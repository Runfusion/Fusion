---
"@runfusion/fusion": patch
---

Truncate Plan-Only scope-leak activity-log entries and `fn_task_done` blocking refusal messages to the first 10 off-scope and declared-scope entries with a `… (+N more)` suffix and explicit `total off-scope=` / `total scope=` counters, so large tasks no longer flood the activity log.
