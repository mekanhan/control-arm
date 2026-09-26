/**
 * Reap the test processes when this process goes away.
 *
 * A machine running these audits was found carrying ten stray `node --test` processes,
 * seven of them TWO DAYS old, each holding a worktree and file descriptors open. They sat
 * at 0% CPU, which is why nothing noticed: the tool looked idle rather than leaky.
 *
 * The cause is NOT the timeout — that path already killed what it spawned. It is the audit
 * being killed itself. Observed directly:
 *
 *     before   1242399  ppid 1242397   node --test hangs.test.mjs
 *     (kill the parent)
 *     after    1242399  ppid 2099      node --test hangs.test.mjs   <- survived
 *
 * An audit runs for the better part of an hour, so it gets interrupted often — and each
 * interruption stranded whatever was mid-run. `detached: true` alone makes this WORSE,
 * because a detached child is meant to outlive its parent. So the spawn stays detached (to
 * get a killable process GROUP for runners that fork workers) and every live group is
 * registered here, to be swept when this process ends however it ends.
 */
const live = new Set();

/** Kill a process group, tolerating one that has already gone. */
export function killGroup(pid) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone, or never grouped */ }
}

export function register(pid) { live.add(pid); }
export function unregister(pid) { live.delete(pid); }
export function liveCount() { return live.size; }

export function reapAll() {
    for (const pid of live) killGroup(pid);
    live.clear();
}

let armed = false;
/**
 * Idempotent, and deliberately not installed at import time: importing a module should not
 * change how the process handles signals. The runners call this the first time they spawn.
 */
export function armReaper() {
    if (armed) return;
    armed = true;
    process.on('exit', reapAll);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(sig, () => {
            reapAll();
            // Re-raise with the handler removed, so the exit code still says "signalled"
            // rather than pretending this was a clean exit.
            process.removeAllListeners(sig);
            process.kill(process.pid, sig);
        });
    }
}
