import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { TaskStore } from "@fusion/core";
import {
  formatTrackingComment,
  GitHubTrackingCommentService,
} from "../github-tracking-comments.js";

const { mockCommentOnIssue } = vi.hoisted(() => ({
  mockCommentOnIssue: vi.fn(),
}));

const { mockResolveGithubTrackingAuth } = vi.hoisted(() => ({
  mockResolveGithubTrackingAuth: vi.fn(),
}));

vi.mock("../github.js", () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({
    commentOnIssue: (...args: unknown[]) => mockCommentOnIssue(...args),
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
    title: "Tracked task",
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

describe("formatTrackingComment", () => {
  it("formats in-progress comments", () => {
    const comment = formatTrackingComment({ id: "FN-1", title: "Build thing" }, "in-progress");
    expect(comment.startsWith("Fusion task: FN-1\n\n🚧 In progress")).toBe(true);
  });

  it("formats done comments", () => {
    const comment = formatTrackingComment({ id: "FN-1", title: "Build thing" }, "done");
    expect(comment.startsWith("Fusion task: FN-1\n\n✅ Done")).toBe(true);
  });

  it("falls back to untitled task", () => {
    const comment = formatTrackingComment({ id: "FN-1", title: "   " }, "done");
    expect(comment).toContain("Untitled task");
  });

  it("collapses multiline title whitespace", () => {
    const comment = formatTrackingComment({ id: "FN-1", title: "Line 1\n\n  Line 2" }, "done");
    expect(comment).toContain("Line 1 Line 2");
  });

  it("truncates long titles and caps total length", () => {
    const comment = formatTrackingComment({ id: "FN-1", title: "A".repeat(1000) }, "done");
    expect(comment.length).toBeLessThanOrEqual(500);
    expect(comment).toContain("…");
  });

  it("never includes urls or markdown links", () => {
    const comment = formatTrackingComment({ id: "FN-1", title: "hello" }, "done");
    expect(comment).not.toContain("localhost");
    expect(comment).not.toContain("http://");
    expect(comment).not.toContain("https://");
    expect(comment).not.toContain("](");
  });
});

describe("GitHubTrackingCommentService", () => {
  let store: MockStore;
  let service: GitHubTrackingCommentService;
  beforeEach(() => {
    vi.clearAllMocks();
    store = new MockStore();
    mockResolveGithubTrackingAuth.mockReturnValue({ ok: true, auth: { mode: "token", token: "ghp_test" } });
    service = new GitHubTrackingCommentService(store as unknown as TaskStore);
  });

  it("start/stop are idempotent", async () => {
    service.start();
    service.start();

    store.emit("task:moved", { task: createTask(), from: "todo", to: "in-progress" });
    await flushAsync();
    expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);

    service.stop();
    service.stop();

    store.emit("task:moved", { task: createTask(), from: "todo", to: "in-progress" });
    await flushAsync();
    expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
  });

  it("ignores non-target columns", async () => {
    service.start();

    for (const to of ["triage", "todo", "in-review", "archived"]) {
      store.emit("task:moved", { task: createTask(), from: "todo", to });
    }
    await flushAsync();

    expect(mockCommentOnIssue).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("posts in-progress and done comments in order", async () => {
    service.start();

    store.emit("task:moved", { task: createTask(), from: "todo", to: "in-progress" });
    store.emit("task:moved", { task: createTask(), from: "in-progress", to: "done" });
    await flushAsync();

    expect(mockCommentOnIssue).toHaveBeenCalledTimes(2);
    expect(mockCommentOnIssue).toHaveBeenNthCalledWith(
      1,
      "owner",
      "repo",
      42,
      expect.stringContaining("🚧 In progress"),
    );
    expect(mockCommentOnIssue).toHaveBeenNthCalledWith(
      2,
      "owner",
      "repo",
      42,
      expect.stringContaining("✅ Done"),
    );
  });

  it("writes success logs", async () => {
    service.start();

    store.emit("task:moved", { task: createTask(), from: "todo", to: "done" });
    await flushAsync();

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-1",
      "Posted GitHub tracking comment",
      "owner/repo#42 (done)",
    );
  });

  it("ignores disabled tracking", async () => {
    service.start();

    store.emit("task:moved", {
      task: createTask({ githubTracking: { enabled: false } }),
      from: "todo",
      to: "done",
    });
    await flushAsync();

    expect(mockCommentOnIssue).not.toHaveBeenCalled();
  });

  it("ignores when linked issue is missing", async () => {
    service.start();

    store.emit("task:moved", {
      task: createTask({ githubTracking: { enabled: true } }),
      from: "todo",
      to: "done",
    });
    await flushAsync();

    expect(mockCommentOnIssue).not.toHaveBeenCalled();
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
            url: "u",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
      from: "todo",
      to: "done",
    });
    await flushAsync();

    expect(mockCommentOnIssue).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-1",
      "Failed to post GitHub tracking comment",
      "Linked issue metadata is incomplete",
    );
  });

  it("swallows github errors and keeps listener alive", async () => {
    service.start();
    mockCommentOnIssue.mockRejectedValueOnce(new Error("rate limited"));

    expect(() => {
      store.emit("task:moved", { task: createTask(), from: "todo", to: "done" });
    }).not.toThrow();

    await flushAsync();

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-1",
      "Failed to post GitHub tracking comment",
      "rate limited",
    );

    mockCommentOnIssue.mockResolvedValueOnce(undefined);
    store.emit("task:moved", { task: createTask(), from: "todo", to: "in-progress" });
    await flushAsync();

    expect(mockCommentOnIssue).toHaveBeenCalledTimes(2);
  });

  it("ignores same-column events", async () => {
    service.start();

    store.emit("task:moved", { task: createTask(), from: "done", to: "done" });
    await flushAsync();

    expect(mockCommentOnIssue).not.toHaveBeenCalled();
  });

  it("resolves auth for each call", async () => {
    service.start();

    store.emit("task:moved", { task: createTask(), from: "todo", to: "in-progress" });
    store.emit("task:moved", { task: createTask(), from: "in-progress", to: "done" });
    await flushAsync();

    expect(mockCommentOnIssue).toHaveBeenCalledTimes(2);
    expect(mockResolveGithubTrackingAuth).toHaveBeenCalledTimes(2);
  });
});
