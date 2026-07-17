---
"@runfusion/fusion": patch
---

summary: Fix "SQLite Database is not available" error when creating a refinement or duplicating a task on PostgreSQL.
category: fix
dev: atomicCreateTaskJson now routes to the AsyncDataLayer in backend mode (soft-delete conflict check + non-destructive insert in one transaction), fixing the refineTask/duplicateTask createTaskWithId paths that bypassed _createTaskInternal's backend routing.
