// @vitest-environment node
/*
FNXC:MissionTaskPrefix 2026-07-14-19:00:
Route regression for greptile P1 on PR #1930: PATCH with taskPrefix null/empty must clear a stored mission override so triage inherits the project prefix; omitting the key must leave it unchanged.

FNXC:MissionTaskPrefix 2026-07-14-19:05:
Ported off the deleted SQLite inMemoryDb TaskStore fixture (VAL-REMOVAL-005). Mock the mission store so the test asserts route validation/normalization without requiring PostgreSQL.
*/

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { RepairAssertionsMissingError, RepairNotEligibleError, RepairValidatorRunInFlightError, type TaskStore } from "@fusion/core";
import { createMissionRouter } from "../mission-routes.js";
import { request } from "../test-request.js";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../../core/src/__test-utils__/pg-test-harness.js";

type MissionRecord = {
  id: string;
  title: string;
  description?: string;
  status: string;
  interviewState: string;
  taskPrefix?: string;
  autoAdvance: boolean;
  autopilotEnabled: boolean;
  autopilotState: string;
  createdAt: string;
  updatedAt: string;
};

function createFixture() {
  const missions = new Map<string, MissionRecord>();
  let seq = 0;

  const missionStore = {
    createMission: vi.fn(async (input: { title: string; taskPrefix?: string }) => {
      const now = new Date().toISOString();
      const mission: MissionRecord = {
        id: `M-${++seq}`,
        title: input.title,
        status: "planning",
        interviewState: "not_started",
        taskPrefix: input.taskPrefix,
        autoAdvance: false,
        autopilotEnabled: false,
        autopilotState: "inactive",
        createdAt: now,
        updatedAt: now,
      };
      missions.set(mission.id, mission);
      return mission;
    }),
    getMission: vi.fn(async (id: string) => missions.get(id)),
    updateMission: vi.fn(async (id: string, updates: Partial<MissionRecord>) => {
      const existing = missions.get(id);
      if (!existing) throw new Error(`Mission ${id} not found`);
      const updated: MissionRecord = {
        ...existing,
        ...updates,
        id,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      };
      // Explicit undefined clears the override (same as AsyncMissionStore).
      if ("taskPrefix" in updates && updates.taskPrefix === undefined) {
        delete updated.taskPrefix;
      }
      missions.set(id, updated);
      return updated;
    }),
    listMissions: vi.fn(async () => [...missions.values()]),
    listMissionsWithSummaries: vi.fn(async () => []),
    getMissionWithHierarchy: vi.fn(async () => undefined),
    listGoalIdsForMission: vi.fn(async () => []),
    linkGoal: vi.fn(),
    unlinkGoal: vi.fn(),
    // Present from router construction so the backend capability guard follows the PG repair path.
    repairFeatureValidationState: undefined as unknown,
    on: vi.fn(),
    off: vi.fn(),
  };

  const store = {
    getMissionStore: () => missionStore,
    getGoalStore: () => ({
      getGoal: vi.fn(async () => undefined),
      listGoals: vi.fn(async () => []),
    }),
    getRootDir: () => "/tmp/mission-task-prefix-routes",
    getSettings: vi.fn(async () => ({})),
    backendMode: true,
  } as unknown as TaskStore;

  const app = express();
  app.use(express.json());
  app.use("/api/missions", createMissionRouter(store));

  return { app, missionStore, missions };
}

describe("mission taskPrefix routes", () => {
  let app: express.Express;
  let missionStore: ReturnType<typeof createFixture>["missionStore"];

  beforeEach(() => {
    ({ app, missionStore } = createFixture());
  });

  /*
  FNXC:MissionValidationRepair 2026-08-11-01:20:
  The repair route is an operator-facing adapter over the attributed store primitive. Exercise
  its re-run response so route registration cannot regress while the store owns mutation rules.
  */
  it("starts validation repair through the feature repair route", async () => {
    const feature = { id: "F-1", status: "in-progress", loopState: "blocked" };
    Object.assign(missionStore, {
      getFeature: vi.fn(async (id: string) => id === feature.id ? feature : undefined),
      repairFeatureValidationState: vi.fn(async () => ({ feature: { ...feature, loopState: "validating" }, run: {
        id: "VR-1", featureId: feature.id, status: "running", triggerType: "manual",
        implementationAttempt: 0, validatorAttempt: 1, startedAt: "2026-01-01T00:00:00.000Z",
      } })),
    });
    const response = await request(app, "POST", "/api/missions/features/F-1/repair-validation", JSON.stringify({ action: "re_run" }), { "content-type": "application/json" });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ runId: "VR-1", featureId: "F-1", status: "running" });
    expect((missionStore as typeof missionStore & { repairFeatureValidationState: ReturnType<typeof vi.fn> }).repairFeatureValidationState)
      .toHaveBeenCalledWith("F-1", expect.objectContaining({ action: "re_run", actor: expect.objectContaining({ type: "operator" }) }));
  });

  it("maps expected re-run store guards to actionable API statuses", async () => {
    const feature = { id: "F-1", status: "in-progress", loopState: "blocked" };
    const repairFeatureValidationState = vi.fn()
      .mockRejectedValueOnce(new RepairAssertionsMissingError())
      .mockRejectedValueOnce(new RepairValidatorRunInFlightError(feature.id))
      .mockRejectedValueOnce(new RepairNotEligibleError(feature.id, "re_run"));
    Object.assign(missionStore, {
      getFeature: vi.fn(async () => feature),
      repairFeatureValidationState,
    });

    const missingAssertions = await request(app, "POST", "/api/missions/features/F-1/repair-validation", JSON.stringify({ action: "re_run" }), { "content-type": "application/json" });
    expect(missingAssertions.status).toBe(400);
    expect(missingAssertions.body.error).toContain("Feature has no linked assertions");

    const running = await request(app, "POST", "/api/missions/features/F-1/repair-validation", JSON.stringify({ action: "re_run" }), { "content-type": "application/json" });
    expect(running.status).toBe(409);
    expect(running.body.error).toContain("already has a running validator run");

    const lockedRace = await request(app, "POST", "/api/missions/features/F-1/repair-validation", JSON.stringify({ action: "re_run" }), { "content-type": "application/json" });
    expect(lockedRace.status).toBe(409);
    expect(lockedRace.body.error).toContain("not eligible");
  });

  it("clears a blocked badge with server-derived targets and rejects ineligible repair", async () => {
    const feature = { id: "F-1", status: "blocked", loopState: "blocked" };
    const repairFeatureValidationState = vi.fn(async () => ({ feature: { ...feature, status: "defined", loopState: "idle" } }));
    Object.assign(missionStore, { getFeature: vi.fn(async () => feature), repairFeatureValidationState });

    const cleared = await request(app, "POST", "/api/missions/features/F-1/repair-validation", JSON.stringify({
      action: "clear", status: "in-progress", loopState: "implementing", groundTruth: { forged: true },
    }), { "content-type": "application/json" });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ status: "defined", loopState: "idle" });
    expect(repairFeatureValidationState).toHaveBeenCalledWith("F-1", expect.objectContaining({
      action: "clear", resolvedStatus: "defined", resolvedLoopState: "idle",
      groundTruth: expect.objectContaining({ taskId: null, taskLiveness: "absent" }),
    }));

    Object.assign(missionStore, { getFeature: vi.fn(async () => ({ ...feature, status: "defined", loopState: "idle" })) });
    const rejected = await request(app, "POST", "/api/missions/features/F-1/repair-validation", JSON.stringify({ action: "clear" }), { "content-type": "application/json" });
    expect(rejected.status).toBe(409);
    expect(repairFeatureValidationState).toHaveBeenCalledTimes(1);
  });

  it("clears a stored taskPrefix when PATCH sends null", async () => {
    const mission = await missionStore.createMission({ title: "Prefixed", taskPrefix: "ERR" });
    expect((await missionStore.getMission(mission.id))?.taskPrefix).toBe("ERR");

    const response = await request(
      app,
      "PATCH",
      `/api/missions/${mission.id}`,
      JSON.stringify({ taskPrefix: null }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect((response.body as { taskPrefix?: string }).taskPrefix).toBeUndefined();
    expect((await missionStore.getMission(mission.id))?.taskPrefix).toBeUndefined();
    expect(missionStore.updateMission).toHaveBeenCalledWith(
      mission.id,
      expect.objectContaining({ taskPrefix: undefined }),
      expect.anything(),
    );
  });

  it("clears a stored taskPrefix when PATCH sends an empty string", async () => {
    const mission = await missionStore.createMission({ title: "Prefixed", taskPrefix: "BUG" });

    const response = await request(
      app,
      "PATCH",
      `/api/missions/${mission.id}`,
      JSON.stringify({ taskPrefix: "   " }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect((await missionStore.getMission(mission.id))?.taskPrefix).toBeUndefined();
  });

  it("leaves taskPrefix unchanged when the PATCH body omits the key", async () => {
    const mission = await missionStore.createMission({ title: "Prefixed", taskPrefix: "ERR" });

    const response = await request(
      app,
      "PATCH",
      `/api/missions/${mission.id}`,
      JSON.stringify({ title: "Renamed only" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect((response.body as { title: string; taskPrefix?: string }).title).toBe("Renamed only");
    expect((response.body as { taskPrefix?: string }).taskPrefix).toBe("ERR");
    expect((await missionStore.getMission(mission.id))?.taskPrefix).toBe("ERR");
    // updateMission must not receive a taskPrefix key when the body omitted it.
    const updateArg = missionStore.updateMission.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(updateArg).not.toHaveProperty("taskPrefix");
  });

  it("uppercases a non-empty taskPrefix on PATCH", async () => {
    const mission = await missionStore.createMission({ title: "Plain" });

    const ok = await request(
      app,
      "PATCH",
      `/api/missions/${mission.id}`,
      JSON.stringify({ taskPrefix: "err2" }),
      { "content-type": "application/json" },
    );
    expect(ok.status).toBe(200);
    expect((ok.body as { taskPrefix?: string }).taskPrefix).toBe("ERR2");
    expect((await missionStore.getMission(mission.id))?.taskPrefix).toBe("ERR2");
  });

  it.each([
    [123, "taskPrefix must be a string or null"],
    ["1ERR", "taskPrefix must start with a letter and contain only letters and digits"],
  ])("returns 400 for invalid taskPrefix %j", async (taskPrefix, message) => {
    const mission = await missionStore.createMission({ title: "Plain" });

    const response = await request(
      app,
      "PATCH",
      `/api/missions/${mission.id}`,
      JSON.stringify({ taskPrefix }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: message });
    expect(missionStore.updateMission).not.toHaveBeenCalled();
  });
});

/*
FNXC:MissionValidationRepair 2026-08-11-01:46:
Exercise the real dashboard router, engine fence resolver, and PostgreSQL mission store together.
Forwarding mocks cannot demonstrate that an archived link clears or that the route's one retry
re-resolves a genuine task race before writing.
*/
pgDescribe("mission validation repair routes", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_route_validation_repair",
    projectId: "route-validation-repair-test",
  });
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  function app() {
    const server = express();
    server.use(express.json());
    server.use("/api/missions", createMissionRouter(h.store()));
    return server;
  }

  async function blockedFeature(taskId?: string) {
    const missionStore = h.store().getMissionStore();
    const mission = await missionStore.createMission({ title: "Route repair" });
    const milestone = await missionStore.addMilestone(mission.id, { title: "Milestone" });
    const slice = await missionStore.addSlice(milestone.id, { title: "Slice" });
    const feature = await missionStore.addFeature(slice.id, { title: "Feature" });
    return missionStore.updateFeature(feature.id, { taskId, status: "blocked", loopState: "blocked" });
  }

  it("clears a physically archived link retained in a nonliteral column through the production route", async () => {
    /* FNXC:MissionValidationRepair 2026-08-11-02:05: Archive preserves the task's prior `done` column in retained storage while marking it deleted, proving the fence does not depend on the literal archived column. */
    const task = await h.store().createTask({ description: "Archived route delivery", column: "done" });
    await h.store().archiveTask(task.id, { cleanup: false });
    const feature = await blockedFeature(task.id);

    const response = await request(app(), "POST", `/api/missions/features/${feature.id}/repair-validation`, JSON.stringify({ action: "clear" }), { "content-type": "application/json" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: feature.id, status: "defined", loopState: "idle" });
  });

  it("maps a locked eligibility race to conflict instead of a server error", async () => {
    const taskStore = h.store();
    const feature = await blockedFeature();
    const missionStore = taskStore.getMissionStore();
    const original = missionStore.repairFeatureValidationState.bind(missionStore);
    const repair = vi.spyOn(missionStore, "repairFeatureValidationState").mockImplementationOnce(async (id, options) => {
      /* FNXC:MissionValidationRepair 2026-08-11-02:05: Simulate the concurrent validator that changes the row after route preflight but before the store's lock-time eligibility check. */
      await missionStore.updateFeature(feature.id, { loopState: "validating" });
      return original(id, options);
    });
    try {
      const response = await request(app(), "POST", `/api/missions/features/${feature.id}/repair-validation`, JSON.stringify({ action: "re_run" }), { "content-type": "application/json" });
      expect(response.status).toBe(409);
      expect(response.body.error).toContain("not eligible");
      expect(repair).toHaveBeenCalledTimes(1);
    } finally {
      repair.mockRestore();
    }
  });

  it("re-resolves a live task fence once after a real route race", async () => {
    const taskStore = h.store();
    const task = await taskStore.createTask({ description: "Planner route delivery", column: "todo" });
    const feature = await blockedFeature(task.id);
    const original = taskStore.getTask.bind(taskStore);
    let reads = 0;
    const getTask = vi.spyOn(taskStore, "getTask").mockImplementation(async (id: string) => {
      const snapshot = await original(id);
      reads += 1;
      if (reads === 1 && snapshot) await taskStore.moveTask(id, "in-progress");
      return snapshot;
    });
    const repair = vi.spyOn(taskStore.getMissionStore(), "repairFeatureValidationState");
    try {
      const response = await request(app(), "POST", `/api/missions/features/${feature.id}/repair-validation`, JSON.stringify({ action: "clear" }), { "content-type": "application/json" });
      expect(response.status).toBe(200);
      expect(repair).toHaveBeenCalledTimes(2);
      // One helper read per bounded attempt proves the first real fence lost its race and the second re-resolved.
      expect(reads).toBe(2);
      expect(response.body).toMatchObject({ status: "in-progress", loopState: "implementing" });
    } finally {
      getTask.mockRestore();
    }
  });
});
