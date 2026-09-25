/**
 * The short-draw warning (#10) — the dayjs incident, pinned.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleWarning } from '../src/sample-warning.mjs';

const dayjs = {
    requested: 40, matched: 6, eligible: 5, drawn: 5,
    since: '12 months ago', sinceWasExplicit: false,
};

test('SAMPLE-001: the dayjs run warns, and names the default window as the cause', () => {
    const w = sampleWarning(dayjs);
    assert.ok(w, 'a 5-of-40 draw must warn');
    assert.match(w, /asked for 40 commits, drew 5/);
    assert.match(w, /DEFAULT window/);
    assert.match(w, /--since/);

    // CONTROL ARM: the shipped behaviour. Before this existed, the same inputs produced
    // nothing at all, and the run printed a confident 100% over five commits.
    const shipped = () => null;
    assert.equal(shipped(dayjs), null, 'the old code must still say nothing');
});

test('SAMPLE-002: a FULL draw is silent — the warning must not fire on healthy runs', () => {
    // A warning that fires on every run is noise, and noise gets switched off.
    assert.equal(sampleWarning({ ...dayjs, matched: 190, eligible: 99, drawn: 40 }), null);
    assert.equal(sampleWarning({ requested: 1, matched: 1, eligible: 1, drawn: 1, since: '12 months ago' }), null);
});

test('SAMPLE-003: an EXPLICIT --since is not blamed on the default', () => {
    const w = sampleWarning({ ...dayjs, since: '6 years', sinceWasExplicit: true });
    assert.ok(w, 'still short, so still warns');
    assert.doesNotMatch(w, /DEFAULT window/, 'the user chose this window — do not lecture them about it');
    assert.doesNotMatch(w, /--since '6 years'/, 'do not suggest the flag they just passed');
});

test('SAMPLE-004: when the WINDOW held enough, the pre-filter is named instead', () => {
    // 200 commits matched, but only 12 ship both a test and a source change. Widening
    // --since is the wrong advice here; saying so would send someone down a dead end.
    const w = sampleWarning({ requested: 40, matched: 200, eligible: 12, drawn: 12, since: '12 months ago' });
    assert.match(w, /only 12 ship both a test and a/);
    assert.doesNotMatch(w, /DEFAULT window/);
});

test('SAMPLE-005: nothing matched at all is said plainly', () => {
    const w = sampleWarning({ requested: 40, matched: 0, eligible: 0, drawn: 0, since: '12 months ago' });
    assert.match(w, /Nothing matched the subject filter/);
    // An empty audit printed "Total: 0" and read as a clean bill of health on undici.
    assert.match(w, /is not a rate/);
});

test('SAMPLE-006: singular/plural reads correctly at one commit', () => {
    const w = sampleWarning({ requested: 40, matched: 1, eligible: 1, drawn: 1, since: '12 months ago' });
    assert.match(w, /over 1 commit is not a rate/);
    assert.doesNotMatch(w, /1 commits/);
});
