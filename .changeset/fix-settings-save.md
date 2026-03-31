---
"@dustinbyrne/kb": patch
---

Fix settings save failure by resolving race condition in parallel task creation and ensuring config row exists in SQLite.

- Fixed race condition in `allocateId()` where parallel task creation could cause `config.json` to have stale `nextId` values by wrapping the config sync in `withConfigLock()`
- Changed `writeConfig()` to use `INSERT OR REPLACE` instead of `UPDATE` to ensure the config row is created if missing
- Added error handling tests for settings save failures
- Added integration tests for SQLite settings persistence
