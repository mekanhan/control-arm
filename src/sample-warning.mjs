/**
 * Say so when the draw came up short. (#10)
 *
 * `audit --n 40` on iamkun/dayjs judged FIVE commits and printed a confident 100%.
 * Nothing was broken: the default window is twelve months, dayjs ships few `fix:`
 * commits that also touch a test, and the pool was simply smaller than the request.
 * The window is echoed in the header, so it was visible — but a printed default is not
 * a signal, and a 100% over five commits reads exactly like a 100% over five hundred.
 *
 * What exposed it was that two different `--n` values and two different seeds gave
 * BYTE-IDENTICAL output. A rate that does not move when you change the sample size is
 * not a rate.
 *
 * Deliberately no magic threshold. The condition is the one thing that needs no
 * judgement call: you asked for N and did not get N. Where the pool ran out decides
 * which cause gets named.
 */

/**
 * @param {number} requested  --n
 * @param {number} matched    commits whose subject matched --grep, within --since
 * @param {number} eligible   of those, the ones shipping both a test and a source change
 * @param {number} drawn      what was actually sampled
 * @param {string} since      the window in force
 * @param {boolean} sinceWasExplicit  did the user pass --since themselves?
 * @returns {string|null}     a warning to print, or null when the draw was full
 */
export function sampleWarning({ requested, matched, eligible, drawn, since, sinceWasExplicit }) {
    if (drawn >= requested) return null;

    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const lines = [`  asked for ${plural(requested, 'commit')}, drew ${drawn}.`];

    if (matched === 0) {
        lines.push(`  Nothing matched the subject filter within '${since}'.`);
    } else if (eligible < requested && matched >= requested) {
        // The window held enough commits; the test+source pre-filter is what trimmed it.
        lines.push(`  ${matched} matched the filter but only ${eligible} ship both a test and a`);
        lines.push(`  source change, and only those can be judged.`);
    } else {
        lines.push(`  Only ${plural(matched, 'commit')} matched the subject filter within '${since}'.`);
        if (!sinceWasExplicit)
            lines.push(`  That is the DEFAULT window, not a choice — widen it with --since '6 years'.`);
    }

    lines.push('');
    lines.push(`  A rate over ${drawn} commit${drawn === 1 ? '' : 's'} is not a rate. Read the counts, not the percentage.`);
    return lines.join('\n');
}
