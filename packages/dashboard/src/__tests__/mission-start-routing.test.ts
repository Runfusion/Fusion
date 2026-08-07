// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { createMissionRouter } from "../mission-routes.js";
import { request } from "../test-request.js";

type CompatibilitySetting = boolean | undefined;

type Mission = {
  id: string;
  status: "planning" | "active" | "blocked";
  autoAdvance: boolean;
  autopilotEnabled: boolean;
};

type Slice = {
  id: string;
  missionId: string;
  status: "pending" | "active";
};

function createFixture(ephemeralAgentsEnabled: CompatibilitySetting) {
  const mission: Mission = {
    id: "M-START-1",
    status: "planning",
    autoAdvance: false,
    autopilotEnabled: false,
  };
  const slice: Slice = { id: "SL-START-1", missionId: mission.id, status: "pending" };
  const getSettings = vi.fn(async () => ({ ephemeralAgentsEnabled }));
  const missionStore = {
    getMission: vi.fn(async (id: string) => id === mission.id ? mission : undefined),
    findNextPendingSlice: vi.fn(async (id: string) => id === mission.id && slice.status === "pending" ? slice : undefined),
    updateMission: vi.fn(async (_id: string, patch: Partial<Mission>) => {
      Object.assign(mission, patch);
      return mission;
    }),
    activateSlice: vi.fn(async (id: string) => {
      if (id === slice.id) slice.status = "active";
      return slice;
    }),
    getMissionWithHierarchy: vi.fn(async (id: string) => id === mission.id ? { ...mission, milestones: [{ slices: [{ ...slice, features: [] }] }] } : undefined),
  };
  const store = {
    getMissionStore: () => missionStore,
    getGoalStore: () => ({}),
    getSettings,
    getRootDir: () => "/tmp/mission-start-routing",
    backendMode: true,
  } as unknown as TaskStore;
  const app = express();
  app.use(express.json());
  app.use("/api/missions", createMissionRouter(store));
  return { app, getSettings, mission, missionStore, slice };
}

/*
FNXC:MissionRouting 2026-08-07-08:36:
`ephemeralAgentsEnabled` is a retired client-compatibility input, not mission admission policy.
Mission start must activate a valid planning mission and its pending slice without reading settings or
preflighting legacy executor inventory; durable workflow principals are resolved only at workflow execution.
*/
describe("mission start routing", () => {
  it.each<CompatibilitySetting>([undefined, true, false])(
    "activates a planning mission independently of compatibility input %s",
    async (ephemeralAgentsEnabled) => {
      const { app, getSettings, mission, missionStore, slice } = createFixture(ephemeralAgentsEnabled);

      const response = await request(app, "POST", `/api/missions/${mission.id}/start`);

      expect(response.status).toBe(200);
      expect(mission.status).toBe("active");
      expect(mission.autoAdvance).toBe(true);
      expect(mission.autopilotEnabled).toBe(true);
      expect(slice.status).toBe("active");
      expect(missionStore.updateMission).toHaveBeenCalledOnce();
      expect(missionStore.activateSlice).toHaveBeenCalledWith(slice.id);
      expect(getSettings).not.toHaveBeenCalled();
    },
  );

  it("rejects a non-planning mission without activating its slice", async () => {
    const { app, mission, missionStore, slice } = createFixture(false);
    mission.status = "active";

    const response = await request(app, "POST", `/api/missions/${mission.id}/start`);

    expect(response.status).toBe(409);
    expect(slice.status).toBe("pending");
    expect(missionStore.activateSlice).not.toHaveBeenCalled();
  });

  it("rejects a planning mission with no pending slice", async () => {
    const { app, mission, missionStore, slice } = createFixture(false);
    slice.status = "active";

    const response = await request(app, "POST", `/api/missions/${mission.id}/start`);

    expect(response.status).toBe(400);
    expect(mission.status).toBe("planning");
    expect(missionStore.updateMission).not.toHaveBeenCalled();
  });
});
