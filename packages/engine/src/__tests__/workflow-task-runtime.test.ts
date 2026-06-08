import { describe, expect, it } from "vitest";
import type { Settings, TaskDetail, WorkflowIr } from "@fusion/core";

import { WorkflowTaskRuntime, type WorkflowTaskRuntimeDeps } from "../workflow-task-runtime.js";
import type { WorkflowNodeResult } from "../workflow-graph-executor.js";
import type { WorkflowLegacySeams } from "../workflow-node-handlers.js";

const task = { id: "FN-9002" } as TaskDetail;
const flagOff = { experimentalFeatures: {} } as unknown as Pick<Settings, "experimentalFeatures">;

function selectedIr(): WorkflowIr {
  return {
    version: "v1",
    name: "selected",
    nodes: [
      { id: "start", kind: "start" },
      { id: "prepare", kind: "prompt", config: { prompt: "prepare" } },
      { id: "execute", kind: "prompt", config: { seam: "execute" } },
      { id: "zend", kind: "end" },
    ],
    edges: [
      { from: "start", to: "prepare", condition: "success" },
      { from: "prepare", to: "execute", condition: "success" },
      { from: "execute", to: "zend", condition: "success" },
      { from: "execute", to: "zend", condition: "failure" },
    ],
  };
}

function recordingSeams(calls: string[], overrides: Partial<Record<string, WorkflowNodeResult>> = {}): WorkflowLegacySeams {
  const seam = (name: keyof WorkflowLegacySeams) => async (): Promise<WorkflowNodeResult> => {
    calls.push(name);
    return overrides[name] ?? { outcome: "success" };
  };
  return {
    planning: seam("planning"),
    execute: seam("execute"),
    review: seam("review"),
    merge: seam("merge"),
    schedule: seam("schedule"),
  };
}

describe("WorkflowTaskRuntime", () => {
  it("requires execution wiring at the type boundary", () => {
    // @ts-expect-error WorkflowTaskRuntime is an execution entry point, so seams are required.
    const missingSeams: WorkflowTaskRuntimeDeps = {
      store: {
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
      },
      runCustomNode: async () => ({ outcome: "success" }),
    };
    expect(missingSeams).toBeDefined();
  });

  it("runs a selected workflow through the graph engine", async () => {
    const calls: string[] = [];
    let workflowSelectionReads = 0;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => {
          workflowSelectionReads += 1;
          return { workflowId: "WF-001", stepIds: [] };
        },
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
      },
      seams: recordingSeams(calls),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("completed");
    expect(calls).toEqual(["custom:prepare", "execute"]);
    expect(result.visitedNodeIds).toEqual(["start", "prepare", "execute"]);
    expect(workflowSelectionReads).toBe(1);
  });

  it("resolves an unselected task to the built-in coding workflow instead of falling back", async () => {
    const calls: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
      },
      seams: recordingSeams(calls),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("completed");
    expect(calls).toEqual(["execute", "review", "merge"]);
    expect(result.visitedNodeIds).toEqual(["start", "execute", "review", "merge"]);
  });

  it("turns selected workflow lookup failures into the built-in workflow target", async () => {
    const calls: string[] = [];
    const observedRunIds: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-MISSING", stepIds: [] }),
        getWorkflowDefinition: async () => undefined,
      },
      seams: recordingSeams(calls),
      runCustomNode: async () => ({ outcome: "success" }),
      branchPersistence: {
        loadBranchStates: (_taskId, runId) => {
          observedRunIds.push(runId);
          return [];
        },
      },
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("completed");
    expect(calls).toEqual(["execute", "review", "merge"]);
    expect(observedRunIds).toContain("FN-9002:builtin:coding");
    expect(observedRunIds).not.toContain("FN-9002:WF-MISSING");
  });

  it("turns corrupt selected workflow definitions into the built-in workflow target", async () => {
    const calls: string[] = [];
    const observedRunIds: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-CORRUPT", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: "not a workflow ir" }),
      },
      seams: recordingSeams(calls),
      runCustomNode: async () => ({ outcome: "success" }),
      branchPersistence: {
        loadBranchStates: (_taskId, runId) => {
          observedRunIds.push(runId);
          return [];
        },
      },
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("completed");
    expect(calls).toEqual(["execute", "review", "merge"]);
    expect(observedRunIds).toContain("FN-9002:builtin:coding");
    expect(observedRunIds).not.toContain("FN-9002:WF-CORRUPT");
  });

  it("forces only the graph executor flag while preserving other settings", async () => {
    let observedSettings: Pick<Settings, "experimentalFeatures"> | undefined;
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
      },
      seams: recordingSeams([]),
      runCustomNode: async () => ({ outcome: "success" }),
      handlers: {
        prompt: async (_node, context) => {
          observedSettings = context.settings;
          return { outcome: "success" };
        },
      },
    });
    const settings = {
      experimentalFeatures: { workflowColumns: true },
      testMode: true,
    } as unknown as Settings;

    const result = await runtime.run(task, settings);

    expect(result.disposition).toBe("completed");
    expect(observedSettings?.experimentalFeatures?.workflowGraphExecutor).toBe(true);
    expect(observedSettings?.experimentalFeatures?.workflowColumns).toBe(true);
    expect((observedSettings as Settings | undefined)?.testMode).toBe(true);
  });

  it("uses a workflow-specific default run id", async () => {
    const observedRunIds: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
      },
      seams: recordingSeams([]),
      runCustomNode: async () => ({ outcome: "success" }),
      branchPersistence: {
        loadBranchStates: (_taskId, runId) => {
          observedRunIds.push(runId);
          return [];
        },
      },
    });

    await runtime.run(task, flagOff);

    expect(observedRunIds).toContain("FN-9002:WF-001");
  });

  it("uses the built-in workflow id in the default run id for unselected tasks", async () => {
    const observedRunIds: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => undefined,
        getWorkflowDefinition: async () => undefined,
      },
      seams: recordingSeams([]),
      runCustomNode: async () => ({ outcome: "success" }),
      branchPersistence: {
        loadBranchStates: (_taskId, runId) => {
          observedRunIds.push(runId);
          return [];
        },
      },
    });

    await runtime.run(task, flagOff);

    expect(observedRunIds).toContain("FN-9002:builtin:coding");
  });

  it("surfaces graph failures as workflow-engine failures, not fallback", async () => {
    const calls: string[] = [];
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
      },
      seams: recordingSeams(calls, { execute: { outcome: "failure", value: "implementation-incomplete" } }),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("failed");
    expect(result.outcome).toBe("failure");
    expect(calls).toEqual(["custom:prepare", "execute"]);
  });

  it("converts interpreter throws into workflow-engine failures", async () => {
    const badIr: WorkflowIr = {
      version: "v1",
      name: "bad",
      nodes: [
        { id: "start", kind: "start" },
        { id: "zend", kind: "end" },
      ],
      edges: [{ from: "start", to: "ghost" }],
    };
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: badIr }),
      },
      seams: recordingSeams([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("failed");
    expect(result.reason).toMatch(/workflow-execution-error/);
  });

  it("preserves graph node ids when the graph throws after seam and custom side effects", async () => {
    const cyclicIr: WorkflowIr = {
      version: "v1",
      name: "cyclic",
      nodes: [
        { id: "start", kind: "start" },
        { id: "do-execute", kind: "prompt", config: { seam: "execute" } },
        { id: "loop", kind: "prompt", config: { prompt: "loop" } },
      ],
      edges: [
        { from: "start", to: "do-execute", condition: "success" },
        { from: "do-execute", to: "loop", condition: "success" },
        { from: "loop", to: "do-execute", condition: "success" },
      ],
    };
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: cyclicIr }),
      },
      seams: recordingSeams([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("failed");
    expect(result.reason).toMatch(/workflow-execution-error/);
    expect(result.visitedNodeIds).toEqual(["do-execute", "loop"]);
  });

  it("diagnostic event failures do not affect execution", async () => {
    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: selectedIr() }),
      },
      seams: recordingSeams([]),
      runCustomNode: async () => ({ outcome: "success" }),
      onEvent: () => {
        throw new Error("diagnostics failed");
      },
    });

    const result = await runtime.run(task, flagOff);

    expect(result.disposition).toBe("completed");
  });
});
