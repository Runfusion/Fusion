---
category: workflow-learnings
module: scripts/lifecycle-column-census
tags: [lifecycle-columns, census, conversion, guards, measurement]
problem_type: measurement-hazard
applies_when: converting a lifecycle-column literal to a resolved-role read
---

# The conversions that break the code and improve the number

Recorded 2026-07-30 from the u12 lane of the workflow-owned-lifecycle program, after five of nine
conversions in one reviewed-and-green tranche turned out to do nothing. Written for whoever works the
remaining ~240 guards.

## The shape

The census counts COMPARISONS against legacy column ids. A conversion removes the comparison. So any
change that removes the comparison scores as progress — including changes that remove the guard and
put nothing in its place.

Three ways that happened here, all of which passed `tsc`, the full suite, and `--strict`:

**1. The resolved value never arrives.** A parameter or prop is added and no caller supplies it.
```ts
export function isTaskStuck(task, timeoutMs, dataAsOfMs, columnFlags?) { … }
isTaskStuck(task, timeoutMs, lastFetchTimeMs);        // every caller. Always undefined.
```
Also as props: declared in `XProps`, passed by the parent, and never destructured by `X`.

**2. The resolver cannot resolve.** `resolveTaskWorkflowIrSync` returns the DEFAULT workflow IR for
every task in production — its selection reader is a PostgreSQL-cutover stub returning `undefined`
unconditionally — and its return type is non-optional, so no caller can detect the substitution. A
guard resolved through it reads as converted and answers with legacy ids forever. Proven in
`core/src/__tests__/postgres/sync-workflow-ir-is-always-default.pg.test.ts`.

**3. The census cannot see the other half.** It counts comparisons, so a move TARGET
(`moveTask(id, "todo")`) is invisible. Converting a classifier while leaving its target turned a
silent no-op into a hard `TransitionRejectionError`, with the file reading 0 guards.

## Why review, tests and types all miss it

- `tsc` — the parameter is optional, so omitting it is legal.
- Tests — the fallback IS the previous behaviour. That is what the fallback is for.
- The census — down by one, correctly, by its own definition.
- Grep — finds the symbol in exactly the places you added it, and says nothing about flow.

## What to do instead

**Trace the value from the render/call site down, not from the declaration out.** Compiling proves
the type exists; it does not prove anything passes it.

**Wire a supplier, or delete the seam and leave the literal counted.** An unsupplied optional
parameter is strictly worse than the literal it replaced: the literal is honest and keeps the census
pointing at real work. Three of the five above were reverted for exactly this, and the package count
went from a reported 2 back up to 6. Six was the true number.

**Convert a gate and its destination together.** If the guard decides something, find what acts on
the decision.

## The guards, and their limits

- `scripts/check-inert-flag-seams.mjs` — trailing lane/flag parameter with no supplier (gate).
- `packages/dashboard/app/__tests__/resolved-flags-seams-have-suppliers.test.ts` — the props shape.

Both match by NAME, which leaves two known ways to mislead: they prove only that ONE caller supplies
(not all — a real defect got through this), and they exclude `__tests__`, so test-only exports look
unsupplied.

## A false positive you have learned to ignore will hide a true one

The third way was imported shadows: two same-named functions in different modules conflated. It cost
a wrong "fix" that `tsc` rejected and a bad list sent to two other batches, and I wrote it down as a
known limitation — reports mentioning `sortTasksForDisplayColumn` are noise, read past them.

That annotation was the actual damage. Core's `sortTasksForDisplayColumn` really never receives its
`columnFlags` argument outside its own tests; the dashboard function of the same name, called with
more arguments from three components, was raising the arg-count max and clearing core's seam. The
offender had been sitting behind a row everyone had been told to skip. Resolving imports (record the
module each callee is imported FROM, match it against the seam's declaring module) surfaced it
immediately.

So: a guard's false positives are not a cosmetic problem to be documented around. Each one trains its
readers to skip a line, and the skipped line is where the next real finding appears. Fix the noise or
delete the guard.

The cost argument that kept this open for days — "import resolution is not worth it until a report is
wrong in a way that costs more than reading it carefully" — was already false when written. The
report had by then been wrong twice, both times expensively. Re-read that kind of deferral whenever
the thing it defers has since happened; nothing prompts you to.

## A fourth shape: supplying the WRONG flags

The three shapes above are all omissions — no supplier, one supplier, a supplier only in tests. The
fourth is worse, because it looks finished: flags are supplied, they are the wrong ones, and it
type-checks.

Two real instances, both from live work:

**The union read.** `ListView` passed `columnFlagsById.get(task.column)` into a per-task guard, with
the comment "this list already owns `columnFlagsById`". That map is a UNION across every workflow,
keyed by column id. For a task whose own workflow does not declare that column, it returns a
NEIGHBOUR workflow's traits — so the guard does not degrade to the legacy answer, it asserts a role
the card's board never granted. Use the per-task accessor; it falls back to absent flags on purpose.

**The other task's flags.** In `TaskDetailModal`, `detailColumnFlags` describes the open task. A call
asking about the near-duplicate CANONICAL — a different task, on a column the component never
resolves — would have compiled fine with those flags passed in, counted as a conversion, and answered
about the wrong row. A note at that site had recommended exactly that, on the reasoning that the
flags were "already in this component."

Both justifications sound like the conversion is *more* correct than the literal. The test:

> Do these flags describe the column of the row this guard is about?

If the guard asks about task B while the flags describe task A, supplying them is worse than omitting
them. An omission degrades to the legacy id, which is at least the OLD behaviour. Wrong flags are new
behaviour that nobody chose.

## A fifth shape: the consumer is converted and the PRODUCER passes a literal

Found in MY OWN shipped fix, by the operator reviewing it — the sharpest instance in this document
because every instrument here reported it as done.

The PURE predicate `isNearDuplicateCanonicalInactive` was converted to take the canonical's resolved
column flags, and its test proved that by supplying `column: "shipped"`. Meanwhile both production
call sites in `moves.ts` gated on the RESOLVED complete lane and then passed the literal
`column: "done"` — and the store wrapper `clearNearDuplicateReferencesToImpl` called the predicate
with no flags at all, so even a correct producer would not have reached the converted branch.

Be precise about which layer was converted, because the imprecision is the same defect one level up:
the *predicate* was converted; the *call site* and the *producer* were not. PR #2823 converts both —
until it lands, `branch-group-ops.ts` still invokes the predicate flagless on `main`.

The consumer contract was correct, the producer was never converted, and the hand-supplied fixture
value is exactly what hid it.

Why nothing caught it:

- the **census** counts comparisons, and a value passed as an argument is not a comparison;
- the **seam check** asks whether callers SUPPLY the argument — these did, with a literal;
- the **test** supplied the interesting value itself, so it exercised the consumer and never the
  producer.

Worse, driving the flow end to end still did not distinguish them: the consumer looks the passed
column up in the canonical's IR, finds nothing for `done` on a renamed board, and falls through to
the LEGACY predicate where `done` IS terminal. Right answer, wrong reason. It only bites on a board
that DECLARES a `done` column WITHOUT the complete trait — then the literal resolves real flags,
learns `done` is not terminal there, and strands every marker.

**The rule: a differential test must vary the value the PRODUCTION code computes, not one the test
hands in.** If your fixture passes the lane name, you have tested the consumer. Ask separately who
computes that argument in production, and whether they compute it or spell it.

MEASURED, so nobody builds the wrong instrument: an AST probe for a call argument
`{ column: "<legacy id>" }` found **79 sites** across `packages/` when measured on 2026-07-30 (42 as
of 2026-07-31, after the analytics conversions landed — the ratio is the point, not the total). It flags the two real `moves.ts`
offenders, but most of the rest are legitimate — `set({ column: "archived" })` writing the archive
state, `listTasks({ column: "todo" })` filtering a query. A blocking gate on this shape needs a
curated list of consumers that interpret the column as a ROLE (as opposed to storing or filtering
it), which is a judgment call per consumer rather than a mechanical check. Recorded rather than
built.

## Surfaces that were checked and are CLEAN — do not re-probe these

Negative results, recorded so the next person does not spend a session rediscovering them. Each was
a plausible "the census cannot see this" theory; each was measured.

**Membership tests with inline literals** — `["done","archived"].includes(task.column)`. The census
counts binary comparisons only, so this shape would be invisible. **Zero sites.** Nobody writes it.

**Named legacy-id collections** — ~~clean~~ **THIS ENTRY WAS WRONG, and it hid two real defects.**

It counted DECLARATIONS (48 on 2026-07-30, 49 on 2026-07-31) and concluded the population was benign
because each declaration is a fallback vocabulary, a builtin column list, or an already-converted
seam. All true of the declarations, and the declaration is not where the defect lives.

**Measure the USE, not the declaration: a collection used as a MEMBERSHIP GATE against a column.**
Nine of those exist (2026-07-31), and two were live defects that this entry had explicitly told the
next reader not to re-probe:

- `TIME_INDICATOR_COLUMNS.has(task.column)` in `TaskCard` — the elapsed-time indicator never rendered
  on a renamed board, and the fix for the *subscription* one seam earlier did not make it visible;
- `PLANNER_ACTIVITY_COLUMN_IDS.has(task.column)` in `useTasks` — the planning border and pulsing
  badge never appeared, because the stamp every consumer filters was never written.

The other seven are genuinely fine, and the reasons are worth keeping because they are the shapes to
recognise: the no-flags fallback INSIDE a role helper (`columnRoles.ts`, `useSessionFiles.ts`), a
seam that seeds the legacy pair and then UNIONs resolved lanes (`branch-group-ops.ts`), a marked
`DELIBERATE-LITERAL` fallback chain (`DocumentsView.tsx`), and a plugin with no trait source at all
(same class as the dependency-graph gap).

The tell separating the two groups is one question: **does a flags path exist in this file at all?**
Both defects had none — the gate was the only decision, with nothing to degrade from.

A "do not re-probe" note that is wrong is worse than no note, because it converts one person's
incomplete measurement into everybody's blind spot. That is the same failure this document already
records for `sortTasksForDisplayColumn`, one level up: there an annotation told readers to skip a
ROW, here it told them to skip a POPULATION.

**`switch (task.column)` with legacy `case` labels** — a `SwitchStatement` is not a `BinaryExpression`,
so the comparison walk cannot see it. **Zero sites**, measured 2026-07-30. The codebase dispatches on
column with `if`/ternaries, not `switch`.

**A legacy id hoisted into a single const**, then compared — `const LANE = "done"; task.column === LANE`.
This is the exact shape that HAD a real population in SQL (see the const-resolution fix to
`check-sql-column-literals`), so it was worth measuring on the TypeScript side rather than assuming
the answer carried over. **One site**, and it is correct code: `self-healing.ts` seeds
`let holdColumn = "todo"` as its documented legacy floor and then overwrites it from
`resolveLifecycleColumns(...).hold`. The census is right not to flag it; a naive version of this probe
reports it as a defect.

So the census's comparison-only scope is adequate for this codebase. Filing "48 uncounted sites"
would have been the same mistake as gating on `{ column: "<literal>" }` call arguments (79 sites,
mostly legitimate): a number that looks like a work list and is not.

The same conclusion does NOT transfer between instruments. Three of these shapes are empty in
TypeScript while the equivalent shape in SQL was live — the population is a property of how people
write that particular kind of code, so each instrument has to be measured on its own.

**The rule:** measure a candidate surface, then inspect a sample, before reporting it OR instrumenting
it. A raw count is a hypothesis. The SQL surface survived this test and got a ratchet; these two did
not, and got nothing, which is the correct outcome and cost an hour to establish rather than a wrong
gate to maintain.

CORRECTION, 2026-07-31. This paragraph used to read "the SQL surface survived this test — 14 sites,
all genuinely vocabulary-bound". Both halves were wrong within a day. The population was 31 once the
scanner stopped missing Drizzle-templated queries, and hand-reading split it into roughly fourteen
lane-bound sites, eleven `archived` comparisons (three of them CORRECT as literals — they read a
state, not a lane), one in dead code, and five that the hand-read simply did not reach before the
paragraph was written.

The arithmetic not adding up (14 + 11 + 1 = 26, not 31) is itself the point and is left visible rather
than tidied: the categories came from reading, the total came from the tool, and the gap is the part
of the population nobody had classified yet. A tidied version would have implied a complete audit that
had not happened — which is the exact failure this section is about. Writing "all genuinely vocabulary-bound" was the same
mistake this section warns about, committed in the sentence that warns about it.

## Guards start catching other people's work, not just yours

Every guard in this lane was written after a defect I had shipped, so for a long time they only
re-caught my own mistakes — which is weak evidence, since I was also the one deciding what to test.

The first real signal came from a routine merge with `main`: the per-task-flags ratchet failed on two
call sites another worker had landed, the seam check flagged two more partially-supplied conversions,
and an exemption I was carrying self-retired because its staleness check noticed the seam had been
wired upstream.

That is the point at which a ratchet has earned its keep. Until a guard has failed on code you did
not write, you know it encodes your habits; you do not yet know it encodes the invariant.

## Mutation testing has one blind spot: your own imagination

Everything above says "watch the guard go red before you trust it." That rule is necessary and it is
not sufficient, and the way it fails is worth stating because it cost the most.

Three instruments were written during this program, each mutation-tested in both directions before
shipping, each green. Reviewers then found, in those same instruments:

- a file-level pre-filter that skipped whole files, so a forbidden site added to a file with no other
  SQL was invisible;
- an anchored pattern that missed qualified and compound fragments (`t."column" = 'done'`);
- a scan over SOURCE text, where a double-quoted TS string still spells `\"column\"` with the
  backslashes in it;
- an operator list of `= != <>` that never considered `IN (...)`;
- and worst, a template scan that joined only the STATIC spans — so a Drizzle query, which puts the
  COLUMN in the interpolation hole and the legacy id in the static text, matched nothing. **That gate
  was blind on the exact files it was built to freeze.** Enabling that one shape revealed five
  previously invisible files and took the population from 14 to 31.

Every one of those is a FALSE NEGATIVE, and none was catchable by the mutation tests that were run,
for a structural reason: **a mutation you write is a mutation you already imagined, so it lands
inside the space your scanner understands.** Reintroducing a defect the checker was designed around
proves the checker still handles that defect. It says nothing about the shapes you never modelled.

What actually finds these:

1. **Run the instrument against the code it was written for, and read the hits by hand.** The Drizzle
   blindness was visible the moment someone asked "why is the merge-queue query, the reason this
   exists, not in the output?"
2. **Separate the two causes, because they have different fixes.** Only the first defect above is a
   pre-filter problem: two patterns disagreeing about whether to run the real check, where the cheap
   one is a second, weaker specification of the thing you are testing. Delete it and run the real
   pattern everywhere. The other four — the anchored fragment, the raw-source scan, the missing `IN`,
   the static-span join — are single-pattern defects: the pattern was the only specification and it
   simply did not describe the shape. No amount of restructuring finds those; only running the
   instrument against real code does (see 1). Conflating them is tempting because they all present as
   "the guard is green and the site is there", and it sends you refactoring when you should be
   reading output.
3. **Treat a guard's own count as a claim to verify, not a result.** "14 sites" read as coverage for
   days; it was the subset one scanner happened to model.

A false positive is loud and gets fixed. A false negative prints a baseline and reads as coverage.

### A sixth shape: the resolved value arrives, and a memo has already answered

Three defects in one session, all the same shape and none visible to any instrument here.

A lane value resolved asynchronously — the board fetches workflow traits after first paint — is read
inside a `useMemo`/`useCallback` whose dependency list omits it. The first computation runs with the
flags `undefined`, the role helpers correctly fall back to the legacy ids, and on a RENAMED board
that answer is wrong. When the flags arrive nothing in the dependency list has changed, so the memo
never recomputes and the pre-load answer stands.

A legacy board hides it completely: there the fallback already answers correctly on the first paint,
so the stale list costs nothing. **Every instance is renamed-board-only**, which is why they
accumulated. This repo also has no `react-hooks/exhaustive-deps` rule, so the class is invisible to
lint, and a disable directive for that rule fails CI.

Found: the blocker fan-out map (empty trait index, permanent), the card's live elapsed-time indicator
(never subscribed, permanent), and the near-duplicate chip (stale closure, bounded).

**Two properties decide severity, and both are checkable by reading the dependency list:**

1. **Does any dependency refresh quickly?** `allTasks` or a task identity rebuilds the closure on the
   next update, so the wrong answer is a bounded window rather than permanent. The near-duplicate
   chip keys on `allTasks` and self-heals on the next task refresh; the time indicator keys on
   `task.column`, which never changes, so it never recovers.

   **A CLOCK-SHAPED DEPENDENCY IS NOT AUTOMATICALLY A FAST ONE — read its cadence, not its name.**
   I classified `lifecycleDates` as bounded on the strength of a `lifecycleNowMs` dependency and
   deferred it. That value is driven by a LOCAL-MIDNIGHT boundary timer, one tick per card per day,
   so a finished card shows no completion date for up to twenty-four hours. The operator found it
   after I had written it off. `nowMs`, `Ticker` and `lastFetchTimeMs` span a live 30-second ticker,
   a per-fetch stamp and a daily boundary; sorting them by name puts a day-long defect in the same
   bucket as a 30-second one.

   The interaction is worth keeping too: a card in a completion lane does not subscribe to the shared
   live ticker at all (that is what the ticker's own eligibility check is for), so the "fast"
   dependency that would have rescued it is the one thing it never receives. Ask which dependencies
   refresh FOR THIS POPULATION, not which ones exist in the list.
2. **Is the value covered TRANSITIVELY?** A dependency that itself lists the flags gets a new
   identity when they arrive, which propagates. `TaskCard`'s context-menu memo omits all three role
   flags and is nonetheless correct, because it depends on `taskActionMenuModel.actions` and that
   model lists `taskColumnFlags`. Reading the dependency list alone reports this as a defect.

**A gate for this was built and rejected.** A scanner for "memoized hook reads a lane value absent
from its deps" reports 19 sites; two were real. Property 2 is the reason — transitive coverage is
invisible to any purely syntactic check, and would need a real dependency graph to resolve. Freezing
19 would have baselined mostly noise and trained everyone to skip the report, which is the failure
this document already records for `sortTasksForDisplayColumn`. The scanner is a good investigative
tool and a bad ratchet; the distinction is worth keeping.

The triage that does work is cheap: run the scan, then for each hit ask the two questions above. Nine
of the nineteen survive question 1; hand-checking those is an afternoon, not a project.

### A deferral's stated blocker is a claim, and it decays the same way a measurement does

Two pieces of work were filed rather than fixed in one session, each with a specific technical reason.
Both reasons were wrong, and in both cases the real obstacle was smaller than the stated one.

- **"The plugin has no scaffolding for faking its stores."** It had `_harness.ts`, building a real
  `PluginContext` over a live PostgreSQL layer. The gap was two missing readers on a stub — additive,
  and inert for every existing suite. The filed issue was a pipeline that stalls forever on a renamed
  board, so the cost of that excuse was a real stall sitting open behind a plausible-sounding note.
- **"Supplying this needs a published-API change."** The type was dashboard-internal and the SDK
  package is `private: true`. Every consumer was in-repo. Building the chain took minutes and
  surfaced a different, smaller obstacle: the plugin compiles against stale dashboard type
  declarations, which is build plumbing rather than an API decision.

The shape is the same both times: **the blocker was asserted from the shape of the problem rather than
tested.** "This needs infrastructure that does not exist" and "this crosses a published boundary" are
both checkable in about five minutes, and neither was checked before writing a paragraph explaining
why the work could not proceed.

Filing is often right — someone else owns the contract, the fix needs a decision, the data genuinely
is not there. What makes it wrong is filing on an *untested* blocker, because a filed issue with a
confident rationale is the one thing nobody re-derives. It reads as settled. That is the same
mechanism as a stale "do not re-probe" note, one level up: there a measurement went stale, here a
decision did.

The rule that costs nothing: **before writing the blocker down, spend five minutes trying to hit it.**
If it is real you will hit it immediately and can describe it precisely, which makes the issue more
useful. If it is not, you have the fix instead of the issue.

### The probe harness lies more often than the gate does

Probing four gates with unimagined shapes in one session produced **two rounds of silently invalid
results**, each from the harness rather than the instrument, and each agreeing with what was expected
— which is why neither was noticed on the spot.

1. **`node gate.mjs | tail` then `echo $?` reads `tail`'s exit status, not the gate's.** Every probe
   reported "caught". The gate was in fact failing on `main` for an unrelated reason, so the runs
   proved nothing about the probes at all. Capture the status into a variable before any pipe.
2. **A gate that lists files with `git ls-files` cannot see an untracked probe file.** Six census
   probes all reported "missed", including the shape the census is explicitly built for — the tell
   that the harness, not the instrument, was broken. Gates that walk the filesystem
   (`check-sql-column-literals`, `check-inert-flag-seams`) see untracked files; the census does not.
   `git add -N` the probe, then reset it.

The general rule: **a probe run needs its own control.** Include one shape the instrument is known to
catch and one it must not flag. If the known-good shape does not come back caught, stop — you are
measuring your harness. Both failures above would have been caught immediately by that single check,
and in the second case the control is what exposed it.

This matters more than it sounds. A probe that wrongly reports "caught" retires a real hole; a probe
that wrongly reports "missed" sends you rewriting an instrument that was already correct. The first
nearly shipped a double-counting change to the SQL gate, on evidence that was entirely fictional.

### A seventh shape: reusing an ALREADY-RESOLVED local, without checking what resolved it

The three inert conversions this program had catalogued (#3051, #3062, #3068) all called
`resolveTaskWorkflowIrSync` **at the call site**, where the sync resolver is visible in the diff. The
fourth did not, and it is mine: #3114 converted a `triage.ts` arm to `disposeLanes.wip`, reusing a
value `resolvePlannerLanes` had already produced a few lines above. It landed, and `main` went red on
`check-inert-sync-lanes` (`triage.ts: 7 -> 8`).

My stated reasoning, verbatim: *"`resolvePlannerLanes` already called immediately above — no new
resolution/await."* That sentence checks the cost question and skips the correctness one. I confirmed
I was adding no `await` to a synchronous listener — the usual blocker — and never asked what kind of
resolver had produced the local I was reusing.

**Reusing an existing resolved value reads as strictly safer than resolving.** No new work, no new
await, no new failure mode; the resolution is a fait accompli. That intuition is correct about cost
and silent about correctness, and the sync-ness sits one hop away inside the helper, where a
call-site reviewer will not see it.

So the check is not "am I calling a sync resolver here?" but **"what produced every lane value I am
about to compare against, transitively?"** A local is not evidence of anything; the resolver behind it
is. #3122 widened the gate to follow wrappers for exactly this reason — and I walked through the door
it was widened to cover, in the same phase I was adding it.

Two corollaries worth keeping:

- **A gate that catches the defect but does not block is a report.** This fired correctly and the PR
  merged anyway, because `check:inert-sync-lanes` was not in the blocking set (being fixed in #3127).
  That is the second time in one phase that a correct non-blocking signal was ignored.
- **The remaining count is not backlog.** Reverting the arm takes `triage.ts` to 7, and those seven
  are the same shape — they need the emitter-side / async-threading work, not another conversion pass.
  `--claims` now marks sync-resolver files as inert-risk and keeps them out of the start-here list.

## A blocker described four times, wrong twice: instrument before you file

One `triage.ts` site sat flagged as unconvertible for four cycles. Each cycle produced a confident
mechanism, and the mechanisms split cleanly by method:

| # | claimed mechanism | derived from | held? |
|---|---|---|---|
| 1 | merged intake/hold vocabularies | reading | no |
| 2 | the orphan arm is scoped to `source === "selection"` | reading + one test run | partly |
| 3 | provenance verifies by `ir.id`, which builtins lack | reading a **comment** | **no — filed as an issue, closed as wrong** |
| 4 | two test harnesses cannot answer a selection query | instrumented isolation | **yes** |

Mechanism 1, derived from reading, was wrong outright; mechanism 2, derived from reading plus a
single test run, held only partly — the arm is scoped as claimed, but that scoping was not what made
the conversion fail. Neither reading-derived claim survived intact. The one derived from a comment was wrong in the most
expensive way: the text quoted was historical prose explaining code that had been REMOVED, sitting
directly above a paragraph saying so. A rationale was read as an implementation.

**The isolation that settled it took three runs and about a minute:**

```text
flag only, no conversion             8 passed   -> the orphan arm is not the cause
flag + conversion                    5 failed   -> the conversion is
same, with a realistic mock store    8 passed   -> the mock was the cause
```

That is the whole technique: change one variable at a time and let the suite answer. It was available
from cycle one.

### Why this is not just "test more"

Every wrong mechanism was *plausible*, *specific*, and *consistent with the code as read*. Plausibility
is what made them dangerous — each one was good enough to write down, publish, and act on. The failure
mode is not sloppiness; it is that a careful reading of a large file feels like evidence and is not.

The tell is grammatical: **if a claim can be written without running anything, it has not been tested.**
Statements like "this cannot be converted because X" are hypotheses. Statements like "reverting X fails
these 3 of 8 cases" are measurements. This document is full of the second kind because the first kind
kept being wrong.

### The corollary that found real bugs

Once the harness was the suspect rather than the code, a class fell out: **a test that stubs a reader
which is broken in production proves the call site's logic while being unable to see that production
resolves nothing.** Eight files stubbed `resolveTaskWorkflowIrSync`. Auditing them — delete the stub,
see whether the suite still discriminates — classified six: one masking a live defect, four redundant,
one legitimate. The other two are unaccounted for in this write-up — the outcomes were not recorded
at the time, and inventing a classification now would be the same unearned confidence this document
is about. Either eight is the wrong total or two audits went unrecorded; whoever re-runs the audit
should treat the six as the only claim it supports.

The distinguishing property is narrow, and worth stating because the obvious generalisation fails:
the reader must return something **incorrect**, not merely **unused**. `getTaskWorkflowSelection` is
also degraded under PostgreSQL, and stubbing it masks nothing, because the resolver simply prefers the
async twin and both answer the same. Measured: 120 files stub it; adding the async twin to the
highest-signal one changed nothing.

## The rule that produced every fix above

**A green guard is evidence only once you have watched it go red.**

Three separate guards written during this lane shipped green while catching nothing: one used a
`$`-anchored regex as a whole-file prefilter and scanned nothing; one checked whether a prop name
appeared anywhere, which the parent legitimately satisfied; one decided "is this the seam's own file"
from a flag any comment set. Every one was found by reintroducing the defect on purpose, and none
would have been found by reading the code.

If you add a ratchet, also add the assertion that fails when it finds NOTHING. A guard that cannot
fire is indistinguishable from a clean codebase.
