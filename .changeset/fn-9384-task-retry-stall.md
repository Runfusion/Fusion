---
"@runfusion/fusion": patch
---

summary: Return deadlock-paused failed review tasks to their runnable lane on CLI retry.
category: fix
dev: The CLI retry path now preserves progress while clearing the automatic deadlock pause and merge retry budget.
