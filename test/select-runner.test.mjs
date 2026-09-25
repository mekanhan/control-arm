/**
 * Runner selection, over synthetic trees.
 *
 * Picking the WRONG runner is a silent failure: vitest run from the repo root finds no
 * config and reports "No test files found", which reads INCONCLUSIVE — a whole surface
 * disappears without ever saying why. So the walk-up has to be pinned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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


test('RUNNER-010: a Playwright suite is detected, so it can be DECLINED by name', async () => {
    // Found by a user running this against a real Playwright suite. The spec fell through
    // to node:test, which cannot execute it, and the report read:
    //     arm A did not run (node): test failed
    // That blames the author's test for the tool's own gap. It is the worst kind of wrong
    // message — specific, confident, actionable, and pointing at the wrong thing.
    const dir = mkdtempSync(path.join(tmpdir(), 'ca-pw-'));
    mkdirSync(path.join(dir, 'platform-e2e', 'tests', 'api'), { recursive: true });
    writeFileSync(path.join(dir, 'platform-e2e', 'playwright.config.ts'), 'export default {};');
    writeFileSync(path.join(dir, 'platform-e2e', 'tests', 'api', 'x.spec.ts'), "import { test } from '@playwright/test';");

    const r = await selectRunner(dir, 'platform-e2e/tests/api/x.spec.ts');
    assert.equal(r.flavour, 'playwright');
    assert.equal(r.pkgDir, 'platform-e2e');

    // CONTROL ARM — the shipped table, which had no playwright entry. It walked past the
    // config it did not recognise and answered `node`.
    const OLD = ['vitest.config.ts', 'vitest.config.js', 'jest.config.js', 'jest.config.ts'];
    const oldAnswer = OLD.some(f => existsSync(path.join(dir, 'platform-e2e', f))) ? 'other' : 'node';
    assert.equal(oldAnswer, 'node', 'the old table must still answer node for a Playwright spec');
    rmSync(dir, { recursive: true, force: true });
});

test('RUNNER-011: a `playwright test` script is the second signal', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ca-pw2-'));
    mkdirSync(path.join(dir, 'e2e'), { recursive: true });
    writeFileSync(path.join(dir, 'e2e', 'package.json'),
        JSON.stringify({ name: 'e2e', scripts: { test: 'playwright test --project=api' } }));
    writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'x');
    const r = await selectRunner(dir, 'e2e/a.spec.ts');
    assert.equal(r.flavour, 'playwright');
    rmSync(dir, { recursive: true, force: true });
});

test('RUNNER-012: node:test is still the fallback for a repo that declares nothing', async () => {
    // RUNNER-010 must not have turned every undeclared repo into "unsupported".
    const dir = mkdtempSync(path.join(tmpdir(), 'ca-plain-'));
    mkdirSync(path.join(dir, 'test'), { recursive: true });
    writeFileSync(path.join(dir, 'test', 'a.test.mjs'), 'x');
    const r = await selectRunner(dir, 'test/a.test.mjs');
    assert.equal(r.flavour, 'node');
    rmSync(dir, { recursive: true, force: true });
});
