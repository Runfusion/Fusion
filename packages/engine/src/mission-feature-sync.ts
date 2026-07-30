import type { MissionFeature, Task, TaskStore } from "@fusion/core";
import { resolveTaskLifecycleColumns } from "@fusion/core";
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

/**
 * The columns a task can sit in BEFORE implementation, from its own workflow.
 * Falls back to the legacy pair when the workflow cannot be resolved — conservative, because the
 * cost of an empty set here is a mission feature frozen at `in-progress` forever.
 */
async function resolvePreImplementationColumns(
  taskStore: MissionFeatureSyncStore,
  task: Task,
): Promise<ReadonlySet<string>> {
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-08:45 (triage-guard census — why this entry stays open):
  The legacy pair is UNIONED with the resolved lanes, not replaced by them, and that is a
  deliberate stop short of the census goal rather than an oversight.

  A store that cannot name the task's workflow resolves to the default builtin, whose merged
  Planning lane is `todo` alone — so replacing the pair would silently stop rolling back a card
  sitting in `triage` under `builtin:legacy-coding`, which still declares that column. The failure
  is invisible in the worst way: the mission feature stays `in-progress` while the task is queued
  for re-planning, so the roadmap reports work in flight that nobody is doing.

  Union fixes the real defect — a RENAMED planner column now rolls the feature back where before
  it did not — without regressing legacy. Closing the entry properly needs this function to know
  whether a resolution is a real selection or a default guess, which is a resolver change, not a
  call-site change.
  */
  const legacy = ["triage", "todo"];
  const columns = await resolveTaskLifecycleColumns(taskStore as never, task.id).catch(() => undefined);
  const lanes = new Set<string>(legacy);
  if (columns?.intake) lanes.add(columns.intake);
  if (columns?.hold) lanes.add(columns.hold);
  return lanes;
}

export type MissionFeatureSyncStore = Pick<TaskStore, "getTask">
  & Partial<Pick<TaskStore, "getTaskWorkflowSelection" | "getTaskWorkflowSelectionAsync" | "getWorkflowDefinition">>;

export async function reconcileMissionFeatureState(
  taskStore: MissionFeatureSyncStore,
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

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-08:20 (triage-guard census):
  "The task went BACK to a pre-implementation lane" is a lifecycle ROLE, not a pair of column
  ids. Naming `triage`/`todo` literally means a workflow that renames either one stops rolling
  its mission feature back — the feature stays `in-progress` while the task is queued for
  re-planning, so the roadmap reports work in flight that nobody is doing. Silent, and only
  visible to whoever reads the mission board.

  Resolved by trait (intake or hold) from the task's OWN workflow. When the workflow cannot be
  resolved the legacy pair is kept, so an unreadable workflow behaves exactly as before rather
  than freezing the feature. Note the `triaged` STATUS below is a mission-feature status, not a
  column id, and is deliberately untouched.
  */
  const preImplementationColumns = await resolvePreImplementationColumns(taskStore, task);
  if (preImplementationColumns.has(task.column) && feature.status === "in-progress") {
    return {
      kind: "update",
      status: "triaged",
      reason: `task ${task.id} returned to triage`,
    };
  }

  return { kind: "noop" };
}
