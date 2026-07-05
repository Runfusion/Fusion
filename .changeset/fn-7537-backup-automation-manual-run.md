---
"@runfusion/fusion": patch
---

summary: Manual "Run now" for the Database Backup automation now runs in-process like the scheduler, matching cron behavior.
category: fix
dev: The legacy single-command and command-step manual automation run path (`executeSingleCommand` in packages/dashboard/src/routes.ts) now intercepts `isInProcessBackupCommand`/`isInProcessMemoryBackupCommand` via the scoped TaskStore, mirroring `RoutineRunner.executeCommand`/`CronRunner`, instead of always shelling out via `exec()`. `formatInProcessBackupError`, `isInProcessBackupCommand`, and `isInProcessMemoryBackupCommand` are now exported from `@fusion/engine` for reuse. Existing onStep/onText live-run callbacks already stream incremental output for command/backup runs; added regression coverage confirming this holds for the new interception branch.
