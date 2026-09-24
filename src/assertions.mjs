/**
 * WHY is this test weak? — static analysis of a single test case's assertions.
 *
 * The two-arm run answers "did this case discriminate". It does not say what is wrong
 * with a case that did not, and "NON-DISCRIMINATING" on its own is not actionable: the
 * reader still has to open the file and work out whether they are looking at a deliberate
 * regression guard or an assertion that cannot fail.
 *
 * This reads the case body and names the shape. It is HEURISTIC and it says so — every
 * finding carries a confidence, and `weak` is never asserted where `unknown` is honest.
 *
 * WHY REGEX AND NOT AN AST. An AST parse fails closed on any syntax the parser does not
 * know (JSX, TS decorators, a newer proposal), and the input here is other people's test
 * files across three runners. A regex that recognises less is better than a parser that
 * refuses whole files. The cost is real and bounded: unrecognised shapes report `unknown`,
 * which renders as "not analysed" rather than as a clean bill of health.
 */

/** Assertion shapes that pass for a huge class of values, including the wrong one. */
const SHAPES = [
    {
        id: 'truthy-only',
        re: /\b(?:assert\.ok|assert)\(\s*([A-Za-z_$][\w$.\[\]]*)\s*(?:,[^)]*)?\)/,
        severity: 'weak',
        say: (m) => `\`assert.ok(${m[1]})\` passes for ANY truthy value — the right answer and the wrong one both satisfy it`,
    },
    {
        id: 'truthy-matcher',
        re: /\bexpect\(\s*([^)]{1,40})\s*\)\s*\.\s*(?:toBeTruthy|toBeDefined|not\.toBeNull|not\.toBeUndefined)\s*\(/,
        severity: 'weak',
        say: (m) => `\`expect(${m[1]}).toBeTruthy()\` passes for any non-empty value, right or wrong`,
    },
    {
        id: 'directional',
        re: /\b(?:assert\.ok|expect)\s*\(\s*([^)]{1,60}?)\s*([<>]=?)\s*([^)]{1,20}?)\s*\)/,
        severity: 'weak',
        say: (m) => `asserts a DIRECTION (\`${m[1].trim()} ${m[2]} ${m[3].trim().replace(/,.*$/, '')}\`) — a wrong value on the same side still passes`,
    },
    {
        id: 'not-equal-nullish',
        re: /\bassert\.notEqual\s*\(\s*([^,]{1,40}),\s*(undefined|null)\s*\)/,
        severity: 'weak',
        say: (m) => `\`notEqual(${m[1].trim()}, ${m[2]})\` excludes exactly one value out of every possible answer`,
    },
    {
        id: 'snapshot',
        re: /\.\s*toMatchSnapshot\s*\(/,
        severity: 'suspect',
        say: () => `pins a SNAPSHOT — it fails on any change, including a correct one, and passes a wrong value that was recorded while the bug was live`,
    },
    {
        id: 'type-only',
        re: /\b(?:assert\.ok|expect)\s*\(\s*typeof\s+([A-Za-z_$][\w$.]*)\s*(?:===?\s*['"]\w+['"])?\s*\)/,
        severity: 'weak',
        say: (m) => `asserts only the TYPE of \`${m[1]}\` — every wrong value of the right type passes`,
    },
    {
        id: 'length-only',
        re: /\b(?:assert\.ok|expect)\s*\(\s*([A-Za-z_$][\w$.\[\]]*)\.length\s*\)/,
        severity: 'weak',
        say: (m) => `asserts only that \`${m[1]}\` is non-empty — the contents are unchecked`,
    },
    {
        id: 'does-not-throw',
        re: /\b(?:assert\.doesNotThrow|expect\([^)]*\)\s*\.\s*not\s*\.\s*toThrow)\s*\(/,
        severity: 'weak',
        say: () => `asserts only that it did not throw — a wrong answer returned quietly still passes`,
    },
    {
        id: 'source-text',
        re: /readFileSync\s*\([^)]*\)[\s\S]{0,200}?(?:includes|match|test)\s*\(/,
        severity: 'weak',
        say: () => `reads the SOURCE and matches text instead of executing it — it pins the code's spelling, not its behaviour`,
    },
    {
        id: 'no-assertion',
        re: null,
        severity: 'weak',
        say: () => `the case body contains no assertion at all`,
    },
];

/** Shapes that are STRONG — an exact expected value the wrong answer cannot satisfy. */
const STRONG = new RegExp([
    // node:assert — an exact expected value
    'assert\\.(?:equal|strictEqual|deepEqual|deepStrictEqual|notDeepEqual|match|throws|rejects)\\s*\\(',
    // jest / vitest matchers that pin a value, a shape or a call
    'expect\\([\\s\\S]{0,200}?\\)\\s*(?:\\.\\s*(?:not|resolves|rejects)\\s*)*\\.\\s*(?:'
      + 'toBe|toEqual|toStrictEqual|toMatchObject|toMatch|toMatchInlineSnapshot'
      + '|toContain|toContainEqual|toHaveLength|toHaveProperty|toBeCloseTo|toBeNull'
      + '|toHaveBeenCalledWith|toHaveBeenCalledTimes|toThrow|toThrowError'
    + ')\\s*\\(',
].join('|'));

const ASSERT_ANY = /\b(?:assert[.(]|expect\s*\()/;

/**
 * Pull one test case's body out of a file by its name. Brace-matched, not line-based.
 *
 * PROGRESSIVE REDUCTION, and it is the difference between analysing a third of the corpus
 * and analysing all of it. A nested suite reports the CONCATENATED name —
 *
 *     describe('auction client', () => { it('AUCWEB-001 calls GET /auction/:vin', …) })
 *     reported as:  "auction client AUCWEB-001 calls GET /auction/:vin"
 *
 * — while the source contains only the inner title. Searching for the full string finds
 * nothing. Measured on 400 real cases: 256 of them (64%) failed to resolve for exactly
 * this reason, which read as "could not analyse" when the body was right there.
 *
 * So: try the full name, then drop leading words one at a time and take the LONGEST
 * remainder that resolves. Longest-first matters — a short suffix like "returns null"
 * could match several cases in one file, and matching the wrong body is worse than
 * matching none. A remainder under 8 characters is refused for the same reason.
 */
export function extractCase(source, caseName) {
    const words = String(caseName).split(/\s+/);
    for (let start = 0; start < words.length; start++) {
        const candidate = words.slice(start).join(' ');
        // The length floor guards against an AMBIGUOUS SUFFIX resolving to an arbitrary
        // case ("returns null" could name three tests in one file). It must NOT apply to
        // the full name: a test legitimately called `p is 1` is six characters, and
        // refusing it made every short-named case unfindable. Found by a unit test whose
        // own fixture had a short name — the floor silently rejected it.
        if (start > 0 && candidate.length < 8) break;
        const body = extractExact(source, candidate);
        if (body != null) return body;
    }
    return null;
}

/**
 * Find a case by title and return its body — by SCANNING, not by regex.
 *
 * Two things a regex got wrong on real files, both measured:
 *
 * 1. ESCAPED QUOTES. `it('METER-038: usage on the user\'s LOCAL today is counted')` is
 *    reported by the runner as `...the user's LOCAL today...`, with the backslash gone.
 *    A regex matching `(['"`])<name>\1` never matches, because the source holds `\'`
 *    where the name holds `'`. So: parse the literal properly and UNESCAPE it before
 *    comparing.
 *
 * 2. BRACES INSIDE STRINGS. Counting `{` and `}` literally unbalances on a body
 *    containing `'{'`, a regex like /[{]/, a template literal, or a comment with a brace
 *    in it — and then the body is reported as not found. So: skip strings, template
 *    literals, comments and regex literals while matching.
 *
 * Together these were the whole of the remaining "could not analyse" pile.
 */
function unescapeLiteral(raw) {
    return raw.replace(/\\(['"`\\nrt])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' }[c] ?? c));
}

/** Read a quoted literal starting at `i` (which must be the quote). Returns {text, end}. */
function readLiteral(src, i) {
    const q = src[i];
    let out = '';
    for (let j = i + 1; j < src.length; j++) {
        const c = src[j];
        if (c === '\\') { out += c + (src[j + 1] ?? ''); j++; continue; }
        if (c === q) return { text: unescapeLiteral(out), raw: out, tmpl: q === '`', end: j };
        if (c === '\n' && q !== '`') return null;   // unterminated: not a title
        out += c;
    }
    return null;
}

/**
 * Walk from `open` (a `{`) to its matching `}`, ignoring braces that are not code.
 * Regex detection is the approximate part: a `/` is treated as starting a regex only
 * when the previous non-space character cannot end an expression. That is the standard
 * heuristic and it is wrong only for exotic code; when it is wrong the scan fails closed
 * and the case reports as not analysed, never as a wrong body.
 */
function matchBrace(src, open) {
    let depth = 0;
    let prev = '';
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i === -1) return -1; continue; }
        if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i === -1) return -1; i++; continue; }
        if (c === '"' || c === "'" || c === '`') {
            const lit = readLiteral(src, i);
            if (!lit) return -1;
            i = lit.end;
            prev = c;
            continue;
        }
        // REGEX DETECTION, deliberately narrow. The usual heuristic — "a slash after
        // anything that cannot end an expression starts a regex" — is WRONG on JSX: in
        // `</div>` the slash follows `<`, so the scan treats the rest of the component as
        // a regex literal and the body is never found. Measured: every .tsx case in the
        // corpus failed this way. So require the previous character to be one of a small
        // set of operators that really can precede a regex, and never `<`.
        if (c === '/' && REGEX_PREV.has(prev) && !'/*>='.includes(src[i + 1] ?? '')) {
            // regex literal: run to the unescaped closing slash
            let j = i + 1, inClass = false;
            for (; j < src.length; j++) {
                const d = src[j];
                if (d === '\\') { j++; continue; }
                if (d === '[') inClass = true;
                else if (d === ']') inClass = false;
                else if (d === '/' && !inClass) break;
                else if (d === '\n') return -1;
            }
            i = j;
            prev = '/';
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return i; }
        if (!/\s/.test(c)) prev = c;
    }
    return -1;
}

/** Characters after which a `/` genuinely begins a regex literal. `<` is NOT one. */
const REGEX_PREV = new Set(['=', '(', ',', '[', ':', '!', '&', '|', '?', '{', ';', '+', '-', '*', '%', '^', '~', 'return'.slice(-1)]);

const CALL = /\b(?:test|it)(?:\.\w+)?\s*\(\s*(?=['"`])/g;

/**
 * Does this source title name the case the runner reported?
 *
 * Exact for a plain string. For a TEMPLATE LITERAL WITH INTERPOLATION it cannot be exact,
 * because the runtime name contains a value the source does not:
 *
 *     for (const rel of PUBLIC_PAGES) {
 *       it(`${rel}: no docs/(planning|LEGAL|spec|marketing) reference`, …)
 *
 *     reported as:  "app/page.tsx: no docs/(planning|LEGAL|spec|marketing) reference"
 *
 * Every parameterised test has this shape, and there were 30-odd of them in one file
 * alone. So each `${…}` becomes a non-greedy wildcard and the rest is matched literally.
 *
 * All N generated cases resolve to the SAME body, which is correct: they share one. The
 * assertion analysis is therefore about the shared body, which is the thing worth reading.
 */
function titleMatches(lit, caseName) {
    if (lit.text === caseName) return true;
    if (!lit.tmpl || !lit.raw.includes('${')) return false;
    const pattern = lit.raw
        .split(/\$\{[^}]*\}/)
        .map(part => unescapeLiteral(part).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[\\s\\S]*?');
    try { return new RegExp('^' + pattern + '$').test(caseName); } catch { return false; }
}

function extractExact(source, caseName) {
    CALL.lastIndex = 0;
    let m;
    while ((m = CALL.exec(source)) !== null) {
        const qi = m.index + m[0].length;
        const lit = readLiteral(source, qi);
        if (!lit) continue;
        if (!titleMatches(lit, caseName)) continue;
        const open = source.indexOf('{', lit.end);
        if (open === -1) continue;
        const close = matchBrace(source, open);
        // A failed brace scan on ONE site must not abandon the search — a later site may
        // carry the same title and scan cleanly. Fail closed per site, not per file.
        if (close === -1) continue;
        return source.slice(open + 1, close);
    }
    return null;
}

/**
 * @returns {{verdict:'strong'|'weak'|'suspect'|'unknown', findings:Array, snippet:string}}
 */
/**
 * A stub at FILE scope that shadows nothing — because the real symbol was never imported.
 *
 * `const priority = () => 1;` next to `import { SLA_HOURS } from '../src/priority.mjs'`
 * means the unit under test is never called: the case asserts against the stub and passes
 * whatever the real code does. Caught only by reading the WHOLE file, so this cannot live
 * in the per-case shapes above — the case body does not contain it.
 *
 * Deliberately narrow: it fires only when a locally-defined arrow function has the same
 * name as something the test file imports from, or names in, its own source path. A
 * broader rule would flag every legitimate helper.
 */
function fileScopeStubs(source) {
    const out = [];
    const imported = new Set();
    for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
        for (const nm of m[1].split(',')) {
            const n = nm.trim().split(/\s+as\s+/).pop().trim();
            if (n) imported.add(n);
        }
    }
    for (const m of source.matchAll(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm)) {
        const name = m[1];
        // FALSE POSITIVE FOUND ON A REAL RUN. This used to substring-match the name against
        // every import path, so a two-letter helper named `at` matched `@acme/core` —
        // because the word "acme" contains "at" — and every case in that file was reported
        // as testing a stub. A wrong explanation is worse than none: it sends the reader to
        // look at code that is fine.
        //
        // Now: the name must be either an EXACT imported binding, or the BASENAME of an
        // imported module (`import … from '../src/priority.mjs'` for a stub named
        // `priority`). And never a name under three characters, where any rule is a guess.
        if (name.length < 3) continue;
        const basenameMatch = [...source.matchAll(/from\s*['"]([^'"]+)['"]/g)]
            .some(im => im[1].split('/').pop().replace(/\.[mc]?[jt]sx?$/, '') === name);
        if (imported.has(name) || basenameMatch) {
            out.push({
                id: 'stubbed-subject', severity: 'weak',
                note: `\`${name}\` is redefined as a local stub at file scope — the real \`${name}\` is never called, so this case passes whatever the shipped code does`,
            });
        }
    }
    return out;
}

export function analyseCase(source, caseName) {
    const body = extractCase(source, caseName);
    if (body == null) return { verdict: 'unknown', findings: [], snippet: '', reason: 'case body not found' };

    // Comments carry example code and prose; stripping them first stops both from matching.
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    const findings = [];
    for (const s of SHAPES) {
        if (s.id === 'no-assertion') continue;
        const m = code.match(s.re);
        if (m) findings.push({ id: s.id, severity: s.severity, note: s.say(m) });
    }
    if (!ASSERT_ANY.test(code)) {
        const s = SHAPES.find(x => x.id === 'no-assertion');
        findings.push({ id: s.id, severity: s.severity, note: s.say() });
    }

    findings.push(...fileScopeStubs(source));

    const hasStrong = STRONG.test(code);
    const weak = findings.some(f => f.severity === 'weak');

    // A case with BOTH an exact assertion and a loose one is not weak — the exact one
    // still fails on a wrong answer. Report the loose shape, but do not call it weak.
    let verdict;
    const stubbed = findings.some(f => f.id === 'stubbed-subject');
    if (stubbed) verdict = 'weak';          // an exact assertion against a stub proves nothing
    else if (weak && !hasStrong) verdict = 'weak';
    else if (findings.length && hasStrong) verdict = 'suspect';
    else if (hasStrong) verdict = 'strong';
    else verdict = 'unknown';

    const snippet = code.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 4).join('\n');
    return { verdict, findings, snippet, hasStrong };
}
