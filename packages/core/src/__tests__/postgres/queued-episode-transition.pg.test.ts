import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import { createConnectionSetFromUrl } from "../../postgres/connection.js";
import { createAsyncDataLayer } from "../../postgres/data-layer.js";
import { TaskStore } from "../../store.js";
import { insertTaskRow } from "../../task-store/async/async-persistence.js";

const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_queued_episode" });

const dependency = (ids: string[]) => ({
  signature: `dependency:${[...new Set(ids)].sort().join(",")}`,
  blockedBy: ids[0] ?? null,
  overlapBlockedBy: null,
  action: `queued — unmet dependencies: ${ids.join(", ")}`,
});
const overlap = (id: string) => ({
  signature: `file-scope:${id}`,
  blockedBy: null,
  overlapBlockedBy: id,
  action: `queued — waiting for active file-scope lease ${id}`,
});

pgDescribe("queued episode transition", () => {
  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  afterEach(h.afterEach);

  it("logs once for an unchanged full dependency episode and again when its full set changes", async () => {
    const task = await h.store().createTask({ description: "queued task" });
    expect((await h.store().transitionQueuedEpisode(task.id, dependency(["FN-A", "FN-B"]))).appended).toBe(true);
    expect((await h.store().transitionQueuedEpisode(task.id, dependency(["FN-A", "FN-B"]))).appended).toBe(false);
    expect((await h.store().transitionQueuedEpisode(task.id, dependency(["FN-A", "FN-C"]))).appended).toBe(true);
    const updated = await h.store().getTask(task.id);
    expect(updated.blockedBy).toBe("FN-A");
    expect(updated.log?.filter((entry) => entry.action.startsWith("queued — unmet dependencies"))).toHaveLength(2);
  });

  it("switches queue kind and re-arms after a cleared state", async () => {
    const task = await h.store().createTask({ description: "queue boundaries" });
    await h.store().transitionQueuedEpisode(task.id, dependency(["FN-A"]));
    await h.store().transitionQueuedEpisode(task.id, overlap("FN-LOCK"));
    await h.store().updateTask(task.id, { status: null, blockedBy: null, overlapBlockedBy: null });
    expect((await h.store().transitionQueuedEpisode(task.id, overlap("FN-LOCK"))).appended).toBe(true);
    const updated = await h.store().getTask(task.id);
    expect(updated.log?.filter((entry) => entry.action.startsWith("queued —"))).toHaveLength(3);
  });

  it("serializes separate-store producers and keeps the committed episode suppressed after reconstruction", async () => {
    const task = await h.store().createTask({ description: "concurrent queue" });
    const backend: ResolvedBackend = {
      mode: "external",
      runtimeUrl: h.testUrl(),
      migrationUrl: h.testUrl(),
      migrationUrlOverridden: true,
      directSessionUrl: h.testUrl(),
      directSessionProvenance: "migration-override",
    };
    const [connections, root] = await Promise.all([
      createConnectionSetFromUrl(backend, { projectId: "", useRuntimeRole: true }),
      mkdtemp(join(tmpdir(), "fusion-queued-episode-reconstructed-")),
    ]);
    try {
      const reconstructed = new TaskStore(root, undefined, {
        asyncLayer: createAsyncDataLayer(connections, { projectId: "" }),
      });
      const results = await Promise.all(Array.from(
        { length: 8 },
        (_, index) => (index % 2 === 0 ? h.store() : reconstructed).transitionQueuedEpisode(task.id, overlap("FN-LOCK")),
      ));
      expect(results.filter((result) => result.appended)).toHaveLength(1);
      expect((await reconstructed.transitionQueuedEpisode(task.id, overlap("FN-LOCK"))).appended).toBe(false);
      const row = (await h.adminDb().select().from(schema.project.tasks).where(and(
        eq(schema.project.tasks.projectId, "__legacy_unscoped__"),
        eq(schema.project.tasks.id, task.id),
      )))[0];
      expect(row?.queuedLogEpisodeSignature).toBe("file-scope:FN-LOCK");
      expect((await reconstructed.getTask(task.id))?.log?.filter((entry) => entry.action.startsWith("queued —"))).toHaveLength(1);
    } finally {
      await Promise.allSettled([connections.close(), rm(root, { recursive: true, force: true })]);
    }
  });

  it("keeps same task IDs isolated between projects", async () => {
    const backend: ResolvedBackend = {
      mode: "external",
      runtimeUrl: h.testUrl(),
      migrationUrl: h.testUrl(),
      migrationUrlOverridden: true,
      directSessionUrl: h.testUrl(),
      directSessionProvenance: "migration-override",
    };
    const [connectionsA, connectionsB, rootA, rootB] = await Promise.all([
      createConnectionSetFromUrl(backend, { projectId: "project-a", useRuntimeRole: true }),
      createConnectionSetFromUrl(backend, { projectId: "project-b", useRuntimeRole: true }),
      mkdtemp(join(tmpdir(), "fusion-queued-episode-a-")),
      mkdtemp(join(tmpdir(), "fusion-queued-episode-b-")),
    ]);
    try {
      const layerA = createAsyncDataLayer(connectionsA, { projectId: "project-a" });
      const layerB = createAsyncDataLayer(connectionsB, { projectId: "project-b" });
      const storeA = new TaskStore(rootA, undefined, { asyncLayer: layerA });
      const storeB = new TaskStore(rootB, undefined, { asyncLayer: layerB });
      const now = new Date().toISOString();
      const row = { id: "FN-SAME", description: "same id", column: "todo", currentStep: 0, createdAt: now, updatedAt: now };
      await Promise.all([insertTaskRow(layerA, row, { lineageId: null }), insertTaskRow(layerB, row, { lineageId: null })]);

      await expect(Promise.all([
        storeA.transitionQueuedEpisode(row.id, overlap("FN-LOCK")),
        storeB.transitionQueuedEpisode(row.id, overlap("FN-LOCK")),
      ])).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ appended: true }),
        expect.objectContaining({ appended: true }),
      ]));
      expect((await storeA.getTask(row.id))?.log?.filter((entry) => entry.action.startsWith("queued —"))).toHaveLength(1);
      expect((await storeB.getTask(row.id))?.log?.filter((entry) => entry.action.startsWith("queued —"))).toHaveLength(1);
    } finally {
      await Promise.allSettled([
        connectionsA.close(), connectionsB.close(), rm(rootA, { recursive: true, force: true }), rm(rootB, { recursive: true, force: true }),
      ]);
    }
  });

  it("rolls back queue fields, marker, and log together when persistence fails", async () => {
    const task = await h.store().createTask({ description: "rollback queue transition" });
    await h.adminDb().execute(sql.raw(`
      CREATE FUNCTION public.fail_queued_episode_transition_for_test() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.id = '${task.id}' THEN RAISE EXCEPTION 'forced queued episode failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_queued_episode_transition_for_test
      BEFORE UPDATE ON project.tasks FOR EACH ROW EXECUTE FUNCTION public.fail_queued_episode_transition_for_test();
    `));
    try {
      await expect(h.store().transitionQueuedEpisode(task.id, overlap("FN-LOCK"))).rejects.toThrow("Failed query");
      const rolledBack = await h.store().getTask(task.id);
      expect(rolledBack?.status).not.toBe("queued");
      expect(rolledBack?.queuedLogEpisodeSignature).toBeUndefined();
      expect(rolledBack?.log?.filter((entry) => entry.action.startsWith("queued —"))).toHaveLength(0);
    } finally {
      await h.adminDb().execute(sql.raw(`
        DROP TRIGGER fail_queued_episode_transition_for_test ON project.tasks;
        DROP FUNCTION public.fail_queued_episode_transition_for_test();
      `));
    }
    expect((await h.store().transitionQueuedEpisode(task.id, overlap("FN-LOCK"))).appended).toBe(true);
  });
});
