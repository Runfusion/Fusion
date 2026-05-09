---
"@runfusion/fusion": patch
---

Scheduler: exclude paused in-review tasks from `activeScopes`. Paused failed-merge tasks no longer block dispatch of overlapping todo tasks via `blockedBy` re-stamping. (FN-3867)
