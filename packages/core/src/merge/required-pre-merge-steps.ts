import type { WorkflowIr } from "../workflows/workflow-ir-types.js";
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
      .filter((step) => isWorkflowOptionalGroupEnabled(enabledWorkflowSteps, step.templateId, step.defaultOn))
      .map((step) => step.templateId),
  );
}
