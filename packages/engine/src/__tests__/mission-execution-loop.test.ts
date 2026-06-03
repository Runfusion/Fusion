/**
 * MissionExecutionLoop unit tests.
 *
 * Tests the validation cycle orchestration class with mocked TaskStore, MissionStore,
 * and AI agent (createFnAgent/promptWithFallback).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TEST_MODE_RESOLVED } from "@fusion/core";
import type {
  Mission,
  Milestone,
  Slice,
  MissionFeature,
  MissionContractAssertion,
  MissionValidatorRun,
} from "@fusion/core";

// ── Mock AI dependencies ─────────────────────────────────────────────────────
// Shared mock state that can be configured per test
const mockSessionHolder: {
  session: {
    state: { messages: Array<{ role: string; content: string }> };
    dispose: ReturnType<typeof vi.fn>;
  };
} = {
  session: {
    state: { messages: [] },
    dispose: vi.fn(),
  },
};

// Mock the pi module before MissionExecutionLoop is imported
vi.mock("../pi.js", () => {
  const createFnAgent = vi.fn(() => Promise.resolve({ session: mockSessionHolder.session }));
  const promptWithFallback = vi.fn().mockResolvedValue(undefined);
  return { createFnAgent, promptWithFallback };
});

vi.mock("../logger.js", () => ({
  createLogger: vi.fn((_name: string) => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock("../agent-session-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent-session-helpers.js")>();
  return {
    ...actual,
    createResolvedAgentSession: vi.fn(async () => ({
      session: mockSessionHolder.session as any,
      sessionFile: undefined,
      runtimeId: "test-runtime",
      wasConfigured: true,
    })),
  };
});

// Helper to reset mock session state
function resetMockSession() {
  mockSessionHolder.session.state.messages = [];
  mockSessionHolder.session.dispose = vi.fn();
}

// Import AFTER vi.mock so the mock is applied
import { createResolvedAgentSession } from "../agent-session-helpers.js";
import { MissionExecutionLoop, loopLog } from "../mission-execution-loop.js";

// ── Mock Factories ──────────────────────────────────────────────────────────

function createMockMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "M-TEST1",
    title: "Test Mission",
    status: "active",
    interviewState: "not_started",
    autoAdvance: true,
    autopilotEnabled: true,
    autopilotState: "inactive",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockMilestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: "MS-001",
    missionId: "M-TEST1",
    title: "Test Milestone",
    status: "active",
    orderIndex: 0,
    interviewState: "not_started",
    dependencies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockSlice(overrides: Partial<Slice> = {}): Slice {
  return {
    id: "SL-001",
    milestoneId: "MS-001",
    title: "Test Slice",
    status: "active",
    planState: "not_started",
    orderIndex: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockFeature(overrides: Partial<MissionFeature> = {}): MissionFeature {
  return {
    id: "F-001",
    sliceId: "SL-001",
    title: "Test Feature",
    status: "defined",
    loopState: "idle",
    implementationAttemptCount: 0,
    validatorAttemptCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockValidatorRun(overrides: Partial<MissionValidatorRun> = {}): MissionValidatorRun {
  return {
    id: "VR-001",
    featureId: "F-001",
    milestoneId: "MS-001",
    sliceId: "SL-001",
    status: "running",
    triggerType: "task_completion",
    implementationAttempt: 1,
    validatorAttempt: 1,
    startedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockMissionStore() {
  const missions = new Map<string, Mission>();
  const features = new Map<string, MissionFeature>();
  const assertionsByFeature = new Map<string, Array<{ id: string; milestoneId: string; title: string; assertion: string; status: "pending" | "passed" | "failed" | "blocked"; orderIndex: number; createdAt: string; updatedAt: string; sourceFeatureId?: string }>>();
  const validatorRuns = new Map<string, MissionValidatorRun>();

  const store = {
    // Mission methods
    getMission: vi.fn((id: string) => missions.get(id)),
    listMissions: vi.fn(() => [...missions.values()]),
    updateMission: vi.fn((id: string, updates: Partial<Mission>) => {
      const existing = missions.get(id);
      if (!existing) throw new Error(`Mission ${id} not found`);
      const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
      missions.set(id, updated);
      return updated;
    }),
    getMissionWithHierarchy: vi.fn((id: string) => {
      const mission = missions.get(id);
      if (!mission) return undefined;
      return {
        ...mission,
        milestones: [createMockMilestone({ missionId: id })],
      };
    }),
    logMissionEvent: vi.fn(),

    // Feature methods
    getFeature: vi.fn((id: string) => features.get(id)),
    getFeatureByTaskId: vi.fn((taskId: string) => {
      for (const feature of features.values()) {
        if (feature.taskId === taskId) return feature;
      }
      return undefined;
    }),
    listFeatures: vi.fn(() => [...features.values()]),
    updateFeatureStatus: vi.fn((id: string, status: MissionFeature["status"]) => {
      const feature = features.get(id);
      if (!feature) throw new Error(`Feature ${id} not found`);
      const updated = { ...feature, status, updatedAt: new Date().toISOString() };
      features.set(id, updated);
      return updated;
    }),
    updateFeature: vi.fn((id: string, updates: Partial<MissionFeature>) => {
      const feature = features.get(id);
      if (!feature) throw new Error(`Feature ${id} not found`);
      const updated = { ...feature, ...updates, updatedAt: new Date().toISOString() };
      features.set(id, updated);
      return updated;
    }),
    transitionLoopState: vi.fn((id: string, newState: MissionFeature["loopState"]) => {
      const feature = features.get(id);
      if (!feature) throw new Error(`Feature ${id} not found`);
      const updated = { ...feature, loopState: newState, updatedAt: new Date().toISOString() };
      features.set(id, updated);
      return updated;
    }),
    listAssertionsForFeature: vi.fn((featureId: string) => assertionsByFeature.get(featureId) ?? []),
    ensureFeatureAssertionLinked: vi.fn((featureId: string) => {
      const feature = features.get(featureId);
      if (!feature) {
        throw new Error(`Feature ${featureId} not found`);
      }
      if ((assertionsByFeature.get(featureId) ?? []).length === 0) {
        store._addFeatureWithManagedAssertion(feature);
      }
      return assertionsByFeature.get(featureId) ?? [];
    }),
    getAssertionsForFeature: vi.fn((featureId: string) => assertionsByFeature.get(featureId) ?? []),
    getSlice: vi.fn((id: string) => {
      // Return a mock slice with milestoneId for the hierarchy
      return createMockSlice({ id });
    }),
    getMilestone: vi.fn((id: string) => {
      // Return a mock milestone with missionId for the hierarchy
      return createMockMilestone({ id });
    }),

    // Validator run methods
    startValidatorRun: vi.fn((featureId: string, _triggerType?: string, _taskId?: string) => {
      const run = createMockValidatorRun({ featureId });
      validatorRuns.set(run.id, run);
      return run;
    }),
    listStaleRunningValidatorRuns: vi.fn((_maxAgeMs: number) => [...validatorRuns.values()].filter((run) => run.status === "running")),
    reapValidatorRun: vi.fn((id: string, reason: string) => {
      const run = validatorRuns.get(id);
      if (!run) {
        throw new Error(`Validator run ${id} not found`);
      }
      if (run.status !== "running") {
        return run;
      }
      const updated = {
        ...run,
        status: "error" as const,
        summary: reason,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      validatorRuns.set(id, updated);

      const feature = features.get(run.featureId);
      if (feature) {
        features.set(run.featureId, {
          ...feature,
          loopState: "needs_fix",
          lastValidatorStatus: "error",
          updatedAt: new Date().toISOString(),
        });
      }

      return updated;
    }),
    getValidatorRun: vi.fn((id: string) => validatorRuns.get(id)),
    completeValidatorRun: vi.fn((id: string, status: MissionValidatorRun["status"], summary?: string) => {
      const run = validatorRuns.get(id);
      if (!run) throw new Error(`Validator run ${id} not found`);
      if (run.status !== "running") {
        throw new Error(`Validator run ${id} is not in 'running' status`);
      }
      const updated = {
        ...run,
        status,
        summary,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      validatorRuns.set(id, updated);

      const feature = features.get(run.featureId);
      if (feature) {
        if (status === "passed") {
          features.set(run.featureId, {
            ...feature,
            loopState: "passed",
            lastValidatorStatus: "passed",
            updatedAt: new Date().toISOString(),
          });
        } else if (status === "failed") {
          features.set(run.featureId, {
            ...feature,
            loopState: "needs_fix",
            lastValidatorStatus: "failed",
            updatedAt: new Date().toISOString(),
          });
        } else if (status === "blocked") {
          features.set(run.featureId, {
            ...feature,
            loopState: "blocked",
            lastValidatorStatus: "blocked",
            updatedAt: new Date().toISOString(),
          });
        } else if (status === "error") {
          features.set(run.featureId, {
            ...feature,
            loopState: "validating",
            lastValidatorStatus: "error",
            updatedAt: new Date().toISOString(),
          });
        }
      }

      return updated;
    }),
    recordValidatorFailures: vi.fn(() => []),
    createGeneratedFixFeature: vi.fn((sourceFeatureId: string, runId: string, _failedAssertionIds: string[]) => {
      const sourceFeature = features.get(sourceFeatureId);
      if (!sourceFeature) throw new Error(`Feature ${sourceFeatureId} not found`);

      const fixFeature = createMockFeature({
        id: `FIX-${sourceFeatureId}`,
        sliceId: sourceFeature.sliceId,
        title: `Fix for ${sourceFeature.title}`,
        taskId: `TASK-FIX-${sourceFeatureId}`,
        generatedFromFeatureId: sourceFeatureId,
        generatedFromRunId: runId,
        loopState: "implementing",
        implementationAttemptCount: 0,
      });
      features.set(fixFeature.id, fixFeature);

      const updatedSource = {
        ...sourceFeature,
        implementationAttemptCount: (sourceFeature.implementationAttemptCount ?? 0) + 1,
        loopState: "implementing" as const,
        updatedAt: new Date().toISOString(),
      };
      features.set(sourceFeatureId, updatedSource);

      return fixFeature;
    }),
    triageFeature: vi.fn(async (featureId: string) => {
      const feature = features.get(featureId);
      if (!feature) throw new Error(`Feature ${featureId} not found`);
      // Simulate triage by updating the feature
      const updated = { ...feature, status: "triaged" as const, updatedAt: new Date().toISOString() };
      features.set(featureId, updated);
      return updated;
    }),

    // Event emitter
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),

    // Internal setters for test setup
    _setMission: (m: Mission) => missions.set(m.id, m),
    _setFeature: (f: MissionFeature) => features.set(f.id, f),
    _setAssertionsForFeature: (featureId: string, assertions: Array<{ id: string; milestoneId: string; title: string; assertion: string; status: "pending" | "passed" | "failed" | "blocked"; orderIndex: number; createdAt: string; updatedAt: string; sourceFeatureId?: string }>) => {
      assertionsByFeature.set(featureId, assertions);
    },
    _addFeatureWithManagedAssertion: (f: MissionFeature) => {
      features.set(f.id, f);
      const now = new Date().toISOString();
      assertionsByFeature.set(f.id, [{
        id: `CA-${f.id}`,
        milestoneId: "MS-001",
        title: f.title,
        assertion: f.acceptanceCriteria || f.description || `Verify implementation of: ${f.title}`,
        status: "pending",
        orderIndex: 0,
        createdAt: now,
        updatedAt: now,
        sourceFeatureId: f.id,
      }]);
    },
    _getValidatorRun: (id: string) => validatorRuns.get(id),
    _clear: () => {
      missions.clear();
      features.clear();
      assertionsByFeature.clear();
      validatorRuns.clear();
    },
  };

  return store;
}

function createMockTaskStore() {
  const tasks = new Map<string, {
    id: string;
    title?: string;
    description?: string;
    log?: Array<{ action?: string }>;
    column?: string;
    missionId?: string;
    sliceId?: string;
    status?: string;
    assignedAgentId?: string;
    validatorModelProvider?: string;
    validatorModelId?: string;
  }>();

  const store = {
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    createTask: vi.fn(async (input: { title?: string; description?: string; column?: string; missionId?: string; sliceId?: string }) => {
      const id = `KB-${tasks.size + 1}`;
      const task = { id, ...input };
      tasks.set(id, task);
      return task;
    }),
    moveTask: vi.fn(async () => {}),
    updateTask: vi.fn(async () => {}),
    getSettings: vi.fn().mockResolvedValue({
      missionStaleThresholdMs: 600_000,
      missionMaxTaskRetries: 3,
    }),
    recordRunAuditEvent: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),

    _setTask: (t: {
      id: string;
      title?: string;
      description?: string;
      log?: Array<{ action?: string }>;
      column?: string;
      missionId?: string;
      sliceId?: string;
      status?: string;
      assignedAgentId?: string;
      validatorModelProvider?: string;
      validatorModelId?: string;
    }) => tasks.set(t.id, t),
    _clear: () => tasks.clear(),
  };

  return store;
}

// Helper to make mock session with AI response
function makeMockSession(responseContent: string) {
  return {
    state: {
      messages: [
        { role: "user", content: "Validate this" },
        { role: "assistant", content: responseContent },
      ],
    },
    dispose: vi.fn(),
  };
}

// Helper to make assertions
function makeAssertions(count: number): MissionContractAssertion[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `CA-${i + 1}`,
    milestoneId: "MS-001",
    title: `Assertion ${i + 1}`,
    assertion: `Should do thing ${i + 1}`,
    status: "pending" as const,
    orderIndex: i,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
}

function expectNoValidationBoardTaskMutation(taskStore: ReturnType<typeof createMockTaskStore>) {
  expect(taskStore.updateTask).not.toHaveBeenCalled();
  expect(taskStore.moveTask).not.toHaveBeenCalled();
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("MissionExecutionLoop", () => {
  let loop: MissionExecutionLoop;
  let missionStore: ReturnType<typeof createMockMissionStore>;
  let taskStore: ReturnType<typeof createMockTaskStore>;
  let agentStore: { getAgent: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    missionStore = createMockMissionStore();
    taskStore = createMockTaskStore();
    agentStore = {
      getAgent: vi.fn(),
    };

    vi.mocked(createResolvedAgentSession).mockReset();
    vi.mocked(createResolvedAgentSession).mockResolvedValue({
      session: mockSessionHolder.session as any,
      sessionFile: undefined,
      runtimeId: "test-runtime",
      wasConfigured: true,
    });

    const mission = createMockMission();
    missionStore._setMission(mission);

    // Reset mock session state before each test
    resetMockSession();
  });

  afterEach(() => {
    loop?.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────

  describe("start/stop", () => {
    it("should start and be running", () => {
      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });

      loop.start();
      expect(loop.isRunning()).toBe(true);
    });

    it("should be idempotent on start", () => {
      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });

      loop.start();
      loop.start(); // Should not throw
      expect(loop.isRunning()).toBe(true);
    });

    it("should stop cleanly", () => {
      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });

      loop.start();
      loop.stop();
      expect(loop.isRunning()).toBe(false);
    });

    it("should be idempotent on stop", () => {
      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });

      loop.stop(); // Should not throw
      expect(loop.isRunning()).toBe(false);
    });
  });

  describe("recoverActiveMissions stranded done features", () => {
    function wireHierarchy(slice: Slice, features: MissionFeature[]) {
      missionStore.getMissionWithHierarchy = vi.fn((id: string) => {
        const mission = missionStore.getMission(id);
        if (!mission) return undefined;
        return {
          ...mission,
          milestones: [
            {
              ...createMockMilestone({ missionId: id }),
              slices: [{ ...slice, features }],
            },
          ],
        };
      }) as any;
    }

    it("re-validates a done feature stranded in 'implementing' with no linked task", async () => {
      // Regression: a feature marked "done" whose loopState never left
      // "implementing" (and which was never validated and has no board task)
      // can never validate on its own — the prior recovery loop only re-drove
      // implementing features that still had a taskId. The slice-completion
      // gate then refuses to count it, wedging the whole mission. Recovery
      // must re-drive validation so the slice can eventually complete.
      const mission = createMockMission({ id: "M-STRAND", status: "active" });
      missionStore._setMission(mission);

      const slice = createMockSlice({ id: "SL-STRAND", milestoneId: "MS-001", status: "active" });
      const orphan = createMockFeature({
        id: "F-STRAND",
        sliceId: "SL-STRAND",
        status: "done",
        loopState: "implementing",
        lastValidatorStatus: undefined,
        taskId: undefined,
      });
      (missionStore as any)._addFeatureWithManagedAssertion(orphan);
      wireHierarchy(slice, [missionStore.getFeature("F-STRAND") as MissionFeature]);

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      const result = await loop.recoverActiveMissions();

      expect(missionStore.startValidatorRun).toHaveBeenCalledWith("F-STRAND", "task_completion");
      expect(result.recoveredCount).toBeGreaterThanOrEqual(1);
    });

    it("leaves an already-validated done feature untouched", async () => {
      const mission = createMockMission({ id: "M-OK", status: "active" });
      missionStore._setMission(mission);

      const slice = createMockSlice({ id: "SL-OK", milestoneId: "MS-001", status: "active" });
      const validated = createMockFeature({
        id: "F-OK",
        sliceId: "SL-OK",
        status: "done",
        loopState: "passed",
        lastValidatorStatus: "passed",
        taskId: undefined,
      });
      (missionStore as any)._addFeatureWithManagedAssertion(validated);
      wireHierarchy(slice, [missionStore.getFeature("F-OK") as MissionFeature]);

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      await loop.recoverActiveMissions();

      expect(missionStore.startValidatorRun).not.toHaveBeenCalled();
    });
  });

  describe("reapStaleValidatorRuns", () => {
    it("reaps stale runs across trigger types and records audit metadata", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));

      const mission = createMockMission({ id: "M-001" });
      missionStore._setMission(mission);
      const featureManual = createMockFeature({ id: "F-manual", taskId: "FN-manual", loopState: "validating" });
      const featureAuto = createMockFeature({ id: "F-auto", taskId: "FN-auto", loopState: "validating" });
      missionStore._setFeature(featureManual);
      missionStore._setFeature(featureAuto);
      missionStore.getMilestone = vi.fn(() => createMockMilestone({ id: "MS-001", missionId: mission.id }));
      missionStore.listStaleRunningValidatorRuns = vi.fn(() => [
        createMockValidatorRun({ id: "VR-manual", featureId: featureManual.id, triggerType: "manual", startedAt: "2026-06-01T11:40:00.000Z" }),
        createMockValidatorRun({ id: "VR-auto", featureId: featureAuto.id, triggerType: "auto", startedAt: "2026-06-01T11:50:00.000Z" }),
      ]);
      missionStore.reapValidatorRun = vi.fn((id: string, reason: string) => ({
        ...createMockValidatorRun({
          id,
          featureId: id === "VR-manual" ? featureManual.id : featureAuto.id,
          triggerType: id === "VR-manual" ? "manual" : "auto",
          startedAt: id === "VR-manual" ? "2026-06-01T11:40:00.000Z" : "2026-06-01T11:50:00.000Z",
        }),
        status: "error",
        summary: reason,
        completedAt: "2026-06-01T12:00:00.000Z",
        updatedAt: "2026-06-01T12:00:00.000Z",
      }));

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });

      const result = await loop.reapStaleValidatorRuns(15 * 60 * 1000);

      expect(result).toEqual({ reapedCount: 2 });
      expect(missionStore.reapValidatorRun).toHaveBeenCalledTimes(2);
      expect(taskStore.recordRunAuditEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
        agentId: "store",
        runId: "validator-run-reaper",
        domain: "database",
        mutationType: "mission:validator-run-reaped",
        target: "VR-manual",
        metadata: expect.objectContaining({
          runId: "VR-manual",
          featureId: featureManual.id,
          missionId: mission.id,
          triggerType: "manual",
          elapsedMs: 20 * 60 * 1000,
        }),
      }));
      expect(taskStore.recordRunAuditEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
        target: "VR-auto",
        metadata: expect.objectContaining({
          runId: "VR-auto",
          featureId: featureAuto.id,
          missionId: mission.id,
          triggerType: "auto",
          elapsedMs: 10 * 60 * 1000,
        }),
      }));
    });

    it("skips stale runs still actively owned in-process", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));

      const feature = createMockFeature({ id: "F-live", taskId: "FN-live", loopState: "implementing" });
      missionStore._setFeature(feature);
      missionStore.listStaleRunningValidatorRuns = vi.fn(() => [
        createMockValidatorRun({ id: "VR-live", featureId: feature.id, startedAt: "2026-06-01T11:30:00.000Z" }),
      ]);

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      (loop as any).activeValidations.add(feature.id);

      const reaped = await loop.reapStaleValidatorRuns(15 * 60 * 1000);

      expect(reaped).toEqual({ reapedCount: 0 });
      expect(missionStore.reapValidatorRun).not.toHaveBeenCalled();
      expect(taskStore.recordRunAuditEvent).not.toHaveBeenCalled();
    });

    it("isolates per-run reap failures", async () => {
      missionStore.listStaleRunningValidatorRuns = vi.fn(() => [
        createMockValidatorRun({ id: "VR-bad", featureId: "F-bad" }),
        createMockValidatorRun({ id: "VR-good", featureId: "F-good" }),
      ]);
      missionStore.reapValidatorRun = vi.fn((id: string) => {
        if (id === "VR-bad") {
          throw new Error("boom");
        }
        return {
          ...createMockValidatorRun({ id, featureId: "F-good" }),
          status: "error",
          summary: "reaped",
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });

      const result = await loop.reapStaleValidatorRuns(15 * 60 * 1000);

      expect(result).toEqual({ reapedCount: 1 });
      expect(missionStore.reapValidatorRun).toHaveBeenCalledTimes(2);
      expect(taskStore.recordRunAuditEvent).toHaveBeenCalledTimes(1);
    });
  });

  // ── processTaskOutcome ───────────────────────────────────────────────────

  describe("processTaskOutcome", () => {
    it("should skip if loop is not running", async () => {
      const feature = createMockFeature({ loopState: "implementing", taskId: "FN-001" });
      missionStore._setFeature(feature);
      taskStore._setTask({ id: "FN-001" });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      // Don't start - loop is not running

      await loop.processTaskOutcome("FN-001");

      // Should not start validator run
      expect(missionStore.startValidatorRun).not.toHaveBeenCalled();
    });

    it("should skip if task has no linked feature", async () => {
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(undefined);

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      await loop.processTaskOutcome("FN-999");

      expect(missionStore.startValidatorRun).not.toHaveBeenCalled();
    });

    it("should skip if feature is not in implementing state", async () => {
      const feature = createMockFeature({ loopState: "idle", taskId: "FN-001" });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      await loop.processTaskOutcome("FN-001");

      expect(missionStore.startValidatorRun).not.toHaveBeenCalled();
      expect(missionStore.logMissionEvent).toHaveBeenCalledWith(
        expect.any(String),
        "warning",
        expect.stringContaining("Validation skipped"),
        expect.objectContaining({
          code: "validation_skipped_loop_state",
          featureId: "F-001",
          taskId: "FN-001",
          loopState: "idle",
        }),
      );
    });

    it("requeues needs_fix features back through validation", async () => {
      const assertions = makeAssertions(1);
      const response = JSON.stringify({
        status: "pass",
        assertions: [{ assertionId: "CA-1", passed: true, message: "OK" }],
        summary: "Recovered validation passed",
      });

      mockSessionHolder.session.state.messages = [
        { role: "user", content: "Validate this" },
        { role: "assistant", content: response },
      ];

      const feature = createMockFeature({ loopState: "needs_fix", taskId: "FN-NEEDS-FIX" });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue(assertions);
      taskStore._setTask({ id: "FN-NEEDS-FIX", title: "Test", description: "Implementation", log: [], column: "done" });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      await loop.processTaskOutcome("FN-NEEDS-FIX");

      expect(missionStore.transitionLoopState).toHaveBeenCalledWith("F-001", "implementing");
      expect(missionStore.startValidatorRun).toHaveBeenCalled();
      expect(missionStore.completeValidatorRun).toHaveBeenCalledWith(expect.any(String), "passed", "Recovered validation passed");
    });

    it("lazy-ensures a managed assertion and routes zero-assertion features through validation", async () => {
      const feature = createMockFeature({
        id: "F-001",
        loopState: "implementing",
        taskId: "FN-001",
        title: "Feature from prose",
        acceptanceCriteria: "Feature must validate through AI",
      });
      missionStore._setFeature(feature);
      taskStore._setTask({ id: "FN-001", title: "Test", description: "Test task", log: [] });
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi
        .fn()
        .mockReturnValueOnce([])
        .mockImplementation((featureId: string) => (missionStore as any).getAssertionsForFeature(featureId));

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      const emitSpy = vi.spyOn(loop, "emit");
      vi.spyOn(loop as any, "runValidation").mockResolvedValue({ status: "pass", summary: "ok" });
      loop.start();

      await loop.processTaskOutcome("FN-001");

      expect(missionStore.ensureFeatureAssertionLinked).toHaveBeenCalledWith("F-001");
      expect(missionStore.startValidatorRun).toHaveBeenCalledWith("F-001", "task_completion");
      expect(emitSpy).toHaveBeenCalledWith(
        "validation:passed",
        expect.objectContaining({ featureId: "F-001" }),
      );
      const noAssertionEvents = missionStore.logMissionEvent.mock.calls.filter(
        ([, , , payload]) => payload?.code === "validation_auto_passed_no_assertions",
      );
      expect(noAssertionEvents).toHaveLength(0);
      expectNoValidationBoardTaskMutation(taskStore);
    });

    it("does not emit auto-pass evidence across re-entry after lazy assertion ensure", async () => {
      const feature = createMockFeature({
        id: "F-001",
        loopState: "implementing",
        taskId: "FN-001",
        title: "Feature from prose",
        acceptanceCriteria: "Feature must validate through AI",
      });
      missionStore._setFeature(feature);
      taskStore._setTask({ id: "FN-001", title: "Test", description: "Test task", log: [] });
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi
        .fn()
        .mockReturnValueOnce([])
        .mockImplementation((featureId: string) => (missionStore as any).getAssertionsForFeature(featureId));

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      await loop.processTaskOutcome("FN-001");
      await loop.processTaskOutcome("FN-001");

      expect(missionStore.ensureFeatureAssertionLinked).toHaveBeenCalledTimes(1);
      const noAssertionEvents = missionStore.logMissionEvent.mock.calls.filter(
        ([, , , payload]) => payload?.code === "validation_auto_passed_no_assertions",
      );
      expect(noAssertionEvents).toHaveLength(0);
    });

    it("uses validator path for later-added feature with managed assertion", async () => {
      const feature = createMockFeature({
        id: "F-LATER",
        loopState: "implementing",
        taskId: "FN-LATER",
        title: "Later Feature",
        acceptanceCriteria: "Later criteria",
      });
      (missionStore as any)._addFeatureWithManagedAssertion(feature);
      taskStore._setTask({ id: "FN-LATER", title: "Later task", description: "done", log: [] });
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      await loop.processTaskOutcome("FN-LATER");

      expect(missionStore.listAssertionsForFeature).toHaveBeenCalledWith("F-LATER");
      expect(missionStore.startValidatorRun).toHaveBeenCalledWith("F-LATER", "task_completion");
    });

    it("threads milestone acceptance criteria into validator prompts", () => {
      const feature = createMockFeature({
        id: "F-MILESTONE",
        title: "Feature under milestone",
        acceptanceCriteria: "Feature criteria",
      });
      const milestone = createMockMilestone({
        id: "MS-MILESTONE",
        acceptanceCriteria: "Milestone pass bar text",
      });
      const assertions = [
        {
          id: "CA-1",
          milestoneId: milestone.id,
          title: "Managed assertion",
          assertion: "Feature criteria",
          status: "pending" as const,
          orderIndex: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });

      const prompt = (loop as any).buildValidationPrompt(feature, assertions, milestone);
      const systemPrompt = (loop as any).buildValidationSystemPrompt(feature, assertions, "Task context", milestone);

      expect(prompt).toContain("Milestone pass bar text");
      expect(prompt).toContain("must also be satisfied for this feature to pass");
      expect(systemPrompt).toContain("Milestone pass bar text");
      expect(systemPrompt).toContain("validator-executed requirements");
    });

    it("does NOT create a board task for single-feature validation", async () => {
      const feature = createMockFeature({ loopState: "implementing", taskId: "FN-001", sliceId: "SL-001" });
      missionStore._setFeature(feature);
      taskStore._setTask({ id: "FN-001", title: "Test", description: "Test task", log: [] });
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue([
        { id: "CA-1", milestoneId: "MS-001", title: "Test assertion", assertion: "Should work", status: "pending" as const, orderIndex: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ]);

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      await loop.processTaskOutcome("FN-001");

      expect(taskStore.createTask).toHaveBeenCalledTimes(0);
      expect(missionStore.startValidatorRun).toHaveBeenCalledWith("F-001", "task_completion");
    });

    it("does NOT set mission-validation status on any task", async () => {
      const feature = createMockFeature({ loopState: "implementing", taskId: "FN-001", sliceId: "SL-001" });
      missionStore._setFeature(feature);
      taskStore._setTask({ id: "FN-001", title: "Test", description: "Test task", log: [] });
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue([
        { id: "CA-1", milestoneId: "MS-001", title: "Test assertion", assertion: "Should work", status: "pending" as const, orderIndex: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ]);

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      await loop.processTaskOutcome("FN-001");

      expect(taskStore.updateTask).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: "mission-validation" }),
      );
    });

    it("skips duplicate trigger when feature already has active validation", async () => {
      const feature = createMockFeature({ loopState: "implementing", taskId: "FN-001", sliceId: "SL-001" });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue([
        { id: "CA-1", milestoneId: "MS-001", title: "Test assertion", assertion: "Should work", status: "pending" as const, orderIndex: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ]);

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();
      (loop as any).activeValidations.add("F-001");

      await loop.processTaskOutcome("FN-001");

      expect(missionStore.startValidatorRun).not.toHaveBeenCalled();
      expect(missionStore.logMissionEvent).toHaveBeenCalledWith(
        expect.any(String),
        "warning",
        expect.stringContaining("duplicate trigger"),
        expect.objectContaining({
          code: "validation_deduplicated",
          featureId: "F-001",
          taskId: "FN-001",
        }),
      );
    });

    it("calls startValidatorRun without a board task ID", async () => {
      const feature = createMockFeature({ loopState: "implementing", taskId: "FN-001", sliceId: "SL-001" });
      missionStore._setFeature(feature);
      taskStore._setTask({ id: "FN-001", title: "Test", description: "Test task", log: [] });
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue([
        { id: "CA-1", milestoneId: "MS-001", title: "Test assertion", assertion: "Should work", status: "pending" as const, orderIndex: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ]);

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      await loop.processTaskOutcome("FN-001");

      expect(missionStore.startValidatorRun).toHaveBeenCalledWith(
        "F-001",
        "task_completion",
      );
    });

    it("threads configured validator/default model settings into mission validation sessions", async () => {
      const feature = createMockFeature({ loopState: "implementing", taskId: "FN-MODEL-SETTINGS", status: "in-progress" });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue(makeAssertions(1));
      taskStore._setTask({
        id: "FN-MODEL-SETTINGS",
        title: "Validation model settings",
        description: "Implementation",
        log: [],
        validatorModelProvider: "task-validator",
        validatorModelId: "task-validator-model",
      });
      vi.mocked(taskStore.getSettings).mockResolvedValue({
        missionStaleThresholdMs: 600_000,
        missionMaxTaskRetries: 3,
        validatorProvider: "project-validator",
        validatorModelId: "project-validator-model",
        defaultProviderOverride: "project-default-override",
        defaultModelIdOverride: "project-default-override-model",
        defaultProvider: "project-default",
        defaultModelId: "project-default-model",
        fallbackProvider: "fallback-provider",
        fallbackModelId: "fallback-model",
      });
      mockSessionHolder.session.state.messages = [
        { role: "assistant", content: JSON.stringify({ status: "pass", assertions: [{ assertionId: "CA-1", passed: true }], summary: "all good" }) },
      ];

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      await loop.processTaskOutcome("FN-MODEL-SETTINGS");

      expect(createResolvedAgentSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionPurpose: "validation",
        defaultProvider: "task-validator",
        defaultModelId: "task-validator-model",
        fallbackProvider: "fallback-provider",
        fallbackModelId: "fallback-model",
        settings: expect.objectContaining({
          validatorProvider: "project-validator",
          validatorModelId: "project-validator-model",
          defaultProvider: "project-default",
          defaultModelId: "project-default-model",
        }),
      }));
    });

    it("uses assigned agent runtime model ahead of task/settings for mission validation", async () => {
      const feature = createMockFeature({ loopState: "implementing", taskId: "FN-MODEL-AGENT", status: "in-progress" });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue(makeAssertions(1));
      taskStore._setTask({
        id: "FN-MODEL-AGENT",
        title: "Validation model agent",
        description: "Implementation",
        log: [],
        assignedAgentId: "agent-1",
        validatorModelProvider: "task-validator",
        validatorModelId: "task-validator-model",
      });
      agentStore.getAgent.mockResolvedValue({
        id: "agent-1",
        runtimeConfig: { model: "agent-provider/agent-model" },
      });
      vi.mocked(taskStore.getSettings).mockResolvedValue({
        missionStaleThresholdMs: 600_000,
        missionMaxTaskRetries: 3,
        validatorProvider: "project-validator",
        validatorModelId: "project-validator-model",
      });
      mockSessionHolder.session.state.messages = [
        { role: "assistant", content: JSON.stringify({ status: "pass", assertions: [{ assertionId: "CA-1", passed: true }], summary: "all good" }) },
      ];

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
        agentStore: agentStore as any,
      });
      loop.start();

      await loop.processTaskOutcome("FN-MODEL-AGENT");

      expect(createResolvedAgentSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionPurpose: "validation",
        defaultProvider: "agent-provider",
        defaultModelId: "agent-model",
      }));
    });

    it("forces mock/scripted validator lane when test mode is active", async () => {
      const feature = createMockFeature({ loopState: "implementing", taskId: "FN-MODEL-TESTMODE", status: "in-progress" });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue(makeAssertions(1));
      taskStore._setTask({
        id: "FN-MODEL-TESTMODE",
        title: "Validation model test mode",
        description: "Implementation",
        log: [],
        assignedAgentId: "agent-1",
        validatorModelProvider: "task-validator",
        validatorModelId: "task-validator-model",
      });
      agentStore.getAgent.mockResolvedValue({
        id: "agent-1",
        runtimeConfig: { model: "agent-provider/agent-model" },
      });
      vi.mocked(taskStore.getSettings).mockResolvedValue({
        missionStaleThresholdMs: 600_000,
        missionMaxTaskRetries: 3,
        testMode: true,
        validatorProvider: "project-validator",
        validatorModelId: "project-validator-model",
        fallbackProvider: "fallback-provider",
        fallbackModelId: "fallback-model",
      });
      mockSessionHolder.session.state.messages = [
        { role: "assistant", content: JSON.stringify({ status: "pass", assertions: [{ assertionId: "CA-1", passed: true }], summary: "all good" }) },
      ];

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
        agentStore: agentStore as any,
      });
      loop.start();

      await loop.processTaskOutcome("FN-MODEL-TESTMODE");

      expect(createResolvedAgentSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionPurpose: "validation",
        defaultProvider: TEST_MODE_RESOLVED.provider,
        defaultModelId: TEST_MODE_RESOLVED.modelId,
        fallbackProvider: "fallback-provider",
        fallbackModelId: "fallback-model",
      }));
    });

    it("runs linked assertions and marks completion only when validation passes", async () => {
      const feature = createMockFeature({ loopState: "implementing", taskId: "FN-ASSERT-PASS", status: "in-progress" });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue(makeAssertions(2));
      taskStore._setTask({ id: "FN-ASSERT-PASS", title: "Assertion pass", description: "Implementation", log: [] });
      mockSessionHolder.session.state.messages = [
        { role: "assistant", content: JSON.stringify({ status: "pass", assertions: [{ assertionId: "CA-1", passed: true }, { assertionId: "CA-2", passed: true }], summary: "all good" }) },
      ];

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      await loop.processTaskOutcome("FN-ASSERT-PASS");

      expect(missionStore.startValidatorRun).toHaveBeenCalledWith("F-001", "task_completion");
      expect(missionStore.completeValidatorRun).toHaveBeenCalledWith(expect.any(String), "passed", expect.any(String));
      expect(missionStore.getFeature("F-001")?.loopState).toBe("passed");
      expect(missionStore.getFeature("F-001")?.lastValidatorStatus).toBe("passed");
      expect(missionStore.updateFeatureStatus).toHaveBeenCalledWith("F-001", "done");
    });

    it("routes failed assertion validation to fix flow and does not pass feature", async () => {
      const feature = createMockFeature({ loopState: "implementing", taskId: "FN-ASSERT-FAIL", status: "in-progress" });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue(makeAssertions(2));
      taskStore._setTask({ id: "FN-ASSERT-FAIL", title: "Assertion fail", description: "Implementation", log: [] });
      mockSessionHolder.session.state.messages = [
        { role: "assistant", content: JSON.stringify({ status: "fail", assertions: [{ assertionId: "CA-1", passed: false, message: "miss" }], summary: "failed" }) },
      ];

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      await loop.processTaskOutcome("FN-ASSERT-FAIL");

      expect(missionStore.completeValidatorRun).toHaveBeenCalledWith(expect.any(String), "failed", expect.any(String));
      expect(missionStore.createGeneratedFixFeature).toHaveBeenCalled();
      expect(missionStore.getFeature("F-001")?.lastValidatorStatus).toBe("failed");
      expect(missionStore.getFeature("F-001")?.loopState).toBe("implementing");
      expect(missionStore.getFeature("F-001")?.status).not.toBe("done");
    });
  });

  // ── recoverActiveMissions ────────────────────────────────────────────────

  describe("recoverActiveMissions", () => {
    it("should not crash when called on stopped loop", async () => {
      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      // Don't start - loop is not running

      await expect(loop.recoverActiveMissions()).resolves.not.toThrow();
    });

    it("should not crash when getMissionWithHierarchy returns null", async () => {
      const mission = createMockMission({ status: "active" });
      missionStore._setMission(mission);

      missionStore.getMissionWithHierarchy = vi.fn().mockReturnValue(null);

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      await expect(loop.recoverActiveMissions()).resolves.not.toThrow();
    });

    it("should not crash when getMissionWithHierarchy throws", async () => {
      const mission = createMockMission({ status: "active" });
      missionStore._setMission(mission);

      missionStore.getMissionWithHierarchy = vi.fn().mockImplementation(() => {
        throw new Error("Database error");
      });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      await expect(loop.recoverActiveMissions()).resolves.not.toThrow();
    });

    it("logs warn when mission hierarchy lookup throws during recovery", async () => {
      const mission = createMockMission({ id: "M-LOOKUP", status: "active" });
      missionStore._setMission(mission);
      missionStore.getMissionWithHierarchy = vi.fn().mockImplementation(() => {
        throw new Error("Database error");
      });

      vi.mocked(loopLog.warn).mockClear();

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      await loop.recoverActiveMissions();

      expect(loopLog.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "getMissionWithHierarchy failed for mission M-LOOKUP: Database error",
        ),
      );
    });

    it("should handle empty hierarchy gracefully", async () => {
      const mission = createMockMission({ status: "active" });
      missionStore._setMission(mission);

      missionStore.getMissionWithHierarchy = vi.fn().mockReturnValue({
        ...mission,
        milestones: [],
      });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      await loop.recoverActiveMissions();
      expect(missionStore.transitionLoopState).not.toHaveBeenCalled();
    });

    it("should not recover features from archived missions", async () => {
      const mission = createMockMission({ status: "archived" });
      missionStore._setMission(mission);

      missionStore.getMissionWithHierarchy = vi.fn().mockReturnValue({
        ...mission,
        milestones: [],
      });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      await loop.recoverActiveMissions();
      expect(missionStore.transitionLoopState).not.toHaveBeenCalled();
    });
  });

  // ── Error handling ────────────────────────────────────────────────────────

  describe("error handling", () => {
    it("should not crash the loop on processTaskOutcome errors", async () => {
      missionStore.getFeatureByTaskId = vi.fn().mockImplementation(() => {
        throw new Error("Database error");
      });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      await expect(loop.processTaskOutcome("FN-001")).resolves.not.toThrow();
    });
  });

  // ── parseValidationResult JSON extraction ─────────────────────────────────

  describe("parseValidationResult", () => {
    it("should parse pass result from plain JSON", async () => {
      const assertions = makeAssertions(2);
      const response = JSON.stringify({
        status: "pass",
        assertions: [
          { assertionId: "CA-1", passed: true, message: "OK" },
          { assertionId: "CA-2", passed: true, message: "OK" },
        ],
        summary: "All assertions passed",
      });

      // Set up mock session with AI response
      mockSessionHolder.session.state.messages = [
        { role: "user", content: "Validate this" },
        { role: "assistant", content: response },
      ];

      const feature = createMockFeature({ loopState: "implementing", taskId: "FN-001" });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue(assertions);
      taskStore._setTask({ id: "FN-001", title: "Test", description: "Implementation", log: [] });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      const emitSpy = vi.spyOn(loop, "emit");
      loop.start();

      await loop.processTaskOutcome("FN-001");

      // Should emit validation:passed
      expect(emitSpy).toHaveBeenCalledWith(
        "validation:passed",
        expect.objectContaining({ featureId: "F-001" }),
      );

      // completeValidatorRun should be called with passed
      expect(missionStore.completeValidatorRun).toHaveBeenCalledWith(
        expect.any(String),
        "passed",
        expect.any(String),
      );
      expect(missionStore.updateFeature).not.toHaveBeenCalled();
      expectNoValidationBoardTaskMutation(taskStore);
    });

    it("should parse fail result from JSON in markdown code block", async () => {
      const assertions = makeAssertions(2);
      const response = {
        status: "fail",
        assertions: [
          { assertionId: "CA-1", passed: true, message: "OK" },
          { assertionId: "CA-2", passed: false, message: "Failed", expected: "true", actual: "false" },
        ],
        summary: "One assertion failed",
      };

      // Set up mock session with AI response in markdown code block
      mockSessionHolder.session.state.messages = [
        { role: "user", content: "Validate this" },
        { role: "assistant", content: "```json\n" + JSON.stringify(response) + "\n```" },
      ];

      const feature = createMockFeature({ loopState: "implementing", taskId: "FN-001" });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue(assertions);
      taskStore._setTask({ id: "FN-001", title: "Test", description: "Implementation", log: [] });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      const emitSpy = vi.spyOn(loop, "emit");
      loop.start();

      await loop.processTaskOutcome("FN-001");

      // Should emit validation:failed
      expect(emitSpy).toHaveBeenCalledWith(
        "validation:failed",
        expect.objectContaining({ featureId: "F-001" }),
      );

      // recordValidatorFailures should be called
      expect(missionStore.recordValidatorFailures).toHaveBeenCalled();

      // completeValidatorRun should be called with failed
      expect(missionStore.completeValidatorRun).toHaveBeenCalledWith(
        expect.any(String),
        "failed",
        expect.any(String),
      );

      // createGeneratedFixFeature should be called
      expect(missionStore.createGeneratedFixFeature).toHaveBeenCalled();
      expectNoValidationBoardTaskMutation(taskStore);
    });

    it("should handle malformed JSON gracefully", async () => {
      const assertions = makeAssertions(1);
      // Malformed JSON with trailing comma
      const malformedResponse = '{"status":"blocked","assertions":[{"assertionId":"CA-1","passed":false}],"summary":"Blocked","blockedReason":"API down",}';

      // Set up mock session with malformed JSON
      mockSessionHolder.session.state.messages = [
        { role: "user", content: "Validate this" },
        { role: "assistant", content: malformedResponse },
      ];

      const feature = createMockFeature({ loopState: "implementing", taskId: "FN-001" });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue(assertions);
      taskStore._setTask({ id: "FN-001", title: "Test", description: "Implementation", log: [] });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      const emitSpy = vi.spyOn(loop, "emit");
      loop.start();

      await loop.processTaskOutcome("FN-001");

      // When JSON is malformed and cannot be repaired, it should result in an error status
      // The loop should handle the error gracefully
      expect(emitSpy).toHaveBeenCalledWith(
        expect.stringMatching(/validation:(passed|failed|blocked|error)/),
        expect.any(Object),
      );
    });

    it("should handle AI session returning no messages gracefully", async () => {
      const assertions = makeAssertions(1);
      // Session with no messages
      mockSessionHolder.session.state.messages = [];

      const feature = createMockFeature({ loopState: "implementing", taskId: "FN-001" });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue(assertions);
      taskStore._setTask({ id: "FN-001", title: "Test", description: "Implementation", log: [] });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      // Should not throw - error is caught and handled
      await expect(loop.processTaskOutcome("FN-001")).resolves.not.toThrow();
    });
  });

  // ── handleValidationPass ──────────────────────────────────────────────────

  describe("handleValidationPass", () => {
    it("should mark feature as passed and notify autopilot", async () => {
      const feature = createMockFeature({
        loopState: "implementing",
        taskId: "FN-001",
        id: "F-001",
      });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue([]);
      taskStore._setTask({ id: "FN-001", title: "Test", description: "Test", log: [] });

      const notifySpy = vi.fn();
      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
        missionAutopilot: {
          notifyValidationComplete: notifySpy,
        },
      });
      const emitSpy = vi.spyOn(loop, "emit");
      vi.spyOn(loop as any, "runValidation").mockResolvedValue({ status: "pass", summary: "ok" });
      loop.start();

      await loop.processTaskOutcome("FN-001");

      expect(missionStore.ensureFeatureAssertionLinked).toHaveBeenCalledWith("F-001");
      expect(missionStore.startValidatorRun).toHaveBeenCalledWith("F-001", "task_completion");

      // validation:passed event emitted
      expect(emitSpy).toHaveBeenCalledWith(
        "validation:passed",
        expect.objectContaining({ featureId: "F-001" }),
      );

      // Autopilot notified
      expect(notifySpy).toHaveBeenCalledWith("F-001", "passed");
    });

    it("skips completion when the validator run was reaped mid-flight", async () => {
      const assertions = makeAssertions(1);
      const response = JSON.stringify({
        status: "pass",
        assertions: [{ assertionId: "CA-1", passed: true, message: "OK" }],
        summary: "All assertions passed",
      });

      mockSessionHolder.session.state.messages = [
        { role: "user", content: "Validate this" },
        { role: "assistant", content: response },
      ];

      const feature = createMockFeature({ loopState: "implementing", taskId: "FN-REAPED", id: "F-REAPED" });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue(assertions);
      taskStore._setTask({ id: "FN-REAPED", title: "Test", description: "Implementation", log: [] });

      const originalStartValidatorRun = missionStore.startValidatorRun;
      missionStore.startValidatorRun = vi.fn((featureId: string, triggerType?: string, taskId?: string) => {
        const run = originalStartValidatorRun(featureId, triggerType, taskId);
        missionStore.reapValidatorRun(run.id, "stale");
        return run;
      });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      const emitSpy = vi.spyOn(loop, "emit");
      loop.start();

      await expect(loop.processTaskOutcome("FN-REAPED")).resolves.not.toThrow();

      expect(missionStore.completeValidatorRun).not.toHaveBeenCalledWith(expect.any(String), "passed", expect.any(String));
      expect(emitSpy).toHaveBeenCalledWith(
        "validation:passed",
        expect.objectContaining({ featureId: "F-REAPED" }),
      );
    });
  });

  // ── handleValidationFail ──────────────────────────────────────────────────

  describe("handleValidationFail", () => {
    it("should generate fix feature and record failures", async () => {
      const assertions: MissionContractAssertion[] = [
        {
          id: "CA-1",
          milestoneId: "MS-001",
          title: "Test assertion",
          assertion: "Should work",
          status: "pending",
          orderIndex: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      const feature = createMockFeature({
        loopState: "implementing",
        taskId: "FN-001",
        id: "F-001",
        implementationAttemptCount: 1,
      });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue(assertions);

      // Mock AI to return fail response
      const failResponse = JSON.stringify({
        status: "fail",
        assertions: [{ assertionId: "CA-1", passed: false, message: "Failed", expected: "ok", actual: "not ok" }],
        summary: "Assertion failed",
      });
      mockSessionHolder.session.state.messages = [
        { role: "user", content: "Validate this" },
        { role: "assistant", content: failResponse },
      ];

      taskStore._setTask({ id: "FN-001", title: "Test", description: "Implementation", log: [] });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      const emitSpy = vi.spyOn(loop, "emit");
      loop.start();

      await loop.processTaskOutcome("FN-001");

      // recordValidatorFailures called
      expect(missionStore.recordValidatorFailures).toHaveBeenCalled();

      // completeValidatorRun called with failed
      expect(missionStore.completeValidatorRun).toHaveBeenCalledWith(
        expect.any(String),
        "failed",
        expect.any(String),
      );

      // createGeneratedFixFeature called
      expect(missionStore.createGeneratedFixFeature).toHaveBeenCalledWith(
        "F-001",
        expect.any(String),
        expect.arrayContaining(["CA-1"]),
      );

      // triageFeature called for the fix feature
      expect(missionStore.triageFeature).toHaveBeenCalledWith(
        expect.stringContaining("FIX-"),
      );

      // validation:failed event emitted
      expect(emitSpy).toHaveBeenCalledWith(
        "validation:failed",
        expect.objectContaining({
          featureId: "F-001",
          failures: expect.arrayContaining([
            expect.objectContaining({ assertionId: "CA-1" }),
          ]),
        }),
      );
    });

    it("should emit validation:failed even if triageFeature throws", async () => {
      const assertions: MissionContractAssertion[] = [
        {
          id: "CA-1",
          milestoneId: "MS-001",
          title: "Test assertion",
          assertion: "Should work",
          status: "pending",
          orderIndex: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      const feature = createMockFeature({
        loopState: "implementing",
        taskId: "FN-001",
        id: "F-001",
        implementationAttemptCount: 1,
      });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue(assertions);

      // Mock AI to return fail response
      const failResponse = JSON.stringify({
        status: "fail",
        assertions: [{ assertionId: "CA-1", passed: false, message: "Failed", expected: "ok", actual: "not ok" }],
        summary: "Assertion failed",
      });
      mockSessionHolder.session.state.messages = [
        { role: "user", content: "Validate this" },
        { role: "assistant", content: failResponse },
      ];

      // Make triageFeature throw an error
      missionStore.triageFeature = vi.fn().mockRejectedValue(new Error("Triage failed"));

      taskStore._setTask({ id: "FN-001", title: "Test", description: "Implementation", log: [] });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      const emitSpy = vi.spyOn(loop, "emit");
      loop.start();

      await loop.processTaskOutcome("FN-001");

      // triageFeature was called but threw
      expect(missionStore.triageFeature).toHaveBeenCalledWith(expect.stringContaining("FIX-"));

      // validation:failed event should still be emitted
      expect(emitSpy).toHaveBeenCalledWith(
        "validation:failed",
        expect.objectContaining({
          featureId: "F-001",
        }),
      );
    });
  });

  // ── handleValidationBlocked ───────────────────────────────────────────────

  describe("handleValidationBlocked", () => {
    it("should mark feature as blocked without generating fix", async () => {
      const assertions: MissionContractAssertion[] = [
        {
          id: "CA-1",
          milestoneId: "MS-001",
          title: "Test assertion",
          assertion: "Should work",
          status: "pending",
          orderIndex: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      const feature = createMockFeature({
        loopState: "implementing",
        taskId: "FN-001",
        id: "F-001",
      });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue(assertions);

      // Mock AI to return blocked response
      const blockedResponse = JSON.stringify({
        status: "blocked",
        assertions: [{ assertionId: "CA-1", passed: false, message: "Blocked" }],
        summary: "Validation blocked",
        blockedReason: "External API not available",
      });
      mockSessionHolder.session.state.messages = [
        { role: "user", content: "Validate this" },
        { role: "assistant", content: blockedResponse },
      ];

      taskStore._setTask({ id: "FN-001", title: "Test", description: "Implementation", log: [] });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      const emitSpy = vi.spyOn(loop, "emit");
      loop.start();

      await loop.processTaskOutcome("FN-001");

      // completeValidatorRun called with blocked
      expect(missionStore.completeValidatorRun).toHaveBeenCalledWith(
        expect.any(String),
        "blocked",
        expect.stringContaining("External API not available"),
      );

      // createGeneratedFixFeature should NOT be called
      expect(missionStore.createGeneratedFixFeature).not.toHaveBeenCalled();

      // validation:blocked event emitted
      expect(emitSpy).toHaveBeenCalledWith(
        "validation:blocked",
        expect.objectContaining({
          featureId: "F-001",
          reason: expect.stringContaining("External API not available"),
        }),
      );
      expectNoValidationBoardTaskMutation(taskStore);
    });
  });

  // ── handleValidationError ───────────────────────────────────────────────

  describe("handleValidationError", () => {
    it("surfaces validation session creation failures as mission errors", async () => {
      const assertions = makeAssertions(1);
      const feature = createMockFeature({
        loopState: "implementing",
        taskId: "FN-SESSION-ERROR",
        id: "F-001",
      });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue(assertions);
      taskStore._setTask({ id: "FN-SESSION-ERROR", title: "Test", description: "Implementation", log: [] });
      vi.mocked(createResolvedAgentSession).mockRejectedValueOnce(new Error("401 insufficient credits"));

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      const emitSpy = vi.spyOn(loop, "emit");
      loop.start();

      await loop.processTaskOutcome("FN-SESSION-ERROR");

      expect(missionStore.completeValidatorRun).toHaveBeenCalledWith(
        expect.any(String),
        "error",
        "Validation failed due to error: 401 insufficient credits",
      );
      expect(missionStore.createGeneratedFixFeature).not.toHaveBeenCalled();
      expect(emitSpy).toHaveBeenCalledWith(
        "validation:error",
        expect.objectContaining({
          featureId: "F-001",
          error: "Validation failed due to error: 401 insufficient credits",
        }),
      );
      expect(missionStore.logMissionEvent).toHaveBeenCalledWith(
        expect.any(String),
        "error",
        expect.stringContaining("Validation error"),
        expect.objectContaining({
          code: "validation_error",
          featureId: "F-001",
          error: "Validation failed due to error: 401 insufficient credits",
        }),
      );
      expectNoValidationBoardTaskMutation(taskStore);
    });

    it("emits validation:error without mutating any board task", async () => {
      const assertions = makeAssertions(1);
      const feature = createMockFeature({
        loopState: "implementing",
        taskId: "FN-001",
        id: "F-001",
      });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue(assertions);
      taskStore._setTask({ id: "FN-001", title: "Test", description: "Implementation", log: [] });

      mockSessionHolder.session.state.messages = [
        { role: "user", content: "Validate this" },
        { role: "assistant", content: JSON.stringify({ status: "unknown", summary: "validator crashed" }) },
      ];

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      const emitSpy = vi.spyOn(loop, "emit");
      loop.start();

      await loop.processTaskOutcome("FN-001");

      expect(missionStore.completeValidatorRun).toHaveBeenCalledWith(
        expect.any(String),
        "error",
        "Invalid status in validation response",
      );
      expect(emitSpy).toHaveBeenCalledWith(
        "validation:error",
        expect.objectContaining({
          featureId: "F-001",
          error: "Invalid status in validation response",
        }),
      );
      expect(missionStore.logMissionEvent).toHaveBeenCalledWith(
        expect.any(String),
        "error",
        expect.stringContaining("Validation error"),
        expect.objectContaining({
          code: "validation_error",
          featureId: "F-001",
          error: "Invalid status in validation response",
        }),
      );
      expectNoValidationBoardTaskMutation(taskStore);
    });
  });

  // ── Retry budget enforcement ─────────────────────────────────────────────

  describe("retry budget enforcement", () => {
    it("should emit budget_exhausted event when retry budget is exhausted", async () => {
      // Create a feature with implementationAttemptCount at the max (3)
      // Feature must be in "implementing" state to trigger validation
      const feature = createMockFeature({
        loopState: "implementing",
        taskId: "FN-001",
        id: "F-001",
        implementationAttemptCount: 3, // At max budget (default maxRetryBudget=3)
      });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue([
        {
          id: "CA-1",
          milestoneId: "MS-001",
          title: "Test assertion",
          assertion: "Should work",
          status: "pending",
          orderIndex: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);

      // When createGeneratedFixFeature is called with exhausted budget,
      // it should throw an error that includes "retry budget exhausted"
      missionStore.createGeneratedFixFeature = vi.fn().mockImplementation(() => {
        throw new Error("retry budget exhausted: maximum implementation attempts reached");
      });

      // Mock AI to return fail response
      const failResponse = JSON.stringify({
        status: "fail",
        assertions: [{ assertionId: "CA-1", passed: false, message: "Failed" }],
        summary: "Failed",
      });
      mockSessionHolder.session.state.messages = [
        { role: "user", content: "Validate this" },
        { role: "assistant", content: failResponse },
      ];

      taskStore._setTask({ id: "FN-001", title: "Test", description: "Implementation", log: [] });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
        maxRetryBudget: 3,
      });
      const emitSpy = vi.spyOn(loop, "emit");
      loop.start();

      await loop.processTaskOutcome("FN-001");

      // When budget exhausted, validation:budget_exhausted event should be emitted
      expect(emitSpy).toHaveBeenCalledWith(
        "validation:budget_exhausted",
        expect.objectContaining({ featureId: "F-001" }),
      );
    });

    it("should respect custom maxRetryBudget setting", async () => {
      // Create a feature with implementationAttemptCount at custom max (2)
      // Feature must be in "implementing" state to trigger validation
      const feature = createMockFeature({
        loopState: "implementing",
        taskId: "FN-001",
        id: "F-001",
        implementationAttemptCount: 2, // At custom max
      });
      missionStore._setFeature(feature);
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue([
        {
          id: "CA-1",
          milestoneId: "MS-001",
          title: "Test assertion",
          assertion: "Should work",
          status: "pending",
          orderIndex: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);

      // When createGeneratedFixFeature is called with exhausted budget,
      // it should throw
      missionStore.createGeneratedFixFeature = vi.fn().mockImplementation(() => {
        throw new Error("retry budget exhausted: maximum implementation attempts reached");
      });

      const failResponse = JSON.stringify({
        status: "fail",
        assertions: [{ assertionId: "CA-1", passed: false, message: "Failed" }],
        summary: "Failed",
      });
      mockSessionHolder.session.state.messages = [
        { role: "user", content: "Validate this" },
        { role: "assistant", content: failResponse },
      ];

      taskStore._setTask({ id: "FN-001", title: "Test", description: "Implementation", log: [] });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
        maxRetryBudget: 2, // Custom budget of 2
      });
      const emitSpy = vi.spyOn(loop, "emit");
      loop.start();

      await loop.processTaskOutcome("FN-001");

      // Should emit budget_exhausted when at custom max
      expect(emitSpy).toHaveBeenCalledWith(
        "validation:budget_exhausted",
        expect.objectContaining({ featureId: "F-001" }),
      );
    });
  });

  // ── recoverActiveMissions processTaskOutcome calls ───────────────────────

  describe("recoverActiveMissions", () => {
    it("should call processTaskOutcome for validating features with linked task", async () => {
      const feature = createMockFeature({
        id: "F-VALIDATING",
        sliceId: "SL-001",
        loopState: "validating",
        taskId: "FN-VALIDATING",
      });
      missionStore._setFeature(feature);

      missionStore.getMissionWithHierarchy = vi.fn().mockReturnValue({
        id: "M-TEST1",
        title: "Test Mission",
        status: "active",
        interviewState: "not_started",
        autoAdvance: true,
        autopilotEnabled: true,
        autopilotState: "inactive",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        milestones: [
          {
            ...createMockMilestone(),
            slices: [
              {
                ...createMockSlice(),
                features: [feature],
              },
            ],
          },
        ],
      });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      const processTaskOutcomeSpy = vi.spyOn(loop, "processTaskOutcome");
      taskStore._setTask({ id: "FN-VALIDATING", column: "done" });
      loop.start();

      await loop.recoverActiveMissions();

      // processTaskOutcome should be called for the validating feature
      expect(processTaskOutcomeSpy).toHaveBeenCalledWith("FN-VALIDATING");
    });

    it("should call processTaskOutcome for needs_fix features with linked task", async () => {
      const feature = createMockFeature({
        id: "F-NEEDS-FIX",
        sliceId: "SL-001",
        loopState: "needs_fix",
        taskId: "FN-NEEDS-FIX",
      });
      missionStore._setFeature(feature);

      missionStore.getMissionWithHierarchy = vi.fn().mockReturnValue({
        id: "M-TEST1",
        title: "Test Mission",
        status: "active",
        interviewState: "not_started",
        autoAdvance: true,
        autopilotEnabled: true,
        autopilotState: "inactive",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        milestones: [
          {
            ...createMockMilestone(),
            slices: [
              {
                ...createMockSlice(),
                features: [feature],
              },
            ],
          },
        ],
      });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      const processTaskOutcomeSpy = vi.spyOn(loop, "processTaskOutcome");
      taskStore._setTask({ id: "FN-NEEDS-FIX", column: "done" });
      loop.start();

      await loop.recoverActiveMissions();

      // processTaskOutcome should be called for the needs_fix feature
      expect(processTaskOutcomeSpy).toHaveBeenCalledWith("FN-NEEDS-FIX");
    });

    it("should transition validating feature back to implementing before processTaskOutcome", async () => {
      const feature = createMockFeature({
        id: "F-VALIDATING",
        sliceId: "SL-001",
        loopState: "validating",
        taskId: "FN-VALIDATING",
      });
      missionStore._setFeature(feature);

      missionStore.getMissionWithHierarchy = vi.fn().mockReturnValue({
        id: "M-TEST1",
        title: "Test Mission",
        status: "active",
        interviewState: "not_started",
        autoAdvance: true,
        autopilotEnabled: true,
        autopilotState: "inactive",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        milestones: [
          {
            ...createMockMilestone(),
            slices: [
              {
                ...createMockSlice(),
                features: [feature],
              },
            ],
          },
        ],
      });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      await loop.recoverActiveMissions();

      // transitionLoopState should be called to move from validating back to implementing
      expect(missionStore.transitionLoopState).toHaveBeenCalledWith("F-VALIDATING", "implementing");
    });

    it("should not call processTaskOutcome when validating feature task is still in-progress", async () => {
      const feature = createMockFeature({
        id: "F-VALIDATING-IN-PROGRESS",
        sliceId: "SL-001",
        loopState: "validating",
        taskId: "FN-IN-PROGRESS",
      });
      missionStore._setFeature(feature);

      missionStore.getMissionWithHierarchy = vi.fn().mockReturnValue({
        id: "M-TEST1",
        title: "Test Mission",
        status: "active",
        interviewState: "not_started",
        autoAdvance: true,
        autopilotEnabled: true,
        autopilotState: "inactive",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        milestones: [
          {
            ...createMockMilestone(),
            slices: [
              {
                ...createMockSlice(),
                features: [feature],
              },
            ],
          },
        ],
      });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      const processTaskOutcomeSpy = vi.spyOn(loop, "processTaskOutcome");
      taskStore._setTask({ id: "FN-IN-PROGRESS", column: "in-progress" });
      loop.start();

      await loop.recoverActiveMissions();

      expect(processTaskOutcomeSpy).not.toHaveBeenCalled();
      expect(missionStore.transitionLoopState).toHaveBeenCalledWith("F-VALIDATING-IN-PROGRESS", "implementing");
    });

    it("should recover implementing features whose linked task is already done and assertions are unpassed", async () => {
      const feature = createMockFeature({
        id: "F-IMPLEMENTING-DONE",
        sliceId: "SL-001",
        loopState: "implementing",
        status: "done",
        taskId: "FN-DONE",
        lastValidatorStatus: undefined,
      });
      missionStore._setFeature(feature);
      missionStore._setAssertionsForFeature("F-IMPLEMENTING-DONE", [
        {
          id: "CA-1",
          milestoneId: "MS-001",
          title: "Must pass",
          assertion: "Assertion",
          status: "pending",
          orderIndex: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);

      missionStore.getMissionWithHierarchy = vi.fn().mockReturnValue({
        ...createMockMission(),
        milestones: [
          {
            ...createMockMilestone(),
            slices: [{ ...createMockSlice(), features: [feature] }],
          },
        ],
      });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      const processTaskOutcomeSpy = vi.spyOn(loop, "processTaskOutcome");
      taskStore._setTask({ id: "FN-DONE", column: "done" });

      await loop.recoverActiveMissions();

      expect(processTaskOutcomeSpy).toHaveBeenCalledWith("FN-DONE");
    });

    it("does not re-trigger implementing features when validator already passed", async () => {
      const feature = createMockFeature({
        id: "F-IMPLEMENTING-PASSED",
        sliceId: "SL-001",
        loopState: "implementing",
        status: "done",
        taskId: "FN-PASSED",
        lastValidatorStatus: "passed",
      });
      missionStore._setFeature(feature);
      missionStore._setAssertionsForFeature("F-IMPLEMENTING-PASSED", [
        {
          id: "CA-1",
          milestoneId: "MS-001",
          title: "Must pass",
          assertion: "Assertion",
          status: "passed",
          orderIndex: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);

      missionStore.getMissionWithHierarchy = vi.fn().mockReturnValue({
        ...createMockMission(),
        milestones: [
          {
            ...createMockMilestone(),
            slices: [{ ...createMockSlice(), features: [feature] }],
          },
        ],
      });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      const processTaskOutcomeSpy = vi.spyOn(loop, "processTaskOutcome");
      taskStore._setTask({ id: "FN-PASSED", column: "done" });

      await loop.recoverActiveMissions();

      expect(processTaskOutcomeSpy).not.toHaveBeenCalled();
    });

    it("should not call processTaskOutcome for needs_fix features without taskId", async () => {
      const feature = createMockFeature({
        id: "F-NO-TASK",
        sliceId: "SL-001",
        loopState: "needs_fix",
        taskId: undefined, // No linked task
      });
      missionStore._setFeature(feature);

      missionStore.getMissionWithHierarchy = vi.fn().mockReturnValue({
        id: "M-TEST1",
        title: "Test Mission",
        status: "active",
        interviewState: "not_started",
        autoAdvance: true,
        autopilotEnabled: true,
        autopilotState: "inactive",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        milestones: [
          {
            ...createMockMilestone(),
            slices: [
              {
                ...createMockSlice(),
                features: [feature],
              },
            ],
          },
        ],
      });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      const processTaskOutcomeSpy = vi.spyOn(loop, "processTaskOutcome");
      loop.start();

      await loop.recoverActiveMissions();

      // processTaskOutcome should NOT be called (no taskId)
      expect(processTaskOutcomeSpy).not.toHaveBeenCalled();
    });
  });
});
