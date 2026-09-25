/**
 * The findings contract, v1 — see the findings-contract SPEC.
 *
 * This is the second tool to conform, and the clauses it was chosen to test are C-005
 * (`skipped`) and C-006 (`confidence`), because this tool already refuses to answer.
 * `INCONCLUSIVE` has always been the rule that a red test which never RAN proves nothing;
 * `skipped` is that rule with a schema.
 *
 * The mapping that matters, and it is not one-to-one:
 *
 *   commit CAUGHT        -> no finding. Nothing is wrong.
 *   commit BLIND         -> a finding, severity `warn`
 *   commit INCONCLUSIVE  -> NOT a finding. It goes to `skipped`, with the reason.
 *   case NON-DISCRIM.    -> never a finding. It is a fact about a guard, not a fault.
 *   case FLAKY           -> a finding. Runs disagreed, which is a real defect.
 *
 * `BLIND` is `warn` and not `blocker` for the same reason `unreached` has no blockers:
 * C-004 asks whether a build fails NOW, and a test that cannot catch a bug breaks
 * nothing today. It is the absence of protection. `--fail-on-blind` remains this tool's
 * own opinion, named separately, exactly as the spec now requires.
 */

import { CAUGHT, BLIND, INCONCLUSIVE, FLAKY, SKIPPED } from './verdict.mjs';

export const BLOCKER = 'blocker', WARN = 'warn', INFO = 'info';

const BLIND_COMMIT = 'CA-001';
const FLAKY_CASE = 'CA-002';
const WEAK_ON_NEW = 'CA-003';
const DOCTOR_BLOCK = 'CA-010';
const NOT_JUDGED = 'CA-900';

const envelope = (findings, skipped, target, extra = {}) => {
    const n = s => findings.filter(f => f.severity === s).length;
    return {
        contract: 1,
        tool: 'control-arm',
        version: '1.1.0',
        ran_at: new Date().toISOString(),
        target,
        findings: findings.sort((a, b) =>
            ({ blocker: 0, warn: 1, info: 2 })[a.severity] - ({ blocker: 0, warn: 1, info: 2 })[b.severity]),
        skipped,
        summary: { blocker: n(BLOCKER), warn: n(WARN), info: n(INFO), skipped: skipped.length, ...extra },
    };
};

/**
 * One commit's result -> findings and skips. Shared by `verify` and `audit`, so the two
 * cannot drift into describing the same verdict differently.
 */
export function commitRows(r, repo) {
    const findings = [], skipped = [];

    // The tool declined before it began — no test file, not a fix, nothing to replay.
    if (r.note) {
        skipped.push({
            id: NOT_JUDGED,
            reason: `${r.short} ${r.subject?.slice(0, 60) ?? ''} — ${r.note}`,
            requires: 'a commit that ships both a test and a source change',
        });
        return { findings, skipped };
    }

    const disc = (r.cases ?? []).filter(c => c.verdict === CAUGHT);
    const inc = (r.cases ?? []).filter(c => c.verdict === INCONCLUSIVE);
    const flaky = (r.cases ?? []).filter(c => c.verdict === FLAKY);

    // C-005. Every case that could not be judged is named, with its own reason — not
    // summed into a count. The reason is the useful part: "the import is missing on the
    // parent" and "the test is not green on the fix either" need different fixes.
    for (const c of inc) {
        skipped.push({
            id: NOT_JUDGED,
            reason: `${r.short} · ${c.name} — ${c.reason ?? 'could not be judged'}`,
            requires: 'a test that loads and passes on the fix, and loads on the parent',
        });
    }

    for (const c of flaky) {
        findings.push({
            id: FLAKY_CASE,
            severity: WARN,
            title: `"${c.name}" gave different answers on repeated runs`,
            observed: { what: 'the same case run more than once against the same parent',
                        where: `${c.file} · ${r.short}`,
                        value: c.reason ?? 'runs disagreed' },
            next: 'A flaky test cannot prove anything about this commit, and it will not prove anything about the next one either. Fix the flake before trusting either verdict.',
            confidence: 'observed',
            fingerprint: `${FLAKY_CASE}:${c.file}:${c.name}`,
        });
    }

    if (r.verdict === BLIND) {
        // C-006. Arm C is what separates a real gap from an artefact, and its answer is
        // exactly the confidence distinction: `open` was checked against HEAD and holds;
        // `unknown` could not be checked and must not be asserted.
        const arm = r.stillOpen ?? null;   // armC, attached by verifyCommit
        if (arm?.status === 'repaired') {
            findings.push({
                id: BLIND_COMMIT, severity: INFO,
                title: `${r.short} shipped with no test that catches it — but the gap was closed later`,
                observed: { what: 'a commit whose own tests all pass on the broken code',
                            where: r.short, value: arm.reason },
                next: 'Nothing to do. Recorded because the history is worth knowing, not because it is open.',
                confidence: 'observed',
                fingerprint: `${BLIND_COMMIT}:${r.sha}`,
            });
        } else if (arm?.status === 'unknown') {
            skipped.push({
                id: NOT_JUDGED,
                reason: `${r.short} looks BLIND, but it could not be confirmed against HEAD — ${arm.reason}`,
                requires: 'the test file to still exist at HEAD',
            });
        } else {
            findings.push({
                id: BLIND_COMMIT, severity: WARN,
                title: `No test in ${r.short} fails without the change`,
                observed: {
                    what: `${(r.cases ?? []).length} case(s) replayed against the parent commit`,
                    where: `${r.short} — ${r.subject?.slice(0, 70) ?? ''}`,
                    value: 'every case ran on the broken code and passed',
                },
                next: 'This fix shipped without a test that would have caught the bug. Add one that fails on the parent, or confirm the existing tests are regression guards and were never meant to.',
                confidence: 'observed',
                fingerprint: `${BLIND_COMMIT}:${r.sha}`,
            });
        }
    }

    // C-006 in its plainest form: a CAUGHT on new code is a real result reached against
    // absent code, so the claim is weaker than the word suggests. Say so rather than let
    // the headline drift upward for free on a feature-heavy week.
    if (r.verdict === CAUGHT && r.newCode && disc.length) {
        findings.push({
            id: WEAK_ON_NEW, severity: INFO,
            title: `${r.short} is CAUGHT, but on code that did not exist before`,
            observed: { what: `${disc.length} case(s) that fail on the parent`,
                        where: r.short,
                        value: r.kind === 'feature' ? 'conventional prefix says feature' : 'this commit only added source lines' },
            next: 'Almost any test reading a new field fails on a base that lacks it, well aimed or not. Read this as "the code is new", not as "the test is good".',
            confidence: 'inferred',
            fingerprint: `${WEAK_ON_NEW}:${r.sha}`,
        });
    }

    return { findings, skipped };
}

export function verifyEnvelope(r, { repo, sha }) {
    const { findings, skipped } = commitRows(r, repo);
    return envelope(findings, skipped, { kind: 'commit', id: repo, ref: r.sha ?? sha },
        { verdict: r.verdict ?? SKIPPED, cases: (r.cases ?? []).length });
}

export function auditEnvelope(results, { repo, since, n, seed }) {
    const findings = [], skipped = [];
    for (const r of results) {
        const rows = commitRows(r, repo);
        findings.push(...rows.findings);
        skipped.push(...rows.skipped);
    }
    const answerable = results.filter(r => r.verdict === CAUGHT || r.verdict === BLIND).length;
    const caught = results.filter(r => r.verdict === CAUGHT).length;
    return envelope(findings, skipped, { kind: 'repo', id: repo, ref: null }, {
        commits_judged: results.length,
        answerable,
        caught,
        // C-006 as a number: a rate over a handful of commits is not a rate, so the
        // denominator ships beside it and a consumer can refuse to divide.
        caught_rate: answerable ? +(caught / answerable).toFixed(3) : null,
        since, sample: n, seed,
    });
}

export function doctorEnvelope(checks, { repo }) {
    const findings = checks.filter(c => !c.ok).map(c => ({
        id: DOCTOR_BLOCK,
        severity: BLOCKER,
        title: `Cannot measure this repository: ${c.name}`,
        observed: { what: c.name, where: repo, value: c.detail },
        next: c.detail,
        confidence: 'observed',
        fingerprint: `${DOCTOR_BLOCK}:${c.name}`,
    }));
    return envelope(findings, [], { kind: 'repo', id: repo, ref: null },
        { checks: checks.length, passed: checks.filter(c => c.ok).length });
}
