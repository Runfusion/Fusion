import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { TaskStore } from "@fusion/core";
import { decideIssueAction, GitHubTrackingStateService } from "../github-tracking-state.js";

const { mockSetIssueState } = vi.hoisted(() => ({
  mockSetIssueState: vi.fn(),
}));

const { mockResolveGithubTrackingAuth } = vi.hoisted(() => ({
  mockResolveGithubTrackingAuth: vi.fn(),
}));

vi.mock("../github.js", () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({
    setIssueState: (...args: unknown[]) => mockSetIssueState(...args),
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

  it("returns null for done -> archived", () => {
    expect(decideIssueAction("done", "archived")).toBeNull();
  });

  it.each([
    ["triage", "todo"],
    ["todo", "in-progress"],
    ["in-progress", "in-review"],
    ["in-review", "archived"],
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
    service = new GitHubTrackingStateService(store as unknown as TaskStore);
  });

  it("start/stop are idempotent", async () => {
    service.start();
    service.start();

    store.emit("task:moved", { task: createTask(), from: "triage", to: "done" });
    await flushAsync();
    expect(mockSetIssueState).toHaveBeenCalledTimes(1);

    service.stop();
    service.stop();

    store.emit("task:moved", { task: createTask(), from: "done", to: "todo" });
    await flushAsync();
    expect(mockSetIssueState).toHaveBeenCalledTimes(1);
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

  it("does nothing for done -> archived", async () => {
    service.start();

    store.emit("task:moved", { task: createTask(), from: "done", to: "archived" });
    await flushAsync();

    expect(mockSetIssueState).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("does nothing for non-done transitions", async () => {
    service.start();

    store.emit("task:moved", { task: createTask(), from: "todo", to: "in-progress" });
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

  it("emits close then reopen in order", async () => {
    service.start();

    store.emit("task:moved", { task: createTask(), from: "triage", to: "done" });
    store.emit("task:moved", { task: createTask(), from: "done", to: "todo" });
    await flushAsync();

    expect(mockSetIssueState).toHaveBeenCalledTimes(2);
    expect(mockSetIssueState).toHaveBeenNthCalledWith(1, "owner", "repo", 42, "closed", "completed");
    expect(mockSetIssueState).toHaveBeenNthCalledWith(2, "owner", "repo", 42, "open", "reopened");
  });
});
