---
"@runfusion/fusion": patch
---

summary: Restore the chat "Working…" indicator immediately when returning to a session with an active generation.
category: fix
dev: `useChat.ts` `selectSession` now reattaches on the authoritative `fetchChatSession` refresh whenever `isGenerating===true`, instead of requiring a populated `inFlightGeneration` snapshot that is null pre-first-delta. Guards against races (stale active session, already-open stream) and reuses `attachIfGenerating` (FN-7656).
