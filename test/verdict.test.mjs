/**
 * The decision logic, exhaustively, with no git and no subprocesses.
 *
 * Every case here is a shape observed in a real run, not an invented one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, reduceRuns, rollUp, isDisagreement, CAUGHT, BLIND, NON_DISCRIMINATING, INCONCLUSIVE, FLAKY, SKIPPED } from '../src/verdict.mjs';

const pass = { status: 'pass' };
const assertFail = { status: 'fail', code: 'ERR_ASSERTION', errorName: 'AssertionError', message: '"CERT OF TITLE-PRIOR-SALVAGE" resolved to Salvage' };
const errFail = { status: 'fail', code: 'ERR_TEST_FAILURE', errorName: 'SyntaxError', message: "does not provide an export named 'TITLE_SEPARATOR'" };

test('CAUGHT: green on the fix, assertion-red on the parent', () => {
    assert.equal(classify({ armA: pass, armB: assertFail }).verdict, CAUGHT);
});

test('NON-DISCRIMINATING: green on the fix AND green on the parent', () => {
    assert.equal(classify({ armA: pass, armB: pass }).verdict, NON_DISCRIMINATING);
});

test('a case green on both arms is never called BLIND — a regression guard is indistinguishable', () => {
    // Observed in practice: 3 of one commit's 4 cases were deliberate regression guards.
    assert.notEqual(classify({ armA: pass, armB: pass }).verdict, BLIND);
});

test('a non-assertion failure on the parent is INCONCLUSIVE, never CAUGHT — the test never ran', () => {
    const r = classify({ armA: pass, armB: errFail });
    assert.equal(r.verdict, INCONCLUSIVE);
    assert.match(r.reason, /never ran/);
});

test('exit code alone would have gotten that wrong', () => {
    // Both of these are "the process exited non-zero". Only one is a verdict.
    assert.equal(classify({ armA: pass, armB: assertFail }).verdict, CAUGHT);
    assert.equal(classify({ armA: pass, armB: errFail }).verdict, INCONCLUSIVE);
});

test('unproven module identity withholds the verdict even when arm B passed', () => {
    // THE false-BLIND guard. Arm B green + identity unproven is precisely the symlink
    // trap that made this tool report a false BLIND before it had an identity gate.
    const r = classify({ armA: pass, armB: pass, identity: { proven: false, reason: 'resolved OUTSIDE the worktree' } });
    assert.equal(r.verdict, INCONCLUSIVE);
    assert.notEqual(r.verdict, BLIND);
});

test('a case that is red on the fix is INCONCLUSIVE — the commit does not stand up', () => {
    assert.equal(classify({ armA: assertFail, armB: assertFail }).verdict, INCONCLUSIVE);
});

test('a case missing from the parent run is INCONCLUSIVE, not BLIND', () => {
    assert.equal(classify({ armA: pass, armB: null }).verdict, INCONCLUSIVE);
});

test('isDisagreement is narrow: an unknown error name is not guessed into CAUGHT', () => {
    assert.equal(isDisagreement({ status: 'fail', errorName: 'WeirdCustomError' }), false);
    assert.equal(isDisagreement({ status: 'fail', errorName: 'JestAssertionError' }), true);
});

test('FLAKY: runs that disagree between CAUGHT and BLIND', () => {
    const r = reduceRuns([{ verdict: CAUGHT }, { verdict: NON_DISCRIMINATING }, { verdict: CAUGHT }]);
    assert.equal(r.verdict, FLAKY);
});

test('an INCONCLUSIVE run does not erase a decided one, but is disclosed', () => {
    const r = reduceRuns([{ verdict: CAUGHT, reason: 'assertion' }, { verdict: INCONCLUSIVE, reason: 'timeout' }, { verdict: CAUGHT, reason: 'assertion' }]);
    assert.equal(r.verdict, CAUGHT);
    assert.match(r.reason, /1 of 3 runs inconclusive/);
});

test('rollUp: one discriminating case carries the commit, guards and all', () => {
    assert.equal(rollUp([{ verdict: NON_DISCRIMINATING }, { verdict: NON_DISCRIMINATING }, { verdict: CAUGHT }]), CAUGHT);
});

test('rollUp: a SKIPPED case blocks BLIND — it might have been the discriminating one', () => {
    // Observed: all four tests written FOR a bug were { skip: SKIP } on a host with no
    // TEST_DATABASE_URL, while older cases in the same file ran and did not discriminate.
    // Calling that blind judges the commit on the tests NOT written for it.
    assert.equal(rollUp([{ verdict: NON_DISCRIMINATING }, { verdict: SKIPPED }]), INCONCLUSIVE);
    assert.equal(rollUp([{ verdict: NON_DISCRIMINATING }, { verdict: NON_DISCRIMINATING }, { verdict: SKIPPED }]), INCONCLUSIVE);
});

test('rollUp: BLIND only when every case ran and NOT ONE discriminated', () => {
    assert.equal(rollUp([{ verdict: NON_DISCRIMINATING }, { verdict: NON_DISCRIMINATING }]), BLIND);
    // one case could not be judged -> the commit cannot be called blind
    assert.equal(rollUp([{ verdict: NON_DISCRIMINATING }, { verdict: INCONCLUSIVE }]), INCONCLUSIVE);
});

test('CONTROL ARM: a verdict engine that only read exit codes fails these', () => {
    // TEST-001 — the old, naive implementation, executed here, asserted to still be wrong.
    const naive = ({ armB }) => (armB && armB.status === 'fail' ? CAUGHT : BLIND);
    assert.equal(naive({ armB: errFail }), CAUGHT);                       // it says CAUGHT...
    assert.equal(classify({ armA: pass, armB: errFail }).verdict, INCONCLUSIVE);  // ...we say no
    assert.equal(naive({ armB: pass }), BLIND);   // and calls every regression guard blind                            // and it cannot see
    assert.equal(classify({ armA: pass, armB: pass, identity: { proven: false, reason: 'x' } }).verdict, INCONCLUSIVE);
});
