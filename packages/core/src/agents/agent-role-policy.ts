import type { Agent, AgentCapability, Task } from "../types.js";

/*
FNXC:WorkflowResolvedColumns 2026-07-30-15:20 (FLAGGED, NOT FIXED — found by a #2739 review thread):
THE ROLE-ROUTING POLICY IS BYPASSED ENTIRELY ON A RENAMED BOARD.

`isImplementationTask` is a Set membership test over these hardcoded ids, and
`evaluateImplementationTaskBind` short-circuits to `{ allowed: true }` when it returns false. So on a
workflow whose lanes are named anything else, EVERY agent is bind-compatible with EVERY task: the role
check that exists to stop a liaison/custom agent being handed implementation work — the NEXT-871 loop
FN-7851 fixed — silently does not apply.

HOW IT SURFACED, which is the part worth keeping: a reviewer noticed my dispatch test claimed to exercise
the bind evaluator while omitting the optional `agent` argument. Passing a real agent was not enough to
prove the evaluator RAN, so I added a case asserting a `custom`-role agent is refused an implementation
task on a renamed lane. It FAILED — the task was handed over — and the cause is this Set, not the test.

WHY THE CENSUS NEVER FLAGGED IT: these are Set MEMBERS, not comparisons. The lifecycle-column census scans
`===`/`!==` against a column, so a literal collection is invisible to it — the same blind spot that hid the
raw-`sql` encoding of the archived gate (PR #2724). Worth knowing that the backlog number is a floor, not a
total.

NOT FIXED HERE. `isImplementationTask` is a SYNC pure predicate with no store and no task id, called from
`evaluateImplementationTaskBind`, which gates agent assignment; resolving a workflow inside it means
threading a resolver through the routing policy and making its callers async. That is a behaviour change to
agent admission, not a vocabulary conversion, and the failure mode of getting it wrong is either handing
implementation work to a liaison or refusing work to a valid executor.
*/
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

/*
FNXC:WorkflowAgentRouting 2026-08-07-07:56:
FN-8764 makes `roles` canonical. Assignment admission must inspect every
normalized tag while still accepting the deprecated singular projection from
legacy callers, so a multi-role executor is never rejected as its first tag.
*/
type RoleTaggedAgent = Partial<Pick<Agent, "id" | "role" | "roles" | "runtimeConfig">>;

function agentRoles(agent: RoleTaggedAgent): readonly AgentCapability[] {
  return agent.roles?.length ? agent.roles : agent.role ? [agent.role] : [];
}

export type AgentAssignmentPolicyInput = RoleTaggedAgent;

export function getAgentAssignmentPolicy(agent: RoleTaggedAgent): AgentAssignmentPolicy {
  const raw = (agent.runtimeConfig ?? {})["assignmentPolicy"];
  return raw === "explicit-only" || raw === "none" ? raw : "auto";
}

/** Eligible for automatic routing (scheduler auto-assign, no-task backlog auto-claim). */
export function isAgentAutoAssignable(agent: RoleTaggedAgent): boolean {
  return getAgentAssignmentPolicy(agent) === "auto";
}

/**
 * Hard floor: policy "none" blocks implementation-task binding on EVERY path,
 * including explicit delegation and executorRoleOverride (issue #2015).
 */
export function canAgentReceiveImplementationTasks(agent: RoleTaggedAgent): boolean {
  return getAgentAssignmentPolicy(agent) !== "none";
}

/**
 * FNXC:WorkflowAgentRouting 2026-08-10-01:15:
 * The STATIC half of workflow-principal routability, shared so provisioning and the router cannot drift.
 * A disabled runtime, a paused/errored agent, or a transient per-task worker can never own a workflow stage.
 * The router adds the dynamic half (session capacity); this predicate is the part provisioning must satisfy
 * for an instance to be able to route a role at all.
 *
 * Extracted after every built-in workflow owner shipped `runtimeConfig: { enabled: false }` while the router
 * treated `enabled === false` as unavailable — so the only permanent principals for triage/executor/reviewer/
 * merger were unroutable by construction, and any instance without operator-created role agents held at its
 * first workflow node.
 */
/** True for the four provenance-marked permanent owners that route built-in workflow stages. */
export function isBuiltinWorkflowRoleAgent(agent: { metadata?: Record<string, unknown> | null }): boolean {
  return agent.metadata?.builtInWorkflowRole === true;
}

/*
FNXC:WorkflowAgentRouting 2026-08-10-01:15:
`runtimeConfig.enabled` means ONE thing: run this agent's own durable heartbeat loop. Every consumer in the
engine reads it that way — heartbeat scheduling, error recovery, self-healing, the in-process runtime — except
the workflow router, which also treated it as "may own a workflow stage". Those are different questions, and
conflating them is what produced BOTH failures here:

 - Built-in owners ship with the heartbeat off (correct — they are invoked BY the workflow engine and must not
   run autonomous loops or auto-claim work), and that silently made every built-in role unroutable, deadlocking
   the board.
 - Turning the heartbeat on to restore routing then gave four agents autonomous loops nobody asked for.

So the flag is separated: `enabled` governs the heartbeat runtime ONLY, and workflow routability is answered by
{@link isWorkflowPrincipalEligible}. For the four built-in owners routability is STRUCTURAL — they are the
engine's own principals for triage/executor/reviewer/merger, there is no fallback if a role cannot route, and
"unroutable" is not a state an operator can meaningfully select. To take one out of rotation, add your own
agent with that role and route to it; that leaves the role routable, which is the property this protects.
*/

export function isWorkflowPrincipalEligible(
  agent: Pick<RoleTaggedAgent, "runtimeConfig"> & {
    state?: string;
    id?: string;
    metadata?: Record<string, unknown> | null;
  },
): boolean {
  // A paused or errored agent is genuinely unusable — that applies to built-ins too, so it is checked first.
  if (agent.state === "paused" || agent.state === "error") return false;
  // Built-in owners route regardless of their heartbeat setting; see the note above.
  if (isBuiltinWorkflowRoleAgent(agent)) return true;
  return agent.runtimeConfig?.enabled !== false;
}

export function isImplementationTask(task: Pick<Task, "column">): boolean {
  return IMPLEMENTATION_TASK_COLUMNS.has(task.column);
}

export function isExecutorRoleAgent(agent: RoleTaggedAgent): boolean {
  return agentRoles(agent).includes("executor");
}

export function isEngineerRoleAgent(agent: RoleTaggedAgent): boolean {
  return agentRoles(agent).includes("engineer");
}

/*
FNXC:WorkflowAgentRouting 2026-08-10-07:50:
STRUCTURAL capability for a workflow stage, kept separate from AVAILABILITY. The distinction decides
whether an unroutable named principal is a WAIT or a DEAD END, and conflating the two wedged the board:

FN-8869/FN-8928/FN-8845 were each explicitly assigned to a permanent ENGINEER-role agent, which
`canAgentTakeImplementationTaskForExplicitRouting` allows by design. The workflow `step-execute` node then
took that owner as `task-assignee` named authority, found no `executor` tag, and held closed — and a NAMED
principal never falls through to the role pool. Two idle `Workflow Executor` pool agents sat unused while the
cards re-dispatched and re-held every ~15 minutes for hours. The only thing still touching them was the owner
agent's own hourly heartbeat, which logged "progressing, no blockers" and exited: heartbeat observation had
silently replaced execution.

An agent that lacks the role can NEVER satisfy the node, so waiting on it is unbounded by construction. It was
never authority for this node in the first place — routing must skip it and continue precedence. Only an agent
that HAS the role but is momentarily unusable (paused/errored/disabled runtime/at session capacity) earns a
hold, because that hold ends on its own.
*/
export interface WorkflowRoleCapabilityOptions {
  /*
  FNXC:WorkflowAgentRouting 2026-08-10-07:50:
  Accept an ENGINEER-role owner as capable of an executor node. Set ONLY for named task-assignee authority,
  never for the role pool.

  A durable engineer explicitly assigned to a task is already allowed to take implementation work
  (`canAgentTakeImplementationTaskForExplicitRouting`), so the executor node it owns must run — and run
  CONTINUOUSLY under graph dispatch. The alternative, which is what actually shipped, is that the owner's
  hourly heartbeat becomes the only thing that ever touches the card: it wakes, logs "progressing, no
  blockers", calls fn_heartbeat_done, and the work never advances. An agent holding a task executes it; a
  heartbeat is a liveness tick, not a work loop.

  The POOL stays strict, because automatic backlog pickup by engineers is a separate opt-in
  (`canAgentTakeImplementationTaskForBacklogPickup`) and unassigned work must not silently land on engineers.
  */
  readonly allowEngineerAsExecutor?: boolean;
}

export function hasWorkflowRoleCapability(
  agent: RoleTaggedAgent,
  role: AgentCapability,
  options: WorkflowRoleCapabilityOptions = {},
): boolean {
  const roles = agentRoles(agent);
  const tagged = roles.includes(role)
    || (role === "executor" && options.allowEngineerAsExecutor === true && roles.includes("engineer"));
  if (!tagged) return false;
  // Assignment policy "none" is a hard floor on implementation work; such an agent can never run an executor node.
  return role !== "executor" || canAgentReceiveImplementationTasks(agent);
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
  agent: RoleTaggedAgent & Pick<Agent, "id">,
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
  agent: RoleTaggedAgent & Pick<Agent, "id">,
  task: Pick<Task, "id" | "column">,
  context: ImplementationTaskBindContext = {},
): void {
  const verdict = evaluateImplementationTaskBind(agent, task, context);
  if (!verdict.allowed) {
    throw new AgentTaskRoutingPolicyError(agent.id, task.id, verdict.reason);
  }
}

export function formatRoleMismatchReason(
  agent: RoleTaggedAgent & Pick<Agent, "id">,
  task: Pick<Task, "id" | "column">,
): string {
  const policy = getAgentAssignmentPolicy(agent);
  if (policy !== "auto") {
    return `Agent ${agent.id} has assignmentPolicy "${policy}"; implementation task ${task.id} cannot be routed to it${policy === "none" ? " by any path (no override supported)" : " automatically — explicit routing only"}.`;
  }
  const roles = agentRoles(agent);
  return `Agent ${agent.id} has roles "${roles.join(", ") || "none"}"; implementation task ${task.id} requires an "executor"-role agent by default, with durable "engineer" supported only for explicit routing. Pass override=true to bypass.`;
}
