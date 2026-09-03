/*
FNXC:ReviewVerdictAuthority 2026-09-02-19:16:
An approving review outcome requires a parsed structured JSON verdict object. Summary projections do not own merge approval, while every blocking gate, skill-less prompt review, and prompt inside a merge-consulted optional group does; the opt-in advisory ce-doc-review skill was the measured gap where a verdict-less response could be persisted as approval.
*/

export interface WorkflowStepVerdictRequirementInput {
  gateMode?: string;
  skillName?: string;
  summaryTarget?: string;
  optionalGroupId?: string;
}

/** Resolve whether a workflow prompt step must author a structured review verdict. */
export function resolveWorkflowStepVerdictRequirement(
  step: WorkflowStepVerdictRequirementInput,
): boolean {
  if (step.summaryTarget === "task") return false;

  const isSkillStep = typeof step.skillName === "string" && step.skillName.trim().length > 0;
  const isOptionalGroupStep = typeof step.optionalGroupId === "string" && step.optionalGroupId.trim().length > 0;
  return step.gateMode === "gate" || !isSkillStep || isOptionalGroupStep;
}
