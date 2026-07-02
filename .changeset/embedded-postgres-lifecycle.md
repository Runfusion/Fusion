---
"@runfusion/fusion": minor
---

summary: Bundle embedded PostgreSQL for zero-system-install local storage when DATABASE_URL is unset.
category: feature
dev: Adds `embedded-postgres` lifecycle manager (initdb/pg_ctl start/stop, graceful SIGTERM/SIGINT shutdown, data persistence across restarts). Platform binaries bundled for macOS/Linux/Windows arm64/x64. Used by `createTaskStoreForBackend` when DATABASE_URL is unset.

