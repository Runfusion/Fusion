---
"@runfusion/fusion": patch
---

summary: Fix Claude 5.5 requests returning a 404 from Anthropic.
category: fix
dev: Registers the Anthropic SDK origin without a duplicate `/v1` path.
