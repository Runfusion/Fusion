---
"@runfusion/fusion": patch
---

summary: Archived task-planner chats now soft-delete their Stash sessions on bulk archival.
category: fix
dev: New best-effort batched Stash sync (deleteStashChatSessions / bulkDeleteStashChatSessions in @fusion/core) wired into the dashboard and engine task-moved archive listeners; paged lookup bounded to 2000 rows — rows older than the lookback window may remain and are debug-logged.
