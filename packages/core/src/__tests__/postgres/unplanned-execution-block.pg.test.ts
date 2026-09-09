import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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

const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
  prefix: "fusion_unplanned_block",
});

pgDescribe("unplanned execution refusal dedupe", () => {
  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  afterEach(h.afterEach);

  it("atomically records one durable log entry for concurrent repeat calls", async () => {
    const task = await h.store().createTask({ description: "unplanned task" });
    const before = (await h.store().getTask(task.id)).updatedAt;

    const results = await Promise.all(Array.from(
      { length: 8 },
      () => h.store().checkAndRecordUnplannedExecutionBlock(task.id, "episode-a"),
    ));

    expect(results.filter(Boolean)).toHaveLength(1);
    const updated = await h.store().getTask(task.id);
    expect(updated.updatedAt).toBe(before);
    expect(updated.log?.filter((entry) => entry.action.includes("Execution dispatch refused"))).toHaveLength(1);
    const markers = await h.adminDb().select().from(schema.project.unplannedExecutionBlocks);
    expect(markers).toHaveLength(1);
  });

  it("records a new refusal when the planning episode changes", async () => {
    const task = await h.store().createTask({ description: "replanned task" });

    await expect(h.store().checkAndRecordUnplannedExecutionBlock(task.id, "episode-a")).resolves.toBe(true);
    await expect(h.store().checkAndRecordUnplannedExecutionBlock(task.id, "episode-b")).resolves.toBe(true);

    const updated = await h.store().getTask(task.id);
    expect(updated.log?.filter((entry) => entry.action.includes("Execution dispatch refused"))).toHaveLength(2);
  });

  it("keeps the same task id and episode independent across projects", async () => {
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
      mkdtemp(join(tmpdir(), "fusion-refusal-a-")),
      mkdtemp(join(tmpdir(), "fusion-refusal-b-")),
    ]);
    try {
      const layerA = createAsyncDataLayer(connectionsA, { projectId: "project-a" });
      const layerB = createAsyncDataLayer(connectionsB, { projectId: "project-b" });
      const storeA = new TaskStore(rootA, undefined, { asyncLayer: layerA });
      const storeB = new TaskStore(rootB, undefined, { asyncLayer: layerB });
      const now = new Date().toISOString();
      const row = {
        id: "FN-SAME",
        description: "same id",
        column: "todo",
        currentStep: 0,
        createdAt: now,
        updatedAt: now,
      };
      await Promise.all([
        insertTaskRow(layerA, row, { lineageId: null }),
        insertTaskRow(layerB, row, { lineageId: null }),
      ]);

      await expect(Promise.all([
        storeA.checkAndRecordUnplannedExecutionBlock(row.id, "episode-a"),
        storeB.checkAndRecordUnplannedExecutionBlock(row.id, "episode-a"),
      ])).resolves.toEqual([true, true]);

      const markers = await h.adminDb().select().from(schema.project.unplannedExecutionBlocks)
        .where(eq(schema.project.unplannedExecutionBlocks.taskId, row.id));
      expect(markers.map((marker) => marker.projectId).sort()).toEqual(["project-a", "project-b"]);
    } finally {
      await Promise.allSettled([
        connectionsA.close(),
        connectionsB.close(),
        rm(rootA, { recursive: true, force: true }),
        rm(rootB, { recursive: true, force: true }),
      ]);
    }
  });

  it("rolls back the marker when the live task guard finds a deleted task", async () => {
    const deleted = await h.store().createTask({ description: "deleted task" });
    await h.store().deleteTask(deleted.id);
    await expect(h.store().checkAndRecordUnplannedExecutionBlock(deleted.id, "episode-a"))
      .rejects.toThrow(/not found or deleted/);
    const deletedMarkers = await h.adminDb().select().from(schema.project.unplannedExecutionBlocks)
      .where(eq(schema.project.unplannedExecutionBlocks.taskId, deleted.id));
    expect(deletedMarkers).toHaveLength(0);
  });
});
