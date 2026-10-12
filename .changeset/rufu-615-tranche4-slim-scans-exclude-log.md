---
"@runfusion/fusion": patch
---

summary: Engine board scans stop reading task-log text they never used, cutting dashboard memory growth.
category: fix
dev: `listTasks({ slim: true })` already returned `log: []` on both the derive-on and derive-off paths (`reads.ts` slim finalize assigns `task.log = []` unconditionally), so the `log` column was parsed and thrown away on every one of those reads. Tranche 4 passes `excludeLog: true` at all 87 remaining engine sites (all 66 in `self-healing.ts`, plus 16 files with no non-logger `.log` token), taking the census from 88 unconverted scans to 2. `list-tasks-slim-excludes-log.test.ts` ratchets the number.
