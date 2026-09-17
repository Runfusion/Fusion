---
"@runfusion/fusion": minor
---

summary: Mark a task at creation so it waits for your plan approval, with a message on approve or reject.
category: feature
dev: Adds `Task.humanPlanApproval` (migration 0080, `project.tasks.human_plan_approval`) and the shared predicates in `packages/core/src/planner/human-plan-approval.ts`. Proof requires an operator decision matching both `approvedPlanFingerprint` and the current Plan Review episode; `approvedPlanFingerprint` alone is never sufficient. Release admission converges on `evaluateUnplannedForExecution` (new `human-plan-approval-pending` reason) plus an execution-entry fence, evaluated before the Fast short-circuit. `approve-plan`/`reject-plan` accept optional `message`, `requestId`, `expectedPlanFingerprint`, and `expectedEpisodeId`; reject routes through `buildPreservedPlanRespecifyPatch` instead of deleting PROMPT.md.
