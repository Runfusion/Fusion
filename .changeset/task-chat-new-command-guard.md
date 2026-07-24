---
"@runfusion/fusion": patch
---

summary: /new and /clear in Chat no longer wipe a task-bound planner chat's history.
category: fix
dev: ChatView's exact `/new`//`/clear` intercept now recognizes `task-planner:<taskId>` sessions (surfaced in the common feed via `showTaskChatsInCommonFeed`) and consumes the command with a warning toast instead of calling createSession.
