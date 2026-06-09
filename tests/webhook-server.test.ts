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
import type { SessionStore } from '../src/session.js';
import type { CatalogClient } from '../src/catalog.js';
import type { RelayPool } from '../src/relay-pool.js';

const SILENT = pino({ level: 'silent' });
const SECRET = 'd'.repeat(64);

// ----- minimal stubs ------------------------------------------------

type LookupMap = Map<string, string>;

function stubSessionStore(lookup: LookupMap): SessionStore {
    return {
        lookupPubkey: async (id: string) => lookup.get(id) ?? null,
        unlinkOrder:  async (id: string) => { lookup.delete(id); },
        get: async () => null,
        // unused by the webhook path but required by the type:
        save: async () => undefined,
        touch: async () => false,
        delete: async () => undefined,
        linkOrder: async () => undefined,
        mutate: async () => { throw new Error('not used'); },
    } as unknown as SessionStore;
}

function stubRelayPool(): RelayPool & { publishedEvents: NostrEvent[] } {
    const publishedEvents: NostrEvent[] = [];
    return {
        publishedEvents,
        publishAtLeastOne: async (evt: NostrEvent) => { publishedEvents.push(evt); },
        publish:    async () => [],
        subscribe:  () => ({ id: '0', close: () => {} }),
        getHealth:  () => ({ total: 0, connected: 0, relayStatus: {}, activeSubscriptions: 0, seenWindow: 0 }),
        close:      () => {},
    } as unknown as RelayPool & { publishedEvents: NostrEvent[] };
}

const stubCatalog = {} as unknown as CatalogClient;

// ----- harness ------------------------------------------------------

let baseUrl = '';
let lookup: LookupMap;
let relay:  ReturnType<typeof stubRelayPool>;
let server: ReturnType<typeof createWebhookServer>;

function sign(body: string, ts: number): { ts: string; sig: string } {
    const tsStr = String(ts);
    const sig   = createHmac('sha256', SECRET).update(tsStr + '\n' + body).digest('hex');
    return { ts: tsStr, sig };
}

before(async () => {
    lookup = new Map();
    relay  = stubRelayPool();
    server = createWebhookServer({
        nostrProxySecret: SECRET,
        sessionStore:     stubSessionStore(lookup),
        catalog:          stubCatalog,
        relayPool:        relay,
        botSecret:        new Uint8Array(32).fill(1),
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
