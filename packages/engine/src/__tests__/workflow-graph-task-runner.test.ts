import { describe, expect, it } from "vitest";
import type { Settings, TaskDetail, WorkflowDefinition, WorkflowIr } from "@fusion/core";

import { WorkflowGraphTaskRunner, type WorkflowGraphRunnerStore } from "../workflow-graph-task-runner.js";
import type { WorkflowNodeResult } from "../workflow-graph-executor.js";

const task = { id: "FN-9001" } as TaskDetail;
const flagOn = { experimentalFeatures: { workflowGraphExecutor: true } } as unknown as Pick<
  Settings,
  "experimentalFeatures"
>;
const flagOff = { experimentalFeatures: {} } as unknown as Pick<Settings, "experimentalFeatures">;

/** start → lint(custom) → execute → review → merge → notify(custom) → end, with seam failure edges to end. */
function fullLifecycleIr(): WorkflowIr {
  return {
    version: "v1",
    name: "full",
    nodes: [
      { id: "start", kind: "start" },
      { id: "lint", kind: "prompt", config: { prompt: "lint it" } },
      { id: "execute", kind: "prompt", config: { seam: "execute" } },
      { id: "review", kind: "prompt", config: { seam: "review" } },
      { id: "merge", kind: "prompt", config: { seam: "merge" } },
      { id: "notify", kind: "script", config: { scriptName: "notify" } },
      { id: "zend", kind: "end" },
    ],
    edges: [
      { from: "start", to: "lint" },
      { from: "lint", to: "execute", condition: "success" },
      { from: "execute", to: "review", condition: "success" },
      { from: "review", to: "merge", condition: "success" },
      { from: "merge", to: "notify", condition: "success" },
      { from: "notify", to: "zend", condition: "success" },
      { from: "execute", to: "zend", condition: "failure" },
      { from: "review", to: "zend", condition: "failure" },
      { from: "merge", to: "zend", condition: "failure" },
    ],
  };
}

function definition(ir: WorkflowIr): WorkflowDefinition {
  return {
    id: "WF-001",
    name: "Full lifecycle",
    description: "",
    kind: "workflow",
    ir,
    layout: {},
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}

function storeWith(def: WorkflowDefinition | undefined, workflowId = "WF-001"): WorkflowGraphRunnerStore {
  return {
    getTaskWorkflowSelection: () => (def ? { workflowId, stepIds: [] } : undefined),
    getWorkflowDefinition: async () => def,
  };
}

function recordingSeams(calls: string[], overrides: Partial<Record<string, WorkflowNodeResult>> = {}) {
  const seam = (name: string) => async (): Promise<WorkflowNodeResult> => {
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

describe("WorkflowGraphTaskRunner (CU-U2)", () => {
  it("runs the full lifecycle in graph order: custom → execute → review → merge → custom", async () => {
    const calls: string[] = [];
    const runner = new WorkflowGraphTaskRunner({
      store: storeWith(definition(fullLifecycleIr())),
      seams: recordingSeams(calls),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
    });

    const result = await runner.run(task, flagOn);

    expect(result.disposition).toBe("completed");
    expect(calls).toEqual(["custom:lint", "execute", "review", "merge", "custom:notify"]);
    expect(result.visitedNodeIds).toEqual(["start", "lint", "execute", "review", "merge", "notify"]);
  });

  it("a failing seam terminates the run as failed without running later nodes", async () => {
    const calls: string[] = [];
    const runner = new WorkflowGraphTaskRunner({
      store: storeWith(definition(fullLifecycleIr())),
      seams: recordingSeams(calls, { review: { outcome: "failure", value: "REVISE" } }),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
    });

    const result = await runner.run(task, flagOn);

    expect(result.disposition).toBe("failed");
    expect(calls).toEqual(["custom:lint", "execute", "review"]);
    expect(calls).not.toContain("merge");
  });

  it("a failing custom gate before execute blocks the whole pipeline", async () => {
    const calls: string[] = [];
    const runner = new WorkflowGraphTaskRunner({
      store: storeWith(definition(fullLifecycleIr())),
      seams: recordingSeams(calls),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return node.id === "lint" ? { outcome: "failure", value: "lint-failed" } : { outcome: "success" };
      },
    });

    const result = await runner.run(task, flagOn);

    expect(result.disposition).toBe("failed");
    expect(calls).toEqual(["custom:lint"]);
  });

  it("falls back when the flag is off", async () => {
    const runner = new WorkflowGraphTaskRunner({
      store: storeWith(definition(fullLifecycleIr())),
      seams: recordingSeams([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });
    const result = await runner.run(task, flagOff);
    expect(result.disposition).toBe("fell-back");
    expect(result.reason).toBe("flag-off");
  });

  it("falls back when the task has no workflow selection", async () => {
    const runner = new WorkflowGraphTaskRunner({
      store: storeWith(undefined),
      seams: recordingSeams([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });
    const result = await runner.run(task, flagOn);
    expect(result).toMatchObject({ disposition: "fell-back", reason: "no-selection" });
  });

  it("falls back when the selected workflow no longer exists", async () => {
    const store: WorkflowGraphRunnerStore = {
      getTaskWorkflowSelection: () => ({ workflowId: "WF-404", stepIds: [] }),
      getWorkflowDefinition: async () => undefined,
    };
    const runner = new WorkflowGraphTaskRunner({
      store,
      seams: recordingSeams([]),
      runCustomNode: async () => ({ outcome: "success" }),
    });
    const result = await runner.run(task, flagOn);
    expect(result.disposition).toBe("fell-back");
    expect(result.reason).toMatch(/workflow-missing/);
  });

  it("falls back (never strands the task) when the interpreter throws", async () => {
    // Malformed graph: edge references unknown node → WorkflowIrError inside run().
    const badIr: WorkflowIr = {
      version: "v1",
      name: "bad",
      nodes: [
        { id: "start", kind: "start" },
        { id: "end", kind: "end" },
      ],
      edges: [{ from: "start", to: "ghost" }],
    };
    const events: string[] = [];
    const runner = new WorkflowGraphTaskRunner({
      store: storeWith(definition(badIr)),
      seams: recordingSeams([]),
      runCustomNode: async () => ({ outcome: "success" }),
      onEvent: (e) => events.push(e.type),
    });
    const result = await runner.run(task, flagOn);
    expect(result.disposition).toBe("fell-back");
    expect(result.reason).toMatch(/interpreter-error/);
    expect(events).toContain("fallback");
  });

  it("an interpreter error AFTER side effects terminates as failed, not fell-back", async () => {
    // Cycle reached only after custom nodes execute: re-running legacy would
    // repeat the implementation, so the runner must not signal fallback.
    const cyclicIr: WorkflowIr = {
      version: "v1",
      name: "cyclic",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt", config: { prompt: "a" } },
        { id: "b", kind: "prompt", config: { prompt: "b" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a", condition: "success" },
        { from: "a", to: "b", condition: "success" },
        { from: "b", to: "a", condition: "success" },
      ],
    };
    const calls: string[] = [];
    const runner = new WorkflowGraphTaskRunner({
      store: storeWith(definition(cyclicIr)),
      seams: recordingSeams(calls),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
    });
    const result = await runner.run(task, flagOn);
    expect(calls.length).toBeGreaterThan(0);
    expect(result.disposition).toBe("failed");
    expect(result.reason).toMatch(/interpreter-error/);
  });

  it("exposes node outcomes in the shared context for downstream consumers", async () => {
    const runner = new WorkflowGraphTaskRunner({
      store: storeWith(definition(fullLifecycleIr())),
      seams: recordingSeams([]),
      runCustomNode: async () => ({ outcome: "success", value: "APPROVE" }),
    });
    const result = await runner.run(task, flagOn);
    expect(result.context?.["node:lint:outcome"]).toBe("success");
    expect(result.context?.["node:lint:value"]).toBe("APPROVE");
  });

  it("onEvent diagnostics failures never affect the run", async () => {
    const runner = new WorkflowGraphTaskRunner({
      store: storeWith(definition(fullLifecycleIr())),
      seams: recordingSeams([]),
      runCustomNode: async () => ({ outcome: "success" }),
      onEvent: () => {
        throw new Error("diagnostics boom");
      },
    });
    const result = await runner.run(task, flagOn);
    expect(result.disposition).toBe("completed");
  });

  // #1407/#1412: the runner forwards its injected branchPersistence into the
  // WorkflowGraphExecutor, which writes per-branch state and prunes stale runs.
  // Uses a real in-memory persistence whose method shape matches the store-
  // backed adapter the production executor builds (saveBranchState /
  // loadBranchStates / clearStaleBranchStates) — no mock of a nonexistent API.
  function fanoutIr(): WorkflowIr {
    return {
      version: "v1",
      name: "fanout",
      nodes: [
        { id: "start", kind: "start" },
        { id: "split", kind: "split" },
        { id: "a", kind: "prompt", config: { prompt: "a" } },
        { id: "b", kind: "prompt", config: { prompt: "b" } },
        { id: "join", kind: "join", config: { mode: "all" } },
        { id: "zend", kind: "end" },
      ],
      edges: [
        { from: "start", to: "split" },
        { from: "split", to: "a" },
        { from: "split", to: "b" },
        { from: "a", to: "join" },
        { from: "b", to: "join" },
        { from: "join", to: "zend", condition: "success" },
      ],
    };
  }

  it("forwards branchPersistence to the executor: writes branch state and prunes stale runs", async () => {
    const saved: Array<{ branchId: string; currentNodeId: string; status: string }> = [];
    const pruneCalls: Array<{ taskId: string; keepRunId: string }> = [];
    const persistence = {
      saveBranchState: (s: { branchId: string; currentNodeId: string; status: string }) => {
        saved.push({ branchId: s.branchId, currentNodeId: s.currentNodeId, status: s.status });
      },
      loadBranchStates: () => [],
      clearStaleBranchStates: (taskId: string, keepRunId: string) => {
        pruneCalls.push({ taskId, keepRunId });
      },
    };

    const runner = new WorkflowGraphTaskRunner({
      store: storeWith(definition(fanoutIr())),
      seams: recordingSeams([]),
      runCustomNode: async () => ({ outcome: "success" }),
      branchPersistence: persistence,
    });

    const result = await runner.run(task, flagOn);
    expect(result.disposition).toBe("completed");

    // Both branches persisted, and each reached "completed" at the join.
    expect(saved.some((s) => s.branchId === "a")).toBe(true);
    expect(saved.some((s) => s.branchId === "b")).toBe(true);
    expect(saved.some((s) => s.status === "completed")).toBe(true);

    // Prune ran (on start AND completion) keyed by the runner's runId.
    expect(pruneCalls.length).toBeGreaterThanOrEqual(2);
    expect(pruneCalls.every((c) => c.taskId === task.id)).toBe(true);
    expect(pruneCalls.every((c) => c.keepRunId === `${task.id}:WF-001`)).toBe(true);
  });
});
