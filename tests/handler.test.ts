/**
 * Handler pipeline integration test.
 *
 * We DO use the real crypto + commands + render + session modules; only
 * the boundary types (RelayPool, CatalogClient, BtcrechargeClient,
 * Redis) are faked. Pinned contract:
 *
 *   - a real NIP-04 event from a customer secret to the bot pubkey
 *     round-trips: decrypt, FSM, render, encrypt, publish, and the
 *     reply ciphertext decrypts back with the customer's secret,
 *   - stale DMs (relay replay / redeploy backlog) drop without a reply,
 *   - buildInboundFilters splits the since per kind: tight for kind 4,
 *     2-day window for kind 1059 (NIP-59 backdates wrap timestamps),
 *   - replies route to the recipient relays the resolver returns.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import pino from 'pino';
import {
    generateSecretKey,
    getPublicKey,
    nip04,
    type NostrEvent,
} from 'nostr-tools';

import type { BtcrechargeClient } from '../src/btcrecharge-client.js';
import type { CatalogClient } from '../src/catalog.js';
import { encryptNip04 } from '../src/crypto.js';
import { buildInboundFilters, handleIncomingDm } from '../src/handler.js';
import type { RelayPool } from '../src/relay-pool.js';
import {
    SessionStore,
    type RedisLike,
    type RedisLikePipeline,
} from '../src/session.js';

const SILENT = pino({ level: 'silent' });
const CALLBACK_URL = 'https://bot.example/webhook/order';

// Same InMemoryRedis stub session.test.ts uses, trimmed to what handler
// needs (no WATCH-conflict knob - one DM at a time in these tests).
class InMemoryRedis implements RedisLike {
    private store = new Map<string, { value: string; expiresAt: number | null }>();
    async get(key: string): Promise<string | null> {
        const e = this.store.get(key);
        if (!e) return null;
        if (e.expiresAt !== null && Date.now() > e.expiresAt) {
            this.store.delete(key);
            return null;
        }
        return e.value;
    }
    async set(key: string, value: string, _mode: 'EX', seconds: number): Promise<'OK'> {
        this.store.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
        return 'OK';
    }
    async del(...keys: string[]): Promise<number> {
        let n = 0;
        for (const k of keys) if (this.store.delete(k)) n++;
        return n;
    }
    async watch(..._keys: string[]): Promise<'OK'> { return 'OK'; }
    async unwatch(): Promise<'OK'> { return 'OK'; }
    multi(): RedisLikePipeline {
        const ops: Array<() => Promise<void>> = [];
        const pipeline: RedisLikePipeline = {
            set: (key, value, mode, seconds) => {
                ops.push(async () => { await this.set(key, value, mode, seconds); });
                return pipeline;
            },
            del: (key) => {
                ops.push(async () => { await this.del(key); });
                return pipeline;
            },
            exec: async () => {
                for (const op of ops) await op();
                return ops.map(() => [null, 'OK'] as [Error | null, unknown]);
            },
        };
        return pipeline;
    }
}

const stubCatalog     = { list: async () => [] } as unknown as CatalogClient;
const stubBtcrecharge = {} as unknown as BtcrechargeClient;

test('handleIncomingDm: /help round-trips - decrypt, FSM, render, encrypt, publish', async () => {
    const botSecret = generateSecretKey();
    const botPubkey = getPublicKey(botSecret);
    const cusSecret = generateSecretKey();
    const cusPubkey = getPublicKey(cusSecret);

    const sessionStore = new SessionStore(new InMemoryRedis(), SILENT);

    const published: NostrEvent[] = [];
    const relayPool = {
        publish: async (ev: NostrEvent) => {
            published.push(ev);
            return [{ url: 'wss://test', ok: true }];
        },
    } as unknown as RelayPool;

    const inbound = encryptNip04(cusSecret, botPubkey, '/help');

    await handleIncomingDm(inbound, {
        botSecret,
        sessionStore,
        catalog:     stubCatalog,
        btcrecharge: stubBtcrecharge,
        relayPool,
        callbackUrl: CALLBACK_URL,
        minPowBits:  0,
        logger:      SILENT,
    });

    assert.ok(published.length >= 1, 'expected at least one reply published');
    const nip04Reply = published.find((e) => e.kind === 4);
    assert.ok(nip04Reply, 'expected a NIP-04 reply (kind=4) matching the inbound protocol');

    const pTag = nip04Reply.tags.find((t) => t[0] === 'p');
    assert.ok(pTag, 'reply must carry a #p tag for the recipient');
    assert.equal(pTag![1], cusPubkey);

    const replyText = await nip04.decrypt(cusSecret, botPubkey, nip04Reply.content);
    assert.match(replyText, /\/menu/);
    assert.match(replyText, /\/help/);
});

test('handleIncomingDm: stale DM (relay replay / redeploy backlog) drops without a reply', async () => {
    const botSecret = generateSecretKey();
    const botPubkey = getPublicKey(botSecret);
    const cusSecret = generateSecretKey();

    const sessionStore = new SessionStore(new InMemoryRedis(), SILENT);

    const published: NostrEvent[] = [];
    const relayPool = {
        publish: async (ev: NostrEvent) => {
            published.push(ev);
            return [{ url: 'wss://t', ok: true }];
        },
        publishAtLeastOne: async (ev: NostrEvent) => { published.push(ev); },
    } as unknown as RelayPool;

    // Real ciphertext but the event claims it was sent an hour ago - the
    // shape a relay replays after a re-subscribe or a bot redeploy.
    const inbound = {
        ...encryptNip04(cusSecret, botPubkey, '/help'),
        created_at: Math.floor(Date.now() / 1000) - 3600,
    };

    await handleIncomingDm(inbound, {
        botSecret,
        sessionStore,
        catalog:     stubCatalog,
        btcrecharge: stubBtcrecharge,
        relayPool,
        callbackUrl: CALLBACK_URL,
        minPowBits:  0,
        logger:      SILENT,
    });

    assert.equal(published.length, 0, 'stale DM must not produce a reply (would double-answer old messages)');
});

test('buildInboundFilters: tight since for kind 4, 2-day window for kind 1059 gift wraps', () => {
    const nowSec = 1_750_000_000;
    const botPubkey = 'f'.repeat(64);
    const filters = buildInboundFilters(botPubkey, nowSec);

    assert.equal(filters.length, 2);
    const f4 = filters.find((f) => f.kinds?.includes(4));
    const f1059 = filters.find((f) => f.kinds?.includes(1059));
    assert.ok(f4, 'expected a kind-4 filter');
    assert.ok(f1059, 'expected a kind-1059 filter');

    assert.deepEqual(f4['#p'], [botPubkey]);
    assert.deepEqual(f1059['#p'], [botPubkey]);

    assert.equal(f4.since, nowSec - 300);
    // NIP-59 randomizes the wrap created_at up to 2 days into the past;
    // a tighter since silently filters out most NIP-17 DMs at the relay.
    assert.ok(
        f1059.since !== undefined && f1059.since <= nowSec - 2 * 86_400,
        'gift-wrap since must cover the full 2-day backdate window',
    );
});

test('handleIncomingDm: replies route to the recipient relays the resolver returns', async () => {
    const botSecret = generateSecretKey();
    const botPubkey = getPublicKey(botSecret);
    const cusSecret = generateSecretKey();
    const cusPubkey = getPublicKey(cusSecret);

    const sessionStore = new SessionStore(new InMemoryRedis(), SILENT);

    const publishExtras: Array<readonly string[] | undefined> = [];
    const relayPool = {
        publish: async (_ev: NostrEvent, extraRelays?: readonly string[]) => {
            publishExtras.push(extraRelays);
            return [{ url: 'wss://test', ok: true }];
        },
    } as unknown as RelayPool;

    const resolveCalls: string[] = [];
    const recipientRelays = {
        resolve: async (pubkey: string) => {
            resolveCalls.push(pubkey);
            return ['wss://customer-inbox'];
        },
    };

    const inbound = encryptNip04(cusSecret, botPubkey, '/help');
    await handleIncomingDm(inbound, {
        botSecret,
        sessionStore,
        catalog:     stubCatalog,
        btcrecharge: stubBtcrecharge,
        relayPool,
        callbackUrl: CALLBACK_URL,
        minPowBits:  0,
        recipientRelays,
        logger:      SILENT,
    });

    assert.deepEqual(resolveCalls, [cusPubkey], 'resolver must be asked for the SENDER pubkey');
    assert.ok(publishExtras.length >= 1, 'expected at least one publish');
    for (const extras of publishExtras) {
        assert.deepEqual(extras, ['wss://customer-inbox']);
    }
});
