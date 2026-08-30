---
"@runfusion/fusion": patch
---

summary: Allow workspace tasks to retry their current stage without losing repository landing progress.
category: fix
dev: Removes the `workspace-task` restart refusal and uses `isMergeActiveStatus` for the active-merge fence.
