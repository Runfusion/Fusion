---
"@runfusion/fusion": patch
---

summary: Prevent stale workflow recovery log entries from sending incorrect notifications.
category: fix
dev: Adds workflowTransitionNotification task markers for pause-abort recovery requeues and avoids log-text notification heuristics.
