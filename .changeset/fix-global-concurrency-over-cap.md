---
"@runfusion/fusion": patch
---

summary: Stop more agents from running than the global concurrency cap allows.
category: fix
dev: Scheduler tryAcquires a shared slot before todo→in-progress and hands it to the executor/graph; triage admits planners against live running-agent claim (planning + in-progress + active in-review), not only semaphore.availableCount.
