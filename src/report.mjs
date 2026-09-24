/**
 * Output. Deliberately separate from every decision: `verdict.mjs` returns data, this
 * turns data into text, and nothing here may change an outcome.
 *
 * The house rule this obeys: never round a verdict UP. INCONCLUSIVE is printed as
 * INCONCLUSIVE and counted in its own column, because a tool that quietly folds "could
 * not run" into "caught it" is reporting a number nobody can act on.
 */

import { CAUGHT, BLIND, NON_DISCRIMINATING, INCONCLUSIVE, FLAKY, SKIPPED } from './verdict.mjs';

export const MARK = { ok: '✓', no: '✗', hm: '?' };

const GLYPH = {
    [CAUGHT]: '✓', [BLIND]: '✗', [NON_DISCRIMINATING]: '–', [INCONCLUSIVE]: '?', [FLAKY]: '~', [SKIPPED]: '·',
};
const ORDER = [CAUGHT, BLIND, FLAKY, INCONCLUSIVE, SKIPPED];
const CASE_ORDER = [CAUGHT, NON_DISCRIMINATING, FLAKY, INCONCLUSIVE, SKIPPED];

export function renderVerify(r) {
    const L = [];
    L.push('');
    L.push(`  ${r.short}  ${r.subject}`);
    L.push(`  ${r.date} · ${r.testFiles.length} test file(s) · ${r.sourceFiles.length} source file(s) changed`);
    if (r.note) { L.push(`  ${MARK.hm} ${r.note}`); L.push(''); return L.join('\n'); }

    const idn = r.cases.find(c => /identity unproven/.test(c.reason || ''));
    L.push(idn ? `  ${MARK.no} module identity NOT proven — every verdict below is withheld`
               : `  ${MARK.ok} module identity verified (arm B resolved inside the parent worktree)`);
    L.push('');

    const byFile = new Map();
    for (const c of r.cases) { if (!byFile.has(c.file)) byFile.set(c.file, []); byFile.get(c.file).push(c); }
    for (const [file, cases] of byFile) {
        L.push(`  ${file}`);
        for (const c of cases) {
            const label = c.verdict === CAUGHT ? 'DISCRIMINATES' : c.verdict === NON_DISCRIMINATING ? 'no-discrim.  ' : c.verdict === FLAKY ? 'FLAKY        ' : c.verdict === SKIPPED ? 'skip         ' : 'INCONCLUSIVE ';
            L.push(`    ${GLYPH[c.verdict]} ${label} ${c.name}`);
            // The assertion note, where there is one, says something the generic reason
            // cannot: WHY this case could not have caught the bug. Prefer it.
            const detail = c.why || c.reason;
            if (detail && c.verdict !== SKIPPED) L.push(`              └ ${String(detail).replace(/\s+/g, ' ').slice(0, 160)}`);
        }
        L.push('');
    }
    const n = v => r.cases.filter(c => c.verdict === v).length;
    if (r.stillOpen) {
        const m = { repaired: '↻ REPAIRED SINCE', open: '‼ STILL OPEN TODAY', unknown: '? cannot tell' }[r.stillOpen.status];
        L.push(`  ${m} — ${r.stillOpen.reason}`);
        L.push('');
    }
    L.push(`  VERDICT  ${r.verdict}   ·  ${n(CAUGHT)} discriminating, ${n(NON_DISCRIMINATING)} non-discriminating (guards look like this too), ${n(FLAKY)} flaky, ${n(INCONCLUSIVE)} inconclusive`);
    L.push('');
    return L.join('\n');
}

function bar(count, total, width = 26) {
    if (!total) return ' '.repeat(width);
    const filled = Math.round((count / total) * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function renderAudit(results, meta) {
    const L = [];
    const commitTally = Object.fromEntries(ORDER.map(v => [v, results.filter(r => r.verdict === v).length]));
    const allCases = results.flatMap(r => r.cases);
    const caseTally = Object.fromEntries([...ORDER, NON_DISCRIMINATING].map(v => [v, allCases.filter(c => c.verdict === v).length]));

    L.push('');
    L.push('  ┌─ ca audit ──────────────────────────────────────────────────────────────┐');
    L.push(`     since ${meta.since} · ${meta.matched} commits matched · ${meta.eligible} judgeable · ${meta.n} drawn at random (seed ${meta.seed})`);
    L.push(`     ${(meta.seconds / 60).toFixed(1)} min · ${(meta.seconds / Math.max(meta.n, 1)).toFixed(1)}s per commit`);
    L.push('  └─────────────────────────────────────────────────────────────────────────┘');
    L.push('');
    L.push('  BY COMMIT   (a commit is CAUGHT if ANY of its cases discriminates)');
    for (const v of ORDER) {
        const c = commitTally[v];
        if (!c && v === SKIPPED) continue;
        L.push(`    ${(GLYPH[v] + ' ' + v).padEnd(16)} ${bar(c, meta.n)} ${String(c).padStart(4)}  ${((c / Math.max(meta.n, 1)) * 100).toFixed(1).padStart(5)}%`);
    }
    L.push('');
    L.push(`  BY CASE     (${allCases.length} individual test cases — a regression guard reads as non-discriminating, which is correct for it)`);
    for (const v of CASE_ORDER) {
        const c = caseTally[v];
        if (!c && v === SKIPPED) continue;
        L.push(`    ${(GLYPH[v] + ' ' + v).padEnd(16)} ${bar(c, allCases.length)} ${String(c).padStart(4)}  ${((c / Math.max(allCases.length, 1)) * 100).toFixed(1).padStart(5)}%`);
    }

    const decided = commitTally[CAUGHT] + commitTally[BLIND];
    L.push('');
    L.push('  THE NUMBER THAT MATTERS');
    L.push(`    Of ${decided} commits where the instrument could answer at all,`);
    L.push(`    ${commitTally[CAUGHT]} shipped a test that would have caught the bug — ${decided ? ((commitTally[CAUGHT] / decided) * 100).toFixed(1) : '—'}%`);
    L.push(`    ${commitTally[BLIND]} shipped a test that was green on the broken code — ${decided ? ((commitTally[BLIND] / decided) * 100).toFixed(1) : '—'}%`);
    L.push(`    ${commitTally[INCONCLUSIVE]} could not be judged, and are excluded from that ratio rather than assumed.`);
    L.push('');

    const blind = results.filter(r => r.verdict === BLIND);
    if (blind.length) {
        L.push('  BLIND COMMITS — every case green on the broken code');
        for (const r of blind.slice(0, 40)) L.push(`    ${r.short}  ${r.date}  ${r.subject.slice(0, 84)}`);
        if (blind.length > 40) L.push(`    … and ${blind.length - 40} more (see CSV)`);
        L.push('');
    }
    const why = new Map();
    for (const c of allCases.filter(c => c.verdict === INCONCLUSIVE)) {
        const key = String(c.reason || '').replace(/\s+/g, ' ')
            .replace(/'[^']*'/g, "'…'").replace(/["`][^"`]*["`]/g, '…')
            .replace(/\d+/g, 'N').slice(0, 92);
        why.set(key, (why.get(key) || 0) + 1);
    }
    if (why.size) {
        L.push('  WHY INCONCLUSIVE  (the honest denominator — not folded into the ratio above)');
        for (const [k, v] of [...why].sort((a, b) => b[1] - a[1]).slice(0, 12)) L.push(`    ${String(v).padStart(4)}  ${k}`);
        L.push('');
    }
    return L.join('\n');
}
