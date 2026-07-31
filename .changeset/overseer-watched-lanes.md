---
"@runfusion/fusion": patch
---

summary: Planner oversight now watches tasks on boards with renamed lanes instead of silently watching nothing.
category: fix
dev: `resolveWatchedStage` keyed on the literal `in-progress`/`in-review`, so on a renamed board it returned null for every card — `observeTask` returned early, no observation was recorded, and `PlannerRecoveryController` had nothing to act on. It now takes the task's resolved `columnFlags`, supplied by `project-engine.ts` at both call sites with a per-poll IR cache.
