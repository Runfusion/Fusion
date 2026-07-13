---
"@runfusion/fusion": patch
---

summary: Make Chat go-to-top contextual and inline, with the edit pencil compact beside timestamps.
category: feature
dev: StandardChatMessageItem gains an isTopClipped prop; ChatView measures clipped message tops on scroll to gate go-to-top visibility. Edit pencil moved from a standalone row into the timestamp footer.
