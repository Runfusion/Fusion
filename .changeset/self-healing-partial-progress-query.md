---
"@runfusion/fusion": patch
---

summary: Partially-completed work is retried again on boards with renamed columns.
category: fix
dev: `recoverPartialProgressNoTaskDoneFailures` read the literal `in-review`, so on a renamed board a card failed for "no fn_task_done" that had made real step progress was never retried and its retry budget was never spent. Read resolves via `resolveProjectColumnsForRoles`, per-card check resolves per card.
