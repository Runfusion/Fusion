---
"@dustinbyrne/kb": patch
---

Remove duplicate ntfy notification on task merge

Previously, when a task was merged to main, two identical notifications were sent because both `task:moved` (to "done") and `task:merged` events triggered notifications. Now only the `task:merged` event sends the notification, eliminating the duplicate.
