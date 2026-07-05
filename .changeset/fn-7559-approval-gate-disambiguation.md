---
"@runfusion/fusion": patch
---

summary: Tasks held for release authorization or Plan Review are now shown distinctly, so auto-approve no longer looks broken.
category: fix
dev: FN-7559 — auto-approve-all bypasses only the manual plan-approval gate (unchanged, FN-7526). Release-authorization holds are surfaced with a new distinct status reason (`Task.awaitingApprovalReason: "release-authorization"`) and no longer render the generic manual Approve/Reject affordance in TaskCard/TaskDetailModal; Workflow Plan Review already used distinct statuses (`needs-replan`/`plan-review-unavailable`) and is unaffected. Both gates remain independent and intact — this is UI/data disambiguation only.
