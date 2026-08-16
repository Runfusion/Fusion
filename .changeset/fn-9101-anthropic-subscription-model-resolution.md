---
"@runfusion/fusion": patch
---

summary: Fix Claude subscription model resolution failing with unknown provider anthropic-subscription.
category: fix
dev: Normalize auth-surface ids anthropic-subscription/anthropic-api-key to execution provider anthropic at model resolution seams; keep subscription OAuth credentials and auth cards on anthropic-subscription.
