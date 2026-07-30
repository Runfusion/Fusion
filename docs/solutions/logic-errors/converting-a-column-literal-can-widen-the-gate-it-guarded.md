---
category: logic-errors
module: "@fusion/engine, @fusion/core, @fusion/dashboard"
date: 2026-07-31
problem_type: logic_error
component: workflow-lifecycle-columns
severity: high
applies_when:
  - "Replacing a `task.column === \"<legacy id>\"` comparison with a trait-resolved lifecycle role"
  - "Converting a guard in triage discovery, hold release, self-healing, or a dashboard affordance"
  - "Reviewing a lifecycle-column conversion PR"
  - "A card started being auto-planned, auto-advanced, or auto-shown after a conversion that 'only renamed things'"
---

# Converting a column literal can WIDEN the gate it was guarding

## The two failure directions

A lifecycle-column conversion replaces "is this card in the column named X" with "is this card in the
column carrying role R". Both directions of error are common, and only one of them is obvious.

**Direction 1 — narrower / phantom (the obvious one).** The gate resolves the role but a *destination*
or an *exemption* beside it stays literal. The guard admits a card on a renamed board and the move
then targets a column that board does not declare. Symptoms: `TransitionRejectionError`, a card in a
column nothing renders, or a recovery that reports failure after a partial move. This shape happened
four times in one plugin file and twice in `executor.ts` during Phase C.

**Direction 2 — WIDER (the one that gets shipped).** The literal was holding a gate *shut* for a
workflow whose column simply did not match it. Resolving the role makes the predicate start matching,
so behaviour the literal excluded by accident now happens. Nothing errors. Nothing is rejected. The
engine just does more than it used to.

## The incident

`builtin:coding-ideas` exists so an operator can park a capture without the engine planning it
(FN-7596). That rule was enforced *accidentally*: triage discovery's admission predicate compared
against `"triage"`, and an `ideas` card matched no branch.

Converting that predicate to resolve intake **by trait** made `ideas` the resolved intake column for
that workflow — so discovery began specifying parked ideas. Measured: `poll()` called `specifyTask`
on the parked card. The conversion was correct in vocabulary and wider in effect.

The fix is not to revert the conversion. It is to make the *real* rule explicit: the intake trait
carries `autoTriage: false`, and a manual intake is never auto-admitted. The signal was in the IR the
whole time; the literal had been standing in for it.

## Why the guarding test did not catch it

`triage.test.ts` had a case named "excludes a parked ideas-column task from the poll's
specify-dispatch set". It passed before the conversion, passed after the rule broke, and passes today.

Its store has **no workflow readers**. Lifecycle resolution therefore falls back to `triage`/`todo`,
an `ideas` card matches neither branch, and the card is excluded — for a reason that has nothing to do
with manual intake. The fixture could not reach the code path the test was named after.

The tell was in its own comment, which still described the mechanism the conversion had removed
("`eligibleTriageTasks`, which only matches `column === "triage"`"). **A comment describing a
mechanism that no longer exists is evidence the test is no longer testing it.**

## What to do when converting a column literal

1. **Ask what the literal EXCLUDED**, not just what it matched. List the workflows whose columns did
   not match it, and decide deliberately whether each should now be included. That question is what
   distinguishes a rename from a behaviour change.
2. **Convert the destinations and the exemptions in the same commit.** A role-resolved rule with a
   name-matched carve-out inverts the carve-out.
3. **Make the fixture resolve a workflow.** A store without `getTaskWorkflowSelection` /
   `getWorkflowDefinition` cannot reach any trait-resolved branch, so a test built on one proves
   nothing about the conversion. Drive the real builtin IR (`BUILTIN_CODING_IDEAS_WORKFLOW_IR`) or a
   renamed fixture, and assert on both a renamed and a merged shape.
4. **Pair every conversion with a negative.** "Never fires" and "always fires" must both fail. For an
   admission gate that means: the manual intake is refused, an AUTO intake still admits, and an
   unresolvable workflow behaves as before.
5. **Re-read the comment above the test you are relying on.** If it names a mechanism the diff
   removed, that test is now decoration.

## Where the guards are

`node scripts/lifecycle-column-census.mjs` reports the remaining comparisons, classified into column
guards (the backlog), agent-role comparisons, entity-status comparisons, and reviewed
`DELIBERATE-LITERAL` sites. Only the first class is convertible; converting a role comparison
reintroduces this bug's cousin, because the planner *lane* is named `triage` and keeps that name.

## References

- `packages/engine/src/__tests__/manual-intake-admission.test.ts` — the invariant, with the surface
  enumeration and the measured pre-fix behaviour.
- `packages/engine/src/triage.ts` — `isAtIntakeColumn`, and why the hold branch is deliberately not
  gated (a card in hold was RELEASED there).
- `docs/testing.md` → "Lifecycle-column census (report-only)" — the four classes and why they are
  never netted into one number.
