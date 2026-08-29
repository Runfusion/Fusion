import type { TaskDetail, WorkflowIrNode } from "@fusion/core";

import type { WorkflowNodeHandler, WorkflowNodeResult } from "../workflows/workflow-graph-executor.js";
import type { WorkflowNodeRunner, WorkflowNodeRunnerContext } from "../workflows/workflow-node-runner.js";

export type CodeNodeRunnerDelegate = (
  node: WorkflowIrNode,
  task: TaskDetail,
  context: Record<string, unknown>,
) => Promise<WorkflowNodeResult>;

/*
FNXC:WorkflowNodeRunners 2026-07-01-00:00:
Code nodes now have a dedicated runner boundary. The compile/process mechanics remain injected, and an unwired code node fails closed so graph routing cannot silently approve unexecuted code.
*/
export class CodeWorkflowNodeRunner implements WorkflowNodeRunner {
  public readonly kind = "code" as const;

  public constructor(private readonly runCode?: CodeNodeRunnerDelegate) {}

  public async run(node: WorkflowIrNode, context: WorkflowNodeRunnerContext): Promise<WorkflowNodeResult> {
    if (!this.runCode) {
      return { outcome: "failure", value: "code-node-unwired" };
    }
    return this.runCode(node, context.task, context.context);
  }
}

export function createCodeNodeHandler(runCode?: CodeNodeRunnerDelegate): WorkflowNodeHandler {
  const runner = new CodeWorkflowNodeRunner(runCode);
  return (node, context) => runner.run(node, context);
}
