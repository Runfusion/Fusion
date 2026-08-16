---
"@runfusion/fusion": patch
---

summary: Restore agent-activity telemetry, Plan Review convergence, and restart-retry safety guards lost in an executor refactor.
category: fix
dev: The wave-18 executor peel (#3317) was built from a stale base and silently dropped shipped behaviors; restored — FN-8864 agent-activity writers (task started/handed-off, workflow gate pass/fail, gate principal attribution via new `executor/workflow-gate-activity.ts`), FN-8768 Plan Review group recognition + convergence primer + modified-file review scoping, FN-6782's fire-time guard on transient resume-after-restart retries, FN-8868 session usage telemetry boundaries, recommendation-route withheld-tool guidance, and the per-instance worktree retry cap. Graph dispatch requiring `options.agentStore` (FN-8764/FN-8821) is intended behavior; the shared test harness now provisions it.
