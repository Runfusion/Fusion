import type { MissionFeature, Task, TaskStore } from "@fusion/core";
import { resolveLifecycleColumns, resolveWorkflowIrForTask } from "@fusion/core";
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
  FNXC:WorkflowLifecycleColumns 2026-07-30-11:20 (triage-guard census; PR #2609 review — greptile):
  INTAKE, plus the legacy ids ONLY where the workflow does not use them for something else.

  Two corrections, both from review, both cases where a wider set silently erases roadmap state:

  - `hold` is NOT pre-implementation. A workflow may carry the trait on a mid-pipeline capacity or
    manual-release wait; a card parked there is downstream of implementation, and rolling its
    feature back to `triaged` erases work that really happened. (Same mistake I had already fixed
    in the usage-limit lane — worth stating rather than quietly repeating.)
  - The legacy union must not OVERRIDE a workflow's own roles. A custom workflow is free to name
    its implementation or completion column `todo`, and unconditionally treating that id as
    pre-implementation would reset an active feature mid-flight.

  The legacy ids survive only as compat for a workflow that does not claim them, which is what a
  `{ getTask }`-only store resolving to the default builtin needs: post-merge the default declares
  `todo` as its Planning lane and no `triage` at all, so `builtin:legacy-coding` cards would
  otherwise stop rolling back.
  */
  const ir = await resolveWorkflowIrForTask(taskStore as never, task.id).catch(() => undefined);
  const columns = ir ? resolveLifecycleColumns(ir) : undefined;
  const order = (ir && "columns" in ir ? ir.columns ?? [] : []).map((column: { id: string }) => column.id);
  const lanes = new Set<string>();
  if (columns?.intake) lanes.add(columns.intake);
  /*
  A hold column is pre-implementation only when it sits BEFORE the implementation column in the
  workflow's declared order — `ir.columns` is ordered and that order IS the lifecycle order (see
  the graph entry contract). That is what separates a planning queue from a mid-pipeline wait:
  both carry `hold`, and the trait alone cannot tell them apart.
  */
  if (columns?.hold) {
    const holdIndex = order.indexOf(columns.hold);
    const wipIndex = columns.wip ? order.indexOf(columns.wip) : -1;
    if (holdIndex !== -1 && (wipIndex === -1 || holdIndex < wipIndex)) lanes.add(columns.hold);
  }
  const claimedElsewhere = new Set(
    [columns?.wip, columns?.review, columns?.complete, columns?.archived].filter((id): id is string => typeof id === "string"),
  );
  for (const legacyId of ["triage", "todo"]) {
    if (!claimedElsewhere.has(legacyId)) lanes.add(legacyId);
  }
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
