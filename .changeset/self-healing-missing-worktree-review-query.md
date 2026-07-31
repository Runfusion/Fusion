---
"@runfusion/fusion": patch
---

summary: Review failures from a missing worktree recover on renamed boards, and on boards with two review columns.
category: fix
dev: `recoverMissingWorktreeReviewFailures` had per-candidate lane wiring but still read the literal `in-review`, so only boards whose review lane kept that name benefited. The read now resolves via `resolveProjectColumnsForRoles`. Its per-candidate set also came from `resolveTaskLifecycleColumns().review` (first column per role) while the classifiers take a membership set; it now unions `columnsWithFlag` across the three review roles.
