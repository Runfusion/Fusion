---
"@runfusion/fusion": patch
---

Fix stale board entries after dependency-driven task re-specification moves by syncing the watched task cache after `updateTaskDependencies` writes and defensively deduplicating `listTasks` rows so active task rows win over archived snapshots.
