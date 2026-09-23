/**
 * Fixture repos with KNOWN answers — this tool's own control arm.
 *
 * The tool's whole claim is "a test that cannot fail is decoration". A tool that asserts
 * that about other people's tests, while its own suite only checks that it doesn't crash,
 * is the same defect one level up. So: eight tiny git repos where the right verdict is
 * known by construction, and `test/fixtures.test.mjs` asserts the tool returns it.
 *
 * If `ca` cannot tell 02-blind-tautology from 01-caught-value, it does not ship.
 *
 * Every BLIND shape here is a real documented defect from the auctionmate repo's
 * docs/spec/testing.md, not an invented one:
 *   02  TEST-002  assert the VALUE, not the direction
 *   03  TEST-005  execute the shipped code, don't grep it
 *   04           over-mocking the unit under test
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '.build');

// The bug every fixture is about, so the verdicts differ only in the TEST, never the bug.
const BROKEN = `export function titleBrand(raw) {
    const s = String(raw).toLowerCase();
    if (/prior\\s*salvage/.test(s)) return 'Rebuilt';   // \\s* matches whitespace and nothing else
    if (/salvage/.test(s)) return 'Salvage';
    return 'Clean';
}
export const MULT = { Clean: 100, Rebuilt: 65, Salvage: 40 };
`;
const FIXED = BROKEN.replace('/prior\\s*salvage/', '/prior[-_\\s/.]*salvage/');

const FIXTURES = {
    '01-caught-value': {
        expect: 'CAUGHT',
        why: 'asserts the exact brand for the hyphenated spelling',
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleBrand, MULT } from '../src/title.mjs';
test('hyphenated prior-salvage is Rebuilt at 65', () => {
    assert.equal(titleBrand('CERT OF TITLE-PRIOR-SALVAGE'), 'Rebuilt');
    assert.equal(MULT[titleBrand('CERT OF TITLE-PRIOR-SALVAGE')], 65);
});`,
    },
    '02-blind-direction': {
        expect: 'BLIND',
        why: 'TEST-002 — asserts a direction (>0) that the wrong answer also satisfies',
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleBrand, MULT } from '../src/title.mjs';
test('hyphenated titles are handled', () => {
    const b = titleBrand('CERT OF TITLE-PRIOR-SALVAGE');
    assert.ok(b, 'a brand comes back');
    assert.ok(MULT[b] > 0, 'it is priced');
    assert.notEqual(b, undefined);
});`,
    },
    '03-blind-sourcetext': {
        expect: 'BLIND',
        why: 'TEST-005 — greps the source instead of executing it',
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('the separator class is tolerant', () => {
    const src = readFileSync(new URL('../src/title.mjs', import.meta.url), 'utf8');
    assert.ok(src.includes('prior'), 'the rule mentions prior salvage');
    assert.ok(/salvage/.test(src));
});`,
    },
    '04-blind-overmock': {
        expect: 'BLIND',
        why: 'mocks the unit under test, so the real function never runs',
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MULT } from '../src/title.mjs';
const titleBrand = () => 'Rebuilt';   // "stub for speed"
test('hyphenated prior-salvage is Rebuilt at 65', () => {
    assert.equal(titleBrand('CERT OF TITLE-PRIOR-SALVAGE'), 'Rebuilt');
    assert.equal(MULT['Rebuilt'], 65);
});`,
    },
    '05-inconclusive-newexport': {
        expect: 'INCONCLUSIVE',
        why: 'imports a symbol the fix added — cannot even load at the parent',
        fixedExtra: `export const SEP = /[-_\\s/.]*/;\n`,
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEP } from '../src/title.mjs';
test('separator class is shared', () => {
    assert.equal(SEP.source, '[-_\\\\s/.]*');
});`,
    },
    '06-inconclusive-armA-red': {
        expect: 'INCONCLUSIVE',
        why: 'the case is not green on the fix either — the commit does not stand up',
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleBrand } from '../src/title.mjs';
test('hyphenated prior-salvage is Rebuilt', () => {
    assert.equal(titleBrand('CERT OF TITLE-PRIOR-SALVAGE'), 'TotallyWrongExpectation');
});`,
    },
    '07-caught-mixed': {
        expect: 'CAUGHT',
        why: 'one discriminating case plus two regression guards green on both arms',
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleBrand } from '../src/title.mjs';
test('DISCRIMINATES: hyphenated is Rebuilt', () => {
    assert.equal(titleBrand('CERT OF TITLE-PRIOR-SALVAGE'), 'Rebuilt');
});
test('GUARD: spaced spelling still Rebuilt', () => {
    assert.equal(titleBrand('CERT OF TITLE-PRIOR SALVAGE'), 'Rebuilt');
});
test('GUARD: a plain salvage cert stays Salvage', () => {
    assert.equal(titleBrand('SALVAGE CERTIFICATE'), 'Salvage');
});`,
    },
    '09-caught-slash-in-name': {
        expect: 'CAUGHT',
        why: 'the discriminating case has a SLASH in its name — it used to be silently dropped',
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleBrand } from '../src/title.mjs';
test('TITLE-022: VDB title-code / variant-string handling', () => {
    assert.equal(titleBrand('CERT OF TITLE-PRIOR-SALVAGE'), 'Rebuilt');
});`,
    },
    '08-skipped-notest': {
        expect: 'SKIPPED',
        why: 'the fix shipped no test at all',
        test: null,
    },
};

function sh(cwd, args) { execFileSync('git', args, { cwd, stdio: 'pipe' }); }

export function buildFixtures() {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    const built = {};

    for (const [name, spec] of Object.entries(FIXTURES)) {
        const dir = path.join(ROOT, name);
        mkdirSync(path.join(dir, 'src'), { recursive: true });
        mkdirSync(path.join(dir, 'tests'), { recursive: true });
        sh(dir, ['init', '-q']);
        sh(dir, ['config', 'user.email', 'ca@fixture']);
        sh(dir, ['config', 'user.name', 'ca fixture']);
        writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, type: 'module', private: true }, null, 2));

        // --- parent: the bug, and whatever tests existed before (none) ---
        writeFileSync(path.join(dir, 'src/title.mjs'), BROKEN);
        sh(dir, ['add', '-A']); sh(dir, ['commit', '-qm', 'feat: title brands']);

        // --- fix: source repaired, test added ---
        writeFileSync(path.join(dir, 'src/title.mjs'), FIXED + (spec.fixedExtra || ''));
        if (spec.test) writeFileSync(path.join(dir, 'tests/title.test.mjs'), spec.test + '\n');
        sh(dir, ['add', '-A']); sh(dir, ['commit', '-qm', 'fix: a hyphen decided a title was worth 40 instead of 65']);

        built[name] = { dir, sha: execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim(), ...spec };
    }
    return built;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const b = buildFixtures();
    for (const [n, f] of Object.entries(b)) console.log(`  ${f.expect.padEnd(13)} ${n.padEnd(26)} ${f.why}`);
    console.log(`\n  ${Object.keys(b).length} fixtures in ${ROOT}\n`);
}
