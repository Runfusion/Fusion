---
"@runfusion/fusion": minor
---

Harden the project database against the recurring "database disk image is malformed" corruption.

- **Integrity-checked backups**: every backup copy is now verified with `PRAGMA quick_check` before it is kept, a verifiably-corrupt copy is quarantined as `*.corrupt` instead of masquerading as good, and `cleanupOldBackups` will never rotate out the last verified-good backup.
- **Startup auto-recovery**: on open, a malformed `fusion.db` is detected and rebuilt offline via `sqlite3 .recover` (corrupt original preserved as `fusion.db.corrupt-<ts>`, stale `-wal`/`-shm` dropped) before any connection is established. Opt out with `FUSION_DISABLE_DB_AUTORECOVER=1`. This also fixes a latent bug where the recovery path invoked the non-existent `.recover main` option and always failed.
- **Database shrink + retention**: scratch `lost_and_found*` tables left by prior recoveries are dropped on init, and a new `operationalLogRetentionDays` setting (default 30 days, configurable in Settings → Backups → Database Maintenance, 0 to disable) prunes unbounded append-only log tables (`activityLog`, `agentLogEntries`, `runAuditEvents`, `agentHeartbeats`) during periodic maintenance to curb the file growth that widens the corruption window.
