/**
 * Inbound DM handler. The relay-pool subscription fires this for every
 * kind=4 (NIP-04) or kind=1059 (NIP-17 gift wrap) event addressed to the
 * bot pubkey. Pipeline:
 *
 *   1. PoW gate (NIP-13) - reject early on insufficient work if enabled
 *   2. Decrypt (NIP-04 or NIP-17 auto-detect) - drop on garbage
 *   3. Rate limit on per-pubkey token bucket - reject silently if empty
 *   4. Parse command into Intent
 *   5. FSM transition (Session, Intent) -> (Session, Action[])
 *   6. Render each Action into a DM body (catalog + invoice creation
 *      sit here for send_menu / send_invoice)
 *   7. Encrypt + publish DM using whichever protocol the customer
 *      proved capable of in step 2
 *
 * Each step lands in its own module; this file is just the wire.
 */
import type { Filter, NostrEvent } from 'nostr-tools';
import type { Logger } from 'pino';

import { consumeToken, meetsPoWThreshold } from './anti-spam.js';
import type { CatalogClient } from './catalog.js';
import { KIND_NIP04_DM, KIND_NIP17_WRAP, buildOutboundDm, decryptIncoming } from './crypto.js';
import { parseCommand, transition } from './commands.js';
import { actionToText } from './render.js';
import type { RelayPool } from './relay-pool.js';
import type { SessionStore } from './session.js';
import type { BtcrechargeClient } from './btcrecharge-client.js';

const BUCKET_CAPACITY     = 10;
const BUCKET_REFILL_PER_S = 10 / 60;          // 10 DMs / minute
const TOKEN_BUCKET_INIT   = BUCKET_CAPACITY;  // fresh sessions start full

/** Subscription lookback for kind 4 - real timestamps, tight window. */
const NIP04_LOOKBACK_S = 300;
/**
 * Subscription lookback for kind 1059. NIP-59 randomly backdates the
 * gift-wrap created_at up to 2 days; a tighter `since` makes relays
 * silently drop most NIP-17 DMs before we ever see them.
 */
const NIP17_LOOKBACK_S = 2 * 86_400 + NIP04_LOOKBACK_S;
/**
 * Freshness gate on the decrypted rumor's REAL send time. Anything older
 * is a relay replay or redeploy backlog - answering it would double-reply
 * to messages the customer already got an answer for.
 */
const MAX_DM_AGE_S = 600;

/**
 * Inbound subscription filters, split per kind because the safe `since`
 * differs by two days between NIP-04 and NIP-17 (see lookback notes).
 */
export function buildInboundFilters(botPubkey: string, nowSec: number): Filter[] {
    return [
        { kinds: [KIND_NIP04_DM],   '#p': [botPubkey], since: nowSec - NIP04_LOOKBACK_S },
        { kinds: [KIND_NIP17_WRAP], '#p': [botPubkey], since: nowSec - NIP17_LOOKBACK_S },
    ];
}

export interface HandlerDeps {
    botSecret:     Uint8Array;
    sessionStore:  SessionStore;
    catalog:       CatalogClient;
    btcrecharge:   BtcrechargeClient;
    relayPool:     RelayPool;
    callbackUrl:   string;
    minPowBits:    number;
    /** NIP-65/NIP-17 inbox resolver; when absent replies go pool-only. */
    recipientRelays?: { resolve(pubkey: string): Promise<string[]> };
    logger:        Logger;
}

export async function handleIncomingDm(event: NostrEvent, deps: HandlerDeps): Promise<void> {
    const log = deps.logger;

    // 1. PoW gate
    if (!meetsPoWThreshold(event, deps.minPowBits)) {
        log.debug({ id: event.id.slice(0, 12) }, 'rejected: insufficient PoW');
        return;
    }

    // 2. Decrypt
    const decrypted = decryptIncoming(deps.botSecret, event);
    if (!decrypted) {
        log.debug({ id: event.id.slice(0, 12), kind: event.kind }, 'dropped: decrypt failed');
        return;
    }
    const senderPubkey = decrypted.senderPubkey;

    // 2b. Freshness gate on the REAL send time. The wide kind-1059
    // subscription window (and relay replays after a re-subscribe or a
    // redeploy) hands us old DMs; answering them would double-reply.
    const inboundLagS = Math.floor(Date.now() / 1000) - decrypted.sentAt;
    if (inboundLagS > MAX_DM_AGE_S) {
        log.info(
            { id: event.id.slice(0, 12), kind: event.kind, inboundLagS },
            'dropped: stale DM (relay replay or redeploy backlog)',
        );
        return;
    }
    log.info({
        id:       event.id.slice(0, 12),
        kind:     event.kind,
        protocol: decrypted.protocol,
        pubkey:   senderPubkey.slice(0, 8),
        inboundLagS,
    }, 'dm received');

    // Kick off the recipient-relay lookup now so the network round-trip
    // overlaps the FSM + render work instead of serializing after it.
    const recipientRelaysPromise: Promise<string[]> = deps.recipientRelays
        ? deps.recipientRelays.resolve(senderPubkey)
        : Promise.resolve([]);

    // 3. Rate limit + 4. Parse + 5. FSM transition - all under a single
    // session mutate so concurrent DMs from the same pubkey serialize on
    // the Redis optimistic lock.
    let actions: Awaited<ReturnType<typeof transition>>['actions'] = [];
    let finalSession;
    try {
        finalSession = await deps.sessionStore.mutate(senderPubkey, (current) => {
            // For a brand-new session the WATCH-loaded value is the blank
            // template, which sits at bucket=0. Initialise to full so the
            // customer's first DM does not bounce off an empty bucket.
            const seeded = current.metadata.firstSeen === current.metadata.lastSeen && current.rateLimit.bucket === 0
                ? { ...current, rateLimit: { bucket: TOKEN_BUCKET_INIT, lastRefill: Math.floor(Date.now() / 1000) } }
                : current;

            const decision = consumeToken(seeded.rateLimit, BUCKET_CAPACITY, BUCKET_REFILL_PER_S, Math.floor(Date.now() / 1000));
            const next     = { ...seeded, rateLimit: decision.state };
            next.protocol  = decrypted.protocol;

            if (!decision.allowed) {
                // Persist the new bucket state but suppress the FSM step.
                return next;
            }

            const intent = parseCommand(decrypted.plaintext, next.flow);
            const t = transition(next, intent);
            actions = t.actions;
            return t.session;
        });
    } catch (err) {
        log.error({ err: String(err), pubkey: senderPubkey.slice(0, 8) }, 'session mutate failed');
        return;
    }

    if (actions.length === 0) {
        log.debug({ pubkey: senderPubkey.slice(0, 8) }, 'no actions to emit (rate limited or no-op)');
        return;
    }

    // 6 + 7. Render each action, encrypt, publish (pool + recipient relays).
    const recipientRelayUrls = await recipientRelaysPromise;
    for (const action of actions) {
        let text: string | null;
        const renderStart = Date.now();
        try {
            text = await actionToText(action, finalSession, {
                catalog:      deps.catalog,
                btcrecharge:  deps.btcrecharge,
                sessionStore: deps.sessionStore,
                callbackUrl:  deps.callbackUrl,
                logger:       log,
            });
        } catch (err) {
            log.error({ err: String(err), action: action.kind }, 'action render failed');
            continue;
        }
        if (text === null) continue;
        const renderMs = Date.now() - renderStart;

        const events = buildOutboundDm(deps.botSecret, senderPubkey, text, finalSession.protocol);
        const publishStart = Date.now();
        const settled = await Promise.allSettled(
            events.map(e => deps.relayPool.publish(e, recipientRelayUrls)),
        );
        const publishMs = Date.now() - publishStart;
        const rejected = settled.filter(r => r.status === 'rejected').length;
        log.info({
            pubkey:          senderPubkey.slice(0, 8),
            action:          action.kind,
            kinds:           events.map(e => e.kind),
            rejected,
            recipientRelays: recipientRelayUrls.length,
            renderMs,
            publishMs,
        }, 'reply published');
    }
}
