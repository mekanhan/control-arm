# control-arm (`ca`)

**Does a test actually fail on the code it was written to catch?**

## In plain words

When you fix a bug, you usually add a test so it can't come back. Everyone does this.
**Nobody ever checks whether that test would actually have caught the bug.**

This checks. It takes the test you wrote, rewinds your code to just before the fix, and
runs the test there. Red means it works. Green means it was never capable of catching
anything — it just sits in your suite looking like protection.

It does not write tests, and there is no AI in it. It runs your tests and reports what
happened.

### Two tests for the same bug

```js
// A
assert.equal(priority('HIGH-PRIORITY'), 1);

// B
const p = priority('HIGH-PRIORITY');
assert.ok(p);                 // any number but 0 is truthy
assert.ok(SLA_HOURS[p] > 0);  // 24 > 0 is true
```

The bug: `priority()` matched `HIGH PRIORITY` with a space but not `HIGH-PRIORITY`
with a hyphen, so an urgent ticket came back as normal.

On the fixed code both pass. On the broken code **A fails and B still passes** — because
the wrong answer, 2, is also truthy and also has a positive SLA. In CI they are identical:
two green checkmarks. That is the gap.

### "My tests are all green. So what happens?"

Green tells you nothing here, because **both arms start green.** A passing suite is the
starting condition, not the result. The tool re-runs those same green tests against the
broken code and watches which ones *break*.

On a healthy commit you see one or two `CAUGHT` and a pile of `NON-DISCRIMINATING` — and
that is the **good** outcome. One test was aimed at the bug; the rest were guarding other
things. The only worrying result is a commit where *nothing* caught it.

### Which of your tests does it look at?

It does not care what *kind* of test it is, only whether the runner can execute the file.

| kind | covered | why |
|---|---|---|
| unit tests | yes | the easy case |
| backend / server logic | yes | same runner, same rewind |
| database-backed tests | yes | needs a live DB, else they report SKIPPED |
| component tests (React / RN) | yes | via vitest and jest |
| browser e2e (Playwright) | **no** | no Playwright runner yet |
| performance / load | **no** | they measure speed, not correctness |
| manual QA | **no** | nothing to execute |

Mostly unit tests in practice, but not only — anything `node --test`, `vitest` or `jest`
can run, including tests that talk to a real Postgres.

---

A test that cannot fail is decoration. Nothing in a normal CI pipeline can tell a test
that catches its bug from a test that would have shipped green either way — both are a
checkmark. `ca` tells them apart, by running the new test against the old code.

## Try it in two minutes

No setup, no config, nothing to install — it has no dependencies.

```bash
git clone https://github.com/mekanhan/control-arm && cd control-arm

# 1. Can this repo be measured at all?
node bin/ca.mjs doctor --repo .

# 2. Judge one commit. This one is control-arm's own bug fix.
node bin/ca.mjs verify 1845c1d3 --repo .
```

You get:

```
  1845c1d3  fix: a SKIPPED case blocks BLIND
  ✓ module identity verified

  LEGEND   ✓ fails without the fix (this test works)   – green either way (a guard looks like this)
           ⚠ could not run on the old code   ~ flaky   · skipped by the runner

  test/verdict.test.mjs
    ✓ CATCHES IT    rollUp: a SKIPPED case blocks BLIND
    – green either way  rollUp: one discriminating case carries the commit
              └ asserts an exact expected value — most likely a deliberate regression guard

  VERDICT  ✓ CAUGHT
           1 test here would have caught this bug. The rest are guards or could not run.
```

**Read it like this:** one test was aimed at the bug and genuinely catches it. The other
fourteen stay green either way — which is what a regression guard is *supposed* to do.
That mix is the healthy outcome. The result to worry about is `✗ BLIND`: nothing in the
commit fails on the broken code.

Then point it at your own repo:

```bash
node bin/ca.mjs verify <any-fix-sha> --repo ~/path/to/your-repo
node bin/ca.mjs audit --repo ~/path/to/your-repo --n 30 --html report.html
```

## Then: the PR check

The primary use. It runs in seconds, it is deterministic, and it puts the answer where the
decision is made.

```yaml
# .github/workflows/control-arm.yml
- uses: mekanhan/control-arm@master
  with:
    base: develop          # compares against the MERGE BASE with this, never its tip
    comment: 'true'        # one comment per PR, edited in place
    fail-on-blind: 'false' # advisory by default — see below
```

It posts this:

```
### `control-arm` — this branch is proven

**3 of 4 cases cannot pass without this change.**

| | case | on the base |
|---|---|---|
| ✅ | MUTGATE-001: a scheduled workflow runs the mutation suite | mutation.yml is missing — nothing runs mutation testing |
| ⚪️ | MUTGATE-003: every mutated file exists | _green on both — a regression guard looks like this too_ |
```

**`fail-on-blind` is false by default, deliberately.** A PR may legitimately ship only
regression guards, and a gate that fires on those is switched off within a week. This
comments; a person decides. Turn it on only where every fix genuinely must ship a
discriminating test.

### Everything else

```bash
ca doctor                        # can this repo be measured?
ca verify <commit>               # one commit, per-case verdicts
ca verify <tip> --against main   # a whole branch, against its merge base
ca audit --n 100 --html r.html   # a random sample, with an honest denominator
```

The audit is the interesting one and the slow one — roughly 8s per commit, so a 300-commit
sample is a nightly job, not a check.

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
node_modules/@acme/core -> ../../packages/core
resolved: file:///…/the-repo/packages/core/src/parser.js   ← today's code
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

## Measured results

Two repositories, random draws, seeds recorded so the samples are reproducible.

| | a private monorepo | nodejs/undici |
|---|---|---|
| fix commits sampled | 300 | 25 |
| answerable | 214 | 15 |
| **CAUGHT** | **201 — 93.9%** | **12 — 80.0%** |
| BLIND | 13 — 6.1% | 3 — 20.0% |
| INCONCLUSIVE | 86 | 10 |
| runtime | 7.1 s/commit | 24.9 s/commit |

`INCONCLUSIVE` is 29% and 40% respectively. That is the honest denominator, not a rounding
error: a fix that adds an export its test imports cannot be replayed against the parent,
because the test will not load there. Those are excluded from the ratio rather than
assumed either way.

## How often is this tool wrong?

Ask any measuring instrument this. Here is the answer for this one, on the 300-commit run.

The raw headline was **13 BLIND commits**. After running arm C on each and checking them
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

Every bug found in this tool so far was found by pointing it at real work, and **none by
its own test suite**:

| bug | found by |
|---|---|
| a slash in a test NAME silently dropped the case | random hand-audit of BLIND verdicts |
| skipped cases counted toward `BLIND` | hand-audit of the BLIND list |
| config and CI YAML not treated as source | a live PR it was asked to check |
| commit-vs-parent is wrong for a PR branch | a reviewer's suggested command |
| `.env` absent from worktrees → 955 phantom skips | getting a real database running |
| a historical `BLIND` is not an open defect | shipping a redundant ticket to a colleague |
| test detection required BOTH a `test/` dir AND a `.test.` suffix | first run on a repo the author did not write |

That last one returned **an entirely empty audit** on undici — 284 commits matched, zero
judged — because undici names its tests `test/client-request.js`. Not a wrong answer: no
answer. It is the argument for running this on somebody else's code before believing any
number it prints.

## Scope, stated plainly

- **A test can only be judged against the bug it was written for.** No fix commit, no
  broken code, no verdict. The measurable universe is fix commits that shipped a test.
  For tests with no such pairing, the instrument is mutation testing, not this.
- One runner today (`node:test`). The runner seam is isolated in `src/runner.mjs`;
  the decision logic never sees runner output.
- `ca` never touches your working tree — no `stash`, no `checkout` in your clone.
  Everything happens in detached worktrees under `.ca-work/`.

MIT.
