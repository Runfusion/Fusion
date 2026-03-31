---
"@dustinbyrne/kb": minor
---

Add automatic database backup feature
- Configurable backup schedule (cron expression)
- Configurable retention policy (number of backups to keep)
- Manual backup and restore via CLI (`kb backup --create`, `--list`, `--restore`, `--cleanup`)
- Dashboard settings UI for configuration with backup statistics
- Automatic cleanup of old backups exceeding retention limit
- Pre-restore backup creation for safety
