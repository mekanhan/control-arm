/**
 * The CLI's surface, as data.
 *
 * It lives here rather than inline in `bin/ca.mjs` so a test can read the REAL table
 * instead of a copy of it. A copy drifts, and a test asserting against a copy passes
 * while the README documents a command the binary has never heard of.
 *
 * That is not hypothetical. `ca probe` was the first command in this README from the
 * day it was written. It does not exist. It survived a full rewrite, a review pass, a
 * GitHub release, a Marketplace listing and an npm publish, and reached the npm front
 * page — because nothing in a 48-test suite knew the README existed.
 */

/** Subcommands. `bin/ca.mjs` builds its dispatch table from these names. */
export const COMMANDS = Object.freeze({
    doctor: 'can this repo be measured at all?',
    verify: 'one commit, per-case verdicts',
    audit: 'sample N fix commits and report the CAUGHT rate',
    issues: 'file a ticket per open BLIND commit',
});

export const COMMAND_NAMES = Object.freeze(Object.keys(COMMANDS));

/**
 * Every flag the binary reads. `takesValue` matters to the README check: a valued flag
 * documented without a value is a copy-paste that silently swallows the next argument.
 */
export const FLAGS = Object.freeze({
    repo: { takesValue: true, help: 'the repository to measure (default: cwd)' },
    against: { takesValue: true, help: 'compare against a base ref — turns verify into a PR check' },
    runs: { takesValue: true, help: 'repeat each case N times to expose flakes' },
    timeout: { takesValue: true, help: 'per-run timeout in ms' },
    work: { takesValue: true, help: 'where to put the throwaway worktrees' },
    n: { takesValue: true, help: 'how many fix commits to sample' },
    since: { takesValue: true, help: "how far back to look, e.g. '6 years' (default: 12 months)" },
    grep: { takesValue: true, help: 'commit-subject filter' },
    seed: { takesValue: true, help: 'make the random draw reproducible' },
    out: { takesValue: true, help: 'write the audit to a CSV' },
    html: { takesValue: true, help: 'write an HTML report' },
    json: { takesValue: false, help: 'findings-contract v1 envelope on stdout — or `--json <path>` to write the audit file' },
    'fail-on-blind': { takesValue: false, help: 'exit 1 when a commit is BLIND (off by default — BLIND is a warning, not a blocker)' },
    keep: { takesValue: false, help: 'leave the worktrees behind for inspection' },
    'pr-comment': { takesValue: false, help: 'print the PR comment markdown and nothing else' },
    apply: { takesValue: false, help: 'actually file the issues, rather than printing them' },
    'include-test-fixes': { takesValue: false, help: 'do not skip commits whose subject is fix(test)' },
});

export const FLAG_NAMES = Object.freeze(Object.keys(FLAGS));

export const BIN = 'ca';
