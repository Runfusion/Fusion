import {
  classifyWorkflowAgentNode,
  isEphemeralAgent,
  resolveColumnAgentBinding,
  type Agent,
  type TaskDetail,
  type WorkflowAgentRole,
  type WorkflowIr,
  type WorkflowIrNode,
} from "@fusion/core";

export type WorkflowPrincipalAuthority = "task-assignee" | "review-node-override" | "column-binding" | "role-pool";

export interface WorkflowPrincipalRoute {
  agent: Agent;
  role: WorkflowAgentRole;
  authority: WorkflowPrincipalAuthority;
}

export type WorkflowPrincipalRouteResult =
  | { status: "unclassified" }
  | { status: "held"; role: WorkflowAgentRole; reason: "named-principal-unavailable" | "role-pool-exhausted" }
  | { status: "routed"; route: WorkflowPrincipalRoute };

/**
 * FNXC:WorkflowAgentRouting 2026-08-07-04:31:
 * A claimed work item is a principal fence, not routing metadata. Resume must
 * revalidate the stored principal against the current task and exact reviewer
 * node, then use that same durable identity rather than resolving a new pool
 * candidate. A changed owner or edited-away review override fails closed.
 */
/**
 * FNXC:WorkflowAgentRouting 2026-08-07-04:56:
 * A reviewer override is an exact-node capability. Session tool gates use this
 * helper after reloading the workflow IR so editing/removing an override revokes
 * authority immediately rather than leaving a task-wide reviewer grant alive.
 */
export function isCurrentReviewerNodeOverride(
  ir: WorkflowIr | undefined,
  nodeInstanceId: string,
  principalAgentId: string,
): boolean {
  const node = findWorkflowNodeInstance(ir, nodeInstanceId);
  return node?.reviewerAgentId === principalAgentId && classifyWorkflowAgentNode(node) === "reviewer";
}

/**
 * FNXC:WorkflowAgentRouting 2026-08-07-05:29:
 * Reviewer authority is fenced to the instantiated template node, not merely a
 * top-level ID. A foreach review attempt uses `<foreach>#<index>:<node>`, so
 * resolving only `ir.nodes` would leave an edited nested override authorized.
 */
export function findWorkflowNodeInstance(ir: WorkflowIr | undefined, nodeInstanceId: string): WorkflowIrNode | undefined {
  if (!ir) return undefined;
  return findTemplateNodeInstance(ir.nodes, nodeInstanceId);
}

/** Resolve recursively because template containers may be nested. */
function findTemplateNodeInstance(nodes: readonly WorkflowIrNode[], nodeInstanceId: string): WorkflowIrNode | undefined {
  const direct = nodes.find((node) => node.id === nodeInstanceId);
  if (direct) return direct;

  for (const container of nodes) {
    const templateNodes = (container.config as { template?: { nodes?: WorkflowIrNode[] } } | undefined)?.template?.nodes;
    if (!templateNodes) continue;
    const optionalPrefix = `${container.id}::`;
    if (nodeInstanceId.startsWith(optionalPrefix)) {
      const nested = findTemplateNodeInstance(templateNodes, nodeInstanceId.slice(optionalPrefix.length));
      if (nested) return nested;
    }
    const iterationPrefix = `${container.id}#`;
    if (!nodeInstanceId.startsWith(iterationPrefix)) continue;
    const separator = nodeInstanceId.indexOf(":", iterationPrefix.length);
    if (separator < 0 || !/^\d+$/.test(nodeInstanceId.slice(iterationPrefix.length, separator))) continue;
    const nested = findTemplateNodeInstance(templateNodes, nodeInstanceId.slice(separator + 1));
    if (nested) return nested;
  }
  return undefined;
}

export function validateFencedWorkflowPrincipal(input: {
  task: Pick<TaskDetail, "assignedAgentId">;
  ir?: WorkflowIr;
  node: WorkflowIrNode;
  principalAgentId: string;
  role: WorkflowAgentRole;
  authority: WorkflowPrincipalAuthority;
  agents: readonly Agent[];
  /** Instantiated template identity used to revalidate exact-node review authority. */
  nodeInstanceId?: string;
  activeSessions?: ReadonlyMap<string, number>;
}): WorkflowPrincipalRouteResult {
  const classifiedRole = classifyWorkflowAgentNode(input.node);
  if (classifiedRole !== input.role) {
    return { status: "held", role: input.role, reason: "named-principal-unavailable" };
  }
  if (input.authority === "task-assignee" && input.task.assignedAgentId !== input.principalAgentId) {
    return { status: "held", role: input.role, reason: "named-principal-unavailable" };
  }
  if (input.authority === "review-node-override" && (
    input.nodeInstanceId
      ? !isCurrentReviewerNodeOverride(input.ir, input.nodeInstanceId, input.principalAgentId)
      : input.node.reviewerAgentId !== input.principalAgentId
  )) {
    return { status: "held", role: input.role, reason: "named-principal-unavailable" };
  }
  /*
   * FNXC:WorkflowAgentRouting 2026-08-07-04:45:
   * A column binding is named authority too. A resumed work item must reject a
   * binding that was removed or redirected; otherwise an old column principal
   * could keep acting after an operator changed workflow routing.
   */
  if (input.authority === "column-binding" && (!input.ir || resolveColumnAgentBinding(input.ir, input.node.id)?.agentId !== input.principalAgentId)) {
    return { status: "held", role: input.role, reason: "named-principal-unavailable" };
  }
  const agent = input.agents.find((candidate) => candidate.id === input.principalAgentId);
  return available(agent, input.activeSessions ?? new Map())
    ? { status: "routed", route: { agent, role: input.role, authority: input.authority } }
    : { status: "held", role: input.role, reason: "named-principal-unavailable" };
}

/** A named principal is never silently replaced once a precedence branch names it. */
function available(agent: Agent | undefined, activeSessions: ReadonlyMap<string, number>): agent is Agent {
  /*
   * FNXC:WorkflowAgentRouting 2026-08-07-03:38:
   * Workflow-stage routing may only select durable operator-visible principals.
   * Legacy task workers remain transient implementation infrastructure and must
   * never satisfy a role-pool route, even when their singular compatibility role
   * matches. A named transient identity is likewise unavailable and holds closed.
   */
  if (!agent || isEphemeralAgent(agent) || agent.state === "paused" || agent.state === "error") return false;
  const max = agent.runtimeConfig?.maxWorkflowSessions;
  return typeof max !== "number" || activeSessions.get(agent.id) === undefined || activeSessions.get(agent.id)! < max;
}

/**
 * FNXC:WorkflowAgentRouting 2026-08-07-03:12:
 * Routing selects a durable principal deterministically and never mutates task
 * ownership. A reviewer override applies only to the exact classified node;
 * unavailable named identities hold instead of falling through to the pool.
 */
export function routeWorkflowPrincipal(input: {
  task: Pick<TaskDetail, "assignedAgentId">;
  ir: WorkflowIr;
  node: WorkflowIrNode;
  agents: readonly Agent[];
  activeSessions?: ReadonlyMap<string, number>;
  /**
   * FNXC:WorkflowAgentRouting 2026-08-07-07:32:
   * Agent-capacity admission may race another engine after this process took its
   * snapshot. Retrying a pool route excludes only the contender that lost that
   * durable race; named authority must always hold closed instead.
   */
  excludedPoolAgentIds?: ReadonlySet<string>;
}): WorkflowPrincipalRouteResult {
  const role = classifyWorkflowAgentNode(input.node);
  if (!role) return { status: "unclassified" };
  const activeSessions = input.activeSessions ?? new Map();
  const byId = new Map(input.agents.map((agent) => [agent.id, agent]));
  const named = (id: string | undefined, authority: WorkflowPrincipalAuthority): WorkflowPrincipalRouteResult | undefined => {
    if (!id) return undefined;
    const agent = byId.get(id);
    return available(agent, activeSessions)
      ? { status: "routed", route: { agent, role, authority } }
      : { status: "held", role, reason: "named-principal-unavailable" };
  };
  if (role === "reviewer") {
    const overridden = named(input.node.reviewerAgentId, "review-node-override");
    if (overridden) return overridden;
  }
  const owner = named(input.task.assignedAgentId, "task-assignee");
  if (owner) return owner;
  const column = resolveColumnAgentBinding(input.ir, input.node.id);
  const bound = named(column?.agentId, "column-binding");
  if (bound) return bound;
  const pool = input.agents
    .filter((agent) => !input.excludedPoolAgentIds?.has(agent.id)
      && agent.roles.includes(role) && available(agent, activeSessions))
    .sort((left, right) => (activeSessions.get(left.id) ?? 0) - (activeSessions.get(right.id) ?? 0)
      || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const agent = pool[0];
  return agent
    ? { status: "routed", route: { agent, role, authority: "role-pool" } }
    : { status: "held", role, reason: "role-pool-exhausted" };
}
