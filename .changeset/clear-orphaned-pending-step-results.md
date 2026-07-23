---
"@runfusion/fusion": patch
---

summary: Recover in-review tasks stranded by a restart that killed an in-flight review step, instead of failing them.
category: fix
dev: New startup sweep `reconcileOrphanedPendingStepResults` wires the previously caller-less `resolveOrphanedPendingStepResults` helper; emits `task:reconcile-orphaned-pending-step-results` run-audit events.
