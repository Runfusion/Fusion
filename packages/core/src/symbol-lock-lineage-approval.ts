import type { Milestone, Mission, MissionFeature, Slice } from "./mission-types.js";
import type { Task } from "./types.js";

/**
 * FNXC:SymbolLock 2026-07-19-14:58:
 * Autonomous symbol-lock admission is allowed only for work already greenlit
 * through the live Mission → Milestone → Slice → Feature path. An active
 * Mission, Milestone, and Slice establish that implementation is currently
 * authorized; triaged or in-progress Features are the only implementable
 * states. Planning, blocked, completed, archived, defined, and done states
 * must not be treated as approval.
 *
 * When plan approval is required, a non-empty approvedPlanFingerprint proves
 * an operator or plan gate approved the task's current plan. This predicate
 * checks presence only: plan-approval.ts owns fingerprint computation and
 * validation, while this IO-free contract stays reusable by schedulers.
 */
export const MISSION_LINEAGE_APPROVAL_REQUIRED = {
  missionStatus: "active",
  milestoneStatus: "active",
  sliceStatus: "active",
  featureStatuses: ["triaged", "in-progress"] as const,
};

export type MissionLineageApprovalReason =
  | "approved"
  | "missing-mission"
  | "missing-milestone"
  | "missing-slice"
  | "missing-feature"
  | "mission-not-active"
  | "milestone-not-active"
  | "slice-not-active"
  | "feature-not-implementable"
  | "plan-not-approved";

export type MissionLineageApprovalResult =
  | { approved: true; reason: "approved" }
  | { approved: false; reason: Exclude<MissionLineageApprovalReason, "approved"> };

/** A resolved lineage only; scheduler-owned resolution deliberately stays outside this pure seam. */
export interface MissionLineageSnapshot {
  mission?: Mission | null;
  milestone?: Milestone | null;
  slice?: Slice | null;
  feature?: MissionFeature | null;
  task: Pick<Task, "approvedPlanFingerprint">;
  planApprovalRequired: boolean;
}

/** Evaluate the canonical symbol-lock admission contract in deterministic failure order. */
export function evaluateMissionLineageApproval(
  snapshot: MissionLineageSnapshot,
): MissionLineageApprovalResult {
  const { mission, milestone, slice, feature, task, planApprovalRequired } = snapshot;

  if (!mission) return { approved: false, reason: "missing-mission" };
  if (!milestone) return { approved: false, reason: "missing-milestone" };
  if (!slice) return { approved: false, reason: "missing-slice" };
  if (!feature) return { approved: false, reason: "missing-feature" };

  if (mission.status !== MISSION_LINEAGE_APPROVAL_REQUIRED.missionStatus) {
    return { approved: false, reason: "mission-not-active" };
  }
  if (milestone.status !== MISSION_LINEAGE_APPROVAL_REQUIRED.milestoneStatus) {
    return { approved: false, reason: "milestone-not-active" };
  }
  if (slice.status !== MISSION_LINEAGE_APPROVAL_REQUIRED.sliceStatus) {
    return { approved: false, reason: "slice-not-active" };
  }
  if (!MISSION_LINEAGE_APPROVAL_REQUIRED.featureStatuses.some((status) => status === feature.status)) {
    return { approved: false, reason: "feature-not-implementable" };
  }
  if (
    planApprovalRequired
    && (typeof task.approvedPlanFingerprint !== "string" || task.approvedPlanFingerprint.trim().length === 0)
  ) {
    return { approved: false, reason: "plan-not-approved" };
  }

  return { approved: true, reason: "approved" };
}

/** Convenience projection for callers that do not need the rejection reason. */
export function isMissionLineageApproved(snapshot: MissionLineageSnapshot): boolean {
  return evaluateMissionLineageApproval(snapshot).approved;
}
