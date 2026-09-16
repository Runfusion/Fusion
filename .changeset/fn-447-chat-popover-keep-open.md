---
"@runfusion/fusion": patch
---

summary: Ctrl/Cmd-click and Open in new window keep the Chat conversation list open.
category: fix
dev: ChatView's `onOpenSessionInNewWindow` now takes an optional `{ keepListOpen }` second argument; only the footer Conversations popover host consumes it.
