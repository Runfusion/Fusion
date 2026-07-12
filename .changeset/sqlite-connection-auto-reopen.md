---
"@runfusion/fusion": patch
---

summary: Auto-heal wedged SQLite connections in place instead of failing every request until restart.
category: fix
dev: The sqlite adapter now classifies connection-corruption errors (SQLITE_NOTADB "file is not a database" / "database disk image is malformed"), reopens the connection on the same path, replays assignment-style PRAGMAs, verifies with PRAGMA quick_check, and retries the failed operation once when outside an explicit transaction. Statements are generation-tracked so ones prepared before the reopen re-prepare transparently; mid-transaction unwind (ROLLBACK/RELEASE) after a reopen is absorbed as no-ops. Covers fusion.db, fusion-central.db, and archive.db. On-disk corruption (quick_check failure) still defers to the open-time recovery machinery.
