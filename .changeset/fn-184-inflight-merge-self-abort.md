---
"@runfusion/fusion": patch
---

summary: Fix merges never completing — an in-flight merge no longer aborts itself every 15 seconds.
category: fix
dev: The FN-180 in-flight revoke watcher in `ProjectEngine.wireTaskPauseMergeInterruption` read `runAiMerge`'s own `status:"merging"` stamp as a blocking pre-merge verdict, because `merging`/`merging-pr` are in `HARD_BLOCKING_TASK_STATUSES` and the CLI entry points wire the unoptioned `getTaskMergeBlocker`. The abort spent no `mergeRetries`, so the drain catch cleared the stamp and the sweep re-admitted the task every `pollIntervalMs` indefinitely. The blocker is now evaluated against a verdict view that neutralizes `isMergeActiveStatus` for the task this engine already owns; genuine verdicts, `paused`, `queued`, and merge-active stamps on other tasks are unaffected.
