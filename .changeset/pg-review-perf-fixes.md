---
"@runfusion/fusion": patch
---

summary: Speed up board listing and agent chat on PostgreSQL with SQL-side pagination and a conversation history cap.
category: performance
dev: Closes the two open PR #1793 review findings — readLiveTaskRows now pushes column filters + ORDER BY (created_at, numeric id suffix) + LIMIT/OFFSET into SQL instead of scanning and hydrating the whole task table per listTasks; getConversation is capped to the most recent 200 messages by default (options.limit overrides, oldest-first order preserved) in both the async and sqlite paths.
