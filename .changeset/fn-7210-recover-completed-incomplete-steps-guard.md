---
"@runfusion/fusion": patch
---

summary: Fix review tasks stuck when merge retries starve the executor's code-review revision pass.
category: fix
dev: recoverCompletedTask now refuses workflow-graph re-entry when the live task has incomplete steps or a remediation bounce (sendTaskBackForFix → scheduleWorkflowRerun) is already scheduled, so a pre-merge optional/advisory REVISE that reopens plan steps lets the executor finish them instead of re-passing the advisory step (budget exhausted) and looping on the "task has incomplete steps" merge gate. Regression: restart.integration.test.ts.
