import { WorkflowIrError } from "@fusion/core";

import type { WorkflowCustomNodeRunner } from "../workflows/workflow-node-handlers.js";
import type { WorkflowNodeHandler } from "../workflows/workflow-graph-executor.js";
import type { WorkflowNodeRunner, WorkflowNodeRunnerContext } from "../workflows/workflow-node-runner.js";

/*
FNXC:WorkflowNodeRunners 2026-07-01-00:00:
Gate behavior is an engine-owned node runner. Workflow definitions remain declarative: context gates compare graph state, while executable gates delegate to the existing custom-node execution hook until that service is extracted.
*/
export class GateNodeRunner implements WorkflowNodeRunner {
  public readonly kind = "gate" as const;

  public constructor(private readonly runCustomNode?: WorkflowCustomNodeRunner) {}

  public async run(node: Parameters<WorkflowNodeHandler>[0], context: WorkflowNodeRunnerContext) {
    const expected = node.config?.expect;
    if (typeof expected === "string") {
      const actual = context.context[String(node.config?.contextKey ?? "outcome")];
      if (actual !== expected) {
        return { outcome: "failure" as const, value: "gate-mismatch" };
      }
      return { outcome: "success" as const };
    }

    const hasExecutableConfig =
      typeof node.config?.prompt === "string" || typeof node.config?.scriptName === "string";
    if (hasExecutableConfig) {
      if (!this.runCustomNode) {
        throw new WorkflowIrError(`No custom-node runner registered for node: ${node.id}`);
      }
      return this.runCustomNode(node, context.task, context.context);
    }

    return { outcome: "success" as const };
  }
}

export function createGateHandler(runCustomNode?: WorkflowCustomNodeRunner): WorkflowNodeHandler {
  const runner = new GateNodeRunner(runCustomNode);
  return (node, context) => runner.run(node, context);
}
