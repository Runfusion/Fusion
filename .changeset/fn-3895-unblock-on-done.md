---
"@runfusion/fusion": patch
---

Improve stale dependency unblocking so todo tasks are released promptly when their blocker reaches done or archived, and ensure startup recovery runs the stale `blockedBy` sweep once on boot to repair previously stuck rows. This complements the existing periodic self-heal pass, reducing unblock latency and automatically repairing incidents like dependents remaining blocked after a completed task.
