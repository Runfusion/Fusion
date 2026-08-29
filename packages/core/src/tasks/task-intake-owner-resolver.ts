import type { Agent } from "../types.js";
import type { WorkflowIr, WorkflowIrNode } from "../workflows/workflow-ir-types.js";
import { classifyWorkflowAgentNode } from "../workflows/workflow-ir-types.js";
import { instanceNodeId, resolveColumnAgentBinding, resolveEffectiveAgent } from "../agents/column-agent-resolver.js";
import { isEphemeralAgent } from "../types.js";
import {
  canAgentReceiveImplementationTasks,
  canAgentTakeImplementationTaskForExplicitRouting,
  isAgentAutoAssignable,
  isExecutorRoleAgent,
} from "../agents/agent-role-policy.js";

export type TaskIntakeOwnerResolution =
  | { status: "selected"; agentId: string; source: "explicit" | "execute-binding" | "executor-pool" }
  | { status: "exempt"; reason: "terminal" | "historical" | "fixture" }
  | { status: "rejected"; reason: "explicit-assignee-ineligible" | "named-execute-binding-unavailable" | "workflow-unresolvable" | "agent-backend-unavailable" }
  | { status: "unowned"; reason: "no-eligible-executor" };

type IntakeOwnershipExemptionReason = "terminal" | "historical" | "fixture";

declare const intakeOwnershipExemptionBrand: unique symbol;

/**
 * Opaque capability accepted only by TaskStore's internal creation plumbing.
 * JSON and public tool/API inputs cannot carry its symbol brand.
 */
export type IntakeOwnershipExemption = {
  readonly reason: IntakeOwnershipExemptionReason;
  readonly [intakeOwnershipExemptionBrand]: true;
};

const intakeOwnershipExemptionToken = Symbol("fusion.task-intake-ownership-exemption");

type RuntimeIntakeOwnershipExemption = IntakeOwnershipExemption & {
  readonly [intakeOwnershipExemptionToken]: true;
};

/*
FNXC:IntakeOwnership 2026-08-09-19:49:
The exemption has named in-process factories for terminal, historical, and fixture-only creation so
its deliberate-null outcome is reachable without becoming a generic public opt-out. The symbol token
keeps JSON bodies, tool arguments, and forwarded payloads unable to forge any of these capabilities.
*/
function createIntakeOwnershipExemption(reason: IntakeOwnershipExemptionReason): IntakeOwnershipExemption {
  return {
    reason,
    [intakeOwnershipExemptionToken]: true,
  } as unknown as IntakeOwnershipExemption;
}

/** Creates the closed capability for a terminal task that must never be dispatched. */
export function createTerminalIntakeOwnershipExemption(): IntakeOwnershipExemption {
  return createIntakeOwnershipExemption("terminal");
}

/** Creates the closed capability for an imported historical record. */
export function createHistoricalIntakeOwnershipExemption(): IntakeOwnershipExemption {
  return createIntakeOwnershipExemption("historical");
}

/** Creates the closed capability for test fixtures that are not executable intake. */
export function createFixtureIntakeOwnershipExemption(): IntakeOwnershipExemption {
  return createIntakeOwnershipExemption("fixture");
}

/** Converts a closed internal capability into the resolver's simple pure-input reason. */
export function getInternalIntakeOwnershipExemptionReason(value: unknown): IntakeOwnershipExemptionReason | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<RuntimeIntakeOwnershipExemption>;
  return candidate[intakeOwnershipExemptionToken] === true
    && (candidate.reason === "terminal" || candidate.reason === "historical" || candidate.reason === "fixture")
    ? candidate.reason
    : undefined;
}

export interface ResolveTaskIntakeOwnerInput {
  workflow: WorkflowIr | "no-workflow-context" | "unresolvable";
  explicitAssigneeId?: string;
  /**
   * Bypasses only the explicit assignee's role check. It never bypasses policy "none",
   * ephemeral, disabled-runtime, paused, or error eligibility gates, and cannot affect automatic routing.
   */
  explicitAssigneeRoleOverride?: boolean;
  agents?: readonly Agent[];
  /** Internal plumbing supplies this only after validating an opaque exemption capability. */
  ownershipExemptionReason?: IntakeOwnershipExemptionReason;
  ownModelProvider?: string;
  ownModelId?: string;
  /** Per-task optional-group enablement. Omitted means no optional groups run. */
  enabledWorkflowSteps?: readonly string[];
  /** Current workflow-session load snapshot; it only orders pool candidates. */
  activeSessions?: ReadonlyMap<string, number>;
}

/*
FNXC:IntakeOwnership 2026-08-09-08:49:
Intake ownership is a durable executor identity, not the mutable workflow-stage principal. `unowned`
means a genuinely empty eligible executor pool and inserts a visible null owner; `rejected` means the
create must fail before insertion. Neither outcome is called `held`, which is reserved for routing waits.
*/
export function resolveTaskIntakeOwner(input: ResolveTaskIntakeOwnerInput): TaskIntakeOwnerResolution {
  if (input.ownershipExemptionReason) return { status: "exempt", reason: input.ownershipExemptionReason };
  if (!input.agents) return { status: "rejected", reason: "agent-backend-unavailable" };
  if (input.workflow === "unresolvable") return { status: "rejected", reason: "workflow-unresolvable" };

  const meetsNonRoleEligibility = (agent: Agent | undefined): agent is Agent => Boolean(
    agent
    && !isEphemeralAgent(agent)
    && agent.runtimeConfig?.enabled !== false
    && agent.state !== "paused"
    && agent.state !== "error"
    && canAgentReceiveImplementationTasks(agent),
  );
  const automaticallyEligible = (agent: Agent | undefined): agent is Agent => Boolean(
    meetsNonRoleEligibility(agent)
    // `explicit-only` is valid only for a caller's deliberate assignee. A binding
    // or pool choice is automatic routing and must retain that policy boundary.
    && isAgentAutoAssignable(agent)
    && isExecutorRoleAgent(agent),
  );
  const byId = new Map(input.agents.map((agent) => [agent.id, agent]));
  if (input.explicitAssigneeId !== undefined) {
    const explicit = byId.get(input.explicitAssigneeId);
    /*
    FNXC:IntakeOwnership 2026-08-11-02:04:
    DELIBERATE-LITERAL: this synthetic task-like value asks only whether an explicitly selected
    agent may perform implementation work; it is not a persisted task query or move target.
    FN-8843 duplicated an executor-only role check here, contradicting explicit-routing policy and the
    executorRoleOverride contract so every explicitly assigned engineer or operator override failed before insert.
    The shared policy now owns the explicit role decision; binding and pool routing remain executor-only.
    */
    const explicitRoleEligible = explicit !== undefined
      && (input.explicitAssigneeRoleOverride === true
        || canAgentTakeImplementationTaskForExplicitRouting(explicit, { column: "todo" }));
    return meetsNonRoleEligibility(explicit) && explicitRoleEligible
      ? { status: "selected", agentId: explicit.id, source: "explicit" }
      : { status: "rejected", reason: "explicit-assignee-ineligible" };
  }

  if (input.workflow !== "no-workflow-context") {
    const execute = firstReachableExecuteNode(input.workflow, new Set(input.enabledWorkflowSteps));
    if (execute) {
      const effective = resolveEffectiveAgent({
        binding: execute.binding,
        ownModelProvider: input.ownModelProvider,
        ownModelId: input.ownModelId,
      });
      if (effective.source === "column-agent") {
        const bound = byId.get(effective.agentId);
        return automaticallyEligible(bound)
          ? { status: "selected", agentId: bound.id, source: "execute-binding" }
          : { status: "rejected", reason: "named-execute-binding-unavailable" };
      }
    }
  }

  const activeSessions = input.activeSessions ?? new Map<string, number>();
  const pool = input.agents.filter((agent) => automaticallyEligible(agent)).sort((a, b) =>
    (activeSessions.get(a.id) ?? 0) - (activeSessions.get(b.id) ?? 0)
    || a.createdAt.localeCompare(b.createdAt)
    || a.id.localeCompare(b.id),
  );
  return pool[0]
    ? { status: "selected", agentId: pool[0].id, source: "executor-pool" }
    : { status: "unowned", reason: "no-eligible-executor" };
}

type ReachableExecuteNode = { node: WorkflowIrNode; binding: ReturnType<typeof resolveColumnAgentBinding> };

/*
FNXC:IntakeOwnership 2026-08-09-09:20:
The durable owner follows graph reachability, not authoring-array order: an unreachable executor
binding must never steal a new task from the first execute node its workflow can actually dispatch.
Container templates are searched through their local entry walk; foreach bindings use the canonical
instance-node identity so template inheritance preserves the same column-agent policy as runtime.
*/
function firstReachableExecuteNode(ir: WorkflowIr, enabledWorkflowSteps: ReadonlySet<string>): ReachableExecuteNode | undefined {
  const topLevel = reachableNodes(ir.nodes, ir.edges);
  for (const node of topLevel) {
    const found = findExecuteInNode(ir, node, enabledWorkflowSteps);
    if (found) return found;
  }
  return undefined;
}

function findExecuteInNode(
  ir: WorkflowIr,
  node: WorkflowIrNode,
  enabledWorkflowSteps: ReadonlySet<string>,
): ReachableExecuteNode | undefined {
  if (classifyWorkflowAgentNode(node) === "executor") {
    return { node, binding: resolveColumnAgentBinding(ir, node.id) };
  }
  const template = (node.config as { template?: { nodes?: WorkflowIrNode[]; edges?: WorkflowIr["edges"] } } | undefined)?.template;
  if (!template?.nodes?.length) return undefined;
  // FNXC:IntakeOwnership 2026-08-09-16:38: Optional-group templates are not
  // reachable when their group is disabled for this task. Never let a disabled
  // execute binding select or reject a durable owner for a path that cannot run.
  if (node.kind === "optional-group" && !enabledWorkflowSteps.has(node.id)) return undefined;

  for (const inner of reachableNodes(template.nodes, template.edges ?? [])) {
    if (classifyWorkflowAgentNode(inner) === "executor") {
      // FNXC:IntakeOwnership 2026-08-09-18:15: A nested foreach has no
      // top-level instance identity for resolveColumnAgentBinding. Retain its
      // template-column fallback so an execute node's own column wins over its outer container.
      const binding = node.kind === "foreach"
        ? resolveColumnAgentBinding(ir, instanceNodeId(node.id, 0, inner.id))
          ?? bindingForTemplateNode(ir, node, inner)
        : bindingForTemplateNode(ir, node, inner);
      return { node: inner, binding };
    }
    // Templates may nest foreach/containers. Continue the reachability walk rather
    // than treating a non-executor wrapper as a terminal graph fragment.
    const nested = findExecuteInNode(ir, inner, enabledWorkflowSteps);
    if (nested) {
      return {
        ...nested,
        binding: nested.binding ?? bindingForTemplateNode(ir, node, inner),
      };
    }
  }
  return undefined;
}

function bindingForTemplateNode(
  ir: WorkflowIr,
  container: WorkflowIrNode,
  node: WorkflowIrNode,
): ReturnType<typeof resolveColumnAgentBinding> {
  const columnId = node.column ?? container.column;
  return ir.version === "v2" && columnId !== undefined
    ? ir.columns.find((column) => column.id === columnId)?.agent
    : undefined;
}

function reachableNodes(nodes: readonly WorkflowIrNode[], edges: readonly WorkflowIr["edges"][number][]): WorkflowIrNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind === "rework" || !byId.has(edge.from) || !byId.has(edge.to)) continue;
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }
  const start = nodes.find((node) => node.kind === "start");
  // Invalid/legacy fragments have no start; retaining declaration order is a safe
  // compatibility fallback while valid workflow IR always takes the graph walk.
  if (!start) return [...nodes];

  const ordered: WorkflowIrNode[] = [];
  const seen = new Set<string>();
  const queue = [start.id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    ordered.push(node);
    queue.push(...(outgoing.get(id) ?? []));
  }
  return ordered;
}
