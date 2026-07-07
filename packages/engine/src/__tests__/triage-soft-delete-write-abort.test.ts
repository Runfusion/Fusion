import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskDetail, TaskStore } from "@fusion/core";
import { TaskDeletedError } from "@fusion/core";

const {
  mockCreateResolvedAgentSession,
  mockPromptWithFallback,
  mockDescribeModel,
} = vi.hoisted(() => ({
  mockCreateResolvedAgentSession: vi.fn(),
  mockPromptWithFallback: vi.fn(),
  mockDescribeModel: vi.fn().mockReturnValue("mock-model"),
}));

vi.mock("../agent-session-helpers.js", () => ({
  createResolvedAgentSession: mockCreateResolvedAgentSession,
  extractRuntimeHint: vi.fn(),
  resolvePlanningSessionModel: vi.fn().mockReturnValue({ provider: "mock", modelId: "mock-model" }),
}));

vi.mock("../pi.js", () => {
  /*
  FNXC:EngineTests 2026-07-07-08:05:
  triage.ts specifyTask now (FN-7559) checks `err instanceof ModelFallbackExhaustedError` in its catch and (earlier, agentWork) calls `formatModelMarkerDetails`. The pi mock must expose both so the instanceof guard is callable and agentWork's model-marker formatting resolves, instead of crashing happy-path specifyTask runs.
  */
  class ModelFallbackExhaustedError extends Error {}
  return {
    ModelFallbackExhaustedError,
    describeModel: mockDescribeModel,
    formatModelMarkerDetails: vi.fn((model: string) => model),
    promptWithFallback: mockPromptWithFallback,
  };
});

vi.mock("../reviewer.js", () => ({
  reviewStep: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  return createEngineCoreMock(() => importOriginal<typeof import("@fusion/core")>(), {
    resolveAgentPrompt: vi.fn().mockReturnValue(null),
  });
});

import { planLog } from "../logger.js";
import { TriageProcessor } from "../triage.js";

const mockTaskDetail: TaskDetail = {
  id: "FN-5208",
  description: "soft delete race",
  column: "triage",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  prompt: "# FN-5208\n",
  attachments: [],
  comments: [],
};

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-5208",
    description: "soft delete race",
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    on: vi.fn(),
    getTask: vi.fn().mockResolvedValue({ ...mockTaskDetail }),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 10000,
      groupOverlappingFiles: false,
      autoMerge: true,
    } as Settings),
    listTasks: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as TaskStore;
}

describe("triage soft-delete write abort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPromptWithFallback.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("aborts specifyTask cleanly when a store write hits TaskDeletedError", async () => {
    const deletedAt = "2026-05-19T12:00:00.000Z";
    const dispose = vi.fn();
    const onSpecifyError = vi.fn();
    const logSpy = vi.spyOn(planLog, "log");
    mockCreateResolvedAgentSession.mockResolvedValue({
      session: {
        state: {},
        sessionManager: {},
        dispose,
        navigateTree: vi.fn(),
      },
    });

    const store = createMockStore({
      updateTask: vi.fn().mockRejectedValueOnce(new TaskDeletedError("FN-5208", deletedAt)),
    });

    const processor = new TriageProcessor(store, "/tmp/root", { onSpecifyError });
    await expect(processor.specifyTask(createTask())).resolves.toBeUndefined();

    expect(store.updateTask).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(onSpecifyError).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("[triage] FN-5208: skipping spec write — task soft-deleted");
    expect(mockPromptWithFallback).not.toHaveBeenCalled();
    expect((processor as any).activeSessions.size).toBe(0);
  });

  it("keeps normal specifyTask runs progressing through planning setup", async () => {
    const dispose = vi.fn();
    mockCreateResolvedAgentSession.mockResolvedValue({
      session: {
        state: {},
        sessionManager: {},
        dispose,
        navigateTree: vi.fn(),
      },
    });

    const store = createMockStore();
    const processor = new TriageProcessor(store, "/tmp/root");
    await expect(processor.specifyTask(createTask())).resolves.toBeUndefined();

    expect(store.updateTask).toHaveBeenCalledWith("FN-5208", { status: "planning" });
    expect(mockPromptWithFallback).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
