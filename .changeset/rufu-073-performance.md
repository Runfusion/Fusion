---
"@runfusion/fusion": patch
---

summary: Cut scheduler CPU and health-API latency by reading each task's workflow selection once per poll tick.
category: performance
dev: Adds a strictly per-tick/per-pass selection cache threaded through `resolveTaskParkedColumns` and the escalation/hydration sweeps in the scheduler; each task's `task_workflow_selection` is read at most once per tick instead of ~6x, eliminating the Drizzle SQL-query storm without any schema or resolver-behavior change.