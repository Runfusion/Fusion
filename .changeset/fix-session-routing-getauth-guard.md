---
"@runfusion/fusion": patch
---

summary: Harden session-routing header wiring so a missing model-auth method can't break agent startup.
category: fix
dev: attachSessionRoutingHeaders now no-ops (warns) when ModelRuntime.getAuth is absent instead of throwing on getAuth.bind, restoring the pre-FN-8142 defensive invariant. Also realigns the pi-create-fn-agent and pi-session-routing-headers engine tests to the ModelRuntime.getAuth routing seam (mocks add the ModelRuntime export) so both suites pass against the 0.80.10 SDK landed by FN-8179.
