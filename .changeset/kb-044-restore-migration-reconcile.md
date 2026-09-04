---
"@runfusion/fusion": patch
---

summary: Replay missing PostgreSQL migrations after restoring an older dump pair.
category: fix
dev: After FN-9255 bookkeeping dumps restore, legacy two-member stems still rewind public.fusion_schema_migrations from the earliest missing CREATE-TABLE sentinel and replay; a thrown reconcile uses the same dump-group rollback. Remote reconciliation connections use ssl verify-full.
