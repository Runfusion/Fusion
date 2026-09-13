import type { TaskStore } from "@fusion/core";
import type { WorkflowGraphTaskRunResult } from "../workflows/workflow-graph-task-runner.js";

/**
 * FNXC:WorkflowAdmission 2026-09-13-06:53:
 * Overlap revalidation and dependency-configuration refusals are durable waits, just like
 * principal capacity refusals. Consume only an explicit marker from a suspended run; arbitrary
 * output strings and old markers on a completed run must never strand successful work.
 */
export function workflowAdmissionHoldReason(result: Pick<WorkflowGraphTaskRunResult, "disposition" | "context">): string | undefined {
  if (result.disposition !== "suspended") return undefined;
  for (const [key, value] of Object.entries(result.context ?? {})) {
    if (typeof value !== "string" || !key.startsWith("node:")) continue;
    if (key.endsWith(":principal-hold") && (value.startsWith("workflow-principal-") || value.startsWith("overlap-plan-revalidation-"))) return value;
    if (key.endsWith(":dependency-configuration-block")) return "dependency-configuration-blocked";
  }
  return undefined;
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
