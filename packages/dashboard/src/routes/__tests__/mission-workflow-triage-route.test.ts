// @vitest-environment node

/*
FNXC:MissionWorkflows 2026-06-25-00:00:
Mission route tests encode the invariant that both single-feature and slice bulk triage honor a supplied workflowId, preserve default inheritance when it is omitted, and reject invalid workflow selections before linking features.
*/

import { afterEach, beforeEach, expect, it } from "vitest";
import express from "express";
import { TaskStore } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../../../../core/src/__test-utils__/pg-test-harness.js";
import type { WorkflowIr } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

function linearIr(name: string): WorkflowIr {
  return {
    version: "v1",
    name,
    nodes: [
      { id: "start", kind: "start" },
      { id: "triage", kind: "prompt", config: { name: "Triage", prompt: "review" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "triage", condition: "success" },
      { from: "triage", to: "end", condition: "success" },
    ],
  };
}

pgDescribe("mission triage routes workflowId", () => {
  let harness: PgTestHarness;
  let store: TaskStore;
  let app: express.Express;

  beforeEach(async () => {
    // FNXC:PostgresCutover 2026-07-16-06:50: mission triage route assertions
    // need a real async store because the in-memory SQLite fixture was removed.
    harness = await createTaskStoreForTest();
    store = harness.store;

    app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
  });

  afterEach(async () => {
    await harness.teardown();
  });

  const post = (path: string, body: unknown) =>
    REQUEST(app, "POST", path, JSON.stringify(body), { "content-type": "application/json" });

  async function createMissionFeature(title = "Feature") {
    const missionStore = store.getMissionStore();
    // FNXC:PostgresCutover 2026-07-16-06:55: mission store mutations and
    // reads are asynchronous against PostgreSQL; await each linked entity.
    const mission = await missionStore.createMission({ title: "Mission" });
    const milestone = await missionStore.addMilestone(mission.id, { title: "Milestone" });
    const slice = await missionStore.addSlice(milestone.id, { title: "Slice" });
    const feature = await missionStore.addFeature(slice.id, { title });
    return { missionStore, mission, milestone, slice, feature };
  }

  it("POST /missions/features/:featureId/triage assigns the supplied workflowId", async () => {
    const workflow = await store.createWorkflowDefinition({ name: "Mission Feature Route", ir: linearIr("mission-feature-route") });
    const { feature } = await createMissionFeature("Route Feature");

    const res = await post(`/api/missions/features/${feature.id}/triage`, { workflowId: workflow.id });

    expect(res.status).toBe(200);
    const taskId = (res.body as { taskId: string }).taskId;
    expect((await store.getTaskWorkflowSelectionAsync(taskId))?.workflowId).toBe(workflow.id);
  });

  it("POST /missions/slices/:sliceId/triage-all assigns the supplied workflowId to all created tasks", async () => {
    const workflow = await store.createWorkflowDefinition({ name: "Mission Slice Route", ir: linearIr("mission-slice-route") });
    const { missionStore, slice } = await createMissionFeature("Route Feature 1");
    await missionStore.addFeature(slice.id, { title: "Route Feature 2" });

    const res = await post(`/api/missions/slices/${slice.id}/triage-all`, { workflowId: workflow.id });

    expect(res.status).toBe(200);
    const triaged = (res.body as { triaged: Array<{ taskId: string }> }).triaged;
    expect(triaged).toHaveLength(2);
    expect(await Promise.all(triaged.map(async (feature) => (
      await store.getTaskWorkflowSelectionAsync(feature.taskId)
    )?.workflowId))).toEqual([workflow.id, workflow.id]);
  });

  it("omitting workflowId preserves default workflow inheritance for feature triage", async () => {
    const workflow = await store.createWorkflowDefinition({ name: "Mission Route Default", ir: linearIr("mission-route-default") });
    await store.setDefaultWorkflowId(workflow.id);
    const { feature } = await createMissionFeature("Default Route Feature");

    const res = await post(`/api/missions/features/${feature.id}/triage`, {});

    expect(res.status).toBe(200);
    expect((await store.getTaskWorkflowSelectionAsync((res.body as { taskId: string }).taskId))?.workflowId).toBe(workflow.id);
  });

  it("omitting workflowId preserves default workflow inheritance for slice bulk triage", async () => {
    const workflow = await store.createWorkflowDefinition({ name: "Mission Bulk Route Default", ir: linearIr("mission-bulk-route-default") });
    await store.setDefaultWorkflowId(workflow.id);
    const { slice } = await createMissionFeature("Default Bulk Route Feature");

    const res = await post(`/api/missions/slices/${slice.id}/triage-all`, {});

    expect(res.status).toBe(200);
    const triaged = (res.body as { triaged: Array<{ taskId: string }> }).triaged;
    expect(triaged).toHaveLength(1);
    expect((await store.getTaskWorkflowSelectionAsync(triaged[0].taskId))?.workflowId).toBe(workflow.id);
  });

  it("invalid workflowId type returns 400 without linking the feature", async () => {
    const { missionStore, feature } = await createMissionFeature("Invalid Workflow Feature");

    const res = await post(`/api/missions/features/${feature.id}/triage`, { workflowId: 42 });

    expect(res.status).toBe(400);
    expect((await missionStore.getFeature(feature.id))?.taskId).toBeUndefined();
  });

  it("invalid workflowId type for slice bulk triage returns 400 without linking features", async () => {
    const { missionStore, slice } = await createMissionFeature("Invalid Bulk Workflow Feature");

    const res = await post(`/api/missions/slices/${slice.id}/triage-all`, { workflowId: 42 });

    expect(res.status).toBe(400);
    expect((await missionStore.listFeatures(slice.id)).every((candidate) => !candidate.taskId)).toBe(true);
  });

  it("unknown workflowId returns a 4xx without linking feature or slice tasks", async () => {
    const { missionStore, slice, feature } = await createMissionFeature("Unknown Workflow Feature");
    await missionStore.addFeature(slice.id, { title: "Unknown Workflow Slice Feature" });

    const single = await post(`/api/missions/features/${feature.id}/triage`, { workflowId: "WF-MISSING" });
    expect(single.status).toBeGreaterThanOrEqual(400);
    expect(single.status).toBeLessThan(500);
    expect((await missionStore.getFeature(feature.id))?.taskId).toBeUndefined();

    const bulk = await post(`/api/missions/slices/${slice.id}/triage-all`, { workflowId: "WF-MISSING" });
    expect(bulk.status).toBeGreaterThanOrEqual(400);
    expect(bulk.status).toBeLessThan(500);
    expect((await missionStore.listFeatures(slice.id)).every((candidate) => !candidate.taskId)).toBe(true);
  });
});
