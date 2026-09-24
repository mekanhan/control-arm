/**
 * Case extraction, pinned against the four shapes that actually broke it.
 *
 * Each of these was measured on a real corpus of 400 test cases, and each one alone
 * accounted for a double-digit share of "could not analyse". Together they took the
 * unresolvable pile from 64% to 1.3%. None would be caught by a suite that only fed the
 * analyser well-formed input, which is why they are here with the messy input attached.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCase, analyseCase } from '../src/assertions.mjs';

test('nested suites: the runner reports the CONCATENATED name, the source holds the inner one', () => {
    const src = `
describe('auction client', () => {
  it('AUCWEB-001 calls GET /auction/:vin', () => { assert.equal(a, 1); });
});`;
    // Reported by the runner as describe-title + space + it-title.
    const body = extractCase(src, 'auction client AUCWEB-001 calls GET /auction/:vin');
    assert.ok(body, 'progressive reduction must find the inner title');
    assert.match(body, /assert\.equal\(a, 1\)/);
});

test('an APOSTROPHE in the title: source holds a backslash the reported name does not', () => {
    const src = `it('METER-038: usage on the user\\'s LOCAL today is counted', () => { assert.equal(n, 3); });`;
    const body = extractCase(src, "METER-038: usage on the user's LOCAL today is counted");
    assert.ok(body, "an escaped quote inside the literal must still match the unescaped reported name");
    assert.match(body, /assert\.equal\(n, 3\)/);
});

test('JSX: a closing tag is NOT a regex literal', () => {
    // `</div>` puts a slash after `<`. The usual "slash after a non-expression starts a
    // regex" heuristic swallows the rest of the component, and the body is never found.
    const src = `
it('hero renders', () => {
  render(<div className="x">{name}</div>);
  expect(screen.getByText('hi')).toBeTruthy();
});`;
    const body = extractCase(src, 'hero renders');
    assert.ok(body, 'a JSX body must brace-match cleanly');
    assert.match(body, /getByText/);
});

test('braces inside strings and regexes do not unbalance the scan', () => {
    const src = `
it('handles braces', () => {
  const s = '{';
  const re = /[{}]/;
  assert.equal(f(s, re), '}');
});`;
    const body = extractCase(src, 'handles braces');
    assert.ok(body, 'a brace inside a string or a character class is not structure');
    assert.match(body, /assert\.equal\(f\(s, re\)/);
});

test('template-literal titles: every generated case resolves to the shared body', () => {
    const src = `
for (const rel of PAGES) {
  it(\`\${rel}: no internal repo paths\`, () => { expect(md).not.toMatch(BAD); });
}`;
    const a = extractCase(src, 'app/page.tsx: no internal repo paths');
    const b = extractCase(src, 'app/pricing/page.tsx: no internal repo paths');
    assert.ok(a && b, 'a parameterised title must match by pattern, not by equality');
    assert.equal(a, b, 'all generated cases share one body — that is correct, not a bug');
});

test('a wrong body is worse than none: a short remainder is refused', () => {
    const src = `
it('alpha returns null', () => { assert.equal(x, null); });
it('beta returns null',  () => { assert.equal(y, 0); });`;
    // "returns null" alone is ambiguous between the two — reduction must not take it.
    const body = extractCase(src, 'some suite that does not exist returns null');
    assert.equal(body, null, 'an ambiguous short suffix must not resolve to an arbitrary case');
});

test('CONTROL ARM: naive equality-only extraction fails every one of these', () => {
    // The implementation this replaced. Asserted to still get them wrong.
    const naive = (src, name) => {
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b(?:test|it)\\s*\\(\\s*(['"\`])${esc}\\1`).test(src);
    };
    assert.equal(naive(`it('a b c', () => {});`, 'suite a b c'), false);   // nested
    assert.equal(naive(`it('u\\'s v', () => {});`, "u's v"), false);        // apostrophe
    assert.equal(naive('it(`${r}: x`, () => {});', 'p.tsx: x'), false);    // template
});

test('the analyser reports UNKNOWN rather than a clean bill when it cannot tell', () => {
    const r = analyseCase(`it('odd', () => { somethingEntirelyUnrecognised(); });`, 'odd');
    assert.notEqual(r.verdict, 'strong', 'an unrecognised body must never read as strong');
});

test('a short helper name must not be accused of stubbing the unit under test', () => {
    // FOUND ON A REAL RUN. The stub check substring-matched the name against every import
    // path, so a two-letter helper `at` matched '@acme/core' — "acme" contains "at" — and
    // every case in that file was reported as testing a stub. A wrong explanation is worse
    // than none: it sends the reader to look at code that is fine.
    const src = `
import { computeTier } from '@acme/core/tiers.js';
const at = (arr, i) => arr[i];
it('TIER-001: the tier changes the money', () => {
    assert.equal(at(computeTier(x), 0), 1200);
});`;
    const r = analyseCase(src, 'TIER-001: the tier changes the money');
    assert.ok(!r.findings.some(f => f.id === 'stubbed-subject'),
        'a local helper whose name merely appears inside an import path is not a stub');
});

test('a REAL stub is still caught — the tightening must not blind the check', () => {
    const src = `
import { SLA_HOURS } from '../src/priority.mjs';
const priority = () => 1;
it('p is 1', () => { assert.equal(priority('HIGH-PRIORITY'), 1); });`;
    const r = analyseCase(src, 'p is 1');
    assert.ok(r.findings.some(f => f.id === 'stubbed-subject'),
        'a stub matching the imported module basename must still be reported');
    assert.equal(r.verdict, 'weak');
});
