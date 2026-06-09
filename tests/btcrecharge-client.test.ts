/**
 * btcrecharge HTTP client behaviour. Network is mocked via a stub fetch
 * so we can pin:
 *
 *   - input validation rejects malformed slugs / phones / callback URLs
 *     before any request is even attempted
 *   - HMAC signature is correct and verifiable with the shared secret
 *   - 2xx response is parsed into the typed CreateLightningOrderResponse
 *   - 4xx and 5xx surface as BtcrechargeApiError with status + code
 *   - timeout aborts the request when the backend hangs
 *   - newOrderId returns a unique, well-formed idempotency key
 */
import { strict as assert } from 'node:assert';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';

import pino from 'pino';

import {
    BtcrechargeApiError,
    BtcrechargeClient,
} from '../src/btcrecharge-client.js';

const SILENT = pino({ level: 'silent' });
const SECRET = 'de1e132c37d6d3bf6cb4a991a7ee855f66783a3212a6999f8014be3409bc78f8';
const BASE   = 'https://btcrecharge.example';

interface CapturedRequest {
    url:     string;
    method:  string;
    body:    string;
    headers: Record<string, string>;
}

function stubFetch(response: { status: number; body: unknown } | (() => Promise<Response>)): {
    fetchImpl: typeof fetch;
    captured:  CapturedRequest[];
} {
    const captured: CapturedRequest[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
        const url     = typeof input === 'string' ? input : input.toString();
        const headers = Object.fromEntries(
            Object.entries((init?.headers ?? {}) as Record<string, string>),
        );
        captured.push({
            url,
            method:  init?.method ?? 'GET',
            body:    typeof init?.body === 'string' ? init.body : '',
            headers,
        });
        if (typeof response === 'function') return response();
        return new Response(JSON.stringify(response.body), {
            status:  response.status,
            headers: { 'Content-Type': 'application/json' },
        });
    };
    return { fetchImpl, captured };
}

function makeInput() {
    return {
        nostrOrderId:   'nostr-' + randomUUID(),
        operatorSlug:   'airtel-india',
        msisdn:         '+918123456789',
        topupValue:     '5',
        callbackUrl:    'https://nostr-bot.example/webhook/order',
        customerPubkey: 'a'.repeat(64),
    };
}

function makeSuccessBody() {
    return {
        internalOrderId: 12345,
        lnInvoice:       'lnbc500u1pxxxxFAKEinvoice',
        sats:            5500,
        expiresAt:       Math.floor(Date.now() / 1000) + 900,
        state:           'awaiting_payment',
        idempotent:      false,
    };
}

// ------------------------------------------------------------------

test('client: rejects invalid operator slug before any HTTP call', async () => {
    const { fetchImpl, captured } = stubFetch({ status: 200, body: {} });
    const client = new BtcrechargeClient({ baseUrl: BASE, nostrProxySecret: SECRET, fetchImpl }, SILENT);
    await assert.rejects(
        client.createLightningOrder({ ...makeInput(), operatorSlug: 'bad slug with spaces' }),
    );
    assert.equal(captured.length, 0, 'should not have hit the network on validation failure');
});

test('client: rejects non-E.164 phone before any HTTP call', async () => {
    const { fetchImpl, captured } = stubFetch({ status: 200, body: {} });
    const client = new BtcrechargeClient({ baseUrl: BASE, nostrProxySecret: SECRET, fetchImpl }, SILENT);
    await assert.rejects(client.createLightningOrder({ ...makeInput(), msisdn: '0812345' }));
    assert.equal(captured.length, 0);
});

test('client: rejects non-URL callback before any HTTP call', async () => {
    const { fetchImpl, captured } = stubFetch({ status: 200, body: {} });
    const client = new BtcrechargeClient({ baseUrl: BASE, nostrProxySecret: SECRET, fetchImpl }, SILENT);
    await assert.rejects(client.createLightningOrder({ ...makeInput(), callbackUrl: 'not-a-url' }));
    assert.equal(captured.length, 0);
});

test('client: sends X-Timestamp and X-Signature with a correct HMAC', async () => {
    const { fetchImpl, captured } = stubFetch({ status: 200, body: makeSuccessBody() });
    const client = new BtcrechargeClient({ baseUrl: BASE, nostrProxySecret: SECRET, fetchImpl }, SILENT);
    await client.createLightningOrder(makeInput());

    assert.equal(captured.length, 1);
    const req = captured[0]!;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, BASE + '/internal/lightning-orders');
    assert.ok(req.headers['X-Timestamp'], 'X-Timestamp must be present');
    assert.ok(req.headers['X-Signature'], 'X-Signature must be present');
    assert.equal(req.headers['X-Client'], 'nostr');
    assert.equal(req.headers['Content-Type'], 'application/json');

    const expected = createHmac('sha256', SECRET)
        .update(req.headers['X-Timestamp']! + '\n' + req.body)
        .digest('hex');
    assert.equal(req.headers['X-Signature'], expected);
});

test('client: 2xx response parses into a typed CreateLightningOrderResponse', async () => {
    const body = makeSuccessBody();
    const { fetchImpl } = stubFetch({ status: 200, body });
    const client = new BtcrechargeClient({ baseUrl: BASE, nostrProxySecret: SECRET, fetchImpl }, SILENT);

    const res = await client.createLightningOrder(makeInput());
    assert.equal(res.internalOrderId, body.internalOrderId);
    assert.match(res.lnInvoice, /^lnbc/i);
    assert.equal(res.sats, body.sats);
    assert.equal(res.state, body.state);
});

test('client: 409 out_of_stock surfaces as BtcrechargeApiError with code', async () => {
    const { fetchImpl } = stubFetch({ status: 409, body: { error: 'out_of_stock' } });
    const client = new BtcrechargeClient({ baseUrl: BASE, nostrProxySecret: SECRET, fetchImpl }, SILENT);

    await assert.rejects(
        client.createLightningOrder(makeInput()),
        (err: unknown) => {
            assert.ok(err instanceof BtcrechargeApiError);
            assert.equal(err.status, 409);
            assert.equal(err.code, 'out_of_stock');
            return true;
        },
    );
});

test('client: 5xx transient error surfaces as BtcrechargeApiError', async () => {
    const { fetchImpl } = stubFetch({ status: 502, body: { error: 'provider_unreachable', detail: 'bitrefill down' } });
    const client = new BtcrechargeClient({ baseUrl: BASE, nostrProxySecret: SECRET, fetchImpl }, SILENT);

    await assert.rejects(
        client.createLightningOrder(makeInput()),
        (err: unknown) => {
            assert.ok(err instanceof BtcrechargeApiError);
            assert.equal(err.status, 502);
            assert.equal(err.code, 'provider_unreachable');
            assert.match(err.message, /bitrefill down/);
            return true;
        },
    );
});

test('client: non-JSON response surfaces as invalid_response', async () => {
    const fetchImpl: typeof fetch = async () =>
        new Response('<!doctype html><h1>Bad Gateway</h1>', { status: 502 });
    const client = new BtcrechargeClient({ baseUrl: BASE, nostrProxySecret: SECRET, fetchImpl }, SILENT);

    await assert.rejects(
        client.createLightningOrder(makeInput()),
        (err: unknown) => {
            assert.ok(err instanceof BtcrechargeApiError);
            assert.equal(err.code, 'invalid_response');
            return true;
        },
    );
});

test('client: hung backend aborts after configured timeout', async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
    const client = new BtcrechargeClient(
        { baseUrl: BASE, nostrProxySecret: SECRET, fetchImpl, timeoutMs: 25 },
        SILENT,
    );
    await assert.rejects(client.createLightningOrder(makeInput()), /aborted/);
});

test('client: newOrderId returns a unique, well-formed key', () => {
    const a = BtcrechargeClient.newOrderId();
    const b = BtcrechargeClient.newOrderId();
    assert.notEqual(a, b);
    assert.match(a, /^nostr-[0-9a-f-]{36}$/);
});
