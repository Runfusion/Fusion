---
"@runfusion/fusion": patch
---

summary: Fix PostgreSQL-mode merge recovery, lost task-field writes, first-boot SQLite auto-migration, and backup tool discovery.
category: fix
dev: recoverStaleTransitionPending ported to backend mode (async-transition-pending.ts); backend moves now write/clear the crash-safe transitionPending marker; atomicWriteTaskJson/WithAudit write changed columns instead of full-row upserts (lost-update class behind stuck "unplanned" cards); createTaskStoreForBackend auto-migrates legacy fusion.db into an empty PG database on first boot (loud failure, SQLite kept as backup); PgBackupManager resolves pg_dump/pg_restore from common install locations when not on PATH.
