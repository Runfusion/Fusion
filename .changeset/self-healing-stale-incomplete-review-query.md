---
"@runfusion/fusion": patch
---

summary: Review cards with unfinished steps are requeued again on boards with renamed columns.
category: fix
dev: `recoverStaleIncompleteReviewTasks` read the literal `in-review`, so a card that reached review on a graph failure with steps still unfinished was never requeued on a renamed board. Read resolves via `resolveProjectColumnsForRoles`, per-card check resolves per card; the requeue keeps its literal target because it passes `recoveryRehome: true`.
