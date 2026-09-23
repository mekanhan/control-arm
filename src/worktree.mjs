/**
 * Worktree + dependency plumbing.
 *
 * TWO HARD RULES.
 *
 * 1. NEVER touch the user's working tree. No `git stash`, no `git checkout` in their
 *    clone, no writes outside the work dir. A validation tool that can lose somebody's
 *    uncommitted work is dead on arrival, and this one runs over hundreds of commits
 *    unattended. Everything happens in detached worktrees under `.ca-work/`.
 *
 * 2. Worktrees are REUSED across commits. `git worktree add` copies the whole tree
 *    (3,121 files on auctionmate, ~20s); checking out a new commit inside an existing
 *    worktree only touches what differs. Over 300 commits that is the difference between
 *    a coffee and an afternoon.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, symlink, lstat, readlink, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);

export async function git(repo, args, opts = {}) {
    const { stdout } = await exec('git', ['-C', repo, ...args], { maxBuffer: 64 << 20, ...opts });
    return stdout;
}

export async function ensureWorktree(repo, workDir, name, sha) {
    const dir = path.join(workDir, name);
    let exists = false;
    try { await lstat(path.join(dir, '.git')); exists = true; } catch { /* first use */ }

    if (!exists) {
        await mkdir(workDir, { recursive: true });
        await rm(dir, { recursive: true, force: true });
        await git(repo, ['worktree', 'add', '--detach', '--force', dir, sha]);
    } else {
        // Reset hard, not checkout: a previous run transplanted a test file in here, and
        // a dirty tree would make the next checkout fail or, worse, silently keep it.
        await git(dir, ['checkout', '--detach', '--force', sha]);
        await git(dir, ['reset', '--hard', sha]);
        await git(dir, ['clean', '-fdq', '-e', 'node_modules']);
    }
    return dir;
}

/**
 * Build a node_modules inside the worktree.
 *
 * Third-party packages are symlinked straight to the target repo's copies — they are
 * version-pinned content and sharing them saves an install per commit. WORKSPACE packages
 * are NOT: those are symlinks into the repo's own source, and following them is exactly
 * how arm B ends up loading today's code. Those get re-pointed at the worktree.
 *
 * `identity.mjs` verifies the result rather than trusting it, because this function is a
 * heuristic over somebody else's directory layout and will eventually be wrong.
 */
export async function linkDependencies(repoRoot, worktreeDir, { force = false } = {}) {
    const src = path.join(repoRoot, 'node_modules');
    const dst = path.join(worktreeDir, 'node_modules');
    try { await lstat(src); } catch { return { linked: 0, note: 'target repo has no node_modules' }; }

    // Worktrees are reused across commits and node_modules is excluded from `git clean`,
    // so this only has to run once per worktree. Rebuilding ~1,300 symlinks per commit
    // dominated the audit's runtime and changed nothing.
    if (!force) { try { await lstat(dst); return { linked: 0, note: 'reused' }; } catch { /* build it */ } }

    await rm(dst, { recursive: true, force: true });
    await mkdir(dst, { recursive: true });

    let linked = 0, repointed = 0;
    const repoReal = path.resolve(repoRoot);

    const link = async (relEntry) => {
        const from = path.join(src, relEntry);
        const to = path.join(dst, relEntry);
        let target = from;
        try {
            const st = await lstat(from);
            if (st.isSymbolicLink()) {
                const raw = await readlink(from);
                const abs = path.resolve(path.dirname(from), raw);
                if (abs.startsWith(repoReal + path.sep)) {
                    // A workspace package. Point it at the SAME relative path inside the worktree.
                    target = path.join(worktreeDir, path.relative(repoReal, abs));
                    repointed++;
                }
            }
        } catch { return; }
        await mkdir(path.dirname(to), { recursive: true });
        await symlink(target, to).catch(() => {});
        linked++;
    };

    for (const entry of await readdir(src)) {
        if (entry.startsWith('@')) {
            for (const scoped of await readdir(path.join(src, entry)).catch(() => [])) {
                await link(path.join(entry, scoped));
            }
        } else {
            await link(entry);
        }
    }
    return { linked, repointed };
}

/** Put the fix's version of a test file onto the parent tree. The transplant. */
export async function transplant(repo, sha, relPath, worktreeDir) {
    const content = await git(repo, ['show', `${sha}:${relPath}`]);
    const dest = path.join(worktreeDir, relPath);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content);
    return dest;
}

export async function removeWorktrees(repo, workDir) {
    for (const name of ['fix', 'parent']) {
        await git(repo, ['worktree', 'remove', '--force', path.join(workDir, name)]).catch(() => {});
    }
    await git(repo, ['worktree', 'prune']).catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
}
