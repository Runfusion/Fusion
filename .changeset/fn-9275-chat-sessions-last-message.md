---
"@runfusion/fusion": patch
---

summary: Keep chat conversation lists fast as project chat history grows.
category: performance
dev: getLastMessageForSessions and searchChatSessionsByMessageContent use per-session CROSS JOIN LATERAL LIMIT 1 with left(content, 101), ChatSessionLastMessage, and migration 0073 / SCHEMA_BASELINE_VERSION 0073.
