// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, type Goal } from "@fusion/core";
import { createMissionRouter } from "../mission-routes.js";
import { get, request } from "../test-request.js";

async function createFixture() {
  const rootDir = mkdtempSync(join(tmpdir(), "kb-mission-goal-links-"));
  const globalDir = join(rootDir, ".fusion-global-settings");
  const store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
  await store.init();

  const app = express();
  app.use(express.json());
  app.use("/api/missions", createMissionRouter(store));

  return { app, store, rootDir };
}

describe("mission goal linkage routes", () => {
  let rootDir: string;
  let app: express.Express;
  let store: TaskStore;

  beforeEach(async () => {
    ({ app, store, rootDir } = await createFixture());
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("lists empty and populated linked goals", async () => {
    const mission = store.getMissionStore().createMission({ title: "Ship mission" });
    const goalA = store.getGoalStore().createGoal({ title: "Goal A" });
    const goalB = store.getGoalStore().createGoal({ title: "Goal B" });

    const empty = await get(app, `/api/missions/${mission.id}/goals`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ goals: [] });

    store.getMissionStore().linkGoal(mission.id, goalA.id);
    store.getMissionStore().linkGoal(mission.id, goalB.id);

    const populated = await get(app, `/api/missions/${mission.id}/goals`);
    expect(populated.status).toBe(200);
    expect((populated.body as { goals: Goal[] }).goals.map((goal) => goal.id)).toEqual([goalA.id, goalB.id]);
  });

  it("sets the full linked goal set", async () => {
    const mission = store.getMissionStore().createMission({ title: "Ship mission" });
    const goalA = store.getGoalStore().createGoal({ title: "Goal A" });
    const goalB = store.getGoalStore().createGoal({ title: "Goal B" });
    const goalC = store.getGoalStore().createGoal({ title: "Goal C" });
    store.getMissionStore().linkGoal(mission.id, goalA.id);
    store.getMissionStore().linkGoal(mission.id, goalB.id);

    const response = await request(
      app,
      "PUT",
      `/api/missions/${mission.id}/goals`,
      JSON.stringify({ goalIds: [goalB.id, goalC.id, goalC.id] }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect((response.body as { goals: Goal[] }).goals.map((goal) => goal.id)).toEqual([goalB.id, goalC.id]);
    expect(store.getMissionStore().listGoalIdsForMission(mission.id)).toEqual([goalB.id, goalC.id]);
  });

  it("adds a linked goal idempotently", async () => {
    const mission = store.getMissionStore().createMission({ title: "Ship mission" });
    const goal = store.getGoalStore().createGoal({ title: "Goal A" });

    const first = await request(app, "POST", `/api/missions/${mission.id}/goals/${goal.id}`);
    expect(first.status).toBe(200);
    expect((first.body as { goals: Goal[] }).goals.map((entry) => entry.id)).toEqual([goal.id]);

    const second = await request(app, "POST", `/api/missions/${mission.id}/goals/${goal.id}`);
    expect(second.status).toBe(200);
    expect((second.body as { goals: Goal[] }).goals.map((entry) => entry.id)).toEqual([goal.id]);
    expect(store.getMissionStore().listGoalIdsForMission(mission.id)).toEqual([goal.id]);
  });

  it("removes a linked goal idempotently", async () => {
    const mission = store.getMissionStore().createMission({ title: "Ship mission" });
    const goal = store.getGoalStore().createGoal({ title: "Goal A" });
    store.getMissionStore().linkGoal(mission.id, goal.id);

    const first = await request(app, "DELETE", `/api/missions/${mission.id}/goals/${goal.id}`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ removed: true, goals: [] });

    const second = await request(app, "DELETE", `/api/missions/${mission.id}/goals/${goal.id}`);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ removed: true, goals: [] });
  });

  it("returns 400 for malformed goal ids", async () => {
    const mission = store.getMissionStore().createMission({ title: "Ship mission" });

    const listBad = await get(app, `/api/missions/not-a-mission/goals`);
    expect(listBad.status).toBe(400);

    const setBad = await request(
      app,
      "PUT",
      `/api/missions/${mission.id}/goals`,
      JSON.stringify({ goalIds: ["bad-goal-id"] }),
      { "content-type": "application/json" },
    );
    expect(setBad.status).toBe(400);

    const addBad = await request(app, "POST", `/api/missions/${mission.id}/goals/not-a-goal`);
    expect(addBad.status).toBe(400);

    const deleteBad = await request(app, "DELETE", `/api/missions/${mission.id}/goals/not-a-goal`);
    expect(deleteBad.status).toBe(400);
  });

  it("returns 404 for missing mission or goal", async () => {
    const mission = store.getMissionStore().createMission({ title: "Ship mission" });
    const goal = store.getGoalStore().createGoal({ title: "Goal A" });

    const missingMissionList = await get(app, "/api/missions/M-404/goals");
    expect(missingMissionList.status).toBe(404);

    const missingMissionAdd = await request(app, "POST", `/api/missions/M-404/goals/${goal.id}`);
    expect(missingMissionAdd.status).toBe(404);

    const missingGoalAdd = await request(app, "POST", `/api/missions/${mission.id}/goals/G-404`);
    expect(missingGoalAdd.status).toBe(404);

    const missingGoalSet = await request(
      app,
      "PUT",
      `/api/missions/${mission.id}/goals`,
      JSON.stringify({ goalIds: [goal.id, "G-404"] }),
      { "content-type": "application/json" },
    );
    expect(missingGoalSet.status).toBe(404);

    const missingGoalDelete = await request(app, "DELETE", `/api/missions/${mission.id}/goals/G-404`);
    expect(missingGoalDelete.status).toBe(404);
  });
});
