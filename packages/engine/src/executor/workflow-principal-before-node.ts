/**
 * FNXC:CodeOrganization 2026-08-08-12:00:
 * Graph beforeNodeExecution principal admission peeled for U4 (FN-8764 / FN-8821 / main tip).
 *
 * FNXC:WorkflowAgentRouting 2026-08-07-03:38 / 2026-08-07-23:50 / 2026-08-08-03:20:
 * Graph execution resolves permanent workflow principals before handlers can create a model session.
 * Fence writes use replaceActiveTaskWorkflowContinuation so resumed runs do not deadlock on the
 * one-active-continuation index. Missing agent-store/IR is logged as a composition fault.
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
  WorkflowWorkItem,
} from "@fusion/core";
import { classifyWorkflowAgentNode, isWorkflowAgentRole } from "@fusion/core";
import {
  routeWorkflowPrincipal,
  validateFencedWorkflowPrincipal,
} from "../agents/workflow-agent-router.js";
import type { WorkflowAgentCapacity } from "../agents/workflow-agent-capacity.js";
import type { WorkflowNodeResult } from "../workflows/workflow-graph-executor.js";
import { executorLog } from "../logger.js";

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
  /** Holds written for principal unavailability so terminalization can skip re-closing them. */
  directWorkflowPrincipalHeldWorkItemIds: Set<string>;
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
/*
 * A classified session without the authoritative IR/agent store must fail closed;
 * running it as an ambient executor defeats role routing.
 *
 * FNXC:WorkflowAgentRouting 2026-08-07-23:05:
 * Name WHICH dependency is missing and log it. Unlike every other refusal below,
 * this one persists no held work item (the durable-hold helper needs the very IR
 * that is missing), so it is the one routing outcome with no durable trace at all:
 * the run suspends with a bare `capacity` marker and the card re-suspends at the
 * same node every poll, indistinguishable from a dead engine. A missing agent-store
 * wire deadlocked the whole board this way. Neither condition is transient — both
 * are boot-time composition faults — so log at error, not warn.
 */
if (!deps.options.agentStore || !deps.columnAgentIr) {
  const missing = !deps.options.agentStore ? "no-agent-store" : "no-workflow-ir";
  executorLog.error(
    `[workflow-graph] ${nodeTask.id}: cannot route node '${node.id}' to a '${classifiedRole}' principal — ${missing}. `
    + "This is a runtime composition fault, not a transient wait: the node will re-suspend every dispatch until it is repaired.",
  );
  return { outcome: "failure" as const, value: `workflow-principal-routing-unavailable:${missing}:${classifiedRole}` };
}
const agents = await deps.options.agentStore.listAgents({ includeEphemeral: true });
const activeSessions = new Map(agents.map((agent) => [agent.id, deps.workflowAgentCapacity.activeSessions(agent.id, deps.store.getRootDir())]));
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
 * A work-item resume must consume its persisted principal fence. Do
 * not call ordinary precedence routing for a row that already names
 * an agent: that would turn the durable record into display-only
 * metadata and could silently replace a reviewer or task owner.
 */
const hasFencedPrincipal = fencedPrincipalId
  && isWorkflowAgentRole(fencedRole)
  && (fencedAuthority === "task-assignee" || fencedAuthority === "review-node-override" || fencedAuthority === "column-binding" || fencedAuthority === "role-pool");
let routed = hasFencedPrincipal
  && (fencedAuthority === "task-assignee" || fencedAuthority === "review-node-override" || fencedAuthority === "column-binding" || fencedAuthority === "role-pool")
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
/** Cleared when a stale fence is discarded, so the pool-capacity retry below is no longer fenced off. */
let fenceStillGoverns = Boolean(hasFencedPrincipal);
/*
 * FNXC:WorkflowAgentRouting 2026-08-10-07:50:
 * A fence that no longer describes reality is not a wait — the principal is gone, lost the role, or had its
 * authority edited away, and no amount of re-dispatching fixes that. Re-route from scratch so the card keeps
 * executing under whoever IS authority now. Without this, a resumed continuation kept re-asserting a dead
 * principal every dispatch and the task only ever advanced when a human moved it.
 */
if (routed.status === "held" && routed.staleFence) {
  executorLog.warn(
    `[workflow-graph] ${nodeTask.id}: fenced principal '${fencedPrincipalId}' can no longer run node '${node.id}' `
    + `as '${classifiedRole}' — discarding the stale fence and re-routing.`,
  );
  routed = routeWorkflowPrincipal({
    task: nodeTask,
    ir: deps.columnAgentIr,
    node,
    agents,
    activeSessions,
  });
  // The fence is discarded, so a fresh role-pool route may take the cross-engine capacity retry below.
  fenceStillGoverns = false;
}
if (routed.status === "unclassified") return undefined;
/*
 * FNXC:WorkflowAgentRouting 2026-08-07-23:50:
 * EVERY durable continuation write on this path goes through the atomic
 * replace primitive, never a bare upsert.
 *
 * `idx_workflow_work_items_one_active_task_continuation` permits ONE active
 * (`runnable`/`running`/`held`/`retrying`) `kind:"task"` row per task, and a
 * plain upsert's ON CONFLICT target is a DIFFERENT constraint
 * (run_id, task_id, node_id, kind). So a row this run has already left — the
 * continuation it resumed on, or a previous foreach instance of the same
 * template node, which shares `nodeId` and differs only by `runId` — does not
 * upsert, it RAISES. That raise deadlocked the board: routing failed closed,
 * the run re-suspended every dispatch, and only an operator bouncing the card
 * cleared it.
 *
 * `replaceActiveTaskWorkflowContinuation` retires every active row that is not
 * this exact (runId, nodeId, kind) and upserts the successor inside ONE
 * transaction holding the task's advisory lock. That is what makes the handover
 * atomic (no window with zero active rows), instance-aware (a sibling foreach
 * instance has a different runId, so it is retired), and race-free against a
 * concurrent engine (the lock serializes the read and the write). It is the
 * repository's existing primitive for exactly this — `plan-review-continuation.ts`
 * and `workflow-column-boundary-hooks.ts` already use it.
 *
 * Deliberately NOT an error-recovery path: an earlier revision reacted to a
 * failed upsert by terminalizing other rows, which meant any transient database
 * error destroyed a legitimate `held` continuation. Replacing unconditionally on
 * the success path removes the need to classify errors at all.
 */
const writeContinuation = async (
  input: Parameters<NonNullable<TaskStore["upsertWorkflowWorkItem"]>>[0] & { kind: "task" },
): Promise<WorkflowWorkItem | undefined> => {
  if (typeof deps.store.replaceActiveTaskWorkflowContinuation === "function") {
    return await deps.store.replaceActiveTaskWorkflowContinuation(input);
  }
  // Degradation for minimal/legacy stores without the atomic primitive:
  // a bare upsert keeps the pre-primitive behavior rather than failing the run.
  if (typeof deps.store.upsertWorkflowWorkItem === "function") {
    return await deps.store.upsertWorkflowWorkItem(input);
  }
  return undefined;
};
/*
 * FNXC:WorkflowAgentRouting 2026-08-07-23:50:
 * A hold write must NEVER throw out of `beforeNodeExecution`. Only
 * `WorkflowGraphSuspended` is rethrown by the interpreter, so any other throw
 * here degrades a recoverable availability hold into a terminal graph failure —
 * the card is parked failed instead of waiting for its principal. Failing to
 * RECORD the hold is bad; failing the task because we could not record it is
 * worse. Log and continue: the refusal value still fails the node closed.
 */
const holdDirectPrincipalWorkItem = async (
  reason: string,
  principalAgentId: string | null,
  authorityKind: "task-assignee" | "review-node-override" | "column-binding" | "role-pool" | null,
): Promise<void> => {
  try {
    const item = await writeContinuation({
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
    if (item) {
      deps.directWorkflowPrincipalWorkItemIds.add(item.id);
      // The run now owns the task's single active continuation at THIS node, so
      // the caller must not also transition the row it resumed on (that row is
      // already retired, and transitioning a terminal row throws).
      deps.directWorkflowPrincipalHeldWorkItemIds.add(item.id);
    }
  } catch (holdErr) {
    executorLog.error(
      `[workflow-graph] ${nodeTask.id}: could not persist the availability hold for node '${node.id}' (${reason}): `
      + `${holdErr instanceof Error ? holdErr.message : String(holdErr)}`,
    );
  }
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
   * Direct graph dispatch must preserve an unavailable named principal
   * or exhausted role pool as durable held work before suspending. A
   * failure result would otherwise terminalize the task and erase the
   * exact availability condition operators need to repair or await.
   */
  await holdDirectPrincipalWorkItem(reason, namedPrincipal ?? null, authorityKind);
  return { outcome: "failure" as const, value: reason };
}
/*
 * FNXC:WorkflowAgentRouting 2026-08-08-03:20:
 * Use the SAME run-id fallback the two durable writes below use. `deps.resolvedRunId` is
 * optional by construction (a definition load failure leaves it undefined), and this
 * interpolated it raw — producing the literal attempt id `undefined:<nodeInstance>`,
 * shared by every task in the project that hit that failure. The capacity lease is
 * keyed on `(projectId, attemptId)` and returns `acquired` for a pre-existing row
 * REGARDLESS of agent, so colliding tasks bypass both the project and per-agent caps,
 * and one task's release deletes another's live lease.
 */
const attemptId = `${deps.resolvedRunId ?? `${nodeTask.id}:workflow`}:${nodeInstanceId}`;
/*
 * FNXC:WorkflowAgentRouting 2026-08-07-05:29:
 * Workflow-stage admission consumes the project workflow budget, while
 * an agent's heartbeat retains its separate maxConcurrentRuns budget.
 * Passing the project limit here closes the direct-graph path, which
 * otherwise enforced only optional per-agent limits.
 */
let capacity = await deps.workflowAgentCapacity.acquire({
  projectId: deps.options.agentStore.workflowProjectId ?? deps.store.getRootDir(),
  agent: routed.route.agent,
  attemptId,
  maxProjectSessions: deps.settings.maxConcurrent,
});
/*
 * FNXC:WorkflowAgentRouting 2026-08-07-07:32:
 * A role-pool snapshot is process-local, while admission is durable
 * across engines. If another engine filled the selected agent between
 * selection and the atomic acquire, try the next eligible pool member.
 * Fenced and named principals never take this fallback.
 */
if (capacity.status === "held" && capacity.reason === "agent-capacity"
  && routed.route.authority === "role-pool" && !fenceStillGoverns) {
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
 * Graph dispatch normally reaches handlers without a scheduler work
 * item. Persist the exact selected identity before constructing that
 * handler session, so policy gates and recovery have the same durable
 * fence as a claimed continuation. A persistence failure releases the
 * just-acquired capacity and fails closed rather than running ambient.
 */
if (!durableWorkItemId) {
  /*
   * FNXC:WorkflowAgentRouting 2026-08-07-23:50:
   * The fence is written through the atomic replace primitive (see
   * `writeContinuation` above), so the row this run already left — the resumed
   * continuation, or a sibling foreach instance sharing this template `nodeId` —
   * is retired in the SAME locked transaction that installs this fence. There is
   * therefore no conflict to react to and no window in which the task has zero
   * active continuations.
   *
   * A failure here still fails CLOSED: no session may start without its durable
   * principal record. Release the just-acquired capacity and surface the store
   * error, whose actionable text (constraint name, NOT NULL column) the store
   * layer puts on `cause` rather than `message`.
   */
  try {
    const item = await writeContinuation({
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
    if (item) {
      durableWorkItemId = item.id;
      deps.directWorkflowPrincipalWorkItemIds.add(item.id);
    }
  } catch (fenceErr) {
    const detail = fenceErr instanceof Error ? fenceErr.message : String(fenceErr);
    const cause = fenceErr instanceof Error && fenceErr.cause instanceof Error
      ? ` [cause: ${fenceErr.cause.message}]`
      : "";
    executorLog.error(
      `[workflow-graph] ${nodeTask.id}: durable principal fence write failed for node '${node.id}' `
      + `(role=${routed.route.role}, authority=${routed.route.authority}, agent=${routed.route.agent.id}): ${detail}${cause}`,
    );
    await deps.store.logEntry(
      nodeTask.id,
      `Workflow principal fence write failed at node '${node.id}' — ${detail.slice(0, 300)}${cause}`,
    ).catch(() => undefined);
    void deps.workflowAgentCapacity.release(attemptId, deps.options.agentStore.workflowProjectId ?? deps.store.getRootDir());
    return { outcome: "failure" as const, value: `workflow-principal-fence-unavailable:${routed.route.role}` };
  }
}
deps.workflowCapacityAttemptIds.add(attemptId);
deps.activeWorkflowPrincipals.set(nodeTask.id, {
  agentId: routed.route.agent.id,
  nodeInstanceId,
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
  void deps.workflowAgentCapacity.release(attemptId, deps.options.agentStore?.workflowProjectId ?? deps.store.getRootDir());
  deps.workflowCapacityAttemptIds.delete(attemptId);
  const principal = deps.activeWorkflowPrincipals.get(nodeTask.id);
  if (principal?.nodeInstanceId === nodeInstanceId) {
    deps.activeWorkflowPrincipals.delete(nodeTask.id);
    deps.activeWorkflowAuthorities.delete(nodeTask.id);
  }
  /*
   * FNXC:WorkflowAgentRouting 2026-08-07-05:37:
   * A principal fence ends with its handler attempt. Leaving these
   * fields in shared graph context made the next classified node reuse
   * the prior role/node fence and fail closed (or worse, inherit it).
   * Template wrappers restore only their parent node identity after
   * this release; no principal context crosses a node boundary.
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
