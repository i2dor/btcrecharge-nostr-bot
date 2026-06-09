/**
 * Bot identity. Loaded once at boot from the BOT_NSEC environment variable.
 * If BOT_NSEC is missing we refuse to start - the bot's pubkey IS its
 * identity to customers and to btcrecharge's allow-list; generating a fresh
 * keypair at boot would silently flip the bot to a new npub and orphan every
 * in-flight conversation.
 */
import { getPublicKey, nip19 } from 'nostr-tools';

interface Identity {
    secret: Uint8Array;
    pubkey: string;
    npub:   string;
}

function decodeNsec(raw: string): Uint8Array {
    if (raw.startsWith('nsec1')) {
        const { type, data } = nip19.decode(raw);
        if (type !== 'nsec') throw new Error(`unexpected nip19 type for BOT_NSEC: ${type}`);
        return data;
    }
    if (/^[0-9a-f]{64}$/i.test(raw)) {
        return Uint8Array.from(Buffer.from(raw, 'hex'));
    }
    throw new Error('BOT_NSEC must be either bech32 (nsec1...) or 64 hex chars');
}

let cached: Identity | null = null;

export function getIdentity(): Identity {
    if (cached) return cached;
    const raw = process.env.BOT_NSEC ?? '';
    if (!raw) {
        throw new Error(
            'BOT_NSEC env var is required. Set it to the bot\'s nsec1... (or 64 hex). ' +
            'Generate ONCE for production and persist offline.'
        );
    }
    const secret = decodeNsec(raw);
    const pubkey = getPublicKey(secret);
    cached = { secret, pubkey, npub: nip19.npubEncode(pubkey) };
    return cached;
}
