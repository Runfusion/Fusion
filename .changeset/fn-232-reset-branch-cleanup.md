---
"@runfusion/fusion": minor
---

summary: Reset now deletes the task's local branch and commits so the next run starts clean.
category: fix
dev: Adds `branchCleanupTargets`, `planTaskResetBranchCleanup`, and `deleteTaskResetBranches`; absent reset targets skip the ownership proof.
