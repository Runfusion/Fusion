import { describe, expect, it } from "vitest";
import {
  evaluateMissionLineageApproval,
  isMissionLineageApproved,
  MISSION_LINEAGE_APPROVAL_REQUIRED,
  type MissionLineageSnapshot,
} from "../index.js";
import type { Milestone, Mission, MissionFeature, Slice } from "../missions/mission-types.js";

const timestamp = "2026-07-19T14:58:00.000Z";

function mission(status: Mission["status"] = "active"): Mission {
  return { id: "M-1", title: "Mission", status, interviewState: "completed", createdAt: timestamp, updatedAt: timestamp };
}

function milestone(status: Milestone["status"] = "active"): Milestone {
  return {
    id: "MS-1", missionId: "M-1", title: "Milestone", status, orderIndex: 0,
    interviewState: "completed", dependencies: [], createdAt: timestamp, updatedAt: timestamp,
  };
}

function slice(status: Slice["status"] = "active"): Slice {
  return {
    id: "SL-1", milestoneId: "MS-1", title: "Slice", status, orderIndex: 0,
    planState: "planned", createdAt: timestamp, updatedAt: timestamp,
  };
}

function feature(status: MissionFeature["status"] = "triaged"): MissionFeature {
  return { id: "F-1", sliceId: "SL-1", title: "Feature", status, createdAt: timestamp, updatedAt: timestamp };
}

function snapshot(overrides: Partial<MissionLineageSnapshot> = {}): MissionLineageSnapshot {
  return {
    mission: mission(),
    milestone: milestone(),
    slice: slice(),
    feature: feature(),
    task: {},
    planApprovalRequired: false,
    ...overrides,
  };
}

describe("evaluateMissionLineageApproval", () => {
  it.each([
    ["mission", "missing-mission"],
    ["milestone", "missing-milestone"],
    ["slice", "missing-slice"],
    ["feature", "missing-feature"],
  ] as const)("reports %s absence before later requirements", (link, reason) => {
    expect(evaluateMissionLineageApproval(snapshot({ [link]: undefined }))).toEqual({ approved: false, reason });
  });

  it.each(["planning", "blocked", "complete", "archived"] as const)("rejects %s missions", (status) => {
    expect(evaluateMissionLineageApproval(snapshot({ mission: mission(status) }))).toEqual({
      approved: false, reason: "mission-not-active",
    });
  });

  it.each(["planning", "blocked", "complete"] as const)("rejects %s milestones", (status) => {
    expect(evaluateMissionLineageApproval(snapshot({ milestone: milestone(status) }))).toEqual({
      approved: false, reason: "milestone-not-active",
    });
  });

  it.each(["pending", "complete"] as const)("rejects %s slices", (status) => {
    expect(evaluateMissionLineageApproval(snapshot({ slice: slice(status) }))).toEqual({
      approved: false, reason: "slice-not-active",
    });
  });

  it.each(["defined", "done", "blocked"] as const)("rejects %s features", (status) => {
    expect(evaluateMissionLineageApproval(snapshot({ feature: feature(status) }))).toEqual({
      approved: false, reason: "feature-not-implementable",
    });
  });

  it.each(["triaged", "in-progress"] as const)("accepts implementable %s features without plan approval", (status) => {
    const input = snapshot({ feature: feature(status) });
    expect(evaluateMissionLineageApproval(input)).toEqual({ approved: true, reason: "approved" });
    expect(isMissionLineageApproved(input)).toBe(true);
  });

  it("ignores fingerprints when plan approval is not required", () => {
    expect(evaluateMissionLineageApproval(snapshot({ task: { approvedPlanFingerprint: "   " } }))).toEqual({
      approved: true, reason: "approved",
    });
  });

  it.each([undefined, "", " \t\n "])("requires a non-empty plan fingerprint when configured: %j", (approvedPlanFingerprint) => {
    expect(evaluateMissionLineageApproval(snapshot({
      planApprovalRequired: true,
      task: { approvedPlanFingerprint },
    }))).toEqual({ approved: false, reason: "plan-not-approved" });
  });

  it("accepts a non-empty plan fingerprint when configured", () => {
    expect(evaluateMissionLineageApproval(snapshot({
      planApprovalRequired: true,
      task: { approvedPlanFingerprint: "sha256:approved" },
    }))).toEqual({ approved: true, reason: "approved" });
  });

  it("does not mutate the resolved lineage snapshot", () => {
    const input = snapshot({ planApprovalRequired: true, task: { approvedPlanFingerprint: "approved" } });
    const before = structuredClone(input);

    evaluateMissionLineageApproval(input);

    expect(input).toEqual(before);
  });

  it("exports required statuses matching the predicate contract", () => {
    expect(MISSION_LINEAGE_APPROVAL_REQUIRED).toEqual({
      missionStatus: "active",
      milestoneStatus: "active",
      sliceStatus: "active",
      featureStatuses: ["triaged", "in-progress"],
    });
  });
});
