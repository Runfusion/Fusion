---
title: "Mission autopilot stalls forever on a done+implementing feature with no task"
date: 2026-06-03
category: docs/solutions/logic-errors
module: "engine/mission-execution-loop + core/mission-store"
problem_type: logic_error
component: background_job
symptoms:
  - "A mission silently stops advancing — no error, no crash, just no progress"
  - "Autopilot cycles watching to activating to watching indefinitely in mission_events, never advancing the milestone"
  - "A slice stays stuck active even though all of its features report status=done"
  - "Wedged feature shows the contradictory combo: status=done plus loopState=implementing plus null lastValidatorStatus plus a linked assertion plus no taskId"
root_cause: missing_workflow_step
resolution_type: code_fix
severity: high
related_components:
  - "packages/engine/src/mission-execution-loop.ts (recoverActiveMissions, runFeatureValidation)"
  - "packages/core/src/mission-store.ts (computeSliceStatus)"
tags:
  - mission-system
  - autopilot
  - recovery
  - slice-completion
  - assertion-validation
  - loop-state
---

# Mission autopilot stalls forever on a done+implementing feature with no task

## Problem

A mission feature could be left `status="done"` while its `loopState` stayed `"implementing"`, with no linked board task (`taskId`) and never validated (`lastValidatorStatus` null). The slice-completion gate correctly refuses to count an unvalidated, assertion-linked `done` feature, so the slice — and therefore the milestone and the whole mission — could never auto-progress. The mission stalled silently and indefinitely.

## Symptoms

- A mission stops advancing entirely — no error, no crash, just no forward motion.
- Autopilot cycles `watching → activating → watching` forever in `mission_events`, never advancing the milestone.
- A slice stays `active` even though every feature in it reports `status="done"`.
- The wedged features carry the contradictory combination: `status="done"` + `loopState="implementing"` + `lastValidatorStatus=null` + at least one linked assertion + no `taskId`.

## What Didn't Work

The first hypothesis came from reading code alone: an early `return` in the scheduler — the `reconciliation.kind === "blocked"` branch in `handleMissionTaskMove` — looked like it could swallow the transition before the completion handler ran. Plausible on inspection, but **not** what wedged this mission.

The real cause only surfaced by inspecting the live per-project DB read-only (`file:.../.fusion/fusion.db?mode=ro`) and looking at the actual stored feature rows. The diagnosis was then confirmed by contrast: an already-**completed** older mission also had many `done`+`implementing` features, but with **zero** assertions — so the gate let them through. That isolated the *assertion gate* as the active ingredient, not the `done`+`implementing` pairing by itself.

Lesson: reasoning from code alone pointed at the wrong early-return; observed data found the orphan state.

## Solution

Two independent, individually-correct facts interlocked into a deadlock:

1. **The slice gate is strict (by design).** `MissionStore.computeSliceStatus` (`packages/core/src/mission-store.ts:3866-3880`, added by FN-5715) refuses to count an assertion-linked `done` feature toward slice completion unless its validator passed *or* its `loopState` is idle/undefined.
2. **The recovery sweep had a gap.** `MissionExecutionLoop.recoverActiveMissions` only re-drove `implementing` features that still carried a `taskId` (`feature.loopState === "implementing" && feature.taskId`). A task-less stranded `done` feature matched none of the recovery branches (`validating` / `needs_fix` / `implementing && taskId`), so it could never be validated.

The fix adds a recovery branch for the orphan and extracts the validation path into a shared helper. Validation is a read-only judge (no board task created, no code edited), so it is safe to run directly from the recovery sweep.

```ts
// packages/engine/src/mission-execution-loop.ts — recoverActiveMissions,
// after the existing implementing+taskId branch
if (
  feature.loopState === "implementing"
  && !feature.taskId
  && feature.status === "done"
  && feature.lastValidatorStatus !== "passed"
  && !this.activeValidations.has(feature.id)
) {
  const currentFeature = this.missionStore.getFeature(feature.id) ?? feature;
  // Live re-check: skip if it has since passed (avoids racing a concurrent pass)
  if (
    currentFeature.loopState === "passed"
    || currentFeature.lastValidatorStatus === "passed"
  ) {
    continue;
  }
  recoveredCount++;
  await this.runFeatureValidation(currentFeature);
}
```

The validation execution path was lifted out of `processTaskOutcome` into a reusable private method (behavior-preserving for the existing task-completion path):

```ts
// processTaskOutcome's inline block becomes a single call:
await this.runFeatureValidation(feature);

// shared helper used by both task-completion and recovery:
private async runFeatureValidation(feature: MissionFeature): Promise<void> {
  const assertions = this.missionStore.listAssertionsForFeature(feature.id);
  if (assertions.length === 0) {
    await this.handleValidationPass(feature.id, undefined, "No assertions linked");
    return;
  }
  this.activeValidations.add(feature.id);
  try {
    const run = this.missionStore.startValidatorRun(feature.id, "task_completion");
    const result = await this.runValidation(feature, assertions, run);
    // dispatch pass / fail / blocked / error as before
  } finally {
    this.activeValidations.delete(feature.id);
  }
}
```

Shipped in PR #1345 (commit `c2604d5`). Tests added in `packages/engine/src/__tests__/mission-execution-loop.test.ts`; full mission-execution-loop suite plus self-healing/validator-reaper suites stayed green.

## Why This Works

The mission stalled because the validator never ran → `lastValidatorStatus` stayed null → `computeSliceStatus` never let the slice reach `complete` → the milestone never completed → autopilot looped forever. The gate was right to block; the bug was that nothing ever *satisfied* the gate for a task-less feature. Re-driving validation gives the orphan a terminal validator status either way: on pass it becomes legitimately complete and the slice resolves; on fail the existing fix-feature flow takes over. The live `getFeature` re-check before validating avoids racing a concurrent pass.

## Prevention

- **Treat `loopState` as possibly-stale and possibly-contradictory with `status`.** The `done` + non-terminal-`loopState` pairing is an invariant violation worth asserting/reconciling at write time, not just tolerating downstream. Any logic that *gates* on `loopState` inherits this fragility.
- **Recovery/self-healing sweeps keyed on `taskId` must handle the task-less orphan.** Conditions like `loopState === "implementing" && feature.taskId` silently skip any feature missing the key. Enumerate the orphan states explicitly.
- **When two individually-correct rules can interlock into a deadlock** (a strict gate + an incomplete recovery sweep), add an explicit reconciliation path rather than weakening the gate.
- **Diagnostic tip:** when a state machine stalls with no error, inspect the live DB read-only (`?mode=ro`) and read the actual stored values; contrast a wedged instance against a healthy/completed one to isolate the active ingredient. Code-reading alone misdirected this investigation.

## Related Issues

- `docs/missions-completion-contract.md` — the canonical FN-5715 completion-gate contract. It already covers (a) zero-assertion features going to `loopState="passed"` and (b) `taskId == null` features being re-triaged, but does **not** yet cover this specific orphan: `done` + `implementing` + no `taskId` + never validated. This learning extends that contract; the invariant belongs folded into its "Slice Status / Autopilot Advance" and "Validator/loop behavior" sections.
- `docs/missions.md:297` — documents stranded-feature (`taskId == null`) reconciliation and the `mission:stranded-feature-triaged` audit event.
- FN-5721 (#1183) — "Implement mission completion gate contract" (FN-5715 enforcement baseline); closest companion issue.
- FN-5901 — "reap stale mission validator runs": the sibling self-healing pattern for stale *validator* runs. This fix is the analogous self-heal for stranded *implementing* features. (session history)
- FN-5902 (in flight as of 2026-06-02) — "make ALL mission validation AI-run; eliminate zero-assertion auto-pass". Touches the same validation pipeline (`mission-execution-loop.ts` auto-pass branch); changing zero-assertion behavior interacts with this gate. (session history)
