import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { GitHubTrackingReconciler, RECONCILE_CONCURRENCY_LIMIT } from "../github-tracking-reconciler.js";

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

function createStore(options: {
  listTasks?: Array<Record<string, unknown>>;
  reconcileCandidates?: Array<Record<string, unknown>>;
}): TaskStore {
  return {
    listTasks: vi.fn().mockResolvedValue(options.listTasks ?? []),
    listTasksForGithubTrackingReconcile: vi.fn().mockResolvedValue(options.reconcileCandidates ?? []),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({ githubAuthMode: "token", githubAuthToken: "ghp_test" }),
    getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn().mockResolvedValue({}) })),
  } as unknown as TaskStore;
}

describe("GitHubTrackingReconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("closes open issues for done tracked tasks", async () => {
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
    mockGetIssue.mockResolvedValue({ state: "open" });
    const store = createStore({ listTasks: [{ id: "FN-1", status: "done", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 1 } } }] });

    const result = await new GitHubTrackingReconciler().reconcile(store);

    expect(mockSetIssueState).toHaveBeenCalledWith("o", "r", 1, "closed", "completed");
    expect(result.closed).toBe(1);
  });

  it("skips closed issues and invalid tracking tasks", async () => {
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
    mockGetIssue.mockResolvedValue({ state: "closed" });
    const store = createStore({ listTasks: [
      { id: "FN-1", status: "done", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 1 } } },
      { id: "FN-2", status: "done", githubTracking: { enabled: false, issue: { owner: "o", repo: "r", number: 2 } } },
      { id: "FN-3", status: "done", githubTracking: { enabled: true, issue: { owner: "o", repo: "", number: 3 } } },
      { id: "FN-4", status: "todo", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 4 } } },
    ] });

    const result = await new GitHubTrackingReconciler().reconcile(store);

    expect(result.closed).toBe(0);
    expect(result.skipped).toBe(3);
    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("logs and continues on per-issue errors", async () => {
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
    mockGetIssue.mockRejectedValueOnce(new Error("boom"));
    mockGetIssue.mockResolvedValueOnce({ state: "open" });
    const store = createStore({ listTasks: [
      { id: "FN-1", status: "done", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 1 } } },
      { id: "FN-2", status: "done", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 2 } } },
    ] });

    const result = await new GitHubTrackingReconciler().reconcile(store);

    expect(result.errors).toBe(1);
    expect(result.closed).toBe(1);
    expect((store.logEntry as any)).toHaveBeenCalledWith("FN-1", "Failed to reconcile GitHub tracking issue", "boom");
  });

  it("skips and logs when auth is unavailable", async () => {
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: false, message: "no auth" });
    const store = createStore({ listTasks: [{ id: "FN-1", status: "done", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 1 } } }] });

    const result = await new GitHubTrackingReconciler().reconcile(store);

    expect(result.skipped).toBe(1);
    expect((store.logEntry as any)).toHaveBeenCalledWith("FN-1", "Skipped GitHub tracking issue reconciliation", "no auth");
  });

  it("respects concurrency cap", async () => {
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
    let inFlight = 0;
    let maxInFlight = 0;
    mockGetIssue.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return { state: "closed" };
    });

    const tasks = Array.from({ length: 10 }, (_, i) => ({
      id: `FN-${i + 1}`,
      status: "done",
      githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: i + 1 } },
    }));

    await new GitHubTrackingReconciler().reconcile(createStore({ listTasks: tasks }));
    expect(maxInFlight).toBeLessThanOrEqual(RECONCILE_CONCURRENCY_LIMIT);
  });

  describe("reconcileDeletedAndArchived", () => {
    it("closes with not_planned for soft-deleted tasks", async () => {
      mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
      mockGetIssue.mockResolvedValue({ state: "open" });
      const store = createStore({ reconcileCandidates: [{ id: "FN-1", deletedAt: "2026-01-01T00:00:00.000Z", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 1 } } }] });

      const result = await new GitHubTrackingReconciler().reconcileDeletedAndArchived(store);

      expect(mockSetIssueState).toHaveBeenCalledWith("o", "r", 1, "closed", "not_planned");
      expect(result.closed).toBe(1);
    });

    it("chooses completed for archived tasks with executionCompletedAt", async () => {
      mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
      mockGetIssue.mockResolvedValue({ state: "open" });
      const store = createStore({ reconcileCandidates: [{ id: "FN-2", column: "archived", executionCompletedAt: "2026-01-01T00:00:00.000Z", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 2 } } }] });

      await new GitHubTrackingReconciler().reconcileDeletedAndArchived(store);

      expect(mockSetIssueState).toHaveBeenCalledWith("o", "r", 2, "closed", "completed");
    });

    it("chooses not_planned for archived tasks without executionCompletedAt", async () => {
      mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
      mockGetIssue.mockResolvedValue({ state: "open" });
      const store = createStore({ reconcileCandidates: [{ id: "FN-3", column: "archived", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 3 } } }] });

      await new GitHubTrackingReconciler().reconcileDeletedAndArchived(store);

      expect(mockSetIssueState).toHaveBeenCalledWith("o", "r", 3, "closed", "not_planned");
    });

    it("uses deletion reason when task is both deleted and archived", async () => {
      mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
      mockGetIssue.mockResolvedValue({ state: "open" });
      const store = createStore({ reconcileCandidates: [{ id: "FN-4", column: "archived", deletedAt: "2026-01-01T00:00:00.000Z", executionCompletedAt: "2026-01-01T00:00:00.000Z", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 4 } } }] });

      await new GitHubTrackingReconciler().reconcileDeletedAndArchived(store);

      expect(mockSetIssueState).toHaveBeenCalledWith("o", "r", 4, "closed", "not_planned");
    });

    it("skips already closed issues and malformed tracking", async () => {
      mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
      mockGetIssue.mockResolvedValue({ state: "closed" });
      const store = createStore({ reconcileCandidates: [
        { id: "FN-5", column: "archived", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 5 } } },
        { id: "FN-6", deletedAt: "2026-01-01T00:00:00.000Z", githubTracking: { enabled: false, issue: { owner: "o", repo: "r", number: 6 } } },
        { id: "FN-7", deletedAt: "2026-01-01T00:00:00.000Z", githubTracking: { enabled: true, issue: { owner: "o", repo: "", number: 7 } } },
      ] });

      const result = await new GitHubTrackingReconciler().reconcileDeletedAndArchived(store);

      expect(result.skipped).toBe(3);
      expect(mockSetIssueState).not.toHaveBeenCalled();
    });

    it("logs task errors and continues", async () => {
      mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
      mockGetIssue.mockRejectedValueOnce(new Error("boom"));
      mockGetIssue.mockResolvedValueOnce({ state: "open" });
      const store = createStore({ reconcileCandidates: [
        { id: "FN-8", deletedAt: "2026-01-01T00:00:00.000Z", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 8 } } },
        { id: "FN-9", deletedAt: "2026-01-01T00:00:00.000Z", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 9 } } },
      ] });

      const result = await new GitHubTrackingReconciler().reconcileDeletedAndArchived(store);

      expect(result.errors).toBe(1);
      expect(result.closed).toBe(1);
      expect((store.logEntry as any)).toHaveBeenCalledWith(
        "FN-8",
        "Failed to reconcile GitHub tracking issue (deleted/archived pass)",
        "boom",
      );
    });

    it("counts all as skipped when auth is unavailable", async () => {
      mockResolveGithubTrackingAuth.mockReturnValue({ ok: false, message: "no auth" });
      const store = createStore({ reconcileCandidates: [{ id: "FN-10", deletedAt: "2026-01-01T00:00:00.000Z", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 10 } } }] });

      const result = await new GitHubTrackingReconciler().reconcileDeletedAndArchived(store);

      expect(result.skipped).toBe(1);
      expect((store.logEntry as any)).toHaveBeenCalledWith(
        "FN-10",
        "Skipped GitHub tracking issue reconciliation (deleted/archived pass)",
        "no auth",
      );
      expect(mockGetIssue).not.toHaveBeenCalled();
      expect(mockSetIssueState).not.toHaveBeenCalled();
    });
  });
});
