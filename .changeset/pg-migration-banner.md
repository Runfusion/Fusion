---
"@runfusion/fusion": minor
---

summary: Dashboard banner after SQLite auto-migration to PostgreSQL with backup location and help link.
category: feature
dev: startup-factory persists settings.sqliteMigrationNotice (migratedAt/rows/tables/sqliteBackups) after a successful first-boot auto-migration; SqliteMigrationBanner renders it once, dismiss persists dismissed:true via PUT /settings. Auto-migration now also stamps archive.archived_tasks.project_id.
