#!/usr/bin/env node
/**
 * ca — does a test actually fail on the code it was written to catch?
 *
 *   ca doctor  [--repo .]                     can this repo be measured at all?
 *   ca verify  <commit> [--repo .] [--runs 3] one commit, per-case verdicts
 *   ca audit   [--repo .] [--n 100] [--since '12 months'] [--grep '^fix'] [--out f.csv]
 */

import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { git, removeWorktrees } from '../src/worktree.mjs';
import { verifyCommit, commitInfo } from '../src/verify.mjs';
import { CAUGHT, BLIND, INCONCLUSIVE, FLAKY, SKIPPED } from '../src/verdict.mjs';
import { renderVerify, renderAudit, MARK } from '../src/report.mjs';
import { renderHtml, issueBody } from '../src/html-report.mjs';
import { prComment } from '../src/markdown-report.mjs';
import { analyseCase, extractCase } from '../src/assertions.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = n => argv.includes(`--${n}`);
const repo = path.resolve(flag('repo', process.cwd()));
const workDir = path.resolve(flag('work', path.join(repo, '.ca-work')));

function die(msg, code = 2) { console.error(`ca: ${msg}`); process.exit(code); }

async function doctor() {
    const checks = [];
    const ok = (name, detail) => checks.push({ ok: true, name, detail });
    const no = (name, detail) => checks.push({ ok: false, name, detail });

    try { await git(repo, ['rev-parse', '--git-dir']); ok('git repository', repo); }
    catch { no('git repository', `${repo} is not a git repo`); }

    try {
        const dirty = (await git(repo, ['status', '--porcelain'])).trim();
        // Not a blocker — we never touch the user's tree — but worth saying out loud.
        dirty ? ok('working tree', `${dirty.split('\n').length} uncommitted change(s) — untouched, we use worktrees`)
              : ok('working tree', 'clean');
    } catch { no('working tree', 'could not read status'); }

    try {
        const n = (await git(repo, ['rev-list', '--count', 'HEAD'])).trim();
        ok('history', `${Number(n).toLocaleString()} commits`);
    } catch { no('history', 'no commits'); }

    let pkg = null;
    try { pkg = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(repo, 'package.json'), 'utf8')); } catch {}
    pkg ? ok('package.json', pkg.name || '(unnamed)') : no('package.json', 'not found — only node:test repos are supported today');

    try {
        await (await import('node:fs/promises')).lstat(path.join(repo, 'node_modules'));
        ok('node_modules', 'present — will be linked into worktrees');
    } catch { no('node_modules', 'missing — run install first, or arm B cannot resolve imports'); }

    if (pkg?.workspaces) {
        checks.push({ ok: true, name: 'workspaces', detail: `${[].concat(pkg.workspaces).join(', ')} — workspace links will be re-pointed into the worktree (this is the trap that produces false BLIND)` });
    }

    const w = 22;
    console.log(`\n  ca doctor — ${repo}\n`);
    for (const c of checks) console.log(`  ${c.ok ? MARK.ok : MARK.no} ${c.name.padEnd(w)} ${c.detail}`);
    const bad = checks.filter(c => !c.ok);
    console.log(bad.length ? `\n  ${bad.length} blocker(s).\n` : `\n  Ready.\n`);
    process.exit(bad.length ? 1 : 0);
}

async function verify() {
    const sha = argv[1];
    if (!sha || sha.startsWith('--')) die('usage: ca verify <commit>');
    const runs = Number(flag('runs', 1));
    const r = await verifyCommit({ repo, workDir, sha, against: flag('against'), runs, timeoutMs: Number(flag('timeout', 120_000)),
        onStep: s => process.stderr.write(`\r  … ${s}      `) });
    process.stderr.write('\r' + ' '.repeat(40) + '\r');
    if (has('pr-comment')) console.log(prComment(r, { repoName: flag('repo', '.') }));
    else console.log(renderVerify(r));
    if (!has('keep')) await removeWorktrees(repo, workDir);
    process.exit(r.verdict === BLIND ? 1 : 0);
}

async function audit() {
    const n = Number(flag('n', 100));
    const since = flag('since', '12 months ago');
    const grep = new RegExp(flag('grep', '^(fix|bug)'), 'i');
    // `fix(test): ...` commits repair the TEST. Asking "did the test catch the bug" when
    // the bug WAS the test is a category error, and it produces confident nonsense:
    // Two such commits surfaced as still-open BLIND and neither is a finding. Measured
    // contamination in one real repo: 12 of 1,209 (~1%) — small, but it lands squarely in
    // the headline column. Opt back in with --include-test-fixes.
    const dropTestFixes = !has('include-test-fixes');
    const TEST_FIX = /^(fix|bug)\s*\((test|tests|ci|build|chore)\)/i;
    const seed = Number(flag('seed', 1));
    const runs = Number(flag('runs', 1));

    process.stderr.write(`  selecting commits (since ${since}, /${grep.source}/) …\n`);
    const log = await git(repo, ['log', `--since=${since}`, '--format=%H|%s', '--no-merges']);
    let candidates = log.trim().split('\n').map(l => { const i = l.indexOf('|'); return { sha: l.slice(0, i), subject: l.slice(i + 1) }; })
        .filter(c => grep.test(c.subject))
        .filter(c => !(dropTestFixes && TEST_FIX.test(c.subject)));

    // Cheap pre-filter: only commits that ship BOTH a test and a source change can be judged.
    const eligible = [];
    for (const c of candidates) {
        const info = await commitInfo(repo, c.sha);
        if (info.testFiles.length && info.sourceFiles.length) eligible.push(info);
    }
    process.stderr.write(`  ${candidates.length} matched the subject filter · ${eligible.length} ship both a test and a source change\n`);

    // Deterministic pseudo-random draw. NOT the newest N, and not a set anyone chose —
    // a sample you picked cannot measure coverage.
    let s = seed >>> 0 || 1;
    const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const pool = [...eligible];
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const sample = pool.slice(0, n);
    process.stderr.write(`  drawing ${sample.length} at random (seed ${seed})\n\n`);

    const results = [];
    const t0 = Date.now();
    for (const [i, info] of sample.entries()) {
        const el = ((Date.now() - t0) / 1000).toFixed(0);
        process.stderr.write(`\r  [${String(i + 1).padStart(3)}/${sample.length}] ${el}s  ${info.short} ${info.subject.slice(0, 64).padEnd(64)}`);
        try {
            results.push(await verifyCommit({ repo, workDir, sha: info.sha, runs, timeoutMs: Number(flag('timeout', 120_000)) }));
        } catch (e) {
            results.push({ ...info, cases: [], verdict: INCONCLUSIVE, note: `harness error: ${String(e.message).slice(0, 160)}` });
        }
    }
    process.stderr.write('\r' + ' '.repeat(120) + '\r');

    console.log(renderAudit(results, { since, n: sample.length, eligible: eligible.length, matched: candidates.length, seed, seconds: (Date.now() - t0) / 1000 }));

    const htmlOut = flag('html');
    if (htmlOut) {
        const blind = results.filter(r => r.verdict === BLIND || r.stillOpen);
        const answerable = results.filter(r => r.verdict === CAUGHT || r.verdict === BLIND).length;
        const caught = results.filter(r => r.verdict === CAUGHT).length;
        let slug = 'OWNER/REPO';
        try {
            const url = (await git(repo, ['remote', 'get-url', 'origin'])).trim();
            const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)/); if (m) slug = m[1];
        } catch { /* no remote: the links still render, pointed at a placeholder */ }
        const html = renderHtml({
            repoSlug: slug, repoName: repo,
            findings: blind.map(r => ({ sha: r.sha, date: r.date, subject: r.subject, verdict: r.verdict,
                stillOpen: r.stillOpen?.status?.toUpperCase(),
                cases: r.cases.filter(c => c.verdict !== 'SKIPPED').map(c => ({ verdict: c.verdict, name: c.name, why: c.why })) })),
            meta: { repo: path.basename(repo), n: sample.length, seed, when: new Date().toISOString().slice(0, 10),
                caught, blind: results.filter(r => r.verdict === BLIND).length,
                inconclusive: results.filter(r => r.verdict === INCONCLUSIVE).length,
                pct: answerable ? ((caught / answerable) * 100).toFixed(1) : '—' },
        });
        await writeFile(path.resolve(htmlOut), html);
        console.log(`  HTML report: ${path.resolve(htmlOut)}\n`);
    }

    const out = flag('out');
    if (out) {
        const esc = v => `"${String(v ?? '').replace(/"/g, '""').replace(/\s+/g, ' ').slice(0, 400)}"`;
        const rows = [['sha', 'date', 'subject', 'commit_verdict', 'file', 'case', 'case_verdict', 'reason', 'why_weak'].join(',')];
        for (const r of results) {
            if (!r.cases.length) rows.push([r.sha, r.date, esc(r.subject), r.verdict, '', '', r.verdict, esc(r.note)].join(','));
            for (const c of r.cases) rows.push([r.sha, r.date, esc(r.subject), r.verdict, esc(c.file), esc(c.name), c.verdict, esc(c.reason), esc(c.why)].join(','));
        }
        await writeFile(path.resolve(out), rows.join('\n'));
        console.log(`  full per-case results: ${path.resolve(out)}  (${rows.length - 1} rows)\n`);
    }
    if (!has('keep')) await removeWorktrees(repo, workDir);
}

async function issues() {
    const sha = argv[1];
    if (!sha || sha.startsWith('--')) die('usage: ca issues <commit> [--apply]');
    const r = await verifyCommit({ repo, workDir, sha, against: flag('against'), timeoutMs: Number(flag('timeout', 120_000)) });
    if (r.verdict !== BLIND) {
        console.log(`\n  ${r.short} is ${r.verdict}, not BLIND — nothing to file.\n`);
        if (!has('keep')) await removeWorktrees(repo, workDir);
        return;
    }
    const title = `test gap: ${r.subject.slice(0, 70)}`;
    const body = issueBody({ ...r, stillOpen: r.stillOpen?.status?.toUpperCase() }, repo);
    if (!has('apply')) {
        // Default is a DRY RUN. Filing an issue is outward-facing and irreversible enough
        // that it should never be the thing that happens when someone tries the command.
        console.log(`\n  DRY RUN — would file:\n\n  title: ${title}\n`);
        console.log(body.split('\n').map(l => '  | ' + l).join('\n'));
        console.log(`\n  Re-run with --apply to file it.\n`);
    } else {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const { stdout } = await promisify(execFile)('gh',
            ['issue', 'create', '--repo', repo, '--title', title, '--body', body, '--label', 'test-gap'],
            { cwd: repo });
        console.log(`  filed: ${stdout.trim()}`);
    }
    if (!has('keep')) await removeWorktrees(repo, workDir);
}

const table = { doctor, verify, audit, issues };
if (!table[cmd]) {
    console.log(`
  ca — does a test actually fail on the code it was written to catch?

    ca doctor                                  can this repo be measured?
    ca verify <commit> [--runs 3]              one commit, per-case verdicts
    ca audit --n 100 [--since '6 months'] [--grep '^fix'] [--seed 1] [--out r.csv]

  common:  --repo <path>   --timeout <ms>   --keep (leave worktrees for inspection)
`);
    process.exit(table[cmd] ? 0 : 2);
}
table[cmd]().catch(e => { console.error(e); process.exit(2); });
