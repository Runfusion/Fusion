---
"@runfusion/fusion": patch
---

summary: Replay missing PostgreSQL migrations after restoring an older dump pair.
category: fix
dev: After a project restore, rewind public.fusion_schema_migrations from the earliest missing CREATE-TABLE sentinel and run applySchemaBaseline; reconciliation failures roll back project/archive from the pre-restore pair. Remote reconciliation connections use ssl verify-full.
