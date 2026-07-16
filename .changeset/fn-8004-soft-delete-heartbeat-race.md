---
"@runfusion/fusion": patch
---

summary: Concurrent soft-delete during a heartbeat move no longer strands an agent in error.
category: fix
dev: New engine classifier isConcurrentSoftDeleteRaceError short-circuits the agent-heartbeat failed-run handler for TaskDeletedError races (agent stays active, budget untouched) and emits run-audit agent:heartbeat-move-skipped-soft-delete.
