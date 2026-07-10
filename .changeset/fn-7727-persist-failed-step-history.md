---
"@runfusion/fusion": patch
---

summary: Preserve prior failed review-step attempts so self-healing re-runs no longer erase the failure history.
category: fix
dev: Adds an optional `priorAttempts?: WorkflowStepResult[]` field (bounded, single-level, capped at `MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS`) plus a shared pure `upsertWorkflowStepResult(existing, incoming, opts?)` helper in `@fusion/core` (`packages/core/src/workflow-step-results.ts`). Both engine recorders — the executor graph adapter's `recordWorkflowStepResult` and triage's `recordPlanReviewWorkflowResult` — now route through this helper instead of a bare replace-in-place upsert, so a self-healing recovery re-run of a failed pre-merge review node (code-review, plan-review, browser-verification) snapshots the prior `failed`/`advisory_failure` attempt into `priorAttempts` rather than overwriting it. Selection (self-healing, merge-blocker, progress/timing) is unchanged and reads only the current entry; `priorAttempts` is read-only history, surfaced in the task-detail Summary tab's Workflow results list as a collapsed "previous failed attempts" disclosure.
