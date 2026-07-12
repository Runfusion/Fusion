---
"@runfusion/fusion": minor
---

summary: Show a Grok (xAI) card in the Usage dropdown for configured Grok API keys.
category: feature
dev: usage.ts adds fetchGrokUsage (env GROK_API_KEY -> ~/.grok/user-settings.json -> grok-cli auth key) validating GET https://api.x.ai/v1/api-key and registered in fetchAllProviderUsage. xAI exposes no subscription usage meter to the inference key, so the card is auth-validity (ok/no-auth/error) with a real usage window only when confirmed data exists; no fabricated windows. Real usage field found: no — validity-only.
