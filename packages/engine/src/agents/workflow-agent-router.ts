import {
  classifyWorkflowAgentNode,
  hasWorkflowRoleCapability,
  isEphemeralAgent,
  isWorkflowPrincipalEligible,
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
  | {
      status: "held";
      role: WorkflowAgentRole;
      reason: "named-principal-unavailable" | "role-pool-exhausted";
      /**
       * FNXC:WorkflowAgentRouting 2026-08-10-07:50:
       * Set when a persisted fence names a principal that can NEVER satisfy this node — the agent is gone,
       * lost the role, or had its authority edited away. The fence is stale, not waiting: the caller must
       * re-route from scratch instead of holding. A capable-but-busy principal never sets this, so the
       * "never silently replace a valid named principal" guarantee is unchanged.
       */
      staleFence?: true;
    }
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
  /*
   * FNXC:WorkflowAgentRouting 2026-08-10-07:50:
   * Every branch below proves the fence no longer describes reality — the node changed role, ownership moved,
   * or the review override was edited away. None of those resolve by waiting, so they are marked `staleFence`
   * and the caller re-routes. Holding on them is what turned an ordinary reassignment into a permanent wedge.
   */
  const staleFence = { status: "held", role: input.role, reason: "named-principal-unavailable", staleFence: true } as const;
  const classifiedRole = classifyWorkflowAgentNode(input.node);
  if (classifiedRole !== input.role) return staleFence;
  if (input.authority === "task-assignee" && (
    input.role !== "executor" || input.task.assignedAgentId !== input.principalAgentId
  )) {
    return staleFence;
  }
  /*
   * FNXC:WorkflowAgentRouting 2026-08-10-08:35:
   * "The override was edited away" and "I cannot resolve this node instance at all" are NOT the same fact, and
   * `isCurrentReviewerNodeOverride` returns false for both. Marking the second one stale would fail OPEN: an IR
   * that failed to load, or an instance id this run cannot resolve, would discard a REAL reviewer fence and let
   * the role pool take a review the operator explicitly named someone for. Only a resolved node whose
   * `reviewerAgentId` genuinely differs is stale; an unresolvable instance holds closed and waits for a human.
   */
  if (input.authority === "review-node-override") {
    const instance = input.nodeInstanceId
      ? findWorkflowNodeInstance(input.ir, input.nodeInstanceId)
      : input.node;
    if (!instance || classifyWorkflowAgentNode(instance) !== "reviewer") {
      return { status: "held", role: input.role, reason: "named-principal-unavailable" };
    }
    if (instance.reviewerAgentId !== input.principalAgentId) return staleFence;
  }
  /*
   * FNXC:WorkflowAgentRouting 2026-08-07-04:45:
   * A column binding is named authority too. A resumed work item must reject a
   * binding that was removed or redirected; otherwise an old column principal
   * could keep acting after an operator changed workflow routing.
   */
  if (input.authority === "column-binding") {
    // FNXC:WorkflowAgentRouting 2026-08-10-08:35: same fail-closed split as the review override above — an
    // absent IR is "cannot resolve", not "binding removed", and must never discard a live operator binding.
    if (!input.ir) return { status: "held", role: input.role, reason: "named-principal-unavailable" };
    if (resolveColumnAgentBinding(input.ir, input.node.id)?.agentId !== input.principalAgentId) return staleFence;
  }
  const agent = input.agents.find((candidate) => candidate.id === input.principalAgentId);
  // A vanished or role-less principal is a dead fence; a capable one that is merely busy is a real wait.
  if (!agent || !hasWorkflowRoleCapability(agent, input.role, {
    allowEngineerAsExecutor: input.authority === "task-assignee",
  })) {
    return staleFence;
  }
  return available(agent)
    ? { status: "routed", route: { agent, role: input.role, authority: input.authority } }
    : { status: "held", role: input.role, reason: "named-principal-unavailable" };
}

/** A named principal is never silently replaced once a precedence branch names it. */
function available(agent: Agent | undefined): agent is Agent {
  /*
   * FNXC:WorkflowAgentRouting 2026-08-07-03:38:
   * Workflow-stage routing may only select durable operator-visible principals.
   * Legacy task workers remain transient implementation infrastructure and must
   * never satisfy a role-pool route, even when their singular compatibility role
   * matches. A named transient identity is likewise unavailable and holds closed.
   */
  // FNXC:WorkflowAgentRouting 2026-08-10-01:15: the static half is shared with provisioning
  // (isWorkflowPrincipalEligible) so "what provisioning must produce" and "what routing accepts"
  // cannot drift apart again — that drift is what left every built-in owner unroutable.
  if (!agent || isEphemeralAgent(agent) || !isWorkflowPrincipalEligible(agent)) return false;
  /*
  FNXC:WorkflowAgentRouting 2026-08-11-09:12:
  Availability is now a pure ELIGIBILITY test — is this a durable principal that may run this role — with
  no session-count ceiling. `runtimeConfig.maxWorkflowSessions` used to gate here; a role agent at its
  ceiling reported `role-pool-exhausted`/`named-principal-unavailable` and the node became a durable
  `held` row that no dispatcher re-polled. With one agent per role that ceiling serialized the entire
  board. See `WorkflowAgentCapacity.acquire` for the full rationale — the two must stay consistent, since
  a cap in either place reproduces the same wedge on its own.
  */
  return true;
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
    /*
    FNXC:IntakeOwnership 2026-08-09-09:55:
    A durable task owner is only authority for an executor node when it still has
    the executor role. This revalidation protects legacy rows and concurrent
    reassignment from dispatching implementation work through a stale non-executor owner.
    */
    // FNXC:IntakeOwnership 2026-08-09-18:15: A persisted executor owner is
    // revalidated at dispatch. Runtime disablement and assignment policy changes
    // revoke implementation authority instead of letting a stale owner run work.
    /*
     * FNXC:WorkflowAgentRouting 2026-08-10-07:50:
     * `undefined` means "not authority for this node" and precedence CONTINUES to the column binding and then
     * the role pool. A named identity that lacks the role can never run this node, so holding on it waits
     * forever — that is the deadlock that stranded FN-8869/FN-8928/FN-8845 for hours behind idle pool agents,
     * each because an operator legitimately assigned the card to an ENGINEER-role permanent agent (which
     * `canAgentTakeImplementationTaskForExplicitRouting` permits) and the executor node then took that owner as
     * `task-assignee` authority. Availability is still fail-closed below: a principal that HAS the role but is
     * paused, disabled, or at session capacity holds, and is never silently replaced by a pool member.
     */
    if (!agent || !hasWorkflowRoleCapability(agent, role, { allowEngineerAsExecutor: authority === "task-assignee" })) {
      return undefined;
    }
    return available(agent)
      ? { status: "routed", route: { agent, role, authority } }
      : { status: "held", role, reason: "named-principal-unavailable" };
  };
  if (role === "reviewer") {
    const overridden = named(input.node.reviewerAgentId, "review-node-override");
    if (overridden) return overridden;
  }
  /*
  FNXC:IntakeOwnership 2026-08-09-08:49:
  Durable task ownership names an executor only. Planning and review must retain their separately
  fenced stage principals; treating the owner as authority there would route planners to executors.
  */
  if (role === "executor") {
    const owner = named(input.task.assignedAgentId, "task-assignee");
    if (owner) return owner;
  }
  const column = resolveColumnAgentBinding(input.ir, input.node.id);
  const bound = named(column?.agentId, "column-binding");
  if (bound) return bound;
  const pool = input.agents
    .filter((agent) => !input.excludedPoolAgentIds?.has(agent.id)
      && hasWorkflowRoleCapability(agent, role) && available(agent))
    .sort((left, right) => (activeSessions.get(left.id) ?? 0) - (activeSessions.get(right.id) ?? 0)
      || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const agent = pool[0];
  return agent
    ? { status: "routed", route: { agent, role, authority: "role-pool" } }
    : { status: "held", role, reason: "role-pool-exhausted" };
}
