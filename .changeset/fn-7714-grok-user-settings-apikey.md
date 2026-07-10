---
"@runfusion/fusion": patch
---

summary: Grok now uses the key from ~/.grok/user-settings.json when GROK_API_KEY is not set.
category: fix
dev: registerBuiltInGrokProvider (packages/core/src/grok-provider.ts) now hydrates process.env.GROK_API_KEY from ~/.grok/user-settings.json { apiKey } when the env var is unset/empty, so the provider's $GROK_API_KEY reference resolves. Env var always wins; missing/malformed/empty file is fail-soft (no throw, no env mutation). Mirrors the grok-runtime probe's fallback.
