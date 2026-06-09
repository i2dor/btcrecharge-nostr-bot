/**
 * Callback URL resolution.
 *
 * Pins the resolution order that silently broke prod (orders 1015-1017
 * landed `http://localhost:8080/webhook/order` because neither
 * BOT_PUBLIC_URL nor RAILWAY_PUBLIC_DOMAIN was set on Railway, and the
 * caller never noticed because the fallback was a string-literal default).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { resolveCallbackUrl } from '../src/callback-url.js';

test('resolveCallbackUrl: BOT_PUBLIC_URL wins over RAILWAY_PUBLIC_DOMAIN', () => {
    const url = resolveCallbackUrl({
        botPublicUrl:        'https://bot.example.com',
        railwayPublicDomain: 'railway.example.com',
        port:                3000,
    });
    assert.equal(url, 'https://bot.example.com/webhook/order');
});

test('resolveCallbackUrl: RAILWAY_PUBLIC_DOMAIN is the second-priority fallback', () => {
    const url = resolveCallbackUrl({
        botPublicUrl:        undefined,
        railwayPublicDomain: 'btcrecharge-nostr-bot.up.railway.app',
        port:                3000,
    });
    assert.equal(url, 'https://btcrecharge-nostr-bot.up.railway.app/webhook/order');
});

test('resolveCallbackUrl: localhost fallback when nothing else is set (dev only)', () => {
    const url = resolveCallbackUrl({
        botPublicUrl:        undefined,
        railwayPublicDomain: undefined,
        port:                3000,
    });
    assert.equal(url, 'http://localhost:3000/webhook/order');
});

test('resolveCallbackUrl: trailing slash on BOT_PUBLIC_URL is normalised', () => {
    const url = resolveCallbackUrl({
        botPublicUrl:        'https://bot.example.com/',
        railwayPublicDomain: undefined,
        port:                3000,
    });
    assert.equal(url, 'https://bot.example.com/webhook/order');
});
