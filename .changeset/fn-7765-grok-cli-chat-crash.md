---
"@runfusion/fusion": patch
---

summary: Fix Grok CLI chat failing instantly with a "Response failed" error.
category: fix
dev: ChatManager.sendMessage (packages/dashboard/src/chat.ts) now null-safely reads session.state.errorMessage/messages and falls back to the session's top-level messages + accumulated onText stream, so plugin-backed CLI runtime sessions (grok/droid/cursor) that expose no pi-shaped `state` render their reply instead of throwing "Cannot read properties of undefined (reading 'errorMessage')". pi/openclaw/hermes state.errorMessage failure bubbles are unchanged. Same fix applied to the room-responder session.state.messages read.
