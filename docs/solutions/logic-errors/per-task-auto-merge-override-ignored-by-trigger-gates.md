---
title: Per-task auto-merge override ignored by trigger-layer gates
date: 2026-06-03
category: logic-errors
module: engine
problem_type: logic_error
component: background_job
symptoms:
  - "Tasks with per-task autoMerge:true never auto-merged when global settings.autoMerge was off"
  - "Override tasks reached in-review and sat there indefinitely with no error surfaced"
  - "In-review self-healing sweeps short-circuited on the global setting and never enqueued the merge"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - merger
  - self-healing
  - store
tags:
  - auto-merge
  - per-task-override
  - merge-queue
  - self-healing
  - engine
  - trigger-gate
---

# Per-task auto-merge override ignored by trigger-layer gates

## Problem

A per-task `autoMerge: true` override was honored only by the merger itself, but every *trigger-layer* gate (engine enqueue, 19 self-healing sweeps, store stall-signal hydration) checked the global `settings.autoMerge` alone. With global auto-merge OFF, override tasks were never enqueued and sat in `in-review` forever. Fixed in PR Runfusion/Fusion#1356.

## Symptoms

- User disabled auto-merge globally but enabled it on individual tasks.
- Those individually-enabled tasks reached `in-review` and stayed there indefinitely — never picked up, never merged.
- No error surfaced: the tasks were simply never *triggered* into the merge pipeline, so the merger's per-task handling never ran.

## What Didn't Work

- **Assuming the downstream merger check was enough.** The only code consulting `task.autoMerge` was the merger (`packages/engine/src/merger.ts` ~7958: `task.autoMerge === false` → `manual-required`). That runs *after* enqueue. The enqueue gate `allowInReviewMergeProcessing` (`packages/engine/src/project-engine.ts:1386`) and 19 self-healing sweeps short-circuited on `settings.autoMerge` before the task ever reached the merger — so the per-task flag was dead code from the user's perspective. Notably, the feature issues (Runfusion/Fusion#1150, #1152, #1153) shipped the data model, a resolver (`resolveEffectiveAutoMerge`), and the dashboard control — #1152 even claimed engine merge-gating used the resolved value — but no trigger gate actually consulted it.
- **Reaching for `resolveEffectiveAutoMerge` at the gates.** The existing resolver `task.autoMerge ?? settings.autoMerge` (`packages/core/src/task-merge.ts`) looks like the natural gate, but using it would *regress* the global-ON + `autoMerge:false` case: those tasks must still flow into the merger so it can park them as `manual-required` (and so merged-task finalization sweeps still finalize them). Plain resolution would skip them at the trigger, stranding manually-merged tasks in `in-review`.
- **Slim-projection gotcha.** Per-task gating reads `task.autoMerge` off rows from slim task projections. If the `autoMerge` column were missing from `getTaskSelectClause` (`packages/core/src/store.ts` ~1976), the gate would silently see `undefined` and the override would fail with no error. (Verified present — but a real trap when adding per-row predicates.)

## Solution

New core predicate, **additive** to the global setting (`packages/core/src/task-merge.ts`):

```ts
export function allowsAutoMergeProcessing(
  task: Pick<Task, "autoMerge">,
  settings: Pick<Settings, "autoMerge">,
): boolean {
  return settings.autoMerge !== false || task.autoMerge === true;
}
```

Applied at three trigger layers:

1. **Enqueue gate** (`project-engine.ts:1386`), which fronts all four enqueue paths (startup sweep, periodic retry, unpause, task-moved fast path):

   ```ts
   // before
   private allowInReviewMergeProcessing(task: Pick<Task, "branchContext">, settings: Pick<Settings, "autoMerge">): boolean {
     return settings.autoMerge || isSharedBranchGroupMemberIntegration(task);
   }
   // after
   private allowInReviewMergeProcessing(task: Pick<Task, "branchContext" | "autoMerge">, settings: Pick<Settings, "autoMerge">): boolean {
     return allowsAutoMergeProcessing(task, settings) || isSharedBranchGroupMemberIntegration(task);
   }
   ```

2. **All 19 self-healing sweeps** (`self-healing.ts`): the function-level early returns (`if (settings.autoMerge === false) return 0;`) were replaced by per-task filtering inside each sweep's candidate set, e.g.:

   ```ts
   const candidates = tasks.filter((t) =>
     t.column === "in-review" &&
     allowsAutoMergeProcessing(t, settings) &&
     !t.paused && /* ... */);
   ```

3. **Store stall-signal hydration** (`store.ts`, 6 sites): `autoMerge: settings.autoMerge` → `autoMerge: allowsAutoMergeProcessing(task, settings)` in the `getInReviewStallReason` / `getInReviewStalledSignal` contexts, so board diagnostics reflect that override tasks *are* being processed.

The self-healing contract also changed: from "skip the whole sweep when global is off" to "list tasks, but mutate nothing without a per-task override." FN-5147 tests that asserted `listTasks` was never called were updated to assert the mutation-free guarantee instead. This extends — and stays consistent with — the AGENTS.md `autoMerge: false` callout (FN-5147): self-healing still never moves override-less `in-review` tasks when auto-merge is off.

## Why This Works

The root cause was a flag consulted only where the *action* runs, not where processing is *triggered*. Adding the override evaluation to every trigger gate closes the gap.

Additive (`settings.autoMerge !== false || task.autoMerge === true`) is deliberately chosen over resolution (`task.autoMerge ?? settings.autoMerge`):

- **Global ON:** `settings.autoMerge !== false` is already `true`, so the predicate is a no-op — every task flows through exactly as before, including `autoMerge:false` tasks that the merger then parks as `manual-required`. Resolution would have excluded those, breaking manual-required parking and finalization.
- **Global OFF:** the first term is `false`, so only `task.autoMerge === true` tasks proceed — exactly the missing override path.

It changes nothing when global is ON and adds only the explicit-true path when global is OFF.

## Prevention

When adding a per-entity override to a behavior that's gated on a global setting, the override must be consulted **where the behavior is TRIGGERED, not just where the action runs.** A check at the merger (the action) is invisible if upstream enqueue/sweep gates already filtered the entity out.

- **Grep every gate on the global setting** before declaring the override wired: here `settings.autoMerge` appeared at 1 enqueue gate, 19 sweep guards, and 6 hydration sites — all needed updating. A search for the global key, not just the new override field, surfaces the dead-flag sites.
- **Prefer additive gating over effective-value resolution for *processing* gates.** Resolution collapses three states (global-on/off × per-task true/false/unset) into one boolean and can starve a needed downstream branch (the manual-required parking path). Gate on "should this be processed at all," resolve the actual behavior later.
- **Check existing regression contracts before re-scoping a gate.** Review of the fix PR suggested exempting `todo`/`in-progress` candidates (execution-stage repair) from the auto-merge gate — but the repo's FN-5704 regression test ("short-circuits reclaim when autoMerge is false") deliberately keeps execution-stage reclaim inert in manual-review projects. Per-task gating applied uniformly preserves that contract while enabling overrides; exempting execution-stage recovery would be a separate, deliberate behavior change.
- **Watch slim projections:** per-row predicates require the override column in the SELECT clause, or they silently read `undefined`.
- **Test matrix must cross global × per-task.** The fix shipped red-first unit tests for the predicate (`packages/core/src/__tests__/task-merge.test.ts`), the gate including the shared-group exemption (`packages/engine/src/__tests__/project-engine.test.ts`), and a self-healing test proving an **override task is processed while an override-less sibling stays skipped** (`packages/engine/src/__tests__/self-healing.test.ts`) — the latter is the canonical shape: two tasks differing only in `autoMerge` under global-OFF, asserting divergent outcomes.

## Related Issues

- Runfusion/Fusion#1356 — the fix PR
- Runfusion/Fusion#1150, Runfusion/Fusion#1152, Runfusion/Fusion#1153 — the per-task auto-merge feature trio (data model + resolver, engine gating, dashboard control); #1152's gating claim is the gap this bug exposed
- Runfusion/Fusion#753 (FN-5147), Runfusion/Fusion#690 (FN-5052) — prior global `autoMerge:false` stall/lifecycle handling that the sweeps' guards came from
- AGENTS.md → "`autoMerge: false` callout (FN-5147)" — standing lifecycle rule this fix extends to per-task granularity
