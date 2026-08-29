/*
FNXC:WorkflowExecution 2026-08-08-01:40:
A durable continuation may name a node that is NOT a resumable graph node.

A principal fence written for a node inside a foreach template stores the TEMPLATE node id
(`step-execute`), with the materialized instance in `nodeInstanceId` (`steps#0:step-execute`).
The template node lives under the foreach's `config.template`, never in `ir.nodes` — so handing
it to the interpreter as a start node resolves to nothing. Before this was pinned, that threw
`WorkflowIrError("Workflow IR missing start node")`, the executor's catch turned it into a
terminal graph failure, and a healthy card was parked on every dispatch while the message sent
readers to inspect a workflow definition that was perfectly fine.

Two contracts are pinned here, using the REAL builtin coding IR rather than a fixture so the
nesting is the production one:
  1. `step-execute` is genuinely a template-only node — the premise the executor's guard rests
     on. If the builtin graph ever hoists it to the top level, the guard is dead code and this
     says so.
  2. Resuming at an unknown node id fails with a message that names the resume id, and is
     distinguishable from a genuinely start-less IR.
*/

import { describe, expect, it } from "vitest";
import { resolveDefaultWorkflowIr, WorkflowIrError } from "@fusion/core";
import type { TaskDetail, WorkflowIr, WorkflowIrNode } from "@fusion/core";

import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";

/*
The IR `builtin:coding` actually resolves to. Deliberately the production resolver rather than a
raw constant: `builtin:coding` maps to the stepwise-final-review graph, NOT the legacy
`BUILTIN_CODING_WORKFLOW_IR` (which has no foreach at all), and two move-path resolvers have
already drifted apart on exactly that point.
*/
const DEFAULT_IR = resolveDefaultWorkflowIr();

const task = { id: "FN-RESUME", column: "in-progress" } as TaskDetail;

function settingsOn() {
  return { experimentalFeatures: { workflowGraphExecutor: true } } as never;
}

/** Template nodes of the `steps` foreach in the real builtin coding workflow. */
function foreachTemplateNodeIds(ir: WorkflowIr): string[] {
  const foreach = ir.nodes.find((node) => node.kind === "foreach");
  const template = (foreach?.config as { template?: { nodes?: WorkflowIrNode[] } } | undefined)?.template;
  return (template?.nodes ?? []).map((node) => node.id);
}

describe("graph resume node resolution", () => {
  it("step-execute is a foreach TEMPLATE node, not a top-level graph node", () => {
    const topLevel = DEFAULT_IR.nodes.map((node) => node.id);
    expect(foreachTemplateNodeIds(DEFAULT_IR)).toContain("step-execute");
    // The premise of the executor's resume guard: a fence for this node names something the
    // interpreter cannot start at.
    expect(topLevel).not.toContain("step-execute");
    expect(topLevel).toContain("steps");
    expect(topLevel).toContain("parse");
  });

  it("resuming at a template node id reports the resume id, not a missing start node", async () => {
    const executor = new WorkflowGraphExecutor({});
    const error = await executor
      .run(task, settingsOn(), DEFAULT_IR, "step-execute")
      .then(() => null, (e: unknown) => e as Error);

    expect(error).toBeInstanceOf(WorkflowIrError);
    expect(error?.message).toContain("step-execute");
    // The old message pointed at the wrong thing and cost real debugging time.
    expect(error?.message).not.toBe("Workflow IR missing start node");
  });

  it("still reports a genuinely start-less IR as a missing start node", async () => {
    const executor = new WorkflowGraphExecutor({});
    const startless: WorkflowIr = { version: "v1", name: "startless", nodes: [], edges: [] } as WorkflowIr;

    const error = await executor
      .run(task, settingsOn(), startless)
      .then(() => null, (e: unknown) => e as Error);

    expect(error).toBeInstanceOf(WorkflowIrError);
    expect(error?.message).toBe("Workflow IR missing start node");
  });
});
