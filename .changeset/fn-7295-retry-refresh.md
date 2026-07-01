---
"@runfusion/fusion": patch
---

summary: Refresh dashboard task state immediately after Retry succeeds.
category: fix
dev: useTasks now replaces matching retry rows, updates project SWR task cache, and invalidates older fetches.
