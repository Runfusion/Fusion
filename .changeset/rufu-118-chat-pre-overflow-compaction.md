---
"@runfusion/fusion": minor
---

summary: Chat now compacts context before it overflows the model window, so long chats stop degrading to 1-token replies.
category: fix
dev: Deterministic pre-overflow compaction gate on the chat/CLI pi-session path; `tokenCap` setting becomes an upper bound (unset = 80% of the per-model context window) on chat compaction; executor path unchanged.
