---
"@runfusion/fusion": patch
---

summary: PR comment monitoring no longer freezes the daemon while gh runs.
category: performance
dev: The default PR-monitor gh client uses runGhJsonAsync plus new isGhAvailableAsync/isGhAuthenticatedAsync helpers, which share the sync helpers' 60 s cache and coalesce concurrent spawns.
