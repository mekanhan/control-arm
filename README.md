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

## What you get

> ### `control-arm` — this branch is proven
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

It does not care what *kind* of test it is, only whether the runner can execute the file.

| kind | covered | why |
|---|---|---|
| unit tests | yes | the easy case |
| backend / server logic | yes | same runner, same rewind |
| database-backed tests | yes | needs a live DB, else they report `SKIPPED` |
| component tests (React / RN) | yes | via vitest and jest |
| browser e2e (Playwright) | **no** | no Playwright runner yet |
| performance / load | **no** | they measure speed, not correctness |
| manual QA | **no** | nothing to execute |

## Does it work?

Three repositories, random draws, seeds recorded so the samples are reproducible.

| | a private monorepo | nodejs/undici | iamkun/dayjs |
|---|---|---|---|
| fix commits sampled | 300 | 25 | 40 |
| answerable | 214 | 15 | 25 |
| **CAUGHT** | **93.9%** | **80.0%** | **92.0%** |
| BLIND | 6.1% | 20.0% | 8.0% |
| runtime | 7.1 s/commit | 24.9 s/commit | 1.4 s/commit |

**The dayjs column is the one to weigh.** It is a codebase the author did not write, did
not choose for a flattering result, and could not tune the tool against — 190 fix commits
matched the filter, 99 ship both a test and a source change, 40 drawn at random with the
seed recorded. It lands within a point of the private monorepo it was built on.

Of the 13 raw `BLIND` verdicts in that 300-commit run, **5 were genuinely open** — a 62%
false-positive rate on the raw number, which is why the filters exist.

**[DESIGN.md](DESIGN.md) has the rest**: how the rewind works, the three traps that
separate an instrument from a random number generator, the full accuracy audit, and every
bug found in this tool so far — none of which were found by its own test suite.

## Scope, stated plainly

- **A test can only be judged against the bug it was written for.** No fix commit, no
  broken code, no verdict. The measurable universe is fix commits that shipped a test. For
  tests with no such pairing, the instrument is mutation testing, not this.
- One runner today (`node:test`, plus vitest and jest via adapters). The runner seam is
  isolated in `src/runner.mjs`; the decision logic never sees raw runner output.
- `ca` never touches your working tree — no `stash`, no `checkout` in your clone.
  Everything happens in detached worktrees under `.ca-work/`.

MIT.
