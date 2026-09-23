/**
 * The decision. Pure functions only — no git, no filesystem, no subprocesses.
 *
 * This file is deliberately the only place a verdict is decided, and deliberately
 * has no I/O, because it is the part that has to be exhaustively tested. Everything
 * else in this tool is plumbing that produces its two inputs.
 *
 * THE FIVE VERDICTS
 *
 *   CAUGHT              the case ran on the broken code and DISAGREED with it (assertion)
 *   NON-DISCRIMINATING  the case ran and was fine with it  (case level — a fact, not a fault)
 *   BLIND               NO case in the commit discriminated (commit level — a judgement)
 *   INCONCLUSIVE  the case did not run, or we cannot prove what it ran against
 *   FLAKY         repeated runs disagreed with each other
 *   SKIPPED       there was nothing to judge
 *
 * WHY EXIT CODE IS NOT THE SIGNAL. A test that "fails" at the parent commit with
 * `SyntaxError: does not provide an export named 'TITLE_SEPARATOR'` — because the fix
 * ADDED that export — has a non-zero exit and has told you nothing: it never ran. Read
 * exit code only and you report CAUGHT, and the tool's headline number is inflated
 * garbage. Observed on auctionmate 8cf7301a, 2026-09-23.
 *
 * WHY A FALSE `BLIND` IS THE WORST OUTPUT. CAUGHT and INCONCLUSIVE are both survivable
 * — one is good news, the other is an honest shrug. BLIND accuses an engineer of having
 * written a test that cannot fail. Get that wrong and nobody trusts the tool again. So
 * every ambiguity resolves AWAY from BLIND, never toward it.
 */

export const CAUGHT = 'CAUGHT';
/**
 * CASE level. The case ran on the broken code and was fine with it.
 *
 * NOT a synonym for "bad test", and renamed from BLIND on 2026-09-23 after the first real
 * run said this about auctionmate 8cf7301a:
 *
 *     ✗ BLIND   TITLE-022 CONTROL ARM: the whitespace-only patterns really do split ...
 *     ✗ BLIND   TITLE-022: the prefix test survives the wider separators ...
 *     ✗ BLIND   TITLE-022: the brands the separator change must not touch
 *
 * All three are REGRESSION GUARDS. They are supposed to be green on both arms — that is
 * their entire job. Calling them blind is a false accusation of a careful engineer, which
 * is the one output that destroys trust in this tool.
 *
 * Red/green cannot distinguish "meant to catch this bug and failed" from "meant to stay
 * green". That is INTENT, and the tool cannot read it. So the case level states the FACT
 * (it did not discriminate) and the judgement is made only where it is safe: at the
 * commit, where a fix in which NOTHING discriminates shipped no test that could catch its
 * own bug, whatever each case was for.
 */
export const NON_DISCRIMINATING = 'NON-DISCRIMINATING';
/** COMMIT level only: every case ran, and not one of them discriminated. */
export const BLIND = 'BLIND';
export const INCONCLUSIVE = 'INCONCLUSIVE';
export const FLAKY = 'FLAKY';
export const SKIPPED = 'SKIPPED';

/**
 * Did this failure come from the test DISAGREEING, or from it being unable to run?
 *
 * node:test TAP puts `name: 'AssertionError'` / `code: 'ERR_ASSERTION'` on the first and
 * a real error name (ReferenceError, SyntaxError, TypeError) on the second. Other runners
 * differ; `runners/*.mjs` maps them onto this same shape, which is why this predicate
 * takes a normalised case and not raw output.
 */
export function isDisagreement(caseResult) {
    if (!caseResult || caseResult.status !== 'fail') return false;
    if (caseResult.code === 'ERR_ASSERTION') return true;
    if (caseResult.errorName === 'AssertionError') return true;
    // Assertion libraries that are not node:assert. Narrow on purpose: an unknown error
    // name must fall through to INCONCLUSIVE, not be guessed into CAUGHT.
    return ['JestAssertionError', 'ExpectationFailed', 'AssertionFailedError'].includes(caseResult.errorName);
}

/**
 * One case, one run. `armA` is the case on the FIXED code, `armB` the same case
 * transplanted onto the BROKEN (parent) code.
 *
 * `identity` is the proof that armB actually loaded the parent's modules. It is a hard
 * gate before anything else, because without it a BLIND is indistinguishable from a
 * harness that silently resolved the fixed code — which is exactly what happened on the
 * first real run of this tool.
 */
export function classify({ armA, armB, identity }) {
    if (identity && identity.proven === false) {
        return { verdict: INCONCLUSIVE, reason: `module identity unproven: ${identity.reason}` };
    }
    if (!armA) return { verdict: SKIPPED, reason: 'case not present on the fix' };

    // The fix must be green, or there is no "before and after" to compare. A red case on
    // the fix means the commit does not stand on its own — not that the test is bad.
    if (armA.status !== 'pass') {
        return { verdict: INCONCLUSIVE, reason: `case is not green on the fix (${armA.errorName || armA.status})` };
    }
    // The case exists on the fix but never reported on the parent: the file failed to
    // load, or the runner died before reaching it.
    if (!armB) {
        return { verdict: INCONCLUSIVE, reason: 'case did not report on the parent (file failed to load?)' };
    }
    if (armB.status === 'pass') {
        return { verdict: NON_DISCRIMINATING, reason: 'green on the broken code (a regression guard looks identical here)' };
    }
    if (isDisagreement(armB)) {
        return { verdict: CAUGHT, reason: armB.message || 'assertion failed on the broken code' };
    }
    return {
        verdict: INCONCLUSIVE,
        reason: `case errored rather than failed on the parent (${armB.errorName || armB.code || 'unknown'}) — it never ran`,
    };
}

/**
 * N runs of the same case. Disagreement between runs is its own verdict: a case that is
 * CAUGHT twice and BLIND once has told you nothing about the fix and something important
 * about the test.
 *
 * INCONCLUSIVE does not outvote a real result — an infra hiccup on run 2 should not erase
 * a clean CAUGHT from runs 1 and 3 — but a CAUGHT/BLIND split is FLAKY, always.
 */
export function reduceRuns(results) {
    if (results.length === 0) return { verdict: SKIPPED, reason: 'no runs' };
    const decided = results.filter(r => r.verdict === CAUGHT || r.verdict === NON_DISCRIMINATING);
    if (decided.length === 0) return results[0];

    const distinct = new Set(decided.map(r => r.verdict));
    if (distinct.size > 1) {
        const tally = decided.map(r => r.verdict).join(', ');
        return { verdict: FLAKY, reason: `runs disagreed: ${tally}` };
    }
    if (decided.length < results.length) {
        const d = decided[0];
        return { ...d, reason: `${d.reason} (${results.length - decided.length} of ${results.length} runs inconclusive)` };
    }
    return decided[0];
}

/** Commit-level roll-up. A commit is CAUGHT if ANY of its cases discriminates. */
export function rollUp(caseVerdicts) {
    if (caseVerdicts.length === 0) return SKIPPED;
    const has = v => caseVerdicts.some(c => c.verdict === v);
    if (has(CAUGHT)) return CAUGHT;
    if (has(FLAKY)) return FLAKY;
    // Every case ran and none discriminated: the commit shipped tests that its own bug
    // would have walked past.
    if (caseVerdicts.every(c => c.verdict === NON_DISCRIMINATING || c.verdict === SKIPPED) && has(NON_DISCRIMINATING)) return BLIND;
    return INCONCLUSIVE;
}
