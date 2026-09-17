// @vitest-environment node

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTaskLogReadOnlyMessage, type TaskStore } from "@fusion/core";
import { GitHubSourceIssueCloseService } from "../github-source-issue-close.js";
import { GitHubTrackingCommentService } from "../github-tracking-comments.js";
import { GitHubTrackingStateService } from "../github-tracking-state.js";
import { GitHubIssueCommentService } from "../github-issue-comment.js";
import { GitLabDeleteCloseService } from "../gitlab-delete-close.js";
import { GitLabTrackingStateService } from "../gitlab-tracking-state.js";
import { GitLabSourceIssueCloseService } from "../gitlab-source-issue-close.js";
import { GitLabIssueCommentService } from "../gitlab-issue-comment.js";
import { GitLabTrackingCommentService } from "../gitlab-tracking-comments.js";
import { KnowledgeIndexRefreshService } from "../knowledge-index-refresh.js";

class LifecycleStore extends EventEmitter {
  readonly logEntry = vi.fn();
  readonly getTask = vi.fn();
  readonly getSettings = vi.fn().mockResolvedValue({ githubCloseSourceIssueOnDone: true });
  readonly getGlobalSettingsStore = vi.fn(() => ({ getSettings: vi.fn().mockResolvedValue({}) }));
}

async function flushListener(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const refusal = () => new Error(buildTaskLogReadOnlyMessage("KB-031"));

function movedTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "KB-031",
    title: "terminal task",
    sourceIssue: { provider: "gitlab", repository: "owner/repo", issueNumber: 1 },
    githubTracking: { enabled: true, issue: { owner: "owner", repo: "repo", number: 1 } },
    gitlabTracking: { enabled: true, item: { kind: "project_issue", projectPath: "owner/repo", iid: 1 } },
    ...overrides,
  };
}

/** Exercises a real EventEmitter listener and verifies its reporting boundary, not only promise settlement. */
async function expectContainedWarning(run: (store: LifecycleStore) => void): Promise<void> {
  const store = new LifecycleStore();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const unhandled: unknown[] = [];
  const capture = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", capture);
  try {
    run(store);
    await flushListener();
  } finally {
    process.off("unhandledRejection", capture);
  }
  expect(unhandled).toEqual([]);
  expect(warning).toHaveBeenCalledOnce();
  expect(String(warning.mock.calls[0]?.[0])).toContain("KB-031");
}

describe("terminal task lifecycle listener containment", () => {
  afterEach(() => vi.restoreAllMocks());

  it("GitHubTrackingStateService task:moved reports a canonical settings refusal", async () => {
    await expectContainedWarning((store) => {
      store.logEntry.mockRejectedValue(refusal());
      const service = new GitHubTrackingStateService(store as unknown as TaskStore);
      service.start();
      store.emit("task:moved", { task: movedTask({ githubTracking: { enabled: true, issue: {} } }), from: "todo", to: "done" });
    });
  });

  it("GitHubTrackingStateService task:deleted reports a canonical settings refusal", async () => {
    await expectContainedWarning((store) => {
      store.getSettings.mockRejectedValue(refusal());
      const service = new GitHubTrackingStateService(store as unknown as TaskStore);
      service.start();
      store.emit("task:deleted", movedTask({ sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 1 } }), {});
    });
  });

  it("GitHubSourceIssueCloseService reports a canonical settings refusal", async () => {
    await expectContainedWarning((store) => {
      store.getSettings.mockRejectedValue(refusal());
      const service = new GitHubSourceIssueCloseService(store as unknown as TaskStore);
      service.start();
      store.emit("task:moved", { task: movedTask({ sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 1 } }), from: "todo", to: "done" });
    });
  });

  it("GitHubIssueCommentService reports a canonical settings refusal", async () => {
    await expectContainedWarning((store) => {
      store.getSettings.mockRejectedValue(refusal());
      const service = new GitHubIssueCommentService(store as unknown as TaskStore);
      service.start();
      store.emit("task:moved", { task: movedTask({ sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 1 }, githubTracking: undefined }), from: "todo", to: "done" });
    });
  });

  it("GitHubTrackingCommentService reports a canonical settings refusal", async () => {
    await expectContainedWarning((store) => {
      store.logEntry.mockRejectedValue(refusal());
      const service = new GitHubTrackingCommentService(store as unknown as TaskStore);
      service.start();
      store.emit("task:moved", { task: movedTask({ githubTracking: { enabled: true, issue: {} } }), from: "todo", to: "done" });
    });
  });

  it("GitLabDeleteCloseService reports its canonical log refusal", async () => {
    await expectContainedWarning((store) => {
      store.logEntry.mockRejectedValue(refusal());
      const service = new GitLabDeleteCloseService(store as unknown as TaskStore);
      service.start();
      store.emit("task:deleted", movedTask({ gitlabTracking: undefined }), {});
    });
  });

  it("GitLabTrackingStateService reports its canonical log refusal", async () => {
    await expectContainedWarning((store) => {
      store.logEntry.mockRejectedValue(refusal());
      const service = new GitLabTrackingStateService(store as unknown as TaskStore);
      service.start();
      store.emit("task:moved", { task: movedTask(), from: "todo", to: "done" });
    });
  });

  it("GitLabSourceIssueCloseService reports its canonical log refusal", async () => {
    await expectContainedWarning((store) => {
      store.logEntry.mockRejectedValue(refusal());
      store.getSettings.mockResolvedValue({ gitlabCloseSourceIssueOnDone: true });
      const service = new GitLabSourceIssueCloseService(store as unknown as TaskStore);
      service.start();
      store.emit("task:moved", { task: movedTask(), from: "todo", to: "done" });
    });
  });

  it("GitLabIssueCommentService reports a canonical settings refusal", async () => {
    await expectContainedWarning((store) => {
      store.getSettings.mockRejectedValue(refusal());
      const service = new GitLabIssueCommentService(store as unknown as TaskStore);
      service.start();
      store.emit("task:moved", { task: movedTask(), from: "todo", to: "done" });
    });
  });

  it("GitLabTrackingCommentService reports a canonical settings refusal", async () => {
    await expectContainedWarning((store) => {
      store.logEntry.mockRejectedValue(refusal());
      const service = new GitLabTrackingCommentService(store as unknown as TaskStore);
      service.start();
      store.emit("task:moved", { task: movedTask({ gitlabTracking: { item: { kind: "project_issue", iid: 1 } } }), from: "todo", to: "done" });
    });
  });

  it("KnowledgeIndexRefreshService reports a terminal refresh failure", async () => {
    await expectContainedWarning((store) => {
      store.getTask.mockRejectedValue(refusal());
      const service = new KnowledgeIndexRefreshService(store as unknown as TaskStore);
      service.start();
      store.emit("task:moved", { task: movedTask(), from: "todo", to: "done" });
    });
  });

  it("contains the reported combined delete burst without an unhandled rejection", async () => {
    const store = new LifecycleStore();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    store.getSettings.mockRejectedValue(refusal());
    const unhandled: unknown[] = [];
    const capture = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", capture);
    try {
      const github = new GitHubTrackingStateService(store as unknown as TaskStore);
      const gitlab = new GitLabDeleteCloseService(store as unknown as TaskStore);
      github.start();
      gitlab.start();
      store.emit("task:deleted", movedTask({ sourceIssue: { provider: "github", repository: "owner/repo", issueNumber: 1 } }), {});
      await flushListener();
    } finally {
      process.off("unhandledRejection", capture);
    }
    expect(unhandled).toEqual([]);
    expect(warning).toHaveBeenCalledOnce();
  });
});
