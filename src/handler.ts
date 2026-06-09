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
import type { NostrEvent } from 'nostr-tools';
import type { Logger } from 'pino';

import { consumeToken, meetsPoWThreshold } from './anti-spam.js';
import type { CatalogClient } from './catalog.js';
import { buildOutboundDm, decryptIncoming } from './crypto.js';
import { parseCommand, transition } from './commands.js';
import { actionToText } from './render.js';
import type { RelayPool } from './relay-pool.js';
import type { SessionStore } from './session.js';
import type { BtcrechargeClient } from './btcrecharge-client.js';

const BUCKET_CAPACITY     = 10;
const BUCKET_REFILL_PER_S = 10 / 60;          // 10 DMs / minute
const TOKEN_BUCKET_INIT   = BUCKET_CAPACITY;  // fresh sessions start full

export interface HandlerDeps {
    botSecret:     Uint8Array;
    sessionStore:  SessionStore;
    catalog:       CatalogClient;
    btcrecharge:   BtcrechargeClient;
    relayPool:     RelayPool;
    callbackUrl:   string;
    minPowBits:    number;
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

    // 6 + 7. Render each action, encrypt, publish.
    for (const action of actions) {
        let text: string | null;
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

        const events = buildOutboundDm(deps.botSecret, senderPubkey, text, finalSession.protocol);
        const settled = await Promise.allSettled(events.map(e => deps.relayPool.publishAtLeastOne(e)));
        const rejected = settled.filter(r => r.status === 'rejected').length;
        log.info({
            pubkey:   senderPubkey.slice(0, 8),
            action:   action.kind,
            kinds:    events.map(e => e.kind),
            rejected,
        }, 'reply published');
    }
}
