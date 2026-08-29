import {access} from "node:fs/promises";
import {join} from "node:path";
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from "vitest";
import {
  LiveTaskWorktreeRemovalRefusedError,
  registerArchiveWorkspaceWorktreeDisposer,
} from "../index.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

/*
FNXC:WorkflowLifecycle 2026-08-15-06:35:
A reported live-removal refusal means none of the archive cleanup chain is safe. This production
archive test protects against a future change that continues with branch or task-directory deletion
after preserving the workspace worktree reservation.
*/
pgDescribe("archive cleanup live-refusal suppression", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({prefix: "archive_live_cleanup"});
  let unregister: (() => void) | undefined;

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await h.afterEach();
  });
  afterAll(h.afterAll);

  async function workspaceTask(column = "done") {
    const store = h.store();
    const task = await store.createTask({column: column as never, title: "workspace", description: "workspace"});
    return store.updateTask(task.id, {workspaceWorktrees: {
      "repo-a": {worktreePath: join(h.rootDir(), ".worktrees", task.id, "repo-a"), branch: `fusion/${task.id}-a`},
    }});
  }

  it("preserves branches and task files when disposal refuses a live task", async () => {
    const store = h.store();
    const task = await workspaceTask();
    unregister = registerArchiveWorkspaceWorktreeDisposer(store, async (snapshot, plan) => ({
      removed: [],
      failed: plan.map((entry) => ({repoRel: entry.repoRel, error: new LiveTaskWorktreeRemovalRefusedError(snapshot.id, entry.repoRel, entry.worktreePath, ["wip-lane"])})),
    }));
    const cleanup = vi.spyOn(store, "cleanupBranchForTask");
    const taskDir = store.taskDir(task.id);

    await store.archiveTask(task.id);

    expect(cleanup).not.toHaveBeenCalled();
    await expect(access(taskDir)).resolves.toBeUndefined();
    expect((await store.getTask(task.id, {includeDeleted: true})).workspaceWorktrees).toEqual(task.workspaceWorktrees);
  });

  it("keeps normal cleanup behavior after successful disposal", async () => {
    const store = h.store();
    const task = await workspaceTask();
    unregister = registerArchiveWorkspaceWorktreeDisposer(store, async (_snapshot, plan) => ({removed: plan.map((entry) => entry.repoRel), failed: []}));
    const cleanup = vi.spyOn(store, "cleanupBranchForTask").mockResolvedValue(undefined);
    const taskDir = store.taskDir(task.id);

    await store.archiveTask(task.id);

    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(access(taskDir)).rejects.toMatchObject({code: "ENOENT"});
  });
});
