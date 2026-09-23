/**
 * Re-roll commit verdicts from a saved audit CSV using the CURRENT rollUp.
 *
 * Per-case verdicts are what the two arms measured; the commit verdict is a pure function
 * of them. So a change to the roll-up rule does not need the 7-minute run again — and
 * re-running would also change the sample, which is the wrong thing to do when comparing
 * a rule change.
 */
import { readFileSync } from 'node:fs';
import { rollUp } from './src/verdict.mjs';

function parseCsv(text) {
    const out = []; const lines = text.split('\n').filter(Boolean); const hdr = lines.shift().split(',');
    for (const line of lines) {
        const f = []; let cur = '', q = false;
        for (let i = 0; i < line.length; i++) { const c = line[i];
            if (q) { if (c === '"' && line[i+1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
            else if (c === '"') q = true; else if (c === ',') { f.push(cur); cur = ''; } else cur += c; }
        f.push(cur); out.push(Object.fromEntries(hdr.map((h, i) => [h, f[i]])));
    }
    return out;
}
const runnerOf = f => !f ? 'none'
    : f.startsWith('tests/') || f.startsWith('packages/') ? 'node:test'
    : f.startsWith('apps/web/') ? 'vitest' : f.startsWith('apps/mobile/') ? 'jest'
    : f.startsWith('apps/e2e/') ? 'playwright' : 'other';

const rows = parseCsv(readFileSync(process.argv[2], 'utf8'));
const commits = new Map();
for (const r of rows) {
    if (!commits.has(r.sha)) commits.set(r.sha, { ...r, cases: [] });
    if (r.case) commits.get(r.sha).cases.push(r);
}
const list = [...commits.values()].map(c => {
    const nv = c.cases.length ? rollUp(c.cases.map(x => ({ verdict: x.case_verdict }))) : c.commit_verdict;
    const rs = [...new Set(c.cases.map(x => runnerOf(x.file)).filter(x => x !== 'none'))];
    return { ...c, was: c.commit_verdict, now: nv, seg: rs.length === 1 ? rs[0] : rs.length ? 'mixed' : 'none' };
});

const V = ['CAUGHT', 'BLIND', 'FLAKY', 'INCONCLUSIVE', 'SKIPPED'];
const changed = list.filter(c => c.was !== c.now);
console.log(`\n  ${list.length} commits · ${changed.length} changed verdict under the corrected roll-up\n`);
for (const c of changed) console.log(`    ${c.was.padEnd(13)} -> ${c.now.padEnd(13)} ${c.sha.slice(0,8)}  ${c.subject.slice(0,70)}`);

const node = list.filter(c => c.seg === 'node:test' || c.seg === 'mixed');
const dec = node.filter(c => c.now === 'CAUGHT' || c.now === 'BLIND');
const caught = dec.filter(c => c.now === 'CAUGHT').length;
console.log(`\n  SUPPORTED SEGMENT (node:test, incl. mixed): ${node.length} commits`);
for (const v of V) { const n = node.filter(c => c.now === v).length; if (n) console.log(`    ${v.padEnd(14)} ${String(n).padStart(4)}  ${(n/node.length*100).toFixed(1)}%`); }
console.log(`\n  ANSWERABLE: ${dec.length}   CAUGHT ${caught} (${(caught/dec.length*100).toFixed(1)}%)   BLIND ${dec.length-caught} (${((dec.length-caught)/dec.length*100).toFixed(1)}%)\n`);
console.log('  BLIND after correction:\n');
for (const c of list.filter(c => c.now === 'BLIND')) console.log(`    ${c.sha.slice(0,8)}  ${c.date}  ${c.subject.slice(0,84)}`);
console.log('');
