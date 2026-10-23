---
"@runfusion/fusion": patch
---

summary: Stop re-reading the whole task archive on every board and engine poll.
category: performance
dev: listArchivedTasks keeps the raw task_json rows per query handle and project, guarded by a count and xmin fingerprint checked on every call, so an unchanged archive is served from memory and any insert, update or delete is seen immediately.
