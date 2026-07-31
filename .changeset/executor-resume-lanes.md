---
"@runfusion/fusion": patch
---

summary: A task interrupted by an engine pause now resumes on boards with renamed columns.
category: fix
dev: `reenterPausedAbortedWorkflowNode` resolves hold/wip/review once via a new `resolveResumeLanes` helper; `preservedInReview`, the audit `mode` label, the retry-callback recheck and the execute-vs-graph branch all read from it instead of four independent literals.
