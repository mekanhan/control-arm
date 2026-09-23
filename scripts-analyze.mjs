/**
 * Segment the audit CSV by which runner the test file belongs to.
 *
 * `ca` ships one runner (node:test). A monorepo's fix commits touch vitest and jest test
 * files too, and those come back INCONCLUSIVE for a reason that says nothing about the
 * test — the tool simply cannot execute it. Reporting one blended ratio over both would
 * be the same defect the tool exists to catch: a number fitted to a population it does
 * not describe.
 */
import { readFileSync } from 'node:fs';

const rows = [];
const raw = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
const hdr = raw.shift().split(',');
for (const line of raw) {
    // naive CSV with quoted fields
    const f = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
        else if (c === '"') q = true;
        else if (c === ',') { f.push(cur); cur = ''; }
        else cur += c;
    }
    f.push(cur);
    rows.push(Object.fromEntries(hdr.map((h, i) => [h, f[i]])));
}

const runnerOf = (file) => {
    if (!file) return 'none';
    if (file.startsWith('tests/')) return 'node:test (supported)';
    if (file.startsWith('apps/web/')) return 'vitest (unsupported)';
    if (file.startsWith('apps/mobile/')) return 'jest (unsupported)';
    if (file.startsWith('apps/e2e/')) return 'playwright (unsupported)';
    if (file.startsWith('packages/')) return 'node:test (supported)';
    return 'other';
};

const commits = new Map();
for (const r of rows) {
    if (!commits.has(r.sha)) commits.set(r.sha, { sha: r.sha, date: r.date, subject: r.subject, verdict: r.commit_verdict, cases: [] });
    commits.get(r.sha).cases.push(r);
}

// A commit belongs to the runner of its test files; mixed commits are called out.
const seg = new Map();
for (const c of commits.values()) {
    const rs = [...new Set(c.cases.map(x => runnerOf(x.file)).filter(x => x !== 'none'))];
    const key = rs.length === 0 ? 'no test file' : rs.length === 1 ? rs[0] : 'mixed';
    if (!seg.has(key)) seg.set(key, []);
    seg.get(key).push(c);
}

const V = ['CAUGHT', 'BLIND', 'FLAKY', 'INCONCLUSIVE', 'SKIPPED'];
console.log('\n  COMMITS BY RUNNER SEGMENT\n');
console.log('  ' + 'segment'.padEnd(26) + V.map(v => v.slice(0, 6).padStart(7)).join('') + '    n');
for (const [k, list] of [...seg].sort((a, b) => b[1].length - a[1].length)) {
    const t = V.map(v => String(list.filter(c => c.verdict === v).length).padStart(7)).join('');
    console.log('  ' + k.padEnd(26) + t + String(list.length).padStart(5));
}

const supported = seg.get('node:test (supported)') || [];
const dec = supported.filter(c => c.verdict === 'CAUGHT' || c.verdict === 'BLIND');
console.log(`\n  SUPPORTED SEGMENT ONLY (node:test)\n`);
console.log(`    ${supported.length} commits · ${dec.length} the instrument could answer`);
if (dec.length) {
    const caught = dec.filter(c => c.verdict === 'CAUGHT').length;
    console.log(`    CAUGHT ${caught}/${dec.length} = ${(caught / dec.length * 100).toFixed(1)}%   BLIND ${dec.length - caught}/${dec.length} = ${((dec.length - caught) / dec.length * 100).toFixed(1)}%`);
}
const blind = supported.filter(c => c.verdict === 'BLIND');
if (blind.length) {
    console.log(`\n  BLIND COMMITS IN THE SUPPORTED SEGMENT (hand-audit these)\n`);
    for (const c of blind) console.log(`    ${c.sha.slice(0, 8)}  ${c.date}  ${c.subject.slice(0, 90)}`);
}
const why = new Map();
for (const c of supported.filter(c => c.verdict === 'INCONCLUSIVE')) {
    for (const cs of c.cases.filter(x => x.case_verdict === 'INCONCLUSIVE')) {
        const k = cs.reason.replace(/'[^']*'/g, "'…'").replace(/\d+/g, 'N').slice(0, 88);
        why.set(k, (why.get(k) || 0) + 1);
    }
}
if (why.size) {
    console.log(`\n  WHY INCONCLUSIVE, supported segment only\n`);
    for (const [k, v] of [...why].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`    ${String(v).padStart(4)}  ${k}`);
}
console.log('');
