/**
 * FNXC:CodeOrganization 2026-08-04-06:40:
 * TaskExecutor private field requirement notes (U4). Field *declarations* stay on TaskExecutor;
 * this module hosts the non-FNXC field docs so executor.ts can keep ratcheting line-count.
 *
 * - `resumingUnpaused`: Tasks currently being prepared for unpause resume, before execute() has registered them.
 * - `approvalSuspended`: Tasks whose active session was intentionally suspended by an action gate.
 * - `approvalResumeAfterUnwind`: Approval decisions received while the old execute() lifecycle is still unwinding.
 * - `recoveringCompleted`: Completed orphan recovery tasks currently running during startup.
 * - `capturedReflectionTaskIds`: FN-7528: once-per-completion reflection capture guard (see signal-task-complete.ts).
 * - `workflowRerunPending`: Workflow-rerun bounce in flight (todo→in-progress); blocks premature task:moved execute().
 * - `workflowLifecycleMovesInFlight`: Graph-owned task:moved emissions so external moves still hard-cancel.
 * - `pendingTaskDisposals`: FN-5256: in-flight session-disposal promises (await before re-dispatch worktree).
 * - `activeSessions`: Active agent sessions per task, used to terminate on pause and inject steering.
 * - `activeStepExecutors`: Active step-session executors per task (mutually exclusive with activeSessions).
 * - `activeStepExecutorSeenSteeringIds`: Steering comments already observed for active step-session executor runs.
 * - `activeWorkflowStepSessions`: Active pre-merge workflow step sessions per task.
 * - `activeWorkflowStepSessionSeenSteeringIds`: Steering comments already observed for active workflow step sessions.
 * - `activeConfiguredCommandControllers`: Active configured-command abort controllers keyed by task.
 * - `authoritativeAssignedAgentStore`: Lazy root-project AgentStore when execution is handed an agents-less worktree store.
 * - `activeWorkflowGraphAbortControllers`: Active workflow-graph runner abort controllers keyed by task.
 * - `activeCliTaskSessions`: CLI agent task sessions (U7) — hard-cancel SIGKILL + in-review PTY reap.
 * - `activeSubagentSessions`: Reviewer subagent sessions — disposed with parent kill paths.
 * - `pausedAborted`: Tasks that were paused mid-execution (to avoid marking them as "failed").
 * - `depAborted`: Tasks that had a dependency added mid-execution (abort + discard worktree).
 * - `stuckAborted`: Tasks killed by stuck task detector. Value = shouldRequeue (budget not exhausted).
 * - `userCanceledTaskIds`: Tasks explicitly canceled by user move (in-progress → todo).
 * - `graphExecuteSelfRequeued`: Run-local marker: graph execute self-requeued for recoverable repair (outer failure sink must not overwrite).
 * - `loopRecoveryState`: In-memory loop recovery state per task (compact-and-resume attempts; reset at execute finally).
 * - `spawnedAgents`: Spawned child agent IDs per parent task ID. Used for lifecycle tracking.
 * - `tokenUsageBaselines`: Per-task baseline of session stats used for delta persistence across repeated updates.
 * - `branchConflictErrorCount`: In-memory branch conflict error counters per task for tripwire protection.
 * - `completedTaskWatchdogs`: One-shot watchdogs for completed tasks that should have transitioned to in-review.
 * - `workflowRerunWatchdogs`: One-shot watchdogs for workflow reruns that should have bounced back to in-progress.
 * - `pendingEphemeralDeletions`: Set of ephemeral spawned agent IDs with in-flight cleanup (prevents duplicate deletion attempts).
 * - `childSessions`: Child agent sessions keyed by agent ID. Used for termination.
 * - `totalSpawnedCount`: Total count of currently spawned agents (across all parents).
 * - `tokenCapDetector`: Token cap detector for proactive context compaction.
 * - `currentRunContexts`: Current run context for mutation correlation, keyed by task id.
 * - `outerConcurrencyClaims`: Tasks whose graph run already owns a top-level concurrency slot (scheduler pre-held handoff).
 * - `graphToolFailureRunCursors`: Per graph-run agent-log boundary; passed to failure handling rather than trusting stale task snapshots.
 * - `graphStepSessionPinned`: Step-inversion pin for hard per-step boundary before step-review (cleared on graph finally).
 * - `graphStepRunOnce`: Step-inversion (U6/U8): once-per-run implementation-phase cache keyed by task id.
 * - `graphStepActiveContext`: Step-inversion (KTD-4): active foreach context for deferDoneToReview (`taskId:instanceId`).
 * - `graphColumnAgentResolver`: Per-run column-agent binding resolver (nodeId → binding); cleared in graph finally.
 * - `graphUnattendedRuns`: (U3) Unattended graph runs (LFG/pipeline) — FUSION_HEADLESS for skill steps.
 * - `graphSeamGoverningNodeId`: Governing seam node id for in-flight implementation pass (column-agent plan U4).
 * - `mergeRequester`: Wired by the runtime to ProjectEngine.onMerge.
 */

export {};
