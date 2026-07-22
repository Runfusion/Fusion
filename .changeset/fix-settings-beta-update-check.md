---
"@runfusion/fusion": patch
---

summary: Settings Check for updates now finds newer beta releases when the beta channel is selected.
category: fix
dev: Settings footer and GET /api/updates/check now force-refresh through channel-aware performUpdateCheck (updateChannel + npm beta dist-tag) instead of always querying registry latest with prerelease-blind compare.
