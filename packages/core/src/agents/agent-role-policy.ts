import type { Agent, Task } from "../types.js";

const IMPLEMENTATION_TASK_COLUMNS: ReadonlySet<Task["column"]> = new Set([
  "triage",
  "todo",
  "in-progress",
  "in-review",
]);

/*
FNXC:AgentRouting 2026-07-12-11:20:
GitHub issue Runfusion/Fusion#2015: product-code executor tasks were repeatedly routed to a liaison-only agent because
every routing path (scheduler auto-assign pool, heartbeat auto-claim, delegation, claim primitive) gated only on the
coarse `role` field — an agent whose mandate is "file upstream bug reports, never implement product code" is
indistinguishable from a real executor when its role is "executor".
The per-agent assignment policy (agent.runtimeConfig.assignmentPolicy) closes this:
- "auto" (default): current behavior — eligible for auto-assignment, backlog auto-claim, and explicit routing.
- "explicit-only": never auto-assigned or auto-claimed; may still receive explicitly routed/delegated tasks.
- "none": may NEVER be bound to implementation tasks by any path — including explicit delegation and the
  sourceMetadata.executorRoleOverride bypass. This is the hard guarantee for liaison/observer-type agents.
*/
export type AgentAssignmentPolicy = "auto" | "explicit-only" | "none";

export type AgentAssignmentPolicyInput = Pick<Agent, "role"> & Partial<Pick<Agent, "runtimeConfig">>;

export function getAgentAssignmentPolicy(agent: Partial<Pick<Agent, "id" | "role" | "runtimeConfig">>): AgentAssignmentPolicy {
  const raw = (agent.runtimeConfig ?? {})["assignmentPolicy"];
  return raw === "explicit-only" || raw === "none" ? raw : "auto";
}

/** Eligible for automatic routing (scheduler auto-assign, no-task backlog auto-claim). */
export function isAgentAutoAssignable(agent: Partial<Pick<Agent, "id" | "role" | "runtimeConfig">>): boolean {
  return getAgentAssignmentPolicy(agent) === "auto";
}

/**
 * Hard floor: policy "none" blocks implementation-task binding on EVERY path,
 * including explicit delegation and executorRoleOverride (issue #2015).
 */
export function canAgentReceiveImplementationTasks(agent: Partial<Pick<Agent, "id" | "role" | "runtimeConfig">>): boolean {
  return getAgentAssignmentPolicy(agent) !== "none";
}

export function isImplementationTask(task: Pick<Task, "column">): boolean {
  return IMPLEMENTATION_TASK_COLUMNS.has(task.column);
}

export function isExecutorRoleAgent(agent: Pick<Agent, "role">): boolean {
  return agent.role === "executor";
}

export function isEngineerRoleAgent(agent: Pick<Agent, "role">): boolean {
  return agent.role === "engineer";
}

export function canAgentTakeImplementationTaskForExplicitRouting(
  agent: AgentAssignmentPolicyInput,
  task: Pick<Task, "column">,
): boolean {
  if (!isImplementationTask(task)) return true;
  if (!canAgentReceiveImplementationTasks(agent)) return false;
  return isExecutorRoleAgent(agent) || isEngineerRoleAgent(agent);
}

export interface BacklogPickupRoleOptions {
  /** Allow durable engineer-role agents to auto-claim implementation backlog work. Default: false. */
  allowEngineer?: boolean;
}

/*
FNXC:AutoClaim 2026-07-19-00:00:
FN-8362: This is the shared automatic-backlog boundary. Executors always pass;
engineers require the resolved opt-in, while reviewer/custom never do. This
must remain separate from explicit routing, where eligible engineers can be
assigned or delegated work regardless of backlog-auto-claim settings.
*/
export function canAgentTakeImplementationTaskForBacklogPickup(
  agent: AgentAssignmentPolicyInput,
  task: Pick<Task, "column">,
  options: BacklogPickupRoleOptions = {},
): boolean {
  if (!isImplementationTask(task)) return true;
  // FNXC:AgentRouting 2026-07-12-11:20: backlog pickup is automatic routing — only "auto"-policy agents qualify (#2015).
  if (!isAgentAutoAssignable(agent)) return false;
  return isExecutorRoleAgent(agent) || (options.allowEngineer === true && isEngineerRoleAgent(agent));
}

export function canAgentTakeImplementationTask(
  agent: AgentAssignmentPolicyInput,
  task: Pick<Task, "column">,
  options?: BacklogPickupRoleOptions,
): boolean {
  return canAgentTakeImplementationTaskForBacklogPickup(agent, task, options);
}

/*
FNXC:AgentRouting 2026-07-12-11:40:
FN-7851 / issue #2015: the executor-role guard was enforced on user-facing binding surfaces but not the low-level
binding primitives (AgentStore.checkoutTask/assignTask, dashboard POST /tasks/:id/checkout), and the inbox selector
re-selected mis-bound in-progress tasks forever. Every binding surface must funnel through this ONE evaluator so the
policy can never drift between callers.
Override semantics: `executorRoleOverride` (explicit operator override) bypasses the ROLE check only — it never
bypasses assignmentPolicy "none", which is the hard liaison guarantee.
*/
export interface ImplementationTaskBindContext {
  /** True when the bind is explicit routing (task already assigned to this agent, operator/delegation choice). */
  explicitRouting?: boolean;
  /** True when the task carries sourceMetadata.executorRoleOverride === true or an operator passed override. */
  executorRoleOverride?: boolean;
  /** Backlog-pickup engineer opt-in (settings/runtimeConfig engineerBacklogAutoClaim). Only relevant when not explicit. */
  allowEngineer?: boolean;
}

export type ImplementationTaskBindVerdict = { allowed: true } | { allowed: false; reason: string };

export function evaluateImplementationTaskBind(
  agent: Pick<Agent, "id" | "role"> & Partial<Pick<Agent, "runtimeConfig">>,
  task: Pick<Task, "id" | "column">,
  context: ImplementationTaskBindContext = {},
): ImplementationTaskBindVerdict {
  if (!isImplementationTask(task)) {
    return { allowed: true };
  }
  if (!canAgentReceiveImplementationTasks(agent)) {
    return { allowed: false, reason: formatRoleMismatchReason(agent, task) };
  }
  if (context.executorRoleOverride === true) {
    return { allowed: true };
  }
  const explicit = context.explicitRouting === true;
  const roleAllowed = explicit
    ? canAgentTakeImplementationTaskForExplicitRouting(agent, task)
    : canAgentTakeImplementationTask(agent, task, { allowEngineer: context.allowEngineer });
  return roleAllowed ? { allowed: true } : { allowed: false, reason: formatRoleMismatchReason(agent, task) };
}

/** Typed error thrown by binding primitives when a bind violates the routing policy. */
export class AgentTaskRoutingPolicyError extends Error {
  readonly code = "agent-task-routing-policy" as const;
  constructor(
    public readonly agentId: string,
    public readonly taskId: string,
    reason: string,
  ) {
    super(reason);
    this.name = "AgentTaskRoutingPolicyError";
  }
}

export function assertImplementationTaskBindAllowed(
  agent: Pick<Agent, "id" | "role"> & Partial<Pick<Agent, "runtimeConfig">>,
  task: Pick<Task, "id" | "column">,
  context: ImplementationTaskBindContext = {},
): void {
  const verdict = evaluateImplementationTaskBind(agent, task, context);
  if (!verdict.allowed) {
    throw new AgentTaskRoutingPolicyError(agent.id, task.id, verdict.reason);
  }
}

export function formatRoleMismatchReason(
  agent: Pick<Agent, "id" | "role"> & Partial<Pick<Agent, "runtimeConfig">>,
  task: Pick<Task, "id" | "column">,
): string {
  const policy = getAgentAssignmentPolicy(agent);
  if (policy !== "auto") {
    return `Agent ${agent.id} has assignmentPolicy "${policy}"; implementation task ${task.id} cannot be routed to it${policy === "none" ? " by any path (no override supported)" : " automatically — explicit routing only"}.`;
  }
  return `Agent ${agent.id} has role "${agent.role}"; implementation task ${task.id} requires an "executor"-role agent by default, with durable "engineer" supported only for explicit routing. Pass override=true to bypass.`;
}
