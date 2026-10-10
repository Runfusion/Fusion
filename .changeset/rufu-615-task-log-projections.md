---
"@runfusion/fusion": minor
---

summary: Board refresh no longer transfers the task agent log, cutting per-refresh memory and read time.
category: performance
dev: Two write-time columns (`tasks.timing_total_ms`, `tasks.log_recent`, migration 0092) now answer the five log-derived board figures, so `listTasks({ excludeLog: true })` is effective while deriving — it used to be a documented no-op. Shared loaders still return `log` by default; callers opt in per call. Never write `tasks.log` without also writing both derived columns in the same statement.
