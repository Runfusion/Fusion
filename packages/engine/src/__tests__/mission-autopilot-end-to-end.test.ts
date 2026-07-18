import { describe, it, expect, vi } from "vitest";
import { Scheduler } from "../scheduler.js";
import { MissionAutopilot } from "../mission-autopilot.js";
import { MissionExecutionLoop } from "../mission-execution-loop.js";
import type { TaskStore } from "@fusion/core";

function makeHarness({
  withAssertions = true,
  initialFeatureStatus = "in-progress",
  initialTaskColumn = "in-progress",
  runValidationImpl,
}: {
  withAssertions?: boolean;
  initialFeatureStatus?: string;
  initialTaskColumn?: string;
  runValidationImpl?: () => Promise<{ status: "pass" | "error"; assertions: []; summary: string }>;
} = {}) {
  const mission = {
    id: "M-001",
    title: "Mission",
    status: "active",
    autoAdvance: true,
    autopilotEnabled: true,
    autopilotState: "inactive",
    interviewState: "not_started",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as const;
  const milestone = {
    id: "MS-001",
    missionId: mission.id,
    title: "Milestone",
    status: "active",
    orderIndex: 0,
    interviewState: "not_started",
    dependencies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const slices = new Map<string, any>([
    ["SL-001", { id: "SL-001", milestoneId: milestone.id, title: "Slice 1", status: "active", planState: "not_started", orderIndex: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    ["SL-002", { id: "SL-002", milestoneId: milestone.id, title: "Slice 2", status: "pending", planState: "not_started", orderIndex: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
  ]);
  const feature = {
    id: "F-001",
    sliceId: "SL-001",
    title: "Feature",
    status: initialFeatureStatus,
    loopState: "implementing",
    taskId: "FN-001",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const features = new Map([[feature.id, feature]]);
  const task = {
    id: "FN-001",
    title: "Task",
    description: "desc",
    column: initialTaskColumn,
    sliceId: "SL-001",
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [],
    currentStep: 0,
    dependencies: [],
    prompt: "",
  } as any;

  const handlers = new Map<string, Function[]>();
  const on = vi.fn((event: string, cb: Function) => {
    handlers.set(event, [...(handlers.get(event) ?? []), cb]);
  });

  let missionStore: any;
  const taskStore = {
    getTask: vi.fn(async () => task),
    getRootDir: vi.fn(() => "/tmp"),
    getTasksDir: vi.fn(() => "/tmp/.fusion/tasks"),
    getSettings: vi.fn(async () => ({})),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    listTasks: vi.fn(async () => []),
    updateTask: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => ({})),
    getMissionStore: vi.fn(() => missionStore),
    on,
    off: vi.fn(),
  } as unknown as TaskStore;

  missionStore = {
    getMission: vi.fn(() => mission),
    listMissions: vi.fn(() => [mission]),
    updateMission: vi.fn((_id: string, updates: any) => ({ ...mission, ...updates })),
    logMissionEvent: vi.fn(),
    getMilestone: vi.fn((id: string) => (id === milestone.id ? milestone : undefined)),
    getSlice: vi.fn((id: string) => slices.get(id)),
    updateSlice: vi.fn((id: string, updates: any) => {
      const next = { ...slices.get(id), ...updates, updatedAt: new Date().toISOString() };
      slices.set(id, next);
      return next;
    }),
    getMissionWithHierarchy: vi.fn(() => ({
      ...mission,
      milestones: [{ ...milestone, slices: [...slices.values()].map((slice) => ({ ...slice, features: [...features.values()].filter((f) => f.sliceId === slice.id) })) }],
    })),
    listSlices: vi.fn(() => [...slices.values()]),
    listFeatures: vi.fn((sliceId?: string) => [...features.values()].filter((f) => !sliceId || f.sliceId === sliceId)),
    getFeatureByTaskId: vi.fn((taskId: string) => [...features.values()].find((f) => f.taskId === taskId)),
    getFeature: vi.fn((id: string) => features.get(id)),
    updateFeatureStatus: vi.fn((id: string, status: string) => {
      const existing = features.get(id);
      if (!existing) return undefined;
      const next = { ...existing, status, updatedAt: new Date().toISOString() };
      features.set(id, next);
      const slice = slices.get(next.sliceId);
      const done = [...features.values()]
        .filter((f) => f.sliceId === next.sliceId)
        .every((f) => f.status === "done");
      if (slice && done && slice.status !== "complete") {
        slices.set(slice.id, { ...slice, status: "complete", updatedAt: new Date().toISOString() });
      }
      return next;
    }),
    listAssertionsForFeature: vi.fn(async () => (withAssertions ? [{ id: "CA-1", milestoneId: milestone.id, title: "assert", assertion: "works", status: "pending", orderIndex: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] : [])),
    ensureFeatureAssertionLinked: vi.fn(async () => (withAssertions ? [{ id: "CA-1", milestoneId: milestone.id, title: "generated assert", assertion: "works", status: "pending", orderIndex: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] : [])),
    listGoalIdsForMission: vi.fn(async () => []),
    startValidatorRun: vi.fn(async () => ({ id: "VR-001", featureId: feature.id, milestoneId: milestone.id, sliceId: "SL-001", status: "running", triggerType: "task_completion", implementationAttempt: 1, validatorAttempt: 1, startedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })),
    completeValidatorRun: vi.fn(),
    recordValidatorFailures: vi.fn(),
    createGeneratedFixFeature: vi.fn(),
    triageFeature: vi.fn(),
    transitionLoopState: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };

  const autopilot = new MissionAutopilot(taskStore as any, missionStore);
  const loop = new MissionExecutionLoop({ taskStore, missionStore, rootDir: "/tmp", missionAutopilot: { notifyValidationComplete: async (featureId: string) => {
    const f = missionStore.getFeature(featureId);
    if (f?.taskId) await autopilot.handleTaskCompletion(f.taskId);
  } } });
  vi.spyOn(loop as any, "runValidation").mockImplementation(async () => ({
    result: await (runValidationImpl ?? (async () => ({ status: "pass" as const, assertions: [], summary: "ok" })))(),
    inspection: { workspaceStale: false },
  }));
  loop.start();

  const scheduler = new Scheduler(taskStore, {
    missionStore,
    missionAutopilot: autopilot,
    missionExecutionLoop: loop,
    pollIntervalMs: 60_000,
  });
  const activateSpy = vi.spyOn(scheduler, "activateNextPendingSlice").mockImplementation(async (missionId: string) => {
    if (missionId !== mission.id) return null;
    const next = slices.get("SL-002");
    slices.set("SL-002", { ...next, status: "active", updatedAt: new Date().toISOString() });
    return slices.get("SL-002");
  });

  const emitTaskMoved = async (to: string) => {
    task.column = to;
    const callbacks = handlers.get("task:moved") ?? [];
    await Promise.all(callbacks.map((cb) => cb({ task, from: "in-progress", to })));
  };

  scheduler.start();

  return { missionStore, loop, autopilot, scheduler, emitTaskMoved, slices, feature, activateSpy };
}

describe("mission autopilot end-to-end wiring", () => {
  it("runs validation and advances next slice when a linked task is moved to done", async () => {
    const h = makeHarness({ withAssertions: true });

    const processSpy = vi.spyOn(h.loop, "processTaskOutcome");
    await h.emitTaskMoved("done");
    await vi.waitFor(() => expect(h.missionStore.getFeatureByTaskId("FN-001")?.status).toBe("done"));

    expect(h.missionStore.getFeatureByTaskId("FN-001")?.status).toBe("done");
    expect(processSpy).toHaveBeenCalledWith("FN-001");
    expect(h.missionStore.startValidatorRun).toHaveBeenCalledWith("F-001", "task_completion", "FN-001");
    expect(h.missionStore.completeValidatorRun).toHaveBeenCalledWith("VR-001", "passed", "ok");
    expect(h.slices.get("SL-001").status).toBe("complete");
    expect(h.activateSpy).toHaveBeenCalledWith("M-001");
    expect(h.slices.get("SL-002").status).toBe("active");
    h.scheduler.stop();
  });

  it("advances slices in no-assertions pass path", async () => {
    const h = makeHarness({ withAssertions: false });

    await h.emitTaskMoved("done");
    await vi.waitFor(() => expect(h.slices.get("SL-001").status).toBe("complete"));

    expect(h.missionStore.startValidatorRun).not.toHaveBeenCalled();
    expect(h.slices.get("SL-001").status).toBe("complete");
    expect(h.activateSpy).toHaveBeenCalledWith("M-001");
    expect(h.slices.get("SL-002").status).toBe("active");
    h.scheduler.stop();
  });

  it("marks recovered done-task features complete after validation pass", async () => {
    const h = makeHarness({ withAssertions: true, initialFeatureStatus: "in-progress", initialTaskColumn: "done" });

    await h.loop.processTaskOutcome("FN-001");

    expect(h.missionStore.startValidatorRun).toHaveBeenCalledWith("F-001", "task_completion", "FN-001");
    expect(h.missionStore.completeValidatorRun).toHaveBeenCalledWith("VR-001", "passed", "ok");
    expect(h.missionStore.getFeature("F-001")?.status).toBe("done");
    expect(h.slices.get("SL-001").status).toBe("complete");
    expect(h.activateSpy).toHaveBeenCalledWith("M-001");
    h.scheduler.stop();
  });

  it("deduplicates concurrent processTaskOutcome triggers for the same feature", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = makeHarness({
      withAssertions: true,
      runValidationImpl: async () => {
        await gate;
        return { status: "pass", assertions: [], summary: "ok" };
      },
    });

    const first = h.loop.processTaskOutcome("FN-001");
    const second = h.loop.processTaskOutcome("FN-001");
    release?.();
    await Promise.all([first, second]);

    expect(h.missionStore.startValidatorRun).toHaveBeenCalledTimes(1);
    h.scheduler.stop();
  });

  it("emits mission error event when validator returns error", async () => {
    const h = makeHarness({
      withAssertions: true,
      runValidationImpl: async () => ({ status: "error", assertions: [], summary: "runtime unavailable" }),
    });

    await h.emitTaskMoved("done");
    await vi.waitFor(() => expect(h.missionStore.completeValidatorRun).toHaveBeenCalledWith("VR-001", "error", "runtime unavailable"));

    expect(h.missionStore.completeValidatorRun).toHaveBeenCalledWith("VR-001", "error", "runtime unavailable");
    expect(h.missionStore.logMissionEvent).toHaveBeenCalledWith(
      "M-001",
      "error",
      expect.stringContaining("Validation error"),
      expect.objectContaining({
        code: "validation_error",
        featureId: "F-001",
        error: "runtime unavailable",
      }),
    );
    h.scheduler.stop();
  });
});
