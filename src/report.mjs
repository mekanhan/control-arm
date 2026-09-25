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

/**
 * One glyph per verdict, and they carry meaning rather than decorate.
 *
 * Single-width characters on purpose: an emoji is two columns wide in most terminals and
 * silently breaks every aligned column after it. Markdown output (the PR comment, the
 * issue body) uses emoji instead, where width does not matter and colour does.
 *
 * ⚠ replaced ? for INCONCLUSIVE. A question mark reads as "unknown, probably fine"; the
 * verdict actually means "I could not run this, so do not count it either way", which is
 * a thing the reader must notice rather than skim past.
 */
const GLYPH = {
    [CAUGHT]: '✓', [BLIND]: '✗', [NON_DISCRIMINATING]: '–', [INCONCLUSIVE]: '⚠', [FLAKY]: '~', [SKIPPED]: '·',
};
const ORDER = [CAUGHT, BLIND, FLAKY, INCONCLUSIVE, SKIPPED];
const CASE_ORDER = [CAUGHT, NON_DISCRIMINATING, FLAKY, INCONCLUSIVE, SKIPPED];

export function renderVerify(r) {
    const L = [];
    L.push('');
    L.push(`  ${r.short}  ${r.subject}`);
    L.push(`  ${r.date} · ${r.testFiles.length} test file(s) · ${r.sourceFiles.length} source file(s) changed`);
    // Say it when arm B is not purely the parent. The verdict still describes the parent's
    // BEHAVIOUR — only files the commit added are carried over, and nothing at the parent
    // could depend on those — but a reader is entitled to know the tree was not untouched.
    if ((r.transplantedAdded || []).length) {
        const n = r.transplantedAdded.length;
        L.push(`  arm B also carries ${n} file(s) this commit ADDED, or the test could not load: ${r.transplantedAdded.slice(0, 3).join(', ')}${n > 3 ? ` +${n - 3} more` : ''}`);
    }
    if (r.note) { L.push(`  ${MARK.hm} ${r.note}`); L.push(''); return L.join('\n'); }

    const idn = r.cases.find(c => /identity unproven/.test(c.reason || ''));
    L.push(idn ? `  ${MARK.no} module identity NOT proven — every verdict below is withheld`
               : `  ${MARK.ok} module identity verified (arm B resolved inside the parent worktree)`);
    L.push('');
    // The legend belongs HERE more than on the audit summary. `verify` is the command
    // someone runs first, and "– no-discrim." means nothing to a reader seeing it once.
    L.push('  LEGEND   ✓ fails without the fix (this test works)   – green either way (a guard looks like this)');
    L.push('           ⚠ could not run on the old code   ~ flaky   · skipped by the runner');
    L.push('');

    const byFile = new Map();
    for (const c of r.cases) { if (!byFile.has(c.file)) byFile.set(c.file, []); byFile.get(c.file).push(c); }
    for (const [file, cases] of byFile) {
        L.push(`  ${file}`);
        for (const c of cases) {
            const label = c.verdict === CAUGHT ? 'CATCHES IT   '
                        : c.verdict === NON_DISCRIMINATING ? 'green either way'
                        : c.verdict === FLAKY ? 'FLAKY           '
                        : c.verdict === SKIPPED ? 'skipped         '
                        : 'COULD NOT RUN   ';
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
        const m = { repaired: '↻ REPAIRED SINCE', open: '‼ STILL OPEN TODAY', unknown: '⚠ cannot tell' }[r.stillOpen.status];
        L.push(`  ${m} — ${r.stillOpen.reason}`);
        L.push('');
    }
    // WHAT CAUGHT IS ALLOWED TO CLAIM depends on whether there was a bug to catch.
    // On new code the base lacks the thing entirely, so a failing test there is expected
    // rather than evidence. Same verdict, a much weaker sentence.
    const plain = r.verdict === CAUGHT && r.newCode
        ? `${n(CAUGHT)} test${n(CAUGHT) === 1 ? ' fails' : 's fail'} on the base — but this commit ADDS code, so the base lacks it entirely. That is expected, not evidence the tests are well aimed.`
        : r.verdict === CAUGHT
        ? `${n(CAUGHT)} test${n(CAUGHT) === 1 ? '' : 's'} here would have caught this bug. The rest are guards or could not run.`
        : r.verdict === BLIND
        ? `NOTHING here would have caught this bug — every test is green on the broken code.`
        : r.verdict === FLAKY ? `A test gave different answers on repeated runs. Do not trust either.`
        : `Could not judge this commit. See the reason above — it is not a pass or a fail.`;
    const qualifier = r.verdict === CAUGHT && r.newCode
        ? `  (${r.kind === 'feature' ? 'a feature' : 'adds code, no source deletions'} — weak evidence)` : '';
    L.push(`  VERDICT  ${GLYPH[r.verdict] ?? ''} ${r.verdict}${qualifier}`);
    L.push(`           ${plain}`);
    L.push(`           ${n(CAUGHT)} catch it · ${n(NON_DISCRIMINATING)} green either way · ${n(FLAKY)} flaky · ${n(INCONCLUSIVE)} could not run`);
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
    L.push('  LEGEND   ✓ caught   ✗ blind   – ran, did not discriminate   ⚠ could not run   ~ flaky');
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

    const strongCaught = results.filter(r => r.verdict === CAUGHT && !r.newCode).length;
    const decided = strongCaught + commitTally[BLIND];
    L.push('');
    // NEW CODE IS NOT EVIDENCE. A feature's base lacks the thing entirely, so essentially
    // any test touching it fails there. Counting those in the headline lets the number
    // drift upward for free on a feature-heavy sample.
    const newCodeCaught = results.filter(r => r.verdict === CAUGHT && r.newCode).length;
    if (newCodeCaught) {
        L.push(`  ${newCodeCaught} CAUGHT commit(s) only ADD code — the base lacks it entirely, so a failing`);
        L.push('  test there is expected rather than evidence. Excluded from the ratio below.');
        L.push('');
    }
    L.push('  THE NUMBER THAT MATTERS');
    L.push(`    Of ${decided} commits where the instrument could answer at all,`);
    L.push(`    ${strongCaught} shipped a test that would have caught the bug — ${decided ? ((strongCaught / decided) * 100).toFixed(1) : '—'}%`);
    L.push(`    ${commitTally[BLIND]} shipped a test that was green on the broken code — ${decided ? ((commitTally[BLIND] / decided) * 100).toFixed(1) : '—'}%`);
    L.push(`    ${commitTally[INCONCLUSIVE]} could not be judged, and are excluded from that ratio rather than assumed.`);
    L.push('');

    const blind = results.filter(r => r.verdict === BLIND);
    if (blind.length) {
        // ARM C SPLIT — the only line in this report that is a TICKET rather than a fact.
        // A raw BLIND count is close to useless as a headline: on a 300-commit run it was
        // 13, of which 3 were already repaired and 2 unjudgeable. Reporting the count
        // alone hands somebody thirteen tickets, eight of which waste their afternoon.
        const open = blind.filter(r => r.stillOpen?.status === 'open');
        const repaired = blind.filter(r => r.stillOpen?.status === 'repaired');
        const cannot = blind.filter(r => !r.stillOpen || r.stillOpen.status === 'unknown');

        L.push('  STILL OPEN TODAY — the only rows that are work');
        if (open.length) for (const r of open) L.push(`    ‼ ${r.short}  ${r.date}  ${r.subject.slice(0, 82)}`);
        else L.push('    (none — every blind finding was repaired later or cannot be judged)');
        L.push('');
        if (repaired.length) {
            L.push(`  ↻ REPAIRED SINCE — true of the commit, already fixed in the tree (${repaired.length})`);
            for (const r of repaired.slice(0, 12)) L.push(`      ${r.short}  ${r.subject.slice(0, 80)}`);
            L.push('');
        }
        if (cannot.length) {
            L.push(`  ⚠ CANNOT TELL — the test file no longer exists, or will not run at HEAD (${cannot.length})`);
            for (const r of cannot.slice(0, 12)) L.push(`      ${r.short}  ${r.subject.slice(0, 80)}`);
            L.push('');
        }
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
