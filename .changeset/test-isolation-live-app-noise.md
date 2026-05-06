---
"@runfusion/fusion": patch
---

Extend `scripts/check-test-isolation.mjs` runtime ignore list to cover live
fusion app paths that previously tripped the merge-time check when a fusion
instance was running on the same HOME during tests: `tasks/`, `messages/`,
`memory-insights.md`, `test-cache.json`, `HEARTBEAT.md`, `kb.db.backup-*`,
and `fusion.db.pre-*` snapshots. Tests still must not write to these paths;
the filter only suppresses noise from a concurrently-running app.
