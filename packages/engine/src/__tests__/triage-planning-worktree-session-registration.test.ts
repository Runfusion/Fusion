import { mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskDetail, TaskStore } from "@fusion/core";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { TriageProcessor } from "../triage.js";

const { mockCreateFnAgent, mockPromptWithFallback } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
  mockPromptWithFallback: vi.fn(),
}));

vi.mock("../reviewer.js", () => ({ reviewStep: vi.fn() }));
vi.mock("../pi.js", () => {
  class ModelFallbackExhaustedError extends Error {}
  return {
    ModelFallbackExhaustedError,
    createFnAgent: mockCreateFnAgent,
    describeModel: vi.fn().mockReturnValue("mock-model"),
    formatModelMarkerDetails: vi.fn((model: string) => model),
    promptWithFallback: mockPromptWithFallback,
  };
});
vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  const original = await importOriginal<typeof import("@fusion/core")>();
  return createEngineCoreMock(() => Promise.resolve(original));
});

const ROOT_DIR = "/tmp/fn-282-root";
const LEGACY_PLANNING_WORKTREE = "/tmp/fn-282-root/.worktrees/legacy";

function createTask(): Task {
  return {
    id: "FN-282",
    description: "Plan before creating an execution checkout",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function createStore(task: Task): TaskStore {
  return {
    getRootDir: vi.fn().mockReturnValue(ROOT_DIR),
    getTask: vi.fn().mockResolvedValue({ ...task, prompt: "", attachments: [], comments: [] } as TaskDetail),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(), moveTask: vi.fn(), updateTask: vi.fn().mockResolvedValue(undefined), deleteTask: vi.fn(), mergeTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 12, maxWorktrees: 4, pollIntervalMs: 10000, groupOverlappingFiles: false, autoMerge: true } as Settings),
    updateSettings: vi.fn(), logEntry: vi.fn().mockResolvedValue(undefined), appendAgentLog: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]), addSteeringComment: vi.fn(), parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]), parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined), getWorkflowDefinition: vi.fn().mockResolvedValue(undefined), on: vi.fn(), emit: vi.fn(),
  } as unknown as TaskStore;
}

describe("checkout-free planning session registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeSessionRegistry.unregisterPath(ROOT_DIR);
    activeSessionRegistry.unregisterPath(LEGACY_PLANNING_WORKTREE);
  });

  afterEach(async () => {
    await rm(ROOT_DIR, { recursive: true, force: true });
  });

  it("runs from the project root without registering any task-owned session path", async () => {
    const task = createTask();
    const store = createStore(task);
    let capturedOptions: Record<string, unknown> | undefined;
    let rootActiveDuringSession: boolean | undefined;
    let legacyPathActiveDuringSession: boolean | undefined;

    mockCreateFnAgent.mockImplementationOnce(async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return {
        session: {
          state: {},
          sessionManager: { getLeafId: vi.fn().mockReturnValue(null) },
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          navigateTree: vi.fn(),
        },
      };
    });
    mockPromptWithFallback.mockImplementationOnce(async () => {
      rootActiveDuringSession = activeSessionRegistry.isPathActive(ROOT_DIR);
      legacyPathActiveDuringSession = activeSessionRegistry.isPathActive(LEGACY_PLANNING_WORKTREE);
    });

    await new TriageProcessor(store, ROOT_DIR).specifyTask(task);

    expect(capturedOptions).toMatchObject({
      cwd: ROOT_DIR,
      sessionBoundary: {
        kind: "read-only-root",
        writableRoot: null,
        projectRoot: ROOT_DIR,
        writableAllowlist: [`${ROOT_DIR}/.fusion`],
      },
    });
    expect(rootActiveDuringSession).toBe(false);
    expect(legacyPathActiveDuringSession).toBe(false);
    expect(activeSessionRegistry.pathsForTask(task.id)).toEqual([]);
    expect(vi.mocked(store.updateTask).mock.calls.every(([, patch]) =>
      !("worktree" in (patch as object)) && !("workspaceWorktrees" in (patch as object)),
    )).toBe(true);
  });

  it("uses the same root boundary for a workspace task with no acquired repository checkouts", async () => {
    await mkdir(`${ROOT_DIR}/.fusion`, { recursive: true });
    await writeFile(`${ROOT_DIR}/.fusion/workspace.json`, JSON.stringify({ repos: ["repo-a", "repo-b"] }));
    const task = { ...createTask(), workspaceWorktrees: {} };
    const store = createStore(task);
    let capturedOptions: Record<string, unknown> | undefined;
    mockCreateFnAgent.mockImplementationOnce(async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return {
        session: {
          state: {},
          sessionManager: { getLeafId: vi.fn().mockReturnValue(null) },
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          navigateTree: vi.fn(),
        },
      };
    });
    mockPromptWithFallback.mockResolvedValueOnce(undefined);

    await new TriageProcessor(store, ROOT_DIR).specifyTask(task);

    expect(capturedOptions).toMatchObject({
      cwd: ROOT_DIR,
      sessionBoundary: {
        kind: "read-only-root",
        writableRoot: null,
        projectRoot: ROOT_DIR,
        writableAllowlist: [`${ROOT_DIR}/.fusion`],
      },
    });
    expect(task.workspaceWorktrees).toEqual({});
    expect(activeSessionRegistry.pathsForTask(task.id)).toEqual([]);
    expect(vi.mocked(store.updateTask).mock.calls.every(([, patch]) =>
      !("worktree" in (patch as object)) && !("workspaceWorktrees" in (patch as object)),
    )).toBe(true);
  });
});
