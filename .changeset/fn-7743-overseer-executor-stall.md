---
"@runfusion/fusion": patch
---

summary: The planner overseer now detects and recovers stalled in-progress tasks instead of leaving hung executors stuck.
category: fix
dev: FN-7743 — the executor-stage overseer observation now emits `signal: "stuck"` once an in-progress task has been inactive past a configurable threshold (`plannerOverseerExecutorStuckAfterMs`), feeding the existing `decidePlannerRecovery` → bounded `inject_guidance` path. Previously a non-paused in-progress task was always reported `progressing`, so a hung executor was never recovered. Human-control withholds (user-paused / approval-blocked / autoMerge-off) still take precedence.
