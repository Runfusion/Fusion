---
"@runfusion/fusion": patch
---

summary: Plan approve/reject API now blocks release-authorization holds, requiring the authorization marker first.
category: fix
dev: FN-7564 — POST /tasks/:id/approve-plan and /reject-plan now return 400 when task.awaitingApprovalReason === "release-authorization" (FN-7559 discriminator), enforcing the FN-6481 release-authorization gate at the API layer regardless of client. Manual-approval holds are unaffected.
