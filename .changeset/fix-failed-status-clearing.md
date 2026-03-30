---
"@dustinbyrne/kb": patch
---

Fix "failed" status showing on dashboard for non-failed tasks

When a task failed during execution and was moved from "in-progress" back to "todo" or "triage" for retry, the `status` and `error` fields were not being cleared. This caused the dashboard to continue showing the red "failed" badge even though the task was ready for re-execution.

The `moveTask` function now clears `status`, `error`, `worktree`, and `blockedBy` fields when moving from "in-progress" to "todo" or "triage", matching the behavior already in place for the "done" column.
