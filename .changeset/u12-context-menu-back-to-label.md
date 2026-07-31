---
"@runfusion/fusion": patch
---

summary: The "Back to" move-menu label now uses your workflow's own review and work column names.
category: fix
dev: `getTaskMoveTransitions` derived the "Back to In Progress" label from the hardcoded ids `in-review`/`in-progress` plus a hardcoded English string, so a workflow renaming those lanes either lost the label or named a column not on the board. Now keyed on the `mergeBlocker` (current) and `countsTowardWip` (target) traits with the column's own label via a new `taskDetail.move.backTo` key. The labelled set is unchanged for built-in workflows.
