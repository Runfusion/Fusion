import type { Settings, TaskDetail, WorkflowColumnAgent, WorkflowIrNode } from "@fusion/core";

import type { WorkflowNodeResult } from "./workflow-graph-executor.js";
import type { WorkflowCustomNodeRunner } from "./workflow-node-handlers.js";

export interface WorkflowCustomNodeExecutionServiceDeps {
  execute: (
    node: WorkflowIrNode,
    task: TaskDetail,
    settings: Settings,
    columnBinding?: WorkflowColumnAgent,
    context?: Record<string, unknown>,
  ) => Promise<WorkflowNodeResult>;
  resolveColumnBinding?: (nodeId: string) => WorkflowColumnAgent | undefined;
}

/*
FNXC:WorkflowCustomNodes 2026-07-01-00:00:
Custom prompt/script/gate execution is exposed as a service boundary so graph runners and plugin hooks can depend on a typed node-execution service instead of a private TaskExecutor method. The service delegates during migration; later slices can move executor modes and approval/worktree guards behind this contract.

FNXC:WorkflowCustomNodes 2026-07-01-00:00:
The custom-node service must preserve graph context while abstracting executor internals because optional-group activation and workflow metadata are carried through the runner context, not only through task/settings inputs.
*/
export class WorkflowCustomNodeExecutionService {
  public constructor(private readonly deps: WorkflowCustomNodeExecutionServiceDeps) {}

  public runner(settings: Settings): WorkflowCustomNodeRunner {
    return (node, task, context) =>
      this.deps.execute(
        node,
        task,
        settings,
        this.deps.resolveColumnBinding?.(node.id),
        context,
      );
  }
}
