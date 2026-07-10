---
"@runfusion/fusion": patch
---

summary: Fix Chat header showing thread controls while the conversation list is displayed after re-entering Chat.
category: fix
dev: On mobile remount, useChat/useChatRooms restore the active session/room while sidebarVisible resets true; mobile thread controls now key off actual pane visibility.
