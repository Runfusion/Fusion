import type { MissionFeature, Task, TaskStore } from "@fusion/core";
import { resolveTaskLifecycleColumns } from "@fusion/core";
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
  taskStore: Pick<TaskStore, "getTask"> & Parameters<typeof resolveTaskLifecycleColumns>[0],
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

  /*
  FNXC:MissionFeatureSyncLanes 2026-07-30-02:10 (U7 / R3):
  Map the task's lifecycle POSITION onto the feature's roadmap status by ROLE. Keyed
  on the five literals, EVERY branch below silently answered "no" on a renamed
  workflow, so this collapsed to a permanent `noop`: the mission's roadmap froze at
  whatever status it last held while the tasks underneath it ran to completion.

  Worse than a wrong status — a stale roadmap reads as a stable one. Nothing errors,
  nothing retries, and the mission view stops tracking reality.

  Unresolvable workflow falls back to the LEGACY ids rather than to `noop`: a mission
  whose workflow cannot be read should keep tracking on the default vocabulary, not go
  silent, which is the exact failure being fixed here.
  */
  const roles = await resolveTaskLifecycleColumns(taskStore, task.id);
  const lane = {
    intake: roles?.intake ?? "triage",
    hold: roles?.hold ?? "todo",
    wip: roles?.wip ?? "in-progress",
    review: roles?.review ?? "in-review",
    complete: roles?.complete ?? "done",
    archived: roles?.archived ?? "archived",
  };

  if (task.column === lane.complete) {
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
  if (task.column === lane.archived) return { kind: "noop" };

  if (
    (task.column === lane.wip || task.column === lane.review)
    && (feature.status === "triaged" || feature.status === "defined")
  ) {
    return {
      kind: "update",
      status: "in-progress",
      reason: task.column === lane.review
        ? `task ${task.id} is in review`
        : `task ${task.id} started`,
    };
  }

  /*
  FNXC:MissionFeatureSyncLanes 2026-07-30-23:55 (rebase onto main's independent conversion):
  MAIN converted this branch to `context.plannerColumns` while this PR converted it to the
  task's own resolved lanes. Kept BOTH, because they answer different halves: a caller that
  knows the board's planner columns should win, and a caller that does not should still get
  the task's resolved lanes rather than the legacy pair.

  The ORPHANED-legacy-id acceptance is this PR's remaining contribution: a card resting in
  `triage`/`todo` on a workflow that does NOT declare that id is a pre-#2515 row U11's
  re-homing has not reached, and its feature must still return to `triaged`. Resolving lanes
  alone would silently stop tracking those rows — the same going-silent failure this whole
  conversion exists to fix.

  SCOPED to ids the workflow does not declare, per greptile on #2593: a custom workflow may
  legitimately name a NON-planner lane `triage` (its review column), and mapping a card there
  to `triaged` would misreport the roadmap.
  */
  const declaresColumn = (id: string): boolean => Object.values(lane).includes(id);
  const inPlannerLane = (context.plannerColumns ?? []).includes(task.column)
    || task.column === lane.intake
    || task.column === lane.hold
    || (LEGACY_PLANNER_COLUMNS.includes(task.column) && !declaresColumn(task.column));
  if (inPlannerLane && feature.status === "in-progress") {
    return {
      kind: "update",
      status: "triaged",
      reason: `task ${task.id} returned to triage`,
    };
  }

  return { kind: "noop" };
}
