/**
 * publish-note CLI helpers - pure functions only.
 *
 * The signing + SimplePool publish path is integration and is not unit
 * tested. We pin (a) flag parsing (boolean flags, key=value, unknown-key
 * rejection), (b) hashtag -> t-tag extraction (the behaviour that makes a
 * note discoverable), and (c) the note template shape.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
    parseFlags,
    extractHashtags,
    buildNoteTemplate,
    resolveContent,
} from '../scripts/publish-note.js';

test('parseFlags: booleans, key=value, defaults', () => {
    const f = parseFlags(['--content=hi', '--dry-run', '--no-tags', '--timeout=2000']);
    assert.equal(f.content, 'hi');
    assert.equal(f.dryRun, true);
    assert.equal(f.noTags, true);
    assert.equal(f.timeoutMs, 2000);
});

test('parseFlags: defaults when flags omitted', () => {
    const f = parseFlags(['--file=note.txt']);
    assert.equal(f.file, 'note.txt');
    assert.equal(f.dryRun, false);
    assert.equal(f.noTags, false);
    assert.equal(f.timeoutMs, 8000);
});

test('parseFlags: unknown flag rejected', () => {
    assert.throws(() => parseFlags(['--bogus=1']), /unknown flag/);
    assert.throws(() => parseFlags(['--standalone']), /expected --key=value/);
});

test('extractHashtags: lowercases, dedupes, ignores bare # and number-leading', () => {
    assert.deepEqual(
        extractHashtags('gm #Nostr #bitcoin #BITCOIN #plebchain # #1 end'),
        ['nostr', 'bitcoin', 'plebchain'],
    );
    assert.deepEqual(extractHashtags('no tags here'), []);
});

test('buildNoteTemplate: kind 1, hashtags become t-tags, content preserved', () => {
    const tmpl = buildNoteTemplate('hello #lightning #nostr', false, 1_700_000_000);
    assert.equal(tmpl.kind, 1);
    assert.equal(tmpl.content, 'hello #lightning #nostr');
    assert.equal(tmpl.created_at, 1_700_000_000);
    assert.deepEqual(tmpl.tags, [['t', 'lightning'], ['t', 'nostr']]);
});

test('buildNoteTemplate: --no-tags suppresses t-tags', () => {
    const tmpl = buildNoteTemplate('hello #lightning', true, 1_700_000_000);
    assert.deepEqual(tmpl.tags, []);
});

test('resolveContent: inline content; missing source throws', () => {
    assert.equal(resolveContent({ content: 'hi', noTags: false, dryRun: false, timeoutMs: 8000 }), 'hi');
    assert.throws(
        () => resolveContent({ noTags: false, dryRun: false, timeoutMs: 8000 }),
        /no content/,
    );
});
