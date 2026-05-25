import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { TaskStore } from "@fusion/core";
import { decideIssueAction, GitHubTrackingStateService } from "../github-tracking-state.js";

const { mockSetIssueState, mockDeleteIssue, mockGetIssue } = vi.hoisted(() => ({
  mockSetIssueState: vi.fn(),
  mockDeleteIssue: vi.fn(),
  mockGetIssue: vi.fn(),
}));

const { mockResolveGithubTrackingAuth } = vi.hoisted(() => ({
  mockResolveGithubTrackingAuth: vi.fn(),
}));

vi.mock("../github.js", () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({
    setIssueState: (...args: unknown[]) => mockSetIssueState(...args),
    deleteIssue: (...args: unknown[]) => mockDeleteIssue(...args),
    getIssue: (...args: unknown[]) => mockGetIssue(...args),
  })),
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

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("decideIssueAction", () => {
  const columns = ["triage", "todo", "in-progress", "in-review", "done", "archived"] as const;
  const activeColumns = ["triage", "todo", "in-progress", "in-review"] as const;

  it.each(columns.filter((from) => from !== "done"))("returns close for %s -> done", (from) => {
    expect(decideIssueAction(from, "done")).toEqual({ action: "close", stateReason: "completed" });
  });

  it.each(activeColumns)("returns reopen for done -> %s", (to) => {
    expect(decideIssueAction("done", to)).toEqual({ action: "reopen", stateReason: "reopened" });
  });

  it("closes on done -> archived", () => {
    expect(decideIssueAction("done", "archived")).toEqual({ action: "close", stateReason: "completed" });
  });

  it("closes on in-review -> archived", () => {
    expect(decideIssueAction("in-review", "archived")).toEqual({ action: "close", stateReason: "completed" });
  });

  it.each(["todo", "triage", "in-progress"] as const)("returns null for %s -> archived", (from) => {
    expect(decideIssueAction(from, "archived")).toBeNull();
  });

  it.each([
    ["triage", "todo"],
    ["todo", "in-progress"],
    ["in-progress", "in-review"],
    ["done", "done"],
    ["archived", "archived"],
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

  it("closes on archived -> done", async () => {
    service.start();

    store.emit("task:moved", { task: createTask(), from: "archived", to: "done" });
    await flushAsync();

    expect(mockSetIssueState).toHaveBeenCalledWith("owner", "repo", 42, "closed", "completed");
  });

  it.each(["todo", "triage", "in-progress", "in-review"] as const)("reopens on done -> %s", async (to) => {
    service.start();

    store.emit("task:moved", { task: createTask(), from: "done", to });
    await flushAsync();

    expect(mockSetIssueState).toHaveBeenCalledWith("owner", "repo", 42, "open", "reopened");
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Reopened linked GitHub tracking issue", "owner/repo#42");
  });

  it("closes on done -> archived", async () => {
    service.start();

    store.emit("task:moved", { task: createTask(), from: "done", to: "archived" });
    await flushAsync();

    expect(mockSetIssueState).toHaveBeenCalledWith("owner", "repo", 42, "closed", "completed");
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Closed linked GitHub tracking issue", "owner/repo#42");
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
