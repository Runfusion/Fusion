---
"@runfusion/fusion": patch
---

Fix the global pause/resume failure mode that stalled the board: a pause-abort that left a task back in `todo` was parked `status:"failed"` ("operator action required") and leaked its in-memory worktree slot, producing an instant re-fail retry storm and concurrency-starving the whole queue.

- Root cause: `handleGraphFailure` now treats a pause-abort that has re-queued a task to `todo` as benign (FN-6782) — it no longer parks it failed, clears the `pausedAborted` marker so the next dispatch starts clean, and releases the leaked worktree slot.
- Auto-recovery: a new `recoverPausedAbortFailures` self-healing sweep clears any pause-abort park (`status:"failed"` with "operator action required") still on the board and requeues it for normal scheduling, so the board self-heals without operator intervention.
- Defense-in-depth: a new `reapLeakedConcurrencySlots` self-healing sweep reclaims any in-memory worktree slot whose holder is no longer in-progress (the "in todo yet still a `maxWorktrees` holder" leak), gated by the executor's live-session refusal so it can never pull a worktree out from under a running agent. This recovers a leaked slot from any future/unknown path without an engine restart.
