import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { TaskStore } from "@fusion/core";
import { GitHubTrackingStateService } from "../github-tracking-state.js";
import { createApiRoutes } from "../routes.js";
import { request as performRequest } from "../test-request.js";

type GitHubIssueActionPayload = Record<string, unknown>;
type StoreEventApi = {
  on: (event: string, listener: (payload: GitHubIssueActionPayload) => void) => void;
  off: (event: string, listener: (payload: GitHubIssueActionPayload) => void) => void;
};

const { mockSetIssueState, mockGetIssue, mockResolveGithubTrackingAuth } = vi.hoisted(() => ({
  mockSetIssueState: vi.fn(),
  mockGetIssue: vi.fn(),
  mockResolveGithubTrackingAuth: vi.fn(),
}));

vi.mock("../github.js", () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({
    setIssueState: (...args: unknown[]) => mockSetIssueState(...args),
    getIssue: (...args: unknown[]) => mockGetIssue(...args),
  })),
}));

vi.mock("../github-auth.js", () => ({
  resolveGithubTrackingAuth: (...args: unknown[]) => mockResolveGithubTrackingAuth(...args),
}));

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-dashboard-github-tracking-delete-test-"));
}

function waitForGithubIssueAction(
  store: TaskStore,
  predicate: (payload: GitHubIssueActionPayload) => boolean,
  { timeoutMs = 2_000, timeoutMessage = "Timed out waiting for github-issue:action event" } = {},
): Promise<GitHubIssueActionPayload> {
  const eventStore = store as unknown as StoreEventApi;

  return new Promise((resolve, reject) => {
    const onAction = (payload: GitHubIssueActionPayload) => {
      if (!predicate(payload)) {
        return;
      }

      clearTimeout(timeoutId);
      eventStore.off("github-issue:action", onAction);
      resolve(payload);
    };

    const timeoutId = setTimeout(() => {
      eventStore.off("github-issue:action", onAction);
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    eventStore.on("github-issue:action", onAction);
  });
}

async function expectNoGithubIssueAction(
  store: TaskStore,
  predicate: (payload: GitHubIssueActionPayload) => boolean,
  timeoutMessage: string,
): Promise<void> {
  await expect(
    waitForGithubIssueAction(store, predicate, {
      timeoutMs: 150,
      timeoutMessage,
    }),
  ).rejects.toThrow(timeoutMessage);
}

async function requestDelete(app: express.Express, path: string): Promise<{ status: number; body: any }> {
  const res = await performRequest(app, "DELETE", path);
  return { status: res.status, body: res.body };
}

describe("github tracking delete flow", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;
  let stateService: GitHubTrackingStateService;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "token" } });
    mockGetIssue.mockResolvedValue({ state: "open" });
    rootDir = makeTmpDir();
    globalDir = makeTmpDir();
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
    stateService = new GitHubTrackingStateService(store);
    stateService.start();
  });

  afterEach(async () => {
    stateService.stop();
    store.close();
    await rm(rootDir, { recursive: true, force: true });
    await rm(globalDir, { recursive: true, force: true });
  });

  it("closes the linked issue as not_planned when a tracked task is deleted", async () => {
    const task = await store.createTask({
      description: "delete tracked task",
      githubTracking: { enabled: true },
    });

    await store.linkGithubIssue(task.id, {
      owner: "octocat",
      repo: "hello-world",
      number: 7,
      url: "https://github.com/octocat/hello-world/issues/7",
      createdAt: new Date().toISOString(),
    });

    const closeAction = waitForGithubIssueAction(
      store,
      (payload) => payload.taskId === task.id && payload.action === "close" && payload.outcome === "success",
      { timeoutMessage: `Timed out waiting for close action for deleted task ${task.id}` },
    );

    await store.deleteTask(task.id);
    await closeAction;

    expect(mockSetIssueState).toHaveBeenCalledTimes(1);
    expect(mockSetIssueState).toHaveBeenCalledWith("octocat", "hello-world", 7, "closed", "not_planned");
  });

  it("does not call GitHub when deleting a task with tracking disabled", async () => {
    const task = await store.createTask({
      description: "delete untracked task",
      githubTracking: { enabled: false },
    });

    await store.deleteTask(task.id);
    await expectNoGithubIssueAction(
      store,
      (payload) => payload.taskId === task.id,
      `Unexpected github-issue:action event for tracking-disabled deleted task ${task.id}`,
    );

    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("does not call GitHub when deleting a tracked task without a linked issue", async () => {
    const task = await store.createTask({
      description: "delete tracked task without issue",
      githubTracking: { enabled: true },
    });

    await store.deleteTask(task.id);
    await expectNoGithubIssueAction(
      store,
      (payload) => payload.taskId === task.id,
      `Unexpected github-issue:action event for deleted task without linked issue ${task.id}`,
    );

    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("closes linked issue when delete receives explicit githubIssueAction=close", async () => {
    const task = await store.createTask({
      description: "delete tracked task with explicit close",
      githubTracking: { enabled: true },
    });

    await store.linkGithubIssue(task.id, {
      owner: "octocat",
      repo: "hello-world",
      number: 10,
      url: "https://github.com/octocat/hello-world/issues/10",
      createdAt: new Date().toISOString(),
    });

    const closeAction = waitForGithubIssueAction(
      store,
      (payload) => payload.taskId === task.id && payload.action === "close" && payload.outcome === "success",
      { timeoutMessage: `Timed out waiting for explicit close action for deleted task ${task.id}` },
    );

    await store.deleteTask(task.id, { githubIssueAction: "close" });
    await closeAction;

    expect(mockSetIssueState).toHaveBeenCalledWith("octocat", "hello-world", 10, "closed", "not_planned");
  });

  it("does not report failed close when task is done then deleted", async () => {
    const task = await store.createTask({
      description: "done then deleted task",
      githubTracking: { enabled: true },
    });

    await store.linkGithubIssue(task.id, {
      owner: "octocat",
      repo: "hello-world",
      number: 11,
      url: "https://github.com/octocat/hello-world/issues/11",
      createdAt: new Date().toISOString(),
    });

    await store.moveTask(task.id, "done");
    mockSetIssueState.mockClear();
    mockGetIssue.mockResolvedValue({ state: "closed" });

    const skippedCloseAction = waitForGithubIssueAction(
      store,
      (payload) => payload.taskId === task.id && payload.action === "close" && payload.outcome === "skipped",
      { timeoutMessage: `Timed out waiting for skipped close action for deleted task ${task.id}` },
    );

    await store.deleteTask(task.id);
    await skippedCloseAction;

    expect(mockSetIssueState).not.toHaveBeenCalled();
    await expectNoGithubIssueAction(
      store,
      (payload) => payload.taskId === task.id && payload.action === "close" && payload.outcome === "failed",
      `Unexpected failed close action for done-then-deleted task ${task.id}`,
    );
  });

  it("route delete uses same store instance observed by tracking state service", async () => {
    const task = await store.createTask({
      description: "route delete tracked task",
      githubTracking: { enabled: true },
    });

    await store.linkGithubIssue(task.id, {
      owner: "octocat",
      repo: "hello-world",
      number: 12,
      url: "https://github.com/octocat/hello-world/issues/12",
      createdAt: new Date().toISOString(),
    });

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    const closeAction = waitForGithubIssueAction(
      store,
      (payload) => payload.taskId === task.id && payload.action === "close" && payload.outcome === "success",
      { timeoutMessage: `Timed out waiting for route close action for deleted task ${task.id}` },
    );

    const response = await requestDelete(app, `/api/tasks/${task.id}?githubIssueAction=close`);
    expect(response.status).toBe(200);

    await closeAction;
    expect(mockSetIssueState).toHaveBeenCalledWith("octocat", "hello-world", 12, "closed", "not_planned");
  });

  it("does not trigger an unhandled rejection when closing linked issue fails on delete", async () => {
    const task = await store.createTask({
      description: "delete tracked task with close failure",
      githubTracking: { enabled: true },
    });

    await store.linkGithubIssue(task.id, {
      owner: "octocat",
      repo: "hello-world",
      number: 8,
      url: "https://github.com/octocat/hello-world/issues/8",
      createdAt: new Date().toISOString(),
    });

    mockSetIssueState.mockRejectedValueOnce(new Error("close failed"));
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const failedCloseAction = waitForGithubIssueAction(
        store,
        (payload) => payload.taskId === task.id && payload.action === "close" && payload.outcome === "failed",
        { timeoutMessage: `Timed out waiting for failed close action for deleted task ${task.id}` },
      );

      await store.deleteTask(task.id);
      await failedCloseAction;

      expect(mockSetIssueState).toHaveBeenCalledWith("octocat", "hello-world", 8, "closed", "not_planned");
      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("emits github issue action event on successful close-on-delete", async () => {
    const task = await store.createTask({
      description: "delete tracked task emits github issue close event",
      githubTracking: { enabled: true },
    });

    await store.linkGithubIssue(task.id, {
      owner: "octocat",
      repo: "hello-world",
      number: 9,
      url: "https://github.com/octocat/hello-world/issues/9",
      createdAt: new Date().toISOString(),
    });

    const events: Array<Record<string, unknown>> = [];
    const eventStore = store as unknown as StoreEventApi;
    const onAction = (payload: Record<string, unknown>) => {
      events.push(payload);
    };
    eventStore.on("github-issue:action", onAction);

    try {
      const closeAction = waitForGithubIssueAction(
        store,
        (payload) => payload.taskId === task.id && payload.action === "close" && payload.outcome === "success",
        { timeoutMessage: `Timed out waiting for emitted close action for deleted task ${task.id}` },
      );

      await store.deleteTask(task.id);
      await closeAction;
    } finally {
      eventStore.off("github-issue:action", onAction);
    }

    expect(events).toContainEqual({
      taskId: task.id,
      action: "close",
      owner: "octocat",
      repo: "hello-world",
      number: 9,
      outcome: "success",
    });
  });
});
