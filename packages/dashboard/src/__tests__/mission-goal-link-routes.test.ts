// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import express from "express";
import { createSharedPgTaskStoreTestHarness, pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import * as schema from "../../../core/src/postgres/schema/index.js";
import { createMissionRouter } from "../mission-routes.js";
import { request } from "../test-request.js";

const PROJECT_ID = "fx011-dashboard-mission-goals";
const h = createSharedPgTaskStoreTestHarness({ prefix: "fx011_dashboard_mission_goals", projectId: PROJECT_ID });

/*
FNXC:MissionGoalLinking 2026-09-23-09:05:
Every dashboard goal-link write door must inherit the project-scoped store invariant; this real router/store suite prevents create, patch, replace, and single-link endpoints from drifting into independent validation rules.
*/
pgDescribe("mission goal link routes", () => {
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  function app() {
    const server = express();
    server.use(express.json());
    server.use("/api/missions", createMissionRouter(h.store(), undefined, undefined, {
      isRunning: () => true,
      recoverActiveMissions: vi.fn(),
      executeManualValidatorRun: vi.fn(async () => undefined),
    }));
    return server;
  }

  it("links, lists, and replaces same-project goals idempotently", async () => {
    const missionStore = h.store().getMissionStore();
    const goalStore = h.store().getGoalStore();
    const mission = await missionStore.createMission({ title: "Mission A" });
    const goalA = await goalStore.createGoal({ title: "Goal A" });
    const goalB = await goalStore.createGoal({ title: "Goal B" });

    const linked = await request(app(), "POST", `/api/missions/${mission.id}/goals/${goalA.id}`);
    expect(linked.status).toBe(200);
    expect(linked.body.goals).toEqual([expect.objectContaining({ id: goalA.id })]);

    const relinked = await request(app(), "POST", `/api/missions/${mission.id}/goals/${goalA.id}`);
    expect(relinked.status).toBe(200);
    expect(relinked.body.goals).toHaveLength(1);

    const replaced = await request(
      app(),
      "PUT",
      `/api/missions/${mission.id}/goals`,
      JSON.stringify({ goalIds: [goalB.id, goalB.id, goalA.id] }),
      { "content-type": "application/json" },
    );
    expect(replaced.status).toBe(200);
    expect(replaced.body.goals.map((goal: { id: string }) => goal.id)).toEqual([goalA.id, goalB.id]);

    const listed = await request(app(), "GET", `/api/missions/${mission.id}/goals`);
    expect(listed.status).toBe(200);
    expect(listed.body.goals.map((goal: { id: string }) => goal.id)).toEqual([goalA.id, goalB.id]);
  });

  it("shares link validation across mission create and patch goalIds", async () => {
    const goal = await h.store().getGoalStore().createGoal({ title: "Shared goal" });
    const created = await request(
      app(),
      "POST",
      "/api/missions",
      JSON.stringify({ title: "Created with goal", goalIds: [goal.id, goal.id] }),
      { "content-type": "application/json" },
    );
    expect(created.status).toBe(201);
    expect(created.body.linkedGoals).toEqual([expect.objectContaining({ id: goal.id })]);

    const patched = await request(
      app(),
      "PATCH",
      `/api/missions/${created.body.id}`,
      JSON.stringify({ goalIds: [] }),
      { "content-type": "application/json" },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.linkedGoals).toEqual([]);
  });

  it("rejects archived, missing, foreign goals and missing missions without links", async () => {
    const mission = await h.store().getMissionStore().createMission({ title: "Mission A" });
    const archived = await h.store().getGoalStore().createGoal({ title: "Archived" });
    await h.store().getGoalStore().archiveGoal(archived.id);
    const now = new Date().toISOString();
    await h.adminDb().insert(schema.project.goals).values({
      projectId: "fx011-foreign-project",
      id: "G-FX011-FOREIGN",
      title: "Foreign",
      description: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const archivedResponse = await request(app(), "POST", `/api/missions/${mission.id}/goals/${archived.id}`);
    expect(archivedResponse.status).toBe(400);
    expect(archivedResponse.body.details).toMatchObject({ code: "GOAL_ARCHIVED", goalId: archived.id });

    for (const goalId of ["G-FX011-MISSING", "G-FX011-FOREIGN"]) {
      const response = await request(app(), "POST", `/api/missions/${mission.id}/goals/${goalId}`);
      expect(response.status).toBe(400);
      expect(response.body.details).toMatchObject({ code: "GOAL_NOT_FOUND", goalId });
    }

    const missingMission = await request(app(), "POST", `/api/missions/M-FX011-MISSING/goals/${archived.id}`);
    expect(missingMission.status).toBe(404);
    expect(await h.store().getMissionStore().listGoalIdsForMission(mission.id)).toEqual([]);
  });
});
