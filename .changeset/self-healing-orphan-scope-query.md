---
"@runfusion/fusion": patch
---

summary: Orphan-only scope-violation recovery now runs on boards with renamed columns.
category: fix
dev: `recoverOrphanOnlyScopeViolations` queried the literal `in-review`, so it never ran on a renamed board and such a task stayed failed. Read now resolves via `resolveProjectColumnsForRoles`; the per-card verdict and its `getTaskHardMergeBlocker` resolve from the task's own workflow.
