/**
 * FNXC:TaskStateReconciliation 2026-07-29-16:10:
 * Wedge resolution is a PostgreSQL compare-and-set across dashboard processes. A resolver that waits behind a replacement write must preserve the replacement episode, while an exact active episode resolves normally.
 *
 * FNXC:TaskStateReconciliation 2026-07-29-22:01:
 * Resolution projection must hold the task row lock through task JSON, cache, and event publication so a cross-process replacement cannot commit and publish before an older resolved snapshot.
 *
 * FNXC:TaskStateReconciliation 2026-07-29-22:17:
 * A deletion that commits after the compare-and-set but before projection must retain deleted-task semantics instead of returning a stale successful resolution.
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

  it("maps deletion between resolution and projection to a deleted-task failure", async () => {
    const store = h.store();
    const layer = h.layer();
    const task = await h.createTestTask();
    const projectId = layer.projectId ?? "__legacy_unscoped__";
    await store.updateTask(task.id, {
      wedgeNotification: {
        reasonKey: "failed:stale",
        episodeId: "episode-deleted-before-projection",
        status: "active",
        transitionedAt: "2026-07-29T00:00:00.000Z",
      },
    });

    const originalTransactionImmediate = layer.transactionImmediate.bind(layer);
    let reportProjectionPending!: () => void;
    const projectionPending = new Promise<void>((resolve) => {
      reportProjectionPending = resolve;
    });
    let releaseProjection!: () => void;
    const projectionMayStart = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    vi.spyOn(layer, "transactionImmediate").mockImplementationOnce(async (callback) => {
      reportProjectionPending();
      await projectionMayStart;
      return originalTransactionImmediate(callback);
    });

    const resolution = store.resolveTaskWedgeNotificationEpisode(task.id, "episode-deleted-before-projection");
    await projectionPending;
    const deletedAt = "2026-07-29T00:02:00.000Z";
    await h.adminSql()`
      UPDATE project.tasks
      SET deleted_at = ${deletedAt}, updated_at = ${deletedAt}
      WHERE project_id = ${projectId} AND id = ${task.id}
    `;
    releaseProjection();

    await expect(resolution).rejects.toMatchObject({
      name: "TaskDeletedError",
      deletedAt,
    });
  });

  it("does not let resolved publication hide a replacement episode", async () => {
    const store = h.store();
    const task = await h.createTestTask();
    const projectId = h.layer().projectId ?? "__legacy_unscoped__";
    await store.updateTask(task.id, {
      wedgeNotification: {
        reasonKey: "failed:stale",
        episodeId: "episode-publication-observed",
        status: "active",
        transitionedAt: "2026-07-29T00:00:00.000Z",
      },
    });

    const publishedEpisodes: string[] = [];
    store.on("task:updated", (updated) => {
      if (updated.wedgeNotification?.episodeId) publishedEpisodes.push(updated.wedgeNotification.episodeId);
    });
    const originalWriteTaskJsonFile = store.writeTaskJsonFile.bind(store);
    let reportResolutionProjection!: () => void;
    const resolutionProjectionStarted = new Promise<void>((resolve) => {
      reportResolutionProjection = resolve;
    });
    let releaseResolutionProjection!: () => void;
    const resolutionProjectionMayFinish = new Promise<void>((resolve) => {
      releaseResolutionProjection = resolve;
    });
    vi.spyOn(store, "writeTaskJsonFile").mockImplementationOnce(async (...args) => {
      reportResolutionProjection();
      await resolutionProjectionMayFinish;
      await originalWriteTaskJsonFile(...args);
    });

    const resolution = store.resolveTaskWedgeNotificationEpisode(task.id, "episode-publication-observed");
    await resolutionProjectionStarted;

    let reportReplacementAttempt!: () => void;
    const replacementAttempted = new Promise<void>((resolve) => {
      reportReplacementAttempt = resolve;
    });
    const replacement = (async () => {
      reportReplacementAttempt();
      await h.adminSql()`
        UPDATE project.tasks
        SET wedge_notification = ${JSON.stringify({
          reasonKey: "failed:new",
          episodeId: "episode-publication-replacement",
          status: "active",
          transitionedAt: "2026-07-29T00:01:00.000Z",
        })}, updated_at = ${"2026-07-29T00:01:00.000Z"}
        WHERE project_id = ${projectId} AND id = ${task.id}
      `;
      const replacementTask = await store.getTask(task.id);
      await originalWriteTaskJsonFile(store.taskDir(task.id), replacementTask);
      store.emitTaskLifecycleEventSafely("task:updated", [replacementTask]);
      return replacementTask;
    })();
    await replacementAttempted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseResolutionProjection();

    const [resolutionResult, replacementTask] = await Promise.all([resolution, replacement]);
    const projectedTask = await store.readTaskJson(store.taskDir(task.id));

    expect(resolutionResult.resolved).toBe(true);
    expect(replacementTask.wedgeNotification).toMatchObject({
      episodeId: "episode-publication-replacement",
      status: "active",
    });
    expect(projectedTask.wedgeNotification).toMatchObject({
      episodeId: "episode-publication-replacement",
      status: "active",
    });
    expect(publishedEpisodes.at(-1)).toBe("episode-publication-replacement");
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
