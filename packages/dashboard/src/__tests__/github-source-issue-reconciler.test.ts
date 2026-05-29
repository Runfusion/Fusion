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
  GitHubClient: vi.fn().mockImplementation(() => ({
    getIssue: (...args: unknown[]) => mockGetIssue(...args),
    setIssueState: (...args: unknown[]) => mockSetIssueState(...args),
  })),
}));

vi.mock("../github-auth.js", () => ({
  resolveGithubTrackingAuth: (...args: unknown[]) => mockResolveGithubTrackingAuth(...args),
}));

function createStore(listTasks: Array<Record<string, unknown>>, settings: Record<string, unknown> = { githubCloseSourceIssueOnDone: true, githubAuthMode: "token", githubAuthToken: "ghp_test" }): TaskStore {
  return {
    listTasks: vi.fn().mockResolvedValue(listTasks),
    listTasksForGithubTrackingReconcile: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue(settings),
    getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn().mockResolvedValue({}) })),
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
    const store = createStore([{ id: "FN-1", status: "done", sourceIssue: { provider: "github", repository: "o/r", issueNumber: 1 } }], { githubCloseSourceIssueOnDone: false });
    const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);
    expect(result).toEqual({ scanned: 1, closed: 0, skipped: 1, errors: 0 });
    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("closes open source issues", async () => {
    const store = createStore([{ id: "FN-1", status: "done", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 4 } }]);
    const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);
    expect(mockSetIssueState).toHaveBeenCalledWith("owner", "repo", 4, "closed", "completed");
    expect(result.closed).toBe(1);
  });

  it("skips already-closed source issues", async () => {
    mockGetIssue.mockResolvedValueOnce({ state: "closed" });
    const store = createStore([{ id: "FN-1", status: "done", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 4 } }]);
    const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);
    expect(result.skipped).toBe(1);
    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("skips source issues missing from GitHub", async () => {
    mockGetIssue.mockResolvedValueOnce(null);
    const store = createStore([{ id: "FN-12", status: "done", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 12 } }]);
    const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("ignores non-done tasks and tasks without sourceIssue", async () => {
    const store = createStore([
      { id: "FN-1", status: "todo", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 1 } },
      { id: "FN-2", status: "done" },
      { id: "FN-3", status: "done", sourceIssue: { provider: "jira", repository: "x/y", issueNumber: 3 } },
    ]);
    const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);
    expect(result).toEqual({ scanned: 0, closed: 0, skipped: 0, errors: 0 });
    expect(mockGetIssue).not.toHaveBeenCalled();
  });

  it("counts errors and logs on getIssue failure", async () => {
    mockGetIssue.mockRejectedValueOnce(new Error("boom"));
    const store = createStore([{ id: "FN-9", status: "done", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 9 } }]);
    const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);
    expect(result.errors).toBe(1);
    expect((store.logEntry as any)).toHaveBeenCalledWith("FN-9", "Failed to reconcile GitHub source issue", "boom");
  });

  it("counts errors and logs on setIssueState failure", async () => {
    mockSetIssueState.mockRejectedValueOnce(new Error("write failed"));
    const store = createStore([{ id: "FN-10", status: "done", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 10 } }]);
    const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);
    expect(result.errors).toBe(1);
    expect((store.logEntry as any)).toHaveBeenCalledWith("FN-10", "Failed to reconcile GitHub source issue", "write failed");
  });

  it("skips and logs when auth resolution fails", async () => {
    mockResolveGithubTrackingAuth.mockReturnValueOnce({ ok: false, message: "no auth" });
    const store = createStore([{ id: "FN-11", status: "done", sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 11 } }]);
    const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);
    expect(result.skipped).toBe(1);
    expect((store.logEntry as any)).toHaveBeenCalledWith("FN-11", "Skipped GitHub source issue reconciliation", "no auth");
    expect(mockSetIssueState).not.toHaveBeenCalled();
  });
});
