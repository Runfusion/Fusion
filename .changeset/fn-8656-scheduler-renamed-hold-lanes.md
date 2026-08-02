---
"@runfusion/fusion": patch
---

summary: Fix scheduler not unblocking dependents on boards with renamed hold or terminal columns.
category: fix
dev: Scheduler now uses async workflow lanes after its synchronous event prologue.
