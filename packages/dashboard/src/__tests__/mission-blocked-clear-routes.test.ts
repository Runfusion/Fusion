// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { MissionBlockedClearConflictError, type TaskStore } from "@fusion/core";
import { createMissionRouter } from "../mission-routes.js";
import { request } from "../test-request.js";

const mission = {
  id: "M-1", title: "Blocked mission", status: "planning", interviewState: "completed",
  autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive",
  createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
};
const canonicalBlocker = { schemaVersion: 1 as const, kind: "mission-resume-conflict" as const, rootFeatureId: "F-1", reason: "budget-exhausted" as const, source: "feature-row" as const };

function fixture() {
  const missionStore = {
    getMission: vi.fn(async (id: string) => id === mission.id ? mission : undefined),
    getMissionBlockedDiagnostics: vi.fn(async (id: string) => {
      if (id !== mission.id) throw new Error(`Mission ${id} not found`);
      return { missionId: id, status: "blocked", recomputedStatus: "planning", clearable: true, resumable: false, blockers: [canonicalBlocker] };
    }),
    clearMissionBlockedStatus: vi.fn(async () => ({ mission, blockers: [canonicalBlocker] })),
    resumeMission: vi.fn(async () => { throw new Error("unused"); }),
    on: vi.fn(), off: vi.fn(),
  };
  const store = {
    getMissionStore: () => missionStore,
    getGoalStore: () => ({ getGoal: vi.fn(), listGoals: vi.fn() }),
    getRootDir: () => "/tmp/mission-blocked-clear-routes",
    getSettings: vi.fn(async () => ({})),
    backendMode: true,
  } as unknown as TaskStore;
  const autopilot = { watchMission: vi.fn(), unwatchMission: vi.fn(), isWatching: vi.fn(), getAutopilotStatus: vi.fn(), checkAndStartMission: vi.fn(), recoverStaleMission: vi.fn(), start: vi.fn(), stop: vi.fn() };
  const app = express();
  app.use(express.json());
  app.use("/api/missions", createMissionRouter(store, autopilot));
  return { app, missionStore, autopilot };
}

describe("mission blocked-clear routes", () => {
  let setup: ReturnType<typeof fixture>;
  beforeEach(() => { setup = fixture(); });

  it("clears with the dashboard actor and never re-arms autopilot", async () => {
    const response = await request(setup.app, "POST", "/api/missions/M-1/clear-blocked", JSON.stringify({ reason: "stale badge" }), { "content-type": "application/json" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ mission, blockers: [canonicalBlocker] });
    expect(setup.missionStore.clearMissionBlockedStatus).toHaveBeenCalledWith("M-1", expect.objectContaining({ reason: "stale badge", actor: expect.objectContaining({ type: "operator", id: "dashboard" }) }));
    expect(setup.autopilot.watchMission).not.toHaveBeenCalled();
    expect(setup.autopilot.recoverStaleMission).not.toHaveBeenCalled();
  });

  it("maps missing, malformed, and non-blocked clear requests without a blocker payload", async () => {
    const missing = await request(setup.app, "POST", "/api/missions/M-404/clear-blocked", undefined, { "content-type": "application/json" });
    expect(missing.status).toBe(404);
    const malformed = await request(setup.app, "POST", "/api/missions/not-a-mission/clear-blocked");
    expect(malformed.status).toBe(400);
    setup.missionStore.clearMissionBlockedStatus.mockRejectedValueOnce(new MissionBlockedClearConflictError("active"));
    const conflict = await request(setup.app, "POST", "/api/missions/M-1/clear-blocked");
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ details: { code: "MISSION_NOT_BLOCKED", status: "active" } });
    expect((conflict.body as { details: Record<string, unknown> }).details).not.toHaveProperty("blockers");
  });

  it("returns diagnostics verbatim without writes", async () => {
    const response = await request(setup.app, "GET", "/api/missions/M-1/blocked-diagnostics");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ blockers: [canonicalBlocker] });
    expect(setup.missionStore.clearMissionBlockedStatus).not.toHaveBeenCalled();
  });
});
