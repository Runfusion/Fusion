// @vitest-environment node

/*
FNXC:MissionReconciliation 2026-07-20-08:34:
The HTTP regression fixture uses the real PostgreSQL archive path because a mocked `column:"archived"` task cannot prove the retained tombstone+cold-snapshot contract. Success must preserve the parked mission and loop state; every expected domain rejection must be a 4xx with no partial feature, task, or rollup mutation.
*/

import { afterEach, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import express from "express";
import { TaskStore } from "@fusion/core";
import * as schema from "../../../../core/src/postgres/schema/index.js";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../../../../core/src/__test-utils__/pg-test-harness.js";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

pgDescribe("mission reconcile-done route", () => {
  let harness: PgTestHarness;
  let store: TaskStore;
  let app: express.Express;

  beforeEach(async () => {
    harness = await createTaskStoreForTest();
    store = harness.store;
    app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
  });

  afterEach(async () => {
    await harness.teardown();
  });

  const post = (featureId: string, body: unknown) => REQUEST(
    app,
    "POST",
    `/api/missions/features/${featureId}/reconcile-done`,
    JSON.stringify(body),
    { "content-type": "application/json" },
  );

  async function createFeature(title = "Delivered") {
    const missionStore = store.getMissionStore();
    const mission = await missionStore.createMission({ title: "Parked mission" });
    const milestone = await missionStore.addMilestone(mission.id, { title: "Milestone" });
    const slice = await missionStore.addSlice(milestone.id, { title: "Slice" });
    const feature = await missionStore.addFeature(slice.id, { title });
    return { missionStore, mission, milestone, slice, feature };
  }

  it("reconciles a normally archived task atomically without mission-loop side effects", async () => {
    const { missionStore, mission, milestone, slice, feature } = await createFeature();
    const task = await store.createTask({ description: "shipped delivery", column: "done" });
    await store.archiveTask(task.id, { cleanup: false });
    const taskCount = (await store.listTasks()).length;

    const response = await post(feature.id, { taskId: task.id });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: feature.id, taskId: task.id, status: "done", loopState: "idle", implementationAttemptCount: 0 });
    expect(await missionStore.getSlice(slice.id)).toMatchObject({ status: "complete" });
    expect(await missionStore.getMilestone(milestone.id)).toMatchObject({ status: "complete" });
    expect(await missionStore.getMission(mission.id)).toMatchObject({ status: "planning", autopilotEnabled: false, autoAdvance: false });
    expect(await store.getTask(task.id)).toMatchObject({ column: "archived" });
    expect((await store.listTasks()).length).toBe(taskCount);

    const tombstone = await harness.layer.db
      .select({ deletedAt: schema.project.tasks.deletedAt, column: schema.project.tasks.column, missionId: schema.project.tasks.missionId, sliceId: schema.project.tasks.sliceId })
      .from(schema.project.tasks)
      .where(and(eq(schema.project.tasks.projectId, harness.layer.projectId), eq(schema.project.tasks.id, task.id)));
    expect(tombstone).toEqual([{ deletedAt: expect.any(String), column: "archived", missionId: null, sliceId: null }]);

    const idempotent = await post(feature.id, { taskId: task.id });
    expect(idempotent.status).toBe(200);
    expect(idempotent.body).toEqual(response.body);
  });

  it("returns stable 400/404 responses for malformed and unknown inputs", async () => {
    const { feature } = await createFeature();

    expect((await post(feature.id, {})).status).toBe(400);
    expect((await post(feature.id, { taskId: "  " })).status).toBe(400);
    expect((await post("not-a-feature", { taskId: "FN-1" })).status).toBe(400);
    expect((await post("F-MISSING", { taskId: "FN-1" })).status).toBe(404);
    expect((await post(feature.id, { taskId: "FN-MISSING" })).status).toBe(404);
  });

  it("maps every terminal-evidence conflict to 409 without mutation", async () => {
    const { missionStore, mission, slice, feature } = await createFeature("Canonical");
    const other = await missionStore.addFeature(slice.id, { title: "Other" });
    const active = await store.createTask({ description: "active", column: "todo" });
    const invalidDeleted = await store.createTask({ description: "invalid deleted", column: "done" });
    await harness.layer.db.update(schema.project.tasks).set({ deletedAt: new Date().toISOString() }).where(and(
      eq(schema.project.tasks.projectId, harness.layer.projectId),
      eq(schema.project.tasks.id, invalidDeleted.id),
    ));
    const duplicate = await store.createTask({ description: "duplicate link", column: "done" });
    await missionStore.reconcileFeatureDoneWithTerminalTask(other.id, duplicate.id);

    const before = await missionStore.getFeature(feature.id);
    for (const taskId of [active.id, invalidDeleted.id, duplicate.id]) {
      const response = await post(feature.id, { taskId });
      expect(response.status).toBe(409);
      expect(await missionStore.getFeature(feature.id)).toEqual(before);
      expect(await missionStore.getMission(mission.id)).toMatchObject({ status: "planning", autopilotEnabled: false, autoAdvance: false });
    }

    const canonical = await store.createTask({ description: "canonical", column: "done" });
    await missionStore.linkFeatureToTask(feature.id, active.id);
    const linkedBefore = await missionStore.getFeature(feature.id);
    const mismatch = await post(feature.id, { taskId: canonical.id });
    expect(mismatch.status).toBe(409);
    expect(await missionStore.getFeature(feature.id)).toEqual(linkedBefore);
    expect(await store.getTask(canonical.id)).toMatchObject({ missionId: undefined, sliceId: undefined });
  });
});
