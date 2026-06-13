import type { WorkflowIr } from "./workflow-ir-types.js";
import { WORKFLOW_STEP_TEMPLATES, type WorkflowStepTemplate } from "./types.js";

export interface ResolvedWorkflowOptionalStep {
  templateId: string;
  name: string;
  description: string;
  icon?: string;
  phase: NonNullable<WorkflowStepTemplate["phase"]>;
  defaultOn: boolean;
}

/**
 * Resolve workflow-declared optional step template ids into display metadata.
 *
 * The declaration is intentionally execution-inert: it only advertises which
 * template-backed workflow steps a task may toggle into `enabledWorkflowSteps`.
 * Unknown template ids are skipped so stale/custom declarations never render
 * blank UI rows or break workflow loading.
 */
export function resolveWorkflowOptionalSteps(
  ir: WorkflowIr,
  pluginTemplates: WorkflowStepTemplate[] = [],
): ResolvedWorkflowOptionalStep[] {
  if (ir.version !== "v2" || !ir.optionalSteps?.length) return [];

  const templates = new Map<string, WorkflowStepTemplate>();
  for (const template of [...WORKFLOW_STEP_TEMPLATES, ...pluginTemplates]) {
    templates.set(template.id, template);
  }

  const resolved: ResolvedWorkflowOptionalStep[] = [];
  for (const optionalStep of ir.optionalSteps) {
    const template = templates.get(optionalStep.templateId);
    if (!template) continue;
    resolved.push({
      templateId: optionalStep.templateId,
      name: template.name,
      description: template.description,
      icon: template.icon,
      phase: template.phase ?? "pre-merge",
      defaultOn: optionalStep.defaultOn ?? template.defaultOn ?? false,
    });
  }
  return resolved;
}
