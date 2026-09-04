import { describe, expect, it, vi } from "vitest";
import type { TaskStore, WorkflowIr } from "@fusion/core";

import { Scheduler } from "../scheduler.js";
import { flushAsyncHandlers } from "./_flush-async-handlers.js";

const WORKFLOW_ID = "custom:capacity-wake";

function workflow(wipColumns = ["in-progress"]): WorkflowIr {
  return {
    version: "v2",
    id: WORKFLOW_ID,
    name: "Capacity wake",
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", name: "Planning", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      ...wipColumns.map((id) => ({ id, name: id, traits: [{ trait: "wip" as const }] })),
      { id: "in-review", name: "Review", traits: [{ trait: "merge" }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function task(column: string) {
  return {
    id: "FN-242",
    title: "Capacity wake",
    description: "",
    column,
    status: null,
    paused: false,
    userPaused: false,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    columnMovedAt: "2026-08-28T21:24:00.000Z",
    createdAt: "2026-08-28T21:00:00.000Z",
    updatedAt: "2026-08-28T21:24:00.000Z",
  };
}

function createHarness(ir = workflow(), running = true) {
  const listeners = new Map<string, Array<(payload: any) => unknown>>();
  const selection = { workflowId: WORKFLOW_ID, stepIds: [] };
  const store = {
    on: vi.fn((event: string, listener: (payload: any) => unknown) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    off: vi.fn(),
    getRootDir: vi.fn(() => "/test/project"),
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
    listTasks: vi.fn(async () => []),
    updateTask: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
  } as unknown as TaskStore;
  const onCapacityReleased = vi.fn();
  const scheduler = new Scheduler(store, { onCapacityReleased });
  const schedule = vi.spyOn(scheduler, "schedule").mockResolvedValue(undefined);
  (scheduler as unknown as { running: boolean }).running = running;

  return {
    scheduler,
    schedule,
    onCapacityReleased,
    emit: async (from: string, to: string, source = "engine") => {
      const payload = { task: task(to), from, to, source };
      for (const listener of listeners.get("task:moved") ?? []) await listener(payload);
      await flushAsyncHandlers();
    },
  };
}

describe("Scheduler capacity-release event wakes", () => {
  it("wakes once when the default WIP lane is vacated", async () => {
    const { emit, schedule, onCapacityReleased } = createHarness();

    await emit("in-progress", "in-review");

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(onCapacityReleased).toHaveBeenCalledOnce();
    expect(onCapacityReleased).toHaveBeenCalledWith("wip-column");
  });

  it("resolves a renamed capacity lane from workflow traits", async () => {
    const { emit, schedule, onCapacityReleased } = createHarness(workflow(["building"]));

    await emit("building", "in-review");

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(onCapacityReleased).toHaveBeenCalledWith("wip-column");
  });

  it("does not wake between two capacity lanes but wakes when leaving their membership", async () => {
    const { emit, schedule, onCapacityReleased } = createHarness(workflow(["build-a", "build-b"]));

    await emit("build-a", "build-b");
    expect(schedule).not.toHaveBeenCalled();
    expect(onCapacityReleased).not.toHaveBeenCalled();

    await emit("build-b", "in-review");
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(onCapacityReleased).toHaveBeenCalledTimes(1);
  });

  it("coalesces the capacity and hold wake arms into one scheduling pass", async () => {
    const { scheduler, emit, schedule, onCapacityReleased } = createHarness();

    await emit("in-progress", "todo", "engine");

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(onCapacityReleased).toHaveBeenCalledTimes(1);
    expect((scheduler as unknown as { recentEngineTodoRequeues: Map<string, string> }).recentEngineTodoRequeues.has("FN-242")).toBe(true);
  });

  it("does not report capacity release when moving into a WIP lane", async () => {
    const { emit, schedule, onCapacityReleased } = createHarness();

    await emit("todo", "in-progress");

    expect(onCapacityReleased).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("does not wake after the scheduler is stopped", async () => {
    const { emit, schedule, onCapacityReleased } = createHarness(workflow(), false);

    await emit("in-progress", "in-review");

    expect(schedule).not.toHaveBeenCalled();
    expect(onCapacityReleased).not.toHaveBeenCalled();
  });
});
