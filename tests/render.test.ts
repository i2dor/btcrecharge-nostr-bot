/**
 * Render layer behaviour.
 *
 * The catalog can throw mid-/confirm if Redis blips or upstream is down.
 * Before the fix in commit 94892ca, that error would propagate up through
 * `getBySku` into the handler's silent catch-all and the customer got no
 * reply. We pin the observable contract: any catalog throw during invoice
 * creation surfaces a user-visible message, never silence.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import pino from 'pino';

import { actionToText, type RenderDeps } from '../src/render.js';
import type { CatalogClient, CatalogItem } from '../src/catalog.js';
import { BtcrechargeApiError, type BtcrechargeClient } from '../src/btcrecharge-client.js';
import type { CustomerSession, SessionStore } from '../src/session.js';

const SILENT = pino({ level: 'silent' });

function makeSession(): CustomerSession {
    return {
        pubkey:                'a'.repeat(64),
        protocol:              'nip04',
        flow:                  { type: 'idle', ctx: {} },
        cart:                  [],
        pendingOrderIds:       [],
        refundPendingOrderIds: [],
        rateLimit:             { bucket: 10, lastRefill: 0 },
        metadata:              { firstSeen: 0, lastSeen: 0, totalOrders: 0 },
    };
}

interface StubOpts {
    /** Make catalog.getBySku / catalog.list throw. */
    catalogThrows?: boolean;
    /** Catalog item to return from getBySku when not throwing. */
    catalogItem?: CatalogItem | null;
    /** Behaviour for btcrecharge.submitRefundAddress. */
    submitRefundAddress?: 'ok' | BtcrechargeApiError | Error;
}

function makeDeps(opts: StubOpts = {}): RenderDeps {
    const catalog = {
        list: async () => {
            if (opts.catalogThrows) throw new Error('upstream down');
            return [];
        },
        getBySku: async () => {
            if (opts.catalogThrows) throw new Error('upstream down');
            return opts.catalogItem ?? null;
        },
    } as unknown as CatalogClient;

    const btcrecharge = {
        createLightningOrder: async () => {
            throw new Error('should not be reached in these tests');
        },
        submitRefundAddress: async () => {
            const s = opts.submitRefundAddress;
            if (s === undefined || s === 'ok') return { ok: true as const, state: 'refund_pending' };
            throw s;
        },
    } as unknown as BtcrechargeClient;

    const sessionStore = {
        linkOrder: async () => { /* noop */ },
        mutate:    async (_pk: string, fn: (s: CustomerSession) => CustomerSession) => fn(makeSession()),
    } as unknown as SessionStore;

    return {
        catalog,
        btcrecharge,
        sessionStore,
        callbackUrl: 'https://example.test/webhook/order',
        logger:      SILENT,
    };
}

test('send_menu surfaces a user-visible message when catalog.list throws', async () => {
    const deps   = makeDeps({ catalogThrows: true });
    const reply  = await actionToText({ kind: 'send_menu' }, makeSession(), deps);
    assert.ok(reply, 'reply must not be null');
    assert.match(reply, /temporarily unavailable/i);
});

test('send_invoice surfaces a user-visible message when catalog.getBySku throws', async () => {
    // Regression for the "nu vine nimic dupa /confirm" bug: before the fix
    // a catalog throw here propagated past createInvoice into the handler's
    // silent catch-all and the customer saw no reply at all.
    const deps  = makeDeps({ catalogThrows: true });
    const reply = await actionToText(
        { kind: 'send_invoice', sku: 'vodafone-romania', amountIndex: 1, phone: '+40734145710' },
        makeSession(),
        deps,
    );
    assert.ok(reply, 'reply must not be null');
    assert.match(reply, /temporarily unavailable/i);
});

test('send_invoice reports an unknown SKU when catalog returns null', async () => {
    const deps  = makeDeps({ catalogItem: null });
    const reply = await actionToText(
        { kind: 'send_invoice', sku: 'nonexistent-xx', amountIndex: 1, phone: '+40734145710' },
        makeSession(),
        deps,
    );
    assert.ok(reply, 'reply must not be null');
    assert.match(reply, /Unknown SKU/);
});

// ----- amount selection (Phase 2.6) ---------------------------------

const VODAFONE_RO_ITEM: CatalogItem = {
    sku:        'vodafone-romania-ro',
    operatorId: 'vodafone-romania',
    label:      'Vodafone Romania',
    country:    'RO',
    currency:   'EUR',
    amounts:    ['4.76', '6.95', '13.90', '27.80'],
    inStock:    true,
};

test('send_amounts renders a numbered list keyed to the catalog order', async () => {
    const deps  = makeDeps({ catalogItem: VODAFONE_RO_ITEM });
    const reply = await actionToText({ kind: 'send_amounts', sku: 'vodafone-romania-ro' }, makeSession(), deps);
    assert.ok(reply, 'reply must not be null');
    // Each amount in the catalog row should appear as "N) <amount> <currency>"
    // at line start - no column padding (proportional fonts mash it).
    assert.match(reply, /^1\) 4\.76 EUR$/m);
    assert.match(reply, /^2\) 6\.95 EUR$/m);
    assert.match(reply, /^3\) 13\.90 EUR$/m);
    assert.match(reply, /^4\) 27\.80 EUR$/m);
    assert.match(reply, /Reply with the number/);
});

test('send_confirm_prompt echoes the chosen amount so the customer can verify before /confirm', async () => {
    const deps  = makeDeps({ catalogItem: VODAFONE_RO_ITEM });
    const reply = await actionToText(
        { kind: 'send_confirm_prompt', sku: 'vodafone-romania-ro', amountIndex: 3, phone: '+40734145710' },
        makeSession(),
        deps,
    );
    assert.ok(reply, 'reply must not be null');
    // Index 3 means amounts[2] -> "13.90", not the first row (4.76) the
    // pre-Phase-2.6 bot would have auto-picked.
    assert.match(reply, /^Vodafone Romania - 13\.90 EUR -> \+40734145710$/m);
    assert.match(reply, /\/confirm/);
});

test('send_help lists commands with " - " delimiters (no column padding)', async () => {
    const deps  = makeDeps();
    const reply = await actionToText({ kind: 'send_help' }, makeSession(), deps);
    assert.ok(reply, 'reply must not be null');
    assert.match(reply, /^\/menu - list available countries$/m);
    assert.match(reply, /^\/menu <cc> - see top-ups for a country \(e\.g\. \/menu RO\)$/m);
    assert.match(reply, /^\/buy <sku> - start a purchase \(e\.g\. \/buy vodafone-romania-ro\)$/m);
    assert.match(reply, /^\/cancel - abort an in-flight order$/m);
    assert.match(reply, /^\/clear - empty the cart$/m);
});

test('send_cart non-empty: one " - " delimited line per item', async () => {
    const deps    = makeDeps();
    const session = makeSession();
    session.cart = [{ sku: 'vodafone-romania-ro', amount: 5, phone: '+40734145710' }];
    const reply = await actionToText({ kind: 'send_cart' }, session, deps);
    assert.ok(reply, 'reply must not be null');
    assert.match(reply, /^vodafone-romania-ro - 5 -> \+40734145710$/m);
});

test('send_pending_orders empty: tells the customer they have no orders in flight', async () => {
    const deps    = makeDeps();
    const session = makeSession();
    session.pendingOrderIds = [];
    const reply = await actionToText({ kind: 'send_pending_orders' }, session, deps);
    assert.ok(reply, 'reply must not be null');
    assert.match(reply, /No orders in flight/i);
});

test('send_pending_orders non-empty: lists each remembered order ID', async () => {
    const deps    = makeDeps();
    const session = makeSession();
    session.pendingOrderIds = ['1015', '1019'];
    const reply = await actionToText({ kind: 'send_pending_orders' }, session, deps);
    assert.ok(reply, 'reply must not be null');
    assert.match(reply, /^Order 1015 - I will DM you when it changes state\.$/m);
    assert.match(reply, /^Order 1019 - I will DM you when it changes state\.$/m);
});

// ----- Phase 3: refund address ---------------------------------------

test('submit_refund_address (success): tells the customer the address is being verified', async () => {
    const deps  = makeDeps({ submitRefundAddress: 'ok' });
    const reply = await actionToText(
        { kind: 'submit_refund_address', orderId: '1042', address: 'alice@walletofsatoshi.com' },
        makeSession(),
        deps,
    );
    assert.ok(reply, 'reply must not be null');
    assert.match(reply, /verifying alice@walletofsatoshi\.com/);
    assert.match(reply, /refund is on the way/);
});

test('submit_refund_address (unreachable_address): asks for a different address', async () => {
    const deps = makeDeps({
        submitRefundAddress: new BtcrechargeApiError(400, 'unreachable_address', 'no response'),
    });
    const reply = await actionToText(
        { kind: 'submit_refund_address', orderId: '1042', address: 'broken@nowhere.test' },
        makeSession(),
        deps,
    );
    assert.ok(reply, 'reply must not be null');
    assert.match(reply, /does not seem reachable/);
    assert.match(reply, /different one/);
});

test('submit_refund_address (order_not_refundable): tells the customer the order moved on', async () => {
    const deps = makeDeps({
        submitRefundAddress: new BtcrechargeApiError(409, 'order_not_refundable', 'already refunded'),
    });
    const reply = await actionToText(
        { kind: 'submit_refund_address', orderId: '1042', address: 'alice@walletofsatoshi.com' },
        makeSession(),
        deps,
    );
    assert.ok(reply, 'reply must not be null');
    assert.match(reply, /no longer in refund_pending/);
});

test('submit_refund_address (5xx / network): asks to retry the same address shortly', async () => {
    const deps = makeDeps({
        submitRefundAddress: new BtcrechargeApiError(503, 'backend_down', 'temporary'),
    });
    const reply = await actionToText(
        { kind: 'submit_refund_address', orderId: '1042', address: 'alice@walletofsatoshi.com' },
        makeSession(),
        deps,
    );
    assert.ok(reply, 'reply must not be null');
    assert.match(reply, /Could not reach the refund service/);
    assert.match(reply, /try again/);
});

test('submit_refund_address (non-numeric orderId): bails with a support nudge instead of crashing', async () => {
    const deps  = makeDeps();
    const reply = await actionToText(
        { kind: 'submit_refund_address', orderId: 'not-a-number', address: 'alice@walletofsatoshi.com' },
        makeSession(),
        deps,
    );
    assert.ok(reply, 'reply must not be null');
    assert.match(reply, /Something is off|contact support/i);
});

test('send_confirm_prompt reports an out-of-range pick instead of silently substituting', async () => {
    const deps  = makeDeps({ catalogItem: VODAFONE_RO_ITEM });
    const reply = await actionToText(
        { kind: 'send_confirm_prompt', sku: 'vodafone-romania-ro', amountIndex: 99, phone: '+40734145710' },
        makeSession(),
        deps,
    );
    assert.ok(reply, 'reply must not be null');
    assert.match(reply, /outside the list/i);
    assert.match(reply, /1 to 4/);
});
