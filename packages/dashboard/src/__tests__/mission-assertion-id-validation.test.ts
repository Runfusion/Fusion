// @vitest-environment node
/*
FNXC:MissionAssertions 2026-08-01-19:44:
Route validation must accept IDs emitted by MissionStore rather than a hand-written approximation. This protects every assertion CRUD and feature-link route when the store's generated ID segments evolve.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { MissionStore, type Database, type TaskStore } from "@fusion/core";
import { createMissionRouter } from "../mission-routes.js";
import { request } from "../test-request.js";

const FEATURE_ID = "F-TEST";
const LEGACY_ASSERTION_ID = "CA-A3B7CD-E9F2";

function createStoreGeneratedAssertionId(): string {
  const database = {
    prepare: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    bumpLastModified: vi.fn(),
  } as unknown as Database;
  const missionStore = new MissionStore("/tmp/mission-assertion-id-validation", database);

  return (missionStore as unknown as { generateId(prefix: string): string }).generateId("CA");
}

function createFixture() {
  const assertionId = createStoreGeneratedAssertionId();
  const assertion = { id: assertionId, milestoneId: "MS-TEST", title: "Assertion", assertion: "It holds", status: "pending" };
  const missionStore = {
    getContractAssertion: vi.fn(async (id: string) => id.startsWith("CA-") ? { ...assertion, id } : undefined),
    updateContractAssertion: vi.fn(async (id: string) => ({ ...assertion, id, status: "passed" })),
    deleteContractAssertion: vi.fn(async () => undefined),
    linkFeatureToAssertion: vi.fn(async () => undefined),
    unlinkFeatureFromAssertion: vi.fn(async () => undefined),
    listFeaturesForAssertion: vi.fn(async () => [{ id: FEATURE_ID }]),
    on: vi.fn(),
    off: vi.fn(),
  };
  const store = {
    getMissionStore: () => missionStore,
    getGoalStore: () => ({ getGoal: vi.fn(), listGoals: vi.fn() }),
    getRootDir: () => "/tmp/mission-assertion-id-validation",
    getSettings: vi.fn(async () => ({})),
    backendMode: true,
  } as unknown as TaskStore;
  const app = express();
  app.use(express.json());
  app.use("/api/missions", createMissionRouter(store));

  return { app, assertionId, missionStore };
}

describe("mission assertion ID validation", () => {
  let fixture: ReturnType<typeof createFixture>;

  beforeEach(() => {
    fixture = createFixture();
  });

  it.each([
    ["GET /assertions/:assertionId", "GET", (id: string) => `/api/missions/assertions/${id}`],
    ["PATCH /assertions/:assertionId", "PATCH", (id: string) => `/api/missions/assertions/${id}`],
    ["DELETE /assertions/:assertionId", "DELETE", (id: string) => `/api/missions/assertions/${id}`],
    ["POST /features/:featureId/assertions/:assertionId/link", "POST", (id: string) => `/api/missions/features/${FEATURE_ID}/assertions/${id}/link`],
    ["POST /features/:featureId/assertions/:assertionId/unlink", "POST", (id: string) => `/api/missions/features/${FEATURE_ID}/assertions/${id}/unlink`],
    ["GET /assertions/:assertionId/features", "GET", (id: string) => `/api/missions/assertions/${id}/features`],
  ] as const)("accepts a current MissionStore ID on %s", async (_name, method, pathFor) => {
    const response = await request(
      fixture.app,
      method,
      pathFor(fixture.assertionId),
      method === "PATCH" ? JSON.stringify({ status: "passed" }) : undefined,
      method === "PATCH" ? { "content-type": "application/json" } : undefined,
    );

    expect(fixture.assertionId).toMatch(/^CA-[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$/);
    expect(response.status).not.toBe(400);
    expect(response.body).not.toEqual({ error: "Invalid assertion ID format" });
  });

  it("accepts legacy two-segment assertion IDs", async () => {
    const response = await request(fixture.app, "GET", `/api/missions/assertions/${LEGACY_ASSERTION_ID}`);

    expect(response.status).toBe(200);
  });

  it.each([
    "M-A3B7CD-0001-E9F2",
    "CA-",
    "%20",
    "CA-%2E%2E%2F%2E%2E%2Fetc",
    "CA-A3B7CD%2F0001-E9F2",
    "CA-A3B7CD-0001-INVALID!",
  ])("rejects invalid assertion ID %j", async (assertionId) => {
    const response = await request(fixture.app, "GET", `/api/missions/assertions/${assertionId}`);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Invalid assertion ID format" });
  });
});
