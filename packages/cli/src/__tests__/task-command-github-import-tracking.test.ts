import { beforeEach, describe, expect, it, vi } from "vitest";

const taskStoreCtorMock = vi.hoisted(() => vi.fn());
const runGhJsonAsyncMock = vi.hoisted(() => vi.fn());
const resolveProjectMock = vi.hoisted(() => vi.fn());

vi.mock("@fusion/core", async (importActual) => {
  const actual = await importActual<typeof import("@fusion/core")>();
  return {
    ...actual,
    TaskStore: taskStoreCtorMock,
  };
});

vi.mock("@fusion/core/gh-cli", () => ({
  isGhAvailable: vi.fn(() => true),
  isGhAuthenticated: vi.fn(() => true),
  runGhJsonAsync: runGhJsonAsyncMock,
  getGhErrorMessage: vi.fn((error: unknown) => (error instanceof Error ? error.message : String(error))),
}));

// FNXC:CliBoardMutation 2026-07-09-00:00: task.ts imports closeProjectStore +
// asLocalProjectContext from project-context; stub both so the whole-module
// mock stays accurate as task.ts's project-context surface grows.
vi.mock("../project-context.js", () => ({
  resolveProject: resolveProjectMock,
  closeProjectStore: vi.fn(async (context: { store: { close?: () => unknown } }) => {
    try {
      await context.store.close?.();
    } catch {
      // best-effort, mirrors production closeProjectStore
    }
  }),
  asLocalProjectContext: vi.fn((store: unknown) => ({
    projectId: process.cwd(),
    projectPath: process.cwd(),
    projectName: "current-project",
    isRegistered: false,
    store,
  })),
}));

vi.mock("@fusion/dashboard", () => ({
  registerGithubTrackingHook: vi.fn(),
}));

vi.mock("@fusion/engine", () => ({
  createFnAgent: vi.fn(),
  runAiMerge: vi.fn(),
  landWorkspaceTask: vi.fn(),
}));

vi.mock("@fusion/dashboard/planning", () => ({
  createSession: vi.fn(),
  submitResponse: vi.fn(),
  RateLimitError: class RateLimitError extends Error {},
  SessionNotFoundError: class SessionNotFoundError extends Error {},
  InvalidSessionStateError: class InvalidSessionStateError extends Error {},
}));

import { runTaskImportFromGitHub } from "../commands/task.js";

describe("fn task import GitHub tracking defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    resolveProjectMock.mockRejectedValue(new Error("No project context"));
    runGhJsonAsyncMock.mockResolvedValue([
      {
        number: 1,
        title: "Imported Issue",
        body: "Imported issue body",
        html_url: "https://github.com/owner/repo/issues/1",
        labels: [],
      },
    ]);
  });

  function mockStore(options: { projectSettings?: Record<string, unknown>; globalSettings?: Record<string, unknown> } = {}) {
    const createTask = vi.fn().mockImplementation((input) => Promise.resolve({
      id: "FN-001",
      title: input.title,
      description: input.description,
      column: "triage",
    }));
    taskStoreCtorMock.mockImplementation(function () {
      return {
        init: vi.fn().mockResolvedValue(undefined),
        listTasks: vi.fn().mockResolvedValue([]),
        createTask,
        getSettings: vi.fn().mockResolvedValue(options.projectSettings ?? {}),
        getGlobalSettingsStore: vi.fn().mockReturnValue({
          getSettings: vi.fn().mockResolvedValue(options.globalSettings ?? {}),
        }),
      };
    });
    return { createTask };
  }

  it("sets githubTracking.enabled for fn task import when project tracking defaults are on", async () => {
    const { createTask } = mockStore({ projectSettings: { githubTrackingEnabledByDefault: true } });

    await runTaskImportFromGitHub("owner/repo", { limit: 1 });

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      githubTracking: { enabled: true },
      sourceIssue: expect.objectContaining({
        provider: "github",
        repository: "owner/repo",
        issueNumber: 1,
      }),
    }));
  });

  it("sets githubTracking.enabled for fn task import when global tracking defaults are on", async () => {
    const { createTask } = mockStore({ globalSettings: { githubTrackingDefaultEnabledForNewTasks: true } });

    await runTaskImportFromGitHub("owner/repo", { limit: 1 });

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      githubTracking: { enabled: true },
      sourceIssue: expect.objectContaining({ issueNumber: 1 }),
    }));
  });

  it("sets githubTracking.enabled for fn task import when import linking is on and new-task defaults are off", async () => {
    const { createTask } = mockStore({
      projectSettings: {
        githubTrackingEnabledByDefault: false,
        githubLinkImportedIssuesToTracking: true,
      },
    });

    await runTaskImportFromGitHub("owner/repo", { limit: 1 });

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      githubTracking: { enabled: true },
      sourceIssue: expect.objectContaining({ provider: "github", repository: "owner/repo", issueNumber: 1 }),
    }));
  });

  it("does not force githubTracking for fn task import when tracking defaults are off", async () => {
    const { createTask } = mockStore();

    await runTaskImportFromGitHub("owner/repo", { limit: 1 });

    expect(createTask).toHaveBeenCalledWith(expect.not.objectContaining({
      githubTracking: expect.anything(),
    }));
  });
});
