/**
 * FNXC:TaskStateReconciliation 2026-07-29-16:10:
 * Wedge resolution is a PostgreSQL compare-and-set across dashboard processes. A resolver that waits behind a replacement write must preserve the replacement episode, while an exact active episode resolves normally.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("TaskStore wedge episode resolution (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_wedge_resolution",
    poolMax: 3,
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterEach(() => vi.restoreAllMocks());
  afterAll(h.afterAll);

  it("resolves the exact active episode", async () => {
    const store = h.store();
    const task = await h.createTestTask();
    await store.updateTask(task.id, {
      wedgeNotification: {
        reasonKey: "failed:stale",
        episodeId: "episode-observed",
        status: "active",
        transitionedAt: "2026-07-29T00:00:00.000Z",
      },
    });

    const result = await store.resolveTaskWedgeNotificationEpisode(task.id, "episode-observed");

    expect(result.resolved).toBe(true);
    expect(result.task.wedgeNotification).toMatchObject({
      episodeId: "episode-observed",
      status: "resolved",
    });
  });

  it("reports a committed resolution when the derived task JSON projection fails", async () => {
    const store = h.store();
    const task = await h.createTestTask();
    await store.updateTask(task.id, {
      wedgeNotification: {
        reasonKey: "failed:stale",
        episodeId: "episode-projection-failure",
        status: "active",
        transitionedAt: "2026-07-29T00:00:00.000Z",
      },
    });
    const writeTaskJsonFile = vi
      .spyOn(store, "writeTaskJsonFile")
      .mockRejectedValueOnce(new Error("projection unavailable"));

    const result = await store.resolveTaskWedgeNotificationEpisode(task.id, "episode-projection-failure");

    expect(writeTaskJsonFile).toHaveBeenCalledTimes(1);
    expect(result.resolved).toBe(true);
    expect(result.task.wedgeNotification).toMatchObject({
      episodeId: "episode-projection-failure",
      status: "resolved",
    });
    expect((await store.getTask(task.id)).wedgeNotification).toMatchObject({
      episodeId: "episode-projection-failure",
      status: "resolved",
    });
  });

  it("preserves a replacement episode committed while the resolver waits on the row lock", async () => {
    const store = h.store();
    const task = await h.createTestTask();
    const projectId = h.layer().projectId ?? "__legacy_unscoped__";
    await store.updateTask(task.id, {
      wedgeNotification: {
        reasonKey: "failed:stale",
        episodeId: "episode-observed",
        status: "active",
        transitionedAt: "2026-07-29T00:00:00.000Z",
      },
    });

    let releaseReplacement!: () => void;
    const replacementMayCommit = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    let reportLocked!: () => void;
    const rowLocked = new Promise<void>((resolve) => {
      reportLocked = resolve;
    });

    const replacement = h.adminSql().begin(async (sql) => {
      await sql`
        SELECT id
        FROM project.tasks
        WHERE project_id = ${projectId} AND id = ${task.id}
        FOR UPDATE
      `;
      reportLocked();
      await replacementMayCommit;
      await sql`
        UPDATE project.tasks
        SET wedge_notification = ${JSON.stringify({
          reasonKey: "failed:new",
          episodeId: "episode-replacement",
          status: "active",
          transitionedAt: "2026-07-29T00:01:00.000Z",
        })}, updated_at = ${"2026-07-29T00:01:00.000Z"}
        WHERE project_id = ${projectId} AND id = ${task.id}
      `;
    });

    await rowLocked;
    const resolution = store.resolveTaskWedgeNotificationEpisode(task.id, "episode-observed");
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseReplacement();

    const [, result] = await Promise.all([replacement, resolution]);
    expect(result.resolved).toBe(false);
    expect((await store.getTask(task.id)).wedgeNotification).toMatchObject({
      episodeId: "episode-replacement",
      status: "active",
    });
  });
});
