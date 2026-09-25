/**
 * Execute the README. (#9)
 *
 * `ca probe` was the first command this README told a new user to run. It does not
 * exist — the dispatch table is `{ doctor, verify, audit, issues }` — so it fell
 * through to the help text and exited 2. It survived a rewrite, a review, a GitHub
 * release, a Marketplace listing and an npm publish, and landed on the npm front page.
 *
 * Forty-eight tests and not one of them knew the README existed. This is the cheapest
 * gate against a repeat: no network, no subprocess, no worktree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_NAMES, FLAGS, FLAG_NAMES, BIN } from '../src/cli-spec.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(path.join(ROOT, f), 'utf8');

/** Every line inside a ```bash / ```sh fence, trailing comments stripped. */
function shellLines(md) {
    const out = [];
    for (const m of md.matchAll(/```(?:bash|sh|console|shell)\n([\s\S]*?)```/g))
        for (const raw of m[1].split('\n')) {
            const line = raw.replace(/\s+#.*$/, '').trim();
            if (line && !line.startsWith('#') && !line.startsWith('$')) out.push(line);
        }
    return out;
}

/** The lines that invoke THIS binary — not `npm`, not `git`, not `node`. */
const invocationsIn = md => shellLines(md)
    .filter(l => new RegExp(`(^|[\\s/])${BIN}\\s`).test(l) && !/^(npm|npx|git|node|cd)\s/.test(l));

const README = read('README.md');
const DESIGN = read('DESIGN.md');
const invocations = [...invocationsIn(README), ...invocationsIn(DESIGN)];

test('CLI-001: the docs actually invoke the binary somewhere', () => {
    // A doc that shows no commands passes every check below vacuously. Refuse that.
    assert.ok(invocations.length >= 3,
        `expected at least 3 \`${BIN}\` commands across README + DESIGN, found ${invocations.length}`);
});

test('CLI-002: every command the docs show exists in the dispatch table', () => {
    const bad = [];
    for (const line of invocations) {
        const argv = line.split(/\s+/);
        const cmd = argv[argv.indexOf(BIN) + 1];
        if (cmd && !cmd.startsWith('-') && !COMMAND_NAMES.includes(cmd)) bad.push({ cmd, line });
    }
    assert.deepEqual(bad, [],
        `the docs name commands that do not exist:\n` +
        bad.map(b => `    ${b.cmd}   in: ${b.line}`).join('\n'));
});

test('CLI-003: every flag the docs show is one the binary reads', () => {
    const bad = [];
    for (const line of invocations)
        for (const m of line.matchAll(/(?:^|\s)--([a-z][a-z-]*)/g))
            if (!FLAG_NAMES.includes(m[1])) bad.push({ flag: `--${m[1]}`, line });
    assert.deepEqual(bad, [],
        `the docs show flags the binary does not read:\n` +
        bad.map(b => `    ${b.flag}   in: ${b.line}`).join('\n'));
});

test('CLI-004: a flag that takes a VALUE is shown with one', () => {
    const bare = [];
    for (const line of invocations) {
        const argv = line.split(/\s+/);
        argv.forEach((a, i) => {
            const name = a.startsWith('--') && !a.includes('=') ? a.slice(2) : null;
            if (!name || !FLAGS[name]?.takesValue) return;
            const next = argv[i + 1];
            if (!next || next.startsWith('--')) bare.push(`${a} in: ${line}`);
        });
    }
    assert.deepEqual(bare, [], `these are documented without a value:\n    ${bare.join('\n    ')}`);
});

test('CLI-005: CONTROL ARM — the exact bug that shipped is caught', () => {
    // `ca probe` reproduced. If this stops holding, CLI-002 has become decoration.
    const broken = '```bash\nca probe\nca verify HEAD --against origin/main\n```';
    const bad = [];
    for (const line of invocationsIn(broken)) {
        const argv = line.split(/\s+/);
        const cmd = argv[argv.indexOf(BIN) + 1];
        if (cmd && !cmd.startsWith('-') && !COMMAND_NAMES.includes(cmd)) bad.push(cmd);
    }
    assert.deepEqual(bad, ['probe'], 'the check must catch the command that shipped');

    // And the real README must be clean by that same code path, so this proves
    // something about the README and not only about a string literal.
    assert.equal(/\bca probe\b/.test(README), false, '`ca probe` is back in the README');
});

test('CLI-006: the dispatch table and the spec do not drift', () => {
    // bin/ca.mjs builds its table from COMMANDS, so a command added there but not here
    // would make CLI-002 reject a command that genuinely works.
    const src = read('bin/ca.mjs');
    assert.match(src, /from '\.\.\/src\/cli-spec\.mjs'/,
        'bin/ca.mjs must import the spec, or the two can disagree');
});

test('CLI-007: every flag the binary reads is documented somewhere', () => {
    // The mirror of CLI-003, and the gap that let `--fail-on-blind` and the new meaning
    // of `--json` ship undocumented while six green checks said the docs were fine.
    // A one-directional gate only catches docs that lie, never docs that omit.
    const docs = README + DESIGN;
    const shown = new Set(invocations.flatMap(l =>
        [...l.matchAll(/(?:^|\s)--([a-z][a-z-]*)/g)].map(m => m[1])));
    const missing = FLAG_NAMES.filter(f =>
        !shown.has(f) && !docs.includes(`\`--${f}\``) && !docs.includes(`--${f} `));
    assert.deepEqual(missing, [],
        `the binary reads flags no doc mentions: ${missing.map(f => '--' + f).join(', ')}`);
});
