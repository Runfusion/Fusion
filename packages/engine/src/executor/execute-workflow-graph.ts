/**
 * FNXC:CodeOrganization 2026-08-03-14:30:
 * executeWorkflowGraph peeled from TaskExecutor (U4).
 *
 * Runs the graph-owned workflow path: claim routing, node preparation, custom-node
 * execution, foreach worktree deps, and terminal handleGraphFailure.
 */
import type {
  AgentStore,
  Settings,
  Task,
  TaskDetail,
  TaskStore,
  ThinkingLevel,
  WorkflowColumnAgent,
  WorkflowIr,
  WorkflowStepResult as CoreWorkflowStepResult,
  WorkflowWorkItem,
} from "@fusion/core";
import {
  ACTIVE_WORKFLOW_WORK_ITEM_STATES,
  computePlanApprovalFingerprint,
  isPlanReviewSatisfied,
  PLAN_REVIEW_GROUP_ID,
  getBuiltinWorkflow,
  resolveColumnAgentBinding,
  resolveMaxConsecutiveToolFailureRetries,
  resolveTaskOutputLanguage,
  resolveWorkflowIrForTask,
  upsertWorkflowStepResult,
  applySupersededFindingIds,
  applySupersededPriorAttemptFindingIds,
  closeUnrebuttedDisputedFindings,
  isTerminalStepResult,
  isWorkflowStepNotRun,
} from "@fusion/core";
import { resolveWorkflowGateActivityClaim } from "./workflow-gate-activity.js";
import type { ImplementationExit } from "./implementation-exit.js";
import type { WorkflowGraphTaskRunResult } from "../workflows/workflow-graph-task-runner.js";
import { WorkflowGraphTaskRunner } from "../workflows/workflow-graph-task-runner.js";
import { WorkflowCustomNodeExecutionService } from "../workflows/workflow-custom-node-execution.js";
import {
  requiredArtifactReadFailedValue,
  workflowEntryArtifacts,
} from "../execution/required-workflow-artifacts.js";
import { getActiveNotificationService } from "../util/notifier.js";

export function buildWorkflowGateActivityMetadata(
  result: CoreWorkflowStepResult,
  persistedResult: CoreWorkflowStepResult,
): { stepId: string; status: CoreWorkflowStepResult["status"]; attempt: number; notRun?: true } {
  return {
    stepId: result.workflowStepId,
    status: result.status,
    attempt: persistedResult.priorAttempts?.length ?? 0,
    ...(isWorkflowStepNotRun(result) ? { notRun: true } : {}),
  };
}
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { emitBoundedRunAudit } from "./emit-bounded-run-audit.js";
import { takePreHeldExecutorSlot } from "../concurrency/concurrency.js";
import { resolveCompleteColumnFor } from "./lifecycle-columns.js";
import { workflowNodeRequiresWorktree } from "../workflows/workflow-node-execution-needs.js";
import { nextPlanReviewAttemptCount, PLAN_REVIEW_FEEDBACK_HISTORY_LIMIT } from "../plan-review-feedback-history.js";
import type { AgentSemaphore } from "../concurrency/concurrency.js";
import type { WorkflowAgentCapacity } from "../agents/workflow-agent-capacity.js";
import {
  admitWorkflowPrincipalBeforeNode,
  type ActiveWorkflowAuthority,
} from "./workflow-principal-before-node.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirror TaskExecutor method/map surface
type AnyFn = (...args: any[]) => any;

export type ExecuteWorkflowGraphDeps = {
  store: TaskStore;
  options: {
    prNodes?: unknown;
    semaphore?: AgentSemaphore;
    getLocalNodeId?: () => string | undefined;
    agentStore?: AgentStore | null;
    [k: string]: unknown;
  };
  activeWorkflowGraphAbortControllers: Map<string, AbortController>;
  /* FNXC:WorkflowLifecycle 2026-08-31-06:41: reset at run birth so an abort marker can only describe THIS run. */
  userCanceledTaskIds: Set<string>;
  clearPausedAborted: (taskId: string) => void;
  workflowAgentCapacity: WorkflowAgentCapacity;
  activeWorkflowAuthorities: Map<string, ActiveWorkflowAuthority>;
  activeWorkflowPrincipals: Map<string, { agentId: string; nodeInstanceId: string; agent?: import("@fusion/core").Agent }>;
  graphColumnAgentResolver: Map<string, (nodeId: string) => WorkflowColumnAgent | undefined>;
  graphExecuteSelfRequeued: Set<string>;
  graphRethinkNarrations: Map<string, unknown>;
  graphRouting: Set<string>;
  graphSeamGoverningNodeId: Map<string, string>;
  graphSeamSkillName: Map<string, string>;
  graphSeamThinkingLevel: Map<string, ThinkingLevel>;
  graphStepActiveContext: Map<string, unknown>;
  graphStepRunOnce: Map<string, Promise<{ taskDone: boolean; modifiedFiles: string[]; exit?: ImplementationExit }>>;
  graphStepSessionPinned: Set<string>;
  graphToolFailureRunCursors: Map<string, number>;
  graphUnattendedRuns: Set<string>;
  /** FNXC:AgentActivityStream 2026-08-15-22:15: FN-8864 node-scoped routed-principal retention for gate attribution (restored post-wave-18). */
  workflowGateActivityPrincipals: Map<string, string>;
  outerConcurrencyClaims: Set<string>;
  processWideGraphRouting: Set<string>;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  advanceNoMergeWorkflowToCompleteColumn: AnyFn;
  applyGraphRethinkReset: AnyFn;
  buildBranchPersistence: AnyFn;
  buildCodeNodeRunner: AnyFn;
  buildColumnBoundaryHooks: AnyFn;
  buildForeachWorktreeDeps: AnyFn;
  buildParseStepsDeps: AnyFn;
  buildStepInstancePersistence: AnyFn;
  createAuthoritativeWorkflowPrimitives: AnyFn;
  createAuthoritativeWorkflowSeams: AnyFn;
  finalizeMergeConfirmedWorkflowGraphTask: AnyFn;
  handleGraphFailure: AnyFn;
  isLiveSharedBranchGroupMember: (
    task: Pick<TaskDetail, "branchContext" | "autoMerge" | "autoMergeProvenance">,
  ) => Promise<boolean>;
  prepareGraphNodeExecution: AnyFn;
  readTaskArtifact: AnyFn;
  recoverMissingRequiredArtifacts: AnyFn;
  requestPreMergeOptionalStepFix: AnyFn;
  /** FNXC:PlanReviewNoOp 2026-08-09-22:10: CLOSE_NO_OP accepted terminalization (FN-8841). */
  completePlanReviewNoOp: AnyFn;
  /** FNXC:PlanReviewNoOp 2026-08-09-22:10: hold failed/invalid close evidence on the continuation. */
  holdPlanReviewNoOpContinuation: AnyFn;
  runGraphCustomNode: AnyFn;
  terminateAllChildren: AnyFn;
};

/*
FNXC:WorkflowAgentRouting 2026-08-10-01:15:
Backoff ladder for a workflow-principal hold. A hold had NO cooldown, so the scheduler re-dispatched instantly
and the run re-entered only to re-fence and re-park: observed at ~3.5 re-dispatches/second across every task,
pinning a core and writing ~19k `workflowWorkItem` audit rows/hour while nothing executed. The hold never
increments the work item's `attempt`, so no retry budget is consumed and no existing guard can ever fire.

Module-scoped and in-memory on purpose, matching the session-contention hold: it needs no schema change, and a
restart clearing it is CORRECT — a restart is exactly when agent configuration may have changed. The ceiling is
generous because an unroutable role clears on OPERATOR action (enable or add an agent), never on its own, so
polling it every few seconds only burns CPU.
*/
/*
FNXC:WorkflowAgentRouting 2026-08-23-22:22:
Read the test-mode zero at RECORD time rather than binding it at module load. The value is identical in
production and in suites; late binding is what lets a regression test drive a real cooldown through the real
writer and reader instead of asserting against a stubbed clock.
*/
function principalHoldBackoffBaseMs(): number {
  return process.env.VITEST || process.env.NODE_ENV === "test" ? 0 : 15_000;
}
const PRINCIPAL_HOLD_MAX_BACKOFF_MS = 300_000;
const principalHoldBackoff = new Map<string, { reason: string; attempt: number; until: number }>();

export type PrincipalHoldCooldown = { reason: string; attempt: number; until: number };

/*
FNXC:WorkflowAgentRouting 2026-08-23-22:22:
The ladder is a primitive with exactly ONE writer and ONE reader, both exported. It was previously an inline
`.set()` plus an inline `.get()` comparison, and the U4 executor peel (#3317) moved the reader to a call site
where its own guard condition could never be true — leaving the map written, cleared, and never honored, which
is indistinguishable from a working cooldown at a glance. Keeping both ends named and exported means a lost
reader is a lost REFERENCE, which the compiler and the census can see.
*/
export function recordPrincipalHoldBackoff(taskId: string, reason: string): { attempt: number; repeated: boolean } {
  const priorHold = principalHoldBackoff.get(taskId);
  const repeated = priorHold?.reason === reason;
  const attempt = repeated ? priorHold!.attempt + 1 : 1;
  principalHoldBackoff.set(taskId, {
    reason,
    attempt,
    until: Date.now() + Math.min(PRINCIPAL_HOLD_MAX_BACKOFF_MS, principalHoldBackoffBaseMs() * 2 ** (attempt - 1)),
  });
  return { attempt, repeated };
}

/** The active cooldown for a task, or null when none is recorded or the window has elapsed. */
export function getActivePrincipalHoldCooldown(taskId: string): PrincipalHoldCooldown | null {
  const hold = principalHoldBackoff.get(taskId);
  if (!hold || Date.now() >= hold.until) return null;
  return hold;
}

/** True while a principal hold is still cooling down, so dispatch must not re-enter the graph. */
export function isPrincipalHoldCoolingDown(taskId: string): boolean {
  return getActivePrincipalHoldCooldown(taskId) !== null;
}

/** Clears the ladder for a task; exported so tests and recovery paths can reset it deterministically. */
export function clearPrincipalHoldBackoff(taskId: string): void {
  principalHoldBackoff.delete(taskId);
}

/*
FNXC:ReviewConvergence 2026-08-22-06:06:
FN-149 scopes convergence state to one uninterrupted review episode. A terminal approval ends the
whole episode, while a changed durable review fingerprint proves progress and re-arms only the
stage; the monotonic cycle count remains spent until approval or an operator retry bounds
progress-then-reject loops.
*/
function reviewConvergenceResetPatch(
  previous: CoreWorkflowStepResult | undefined,
  incoming: CoreWorkflowStepResult,
): Pick<Task, "reviewConvergenceStage" | "reviewConvergenceEscalationCount"> | undefined {
  if (incoming.phase !== "pre-merge" || !incoming.reviewKind) return undefined;
  const approved = isTerminalStepResult(incoming)
    && (incoming.verdict === "APPROVE" || incoming.verdict === "APPROVE_WITH_NOTES");
  if (approved) return { reviewConvergenceStage: 0, reviewConvergenceEscalationCount: 0 };
  if (previous?.reviewInputFingerprint && incoming.reviewInputFingerprint
    && previous.reviewInputFingerprint !== incoming.reviewInputFingerprint) {
    return { reviewConvergenceStage: 0 };
  }
  return undefined;
}

export type WorkflowStepResultPersistFence = {
  signal?: AbortSignal;
  requireAttemptStartedAt?: string;
  /** A failed pending write may recover only if no different attempt has since claimed this step. */
  requireAttemptStartedAtOrAbsent?: string;
};

/** Returns true only when the exact graph attempt still owns its pending/terminal row. */
export function attemptStillPresent(
  results: CoreWorkflowStepResult[] | undefined,
  workflowStepId: string,
  startedAt: string,
): boolean {
  return results?.some((entry) => entry.workflowStepId === workflowStepId && entry.startedAt === startedAt) === true;
}

/*
FNXC:WorkflowStepResults 2026-08-29-03:21:
A fail-soft pending write can report no durable receipt even though the graph must still record its
terminal verdict. Permit that recovery only when the step row remains absent or carries this exact
`startedAt`; any different identity belongs to a later run and must never be replaced by stale work.
*/
export function attemptStillPresentOrAbsent(
  results: CoreWorkflowStepResult[] | undefined,
  workflowStepId: string,
  startedAt: string,
): boolean {
  return (results ?? []).every((entry) => entry.workflowStepId !== workflowStepId || entry.startedAt === startedAt);
}

function attemptFenceAllows(
  fence: WorkflowStepResultPersistFence,
  results: CoreWorkflowStepResult[] | undefined,
  workflowStepId: string,
): boolean {
  return (
    (fence.requireAttemptStartedAt === undefined
      || attemptStillPresent(results, workflowStepId, fence.requireAttemptStartedAt))
    && (fence.requireAttemptStartedAtOrAbsent === undefined
      || attemptStillPresentOrAbsent(results, workflowStepId, fence.requireAttemptStartedAtOrAbsent))
  );
}

type WorkflowStepResultPatch = Pick<
  Task,
  "workflowStepResults"
  | "approvedPlanFingerprint"
  | "reviewConvergenceStage"
  | "reviewConvergenceEscalationCount"
>;

type FencedWorkflowStepResultOutcome =
  | { applied: true; task: Task }
  | { applied: false; reason: string };

type RuntimeWorkflowStepResultStore = {
  updateWorkflowStepResultsFenced?: (
    taskId: string,
    compute: (current: Task) => WorkflowStepResultPatch | null,
  ) => Promise<FencedWorkflowStepResultOutcome>;
  updateTaskAtomic?: (
    taskId: string,
    compute: (current: Task) => WorkflowStepResultPatch | null,
    runContext?: EngineRunContext,
  ) => Promise<Task>;
};

function buildWorkflowStepResultPatch(
  current: Task,
  result: CoreWorkflowStepResult,
  isPlanReviewResult: boolean,
): { resultToPersist: CoreWorkflowStepResult; results: CoreWorkflowStepResult[]; patch: WorkflowStepResultPatch } {
  const resultToPersist = isPlanReviewResult
    ? {
        ...result,
        planReviewAttemptCount: nextPlanReviewAttemptCount(
          current.workflowStepResults?.find((existing) => existing.workflowStepId === result.workflowStepId),
          result,
        ),
      }
    : result;
  const upserted = upsertWorkflowStepResult(
    current.workflowStepResults,
    resultToPersist,
    isPlanReviewResult ? { maxPriorAttempts: PLAN_REVIEW_FEEDBACK_HISTORY_LIMIT } : undefined,
  );
  const crossLane = applySupersededFindingIds(upserted, resultToPersist.supersededFindingIds ?? [], {
    excludeWorkflowStepId: resultToPersist.workflowStepId,
    sourceWorkflowStepId: resultToPersist.supersededFindingSourceWorkflowStepId ?? "",
  }) ?? upserted;
  const sameGate = resultToPersist.supersededFindingSourceWorkflowStepId === resultToPersist.workflowStepId
    ? applySupersededPriorAttemptFindingIds(crossLane, {
        workflowStepId: resultToPersist.workflowStepId,
        findingIds: resultToPersist.supersededFindingIds ?? [],
      }) ?? crossLane
    : crossLane;
  const results = closeUnrebuttedDisputedFindings(sameGate, resultToPersist, {
    revisionKey: resultToPersist.workflowStepId,
    workflowStepId: resultToPersist.workflowStepId,
  }) ?? sameGate;
  return {
    resultToPersist,
    results,
    patch: {
      workflowStepResults: results,
      ...reviewConvergenceResetPatch(
        current.workflowStepResults?.find((entry) => entry.workflowStepId === resultToPersist.workflowStepId),
        resultToPersist,
      ),
    },
  };
}

/*
FNXC:WorkflowLifecycle 2026-08-29-02:04:
awaitAbortInFlightTaskWork aborts the graph without awaiting it, while Reset performs slow Git cleanup
before publishing its fresh row. Therefore a caller-side abort check, the planning lifecycle lock, and
updateTaskAtomic's in-process task mutex cannot fence an already-started graph write against Reset.
Production uses TaskStore.updateWorkflowStepResultsFenced, whose PostgreSQL transaction holds the same
per-task advisory lock as resetTaskPublicationImpl. Minimal test stores retain the atomic and direct
fallbacks, but only the first tier serializes against Reset.
*/
async function writeWorkflowStepResultPatch(
  deps: Pick<ExecuteWorkflowGraphDeps, "store" | "getRunContextFor">,
  taskId: string,
  compute: (current: Task) => WorkflowStepResultPatch | null,
): Promise<{ applied: boolean; task?: Task }> {
  const store = deps.store as TaskStore & RuntimeWorkflowStepResultStore;
  if (typeof store.updateWorkflowStepResultsFenced === "function") {
    const outcome = await store.updateWorkflowStepResultsFenced(taskId, compute);
    if (outcome.applied) return { applied: true, task: outcome.task };
    if (outcome.reason !== "unavailable") return { applied: false };
  }

  if (typeof store.updateTaskAtomic === "function") {
    let applied = false;
    const task = await store.updateTaskAtomic(taskId, (current) => {
      const patch = compute(current);
      if (patch !== null) applied = true;
      return patch;
    }, deps.getRunContextFor(taskId));
    return applied ? { applied: true, task } : { applied: false };
  }

  const current = await store.getTask(taskId);
  if (!current) return { applied: false };
  const patch = compute(current);
  if (patch === null) return { applied: false };
  const task = await store.updateTask(taskId, patch, deps.getRunContextFor(taskId));
  return { applied: true, task };
}

type PersistWorkflowStepResultDeps = Pick<ExecuteWorkflowGraphDeps, "store" | "getRunContextFor" | "readTaskArtifact">
  & Partial<Pick<ExecuteWorkflowGraphDeps, "workflowGateActivityPrincipals" | "activeWorkflowPrincipals">>;

/** The graph needs durable acceptance separately from the scope-CAS edge-admission result. */
export type WorkflowStepResultPersistOutcome = {
  scopeCurrent: boolean;
  persisted: boolean;
};

/**
 * Persists graph review evidence and applies explicit prior-lane supersession in
 * the same write. Exported for production-shaped graph-writer tests.
 */
export async function persistWorkflowStepResult(
  deps: PersistWorkflowStepResultDeps,
  taskId: string,
  result: CoreWorkflowStepResult,
  fence: WorkflowStepResultPersistFence = {},
): Promise<boolean> {
  return (await persistWorkflowStepResultWithOutcome(deps, taskId, result, fence)).scopeCurrent;
}

/**
 * Production adapter receipt for graph persistence. `persistWorkflowStepResult` retains its legacy
 * boolean contract while optional-group lease establishment uses `persisted` to decide whether a
 * terminal write has a durable predecessor to compare-and-set against.
 */
export async function persistWorkflowStepResultWithOutcome(
  deps: PersistWorkflowStepResultDeps,
  taskId: string,
  result: CoreWorkflowStepResult,
  fence: WorkflowStepResultPersistFence = {},
): Promise<WorkflowStepResultPersistOutcome> {
  if (typeof deps.store.updateTask !== "function") return { scopeCurrent: true, persisted: false };
  if (fence.signal?.aborted) return { scopeCurrent: true, persisted: false };

  try {
    const live = await deps.store.getTask(taskId);
    const repositoryScopeRevision = typeof result.repositoryScopeRevision === "number"
      ? result.repositoryScopeRevision
      : undefined;
    const isPlanReviewResult = result.workflowStepId === PLAN_REVIEW_GROUP_ID
      || result.workflowStepName === "Plan Review";
    let scopeSuperseded = false;
    let fenceRefused = false;
    let activityResult = result;
    let activityResults: CoreWorkflowStepResult[] | undefined;

    const compute = (current: Task, options?: { requireScopeRevision?: number }): WorkflowStepResultPatch | null => {
      if (fence.signal?.aborted) {
        fenceRefused = true;
        return null;
      }
      if (!attemptFenceAllows(fence, current.workflowStepResults, result.workflowStepId)) {
        fenceRefused = true;
        return null;
      }
      if (
        options?.requireScopeRevision !== undefined
        && current.repositoryScope?.revision !== options.requireScopeRevision
      ) {
        scopeSuperseded = true;
        return null;
      }
      const built = buildWorkflowStepResultPatch(current, result, isPlanReviewResult);
      activityResult = built.resultToPersist;
      activityResults = built.results;
      return built.patch;
    };

    if (isPlanReviewResult && isPlanReviewSatisfied(result) && deps.store.isBackendMode()) {
      const prompt = await deps.readTaskArtifact(taskId, "PROMPT.md");
      if (!prompt?.trim()) throw new Error("Plan Review cannot accept an unreadable PROMPT.md without a spec lock");
      const fingerprint = computePlanApprovalFingerprint(prompt);
      await deps.store.withPlanningLifecycleLock(taskId, async () => {
        const fresh = await deps.store.getTask(taskId);
        // This cheap check avoids creating inert plan evidence after a cancellation. The advisory-lock
        // transaction below remains the enforcement point for an abort or Reset racing this await chain.
        if (
          fence.signal?.aborted
          || !attemptFenceAllows(fence, fresh?.workflowStepResults, result.workflowStepId)
        ) {
          fenceRefused = true;
          return;
        }
        await deps.store.lockCurrentPlanWhilePlanningLocked(taskId, fingerprint, prompt);
        const written = await writeWorkflowStepResultPatch(deps, taskId, (current) => {
          const patch = compute(current);
          return patch === null ? null : { ...patch, approvedPlanFingerprint: fingerprint };
        });
        if (!written.applied) {
          fenceRefused = true;
          return;
        }
        await deps.store.reconcileSpecDriftWhilePlanningLocked(written.task!);
      });
    } else {
      const written = await writeWorkflowStepResultPatch(
        deps,
        taskId,
        (current) => compute(current, repositoryScopeRevision === undefined
          ? undefined
          : { requireScopeRevision: repositoryScopeRevision }),
      );
      if (!written.applied) fenceRefused = true;
    }

    if (scopeSuperseded) return { scopeCurrent: false, persisted: false };
    if (fenceRefused) return { scopeCurrent: true, persisted: false };

    const persistedResult = activityResults?.find((entry) => entry.workflowStepId === result.workflowStepId) ?? activityResult;
    if (isTerminalStepResult(result)) {
      const passed = result.status === "passed"
        || result.status === "skipped"
        || result.verdict === "APPROVE"
        || result.verdict === "APPROVE_WITH_NOTES"
        || result.verdict === "CLOSE_NO_OP";
      try {
        await deps.store.recordAgentActivity({
          type: passed ? "workflow:gate-passed" : "workflow:gate-failed",
          attributionClaim: resolveWorkflowGateActivityClaim(
            deps.workflowGateActivityPrincipals?.get(`${taskId}\0${result.workflowStepId}`)
              ?? deps.activeWorkflowPrincipals?.get(taskId)?.agentId,
            live?.assignedAgentId,
          ),
          taskId,
          occurredAt: result.completedAt ?? result.startedAt ?? new Date().toISOString(),
          discriminator: `${result.workflowStepId}:${result.startedAt ?? result.completedAt ?? result.status}`,
          metadata: buildWorkflowGateActivityMetadata(result, persistedResult),
        });
        deps.workflowGateActivityPrincipals?.delete(`${taskId}\0${result.workflowStepId}`);
      } catch (error) {
        executorLog.warn(`[agent-activity] ${taskId}: failed to record workflow gate activity: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { scopeCurrent: true, persisted: true };
  } catch (error) {
    executorLog.warn(`[agent-activity] ${taskId}: failed to persist workflow step result: ${error instanceof Error ? error.message : String(error)}`);
    return { scopeCurrent: true, persisted: false };
  }
}

/**
 * Remove only the pending lease from the aborted attempt. This intentionally uses the same writer
 * tiers as terminal results: production serializes the removal with Reset, while fake stores retain
 * test-friendly fallbacks. A missing or newer lease is a harmless no-op.
 */
export async function discardWorkflowStepLease(
  deps: Pick<ExecuteWorkflowGraphDeps, "store" | "getRunContextFor">,
  taskId: string,
  workflowStepId: string,
  startedAt: string,
): Promise<boolean> {
  try {
    const written = await writeWorkflowStepResultPatch(deps, taskId, (current) => {
      const lease = current.workflowStepResults?.find((entry) =>
        entry.workflowStepId === workflowStepId
        && entry.status === "pending"
        && entry.startedAt === startedAt,
      );
      if (!lease) return null;
      return { workflowStepResults: current.workflowStepResults?.filter((entry) => entry !== lease) };
    });
    return written.applied;
  } catch {
    return false;
  }
}

export async function executeWorkflowGraph(
  deps: ExecuteWorkflowGraphDeps,
  task: Task,
  opts?: { alreadyClaimed?: boolean },
): Promise<void> {
    /*
    FNXC:WorkflowAgentRouting 2026-08-10-01:15:
    Honor an active principal-hold cooldown BEFORE the graph is entered — re-entering only to re-fence and
    re-park is the hot loop itself, and it costs a graph run plus two work-item writes and two audit rows per
    pass for a condition that cannot change without operator action.
    */
    /*
    FNXC:WorkflowAgentRouting 2026-08-23-22:22:
    Stays gated on `!alreadyClaimed`, and that gate is deliberate rather than an oversight: when executeCore has
    already claimed graphRouting it sets `graphRunnerOwnsClaim` and stops deleting the claim in its finally, so
    an early return HERE would strand the claim and wedge the task against every later dispatch. The claimed
    path is therefore guarded upstream in executeCore, BEFORE the claim — which is where the check lived until
    #3317 moved it here and left this the only copy. This one now covers direct, unclaimed graph entry only.
    */
    const cooling = getActivePrincipalHoldCooldown(task.id);
    if (cooling && !opts?.alreadyClaimed) {
      executorLog.debug(`[workflow-graph] ${task.id} deferred — principal hold cooling down (${cooling.reason})`);
      return;
    }
    // Claim synchronously before any await so concurrent execute() calls for
    // the same task cannot both enter graph routing (mirrors executingTaskLock).
    // executeCore may already have claimed before its pre-graph awaits (FN-8471).
    if (!opts?.alreadyClaimed) {
      deps.graphRouting.add(task.id);
    }
    let graphAbortController: AbortController | undefined;
    const workflowCapacityAttemptIds = new Set<string>();
    /*
     * FNXC:WorkflowAgentRouting 2026-08-07-05:06:
     * Direct graph dispatch is also a production session-launch path. Track its
     * per-node durable fences so direct runs do not degrade principals to a
     * process-local map while scheduled continuations remain fenced in Postgres.
     */
    const directWorkflowPrincipalWorkItemIds = new Set<string>();
    const directWorkflowPrincipalHeldWorkItemIds = new Set<string>();
    /*
    FNXC:GlobalConcurrencyControls 2026-07-14-18:30:
    The hold/release sweep may have already tryAcquired a global slot for this card before moving it to in-progress. Claim that pre-held slot for the full graph run so utilization stays honest between workflow nodes and triage cannot overfill the cap while this task is still graph-owned.
    */
    const hadPreHeldExecutorSlot = takePreHeldExecutorSlot(task.id);
    if (hadPreHeldExecutorSlot) {
      deps.outerConcurrencyClaims.add(task.id);
    }
    try {
      let settings: Settings;
      try {
        settings = await deps.store.getSettings();
      } catch (err) {
        await deps.handleGraphFailure(task, {
          disposition: "failed",
          outcome: "failure",
          reason: `settings-load-failed: ${err instanceof Error ? err.message : String(err)}`,
          visitedNodeIds: [],
        });
        return;
      }
      /*
      FNXC:WorkflowExecution 2026-06-22-18:00:
      workflowGraphExecutor graduated from Experimental. Every task routes through the graph runner by default, and stale persisted experimentalFeatures.workflowGraphExecutor=false values are ignored so the product no longer has a user-facing or runtime graph-engine kill switch.
      */
      settings = { ...settings };
      /*
       * FNXC:ExecutorToolFailureRetry 2026-07-16-12:00:
       * Capture a count cursor without reading the task log. Failure handling receives this
       * execution-local boundary, so a stale task snapshot cannot accidentally qualify an old run.
       *
       * FNXC:ExecutorToolFailureRetry 2026-07-17-06:30:
       * Minimal/test TaskStore adapters may omit getAgentLogCount (same optional pattern as
       * project-engine). Treat a missing method as cursor 0 so graph entry does not throw
       * "is not a function" and still records a durable detector boundary when updateTask exists.
       */
      if (resolveMaxConsecutiveToolFailureRetries(settings) > 0) {
        const cursor = typeof deps.store.getAgentLogCount === "function"
          ? await deps.store.getAgentLogCount(task.id).catch(() => 0)
          : 0;
        deps.graphToolFailureRunCursors.set(task.id, cursor);
        if (typeof deps.store.updateTask === "function") {
          await deps.store.updateTask(task.id, { toolFailureDetectorLogCursor: cursor }, deps.getRunContextFor(task.id));
        }
      }
      let selection: { workflowId: string; stepIds: string[] } | undefined;
      /*
      FNXC:WorkflowExecution 2026-07-19-17:30 (U10b / R9):
      The legacy fallback is DELETED. It used to return `false` here — handing the run to a
      legacy execute path — when the store exposed neither workflow-selection reader. That
      escape hatch is gone: graph ownership is now UNCONDITIONAL, which is what lets
      `graphCompletion` be a required callback rather than an optional one and collapses the
      three completion boundaries in `runImplementation` to plain returns.
      A store that cannot resolve a workflow now ALWAYS fails closed, not only when the task
      has enabled pre-merge steps. The old "no enabled steps means nothing to gate, so the
      legacy path is safe" carve-out died with the path it protected: there is no second
      executor left to fall back to, so returning `false` would silently run nothing.
      */
      if (
        typeof deps.store.getTaskWorkflowSelectionAsync !== "function"
        && typeof deps.store.getTaskWorkflowSelection !== "function"
      ) {
        /*
        FNXC:FastOptionalSteps 2026-06-30-09:45:
        Fast mode only clears optional workflow steps by default; explicit `enabledWorkflowSteps` remains operator intent. Minimal or older stores that cannot resolve the graph must fail closed, even in fast mode, rather than falling through and silently skipping the selected optional-group body.
        */
        await deps.handleGraphFailure(task, {
          disposition: "failed",
          outcome: "failure",
          reason:
            "workflow-selection-api-unavailable: store lacks a workflow-selection reader so the workflow graph cannot run; "
            + "the legacy execute fallback was removed (U10b) and the graph is the only executor. Failing closed rather than running nothing (KTD-5).",
          visitedNodeIds: [],
        });
        return;
      }
      try {
        selection = typeof deps.store.getTaskWorkflowSelectionAsync === "function"
          ? await deps.store.getTaskWorkflowSelectionAsync(task.id)
          : deps.store.getTaskWorkflowSelection(task.id);
      } catch (err) {
        await deps.handleGraphFailure(task, {
          disposition: "failed",
          outcome: "failure",
          reason: `workflow-selection-failed: ${err instanceof Error ? err.message : String(err)}`,
          visitedNodeIds: [],
        });
        return;
      }
      selection ??= { workflowId: "builtin:coding", stepIds: [] };

      // Resolve the production run id ONCE, here, so it is the single source of
      // truth shared by the runner AND the executor-side persistence deps
      // (parse-steps pin probe, foreach instance-row flips, resume reconcile). The
      // runner derives `${task.id}:${definition.id}`; we mirror that derivation
      // from the resolved definition and thread it everywhere. Best-effort: if the
      // definition cannot be resolved (older store), the runner falls back to its
      // own derivation and the deps fall back to the legacy `:run` literal — the
      // prior behavior — so this never strands a task.
      let resolvedRunId: string | undefined;
      try {
        const definition = selection.workflowId === "builtin:coding"
          ? { id: "builtin:coding" }
          : await deps.store.getWorkflowDefinition?.(selection.workflowId);
        if (definition) resolvedRunId = `${task.id}:${definition.id}`;
      } catch {
        // Definition load failure — leave undefined; deps/runner use fallbacks.
      }

      // Column-agent binding (plan U3): the IR is NOT in scope inside
      // runGraphCustomNode, so resolve it here (the seam wiring) where the
      // selection is known, and thread a per-node binding lookup into the custom
      // node callback. Resolve the IR ONCE per run (never an uncached per-node
      // fetch — mirrors the hold-release.ts irCache posture); best-effort, so a
      // resolution failure simply yields no bindings (R8 graceful degradation).
      /*
      FNXC:WorkflowColumns 2026-06-22-18:00:
      Column-agent binding now participates in every graph run. The former workflowColumns kill switch was removed, so stale persisted false values cannot silently disable custom-node, seam, or watcher bindings.
      */
      let columnAgentIr: WorkflowIr | undefined;
      try {
        columnAgentIr = await resolveWorkflowIrForTask(deps.store, task.id);
      } catch {
        columnAgentIr = undefined;
      }
      if (columnAgentIr) {
        const missingEntryArtifacts: string[] = [];
        for (const artifact of workflowEntryArtifacts(columnAgentIr)) {
          let content: string | undefined;
          try {
            content = await deps.readTaskArtifact(task.id, artifact.key);
          } catch (error) {
            const failureValue = requiredArtifactReadFailedValue(artifact.key);
            await deps.handleGraphFailure(task, {
              disposition: "failed",
              outcome: "failure",
              reason: `workflow-required-artifact-read-failed:${artifact.key}:${error instanceof Error ? error.message : String(error)}`,
              visitedNodeIds: ["workflow-entry-artifact"],
              context: { "node:workflow-entry-artifact:value": failureValue },
            });
            return;
          }
          if (typeof content !== "string" || !content.trim()) missingEntryArtifacts.push(artifact.key);
        }
        if (missingEntryArtifacts.length > 0) {
          const liveTask = await deps.store.getTask(task.id).catch(() => task);
          await deps.recoverMissingRequiredArtifacts(liveTask, missingEntryArtifacts, { source: "graph-entry" });
          return;
        }
      }
      const resolveBindingForNode = (nodeId: string): WorkflowColumnAgent | undefined =>
        columnAgentIr ? resolveColumnAgentBinding(columnAgentIr, nodeId) : undefined;
      // Column-agent seam wiring (U4): expose the same per-run resolver to the
      // execute / step-execute seams (which key off a governing node id stamped
      // into context), so the coding/step session runs as the column agent under
      // the SAME binding lookup the custom-node seam uses (KTD-2 single resolver).
      deps.graphColumnAgentResolver.set(task.id, resolveBindingForNode);

      // (U3) Genuinely-unattended run signal. This is an EXPLICIT opt-in, not an
      // inferred heuristic: a run is unattended only when an entrypoint that
      // knows no human will ever answer (LFG / pipeline / disable-model-invocation)
      // marks it so. No such marker reaches this executor path today (verified —
      // KTD-3), so this resolves to false (board run) for every current run, and
      // the safe default is preserved: absence of the explicit flag ALWAYS yields
      // no FUSION_HEADLESS, so a board task can only ever park (a human can answer
      // via the await-input card button), never silently skip approval. When such
      // an entrypoint is added, it sets `unattended` here.
      // No entrypoint sets this today, so clear any stale entry; a board run never
      // sets FUSION_HEADLESS. When an LFG/pipeline/disable-model-invocation
      // entrypoint is added, call `deps.graphUnattendedRuns.add(task.id)` here and
      // the finally below clears it.
      deps.graphUnattendedRuns.delete(task.id);

      /*
      FNXC:TaskOutputLanguage 2026-08-19-16:25:
      Capture both settings and original task input before the graph can yield. Review handoffs may
      fetch a live task after an operator edit, but their deterministic missing-summary fallback must
      remain bound to the language target selected when this graph invocation began.
      */
      const outputLanguage = resolveTaskOutputLanguage(settings, task.description ?? "");
      /*
      FNXC:WorkflowLifecycle 2026-08-31-06:41:
      A run is born here, so every abort marker still standing belongs to a PREVIOUS one. They are
      plain task-keyed in-memory collections with no run identity, and nothing else clears them on
      this path: `userCanceledTaskIds` is dropped only by the implementation loop and the
      move-INTO-WIP listener, and `pausedAborted`/`pausedAbortProvenance` only by the implementation
      loop and the pause-replay seams. A card canceled in the REVIEW lane reaches none of those, so
      the markers outlived their run and poisoned every later one.

      Measured on FN-270/FN-273. The dashboard Retry runs pause -> hard-cancel -> unpause to restart
      a review step, and `awaitAbortInFlightTaskWork` stamps `markPausedAborted` UNCONDITIONALLY --
      even though the idle card had no live surface to abort. Two minutes later the Code Review
      returned REVISE and the teardown read those leftovers as its own: the operator-cancellation
      exit swallowed the verdict, and `genuinePauseAbort` re-classified it as a pause abort. No fix
      steps, no move to WIP -- and WIP is the very transition that would have cleared the marker.
      Each Retry re-armed it, so retrying was the one action guaranteed not to help.

      Resetting at the run boundary is what makes the FN-249 contract ("terminal for ITS in-flight
      run") structurally true instead of aspirational, and it repairs both readers at once. A
      genuinely canceled run is unaffected: its marker is set while it runs, and its own teardown
      still sees it. Cleanup of a run that outlives its successor stays driven by the run-scoped
      interruption fields the runner puts on the result.
      */
      deps.userCanceledTaskIds.delete(task.id);
      deps.clearPausedAborted(task.id);
      graphAbortController = new AbortController();
      const graphAbortSignal = graphAbortController.signal;
      deps.activeWorkflowGraphAbortControllers.set(task.id, graphAbortController);
      const customNodeExecution = new WorkflowCustomNodeExecutionService({
        /*
        FNXC:TaskOutputLanguage 2026-08-19-16:34:
        Custom prompt and review nodes can yield before their session begins. Bind the graph-start
        resolution here so a later task-description or settings edit cannot retarget their output.
        */
        execute: (node, nodeTask, nodeSettings, columnBinding, context) =>
          deps.runGraphCustomNode(node, nodeTask, nodeSettings, columnBinding, context, outputLanguage),
        resolveColumnBinding: resolveBindingForNode,
      });
      /*
      FNXC:PlanReviewNoOp 2026-08-09-22:10:
      Continuation is declared before the runner so holdPlanReviewNoOp can replace it
      during CLOSE_NO_OP terminalization failure without a TDZ (FN-8841).
      */
      let continuation: WorkflowWorkItem | undefined;
      const runner = new WorkflowGraphTaskRunner({
        localNodeId: deps.options.getLocalNodeId?.(),
        store: {
          ...deps.store,
          /*
          FNXC:WorkflowSelection 2026-07-14-17:06:
          Graph execution must reuse the asynchronously resolved selection. A PostgreSQL TaskStore cannot provide that selection through the synchronous compatibility method, and substituting builtin:coding here would silently execute the wrong graph.
          */
          getTaskWorkflowSelection: () => selection,
          getTaskWorkflowSelectionAsync: async () => selection,
          getWorkflowDefinition: async (id: string) =>
            (await deps.store.getWorkflowDefinition?.(id))
              ?? (id === "builtin:coding" ? getBuiltinWorkflow("builtin:coding") : undefined),
          getTask: (taskId: string) => deps.store.getTask(taskId),
        },
        runId: resolvedRunId,
        isLiveSharedBranchMember: (nodeTask) =>
          deps.isLiveSharedBranchGroupMember(nodeTask),
        primitives: deps.createAuthoritativeWorkflowPrimitives(settings, outputLanguage),
        seams: deps.createAuthoritativeWorkflowSeams(settings, outputLanguage),
        prepareNodeExecution: (node, nodeTask, requirement) =>
          deps.prepareGraphNodeExecution(node, nodeTask, settings, requirement),
        beforeNodeExecution: async (node, nodeTask, context) => {
          const principalAdmission = await admitWorkflowPrincipalBeforeNode(
            {
              store: deps.store,
              options: deps.options,
              workflowAgentCapacity: deps.workflowAgentCapacity,
              activeWorkflowAuthorities: deps.activeWorkflowAuthorities,
              activeWorkflowPrincipals: deps.activeWorkflowPrincipals,
              workflowGateActivityPrincipals: deps.workflowGateActivityPrincipals,
              workflowCapacityAttemptIds,
              directWorkflowPrincipalWorkItemIds,
              directWorkflowPrincipalHeldWorkItemIds,
              columnAgentIr,
              resolveBindingForNode,
              resolvedRunId,
              settings,
            },
            node,
            nodeTask,
            context,
          );
          if (principalAdmission) return principalAdmission;
          const live = await deps.store.getTask(nodeTask.id);
          /*
          FNXC:WorkflowReviewSeal 2026-08-25-02:10:
          Structural signals only. The old test also matched `/code review/i` against the display
          name, which made the seal's central question — "is this THE review that seals the tree?" —
          depend on a label an operator is free to change. Renaming the gate to "Final Review" would
          have silently stopped it being recognised as the sealing review while every other gate kept
          being sealed against it. `reviewKind: "code"` and the node/group id are carried by every
          built-in and are what the rest of the merge path already keys on.
          */
          const isCodeReview = node.id === "code-review"
            || node.id === "code-review-step"
            || node.config?.reviewKind === "code";
          /*
          FNXC:WorkflowReviewSeal 2026-08-24-16:20:
          A DETERMINISTIC verification gate is not a writer. It needs a worktree because it runs the
          project's test/build commands there, but it only reads the tree and reports exit codes —
          `verification-gate.ts` has no mutation path at all. It was nevertheless sealed, because
          `workflowNodeRequiresWorktree` conflates "needs a worktree" with "writes", and its
          inline-fix branch matches on the node NAME (`/review|verification/i`).
          The consequence was a wedge, measured by pipeline-smoke S13: any post-approval requeue — a
          merge conflict, a transient merge failure — replays `steps -> verification`, the seal
          refuses the gate it should have welcomed, and the card terminates at
          verification-remediation instead of retrying its merge. Re-running the tests after an
          approval cannot invalidate that approval; it is the one thing worth doing again.
          Narrow by construction: keyed on `workflowAction: "deterministic-verification"`, so a
          prompt-driven review named "Verification" stays sealed.
          */
          const deterministicVerification = node.config?.workflowAction === "deterministic-verification"
            || (node.config?.template as { nodes?: Array<{ config?: Record<string, unknown> }> } | undefined)
              ?.nodes?.every((inner) => inner.config?.workflowAction === "deterministic-verification") === true;
          const writeCapable = !deterministicVerification
            && (workflowNodeRequiresWorktree(node, { reviewerInlineFixes: settings.reviewerInlineFixes === false ? false : undefined }) || node.kind === "code");
          const hasCurrentCodeReviewApproval = live.workflowStepResults?.some((result) =>
            result.reviewKind === "code"
            && result.status === "passed"
            && result.verdict === "APPROVE"
            && (live.repositoryScope === undefined || result.repositoryScopeRevision === undefined || result.repositoryScopeRevision === live.repositoryScope.revision),
          ) === true;
          /*
          FNXC:WorkflowReviewSeal 2026-08-24-16:20:
          A gate that ALREADY passed is not a new mutation. When a post-approval requeue replays the
          pre-review chain — a merge conflict, a transient merge failure — the graph walks back
          through gates whose output is already in the approved tree. Refusing them turns a
          retryable merge into a terminal wedge: measured by pipeline-smoke S13, where a conflicting
          merge left the card cycling on `documentation-delivery` with
          `workspace-review-seal-required` instead of retrying the merge it was sent back for.
          Skipping is the only coherent answer. Re-running the gate would rewrite the very tree the
          review approved and invalidate that approval, so "already produced, already reviewed" must
          resolve as satisfied. A gate with no passed result still hits the refusal below, which is
          the case the seal exists for.
          */
          /*
          FNXC:WorkflowReviewSeal 2026-08-24-20:40:
          Match the OPTIONAL-GROUP id, not just this node's own id. A gate runs as the group's inner
          template node (`documentation-delivery-step`) while its result is recorded under the group
          (`documentation-delivery`), so an id-only comparison never matched and the carve-out below
          was dead code for every optional group — exactly the shape it exists to protect. Measured
          on S13: a conflicting merge replayed the already-`skipped` documentation gate, the seal
          refused it, and the card cycled instead of retrying its merge.
          */
          /*
          FNXC:WorkflowReviewSeal 2026-08-24-21:20:
          Presence of a result row is the signal, not its status. Two facts make that exact rather
          than lax: these gates run UPSTREAM of Code Review, so a current approval proves the gate
          already ran in this episode; and the group writes a fresh `pending` row when it STARTS,
          overwriting the terminal record before this check ever sees it — measured on S13, where the
          replayed documentation gate showed `pending` with `priorAttempts=failed/failed/...` and its
          earlier `passed` was simply gone. A status test is therefore unanswerable here, while a
          gate that has genuinely never run has no row at all and is still refused below.
          Matched on the OPTIONAL-GROUP id too: a gate executes as its inner template node
          (`documentation-delivery-step`) while its result is recorded under the group.
          */
          const alreadySatisfied = live.workflowStepResults?.some((result) =>
            (result.workflowStepId === node.id || node.id === `${result.workflowStepId}-step`)
            && !result.remediationArchivedAt,
          ) === true;
          if (!isCodeReview && writeCapable && hasCurrentCodeReviewApproval && alreadySatisfied) {
            return { outcome: "success", value: "already-satisfied-under-review-seal" };
          }
          if (!isCodeReview && writeCapable && hasCurrentCodeReviewApproval) {
            /*
            FNXC:WorkflowReviewSeal 2026-08-21-20:11:
            A passed Code Review seals every task branch, not only workspace rows that carry
            repository evidence. Refuse a later write-capable node before worktree preparation or
            session creation so its explicit re-review route runs before any mutation.
            */
            return { outcome: "failure", value: "workspace-review-seal-required" };
          }
          return undefined;
        },
        runCustomNode: customNodeExecution.runner(settings),
        publishTaskProjection: async (taskId, patch) => {
          await deps.store.updateTaskAtomic(taskId, (liveTask) => {
            const update: Parameters<TaskStore["updateTask"]>[1] = {};
            if (patch.modifiedFiles) {
              const merged = [...new Set([...(liveTask.modifiedFiles ?? []), ...patch.modifiedFiles])].sort();
              if (merged.length > 0) update.modifiedFiles = merged;
            }
            if (patch.mergeDetails) {
              update.mergeDetails = { ...(liveTask.mergeDetails ?? {}), ...patch.mergeDetails };
            }
            if (patch.summary !== undefined) update.summary = patch.summary;
            return update;
          });
        },
        onEvent: (event) => executorLog.debug(`[workflow-graph] ${event.type} ${event.taskId}: ${event.detail}`),
        signal: graphAbortController.signal,
        // Wire SQLite-backed per-branch persistence in production (#1407): the
        // executor writes each branch's currentNodeId/status to
        // workflow_run_branches so fan-out crash-resume and the U9 badges have
        // real data, and prunes stale runs (#1412). Adapter degrades to no-op
        // when the store predates these methods (additive guard).
        branchPersistence: deps.buildBranchPersistence(),
        // Step-inversion (KTD-6, U3/U4): per-instance run-state persistence.
        stepInstancePersistence: deps.buildStepInstancePersistence(),
        // Step-inversion (KTD-4, U5): RETHINK reset-on-rework — when the foreach
        // sub-walk traverses a rework edge triggered by `outcome:rethink`, reset
        // the active instance's step to its persisted per-step baseline (git reset
        // + session rewind + step→pending) before re-entering step-execute.
        onReworkReset: (active) => deps.applyGraphRethinkReset(task.id, active),
        // Step-inversion (KTD-12, U12): parse-steps node handler deps — artifact
        // read (through task-documents with PROMPT.md fallback), step-list write
        // (graph-source projection), pin-protection probe, and audit.
        parseStepsDeps: deps.buildParseStepsDeps(resolvedRunId),
        // Step-inversion (KTD-15, U14): code node runner — esbuild compile +
        // child-process execution with the harness contract.
        runCode: deps.buildCodeNodeRunner(),
        notifyDispatch: (event, payload) => getActiveNotificationService()?.dispatch(event, payload),
        // PR-entity nodes (U3): pr-create/pr-respond/pr-merge handler deps —
        // engine-owned store + CLI-injected GitHub callbacks. Absent → fail closed.
        prNodes: deps.options.prNodes,
        // Step-inversion (KTD-11, U10): worktree isolation + ordered integration +
        // parallel scheduling. Per-instance worktrees branched off the task's main
        // branch tip; integration rebases each branch in step order; the projection
        // flips done-iff-integrated. Shared isolation never invokes these.
        ...deps.buildForeachWorktreeDeps(task, resolvedRunId),
        // FIX 4 (context gap): task-level log sink so an integration-conflict
        // rework writes a visible "reworking on updated base (files: ...)" entry
        // the re-running agent can read. Best-effort; logging failures swallowed.
        logTaskEntry: (summary: string, detail?: string) => {
          void deps.store
            .logEntry(task.id, summary, detail, deps.getRunContextFor(task.id))
            .catch(() => {});
        },
        /*
        FNXC:WorkflowStepResults 2026-06-25-12:00:
        Plan U2 (KTD-1/KTD-2): persistence adapter for an ENABLED optional-group
        node's outcome. The graph records each enabled group's WorkflowStepResult
        into the EXISTING `task.workflowStepResults` field keyed by `node.id` so the
        unified progress bar (getUnifiedTaskProgress) reflects graph-run steps —
        NO new table/type/store method. Upsert by `workflowStepId === node.id`
        (replace-if-present else append) through the existing
        `store.updateTask({workflowStepResults})` path. Fail-soft: degrade to a
        no-op when the store lacks updateTask, and swallow read/write errors (the
        executor wrapper also swallows) so result recording never affects the run.
        */
        /*
        FNXC:PlanReviewNoOp 2026-08-09-01:55:
        Invalid, unroutable, or failed Plan Review closes are explicit waits, not graph failures.
        Keep one held continuation at plan-review so scheduler resume preserves the audited close
        evidence without changing the task's column or manufacturing a task error.
        */
        completePlanReviewNoOp: (nodeTask, marker) => deps.completePlanReviewNoOp(nodeTask, marker),
        holdPlanReviewNoOp: async (nodeTask, suspension) => {
          continuation = await deps.holdPlanReviewNoOpContinuation(nodeTask, suspension, continuation, resolvedRunId);
        },
        recordWorkflowStepResult: (
          taskId: string,
          result: CoreWorkflowStepResult,
          fence?: WorkflowStepResultPersistFence,
        ) => persistWorkflowStepResultWithOutcome(deps, taskId, result, {
          ...fence,
          signal: graphAbortSignal,
        }),
        discardWorkflowStepLease: (taskId: string, workflowStepId: string, startedAt: string) =>
          discardWorkflowStepLease(deps, taskId, workflowStepId, startedAt),
        isRepositoryScopeReviewEdgeCurrent: async (taskId: string, workflowStepId: string, revision: number): Promise<boolean> => {
          const current = await deps.store.getTask(taskId);
          const result = current.workflowStepResults?.find((entry) => entry.workflowStepId === workflowStepId);
          return current.repositoryScope?.revision === revision
            && result?.repositoryScopeRevision === revision
            && result?.status === "passed";
        },
        requestPreMergeOptionalStepFix: (taskId, info) => deps.requestPreMergeOptionalStepFix(taskId, task, info),
        // U5c (U1 KTD-1/2/3/12): wire the production lifecycle-move hooks so the
        // graph interpreter owns the card's column moves (was reverted in U5a
        // pending U6/U7 trait re-key; safe now). Absent → the graph performs no
        // lifecycle moves (pre-cutover byte-identical); present → the controller
        // moves the card on each node-column boundary with all move-safety.
        columnBoundaryHooks: deps.buildColumnBoundaryHooks(task, resolvedRunId),
      });
      let result: WorkflowGraphTaskRunResult;
      try {
        const loadedDetail = await deps.store.getTask(task.id);
        /*
        FNXC:WorkflowExecution 2026-06-23-11:36:
        Graph dispatch must preserve the row identity that entered execute(). Minimal test stores and stale adapters can return an unrelated fallback task from getTask(); trusting that row would run the workflow under the wrong task id and bypass executor invariants. Use the refreshed row only when it matches the dispatch task.
        */
        const detail: TaskDetail = loadedDetail?.id === task.id
          ? loadedDetail
          : { ...task, prompt: task.prompt ?? task.description ?? "" };
        const workItems = await deps.store.listWorkflowWorkItemsForTask?.(task.id, { kinds: ["task"] }) ?? [];
        for (let index = workItems.length - 1; index >= 0; index -= 1) {
          const candidate = workItems[index];
          if (ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(candidate.state)) {
            continuation = candidate;
            break;
          }
        }
        if (continuation && continuation.state !== "running") {
          continuation = await deps.store.transitionWorkflowWorkItem(continuation.id, "running", {
            leaseOwner: `executor:${task.id}`,
            leaseExpiresAt: null,
            lastError: null,
          });
        }
        /*
         * FNXC:WorkflowAgentRouting 2026-08-07-07:45:
         * A direct graph resume owns the same durable continuation as scheduler
         * work-item dispatch. Rehydrate its fence before the graph reaches
         * beforeNodeExecution so recovery validates this exact principal instead
         * of silently choosing a fresh role-pool candidate.
         */
        const continuationContext = continuation?.principalAgentId
          ? {
              "workflow:work-item-id": continuation.id,
              "workflow:principal-agent-id": continuation.principalAgentId,
              "workflow:principal-role": continuation.workflowRole,
              "workflow:principal-authority": continuation.authorityKind,
              "workflow:node-instance-id": continuation.nodeInstanceId ?? continuation.nodeId,
            }
          : undefined;
        /*
         * FNXC:WorkflowExecution 2026-08-08-01:40:
         * Only a TOP-LEVEL node id is a legal resume point. A foreach template node id
         * is not in ir.nodes; re-enter at the column resume node instead of terminalizing.
         */
        const resumeNodeId = continuation?.nodeId
          && columnAgentIr?.nodes.some((candidate) => candidate.id === continuation?.nodeId)
          ? continuation.nodeId
          : undefined;
        if (continuation?.nodeId && resumeNodeId === undefined) {
          executorLog.debug(
            `[workflow-graph] ${task.id}: continuation node '${continuation.nodeId}' is not a top-level graph node `
            + `(instance '${continuation.nodeInstanceId ?? "none"}') — re-entering at the column resume node`,
          );
        }
        result = await runner.run(detail, settings, resumeNodeId, continuationContext);
      } catch (err) {
        if (continuation) {
          await deps.store.transitionWorkflowWorkItem(continuation.id, "failed", {
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: "workflow-continuation-dispatch-failed",
          }).catch(() => undefined);
        }
        executorLog.error(
          `[workflow-graph] ${task.id} interpreter threw — parking task as workflow failure: ${err instanceof Error ? err.message : String(err)}`,
        );
        await deps.handleGraphFailure(task, {
          disposition: "failed",
          outcome: "failure",
          reason: `interpreter-error: ${err instanceof Error ? err.message : String(err)}`,
          visitedNodeIds: [],
        });
        return;
      }
      const principalHoldReason = Object.values(result.context ?? {}).find((value): value is string =>
        typeof value === "string" && value.startsWith("workflow-principal-"),
      );
      /*
       * FNXC:WorkflowAgentRouting 2026-08-07-07:45:
       * Principal availability is a recoverable continuation hold, not a graph
       * failure. Do not terminalize the direct fence or call graph failure
       * handling; the next direct resume must receive the same fenced identity.
       */
      if (principalHoldReason) {
        /*
         * FNXC:WorkflowAgentRouting 2026-08-07-22:39:
         * A principal hold is a WAIT and must not be invisible. Log holds; error for the
         * never-clears composition fault (missing agent-store / IR).
         */
        const neverClears = principalHoldReason.startsWith("workflow-principal-routing-unavailable:");
        /*
         * FNXC:WorkflowAgentRouting 2026-08-10-01:15:
         * Record the backoff keyed on the hold REASON. A changed reason resets the ladder (genuinely new
         * information); repeats extend it. The first occurrence of a reason still logs immediately so the
         * hold stays greppable, while repeats stay silent so neither the engine log nor the task log floods.
         */
        const { repeated } = recordPrincipalHoldBackoff(task.id, principalHoldReason);
        const holdMessage = `[workflow-graph] ${task.id} held at graph node — ${principalHoldReason}`;
        if (!repeated) {
          if (neverClears) {
            executorLog.error(`${holdMessage} (workflow principal routing is unavailable; this hold cannot self-clear)`);
          } else {
            executorLog.warn(holdMessage);
          }
          await deps.store.logEntry(task.id, `Workflow stage held — ${principalHoldReason}`).catch(() => undefined);
        }
        if (
          continuation
          && typeof deps.store.transitionWorkflowWorkItem === "function"
          && !directWorkflowPrincipalHeldWorkItemIds.has(continuation.id)
        ) {
          await deps.store.transitionWorkflowWorkItem(continuation.id, "held", {
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: principalHoldReason,
            blockedReason: principalHoldReason,
          }).catch(() => undefined);
        }
        return;
      }
      // FNXC:WorkflowAgentRouting 2026-08-10-01:15: this run cleared the principal fence, so any prior hold is
      // resolved — drop the ladder so a later hold starts from the short delay rather than a stale long one.
      clearPrincipalHoldBackoff(task.id);
      /* Direct graph node fences are terminalized only after the interpreter
       * returns, preserving their historical principal through all handler and
       * tool-gate calls while ensuring completed work cannot render as active.
       * Availability holds intentionally remain held for recovery instead. */
      if (result.disposition !== "suspended" && directWorkflowPrincipalWorkItemIds.size > 0 && typeof deps.store.transitionWorkflowWorkItem === "function") {
        const terminalState = result.disposition === "completed" ? "succeeded" : "failed";
        await Promise.all([...directWorkflowPrincipalWorkItemIds].map(async (id) => {
          if (directWorkflowPrincipalHeldWorkItemIds.has(id)) return;
          await deps.store.transitionWorkflowWorkItem(id, terminalState, {
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: terminalState === "failed" ? "workflow-graph-node-failed" : null,
          }).catch(() => undefined);
        }));
      }
      if (result.disposition === "fell-back") {
        executorLog.warn(`[workflow-graph] ${task.id} could not resolve workflow — parking task instead of legacy fallback: ${result.reason}`);
        await deps.handleGraphFailure(task, {
          ...result,
          disposition: "failed",
          outcome: "failure",
          reason: result.reason ?? "workflow-resolution-failed",
        });
        return;
      }
      if (result.disposition === "suspended") {
        /*
         * FNXC:WorkflowExecution 2026-08-07-22:52:
         * Record suspension so an invisible wait is greppable (ids/outcomes-only audit).
         */
        const suspension = result.suspension;
        await emitBoundedRunAudit(deps.store, {
          taskId: task.id,
          agentId: "executor",
          runId: resolvedRunId ?? `workflow-run-suspended:${task.id}`,
          domain: "database",
          mutationType: "task:workflow-run-suspended",
          target: task.id,
          metadata: {
            taskId: task.id,
            nodeId: suspension?.nodeId ?? "unknown",
            reason: suspension?.reason ?? "unknown",
            fromColumn: suspension?.fromColumn ?? null,
            toColumn: suspension?.toColumn ?? null,
            continuationId: continuation?.id ?? null,
            continuationNodeId: continuation?.nodeId ?? null,
            continuationState: continuation?.state ?? null,
          },
        });
        executorLog.log(
          `[workflow-graph] ${task.id} suspended at node '${suspension?.nodeId ?? "unknown"}' (${suspension?.reason ?? "unknown"})`,
        );
        return;
      }
      /*
       * FNXC:WorkflowExecution 2026-08-08-03:20:
       * Closing the continuation is bookkeeping and must never skip handleGraphFailure.
       */
      const closeContinuation = async (state: "failed" | "succeeded"): Promise<void> => {
        if (!continuation || typeof deps.store.transitionWorkflowWorkItem !== "function") return;
        if (directWorkflowPrincipalHeldWorkItemIds.has(continuation.id)) return;
        try {
          await deps.store.transitionWorkflowWorkItem(continuation.id, state, {
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: state === "failed" ? "workflow-continuation-failed" : null,
          });
        } catch (closeErr) {
          executorLog.debug(
            `[workflow-graph] ${task.id}: continuation ${continuation.id} could not be closed as ${state} `
            + `(likely already terminal): ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
          );
        }
      };
      if (result.disposition === "failed") {
        await closeContinuation("failed");
        await deps.handleGraphFailure(task, result);
      } else if (result.disposition === "completed") {
        await closeContinuation("succeeded");
        const live = await deps.store.getTask(task.id).catch(() => task);
        if ((live as TaskDetail).mergeDetails?.mergeConfirmed === true && (live as TaskDetail).column !== await resolveCompleteColumnFor(deps.store, task.id)) {
          await deps.finalizeMergeConfirmedWorkflowGraphTask(task.id, "graph-completed");
        }
        await deps.advanceNoMergeWorkflowToCompleteColumn(live as TaskDetail);
        if ((live.graphResumeRetryCount ?? 0) !== 0 || (live.sessionContentionHoldCount ?? 0) !== 0 || live.sessionContentionWaitReason != null || (live.consecutiveToolFailureRetryCount ?? 0) !== 0) {
          await deps.store.updateTask(task.id, { graphResumeRetryCount: 0, sessionContentionHoldCount: 0, sessionContentionWaitReason: null, consecutiveToolFailureRetryCount: 0, executorEscalationAttempted: false, toolFailureDetectorLogCursor: null, toolFailureRetryExhaustedAuditEmitted: false }, deps.getRunContextFor(task.id));
        }
      }
      return;
    } finally {
      // FNXC:WorkflowGraph 2026-06-20-23:35:
      // Terminate child agents spawned by this graph run's coding-mode skill steps.
      // U8 registered fn_spawn_agent for coding-mode steps, but the graph path
      // returns from execute() at the graphOwned early-return — BEFORE execute()'s
      // outer finally that calls terminateAllChildren. Without this, graph-step
      // children orphan their sessions/worktrees, and their ids accumulate in the
      // per-parent spawn budget (spawnedAgents[taskId]), starving later steps'
      // fan-out (e.g. ce-code-review's reviewer panel). Mirror the non-graph
      // cleanup; run it before the per-run graph bookkeeping below.
      try {
        await deps.terminateAllChildren(task.id);
      } catch (err) {
        executorLog.warn(`terminateAllChildren failed for graph task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (hadPreHeldExecutorSlot) {
        deps.outerConcurrencyClaims.delete(task.id);
        /*
        FNXC:GlobalConcurrencyControls 2026-07-19-17:40 (U10b):
        Always release. The `transferPreHeldToLegacy` branch — which re-registered the reserved
        global slot for a legacy execute path to pick up — died with that path: the graph can no
        longer decline ownership, so there is no second executor to hand the slot to. Holding the
        registration with nothing left to claim it would permanently reduce global capacity.
        */
        deps.options.semaphore?.release();
      }
      for (const attemptId of workflowCapacityAttemptIds) {
        void deps.workflowAgentCapacity.release(
          attemptId,
          deps.options.agentStore?.workflowProjectId ?? deps.store.getRootDir(),
        );
      }
      deps.activeWorkflowAuthorities.delete(task.id);
      deps.activeWorkflowPrincipals.delete(task.id);
      // FNXC:AgentActivityStream 2026-08-15-22:15: drop FN-8864 gate-attribution retention for this run (restored post-wave-18).
      for (const key of deps.workflowGateActivityPrincipals.keys()) {
        if (key.startsWith(`${task.id}\0`)) deps.workflowGateActivityPrincipals.delete(key);
      }
      if (graphAbortController && deps.activeWorkflowGraphAbortControllers.get(task.id) === graphAbortController) {
        deps.activeWorkflowGraphAbortControllers.delete(task.id);
      }
      deps.graphRouting.delete(task.id);
      deps.graphToolFailureRunCursors.delete(task.id);
      // Clear per-run step-inversion pins (KTD-8: pinned only for the run's life).
      deps.graphStepSessionPinned.delete(task.id);
      deps.graphStepRunOnce.delete(task.id);
      // Clear per-run column-agent seam wiring (U4): the resolver and any dangling
      // governing-node-id are scoped to this run only.
      deps.graphColumnAgentResolver.delete(task.id);
      deps.graphUnattendedRuns.delete(task.id);
      deps.graphSeamGoverningNodeId.delete(task.id);
      deps.graphSeamThinkingLevel.delete(task.id);
      deps.graphSeamSkillName.delete(task.id);
      deps.graphExecuteSelfRequeued.delete(task.id);
      // Per-instance keys: clear every instance slot owned by this task.
      const ctxPrefix = `${task.id}:`;
      for (const key of deps.graphStepActiveContext.keys()) {
        if (key.startsWith(ctxPrefix)) deps.graphStepActiveContext.delete(key);
      }
      for (const key of deps.graphRethinkNarrations.keys()) {
        if (key.startsWith(ctxPrefix)) deps.graphRethinkNarrations.delete(key);
      }
    }
}
