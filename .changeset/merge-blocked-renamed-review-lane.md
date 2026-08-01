---
"@runfusion/fusion": patch
---

summary: Tasks can be merged again on boards whose review column is renamed.
category: fix
dev: Both merge entry points called `getTaskMergeBlocker` without `reviewColumns`, so its column-identity check used the literal `in-review` and returned a blocker for any renamed review lane — `aiMergeTask` and `runAiMerge` then threw `Cannot merge FN-x: task is in '<lane>', must be in 'in-review'`. Both now resolve the task's own review lanes.
