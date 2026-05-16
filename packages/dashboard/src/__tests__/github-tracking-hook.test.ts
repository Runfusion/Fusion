import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, setTaskCreatedHook } from "@fusion/core";

const { mockCreateIssue, mockResolveGithubTrackingAuth } = vi.hoisted(() => ({
  mockCreateIssue: vi.fn(),
  mockResolveGithubTrackingAuth: vi.fn(),
}));

vi.mock("../github.js", () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({
    createIssue: (...args: unknown[]) => mockCreateIssue(...args),
  })),
}));

vi.mock("../github-auth.js", () => ({
  resolveGithubTrackingAuth: (...args: unknown[]) => mockResolveGithubTrackingAuth(...args),
}));

import { createTrackingIssueForTask, registerGithubTrackingHook } from "../github-tracking-hook.js";
import * as githubTracking from "../github-tracking.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-dashboard-github-tracking-hook-test-"));
}

describe("registerGithubTrackingHook", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    setTaskCreatedHook(undefined);
    vi.clearAllMocks();
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "tok" } });
    mockCreateIssue.mockResolvedValue({
      owner: "o",
      repo: "r",
      number: 42,
      htmlUrl: "https://github.com/o/r/issues/42",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    rootDir = makeTmpDir();
    globalDir = makeTmpDir();
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(async () => {
    setTaskCreatedHook(undefined);
    store.close();
    await rm(rootDir, { recursive: true, force: true });
    await rm(globalDir, { recursive: true, force: true });
  });

  it("creates a tracking issue when githubTracking.enabled is true and repo is configured", async () => {
    registerGithubTrackingHook();

    await store.updateSettings({
      githubTrackingDefaultRepo: "o/r",
      githubAuthMode: "token",
      githubAuthToken: "tok",
    });

    const task = await store.createTask({
      description: "test task",
      title: "Test task",
      githubTracking: { enabled: true },
    });

    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
    expect(mockCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", title: expect.stringContaining(task.id) }),
    );
  });

  it("is a no-op when githubTracking is not enabled", async () => {
    registerGithubTrackingHook();

    await store.createTask({
      description: "no tracking",
      title: "No tracking",
    });

    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("is a no-op when task already has a linked issue", async () => {
    registerGithubTrackingHook();

    await store.updateSettings({
      githubTrackingDefaultRepo: "o/r",
      githubAuthMode: "token",
      githubAuthToken: "tok",
    });

    const task = await store.createTask({
      description: "already linked",
      title: "Already linked",
      githubTracking: {
        enabled: true,
        issue: { owner: "o", repo: "r", number: 1, url: "https://github.com/o/r/issues/1" },
      },
    });

    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("does not propagate hook errors out of createTask", async () => {
    mockCreateIssue.mockRejectedValue(new Error("Octokit failure"));
    registerGithubTrackingHook();

    await store.updateSettings({
      githubTrackingDefaultRepo: "o/r",
      githubAuthMode: "token",
      githubAuthToken: "tok",
    });

    // Should NOT throw — best-effort contract
    const task = await store.createTask({
      description: "will fail gracefully",
      title: "Graceful failure",
      githubTracking: { enabled: true },
    });

    expect(task.id).toMatch(/^FN-/);
    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
  });

  it("creates one issue total across hook execution and follow-up stale reference call", async () => {
    registerGithubTrackingHook();

    await store.updateSettings({
      githubTrackingDefaultRepo: "o/r",
      githubAuthMode: "token",
      githubAuthToken: "tok",
    });

    const createdTask = await store.createTask({
      description: "stale follow up",
      title: "Stale follow up",
      githubTracking: { enabled: true },
    });

    const staleTaskRef = { ...createdTask, githubTracking: { enabled: true } };
    const projectSettings = await store.getSettings();

    const result = await githubTracking.maybeCreateTrackingIssue(staleTaskRef, {
      taskStore: store,
      projectSettings,
      globalSettings: {},
      rootDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(result).toEqual({ created: false, reason: "issue_already_linked" });
    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
  });

  it("passes request token when settings token is missing", async () => {
    const task = await store.createTask({
      description: "token override",
      githubTracking: { enabled: true },
    });

    const spy = vi.spyOn(githubTracking, "maybeCreateTrackingIssue").mockResolvedValue({
      created: false,
      reason: "tracking_disabled",
    });

    await createTrackingIssueForTask(store, task, { githubToken: "request-token" });

    expect(spy).toHaveBeenCalledWith(
      task,
      expect.objectContaining({
        projectSettings: expect.objectContaining({ githubAuthToken: "request-token" }),
      }),
    );
    spy.mockRestore();
  });

  it("prefers settings token over request token", async () => {
    await store.updateSettings({ githubAuthToken: "settings-token" });
    const task = await store.createTask({
      description: "token precedence",
      githubTracking: { enabled: true },
    });

    const spy = vi.spyOn(githubTracking, "maybeCreateTrackingIssue").mockResolvedValue({
      created: false,
      reason: "tracking_disabled",
    });

    await createTrackingIssueForTask(store, task, { githubToken: "request-token" });

    expect(spy).toHaveBeenCalledWith(
      task,
      expect.objectContaining({
        projectSettings: expect.objectContaining({ githubAuthToken: "settings-token" }),
      }),
    );
    spy.mockRestore();
  });

  it("swallows maybeCreateTrackingIssue errors", async () => {
    const task = await store.createTask({
      description: "best effort",
      githubTracking: { enabled: true },
    });

    const spy = vi.spyOn(githubTracking, "maybeCreateTrackingIssue").mockRejectedValue(new Error("boom"));

    await expect(createTrackingIssueForTask(store, task)).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
