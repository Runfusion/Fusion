---
"@runfusion/fusion": patch
---

summary: Board reads no longer fetch task-log text they immediately discard, cutting the dashboard's largest memory cost.
category: fix
dev: `listTasks({ slim: true })` already returned `log: []` on both slim paths (`listTasksImpl` assigns `task.log = []` in the derive-off strip and again in the derive-on slim strip), so the `log` column was shipped from PostgreSQL and JSON-parsed purely to be thrown away. `effectiveExcludeLog` now includes `slim`, so the SELECT omits the column. The three log-derived signals on the derive-on slim path run before the strip and already read `timing_total_ms` / `log_recent`, so board payloads are unchanged (`board-read-shape-guard.test.ts`).
