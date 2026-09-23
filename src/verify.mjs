/**
 * Orchestration: two arms, one commit.
 *
 *   ARM A   worktree @ FIX     + the fix's own test   -> must be GREEN, or there is no
 *                                                        before/after to compare
 *   ARM B   worktree @ PARENT  + the fix's test TRANSPLANTED onto the old source
 *
 * The transplant is the whole idea. You do NOT run the parent's tests — the parent does
 * not have this test. You take the new test and ask it about the old code.
 */

import path from 'node:path';
import { git, ensureWorktree, linkDependencies, transplant } from './worktree.mjs';
import { proveIdentity } from './identity.mjs';
import { nodeTest } from './runner.mjs';
import { vitest, jest } from './runner-json.mjs';
import { selectRunner } from './select-runner.mjs';

const RUNNERS = { node: nodeTest, vitest, jest };
import { classify, reduceRuns, rollUp, isDisagreement, BLIND, SKIPPED, INCONCLUSIVE } from './verdict.mjs';

/**
 * Documentation, and nothing else, is "not source".
 *
 * This used to be an ALLOWLIST of `.js/.ts/.tsx/.mjs`, and it made the tool decline the
 * one kind of change it should be best at judging. auctionmate PR #2519 wires the
 * mutation gate: it changes `stryker.conf.json` and `.github/workflows/mutation.yml`, and
 * ships `tests/mutationGateWiring.test.js` to assert that wiring. Zero JS changed, so the
 * commit read as "test-only — no source change to be blind to" and got no verdict.
 *
 * That is backwards. A guard that is installed but wired to nothing is the dominant defect
 * class in that repo — three instances found in one afternoon — and the test proving a
 * gate is armed is precisely a test that should be shown to fail without the wiring.
 * Config, CI YAML and shell ARE the source for those.
 *
 * So: deny-list the docs, accept the rest. A commit that changes only Markdown genuinely
 * has nothing to be blind to; everything else might.
 */
const DOC_RE = /\.(md|mdx|txt|rst|adoc)$/i;

const TEST_RE = /(^|\/)(tests?|__tests__|spec)\/.*\.(test|spec)\.(m?[jt]sx?)$|\.(test|spec)\.(m?[jt]sx?)$/;

export async function commitInfo(repo, sha) {
    const out = await git(repo, ['show', '--no-patch', '--format=%H%n%s%n%ad', '--date=short', sha]);
    const [full, subject, date] = out.trim().split('\n');
    const files = (await git(repo, ['show', '--name-only', '--format=', sha])).trim().split('\n').filter(Boolean);
    return {
        sha: full, short: full.slice(0, 8), subject, date,
        files,
        testFiles: files.filter(f => TEST_RE.test(f)),
        sourceFiles: files.filter(f => !TEST_RE.test(f) && !DOC_RE.test(f)),
    };
}

export async function verifyCommit({ repo, workDir, sha, runs = 1, timeoutMs = 120_000, onStep = () => {} }) {
    const info = await commitInfo(repo, sha);
    const result = { ...info, cases: [], verdict: SKIPPED, note: null };

    if (info.testFiles.length === 0) { result.note = 'no test file in the commit'; return result; }
    if (info.sourceFiles.length === 0) { result.note = 'test-only commit — no source change to be blind to'; return result; }

    const parent = (await git(repo, ['rev-parse', `${sha}^`])).trim();

    // --- ARM A -------------------------------------------------------------------------
    onStep('arm A');
    const fixDir = await ensureWorktree(repo, workDir, 'fix', sha);
    await linkDependencies(repo, fixDir);

    // --- ARM B -------------------------------------------------------------------------
    onStep('arm B');
    const parentDir = await ensureWorktree(repo, workDir, 'parent', parent);
    await linkDependencies(repo, parentDir);

    const perFile = [];
    for (const rel of info.testFiles) {
        // Chosen from the FIX worktree: the parent may predate the config file entirely,
        // and the question is which runner the test was written for.
        const { flavour, pkgDir } = await selectRunner(fixDir, rel);
        const runner = RUNNERS[flavour];
        const opts = { relTestPath: rel, pkgDir, timeoutMs };

        const a = await runner.execute({ worktreeDir: fixDir, ...opts });
        if (!a.ok) { perFile.push({ file: rel, runner: flavour, pkgDir, skip: `arm A did not run (${flavour}): ${a.loadFailure}` }); continue; }

        const dest = await transplant(repo, sha, rel, parentDir);
        const identity = await proveIdentity({ worktreeRoot: parentDir, repoRoot: repo, testFilePath: dest });

        const runsOut = [];
        for (let i = 0; i < runs; i++) {
            const b = await runner.execute({ worktreeDir: parentDir, ...opts });
            runsOut.push({ b, identity });
        }
        perFile.push({ file: rel, runner: flavour, pkgDir, armA: a, runs: runsOut, identity });
    }

    // --- verdicts ----------------------------------------------------------------------
    for (const f of perFile) {
        if (f.skip) { result.cases.push({ file: f.file, name: '(file)', verdict: INCONCLUSIVE, reason: f.skip }); continue; }
        for (const aCase of f.armA.cases) {
            const perRun = f.runs.map(({ b, identity }) => {
                if (!b.ok) return { verdict: INCONCLUSIVE, reason: `did not run on the parent: ${b.loadFailure}` };
                const bCase = b.cases.find(c => c.name === aCase.name) || null;
                return classify({ armA: aCase, armB: bCase, identity });
            });
            const final = reduceRuns(perRun);
            result.cases.push({ file: f.file, name: aCase.name, ...final });
        }
    }
    result.verdict = rollUp(result.cases);

    // --- ARM C: is this BLIND finding still open? ---------------------------------------
    if (result.verdict === BLIND) {
        result.stillOpen = await armC({ repo, parentDir, perFile, timeoutMs });
    }
    return result;
}

/**
 * ARM C — the current test against the historical bug.
 *
 * WHY THIS EXISTS, and it is the most important caveat in the tool.
 *
 * Arms A and B answer "did the test SHIPPED WITH THIS COMMIT catch its own bug". That is a
 * fact about the past and it stays true forever. It does NOT mean there is a gap today:
 * the repo may have repaired it since, and a BLIND verdict reported as an open defect is a
 * redundant ticket handed to a colleague.
 *
 * Earned 2026-09-23, by doing exactly that. auctionmate c9e46fcb shipped METER-024 with a
 * `d += 3` loop that stepped over 2026-09-06 — the date its own comment named — so it
 * could not fail on the code it was written for. True, and I recommended the one-character
 * fix to a peer about to open a PR. The stride had been `d += 1` since 2026-07-30
 * (45c4ffcc), changed because MUTATION TESTING deleted the loop body and nothing failed.
 * Stryker had found the same defect three months earlier, from the opposite direction.
 *
 * So: take the CURRENT version of the test file, put it on the parent's broken code, and
 * run it. If it fails now, the gap was repaired and the finding is history, not a ticket.
 */
async function armC({ repo, parentDir, perFile, timeoutMs }) {
    const files = perFile.filter(f => !f.skip);
    if (files.length === 0) return { status: 'unknown', reason: 'no runnable test file' };

    for (const f of files) {
        let dest;
        try { dest = await transplant(repo, 'HEAD', f.file, parentDir); }
        catch { return { status: 'unknown', reason: `${f.file} does not exist at HEAD (renamed or deleted)` }; }

        const runner = RUNNERS[f.runner] || nodeTest;
        const r = await runner.execute({ worktreeDir: parentDir, relTestPath: f.file, pkgDir: f.pkgDir, timeoutMs });
        if (!r.ok) return { status: 'unknown', reason: `current test could not run on the parent: ${r.loadFailure}` };

        const killer = r.cases.find(c => isDisagreement(c));
        if (killer) {
            return { status: 'repaired', reason: `the CURRENT "${killer.name}" fails on this bug — the gap was closed after this commit`, by: killer.name, file: f.file };
        }
    }
    return { status: 'open', reason: 'even the CURRENT tests are green on this bug — still unguarded today' };
}
