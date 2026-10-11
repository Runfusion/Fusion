---
"@runfusion/fusion": patch
---

summary: Task history stops repeating the same self-repair line on every pass and every restart.
category: fix
dev: Repeated engine diagnostics (planning failures, lifecycle-containment refusals, merge-confirmed finalization refusals, done-task merge repair skips, planner-oversight observations, goal-injection results) now append through one durable dedupe keyed per card + episode (`store.logEntryOnce`) instead of an in-process sighting map, so a supervised restart no longer re-announces every stuck card. A suppressed repeat performs no row write at all — no `task.log` growth, no `updated_at` bump, no `task:updated` broadcast, and no full-card `rowToTask` + `task.json` mirror rewrite inside `logEntryOnce` itself. A suppressed no-op is still a fulfilled call, so the RUFU-382 planning-capacity mirror keeps its existing semantics. Four public TaskStore surfaces added by the workflow-cache epoch work are now classified in the durable-write inventory.
