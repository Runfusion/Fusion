---
"@runfusion/fusion": patch
---

summary: Database backup automation failures now report which database and the underlying cause.
category: fix
dev: Hardens runBackupCommand + routine/cron in-process backup branches so AutomationRunResult.error is always actionable.
