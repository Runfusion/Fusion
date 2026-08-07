/**
 * FNXC:CodeOrganization 2026-08-07-12:00:
 * Graph beforeNodeExecution principal admission peeled for U4 (FN-8764 / FN-8821).
 *
 * FNXC:WorkflowAgentRouting 2026-08-07-03:38:
 * Graph execution resolves permanent workflow principals before handlers can create a model session.
 * An unavailable explicit owner, column agent, or reviewer override fails closed at its node instead
 * of silently selecting a different pool member. The durable work-item fence is established by the
 * work-item runtime path; this live graph admission makes the same routing contract authoritative
 * for direct dispatch.
 */
import type {
  Agent,
  AgentStore,
  Settings,
  TaskDetail,
  TaskStore,
  WorkflowColumnAgent,
  WorkflowIr,
  WorkflowIrNode,
} from "@fusion/core";
import { classifyWorkflowAgentNode, isWorkflowAgentRole } from "@fusion/core";
import {
  routeWorkflowPrincipal,
  validateFencedWorkflowPrincipal,
  type WorkflowPrincipalRouteResult,
} from "../agents/workflow-agent-router.js";
import type { WorkflowAgentCapacity } from "../agents/workflow-agent-capacity.js";
import type { WorkflowNodeResult } from "../workflows/workflow-graph-executor.js";

export type ActiveWorkflowAuthority = {
  agentId: string;
  taskId: string;
  runId: string;
  workItemId: string;
  nodeInstanceId: string;
  requiresDurableFence: boolean;
  kind: "task-assignee" | "review-node-override";
};

export type WorkflowPrincipalBeforeNodeDeps = {
  store: TaskStore;
  options: { agentStore?: AgentStore | null; [k: string]: unknown };
  workflowAgentCapacity: WorkflowAgentCapacity;
  activeWorkflowAuthorities: Map<string, ActiveWorkflowAuthority>;
  activeWorkflowPrincipals: Map<string, { agentId: string; nodeInstanceId: string; agent?: Agent }>;
  workflowCapacityAttemptIds: Set<string>;
  directWorkflowPrincipalWorkItemIds: Set<string>;
  columnAgentIr: WorkflowIr | undefined;
  resolveBindingForNode: (nodeId: string) => WorkflowColumnAgent | undefined;
  resolvedRunId: string | undefined;
  settings: Settings;
};

export async function admitWorkflowPrincipalBeforeNode(
  deps: WorkflowPrincipalBeforeNodeDeps,
  node: WorkflowIrNode,
  nodeTask: TaskDetail,
  context: Record<string, unknown>,
): Promise<WorkflowNodeResult | undefined> {
  const classifiedRole = classifyWorkflowAgentNode(node);
  if (!classifiedRole) return undefined;
  // A classified session without the authoritative IR/agent store must
  // fail closed; running it as an ambient executor defeats role routing.
  if (!deps.options.agentStore || !deps.columnAgentIr) {
    return { outcome: "failure" as const, value: `workflow-principal-routing-unavailable:${classifiedRole}` };
  }
  const agents = await deps.options.agentStore.listAgents({ includeEphemeral: true });
  const activeSessions = new Map(
    agents.map((agent) => [agent.id, deps.workflowAgentCapacity.activeSessions(agent.id, deps.store.getRootDir())]),
  );
  const fencedPrincipalId = typeof context["workflow:principal-agent-id"] === "string"
    ? context["workflow:principal-agent-id"]
    : undefined;
  const fencedRole = context["workflow:principal-role"];
  const fencedAuthority = context["workflow:principal-authority"];
  const nodeInstanceId = typeof context["workflow:node-instance-id"] === "string"
    ? context["workflow:node-instance-id"]
    : node.id;
  /*
   * FNXC:WorkflowAgentRouting 2026-08-07-04:31:
   * A work-item resume must consume its persisted principal fence. Do not call ordinary
   * precedence routing for a row that already names an agent: that would turn the durable
   * record into display-only metadata and could silently replace a reviewer or task owner.
   */
  const hasFencedPrincipal = Boolean(
    fencedPrincipalId
    && isWorkflowAgentRole(fencedRole)
    && (fencedAuthority === "task-assignee"
      || fencedAuthority === "review-node-override"
      || fencedAuthority === "column-binding"
      || fencedAuthority === "role-pool"),
  );
  let routed: WorkflowPrincipalRouteResult = hasFencedPrincipal
    && fencedPrincipalId
    && isWorkflowAgentRole(fencedRole)
    && (fencedAuthority === "task-assignee"
      || fencedAuthority === "review-node-override"
      || fencedAuthority === "column-binding"
      || fencedAuthority === "role-pool")
    ? validateFencedWorkflowPrincipal({
        task: nodeTask,
        ir: deps.columnAgentIr,
        node,
        principalAgentId: fencedPrincipalId,
        role: fencedRole,
        authority: fencedAuthority,
        agents,
        nodeInstanceId,
        activeSessions,
      })
    : routeWorkflowPrincipal({
        task: nodeTask,
        ir: deps.columnAgentIr,
        node,
        agents,
        activeSessions,
      });
  if (routed.status === "unclassified") return undefined;
  const holdDirectPrincipalWorkItem = async (
    reason: string,
    principalAgentId: string | null,
    authorityKind: "task-assignee" | "review-node-override" | "column-binding" | "role-pool" | null,
  ): Promise<void> => {
    if (typeof deps.store.upsertWorkflowWorkItem !== "function") return;
    const item = await deps.store.upsertWorkflowWorkItem({
      runId: `${deps.resolvedRunId ?? `${nodeTask.id}:workflow`}:${nodeInstanceId}`,
      taskId: nodeTask.id,
      nodeId: node.id,
      nodeInstanceId,
      kind: "task",
      state: "held",
      leaseOwner: null,
      leaseExpiresAt: null,
      blockedReason: reason,
      lastError: reason,
      principalAgentId,
      workflowRole: classifiedRole,
      authorityKind,
    });
    deps.directWorkflowPrincipalWorkItemIds.add(item.id);
  };
  if (routed.status === "held") {
    const reviewerOverride = classifiedRole === "reviewer" ? node.reviewerAgentId : undefined;
    const columnBinding = deps.resolveBindingForNode(node.id);
    const namedPrincipal = reviewerOverride ?? nodeTask.assignedAgentId ?? columnBinding?.agentId;
    const authorityKind = reviewerOverride
      ? "review-node-override"
      : nodeTask.assignedAgentId
        ? "task-assignee"
        : columnBinding?.agentId
          ? "column-binding"
          : null;
    const reason = `workflow-principal-${routed.reason}:${routed.role}`;
    /*
     * FNXC:WorkflowAgentRouting 2026-08-07-06:53:
     * Direct graph dispatch must preserve an unavailable named principal or exhausted role
     * pool as durable held work before suspending. A failure result would otherwise
     * terminalize the task and erase the exact availability condition operators need.
     */
    await holdDirectPrincipalWorkItem(reason, namedPrincipal ?? null, authorityKind);
    return { outcome: "failure" as const, value: reason };
  }
  const attemptId = `${deps.resolvedRunId}:${nodeInstanceId}`;
  /*
   * FNXC:WorkflowAgentRouting 2026-08-07-05:29:
   * Workflow-stage admission consumes the project workflow budget, while an agent's
   * heartbeat retains its separate maxConcurrentRuns budget.
   */
  let capacity = await deps.workflowAgentCapacity.acquire({
    projectId: deps.options.agentStore.workflowProjectId ?? deps.store.getRootDir(),
    agent: routed.route.agent,
    attemptId,
    maxProjectSessions: deps.settings.maxConcurrent,
  });
  /*
   * FNXC:WorkflowAgentRouting 2026-08-07-07:32:
   * A role-pool snapshot is process-local, while admission is durable across engines.
   * If another engine filled the selected agent between selection and the atomic acquire,
   * try the next eligible pool member. Fenced and named principals never take this fallback.
   */
  if (capacity.status === "held" && capacity.reason === "agent-capacity"
    && routed.route.authority === "role-pool" && !hasFencedPrincipal) {
    const excludedPoolAgentIds = new Set<string>();
    while (capacity.status === "held" && capacity.reason === "agent-capacity"
      && routed.route.authority === "role-pool") {
      excludedPoolAgentIds.add(routed.route.agent.id);
      const retryRoute = routeWorkflowPrincipal({
        task: nodeTask,
        ir: deps.columnAgentIr,
        node,
        agents,
        activeSessions,
        excludedPoolAgentIds,
      });
      if (retryRoute.status !== "routed" || retryRoute.route.authority !== "role-pool") break;
      routed = retryRoute;
      capacity = await deps.workflowAgentCapacity.acquire({
        projectId: deps.options.agentStore.workflowProjectId ?? deps.store.getRootDir(),
        agent: routed.route.agent,
        attemptId,
        maxProjectSessions: deps.settings.maxConcurrent,
      });
    }
  }
  if (capacity.status === "held") {
    const reason = `workflow-principal-${capacity.reason}:${routed.route.role}`;
    await holdDirectPrincipalWorkItem(reason, routed.route.agent.id, routed.route.authority);
    return { outcome: "failure" as const, value: reason };
  }
  let durableWorkItemId = typeof context["workflow:work-item-id"] === "string"
    ? context["workflow:work-item-id"]
    : undefined;
  /*
   * FNXC:WorkflowAgentRouting 2026-08-07-05:06:
   * Graph dispatch normally reaches handlers without a scheduler work item. Persist the
   * exact selected identity before constructing that handler session. A persistence
   * failure releases the just-acquired capacity and fails closed rather than running ambient.
   */
  if (!durableWorkItemId && typeof deps.store.upsertWorkflowWorkItem === "function") {
    try {
      const item = await deps.store.upsertWorkflowWorkItem({
        runId: `${deps.resolvedRunId ?? `${nodeTask.id}:workflow`}:${nodeInstanceId}`,
        taskId: nodeTask.id,
        nodeId: node.id,
        kind: "task",
        state: "running",
        leaseOwner: `executor:${nodeTask.id}`,
        leaseExpiresAt: null,
        principalAgentId: routed.route.agent.id,
        workflowRole: routed.route.role,
        authorityKind: routed.route.authority,
        nodeInstanceId,
      });
      durableWorkItemId = item.id;
      deps.directWorkflowPrincipalWorkItemIds.add(item.id);
    } catch {
      void deps.workflowAgentCapacity.release(
        attemptId,
        deps.options.agentStore.workflowProjectId ?? deps.store.getRootDir(),
      );
      return { outcome: "failure" as const, value: `workflow-principal-fence-unavailable:${routed.route.role}` };
    }
  }
  deps.workflowCapacityAttemptIds.add(attemptId);
  deps.activeWorkflowPrincipals.set(nodeTask.id, {
    agentId: routed.route.agent.id,
    nodeInstanceId,
    agent: routed.route.agent,
  });
  if (durableWorkItemId) context["workflow:work-item-id"] = durableWorkItemId;
  context["workflow:principal-agent-id"] = routed.route.agent.id;
  context["workflow:principal-role"] = routed.route.role;
  context["workflow:principal-authority"] = routed.route.authority;
  if (routed.route.authority === "task-assignee" || routed.route.authority === "review-node-override") {
    deps.activeWorkflowAuthorities.set(nodeTask.id, {
      agentId: routed.route.agent.id,
      taskId: nodeTask.id,
      runId: deps.resolvedRunId ?? `${nodeTask.id}:${node.id}`,
      workItemId: durableWorkItemId ?? attemptId,
      nodeInstanceId,
      requiresDurableFence: durableWorkItemId !== undefined,
      kind: routed.route.authority,
    });
  } else {
    deps.activeWorkflowAuthorities.delete(nodeTask.id);
  }
  context["workflow:release-principal"] = () => {
    // Delete first so the outer graph finally cannot double-release this attempt.
    deps.workflowCapacityAttemptIds.delete(attemptId);
    void deps.workflowAgentCapacity.release(
      attemptId,
      deps.options.agentStore?.workflowProjectId ?? deps.store.getRootDir(),
    );
    const principal = deps.activeWorkflowPrincipals.get(nodeTask.id);
    if (principal?.nodeInstanceId === nodeInstanceId) {
      deps.activeWorkflowPrincipals.delete(nodeTask.id);
      deps.activeWorkflowAuthorities.delete(nodeTask.id);
    }
    /*
     * FNXC:WorkflowAgentRouting 2026-08-07-05:37:
     * A principal fence ends with its handler attempt. Leaving these fields in shared
     * graph context made the next classified node reuse the prior role/node fence.
     */
    if (context["workflow:principal-agent-id"] === routed.route.agent.id) {
      delete context["workflow:principal-agent-id"];
      delete context["workflow:principal-role"];
      delete context["workflow:principal-authority"];
      delete context["workflow:work-item-id"];
    }
  };
  return undefined;
}
