---
"@runfusion/fusion": patch
---

summary: Stop capacity reads from loading the task-log column they never use, shortening the ramp to a supervised restart.
category: fix
dev: The triage poll's capacity-claim snapshot, the merge-lane claim snapshot, both near-duplicate comparators, and the spec-drift startup replay now pass `excludeLog: true` (plus `derive: false` where only ids are consumed). `log` is 42.7% of live-row bytes (125 MB over 2 417 rows on a live board) and none of these consumers read it — the capacity predicate reads `id`, `status` and `workflowStepResults`. The five log-derived board figures come from `timing_total_ms` + `log_recent` (RUFU-615), so no badge changes shape.
