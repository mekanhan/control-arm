/**
 * LEAK-001..002 — killing the audit must not strand the test it was running.
 *
 * A machine running these audits carried ten stray `node --test` processes, seven of them
 * TWO DAYS old, each holding a worktree and file descriptors open. At 0% CPU, so the tool
 * looked idle rather than leaky.
 *
 * The cause is not the timeout — that path already killed what it spawned. It is the audit
 * being killed ITSELF, which an hour-long run invites. Observed directly before the fix:
 *
 *     before   1242399  ppid 1242397   node --test hangs.test.mjs
 *     (kill the parent)
 *     after    1242399  ppid 2099      node --test hangs.test.mjs   <- survived
 *
 * So the scenario here is the real one: start a parent that spawns a hanging test, SIGTERM
 * the parent, and look for survivors. An earlier version of this file tested the timeout
 * path instead and its control arm would not reproduce the bug — which is exactly what a
 * control arm is for (TEST-001).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Any surviving test process belonging to this probe directory. */
const survivors = (tag) => {
    try {
        // -ww: without it `ps` truncates to 80 columns when stdout is not a terminal, and
        // the node binary path alone is 47 of them — the tag falls off the end and this
        // filter matches nothing. Both arms then "pass" for the same empty reason.
        return execFileSync('ps', ['-eo', 'pid,args', '-ww'], { encoding: 'utf8' })
            .split('\n').filter((l) => l.includes(tag) && l.includes('--test'));
    } catch { return []; }
};

/**
 * `guarded` picks which parent to run: the shipped runner (which arms the reaper) or a
 * bare spawn that reproduces the old behaviour.
 */
async function killParentMidRun(guarded) {
    const dir = mkdtempSync(join(tmpdir(), 'ca-leakprobe-'));
    // The probe's name must appear in the CHILD'S ARGV, not just its cwd — `ps -eo args`
    // never shows a working directory, and an earlier version of this file filtered on the
    // directory and therefore matched nothing. Both arms passed for the same empty reason.
    const tag = dir.split('/').pop();
    const testFile = `hangs-${tag}.test.mjs`;
    writeFileSync(join(dir, testFile), `import { test } from 'node:test';
test('hangs forever', async () => { await new Promise(() => {}); });
`);
    const parentJs = join(dir, 'parent.mjs');
    writeFileSync(parentJs, guarded
        ? `import { nodeTest } from ${JSON.stringify(resolve(HERE, '../src/runner.mjs'))};
await nodeTest.execute({ worktreeDir: ${JSON.stringify(dir)}, relTestPath: ${JSON.stringify(testFile)}, timeoutMs: 600000 });
`
        : `import { spawn } from 'node:child_process';
// Strip NODE_TEST*, the way the shipped runner's childEnv() does. Inherited, it makes a
// nested \`node --test\` behave as part of THIS run and exit at once — leaving nothing to
// strand, so the control arm would prove nothing.
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST')) delete env[k];
spawn(process.execPath, ['--test', ${JSON.stringify(testFile)}], { cwd: ${JSON.stringify(dir)}, detached: true, stdio: 'ignore', env });
// A never-resolving await is NOT a handle: with stdio:'ignore' there is no inherited stdin
// either, so this parent exits on its own and the kill below lands on nothing (ESRCH).
// The timer is what keeps it alive long enough to be interrupted, the way a real audit is.
setTimeout(() => {}, 60000);
`);

    const parent = spawn(process.execPath, [parentJs], { cwd: dir, stdio: 'ignore' });
    await wait(2500);                       // let the test process come up
    // Precondition, not decoration: if the test process never came up there is nothing to
    // strand, and BOTH arms would pass for the same empty reason. This file has already
    // failed that way twice — once on a `ps` filter that matched nothing, once on a parent
    // that exited before it could be killed.
    const running = survivors(tag).length;
    process.kill(parent.pid, 'SIGTERM');    // the interruption an hour-long audit invites
    await wait(1500);

    const left = survivors(tag);
    for (const line of left) {
        const pid = Number(line.trim().split(/\s+/)[0]);
        try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ }
        try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    }
    try { process.kill(-parent.pid, 'SIGKILL'); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
    return { left, running };
}

describe('an interrupted audit strands nothing', () => {
    test('LEAK-001: SIGTERM to the runner takes its test process with it', async () => {
        const { left, running } = await killParentMidRun(true);
        assert.ok(running > 0, 'the test process never started — this arm proves nothing');
        assert.equal(left.length, 0,
            `${left.length} test process(es) survived the parent:\n${left.join('\n')}`);
    });

    test('LEAK-002: CONTROL ARM — without the reaper the test process outlives it', async () => {
        const { left, running } = await killParentMidRun(false);
        assert.ok(running > 0, 'the test process never started — this arm proves nothing');
        // If this ever passes, LEAK-001 has stopped proving anything on this platform.
        assert.ok(left.length > 0,
            'the unguarded parent stranded NOTHING — LEAK-001 cannot discriminate here');
    });
});
