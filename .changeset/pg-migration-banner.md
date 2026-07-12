---
"@runfusion/fusion": minor
---

summary: Show a dashboard banner after SQLite data is auto-migrated to PostgreSQL, with backup location and a Need-help Discord link.
category: feature
dev: startup-factory persists settings.sqliteMigrationNotice (migratedAt/rows/tables/sqliteBackups) after a successful first-boot auto-migration; SqliteMigrationBanner renders it once, dismiss persists dismissed:true via PUT /settings. Auto-migration now also stamps archive.archived_tasks.project_id.
