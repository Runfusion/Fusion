---
"@runfusion/fusion": patch
---

summary: Cards can no longer sit waiting unowned, and every silent skip on the planning path now says so.
category: fix
dev: Closes the second FN-8596 strand: a triage card with stale execution stamps and NO status was owned by nobody — planning excluded it (stamps read as advanced) and `recoverAdvancedTriageTasks` also excluded it, because it bails on `workflowIrPinColumnId === "triage"`. `hasAdvancedPastPlanning` now decides purely on arrival order (a stamp predating `columnMovedAt` belongs to a previous pass) for any card in the planner column, whatever its status. Adds `SelfHealingManager.detectStalledCards`, a detect-only watchdog emitting `task:stall-watchdog-detected` for any non-terminal, unpaused card idle past 30m with no live session and no queued continuation — deduped per shape, never mutating (recovery stays with the sweep that owns each shape). Makes the previously silent skips observable: `runIfStillPlanningUnderTaskLock`, the planning handoff `moveTaskIf`, and the four `requestPreMergeOptionalStepFix` refusals now log why nothing was scheduled.
