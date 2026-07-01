---
"@runfusion/fusion": patch
---

summary: Restore Claude Sonnet 5 in the model picker (it had disappeared from every surface).
category: fix
dev: Re-adds `claude-sonnet-5` to SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION and its static pricing (removed by FN-7374). Live-verified: Sonnet 5 returns 200 on api.anthropic.com/v1 with a raw ANTHROPIC_API_KEY and runs via the Claude CLI; it 403s (scope) on subscription-OAuth /v1, where the runtime actionable-failure/fallback path applies.
