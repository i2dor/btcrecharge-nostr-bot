/**
 * Anti-spam primitives. Two independent layers, both pure functions
 * driven by inputs - no I/O, no clocks, no globals - so they unit-test
 * trivially and the caller decides when to persist the result.
 *
 * Layer 1: token bucket per pubkey. The session schema already carries
 * `rateLimit.bucket` and `rateLimit.lastRefill`; this module computes
 * the new state when a DM arrives, without knowing or caring that the
 * persistence backend is Redis.
 *
 * Layer 2: NIP-13 Proof-of-Work. Inbound events MUST carry a `nonce`
 * tag declaring a committed target difficulty, and the event id MUST
 * actually meet that target. We additionally require the target to be
 * at least our configured minimum, otherwise an attacker could ship an
 * event with target=0 and we would accept it.
 *
 * MVP defaults: bucket capacity 10, refill 10/min (one token every 6s),
 * PoW minBits = 0 (disabled). Operators dial up minBits in production
 * once organic traffic patterns are known.
 */
import type { NostrEvent } from 'nostr-tools';

// ----- token bucket -------------------------------------------------

export interface BucketState {
    /** Tokens currently in the bucket, fractional. */
    bucket:     number;
    /** Last time we credited refills, unix seconds. */
    lastRefill: number;
}

export interface BucketDecision {
    allowed:  boolean;
    /** Bucket state to persist - update even on reject so refill clock advances. */
    state:    BucketState;
}

/**
 * Consume one token from the bucket. The bucket refills continuously at
 * `refillPerSec` tokens per second, capped at `capacity`. If at least
 * one token is available the call returns `allowed: true` and a state
 * with one token spent; otherwise `allowed: false` and the bucket left
 * empty (but with `lastRefill` advanced so future refills are accurate).
 *
 * A fresh-pubkey session typically starts with `bucket = 0` so the very
 * first DM is decided by however much refill has accrued since
 * `lastRefill`. For frictionless first-touch UX, callers should
 * initialize `bucket = capacity` when minting a new session.
 */
export function consumeToken(
    current:      BucketState,
    capacity:     number,
    refillPerSec: number,
    nowSec:       number,
): BucketDecision {
    if (capacity <= 0)     throw new Error('bucket capacity must be positive');
    if (refillPerSec <= 0) throw new Error('refill rate must be positive');

    const elapsed   = Math.max(0, nowSec - current.lastRefill);
    const refilled  = Math.min(capacity, current.bucket + elapsed * refillPerSec);
    if (refilled < 1) {
        return {
            allowed: false,
            state:   { bucket: refilled, lastRefill: nowSec },
        };
    }
    return {
        allowed: true,
        state:   { bucket: refilled - 1, lastRefill: nowSec },
    };
}

// ----- NIP-13 Proof-of-Work -----------------------------------------

/**
 * Count leading zero bits in a hex string (typically `event.id`). Used
 * by NIP-13 to measure work done on an event. Works one nibble at a
 * time so a 64-char id is at most 64 iterations.
 */
export function countLeadingZeroBits(hex: string): number {
    let bits = 0;
    for (const ch of hex.toLowerCase()) {
        const nibble = parseInt(ch, 16);
        if (Number.isNaN(nibble)) break;
        if (nibble === 0) { bits += 4; continue; }
        // clz32(n) counts leading zeros of a 32-bit value; for a 4-bit
        // nibble the bits live in bits 0-3 so we subtract 28.
        bits += Math.clz32(nibble) - 28;
        break;
    }
    return bits;
}

/**
 * NIP-13 acceptance gate.
 *
 *   1. event.id MUST have at least `minBits` leading zero bits, AND
 *   2. the `nonce` tag MUST exist with a committed target >= minBits.
 *
 * The second check prevents an attacker from shipping an event with
 * `target = 0` (no commitment) but a happens-to-be-lucky id - per the
 * NIP-13 spec the target is the part of the work that proves intent.
 *
 * When `minBits === 0` the gate is disabled and every event passes.
 * That is the MVP default; raise it once organic traffic shape is known.
 */
export function meetsPoWThreshold(event: NostrEvent, minBits: number): boolean {
    if (minBits <= 0) return true;
    if (!event.id || event.id.length !== 64) return false;

    if (countLeadingZeroBits(event.id) < minBits) return false;

    const nonce = event.tags.find(t => t[0] === 'nonce');
    if (!nonce || nonce.length < 3) return false;
    const committed = Number(nonce[2]);
    if (!Number.isInteger(committed) || committed < minBits) return false;

    return true;
}
