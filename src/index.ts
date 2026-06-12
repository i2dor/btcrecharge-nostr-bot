/**
 * Bot entrypoint. Wires Phase 1 (foundation) + Phase 2.1-2.3 (catalog,
 * btcrecharge client, webhook receiver) into the live loop:
 *
 *   - boot identity + config + logger
 *   - connect Redis (ioredis)
 *   - build SessionStore + CatalogClient + BtcrechargeClient
 *   - build RelayPool, subscribe to NIP-04 (kind=4) and NIP-17 (kind=1059)
 *     events tagging the bot pubkey
 *   - on each event, hand to `handleIncomingDm`
 *   - in parallel, run an HTTP server for /webhook/order + /health
 *   - shutdown on SIGINT/SIGTERM with a best-effort drain
 */
import Redis from 'ioredis';

import { BtcrechargeClient } from './btcrecharge-client.js';
import { resolveCallbackUrl } from './callback-url.js';
import { CatalogClient } from './catalog.js';
import { getConfig } from './config.js';
import { buildInboundFilters, handleIncomingDm } from './handler.js';
import { getIdentity } from './identity.js';
import { getLogger } from './logger.js';
import { RecipientRelays } from './nip65.js';
import { RelayPool } from './relay-pool.js';
import { SessionStore } from './session.js';
import { createWebhookServer } from './webhook-server.js';

async function main(): Promise<void> {
    const cfg = getConfig();
    const id  = getIdentity();
    const log = getLogger();

    log.info({
        npub:     id.npub,
        pubkey:   id.pubkey.slice(0, 16) + '...',
        env:      cfg.appEnv,
        relays:   cfg.nostrRelays.length,
        backend:  cfg.btcrechargeBaseUrl,
        redisUrl: maskRedisUrl(cfg.redisUrl),
    }, 'bot booting');

    const redis = new Redis(cfg.redisUrl, {
        // ioredis defaults retry forever on disconnect; keep that, just
        // suppress the noisy console warnings that fight pino formatting.
        lazyConnect: false,
        maxRetriesPerRequest: null,
    });
    redis.on('error', (err: Error) => log.warn({ err: err.message }, 'redis error'));
    redis.on('connect', () => log.info('redis connected'));

    const sessionStore = new SessionStore(redis, log);
    const catalog      = new CatalogClient({
        baseUrl:    cfg.btcrechargeBaseUrl,
        directOnly: cfg.directTopupOnly,
    }, redis, log);
    const btcrecharge  = new BtcrechargeClient({
        baseUrl:          cfg.btcrechargeBaseUrl,
        nostrProxySecret: cfg.nostrProxySecret,
    }, log);

    const relayPool       = new RelayPool({ relays: cfg.nostrRelays }, log);
    const recipientRelays = new RecipientRelays(relayPool, log);

    const callbackUrl = resolveCallbackUrl({
        botPublicUrl:        cfg.botPublicUrl,
        railwayPublicDomain: process.env['RAILWAY_PUBLIC_DOMAIN'],
        port:                cfg.port,
    });
    log.info({ callbackUrl }, 'callback URL resolved');
    // Loud warning so the operator notices in Railway logs if the bot is
    // about to give btcrecharge a useless localhost URL.
    if (callbackUrl.startsWith('http://localhost')) {
        log.warn(
            'callback URL is localhost - btcrecharge will not be able to ' +
            'deliver order callbacks. Set BOT_PUBLIC_URL or generate a ' +
            'Railway public domain so RAILWAY_PUBLIC_DOMAIN is populated.',
        );
    }

    // Inbound subscriptions: kind 4 (NIP-04) + kind 1059 (NIP-17 gift
    // wrap) addressed to the bot pubkey, with per-kind `since` windows
    // (NIP-59 backdates gift-wrap timestamps up to 2 days). The handler's
    // freshness gate on the decrypted send time drops replayed history;
    // the relay pool dedupes via seen-event-id LRU.
    for (const filter of buildInboundFilters(id.pubkey, Math.floor(Date.now() / 1000))) {
        relayPool.subscribe(filter, (event) => {
            void handleIncomingDm(event, {
                botSecret:    id.secret,
                sessionStore,
                catalog,
                btcrecharge,
                relayPool,
                callbackUrl,
                minPowBits:   0, // disabled by default for MVP
                recipientRelays,
                logger:       log,
            });
        });
    }

    const server = createWebhookServer({
        nostrProxySecret: cfg.nostrProxySecret,
        sessionStore,
        catalog,
        relayPool,
        botSecret:        id.secret,
        recipientRelays,
        logger:           log,
    }, cfg.port);

    log.info('bot online');

    const shutdown = async (signal: string): Promise<void> => {
        log.info({ signal }, 'shutdown received');
        server.close();
        relayPool.close();
        try { await redis.quit(); } catch { /* ignore */ }
        process.exit(0);
    };
    process.on('SIGINT',  () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/** Mask password in a redis:// URL so we can log it safely. */
function maskRedisUrl(url: string): string {
    return url.replace(/(rediss?:\/\/[^:]*:)[^@]*(@)/, '$1***$2');
}

main().catch((err) => {
    // Use console here because the logger may have failed to construct
    // (bad LOG_LEVEL, missing env). We want the message in Railway logs
    // either way.
    // eslint-disable-next-line no-console
    console.error('fatal:', err);
    process.exit(1);
});
