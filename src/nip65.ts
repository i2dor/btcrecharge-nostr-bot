/**
 * Recipient relay resolution (NIP-17 / NIP-65).
 *
 * Replies published only to OUR pool relays are invisible to customers
 * whose clients read from elsewhere. This resolver finds where the
 * customer actually listens:
 *
 *   1. kind 10050 (NIP-17 DM inbox relays) - the canonical answer for
 *      DMs; tags shaped ['relay', 'wss://...'].
 *   2. kind 10002 (NIP-65 relay list) as fallback - 'read' and
 *      unmarked entries only; tags shaped ['r', 'wss://...', marker?].
 *
 * Lookups go through the relay pool plus a relay-list aggregator
 * (purplepag.es) so we find the lists even when the customer has no
 * relay overlap with us. Results are cached per pubkey; failures
 * return [] WITHOUT caching so the next DM retries.
 */
import type { Filter, NostrEvent } from 'nostr-tools';
import type { Logger } from 'pino';

const KIND_DM_RELAYS  = 10050;
const KIND_RELAY_LIST = 10002;

const DEFAULT_INDEX_RELAYS = ['wss://purplepag.es'];
const DEFAULT_MAX_RELAYS   = 4;
const DEFAULT_TTL_MS       = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES  = 1000;

/** The slice of RelayPool the resolver needs. Stubbable in tests. */
export interface RecipientRelayQueryPool {
    query(
        filter: Filter,
        opts?: { extraRelays?: readonly string[] },
    ): Promise<NostrEvent[]>;
}

export interface RecipientRelaysOptions {
    /** Aggregator relays unioned into every lookup. */
    indexRelays?: readonly string[];
    /** Cap on returned relays - publishing to a customer's full 20-relay
     *  list would multiply outbound connections for no delivery gain. */
    maxRelays?: number;
    ttlMs?: number;
    maxEntries?: number;
}

interface CacheEntry {
    relays:    string[];
    expiresAt: number;
}

function isRelayUrl(url: string): boolean {
    return /^wss?:\/\//i.test(url);
}

export class RecipientRelays {
    private readonly pool:        RecipientRelayQueryPool;
    private readonly log:         Logger;
    private readonly indexRelays: readonly string[];
    private readonly maxRelays:   number;
    private readonly ttlMs:       number;
    private readonly maxEntries:  number;
    private readonly cache:       Map<string, CacheEntry> = new Map();

    constructor(pool: RecipientRelayQueryPool, logger: Logger, opts: RecipientRelaysOptions = {}) {
        this.pool        = pool;
        this.log         = logger.child({ component: 'recipient-relays' });
        this.indexRelays = opts.indexRelays ?? DEFAULT_INDEX_RELAYS;
        this.maxRelays   = opts.maxRelays   ?? DEFAULT_MAX_RELAYS;
        this.ttlMs       = opts.ttlMs       ?? DEFAULT_TTL_MS;
        this.maxEntries  = opts.maxEntries  ?? DEFAULT_MAX_ENTRIES;
    }

    /**
     * Resolve the customer's DM inbox relays. Never throws; a failed
     * lookup returns [] so the caller falls back to pool-only publish.
     */
    async resolve(pubkey: string): Promise<string[]> {
        const hit = this.cache.get(pubkey);
        if (hit && hit.expiresAt > Date.now()) return hit.relays;

        let events: NostrEvent[];
        try {
            events = await this.pool.query(
                { kinds: [KIND_DM_RELAYS, KIND_RELAY_LIST], authors: [pubkey] },
                { extraRelays: this.indexRelays },
            );
        } catch (err) {
            this.log.warn(
                { pubkey: pubkey.slice(0, 8), err: String(err) },
                'recipient relay lookup failed - replying on pool relays only',
            );
            return [];
        }

        const relays = this.pick(events);
        this.store(pubkey, relays);
        this.log.debug(
            { pubkey: pubkey.slice(0, 8), relays: relays.length },
            'recipient relays resolved',
        );
        return relays;
    }

    private pick(events: NostrEvent[]): string[] {
        const dmRelays = this.newest(events, KIND_DM_RELAYS);
        if (dmRelays) {
            const urls = dmRelays.tags
                .filter((t) => t[0] === 'relay' && typeof t[1] === 'string')
                .map((t) => t[1] as string);
            const picked = this.sanitize(urls);
            if (picked.length > 0) return picked;
        }

        const relayList = this.newest(events, KIND_RELAY_LIST);
        if (relayList) {
            const urls = relayList.tags
                .filter(
                    (t) =>
                        t[0] === 'r' &&
                        typeof t[1] === 'string' &&
                        (t[2] === undefined || t[2] === 'read'),
                )
                .map((t) => t[1] as string);
            return this.sanitize(urls);
        }

        return [];
    }

    private newest(events: NostrEvent[], kind: number): NostrEvent | null {
        let best: NostrEvent | null = null;
        for (const e of events) {
            if (e.kind !== kind) continue;
            if (!best || e.created_at > best.created_at) best = e;
        }
        return best;
    }

    private sanitize(urls: string[]): string[] {
        return [...new Set(urls.filter(isRelayUrl))].slice(0, this.maxRelays);
    }

    private store(pubkey: string, relays: string[]): void {
        if (this.cache.size >= this.maxEntries) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
        }
        this.cache.set(pubkey, { relays, expiresAt: Date.now() + this.ttlMs });
    }
}
