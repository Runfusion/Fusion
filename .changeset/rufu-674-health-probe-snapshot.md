---
"@runfusion/fusion": patch
---

summary: Dashboard health checks no longer time out under load, so a healthy server is not restarted.
category: fix
dev: `GET /api/health` is served from a snapshot refreshed every 5 s instead of awaiting the Postgres health evaluation on the request path; a snapshot older than 90 s returns 503 so a wedged process still fails its watchdog probe. New module `packages/dashboard/src/health-snapshot.ts`.
