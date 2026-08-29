import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { TaskStore } from "@fusion/core";
import { GitHubSourceIssueCloseService } from "../github-source-issue-close.js";

const { mockSetIssueState, mockGetIssue } = vi.hoisted(() => ({
  mockSetIssueState: vi.fn(),
  mockGetIssue: vi.fn(),
}));

const { mockResolveGithubTrackingAuth } = vi.hoisted(() => ({
  mockResolveGithubTrackingAuth: vi.fn(),
}));

vi.mock("../github.js", () => ({
  GitHubClient: vi.fn().mockImplementation(function () { return {
    setIssueState: (...args: unknown[]) => mockSetIssueState(...args),
    getIssue: (...args: unknown[]) => mockGetIssue(...args),
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
    this.getSettings = vi.fn().mockResolvedValue({ githubCloseSourceIssueOnDone: true, githubAuthMode: "token", githubAuthToken: "ghp_test" });
    this.getGlobalSettingsStore = vi.fn(() => ({ getSettings: vi.fn().mockResolvedValue({}) }));
  }
}

function createEvent(overrides: Record<string, unknown> = {}) {
  return {
    task: {
      id: "FN-1",
      sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 42 },
      ...overrides,
    },
    from: "todo",
    to: "done",
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("GitHubSourceIssueCloseService", () => {
  let store: MockStore;
  let service: GitHubSourceIssueCloseService;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new MockStore();
    service = new GitHubSourceIssueCloseService(store as unknown as TaskStore);
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
    mockGetIssue.mockResolvedValue({ state: "open" });
  });

  it("does nothing when setting is disabled", async () => {
    store.getSettings.mockResolvedValueOnce({ githubCloseSourceIssueOnDone: false });
    service.start();
    store.emit("task:moved", createEvent());
    await flushAsync();
    expect(mockGetIssue).not.toHaveBeenCalled();
    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("ignores missing sourceIssue", async () => {
    service.start();
    store.emit("task:moved", createEvent({ sourceIssue: undefined }));
    await flushAsync();
    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("ignores non-github provider", async () => {
    service.start();
    store.emit("task:moved", createEvent({ sourceIssue: { provider: "jira", repository: "owner/repo", issueNumber: 42 } }));
    await flushAsync();
    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("logs malformed repository", async () => {
    service.start();
    store.emit("task:moved", createEvent({ sourceIssue: { provider: "github", repository: "bad", issueNumber: 42 } }));
    await flushAsync();
    expect(mockSetIssueState).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Failed to close linked GitHub source issue", "Invalid GitHub source issue metadata: bad#42");
  });

  it("short-circuits when already closed", async () => {
    service.start();
    mockGetIssue.mockResolvedValueOnce({ state: "closed" });
    store.emit("task:moved", createEvent());
    await flushAsync();
    expect(mockSetIssueState).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Skipped closing GitHub source issue - issue not found or already closed", "owner/repo#42");
  });

  it("skips when source issue is missing from GitHub", async () => {
    service.start();
    mockGetIssue.mockResolvedValueOnce(null);
    store.emit("task:moved", createEvent());
    await flushAsync();
    expect(mockSetIssueState).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Skipped closing GitHub source issue - issue not found or already closed", "owner/repo#42");
  });

  it("closes open github source issue", async () => {
    service.start();
    store.emit("task:moved", createEvent());
    await flushAsync();
    expect(mockSetIssueState).toHaveBeenCalledWith("owner", "repo", 42, "closed", "completed");
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Closed linked GitHub source issue", "owner/repo#42");
  });

  it.each([
    ["todo", "not_planned"],
    ["in-progress", "not_planned"],
    ["done", "completed"],
  ])("closes source issue when archived from %s", async (from, stateReason) => {
    service.start();
    store.emit("task:moved", { ...createEvent(), from, to: "archived" });
    await flushAsync();
    expect(mockSetIssueState).toHaveBeenCalledWith("owner", "repo", 42, "closed", stateReason);
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Closed linked GitHub source issue", "owner/repo#42");
  });

  it("reopens source issue when unarchived to done", async () => {
    mockGetIssue.mockResolvedValueOnce({ state: "closed" });
    service.start();
    store.emit("task:moved", { ...createEvent(), from: "archived", to: "done" });
    await flushAsync();
    expect(mockSetIssueState).toHaveBeenCalledWith("owner", "repo", 42, "open", "reopened");
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Reopened linked GitHub source issue", "owner/repo#42");
  });

  it("reopens source issue when moved out of done", async () => {
    mockGetIssue.mockResolvedValueOnce({ state: "closed" });
    service.start();
    store.emit("task:moved", { ...createEvent(), from: "done", to: "todo" });
    await flushAsync();
    expect(mockSetIssueState).toHaveBeenCalledWith("owner", "repo", 42, "open", "reopened");
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Reopened linked GitHub source issue", "owner/repo#42");
  });

  it("does nothing for archived source issue transition when setting is disabled", async () => {
    store.getSettings.mockResolvedValueOnce({ githubCloseSourceIssueOnDone: false });
    service.start();
    store.emit("task:moved", { ...createEvent(), to: "archived" });
    await flushAsync();
    expect(mockGetIssue).not.toHaveBeenCalled();
    expect(mockSetIssueState).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("ignores archived transitions without sourceIssue", async () => {
    service.start();
    store.emit("task:moved", { ...createEvent({ sourceIssue: undefined }), to: "archived" });
    await flushAsync();
    expect(mockGetIssue).not.toHaveBeenCalled();
    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("ignores archived transitions for non-github provider", async () => {
    service.start();
    store.emit("task:moved", {
      ...createEvent({ sourceIssue: { provider: "jira", repository: "owner/repo", issueNumber: 42 } }),
      to: "archived",
    });
    await flushAsync();
    expect(mockGetIssue).not.toHaveBeenCalled();
    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("retries transient close failures once", async () => {
    service.start();
    mockSetIssueState.mockRejectedValueOnce(new Error("ECONNRESET"));
    mockSetIssueState.mockResolvedValueOnce(undefined);
    store.emit("task:moved", createEvent());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockSetIssueState).toHaveBeenCalledTimes(2);
  });

  it("logs non-transient close failures", async () => {
    service.start();
    mockSetIssueState.mockRejectedValueOnce(new Error("bad request"));
    store.emit("task:moved", createEvent());
    await flushAsync();
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Failed to close linked GitHub source issue", "bad request");
  });

  it("no-ops for non-actionable transitions", async () => {
    service.start();
    store.emit("task:moved", { ...createEvent(), to: "in-review" });
    await flushAsync();
    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("no-ops when remaining done", async () => {
    service.start();
    store.emit("task:moved", { ...createEvent(), from: "done", to: "done" });
    await flushAsync();
    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("no-ops when remaining archived", async () => {
    service.start();
    store.emit("task:moved", { ...createEvent(), from: "archived", to: "archived" });
    await flushAsync();
    expect(mockSetIssueState).not.toHaveBeenCalled();
  });

  it("skips and logs when auth resolution fails", async () => {
    mockResolveGithubTrackingAuth.mockReturnValueOnce({ ok: false, message: "no auth" });
    service.start();
    store.emit("task:moved", createEvent());
    await flushAsync();
    expect(mockSetIssueState).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", "Skipped closing GitHub source issue", "no auth");
  });

  it("attach adds listener for additional project store", async () => {
    const lateStore = new MockStore();
    service.start();
    service.attach(lateStore as unknown as TaskStore);
    lateStore.emit("task:moved", createEvent());
    await flushAsync();
    expect(mockSetIssueState).toHaveBeenCalledWith("owner", "repo", 42, "closed", "completed");
  });

  it("detach removes listeners", async () => {
    service.start();
    service.detach(store as unknown as TaskStore);
    store.emit("task:moved", createEvent());
    await flushAsync();
    expect(mockSetIssueState).not.toHaveBeenCalled();
  });
});
