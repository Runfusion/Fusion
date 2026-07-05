---
"@runfusion/fusion": patch
---

summary: Manual plan approval no longer re-asks you to approve a plan you already approved when it hasn't changed.
category: fix
dev: FN-7569 — approving a plan records a fingerprint of the approved PROMPT.md (new nullable Task.approvedPlanFingerprint, migration 139). The manual plan-approval gate skips re-parking at awaiting-approval when a re-specification (replan, plan-review retry, self-healing rebound) produces the same plan; a changed plan or reject-plan still requires fresh approval. Release authorization, Workflow Plan Review, and auto-approve-all are unchanged.
