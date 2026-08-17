---
"@runfusion/fusion": patch
---

summary: Dashboard event streams for an unknown project now return 404 instead of logging a 500 server error.
category: fix
dev: `/api/events` maps project-not-found store-resolution failures to 404 with a clean message; stale client tabs and e2e fixture pages no longer fill operator logs with startup-factory construction errors.
