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
import { classify, reduceRuns, rollUp, SKIPPED, INCONCLUSIVE } from './verdict.mjs';

const TEST_RE = /(^|\/)(tests?|__tests__|spec)\/.*\.(test|spec)\.(m?[jt]sx?)$|\.(test|spec)\.(m?[jt]sx?)$/;

export async function commitInfo(repo, sha) {
    const out = await git(repo, ['show', '--no-patch', '--format=%H%n%s%n%ad', '--date=short', sha]);
    const [full, subject, date] = out.trim().split('\n');
    const files = (await git(repo, ['show', '--name-only', '--format=', sha])).trim().split('\n').filter(Boolean);
    return {
        sha: full, short: full.slice(0, 8), subject, date,
        files,
        testFiles: files.filter(f => TEST_RE.test(f)),
        sourceFiles: files.filter(f => !TEST_RE.test(f) && /\.(m?[jt]sx?)$/.test(f)),
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
        const a = await nodeTest.execute({ worktreeDir: fixDir, relTestPath: rel, timeoutMs });
        if (!a.ok) { perFile.push({ file: rel, skip: `arm A did not run: ${a.loadFailure}` }); continue; }

        const dest = await transplant(repo, sha, rel, parentDir);
        const identity = await proveIdentity({ worktreeRoot: parentDir, testFilePath: dest });

        const runsOut = [];
        for (let i = 0; i < runs; i++) {
            const b = await nodeTest.execute({ worktreeDir: parentDir, relTestPath: rel, timeoutMs });
            runsOut.push({ b, identity });
        }
        perFile.push({ file: rel, armA: a, runs: runsOut, identity });
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
    return result;
}
