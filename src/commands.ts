/**
 * Command parser and conversation FSM.
 *
 * The parser turns inbound DM text into an `Intent` - a tagged union that
 * names what the customer asked for, without knowing anything about how
 * the bot will respond. Slash commands (`/menu`, `/buy ...`) are matched
 * first; whatever is left over is interpreted against the current flow
 * state (mid-`entering_phone` lets the customer just type the number
 * without a prefix).
 *
 * The FSM (`transition`) is a pure function: given a session and an
 * intent, it returns the next session plus the side effects the caller
 * should emit. Side effects are symbolic (`{ kind: 'send_menu' }`)
 * because the actual catalog data, invoice strings, and order statuses
 * land in Phase 2 - this module ships the conversation grammar with no
 * external dependencies and is fully unit-testable.
 */
import type { CustomerSession, Flow } from './session.js';

// ----- Intent (parser output) ---------------------------------------

export type Intent =
    | { kind: 'start' }
    | { kind: 'help' }
    | { kind: 'menu' }
    | { kind: 'cart' }
    | { kind: 'clear' }
    | { kind: 'cancel' }
    | { kind: 'buy';        sku: string }
    | { kind: 'pick_amount'; index: number }
    | { kind: 'status';     orderId: string }
    | { kind: 'phone';      value: string }
    | { kind: 'confirm' }
    | { kind: 'unknown';    raw: string };

const SLASH_COMMANDS = new Set([
    'start', 'help', 'menu', 'cart', 'clear', 'cancel',
    'buy',   'status', 'yes', 'no', 'confirm',
]);

const PHONE_RE = /^\+?[0-9][0-9\s\-()]{3,20}$/;

/**
 * Parse a single DM into an Intent. The current flow state is used only
 * for the "no slash command, just bare text" path - in `entering_phone`
 * a bare `+918123456789` is treated as a phone supply rather than as
 * an unknown command.
 */
export function parseCommand(text: string, flow: Flow): Intent {
    const trimmed = text.trim();
    if (trimmed === '') return { kind: 'unknown', raw: text };

    // Slash command: `/cmd [args]` or bare `cmd [args]` for the common
    // keywords (start, menu, help). Customers often forget the slash.
    const slashMatch = /^\/?([a-z]+)\b\s*(.*)$/i.exec(trimmed);
    if (slashMatch) {
        const cmd  = slashMatch[1]!.toLowerCase();
        const rest = slashMatch[2]!.trim();
        if (SLASH_COMMANDS.has(cmd)) {
            switch (cmd) {
                case 'start':   return { kind: 'start' };
                case 'help':    return { kind: 'help' };
                case 'menu':    return { kind: 'menu' };
                case 'cart':    return { kind: 'cart' };
                case 'clear':   return { kind: 'clear' };
                case 'cancel':  return { kind: 'cancel' };
                case 'yes':     // fallthrough
                case 'confirm': return { kind: 'confirm' };
                case 'no':      return { kind: 'cancel' };
                case 'buy':
                    if (!rest) return { kind: 'unknown', raw: trimmed };
                    return { kind: 'buy', sku: rest.toLowerCase() };
                case 'status':
                    if (!rest) return { kind: 'unknown', raw: trimmed };
                    return { kind: 'status', orderId: rest };
            }
        }
    }

    // No slash command. Interpret against current flow.
    if (flow.type === 'selecting_amount' && /^\d{1,3}$/.test(trimmed)) {
        const index = parseInt(trimmed, 10);
        if (index >= 1) return { kind: 'pick_amount', index };
    }
    if (flow.type === 'entering_phone' && PHONE_RE.test(trimmed)) {
        return { kind: 'phone', value: normalizePhone(trimmed) };
    }
    if (flow.type === 'confirming_amount') {
        const lower = trimmed.toLowerCase();
        if (lower === 'yes' || lower === 'y' || lower === 'ok') return { kind: 'confirm' };
        if (lower === 'no'  || lower === 'n')                   return { kind: 'cancel' };
    }
    return { kind: 'unknown', raw: trimmed };
}

function normalizePhone(raw: string): string {
    const digits = raw.replace(/[\s\-()]/g, '');
    return digits.startsWith('+') ? digits : '+' + digits;
}

// ----- FSM (transition output) --------------------------------------

export type Action =
    | { kind: 'send_text';           text: string }
    | { kind: 'send_help' }
    | { kind: 'send_menu' }
    | { kind: 'send_cart' }
    | { kind: 'send_amounts';        sku: string }
    | { kind: 'send_confirm_prompt'; sku: string; amountIndex: number; phone: string }
    | { kind: 'send_invoice';        sku: string; amountIndex: number; phone: string }
    | { kind: 'send_status';         orderId: string };

export interface TransitionResult {
    session: CustomerSession;
    actions: Action[];
}

const HELP_TEXT_FOR_INVALID_BUY = 'I need a SKU. Try /menu to see the catalog, then /buy <sku>.';
const HELP_TEXT_FOR_INVALID_STATUS = 'Tell me which order. Try /status <order-id>.';
const PROMPT_PHONE   = 'Got it. Reply with the recipient phone number including country code, e.g. +918123456789';
const PROMPT_PICK_AGAIN = 'Reply with one of the numbers shown above, e.g. "1".';
const WAITING_PAY    = 'I am waiting for your Lightning payment. Reply /cancel to abort.';
const CANCELLED      = 'Cancelled. Reply /menu to start over.';
const CART_CLEARED   = 'Cart cleared. Reply /menu to start over.';
const UNKNOWN        = 'Sorry, I did not catch that. Reply /help for the command list.';

/**
 * Apply an intent to the current session and return the next session
 * plus the side effects to emit. Pure - no I/O, no clocks, no globals,
 * trivially unit-testable.
 *
 * Caller is expected to wrap this in `sessionStore.mutate(pubkey, ...)`
 * so concurrent DMs from the same customer serialize on the Redis
 * optimistic lock.
 */
export function transition(session: CustomerSession, intent: Intent): TransitionResult {
    // Universal commands that work in every flow state.
    switch (intent.kind) {
        case 'start':
            return { session: idle(session), actions: [{ kind: 'send_text', text: greeting() }] };
        case 'help':
            return { session, actions: [{ kind: 'send_help' }] };
        case 'cart':
            return { session, actions: [{ kind: 'send_cart' }] };
        case 'clear':
            return {
                session: { ...idle(session), cart: [] },
                actions: [{ kind: 'send_text', text: CART_CLEARED }],
            };
        case 'cancel':
            return { session: idle(session), actions: [{ kind: 'send_text', text: CANCELLED }] };
        case 'status':
            return { session, actions: [{ kind: 'send_status', orderId: intent.orderId }] };
    }

    // Flow-aware paths.
    switch (intent.kind) {
        case 'menu':
            return {
                session: { ...session, flow: { type: 'selecting_carrier', ctx: {} } },
                actions: [{ kind: 'send_menu' }],
            };

        case 'buy':
            if (!intent.sku) {
                return { session, actions: [{ kind: 'send_text', text: HELP_TEXT_FOR_INVALID_BUY } ] };
            }
            return {
                session: {
                    ...session,
                    flow: { type: 'selecting_amount', ctx: { sku: intent.sku } },
                },
                actions: [{ kind: 'send_amounts', sku: intent.sku }],
            };

        case 'pick_amount': {
            if (session.flow.type !== 'selecting_amount') {
                return { session, actions: [{ kind: 'send_text', text: UNKNOWN }] };
            }
            const sku = (session.flow.ctx as { sku?: string }).sku;
            if (!sku) {
                return { session: idle(session), actions: [{ kind: 'send_text', text: UNKNOWN }] };
            }
            return {
                session: {
                    ...session,
                    flow: { type: 'entering_phone', ctx: { sku, amountIndex: intent.index } },
                },
                actions: [{ kind: 'send_text', text: PROMPT_PHONE }],
            };
        }

        case 'phone': {
            if (session.flow.type !== 'entering_phone') {
                return { session, actions: [{ kind: 'send_text', text: UNKNOWN }] };
            }
            const { sku, amountIndex } = session.flow.ctx as { sku?: string; amountIndex?: number };
            if (!sku || !amountIndex) {
                return { session: idle(session), actions: [{ kind: 'send_text', text: UNKNOWN }] };
            }
            return {
                session: {
                    ...session,
                    flow: { type: 'confirming_amount', ctx: { sku, amountIndex, phone: intent.value } },
                },
                actions: [{ kind: 'send_confirm_prompt', sku, amountIndex, phone: intent.value }],
            };
        }

        case 'confirm': {
            if (session.flow.type !== 'confirming_amount') {
                return { session, actions: [{ kind: 'send_text', text: UNKNOWN }] };
            }
            const { sku, amountIndex, phone } = session.flow.ctx as { sku?: string; amountIndex?: number; phone?: string };
            if (!sku || !amountIndex || !phone) {
                return { session: idle(session), actions: [{ kind: 'send_text', text: UNKNOWN }] };
            }
            return {
                session: {
                    ...session,
                    flow: { type: 'awaiting_payment', ctx: { sku, amountIndex, phone } },
                },
                actions: [{ kind: 'send_invoice', sku, amountIndex, phone }],
            };
        }

        case 'unknown':
            if (session.flow.type === 'awaiting_payment') {
                return { session, actions: [{ kind: 'send_text', text: WAITING_PAY }] };
            }
            if (session.flow.type === 'selecting_amount') {
                return {
                    session,
                    actions: [{ kind: 'send_text', text: PROMPT_PICK_AGAIN }],
                };
            }
            if (session.flow.type === 'entering_phone') {
                return {
                    session,
                    actions: [{ kind: 'send_text', text: 'That does not look like a phone number. ' + PROMPT_PHONE }],
                };
            }
            if (intent.raw.toLowerCase().match(/\b(hi|hello|hey|gm|gn)\b/)) {
                return { session: idle(session), actions: [{ kind: 'send_text', text: greeting() }] };
            }
            return { session, actions: [{ kind: 'send_text', text: UNKNOWN }] };

        default: {
            const exhaustive: never = intent;
            void exhaustive;
            return { session, actions: [{ kind: 'send_text', text: UNKNOWN }] };
        }
    }
}

function idle(session: CustomerSession): CustomerSession {
    return { ...session, flow: { type: 'idle', ctx: {} } };
}

function greeting(): string {
    return [
        'Hi! btcrecharge - international mobile top-ups paid in Bitcoin.',
        '',
        '  /menu              list available top-ups',
        '  /buy <sku>         start a purchase',
        '  /cart              show current cart',
        '  /status <id>       check an order',
        '  /help              show this message',
        '',
        'Example: /buy airtel-in-5',
    ].join('\n');
}
