/**
 * Customer session state, kept in Redis with a 7-day sliding TTL.
 *
 * What we store per customer pubkey:
 *
 *   - `protocol`: last detected encryption (nip04 / nip17). Decision #2.
 *     Reply path uses this to decide between dual-send and single-send.
 *   - `flow`: the multi-step command FSM (idle, selecting_carrier, ...).
 *   - `cart`: items the customer has picked but not yet paid for.
 *   - `pendingOrderIds`: btcrecharge order IDs awaiting state callbacks.
 *   - `rateLimit`: token bucket counters for per-pubkey throttling.
 *   - `metadata`: firstSeen / lastSeen / totalOrders, observability only.
 *
 * Plus a separate reverse index `nostr-bot:order-to-pubkey:<orderId>`
 * so the webhook callback (Phase 2.3) can resolve a btcrecharge order
 * back to the customer's npub in O(1).
 *
 * Atomicity: `mutate` retries under WATCH/MULTI/EXEC. Two concurrent DMs
 * from the same pubkey land sequentially without losing cart entries.
 *
 * Storage layout is JSON per key, not a hash. Trades a bit of write
 * amplification for read simplicity (one Redis hop, schema validated by
 * zod, no field-name drift).
 */
import type { Logger } from 'pino';
import { z } from 'zod';

// ----- types --------------------------------------------------------

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export const ProtocolSchema = z.enum(['nip04', 'nip17']);

export const FlowSchema = z.object({
    type: z.enum([
        'idle',
        'selecting_carrier',
        'selecting_amount',
        'entering_phone',
        'confirming_amount',
        'awaiting_payment',
        'awaiting_refund_address',
    ]),
    ctx: z.record(z.unknown()).default({}),
});

export const CartItemSchema = z.object({
    sku:    z.string().min(1),
    amount: z.number().positive(),
    phone:  z.string().regex(/^\+[0-9]{4,18}$/),
});

export const RateLimitSchema = z.object({
    bucket:     z.number().nonnegative(),
    lastRefill: z.number().nonnegative(),
});

export const MetadataSchema = z.object({
    firstSeen:   z.number().nonnegative(),
    lastSeen:    z.number().nonnegative(),
    totalOrders: z.number().nonnegative(),
});

export const SessionSchema = z.object({
    pubkey:                  z.string().regex(/^[0-9a-f]{64}$/i),
    protocol:                ProtocolSchema.nullable(),
    flow:                    FlowSchema,
    cart:                    z.array(CartItemSchema),
    pendingOrderIds:         z.array(z.string().min(1)),
    // Orders the backend has flipped to refund_pending. The bot keeps
    // this list separately from pendingOrderIds so that an inbound
    // Lightning address has a clear target even if the customer wandered
    // off the awaiting_refund_address flow with /menu first.
    refundPendingOrderIds:   z.array(z.string().min(1)).default([]),
    rateLimit:               RateLimitSchema,
    metadata:                MetadataSchema,
});

export type CustomerSession = z.infer<typeof SessionSchema>;
export type Flow            = z.infer<typeof FlowSchema>;
export type CartItem        = z.infer<typeof CartItemSchema>;
export type Protocol        = z.infer<typeof ProtocolSchema>;

// ----- Redis surface we depend on -----------------------------------
//
// We narrow ioredis to just the methods we touch so tests can supply a
// hand-written in-memory implementation without adding ioredis-mock.

export interface RedisLikePipeline {
    set(key: string, value: string, mode: 'EX', seconds: number): RedisLikePipeline;
    del(key: string): RedisLikePipeline;
    exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface RedisLike {
    get(key: string):                                           Promise<string | null>;
    set(key: string, value: string, mode: 'EX', seconds: number): Promise<'OK' | null>;
    del(...keys: string[]):                                     Promise<number>;
    watch(...keys: string[]):                                   Promise<'OK'>;
    unwatch():                                                  Promise<'OK'>;
    multi():                                                    RedisLikePipeline;
}

// ----- store --------------------------------------------------------

const SESSION_PREFIX = 'nostr-bot:session:';
const ORDER_PREFIX   = 'nostr-bot:order-to-pubkey:';
const MAX_MUTATE_RETRIES = 5;

export class SessionStore {
    private readonly redis: RedisLike;
    private readonly log:   Logger;

    constructor(redis: RedisLike, logger: Logger) {
        this.redis = redis;
        this.log   = logger.child({ component: 'session-store' });
    }

    async get(pubkey: string): Promise<CustomerSession | null> {
        const raw = await this.redis.get(sessionKey(pubkey));
        if (raw === null) return null;
        return parseSession(raw, this.log);
    }

    async save(session: CustomerSession): Promise<void> {
        const validated = SessionSchema.parse(session);
        validated.metadata.lastSeen = nowSec();
        await this.redis.set(sessionKey(validated.pubkey), JSON.stringify(validated), 'EX', SESSION_TTL_SECONDS);
    }

    /** Refresh TTL without otherwise touching the session. */
    async touch(pubkey: string): Promise<boolean> {
        const raw = await this.redis.get(sessionKey(pubkey));
        if (raw === null) return false;
        // Re-write the same value with a fresh TTL. Cheaper than EXPIRE on
        // some ioredis versions and avoids drift between value and TTL.
        await this.redis.set(sessionKey(pubkey), raw, 'EX', SESSION_TTL_SECONDS);
        return true;
    }

    /**
     * Atomic read-modify-write. Uses WATCH/MULTI/EXEC; on optimistic-lock
     * conflict (another writer changed the key between read and exec) we
     * retry with the fresh value, up to MAX_MUTATE_RETRIES times.
     *
     * `fn` receives the current session (or a fresh blank one if missing)
     * and MUST return the desired new state. It may be called more than
     * once on conflict, so keep it pure.
     */
    async mutate(
        pubkey: string,
        fn: (current: CustomerSession) => CustomerSession,
    ): Promise<CustomerSession> {
        const key = sessionKey(pubkey);
        for (let attempt = 0; attempt < MAX_MUTATE_RETRIES; attempt++) {
            await this.redis.watch(key);
            const raw     = await this.redis.get(key);
            const current = raw === null ? blankSession(pubkey) : parseSession(raw, this.log);
            const next    = SessionSchema.parse(fn(current));
            next.metadata.lastSeen = nowSec();

            const execResult = await this.redis
                .multi()
                .set(key, JSON.stringify(next), 'EX', SESSION_TTL_SECONDS)
                .exec();

            if (execResult !== null) return next;
            this.log.debug({ pubkey: pubkey.slice(0, 8), attempt }, 'mutate retry');
        }
        await this.redis.unwatch();
        throw new Error(`session mutate retries exhausted for ${pubkey.slice(0, 8)}`);
    }

    async delete(pubkey: string): Promise<void> {
        await this.redis.del(sessionKey(pubkey));
    }

    // ----- order reverse index ----------------------------------------

    async linkOrder(orderId: string, pubkey: string): Promise<void> {
        await this.redis.set(orderKey(orderId), pubkey, 'EX', SESSION_TTL_SECONDS);
    }

    async lookupPubkey(orderId: string): Promise<string | null> {
        return this.redis.get(orderKey(orderId));
    }

    async unlinkOrder(orderId: string): Promise<void> {
        await this.redis.del(orderKey(orderId));
    }
}

// ----- helpers ------------------------------------------------------

function nowSec(): number { return Math.floor(Date.now() / 1000); }

function sessionKey(pubkey: string): string { return SESSION_PREFIX + pubkey; }
function orderKey(orderId: string): string  { return ORDER_PREFIX   + orderId; }

function parseSession(raw: string, log: Logger): CustomerSession {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (err) {
        log.error({ err: String(err) }, 'session JSON parse failed');
        throw new Error('session JSON parse failed');
    }
    return SessionSchema.parse(parsed);
}

export function blankSession(pubkey: string): CustomerSession {
    const ts = nowSec();
    return {
        pubkey,
        protocol: null,
        flow:     { type: 'idle', ctx: {} },
        cart:     [],
        pendingOrderIds:       [],
        refundPendingOrderIds: [],
        rateLimit: { bucket: 0, lastRefill: ts },
        metadata:  { firstSeen: ts, lastSeen: ts, totalOrders: 0 },
    };
}
