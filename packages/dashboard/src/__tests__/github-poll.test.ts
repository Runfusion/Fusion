import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrInfo, TaskStore } from "@kb/core";
import { GitHubPollingService, GitHubRateLimiter } from "../github-poll.js";

const getBadgeStatusesBatch = vi.fn();

vi.mock("../github.js", () => ({
  GitHubClient: vi.fn(() => ({
    getBadgeStatusesBatch,
  })),
}));

function createStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn(),
    updatePrInfo: vi.fn(),
    updateIssueInfo: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
}

function createPrInfo(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    url: "https://github.com/owner/repo/pull/1",
    number: 1,
    status: "open",
    title: "Test PR",
    headBranch: "feature/test",
    baseBranch: "main",
    commentCount: 0,
    lastCheckedAt: "2026-03-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("GitHubPollingService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds and removes task watches", () => {
    const poller = new GitHubPollingService();

    poller.watchTask("KB-063", "pr", "owner", "repo", 1);
    poller.watchTask("KB-063", "issue", "owner", "repo", 2);

    expect(poller.getWatch("KB-063")?.pr?.number).toBe(1);
    expect(poller.getWatch("KB-063")?.issue?.number).toBe(2);

    poller.unwatchTaskType("KB-063", "pr");
    expect(poller.getWatch("KB-063")?.pr).toBeUndefined();
    expect(poller.getWatch("KB-063")?.issue?.number).toBe(2);

    poller.unwatchTaskType("KB-063", "issue");
    expect(poller.getWatch("KB-063")).toBeUndefined();
  });

  it("does not write to the store when fetched badge data is unchanged", async () => {
    const task = {
      id: "KB-063",
      prInfo: createPrInfo(),
      issueInfo: undefined,
    };
    const updatePrInfo = vi.fn();
    const store = createStore({
      getTask: vi.fn().mockResolvedValue(task),
      updatePrInfo,
    });

    getBadgeStatusesBatch.mockResolvedValue({
      pr_1: {
        type: "pr",
        prInfo: createPrInfo({ lastCheckedAt: undefined }),
      },
    });

    const poller = new GitHubPollingService({
      store,
      rateLimiter: new GitHubRateLimiter({ maxRequests: 10 }),
    });

    poller.watchTask("KB-063", "pr", "owner", "repo", 1);
    await poller.pollOnce();

    expect(updatePrInfo).not.toHaveBeenCalled();
    expect(poller.getLastCheckedAt("KB-063", "pr")).toMatch(/^2026|^20/);
  });

  it("updates PR info when comment metadata changes", async () => {
    const task = {
      id: "KB-063",
      prInfo: createPrInfo({ commentCount: 0 }),
      issueInfo: undefined,
    };
    const updatePrInfo = vi.fn().mockResolvedValue(undefined);
    const store = createStore({
      getTask: vi.fn().mockResolvedValue(task),
      updatePrInfo,
    });

    getBadgeStatusesBatch.mockResolvedValue({
      pr_1: {
        type: "pr",
        prInfo: createPrInfo({ commentCount: 2, lastCommentAt: "2026-03-30T12:00:00.000Z", lastCheckedAt: undefined }),
      },
    });

    const poller = new GitHubPollingService({
      store,
      rateLimiter: new GitHubRateLimiter({ maxRequests: 10 }),
    });

    poller.watchTask("KB-063", "pr", "owner", "repo", 1);
    await poller.pollOnce();

    expect(updatePrInfo).toHaveBeenCalledTimes(1);
    expect(updatePrInfo.mock.calls[0][1]).toMatchObject({
      commentCount: 2,
      lastCommentAt: "2026-03-30T12:00:00.000Z",
    });
    expect(updatePrInfo.mock.calls[0][1]?.lastCheckedAt).toBeTruthy();
  });

  it("deduplicates repo batch requests for shared resources", async () => {
    const store = createStore({
      getTask: vi.fn().mockImplementation(async (taskId: string) => ({
        id: taskId,
        prInfo: createPrInfo(),
        issueInfo: undefined,
      })),
      updatePrInfo: vi.fn().mockResolvedValue(undefined),
    });

    getBadgeStatusesBatch.mockResolvedValue({
      pr_1: {
        type: "pr",
        prInfo: createPrInfo({ lastCheckedAt: undefined }),
      },
    });

    const poller = new GitHubPollingService({
      store,
      rateLimiter: new GitHubRateLimiter({ maxRequests: 10 }),
    });

    poller.watchTask("KB-063", "pr", "owner", "repo", 1);
    poller.watchTask("KB-064", "pr", "owner", "repo", 1);

    await poller.pollOnce();

    expect(getBadgeStatusesBatch).toHaveBeenCalledTimes(1);
    expect(getBadgeStatusesBatch.mock.calls[0][2]).toEqual([
      { alias: "pr_1", type: "pr", number: 1 },
    ]);
  });

  it("skips polling when the shared rate limiter denies the request", async () => {
    const store = createStore({
      getTask: vi.fn().mockResolvedValue({
        id: "KB-063",
        prInfo: createPrInfo(),
        issueInfo: undefined,
      }),
      updatePrInfo: vi.fn(),
    });

    const poller = new GitHubPollingService({
      store,
      rateLimiter: new GitHubRateLimiter({ maxRequests: 0 }),
    });

    poller.watchTask("KB-063", "pr", "owner", "repo", 1);
    await poller.pollOnce();

    expect(getBadgeStatusesBatch).not.toHaveBeenCalled();
  });

  it("updates issue info when badge-relevant issue fields change", async () => {
    const updateIssueInfo = vi.fn().mockResolvedValue(undefined);
    const store = createStore({
      getTask: vi.fn().mockResolvedValue({
        id: "KB-063",
        prInfo: undefined,
        issueInfo: {
          url: "https://github.com/owner/repo/issues/2",
          number: 2,
          state: "closed",
          title: "Tracked issue",
          stateReason: "reopened",
          lastCheckedAt: "2026-03-30T00:00:00.000Z",
        },
      }),
      updateIssueInfo,
    });

    getBadgeStatusesBatch.mockResolvedValue({
      issue_2: {
        type: "issue",
        issueInfo: {
          url: "https://github.com/owner/repo/issues/2",
          number: 2,
          state: "closed",
          title: "Tracked issue",
          stateReason: "completed",
        },
      },
    });

    const poller = new GitHubPollingService({
      store,
      rateLimiter: new GitHubRateLimiter({ maxRequests: 10 }),
    });

    poller.watchTask("KB-063", "issue", "owner", "repo", 2);
    await poller.pollOnce();

    expect(updateIssueInfo).toHaveBeenCalledTimes(1);
    expect(updateIssueInfo.mock.calls[0][1]).toMatchObject({
      stateReason: "completed",
    });
    expect(updateIssueInfo.mock.calls[0][1]?.lastCheckedAt).toBeTruthy();
  });

  it("keeps watches on transient task load failures", async () => {
    const store = createStore({
      getTask: vi.fn().mockRejectedValue(new Error("temporary parse error")),
      updatePrInfo: vi.fn(),
    });

    getBadgeStatusesBatch.mockResolvedValue({
      pr_1: {
        type: "pr",
        prInfo: createPrInfo({ lastCheckedAt: undefined }),
      },
    });

    const poller = new GitHubPollingService({
      store,
      rateLimiter: new GitHubRateLimiter({ maxRequests: 10 }),
    });

    poller.watchTask("KB-063", "pr", "owner", "repo", 1);
    await poller.pollOnce();

    expect(poller.getWatch("KB-063")).toBeDefined();
    expect(poller.getLastCheckedAt("KB-063", "pr")).toBeUndefined();
  });

  it("does not clear badge links on ambiguous null batch responses", async () => {
    const updatePrInfo = vi.fn();
    const store = createStore({
      getTask: vi.fn().mockResolvedValue({
        id: "KB-063",
        prInfo: createPrInfo(),
        issueInfo: undefined,
      }),
      updatePrInfo,
    });

    getBadgeStatusesBatch.mockResolvedValue({
      pr_1: null,
    });

    const poller = new GitHubPollingService({
      store,
      rateLimiter: new GitHubRateLimiter({ maxRequests: 10 }),
    });

    poller.watchTask("KB-063", "pr", "owner", "repo", 1);
    await poller.pollOnce();

    expect(updatePrInfo).not.toHaveBeenCalled();
    expect(poller.getWatch("KB-063")).toBeDefined();
    expect(poller.getLastCheckedAt("KB-063", "pr")).toBeUndefined();
  });

  it("unwatches tasks that can no longer be loaded", async () => {
    const store = createStore({
      getTask: vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" })),
      updatePrInfo: vi.fn(),
    });

    getBadgeStatusesBatch.mockResolvedValue({
      pr_1: {
        type: "pr",
        prInfo: createPrInfo({ lastCheckedAt: undefined }),
      },
    });

    const poller = new GitHubPollingService({
      store,
      rateLimiter: new GitHubRateLimiter({ maxRequests: 10 }),
    });

    poller.watchTask("KB-063", "pr", "owner", "repo", 1);
    await poller.pollOnce();

    expect(poller.getWatch("KB-063")).toBeUndefined();
  });
});
