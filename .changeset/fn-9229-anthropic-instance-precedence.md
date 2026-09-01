---
"@runfusion/fusion": patch
---

summary: Your selected Claude account now takes precedence over a leftover legacy Anthropic sign-in.
category: fix
dev: `resolveAnthropicRuntimeApiKey` and the shared refresh candidate preserve subscription-instance precedence; auth status exposes `legacyAnthropicOAuthPresent`.
