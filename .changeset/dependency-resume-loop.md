---
"@runfusion/fusion": patch
---

summary: Stop repeated resume attempts for tasks waiting on unfinished dependencies.
category: fix
dev: Check dependency admission before clearing resume state or recovering completed work.
