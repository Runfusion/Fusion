---
"@runfusion/fusion": patch
---

summary: Bound durable-agent heartbeat worktree-acquisition retries and count exhausted failures.
category: fix
dev: HeartbeatMonitor.executeHeartbeat's task worktree acquisition (agent-heartbeat.ts) previously requeued a task to "todo" on every acquisition failure with no cross-heartbeat retry cap, unlike Executor.createWorktree's bounded MAX_WORKTREE_RETRIES loop. Adds MAX_HEARTBEAT_WORKTREE_ACQUISITION_RETRIES (3), reusing Task.recoveryRetryCount as the counter (no schema migration). On cap exhaustion the task is terminally marked status:"failed" and a new onTaskAcquisitionExhausted callback is invoked; in-process-runtime.ts wires it to CentralCore.recordTaskCompletion(taskId, false) so the failure is counted (previously totalTasksFailed could stay 0 for this path). Investigation (FN-7721) found the other reported worktree-collision sub-gaps (branch-exists idempotent reuse, in-call retry cap, branch↔task-ID naming) already handled or not reproducing on HEAD — see task docs for evidence.
