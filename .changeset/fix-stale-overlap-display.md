---
"@runfusion/fusion": patch
---

summary: Hide stale file-overlap blockers when a task is queued on an unfinished dependency.
category: fix
dev: Scheduler dependency transitions now retain only overlap blockers backed by an active overlapping lease.
