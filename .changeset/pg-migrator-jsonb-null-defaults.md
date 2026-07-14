---
"@runfusion/fusion": patch
---

summary: Preserve PostgreSQL jsonb defaults when legacy SQLite rows contain NULL.
category: fix
dev: The SQLite-to-PostgreSQL migrator now reads target nullability and jsonb defaults, replacing legacy NULL or empty-string values only for NOT NULL jsonb columns with valid defaults. This prevents first-boot migration failures such as research_runs.sources violating its NOT NULL constraint while keeping checksum verification aligned with the migrated values.
