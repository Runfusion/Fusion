---
"@runfusion/fusion": patch
---

summary: Speed up task lists and hold-release scheduling by batching workflow selection reads.
category: performance
dev: Adds prefetchWorkflowSelections and listTasks selectionCache/selectionReadTally options.
