/**
 * One-shot CLI: publish a kind 0 metadata event for the bot identity.
 *
 * - Loads BOT_NSEC + NOSTR_RELAYS from the environment (same env contract
 *   as the bot proper). Fails loudly if BOT_NSEC is missing rather than
 *   silently generating a fresh keypair.
 * - Subscribes to the current kind 0 first and merges the existing
 *   content with the CLI args; fields the operator does NOT pass on the
 *   CLI are preserved verbatim. This is what keeps `name`, `nip05`, etc.
 *   from getting wiped just because you only wanted to flip the picture.
 * - Signs with the bot's secret, broadcasts via SimplePool, reports the
 *   per-relay ack/fail outcome.
 *
 * Usage:
 *   npm run publish-profile -- \
 *     --picture=https://nostr.build/i/<id>.png \
 *     --banner=https://nostr.build/i/<id>.png
 *
 * Other flags: --name, --display-name, --about, --nip05, --lud16,
 * --website, --dry-run (skip publish, print the event), --no-fetch (skip
 * the existing-event merge step), --timeout=<ms> (fetch + publish window,
 * default 8000).
 *
 * Exit codes: 0 = published to >= 1 relay; 1 = published to 0 relays;
 * 2 = bad invocation.
 */
import { SimplePool, finalizeEvent, type NostrEvent } from 'nostr-tools';

import { getIdentity } from '../src/identity.js';

export interface ProfileFields {
    name?:         string;
    display_name?: string;
    picture?:      string;
    banner?:       string;
    about?:        string;
    nip05?:        string;
    lud16?:        string;
    website?:      string;
}

export interface Flags extends ProfileFields {
    dryRun:    boolean;
    noFetch:   boolean;
    timeoutMs: number;
}

const KNOWN_KEYS = ['name', 'display_name', 'picture', 'banner', 'about', 'nip05', 'lud16', 'website'] as const;

export function parseFlags(argv: readonly string[]): Flags {
    const out: Flags = { dryRun: false, noFetch: false, timeoutMs: 8000 };
    for (const raw of argv) {
        const arg = raw.replace(/^--/, '');
        if (arg === 'dry-run')  { out.dryRun  = true; continue; }
        if (arg === 'no-fetch') { out.noFetch = true; continue; }
        const eq = arg.indexOf('=');
        if (eq < 0) {
            throw new Error(`unknown flag: --${arg} (expected --key=value)`);
        }
        const key = arg.slice(0, eq);
        const val = arg.slice(eq + 1);
        if (key === 'timeout') { out.timeoutMs = parseInt(val, 10); continue; }
        // Accept both kebab-case (CLI ergonomics) and snake_case (NIP-01).
        const norm = key.replace(/-/g, '_') as typeof KNOWN_KEYS[number];
        if (!(KNOWN_KEYS as readonly string[]).includes(norm)) {
            throw new Error(`unknown profile field: ${key}`);
        }
        out[norm] = val;
    }
    return out;
}

function relays(): readonly string[] {
    const raw = process.env['NOSTR_RELAYS']
        ?? 'wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social,wss://relay.primal.net,wss://offchain.pub';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

async function fetchLatestKind0(
    pool:    SimplePool,
    pubkey:  string,
    relays:  readonly string[],
    timeoutMs: number,
): Promise<NostrEvent | null> {
    return new Promise((resolve) => {
        let latest: NostrEvent | null = null;
        const sub = pool.subscribeMany(
            [...relays],
            [{ kinds: [0], authors: [pubkey], limit: 1 }],
            {
                onevent: (ev) => {
                    if (!latest || ev.created_at > latest.created_at) latest = ev;
                },
                oneose: () => {
                    sub.close();
                    resolve(latest);
                },
            },
        );
        setTimeout(() => { sub.close(); resolve(latest); }, timeoutMs);
    });
}

/** Preserve unset fields from the existing kind 0; only flags actually
 *  passed on the CLI overwrite the merged content. An EMPTY-string flag
 *  (`--website=`) is treated as a delete request - useful when the field
 *  was set previously and you want it gone from the published JSON, not
 *  just blanked. Without delete semantics a leftover `--website=""` in
 *  the wire format still renders as a clickable element in some clients
 *  (Primal does this), defeating the point of clearing it. */
export function mergeContent(
    existingContent: string | null,
    flags:           ProfileFields,
): Record<string, unknown> {
    let base: Record<string, unknown> = {};
    if (existingContent) {
        try { base = JSON.parse(existingContent) as Record<string, unknown>; }
        catch { base = {}; }
    }
    for (const k of KNOWN_KEYS) {
        const v = flags[k];
        if (v === undefined) continue;
        if (v === '') {
            delete base[k];
        } else {
            base[k] = v;
        }
    }
    return base;
}

async function publishWithReport(
    pool:   SimplePool,
    relays: readonly string[],
    event:  NostrEvent,
    timeoutMs: number,
): Promise<{ ok: number; fail: number; per: Record<string, string> }> {
    const promises = pool.publish([...relays], event);
    const per: Record<string, string> = {};
    let ok = 0, fail = 0;
    await Promise.all(promises.map((p, i) => {
        const url = relays[i] ?? `relay-${i}`;
        return Promise.race([
            p.then(
                ()  => { per[url] = 'ok';        ok++;   },
                err => { per[url] = 'fail: ' + String(err).slice(0, 80); fail++; },
            ),
            new Promise<void>((res) => setTimeout(() => {
                if (!(url in per)) { per[url] = 'timeout'; fail++; }
                res();
            }, timeoutMs)),
        ]);
    }));
    return { ok, fail, per };
}

async function main(): Promise<void> {
    let flags: Flags;
    try { flags = parseFlags(process.argv.slice(2)); }
    catch (err) {
        console.error('Bad args:', (err as Error).message);
        process.exit(2);
    }

    const id   = getIdentity();
    const list = relays();

    console.log('Publishing kind 0 for', id.npub);
    console.log('Relays:', list.join(', '));
    console.log('Flags :', JSON.stringify({ ...flags, secret: undefined }, null, 2));

    const pool = new SimplePool();

    let existing: NostrEvent | null = null;
    if (!flags.noFetch) {
        process.stdout.write('Fetching current kind 0 ... ');
        existing = await fetchLatestKind0(pool, id.pubkey, list, flags.timeoutMs);
        console.log(existing ? `found (created_at=${existing.created_at})` : 'none');
    }

    const merged = mergeContent(existing?.content ?? null, flags);
    const template = {
        kind:       0,
        content:    JSON.stringify(merged),
        tags:       [] as string[][],
        created_at: Math.floor(Date.now() / 1000),
    };
    const signed = finalizeEvent(template, id.secret);

    console.log('\nEvent to publish:');
    console.log(JSON.stringify({ ...signed, content: merged }, null, 2));

    if (flags.dryRun) {
        console.log('\n--dry-run: not publishing.');
        pool.close([...list]);
        process.exit(0);
    }

    const report = await publishWithReport(pool, list, signed, flags.timeoutMs);
    console.log('\nPer-relay outcome:');
    for (const [url, status] of Object.entries(report.per)) {
        console.log(`  ${url.padEnd(36)} ${status}`);
    }
    console.log(`\nPublished to ${report.ok}/${list.length} relays.`);
    pool.close([...list]);
    process.exit(report.ok > 0 ? 0 : 1);
}

// Only auto-run when invoked as a CLI; tests import this module and don't
// want the main() side effects.
const invokedDirectly = (() => {
    const entry = process.argv[1] ?? '';
    return entry.endsWith('publish-profile.ts') || entry.endsWith('publish-profile.js');
})();
if (invokedDirectly) {
    main().catch((err) => {
        console.error('fatal:', err);
        process.exit(1);
    });
}
