---
"@runfusion/fusion": patch
---

summary: Let Anthropic subscription login power Anthropic model requests without a raw API key.
category: fix
dev: Bridges runtime provider `anthropic` to OAuth credentials stored under `anthropic-subscription` while preserving raw API-key precedence.
