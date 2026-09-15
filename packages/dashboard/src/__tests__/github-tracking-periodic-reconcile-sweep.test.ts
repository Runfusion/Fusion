// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { registerGitGitHubRoutes, GITHUB_TRACKING_RECONCILE_INTERVAL_MS } from "../routes/register-git-github.js";
import { GitHubTrackingReconciler } from "../github-tracking-reconciler.js";

const { mockGetIssue, mockSetIssueState, mockResolveGithubTrackingAuth } = vi.hoisted(() => ({
  mockGetIssue: vi.fn(),
  mockSetIssueState: vi.fn(),
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

/*
FNXC:GithubTrackingReconcile 2026-07-16-15:40:
Spy the three individual reconcile passes on the prototype but keep the REAL runSweep, so this test
exercises production's actual pass-isolation + offset-paging orchestration (not a re-implemented mock).
This is what proves the sweep still pages reconcileDeletedTasks by offset after runSweep took
ownership of that logic.
*/
let reconcile: ReturnType<typeof vi.spyOn>;
let reconcileDeletedTasks: ReturnType<typeof vi.spyOn>;
let reconcileSourceIssues: ReturnType<typeof vi.spyOn>;

vi.mock("../github-issue-comment.js", () => ({
  GitHubIssueCommentService: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }),
}));
vi.mock("../github-tracking-comments.js", () => ({
  GitHubTrackingCommentService: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }),
}));
vi.mock("../github-source-issue-close.js", () => ({
  GitHubSourceIssueCloseService: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn(), attach: vi.fn(), detach: vi.fn() }; }),
}));
vi.mock("../github-tracking-state.js", () => ({
  GitHubTrackingStateService: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn(), attach: vi.fn(), detach: vi.fn() }; }),
}));

function createStore(): TaskStore {
  return {
    on: vi.fn(),
    off: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    listTasksForGithubTrackingReconcile: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

/*
FNXC:DashboardTests 2026-06-14-09:58:
FN-6444 rescues the periodic reconcile route/API test by keeping the fake router aligned with the production route registrar's HTTP verbs instead of skipping the file.
*/
describe("GitHub tracking periodic reconcile sweep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Keep the real runSweep; stub only the three passes so we can assert paged offsets.
    reconcile = vi.spyOn(GitHubTrackingReconciler.prototype, "reconcile").mockResolvedValue({ scanned: 0, closed: 0, skipped: 0, errors: 0 });
    reconcileDeletedTasks = vi.spyOn(GitHubTrackingReconciler.prototype, "reconcileDeletedTasks");
    reconcileSourceIssues = vi.spyOn(GitHubTrackingReconciler.prototype, "reconcileSourceIssues").mockResolvedValue({ scanned: 0, closed: 0, skipped: 0, errors: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps repeated archived-board sweeps quiescent while deduplicating changed diagnostics", async () => {
    // Exact counts guard both regressions: task-log writes and per-cycle warning noise.
    vi.restoreAllMocks();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = createStore();
    const candidate = { id: "FN-archived", column: "archived", deletedAt: "2026-01-01T00:00:00.000Z", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 1 } } };
    (store.listTasksForGithubTrackingReconcile as ReturnType<typeof vi.fn>).mockResolvedValue({ tasks: [candidate], hasMore: false });
    (store.logEntry as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Task FN-archived is archived — logging is read-only"));
    const reconciler = new GitHubTrackingReconciler();

    mockResolveGithubTrackingAuth.mockReturnValue({ ok: false, message: "no auth" });
    const offsets = [
      await reconciler.runSweep(store, { offset: 0 }),
      await reconciler.runSweep(store, { offset: 0 }),
      await reconciler.runSweep(store, { offset: 0 }),
    ];
    expect(offsets).toEqual([{ nextOffset: 0 }, { nextOffset: 0 }, { nextOffset: 0 }]);
    expect(store.logEntry).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    mockResolveGithubTrackingAuth.mockReturnValue({ ok: false, message: "auth changed" });
    await reconciler.runSweep(store, { offset: 0 });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("does not warn or mutate archived rows when GitHub reconciliation is healthy", async () => {
    vi.restoreAllMocks();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = createStore();
    (store.listTasksForGithubTrackingReconcile as ReturnType<typeof vi.fn>).mockResolvedValue({
      tasks: [{ id: "FN-deleted", deletedAt: "2026-01-01T00:00:00.000Z", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 1 } } }],
      hasMore: false,
    });
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "test" } });
    mockGetIssue.mockResolvedValue({ state: "closed" });
    const reconciler = new GitHubTrackingReconciler();
    await reconciler.runSweep(store, { offset: 0 });
    await reconciler.runSweep(store, { offset: 0 });
    await reconciler.runSweep(store, { offset: 0 });
    expect(store.logEntry).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("deduplicates unchanged deleted-pass GitHub API failures across cycles", async () => {
    vi.restoreAllMocks();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = createStore();
    (store.listTasksForGithubTrackingReconcile as ReturnType<typeof vi.fn>).mockResolvedValue({
      tasks: [{ id: "FN-deleted", deletedAt: "2026-01-01T00:00:00.000Z", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 1 } } }],
      hasMore: false,
    });
    (store.logEntry as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Task FN-deleted is archived — logging is read-only"));
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "test" } });
    mockGetIssue.mockRejectedValue(new Error("GitHub unavailable"));
    const reconciler = new GitHubTrackingReconciler();
    await reconciler.runSweep(store, { offset: 0 });
    await reconciler.runSweep(store, { offset: 0 });
    await reconciler.runSweep(store, { offset: 0 });
    expect(store.logEntry).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().join(" ")).not.toContain("pass failed");
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("runs startup and periodic sweeps with paged offsets and clears interval on dispose", async () => {
    const store = createStore();
    const disposers: Array<() => void> = [];
    reconcileDeletedTasks
      .mockResolvedValueOnce({ scanned: 200, closed: 0, skipped: 0, errors: 0, hasMore: true })
      .mockResolvedValueOnce({ scanned: 200, closed: 0, skipped: 0, errors: 0, hasMore: true })
      .mockResolvedValueOnce({ scanned: 10, closed: 0, skipped: 0, errors: 0, hasMore: false });

    registerGitGitHubRoutes({
      router: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      getProjectContext: vi.fn(),
      rethrowAsApiError: vi.fn(),
      store,
      registerDispose: (fn: () => void) => disposers.push(fn),
      options: {},
    } as any);

    await vi.advanceTimersByTimeAsync(0);
    expect(reconcileDeletedTasks).toHaveBeenNthCalledWith(1, store, { offset: 0, limit: 200 });
    // All three passes run per sweep (regression: a throwing pass must not starve the others).
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcileSourceIssues).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(GITHUB_TRACKING_RECONCILE_INTERVAL_MS);
    expect(reconcileDeletedTasks).toHaveBeenNthCalledWith(2, store, { offset: 200, limit: 200 });

    await vi.advanceTimersByTimeAsync(GITHUB_TRACKING_RECONCILE_INTERVAL_MS);
    expect(reconcileDeletedTasks).toHaveBeenNthCalledWith(3, store, { offset: 400, limit: 200 });

    await vi.advanceTimersByTimeAsync(GITHUB_TRACKING_RECONCILE_INTERVAL_MS);
    expect(reconcileDeletedTasks).toHaveBeenNthCalledWith(4, store, { offset: 0, limit: 200 });

    for (const dispose of disposers) {
      dispose();
    }
    const callsAfterDispose = reconcileDeletedTasks.mock.calls.length;
    await vi.advanceTimersByTimeAsync(GITHUB_TRACKING_RECONCILE_INTERVAL_MS);
    expect(reconcileDeletedTasks.mock.calls.length).toBe(callsAfterDispose);
  });
});
