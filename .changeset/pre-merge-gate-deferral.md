---
"@runfusion/fusion": patch
---

summary: A task no longer fails permanently when auto-merge runs before its Code Review gate.
category: fix
dev: Merge doors throw the typed `PreMergeStepsNotRunError` for the unrun-enabled-gate blocker; the auto-merge error path treats it as a deferral (no `status:"failed"` park, no retry burn), and `enqueueEligibleInReviewTasks` holds in-review cards out of the merge queue until every enabled pre-merge group has a result (`findUnrunRequiredPreMergeStepIds`).
