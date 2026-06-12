/**
 * Publish a NIP-23 long-form note (kind 30023) signed with the bot's NSEC.
 *
 * NIP-23 events are "parameterized replaceable" - the tuple
 * (pubkey, kind, d-tag) uniquely identifies an article. Re-publishing
 * with the same `d` tag REPLACES the prior version across all
 * compliant relays + clients. There is no need to delete the previous
 * version explicitly.
 *
 * Usage:
 *   npm run publish-article -- \
 *     --file=docs/ANNOUNCEMENT.md \
 *     --title="The first Nostr DM bot for international mobile top-ups" \
 *     --summary="DM the bot, pay a Lightning invoice, the recipient's phone is topped up in seconds." \
 *     --slug=first-nostr-mobile-topup-bot \
 *     --image=https://nostr.build/i/<header>.png \
 *     --tag=nostr --tag=bitcoin --tag=lightning --tag=mobile-topups
 *
 *   # Dry-run prints the signed event without publishing.
 *   npm run publish-article -- --file=docs/ANNOUNCEMENT.md --dry-run
 *
 * Defaults:
 *   --title         first H1 (`# Heading`) found in the file
 *   --slug          basename of --file, lowercased, kebab-cased
 *   --published-at  current unix timestamp
 *
 * Tag conventions for clients (Habla / Yakihonne / Highlighter):
 *   `d`            stable identifier; same d-tag = same article slot
 *   `title`        shown as headline
 *   `summary`      shown as TLDR / preview
 *   `image`        header / hero image URL
 *   `published_at` unix seconds; some clients use this rather than created_at
 *   `t`            topic tag, repeatable
 */
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { SimplePool, finalizeEvent, type NostrEvent, type EventTemplate } from 'nostr-tools';

import { getIdentity } from '../src/identity.js';

export interface ArticleFlags {
    file:        string;
    title:       string | undefined;
    summary:     string | undefined;
    slug:        string | undefined;
    image:       string | undefined;
    topics:      string[];
    publishedAt: number | undefined;
    dryRun:      boolean;
    timeoutMs:   number;
}

export function parseArticleFlags(argv: readonly string[]): ArticleFlags {
    let file:        string | undefined;
    let title:       string | undefined;
    let summary:     string | undefined;
    let slug:        string | undefined;
    let image:       string | undefined;
    const topics:    string[] = [];
    let publishedAt: number | undefined;
    let dryRun       = false;
    let timeoutMs    = 8000;

    for (const raw of argv) {
        const arg = raw.replace(/^--/, '');
        if (arg === 'dry-run') { dryRun = true; continue; }
        const eq = arg.indexOf('=');
        if (eq < 0) throw new Error(`unknown flag: --${arg} (expected --key=value)`);
        const key = arg.slice(0, eq);
        const val = arg.slice(eq + 1);
        switch (key) {
            case 'file':         file        = val; break;
            case 'title':        title       = val; break;
            case 'summary':      summary     = val; break;
            case 'slug':         slug        = val; break;
            case 'image':        image       = val; break;
            case 'tag':          topics.push(val);  break;
            case 'published-at':
            case 'published_at': publishedAt = parseInt(val, 10); break;
            case 'timeout':      timeoutMs   = parseInt(val, 10); break;
            default:             throw new Error(`unknown flag: --${key}`);
        }
    }
    if (!file) throw new Error('--file=<path> is required');
    return { file, title, summary, slug, image, topics, publishedAt, dryRun, timeoutMs };
}

/** Derive a kebab-case slug from a file path. `docs/MY-POST.md` -> `my-post`. */
export function deriveSlug(filePath: string): string {
    const base = basename(filePath, extname(filePath));
    return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** First H1 (`# heading`) in the markdown content, trimmed. */
export function extractTitle(markdown: string): string | undefined {
    const m = markdown.match(/^#\s+(.+?)\s*$/m);
    return m ? m[1] : undefined;
}

/**
 * Build the unsigned event template the script will hand to finalizeEvent.
 *
 * Tag order is the NIP-23 convention - `d` first so any client that
 * scans for the identifier finds it without iterating; the rest follow
 * in the order most clients render them.
 */
export function buildArticleTemplate(args: {
    content:     string;
    title:       string;
    summary:     string | undefined;
    slug:        string;
    image:       string | undefined;
    topics:      readonly string[];
    publishedAt: number;
    now:         number;
}): EventTemplate {
    const tags: string[][] = [
        ['d',            args.slug],
        ['title',        args.title],
    ];
    if (args.summary) tags.push(['summary', args.summary]);
    if (args.image)   tags.push(['image',   args.image]);
    tags.push(['published_at', String(args.publishedAt)]);
    for (const t of args.topics) tags.push(['t', t]);

    return {
        kind:       30023,
        content:    args.content,
        tags,
        created_at: args.now,
    };
}

function relays(): readonly string[] {
    const raw = process.env['NOSTR_RELAYS']
        ?? 'wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social,wss://relay.primal.net,wss://offchain.pub';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

async function publishWithReport(
    pool:   SimplePool,
    list:   readonly string[],
    event:  NostrEvent,
    timeoutMs: number,
): Promise<{ ok: number; per: Record<string, string> }> {
    const promises = pool.publish([...list], event);
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
            }, timeoutMs)),
        ]);
    }));
    return { ok, per };
}

async function main(): Promise<void> {
    let flags: ArticleFlags;
    try { flags = parseArticleFlags(process.argv.slice(2)); }
    catch (err) {
        console.error('Bad args:', (err as Error).message);
        console.error('Usage: npm run publish-article -- --file=<path> [--title=...] [--slug=...] [--summary=...] [--image=...] [--tag=topic ...] [--dry-run]');
        process.exit(2);
    }

    const content = await readFile(flags.file, 'utf8');
    const title   = flags.title ?? extractTitle(content);
    if (!title) {
        console.error('Could not determine title - file has no H1 and no --title was passed.');
        process.exit(2);
    }
    const slug        = flags.slug ?? deriveSlug(flags.file);
    const now         = Math.floor(Date.now() / 1000);
    const publishedAt = flags.publishedAt ?? now;

    const id   = getIdentity();
    const list = relays();

    console.log('Publishing kind 30023 from', id.npub);
    console.log('File   :', flags.file, `(${content.length} chars)`);
    console.log('Title  :', title);
    console.log('Slug   :', slug);
    console.log('Topics :', flags.topics.join(', ') || '(none)');
    console.log('Relays :', list.join(', '));

    const template = buildArticleTemplate({
        content,
        title,
        summary: flags.summary,
        slug,
        image:   flags.image,
        topics:  flags.topics,
        publishedAt,
        now,
    });
    const signed = finalizeEvent(template, id.secret);

    console.log('\nEvent (sans content):');
    console.log(JSON.stringify({ ...signed, content: `<${content.length} chars>` }, null, 2));

    if (flags.dryRun) {
        console.log('\n--dry-run: not publishing.');
        process.exit(0);
    }

    const pool   = new SimplePool();
    const report = await publishWithReport(pool, list, signed, flags.timeoutMs);
    console.log('\nPer-relay outcome:');
    for (const [url, status] of Object.entries(report.per)) {
        console.log(`  ${url.padEnd(36)} ${status}`);
    }
    console.log(`\nPublished to ${report.ok}/${list.length} relays.`);
    console.log('\nThe article is now addressable as:');
    console.log(`  naddr -> kind=30023, pubkey=${id.npub}, d=${slug}`);
    console.log('Long-form clients (Habla, Yakihonne, Highlighter) discover it via the relays above.');
    pool.close([...list]);
    process.exit(report.ok > 0 ? 0 : 1);
}

const invokedDirectly = (() => {
    const entry = process.argv[1] ?? '';
    return entry.endsWith('publish-article.ts') || entry.endsWith('publish-article.js');
})();
if (invokedDirectly) {
    main().catch((err) => {
        console.error('fatal:', err);
        process.exit(1);
    });
}
