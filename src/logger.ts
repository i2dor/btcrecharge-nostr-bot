/**
 * Structured logger. Use this everywhere - never `console.log`.
 *
 * Sensitive fields (nsec, hex private keys, raw HMAC secrets) are scrubbed
 * by the redact list. Adding a new secret-bearing field? Add it here too,
 * or it WILL leak into Railway logs and Sentry.
 */
import pino from 'pino';
import { getConfig } from './config.js';

let cached: pino.Logger | null = null;

export function getLogger(): pino.Logger {
    if (cached) return cached;
    const cfg = getConfig();
    cached = pino({
        level: cfg.logLevel,
        base:  { env: cfg.appEnv, service: 'btcrecharge-nostr-bot' },
        redact: {
            paths: [
                'nsec',
                'BOT_NSEC',
                'NOSTR_PROXY_SECRET',
                'secret',
                'privateKey',
                'sk',
                '*.nsec',
                '*.secret',
                'req.headers.authorization',
                'req.headers["x-signature"]',
            ],
            censor: '[REDACTED]',
        },
    });
    return cached;
}
