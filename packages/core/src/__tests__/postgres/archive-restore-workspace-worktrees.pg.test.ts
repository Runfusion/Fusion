import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import { isWorkspaceTask } from "../../types.js";

pgDescribe("archive restore workspace worktrees", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_archive_restore_workspace" });
  let root = "";

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); root = await mkdtemp(join(tmpdir(), "fusion-archive-restore-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); await h.afterEach(); });

  async function archivedTask(workspaceWorktrees: Record<string, unknown> | undefined, worktree?: string) {
    const store = h.store();
    const task = await store.createTaskWithReservedId(
      { description: "workspace archive restore", column: "in-review" },
      { taskId: `FN-RESTORE-${Date.now()}-${Math.random()}`, applyDefaultWorkflowSteps: false },
    );
    await store.updateTask(task.id, { workspaceWorktrees, worktree } as never);
    await store.archiveTask(task.id, { cleanup: false });
    return { store, id: task.id };
  }

  it("drops removed repository entries and stale singular worktree on restore", async () => {
    /*
    FNXC:ArchiveRestore 2026-08-15-05:39:
    Archive cleanup can remove every workspace path after the live row was soft-deleted. Unarchive
    must not resurrect those entries or their landedSha values into a false partial-land candidate.
    */
    const removedA = join(root, "repo-a");
    const removedB = join(root, "repo-b");
    const { store, id } = await archivedTask({
      "repo-a": { worktreePath: removedA, branch: "fusion/a", landedSha: "landed-a" },
      "repo-b": { worktreePath: removedB, branch: "fusion/b" },
    }, removedA);

    const restored = await store.unarchiveTask(id);
    expect(restored.workspaceWorktrees).toBeUndefined();
    expect(restored.worktree).toBeUndefined();
    expect(isWorkspaceTask(restored)).toBe(false);
  });

  it("preserves existing repository entries and landed state while removing disposed siblings", async () => {
    const surviving = join(root, "repo-a");
    await mkdir(surviving);
    const { store, id } = await archivedTask({
      "repo-a": { worktreePath: surviving, branch: "fusion/a", landedSha: "landed-a" },
      "repo-b": { worktreePath: join(root, "repo-b"), branch: "fusion/b", landedSha: "landed-b" },
    });

    const restored = await store.unarchiveTask(id);
    expect(restored.workspaceWorktrees).toEqual({
      "repo-a": { worktreePath: surviving, branch: "fusion/a", landedSha: "landed-a" },
    });
    expect(isWorkspaceTask(restored)).toBe(true);
  });

  it("is a no-op for absent and empty workspace maps", async () => {
    for (const workspaceWorktrees of [undefined, {}]) {
      const { store, id } = await archivedTask(workspaceWorktrees);
      const restored = await store.unarchiveTask(id);
      expect(restored.workspaceWorktrees).toBeUndefined();
      expect(isWorkspaceTask(restored)).toBe(false);
    }
  });
});
