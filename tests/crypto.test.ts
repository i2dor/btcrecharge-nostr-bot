/**
 * Crypto layer behaviour. Tests run real NIP-04 / NIP-17 encrypt and
 * decrypt round-trips against fresh keypairs - the upstream library is
 * already covered by its own conformance tests, so we just pin the
 * contract that our wrapper exposes:
 *
 *   - NIP-04 round-trip with the correct sender / recipient mapping
 *   - NIP-17 round-trip, with the SEALED sender pubkey surfacing (not
 *     the ephemeral gift wrap author)
 *   - decryptIncoming routes by event kind and tags the protocol
 *   - decryptIncoming returns null on garbage rather than throwing
 *   - buildOutboundDm dual-sends when capability is unknown, single-sends
 *     when capability is already nip17
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { generateSecretKey, getPublicKey } from 'nostr-tools';

import {
    KIND_NIP04_DM,
    KIND_NIP17_WRAP,
    buildOutboundDm,
    decryptIncoming,
    encryptNip04,
    encryptNip17,
} from '../src/crypto.js';

function fixture() {
    const senderSk    = generateSecretKey();
    const senderPub   = getPublicKey(senderSk);
    const recipientSk = generateSecretKey();
    const recipientPub = getPublicKey(recipientSk);
    return { senderSk, senderPub, recipientSk, recipientPub };
}

// ------------------------------------------------------------------

test('crypto: NIP-04 round-trip surfaces plaintext + real sender pubkey', () => {
    const { senderSk, senderPub, recipientSk, recipientPub } = fixture();
    const plaintext = 'hello over the deprecated channel';
    const event     = encryptNip04(senderSk, recipientPub, plaintext);

    assert.equal(event.kind, KIND_NIP04_DM);
    assert.equal(event.pubkey, senderPub);
    assert.deepEqual(event.tags, [['p', recipientPub]]);

    const decrypted = decryptIncoming(recipientSk, event);
    assert.ok(decrypted);
    assert.equal(decrypted.plaintext,    plaintext);
    assert.equal(decrypted.protocol,     'nip04');
    assert.equal(decrypted.senderPubkey, senderPub);
});

test('crypto: NIP-17 round-trip surfaces sealed sender, not gift-wrap author', () => {
    const { senderSk, senderPub, recipientSk, recipientPub } = fixture();
    const plaintext = 'hello over the modern channel';
    const event     = encryptNip17(senderSk, recipientPub, plaintext);

    assert.equal(event.kind, KIND_NIP17_WRAP);
    // Outer author MUST be ephemeral - that is the whole point of
    // NIP-17 - so it must differ from our real sender pubkey.
    assert.notEqual(event.pubkey, senderPub);

    const decrypted = decryptIncoming(recipientSk, event);
    assert.ok(decrypted);
    assert.equal(decrypted.plaintext,    plaintext);
    assert.equal(decrypted.protocol,     'nip17');
    assert.equal(decrypted.senderPubkey, senderPub,
        'unwrapped sender must be the sealed real sender, not the ephemeral wrap key');
});

test('crypto: decryptIncoming returns null for unsupported event kinds', () => {
    const { recipientSk } = fixture();
    const fakeNote = {
        id:         '0'.repeat(64),
        pubkey:     '1'.repeat(64),
        created_at: 0,
        kind:       1,        // text note, not a DM
        tags:       [],
        content:    'hi',
        sig:        '0'.repeat(128),
    };
    assert.equal(decryptIncoming(recipientSk, fakeNote), null);
});

test('crypto: decryptIncoming returns null on garbage ciphertext', () => {
    const { senderSk, recipientPub, recipientSk } = fixture();
    const event     = encryptNip04(senderSk, recipientPub, 'good');
    const tampered  = { ...event, content: 'garbage-ciphertext' };
    assert.equal(decryptIncoming(recipientSk, tampered), null);
});

test('crypto: buildOutboundDm dual-sends when capability is unknown', () => {
    const { senderSk, recipientPub } = fixture();
    const events = buildOutboundDm(senderSk, recipientPub, 'hi', null);
    assert.equal(events.length, 2);
    // Numeric sort - default Array.prototype.sort is lexicographic, so
    // [4, 1059].sort() would give [1059, 4] because '1' < '4' as a string.
    const kinds = events.map(e => e.kind).sort((a, b) => a - b);
    assert.deepEqual(kinds, [KIND_NIP04_DM, KIND_NIP17_WRAP]);
});

test('crypto: buildOutboundDm dual-sends when last seen is nip04', () => {
    const { senderSk, recipientPub } = fixture();
    const events = buildOutboundDm(senderSk, recipientPub, 'hi', 'nip04');
    assert.equal(events.length, 2);
});

test('crypto: buildOutboundDm single-sends NIP-17 when capability proven', () => {
    const { senderSk, recipientPub } = fixture();
    const events = buildOutboundDm(senderSk, recipientPub, 'hi', 'nip17');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, KIND_NIP17_WRAP);
});

test('crypto: NIP-04 and NIP-17 both round-trip the same plaintext from same sender', () => {
    const { senderSk, recipientSk, recipientPub } = fixture();
    const text = 'shared plaintext used for both protocols';

    const four = encryptNip04(senderSk, recipientPub, text);
    const wrap = encryptNip17(senderSk, recipientPub, text);

    const four_decrypted = decryptIncoming(recipientSk, four);
    const wrap_decrypted = decryptIncoming(recipientSk, wrap);
    assert.equal(four_decrypted?.plaintext, text);
    assert.equal(wrap_decrypted?.plaintext, text);
});
