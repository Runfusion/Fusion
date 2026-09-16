---
"@runfusion/fusion": patch
---

summary: Task-linked chat conversations now appear instantly when you open Chat.
category: fix
dev: `GET /api/chat/sessions` now returns `taskChatsVisibleInCommonFeed`, and the `useChat` localStorage session snapshot stores that effective visibility next to the rows so cached `task-planner:` sessions rehydrate on first render. Legacy bare-array snapshots read as unknown visibility and stay filtered; archived and empty planner rows are never rehydrated.
