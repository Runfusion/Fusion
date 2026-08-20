---
"@runfusion/fusion": minor
---

summary: Custom provider models can now set per-model context window and max output tokens.
category: feature
dev: `buildCustomProviderModels` reads `contextWindow`/`maxTokens` from the persisted model entry (emitted only when a positive finite number; falls back to 128000/16384 otherwise), the custom-provider routes validate both fields on add/update/refresh with an id-merge that preserves persisted windows, and Advanced: Custom Providers replaces the comma-separated model input with a per-model row editor (model ID, display name, context window, max output tokens).
