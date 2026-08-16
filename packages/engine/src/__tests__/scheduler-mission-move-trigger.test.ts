import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionFeature, MissionStore, TaskStore } from "@fusion/core";

const { reconcileMissionState } = vi.hoisted(() => ({ reconcileMissionState: vi.fn() }));
vi.mock("../missions/mission-state-reconcile.js", () => ({ reconcileMissionState }));

import { Scheduler } from "../scheduler.js";

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-001",
    title: "Mission task",
    description: "desc",
    column: "done",
    status: "done",
    sliceId: "SL-001",
    log: [],
    ...overrides,
  };
}

function feature(overrides: Partial<MissionFeature> = {}): MissionFeature {
  return {
    id: "F-001",
    title: "Feature",
    sliceId: "SL-001",
    status: "in-progress",
    loopState: "implementing",
    implementationAttemptCount: 0,
    validatorAttemptCount: 0,
    taskId: "FN-001",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function storeFor(currentTask: ReturnType<typeof task>, overrides: Record<string, unknown> = {}) {
  return {
    getTask: vi.fn(async () => currentTask),
    getRootDir: vi.fn(() => "/test/project"),
    getSettings: vi.fn(async () => ({})),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
}

function missionStoreFor(currentFeature = feature(), overrides: Record<string, unknown> = {}) {
  return {
    getFeatureByTaskId: vi.fn(async () => currentFeature),
    getSlice: vi.fn(async () => ({ id: "SL-001", milestoneId: "MS-001", status: "active" })),
    getMilestone: vi.fn(async () => ({ id: "MS-001", missionId: "M-001" })),
    ...overrides,
  } as unknown as MissionStore;
}

function loop(running = false) {
  return {
    isRunning: vi.fn(() => running),
    start: vi.fn(),
    processTaskOutcome: vi.fn(async () => undefined),
  };
}

async function move(
  currentTask: ReturnType<typeof task>,
  currentMissionStore: MissionStore,
  missionExecutionLoop = loop(),
  taskStore: TaskStore = storeFor(currentTask),
) {
  const scheduler = new Scheduler(taskStore, { missionStore: currentMissionStore, missionExecutionLoop: missionExecutionLoop as any });
  await (scheduler as any).handleMissionTaskMove(currentTask.id, currentTask.column);
  return { scheduler, missionExecutionLoop };
}

describe("FN-9107 scheduler mission completion trigger", () => {
  beforeEach(() => reconcileMissionState.mockReset());

  it("continues after the pre-resolution reconciliation boundary fails", async () => {
    const currentTask = task({ missionId: "M-001" });
    reconcileMissionState.mockRejectedValueOnce(new Error("pre-resolution failure"));

    const { missionExecutionLoop } = await move(currentTask, missionStoreFor());

    expect(reconcileMissionState).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ missionId: "M-001" }));
    expect(missionExecutionLoop.start).toHaveBeenCalledTimes(1);
    expect(missionExecutionLoop.processTaskOutcome).toHaveBeenCalledWith("FN-001");
  });

  it("continues after the post-resolution reconciliation boundary fails without restarting a running loop", async () => {
    const currentTask = task();
    reconcileMissionState.mockImplementation(async (...args: unknown[]) => {
      const options = args[1] as { missionId?: string } | undefined;
      if (options?.missionId === "M-001") throw new Error("post-resolution failure");
    });

    const { missionExecutionLoop } = await move(currentTask, missionStoreFor(), loop(true));

    expect(reconcileMissionState).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ missionId: "M-001" }));
    expect(missionExecutionLoop.start).not.toHaveBeenCalled();
    expect(missionExecutionLoop.processTaskOutcome).toHaveBeenCalledWith("FN-001");
  });

  it("triggers through a custom completion-role column", async () => {
    const currentTask = task({ column: "shipped" });
    const taskStore = storeFor(currentTask, {
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "WF-001", stepIds: [] })),
      getWorkflowDefinition: vi.fn(async () => ({
        ir: { version: "v2", id: "WF-001", nodes: [], edges: [], columns: [{ id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] }] },
      })),
    });

    const { missionExecutionLoop } = await move(currentTask, missionStoreFor(), loop(), taskStore);

    expect(missionExecutionLoop.start).toHaveBeenCalledTimes(1);
    expect(missionExecutionLoop.processTaskOutcome).toHaveBeenCalledWith("FN-001");
  });

  it("keeps the legacy done fallback when workflow resolution fails", async () => {
    const currentTask = task();
    const taskStore = storeFor(currentTask, {
      getTaskWorkflowSelection: vi.fn(() => { throw new Error("workflow unavailable"); }),
    });

    const { missionExecutionLoop } = await move(currentTask, missionStoreFor(), loop(), taskStore);

    expect(missionExecutionLoop.start).toHaveBeenCalledTimes(1);
    expect(missionExecutionLoop.processTaskOutcome).toHaveBeenCalledWith("FN-001");
  });

  it("uses the same trigger when an in-place failure park dispatches task:updated", async () => {
    const currentTask = task({ status: "failed" });
    const taskStore = storeFor(currentTask);
    const missionExecutionLoop = loop();
    const scheduler = new Scheduler(taskStore, { missionStore: missionStoreFor(), missionExecutionLoop: missionExecutionLoop as any });
    const updatedListener = taskStore.on.mock.calls.find(([event]) => event === "task:updated")?.[1];

    updatedListener(currentTask);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(missionExecutionLoop.start).toHaveBeenCalledTimes(1);
    expect(missionExecutionLoop.processTaskOutcome).toHaveBeenCalledWith("FN-001");
  });

  it("preserves the slice mismatch guard", async () => {
    const currentTask = task();
    const { missionExecutionLoop } = await move(currentTask, missionStoreFor(feature({ sliceId: "SL-OTHER" })));

    expect(missionExecutionLoop.start).not.toHaveBeenCalled();
    expect(missionExecutionLoop.processTaskOutcome).not.toHaveBeenCalled();
  });
});
