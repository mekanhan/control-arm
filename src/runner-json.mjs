/**
 * vitest / jest runner.
 *
 * Both emit the SAME JSON shape (jest's, which vitest adopted), so one adapter covers
 * `apps/web` (145 fix commits) and `apps/mobile` (101) — 246 of the 267 commits the
 * node:test runner had to decline.
 *
 *   { testResults: [ { assertionResults: [ { fullName, status, failureMessages[] } ] } ] }
 *
 * THE HARD PART IS THE SAME ONE AS EVERYWHERE ELSE: telling a test that DISAGREED from a
 * test that could not RUN. node:test hands that over as `code: 'ERR_ASSERTION'`. These two
 * do not — there is only `failureMessages`, an array of formatted strings. So the adapter
 * has to read the message, which is exactly the kind of text-matching this tool tells
 * other people not to do.
 *
 * It is acceptable here for one reason: the fallback is INCONCLUSIVE, not CAUGHT. An
 * unrecognised message means "I could not tell", which withholds the verdict. A regex that
 * drifts costs coverage; it cannot manufacture a finding. That asymmetry is the whole
 * design and it is why the patterns below are deliberately narrow.
 */

import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

/** An assertion library disagreeing, as vitest/chai and jest/expect phrase it. */
const DISAGREEMENT = [
    /^AssertionError\b/m,
    /^JestAssertionError\b/m,
    /\bexpected .* to (?:be|equal|deeply equal|eql|contain|match|have)\b/,
    /^\s*expect\(.*\)\..*\n/m,          // jest's "expect(received).toBe(expected)" header
    /\bError: expect\(/,
];
/** Could-not-run, which must beat the patterns above if both appear. */
const CANNOT_RUN = [
    /\b(?:SyntaxError|ReferenceError)\b/,
    /Cannot find (?:module|package)/i,
    /ERR_MODULE_NOT_FOUND/,
    /Failed to (?:load|resolve) (?:url|import)/i,
    /does not provide an export named/,
    /Unknown file extension/,
    /No test (?:files )?found/i,
];

export function classifyMessages(msgs) {
    const text = (msgs || []).join('\n');
    if (!text.trim()) return { errorName: 'Unknown', code: null, message: null };
    // Order matters: a module that failed to load often ALSO prints an expect() frame.
    for (const re of CANNOT_RUN) if (re.test(text)) {
        return { errorName: (text.match(/\b(SyntaxError|ReferenceError|TypeError|Error)\b/) || [, 'LoadError'])[1], code: 'ERR_TEST_FAILURE', message: text.split('\n')[0].slice(0, 200) };
    }
    for (const re of DISAGREEMENT) if (re.test(text)) {
        return { errorName: 'AssertionError', code: 'ERR_ASSERTION', message: text.split('\n').find(l => l.trim()) ?.slice(0, 200) ?? null };
    }
    // Unrecognised: say so. INCONCLUSIVE is the honest answer, and it is the safe one.
    return { errorName: 'Unrecognised', code: null, message: text.split('\n')[0].slice(0, 200) };
}

function run(cmd, args, { cwd, timeoutMs, env }) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { cwd, env, shell: false });
        let stdout = '', stderr = '', killed = false;
        const t = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        child.on('close', code => { clearTimeout(t); resolve({ code, stdout, stderr, killed }); });
        child.on('error', e => { clearTimeout(t); resolve({ code: -1, stdout, stderr: String(e), killed }); });
    });
}

function childEnv() {
    const env = { ...process.env, NO_COLOR: '1', CI: '1', FORCE_COLOR: '0' };
    for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST')) delete env[k];
    delete env.NODE_OPTIONS;
    return env;
}

/**
 * `flavour` is 'vitest' or 'jest'. `pkgDir` is the workspace the test belongs to
 * (apps/web), NOT the repo root — both tools resolve their config relative to cwd.
 */
export function jsonRunner(flavour) {
    return {
        name: flavour,
        async execute({ worktreeDir, relTestPath, pkgDir, timeoutMs = 180_000 }) {
            const cwd = path.join(worktreeDir, pkgDir || '.');
            const rel = pkgDir ? path.relative(pkgDir, relTestPath) : relTestPath;
            const outFile = path.join(cwd, `.ca-${flavour}-${process.pid}.json`);
            const args = flavour === 'vitest'
                ? ['vitest', 'run', rel, '--reporter=json', '--outputFile', outFile]
                : ['jest', rel, '--json', '--outputFile', outFile, '--ci'];

            const r = await run('npx', ['--no-install', ...args], { cwd, timeoutMs, env: childEnv() });
            if (r.killed) { await rm(outFile, { force: true }); return { ok: false, loadFailure: 'timeout', cases: [], raw: r }; }

            let report;
            try { report = JSON.parse(await readFile(outFile, 'utf8')); }
            catch {
                const why = (r.stderr + r.stdout).match(/\b(Cannot find module[^\n]*|SyntaxError[^\n]*|ERR_MODULE_NOT_FOUND[^\n]*|No test files found[^\n]*|Failed to (?:load|resolve)[^\n]*)/);
                await rm(outFile, { force: true });
                return { ok: false, loadFailure: why ? why[1].slice(0, 220) : `${flavour} produced no JSON report (exit ${r.code})`, cases: [], raw: r };
            }
            await rm(outFile, { force: true });

            const cases = [];
            for (const file of report.testResults || []) {
                // A file that failed to compile has no assertionResults, only a message.
                if ((file.assertionResults || []).length === 0 && file.message) {
                    return { ok: false, loadFailure: String(file.message).split('\n')[0].slice(0, 220), cases: [], raw: r };
                }
                for (const a of file.assertionResults || []) {
                    const status = a.status === 'passed' ? 'pass' : a.status === 'failed' ? 'fail' : 'skip';
                    cases.push({
                        name: a.fullName || a.title,
                        status,
                        ...(status === 'fail' ? classifyMessages(a.failureMessages) : { errorName: null, code: null, message: null }),
                    });
                }
            }
            if (cases.length === 0) return { ok: false, loadFailure: 'no cases reported', cases: [], raw: r };
            return { ok: true, cases, raw: r };
        },
    };
}

export const vitest = jsonRunner('vitest');
export const jest = jsonRunner('jest');
