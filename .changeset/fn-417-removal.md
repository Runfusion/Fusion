---
"@runfusion/fusion": minor
---

summary: Task right-click menus no longer offer Plan or Merge & Close; the engine handles both.
category: breaking
dev: Removes the `plan` descriptor and its `onPlan` option from `buildTaskActionMenuModel`, along with the now-unused `isPreExecutionHoldColumn` predicate — that was this file's last recorded `triage` guard, so `scripts/lib/lifecycle-column-census-baseline.json` is re-sealed. The `merge` review action becomes opt-in behind a new `includeMergeCompletionAction` option (default off); only `TaskDetailModal` enables it, so its review footer button is unchanged. Host wiring drops the dead `onPlanningMode` prop from `TaskCard`, `ListView`, and `WorktreeGroup`; `planningWorkflowId` is kept because planner-oversight resolution still consumes it.
