/**
 * The vitest/jest adapter, at the level where it can actually be wrong.
 *
 * WHAT THIS DOES AND DOES NOT COVER — stated because the gap matters.
 *
 * The node:test path has 9 end-to-end fixtures: real git repos, both arms, known verdict.
 * These two runners do NOT, because a fixture would have to `npm install` vitest or jest
 * per repo — slow, network-dependent, and version-drifting. The full two-arm path for
 * each is verified on ONE real commit apiece — a vitest component commit and a jest
 * React Native commit — which is a smoke test, not a control arm.
 *
 * So this file covers the part that is BOTH untested end-to-end AND most likely to be
 * wrong: the text-matching in `classifyMessages`. node:test hands over `ERR_ASSERTION`;
 * these two give formatted strings, so the adapter has to read prose. Every string below
 * is a real shape emitted by vitest or jest, not an invented one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMessages, parseReport } from '../src/runner-json.mjs';

const isDisagreement = m => classifyMessages(m).code === 'ERR_ASSERTION';
const isCannotRun = m => classifyMessages(m).code === 'ERR_TEST_FAILURE';
const isUnknown = m => classifyMessages(m).code === null;

test('vitest/chai disagreement is read as an assertion', () => {
    assert.ok(isDisagreement(["AssertionError: expected 'Urgent' to deeply equal 'Normal'"]));
    assert.ok(isDisagreement(['AssertionError: expected 40 to be 65 // Object.is equality']));
});

test('jest/expect disagreement is read as an assertion', () => {
    assert.ok(isDisagreement(['expect(received).toBe(expected) // Object.is equality\n\nExpected: "Normal"\nReceived: "Urgent"']));
    assert.ok(isDisagreement(['Error: expect(received).toEqual(expected)\n\n- Expected\n+ Received']));
});

test('a module that could not load is NOT an assertion', () => {
    assert.ok(isCannotRun(["Error: Cannot find module '../src/newHelper' from 'lib/__tests__/x.test.tsx'"]));
    assert.ok(isCannotRun(["SyntaxError: The requested module './bucket.js' does not provide an export named 'SEP'"]));
    assert.ok(isCannotRun(['Error: Failed to resolve import "./notYet" from "lib/x.test.tsx". Does the file exist?']));
    assert.ok(isCannotRun(['TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".tsx"']));
});

test('CANNOT-RUN WINS when both shapes appear — the ordering that matters', () => {
    // A failed module load frequently ALSO prints an expect() frame from the stack. If
    // the disagreement patterns were checked first, this would read CAUGHT, and a commit
    // whose test never ran would be credited with catching its bug.
    const both = ['SyntaxError: does not provide an export named \'SEP\'\n  at expect(received).toBe(expected)\n  expected \'a\' to be \'b\''];
    assert.ok(isCannotRun(both), 'a load failure that also prints an expect() frame must not read as a disagreement');
    assert.notEqual(classifyMessages(both).code, 'ERR_ASSERTION');
});

test('an UNRECOGNISED message is unknown — never guessed into an assertion', () => {
    // This is the design: an unrecognised shape costs COVERAGE (it reads INCONCLUSIVE),
    // it cannot manufacture a finding. A drifting regex must fail safe, not fail loud.
    assert.ok(isUnknown(['Something entirely unexpected happened in a custom matcher']));
    assert.ok(isUnknown([]));
    assert.ok(isUnknown(['']));
    assert.notEqual(classifyMessages(['whatever']).code, 'ERR_ASSERTION');
});

test('CONTROL ARM: a naive "any failure is a disagreement" classifier gets these wrong', () => {
    // TEST-001 — run the broken implementation and assert it still reproduces the bug.
    const naive = msgs => (msgs && msgs.length ? 'ERR_ASSERTION' : null);
    const loadFail = ["Error: Cannot find module '../src/newHelper'"];
    assert.equal(naive(loadFail), 'ERR_ASSERTION');              // the naive one says CAUGHT
    assert.equal(classifyMessages(loadFail).code, 'ERR_TEST_FAILURE');  // ours says it never ran
    const weird = ['custom matcher blew up'];
    assert.equal(naive(weird), 'ERR_ASSERTION');
    assert.equal(classifyMessages(weird).code, null);
});

// --- parseReport: mapping a real runner JSON onto normalised cases ---
// The two-arm path for vitest/jest has no end-to-end fixture (it would `npm install` a
// runner per repo), but the report PARSING — the part that can silently mislabel a
// verdict — is pure and pinned here against captured shapes.

test('parseReport: pass / fail / skip map to normalised cases', () => {
    const report = {
        testResults: [{
            assertionResults: [
                { fullName: 'maps HIGH-PRIORITY to 1', status: 'passed', failureMessages: [] },
                { fullName: 'maps LOW to 3', status: 'failed', failureMessages: ['AssertionError: expected 2 to deeply equal 3'] },
                { title: 'a skipped case', status: 'pending', failureMessages: [] },
            ],
        }],
    };
    const r = parseReport(report);
    assert.equal(r.ok, true);
    assert.deepEqual(r.cases.map(c => c.status), ['pass', 'fail', 'skip']);
    assert.equal(r.cases[1].code, 'ERR_ASSERTION');   // a disagreement, not a load error
    assert.equal(r.cases[2].name, 'a skipped case');  // title is the fullName fallback
});

test('parseReport: a file that failed to compile is a load failure, not zero cases', () => {
    const report = { testResults: [{ message: '  ● Test suite failed to run\n\n    SyntaxError: does not provide an export named SEP', assertionResults: [] }] };
    const r = parseReport(report);
    assert.equal(r.ok, false);
    assert.match(r.loadFailure, /Test suite failed to run/);
    assert.deepEqual(r.cases, []);
});

test('parseReport: an empty report is a load failure — never BLIND-by-absence', () => {
    assert.equal(parseReport({ testResults: [] }).ok, false);
    assert.equal(parseReport({}).ok, false);
    assert.equal(parseReport({ testResults: [{ assertionResults: [] }] }).ok, false);
});

