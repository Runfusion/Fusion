---
"@runfusion/fusion": patch
---

summary: Keep planning timers session-specific and return cleanly from stopped generations.
category: fix
dev: Persists each generation's start time and restores the prior planning step when stopped.
