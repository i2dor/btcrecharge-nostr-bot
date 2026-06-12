/**
 * RecipientRelays behaviour: resolve a customer's DM inbox relays from
 * kind 10050 (NIP-17 DM relays) with kind 10002 (NIP-65 relay list)
 * read entries as the fallback. The pool is stubbed; we pin the
 * selection, caching, and failure contract that handler/webhook-server
 * rely on.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import pino from 'pino';
import type { Filter, NostrEvent } from 'nostr-tools';

import { RecipientRelays } from '../src/nip65.js';

const SILENT = pino({ level: 'silent' });
const PUBKEY = 'c'.repeat(64);

function makeEvent(kind: number, tags: string[][], createdAt = 1_750_000_000): NostrEvent {
    return {
        id:         Math.random().toString(16).slice(2).padEnd(64, '0'),
        pubkey:     PUBKEY,
        created_at: createdAt,
        kind,
        tags,
        content:    '',
        sig:        'd'.repeat(128),
    };
}

class StubQueryPool {
    public calls: Filter[] = [];
    public results: NostrEvent[] = [];
    public fail = false;
    async query(filter: Filter): Promise<NostrEvent[]> {
        this.calls.push(filter);
        if (this.fail) throw new Error('relay query timed out');
        return this.results;
    }
}

test('nip65: prefers kind 10050 DM relays over the 10002 fallback', async () => {
    const pool = new StubQueryPool();
    pool.results = [
        makeEvent(10002, [['r', 'wss://general-read']]),
        makeEvent(10050, [['relay', 'wss://dm-inbox-1'], ['relay', 'wss://dm-inbox-2']]),
    ];
    const resolver = new RecipientRelays(pool, SILENT);

    const relays = await resolver.resolve(PUBKEY);

    assert.deepEqual(relays, ['wss://dm-inbox-1', 'wss://dm-inbox-2']);
    assert.deepEqual(pool.calls[0]!.kinds?.slice().sort((a, b) => a - b), [10002, 10050]);
    assert.deepEqual(pool.calls[0]!.authors, [PUBKEY]);
});

test('nip65: falls back to 10002 read/unmarked entries, skips write-only and garbage', async () => {
    const pool = new StubQueryPool();
    pool.results = [
        makeEvent(10002, [
            ['r', 'wss://read-only', 'read'],
            ['r', 'wss://both-directions'],
            ['r', 'wss://write-only', 'write'],
            ['r', 'https://not-a-relay'],
        ]),
    ];
    const resolver = new RecipientRelays(pool, SILENT);

    const relays = await resolver.resolve(PUBKEY);

    assert.deepEqual(relays, ['wss://read-only', 'wss://both-directions']);
});

test('nip65: the newest relay-list event wins, capped at maxRelays', async () => {
    const pool = new StubQueryPool();
    pool.results = [
        makeEvent(10050, [['relay', 'wss://stale']], 1_700_000_000),
        makeEvent(
            10050,
            [['relay', 'wss://r1'], ['relay', 'wss://r2'], ['relay', 'wss://r3']],
            1_750_000_000,
        ),
    ];
    const resolver = new RecipientRelays(pool, SILENT, { maxRelays: 2 });

    const relays = await resolver.resolve(PUBKEY);

    assert.deepEqual(relays, ['wss://r1', 'wss://r2']);
});

test('nip65: resolutions are cached per pubkey', async () => {
    const pool = new StubQueryPool();
    pool.results = [makeEvent(10050, [['relay', 'wss://cached']])];
    const resolver = new RecipientRelays(pool, SILENT);

    assert.deepEqual(await resolver.resolve(PUBKEY), ['wss://cached']);
    assert.deepEqual(await resolver.resolve(PUBKEY), ['wss://cached']);
    assert.equal(pool.calls.length, 1, 'second resolve must come from cache');
});

test('nip65: a failed query returns [] uncached so the next DM retries', async () => {
    const pool = new StubQueryPool();
    pool.fail = true;
    const resolver = new RecipientRelays(pool, SILENT);

    assert.deepEqual(await resolver.resolve(PUBKEY), []);

    pool.fail = false;
    pool.results = [makeEvent(10050, [['relay', 'wss://recovered']])];
    assert.deepEqual(await resolver.resolve(PUBKEY), ['wss://recovered']);
    assert.equal(pool.calls.length, 2);
});
