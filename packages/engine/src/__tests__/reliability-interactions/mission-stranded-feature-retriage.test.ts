import { describe, expect, it, vi } from "vitest";
import type { MissionFeature, TaskStore } from "@fusion/core";
import { schedulerLog } from "../../logger.js";
import { Scheduler } from "../../scheduler.js";

function createTaskStore(tasks: any[] = []): TaskStore {
  return {
    listTasks: vi.fn(async () => tasks),
    getTask: vi.fn(async (taskId: string) => tasks.find((task) => task.id === taskId)),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getSettings: vi.fn(async () => ({})),
    getRootDir: vi.fn(() => "/test/project"),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

function feature(overrides: Partial<MissionFeature>): MissionFeature {
  return {
    id: "F-001",
    sliceId: "SL-001",
    title: "Feature one",
    status: "defined",
    loopState: "idle",
    implementationAttemptCount: 0,
    validatorAttemptCount: 0,
    taskId: undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as MissionFeature;
}

describe("FN-5754 reliability: mission stranded feature retriage", () => {
  it("triages stranded features in active autopilot slices and is idempotent", async () => {
    const features = [feature({ id: "F-001" })];
    const tasks: any[] = [];
    const missionStore = {
      listMissions: vi.fn(() => [{ id: "M-001", status: "active", autopilotEnabled: true }]),
      getMissionWithHierarchy: vi.fn(() => ({
        id: "M-001",
        status: "active",
        milestones: [{ id: "MS-001", slices: [{ id: "SL-001", status: "active", features }] }],
      })),
      triageFeature: vi.fn(async (featureId: string) => {
        const taskId = `FN-${featureId}`;
        tasks.push({ id: taskId, title: "Feature one", missionId: "M-001", sliceId: "SL-001", column: "todo", status: "queued" });
        features[0] = { ...features[0], taskId, status: "triaged" };
        return features[0];
      }),
      linkFeatureToTask: vi.fn(),
      updateFeatureStatus: vi.fn(),
      listAssertionsForFeature: vi.fn(() => []),
      reconcileSupersededGeneratedFixFeatures: vi.fn(async () => ({ supersededCount: 0, featureIds: [] as string[] })),
    };
    const store = createTaskStore(tasks);

    const scheduler = new Scheduler(store, { missionStore: missionStore as any });
    await scheduler.reconcileAllMissionFeatures();
    await scheduler.reconcileAllMissionFeatures();

    expect(missionStore.triageFeature).toHaveBeenCalledTimes(1);
    expect(features[0].taskId).toBe("FN-F-001");
  });

  it("keeps a terminal generated fix done across consecutive reconciles", async () => {
    const features = [feature({
      id: "F-FIX-DONE", status: "done", loopState: "passed", generatedFromFeatureId: "F-ORIGINAL",
      lastValidatorStatus: "passed", taskId: undefined,
    })];
    const missionStore = {
      listMissions: vi.fn(() => [{ id: "M-001", status: "active", autopilotEnabled: true }]),
      getMissionWithHierarchy: vi.fn(() => ({ id: "M-001", status: "active", milestones: [{ id: "MS-001", slices: [{ id: "SL-001", status: "active", features }] }] })),
      triageFeature: vi.fn(), linkFeatureToTask: vi.fn(), updateFeatureStatus: vi.fn(), listAssertionsForFeature: vi.fn(() => []),
      updateFeature: vi.fn(),
      reconcileSupersededGeneratedFixFeatures: vi.fn(async () => ({ supersededCount: 0, featureIds: [] as string[] })),
    };
    const scheduler = new Scheduler(createTaskStore([]), { missionStore: missionStore as any });
    await scheduler.reconcileAllMissionFeatures();
    await scheduler.reconcileAllMissionFeatures();

    expect(missionStore.updateFeature).not.toHaveBeenCalledWith("F-FIX-DONE", expect.objectContaining({ status: "blocked" }));
    expect(missionStore.triageFeature).not.toHaveBeenCalled();
    expect(features[0].status).toBe("done");
  });

  it("links title-matched existing tasks without recreating", async () => {
    const tasks = [{ id: "FN-001", title: "Feature one", missionId: "M-001", sliceId: "SL-001", column: "todo", status: "queued" }];
    const features = [feature({ id: "F-001", taskId: undefined, status: "triaged" })];
    const missionStore = {
      listMissions: vi.fn(() => [{ id: "M-001", status: "active", autopilotEnabled: true }]),
      getMissionWithHierarchy: vi.fn(() => ({
        id: "M-001",
        status: "active",
        milestones: [{ id: "MS-001", slices: [{ id: "SL-001", status: "active", features }] }],
      })),
      triageFeature: vi.fn(),
      linkFeatureToTask: vi.fn((featureId: string, taskId: string) => {
        features[0] = { ...features[0], id: featureId, taskId };
        return features[0];
      }),
      updateFeatureStatus: vi.fn(),
      listAssertionsForFeature: vi.fn(() => []),
      reconcileSupersededGeneratedFixFeatures: vi.fn(async () => ({ supersededCount: 0, featureIds: [] as string[] })),
    };

    const scheduler = new Scheduler(createTaskStore(tasks), { missionStore: missionStore as any });
    await scheduler.reconcileAllMissionFeatures();

    expect(missionStore.linkFeatureToTask).toHaveBeenCalledWith("F-001", "FN-001");
    expect(missionStore.triageFeature).not.toHaveBeenCalled();
  });

  it("resets and retriages inconsistent non-defined stranded features without title match", async () => {
    let features = [feature({ id: "F-001", status: "triaged", taskId: undefined })];
    const tasks: any[] = [];
    const missionStore = {
      listMissions: vi.fn(() => [{ id: "M-001", status: "active", autopilotEnabled: true }]),
      getMissionWithHierarchy: vi.fn(() => ({
        id: "M-001",
        status: "active",
        milestones: [{ id: "MS-001", slices: [{ id: "SL-001", status: "active", features }] }],
      })),
      triageFeature: vi.fn(async (featureId: string) => {
        const taskId = `FN-${featureId}`;
        tasks.push({ id: taskId, title: "Feature one", missionId: "M-001", sliceId: "SL-001", column: "todo", status: "queued" });
        features = [{ ...features[0], taskId, status: "triaged" }];
        return features[0];
      }),
      linkFeatureToTask: vi.fn(),
      updateFeature: vi.fn((featureId: string, updates: Partial<MissionFeature>) => {
        features = [{ ...features[0], id: featureId, ...updates }];
        return features[0];
      }),
      updateFeatureStatus: vi.fn(),
      listAssertionsForFeature: vi.fn(() => []),
      reconcileSupersededGeneratedFixFeatures: vi.fn(async () => ({ supersededCount: 0, featureIds: [] as string[] })),
    };

    const scheduler = new Scheduler(createTaskStore(tasks), { missionStore: missionStore as any });
    await scheduler.reconcileAllMissionFeatures();

    expect(missionStore.updateFeature).toHaveBeenCalledWith("F-001", {
      status: "defined",
      loopState: "idle",
      taskId: undefined,
    });
    expect(missionStore.triageFeature).toHaveBeenCalledWith("F-001");
    expect(features[0].taskId).toBe("FN-F-001");
  });

  it("blocks stranded generated fix features instead of recreating fix-loop tasks", async () => {
    let features = [feature({
      id: "F-FIX",
      title: "Fix: Fix: Mobile read/browse MVP",
      status: "triaged",
      generatedFromFeatureId: "F-ORIGINAL",
      taskId: undefined,
    })];
    const missionStore = {
      listMissions: vi.fn(() => [{ id: "M-001", status: "active", autopilotEnabled: true }]),
      getMissionWithHierarchy: vi.fn(() => ({
        id: "M-001",
        status: "active",
        milestones: [{ id: "MS-001", slices: [{ id: "SL-001", status: "active", features }] }],
      })),
      triageFeature: vi.fn(),
      linkFeatureToTask: vi.fn(),
      updateFeature: vi.fn((featureId: string, updates: Partial<MissionFeature>) => {
        features = [{ ...features[0], id: featureId, ...updates }];
        return features[0];
      }),
      updateFeatureStatus: vi.fn(),
      listAssertionsForFeature: vi.fn(() => []),
      reconcileSupersededGeneratedFixFeatures: vi.fn(async () => ({ supersededCount: 0, featureIds: [] as string[] })),
    };

    const scheduler = new Scheduler(createTaskStore([]), { missionStore: missionStore as any });
    await scheduler.reconcileAllMissionFeatures();

    expect(missionStore.triageFeature).not.toHaveBeenCalled();
    expect(missionStore.updateFeature).toHaveBeenCalledWith("F-FIX", {
      status: "blocked",
      loopState: "blocked",
      taskId: undefined,
    });
    expect(features[0].status).toBe("blocked");
  });

  it("blocks stranded validator-run generated features", async () => {
    let features = [feature({
      id: "F-FIX-RUN",
      title: "Generated follow-up",
      status: "triaged",
      generatedFromRunId: "MVR-001",
      taskId: undefined,
    })];
    const missionStore = {
      listMissions: vi.fn(() => [{ id: "M-001", status: "active", autopilotEnabled: true }]),
      getMissionWithHierarchy: vi.fn(() => ({
        id: "M-001",
        status: "active",
        milestones: [{ id: "MS-001", slices: [{ id: "SL-001", status: "active", features }] }],
      })),
      triageFeature: vi.fn(),
      linkFeatureToTask: vi.fn(),
      updateFeature: vi.fn((featureId: string, updates: Partial<MissionFeature>) => {
        features = [{ ...features[0], id: featureId, ...updates }];
        return features[0];
      }),
      updateFeatureStatus: vi.fn(),
      listAssertionsForFeature: vi.fn(() => []),
      reconcileSupersededGeneratedFixFeatures: vi.fn(async () => ({ supersededCount: 0, featureIds: [] as string[] })),
    };

    const scheduler = new Scheduler(createTaskStore([]), { missionStore: missionStore as any });
    await scheduler.reconcileAllMissionFeatures();

    expect(missionStore.triageFeature).not.toHaveBeenCalled();
    expect(features[0].status).toBe("blocked");
  });

  it("retriages user-authored Fix-prefixed features when no generated marker is present", async () => {
    let features = [feature({ id: "F-USER-FIX", title: "Fix: login redirect loop", status: "triaged", taskId: undefined })];
    const tasks: any[] = [];
    const missionStore = {
      listMissions: vi.fn(() => [{ id: "M-001", status: "active", autopilotEnabled: true }]),
      getMissionWithHierarchy: vi.fn(() => ({
        id: "M-001",
        status: "active",
        milestones: [{ id: "MS-001", slices: [{ id: "SL-001", status: "active", features }] }],
      })),
      triageFeature: vi.fn(async (featureId: string) => {
        const taskId = `FN-${featureId}`;
        tasks.push({ id: taskId, title: "Fix: login redirect loop", missionId: "M-001", sliceId: "SL-001", column: "todo", status: "queued" });
        features = [{ ...features[0], taskId, status: "triaged" }];
        return features[0];
      }),
      linkFeatureToTask: vi.fn(),
      updateFeature: vi.fn((featureId: string, updates: Partial<MissionFeature>) => {
        features = [{ ...features[0], id: featureId, ...updates }];
        return features[0];
      }),
      updateFeatureStatus: vi.fn(),
      listAssertionsForFeature: vi.fn(() => []),
      reconcileSupersededGeneratedFixFeatures: vi.fn(async () => ({ supersededCount: 0, featureIds: [] as string[] })),
    };

    const scheduler = new Scheduler(createTaskStore(tasks), { missionStore: missionStore as any });
    await scheduler.reconcileAllMissionFeatures();

    expect(missionStore.triageFeature).toHaveBeenCalledWith("F-USER-FIX");
    expect(features[0].taskId).toBe("FN-F-USER-FIX");
  });

  it("triages newly-created generated fix features that are still defined", async () => {
    let features = [feature({
      id: "F-NEW-FIX",
      title: "Fix: Mobile read/browse MVP",
      status: "defined",
      generatedFromFeatureId: "F-ORIGINAL",
      taskId: undefined,
    })];
    const tasks: any[] = [];
    const missionStore = {
      listMissions: vi.fn(() => [{ id: "M-001", status: "active", autopilotEnabled: true }]),
      getMissionWithHierarchy: vi.fn(() => ({
        id: "M-001",
        status: "active",
        milestones: [{ id: "MS-001", slices: [{ id: "SL-001", status: "active", features }] }],
      })),
      triageFeature: vi.fn(async (featureId: string) => {
        const taskId = `FN-${featureId}`;
        tasks.push({ id: taskId, title: "Fix: Mobile read/browse MVP", missionId: "M-001", sliceId: "SL-001", column: "todo", status: "queued" });
        features = [{ ...features[0], taskId, status: "triaged" }];
        return features[0];
      }),
      linkFeatureToTask: vi.fn(),
      updateFeature: vi.fn((featureId: string, updates: Partial<MissionFeature>) => {
        features = [{ ...features[0], id: featureId, ...updates }];
        return features[0];
      }),
      updateFeatureStatus: vi.fn(),
      listAssertionsForFeature: vi.fn(() => []),
      reconcileSupersededGeneratedFixFeatures: vi.fn(async () => ({ supersededCount: 0, featureIds: [] as string[] })),
    };

    const scheduler = new Scheduler(createTaskStore(tasks), { missionStore: missionStore as any });
    await scheduler.reconcileAllMissionFeatures();

    expect(missionStore.triageFeature).toHaveBeenCalledWith("F-NEW-FIX");
    expect(missionStore.updateFeature).not.toHaveBeenCalledWith("F-NEW-FIX", expect.objectContaining({ status: "blocked" }));
    expect(features[0].taskId).toBe("FN-F-NEW-FIX");
  });

  it("does not reopen done features that no longer have task links", async () => {
    const features = [feature({ id: "F-DONE", title: "Completed feature", status: "done", taskId: undefined })];
    const missionStore = {
      listMissions: vi.fn(() => [{ id: "M-001", status: "active", autopilotEnabled: true }]),
      getMissionWithHierarchy: vi.fn(() => ({
        id: "M-001",
        status: "active",
        milestones: [{ id: "MS-001", slices: [{ id: "SL-001", status: "active", features }] }],
      })),
      triageFeature: vi.fn(),
      linkFeatureToTask: vi.fn(),
      updateFeature: vi.fn(),
      updateFeatureStatus: vi.fn(),
      listAssertionsForFeature: vi.fn(() => []),
      reconcileSupersededGeneratedFixFeatures: vi.fn(async () => ({ supersededCount: 0, featureIds: [] as string[] })),
    };

    const scheduler = new Scheduler(createTaskStore([]), { missionStore: missionStore as any });
    await scheduler.reconcileAllMissionFeatures();

    expect(missionStore.triageFeature).not.toHaveBeenCalled();
    expect(missionStore.updateFeature).not.toHaveBeenCalled();
  });

  it("keeps ordinary done linked features in startup task-drift reconciliation", async () => {
    const tasks = [{ id: "FN-DONE", title: "Completed feature", missionId: "M-001", sliceId: "SL-001", column: "done", status: "queued" }];
    const features = [feature({ id: "F-DONE", title: "Completed feature", status: "done", taskId: "FN-DONE" })];
    const missionStore = {
      listMissions: vi.fn(() => [{ id: "M-001", status: "active", autopilotEnabled: true }]),
      getMissionWithHierarchy: vi.fn(() => ({
        id: "M-001",
        status: "active",
        milestones: [{ id: "MS-001", slices: [{ id: "SL-001", status: "active", features }] }],
      })),
      updateFeatureStatus: vi.fn(),
      listAssertionsForFeature: vi.fn(() => []),
      reconcileSupersededGeneratedFixFeatures: vi.fn(async () => ({ supersededCount: 0, featureIds: [] as string[] })),
    };
    const store = createTaskStore(tasks);

    const scheduler = new Scheduler(store, { missionStore: missionStore as any });
    await scheduler.reconcileAllMissionFeatures();

    expect(store.getTask).toHaveBeenCalledWith("FN-DONE");
  });

  it("keeps done generated fixes with live task ownership in startup task-drift reconciliation", async () => {
    const tasks = [{ id: "FN-GENERATED-DONE", title: "Fix: completed generated remediation", missionId: "M-001", sliceId: "SL-001", column: "done", status: "queued" }];
    const features = [feature({
      id: "F-GENERATED-DONE",
      title: "Fix: completed generated remediation",
      status: "done",
      generatedFromFeatureId: "F-SOURCE",
      taskId: "FN-GENERATED-DONE",
    })];
    const missionStore = {
      listMissions: vi.fn(() => [{ id: "M-001", status: "active", autopilotEnabled: true }]),
      getMissionWithHierarchy: vi.fn(() => ({
        id: "M-001",
        status: "active",
        milestones: [{ id: "MS-001", slices: [{ id: "SL-001", status: "active", features }] }],
      })),
      updateFeatureStatus: vi.fn(),
      listAssertionsForFeature: vi.fn(() => []),
      reconcileSupersededGeneratedFixFeatures: vi.fn(async () => ({ supersededCount: 0, featureIds: [] as string[] })),
    };
    const store = createTaskStore(tasks);

    const scheduler = new Scheduler(store, { missionStore: missionStore as any });
    await scheduler.reconcileAllMissionFeatures();

    expect(store.getTask).toHaveBeenCalledWith("FN-GENERATED-DONE");
  });

  it("does not block superseded done generated fixes during refreshed startup reconciliation", async () => {
    const supersededFix = feature({
      id: "F-SUPERSEDED-FIX",
      title: "Fix: already validated remediation",
      status: "done",
      loopState: "passed",
      lastValidatorStatus: "passed",
      generatedFromFeatureId: "F-SOURCE",
      taskId: undefined,
    });
    const remainingFeature = feature({ id: "F-REMAINING", title: "Remaining feature", status: "defined", taskId: undefined });
    let features = [supersededFix, remainingFeature];
    const tasks: any[] = [{
      id: "FN-STALE-FIX",
      title: "Fix: already validated remediation",
      missionId: "M-001",
      sliceId: "SL-001",
      column: "todo",
      status: "queued",
    }];
    const missionStore = {
      listMissions: vi.fn(() => [{ id: "M-001", status: "active", autopilotEnabled: true }]),
      getMissionWithHierarchy: vi.fn(() => ({
        id: "M-001",
        status: "active",
        milestones: [{ id: "MS-001", slices: [{ id: "SL-001", status: "active", features }] }],
      })),
      reconcileSupersededGeneratedFixFeatures: vi.fn(() => ({ supersededCount: 1, featureIds: ["F-SUPERSEDED-FIX"] })),
      listFeatures: vi.fn(() => features),
      getSlice: vi.fn(() => ({ id: "SL-001", milestoneId: "MS-001", status: "active", features })),
      triageFeature: vi.fn(async (featureId: string) => {
        const taskId = `FN-${featureId}`;
        tasks.push({ id: taskId, title: "Remaining feature", missionId: "M-001", sliceId: "SL-001", column: "todo", status: "queued" });
        features = features.map((candidate) => candidate.id === featureId ? { ...candidate, taskId, status: "triaged" } : candidate);
        return features.find((candidate) => candidate.id === featureId);
      }),
      linkFeatureToTask: vi.fn(),
      updateFeature: vi.fn(),
      updateFeatureStatus: vi.fn(),
      listAssertionsForFeature: vi.fn(() => []),
    };

    const scheduler = new Scheduler(createTaskStore(tasks), { missionStore: missionStore as any });
    await scheduler.reconcileAllMissionFeatures();

    expect(missionStore.updateFeature).not.toHaveBeenCalledWith("F-SUPERSEDED-FIX", expect.objectContaining({ status: "blocked" }));
    expect(missionStore.linkFeatureToTask).not.toHaveBeenCalledWith("F-SUPERSEDED-FIX", "FN-STALE-FIX");
    expect(missionStore.triageFeature).toHaveBeenCalledWith("F-REMAINING");
  });

  it("leaves non-autopilot and blocked features untouched", async () => {
    const autopilotOffFeature = feature({ id: "F-001", status: "defined", taskId: undefined });
    const blockedFeature = feature({ id: "F-002", status: "blocked", taskId: undefined, title: "Blocked feature" });
    const missionStore = {
      listMissions: vi.fn(() => [
        { id: "M-001", status: "active", autopilotEnabled: false, autoAdvance: false },
        { id: "M-002", status: "active", autopilotEnabled: true },
      ]),
      getMissionWithHierarchy: vi.fn((missionId: string) => missionId === "M-001"
        ? { id: missionId, status: "active", milestones: [{ id: "MS-001", slices: [{ id: "SL-001", status: "active", features: [autopilotOffFeature] }] }] }
        : { id: missionId, status: "active", milestones: [{ id: "MS-002", slices: [{ id: "SL-002", status: "active", features: [blockedFeature] }] }] }),
      triageFeature: vi.fn(),
      linkFeatureToTask: vi.fn(),
      updateFeatureStatus: vi.fn(),
    };

    const scheduler = new Scheduler(createTaskStore([]), { missionStore: missionStore as any });
    await scheduler.reconcileAllMissionFeatures();

    expect(missionStore.triageFeature).not.toHaveBeenCalled();
    expect(missionStore.linkFeatureToTask).not.toHaveBeenCalled();
  });

  it("emits mission:stranded-feature-triaged audit entries", async () => {
    const features = [feature({ id: "F-001" })];
    const tasks: any[] = [];
    const store = createTaskStore(tasks);
    const missionStore = {
      listMissions: vi.fn(() => [{ id: "M-001", status: "active", autopilotEnabled: true }]),
      getMissionWithHierarchy: vi.fn(() => ({
        id: "M-001",
        status: "active",
        milestones: [{ id: "MS-001", slices: [{ id: "SL-001", status: "active", features }] }],
      })),
      triageFeature: vi.fn(async () => {
        features[0] = { ...features[0], taskId: "FN-001", status: "triaged" };
        tasks.push({ id: "FN-001", title: "Feature one", missionId: "M-001", sliceId: "SL-001", column: "todo", status: "queued" });
        return features[0];
      }),
      linkFeatureToTask: vi.fn(),
      updateFeatureStatus: vi.fn(),
      listAssertionsForFeature: vi.fn(() => []),
      reconcileSupersededGeneratedFixFeatures: vi.fn(async () => ({ supersededCount: 0, featureIds: [] as string[] })),
    };

    const scheduler = new Scheduler(store, { missionStore: missionStore as any });
    await scheduler.reconcileAllMissionFeatures();

    expect((store.recordRunAuditEvent as any).mock.calls.some(([event]: any[]) => event.mutationType === "mission:stranded-feature-triaged" && event.metadata?.featureId === "F-001" && event.metadata?.taskId === "FN-001")).toBe(true);
  });
});


describe("FN-9013 regression: mission listFeatures receiver and containment", () => {
  class ReceiverDependentMissionStore {
    readonly db: { features: (sliceId: string) => MissionFeature[] | Promise<MissionFeature[]> };
    readonly listMissions: ReturnType<typeof vi.fn>;
    readonly getMissionWithHierarchy: ReturnType<typeof vi.fn>;
    readonly reconcileSupersededGeneratedFixFeatures = vi.fn(async () => ({ supersededCount: 0, featureIds: [] as string[] }));
    readonly triageFeature: ReturnType<typeof vi.fn>;
    readonly updateFeature = vi.fn();

    constructor(
      featuresBySlice: Record<string, MissionFeature[]>,
      options: { asyncListFeatures: boolean; failSliceId?: string; missions?: Array<{ id: string; status: string; autopilotEnabled: boolean }>; hierarchyByMission?: Record<string, unknown> },
    ) {
      this.db = {
        features: (sliceId) => {
          if (sliceId === options.failSliceId) throw new Error(`slice ${sliceId} failed`);
          const features = featuresBySlice[sliceId] ?? [];
          return options.asyncListFeatures ? Promise.resolve(features) : features;
        },
      };
      this.listMissions = vi.fn(() => options.missions ?? [{ id: "M-001", status: "active", autopilotEnabled: true }]);
      this.getMissionWithHierarchy = vi.fn((missionId: string) => options.hierarchyByMission?.[missionId] ?? {
        id: missionId,
        status: "active",
        milestones: [{ id: `MS-${missionId}`, slices: [{ id: "SL-001", status: "active", features: featuresBySlice["SL-001"] ?? [] }] }],
      });
      this.triageFeature = vi.fn(async (featureId: string) => {
        const candidate = Object.values(featuresBySlice).flat().find((item) => item.id === featureId)!;
        return { ...candidate, taskId: `FN-${featureId}`, status: "triaged" };
      });
    }

    listFeatures(sliceId: string): MissionFeature[] | Promise<MissionFeature[]> {
      return this.db.features(sliceId);
    }
  }

  it.each([true, false])("preserves the receiver for %s listFeatures stores and retriages stranded features", async (asyncListFeatures) => {
    const features = { "SL-001": [feature({ id: asyncListFeatures ? "F-ASYNC" : "F-SYNC" })] };
    const missionStore = new ReceiverDependentMissionStore(features, { asyncListFeatures });
    const errorSpy = vi.spyOn(schedulerLog, "error").mockImplementation(() => {});

    try {
      const fixed = await new Scheduler(createTaskStore(), { missionStore: missionStore as any }).reconcileAllMissionFeatures();

      expect(missionStore.triageFeature).toHaveBeenCalledWith(features["SL-001"][0].id);
      expect(fixed).toBeGreaterThan(0);
      expect(errorSpy.mock.calls.some(([, error]) => error instanceof TypeError)).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("falls back to hierarchy features when the optional capability is absent", async () => {
    const features = [feature({ id: "F-FALLBACK" })];
    const missionStore = {
      listMissions: vi.fn(() => [{ id: "M-001", status: "active", autopilotEnabled: true }]),
      getMissionWithHierarchy: vi.fn(() => ({
        id: "M-001",
        status: "active",
        milestones: [{ id: "MS-001", slices: [{ id: "SL-001", status: "active", features }] }],
      })),
      reconcileSupersededGeneratedFixFeatures: vi.fn(async () => ({ supersededCount: 0, featureIds: [] as string[] })),
      triageFeature: vi.fn(async () => ({ ...features[0], taskId: "FN-FALLBACK", status: "triaged" })),
    };

    await new Scheduler(createTaskStore(), { missionStore: missionStore as any }).reconcileAllMissionFeatures();

    expect(missionStore.triageFeature).toHaveBeenCalledWith("F-FALLBACK");
  });

  it("logs one failing slice and continues remaining slices and missions", async () => {
    const featuresBySlice = {
      "SL-001": [feature({ id: "F-FAILED", sliceId: "SL-001" })],
      "SL-002": [feature({ id: "F-SECOND-SLICE", sliceId: "SL-002" })],
      "SL-003": [feature({ id: "F-SECOND-MISSION", sliceId: "SL-003" })],
      "SL-004": [feature({ id: "F-SECOND-MISSION-SECOND-SLICE", sliceId: "SL-004" })],
    };
    const missionStore = new ReceiverDependentMissionStore(featuresBySlice, {
      asyncListFeatures: true,
      failSliceId: "SL-001",
      missions: [
        { id: "M-001", status: "active", autopilotEnabled: true },
        { id: "M-002", status: "active", autopilotEnabled: true },
      ],
      hierarchyByMission: {
        "M-001": { id: "M-001", status: "active", milestones: [{ id: "MS-001", slices: [{ id: "SL-001", status: "active", features: featuresBySlice["SL-001"] }, { id: "SL-002", status: "active", features: featuresBySlice["SL-002"] }] }] },
        "M-002": { id: "M-002", status: "active", milestones: [{ id: "MS-002", slices: [{ id: "SL-003", status: "active", features: featuresBySlice["SL-003"] }, { id: "SL-004", status: "active", features: featuresBySlice["SL-004"] }] }] },
      },
    });
    const errorSpy = vi.spyOn(schedulerLog, "error").mockImplementation(() => {});

    try {
      const fixed = await new Scheduler(createTaskStore(), { missionStore: missionStore as any }).reconcileAllMissionFeatures();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("SL-001"), expect.any(Error));
      expect(missionStore.triageFeature).toHaveBeenCalledWith("F-SECOND-SLICE");
      expect(missionStore.triageFeature).toHaveBeenCalledWith("F-SECOND-MISSION");
      expect(missionStore.triageFeature).toHaveBeenCalledWith("F-SECOND-MISSION-SECOND-SLICE");
      expect(missionStore.triageFeature).not.toHaveBeenCalledWith("F-FAILED");
      expect(fixed).toBeGreaterThan(0);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
