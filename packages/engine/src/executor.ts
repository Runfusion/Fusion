// port-4040-allowlist: this file embeds the "never kill port 4040" rule in the executor prompt.
import {
  AgentStore,
  type TaskStore, type Task, type TaskDetail, type TaskTokenUsage, type Settings,
  type RunMutationContext, type Agent, type MergeResult, type WorkflowIrNode,
  type ThinkingLevel,
  type WorkflowIr, type WorkflowFieldDefinition, type WorkflowColumnAgent, type TaskMoveLanes,
  type ApprovalRequestStore, type WorkspaceConfig, type RunCommandResult,
} from "@fusion/core";
import type { ImplementationExit } from "./executor/implementation-exit.js";
import { resolvePlannerLanes } from "./execution/replan-target.js";
import { type WorkflowGraphTaskRunResult, type WorkflowColumnBoundaryHooks } from "./workflows/workflow-graph-task-runner.js";
import type { ParseStepsHandlerDeps, CodeNodeRunner, ForeachActiveContext, WorkflowLegacySeams } from "./workflows/workflow-node-handlers.js";
import type { WorkflowBranchPersistence } from "./workflows/workflow-graph-branches.js";
import type { WorkflowStepInstancePersistence } from "./workflows/workflow-graph-foreach.js";
import type { WorkflowNodeResult } from "./workflows/workflow-graph-executor.js";
import type { WorkflowRuntimePrimitives } from "./execution/runtime-primitives.js";
import { createWorkflowRuntimePrimitiveProvider } from "./workflows/workflow-runtime-primitive-provider.js";
import { type VerificationResult } from "./execution/verification-utils.js";
import type { ReviewResult } from "./execution/reviewer.js";
import { ModelRegistry, type ToolDefinition, type AgentSession } from "@earendil-works/pi-coding-agent";
import { dropPreHeldExecutorSlot } from "./concurrency/concurrency.js";
/* FNXC:Workspace 2026-06-21-15:00: F5/F8 workspace-path helpers are consumed via free peels / pure-bindings, not direct imports here. */
import { activeSessionRegistry } from "./agents/active-session-registry.js";
import { CliTaskSession } from "./cli-agent/task-session.js";
import { TokenCapDetector } from "./errors/token-cap-detector.js";

import { StepSessionExecutor } from "./execution/step-session-executor.js";
import type { RunTaskStepResult } from "./execution/step-runner.js";
import type { RunAuditor } from "./util/run-audit.js";
import { AutoRecoveryDispatcher } from "./healing/auto-recovery.js";
import { getTaskCompletionBlockerForStore } from "./execution/task-completion.js";
import type { AgentActionGateContext } from "./agents/agent-action-gate.js";

/* FNXC:CodeOrganization 2026-08-03-20:50: Public non-Free re-exports in executor/public-reexports.ts. */
export * from "./executor/public-reexports.js";
import type { PausedAbortProvenance } from "./executor/paused-abort-provenance.js";

/* FNXC:CodeOrganization 2026-08-04-06:15:
 Executor tunables via namespace import (U4).
*/
import * as constants from "./executor/executor-constants.js";

/* FNXC:CodeOrganization 2026-08-04-06:15:
 Pure free-helpers via namespace import (U4) — line-count ratchet for pure-bindings barrel.
*/
import * as pure from "./executor/pure-bindings.js";
/* FNXC:CodeOrganization 2026-08-04-06:05:
 Impl bindings via namespace import (U4) — collapses the long named-import list so executor.ts line count
 can keep ratcheting without per-symbol import lines.
*/
import * as impl from "./executor/impl-bindings.js";

/* FNXC:CodeOrganization 2026-08-03-20:40: Free re-exports live in executor/free-reexports.ts (U4 barrel). */
export * from "./executor/free-reexports.js";
import type { ActiveSessionBookkeepingDeps } from "./executor/active-session-bookkeeping.js";
import type { TaskLivenessDeps } from "./executor/task-liveness.js";
/* FNXC:CodeOrganization 2026-08-04-06:05:
 Deps-bag builders via namespace import (U4) — same line-count ratchet as impl-bindings.
*/
import * as bags from "./executor/deps-bags.js";
import { facadeFields, facadeMethods, type FacadeRestArgs, type FacadeAfterFirst, type FacadeAfterSecond } from "./executor/facade-methods.js";
import { bindHandleWorktreeConflict, bindTryCreateWorktree } from "./executor/worktree-create-binders.js";
import { buildWireExecutorLifecycleDeps, wireExecutorLifecycle } from "./executor/wire-executor-lifecycle.js";

export async function __runConfiguredCommandForTests(
  command: string,
  cwd: string,
  timeoutMs: number,
  extraEnv?: NodeJS.ProcessEnv,
  auditor?: RunAuditor,
  signal?: AbortSignal,
): Promise<RunCommandResult> {
  return pure.runConfiguredCommand(command, cwd, timeoutMs, extraEnv, auditor, signal);
}

/* FNXC:CodeOrganization 2026-08-04-02:35: Orphan await-input/conventions JSDoc removed — lives on await-input-parse.ts + workflow-step-verdict.ts peels. */
import type {
  WorkflowStepOutcome,
} from "./executor/workflow-step-verdict.js";

/* FNXC:CodeOrganization 2026-08-03-21:00: Options/types live in executor/task-executor-options.ts. */
export type {
  TaskExecutorOptions,
  CliAgentRuntime,
  ActiveExecutorSessionState,
  GraphCompletionCallback,
} from "./executor/task-executor-options.js";
import type {
  TaskExecutorOptions,
  ActiveExecutorSessionState,
} from "./executor/task-executor-options.js";

/* FNXC:CodeOrganization 2026-08-04-03:10: Rebound/guard Phase C FNXC lives on lifecycle-columns.ts; GraphCompletionCallback U5d/U5e on task-executor-options.ts. */

export class TaskExecutor {
  /* FNXC:CodeOrganization 2026-08-04-03:15: activeWorktrees SET semantics FNXC lives on active-worktrees.ts. */
  private activeWorktrees = new Map<string, Set<string>>();

  private addActiveWorktree(taskId: string, worktreePath: string): void {
    impl.addActiveWorktreeImpl(this.activeWorktrees, taskId, worktreePath);
  }

  private getActiveWorktreePaths(taskId: string): string[] {
    return impl.getActiveWorktreePathsImpl(this.activeWorktrees, taskId);
  }
  private executing = new Set<string>();
  /** Tasks currently being prepared for unpause resume, before execute() has registered them. */
  private resumingUnpaused = new Set<string>();
  /** Tasks whose active session was intentionally suspended by an action gate. */
  private approvalSuspended = new Set<string>();
  /** Approval decisions received while the old execute() lifecycle is still unwinding. */
  private approvalResumeAfterUnwind = new Set<string>();
  /** Completed orphan recovery tasks currently running during startup. */
  private recoveringCompleted = new Set<string>();
  /** FN-7528: once-per-completion reflection capture guard (see signal-task-complete.ts). */
  private capturedReflectionTaskIds = new Set<string>();
  /** Workflow-rerun bounce in flight (todo→in-progress); blocks premature task:moved execute(). */
  private workflowRerunPending = new Set<string>();
  /** Graph-owned task:moved emissions so external moves still hard-cancel. */
  private workflowLifecycleMovesInFlight = new Set<string>();
  /** FN-5256: in-flight session-disposal promises (await before re-dispatch worktree). */
  private pendingTaskDisposals = new Map<string, Promise<void>>();
  private unregisterTaskMoveDisposer: (() => void) | undefined;
  private unregisterArchiveWorktreeDisposer: (() => void) | undefined;
  private unregisterArchiveWorkspaceWorktreeDisposer: (() => void) | undefined;
  /** Active agent sessions per task, used to terminate on pause and inject steering. */
  private activeSessions = new Map<string, ActiveExecutorSessionState>();
  /** Active step-session executors per task (mutually exclusive with activeSessions). */
  private activeStepExecutors = new Map<string, StepSessionExecutor>();
  /** Steering comments already observed for active step-session executor runs. */
  private activeStepExecutorSeenSteeringIds = new Map<string, Set<string>>();
  /* FNXC:CodeOrganization 2026-08-04-03:35: effectiveColumnAgentByTask semantics on is-agent-effectively-executing.ts. */
  private effectiveColumnAgentByTask = new Map<string, string>();
  /** Active pre-merge workflow step sessions per task. */
  private activeWorkflowStepSessions = new Map<string, AgentSession>();
  /** FNXC:TaskTiming 2026-07-30-21:40: graph-owned Plan Review sessions only (self-healing liveness). */
  private activePlanningWorkflowSessions = new Set<string>();
  /** Steering comments already observed for active workflow step sessions. */
  private activeWorkflowStepSessionSeenSteeringIds = new Map<string, Set<string>>();
  /** Active configured-command abort controllers keyed by task. */
  private activeConfiguredCommandControllers = new Map<string, Set<AbortController>>();
  /** Lazy root-project AgentStore when execution is handed an agents-less worktree store. */
  private authoritativeAssignedAgentStore: AgentStore | null = null;
  /** Active workflow-graph runner abort controllers keyed by task. */
  private activeWorkflowGraphAbortControllers = new Map<string, AbortController>();
  /** CLI agent task sessions (U7) — hard-cancel SIGKILL + in-review PTY reap. */
  private activeCliTaskSessions = new Map<string, CliTaskSession>();
  private readonlyWorkflowStepAuditDone = false;
  /** Reviewer subagent sessions — disposed with parent kill paths. */
  private activeSubagentSessions = new Map<string, Set<AgentSession>>();
  /** Tasks that were paused mid-execution (to avoid marking them as "failed"). */
  private pausedAborted = new Set<string>();
  /* FNXC:CodeOrganization 2026-08-04-03:15: Pause/abort provenance FNXC lives on paused-abort-provenance.ts. */
  private pausedAbortProvenance = new Map<string, PausedAbortProvenance>();
  /* FNXC:CodeOrganization 2026-08-04-03:15: completionFinalizedTaskIds FNXC lives on pause-abort-markers.ts. */
  private completionFinalizedTaskIds = new Set<string>();
  /** Tasks that had a dependency added mid-execution (abort + discard worktree). */
  private depAborted = new Set<string>();
  /** Tasks killed by stuck task detector. Value = shouldRequeue (budget not exhausted). */
  private stuckAborted = new Map<string, boolean>();
  /** Tasks explicitly canceled by user move (in-progress → todo). */
  private userCanceledTaskIds = new Set<string>();
  /** Run-local marker: graph execute self-requeued for recoverable repair (outer failure sink must not overwrite). */
  private graphExecuteSelfRequeued = new Set<string>();
  /** In-memory loop recovery state per task. Keyed by taskId, not persisted.
   *  Tracks compact-and-resume attempt count per execute() lifecycle.
   *  Reset at execute() lifecycle end (finally block). */
  private loopRecoveryState = new Map<string, { attempts: number; pending: boolean }>();
  /** Spawned child agent IDs per parent task ID. Used for lifecycle tracking. */
  private spawnedAgents = new Map<string, Set<string>>();
  /** Per-task baseline of session stats used for delta persistence across repeated updates. */
  private tokenUsageBaselines = new Map<string, { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; totalTokens: number }>();
  /** In-memory branch conflict error counters per task for tripwire protection. */
  private branchConflictErrorCount = new Map<string, number>();
  /** One-shot watchdogs for completed tasks that should have transitioned to in-review. */
  private completedTaskWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  /** One-shot watchdogs for workflow reruns that should have bounced back to in-progress. */
  private workflowRerunWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  /** Set of ephemeral spawned agent IDs with in-flight cleanup (prevents duplicate deletion attempts). */
  private pendingEphemeralDeletions = new Set<string>();
  private workspaceConfig: WorkspaceConfig | null | undefined = undefined;

  /* FNXC:CodeOrganization 2026-08-04-03:15: safeLogEntry FN-7335 breadcrumb FNXC lives on safe-log-entry.ts. */
  private safeLogEntry(taskId: string, message: string): void {
    impl.safeLogEntryImpl(this.storeRunContextDeps(), taskId, message);
  }

  private markPausedAborted(
    ...args: FacadeRestArgs<typeof impl.markPausedAbortedImpl>
  ): void {
    impl.markPausedAbortedImpl(bags.buildMarkPausedAbortedDeps(this), ...args);
  }

  private pauseAbortMarkerDeps() {
    return bags.buildPauseAbortMarkerDeps(this);
  }
  private markCompletionFinalized(taskId: string): void { impl.markCompletionFinalizedImpl(this.pauseAbortMarkerDeps(), taskId); }
  private clearPausedAborted(taskId: string): void { impl.clearPausedAbortedImpl(this.pauseAbortMarkerDeps(), taskId); }

  private async clearStalePauseAbortBeforeDispatch(task: Task): Promise<void> {
    return impl.clearStalePauseAbortBeforeDispatchImpl(bags.buildClearStalePauseAbortBeforeDispatchDeps(this), task);
  }

  clearPauseAbortStateForManualRetry(taskId: string): void {
    impl.clearPauseAbortStateForManualRetryImpl(
      { clearPausedAborted: (id: string) => this.clearPausedAborted(id) },
      taskId,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:00: Full Workspace/PlanReviewWorktree FNXC lives on session-registry-path.ts. */
  private sessionRegistryPath(taskId: string, worktreePath: string): string {
    return impl.sessionRegistryPathImpl(this.rootDir, taskId, worktreePath);
  }

  private activeSessionBookkeepingDeps(): ActiveSessionBookkeepingDeps {
    return bags.buildActiveSessionBookkeepingDeps(this);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:00: Full SessionContention FNXC lives on acquire-session-registry-path.ts. */
  private acquireSessionRegistryPath(
    ...args: FacadeRestArgs<typeof impl.acquireSessionRegistryPathImpl>
  ): void {
    impl.acquireSessionRegistryPathImpl(bags.buildAcquireSessionRegistryPathDeps(this), ...args);
  }

  private setActiveSession(taskId: string, sessionState: ActiveExecutorSessionState, worktreePath: string): void {
    impl.setActiveSessionImpl(this.activeSessionBookkeepingDeps(), taskId, sessionState, worktreePath);
  }

  private markGraphExecuteSelfRequeued(taskId: string): void {
    impl.markGraphExecuteSelfRequeuedImpl(this.activeSessionBookkeepingDeps(), taskId);
  }

  private deleteActiveSession(taskId: string, worktreePath?: string): void {
    impl.deleteActiveSessionImpl(this.activeSessionBookkeepingDeps(), taskId, worktreePath);
  }

  private setActiveStepExecutor(taskId: string, stepExecutor: StepSessionExecutor, worktreePath: string, seenSteeringIds = new Set<string>()): void {
    impl.setActiveStepExecutorImpl(this.activeSessionBookkeepingDeps(), taskId, stepExecutor, worktreePath, seenSteeringIds);
  }

  private deleteActiveStepExecutor(taskId: string, worktreePath?: string): void {
    impl.deleteActiveStepExecutorImpl(this.activeSessionBookkeepingDeps(), taskId, worktreePath);
  }

  private setActiveWorkflowStepSession(taskId: string, session: AgentSession, worktreePath: string, seenSteeringIds = new Set<string>()): void {
    impl.setActiveWorkflowStepSessionImpl(this.activeSessionBookkeepingDeps(), taskId, session, worktreePath, seenSteeringIds);
  }

  private deleteActiveWorkflowStepSession(taskId: string, worktreePath?: string): void {
    impl.deleteActiveWorkflowStepSessionImpl(this.activeSessionBookkeepingDeps(), taskId, worktreePath);
  }

  private registerConfiguredCommandController(taskId: string, controller: AbortController): void {
    impl.registerConfiguredCommandControllerImpl(this.activeConfiguredCommandControllers, taskId, controller);
  }

  private unregisterConfiguredCommandController(taskId: string, controller: AbortController): void {
    impl.unregisterConfiguredCommandControllerImpl(this.activeConfiguredCommandControllers, taskId, controller);
  }

  private getAutoRecoveryDispatcher(audit: RunAuditor): AutoRecoveryDispatcher {
    return impl.getAutoRecoveryDispatcherImpl(bags.buildGetAutoRecoveryDispatcherDeps(this), audit);
  }

  private async renewTaskLease(
    ...args: FacadeRestArgs<typeof impl.renewTaskLeaseImpl>
  ): Promise<void>  {
    return impl.renewTaskLeaseImpl(bags.buildRenewTaskLeaseDeps(this), ...args);
  }

  private async finalizeAlreadyReviewedTask(taskId: string): Promise<"merged" | "blocked" | "missing"> {
    return impl.finalizeAlreadyReviewedTaskImpl(bags.buildFinalizeAlreadyReviewedTaskDeps(this), taskId);
  }

  private async getExecutionPauseLabel(): Promise<"global pause" | "engine pause" | null> {
    return impl.getExecutionPauseLabelImpl({ store: this.store });
  }

  private async shouldDeferCompletionForGlobalPause(
    ...args: FacadeRestArgs<typeof impl.shouldDeferCompletionForGlobalPauseImpl>
  ): Promise<boolean> {
    return impl.shouldDeferCompletionForGlobalPauseImpl(bags.buildShouldDeferCompletionForGlobalPauseDeps(this), ...args);
  }

  private async shouldDeferWorkflowStepCompletion(
    ...args: FacadeRestArgs<typeof impl.shouldDeferWorkflowStepCompletionImpl>
  ): Promise<boolean>  {
    return impl.shouldDeferWorkflowStepCompletionImpl(bags.buildShouldDeferWorkflowStepCompletionDeps(this), ...args);
  }

  /** Child agent sessions keyed by agent ID. Used for termination. */
  private childSessions = new Map<string, AgentSession>();
  /** Total count of currently spawned agents (across all parents). */
  private totalSpawnedCount = 0;
  /** Token cap detector for proactive context compaction. */
  private tokenCapDetector = new TokenCapDetector();
  private _modelRegistry?: Promise<ModelRegistry>;
  private _approvalRequestStore?: ApprovalRequestStore;
  /** Current run context for mutation correlation, keyed by task id. */
  private currentRunContexts = new Map<string, RunMutationContext>();

  private getRunContextFor(taskId: string): RunMutationContext | undefined {
    return this.currentRunContexts.get(taskId);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:35: handoffTaskToReview reason/failure FNXC lives on handoff-task-to-review.ts. */
  private async handoffTaskToReview(
    ...args: FacadeRestArgs<typeof impl.handoffTaskToReviewImpl>
  ): Promise<Task> {
    return impl.handoffTaskToReviewImpl(bags.buildHandoffTaskToReviewDeps(this), ...args);
  }

  /* FNXC:ReviewArtifacts 2026-07-19-10:00: best-effort feature-video before review handoff (never delays transition). */
  private async generateCompletionFeatureVideo(task: Task): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reviewArtifactGenerator is optional TaskExecutorOptions field
    return impl.generateCompletionFeatureVideoImpl({ store: this.store, options: this.options as any }, task);
  }

  private async awaitFeatureVideoBounded(result: Promise<import("./review-artifacts/feature-video.js").FeatureVideoResult>): Promise<import("./review-artifacts/feature-video.js").FeatureVideoResult> {
    return impl.awaitFeatureVideoBoundedImpl(result);
  }

  private getModelRegistry(): Promise<ModelRegistry> {
    return impl.getModelRegistryImpl({
      getModelRegistryCache: () => this._modelRegistry,
      setModelRegistryCache: (value) => { this._modelRegistry = value; },
    });
  }

  private get approvalRequestStore(): ApprovalRequestStore {
    return impl.getApprovalRequestStoreImpl({
      getCache: () => this._approvalRequestStore,
      setCache: (value) => { this._approvalRequestStore = value; },
      store: this.store,
    });
  }

  private buildActionGateContext(
    ...args: FacadeRestArgs<typeof impl.buildActionGateContextImpl>
  ): AgentActionGateContext | undefined {
    return impl.buildActionGateContextImpl(bags.buildBuildActionGateContextDeps(this), ...args);
  }

  private buildPermanentAgentGatingContext(
    ...args: FacadeRestArgs<typeof impl.buildPermanentAgentGatingContextImpl>
  ): import("@fusion/core").PermanentAgentGatingContext | undefined {
    return impl.buildPermanentAgentGatingContextImpl(bags.buildBuildPermanentAgentGatingContextDeps(this), ...args);
  }

  /** Returns the set of task IDs currently being executed. */

  private taskLivenessDeps(): TaskLivenessDeps {
    return bags.buildTaskLivenessDeps(this, TaskExecutor.processWideGraphRouting);
  }

  getExecutingTaskIds(): Set<string> {
    return impl.getExecutingTaskIdsImpl(this.taskLivenessDeps());
  }

  /** FNXC:TaskTiming 2026-07-30-21:40: Plan Review liveness (narrower than isTaskActive). */
  hasActivePlanningWorkflowSession(taskId: string): boolean {
    return impl.hasActivePlanningWorkflowSessionImpl(this.taskLivenessDeps(), taskId);
  }

  isTaskActive(taskId: string): boolean {
    return impl.isTaskActiveImpl(this.taskLivenessDeps(), taskId);
  }

  /* FNXC:CodeOrganization 2026-08-04-06:15: isTaskLiveForOverseerRetry FNXC lives on is-task-live-for-overseer-retry.ts. */
  isTaskLiveForOverseerRetry(taskId: string): boolean {
    return impl.isTaskLiveForOverseerRetryImpl(
      {
        ...facadeFields(this, ["resumingUnpaused"]),
        ...facadeMethods(this, ["isTaskActive", "hasLiveTaskSessionSurface"]),
      },
      taskId,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:15: hasLiveSessionSurface / clearPhantom FNXC on has-live-session-surface.ts + clear-phantom-executor-binding.ts. */
  hasLiveSessionSurface(taskId: string): boolean {
    return impl.hasLiveSessionSurfaceImpl(bags.buildHasLiveSessionSurfaceDeps(this, (id) => activeSessionRegistry.pathsForTask(id)), taskId);
  }

  clearPhantomExecutorBinding(taskId: string, options: { preserveWorktrees?: boolean } = {}): boolean {
    return impl.clearPhantomExecutorBindingImpl(bags.buildClearPhantomExecutorBindingDeps(this), taskId, options);
  }

  isEphemeralDeletionPending(agentId: string): boolean {
    return impl.isEphemeralDeletionPendingImpl(this.pendingEphemeralDeletions, agentId);
  }

  disposeEphemeralTimers(): void {
    impl.disposeEphemeralTimersImpl(this.pendingEphemeralDeletions);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:40: abortAllSessionBash FNXC lives on abort-all-session-bash.ts. */

  private registerSubagentSession(taskId: string, session: AgentSession): void {
    impl.registerSubagentSessionImpl(this.activeSubagentSessions, taskId, session);
  }

  private unregisterSubagentSession(taskId: string, session: AgentSession): void {
    impl.unregisterSubagentSessionImpl(this.activeSubagentSessions, taskId, session);
  }

  private disposeSubagentsForTask(taskId: string, reason: string): void {
    impl.disposeSubagentsForTaskImpl(this.activeSubagentSessions, taskId, reason);
  }

  /* FNXC:WorkflowResolvedColumns 2026-07-31-23:59: isPlannerColumnFor DELETED (zero production callers; inert sync-lane count drop). */

  /**
   * Was this card pulled BACKWARD out of a planner lane — as opposed to advancing forward
   * out of it?
   *
   * FNXC:WorkflowLifecycleColumns 2026-07-30-16:55 (PR #2628 review, greptile P1):
   * THE FORWARD EXCLUSIONS MUST RESOLVE TOO, and leaving them literal made this branch WORSE
   * than before I touched it. With a role-aware source check and name-matched destinations, a
   * renamed board's ordinary FORWARD move (planning -> building) passed the source test and
   * matched none of the exclusions, so the evacuation fired on a card that was simply
   * advancing: it aborted live planning work and deleted the valid pre-execution worktree.
   * Before the conversion the source check failed and nothing happened; a half-conversion
   * turned a missed rescue into active damage. Third time this program has produced that
   * shape — gates converted, destinations left literal.
   *
   * Forward means the workflow's own wip, review, or complete lane. When a role is not
   * declared it cannot be a forward target, so it is simply not excluded.
   *
   * FNXC:WorkflowResolvedColumns 2026-07-31-23:59 (LANES COME FROM THE EMITTER — the sync resolver
   * is gone):
   * This took its lanes from `resolvePlannerLanes`, whose selection reader returns `undefined`
   * unconditionally under PostgreSQL, so it answered with the DEFAULT board for every task and both
   * its guards were INERT — counted by `check-inert-sync-lanes`, invisible to the census because
   * they already read as converted.
   *
   * The comment above said it had to be synchronous because the `task:moved` emitter is. That was
   * true and is no longer binding: the emitter now resolves the lanes ONCE, asynchronously
   * (`moves.ts` -> `resolveWorkflowIrForTask`), and hands them down on the payload. Reading a
   * parameter is as synchronous as reading `from`, so nothing is reordered and no listener resolves.
   *
   * `lanes` is REQUIRED rather than optional, deliberately. An optional parameter that the one
   * production caller happens to pass is the "seam with no supplier" shape this program keeps
   * finding — required means a future caller fails typecheck instead of silently falling back to a
   * default board. When the emitter itself could not resolve (`lanes` undefined on the payload), the
   * legacy ids answer, which is exactly what `resolvePlannerLanes` degraded to anyway.
   */
  private isBackwardMoveOutOfPlanning(taskId: string, from: string, to: string, moveLanes: TaskMoveLanes | undefined): boolean {
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-23:59 (fallback CHANGED — adopting the better argument
    from the duplicate PR #3140):
    The payload is the real path and is preferred. The FALLBACK, for the case where the emitter could
    not resolve, is the SYNC resolver rather than the legacy literals.

    I had it the other way round. Falling back to literals reads cleaner and drops these guards off
    `check-inert-sync-lanes` — but it makes the NO-PAYLOAD path strictly WORSE, because
    `resolvePlannerLanes` is best-effort (it answers correctly under legacy SQLite, and only degrades
    to the default board under PostgreSQL) whereas a literal can never be right on a renamed board.
    Optimising the guard off a ratchet at the cost of the degraded path is scoring the number.

    THESE TWO GUARDS STAY COUNTED by `check-inert-sync-lanes`, which is the honest state: the sync
    call is still here, so the ratchet should still point at it. `executor.ts` goes 4 -> 2, from the
    `isPlannerColumnFor` deletion below, not from these.

    That took two corrections to get right, recorded because the intermediate state was wrong in a way
    that looked authoritative. I predicted "stays counted", the gate reported ZERO, and I wrote the
    under-reporting down as fact. It was a gate defect, not a property of this code: the scan
    registered a sync local only from a direct call initializer and did not follow one through a
    conditional (#3169) or through the object literal these lanes are rebuilt into (#3170). With both
    hops followed the gate reports 2 here — the original prediction.

    The shape was deliberately NOT rewritten to whatever form the scanner recognised. Payload-first
    with a sync fallback is correct on the merits, and a guard that pushes authors toward a worse
    degraded path to keep its own count tidy is a guard doing harm — so the scanner was fixed instead.
    */
    const sync = moveLanes ? undefined : resolvePlannerLanes(this.store, taskId);
    const lanes = {
      hold: moveLanes?.hold ?? sync?.hold ?? "todo",
      intake: moveLanes?.intake ?? sync?.intake ?? "triage",
      wip: moveLanes?.wip ?? sync?.wip ?? "in-progress",
      review: moveLanes?.review ?? sync?.review ?? "in-review",
      complete: moveLanes?.complete ?? sync?.complete ?? "done",
    };
    if (from !== lanes.hold && from !== lanes.intake) return false;
    const forwardTargets = [lanes.wip, lanes.review, lanes.complete].filter(
      (column): column is string => typeof column === "string",
    );
    /*
    DELIBERATELY NOT ALSO EXCLUDING planner-to-planner moves. The literal version fired the
    evacuation on `todo -> triage` (a replan rebound), and whether that is right is a separate
    question from this review fix — the replan path is engine-initiated, so aborting the planning
    session there may be exactly wrong, but changing it is a behavior change with its own
    surfaces to enumerate. This conversion keeps that case behaving as it does today.
    */
    return !forwardTargets.includes(to);
  }

  /** FN-5256: register in-flight disposal so re-dispatch awaits prior session reap. */
  private trackTaskDisposal(taskId: string, disposal: Promise<void>): void {
    impl.trackTaskDisposalImpl({ pendingTaskDisposals: this.pendingTaskDisposals }, taskId, disposal);
  }

  /* FNXC:CodeOrganization 2026-08-04-02:10: awaitAbort / abortAllInFlight thin facades (U4). */
  async awaitAbortInFlightTaskWork(
    ...args: FacadeRestArgs<typeof impl.awaitAbortInFlightTaskWorkImpl>
  ): Promise<void> {
    return impl.awaitAbortInFlightTaskWorkImpl(bags.buildAwaitAbortInFlightTaskWorkDeps(this), ...args);
  }

  async abortAllInFlight(reason: string): Promise<void> {
    return impl.abortAllInFlightImpl(bags.buildAbortAllInFlightDeps(this), reason);
  }

  abortAllSessionBash(): void {
    impl.abortAllSessionBashImpl({
      ...facadeFields(this, [
        "activeSessions", "childSessions", "activeStepExecutors",
      ]),
    });
  }

  private async parkApprovalSuspension(
    ...args: FacadeRestArgs<typeof impl.parkApprovalSuspensionImpl>
  ): Promise<boolean> {
    return impl.parkApprovalSuspensionImpl(bags.buildParkApprovalSuspensionDeps(this), ...args);
  }

  private async dispatchUnpauseResume(task: Task): Promise<boolean> {
    return impl.dispatchUnpauseResumeImpl(bags.buildDispatchUnpauseResumeDeps(this), task);
  }

  private async resumeApprovalAfterUnwindIfNeeded(
    ...args: FacadeRestArgs<typeof impl.resumeApprovalAfterUnwindIfNeededImpl>
  ): Promise<boolean> {
    return impl.resumeApprovalAfterUnwindIfNeededImpl(bags.buildResumeApprovalAfterUnwindDeps(this), ...args);
  }

  private async resolveMcpServers(agentId?: string | null) {
    return impl.resolveMcpServersImpl({ store: this.store }, agentId);
  }

  /**
   * Tasks whose graph run already owns a top-level concurrency slot (scheduler pre-held handoff).
   * Seam re-entry under that graph must not acquire a second slot.
   */
  private outerConcurrencyClaims = new Set<string>();

  /* FNXC:GlobalConcurrencyControls 2026-07-14-18:30: share scheduler pre-held global slot; no second top-level acquire under full cap. */
  private async runWithExecutorSemaphore<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    return impl.runWithExecutorSemaphoreImpl(bags.buildRunWithExecutorSemaphoreDeps(this), taskId, work);
  }

  /* FNXC:PlannerOversight 2026-07-13-23:05: session-advisor flush setter (options captured at construct). */
  setOnExecutorLogFlushed(cb: TaskExecutorOptions["onExecutorLogFlushed"]): void {
    this.options = { ...this.options, onExecutorLogFlushed: cb };
  }

  constructor(
    private store: TaskStore,
    private rootDir: string,
    private options: TaskExecutorOptions = {},
  ) {
    /* FNXC:CodeOrganization 2026-08-04-04:00: constructor wiring via buildWireExecutorLifecycleDeps (U4). */
    const wired = wireExecutorLifecycle(buildWireExecutorLifecycleDeps(this));
    this.unregisterTaskMoveDisposer = wired.unregisterTaskMoveDisposer;
    this.unregisterArchiveWorktreeDisposer = wired.unregisterArchiveWorktreeDisposer;
    this.unregisterArchiveWorkspaceWorktreeDisposer = wired.unregisterArchiveWorkspaceWorktreeDisposer;
  }

  /* FNXC:CodeOrganization 2026-08-04-02:25: shared store + getRunContextFor deps bag for free-fn facades. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same any-spread posture as facadeMethods
  private storeRunContextDeps(): any {
    return {
      ...facadeFields(this, ["store"]),
      ...facadeMethods(this, ["getRunContextFor"]),
    };
  }

  private async resetMergeStateIfNeeded(task: Task, from: Task["column"]): Promise<Task> {
    return impl.resetMergeStateIfNeededImpl(bags.buildResetMergeStateIfNeededDeps(this), task, from);
  }

  private async cleanupMergeStateForReverification(
    ...args: FacadeRestArgs<typeof impl.cleanupMergeStateForReverificationImpl>
  ): Promise<Task>  {
    return impl.cleanupMergeStateForReverificationImpl(this.storeRunContextDeps(), ...args);
  }

  private async clearResumeFailureState(task: Task): Promise<void> {
    return impl.clearResumeFailureStateImpl({ store: this.store }, task);
  }

  private clearCompletedTaskWatchdog(taskId: string): void {
    impl.clearCompletedTaskWatchdogImpl(this.completedTaskWatchdogs, taskId);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:35: signalTaskComplete FN-7528 FNXC lives on signal-task-complete.ts. */
  private signalTaskComplete(task: Task): void {
    return impl.signalTaskCompleteImpl(bags.buildSignalTaskCompleteDeps(this), task);
  }

  private triggerPostTaskReflectionCapture(task: Task): void {
    return impl.triggerPostTaskReflectionCaptureImpl(bags.buildTriggerPostTaskReflectionCaptureDeps(this), task);
  }

  private clearWorkflowRerunWatchdog(taskId: string): void {
    impl.clearWorkflowRerunWatchdogImpl(this.workflowRerunWatchdogs, taskId);
  }

  private scheduleCompletedTaskWatchdog(taskId: string, trigger: string): void {
    impl.scheduleCompletedTaskWatchdogImpl(
      bags.buildScheduleCompletedTaskWatchdogDeps(this, constants.COMPLETED_TASK_WATCHDOG_MS),
      taskId,
      trigger,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:40: clearTerminalStepFailures ReviewLeniency FNXC lives on clear-terminal-step-failures-for-retry.ts. */
  private async clearTerminalStepFailuresForRetry(taskId: string): Promise<void> {
    return impl.clearTerminalStepFailuresForRetryImpl(this.storeRunContextDeps(), taskId);
  }

  private async performWorkflowRerunBounce(
    ...args: FacadeRestArgs<typeof impl.performWorkflowRerunBounceImpl>
  ): Promise<"bounced" | "skipped-pending" | "deferred-paused">  {
    return impl.performWorkflowRerunBounceImpl(bags.buildPerformWorkflowRerunBounceDeps(this), ...args);
  }

  private scheduleWorkflowRerun(
    ...args: FacadeRestArgs<typeof impl.scheduleWorkflowRerunImpl>
  ): void {
    impl.scheduleWorkflowRerunImpl(bags.buildScheduleWorkflowRerunDeps(this, constants.WORKFLOW_RERUN_WATCHDOG_MS), ...args);
  }

  private completionFinalizationDeps() {
    return bags.buildCompletionFinalizationFacadeDeps(this);
  }

  private async parkCompletedBlockedTask(task: Task, completionBlocker: string, source: string, workComplete = pure.isTaskWorkComplete(task)): Promise<boolean> {
    return impl.parkCompletedBlockedTaskImpl(this.completionFinalizationDeps(), task, completionBlocker, source, workComplete);
  }

  private async getCompletedTaskFinalizationDecision(taskId: string, taskDone: boolean): Promise<"finalize" | "blocked" | "incomplete"> {
    return impl.getCompletedTaskFinalizationDecisionImpl(this.completionFinalizationDeps(), taskId, taskDone);
  }

  private async shouldFinalizeCompletedTask(taskId: string, taskDone: boolean): Promise<boolean> {
    return impl.shouldFinalizeCompletedTaskImpl(this.completionFinalizationDeps(), taskId, taskDone);
  }

  private nonContinuableSessionDeps() {
    return bags.buildNonContinuableSessionFacadeDeps(this);
  }

  private async handleNonContinuableSessionError(task: Task, taskDone: boolean, errorMessage: string): Promise<boolean> {
    return impl.handleNonContinuableSessionErrorImpl(this.nonContinuableSessionDeps(), task, taskDone, errorMessage);
  }

  private async handleNonContinuableSessionRetry(task: Task, errorMessage: string): Promise<boolean> {
    return impl.handleNonContinuableSessionRetryImpl(this.nonContinuableSessionDeps(), task, errorMessage);
  }

  private async getTaskCompletionBlocker(task: Task): Promise<string | undefined> {
    return getTaskCompletionBlockerForStore(this.store, task);
  }

  /** FNXC:TokenBudget 2026-07-16-00:00: persist-time budget enforcement for all executor token writes. */
  private async persistTaskTokenUsage(taskId: string, tokenUsage: TaskTokenUsage): Promise<void> {
    return impl.persistTaskTokenUsageImpl(this.storeRunContextDeps(), taskId, tokenUsage);
  }

  /* FNXC:TokenAnalytics 2026-07-17-14:00: persistTokenUsage sole central writer; baselines feed that delta seam (no double-credit). */
  private async captureExecutorTokenUsageBaseline(taskId: string, session: AgentSession): Promise<void> {
    return impl.captureExecutorTokenUsageBaselineImpl({ tokenUsageBaselines: this.tokenUsageBaselines }, taskId, session);
  }

  private async persistTokenUsage(
    ...args: FacadeRestArgs<typeof impl.persistTokenUsageImpl>
  ): Promise<void> {
    return impl.persistTokenUsageImpl(bags.buildPersistTokenUsageDeps(this), ...args);
  }

  // FNXC:CodeOrganization 2026-08-03-09:25: pure token helper facades for prototype/instance call sites after free peel.
  private accumulateTokenUsage(...args: Parameters<typeof impl.accumulateTokenUsageImpl>): ReturnType<typeof impl.accumulateTokenUsageImpl> {
    return impl.accumulateTokenUsageImpl(...args);
  }
  private tokenUsageWithModelSnapshot(...args: Parameters<typeof impl.tokenUsageWithModelSnapshotImpl>): ReturnType<typeof impl.tokenUsageWithModelSnapshotImpl> {
    return impl.tokenUsageWithModelSnapshotImpl(...args);
  }
  private async extractSessionTokenUsage(...args: Parameters<typeof impl.extractSessionTokenUsageImpl>): ReturnType<typeof impl.extractSessionTokenUsageImpl> {
    return impl.extractSessionTokenUsageImpl(...args);
  }

  private async executeReviewHandoff(
    ...args: FacadeRestArgs<typeof impl.executeReviewHandoffImpl>
  ): Promise<void>  {
    return impl.executeReviewHandoffImpl(bags.buildExecuteReviewHandoffDeps(this), ...args);
  }

  /** Fast-path completed task → in-review without a new agent session. */
  async recoverCompletedTask(task: Task): Promise<boolean> {
    return impl.recoverCompletedTaskImpl(bags.buildRecoverCompletedTaskDeps(this), task);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:20: optional-step budget + replan-cap FNXC on request-pre-merge-optional-step-fix.ts + park-plan-review-replan-cap.ts. */
  private async parkPlanReviewReplanCapExhausted(
    ...args: FacadeRestArgs<typeof impl.parkPlanReviewReplanCapExhaustedImpl>
  ): Promise<void>  {
    return impl.parkPlanReviewReplanCapExhaustedImpl(this.storeRunContextDeps(), ...args);
  }

  private async requestPreMergeOptionalStepFix(
    ...args: FacadeRestArgs<typeof impl.requestPreMergeOptionalStepFixImpl>
  ): Promise<boolean> {
    return impl.requestPreMergeOptionalStepFixImpl(bags.buildRequestPreMergeOptionalStepFixDeps(this), ...args);
  }

  private async recoverMissingRequiredArtifacts(
    ...args: FacadeRestArgs<typeof impl.recoverMissingRequiredArtifactsImpl>
  ): Promise<void>  {
    return impl.recoverMissingRequiredArtifactsImpl(bags.buildRecoverMissingRequiredArtifactsDeps(this), ...args);
  }

  private async isRequiredArtifactRecoveryProtected(task: Task): Promise<boolean> {
    return impl.isRequiredArtifactRecoveryProtectedImpl(this.store, (taskId: string) => this.resolveResumeLanes(taskId), task);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:30: recoverFailedPreMerge FNXC lives on recover-failed-pre-merge-step.ts. */
  async recoverFailedPreMergeWorkflowStep(task: Task): Promise<boolean> {
    return impl.recoverFailedPreMergeWorkflowStepImpl(bags.buildRecoverFailedPreMergeWorkflowStepDeps(this), task);
  }

  /** Defer execute when permanent agent has active heartbeat and allowParallelExecution=false. */
  private async shouldDeferForHeartbeat(agentId: string): Promise<boolean> {
    return impl.shouldDeferForHeartbeatImpl({ agentStore: this.options.agentStore }, agentId);
  }

  private async getAuthoritativeAssignedAgent(
    ...args: FacadeRestArgs<typeof impl.getAuthoritativeAssignedAgentImpl>
  ): Promise<Agent | null> {
    return impl.getAuthoritativeAssignedAgentImpl(bags.buildGetAuthoritativeAssignedAgentDeps(this), ...args);
  }

  private async getAssignedAgentRuntimeConfig(
    ...args: FacadeRestArgs<typeof impl.getAssignedAgentRuntimeConfigImpl>
  ): Promise<Record<string, unknown> | undefined> {
    return impl.getAssignedAgentRuntimeConfigImpl(bags.buildGetAssignedAgentRuntimeConfigDeps(this), ...args);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:15: listWipLaneTasks resume-sweep FNXC lives on list-wip-lane-tasks.ts. */
  private async listWipLaneTasks(): Promise<Task[]> {
    return impl.listWipLaneTasksImpl(this.store);
  }

  async resumeTaskForAgent(agentId: string): Promise<void> {
    return impl.resumeTaskForAgentImpl(bags.buildResumeTaskForAgentDeps(this), agentId);
  }

  /** Column-agent U5/R6: effective principal matches agentId (fail-soft → false). */
  private async taskEffectiveAgentMatches(task: Task, agentId: string): Promise<boolean> {
    return impl.taskEffectiveAgentMatchesImpl(this.store, task, agentId);
  }

  /** Resume orphaned in-progress tasks after crash/restart (complete → in-review fast path). */
  async resumeOrphaned(): Promise<void> {
    return impl.resumeOrphanedImpl(bags.buildResumeOrphanedDeps(this, TaskExecutor.processWideGraphRouting));
  }

  private async resolveInstructionsForRole(role: string, settings?: Settings): Promise<string> {
    return impl.resolveInstructionsForRoleImpl(bags.buildResolveInstructionsForRoleDeps(this), role, settings);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:20: graphCompletion U5d/U5e FNXC lives on task-executor-options.ts. */
  /** Per graph-run agent-log boundary; passed to failure handling rather than trusting stale task snapshots. */
  private graphToolFailureRunCursors = new Map<string, number>();

  /** Step-inversion pin for hard per-step boundary before step-review (cleared on graph finally). */
  private graphStepSessionPinned = new Set<string>();

  /** Step-inversion (U6/U8): once-per-run implementation-phase cache keyed by task id. */
  private graphStepRunOnce = new Map<string, Promise<{ taskDone: boolean; modifiedFiles: string[]; exit?: ImplementationExit }>>();

  /** Step-inversion (KTD-4): active foreach context for deferDoneToReview (`taskId:instanceId`). */
  private graphStepActiveContext = new Map<string, ForeachActiveContext>();

  /** FNXC:ProactiveChatStatus 2026-07-16-12:30: RETHINK summary held until rework reset succeeds. */
  private graphRethinkNarrations = new Map<string, string>();

  /** Per-run column-agent binding resolver (nodeId → binding); cleared in graph finally. */
  private graphColumnAgentResolver = new Map<string, (nodeId: string) => WorkflowColumnAgent | undefined>();

  /** (U3) Unattended graph runs (LFG/pipeline) — FUSION_HEADLESS for skill steps. */
  private graphUnattendedRuns = new Set<string>();

  /** Governing seam node id for in-flight implementation pass (column-agent plan U4). */
  private graphSeamGoverningNodeId = new Map<string, string>();

  /** FNXC:Settings-ThinkingLevel 2026-07-10-00:00: per-run thinking pin for execute/step-execute seams. */
  private graphSeamThinkingLevel = new Map<string, ThinkingLevel>();

  /** FNXC:WorkflowStepSkills 2026-07-22-00:00: FN-8490 skill pin for pass-initiating foreach instance. */
  private graphSeamSkillName = new Map<string, string>();

  /** FN-4811 process-wide graph routing (cross-instance execute() races). */
  private get graphRouting(): Set<string> {
    return TaskExecutor.processWideGraphRouting;
  }

  private static processWideGraphRouting = new Set<string>();

  /** Wired by the runtime to ProjectEngine.onMerge. */
  private mergeRequester?: (taskId: string, options?: { signal?: AbortSignal }) => Promise<MergeResult>;

  setMergeRequester(requestMerge: (taskId: string, options?: { signal?: AbortSignal }) => Promise<MergeResult>): void {
    this.mergeRequester = requestMerge;
  }

  private async executeWorkflowGraph(
    ...args: FacadeRestArgs<typeof impl.executeWorkflowGraphImpl>
  ): Promise<void> {
    return impl.executeWorkflowGraphImpl(bags.buildExecuteWorkflowGraphDeps(this), ...args);
  }

  private buildBranchPersistence(): WorkflowBranchPersistence | undefined {
    return impl.buildBranchPersistenceImpl({ store: this.store });
  }

  /** Graph foreach instance persistence (KTD-6); undefined on pre-CRUD stores. */
  private buildStepInstancePersistence(): WorkflowStepInstancePersistence | undefined {
    return impl.buildStepInstancePersistenceImpl({ store: this.store });
  }

  /* FNXC:CodeOrganization 2026-08-04-03:15: no-merge complete-column + IR pin FNXC lives on no-merge-complete-column.ts. */
  private async advanceNoMergeWorkflowToCompleteColumn(task: TaskDetail): Promise<void> {
    return impl.advanceNoMergeWorkflowToCompleteColumnImpl(this.store, task);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:15: column-boundary hooks FNXC lives on build-column-boundary-hooks.ts. */
  private buildColumnBoundaryHooks(task: Pick<Task, "id">, workflowRunId?: string): WorkflowColumnBoundaryHooks {
    return impl.buildColumnBoundaryHooksImpl(bags.buildColumnBoundaryHooksFacadeDeps(this), task, workflowRunId);
  }

  /** KTD-12 parse-steps artifact/parser for graph-owned step lists (undefined = legacy). */
  private resolveTaskStepSource(ir: WorkflowIr | undefined): { artifact: string; parser: string } | undefined {
    return impl.resolveTaskStepSourceImpl(ir);
  }

  /** KTD-13 workflow custom field defs for prompt surface (fail-soft → undefined). */
  private async resolveTaskCustomFieldDefs(taskId: string): Promise<WorkflowFieldDefinition[] | undefined> {
    return impl.resolveTaskCustomFieldDefsImpl({ store: this.store }, taskId);
  }

  /** Task artifact by key (PROMPT.md falls back to task PROMPT content). */
  private async readTaskArtifact(taskId: string, key: string): Promise<string | undefined> {
    return impl.readTaskArtifactImpl({ store: this.store }, taskId, key);
  }

  private buildParseStepsDeps(runId?: string): ParseStepsHandlerDeps {
    return impl.buildParseStepsDepsImpl(bags.buildParseStepsFacadeDeps(this), runId);
  }

  /** KTD-15/U14 code-node runner (worktree cwd, artifact pre-read, customFields). */
  private buildCodeNodeRunner(): CodeNodeRunner {
    return impl.buildCodeNodeRunnerImpl(bags.buildCodeNodeRunnerFacadeDeps(this));
  }

  private buildForeachWorktreeDeps(
    ...args: FacadeRestArgs<typeof impl.buildForeachWorktreeDepsImpl>
  ): ReturnType<typeof impl.buildForeachWorktreeDepsImpl> {
    return impl.buildForeachWorktreeDepsImpl(bags.buildBuildForeachWorktreeDepsDeps(this), ...args);
  }

  private async applyGraphRethinkReset(
    ...args: FacadeRestArgs<typeof impl.applyGraphRethinkResetImpl>
  ): Promise<void> {
    return impl.applyGraphRethinkResetImpl(bags.buildApplyGraphRethinkResetDeps(this), ...args);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:20: runImplementationPhase U5e FNXC lives on run-implementation-phase.ts. */
  private async runImplementationPhase(
    ...args: FacadeRestArgs<typeof impl.runImplementationPhaseImpl>
  ): Promise<{ taskDone: boolean; modifiedFiles: string[]; exit?: ImplementationExit }> {
    return impl.runImplementationPhaseImpl(bags.buildRunImplementationPhaseDeps(this), ...args);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:20: step-inversion driver FNXC lives on run-graph-task-step.ts. */
  private async runGraphTaskStep(
    ...args: FacadeRestArgs<typeof impl.runGraphTaskStepImpl>
  ): Promise<{ success: boolean; error?: string; exit?: ImplementationExit }> {
    return impl.runGraphTaskStepImpl(bags.buildRunGraphTaskStepDeps(this), ...args);
  }

  /** Read the active foreach instance context for a graph-owned task (if any) so
   *  the step driver can honor `deferDoneToReview`. The active context is threaded
   *  through the foreach sub-walk; we surface it via a per-task slot the
   *  step-execute seam stamps. Returns undefined outside a foreach instance. */
  private foreachActiveForTask(taskId: string, instanceId?: string): ForeachActiveContext | undefined {
    return impl.foreachActiveForTaskImpl({ graphStepActiveContext: this.graphStepActiveContext }, taskId, instanceId);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:20: projected step worktree-gating FNXC lives on run-projected-graph-task-step.ts. */
  private async runProjectedGraphTaskStep(
    ...args: FacadeRestArgs<typeof impl.runProjectedGraphTaskStepImpl>
  ): Promise<RunTaskStepResult> {
    return impl.runProjectedGraphTaskStepImpl(bags.buildRunProjectedGraphTaskStepDeps(this), ...args);
  }

  /** Public authoritative-driver seam factory: exposes the same real lifecycle
   * seams the internal graph runner uses, without changing legacy behavior. */
  public createAuthoritativeWorkflowPrimitives(settings: Settings): WorkflowRuntimePrimitives {
    return createWorkflowRuntimePrimitiveProvider((providerSettings) =>
      this.createAuthoritativeWorkflowPrimitivesFromExecutor(providerSettings),
    ).create(settings);
  }

  private createAuthoritativeWorkflowPrimitivesFromExecutor(settings: Settings): WorkflowRuntimePrimitives {
     
    return impl.createAuthoritativeWorkflowPrimitivesFromExecutorImpl(bags.buildCreateAuthoritativeWorkflowPrimitivesFromExecutorDeps(this), settings);
     
  }

  private async resolveMergeBoundaryColumn(taskId: string, nodeId: string): Promise<string> {
    return impl.resolveMergeBoundaryColumnImpl({ store: this.store }, taskId, nodeId);
  }

  private async ensureWorkflowMergeBoundaryTask(
    ...args: FacadeRestArgs<typeof impl.ensureWorkflowMergeBoundaryTaskImpl>
  ): Promise<TaskDetail>  {
    return impl.ensureWorkflowMergeBoundaryTaskImpl(bags.buildEnsureWorkflowMergeBoundaryTaskDeps(this), ...args);
  }

  private async evaluateWorkflowMergeBoundary(
    ...args: FacadeRestArgs<typeof impl.evaluateWorkflowMergeBoundaryImpl>
  ): ReturnType<typeof impl.evaluateWorkflowMergeBoundaryImpl> {
    return impl.evaluateWorkflowMergeBoundaryImpl(bags.buildEvaluateWorkflowMergeBoundaryDeps(this), ...args);
  }

  private async loadMergeBoundaryInstances(
    ...args: FacadeRestArgs<typeof impl.loadMergeBoundaryInstancesImpl>
  ): ReturnType<typeof impl.loadMergeBoundaryInstancesImpl> {
    return impl.loadMergeBoundaryInstancesImpl({ store: this.store }, ...args);
  }

  private async getWorkflowMergeImplementationProofFailure(
    ...args: FacadeRestArgs<typeof impl.getWorkflowMergeImplementationProofFailureImpl>
  ): Promise<string | undefined> {
    return impl.getWorkflowMergeImplementationProofFailureImpl(bags.buildWorkflowMergeImplementationProofFailureDeps(this), ...args);
  }

  /** FNXC:WorkflowMerge 2026-07-27-12:00: FN-8601 checklist/foreach merge admission gate. */
  private shouldCompleteChecklistAtWorkflowMerge(task: TaskDetail, proof?: { complete: boolean }): boolean {
    return impl.shouldCompleteChecklistAtWorkflowMergeImpl(task, proof);
  }

  public createAuthoritativeWorkflowSeams(_settings: Settings): WorkflowLegacySeams {
    return impl.createAuthoritativeWorkflowSeamsImpl(bags.buildCreateAuthoritativeWorkflowSeamsDeps(this), _settings);
  }

  private async updateStepGraph(
    ...args: FacadeRestArgs<typeof impl.updateStepGraphImpl>
  ): Promise<void> {
    return impl.updateStepGraphImpl({ store: this.store }, ...args);
  }

  /** Await-input node: park awaiting-user-input; resume consumes steering as answer. */
  private async runAwaitInputNode(node: WorkflowIrNode, live: TaskDetail): Promise<WorkflowNodeResult> {
    return impl.runAwaitInputNodeImpl(this.storeRunContextDeps(), node, live);
  }

  private async pauseForCliApproval(node: WorkflowIrNode, live: TaskDetail, command: string): Promise<WorkflowNodeResult> {
    return impl.pauseForCliApprovalImpl(this.storeRunContextDeps(), node, live, command);
  }

  /** Run an arbitrary (approved) CLI command in the task worktree, supervised. */
  private async runRawCliCommand(
    ...args: FacadeRestArgs<typeof impl.runRawCliCommandImpl>
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    return impl.runRawCliCommandImpl(bags.buildRunRawCliCommandDeps(this, pure.runConfiguredCommand), ...args);
  }

  /** Column-agent U3 adoption for custom nodes (R8 fail-soft → undefined). */
  private async adoptColumnAgentForNode(
    ...args: FacadeRestArgs<typeof impl.adoptColumnAgentForNodeImpl>
  ): Promise<{ modelProvider?: string; modelId?: string; persona?: string } | undefined> {
    return impl.adoptColumnAgentForNodeImpl(bags.buildAdoptColumnAgentForNodeDeps(this), ...args);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:30: column-agent seam FNXC lives on resolve-seam-column-agent.ts / resolve-effective-principal-id.ts / is-agent-effectively-executing.ts. */
  private async resolveSeamColumnAgent(
    ...args: FacadeRestArgs<typeof impl.resolveSeamColumnAgentImpl>
  ): Promise<{ agent: Agent; mode: WorkflowColumnAgent["mode"] | undefined } | undefined> {
    return impl.resolveSeamColumnAgentImpl(bags.buildResolveSeamColumnAgentDeps(this), ...args);
  }

  private resolveEffectivePrincipalId(
    ...args: FacadeRestArgs<typeof impl.resolveEffectivePrincipalIdImpl>
  ): string | undefined {
    return impl.resolveEffectivePrincipalIdImpl(bags.buildResolveEffectivePrincipalIdDeps(this), ...args);
  }

  isAgentEffectivelyExecuting(agentId: string): boolean {
    return impl.isAgentEffectivelyExecutingImpl(this.effectiveColumnAgentByTask, agentId);
  }

  /** Plugin-injected taskEnv (scoped; never mutates process.env). Shared by agentWork + graph skill steps. */
  private async buildInjectedRuntimeEnv(
    ...args: FacadeRestArgs<typeof impl.buildInjectedRuntimeEnvImpl>
  ): Promise<{ env: NodeJS.ProcessEnv; injectedKeyCount: number; pathEntryCount: number }> {
    return impl.buildInjectedRuntimeEnvImpl(bags.buildInjectedRuntimeEnvDeps(this), ...args);
  }

  private async ensureGraphCustomNodeWorktree(
    ...args: FacadeRestArgs<typeof impl.ensureGraphCustomNodeWorktreeImpl>
  ): Promise<TaskDetail>  {
    return impl.ensureGraphCustomNodeWorktreeImpl(bags.buildEnsureGraphCustomNodeWorktreeDeps(this, pure.runConfiguredCommand), ...args);
  }

  public async releasePreExecutionWorktree(
    ...args: FacadeRestArgs<typeof impl.releasePreExecutionWorktreeImpl>
  ): Promise<boolean> {
    return impl.releasePreExecutionWorktreeImpl(bags.buildReleasePreExecutionWorktreeDeps(this), ...args);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:25: planning worktree acquisition FNXC lives on ensure-task-worktree-for-planning.ts. */
  public async ensureTaskWorktreeForPlanning(taskId: string): Promise<string | null> {
    return impl.ensureTaskWorktreeForPlanningImpl(bags.buildEnsureTaskWorktreeForPlanningDeps(this), taskId);
  }

  private async prepareGraphNodeExecution(
    ...args: FacadeRestArgs<typeof impl.prepareGraphNodeExecutionImpl>
  ): Promise<void> {
    return impl.prepareGraphNodeExecutionImpl(bags.buildPrepareGraphNodeExecutionDeps(this), ...args);
  }

  private async finalizeMergeConfirmedWorkflowGraphTask(
    ...args: FacadeRestArgs<typeof impl.finalizeMergeConfirmedWorkflowGraphTaskImpl>
  ): Promise<boolean> {
    return impl.finalizeMergeConfirmedWorkflowGraphTaskImpl(bags.buildFinalizeMergeConfirmedWorkflowGraphTaskDeps(this), ...args);
  }

  /** Custom (non-seam) graph node via WorkflowStep machinery; columnBinding U3/R precedence. */
  private async runGraphCustomNode(
    ...args: FacadeRestArgs<typeof impl.runGraphCustomNodeImpl>
  ): Promise<WorkflowNodeResult> {
    return impl.runGraphCustomNodeImpl(bags.buildRunGraphCustomNodeDeps(this), ...args);
  }

  private async runCliAgentNode(
    ...args: FacadeRestArgs<typeof impl.runCliAgentNodeImpl>
  ): Promise<WorkflowNodeResult>  {
    return impl.runCliAgentNodeImpl(bags.buildRunCliAgentNodeDeps(this), ...args);
  }

  /** U7 CLI handoff: graceful PTY reap as completed (best-effort; never blocks advancement). */
  private async reapCliTaskSessionForHandoff(session: CliTaskSession, taskId: string): Promise<void> {
    return impl.reapCliTaskSessionForHandoffImpl(session, taskId);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:30: session-contention hold FNXC lives on session-contention-hold.ts. */
  private sessionContentionHoldAttempts = new Map<string, number>();

  private clearSessionContentionHold(taskId: string): void {
    this.sessionContentionHoldAttempts.delete(taskId);
  }

  private async holdForSessionContention(
    ...args: FacadeRestArgs<typeof impl.holdForSessionContentionImpl>
  ): Promise<void>  {
    return impl.holdForSessionContentionImpl(bags.buildHoldForSessionContentionDeps(this), ...args);
  }

  private async routeUnusableWorktreeGraphFailureToRecovery(
    ...args: FacadeRestArgs<typeof impl.routeUnusableWorktreeGraphFailureToRecoveryImpl>
  ): Promise<boolean>  {
    return impl.routeUnusableWorktreeGraphFailureToRecoveryImpl(bags.buildRouteUnusableWorktreeGraphFailureToRecoveryDeps(this), ...args);
  }

  /* FNXC:CodeOrganization 2026-08-04-06:15: hasLiveTaskSessionSurface FNXC lives on has-live-task-session-surface host peel. */
  private hasLiveTaskSessionSurface(taskId: string): boolean {
    return impl.hasLiveTaskSessionSurfaceImpl(bags.buildHasLiveTaskSessionSurfaceDeps(this), taskId);
  }

  /* FNXC:CodeOrganization 2026-08-04-06:15: isRemediationGraphNode FNXC lives on remediation-graph-node.ts. */
  private async isRemediationGraphNode(taskId: string, failedNode: string | undefined): Promise<boolean> {
    return impl.isRemediationGraphNodeImpl({ store: this.store }, taskId, failedNode);
  }

  /* FNXC:CodeOrganization 2026-08-04-06:15: isPreMergeRemediationGraphNode FNXC lives on remediation-graph-node.ts. */
  private async isPreMergeRemediationGraphNode(taskId: string, failedNode: string | undefined): Promise<boolean> {
    return impl.isPreMergeRemediationGraphNodeImpl({ store: this.store }, taskId, failedNode);
  }

  private async resolveFailedPreMergeWorkflowStepBudget(
    ...args: FacadeAfterFirst<typeof impl.resolveFailedPreMergeWorkflowStepBudgetImpl>
  ): ReturnType<typeof impl.resolveFailedPreMergeWorkflowStepBudgetImpl> {
    return impl.resolveFailedPreMergeWorkflowStepBudgetImpl({ store: this.store }, ...args);
  }

  private async isLiveSharedBranchGroupMember(live: Pick<TaskDetail, "branchContext">): Promise<boolean> {
    return impl.isLiveSharedBranchGroupMemberImpl({ store: this.store, rootDir: this.rootDir }, live);
  }

  private async routeRetryableRemediationGraphFailureToPreMergeFix(
    ...args: FacadeRestArgs<typeof impl.routeRetryableRemediationGraphFailureToPreMergeFixImpl>
  ): Promise<boolean>  {
    return impl.routeRetryableRemediationGraphFailureToPreMergeFixImpl(bags.buildRouteRetryableRemediationGraphFailureToPreMergeFixDeps(this), ...args);
  }

  /* Shared resumeLanesMemo: one snapshot for handleGraphFailure recovery paths (avoid disagreeing re-resolve). */
  private async isRetryableBenignMergePauseAbort(
    ...args: FacadeRestArgs<typeof impl.isRetryableBenignMergePauseAbortImpl>
  ): Promise<boolean> {
    return impl.isRetryableBenignMergePauseAbortImpl(bags.buildResumeLaneClassifierDeps(this), ...args);
  }

  private async isBenignManualMergeHoldPauseAbort(
    ...args: FacadeRestArgs<typeof impl.isBenignManualMergeHoldPauseAbortImpl>
  ): Promise<boolean> {
    return impl.isBenignManualMergeHoldPauseAbortImpl(bags.buildResumeLaneClassifierDeps(this), ...args);
  }

  private async handleStaleInReviewPlanPauseAbortReplay(
    ...args: FacadeRestArgs<typeof impl.handleStaleInReviewPlanPauseAbortReplayImpl>
  ): Promise<boolean> {
    return impl.handleStaleInReviewPlanPauseAbortReplayImpl(bags.buildHandleStaleInReviewPlanPauseAbortReplayDeps(this), ...args);
  }

  private async handleStaleInReviewParsePauseAbortReplay(
    ...args: FacadeRestArgs<typeof impl.handleStaleInReviewParsePauseAbortReplayImpl>
  ): Promise<boolean> {
    return impl.handleStaleInReviewParsePauseAbortReplayImpl(bags.buildHandleStaleInReviewParsePauseAbortReplayDeps(this), ...args);
  }

  private async isReentrantPausedAbortedInFlightNode(
    ...args: FacadeRestArgs<typeof impl.isReentrantPausedAbortedInFlightNodeImpl>
  ): Promise<boolean> {
    return impl.isReentrantPausedAbortedInFlightNodeImpl(bags.buildResumeLaneClassifierDeps(this), ...args);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:05: Full Phase C resume-eligibility FNXC lives on resolve-resume-lanes.ts. */
  private async resolveResumeLanes(
    ...args: FacadeRestArgs<typeof impl.resolveResumeLanesImpl>
  ): Promise<{ hold: string; wip: string; review: string; wipDeclared: boolean }> {
    return impl.resolveResumeLanesImpl({ store: this.store }, ...args);
  }

  private async reenterPausedAbortedWorkflowNode(
    ...args: FacadeRestArgs<typeof impl.reenterPausedAbortedWorkflowNodeImpl>
  ): Promise<boolean>  {
    return impl.reenterPausedAbortedWorkflowNodeImpl(bags.buildReenterPausedAbortedWorkflowNodeDeps(this), ...args);
  }

  private async routeGraphMergeFailureToRetry(
    ...args: FacadeRestArgs<typeof impl.routeGraphMergeFailureToRetryImpl>
  ): Promise<boolean>  {
    return impl.routeGraphMergeFailureToRetryImpl(bags.buildRouteGraphMergeFailureToRetryDeps(this), ...args);
  }

  private async routeImplementationIncompleteMergeGraphFailure(
    ...args: FacadeRestArgs<typeof impl.routeImplementationIncompleteMergeGraphFailureImpl>
  ): Promise<boolean> {
    return impl.routeImplementationIncompleteMergeGraphFailureImpl(bags.buildRouteImplementationIncompleteMergeGraphFailureDeps(this), ...args);
  }

  private async hasTrailingConsecutiveToolFailures(taskId: string, cursor: number | null | undefined, threshold: number): Promise<boolean> {
    return impl.hasTrailingConsecutiveToolFailuresImpl({ store: this.store }, taskId, cursor, threshold);
  }

  /** Terminal failure of a graph run: record the error and park the task in
   *  review so a human can act — never leave it invisible in in-progress. */
  private async handleGraphFailure(task: Task, result: WorkflowGraphTaskRunResult): Promise<void> {
    return impl.handleGraphFailureImpl(bags.buildHandleGraphFailureDeps(this), task, result);
  }

  private async routeGraphFailureToExecutionResume(
    ...args: FacadeRestArgs<typeof impl.routeGraphFailureToExecutionResumeImpl>
  ): Promise<boolean>  {
    return impl.routeGraphFailureToExecutionResumeImpl(bags.buildRouteGraphFailureToExecutionResumeDeps(this), ...args);
  }

  private async routeResetParsePinMismatchToRetry(live: TaskDetail): Promise<boolean> {
    return impl.routeResetParsePinMismatchToRetryImpl(bags.buildRouteResetParsePinMismatchToRetryDeps(this), live);
  }

  private async maybeDispatchWorkflowWorkEngine(task: Task): Promise<boolean> {
    return impl.maybeDispatchWorkflowWorkEngineImpl({ store: this.store }, task);
  }

  private async evaluateTaskVerdictProviders(
    ...args: FacadeRestArgs<typeof impl.evaluateTaskVerdictProvidersImpl>
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    return impl.evaluateTaskVerdictProvidersImpl({ store: this.store }, ...args);
  }

  private async blockOuterDispatchWhenDependenciesUnmet(task: Task): Promise<boolean> {
    return impl.blockOuterDispatchWhenDependenciesUnmetImpl(this.storeRunContextDeps(), task);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:25: ephemeral-off dispatch guard FNXC lives on block-outer-dispatch-when-ephemeral-disabled.ts. */
  private async blockOuterDispatchWhenEphemeralDisabled(task: Task): Promise<boolean> {
    return impl.blockOuterDispatchWhenEphemeralDisabledImpl(bags.buildBlockOuterDispatchWhenEphemeralDisabledDeps(this), task);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:25: execute wrapper + executeCore routing FNXC lives on execute-core.ts. */
  async execute(task: Task): Promise<void> {
    try {
      await this.executeCore(task);
    } finally {
      if (dropPreHeldExecutorSlot(task.id)) this.options.semaphore?.release();
    }
  }

  private async executeCore(task: Task): Promise<void> {
    return impl.executeCoreImpl(bags.buildExecuteCoreDeps(this), task);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:25: runImplementation U5e/U10b/U8 FNXC lives on run-implementation.ts. */
  private async runImplementation(
    ...args: FacadeRestArgs<typeof impl.runImplementationImpl>
  ): Promise<void> {
    return impl.runImplementationImpl(bags.buildRunImplementationFacadeDeps(this), ...args);
  }

  /** FNXC:CodeOrganization 2026-08-03-22:25: shared free-tool deps bag for runImplementation + executeWorkflowStep. */
  private sharedWorkerToolsDeps(): import("./executor/shared-worker-tools.js").SharedWorkerToolsDeps {
    return bags.buildSharedWorkerToolsDeps(this);
  }

  // ── Custom tools for the worker agent ──────────────────────────────

  private createTaskUpdateTool(
    ...args: FacadeRestArgs<typeof impl.createTaskUpdateToolImpl>
  ): ToolDefinition {
    return impl.createTaskUpdateToolImpl(bags.buildCreateTaskUpdateToolDeps(this), ...args);
  }

  private createTaskAddDepTool(taskId: string): ToolDefinition {
    return impl.createTaskAddDepToolImpl(bags.buildCreateTaskAddDepToolDeps(this), taskId);
  }

  private async transitionReviewAddressing(taskId: string, from: Array<"queued" | "in-progress" | "addressed" | "failed">, to: "queued" | "in-progress" | "addressed" | "failed"): Promise<void> {
    return impl.transitionReviewAddressingImpl(this.store, taskId, from, to);
  }

  /* FNXC:CodeOrganization 2026-08-03-16:20: worktree invariant facades (U4 Slice B). */
  private worktreeInvariantDeps() {
    return bags.buildWorktreeInvariantFacadeDeps(this);
  }

  private async verifyWorktreeInvariants(
    ...args: FacadeRestArgs<typeof impl.verifyWorktreeInvariantsImpl>
  ): ReturnType<typeof impl.verifyWorktreeInvariantsImpl> {
    return impl.verifyWorktreeInvariantsImpl(this.worktreeInvariantDeps(), ...args);
  }

  private async evaluateTaskDoneScopeLeak(
    ...args: FacadeRestArgs<typeof impl.evaluateTaskDoneScopeLeakImpl>
  ): ReturnType<typeof impl.evaluateTaskDoneScopeLeakImpl> {
    return impl.evaluateTaskDoneScopeLeakImpl(bags.buildEvaluateTaskDoneScopeLeakDeps(this), ...args);
  }

  private async handleImplicitTaskDoneRefusal(
    ...args: FacadeRestArgs<typeof impl.handleImplicitTaskDoneRefusalImpl>
  ): Promise<void>  {
    return impl.handleImplicitTaskDoneRefusalImpl(bags.buildHandleImplicitTaskDoneRefusalDeps(this), ...args);
  }

  private createTaskDoneTool(
    ...args: FacadeRestArgs<typeof impl.createTaskDoneToolImpl>
  ): ToolDefinition  {
    return impl.createTaskDoneToolImpl(bags.buildCreateTaskDoneToolDeps(this), ...args);
  }

  private async handleDepAbortCleanup(taskId: string, worktreePath: string): Promise<void> {
    return impl.handleDepAbortCleanupImpl(bags.buildHandleDepAbortCleanupDeps(this), taskId, worktreePath);
  }

  private async reopenLastStepForRevision(
    ...args: FacadeAfterFirst<typeof impl.reopenLastStepForRevisionImpl>
  ): Promise<{ index: number; name: string; indexes: number[] } | null> {
    return impl.reopenLastStepForRevisionImpl(this.store, ...args);
  }

  private async runExecutorDeterministicVerification(
    ...args: FacadeRestArgs<typeof impl.runExecutorDeterministicVerificationImpl>
  ): Promise<VerificationResult>  {
    return impl.runExecutorDeterministicVerificationImpl(this.storeRunContextDeps(), ...args);
  }

  private async attemptExecutorVerificationFix(
    ...args: FacadeRestArgs<typeof impl.attemptExecutorVerificationFixImpl>
  ): Promise<boolean> {
    return impl.attemptExecutorVerificationFixImpl(bags.buildAttemptExecutorVerificationFixDeps(this), ...args);
  }

  private async sendTaskBackForFix(
    ...args: FacadeRestArgs<typeof impl.sendTaskBackForFixImpl>
  ): Promise<void> {
    return impl.sendTaskBackForFixImpl(bags.buildSendTaskBackForFixDeps(this, constants.MAX_WORKFLOW_STEP_RETRIES), ...args);
  }

  private async injectWorkflowStepFailureInstructions(
    ...args: FacadeAfterFirst<typeof impl.injectWorkflowStepFailureInstructionsImpl>
  ): Promise<void>  {
    return impl.injectWorkflowStepFailureInstructionsImpl(this.store, ...args);
  }

  private async captureModifiedFiles(...args: Parameters<typeof impl.captureModifiedFilesImpl>): Promise<string[]> {
    return impl.captureModifiedFilesImpl(...args);
  }
  private async captureWorkspaceModifiedFiles(...args: Parameters<typeof impl.captureWorkspaceModifiedFilesImpl>): Promise<string[]> {
    return impl.captureWorkspaceModifiedFilesImpl(...args);
  }
  private async reviewWorkspacePerRepo(...args: Parameters<typeof impl.reviewWorkspacePerRepoImpl>): Promise<ReviewResult> {
    return impl.reviewWorkspacePerRepoImpl(...args);
  }

  private async captureUncommittedModifiedFiles(worktreePath: string): Promise<string[]> {
    return impl.captureUncommittedModifiedFilesImpl(worktreePath);
  }

  // ── Worktree management ────────────────────────────────────────────

  /**
   * Execute a script-mode workflow step by resolving the scriptName to a command
   * from project settings and running it in the task worktree.
   */
  private async executeScriptWorkflowStep(
    ...args: FacadeRestArgs<typeof impl.executeScriptWorkflowStepImpl>
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    return impl.executeScriptWorkflowStepImpl(bags.buildExecuteScriptWorkflowStepDeps(this, pure.runConfiguredCommand), ...args);
  }

  private workflowInputRepliesAfterWatermark(task: TaskDetail, marker: string): Array<{ createdAt?: string }> {
    return impl.workflowInputRepliesAfterWatermarkImpl(task, marker);
  }

  private async resolveWorkflowInputMarkerForGraphNode(live: TaskDetail, nodeId: string): Promise<"clear" | "waiting" | "none"> {
    return impl.resolveWorkflowInputMarkerForGraphNodeImpl(this.storeRunContextDeps(), live, nodeId);
  }

  private async executeWorkflowStep(
    ...args: FacadeRestArgs<typeof impl.executeWorkflowStepImpl>
  ): Promise<WorkflowStepOutcome> {
    return impl.executeWorkflowStepImpl(bags.buildExecuteWorkflowStepDeps(this), ...args);
  }

  private async tryBootstrapMisbindingRecovery(
    ...args: FacadeRestArgs<typeof impl.tryBootstrapMisbindingRecoveryImpl>
  ): Promise<boolean> {
    return impl.tryBootstrapMisbindingRecoveryImpl(bags.buildTryBootstrapMisbindingRecoveryDeps(this), ...args);
  }

  /* FNXC:CodeOrganization 2026-08-03-16:05: branch-conflict reclaim/handle facades (U4 Slice B). */
  private branchConflictHandleDeps() {
    return bags.buildBranchConflictHandleFacadeDeps(this);
  }

  private async reclaimExistingWorktree(
    ...args: FacadeRestArgs<typeof impl.reclaimExistingWorktreeImpl>
  ): Promise<void> {
    return impl.reclaimExistingWorktreeImpl(this.branchConflictHandleDeps(), ...args);
  }

  private async handleBranchConflict(
    ...args: FacadeRestArgs<typeof impl.handleBranchConflictImpl>
  ): Promise<"retry" | "reclaimed" | "sticky"> {
    return impl.handleBranchConflictImpl(this.branchConflictHandleDeps(), ...args);
  }

  private async recoverMissingWorktreeSessionStartFailure(
    ...args: FacadeRestArgs<typeof impl.recoverMissingWorktreeSessionStartFailureImpl>
  ): Promise<false | "requeue-todo" | "escalate-exhausted">  {
    return impl.recoverMissingWorktreeSessionStartFailureImpl(bags.buildRecoverMissingWorktreeSessionStartFailureDeps(this), ...args);
  }

  private async emitWorktreeReanchoredAudit(
    ...args: FacadeRestArgs<typeof impl.emitWorktreeReanchoredAuditImpl>
  ): Promise<void> {
    return impl.emitWorktreeReanchoredAuditImpl(this.storeRunContextDeps(), ...args);
  }

  listWorktreeHolders(): Array<{ taskId: string; worktreePath: string }> {
    // FNXC:Workspace 2026-06-21-12:00: KTD2 — flat-map each task's Set into one holder row per worktree path. A workspace task emits N rows; the FN-6782 reaper (self-healing.ts) and in-process-runtime adapter key purely off taskId (verified) and are idempotent across duplicate-task rows, so multi-row holders do not mis-count maxWorktrees slots.
    return impl.listWorktreeHoldersImpl(this.activeWorktrees);
  }

  /* FNXC:CodeOrganization 2026-08-03-14:20: thin free-helper facades for vi.spyOn surfaces (U4 Slice B). */
  private hasActiveWorktreeBinding(taskId: string, worktreePath: string): boolean {
    return pure.hasActiveWorktreeBinding(this.activeWorktrees, taskId, worktreePath);
  }

  private async shouldGenerateNewWorktreeName(conflictPath: string, currentTaskId: string): Promise<boolean> {
    return pure.shouldGenerateNewWorktreeName(this.activeWorktrees, this.store, conflictPath, currentTaskId);
  }

  private async findActiveWorktreeOwner(worktreePath: string, requestingTaskId: string): Promise<string | null> {
    return pure.findActiveWorktreeOwner(this.activeWorktrees, this.store, worktreePath, requestingTaskId);
  }

  private async isLiveCleanupRefusal(worktreePath: string, taskId: string): Promise<boolean> {
    return pure.isLiveCleanupRefusal(this.activeWorktrees, this.store, worktreePath, taskId);
  }

  private async cleanupStaleBranch(branch: string, taskId: string): Promise<boolean> {
    return pure.cleanupStaleBranch(this.rootDir, this.store, branch, taskId);
  }

  private async planSquashImportFromDep(
    ...args: FacadeAfterSecond<typeof pure.planSquashImportFromDep>
  ): ReturnType<typeof pure.planSquashImportFromDep> {
    return pure.planSquashImportFromDep(this.rootDir, this.store, ...args);
  }

  private async reconcileSelfOwnedBeforeRemove(
    ...args: FacadeRestArgs<typeof pure.reconcileSelfOwnedBeforeRemove>
  ): Promise<void> {
    return pure.reconcileSelfOwnedBeforeRemove(this.store, ...args);
  }

  /* FNXC:CodeOrganization 2026-08-03-14:50: stale-lock / reclaim / remove-own facades (U4 Slice B). */
  private staleLockRecoveryDeps() {
    return bags.buildStaleLockRecoveryDeps(this);
  }

  private async emitStaleLockAudit(
    ...args: FacadeRestArgs<typeof pure.emitStaleLockAudit>
  ): Promise<void> {
    return pure.emitStaleLockAudit(this.staleLockRecoveryDeps(), ...args);
  }

  private async recoverIndexLockIfStale(taskId: string, path: string, conflictInfo: { lockPath?: string; message?: string }): Promise<boolean> {
    return pure.recoverIndexLockIfStale(this.staleLockRecoveryDeps(), taskId, path, conflictInfo);
  }

  private async recoverStaleRegistration(taskId: string, path: string, conflictInfo: { path?: string; message?: string }): Promise<boolean> {
    return pure.recoverExecutorStaleRegistration(this.staleLockRecoveryDeps(), taskId, path, conflictInfo);
  }

  private async normalizeReclaimableWorktreePath(
    ...args: FacadeRestArgs<typeof pure.normalizeReclaimableWorktreePath>
  ): Promise<string> {
    return pure.normalizeReclaimableWorktreePath(bags.buildNormalizeReclaimableWorktreePathDeps(this), ...args);
  }

  private async tryFreshWorktreeAfterLiveConflict(
    ...args: FacadeRestArgs<typeof pure.tryFreshWorktreeAfterLiveConflict>
  ): Promise<{ path: string; branch: string }> {
    return pure.tryFreshWorktreeAfterLiveConflict(bags.buildTryFreshWorktreeAfterLiveConflictDeps(this, bindTryCreateWorktree(this)), ...args);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:45: worktree create/conflict deps bag + binders (U4). */
  private worktreeCreateConflictDeps(): import("./executor/worktree-create-conflict.js").WorktreeCreateConflictDeps {
    return bags.buildWorktreeCreateConflictFacadeDeps(this, constants.MAX_WORKTREE_RETRIES, bindHandleWorktreeConflict(this), bindTryCreateWorktree(this));
  }

  private async tryCreateWorktree(
    ...args: FacadeRestArgs<typeof impl.tryCreateWorktreeImpl>
  ): Promise<{ path: string; branch: string }> {
    return impl.tryCreateWorktreeImpl(this.worktreeCreateConflictDeps(), ...args);
  }

  private async handleWorktreeConflict(
    ...args: FacadeRestArgs<typeof impl.handleWorktreeConflictImpl>
  ): Promise<{ path: string; branch: string } | null> {
    return impl.handleWorktreeConflictImpl(this.worktreeCreateConflictDeps(), ...args);
  }

  private async cleanupConflictingWorktree(
    ...args: FacadeRestArgs<typeof impl.cleanupConflictingWorktreeImpl>
  ): Promise<boolean>  {
    return impl.cleanupConflictingWorktreeImpl(bags.buildCleanupConflictingWorktreeDeps(this), ...args);
  }

  /* FNXC:CodeOrganization 2026-08-03-15:20: outer worktree create path facades (U4 Slice B). */
  private async resolveWorktreeStartPoint(startPoint: string, taskId: string): Promise<string | null> {
    return impl.resolveWorktreeStartPointImpl(this.rootDir, this.store, startPoint, taskId);
  }

  private async squashImportDepIntoWorktree(
    ...args: FacadeAfterFirst<typeof impl.squashImportDepIntoWorktreeImpl>
  ): Promise<void>  {
    return impl.squashImportDepIntoWorktreeImpl(this.store, ...args);
  }

  private async rebaseNewWorktreeOntoRemote(
    ...args: FacadeAfterSecond<typeof impl.rebaseNewWorktreeOntoRemoteImpl>
  ): Promise<void> {
    return impl.rebaseNewWorktreeOntoRemoteImpl(this.rootDir, this.store, ...args);
  }

  private async createWorktree(
    ...args: FacadeRestArgs<typeof impl.createWorktreeImpl>
  ): Promise<{ path: string; branch: string }> {
    return impl.createWorktreeImpl(bags.buildCreateWorktreeFacadeDeps(this, bindTryCreateWorktree(this)), ...args);
  }

  private async removeOwnWorktreeWithReconcile(
    ...args: FacadeRestArgs<typeof pure.removeOwnWorktreeWithReconcile>
  ): Promise<void> {
    return pure.removeOwnWorktreeWithReconcile(bags.buildRemoveOwnWorktreeWithReconcileDeps(this), ...args);
  }

  /** Remove only this executor's store-scoped lifecycle disposer registrations. */
  disposeStoreLifecycleDisposers(): void {
    impl.disposeStoreLifecycleDisposersImpl({
      clearTaskMoveDisposer: () => { this.unregisterTaskMoveDisposer?.(); this.unregisterTaskMoveDisposer = undefined; },
      clearArchiveWorktreeDisposer: () => { this.unregisterArchiveWorktreeDisposer?.(); this.unregisterArchiveWorktreeDisposer = undefined; },
      clearArchiveWorkspaceWorktreeDisposer: () => { this.unregisterArchiveWorkspaceWorktreeDisposer?.(); this.unregisterArchiveWorkspaceWorktreeDisposer = undefined; },
    });
  }

  async cleanup(taskId: string): Promise<void> {
    return impl.cleanupTaskWorktreeImpl(bags.buildCleanupTaskWorktreeDeps(this), taskId);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:40: recoverApprovedSteps FNXC lives on recover-approved-steps-on-resume.ts. */
  private async recoverApprovedStepsOnResume(taskId: string): Promise<void> {
    return impl.recoverApprovedStepsOnResumeImpl(this.store, taskId);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:40: reconcileStepsFromGitHistory FNXC lives on reconcile-steps-from-git-history.ts. */
  private async reconcileStepsFromGitHistory(taskId: string, detail: TaskDetail, worktreePath: string): Promise<void> {
    return impl.reconcileStepsFromGitHistoryImpl(bags.buildReconcileStepsFromGitHistoryDeps(this), taskId, detail, worktreePath);
  }

  /** Stuck-kill: reset done steps when branch has no unique commits (lost uncommitted work). */
  private async resetStepsIfWorkLost(task: Task): Promise<void> {
    return impl.resetStepsIfWorkLostImpl(bags.buildResetStepsIfWorkLostDeps(this), task);
  }

  private async resetLostWorkStepProgress(task: Task, completedStepCount: number, reason: string): Promise<void> {
    return impl.resetLostWorkStepProgressImpl({ store: this.store }, task, completedStepCount, reason);
  }

  markStuckAborted(...args: FacadeRestArgs<typeof impl.markStuckAbortedImpl>): void {
    return impl.markStuckAbortedImpl(bags.buildMarkStuckAbortedDeps(this), ...args);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:40: handleLoopDetected FNXC lives on handle-loop-detected.ts. */
  async handleLoopDetected(...args: FacadeRestArgs<typeof impl.handleLoopDetectedImpl>): Promise<boolean> {
    return impl.handleLoopDetectedImpl(bags.buildHandleLoopDetectedDeps(this), ...args);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:30: getWorktreePath KTD2 contract FNXC lives on active-worktrees helpers / free peel. */
  getWorktreePath(taskId: string): string | undefined {
    return impl.getWorktreePathImpl(this.workspaceConfig, (id) => this.getActiveWorktreePaths(id), taskId);
  }

  // ── Agent Spawning ─────────────────────────────────────────────────────

  private async terminateAllChildren(parentTaskId: string): Promise<void> {
    return impl.terminateAllChildrenImpl(bags.buildTerminateAllChildrenDeps(this), parentTaskId);
  }

  private async terminateChildAgent(childId: string): Promise<void> {
    return impl.terminateChildAgentImpl(bags.buildTerminateChildAgentDeps(this), childId);
  }

  /**
   * Run a spawned child agent's task to completion.
   * Handles state transitions and cleanup.
   */
  private async runSpawnedChild(
    ...args: FacadeRestArgs<typeof impl.runSpawnedChildImpl>
  ): Promise<void>  {
    return impl.runSpawnedChildImpl(bags.buildRunSpawnedChildDeps(this), ...args);
  }

  private createSpawnAgentTool(
    ...args: FacadeRestArgs<typeof impl.createSpawnAgentToolImpl>
  ): ToolDefinition {
    // FNXC:CodeOrganization 2026-08-03-12:35: get/set totalSpawnedCount so capacity tests that mutate priv.totalSpawnedCount still drive the free-fn path.
    return impl.createSpawnAgentToolImpl(bags.buildCreateSpawnAgentToolDeps(this), ...args);
  }

}
