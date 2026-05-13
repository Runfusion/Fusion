---
"@runfusion/fusion": patch
---

Fix `fn_task_done` failing to clear `paused`/`pausedByAgentId` when called on a paused task (FN-3964). Before this fix, a task with `task.paused=true` in `in-progress` or `todo` would land in a contradictory `todo + paused` state after completion, blocking future scheduler picks. Now the executor always clears task-level pause flags on explicit agent completion.
