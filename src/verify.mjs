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
import { git, ensureWorktree, linkDependencies, linkEnvFiles, transplant } from './worktree.mjs';
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
 * one kind of change it should be best at judging. A real PR wired a mutation-testing
 * gate: it changed a tool config and a CI workflow, and shipped a test asserting that
 * wiring. Zero JS changed, so the commit read as "test-only — no source change to be
 * blind to" and got no verdict.
 *
 * That is backwards. A guard that is installed but wired to nothing is the dominant defect
 * class in many repos — three instances found in one afternoon — and the test proving a
 * gate is armed is precisely a test that should be shown to fail without the wiring.
 * Config, CI YAML and shell ARE the source for those.
 *
 * So: deny-list the docs, accept the rest. A commit that changes only Markdown genuinely
 * has nothing to be blind to; everything else might.
 */
const DOC_RE = /\.(md|mdx|txt|rst|adoc)$/i;

/**
 * Files no unit test can exercise, however good the suite is.
 *
 * A `fix(ios):` commit repairing an aborted CocoaPods install came back as a still-open
 * BLIND. It is not a finding. A dependency-resolution failure is caught by a BUILD, and
 * asking whether a unit test would have caught it is a category error. Reporting it as a gap teaches the reader that the tool does not know
 * what a test is for.
 *
 * Deliberately narrow: only manifests and project files for toolchains that build rather
 * than run. A .json or .yml can absolutely be under test — a CI-wiring test asserts a
 * workflow file — so those are NOT here.
 */
const BUILD_ONLY_RE = /(^|\/)(Podfile(\.lock)?|Gemfile(\.lock)?|Cartfile.*|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.pbxproj|.*\.xcworkspacedata|.*\.xcscheme|.*\.gradle(\.kts)?|gradle\.properties|.*\.plist|.*\.podspec|.*\.lock)$/i;

/**
 * KNOWN LIMIT, stated rather than papered over: build-time JAVASCRIPT is not detectable
 * by filename. One such commit changed `apps/mobile/plugins/withModularHeaders.js` — an
 * Expo config plugin that runs at BUILD time, spelled exactly like runtime source. Webpack/vite/rollup configs and codegen
 * scripts are the same shape.
 *
 * A heuristic wide enough to catch those (path contains "plugins", "scripts", "config")
 * would also exclude real application code, and a FALSE EXCLUSION is worse than a false
 * inclusion here: it hides a finding silently, where a category error is at least visible
 * and arguable. So these reach a verdict and need human triage. The audit's subject
 * filter catches most of them in practice, because they are usually scoped fix(ios),
 * fix(build) or similar.
 */

/**
 * What counts as a test file.
 *
 * TWO independent signals, because projects pick one or the other and a tool that demands
 * both measures nothing:
 *
 *   1. a `.test.` / `.spec.` suffix anywhere      (most application repos)
 *   2. living under a test directory              (undici, node core, most library repos)
 *
 * This used to require BOTH — a file under `tests/` AND a `.test.` suffix. Run against
 * nodejs/undici, whose tests are `test/client-request.js` with no suffix, the tool
 * reported "284 commits matched, 0 ship both a test and a source change" and produced an
 * entirely empty audit. Not a wrong answer: NO answer, on a repo with 261 fix commits
 * that ship tests.
 *
 * Found the first time it was pointed at a codebase its author did not write, which is
 * the whole argument for doing that before believing any number it prints.
 */
const TEST_DIR_RE = /(^|\/)(tests?|__tests__|spec|specs)\//i;
const TEST_SUFFIX_RE = /\.(test|spec)\.(m?[jt]sx?)$/i;
const CODE_RE = /\.(m?[jt]sx?)$/i;
const TEST_RE = (f) => CODE_RE.test(f) && (TEST_SUFFIX_RE.test(f) || TEST_DIR_RE.test(f));

export async function commitInfo(repo, sha, against = null) {
    const out = await git(repo, ['show', '--no-patch', '--format=%H%n%s%n%ad', '--date=short', sha]);
    const [full, subject, date] = out.trim().split('\n');
    // With a base, the changed set is the WHOLE branch, not just the tip commit — a PR's
    // test may have arrived in commit 1 and its source change in commit 3.
    const files = against
        ? (await git(repo, ['diff', '--name-only', `${(await git(repo, ['merge-base', against, sha])).trim()}...${sha}`])).trim().split('\n').filter(Boolean)
        : (await git(repo, ['show', '--name-only', '--format=', sha])).trim().split('\n').filter(Boolean);
    return {
        sha: full, short: full.slice(0, 8), subject, date,
        files,
        testFiles: files.filter(f => TEST_RE(f)),
        sourceFiles: files.filter(f => !TEST_RE(f) && !DOC_RE.test(f)),
    };
}

/**
 * `against` turns this from a commit check into a PR check, and the distinction matters.
 *
 * By default the "broken" side is the commit's own parent — right for auditing history,
 * where each fix is judged against the bug it fixed.
 *
 * A PR is different. A real PR landed a follow-up commit whose parent ALREADY contained
 * the change under test — so commit-vs-parent compares the branch to itself and every
 * case reads non-discriminating, and a sound PR looks unproven. The question a PR gate asks is
 * "does this test fail WITHOUT THIS BRANCH", so the base is the MERGE BASE of the branch
 * and its target, never the target's tip: develop moves, and diffing against a moved tip
 * drags in everyone else's changes and attributes them here.
 */
export async function verifyCommit({ repo, workDir, sha, against = null, runs = 1, timeoutMs = 120_000, onStep = () => {} }) {
    const info = await commitInfo(repo, sha, against);
    const result = { ...info, cases: [], verdict: SKIPPED, note: null };

    if (info.testFiles.length === 0) { result.note = 'no test file in the commit'; return result; }
    if (info.sourceFiles.length === 0) { result.note = 'test-only commit — no source change to be blind to'; return result; }
    if (info.sourceFiles.every(f => BUILD_ONLY_RE.test(f))) {
        result.note = 'build-only change (lockfiles / project files) — a build catches this, not a unit test';
        return result;
    }

    const parent = against
        ? (await git(repo, ['merge-base', against, sha])).trim()
        : (await git(repo, ['rev-parse', `${sha}^`])).trim();

    // --- ARM A -------------------------------------------------------------------------
    onStep('arm A');
    const fixDir = await ensureWorktree(repo, workDir, 'fix', sha);
    await linkDependencies(repo, fixDir);
    await linkEnvFiles(repo, fixDir);

    // --- ARM B -------------------------------------------------------------------------
    onStep('arm B');
    const parentDir = await ensureWorktree(repo, workDir, 'parent', parent);
    await linkDependencies(repo, parentDir);
    await linkEnvFiles(repo, parentDir);

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
 * Earned by doing exactly that. A commit shipped a property-based test whose loop stepped
 * over the very date its own comment named as the bug, so it could not fail on the code it
 * was written for. True — and the one-character fix was recommended to a colleague who was
 * about to open a PR for it. The stride had already been corrected three months earlier,
 * by MUTATION TESTING, which deleted the loop body and saw nothing fail. A different
 * instrument had found the same defect from the opposite direction.
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
