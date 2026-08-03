/**
 * FNXC:CodeOrganization 2026-08-03-17:15:
 * resolveMergeBoundaryColumn, loadMergeBoundaryInstances, and
 * shouldCompleteChecklistAtWorkflowMerge peeled from TaskExecutor (U4).
 */
import type { TaskDetail, TaskStore } from "@fusion/core";
import { resolveWorkflowIrForTask } from "@fusion/core";
import { MERGE_REGION_KINDS } from "../workflows/workflow-graph-executor.js";

export type ResolveMergeBoundaryColumnDeps = {
  store: TaskStore;
};

export async function resolveMergeBoundaryColumn(
  deps: ResolveMergeBoundaryColumnDeps,
  taskId: string,
  nodeId: string,
): Promise<string> {
  try {
    const ir = await resolveWorkflowIrForTask(deps.store, taskId);
    // Prefer the named node's column when it is itself a merge-class node
    // (merge-gate/merge-attempt/…). Otherwise fall back to the FIRST merge-class
    // node's column — the boundary's caller may pass a synthetic id
    // ("legacy-merge-seam") or a non-merge node, so keying on merge-class kinds
    // (not an arbitrary node's column) is what reliably lands the card in the
    // workflow's merge column: `in-review` for builtin:coding (KTD-7 parity),
    // `Merging` for the benchmark.
    const named = ir.nodes.find((n) => n.id === nodeId);
    if (named && MERGE_REGION_KINDS.has(named.kind) && named.column) return named.column;
    const mergeNode = ir.nodes.find((n) => MERGE_REGION_KINDS.has(n.kind) && n.column);
    if (mergeNode?.column) return mergeNode.column;
    return "in-review";
  } catch {
    return "in-review";
  }
}

export type LoadMergeBoundaryInstancesDeps = {
  store: TaskStore;
};

export async function loadMergeBoundaryInstances(
  deps: LoadMergeBoundaryInstancesDeps,
  taskId: string,
  runId?: string,
): Promise<Array<{ foreachNodeId: string; stepIndex: number; pinnedStepCount: number }>> {
  if (!runId) return [];
  const store = deps.store as typeof deps.store & {
    loadWorkflowRunStepInstancesAsync?: (id: string, idRun: string) => Promise<Array<{ foreachNodeId: string; stepIndex: number; pinnedStepCount: number }>>;
    loadWorkflowRunStepInstances?: (id: string, idRun: string) => Array<{ foreachNodeId: string; stepIndex: number; pinnedStepCount: number }>;
  };
  try {
    return await store.loadWorkflowRunStepInstancesAsync?.(taskId, runId)
      ?? store.loadWorkflowRunStepInstances?.(taskId, runId)
      ?? [];
  } catch { return []; }
}

/*
FNXC:WorkflowMerge 2026-07-27-12:00:
FN-8601 gates checklist projection and foreach merge admission on required node-result
presence, terminal status for every present result, and expanded-instance coverage.
Non-foreach/no-seam coverage is vacuous and does not change legacy move behavior.
*/
export function shouldCompleteChecklistAtWorkflowMerge(
  task: TaskDetail,
  proof?: { complete: boolean },
): boolean {
  if (!Array.isArray(task.steps) || task.steps.length === 0) return false;
  if (task.steps.every((step) => step.status === "done" || step.status === "skipped")) return false;
  if (proof) return proof.complete;
  const graphNodeResults = (task.workflowStepResults ?? []).filter((result) => result.source === "node" && (result.phase ?? "pre-merge") === "pre-merge");
  return graphNodeResults.length > 0 && graphNodeResults.every((result) => result.status === "passed" || result.status === "skipped");
}
