---
"@runfusion/fusion": patch
---

summary: Unblock queued work when a waiting task's file reservation prevents its prerequisites from starting.
category: fix
dev: Apply dependency readiness to dormant file-scope reservations across admission, blocker repair, and recovery.
