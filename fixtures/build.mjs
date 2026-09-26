/**
 * Fixture repos with KNOWN answers — this tool's own control arm.
 *
 * The tool's whole claim is "a test that cannot fail is decoration". A tool that asserts
 * that about other people's tests, while its own suite only checks that it doesn't crash,
 * is the same defect one level up. So: tiny git repos where the right verdict is known by
 * construction, and `test/fixtures.test.mjs` asserts the tool returns it.
 *
 * If `ca` cannot tell 02-blind-direction from 01-caught-value, it does not ship.
 *
 * THE BUG THEY ALL SHARE. `priority()` maps a label to a number. The broken version joins
 * its words with `\s*`, which matches whitespace and nothing else, so it reads
 * "HIGH PRIORITY" but not "HIGH-PRIORITY" — one separator, a different answer. The fixed
 * version accepts any run of real separators.
 *
 * Deliberately a boring, universal domain: every issue tracker has priority labels, and
 * the fixtures should not require knowing anybody's product to read. Only the TEST differs
 * between fixtures; the bug is identical in all of them, so a verdict can only come from
 * the test's quality.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '.build');

const BROKEN = `export function priority(label) {
    const s = String(label).toLowerCase();
    if (/high\\s*priority/.test(s)) return 1;   // \\s* matches whitespace and nothing else
    if (/low\\s*priority/.test(s)) return 3;
    return 2;
}
export const SLA_HOURS = { 1: 4, 2: 24, 3: 72 };
`;
const FIXED = BROKEN
    .replace('/high\\s*priority/', '/high[-_\\s.]*priority/')
    .replace('/low\\s*priority/', '/low[-_\\s.]*priority/');

const FIXTURES = {
    '01-caught-value': {
        expect: 'CAUGHT',
        why: 'asserts the exact priority for the hyphenated spelling',
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priority, SLA_HOURS } from '../src/priority.mjs';
test('a hyphenated HIGH-PRIORITY label is priority 1, four-hour SLA', () => {
    assert.equal(priority('HIGH-PRIORITY'), 1);
    assert.equal(SLA_HOURS[priority('HIGH-PRIORITY')], 4);
});`,
    },
    '02-blind-direction': {
        expect: 'BLIND',
        why: 'asserts a DIRECTION (>0) that the wrong answer also satisfies',
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priority, SLA_HOURS } from '../src/priority.mjs';
test('hyphenated labels are handled', () => {
    const p = priority('HIGH-PRIORITY');
    assert.ok(p, 'a priority comes back');
    assert.ok(SLA_HOURS[p] > 0, 'it has an SLA');
    assert.notEqual(p, undefined);
});`,
    },
    '03-blind-sourcetext': {
        expect: 'BLIND',
        why: 'greps the source instead of executing it',
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('the separator class is tolerant', () => {
    const src = readFileSync(new URL('../src/priority.mjs', import.meta.url), 'utf8');
    assert.ok(src.includes('priority'), 'the rule mentions priority');
    assert.ok(/high/.test(src));
});`,
    },
    '04-blind-overmock': {
        expect: 'BLIND',
        why: 'mocks the unit under test, so the real function never runs',
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLA_HOURS } from '../src/priority.mjs';
const priority = () => 1;   // "stubbed for speed"
test('a hyphenated HIGH-PRIORITY label is priority 1', () => {
    assert.equal(priority('HIGH-PRIORITY'), 1);
    assert.equal(SLA_HOURS[1], 4);
});`,
    },
    '05-inconclusive-newexport': {
        expect: 'INCONCLUSIVE',
        why: 'imports a symbol the fix added — cannot even load at the parent',
        fixedExtra: `export const SEPARATORS = /[-_\\s.]*/;\n`,
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEPARATORS } from '../src/priority.mjs';
test('the separator class is shared', () => {
    assert.equal(SEPARATORS.source, '[-_\\\\s.]*');
});`,
    },
    '06-inconclusive-armA-red': {
        expect: 'INCONCLUSIVE',
        why: 'the case is not green on the fix either — the commit does not stand up',
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priority } from '../src/priority.mjs';
test('a hyphenated HIGH-PRIORITY label is priority 1', () => {
    assert.equal(priority('HIGH-PRIORITY'), 99);
});`,
    },
    '07-caught-mixed': {
        expect: 'CAUGHT',
        why: 'one discriminating case plus two regression guards green on both arms',
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priority } from '../src/priority.mjs';
test('DISCRIMINATES: the hyphenated spelling is priority 1', () => {
    assert.equal(priority('HIGH-PRIORITY'), 1);
});
test('GUARD: the spaced spelling is still priority 1', () => {
    assert.equal(priority('HIGH PRIORITY'), 1);
});
test('GUARD: an unlabelled ticket is still the default priority 2', () => {
    assert.equal(priority('needs triage'), 2);
});`,
    },
    '09-caught-slash-in-name': {
        expect: 'CAUGHT',
        why: 'the discriminating case has a SLASH in its name — it used to be silently dropped',
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priority } from '../src/priority.mjs';
test('label parsing / separator handling', () => {
    assert.equal(priority('HIGH-PRIORITY'), 1);
});`,
    },
    '08-skipped-notest': {
        expect: 'SKIPPED',
        why: 'the fix shipped no test at all',
        test: null,
    },
    '11-caught-via-added-file': {
        expect: 'CAUGHT',
        why: 'the test imports a file the fix ADDED — arm B could not even link before',
        // The shape behind 39 of the 82 INCONCLUSIVE commits in the 300-commit audit: a fix
        // that adds a helper AND repairs behaviour, with a test that imports the helper.
        // The helper goes onto the parent (it cannot un-break anything — it did not exist);
        // the repair does not, so the bug is still there for the test to find.
        addedFile: { path: 'src/labels.mjs', content: `export const CANON = (s) => String(s).trim().toUpperCase();\n` },
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priority } from '../src/priority.mjs';
import { CANON } from '../src/labels.mjs';
test('a canonicalised HIGH-PRIORITY label is priority 1', () => {
    assert.equal(priority(CANON(' high-priority ')), 1);
});`,
    },
    '12-inconclusive-newcode-test': {
        expect: 'INCONCLUSIVE',
        why: 'arm B only links because of an ADDED file, and the test never names what changed — a new-code test, not a blind one',
        // The guard on the above. Same commit shape, but the test exercises ONLY the new
        // helper. It passes on the parent because the helper is all it touches — and
        // calling that BLIND would accuse a test of missing a bug nobody pointed it at.
        addedFile: { path: 'src/labels.mjs', content: `export const CANON = (s) => String(s).trim().toUpperCase();\n` },
        testPath: 'tests/labels.test.mjs',
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANON } from '../src/labels.mjs';
test('CANON upper-cases and trims', () => {
    // Deliberately says nothing the commit modified — naming the changed module, even
    // inside a string, is enough for the reachability check to let this through.
    assert.equal(CANON(' urgent '), 'URGENT');
});`,
    },
    '13-inconclusive-added-only': {
        expect: 'INCONCLUSIVE',
        why: 'the commit only ADDED source, so arm B holds the whole change — nothing left to be blind to',
        // Caught on the real bbd0db0d, which adds a component and its test and modifies
        // nothing. The first version of the added-files guard defaulted to "the test
        // reaches what changed" when NOTHING had changed, and reported a false BLIND.
        addedOnly: true,
        addedFile: { path: 'src/labels.mjs', content: `export const CANON = (s) => String(s).trim().toUpperCase();\n` },
        testPath: 'tests/labels.test.mjs',
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANON } from '../src/labels.mjs';
test('CANON upper-cases and trims', () => {
    assert.equal(CANON(' urgent '), 'URGENT');
});`,
    },
    '14-inconclusive-added-plus-comment-edit': {
        expect: 'INCONCLUSIVE',
        why: 'the only edit to existing source is a comment, so every real change is in the ADDED file',
        // Caught on 022c9997: two added scripts, an added test, and one pre-existing file
        // whose changed lines are all comments. The whole-diff comment-only check cannot
        // fire (the added scripts are real code) and the added-only check cannot fire
        // (a file WAS modified) — so a commit whose fix IS a test came back BLIND.
        commentOnly: true,          // leaves src/priority.mjs broken, adds a comment line
        addedFile: { path: 'src/labels.mjs', content: `export const CANON = (s) => String(s).trim().toUpperCase();\n` },
        testPath: 'tests/labels.test.mjs',
        // It must NAME the modified module, or the run exits through the
        // "test reaches nothing that changed" branch instead and the fixture proves
        // nothing — which is exactly what the first version of it did. 022c9997's test
        // names scripts/spec-coverage.js for the same reason: it is the file it is about.
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANON } from '../src/labels.mjs';
import { priority } from '../src/priority.mjs';
test('CANON upper-cases and trims', () => {
    assert.equal(CANON(' urgent '), 'URGENT');
});
test('priority still defaults to 2 for an unlabelled ticket', () => {
    assert.equal(priority('needs triage'), 2);
});`,
    },
    '10-skipped-comment-only': {
        expect: 'SKIPPED',
        why: 'the source change is a reworded comment — identical behaviour, nothing to be blind to',
        // Source stays BROKEN; only a comment moves. A commit like this used to come back
        // BLIND and read as an open defect.
        commentOnly: true,
        test: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priority } from '../src/priority.mjs';
test('a spaced HIGH PRIORITY label is priority 1', () => {
    assert.equal(priority('HIGH PRIORITY'), 1);
});`,
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
        writeFileSync(path.join(dir, 'src/priority.mjs'), BROKEN);
        sh(dir, ['add', '-A']); sh(dir, ['commit', '-qm', 'feat: priority labels']);

        // --- fix: source repaired, test added ---
        // A comment-only fixture keeps the BROKEN source and changes only a comment, so the
        // commit is a genuine `fix:` subject with no behavioural diff from its parent.
        // `addedOnly` leaves the existing source untouched, so the commit's whole diff is
        // the new file plus its test — no modified source anywhere.
        if (!spec.addedOnly) {
            writeFileSync(
                path.join(dir, 'src/priority.mjs'),
                spec.commentOnly
                    ? `// Separator handling is what this module is about.\n${BROKEN}`
                    : FIXED + (spec.fixedExtra || ''),
            );
        }
        if (spec.addedFile) {
            mkdirSync(path.dirname(path.join(dir, spec.addedFile.path)), { recursive: true });
            writeFileSync(path.join(dir, spec.addedFile.path), spec.addedFile.content);
        }
        if (spec.test) writeFileSync(path.join(dir, spec.testPath || 'tests/priority.test.mjs'), spec.test + '\n');
        sh(dir, ['add', '-A']); sh(dir, ['commit', '-qm', 'fix: a hyphen made a HIGH-PRIORITY ticket read as normal']);

        built[name] = { dir, sha: execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim(), ...spec };
    }
    return built;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const b = buildFixtures();
    for (const [n, f] of Object.entries(b)) console.log(`  ${f.expect.padEnd(13)} ${n.padEnd(26)} ${f.why}`);
    console.log(`\n  ${Object.keys(b).length} fixtures in ${ROOT}\n`);
}
