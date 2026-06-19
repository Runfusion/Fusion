// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { registerGitGitHubRoutes, GITHUB_TRACKING_RECONCILE_INTERVAL_MS } from "../routes/register-git-github.js";

const reconcile = vi.fn().mockResolvedValue({ scanned: 0, closed: 0, skipped: 0, errors: 0 });
const reconcileDeletedAndArchived = vi.fn();
const reconcileSourceIssues = vi.fn().mockResolvedValue({ scanned: 0, closed: 0, skipped: 0, errors: 0 });

vi.mock("../github-tracking-reconciler.js", () => ({
  RECONCILE_SCAN_LIMIT: 200,
  GitHubTrackingReconciler: vi.fn().mockImplementation(function () { return {
    reconcile,
    reconcileDeletedAndArchived,
    reconcileSourceIssues,
  }; }),
}));

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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs startup and periodic sweeps with paged offsets and clears interval on dispose", async () => {
    const store = createStore();
    const disposers: Array<() => void> = [];
    reconcileDeletedAndArchived
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
    expect(reconcileDeletedAndArchived).toHaveBeenNthCalledWith(1, store, { offset: 0, limit: 200 });

    await vi.advanceTimersByTimeAsync(GITHUB_TRACKING_RECONCILE_INTERVAL_MS);
    expect(reconcileDeletedAndArchived).toHaveBeenNthCalledWith(2, store, { offset: 200, limit: 200 });

    await vi.advanceTimersByTimeAsync(GITHUB_TRACKING_RECONCILE_INTERVAL_MS);
    expect(reconcileDeletedAndArchived).toHaveBeenNthCalledWith(3, store, { offset: 400, limit: 200 });

    await vi.advanceTimersByTimeAsync(GITHUB_TRACKING_RECONCILE_INTERVAL_MS);
    expect(reconcileDeletedAndArchived).toHaveBeenNthCalledWith(4, store, { offset: 0, limit: 200 });

    for (const dispose of disposers) {
      dispose();
    }
    const callsAfterDispose = reconcileDeletedAndArchived.mock.calls.length;
    await vi.advanceTimersByTimeAsync(GITHUB_TRACKING_RECONCILE_INTERVAL_MS);
    expect(reconcileDeletedAndArchived.mock.calls.length).toBe(callsAfterDispose);
  });
});
