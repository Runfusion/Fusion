---
"@runfusion/fusion": patch
---

summary: Auto-approve now reliably sends specified plans to the board without a manual approval stop.
category: fix
dev: FN-7526 — investigated the reported "plans still park at awaiting-approval when auto-approve is on" symptom; resolvePlanApprovalRequired, mergeEffectiveSettings/applyWorkflowSettingsOverlay, and every finalizeApprovedTask call site (specifyTask, recoverApprovedTask, retryUnavailablePlanReview, tryFinalizeExplicitDuplicateMarker) already honored project planApprovalMode: "auto-approve-all" over a stored workflow requirePlanApproval value — no production defect reproduced. Added end-to-end regression coverage across every enumerated surface (Plan Review reviewer-outage retry, refinement routing, self-healing starved-refinement recovery) using the real mergeEffectiveSettings pipeline instead of isolated bare-settings unit calls, plus explicit assertions that the independent release-authorization and Workflow Plan Review gates remain intact under auto-approve-all, so a future bare-settings call site is caught immediately instead of silently reintroducing the reported behavior.
