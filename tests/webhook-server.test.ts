/**
 * Webhook server behaviour. We instantiate the real http server on a
 * port the OS picks, then POST to it from the test process. The stubs
 * cover the Redis-shaped surface and a tiny RelayPool / catalog so the
 * server hits realistic decision paths.
 *
 * Pinned contract:
 *   - GET /health -> 200 {ok:true}
 *   - POST /webhook/order with valid HMAC + payload -> 200 + dispatches DM
 *   - POST with bad HMAC -> 401, no DM
 *   - POST with stale timestamp -> 401, no DM
 *   - POST with valid HMAC but unknown internal_order_id -> 202 silent ack
 *   - Terminal states drop the reverse-index entry
 *   - state -> notification text mapping covers every documented case
 */
import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';

import pino from 'pino';
import type { NostrEvent } from 'nostr-tools';

import {
    CALLBACK_TIMESTAMP_WINDOW_SEC,
    createWebhookServer,
    renderStateNotification,
} from '../src/webhook-server.js';
import { blankSession, type CustomerSession, type SessionStore } from '../src/session.js';
import type { CatalogClient } from '../src/catalog.js';
import type { RelayPool } from '../src/relay-pool.js';

const SILENT = pino({ level: 'silent' });
const SECRET = 'd'.repeat(64);

// ----- minimal stubs ------------------------------------------------

type LookupMap = Map<string, string>;

interface SessionStateMap {
    /** Per-pubkey latest session as the bot would have stored it. */
    sessions: Map<string, CustomerSession>;
    /** Last result of the mutate call, for assertions. */
    lastMutation: CustomerSession | null;
}

function stubSessionStore(lookup: LookupMap, state: SessionStateMap): SessionStore {
    return {
        lookupPubkey: async (id: string) => lookup.get(id) ?? null,
        unlinkOrder:  async (id: string) => { lookup.delete(id); },
        get:          async (pk: string) => state.sessions.get(pk) ?? null,
        save:         async () => undefined,
        touch:        async () => false,
        delete:       async () => undefined,
        linkOrder:    async () => undefined,
        // Apply the provided mutator to the stored session (or a blank
        // one if missing), record the result, persist it back.
        mutate: async (pk: string, fn: (s: CustomerSession) => CustomerSession) => {
            const current = state.sessions.get(pk) ?? blankSession(pk);
            const next    = fn(current);
            state.sessions.set(pk, next);
            state.lastMutation = next;
            return next;
        },
    } as unknown as SessionStore;
}

function stubRelayPool(): RelayPool & {
    publishedEvents: NostrEvent[];
    publishExtras:   Array<readonly string[] | undefined>;
} {
    const publishedEvents: NostrEvent[] = [];
    const publishExtras:   Array<readonly string[] | undefined> = [];
    return {
        publishedEvents,
        publishExtras,
        publishAtLeastOne: async (evt: NostrEvent) => { publishedEvents.push(evt); },
        publish: async (evt: NostrEvent, extraRelays?: readonly string[]) => {
            publishedEvents.push(evt);
            publishExtras.push(extraRelays);
            return [{ url: 'wss://t', ok: true }];
        },
        subscribe:  () => ({ id: '0', close: () => {} }),
        getHealth:  () => ({ total: 0, connected: 0, relayStatus: {}, activeSubscriptions: 0, seenWindow: 0 }),
        close:      () => {},
    } as unknown as RelayPool & {
        publishedEvents: NostrEvent[];
        publishExtras:   Array<readonly string[] | undefined>;
    };
}

const stubCatalog = {} as unknown as CatalogClient;

// ----- harness ------------------------------------------------------

let baseUrl = '';
let lookup: LookupMap;
let state:  SessionStateMap;
let relay:  ReturnType<typeof stubRelayPool>;
let server: ReturnType<typeof createWebhookServer>;
let resolveCalls: string[];

function sign(body: string, ts: number): { ts: string; sig: string } {
    const tsStr = String(ts);
    const sig   = createHmac('sha256', SECRET).update(tsStr + '\n' + body).digest('hex');
    return { ts: tsStr, sig };
}

before(async () => {
    lookup       = new Map();
    state        = { sessions: new Map(), lastMutation: null };
    relay        = stubRelayPool();
    resolveCalls = [];
    server = createWebhookServer({
        nostrProxySecret: SECRET,
        sessionStore:     stubSessionStore(lookup, state),
        catalog:          stubCatalog,
        relayPool:        relay,
        botSecret:        new Uint8Array(32).fill(1),
        recipientRelays:  {
            resolve: async (pubkey: string) => {
                resolveCalls.push(pubkey);
                return ['wss://customer-inbox'];
            },
        },
        logger:           SILENT,
    }, 0);
    await new Promise<void>(r => server.on('listening', r));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
    await new Promise<void>(r => server.close(() => r()));
});

// ------------------------------------------------------------------

test('webhook: GET /health returns 200 + ok json', async () => {
    const res = await fetch(baseUrl + '/health');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
});

test('webhook: POST with no signature returns 401', async () => {
    const res = await fetch(baseUrl + '/webhook/order', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ internal_order_id: 1, state: 'delivered' }),
    });
    assert.equal(res.status, 401);
});

test('webhook: POST with bad signature returns 401', async () => {
    const body = JSON.stringify({ internal_order_id: 1, state: 'delivered' });
    const ts   = Math.floor(Date.now() / 1000).toString();
    const res = await fetch(baseUrl + '/webhook/order', {
        method:  'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Timestamp':  ts,
            'X-Signature':  '0'.repeat(64),
        },
        body,
    });
    assert.equal(res.status, 401);
});

test('webhook: stale timestamp outside window returns 401', async () => {
    const body = JSON.stringify({ internal_order_id: 1, state: 'delivered' });
    const stale = Math.floor(Date.now() / 1000) - (CALLBACK_TIMESTAMP_WINDOW_SEC + 100);
    const { ts, sig } = sign(body, stale);
    const res = await fetch(baseUrl + '/webhook/order', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Timestamp': ts, 'X-Signature': sig },
        body,
    });
    assert.equal(res.status, 401);
});

test('webhook: valid signature but unknown order_id returns 202 silent ack', async () => {
    const body = JSON.stringify({ internal_order_id: 99999, state: 'delivered' });
    const { ts, sig } = sign(body, Math.floor(Date.now() / 1000));
    const res = await fetch(baseUrl + '/webhook/order', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Timestamp': ts, 'X-Signature': sig },
        body,
    });
    assert.equal(res.status, 202);
    const j = await res.json() as { ok: boolean; note?: string };
    assert.equal(j.ok,   true);
    assert.equal(j.note, 'no_subscriber');
    assert.equal(relay.publishedEvents.length, 0);
});

test('webhook: known order_id with state=delivered dispatches a DM and drops the entry', async () => {
    const pubkey = 'a'.repeat(64);
    lookup.set('42', pubkey);

    const body = JSON.stringify({ internal_order_id: 42, state: 'delivered' });
    const { ts, sig } = sign(body, Math.floor(Date.now() / 1000));
    const res = await fetch(baseUrl + '/webhook/order', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Timestamp': ts, 'X-Signature': sig },
        body,
    });
    assert.equal(res.status, 200);
    assert.equal(relay.publishedEvents.length >= 1, true, 'at least one DM kind should have been published');
    assert.equal(lookup.has('42'), false, 'terminal state should drop the reverse-index entry');
});

test('webhook: state DM routes to the recipient relays the resolver returns', async () => {
    const pubkey = 'a'.repeat(64);
    lookup.set('4242', pubkey);

    const body = JSON.stringify({ internal_order_id: 4242, state: 'delivered' });
    const { ts, sig } = sign(body, Math.floor(Date.now() / 1000));
    const res = await fetch(baseUrl + '/webhook/order', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Timestamp': ts, 'X-Signature': sig },
        body,
    });
    assert.equal(res.status, 200);

    assert.ok(resolveCalls.includes(pubkey), 'resolver must be asked for the subscriber pubkey');
    assert.ok(relay.publishExtras.length >= 1, 'state DM must go through publish(event, extraRelays)');
    assert.deepEqual(relay.publishExtras.at(-1), ['wss://customer-inbox']);
});

test('webhook: paying_bitrefill stays silent (no DM) but still 200', async () => {
    const pubkey = 'b'.repeat(64);
    lookup.set('77', pubkey);
    const before = relay.publishedEvents.length;

    const body = JSON.stringify({ internal_order_id: 77, state: 'paying_bitrefill' });
    const { ts, sig } = sign(body, Math.floor(Date.now() / 1000));
    const res = await fetch(baseUrl + '/webhook/order', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Timestamp': ts, 'X-Signature': sig },
        body,
    });
    assert.equal(res.status, 200);
    assert.equal(relay.publishedEvents.length, before, 'intermediate state should not publish');
});

test('webhook: 404 on unknown route', async () => {
    const res = await fetch(baseUrl + '/nope');
    assert.equal(res.status, 404);
});

// ------------------------------------------------------------------
// pure state -> notification mapping
// ------------------------------------------------------------------

test('renderStateNotification: covers every documented state', () => {
    assert.match(renderStateNotification({ internal_order_id: 1, state: 'customer_paid' })!,      /Payment received/);
    assert.equal(renderStateNotification({ internal_order_id: 1, state: 'paying_bitrefill' }),    null);
    assert.match(renderStateNotification({ internal_order_id: 1, state: 'delivered' })!,          /delivered/);
    assert.match(renderStateNotification({ internal_order_id: 1, state: 'payout_failed' })!,      /retrying/);
    assert.match(renderStateNotification({ internal_order_id: 1, state: 'refund_pending' })!,     /refund/i);
    assert.match(renderStateNotification({ internal_order_id: 1, state: 'refunded' })!,           /refund/i);
    assert.match(renderStateNotification({ internal_order_id: 1, state: 'expired' })!,            /expired/i);
    assert.match(renderStateNotification({ internal_order_id: 1, state: 'invalid', error: 'bad operator' })!, /bad operator/);
    assert.equal(renderStateNotification({ internal_order_id: 1, state: 'unknown_future_state' }), null);
});

// ----- Phase 3: refund_pending / refund_reminder / refunded ---------

test('renderStateNotification: refund_pending lists both accepted formats and the sats amount', () => {
    const text = renderStateNotification({ internal_order_id: 1015, state: 'refund_pending', sats: 9395 })!;
    assert.match(text, /1015/);
    assert.match(text, /Lightning address/);
    assert.match(text, /LNURL-pay/);
    assert.match(text, /9395 sats/);
});

test('renderStateNotification: refund_reminder messages vary with attempt number', () => {
    const a1 = renderStateNotification({ internal_order_id: 1, state: 'refund_reminder', reminder_attempt: 1 })!;
    const a3 = renderStateNotification({ internal_order_id: 1, state: 'refund_reminder', reminder_attempt: 3 })!;
    assert.match(a1, /Reminder/i);
    assert.match(a3, /operator/i);            // final reminder mentions operator escalation
    assert.notEqual(a1, a3);
});

test('renderStateNotification: refunded with refund_tx surfaces the tx for receipts', () => {
    const text = renderStateNotification({ internal_order_id: 1, state: 'refunded', refund_tx: 'abc123' })!;
    assert.match(text, /abc123/);
});

// The pubkey here MUST be a valid secp256k1 x-coordinate or
// buildOutboundDm raises "bad point: is not on curve" during the
// NIP-04 ECDH step. The existing 'a'.repeat(64) and 'b'.repeat(64)
// keys happen to be valid; we reuse the 'a' one (the underlying
// session map is keyed by pubkey, so isolating tests by orderId only
// is enough).
const VALID_TEST_PUBKEY = 'a'.repeat(64);

test('webhook: refund_pending mutates the session into awaiting_refund_address and adds the order', async () => {
    lookup.set('1015', VALID_TEST_PUBKEY);
    state.sessions.set(VALID_TEST_PUBKEY, blankSession(VALID_TEST_PUBKEY));

    const body = JSON.stringify({ internal_order_id: 1015, state: 'refund_pending', sats: 9395 });
    const { ts, sig } = sign(body, Math.floor(Date.now() / 1000));
    const res = await fetch(baseUrl + '/webhook/order', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Timestamp': ts, 'X-Signature': sig },
        body,
    });
    assert.equal(res.status, 200);

    const after = state.sessions.get(VALID_TEST_PUBKEY)!;
    assert.equal(after.flow.type, 'awaiting_refund_address');
    assert.equal((after.flow.ctx as { orderId?: string }).orderId, '1015');
    assert.ok(after.refundPendingOrderIds.includes('1015'));
});

test('webhook: refunded for the current refund flow flips back to idle and clears the list', async () => {
    lookup.set('1042', VALID_TEST_PUBKEY);
    const start: CustomerSession = {
        ...blankSession(VALID_TEST_PUBKEY),
        flow:                  { type: 'awaiting_refund_address', ctx: { orderId: '1042' } },
        refundPendingOrderIds: ['1042'],
    };
    state.sessions.set(VALID_TEST_PUBKEY, start);

    const body = JSON.stringify({ internal_order_id: 1042, state: 'refunded', refund_tx: 'tx-abc' });
    const { ts, sig } = sign(body, Math.floor(Date.now() / 1000));
    const res = await fetch(baseUrl + '/webhook/order', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Timestamp': ts, 'X-Signature': sig },
        body,
    });
    assert.equal(res.status, 200);

    const after = state.sessions.get(VALID_TEST_PUBKEY)!;
    assert.equal(after.flow.type, 'idle');
    assert.deepEqual(after.refundPendingOrderIds, []);
});
