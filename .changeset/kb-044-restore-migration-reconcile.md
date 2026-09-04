---
"@runfusion/fusion": patch
---

summary: Replay missing PostgreSQL migrations after restoring an older dump pair.
category: fix
dev: After a project restore, rewind public.fusion_schema_migrations from the earliest missing sentinel (0040 task-lifecycle relations) and run applySchemaBaseline.
