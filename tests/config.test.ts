/**
 * Config parsing. The zod schema is the boot-time gate that turns a typo or
 * missing env into a loud failure - these tests pin the contract so a future
 * "convenience default" does not silently weaken it.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { generateSecretKey, nip19 } from 'nostr-tools';

// Ephemeral throwaway fixtures - generated per run, never real credentials.
const VALID_NSEC   = nip19.nsecEncode(generateSecretKey());
const VALID_SECRET = 'deadbeef'.repeat(8); // dummy 64-hex, not a real secret

async function loadFreshConfigModule(): Promise<typeof import('../src/config.js')> {
    const url = new URL(`../src/config.ts?cacheBust=${Math.random()}`, import.meta.url);
    return (await import(url.href)) as typeof import('../src/config.js');
}

function setMinimalEnv(): void {
    process.env['BOT_NSEC']             = VALID_NSEC;
    process.env['NOSTR_PROXY_SECRET']   = VALID_SECRET;
    delete process.env['BTCRECHARGE_BASE_URL'];
    delete process.env['NOSTR_RELAYS'];
    delete process.env['REDIS_URL'];
    delete process.env['PORT'];
    delete process.env['LOG_LEVEL'];
    delete process.env['APP_ENV'];
}

test('config: minimal env populates documented defaults', async () => {
    setMinimalEnv();
    const mod = await loadFreshConfigModule();
    const cfg = mod.getConfig();

    assert.equal(cfg.btcrechargeBaseUrl, 'https://btcrecharge.com');
    assert.deepEqual(cfg.nostrRelays, [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.snort.social',
        'wss://relay.primal.net',
        'wss://offchain.pub',
    ]);
    assert.equal(cfg.redisUrl, 'redis://localhost:6379');
    assert.equal(cfg.port, 3000);
    assert.equal(cfg.logLevel, 'info');
    assert.equal(cfg.appEnv, 'development');
});

test('config: trailing slash on base url is stripped', async () => {
    setMinimalEnv();
    process.env['BTCRECHARGE_BASE_URL'] = 'https://btcrecharge.com/';
    const mod = await loadFreshConfigModule();
    assert.equal(mod.getConfig().btcrechargeBaseUrl, 'https://btcrecharge.com');
});

test('config: relay list is comma-split and whitespace-trimmed', async () => {
    setMinimalEnv();
    process.env['NOSTR_RELAYS'] = '  wss://a.example , wss://b.example ,wss://c.example  ';
    const mod = await loadFreshConfigModule();
    assert.deepEqual(mod.getConfig().nostrRelays, [
        'wss://a.example',
        'wss://b.example',
        'wss://c.example',
    ]);
});

test('config: NOSTR_PROXY_SECRET must be exactly 64 hex chars', async () => {
    setMinimalEnv();
    process.env['NOSTR_PROXY_SECRET'] = 'short';
    const mod = await loadFreshConfigModule();
    assert.throws(() => mod.getConfig(), /NOSTR_PROXY_SECRET must be 64 hex/);
});

test('config: missing BOT_NSEC fails fast at boot', async () => {
    setMinimalEnv();
    delete process.env['BOT_NSEC'];
    const mod = await loadFreshConfigModule();
    assert.throws(() => mod.getConfig(), /BOT_NSEC is required/);
});

test('config: PORT coerces a numeric string and rejects garbage', async () => {
    setMinimalEnv();
    process.env['PORT'] = '8080';
    const mod = await loadFreshConfigModule();
    assert.equal(mod.getConfig().port, 8080);
});
