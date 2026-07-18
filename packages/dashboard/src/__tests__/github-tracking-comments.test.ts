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
  GitHubClient: vi.fn().mockImplementation(function () { return {
    commentOnIssue: (...args: unknown[]) => mockCommentOnIssue(...args),
  }; }),
}));

vi.mock("../github-auth.js", () => ({
  resolveGithubTrackingAuth: (...args: unknown[]) => mockResolveGithubTrackingAuth(...args),
}));

const { mockGetCliPackageVersion } = vi.hoisted(() => ({
  mockGetCliPackageVersion: vi.fn(() => "0.57.0"),
}));

/*
 * FNXC:GitHubTrackingComments 2026-07-15-09:40:
 * Pin the resolved CLI version so self-repo release-line assertions do not drift with each real
 * release. `isUnresolvedCliPackageVersion` keeps its real behavior — fusion-release-version.ts
 * depends on it for the 0.0.0 sentinel fallback.
 */
vi.mock("../cli-package-version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli-package-version.js")>()),
  getCliPackageVersion: () => mockGetCliPackageVersion(),
}));

class MockStore extends EventEmitter {
  logEntry: Mock;
  getTask: Mock;
  getSettings: Mock;
  getGlobalSettingsStore: Mock;

  constructor() {
    super();
    this.logEntry = vi.fn().mockResolvedValue(undefined);
    // Null preserves the event snapshot unless a test supplies a newer authoritative row.
    this.getTask = vi.fn().mockResolvedValue(null);
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

/*
 * FNXC:GitHubTrackingComments 2026-07-15-09:40:
 * Regression coverage for issue #1916. Original symptom: done comments posted on runfusion/fusion
 * issues carried no release version, because FN-7575 added the lines to GitHubIssueCommentService
 * (off by default, no Settings UI) while GitHubTrackingCommentService is what actually posts.
 * These assert the general invariant across every done-comment surface — the pure formatter AND
 * the service that posts — not just the single reported repro.
 */
describe("formatTrackingComment release version lines (issue #1916)", () => {
  const selfRepoTask = {
    id: "FN-7575",
    title: "GitHub comment with release version on Fusion task close",
    branch: "fusion/fn-7575",
  };

  it("appends current and target release lines on a Fusion self-repo done comment", () => {
    const comment = formatTrackingComment(
      selfRepoTask,
      "done",
      { owner: "runfusion", repo: "fusion" },
      { currentVersion: "0.57.0" },
    );

    expect(comment).toContain("Current version: v0.57.0");
    expect(comment).toContain("Target release: v0.58.0");
  });

  it("matches the self-repo slug case-insensitively (issue #1916 uses Runfusion/Fusion)", () => {
    const comment = formatTrackingComment(
      selfRepoTask,
      "done",
      { owner: "Runfusion", repo: "Fusion" },
      { currentVersion: "0.57.0" },
    );

    expect(comment).toContain("Target release: v0.58.0");
  });

  it("bumps the minor and resets the patch", () => {
    const comment = formatTrackingComment(
      selfRepoTask,
      "done",
      { owner: "runfusion", repo: "fusion" },
      { currentVersion: "1.2.9" },
    );

    expect(comment).toContain("Current version: v1.2.9");
    expect(comment).toContain("Target release: v1.3.0");
  });

  it("leaves done comments on every other repo byte-for-byte unchanged", () => {
    const withVersion = formatTrackingComment(
      selfRepoTask,
      "done",
      { owner: "acme", repo: "widgets" },
      { currentVersion: "0.57.0" },
    );

    expect(withVersion).not.toContain("Target release");
    expect(withVersion).not.toContain("Current version");
    // Byte-for-byte identical to the pre-fix output for non-self repos.
    expect(withVersion).toBe(
      formatTrackingComment(selfRepoTask, "done", { owner: "acme", repo: "widgets" }),
    );
  });

  it("omits release lines on the in-progress transition", () => {
    const comment = formatTrackingComment(selfRepoTask, "in-progress", undefined, {
      currentVersion: "0.57.0",
    });

    expect(comment).not.toContain("Target release");
  });

  it("falls back silently when the version is the unresolved 0.0.0 sentinel", () => {
    const comment = formatTrackingComment(
      selfRepoTask,
      "done",
      { owner: "runfusion", repo: "fusion" },
      { currentVersion: "0.0.0" },
    );

    expect(comment).not.toContain("Target release");
    expect(comment).toContain("✅ Done —");
  });

  it("falls back silently when the version is unparseable", () => {
    const comment = formatTrackingComment(
      selfRepoTask,
      "done",
      { owner: "runfusion", repo: "fusion" },
      { currentVersion: "not-a-version" },
    );

    expect(comment).not.toContain("Target release");
    expect(comment).toContain("✅ Done —");
  });

  it("never resolves the package version for non-self repos", () => {
    const resolveVersion = vi.fn(() => "0.57.0");
    formatTrackingComment(selfRepoTask, "done", { owner: "acme", repo: "widgets" }, {
      currentVersion: resolveVersion,
    });

    expect(resolveVersion).not.toHaveBeenCalled();
  });

  it("keeps release lines within the length cap when the title forces truncation", () => {
    const comment = formatTrackingComment(
      {
        id: "FN-1",
        title: "T".repeat(4000),
        branch: "fusion/fn-1",
        mergeDetails: {
          commitSha: "abcdef1234567890",
          mergeCommitMessage: `feat(FN-1): ${"subject ".repeat(200)}`,
          prNumber: 7,
          mergeTargetBranch: "main",
          mergedAt: "2026-05-12T10:00:00.000Z",
          filesChanged: 3,
        },
      },
      "done",
      { owner: "runfusion", repo: "fusion" },
      { currentVersion: "0.57.0" },
    );

    expect(comment.length).toBeLessThanOrEqual(2000);
    expect(comment).toContain("Target release: v0.58.0");
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

  /*
   * FNXC:GitHubTrackingComments 2026-07-15-09:40:
   * Issue #1916 symptom verification at the surface that actually posts: a done comment on a
   * runfusion/fusion issue must carry the release lines. The pure-formatter tests above cannot
   * catch a service wired to a version resolver that never runs, so assert the posted body.
   */
  it("posts release version lines on a Fusion self-repo done comment", async () => {
    service.start();

    store.emit("task:moved", {
      task: createTask({
        githubTracking: {
          enabled: true,
          issue: {
            owner: "Runfusion",
            repo: "Fusion",
            number: 1916,
            url: "https://github.com/Runfusion/Fusion/issues/1916",
            createdAt: "2026-07-05T15:30:13.000Z",
          },
        },
      }),
      from: "in-progress",
      to: "done",
    });
    await flushAsync();

    const body = mockCommentOnIssue.mock.calls[0]?.[3] as string;
    expect(body).toContain("✅ Done");
    expect(body).toContain("Current version: v0.57.0");
    expect(body).toContain("Target release: v0.58.0");
  });

  it("posts no release version lines on a done comment for any other repo", async () => {
    service.start();

    store.emit("task:moved", { task: createTask(), from: "in-progress", to: "done" });
    await flushAsync();

    const body = mockCommentOnIssue.mock.calls[0]?.[3] as string;
    expect(body).toContain("✅ Done");
    expect(body).not.toContain("Target release");
    expect(body).not.toContain("Current version");
  });

  it("recovers a landing commit from the authoritative row when the done event is stale", async () => {
    service.start();
    const snapshot = createTask({ mergeDetails: { prNumber: 7 } });
    store.getTask.mockResolvedValueOnce(createTask({
      mergeDetails: { commitSha: "abcdef1234567890", prNumber: 7 },
    }));

    store.emit("task:moved", { task: snapshot, from: "in-progress", to: "done" });
    await flushAsync();

    expect(store.getTask).toHaveBeenCalledWith("FN-1");
    expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
    expect(mockCommentOnIssue.mock.calls[0]?.[3]).toContain(
      "Commit: [abcdef1](https://github.com/owner/repo/commit/abcdef1234567890)",
    );
  });

  it("keeps an event-snapshot commit link when the authoritative row is unavailable", async () => {
    service.start();
    store.getTask.mockRejectedValueOnce(new Error("store unavailable"));

    store.emit("task:moved", {
      task: createTask({ mergeDetails: { commitSha: "abcdef1234567890" } }),
      from: "in-progress",
      to: "done",
    });
    await flushAsync();

    expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
    expect(mockCommentOnIssue.mock.calls[0]?.[3]).toContain(
      "Commit: [abcdef1](https://github.com/owner/repo/commit/abcdef1234567890)",
    );
  });

  it("keeps an event-snapshot commit link when the authoritative row is missing", async () => {
    service.start();
    store.getTask.mockResolvedValueOnce(null);

    store.emit("task:moved", {
      task: createTask({ mergeDetails: { commitSha: "abcdef1234567890" } }),
      from: "in-progress",
      to: "done",
    });
    await flushAsync();

    expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
    expect(mockCommentOnIssue.mock.calls[0]?.[3]).toContain(
      "Commit: [abcdef1](https://github.com/owner/repo/commit/abcdef1234567890)",
    );
  });

  it("posts a no-op landing without a Commit line", async () => {
    service.start();
    store.getTask.mockResolvedValueOnce(createTask({ mergeDetails: { noOpMerge: true } }));

    store.emit("task:moved", {
      task: createTask({ mergeDetails: { noOpMerge: true } }),
      from: "in-progress",
      to: "done",
    });
    await flushAsync();

    expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
    expect(mockCommentOnIssue.mock.calls[0]?.[3]).not.toContain("Commit:");
  });

  it("does not refetch or duplicate a comment for in-progress and same-column transitions", async () => {
    service.start();

    store.emit("task:moved", { task: createTask(), from: "todo", to: "in-progress" });
    store.emit("task:moved", { task: createTask(), from: "done", to: "done" });
    await flushAsync();

    expect(store.getTask).not.toHaveBeenCalled();
    expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
    expect(mockCommentOnIssue.mock.calls[0]?.[3]).toContain("🚧 In progress");
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
