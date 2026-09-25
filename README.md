# control-arm (`ca`)

**Does a test actually fail on the code it was written to catch?**

When you fix a bug you usually add a test so it can't come back. Everyone does this.
**Nobody checks whether that test would actually have caught the bug.**

This checks. It takes the test you wrote, rewinds your code to just before the fix, and
runs the test there. Red means it works. Green means it was never capable of catching
anything — it just sits in your suite looking like protection.

It does not write tests, and there is no AI in it. It runs your tests and reports what
happened.

## Two tests for the same bug

```js
// A
assert.equal(priority('HIGH-PRIORITY'), 1);

// B
const p = priority('HIGH-PRIORITY');
assert.ok(p);                 // any number but 0 is truthy
assert.ok(SLA_HOURS[p] > 0);  // 24 > 0 is true
```

The bug: `priority()` matched `HIGH PRIORITY` with a space but not `HIGH-PRIORITY` with a
hyphen, so an urgent ticket came back as normal.

On the fixed code both pass. On the broken code **A fails and B still passes** — the wrong
answer, `2`, is also truthy and also has a positive SLA. In CI they are identical: two
green checkmarks.

**That is the gap.** Nothing in a normal pipeline can tell those two apart. `ca` can,
because it runs the new test against the old code.

## Install

```bash
npm i -g control-arm     # or run it from a clone: node bin/ca.mjs
```

Node 18+. No other dependencies.

## Use it

```bash
# Can this repo be measured at all?
ca doctor

# Judge one commit — a fix, with the test that shipped alongside it
ca verify <sha>

# Judge a branch against where it will merge
ca verify HEAD --against origin/main
```

### As a PR check

```yaml
# .github/workflows/control-arm.yml
name: control-arm
on: pull_request

# `comment: true` posts with the default GITHUB_TOKEN, which is read-only in most
# repos. Without this block the run succeeds and the comment silently never appears.
permissions:
  contents: read
  pull-requests: write

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }        # the merge base needs real history
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - uses: mekanhan/control-arm@v1
        with:
          base: main
          comment: 'true'
```

It comments on the PR with a line per test. It does **not** fail the build by default: a
PR can legitimately ship only regression guards, and a gate that fires on those gets
switched off within a week.

**On a feature PR it refuses to claim anything.** This matters, because the check is
meaningless there and would otherwise read as proof. On a feature the base is code where
the thing does not exist yet, so essentially *any* test touching it fails —
`expected 0 to be greater than 0` is a real assertion failure that says nothing about
whether the test is well aimed. So the comment changes its own headline:

> ### `control-arm` — new code — these tests cannot be judged this way
>
> **3 of 4 tests fail without this change** — but this is a feature, so the base does not
> have it at all.
>
> That is expected, and it is weak evidence: on new code almost any test that reads the new
> thing fails on the base, whether or not it is well aimed. A test asserting `1 === 1` in
> the same file would NOT show up here; one that merely reads the new field would.

The classification is `fix`/`feat` from the conventional-commit prefix, plus a supporting
hint — a commit that only *added* source lines and deleted none looks like new code
regardless of its prefix. Both were measured on a real corpus before being trusted: the
prefix is used consistently (1,213 `fix` / 988 `feat`), while additions-only fires on 9 of
28 features but also on 1 of 35 fixes — **specific, not sensitive**, so it qualifies the
claim and never decides the verdict on its own. A `CAUGHT` on a feature is still `CAUGHT`;
it just does not get to say it would have caught a bug, because there was no bug.

## All flags

```bash
ca doctor  --repo .                       # can this repo be measured?
ca verify  <sha> --repo . --runs 3 --timeout 120000 --work .ca-work
ca verify  <sha> --against origin/main --pr-comment --fail-on-blind
ca audit   --n 100 --since '6 years' --grep '^fix' --seed 1 --out r.csv --html r.html
ca issues  --apply --include-test-fixes
```

| flag | |
|---|---|
| `--repo <path>` | the repository to measure (default: cwd) |
| `--against <ref>` | compare against a base ref — turns `verify` into a PR check |
| `--runs <n>` | repeat each case N times to expose flakes |
| `--timeout <ms>` | per-run timeout |
| `--work <path>` | where the throwaway worktrees go |
| `--keep` | leave them behind for inspection |
| `--n <n>` · `--since <when>` · `--grep <re>` · `--seed <n>` | which commits `audit` samples |
| `--include-test-fixes` | do not skip `fix(test):` commits, where the bug WAS the test |
| `--out <file>` · `--html <file>` | write the audit as CSV or HTML |
| `--pr-comment` | print the PR comment markdown and nothing else |
| `--apply` | `issues` actually files them, rather than printing |
| **`--json`** | **findings-contract v1 envelope on stdout** (see below) |
| `--json <path>` | the older behaviour: write the audit summary to a file |
| **`--fail-on-blind`** | **exit 1 when a commit is BLIND** |

### The findings contract

Bare `--json` emits one [findings-contract v1](https://github.com/mekanhan/findings-contract)
object on stdout and nothing else — progress goes to stderr, so it pipes. It works on
`doctor`, `verify` and `audit`.

The mapping is not one-to-one, and the interesting part is what is **not** a finding:

| | |
|---|---|
| commit `CAUGHT` | no finding. Nothing is wrong |
| commit `BLIND` | a finding, severity `warn` |
| commit `INCONCLUSIVE` | **not** a finding — it goes to `skipped`, with its reason |
| case `NON-DISCRIMINATING` | never a finding. A fact about a guard, not a fault |
| case `FLAKY` | a finding. Runs disagreed, which is a real defect |

**Exit codes:** `0` ran cleanly · `1` found blockers · `2` the tool itself failed.

`ca verify` used to exit `1` on `BLIND`. It no longer does unless you pass
`--fail-on-blind`, because `BLIND` is a `warn` — a test that cannot catch a bug breaks
nothing today — and putting a warning into an exit code makes every caller guess. The
GitHub Action is unaffected: it reads the verdict from stdout.

## What you get

> ### `control-arm` — 1 test here fails without this change
>
> **1 of 5 tests here genuinely catch this change.** Run against the code as it was before
> this PR, they fail; with the change, they pass.
>
> | | test | what it did on the code WITHOUT this change |
> |---|---|---|
> | ✅ | `RESET-002: does not render the next UTC midnight` | **failed** — `expect(received).toBeNull()` |
> | ⚪️ | `RESET-003: the pre-fix expression disagrees` | _passed too — so it is not what catches this bug_ |
> | ⚠️ | `RESET-001: renders the time the server sent` | _could not run there — crashed rather than disagreeing_ |

**One `CAUGHT` and a pile of `NON-DISCRIMINATING` is the healthy result**, not a problem.
One test was aimed at the bug; the rest guard other things. The only worrying outcome is a
commit where *nothing* caught it.

## Verdicts

| level | verdict | meaning |
|---|---|---|
| case | `CAUGHT` | ran on the broken code and disagreed with it |
| case | `NON-DISCRIMINATING` | ran and was fine with it — a fact, not a fault |
| case | `INCONCLUSIVE` | never ran, or its identity could not be proven |
| case | `FLAKY` | repeated runs disagreed |
| commit | `CAUGHT` | at least one case discriminates |
| commit | `BLIND` | every case ran, **not one** discriminated |
| commit | `INCONCLUSIVE` | excluded from the ratio rather than assumed |

`INCONCLUSIVE` is reported in its own column and never folded into the others. A
measurement that cannot tell zero from failure is not a measurement.

## Which of your tests it looks at

It does not care what *kind* of test it is, only whether a runner it has can execute the file.

**Every row carries what proves it.** A row without evidence beside it is an aspiration, and
that is exactly where this table was wrong before: vitest and jest were listed as covered
because the code has adapters for them, not because either had ever been run. The first
commit used to check crashed the tool.

| kind | covered | proven by |
|---|---|---|
| unit tests (`node:test`) | yes | fixtures `01`–`12`, built and run by `npm test` on every push |
| backend / server logic | yes | same runner, same rewind — fixtures above |
| component tests (**vitest**) | yes | observed on a real commit, 2026-09-25 — **no public fixture yet** (#21) |
| component tests (**jest**) | yes | observed on a real commit, 2026-09-25 — **no public fixture yet** (#21) |
| database-backed tests | partly | observed running against a live DB. The `SKIPPED`-without-a-DB path is **unverified** (#21) |
| browser e2e (Playwright) | **no** | `RUNNER-010` — detected and **declined by name**, so you get "no playwright runner" rather than a confusing failure |
| WDIO / Appium | **no** | not detected at all — it will fall through to `node` and report a load failure (#21) |
| performance / load (k6) | **no** | they measure speed, not correctness |
| manual QA | **no** | nothing to execute |

### How to read that table

**"fixtures"** means anyone can re-run it: `npm test` builds throwaway repos where the right
answer is known by construction, and the suite fails if this tool cannot tell
`02-blind-direction` from `01-caught-value`.

**"observed on a real commit"** means it worked once, on a repository you cannot see. That is
weaker, and it is marked weaker on purpose. Until a fixture exists, nothing stops those two
rows regressing silently — which is how they came to be wrong in the first place.

## Does it work?

**Two different questions live here, and mixing them flatters the tool.** How good are the
tests it measured, and how often is the tool itself right? Only the second is about
`control-arm`.

### How often is the TOOL right?

This is the number to judge it on. On the 300-commit run it raised **13 `BLIND` verdicts**
— "not one test in this commit would have caught the bug". Each was then re-run through
arm C and checked by hand:

| | |
|---|---|
| 13 | raw `BLIND` |
| −3 | `↻ REPAIRED SINCE` — the gap was real, and closed after that commit |
| −2 | `? cannot tell` — the test file no longer exists at HEAD |
| −3 | category errors: two `fix(test):` (the bug WAS the test) and one build failure no unit test can catch |
| **5** | genuinely open — **2.3% of answerable commits** |

**A 62% false-positive rate on the raw number.** Publish it and you hand someone thirteen
tickets, eight of which waste their afternoon. Arm C and the corpus filter exist entirely
because of that, and they run by default.

All five survivors held up under hand inspection. **That is 5 for 5 out of 13 candidates —
far too small a sample to quote as a precision rate**, and it is stated as a count for that
reason. The honest summary is: the raw signal is badly over-sensitive, the filters remove
eight of eight known false positives, and what precision remains after them has not been
measured on a sample large enough to have a rate.

`BLIND` is the only verdict that accuses anybody, so every ambiguity resolves away from it.

### How good were the TESTS it measured?

These say nothing about the tool's accuracy — they are a property of the repositories.
Counts, not just percentages, because a percentage over 25 commits invites arithmetic
nobody should have to do themselves.

| | a private monorepo | nodejs/undici | iamkun/dayjs |
|---|---|---|---|
| fix commits sampled | 300 | 25 | 40 |
| answerable | 214 | 15 | 25 |
| **CAUGHT** | **201 — 93.9%** | **12 — 80.0%** | **23 — 92.0%** |
| BLIND | 13 — 6.1% | **3** — 20.0% | **2** — 8.0% |
| INCONCLUSIVE | 86 | 10 | 9 |
| runtime | 7.1 s/commit | 24.9 s/commit | 1.4 s/commit |

**The small columns are small.** dayjs's 8% is **two commits** and undici's 20% is **three**.
Those are proof-of-concept numbers; do not read a difference between 80% and 92% as a
difference between the repositories.

**The dayjs column is the one to weigh** anyway: a codebase the author did not write, did
not choose for a flattering result, and could not tune against — 190 fix commits matched
the filter, 99 ship both a test and a source change, 40 drawn at random with the seed
recorded. It lands within a point of the private monorepo it was built on.

### Why is so much unanswerable?

29% and 40% is a lot to exclude, so here is where it goes. `INCONCLUSIVE` is never folded
into the other columns — a measurement that cannot tell zero from failure is not a
measurement — and there are exactly four ways to earn it:

| cause | what happened |
|---|---|
| **the test will not load on the parent** | the dominant one. The fix *added* an export, a module, a fixture; the test imports it; on the parent that import throws before a single assertion runs. `SyntaxError: does not provide an export named …` is not a test failing, it is a test never starting |
| **the test is not green on the fix either** | no before/after to compare. Usually an environment gap — a database, a browser, a missing `.env` |
| **module identity unprovable** | the run could not be shown to have loaded the worktree's code rather than the real repo's. Refused rather than guessed |
| **a skipped case is present** | the skipped one might have been the discriminating one, so the commit cannot be called `BLIND` |

The breakdown *between* these four has not been counted per repository, so no split is
quoted here.

## Working on this repo

```bash
git config core.hooksPath .githooks   # once per clone; worktrees inherit it
```

`pre-push` refuses three things CI can only tell you about after the fact: a direct push to
`main` (everything lands through a PR), a branch **named** like a default that is not this
repo's default, and a push from a base that has already moved.

The middle one is not hypothetical. A local `master` once sat ten commits behind `main`
while `main` moved on through four PRs; pushing it created a parallel remote branch, and the
Node 20/22/24 matrix came back green against the wrong base. The only tell was a line of
push output — `* [new branch] master -> master` — on a repo that is anything but new.

If a push prints none of that hook's output, it is not armed. Check `core.hooksPath` before
trusting anything it did not say.

## Prior art

The fail-before / pass-after check is not new, and it is worth saying who got there first:

- **[Defects4J](https://github.com/rjust/defects4j)** records, for each reproducible bug,
  the **trigger tests** that fail on the buggy version and pass on the fixed one.
- **[SWE-bench](https://www.swebench.com/)** builds every task around **`FAIL_TO_PASS`**
  tests, with `PASS_TO_PASS` as the regression guard — the same two arms.

Both use the property to **construct benchmarks**: they start from a known bug and keep the
tests that prove it. `control-arm` runs the same check in the other direction — on ordinary
commits, in CI, where the answer is not known in advance and a `BLIND` result is news
rather than a data-cleaning step.

The consequence of that difference is most of this repository: a benchmark can discard
anything ambiguous, because it only needs *some* clean examples. A CI check cannot discard
the commit in front of it, so it has to be able to say `INCONCLUSIVE` out loud, and it has
to be right when it says `BLIND` about somebody's work.

## Scope, stated plainly

- **A test can only be judged against the bug it was written for.** No fix commit, no
  broken code, no verdict. The measurable universe is fix commits that shipped a test. For
  tests with no such pairing, the instrument is mutation testing, not this.
- One runner today (`node:test`, plus vitest and jest via adapters). The runner seam is
  isolated in `src/runner.mjs`; the decision logic never sees raw runner output.
- `ca` never touches your working tree — no `stash`, no `checkout` in your clone.
  Everything happens in detached worktrees under `.ca-work/`.

MIT.
