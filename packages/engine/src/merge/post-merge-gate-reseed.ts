import {
  allowsAutoMergeProcessing,
  ACTIVE_WORKFLOW_WORK_ITEM_STATES,
  computeWorkflowIrPin,
  getPostMergeFinalizeBlocker,
  getRequiredPostMergeEvidenceDecision,
  resolveWorkflowIrForTaskWithProvenance,
  type TaskStore,
  type WorkflowStepResult,
  type RequiredPostMergeEvidenceDecision,
  type Task,
} from "@fusion/core";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { isTaskExecutionLive } from "./merge-execution-exclusion.js";

/**
 * FNXC:PostMergeRecovery 2026-10-01-06:55:
 * A landed card with an absent post-merge gate must resume at that gate, not repeatedly try to
 * finalize or rerun implementation/merge. Existing results (including REVISE) remain authoritative
 * until a real recheck reports; scheduling work never grants approval or erases a rejection.
 * A fresh durable checkout lease is live ownership even when this process has no active session, so
 * finalization and self-healing must refuse it before the snapshot-fenced idle insert.
 */
const DEFAULT_CHECKOUT_LEASE_GRACE_MS = 10 * 60_000;
const CHECKOUT_LEASE_STALENESS_MULTIPLIER = 3;

function hasFreshCheckoutLease(
  task: { checkoutRunId?: string | null; checkoutLeaseRenewedAt?: string | null },
  settings: { taskStuckTimeoutMs?: number },
): boolean {
  const leaseAge = task.checkoutLeaseRenewedAt
    ? Date.now() - Date.parse(task.checkoutLeaseRenewedAt)
    : Number.POSITIVE_INFINITY;
  const graceMs = (settings.taskStuckTimeoutMs ?? DEFAULT_CHECKOUT_LEASE_GRACE_MS)
    * CHECKOUT_LEASE_STALENESS_MULTIPLIER;
  return !!task.checkoutRunId && Number.isFinite(leaseAge) && leaseAge >= 0 && leaseAge < graceMs;
}

export type PostMergeGateResumeResult =
  | { outcome: "resumed"; gateId: string }
  | { outcome: "exhausted"; gateId: string }
  | { outcome: "not-resumable" };

const EXHAUSTED_PREFIX = "Post-merge verification needs remediation";

function hasExhaustedRechecks(result: WorkflowStepResult): boolean {
  return (result.priorAttempts ?? []).filter((entry) => entry.status === "failed").length >= 3;
}

/*
FNXC:ReviewRecovery 2026-10-04-02:24:
Post-merge reviewers can run before hosted CI finishes. Revisit rejected evidence after 15 minutes,
then 30 and 60 minutes, with further checks capped at one per hour. CI and follow-up fixes can
arrive after the early retries; a total attempt cap would strand their evidence permanently.
Durable result history survives restart and task-log updates cannot shorten the wait. Missing
timestamps, duplicate evidence and live owners fail closed.
*/
function isRejectedGateRecheckDue(result: WorkflowStepResult): boolean {
  const failures = (result.priorAttempts ?? []).filter((entry) => entry.status === "failed").length;
  const completedAt = Date.parse(result.completedAt ?? "");
  return result.status === "failed" && Number.isFinite(completedAt)
    && Date.now() - completedAt >= 15 * 60_000 * 2 ** Math.min(failures, 2);
}

export function isPostMergeGateRecoveryDue(
  task: Pick<Task, "workflowStepResults" | "status" | "error">,
  decision: RequiredPostMergeEvidenceDecision,
): boolean {
  if (decision.outcome === "resumable") return true;
  if (decision.outcome !== "blocked" || decision.reason !== "failed") return false;
  const result = task.workflowStepResults?.find((entry) => entry.workflowStepId === decision.gateId);
  return !!result && (isRejectedGateRecheckDue(result)
    || (hasExhaustedRechecks(result) && !task.error?.startsWith(EXHAUSTED_PREFIX)));
}

export async function resumeMissingPostMergeGate(
  store: TaskStore,
  taskId: string,
  options: { manualRetry?: boolean } = {},
): Promise<PostMergeGateResumeResult> {
  if (typeof store.seedWorkspaceCodeReviewContinuationIfIdle !== "function") return { outcome: "not-resumable" };
  const task = await store.getTask(taskId);
  const settings = await store.getSettings();
  if (!task.mergeDetails?.mergeConfirmed || !task.updatedAt
    || task.paused || task.userPaused || task.deletedAt || task.autoMerge === false
    || settings.globalPause || settings.enginePaused
    || !allowsAutoMergeProcessing(task, settings)
    || getPostMergeFinalizeBlocker(task)
    || hasFreshCheckoutLease(task, settings)
    || isTaskExecutionLive(task.id, { activeSessionRegistry, executingTaskLock })) return { outcome: "not-resumable" };

  const decision = await getRequiredPostMergeEvidenceDecision(store, task);
  const manualRetry = options.manualRetry === true && decision.outcome === "blocked" && decision.reason === "failed";
  if (decision.outcome === "finalizable" || (!manualRetry && !isPostMergeGateRecoveryDue(task, decision))) return { outcome: "not-resumable" };
  const failedResult = task.workflowStepResults?.find((entry) => entry.workflowStepId === decision.gateId);
  if (!manualRetry && failedResult?.status === "failed" && hasExhaustedRechecks(failedResult)
    && !task.error?.startsWith(EXHAUSTED_PREFIX)) {
    let recorded = false;
    await store.updateTaskAtomic(task.id, async (live) => {
      if (live.updatedAt !== task.updatedAt || live.paused || live.userPaused || live.deletedAt
        || !live.mergeDetails?.mergeConfirmed || live.autoMerge === false) return null;
      const items = await store.listWorkflowWorkItemsForTask(task.id);
      if (items.some((item) => ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state))) return null;
      recorded = true;
      return { status: "failed", error: `${EXHAUSTED_PREFIX}: '${decision.gateId}' has repeated rejected evidence. ${failedResult.notes || failedResult.output || "Inspect the failed verification result."} Automatic evidence checks continue hourly; Retry can check again after remediation.` };
    });
    if (recorded) await store.logEntry(task.id, `[post-merge] Repeated rejected evidence for '${decision.gateId}'; remediation is required and automatic checks continue hourly. Merge proof and failed evidence are preserved.`);
    return recorded ? { outcome: "exhausted", gateId: decision.gateId } : { outcome: "not-resumable" };
  }
  const selection = await store.getTaskWorkflowSelectionAsync(task.id);
  const resolved = await resolveWorkflowIrForTaskWithProvenance(store, task.id);
  if (resolved.source === "default" && !resolved.selectionAbsent) return { outcome: "not-resumable" };
  const { ir } = resolved;
  const node = ir.version === "v2" ? ir.nodes.find((candidate) => candidate.id === decision.gateId) : undefined;
  if (!node) return { outcome: "not-resumable" };

  const items = await store.listWorkflowWorkItemsForTask(task.id);
  const seeded = await store.seedWorkspaceCodeReviewContinuationIfIdle({
    taskId: task.id,
    nodeId: node.id,
    kind: "task",
    state: "runnable",
    runId: `${task.id}:post-merge-gate-reseed:${node.id}:${items.length}`,
    stableWorkflowRunId: `${task.id}:${ir.name}`,
    continuationSequence: items.length,
    sourceColumn: task.column,
    targetColumn: task.column,
    irHash: computeWorkflowIrPin(ir, node.id).irHash,
    expectedWorkflowSelection: selection ?? null,
    expectedTaskUpdatedAt: task.updatedAt,
  });
  if (!seeded.seeded) return { outcome: "not-resumable" };
  if (task.error?.startsWith(EXHAUSTED_PREFIX)) {
    const previousError = task.error;
    await store.updateTaskAtomic(task.id, (live) => {
      if (live.status !== "failed" || live.error !== previousError || live.paused || live.userPaused
        || !live.mergeDetails?.mergeConfirmed) return null;
      return { status: null as unknown as Task["status"], error: null as unknown as Task["error"] };
    });
  }
  await store.logEntry(task.id, `[post-merge] ${decision.outcome === "resumable" ? "Resuming missing verification" : "Rechecking rejected evidence"} at '${node.id}'; already-landed implementation and merge will not run again.`);
  return { outcome: "resumed", gateId: node.id };
}
