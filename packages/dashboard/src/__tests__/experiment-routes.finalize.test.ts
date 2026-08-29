// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import express from "express";
import { get as performGet, request as performRequest } from "../test-request.js";

const previewPlanMock = vi.hoisted(() => vi.fn());
const finalizeMock = vi.hoisted(() => vi.fn());

const mockErrors = vi.hoisted(() => ({
  StateError: class extends Error { code = "state_error" as const; },
  NoKeptError: class extends Error { code = "no_kept_runs" as const; },
  PlanError: class extends Error { code = "plan_error" as const; },
  MergeBaseError: class extends Error { code = "merge_base_error" as const; },
  BranchExistsError: class extends Error { code = "branch_exists" as const; },
  CherryPickError: class extends Error {
    code = "cherry_pick_conflict" as const;
    groupId = "g-1";
    commit = "abc";
    stderr = "conflict";
  },
}));

vi.mock("@fusion/engine", () => ({
  listCliAdapterDescriptors: () => [],
  defaultGitOps: vi.fn(() => ({})),
  ExperimentFinalizeService: vi.fn(function () { return { previewPlan: previewPlanMock, finalize: finalizeMock }; }),
  ExperimentFinalizeStateError: mockErrors.StateError,
  ExperimentFinalizeNoKeptRunsError: mockErrors.NoKeptError,
  ExperimentFinalizePlanError: mockErrors.PlanError,
  ExperimentFinalizeMergeBaseError: mockErrors.MergeBaseError,
  ExperimentFinalizeBranchExistsError: mockErrors.BranchExistsError,
  ExperimentFinalizeCherryPickConflictError: mockErrors.CherryPickError,
}));

import { createExperimentRouter } from "../experiment-routes.js";

function appWithRouter() {
  const app = express();
  app.use(express.json());
  app.use(createExperimentRouter({ getRootDir: () => process.cwd(), getExperimentSessionStore: () => ({}) } as any));
  return app;
}

describe("experiment finalize routes", () => {
  it("returns plan success", async () => {
    previewPlanMock.mockResolvedValue({ sessionId: "EXP-1", groups: [], mergeBaseCommit: "mb" });
    const response = await performGet(appWithRouter(), "/EXP-1/finalize/plan");
    expect(response.status).toBe(200);
    expect(response.body.plan.sessionId).toBe("EXP-1");
  });

  it("returns finalize success", async () => {
    finalizeMock.mockResolvedValue({ sessionId: "EXP-1", branches: [] });
    const response = await performRequest(appWithRouter(), "POST", "/EXP-1/finalize", JSON.stringify({ summary: "done" }), { "content-type": "application/json" });
    expect(response.status).toBe(200);
    expect(response.body.result.sessionId).toBe("EXP-1");
  });

  it("maps 404 for missing session", async () => {
    previewPlanMock.mockRejectedValue(new mockErrors.StateError("session not found: EXP-x"));
    const response = await performGet(appWithRouter(), "/EXP-x/finalize/plan");
    expect(response.status).toBe(404);
  });

  it("maps plan error to 400", async () => {
    finalizeMock.mockRejectedValue(new mockErrors.PlanError("bad plan"));
    const response = await performRequest(appWithRouter(), "POST", "/EXP-1/finalize", "{}", { "content-type": "application/json" });
    expect(response.status).toBe(400);
  });

  it("maps merge-base error to 422", async () => {
    finalizeMock.mockRejectedValue(new mockErrors.MergeBaseError("no merge base"));
    const response = await performRequest(appWithRouter(), "POST", "/EXP-1/finalize", "{}", { "content-type": "application/json" });
    expect(response.status).toBe(422);
  });

  it("maps branch exists to 409", async () => {
    finalizeMock.mockRejectedValue(new mockErrors.BranchExistsError("exists"));
    const response = await performRequest(appWithRouter(), "POST", "/EXP-1/finalize", "{}", { "content-type": "application/json" });
    expect(response.status).toBe(409);
  });

  it("maps cherry-pick conflict details to 422", async () => {
    finalizeMock.mockRejectedValue(new mockErrors.CherryPickError("conflict"));
    const response = await performRequest(appWithRouter(), "POST", "/EXP-1/finalize", "{}", { "content-type": "application/json" });
    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({ code: "cherry_pick_conflict", groupId: "g-1", commit: "abc", stderr: "conflict" });
  });
});
