---
"@runfusion/fusion": patch
---

summary: Keep the Anthropic OAuth login error inside the Settings card on mobile.
category: fix
dev: Provider loginError is a wrapping block banner under the auth card header instead of an inline flex sibling, so a long expiry message cannot overflow a phone-width Settings card.
