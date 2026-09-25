/**
 * The PR-comment format: the same findings, compressed to what fits above the fold.
 *
 * A reviewer reads this inline on a pull request, so it is per-CASE and not per-commit:
 * the useful sentence is "these two cases cannot pass without your change", and the
 * useful warning is "this one errored rather than asserted, so it proves nothing".
 */
export function prComment(r, { repoName = '.' } = {}) {
    // A DECLINED commit says NOTHING, and an empty string is how it says it.
    //
    // `r.note` is set when the tool refused to judge — a test-only commit, a build-only
    // change, no test at all. There is no finding to report and no accusation to make, so
    // the caller writes an empty file and the comment step skips.
    //
    // It did not, briefly, and posted "### control-arm — SKIPPED · No case in this branch
    // fails without the change" onto a workflow-only PR. Technically true and completely
    // misleading: that PR has no tests, so of course none of them discriminate. A comment
    // that reads as an accusation on a PR doing nothing wrong is worse than no comment.
    //
    // The decision belongs here, where the note lives, and not in a shell scraping stdout
    // for a VERDICT line that a declined run never prints.
    if (r.note) return '';
    const G = { CAUGHT: '✅', 'NON-DISCRIMINATING': '⚪️', INCONCLUSIVE: '⚠️', FLAKY: '🔁', SKIPPED: '⏭' };
    const disc = r.cases.filter(c => c.verdict === 'CAUGHT');
    const inc = r.cases.filter(c => c.verdict === 'INCONCLUSIVE');
    const L = [];
    // STATE THE FACT, do not grade the branch. "this branch is proven" was the one
    // heading in this tool that claimed more than it had measured: what was observed is
    // that N tests fail on the base, which is a count, not a verdict on the branch.
    const n = disc.length;
    const head = r.verdict !== 'CAUGHT' ? r.verdict
        : r.newCode ? 'new code — these tests cannot be judged this way'
        : `${n} test${n === 1 ? '' : 's'} here fail${n === 1 ? 's' : ''} without this change`;
    L.push(`### \`control-arm\` — ${head}`);
    L.push('');
    if (disc.length && r.newCode) {
        // The claim CAUGHT is allowed to make depends on whether there was a bug. On new
        // code the base lacks the thing entirely, so essentially any test touching it
        // fails there. Saying "cannot pass without this change" would be true and
        // worthless — it restates that the code is new.
        L.push(`**${disc.length} of ${r.cases.length} tests fail without this change** — but this ${r.kind === 'feature' ? 'is a feature' : 'commit only adds code'}, so the base does not have it at all.`);
        L.push('');
        L.push(`That is expected, and it is weak evidence: on new code almost any test that reads the new thing fails on the base, whether or not it is well aimed. A test asserting \`1 === 1\` in the same file would NOT show up here; one that merely reads the new field would.`);
    } else L.push(disc.length
        ? `**${disc.length} of ${r.cases.length} tests here genuinely catch this change.** Run against the code as it was before this PR, they fail; with the change, they pass.`
        : `**No test here fails without this change.** Every test in this PR is already green on the code it is meant to fix — so none of them would have caught it.`);
    L.push('');
    // PLAIN WORDS IN THE TABLE HEAD. "case" means "test" to almost nobody outside
    // testing, and "the base" is version-control jargon used as a bare column header.
    // The reader of a PR comment is usually the author, mid-review, not a specialist.
    L.push('| | test | what it did on the code WITHOUT this change |');
    L.push('|---|---|---|');
    for (const c of r.cases) {
        const why = c.verdict === 'CAUGHT'
            ? `**failed** — ${(c.reason || '').replace(/\s+/g, ' ').slice(0, 84)}`
            : c.verdict === 'INCONCLUSIVE'
            ? `_could not run there — ${(c.reason || '').replace(/\s+/g, ' ').slice(0, 74)}_`
            : c.verdict === 'SKIPPED' ? '_skipped by the test runner_'
            : c.verdict === 'FLAKY' ? '_different answers on repeated runs — trust neither_'
            : '_passed too — so it is not what catches this bug. Often deliberate: a test that guards something else._';
        L.push(`| ${G[c.verdict] || '·'} | ${c.name.replace(/\|/g, '\\|').slice(0, 96)} | ${why.replace(/\|/g, '\\|')} |`);
    }
    L.push('');
    if (inc.length) {
        // The single most important idea in the tool, and previously its most opaque
        // sentence. Say the mechanism, not the category.
        L.push(`> ⚠️ **${inc.length} test${inc.length > 1 ? 's' : ''} could not run at all** on the older code — ${inc.length > 1 ? 'they' : 'it'} crashed instead of disagreeing (a missing import, usually).`);
        L.push('>');
        L.push('> That still shows up red, which looks like proof but is not: a test that never executed cannot tell you whether it would have caught anything.');
    }
    L.push('');
    L.push('<details><summary>What this check does</summary>');
    L.push('');
    L.push('It takes the tests in this PR and runs them against the code **as it was before your change**.');
    L.push('');
    L.push('- ✅ **failed there** — the test genuinely catches this. It would have gone red on the old code.');
    L.push('- ⚪️ **passed there too** — this test is not what catches this change. That is often correct: a test guarding something else *should* stay green.');
    L.push('- ⚠️ **could not run there** — it crashed rather than disagreeing, so it proves nothing either way.');
    L.push('');
    L.push('A green test suite cannot tell these apart. That is the whole point of the check.');
    L.push('</details>');
    L.push('');
    L.push(`<sub>\`ca verify ${r.short} --against <base> --repo ${repoName}\` · verified it loaded the old code, not the new</sub>`);
    return L.join('\n');
}
