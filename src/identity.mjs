/**
 * Prove the control arm loaded the control arm's code.
 *
 * EARNED ON THE FIRST REAL RUN, 2026-09-23. Verifying auctionmate 8cf7301a, arm B
 * reported 4 pass / 0 fail — a BLIND verdict on one of the most carefully tested commits
 * in that repo. The harness had symlinked the target repo's whole `node_modules` into the
 * worktree. Workspace packages inside it are symlinks relative to the REAL repo:
 *
 *     node_modules/@auctionmate/core -> ../../packages/core
 *     resolved: file:///home/.../auctionmate-project/packages/core/src/bucket.js
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
export async function proveIdentity({ worktreeRoot, testFilePath, timeoutMs = 30_000 }) {
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
        if (!real.startsWith(rootUrl)) escapees.push(`${spec} -> ${real}`);
    }
    if (escapees.length) {
        return { proven: false, reason: `resolved OUTSIDE the worktree: ${escapees.join('; ')}`, resolved };
    }
    return { proven: true, resolved };
}
