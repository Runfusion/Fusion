---
"@runfusion/fusion": patch
---

summary: Orphaned in-flight review steps are now marked failed for re-review instead of silently skipped at merge.
category: fix
dev: `resolveOrphanedPendingStepResults` rewrites orphans to `status:"failed"` (never deletes — deletion satisfied the merge gate and skipped review); the sweep also runs in periodic maintenance, skips `in-progress` rows, re-reads before writing, and the audit event is registered in `DatabaseMutationType` with metadata `{taskId, column, orphanedCount, resultCount}`.
