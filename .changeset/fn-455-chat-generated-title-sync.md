---
"@runfusion/fusion": patch
---

summary: A new conversation's generated name now appears in the open chat window right away.
category: fix
dev: Chat title generation is one shared `ChatManager` seam reached by both the model path and the CLI-agent early return, with its `updateSession` write awaited and a single truncated fallback. Client-side, a `chat:session:updated` payload received while the authoritative selection snapshot is in flight is deferred as the bare `title` string and reapplied over that snapshot through a closed allowlist; every other session field (cursor, generation state) stays owned by the snapshot.
