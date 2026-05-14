---
"@runfusion/fusion": patch
---

Self-healing now emits a `task:auto-recover-already-merged` run-audit event when `SelfHealingManager.recoverAlreadyMergedReviewTasks` finalizes a phantom-merge-guard false positive. Enables the `recoverAlreadyMergedReviewTasksRecoveriesPerDay` reliability metric to be derived from `run_audit_events`.
