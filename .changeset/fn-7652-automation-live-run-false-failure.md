---
"@runfusion/fusion": patch
---

summary: Automation live output no longer shows "Run failed" for runs that actually succeed.
category: fix
dev: Reconciles the live-run panel terminal status (ScheduledTasksModal/RoutineCard) to the authoritative POST/registry result and gates benign SSE teardown (post-terminal close, reconnect exhaustion) from being surfaced as a failure across both `/routines/:id/run/stream` and `/automations/:id/run/stream`.
