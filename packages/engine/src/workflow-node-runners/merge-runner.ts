import { hasUserAutoMergeHold, type Settings, type TaskDetail } from "@fusion/core";

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
    FNXC:SharedBranchMemberHold 2026-08-05-22:50:
    FN-8811 requires the graph's first merge decision to preserve the live
    member→group fast path for inherited, mission, and legacy false values.
    Only the operator-authored false pair takes the existing manual-hold edge;
    the live resolver also keeps stale/default-branch groups on normal policy.
    */
    const autoMerge = !hasUserAutoMergeHold(ctx.task)
      && ((await deps.isLiveSharedBranchMember?.(ctx.task, settings)) === true
        || (ctx.task.autoMerge !== false && settings.autoMerge !== false));
    return {
      outcome: "success",
      value: autoMerge ? "auto-on" : "auto-off",
    };
  };
}
