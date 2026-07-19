import type { MissionFeature, Task, TaskStore } from "@fusion/core";
import { getTaskCompletionBlockerForStore } from "./task-completion.js";

export type MissionFeatureSyncTargetStatus = "done" | "in-progress" | "triaged";

export interface MissionFeatureSyncContext {
  hasLinkedAssertions?: boolean;
}

export type MissionFeatureSyncDecision =
  | { kind: "failure"; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "update"; status: MissionFeatureSyncTargetStatus; reason: string }
  | { kind: "noop" };

export async function reconcileMissionFeatureState(
  taskStore: Pick<TaskStore, "getTask">,
  task: Task,
  feature: Pick<MissionFeature, "id" | "status" | "lastValidatorStatus">,
  context: MissionFeatureSyncContext = {},
): Promise<MissionFeatureSyncDecision> {
  if (task.status === "failed" && feature.status === "in-progress") {
    return {
      kind: "failure",
      reason: `task ${task.id} failed while feature ${feature.id} is in-progress`,
    };
  }

  /* FNXC:ResearchMissionBridge 2026-07-18-12:00: Research-derived features use this same reconciliation decision, so task completion never bypasses assertion validation or parent-roadmap rollups. */
  const hasUnvalidatedAssertions = context.hasLinkedAssertions === true
    && feature.lastValidatorStatus !== "passed";

  if (task.column === "done") {
    const blocker = await getTaskCompletionBlockerForStore(taskStore, task);
    if (blocker) {
      return { kind: "blocked", reason: blocker };
    }

    if (hasUnvalidatedAssertions) {
      if (feature.status !== "in-progress") {
        return {
          kind: "update",
          status: "in-progress",
          reason: `task ${task.id} completed; awaiting assertion validation`,
        };
      }
      return { kind: "noop" };
    }

    if (feature.status !== "done") {
      return {
        kind: "update",
        status: "done",
        reason: `task ${task.id} completed`,
      };
    }

    return { kind: "noop" };
  }

  if (task.column === "archived") {
    if (hasUnvalidatedAssertions) {
      if (feature.status !== "in-progress") {
        return {
          kind: "update",
          status: "in-progress",
          reason: `task ${task.id} archived; awaiting assertion validation`,
        };
      }
      return { kind: "noop" };
    }

    if (feature.status !== "done") {
      return {
        kind: "update",
        status: "done",
        reason: `task ${task.id} was archived after completion`,
      };
    }

    return { kind: "noop" };
  }

  if (
    (task.column === "in-progress" || task.column === "in-review")
    && (feature.status === "triaged" || feature.status === "defined")
  ) {
    return {
      kind: "update",
      status: "in-progress",
      reason: task.column === "in-review"
        ? `task ${task.id} is in review`
        : `task ${task.id} started`,
    };
  }

  if (
    (task.column === "triage" || task.column === "todo")
    && feature.status === "in-progress"
  ) {
    return {
      kind: "update",
      status: "triaged",
      reason: `task ${task.id} returned to triage`,
    };
  }

  return { kind: "noop" };
}
