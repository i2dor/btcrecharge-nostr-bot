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
import type { BtcrechargeClient } from '../src/btcrecharge-client.js';
import type { CustomerSession, SessionStore } from '../src/session.js';

const SILENT = pino({ level: 'silent' });

function makeSession(): CustomerSession {
    return {
        pubkey:          'a'.repeat(64),
        protocol:        'nip04',
        flow:            { type: 'idle', ctx: {} },
        cart:            [],
        pendingOrderIds: [],
        rateLimit:       { bucket: 10, lastRefill: 0 },
        metadata:        { firstSeen: 0, lastSeen: 0, totalOrders: 0 },
    };
}

interface StubOpts {
    /** Make catalog.getBySku / catalog.list throw. */
    catalogThrows?: boolean;
    /** Catalog item to return from getBySku when not throwing. */
    catalogItem?: CatalogItem | null;
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
    } as unknown as BtcrechargeClient;

    const sessionStore = {
        linkOrder: async () => { /* noop */ },
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
    // Each amount in the catalog row should appear as "N) <amount> <currency>".
    assert.match(reply, /1\) 4\.76 EUR/);
    assert.match(reply, /2\) 6\.95 EUR/);
    assert.match(reply, /3\) 13\.90 EUR/);
    assert.match(reply, /4\) 27\.80 EUR/);
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
    assert.match(reply, /Vodafone Romania 13\.90 EUR -> \+40734145710/);
    assert.match(reply, /\/confirm/);
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
