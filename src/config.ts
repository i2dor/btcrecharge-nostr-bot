/**
 * Environment-driven config. Parsed with zod so a typo or missing value
 * fails loudly at boot instead of silently at the first call site.
 */
import { z } from 'zod';

const Schema = z.object({
    // `required_error` covers `undefined`, `.min(1)` covers an empty string;
    // without both, zod's default "Required" / "String must contain at
    // least 1 character(s)" messages bypass our custom hint.
    BOT_NSEC:             z.string({ required_error: 'BOT_NSEC is required' }).min(1, 'BOT_NSEC is required'),
    NOSTR_PROXY_SECRET:   z.string({ required_error: 'NOSTR_PROXY_SECRET must be 64 hex' }).regex(/^[0-9a-f]{64}$/i, 'NOSTR_PROXY_SECRET must be 64 hex'),
    BTCRECHARGE_BASE_URL: z.string().url().default('https://btcrecharge.com'),
    NOSTR_RELAYS:         z.string().min(1).default('wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social'),
    // Railway internal hostnames (redis-volume.railway.internal) parse fine
    // as URLs, but zod's url() rejects values containing dots-as-tld when
    // the host lacks a public suffix. Relax to "starts with redis://" so
    // ioredis itself surfaces a useful error if the URL is malformed
    // instead of a cryptic 'Invalid url' at boot.
    REDIS_URL:            z.string().regex(/^rediss?:\/\//i, 'REDIS_URL must start with redis:// or rediss://').default('redis://localhost:6379'),
    PORT:                 z.coerce.number().int().positive().default(3000),
    LOG_LEVEL:            z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    APP_ENV:              z.enum(['development', 'test', 'staging', 'production']).default('development'),
});

export interface Config {
    botNsec:            string;
    nostrProxySecret:   string;
    btcrechargeBaseUrl: string;
    nostrRelays:        readonly string[];
    redisUrl:           string;
    port:               number;
    logLevel:           'trace' | 'debug' | 'info' | 'warn' | 'error';
    appEnv:             'development' | 'test' | 'staging' | 'production';
}

let cached: Config | null = null;

export function getConfig(): Config {
    if (cached) return cached;
    const parsed = Schema.parse(process.env);
    cached = {
        botNsec:            parsed.BOT_NSEC,
        nostrProxySecret:   parsed.NOSTR_PROXY_SECRET,
        btcrechargeBaseUrl: parsed.BTCRECHARGE_BASE_URL.replace(/\/$/, ''),
        nostrRelays:        parsed.NOSTR_RELAYS.split(',').map(s => s.trim()).filter(Boolean),
        redisUrl:           parsed.REDIS_URL,
        port:               parsed.PORT,
        logLevel:           parsed.LOG_LEVEL,
        appEnv:             parsed.APP_ENV,
    };
    return cached;
}
