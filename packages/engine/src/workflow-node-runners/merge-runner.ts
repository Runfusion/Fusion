import { hasSharedBranchMemberAutoMergeHold, type Settings, type TaskDetail } from "@fusion/core";

import type { WorkflowNodeHandler } from "../workflows/workflow-graph-executor.js";
import type { WorkflowPrimitiveContext, WorkflowRuntimePrimitives } from "../execution/runtime-primitives.js";
import { runWorkflowMergeAttemptNode } from "../workflows/workflow-merge-nodes.js";
import type { WorkflowLegacySeams } from "../workflows/workflow-node-handlers.js";

type MergeRunnerNode = Parameters<WorkflowNodeHandler>[0];
type MergeRunnerContext = Parameters<WorkflowNodeHandler>[1];

export interface MergeAttemptRunnerDeps {
  primitives?: WorkflowRuntimePrimitives;
  seams: Pick<WorkflowLegacySeams, "merge">;
  buildPrimitiveContext: (
    node: MergeRunnerNode,
    context: MergeRunnerContext,
    attempt?: number,
  ) => WorkflowPrimitiveContext;
}

/*
FNXC:WorkflowNodeRunners 2026-07-01-00:00:
Merge-attempt behavior is isolated behind a runner factory so the graph handler map no longer owns merge primitive dispatch. Primitive-backed production runs keep using WorkflowRuntimePrimitives; legacy-seam compatibility remains explicit for runner migration tests.
*/
export function createMergeAttemptHandler(deps: MergeAttemptRunnerDeps): WorkflowNodeHandler {
  return async (node, ctx) => {
    if (!deps.primitives) {
      return deps.seams.merge(ctx.task, ctx.context, ctx.signal);
    }
    const attempt = typeof ctx.context["workflow:work-item-attempt"] === "number"
      ? ctx.context["workflow:work-item-attempt"]
      : undefined;
    return runWorkflowMergeAttemptNode(
      { primitives: deps.primitives },
      deps.buildPrimitiveContext(node, ctx, attempt),
      ctx.task,
    );
  };
}

export interface MergeGateHandlerDeps {
  /** Resolves whether the task currently has a live intermediate group target. */
  isLiveSharedBranchMember?: (
    task: Pick<TaskDetail, "branchContext" | "autoMerge" | "autoMergeProvenance">,
    settings: Pick<Settings, "autoMerge">,
  ) => Promise<boolean>;
}

export function createMergeGateHandler(deps: MergeGateHandlerDeps = {}): WorkflowNodeHandler {
  return async (_node, ctx) => {
    const settingsAutoMerge = (ctx.settings as Partial<Settings> | undefined)?.autoMerge;
    const settings = { autoMerge: settingsAutoMerge ?? true };
    /*
    FNXC:SharedBranchMemberHold 2026-08-08-01:58:
    FN-8823 makes this graph gate the first authoritative consumer of the
    canonical consent policy. Evaluate it before group liveness: a live member
    cannot bypass project Off unless its task explicitly opted in with true.
    */
    const autoMerge = !hasSharedBranchMemberAutoMergeHold(ctx.task, settings)
      && ((await deps.isLiveSharedBranchMember?.(ctx.task, settings)) === true
        || (ctx.task.autoMerge !== false && settings.autoMerge !== false));
    return {
      outcome: "success",
      value: autoMerge ? "auto-on" : "auto-off",
    };
  };
}
