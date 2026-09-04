import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
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
});
