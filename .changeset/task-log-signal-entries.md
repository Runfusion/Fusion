---
"@runfusion/fusion": patch
---

summary: Board lists no longer read every task's full log history on each poll.
category: performance
dev: Migration 0090 adds project.tasks.log_signal_entries, a trigger-maintained in-order subset of log holding exactly the entries slim-list signals can read; slim listTasks reads it instead of log.
