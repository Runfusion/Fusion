---
"@dustinbyrne/kb": patch
---

Fix workflow step results persistence and column movement. Tasks now properly persist workflow step results to the task's `workflowStepResults` field, move to "in-review" even when workflow steps fail (so users can see and retry), and clear workflow step results when a task is retried.
