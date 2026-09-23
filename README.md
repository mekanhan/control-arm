# control-arm (`ca`)

**Does a test actually fail on the code it was written to catch?**

A test that cannot fail is decoration. Nothing in a normal CI pipeline can tell a test
that catches its bug from a test that would have shipped green either way — both are a
checkmark. `ca` tells them apart, by running the new test against the old code.

```bash
ca doctor                        # can this repo be measured?
ca verify <commit>               # one commit, per-case verdicts
ca audit --n 100 --out r.csv     # a random sample, with an honest denominator
```

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

**1. Exit code is not the signal.** A test that "fails" at the parent with
`SyntaxError: does not provide an export named 'TITLE_SEPARATOR'` — because the fix
*added* that export — exits non-zero and has told you nothing. It never ran. Read the exit
code only and your headline number is inflated garbage. The discriminator is
**assertion-failure vs. error-failure**, which every test runner reports and almost
nothing reads.

**2. Prove the control arm loaded the control arm's code.** On its very first real run
this tool reported `4 pass / 0 fail` on the parent — a BLIND verdict on one of the most
carefully tested commits in the target repo. The harness had symlinked the repo's whole
`node_modules` into the worktree, and workspace packages inside it are symlinks *relative
to the real repo*:

```
node_modules/@auctionmate/core -> ../../packages/core
resolved: file:///…/auctionmate-project/packages/core/src/bucket.js   ← today's code
```

Arm B never loaded the code under test. Every language has this trap somewhere (venvs,
module caches, classpaths). So `ca` asks the runtime where each of the test's imports
actually resolved and **refuses to answer** if any landed outside the worktree.

**3. A false BLIND is the worst output this tool can produce.** CAUGHT is good news;
INCONCLUSIVE is an honest shrug. BLIND accuses an engineer of writing a test that cannot
fail. Get it wrong once and nobody trusts the tool again. So **every ambiguity resolves
away from BLIND**, and the verdict is withheld rather than guessed.

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
(`NON-DISCRIMINATING`) and only a **commit** gets judged `BLIND`, when not one of its
cases discriminated.

## Verdicts

| level | verdict | meaning |
|---|---|---|
| case | `CAUGHT` | ran on the broken code and disagreed with it |
| case | `NON-DISCRIMINATING` | ran and was fine with it — a fact, not a fault |
| case | `INCONCLUSIVE` | never ran, or identity unproven |
| case | `FLAKY` | repeated runs disagreed |
| commit | `CAUGHT` | at least one case discriminates |
| commit | `BLIND` | every case ran, **not one** discriminated |
| commit | `INCONCLUSIVE` | excluded from the ratio rather than assumed |

`INCONCLUSIVE` is reported in its own column and never folded into the others. A
measurement that cannot tell ZERO from FAILURE is not a measurement.

## Why you should believe a verdict

`npm test` runs eight fixture repos where the right answer is known by construction —
including three different shapes of blind test and two different shapes of unrunnable
test. **If `ca` cannot tell `02-blind-direction` from `01-caught-value`, it does not
ship.** The verdict engine is pure and has no I/O, so it is tested exhaustively; it also
keeps a control arm executing the naive exit-code implementation and asserting it still
gets the answers wrong.

That is the standard this tool asks of other people's tests, so it is the standard its own
suite is held to.

## Scope, stated plainly

- **A test can only be judged against the bug it was written for.** No fix commit, no
  broken code, no verdict. The measurable universe is fix commits that shipped a test.
  For tests with no such pairing, the instrument is mutation testing, not this.
- One runner today (`node:test`). The runner seam is isolated in `src/runner.mjs`;
  the decision logic never sees runner output.
- `ca` never touches your working tree — no `stash`, no `checkout` in your clone.
  Everything happens in detached worktrees under `.ca-work/`.

MIT.
