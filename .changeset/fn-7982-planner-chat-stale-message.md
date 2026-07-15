---
"@runfusion/fusion": patch
---

summary: Fix task chat showing a stale agent message while generating a new reply.
category: fix
dev: TaskPlannerChatTab now clears streamingThinking and the streaming-assistant row on fresh generations while preserving attach-to-in-flight snapshots.
