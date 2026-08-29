---
"@runfusion/fusion": patch
---

summary: Workflow gates are classified by what they are, not by what they are called.
category: fix
dev: Three name/id-coupling defects removed. `workflowNodeRequiresWorktree` matched `/review|verification/i` against `config.name`, so a deterministic verification gate was classified write-capable purely because of its label and the review seal refused it on every post-approval replay; it now keys on `reviewKind`, `workflowAction` and the optional-group id. The review seal's `isCodeReview` likewise matched `/code review/i`, which would have silently unrecognised a gate renamed to "Final Review". `getRunningOptionalGateBadge` replaced a closed three-id allowlist with `isNonImplementationWorkflowStepId`, so review-lane gates added by a workflow surface a running badge instead of leaving the card apparently idle until "Merging". Lifecycle-column ratchet ceilings lowered to measured counts (todo 64→12, in-progress 197→72, in-review 213→28).
