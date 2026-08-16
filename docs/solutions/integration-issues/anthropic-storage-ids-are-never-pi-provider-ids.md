---
title: "Anthropic auth-card/storage ids (anthropic-subscription, anthropic-api-key) must never reach pi as provider ids"
date: 2026-08-15
category: integration-issues
module: engine-auth
problem_type: integration_issue
component: authentication
symptoms:
  - "Task or session fails with `Unknown provider: anthropic-subscription`"
  - "Settings → Authentication → Anthropic Subscription Login permanently errors; /api/auth/status shows loginError `Unknown provider: anthropic-subscription`"
  - "Anthropic subscription users fall back to other providers or Claude CLI while the credential on disk is valid"
root_cause: identifier_domain_confusion
resolution_type: code_fix
severity: high
tags: [anthropic, oauth, subscription, provider-id, pi, model-runtime, auth-storage]
related_components: [authentication, model-resolution]
---

# Anthropic auth-card/storage ids are never pi provider ids

## The invariant

Fusion splits Anthropic authentication into two dashboard cards backed by dedicated **storage/UI ids**:

- `anthropic-subscription` — subscription OAuth storage row + card id
- `anthropic-api-key` — raw API-key card id (stores under `anthropic`)

pi (`@earendil-works/pi-ai` / `pi-coding-agent`) registers exactly ONE Anthropic execution provider: **`anthropic`**. Any pi surface that takes a provider id — `ModelRuntime.login`, `ModelRuntime.prepareRequest`/`stream` (via `model.provider`), `models.refresh({ providers })`, model registry lookups — throws `Unknown provider: <id>` (a `ModelsError`) when handed a storage/card id. Do NOT "fix" this by registering an `anthropic-subscription` provider in pi: that reroute reintroduced the #1857 regression (FN-7391/FN-7396).

Normalize at the boundary instead: `toExecutionModelProviderId(providerId)` from `@fusion/core` (`packages/core/src/ai/anthropic-models.ts`) maps both ids to `anthropic` and is the shared helper every seam must use.

## Incident history (three occurrences of the same class)

1. **#1857 / FN-7391 / FN-7396** — an `/v1`-based `anthropic-subscription` provider was registered in pi and OAuth rerouted through it; regressed subscription execution.
2. **FN-9101** — the dashboard model catalog briefly exposed credential-card rows as selectable model providers; persisted selections then failed model resolution. Fixed by normalizing in `resolveConfiguredModel` (`packages/engine/src/pi.ts`) and `createResolvedAgentSession` (`agent-session-helpers.ts`), and filtering catalog rows in `register-model-routes.ts`.
3. **GitHub #3462** — once the Authentication cards passed an explicit credential-instance id, dashboard login routed through `loginInstance` (`packages/engine/src/auth/provider-auth.ts`), which passed the storage row id straight to `ModelRuntime.login`. Every subscription login failed while the on-disk credential stayed valid. Fixed by making `loginInstance` reuse the Anthropic-aware `login` seam.

## Guards now in place

- **Choke point**: `FusionAuthStorage.login` (`packages/engine/src/auth/auth-storage.ts`) is the only seam that hands a provider id to `ModelRuntime.login`, and it normalizes via `toExecutionModelProviderId` before calling pi. A buggy caller now degrades to a correct upstream `anthropic` login instead of a hard failure. Regression test: `packages/engine/src/__tests__/auth-storage.test.ts` ("normalizes Anthropic storage-only ids…").
- **Login-instance seam**: `provider-auth.ts` `loginInstance` reuses the hoisted Anthropic-aware `login` (upstream login as `anthropic`, credential relocated to the `anthropic-subscription` row). Regression test: `packages/engine/src/__tests__/provider-auth-instances.test.ts` ("routes Anthropic subscription instance login…").
- **Model resolution**: `resolveConfiguredModel` and `createResolvedAgentSession` normalize persisted selections (FN-9101 tests: `agent-session-helpers-anthropic-subscription.test.ts`, `pi-create-fn-agent.test.ts`, `anthropic-execution-provider.test.ts`).
- **Catalog**: `register-model-routes.ts` drops credential-card rows from `/api/models` so they can never be selected/persisted as model providers.

## When adding a new seam

If new code passes a provider id from settings, task rows, auth storage, credential instances, or dashboard payloads into ANY pi API, run it through `toExecutionModelProviderId` first — and if the seam is auth-related, prefer routing through the existing Anthropic-aware login/getApiKey seams rather than talking to `ModelRuntime` directly. The same split-id pattern applies if another provider ever grows separate subscription/API-key cards: keep card ids out of the execution domain and extend the shared normalizer.
