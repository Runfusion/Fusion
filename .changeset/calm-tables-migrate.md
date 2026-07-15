---
"@runfusion/fusion": patch
---

summary: Preserve late task, workflow, and mission fields during SQLite-to-PostgreSQL migration.
category: fix
dev: Adds PostgreSQL schema migration 0007 and restores runtime persistence for active late-added fields.
