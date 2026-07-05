---
"@runfusion/fusion": minor
---

summary: Planner overseer now stays fully hands-off for paused tasks and auto-merge-off / human-review tasks.
category: feature
dev: Adds the pure `evaluateOverseerHumanControl` policy (packages/engine/src/overseer-human-control-policy.ts), consulted at the top of `PlannerRecoveryController.tick()` before any action classification, confirmation gating, steering, retry, or dispatch — so a user-paused or `autoMerge:false`/human-review task never even records a pending confirmation. Reuses `allowsAutoMergeProcessing` from `@fusion/core` verbatim (never re-derives the auto-merge/human-review predicate). Distinguishes explicit user pause (`task.userPaused===true`, or `task.paused===true` with no `pausedReason`) from engine/self-healing parks (which always stamp a `pausedReason`). Emits a bounded `overseer:oversight-withheld-human-control` run-audit no-action event (metadata: `{ taskId, reason, stage, oversightLevel }`), deduped per (taskId, reason) so it does not spam every poll.
