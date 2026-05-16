---
"@runfusion/fusion": minor
---

Fail-hard by default when a delegated worktrunk operation fails: the task is paused with `pausedReason: "worktrunk_operation_failed"` and the underlying stderr is surfaced in the dashboard. Set `worktrunk.onFailure: "fallback-native"` to instead fall back transparently to Fusion's built-in worktree-pool and receive a one-shot dashboard alert per task.
