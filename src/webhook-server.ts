/**
 * HTTP webhook receiver. btcrecharge POSTs every order state change here
 * (it learns the URL via the `callback_url` we send when creating the
 * invoice). We verify the same HMAC scheme used outbound, look up the
 * customer pubkey from the Redis reverse index, render a state-specific
 * notification, and DM it.
 *
 * Also serves `/health` for Railway probes.
 *
 * Built on Node's stdlib `http` to avoid an Express dependency for one
 * route - the body is tiny, no streaming, no middleware needs.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { z } from 'zod';

import type { CatalogClient } from './catalog.js';
import { buildOutboundDm } from './crypto.js';
import type { RelayPool } from './relay-pool.js';
import type { SessionStore } from './session.js';

export const CALLBACK_TIMESTAMP_WINDOW_SEC = 300;

export const WebhookPayloadSchema = z.object({
    internal_order_id: z.number().int().positive(),
    state:             z.string().min(1),
    nostr_order_id:    z.string().min(1).optional(),
    sats:              z.number().int().positive().optional(),
    voucher_pin:       z.string().optional(),
    error:             z.string().optional(),
    // Phase 3: cron reminder + completed refund details.
    reminder_attempt:  z.number().int().min(1).max(10).optional(),
    refund_tx:         z.string().optional(),
});

export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

export interface WebhookServerDeps {
    nostrProxySecret: string;
    sessionStore:     SessionStore;
    catalog:          CatalogClient;
    relayPool:        RelayPool;
    botSecret:        Uint8Array;
    /** NIP-65/NIP-17 inbox resolver; when absent DMs go pool-only. */
    recipientRelays?: { resolve(pubkey: string): Promise<string[]> };
    logger:           Logger;
}

/** Map order state -> what the customer should hear, or `null` for silent. */
export function renderStateNotification(payload: WebhookPayload): string | null {
    switch (payload.state) {
        case 'customer_paid':
            return 'Payment received. Dispatching your top-up...';
        case 'paying_bitrefill':
            return null; // intermediate, no need to spam
        case 'delivered':
            return [
                'Done! Your top-up was delivered.',
                payload.voucher_pin ? '' : '',
                payload.voucher_pin ? `Voucher: ${payload.voucher_pin}` : '',
            ].filter(Boolean).join('\n');
        case 'payout_failed':
            return 'Hiccup while delivering. I am retrying automatically.';
        case 'refund_pending':
            return [
                `The order ${payload.internal_order_id} failed.`,
                '',
                'Reply with one of:',
                '  - a Lightning address (e.g. alice@walletofsatoshi.com)',
                '  - an LNURL-pay        (e.g. lnurl1...)',
                payload.sats ? `and I will refund ${payload.sats} sats.` : 'and I will issue your refund.',
            ].filter(Boolean).join('\n');
        case 'refund_reminder': {
            const attempt = payload.reminder_attempt ?? 1;
            if (attempt >= 3) {
                return [
                    `Still waiting on a Lightning address for the refund on order ${payload.internal_order_id}.`,
                    'I will hold this refund for an operator to handle. Reply any time with an address and I will retry automatically.',
                ].join('\n');
            }
            return `Reminder: I still need a Lightning address for the refund on order ${payload.internal_order_id}. Reply with an address or LNURL when ready.`;
        }
        case 'refunded':
            return payload.refund_tx
                ? `Refund sent. tx: ${payload.refund_tx}. Thanks for being patient.`
                : 'Your refund has been sent. Thanks for being patient.';
        case 'expired':
            return 'The Lightning invoice expired before payment. /menu to start over.';
        case 'invalid':
            return payload.error
                ? `The order was rejected: ${payload.error}.`
                : 'The order was rejected. /menu to start over.';
        default:
            return null;
    }
}

export function createWebhookServer(deps: WebhookServerDeps, port: number): Server {
    const log = deps.logger.child({ component: 'webhook-server' });

    const server = createServer((req, res) => {
        handleRequest(req, res, deps, log).catch((err) => {
            log.error({ err: String(err) }, 'unhandled error in webhook handler');
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end('{"error":"internal"}');
            }
        });
    });

    server.listen(port, () => {
        log.info({ port }, 'webhook server listening');
    });
    return server;
}

async function handleRequest(
    req:   IncomingMessage,
    res:   ServerResponse,
    deps:  WebhookServerDeps,
    log:   Logger,
): Promise<void> {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
    }

    if (req.method !== 'POST' || req.url !== '/webhook/order') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"not_found"}');
        return;
    }

    const body = await readBody(req);
    if (!verifySignature(req, body, deps.nostrProxySecret)) {
        log.warn({ ip: req.socket.remoteAddress }, 'webhook signature rejected');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"bad_signature"}');
        return;
    }

    let payload: WebhookPayload;
    try {
        payload = WebhookPayloadSchema.parse(JSON.parse(body));
    } catch (err) {
        log.warn({ err: String(err) }, 'webhook payload invalid');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"bad_payload"}');
        return;
    }

    const pubkey = await deps.sessionStore.lookupPubkey(String(payload.internal_order_id));
    if (!pubkey) {
        // The customer's reverse-index entry has expired, the order is for
        // a different bot, or we have lost state. Acknowledge so btcrecharge
        // does not retry forever; log so an operator can chase.
        log.warn({ orderId: payload.internal_order_id, state: payload.state }, 'no pubkey for order id');
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end('{"ok":true,"note":"no_subscriber"}');
        return;
    }

    // Phase 3: refund flow needs us to mutate the session so the next
    // DM from the customer is parsed against the right flow state. We
    // do this BEFORE the DM publish so a race where the customer
    // replies instantly still finds the right flow on read.
    const orderIdStr = String(payload.internal_order_id);
    if (payload.state === 'refund_pending') {
        await deps.sessionStore.mutate(pubkey, (s) => ({
            ...s,
            flow: { type: 'awaiting_refund_address', ctx: { orderId: orderIdStr } },
            refundPendingOrderIds: s.refundPendingOrderIds.includes(orderIdStr)
                ? s.refundPendingOrderIds
                : [...s.refundPendingOrderIds, orderIdStr],
        }));
    } else if (payload.state === 'refunded') {
        await deps.sessionStore.mutate(pubkey, (s) => ({
            ...s,
            // Move the order out of the refund-pending list; if the
            // customer was still in awaiting_refund_address for this
            // order, also bounce them to idle so a stray "+" reaction
            // doesn't re-trigger anything.
            flow: (s.flow.type === 'awaiting_refund_address'
                   && (s.flow.ctx as { orderId?: string }).orderId === orderIdStr)
                ? { type: 'idle', ctx: {} }
                : s.flow,
            refundPendingOrderIds: s.refundPendingOrderIds.filter(id => id !== orderIdStr),
        }));
    }

    const text = renderStateNotification(payload);
    if (text !== null) {
        const recipientRelayUrls = deps.recipientRelays
            ? await deps.recipientRelays.resolve(pubkey)
            : [];
        const session = await deps.sessionStore.get(pubkey);
        const events  = buildOutboundDm(deps.botSecret, pubkey, text, session?.protocol ?? null);
        await Promise.allSettled(events.map(e => deps.relayPool.publish(e, recipientRelayUrls)));
        log.info({
            orderId:         payload.internal_order_id,
            state:           payload.state,
            pubkey:          pubkey.slice(0, 8),
            kinds:           events.map(e => e.kind),
            recipientRelays: recipientRelayUrls.length,
        }, 'state DM dispatched');
    }

    // Cleanup terminal states so the reverse index does not grow forever.
    if (TERMINAL_STATES.has(payload.state)) {
        await deps.sessionStore.unlinkOrder(String(payload.internal_order_id));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
}

const TERMINAL_STATES = new Set(['delivered', 'refunded', 'expired', 'invalid']);

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

export function verifySignature(req: IncomingMessage, body: string, secret: string): boolean {
    const ts  = String(req.headers['x-timestamp'] ?? '');
    const sig = String(req.headers['x-signature'] ?? '');
    if (!/^\d+$/.test(ts) || sig.length !== 64) return false;
    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
    if (age > CALLBACK_TIMESTAMP_WINDOW_SEC) return false;

    const expected = createHmac('sha256', secret).update(ts + '\n' + body).digest('hex');
    try {
        return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
    } catch {
        return false;
    }
}
