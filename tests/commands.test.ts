/**
 * Command parser + FSM behaviour. The FSM is a pure function, so every
 * scenario reduces to "given session S and intent I, the next session
 * is S' and the action list is A". We exercise:
 *
 *   - slash + slash-less parsing of every command
 *   - mid-flow free-text (phone, yes/no) routed to the right intent kind
 *   - the happy path /menu -> /buy -> phone -> /confirm -> invoice
 *   - /cancel from every state returns to idle
 *   - unknown input in awaiting_payment nudges the customer, does not
 *     reset their pending invoice
 *   - exhaustive switch keeps the union covered at compile time
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { CustomerSession } from '../src/session.js';
import { blankSession } from '../src/session.js';
import { parseCommand, transition } from '../src/commands.js';

const PUBKEY = 'a'.repeat(64);
const idle = (): CustomerSession => blankSession(PUBKEY);
const inFlow = (type: CustomerSession['flow']['type'], ctx: Record<string, unknown> = {}): CustomerSession => ({
    ...blankSession(PUBKEY),
    flow: { type, ctx },
});

// ------------------------------------------------------------------
// parser
// ------------------------------------------------------------------

test('parser: every slash command maps to the right intent kind', () => {
    const s = idle();
    assert.equal(parseCommand('/start',  s.flow).kind, 'start');
    assert.equal(parseCommand('/help',   s.flow).kind, 'help');
    assert.equal(parseCommand('/menu',   s.flow).kind, 'menu');
    assert.equal(parseCommand('/cart',   s.flow).kind, 'cart');
    assert.equal(parseCommand('/clear',  s.flow).kind, 'clear');
    assert.equal(parseCommand('/cancel', s.flow).kind, 'cancel');
});

test('parser: slash-less common commands also parse (customers forget the slash)', () => {
    const s = idle();
    assert.equal(parseCommand('menu',  s.flow).kind, 'menu');
    assert.equal(parseCommand('help',  s.flow).kind, 'help');
    assert.equal(parseCommand('start', s.flow).kind, 'start');
});

test('parser: /buy carries the lowercased sku argument', () => {
    const i = parseCommand('/buy Airtel-IN-5', idle().flow);
    assert.equal(i.kind, 'buy');
    if (i.kind === 'buy') assert.equal(i.sku, 'airtel-in-5');
});

test('parser: /buy without an argument is unknown', () => {
    const i = parseCommand('/buy', idle().flow);
    assert.equal(i.kind, 'unknown');
});

test('parser: /status carries the order id verbatim', () => {
    const i = parseCommand('/status ord-abc', idle().flow);
    assert.equal(i.kind, 'status');
    if (i.kind === 'status') assert.equal(i.orderId, 'ord-abc');
});

test('parser: in entering_phone, a bare phone number is parsed as phone supply', () => {
    const flow = inFlow('entering_phone', { sku: 'airtel-in-5' }).flow;
    const i    = parseCommand('+91 81234 56789', flow);
    assert.equal(i.kind, 'phone');
    if (i.kind === 'phone') assert.equal(i.value, '+918123456789');
});

test('parser: in confirming_amount, "yes" / "no" map to confirm / cancel', () => {
    const flow = inFlow('confirming_amount', { sku: 'x', phone: '+1' }).flow;
    assert.equal(parseCommand('yes', flow).kind, 'confirm');
    assert.equal(parseCommand('n',   flow).kind, 'cancel');
});

test('parser: gibberish becomes unknown', () => {
    assert.equal(parseCommand('asdf qwer', idle().flow).kind, 'unknown');
});

// ----- Phase 3: Lightning address / LNURL parsing --------------------

test('parser: Lightning address (LUD-16) is recognised in ANY flow', () => {
    // Customers can paste an address mid-/menu / mid-idle; FSM routes
    // it against pendingRefundOrderIds, parser does not gate on flow.
    for (const flow of [idle().flow, inFlow('awaiting_refund_address', { orderId: '42' }).flow, inFlow('selecting_amount', { sku: 'x' }).flow]) {
        const i = parseCommand('alice@walletofsatoshi.com', flow);
        assert.equal(i.kind, 'ln_address', `flow ${flow.type} should still recognise the address`);
        if (i.kind === 'ln_address') assert.equal(i.value, 'alice@walletofsatoshi.com');
    }
});

test('parser: Lightning address is lowercased on storage', () => {
    const i = parseCommand('ALICE@WalletOfSatoshi.COM', idle().flow);
    assert.equal(i.kind, 'ln_address');
    if (i.kind === 'ln_address') assert.equal(i.value, 'alice@walletofsatoshi.com');
});

test('parser: LNURL-pay bech32 is recognised as ln_address', () => {
    const lnurl = 'lnurl1' + 'q'.repeat(60);
    const i = parseCommand(lnurl, idle().flow);
    assert.equal(i.kind, 'ln_address');
    if (i.kind === 'ln_address') assert.equal(i.value, lnurl);
});

test('parser: invalid Lightning address (no TLD) falls through to unknown', () => {
    assert.equal(parseCommand('alice@host', idle().flow).kind, 'unknown');
});

// ----- Phase 3: ln_address routing in the FSM ------------------------

test('fsm: ln_address in awaiting_refund_address uses ctx.orderId', () => {
    const s = inFlow('awaiting_refund_address', { orderId: '1042' });
    const r = transition(s, { kind: 'ln_address', value: 'alice@walletofsatoshi.com' });
    assert.equal(r.session.flow.type, 'awaiting_refund_address');
    assert.equal((r.session.flow.ctx as { orderId?: string }).orderId, '1042');
    assert.equal(r.actions[0]!.kind, 'submit_refund_address');
    if (r.actions[0]!.kind === 'submit_refund_address') {
        assert.equal(r.actions[0]!.orderId, '1042');
        assert.equal(r.actions[0]!.address, 'alice@walletofsatoshi.com');
    }
});

test('fsm: ln_address outside that flow uses the most recent refundPendingOrderIds entry', () => {
    const s: CustomerSession = {
        ...inFlow('idle'),
        refundPendingOrderIds: ['1015', '1042'],   // 1042 is newer / more urgent
    };
    const r = transition(s, { kind: 'ln_address', value: 'alice@walletofsatoshi.com' });
    assert.equal(r.actions[0]!.kind, 'submit_refund_address');
    if (r.actions[0]!.kind === 'submit_refund_address') {
        assert.equal(r.actions[0]!.orderId, '1042');
    }
    // Flow flips into awaiting_refund_address so a follow-up "+1042 ok"
    // type message is parsed against the right context.
    assert.equal(r.session.flow.type, 'awaiting_refund_address');
});

test('fsm: ln_address with no refund_pending order at all rejects with a clear nudge', () => {
    const r = transition(idle(), { kind: 'ln_address', value: 'alice@walletofsatoshi.com' });
    assert.equal(r.actions[0]!.kind, 'send_text');
    if (r.actions[0]!.kind === 'send_text') {
        assert.match(r.actions[0]!.text, /not expecting a Lightning address/i);
    }
});

test('fsm: unknown input in awaiting_refund_address re-prompts with the expected formats', () => {
    const s = inFlow('awaiting_refund_address', { orderId: '1042' });
    const r = transition(s, { kind: 'unknown', raw: 'something else' });
    assert.equal(r.actions[0]!.kind, 'send_text');
    if (r.actions[0]!.kind === 'send_text') {
        assert.match(r.actions[0]!.text, /Lightning address or LNURL/);
    }
});

// ------------------------------------------------------------------
// transition - universal commands
// ------------------------------------------------------------------

test('fsm: /help leaves the session untouched and emits send_help', () => {
    const s = inFlow('entering_phone', { sku: 'airtel-in-5' });
    const r = transition(s, { kind: 'help' });
    assert.deepEqual(r.session.flow, s.flow);
    assert.equal(r.actions[0]!.kind, 'send_help');
});

test('fsm: /clear empties the cart and returns to idle', () => {
    const s: CustomerSession = {
        ...inFlow('selecting_carrier'),
        cart: [{ sku: 'airtel-in-5', amount: 5, phone: '+918123456789' }],
    };
    const r = transition(s, { kind: 'clear' });
    assert.equal(r.session.cart.length, 0);
    assert.equal(r.session.flow.type, 'idle');
});

test('fsm: /cancel returns to idle from any flow', () => {
    for (const type of ['selecting_carrier', 'entering_phone', 'confirming_amount', 'awaiting_payment'] as const) {
        const s = inFlow(type);
        const r = transition(s, { kind: 'cancel' });
        assert.equal(r.session.flow.type, 'idle', `cancel should idle from ${type}`);
    }
});

// ------------------------------------------------------------------
// happy path
// ------------------------------------------------------------------

test('fsm: /menu transitions idle -> selecting_carrier and emits send_menu', () => {
    const s = idle();
    const r = transition(s, { kind: 'menu' });
    assert.equal(r.session.flow.type, 'selecting_carrier');
    assert.equal(r.actions[0]!.kind, 'send_menu');
});

test('fsm: full happy path /menu -> /buy -> pick_amount -> phone -> /confirm -> send_invoice', () => {
    let s = idle();

    s = transition(s, { kind: 'menu' }).session;
    assert.equal(s.flow.type, 'selecting_carrier');

    // /buy now lands in selecting_amount and emits send_amounts so the
    // customer can pick from the numbered list instead of being railroaded
    // into the smallest denomination.
    const afterBuy = transition(s, { kind: 'buy', sku: 'airtel-in-5' });
    s = afterBuy.session;
    assert.equal(s.flow.type, 'selecting_amount');
    assert.equal((s.flow.ctx as { sku?: string }).sku, 'airtel-in-5');
    assert.equal(afterBuy.actions[0]!.kind, 'send_amounts');

    s = transition(s, { kind: 'pick_amount', index: 2 }).session;
    assert.equal(s.flow.type, 'entering_phone');
    assert.equal((s.flow.ctx as { amountIndex?: number }).amountIndex, 2);

    const afterPhone = transition(s, { kind: 'phone', value: '+918123456789' });
    s = afterPhone.session;
    assert.equal(s.flow.type, 'confirming_amount');
    assert.equal((s.flow.ctx as { phone?: string }).phone, '+918123456789');
    assert.equal(afterPhone.actions[0]!.kind, 'send_confirm_prompt');

    const final = transition(s, { kind: 'confirm' });
    assert.equal(final.session.flow.type, 'awaiting_payment');
    assert.equal(final.actions[0]!.kind, 'send_invoice');
    if (final.actions[0]!.kind === 'send_invoice') {
        assert.equal(final.actions[0]!.sku,         'airtel-in-5');
        assert.equal(final.actions[0]!.amountIndex, 2);
        assert.equal(final.actions[0]!.phone,       '+918123456789');
    }
});

test('parser: in selecting_amount, a bare integer parses as pick_amount', () => {
    const flow = inFlow('selecting_amount', { sku: 'airtel-in-5' }).flow;
    const i    = parseCommand('2', flow);
    assert.equal(i.kind, 'pick_amount');
    if (i.kind === 'pick_amount') assert.equal(i.index, 2);
});

test('parser: in selecting_amount, non-numeric input is unknown (gets a re-prompt)', () => {
    const flow = inFlow('selecting_amount', { sku: 'airtel-in-5' }).flow;
    assert.equal(parseCommand('five', flow).kind, 'unknown');
});

test('fsm: pick_amount outside selecting_amount is ignored gracefully', () => {
    const s = inFlow('idle');
    const r = transition(s, { kind: 'pick_amount', index: 1 });
    assert.equal(r.session.flow.type, 'idle');
    assert.equal(r.actions[0]!.kind, 'send_text');
});

test('parser: /menu without arg has no country (drill-down view)', () => {
    const i = parseCommand('/menu', idle().flow);
    assert.equal(i.kind, 'menu');
    if (i.kind === 'menu') assert.equal(i.country, undefined);
});

test('parser: /menu RO carries the uppercased country code', () => {
    const i = parseCommand('/menu ro', idle().flow);
    assert.equal(i.kind, 'menu');
    if (i.kind === 'menu') assert.equal(i.country, 'RO');
});

test('parser: /menu with a non-ISO-2 arg falls back to the index (no country)', () => {
    const i = parseCommand('/menu romania', idle().flow);
    assert.equal(i.kind, 'menu');
    if (i.kind === 'menu') assert.equal(i.country, undefined);
});

test('parser: bare /status now parses as status with no orderId (was unknown, broke awaiting_payment)', () => {
    const i = parseCommand('/status', idle().flow);
    assert.equal(i.kind, 'status');
    if (i.kind === 'status') assert.equal(i.orderId, undefined);
});

test('fsm: /menu RO carries the country through to send_menu', () => {
    const r = transition(idle(), { kind: 'menu', country: 'RO' });
    assert.equal(r.actions[0]!.kind, 'send_menu');
    if (r.actions[0]!.kind === 'send_menu') assert.equal(r.actions[0]!.country, 'RO');
});

test('fsm: bare /status emits send_pending_orders instead of dead-ending in WAITING_PAY', () => {
    // Regression for the "la /status -> I am waiting for your Lightning payment" bug.
    // Customer in awaiting_payment used to get the WAITING_PAY nudge because the
    // parser fell through to `unknown`. Now bare /status routes to a real action.
    const s = inFlow('awaiting_payment', { sku: 'x', amountIndex: 1, phone: '+1' });
    const r = transition(s, { kind: 'status' });
    assert.equal(r.actions[0]!.kind, 'send_pending_orders');
});

test('fsm: /status <id> still routes to send_status with the explicit id', () => {
    const r = transition(idle(), { kind: 'status', orderId: 'ord-42' });
    assert.equal(r.actions[0]!.kind, 'send_status');
    if (r.actions[0]!.kind === 'send_status') assert.equal(r.actions[0]!.orderId, 'ord-42');
});

test('fsm: unknown input in selecting_amount nudges to pick a number', () => {
    const s = inFlow('selecting_amount', { sku: 'x' });
    const r = transition(s, { kind: 'unknown', raw: 'huh?' });
    assert.equal(r.session.flow.type, 'selecting_amount');
    if (r.actions[0]!.kind === 'send_text') {
        assert.match(r.actions[0]!.text, /number/i);
    }
});

// ------------------------------------------------------------------
// guards
// ------------------------------------------------------------------

test('fsm: /buy without sku argument prompts for one without changing state', () => {
    const s = idle();
    const r = transition(s, { kind: 'buy', sku: '' });
    assert.equal(r.session.flow.type, 'idle');
    if (r.actions[0]!.kind === 'send_text') {
        assert.match(r.actions[0]!.text, /SKU/);
    }
});

test('fsm: phone supplied outside entering_phone is ignored gracefully', () => {
    const s = inFlow('selecting_carrier');
    const r = transition(s, { kind: 'phone', value: '+1' });
    assert.equal(r.session.flow.type, 'selecting_carrier');
    assert.equal(r.actions[0]!.kind, 'send_text');
});

test('fsm: /confirm outside confirming_amount is ignored gracefully', () => {
    const s = inFlow('entering_phone', { sku: 'x' });
    const r = transition(s, { kind: 'confirm' });
    assert.equal(r.session.flow.type, 'entering_phone');
});

test('fsm: unknown input during awaiting_payment nudges, does not reset flow', () => {
    const s = inFlow('awaiting_payment', { sku: 'x', phone: '+1' });
    const r = transition(s, { kind: 'unknown', raw: 'huh?' });
    assert.equal(r.session.flow.type, 'awaiting_payment',
        'should NOT reset to idle - the customer still has a pending invoice');
    if (r.actions[0]!.kind === 'send_text') {
        assert.match(r.actions[0]!.text, /waiting/i);
    }
});

test('fsm: greeting words from idle re-show the welcome message', () => {
    const r = transition(idle(), { kind: 'unknown', raw: 'gm' });
    if (r.actions[0]!.kind === 'send_text') {
        assert.match(r.actions[0]!.text, /btcrecharge/);
    }
});

test('fsm: /status routes through send_status without touching the flow', () => {
    const s = inFlow('selecting_carrier');
    const r = transition(s, { kind: 'status', orderId: 'ord-42' });
    assert.equal(r.session.flow.type, 'selecting_carrier');
    if (r.actions[0]!.kind === 'send_status') {
        assert.equal(r.actions[0]!.orderId, 'ord-42');
    }
});
