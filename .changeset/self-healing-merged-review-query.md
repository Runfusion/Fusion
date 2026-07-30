---
"@runfusion/fusion": patch
---

summary: Merged-but-unfinished tasks are now finalized on boards with renamed columns.
category: fix
dev: `recoverMergedReviewTasks` read the literal `in-review`/`todo`, so a card whose merge was confirmed sat unfinished on a renamed board while its commit was already on the base branch. Reads resolve via `resolveProjectColumnsForRoles`, the two per-card column checks resolve per card (falling back to the project sets when a card's own workflow is unreadable), and the candidate list is deduped.
