import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { GitHubTrackingReconciler, RECONCILE_CONCURRENCY_LIMIT, RECONCILE_SCAN_LIMIT } from "../github-tracking-reconciler.js";

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

/*
FNXC:WorkflowResolvedColumns 2026-07-31-05:30 (fleet phase — why the existing cases could not catch this):
`workflowIr` is OPTIONAL and every pre-existing case omits it. Without a workflow reader,
`resolveTaskLifecycleColumns` catches and returns undefined, so the reconciler falls back to the legacy
ids and those cases assert exactly what they always asserted — which is why all 33 stayed green through
the conversion, and why none of them could have caught it being wrong.

Supplying an IR is what makes the renamed-lane case below a real test rather than a restatement.
*/
function createStore(options: {
  listTasks?: Array<Record<string, unknown>>;
  reconcileCandidates?: Array<Record<string, unknown>>;
  reconcileHasMore?: boolean;
  settings?: Record<string, unknown>;
  workflowIr?: Record<string, unknown>;
}): TaskStore {
  return {
    ...(options.workflowIr
      ? {
        getTaskWorkflowSelection: () => ({ workflowId: "custom:renamed", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: options.workflowIr }),
      }
      : {}),
    listTasks: vi.fn().mockResolvedValue(options.listTasks ?? []),
    listTasksForGithubTrackingReconcile: vi
      .fn()
      .mockResolvedValue({ tasks: options.reconcileCandidates ?? [], hasMore: options.reconcileHasMore ?? false }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue(options.settings ?? { githubAuthMode: "token", githubAuthToken: "ghp_test" }),
    getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn().mockResolvedValue({}) })),
  } as unknown as TaskStore;
}

describe("GitHubTrackingReconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes a recently updated tracked done task even when older untracked terminal rows fill the scan window", async () => {
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
    mockGetIssue.mockResolvedValue({ state: "open" });
    const olderUntracked = Array.from({ length: RECONCILE_SCAN_LIMIT }, (_, i) => ({
      id: `FN-old-${String(i + 1).padStart(4, "0")}`,
      column: "todo",
      createdAt: `2026-01-01T00:00:00.${String(i).padStart(3, "0")}Z`,
      updatedAt: `2026-01-01T00:00:00.${String(i).padStart(3, "0")}Z`,
    }));
    const store = createStore({
      listTasks: [
        ...olderUntracked,
        {
          id: "FN-9061",
          column: "done",
          createdAt: "2026-08-15T04:05:43.525Z",
          updatedAt: "2026-08-15T04:51:10.315Z",
          executionCompletedAt: "2026-08-15T04:46:44.428Z",
          githubTracking: { enabled: true, issue: { owner: "Runfusion", repo: "Fusion", number: 3458 } },
        },
      ],
    });

    const result = await new GitHubTrackingReconciler().reconcile(store);

    expect(mockSetIssueState).toHaveBeenCalledWith("Runfusion", "Fusion", 3458, "closed", "completed");
    expect(result.closed).toBe(1);
  });

  it("closes open issues for done-column tracked tasks", async () => {
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
    mockGetIssue.mockResolvedValue({ state: "open" });
    const store = createStore({ listTasks: [{ id: "FN-1", column: "done", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 1 } } }] });

    const result = await new GitHubTrackingReconciler().reconcile(store);

    expect((store.listTasks as any)).toHaveBeenCalledWith({ slim: true, includeArchived: false });
    expect(mockSetIssueState).toHaveBeenCalledWith("o", "r", 1, "closed", "completed");
    expect(result.closed).toBe(1);
  });

  it("skips closed issues and invalid tracking tasks", async () => {
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
    mockGetIssue.mockResolvedValue({ state: "closed" });
    const store = createStore({ listTasks: [
      { id: "FN-1", column: "done", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 1 } } },
      { id: "FN-2", column: "done", githubTracking: { enabled: false, issue: { owner: "o", repo: "r", number: 2 } } },
      { id: "FN-3", column: "done", githubTracking: { enabled: true, issue: { owner: "o", repo: "", number: 3 } } },
      { id: "FN-4", column: "todo", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 4 } } },
    ] });

    const result = await new GitHubTrackingReconciler().reconcile(store);

    expect(result.closed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("logs and continues on per-issue errors", async () => {
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
    mockGetIssue.mockRejectedValueOnce(new Error("boom"));
    mockGetIssue.mockResolvedValueOnce({ state: "open" });
    const store = createStore({ listTasks: [
      { id: "FN-1", column: "done", updatedAt: "2026-08-15T04:51:00.000Z", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 1 } } },
      { id: "FN-2", column: "done", updatedAt: "2026-08-15T04:50:00.000Z", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 2 } } },
    ] });

    const result = await new GitHubTrackingReconciler().reconcile(store);

    expect(result.errors).toBe(1);
    expect(result.closed).toBe(1);
    expect((store.logEntry as any)).toHaveBeenCalledWith("FN-1", "Failed to reconcile GitHub tracking issue", "boom");
  });

  it("skips and logs when auth is unavailable", async () => {
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: false, message: "no auth" });
    const store = createStore({ listTasks: [{ id: "FN-1", column: "done", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 1 } } }] });

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
      column: "done",
      githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: i + 1 } },
    }));

    await new GitHubTrackingReconciler().reconcile(createStore({ listTasks: tasks }));
    expect(maxInFlight).toBeLessThanOrEqual(RECONCILE_CONCURRENCY_LIMIT);
  });

  describe("reconcileSourceIssues", () => {
    const sourceSettings = { githubCloseSourceIssueOnDone: true, githubAuthMode: "token", githubAuthToken: "ghp_test" };

    it("scans completed GitHub source issues and ignores non-complete tasks", async () => {
      mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
      mockGetIssue.mockResolvedValue({ state: "open" });
      const store = createStore({
        settings: sourceSettings,
        listTasks: [
          { id: "FN-1", column: "done", sourceIssue: { provider: "github", repository: "o/r", issueNumber: 1 } },
          { id: "FN-2", column: "todo", sourceIssue: { provider: "github", repository: "o/r", issueNumber: 2 } },
          { id: "FN-3", column: "done", sourceIssue: { provider: "jira", repository: "o/r", issueNumber: 3 } },
        ],
      });

      const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);

      expect((store.listTasks as any)).toHaveBeenCalledWith({ slim: false, includeArchived: false });
      expect(mockSetIssueState).toHaveBeenCalledWith("o", "r", 1, "closed", "completed");
      expect(mockSetIssueState).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ scanned: 1, closed: 1, skipped: 0, errors: 0 });
    });

    it("persists the current close time after closing an open source issue", async () => {
      vi.useFakeTimers({ now: new Date("2026-06-18T10:00:00.000Z") });
      mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
      mockGetIssue.mockResolvedValue({ state: "open" });
      const sourceIssue = { provider: "github", repository: "o/r", issueNumber: 1 };
      const store = createStore({
        settings: sourceSettings,
        listTasks: [{ id: "FN-1", column: "done", sourceIssue }],
      });

      const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);

      expect(mockSetIssueState).toHaveBeenCalledWith("o", "r", 1, "closed", "completed");
      expect((store.updateTask as any)).toHaveBeenCalledWith("FN-1", {
        sourceIssue: { ...sourceIssue, closedAt: "2026-06-18T10:00:00.000Z" },
      });
      expect(result).toMatchObject({ closed: 1, skipped: 0, errors: 0 });
    });

    it("backfills already-closed source issues with the GitHub closedAt without reclosing", async () => {
      mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
      mockGetIssue.mockResolvedValue({ state: "closed", closedAt: "2026-06-01T12:00:00Z" });
      const sourceIssue = { provider: "github", repository: "o/r", issueNumber: 7 };
      const store = createStore({
        settings: sourceSettings,
        listTasks: [{ id: "FN-7", column: "done", sourceIssue }],
      });

      const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);

      expect(mockSetIssueState).not.toHaveBeenCalled();
      expect((store.updateTask as any)).toHaveBeenCalledWith("FN-7", {
        sourceIssue: { ...sourceIssue, closedAt: "2026-06-01T12:00:00Z" },
      });
      expect(result).toMatchObject({ closed: 0, skipped: 1, errors: 0 });
    });

    it("does not overwrite an existing source issue closedAt", async () => {
      mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
      mockGetIssue.mockResolvedValue({ state: "closed", closedAt: "2026-06-01T12:00:00Z" });
      const store = createStore({
        settings: sourceSettings,
        listTasks: [{
          id: "FN-8",
          column: "done",
          sourceIssue: { provider: "github", repository: "o/r", issueNumber: 8, closedAt: "2026-01-01T00:00:00.000Z" },
        }],
      });

      const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);

      expect(mockSetIssueState).not.toHaveBeenCalled();
      expect((store.updateTask as any)).not.toHaveBeenCalled();
      expect(result).toMatchObject({ closed: 0, skipped: 1, errors: 0 });
    });

    it("logs but does not fail when persisting a source issue closedAt fails", async () => {
      vi.useFakeTimers({ now: new Date("2026-06-18T10:00:00.000Z") });
      mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
      mockGetIssue.mockResolvedValue({ state: "open" });
      const store = createStore({
        settings: sourceSettings,
        listTasks: [{ id: "FN-9", column: "done", sourceIssue: { provider: "github", repository: "o/r", issueNumber: 9 } }],
      });
      (store.updateTask as any).mockRejectedValueOnce(new Error("db locked"));

      const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);

      expect(result).toMatchObject({ closed: 1, errors: 0 });
      expect((store.logEntry as any)).toHaveBeenCalledWith("FN-9", "Failed to persist GitHub source issue closed timestamp", "db locked");
    });

    it("skips source issue reconciliation when close-on-done is disabled", async () => {
      const store = createStore({
        settings: { githubCloseSourceIssueOnDone: false, githubAuthMode: "token", githubAuthToken: "ghp_test" },
        listTasks: [{ id: "FN-1", column: "done", sourceIssue: { provider: "github", repository: "o/r", issueNumber: 1 } }],
      });

      const result = await new GitHubTrackingReconciler().reconcileSourceIssues(store);

      expect(mockSetIssueState).not.toHaveBeenCalled();
      expect((store.updateTask as any)).not.toHaveBeenCalled();
      expect(result).toEqual({ scanned: 1, closed: 0, skipped: 1, errors: 0 });
    });
  });

  describe("reconcileDeletedTasks", () => {
    it("closes with not_planned for soft-deleted tasks", async () => {
      mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
      mockGetIssue.mockResolvedValue({ state: "open" });
      const store = createStore({ reconcileCandidates: [{ id: "FN-1", deletedAt: "2026-01-01T00:00:00.000Z", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 1 } } }] });

      const result = await new GitHubTrackingReconciler().reconcileDeletedTasks(store, { offset: 0, limit: 10 });

      expect(mockSetIssueState).toHaveBeenCalledWith("o", "r", 1, "closed", "not_planned");
      expect(result.closed).toBe(1);
      expect(result.hasMore).toBe(false);
      expect((store.listTasksForGithubTrackingReconcile as any)).toHaveBeenCalledWith({ offset: 0, limit: 10 });
    });

    it("returns hasMore from store paging", async () => {
      mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
      mockGetIssue.mockResolvedValue({ state: "closed" });
      const store = createStore({
        reconcileCandidates: [{ id: "FN-5", deletedAt: "2026-01-01T00:00:00.000Z", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 5 } } }],
        reconcileHasMore: true,
      });

      const result = await new GitHubTrackingReconciler().reconcileDeletedTasks(store, { offset: 200, limit: 200 });
      expect(result.hasMore).toBe(true);
      expect(result.skipped).toBe(1);
    });
  });

  /*
  FNXC:GithubTrackingReconcile 2026-07-16-15:40:
  Regression coverage for the reconcile backstop going fully dark. The bug: a throw in the
  deleted-task pass aborted the whole sweep (shared try/catch, silent swallow), so the
  done-task tracking pass — which closes linked GitHub issues on Done — never ran on any sweep,
  and imported/linked issues stayed open forever. Invariant asserted below: each pass is isolated,
  so a throw in ANY one pass never prevents the others from running.
  */
  describe("runSweep pass isolation", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("runs done-task + source-issue passes even when the deleted-task pass throws", async () => {
      const reconciler = new GitHubTrackingReconciler();
      const deletedTasks = vi
        .spyOn(reconciler, "reconcileDeletedTasks")
        .mockRejectedValue(new Error("listTasksForGithubTrackingReconcile exploded"));
      const reconcile = vi
        .spyOn(reconciler, "reconcile")
        .mockResolvedValue({ scanned: 1, closed: 1, skipped: 0, errors: 0 });
      const reconcileSource = vi
        .spyOn(reconciler, "reconcileSourceIssues")
        .mockResolvedValue({ scanned: 0, closed: 0, skipped: 0, errors: 0 });

      const store = createStore({});
      const { nextOffset } = await reconciler.runSweep(store, { offset: 0 });

      // The critical invariant: the two closing passes still ran despite pass 1 throwing.
      expect(deletedTasks).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcileSource).toHaveBeenCalledTimes(1);
      // A failed deleted-task pass resets the paging offset (retry from 0 next sweep).
      expect(nextOffset).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
    });

    it("runs the source-issue pass even when the done-task pass throws, and advances paging", async () => {
      const reconciler = new GitHubTrackingReconciler();
      vi.spyOn(reconciler, "reconcileDeletedTasks").mockResolvedValue({ scanned: 0, closed: 0, skipped: 0, errors: 0, hasMore: true });
      const reconcile = vi.spyOn(reconciler, "reconcile").mockRejectedValue(new Error("done-task pass boom"));
      const reconcileSource = vi
        .spyOn(reconciler, "reconcileSourceIssues")
        .mockResolvedValue({ scanned: 0, closed: 0, skipped: 0, errors: 0 });

      const store = createStore({});
      const { nextOffset } = await reconciler.runSweep(store, { offset: 200 });

      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcileSource).toHaveBeenCalledTimes(1);
      // The deleted-task pass reported hasMore, so paging advances by the scan limit.
      expect(nextOffset).toBe(200 + RECONCILE_SCAN_LIMIT);
    });
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-05:30 (fleet phase — the SYNC-FILTER class, converted):
  Before this, a literal `task.column === "done"` filter matched nothing on a board whose complete
  lane was renamed. The pass then reported a clean-looking run that closed no GitHub issues at all.
  */
  const RENAMED_IR = {
    version: "v2",
    id: "custom:renamed",
    name: "Renamed",
    nodes: [],
    edges: [],
    columns: [
      { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
      { id: "building", name: "Building", traits: [{ trait: "wip" }] },
      { id: "checking", name: "Checking", traits: [{ trait: "merge-blocker" }] },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    ],
  };

  it("closes issues on a RENAMED complete lane, which the id comparisons could not see", async () => {
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
    mockGetIssue.mockResolvedValue({ state: "open" });
    const store = createStore({
      workflowIr: RENAMED_IR,
      listTasks: [
        { id: "FN-9", column: "shipped", githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 9 } } },
      ],
    });

    const result = await new GitHubTrackingReconciler().reconcile(store);

    expect(mockSetIssueState).toHaveBeenCalledWith("o", "r", 9, "closed", "completed");
    expect(result.closed).toBe(1);
  });

});
