import type { PluginContext } from "@fusion/plugin-sdk";
import { resolveTaskLifecycleColumns } from "@fusion/core";
import { taskToCard, type GlassesCard } from "./cards.js";
import { GlassesInputError } from "./quick-capture.js";

type TaskRecord = NonNullable<Awaited<ReturnType<PluginContext["taskStore"]["getTask"]>>>;

type AgentActionInput = {
  taskId: unknown;
};

type AgentActionDeps = {
  taskStore: PluginContext["taskStore"];
  pluginId: string;
  cardOptions?: unknown;
};

/*
FNXC:PluginLifecycleColumns 2026-07-30-03:20 (U11 #2515 audit):
Is the card in its workflow's PRE-IMPLEMENTATION lane — intake or hold?

These gates named `triage` directly. U11 merged Todo into Planning keeping the id
`todo` and DELETING `triage`, so on the default lineage `approvePlan` refused every
card (an awaiting-approval card now sits in `todo`) and `retryTask`'s planning branch
became unreachable. `startWork` survived only because it already accepted both ids —
which is the tell: the gate written against a lane kept working, the two written
against an id broke.

Resolves the task's OWN lanes when the host store can (this plugin depends on
`@fusion/core`), and falls back to BOTH legacy ids when it cannot. The fallback is
not cosmetic: `PluginContext["taskStore"]` is a narrowed surface and is not
guaranteed to expose workflow selection, so a plugin must degrade to something that
works rather than to something that refuses.
*/
const LEGACY_PLANNING_IDS = new Set(["triage", "todo"]);

/** Legacy destination ids, used only when the workflow declares no such role. */
const LEGACY_DESTINATIONS = { hold: "todo", wip: "in-progress", review: "in-review" } as const;

type Lanes = {
  intake?: string; hold?: string; wip?: string; review?: string; complete?: string; archived?: string;
};

/**
 * FNXC:PluginLifecycleColumns 2026-07-30-05:10 (PR #2607 review — greptile P1 x2):
 * Resolve the task's lanes ONCE per action, so gates AND destinations come from the
 * same answer.
 *
 * The first version resolved only the GATES and left `moveTask` pointing at
 * `in-progress` / `todo` literally. On a renamed workflow that is worse than the bug
 * it replaced: the gate now admits the card and then moves it into a column the
 * workflow does not declare (R7). Half a conversion moved the failure from "refuses
 * valid work" to "puts work somewhere nothing renders it".
 */
async function resolveLanes(
  taskStore: AgentActionDeps["taskStore"],
  taskId: string,
): Promise<Lanes | undefined> {
  try {
    return await resolveTaskLifecycleColumns(taskStore as never, taskId) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Every column id the workflow assigns to a role. */
function declaredIds(lanes?: Lanes): Set<string> {
  return new Set(Object.values(lanes ?? {}).filter((v): v is string => typeof v === "string"));
}

/**
 * FNXC:PluginLifecycleColumns 2026-07-30-05:10 (PR #2607 review — greptile P1):
 * Is the card in its workflow's PRE-IMPLEMENTATION lane?
 *
 * The legacy acceptance is SCOPED: a legacy id counts only when the workflow does not
 * assign it to ANY role. Unscoped, a workflow that names its review or wip lane
 * `triage`/`todo` would have those cards authorized as planning work — greptile's
 * finding, and the same over-reach caught on #2593 and #2602. Scoping needs the whole
 * lane set, which is why `resolveLanes` returns all of it rather than intake/hold only;
 * the earlier version could not express this and said so as a known limitation.
 */
function isInPlanningLane(lanes: Lanes | undefined, column: string): boolean {
  if (column === lanes?.intake || column === lanes?.hold) return true;
  return LEGACY_PLANNING_IDS.has(column) && !declaredIds(lanes).has(column);
}

/** A move target from the resolved role, falling back to the legacy id ONLY when the
 *  workflow declares no such role — never over a column it assigned elsewhere. */
function destination(lanes: Lanes | undefined, role: keyof typeof LEGACY_DESTINATIONS): string {
  return lanes?.[role] ?? LEGACY_DESTINATIONS[role];
}


type AgentActionResult = {
  task: TaskRecord;
  card: GlassesCard;
};

const START_WORK_BLOCKED_STATUSES = new Set(["planning", "needs-replan", "awaiting-approval", "awaiting-user-review"]);
const RETRYABLE_FAILURE_STATUSES = new Set(["failed", "stuck-killed"]);
const RETRYABLE_TRIAGE_STATUSES = new Set(["failed", "planning", "needs-replan"]);

function normalizeTaskId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GlassesInputError(400, "taskId is required");
  }
  return value.trim();
}

async function getTaskOrThrow(taskStore: PluginContext["taskStore"], taskId: string): Promise<TaskRecord> {
  const task = await taskStore.getTask(taskId);
  if (!task) {
    throw new GlassesInputError(404, "task not found");
  }
  return task as TaskRecord;
}

function conflict(verb: string, task: { column: unknown; status?: unknown }): never {
  throw new GlassesInputError(409, `${verb} not allowed in column=${String(task.column)} status=${String(task.status ?? null)}`);
}

async function toResult(taskStore: PluginContext["taskStore"], taskId: string): Promise<AgentActionResult> {
  const task = await getTaskOrThrow(taskStore, taskId);
  return { task, card: taskToCard(task as never) };
}

export async function startWork(input: AgentActionInput, deps: AgentActionDeps): Promise<AgentActionResult> {
  const taskId = normalizeTaskId(input.taskId);
  const task = await getTaskOrThrow(deps.taskStore, taskId);
  const startLanes = await resolveLanes(deps.taskStore, taskId);
  if (!isInPlanningLane(startLanes, String(task.column)) || START_WORK_BLOCKED_STATUSES.has(String(task.status))) {
    conflict("start-work", task);
  }
  // Intentional v1 limitation: plugin cannot import engine allocator, so moveTask runs without allocateWorktree.
  await deps.taskStore.moveTask(taskId, destination(startLanes, "wip"));
  return toResult(deps.taskStore, taskId);
}

export async function requestReview(input: AgentActionInput, deps: AgentActionDeps): Promise<AgentActionResult> {
  const taskId = normalizeTaskId(input.taskId);
  const task = await getTaskOrThrow(deps.taskStore, taskId);
  if (task.column !== "in-progress") {
    conflict("request-review", task);
  }
  await deps.taskStore.moveTask(taskId, "in-review");
  return toResult(deps.taskStore, taskId);
}

export async function approvePlan(input: AgentActionInput, deps: AgentActionDeps): Promise<AgentActionResult> {
  const taskId = normalizeTaskId(input.taskId);
  const task = await getTaskOrThrow(deps.taskStore, taskId);
  const approveLanes = await resolveLanes(deps.taskStore, taskId);
  if (!isInPlanningLane(approveLanes, String(task.column)) || task.status !== "awaiting-approval") {
    conflict("approve-plan", task);
  }
  await deps.taskStore.moveTask(taskId, destination(approveLanes, "hold"));
  await deps.taskStore.updateTask(taskId, { status: undefined });
  return toResult(deps.taskStore, taskId);
}

export async function acceptReview(input: AgentActionInput, deps: AgentActionDeps): Promise<AgentActionResult> {
  const taskId = normalizeTaskId(input.taskId);
  const task = await getTaskOrThrow(deps.taskStore, taskId);
  if (task.column !== "in-review") {
    conflict("accept-review", task);
  }
  await deps.taskStore.updateTask(taskId, { status: null, assigneeUserId: null });
  return toResult(deps.taskStore, taskId);
}

export async function returnToAgent(input: AgentActionInput, deps: AgentActionDeps): Promise<AgentActionResult> {
  const taskId = normalizeTaskId(input.taskId);
  const task = await getTaskOrThrow(deps.taskStore, taskId);
  if (task.column !== "in-review") {
    conflict("return-to-agent", task);
  }
  await deps.taskStore.updateTask(taskId, {
    assigneeUserId: null,
    status: null,
    assignedAgentId: null,
  });
  await deps.taskStore.moveTask(taskId, "todo");
  return toResult(deps.taskStore, taskId);
}

export async function retryTask(input: AgentActionInput, deps: AgentActionDeps): Promise<AgentActionResult> {
  const taskId = normalizeTaskId(input.taskId);
  const task = await getTaskOrThrow(deps.taskStore, taskId);

  if (task.column === "in-review" && RETRYABLE_FAILURE_STATUSES.has(String(task.status))) {
    await deps.taskStore.updateTask(taskId, { status: null, error: null, stuckKillCount: 0, mergeRetries: 0 });
    return toResult(deps.taskStore, taskId);
  }

  const retryLanes = await resolveLanes(deps.taskStore, taskId);
  if (
    isInPlanningLane(retryLanes, String(task.column)) &&
    (RETRYABLE_TRIAGE_STATUSES.has(String(task.status)) || (typeof task.stuckKillCount === "number" && task.stuckKillCount > 0))
  ) {
    // Intentional v1 limitation: does not delete on-disk PROMPT.md or run dashboard step-reset/branch-inspection logic.
    await deps.taskStore.updateTask(taskId, {
      status: "needs-replan",
      error: null,
      worktree: null,
      branch: null,
      baseBranch: null,
      baseCommitSha: null,
      stuckKillCount: 0,
      recoveryRetryCount: null,
      nextRecoveryAt: null,
    });
    return toResult(deps.taskStore, taskId);
  }

  if (RETRYABLE_FAILURE_STATUSES.has(String(task.status))) {
    // Intentional v1 limitation: omits dashboard retry step-reset/branch-inspection behavior.
    await deps.taskStore.updateTask(taskId, {
      status: null,
      error: null,
      worktree: null,
      branch: null,
      baseBranch: null,
      baseCommitSha: null,
      stuckKillCount: 0,
      recoveryRetryCount: null,
      nextRecoveryAt: null,
    });
    await deps.taskStore.moveTask(taskId, "todo");
    return toResult(deps.taskStore, taskId);
  }

  conflict("retry", task);
}
