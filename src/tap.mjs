/**
 * Parse node:test TAP 13 into normalised case results.
 *
 * Normalised shape, which `verdict.mjs` is written against and other runners must also
 * produce:  { name, status: 'pass'|'fail', errorName, code, message }
 *
 * We take the TAP reporter rather than the spec reporter because the YAML block carries
 * `code:` and `name:`, which is the ONLY thing separating "the test disagreed" from "the
 * test could not run". The human-readable reporters drop it.
 */

const OK = /^\s*ok\s+\d+\s+-\s+(.*)$/;
const NOT_OK = /^\s*not ok\s+\d+\s+-\s+(.*)$/;

export function parseTap(stdout) {
    const lines = stdout.split('\n');
    const cases = [];
    let current = null;
    // TAP folds a multi-line error into a `|-` block of indented lines. We used to record
    // the literal string '<multiline>' for those, which threw away the actual assertion
    // message — and the assertion message is the single most useful thing in the output.
    // It surfaced as "<multiline>" in PR comments where the real text belonged.
    let collecting = null;

    for (const line of lines) {
        const ok = line.match(OK);
        const notOk = line.match(NOT_OK);
        if (ok || notOk) {
            // Trailing TAP directives are not part of the name.
            const raw = (ok || notOk)[1];
            const name = raw.replace(/\s*#\s*(SKIP|TODO).*$/i, '').trim();
            const skipped = /#\s*SKIP/i.test(raw);
            current = { name, status: skipped ? 'skip' : (ok ? 'pass' : 'fail'), errorName: null, code: null, message: null };
            cases.push(current);
            continue;
        }
        if (collecting !== null) {
            // Indented continuation lines belong to the block; anything at or above the
            // opening indent ends it.
            const indent = line.match(/^\s*/)[0].length;
            if (line.trim() && indent > collecting.indent) {
                if (!collecting.done) {
                    const t = line.trim();
                    if (t) { collecting.target.message = t.slice(0, 220); collecting.done = true; }
                }
                continue;
            }
            collecting = null;
        }
        if (!current || current.status !== 'fail') continue;
        // Flat scalars inside the YAML block. Deliberately not a YAML parser: we want four
        // fields and a malformed block must degrade to "unknown", which reads INCONCLUSIVE.
        let m;
        if ((m = line.match(/^\s*code:\s*'?([^'\n]+)'?\s*$/))) current.code = m[1].trim();
        else if ((m = line.match(/^\s*name:\s*'?([^'\n]+)'?\s*$/))) current.errorName = m[1].trim();
        // `expected:` and `actual:` are the ONLY fields that say WHAT the disagreement
        // was. "Expected values to be strictly equal:" is a category, not a finding — the
        // reader wants "expected 1, got 2", and only these two carry it.
        else if ((m = line.match(/^\s*expected:\s*(.+?)\s*$/))) current.expected = m[1];
        else if ((m = line.match(/^\s*actual:\s*(.+?)\s*$/))) current.actual = m[1];
        else if ((m = line.match(/^\s*error:\s*'([^']*)'\s*$/))) current.message = m[1].trim();
        else if ((m = line.match(/^(\s*)error:\s*\|-\s*$/))) {
            collecting = { indent: m[1].length, target: current, done: false };
        }
    }
    for (const c of cases) {
        if (c.expected !== undefined && c.actual !== undefined) {
            c.message = `expected ${c.expected}, got ${c.actual}`;
        }
        delete c.expected; delete c.actual;
    }
    return cases;
}

/**
 * A whole-file load failure. node:test reports this as a `not ok` for the FILE path with
 * no individual cases, which must not be mistaken for every case failing by assertion.
 */
export function isFileLevelFailure(cases, testFile) {
    if (cases.length !== 1) return false;
    const only = cases[0];
    return only.status === 'fail' && (only.name.includes('/') || only.name.endsWith('.mjs') || only.name.endsWith('.js') || only.name === testFile);
}
