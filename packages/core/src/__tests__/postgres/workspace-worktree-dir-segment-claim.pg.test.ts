import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

/*
FNXC:WorkspaceWorktree 2026-09-04-05:15:
The unique claim is live-only. Archive soft-deletes the holder (`deleted_at`) and disposes its
checkouts; a later task must be able to pin the released branch/title slug through the shipped
`pinWorkspaceWorktreeDirSegment` writer, not fall back to a task-id directory.
*/
pgTest("workspace worktree directory segment claim (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_workspace_segment_claim",
    projectId: "proj-segment-claim",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("releases an archived task's segment so a successor can claim it", async () => {
    const store = h.store();
    const holder = await store.createTask({ description: "holds the released workspace name" });
    const first = await store.pinWorkspaceWorktreeDirSegment(holder.id, "foo");
    expect(first).toMatchObject({ segment: "foo", minted: true, claimed: true });

    const rival = await store.createTask({ description: "waits for the released workspace name" });
    const blocked = await store.pinWorkspaceWorktreeDirSegment(rival.id, "foo");
    expect(blocked).toMatchObject({ minted: false, claimed: false, segment: "foo" });

    await store.archiveTask(holder.id, { cleanup: false });

    const released = await store.pinWorkspaceWorktreeDirSegment(rival.id, "foo");
    expect(released).toMatchObject({ segment: "foo", minted: true, claimed: true });
    expect((await store.getTask(rival.id)).workspaceWorktreeDirSegment).toBe("foo");
  });

  it("does not reclaim a live successor's segment when unarchiving a holder with surviving paths", async () => {
    /*
    FNXC:WorkspaceWorktree 2026-09-04-05:44:
    Restore used to write the tombstone's pin while clearing `deleted_at`. Surviving workspace
    paths made that write happen even after a successor had claimed the released name, so the
    live-only unique index aborted unarchive. Leave the restored pin null when the name is live.
    */
    const store = h.store();
    const surviving = await mkdtemp(join(tmpdir(), "fusion-segment-restore-"));
    try {
      await mkdir(join(surviving, "repo-a"));
      const holder = await store.createTask({ description: "archived holder with surviving checkout" });
      await store.pinWorkspaceWorktreeDirSegment(holder.id, "foo");
      await store.updateTask(holder.id, {
        workspaceWorktrees: { "repo-a": { worktreePath: join(surviving, "repo-a"), branch: "fusion/a" } },
      } as never);
      await store.archiveTask(holder.id, { cleanup: false });

      const successor = await store.createTask({ description: "owns foo after archive" });
      expect(await store.pinWorkspaceWorktreeDirSegment(successor.id, "foo")).toMatchObject({
        segment: "foo",
        minted: true,
        claimed: true,
      });

      const restored = await store.unarchiveTask(holder.id);
      expect(restored.workspaceWorktreeDirSegment).toBeUndefined();
      expect((await store.getTask(successor.id)).workspaceWorktreeDirSegment).toBe("foo");
    } finally {
      await rm(surviving, { recursive: true, force: true });
    }
  });

  it("ignores generic task updates that would rewrite a live pin", async () => {
    /*
    FNXC:WorkspaceWorktree 2026-09-04-06:15:
    Only `pinWorkspaceWorktreeDirSegment` may take a live unique claim. A plugin-shaped
    `updateTask` patch must not replace or path-traverse an existing pin.
    */
    const store = h.store();
    const task = await store.createTask({ description: "already pinned" });
    expect(await store.pinWorkspaceWorktreeDirSegment(task.id, "foo")).toMatchObject({
      segment: "foo",
      minted: true,
      claimed: true,
    });
    await store.updateTask(task.id, { workspaceWorktreeDirSegment: "hijacked" } as never);
    expect((await store.getTask(task.id)).workspaceWorktreeDirSegment).toBe("foo");
    await store.updateTask(task.id, {
      workspaceWorktrees: { "repo-a": { worktreePath: join(tmpdir(), "fn-3520-recorded"), branch: "fusion/a" } },
      workspaceWorktreeDirSegment: null,
    } as never);
    expect((await store.getTask(task.id)).workspaceWorktreeDirSegment).toBe("foo");
  });

  it("refuses an unsafe first pin from generic updateTask", async () => {
    /*
    FNXC:WorkspaceWorktree 2026-09-04-07:51:
    `updateTask` is still a first-mint fallback. Persist only a single path component so
    `../../outside` cannot become the write-once directory. Drive the shipped writer.
    */
    const store = h.store();
    const task = await store.createTask({ description: "unsafe first pin" });
    await store.updateTask(task.id, { workspaceWorktreeDirSegment: "../../outside" } as never);
    expect((await store.getTask(task.id)).workspaceWorktreeDirSegment).toBeUndefined();
    await store.updateTask(task.id, { workspaceWorktreeDirSegment: "foo" } as never);
    expect((await store.getTask(task.id)).workspaceWorktreeDirSegment).toBe("foo");
  });
});
