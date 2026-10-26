---
"@runfusion/fusion": patch
---

summary: The scheduler no longer reads every task's workflow on each poll just to renew symbol locks.
category: performance
dev: renewActiveMissionSymbolLocks checks declared symbols before resolving the workflow, and shares one per-pass IR cache across the tasks that need it.
