import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { createSharedPgTaskStoreTestHarness, pgDescribe } from "../../__test-utils__/pg-test-harness.js";
import { AsyncGoalStore } from "../../async-stores/async-goal-store.js";
import { AsyncMissionStore } from "../../async-stores/async-mission-store.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { createConnectionSetFromUrl } from "../../postgres/connection.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import * as schema from "../../postgres/schema/index.js";

const h = createSharedPgTaskStoreTestHarness({ prefix: "fx011_goal_mission_scope" });
const PROJECT_A = "fx011-project-a";
const PROJECT_B = "fx011-project-b";
const LEGACY_PROJECT = "__legacy_unscoped__";
const SHARED_GOAL_ID = "G-FX011-SHARED";
const MISSION_ID = "M-FX011-A";

function bind(projectId: string | undefined): AsyncDataLayer {
  return { ...h.layer(), projectId };
}

async function seedMission(projectId: string, id = MISSION_ID): Promise<void> {
  const now = new Date().toISOString();
  await h.adminDb().insert(schema.project.missions).values({
    projectId,
    id,
    title: `Mission ${projectId}`,
    description: null,
    status: "planning",
    interviewState: "not_started",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedGoal(projectId: string, title: string, status: "active" | "archived" = "active", id = SHARED_GOAL_ID): Promise<void> {
  const now = new Date().toISOString();
  await h.adminDb().insert(schema.project.goals).values({
    projectId,
    id,
    title,
    description: null,
    status,
    createdAt: now,
    updatedAt: now,
  });
}

pgDescribe("mission-goal project ownership", () => {
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("links a goal visible to the bound goal store through the same project partition", async () => {
    await seedMission(PROJECT_A);
    await seedGoal(PROJECT_A, "Project A goal");

    const goals = new AsyncGoalStore(bind(PROJECT_A));
    const missions = new AsyncMissionStore(bind(PROJECT_A));
    expect(await goals.getGoal(SHARED_GOAL_ID)).toMatchObject({ id: SHARED_GOAL_ID, title: "Project A goal" });

    await expect(missions.linkGoal(MISSION_ID, SHARED_GOAL_ID)).resolves.toMatchObject({
      missionId: MISSION_ID,
      goalId: SHARED_GOAL_ID,
    });
    expect(await missions.listGoalIdsForMission(MISSION_ID)).toEqual([SHARED_GOAL_ID]);
  });

  it("isolates colliding IDs, mutations, active counts, and unbound compatibility reads", async () => {
    await seedGoal(PROJECT_A, "Project A goal");
    await seedGoal(PROJECT_B, "Project B goal");
    await seedGoal(LEGACY_PROJECT, "Legacy goal", "active", "G-FX011-LEGACY");

    const goalsA = new AsyncGoalStore(bind(PROJECT_A));
    const goalsB = new AsyncGoalStore(bind(PROJECT_B));
    const unboundGoals = new AsyncGoalStore(bind(undefined));

    expect((await goalsA.getGoal(SHARED_GOAL_ID))?.title).toBe("Project A goal");
    expect((await goalsB.getGoal(SHARED_GOAL_ID))?.title).toBe("Project B goal");
    expect(await goalsA.getGoal("G-FX011-LEGACY")).toBeNull();
    expect((await unboundGoals.listGoals()).map((goal) => goal.id)).toEqual(["G-FX011-LEGACY"]);

    await goalsA.updateGoal(SHARED_GOAL_ID, { title: "Updated A" });
    await goalsA.archiveGoal(SHARED_GOAL_ID);
    expect(await goalsA.listGoals({ status: "active" })).toEqual([]);
    expect(await goalsB.listGoals({ status: "active" })).toHaveLength(1);
    expect((await goalsB.getGoal(SHARED_GOAL_ID))?.title).toBe("Project B goal");
  });

  it("rejects missing, foreign, and archived goals without a partial link", async () => {
    await seedMission(PROJECT_A);
    await seedGoal(PROJECT_B, "Foreign goal", "active", "G-FX011-FOREIGN");
    await seedGoal(PROJECT_A, "Archived goal", "archived", "G-FX011-ARCHIVED");
    const missions = new AsyncMissionStore(bind(PROJECT_A));

    await expect(missions.linkGoal(MISSION_ID, "G-FX011-MISSING")).rejects.toThrow("Goal G-FX011-MISSING not found");
    await expect(missions.linkGoal(MISSION_ID, "G-FX011-FOREIGN")).rejects.toThrow("Goal G-FX011-FOREIGN not found");
    await expect(missions.linkGoal(MISSION_ID, "G-FX011-ARCHIVED")).rejects.toThrow("Goal G-FX011-ARCHIVED is archived");
    expect(await missions.listGoalIdsForMission(MISSION_ID)).toEqual([]);
  });

  it("keeps duplicate and concurrent relinks idempotent and visible to a fresh store", async () => {
    await seedMission(PROJECT_A);
    await seedGoal(PROJECT_A, "Project A goal");
    const missions = new AsyncMissionStore(bind(PROJECT_A));
    const linkedEvents = vi.fn();
    missions.on("mission:goal-linked", linkedEvents);

    const [first, second] = await Promise.all([
      missions.linkGoal(MISSION_ID, SHARED_GOAL_ID),
      missions.linkGoal(MISSION_ID, SHARED_GOAL_ID),
    ]);
    expect(first).toMatchObject({ missionId: MISSION_ID, goalId: SHARED_GOAL_ID });
    expect(second).toMatchObject({ missionId: MISSION_ID, goalId: SHARED_GOAL_ID });
    expect(linkedEvents).toHaveBeenCalledTimes(1);

    const backend: ResolvedBackend = {
      mode: "external",
      runtimeUrl: h.testUrl(),
      migrationUrl: h.testUrl(),
      migrationUrlOverridden: false,
      directSessionUrl: h.testUrl(),
      directSessionProvenance: "migration-override",
    };
    const freshConnections = await createConnectionSetFromUrl(backend, { projectId: PROJECT_A, poolMax: 2 });
    const freshLayer = createAsyncDataLayer(freshConnections, { projectId: PROJECT_A });
    try {
      const freshMissions = new AsyncMissionStore(freshLayer);
      expect(await freshMissions.listGoalIdsForMission(MISSION_ID)).toEqual([SHARED_GOAL_ID]);
    } finally {
      await freshLayer.close();
    }

    const rows = await h.adminDb().select().from(schema.project.missionGoals).where(and(
      eq(schema.project.missionGoals.projectId, PROJECT_A),
      eq(schema.project.missionGoals.missionId, MISSION_ID),
      eq(schema.project.missionGoals.goalId, SHARED_GOAL_ID),
    ));
    expect(rows).toHaveLength(1);
  });

  it("reports a missing mission before considering the goal", async () => {
    await seedGoal(PROJECT_A, "Project A goal");
    const missions = new AsyncMissionStore(bind(PROJECT_A));
    await expect(missions.linkGoal("M-FX011-MISSING", SHARED_GOAL_ID)).rejects.toThrow("Mission M-FX011-MISSING not found");
  });
});
