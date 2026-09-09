/**
 * FNXC:CodeOrganization 2026-08-03-15:00:
 * handleGraphFailure peeled from TaskExecutor (U4).
 *
 * Terminal failure sink for a graph run: honor blocked parks, route recoverable
 * failures (worktree/session/remediation/resume), and park the task visibly when
 * no recovery path applies — never leave a failed graph invisible in in-progress.
 */
import { join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import {
  nonExecutableDuplicateRedirectReason,
  resolveExplicitDuplicateMarker,
  resolveConsecutiveToolFailureRetryBackoffMs,
  resolveConsecutiveToolFailureThreshold,
  resolveExecutorEscalationTarget,
  resolveLifecycleColumns,
  resolveMaxConsecutiveToolFailureRetries,
  hasPendingReviewRemediationWork,
  resolveReboundTarget,
  resolveStepReopenPolicy,
  resolveWorkflowIrForTask,
  resolvePreMergeGateForTask,
  TransitionRejectionError,
} from "@fusion/core";
import {
  BRANCH_WRITE_PROVENANCE_FAILURE_VALUE,
  PLAN_REVIEW_PROVIDER_FAILURE_HOLD_VALUE,
  WORKFLOW_DRIFT_PARK_CONTEXT_KEY,
} from "../workflows/workflow-graph-executor.js";
import type { WorkflowGraphTaskRunResult } from "../workflows/workflow-graph-task-runner.js";
import { isRequiredArtifactReadFailedValue } from "../execution/required-workflow-artifacts.js";
import { getPromptPath } from "../execution/spec-staleness.js";
import { executorLog } from "../logger.js";
import { generateSyntheticRunId, type EngineRunContext } from "../util/run-audit.js";
import { emitBoundedRunAudit } from "./emit-bounded-run-audit.js";
import { captureMergeContentDescriptor } from "../merge/merge-content-capture.js";
import { rerouteUnrunPreMergeGateToReview } from "../merge/pre-merge-gate-reseed.js";
import { MERGE_BOUNDARY_UNPROVEN_VALUE } from "../workflows/workflow-merge-nodes.js";
import { emitMergeBoundaryUnprovenParked } from "./emit-merge-boundary-unproven-audit.js";
import { PAUSE_ABORT_PARK_ERROR_MARKER, PAUSE_ABORT_PARK_OPERATOR_MARKER } from "../self-healing.js";
import {
  graphFailureErrorTexts,
  graphFailureValue,
  graphRunReportedPendingReview,
  isMergeGraphFailure,
  latestFailedPreMergeWorkflowStep,
  isSessionContentionGraphFailure,
  isWorkspacePreparationGraphFailure,
  isWorktreeBaseRefreshGraphFailure,
} from "./graph-failure-pure.js";
import {
  isBenignInReviewPauseAbort,
  isTransientResumeAfterRestartGraphFailure,
} from "./graph-resume-predicates.js";
import {
  buildExecuteRequeueLoopHighWaterSignature,
  EXECUTE_REQUEUE_LOOP_VISIBLE_THRESHOLD,
  MAX_EXECUTE_REQUEUE_LOOP_CYCLES,
} from "./requeue-loop.js";
import {
  resolveCompleteColumnFor,
  resolveReboundColumnFor,
  resolveTerminalColumnsFor,
} from "./lifecycle-columns.js";
import {
  isAwaitingGraphFailureValue,
  isTerminalMergeGraphFailureValue,
} from "./task-predicates.js";
import type { PausedAbortProvenance } from "./paused-abort-provenance.js";

const MAX_TRANSIENT_GRAPH_RESUME_RETRIES = 2;
const TRANSIENT_GRAPH_RESUME_RETRY_BACKOFF_MS = process.env.VITEST || process.env.NODE_ENV === "test" ? 0 : 1_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirror TaskExecutor method/map surface
type AnyFn = (...args: any[]) => any;

export type HandleGraphFailureDeps = {
  store: TaskStore;
  rootDir: string;
  options: { stuckTaskDetector?: { untrackTask?: (taskId: string) => void }; [k: string]: unknown };
  activeWorktrees: Map<string, Set<string>>;
  completionFinalizedTaskIds: Set<string>;
  graphExecuteSelfRequeued: Set<string>;
  graphToolFailureRunCursors: Map<string, number>;
  pausedAborted: Set<string>;
  pausedAbortProvenance: Map<string, PausedAbortProvenance>;
  userCanceledTaskIds: Set<string>;
  /*
  FNXC:WorkflowLifecycle 2026-08-15-22:15 (restored post-wave-18): liveness surfaces consumed by the
  transient-resume scheduled retry's FIRE-TIME guard, so a retry armed before a pause/delete/move/park
  cannot re-dispatch a task that is no longer in a safe WIP resume state.
  */
  executing: Set<string>;
  resumingUnpaused: Set<string>;
  activeSessions: Map<string, unknown>;
  activeStepExecutors: Map<string, unknown>;
  activeWorkflowStepSessions: Map<string, unknown>;
  activeCliTaskSessions: Map<string, unknown>;
  activeWorkflowGraphAbortControllers: Map<string, AbortController>;
  processWideGraphRouting: Set<string>;
  /** Deferred terminal-park callbacks currently in flight (restart-recovery intent chain). */
  deferredTerminalParksInFlight: Set<string>;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  clearCompletedTaskWatchdog: (taskId: string) => void;
  clearPausedAborted: (taskId: string) => void;
  execute: AnyFn;
  finalizeMergeConfirmedWorkflowGraphTask: AnyFn;
  getTaskCompletionBlocker: AnyFn;
  handleStaleInReviewParsePauseAbortReplay: AnyFn;
  handleStaleInReviewPlanPauseAbortReplay: AnyFn;
  handoffTaskToReview: AnyFn;
  hasLiveTaskSessionSurface: AnyFn;
  hasTrailingConsecutiveToolFailures: AnyFn;
  holdForSessionContention: AnyFn;
  isBenignManualMergeHoldPauseAbort: AnyFn;
  isReentrantPausedAbortedInFlightNode: AnyFn;
  isRemediationGraphNode: AnyFn;
  isRequiredArtifactRecoveryProtected: AnyFn;
  isRetryableBenignMergePauseAbort: AnyFn;
  parkCompletedBlockedTask: AnyFn;
  persistTokenUsage: AnyFn;
  reenterPausedAbortedWorkflowNode: AnyFn;
  resolveResumeLanes: AnyFn;
  routeGraphFailureToExecutionResume: AnyFn;
  routeGraphMergeFailureToRetry: AnyFn;
  requestPreMergeOptionalStepFix: AnyFn;
  routeImplementationIncompleteMergeGraphFailure: AnyFn;
  routeResetParsePinMismatchToRetry: AnyFn;
  routeRetryableRemediationGraphFailureToPreMergeFix: AnyFn;
  routeUnusableWorktreeGraphFailureToRecovery: AnyFn;
  safeLogEntry: AnyFn;
};

async function retryTerminalFailurePersistence(
  store: TaskStore,
  taskId: string,
  message: string,
  runContext: EngineRunContext | undefined,
  capturedColumnMovedAt: string | undefined,
): Promise<boolean> {
  /*
  FNXC:MergeRetryReliability 2026-09-04-02:24:
  Bounded terminal persistence can outlive an operator requeue during a store
  outage. Every retry therefore uses the same atomic lane-move fence as deferred
  recovery, so an old graph run cannot fail the newly requeued execution.
  */
  const delays = [1000, 2000, 4000, 8000, 16000, 32000, 64000];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    try {
      await store.updateTaskAtomic(taskId, (current) => {
        if (
          !current
          || current.deletedAt
          || current.status != null
          || current.paused
          || current.userPaused
          || (typeof capturedColumnMovedAt === "string"
            && typeof current.columnMovedAt === "string"
            && current.columnMovedAt !== capturedColumnMovedAt)
        ) return null;
        return { error: message, status: "failed" };
      }, runContext);
      return true;
    } catch (error) {
      if (attempt === delays.length - 1) {
        executorLog.error(`${taskId}: terminal graph-failure persistence exhausted: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
  return false;
}
export async function handleGraphFailure(
  deps: HandleGraphFailureDeps,
  task: Task,
  result: WorkflowGraphTaskRunResult,
): Promise<void> {

    deps.clearCompletedTaskWatchdog(task.id);
    deps.options.stuckTaskDetector?.untrackTask?.(task.id);
    try {
      const loadedLive = await deps.store.getTask(task.id);
      /*
      FNXC:WorkflowLifecycle 2026-06-23-12:01:
      Graph failure handling must never mutate a different task row than the one that entered execute(). Minimal stores can return fallback rows from getTask(); treat that as an unavailable live snapshot and leave the inner executor recovery result intact instead of handing off the wrong task.
      */
      if (!loadedLive || loadedLive.id !== task.id) {
        executorLog.warn(`${task.id}: graph failure live-state refetch returned ${loadedLive?.id ?? "null"} — preserving inner executor result`);
        await deps.persistTokenUsage(task.id);
        return;
      }
      const live = loadedLive;
      /*
      FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet: executor.ts handleGraphFailure):
      ONE LANE SNAPSHOT FOR THE WHOLE METHOD, declared where `live` first exists. The three wip comparisons
      below run BEFORE the re-entry classifiers' memo was created, so a snapshot declared beside that memo
      is used-before-declared — which is how the two halves came to read different boards in the first
      place. The memo is seeded from this snapshot so the classifiers still share it.
      */
      const resumeLanesMemo: { lanes?: { hold: string; wip: string; review: string; wipDeclared: boolean } } = {};
      const failureLanes = await deps.resolveResumeLanes(live.id, resumeLanesMemo);
      /*
      FNXC:Lifecycle 2026-07-16-21:22:
      FN-8141 follow-up 1 — an honest `fn_task_done(outcome="blocked")` park (status="failed",
      error "BLOCKED: <reason>", executor ~14657) must SURVIVE the same graph-teardown machinery
      that undid the original incident's failed park. Every downstream classifier in this method
      can wash the marker out: the genuine-pause-abort todo-rehome branch (~9504) clears
      status/error on a task the abort bounced back to `todo`; the execution-resume router and the
      terminal graph-failure sink (~9982) overwrite the distinctive `BLOCKED:` error with a generic
      "Workflow graph terminated with failure" string; and the engine-internal auto-continue
      (~9540) re-runs the doomed session. Self-healing (#2257/#2260) and dependency-gated scheduling
      key off this exact `BLOCKED:` error + the recorded blockedBy dependencies, so any of those
      would re-open the laundering hole. Detect the live blocked park BEFORE every other classifier
      and honor it exactly like the non-graph post-loop honor-park (executor ~12163): clear the
      in-memory pause-abort marker so `recoverPausedAbortFailures` has nothing to chase, RELEASE the
      worktree/concurrency slot (FN-6782 leaked-`maxWorktrees`-holder precedent; the graph finally
      does not delete `activeWorktrees`), and return WITHOUT touching status/error/column/
      dependencies/steps — the park stays intact for the blocker/operator. Unblocking still works:
      the operator requeue (moveTask in-progress→todo, moves.ts ~628) and `buildManualRetryResetPatch`
      clear the `BLOCKED:` error, and the scheduler leaves the parked row untouched while blockedBy
      dependencies are unmet.
      */
      if (live.status === "failed" && live.error?.startsWith("BLOCKED:")) {
        deps.clearPausedAborted(task.id);
        deps.activeWorktrees.delete(task.id);
        const blockedParkHonored = `Workflow graph run ended after an honest blocked park (${live.error}) — honoring park, not requeueing, retrying, or clearing state`;
        executorLog.log(`${task.id}: ${blockedParkHonored}`);
        await deps.store.logEntry(task.id, blockedParkHonored, undefined, deps.getRunContextFor(task.id));
        await deps.persistTokenUsage(task.id);
        return;
      }
      /*
      FNXC:ReviewEmptyContent 2026-08-28-13:14:
      The remediation seam returns false after its fenced park, so code-review-remediation fails and
      reaches this sink. That node already crossed review to the maxConcurrent WIP lane on entry; a
      terminal row left there would consume capacity forever. Settle it once with a forward WIP to
      review move before any resume/remediation classifier, using moveTask rather than the merge-queue
      handoff. preserveStatus plus a post-move reassert protects the ending, while
      allowDirectInReviewMove identifies the transition as legitimate. A rejected settle is a
      deferral and leaves the park valid in place. Reporting graph success is not an alternative:
      no-merge workflows would close succeeded and bypass guards while moving the failed card to done.
      */
      if (live.status === "failed" && live.error?.startsWith("NO REVIEWABLE CONTENT:")) {
        const parkedError = live.error;
        let settledColumn = live.column;
        if (failureLanes.wipDeclared && live.column === failureLanes.wip && failureLanes.review !== live.column) {
          try {
            await deps.store.moveTask(task.id, failureLanes.review, {
              moveSource: "engine",
              preserveProgress: true,
              preserveWorktree: true,
              preserveStatus: true,
              allowDirectInReviewMove: true,
            });
            settledColumn = failureLanes.review;
          } catch (error) {
            if (!(error instanceof TransitionRejectionError)) throw error;
            executorLog.warn(`${task.id}: empty-review terminal park could not settle into '${failureLanes.review}' (${error.message}); preserving park in '${live.column}'`);
          }
        }
        const afterSettle = await deps.store.getTask(task.id);
        if (afterSettle.status !== "failed" || afterSettle.error !== parkedError) {
          await deps.store.updateTask(task.id, { status: "failed", error: parkedError }, deps.getRunContextFor(task.id));
        }
        deps.clearPausedAborted(task.id);
        deps.activeWorktrees.delete(task.id);
        const emptyParkHonored = `Workflow graph run ended after a no-reviewable-content park — honoring terminal state in '${settledColumn}', not retrying or resuming`;
        executorLog.log(`${task.id}: ${emptyParkHonored}`);
        await deps.store.logEntry(task.id, emptyParkHonored, undefined, deps.getRunContextFor(task.id));
        await deps.persistTokenUsage(task.id);
        return;
      }
      /*
      FNXC:WorkflowMerge 2026-08-06-14:41:
      A merge requester can deliberately reject finalization, persist the blocker in `error`, and
      rebound the task to its workflow hold column. The graph then unwinds as a merge-node failure.
      Retrying or resuming that stale graph overrides the merger's durable decision and creates an
      unbounded hold -> merge -> hold loop. Honor the fresh parked row before any retry router; an
      operator retry can clear the error and start a new graph run explicitly.

      FNXC:EmptyMergeFinalize 2026-08-28-13:14:
      FN-217 removed merge-failure-rebound's backward-move authority, so an empty-merge refusal now
      remains in review. Honor that precise merger park when it carries a hard blocking status;
      requiring only the historical hold lane would let graph teardown overwrite it with a generic
      failure. The review lane already consumes no WIP capacity, so this branch performs no move.
      */
      const parkedMergeNode = result.visitedNodeIds[result.visitedNodeIds.length - 1];
      if (
        live.error != null &&
        (live.column === failureLanes.hold
          || (live.column === failureLanes.review && live.status === "failed")) &&
        isMergeGraphFailure(parkedMergeNode)
      ) {
        deps.clearPausedAborted(task.id);
        deps.activeWorktrees.delete(task.id);
        const mergerParkHonored = `Workflow graph run ended after merger parked task with blocker (${live.error}) — honoring park, not retrying or resuming merge`;
        executorLog.log(`${task.id}: ${mergerParkHonored}`);
        await deps.store.logEntry(task.id, mergerParkHonored, undefined, deps.getRunContextFor(task.id));
        await deps.persistTokenUsage(task.id);
        return;
      }
      /*
      FNXC:WorkflowIrPin 2026-07-19-21:10 (KTD-3 drift park, PR #2342):
      A graph run that exited on the drift guard carries WORKFLOW_DRIFT_PARK_CONTEXT_KEY
      and visited no nodes. Before this branch existed the result fell through to the
      generic terminal sink as a misleading `failedNode: 'unknown'` failure — and,
      combined with the stale pin (now cleared by detectDrift itself), that made a
      permanent requeue→drift→fail loop. Park it here with an accurate drift reason
      instead: preserve worktree/branch/step progress untouched, do NOT re-emit the
      `task:reconcile-workflow-drift` audit (detectDrift already emitted the ids-only
      event once), and leave the row recoverable by ordinary requeue — which now
      succeeds because the cleared pin lets the next run re-resolve the CURRENT IR
      and adopt the changed workflow.
      */
      if (result.context?.[WORKFLOW_DRIFT_PARK_CONTEXT_KEY] === true) {
        const driftMessage = "Workflow drift park: the workflow definition changed under this run (pinned node/column no longer in the current IR). Stale IR pin cleared — requeue the task to re-resolve the current workflow and continue.";
        executorLog.warn(`${task.id}: ${driftMessage}`);
        await deps.store.logEntry(task.id, driftMessage, undefined, deps.getRunContextFor(task.id));
        if (live.status == null && live.error == null) {
          await deps.store.updateTask(task.id, { error: driftMessage, status: "failed" }, deps.getRunContextFor(task.id));
        }
        await deps.persistTokenUsage(task.id);
        return;
      }
      /*
      FNXC:SessionContention 2026-07-25-21:30:
      Classified BEFORE every other graph-failure router. A node that could not start because another
      task holds its session path or sub-repo lease is not a provider outage, not a plan defect, and not
      a terminal failure — it is a wait. Route it to the self-recovering backoff hold, which never parks
      the task and never consumes the provider/artifact retry budgets.
      */
      /*
       * FNXC:BranchNaming 2026-08-21-09:09:
       * A rejected branch provenance is deterministic task mutation input, not a model/provider
       * outage. Park it exactly once before every retry classifier so recovery cannot replay a
       * freshly-created checkout or consume graph/provider retry budgets.
       */
      if (graphFailureValue(result) === BRANCH_WRITE_PROVENANCE_FAILURE_VALUE) {
        const diagnostic = graphFailureErrorTexts(result).find((message) => message.includes("branchWriteOrigin is required when branch is provided"))
          ?? "branchWriteOrigin is required when branch is provided";
        await deps.store.logEntry(task.id, diagnostic, undefined, deps.getRunContextFor(task.id));
        await deps.store.updateTask(task.id, { status: "failed", error: diagnostic }, deps.getRunContextFor(task.id));
        await deps.persistTokenUsage(task.id);
        return;
      }
      if (isSessionContentionGraphFailure(result)) {
        await deps.holdForSessionContention(task, live, result);
        await deps.persistTokenUsage(task.id);
        return;
      }
      /*
      FNXC:WorkspacePreparation 2026-08-21-19:39:
      A workspace `git worktree add` or base-ref failure occurs before a model session exists.
      Route it through the bounded environment hold before the Plan Review provider classifier so
      Git diagnostics remain actionable and provider retry accounting is untouched.
      */
      if (isWorkspacePreparationGraphFailure(result)) {
        const diagnostic = graphFailureErrorTexts(result)[0]
          ?? "Workspace repository preparation failed before a reviewer session started";
        /*
        FNXC:WorkspacePreparation 2026-08-21-19:52:
        Git preparation is an environment episode, not a graph/provider retry. Reuse the durable
        worktree recovery family so Retry resets only its dedicated counter and the Git cause survives.
        */
        if (await deps.routeUnusableWorktreeGraphFailureToRecovery(task, live, result, resumeLanesMemo)) {
          await deps.persistTokenUsage(task.id);
          return;
        }
        await deps.store.updateTask(task.id, {
          status: "failed",
          error: `${diagnostic} — repair/create the repository base ref or configuration, then choose Retry`,
        }, deps.getRunContextFor(task.id));
        await deps.persistTokenUsage(task.id);
        return;
      }
      /*
      FNXC:WorktreeBaseRefresh 2026-08-01-16:33:
      Code-node acquisition publishes every stale/unknown checkout refusal as a typed graph value.
      Keep it in the same bounded delayed-resume lane as other recoverable pre-session failures so
      no handler runs, no failure edge mislabels it as a plan defect, and its exact reason survives
      in the task log. Exhaustion deliberately leaves the task held for a later clean acquisition.
      */
      if (isWorktreeBaseRefreshGraphFailure(result)) {
        const refreshKind = graphFailureValue(result)!;
        const priorRetries = live.graphResumeRetryCount ?? 0;
        if (priorRetries < MAX_TRANSIENT_GRAPH_RESUME_RETRIES) {
          const nextRetries = priorRetries + 1;
          const message = `Worktree base refresh blocked execution (${refreshKind}) — retrying in place (${nextRetries}/${MAX_TRANSIENT_GRAPH_RESUME_RETRIES})`;
          await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
          await deps.store.updateTask(task.id, { graphResumeRetryCount: nextRetries }, deps.getRunContextFor(task.id));
          const scheduleRetry = () => {
            deps.execute(live).catch((err: unknown) =>
              executorLog.error(`Failed worktree base refresh retry for ${task.id}:`, err),
            );
          };
          const handle = setTimeout(scheduleRetry, TRANSIENT_GRAPH_RESUME_RETRY_BACKOFF_MS);
          handle.unref?.();
        } else {
          await deps.store.logEntry(
            task.id,
            `Worktree base refresh remains blocked (${refreshKind}) — retry budget exhausted; task remains held`,
            undefined,
            deps.getRunContextFor(task.id),
          );
        }
        await deps.persistTokenUsage(task.id);
        return;
      }
      /*
      FNXC:MissingWorktreeRecovery 2026-07-16-18:25:
      An unusable-worktree session-start refusal inside a graph node must route to the bounded
      worktree-session recovery BEFORE any other classifier: FN-7977's provider-failure hold
      would otherwise retry the same stale worktree in place, and the terminal sink would park
      the task failed with the signature erased (FN-7996 looped dispatch→park all day).
      */
      if (await deps.routeUnusableWorktreeGraphFailureToRecovery(task, live, result, resumeLanesMemo)) {
        await deps.persistTokenUsage(task.id);
        return;
      }
      if (isRequiredArtifactReadFailedValue(graphFailureValue(result))) {
        /*
        FNXC:WorkflowArtifacts 2026-07-21-17:00:
        A TaskStore read outage is not proof that an artifact is absent. Keep the
        task in place and use the bounded graph-resume budget instead of replanning
        or terminalizing a possibly healthy workflow contract.
        */
        const priorRetries = live.graphResumeRetryCount ?? 0;
        if (priorRetries < MAX_TRANSIENT_GRAPH_RESUME_RETRIES) {
          const nextRetries = priorRetries + 1;
          const message = `Required workflow artifact could not be read — retrying in place (${nextRetries}/${MAX_TRANSIENT_GRAPH_RESUME_RETRIES})`;
          await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
          await deps.store.updateTask(task.id, { graphResumeRetryCount: nextRetries }, deps.getRunContextFor(task.id));
          const scheduleRetry = () => {
            void (async () => {
              try {
                const resumeTask = await deps.store.getTask(task.id);
                if (await deps.isRequiredArtifactRecoveryProtected(resumeTask) || resumeTask.status === "failed") return;
                await deps.execute(resumeTask);
              } catch (err) {
                executorLog.error(`Failed required-artifact read retry for ${task.id}:`, err);
              }
            })();
          };
          const handle = setTimeout(scheduleRetry, TRANSIENT_GRAPH_RESUME_RETRY_BACKOFF_MS);
          handle.unref?.();
        } else {
          await deps.store.logEntry(
            task.id,
            "Required workflow artifact read retry budget exhausted — task remains held in its current state",
            undefined,
            deps.getRunContextFor(task.id),
          );
        }
        await deps.persistTokenUsage(task.id);
        return;
      }
      if (graphFailureValue(result) === PLAN_REVIEW_PROVIDER_FAILURE_HOLD_VALUE) {
        /*
         * FNXC:PlanReviewReplan 2026-07-15-16:35:
         * FN-7977: graph-native Plan Review provider failures are a bounded
         * in-place retry. They must not follow the built-in failure edge into
         * plan-replan or overwrite a progressed card's column, worktree, or steps.
         */
        const priorRetries = live.graphResumeRetryCount ?? 0;
        if (priorRetries < MAX_TRANSIENT_GRAPH_RESUME_RETRIES) {
          const nextRetries = priorRetries + 1;
          const message = `Plan Review provider failure — retrying in place (${nextRetries}/${MAX_TRANSIENT_GRAPH_RESUME_RETRIES})`;
          executorLog.warn(`${task.id}: ${message}`);
          await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
          await deps.store.updateTask(task.id, {
            graphResumeRetryCount: nextRetries,
          }, deps.getRunContextFor(task.id));
          const scheduleRetry = () => {
            deps.execute(live).catch((err: unknown) =>
              executorLog.error(`Failed Plan Review provider retry for ${task.id}:`, err),
            );
          };
          const handle = setTimeout(scheduleRetry, TRANSIENT_GRAPH_RESUME_RETRY_BACKOFF_MS);
          handle.unref?.();
        } else {
          const message = "Plan Review provider retry budget exhausted — task remains held in its current state";
          executorLog.warn(`${task.id}: ${message}`);
          await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
        }
        await deps.persistTokenUsage(task.id);
        return;
      }
      if (live.mergeDetails?.mergeConfirmed === true && live.column !== await resolveCompleteColumnFor(deps.store, live.id)) {
        if (await deps.finalizeMergeConfirmedWorkflowGraphTask(live.id, "graph-failure")) {
          await deps.persistTokenUsage(task.id);
          return;
        }
      }
      // A paused/aborted implementation is not a graph failure while the task
      // is still in-progress — leave the pause machinery in charge instead of
      // parking the task in review.
      const pausedAborted = deps.pausedAborted.has(task.id);
      const abortProvenance = deps.pausedAbortProvenance.get(task.id);
      const mergeSeamAborted = abortProvenance === "merge-seam";
      const completionFinalizeAborted = abortProvenance === "completion-finalize";
      const persistedCompletionFinalizeLog = live.log?.some((entry) => entry.action.includes("Execution paused after completion — finalizing to in-review")) === true;
      const persistedCompletedProgress = live.steps.length > 0 && live.steps.every((step) => step.status === "done" || step.status === "skipped");
      /*
      FNXC:WorkflowLifecycle 2026-06-17-23:39: A real live pause still parks even if stale provenance says completion-finalize; completed handoff rows are expected to be unpaused.

      FNXC:WorkflowLifecycle 2026-06-18-10:57:
      FN-6644: a completed/no-commit execution that already finalized to in-review must not be re-parked as an operator-action pause abort when later teardown overwrites FN-6625 `completion-finalize` provenance with `hard-cancel` (FN-6641). Only suppress the pause-abort branch for already-finalized, non-in-progress rows with no live user/global pause; active execution hard-cancel and genuine pause/global-pause still park or preserve exactly as before.

      FNXC:WorkflowLifecycle 2026-06-18-12:00:
      FN-6647 closes the remaining durability gap by deriving already-finalized completion from the persisted task row: non-in-progress column, completed steps, no live pause/status/error, and the finalize-to-review log entry. The volatile `completionFinalizedTaskIds` marker still helps within one executor lifecycle, but teardown/restart loss must not reclassify a completed in-review row as a hard-cancel pause abort.
      */
      /* FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet): on a renamed board a completed,
         already-finalized row read as still-in-wip, so FN-6644/FN-6647's suppression never fired and the
         row was re-parked as an operator-action pause abort — the durability gap those tickets closed. */
      const alreadyFinalizedToReview = Boolean(
        live.column !== failureLanes.wip
          && persistedCompletedProgress
          && live.status == null
          && live.error == null
          && live.userPaused !== true
          // FNXC:WorkflowLifecycle 2026-06-18-16:20:
          // FN-6648: do NOT require `paused !== true` here. The
          // paused-after-completion graceful-exit path (executor ~8748/8194)
          // finalizes a FULLY COMPLETED task to in-review while leaving a
          // NON-user `paused: true` flag set — handoffToReview /
          // applyInReviewEnterEffects clear status/blockedBy/overlapBlockedBy
          // but never `paused`. Requiring `paused !== true` made this clean
          // completion unrecognizable, so `genuinePauseAbort` parked it failed
          // with the spurious "engine abort during pause/resume" error
          // (FN-6638 recurrence). `userPaused`/global-pause are still excluded,
          // and `persistedCompletedProgress` + `persistedCompletionFinalizeLog`
          // + status/error == null keep this scoped to genuine completions.
          && abortProvenance !== "global-pause"
          && !mergeSeamAborted
          && persistedCompletionFinalizeLog,
      );
      const completionFinalized = completionFinalizeAborted || deps.completionFinalizedTaskIds.has(task.id) || alreadyFinalizedToReview;
      const suppressFinalizedCompletionAbort = Boolean(
        completionFinalized
          && live.column !== failureLanes.wip
          && !live.userPaused
          // FN-6648: `paused !== true` intentionally dropped here too — the
          // suppression is already gated on `completionFinalized` (completed
          // steps + finalize-to-review evidence) plus userPaused/global-pause
          // exclusions, so a lingering non-user post-completion pause flag must
          // not defeat it. See alreadyFinalizedToReview note above.
          && abortProvenance !== "global-pause"
          && !mergeSeamAborted,
      );
      const genuinePauseAbort = Boolean(
        live.userPaused
          || abortProvenance === "global-pause"
          // FN-6648: gate the bare `paused` clause on the completion-finalize
          // suppression so a completed task carrying a non-user post-completion
          // pause flag is not parked as an operator-action failure.
          || (live.paused && !mergeSeamAborted && !suppressFinalizedCompletionAbort)
          || (pausedAborted && !mergeSeamAborted && !completionFinalizeAborted && !suppressFinalizedCompletionAbort),
      );
      const failedNodeForLog = result.visitedNodeIds[result.visitedNodeIds.length - 1] ?? "unknown";
      const failureValueForLog = graphFailureValue(result) ?? "none";
      if (pausedAborted || live.paused || live.userPaused || abortProvenance) {
        deps.safeLogEntry(
          task.id,
          `Pause abort classified: provenance=${abortProvenance ?? "unknown"}; node=${failedNodeForLog}; interrupted=${result.interruptedNodeId ?? "none"}; abortKind=${result.interruptedAbortKind ?? "none"}; column=${live.column}; status=${live.status ?? "none"}; paused=${live.paused === true}; userPaused=${live.userPaused === true}; value=${failureValueForLog}; genuine=${genuinePauseAbort}; mergeSeam=${mergeSeamAborted}; completionSuppressed=${suppressFinalizedCompletionAbort}`,
        );
      }
      /*
      FNXC:WorkflowLifecycle 2026-08-29-02:20:
      FN-249 treats an operator cancellation as the terminal outcome for its in-flight graph run.
      Keep the existing breadcrumb, then stop before every recovery classifier so a canceled run
      cannot retry a merge or manufacture a failed park; engine aborts have no user-cancel marker
      and retain their existing recoveries.

      FNXC:WorkflowLifecycle 2026-08-31-06:41:
      "its in-flight graph run" is enforced at the RUN BOUNDARY, not here. Every abort marker this
      function reads (`userCanceledTaskIds`, `pausedAborted`, `pausedAbortProvenance`) is a plain
      task-keyed in-memory collection with no run identity, and `executeWorkflowGraph` now clears
      them as each run is born -- see the reset there. That is what makes this check honest: a marker
      present at teardown can only have been set DURING this run.

      An earlier attempt guarded HERE instead, by asking whether the run "carried abort evidence",
      and it failed in exactly the way it was meant to prevent. It counted `pausedAborted` as
      evidence, but `awaitAbortInFlightTaskWork` stamps that marker UNCONDITIONALLY -- even when the
      cancel finds no live surface -- so a dashboard Retry on an idle card left it set and the NEXT
      run read it as its own. Worse, the same stale marker also turns `genuinePauseAbort` true below,
      so a REVISE was classified as a pause abort even once it got past this branch. Both traps have
      one cause, and it is the missing per-run reset, not the reading of it.
      */
      if (deps.userCanceledTaskIds.has(task.id)) {
        deps.clearPausedAborted(task.id);
        deps.activeWorktrees.delete(task.id);
        const cancellationExit = "Workflow graph run ended after operator cancellation — no merge routing, no failure park";
        executorLog.log(`${task.id}: ${cancellationExit}`);
        await deps.store.logEntry(task.id, cancellationExit, undefined, deps.getRunContextFor(task.id));
        await deps.persistTokenUsage(task.id);
        return;
      }
      /*
      FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (PR #2640 review, greptile P2): one lane
      snapshot for one recovery decision — see `resolveResumeLanes`. Eligibility and re-entry are two
      halves of the SAME decision and must not read different boards.

      FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet): the surrounding branches share it now too.
      This method asked "still in the wip lane?" in three more places as the default lineage's id while
      creating this memo for the classifiers — so the classifiers read the board and the branches around
      them read the default names.
      */
      if (genuinePauseAbort && await deps.isReentrantPausedAbortedInFlightNode(live, result, abortProvenance, pausedAborted, deps.userCanceledTaskIds.has(task.id), resumeLanesMemo)) {
        if (await deps.reenterPausedAbortedWorkflowNode(live, result, abortProvenance, resumeLanesMemo)) {
          return;
        }
      }
      /*
      FNXC:WorkflowMerge 2026-07-14-18:20:
      FN-1165 greptile P1: system pause (`live.paused` without userPaused/global-pause) must still enter the
      implementation-incomplete merge classifier. Requiring `live.paused !== true` let pause-abort parking win and
      skipped fail-closed/resumable routing for missing implementation proof. User pause and global-pause stay excluded.
      */
      if (
        genuinePauseAbort
        && abortProvenance !== "global-pause"
        && abortProvenance !== "completion-finalize"
        && live.userPaused !== true
        && isMergeGraphFailure(failedNodeForLog)
        && failureValueForLog === "implementation-incomplete"
      ) {
        if (await deps.routeImplementationIncompleteMergeGraphFailure(live, failedNodeForLog)) {
          return;
        }
      }
      if (genuinePauseAbort && await deps.isRetryableBenignMergePauseAbort(live, result, abortProvenance, pausedAborted, deps.userCanceledTaskIds.has(task.id), resumeLanesMemo)) {
        if (await deps.routeGraphMergeFailureToRetry(live, result, abortProvenance)) {
          return;
        }
      }
      if (genuinePauseAbort && await deps.isBenignManualMergeHoldPauseAbort(live, result, abortProvenance, pausedAborted, resumeLanesMemo)) {
        /*
        FNXC:WorkflowLifecycle 2026-07-09-14:56:
        FN-7749 / Runfusion#1979: auto-merge-off manual merge hold is terminal-until-human-merged, not an executor failure. Preserve the `in-review` row for Merge & Close, do not invoke merge retry, and clear only stale pause-abort status/error so FN-5147's no-backward-move/no-reenqueue contract stays intact.
        */
        deps.clearPausedAborted(task.id);
        deps.activeWorktrees.delete(task.id);
        const manualHoldBenign = "Workflow graph run ended at manual merge hold with auto-merge off — benign, in-review manual-hold state preserved for Merge & Close";
        executorLog.log(`${task.id}: ${manualHoldBenign}`);
        await deps.store.logEntry(task.id, manualHoldBenign, undefined, deps.getRunContextFor(task.id));
        if (live.status != null || live.error != null) {
          await deps.store.logEntry(task.id, "Auto-recovered: cleared stale auto-merge-off manual merge hold pause-abort failure — failure notification suppressed", undefined, deps.getRunContextFor(task.id));
          await deps.store.updateTask(task.id, { status: null, error: null }, deps.getRunContextFor(task.id));
        }
        await deps.persistTokenUsage(task.id);
        return;
      }
      if (genuinePauseAbort && isBenignInReviewPauseAbort(live, result, abortProvenance, pausedAborted, deps.userCanceledTaskIds.has(task.id), failureLanes.review)) {
        deps.clearPausedAborted(task.id);
        deps.activeWorktrees.delete(task.id);
        const inReviewBenign = "Workflow graph run ended during engine pause/resume while already in-review — benign, in-review state preserved";
        executorLog.log(`${task.id}: ${inReviewBenign}`);
        await deps.store.logEntry(task.id, inReviewBenign, undefined, deps.getRunContextFor(task.id));
        await deps.persistTokenUsage(task.id);
        return;
      }
      if (genuinePauseAbort && await deps.handleStaleInReviewParsePauseAbortReplay(live, result, abortProvenance, pausedAborted, deps.userCanceledTaskIds.has(task.id), resumeLanesMemo)) {
        return;
      }
      if (genuinePauseAbort && await deps.handleStaleInReviewPlanPauseAbortReplay(live, result, abortProvenance, pausedAborted, deps.userCanceledTaskIds.has(task.id), resumeLanesMemo)) {
        return;
      }
      if (genuinePauseAbort) {
        /*
        FNXC:WorkflowLifecycle 2026-06-15-01:45:
        FN-6478: a graph exit during an in-progress pause is recoverable by explicit unpause, but the same exit after the task has already left in-progress strands the workflow graph. Preserve userPaused and autoMerge:false review parking; surface non-in-progress paused exits as operator-actionable failures without moving the task backward or re-enqueueing execution.

        FNXC:WorkflowLifecycle 2026-06-17-03:48:
        FN-6568: merge-seam aborts are not pause provenance. A non-paused merge-node failure must bypass this operator-action pause branch so FN-6528/FN-6531/FN-6534/FN-6537-style failures route to bounded auto-merge retry instead of being parked failed with mergeRetries=NULL.

        FNXC:WorkflowLifecycle 2026-06-17-23:32:
        FN-6625: completion-finalize aborts are teardown artifacts after a completed/no-commit execution has already advanced to in-review. Without excluding that provenance, the FN-6614 execute-node tail failure was mislabeled as an operator-action pause abort and re-parked failed.
        */
        // FNXC:WorkflowLifecycle 2026-07-12-09:05: check `live.paused` BEFORE the
        // bare pausedAborted marker — a task-pause park that survived teardown
        // (preservePause, FN-7851) is operator intent, not an engine-internal
        // abort, and must be labeled as such so the benign re-queue log below
        // does not misreport it as engine churn.
        const pauseProvenance = live.userPaused
          ? "explicit user pause"
          : abortProvenance === "global-pause"
            ? "global pause"
            : live.paused
              ? "task pause"
              : pausedAborted
                ? "engine abort during pause/resume"
                : "task pause";
        // Typed discriminant for the engine-internal abort case (mirrors the
        // `pauseProvenance === "engine abort during pause/resume"` arm above):
        // a generic (`hard-cancel`/`engine-abort`, KB-PROV 2026-07-26) teardown that is
        // NOT a user pause or global pause. Used
        // to gate the auto-continue branch so the gate cannot silently drift if
        // the human-readable provenance label is ever revised.
        const isEngineInternalAbort =
          pausedAborted && !live.paused && !live.userPaused && abortProvenance !== "global-pause";
        if (live.column !== failureLanes.wip) {
          // FN-6782: a pause/resume abort that has left the task back in `todo`
          // is benign — the work is simply re-queued for a fresh dispatch, not
          // stranded. Parking it `status: "failed"` (operator action required)
          // here is what caused the retry storm: the scheduler re-dispatches the
          // todo task, this branch re-fires on the still-set pausedAborted
          // marker, and it re-parks instantly with no backoff. Treat `todo` like
          // the in-progress benign case: clear the abort marker so the next
          // dispatch starts clean, log, and return WITHOUT parking failed. The
          // operator-action failure is preserved only for genuinely stranded
          // non-todo columns (e.g. in-review), per FN-6478.
          if (live.column === await resolveReboundColumnFor(deps.store, task.id)) {
            deps.clearPausedAborted(task.id);
            // FNXC:WorkflowLifecycle 2026-06-20-00:00: FN-6782 leak fix — a task
            // parked back to `todo` must not keep pinning its in-memory worktree
            // slot. The execute() finally does not delete activeWorktrees on this
            // early-return path, so without this release the slot leaks — a `todo`
            // task stays a maxWorktrees holder and concurrency-blocks the whole
            // queue (the FN-6756 "in todo yet still a holder, maxWorktrees=3/3"
            // symptom). Mirror clearPhantomExecutorBinding's release semantics.
            // Safe here: handleGraphFailure is terminal for this run (no seam
            // re-entry), and the next dispatch re-acquires a fresh worktree.
            deps.activeWorktrees.delete(task.id);
            // FNXC:WorkflowLifecycle 2026-06-20-22:42: FN-6782 follow-up — an
            // "engine abort during pause/resume" is NOT an operator action: the
            // engine tore down in-flight work (hard-cancel via
            // abortInFlightTaskWork) while the workflow graph run was ending and
            // the task got re-queued to todo. Bouncing it back through todo for
            // a fresh scheduler dispatch is observable churn and used to fire a
            // spurious failure notification. Instead, continue the agent session
            // automatically by re-executing in place, bounded by the same
            // graphResumeRetryCount budget + backoff as the transient-resume
            // path (and reset to 0 on the next clean graph completion, executor
            // ~4242) so a genuinely wedged task still falls through to the benign
            // re-queue after MAX retries rather than looping with no backoff.
            // Scoped strictly to the engine-internal abort provenance: an
            // explicit user pause / global pause / task pause that landed in todo
            // must still wait for an explicit resume (the benign re-queue below).
            // The graphResumeRetryCount budget is deliberately SHARED with the
            // transient-resume-after-restart path (executor ~6850): both are
            // "the graph run ended transiently, re-run it" recoveries, and a
            // single combined cap is the belt-and-suspenders guard the
            // executor-retry-storm tests assert against. The count is reset to 0
            // only on a clean graph completion (~4242) — NOT on the benign
            // fallback below, so a still-wedged task that exhausts the budget
            // stops auto-continuing instead of looping (resetting here would
            // reintroduce a slower storm).
            if (isEngineInternalAbort) {
              const priorRetries = live.graphResumeRetryCount ?? 0;
              if (priorRetries < MAX_TRANSIENT_GRAPH_RESUME_RETRIES) {
                const nextRetries = priorRetries + 1;
                const retryMessage = `Workflow graph run ended during ${pauseProvenance} — auto-continuing the agent session (${nextRetries}/${MAX_TRANSIENT_GRAPH_RESUME_RETRIES}) instead of re-queueing to todo`;
                executorLog.log(`${task.id}: ${retryMessage}`);
                await deps.store.logEntry(task.id, retryMessage, undefined, deps.getRunContextFor(task.id));
                // Emit the Auto-recovered marker BEFORE clearing status so the
                // status-clearing updateTask's task:updated event already carries
                // the recovery log — NotificationService.maybeSuppressTransientFailedNotification
                // (recoveredStatus path) then proactively cancels any pending
                // failure timer rather than relying on the race-contingent
                // fire-time re-check.
                await deps.store.logEntry(task.id, "Auto-recovered: engine-internal pause/resume abort — retrying agent session, failure notification suppressed", undefined, deps.getRunContextFor(task.id));
                await deps.store.updateTask(task.id, { graphResumeRetryCount: nextRetries, status: null, error: null }, deps.getRunContextFor(task.id));
                await deps.persistTokenUsage(task.id);
                const scheduleRetry = () => {
                  // Re-fetch at fire time: the snapshot is up to
                  // TRANSIENT_GRAPH_RESUME_RETRY_BACKOFF_MS stale, and the direct
                  // execute() bypasses the scheduler's pause filter (we cleared
                  // pausedAborted at the top of this branch). If a user paused,
                  // moved, or deleted the task during the backoff window, abort
                  // the auto-continue and leave it to normal scheduling so we
                  // never resume work the user just parked.
                  void (async () => {
                    try {
                      const resumeTask = await deps.store.getTask(task.id);
                      if (
                        resumeTask.deletedAt
                        || resumeTask.paused
                        || resumeTask.userPaused
                        || resumeTask.column !== await resolveReboundColumnFor(deps.store, task.id)
                      ) {
                        executorLog.log(
                          `${task.id}: skipping pause-abort auto-continue — task is now ${resumeTask.deletedAt ? "deleted" : resumeTask.paused || resumeTask.userPaused ? "paused" : `in '${resumeTask.column}'`} at retry fire time`,
                        );
                        return;
                      }
                      await deps.execute(resumeTask);
                    } catch (err) {
                      executorLog.error(`Failed pause-abort internal retry for ${task.id}:`, err);
                    }
                  })();
                };
                if (TRANSIENT_GRAPH_RESUME_RETRY_BACKOFF_MS > 0) {
                  const handle = setTimeout(scheduleRetry, TRANSIENT_GRAPH_RESUME_RETRY_BACKOFF_MS);
                  handle.unref?.();
                } else {
                  setTimeout(scheduleRetry, 0).unref?.();
                }
                return;
              }
              // Note: the count is left at MAX (not reset here) deliberately, so
              // this task stops auto-continuing until a clean graph completion
              // resets it (~4242). Because the budget is SHARED with the
              // transient-resume-after-restart path (~6869), a task that already
              // burned retries there starts here with a smaller auto-continue
              // budget — and vice versa. That cross-draining is intentional: a
              // single combined cap across both transient-recovery paths is what
              // bounds runaway re-runs, even if it means a repeatedly
              // hard-cancelled task that never completes cleanly exhausts the
              // shared budget and falls back to plain todo re-queueing.
              executorLog.warn(`${task.id}: engine abort during pause/resume exhausted ${MAX_TRANSIENT_GRAPH_RESUME_RETRIES} internal retries — falling back to benign todo re-queue`);
            }
            // FNXC:WorkflowLifecycle 2026-07-12-09:05: a row still carrying a
            // pause park (paused/userPaused) is NOT "cleared for normal
            // scheduling" — the scheduler skips it until an explicit unpause.
            // Say so, or the log contradicts the board (FN-7851 misdiagnosis).
            const todoBenign = live.paused || live.userPaused
              ? `Workflow graph run ended during ${pauseProvenance} with task parked in todo — benign, paused awaiting explicit unpause`
              : `Workflow graph run ended during ${pauseProvenance} with task re-queued to todo — benign, cleared for normal scheduling`;
            executorLog.log(`${task.id}: ${todoBenign}`);
            await deps.store.logEntry(task.id, todoBenign, undefined, deps.getRunContextFor(task.id));
            // FNXC:WorkflowLifecycle 2026-06-20-19:58: reconcile a stale
            // persisted failure with the benign reclassification. A pause-abort
            // parked `status:"failed"` on an earlier non-todo observation stays
            // dispatchable (scheduler.ts filters column+paused, NOT status) and
            // re-enters this branch in `todo`; `recoverPausedAbortFailures` that
            // would clear it is suppressed during global/engine pause
            // (self-healing.ts). Leaving the row failed contradicts the benign
            // log: the board shows it failed AND the deferred failure
            // notification fires (notification-service fire-time check sees
            // status === "failed"). Clear status/error here so the row matches
            // the log, then emit an `Auto-recovered:`-prefixed entry so
            // NotificationService.maybeSuppressTransientFailedNotification
            // PROACTIVELY cancels the pending failure timer on the task:updated
            // event (recoveredStatus path) — rather than relying only on the
            // fire-time re-check, which is race-contingent when
            // failureNotificationDelayMs is near 0. The prefix is the documented
            // contract for self-healing recovery logs (see self-healing.ts /
            // project-engine.ts). Scoped to the actual-clear path so the common
            // no-failure benign re-queue is not mislabeled as a recovery.
            if (live.status != null || live.error != null) {
              await deps.store.updateTask(task.id, { status: null, error: null }, deps.getRunContextFor(task.id));
              await deps.store.logEntry(task.id, "Auto-recovered: cleared stale pause-abort failure on todo re-queue — failure notification suppressed", undefined, deps.getRunContextFor(task.id));
            }
            await deps.persistTokenUsage(task.id);
            return;
          }
          /*
          FNXC:WorkflowLifecycle 2026-07-12:
          A pause-abort whose task already reached a terminal SUCCESS column is
          benign teardown, not an operator problem. The live-acceptance repro:
          the workflow merge boundary hard-cancels the in-flight executor
          session when it moves the task in-progress → in-review
          (abort-in-flight provenance=engine-abort, formerly hard-cancel — KB-PROV 2026-07-26), the AI merge then lands and
          the task advances to done — and only afterwards does the aborted
          graph run reach this sink, where it logged "Workflow graph failure
          surfaced ... operator action required; retry or explicitly
          unpause/resume" on a task that finished perfectly. The `status:
          "failed"` write below was already guarded for workflow Complete, but the
          alarming operator-action log entry (and its warn) still fired on
          every auto-merged task. Treat Complete like the todo benign
          case: clear the abort marker, release the worktree slot, log a
          benign completion note, and never emit the PAUSE_ABORT_PARK markers
          (so self-healing's recoverPausedAbortFailures has nothing to chase).
          */
          if ((await resolveTerminalColumnsFor(deps.store, live.id)).includes(live.column)) {
            deps.clearPausedAborted(task.id);
            deps.activeWorktrees.delete(task.id);
            const doneBenign = `Workflow graph run ended during ${pauseProvenance} after the task already completed ('${live.column}') — benign, no action needed`;
            executorLog.log(`${task.id}: ${doneBenign}`);
            await deps.store.logEntry(task.id, doneBenign, undefined, deps.getRunContextFor(task.id));
            await deps.persistTokenUsage(task.id);
            return;
          }
          const failedNode = result.visitedNodeIds[result.visitedNodeIds.length - 1] ?? "unknown";
          // FNXC:WorkflowLifecycle 2026-06-20-00:00: build the parked-failure
          // message from the shared markers so self-healing's recoverPausedAbortFailures
          // predicate cannot drift out of sync with this text (PR #1687 review).
          const message = `${PAUSE_ABORT_PARK_ERROR_MARKER} ${pauseProvenance} in '${live.column}' at node '${failedNode}' — ${PAUSE_ABORT_PARK_OPERATOR_MARKER}; retry or explicitly unpause/resume after inspecting the task`;
          executorLog.warn(`${task.id}: ${message}`);
          await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
          if (live.status == null && live.error == null) {
            await deps.store.updateTask(task.id, { error: message, status: "failed" }, deps.getRunContextFor(task.id));
          }
          await deps.persistTokenUsage(task.id);
          return;
        }
        const benignMessage = "Workflow graph run ended while task is paused — pause state preserved";
        executorLog.log(`${task.id}: ${benignMessage} (${pauseProvenance})`);
        await deps.store.logEntry(task.id, benignMessage, undefined, deps.getRunContextFor(task.id));
        return;
      }
      const failedNode = result.visitedNodeIds[result.visitedNodeIds.length - 1];
      const mergeGraphFailure = isMergeGraphFailure(failedNode);
      const failureValue = graphFailureValue(result);
      /*
      FNXC:DuplicateIntake 2026-08-01-19:24:
      Defense in depth for FN-8704: if a card slipped into WIP with PROMPT.md = only
      `DUPLICATE: FN-####`, the graph dies at the parse node. Parked `failed` in WIP
      re-ran forever on Retry. Rebound to needs-replan with feedback instead of
      terminal failed so triage rewrites a real plan. Primary gate is scheduler
      filesystem validation; this recovers cards already past admission.
      */
      if (
        !live.paused
        && !live.userPaused
        && !live.deletedAt
        && typeof failedNode === "string"
        && (failedNode === "parse" || failedNode.endsWith(":parse") || failedNode.includes("parse-steps") || failureValue === "parse-error" || failureValue === "missing-implementation-steps")
      ) {
        try {
          const tasksDir = typeof deps.store.getTasksDir === "function"
            ? deps.store.getTasksDir()
            : join(deps.rootDir, ".fusion", "tasks");
          const promptContent = await readFile(getPromptPath(tasksDir, live.id), "utf-8").catch(() => "");
          const redirectReason = nonExecutableDuplicateRedirectReason(promptContent, live.title);
          if (redirectReason) {
            const duplicateResolution = resolveExplicitDuplicateMarker(promptContent, live.title);
            const marker = duplicateResolution.marker;
            await deps.store.updateTask(live.id, {
              status: null,
              error: null,
            }, deps.getRunContextFor(live.id));
            const feedback = marker
              ? `Execution parse rejected non-executable duplicate redirect (DUPLICATE: ${marker.canonicalId}). Write a full plan body; do not re-emit only DUPLICATE: ${marker.canonicalId}.`
              : `Execution parse rejected conflicting duplicate redirects (${redirectReason}). Correct the title or PROMPT.md before writing a full plan body.`;
            await deps.store.logEntry(
              live.id,
              "AI spec revision requested",
              feedback,
              deps.getRunContextFor(live.id),
            );
            await deps.store.logEntry(
              live.id,
              "Parse node failed on duplicate redirect — retained in the current execution lane for repair",
              redirectReason,
              deps.getRunContextFor(live.id),
            );
            executorLog.warn(`${live.id}: ${redirectReason} — retained for in-place execution repair`);
            deps.activeWorktrees.delete(live.id);
            await deps.persistTokenUsage(live.id);
            return;
          }
        } catch (replanErr) {
          executorLog.warn(
            `${live.id}: failed to rebound non-executable duplicate prompt after parse failure: ${replanErr instanceof Error ? replanErr.message : String(replanErr)}`,
          );
        }
      }
      /*
      FNXC:WorkflowExecutionOwnership 2026-07-28-09:40 (U8 / R3):
      The execution-policy ladder below — the FN-7863/FN-7926 dispatch-loop gate, the FN-7996
      tool-failure retry, and the FN-7998 escalation — decided the task's own lifecycle by
      naming `"todo"` and `"in-progress"` literally. Under any workflow that renames those
      columns the whole ladder was unreachable and its failure was SILENT in the worst
      direction: the `live.column !== wip` guard below classified a card sitting in its own
      implementation column as "already advanced — no further action needed", so the graph
      failure was swallowed, no status was written, and the scheduler re-dispatched the same
      doomed run. Nothing failed; the retry budgets, the escalation, and the bounded
      terminalization simply never ran.

      Resolve ONCE per failure and thread the pair through the ladder. One IR read per graph
      failure: this is a terminal recovery path, not an enumeration loop.

      FNXC:WorkflowExecutionOwnership 2026-07-28-14:05 (U8 / R3, PR #2497 review — greptile P1):
      THE FALLBACK IS PER-WORKFLOW, NEVER PER-ROLE. The first cut wrote `columns?.hold ?? "todo"`,
      which conflates two different situations: "no workflow could be resolved" and "this
      workflow resolved fine and simply declares no hold column". Only the first justifies the
      legacy literal. For the second, substituting `todo` invents a column the workflow does not
      declare — and node-target escalation then PERSISTS it, stranding the card somewhere the
      board cannot route and defeating the scheduler node re-resolution the escalation exists
      for. U1 returns `undefined` per missing role precisely so a caller cannot borrow an
      unrelated column; `?? "todo"` threw that guarantee away one line after asking for it.

      So:
        - IR unresolvable          -> the legacy literals, i.e. exactly pre-conversion behavior.
        - IR resolved              -> `resolveReboundTarget` (KTD-10: hold -> intake -> first
                                      column), which can only ever name a DECLARED column, and
                                      `undefined` for wip when the workflow declares none.

      A `wipColumn` of `undefined` is not a wildcard — every gate below treats "I cannot prove
      where the wip column is" as "do not take the shortcut", so an unprovable card terminalizes
      VISIBLY rather than being swallowed by the already-advanced branch. Fail closed toward the
      operator seeing the failure.

      The two literals that remain are ONLY the unresolvable-workflow fallback, and they are the
      same pre-conversion values `resolveReboundColumnFor` already falls back to at its ~16
      executor call sites — this adds no new rule and no new reachable-by-a-valid-workflow
      literal. They are legacy-compat for a task whose workflow cannot be read at all, and they
      belong to the same sweep that retires `resolveReboundColumnFor`'s own `?? "todo"` when U11
      removes the column; they are deliberately NOT a per-role default, which is what made the
      first cut wrong.
      */
      let lifecycleIr: WorkflowIr | undefined;
      try {
        lifecycleIr = await resolveWorkflowIrForTask(deps.store, task.id);
      } catch {
        lifecycleIr = undefined;
      }
      const wipColumn = lifecycleIr ? resolveLifecycleColumns(lifecycleIr)?.wip : "in-progress";
      const holdColumn = lifecycleIr ? resolveReboundTarget(lifecycleIr) : "todo";
      /*
      FNXC:WorkflowExecutionOwnership 2026-07-29-18:55 (U8 / R4):
      COMPAT PATH for user-authored graphs, deliberately named. Every BUILT-IN shape declares the
      `outcome:review-pending` edge, so a built-in run never reaches here — it routed to its park
      node and ended. A custom workflow without the edge falls through to its generic `failure`
      edge and lands here, where the handoff the implementation phase used to perform inline
      happens instead. For those graphs this is a relocation, not an elimination: the transition is
      still executor-performed. What changes is that it is one named classifier in the failure
      ladder rather than a call buried two thousand lines into a session loop.
      */
      if (graphRunReportedPendingReview(result, failureValue)) {
        const compatMessage = "Implementation stopped on a pending review — parking in review (this workflow does not route the review-pending outcome)";
        executorLog.log(`${task.id}: ${compatMessage}`);
        await deps.store.logEntry(task.id, compatMessage, undefined, deps.getRunContextFor(task.id));
        await deps.handoffTaskToReview(live, "executor-exit-while-review-pending");
        await deps.persistTokenUsage(task.id);
        return;
      }
      const executeNodeSelfRequeued = failedNode === "execute" && deps.graphExecuteSelfRequeued.has(task.id);
      if (failedNode === "execute" && ((holdColumn !== undefined && live.column === holdColumn) || executeNodeSelfRequeued)) {
        /*
        FNXC:WorkflowLifecycle 2026-06-23-12:03:
        The graph execute node delegates to the authoritative executor. If that inner executor requeues the task to todo for self-heal/retry, the outer graph failure must not override it by parking the task in review.

        FNXC:WorkflowLifecycle 2026-06-23-21:19:
        Also honor the in-process self-requeue marker. Upgrade/restart races and minimal stores can return a stale `in-progress` live row even after the inner executor already moved the task to `todo`; stale reads must not strand progressing tasks in review.

        FNXC:WorkflowLifecycle 2026-07-12-00:00:
        FN-7863: the scheduler's wall-clock dispatchStormCount guard only increments when re-dispatches happen inside its short window; slow execute→pause-abort→todo loops reset that counter every cycle. Count this funnel by execution-progress signature instead, warn early for board-visible monitoring, and terminalize only non-paused live tasks after the bounded no-progress cap while preserving worktree/branch/step progress.

        FNXC:WorkflowLifecycle 2026-07-12-23:14:
        FN-7926 diverts completed-but-blocked rows before the FN-7863 counter increments. A stable all-done step signature plus unresolved dependency/blockedBy is a waiting state, not an implementation no-progress loop; park it with the specific blocker and let self-healing advance it when `getTaskCompletionBlocker` clears.
        */
        const completionBlocker = await deps.getTaskCompletionBlocker(live);
        if (completionBlocker && await deps.parkCompletedBlockedTask(live, completionBlocker, "execute-requeue")) {
          await deps.persistTokenUsage(task.id);
          return;
        }
        const { signature, madeForwardProgress } = buildExecuteRequeueLoopHighWaterSignature(live, live.executeRequeueLoopSignature);
        const nextCount = madeForwardProgress || live.executeRequeueLoopSignature == null
          ? 1
          : (live.executeRequeueLoopCount ?? 0) + 1;
        if (live.executeRequeueLoopCount !== nextCount || live.executeRequeueLoopSignature !== signature) {
          await deps.store.updateTask(task.id, {
            executeRequeueLoopCount: nextCount,
            executeRequeueLoopSignature: signature,
          }, deps.getRunContextFor(task.id));
        }
        if (nextCount === EXECUTE_REQUEUE_LOOP_VISIBLE_THRESHOLD) {
          const warningMessage = `Execution dispatch loop building: ${nextCount}/${MAX_EXECUTE_REQUEUE_LOOP_CYCLES} no-progress execute re-queues`;
          executorLog.warn(`${task.id}: ${warningMessage}`);
          await deps.store.logEntry(task.id, warningMessage, undefined, deps.getRunContextFor(task.id));
        }
        const canTerminalizeExecuteLoop = live.userPaused !== true
          && live.paused !== true
          && !(await resolveTerminalColumnsFor(deps.store, live.id)).includes(live.column);
        if (nextCount >= MAX_EXECUTE_REQUEUE_LOOP_CYCLES && canTerminalizeExecuteLoop) {
          const terminalError = `EXECUTION_DISPATCH_LOOP_EXHAUSTED: execute node re-queued task to todo ${nextCount} times with no forward progress (last value=${failureValue ?? "no-value"}). No further automatic retries will run. Manually retry, decompose, or rescope the task.`;
          await deps.store.updateTask(task.id, {
            status: "failed",
            error: terminalError,
            executeRequeueLoopCount: nextCount,
            executeRequeueLoopSignature: signature,
          }, deps.getRunContextFor(task.id));
          /*
           * FNXC:RunAudit 2026-08-20-03:02:
           * FN-9172 keeps terminal-park telemetry bounded because updateTask has already landed;
           * an audit failure must not skip persistTokenUsage or this branch's return.
           */
          await emitBoundedRunAudit(deps.store, {
            taskId: task.id,
            agentId: "executor",
            runId: generateSyntheticRunId("execution-dispatch-loop", task.id),
            domain: "database",
            mutationType: "task:execution-dispatch-loop-terminalized",
            target: task.id,
            metadata: {
              taskId: task.id,
              cycleCount: nextCount,
              maxCycles: MAX_EXECUTE_REQUEUE_LOOP_CYCLES,
              progressSignature: signature,
              failureValue: failureValue ?? null,
            },
          });
          executorLog.warn(`${task.id}: ${terminalError}`);
          await deps.store.logEntry(task.id, terminalError, undefined, deps.getRunContextFor(task.id));
          await deps.persistTokenUsage(task.id);
          return;
        }
        const benignMessage = `Workflow graph execute node ended after executor re-queued task to todo (${failureValue ?? "no-value"}) — executor recovery preserved`;
        executorLog.log(`${task.id}: ${benignMessage}`);
        await deps.store.logEntry(task.id, benignMessage, undefined, deps.getRunContextFor(task.id));
        await deps.persistTokenUsage(task.id);
        return;
      }
      if (mergeGraphFailure && failureValue === "implementation-incomplete") {
        if (await deps.routeImplementationIncompleteMergeGraphFailure(live, failedNode ?? "unknown")) {
          return;
        }
      }
      if (mergeGraphFailure && !isTerminalMergeGraphFailureValue(failureValue) && await deps.routeGraphMergeFailureToRetry(live, result, abortProvenance)) {
        return;
      }
      if (mergeGraphFailure && isTerminalMergeGraphFailureValue(failureValue) && !(await resolveTerminalColumnsFor(deps.store, live.id)).includes(live.column)) {
        const message = `Workflow graph terminal merge failure at node '${failedNode ?? "unknown"}' (${failureValue}) — operator action required`;
        executorLog.warn(`${task.id}: ${message}`);
        await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
        const outcome = live.status == null && live.error == null ? "parked" as const : "already-terminal" as const;
        if (outcome === "parked") {
          await deps.store.updateTask(task.id, { error: message, status: "failed" }, deps.getRunContextFor(task.id));
        }
        if (failureValue === MERGE_BOUNDARY_UNPROVEN_VALUE) {
          /*
          FNXC:RunAudit 2026-08-20-02:00:
          FN-9168 records this reachable graph-terminal merge-boundary-unproven park exactly once.
          Other terminal merge failures remain unchanged. The bounded emitter contains audit failure
          and hangs after the status write, so observability cannot alter or wedge the park.
          */
          await emitMergeBoundaryUnprovenParked(deps.store, {
            taskId: task.id,
            nodeId: failedNode ?? "unknown",
            failureValue,
            source: "graph-terminal-park",
            priorColumn: live.column,
            priorStatus: live.status,
            outcome,
            runId: deps.getRunContextFor(task.id)?.runId,
          });
        }
        await deps.persistTokenUsage(task.id);
        return;
      }
      if (failedNode === "parse" && failureValue === "pin-mismatch" && await deps.routeResetParsePinMismatchToRetry(live)) {
        return;
      }
      if (await deps.routeRetryableRemediationGraphFailureToPreMergeFix(live, failedNode, failureValue)) {
        return;
      }
      if (await deps.routeGraphFailureToExecutionResume(live, failedNode ?? "unknown", failureValue, resumeLanesMemo)) {
        return;
      }
      /*
      FNXC:WorkflowExecutionOwnership 2026-07-28-14:10 (U8 / R3, PR #2497 review):
      `wipColumn === undefined` means the workflow declares no implementation column, so there
      is no evidence the card "already advanced" past one. Swallowing the failure on a guess is
      the exact silent-loss this conversion exists to remove — require a KNOWN wip column before
      taking the benign shortcut.
      */
      if (wipColumn !== undefined && live.column !== wipColumn) {
        const failedPreMergeStep = latestFailedPreMergeWorkflowStep(live);
        if (failedPreMergeStep) {
          /*
          FNXC:LifecycleContainment 2026-08-30-12:57:
          A graph route may end in review without traversing its remediation edge. Before parking a
          blocking failed gate, use the same producer that live review uses; Code Review's fallback
          guarantees a malformed REVISE still has one executable Fix step rather than a dead card.
          */
          const workflowIr = await resolveWorkflowIrForTask(deps.store, task.id).catch(() => undefined);
          const stepReopenPolicy = resolveStepReopenPolicy(workflowIr);
          if (live.column === failureLanes.review
            && !live.paused
            && !hasPendingReviewRemediationWork(live, { stepReopenPolicy })) {
            /*
            FNXC:LifecycleContainment 2026-08-30-13:36:
            This backstop is an AUTOMATIC remediation attempt, so it owes the same admission claim as
            the self-healing sweep. Unclaimed, a graph failure racing that sweep could append a second
            remediation wave, bounce twice, or write a second "explained once" refusal for one review
            input. It therefore claims the exact failed round, drives the hand-off from the claimed
            in-transaction snapshot, and releases on success or retains on a genuine decline. Losing
            the claim — to a live owner, or to a durable refusal already recorded for this same round
            — is SILENT: the owner narrates that round's outcome, and a second park message here would
            be the duplicate operator noise this task exists to remove.
            */
            /*
            FNXC:ReviewRemediation 2026-08-31-09:00:
            NO CLAIM. This backstop RE-TRIGGERS the single remediation producer; it is not a second
            writer, so it has nothing to arbitrate.

            The claim FN-267 added here bought a BOUNDED problem -- a duplicate remediation wave,
            capped by the revision budget -- at the price of an UNBOUNDED one: any admission that was
            not `claimed`/`unkeyable` returned in silence, and the caller's own "remediation was not
            scheduled" message sits BELOW that return, so it never fired. The card died with a
            blocking review and an empty timeline. Measured: the claim signature separated its fields
            with NUL, PostgreSQL rejects NUL (SQLSTATE 22P05), so from the hour FN-267 landed no claim
            could be written at all and FN-270/FN-273 sat blocked overnight while every isolated part
            looked correct.

            What FN-267 genuinely fixed -- a rerun bounced before its fix steps existed -- lives in
            the ordering guard (`hasPendingReviewRemediationWork` plus the deterministic Fix-step
            fallback), which is untouched. Ordering comes from the code path; the claim only ever
            added arbitration between writers that should not both exist.

            Plan Review is the shape being restored: ONE producer, and recovery that re-triggers it
            rather than duplicating it. Its recovery sweeps re-seed the card at its node and stop
            there, which is why Plan Review has never needed a claim, a fence, or a refusal marker --
            and why its REVISE round completed normally on the very card this one stranded.
            */
            const scheduled: boolean = await deps.requestPreMergeOptionalStepFix(task.id, live, {
              nodeId: failedPreMergeStep.workflowStepId,
              stepName: failedPreMergeStep.workflowStepName || failedPreMergeStep.workflowStepId,
              feedback: failedPreMergeStep.output ?? "(no feedback captured)",
              phase: failedPreMergeStep.phase ?? "pre-merge",
              status: failedPreMergeStep.status,
              verdict: failedPreMergeStep.verdict,
              reviewKind: failedPreMergeStep.reviewKind,
              findings: failedPreMergeStep.findings,
            });
            /*
            FNXC:ReviewRemediation 2026-08-31-09:00:
            A decline now falls through to the "remediation was not scheduled" park below, which is
            the operator-facing message that the claim's silent returns used to skip over entirely.
            */
            if (scheduled) return;
          }
          const stepName = failedPreMergeStep.workflowStepName || failedPreMergeStep.workflowStepId || "Unknown";
          const blockedMessage = `Workflow graph run ended in '${live.column}' with failed pre-merge step '${stepName}' still blocking merge — remediation was not scheduled`;
          executorLog.warn(`${task.id}: ${blockedMessage}`);
          await deps.store.logEntry(
            task.id,
            blockedMessage,
            "Retry the task after restoring its remediation checkout or revision policy. Use the privileged review bypass only when this failed review is known to be non-blocking.",
            deps.getRunContextFor(task.id),
          );
          return;
        }
        // FN-9243: failure after crossing into review must leave a producer for genuinely unrun gates.
        const reroute = await (async () => {
          const gate = await resolvePreMergeGateForTask(deps.store, live.id, live.enabledWorkflowSteps, live);
          const settings = await deps.store.getSettings();
          const mergeContent = await captureMergeContentDescriptor(live, { workspaceRootDir: deps.rootDir, settings });
          return rerouteUnrunPreMergeGateToReview(deps.store, live, {
            requiredPreMergeStepIds: gate.requiredPreMergeStepIds,
            mergeContent,
          });
        })().catch(() => undefined);
        if (reroute?.rerouted) {
          const message = `Workflow graph re-seeded at unrun pre-merge gate '${reroute.nodeId ?? "unknown"}' after review-lane failure`;
          executorLog.warn(`${task.id}: ${message}`);
          await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
          return;
        }
        const benignMessage = `Workflow graph run ended after task already advanced to '${live.column}' — no further action needed`;
        executorLog.log(`${task.id}: ${benignMessage}`);
        await deps.store.logEntry(task.id, benignMessage, undefined, deps.getRunContextFor(task.id));
        return;
      }
      if (isAwaitingGraphFailureValue(failureValue)) {
        /*
        FNXC:WorkflowLifecycle 2026-06-15-12:00:
        Awaiting-input and awaiting-CLI-approval workflow node values are resumable operator waits, not terminal execute failures. Classify the node value before the generic graph-failure sink so a stale or partially reloaded pause flag cannot park a legitimately runnable task in review with the execute-node symptom.
        */
        const benignMessage = `Workflow graph run ended awaiting ${failureValue === "awaiting-cli-approval" ? "CLI approval" : "user input"} at node '${failedNode ?? "unknown"}' — awaiting state preserved`;
        executorLog.log(`${task.id}: ${benignMessage}`);
        await deps.store.logEntry(task.id, benignMessage, undefined, deps.getRunContextFor(task.id));
        if (live.status !== failureValue || !live.paused) {
          await deps.store.updateTask(task.id, { status: failureValue, paused: true }, deps.getRunContextFor(task.id));
        }
        return;
      }
      if (isTransientResumeAfterRestartGraphFailure(live, result)) {
        const priorRetries = live.graphResumeRetryCount ?? 0;
        if (priorRetries < MAX_TRANSIENT_GRAPH_RESUME_RETRIES) {
          const nextRetries = priorRetries + 1;
          const benignMessage = `Transient resume-after-restart graph failure — auto-retrying (${nextRetries}/${MAX_TRANSIENT_GRAPH_RESUME_RETRIES}) instead of parking`;
          executorLog.warn(`${task.id}: ${benignMessage}`);
          await deps.store.logEntry(task.id, benignMessage, undefined, deps.getRunContextFor(task.id));
          await deps.store.updateTask(task.id, {
            graphResumeRetryCount: nextRetries,
            status: null,
            error: null,
          }, deps.getRunContextFor(task.id));
          /*
          FNXC:WorkflowLifecycle 2026-08-15-22:15 (restored post-wave-18, FN-6782 family): the scheduled
          retry must re-read the LIVE row at fire time and re-verify it is still in a safe WIP resume
          state. The peel had replaced this with an unguarded `execute(live)` on the stale snapshot, so a
          task deleted/paused/moved/parked/canceled — or one that already has an active run — between arming
          and firing would be re-dispatched anyway.
          */
          const scheduleRetry = () => {
            void (async () => {
              try {
                const resumeTask = await deps.store.getTask(task.id);
                const resumeFailureState = resumeTask as Task & { lastError?: unknown; failureReason?: unknown };
                if (
                  resumeTask.deletedAt
                  || resumeTask.paused
                  || resumeTask.userPaused
                  || deps.userCanceledTaskIds.has(task.id)
                  || resumeTask.status != null
                  || resumeTask.error != null
                  || resumeFailureState.lastError != null
                  || resumeFailureState.failureReason != null
                  || resumeTask.column !== failureLanes.wip
                  || (await resolveTerminalColumnsFor(deps.store, resumeTask.id)).includes(resumeTask.column)
                  || deps.executing.has(task.id)
                  || deps.activeSessions.has(task.id)
                  || deps.activeStepExecutors.has(task.id)
                  || deps.activeWorkflowStepSessions.has(task.id)
                  || deps.activeCliTaskSessions.has(task.id)
                  || deps.activeWorkflowGraphAbortControllers.has(task.id)
                  || deps.resumingUnpaused.has(task.id)
                  || deps.processWideGraphRouting.has(task.id)
                ) {
                  executorLog.debug(`${task.id}: skipping transient graph resume retry — task is no longer in a safe WIP resume state`);
                  return;
                }
                await deps.execute(resumeTask);
              } catch (err) {
                executorLog.error(`Failed transient graph resume retry for ${task.id}:`, err);
              }
            })();
          };
          if (TRANSIENT_GRAPH_RESUME_RETRY_BACKOFF_MS > 0) {
            const handle = setTimeout(scheduleRetry, TRANSIENT_GRAPH_RESUME_RETRY_BACKOFF_MS);
            handle.unref?.();
          } else {
            setTimeout(scheduleRetry, 0).unref?.();
          }
          return;
        }
      }
      /*
      FNXC:WorkflowRemediation 2026-07-01-23:40:
      Do NOT flag a still-executing task as failed. A `pre-merge-remediation` / `plan-replan` node (e.g. `code-review-remediation`) is a fire-and-forget async scheduler with no `failure` out-edge, so a failed re-arm (missing rehydrated failureContext after restart, remediation-not-scheduled, or an exhausted rework budget) bubbles out as the terminal graph outcome here. When a SEPARATE live agent session surface is still registered for this task, the previously-scheduled fix/reviewer is genuinely mid-flight — parking `status:"failed"` would surface a spurious "Task Failed" over live work. Preserve the row and let the live session drive its own terminal handoff instead. Scoped strictly to remediation nodes + a live session surface so genuine execute/merge terminal failures (and remediation failures with NO live session, e.g. a truly exhausted budget) still park exactly as before.

      FNXC:WorkflowRemediation 2026-07-21-22:56:
      Extend the same preserve rule to execute-family nodes when a SEPARATE live session surface exists. A losing raced graph (duplicate resume after plan-review) can terminate at steps#N:step-execute while a peer session still owns coding work; stamping status=failed arms overseer retry_step hard-cancels (FN-8471). Merge-region failures still park — they are not execute-family.
      */
      const isExecuteFamilyNode =
        failedNode === "execute"
        || failedNode === "step-execute"
        || failedNode?.endsWith(":step-execute") === true;
      if (deps.hasLiveTaskSessionSurface(task.id)) {
        const isRemediation = await deps.isRemediationGraphNode(task.id, failedNode);
        if (isRemediation || isExecuteFamilyNode) {
          const kind = isRemediation ? "remediation" : "execute";
          const benignMessage = `Workflow graph ended at ${kind} node '${failedNode ?? "unknown"}' while a live agent session is still executing — not flagging as failed; live session preserved`;
          executorLog.warn(`${task.id}: ${benignMessage}`);
          await deps.store.logEntry(task.id, benignMessage, undefined, deps.getRunContextFor(task.id));
          await deps.persistTokenUsage(task.id);
          return;
        }
      }
      const message = `Workflow graph terminated with failure at node '${failedNode ?? "unknown"}'`;
      const settings = await deps.store.getSettings();
      const maxToolFailureRetries = resolveMaxConsecutiveToolFailureRetries(settings);
      if (maxToolFailureRetries > 0 && isExecuteFamilyNode && !live.paused && !live.userPaused && !live.deletedAt && live.column === wipColumn) {
        // Prefer the execution-local boundary; recovery paths refetch durable state rather than use the stale failure snapshot.
        const cursor = deps.graphToolFailureRunCursors.get(task.id) ?? (await deps.store.getTask(task.id))?.toolFailureDetectorLogCursor;
        const threshold = resolveConsecutiveToolFailureThreshold(settings);
        if (await deps.hasTrailingConsecutiveToolFailures(task.id, cursor, threshold)) {
          const claim = await deps.store.claimNextToolFailureRetry(task.id, cursor!, maxToolFailureRetries);
          if (claim.outcome === "claimed") {
            await deps.store.updateTask(task.id, { status: null, error: null }, deps.getRunContextFor(task.id));
            await deps.store.logEntry(task.id, `Consecutive tool-call failures — auto-retrying same model (${claim.attempt}/${maxToolFailureRetries}) instead of parking`, undefined, deps.getRunContextFor(task.id));
            await emitBoundedRunAudit(deps.store, { taskId: task.id, agentId: "executor", runId: generateSyntheticRunId("tool-failure-retry", task.id), domain: "database", mutationType: "task:execution-tool-failure-retry", target: task.id, metadata: { taskId: task.id, nodeId: failedNode ?? "unknown", attempt: claim.attempt, maxAttempts: maxToolFailureRetries, consecutiveToolFailures: threshold, mode: "same-model" } });
            const schedule = () => { void (async () => { const resume = await deps.store.getTask(task.id); if (resume && !resume.deletedAt && !resume.paused && !resume.userPaused && resume.column === wipColumn) await deps.execute(resume); })().catch((error) => executorLog.error(`${task.id}: tool-failure retry failed`, error)); };
            const delay = resolveConsecutiveToolFailureRetryBackoffMs(settings);
            setTimeout(schedule, delay).unref?.();
            return;
          }
          if (claim.outcome === "already-claimed-for-run") { await deps.store.getTask(task.id); return; }
          /*
          FNXC:ExecutorEscalation 2026-07-16-21:00:
          FN-7998 inserts exactly one opt-in recovery between FN-7996 exhaustion and the unchanged terminal park. Refetch before writing so a pause, deletion, or later run cannot inherit a costly model/node override from this stale graph result.
          */
          const escalationTarget = resolveExecutorEscalationTarget(settings);
          const hasModelTarget = escalationTarget.provider !== undefined && escalationTarget.modelId !== undefined;
          /*
          FNXC:WorkflowExecutionOwnership 2026-07-28-14:15 (U8 / R3, PR #2497 review — greptile P1):
          A node escalation is a REQUEUE: it parks the card back in the hold lane so the
          scheduler re-resolves the effective node. Without a declared requeue target there is
          nowhere legal to put it, and persisting an invented column is worse than not
          escalating — the card lands where the board cannot route it and the node is never
          dispatched. Degrade to the no-node-target shape (in-place retry, which is already how
          an enabled escalation with no usable target behaves) rather than writing an
          undeclared column.
          */
          const nodeTargetRequeueColumn = escalationTarget.nodeId !== undefined ? holdColumn : undefined;
          const hasNodeTarget = escalationTarget.nodeId !== undefined && nodeTargetRequeueColumn !== undefined;
          if (escalationTarget.nodeId !== undefined && nodeTargetRequeueColumn === undefined) {
            await deps.store.logEntry(task.id, "Node escalation downgraded to an in-place retry — this task's workflow declares no column to requeue into", undefined, deps.getRunContextFor(task.id));
          }
          let claimedEscalation = false;
          let priorEscalationRetryCount = 0;
          /*
          FNXC:ExecutorEscalation 2026-07-16-22:30:
          The one-shot latch is claimed under the TaskStore lock. Concurrent exhausted
          graph handlers for the same detector cursor must not both schedule an alternate
          run; a loser leaves the winner's in-progress row untouched.
          */
          await deps.store.updateTaskAtomic(task.id, (current) => {
            const ownsFailureRun = current.toolFailureDetectorLogCursor === cursor
              && current.column === wipColumn
              && !current.paused
              && !current.userPaused
              && !current.deletedAt;
            if (!ownsFailureRun || current.executorEscalationAttempted === true || !escalationTarget.enabled) return null;
            claimedEscalation = true;
            priorEscalationRetryCount = current.consecutiveToolFailureRetryCount ?? 0;
            return {
              ...(hasModelTarget ? { modelProvider: escalationTarget.provider, modelId: escalationTarget.modelId } : {}),
              ...(hasNodeTarget ? { nodeId: escalationTarget.nodeId, column: nodeTargetRequeueColumn } : {}),
              executorEscalationAttempted: true,
              /* FNXC:ExecutorEscalation 2026-07-16-22:40: Invalidate the exhausted run cursor before releasing the claim so concurrent stale handlers cannot park or audit the alternate execution; the alternate captures its own cursor at startup. */
              toolFailureDetectorLogCursor: null,
              status: null,
              error: null,
            };
          }, deps.getRunContextFor(task.id));
          if (claimedEscalation) {
            await deps.store.logEntry(task.id, "Same-model retries exhausted — escalating to alternate model/node (one attempt) instead of parking", undefined, deps.getRunContextFor(task.id));
            await emitBoundedRunAudit(deps.store, { taskId: task.id, agentId: "executor", runId: generateSyntheticRunId("escalation-retry", task.id), domain: "database", mutationType: "task:execution-escalation-retry", target: task.id, metadata: { taskId: task.id, nodeId: failedNode ?? "unknown", hasModelTarget, hasNodeTarget, priorConsecutiveToolFailureRetryCount: priorEscalationRetryCount } });
            if (!hasNodeTarget) {
              const scheduleEscalation = () => { void (async () => { const resumeTask = await deps.store.getTask(task.id); if (resumeTask && !resumeTask.deletedAt && !resumeTask.paused && !resumeTask.userPaused && resumeTask.column === wipColumn) await deps.execute(resumeTask); })().catch((error) => executorLog.error(`${task.id}: escalation retry failed`, error)); };
              const handle = setTimeout(scheduleEscalation, resolveConsecutiveToolFailureRetryBackoffMs(settings));
              handle.unref?.();
            }
            return;
          }

          /*
          FNXC:ExecutorToolFailureRetry 2026-07-16-20:45:
          Exhaustion belongs to the graph run that supplied `cursor`, not a later run
          that may have begun while this handler awaited its durable claim. Revalidate
          the cursor under TaskStore's per-task atomic lock while applying the terminal
          state; only that successful CAS may emit the exhaustion audit. This keeps an
          old terminal handler from parking a newer in-progress executor run.
          */
          let cursorOwnedTerminalPark = false;
          let escalationAttemptFailed = false;
          let escalationHadModelTarget = false;
          let escalationHadNodeTarget = false;
          await deps.store.updateTaskAtomic(task.id, (current) => {
            if (
              current.toolFailureDetectorLogCursor !== cursor
              || current.column !== wipColumn
              || current.paused
              || current.userPaused
              || current.deletedAt
              || current.status !== null
            ) {
              return null;
            }
            cursorOwnedTerminalPark = true;
            escalationAttemptFailed = current.executorEscalationAttempted === true;
            escalationHadModelTarget = current.modelProvider != null && current.modelId != null;
            escalationHadNodeTarget = current.nodeId != null;
            return { error: message, status: "failed" };
          }, deps.getRunContextFor(task.id));
          if (!cursorOwnedTerminalPark) return;
          if (await deps.store.markToolFailureRetryExhaustedAudit(task.id)) {
            await emitBoundedRunAudit(deps.store, { taskId: task.id, agentId: "executor", runId: generateSyntheticRunId("tool-failure-retry-exhausted", task.id), domain: "database", mutationType: "task:execution-tool-failure-retry-exhausted", target: task.id, metadata: { taskId: task.id, nodeId: failedNode ?? "unknown", attempts: maxToolFailureRetries, limit: maxToolFailureRetries, outcome: "terminal-park" } });
          }
          if (escalationAttemptFailed) {
            await emitBoundedRunAudit(deps.store, { taskId: task.id, agentId: "executor", runId: generateSyntheticRunId("escalation-exhausted", task.id), domain: "database", mutationType: "task:execution-escalation-exhausted", target: task.id, metadata: { taskId: task.id, nodeId: failedNode ?? "unknown", hadModelTarget: escalationHadModelTarget, hadNodeTarget: escalationHadNodeTarget } });
          }
          executorLog.warn(`${task.id}: ${message}`);
          await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
          await deps.persistTokenUsage(task.id);
          return;
        }
      }
      if (live.executorEscalationAttempted === true) {
        const failureCursor = task.toolFailureDetectorLogCursor;
        let escalationTerminalParked = false;
        let escalationHadModelTarget = false;
        let escalationHadNodeTarget = false;
        /*
        FNXC:ExecutorEscalation 2026-07-16-22:35:
        Once the durable escalation latch is set, every terminal failure of that
        alternate run emits the exhaustion audit even if an operator disables the
        setting mid-run. Cursor ownership prevents an old concurrent handler from
        parking the newly scheduled alternate execution.
        */
        await deps.store.updateTaskAtomic(task.id, (current) => {
          if (
            current.toolFailureDetectorLogCursor !== failureCursor
            || current.column !== wipColumn
            || current.paused
            || current.userPaused
            || current.deletedAt
            || current.status !== null
          ) return null;
          escalationTerminalParked = true;
          escalationHadModelTarget = current.modelProvider != null && current.modelId != null;
          escalationHadNodeTarget = current.nodeId != null;
          return { error: message, status: "failed" };
        }, deps.getRunContextFor(task.id));
        if (!escalationTerminalParked) return;
        await emitBoundedRunAudit(deps.store, { taskId: task.id, agentId: "executor", runId: generateSyntheticRunId("escalation-exhausted", task.id), domain: "database", mutationType: "task:execution-escalation-exhausted", target: task.id, metadata: { taskId: task.id, nodeId: failedNode ?? "unknown", hadModelTarget: escalationHadModelTarget, hadNodeTarget: escalationHadNodeTarget } });
      } else {
        const parked = await retryTerminalFailurePersistence(
          deps.store,
          task.id,
          message,
          deps.getRunContextFor(task.id),
          live.columnMovedAt,
        );
        if (!parked) {
          /*
          FNXC:MergeRetryReliability 2026-08-26-18:30 (Greptile P1 x6): during a
          persistent store outage the bounded backoff can exhaust while the task
          still sits in its lane. Keep re-attempting on a fixed interval until
          the row is durably terminal or the write's fence rejects it — no round
          cap, so a store that recovers hours later still finds the row parked
          instead of lane-resident with null status. Every re-attempt is exactly
          one fenced write: updateTaskAtomic's reducer re-checks the live row
          (deleted / already-terminal / paused) atomically, so no separate
          getTask probe exists — a probe could itself reject during the outage
          and, landing outside the retry branch, would end the chain. Run
          identity is fenced by STRICT equality with the id captured at
          exhaustion, and no chain is scheduled at all when no execution context
          exists then: two absent (undefined) contexts must never compare equal,
          or a stale handler could park freshly recovered or requeued work.
          resumeOrphaned() parks lane-resident null-status rows at restart.
          */
          /*
          FNXC:MergeRetryReliability 2026-09-04-01:51:
          columnMovedAt changes for every lane move, including operator requeue,
          making it the durable execution identity. Do not use updatedAt: logs and
          token usage mutate it without starting a new execution.
          */
          const capturedRunId = deps.getRunContextFor(task.id)?.runId;
          const capturedColumnMovedAt = live.columnMovedAt;
          // FNXC:MergeRetryReliability 2026-08-29-14:35 (Greptile round-9
          // Issue 1): the in-memory deferred chain dies with the engine — an
          // unref'd timeout has no durable ownership, so an exit during the
          // store outage discards the pending failed-state write and restart
          // recovery RE-RUNS a task that should have been parked. Persist the
          // terminal-park intent next to the task's own directory so restart
          // recovery (resumeOrphaned) can apply it instead of re-executing.
          // FNXC:MergeRetryReliability 2026-08-29-16:52 (CodeRabbit L1331):
          // persist the intent on EVERY exhaustion path — including the
          // no-context branch below — so restart recovery parks the task even
          // when the deferred chain was never schedulable.
          const tasksDir = typeof deps.store.getTasksDir === "function"
            ? deps.store.getTasksDir()
            : join(deps.rootDir, ".fusion", "tasks");
          const deferredParkIntentPath = join(tasksDir, task.id, "deferred-terminal-park.json");
          // Fire-and-forget: the intent write must not delay scheduling the
          // deferred chain (a blocked fs would push the timer past the
          // retry window). If the filesystem is unavailable the in-memory
          // chain still runs; restart recovery simply loses the intent.
          // FNXC:MergeRetryReliability 2026-08-29-17:08 (CodeRabbit L1351):
          // hold the write promise and await it inside the deferred chain
          // before each rm, so a slow fs write cannot recreate the file
          // after the intent was settled.
          const intentWrite = writeFile(deferredParkIntentPath, JSON.stringify({ message, writtenAt: new Date().toISOString(), columnMovedAt: capturedColumnMovedAt }), "utf-8")
            .catch((intentError) => {
              executorLog.warn(`${task.id}: failed to persist deferred terminal-park intent: ${intentError instanceof Error ? intentError.message : String(intentError)}`);
            });
          if (capturedRunId === undefined) {
            executorLog.warn(`${task.id}: no execution context at exhaustion — skipping deferred terminal park (a null-status lane row is parked at restart)`);
          } else {
            const scheduleDeferredTerminalPark = (attempt: number): void => {
              const handle = setTimeout(() => {
                void (async function deferredTerminalParkAttempt() {
                  // FNXC:MergeRetryReliability 2026-08-29-17:40 (CodeRabbit L399):
                  // expose an observable in-flight marker so tests drive the fence
                  // from observed state instead of stack traces (rename/inlining
                  // or a deep async stack could silently disable the fence tests).
                  deps.deferredTerminalParksInFlight.add(task.id);
                  try {
                  const currentRunId = deps.getRunContextFor(task.id)?.runId;
                  // FNXC:MergeRetryReliability 2026-08-29-12:05 (Greptile round-4
                  // Issue 1): a cleared context (currentRunId === undefined) means
                  // normal execution teardown already happened and NO OTHER run
                  // owns the task — the lane-resident null-status row must still be
                  // parked now the store recovered. Skipping on undefined made
                  // recovery depend on an engine restart (resumeOrphaned), leaving
                  // the task lane-resident indefinitely.
                  // FNXC:MergeRetryReliability 2026-08-29-12:20 (Greptile round-8
                  // Issue 1): a cleared context is NOT sufficient proof of a dead
                  // run — a valid requeue also clears it while the task is live on
                  // some execution surface. Fence both ways: different ACTIVE run
                  // id, OR no run id but any live execution surface for the task
                  // (same surface list the transient resume retry uses), means a
                  // stale callback must not terminalize newer/requeued work.
                  const taskHasLiveExecutionSurface =
                    deps.executing.has(task.id)
                    || deps.activeSessions.has(task.id)
                    || deps.activeStepExecutors.has(task.id)
                    || deps.activeWorkflowStepSessions.has(task.id)
                    || deps.activeCliTaskSessions.has(task.id)
                    || deps.activeWorkflowGraphAbortControllers.has(task.id)
                    || deps.resumingUnpaused.has(task.id)
                    || deps.processWideGraphRouting.has(task.id);
                  if (
                    (currentRunId !== undefined && currentRunId !== capturedRunId)
                    || (currentRunId === undefined && taskHasLiveExecutionSurface)
                  ) {
                    // FNXC:MergeRetryReliability 2026-08-29-16:52 (CodeRabbit L1402):
                    // a skipped fence ends the chain — the file must not leak so a
                    // later restart parks work a NEWER run owns.
                    await intentWrite;
                    await rm(deferredParkIntentPath, { force: true }).catch(() => undefined);
                    return;
                  }
                let fencedParked = false;
                try {
                  await deps.store.updateTaskAtomic(task.id, (current) => {
                    if (
                      !current
                      || current.deletedAt
                      || current.status != null
                      || current.paused
                      || current.userPaused
                      || (typeof capturedColumnMovedAt === "string"
                        && typeof current.columnMovedAt === "string"
                        && current.columnMovedAt !== capturedColumnMovedAt)
                    ) return null;
                    fencedParked = true;
                    return { error: message, status: "failed" };
                  }, deps.getRunContextFor(task.id));
                } catch (error) {
                  if (attempt % 10 === 0) {
                    executorLog.error(`${task.id}: deferred terminal persistence attempt ${attempt + 1} rejected (${error instanceof Error ? error.message : String(error)}) — re-attempting`);
                  }
                  scheduleDeferredTerminalPark(attempt + 1);
                  return;
                }
                // FNXC:MergeRetryReliability 2026-08-29-16:52 (CodeRabbit L1402):
                // reached only when the fenced write RESOLVED — either the row
                // was parked (fencedParked) or the reducer declined it (row
                // already terminal/deleted/paused). Both settle the intent:
                // dropped the durable marker so a later restart does not re-apply
                // stale terminal state.
                // FNXC:MergeRetryReliability 2026-08-29-17:08 (CodeRabbit L1351):
                // await the intent write BEFORE deleting it, so a slow fs write
                // cannot recreate the file after the chain settled the intent.
                await intentWrite;
                await rm(deferredParkIntentPath, { force: true }).catch(() => undefined);
                if (fencedParked) {
                  executorLog.warn(`${task.id}: deferred terminal persistence parked the row after store recovery`);
                }
                  } finally {
                    deps.deferredTerminalParksInFlight.delete(task.id);
                  }
              })().catch((error) => executorLog.error(
                `${task.id}: deferred terminal persistence failed: ${error instanceof Error ? error.message : String(error)}`,
              ));
            }, process.env.VITEST || process.env.NODE_ENV === "test" ? 0 : 120_000);
            handle.unref?.();
            };
            scheduleDeferredTerminalPark(0);
          }
        }
      }
      executorLog.warn(`${task.id}: ${message}`);
      await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
      await deps.persistTokenUsage(task.id);
    } catch (err) {
      executorLog.error(
        `${task.id}: failed to park graph-failed task: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
}
