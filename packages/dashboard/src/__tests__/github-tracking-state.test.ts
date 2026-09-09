import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { TaskStore } from "@fusion/core";
import { decideIssueAction, GitHubTrackingStateService } from "../github-tracking-state.js";

const { mockSetIssueState, mockDeleteIssue, mockGetIssue, mockCommentOnIssue } = vi.hoisted(() => ({
  mockSetIssueState: vi.fn(),
  mockDeleteIssue: vi.fn(),
  mockGetIssue: vi.fn(),
  mockCommentOnIssue: vi.fn(),
}));

const { mockResolveGithubTrackingAuth } = vi.hoisted(() => ({
  mockResolveGithubTrackingAuth: vi.fn(),
}));

vi.mock("../github.js", () => ({
  GitHubClient: vi.fn().mockImplementation(function () { return {
    setIssueState: (...args: unknown[]) => mockSetIssueState(...args),
    deleteIssue: (...args: unknown[]) => mockDeleteIssue(...args),
    getIssue: (...args: unknown[]) => mockGetIssue(...args),
    commentOnIssue: (...args: unknown[]) => mockCommentOnIssue(...args),
  }; }),
}));

vi.mock("../github-auth.js", () => ({
  resolveGithubTrackingAuth: (...args: unknown[]) => mockResolveGithubTrackingAuth(...args),
}));

class MockStore extends EventEmitter {
  logEntry: Mock;
  getSettings: Mock;
  getGlobalSettingsStore: Mock;

  constructor() {
    super();
    this.logEntry = vi.fn().mockResolvedValue(undefined);
    this.getSettings = vi.fn().mockResolvedValue({ githubAuthMode: "token", githubAuthToken: "ghp_test" });
    this.getGlobalSettingsStore = vi.fn(() => ({ getSettings: vi.fn().mockResolvedValue({}) }));
  }
}

function createTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "FN-1",
    githubTracking: {
      enabled: true,
      issue: {
        owner: "owner",
        repo: "repo",
        number: 42,
        url: "https://github.com/owner/repo/issues/42",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    },
    ...overrides,
  };
}

function createSourceTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "FN-source",
    sourceIssue: {
      provider: "github",
      repository: "acme/widgets",
      issueNumber: 42,
      externalIssueId: "42",
    },
    ...overrides,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("decideIssueAction", () => {
  const activeColumns = ["triage", "todo", "in-progress", "in-review"] as const;

  it.each(activeColumns)("returns close for %s -> done", (from) => {
    expect(decideIssueAction(from, "done")).toEqual({ action: "close", stateReason: "completed" });
  });

  it.each(activeColumns)("returns reopen for done -> %s", (to) => {
    expect(decideIssueAction("done", to)).toEqual({ action: "reopen", stateReason: "reopened" });
  });

  it.each([
    ["triage", "todo"],
    ["todo", "in-progress"],
    ["in-progress", "in-review"],
    ["done", "done"],
  ] as const)("returns null for %s -> %s", (from, to) => {
    expect(decideIssueAction(from, to)).toBeNull();
  });
});

describe("GitHubTrackingStateService", () => {
  let store: MockStore;
  let service: GitHubTrackingStateService;
  beforeEach(() => {
    vi.clearAllMocks();
    store = new MockStore();
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
    mockGetIssue.mockResolvedValue({ state: "open" });
    service = new GitHubTrackingStateService(store as unknown as TaskStore);
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-10:40 (fleet phase — THE SEAM WAS NEVER WIRED):
  `decideIssueAction` has accepted an injectable `classify` since U12/R2, and the header of
  github-tracking-state.ts states the defect that seam fixed: "a user-authored workflow whose terminal
  column is called something else never closed its linked GitHub issue". But the only PRODUCTION caller
  passed no classifier, so every real move fell through to `legacyColumnLifecycleClass` and the described
  bug was still live. The seam was reachable from unit tests only — which is exactly why the 68 cases in
  this file were all green while the thing they document did not work.

  These cases drive the SERVICE (not the pure decision function) on a renamed board, so they fail if the
  wiring is removed even though the seam still exists.

  REVERT CHECK, measured: dropping the resolved classifier at the call site — leaving
  `decideIssueAction(event.from, event.to)`, exactly as it was — makes both cases fail with 0
  setIssueState calls. The pure-function cases above pass either way.
  */
  describe("the resolved classifier is actually wired into the service", () => {
    const RENAMED_IR = {
      version: "v2",
      id: "custom:renamed",
      name: "Renamed",
      nodes: [],
      edges: [],
      columns: [
        { id: "building", name: "Building", traits: [{ trait: "wip" }] },
        { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
      ],
    };

    function renamedStore(): MockStore {
      const s = new MockStore();
      return Object.assign(s, {
        getTaskWorkflowSelection: () => ({ workflowId: "custom:renamed", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: RENAMED_IR }),
      });
    }

    it("closes the linked issue when a card reaches a RENAMED complete lane", async () => {
      const s = renamedStore();
      new GitHubTrackingStateService(s as unknown as TaskStore).start();

      s.emit("task:moved", { task: createTask(), from: "building", to: "shipped" });
      await flushAsync();

      expect(mockSetIssueState).toHaveBeenCalledWith("owner", "repo", 42, "closed", "completed");
    });

    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-10:50 (batch-core — the THIRD state):

    A V1-UPGRADED BOARD STILL COMPLETES THINGS.

    This classifier deliberately treats a RESOLVED but EMPTY complete set as a real answer: a board
    that declares no completion lane does not "complete" cards. That is right for a v2 board and wrong
    for a v1 upgrade — `synthesizeDefaultColumns` emits every default column with `traits: []`, so the
    IR resolves cleanly and every flag set is empty while `done` plainly exists and holds finished
    cards.

    The consequence was invisible: `decideIssueAction` returned null for every transition, so tracking
    NEVER closed a source issue on a v1 board — and because the source-issue commenter defers to this
    service whenever tracking targets the same issue, neither posted. The completion comment vanished
    with nothing logged.

    Not caught by the renamed-lane fixtures above, because they all express traits. The distinguishing
    property is a workflow that expresses NONE.
    */
    it("still closes the issue on a V1-UPGRADED board whose columns carry no traits", async () => {
      const v1UpgradedIr = {
        version: "v2",
        id: "custom:v1",
        name: "Legacy",
        nodes: [],
        edges: [],
        columns: ["todo", "in-progress", "in-review", "done"].map((id) => ({ id, name: id, traits: [] })),
      };
      const s = new MockStore();
      Object.assign(s, {
        getTaskWorkflowSelection: () => ({ workflowId: "custom:v1", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: v1UpgradedIr }),
      });
      new GitHubTrackingStateService(s as unknown as TaskStore).start();

      s.emit("task:moved", { task: createTask(), from: "in-progress", to: "done" });
      await flushAsync();

      expect(mockSetIssueState).toHaveBeenCalledWith("owner", "repo", 42, "closed", "completed");
    });

    it("closes the issue from a SECOND complete lane, not just the first", async () => {
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-14:20 (PR #2754 review — greptile):
      `LifecycleColumns` names ONE column per role by design (#2721), so a workflow declaring `complete`
      on two columns had the second invisible: a card moved there left its linked GitHub issue OPEN, with
      no error and nothing in the log to notice. Complete-trait sets are the membership answer.
      */
      const TWO_COMPLETE_IR = {
        ...RENAMED_IR,
        columns: [
          ...RENAMED_IR.columns,
          { id: "shipped-two", name: "Shipped 2", traits: [{ trait: "complete" }] },
        ],
      };
      const s = Object.assign(new MockStore(), {
        getTaskWorkflowSelection: () => ({ workflowId: "custom:renamed", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: TWO_COMPLETE_IR }),
      });
      new GitHubTrackingStateService(s as unknown as TaskStore).start();

      s.emit("task:moved", { task: createTask(), from: "building", to: "shipped-two" });
      await flushAsync();

      expect(mockSetIssueState).toHaveBeenCalledWith("owner", "repo", 42, "closed", "completed");
    });

    it("does nothing for a move between two lanes that play neither terminal role", async () => {
      // Non-vacuous: the resolved classifier must still return null for non-terminal moves.
      const s = renamedStore();
      new GitHubTrackingStateService(s as unknown as TaskStore).start();

      s.emit("task:moved", { task: createTask(), from: "shipped", to: "building" });
      await flushAsync();

      // shipped -> building is a reopen, so an action IS expected; use two non-terminal lanes instead.
      mockSetIssueState.mockClear();
      s.emit("task:moved", { task: createTask(), from: "building", to: "building" });
      await flushAsync();
      expect(mockSetIssueState).not.toHaveBeenCalled();
    });
  });

  it("start/stop are idempotent", async () => {
    service.start();
    service.start();

    store.emit("task:moved", { task: createTask(), from: "triage", to: "done" });
    store.emit("task:deleted", createTask({ id: "FN-2" }));
    await flushAsync();
    expect(mockSetIssueState).toHaveBeenCalledTimes(2);

    service.stop();
    service.stop();

    store.emit("task:moved", { task: createTask(), from: "done", to: "todo" });
    store.emit("task:deleted", createTask({ id: "FN-3" }));
    await flushAsync();
    expect(mockSetIssueState).toHaveBeenCalledTimes(2);
  });

  it("closes on triage -> done and logs success", async () => {
    service.start();

    store.emit("task:moved", { task: createTask(), from: "triage", to: "done" });
    await flushAsync();

    expect(mockSetIssueState).toHaveBeenCalledWith("owner", "repo", 42, "closed", "completed");
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Closed linked GitHub tracking issue", "owner/repo#42");
  });

  it.each(["todo", "triage", "in-progress", "in-review"] as const)("reopens on done -> %s", async (to) => {
    service.start();

    store.emit("task:moved", { task: createTask(), from: "done", to });
    await flushAsync();

    expect(mockSetIssueState).toHaveBeenCalledWith("owner", "repo", 42, "open", "reopened");
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Reopened linked GitHub tracking issue", "owner/repo#42");
  });

  it("does nothing for non-done transitions", async () => {
    service.start();

    for (const [from, to] of [["triage", "todo"], ["todo", "in-progress"], ["in-review", "in-review"]] as const) {
      store.emit("task:moved", { task: createTask(), from, to });
    }
    await flushAsync();

    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("ignores disabled tracking", async () => {
    service.start();

    store.emit("task:moved", {
      task: createTask({ githubTracking: { enabled: false } }),
      from: "todo",
      to: "done",
    });
    await flushAsync();

    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("ignores missing linked issue", async () => {
    service.start();

    store.emit("task:moved", {
      task: createTask({ githubTracking: { enabled: true } }),
      from: "todo",
      to: "done",
    });
    await flushAsync();

    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("logs incomplete metadata", async () => {
    service.start();

    store.emit("task:moved", {
      task: createTask({
        githubTracking: {
          enabled: true,
          issue: {
            owner: "",
            repo: "repo",
            number: 42,
          },
        },
      }),
      from: "todo",
      to: "done",
    });
    await flushAsync();

    expect(mockSetIssueState).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-1",
      "Failed to update GitHub tracking issue state",
      "Linked issue metadata is incomplete",
    );
  });

  it("swallows close failures and keeps listener alive", async () => {
    service.start();
    mockSetIssueState.mockRejectedValueOnce(new Error("close failed"));

    expect(() => {
      store.emit("task:moved", { task: createTask(), from: "todo", to: "done" });
    }).not.toThrow();
    await flushAsync();

    expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Failed to close GitHub tracking issue", "close failed");

    mockSetIssueState.mockResolvedValueOnce(undefined);
    store.emit("task:moved", { task: createTask(), from: "done", to: "todo" });
    await flushAsync();

    expect(mockSetIssueState).toHaveBeenCalledTimes(2);
  });

  it("retries once for transient close failures", async () => {
    service.start();
    mockSetIssueState.mockRejectedValueOnce(new Error("ECONNRESET"));
    mockSetIssueState.mockResolvedValueOnce(undefined);

    store.emit("task:moved", { task: createTask(), from: "todo", to: "done" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockSetIssueState).toHaveBeenCalledTimes(2);
  });

  it("treats already-closed issue as success", async () => {
    service.start();
    mockGetIssue.mockResolvedValueOnce({ state: "closed" });

    store.emit("task:moved", { task: createTask(), from: "todo", to: "done" });
    await flushAsync();

    expect(mockSetIssueState).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Linked GitHub tracking issue already closed", "owner/repo#42");
  });

  it("swallows reopen failures", async () => {
    service.start();
    mockSetIssueState.mockRejectedValueOnce(new Error("reopen failed"));

    store.emit("task:moved", { task: createTask(), from: "done", to: "todo" });
    await flushAsync();

    expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Failed to reopen GitHub tracking issue", "reopen failed");
  });

  it("resolves auth per call", async () => {
    service.start();

    store.emit("task:moved", { task: createTask(), from: "todo", to: "done" });
    store.emit("task:moved", { task: createTask(), from: "done", to: "todo" });
    await flushAsync();

    expect(mockSetIssueState).toHaveBeenCalledTimes(2);
    expect(mockResolveGithubTrackingAuth).toHaveBeenCalledTimes(2);
  });

  it("closes issue for late-registered project stores after attach", async () => {
    const lateStore = new MockStore();
    service.start();
    service.attach(lateStore as unknown as TaskStore);

    lateStore.emit("task:moved", { task: createTask({ id: "FN-late" }), from: "todo", to: "done" });
    await flushAsync();

    expect(mockSetIssueState).toHaveBeenCalledWith("owner", "repo", 42, "closed", "completed");
  });

  it("emits close and reopen updates", async () => {
    service.start();

    store.emit("task:moved", { task: createTask(), from: "triage", to: "done" });
    store.emit("task:moved", { task: createTask(), from: "done", to: "todo" });
    await flushAsync();

    expect(mockSetIssueState).toHaveBeenCalledTimes(2);
    expect(mockSetIssueState).toHaveBeenCalledWith("owner", "repo", 42, "closed", "completed");
    expect(mockSetIssueState).toHaveBeenCalledWith("owner", "repo", 42, "open", "reopened");
  });

  describe("on task:deleted", () => {
    it.each([undefined, "auto", "close"] as const)("closes the linked issue with not_planned when action is %s", async (action) => {
      service.start();

      if (action === undefined) {
        store.emit("task:deleted", createTask());
      } else {
        store.emit("task:deleted", createTask(), { githubIssueAction: action });
      }
      await flushAsync();

      expect(mockSetIssueState).toHaveBeenCalledWith("owner", "repo", 42, "closed", "not_planned");
      expect(mockDeleteIssue).not.toHaveBeenCalled();
    });

    it("deletes linked issue when githubIssueAction is delete", async () => {
      service.start();

      store.emit("task:deleted", createTask(), { githubIssueAction: "delete" });
      await flushAsync();

      expect(mockDeleteIssue).toHaveBeenCalledWith("owner", "repo", 42);
      expect(mockSetIssueState).not.toHaveBeenCalled();
      expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Deleted linked GitHub tracking issue", "owner/repo#42");
    });

    it("leaves linked issue untouched when githubIssueAction is leave", async () => {
      service.start();

      store.emit("task:deleted", createTask(), { githubIssueAction: "leave" });
      await flushAsync();

      expect(mockDeleteIssue).not.toHaveBeenCalled();
      expect(mockSetIssueState).not.toHaveBeenCalled();
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-1",
        "Left linked GitHub tracking issue unchanged on task delete",
        "owner/repo#42",
      );
    });

    describe("source-imported issue delete", () => {
      it("leaves source issue untouched when githubIssueAction is leave", async () => {
        service.start();

        store.emit("task:deleted", createSourceTask(), { githubIssueAction: "leave" });
        await flushAsync();

        expect(mockDeleteIssue).not.toHaveBeenCalled();
        expect(mockSetIssueState).not.toHaveBeenCalled();
        expect(store.logEntry).toHaveBeenCalledWith(
          "FN-source",
          "Left linked source GitHub issue unchanged on task delete",
          "acme/widgets#42",
        );
      });

      it("closes source issue with completed reason", async () => {
        service.start();

        store.emit("task:deleted", createSourceTask(), { githubIssueAction: "close" });
        await flushAsync();

        expect(mockSetIssueState).toHaveBeenCalledWith("acme", "widgets", 42, "closed", "completed");
      });

      it("short-circuits when source issue is already closed", async () => {
        service.start();
        mockGetIssue.mockResolvedValueOnce({ state: "closed" });

        store.emit("task:deleted", createSourceTask(), { githubIssueAction: "close" });
        await flushAsync();

        expect(mockSetIssueState).not.toHaveBeenCalled();
        expect(store.logEntry).toHaveBeenCalledWith("FN-source", "Linked source GitHub issue already closed", "acme/widgets#42");
      });

      it("retries transient source close errors once", async () => {
        service.start();
        mockSetIssueState.mockRejectedValueOnce(new Error("ECONNRESET"));
        mockSetIssueState.mockResolvedValueOnce(undefined);

        store.emit("task:deleted", createSourceTask(), { githubIssueAction: "close" });
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(mockSetIssueState).toHaveBeenCalledTimes(2);
      });

      it("emits failure for non-transient source close errors", async () => {
        service.start();
        mockSetIssueState.mockRejectedValueOnce(new Error("close failed"));
        const emitSpy = vi.spyOn(store, "emit");

        store.emit("task:deleted", createSourceTask(), { githubIssueAction: "close" });
        await flushAsync();

        expect(emitSpy).toHaveBeenCalledWith(
          "github-issue:action",
          expect.objectContaining({ taskId: "FN-source", action: "close", outcome: "failed", error: "close failed" }),
        );
      });

      it("deletes source issue when githubIssueAction is delete", async () => {
        service.start();

        store.emit("task:deleted", createSourceTask(), { githubIssueAction: "delete" });
        await flushAsync();

        expect(mockDeleteIssue).toHaveBeenCalledWith("acme", "widgets", 42);
      });

      it("retries transient source delete errors once", async () => {
        service.start();
        mockDeleteIssue.mockRejectedValueOnce(new Error("timed out"));
        mockDeleteIssue.mockResolvedValueOnce(undefined);

        store.emit("task:deleted", createSourceTask(), { githubIssueAction: "delete" });
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(mockDeleteIssue).toHaveBeenCalledTimes(2);
      });

      it.each([undefined, "auto"] as const)("defaults source delete action %s to close", async (action) => {
        service.start();

        if (action === undefined) {
          store.emit("task:deleted", createSourceTask());
        } else {
          store.emit("task:deleted", createSourceTask(), { githubIssueAction: action });
        }
        await flushAsync();

        expect(mockSetIssueState).toHaveBeenCalledWith("acme", "widgets", 42, "closed", "completed");
      });

      it("ignores non-github source providers", async () => {
        service.start();

        store.emit("task:deleted", createSourceTask({ sourceIssue: { provider: "gitlab", repository: "group/proj", issueNumber: 42 } }));
        await flushAsync();

        expect(mockSetIssueState).not.toHaveBeenCalled();
        expect(mockDeleteIssue).not.toHaveBeenCalled();
      });

      it("logs malformed source repository", async () => {
        service.start();

        store.emit("task:deleted", createSourceTask({ sourceIssue: { provider: "github", repository: "no-slash", issueNumber: 42 } }));
        await flushAsync();

        expect(mockSetIssueState).not.toHaveBeenCalled();
        expect(store.logEntry).toHaveBeenCalledWith(
          "FN-source",
          "Failed to close linked source GitHub issue",
          "Invalid source issue repository: no-slash",
        );
      });

      it.each([0, -1, 1.5] as const)("ignores invalid source issue numbers (%s)", async (issueNumber) => {
        service.start();

        store.emit("task:deleted", createSourceTask({ sourceIssue: { provider: "github", repository: "acme/widgets", issueNumber } }));
        await flushAsync();

        expect(mockSetIssueState).not.toHaveBeenCalled();
        expect(mockDeleteIssue).not.toHaveBeenCalled();
      });

    });

    it.each([
      {
        label: "tracking disabled",
        task: createTask({ githubTracking: { enabled: false } }),
      },
      {
        label: "missing issue",
        task: createTask({ githubTracking: { enabled: true } }),
      },
      {
        label: "missing owner",
        task: createTask({ githubTracking: { enabled: true, issue: { owner: "", repo: "repo", number: 42 } } }),
      },
      {
        label: "missing repo",
        task: createTask({ githubTracking: { enabled: true, issue: { owner: "owner", repo: "", number: 42 } } }),
      },
      {
        label: "missing number",
        task: createTask({ githubTracking: { enabled: true, issue: { owner: "owner", repo: "repo" } } }),
      },
    ])("does nothing when $label", async ({ task }) => {
      service.start();

      store.emit("task:deleted", task);
      await flushAsync();

      expect(mockSetIssueState).not.toHaveBeenCalled();
      expect(mockDeleteIssue).not.toHaveBeenCalled();
      expect(store.logEntry).not.toHaveBeenCalled();
    });

    it("logs close failures without throwing", async () => {
      service.start();
      mockSetIssueState.mockRejectedValueOnce(new Error("delete close failed"));

      expect(() => {
        store.emit("task:deleted", createTask(), { githubIssueAction: "close" });
      }).not.toThrow();
      await flushAsync();

      expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Failed to close linked GitHub tracking issue", "delete close failed");
    });

    it("still attempts close and emits failure event when logEntry rejects for deleted task", async () => {
      service.start();
      store.logEntry = vi.fn().mockRejectedValue(new Error("Task FN-1 not found"));
      mockSetIssueState.mockRejectedValueOnce(new Error("delete close failed"));
      const emitSpy = vi.spyOn(store, "emit");
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      process.on("unhandledRejection", onUnhandledRejection);

      try {
        store.emit("task:deleted", createTask(), { githubIssueAction: "close" });
        await flushAsync();

        expect(mockSetIssueState).toHaveBeenCalledTimes(1);
        expect(unhandledRejections).toHaveLength(0);
        expect(emitSpy).toHaveBeenCalledWith(
          "github-issue:action",
          expect.objectContaining({
            taskId: "FN-1",
            action: "close",
            outcome: "failed",
            error: "delete close failed",
          }),
        );
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
      }
    });

    it("logs delete failures without throwing", async () => {
      service.start();
      mockDeleteIssue.mockRejectedValueOnce(new Error("delete failed"));

      expect(() => {
        store.emit("task:deleted", createTask(), { githubIssueAction: "delete" });
      }).not.toThrow();
      await flushAsync();

      expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Failed to delete linked GitHub tracking issue", "delete failed");
    });

    it("still attempts delete and emits failure event when logEntry rejects for deleted task", async () => {
      service.start();
      store.logEntry = vi.fn().mockRejectedValue(new Error("Task FN-1 not found"));
      mockDeleteIssue.mockRejectedValueOnce(new Error("delete failed"));
      const emitSpy = vi.spyOn(store, "emit");
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      process.on("unhandledRejection", onUnhandledRejection);

      try {
        store.emit("task:deleted", createTask(), { githubIssueAction: "delete" });
        await flushAsync();

        expect(mockDeleteIssue).toHaveBeenCalledTimes(1);
        expect(unhandledRejections).toHaveLength(0);
        expect(emitSpy).toHaveBeenCalledWith(
          "github-issue:action",
          expect.objectContaining({
            taskId: "FN-1",
            action: "delete",
            outcome: "failed",
            error: "delete failed",
          }),
        );
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
      }
    });
  });
});
