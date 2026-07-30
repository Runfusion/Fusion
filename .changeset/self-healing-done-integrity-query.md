---
"@runfusion/fusion": patch
---

summary: Merge-evidence repair and already-merged rescue now run on renamed-column boards.
category: fix
dev: `recoverAlreadyMergedReviewTasks` had the same defect on the review lane — a card whose merge succeeded stayed parked with status=failed. `reconcileDoneTaskIntegrity` queried `listTasks({ column: "done" })`, which returns nothing on a renamed board, so the sweep never executed. It now resolves the project's complete lanes via `resolveProjectColumnsForRoles` and queries each, unioned with the legacy id.
