# How it works, and why you should believe it

[README](README.md) covers what `ca` is and how to run it. This is the part a skeptic
needs: the mechanism, the traps that separate an instrument from a random number
generator, and an honest account of how often it is wrong.

## The mechanism

You do **not** run the parent commit's tests — the parent does not have this test.
You take the new test and ask it about the old code.

```
  commit C ("fix: …")
      │
      ├── [worktree @ C]   run the new test on the FIXED code ──► must be GREEN
      │                        └ not green? INCONCLUSIVE: no before/after to compare
      │
      ├── [worktree @ C~1] transplant ONLY the test file onto the BROKEN code
      │                    └ prove module identity, then run
      │        ┌───────────────┬──────────────┬──────────────────┐
      │        ▼               ▼              ▼                  ▼
      │   AssertionError   passed        SyntaxError/        timeout/crash
      │        │               │         import failure           │
      │        ▼               ▼              ▼                  ▼
      │     CAUGHT      NON-DISCRIM.     INCONCLUSIVE       INCONCLUSIVE
      │
      └── N runs disagree? ──► FLAKY
```

## Three things that decide whether this is an instrument or a random number generator

### 1. Exit code is not the signal

A test that "fails" at the parent with `SyntaxError: does not provide an export named
'TITLE_SEPARATOR'` — because the fix *added* that export — exits non-zero and has told you
nothing. It never ran. Read the exit code only and your headline number is inflated
garbage.

The discriminator is **assertion-failure vs error-failure**, which every test runner
reports and almost nothing reads.

### 2. Prove the control arm loaded the control arm's code

On its first real run this tool reported `4 pass / 0 fail` on the parent — a `BLIND`
verdict on one of the most carefully tested commits in the target repo. The harness had
symlinked the repo's whole `node_modules` into the worktree, and workspace packages inside
it are symlinks *relative to the real repo*:

```
node_modules/@acme/core -> ../../packages/core
resolved: file:///…/the-repo/packages/core/src/parser.js   ← today's code
```

Arm B never loaded the code under test. Every language has this trap somewhere — venvs,
module caches, classpaths. So `ca` asks the runtime where each of the test's imports
actually resolved, and **refuses to answer** if any landed outside the worktree.

### 3. A false `BLIND` is the worst output this tool can produce

`CAUGHT` is good news. `INCONCLUSIVE` is an honest shrug. **`BLIND` accuses an engineer of
writing a test that cannot fail.** Get it wrong once and nobody trusts the tool again.

So **every ambiguity resolves away from `BLIND`**, and the verdict is withheld rather than
guessed.

That is also why the case level and the commit level use different words. The first real
run printed this:

```
✗ BLIND   TITLE-022 CONTROL ARM: the whitespace-only patterns really do split one phrase
✗ BLIND   TITLE-022: the prefix test survives the wider separators
✗ BLIND   TITLE-022: the brands the separator change must not touch
```

All three are **regression guards**. Staying green on both arms is their entire job.
Red/green cannot distinguish "meant to catch this bug and failed" from "meant to stay
green" — that is *intent*, and no tool can read it. So a case states the fact
(`NON-DISCRIMINATING`) and only a **commit** gets judged `BLIND`, when not one of its cases
discriminated.

## Why you should believe a verdict

`npm test` runs eight fixture repos where the right answer is known by construction —
including three different shapes of blind test and two different shapes of unrunnable test.
**If `ca` cannot tell `02-blind-direction` from `01-caught-value`, it does not ship.**

The verdict engine is pure and has no I/O, so it is tested exhaustively. It also keeps a
control arm executing the naive exit-code implementation and asserting it still gets the
answers wrong.

That is the standard this tool asks of other people's tests, so it is the standard its own
suite is held to.

## Measured results

Three repositories, random draws, seeds recorded so the samples are reproducible.

| | a private monorepo | nodejs/undici | iamkun/dayjs |
|---|---|---|---|
| fix commits sampled | 300 | 25 | 40 |
| answerable | 214 | 15 | 25 |
| **CAUGHT** | **201 — 93.9%** | **12 — 80.0%** | **23 — 92.0%** |
| BLIND | 13 — 6.1% | 3 — 20.0% | 2 — 8.0% |
| INCONCLUSIVE | 86 | 10 | 9 |
| runtime | 7.1 s/commit | 24.9 s/commit | 1.4 s/commit |

The dayjs run (`--n 40 --since '6 years' --grep '^fix' --seed 11`) is the one worth
weighting: a codebase the author did not write, did not pick for a flattering result, and
could not tune against. 190 commits matched the subject filter; 99 ship both a test and a
source change; 40 were drawn from those.

**One usability trap found while running it.** `audit` defaults to a six-month window. On
a mature repo that silently shrinks the sample — the first dayjs run judged **5 commits
instead of 40** and printed a confident, meaningless 100%. The window *is* echoed in the
header line, so it is visible rather than hidden, but a `--n 40` that quietly returns 5
deserves a louder signal. Pass `--since` explicitly on any repo older than six months.

`INCONCLUSIVE` is 29% and 40% respectively. That is the honest denominator, not a rounding
error: a fix that adds an export its test imports cannot be replayed against the parent,
because the test will not load there. Those are excluded from the ratio rather than assumed
either way.

## How often is this tool wrong?

Ask any measuring instrument this. Here is the answer for this one, on the 300-commit run.

The raw headline was **13 `BLIND` commits**. After running arm C on each and checking them
by hand, **5 were real**:

| | |
|---|---|
| 13 | raw `BLIND` |
| −3 | `↻ REPAIRED SINCE` — the gap was closed after that commit |
| −2 | `? cannot tell` — the test file no longer exists at HEAD |
| −3 | category errors: two `fix(test):` (the bug WAS the test) and one build failure no unit test can catch |
| **5** | genuinely open, **2.3% of answerable commits** |

**A 62% false-positive rate on the raw number.** Arm C and the corpus filter exist because
of it. Publish the raw count and you hand someone thirteen tickets, eight of which waste
their afternoon.

## Every bug found in this tool so far

None were found by its own test suite. All were found by pointing it at real work.

| bug | found by |
|---|---|
| a slash in a test NAME silently dropped the case | random hand-audit of `BLIND` verdicts |
| skipped cases counted toward `BLIND` | hand-audit of the `BLIND` list |
| config and CI YAML not treated as source | a live PR it was asked to check |
| commit-vs-parent is wrong for a PR branch | a reviewer's suggested command |
| `.env` absent from worktrees → 955 phantom skips | getting a real database running |
| a historical `BLIND` is not an open defect | shipping a redundant ticket to a colleague |
| test detection required BOTH a `test/` dir AND a `.test.` suffix | first run on a repo the author did not write |

That last one returned **an entirely empty audit** on undici — 284 commits matched, zero
judged — because undici names its tests `test/client-request.js`. Not a wrong answer: no
answer.

**It is the argument for running this on somebody else's code before believing any number
it prints.**
