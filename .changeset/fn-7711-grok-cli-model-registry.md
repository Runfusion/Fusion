---
"@runfusion/fusion": patch
---

summary: Grok CLI models now run instead of failing with "not found in the pi model registry".
category: fix
dev: Adds a built-in grok-cli provider (packages/core/src/grok-provider.ts) — xAI OpenAI-compatible endpoint https://api.x.ai/v1, api openai-completions, apiKey $GROK_API_KEY — registered into the execution registry (pi.ts registerExtensionProviders), seedDashboardProviders, and CLI serve/daemon/dashboard, mirroring the built-in Z.ai provider. Grok CLI binary remains discovery/probe only; GrokRuntimeAdapter streaming is still a stub (tracked follow-up).
