---
"@runfusion/fusion": minor
---

summary: Add a Feishu/Lark webhook format so task notifications deliver to Feishu custom bots.
category: feature
dev: New `webhookFormat: "feishu"` setting renders `{ msg_type: "text", content: { text } }`, the shape Feishu custom bot hooks require (other formats get HTTP 200 + code 19002 and silently drop). Selectable in Settings → Notifications; the test-notification endpoint sends the same shape.
