---
"@runfusion/fusion": patch
---

summary: Grok CLI no longer requires a Fusion-visible API key — the CLI's own auth is enough to enable it.
category: fix
dev: probeGrokBinary now derives `authenticated` from `grok` binary availability (readiness) instead of GROK_API_KEY/~/.grok/user-settings.json presence, mirroring the Cursor CLI provider; key detection is exposed as a non-blocking `apiKeyDetected` hint. The /auth/status grok-cli provider is authenticated when enabled + binary available; GrokCliProviderCard drops the blocking "Set GROK_API_KEY" state. The direct xAI streaming path still uses $GROK_API_KEY when present (FN-7711/FN-7714 unchanged).
