---
"@runfusion/fusion": patch
---

summary: Clear orphaned merge status from eligible engine-paused review cards without resuming them.
category: fix
dev: The stale merge sweep permits only merge-deadlock-detected clear-only recovery and never enqueues paused cards.
