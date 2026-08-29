/**
 * FNXC:CodeOrganization 2026-08-03-17:30:
 * foreachActiveForTask peeled from TaskExecutor (U4).
 *
 * Read the active foreach instance context for a graph-owned task so the step driver can
 * honor deferDoneToReview.
 */
import type { ForeachActiveContext } from "../workflows/workflow-node-handlers.js";
import { graphActiveContextKey } from "./task-predicates.js";

export type ForeachActiveForTaskDeps = {
  graphStepActiveContext: Map<string, ForeachActiveContext>;
};

export function foreachActiveForTask(
  deps: ForeachActiveForTaskDeps,
  taskId: string,
  instanceId?: string,
): ForeachActiveContext | undefined {
  if (typeof instanceId === "string") {
    const byInstance = deps.graphStepActiveContext.get(graphActiveContextKey(taskId, instanceId));
    if (byInstance) return byInstance;
  }
  // Fallback (single-instance / no instanceId threaded): return the sole slot
  // owned by this task if exactly one exists.
  const prefix = `${taskId}:`;
  let only: ForeachActiveContext | undefined;
  for (const [key, value] of deps.graphStepActiveContext) {
    if (!key.startsWith(prefix)) continue;
    if (only) return undefined; // ambiguous: more than one instance active
    only = value;
  }
  return only;
}
