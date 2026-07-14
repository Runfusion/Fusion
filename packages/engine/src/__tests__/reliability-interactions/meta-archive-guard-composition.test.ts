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
      },
    });

    const target = await fixture.store.createTask({
      id: "FN-5064-TARGET-DONE",
      title: "target done",
      description: "target",
      column: "done",
      steps: [],
    } as any);

    const mkMeta = async (id: string, title: string) => fixture.store.createTask({
      id,
      title,
      description: `meta guard test for ${target.id}`,
      sourceParentTaskId: target.id,
      column: "todo",
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

    await fixture.store.updateTask(recentMeta.id, {
      column: "in-progress",
      executionStartedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    } as any);
    await fixture.store.updateTask(retryMeta.id, { taskDoneRetryCount: 1 } as any);
    activeSessionRegistry.registerPath(activeWorktreePath, { taskId: activeMeta.id, kind: "executor", ownerKey: activeMeta.id });

    const branchName = `fusion/${branchMeta.id.toLowerCase()}`;
    git(fixture.rootDir, `git checkout -b ${branchName}`);
    git(fixture.rootDir, "git commit --allow-empty -m \"feat: ahead branch meta\"");
    git(fixture.rootDir, "git checkout main");
    await fixture.store.updateTask(branchMeta.id, { branch: branchName } as any);

    try {
      await (fixture.manager as any).runMaintenance();

      const byId = new Map((await fixture.store.listTasks({ includeArchived: true })).map((task) => [task.id, task]));
      expect(byId.get(branchMeta.id)?.column).not.toBe("archived");
      expect(byId.get(recentMeta.id)?.column).not.toBe("archived");
      expect(byId.get(retryMeta.id)?.column).not.toBe("archived");
      expect(byId.get(activeMeta.id)?.column).not.toBe("archived");
      expect(byId.get(controlMeta.id)?.column).toBe("archived");

      const events = fixture.store.getRunAuditEvents({ limit: 400 });
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
