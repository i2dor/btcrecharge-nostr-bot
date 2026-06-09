/**
 * SessionStore behaviour. We exercise the store against a small in-memory
 * Redis stub that mirrors the ioredis surface SessionStore actually uses
 * (get / set EX / del / watch / unwatch / multi.exec). Real Redis is left
 * for the integration suite in Phase 3 - here we pin the contract:
 *
 *   - blank session shape parses through the zod schema
 *   - save -> get round-trip preserves every field
 *   - mutate updates atomically and retries on WATCH conflict
 *   - touch refreshes TTL without changing the stored value
 *   - the order reverse index is independent of the session entry
 *   - schema rejects bad data on the way in AND on the way out
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import pino from 'pino';

import type { CustomerSession, RedisLike, RedisLikePipeline } from '../src/session.js';
import { SESSION_TTL_SECONDS, SessionStore, blankSession } from '../src/session.js';

// ----- in-memory Redis stub ----------------------------------------

interface Entry { value: string; expiresAt: number | null }

class InMemoryRedis implements RedisLike {
    private store    = new Map<string, Entry>();
    private watched: Set<string> = new Set();
    private modifiedSinceWatch = new Set<string>();
    /** Test-only knob: force the next exec() to fail (simulate WATCH conflict). */
    public forceNextExecConflict = false;
    /** Test-only counter: how many times exec ran successfully. */
    public execSuccessCount = 0;

    async get(key: string): Promise<string | null> {
        const e = this.store.get(key);
        if (!e) return null;
        if (e.expiresAt !== null && Date.now() > e.expiresAt) {
            this.store.delete(key);
            return null;
        }
        return e.value;
    }

    async set(key: string, value: string, mode: 'EX', seconds: number): Promise<'OK'> {
        if (mode !== 'EX') throw new Error('stub only implements EX');
        this.store.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
        if (this.watched.has(key)) this.modifiedSinceWatch.add(key);
        return 'OK';
    }

    async del(...keys: string[]): Promise<number> {
        let n = 0;
        for (const k of keys) if (this.store.delete(k)) n++;
        return n;
    }

    async watch(...keys: string[]): Promise<'OK'> {
        for (const k of keys) this.watched.add(k);
        return 'OK';
    }

    async unwatch(): Promise<'OK'> {
        this.watched.clear();
        this.modifiedSinceWatch.clear();
        return 'OK';
    }

    multi(): RedisLikePipeline {
        const ops: Array<() => Promise<void>> = [];
        const self = this;
        const pipeline: RedisLikePipeline = {
            set(key, value, mode, seconds) {
                ops.push(async () => { await self.set(key, value, mode, seconds); });
                return pipeline;
            },
            del(key) {
                ops.push(async () => { await self.del(key); });
                return pipeline;
            },
            async exec() {
                // If any watched key was modified since WATCH, abort.
                const conflict = self.forceNextExecConflict ||
                                  [...self.watched].some(k => self.modifiedSinceWatch.has(k));
                self.forceNextExecConflict = false;
                self.watched.clear();
                self.modifiedSinceWatch.clear();
                if (conflict) return null;
                for (const op of ops) await op();
                self.execSuccessCount++;
                return ops.map(() => [null, 'OK'] as [Error | null, unknown]);
            },
        };
        return pipeline;
    }

    // ----- test helpers ----------------------------------------------
    snapshot(): Record<string, string> {
        const out: Record<string, string> = {};
        for (const [k, v] of this.store) out[k] = v.value;
        return out;
    }

    ttlOf(key: string): number | null {
        const e = this.store.get(key);
        return e?.expiresAt ?? null;
    }
}

const SILENT = pino({ level: 'silent' });
const PUBKEY = 'a'.repeat(64);

// ----- tests --------------------------------------------------------

test('session: blank session shape passes schema validation', () => {
    const s = blankSession(PUBKEY);
    assert.equal(s.pubkey, PUBKEY);
    assert.equal(s.protocol, null);
    assert.equal(s.flow.type, 'idle');
    assert.equal(s.cart.length, 0);
    assert.equal(s.metadata.firstSeen, s.metadata.lastSeen);
    assert.equal(s.metadata.totalOrders, 0);
});

test('session: save then get round-trips all fields', async () => {
    const redis = new InMemoryRedis();
    const store = new SessionStore(redis, SILENT);

    const original = blankSession(PUBKEY);
    original.protocol = 'nip17';
    original.cart.push({ sku: 'airtel-in-5', amount: 5, phone: '+918123456789' });
    original.flow = { type: 'confirming_amount', ctx: { carrier: 'airtel-in' } };

    await store.save(original);
    const fetched = await store.get(PUBKEY);
    assert.ok(fetched);
    assert.equal(fetched.protocol, 'nip17');
    assert.equal(fetched.cart[0]!.sku, 'airtel-in-5');
    assert.equal(fetched.flow.type, 'confirming_amount');
    assert.equal((fetched.flow.ctx as { carrier: string }).carrier, 'airtel-in');
});

test('session: get on missing pubkey returns null', async () => {
    const store = new SessionStore(new InMemoryRedis(), SILENT);
    assert.equal(await store.get('b'.repeat(64)), null);
});

test('session: mutate creates a new session when none exists', async () => {
    const redis = new InMemoryRedis();
    const store = new SessionStore(redis, SILENT);

    const result = await store.mutate(PUBKEY, (s) => {
        s.protocol = 'nip04';
        return s;
    });
    assert.equal(result.protocol, 'nip04');
    assert.equal((await store.get(PUBKEY))?.protocol, 'nip04');
});

test('session: mutate retries once on WATCH conflict and then succeeds', async () => {
    const redis = new InMemoryRedis();
    const store = new SessionStore(redis, SILENT);

    redis.forceNextExecConflict = true;     // first exec returns null
    let callCount = 0;
    const result = await store.mutate(PUBKEY, (s) => {
        callCount++;
        s.cart.push({ sku: 'jio-in-5', amount: 5, phone: '+910000000000' });
        return s;
    });
    assert.equal(callCount, 2, 'fn should be invoked twice (one retry after conflict)');
    assert.equal(result.cart.length, 1);
    assert.equal(redis.execSuccessCount, 1);
});

test('session: touch refreshes TTL without changing value', async () => {
    const redis = new InMemoryRedis();
    const store = new SessionStore(redis, SILENT);

    await store.save(blankSession(PUBKEY));
    const originalSnap = redis.snapshot();
    const originalTtl  = redis.ttlOf('nostr-bot:session:' + PUBKEY);

    await new Promise(r => setTimeout(r, 5));
    const ok = await store.touch(PUBKEY);
    assert.equal(ok, true);
    assert.deepEqual(redis.snapshot(), originalSnap);
    assert.ok(redis.ttlOf('nostr-bot:session:' + PUBKEY)! > originalTtl!,
        'TTL should have moved forward');
});

test('session: touch on missing key returns false', async () => {
    const store = new SessionStore(new InMemoryRedis(), SILENT);
    assert.equal(await store.touch('c'.repeat(64)), false);
});

test('session: linkOrder + lookupPubkey are independent of session entry', async () => {
    const redis = new InMemoryRedis();
    const store = new SessionStore(redis, SILENT);

    await store.linkOrder('order-1', PUBKEY);
    assert.equal(await store.lookupPubkey('order-1'), PUBKEY);

    await store.delete(PUBKEY);
    assert.equal(await store.get(PUBKEY), null);
    // Order index survives session delete.
    assert.equal(await store.lookupPubkey('order-1'), PUBKEY);

    await store.unlinkOrder('order-1');
    assert.equal(await store.lookupPubkey('order-1'), null);
});

test('session: save rejects malformed CustomerSession', async () => {
    const store = new SessionStore(new InMemoryRedis(), SILENT);
    const bad = { ...blankSession(PUBKEY) } as CustomerSession;
    (bad as unknown as { pubkey: string }).pubkey = 'not-hex';
    await assert.rejects(() => store.save(bad));
});

test('session: get rejects corrupted Redis value', async () => {
    const redis = new InMemoryRedis();
    await redis.set('nostr-bot:session:' + PUBKEY, '{not valid json', 'EX', SESSION_TTL_SECONDS);
    const store = new SessionStore(redis, SILENT);
    await assert.rejects(() => store.get(PUBKEY));
});
