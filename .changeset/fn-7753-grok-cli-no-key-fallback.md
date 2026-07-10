---
"@runfusion/fusion": patch
---

summary: Grok CLI models now run via the grok CLI when no Fusion-visible API key is set.
category: fix
dev: createResolvedAgentSession (packages/engine/src/agent-session-helpers.ts) auto-derives runtimeHint "grok" when defaultProvider is grok-cli, no GROK_API_KEY is Fusion-visible (new read-only isGrokApiKeyFusionVisible in packages/core/src/grok-provider.ts), and the Grok runtime is registered; the selected model is passed to the CLI via a new --model option on spawnGrokStream. Explicit runtime hints and the key-visible direct-endpoint default are unchanged. Closes the deferred FN-7722/FN-7725 follow-up.
