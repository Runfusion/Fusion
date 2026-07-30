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
`{ column: "<legacy id>" }` finds **79 sites** across `packages/`. It flags the two real `moves.ts`
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

**Named legacy-id collections** — `const X = ["done","archived"]` then `X.has(col)`. **48 declarations**,
and the raw count is misleading: on inspection they are all either

- the intentional fallback vocabulary the role helpers degrade to (`LEGACY_TERMINAL_COLUMNS`,
  `LEGACY_PLANNING_COLUMNS`, `LEGACY_PRE_IMPLEMENTATION_COLUMN_IDS`), or
- the builtin workflow's own column list (`DEFAULT_WORKFLOW_COLUMN_IDS`, `COLUMNS`), or
- **already-converted** seams that seed the legacy pair as a floor and then UNION the resolved lanes
  — `symbol-locks.ts` `terminalLanesFor` and `branch-group-ops.ts` `satisfiedColumns` both do exactly
  this, with the reasoning recorded at the site.

So the census's comparison-only scope is adequate for this codebase. Filing "48 uncounted sites"
would have been the same mistake as gating on `{ column: "<literal>" }` call arguments (79 sites,
mostly legitimate): a number that looks like a work list and is not.

**The rule:** measure a candidate surface, then inspect a sample, before reporting it OR instrumenting
it. A raw count is a hypothesis. The SQL surface survived this test — 14 sites, all genuinely
vocabulary-bound — and got a ratchet. These two did not, and got nothing, which is the correct
outcome and cost an hour to establish rather than a wrong gate to maintain.

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
2. **Prefer one unanchored pattern over a fast pre-filter plus a precise one.** Every false negative
   above came from two patterns disagreeing about whether to even run the real check. A pre-filter is
   a second, weaker specification of the thing you are testing.
3. **Treat a guard's own count as a claim to verify, not a result.** "14 sites" read as coverage for
   days; it was the subset one scanner happened to model.

A false positive is loud and gets fixed. A false negative prints a baseline and reads as coverage.

## The rule that produced every fix above

**A green guard is evidence only once you have watched it go red.**

Three separate guards written during this lane shipped green while catching nothing: one used a
`$`-anchored regex as a whole-file prefilter and scanned nothing; one checked whether a prop name
appeared anywhere, which the parent legitimately satisfied; one decided "is this the seam's own file"
from a flag any comment set. Every one was found by reintroducing the defect on purpose, and none
would have been found by reading the code.

If you add a ratchet, also add the assertion that fails when it finds NOTHING. A guard that cannot
fire is indistinguishable from a clean codebase.
