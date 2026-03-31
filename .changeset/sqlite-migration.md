---
"@dustinbyrne/kb": minor
---

Migrate storage from file-based JSON to SQLite (hybrid with files for blobs)
- Improved performance for large task counts via SQLite queries
- Better concurrent access support (WAL mode)
- Seamless auto-migration from legacy file-based data
- Zero breaking changes to store APIs
