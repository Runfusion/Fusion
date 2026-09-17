---
"@runfusion/fusion": patch
---

summary: Waiting tasks resume after the integration branch is rebased, with no cleanup or retry loops.
category: fix
dev: `synchronizeOverlapWaitBeforeExecution` now reconciles a rewritten predecessor delivery through the new `reconcileRewrittenDelivery` helper (readable original object, identical `git patch-id --stable`, `Fusion-Task-Id`/`Fusion-Task-Lineage` trailer ownership, ancestry in checkout and target, single qualified candidate) after the dirty-worktree guard and the base refresh, persisting `reconciledSha`/`reconciliationProof` in `OverlapWaitDeliveryProof` and emitting bounded `task:overlap-delivery-reconciled`. The planner `retryStep` handler honors `moveTaskToContainedBackwardTarget` refusals instead of returning true, and the self-healing `tip-already-merged` reclaim withholds while an overlap episode is pending.
