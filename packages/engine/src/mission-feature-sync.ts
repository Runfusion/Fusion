import type { MissionFeature, Task, TaskStore } from "@fusion/core";
import { resolveLifecycleColumns, resolveTaskLifecycleColumns, resolveWorkflowIrForTask } from "@fusion/core";
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
  /*
  FNXC:MissionFeatureSyncLanes 2026-07-31-11:30 (found auditing my OWN merged code for the split I made
  three times in PR #2644):
  ONE SNAPSHOT. This read the workflow TWICE — `resolveTaskLifecycleColumns` for the roles and
  `resolveWorkflowIrForTask` for the declared column ids — which is literally the same read twice, since
  the former is `resolveLifecycleColumns(await resolveWorkflowIrForTask(...))`. A workflow edit between
  them gives roles from one revision and declared columns from another, so the aliasing guard below is
  evaluated against a column set that no longer matches the roles it is protecting.

  FOURTH occurrence of this shape in my work on this program (executor resume lanes, glasses lane
  context, glasses capture, here). The first three were caught in review; this one was already merged.
  The predictor that found it is mechanical rather than clever: grep for two resolver calls inside one
  function.
  */
  const ir = await resolveWorkflowIrForTask(taskStore, task.id).catch(() => undefined);
  const roles = ir ? resolveLifecycleColumns(ir) : undefined;
  /*
  FNXC:MissionFeatureSyncLanes 2026-07-30-05:40 (PR #2602 review — greptile P1):
  A per-role legacy fallback must NEVER claim a column the workflow assigned to a
  DIFFERENT role. Unguarded, a workflow that omits `hold` but names its REVIEW lane
  `todo` got `lane.hold = "todo"` — so a card awaiting merge matched the planner-lane
  branch and its feature was walked BACKWARDS from in-progress to triaged.

  The fallback exists for a workflow that declares no such role at all; it is not a
  licence to alias one that does. Same over-reach greptile caught in the plugin gates
  (#2607) and in the recovery acceptance (#2593) — three variations of "a legacy id is
  not a role".
  */
  /*
  FNXC:MissionFeatureSyncLanes 2026-07-30-06:40 (PR #2602 review, second P1 — greptile):
  DECLARED means "the workflow declares a column with this id", not "some ROLE resolved
  to this id". My previous revision built `declared` from the six resolved roles, so a
  custom workflow with a non-lifecycle column named `todo` — one carrying traits that
  map to no role — left the id invisible, the fallback claimed it as `lane.hold`, and a
  task resting there had its feature regressed to `triaged`.

  I had written that gap down as a residual limitation. Documenting it was not handling
  it: the IR is in reach here, so read the columns and the limitation disappears.
  */
  const declaredColumnIds = new Set(
    ((ir as { columns?: Array<{ id?: unknown }> } | undefined)?.columns ?? [])
      .map((c) => c?.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const declared = new Set([
    ...Object.values(roles ?? {}).filter((v): v is string => typeof v === "string"),
    ...declaredColumnIds,
  ]);
  const laneOr = (resolved: string | undefined, legacy: string): string | undefined =>
    resolved ?? (declared.has(legacy) ? undefined : legacy);
  const lane = {
    intake: laneOr(roles?.intake, "triage"),
    hold: laneOr(roles?.hold, "todo"),
    wip: laneOr(roles?.wip, "in-progress"),
    review: laneOr(roles?.review, "in-review"),
    complete: laneOr(roles?.complete, "done"),
    archived: laneOr(roles?.archived, "archived"),
  };

  if ((lane.complete !== undefined && task.column === lane.complete)) {
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
  if ((lane.archived !== undefined && task.column === lane.archived)) return { kind: "noop" };

  if (
    ((lane.wip !== undefined && task.column === lane.wip) || (lane.review !== undefined && task.column === lane.review))
    && (feature.status === "triaged" || feature.status === "defined")
  ) {
    return {
      kind: "update",
      status: "in-progress",
      reason: (lane.review !== undefined && task.column === lane.review)
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
  /*
  FNXC:MissionFeatureSyncLanes 2026-07-31-00:10 (rebase onto main's independent conversion):
  Three sources of truth, in priority order, and each is here for a reason main's version and
  this PR's version each covered only half of:
    1. `context.plannerColumns` — a caller that KNOWS the board's planner columns (main's
       conversion). Most specific, so it wins.
    2. the task's own resolved intake / hold roles (this PR's conversion), for callers that
       pass no planner columns.
    3. an ORPHANED legacy id — a card resting in `triage`/`todo` on a workflow that does NOT
       declare it. Those are pre-#2515 rows U11's re-homing has not reached; without this their
       feature silently stops being tracked, which is the going-silent failure being fixed.
  Scoped per greptile on #2593: a custom workflow may legitimately name a NON-planner lane
  `triage`, and mapping a card there to `triaged` would misreport the roadmap.
  */
  const declaresColumn = (id: string): boolean => Object.values(lane).includes(id) || declared.has(id);
  const inPlannerLane = (context.plannerColumns ?? []).includes(task.column)
    || (lane.intake !== undefined && task.column === lane.intake)
    || (lane.hold !== undefined && task.column === lane.hold)
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
