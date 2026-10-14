---
"@runfusion/fusion": patch
---

summary: Health check no longer claims "no corruption" when the corruption probe never finished.
category: fix
dev: An unmeasured PostgreSQL task-ID integrity check now publishes `taskIdIntegrity.status: "error"` with a `failure` class (`unconfigured` / `unreachable` / `incomplete`) and forces `corruptionDetected: true`, so `false` now means "completed clean with no blocking errors". The async detector rejects a cancelled or failed measurement instead of resolving an empty ok report, and the dedicated `max: 1` health session carries a server-side `statement_timeout` below the 5s probe budget so an abandoned probe read can no longer wedge later readiness checks. A refused connection is reported by the connectivity stage itself (`checkPostgresHealth` resolves its verdict rather than throwing), so it is classified `unreachable` with the original error text preserved, and never `incomplete`. The dashboard shows a distinct "integrity could not be measured" warning banner whose body names the connectivity truth for each class — only `incomplete` claims Fusion reached PostgreSQL.
