import type { DriftAlignment, DriftReport, MissionFeature, Task, TaskStore, WorkflowSelectionCache } from "@fusion/core";
import { getTaskCompletionBlockerForStore } from "../execution/task-completion.js";
import { resolveLifecycleColumns, resolveTaskLifecycleColumns, resolveWorkflowIrForTask } from "@fusion/core";

export type MissionFeatureSyncTargetStatus = "done" | "in-progress" | "triaged";

/**
 * FNXC:SpecLockMissionAlignment 2026-08-09-07:36:
 * Drift alignment is an orthogonal mission projection. It intentionally does not participate in
 * delivery-status transitions: a diverged task may still be in progress, complete, or failed.
 */
export function projectMissionFeatureAlignment(report: { alignment: DriftAlignment } | undefined): DriftAlignment {
  return report?.alignment ?? "unavailable";
}

/**
 * FNXC:SpecLockMissionAlignment 2026-08-10-16:40:
 * Report persistence, rather than a later task move, is the authoritative alignment event. Update
 * only the linked feature's orthogonal field here; delivery status remains owned by the existing
 * scheduler and autopilot reconciliation paths.
 */
export async function publishPersistedMissionFeatureAlignment(
  taskStore: Pick<TaskStore, "getMissionStore">,
  taskId: string,
  report: Pick<DriftReport, "alignment">,
): Promise<boolean> {
  const missionStore = taskStore.getMissionStore();
  const feature = await missionStore.getFeatureByTaskId(taskId);
  if (!feature || feature.specAlignment === report.alignment) return false;
  await missionStore.updateFeature(feature.id, { specAlignment: report.alignment });
  return true;
}

/**
 * FNXC:SpecLockMissionAlignment 2026-08-09-19:51:
 * Mission delivery reconciliation consumes the retained report instead of deriving scope state
 * from a task column. An absent report is unavailable, never an implicit on-plan projection.
 */
export async function resolveMissionFeatureAlignment(
  taskStore: Pick<TaskStore, "getLatestSpecDriftReport">,
  taskId: string | undefined,
): Promise<DriftAlignment> {
  if (!taskId) return "unavailable";
  try {
    if (typeof taskStore.getLatestSpecDriftReport !== "function") return "unavailable";
    return projectMissionFeatureAlignment(await taskStore.getLatestSpecDriftReport(taskId));
  } catch {
    return "unavailable";
  }
}

export interface MissionFeatureSyncContext {
  hasLinkedAssertions?: boolean;
  /** FNXC:MissionFollowupLifecycle 2026-08-12-00:20: Live Decision-A follow-ups keep their source feature active until the whole delivery boundary is terminal. */
  hasLiveLineageDescendants?: boolean;
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

type MissionFeatureLifecycleLanes = {
  lane: { intake?: string; hold?: string; wip?: string; review?: string; complete?: string };
  declared: Set<string>;
};

/** Resolve the task workflow once so every mission feature projection uses the same role snapshot. */
async function resolveMissionFeatureLifecycleLanes(
  taskStore: Parameters<typeof resolveTaskLifecycleColumns>[0],
  taskId: string,
): Promise<MissionFeatureLifecycleLanes> {
  const ir = await resolveWorkflowIrForTask(taskStore, taskId).catch(() => undefined);
  const roles = ir ? resolveLifecycleColumns(ir) : undefined;
  const declaredColumnIds = new Set(
    ((ir as { columns?: Array<{ id?: unknown }> } | undefined)?.columns ?? [])
      .map((column) => column?.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const declared = new Set([
    ...Object.values(roles ?? {}).filter((value): value is string => typeof value === "string"),
    ...declaredColumnIds,
  ]);
  const laneOr = (resolved: string | undefined, legacy: string): string | undefined =>
    resolved ?? (declared.has(legacy) ? undefined : legacy);
  return {
    declared,
    lane: {
      intake: laneOr(roles?.intake, "triage"), hold: laneOr(roles?.hold, "todo"),
      wip: laneOr(roles?.wip, "in-progress"), review: laneOr(roles?.review, "in-review"),
      complete: laneOr(roles?.complete, "done"),
    },
  };
}

/*
FNXC:MissionValidationRepair 2026-08-10-17:20:
Classification and its fence must come from one task read and one workflow snapshot. A dangling
or deleted link is intentionally fenced as absent with its non-null id, allowing the store to
prove it remains absent instead of making the validation badge permanently unrepairable.
*/
export async function resolveFeatureRepairTargets(
  taskStore: Pick<TaskStore, "getTask"> & Parameters<typeof resolveTaskLifecycleColumns>[0],
  feature: Pick<MissionFeature, "id" | "taskId">,
): Promise<{ status: "defined" | "triaged" | "in-progress"; resumeImplementation: boolean; groundTruth: import("@fusion/core").MissionFeatureRepairGroundTruth }> {
  const resolvedAt = new Date().toISOString();
  const absent = (taskId: string | null): { status: "defined"; resumeImplementation: false; groundTruth: import("@fusion/core").MissionFeatureRepairGroundTruth } => ({
    status: "defined", resumeImplementation: false,
    groundTruth: { featureId: feature.id, taskId, taskLiveness: "absent", taskColumn: null, taskUpdatedAt: null, laneRole: "none", resolvedAt },
  });
  if (!feature.taskId) return absent(null);
  const task = await taskStore.getTask(feature.taskId).catch(() => null);
  if (!task || task.deletedAt) return absent(feature.taskId);

  const { lane, declared } = await resolveMissionFeatureLifecycleLanes(taskStore, task.id);
  const planner = task.column === lane.intake || task.column === lane.hold
    || (LEGACY_PLANNER_COLUMNS.includes(task.column) && !declared.has(task.column));
  const wip = task.column === lane.wip || task.column === lane.review;
  const laneRole = planner ? "planner" : wip ? "wip" : "none";
  /*
  FNXC:MissionValidationRepair 2026-08-11-01:46:
  A live task outside planner and WIP/review roles has no repair target. `defined` is reserved
  for an absent link, so accepting a live completed or custom lane would replace a blocked
  roadmap state with a false no-work state. Callers surface this actionable refusal rather than
  persisting a laneRole:none fence the store cannot truthfully apply.
  */
  if (laneRole === "none") {
    throw new Error(`Linked task ${task.id} is in '${task.column}', which is not a planner or active-work lifecycle lane; move it to a supported lane before repairing validation.`);
  }
  return {
    status: planner ? "triaged" : "in-progress", resumeImplementation: wip,
    groundTruth: { featureId: feature.id, taskId: task.id, taskLiveness: "live", taskColumn: task.column, taskUpdatedAt: task.updatedAt, laneRole, resolvedAt },
  };
}


export type MissionFeatureSyncDecision =
  | { kind: "failure"; reason: string; alignment: DriftAlignment }
  | { kind: "blocked"; reason: string; alignment: DriftAlignment }
  | { kind: "update"; status: MissionFeatureSyncTargetStatus; reason: string; alignment: DriftAlignment }
  | { kind: "noop"; alignment: DriftAlignment };

/**
 * FNXC:SpecLockMissionAlignment 2026-08-10-16:17:
 * Every production mission reconciler must publish the evaluated alignment even when the delivery
 * state is unchanged. Centralizing this write prevents event-driven and periodic consumers from
 * silently calculating a report and then dropping the roadmap projection.
 */
export async function persistMissionFeatureReconciliation(
  missionStore: Pick<{ updateFeature(id: string, updates: Partial<MissionFeature>): unknown }, "updateFeature">,
  feature: Pick<MissionFeature, "id" | "specAlignment">,
  decision: MissionFeatureSyncDecision,
): Promise<boolean> {
  if (decision.kind === "update") {
    await missionStore.updateFeature(feature.id, {
      status: decision.status,
      specAlignment: decision.alignment,
    });
    return true;
  }
  if (feature.specAlignment !== decision.alignment) {
    await missionStore.updateFeature(feature.id, { specAlignment: decision.alignment });
    return true;
  }
  return false;
}

export async function reconcileMissionFeatureState(
  taskStore: Pick<TaskStore, "getTask" | "getLatestSpecDriftReport"> & Parameters<typeof resolveTaskLifecycleColumns>[0],
  task: Task,
  feature: Pick<MissionFeature, "id" | "status" | "lastValidatorStatus" | "specAlignment">,
  context: MissionFeatureSyncContext = {},
  /*
  FNXC:MissionReverseLineageSpecAlignment 2026-08-19-21:44 (RUFU-134 / PR #3491):
  Optional caller-owned IR cache: a reconcile pass that already resolved this task's workflow
  (the terminal-column snapshot) projects alignment without a second per-task selection read.
  Single-task callers omit it and keep the original behavior.
  */
  caches?: {
    irCache?: Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>;
    selectionCache?: WorkflowSelectionCache;
  },
): Promise<MissionFeatureSyncDecision> {
  const alignment = await resolveMissionFeatureAlignment(taskStore, task.id);

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
      alignment,
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
  const ir = await resolveWorkflowIrForTask(taskStore, task.id, caches?.irCache, caches?.selectionCache).catch(() => undefined);
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
  };

  if ((lane.complete !== undefined && task.column === lane.complete)) {
    const blocker = await getTaskCompletionBlockerForStore(taskStore, task);
    if (blocker) {
      return { kind: "blocked", reason: blocker, alignment };
    }

    const pendingCompletionReason = context.hasLiveLineageDescendants === true
      ? "lineage follow-ups"
      : hasUnvalidatedAssertions
        ? "assertion validation"
        : undefined;
    if (pendingCompletionReason) {
      if (feature.status !== "in-progress") {
        return {
          kind: "update",
          status: "in-progress",
          reason: `task ${task.id} completed; awaiting ${pendingCompletionReason}`,
          alignment,
        };
      }
      return { kind: "noop", alignment };
    }

    if (feature.status !== "done") {
      return {
        kind: "update",
        status: "done",
        reason: `task ${task.id} completed`,
        alignment,
      };
    }

    return { kind: "noop", alignment };
  }

  /*
  FNXC:MissionReconciliation 2026-09-04-17:51:
  Only the workflow's live Complete lane proves delivery. Leave tasks in any
  other retained or historical position untouched so they cannot fabricate
  roadmap progress; callers may still recompute hierarchy idempotently.
  */
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
      alignment,
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
      alignment,
    };
  }

  return { kind: "noop", alignment };
}
