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
import { type Filter } from 'nostr-tools';

import { BtcrechargeClient } from './btcrecharge-client.js';
import { CatalogClient } from './catalog.js';
import { getConfig } from './config.js';
import { handleIncomingDm } from './handler.js';
import { getIdentity } from './identity.js';
import { getLogger } from './logger.js';
import { RelayPool } from './relay-pool.js';
import { SessionStore } from './session.js';
import { createWebhookServer } from './webhook-server.js';

async function main(): Promise<void> {
    const cfg = getConfig();
    const id  = getIdentity();
    const log = getLogger();

    log.info({
        npub:    id.npub,
        pubkey:  id.pubkey.slice(0, 16) + '...',
        env:     cfg.appEnv,
        relays:  cfg.nostrRelays.length,
        backend: cfg.btcrechargeBaseUrl,
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
    const catalog      = new CatalogClient({ baseUrl: cfg.btcrechargeBaseUrl }, redis, log);
    const btcrecharge  = new BtcrechargeClient({
        baseUrl:          cfg.btcrechargeBaseUrl,
        nostrProxySecret: cfg.nostrProxySecret,
    }, log);

    const relayPool = new RelayPool({ relays: cfg.nostrRelays }, log);

    // Inbound subscription: kind 4 (NIP-04) + kind 1059 (NIP-17 gift wrap)
    // addressed to the bot pubkey. Look back 5 minutes so a customer DM
    // sent in the brief window around a Railway redeploy is picked up on
    // boot. The relay pool dedupes via seen-event-id LRU, so replaying
    // recent events on every restart is harmless.
    const since: number = Math.floor(Date.now() / 1000) - 300;
    const filter: Filter = {
        kinds: [4, 1059],
        '#p':  [id.pubkey],
        since,
    };

    relayPool.subscribe(filter, (event) => {
        void handleIncomingDm(event, {
            botSecret:    id.secret,
            sessionStore,
            catalog,
            btcrecharge,
            relayPool,
            callbackUrl:  buildCallbackUrl(cfg.port),
            minPowBits:   0, // disabled by default for MVP
            logger:       log,
        });
    });

    const server = createWebhookServer({
        nostrProxySecret: cfg.nostrProxySecret,
        sessionStore,
        catalog,
        relayPool,
        botSecret:        id.secret,
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

function buildCallbackUrl(port: number): string {
    // Railway exposes the service over the public Railway domain; in
    // production we expect RAILWAY_PUBLIC_DOMAIN to be set. Locally the
    // fallback to localhost lets the smoke tests work without changes.
    const domain = process.env['RAILWAY_PUBLIC_DOMAIN'];
    if (domain) return `https://${domain}/webhook/order`;
    return `http://localhost:${port}/webhook/order`;
}

main().catch((err) => {
    // Use console here because the logger may have failed to construct
    // (bad LOG_LEVEL, missing env). We want the message in Railway logs
    // either way.
    // eslint-disable-next-line no-console
    console.error('fatal:', err);
    process.exit(1);
});
