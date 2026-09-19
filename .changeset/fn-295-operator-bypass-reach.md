---
"@runfusion/fusion": patch
---

summary: The review bypass now reaches any blocking gate, and merge blockers name the gate at fault.
category: fix
dev: `bypassFailedPreMergeReviewStep` falls back to a required gate whose result is not an approval (including a remediation-archived row) and erases the archive stamps the approval evaluator vetoes on; the `not-approved` merge blocker string now carries the offending gate id.
