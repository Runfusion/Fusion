import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TaskStore } from "@fusion/core";
import { refreshPrInBackground } from "../routes/register-git-github.js";

vi.mock("../github.js", async () => {
  const actual = await vi.importActual<object>("../github.js");
  class MockGitHubClient {
    async getPrReviewSnapshot() {
      return {
        prInfo: { url: "https://github.com/o/r/pull/1", number: 1, status: "merged", title: "t", headBranch: "h", baseBranch: "main", commentCount: 0 },
        decision: "APPROVED",
        items: [],
      };
    }
    async getPrMergeStatus() {
      return {
        prInfo: { url: "https://github.com/o/r/pull/1", number: 1, status: "merged", title: "t", headBranch: "h", baseBranch: "main", commentCount: 0 },
        reviewDecision: "APPROVED",
        checks: [],
        mergeReady: true,
        blockingReasons: [],
      };
    }
  }
  return { ...actual, GitHubClient: MockGitHubClient };
});

describe("pr merged refresh auto-done", () => {
  let store: TaskStore;
  let rootDir: string;
  let globalDir: string;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fn-4762-pr-merged-root-"));
    globalDir = mkdtempSync(join(tmpdir(), "fn-4762-pr-merged-global-"));
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("moves in-review task to done and records audit", async () => {
    const task = await store.createTask({ description: "pr merged" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updatePrInfo(task.id, {
      url: "https://github.com/o/r/pull/1",
      number: 1,
      status: "open",
      title: "t",
      headBranch: "h",
      baseBranch: "main",
      commentCount: 0,
    });

    await refreshPrInBackground(store, task.id, [(await store.getTask(task.id)).prInfo!]);

    const updated = await store.getTask(task.id);
    expect(updated.column).toBe("done");
    const events = store.getRunAuditEvents({ taskId: task.id, mutationType: "pr:merged-auto-done" });
    expect(events.length).toBeGreaterThan(0);
  });
});
