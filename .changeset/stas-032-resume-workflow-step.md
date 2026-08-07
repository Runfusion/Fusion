---
"@runfusion/fusion": minor
---

summary: Add fn_workflow_step_resume operator tool to unstick permanently-pending merge review steps.
category: feature
dev: New CLI/pi-extension operator-only tool `fn_workflow_step_resume` (with `TaskStore.resumeWorkflowStep` + `findPendingPreMergeStep` helper) transitions a stuck `pending` pre-merge workflow step to `failed` with resume audit metadata so the existing `fn_task_bypass_review` escape hatch can clear the merge blocker. Audit-logged via the new `task:resume-step` run-audit event. Not exposed to executor/reviewer/triage agent surfaces.