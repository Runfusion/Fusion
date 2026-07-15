---
"@runfusion/fusion": patch
---

summary: Chat "Thinking" reasoning blocks now start collapsed for a cleaner transcript.
category: fix
dev: Removed the `open` attribute from TaskChatTab's task-chat-thinking <details>; StandardChatSurface already collapses thinking. Regression tests assert collapsed-by-default + expand-on-click across persisted, streaming, and Task Detail chat surfaces (FN-7974).
