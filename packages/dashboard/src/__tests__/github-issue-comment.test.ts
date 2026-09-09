import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { TaskStore } from "@fusion/core";
import {
  computeNextMinorVersion,
  DEFAULT_COMMENT_TEMPLATE,
  GitHubIssueCommentService,
  isFusionSelfRepo,
} from "../github-issue-comment.js";
import { GitHubTrackingCommentService } from "../github-tracking-comments.js";

const { mockCommentOnIssue } = vi.hoisted(() => ({
  mockCommentOnIssue: vi.fn(),
}));

vi.mock("../github.js", () => ({
  GitHubClient: vi.fn().mockImplementation(function () { return {
    commentOnIssue: (...args: unknown[]) => mockCommentOnIssue(...args),
  }; }),
}));

vi.mock("../github-auth.js", () => ({
  resolveGithubTrackingAuth: () => ({ ok: true, auth: { mode: "token", token: "ghp_test" } }),
}));

class MockStore extends EventEmitter {
  private settings: Record<string, unknown>;
  logEntry: Mock;
  /*
  FNXC:DashboardTests 2026-07-18-12:55:
  GitHubTrackingCommentService re-reads the authoritative task via store.getTask on done moves
  so Done comments can include a landing commit that was not yet on the task:moved snapshot.
  MockStore must implement getTask; returning null keeps the product's snapshot fallback so
  comment-posting assertions stay deterministic.
  */
  getTask: Mock;

  constructor(settings: Record<string, unknown>) {
    super();
    this.settings = settings;
    this.logEntry = vi.fn().mockResolvedValue(undefined);
    this.getTask = vi.fn().mockResolvedValue(null);
  }

  async getSettings(): Promise<Record<string, unknown>> {
    return this.settings;
  }

  setSettings(settings: Record<string, unknown>): void {
    this.settings = settings;
  }

  getRootDir(): string {
    return "/tmp/github-issue-comment-test";
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

describe("isFusionSelfRepo", () => {
  it("matches the canonical slug", () => {
    expect(isFusionSelfRepo("runfusion/fusion")).toBe(true);
  });

  it("matches case-insensitively and trims whitespace", () => {
    expect(isFusionSelfRepo("Runfusion/Fusion")).toBe(true);
    expect(isFusionSelfRepo("  runfusion/fusion  ")).toBe(true);
    expect(isFusionSelfRepo("RUNFUSION/FUSION")).toBe(true);
  });

  it("does not match other repos", () => {
    expect(isFusionSelfRepo("owner/repo")).toBe(false);
    expect(isFusionSelfRepo("runfusion/other")).toBe(false);
    expect(isFusionSelfRepo("other/fusion")).toBe(false);
  });
});

describe("computeNextMinorVersion", () => {
  it("bumps the minor version and resets patch to 0", () => {
    expect(computeNextMinorVersion("0.55.0")).toBe("0.56.0");
  });

  it("resets patch to 0 for a non-zero patch", () => {
    expect(computeNextMinorVersion("1.2.9")).toBe("1.3.0");
  });

  it("tolerates a leading v prefix", () => {
    expect(computeNextMinorVersion("v0.55.0")).toBe("0.56.0");
  });

  it("ignores pre-release/build suffixes", () => {
    expect(computeNextMinorVersion("0.55.0-beta.1")).toBe("0.56.0");
  });

  it("returns null for the unresolved 0.0.0 sentinel", () => {
    expect(computeNextMinorVersion("0.0.0")).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(computeNextMinorVersion("not-a-version")).toBeNull();
    expect(computeNextMinorVersion("")).toBeNull();
  });
});

describe("GitHubIssueCommentService", () => {
  let store: MockStore;
  let service: GitHubIssueCommentService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCommentOnIssue.mockResolvedValue(undefined);
    store = new MockStore({ githubCommentOnDone: true });
    service = new GitHubIssueCommentService(store as unknown as TaskStore, () => "ghp_test", () => "0.55.0");
    service.start();
  });

  afterEach(() => {
    service.stop();
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

  it("posts comment when setting enabled and task moved to done (non-self-repo, byte-for-byte unchanged)", async () => {
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

  it("uses custom template with placeholder substitution for non-self-repo", async () => {
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

  it("appends current + target release version lines for the Fusion self-repo", async () => {
    store.emit("task:moved", {
      task: createTask({
        sourceIssue: { provider: "github", repository: "runfusion/fusion", issueNumber: 42 },
      }),
      from: "in-progress",
      to: "done",
    });
    await flushAsync();

    expect(mockCommentOnIssue).toHaveBeenCalledWith(
      "runfusion",
      "fusion",
      42,
      "✅ Task FN-2623 (Imported task) has been completed and resolved.\n\nCurrent version: v0.55.0\nTarget release: v0.56.0",
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-2623",
      "Posted GitHub issue completion comment",
      "runfusion/fusion#42",
    );
  });

  it("appends release version lines for a case-insensitive self-repo match", async () => {
    store.emit("task:moved", {
      task: createTask({
        sourceIssue: { provider: "github", repository: "Runfusion/Fusion", issueNumber: 42 },
      }),
      from: "in-progress",
      to: "done",
    });
    await flushAsync();

    expect(mockCommentOnIssue).toHaveBeenCalledWith(
      "Runfusion",
      "Fusion",
      42,
      "✅ Task FN-2623 (Imported task) has been completed and resolved.\n\nCurrent version: v0.55.0\nTarget release: v0.56.0",
    );
  });

  it("falls back to the base comment with no version lines when the version is unresolved (0.0.0 sentinel)", async () => {
    const unresolvedService = new GitHubIssueCommentService(
      store as unknown as TaskStore,
      () => "ghp_test",
      () => "0.0.0",
    );
    unresolvedService.start();

    store.emit("task:moved", {
      task: createTask({
        sourceIssue: { provider: "github", repository: "runfusion/fusion", issueNumber: 42 },
      }),
      from: "in-progress",
      to: "done",
    });
    await flushAsync();

    expect(mockCommentOnIssue).toHaveBeenCalledWith(
      "runfusion",
      "fusion",
      42,
      "✅ Task FN-2623 (Imported task) has been completed and resolved.",
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-2623",
      "Posted GitHub issue completion comment",
      "runfusion/fusion#42",
    );

    unresolvedService.stop();
  });

  it("stop unregisters listener", async () => {
    service.stop();

    store.emit("task:moved", { task: createTask(), from: "in-progress", to: "done" });
    await flushAsync();

    expect(mockCommentOnIssue).not.toHaveBeenCalled();
  });
});

/*
 * FNXC:GitHubIssueComment 2026-07-15-11:20:
 * Regression coverage for the double-comment bug: a task carrying BOTH the sourceIssue import
 * linkage and an adopted githubTracking linkage received two done comments on ONE issue.
 * Surface enumeration — suppression must fire ONLY on proven same-issue overlap, and every case
 * where the tracking service stays silent must still get its comment:
 *   suppress: same issue, incl. case-different owner/repo slugs
 *   post:     different issue | tracking disabled | no tracking issue | from === to re-emit
 */
describe("GitHubIssueCommentService duplicate-comment suppression", () => {
  let store: MockStore;
  let service: GitHubIssueCommentService;

  const trackedSameIssue = { enabled: true, issue: { owner: "owner", repo: "repo", number: 123, url: "u", createdAt: "now" } };

  beforeEach(() => {
    vi.clearAllMocks();
    store = new MockStore({ githubCommentOnDone: true });
    service = new GitHubIssueCommentService(store as unknown as TaskStore, () => "ghp_test", () => "0.60.0");
    service.start();
  });

  afterEach(() => service.stop());

  it("suppresses its comment when the tracking service covers the same issue", async () => {
    store.emit("task:moved", { task: createTask({ githubTracking: trackedSameIssue }), from: "in-progress", to: "done" });
    await flushAsync();

    expect(mockCommentOnIssue).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-2623",
      "Skipped GitHub issue completion comment",
      "owner/repo#123 is tracked; GitHub tracking comment covers it",
    );
  });

  it("suppresses when the tracking slug differs only by case", async () => {
    const tracking = { enabled: true, issue: { owner: "Owner", repo: "Repo", number: 123, url: "u", createdAt: "now" } };
    store.emit("task:moved", { task: createTask({ githubTracking: tracking }), from: "in-progress", to: "done" });
    await flushAsync();

    expect(mockCommentOnIssue).not.toHaveBeenCalled();
  });

  it("still posts when tracking points at a DIFFERENT issue (two issues, two comments is correct)", async () => {
    const tracking = { enabled: true, issue: { owner: "other", repo: "tracker", number: 9, url: "u", createdAt: "now" } };
    store.emit("task:moved", { task: createTask({ githubTracking: tracking }), from: "in-progress", to: "done" });
    await flushAsync();

    expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
    expect(mockCommentOnIssue).toHaveBeenCalledWith("owner", "repo", 123, expect.any(String));
  });

  it("still posts when the same-numbered issue lives in a different repo", async () => {
    const tracking = { enabled: true, issue: { owner: "owner", repo: "other-repo", number: 123, url: "u", createdAt: "now" } };
    store.emit("task:moved", { task: createTask({ githubTracking: tracking }), from: "in-progress", to: "done" });
    await flushAsync();

    expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
  });

  it("still posts when tracking is linked but disabled", async () => {
    store.emit("task:moved", { task: createTask({ githubTracking: { ...trackedSameIssue, enabled: false } }), from: "in-progress", to: "done" });
    await flushAsync();

    expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
  });

  it("still posts when tracking is enabled with no linked issue", async () => {
    store.emit("task:moved", { task: createTask({ githubTracking: { enabled: true } }), from: "in-progress", to: "done" });
    await flushAsync();

    expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
  });

  /*
   * FNXC:GitHubIssueComment 2026-07-15-11:20:
   * The tracking service no-ops when from === to, so suppressing on that event would drop the
   * comment entirely rather than dedupe it.
   */
  it("still posts on a same-column re-emit, where the tracking service stays silent", async () => {
    store.emit("task:moved", { task: createTask({ githubTracking: trackedSameIssue }), from: "done", to: "done" });
    await flushAsync();

    expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
  });
});

/*
 * FNXC:GitHubIssueComment 2026-07-15-11:20:
 * Symptom verification for the double-comment bug at the real wiring: BOTH services listening on one
 * store, registered in register-git-github.ts order. The per-service tests above cannot catch a
 * suppression predicate that disagrees with what the tracking service actually does, so assert the
 * total comment count on the issue.
 */
describe("both comment services on one store", () => {
  function bothServices(settings: Record<string, unknown>) {
    const store = new MockStore(settings);
    const issueService = new GitHubIssueCommentService(store as unknown as TaskStore, () => "ghp_test", () => "0.60.0");
    const trackingService = new GitHubTrackingCommentService(store as unknown as TaskStore);
    issueService.start();
    trackingService.start();
    return { store, stop: () => { issueService.stop(); trackingService.stop(); } };
  }

  const adoptedSourceIssue = {
    githubTracking: { enabled: true, issue: { owner: "owner", repo: "repo", number: 123, url: "u", createdAt: "now" } },
    branch: "fusion/fn-2623",
  };

  beforeEach(() => vi.clearAllMocks());

  it("posts exactly one comment — the richer tracking one — when both linkages point at one issue", async () => {
    const { store, stop } = bothServices({ githubCommentOnDone: true, githubAuthMode: "token", githubAuthToken: "ghp_test" });
    store.emit("task:moved", { task: createTask(adoptedSourceIssue), from: "in-progress", to: "done" });
    await flushAsync();
    stop();

    expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
    const body = mockCommentOnIssue.mock.calls[0]?.[3] as string;
    expect(body).toContain("✅ Done —");
    expect(body).toContain("Branch: fusion/fn-2623");
    expect(body).not.toContain("has been completed and resolved");
  });

  it("posts one comment per issue when the linkages point at different issues", async () => {
    const { store, stop } = bothServices({ githubCommentOnDone: true, githubAuthMode: "token", githubAuthToken: "ghp_test" });
    const tracking = { enabled: true, issue: { owner: "other", repo: "tracker", number: 9, url: "u", createdAt: "now" } };
    store.emit("task:moved", { task: createTask({ githubTracking: tracking }), from: "in-progress", to: "done" });
    await flushAsync();
    stop();

    expect(mockCommentOnIssue).toHaveBeenCalledTimes(2);
    expect(mockCommentOnIssue.mock.calls.map((call) => `${call[0]}/${call[1]}#${call[2]}`).sort())
      .toEqual(["other/tracker#9", "owner/repo#123"]);
  });

  it("posts exactly one comment for an imported issue with tracking off", async () => {
    const { store, stop } = bothServices({ githubCommentOnDone: true, githubAuthMode: "token", githubAuthToken: "ghp_test" });
    store.emit("task:moved", { task: createTask(), from: "in-progress", to: "done" });
    await flushAsync();
    stop();

    expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
    expect(mockCommentOnIssue.mock.calls[0]?.[3]).toContain("has been completed and resolved");
  });

  it("posts exactly one comment for a tracked task with githubCommentOnDone off", async () => {
    const { store, stop } = bothServices({ githubCommentOnDone: false, githubAuthMode: "token", githubAuthToken: "ghp_test" });
    store.emit("task:moved", { task: createTask(adoptedSourceIssue), from: "in-progress", to: "done" });
    await flushAsync();
    stop();

    expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
    expect(mockCommentOnIssue.mock.calls[0]?.[3]).toContain("✅ Done —");
  });
});
