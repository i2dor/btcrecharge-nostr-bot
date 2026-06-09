/**
 * Catalog client behaviour.
 *
 * The btcrecharge `/api/operators?country=XX` endpoint is mocked via a
 * stub fetch; Redis is a tiny in-memory map. We pin the observable
 * contract:
 *
 *   - list() returns cached data when fresh, refreshes otherwise
 *   - refresh() aggregates across DEFAULT_COUNTRIES and writes the cache
 *   - getBySku() filters by sku AND in-stock flag
 *   - countryFlag turns ISO-2 codes into regional-indicator emoji
 *   - makeSku produces stable, lowercase, hyphenated SKUs
 *   - renderMenu groups by country, lists amounts, mentions /buy
 *   - refresh fails loudly only when EVERY country fetch failed
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import pino from 'pino';

import {
    CatalogClient,
    countryFlag,
    makeSku,
    renderMenu,
    transformToCatalog,
    type RedisCacheLike,
    type RawOperator,
} from '../src/catalog.js';

const SILENT = pino({ level: 'silent' });
const BASE   = 'https://btcrecharge.example';

class StubRedis implements RedisCacheLike {
    public store = new Map<string, { value: string; expiresAt: number }>();

    async get(key: string): Promise<string | null> {
        const e = this.store.get(key);
        if (!e) return null;
        if (Date.now() > e.expiresAt) { this.store.delete(key); return null; }
        return e.value;
    }
    async set(key: string, value: string, mode: 'EX', seconds: number): Promise<'OK'> {
        if (mode !== 'EX') throw new Error('stub only implements EX');
        this.store.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
        return 'OK';
    }
}

function makeFetch(perCountry: Record<string, { ok: true; operators: RawOperator[] } | 'error'>): {
    fetchImpl: typeof fetch;
    calls: string[];
} {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
        const url = String(input);
        calls.push(url);
        const m = /country=([A-Z]{2})/.exec(url);
        if (!m) return new Response('bad', { status: 400 });
        const cc  = m[1]!;
        const out = perCountry[cc];
        if (!out)              return new Response('not configured', { status: 500 });
        if (out === 'error')   return new Response(JSON.stringify({ ok: false }), { status: 500 });
        return new Response(JSON.stringify({ ok: true, country: cc, operators: out.operators }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };
    return { fetchImpl, calls };
}

const mkOp = (id: string, country: string, name: string, packages: Array<{ value: string; price?: number }>): RawOperator => ({
    id,
    name,
    country_code: country,
    currency:     'USD',
    in_stock:     true,
    packages:     packages.map(p => ({ value: p.value, price: p.price ?? 100 })),
});

// ------------------------------------------------------------------

test('countryFlag: ISO-2 codes map to regional indicators', () => {
    assert.equal(countryFlag('IN'), String.fromCodePoint(0x1F1EE) + String.fromCodePoint(0x1F1F3));
    assert.equal(countryFlag('US'), String.fromCodePoint(0x1F1FA) + String.fromCodePoint(0x1F1F8));
});

test('countryFlag: malformed input falls back to the static map or the raw code', () => {
    assert.equal(countryFlag('xx'), 'xx');
});

test('makeSku: lowercases, hyphenates, and ensures a country suffix', () => {
    const op = mkOp('AIRTEL_India', 'IN', 'Airtel India', [{ value: '5' }]);
    const sku = makeSku(op);
    assert.match(sku, /^airtel-india-in$|^airtel-india$/);
    assert.doesNotMatch(sku, /[A-Z_]/);
});

test('makeSku: does not double-append the country suffix if already present', () => {
    const op = mkOp('vivo-br', 'BR', 'Vivo', [{ value: '10' }]);
    assert.equal(makeSku(op), 'vivo-br');
});

test('transformToCatalog: drops operators without packages, preserves in_stock', () => {
    const raw: RawOperator[] = [
        mkOp('jio-in', 'IN', 'Jio', [{ value: '5' }]),
        { ...mkOp('orphan-xx', 'XX', 'Empty', []), packages: [] },
    ];
    const out = transformToCatalog(raw);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.sku, 'jio-in');
    assert.equal(out[0]!.inStock, true);
});

test('catalog: refresh aggregates across countries and caches the result', async () => {
    const redis = new StubRedis();
    const { fetchImpl, calls } = makeFetch({
        IN: { ok: true, operators: [mkOp('airtel-in', 'IN', 'Airtel India', [{ value: '5' }])] },
        BR: { ok: true, operators: [mkOp('vivo-br',   'BR', 'Vivo',          [{ value: '10' }])] },
    });
    const client = new CatalogClient(
        { baseUrl: BASE, countries: ['IN', 'BR'], fetchImpl, cacheTtl: 30 },
        redis, SILENT,
    );

    const items = await client.refresh();
    assert.equal(items.length, 2);
    assert.deepEqual(calls.sort(), [
        BASE + '/api/operators?country=BR',
        BASE + '/api/operators?country=IN',
    ]);
    assert.ok(await redis.get('nostr-bot:catalog:v1'), 'cache should be populated');
});

test('catalog: list serves from cache on the second call, no extra fetches', async () => {
    const redis = new StubRedis();
    const { fetchImpl, calls } = makeFetch({
        IN: { ok: true, operators: [mkOp('airtel-in', 'IN', 'Airtel India', [{ value: '5' }])] },
    });
    const client = new CatalogClient(
        { baseUrl: BASE, countries: ['IN'], fetchImpl, cacheTtl: 30 },
        redis, SILENT,
    );

    await client.list();
    await client.list();
    assert.equal(calls.length, 1, 'second list call should hit the cache');
});

test('catalog: list ignores a corrupted cache value and refetches', async () => {
    const redis = new StubRedis();
    await redis.set('nostr-bot:catalog:v1', '{not json', 'EX', 30);
    const { fetchImpl } = makeFetch({
        IN: { ok: true, operators: [mkOp('jio-in', 'IN', 'Jio', [{ value: '5' }])] },
    });
    const client = new CatalogClient(
        { baseUrl: BASE, countries: ['IN'], fetchImpl },
        redis, SILENT,
    );
    const items = await client.list();
    assert.equal(items.length, 1);
});

test('catalog: getBySku returns the matching item, or null when missing / out of stock', async () => {
    const redis = new StubRedis();
    const { fetchImpl } = makeFetch({
        IN: { ok: true, operators: [
            mkOp('airtel-in', 'IN', 'Airtel', [{ value: '5' }]),
            { ...mkOp('jio-in', 'IN', 'Jio', [{ value: '5' }]), in_stock: false },
        ] },
    });
    const client = new CatalogClient(
        { baseUrl: BASE, countries: ['IN'], fetchImpl },
        redis, SILENT,
    );

    assert.ok(await client.getBySku('airtel-in'));
    assert.equal(await client.getBySku('jio-in'),   null, 'out-of-stock should resolve to null');
    assert.equal(await client.getBySku('nothing'),  null);
});

test('catalog: refresh tolerates partial country failures', async () => {
    const redis = new StubRedis();
    const { fetchImpl } = makeFetch({
        IN: { ok: true, operators: [mkOp('airtel-in', 'IN', 'Airtel', [{ value: '5' }])] },
        BR: 'error',
    });
    const client = new CatalogClient(
        { baseUrl: BASE, countries: ['IN', 'BR'], fetchImpl },
        redis, SILENT,
    );
    const items = await client.refresh();
    assert.equal(items.length, 1, 'good country should still surface');
});

test('catalog: refresh throws when EVERY country fetch fails', async () => {
    const redis = new StubRedis();
    const { fetchImpl } = makeFetch({ IN: 'error', BR: 'error' });
    const client = new CatalogClient(
        { baseUrl: BASE, countries: ['IN', 'BR'], fetchImpl },
        redis, SILENT,
    );
    await assert.rejects(client.refresh(), /every country fetch failed/);
});

test('renderMenu: groups by country, lists amounts, prompts /buy', () => {
    const items = transformToCatalog([
        mkOp('airtel-in', 'IN', 'Airtel', [{ value: '5' }, { value: '10' }]),
        mkOp('vivo-br',   'BR', 'Vivo',   [{ value: '10' }]),
    ]);
    const text = renderMenu(items);
    assert.match(text, /Top-ups available/);
    assert.match(text, /IN\b/);
    assert.match(text, /BR\b/);
    assert.match(text, /airtel-in/);
    assert.match(text, /vivo-br/);
    assert.match(text, /Use \/buy/);
});

test('renderMenu: empty input produces a friendly fallback', () => {
    assert.match(renderMenu([]), /empty/i);
});
