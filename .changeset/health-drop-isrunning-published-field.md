---
"@runfusion/fusion": patch
---

summary: The health endpoint no longer reports a misleading always-false database.isRunning field.
category: fix
dev: "`GET /api/health` and `POST /api/health/refresh` published a `database.isRunning` boolean copied from the internal `TaskStore` snapshot, where every producer hardcoded it to `false`. It meant 'a health refresh is in flight', never 'the database is down', and was misread as liveness evidence. The published `database` object is now a closed set of measured fields — `healthy`, `corruptionDetected`, `corruptionErrors`, `lastCheckedAt` — built by enumerating each field instead of spreading the store snapshot, so no future internal member can leak onto the wire. Any consumer reading `database.isRunning` must drop that read; `database.healthy` already carries real connectivity liveness. The internal store flag itself is unchanged."
