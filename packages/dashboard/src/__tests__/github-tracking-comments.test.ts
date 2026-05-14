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

  it.each(["in-progress", "done"] as const)("derives the title from description for %s comments when title is empty", (transition) => {
    const comment = formatTrackingComment({ id: "FN-1", title: "", description: "Ship GitHub tracking fallback" }, transition);
    expect(comment).toContain("Ship GitHub tracking fallback");
    expect(comment).not.toContain("Untitled task");
  });

  it.each(["in-progress", "done"] as const)("derives the title from description for %s comments when title is whitespace", (transition) => {
    const comment = formatTrackingComment({ id: "FN-1", title: "   ", description: "Use description instead" }, transition);
    expect(comment).toContain("Use description instead");
    expect(comment).not.toContain("Untitled task");
  });

  it.each(["in-progress", "done"] as const)("falls back to untitled task for %s comments only when title and description are empty", (transition) => {
    const comment = formatTrackingComment({ id: "FN-1", title: "   ", description: "\n\n  " }, transition);
    expect(comment).toContain("Untitled task");
  });

  it("collapses multiline title whitespace", () => {
    const comment = formatTrackingComment({ id: "FN-1", title: "Line 1\n\n  Line 2" }, "done");
    expect(comment).toContain("Line 1 Line 2");
  });

  it("keeps in-progress comments capped at 500 characters", () => {
    const comment = formatTrackingComment({ id: "FN-1", title: "A".repeat(1000) }, "in-progress");
    expect(comment.length).toBeLessThanOrEqual(500);
    expect(comment).toContain("…");
  });

  it("keeps urls and markdown links out of in-progress comments", () => {
    const comment = formatTrackingComment({ id: "FN-1", title: "hello" }, "in-progress");
    expect(comment).not.toContain("localhost");
    expect(comment).not.toContain("http://");
    expect(comment).not.toContain("https://");
    expect(comment).not.toContain("](");
  });

  it("keeps the legacy done comment when merge details are absent", () => {
    expect(formatTrackingComment({ id: "FN-1", title: "Build thing" }, "done")).toBe(
      "Fusion task: FN-1\n\n✅ Done — “Build thing” is complete.",
    );
  });

  it("formats a done comment with merge details and links", () => {
    const comment = formatTrackingComment(
      {
        id: "FN-1",
        title: "Build thing",
        branch: "fusion/fn-1",
        mergeDetails: {
          commitSha: "abcdef1234567890",
          mergeCommitMessage: "feat(FN-1): ship thing\n\nbody",
          prNumber: 7,
          mergeTargetBranch: "main",
          mergedAt: "2026-05-12T10:00:00.000Z",
          filesChanged: 3,
          insertions: 42,
          deletions: 5,
        },
      },
      "done",
      { owner: "owner", repo: "repo" },
    );

    expect(comment).toContain("abcdef1");
    expect(comment).toContain("featFN-1: ship thing");
    expect(comment).not.toContain("body");
    expect(comment).toContain("Branch: fusion/fn-1");
    expect(comment).toContain("PR: [owner/repo#7](https://github.com/owner/repo/pull/7)");
    expect(comment).toContain("https://github.com/owner/repo/commit/abcdef1234567890");
    expect(comment).toContain("Files: 3 changed (+42 / -5)");
    expect(comment).toContain("Merged: 2026-05-12T10:00:00.000Z");
  });

  it("keeps aggregate Files line when rebaseBaseSha is present", () => {
    const comment = formatTrackingComment(
      {
        id: "FN-1",
        title: "Build thing",
        branch: "fusion/fn-1",
        mergeDetails: {
          commitSha: "abcdef1234567890",
          rebaseBaseSha: "1234567890abcdef",
          mergeCommitMessage: "feat(FN-1): ship thing\n\nbody",
          filesChanged: 3,
          insertions: 42,
          deletions: 5,
        },
      },
      "done",
    );

    expect(comment).toContain("Files: 3 changed (+42 / -5)");
  });

  it("omits empty merge placeholders when only commit details are present", () => {
    const comment = formatTrackingComment(
      {
        id: "FN-1",
        title: "Build thing",
        mergeDetails: {
          commitSha: "abcdef1234567890",
          mergeCommitMessage: "feat(FN-1): ship thing\n\nbody",
        },
      },
      "done",
    );

    expect(comment).toContain("Commit: abcdef1 featFN-1: ship thing");
    expect(comment).not.toContain("Branch:");
    expect(comment).not.toContain("PR:");
    expect(comment).not.toContain("Files:");
    expect(comment).not.toContain("Merged:");
    expect(comment).not.toContain("undefined");
    expect(comment).not.toContain(": \n");
  });

  it("keeps done comments plaintext when link context is missing", () => {
    const comment = formatTrackingComment(
      {
        id: "FN-1",
        title: "Build thing",
        mergeDetails: {
          commitSha: "abcdef1234567890",
          mergeCommitMessage: "feat(FN-1): ship thing",
          prNumber: 7,
        },
      },
      "done",
    );

    expect(comment).toContain("Commit: abcdef1 featFN-1: ship thing");
    expect(comment).toContain("PR: #7");
    expect(comment).not.toContain("](");
    expect(comment).not.toContain("https://");
  });

  it("caps enriched done comments at 2000 characters and drops the commit subject before required lines", () => {
    const comment = formatTrackingComment(
      {
        id: "FN-1",
        title: "Title ".repeat(300),
        branch: "fusion/fn-1",
        mergeDetails: {
          commitSha: "abcdef1234567890",
          mergeCommitMessage: `feat(FN-1): ${"subject ".repeat(220)}\n\nbody`,
          prNumber: 7,
          mergedAt: "2026-05-12T10:00:00.000Z",
          filesChanged: 3,
          insertions: 42,
          deletions: 5,
        },
      },
      "done",
      { owner: "owner", repo: "repo" },
    );

    expect(comment.length).toBeLessThanOrEqual(2000);
    expect(comment).toContain("Fusion task: FN-1");
    expect(comment).toContain("✅ Done —");
    expect(comment).toContain("Branch: fusion/fn-1");
    expect(comment).toContain("PR: [owner/repo#7](https://github.com/owner/repo/pull/7)");
    expect(comment).toContain("Merged: 2026-05-12T10:00:00.000Z");
    expect(comment).toContain("Commit: [abcdef1](https://github.com/owner/repo/commit/abcdef1234567890)");
    expect(comment).not.toContain("subject subject subject");
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

    for (const [from, to] of [["triage", "todo"], ["todo", "triage"], ["todo", "in-review"], ["in-review", "archived"]] as const) {
      store.emit("task:moved", { task: createTask(), from, to });
    }
    await flushAsync();

    expect(mockCommentOnIssue).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("posts in-progress and done comments in order", async () => {
    service.start();

    store.emit("task:moved", { task: createTask(), from: "todo", to: "in-progress" });
    store.emit("task:moved", {
      task: createTask({
        branch: "fusion/fn-1",
        mergeDetails: {
          commitSha: "abcdef1234567890",
          mergeCommitMessage: "feat(FN-1): ship thing",
        },
      }),
      from: "in-progress",
      to: "done",
    });
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
    expect(mockCommentOnIssue.mock.calls[1]?.[3]).toContain("abcdef1");
    expect(mockCommentOnIssue.mock.calls[1]?.[3]).toContain("Branch: fusion/fn-1");
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
