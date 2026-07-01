---
"@runfusion/fusion": patch
---

summary: Remove deleted tasks from the board and right sidebar immediately after deletion.
category: fix
dev: Updates the dashboard `useTasks` delete path to remove successfully deleted task ids from shared state and project task cache without waiting for SSE/refetch.
