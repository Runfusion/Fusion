---
"@runfusion/fusion": patch
---

summary: Lower the embedded PostgreSQL default connection cap to 150 on Windows to prevent 0xC0000142 backend crashes.
category: fix
dev: Issue #2411 — embeddedPostgresMaxConnections is now schema-unset; resolveEmbeddedMaxConnections picks win32 150 / else 500, explicit settings still clamp to [32, 2000].
