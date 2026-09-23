/**
 * Prove the control arm loaded the control arm's code.
 *
 * EARNED ON THE FIRST REAL RUN. Verifying a carefully tested commit, arm B
 * reported 4 pass / 0 fail — a BLIND verdict on a commit whose test provably cannot pass
 * on the broken code. The harness had symlinked the target repo's whole `node_modules`
 * into the worktree. Workspace packages inside it are symlinks relative to the REAL repo:
 *
 *     node_modules/@acme/core -> ../../packages/core
 *     resolved: file:///home/.../the-repo/packages/core/src/parser.js
 *
 * so the test imported the CURRENT source, not the parent's. Arm B never loaded the code
 * under test. Rebuilt with workspace links pointed into the worktree, the same run
 * returned CAUGHT with the real assertion message.
 *
 * Every language has this trap somewhere (venvs, GOPATH/module cache, classpaths). So the
 * tool does not assume the checkout worked — it asks the runtime where each of the test's
 * imports actually resolved, and refuses to answer if any of them landed outside the
 * worktree.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);

const IMPORT_RE = /^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm;

export async function specifiersOf(testFilePath) {
    const src = await readFile(testFilePath, 'utf8');
    const out = new Set();
    for (const m of src.matchAll(IMPORT_RE)) {
        const spec = m[1];
        if (spec.startsWith('node:')) continue;      // builtins cannot be stale
        out.add(spec);
    }
    return [...out];
}

/**
 * Ask node, inside the worktree, where each specifier resolves. Any resolution outside
 * `worktreeRoot` means we are testing somebody else's code.
 */
export async function proveIdentity({ worktreeRoot, repoRoot, testFilePath, timeoutMs = 30_000 }) {
    let specs;
    try {
        specs = await specifiersOf(testFilePath);
    } catch (e) {
        return { proven: false, reason: `could not read test file: ${e.message}` };
    }
    if (specs.length === 0) return { proven: true, resolved: {}, note: 'no external imports' };

    const probe = `
        const out = {};
        for (const s of ${JSON.stringify(specs)}) {
            try { out[s] = await import.meta.resolve(s); }
            catch (e) { out[s] = 'UNRESOLVED:' + e.code; }
        }
        console.log(JSON.stringify(out));
    `;
    let stdout;
    try {
        ({ stdout } = await exec(process.execPath, ['--input-type=module', '-e', probe], {
            cwd: path.dirname(testFilePath), timeout: timeoutMs, maxBuffer: 8 << 20,
        }));
    } catch (e) {
        return { proven: false, reason: `resolution probe failed: ${(e.stderr || e.message || '').split('\n')[0]}` };
    }

    let resolved;
    try { resolved = JSON.parse(stdout.trim().split('\n').pop()); }
    catch { return { proven: false, reason: 'resolution probe produced no JSON' }; }

    const rootUrl = new URL('file://' + path.resolve(worktreeRoot) + '/').href;
    // Third-party packages are DELIBERATELY shared with the target repo's node_modules —
    // they are version-pinned content, not the source under test, and installing them per
    // worktree would cost an install per commit for no change in behaviour. So resolving
    // to `<repo>/node_modules/...` is correct and must not read as an identity failure.
    //
    // Measured: without this, one shared third-party package alone withheld the verdict
    // on 5 of 120 commits. A workspace package is the opposite case and still fails, because node
    // follows its symlink to `<repo>/packages/core/...` — inside the repo, OUTSIDE
    // node_modules. That is the distinction this gate exists to make.
    const vendorUrl = repoRoot ? new URL('file://' + path.join(path.resolve(repoRoot), 'node_modules') + '/').href : null;
    const escapees = [];
    for (const [spec, url] of Object.entries(resolved)) {
        if (typeof url !== 'string') continue;
        if (url.startsWith('UNRESOLVED:')) {
            // Genuinely missing at the parent (the fix added it). Not an identity failure
            // — the run will surface it as an error, which reads INCONCLUSIVE anyway.
            continue;
        }
        if (!url.startsWith('file:')) continue;                 // node: / data: are fine
        const real = decodeURIComponent(url);
        if (real.startsWith(rootUrl)) continue;                       // inside the worktree: good
        if (vendorUrl && real.startsWith(vendorUrl)) continue;         // shared third-party: fine
        escapees.push(`${spec} -> ${real}`);
    }
    if (escapees.length) {
        return { proven: false, reason: `resolved OUTSIDE the worktree: ${escapees.join('; ')}`, resolved };
    }
    return { proven: true, resolved };
}
