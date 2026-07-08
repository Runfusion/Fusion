---
"@runfusion/fusion": patch
---

summary: Removed the chat "Search in title only" toggle; chat search always matches message content and title.
category: fix
dev: Dropped searchInTitleOnly/setSearchInTitleOnly from useChat and the ChatView toggle button; content-search path (q param, matchedMessagePreview) is now always-on. Server GET /chat/sessions titleOnly param retained but unused by the client.
