// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import { createApiRoutes } from "../routes.js";
import type { TaskStore, TaskCreateInput, TaskBranchContext } from "@fusion/core";
import { request as performRequest } from "../test-request.js";

const { mockExecFile, mockExecSync } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockExecSync: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  mockExecSync.mockImplementation(((...args: Parameters<typeof actual.execSync>) => actual.execSync(...args)) as typeof actual.execSync);
  mockExecFile.mockImplementation((...callArgs: unknown[]) => {
    const [file, argsOrCb, maybeOptions, maybeCb] = callArgs as [string, unknown, unknown, unknown];
    const args = Array.isArray(argsOrCb) ? argsOrCb : [];
    const cb =
      typeof maybeCb === "function"
        ? (maybeCb as (err: unknown, stdout?: string, stderr?: string) => void)
        : typeof maybeOptions === "function"
          ? (maybeOptions as (err: unknown, stdout?: string, stderr?: string) => void)
          : typeof argsOrCb === "function"
            ? (argsOrCb as (err: unknown, stdout?: string, stderr?: string) => void)
            : null;

    if (file === "pgrep" && args[0] === "-f" && args[1] === "vitest") {
      if (cb) queueMicrotask(() => cb(null, "", ""));
      return;
    }

    return (actual.execFile as (...innerArgs: unknown[]) => unknown)(...callArgs);
  });
  return {
    ...actual,
    execSync: mockExecSync,
    execFile: mockExecFile,
  };
});

vi.mock("@fusion/core", async (importOriginal) => {
  const { createCoreMock } = await import("../test/mockCoreEngine.js");
  return createCoreMock(() => importOriginal<typeof import("@fusion/core")>(), {
    resolveGlobalDir: vi.fn().mockReturnValue("/tmp/fusion-test"),
    isGhAvailable: vi.fn(),
    isGhAuthenticated: vi.fn(),
    isQmdAvailable: vi.fn().mockResolvedValue(false),
    CentralCore: vi.fn().mockImplementation(function () { return {
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listProjects: vi.fn().mockResolvedValue([]),
      reconcileProjectStatuses: vi.fn().mockResolvedValue(undefined),
    }; }),
  });
});

vi.mock("@fusion/engine", async () => {
  const { createEngineMock } = await import("../test/mockCoreEngine.js");
  return createEngineMock({
    createFnAgent: vi.fn(async (options?: { onText?: (delta: string) => void }) => ({
      session: {
        state: { messages: [] as Array<{ role: string; content: string }> },
        prompt: vi.fn(async function (this: { state?: { messages?: Array<{ role: string; content: string }> } }, message: string) {
          options?.onText?.("mock-ai-output");
          const messages = this.state?.messages ?? [];
          messages.push({ role: "user", content: message });
          messages.push({
            role: "assistant",
            content: JSON.stringify({
              subtasks: [
                { id: "subtask-1", title: "Auth backend", description: "Implement backend", suggestedSize: "M", dependsOn: [] },
                { id: "subtask-2", title: "Auth UI", description: "Implement UI", suggestedSize: "S", dependsOn: ["subtask-1"] },
              ],
            }),
          });
        }),
        dispose: vi.fn(),
      },
    })),
    promptWithFallback: vi.fn(async (session: { prompt: (message: string) => Promise<void> }, prompt: string) => {
      await session.prompt(prompt);
    }),
  });
});

type BranchGroup = {
  id: string;
  sourceType: "planning" | "mission" | "new-task";
  sourceId: string;
  branchName: string;
  autoMerge: boolean;
  prState: "none";
  status: "open";
  createdAt: number;
  updatedAt: number;
};

function createMockStore(): TaskStore {
  const tasks = new Map<string, { id: string; title?: string; description: string; branch?: string; branchContext?: TaskBranchContext }>();
  const branchGroupsBySource = new Map<string, BranchGroup>();
  const branchGroupsByBranch = new Map<string, BranchGroup>();
  let seq = 7000;

  const store = {
    getTask: vi.fn(async (id: string) => tasks.get(id) ?? null),
    listTasks: vi.fn().mockResolvedValue([]),
    searchTasks: vi.fn().mockResolvedValue([]),
    findRecentTasksByContentFingerprint: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(async (input: TaskCreateInput) => {
      seq += 1;
      const id = `FN-${seq}`;
      const created = {
        id,
        title: input.title,
        description: input.description,
        column: input.column ?? "triage",
        dependencies: input.dependencies ?? [],
        steps: [],
        currentStep: 0,
        log: [],
        branch: input.branch,
        branchContext: input.branchContext,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      tasks.set(id, created);
      return created;
    }),
    createTaskWithReservedId: undefined,
    moveTask: vi.fn(),
    updateTask: vi.fn(async (id: string, patch: { branch?: string; branchContext?: TaskBranchContext }) => {
      const existing = tasks.get(id);
      if (!existing) throw new Error("missing");
      const next = { ...existing, ...patch };
      tasks.set(id, next);
      return next;
    }),
    updateStep: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({ defaultBranch: "main", autoMerge: false }),
    getSettingsFast: vi.fn().mockResolvedValue({ defaultBranch: "main", autoMerge: false }),
    updateSettings: vi.fn(),
    updateGlobalSettings: vi.fn(),
    getSettingsByScope: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getSettingsByScopeFast: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getGlobalSettingsStore: vi.fn().mockReturnValue({
      getSettings: vi.fn().mockResolvedValue({}),
      updateSettings: vi.fn().mockResolvedValue({}),
      getSettingsPath: vi.fn().mockReturnValue("/fake/home/.fusion/settings.json"),
      init: vi.fn().mockResolvedValue(false),
      invalidateCache: vi.fn(),
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    getAgentLogCount: vi.fn().mockResolvedValue(0),
    getAgentLogsByTimeRange: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    addTaskComment: vi.fn(),
    updateTaskComment: vi.fn(),
    deleteTaskComment: vi.fn(),
    getTaskDocuments: vi.fn().mockResolvedValue([]),
    getTaskDocument: vi.fn().mockResolvedValue(null),
    getTaskDocumentRevisions: vi.fn().mockResolvedValue([]),
    getAllDocuments: vi.fn().mockResolvedValue([]),
    upsertTaskDocument: vi.fn(),
    deleteTaskDocument: vi.fn().mockResolvedValue(undefined),
    updatePrInfo: vi.fn().mockResolvedValue(undefined),
    updateIssueInfo: vi.fn().mockResolvedValue(undefined),
    linkGithubIssue: vi.fn().mockResolvedValue(undefined),
    recordActivity: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    getDistributedTaskIdAllocator: vi.fn().mockReturnValue({
      reserveDistributedTaskId: vi.fn().mockResolvedValue({ reservationId: "res-1", taskId: "FN-8001" }),
      commitDistributedTaskIdReservation: vi.fn().mockResolvedValue({}),
      abortDistributedTaskIdReservation: vi.fn().mockResolvedValue({}),
    }),
    ensureBranchGroupForSource: vi.fn((sourceType: "planning" | "mission" | "new-task", sourceId: string, init: { branchName: string; autoMerge?: boolean }) => {
      const key = `${sourceType}:${sourceId}`;
      const existing = branchGroupsBySource.get(key);
      if (existing) return existing;
      const group: BranchGroup = {
        id: `BG-${sourceType}-${sourceId}`,
        sourceType,
        sourceId,
        branchName: init.branchName,
        autoMerge: Boolean(init.autoMerge),
        prState: "none",
        status: "open",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      branchGroupsBySource.set(key, group);
      branchGroupsByBranch.set(init.branchName, group);
      return group;
    }),
    getBranchGroupBySource: vi.fn((sourceType: "planning" | "mission" | "new-task", sourceId: string) => branchGroupsBySource.get(`${sourceType}:${sourceId}`) ?? null),
    getBranchGroupByBranchName: vi.fn((name: string) => branchGroupsByBranch.get(name) ?? null),
    setTaskBranchGroup: vi.fn(async (taskId: string, groupId: string) => {
      const task = tasks.get(taskId);
      if (!task) return;
      const group = [...branchGroupsBySource.values()].find((candidate) => candidate.id === groupId);
      if (!group) return;
      tasks.set(taskId, {
        ...task,
        branchContext: {
          groupId,
          source: group.sourceType,
          assignmentMode: "shared",
        },
      });
    }),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    createWorkflowStep: vi.fn(),
    getWorkflowStep: vi.fn(),
    updateWorkflowStep: vi.fn(),
    deleteWorkflowStep: vi.fn(),
    getMissionStore: vi.fn().mockReturnValue({
      listMissions: vi.fn().mockReturnValue([]),
      createMission: vi.fn(),
      getMissionWithHierarchy: vi.fn(),
      updateMission: vi.fn(),
      getMission: vi.fn(),
      deleteMission: vi.fn(),
      listMilestonesByMission: vi.fn().mockReturnValue([]),
      createMilestone: vi.fn(),
      updateMilestone: vi.fn(),
      getMilestone: vi.fn(),
      deleteMilestone: vi.fn(),
      listTasksByMilestone: vi.fn().mockReturnValue([]),
      createMissionTask: vi.fn(),
      updateMissionTask: vi.fn(),
      getMissionTask: vi.fn(),
      deleteMissionTask: vi.fn(),
    }),
  };

  return store as unknown as TaskStore;
}

async function REQUEST(app: express.Express, method: string, path: string, body?: unknown) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const res = await performRequest(app, method, path, payload, { "Content-Type": "application/json" });
  return { status: res.status, body: res.body };
}

/**
 * ## Surface Enumeration
 * Surfaces over which this regression spec proves the shared branch-group
 * entry-point invariant (shared-mode tasks work on per-task-derived branches
 * while the shared branch is only a merge target, and group membership identity
 * is stamped consistently):
 * - Providers / execution paths (dashboard entry points that create or assign
 *   branch-group members): planning/subtasks streaming start, new-task creation
 *   in shared mode, and the assignment paths exercised through
 *   `store.createTask`, `ensureBranchGroupForSource`,
 *   `getBranchGroupByBranchName`, `setTaskBranchGroup`, and `updateTask`.
 * - Assignment modes / data states: shared, project-default, existing,
 *   custom-new, auto-new, and per-task-derived sources.
 * - Shared modules/helpers reusing the logic: the branch-name derivation and
 *   `branchContext.groupId` membership-identity helpers shared with the core
 *   entry-point spec, so the invariant cannot drift between dashboard and core.
 * - Breakpoints/platforms: N/A — these are HTTP route/store invariants with no
 *   UI rendering surface.
 *
 * NOTE: two per-task-derived-derivation cases in this file are known
 * pre-existing failures tracked separately; this enumeration documents the
 * intended surface coverage and does not alter those assertions.
 */
describe("shared branch-group entry-point invariants", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("keeps planning/subtasks + new-task shared mode on per-task working branches", async () => {
    const app = buildApp();

    const subtaskStart = await REQUEST(app, "POST", "/api/subtasks/start-streaming", { description: "Break down auth scope" });
    expect(subtaskStart.status).toBe(201);
    const sessionId = subtaskStart.body.sessionId as string;

    const subtaskCreate = await REQUEST(app, "POST", "/api/subtasks/create-tasks", {
      sessionId,
      branchSelection: { mode: "custom-new", branchName: "feature/auth-shared", baseBranch: "main" },
      branchAssignment: { mode: "shared" },
      subtasks: [
        { tempId: "temp-1", title: "Auth backend", description: "Implement backend" },
        { tempId: "temp-2", title: "Auth UI", description: "Implement UI", dependsOn: ["temp-1"] },
      ],
    });

    expect(subtaskCreate.status).toBe(201);
    const planningCalls = (store.createTask as ReturnType<typeof vi.fn>).mock.calls;
    const firstPlanning = planningCalls[0]?.[0] as TaskCreateInput;
    const secondPlanning = planningCalls[1]?.[0] as TaskCreateInput;
    expect(firstPlanning.branch).toBe("feature/auth-shared/auth-backend");
    expect(secondPlanning.branch).toBe("feature/auth-shared/auth-ui");
    expect(firstPlanning.branch).not.toBe("feature/auth-shared");
    expect(secondPlanning.branch).not.toBe("feature/auth-shared");
    expect(firstPlanning.branch).not.toBe(secondPlanning.branch);
    // U1: the real BG- id is stamped into branchContext.groupId so listTasksByBranchGroup(group.id) resolves members.
    const ensuredPlanningGroup = (store.ensureBranchGroupForSource as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value as BranchGroup;
    expect(ensuredPlanningGroup.id).toBe(`BG-planning-${sessionId}`);
    expect(ensuredPlanningGroup.branchName).toBe("feature/auth-shared");
    expect(firstPlanning.branchContext).toMatchObject({ groupId: ensuredPlanningGroup.id, source: "planning", assignmentMode: "shared" });
    expect(secondPlanning.branchContext).toMatchObject({ groupId: ensuredPlanningGroup.id, source: "planning", assignmentMode: "shared" });
    expect(firstPlanning.branchContext?.groupId).not.toBe(`planning:${sessionId}`);

    const newTask = await REQUEST(app, "POST", "/api/tasks", {
      title: "Shared entry-point task",
      description: "Task using shared group",
      branchSelection: { mode: "shared-group", branchName: "feature/newtask-shared" },
    });

    expect(newTask.status).toBe(201);
    const newTaskCreateCall = (store.createTask as ReturnType<typeof vi.fn>).mock.calls[2]?.[0] as TaskCreateInput;
    const newTaskGroup = (store.getBranchGroupByBranchName as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value as BranchGroup | null;
    expect(newTaskCreateCall.branch).toBeUndefined();
    expect(newTaskCreateCall.branchContext).toBeUndefined();
    const createdTaskId = newTask.body.id as string;
    const persistedTask = await store.getTask(createdTaskId);
    expect(persistedTask?.branchContext).toMatchObject({ source: "new-task", assignmentMode: "shared" });
    const joinedGroupId = (store.setTaskBranchGroup as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as string;
    expect(joinedGroupId).toBe(persistedTask?.branchContext?.groupId);
    expect(newTaskGroup).toBeNull();
  });

  it("preserves non-shared selection semantics", async () => {
    const app = buildApp();

    const perTaskDerivedStart = await REQUEST(app, "POST", "/api/subtasks/start-streaming", { description: "Break down auth scope" });
    const perTaskDerivedSessionId = perTaskDerivedStart.body.sessionId as string;
    await REQUEST(app, "POST", "/api/subtasks/create-tasks", {
      sessionId: perTaskDerivedSessionId,
      branchSelection: { mode: "custom-new", branchName: "feature/auth-shared", baseBranch: "main" },
      branchAssignment: { mode: "per-task-derived" },
      subtasks: [
        { tempId: "temp-1", title: "Auth backend", description: "Implement backend" },
      ],
    });

    await REQUEST(app, "POST", "/api/tasks", { description: "project default", branchSelection: { mode: "project-default" } });
    await REQUEST(app, "POST", "/api/tasks", { description: "existing", branchSelection: { mode: "existing", branchName: "feature/existing", baseBranch: "main" } });
    await REQUEST(app, "POST", "/api/tasks", { description: "custom", branchSelection: { mode: "custom-new", branchName: "feature/custom", baseBranch: "main" } });
    await REQUEST(app, "POST", "/api/tasks", { title: "Auto task", description: "auto", branchSelection: { mode: "auto-new" } });

    const calls = (store.createTask as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as TaskCreateInput);
    expect(calls[0].branch).toBe("feature/auth-shared/auth-backend");
    expect(calls[0].branchContext).toMatchObject({ assignmentMode: "per-task-derived", source: "planning" });

    expect(calls[1].branch).toBeUndefined();
    expect(calls[1].branchContext).toBeUndefined();

    expect(calls[2].branch).toBe("feature/existing");
    expect(calls[2].branchContext).toBeUndefined();

    expect(calls[3].branch).toBe("feature/custom");
    expect(calls[3].branchContext).toBeUndefined();

    expect(calls[4].branch).toBeUndefined();
    expect((store.updateTask as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]).toMatchObject({
      branch: expect.stringMatching(/^fusion\/fn-/),
    });

    expect(store.ensureBranchGroupForSource).not.toHaveBeenCalled();
  });
});
