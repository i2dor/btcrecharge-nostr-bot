/**
 * NIP-09 deletion request for an event published by the bot.
 *
 * Usage:
 *   npm run delete-event -- --event-id=<64-hex>
 *   npm run delete-event -- --event-id=<64-hex> --reason="reposted by mistake"
 *   npm run delete-event -- --event-id=<64-hex> --dry-run
 *
 * What this does:
 *   - Builds a kind 5 "deletion request" event referencing the target
 *     event id via an `e` tag.
 *   - Signs it with BOT_NSEC (the only key that has the right to delete
 *     an event the bot published).
 *   - Broadcasts to NOSTR_RELAYS.
 *
 * What it does NOT do:
 *   - It is not a hard delete. NIP-09 is a REQUEST. Compliant relays
 *     stop serving the event; non-compliant ones keep it. Clients that
 *     already cached the event may still display it locally until the
 *     cache is evicted.
 *   - It cannot delete events from a different pubkey - signature would
 *     not match, every relay would reject.
 *
 * How to find the event id:
 *   - Damus / Primal / Amethyst: tap the event -> "Copy event id" or
 *     "View raw JSON" -> the `id` field is 64 hex chars.
 *   - Web: open `https://njump.me/<npub>` to see the bot's recent
 *     events with their ids.
 *   - Programmatically: query any relay for kind 6 (repost) events
 *     authored by the bot pubkey.
 */
import { SimplePool, finalizeEvent } from 'nostr-tools';

import { getIdentity } from '../src/identity.js';

export interface DeleteFlags {
    eventId:   string;
    reason:    string | undefined;
    dryRun:    boolean;
    timeoutMs: number;
}

export function parseDeleteFlags(argv: readonly string[]): DeleteFlags {
    let eventId:   string | undefined;
    let reason:    string | undefined;
    let dryRun     = false;
    let timeoutMs  = 8000;

    for (const raw of argv) {
        const arg = raw.replace(/^--/, '');
        if (arg === 'dry-run') { dryRun = true; continue; }
        const eq = arg.indexOf('=');
        if (eq < 0) throw new Error(`unknown flag: --${arg} (expected --key=value)`);
        const key = arg.slice(0, eq);
        const val = arg.slice(eq + 1);
        if (key === 'event-id' || key === 'event_id') { eventId = val.toLowerCase(); continue; }
        if (key === 'reason')                         { reason = val; continue; }
        if (key === 'timeout')                        { timeoutMs = parseInt(val, 10); continue; }
        throw new Error(`unknown flag: --${key}`);
    }
    if (!eventId) {
        throw new Error('--event-id=<64-hex> is required');
    }
    if (!/^[0-9a-f]{64}$/.test(eventId)) {
        throw new Error(`--event-id must be 64 lowercase hex chars (got ${eventId.length} chars)`);
    }
    return { eventId, reason, dryRun, timeoutMs };
}

function relays(): readonly string[] {
    const raw = process.env['NOSTR_RELAYS']
        ?? 'wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social,wss://relay.primal.net,wss://offchain.pub';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
    let flags: DeleteFlags;
    try { flags = parseDeleteFlags(process.argv.slice(2)); }
    catch (err) {
        console.error('Bad args:', (err as Error).message);
        console.error('Usage: npm run delete-event -- --event-id=<64-hex> [--reason="..."] [--dry-run]');
        process.exit(2);
    }

    const id   = getIdentity();
    const list = relays();

    console.log('Deletion request from', id.npub);
    console.log('Target event id:', flags.eventId);
    console.log('Reason         :', flags.reason ?? '(none)');
    console.log('Relays         :', list.join(', '));

    const template = {
        kind:       5,
        content:    flags.reason ?? '',
        tags:       [['e', flags.eventId]],
        created_at: Math.floor(Date.now() / 1000),
    };
    const signed = finalizeEvent(template, id.secret);

    console.log('\nDeletion event to publish:');
    console.log(JSON.stringify(signed, null, 2));

    if (flags.dryRun) {
        console.log('\n--dry-run: not publishing.');
        process.exit(0);
    }

    const pool = new SimplePool();
    const promises = pool.publish([...list], signed);
    const per: Record<string, string> = {};
    let ok = 0;
    await Promise.all(promises.map((p, i) => {
        const url = list[i] ?? `relay-${i}`;
        return Promise.race([
            p.then(
                ()  => { per[url] = 'ok'; ok++; },
                err => { per[url] = 'fail: ' + String(err).slice(0, 80); },
            ),
            new Promise<void>((res) => setTimeout(() => {
                if (!(url in per)) per[url] = 'timeout';
                res();
            }, flags.timeoutMs)),
        ]);
    }));

    console.log('\nPer-relay outcome:');
    for (const [url, status] of Object.entries(per)) {
        console.log(`  ${url.padEnd(36)} ${status}`);
    }
    console.log(`\nDeletion request broadcast to ${ok}/${list.length} relays.`);
    console.log('\nReminder: NIP-09 is a request, not a hard delete. Relays may');
    console.log('ignore it, and clients that already cached the event may still');
    console.log('show it for up to 24h. Wait 1-2 min then check your client.');
    pool.close([...list]);
    process.exit(ok > 0 ? 0 : 1);
}

const invokedDirectly = (() => {
    const entry = process.argv[1] ?? '';
    return entry.endsWith('delete-event.ts') || entry.endsWith('delete-event.js');
})();
if (invokedDirectly) {
    main().catch((err) => {
        console.error('fatal:', err);
        process.exit(1);
    });
}
