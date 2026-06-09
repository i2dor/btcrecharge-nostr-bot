/**
 * publish-profile CLI helpers - pure functions only.
 *
 * The fetch + publish paths are SimplePool integration and are not unit
 * tested. We pin (a) the CLI parser shape (kebab/snake-case, boolean
 * flags, unknown-key rejection) and (b) the merge semantics (unset CLI
 * args preserve existing content, set ones overwrite).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { parseFlags, mergeContent } from '../scripts/publish-profile.js';

// ----- parseFlags ----------------------------------------------------

test('parseFlags: --picture + --banner populate the matching fields', () => {
    const f = parseFlags(['--picture=https://x/a.png', '--banner=https://x/b.png']);
    assert.equal(f.picture, 'https://x/a.png');
    assert.equal(f.banner,  'https://x/b.png');
    assert.equal(f.dryRun,  false);
    assert.equal(f.noFetch, false);
});

test('parseFlags: --display-name (kebab) is accepted as display_name (snake)', () => {
    const f = parseFlags(['--display-name=btcrecharge bot']);
    assert.equal(f.display_name, 'btcrecharge bot');
});

test('parseFlags: --dry-run + --no-fetch toggle the side-effect flags', () => {
    const f = parseFlags(['--dry-run', '--no-fetch']);
    assert.equal(f.dryRun,  true);
    assert.equal(f.noFetch, true);
});

test('parseFlags: --timeout=4000 parses as a number', () => {
    const f = parseFlags(['--timeout=4000']);
    assert.equal(f.timeoutMs, 4000);
});

test('parseFlags: unknown profile field is rejected (avoids silent typos)', () => {
    assert.throws(() => parseFlags(['--colour=blue']), /unknown profile field: colour/);
});

test('parseFlags: positional arg without = is rejected', () => {
    assert.throws(() => parseFlags(['--something']), /expected --key=value/);
});

// ----- mergeContent --------------------------------------------------

test('mergeContent: with no existing content, returns just the CLI flags', () => {
    const merged = mergeContent(null, { picture: 'https://x/a.png' });
    assert.deepEqual(merged, { picture: 'https://x/a.png' });
});

test('mergeContent: CLI fields overwrite existing fields of the same name', () => {
    const existing = JSON.stringify({
        name:        'btcrecharge bot',
        picture:     'https://OLD/a.png',
        banner:      'https://OLD/b.png',
        nip05:       'bot@btcrecharge.com',
    });
    const merged = mergeContent(existing, {
        picture: 'https://NEW/a.png',
        banner:  'https://NEW/b.png',
    });
    assert.equal(merged.name,    'btcrecharge bot');    // preserved
    assert.equal(merged.nip05,   'bot@btcrecharge.com'); // preserved
    assert.equal(merged.picture, 'https://NEW/a.png');   // overwritten
    assert.equal(merged.banner,  'https://NEW/b.png');   // overwritten
});

test('mergeContent: malformed existing JSON falls back to a clean slate (no throw)', () => {
    const merged = mergeContent('this is not json', { picture: 'https://x/a.png' });
    assert.deepEqual(merged, { picture: 'https://x/a.png' });
});

test('mergeContent: empty flags + existing content returns the existing content verbatim', () => {
    const existing = JSON.stringify({ name: 'bot', picture: 'https://x/a.png' });
    const merged   = mergeContent(existing, {});
    assert.deepEqual(merged, { name: 'bot', picture: 'https://x/a.png' });
});
