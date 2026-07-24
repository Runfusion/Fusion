---
"@runfusion/fusion": minor
---

summary: One plan can now create multiple tasks — keep refining after a task is created and Proceed again.
category: feature
dev: Task-creation claims are epoch-scoped (`planning-session:{id}` → `…#N` via `planningProposalClaimId`); editing a plan past a created task rotates the epoch after turn admission. Complete sessions resume to an editable plan review with a linked-task banner; claim-lifecycle writes are surgical jsonb merges with an epoch-guarded reconcile; create-task 409s while a turn is generating.
