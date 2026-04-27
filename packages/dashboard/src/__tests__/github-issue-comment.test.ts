import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { TaskStore } from "@fusion/core";
import { DEFAULT_COMMENT_TEMPLATE, GitHubIssueCommentService } from "../github-issue-comment.js";

const { mockCommentOnIssue } = vi.hoisted(() => ({
  mockCommentOnIssue: vi.fn(),
}));

vi.mock("../github.js", () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({
    commentOnIssue: (...args: unknown[]) => mockCommentOnIssue(...args),
  })),
}));

class MockStore extends EventEmitter {
  private settings: Record<string, unknown>;
  logEntry: Mock;

  constructor(settings: Record<string, unknown>) {
    super();
    this.settings = settings;
    this.logEntry = vi.fn().mockResolvedValue(undefined);
  }

  async getSettings(): Promise<Record<string, unknown>> {
    return this.settings;
  }

  setSettings(settings: Record<string, unknown>): void {
    this.settings = settings;
  }
}

function createTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "FN-2623",
    title: "Imported task",
    sourceIssue: {
      provider: "github",
      repository: "owner/repo",
      issueNumber: 123,
    },
    ...overrides,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("GitHubIssueCommentService", () => {
  let store: MockStore;
  let service: GitHubIssueCommentService;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new MockStore({ githubCommentOnDone: true });
    service = new GitHubIssueCommentService(store as unknown as TaskStore, () => "ghp_test");
    service.start();
  });

  it("does nothing when setting is disabled", async () => {
    store.setSettings({ githubCommentOnDone: false });

    store.emit("task:moved", { task: createTask(), from: "in-progress", to: "done" });
    await flushAsync();

    expect(mockCommentOnIssue).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("does nothing when task has no sourceIssue", async () => {
    store.emit("task:moved", {
      task: createTask({ sourceIssue: undefined }),
      from: "in-progress",
      to: "done",
    });
    await flushAsync();

    expect(mockCommentOnIssue).not.toHaveBeenCalled();
  });

  it("does nothing when sourceIssue provider is not github", async () => {
    store.emit("task:moved", {
      task: createTask({
        sourceIssue: {
          provider: "gitlab",
          repository: "owner/repo",
          issueNumber: 123,
        },
      }),
      from: "in-progress",
      to: "done",
    });
    await flushAsync();

    expect(mockCommentOnIssue).not.toHaveBeenCalled();
  });

  it("does nothing when task moves to a non-done column", async () => {
    store.emit("task:moved", { task: createTask(), from: "todo", to: "in-progress" });
    await flushAsync();

    expect(mockCommentOnIssue).not.toHaveBeenCalled();
  });

  it("posts comment when setting enabled and task moved to done", async () => {
    mockCommentOnIssue.mockResolvedValue(undefined);

    store.emit("task:moved", { task: createTask(), from: "in-progress", to: "done" });
    await flushAsync();

    expect(mockCommentOnIssue).toHaveBeenCalledWith(
      "owner",
      "repo",
      123,
      "✅ Task FN-2623 (Imported task) has been completed and resolved.",
    );
  });

  it("uses custom template with placeholder substitution", async () => {
    store.setSettings({
      githubCommentOnDone: true,
      githubCommentTemplate: "Task {taskId}: {taskTitle} complete",
    });

    store.emit("task:moved", { task: createTask(), from: "in-progress", to: "done" });
    await flushAsync();

    expect(mockCommentOnIssue).toHaveBeenCalledWith(
      "owner",
      "repo",
      123,
      "Task FN-2623: Imported task complete",
    );
  });

  it("uses default template when custom template is not provided", async () => {
    store.setSettings({ githubCommentOnDone: true, githubCommentTemplate: undefined });

    store.emit("task:moved", { task: createTask(), from: "in-progress", to: "done" });
    await flushAsync();

    expect(mockCommentOnIssue).toHaveBeenCalledWith(
      "owner",
      "repo",
      123,
      DEFAULT_COMMENT_TEMPLATE.replace("{taskId}", "FN-2623").replace("{taskTitle}", "Imported task"),
    );
  });

  it("logs success to task log", async () => {
    store.emit("task:moved", { task: createTask(), from: "in-progress", to: "done" });
    await flushAsync();

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-2623",
      "Posted GitHub issue completion comment",
      "owner/repo#123",
    );
  });

  it("logs error and does not throw when comment call fails", async () => {
    mockCommentOnIssue.mockRejectedValue(new Error("rate limited"));

    expect(() => {
      store.emit("task:moved", { task: createTask(), from: "in-progress", to: "done" });
    }).not.toThrow();

    await flushAsync();

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-2623",
      "Failed to post GitHub issue comment",
      "rate limited",
    );
  });

  it("stop unregisters listener", async () => {
    service.stop();

    store.emit("task:moved", { task: createTask(), from: "in-progress", to: "done" });
    await flushAsync();

    expect(mockCommentOnIssue).not.toHaveBeenCalled();
  });
});
