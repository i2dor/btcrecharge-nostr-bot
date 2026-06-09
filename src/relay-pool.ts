/**
 * Relay pool: a thin layer over `nostr-tools` SimplePool that adds
 *
 *   - resilient connection management: re-issue subscriptions on a periodic
 *     interval. The PoC found that some public relays silently drop ongoing
 *     pushes after EOSE; the periodic re-REQ is the pragmatic fix without
 *     rewriting the SDK.
 *   - event de-duplication: the same DM frequently arrives from 3+ relays;
 *     the consumer should see it once.
 *   - graceful degradation: we warn at <50% relays connected but stay up so
 *     a partial outage on Nostr's side does not take the bot down.
 *   - health introspection for the HTTP /health endpoint we land in 3.2.
 *
 * Subscriptions are described once via `subscribe(filter, onEvent)`. The
 * pool re-issues them transparently; callers do not need to re-subscribe
 * after a reconnect.
 *
 * SimplePool is injected via `poolFactory` so tests can drive a stub
 * without monkey-patching the module loader.
 */
import type { Filter, NostrEvent } from 'nostr-tools';
import { SimplePool } from 'nostr-tools';
import type { Logger } from 'pino';

/** The slice of SimplePool we actually use. Stubbable in tests. */
export interface PoolBackend {
    publish(relays: string[], event: NostrEvent): Promise<void>[];
    subscribeMany(
        relays: string[],
        filter: Filter,
        params: { onevent: (event: NostrEvent) => void; oneose: () => void },
    ): { close(): void };
    listConnectionStatus(): Map<string, boolean>;
    close(relays: string[]): void;
}

export interface PoolOptions {
    /** Relay URLs (wss://...). */
    relays: readonly string[];
    /** Force re-issuance of every subscription on this interval. */
    resubscribeMs?: number;
    /** Cap on the LRU window for seen event IDs. */
    seenLimit?: number;
    /** DI hook for tests; defaults to a real SimplePool. */
    poolFactory?: () => PoolBackend;
}

export interface SubscriptionHandle {
    readonly id: string;
    close(): void;
}

export interface PoolHealth {
    total:     number;
    connected: number;
    relayStatus: Record<string, 'connected' | 'connecting' | 'closed'>;
    activeSubscriptions: number;
    seenWindow: number;
}

export interface PublishOutcome {
    readonly url: string;
    readonly ok:  boolean;
    readonly error?: string;
}

interface InternalSub {
    id:      string;
    filter:  Filter;
    onEvent: (event: NostrEvent) => void;
    handle:  { close(): void } | null;
}

const DEFAULT_RESUBSCRIBE_MS = 2 * 60 * 1000; // 2 minutes - keeps live tail fresh on public relays
const DEFAULT_SEEN_LIMIT     = 5000;

export class RelayPool {
    private readonly backend:      PoolBackend;
    private readonly urls:         readonly string[];
    private readonly resubscribeMs: number;
    private readonly seenLimit:    number;
    private readonly log:          Logger;

    private readonly subs:  Map<string, InternalSub> = new Map();
    private readonly seen:  Set<string>              = new Set();

    private timer:  ReturnType<typeof setInterval> | null = null;
    private nextSubId = 1;
    private closed = false;

    constructor(opts: PoolOptions, logger: Logger) {
        if (opts.relays.length === 0) {
            throw new Error('RelayPool requires at least one relay URL');
        }
        this.urls          = opts.relays;
        this.resubscribeMs = opts.resubscribeMs ?? DEFAULT_RESUBSCRIBE_MS;
        this.seenLimit     = opts.seenLimit     ?? DEFAULT_SEEN_LIMIT;
        this.backend       = (opts.poolFactory ?? (() => new SimplePool() as unknown as PoolBackend))();
        this.log           = logger.child({ component: 'relay-pool' });

        this.timer = setInterval(() => this.refreshAll(), this.resubscribeMs);
        this.timer.unref?.();
    }

    /**
     * Open a long-lived subscription that survives relay drops. The
     * `onEvent` callback fires at most once per event id across all relays.
     */
    subscribe(filter: Filter, onEvent: (event: NostrEvent) => void): SubscriptionHandle {
        if (this.closed) throw new Error('RelayPool is closed');
        const id = String(this.nextSubId++);
        const sub: InternalSub = { id, filter, onEvent, handle: null };
        this.subs.set(id, sub);
        this.openHandle(sub);

        return {
            id,
            close: () => {
                sub.handle?.close();
                this.subs.delete(id);
                this.log.debug({ subId: id }, 'subscription closed by caller');
            },
        };
    }

    /**
     * Publish to every relay. Returns the per-relay outcome so the caller
     * can decide whether partial success is good enough; the helper
     * `publishAtLeastOne` covers the common case.
     */
    async publish(event: NostrEvent): Promise<PublishOutcome[]> {
        if (this.closed) throw new Error('RelayPool is closed');
        const pubs = this.backend.publish(this.urls as string[], event);
        const settled = await Promise.allSettled(pubs);
        const outcomes: PublishOutcome[] = settled.map((res, i) => {
            const url = this.urls[i] ?? '<unknown>';
            return res.status === 'fulfilled'
                ? { url, ok: true }
                : { url, ok: false, error: (res.reason as Error)?.message ?? String(res.reason) };
        });
        const okCount = outcomes.filter(o => o.ok).length;
        this.log.info({ eventId: event.id.slice(0, 12), okCount, total: outcomes.length }, 'publish');
        return outcomes;
    }

    /** Throw if zero relays accepted the publish. */
    async publishAtLeastOne(event: NostrEvent): Promise<void> {
        const outs = await this.publish(event);
        if (!outs.some(o => o.ok)) {
            throw new Error(
                `publish rejected by all ${outs.length} relays: ` +
                outs.map(o => o.error).join('; '),
            );
        }
    }

    getHealth(): PoolHealth {
        const status: Record<string, 'connected' | 'connecting' | 'closed'> = {};
        let connected = 0;
        const live = this.backend.listConnectionStatus();
        for (const url of this.urls) {
            const flag = live.get(url);
            if (flag === true)  { status[url] = 'connected'; connected++; }
            else if (flag === false) { status[url] = 'closed'; }
            else                  { status[url] = 'connecting'; }
        }
        return {
            total:     this.urls.length,
            connected,
            relayStatus: status,
            activeSubscriptions: this.subs.size,
            seenWindow: this.seen.size,
        };
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        for (const sub of this.subs.values()) sub.handle?.close();
        this.subs.clear();
        this.backend.close(this.urls as string[]);
        this.log.info('relay pool closed');
    }

    // --- internals -----------------------------------------------------

    private openHandle(sub: InternalSub): void {
        sub.handle = this.backend.subscribeMany(this.urls as string[], sub.filter, {
            onevent: (event) => this.onIncoming(sub, event),
            oneose:  () => this.log.debug({ subId: sub.id }, 'EOSE'),
        });
    }

    private onIncoming(sub: InternalSub, event: NostrEvent): void {
        if (this.seen.has(event.id)) return;
        this.markSeen(event.id);
        try {
            sub.onEvent(event);
        } catch (err) {
            this.log.error(
                { subId: sub.id, eventId: event.id, err: String(err) },
                'subscription handler threw',
            );
        }
    }

    private markSeen(eventId: string): void {
        this.seen.add(eventId);
        if (this.seen.size <= this.seenLimit) return;
        const keep = [...this.seen].slice(-this.seenLimit / 2);
        this.seen.clear();
        for (const id of keep) this.seen.add(id);
    }

    /**
     * Re-issue every active subscription. Cheap insurance against relays
     * that silently drop a long-lived REQ after EOSE.
     */
    private refreshAll(): void {
        if (this.subs.size === 0) return;
        const health = this.getHealth();
        if (health.connected < health.total / 2) {
            this.log.warn(health, 'fewer than half the relays connected');
        }
        for (const sub of this.subs.values()) {
            sub.handle?.close();
            this.openHandle(sub);
        }
        this.log.debug({ count: this.subs.size }, 'periodic re-subscribe');
    }
}
