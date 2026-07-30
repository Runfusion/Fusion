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

  it.each([
    { label: "without audit", runContext: undefined, persistMethod: "atomicWriteTaskJson" as const },
    { label: "with audit", runContext: { agentId: "wedge-test", runId: "stale-wedge-write" }, persistMethod: "atomicWriteTaskJsonWithAudit" as const },
  ])("does not let an ordinary $label task write reactivate a resolved episode", async ({ runContext, persistMethod }) => {
    const store = h.store();
    const task = await h.createTestTask();
    await store.updateTask(task.id, {
      wedgeNotification: {
        reasonKey: "failed:stale",
        episodeId: "episode-resolved-before-stale-write",
        status: "active",
        transitionedAt: "2026-07-29T00:00:00.000Z",
      },
    });

    const originalPersist = store[persistMethod].bind(store) as (...args: unknown[]) => Promise<void>;
    let reportStaleSnapshot!: () => void;
    const staleSnapshotReady = new Promise<void>((resolve) => {
      reportStaleSnapshot = resolve;
    });
    let releaseStaleWrite!: () => void;
    const staleWriteMayPersist = new Promise<void>((resolve) => {
      releaseStaleWrite = resolve;
    });
    const persistSpy = vi.spyOn(store, persistMethod) as unknown as {
      mockImplementationOnce: (implementation: (...args: unknown[]) => Promise<void>) => void;
    };
    persistSpy.mockImplementationOnce(async (...args: unknown[]) => {
      reportStaleSnapshot();
      await staleWriteMayPersist;
      await originalPersist(...args);
    });

    const staleWrite = store.updateTask(task.id, { title: "ordinary concurrent update" }, runContext);
    await staleSnapshotReady;
    const resolution = await store.resolveTaskWedgeNotificationEpisode(
      task.id,
      "episode-resolved-before-stale-write",
    );
    releaseStaleWrite();
    const updated = await staleWrite;

    expect(resolution.resolved).toBe(true);
    expect(updated.title).toBe("ordinary concurrent update");
    expect(updated.wedgeNotification).toMatchObject({
      episodeId: "episode-resolved-before-stale-write",
      status: "resolved",
    });
    expect((await store.getTask(task.id)).wedgeNotification).toMatchObject({
      episodeId: "episode-resolved-before-stale-write",
      status: "resolved",
    });
  });
});
