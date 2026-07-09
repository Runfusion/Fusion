---
"@runfusion/fusion": minor
---

summary: Add a policy-gated review-lane bypass for cards stranded by a failed pre-merge review step.
category: feature
dev: Adds the operator-only `fn_task_bypass_review` CLI/pi-extension tool, `POST /tasks/:id/bypass-review` dashboard API route, `store.bypassFailedPreMergeReviewStep(id, { reason, actor })`, `task-merge.ts` `getLatestFailedPreMergeReviewStep`, and `bypassedBy`/`bypassedAt`/`bypassReason`/`bypassedFromStatus`/`bypassedFromVerdict` `WorkflowStepResult` fields. Not exposed to executor/reviewer/triage agent tool lists.
