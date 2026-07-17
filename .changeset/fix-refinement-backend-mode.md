---
"@runfusion/fusion": patch
---

summary: Fix "SQLite Database is not available" errors when refining/duplicating tasks and in merge verification on PostgreSQL.
category: fix
dev: atomicCreateTaskJson now routes to the AsyncDataLayer in backend mode (fixing the refineTask/duplicateTask createTaskWithId paths that bypassed _createTaskInternal's backend routing), and the merger verification-cache ops (getVerificationCacheHit/recordVerificationCachePass) are now async with a PostgreSQL branch; the upsert targets verification_cache_pkey by constraint name since migration 0006 rebuilds project-schema PKs to lead with project_id.
