---
"@runfusion/fusion": patch
---

summary: Fix Anthropic subscription logins failing tasks with "Provider is not configured: anthropic".
category: fix
dev: pi >=0.80.8 moved session auth from `ModelRegistry.getApiKeyAndHeaders` (fusion's `getApiKey`) to `ModelRuntime.getAuth` -> pi-ai `resolveProviderAuth`, which reads `credentials.read("anthropic")` and refreshes OAuth via `credentials.modify("anthropic")`. Fusion stores the subscription login under `anthropic-subscription` (no raw `anthropic` row), so the refresh saw `current === undefined` and auth resolved to undefined. Fix: `createFusionCredentialStore.read("anthropic")` now resolves through `getApiKey("anthropic")` (handles refresh + raw/legacy/subscription/fallback precedence) and returns a ready `api_key` credential; pi-ai routes it as OAuth by the `sk-ant-oat` token prefix. Also add "not configured" to `isRetryableModelSelectionError` so an unresolved provider triggers the configured fallback model instead of hard-failing.
