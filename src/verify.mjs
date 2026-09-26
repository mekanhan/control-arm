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
import { analyseCase } from './assertions.mjs';
import { vitest, jest } from './runner-json.mjs';
import { selectRunner } from './select-runner.mjs';

const RUNNERS = { node: nodeTest, vitest, jest };
import { classify, reduceRuns, rollUp, isDisagreement, BLIND, NON_DISCRIMINATING, SKIPPED, INCONCLUSIVE } from './verdict.mjs';

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
// What arm B may carry over from the fix: things a test can actually LOAD. Restricted after
// the first run copied PNG screenshots out of docs/ into the worktree — pointless, and
// `transplant` writes through a string, so a binary would arrive corrupted anyway.
const LOADABLE_RE = /\.(m?[jt]sx?|json|ya?ml|sql|csv|graphql|snap)$/i;
/**
 * TYPE tests — `.test-d.ts`, `.test-types.ts`, and the tsd/expect-type conventions.
 *
 * These assert about the TYPE SYSTEM and are run by a typechecker, not by executing the
 * file. This tool cannot run one, and — far worse — did not even recognise one as a test.
 *
 * FOUND ON A PUBLIC REPOSITORY (remeda, 2026-09-26) and it inverted the answer:
 *
 *     fix(startsWith, endsWith): reject disjoint literal prefixes at compile time
 *       endsWith.test-d.ts      439 +++    <- the actual guard, ignored
 *       endsWith.test.ts         16 +-     <- judged instead, correctly unchanged
 *
 * The fix was type-level, so the runtime tests pass on both arms — as they should. The
 * tool called that BLIND: an accusation, about a repository whose tests are fine, with the
 * real guard sitting right there in the commit unread. Across ten such commits it reported
 * 75% BLIND where the truthful answer is "I cannot judge type-level fixes".
 *
 * So a commit whose test changes are type tests is now INCONCLUSIVE, by the same rule that
 * a skipped case blocks BLIND: a guard we cannot see is not a guard that is absent.
 */
const TYPE_TEST_RE = /\.(test-d|test-types|type-test|types\.test)\.(m?tsx?)$|\.d\.test\.tsx?$/i;

export const isTypeTest = (f) => TYPE_TEST_RE.test(f);

const TEST_RE = (f) => CODE_RE.test(f) && (TEST_SUFFIX_RE.test(f) || TEST_DIR_RE.test(f) || TYPE_TEST_RE.test(f));

/**
 * A "fix" whose source change is entirely comments.
 *
 * Found auditing auctionmate 2026-09-25: `fix(web): correct the framing — this was LIVE
 * mispricing, not a dormant enum risk` came back BLIND and read as an open defect. Its one
 * source hunk changes only a comment block — it corrects how an earlier fix was WRITTEN UP.
 * There is no behaviour that differs from the parent, so no test could tell the two apart,
 * and BLIND is not merely unhelpful there, it is wrong: it accuses a test of missing a bug
 * that does not exist in the diff.
 *
 * The bias is deliberate. A line that is not clearly a comment makes the commit judgeable,
 * because a false "comment-only" HIDES a finding, while a missed decline only costs a
 * verdict on something harmless.
 */
const HASH_COMMENT_EXT = /\.(py|rb|sh|bash|zsh|ya?ml|toml|tf|pl|r|jl)$/i;
const DASH_COMMENT_EXT = /\.(sql|lua|hs|adb|ads)$/i;
const XML_COMMENT_EXT = /\.(html?|xml|svg|vue|svelte)$/i;

export function isCommentOrBlank(file, raw) {
    const line = raw.trim();
    if (line === '') return true;
    if (XML_COMMENT_EXT.test(file) && (line.startsWith('<!--') || line.startsWith('-->'))) return true;
    if (HASH_COMMENT_EXT.test(file)) return line.startsWith('#');
    if (DASH_COMMENT_EXT.test(file) && line.startsWith('--')) return true;
    // C-family, including JSX's {/* … */}. `*` must be followed by space or end of line, or
    // `*ptr = 0;` would read as a comment.
    if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*/')
        || line.startsWith('{/*') || line.startsWith('*/}')) return true;
    return /^\*(\s|$)/.test(line);
}

/**
 * Does this test text reach any file the commit MODIFIED?
 *
 * Only asked when arm B needed files the commit ADDED in order to load at all. If the test
 * names nothing the commit modified, the most likely reading is that it tests the new code
 * the commit introduced — and the bug lives in the modified lines, which such a test never
 * touches. Calling that BLIND would accuse a test of missing a bug it was never pointed at,
 * which is this tool's worst possible output.
 *
 * Deliberately crude, and deliberately biased toward "yes, it reaches". A false "reaches"
 * costs a BLIND that a human then dismisses; a false "does not reach" silently drops a real
 * finding. Matching is on the module basename, so an indirect import through a barrel file
 * is missed — that direction is the safe one.
 */
export function testReachesModified(testSrc, modifiedFiles) {
    for (const f of modifiedFiles) {
        const base = f.split('/').pop().replace(/\.[^.]+$/, '');
        if (base.length < 3) continue;
        if (new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(testSrc)) return true;
    }
    return false;
}

/** True when EVERY changed line in every source file is a comment or blank. */
export function diffIsCommentOnly(diffText) {
    let sawAChangedLine = false;
    let file = '';
    for (const line of diffText.split('\n')) {
        if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
        if (line.startsWith('diff --git ')) {
            const m = line.match(/ b\/(.+)$/);
            file = m ? m[1] : '';
            continue;
        }
        if (line.startsWith('+') || line.startsWith('-')) {
            sawAChangedLine = true;
            if (!isCommentOrBlank(file, line.slice(1))) return false;
        }
    }
    // No changed lines at all (a pure rename or mode change) is not a comment-only fix —
    // let the normal path decide, rather than declining something unexamined.
    return sawAChangedLine;
}

/**
 * IS THIS A REPAIR, OR IS IT NEW CODE? — and why the answer changes what CAUGHT means.
 *
 * On a BUG FIX the base is the broken code, so a test that fails there genuinely
 * discriminates: it would have caught the bug. That is the case this tool was built for.
 *
 * On a FEATURE the base is code where the thing does not exist yet. Essentially ANY test
 * touching the new code fails there — the import is missing, the field is absent, a count
 * is zero. `expected 0 to be greater than 0` is a real AssertionError, correctly
 * classified, and says nothing whatever about whether the test is well aimed. A test
 * asserting `expect(1).toBe(1)` in the same file would NOT have been CAUGHT; essentially
 * any test reading the new field would. The signal comes from the field's existence, not
 * from the test's design.
 *
 * This is the mirror of the INCONCLUSIVE rule. That one says a red test that never RAN
 * proves nothing; this one says a red test that ran against ABSENT CODE proves nearly as
 * little. Counting them together lets the headline drift upward for free on a
 * feature-heavy week, and a number that drifts for free is one people stop reading.
 *
 * MEASURED, because both signals are proxies and only one is any good:
 *   conventional prefix   1,213 fix / 988 feat in one real corpus — used consistently
 *   source additions-only  9 of 28 feat commits, but also 1 of 35 fix commits —
 *                          specific, not sensitive; a supporting hint, never the verdict
 *
 * So this labels the CLAIM and never silently reclassifies a verdict. CAUGHT on a feature
 * is still CAUGHT — it just does not get to say "this would have caught the bug", because
 * there was no bug.
 */
export function commitKind(subject, sourceAddedOnly) {
    const m = String(subject).match(/^\s*([a-z]+)\s*(\([^)]*\))?\s*!?:/i);
    const prefix = m ? m[1].toLowerCase() : null;
    if (prefix === 'fix' || prefix === 'bug' || prefix === 'perf') {
        // A fix that only ADDED source is worth flagging: its test may be reading
        // something that simply was not there, exactly like a feature's.
        return { kind: 'fix', newCode: !!sourceAddedOnly, prefix };
    }
    if (prefix === 'feat' || prefix === 'feature') return { kind: 'feature', newCode: true, prefix };
    if (prefix) return { kind: 'other', newCode: !!sourceAddedOnly, prefix };
    return { kind: 'unknown', newCode: !!sourceAddedOnly, prefix: null };
}

/**
 * `withDiffStat` is OFF by default, and that default is load-bearing.
 *
 * The additions-only signal needs `git show --numstat` — one subprocess per commit. The
 * audit calls commitInfo on EVERY candidate just to test eligibility (1,178 of them on one
 * real corpus), so computing it unconditionally pushed the selection pass past 70 minutes
 * BEFORE a single commit was judged. Measured, not estimated: that run was killed at 72.
 *
 * Only the commits actually verified need it, so verifyCommit asks and the eligibility
 * pass does not. A regression introduced by the fix for issue #3, and caught by noticing a
 * run sit in "selecting commits" for over an hour rather than by any test.
 */
export async function commitInfo(repo, sha, against = null, withDiffStat = false) {
    const out = await git(repo, ['show', '--no-patch', '--format=%H%n%s%n%ad', '--date=short', sha]);
    const [full, subject, date] = out.trim().split('\n');
    // Computed once. It was resolved inline twice before, and the name-status call below
    // would have made it three.
    const mergeBase = against ? (await git(repo, ['merge-base', against, sha])).trim() : null;
    // With a base, the changed set is the WHOLE branch, not just the tip commit — a PR's
    // test may have arrived in commit 1 and its source change in commit 3.
    // `--name-only` lists a RENAMED file under BOTH its old and new path, and a DELETED
    // file under a path that no longer exists at this commit. Treating the old path as a
    // test file the commit ships means `git show <sha>:<old path>` throws later — which
    // took the entire run down with a stack trace instead of reporting anything at all.
    //
    // Found on a real commit that renamed profitBarHelp.test.ts to .tsx.
    const deletedOut = await git(repo,
        against ? ['diff', '--name-status', '--diff-filter=D', mergeBase + '...' + sha]
                : ['show', '--name-status', '--diff-filter=D', '--format=', sha]).catch(() => '');
    const deleted = new Set(deletedOut.trim().split('\n')
        .map(l => l.split(/\t/).pop())
        .filter(Boolean));

    const files = (against
        ? (await git(repo, ['diff', '--name-only', `${mergeBase}...${sha}`])).trim().split('\n').filter(Boolean)
        : (await git(repo, ['show', '--name-only', '--format=', sha])).trim().split('\n').filter(Boolean)
    ).filter(f => !deleted.has(f));
    // Deletions in non-test source: a repair usually changes lines, new code only adds.
    const numstat = !withDiffStat ? '' : against
        ? await git(repo, ['diff', '--numstat', `${mergeBase}...${sha}`])
        : await git(repo, ['show', '--numstat', '--format=', sha]);
    let srcDeletions = 0;
    for (const line of numstat.trim().split('\n')) {
        const [, del, file] = line.split(/\t/).length === 3 ? ['', ...line.split(/\t/).slice(1)] : [];
        const parts = line.split(/\t/);
        if (parts.length !== 3) continue;
        const [, d, f] = parts;
        if (TEST_RE(f) || DOC_RE.test(f)) continue;
        if (/^\d+$/.test(d)) srcDeletions += Number(d);
    }
    const kindInfo = commitKind(subject, srcDeletions === 0);

    // ADDED vs MODIFIED matters for arm B. A file the commit ADDED did not exist at the
    // parent, so putting it there cannot un-break anything — the behavioural repair lives in
    // the lines of MODIFIED files, which arm B must keep in their broken state.
    const nameStatus = !withDiffStat ? '' : against
        ? await git(repo, ['diff', '--name-status', `${mergeBase}...${sha}`]).catch(() => '')
        : await git(repo, ['show', '--name-status', '--format=', sha]).catch(() => '');
    const added = [], modified = [];
    for (const line of nameStatus.trim().split('\n')) {
        const parts = line.split(/\t/);
        if (parts.length < 2) continue;
        const [st, f] = [parts[0], parts[parts.length - 1]];
        if (TEST_RE(f) || DOC_RE.test(f)) continue;
        if (st.startsWith('A')) added.push(f);
        else if (st.startsWith('M') || st.startsWith('R')) modified.push(f);
    }

    return {
        sha: full, short: full.slice(0, 8), subject, date,
        ...kindInfo, srcDeletions,
        files,
        testFiles: files.filter(f => TEST_RE(f)),
        sourceFiles: files.filter(f => !TEST_RE(f) && !DOC_RE.test(f)),
        addedSourceFiles: added,
        modifiedSourceFiles: modified,
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
    const info = await commitInfo(repo, sha, against, true);
    const result = { ...info, cases: [], verdict: SKIPPED, note: null };

    if (info.testFiles.length === 0) { result.note = 'no test file in the commit'; return result; }
    if (info.sourceFiles.length === 0) { result.note = 'test-only commit — no source change to be blind to'; return result; }
    if (info.sourceFiles.every(f => BUILD_ONLY_RE.test(f))) {
        result.note = 'build-only change (lockfiles / project files) — a build catches this, not a unit test';
        return result;
    }

    // A comment-only source change has no behaviour to be blind to. Judging it produces a
    // BLIND that reads as an open defect and is not one — measured on auctionmate, where
    // one of four "still open" findings was a commit that reworded a comment block.
    {
        const args = against
            ? ['diff', `${(await git(repo, ['merge-base', against, sha])).trim()}...${sha}`]
            : ['diff', `${sha}^`, sha];
        const srcDiff = await git(repo, [...args, '--', ...info.sourceFiles]).catch(() => '');
        if (srcDiff && diffIsCommentOnly(srcDiff)) {
            result.note = 'comment-only source change — the behaviour is identical to the parent, so no test could tell them apart';
            return result;
        }
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

    // ── files the commit ADDED go onto the parent too ─────────────────────────────────
    //
    // Measured on 300 auctionmate fix commits: 82 came back INCONCLUSIVE, and 39 of those
    // — nearly half — failed for one reason. The test imports a FILE the commit added, so
    // at the parent the module graph cannot even be built and every case in the file dies
    // at link time. 1,020 cases were lost this way across just 206 (commit, file) pairs;
    // one unresolvable import takes a whole file down, and the biggest took 41 cases with
    // it.
    //
    // A file the commit ADDED did not exist at the parent, so nothing at the parent can
    // depend on it and putting it there cannot un-break anything. The repair lives in the
    // lines of MODIFIED files, and those stay exactly as the parent left them — which is
    // what keeps arm B a picture of the bug.
    //
    // The asymmetry this rests on: after the transplant a test that FAILS on arm B has
    // failed on an assertion about the parent's behaviour, which is trustworthy. A test
    // that PASSES might simply never reach a modified file — so that direction is guarded
    // below rather than reported as BLIND.
    const transplantedAdded = [];
    for (const rel of (info.addedSourceFiles || []).filter(f => LOADABLE_RE.test(f))) {
        try {
            await transplant(repo, sha, rel, parentDir);
            transplantedAdded.push(rel);
        } catch {
            // Unreadable at the fix (submodule, symlink, binary) — arm B just stays as it
            // was, which is the pre-existing behaviour.
        }
    }
    result.transplantedAdded = transplantedAdded;

    const perFile = [];
    for (const rel of info.testFiles) {
        // A TYPE test asserts about the type system and is checked by a typechecker, not by
        // executing the file. Skipping it silently is what made a type-level fix look BLIND
        // while its 439-line guard sat unread in the same commit.
        if (isTypeTest(rel)) {
            perFile.push({
                file: rel, runner: 'typecheck', pkgDir: '',
                skip: 'a TYPE test — asserted against the type system, not by running the file. '
                    + 'control-arm cannot run one, so this commit cannot be judged: the guard exists '
                    + 'and is simply not visible to this method.',
            });
            continue;
        }

        // Chosen from the FIX worktree: the parent may predate the config file entirely,
        // and the question is which runner the test was written for.
        const { flavour, pkgDir } = await selectRunner(fixDir, rel);
        const runner = RUNNERS[flavour];

        // DECLINE BY NAME. A runner we do not have must say which one it is, and must not
        // be attempted with a different one. Running a Playwright spec under node:test
        // produced `arm A did not run (node): test failed`, which blames the author's test
        // for the tool's own gap — the worst kind of wrong message, because it is
        // actionable and points at the wrong thing.
        if (!runner) {
            perFile.push({
                file: rel, runner: flavour, pkgDir,
                skip: `no ${flavour} runner — this file is a ${flavour} test and control-arm cannot execute it. `
                    + `Supported today: node:test, vitest, jest.`,
            });
            continue;
        }

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
    // The fix's own copy of each test file, read ONCE per file rather than once per case:
    // the assertion analysis needs the source, and a 40-case file would otherwise re-read
    // it forty times.
    const sourceOf = new Map();
    for (const f of perFile) {
        if (f.skip) continue;
        try { sourceOf.set(f.file, await git(repo, ['show', `${sha}:${f.file}`])); } catch { /* unreadable */ }
    }

    for (const f of perFile) {
        if (f.skip) { result.cases.push({ file: f.file, name: '(file)', verdict: INCONCLUSIVE, reason: f.skip }); continue; }
        for (const aCase of f.armA.cases) {
            const perRun = f.runs.map(({ b, identity }) => {
                if (!b.ok) return { verdict: INCONCLUSIVE, reason: `did not run on the parent: ${b.loadFailure}` };
                const bCase = b.cases.find(c => c.name === aCase.name) || null;
                return classify({ armA: aCase, armB: bCase, identity });
            });
            const final = reduceRuns(perRun);
            // WHY is this case weak — attached only where the answer is useful. A CAUGHT
            // case needs no explanation (it did its job) and an INCONCLUSIVE one already
            // carries its reason, so the note goes on the cases a reader would otherwise
            // have to open the file to understand.
            let why = null;
            const src = sourceOf.get(f.file);
            if (src && final.verdict === NON_DISCRIMINATING) {
                const a = analyseCase(src, aCase.name);
                if (a.verdict === 'weak' && a.findings.length) why = a.findings[0].note;
                else if (a.verdict === 'suspect' && a.findings.length) why = `${a.findings[0].note} — but it also asserts an exact value, so it may still be sound`;
                else if (a.verdict === 'strong') why = 'asserts an exact expected value — most likely a deliberate regression guard';
            }
            result.cases.push({ file: f.file, name: aCase.name, ...final, ...(why ? { why } : {}) });
        }
    }
    result.verdict = rollUp(result.cases);

    // A BLIND that only became reachable by transplanting added files needs one more
    // question answered: does the test go anywhere near what the commit actually changed?
    // If it names nothing the commit modified, it is testing the new code, and BLIND would
    // be an accusation rather than a finding. CAUGHT is left alone — a test that FAILED on
    // the parent has failed on the parent's behaviour, however it got there.
    if (result.verdict === BLIND && (result.transplantedAdded || []).length) {
        const mods = info.modifiedSourceFiles || [];
        let reaches = mods.length === 0;
        for (const f of perFile) {
            if (reaches) break;
            try {
                reaches = testReachesModified(await git(repo, ['show', `${sha}:${f.file}`]), mods);
            } catch { /* unreadable — leave `reaches` alone */ }
        }
        if (!reaches) {
            result.verdict = INCONCLUSIVE;
            result.note = 'arm B could only load with files this commit ADDED, and the test names '
                + 'nothing it modified — most likely a test for the new code, not for the bug';
        }
    }

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
