// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { createMissionRouter } from "../mission-routes.js";
import { request } from "../test-request.js";

const feature = { id: "F-TEST", sliceId: "SL-TEST", status: "defined", loopState: "idle" };
const run = { id: "VR-FIRST", featureId: feature.id, status: "running", triggerType: "manual", implementationAttempt: 0, validatorAttempt: 1, startedAt: "2026-08-11T03:43:00.000Z" };

function fixture(options: { manual?: boolean; assertions?: unknown[]; exists?: boolean } = {}) {
  const startManualValidatorRun = options.manual === false ? undefined : vi.fn()
    .mockResolvedValueOnce({ outcome: "started", run })
    .mockResolvedValue({ outcome: "already-running", run });
  const missionStore = {
    getFeature: vi.fn(async () => options.exists === false ? undefined : feature),
    listAssertionsForFeature: vi.fn(async () => options.assertions ?? [{ id: "CA-1" }]),
    startManualValidatorRun,
    startValidatorRun: vi.fn(async () => run),
    updateFeature: vi.fn(), on: vi.fn(), off: vi.fn(),
  };
  const store = {
    getMissionStore: () => missionStore,
    getGoalStore: () => ({ getGoal: vi.fn(), listGoals: vi.fn() }),
    getRootDir: () => "/tmp/mission-validate-inflight-guard", getSettings: vi.fn(async () => ({})), backendMode: true,
  } as unknown as TaskStore;
  const app = express();
  app.use(express.json());
  app.use("/api/missions", createMissionRouter(store));
  return { app, missionStore };
}

describe("manual mission validation in-flight guard", () => {
  it("returns a precise conflict without a feature write after the first start", async () => {
    const { app, missionStore } = fixture();
    expect((await request(app, "POST", "/api/missions/features/F-TEST/validate")).status).toBe(202);
    const second = await request(app, "POST", "/api/missions/features/F-TEST/validate");
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: "Validation is already running for this feature", details: { code: "VALIDATION_ALREADY_RUNNING", runId: run.id, featureId: feature.id, startedAt: run.startedAt } });
    expect(missionStore.updateFeature).not.toHaveBeenCalled();
  });

  it("preserves missing-feature and assertion precedence", async () => {
    expect((await request(fixture({ exists: false }).app, "POST", "/api/missions/features/F-TEST/validate")).status).toBe(404);
    const noAssertions = fixture({ assertions: [] });
    expect((await request(noAssertions.app, "POST", "/api/missions/features/F-TEST/validate")).status).toBe(400);
    expect(noAssertions.missionStore.startManualValidatorRun).not.toHaveBeenCalled();
  });

  it("uses the legacy start method when the store lacks the new capability", async () => {
    const legacy = fixture({ manual: false });
    expect((await request(legacy.app, "POST", "/api/missions/features/F-TEST/validate")).status).toBe(202);
    expect(legacy.missionStore.startValidatorRun).toHaveBeenCalledWith(feature.id, "manual");
  });
});
