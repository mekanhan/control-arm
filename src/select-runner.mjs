/**
 * Which runner owns this test file, and from which directory must it be run?
 *
 * A monorepo has several: `tests/**` may be node:test at the repo root while
 * `apps/web/**` is vitest run from apps/web and `apps/mobile/**` is jest run from
 * apps/mobile. vitest and jest both resolve their CONFIG relative to cwd, so running
 * them from the repo root silently picks up the wrong project or none at all.
 *
 * Detection is CONFIG-BASED, walking up from the test file, rather than a hardcoded path
 * map — the map would be right for this repo and wrong for the next one. A repo that
 * declares nothing falls through to node:test, which is the safe default: it either works
 * or it reports a load failure, and a load failure reads INCONCLUSIVE.
 */

import { readFile, access } from 'node:fs/promises';
import path from 'node:path';

const CONFIGS = [
    { flavour: 'vitest', files: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs', 'vite.config.ts', 'vite.config.js'] },
    { flavour: 'jest', files: ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.json'] },
];

const exists = async p => { try { await access(p); return true; } catch { return false; } };

/**
 * @returns {{flavour: 'node'|'vitest'|'jest', pkgDir: string}} pkgDir is relative to the
 * worktree root and is the cwd the runner must be invoked from.
 */
export async function selectRunner(worktreeRoot, relTestPath) {
    let dir = path.dirname(relTestPath);

    while (true) {
        const abs = path.join(worktreeRoot, dir);

        for (const { flavour, files } of CONFIGS) {
            for (const f of files) {
                if (await exists(path.join(abs, f))) return { flavour, pkgDir: dir === '.' ? '' : dir };
            }
        }

        // A package.json whose `test` script names a runner is the second signal. Checked
        // AFTER config files because a workspace root often has a `test` script that
        // delegates, while the config file sits in the package that actually owns the tests.
        const pkgPath = path.join(abs, 'package.json');
        if (await exists(pkgPath)) {
            try {
                const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
                const script = pkg.scripts?.test || '';
                if (/\bvitest\b/.test(script)) return { flavour: 'vitest', pkgDir: dir === '.' ? '' : dir };
                if (/\bjest\b/.test(script)) return { flavour: 'jest', pkgDir: dir === '.' ? '' : dir };
                if (/node\s+--test|\bnode:test\b/.test(script)) return { flavour: 'node', pkgDir: dir === '.' ? '' : dir };
            } catch { /* unparseable package.json is not a signal */ }
        }

        if (dir === '.' || dir === '' || dir === path.sep) return { flavour: 'node', pkgDir: '' };
        dir = path.dirname(dir);
    }
}
