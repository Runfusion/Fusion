---
"@runfusion/fusion": patch
---

summary: Renamed hold and intake lanes now wake the scheduler and unblock dependents correctly.
category: fix
dev: The `task:updated`/`task:deleted` handlers resolve lanes asynchronously; the wake set unions legacy ids so it stays a superset.
