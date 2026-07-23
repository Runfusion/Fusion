import { describe, expect, it, vi } from "vitest";
import type { Settings, TaskDetail, WorkflowDefinition, WorkflowIr } from "@fusion/core";

import {
  WORKFLOW_INTERRUPTED_NODE_ABORT_KIND_CONTEXT_KEY,
  WORKFLOW_INTERRUPTED_NODE_ID_CONTEXT_KEY,
  WORKFLOW_NODE_ENGINE_PAUSE_ABORT_KIND,
  WorkflowGraphExecutor,
  type WorkflowNodeResult,
} from "../workflows/workflow-graph-executor.js";
import { WorkflowGraphTaskRunner, type WorkflowGraphRunnerStore } from "../workflows/workflow-graph-task-runner.js";

const now = "2026-06-28T18:15:00.000Z";
const flagOn = { experimentalFeatures: { workflowGraphExecutor: true } } as unknown as Pick<Settings, "experimentalFeatures">;

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-7214-T",
    title: "paused graph node resume",
    description: "Reproduces node-level pause abort re-entry",
    column: "in-review",
    dependencies: [],
    steps: [{ name: "Implement", status: "pending" }],
    currentStep: 0,
    log: [],
    branch: null,
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-7214-t",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    autoMerge: true,
    mergeRetries: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TaskDetail;
}

function planExecuteIr(): WorkflowIr {
  return {
    version: "v1",
    name: "paused-node",
    nodes: [
      { id: "start", kind: "start" },
      { id: "plan", kind: "prompt", config: { seam: "planning" } },
      { id: "execute", kind: "prompt", config: { seam: "execute" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "plan" },
      { from: "plan", to: "execute", condition: "success" },
      { from: "execute", to: "end", condition: "success" },
    ],
  };
}

function definition(ir: WorkflowIr = planExecuteIr()): WorkflowDefinition {
  return {
    id: "WF-7214",
    name: "Paused node workflow",
    description: "",
    kind: "workflow",
    ir,
    layout: {},
    createdAt: now,
    updatedAt: now,
  };
}

function storeWith(def: WorkflowDefinition | undefined): WorkflowGraphRunnerStore {
  return {
    getTaskWorkflowSelection: () => (def ? { workflowId: def.id, stepIds: [] } : undefined),
    getWorkflowDefinition: async () => def,
  };
}

function seamResult(result: WorkflowNodeResult) {
  return async () => result;
}

describe("workflow graph paused node resume contract (FN-7214)", () => {
  it("stamps the interrupted node when a top-level graph signal aborts an in-flight node", async () => {
    const controller = new AbortController();
    const executor = new WorkflowGraphExecutor({
      signal: controller.signal,
      handlers: {
        prompt: async () => {
          controller.abort();
          return { outcome: "failure", value: "aborted" };
        },
      },
    });

    const result = await executor.run(makeTask(), flagOn, planExecuteIr());

    expect(result.outcome).toBe("failure");
    expect(result.visitedNodeIds).toEqual(["start", "plan"]);
    expect(result.context["node:plan:value"]).toBe("aborted");
    expect(result.context["node:plan:abortKind"]).toBe(WORKFLOW_NODE_ENGINE_PAUSE_ABORT_KIND);
    expect(result.context[WORKFLOW_INTERRUPTED_NODE_ID_CONTEXT_KEY]).toBe("plan");
    expect(result.context[WORKFLOW_INTERRUPTED_NODE_ABORT_KIND_CONTEXT_KEY]).toBe(WORKFLOW_NODE_ENGINE_PAUSE_ABORT_KIND);
  });

  it("returns interrupted node metadata from the task runner for aborted planning seams", async () => {
    const runner = new WorkflowGraphTaskRunner({
      store: storeWith(definition()),
      seams: {
        planning: seamResult({ outcome: "failure", value: "aborted" }),
        execute: seamResult({ outcome: "success" }),
        workflowStep: seamResult({ outcome: "success" }),
        review: seamResult({ outcome: "success" }),
        merge: seamResult({ outcome: "success" }),
        schedule: seamResult({ outcome: "success" }),
      },
      runCustomNode: vi.fn(async () => ({ outcome: "success" as const })),
    });

    const result = await runner.run(makeTask(), flagOn);

    expect(result.disposition).toBe("failed");
    expect(result.interruptedNodeId).toBe("plan");
    expect(result.interruptedAbortKind).toBe(WORKFLOW_NODE_ENGINE_PAUSE_ABORT_KIND);
  });

  it("does not mark genuine node failures as paused-aborted interruptions", async () => {
    const runner = new WorkflowGraphTaskRunner({
      store: storeWith(definition()),
      seams: {
        planning: seamResult({ outcome: "failure", value: "REVISE" }),
        execute: seamResult({ outcome: "success" }),
        workflowStep: seamResult({ outcome: "success" }),
        review: seamResult({ outcome: "success" }),
        merge: seamResult({ outcome: "success" }),
        schedule: seamResult({ outcome: "success" }),
      },
      runCustomNode: vi.fn(async () => ({ outcome: "success" as const })),
    });

    const result = await runner.run(makeTask(), flagOn);

    expect(result.disposition).toBe("failed");
    expect(result.interruptedNodeId).toBeUndefined();
    expect(result.interruptedAbortKind).toBeUndefined();
    expect(result.context?.[WORKFLOW_INTERRUPTED_NODE_ID_CONTEXT_KEY]).toBeUndefined();
  });
});
