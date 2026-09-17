// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTaskLogReadOnlyMessage, buildTaskNotFoundMessage, type TaskStore } from "@fusion/core";
import { GitHubTrackingReconciler } from "../github-tracking-reconciler.js";

const { resolveAuth, getIssue, setIssueState } = vi.hoisted(() => ({
  resolveAuth: vi.fn(),
  getIssue: vi.fn(),
  setIssueState: vi.fn(),
}));

vi.mock("../github-auth.js", () => ({
  resolveGithubTrackingAuth: (...args: unknown[]) => resolveAuth(...args),
}));
vi.mock("../github.js", () => ({
  GitHubClient: vi.fn().mockImplementation(function () {
    return { getIssue: (...args: unknown[]) => getIssue(...args), setIssueState: (...args: unknown[]) => setIssueState(...args) };
  }),
}));

type RowState = "archived" | "soft-deleted" | "absent" | "snapshot-live-write-terminal";

function terminalTask(id: string, state: RowState) {
  return {
    id,
    title: id,
    column: "done",
    dependencies: [],
    deletedAt: state === "soft-deleted" ? "2026-09-01T00:00:00.000Z" : undefined,
    githubTracking: { enabled: true, issue: { owner: "fusion", repo: "fusion", number: 3616 } },
    sourceIssue: { provider: "github", repository: "fusion/fusion", issueNumber: 3616 },
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

/** Builds refusal errors from core's canonical message helpers, never local text fixtures. */
function refusalFor(id: string, state: RowState): Error {
  return new Error(state === "absent" ? buildTaskNotFoundMessage(id) : buildTaskLogReadOnlyMessage(id));
}

function createStore(state: RowState) {
  const task = terminalTask("KB-006", state);
  const logEntry = vi.fn().mockRejectedValue(refusalFor(task.id, state));
  return {
    listTasks: vi.fn().mockResolvedValue(state === "absent" ? [] : [task]),
    listTasksForGithubTrackingReconcile: vi.fn().mockResolvedValue({ tasks: state === "archived" ? [task] : [], hasMore: false }),
    getSettings: vi.fn().mockResolvedValue({}),
    getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn().mockResolvedValue({}) })),
    logEntry,
    updateTask: vi.fn(),
    updateTaskDependencies: vi.fn(),
  } as unknown as TaskStore;
}

describe("terminal task maintenance quiescence", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each<RowState>(["archived", "soft-deleted", "absent", "snapshot-live-write-terminal"])(
    "runs three production sweeps without writes for a %s row",
    async (state) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const store = createStore(state);
      resolveAuth.mockReturnValue({ ok: false, message: "credentials unavailable" });
      const reconciler = new GitHubTrackingReconciler();

      await reconciler.runSweep(store, { offset: 0 });
      await reconciler.runSweep(store, { offset: 0 });
      await reconciler.runSweep(store, { offset: 0 });

      expect(store.logEntry).not.toHaveBeenCalled();
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.updateTaskDependencies).not.toHaveBeenCalled();
      const terminalDiagnostics = warn.mock.calls.filter(([message]) => String(message).includes("github-tracking-reconcile] skipped"));
      // Tracking and source-issue passes have distinct auth signatures; each is first-occurrence-only.
      expect(new Set(terminalDiagnostics.map(([message]) => String(message)))).toHaveLength(2);
      expect(error).not.toHaveBeenCalled();
      vi.useRealTimers();
    },
  );

  it("keeps source reconciliation and closed-at backfill terminal rows quiescent across repeated auth failures", async () => {
    const store = createStore("archived");
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([terminalTask("KB-006", "archived")]);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ githubCloseSourceIssueOnDone: true });
    resolveAuth.mockReturnValue({ ok: false, message: "credentials unavailable" });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reconciler = new GitHubTrackingReconciler();

    for (let index = 0; index < 3; index += 1) {
      await reconciler.reconcileSourceIssues(store);
      await reconciler.backfillSourceIssueClosedAt(store);
    }

    expect(store.logEntry).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledTimes(2);
  });

  it("absorbs a snapshot-live to write-terminal closed-at backfill race", async () => {
    const store = createStore("snapshot-live-write-terminal");
    const liveSnapshot = { ...terminalTask("KB-race", "snapshot-live-write-terminal"), deletedAt: undefined };
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([liveSnapshot]);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ githubAuthMode: "token", githubAuthToken: "test" });
    resolveAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "test" } });
    getIssue.mockResolvedValue({ state: "closed", closedAt: "2026-09-16T00:00:00.000Z" });
    (store.updateTask as ReturnType<typeof vi.fn>).mockRejectedValue(refusalFor("KB-race", "snapshot-live-write-terminal"));
    (store.logEntry as ReturnType<typeof vi.fn>).mockRejectedValue(refusalFor("KB-race", "snapshot-live-write-terminal"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await new GitHubTrackingReconciler().backfillSourceIssueClosedAt(store);

    expect(result.errors).toBe(1);
    expect(store.updateTask).toHaveBeenCalledOnce();
    expect(store.logEntry).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
  });

  it("still reconciles and records a live tracking issue", async () => {
    const store = createStore("archived");
    const live = { ...terminalTask("KB-live", "archived"), deletedAt: undefined };
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([live]);
    resolveAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "test" } });
    getIssue.mockResolvedValue({ state: "open" });
    setIssueState.mockResolvedValue(undefined);
    (store.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await new GitHubTrackingReconciler().reconcile(store);

    expect(setIssueState).toHaveBeenCalledOnce();
    expect(store.logEntry).not.toHaveBeenCalled();
  });
});
