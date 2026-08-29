import type { WorkflowIr } from "../workflows/workflow-ir-types.js";
import type { WorkflowIrResolverStore } from "../workflows/workflow-ir-resolver.js";
import { resolveWorkflowIrForTaskWithProvenance } from "../workflows/workflow-ir-resolver.js";
import { resolveReviewColumns } from "../workflows/workflow-lifecycle-traits.js";
import {
  isWorkflowOptionalGroupEnabled,
  resolveWorkflowOptionalSteps,
} from "../workflows/workflow-optional-steps.js";

/*
FNXC:RequiredPreMergeSteps 2026-08-22-21:12:
An enabled optional group is a required merge gate even before it has produced a
result. Plan Review, Code Review, and Browser Verification omit `phase`, so they
resolve to pre-merge and must be included alongside groups that ran in earlier lanes.
Merge doors pass this resolved set while recovery scanners retain legacy result-only
semantics so they can discover and repair resultless cards.
*/
/** Resolves enabled optional-group ids that must have a terminal pre-merge result. */
export function resolveRequiredPreMergeStepIds(
  ir: WorkflowIr,
  enabledWorkflowSteps: readonly string[] | undefined,
): ReadonlySet<string> {
  return new Set(
    resolveWorkflowOptionalSteps(ir)
      .filter((step) => step.phase === "pre-merge")
      /*
      FNXC:ReportingOnlyGroup 2026-08-26-06:56:
      A reporting group records what it observed; it carries no approval, so requiring one from it can
      only produce a false blocker. Measured: the Documentation milestone returned an advisory REVISE,
      which records `advisory_failure`, which this set turned into "task has enabled pre-merge
      workflow steps without a current approval" — a reporter holding the merge door shut.
      */
      .filter((step) => !step.reportingOnly)
      .filter((step) => isWorkflowOptionalGroupEnabled(enabledWorkflowSteps, step.templateId, step.defaultOn))
      .map((step) => step.templateId),
  );
}

export type PreMergeGateResolution = "not-workflow-aware" | "no-selection" | "read-failed" | "selection";

export type ResolvedPreMergeGate = {
  reviewColumns: ReadonlySet<string>;
  requiredPreMergeStepIds: ReadonlySet<string>;
  provenance: "selection" | "default";
  selectionAbsent?: boolean;
  resolution: PreMergeGateResolution;
};

/*
FNXC:PreMergeGateResolution 2026-08-23-08:51:
FN-180 restores main's deleted `Legacy direct-merger callers have no workflow selection to resolve.
Keep their historical admission semantics; graph-owned tasks supply one.` carve-out without treating a
fallback IR as proof that a task enabled its default review gates. The real PostgreSQL TaskStore always
exposes selection readers; `not-workflow-aware` is only for legacy embedders and test doubles, and keeps
result-only semantics. A present reader that returns no selection makes builtin:coding the real task
workflow and can require its default-on gates; a read failure and a selected workflow that degrades to
default both fail closed at merge doors with `merge gate could not resolve the task workflow`.
*/
export async function resolvePreMergeGateForTask(
  store: WorkflowIrResolverStore,
  taskId: string,
  enabledWorkflowSteps: readonly string[] | undefined,
): Promise<ResolvedPreMergeGate> {
  const resolverStore = store as WorkflowIrResolverStore & {
    getTaskWorkflowSelection?: (id: string) => unknown;
    getTaskWorkflowSelectionAsync?: (id: string) => Promise<unknown>;
  };
  const readSelection = resolverStore.getTaskWorkflowSelectionAsync
    ? () => resolverStore.getTaskWorkflowSelectionAsync!(taskId)
    : typeof resolverStore.getTaskWorkflowSelection === "function"
      ? () => Promise.resolve(resolverStore.getTaskWorkflowSelection!(taskId))
      : undefined;

  let resolution: PreMergeGateResolution;
  let selection: unknown;
  if (!readSelection) {
    resolution = "not-workflow-aware";
  } else {
    try {
      selection = await readSelection();
      resolution = selection ? "selection" : "no-selection";
    } catch {
      resolution = "read-failed";
    }
  }

  // Reuse the public resolver with the already-read selection so its IR fallback and prompt overrides
  // remain canonical without issuing a second selection read that could race this classification.
  const cachedSelectionStore = Object.create(resolverStore) as WorkflowIrResolverStore;
  cachedSelectionStore.getTaskWorkflowSelection = () => selection as never;
  cachedSelectionStore.getTaskWorkflowSelectionAsync = async () => selection as never;
  const resolved = await resolveWorkflowIrForTaskWithProvenance(cachedSelectionStore, taskId);
  const selectionAbsent = resolution === "not-workflow-aware" || resolution === "no-selection";
  return {
    reviewColumns: new Set(resolveReviewColumns(resolved.ir)),
    requiredPreMergeStepIds: resolution === "not-workflow-aware"
      ? new Set<string>()
      : resolveRequiredPreMergeStepIds(resolved.ir, enabledWorkflowSteps),
    provenance: resolution === "read-failed" ? "default" : resolved.source,
    selectionAbsent,
    resolution,
  };
}
