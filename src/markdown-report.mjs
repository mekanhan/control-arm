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
    L.push(`### \`control-arm\` — ${r.verdict === 'CAUGHT' ? 'this branch is proven' : r.verdict}`);
    L.push('');
    L.push(disc.length
        ? `**${disc.length} of ${r.cases.length} cases cannot pass without this change.** Replayed against the merge base, they fail; on this branch they pass.`
        : `**No case in this branch fails without the change.** Every test here is green on the code this PR is meant to fix.`);
    L.push('');
    L.push('| | case | on the base |');
    L.push('|---|---|---|');
    for (const c of r.cases) {
        const why = c.verdict === 'CAUGHT' ? (c.reason || '').replace(/\s+/g, ' ').slice(0, 90)
                  : c.verdict === 'INCONCLUSIVE' ? `_${(c.reason || '').replace(/\s+/g, ' ').slice(0, 90)}_`
                  : '_green on both — a regression guard looks like this too_';
        L.push(`| ${G[c.verdict] || '·'} | ${c.name.replace(/\|/g, '\\|').slice(0, 96)} | ${why.replace(/\|/g, '\\|')} |`);
    }
    L.push('');
    if (inc.length) L.push(`> ⚠️ ${inc.length} case${inc.length > 1 ? 's' : ''} **errored rather than asserted** on the base, so ${inc.length > 1 ? 'they' : 'it'} cannot be attributed. A case that throws still shows red, which reads as proof when it is not.`);
    L.push('');
    L.push(`<sub>\`ca verify ${r.short} --against <base> --repo ${repoName}\` · module identity verified</sub>`);
    return L.join('\n');
}
