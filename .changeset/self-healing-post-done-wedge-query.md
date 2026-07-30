---
"@runfusion/fusion": patch
---

summary: Post-done wedge recovery now unsticks completed tasks on boards with renamed columns.
category: fix
dev: `recoverPostDoneNonContinuableWedge` queried the literal `in-review`, so a task that finished every step and was wedged `failed` by a post-done continuation error stayed failed on a renamed board. Read now resolves via `resolveProjectColumnsForRoles`, and its `getTaskHardMergeBlocker` judges each card against its own workflow.
