---
"@runfusion/fusion": patch
---

summary: Agents now auto-recover from transient OAuth token-rotation 401 errors instead of parking for operator action.
category: fix
dev: Adds `isTransientAuthCredentialError` to the shared transient-error classifier (401 `authentication_error` / "Invalid authentication credentials" / token-expired shapes are transient and not operator-actionable; OAuth scope-grant and API-key failures still park). Heartbeat prompts now run under `withRateLimitRetry` so mid-run token rotations retry in-run. Heartbeat failure classification uses the error message instead of the stack-bearing detail. Self-healing un-parks agents previously paused with `error-unrecoverable` whose lastError now classifies recoverable.
