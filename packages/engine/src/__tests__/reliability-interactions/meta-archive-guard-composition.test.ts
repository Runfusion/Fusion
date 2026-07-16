import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeSessionRegistry } from "../../active-session-registry.js";
// FNXC:SqliteRemoval 2026-07-14: hasPg guard added — makeReliabilityFixture requires PG after SQLite removal (VAL-REMOVAL-005).
import { git, hasGit, hasPg, makeReliabilityFixture } from "./_helpers.js";

const canRun = hasGit && hasPg;
(canRun ? describe : describe.skip)("reliability interactions: meta archive guard composition", () => {
  it("FN-5064: meta-archive guards refuse to destroy substantive work across composition with branch, executor retry, and active session", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5064-COMPOSITION",
      task: { id: "FN-5064-COMPOSITION", title: "anchor", column: "todo" },
      settings: {
        pausedScopeDecayMs: 1,
        metaTaskStallAutoCloseMs: 2 * 60 * 60_000,
        metaTaskActiveExecutionGraceMs: 30 * 60_000,
        boardStallSweepWindowMs: 2 * 60 * 60_000,
        taskPrefix: "FN",
      },
    });

    const target = await fixture.store.createTask({
      id: "FN-5064-TARGET-DONE",
      title: "target done",
      description: "target",
      column: "done",
      steps: [],
    } as any);

    const mkMeta = async (id: string, title: string, column: "todo" | "in-progress" = "todo") => fixture.store.createTask({
      id,
      title,
      description: `meta guard test for ${target.id}`,
      sourceParentTaskId: target.id,
      column,
      noCommitsExpected: true,
      steps: [],
    } as any);

    const branchMeta = await mkMeta("FN-5064-META-BRANCH", `Recover ${target.id}`);
    const recentMeta = await mkMeta("FN-5064-META-RECENT", `Recover ${target.id}`);
    const retryMeta = await mkMeta("FN-5064-META-RETRY", `Recover ${target.id}`);
    const activeWorktreePath = join(fixture.rootDir, "meta-active-worktree");
    await mkdir(activeWorktreePath, { recursive: true });
    const activeMeta = await fixture.store.createTask({
      id: "FN-5064-META-ACTIVE",
      title: `Recover ${target.id}`,
      description: `meta guard test for ${target.id}`,
      sourceParentTaskId: target.id,
      column: "todo",
      noCommitsExpected: true,
      steps: [],
      worktree: activeWorktreePath,
    } as any);
    await fixture.store.updateTask(activeMeta.id, { worktree: activeWorktreePath } as any);
    const controlMeta = await mkMeta("FN-5064-META-CONTROL", `Recover ${target.id}`);

    // FNXC:MetaArchiveGuards 2026-07-16-11:55: Use the board transition API, then persist the activity timestamp, so the PostgreSQL task row models an active executor segment.
    await fixture.store.moveTask(recentMeta.id, "in-progress");
    await fixture.store.updateTask(recentMeta.id, {
      executionStartedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    } as any);
    const persistedRecentMeta = await fixture.store.getTask(recentMeta.id);
    expect(persistedRecentMeta).toEqual(expect.objectContaining({
      column: "in-progress",
      executionStartedAt: expect.any(String),
    }));
    await fixture.store.updateTask(retryMeta.id, { taskDoneRetryCount: 1 } as any);
    expect((await fixture.store.listTasks({ slim: false, includeArchived: true })).find((task) => task.id === recentMeta.id)).toEqual(expect.objectContaining({
      column: "in-progress",
      executionStartedAt: expect.any(String),
    }));
    expect(await (fixture.manager as any).evaluateMetaAutoArchiveGuards(await fixture.store.getTask(recentMeta.id))).toEqual({
      block: true,
      reasons: ["recent-executor-activity"],
    });
    activeSessionRegistry.registerPath(activeWorktreePath, { taskId: activeMeta.id, kind: "executor", ownerKey: activeMeta.id });

    const branchName = `fusion/${branchMeta.id.toLowerCase()}`;
    git(fixture.rootDir, `git checkout -b ${branchName}`);
    git(fixture.rootDir, "git commit --allow-empty -m \"feat: ahead branch meta\"");
    git(fixture.rootDir, "git checkout main");
    await fixture.store.updateTask(branchMeta.id, { branch: branchName } as any);

    try {
      // FNXC:MetaArchiveGuards 2026-07-16-11:55: Exercise the archive pass directly. Full maintenance includes independent recovery passes that may re-home an inactive fixture before this guard composition is evaluated.
      await (fixture.manager as any).autoArchiveResolvedMetaTasks();

      const byId = new Map((await fixture.store.listTasks({ includeArchived: true })).map((task) => [task.id, task]));
      expect(byId.get(branchMeta.id)?.column).not.toBe("archived");
      expect(byId.get(recentMeta.id)?.column).not.toBe("archived");
      expect(byId.get(retryMeta.id)?.column).not.toBe("archived");
      expect(byId.get(activeMeta.id)?.column).not.toBe("archived");
      expect(byId.get(controlMeta.id)?.column).toBe("archived");

      const events = await fixture.store.getRunAuditEventsAsync({ limit: 400 });
      const skipped = events.filter((event) => event.mutationType === "task:auto-archive-meta-resolved-skipped");
      const archived = events.filter((event) => event.mutationType === "task:auto-archived-meta-resolved");
      expect(skipped).toHaveLength(4);
      const blockedByByTask = new Map(skipped.map((event) => [(event.metadata as any)?.taskId, (event.metadata as any)?.blockedBy ?? []]));
      expect(blockedByByTask.get(branchMeta.id)).toEqual(expect.arrayContaining(["branch-has-unique-commits"]));
      expect(blockedByByTask.get(recentMeta.id)).toEqual(expect.arrayContaining(["recent-executor-activity"]));
      expect(blockedByByTask.get(retryMeta.id)).toEqual(expect.arrayContaining(["task-done-retry-pending"]));
      expect(blockedByByTask.get(activeMeta.id)).toEqual(expect.arrayContaining(["active-session"]));
      expect(archived).toHaveLength(1);
      expect((archived[0]?.metadata as any)?.taskId).toBe(controlMeta.id);
    } finally {
      activeSessionRegistry.unregisterPath(activeWorktreePath);
      await fixture.cleanup();
    }
  });
});
