/**
 * publish-article CLI - pure helpers only.
 *
 * Pins (a) parser shape (required --file, repeatable --tag, kebab/snake
 * interop on --published-at), (b) extractTitle for the markdown H1
 * convention, (c) deriveSlug for the default-slug rule, (d) the
 * NIP-23 tag layout in buildArticleTemplate. SimplePool publishing is
 * integration and not unit tested.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
    parseArticleFlags,
    deriveSlug,
    extractTitle,
    buildArticleTemplate,
} from '../scripts/publish-article.js';

// ----- parseArticleFlags --------------------------------------------

test('parseArticleFlags: --file is required', () => {
    assert.throws(() => parseArticleFlags([]), /--file=<path> is required/);
});

test('parseArticleFlags: minimal flags parse, defaults apply', () => {
    const f = parseArticleFlags(['--file=docs/ANNOUNCEMENT.md']);
    assert.equal(f.file, 'docs/ANNOUNCEMENT.md');
    assert.equal(f.title,       undefined);
    assert.equal(f.slug,        undefined);
    assert.deepEqual(f.topics,  []);
    assert.equal(f.dryRun,      false);
});

test('parseArticleFlags: --tag is repeatable and order-preserving', () => {
    const f = parseArticleFlags(['--file=x.md', '--tag=nostr', '--tag=bitcoin', '--tag=lightning']);
    assert.deepEqual(f.topics, ['nostr', 'bitcoin', 'lightning']);
});

test('parseArticleFlags: --published-at and --published_at both work', () => {
    const a = parseArticleFlags(['--file=x.md', '--published-at=1700000000']);
    const b = parseArticleFlags(['--file=x.md', '--published_at=1700000000']);
    assert.equal(a.publishedAt, 1700000000);
    assert.equal(b.publishedAt, 1700000000);
});

test('parseArticleFlags: unknown flag rejected so typos do not silently publish the wrong content', () => {
    assert.throws(() => parseArticleFlags(['--file=x.md', '--colour=blue']), /unknown flag: --colour/);
});

// ----- deriveSlug ----------------------------------------------------

test('deriveSlug: file path -> kebab-case identifier', () => {
    assert.equal(deriveSlug('docs/ANNOUNCEMENT.md'),                  'announcement');
    assert.equal(deriveSlug('docs/PHASE-3-REFUND-FLOW.md'),           'phase-3-refund-flow');
    assert.equal(deriveSlug('some/path/My_Long_Title_2026.md'),       'my-long-title-2026');
});

// ----- extractTitle --------------------------------------------------

test('extractTitle: first H1 wins, headers after the first are ignored', () => {
    const md = '# First Heading\n\nText\n\n# Second Heading\n';
    assert.equal(extractTitle(md), 'First Heading');
});

test('extractTitle: no H1 returns undefined (caller decides to fall back or fail)', () => {
    const md = '## Only Subheading\n\nText\n';
    assert.equal(extractTitle(md), undefined);
});

test('extractTitle: H1 with trailing whitespace is trimmed', () => {
    assert.equal(extractTitle('#   Spaced Out   \n'), 'Spaced Out');
});

// ----- buildArticleTemplate ------------------------------------------

const NOW = 1781046994;

test('buildArticleTemplate: kind 30023 with d + title tags first', () => {
    const ev = buildArticleTemplate({
        content:     'Body',
        title:       'A Title',
        summary:     undefined,
        slug:        'a-title',
        image:       undefined,
        topics:      [],
        publishedAt: NOW,
        now:         NOW,
    });
    assert.equal(ev.kind, 30023);
    assert.equal(ev.tags[0]![0], 'd');
    assert.equal(ev.tags[0]![1], 'a-title');
    assert.equal(ev.tags[1]![0], 'title');
    assert.equal(ev.tags[1]![1], 'A Title');
    assert.equal(ev.content,    'Body');
});

test('buildArticleTemplate: optional summary + image only appear when supplied', () => {
    const evNo  = buildArticleTemplate({
        content: 'x', title: 't', summary: undefined, slug: 't', image: undefined,
        topics: [], publishedAt: NOW, now: NOW,
    });
    const evYes = buildArticleTemplate({
        content: 'x', title: 't', summary: 'sum', slug: 't', image: 'https://x/h.png',
        topics: [], publishedAt: NOW, now: NOW,
    });
    assert.ok(!evNo.tags.some(t => t[0] === 'summary'));
    assert.ok(!evNo.tags.some(t => t[0] === 'image'));
    assert.ok(evYes.tags.some(t => t[0] === 'summary' && t[1] === 'sum'));
    assert.ok(evYes.tags.some(t => t[0] === 'image'   && t[1] === 'https://x/h.png'));
});

test('buildArticleTemplate: topics emit one `t` tag each in input order', () => {
    const ev = buildArticleTemplate({
        content: 'x', title: 't', summary: undefined, slug: 't', image: undefined,
        topics:  ['nostr', 'bitcoin', 'lightning'],
        publishedAt: NOW, now: NOW,
    });
    const tTags = ev.tags.filter(t => t[0] === 't').map(t => t[1]);
    assert.deepEqual(tTags, ['nostr', 'bitcoin', 'lightning']);
});

test('buildArticleTemplate: published_at is a stringified unix seconds value (NIP-23 spec)', () => {
    const ev = buildArticleTemplate({
        content: 'x', title: 't', summary: undefined, slug: 't', image: undefined,
        topics: [], publishedAt: 1700000000, now: NOW,
    });
    const pa = ev.tags.find(t => t[0] === 'published_at');
    assert.ok(pa);
    assert.equal(pa![1], '1700000000');
});
