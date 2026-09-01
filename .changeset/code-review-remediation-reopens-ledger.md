---
"@runfusion/fusion": patch
---

summary: A code review revision's fix steps can now start on the first try, with no manual retry.
category: fix
dev: The step-ledger reopen stamp was added only to `appendRemediationStepsImpl`, but `appendReviewRemediationSteps` takes an inline atomic branch whenever `attemptClaim` or a workspace remediation is present — which Code Review always supplies — so the failing path never reached it. The stamp is now written in that branch too, inside the same mutation as the steps.
