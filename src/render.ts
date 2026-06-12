/**
 * Action -> reply text. The FSM in `commands.ts` emits symbolic Actions
 * (`send_menu`, `send_invoice`, etc.); this module turns them into the
 * actual strings the bot sends back over Nostr DMs.
 *
 * Some actions are pure renders (send_text, send_help, send_cart) while
 * others trigger backend calls (send_invoice creates a BTCPay invoice on
 * btcrecharge; send_status queries order state). All side effects funnel
 * through the injected `deps` so the handler stays testable.
 */
import type { Logger } from 'pino';
import type { Action } from './commands.js';
import type { CustomerSession } from './session.js';
import type { CatalogClient } from './catalog.js';
import type { BtcrechargeClient } from './btcrecharge-client.js';
import { BtcrechargeApiError } from './btcrecharge-client.js';
import { renderMenu } from './catalog.js';
import type { SessionStore } from './session.js';

export interface RenderDeps {
    catalog:      CatalogClient;
    btcrecharge:  BtcrechargeClient;
    sessionStore: SessionStore;
    callbackUrl:  string;
    logger:       Logger;
}

// No column padding anywhere in DM bodies: Nostr clients render DMs in
// proportional fonts, so space alignment collapses into one mashed gap.
const HELP_TEXT = [
    'Commands:',
    '',
    '/menu - list available countries',
    '/menu <cc> - see top-ups for a country (e.g. /menu RO)',
    '/buy <sku> - start a purchase (e.g. /buy vodafone-romania-ro)',
    '/cart - show current cart',
    '/status <id> - check an order',
    '/cancel - abort an in-flight order',
    '/clear - empty the cart',
    '/help - show this message',
].join('\n');

/**
 * Apply an action and return the text to DM the customer, or `null` to
 * stay silent. The session is the LATEST snapshot (after FSM transition),
 * not the prior one - so `cart` reflects what we want to show.
 */
export async function actionToText(
    action:  Action,
    session: CustomerSession,
    deps:    RenderDeps,
): Promise<string | null> {
    switch (action.kind) {
        case 'send_text':
            return action.text;

        case 'send_help':
            return HELP_TEXT;

        case 'send_menu': {
            try {
                const items = await deps.catalog.list();
                return renderMenu(items, action.country);
            } catch (err) {
                deps.logger.error({ err: String(err) }, 'catalog list failed');
                return 'Catalog is temporarily unavailable. Try again in a minute.';
            }
        }

        case 'send_pending_orders': {
            if (session.pendingOrderIds.length === 0) {
                return 'No orders in flight. /menu to start one, or /status <id> to look up a specific order.';
            }
            const lines = ['Your pending orders:'];
            for (const id of session.pendingOrderIds) {
                lines.push(`Order ${id} - I will DM you when it changes state.`);
            }
            return lines.join('\n');
        }

        case 'send_cart': {
            if (session.cart.length === 0) return 'Your cart is empty. /menu to start.';
            const lines = ['Your cart:'];
            for (const it of session.cart) {
                lines.push(`${it.sku} - ${it.amount} -> ${it.phone}`);
            }
            return lines.join('\n');
        }

        case 'send_amounts':
            return renderAmounts(action.sku, deps);

        case 'send_confirm_prompt':
            return renderConfirmPrompt(action.sku, action.amountIndex, action.phone, deps);

        case 'send_invoice':
            return createInvoice(action.sku, action.amountIndex, action.phone, session, deps);

        case 'submit_refund_address':
            return submitRefundAddress(action.orderId, action.address, deps);

        case 'send_status':
            // Real status lookup lands later; for now acknowledge the request
            // so the customer is not left in silence. The webhook callback is
            // the authoritative state channel.
            return `Order ${action.orderId}: I will DM you when state changes.`;

        default: {
            const exhaustive: never = action;
            void exhaustive;
            return null;
        }
    }
}

/** Fetch a catalog item, mapping throws + null + empty-amounts into a single user-visible message. */
async function loadItem(
    sku:  string,
    deps: RenderDeps,
    op:   string,
): Promise<{ ok: true; item: import('./catalog.js').CatalogItem } | { ok: false; message: string }> {
    try {
        const item = await deps.catalog.getBySku(sku);
        if (!item) {
            return { ok: false, message: `Unknown SKU "${sku}". Try /menu to see what is available.` };
        }
        if (!item.amounts.length) {
            return { ok: false, message: `${item.label} has no available amounts right now.` };
        }
        return { ok: true, item };
    } catch (err) {
        deps.logger.error({ err: String(err), sku, op }, 'catalog lookup failed');
        return { ok: false, message: 'Catalog is temporarily unavailable. Try again in a minute.' };
    }
}

/** Number the amounts so the customer can `pick by index` (e.g. "2"). */
async function renderAmounts(sku: string, deps: RenderDeps): Promise<string> {
    const res = await loadItem(sku, deps, 'send_amounts');
    if (!res.ok) return res.message;
    const { item } = res;
    const lines = [`${item.label} - choose an amount:`, ''];
    item.amounts.forEach((amt, i) => {
        lines.push(`${i + 1}) ${amt} ${item.currency}`);
    });
    lines.push('');
    lines.push('Reply with the number, e.g. "1".');
    return lines.join('\n');
}

async function renderConfirmPrompt(
    sku:         string,
    amountIndex: number,
    phone:       string,
    deps:        RenderDeps,
): Promise<string> {
    const res = await loadItem(sku, deps, 'send_confirm_prompt');
    if (!res.ok) return res.message;
    const { item } = res;
    const amount = item.amounts[amountIndex - 1];
    if (!amount) {
        return `That choice is outside the list (1 to ${item.amounts.length}). Reply /cancel and try /buy again.`;
    }
    return [
        'Confirm purchase:',
        `${item.label} - ${amount} ${item.currency} -> ${phone}`,
        '',
        'Reply /confirm to proceed, /cancel to abort.',
    ].join('\n');
}

async function createInvoice(
    sku:         string,
    amountIndex: number,
    phone:       string,
    session:     CustomerSession,
    deps:        RenderDeps,
): Promise<string> {
    const loaded = await loadItem(sku, deps, 'send_invoice');
    if (!loaded.ok) return loaded.message;
    const { item } = loaded;
    const amount = item.amounts[amountIndex - 1];
    if (!amount) {
        return `That choice is outside the list (1 to ${item.amounts.length}). Reply /cancel and try /buy again.`;
    }

    const nostrOrderId = makeIdempotencyKey();
    let order;
    try {
        order = await deps.btcrecharge.createLightningOrder({
            nostrOrderId,
            operatorSlug:   item.operatorId,
            msisdn:         phone,
            topupValue:     amount,
            callbackUrl:    deps.callbackUrl,
            customerPubkey: session.pubkey,
        });
    } catch (err) {
        if (err instanceof BtcrechargeApiError && err.code === 'out_of_stock') {
            return `${item.label} just went out of stock. Try /menu.`;
        }
        deps.logger.error({ err: String(err) }, 'invoice creation failed');
        return 'Sorry, I could not create your invoice right now. Try again in a moment.';
    }

    const orderIdStr = String(order.internalOrderId);
    await deps.sessionStore.linkOrder(orderIdStr, session.pubkey);
    // Also append to pendingOrderIds so a bare /status can summarise it.
    // Best-effort: a failed mutate (race with another DM) is tolerable - the
    // reverse index above is the authoritative customer<->order link.
    try {
        await deps.sessionStore.mutate(session.pubkey, (s) => ({
            ...s,
            pendingOrderIds: s.pendingOrderIds.includes(orderIdStr)
                ? s.pendingOrderIds
                : [...s.pendingOrderIds, orderIdStr],
        }));
    } catch (err) {
        deps.logger.warn({ err: String(err), orderId: orderIdStr }, 'pendingOrderIds mutate failed (non-fatal)');
    }

    return [
        `Order ${orderIdStr}: ${item.label} ${amount} ${item.currency} -> ${phone}`,
        `Amount: ${order.sats} sats`,
        '',
        order.lnInvoice,
        '',
        `Pay the Lightning invoice above. I will DM you once it is delivered. /status ${orderIdStr} to check.`,
    ].join('\n');
}

function makeIdempotencyKey(): string {
    // The btcrecharge endpoint accepts up to 64 chars [A-Za-z0-9_.-].
    // crypto.randomUUID gives us 32 hex + 4 hyphens = 36 chars.
    // The 'nostr-' prefix keeps the source channel obvious in admin logs.
    return 'nostr-' + crypto.randomUUID();
}

/**
 * Send a Lightning address to btcrecharge for a refund_pending order.
 *
 * Failure-mode mapping:
 *   - `unreachable_address` (probe failed)        -> ask for another address
 *   - `bad_address`         (regex / decode fail) -> same
 *   - `order_not_refundable` (state moved on)    -> tell the customer
 *   - `not_refund_pending`   (timing race)        -> same as above
 *   - other 4xx                                  -> generic retry-with-different
 *   - 5xx / network                               -> ask to retry shortly
 *
 * Stays in the FSM's awaiting_refund_address regardless of outcome here;
 * the backend confirms the refund out-of-band via the `refunded`
 * webhook, at which point we DM "Refund sent."
 */
async function submitRefundAddress(
    orderId: string,
    address: string,
    deps:    RenderDeps,
): Promise<string> {
    const numericOrderId = parseInt(orderId, 10);
    if (!Number.isFinite(numericOrderId) || numericOrderId <= 0) {
        deps.logger.error({ orderId }, 'refund address forwarded with non-numeric orderId');
        return 'Something is off with that order id. Please contact support.';
    }
    try {
        await deps.btcrecharge.submitRefundAddress({
            internalOrderId: numericOrderId,
            address,
        });
        return `Thanks. I am verifying ${address} now and will DM you once the refund is on the way.`;
    } catch (err) {
        if (err instanceof BtcrechargeApiError) {
            switch (err.code) {
                case 'unreachable_address':
                case 'bad_address':
                    return 'That Lightning address does not seem reachable. Please reply with a different one (e.g. alice@walletofsatoshi.com or lnurl1...).';
                case 'order_not_refundable':
                case 'not_refund_pending':
                    return 'That order is no longer in refund_pending state. /status to see your orders, or wait for the next DM from me.';
            }
            // Other 4xx: surface the detail if it is short and safe.
            if (err.status >= 400 && err.status < 500) {
                return 'I could not accept that address. Please try a different Lightning address or LNURL.';
            }
        }
        deps.logger.error({ err: String(err), orderId }, 'refund address submit failed');
        return 'Could not reach the refund service right now. Please reply with the same address in a minute and I will try again.';
    }
}
