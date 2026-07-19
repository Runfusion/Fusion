// @vitest-environment node

/*
FNXC:MissionAutoMerge 2026-07-18-12:00:
The mission HTTP surface must preserve boolean overrides and accept PATCH null as the
explicit clear operation. Triage through the production router then stamps only false
onto the created task while retaining its shared mission BranchGroup context.
*/

import { afterEach, beforeEach, expect, it } from "vitest";
import express from "express";
import { TaskStore } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../../../../core/src/__test-utils__/pg-test-harness.js";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

pgDescribe("mission autoMerge routes", () => {
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

  const request = (method: "POST" | "PATCH", path: string, body: unknown) =>
    REQUEST(app, method, path, JSON.stringify(body), { "content-type": "application/json" });

  it("round-trips false, true, and clear-to-inherited while triage stamps false", async () => {
    const created = await request("POST", "/api/missions", { title: "Single PR", autoMerge: false });
    expect(created.status).toBe(201);
    const missionId = (created.body as { id: string; autoMerge?: boolean }).id;
    expect((created.body as { autoMerge?: boolean }).autoMerge).toBe(false);

    const enabled = await request("PATCH", `/api/missions/${missionId}`, { autoMerge: true });
    expect(enabled.status).toBe(200);
    expect((enabled.body as { autoMerge?: boolean }).autoMerge).toBe(true);

    const cleared = await request("PATCH", `/api/missions/${missionId}`, { autoMerge: null });
    expect(cleared.status).toBe(200);
    expect((cleared.body as { autoMerge?: boolean }).autoMerge).toBeUndefined();
    expect((await store.getMissionStore().getMission(missionId))?.autoMerge).toBeUndefined();

    const nullCreate = await request("POST", "/api/missions", { title: "Invalid null", autoMerge: null });
    expect(nullCreate.status).toBe(400);

    const missionStore = store.getMissionStore();
    const falseMission = await missionStore.createMission({ title: "False triage", autoMerge: false });
    const milestone = await missionStore.addMilestone(falseMission.id, { title: "Milestone" });
    const slice = await missionStore.addSlice(milestone.id, { title: "Slice" });
    const feature = await missionStore.addFeature(slice.id, { title: "Task is held for one PR" });
    const triaged = await request("POST", `/api/missions/features/${feature.id}/triage`, {});
    expect(triaged.status).toBe(200);
    const task = await store.getTask((triaged.body as { taskId: string }).taskId);
    expect(task?.autoMerge).toBe(false);
    expect(task?.branchContext?.groupId).toBeDefined();
  });
});
