import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, TaskDetail, WorkflowDefinition, WorkflowIr } from "@fusion/core";
import { createTaskStoreForTest, PG_AVAILABLE } from "../../../core/src/__test-utils__/pg-test-harness.js";

import { NotificationService } from "../notification/notification-service.js";
import { WorkflowGraphTaskRunner, type WorkflowGraphRunnerStore } from "../workflow-graph-task-runner.js";
import type { WorkflowNodeResult } from "../workflow-graph-executor.js";

const task = { id: "FN-9001" } as TaskDetail;
const flagOn = { experimentalFeatures: { workflowGraphExecutor: true } } as unknown as Pick<
  Settings,
  "experimentalFeatures"
>;
const flagOff = { experimentalFeatures: { workflowGraphExecutor: false } } as unknown as Pick<
  Settings,
  "experimentalFeatures"
>;

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
    workflowStep: seam("workflow-step"),
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

  it("projects agent-generated completion summaries from workflow nodes onto the task", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "summary",
      nodes: [
        { id: "start", kind: "start" },
        { id: "summary", kind: "prompt", config: { prompt: "summarize", summaryTarget: "task" } },
        { id: "zend", kind: "end" },
      ],
      edges: [
        { from: "start", to: "summary" },
        { from: "summary", to: "zend", condition: "success" },
      ],
    };
    const projections: Array<{ taskId: string; summary?: string }> = [];
    const runner = new WorkflowGraphTaskRunner({
      store: storeWith(definition(ir)),
      seams: recordingSeams([]),
      runCustomNode: async () => ({
        outcome: "success",
        contextPatch: { summary: "Implemented the workflow and verified the result." },
      }),
      publishTaskProjection: async (taskId, patch) => {
        projections.push({ taskId, summary: patch.summary });
      },
    });

    const result = await runner.run(task, flagOn);

    expect(result.disposition).toBe("completed");
    expect(projections).toEqual([
      { taskId: "FN-9001", summary: "Implemented the workflow and verified the result." },
    ]);
  });

  it("selected workflows reaching the merge seam produce the canonical merged notification once", async () => {
    const emitter = new EventEmitter();
    const graphTask = {
      ...task,
      title: "Workflow merge",
      description: "Graph path",
      column: "done",
      mergeDetails: { mergeConfirmed: true },
    } as TaskDetail;
    const store = Object.assign(emitter, {
      getSettings: vi.fn(async () => ({ ntfyEnabled: true, ntfyTopic: "topic" }) as Settings),
      getTask: vi.fn(async (_id: string) => graphTask),
      getTaskWorkflowSelection: () => ({ workflowId: "WF-001", stepIds: [] }),
      getWorkflowDefinition: async () => definition(fullLifecycleIr()),
    }) as unknown as EventEmitter & WorkflowGraphRunnerStore & {
      getSettings: () => Promise<Settings>;
      getTask: (id: string) => Promise<TaskDetail>;
    };
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const service = new NotificationService(store as any);
    service.registerProvider({ getProviderId: () => "mock", isEventSupported: () => true, sendNotification });
    await service.start();

    const runner = new WorkflowGraphTaskRunner({
      store,
      seams: {
        ...recordingSeams([]),
        merge: async () => {
          store.emit("task:moved", { task: graphTask, from: "in-review", to: "done" });
          store.emit("task:merged", {
            task: graphTask,
            branch: "fusion/fn-9001",
            merged: true,
            worktreeRemoved: false,
            branchDeleted: false,
          });
          return { outcome: "success", value: "merged" };
        },
      },
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runner.run(graphTask, flagOn);

    expect(result.disposition).toBe("completed");
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalledTimes(1);
    });
    expect(sendNotification).toHaveBeenCalledWith(
      "merged",
      expect.objectContaining({ taskId: "FN-9001", taskTitle: "Workflow merge", event: "merged" }),
    );
    await service.stop();
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

  it("ignores stale workflowGraphExecutor=false and still runs the graph", async () => {
    const calls: string[] = [];
    const runner = new WorkflowGraphTaskRunner({
      store: storeWith(definition(fullLifecycleIr())),
      seams: recordingSeams(calls),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
    });
    const result = await runner.run(task, flagOff);
    expect(result.disposition).toBe("completed");
    expect(calls).toEqual(["custom:lint", "execute", "review", "merge", "custom:notify"]);
    expect(result.visitedNodeIds).toEqual(["start", "lint", "execute", "review", "merge", "notify"]);
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

  // FNXC:PgMigrationQuarantine 2026-07-17-18:15: FN-8258 exercises persisted workflow selection against the PostgreSQL AsyncDataLayer rather than removed SQLite inMemoryDb construction.
  (PG_AVAILABLE ? it : it.skip)("persists a valid workflow through the store and launches it through the graph runner", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_workflow_graph_runner" });
    const store = harness.store;
    try {
      const invalidIr: WorkflowIr = {
        version: "v2",
        name: "invalid-save",
        columns: [{ id: "todo", name: "Todo", traits: [] }],
        nodes: [
          { id: "start", kind: "start", column: "todo" },
          { id: "dup", kind: "prompt", column: "todo" },
          { id: "dup", kind: "script", column: "todo" },
          { id: "end", kind: "end", column: "todo" },
        ],
        edges: [
          { from: "start", to: "dup" },
          { from: "dup", to: "end" },
        ],
      };
      await expect(store.createWorkflowDefinition({ name: "Invalid", ir: invalidIr })).rejects.toThrow(
        /Workflow IR has duplicate node id 'dup'/,
      );

      const workflow = await store.createWorkflowDefinition({ name: "Valid", ir: fullLifecycleIr() });
      const persisted = await store.getWorkflowDefinition(workflow.id);
      expect(persisted?.id).toBe(workflow.id);
      const savedTask = await store.createTask({ description: "save run", enabledWorkflowSteps: [] });
      await store.selectTaskWorkflow(savedTask.id, workflow.id);

      const calls: string[] = [];
      const runner = new WorkflowGraphTaskRunner({
        store,
        seams: recordingSeams(calls),
        runCustomNode: async (node) => {
          calls.push(`custom:${node.id}`);
          return { outcome: "success" };
        },
      });

      const result = await runner.run(savedTask, flagOn);

      expect(result.disposition).toBe("completed");
      expect(calls).toEqual(["custom:lint", "execute", "review", "merge", "custom:notify"]);
    } finally {
      await harness.teardown();
    }
  });

  it("resolves built-in workflow selections without requiring the store to return a definition", async () => {
    const calls: string[] = [];
    const getWorkflowDefinition = vi.fn(async () => undefined);
    const store: WorkflowGraphRunnerStore = {
      getTaskWorkflowSelection: () => ({ workflowId: "builtin:legacy-coding", stepIds: [] }),
      getWorkflowDefinition,
    };
    const runner = new WorkflowGraphTaskRunner({
      store,
      seams: recordingSeams(calls),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await runner.run(task, flagOn);

    expect(result.disposition).toBe("completed");
    // FNXC:WorkflowBuiltins 2026-06-28-23:29:
    // Use Legacy coding here because default Coding is now stepwise and requires
    // parse/foreach task-step context. This still proves built-in registry fallback
    // works when the store intentionally does not return a persisted definition.
    expect(calls).toEqual(["planning", "execute", "review", "merge"]);
    expect(result.reason).toBeUndefined();
    expect(getWorkflowDefinition).not.toHaveBeenCalled();
  });

  it("fails closed with invalid-ir before any side-effect seam when resolved IR is malformed", async () => {
    const badIr: WorkflowIr = {
      version: "v2",
      name: "bad",
      columns: [{ id: "c", name: "C", traits: [] }],
      nodes: [
        { id: "start", kind: "start", column: "c" },
        { id: "dup", kind: "prompt", column: "c" },
        { id: "dup", kind: "script", column: "c" },
        { id: "end", kind: "end", column: "c" },
      ],
      edges: [
        { from: "start", to: "dup" },
        { from: "dup", to: "end" },
      ],
    };
    const calls: string[] = [];
    const events: string[] = [];
    const runner = new WorkflowGraphTaskRunner({
      store: storeWith(definition(badIr)),
      seams: recordingSeams(calls),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
      onEvent: (e) => events.push(`${e.type}:${e.detail}`),
    });

    const result = await runner.run(task, flagOn);

    expect(result.disposition).toBe("failed");
    expect(result.outcome).toBe("failure");
    expect(result.reason).toMatch(/invalid-ir: Workflow IR has duplicate node id 'dup'/);
    expect(result.visitedNodeIds).toEqual([]);
    expect(calls).toEqual([]);
    expect(events.some((event) => event.includes("terminal:invalid-ir"))).toBe(true);
  });

  it("fails closed with invalid-ir before any custom node when resolved IR has a dangling edge", async () => {
    const badIr: WorkflowIr = {
      version: "v2",
      name: "bad-edge",
      columns: [{ id: "c", name: "C", traits: [] }],
      nodes: [
        { id: "start", kind: "start", column: "c" },
        { id: "a", kind: "prompt", column: "c" },
        { id: "end", kind: "end", column: "c" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "ghost" },
      ],
    };
    const calls: string[] = [];
    const runner = new WorkflowGraphTaskRunner({
      store: storeWith(definition(badIr)),
      seams: recordingSeams(calls),
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
    });

    const result = await runner.run(task, flagOn);

    expect(result.disposition).toBe("failed");
    expect(result.outcome).toBe("failure");
    expect(result.reason).toMatch(/invalid-ir: Workflow edge 'a' -> 'ghost' references undefined node 'ghost'/);
    expect(result.visitedNodeIds).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("a custom-node failure AFTER side effects terminates as failed, not fell-back", async () => {
    const calls: string[] = [];
    const runner = new WorkflowGraphTaskRunner({
      store: storeWith(definition(fullLifecycleIr())),
      seams: recordingSeams(calls),
      runCustomNode: async (node) => {
        throw new Error(`custom boom: ${node.id}`);
      },
    });
    const result = await runner.run(task, flagOn);
    expect(calls).toEqual([]);
    expect(result.visitedNodeIds).toEqual(["start", "lint"]);
    expect(result.disposition).toBe("failed");
    expect(result.reason).toBeUndefined();
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
