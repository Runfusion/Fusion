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

## The rule that produced every fix above

**A green guard is evidence only once you have watched it go red.**

Three separate guards written during this lane shipped green while catching nothing: one used a
`$`-anchored regex as a whole-file prefilter and scanned nothing; one checked whether a prop name
appeared anywhere, which the parent legitimately satisfied; one decided "is this the seam's own file"
from a flag any comment set. Every one was found by reintroducing the defect on purpose, and none
would have been found by reading the code.

If you add a ratchet, also add the assertion that fails when it finds NOTHING. A guard that cannot
fire is indistinguishable from a clean codebase.
