/**
 * MissionExecutionLoop unit tests.
 *
 * Tests the validation cycle orchestration class with mocked TaskStore, MissionStore,
 * and AI agent (createKbAgent/promptWithFallback).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
vi.mock("./pi.js", () => {
  const createKbAgent = vi.fn(() => Promise.resolve({ session: mockSessionHolder.session }));
  const promptWithFallback = vi.fn().mockResolvedValue(undefined);
  return { createKbAgent, promptWithFallback };
});

// Helper to reset mock session state
function resetMockSession() {
  mockSessionHolder.session.state.messages = [];
  mockSessionHolder.session.dispose = vi.fn();
}

// Import AFTER vi.mock so the mock is applied
import { MissionExecutionLoop } from "./mission-execution-loop.js";

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
    transitionLoopState: vi.fn((id: string, newState: MissionFeature["loopState"]) => {
      const feature = features.get(id);
      if (!feature) throw new Error(`Feature ${id} not found`);
      const updated = { ...feature, loopState: newState, updatedAt: new Date().toISOString() };
      features.set(id, updated);
      return updated;
    }),
    listAssertionsForFeature: vi.fn(() => []),
    getAssertionsForFeature: vi.fn(() => []),
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
    completeValidatorRun: vi.fn((id: string, status: MissionValidatorRun["status"], summary?: string) => {
      const run = validatorRuns.get(id);
      if (!run) throw new Error(`Validator run ${id} not found`);
      const updated = {
        ...run,
        status,
        summary,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      validatorRuns.set(id, updated);
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
        loopState: "needs_fix" as const,
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
    _getValidatorRun: (id: string) => validatorRuns.get(id),
    _clear: () => {
      missions.clear();
      features.clear();
      validatorRuns.clear();
    },
  };

  return store;
}

function createMockTaskStore() {
  const tasks = new Map<string, { id: string; title?: string; description?: string; log?: Array<{ action?: string }>; column?: string; missionId?: string; sliceId?: string; status?: string }>();

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
    on: vi.fn(),
    off: vi.fn(),

    _setTask: (t: { id: string; title?: string; description?: string; log?: Array<{ action?: string }>; column?: string; missionId?: string; sliceId?: string; status?: string }) => tasks.set(t.id, t),
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe("MissionExecutionLoop", () => {
  let loop: MissionExecutionLoop;
  let missionStore: ReturnType<typeof createMockMissionStore>;
  let taskStore: ReturnType<typeof createMockTaskStore>;

  beforeEach(() => {
    vi.useFakeTimers();
    missionStore = createMockMissionStore();
    taskStore = createMockTaskStore();

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
    });

    it("should auto-pass if feature has no linked assertions", async () => {
      const feature = createMockFeature({ loopState: "implementing", taskId: "FN-001" });
      missionStore._setFeature(feature);
      taskStore._setTask({ id: "FN-001", title: "Test", description: "Test task", log: [] });
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue([]);

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      const emitSpy = vi.spyOn(loop, "emit");
      loop.start();

      await loop.processTaskOutcome("FN-001");

      // When there are no assertions, we skip starting a validator run
      expect(missionStore.startValidatorRun).not.toHaveBeenCalled();
      // But the passed event should be emitted
      expect(emitSpy).toHaveBeenCalledWith(
        "validation:passed",
        expect.objectContaining({ featureId: "F-001" }),
      );
    });

    it("creates validation board task when feature has assertions", async () => {
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

      // Should create a validation board task
      expect(taskStore.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining("Validate:"),
          column: "in-progress",
          sliceId: "SL-001",
        }),
      );
    });

    it("sets validation task status to mission-validation", async () => {
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

      // Should update the task status to mission-validation
      expect(taskStore.updateTask).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: "mission-validation" }),
      );
    });

    it("passes taskId to startValidatorRun", async () => {
      const feature = createMockFeature({ loopState: "implementing", taskId: "FN-001", sliceId: "SL-001" });
      missionStore._setFeature(feature);
      taskStore._setTask({ id: "FN-001", title: "Test", description: "Test task", log: [] });
      missionStore.getFeatureByTaskId = vi.fn().mockReturnValue(feature);
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue([
        { id: "CA-1", milestoneId: "MS-001", title: "Test assertion", assertion: "Should work", status: "pending" as const, orderIndex: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ]);
      // Make createTask return a predictable ID
      taskStore.createTask = vi.fn().mockResolvedValue({ id: "KB-999" });

      loop = new MissionExecutionLoop({
        taskStore: taskStore as any,
        missionStore: missionStore as any,
        rootDir: "/tmp",
      });
      loop.start();

      await loop.processTaskOutcome("FN-001");

      // Should pass the created task ID to startValidatorRun
      expect(missionStore.startValidatorRun).toHaveBeenCalledWith(
        "F-001",
        "task_completion",
        "KB-999",
      );
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
      missionStore.listAssertionsForFeature = vi.fn().mockReturnValue([]); // No assertions = auto-pass
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
      loop.start();

      await loop.processTaskOutcome("FN-001");

      // No validator run started (no assertions)
      expect(missionStore.startValidatorRun).not.toHaveBeenCalled();

      // validation:passed event emitted
      expect(emitSpy).toHaveBeenCalledWith(
        "validation:passed",
        expect.objectContaining({ featureId: "F-001" }),
      );

      // Autopilot notified
      expect(notifySpy).toHaveBeenCalledWith("F-001", "passed");
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
