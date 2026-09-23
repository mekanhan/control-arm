/**
 * Runner selection, over synthetic trees.
 *
 * Picking the WRONG runner is a silent failure: vitest run from the repo root finds no
 * config and reports "No test files found", which reads INCONCLUSIVE — a whole surface
 * disappears without ever saying why. So the walk-up has to be pinned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { selectRunner } from '../src/select-runner.mjs';

function tree(spec) {
    const root = mkdtempSync(path.join(tmpdir(), 'ca-sel-'));
    for (const [rel, content] of Object.entries(spec)) {
        const p = path.join(root, rel);
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, content);
    }
    return root;
}

test('a vitest config in the workspace wins, and names that workspace as cwd', async () => {
    const root = tree({
        'package.json': '{"workspaces":["apps/*"]}',
        'apps/web/vitest.config.ts': 'export default {}',
        'apps/web/lib/__tests__/x.test.tsx': '',
    });
    try {
        const r = await selectRunner(root, 'apps/web/lib/__tests__/x.test.tsx');
        assert.equal(r.flavour, 'vitest');
        assert.equal(r.pkgDir, 'apps/web', 'must run FROM apps/web — vitest resolves config relative to cwd');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a jest config in the workspace wins', async () => {
    const root = tree({ 'package.json': '{}', 'apps/mobile/jest.config.js': '', 'apps/mobile/__tests__/y.test.ts': '' });
    try {
        const r = await selectRunner(root, 'apps/mobile/__tests__/y.test.ts');
        assert.equal(r.flavour, 'jest');
        assert.equal(r.pkgDir, 'apps/mobile');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('root tests fall to node:test when nothing else claims them', async () => {
    const root = tree({ 'package.json': '{"scripts":{"test":"node --test tests/*.test.js"}}', 'tests/a.test.js': '' });
    try {
        const r = await selectRunner(root, 'tests/a.test.js');
        assert.equal(r.flavour, 'node');
        assert.equal(r.pkgDir, '');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a repo that declares NOTHING falls through to node:test, not to a guess', async () => {
    // The safe default: node:test either works, or reports a load failure, which reads
    // INCONCLUSIVE. Guessing vitest here would produce "No test files found" — the same
    // silent disappearance this test exists to prevent.
    const root = tree({ 'tests/a.test.js': '' });
    try {
        assert.equal((await selectRunner(root, 'tests/a.test.js')).flavour, 'node');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a workspace config beats a root test script — the nearest owner wins', async () => {
    // The root script often delegates (`npm run test --workspaces`), while the config
    // that actually governs the file sits in the package. Nearest wins, walking up.
    const root = tree({
        'package.json': '{"scripts":{"test":"node --test"}}',
        'apps/web/vitest.config.ts': '',
        'apps/web/x.test.tsx': '',
    });
    try {
        const r = await selectRunner(root, 'apps/web/x.test.tsx');
        assert.equal(r.flavour, 'vitest');
    } finally { rmSync(root, { recursive: true, force: true }); }
});
