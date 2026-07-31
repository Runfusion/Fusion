---
"@runfusion/fusion": patch
---

summary: Foreign-only branch contamination is now cleared on boards with renamed columns.
category: fix
dev: `recoverForeignOnlyContaminatedInReviewTasks` read the literal `in-review`/`in-progress`, so a branch carrying only foreign commits was never classified on a renamed board and the task stayed parked. Reads resolve via `resolveProjectColumnsForRoles`, the two per-card column checks resolve per card, and the concatenated candidate list is deduped.
