// @vitest-environment node
/*
FNXC:MissionTaskPrefix 2026-07-14-19:00:
Route regression for greptile P1 on PR #1930: PATCH with taskPrefix null/empty must clear a stored mission override so triage inherits the project prefix; omitting the key must leave it unchanged.

FNXC:MissionTaskPrefix 2026-07-14-19:05:
Ported off the deleted SQLite inMemoryDb TaskStore fixture (VAL-REMOVAL-005). Mock the mission store so the test asserts route validation/normalization without requiring PostgreSQL.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { createMissionRouter } from "../mission-routes.js";
import { request } from "../test-request.js";

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
