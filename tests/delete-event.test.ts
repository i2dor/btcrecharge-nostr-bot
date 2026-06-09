/**
 * delete-event CLI parser - pure function unit tests.
 *
 * Pins (a) event-id is required and validated as 64-hex, (b) reason is
 * optional, (c) the dry-run + timeout toggles, (d) unknown flags are
 * rejected so a typo cannot silently broadcast a deletion request for
 * the wrong event.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { parseDeleteFlags } from '../scripts/delete-event.js';

const VALID_ID = 'a'.repeat(64);

test('parseDeleteFlags: --event-id is required', () => {
    assert.throws(() => parseDeleteFlags([]), /--event-id=<64-hex> is required/);
});

test('parseDeleteFlags: --event-id must be 64 hex chars', () => {
    assert.throws(() => parseDeleteFlags(['--event-id=abc']),       /64 lowercase hex/);
    assert.throws(() => parseDeleteFlags(['--event-id=' + 'z'.repeat(64)]), /64 lowercase hex/);
});

test('parseDeleteFlags: --event-id is lowercased so case typos do not produce a different deletion', () => {
    const f = parseDeleteFlags(['--event-id=' + 'A'.repeat(64)]);
    assert.equal(f.eventId, 'a'.repeat(64));
});

test('parseDeleteFlags: --event_id (snake_case) is accepted alongside --event-id', () => {
    const f = parseDeleteFlags(['--event_id=' + VALID_ID]);
    assert.equal(f.eventId, VALID_ID);
});

test('parseDeleteFlags: --reason is optional and arbitrary text', () => {
    const f1 = parseDeleteFlags(['--event-id=' + VALID_ID]);
    assert.equal(f1.reason, undefined);
    const f2 = parseDeleteFlags(['--event-id=' + VALID_ID, '--reason=reposted by mistake']);
    assert.equal(f2.reason, 'reposted by mistake');
});

test('parseDeleteFlags: --dry-run toggles without consuming a value', () => {
    const f = parseDeleteFlags(['--event-id=' + VALID_ID, '--dry-run']);
    assert.equal(f.dryRun, true);
});

test('parseDeleteFlags: --timeout=N parses as a number', () => {
    const f = parseDeleteFlags(['--event-id=' + VALID_ID, '--timeout=4000']);
    assert.equal(f.timeoutMs, 4000);
});

test('parseDeleteFlags: unknown flag rejected (avoids silent typos broadcasting the wrong delete)', () => {
    assert.throws(() => parseDeleteFlags(['--event-id=' + VALID_ID, '--mistake=x']), /unknown flag: --mistake/);
});
