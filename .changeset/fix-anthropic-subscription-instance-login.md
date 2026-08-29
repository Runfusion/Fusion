---
"@runfusion/fusion": patch
---

summary: Fix Anthropic Subscription login failing with "Unknown provider: anthropic-subscription".
category: fix
dev: Instance-scoped OAuth login (`loginInstance`) now reuses the Anthropic-aware login seam, logging in upstream as `anthropic` and persisting to the `anthropic-subscription` storage row, instead of passing the storage-only id to `ModelRuntime.login` (GitHub #3462). `FusionAuthStorage.login` — the only seam handing a provider id to `ModelRuntime.login` — additionally normalizes Anthropic auth-card/storage ids via `toExecutionModelProviderId` as defense in depth; see docs/solutions/integration-issues/anthropic-storage-ids-are-never-pi-provider-ids.md.
