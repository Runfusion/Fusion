---
"@runfusion/fusion": patch
---

summary: Prevent implementation-incomplete workflow merge failures from false-completing as no-op done.
category: fix
dev: Merge graph failures with missing implementation proof now fail closed or requeue resumable parsed steps before any no-branch no-op merge requester path can run.
