---
"@runfusion/fusion": patch
---

summary: Compound Engineering sync records the lane a completed card actually reached.
category: fix
dev: `onTaskCompleted` enqueued `toColumn: "done"` while its sibling `onTaskMoved` records the real column, so on a renamed board the sync-queue audit row named a column the board does not have. Now records `task.column`.
