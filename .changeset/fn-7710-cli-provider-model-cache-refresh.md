---
"@runfusion/fusion": patch
---

summary: Grok and Cursor CLI models now appear in model pickers immediately after enabling the provider.
category: fix
dev: useModelsCache exposes a shared single-flight refreshModelsCache() that clears the SWR_CACHE_KEYS.MODELS cache and notifies subscribers; the Authentication CLI provider toggle (cursor-cli/grok-cli/claude-cli/llama-cpp) now calls it. Server-side cursor/grok picker caches use a short negative-TTL so transient cold-start empties self-heal.
