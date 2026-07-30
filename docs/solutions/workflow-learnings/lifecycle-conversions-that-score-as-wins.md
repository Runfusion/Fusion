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

`clearNearDuplicateReferencesTo` was converted to resolve the canonical's column flags, and its test
proved that by supplying `column: "shipped"`. Both production call sites in `moves.ts` gated on the
RESOLVED complete lane and then passed the literal `column: "done"`. The consumer was correct, the
producer was never converted, and the hand-supplied fixture value is exactly what hid it.

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

## Guards start catching other people's work, not just yours

Every guard in this lane was written after a defect I had shipped, so for a long time they only
re-caught my own mistakes — which is weak evidence, since I was also the one deciding what to test.

The first real signal came from a routine merge with `main`: the per-task-flags ratchet failed on two
call sites another worker had landed, the seam check flagged two more partially-supplied conversions,
and an exemption I was carrying self-retired because its staleness check noticed the seam had been
wired upstream.

That is the point at which a ratchet has earned its keep. Until a guard has failed on code you did
not write, you know it encodes your habits; you do not yet know it encodes the invariant.

## The rule that produced every fix above

**A green guard is evidence only once you have watched it go red.**

Three separate guards written during this lane shipped green while catching nothing: one used a
`$`-anchored regex as a whole-file prefilter and scanned nothing; one checked whether a prop name
appeared anywhere, which the parent legitimately satisfied; one decided "is this the seam's own file"
from a flag any comment set. Every one was found by reintroducing the defect on purpose, and none
would have been found by reading the code.

If you add a ratchet, also add the assertion that fails when it finds NOTHING. A guard that cannot
fire is indistinguishable from a clean codebase.
