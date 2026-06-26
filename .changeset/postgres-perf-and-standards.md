---
"@runfusion/fusion": patch
---

summary: Fix PostgreSQL performance and credential-redaction gaps surfaced by the migration review.
category: performance
dev: Adds missing index on tasks.source_parent_task_id (lineage gate was a full scan) and a partial index for the live kanban `WHERE deleted_at IS NULL AND column = ?` read. Batches merge-queue stale-row cleanup to remove an N+1 on lease acquire. Pushes LIMIT into SQL for audit/activity-log queries. Drops the heavy `log` jsonb column from slim board hydration. Fixes the monitor-store backend discriminator (`"ping" in db`, not the ambiguous `"transactionImmediate" in db`), awaits the now-async resolveIncident in signal routes, and redacts `?password=` query-param URLs.
