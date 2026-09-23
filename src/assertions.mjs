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
        if (candidate.length < 8) break;
        const body = extractExact(source, candidate);
        if (body != null) return body;
    }
    return null;
}

function extractExact(source, caseName) {
    const esc = caseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const head = new RegExp(`\\b(?:test|it)\\s*\\(\\s*(['"\`])${esc}\\1`);
    const m = source.match(head);
    if (!m) return null;
    let i = source.indexOf('{', m.index + m[0].length);
    if (i === -1) return null;
    let depth = 0, start = i;
    for (; i < source.length; i++) {
        const c = source[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return source.slice(start + 1, i); }
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
        // Same module imported for OTHER symbols? Then this name is very likely the unit.
        const sameModule = new RegExp(`from\\s*['"][^'"]*${name}[^'"]*['"]`, 'i').test(source);
        if (imported.has(name) || sameModule) {
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
