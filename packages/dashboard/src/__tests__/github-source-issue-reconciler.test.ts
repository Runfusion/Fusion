import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { GitHubTrackingReconciler } from "../github-tracking-reconciler.js";

const { mockGetIssue, mockSetIssueState } = vi.hoisted(() => ({
  mockGetIssue: vi.fn(),
  mockSetIssueState: vi.fn(),
}));

const { mockResolveGithubTrackingAuth } = vi.hoisted(() => ({
  mockResolveGithubTrackingAuth: vi.fn(),
}));

vi.mock("../github.js", () => ({
  GitHubClient: vi.fn().mockImplementation(function () { return {
    getIssue: (...args: unknown[]) => mockGetIssue(...args),
    setIssueState: (...args: unknown[]) => mockSetIssueState(...args),
  }; }),
}));

vi.mock("../github-auth.js", () => ({
  resolveGithubTrackingAuth: (...args: unknown[]) => mockResolveGithubTrackingAuth(...args),
}));

function createStore(listTasks: Array<Record<string, unknown>>, settings: Record<string, unknown> = { githubCloseSourceIssueOnDone: true, githubAuthMode: "token", githubAuthToken: "ghp_test" }): TaskStore {
  return {
    listTasks: vi.fn().mockResolvedValue(listTasks),
    listTasksForGithubTrackingReconcile: vi.fn().mockResolvedValue({ tasks: [], hasMore: false }),
    getSettings: vi.fn().mockResolvedValue(settings),
    getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn().mockResolvedValue({}) })),
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

describe("GitHubTrackingReconciler.reconcileSourceIssues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
    mockGetIssue.mockResolvedValue({ state: "open" });
  });

  it("short-circuits when setting disabled", async () => {
    const store = createStore([{ id: "FN-1", column: "done", sourceIssue: { provider: "github", repository: "o/r", issueNumber: 1 } }], { githubCloseSourceIssueOnDone: false });
    const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);
    expect(result).toEqual({ scanned: 1, closed: 0, skipped: 1, errors: 0 });
    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("closes open source issues", async () => {
    const store = createStore([{ id: "FN-1", column: "done", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 4 } }]);
    const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);
    expect(mockSetIssueState).toHaveBeenCalledWith("owner", "repo", 4, "closed", "completed");
    expect(result.closed).toBe(1);
  });

  it("skips already-closed source issues", async () => {
    mockGetIssue.mockResolvedValueOnce({ state: "closed" });
    const store = createStore([{ id: "FN-1", column: "done", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 4 } }]);
    const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);
    expect(result.skipped).toBe(1);
    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("skips source issues missing from GitHub", async () => {
    mockGetIssue.mockResolvedValueOnce(null);
    const store = createStore([{ id: "FN-12", column: "done", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 12 } }]);
    const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("ignores non-done tasks and tasks without sourceIssue", async () => {
    const store = createStore([
      { id: "FN-1", column: "todo", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 1 } },
      { id: "FN-2", column: "done" },
      { id: "FN-3", column: "done", sourceIssue: { provider: "jira", repository: "x/y", issueNumber: 3 } },
    ]);
    const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);
    expect(result).toEqual({ scanned: 0, closed: 0, skipped: 0, errors: 0 });
    expect(mockGetIssue).not.toHaveBeenCalled();
  });

  it("counts errors and logs on getIssue failure", async () => {
    mockGetIssue.mockRejectedValueOnce(new Error("boom"));
    const store = createStore([{ id: "FN-9", column: "done", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 9 } }]);
    const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);
    expect(result.errors).toBe(1);
    expect((store.logEntry as any)).toHaveBeenCalledWith("FN-9", "Failed to reconcile GitHub source issue", "boom");
  });

  it("counts errors and logs on setIssueState failure", async () => {
    mockSetIssueState.mockRejectedValueOnce(new Error("write failed"));
    const store = createStore([{ id: "FN-10", column: "done", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 10 } }]);
    const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);
    expect(result.errors).toBe(1);
    expect((store.logEntry as any)).toHaveBeenCalledWith("FN-10", "Failed to reconcile GitHub source issue", "write failed");
  });

  it("skips and logs when auth resolution fails", async () => {
    mockResolveGithubTrackingAuth.mockReturnValueOnce({ ok: false, message: "no auth" });
    const store = createStore([{ id: "FN-11", column: "done", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 11 } }]);
    const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);
    expect(result.skipped).toBe(1);
    expect((store.logEntry as any)).toHaveBeenCalledWith("FN-11", "Skipped GitHub source issue reconciliation", "no auth");
    expect(mockSetIssueState).not.toHaveBeenCalled();
  });
});

describe("GitHubTrackingReconciler.backfillSourceIssueClosedAt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
    mockGetIssue.mockResolvedValue({ state: "open" });
  });

  it("persists a real GitHub closed_at for done GitHub source issues missing closedAt", async () => {
    const closedAt = "2026-06-18T12:34:56.000Z";
    mockGetIssue.mockResolvedValueOnce({ state: "closed", closedAt });
    const sourceIssue = { provider: "github", repository: "owner/repo", issueNumber: 4, url: "https://github.com/owner/repo/issues/4" };
    const store = createStore([{ id: "FN-1", column: "done", sourceIssue }]);

    const result = await new GitHubTrackingReconciler().backfillSourceIssueClosedAt(store);

    expect(result).toEqual({ scanned: 1, filled: 1, skipped: 0, errors: 0, hasMore: false });
    expect(mockGetIssue).toHaveBeenCalledWith("owner", "repo", 4);
    expect((store.updateTask as any)).toHaveBeenCalledWith("FN-1", { sourceIssue: { ...sourceIssue, closedAt } });
  });

  it("skips open issues without writing", async () => {
    mockGetIssue.mockResolvedValueOnce({ state: "open" });
    const store = createStore([{ id: "FN-2", column: "done", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 2 } }]);

    const result = await new GitHubTrackingReconciler().backfillSourceIssueClosedAt(store);

    expect(result).toEqual({ scanned: 1, filled: 0, skipped: 1, errors: 0, hasMore: false });
    expect((store.updateTask as any)).not.toHaveBeenCalled();
  });

  it("skips closed issues with no usable closedAt without fabricating a timestamp", async () => {
    mockGetIssue.mockResolvedValueOnce({ state: "closed" });
    const store = createStore([{ id: "FN-3", column: "done", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 3 } }]);

    const result = await new GitHubTrackingReconciler().backfillSourceIssueClosedAt(store);

    expect(result.skipped).toBe(1);
    expect(result.filled).toBe(0);
    expect((store.updateTask as any)).not.toHaveBeenCalled();
  });

  it("excludes tasks that already have sourceIssue.closedAt from the scan", async () => {
    const store = createStore([{ id: "FN-4", column: "done", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 4, closedAt: "2026-06-01T00:00:00.000Z" } }]);

    const result = await new GitHubTrackingReconciler().backfillSourceIssueClosedAt(store);

    expect(result).toEqual({ scanned: 0, filled: 0, skipped: 0, errors: 0, hasMore: false });
    expect(mockGetIssue).not.toHaveBeenCalled();
    expect((store.updateTask as any)).not.toHaveBeenCalled();
  });

  it("ignores non-github, non-done, and missing sourceIssue tasks", async () => {
    const store = createStore([
      { id: "FN-5", column: "todo", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 5 } },
      { id: "FN-6", column: "done", sourceIssue: { provider: "jira", repository: "owner/repo", issueNumber: 6 } },
      { id: "FN-7", column: "done" },
    ]);

    const result = await new GitHubTrackingReconciler().backfillSourceIssueClosedAt(store);

    expect(result).toEqual({ scanned: 0, filled: 0, skipped: 0, errors: 0, hasMore: false });
    expect(mockGetIssue).not.toHaveBeenCalled();
  });

  it("logs getIssue errors per task without throwing", async () => {
    mockGetIssue.mockRejectedValueOnce(new Error("boom"));
    const store = createStore([{ id: "FN-8", column: "done", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 8 } }]);

    const result = await new GitHubTrackingReconciler().backfillSourceIssueClosedAt(store);

    expect(result).toEqual({ scanned: 1, filled: 0, skipped: 0, errors: 1, hasMore: false });
    expect((store.logEntry as any)).toHaveBeenCalledWith("FN-8", "Failed to backfill GitHub source issue closed-at", "boom");
    expect((store.updateTask as any)).not.toHaveBeenCalled();
  });

  it("returns all-skipped and logs when auth resolution fails", async () => {
    mockResolveGithubTrackingAuth.mockReturnValueOnce({ ok: false, message: "no auth" });
    const store = createStore([{ id: "FN-9", column: "archived", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 9 } }]);

    const result = await new GitHubTrackingReconciler().backfillSourceIssueClosedAt(store);

    expect(result).toEqual({ scanned: 1, filled: 0, skipped: 1, errors: 0, hasMore: false });
    expect((store.logEntry as any)).toHaveBeenCalledWith("FN-9", "Skipped GitHub source issue closed-at backfill", "no auth");
    expect(mockGetIssue).not.toHaveBeenCalled();
  });

  it("applies offset and limit pagination with hasMore", async () => {
    const closedAt = "2026-06-18T13:00:00.000Z";
    mockGetIssue.mockResolvedValueOnce({ state: "closed", closedAt });
    const store = createStore([
      { id: "FN-10", column: "done", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 10 } },
      { id: "FN-11", column: "done", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 11 } },
      { id: "FN-12", column: "archived", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 12 } },
    ]);

    const result = await new GitHubTrackingReconciler().backfillSourceIssueClosedAt(store, { offset: 1, limit: 1 });

    expect(result).toEqual({ scanned: 1, filled: 1, skipped: 0, errors: 0, hasMore: true });
    expect(mockGetIssue).toHaveBeenCalledTimes(1);
    expect(mockGetIssue).toHaveBeenCalledWith("owner", "repo", 11);
    expect((store.updateTask as any)).toHaveBeenCalledWith("FN-11", { sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 11, closedAt } });
  });
});
