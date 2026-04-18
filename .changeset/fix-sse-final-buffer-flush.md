---
"@gsxdsm/fusion": patch
---

Fix dashboard `streamChatResponse()` SSE parsing so buffered final events are flushed when streams end without a trailing newline, and add regression coverage.
