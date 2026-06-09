/**
 * Identity loader behaviour. Verifies the bech32 / hex inputs both decode
 * to the same pubkey, and that misuse fails loudly at boot rather than
 * silently rolling a fresh keypair.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

// Internal module under test - import lazily inside each test so we can
// reset the env between runs (the module memoises identity).
async function loadFreshIdentityModule(): Promise<typeof import('../src/identity.js')> {
    // ESM has no `delete require.cache`. Bust the cache by importing through
    // a query-string suffix so each call resolves to a fresh module instance.
    const url = new URL(`../src/identity.ts?cacheBust=${Math.random()}`, import.meta.url);
    return (await import(url.href)) as typeof import('../src/identity.js');
}

test('identity: bech32 nsec round-trips to the expected pubkey', async () => {
    const sk   = generateSecretKey();
    const nsec = nip19.nsecEncode(sk);
    const expected = getPublicKey(sk);

    process.env['BOT_NSEC'] = nsec;
    const mod = await loadFreshIdentityModule();
    const id  = mod.getIdentity();

    assert.equal(id.pubkey, expected);
    assert.equal(id.npub, nip19.npubEncode(expected));
});

test('identity: 64-hex nsec produces the same pubkey as the bech32 form', async () => {
    const sk      = generateSecretKey();
    const hex     = Buffer.from(sk).toString('hex');
    const expected = getPublicKey(sk);

    process.env['BOT_NSEC'] = hex;
    const mod = await loadFreshIdentityModule();
    const id  = mod.getIdentity();

    assert.equal(id.pubkey, expected);
});

test('identity: missing BOT_NSEC throws at first access, no silent regen', async () => {
    delete process.env['BOT_NSEC'];
    const mod = await loadFreshIdentityModule();
    assert.throws(() => mod.getIdentity(), /BOT_NSEC env var is required/);
});

test('identity: malformed BOT_NSEC throws with a hint about the accepted forms', async () => {
    process.env['BOT_NSEC'] = 'not-a-valid-key';
    const mod = await loadFreshIdentityModule();
    assert.throws(() => mod.getIdentity(), /bech32 \(nsec1\.\.\.\) or 64 hex/);
});
