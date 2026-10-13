---
"@runfusion/fusion": patch
---

summary: Prevent stale file-scope releases from causing duplicate task scheduling.
category: fix
dev: Scheduler wakes only after an observed overlap blocker clears in a runnable parked lane.
