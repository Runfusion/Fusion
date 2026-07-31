---
"@runfusion/fusion": patch
---

summary: Falsely-failed tasks with all steps done are cleared again on boards with renamed columns.
category: fix
dev: `recoverMisclassifiedFailures` read the literal `in-review`, so a task parked failed for "without calling fn_task_done" whose steps were all actually done stayed visibly failed on a renamed board. Read resolves via `resolveProjectColumnsForRoles`, per-card check resolves per card.
