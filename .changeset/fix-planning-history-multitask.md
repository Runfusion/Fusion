---
"@runfusion/fusion": patch
---

summary: Completed Planning Mode sessions that create multiple tasks now stay in planning history.
category: fix
dev: The multi-task create-tasks route now uses releaseSession instead of cleanupSession, retaining the persisted ai_sessions row like the single-task path.
