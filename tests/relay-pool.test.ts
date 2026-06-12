/**
 * RelayPool behaviour. The SimplePool dependency is injected via
 * `poolFactory` so we can drive events deterministically without a live
 * WebSocket. Tests target the observable contract:
 *
 *   - dedup across relays (the same event id is delivered once)
 *   - subscription handle lifecycle (close stops further delivery)
 *   - publish outcomes mirror per-relay success/failure
 *   - constructor invariants (empty relay list, etc.)
 *   - close() releases handles and the periodic timer
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import pino from 'pino';
import type { Filter, NostrEvent } from 'nostr-tools';

import type { PoolBackend } from '../src/relay-pool.js';
import { RelayPool } from '../src/relay-pool.js';

interface StubHandle {
    close():  void;
    deliver:  (event: NostrEvent) => void;
    eose:     () => void;
    isClosed: boolean;
}

class StubPool implements PoolBackend {
    public publishCalls:    Array<{ urls: string[]; event: NostrEvent }> = [];
    public queryCalls:      Array<{ urls: string[]; filter: Filter }> = [];
    public queryResults:    NostrEvent[] = [];
    public subscribeCalls   = 0;
    public connectionStatus = new Map<string, boolean>();
    public publishOutcome:  'all-ok' | 'all-fail' | 'mixed' = 'all-ok';
    private handles: StubHandle[] = [];

    publish(urls: string[], event: NostrEvent): Promise<void>[] {
        this.publishCalls.push({ urls, event });
        return urls.map((_, i) => {
            if (this.publishOutcome === 'all-ok')   return Promise.resolve();
            if (this.publishOutcome === 'all-fail') return Promise.reject(new Error('rejected'));
            return i % 2 === 0 ? Promise.resolve() : Promise.reject(new Error('odd-relay-fail'));
        });
    }

    async querySync(urls: string[], filter: Filter): Promise<NostrEvent[]> {
        this.queryCalls.push({ urls, filter });
        return this.queryResults;
    }

    subscribeMany(
        _urls: string[],
        _filter: Filter,
        callbacks: { onevent: (event: NostrEvent) => void; oneose: () => void },
    ): { close(): void } {
        this.subscribeCalls++;
        const handle: StubHandle = {
            close:    () => { handle.isClosed = true; },
            deliver:  (event) => { if (!handle.isClosed) callbacks.onevent(event); },
            eose:     () => { if (!handle.isClosed) callbacks.oneose(); },
            isClosed: false,
        };
        this.handles.push(handle);
        return handle;
    }

    listConnectionStatus(): Map<string, boolean> { return this.connectionStatus; }
    close(_urls: string[]): void { /* no-op */ }

    lastHandle(): StubHandle | undefined { return this.handles.at(-1); }
    allHandles(): StubHandle[] { return this.handles; }
}

const SILENT = pino({ level: 'silent' });

function makeEvent(id: string): NostrEvent {
    return {
        id,
        pubkey:     'a'.repeat(64),
        created_at: Math.floor(Date.now() / 1000),
        kind:       4,
        tags:       [],
        content:    '',
        sig:        'b'.repeat(128),
    };
}

const FILTER: Filter = { kinds: [4] };

// ------------------------------------------------------------------

test('relay-pool: refuses an empty relay list at construction', () => {
    const stub = new StubPool();
    assert.throws(
        () => new RelayPool({ relays: [], poolFactory: () => stub }, SILENT),
        /at least one relay URL/,
    );
});

test('relay-pool: subscribe handle delivers events, dedup across relays', () => {
    const stub = new StubPool();
    const pool = new RelayPool({ relays: ['wss://a', 'wss://b'], poolFactory: () => stub }, SILENT);

    const received: string[] = [];
    pool.subscribe(FILTER, (e) => { received.push(e.id); });

    const evt = makeEvent('event-1');
    stub.lastHandle()!.deliver(evt);
    stub.lastHandle()!.deliver(evt);   // duplicate from a second relay
    stub.lastHandle()!.deliver(evt);   // and a third

    assert.deepEqual(received, ['event-1']);
    pool.close();
});

test('relay-pool: closing the handle stops further delivery', () => {
    const stub = new StubPool();
    const pool = new RelayPool({ relays: ['wss://a'], poolFactory: () => stub }, SILENT);

    const received: string[] = [];
    const sub = pool.subscribe(FILTER, (e) => { received.push(e.id); });

    stub.lastHandle()!.deliver(makeEvent('before'));
    sub.close();
    stub.lastHandle()!.deliver(makeEvent('after'));

    assert.deepEqual(received, ['before']);
    pool.close();
});

test('relay-pool: publish reports per-relay outcomes', async () => {
    const stub = new StubPool();
    stub.publishOutcome = 'mixed';
    const pool = new RelayPool(
        { relays: ['wss://a', 'wss://b', 'wss://c'], poolFactory: () => stub },
        SILENT,
    );

    const outcomes = await pool.publish(makeEvent('publish-1'));

    assert.equal(outcomes.length, 3);
    assert.equal(outcomes.filter(o => o.ok).length,  2);
    assert.equal(outcomes.filter(o => !o.ok).length, 1);
    assert.equal(stub.publishCalls.length, 1);
    pool.close();
});

test('relay-pool: publish unions extra recipient relays, deduped against the pool list', async () => {
    const stub = new StubPool();
    const pool = new RelayPool(
        { relays: ['wss://a', 'wss://b'], poolFactory: () => stub },
        SILENT,
    );

    const outcomes = await pool.publish(makeEvent('extra-1'), ['wss://b', 'wss://customer-inbox']);

    assert.deepEqual(
        stub.publishCalls[0]!.urls,
        ['wss://a', 'wss://b', 'wss://customer-inbox'],
        'extra relays append after the pool list, duplicates removed',
    );
    assert.equal(outcomes.length, 3);
    pool.close();
});

test('relay-pool: query runs a one-shot fetch over pool + extra relays', async () => {
    const stub = new StubPool();
    stub.queryResults = [makeEvent('q-1')];
    const pool = new RelayPool({ relays: ['wss://a'], poolFactory: () => stub }, SILENT);

    const events = await pool.query({ kinds: [10002] }, { extraRelays: ['wss://indexer'] });

    assert.deepEqual(events.map(e => e.id), ['q-1']);
    assert.deepEqual(stub.queryCalls[0]!.urls, ['wss://a', 'wss://indexer']);
    assert.deepEqual(stub.queryCalls[0]!.filter, { kinds: [10002] });
    pool.close();
});

test('relay-pool: getHealth matches relays when the backend keys are normalized URLs', () => {
    const stub = new StubPool();
    // The real SimplePool keys listConnectionStatus() by normalizeURL()
    // output (trailing slash, lowercase host); config URLs usually lack
    // the slash. getHealth must still find them.
    stub.connectionStatus.set('wss://relay.damus.io/', true);
    stub.connectionStatus.set('wss://nos.lol/', true);
    const pool = new RelayPool(
        { relays: ['wss://relay.damus.io', 'wss://nos.lol'], poolFactory: () => stub },
        SILENT,
    );

    const h = pool.getHealth();
    assert.equal(h.connected, 2, 'normalized backend keys must still count as connected');
    assert.equal(h.relayStatus['wss://relay.damus.io'], 'connected');
    assert.equal(h.relayStatus['wss://nos.lol'], 'connected');
    pool.close();
});

test('relay-pool: publishAtLeastOne throws when every relay rejects', async () => {
    const stub = new StubPool();
    stub.publishOutcome = 'all-fail';
    const pool = new RelayPool(
        { relays: ['wss://a', 'wss://b'], poolFactory: () => stub },
        SILENT,
    );

    await assert.rejects(
        pool.publishAtLeastOne(makeEvent('publish-2')),
        /rejected by all 2 relays/,
    );
    pool.close();
});

test('relay-pool: getHealth reflects per-relay connection status', () => {
    const stub = new StubPool();
    stub.connectionStatus.set('wss://a', true);
    stub.connectionStatus.set('wss://b', false);
    // wss://c left unset -> 'connecting'
    const pool = new RelayPool(
        { relays: ['wss://a', 'wss://b', 'wss://c'], poolFactory: () => stub },
        SILENT,
    );

    const h = pool.getHealth();
    assert.equal(h.total,     3);
    assert.equal(h.connected, 1);
    assert.equal(h.relayStatus['wss://a'], 'connected');
    assert.equal(h.relayStatus['wss://b'], 'closed');
    assert.equal(h.relayStatus['wss://c'], 'connecting');
    pool.close();
});

test('relay-pool: close releases active subscriptions', () => {
    const stub = new StubPool();
    const pool = new RelayPool({ relays: ['wss://a'], poolFactory: () => stub }, SILENT);

    pool.subscribe(FILTER, () => {});
    pool.subscribe({ kinds: [1059] }, () => {});
    assert.equal(stub.allHandles().filter(h => !h.isClosed).length, 2);

    pool.close();
    assert.equal(stub.allHandles().filter(h => !h.isClosed).length, 0);
});

test('relay-pool: subscribe rejects after close', () => {
    const stub = new StubPool();
    const pool = new RelayPool({ relays: ['wss://a'], poolFactory: () => stub }, SILENT);
    pool.close();
    assert.throws(
        () => pool.subscribe(FILTER, () => {}),
        /closed/,
    );
});

test('relay-pool: periodic refresh re-opens every subscription handle', async () => {
    const stub = new StubPool();
    const pool = new RelayPool(
        { relays: ['wss://a'], poolFactory: () => stub, resubscribeMs: 30 },
        SILENT,
    );

    pool.subscribe(FILTER, () => {});
    const firstHandle = stub.lastHandle()!;
    assert.equal(stub.subscribeCalls, 1);

    await new Promise(r => setTimeout(r, 80));
    assert.ok(stub.subscribeCalls >= 2, `expected >=2 subscribe calls after refresh tick, got ${stub.subscribeCalls}`);
    assert.equal(firstHandle.isClosed, true, 'old handle should be closed by refresh');
    pool.close();
});
