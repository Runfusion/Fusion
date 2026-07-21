import { describe, expect, it } from "vitest";
import type { Mission, Milestone, MissionFeature, Slice, Task } from "@fusion/core";
import { decideMissionSymbolAdmission } from "../mission-symbol-admission.js";

const mission: Mission = { id: "M-1", title: "Mission", status: "active", interviewState: "completed", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const milestone: Milestone = { id: "MS-1", missionId: mission.id, title: "Milestone", status: "active", orderIndex: 0, interviewState: "completed", dependencies: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const slice: Slice = { id: "SL-1", milestoneId: milestone.id, title: "Slice", status: "active", orderIndex: 0, planState: "planned", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const feature: MissionFeature = { id: "F-1", sliceId: slice.id, taskId: "FN-1", title: "Feature", status: "triaged", createdAt: "2026-01-01", updatedAt: "2026-01-01" };

function task(overrides: Partial<Task> = {}): Task {
  return { id: "FN-1", title: "Task", description: "", column: "todo", priority: "normal", createdAt: "2026-01-01", updatedAt: "2026-01-01", steps: [], dependencies: [], missionId: mission.id, sliceId: slice.id, ...overrides } as Task;
}

function store(overrides: Partial<{ mission: Mission | undefined; milestone: Milestone | undefined; slice: Slice | undefined; feature: MissionFeature | undefined }> = {}) {
  const values = { mission, milestone, slice, feature, ...overrides };
  return {
    getFeatureByTaskId: async () => values.feature,
    getFeature: async (id: string) => id === feature.id ? values.feature : undefined,
    getSlice: async () => values.slice,
    getMilestone: async () => values.milestone,
    getMission: async () => values.mission,
  } as any;
}

describe("decideMissionSymbolAdmission", () => {
  it("uses symbol locking for approved mission lineage with normalized declarations", async () => {
    await expect(decideMissionSymbolAdmission(task({ declaredSymbols: ["pkg/a.ts#A", " pkg/b.ts # B "] }), store())).resolves.toMatchObject({
      kind: "symbol-lock", symbols: ["pkg/a.ts#a", "pkg/b.ts#b"], reason: "approved",
    });
  });

  it("resolves Decision-A follow-up metadata without replacing source feature ownership", async () => {
    const followUp = task({
      id: "FN-2",
      declaredSymbols: ["pkg/a.ts#A"],
      sourceMetadata: { missionLineage: { missionId: mission.id, sliceId: slice.id, featureId: feature.id } },
    });

    await expect(decideMissionSymbolAdmission(followUp, store())).resolves.toMatchObject({
      kind: "symbol-lock", feature: { id: feature.id, taskId: "FN-1" },
    });
  });

  it("blocks malformed Decision-A metadata rather than falling back to another feature", async () => {
    const followUp = task({
      id: "FN-2",
      declaredSymbols: ["pkg/a.ts#A"],
      sourceMetadata: { missionLineage: { missionId: mission.id, sliceId: slice.id, featureId: "F-missing" } },
    });

    await expect(decideMissionSymbolAdmission(followUp, store())).resolves.toEqual({
      kind: "lineage-blocked", reason: "missing-feature",
    });
  });

  it("uses coarse fallback for non-mission and approved empty-symbol work", async () => {
    await expect(decideMissionSymbolAdmission(task({ missionId: undefined, sliceId: undefined }), store({ feature: undefined }))).resolves.toEqual({ kind: "coarse-fallback", reason: "non-mission" });
    await expect(decideMissionSymbolAdmission(task({ declaredSymbols: [] }), store())).resolves.toEqual({ kind: "coarse-fallback", reason: "symbols-unresolvable" });
  });

  it.each([
    ["missing-mission", { mission: undefined }],
    ["missing-milestone", { milestone: undefined }],
    // A missing slice also prevents its parent lookup; the canonical predicate
    // intentionally reports missing-milestone first in that impossible graph.
    ["missing-milestone", { slice: undefined }],
    ["missing-feature", { feature: undefined }],
    ["mission-not-active", { mission: { ...mission, status: "blocked" } }],
    ["milestone-not-active", { milestone: { ...milestone, status: "planning" } }],
    ["slice-not-active", { slice: { ...slice, status: "pending" } }],
    ["feature-not-implementable", { feature: { ...feature, status: "defined" } }],
  ])("blocks mission work for %s", async (reason, values) => {
    await expect(decideMissionSymbolAdmission(task({ declaredSymbols: ["pkg/a.ts#A"] }), store(values as any))).resolves.toEqual({ kind: "lineage-blocked", reason });
  });

  it("honors required plan fingerprints through the canonical predicate", async () => {
    await expect(decideMissionSymbolAdmission(task({ declaredSymbols: ["pkg/a.ts#A"] }), store(), { planApprovalRequired: true })).resolves.toEqual({ kind: "lineage-blocked", reason: "plan-not-approved" });
  });
});
