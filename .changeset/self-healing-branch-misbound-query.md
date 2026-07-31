---
"@runfusion/fusion": patch
---

summary: Branch-misbinding is detected again on boards with renamed columns.
category: fix
dev: `recoverBranchMisboundInReviewTasks` read the literal `in-review`, so on a renamed board a review card whose branch tip belongs to another task was never detected. Read resolves via `resolveProjectColumnsForRoles`, per-card check resolves per card.
