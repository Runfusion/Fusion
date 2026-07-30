import type { MissionFeature, Task, TaskStore } from "@fusion/core";
import { getTaskCompletionBlockerForStore } from "./task-completion.js";

export type MissionFeatureSyncTargetStatus = "done" | "in-progress" | "triaged";

export interface MissionFeatureSyncContext {
  hasLinkedAssertions?: boolean;
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-11:20 (U11):
  The task's resolved planner lanes (intake + hold). Supplied by the CALLER, which
  holds the store — this module takes a deliberately narrowed
  `Pick<TaskStore, "getTask">` and widening it just to resolve an IR would be the
  wrong trade.

  A card back in a planner lane returns the mission feature to `triaged`. Keyed on
  the literals, a renamed workflow left the feature reading `in-progress` forever:
  the roadmap claims work is underway while the card sits waiting to be re-planned.
  Nothing errors — the rollup is simply wrong, which is why it would go unnoticed.

  Defaults to the legacy pair so an unconverted caller is byte-identical.
  */
  plannerColumns?: readonly string[];
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-11:20 (U11):
The PLANNER LANES — the columns where specification happens (intake + hold). The
default stays the legacy PAIR rather than a single id: post-#2515 the default
lineage's intake and hold are the same column, so the pair collapses to one entry
on its own, while every workflow that still declares both keeps both.
*/
export const LEGACY_PLANNER_COLUMNS: readonly string[] = ["triage", "todo"];



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
  /*
  FNXC:MissionReconciliation 2026-07-30-00:00:
  FN-8307 makes failure a provenance-preserving withheld outcome regardless of
  the feature's current state. A released scheduler symbol lock permits this
  reconciliation but never proves implementation completion.
  */
  if (task.status === "failed" || task.error) {
    return {
      kind: "failure",
      reason: `task ${task.id} failed; feature ${feature.id} remains ${feature.status}`,
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

  /*
  FNXC:MissionReconciliation 2026-07-30-00:00:
  Archiving is retention, not a completion signal. Leave canonical feature
  status untouched so a terminal/duplicate archive cannot fabricate roadmap
  progress; callers may still recompute hierarchy idempotently.
  */
  if (task.column === "archived") return { kind: "noop" };

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
    (context.plannerColumns ?? LEGACY_PLANNER_COLUMNS).includes(task.column)
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
