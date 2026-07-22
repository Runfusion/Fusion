import { describe, expect, it, vi } from "vitest";
import type { MissionFeature, MissionStore, TaskStore } from "@fusion/core";
import { Scheduler } from "../../scheduler.js";
import { MissionExecutionLoop } from "../../missions/mission-execution-loop.js";

function makeTaskStore(taskColumn: "done" | "archived" | "in-progress" = "done") {
  return {
    getTask: vi.fn(async (taskId: string) => ({
      id: taskId,
      title: "Mission task",
      description: "desc",
      column: taskColumn,
      status: taskColumn === "in-progress" ? "in-progress" : "done",
      sliceId: "SL-001",
      log: [],
    })),
    getRootDir: vi.fn(() => "/test/project"),
    getSettings: vi.fn(async () => ({})),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

function makeFeature(overrides: Partial<MissionFeature> = {}): MissionFeature {
  return {
    id: "F-001",
    sliceId: "SL-001",
    title: "Feature",
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

describe("FN-5715 reliability: mission validation trigger gap", () => {
  it("starts mission loop + processes completion when done task lands while loop is stopped", async () => {
    const feature = makeFeature();
    const missionStore = {
      getFeatureByTaskId: vi.fn(() => feature),
      listAssertionsForFeature: vi.fn(() => [{ id: "CA-1" }]),
      updateFeatureStatus: vi.fn(),
      getSlice: vi.fn(() => ({ id: "SL-001", milestoneId: "MS-001", status: "active" })),
      getMilestone: vi.fn(() => ({ id: "MS-001", missionId: "M-001" })),
    } as unknown as MissionStore;
    const missionExecutionLoop = {
      isRunning: vi.fn(() => false),
      start: vi.fn(),
      processTaskOutcome: vi.fn(async () => undefined),
    };

    const scheduler = new Scheduler(makeTaskStore("done"), {
      missionStore,
      missionExecutionLoop: missionExecutionLoop as any,
    });

    await (scheduler as any).handleMissionTaskMove("FN-001", "done");

    expect(missionExecutionLoop.start).toHaveBeenCalledTimes(1);
    expect(missionExecutionLoop.processTaskOutcome).toHaveBeenCalledWith("FN-001");
    expect(missionStore.updateFeatureStatus).not.toHaveBeenCalledWith("F-001", "done");
  });

  it("keeps assertion-linked completion path unchanged", async () => {
    const feature = makeFeature();
    const missionStore = {
      getFeatureByTaskId: vi.fn(() => feature),
      listAssertionsForFeature: vi.fn(() => []),
      reconcileSupersededGeneratedFixFeatures: vi.fn(async () => ({ supersededCount: 0, featureIds: [] as string[] })),
      listFeatures: vi.fn(async () => [feature]),
      updateFeatureStatus: vi.fn(),
      getSlice: vi.fn(() => ({ id: "SL-001", milestoneId: "MS-001", status: "active" })),
      getMilestone: vi.fn(() => ({ id: "MS-001", missionId: "M-001" })),
    } as unknown as MissionStore;

    const scheduler = new Scheduler(makeTaskStore("done"), {
      missionStore,
      missionExecutionLoop: {
        isRunning: vi.fn(() => true),
        start: vi.fn(),
        processTaskOutcome: vi.fn(async () => undefined),
      } as any,
    });

    await (scheduler as any).handleMissionTaskMove("FN-001", "done");

    expect(missionStore.updateFeatureStatus).toHaveBeenCalledWith("F-001", "done");
  });

  it("recovers implementing features whose task is already done at startup", async () => {
    const feature = makeFeature({ status: "done", lastValidatorStatus: undefined });
    const missionStore = {
      listMissions: vi.fn(() => [{ id: "M-001", status: "active" }]),
      getMissionWithHierarchy: vi.fn(() => ({
        id: "M-001",
        status: "active",
        milestones: [{ status: "active", slices: [{ status: "active", features: [feature] }] }],
      })),
      listAssertionsForFeature: vi.fn(() => [{ id: "CA-1" }]),
      getFeature: vi.fn(() => feature),
      transitionLoopState: vi.fn(),
      // FNXC:MissionReconcile 2026-07-07-08:21 real MissionStore method (mission-store.ts:3185); recoverActiveMissions calls it per slice and aborts recovery if missing — stub even when supersession isn't exercised.
      reconcileSupersededGeneratedFixFeatures: vi.fn(() => ({ supersededCount: 0, featureIds: [] as string[] })),
      listFeatures: vi.fn(async () => [feature]),
    };
    const taskStore = {
      getTask: vi.fn(async () => ({ id: "FN-001", column: "done" })),
    };

    const loop = new MissionExecutionLoop({
      missionStore: missionStore as any,
      taskStore: taskStore as any,
      rootDir: process.cwd(),
    });
    const processSpy = vi.spyOn(loop, "processTaskOutcome").mockResolvedValue(undefined);
    loop.start();

    await loop.recoverActiveMissions();

    expect(processSpy).toHaveBeenCalledWith("FN-001");
    loop.stop();
  });

  it("recovery trigger for done implementing feature is idempotent across subsequent passes", async () => {
    const feature = makeFeature({ status: "done", lastValidatorStatus: undefined, loopState: "implementing" });
    const missionStore = {
      listMissions: vi.fn(() => [{ id: "M-001", status: "active" }]),
      getMissionWithHierarchy: vi.fn(() => ({
        id: "M-001",
        status: "active",
        milestones: [{ status: "active", slices: [{ status: "active", features: [feature] }] }],
      })),
      listAssertionsForFeature: vi.fn(() => [{ id: "CA-1" }]),
      getFeature: vi.fn(() => feature),
      transitionLoopState: vi.fn(),
      // FNXC:MissionReconcile 2026-07-07-08:21 real MissionStore method (mission-store.ts:3185); recoverActiveMissions calls it per slice and aborts recovery if missing — stub even when supersession isn't exercised.
      reconcileSupersededGeneratedFixFeatures: vi.fn(() => ({ supersededCount: 0, featureIds: [] as string[] })),
      listFeatures: vi.fn(async () => [feature]),
    };
    const taskStore = {
      getTask: vi.fn(async () => ({ id: "FN-001", column: "done" })),
    };

    const loop = new MissionExecutionLoop({
      missionStore: missionStore as any,
      taskStore: taskStore as any,
      rootDir: process.cwd(),
    });
    const processSpy = vi.spyOn(loop, "processTaskOutcome").mockImplementation(async () => {
      feature.lastValidatorStatus = "passed";
      feature.loopState = "passed";
    });
    loop.start();

    await loop.recoverActiveMissions();
    await loop.recoverActiveMissions();

    expect(processSpy).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it("is idempotent for already-passed implementing features", async () => {
    const feature = makeFeature({ status: "done", lastValidatorStatus: "passed" });
    const missionStore = {
      listMissions: vi.fn(() => [{ id: "M-001", status: "active" }]),
      getMissionWithHierarchy: vi.fn(() => ({
        id: "M-001",
        status: "active",
        milestones: [{ status: "active", slices: [{ status: "active", features: [feature] }] }],
      })),
      listAssertionsForFeature: vi.fn(() => [{ id: "CA-1" }]),
      getFeature: vi.fn(() => feature),
      transitionLoopState: vi.fn(),
      // FNXC:MissionReconcile 2026-07-07-08:21 real MissionStore method (mission-store.ts:3185); recoverActiveMissions calls it per slice and aborts recovery if missing — stub even when supersession isn't exercised.
      reconcileSupersededGeneratedFixFeatures: vi.fn(() => ({ supersededCount: 0, featureIds: [] as string[] })),
      listFeatures: vi.fn(async () => [feature]),
    };
    const taskStore = {
      getTask: vi.fn(async () => ({ id: "FN-001", column: "done" })),
    };

    const loop = new MissionExecutionLoop({
      missionStore: missionStore as any,
      taskStore: taskStore as any,
      rootDir: process.cwd(),
    });
    const processSpy = vi.spyOn(loop, "processTaskOutcome").mockResolvedValue(undefined);
    loop.start();

    await loop.recoverActiveMissions();

    expect(processSpy).not.toHaveBeenCalled();
    loop.stop();
  });

  it("periodic recovery lazily ensures assertions and AI-validates zero-link legacy features", async () => {
    const feature = makeFeature({ status: "done", lastValidatorStatus: undefined, loopState: "implementing", acceptanceCriteria: "must pass" });
    const currentFeature = { ...feature };
    const linkedAssertions: Array<{ id: string }> = [];
    const missionStore = {
      listMissions: vi.fn(() => [{ id: "M-001", status: "active" }]),
      getMissionWithHierarchy: vi.fn(() => ({
        id: "M-001",
        status: "active",
        milestones: [{ status: "active", slices: [{ status: "active", features: [feature] }] }],
      })),
      getFeatureByTaskId: vi.fn(() => currentFeature),
      getFeature: vi.fn(() => currentFeature),
      updateFeatureStatus: vi.fn((featureId: string, status: "done") => ({ ...currentFeature, id: featureId, status })),
      updateFeature: vi.fn((_featureId: string, patch: Partial<MissionFeature>) => {
        Object.assign(currentFeature, patch);
        return { ...currentFeature };
      }),
      listAssertionsForFeature: vi.fn(() => linkedAssertions),
      ensureFeatureAssertionLinked: vi.fn(() => {
        if (linkedAssertions.length === 0) {
          linkedAssertions.push({ id: "CA-ENSURED" });
        }
        return linkedAssertions;
      }),
      startValidatorRun: vi.fn(() => ({ id: "VR-001", featureId: "F-001" })),
      completeValidatorRun: vi.fn(),
      getSlice: vi.fn(() => ({ id: "SL-001", milestoneId: "MS-001", status: "active" })),
      getMilestone: vi.fn(() => ({ id: "MS-001", missionId: "M-001" })),
      // resolveFeatureMission (reached via processTaskOutcome during recovery)
      // walks getSlice → getMilestone → getMission to gate on mission.status.
      // Without getMission the walk throws and recovery aborts before it can
      // ensure assertions / start the validator run this test asserts on.
      getMission: vi.fn(() => ({ id: "M-001", status: "active" })),
      logMissionEvent: vi.fn(),
      transitionLoopState: vi.fn(),
      // FNXC:MissionReconcile 2026-07-07-08:21 real MissionStore method (mission-store.ts:3185); recoverActiveMissions calls it per slice and aborts recovery if missing — stub even when supersession isn't exercised.
      reconcileSupersededGeneratedFixFeatures: vi.fn(() => ({ supersededCount: 0, featureIds: [] as string[] })),
      listFeatures: vi.fn(async () => [feature]),
      setFeatureCurrentTaskRunId: vi.fn(),
      getFailuresForRun: vi.fn(() => []),
    };
    const taskStore = {
      getTask: vi.fn(async () => ({ id: "FN-001", column: "done", status: "done" })),
      on: vi.fn(),
      off: vi.fn(),
    };

    const loop = new MissionExecutionLoop({
      missionStore: missionStore as any,
      taskStore: taskStore as any,
      rootDir: process.cwd(),
    });
    // FNXC:EngineTests 2026-07-17-11:50: runFeatureValidation destructures { result, inspection }.
    vi.spyOn(loop as any, "runValidation").mockResolvedValue({
      result: { status: "pass", summary: "ok" },
      inspection: { rootDir: process.cwd() },
    });
    loop.start();

    const periodicMaintenancePass = async () => loop.recoverActiveMissions();
    await periodicMaintenancePass();
    await periodicMaintenancePass();

    expect(missionStore.ensureFeatureAssertionLinked).toHaveBeenCalledWith("F-001");
    // FNXC:EngineTests 2026-07-17-11:45: startValidatorRun now threads the completing task id.
    expect(missionStore.startValidatorRun).toHaveBeenCalledWith("F-001", "task_completion", "FN-001");
    const noAssertionEvents = missionStore.logMissionEvent.mock.calls.filter(
      ([, type, , payload]) => type === "warning" && payload?.code === "validation_auto_passed_no_assertions",
    );
    expect(noAssertionEvents).toHaveLength(0);
    loop.stop();
  });

  it("keeps backfill optional because runtime lazy-ensure routes through validator", async () => {
    const feature = makeFeature({ status: "done", acceptanceCriteria: "must pass", loopState: "implementing" });
    const currentFeature = { ...feature };
    const linkedAssertions: Array<{ id: string }> = [];

    const missionStore = {
      listMissions: vi.fn(() => [{ id: "M-001", status: "active" }]),
      getMissionWithHierarchy: vi.fn(() => ({
        id: "M-001",
        status: "active",
        milestones: [{ status: "active", slices: [{ status: "active", features: [feature] }] }],
      })),
      getFeatureByTaskId: vi.fn(() => currentFeature),
      getFeature: vi.fn(() => currentFeature),
      updateFeatureStatus: vi.fn((_featureId: string, status: "done") => ({ ...currentFeature, status })),
      updateFeature: vi.fn((_featureId: string, patch: Partial<MissionFeature>) => {
        Object.assign(currentFeature, patch);
        return { ...currentFeature };
      }),
      listAssertionsForFeature: vi.fn(() => linkedAssertions),
      ensureFeatureAssertionLinked: vi.fn(() => {
        if (linkedAssertions.length === 0) {
          linkedAssertions.push({ id: "CA-001" });
        }
        return linkedAssertions;
      }),
      startValidatorRun: vi.fn(() => ({ id: "VR-001", featureId: "F-001" })),
      completeValidatorRun: vi.fn(),
      getSlice: vi.fn(() => ({ id: "SL-001", milestoneId: "MS-001", status: "active" })),
      getMilestone: vi.fn(() => ({ id: "MS-001", missionId: "M-001" })),
      // resolveFeatureMission (reached via processTaskOutcome during recovery)
      // walks getSlice → getMilestone → getMission to gate on mission.status.
      // Without getMission the walk throws and recovery aborts before it can
      // ensure assertions / start the validator run this test asserts on.
      getMission: vi.fn(() => ({ id: "M-001", status: "active" })),
      logMissionEvent: vi.fn(),
      transitionLoopState: vi.fn(),
      // FNXC:MissionReconcile 2026-07-07-08:21 real MissionStore method (mission-store.ts:3185); recoverActiveMissions calls it per slice and aborts recovery if missing — stub even when supersession isn't exercised.
      reconcileSupersededGeneratedFixFeatures: vi.fn(() => ({ supersededCount: 0, featureIds: [] as string[] })),
      listFeatures: vi.fn(async () => [feature]),
      setFeatureCurrentTaskRunId: vi.fn(),
      getFailuresForRun: vi.fn(() => []),
    };
    const taskStore = {
      getTask: vi.fn(async () => ({ id: "FN-001", column: "done", status: "done" })),
      on: vi.fn(),
      off: vi.fn(),
    };

    const loop = new MissionExecutionLoop({ missionStore: missionStore as any, taskStore: taskStore as any, rootDir: process.cwd() });
    // FNXC:EngineTests 2026-07-17-11:50: runFeatureValidation destructures { result, inspection }.
    vi.spyOn(loop as any, "runValidation").mockResolvedValue({
      result: { status: "pass", summary: "ok" },
      inspection: { rootDir: process.cwd() },
    });
    loop.start();

    await loop.recoverActiveMissions();

    expect(missionStore.ensureFeatureAssertionLinked).toHaveBeenCalledWith("F-001");
    // FNXC:EngineTests 2026-07-17-11:45: startValidatorRun now threads the completing task id.
    expect(missionStore.startValidatorRun).toHaveBeenCalledWith("F-001", "task_completion", "FN-001");
    const noAssertionEvents = missionStore.logMissionEvent.mock.calls.filter(
      ([, type, , payload]) => type === "warning" && payload?.code === "validation_auto_passed_no_assertions",
    );
    expect(noAssertionEvents).toHaveLength(0);
    expect(missionStore.completeValidatorRun).toHaveBeenCalledWith("VR-001", "passed", "ok");

    loop.stop();
  });
});
