import type {
  WorkflowIr,
  WorkflowIrNode,
  WorkflowOptionalGroupConfig,
} from "./workflow-ir-types.js";
import type { WorkflowStepTemplate } from "./types.js";

export interface ResolvedWorkflowOptionalStep {
  templateId: string;
  name: string;
  description: string;
  icon?: string;
  phase: NonNullable<WorkflowStepTemplate["phase"]>;
  defaultOn: boolean;
}

/*
FNXC:WorkflowOptionalGroup 2026-06-21-14:05:
Re-pointed the per-task optional-step toggle SOURCE from the execution-inert `ir.optionalSteps` declaration to v2 `optional-group` NODES (one resolved entry per group). The legacy `WorkflowOptionalStep` type + `optionalSteps` IR field are now REMOVED (FNXC:WorkflowOptionalGroup 2026-06-21-18:00); a legacy persisted `optionalSteps` key on an old v2 row is tolerated/ignored at parse.
KEYING: the resolved entry is keyed by the group node `id`. The output field is still named `templateId` (not renamed) so the four consuming UI surfaces — inline quick-create card, New Task modal/TaskForm, task-detail Workflow tab, and the optional-steps dropdown — keep reading the same shape unchanged; they now toggle group ids into `enabledWorkflowSteps` instead of template ids. Renaming/recreating a group resets per-task state, identical to the prior `templateId` keying.
Display metadata: `name` comes from `config.name` (falling back to the node id), `defaultOn` from `config.defaultOn ?? false`. The group node carries no description/icon/phase, so `description` is "" and `phase` defaults to "pre-merge" — keeping every field the consumers read populated and non-blank.
*/

function isOptionalGroupNode(
  node: WorkflowIrNode,
): node is WorkflowIrNode & { config: WorkflowOptionalGroupConfig } {
  return node.kind === "optional-group";
}

/**
 * Resolve a workflow's `optional-group` nodes into per-task toggle display
 * metadata. Each enabled group's node id is what a task stores in
 * `enabledWorkflowSteps`; this resolver advertises which groups a task may
 * toggle plus their seed default.
 *
 * Source: v2 `ir.nodes` where `kind === "optional-group"` (NOT the legacy
 * `ir.optionalSteps` declaration). Non-v2 graphs and graphs without any
 * optional-group node resolve to `[]`. A group with a missing or partial config
 * still resolves to a usable entry — `name` falls back to the node id and
 * `defaultOn` to false — rather than being dropped, so a stale/partial node never
 * silently disappears from the toggle UI or breaks workflow loading.
 *
 * `pluginTemplates` is accepted for signature compatibility with the prior
 * template-backed resolver; group nodes are self-describing, so it is currently
 * unused.
 */
export function resolveWorkflowOptionalSteps(
  ir: WorkflowIr,
  _pluginTemplates: WorkflowStepTemplate[] = [],
): ResolvedWorkflowOptionalStep[] {
  if (ir.version !== "v2" || !Array.isArray(ir.nodes)) return [];

  const resolved: ResolvedWorkflowOptionalStep[] = [];
  for (const node of ir.nodes) {
    if (!isOptionalGroupNode(node)) continue;
    const config = (node.config ?? {}) as Partial<WorkflowOptionalGroupConfig>;
    resolved.push({
      // Keyed by the group node id (documented above); field name preserved.
      templateId: node.id,
      name: typeof config.name === "string" && config.name.trim() ? config.name : node.id,
      description: "",
      phase: "pre-merge",
      defaultOn: config.defaultOn === true,
    });
  }
  return resolved;
}

/**
 * Ids of `optional-group` nodes whose effective `defaultOn` is true. Used to
 * seed a new task's `enabledWorkflowSteps` at creation, mirroring the prior
 * `optionalStep.defaultOn ?? false` precedence (U3, R3). Defensive: non-v2
 * graphs and graphs without optional groups yield `[]`.
 */
export function resolveDefaultOnOptionalGroupIds(ir: WorkflowIr): string[] {
  return resolveWorkflowOptionalSteps(ir)
    .filter((step) => step.defaultOn)
    .map((step) => step.templateId);
}

/*
FNXC:WorkflowOptionalGroup 2026-06-21-16:30:
Every optional-group node id in a workflow, regardless of `defaultOn`. These ids are executor toggle keys (the per-task `enabledWorkflowSteps` set), NOT legacy `WorkflowStep` template ids. A built-in group id can deliberately equal a `WORKFLOW_STEP_TEMPLATES` id (e.g. "browser-verification"), so the store must pass these through `resolveEnabledWorkflowSteps` untouched instead of materializing them into a step row whose id the executor would never match.
*/
export function resolveAllOptionalGroupIds(ir: WorkflowIr): string[] {
  return resolveWorkflowOptionalSteps(ir).map((step) => step.templateId);
}
