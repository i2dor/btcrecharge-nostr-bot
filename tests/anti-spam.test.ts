/**
 * Anti-spam primitives behaviour.
 *
 * Token bucket: deterministic refill math, capacity clamp, empty-bucket
 * reject path, lastRefill advances on reject too.
 *
 * NIP-13: leading-zero-bit counting for every nibble pattern, committed
 * target validation, disabled-mode (minBits=0) always allows, missing
 * nonce tag rejected even when id happens to have enough zeros.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { NostrEvent } from 'nostr-tools';

import { consumeToken, countLeadingZeroBits, meetsPoWThreshold } from '../src/anti-spam.js';

// ------------------------------------------------------------------
// token bucket
// ------------------------------------------------------------------

const CAP = 10;
const RATE = 10 / 60; // 10 per minute

test('bucket: full bucket allows the first DM and decrements by one', () => {
    const r = consumeToken({ bucket: CAP, lastRefill: 1000 }, CAP, RATE, 1000);
    assert.equal(r.allowed, true);
    assert.equal(r.state.bucket, CAP - 1);
    assert.equal(r.state.lastRefill, 1000);
});

test('bucket: empty bucket with zero elapsed time rejects', () => {
    const r = consumeToken({ bucket: 0, lastRefill: 1000 }, CAP, RATE, 1000);
    assert.equal(r.allowed, false);
    assert.equal(r.state.bucket, 0);
    assert.equal(r.state.lastRefill, 1000, 'lastRefill should still advance even on reject');
});

test('bucket: empty bucket with one full refill window allows again', () => {
    // 6 seconds at 1/6 token/sec = 1 token.
    const r = consumeToken({ bucket: 0, lastRefill: 1000 }, CAP, RATE, 1006);
    assert.equal(r.allowed, true);
    assert.ok(r.state.bucket < 1e-9, `expected ~0 tokens left, got ${r.state.bucket}`);
});

test('bucket: refill caps at capacity even after very long idle', () => {
    const r = consumeToken({ bucket: 0, lastRefill: 1000 }, CAP, RATE, 1_000_000);
    assert.equal(r.allowed, true);
    // After consuming one, at most capacity - 1 should remain.
    assert.ok(r.state.bucket <= CAP - 1, `bucket exceeded cap-1: ${r.state.bucket}`);
});

test('bucket: 50 DMs at full speed land 10 allowed + 40 rejected', () => {
    let state = { bucket: CAP, lastRefill: 1000 };
    let allowed = 0;
    for (let i = 0; i < 50; i++) {
        const r = consumeToken(state, CAP, RATE, 1000); // no time advance
        state = r.state;
        if (r.allowed) allowed++;
    }
    assert.equal(allowed, CAP, 'exactly capacity-many DMs should pass when no time advances');
});

test('bucket: invariant: capacity and refill rate must be positive', () => {
    assert.throws(() => consumeToken({ bucket: 0, lastRefill: 0 }, 0,   1, 0));
    assert.throws(() => consumeToken({ bucket: 0, lastRefill: 0 }, 10,  0, 0));
});

// ------------------------------------------------------------------
// countLeadingZeroBits
// ------------------------------------------------------------------

test('zero-bits: an all-zero hex string returns the full bit length', () => {
    assert.equal(countLeadingZeroBits('0000'), 16);
});

test('zero-bits: each nibble pattern returns the right zero count', () => {
    // '1' = 0b0001 -> 3 leading zeros within the nibble
    assert.equal(countLeadingZeroBits('1abc'), 3);
    // '8' = 0b1000 -> 0 leading zeros
    assert.equal(countLeadingZeroBits('8abc'), 0);
    // '4' = 0b0100 -> 1 leading zero
    assert.equal(countLeadingZeroBits('4abc'), 1);
    // '2' = 0b0010 -> 2 leading zeros
    assert.equal(countLeadingZeroBits('2abc'), 2);
});

test('zero-bits: counting continues across leading zeros', () => {
    // 0,0,0,1 -> 4+4+4+3 = 15 leading zero bits
    assert.equal(countLeadingZeroBits('0001abcd'), 15);
});

// ------------------------------------------------------------------
// NIP-13 acceptance gate
// ------------------------------------------------------------------

function evtWith(id: string, tags: string[][] = []): NostrEvent {
    return {
        id,
        pubkey:     'a'.repeat(64),
        created_at: 0,
        kind:       4,
        tags,
        content:    '',
        sig:        '0'.repeat(128),
    };
}

test('pow: minBits=0 disables the gate, every event passes', () => {
    assert.equal(meetsPoWThreshold(evtWith('f'.repeat(64)), 0), true);
});

test('pow: rejects when id has fewer leading zero bits than required', () => {
    // 'f...' = 0 leading zero bits, fails any positive threshold.
    const event = evtWith('f'.repeat(64), [['nonce', '0', '16']]);
    assert.equal(meetsPoWThreshold(event, 16), false);
});

test('pow: rejects when nonce tag is missing even if id has enough zeros', () => {
    const event = evtWith('0000' + 'a'.repeat(60));
    // id has 16 leading zero bits, but no nonce -> reject.
    assert.equal(meetsPoWThreshold(event, 16), false);
});

test('pow: rejects when committed target undershoots the requirement', () => {
    const event = evtWith('0000' + 'a'.repeat(60), [['nonce', '0', '8']]);
    assert.equal(meetsPoWThreshold(event, 16), false);
});

test('pow: accepts when both id and committed target meet the requirement', () => {
    const event = evtWith('0000' + 'a'.repeat(60), [['nonce', '0', '16']]);
    assert.equal(meetsPoWThreshold(event, 16), true);
});

test('pow: rejects an event with a malformed (short) id', () => {
    assert.equal(meetsPoWThreshold(evtWith('abc'), 8), false);
});
