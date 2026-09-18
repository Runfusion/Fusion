---
"@runfusion/fusion": minor
---

summary: Reconcile review tasks whose already-landed branches were cleaned up.
category: feature
dev: Adds `fn task reconcile <id>`, backed by `SelfHealingManager.reconcileLandedReviewTask`, with liveness and compare-and-set fencing shared with the automatic absent-branch self-healing sweep; records `task:reconcile-absent-branch-landed`/`task:reconcile-absent-branch-unproven` run-audit events.
