#!/usr/bin/env node
/**
 * Measure the precision (and, when labels cover the whole sample, the recall) of the
 * BLIND verdict against a hand-labelled corpus.
 *
 * The README quotes "a 62% false-positive rate on the raw number" and "5 for 5 out of 13
 * candidates — too small to quote a precision rate". This is the harness that turns those
 * adjectives into a number you can recompute and defend.
 *
 *   node scripts/precision.mjs --labels truth.csv --audit audit-out.csv
 *
 * truth.csv — one row per judged commit:
 *     sha,truth
 *     a1b2c3d4,gap        # BLIND names a real, still-open gap     (a true positive)
 *     e5f6a7b8,not-gap    # BLIND was wrong: a guard, a category error, repaired since, …
 *
 * audit-out.csv — the file written by `ca audit --out`, which carries commit_verdict and
 * still_open per commit. The script collapses its per-case rows back to per-commit.
 *
 * TWO SIGNALS, TWO ANSWERS.
 *   raw BLIND  — the tool's first verdict, before arm C. Its false-positive rate is the
 *                "62%" the README reports; precision is 1 − that.
 *   BLIND + still OPEN  — after arm C rules out "repaired since" and "cannot tell". This
 *                is the only row a reviewer should act on, so its precision is the number
 *                that matters.
 *
 * Recall needs the WHOLE sample labelled (including commits the tool did NOT flag), so a
 * real gap the tool missed shows up as FN. If you only labelled the findings, precision is
 * still exact and recall is meaningless — the script says so rather than guessing.
 */

import { readFileSync } from 'node:fs';

const flag = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const labelsPath = flag('labels');
const auditPath = flag('audit');
if (!labelsPath || !auditPath) {
    console.error('usage: node scripts/precision.mjs --labels truth.csv --audit audit-out.csv');
    process.exit(2);
}

function parseCsv(text) {
    const lines = text.split('\n').filter(Boolean);
    const hdr = lines.shift().split(',');
    return lines.map(line => {
        const f = []; let cur = '', q = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
            else if (c === '"') q = true;
            else if (c === ',') { f.push(cur); cur = ''; }
            else cur += c;
        }
        f.push(cur);
        return Object.fromEntries(hdr.map((h, i) => [h, f[i]]));
    });
}

const truth = new Map(parseCsv(readFileSync(labelsPath, 'utf8')).map(r => [r.sha, r.truth]));

// The audit CSV has one row per CASE; the verdict columns repeat across a commit's rows.
const commits = new Map();
for (const r of parseCsv(readFileSync(auditPath, 'utf8'))) {
    if (!commits.has(r.sha)) commits.set(r.sha, { commit_verdict: r.commit_verdict, still_open: r.still_open });
}

let labelled = 0, unseen = 0;
const rows = [];
for (const [sha, t] of truth) {
    const c = commits.get(sha);
    if (!c) { unseen++; continue; }
    labelled++;
    rows.push({
        sha,
        truth: t,
        raw: c.commit_verdict === 'BLIND',
        open: c.commit_verdict === 'BLIND' && c.still_open === 'OPEN',
    });
}

function stats(flagged) {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const r of rows) {
        const pos = r.truth === 'gap';
        if (flagged(r)) pos ? tp++ : fp++;
        else pos ? fn++ : tn++;
    }
    const precision = tp + fp ? tp / (tp + fp) : null;
    const recall = tp + fn ? tp / (tp + fn) : null;
    const f1 = precision != null && recall != null && (precision + recall) ? 2 * precision * recall / (precision + recall) : null;
    return { tp, fp, fn, tn, precision, recall, f1 };
}

const raw = stats(r => r.raw);
const open = stats(r => r.open);

const pct = x => x == null ? '   —   ' : (x * 100).toFixed(1) + '%';
const row = (label, s) =>
    `  ${label.padEnd(22)}${String(s.tp).padStart(4)}${String(s.fp).padStart(4)}${String(s.fn).padStart(4)}${String(s.tn).padStart(4)}${pct(s.precision).padStart(10)}${pct(s.recall).padStart(9)}${pct(s.f1).padStart(8)}`;

console.log(`\n  precision of the BLIND verdict — ${labelled} labelled commit(s)${unseen ? ` (${unseen} not in the sample, skipped)` : ''}\n`);
console.log('  ' + 'signal'.padEnd(22) + ' TP'.padStart(4) + ' FP'.padStart(4) + ' FN'.padStart(4) + ' TN'.padStart(4) + 'precision'.padStart(10) + ' recall'.padStart(9) + ' F1'.padStart(8));
console.log(row('raw BLIND', raw));
console.log(row('BLIND + still OPEN', open));
console.log('');
console.log(`  false-positive rate on the raw signal = ${pct(raw.precision == null ? null : 1 - raw.precision)}`);
console.log(`  false-positive rate after arm C    = ${pct(open.precision == null ? null : 1 - open.precision)}`);
console.log('\n  recall is exact only if the labels cover the WHOLE sample (including commits the');
console.log('  tool did NOT flag). If you labelled only the findings, read precision and ignore recall.\n');
