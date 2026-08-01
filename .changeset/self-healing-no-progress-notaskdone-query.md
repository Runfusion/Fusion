---
"@runfusion/fusion": patch
---

summary: Failed tasks that produced nothing release their work slot again on renamed boards.
category: fix
dev: `recoverNoProgressNoTaskDoneFailures` read the literal `in-progress`, so a wip card failed for "no fn_task_done" with no step progress and no git work was never requeued on a renamed board and kept holding its slot. Read resolves via `resolveProjectColumnsForRoles`, per-card check resolves per card.
