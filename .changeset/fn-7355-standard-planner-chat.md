---
"@runfusion/fusion": patch
---

summary: Reuse the standard Chat surface for task-detail planner chat.
category: fix
dev: Extracts StandardChatSurface for shared message, thinking, tool-call, and mobile send rendering without importing the lazy ChatView chunk from task detail.
