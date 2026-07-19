import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore, type Task } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { GitLabSourceIssueReconciler } from "../gitlab-source-issue-reconciler.js";

const { mockResolveGitLabClient, mockGetProjectIssue, mockGetMergeRequest } = vi.hoisted(() => ({
  mockResolveGitLabClient: vi.fn(),
  mockGetProjectIssue: vi.fn(),
  mockGetMergeRequest: vi.fn(),
}));

vi.mock("../gitlab-lifecycle.js", async () => {
  const actual = await vi.importActual<typeof import("../gitlab-lifecycle.js")>("../gitlab-lifecycle.js");
  return {
    ...actual,
    resolveGitLabClient: (...args: unknown[]) => mockResolveGitLabClient(...args),
  };
});

function createStore(listTasks: Task[]): TaskStore {
  return {
    listTasks: vi.fn().mockResolvedValue(listTasks),
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

function gitlabTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "done",
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    steps: [],
    dependencies: [],
    log: [],
    sourceIssue: {
      provider: "gitlab",
      repository: "group/project",
      externalIssueId: "123",
      issueNumber: 42,
      url: "https://gitlab.example.test/group/project/-/issues/42",
    },
    source: {
      sourceType: "gitlab_import",
      sourceMetadata: {
        provider: "gitlab",
        resourceType: "project_issue",
        projectPath: "group/project",
        iid: 42,
      },
    },
    ...overrides,
  } as Task;
}

describe("GitLabSourceIssueReconciler.backfillSourceIssueClosedAt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveGitLabClient.mockResolvedValue({
      ok: true,
      client: {
        getProjectIssue: (...args: unknown[]) => mockGetProjectIssue(...args),
        getMergeRequest: (...args: unknown[]) => mockGetMergeRequest(...args),
      },
    });
    mockGetProjectIssue.mockResolvedValue({ state: "opened" });
    mockGetMergeRequest.mockResolvedValue({ state: "opened" });
  });

  it("persists real GitLab issue closedAt timestamps for done source issues", async () => {
    const closedAt = "2026-07-02T12:34:56.000Z";
    mockGetProjectIssue.mockResolvedValueOnce({ state: "closed", closedAt });
    const task = gitlabTask("FN-1");
    const store = createStore([task]);

    const result = await new GitLabSourceIssueReconciler().backfillSourceIssueClosedAt(store);

    expect(result).toEqual({ scanned: 1, filled: 1, skipped: 0, errors: 0, hasMore: false });
    expect(mockGetProjectIssue).toHaveBeenCalledWith("group/project", 42);
    expect(store.updateTask as any).toHaveBeenCalledWith("FN-1", { sourceIssue: { ...task.sourceIssue, closedAt } });
  });

  it("uses merge request mergedAt/closedAt and skips already-filled rows", async () => {
    const mergedAt = "2026-07-02T13:00:00.000Z";
    mockGetMergeRequest.mockResolvedValueOnce({ state: "merged", mergedAt });
    const mrTask = gitlabTask("FN-2", {
      sourceIssue: {
        provider: "gitlab",
        repository: "group/project",
        externalIssueId: "456",
        issueNumber: 7,
        url: "https://gitlab.example.test/group/project/-/merge_requests/7",
      },
      source: {
        sourceType: "gitlab_import",
        sourceMetadata: { provider: "gitlab", resourceType: "merge_request", projectPath: "group/project", iid: 7 },
      },
    });
    const alreadyFilled = gitlabTask("FN-3", { sourceIssue: { ...gitlabTask("x").sourceIssue!, closedAt: "2026-01-01T00:00:00.000Z" } });
    const store = createStore([mrTask, alreadyFilled]);

    const result = await new GitLabSourceIssueReconciler().backfillSourceIssueClosedAt(store);

    expect(result).toEqual({ scanned: 1, filled: 1, skipped: 0, errors: 0, hasMore: false });
    expect(mockGetMergeRequest).toHaveBeenCalledWith("group/project", 7);
    expect(store.updateTask as any).toHaveBeenCalledTimes(1);
    expect(store.updateTask as any).toHaveBeenCalledWith("FN-2", { sourceIssue: { ...mrTask.sourceIssue, closedAt: mergedAt } });
  });

  it("skips open/unavailable resources and never fabricates closedAt", async () => {
    mockGetProjectIssue.mockResolvedValueOnce({ state: "closed" });
    mockGetMergeRequest.mockResolvedValueOnce({ state: "opened", updatedAt: "2026-07-02T14:00:00.000Z" });
    const store = createStore([
      gitlabTask("FN-4"),
      gitlabTask("FN-5", {
        sourceIssue: { provider: "gitlab", repository: "group/project", externalIssueId: "5", issueNumber: 5 },
        source: { sourceType: "gitlab_import", sourceMetadata: { provider: "gitlab", resourceType: "merge_request", projectPath: "group/project", iid: 5 } },
      }),
      gitlabTask("FN-6", {
        sourceIssue: { provider: "gitlab", repository: "", externalIssueId: "6", issueNumber: Number.NaN },
        source: { sourceType: "gitlab_import", sourceMetadata: { provider: "gitlab", resourceType: "project_issue" } },
      }),
    ]);

    const result = await new GitLabSourceIssueReconciler().backfillSourceIssueClosedAt(store);

    expect(result).toEqual({ scanned: 3, filled: 0, skipped: 3, errors: 0, hasMore: false });
    expect(store.updateTask as any).not.toHaveBeenCalled();
    expect(store.logEntry as any).toHaveBeenCalledWith("FN-6", "Skipped GitLab source issue closed-at backfill", "Linked GitLab source metadata is incomplete");
  });

  it("logs 404 or permission failures without corrupting local metadata", async () => {
    mockGetProjectIssue.mockRejectedValueOnce(new Error("GitLab API 404: not found"));
    const store = createStore([gitlabTask("FN-7")]);

    const result = await new GitLabSourceIssueReconciler().backfillSourceIssueClosedAt(store);

    expect(result).toEqual({ scanned: 1, filled: 0, skipped: 0, errors: 1, hasMore: false });
    expect(store.updateTask as any).not.toHaveBeenCalled();
    expect(store.logEntry as any).toHaveBeenCalledWith("FN-7", "Failed to backfill GitLab source issue closed-at", "GitLab API 404: not found");
  });

  it("returns skipped rows when auth resolution fails and applies pagination", async () => {
    mockResolveGitLabClient.mockResolvedValueOnce({ ok: false, message: "GitLab token missing" });
    const store = createStore([gitlabTask("FN-8"), gitlabTask("FN-9"), gitlabTask("FN-10")]);

    const result = await new GitLabSourceIssueReconciler().backfillSourceIssueClosedAt(store, { offset: 1, limit: 1 });

    expect(result).toEqual({ scanned: 1, filled: 0, skipped: 1, errors: 0, hasMore: true });
    expect(mockGetProjectIssue).not.toHaveBeenCalled();
    expect(store.logEntry as any).toHaveBeenCalledWith("FN-9", "Skipped GitLab source issue closed-at backfill", "GitLab token missing");
  });

  pgDescribe("archived TaskStore rows", () => {
    it("excludes real archived TaskStore rows instead of mutating archiveDb entries", async () => {
      // FNXC:PostgresCutover 2026-07-16-06:50: archived-task reconciliation must
      // use the production async-store archive path after SQLite removal.
      const harness = await createTaskStoreForTest();
      const store = harness.store;

      try {
      const task = await store.createTask({ description: "Archived GitLab issue", sourceIssue: gitlabTask("template").sourceIssue });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, false);
      mockGetProjectIssue.mockResolvedValueOnce({ state: "closed", closedAt: "2026-07-02T15:00:00.000Z" });

      const result = await new GitLabSourceIssueReconciler().backfillSourceIssueClosedAt(store);
      const restored = await store.unarchiveTask(task.id);

      expect(result).toEqual({ scanned: 0, filled: 0, skipped: 0, errors: 0, hasMore: false });
      expect(mockGetProjectIssue).not.toHaveBeenCalled();
      expect(restored.sourceIssue?.closedAt).toBeUndefined();
      } finally {
        await harness.teardown();
      }
    });
  });
});
