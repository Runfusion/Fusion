---
"@runfusion/fusion": minor
---

summary: One plan can now create multiple tasks — in the dashboard, the CLI, and agent tools alike.
category: feature
dev: Task-creation claims are epoch-scoped (`planning-session:{id}` → `…#N` via `planningProposalClaimId`); editing a plan past a created task rotates the epoch after turn admission. Complete sessions resume to an editable plan review with a linked-task banner; claim-lifecycle writes are surgical jsonb merges with an epoch-guarded reconcile; create-task 409s while a turn is generating. `fn task plan` / `fn_task_plan` now create through the shared claim-aware `createTaskFromPlanSession` (idempotent, session-linked, epoch-aware) and gain `--resume <sessionId>` / `resumeSessionId` plus an interactive keep-refining loop.
