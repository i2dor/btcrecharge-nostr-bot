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

const HELP_TEXT = [
    'Commands:',
    '  /menu              list available top-ups',
    '  /buy <sku>         start a purchase',
    '  /cart              show current cart',
    '  /status <id>       check an order',
    '  /cancel            abort an in-flight order',
    '  /clear             empty the cart',
    '  /help              show this message',
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
                return renderMenu(items);
            } catch (err) {
                deps.logger.error({ err: String(err) }, 'catalog list failed');
                return 'Catalog is temporarily unavailable. Try again in a minute.';
            }
        }

        case 'send_cart': {
            if (session.cart.length === 0) return 'Your cart is empty. /menu to start.';
            const lines = ['Your cart:'];
            for (const it of session.cart) {
                lines.push(`  ${it.sku}  ${it.amount}  ${it.phone}`);
            }
            return lines.join('\n');
        }

        case 'send_amounts':
            return renderAmounts(action.sku, deps);

        case 'send_confirm_prompt':
            return renderConfirmPrompt(action.sku, action.amountIndex, action.phone, deps);

        case 'send_invoice':
            return createInvoice(action.sku, action.amountIndex, action.phone, session, deps);

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
        lines.push(`  ${i + 1}) ${amt} ${item.currency}`);
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
    return `Confirm: ${item.label} ${amount} ${item.currency} -> ${phone}. Reply /confirm to proceed or /cancel to abort.`;
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

    await deps.sessionStore.linkOrder(String(order.internalOrderId), session.pubkey);

    return [
        `Order: ${item.label} ${amount} ${item.currency} -> ${phone}`,
        `Amount: ${order.sats} sats`,
        '',
        order.lnInvoice,
        '',
        'Pay the Lightning invoice above. I will DM you once it is delivered.',
    ].join('\n');
}

function makeIdempotencyKey(): string {
    // The btcrecharge endpoint accepts up to 64 chars [A-Za-z0-9_.-].
    // crypto.randomUUID gives us 32 hex + 4 hyphens = 36 chars.
    // The 'nostr-' prefix keeps the source channel obvious in admin logs.
    return 'nostr-' + crypto.randomUUID();
}
