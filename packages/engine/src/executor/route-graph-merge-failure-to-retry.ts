/**
 * FNXC:CodeOrganization 2026-08-03-13:45:
 * routeGraphMergeFailureToRetry peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowMerge 2026-07-12-17:38:
 * FN-1165: never route implementation-incomplete merge failures to the merge requester.
 */
import type { TaskDetail, TaskStore } from "@fusion/core";
import type { WorkflowGraphTaskRunResult } from "../workflows/workflow-graph-task-runner.js";
import type { PausedAbortProvenance } from "./paused-abort-provenance.js";
import { isGenericAbortProvenance } from "./paused-abort-provenance.js";
import { graphFailureValue } from "./graph-failure-pure.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { executorLog } from "../logger.js";
import { MERGE_BOUNDARY_UNPROVEN_VALUE } from "../workflows/workflow-merge-nodes.js";
import { emitMergeBoundaryUnprovenParked } from "./emit-merge-boundary-unproven-audit.js";
import type { MergeBoundaryUnprovenReasonCode } from "./workflow-merge-boundary.js";
import { AUTO_MERGE_RETRY_REJECTED_PREFIX } from "../merge/stale-content-park.js";

export type RouteGraphMergeFailureToRetryDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  mergeRequester?: ((taskId: string) => Promise<unknown>) | null;
  ensureWorkflowMergeBoundaryTask: (
    live: TaskDetail,
    opts: { reason: string; nodeId: string; workflowId: string; runId: string },
  ) => Promise<{
    task: TaskDetail;
    blocked?: {
      reason: string;
      code: MergeBoundaryUnprovenReasonCode;
      missingInstanceCount: number;
    };
  }>;
  persistTokenUsage: (taskId: string) => Promise<void>;
};

const BIT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 32000, 64000];

async function parkTaskFailed(
  store: TaskStore,
  taskId: string,
  errorMessage: string,
  runContext: EngineRunContext | undefined,
  capturedColumnMovedAt: string | undefined,
): Promise<boolean> {
  /*
  FNXC:MergeRetryReliability 2026-08-26-14:00 (Greptile P1): the terminal park must
  survive transient store rejections (field: the GDPR-053 engine API hiccuped
  20-30s under planning load). Exponential backoff to ~63s total window; only a
  genuinely down store exhausts it.

  FNXC:MergeRetryReliability 2026-09-04-02:43:
  A retry can outlive an operator requeue after its first store rejection.
  Atomically fence the failed patch on columnMovedAt, which changes on every lane
  move, so this run settles without failing the replacement execution.

  FNXC:MergeRetryReliability 2026-08-26-14:40 (Greptile 4/5): on exhaustion, do NOT
  rethrow into handleGraphFailure's log-only catch — that reproduces the silent
  stranded-task report. Signal "not handled" (return false) so the graph-failure
  handler's own terminal park ("operator action required", durable when the store
  recovers) takes over and the operator sees the failure.
  */
  const backoffMs = BIT_BACKOFF_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt < backoffMs.length; attempt += 1) {
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
        return { status: "failed", error: errorMessage };
      }, runContext);
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < backoffMs.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]));
      }
    }
  }
  executorLog.error(
    `${taskId}: failed to persist failed status after ${backoffMs.length} attempts spanning ~63s: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
  return false;
}


async function persistTokenUsageBestEffort(
  persist: (taskId: string) => Promise<void>,
  taskId: string,
): Promise<void> {
  /*
  FNXC:MergeRetryReliability 2026-08-26-14:50 (Greptile P1): token persistence must
  never block the terminal path. When the store is down it rejects like every other
  write; swallowing it keeps the park result (true/false) authoritative so the
  graph-failure handler's fallback can still run.
  */
  try {
    await persist(taskId);
  } catch (error) {
    executorLog.warn(
      `${taskId}: failed to persist token usage: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function routeGraphMergeFailureToRetry(
  deps: RouteGraphMergeFailureToRetryDeps,
  live: TaskDetail,
  result: WorkflowGraphTaskRunResult,
  abortProvenance: PausedAbortProvenance | undefined,
): Promise<boolean> {
    if (!deps.mergeRequester) return false;
    /* FNXC:WorkflowMerge 2026-07-12-17:38: FN-1165 defense in depth — implementation-incomplete merge graph failures must never reach the merge requester, because a no-branch task can otherwise be finalized as an intentional no-op. */
    if (graphFailureValue(result) === "implementation-incomplete") return false;
    const failedNode = result.visitedNodeIds[result.visitedNodeIds.length - 1] ?? "unknown";
    const message = `Workflow graph merge failure at node '${failedNode}' routed to bounded auto-merge retry${abortProvenance === "merge-seam" ? " after merge-seam abort" : isGenericAbortProvenance(abortProvenance) || abortProvenance === undefined ? " after benign pause/resume abort" : ""}`;
    executorLog.warn(`${live.id}: ${message}`);
    await deps.store.logEntry(live.id, message, undefined, deps.getRunContextFor(live.id));

    /*
    FNXC:MergeRetryReliability 2026-08-26-13:40 (Greptile P1): the boundary-try scope
    is exactly `ensureWorkflowMergeBoundaryTask` + the blocked-park path. A rejection
    here is a boundary-preparation failure: park visibly (AUTO_MERGE_RETRY_FAILED)
    instead of letting handleGraphFailure's method-level catch swallow it silently.
    Everything after — mergeRequester acceptance, token persistence — must NOT be
    classified by this catch, or an accepted merge could be misparked as failed
    (2026-08-26 Greptile "Accepted merge marked failed").
    */
    let mergeBoundary: Awaited<ReturnType<RouteGraphMergeFailureToRetryDeps["ensureWorkflowMergeBoundaryTask"]>> | undefined;
    try {
      /*
      FNXC:MergeRetryReliability 2026-08-26-14:20 (Greptile 3/5): a transient
      boundary-preparation rejection must not terminally fail the task. Retry with
      the same exponential backoff as the park (field window: GDPR-053 API hiccups
      of 20-30s are the norm under planning load); only a persistent outage is
      deemed terminal and parked visibly.
      */
      let firstBoundaryError: unknown;
      for (let attempt = 0; attempt < BIT_BACKOFF_MS.length; attempt += 1) {
        try {
          mergeBoundary = await deps.ensureWorkflowMergeBoundaryTask(live, {
            reason: "workflow-merge-retry-boundary",
            nodeId: failedNode,
            workflowId: result.context?.["workflow:id"] as string | undefined ?? "workflow-graph",
            runId: deps.getRunContextFor(live.id)?.runId ?? "graph-merge-retry",
          });
          break;
        } catch (error) {
          firstBoundaryError ??= error;
          if (attempt < BIT_BACKOFF_MS.length - 1) {
            executorLog.warn(`${live.id}: boundary preparation rejected (${error instanceof Error ? error.message : String(error)}); retrying`);
            await new Promise((resolve) => setTimeout(resolve, BIT_BACKOFF_MS[attempt]));
          }
        }
      }
      if (mergeBoundary === undefined) {
        throw firstBoundaryError;
      }
      /*
      FNXC:WorkflowMerge 2026-08-20-00:50:
      FN-9157 forbids a bounded retry from repeating an unprovable boundary check.
      Park visibly so the existing failed-status lease rule releases overlapping
      work, rather than silently retaining an in-review blocker.
      */
      if (mergeBoundary.blocked) {
        const { reason, code, missingInstanceCount } = mergeBoundary.blocked;
        await deps.store.logEntry(live.id, `Workflow merge boundary retry parked task: ${reason}`, undefined, deps.getRunContextFor(live.id));
        let parked = false;
        /*
        FNXC:MergeRetryReliability 2026-09-04-03:01:
        Boundary preparation awaits work after its initial task read, so an operator
        can requeue before a blocked result returns. Fence this terminal write on the
        same lane-move identity and parkability rules as the bounded retry writer;
        the stale graph failure must not overwrite the replacement execution.
        */
        await deps.store.updateTaskAtomic(live.id, (current) => {
          if (
            !current
            || current.deletedAt
            || current.status != null
            || current.paused
            || current.userPaused
            || (typeof live.columnMovedAt === "string"
              && typeof current.columnMovedAt === "string"
              && current.columnMovedAt !== live.columnMovedAt)
          ) return null;
          parked = true;
          return {
            status: "failed",
            error: `${MERGE_BOUNDARY_UNPROVEN_VALUE.toUpperCase().replaceAll("-", "_")}: ${reason}`,
          };
        }, deps.getRunContextFor(live.id));
        const outcome = parked ? "parked" as const : "already-terminal" as const;
        /*
        FNXC:RunAudit 2026-08-20-02:00:
        FN-9168 records exactly one terminal merge-boundary-unproven park here. The boundary
        helper's blocked return is not a park and remains silent; its bounded audit seam contains
        failure and hangs, so telemetry cannot delay or alter this terminal write or return path.
        */
        await emitMergeBoundaryUnprovenParked(deps.store, {
          taskId: live.id,
          nodeId: failedNode,
          failureValue: MERGE_BOUNDARY_UNPROVEN_VALUE,
          source: "retry-boundary",
          reasonCode: code,
          missingInstanceCount,
          priorColumn: live.column,
          priorStatus: live.status,
          outcome,
          runId: deps.getRunContextFor(live.id)?.runId,
        });
        await persistTokenUsageBestEffort(deps.persistTokenUsage, live.id);
        return true;
      }
    } catch (boundaryError) {
      const reason = boundaryError instanceof Error ? boundaryError.message : String(boundaryError);
      try {
        await deps.store.logEntry(
          live.id,
          `Bounded auto-merge retry failed during boundary preparation; parking task for human intervention: ${reason}`,
          undefined,
          deps.getRunContextFor(live.id),
        );
      } catch {
        // best-effort telemetry; the durable park below is what matters
      }
      const parked = await parkTaskFailed(
        deps.store,
        live.id,
        `AUTO_MERGE_RETRY_FAILED: ${reason}`,
        deps.getRunContextFor(live.id),
        live.columnMovedAt,
      );
      await persistTokenUsageBestEffort(deps.persistTokenUsage, live.id);
      return parked;
    }

    /*
    FNXC:MergeRetryReliability 2026-08-26-12:56 (review): only mergeRequester
    rejections mean "the retry itself was refused" — a resolved requester is an
    accepted merge, and token persistence must not mispark it.
    */
    let mergeRequestRejected = false;
    let mergeRequestRejection: unknown;
    try {
      await deps.mergeRequester(mergeBoundary.task.id);
    } catch (error) {
      mergeRequestRejected = true;
      mergeRequestRejection = error;
    }
    if (!mergeRequestRejected) {
      await persistTokenUsageBestEffort(deps.persistTokenUsage, live.id);
      return true;
    }

    /*
    FNXC:MergeRetryReliability 2026-08-26-11:30 (GDPR-053 field report):
    A rejected mergeRequester used to be swallowed with only an executorLog.warn:
    the task stayed in whatever lane it was in (often in-review) with no status and
    no error, so nothing ever retried the merge and the card sat silently for hours.
    Field evidence: a task whose status was `needs-replan` when the retry fired got
    `task is marked 'needs-replan'` from getTaskMergeBlocker via onMerge; the rejection
    vanished into a broad catch and the board looked healthy while work was stranded.

    Park the task visibly instead: mark it failed with the underlying rejection as the
    error so the existing failed-status lease rule releases overlapping work and the
    operator sees exactly why the auto-merge retry gave up — same contract as the
    FN-9157 blocked-park path above.

    FNXC:MergeRetryReliability 2026-08-26-12:50 (review): the durable park must not be
    skipped because telemetry failed. Log write is best-effort; the status write runs
    unconditionally with its own bounded retry.
    */
    const reason = mergeRequestRejection instanceof Error ? mergeRequestRejection.message : String(mergeRequestRejection);
    try {
      await deps.store.logEntry(
        live.id,
        `Bounded auto-merge retry request rejected; parking task for human intervention: ${reason}`,
        undefined,
        deps.getRunContextFor(live.id),
      );
    } catch {
      // best-effort telemetry; the durable park below is what matters
    }
    const parked = await parkTaskFailed(
      deps.store,
      live.id,
      `${AUTO_MERGE_RETRY_REJECTED_PREFIX} ${reason}`,
      deps.getRunContextFor(live.id),
      live.columnMovedAt,
    );
    await persistTokenUsageBestEffort(deps.persistTokenUsage, live.id);
    return parked;
}
