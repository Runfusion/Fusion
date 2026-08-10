---
"@runfusion/fusion": patch
---

summary: Fix a deadlock where built-in workflow agents were unroutable, leaving every task stuck and spinning.
category: fix
dev: `provisionBuiltinWorkflowRoleAgents` seeded the four permanent owners with `runtimeConfig.enabled: false` while the router's `available()` rejects `enabled === false`, so no built-in role could ever be routed. Built-ins are now seeded enabled, existing rows converge on provisioning, and `enforceBuiltinWorkflowRoleRoutability` coerces them back at the durable `writeAgent` seam so no API/UI/plugin path can disable them. The static routability predicate (`isWorkflowPrincipalEligible`) is shared by provisioning and the router so they cannot drift. Separately, a workflow-principal hold now uses a backoff ladder (`PRINCIPAL_HOLD_BACKOFF_MS`, 15s→5m) checked before graph entry, instead of re-dispatching immediately — the old path spun ~3.5×/sec writing ~19k audit rows/hour with nothing executing.
