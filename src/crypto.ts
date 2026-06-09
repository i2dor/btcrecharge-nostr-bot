/**
 * Encryption layer for outbound and inbound DMs.
 *
 * Decision #2 (locked 2026-06-09): dual NIP-04 + NIP-17 with capability
 * detection. NIP-04 is the deprecated-but-universally-supported legacy
 * path; NIP-17 (Gift Wrap, kind 1059) is the modern privacy-preserving
 * path. We accept either on inbound, and on reply use whichever protocol
 * the customer's client demonstrated by their last incoming DM. If we have
 * not seen this customer before, we send both.
 *
 * Inbound NIP-17 unwrap returns the REAL sender pubkey from the inner
 * seal, not the ephemeral gift-wrap author. That sender pubkey is the
 * customer identity used for session lookup, rate limiting, and order
 * attribution.
 */
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, nip04, nip17 } from 'nostr-tools';

/** Wire-format kinds we accept inbound. */
export const KIND_NIP04_DM    = 4    as const;
export const KIND_NIP17_WRAP  = 1059 as const;

export type Protocol = 'nip04' | 'nip17';

export interface DecryptedDm {
    plaintext:    string;
    protocol:     Protocol;
    senderPubkey: string;
}

/**
 * Encrypt + sign a NIP-04 kind=4 DM. Output is publish-ready.
 *
 * NIP-04 leaks the recipient pubkey in the `p` tag, the sender pubkey in
 * the event author, the timestamp, and the ciphertext length. Customers
 * who care about that should prefer NIP-17 (and their client should send
 * us NIP-17 so our capability tracker switches them over).
 */
export function encryptNip04(
    senderSecret:    Uint8Array,
    recipientPubkey: string,
    plaintext:       string,
): NostrEvent {
    const ciphertext = nip04.encrypt(senderSecret, recipientPubkey, plaintext);
    return finalizeEvent(
        {
            kind:       KIND_NIP04_DM,
            created_at: Math.floor(Date.now() / 1000),
            tags:       [['p', recipientPubkey]],
            content:    ciphertext,
        },
        senderSecret,
    );
}

/**
 * Encrypt + sign a NIP-17 Gift Wrap (kind 1059). Internally builds the
 * three layers (rumor + seal + wrap) via nostr-tools `nip17.wrapEvent`.
 *
 * The outer event author is an ephemeral random key, so observers cannot
 * link multiple gift wraps to the same bot identity. The real bot pubkey
 * is sealed inside.
 */
export function encryptNip17(
    senderSecret:    Uint8Array,
    recipientPubkey: string,
    plaintext:       string,
): NostrEvent {
    return nip17.wrapEvent(senderSecret, { publicKey: recipientPubkey }, plaintext);
}

/**
 * Decrypt a DM and surface which protocol it used. Returns null when the
 * event is not a DM kind we accept, or when decryption fails (bad MAC,
 * truncated payload, wrong recipient). Returning null instead of throwing
 * keeps the relay-pool callback site simple - dropped messages just log
 * and move on, no exception walls.
 */
export function decryptIncoming(
    recipientSecret: Uint8Array,
    event:           NostrEvent,
): DecryptedDm | null {
    if (event.kind === KIND_NIP04_DM) {
        try {
            const plaintext = nip04.decrypt(recipientSecret, event.pubkey, event.content);
            return { plaintext, protocol: 'nip04', senderPubkey: event.pubkey };
        } catch {
            return null;
        }
    }
    if (event.kind === KIND_NIP17_WRAP) {
        try {
            // `unwrapEvent` returns the inner Rumor, whose pubkey is the
            // REAL sender (the gift-wrap author is throwaway).
            const rumor = nip17.unwrapEvent(event, recipientSecret);
            return { plaintext: rumor.content, protocol: 'nip17', senderPubkey: rumor.pubkey };
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Decide which event(s) to publish based on the last-known protocol for
 * this recipient. Unknown or NIP-04 -> dual send (both kinds). Known
 * NIP-17 -> single send (efficiency, the customer's client already proved
 * it understands gift wrap).
 *
 * This implements the body of Decision #2.
 */
export function buildOutboundDm(
    senderSecret:    Uint8Array,
    recipientPubkey: string,
    plaintext:       string,
    knownProtocol:   Protocol | null,
): NostrEvent[] {
    if (knownProtocol === 'nip17') {
        return [encryptNip17(senderSecret, recipientPubkey, plaintext)];
    }
    return [
        encryptNip04(senderSecret, recipientPubkey, plaintext),
        encryptNip17(senderSecret, recipientPubkey, plaintext),
    ];
}
