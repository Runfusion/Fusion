/**
 * FNXC:CodeOrganization 2026-08-04-06:50:
 * Inventory of TaskExecutor facade FNXC pointers relocated from executor.ts (U4 line-count ratchet).
 * Method bodies remain thin facades; requirement history for each peel lives on the named host module.
 *
 * - 2026-08-04-03:15: activeWorktrees SET semantics FNXC lives on active-worktrees.ts.
 * - 2026-08-04-03:15: Pause/abort provenance FNXC lives on paused-abort-provenance.ts.
 * - 2026-08-04-03:15: completionFinalizedTaskIds FNXC lives on pause-abort-markers.ts.
 * - 2026-08-04-03:15: safeLogEntry FN-7335 breadcrumb FNXC lives on safe-log-entry.ts.
 * - 2026-08-04-03:00: Full Workspace/PlanReviewWorktree FNXC lives on session-registry-path.ts.
 * - 2026-08-04-03:00: Full SessionContention FNXC lives on acquire-session-registry-path.ts.
 * - 2026-08-04-03:35: handoffTaskToReview reason/failure FNXC lives on handoff-task-to-review.ts.
 * - 2026-08-04-06:15: isTaskLiveForOverseerRetry FNXC lives on is-task-live-for-overseer-retry.ts.
 * - 2026-08-04-03:40: abortAllSessionBash FNXC lives on abort-all-session-bash.ts.
 * - 2026-08-04-06:20: isBackward body stays here (inert-sync 2); FNXC host is-backward-move-out-of-planning.ts.
 * - 2026-08-04-03:35: signalTaskComplete FN-7528 FNXC lives on signal-task-complete.ts.
 * - 2026-08-04-03:40: clearTerminalStepFailures ReviewLeniency FNXC lives on clear-terminal-step-failures-for-retry.ts.
 * - 2026-08-04-03:30: recoverFailedPreMerge FNXC lives on recover-failed-pre-merge-step.ts.
 * - 2026-08-04-03:15: listWipLaneTasks resume-sweep FNXC lives on list-wip-lane-tasks.ts.
 * - 2026-08-04-03:20: graphCompletion U5d/U5e FNXC lives on task-executor-options.ts.
 * - 2026-08-04-03:15: no-merge complete-column + IR pin FNXC lives on no-merge-complete-column.ts.
 * - 2026-08-04-03:15: column-boundary hooks FNXC lives on build-column-boundary-hooks.ts.
 * - 2026-08-04-03:20: runImplementationPhase U5e FNXC lives on run-implementation-phase.ts.
 * - 2026-08-04-03:20: step-inversion driver FNXC lives on run-graph-task-step.ts.
 * - 2026-08-04-03:20: projected step worktree-gating FNXC lives on run-projected-graph-task-step.ts.
 * - 2026-08-04-03:30: column-agent seam FNXC lives on resolve-seam-column-agent.ts / resolve-effective-principal-id.ts / is-agent-effectively-executing.ts.
 * - 2026-08-04-03:25: planning worktree acquisition FNXC lives on ensure-task-worktree-for-planning.ts.
 * - 2026-08-04-03:30: session-contention hold FNXC lives on session-contention-hold.ts.
 * - 2026-08-04-06:15: hasLiveTaskSessionSurface FNXC lives on has-live-task-session-surface host peel.
 * - 2026-08-04-06:15: isRemediationGraphNode FNXC lives on remediation-graph-node.ts.
 * - 2026-08-04-06:15: isPreMergeRemediationGraphNode FNXC lives on remediation-graph-node.ts.
 * - 2026-08-04-03:05: Full Phase C resume-eligibility FNXC lives on resolve-resume-lanes.ts.
 * - 2026-08-04-03:25: ephemeral-off dispatch guard FNXC lives on block-outer-dispatch-when-ephemeral-disabled.ts.
 * - 2026-08-04-03:25: execute wrapper + executeCore routing FNXC lives on execute-core.ts.
 * - 2026-08-04-03:25: runImplementation U5e/U10b/U8 FNXC lives on run-implementation.ts.
 * - 2026-08-04-03:40: recoverApprovedSteps FNXC lives on recover-approved-steps-on-resume.ts.
 * - 2026-08-04-03:40: reconcileStepsFromGitHistory FNXC lives on reconcile-steps-from-git-history.ts.
 * - 2026-08-04-03:40: handleLoopDetected FNXC lives on handle-loop-detected.ts.
 * - 2026-08-04-03:30: getWorktreePath KTD2 contract FNXC lives on active-worktrees helpers / free peel.
 */

export {};
