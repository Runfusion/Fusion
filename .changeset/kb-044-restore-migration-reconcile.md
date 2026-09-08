---
"@runfusion/fusion": patch
---

summary: Replay missing PostgreSQL migrations after restoring an older dump pair.
category: fix
dev: After FN-9255 bookkeeping dumps restore, legacy stems rewind public.fusion_schema_migrations from the earliest missing table or ALTER column and replay inside one transaction; a thrown reconcile uses dump-group rollback. Remote reconciliation connections use ssl verify-full.
