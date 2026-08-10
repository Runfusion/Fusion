/**
 * FNXC:CodeOrganization 2026-08-03-16:10:
 * runImplementation peeled from TaskExecutor (U4).
 *
 * Full implementation-phase session: worktree acquire/claim, agent session loop,
 * verification, completion handoff, and recovery paths. Graph-owned via required
 * graphCompletion callback (U10b / R9).
 *
 * FNXC:WorkflowExecution 2026-07-19-02:10:
 * U5e (R9) — the implementation phase, lifted out of the dual-purpose `executeCore` into a
 * standalone runner the workflow graph calls DIRECTLY. Before the lift the graph re-entered
 * `execute()` under a completion signal, because worktree / taskEnv / agent / semaphore state
 * is assembled here and was not available standalone at `createGraphSeams` time. Lifting the
 * body moves that assembly behind an ordinary method call, so the graph gets the state it
 * needs without a second trip through routing.
 *
 * Owns: the process-wide task lock, soft-delete refusal, work-engine dispatch, heartbeat
 * deferral, settings merge, worktree acquisition, the agent session, and everything up to the
 * implementation-complete boundary. It does NOT own workflow gates, review handoff, or merge —
 * those are the graph's.
 *
 * FNXC:WorkflowExecution 2026-07-19-17:50 (U10b / R9):
 * graphCompletion is REQUIRED, and an explicit parameter rather than an options bag. It was
 * optional only to describe "a run the graph does not own" — the legacy fallback. That fallback
 * is deleted, so every implementation pass is graph-owned and every completion boundary below is
 * an unconditional handoff. Making it required is the type-level statement of that invariant:
 * an implementation pass whose completion nothing owns can no longer be constructed.
 *
 * FNXC:WorkflowExecutionOwnership 2026-07-28-20:15 (U8 / R4, R5):
 * Optional exit reporter. `graphCompletion` can only say "done"; the endings it cannot express
 * are the ones the executor transitions itself (see `executor/implementation-exit.ts`). This
 * names them so they are OBSERVABLE before they are moved — it changes no routing and nothing
 * branches on it, by R5: an exit id is a reaction, and a dropped reaction must never cost a
 * state change. Optional so uninstrumented dispositions stay silent rather than forcing a
 * large diff; the ownership ledger is the record of that gap, not this callback.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";

const execAsync = promisify(exec);
import type {
  RunMutationContext,
  Task,
  TaskStore,
  WorkspaceConfig,
} from "@fusion/core";
import {
  ApprovalRequestStore,
  DEFAULT_PROVIDER_INSTANCE_ID,
  RetryStormError,
  columnsWithFlag,
  isEphemeralAgent,
  loadWorkspaceConfig,
  resolveEphemeralTaskCreationPolicy,
  resolveExecutorFallbackModel,
  resolvePersistAgentThinkingLog,
  resolveTaskLifecycleColumns,
  resolveWorkflowIrForTask,
  serializeRetryStormError,
} from "@fusion/core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createArtifactListTool,
  createArtifactRegisterTool,
  createArtifactViewTool,
  createTaskCreateTool,
  createTaskDocumentReadTool,
  createTaskDocumentWriteTool,
  createTaskFileScopeAddTool,
  createTaskLogTool,
  createTaskLogsReadTool,
  createTaskPromoteTool,
  createTraitListTool,
  createWorkflowCreateTool,
  createWorkflowDeleteTool,
  createWorkflowGetTool,
  createWorkflowListTool,
  createWorkflowSelectTool,
  createWorkflowSettingsTool,
  createWorkflowUpdateTool,
  createWorkflowValidateTool,
} from "./shared-worker-tools.js";
import {
  createAcquireRepoWorktreeTool,
  createAgentCreateTool,
  createAgentDeleteTool,
  createDelegateTaskTool,
  createGetAgentConfigTool,
  createGoalRetrievalTools,
  createIdeationTools,
  createListAgentsTool,
  createMemoryTools,
  createMissionTools,
  createReadMessagesTool,
  createReflectOnPerformanceTool,
  createResearchTools,
  createSendMessageTool,
  createTaskAssignTool,
  createUpdateAgentConfigTool,
  createWebFetchTool,
  isAgentDelegateTaskToolAvailable,
  isAgentTaskCreateToolAvailable,
} from "../agent-tools.js";
import { getEnabledPluginTools } from "../execution/tool-availability.js";
import type { AcquireTaskWorktreeResult } from "../worktree/worktree-acquisition.js";
import type { ProviderInstanceRef } from "@fusion/core";
import type { ReviewVerdict } from "../execution/reviewer.js";
import { buildPluginPromptSection } from "../agents/agent-instructions.js";
import { AgentLogger } from "../agents/agent-logger.js";
import {
  createResolvedAgentSession,
  extractRuntimeHint,
  resolveExecutorFallbackThinkingLevel,
  resolveExecutorSessionModel,
  resolveExecutorThinkingLevel,
} from "../agents/agent-session-helpers.js";
import {
  executingTaskLock,
} from "../agents/active-session-registry.js";
import { createFallbackModelObserver } from "../auth/fallback-model-observer.js";
import { buildSessionSkillContext } from "../cli-runtime/session-skill-context.js";
import { dropPreHeldExecutorSlot } from "../concurrency/concurrency.js";
import { resolveAuthoritativeExternalExecutionRoute } from "./resolve-authoritative-external-execution-route.js";
import { isContextLimitError } from "../errors/context-limit-detector.js";
import { withRateLimitRetry } from "../errors/rate-limit-retry.js";
import { recordRetry } from "../errors/retry-burned-logger.js";
import { isSilentTransientError, isTransientError } from "../errors/transient-error-detector.js";
import { checkSessionError, isUsageLimitError } from "../errors/usage-limit-detector.js";
import { TokenCapDetector } from "../errors/token-cap-detector.js";
import {
  assertCleanBranchAtBase,
  autoRecoverCrossContamination,
  classifyForeignCommits,
  classifyForeignOnlyContamination,
  classifyMisroutedForeignCommit,
  isBranchConflictError,
  reportBranchAttribution,
  BranchCrossContaminationError,
} from "../execution/branch-conflicts.js";
import { buildPromptLayers, collapsePromptLayers } from "../execution/prompt-layers.js";
import { moveTaskToReplanColumn } from "../execution/replan-target.js";
import {
  createRunVerificationTool,
  runVerificationCommand as runTaskVerificationCommand,
} from "../execution/run-verification-tool.js";
import { captureSessionTokenBaseline, resetSessionTokenBaseline } from "../execution/session-token-usage.js";
import { evaluateSpecStaleness, getPromptPath } from "../execution/spec-staleness.js";
import { StepSessionExecutor } from "../execution/step-session-executor.js";
import { isResearchToolSurfaceEnabled } from "../execution/tool-availability.js";
import { summarizeVerificationOutput } from "../execution/verification-utils.js";
import { buildAgentPersona } from "./agent-binding-pure.js";
import { evaluateImplicitCompletionRefusal } from "./completion-predicates.js";
import {
  configuredCommandErrorMessage,
  runConfiguredCommand,
} from "./configured-command.js";
import { buildExecutionPrompt } from "./execution-prompt.js";
import { resolveReboundColumnFor, resolveTerminalColumnsFor } from "./lifecycle-columns.js";
import { detectPendingReviewBlock } from "./pending-review-block.js";
import { detectPseudoPause } from "./pseudo-pause.js";
import { isInvalidAssistantContinuationErrorMessage } from "./requeue-loop.js";
import {
  canonicalizePath,
  extractPersistedSessionWorktreePath,
  formatGitRepositoryDetectionError,
  isSessionWorktreeCompatible,
} from "./session-worktree-paths.js";
import { isWorkflowStepSkillDiscoverable, mergeAdditionalSkillPaths } from "./skill-path-helpers.js";
import { getExecutorSystemPrompt } from "./system-prompt.js";
import { createConfiguredCommandAbortError, createSeenSteeringIds } from "./task-predicates.js";
import {
  accumulateTokenUsage as accumulateTokenUsageImpl,
  tokenUsageWithModelSnapshot as tokenUsageWithModelSnapshotImpl,
} from "./token-usage-pure.js";
import { captureBaseCommitSha, resolveContaminationBaseRef } from "./worktree-git-refs.js";
import { MAX_TASK_DONE_REQUEUE_RETRIES } from "./task-done-refusal-handler.js";
import type { ImplementationExitReporter } from "./implementation-exit.js";
import type { GraphCompletionCallback } from "./run-implementation-phase.js";
import { resolveAndEmitGoalContext } from "../goals/goal-injection-diagnostics.js";
import { computeRecoveryDecision, formatDelay, MAX_RECOVERY_RETRIES } from "../healing/recovery-policy.js";
import { executorLog, formatError } from "../logger.js";
import { classifyOrphanOurAdvance, rehomeOrphanOntoIntegration } from "../merge/merger-orphan-rehome.js";
import { compactSessionContext, describeModel, formatModelMarkerDetails, promptWithFallback } from "../pi.js";
import { resolveDedicatedPlannerColumnsForTask } from "../planner-lane-resolution.js";
import { mergeEffectiveSettings } from "../project/effective-settings.js";
import { buildStepFailureMessage, emitProactiveStatus, sanitizeFailureReason } from "../project/proactive-status.js";
import { createRunAuditor, generateSyntheticRunId, type EngineRunContext } from "../util/run-audit.js";
import { acquireTaskWorktree } from "../worktree/worktree-acquisition.js";
import { resolveWorktreesDir } from "../worktree/worktree-paths.js";
import {
  RemovalReason,
  classifyTaskWorktree,
  describeRegisteredWorktrees,
  detectGitRepository,
  detectNestedWorktreeRoot,
  isInsideWorktreesDir,
  removeWorktree,
} from "../worktree/worktree-pool.js";

const MAX_TASK_DONE_SESSION_RETRIES = 3;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirror TaskExecutor method/map surface
type AnyFn = (...args: any[]) => any;

/** Minimal session bookkeeping shape used by activeSessions map. */
type ActiveExecutorSessionState = {
  session: AgentSession | null;
  [k: string]: unknown;
};

export type RunImplementationDeps = {
  store: TaskStore;
  rootDir: string;
  workspaceConfig: WorkspaceConfig | null | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TaskExecutorOptions is large and only partially used here
  options: any;
  stuckAborted: Map<string, boolean>;
  executing: Set<string>;
  depAborted: Set<string>;
  tokenUsageBaselines: Map<string, { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens?: number }>;
  loopRecoveryState: Map<string, { attempts: number; pending: boolean }>;
  branchConflictErrorCount: Map<string, number>;
  pausedAborted: Set<string>;
  userCanceledTaskIds: Set<string>;
  tokenCapDetector: TokenCapDetector;
  approvalRequestStore: ApprovalRequestStore;
  activeSessions: Map<string, ActiveExecutorSessionState>;
  activeWorktrees: Map<string, Set<string>>;
  activeWorkflowGraphAbortControllers: Map<string, AbortController>;
  activeWorkflowPrincipals: Map<string, { agentId: string; nodeInstanceId: string; agent?: import("@fusion/core").Agent }>;
  currentRunContexts: Map<string, RunMutationContext | EngineRunContext | undefined>;
  effectiveColumnAgentByTask: Map<string, unknown>;
  graphSeamThinkingLevel: Map<string, string | undefined>;
  graphSeamSkillName: Map<string, string>;
  graphStepSessionPinned: Set<string>;
  outerConcurrencyClaims: Set<string>;
  BRANCH_CONFLICT_TRIPWIRE_THRESHOLD: number;
  MAX_AUTO_RECOVERY_ATTEMPTS: number;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  addActiveWorktree: AnyFn;
  attemptExecutorVerificationFix: AnyFn;
  buildActionGateContext: AnyFn;
  buildInjectedRuntimeEnv: AnyFn;
  buildPermanentAgentGatingContext: AnyFn;
  captureExecutorTokenUsageBaseline: AnyFn;
  captureModifiedFiles: AnyFn;
  captureWorkspaceModifiedFiles: AnyFn;
  cleanupMergeStateForReverification: AnyFn;
  clearCompletedTaskWatchdog: AnyFn;
  clearPausedAborted: AnyFn;
  /** FNXC:CodeOrganization 2026-08-03-22:05: simple shared tools use free factories in shared-worker-tools.ts */
  sharedWorkerTools: import("./shared-worker-tools.js").SharedWorkerToolsDeps;
  createSpawnAgentTool: AnyFn;
  createTaskAddDepTool: AnyFn;
  createTaskDoneTool: AnyFn;
  createTaskUpdateTool: AnyFn;
  createWorktree: AnyFn;
  deleteActiveSession: AnyFn;
  deleteActiveStepExecutor: AnyFn;
  emitWorktreeReanchoredAudit: AnyFn;
  finalizeAlreadyReviewedTask: AnyFn;
  finalizeMergeConfirmedWorkflowGraphTask: AnyFn;
  getAuthoritativeAssignedAgent: AnyFn;
  getAutoRecoveryDispatcher: AnyFn;
  getCompletedTaskFinalizationDecision: AnyFn;
  handleBranchConflict: AnyFn;
  handleDepAbortCleanup: AnyFn;
  handleImplicitTaskDoneRefusal: AnyFn;
  handleNonContinuableSessionError: AnyFn;
  handleNonContinuableSessionRetry: AnyFn;
  handoffTaskToReview: AnyFn;
  hasActiveWorktreeBinding: AnyFn;
  markCompletionFinalized: AnyFn;
  markGraphExecuteSelfRequeued: AnyFn;
  maybeDispatchWorkflowWorkEngine: AnyFn;
  parkApprovalSuspension: AnyFn;
  persistTaskTokenUsage: AnyFn;
  persistTokenUsage: AnyFn;
  reconcileStepsFromGitHistory: AnyFn;
  recoverMissingWorktreeSessionStartFailure: AnyFn;
  registerConfiguredCommandController: AnyFn;
  renewTaskLease: AnyFn;
  resetStepsIfWorkLost: AnyFn;
  resolveEffectivePrincipalId: AnyFn;
  resolveInstructionsForRole: AnyFn;
  resolveMcpServers: AnyFn;
  resolveResumeLanes: AnyFn;
  resolveSeamColumnAgent: AnyFn;
  resolveTaskCustomFieldDefs: AnyFn;
  resumeApprovalAfterUnwindIfNeeded: AnyFn;
  runExecutorDeterministicVerification: AnyFn;
  runWithExecutorSemaphore: AnyFn;
  scheduleCompletedTaskWatchdog: AnyFn;
  sendTaskBackForFix: AnyFn;
  setActiveSession: AnyFn;
  setActiveStepExecutor: AnyFn;
  shouldDeferCompletionForGlobalPause: AnyFn;
  shouldDeferForHeartbeat: AnyFn;
  signalTaskComplete: AnyFn;
  terminateAllChildren: AnyFn;
  transitionReviewAddressing: AnyFn;
  tryBootstrapMisbindingRecovery: AnyFn;
  unregisterConfiguredCommandController: AnyFn;
};

export async function runImplementation(
  deps: RunImplementationDeps,
  task: Task,
  graphCompletion: GraphCompletionCallback,
  reportImplementationExit?: ImplementationExitReporter,
): Promise<void> {

    // FN-4811 follow-up (FN-4814/FN-4809/FN-4811 production failure): claim a
    // PROCESS-WIDE lock synchronously before any other work. Per-instance
    // `deps.executing` was insufficient in production because two execute()
    // invocations for the same task ID still both reached "Executor detected
    // stale merge state" (executor.ts:2661) and both generated runIds — producing
    // duplicate "Worktree created at /..." log entries within the same second.
    // The only fully-reliable guard is a singleton lock shared across all
    // TaskExecutor instances in the same process (e.g., engine restart race,
    // multi-project hybrid runtime, etc.). This is `executingTaskLock` in
    // active-session-registry.ts, a module-level Set.
    const claimed = executingTaskLock.tryClaim(task.id);
    executorLog.debug(`execute() called for ${task.id} (claimed=${claimed}, perInstanceExecuting=${deps.executing.has(task.id)})`);
    if (!claimed) {
      // FNXC:GlobalConcurrencyControls 2026-07-15-02:55: graph fallback may have re-registered a pre-held slot; drop it when this process cannot claim the executor lock.
      if (dropPreHeldExecutorSlot(task.id)) deps.options.semaphore?.release();
      return;
    }

    // Maintain the per-instance Set too, for back-compat with all the existing
    // `deps.executing.has()` checks throughout the file (handler gates,
    // stuck-detector, resumeTaskForAgent, etc.). Per-instance state stays
    // consistent with the process-wide lock.
    deps.executing.add(task.id);

    if (task.deletedAt) {
      executorLog.warn(`${task.id}: refusing execute — task is soft-deleted`);
      deps.executing.delete(task.id);
      executingTaskLock.release(task.id);
      if (dropPreHeldExecutorSlot(task.id)) deps.options.semaphore?.release();
      return;
    }

    if (await deps.maybeDispatchWorkflowWorkEngine(task)) {
      executorLog.log(`${task.id}: workflow work engine claimed execution`);
      deps.executing.delete(task.id);
      executingTaskLock.release(task.id);
      // FNXC:GlobalConcurrencyControls 2026-07-15-02:55: work-engine ownership never take()s the legacy handoff registration — release the reserved global slot.
      if (dropPreHeldExecutorSlot(task.id)) deps.options.semaphore?.release();
      return;
    }

    // Column-agent principal alignment (plan U5, R6): the heartbeat-deferral gate
    // must consult the EFFECTIVE principal, not blindly `assignedAgentId`. For a
    // graph-routed seam the binding context (governing node id + per-run resolver)
    // is already set by the time the seam re-enters execute() — so the effective
    // column agent (when an override/defer binding governs) is the principal whose
    // `allowParallelExecution=false` must serialize. For the legacy/no-binding path
    // `resolveEffectivePrincipalId` returns `assignedAgentId`, so the gate is
    // byte-identical to before.
    const deferralPrincipalId = deps.resolveEffectivePrincipalId(task, task);
    if (deferralPrincipalId && await deps.shouldDeferForHeartbeat(deferralPrincipalId)) {
      executorLog.debug(`${task.id}: skipping execute — agent ${deferralPrincipalId} has active heartbeat run (allowParallelExecution=false)`);
      // Release the slot we just claimed — we never actually ran.
      deps.executing.delete(task.id);
      executingTaskLock.release(task.id);
      // FNXC:GlobalConcurrencyControls 2026-07-15-02:55: heartbeat defer must free any re-registered pre-held global slot so capacity is not stranded until the next dispatch.
      if (dropPreHeldExecutorSlot(task.id)) deps.options.semaphore?.release();
      return;
    }

    executorLog.log(`Starting ${task.id}: ${task.title || task.description.slice(0, 60)}`);

    // Fetch settings early — needed for worktree naming and later configuration.
    // Merge per-task effective workflow settings (U3, KTD-3) OVER the project/global
    // base so the ~20 flat `settings.<key>` read sites threaded from here (workflow
    // step timeout, scope enforcement, runStepsInNewSessions, model lanes,
    // reviewHandoffPolicy, …) pick up workflow values with zero read-site changes.
    // Behavior-inert when nothing is customized (declaration defaults === legacy
    // defaults; absent-default lanes never override).
    /*
    FNXC:ExternalExecutionCheckout 2026-08-09-23:53:
    Execution must re-read persisted routing state and fail closed before worktree acquisition when an operator-owned checkout has drifted or become invalid.
    */
    const { task: authoritativeExecutionTask, route: externalExecutionRoute } =
      await resolveAuthoritativeExternalExecutionRoute(deps.store, task);
    task = authoritativeExecutionTask;
    const settings = await mergeEffectiveSettings(deps.store, task, await deps.store.getSettings());
    if (externalExecutionRoute.configured && !externalExecutionRoute.valid) {
      const message = `Persisted external execution checkout is invalid: ${externalExecutionRoute.reason ?? "unknown error"}`;
      await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
      deps.executing.delete(task.id);
      executingTaskLock.release(task.id);
      if (dropPreHeldExecutorSlot(task.id)) deps.options.semaphore?.release();
      throw new Error(message);
    }

    // Keep runtime plugin workflow step templates synchronized into TaskStore.
    // TaskStore resolves plugin-prefixed workflow IDs from this injected cache
    // to avoid a PluginLoader↔TaskStore circular dependency.
    const pluginWorkflowStepTemplates = deps.options.pluginRunner?.getPluginWorkflowStepTemplates() ?? [];
    deps.store.setPluginWorkflowStepTemplates(pluginWorkflowStepTemplates);

    // Read execution mode to determine whether to skip review and workflow steps
    const executionMode = task.executionMode ?? "standard";

    // Construct run context for mutation correlation
    // Use a synthetic correlation ID: task ID + timestamp + random suffix
    const syntheticRunId = generateSyntheticRunId("exec", task.id);
    deps.currentRunContexts.set(task.id, {
      runId: syntheticRunId,
      agentId: task.assignedAgentId ?? "executor",
    });

    // Build engine run context for audit instrumentation (FN-1404)
    const engineRunContext: EngineRunContext = {
      runId: syntheticRunId,
      agentId: task.assignedAgentId ?? "executor",
      taskId: task.id,
      phase: "execute",
    };

    // Create run auditor for TaskStore-backed audit emission (no-ops if store doesn't support it)
    const audit = createRunAuditor(deps.store, engineRunContext);

    // Stale spec enforcement: check if PROMPT.md has aged beyond the configured threshold.
    // When enabled, stale tasks are moved back to triage with status "needs-replan"
    // so they receive fresh specification before execution. This guard runs early in
    // execute() to prevent stale tasks from entering worktree creation or agent sessions.
    // If timestamp evaluation is skipped (missing/unreadable file), continue with execution
    // so existing filesystem validation paths remain authoritative.
    // Skip for tasks that are already in-progress, in-review, merging, or done —
    // these should not be interrupted and sent back to triage for re-planning.
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-21:40:
    THIS GUARD DID THE EXACT THING ITS OWN COMMENT SAYS IT MUST NOT.

    The comment directly above is explicit: skip for tasks already in-progress, in-review, merging or
    done, because "these should not be interrupted and sent back to triage for re-planning". Keyed on
    a hard-coded `Set`, a renamed board matched NOTHING, so `isActiveTask` was false for a card in a
    renamed wip/review/complete lane — the stale-spec guard then ran on a LIVE task and
    `moveTaskToReplanColumn` + `status: "needs-replan"` yanked it out of execution mid-flight.

    `activeMergeStatuses` still covers the merging states, so a merging card was protected by
    accident; a plain in-progress card was not.

    CENSUS-INVISIBLE: a `Set` literal is a definition, not a comparison, so nothing in the lifecycle
    backlog pointed here. Found by grepping for lane-shaped list literals.

    Resolved from the task's OWN workflow, unioned with the legacy trio for the reason documented on
    `resolveTerminalColumnsFor`: `resolveWorkflowIrForTask` returns the BUILT-IN IR rather than
    throwing when a definition is missing or corrupt, so a degraded resolution must not NARROW this
    set — narrowing it re-opens the interruption this fixes.
    */
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-16:10 (the arity trap, seventh site):
    MEMBERSHIP, not first-per-role. `activeColumns` is a `.has()` test, but was filled from
    `resolveLifecycleColumns`, which returns the FIRST column carrying each trait — so a workflow with two
    wip lanes, or a review lane plus a second merge-blocking one, had only one of each recognised as
    active. A card in the second read as INACTIVE and its prompt file was treated as reclaimable.

    The IR is already in hand one line up; `columnsWithFlag` returns every column carrying the trait.
    The legacy trio stays unioned in — this predicate is about liveness, and under-reporting active is
    the destructive direction.
    */
    const activeIr = await resolveWorkflowIrForTask(deps.store, task.id);
    const activeColumns = new Set<string>(["in-progress", "in-review", "done"]);
    if (activeIr) {
      for (const flag of ["countsTowardWip", "mergeOrchestration", "mergeBlocker", "humanReview", "complete"] as const) {
        for (const lane of columnsWithFlag(activeIr, flag)) activeColumns.add(lane);
      }
    }
    const activeMergeStatuses = new Set(["merging", "merging-pr", "merging-fix"]);
    const isActiveTask = activeColumns.has(task.column) || activeMergeStatuses.has(task.status ?? "");
    if (!isActiveTask) {
      const tasksDir = join(deps.store.getFusionDir(), "tasks");
      const promptPath = getPromptPath(tasksDir, task.id);
      const staleness = await evaluateSpecStaleness({
        settings,
        promptPath,
        task,
        /* FNXC:WorkflowLifecycleColumns 2026-07-30-12:40 (U11): one-line pass-through
           so the guard is driven rather than defaulted. Touches no executor logic. */
        plannerColumns: await resolveDedicatedPlannerColumnsForTask(deps.store, task.id),
      });
      if (staleness.isStale) {
        executorLog.warn(`Task ${task.id} specification is stale — ${staleness.reason}`);
        // Move to the workflow-aware replan column first, then set status so the task
        // enters it with needs-replan (workflows without "triage" replan in place in todo).
        await moveTaskToReplanColumn(deps.store, task);
        await deps.store.updateTask(task.id, { status: "needs-replan" });
        await deps.store.logEntry(task.id, staleness.reason, undefined, deps.getRunContextFor(task.id));
        // FNXC:GlobalConcurrencyControls 2026-07-15-02:55: replan handoff never starts agent work — free any re-registered pre-held slot before leaving execute().
        if (dropPreHeldExecutorSlot(task.id)) deps.options.semaphore?.release();
        return;
      }
    }

    // Drift detection: a task that is already in-progress (i.e. we're not
    // dispatching it fresh from todo) should always carry a `worktree`. If it
    // doesn't, some prior update — most likely a partial pause/abort sequence
    // where updateTask({ worktree: null }) succeeded but the subsequent
    // moveTask()/status write failed — left the row in a half-state. The
    // executor can still recover by falling through to the fresh-worktree
    // path below, but we emit a loud audit record so these states stop being
    // silent.
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet: execute() preflight): THREE DRIFT CHECKS, ONE
    SNAPSHOT — merge-confirmed while still executing, stale mergeDetails, and in-wip with no worktree. None
    fired on a renamed board, so every recovery they perform silently stopped happening. The third one's own
    message says it "usually indicates a partial updateTask/moveTask sequence failed" — a diagnostic that
    could never print on a renamed board.
    */
    const preflightWipLane = (await deps.resolveResumeLanes(task.id)).wip;
    if (task.column === preflightWipLane && task.mergeDetails?.mergeConfirmed === true) {
      if (await deps.finalizeMergeConfirmedWorkflowGraphTask(task.id, "execute-preflight")) {
        deps.executing.delete(task.id);
        executingTaskLock.release(task.id);
        if (dropPreHeldExecutorSlot(task.id)) deps.options.semaphore?.release();
        return;
      }
    }

    if (task.column === preflightWipLane && task.mergeDetails) {
      executorLog.warn(`${task.id}: stale mergeDetails found while executing in-progress task — resetting merge state before continuing`);
      task = await deps.cleanupMergeStateForReverification(
        task,
        "Executor detected stale merge state while task was in-progress — reset verification steps and merge metadata before resuming",
      );
    }

    if (task.column === preflightWipLane && !task.worktree && !externalExecutionRoute.configured) {
      executorLog.error(
        `${task.id}: drift detected — task is in-progress with no worktree. ` +
          `Recovering by creating a fresh worktree. This usually indicates a partial ` +
          `updateTask/moveTask sequence failed somewhere upstream.`,
      );
      await deps.store.logEntry(
        task.id,
        "Drift detected: in-progress with no worktree — creating fresh worktree to recover",
        undefined,
        deps.getRunContextFor(task.id),
      );
    }

    // Hoist worktreePath so it's accessible in the catch block for dep-abort cleanup
    let worktreePath = externalExecutionRoute.configured
      ? externalExecutionRoute.checkoutPath ?? ""
      : task.worktree ?? "";

    // Set by stuck-abort handlers; the actual moveTask("todo") is deferred to
    // the finally block so deps.executing is cleared first (prevents re-dispatch race).
    // true = requeue to todo, false = budget exhausted (already marked failed).
    let stuckRequeue: boolean | null = null;
    let staleAssistantContinuationRequeue = false;
    let taskDone = false;
    let reviewAddressingActivated = false;
    let taskEnv: NodeJS.ProcessEnv | undefined;

    try {
      await deps.transitionReviewAddressing(task.id, ["queued"], "in-progress");
      reviewAddressingActivated = true;
      // Check dependencies
      const allTasks = await deps.store.listTasks({ slim: true, includeArchived: false });
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (batch-engine — dependency satisfaction, per DEPENDENCY):
      Resolved from each DEPENDENCY's own workflow, not this task's: dependencies routinely span workflows,
      so asking "is my blocker finished?" against the blocked task's vocabulary is the wrong question. That
      is the answer main settled on in `branch-group-ops.ts` (#2720) and it is reused here rather than
      re-derived.

      MEMBERSHIP and unioned with the legacy trio, because a workflow may declare more than one complete or
      review lane and `resolveWorkflowIrForTask` yields the BUILT-IN IR for a missing workflow rather than
      throwing — without the union a degraded renamed board treats a finished blocker as unmet and the
      dependent never runs.

      NOTE the set is wider than the terminal pair: this guard has always counted `in-review` as satisfying
      a dependency, so the review role is included. Narrowing it to terminal-only would be a behaviour
      change, not a conversion.
      */
      const depIrCache = new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>();
      const satisfiedByDep = new Map<string, ReadonlySet<string>>();
      for (const depId of task.dependencies) {
        if (satisfiedByDep.has(depId)) continue;
        const satisfied = new Set<string>(["done", "in-review", "archived"]);
        try {
          const depIr = await resolveWorkflowIrForTask(deps.store, depId, depIrCache);
          if (depIr) {
            for (const flag of ["complete", "archived", "mergeOrchestration", "mergeBlocker", "humanReview"] as const) {
              for (const id of columnsWithFlag(depIr, flag)) satisfied.add(id);
            }
          }
        } catch { /* degraded: the legacy trio */ }
        satisfiedByDep.set(depId, satisfied);
      }
      const unmetDeps = task.dependencies.filter((depId) => {
        const dep = allTasks.find((t) => t.id === depId);
        return dep !== undefined && !satisfiedByDep.get(depId)!.has(dep.column);
      });

      if (unmetDeps.length > 0) {
        executorLog.log(`${task.id} blocked by: ${unmetDeps.join(", ")} — deferring`);
        return;
      }

      if (deps.workspaceConfig === undefined) {
        deps.workspaceConfig = await loadWorkspaceConfig(deps.rootDir);
      }
      /*
      FNXC:Workspace 2026-06-22-00:00:
      Workspace mode is only meaningful with at least one usable sub-repo. An empty `{ repos: [] }`
      must NOT bypass the git-repository guard, inject workspace instructions, or expose the
      workspace tool — otherwise a non-git directory with an empty config would skip validation
      and enable a workspace with nothing to work on. Gate every workspace check on repos.length > 0.
      */
      const hasWorkspaceRepos = (deps.workspaceConfig?.repos.length ?? 0) > 0;
      if (!hasWorkspaceRepos) {
        const gitDetection = await detectGitRepository(deps.rootDir);
        if (gitDetection.status === "not-repo") {
          await deps.store.logEntry(
            task.id,
            "Cannot execute task: project directory is not a Git repository. Fusion requires a Git repository for worktree-based task execution.",
          );
          throw new Error(
            "Project directory is not a Git repository. Fusion requires a Git repository for worktree creation. Initialize with 'git init' or run from a Git project directory.",
          );
        }
        if (gitDetection.status === "error") {
          /*
          FNXC:Worktree 2026-07-10-00:00:
          FN-7799 requires environmental Git probe failures in valid repos to surface the real cause instead of telling operators to run `git init`. Dubious ownership and similar persistent failures otherwise block every task across restarts with a false non-repo diagnosis.
          */
          const message = formatGitRepositoryDetectionError(deps.rootDir, gitDetection);
          await deps.store.logEntry(task.id, message);
          throw new Error(message);
        }
      }

      const hadAssignedWorktree = Boolean(task.worktree) || externalExecutionRoute.configured;
      const taskCommandAbortController = new AbortController();
      deps.registerConfiguredCommandController(task.id, taskCommandAbortController);
      /*
      FNXC:Workspace 2026-06-21-12:00:
      KTD1 — in workspace mode `deps.rootDir` is a NON-git parent. Acquiring a root worktree there fails. Skip root acquisition entirely and run the agent session rooted at the browse-only workspace root; the agent acquires per-sub-repo worktrees on demand via fn_acquire_repo_worktree. `task.worktree` stays unset. We synthesize a non-fresh, non-resume acquisition with an empty branch so the downstream env-injection/onStart bookkeeping runs unchanged while every rootDir git preflight (base capture, contamination, liveness) is gated off below. The non-workspace branch is byte-for-byte the original acquisition path.

      FNXC:ExternalExecutionCheckout 2026-08-09-23:53:
      Operator-routed external checkouts skip Fusion worktree acquisition and run against the persisted checkout.
      */
      const acquisition: AcquireTaskWorktreeResult = deps.workspaceConfig
        ? {
            worktreePath: deps.rootDir,
            branch: "",
            source: "existing",
            hydrated: true,
            isResume: Boolean(task.sessionFile),
          }
        : externalExecutionRoute.configured
          ? {
              worktreePath: externalExecutionRoute.checkoutPath ?? "",
              branch: externalExecutionRoute.branch ?? "",
              source: "existing",
              hydrated: true,
              isResume: Boolean(task.sessionFile),
            }
        : await (async () => {
        try {
          return await acquireTaskWorktree({
            task,
            rootDir: deps.rootDir,
            store: deps.store,
            settings,
            pool: deps.options.pool,
            logger: executorLog,
            audit,
            runContext: deps.getRunContextFor(task.id),
            runInitCommand: true,
            createWorktree: deps.createWorktree,
            // FNXC:WorktreeAcquisition 2026-08-09-03:30: This injected creator is native even when project settings
            // prefer Worktrunk; retain its actual backend so stale-base refresh remains enabled on creation and reuse.
            createWorktreeBackendKind: "native",
            runConfiguredCommand: (command, cwd, timeoutMs, env) =>
              runConfiguredCommand(
                command,
                cwd,
                timeoutMs,
                env,
                audit,
                taskCommandAbortController.signal,
              ).then((result) => {
                if (taskCommandAbortController.signal.aborted) {
                  throw createConfiguredCommandAbortError(task.id, command);
                }
                return result;
              }),
            taskEnv,
            secretsStore: deps.options.secretsStore,
            refreshStaleBase: true,
          });
        } finally {
          deps.unregisterConfiguredCommandController(task.id, taskCommandAbortController);
        }
      })();
      worktreePath = acquisition.worktreePath;

      if (acquisition.reclaimed) {
        await audit.git({
          type: "branch:auto-reclaim",
          target: acquisition.branch,
          metadata: {
            taskId: task.id,
            branch: acquisition.branch,
            worktreePath: acquisition.worktreePath,
            existingTipSha: acquisition.reclaimed.existingTipSha,
            strandedCommitCount: acquisition.reclaimed.strandedCommitCount ?? 0,
            trigger: "dispatch-preflight",
          },
        });
      }

      if (!acquisition.isResume && acquisition.source === "fresh" && settings.setupScript) {
        const scriptCommand = settings.scripts?.[settings.setupScript];
        if (scriptCommand) {
          const setupStartedAt = Date.now();
          const setupAbortController = new AbortController();
          deps.registerConfiguredCommandController(task.id, setupAbortController);
          try {
            const setupResult = await runConfiguredCommand(
              scriptCommand,
              worktreePath,
              120_000,
              taskEnv,
              audit,
              setupAbortController.signal,
            );
            if (setupAbortController.signal.aborted) {
              throw createConfiguredCommandAbortError(task.id, scriptCommand);
            }
            if (setupResult.spawnError || setupResult.timedOut || setupResult.exitCode !== 0) {
              throw new Error(configuredCommandErrorMessage(setupResult));
            }
            await deps.store.logEntry(task.id, `[timing] Setup script '${settings.setupScript}' completed in ${Date.now() - setupStartedAt}ms`, scriptCommand, deps.getRunContextFor(task.id));
          } catch (err: unknown) {
            if (err instanceof Error && err.name === "AbortError") {
              throw err;
            }
            const execError = err instanceof Error ? err : new Error(String(err));
            const message = "stderr" in execError && typeof (execError as Record<string, unknown>).stderr === "string"
              ? String((execError as Record<string, unknown>).stderr)
              : execError.message;
            await deps.store.logEntry(task.id, `Setup script '${settings.setupScript}' failed: ${message}`, undefined, deps.getRunContextFor(task.id));
          } finally {
            deps.unregisterConfiguredCommandController(task.id, setupAbortController);
          }
        } else {
          await deps.store.logEntry(task.id, `Setup script '${settings.setupScript}' not found in scripts map — skipping`, undefined, deps.getRunContextFor(task.id));
        }
      }

      /*
      FNXC:Workspace 2026-06-21-12:00:
      KTD1 — every preflight below (base-commit capture, contamination check, worktree-liveness gate) runs git against `worktreePath`, which equals the non-git workspace root in workspace mode. They would all fail. Gate the whole block off in workspace mode; the per-repo equivalents return in Phase B (master U3) against each acquired sub-repo worktree. The non-workspace branch is unchanged.
      */
      if (!deps.workspaceConfig) {
      // Capture the base commit SHA for diff computation whenever a task
      // starts with a newly assigned worktree.
      if (!acquisition.isResume) {
        await captureBaseCommitSha(deps.store, task, worktreePath, audit, { isResume: false });
      }

      // Contamination check must use a FRESH merge-base with the integration
      // branch — NOT task.baseCommitSha. baseCommitSha is intentionally
      // preserved across sessions for stable diff math, which makes it
      // potentially stale relative to main. Using it here would falsely flag
      // every legitimately-merged commit on main since that stale SHA as
      // "foreign contamination" (see FN-4417). The real signal we want is:
      // does the branch contain commits past its current merge-base with main
      // that are attributed to OTHER tasks? Compute the merge-base fresh.
      const contaminationBaseRef = await resolveContaminationBaseRef(worktreePath);
      if (contaminationBaseRef) {
        try {
          await assertCleanBranchAtBase(deps.rootDir, acquisition.branch, contaminationBaseRef, task.id);
        } catch (contaminationError: unknown) {
          if (!(contaminationError instanceof BranchCrossContaminationError)) {
            throw contaminationError;
          }
          const recovered = await deps.tryBootstrapMisbindingRecovery(task, contaminationError, audit);
          if (recovered) {
            return;
          }
          throw contaminationError;
        }
      }

      const expectedRoot = canonicalizePath(deps.rootDir);
      let observedWorktreeRealpath: string;
      let livenessFailure: string | null = null;
      try {
        observedWorktreeRealpath = canonicalizePath(worktreePath);
        if (observedWorktreeRealpath === expectedRoot) {
          livenessFailure = "realpath_matches_repo_root";
        }
      } catch (error) {
        observedWorktreeRealpath = `unresolvable:${worktreePath}`;
        livenessFailure = `unresolvable_worktree:${error instanceof Error ? error.message : String(error)}`;
      }

      if (!livenessFailure && !isInsideWorktreesDir(deps.rootDir, worktreePath, settings)) {
        livenessFailure = "outside_worktrees_dir";
      }

      let livenessFailureReason: string | null = null;
      let livenessClassification: string | null = null;
      const shouldGate = acquisition.isResume || (hadAssignedWorktree && !task.sessionFile && acquisition.source !== "fresh");
      if (!livenessFailure && shouldGate) {
        const classification = await classifyTaskWorktree(deps.rootDir, worktreePath);
        if (!classification.ok) {
          const reanchor = await detectNestedWorktreeRoot(deps.rootDir, worktreePath, settings);
          if (reanchor.reanchored) {
            await deps.store.updateTask(task.id, { worktree: reanchor.root });
            await deps.store.logEntry(task.id, `Re-anchored nested task.worktree from ${worktreePath} to ${reanchor.root}`, undefined, deps.getRunContextFor(task.id));
            await deps.emitWorktreeReanchoredAudit(task.id, worktreePath, reanchor.root, "executor-liveness-gate");
            worktreePath = reanchor.root;
            observedWorktreeRealpath = canonicalizePath(reanchor.root);
          } else {
            livenessClassification = classification.classification;
            livenessFailureReason = classification.reason;
            livenessFailure = `not_usable_task_worktree:${classification.classification}`;
          }
        }
      }

      if (livenessFailure) {
        const expected = `${resolveWorktreesDir(deps.rootDir, settings)}/* (usable, registered)`;
        const observed = `${worktreePath} (${observedWorktreeRealpath})`;
        let registeredPaths: string[] = [];
        try {
          const registeredSnapshot = await describeRegisteredWorktrees(deps.rootDir);
          registeredPaths = registeredSnapshot.canonicalized;
        } catch {
          registeredPaths = [];
        }
        const visibleRegistered = registeredPaths.slice(0, 10);
        const registeredSuffix = registeredPaths.length > 10
          ? `, … +${registeredPaths.length - 10} more`
          : "";
        const registeredSection = ` — registered=[${visibleRegistered.join(", ")}${registeredSuffix}]`;
        const reasonSection = livenessFailureReason ? ` (${livenessFailureReason})` : "";
        const failureMessage = `worktree liveness assertion failed: ${livenessFailure}${reasonSection} — observed=${observed}, expected=${expected}${registeredSection}`;
        executorLog.error(`${task.id}: ${failureMessage}`);
        await deps.store.logEntry(task.id, failureMessage, undefined, deps.getRunContextFor(task.id));

        const priorRequeues = task.taskDoneRetryCount ?? 0;
        const nextRequeueCount = priorRequeues + 1;
        const terminalAction = priorRequeues < MAX_TASK_DONE_REQUEUE_RETRIES ? "requeue-todo" : "park-in-review";
        const isRepoRootCollision = livenessFailure === "realpath_matches_repo_root";
        const auditClassification = livenessClassification ?? (isRepoRootCollision ? "repo-root" : null);
        const auditReason = livenessFailureReason ?? (isRepoRootCollision ? "worktree path realpath matches the project root, not a task worktree" : null);
        /*
         * FNXC:WorktreeLiveness 2026-06-21-11:10:
         * The executor still keeps the repo-root realpath check as defense in depth. If acquisition ever hands the root to this gate, emit structured evidence that separates the invalid checkout path from the normal git registered-worktree snapshot and the configured task-worktree pattern.
         */
        if (auditClassification) {
          const registeredContainsObserved = registeredPaths.includes(observedWorktreeRealpath);
          await audit.git({
            type: "worktree:incomplete-detected",
            target: worktreePath,
            metadata: {
              classification: auditClassification,
              reason: auditReason ?? undefined,
              source: "executor-liveness-gate",
              taskId: task.id,
              retryCount: nextRequeueCount,
              maxRetries: MAX_TASK_DONE_REQUEUE_RETRIES,
              terminalAction,
              observed: worktreePath,
              observedRealpath: observedWorktreeRealpath,
              expected,
              registered: visibleRegistered,
              registeredTotal: registeredPaths.length,
              registeredContainsObserved,
              invalidCheckoutPath: isRepoRootCollision ? "repo-root" : undefined,
              expectedPatternExcludesRepoRoot: isRepoRootCollision,
            },
          });
        }

        if (priorRequeues < MAX_TASK_DONE_REQUEUE_RETRIES) {
          await deps.store.updateTask(task.id, {
            status: "queued",
            error: null,
            worktree: null,
            branch: null,
            sessionFile: null,
            taskDoneRetryCount: nextRequeueCount,
            paused: false,
            pausedByAgentId: null,
          });
          await deps.store.logEntry(
            task.id,
            `${failureMessage} — requeued to todo immediately (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`,
            undefined,
            deps.getRunContextFor(task.id),
          );
          deps.markGraphExecuteSelfRequeued(task.id);
          await deps.store.moveTask(task.id, await resolveReboundColumnFor(deps.store, task.id), { preserveProgress: true });
          executorLog.log(`✗ ${task.id} worktree liveness failed — requeued to todo (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`);
        } else {
          await deps.store.updateTask(task.id, {
            status: "failed",
            error: failureMessage,
            worktree: null,
            branch: null,
            sessionFile: null,
            paused: false,
            pausedByAgentId: null,
          });
          await deps.store.logEntry(task.id, `${failureMessage} — execution failed after worktree liveness retry budget was exhausted`, undefined, deps.getRunContextFor(task.id));
          await deps.persistTokenUsage(task.id);
          executorLog.log(`✗ ${task.id} worktree liveness failed`);
        }
        deps.options.onError?.(task, new Error(failureMessage));
        return;
      }
      } // end !deps.workspaceConfig preflight gate (FNXC:Workspace KTD1)

      // FNXC:Workspace 2026-06-21-12:00: KTD2 — register the worktree path under the task's Set. In workspace mode `worktreePath` is the browse-only root; per-repo sub-repo worktree paths ARE now added to the same Set as the agent acquires them (F2: fn_acquire_repo_worktree's onAcquired callback → addActiveWorktree), so the Set holds root + N sub-repo paths, not just the root. Non-workspace tasks add exactly one path → a one-element set (unchanged liveness/owner semantics).
      deps.addActiveWorktree(task.id, worktreePath);
      executorLog.debug(`${task.id}: worktree ready at ${worktreePath}`);

      const injected = await deps.buildInjectedRuntimeEnv(task.id, worktreePath, acquisition.branch ?? undefined);
      taskEnv = injected.env;
      // FNXC:EngineDiagnostics 2026-08-03-05:54: env injection counts are session setup, not operator state changes.
      executorLog.debug(`${task.id}: executor runtime env injected (${injected.pathEntryCount} PATH entries, ${injected.injectedKeyCount} env keys)`);

      deps.options.onStart?.(task, worktreePath);

      const detail = await deps.store.getTask(task.id);
      executorLog.debug(`${task.id}: fetched task detail (${detail.steps.length} steps, prompt length=${detail.prompt?.length ?? 0})`);

      // Initialize steps from PROMPT.md if empty
      if (detail.steps.length === 0) {
        const steps = await deps.store.parseStepsFromPrompt(task.id);
        if (steps.length > 0) {
          await deps.store.updateStep(task.id, 0, "pending");
        }
      }

      // On resume (task.branch already set from a prior run), reconcile step
      // statuses from git history so the agent doesn't redo already-committed work.
      if (acquisition.isResume && task.branch && detail.steps.length > 0) {
        await deps.reconcileStepsFromGitHistory(task.id, detail, worktreePath);
      }

      // ── Step-Session vs Single-Session execution path ──
      // When runStepsInNewSessions is enabled, each step runs in its own
      // fresh agent session via StepSessionExecutor. Otherwise, the existing
      // single-session flow runs all steps in one monolithic session.

      // Build skill selection context early so it's available in both paths
      const skillContext = await buildSessionSkillContext({
        agentStore: deps.options.agentStore!,
        task: detail,
        sessionPurpose: "executor",
        projectRootDir: deps.rootDir,
        pluginRunner: deps.options.pluginRunner,
      });
      const graphSeamSkillName = deps.graphSeamSkillName.get(task.id);
      const ceSkillsDir = typeof taskEnv?.FUSION_CE_SKILLS_DIR === "string" && taskEnv.FUSION_CE_SKILLS_DIR.trim()
        ? taskEnv.FUSION_CE_SKILLS_DIR.trim()
        : typeof process.env.FUSION_CE_SKILLS_DIR === "string" && process.env.FUSION_CE_SKILLS_DIR.trim()
          ? process.env.FUSION_CE_SKILLS_DIR.trim()
          : undefined;
      let stepSessionSkillSelection = skillContext.skillSelectionContext;
      if (graphSeamSkillName) {
        const bare = graphSeamSkillName.includes(":")
          ? graphSeamSkillName.slice(graphSeamSkillName.lastIndexOf(":") + 1)
          : graphSeamSkillName;
        const existing = stepSessionSkillSelection?.requestedSkillNames ?? [];
        stepSessionSkillSelection = {
          projectRootDir: stepSessionSkillSelection?.projectRootDir ?? deps.rootDir,
          ...(stepSessionSkillSelection?.sessionPurpose
            ? { sessionPurpose: stepSessionSkillSelection.sessionPurpose }
            : { sessionPurpose: "executor" }),
          requestedSkillNames: [...new Set([...existing, graphSeamSkillName, bare])],
        };
      }
      const stepSessionAdditionalSkillPaths = mergeAdditionalSkillPaths(
        skillContext.additionalSkillPaths,
        graphSeamSkillName && ceSkillsDir ? [ceSkillsDir] : undefined,
      );
      if (
        graphSeamSkillName
        && !isWorkflowStepSkillDiscoverable(graphSeamSkillName, stepSessionAdditionalSkillPaths, ceSkillsDir)
      ) {
        await deps.store.logEntry(
          task.id,
          `[skill-load] Foreach step-execute requests skill '${graphSeamSkillName}' but it cannot be discovered from configured plugin body directories or FUSION_CE_SKILLS_DIR; the step runs with role-fallback skills only.`,
        );
      }

      // Graph-owned stepwise runs force step-session physics for the run (KTD-2/
      // KTD-8): the discrete per-step boundary the foreach driver needs exists only
      // in StepSessionExecutor. Pinned per run so a mid-flight setting toggle never
      // selects the unsupported (graph ON × step-sessions OFF) combination.
      const forceStepSession = deps.graphStepSessionPinned.has(task.id);
      if (settings.runStepsInNewSessions || forceStepSession) {
        // ── Step-Session Path ──────────────────────────────────────────
        executorLog.debug(`${task.id}: using step-session mode (maxParallel=${settings.maxParallelSteps ?? 2}${forceStepSession ? ", graph-pinned" : ""})`);

        const stepSessionAgent = await deps.getAuthoritativeAssignedAgent(detail.assignedAgentId);

        // Column-agent SESSION IDENTITY (U4, R2/R3/R4/R8): when the governing
        // step-execute node's declared column binds an agent that supersedes the
        // task's assigned agent, the per-step session's MODEL, runtime hint, and
        // attribution adopt the column agent. The core resolver decides defer vs
        // override (KTD-2); a missing agent logs + falls back (R8). Principal
        // alignment (U5, R5/R6): the gating contexts below ALSO key off the
        // effective `stepIdentityAgent`, and the effective principal is tracked for
        // the reverse-direction heartbeat guard.
        const stepColumnAgent = await deps.resolveSeamColumnAgent(task, detail);
        const stepIdentityAgent = stepColumnAgent?.agent ?? stepSessionAgent;
        // U5 (R6): track the effective column-agent principal so the heartbeat
        // scheduler's reverse guard knows this agent is executing a task it may not
        // be assigned to. Cleared in deleteActiveStepExecutor.
        if (stepColumnAgent?.agent) {
          deps.effectiveColumnAgentByTask.set(task.id, stepColumnAgent.agent.id);
        }
        const stepSessionRuntimeHint = extractRuntimeHint(stepIdentityAgent?.runtimeConfig);

        let accumulatedStepTokenUsage = detail.tokenUsage;
        const tokenUsageRecordedSteps = new Set<number>();
        let stepRotationEvent: import("../credential-instance-rotation.js").RotationEvent | undefined;
        let stepRotationDeclined = false;
        let stepDispatchedRotation = false;
        const initialStepSessionModel = resolveExecutorSessionModel(
          detail.modelProvider,
          detail.modelId,
          settings,
          (stepIdentityAgent?.runtimeConfig ?? undefined) as Record<string, unknown> | undefined,
          detail.credentialInstanceId ?? undefined,
        );
        let activeStepInstanceRef: ProviderInstanceRef | undefined = initialStepSessionModel.provider
          ? {
              providerId: initialStepSessionModel.provider,
              instanceId: initialStepSessionModel.credentialInstanceId ?? DEFAULT_PROVIDER_INSTANCE_ID,
            }
          : undefined;
        const stepExecutorRef: { current?: StepSessionExecutor } = {};
        const nextStepInstance = async (): Promise<ProviderInstanceRef | undefined> => {
          /*
          FNXC:CredentialInstanceRotation 2026-08-01-11:22:
          Executor-step retries refresh task and project pause state at the limit
          boundary, rather than trusting dispatch snapshots. A pause arriving while
          a session is in flight must prevent an autonomous billed-account switch.
          */
          const [liveTask, liveSettings] = await Promise.all([
            deps.store.getTask(task.id).catch(() => undefined),
            deps.store.getSettings().catch(() => settings),
          ]);
          if (stepRotationDeclined || deps.pausedAborted.has(task.id) || !liveTask
            || liveTask.userPaused === true || liveTask.autoMerge === false
            || liveSettings.globalPause === true || liveSettings.enginePaused === true
            || !activeStepInstanceRef?.providerId) return undefined;
          stepRotationEvent ??= await deps.options.credentialRotator?.beginEvent({
            providerId: activeStepInstanceRef.providerId,
            startingInstanceId: activeStepInstanceRef.instanceId,
            lane: "executor-step",
            taskId: task.id,
          });
          if (!stepRotationEvent) { stepRotationDeclined = true; return undefined; }
          // FNXC:CredentialInstanceRotation 2026-08-01-11:34: beginEvent awaits credential inventory, so repeat the human-control check after it resolves. A pause that races this await must prevent cooldown writes and credential dispatch.
          const [postInventoryTask, postInventorySettings] = await Promise.all([
            deps.store.getTask(task.id).catch(() => undefined),
            deps.store.getSettings().catch(() => settings),
          ]);
          if (deps.pausedAborted.has(task.id) || !postInventoryTask
            || postInventoryTask.userPaused === true || postInventoryTask.autoMerge === false
            || postInventorySettings.globalPause === true || postInventorySettings.enginePaused === true) return undefined;
          deps.options.credentialRotator?.markLimited(activeStepInstanceRef);
          if (stepDispatchedRotation) stepRotationEvent.recordOutcome("rotation-failed-limit");
          const next = await stepRotationEvent.next();
          if (!next) { stepRotationEvent.finishExhausted(); return undefined; }
          activeStepInstanceRef = next;
          stepDispatchedRotation = true;
          await stepExecutorRef.current?.retargetCredentialInstance(next);
          return next;
        };
        /*
        FNXC:WorkflowStepControl 2026-06-29-10:15:
        Graph-pinned step sessions are lifecycle-owned by the workflow graph, not by the legacy executor prompt/tools. Their callback projection must use source:"graph" so independent steps can finish out of index order and so duplicate graph runner writes do not trigger the legacy sequential fn_task_update guard.
        */
        const stepProjectionOptions = forceStepSession ? { source: "graph" as const } : undefined;

        const stepExecutor = new StepSessionExecutor({
          store: deps.store,
          taskDetail: detail,
          worktreePath,
          rootDir: deps.rootDir,
          settings,
          // FNXC:GlobalConcurrencyControls 2026-07-14-18:30: When the graph run already owns a top-level slot (outerConcurrencyClaims), do not pass the semaphore into per-step sessions — each step would acquire a second slot and can deadlock under a full global cap.
          semaphore: deps.outerConcurrencyClaims.has(task.id) ? undefined : deps.options.semaphore,
          stuckTaskDetector: deps.options.stuckTaskDetector,
          pluginRunner: deps.options.pluginRunner,
          runtimeHint: stepSessionRuntimeHint,
          assignedAgentRuntimeConfig: (stepIdentityAgent?.runtimeConfig ?? undefined) as Record<string, unknown> | undefined,
          /*
           * FNXC:CredentialInstanceRotation 2026-08-01-10:41:
           * Step sessions must start on the task-selected account. On a usage-limit
           * retry, re-read the live selection and resolve its provider with the same
           * effective column-agent runtime config used to create the session.
           */
          credentialInstanceId: detail.credentialInstanceId,
          resolveCredentialInstanceRetarget: nextStepInstance,
          // Attribute the per-step run auditor to the column agent when it governs
          // (U4); absent → StepSessionExecutor falls back to assignedAgentId.
          effectiveAgentId: stepColumnAgent?.agent.id,
          actionGateContext: deps.buildActionGateContext(task.id, stepIdentityAgent, settings.defaultAgentPermissionPolicy),
          permanentAgentGating: deps.buildPermanentAgentGatingContext(task.id, stepIdentityAgent, settings.defaultAgentPermissionPolicy),
          // FNXC:McpConfig 2026-06-25-23:03: Per-step workflow sessions are an executor lane, so they inherit the task's resolved MCP set from the effective step identity agent and never re-read or log plaintext secret values.
          mcpServers: await deps.resolveMcpServers(stepIdentityAgent?.id),
          workflowStepThinkingLevel: deps.graphSeamThinkingLevel.get(task.id) as string | undefined,
          // FNXC:PluginSkills 2026-07-12-00:00: Step sessions must forward plugin skill body dirs alongside requested names; otherwise plugin-provided SKILL.md bodies are invisible to the inner createFnAgent loader.
          skillSelection: stepSessionSkillSelection,
          additionalSkillPaths: stepSessionAdditionalSkillPaths,
          // Pass agentStore and messageStore for delegation and messaging tools
          agentStore: deps.options.agentStore,
          messageStore: deps.options.messageStore,
          callerIsEphemeral: !stepIdentityAgent || isEphemeralAgent(stepIdentityAgent),
          sourceTaskId: task.id,
          sourceAgentId: stepIdentityAgent?.id,
          taskEnv,
          // FNXC:StepLifecycle 2026-07-22-09:53: Await the dependency-aware store projection before session allocation so a rejected out-of-order start cannot execute while its persisted step remains pending.
          onStepStart: async (stepIndex) => {
            try {
              const startResult = await deps.store.startStep(
                task.id,
                stepIndex,
                stepProjectionOptions,
              );
              if (!startResult.accepted) {
                executorLog.warn(
                  `${task.id}: step ${stepIndex} start was rejected (${startResult.disposition}); persisted status is ` +
                  `${startResult.task.steps?.[stepIndex]?.status ?? "missing"}`,
                );
                return false;
              }
              deps.options.stuckTaskDetector?.recordProgress(task.id);
            } catch (err) {
              executorLog.warn(`${task.id}: failed to update step ${stepIndex} status to in-progress: ${err}`);
              return false;
            }
          },
          onStepComplete: (stepIndex, result) => {
            // FNXC:EngineDiagnostics 2026-07-26-10:05: per-step success is expected bookkeeping (incl. foreach instances); failures stay at log.
            if (result.success) {
              executorLog.debug(`${task.id}: step ${stepIndex} succeeded (${result.retries} retries)`);
            } else {
              executorLog.log(`${task.id}: step ${stepIndex} failed (${result.retries} retries)`);
            }
            try {
              deps.store.updateStep(task.id, stepIndex, result.success ? "done" : "skipped", stepProjectionOptions).catch((err) => {
                executorLog.warn(`${task.id}: failed to update step ${stepIndex} status: ${err}`);
              });
              const safeReason = result.success ? undefined : sanitizeFailureReason(result.error);
              if (!result.success) {
                void emitProactiveStatus(
                  deps.store,
                  task.id,
                  buildStepFailureMessage(stepIndex, detail.steps[stepIndex]?.name, safeReason!),
                  "executor",
                  safeReason,
                );
              }
            } catch (err) {
              executorLog.warn(`${task.id}: failed to update step ${stepIndex} status: ${err}`);
            }

            if (!result.tokenUsage) {
              return;
            }

            const previousStepTokenUsage = accumulatedStepTokenUsage;
            accumulatedStepTokenUsage = accumulateTokenUsageImpl(accumulatedStepTokenUsage, result.tokenUsage);
            if (accumulatedStepTokenUsage) {
              // FNXC:TokenAnalytics 2026-06-19-15:55: Step-scoped token writes now carry the producing session model so workflow-step sessions contribute their exact deltas to per-model analytics instead of relying on the last central session snapshot.
              accumulatedStepTokenUsage = tokenUsageWithModelSnapshotImpl(accumulatedStepTokenUsage, undefined, previousStepTokenUsage, result.tokenUsage, accumulatedStepTokenUsage.lastUsedAt, { provider: result.tokenUsage.modelProvider, id: result.tokenUsage.modelId });
            }
            tokenUsageRecordedSteps.add(stepIndex);
            if (!accumulatedStepTokenUsage) {
              return;
            }

            deps.persistTaskTokenUsage(task.id, accumulatedStepTokenUsage).catch((err: unknown) => {
              executorLog.warn(`${task.id}: failed to persist token usage on step ${stepIndex} complete: ${err}`);
            });
          },
        });
        stepExecutorRef.current = stepExecutor;
        deps.setActiveStepExecutor(task.id, stepExecutor, worktreePath, createSeenSteeringIds(detail));

        const stepWork = async () => {
          const results = await stepExecutor.executeAll();

          // Check abort conditions after execution completes
          if (deps.depAborted.has(task.id)) {
            deps.depAborted.delete(task.id);
            await deps.handleDepAbortCleanup(task.id, worktreePath);
            return;
          }
          if (deps.pausedAborted.has(task.id)) {
            if (deps.userCanceledTaskIds.has(task.id)) {
              deps.clearPausedAborted(task.id);
              deps.stuckAborted.delete(task.id);
              deps.userCanceledTaskIds.delete(task.id);
              await deps.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
              return;
            }
            if (await deps.parkApprovalSuspension(task.id, "step sessions")) return;
            deps.clearPausedAborted(task.id);
            await deps.store.logEntry(task.id, "Execution paused — step sessions terminated, moved to todo", undefined, deps.getRunContextFor(task.id));
            deps.markGraphExecuteSelfRequeued(task.id);
            await deps.store.moveTask(task.id, await resolveReboundColumnFor(deps.store, task.id), { preserveResumeState: true });
            return;
          }
          if (deps.stuckAborted.has(task.id)) {
            stuckRequeue = deps.stuckAborted.get(task.id) ?? true;
            deps.stuckAborted.delete(task.id);
            return;
          }

          for (const result of results) {
            if (!result.tokenUsage || tokenUsageRecordedSteps.has(result.stepIndex)) {
              continue;
            }
            const previousStepTokenUsage = accumulatedStepTokenUsage;
            accumulatedStepTokenUsage = accumulateTokenUsageImpl(accumulatedStepTokenUsage, result.tokenUsage);
            if (accumulatedStepTokenUsage) {
              accumulatedStepTokenUsage = tokenUsageWithModelSnapshotImpl(accumulatedStepTokenUsage, undefined, previousStepTokenUsage, result.tokenUsage, accumulatedStepTokenUsage.lastUsedAt, { provider: result.tokenUsage.modelProvider, id: result.tokenUsage.modelId });
            }
          }

          if (accumulatedStepTokenUsage) {
            await deps.persistTaskTokenUsage(task.id, accumulatedStepTokenUsage);
          }

          const allSuccess = results.every(r => r.success);
          if (allSuccess) {
            const updatedTask = await deps.store.getTask(task.id);
            // FNXC:Workspace 2026-06-21-23:30: KTD1 — per-repo post-session capture.
            // The singular call below runs UNGATED with worktreePath = the browse-only non-git workspace root and silently returns [] (resolveDiffBaseRef swallows the git failure at the root). In workspace mode there is nothing to diff at the root; the real changes live in each acquired sub-repo worktree. So we ADD (not replace) a workspace branch that loops `task.workspaceWorktrees` and reuses the EXISTING captureModifiedFiles per repo — reusing it (rather than hand-building `git diff <base>..HEAD`) gives us the merge-base fallback for an undefined repo.baseCommitSha (resolveDiffBaseRef) AND restores the contamination/divergence audit (filterFilesToOwnTaskCommits) for free per repo. Returned files are repo-prefixed (e.g. `repo-a/src/foo.ts`) and aggregated into task.modifiedFiles.
            if (deps.workspaceConfig) {
              const workspaceWorktrees = updatedTask.workspaceWorktrees ?? {};
              const aggregated = await deps.captureWorkspaceModifiedFiles(updatedTask, audit, "post-session");
              for (const [repoRel, repo] of Object.entries(workspaceWorktrees)) {
                // Per-repo branch-attribution audit (cwd = sub-repo). Run against repo.worktreePath/repo.branch, NOT the non-git root (a root call would fail and surface nothing). The contamination signal already rides on captureWorkspaceModifiedFiles above; this is the supplementary commit-attribution surface (FN-5233 pattern).
                try {
                  const attributionBase = await resolveContaminationBaseRef(repo.worktreePath);
                  if (attributionBase && repo.branch) {
                    const attribution = await reportBranchAttribution(repo.worktreePath, repo.branch, attributionBase, task.id);
                    const hasAnomaly = attribution.foreign.length > 0 || attribution.unattributed.length > 0 || attribution.ownUntrailed.length > 0;
                    if (hasAnomaly) {
                      const summary = `branch-attribution anomalies on ${repoRel}@${repo.branch}: foreign=${attribution.foreign.length}, unattributed=${attribution.unattributed.length}, ownUntrailed=${attribution.ownUntrailed.length}, ownTrailed=${attribution.ownTrailed}`;
                      executorLog.warn(`${task.id}: ${summary}`);
                      await deps.store.logEntry(task.id, `[branch-attribution] ${summary}`, undefined, deps.getRunContextFor(task.id));
                      await audit.git({
                        type: "branch:attribution-anomaly",
                        target: repo.branch,
                        metadata: {
                          taskId: task.id,
                          repo: repoRel,
                          baseSha: attributionBase,
                          ownTrailed: attribution.ownTrailed,
                          foreign: attribution.foreign,
                          unattributed: attribution.unattributed,
                          ownUntrailed: attribution.ownUntrailed,
                        },
                      });
                    }
                  }
                } catch (attributionErr: unknown) {
                  executorLog.warn(`${task.id}: post-session per-repo branch-attribution audit failed for ${repoRel}: ${attributionErr instanceof Error ? attributionErr.message : String(attributionErr)}`);
                }
              }
              if (aggregated.length > 0) {
                await deps.store.updateTask(task.id, { modifiedFiles: aggregated });
                executorLog.log(`${task.id}: captured ${aggregated.length} modified files across ${Object.keys(workspaceWorktrees).length} sub-repo(s)`);
                await audit.filesystem({ type: "file:capture-modified", target: task.id, metadata: { files: aggregated } });
              }
            } else {
            const modifiedFiles = await deps.captureModifiedFiles(worktreePath, updatedTask.baseCommitSha, task.id, audit, "post-session");
            if (modifiedFiles.length > 0) {
              await deps.store.updateTask(task.id, { modifiedFiles });
              executorLog.log(`${task.id}: captured ${modifiedFiles.length} modified files`);
              // Audit trail: record filesystem mutation (FN-1404)
              await audit.filesystem({ type: "file:capture-modified", target: task.id, metadata: { files: modifiedFiles } });
            }

            // Post-session branch attribution audit: walk base..branch and surface
            // any commit that's foreign (different FN-id), unattributed (no subject
            // tag AND no Fusion-Task-Id trailer), or own-but-untrailed (signals the
            // commit-msg hook didn't fire — typically a worktree without identity
            // guards or a plumbing-driven commit). Logged loudly so contamination
            // gets caught within minutes of happening rather than days later at
            // merge time (FN-5233 was this pattern).
            try {
              const attributionBase = await resolveContaminationBaseRef(worktreePath);
              if (attributionBase && updatedTask.branch) {
                const attribution = await reportBranchAttribution(deps.rootDir, updatedTask.branch, attributionBase, task.id);
                const hasAnomaly = attribution.foreign.length > 0 || attribution.unattributed.length > 0 || attribution.ownUntrailed.length > 0;
                if (hasAnomaly) {
                  const summary = `branch-attribution anomalies on ${updatedTask.branch}: foreign=${attribution.foreign.length}, unattributed=${attribution.unattributed.length}, ownUntrailed=${attribution.ownUntrailed.length}, ownTrailed=${attribution.ownTrailed}`;
                  executorLog.warn(`${task.id}: ${summary}`);
                  await deps.store.logEntry(task.id, `[branch-attribution] ${summary}`, undefined, deps.getRunContextFor(task.id));
                  await audit.git({
                    type: "branch:attribution-anomaly",
                    target: updatedTask.branch,
                    metadata: {
                      taskId: task.id,
                      baseSha: attributionBase,
                      ownTrailed: attribution.ownTrailed,
                      foreign: attribution.foreign,
                      unattributed: attribution.unattributed,
                      ownUntrailed: attribution.ownUntrailed,
                    },
                  });
                }
              }
            } catch (attributionErr: unknown) {
              executorLog.warn(`${task.id}: post-session branch-attribution audit failed: ${attributionErr instanceof Error ? attributionErr.message : String(attributionErr)}`);
            }
            } // end !deps.workspaceConfig singular capture (FNXC:Workspace KTD1)

            deps.scheduleCompletedTaskWatchdog(task.id, "step-session completion");
            if (await deps.shouldDeferCompletionForGlobalPause(task.id, "before workflow steps after step-session completion")) {
              return;
            }

            // ── Deterministic verification gate (FN-3345) ──────────
            // Run testCommand/buildCommand after all steps succeed but BEFORE
            // workflow steps and the in-review transition. Skipped in fast mode
            // and when no verification commands are configured.
            if (executionMode !== "fast") {
              if (settings.testCommand?.trim() || settings.buildCommand?.trim()) {
                const verificationResult = await deps.runExecutorDeterministicVerification(task, worktreePath, settings, taskEnv);

                if (!verificationResult.allPassed) {
                  const failedType = verificationResult.failedCommand === "testCommand" ? "test" : "build";
                  const failedResult = failedType === "test" ? verificationResult.testResult! : verificationResult.buildResult!;
                  const failedCommand = failedResult.command;
                  const failureOutput = failedResult.stderr || failedResult.stdout || "Unknown error";
                  const summary = summarizeVerificationOutput(failureOutput, failedType);

                  executorLog.log(`${task.id}: [verification] ${failedType} failed — attempting fix agent`);
                  await deps.store.logEntry(
                    task.id,
                    `[verification] ${failedType} command failed (exit ${failedResult.exitCode}). Attempting fix agent...`,
                    summary,
                    deps.getRunContextFor(task.id),
                  );

                  const maxFixRetries = Math.min(settings.verificationFixRetries ?? 3, 3);

                  if (maxFixRetries === 0) {
                    executorLog.log(`${task.id}: [verification] fix retries set to 0 — sending task back immediately`);
                    await deps.sendTaskBackForFix(
                      task, worktreePath,
                      `${failedType} command \`${failedCommand}\` failed (exit ${failedResult.exitCode}):\n${summary}`,
                      `Verification (${failedType})`,
                      `Deterministic verification failed (${failedType})`,
                      true,
                      true,
                    );
                    return;
                  }

                  let fixSucceeded = false;
                  for (let attempt = 1; attempt <= maxFixRetries; attempt++) {
                    const fixed = await deps.attemptExecutorVerificationFix(
                      task, worktreePath,
                      {
                        command: failedCommand,
                        exitCode: failedResult.exitCode,
                        output: failureOutput,
                        type: failedType,
                      },
                      settings,
                      attempt,
                      maxFixRetries,
                      taskEnv,
                    );
                    if (fixed) {
                      fixSucceeded = true;
                      executorLog.log(`${task.id}: [verification] fix agent succeeded on attempt ${attempt}/${maxFixRetries}`);
                      await deps.store.logEntry(
                        task.id,
                        `[verification] Fix agent succeeded on attempt ${attempt}/${maxFixRetries}. Verification now passing.`,
                        undefined,
                        deps.getRunContextFor(task.id),
                      );
                      break;
                    }
                    executorLog.log(`${task.id}: [verification] fix agent attempt ${attempt}/${maxFixRetries} failed`);
                    await deps.store.logEntry(
                      task.id,
                      `[verification] Fix agent attempt ${attempt}/${maxFixRetries} failed`,
                      undefined,
                      deps.getRunContextFor(task.id),
                    );
                  }

                  if (!fixSucceeded) {
                    executorLog.log(`${task.id}: [verification] all fix attempts exhausted (${maxFixRetries}/${maxFixRetries}) — sending task back`);
                    await deps.sendTaskBackForFix(
                      task, worktreePath,
                      `${failedType} command \`${failedCommand}\` failed (exit ${failedResult.exitCode}) after ${maxFixRetries} fix attempts:\n${summary}`,
                      `Verification (${failedType})`,
                      `Deterministic verification failed after ${maxFixRetries} fix attempts`,
                      true,
                      true,
                    );
                    return;
                  }
                }
              }
            }

            // FNXC:WorkflowExecution 2026-06-25-00:00: U4 (KTD-2/KTD-5) — workflow
            // steps are graph-owned. For a graph-driven run the execute seam
            // registered a completion interceptor; stop at the
            // implementation-complete boundary and hand the remaining lifecycle
            // (workflow gates → review → merge) back to the graph runner, which
            // records results into task.workflowStepResults (U2). The legacy
            // runWorkflowSteps loop was deleted. A NON-graph run reaching here has no
            // enabled workflow steps to run (a minimal store WITH enabled steps is
            // parked fail-closed inside executeWorkflowGraph, KTD-5), so there
            // is nothing to gate before the in-review handoff.
            deps.clearCompletedTaskWatchdog(task.id);
            executorLog.log(`✓ ${task.id} implementation complete — graph interpreter owns the remaining lifecycle`);
            const liveModified = (await deps.store.getTask(task.id).catch(() => task)).modifiedFiles ?? [];
            reportImplementationExit?.("complete-from-live-files");
            graphCompletion({ modifiedFiles: liveModified });
            return;
          } else {
            const failedSteps = results.filter(r => !r.success);
            const errorSummary = failedSteps.map(r => `Step ${r.stepIndex}: ${r.error || "unknown error"}`).join("; ");
            await deps.store.updateTask(task.id, { status: null, error: null });
            await deps.store.logEntry(task.id, `Step-session failed — requeued for execution resume: ${errorSummary}`, undefined, deps.getRunContextFor(task.id));
            deps.markGraphExecuteSelfRequeued(task.id);
            await deps.store.moveTask(task.id, await resolveReboundColumnFor(deps.store, task.id), { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
            executorLog.log(`✗ ${task.id} step-session failed → todo resume: ${errorSummary}`);
            deps.options.onError?.(task, new Error(errorSummary));
          }
        };

        const retryableStepWork = () => withRateLimitRetry(stepWork, {
          signal: deps.activeWorkflowGraphAbortControllers.get(task.id)?.signal,
          rotation: deps.options.credentialRotator && activeStepInstanceRef ? {
            providerId: activeStepInstanceRef.providerId,
            nextInstance: nextStepInstance,
          } : undefined,
          onRetry: (attempt, delayMs, error) => {
            const delaySec = Math.round(delayMs / 1000);
            executorLog.warn(`⏳ ${task.id} rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
            deps.store.logEntry(task.id, `Rate limited — retry ${attempt} in ${delaySec}s`, undefined, deps.getRunContextFor(task.id)).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              executorLog.warn(`${task.id} failed to log rate-limit retry: ${msg}`);
            });
          },
        });

        try {
          await deps.runWithExecutorSemaphore(task.id, retryableStepWork);
          if (stepDispatchedRotation) stepRotationEvent?.recordOutcome("rotation-succeeded");
        } catch (err: unknown) {
          const { message: errorMessage, detail: errorDetail, stack: errorStack } = formatError(err);
          if (deps.depAborted.has(task.id)) {
            deps.depAborted.delete(task.id);
            await deps.handleDepAbortCleanup(task.id, worktreePath);
          } else if (deps.pausedAborted.has(task.id)) {
            if (deps.userCanceledTaskIds.has(task.id)) {
              deps.clearPausedAborted(task.id);
              deps.stuckAborted.delete(task.id);
              deps.userCanceledTaskIds.delete(task.id);
              await deps.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
              return;
            }
            if (await deps.parkApprovalSuspension(task.id, "step session")) return;
            deps.clearPausedAborted(task.id);
            await deps.store.logEntry(task.id, "Execution paused during step-session", undefined, deps.getRunContextFor(task.id));
            deps.markGraphExecuteSelfRequeued(task.id);
            await deps.store.moveTask(task.id, await resolveReboundColumnFor(deps.store, task.id), { preserveResumeState: true });
          } else if (deps.stuckAborted.has(task.id)) {
            stuckRequeue = deps.stuckAborted.get(task.id) ?? true;
            deps.stuckAborted.delete(task.id);
          } else if (deps.options.usageLimitPauser && isUsageLimitError(errorMessage)) {
            await deps.options.usageLimitPauser.onUsageLimitHit("executor", task.id, errorMessage);
          } else if (isTransientError(errorMessage)) {
            const decision = computeRecoveryDecision({
              recoveryRetryCount: task.recoveryRetryCount,
              nextRecoveryAt: task.nextRecoveryAt,
            });

            if (decision.shouldRetry) {
              const attempt = decision.nextState.recoveryRetryCount;
              const delay = formatDelay(decision.delayMs);
              if (!isSilentTransientError(errorMessage)) {
                executorLog.warn(`⚡ ${task.id} transient error — retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}: ${errorMessage}`);
                await deps.store.logEntry(task.id, `Transient error (retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}): ${errorMessage}`, undefined, deps.getRunContextFor(task.id));
              }
              if (worktreePath && existsSync(worktreePath)) {
                try {
                  const settings = await deps.store.getSettings();
                  await removeWorktree({
                    worktreePath,
                    rootDir: deps.rootDir,
                    settings,
                    taskId: task.id,
                    audit,
                    reason: RemovalReason.ExecutorTransientRetry,
                    expectedOwnerTaskId: task.id,
                    liveOwnerProbe: (path, ownerTaskId) => deps.hasActiveWorktreeBinding(ownerTaskId, path),
                  });
                } catch (wtErr: unknown) {
                  const msg = wtErr instanceof Error ? wtErr.message : String(wtErr);
                  executorLog.warn(`${task.id}: worktree removal failed during transient-error retry cleanup (${worktreePath}): ${msg}`);
                }
              }
              await deps.store.updateTask(task.id, {
                recoveryRetryCount: decision.nextState.recoveryRetryCount,
                nextRecoveryAt: decision.nextState.nextRecoveryAt,
                worktree: null,
                branch: null,
              });
              deps.markGraphExecuteSelfRequeued(task.id);
              await deps.store.moveTask(task.id, await resolveReboundColumnFor(deps.store, task.id), { preserveProgress: true });
              stuckRequeue = null; // Prevent outer finally from re-processing
              return;
            }

            executorLog.error(`✗ ${task.id} transient error retries exhausted: ${errorDetail}`);
            if (errorStack) {
              await deps.store.logEntry(task.id, `Transient error retries exhausted: ${errorMessage}`, errorStack, deps.getRunContextFor(task.id));
            }
            await deps.store.updateTask(task.id, {
              status: "failed",
              error: errorMessage,
              recoveryRetryCount: null,
              nextRecoveryAt: null,
            });
            if (accumulatedStepTokenUsage) {
              await deps.persistTaskTokenUsage(task.id, accumulatedStepTokenUsage);
            }
            executorLog.log(`✗ ${task.id} transient retries exhausted — failed in execution`);
            deps.options.onError?.(task, err instanceof Error ? err : new Error(errorMessage));
          } else {
            if (accumulatedStepTokenUsage) {
              await deps.persistTaskTokenUsage(task.id, accumulatedStepTokenUsage);
            }
            if (await deps.handleNonContinuableSessionError(task, false, errorMessage)) {
              return;
            }
            executorLog.error(`✗ ${task.id} step-session execution failed:`, errorDetail);
            await deps.store.logEntry(task.id, `Step-session execution failed: ${errorMessage}`, errorStack ?? errorDetail, deps.getRunContextFor(task.id));
            await deps.store.updateTask(task.id, { status: null, error: null });
            deps.markGraphExecuteSelfRequeued(task.id);
            await deps.store.moveTask(task.id, await resolveReboundColumnFor(deps.store, task.id), { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
            executorLog.log(`✗ ${task.id} step-session execution failed → todo resume`);
            deps.options.onError?.(task, err instanceof Error ? err : new Error(errorMessage));
          }
        } finally {
          deps.executing.delete(task.id);
          executingTaskLock.release(task.id);
          deps.loopRecoveryState.delete(task.id);
          // Wrap cleanup in try/catch so activeStepExecutors.delete() always runs.
          // If cleanup() throws, the executor continues to clean up the in-memory map
          // and requeue logic without leaking the reference.
          try {
            await stepExecutor.cleanup();
          } catch (cleanupErr) {
            executorLog.warn(`StepSessionExecutor cleanup failed for ${task.id}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
          }
          deps.deleteActiveStepExecutor(task.id);

          // Stuck-requeue: clean up worktree and move to todo
          if (stuckRequeue === true) {
            try {
              // Re-read latest task state. Self-healing may have already moved
              // the task out of in-progress while this step-session execution
              // was unwinding; continuing the cleanup would clobber a valid
              // recovery (see the analogous block in the outer finally for the
              // full reasoning).
              /* FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet: stuck-requeue family): "has a
                 concurrent recovery already moved this card on?" — the pre-completion lanes are the board's
                 wip and hold. With literals a renamed board always answered "moved on", the cleanup never
                 ran, and the log line blamed a concurrent recovery that had not happened. */
              const latestTask = await deps.store.getTask(task.id);
              const requeueLanes = await deps.resolveResumeLanes(task.id);
              if (latestTask.column !== requeueLanes.wip && latestTask.column !== requeueLanes.hold) {
                executorLog.log(
                  `${task.id} stuck-requeue skipped — task is now in '${latestTask.column}' (recovered concurrently)`,
                );
              } else {
                const settings = await deps.store.getSettings();
                const preserveProgress = settings.preserveProgressOnStuckRequeue !== false;

                /*
                FNXC:StuckRequeue 2026-06-27-23:15:
                Stuck requeue may destroy a checkout that contains only uncommitted step output. Always reconcile lost-work step state before worktree removal, even when preserve-progress is enabled, so a retry cannot skip code that no longer exists.
                */
                await deps.resetStepsIfWorkLost(latestTask);

                if (worktreePath && existsSync(worktreePath)) {
                  try {
                    await removeWorktree({
                      worktreePath,
                      rootDir: deps.rootDir,
                      settings,
                      taskId: task.id,
                      reason: RemovalReason.ExecutorStuckKilled,
                      expectedOwnerTaskId: task.id,
                      liveOwnerProbe: (path, ownerTaskId) => deps.hasActiveWorktreeBinding(ownerTaskId, path),
                    });
                  } catch (wtErr: unknown) {
                    const msg = wtErr instanceof Error ? wtErr.message : String(wtErr);
                    executorLog.warn(`${task.id}: worktree removal failed during stuck-requeue cleanup (${worktreePath}): ${msg}`);
                  }
                }
                await deps.store.updateTask(task.id, {
                  status: "queued",
                  error: null,
                  worktree: null,
                  branch: null,
                });
                const reboundColumn = await resolveReboundColumnFor(deps.store, task.id);
                if (latestTask.column !== reboundColumn) {
                  deps.markGraphExecuteSelfRequeued(task.id);
                  await deps.store.moveTask(task.id, reboundColumn, preserveProgress ? { preserveProgress: true } : undefined);
                  executorLog.log(`${task.id} moved to ${reboundColumn} for retry after stuck kill${preserveProgress ? " (progress preserved)" : ""}`);
                }
              }
            } catch (err: unknown) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              executorLog.error(`Failed to requeue stuck task ${task.id}: ${errorMessage}`);
            }
            stuckRequeue = null; // Prevent outer finally from re-processing
          }
        }
        // Step-session path handled completely — return before outer catch/finally
        return;
      }

      // ── Single-Session Path (default) ────────────────────────────────
      // Build custom tools for the worker
      // Track the last code review verdict per step so we can enforce REVISE
      // (block fn_task_update status="done" until the agent re-reviews and gets APPROVE).
      // Keyed by the canonical 0-indexed step number used by PROMPT.md headings.
      const codeReviewVerdicts = new Map<number, ReviewVerdict>();

      let wasPaused = false;
      // Mutable ref — populated after createFnAgent, tools access lazily via closure
      const sessionRef: { current: AgentSession | null } = { current: null };
      /*
      FNXC:ReviewerProviderErrors 2026-07-19-02:30:
      DELETED (U10/R9): the deferred provider-error re-raise channel (`reviewerFatalRef`) and the
      per-step conversation checkpoint map (`stepCheckpoints`, the RETHINK rewind target) existed
      only to serve the legacy in-session `fn_review_step` tool. Both die with it. Graph-owned
      review nodes run on their own session and can throw directly, and a RETHINK is a graph edge
      rather than an in-conversation `navigateTree` rewind — so neither mechanism has a caller.
      Do not re-introduce a tool-handler-deferred error channel here: it only ever existed because
      pi-agent-core converts a tool throw into a `tool_error` result the model reads and retries.
      */

      const stuckDetector = deps.options.stuckTaskDetector;
      const assignedAgentId = detail.assignedAgentId?.trim();
      const reflectionTools = deps.options.reflectionService && settings.reflectionEnabled && assignedAgentId
        ? [createReflectOnPerformanceTool(deps.options.reflectionService, assignedAgentId)]
        : [];
      const assignedAgent = await deps.getAuthoritativeAssignedAgent(assignedAgentId);
      const routedPrincipal = deps.activeWorkflowPrincipals.get(task.id);
      const routedPrincipalAgentId = routedPrincipal?.agentId;
      const routedPrincipalAgent = routedPrincipal?.agent
        ?? (routedPrincipalAgentId
          ? await deps.getAuthoritativeAssignedAgent(routedPrincipalAgentId)
          : undefined);
      if (routedPrincipalAgentId && !routedPrincipalAgent) {
        throw new Error(`workflow-principal-unavailable:${routedPrincipalAgentId}`);
      }

      // Column-agent SESSION IDENTITY (U4, R2/R3/R4/R8): when the governing execute
      // seam node's declared column binds an agent that supersedes the task's
      // assigned agent, the coding session's MODEL, runtime hint, persona, and
      // memory tools adopt the column agent. The core resolver decides defer vs
      // override (KTD-2); a missing agent logs + falls back (R8). No binding →
      // `columnAgentSeam` is undefined and every line below is byte-identical to the
      // assigned-agent path (characterization parity). Gating contexts key off
      // `identityAgent` — the effective column agent when a binding governs, else
      // the assigned agent (U5/KTD-3 principal substitution).
      const columnAgentSeam = await deps.resolveSeamColumnAgent(task, detail);
      /*
       * FNXC:WorkflowAgentRouting 2026-08-07-03:46:
       * Once graph admission has fenced a durable workflow principal, the model
       * session must use that exact identity instead of re-resolving ownership or
       * a column binding. This prevents a retry from silently changing authority.
       */
      const identityAgent = routedPrincipalAgent ?? columnAgentSeam?.agent ?? assignedAgent;
      const executorRuntimeHint = extractRuntimeHint(identityAgent?.runtimeConfig);
      // U5 (R6): track the effective column-agent principal so the heartbeat
      // scheduler's reverse guard knows this agent is executing a task it may not
      // be assigned to. Cleared in deleteActiveSession.
      if (columnAgentSeam?.agent) {
        deps.effectiveColumnAgentByTask.set(task.id, columnAgentSeam.agent.id);
      }

      // Log fast mode status
      if (executionMode === "fast") {
        executorLog.debug(`${task.id}: fast mode`);
      }

      /*
      FNXC:TaskVerificationRequest 2026-07-30-00:00:
      Chat can only enqueue a server-resolved profile. The executor owns the live
      worktree, so it claims and runs that request here through the existing bounded
      runner (which acquires withVerificationSlot); no chat-side subprocess exists.
      */
      let verificationRequestInFlight = false;
      const runPendingTaskVerification = async (): Promise<void> => {
        if (verificationRequestInFlight) return;
        const pendingVerification = await deps.store.getTaskVerificationRequestAsync(task.id);
        if (pendingVerification?.status !== "requested") return;
        verificationRequestInFlight = true;
        try {
          const claimedVerification = await deps.store.claimTaskVerificationRequest(task.id, pendingVerification.requestId);
          if (!claimedVerification) return;
          const startedAt = Date.now();
          try {
            const verificationResult = await runTaskVerificationCommand({
              command: claimedVerification.command,
              cwd: worktreePath,
              timeoutMs: settings.verificationCommandTimeoutMs ?? 300_000,
              onHeartbeat: () => stuckDetector?.recordActivity(task.id),
            });
            await deps.store.finishTaskVerificationRequest(task.id, claimedVerification.requestId, verificationResult.success ? "passed" : "failed", {
              success: verificationResult.success, exitCode: verificationResult.exitCode,
              durationMs: Date.now() - startedAt, timedOut: verificationResult.timedOut ?? false,
              stdoutTail: verificationResult.stdout.slice(-8_000), stderrTail: verificationResult.stderr.slice(-8_000),
            });
          } catch (error) {
            await deps.store.finishTaskVerificationRequest(task.id, claimedVerification.requestId, "failed", undefined, error instanceof Error ? error.message.slice(0, 1_000) : "Verification runner failed");
          }
        } finally {
          verificationRequestInFlight = false;
        }
      };
      await runPendingTaskVerification();

      /*
      FNXC:EphemeralAgentTaskCreation 2026-07-26-06:20:
      A `deny` project policy removes fn_task_create from the session's tool list instead of
      registering a tool that only refuses at execute time; see isAgentTaskCreateToolAvailable.

      FNXC:EphemeralAgentTaskCreation 2026-07-26-07:40:
      fn_delegate_task is withheld by the same policy (it creates a task through the same
      primitive), and the suppression emits a run-audit event. Without the event an operator
      cannot distinguish "the policy suppressed the tool" from "the agent had nothing to file" —
      every other policy decision in this engine leaves that trail.
      */
      const executionCallerIsEphemeral = !identityAgent || isEphemeralAgent(identityAgent);
      const taskCreateWithheld = !isAgentTaskCreateToolAvailable(settings, executionCallerIsEphemeral);
      const delegateWithheld = !isAgentDelegateTaskToolAvailable(settings, executionCallerIsEphemeral);
      if (taskCreateWithheld || delegateWithheld) {
        await deps.store.recordRunAuditEvent?.({
          taskId: task.id,
          agentId: identityAgent?.id ?? "executor",
          runId: deps.getRunContextFor(task.id)?.runId ?? generateSyntheticRunId("task-create-withheld", task.id),
          domain: "database",
          mutationType: "agent:task-create-withheld",
          target: task.id,
          metadata: {
            taskId: task.id,
            policy: resolveEphemeralTaskCreationPolicy(settings),
            withheldTaskCreate: taskCreateWithheld,
            withheldDelegateTask: delegateWithheld,
            lane: "execution-session",
          },
        }).catch(() => undefined);
      }
      /*
      FNXC:AgentProvisioningGate 2026-07-26-13:20:
      fn_agent_create / fn_agent_delete previously received no options in the executor lane,
      which made the factory synthesize approvalMode "never" and disabled the provisioning
      approval gate in production. Pass a live settingsProvider plus the shared
      PostgreSQL-backed ApprovalRequestStore when the async layer exists; without a layer we
      pass no approval store so the factory fails CLOSED (require-approval => DENY).
      */
      const provisioningApprovalLayer = typeof deps.store.getAsyncLayer === "function" ? deps.store.getAsyncLayer() : null;
      const agentProvisioningToolOptions = {
        settingsProvider: async () => await deps.store.getSettings(),
        ...(provisioningApprovalLayer ? { approvalRequestStore: deps.approvalRequestStore } : {}),
      };
      const tools = deps.sharedWorkerTools;
      const customTools = [
        deps.createTaskUpdateTool(task.id, codeReviewVerdicts, sessionRef, stuckDetector),
        createTaskLogTool(tools, task.id),
        createTaskLogsReadTool(tools, task.id),
        ...(taskCreateWithheld
          ? []
          : [createTaskCreateTool(tools, executionCallerIsEphemeral, task.id, identityAgent?.id)]),
        deps.createTaskAddDepTool(task.id),
        deps.createTaskDoneTool(task.id, worktreePath, detail.prompt ?? "", codeReviewVerdicts, () => { taskDone = true; }, audit),
        createRunVerificationTool({
          worktreePath,
          rootDir: deps.rootDir,
          taskId: task.id,
          recordActivity: () => stuckDetector?.recordActivity(task.id),
          verificationCommandTimeoutMs: settings.verificationCommandTimeoutMs,
          onVerificationStart: (timeoutMs) => stuckDetector?.beginVerification(task.id, timeoutMs),
          onVerificationEnd: () => stuckDetector?.endVerification(task.id),
          log: {
            info: (s) => executorLog.log(s),
            debug: (s) => executorLog.debug(s),
            warn: (s) => executorLog.warn(s),
            error: (s) => executorLog.warn(s),
          },
        }),
        /*
        FNXC:WorkflowReviewGates 2026-07-19-02:30:
        U10 (R9): the legacy in-session `fn_review_step` tool is DELETED. Plan/code/browser
        review gates are owned exclusively by workflow-graph nodes, so an implementation
        session never spawns its own reviewer. Nothing is injected here; the entry is kept
        as a tombstone marker so a future reader does not re-add a second review authority.
        */
        deps.createSpawnAgentTool(task.id, worktreePath, settings, taskEnv),
        createTaskDocumentWriteTool(tools, task.id),
        createTaskDocumentReadTool(tools, task.id),
        // FNXC:FileScope 2026-07-08-22:40: let the coding agent extend its own declared ## File Scope at runtime (fn_task_file_scope_add) so edits beyond the initial scope are not stranded by the scope-aware squash merge.
        createTaskFileScopeAddTool(tools, task.id),
        createArtifactListTool(tools),
        createArtifactViewTool(tools),
        /*
        FNXC:ArtifactRegistry 2026-07-10-14:30:
        fn_artifact_register was previously gated on assignedAgentId, but default ephemeral mode never
        sets assignedAgentId on in-progress tasks — so executor agents never had the register tool at
        all and agent-produced screenshots/wireframes could not reach the Artifacts gallery. Always
        expose it, attributing ephemeral runs to the established "executor" fallback author.
        */
        createArtifactRegisterTool(tools, assignedAgentId ?? "executor", task.id, worktreePath),
        createWorkflowListTool(tools),
        createWorkflowGetTool(tools),
        createWorkflowValidateTool(tools),
        createWorkflowSelectTool(tools, task.id),
        createTaskPromoteTool(tools, task.id),
        createWorkflowCreateTool(tools),
        createWorkflowUpdateTool(tools),
        createWorkflowDeleteTool(tools),
        createWorkflowSettingsTool(tools),
        createTraitListTool(),
        ...(isResearchToolSurfaceEnabled(settings)
          ? createResearchTools({
            store: deps.store,
            rootDir: deps.rootDir,
            getSettings: async () => deps.store.getSettings(),
          })
          : []),
        ...createMissionTools(deps.store, {
          agentId: engineRunContext.agentId,
          agentName: identityAgent?.name,
        }),
        ...createIdeationTools(deps.store),
        ...createGoalRetrievalTools(deps.store, {
          runContext: {
            runId: engineRunContext.runId,
            agentId: engineRunContext.agentId,
          },
          taskId: task.id,
        }),
        createWebFetchTool(),
        ...createMemoryTools(deps.rootDir, settings, identityAgent ? {
          agentMemory: {
            agentId: identityAgent.id,
            agentName: identityAgent.name,
            memory: identityAgent.memory,
          },
        } : undefined),
        // Conditionally add agent self-reflection when enabled and task has an assigned agent.
        ...reflectionTools,
        // Agent delegation tools — discover and delegate work to other agents.
        ...(deps.options.agentStore ? [
          createListAgentsTool(deps.options.agentStore),
          ...(delegateWithheld
            ? []
            : [createDelegateTaskTool(deps.options.agentStore, deps.store, { rootDir: deps.rootDir, sourceTaskId: task.id, sourceAgentId: assignedAgentId, callerIsEphemeral: executionCallerIsEphemeral })]),
          createTaskAssignTool(deps.options.agentStore, deps.store),
          ...(assignedAgentId ? [
            createGetAgentConfigTool(deps.options.agentStore, assignedAgentId),
            createUpdateAgentConfigTool(deps.options.agentStore, assignedAgentId),
            createAgentCreateTool(deps.options.agentStore, assignedAgentId, agentProvisioningToolOptions),
            createAgentDeleteTool(deps.options.agentStore, assignedAgentId, agentProvisioningToolOptions),
          ] : []),
        ] : []),
        // Messaging tools — allows executor agents to send and receive messages.
        ...(deps.options.messageStore && assignedAgentId ? [
          createSendMessageTool(deps.options.messageStore, assignedAgentId, { autoRecovery: settings.autoRecovery, runAudit: audit, taskStore: deps.store, settings, agentStore: deps.options.agentStore }),
          createReadMessagesTool(deps.options.messageStore, assignedAgentId),
        ] : []),
        // Add plugin tools from PluginRunner
        ...getEnabledPluginTools(deps.options.pluginRunner),
      ];

      if (deps.workspaceConfig && deps.workspaceConfig.repos.length > 0) {
        customTools.push(createAcquireRepoWorktreeTool({
          workspaceRootDir: deps.rootDir,
          workspaceRepos: deps.workspaceConfig.repos,
          task,
          store: deps.store,
          settings,
          logger: executorLog,
          secretsStore: deps.options.secretsStore,
          runContext: engineRunContext,
          audit,
          // FNXC:Workspace 2026-06-21-22:30: F2 — register each freshly-acquired sub-repo worktree path in this task's activeWorktrees Set (KTD2) so owner/liveness checks see live per-repo worktrees, not just the browse-only root.
          onAcquired: (worktreePath: string) => deps.addActiveWorktree(task.id, worktreePath),
          taskEnv,
          // FNXC:Workspace 2026-06-22 — forward the configured worktree-init runner so sub-repo worktrees run configured setup.
          runConfiguredCommand: (command, cwd, timeoutMs, env) =>
            runConfiguredCommand(command, cwd, timeoutMs, env, audit),
        }));
      }

      // Accumulates the full assistant text output for the most recent session.
      // Reset to "" each time a new session begins so detectPseudoPause only
      // sees the last session's output, not the entire conversation history.
      let lastAssistantText = "";

      const agentLogger = new AgentLogger({
        store: deps.store,
        taskId: task.id,
        agent: "executor",
        persistAgentToolOutput: settings.persistAgentToolOutput,
        // Executor sessions are task-scoped ephemeral workers.
        persistAgentThinkingLog: resolvePersistAgentThinkingLog(settings, { ephemeral: true }),
        onAgentText: (taskId, delta) => {
          lastAssistantText += delta;
          stuckDetector?.recordActivity(taskId);
          deps.options.onAgentText?.(taskId, delta);
        },
        onAgentTool: (taskId, toolName, detail) => {
          /*
          FNXC:StuckDetector 2026-07-22-18:05:
          Tool heartbeats carry name+detail fingerprints so the stuck detector can distinguish
          legitimate iterative single-step work from repetitive thrash loops.

          FNXC:StuckDetector 2026-07-22-19:25:
          Forward `detail` to options.onAgentTool so external telemetry keeps the full
          fingerprint contract (CodeRabbit on PR #2404).
          */
          stuckDetector?.recordActivity(taskId, { toolName, toolDetail: detail });
          deps.options.onAgentTool?.(taskId, toolName, detail);
        },
        // FNXC:PlannerOversight 2026-07-13-23:05: live session-advisor delta path (fail-soft).
        onEntriesFlushed: (taskId, entries) => {
          try {
            deps.options.onExecutorLogFlushed?.(taskId, entries);
          } catch {
            /* ignore */
          }
        },
      });

      let agentRotationEvent: import("../credential-instance-rotation.js").RotationEvent | undefined;
      let agentRotationDeclined = false;
      let agentDispatchedRotation = false;
      let activeAgentInstanceRef: ProviderInstanceRef | undefined;

      const agentWork = async () => {
        // Resolve model settings using canonical lane hierarchy:
        // 1. Task override pair (modelProvider + modelId)
        // 2. Project execution lane pair (executionProvider + executionModelId)
        // 3. Global execution lane pair (executionGlobalProvider + executionGlobalModelId)
        // 4. Project default override pair (defaultProviderOverride + defaultModelIdOverride)
        // 5. Global default pair (defaultProvider + defaultModelId)
        // Column-agent session identity (U4): the model precedence input is the
        // EFFECTIVE identity agent's runtimeConfig (column agent when it governs,
        // else the assigned agent — byte-identical no-binding path).
        /*
        FNXC:ColumnAgentModel 2026-06-27-11:24:
        Override column agents own initial session model selection as well as mid-flight re-resolution. Ignore task-level modelProvider/modelId before resolveExecutorSessionModel so pre-existing task model pairs cannot run the column-agent identity on the task model.
        */
        const overrideColumnGovernsInitialSession = columnAgentSeam?.mode === "override";
        const executorSessionModel = resolveExecutorSessionModel(
          overrideColumnGovernsInitialSession ? undefined : detail.modelProvider,
          overrideColumnGovernsInitialSession ? undefined : detail.modelId,
          settings,
          (identityAgent?.runtimeConfig ?? undefined) as Record<string, unknown> | undefined,
          overrideColumnGovernsInitialSession ? undefined : activeAgentInstanceRef?.instanceId ?? detail.credentialInstanceId,
        );
        const { provider: executorProvider, modelId: executorModelId } = executorSessionModel;
        /*
        FNXC:ProviderAuth 2026-08-03-17:35:
        Keep a synthetic "default" ref only for credential-rotation bookkeeping (startingInstanceId).
        Never force that synthetic id into createResolvedAgentSession: chat omits unset instance ids
        and custom providers authenticate via customProviders.apiKey. Passing "default" required an
        auth.json default instance and failed step-execute while chat with the same model worked.
        After a usage-limit rotation, agentDispatchedRotation is true and the offered instance is real.
        */
        activeAgentInstanceRef ??= executorProvider
          ? { providerId: executorProvider, instanceId: executorSessionModel.credentialInstanceId ?? DEFAULT_PROVIDER_INSTANCE_ID }
          : undefined;
        const sessionCredentialInstanceId = agentDispatchedRotation
          ? activeAgentInstanceRef?.instanceId
          : executorSessionModel.credentialInstanceId;
        const { provider: executorFallbackProvider, modelId: executorFallbackModelId } = resolveExecutorFallbackModel(settings);
        const executorSessionThinkingSource = (deps.graphSeamThinkingLevel.get(task.id) as string | undefined) ?? detail.thinkingLevel;
        const executorThinkingLevel = resolveExecutorThinkingLevel(executorSessionThinkingSource, settings);
        const executorFallbackThinkingLevel = resolveExecutorFallbackThinkingLevel(executorSessionThinkingSource, settings);

        // U1 telemetry: now that the session model/provider/node are resolved,
        // give the agent logger the context it needs to emit usage_events tool
        // rows (KTD3). nodeId is sourced from the routed/effective node, null
        // when the task has no node context.
        agentLogger.setUsageContext({
          model: executorModelId ?? null,
          provider: executorProvider ?? null,
          nodeId: detail.effectiveNodeId ?? detail.nodeId ?? null,
          agentId: engineRunContext.agentId ?? null,
        });

        // Determine whether we're resuming a previous session (pause/resume)
        // or starting fresh. Use file-based sessions so conversation state
        // persists across pause/unpause cycles. Resume is allowed only when
        // persisted session metadata still matches the task's live worktree.
        let isResuming = !!task.sessionFile && existsSync(task.sessionFile);
        if (isResuming) {
          const persistedWorktreePath = await extractPersistedSessionWorktreePath(task.sessionFile!, deps.rootDir, settings);
          if (!isSessionWorktreeCompatible(persistedWorktreePath, worktreePath)) {
            executorLog.warn(
              `${task.id}: stale sessionFile worktree mismatch (session=${persistedWorktreePath}, task=${worktreePath}); starting fresh session`,
            );
            await deps.store.logEntry(
              task.id,
              `Detected stale persisted session metadata (worktree mismatch: ${persistedWorktreePath} vs ${worktreePath}) — discarded resume state and started fresh session`,
              undefined,
              deps.getRunContextFor(task.id),
            );
            await deps.store.updateTask(task.id, { sessionFile: null });
            isResuming = false;
          }
        }

        const sessionManager = isResuming
          ? SessionManager.open(task.sessionFile!)
          : SessionManager.create(worktreePath);

        executorLog.debug(`${task.id}: creating agent session (provider=${executorProvider ?? "default"}, model=${executorModelId ?? "default"}, resuming=${isResuming})`);

        // Resolve per-agent custom instructions for the executor role.
        // Column-agent session identity (U4, R3/KTD-6): when a column agent governs,
        // its TYPED persona (soul/instructionsText, via buildAgentPersona — the same
        // source the custom-node path uses) supersedes the role-resolved executor
        // instructions, so the coding session speaks AS the column agent. No binding
        // → role instructions unchanged (characterization parity).
        const columnAgentPersona = columnAgentSeam ? buildAgentPersona(columnAgentSeam.agent) : undefined;
        const executorInstructions = columnAgentPersona
          ?? (await deps.resolveInstructionsForRole("executor", settings));

        // Build structured layers for cross-session prompt caching.
        const executorPluginContributions = await buildPluginPromptSection(
          "executor-system",
          deps.options.pluginRunner,
        );
        if (executorPluginContributions) {
          executorLog.debug(`${task.id}: applied plugin prompt contributions for executor-system surface`);
        }

        const executorGoalResolution = await resolveAndEmitGoalContext({
          lane: "executor",
          store: deps.store,
          audit,
          taskId: task.id,
          runContext: engineRunContext,
        });
        const executorGoalContext = executorGoalResolution.goalContext;

        const executorLayers = buildPromptLayers({
          basePrompt: getExecutorSystemPrompt(settings, { taskCreateWithheld, delegateWithheld }),
          goalContext: executorGoalContext,
          agentInstructions: executorInstructions,
          pluginContributions: executorPluginContributions,
        });

        const executorSystemPromptFinal = collapsePromptLayers(executorLayers);

        // sessionFile must be let because it's assigned before downstream retry-session reassignment.
        let session: AgentSession;
        let sessionFile: string | null | undefined;
        try {
          const createdSession = await createResolvedAgentSession({
            sessionPurpose: "executor",
            runtimeHint: executorRuntimeHint,
            pluginRunner: deps.options.pluginRunner,
            cwd: worktreePath,
            systemPrompt: executorSystemPromptFinal,
            systemPromptLayers: executorLayers,
            tools: "coding",
            customTools,
            onText: agentLogger.onText,
            onThinking: agentLogger.onThinking,
            onToolStart: agentLogger.onToolStart,
            onToolEnd: agentLogger.onToolEnd,
            defaultProvider: executorProvider,
            defaultModelId: executorModelId,
            ...(sessionCredentialInstanceId ? { credentialInstanceId: sessionCredentialInstanceId } : {}),
            fallbackProvider: executorFallbackProvider,
            fallbackModelId: executorFallbackModelId,
            fallbackThinkingLevel: executorFallbackThinkingLevel,
            defaultThinkingLevel: executorThinkingLevel,
            runAuditor: audit,
            settings,
            sessionManager,
            taskEnv,
            mcpServers: await deps.resolveMcpServers(identityAgent?.id),
            // FNXC:PluginSkills 2026-07-12-00:00: Plugin skill session delivery requires forwarding both requested names and body directories so the pi loader can discover plugin-package SKILL.md files.
            ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
            ...(skillContext.additionalSkillPaths.length > 0 ? { additionalSkillPaths: skillContext.additionalSkillPaths } : {}),
            // Column-agent principal alignment (plan U5, R5): action gating is
            // computed for the agent ACTUALLY RUNNING. When the governing execute
            // seam's column binds an agent that supersedes the assigned agent,
            // `identityAgent` is that column agent; otherwise it is `assignedAgent`
            // (byte-identical to before). The builders already accept an `Agent`
            // object, so this is a call-site object swap, not gating-internals surgery.
            actionGateContext: deps.buildActionGateContext(task.id, identityAgent, settings.defaultAgentPermissionPolicy),
            permanentAgentGating: deps.buildPermanentAgentGatingContext(task.id, identityAgent, settings.defaultAgentPermissionPolicy),
            taskId: task.id,
            taskTitle: detail.title,
            onFallbackModelUsed: createFallbackModelObserver({
              agent: "executor",
              label: "executor",
              store: deps.store,
              taskId: task.id,
              taskTitle: detail.title,
            }),
          });
          session = createdSession.session;
          sessionFile = createdSession.sessionFile;
        } catch (sessionStartError) {
          if (await deps.recoverMissingWorktreeSessionStartFailure(task, worktreePath, sessionStartError, audit)) {
            return;
          }
          throw sessionStartError;
        }

        const executorModelDesc = describeModel(session);
        const executorModelDetails = formatModelMarkerDetails(executorModelDesc, executorThinkingLevel);
        const executorModelMarker = `Executor using model: ${executorModelDetails}`;
        if (isResuming) {
          executorLog.debug(`${task.id}: resumed session from ${task.sessionFile}`);
          await deps.store.logEntry(task.id, `Resumed agent session after unpause (model: ${executorModelDesc})`, undefined, deps.getRunContextFor(task.id));
        } else {
          executorLog.debug(`${task.id}: using model ${executorModelDesc}`);
          await deps.store.logEntry(task.id, executorModelMarker, undefined, deps.getRunContextFor(task.id));
          // Persist session file path so pause/resume can reopen it
          if (sessionFile) {
            await deps.store.updateTask(task.id, { sessionFile });
          }
        }
        await deps.store.appendAgentLog(task.id, executorModelMarker, "status", undefined, "executor");

        // Capture both executor and session-helper baselines before any task prompt consumes tokens.
        await deps.captureExecutorTokenUsageBaseline(task.id, session);
        captureSessionTokenBaseline(session);

        // Make session available to custom tools
        sessionRef.current = session;

        // Register session so the pause listener can terminate it.
        // Initialize with all existing steering comments so only mid-flight
        // comments are injected into the running session.
        const seenSteeringIds = createSeenSteeringIds(detail);
        deps.setActiveSession(task.id, {
          session,
          seenSteeringIds,
          lastResolvedModelProvider: executorProvider,
          lastResolvedModelId: executorModelId,
          lastTaskModelProvider: detail.modelProvider,
          lastTaskModelId: detail.modelId,
          lastAssignedAgentId: detail.assignedAgentId ?? null,
          // U5 (R7): the effective column-agent governing this session (null when no
          // binding governs — legacy path). The watcher re-resolves this for graph-
          // mode entries to detect a mid-flight workflow-edit / agent-config change.
          lastEffectiveColumnAgentId: columnAgentSeam?.agent.id ?? null,
        }, worktreePath);

        /*
        FNXC:TaskVerificationRequest 2026-07-30-17:40:
        A chat request can arrive after this executor session starts. Poll while
        this task retains the live worktree so requested records are claimed by
        their owner rather than waiting for an unrelated future dispatch.
        */
        const verificationRequestTimer = setInterval(() => {
          void runPendingTaskVerification().catch((error) => {
            executorLog.warn(`${task.id}: verification request pickup failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }, 1_000);
        let leaseRenewalTimer: ReturnType<typeof setInterval> | undefined;
        if (detail.assignedAgentId && detail.checkedOutBy === detail.assignedAgentId) {
          const leaseEpoch = detail.checkoutLeaseEpoch ?? 0;
          const checkoutNodeId = detail.checkoutNodeId ?? detail.effectiveNodeId ?? detail.nodeId ?? "local";
          const runId = deps.getRunContextFor(task.id)?.runId;
          await deps.renewTaskLease(task.id, detail.assignedAgentId, leaseEpoch, checkoutNodeId, runId).catch(() => {});
          leaseRenewalTimer = setInterval(() => {
            void deps.renewTaskLease(task.id, detail.assignedAgentId!, leaseEpoch, checkoutNodeId, runId).catch(() => {});
          }, 30_000);
        }

        // Register with stuck task detector for heartbeat monitoring
        stuckDetector?.trackTask(task.id, session);
        executorLog.debug(`${task.id}: session registered (model=${describeModel(session)}, stuckDetector=${!!stuckDetector})`);

        // Invoke plugin onAgentRunStart hook (fire-and-forget)
        void deps.options.pluginRunner?.invokeHookSafe("onAgentRunStart", task.id);

        try {
          // Record activity on prompt start (heartbeat for stuck detection)
          stuckDetector?.recordActivity(task.id);

          executorLog.debug(`${task.id}: calling promptWithFallback()...`);
          if (isResuming) {
            // Session already has full conversation history — just tell the
            // agent it was paused and should pick up where it left off.
            await promptWithFallback(session, [
              "Your session was paused and has now been resumed.",
              "Continue working on the task from where you left off.",
              "Review the current state of your worktree and proceed with the next pending step.",
            ].join("\n"));
          } else {
            const customFieldDefs = await deps.resolveTaskCustomFieldDefs(task.id);
            const pluginTaskContributions = await buildPluginPromptSection("executor-task", deps.options.pluginRunner);
            const agentPrompt = buildExecutionPrompt(
              detail,
              deps.rootDir,
              settings,
              worktreePath,
              deps.options.pluginRunner,
              customFieldDefs,
              deps.workspaceConfig,
              {
                pluginTaskContributions,
              },
            );
            await promptWithFallback(session, agentPrompt);
          }

          // Re-raise errors that pi-coding-agent swallowed after exhausting retries.
          // session.prompt() resolves normally even when retries are exhausted —
          // the error is stored on session.state.error instead of being thrown.
          checkSessionError(session);
          await deps.persistTokenUsage(task.id, session);

          // Check if proactive context compaction is needed based on token cap setting.
          // This runs after the main prompt completes to avoid interrupting active work.
          try {
            const capResult = await deps.tokenCapDetector.checkAndCompact(
              session,
              task.id,
              settings.tokenCap,
              async (s) => {
                const compactResult = await compactSessionContext(s);
                if (compactResult) {
                  await deps.store.logEntry(
                    task.id,
                    `Context compacted at ${compactResult.tokensBefore} tokens (token cap: ${settings.tokenCap})`,
                    undefined,
                    deps.getRunContextFor(task.id),
                  );
                }
                return compactResult;
              },
            );
            if (capResult.triggered) {
              executorLog.debug(`${task.id} token cap check: ${capResult.message}`);
            }
          } catch (err) {
            executorLog.debug(`${task.id} token cap check failed (non-fatal): ${err}`);
          }

          // If loop recovery is pending (compact-and-resume was triggered by
          // handleLoopDetected), consume the pending state and resume with a
          // deterministic prompt. The session has already been compacted, so
          // we just need to send a fresh prompt to continue execution.
          const loopState = deps.loopRecoveryState.get(task.id);
          if (loopState?.pending) {
            loopState.pending = false;
            executorLog.log(`${task.id} consuming loop recovery — resuming with fresh context`);
            await deps.store.logEntry(task.id, "Resuming execution after context compaction — taking a different approach", undefined, deps.getRunContextFor(task.id));

            // Reset activity tracking so the detector doesn't immediately re-trigger
            stuckDetector?.recordProgress(task.id);

            const resumePrompt = [
              "Your conversation was compacted because you were looping without making progress.",
              "Review the current state of the worktree carefully:",
              "1. Check `git log --oneline` to see what's already been committed",
              "2. Read the files you were working on to understand current state",
              "3. Review the PROMPT.md steps to see which are still pending",
              "",
              "Take a DIFFERENT approach from what you were doing before.",
              "If the current step is complete, call fn_task_update to mark it done and move to the next step.",
              "If you're stuck on a problem, try a simpler or alternative solution.",
              "",
              "Continue the task from where you left off.",
            ].join("\n");

            await promptWithFallback(session, resumePrompt);
            checkSessionError(session);
            await deps.persistTokenUsage(task.id, session);
          }

          // If dependency was added during execution, discard worktree and move to triage
          if (deps.depAborted.has(task.id)) {
            deps.depAborted.delete(task.id);
            await deps.handleDepAbortCleanup(task.id, worktreePath);
            return;
          }

          // If paused during execution, move to todo so the scheduler can resume
          // after unpause. This path fires when session.dispose() causes the
          // prompt to resolve gracefully instead of throwing.
          if (deps.pausedAborted.has(task.id)) {
            if (deps.userCanceledTaskIds.has(task.id)) {
              deps.clearPausedAborted(task.id);
              deps.stuckAborted.delete(task.id);
              deps.userCanceledTaskIds.delete(task.id);
              await deps.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
              return;
            }
            if (await deps.parkApprovalSuspension(task.id, "agent session")) {
              wasPaused = true;
              return;
            }
            deps.clearPausedAborted(task.id);
            wasPaused = true;
            const finalizationDecision = await deps.getCompletedTaskFinalizationDecision(task.id, taskDone);
            if (finalizationDecision === "finalize") {
              if (await deps.shouldDeferCompletionForGlobalPause(task.id, "paused after completion")) {
                return;
              }
              executorLog.log(`${task.id} paused after completion (graceful session exit) — finalizing to in-review`);
              await deps.store.logEntry(task.id, "Execution paused after completion — finalizing to in-review");
              await deps.persistTokenUsage(task.id);
              /*
              FNXC:WorkflowLifecycle 2026-06-17-23:33:
              FN-6625: the completed/no-commit handoff may dispose graph execution after the task is already in-review. Mark that abort as completion-finalize so a trailing FN-6614-style graph failure resolves benignly instead of looking like a user/global pause; FN-6568 uses the same provenance seam for merge aborts.

              FNXC:WorkflowLifecycle 2026-06-18-10:58:
              FN-6644/FN-6641: the graceful-session-exit handoff must also record durable completed-finalize state because a later teardown can re-mark the abort as `hard-cancel`. The classifier uses that durable handoff marker, not the volatile provenance alone, to keep completed no-commit tasks from being re-parked failed.
              */
              deps.markCompletionFinalized(task.id);
              reportImplementationExit?.("review-handoff-paused-after-completion");
              await deps.handoffTaskToReview(task, "paused-after-completion");
              deps.clearCompletedTaskWatchdog(task.id);
              deps.signalTaskComplete(task);
            } else if (finalizationDecision === "blocked") {
              await deps.persistTokenUsage(task.id);
              return;
            } else {
              executorLog.log(`${task.id} paused (graceful session exit) — moving to todo`);
              await deps.store.logEntry(task.id, "Execution paused — session preserved for resume, moved to todo");
              deps.markGraphExecuteSelfRequeued(task.id);
              await deps.store.moveTask(task.id, await resolveReboundColumnFor(deps.store, task.id), { preserveResumeState: true });
            }
            return;
          }

          // If the stuck task detector disposed the session and the agent exited
          // cleanly, stop here. The requeue is deferred to the finally block
          // (after deps.executing is cleared) to prevent a race where the
          // scheduler re-dispatches while the old execution guard is still set.
          if (deps.stuckAborted.has(task.id)) {
            if (deps.userCanceledTaskIds.has(task.id)) {
              deps.clearPausedAborted(task.id);
              deps.stuckAborted.delete(task.id);
              deps.userCanceledTaskIds.delete(task.id);
              await deps.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
              return;
            }
            stuckRequeue = deps.stuckAborted.get(task.id) ?? true;
            deps.stuckAborted.delete(task.id);
            executorLog.log(`${task.id} terminated by stuck task detector (graceful session exit)`);
            return;
          }

          // If the agent didn't explicitly call fn_task_done, check whether
          // all steps are already complete — treat as implicit done to avoid
          // unnecessary retry sessions for context-overflow / compaction cases.
          if (!taskDone) {
            const implicitCheck = await deps.store.getTask(task.id);
            if (implicitCheck.steps.length > 0 &&
                implicitCheck.steps.every((s) => s.status === "done" || s.status === "skipped")) {
              // Implicit and explicit paths share the same structural pending-review and bulk-step-completion guards.
              const refusal = evaluateImplicitCompletionRefusal(implicitCheck, codeReviewVerdicts);
              if (!refusal.ok) {
                await deps.handleImplicitTaskDoneRefusal(implicitCheck, refusal);
                return;
              }
              taskDone = true;
              executorLog.log(`${task.id} all steps done — treating as implicit fn_task_done`);
              await deps.store.logEntry(task.id, "All steps complete — implicit fn_task_done (agent did not call tool explicitly)", undefined, deps.getRunContextFor(task.id));
              deps.scheduleCompletedTaskWatchdog(task.id, "implicit fn_task_done");
            }
          }

          if (taskDone) {
            // Capture modified files before running workflow steps
            const updatedTask = await deps.store.getTask(task.id);
            const modifiedFiles = await deps.captureModifiedFiles(worktreePath, updatedTask.baseCommitSha, task.id, audit, "workflow-fanout");
            if (modifiedFiles.length > 0) {
              await deps.store.updateTask(task.id, { modifiedFiles });
              executorLog.log(`${task.id}: captured ${modifiedFiles.length} modified files`);
            }

            // Graph-driven completion (interpreter cutover): the workflow graph
            // owns workflow steps, review handoff, and merge from here — stop
            // at the implementation-complete boundary and hand control back.
            deps.clearCompletedTaskWatchdog(task.id);
            executorLog.log(`✓ ${task.id} implementation complete — graph interpreter owns the remaining lifecycle`);
            reportImplementationExit?.("complete");
            graphCompletion({ modifiedFiles });
            return;
          } else {
            let taskDoneSessionRetries = 0;
            let retryAbortedDueToReclaim = false;
            let refusalHandled = false;
            let pendingReviewParked = false;
            /* FNXC:ExecutorTaskDonePark 2026-07-15-16:10: FN-7965 — set when the row was terminally parked (status=failed) by the in-session fn_task_done refusal handler; suppresses both the retry and every post-loop completion/requeue branch so the park survives. */
            let terminallyParked = false;
            while (!taskDone && taskDoneSessionRetries < MAX_TASK_DONE_SESSION_RETRIES) {
              const liveTask = await deps.store.getTask(task.id);
              /*
              FNXC:ExecutorTaskDonePark 2026-07-15-16:10:
              FN-7965: the explicit `fn_task_done` tool handler parks the task terminally (status=failed, worktree/branch/sessionFile cleared) once the refusal retry budget is exhausted — but it runs INSIDE the agent session, so this loop never learned the row had been parked and spawned a retry session anyway. That session completed and marked the task done against a row with no worktree, so the pre-merge graph died on the first write-capable node with `no-worktree-for-write-node` and surfaced as a bogus "terminated at code-review-remediation" instead of the real refusal. Re-read state and honor the park.
              This deliberately does NOT reuse the FN-4806 reclaim branch below: that silently requeues to `todo`, which would clear the park and — with the refusal budget already exhausted — re-park on the next pickup, looping todo→execute→park. A terminal park is the agent's own failure and must stay parked for a human.
              Note the reclaim probes below cannot cover this: they test `liveTask.worktree === null`, but the store maps a cleared column to `undefined`, never `null` (`task-store/serialization.ts` — `row.worktree || undefined`). Tightening that probe is a separate change with real blast radius, so the park is detected by status here instead.
              */
              if (liveTask.status === "failed") {
                const parkMessage = `${task.id}: task parked failed during no-fn_task_done retry — honoring park, not retrying`;
                executorLog.log(parkMessage);
                await deps.store.logEntry(task.id, parkMessage, undefined, deps.getRunContextFor(task.id));
                deps.deleteActiveSession(task.id);
                deps.tokenUsageBaselines.delete(task.id);
                session.dispose();
                terminallyParked = true;
                break;
              }
              const hasExplicitWorktreeBinding = typeof liveTask.worktree === "string" || liveTask.worktree === null;
              const hasExplicitBranchBinding = typeof liveTask.branch === "string" || liveTask.branch === null;
              /* FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet): the contract holds while the card is
                 in ITS board's wip lane; the literal made every renamed-board retry look reclaimed. */
              const worktreeContractIntact = liveTask.column === (await deps.resolveResumeLanes(task.id)).wip
                && !liveTask.paused
                && (!hasExplicitWorktreeBinding || liveTask.worktree === worktreePath)
                && (!hasExplicitBranchBinding || (typeof liveTask.branch === "string" && liveTask.branch.length > 0));
              if (!worktreeContractIntact) {
                const reclaimMessage = `${task.id}: worktree/branch reclaimed during no-fn_task_done retry — aborting retry and requeueing`;
                executorLog.log(reclaimMessage);
                await deps.store.logEntry(task.id, reclaimMessage, undefined, deps.getRunContextFor(task.id));
                deps.deleteActiveSession(task.id);
                deps.tokenUsageBaselines.delete(task.id);
                session.dispose();
                retryAbortedDueToReclaim = true;
                break;
              }

              const pendingReviewBlock = detectPendingReviewBlock(liveTask, codeReviewVerdicts);
              if (pendingReviewBlock.blocked) {
                executorLog.log(
                  `[executor] ${task.id}: fn_task_done not called but task is blocked on pending review (${pendingReviewBlock.reason}) — skipping retry session`,
                );
                await deps.store.logEntry(
                  task.id,
                  `Agent finished without calling fn_task_done but Step ${pendingReviewBlock.stepIndex} is blocked on pending review (${pendingReviewBlock.reason}) — skipping retry session`,
                  undefined,
                  deps.getRunContextFor(task.id),
                );
                deps.deleteActiveSession(task.id);
                deps.tokenUsageBaselines.delete(task.id);
                session.dispose();
                await deps.persistTokenUsage(task.id);
                // A pending-review block is not an execution failure. The executor
                // cannot continue until the reviewer decision is resolved, so park
                // the task in review without setting status=failed; otherwise the
                // merge/review queue deadlocks on a task that is both in-review and
                // failed.
                /*
                FNXC:WorkflowExecutionOwnership 2026-07-29-18:50 (U8 / R4):
                The `handoffTaskToReview` call that stood here is GONE — the graph performs it via
                the `review-pending-handoff` node the live primitive now routes to. What remains is
                a report and a stop, which is all an implementation phase should do. Why review and
                not `failed` (a pending-review block is a wait; status=failed on an in-review row
                deadlocks the merge queue) now lives with the node in the IR, where the routing
                decision is.
                */
                reportImplementationExit?.("review-handoff-pending-review");
                pendingReviewParked = true;
                break;
              }

              taskDoneSessionRetries++;
              executorLog.log(
                `⚠ ${task.id} finished without fn_task_done — retrying with new session (${taskDoneSessionRetries}/${MAX_TASK_DONE_SESSION_RETRIES})`,
              );
              await deps.store.logEntry(
                task.id,
                `Agent finished without calling fn_task_done — retrying with new session (${taskDoneSessionRetries}/${MAX_TASK_DONE_SESSION_RETRIES})`,
                undefined,
                deps.getRunContextFor(task.id),
              );

              // Capture and analyse the previous session's text before resetting.
              const previousSessionText = lastAssistantText;
              const pseudoPause = detectPseudoPause(previousSessionText);

              if (pseudoPause.kind !== "none") {
                const shortMatch = (pseudoPause.matched ?? "").slice(0, 120);
                await deps.store.logEntry(
                  task.id,
                  `Pseudo-pause detected (kind=${pseudoPause.kind}, matched='${shortMatch}')`,
                  undefined,
                  deps.getRunContextFor(task.id),
                );
                executorLog.log(`${task.id} pseudo-pause detected (kind=${pseudoPause.kind}): ${shortMatch}`);
              }

              // Dispose old session and create a fresh one.
              // Reset lastAssistantText so the new session's text is tracked cleanly.
              lastAssistantText = "";
              deps.deleteActiveSession(task.id);
              deps.tokenUsageBaselines.delete(task.id);
              session.dispose();

              let retrySession: AgentSession | null = null;
              try {
                const createdRetrySession = await createResolvedAgentSession({
                  sessionPurpose: "executor",
                  runtimeHint: executorRuntimeHint,
                  pluginRunner: deps.options.pluginRunner,
                  cwd: worktreePath,
                  systemPrompt: executorSystemPromptFinal,
                  systemPromptLayers: executorLayers,
                  tools: "coding",
                  customTools,
                  onText: agentLogger.onText,
                  onThinking: agentLogger.onThinking,
                  onToolStart: agentLogger.onToolStart,
                  onToolEnd: agentLogger.onToolEnd,
                  defaultProvider: executorProvider,
                  defaultModelId: executorModelId,
                  ...(executorSessionModel.credentialInstanceId ? { credentialInstanceId: executorSessionModel.credentialInstanceId } : {}),
                  fallbackProvider: executorFallbackProvider,
                  fallbackModelId: executorFallbackModelId,
                  fallbackThinkingLevel: executorFallbackThinkingLevel,
                  defaultThinkingLevel: executorThinkingLevel,
                  runAuditor: audit,
                  settings,
                  sessionManager: SessionManager.create(worktreePath),
                  taskEnv,
                  mcpServers: await deps.resolveMcpServers(identityAgent?.id),
                  // FNXC:PluginSkills 2026-07-12-00:00: Retry executor sessions must keep the same plugin skill body discovery paths as the primary attempt so requested plugin skill names resolve to real bodies.
                  ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
                  ...(skillContext.additionalSkillPaths.length > 0 ? { additionalSkillPaths: skillContext.additionalSkillPaths } : {}),
                  // U5 (R5): retry session re-keys gating to the effective principal,
                  // mirroring the primary execute-seam session above.
                  actionGateContext: deps.buildActionGateContext(task.id, identityAgent, settings.defaultAgentPermissionPolicy),
                  permanentAgentGating: deps.buildPermanentAgentGatingContext(task.id, identityAgent, settings.defaultAgentPermissionPolicy),
                  // FNXC:SessionRouting 2026-06-24-11:20:
                  // #1675: propagate task id so retry-session requests carry the same
                  // X-Session-Id/X-Session-Affinity as the primary session, keeping the
                  // task's LLM requests grouped under one stable routing/observability id.
                  taskId: task.id,
                });
                retrySession = createdRetrySession.session;
                await deps.captureExecutorTokenUsageBaseline(task.id, retrySession);
                captureSessionTokenBaseline(retrySession);
                if (createdRetrySession.sessionFile) {
                  deps.store.updateTask(task.id, { sessionFile: createdRetrySession.sessionFile }).catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    executorLog.warn(`${task.id} failed to persist retry sessionFile: ${msg}`);
                  });
                }

                session = retrySession;
                sessionRef.current = retrySession;
                deps.setActiveSession(task.id, {
                  session: retrySession,
                  seenSteeringIds,
                  lastResolvedModelProvider: executorProvider,
                  lastResolvedModelId: executorModelId,
                  lastTaskModelProvider: detail.modelProvider,
                  lastTaskModelId: detail.modelId,
                  lastAssignedAgentId: detail.assignedAgentId ?? null,
                  // U5 (R7): preserve the effective column-agent across the retry.
                  lastEffectiveColumnAgentId: columnAgentSeam?.agent.id ?? null,
                }, worktreePath);
                stuckDetector?.trackTask(task.id, retrySession);

                const retryCustomFieldDefs = await deps.resolveTaskCustomFieldDefs(task.id);
                const retryPluginTaskContributions = await buildPluginPromptSection("executor-task", deps.options.pluginRunner);
                let retryPrompt: string;
                if (pseudoPause.kind !== "none") {
                  const shortMatch = (pseudoPause.matched ?? "").slice(0, 120);
                  retryPrompt = [
                    `Your previous turn ended with a pseudo-pause: "${shortMatch}". This is forbidden.`,
                    "",
                    "Turn-ending rules you violated:",
                    "- You MUST NOT end a turn by asking the user a question, summarizing progress, or requesting permission to continue.",
                    "- Phrases like 'If you want, I can continue', 'Should I proceed?', 'Let me know if...' are FORBIDDEN turn-endings.",
                    "- The user is not watching this conversation. Questions written as prose are ignored.",
                    "- If you genuinely cannot proceed, call fn_task_done with a clear explanation — never write the blocker as plain prose.",
                    "",
                    "What you must do now:",
                    "1. Review the PROMPT.md steps and identify the next pending step.",
                    "2. Do the work for that step immediately — call fn_task_update, write code, run tests.",
                    "3. Continue until all steps are done, then call fn_task_done.",
                    "Do NOT ask for permission. Do NOT write a summary. Just call a tool and keep working.",
                    "",
                    "Original task:",
                    buildExecutionPrompt(
                      detail,
                      deps.rootDir,
                      settings,
                      worktreePath,
                      deps.options.pluginRunner,
                      retryCustomFieldDefs,
                      deps.workspaceConfig,
                      {
                        pluginTaskContributions: retryPluginTaskContributions,
                      },
                    ),
                  ].join("\n");
                } else {
                  retryPrompt = [
                    "Your previous session ended without calling the fn_task_done tool.",
                    "The task may already be complete — review the current state of the worktree and either:",
                    "1. If the work is done, call fn_task_done with a summary of what was accomplished.",
                    "2. If there is remaining work, finish it and then call fn_task_done.",
                    "",
                    "Original task:",
                    buildExecutionPrompt(
                      detail,
                      deps.rootDir,
                      settings,
                      worktreePath,
                      deps.options.pluginRunner,
                      retryCustomFieldDefs,
                      deps.workspaceConfig,
                      {
                        pluginTaskContributions: retryPluginTaskContributions,
                      },
                    ),
                  ].join("\n");
                }

                stuckDetector?.recordActivity(task.id);
                await promptWithFallback(retrySession, retryPrompt);
                checkSessionError(retrySession);
                await deps.persistTokenUsage(task.id, retrySession);
              } catch (retryError) {
                deps.deleteActiveSession(task.id);
                deps.tokenUsageBaselines.delete(task.id);
                retrySession?.dispose();
                if (await deps.recoverMissingWorktreeSessionStartFailure(task, worktreePath, retryError, audit)) {
                  return;
                }
                throw retryError;
              }

              if (!taskDone) {
                const implicitCheck = await deps.store.getTask(task.id);
                if (implicitCheck.steps.length > 0 &&
                    implicitCheck.steps.every((s) => s.status === "done" || s.status === "skipped")) {
                  // Implicit and explicit paths share the same structural pending-review and bulk-step-completion guards.
                  const refusal = evaluateImplicitCompletionRefusal(implicitCheck, codeReviewVerdicts);
                  if (!refusal.ok) {
                    await deps.handleImplicitTaskDoneRefusal(implicitCheck, refusal);
                    retrySession?.dispose();
                    retrySession = null;
                    retryAbortedDueToReclaim = false;
                    refusalHandled = true;
                    break;
                  }
                  taskDone = true;
                  executorLog.log(`${task.id} all steps done — treating as implicit fn_task_done`);
                  await deps.store.logEntry(task.id, "All steps complete — implicit fn_task_done (agent did not call tool explicitly)", undefined, deps.getRunContextFor(task.id));
                  deps.scheduleCompletedTaskWatchdog(task.id, "implicit fn_task_done");
                }
              }
            }

            if (taskDone) {
              const updatedTask = await deps.store.getTask(task.id);
              const modifiedFiles = await deps.captureModifiedFiles(worktreePath, updatedTask.baseCommitSha, task.id, audit, "no-task-done-retry");
              if (modifiedFiles.length > 0) {
                await deps.store.updateTask(task.id, { modifiedFiles });
                executorLog.log(`${task.id}: captured ${modifiedFiles.length} modified files`);
              }

              deps.scheduleCompletedTaskWatchdog(task.id, "task completion retry");
              if (await deps.shouldDeferCompletionForGlobalPause(task.id, "before in-review transition after task completion retry")) {
                return;
              }

              // FNXC:WorkflowExecution 2026-06-25-00:00: U4 (KTD-2/KTD-5) — workflow
              // gates are graph-owned (record into task.workflowStepResults, U2); the
              // legacy runWorkflowSteps loop was deleted. For a graph-driven run the
              // execute seam registered a completion interceptor, so stop at the
              // implementation boundary and let the graph own the remaining
              // lifecycle. A non-graph fallback reaching here has NO enabled workflow
              // steps (a minimal store WITH enabled steps is parked fail-closed in
              // executeWorkflowGraph, KTD-5) — nothing to gate before handoff.
              deps.clearCompletedTaskWatchdog(task.id);
              executorLog.log(`✓ ${task.id} implementation complete (retry) — graph interpreter owns the remaining lifecycle`);
              reportImplementationExit?.("complete-after-retry");
              graphCompletion({ modifiedFiles });
              return;
            } else if (terminallyParked) {
              // FN-7965: the in-session refusal handler already wrote the terminal failure and cleared
              // the binding. Nothing further to do — requeueing or handing off to review here is exactly
              // the resurrection that stranded the pre-merge graph.
              await deps.persistTokenUsage(task.id);
              return;
            } else if (retryAbortedDueToReclaim) {
              // FN-4806: Worktree/branch was reclaimed mid-retry by an engine-side housekeeping path
              // (e.g. FN-4546 stale-active-branch reclaim, FN-4742 self-healing removals). This is NOT
              // an agent failure — the agent never got a fair retry attempt. Silently requeue to todo
              // with preserved progress so a fresh worktree is created on next pickup. Do not mark
              // status=failed, do not surface onError, do not burn taskDoneRetryCount budget.
              const silentMessage = `${task.id}: worktree/branch reclaimed mid-retry — requeued to todo (engine self-heal, no failure)`;
              await deps.store.logEntry(
                task.id,
                "Worktree/branch reclaimed mid-retry — requeued to todo (engine self-heal, no failure)",
                undefined,
                deps.getRunContextFor(task.id),
              );
              // Clear any stale binding so the next pickup creates a fresh worktree.
              // baseCommitSha is also cleared because it pinned to the now-reclaimed worktree;
              // the next pickup will re-anchor it on the fresh checkout.
              await deps.store.updateTask(task.id, { worktree: null, branch: null, baseCommitSha: null });
              await deps.persistTokenUsage(task.id);
              deps.markGraphExecuteSelfRequeued(task.id);
              await deps.store.moveTask(task.id, await resolveReboundColumnFor(deps.store, task.id), { preserveProgress: true });
              executorLog.log(silentMessage);
            } else if (refusalHandled) {
              return;
            } else if (pendingReviewParked) {
              return;
            } else {
              // FN-4806: Genuine "agent finished without calling fn_task_done after N retries"
              // exhaustion. Not a reclaim/self-heal — the agent had a fair chance and failed to
              // signal completion. Mark failed, surface onError, and either requeue (budget
              // remaining) or escalate to in-review (budget exhausted).
              const priorRequeues = task.taskDoneRetryCount ?? 0;
              const nextRequeueCount = priorRequeues + 1;
              const errorMessage = `Agent finished without calling fn_task_done (after ${MAX_TASK_DONE_SESSION_RETRIES} retries)`;

              if (priorRequeues < MAX_TASK_DONE_REQUEUE_RETRIES) {
                await deps.store.updateTask(task.id, {
                  status: "queued",
                  error: null,
                  taskDoneRetryCount: nextRequeueCount,
                });
                await deps.store.logEntry(
                  task.id,
                  `${errorMessage} — requeued to todo immediately (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`,
                  undefined,
                  deps.getRunContextFor(task.id),
                );
                deps.markGraphExecuteSelfRequeued(task.id);
                await deps.store.moveTask(task.id, await resolveReboundColumnFor(deps.store, task.id), { preserveProgress: true });
                executorLog.log(`✗ ${task.id} failed after ${MAX_TASK_DONE_SESSION_RETRIES} retries — requeued to todo (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`);
              } else {
                await deps.store.updateTask(task.id, { status: "failed", error: errorMessage });
                await deps.store.logEntry(task.id, `${errorMessage} — execution failed after task-done retry budget was exhausted`, undefined, deps.getRunContextFor(task.id));
                await deps.persistTokenUsage(task.id);
                executorLog.log(`✗ ${task.id} failed after ${MAX_TASK_DONE_SESSION_RETRIES} retries — no fn_task_done`);
              }
              deps.options.onError?.(task, new Error(errorMessage));
            }
          }
        } finally {
          clearInterval(verificationRequestTimer);
          if (leaseRenewalTimer) {
            clearInterval(leaseRenewalTimer);
          }
          deps.deleteActiveSession(task.id);
          stuckDetector?.untrackTask(task.id);
          await agentLogger.flush();
          await deps.persistTokenUsage(task.id, session).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            executorLog.warn(`${task.id}: failed to persist final single-session token usage before dispose: ${msg}`);
          });
          deps.tokenUsageBaselines.delete(task.id);
          resetSessionTokenBaseline(session);
          session.dispose();
          // Terminate all spawned child agents when parent session ends
          await deps.terminateAllChildren(task.id);
          // Clear session file when task completes or fails (not when paused —
          // the file is preserved so unpause can resume the conversation).
          // Check both the local flag (graceful exit) and the instance set
          // (error path where dispose caused prompt to throw).
          if (!wasPaused && !deps.pausedAborted.has(task.id)) {
            deps.store.updateTask(task.id, { sessionFile: null }).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              executorLog.warn(`${task.id} failed to clear sessionFile: ${msg}`);
            });
          }
          // Invoke plugin onAgentRunEnd hook (fire-and-forget)
          void deps.options.pluginRunner?.invokeHookSafe("onAgentRunEnd", task.id);
        }
      };

      const retryableWork = () => withRateLimitRetry(agentWork, {
        signal: deps.activeWorkflowGraphAbortControllers.get(task.id)?.signal,
        rotation: deps.options.credentialRotator ? {
          providerId: activeAgentInstanceRef?.providerId ?? detail.modelProvider ?? "",
          nextInstance: async () => {
            /*
            FNXC:CredentialInstanceRotation 2026-08-01-11:05:
            Executor agent runs rotate only after the shared retry helper classifies a
            usage limit. Live task/settings reads and the executor pause-abort marker
            bail before opening an event, because a pause arriving mid-run cannot
            authorize changing the billed credential. A successful offer causes
            agentWork to construct a fresh session; a non-limit failure intentionally
            leaves its attempt without an outcome row.
            */
            const [liveTask, liveSettings] = await Promise.all([
              deps.store.getTask(task.id).catch(() => undefined),
              deps.store.getSettings().catch(() => settings),
            ]);
            if (agentRotationDeclined || deps.pausedAborted.has(task.id) || !liveTask
              || liveTask.userPaused === true || liveTask.autoMerge === false
              || liveSettings.globalPause === true || liveSettings.enginePaused === true
              || !activeAgentInstanceRef?.providerId) return undefined;
            agentRotationEvent ??= await deps.options.credentialRotator!.beginEvent({
              providerId: activeAgentInstanceRef.providerId,
              startingInstanceId: activeAgentInstanceRef.instanceId,
              lane: "executor-agent",
              taskId: task.id,
            });
            if (!agentRotationEvent) { agentRotationDeclined = true; return undefined; }
            // FNXC:CredentialInstanceRotation 2026-08-01-11:34: Inventory lookup is asynchronous; re-check human control before this retry marks a credential limited or offers another billed account.
            const [postInventoryTask, postInventorySettings] = await Promise.all([
              deps.store.getTask(task.id).catch(() => undefined),
              deps.store.getSettings().catch(() => settings),
            ]);
            if (deps.pausedAborted.has(task.id) || !postInventoryTask
              || postInventoryTask.userPaused === true || postInventoryTask.autoMerge === false
              || postInventorySettings.globalPause === true || postInventorySettings.enginePaused === true) return undefined;
            deps.options.credentialRotator!.markLimited(activeAgentInstanceRef);
            if (agentDispatchedRotation) agentRotationEvent.recordOutcome("rotation-failed-limit");
            const next = await agentRotationEvent.next();
            if (!next) { agentRotationEvent.finishExhausted(); return undefined; }
            activeAgentInstanceRef = next;
            agentDispatchedRotation = true;
            return next;
          },
        } : undefined,
        onRetry: (attempt, delayMs, error) => {
          const delaySec = Math.round(delayMs / 1000);
          executorLog.warn(`⏳ ${task.id} rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
          deps.store.logEntry(task.id, `Rate limited — retry ${attempt} in ${delaySec}s`, undefined, deps.getRunContextFor(task.id)).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            executorLog.warn(`${task.id} failed to log rate-limit retry: ${msg}`);
          });
        },
      });

      await deps.runWithExecutorSemaphore(task.id, retryableWork);
      if (agentDispatchedRotation) agentRotationEvent?.recordOutcome("rotation-succeeded");
    } catch (err: unknown) {
      const { message: errorMessage, detail: errorDetail, stack: errorStack } = formatError(err);
      if (deps.depAborted.has(task.id)) {
        // Dependency added mid-execution — discard worktree and move to triage
        deps.depAborted.delete(task.id);
        await deps.handleDepAbortCleanup(task.id, worktreePath);
      } else if (isInvalidAssistantContinuationErrorMessage(errorMessage)) {
        /*
        FNXC:PostDoneContinuation 2026-07-16-11:57:
        FN-8111 requires a completed task to win over stale-transcript retry handling. An assistant-last error after the task already reached in-review must signal completion and clear the watchdog rather than create a deferred retry that never dispatches.
        */
        if (await deps.handleNonContinuableSessionError(task, taskDone, errorMessage)) {
          return;
        }
        /*
        FNXC:ExecutorSessionRecovery 2026-07-14-06:03:
        A stale assistant-last transcript gets a bounded fresh-session retry with the shared recovery backoff. The retry counter must survive the deferred move so repeated fresh-session failures eventually become a visible execution failure instead of cycling through Todo forever.

        FNXC:ExecutorSessionRecovery 2026-07-14-06:19:
        Deferred self-requeues must mark the workflow graph recovery and release the active worktree slot after the executor lock drops; otherwise graph failure cleanup can overwrite the recovery and the parked task can keep consuming maxWorktrees capacity.
        */
        const liveTask = await deps.store.getTask(task.id);
        const decision = computeRecoveryDecision({
          recoveryRetryCount: liveTask.recoveryRetryCount,
          nextRecoveryAt: liveTask.nextRecoveryAt,
        });
        if (!decision.shouldRetry) {
          executorLog.error(`✗ ${task.id} stale assistant-continuation retries exhausted (${MAX_RECOVERY_RETRIES} attempts): ${errorMessage}`);
          await deps.store.logEntry(
            task.id,
            `Stale assistant-continuation fresh-session retries exhausted after ${MAX_RECOVERY_RETRIES} attempts: ${errorMessage}`,
            errorStack ?? errorDetail,
            deps.getRunContextFor(task.id),
          );
          await deps.store.updateTask(task.id, {
            status: "failed",
            error: errorMessage,
            recoveryRetryCount: null,
            nextRecoveryAt: null,
          });
          await deps.persistTokenUsage(task.id);
          deps.options.onError?.(task, err instanceof Error ? err : new Error(errorMessage));
          return;
        }

        staleAssistantContinuationRequeue = true;
        const attempt = decision.nextState.recoveryRetryCount;
        const delay = formatDelay(decision.delayMs);
        executorLog.warn(`${task.id} stale assistant-continuation session detected — fresh-session retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay} after executor lock release`);
        await deps.store.logEntry(
          task.id,
          `Detected stale assistant-continuation session — fresh-session retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay} with progress preserved: ${errorMessage}`,
          undefined,
          deps.getRunContextFor(task.id),
        );
        await deps.store.updateTask(task.id, {
          sessionFile: null,
          recoveryRetryCount: decision.nextState.recoveryRetryCount,
          nextRecoveryAt: decision.nextState.nextRecoveryAt,
        });
        return;
      } else if (errorMessage.includes("Invalid transition")) {
        // Task was moved by user/process while executor was running — already in desired state
        // This check must come before pausedAborted since it's more specific
        const transitionMatch = errorMessage.match(/Invalid transition: '([^']+)' → '([^']+)'/);
        const fromColumn = transitionMatch?.[1] ?? "unknown";
        const toColumn = transitionMatch?.[2] ?? "unknown";
        const logMessage = `Task already moved from '${fromColumn}' — skipping transition to '${toColumn}'`;
        executorLog.log(`${task.id} ${logMessage}`);
        await deps.store.logEntry(task.id, logMessage, errorMessage, deps.getRunContextFor(task.id));
        /*
        FNXC:WorkflowResolvedColumns 2026-07-31-09:25 (fleet: executor lifecycle roles):
        `fromColumn`/`toColumn` are parsed out of the store's rejection message, so they carry
        whatever ids that workflow declares. Comparing them to the literal `in-review` meant a
        renamed review lane never matched and the duplicate-handoff finalize never ran, leaving
        the card mid-transition with nothing to complete it. Resolve the task's own review role;
        an unresolvable workflow keeps the legacy literal, so behaviour is unchanged wherever the
        vocabulary cannot be read.
        */
        const reviewLane = (await resolveTaskLifecycleColumns(deps.store, task.id).catch(() => undefined))?.review ?? "in-review";
        if (fromColumn === reviewLane && toColumn === reviewLane) {
          try {
            const finalizeResult = await deps.finalizeAlreadyReviewedTask(task.id);
            executorLog.debug(`${task.id} duplicate in-review finalization result: ${finalizeResult}`);
          } catch (finalizeErr: unknown) {
            const finalizeErrMessage = finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr);
            executorLog.warn(`${task.id} failed to finalize duplicate in-review transition: ${finalizeErrMessage}`);
          }
        }
        // Task finished successfully (just already moved), so call onComplete
        deps.signalTaskComplete(task);
      } else if (deps.pausedAborted.has(task.id)) {
        // Task was paused mid-execution — clean up worktree and move to todo
        if (deps.userCanceledTaskIds.has(task.id)) {
          deps.clearPausedAborted(task.id);
          deps.stuckAborted.delete(task.id);
          deps.userCanceledTaskIds.delete(task.id);
          await deps.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
          return;
        }
        if (await deps.parkApprovalSuspension(task.id, "executor session")) return;
        deps.clearPausedAborted(task.id);
        const latestTask = await deps.store.getTask(task.id);
        if (
          /* FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet): the HOLD lane — this recognises a card the
             abort already parked with its progress preserved, and skipping the cleanup is what keeps that
             progress. On a renamed board the cleanup ran anyway and discarded it. */
          latestTask?.column === (await deps.resolveResumeLanes(task.id)).hold &&
          latestTask.paused === true &&
          ((latestTask.currentStep ?? 0) > 0 || latestTask.steps?.some((step) => step.status === "done" || step.status === "in-progress"))
        ) {
          executorLog.debug(`${task.id} paused-abort cleanup skipped — incomplete task is already parked with progress preserved`);
          await deps.store.logEntry(
            task.id,
            "Execution abort cleanup skipped — incomplete stuck-loop task is already parked with progress preserved",
            undefined,
            deps.getRunContextFor(task.id),
          );
          return;
        }
        const finalizationDecision = await deps.getCompletedTaskFinalizationDecision(task.id, taskDone);
        if (finalizationDecision === "finalize") {
          if (await deps.shouldDeferCompletionForGlobalPause(task.id, "paused after completion")) {
            return;
          }
          executorLog.log(`${task.id} paused after completion — finalizing to in-review`);
          await deps.store.logEntry(task.id, "Execution paused after completion — finalizing to in-review", undefined, deps.getRunContextFor(task.id));
          await deps.persistTokenUsage(task.id);
          /*
          FNXC:WorkflowLifecycle 2026-06-17-23:33:
          FN-6625: the completed/no-commit handoff may dispose graph execution after the task is already in-review. Mark that abort as completion-finalize so a trailing FN-6614-style graph failure resolves benignly instead of looking like a user/global pause; FN-6568 uses the same provenance seam for merge aborts.

          FNXC:WorkflowLifecycle 2026-06-18-10:59:
          FN-6644/FN-6641: the finally-block handoff must record durable completed-finalize state because a later teardown can overwrite provenance to `hard-cancel`. The classifier must still resolve that completed no-commit tail failure benignly without weakening genuine pause or active hard-cancel behavior.
          */
          deps.markCompletionFinalized(task.id);
          reportImplementationExit?.("review-handoff-paused-after-completion");
              await deps.handoffTaskToReview(task, "paused-after-completion");
          deps.signalTaskComplete(task);
        } else if (finalizationDecision === "blocked") {
          await deps.persistTokenUsage(task.id);
          return;
        } else {
          executorLog.log(`${task.id} paused — moving to todo`);
          if (worktreePath && existsSync(worktreePath)) {
            try {
              const settings = await deps.store.getSettings();
              await removeWorktree({
                worktreePath,
                rootDir: deps.rootDir,
                settings,
                taskId: task.id,
                audit,
                reason: RemovalReason.ExecutorDispose,
                expectedOwnerTaskId: task.id,
                liveOwnerProbe: (path, ownerTaskId) => deps.hasActiveWorktreeBinding(ownerTaskId, path),
              });
              executorLog.log(`Removed old worktree for paused task: ${worktreePath}`);
            } catch (cleanupErr: unknown) {
              const cleanupErrMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
              executorLog.warn(`Failed to remove old worktree ${worktreePath}: ${cleanupErrMessage}`);
            }
          }
          // FNXC:WorkflowLifecycle 2026-06-21-00:00: FN-6722 — a mid-run abort on
          // a task that already has real step progress must not discard that
          // progress on the bounce to todo. The sibling pause-park path moves
          // with preserveResumeState;
          // this teardown branch historically did not — it cleared `branch` AND
          // moved without preservation, which reset every step to pending
          // (store.moveTaskInternal ~7322 resetAllStepsToPending) and dropped the
          // pointer to the commits already on the task branch. The next dispatch
          // then re-planned from Step 0 even though the work was committed on the
          // branch — observably a "lost all progress / stuck" failure. Preserve the
          // branch + resume state when there is resumable progress so execute()
          // resumes onto the existing branch (the `acquisition.isResume &&
          // task.branch` reconciliation ~7679) from the first incomplete step. The
          // worktree is still removed above and its binding cleared below to free
          // the concurrency slot (FN-6782) — only the durable pointers (branch +
          // step state) are kept. The 9227 guard above covers the same intent but
          // is race-contingent on the move having already landed; this makes the
          // fall-through path safe regardless.
          //
          // Read progress from `latestTask` (the store snapshot fetched at ~9226),
          // NOT the `task` parameter: `task` is frozen at dispatch time and never
          // mutated mid-run, so a fresh task (currentStep 0, all steps pending at
          // dispatch) whose agent committed step progress to the store during this
          // session would otherwise look progress-less here and hit the destructive
          // reset — the exact FN-6722 failure mode. Fall back to `task` when the
          // store read came back empty.
          const progressSource = latestTask ?? task;
          const hasResumableProgress =
            (progressSource.currentStep ?? 0) > 0
            || (progressSource.steps?.some((step) => step.status === "done" || step.status === "in-progress") ?? false);
          /*
          FNXC:WorkflowLifecycle 2026-07-12-09:05:
          Pause-bounce loop (observed on FN-7851): this teardown runs BECAUSE the user paused the task, but the plain move-to-todo below wiped the pause flags (store reopen block), leaving an unpaused dispatchable todo row. The graph-failure classifier then read `paused=false, userPaused=false`, misclassified the abort as engine-internal, and auto-continued the session; once the shared graphResumeRetryCount budget was exhausted the scheduler simply re-dispatched the row seconds later — so pausing an in-progress task could never stick. When the pause that caused this abort is still in force at teardown time, move with `preservePause` so the row lands in todo still parked (`paused` kept; scheduler skips paused/userPaused todo rows) and the classifier sees the pause and routes benignly. An unpause during the teardown window leaves `paused` unset and restores the old requeue-for-normal-scheduling behavior.
          */
          const pauseStillInForce = latestTask?.paused === true;
          await deps.store.updateTask(
            task.id,
            hasResumableProgress ? { worktree: undefined } : { worktree: undefined, branch: undefined },
          );
          await deps.store.logEntry(
            task.id,
            pauseStillInForce
              ? "Execution paused — agent terminated, parked in todo (pause preserved, awaiting explicit unpause)"
              : "Execution paused — agent terminated, moved to todo",
            undefined,
            deps.getRunContextFor(task.id),
          );
          deps.markGraphExecuteSelfRequeued(task.id);
          await deps.store.moveTask(task.id, await resolveReboundColumnFor(deps.store, task.id), {
            ...(hasResumableProgress ? { preserveResumeState: true } : {}),
            ...(pauseStillInForce ? { preservePause: true } : {}),
          });
        }
      } else if (deps.stuckAborted.has(task.id)) {
        // Task was killed by stuck task detector — defer requeue to finally block
        // (after deps.executing is cleared) to prevent re-dispatch race.
        if (deps.userCanceledTaskIds.has(task.id)) {
          deps.clearPausedAborted(task.id);
          deps.stuckAborted.delete(task.id);
          deps.userCanceledTaskIds.delete(task.id);
          await deps.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
          return;
        }
        stuckRequeue = deps.stuckAborted.get(task.id) ?? true;
        deps.stuckAborted.delete(task.id);
        executorLog.log(`${task.id} terminated by stuck task detector — will ${stuckRequeue ? "retry" : "not retry (budget exhausted)"}`);
      } else {
        // Context-limit error reached the executor after promptWithFallback's auto-compaction
        // already attempted to recover. Recovery strategy (in order):
        //   1. Reduced-prompt retry in the same session (up to MAX_REDUCED_PROMPT_ATTEMPTS)
        //   2. Fresh-session requeue — terminate the saturated session and move the task
        //      back to "todo" so the next dispatch gets a clean session (bounded by
        //      recoveryRetryCount / MAX_RECOVERY_RETRIES).
        // FN-2182 class: Step 7 overflow after earlier compaction used to hit the
        // loopAttempts<1 guard and fail permanently; the requeue path below recovers
        // by restarting with a fresh session against the already-written step output.
        const MAX_REDUCED_PROMPT_ATTEMPTS = 3;
        const loopState = deps.loopRecoveryState.get(task.id);
        const loopAttempts = loopState?.attempts ?? 0;
        const isContextError = isContextLimitError(errorMessage);

        if (isContextError && loopAttempts < MAX_REDUCED_PROMPT_ATTEMPTS) {
          const activeEntry = deps.activeSessions.get(task.id);
          if (activeEntry) {
            executorLog.log(`${task.id} context limit error after auto-compaction — attempting reduced-prompt retry (${loopAttempts + 1}/${MAX_REDUCED_PROMPT_ATTEMPTS})`);
            await deps.store.logEntry(task.id, `Context limit error after auto-compaction — attempting reduced-prompt retry (${loopAttempts + 1}/${MAX_REDUCED_PROMPT_ATTEMPTS}): ${errorMessage}`, undefined, deps.getRunContextFor(task.id));

            deps.loopRecoveryState.set(task.id, { attempts: loopAttempts + 1, pending: false });

            try {
              deps.options.stuckTaskDetector?.recordProgress(task.id);
              // Build a reduced prompt that's simpler and shorter to avoid context overflow
              const reducedPrompt = [
                "Your previous attempt hit the context window limit.",
                "Focus on completing the task efficiently with minimal context:",
                "1. Review git status and git log to see what's been done",
                "2. Identify the most critical remaining work",
                "3. Complete it with a simpler, more focused approach",
                "",
                "Do not repeat what's already been done. Just complete the task and call fn_task_done.",
              ].join("\n");

              await promptWithFallback(activeEntry.session!, reducedPrompt);
              checkSessionError(activeEntry.session!);
              await deps.persistTokenUsage(task.id, activeEntry.session);

              // Reduced-prompt retry succeeded — return to let the finally block clean up
              // without marking the task as failed.
              executorLog.log(`${task.id} reduced-prompt recovery succeeded — continuing`);
              await deps.store.logEntry(task.id, "Reduced-prompt recovery succeeded — continuing execution", undefined, deps.getRunContextFor(task.id));
              return;
            } catch (reducedErr: unknown) {
              const reducedErrorMessage = reducedErr instanceof Error ? reducedErr.message : String(reducedErr);
              if (!isContextLimitError(reducedErrorMessage)) {
                executorLog.error(`${task.id} reduced-prompt recovery also failed: ${reducedErrorMessage}`);
                await deps.store.logEntry(task.id, `Reduced-prompt recovery failed: ${reducedErrorMessage}`, undefined, deps.getRunContextFor(task.id));
                // Non-context failure — fall through to mark task as failed
              } else {
                // Still a context error — the session is saturated beyond recovery.
                // Fall through to the fresh-session requeue path below.
                executorLog.warn(`${task.id} session still saturated after reduced-prompt retry — will attempt fresh-session requeue`);
                await deps.store.logEntry(task.id, `Reduced-prompt retry still over context — will attempt fresh-session requeue`, undefined, deps.getRunContextFor(task.id));
              }
            }
          }
        }

        // Fresh-session requeue for context-limit errors: the saturated session
        // cannot be salvaged, but the task's git state is intact. Move the task
        // back to todo so the next scheduling pass creates a new session.
        if (isContextError) {
          const decision = computeRecoveryDecision({
            recoveryRetryCount: task.recoveryRetryCount,
            nextRecoveryAt: task.nextRecoveryAt,
          });

          if (decision.shouldRetry) {
            const attempt = decision.nextState.recoveryRetryCount;
            const delay = formatDelay(decision.delayMs);
            executorLog.warn(`⚡ ${task.id} context-overflow fresh-session requeue ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}`);
            await deps.store.logEntry(task.id, `Context-overflow fresh-session requeue (${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}): ${errorMessage}`, undefined, deps.getRunContextFor(task.id));
            // Retain the worktree and accumulated step progress so the fresh
            // session resumes where the saturated one left off, but clear
            // sessionFile synchronously here so the next dispatch is forced
            // to spawn a brand-new session instead of reopening the
            // over-context one. The session-end finally block also clears
            // sessionFile, but it runs as fire-and-forget — if moveTask
            // wins the task lock first, the next executor pass would
            // observe a stale sessionFile and resume into the saturated
            // session, looping on the same context-limit failure.
            await deps.store.updateTask(task.id, {
              recoveryRetryCount: decision.nextState.recoveryRetryCount,
              nextRecoveryAt: decision.nextState.nextRecoveryAt,
              sessionFile: null,
            });
            deps.markGraphExecuteSelfRequeued(task.id);
            await deps.store.moveTask(task.id, await resolveReboundColumnFor(deps.store, task.id), { preserveResumeState: true });
            return;
          }

          executorLog.error(`✗ ${task.id} context-overflow requeue budget exhausted (${MAX_RECOVERY_RETRIES} attempts): ${errorMessage}`);
          await deps.store.logEntry(task.id, `Context-overflow requeues exhausted after ${MAX_RECOVERY_RETRIES} attempts: ${errorMessage}`, undefined, deps.getRunContextFor(task.id));
          // Reset so downstream failure path can persist cleanly
          await deps.store.updateTask(task.id, {
            recoveryRetryCount: null,
            nextRecoveryAt: null,
          });
          // Fall through to terminal failure marking
        // Contamination recovery lives in executor because branch cross-contamination
        // is surfaced here from task execution preflight; merger empty-cherry-pick
        // handling does not throw BranchCrossContaminationError in its own path.
        } else if (err instanceof BranchCrossContaminationError) {
          const details = err.foreignCommits
            .map((commit) => `${commit.sha.slice(0, 12)}:${commit.foreignTaskId}`)
            .join(", ");
          await deps.store.logEntry(task.id, `[recovery] branch cross-contamination detected on ${err.branchName} since ${err.baseSha}: ${details}`, undefined, deps.getRunContextFor(task.id));

          try {
            const recoveredBootstrapMisbinding = await deps.tryBootstrapMisbindingRecovery(task, err, audit);
            if (recoveredBootstrapMisbinding) {
              return;
            }

            const classified = await classifyForeignCommits({
              repoDir: deps.rootDir,
              branchName: err.branchName,
              baseSha: err.baseSha,
              foreignCommits: err.foreignCommits,
            });

            const misrouted: Array<{ commit: (typeof classified.unique)[number]; foreignTaskId: string; paths: string[] }> = [];
            const preOrphanUnique: typeof classified.unique = [];
            for (const commit of classified.unique) {
              const misroutedResult = await classifyMisroutedForeignCommit({
                repoDir: deps.rootDir,
                sha: commit.sha,
                commitSubject: commit.subject,
                commitBody: await execAsync(`git log -1 --format=%b ${commit.sha}`, { cwd: deps.rootDir, encoding: "utf-8" }).then((r: { stdout: string }) => r.stdout).catch(() => ""),
                currentTaskId: task.id,
              });
              if (misroutedResult.misrouted && misroutedResult.foreignTaskId) {
                misrouted.push({ commit, foreignTaskId: misroutedResult.foreignTaskId, paths: misroutedResult.paths ?? [] });
              } else {
                preOrphanUnique.push(commit);
              }
            }

            // Orphan-our-advance: a "unique" foreign commit attributed to a
            // task that's already `done` is a stranded merge from the pre-FF
            // ref-advance bug. FF-rehomeable orphans are advanced onto the
            // integration branch and then dropped from this task's branch
            // alongside already-upstream commits. Non-FF orphans (diverged
            // from current integration tip) are logged with a cherry-pick
            // hint and left as `genuinelyUnique` for human adjudication.
            const rehomedOrphans: typeof classified.unique = [];
            const genuinelyUnique: typeof classified.unique = [];
            const integrationBranchForOrphan = task.mergeDetails?.mergeTargetBranch
              ?? task.baseBranch
              ?? "main";
            for (const commit of preOrphanUnique) {
              const orphanBody = await execAsync(`git log -1 --format=%b ${commit.sha}`, { cwd: deps.rootDir, encoding: "utf-8" })
                .then((r: { stdout: string }) => r.stdout)
                .catch(() => "");
              const orphanClass = await classifyOrphanOurAdvance({
                repoDir: deps.rootDir,
                taskStore: deps.store,
                integrationBranch: integrationBranchForOrphan,
                currentTaskId: task.id,
                commitSha: commit.sha,
                commitSubject: commit.subject,
                commitBody: orphanBody,
              });
              if (!orphanClass.orphan) {
                genuinelyUnique.push(commit);
                continue;
              }
              const rehome = await rehomeOrphanOntoIntegration({
                rootDir: deps.rootDir,
                projectRootDir: deps.rootDir,
                integrationBranch: integrationBranchForOrphan,
                orphanSha: commit.sha,
                taskId: task.id,
                audit,
              }).catch((rehomeError: unknown): { rehomed: false; reason: string } => ({
                rehomed: false,
                reason: rehomeError instanceof Error ? rehomeError.message : String(rehomeError),
              }));
              if (rehome.rehomed) {
                rehomedOrphans.push(commit);
                await deps.store.logEntry(
                  task.id,
                  `[recovery] rehomed orphan-our-advance commit ${commit.sha.slice(0, 12)} (source ${orphanClass.sourceTaskId}) onto ${integrationBranchForOrphan} via fast-forward; dropping from branch`,
                  undefined,
                  deps.getRunContextFor(task.id),
                );
              } else {
                const hint = "cherryPickHint" in rehome && rehome.cherryPickHint
                  ? ` — manual rehome: \`${rehome.cherryPickHint}\``
                  : "";
                await deps.store.logEntry(
                  task.id,
                  `[recovery] orphan-our-advance commit ${commit.sha.slice(0, 12)} (source ${orphanClass.sourceTaskId}) refused auto-rehome: ${rehome.reason}${hint}`,
                  undefined,
                  deps.getRunContextFor(task.id),
                );
                genuinelyUnique.push(commit);
              }
            }

            const alreadyShas = classified.alreadyUpstream.map((commit) => commit.sha.slice(0, 12)).join(", ") || "none";
            const misroutedShas = misrouted.map(({ commit }) => commit.sha.slice(0, 12)).join(", ") || "none";
            const rehomedShas = rehomedOrphans.map((commit) => commit.sha.slice(0, 12)).join(", ") || "none";
            const uniqueShas = genuinelyUnique.map((commit) => commit.sha.slice(0, 12)).join(", ") || "none";
            await deps.store.logEntry(
              task.id,
              `[recovery] contamination classification: already-upstream=[${alreadyShas}] misrouted=[${misroutedShas}] rehomed-orphan=[${rehomedShas}] unique=[${uniqueShas}]`,
              undefined,
              deps.getRunContextFor(task.id),
            );

            const alreadyAttemptedRecovery = (task.recoveryRetryCount ?? 0) > 0;
            if (genuinelyUnique.length === 0 && !alreadyAttemptedRecovery) {
              // Run the recovery inside the worktree (when one exists) so the final
              // `git checkout <branch>` step doesn't collide with the worktree's own
              // checkout. If we operate from deps.rootDir while the branch is checked
              // out in a worktree, git refuses the recheckout with
              // "branch already used by worktree" and the in-line happy path silently
              // fails — every contaminated task would then fall through to the
              // dispatcher pause path even when it could have auto-recovered.
              const recoveryRepoDir = task.worktree ?? deps.rootDir;
              const recovery = await autoRecoverCrossContamination({
                repoDir: recoveryRepoDir,
                branchName: err.branchName,
                baseSha: err.baseSha,
                taskId: task.id,
                shasToDrop: [
                  ...classified.alreadyUpstream.map((commit) => commit.sha),
                  ...misrouted.map(({ commit }) => commit.sha),
                  ...rehomedOrphans.map((commit) => commit.sha),
                ],
              });

              await deps.store.logEntry(
                task.id,
                `[recovery] auto-recovered branch-cross-contamination: dropped ${recovery.droppedShas.length} commits (already-upstream + misrouted, SHAs: ${recovery.droppedShas.map((sha) => sha.slice(0, 12)).join(", ")}); new tip ${recovery.newTipSha.slice(0, 12)}`,
                undefined,
                deps.getRunContextFor(task.id),
              );

              for (const dropped of misrouted) {
                await audit.database({
                  type: "task:auto-recover-misrouted-foreign-commit",
                  target: task.id,
                  metadata: {
                    droppedSha: dropped.commit.sha,
                    foreignTaskId: dropped.foreignTaskId,
                    paths: dropped.paths,
                  },
                });
              }

              await deps.store.updateTask(task.id, {
                recoveryRetryCount: 1,
                nextRecoveryAt: null,
                paused: false,
                pausedReason: null,
                error: null,
              });
              // FN-4939: preserve the worktree across requeue. The recovery operated
              // inside the worktree (re-anchored the branch and re-checked it out), so
              // the worktree directory remains internally consistent and usable. Nulling
              // task.worktree here was the root cause of transient
              // `no-worktree-no-merge-confirmed` stall signals — a live mapped worktree
              // would still exist on disk while task.worktree was null, and downstream
              // classifiers (in-review-stall.ts, TaskChangesTab) cannot distinguish
              // "worktree gone" from "pointer not yet repopulated". Matches sibling
              // recovery paths in auto-recovery-handlers/contamination.ts,
              // tryBootstrapMisbindingRecovery, and self-healing reclaim.
              deps.markGraphExecuteSelfRequeued(task.id);
              await deps.store.moveTask(task.id, await resolveReboundColumnFor(deps.store, task.id), { preserveResumeState: true, preserveWorktree: true });
              return;
            }

            if (alreadyAttemptedRecovery) {
              await deps.store.logEntry(
                task.id,
                "[recovery] auto-recovery already attempted; escalating to human adjudication",
                undefined,
                deps.getRunContextFor(task.id),
              );
            } else if (genuinelyUnique.length > 0) {
              await deps.store.logEntry(
                task.id,
                `[recovery] unique foreign commits require human adjudication: ${genuinelyUnique.map((commit) => commit.sha.slice(0, 12)).join(", ")}`,
                undefined,
                deps.getRunContextFor(task.id),
              );
            }
          } catch (recoveryError: unknown) {
            const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
            await deps.store.logEntry(task.id, `[recovery] contamination auto-recovery failed: ${recoveryMessage}`, undefined, deps.getRunContextFor(task.id));
          }

          const autoRecoveryDispatcher = deps.getAutoRecoveryDispatcher(audit);
          const ownCommits = err.foreignCommits.filter((commit) => commit.foreignTaskId === task.id).length;
          const foreignAttributedCommits = err.foreignCommits.filter((commit) => commit.foreignTaskId !== task.id).length;
          const foreignOnlyClassification = (task.branch && task.baseCommitSha)
            ? await classifyForeignOnlyContamination({
              repoDir: deps.rootDir,
              branchName: task.branch,
              baseSha: task.baseCommitSha,
              taskId: task.id,
            }).catch(() => null)
            : null;
          const decision = await autoRecoveryDispatcher.dispatch({
            class: "branch-cross-contamination",
            taskId: task.id,
            runId: deps.getRunContextFor(task.id)?.runId,
            pausedReason: "branch-cross-contamination",
            evidence: {
              ownCommits,
              foreignAttributedCommits,
              foreignOnlyKind: foreignOnlyClassification?.kind,
            },
            underlyingError: err,
          }, {
            task,
            retryCount: task.recoveryRetryCount ?? 0,
            settings: (await deps.store.getSettings()).autoRecovery ?? { mode: "deterministic-only", maxRetries: 3 },
          });
          if (decision.action === "pause") {
            await deps.store.updateTask(task.id, {
              status: "failed",
              error: err.message,
              paused: true,
              pausedReason: "branch-cross-contamination",
            });
          }
          return;
        } else if (isBranchConflictError(err)) {
          const conflictCount = (deps.branchConflictErrorCount.get(task.id) ?? 0) + 1;
          deps.branchConflictErrorCount.set(task.id, conflictCount);

          if (conflictCount > deps.BRANCH_CONFLICT_TRIPWIRE_THRESHOLD) {
            const details = [
              `branch=${err.branchName}`,
              `worktree=${err.conflictingWorktreePath}`,
              `existingTipSha=${err.existingTipSha}`,
              `startPoint=${err.startPoint}`,
            ].join(" ");
            const tripwireMessage = `Branch conflict tripwire fired after ${conflictCount} events (threshold ${deps.BRANCH_CONFLICT_TRIPWIRE_THRESHOLD}). ${details}`;
            await deps.store.logEntry(task.id, `[recovery] ${tripwireMessage}`, undefined, deps.getRunContextFor(task.id));
            const autoRecoveryDispatcher = deps.getAutoRecoveryDispatcher(audit);
            const decision = await autoRecoveryDispatcher.dispatch({
              class: "branch-conflict-tripwire",
              taskId: task.id,
              runId: deps.getRunContextFor(task.id)?.runId,
              pausedReason: "branch-conflict-tripwire",
              evidence: {
                branchName: err.branchName,
                conflictingWorktreePath: err.conflictingWorktreePath,
              },
              underlyingError: err,
            }, {
              task,
              retryCount: task.recoveryRetryCount ?? 0,
              settings: (await deps.store.getSettings()).autoRecovery ?? { mode: "deterministic-only", maxRetries: 3 },
            });
            if (decision.action === "pause") {
              await deps.store.updateTask(task.id, {
                status: "failed",
                error: tripwireMessage,
                paused: true,
                pausedReason: "branch-conflict-tripwire",
              });
            }
            return;
          }

          let outcome: "retry" | "reclaimed" | "sticky" = "sticky";
          for (let attempt = 1; attempt <= deps.MAX_AUTO_RECOVERY_ATTEMPTS; attempt += 1) {
            outcome = await deps.handleBranchConflict(task, err);
            if (outcome !== "retry") break;
            await deps.store.logEntry(task.id, `[recovery] ${task.id} branch-conflict auto-retry requested (${attempt}/${deps.MAX_AUTO_RECOVERY_ATTEMPTS})`, undefined, deps.getRunContextFor(task.id));
            const taskForRetry = await deps.store.getTask(task.id);
            await recordRetry({
              store: deps.store,
              settings: await deps.store.getSettings(),
              task: taskForRetry,
              category: "branchConflict",
              role: "executor",
              agentId: task.assignedAgentId ?? undefined,
              attempt,
            });
          }
          if (outcome === "retry") {
            const autoRecoveryDispatcher = deps.getAutoRecoveryDispatcher(audit);
            const decision = await autoRecoveryDispatcher.dispatch({
              class: "branch-conflict-recovery-exhausted",
              taskId: task.id,
              runId: deps.getRunContextFor(task.id)?.runId,
              pausedReason: "branch-conflict-recovery-exhausted",
              evidence: {
                branchName: err.branchName,
                conflictingWorktreePath: err.conflictingWorktreePath,
              },
              underlyingError: err,
            }, {
              task,
              retryCount: task.recoveryRetryCount ?? 0,
              settings: (await deps.store.getSettings()).autoRecovery ?? { mode: "deterministic-only", maxRetries: 3 },
            });
            if (decision.action === "pause") {
              await deps.store.updateTask(task.id, {
                status: "failed",
                error: err.message,
                paused: true,
                pausedReason: "branch-conflict-recovery-exhausted",
              });
            }
            return;
          }
          return;
        } else if (await deps.handleNonContinuableSessionError(task, taskDone, errorMessage)) {
          return;
        } else if (await deps.handleNonContinuableSessionRetry(task, errorMessage)) {
          return;
        } else if (deps.options.usageLimitPauser && isUsageLimitError(errorMessage)) {
          await deps.options.usageLimitPauser.onUsageLimitHit("executor", task.id, errorMessage);
        } else if (isTransientError(errorMessage)) {
          // Transient network/infrastructure error — use bounded recovery policy
          const decision = computeRecoveryDecision({
            recoveryRetryCount: task.recoveryRetryCount,
            nextRecoveryAt: task.nextRecoveryAt,
          });

          if (decision.shouldRetry) {
            const attempt = decision.nextState.recoveryRetryCount;
            const delay = formatDelay(decision.delayMs);
            // Silent transient errors (e.g., "request was aborted") are noisy — skip logging
            if (!isSilentTransientError(errorMessage)) {
              executorLog.warn(`⚡ ${task.id} transient error — retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}: ${errorMessage}`);
              await deps.store.logEntry(task.id, `Transient error (retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}): ${errorMessage}`, undefined, deps.getRunContextFor(task.id));
            }
            // Clean up the old worktree so the retry gets a fresh one
            if (worktreePath && existsSync(worktreePath)) {
              try {
                const settings = await deps.store.getSettings();
                await removeWorktree({
                  worktreePath,
                  rootDir: deps.rootDir,
                  settings,
                  taskId: task.id,
                  audit,
                  reason: RemovalReason.ExecutorTransientRetry,
                  expectedOwnerTaskId: task.id,
                  liveOwnerProbe: (path, ownerTaskId) => deps.hasActiveWorktreeBinding(ownerTaskId, path),
                });
                executorLog.log(`Removed old worktree for transient retry: ${worktreePath}`);
              } catch (cleanupErr: unknown) {
                const cleanupErrMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
                executorLog.warn(`Failed to remove old worktree ${worktreePath}: ${cleanupErrMessage}`);
              }
            }
            await deps.store.updateTask(task.id, {
              recoveryRetryCount: decision.nextState.recoveryRetryCount,
              nextRecoveryAt: decision.nextState.nextRecoveryAt,
              worktree: null,
              branch: null,
            });
            deps.markGraphExecuteSelfRequeued(task.id);
            await deps.store.moveTask(task.id, await resolveReboundColumnFor(deps.store, task.id), { preserveProgress: true });
            return;
          }

          // Recovery budget exhausted — escalate to real failure
          executorLog.error(`✗ ${task.id} transient error retries exhausted (${MAX_RECOVERY_RETRIES} attempts): ${errorDetail}`);
          await deps.store.logEntry(task.id, `Transient error retries exhausted after ${MAX_RECOVERY_RETRIES} attempts: ${errorMessage}`, errorStack ?? errorDetail, deps.getRunContextFor(task.id));
          await deps.store.updateTask(task.id, {
            status: "failed",
            error: errorMessage,
            recoveryRetryCount: null,
            nextRecoveryAt: null,
          });
          await deps.persistTokenUsage(task.id);
          executorLog.log(`✗ ${task.id} transient retries exhausted — failed in execution`);
          deps.options.onError?.(task, err instanceof Error ? err : new Error(errorMessage));
          return;
        }
        const terminalError = err instanceof RetryStormError
          ? JSON.stringify(serializeRetryStormError(err))
          : errorMessage;
        executorLog.error(`✗ ${task.id} execution failed:`, errorDetail);
        await deps.store.logEntry(task.id, `Execution failed: ${terminalError}`, errorStack ?? errorDetail, deps.getRunContextFor(task.id));
        await deps.store.updateTask(task.id, { status: "failed", error: terminalError });
        await deps.persistTokenUsage(task.id);
        executorLog.log(`✗ ${task.id} execution failed`);
        deps.options.onError?.(task, err instanceof Error ? err : new Error(errorMessage));
      }
    } finally {
      if (reviewAddressingActivated) {
        const latestTask = await deps.store.getTask(task.id);
        if (taskDone) {
          await deps.transitionReviewAddressing(task.id, ["in-progress", "queued"], "addressed");
        } else if (latestTask.status === "failed") {
          await deps.transitionReviewAddressing(task.id, ["in-progress", "queued"], "failed");
        }
      }

      /*
      FNXC:GlobalConcurrencyControls 2026-07-15-02:55:
      Belt-and-suspenders for graph→legacy pre-held handoff inside the lock-claimed try:
      release any still-registered slot before lock/executing cleanup. execute()'s outer
      finally also drops (no-op once take/drop already cleared the registration).
      */
      if (dropPreHeldExecutorSlot(task.id)) deps.options.semaphore?.release();

      deps.executing.delete(task.id);
      executingTaskLock.release(task.id);
      // Clear run context at end of execute() lifecycle
      deps.currentRunContexts.delete(task.id);
      // U5 (R6) leak guard: effectiveColumnAgentByTask is set() in the outer execute()
      // scope (execute-seam ~6191, step-session ~5674) BEFORE the session-entry try
      // whose finally (deleteActiveSession / deleteActiveStepExecutor) normally clears
      // it. A throw between the set() and that try would otherwise leak the entry and
      // permanently block the column agent's heartbeat ticks. Deleting here in the
      // outer finally covers BOTH paths since both run inside execute().
      deps.effectiveColumnAgentByTask.delete(task.id);

      // Terminate all spawned child agents on ALL exit paths.
      // This must run here (in the outer finally) rather than only in agentWork's
      // finally block, because failures during worktree creation or before
      // agentWork is entered leave children orphaned with no other cleanup path.
      try {
        await deps.terminateAllChildren(task.id);
      } catch (err) {
        executorLog.warn(`terminateAllChildren failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Reset loop recovery state at end of execute() lifecycle.
      // State is in-memory and per-run — should not persist across attempts.
      deps.loopRecoveryState.delete(task.id);
      deps.tokenUsageBaselines.delete(task.id);

      if (taskDone) {
        deps.branchConflictErrorCount.delete(task.id);
      } else {
        const latestTask = await deps.store.getTask(task.id);
        if ((await resolveTerminalColumnsFor(deps.store, task.id)).includes(latestTask.column)) {
          deps.branchConflictErrorCount.delete(task.id);
        }
      }

      // Requeue stale assistant-continuation sessions AFTER deps.executing is cleared.
      // Moving the task while the execution guard is still held can cause the scheduler's
      // task:moved dispatch to no-op, stranding the task in todo with no fresh run.
      if (staleAssistantContinuationRequeue) {
        /*
        FNXC:ExecutorSessionRecovery 2026-07-14-06:26:
        Claim the process-wide executor lock for deferred cleanup, release it immediately before moveTask emits task:moved, and always drop the claim on errors. This closes the guard-release race without recreating the original no-op dispatch: a fresh retry cannot start while stale state is being cleared, but can claim the task when the committed move event fires.

        FNXC:ExecutorSessionRecovery 2026-07-14-06:34:
        Release the stale run's activeWorktrees slot before releasing the executor lock. Once the lock is open, the fresh retry may install its own slot while moveTask dispatches; deleting afterward would erase the new run's capacity and liveness tracking.
        */
        const cleanupClaimed = executingTaskLock.tryClaim(task.id);
        if (!cleanupClaimed) {
          executorLog.debug(`${task.id} stale assistant-continuation requeue skipped — a fresh executor already claimed the task`);
        } else {
          let cleanupLockHeld = true;
          try {
            const latestTask = await deps.store.getTask(task.id);
            const continuationLanes = await deps.resolveResumeLanes(task.id);
            if (latestTask.column === continuationLanes.wip || latestTask.column === continuationLanes.hold) {
              await deps.store.updateTask(task.id, {
                sessionFile: null,
                status: null,
                error: null,
              });
              const continuationReboundColumn = await resolveReboundColumnFor(deps.store, task.id);
              if (latestTask.column !== continuationReboundColumn) {
                deps.markGraphExecuteSelfRequeued(task.id);
                deps.activeWorktrees.delete(task.id);
                executingTaskLock.release(task.id);
                cleanupLockHeld = false;
                await deps.store.moveTask(task.id, continuationReboundColumn, { preserveResumeState: true });
              } else {
                deps.activeWorktrees.delete(task.id);
              }
              executorLog.log(`${task.id} stale assistant-continuation session cleared — requeued to ${continuationReboundColumn} with progress preserved`);
            } else {
              executorLog.debug(`${task.id} stale assistant-continuation requeue skipped — task is now in '${latestTask.column}'`);
            }
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            executorLog.error(`Failed to requeue stale assistant-continuation task ${task.id}: ${errorMessage}`);
          } finally {
            if (cleanupLockHeld) {
              executingTaskLock.release(task.id);
            }
          }
        }
      }

      // Requeue stuck-killed task AFTER deps.executing is cleared.
      // This prevents the race where the scheduler re-dispatches the task
      // (via task:moved → execute()) while the old execution guard is still set,
      // which caused the new execute() call to silently no-op, stranding the
      // task in "in-progress" with no active session or worktree.
      if (stuckRequeue === true) {
        if (deps.userCanceledTaskIds.has(task.id)) {
          deps.clearPausedAborted(task.id);
          deps.stuckAborted.delete(task.id);
          deps.userCanceledTaskIds.delete(task.id);
          await deps.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
        } else {
          try {
          // Re-read latest task state. While this execute() invocation was
          // unwinding, self-healing (e.g. recoverCompletedTasks) may have
          // already transitioned the task to in-review or done. Continuing
          // the stuck-requeue cleanup in that case would destroy the worktree
          // the recovery now relies on and clobber the task back to todo with
          // all step progress reset, undoing valid completion. Skip the
          // entire cleanup if the column has moved on past in-progress/todo.
          const latestTask = await deps.store.getTask(task.id);
          const outerRequeueLanes = await deps.resolveResumeLanes(task.id);
          if (latestTask.column !== outerRequeueLanes.wip && latestTask.column !== outerRequeueLanes.hold) {
            executorLog.log(
              `${task.id} stuck-requeue skipped — task is now in '${latestTask.column}' (recovered concurrently)`,
            );
          } else {
            const settings = await deps.store.getSettings();
            const preserveProgress = settings.preserveProgressOnStuckRequeue !== false;

            /*
            FNXC:StuckRequeue 2026-06-27-23:15:
            Preserve-progress stuck requeues still remove the old checkout. Reconcile steps first so uncommitted-only output is reset to pending while committed progress can remain complete.
            */
            await deps.resetStepsIfWorkLost(latestTask);

            // Clean up the old worktree so the retry gets a fresh one
            if (worktreePath && existsSync(worktreePath)) {
              try {
                await removeWorktree({
                  worktreePath,
                  rootDir: deps.rootDir,
                  settings,
                  taskId: task.id,
                  audit,
                  reason: RemovalReason.ExecutorStuckKilled,
                  expectedOwnerTaskId: task.id,
                  liveOwnerProbe: (path, ownerTaskId) => deps.hasActiveWorktreeBinding(ownerTaskId, path),
                });
                executorLog.log(`Removed old worktree for stuck-killed retry: ${worktreePath}`);
              } catch (cleanupErr: unknown) {
                const cleanupErrMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
                executorLog.warn(`Failed to remove old worktree ${worktreePath}: ${cleanupErrMessage}`);
              }
            }
            await deps.store.updateTask(task.id, {
              status: "queued",
              error: null,
              worktree: null,
              branch: null,
            });
            // Only move to todo if not already there. Use the freshly-read
            // latestTask.column rather than the stale captured task.column —
            // the captured snapshot can be hours old and would race against
            // any concurrent recovery (see comment above).
            const stuckReboundColumn = await resolveReboundColumnFor(deps.store, task.id);
            if (latestTask.column !== stuckReboundColumn) {
              deps.markGraphExecuteSelfRequeued(task.id);
              await deps.store.moveTask(task.id, stuckReboundColumn, preserveProgress ? { preserveProgress: true } : undefined);
              /*
              Audit trail: record task move (FN-1404).
              FNXC:WorkflowLifecycleColumns 2026-07-30-15:15: `to` records the column the card was
              ACTUALLY moved to. It was hardcoded `"todo"` while the move target was already
              resolved from the workflow, so on a renamed board the audit row named a column the
              move never touched — a run-audit trail that disagrees with the move it describes is
              worse than none, because it is the record an operator reaches for afterwards.
              */
              await audit.database({ type: "task:move", target: task.id, metadata: { to: stuckReboundColumn } });
              executorLog.log(`${task.id} moved to ${stuckReboundColumn} for retry after stuck kill${preserveProgress ? " (progress preserved)" : ""}`);
            } else {
              executorLog.debug(`${task.id} already in ${stuckReboundColumn} — skipping redundant move`);
            }
          }
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            executorLog.error(`Failed to requeue stuck task ${task.id}: ${errorMessage}`);
          }
        }
      }

      /*
       * FNXC:AgentGating 2026-07-12-17:12:
       * MAIN-008 closes the approval-decision/unwind race. The dashboard can
       * unpause while the original executor still owns its process-wide lock;
       * consume that single deferred edge only after every old-session cleanup
       * path above has run, then bootstrap one new executor session. A Set plus
       * resumingUnpaused makes duplicate task updates idempotent.
       */
      await deps.resumeApprovalAfterUnwindIfNeeded(task.id);
    }
}
