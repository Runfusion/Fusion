---
"@runfusion/fusion": patch
---

summary: Ghost review cards are detected again on boards with renamed columns.
category: fix
dev: `recoverGhostReviewTasks` read the literal `in-review`, so a card parked past the stuck timeout with no merge-lane owner was never found on a renamed board. Read resolves via `resolveProjectColumnsForRoles` and the per-card check resolves per card; the kick-back keeps its literal target because it passes `recoveryRehome: true`.
