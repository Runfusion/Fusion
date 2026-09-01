---
"@runfusion/fusion": patch
---

summary: A landed merge no longer fails to finalize when the task row has no steps.
category: fix
dev: `planConfirmedMergeChecklistReconciliation` and the merge-confirmed fast path both assumed `task.steps` is an array. A row reaching them without it threw "Cannot read properties of undefined (reading 'map')", which the merge loop's catch absorbed — so a task whose work had already landed never finalized and never emitted `task:merged`. Both sites now tolerate an absent `steps`.
