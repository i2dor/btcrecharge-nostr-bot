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

test('fsm: full happy path /menu -> /buy -> phone -> /confirm -> send_invoice', () => {
    let s = idle();

    s = transition(s, { kind: 'menu' }).session;
    assert.equal(s.flow.type, 'selecting_carrier');

    s = transition(s, { kind: 'buy', sku: 'airtel-in-5' }).session;
    assert.equal(s.flow.type, 'entering_phone');
    assert.equal((s.flow.ctx as { sku?: string }).sku, 'airtel-in-5');

    s = transition(s, { kind: 'phone', value: '+918123456789' }).session;
    assert.equal(s.flow.type, 'confirming_amount');
    assert.equal((s.flow.ctx as { phone?: string }).phone, '+918123456789');

    const final = transition(s, { kind: 'confirm' });
    assert.equal(final.session.flow.type, 'awaiting_payment');
    assert.equal(final.actions[0]!.kind, 'send_invoice');
    if (final.actions[0]!.kind === 'send_invoice') {
        assert.equal(final.actions[0]!.sku,   'airtel-in-5');
        assert.equal(final.actions[0]!.phone, '+918123456789');
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
