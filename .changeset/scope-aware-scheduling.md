---
"@gsxdsm/fusion": minor
---

Add scope-aware automation and routine scheduling support

- Added `scope` column to automations and routines database tables with migration v34
- Added scope-aware `getDueSchedules(scope)` and `getDueRoutines(scope)` query methods to stores
- Updated CronRunner to poll schedules by scope with "project", "global", or "all" options
- Updated RoutineScheduler to poll routines by scope with "project", "global", or "all" options
- Added scope-aware diagnostics to identify which scope lane produced each run
- Deterministic de-duplication prevents double-execution when polling both scopes
