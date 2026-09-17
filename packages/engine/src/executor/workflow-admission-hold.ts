import { HUMAN_MERGE_APPROVAL_HOLD_MARKER, type TaskStore } from "@fusion/core";
import type { WorkflowGraphTaskRunResult } from "../workflows/workflow-graph-task-runner.js";

/**
 * FNXC:WorkflowAdmission 2026-09-13-06:53:
 * Dependency-configuration refusals are durable waits, just like principal capacity refusals.
 * Consume only an explicit marker from a suspended run; arbitrary output strings and old markers
 * on a completed run must never strand successful work.
 *
 * FNXC:WorkflowAdmission 2026-09-13-08:31:
 * The accepted principal-hold marker family is `workflow-principal-*` only. FN-375 deleted the
 * overlap revalidation gate that produced the other former family, drained its historical wait
 * rows (migration 0078) and constrained the phase column so those episodes cannot return, so no
 * producer of that marker survives. Honouring it here would be an unreachable branch that also
 * contradicts the legacy-tombstone ratchet asserting the deleted pre-node review gate can never
 * suspend graph execution. Plan freshness is now checked statelessly at WIP release instead.
 */
/*
 * FNXC:HumanMergeApproval 2026-09-17-18:09:
 * FN-514 adds a second accepted marker family, `workflow-human-merge-approval*`, for the per-card
 * delivery lock. It is deliberately a HOLD and not a failure: the card is waiting for a human, so it
 * must park `held` with a blocked reason (recoverable, resumable by the operator's decision) rather
 * than terminalize, burn a retry budget or traverse a failure edge.
 */
export function workflowAdmissionHoldReason(result: Pick<WorkflowGraphTaskRunResult, "disposition" | "context">): string | undefined {
  if (result.disposition !== "suspended") return undefined;
  for (const [key, value] of Object.entries(result.context ?? {})) {
    if (typeof value !== "string" || !key.startsWith("node:")) continue;
    if (key.endsWith(":principal-hold")
      && (value.startsWith("workflow-principal-") || value.startsWith(HUMAN_MERGE_APPROVAL_HOLD_MARKER))) {
      return value;
    }
    if (key.endsWith(":dependency-configuration-block")) return "dependency-configuration-blocked";
  }
  return undefined;
}

/** True when an admission hold reason is FN-514's human delivery wait rather than agent routing. */
export function isHumanMergeAdmissionHold(reason: string | undefined): boolean {
  return typeof reason === "string" && reason.startsWith(HUMAN_MERGE_APPROVAL_HOLD_MARKER);
}

/**
 * FNXC:WorkflowAdmission 2026-09-13-06:53:
 * Release every owned running fence as well as the resumed continuation before returning a wait.
 * Keep already-held fences untouched and deduplicate the continuation when it is itself a fence.
 */
export async function holdWorkflowAdmission(
  store: Pick<TaskStore, "transitionWorkflowWorkItem">,
  reason: string,
  continuationId: string | undefined,
  fenceIds: ReadonlySet<string>,
  heldIds: ReadonlySet<string>,
): Promise<void> {
  const ids = new Set(fenceIds);
  if (continuationId) ids.add(continuationId);
  for (const id of ids) {
    if (heldIds.has(id)) continue;
    await store.transitionWorkflowWorkItem(id, "held", {
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: reason,
      blockedReason: reason,
    });
  }
}
