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

/** Resolve one optional group's effective state consistently across runtime and
 * readiness gates. An explicit list (including `[]`) is authoritative; only a
 * missing list falls back to the workflow-authored default.
 * FNXC:WorkflowOptionalSteps 2026-07-21-11:51: Persisted explicit selections,
 * including an empty list, must override workflow defaults across all gates. */
export function isWorkflowOptionalGroupEnabled(
  enabledWorkflowSteps: readonly string[] | undefined,
  groupId: string,
  defaultOn = false,
): boolean {
  return Array.isArray(enabledWorkflowSteps)
    ? enabledWorkflowSteps.includes(groupId)
    : defaultOn;
}

/*
FNXC:WorkflowOptionalGroup 2026-06-21-14:05:
Re-pointed the per-task optional-step toggle SOURCE from the execution-inert `ir.optionalSteps` declaration to v2 `optional-group` NODES (one resolved entry per group). The legacy `WorkflowOptionalStep` type + `optionalSteps` IR field are now REMOVED (FNXC:WorkflowOptionalGroup 2026-06-21-18:00); a legacy persisted `optionalSteps` key on an old v2 row is tolerated/ignored at parse.
KEYING: the resolved entry is keyed by the group node `id`. The output field is still named `templateId` (not renamed) so the four consuming UI surfaces — inline quick-create card, New Task modal/TaskForm, task-detail Workflow tab, and the optional-steps dropdown — keep reading the same shape unchanged; they now toggle group ids into `enabledWorkflowSteps` instead of template ids. Renaming/recreating a group resets per-task state, identical to the prior `templateId` keying.
Display metadata: `name` comes from `config.name` (falling back to the node id), `defaultOn` from `config.defaultOn ?? false`, and `phase` from `config.phase ?? "pre-merge"`. `description` remains "" because optional-group nodes do not carry display copy for it.
*/

function isOptionalGroupNode(
  node: WorkflowIrNode,
): node is WorkflowIrNode & { config: WorkflowOptionalGroupConfig } {
  return node.kind === "optional-group";
}

function computeNodeExecutionRanks(ir: WorkflowIr): Map<string, number> {
  const ranks = new Map<string, number>();
  if (ir.version !== "v2" || !Array.isArray(ir.nodes) || !Array.isArray(ir.edges)) {
    return ranks;
  }

  const outgoing = new Map<string, string[]>();
  for (const edge of ir.edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from)?.push(edge.to);
  }

  const queue: Array<{ id: string; rank: number }> = [];
  for (const node of ir.nodes) {
    if (node.kind === "start" || node.id === "start") {
      queue.push({ id: node.id, rank: 0 });
    }
  }

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) continue;
    const current = ranks.get(next.id);
    if (current !== undefined && current <= next.rank) continue;
    ranks.set(next.id, next.rank);
    for (const target of outgoing.get(next.id) ?? []) {
      queue.push({ id: target, rank: next.rank + 1 });
    }
  }

  return ranks;
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

  const ranks = computeNodeExecutionRanks(ir);
  const resolved: Array<ResolvedWorkflowOptionalStep & { rank: number; nodeIndex: number }> = [];
  for (const [nodeIndex, node] of ir.nodes.entries()) {
    if (!isOptionalGroupNode(node)) continue;
    const config = (node.config ?? {}) as Partial<WorkflowOptionalGroupConfig>;
    resolved.push({
      // Keyed by the group node id (documented above); field name preserved.
      templateId: node.id,
      name: typeof config.name === "string" && config.name.trim() ? config.name : node.id,
      description: "",
      /*
      FNXC:WorkflowOptionalSteps 2026-06-29-12:47:
      Post-merge verification is now a graph-native optional group. Task creation and detail surfaces need the resolver to preserve `config.phase` so post-merge toggles do not look like pre-merge gates.
      */
      phase: config.phase === "post-merge" ? "post-merge" : "pre-merge",
      defaultOn: config.defaultOn === true,
      /*
      FNXC:WorkflowDefinitionSteps 2026-06-29-00:41:
      Definition/task creation surfaces must order optional groups by graph execution position, not raw node-array order. Derived built-ins can insert Plan Review between planning and parse while appending its node object, and operators still need the step list to show Plan Review before execution.
      */
      rank: ranks.get(node.id) ?? Number.MAX_SAFE_INTEGER,
      nodeIndex,
    });
  }
  return resolved
    .sort((a, b) => a.rank - b.rank || a.nodeIndex - b.nodeIndex)
    .map(({ rank: _rank, nodeIndex: _nodeIndex, ...step }) => step);
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
Every optional-group node id in a workflow, regardless of `defaultOn`. These ids are executor toggle keys (the per-task `enabledWorkflowSteps` set), NOT legacy `WorkflowStep` template ids. A built-in group id (e.g. "browser-verification") is passed through `resolveEnabledWorkflowSteps` untouched. (Historically it could collide with an id in the now-deleted built-in step-template catalog, which would wrongly materialize it into a step row the executor never matched; U6 removed that catalog + the materializer, so resolution is a pure identity-stable pass-through.)
*/
export function resolveAllOptionalGroupIds(ir: WorkflowIr): string[] {
  return resolveWorkflowOptionalSteps(ir).map((step) => step.templateId);
}
