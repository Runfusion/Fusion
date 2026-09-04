---
"@runfusion/fusion": patch
---

summary: Fix PostgreSQL backup pair listing and restore both control-plane dump halves safely.
category: fix
dev: Native restore validates paired dumps and retains rollback evidence; backup creation uses reservation/rename publication, skips live claims during cleanup, enforces project-only retention, and documents migration bookkeeping exclusion.
