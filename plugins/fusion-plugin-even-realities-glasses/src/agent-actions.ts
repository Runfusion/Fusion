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

async function isInPlanningLane(
  taskStore: AgentActionDeps["taskStore"],
  task: TaskRecord,
): Promise<boolean> {
  const column = String((task as { column?: unknown }).column ?? "");
  let lanes: { intake?: string; hold?: string } | undefined;
  try {
    lanes = await resolveTaskLifecycleColumns(taskStore as never, String(task.id));
  } catch {
    /* narrowed plugin store cannot resolve a workflow */
  }
  if (column === lanes?.intake || column === lanes?.hold) return true;
  /*
  ADDITIVE, not a fallback. `resolveTaskLifecycleColumns` is TOTAL — every failure
  path returns the default coding IR rather than throwing — so an "else legacy" branch
  is dead code and a pre-U11 row in `triage` would simply be refused. Learned the same
  way twice on this program: the resolver never says "I don't know".

  KNOWN LIMITATION, stated rather than faked: this only resolves intake/hold, so it
  cannot tell "the workflow does not use `triage`" from "the workflow uses `triage` as
  its REVIEW lane". A custom workflow doing the latter would have a review-lane card
  accepted here. I wrote a guard for that and it reduced to `&& false` — it cannot be
  written without resolving every role, which needs a wider store surface than
  `PluginContext["taskStore"]` exposes. Left as a limitation in the same spirit as the
  two `Intentional v1 limitation` notes already in this file, rather than shipped as a
  check that does nothing. Blast radius is a plugin-surface action on a workflow that
  reuses a legacy id for a non-planning role; the engine-side equivalents (#2593,
  #2602) do scope it, because there the whole IR is in reach.
  */
  return LEGACY_PLANNING_IDS.has(column);
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
  if (!(await isInPlanningLane(deps.taskStore, task)) || START_WORK_BLOCKED_STATUSES.has(String(task.status))) {
    conflict("start-work", task);
  }
  // Intentional v1 limitation: plugin cannot import engine allocator, so moveTask runs without allocateWorktree.
  await deps.taskStore.moveTask(taskId, "in-progress");
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
  if (!(await isInPlanningLane(deps.taskStore, task)) || task.status !== "awaiting-approval") {
    conflict("approve-plan", task);
  }
  await deps.taskStore.moveTask(taskId, "todo");
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

  if (
    (await isInPlanningLane(deps.taskStore, task)) &&
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
