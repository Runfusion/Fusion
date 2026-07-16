---
"@runfusion/fusion": patch
---

summary: Fix a startup failure when two Fusion processes start embedded Postgres at the same time.
category: fix
dev: A lifecycle joining an already-running instance returned a URL before the owner's `ensureDatabase()` had created the database, so the joiner's first connect failed. Both join paths now verify the database on the joined instance's port (never `getPort()`, which prefers this instance's requested port) and create it if absent. Verification is best-effort so an unreachable/stale-pid join still resolves optimistically as before. `CREATE DATABASE` races tolerate both `42P04` and `23505` on `pg_database_datname_index`.
