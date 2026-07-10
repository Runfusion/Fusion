---
"@runfusion/fusion": patch
---

summary: Stop false "Anthropic OAuth expired" notifications when the token is actually valid.
category: fix
dev: The OAuth expiry monitor and validity logger iterated the un-aliased `getOAuthProviders()` id `anthropic` and evaluated `get("anthropic")`, which can resolve to a stale legacy/supplemental row (e.g. `~/.pi/agent/auth.json`) even when the fresh, actually-used token lives under `anthropic-subscription`. Both now resolve the freshest of the two aliased ids via a shared `resolveEffectiveOAuthCredential` helper (mirroring the refresh scheduler's `getRefreshCandidateIds` alias handling), so a live subscription token suppresses the false alert. Notification cadence/throttle semantics are unchanged.
