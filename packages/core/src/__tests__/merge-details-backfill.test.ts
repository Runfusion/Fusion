import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "../store";
import { runAudit } from "../../../../scripts/audit-merge-details.mjs";

describe("FN-4529 FN-4524 FN-4518 mergeDetails backfill", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "fn-4529-"));
  const globalDir = join(rootDir, ".fusion-global");
  let store: TaskStore;

  beforeAll(async () => {
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterAll(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const tasks = await store.listTasks({ includeDone: true, includeArchived: true });
    for (const task of tasks) {
      await store.deleteTask(task.id);
    }
  });

  it("dry-run reports classifications and apply is idempotent", async () => {
    const correct = await store.createTask({ title: "correct", description: "correct", column: "done" });
    const stale = await store.createTask({ title: "stale", description: "stale", column: "done" });
    const legacy = await store.createTask({ title: "legacy", description: "legacy", column: "done" });

    await store.updateTask(correct.id, {
      mergeDetails: {
        commitSha: "sha-correct",
        filesChanged: 2,
        insertions: 8,
        deletions: 1,
        mergeConfirmed: true,
        mergeTargetBranch: "main",
      },
    });

    await store.updateTask(stale.id, {
      mergeDetails: {
        commitSha: "sha-stale",
        filesChanged: 1,
        insertions: 1,
        deletions: 1,
        mergeConfirmed: true,
        mergeTargetBranch: "main",
      },
    });

    await store.updateTask(legacy.id, {
      mergeDetails: {
        filesChanged: 3,
        insertions: 3,
        deletions: 3,
        mergeConfirmed: true,
      },
    });

    const fakeGit = {
      commitExists: (sha: string) => sha !== "sha-missing",
      isAncestorOfMain: () => true,
      getShortstat: (sha: string) => {
        if (sha === "sha-correct") return { filesChanged: 2, insertions: 8, deletions: 1 };
        if (sha === "sha-stale") return { filesChanged: 4, insertions: 10, deletions: 2 };
        return null;
      },
      getCommitSubject: () => `feat(${stale.id}): update`,
      getCommitBody: (sha: string) => (sha === "sha-stale" ? `Fusion-Task-Id: ${stale.id}` : ""),
      getCommitRangeCount: () => 1,
    };

    const dryRun = await runAudit({ store, git: fakeGit, dryRun: true });
    expect(dryRun.applied).toHaveLength(0);
    expect(dryRun.matches.map((entry: { taskId: string }) => entry.taskId)).toContain(correct.id);
    expect(dryRun.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: stale.id, classification: "post-push-sha-refresh" }),
        expect.objectContaining({ taskId: legacy.id, classification: "legacy-no-commit-sha" }),
      ]),
    );

    const staleBeforeApply = await store.getTask(stale.id);
    expect(staleBeforeApply.mergeDetails?.filesChanged).toBe(1);

    const logSpy = vi.spyOn(store, "logEntry");
    const apply = await runAudit({ store, git: fakeGit, dryRun: false });
    expect(apply.applied).toHaveLength(1);
    expect(apply.applied[0]).toEqual(expect.objectContaining({ taskId: stale.id }));
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      stale.id,
      "FN-4529 backfill mergeDetails",
      "1/1/1 → 4/10/2",
    );

    const staleAfterApply = await store.getTask(stale.id, { activityLogLimit: 30 });
    expect(staleAfterApply.mergeDetails?.filesChanged).toBe(4);
    expect(staleAfterApply.mergeDetails?.insertions).toBe(10);
    expect(staleAfterApply.mergeDetails?.deletions).toBe(2);

    const applyAgain = await runAudit({ store, git: fakeGit, dryRun: false });
    expect(applyAgain.applied).toHaveLength(0);

    const legacyAfterApply = await store.getTask(legacy.id);
    expect(legacyAfterApply.mergeDetails?.filesChanged).toBe(3);
    expect(legacyAfterApply.mergeDetails?.insertions).toBe(3);
    expect(legacyAfterApply.mergeDetails?.deletions).toBe(3);
  });
});
