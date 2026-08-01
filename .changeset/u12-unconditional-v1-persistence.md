---
"@runfusion/fusion": patch
---

summary: Internal cleanup of retired workflow-columns flag reads; no change to stored workflows or board behavior.
category: internal
dev: The three v1-IR rollback-compat persist sites (`createWorkflowDefinition`, `updateWorkflowDefinition`, `insertWorkflowDefinitionSync`) branched on the retired raw `experimentalFeatures.workflowColumns` key, which is always false, so the downgrade arm was always taken. The branch and the `flagOn` parameter are removed; `downgradeIrToV1IfPure` is kept as a binary-downgrade affordance and pinned by `workflow-ir-v1-rollback-persistence.test.ts`. `TaskStore.workflowColumnsFlagOn()` is deleted (no callers). `isWorkflowColumnsCompatibilityFlagEnabled` survives; every remaining read is on the move path (U2b).
