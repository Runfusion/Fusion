import type { Task, WorkflowStepResult } from "../types.js";
import { resolveWorkflowIrForTask, type WorkflowIrResolverStore } from "../workflows/workflow-ir-resolver.js";
import { isWorkflowOptionalGroupEnabled } from "../workflows/workflow-optional-steps.js";
import { BLOCKING_TASK_STATUSES, clearMergeConfirmedTransientStatus } from "./task-merge.js";

export type ConfirmedMergeChecklistReconciliation = {
  skippedStepIndexes: number[];
  reconciledWorkflowStepIds: string[];
};

export type RequiredPostMergeEvidenceDecision =
  | { outcome: "finalizable" }
  | { outcome: "resumable"; gateId: string }
  | { outcome: "blocked"; gateId: string; reason: "duplicate" | "pending" | "failed" | "skipped" | "not-approved" };

/*
FNXC:ConfirmedMergeFinalization 2026-08-23-07:42:
FN-180 requires a confirmed integration merge to finalize even when a concurrent
review bounce left a stale checklist. Post-merge checks deliberately exclude
steps and review verdicts; only independent task blocking states may defer.

FNXC:ConfirmedMergeFinalization 2026-08-28-11:05:
A failed status cannot block post-merge finalization because all consumers establish durable merge
or landing proof before calling this helper: the shared finalizer uses hasDurableMergeProof, the
project-engine fast path verifies mergeConfirmed reachability, and self-healing proves the landed
commit. getTaskHardMergeBlocker already neutralizes failed for the same FN-9193 failure shape. This
is not a laundering path: keeping proven-landed work out of completion cannot un-merge it and only
leaves a permanently failed board card; every independent operator and planning status still blocks.
*/
export function getPostMergeFinalizeBlocker(task: Pick<Task, "status" | "error">): string | undefined {
  const status = clearMergeConfirmedTransientStatus(task.status);
  if (status && status !== "failed" && BLOCKING_TASK_STATUSES.has(status)) {
    return task.error ? `task is marked '${status}': ${task.error}` : `task is marked '${status}'`;
  }
  return undefined;
}

/*
FNXC:PostMergeRecovery 2026-10-01-06:36:
A confirmed landing is not completion when an enabled post-merge gate has no durable result. The
shared decision exposes that one resumable state structurally, so recovery owners never infer it
from display text; pending, duplicate, skipped, failed, and non-approved evidence remain blockers.
*/
export async function getRequiredPostMergeEvidenceDecision(
  store: WorkflowIrResolverStore,
  task: Pick<Task, "id" | "enabledWorkflowSteps" | "workflowStepResults">,
): Promise<RequiredPostMergeEvidenceDecision> {
  const reader = store as Partial<WorkflowIrResolverStore>;
  if (typeof reader.getTaskWorkflowSelection !== "function") return { outcome: "finalizable" };

  const ir = await resolveWorkflowIrForTask(store, task.id);
  const requiredGateIds = ir.version === "v2"
    ? ir.nodes.flatMap((node) => {
      if (node.kind !== "optional-group" || node.config?.phase !== "post-merge") return [];
      const template = node.config.template as { nodes?: Array<{ config?: { gateMode?: unknown } }> } | undefined;
      const gateMode = template?.nodes?.some((inner) => inner.config?.gateMode === "gate");
      return gateMode && isWorkflowOptionalGroupEnabled(task.enabledWorkflowSteps, node.id, node.config.defaultOn === true)
        ? [node.id]
        : [];
    })
    : [];

  for (const gateId of requiredGateIds) {
    const results = (task.workflowStepResults ?? []).filter((entry) => entry.workflowStepId === gateId);
    if (results.length === 0) return { outcome: "resumable", gateId };
    if (results.length > 1) return { outcome: "blocked", gateId, reason: "duplicate" };
    const [result] = results;
    if (result.status === "pending") return { outcome: "blocked", gateId, reason: "pending" };
    if (result.status === "failed") return { outcome: "blocked", gateId, reason: "failed" };
    if (result.status === "skipped") {
      // Remediation invalidated this earlier attempt; it is retained history, not a waiver.
      if (result.remediationArchivedAt && !result.bypassedBy) return { outcome: "resumable", gateId };
      return { outcome: "blocked", gateId, reason: "skipped" };
    }
    if (result.status !== "passed" || (result.verdict !== "APPROVE" && result.verdict !== "APPROVE_WITH_NOTES")) {
      return { outcome: "blocked", gateId, reason: "not-approved" };
    }
  }
  return { outcome: "finalizable" };
}

export async function getRequiredPostMergeEvidenceBlocker(
  store: WorkflowIrResolverStore,
  task: Pick<Task, "id" | "enabledWorkflowSteps" | "workflowStepResults">,
): Promise<string | undefined> {
  const decision = await getRequiredPostMergeEvidenceDecision(store, task);
  if (decision.outcome === "finalizable") return undefined;
  if (decision.outcome === "resumable") return `required post-merge evidence gate '${decision.gateId}' has not reported`;
  return `required post-merge evidence gate '${decision.gateId}' is not approved`;
}

export function planConfirmedMergeChecklistReconciliation(
  task: Pick<Task, "steps" | "workflowStepResults">,
): ConfirmedMergeChecklistReconciliation {
  /*
  FNXC:ConfirmedMergeFinalization 2026-09-01-05:49:
  `steps` is typed non-optional, but a row can still reach here without it — an older row, a partial
  projection, a store path that does not populate it. This function runs on the merge-CONFIRMED
  fast path, i.e. after the work has already landed, so a TypeError here abandons the finalize and
  leaves a merged task un-finalized. Tolerating the absence costs nothing; asserting the type does
  not make the row real. Measured: a task whose row carried no `steps` threw
  "Cannot read properties of undefined (reading 'map')" and the landed merge never finalized.
  */
  return {
    skippedStepIndexes: (task.steps ?? [])
      .map((step, index) => step.status === "pending" || step.status === "in-progress" ? index : -1)
      .filter((index) => index >= 0),
    reconciledWorkflowStepIds: (task.workflowStepResults ?? [])
      .filter((result: WorkflowStepResult) => result.status === "pending")
      .map((result) => result.workflowStepId),
  };
}
