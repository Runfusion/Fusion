// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import express from "express";
import { isMissionBlockerDescriptor, MissionResumeConflictError, type TaskStore } from "@fusion/core";
import { createMissionRouter } from "../mission-routes.js";
import { request } from "../test-request.js";

const mission = { id: "M-1", title: "Blocked", status: "blocked", interviewState: "completed", autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive", createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z" };
const descriptor = { schemaVersion: 1 as const, kind: "mission-resume-conflict" as const, rootFeatureId: "F-1", reason: "budget-exhausted" as const, source: "feature-row" as const, missionId: "M-1" };
const lineageDescriptor = { ...descriptor, source: "lineage-stop" as const, stoppedAt: "2026-08-11T00:00:00.000Z", origin: "validator-budget" };
const retiredMirrorKey = ["legacy", "Blockers"].join("");

function fixture(error: Error | undefined) {
  let resumed = false;
  const missionStore = { getMission: vi.fn(async () => resumed ? { ...mission, status: "active" } : mission), resumeMission: vi.fn(async () => { if (error) throw error; resumed = true; return { ...mission, status: "active" }; }), on: vi.fn(), off: vi.fn() };
  const store = { getMissionStore: () => missionStore, getGoalStore: () => ({ getGoal: vi.fn(), listGoals: vi.fn() }), getRootDir: () => "/tmp/mission-resume-conflict", getSettings: vi.fn(async () => ({})), backendMode: true } as unknown as TaskStore;
  const app = express(); app.use(express.json()); app.use("/api/missions", createMissionRouter(store));
  return { app };
}

describe("mission resume conflict route", () => {
  it("returns only a versioned canonical descriptor envelope", async () => {
    const response = await request(fixture(new MissionResumeConflictError([descriptor, lineageDescriptor])).app, "POST", "/api/missions/M-1/resume");
    expect(response.status).toBe(409);
    const details = (response.body as { details: Record<string, unknown> }).details;
    expect(details.code).toBe("MISSION_RESUME_CONFLICT");
    expect(details.blockerSchemaVersion).toBe(1);
    expect(details.blockers).toEqual([descriptor, lineageDescriptor]);
    expect((details.blockers as unknown[]).every(isMissionBlockerDescriptor)).toBe(true);
    expect(details).not.toHaveProperty(retiredMirrorKey);
    expect((details.blockers as Array<Record<string, unknown>>).every((blocker) => !("id" in blocker))).toBe(true);
  });

  it("does not misclassify unrelated errors as resume conflicts", async () => {
    const response = await request(fixture(new Error("database unavailable")).app, "POST", "/api/missions/M-1/resume");
    expect(response.status).not.toBe(409);
  });

  it("returns the refreshed mission on success without blocker fields", async () => {
    const response = await request(fixture(undefined).app, "POST", "/api/missions/M-1/resume");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: "M-1", status: "active" });
    expect(response.body).not.toHaveProperty("blockers");
  });
});
