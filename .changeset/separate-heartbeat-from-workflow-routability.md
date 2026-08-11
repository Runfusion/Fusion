---
"@runfusion/fusion": patch
---

summary: Built-in workflow agents no longer need heartbeats enabled to receive work.
category: fix
dev: `runtimeConfig.enabled` governs the durable heartbeat runtime only; workflow-stage routability is answered by `isWorkflowPrincipalEligible`, which treats the four built-in role owners (triage/executor/reviewer/merger) as routable structurally. Built-ins are provisioned `{ enabled: false, autoClaimRelevantTasks: false }` — no autonomous loops, no auto-claim — while every built-in role stays routable. Replaces the earlier write-seam coercion that forced `enabled: true`. Also re-applies the principal-hold backoff ladder (15s→5m, checked before graph entry) into `executor/execute-workflow-graph.ts`, where PR #3317's executor peel dropped it.
