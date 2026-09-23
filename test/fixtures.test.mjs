/**
 * The tool's control arm. Eight repos where the right answer is known by construction.
 *
 * A green run here is the only reason to believe a verdict this tool prints about
 * anybody else's code. It is also the thing that would catch the failure mode that
 * matters most — a FALSE BLIND — because 01 and 07 must never come back BLIND.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildFixtures } from '../fixtures/build.mjs';
import { verifyCommit } from '../src/verify.mjs';
import { removeWorktrees } from '../src/worktree.mjs';

const fixtures = buildFixtures();

for (const [name, f] of Object.entries(fixtures)) {
    test(`${name} -> ${f.expect}  (${f.why})`, async () => {
        const workDir = path.join(f.dir, '.ca-work');
        try {
            const r = await verifyCommit({ repo: f.dir, workDir, sha: f.sha, runs: 1, timeoutMs: 30_000 });
            assert.equal(r.verdict, f.expect,
                `expected ${f.expect}, got ${r.verdict}\n` +
                r.cases.map(c => `    ${c.verdict}  ${c.name}  — ${c.reason}`).join('\n') +
                (r.note ? `\n    note: ${r.note}` : ''));
        } finally {
            await removeWorktrees(f.dir, workDir);
        }
    });
}

test('a FALSE BLIND is the failure that matters: no discriminating fixture may read BLIND', async () => {
    for (const name of ['01-caught-value', '07-caught-mixed']) {
        const f = fixtures[name];
        const workDir = path.join(f.dir, '.ca-work-fb');
        try {
            const r = await verifyCommit({ repo: f.dir, workDir, sha: f.sha, runs: 1, timeoutMs: 30_000 });
            assert.notEqual(r.verdict, 'BLIND', `${name} was accused of being blind — this is the output that destroys trust in the tool`);
        } finally { await removeWorktrees(f.dir, workDir); }
    }
});
