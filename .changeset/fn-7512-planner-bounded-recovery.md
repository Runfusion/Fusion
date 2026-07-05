---
"@runfusion/fusion": minor
---

summary: Planner oversight can autonomously inject guidance, retry stuck/failed steps, and request fixes within bounded limits.
category: feature
dev: Adds pure `decidePlannerRecovery` + recovery types (core) and `PlannerRecoveryController` with injected guidance/retry/targeted-fix handlers (engine), consuming the FN-7511 observation. Acts only at effective level `autonomous`, caps attempts per (task, stage) via `PLANNER_RECOVERY_MAX_ATTEMPTS`, skips user-paused tasks, and excludes merge/PR/destructive actions (deferred to FN-7513) and comprehensive human-control safeguards (FN-7514).
