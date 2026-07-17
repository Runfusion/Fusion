---
"@runfusion/fusion": patch
---

summary: Fix task refinement/duplication, merge verification, and workflow checkpoint persistence on PostgreSQL.
category: fix
dev: atomicCreateTaskJson now routes to the AsyncDataLayer in backend mode (fixing the refineTask/duplicateTask createTaskWithId paths that bypassed _createTaskInternal's backend routing), and the merger verification-cache ops (getVerificationCacheHit/recordVerificationCachePass) are now async with a PostgreSQL branch; the upsert targets verification_cache_pkey by constraint name since migration 0006 rebuilds project-schema PKs to lead with project_id. The full sync-SQLite residue sweep also ports workflow run-branch/step-instance persistence, branch progress, plugin column-transition hooks, getTaskColumns, getWorkflowStep/listWorkflowSteps stored-row reads, readRawProjectSettings, and listWorkflowPromptOverridesForProject to the async layer (several store methods became async: saveWorkflowRunBranch, loadWorkflowRunBranches, clearWorkflowRunBranches, saveWorkflowRunStepInstance, loadWorkflowRunStepInstances, clearWorkflowRunStepInstances, getBranchProgressByTask, readRawProjectSettings, listWorkflowPromptOverridesForProject).
