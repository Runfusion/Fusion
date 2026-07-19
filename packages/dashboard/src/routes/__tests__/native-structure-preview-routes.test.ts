// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { resolveNativeStructurePreview } from "../../native-structure-preview.js";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

const mission = { id: "M-1", title: "Mission", description: "Mission description", status: "active" };
const milestone = { id: "MS-1", missionId: "M-1", title: "Milestone", description: "Milestone description", status: "planning" };
const insight = { id: "INS-1", title: "Finding", content: "Finding content", status: "stale" };
const evaluation = { id: "EV-1", taskId: "FN-1", taskSnapshot: { title: "Evaluated task" }, overallScore: 8, maxScore: 10 };
const goal = { id: "G-1", title: "Goal", description: "Goal description", status: "active" };

function store(overrides: Record<string, unknown> = {}): TaskStore {
  return {
    getMissionStore: vi.fn(() => ({ getMission: vi.fn(async (id) => id === mission.id ? mission : undefined), getMilestone: vi.fn(async (id) => id === milestone.id ? milestone : undefined) })),
    getInsightStore: vi.fn(() => ({ getInsight: vi.fn(async (id) => id === insight.id ? insight : undefined) })),
    getEvalStore: vi.fn(() => ({ getTaskResult: vi.fn(async (id) => id === evaluation.id ? evaluation : undefined) })),
    getGoalStore: vi.fn(() => ({ getGoal: vi.fn(async (id) => id === goal.id ? goal : null) })),
    getRootDir: vi.fn(() => process.cwd()),
    ...overrides,
  } as unknown as TaskStore;
}

describe("resolveNativeStructurePreview", () => {
  it.each([
    ["mission", mission.id, { view: "missions", id: mission.id }],
    ["milestone", milestone.id, { view: "missions", id: milestone.id, missionId: mission.id }],
    ["research-finding", insight.id, { view: "insights", id: insight.id }],
    ["eval-result", evaluation.id, { view: "evals", id: evaluation.id }],
    ["goal", goal.id, { view: "goals", id: goal.id }],
  ] as const)("projects %s into its owning view", async (kind, id, openTarget) => {
    const result = await resolveNativeStructurePreview(store(), { kind, id });
    expect(result).toMatchObject({ available: true, kind, openTarget });
  });

  it.each(["mission", "milestone", "research-finding", "eval-result", "goal"] as const)("returns missing for absent %s", async (kind) => {
    const result = await resolveNativeStructurePreview(store(), { kind, id: "absent" });
    expect(result).toEqual({ available: false, kind, id: "absent", reason: "missing" });
  });

  it.each([
    ["mission", { getMissionStore: vi.fn(() => ({ getMission: vi.fn(async () => ({ ...mission, status: "archived" })) })) }],
    ["milestone", { getMissionStore: vi.fn(() => ({ getMilestone: vi.fn(async () => milestone), getMission: vi.fn(async () => ({ ...mission, status: "archived" })) })) }],
    ["research-finding", { getInsightStore: vi.fn(() => ({ getInsight: vi.fn(async () => ({ ...insight, status: "dismissed" })) })) }],
    ["goal", { getGoalStore: vi.fn(() => ({ getGoal: vi.fn(async () => ({ ...goal, status: "archived" })) })) }],
  ] as const)("maps archived %s to soft-deleted", async (kind, overrides) => {
    const result = await resolveNativeStructurePreview(store(overrides), { kind, id: "target" });
    expect(result).toMatchObject({ available: false, reason: "soft-deleted" });
  });

  it("never maps a missing eval to soft-deleted", async () => {
    await expect(resolveNativeStructurePreview(store(), { kind: "eval-result", id: "absent" })).resolves.toMatchObject({ reason: "missing" });
  });

  it("normalizes and bounds long excerpts for compact cards", async () => {
    const longContent = `  ${"finding   detail ".repeat(30)}  `;
    const result = await resolveNativeStructurePreview(store({
      getInsightStore: vi.fn(() => ({ getInsight: vi.fn(async () => ({ ...insight, content: longContent })) })),
    }), { kind: "research-finding", id: insight.id });

    expect(result).toMatchObject({ available: true });
    if (result.available) {
      expect(result.excerpt.length).toBeLessThanOrEqual(180);
      expect(result.excerpt).not.toMatch(/\s{2,}/);
      expect(result.excerpt.endsWith("…")).toBe(true);
    }
  });
});

describe("native structure preview route", () => {
  it.each([
    ["mission", mission.id, { view: "missions", id: mission.id }],
    ["milestone", milestone.id, { view: "missions", id: milestone.id, missionId: mission.id }],
    ["research-finding", insight.id, { view: "insights", id: insight.id }],
    ["eval-result", evaluation.id, { view: "evals", id: evaluation.id }],
    ["goal", goal.id, { view: "goals", id: goal.id }],
  ] as const)("returns the %s preview projection", async (kind, id, openTarget) => {
    const app = express();
    app.use("/api", createApiRoutes(store()));
    const res = await REQUEST(app, "GET", `/api/native-structures/${kind}/${id}/preview`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, kind, openTarget });
  });

  it("returns the typed unavailable payload with 200", async () => {
    const app = express();
    app.use("/api", createApiRoutes(store()));
    const res = await REQUEST(app, "GET", "/api/native-structures/mission/absent/preview");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: false, reason: "missing" });
  });

  it.each(["roadmap-item", "unknown"])("rejects unsupported %s", async (kind) => {
    const app = express();
    app.use("/api", createApiRoutes(store()));
    const res = await REQUEST(app, "GET", `/api/native-structures/${kind}/id/preview`);
    expect(res.status).toBe(400);
  });
});
