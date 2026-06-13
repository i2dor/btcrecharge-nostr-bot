/**
 * One-shot CLI: publish a kind 1 text note from the bot identity.
 *
 * - Loads BOT_NSEC + NOSTR_RELAYS from the environment (same env contract
 *   as the bot proper and publish-profile.ts). Fails loudly if BOT_NSEC is
 *   missing rather than silently generating a fresh keypair.
 * - Content comes from --file=<path> (preferred for multi-line notes) or
 *   --content="..." inline. Hashtags in the text (#bitcoin) are mirrored
 *   into NIP-12 `t` tags so the note is discoverable by tag search; the
 *   hashtag text stays in the body. Disable with --no-tags.
 * - Signs with the bot's secret, broadcasts via SimplePool, reports the
 *   per-relay ack/fail outcome.
 *
 * Usage:
 *   npm run publish-note -- --file=note.txt --dry-run
 *   npm run publish-note -- --content="gm nostr #plebchain"
 *
 * Other flags: --no-tags (skip hashtag -> t-tag extraction),
 * --dry-run (print the event, do not publish),
 * --timeout=<ms> (publish window, default 8000).
 *
 * Exit codes: 0 = published to >= 1 relay (or dry-run); 1 = published to
 * 0 relays; 2 = bad invocation.
 */
import { readFileSync } from 'node:fs';

import { SimplePool, finalizeEvent, type NostrEvent } from 'nostr-tools';

import { getIdentity } from '../src/identity.js';

export interface Flags {
    content?:  string;
    file?:     string;
    noTags:    boolean;
    dryRun:    boolean;
    timeoutMs: number;
}

export function parseFlags(argv: readonly string[]): Flags {
    const out: Flags = { noTags: false, dryRun: false, timeoutMs: 8000 };
    for (const raw of argv) {
        const arg = raw.replace(/^--/, '');
        if (arg === 'dry-run') { out.dryRun = true; continue; }
        if (arg === 'no-tags') { out.noTags = true; continue; }
        const eq = arg.indexOf('=');
        if (eq < 0) {
            throw new Error(`unknown flag: --${arg} (expected --key=value)`);
        }
        const key = arg.slice(0, eq);
        const val = arg.slice(eq + 1);
        if (key === 'content')      { out.content = val; continue; }
        if (key === 'file')         { out.file = val; continue; }
        if (key === 'timeout')      { out.timeoutMs = parseInt(val, 10); continue; }
        throw new Error(`unknown flag: --${key}`);
    }
    return out;
}

/** Resolve the note body from --file or --content (file wins if both). */
export function resolveContent(flags: Flags): string {
    if (flags.file !== undefined) {
        return readFileSync(flags.file, 'utf8').replace(/\s+$/, '');
    }
    if (flags.content !== undefined) return flags.content;
    throw new Error('no content: pass --file=<path> or --content="..."');
}

/** Extract lowercased, de-duplicated hashtags from note text. A hashtag is
 *  `#` followed by a letter/underscore then word chars - so a bare `#` or a
 *  number-leading `#1` (issue refs) are ignored, matching common client
 *  behaviour. */
export function extractHashtags(text: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const re = /(?:^|\s)#([a-zA-Z_]\w*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const tag = m[1]!.toLowerCase();
        if (!seen.has(tag)) { seen.add(tag); out.push(tag); }
    }
    return out;
}

/** Build the unsigned kind 1 note template (tags from hashtags unless
 *  suppressed). Pure - exposed for tests. */
export function buildNoteTemplate(
    content: string,
    noTags: boolean,
    nowSec: number,
): { kind: number; content: string; tags: string[][]; created_at: number } {
    const tags = noTags ? [] : extractHashtags(content).map((t) => ['t', t]);
    return { kind: 1, content, tags, created_at: nowSec };
}

function relays(): readonly string[] {
    const raw = process.env['NOSTR_RELAYS']
        ?? 'wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social,wss://relay.primal.net,wss://offchain.pub';
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function publishWithReport(
    pool:   SimplePool,
    list:   readonly string[],
    event:  NostrEvent,
    timeoutMs: number,
): Promise<{ ok: number; fail: number; per: Record<string, string> }> {
    const promises = pool.publish([...list], event);
    const per: Record<string, string> = {};
    let ok = 0, fail = 0;
    await Promise.all(promises.map((p, i) => {
        const url = list[i] ?? `relay-${i}`;
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
    let content: string;
    try {
        flags = parseFlags(process.argv.slice(2));
        content = resolveContent(flags);
    } catch (err) {
        console.error('Bad args:', (err as Error).message);
        process.exit(2);
    }

    const id   = getIdentity();
    const list = relays();
    const template = buildNoteTemplate(content, flags.noTags, Math.floor(Date.now() / 1000));
    const signed   = finalizeEvent(template, id.secret);

    console.log('Publishing kind 1 note for', id.npub);
    console.log('Relays:', list.join(', '));
    console.log('Hashtag t-tags:', template.tags.map((t) => t[1]).join(', ') || '(none)');
    console.log('\nEvent to publish:');
    console.log(JSON.stringify(signed, null, 2));

    if (flags.dryRun) {
        console.log('\n--dry-run: not publishing.');
        process.exit(0);
    }

    const pool = new SimplePool();
    const report = await publishWithReport(pool, list, signed, flags.timeoutMs);
    console.log('\nPer-relay outcome:');
    for (const [url, status] of Object.entries(report.per)) {
        console.log(`  ${url.padEnd(36)} ${status}`);
    }
    console.log(`\nPublished to ${report.ok}/${list.length} relays.`);
    pool.close([...list]);
    process.exit(report.ok > 0 ? 0 : 1);
}

const invokedDirectly = (() => {
    const entry = process.argv[1] ?? '';
    return entry.endsWith('publish-note.ts') || entry.endsWith('publish-note.js');
})();
if (invokedDirectly) {
    main().catch((err) => {
        console.error('fatal:', err);
        process.exit(1);
    });
}
