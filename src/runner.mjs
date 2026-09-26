/**
 * Run a test file and return normalised cases.
 *
 * One runner today (node:test). The seam is deliberate: `verdict.mjs` never sees runner
 * output, only the normalised shape, so adding vitest/jest/pytest means adding a file
 * here and changing no decision logic.
 */

import { spawn } from 'node:child_process';
import { register, unregister, killGroup, armReaper } from './children.mjs';
import { parseTap, isFileLevelFailure } from './tap.mjs';

/**
 * The child's environment.
 *
 * `NODE_TEST_*` MUST be stripped. When `ca`'s own suite runs under `node --test`, the
 * runner exports NODE_TEST_CONTEXT into every child; a nested `node --test` sees it,
 * decides it is a subprocess of a parent runner, and switches from TAP to the v8
 * serialiser. The TAP parser then finds no cases and every fixture comes back
 * INCONCLUSIVE — which is exactly how this tool failed its own control arm on the first
 * green run, 2026-09-23. It works perfectly from a shell and lies inside a test.
 *
 * Any tool that shells out to a test runner from inside a test runner has this bug.
 */
function childEnv() {
    const env = { ...process.env, NO_COLOR: '1', CI: '1', FORCE_COLOR: '0' };
    for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST')) delete env[k];
    delete env.NODE_OPTIONS;     // a --require/--import from the parent would load into arm B
    return env;
}

/**
 * Kill the process GROUP, not the child.
 *
 * `node --test` spawns a worker per test file, and vitest/jest fork too. Killing only the
 * process we spawned orphans every one of them: a machine running these audits was found
 * carrying ten stray `node --test` processes, seven of them TWO DAYS old, each holding a
 * worktree and file descriptors open. They sat at 0% CPU, which is why nothing noticed.
 *
 * `detached: true` makes the child a group leader, so `process.kill(-pid)` reaches the
 * whole tree. The group is swept on normal close as well, because a test that leaks a
 * server of its own exits cleanly and leaves it running.
 */
function run(cmd, args, { cwd, timeoutMs }) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { cwd, env: childEnv(), detached: true });
        armReaper();
        register(child.pid);
        const killTree = () => { unregister(child.pid); killGroup(child.pid); };
        let stdout = '', stderr = '', killed = false;
        const timer = setTimeout(() => { killed = true; killTree(); }, timeoutMs);
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        child.on('close', (code) => { clearTimeout(timer); killTree(); resolve({ code, stdout, stderr, killed }); });
        child.on('error', (e) => { clearTimeout(timer); killTree(); resolve({ code: -1, stdout, stderr: String(e), killed }); });
    });
}

export const nodeTest = {
    name: 'node:test',
    matches: (repoRoot, pkg) => !pkg?.scripts?.test?.includes('vitest') || true,
    async execute({ worktreeDir, relTestPath, timeoutMs = 120_000 }) {
        const r = await run(process.execPath, ['--test', '--test-reporter=tap', relTestPath],
            { cwd: worktreeDir, timeoutMs });

        if (r.killed) return { ok: false, loadFailure: 'timeout', cases: [], raw: r };

        const cases = parseTap(r.stdout);
        // Drop the FILE-level TAP row (node:test emits one named after the path) without
        // touching real cases.
        //
        // FALSE BLIND — the first thing a random hand-audit caught. This filter used to
        // be `!c.name.includes('/')`, to drop path-shaped rows. A test named
        //     label parsing / separator handling
        // contains a slash, so it was silently dropped from BOTH arms. It was the only
        // discriminating case in its commit, which then came back BLIND — the tool
        // accusing a correct test of being decoration, which is the one output that ends
        // trust in it.
        //
        // Match the path we were GIVEN instead of guessing from the shape of a name.
        const isFileRow = (name) => name === relTestPath || name.endsWith('/' + relTestPath) || name.endsWith(relTestPath.split('/').pop());
        const real = cases.filter(c => !isFileRow(c.name));

        // No individual cases at all, or a single file-path-shaped failure: the file never
        // loaded. This is the SyntaxError/module-not-found path and it must NOT be handed
        // to the verdict engine as "every case failed".
        if (real.length === 0) {
            const why = (r.stderr + r.stdout).match(/\b(SyntaxError|ReferenceError|TypeError|Error \[ERR_MODULE_NOT_FOUND\]|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package))\b[^\n]*/);
            return {
                ok: false,
                loadFailure: why ? why[0].slice(0, 220) : (cases.length ? (cases[0].message || 'file-level failure') : 'no cases reported'),
                cases: [], raw: r,
            };
        }
        return { ok: true, cases: real, raw: r };
    },
};

export const RUNNERS = [nodeTest];
