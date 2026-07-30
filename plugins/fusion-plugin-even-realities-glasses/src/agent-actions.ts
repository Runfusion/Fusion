import type { PluginContext } from "@fusion/plugin-sdk";
import { resolveLifecycleColumns, resolveWorkflowIrForTask } from "@fusion/core";
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
 * FNXC:PluginLifecycleColumns 2026-07-30-05:10 (PR #2607 review — greptile P1):
 * Is the card in its workflow's PRE-IMPLEMENTATION lane?
 *
 * The legacy acceptance is SCOPED: a legacy id counts only when the workflow does not
 * assign it to ANY role. Unscoped, a workflow that names its review or wip lane
 * `triage`/`todo` would have those cards authorized as planning work — greptile's
 * finding, and the same over-reach caught on #2593 and #2602. Scoping needs the whole
 * lane set, which is why `laneContext` returns all of it rather than intake/hold only;
 * the earlier version could not express this and said so as a known limitation.
 */
function isInPlanningLane(lanes: Lanes | undefined, column: string, declared: Set<string>): boolean {
  if (column === lanes?.intake || column === lanes?.hold) return true;
  return LEGACY_PLANNING_IDS.has(column) && !declared.has(column);
}

/**
 * A move target for `role`, or `undefined` when this workflow has no such lane.
 *
 * FNXC:PluginLifecycleColumns 2026-07-30-21:40 (PR #2607 review — FIFTH finding, same rule):
 * THE LEGACY ID IS NOT A CANDIDATE AT ALL once the workflow speaks columns. Every previous
 * revision tried to qualify the fallback — "declared", then "declared and not assigned to another
 * role" — and each qualification left a hole review found: first an aliased review lane named
 * `todo`, then a TRAITLESS parking column named `todo`, which no role check can see because it
 * carries no role.
 *
 * The qualifications were the mistake. If `laneContext` returned a lane set, the workflow HAS a
 * column vocabulary, so "no column carries the hold trait" is a complete answer: there is nowhere
 * legitimate to send the card and the action must refuse. A column merely NAMED `todo` implements
 * nothing.
 *
 * The legacy id survives in exactly one case — `lanes` is undefined, meaning the workflow could not
 * be resolved at all. There is no basis to decide then, and a pre-U11 board really does use these
 * ids, so refusing would break the migration this program is mid-way through.
 *
 * Five attempts at one rule, so it is worth stating plainly: A LEGACY ID IS NOT A ROLE, and
 * "declared" is not "declared FOR THIS ROLE" — including when it is declared for no role at all.
 */
function destination(
  lanes: Lanes | undefined,
  role: keyof typeof LEGACY_DESTINATIONS,
): string | undefined {
  if (!lanes) return LEGACY_DESTINATIONS[role];
  return lanes[role];
}


/**
 * FNXC:PluginLifecycleColumns 2026-07-30-07:14: one resolve per action. Both the gate
 * (is the card in a planning lane?) and the destination (where does it go?) need the
 * SAME declared-column set — resolving them separately is how the two halves drifted
 * out of agreement in the first place (PR #2607: gates converted, destinations literal).
 */
async function laneContext(
  taskStore: AgentActionDeps["taskStore"],
  taskId: string,
): Promise<{ lanes: Lanes | undefined; declared: Set<string>; degraded: boolean }> {
  /*
  FNXC:PluginLifecycleColumns 2026-07-31-02:25 (PR #2644 review, greptile P1):
  ONE SNAPSHOT PER ACTION. Three helpers used to read the workflow independently — the degraded
  probe, the lane resolution, and the declared-column read — so a workflow edited or deleted
  mid-action could combine a NOT-degraded verdict with fallback lanes, or lanes from one revision
  with declarations from another. The action then either conflicted on a card that was fine or moved
  it toward a column the current workflow no longer has.

  Same fix as the executor's resume lanes (#2640 review): the two or three halves of one decision
  must read one snapshot. Here that means resolving the IR ONCE and deriving everything from it — the
  degraded verdict included, which is now simply "a selection names a workflow whose definition did
  not come back in THIS read".
  */
  const store = taskStore as unknown as {
    getTaskWorkflowSelectionAsync?: (id: string) => Promise<{ workflowId?: string } | undefined>;
    getTaskWorkflowSelection?: (id: string) => { workflowId?: string } | undefined;
    getWorkflowDefinition?: (id: string) => Promise<{ ir?: unknown } | undefined>;
  };

  let selectionWorkflowId: string | undefined;
  try {
    const selection = (await store.getTaskWorkflowSelectionAsync?.(taskId))
      ?? store.getTaskWorkflowSelection?.(taskId);
    selectionWorkflowId = selection?.workflowId;
  } catch {
    /* Cannot read the selection: treat as degraded below, since a MOVE must not guess. */
    return { lanes: undefined, declared: new Set(), degraded: true };
  }

  const usesCustomDefinition = Boolean(selectionWorkflowId)
    && !selectionWorkflowId!.startsWith("builtin:")
    && Boolean(store.getWorkflowDefinition);

  let definitionIr: unknown;
  if (usesCustomDefinition) {
    try {
      definitionIr = (await store.getWorkflowDefinition!(selectionWorkflowId!))?.ir;
    } catch {
      return { lanes: undefined, declared: new Set(), degraded: true };
    }
    /*
    The custom definition is gone. `resolveTaskLifecycleColumns` would silently hand back the DEFAULT
    coding lanes here, which is indistinguishable from a genuinely default board — so refuse rather
    than act on another board's vocabulary.
    */
    if (definitionIr == null) return { lanes: undefined, declared: new Set(), degraded: true };
  }

  /*
  FNXC:PluginLifecycleColumns 2026-07-31-02:50: lanes are derived from the IR THIS function already
  read, not from a second `resolveTaskLifecycleColumns` call. My first pass at "one snapshot" still
  made two reads — the explicit one plus the one inside the resolver — and my own counting test caught
  it. Two reads is two snapshots however carefully the first one is checked.
  */
  const snapshotIr = usesCustomDefinition
    ? definitionIr
    : await resolveWorkflowIrForTask(taskStore as never, taskId).catch(() => undefined);
  const roles = snapshotIr ? resolveLifecycleColumns(snapshotIr as never) : undefined;
  const lanes: Lanes | undefined = roles ?? undefined;
  const declared = new Set(
    Object.values(lanes ?? {}).filter((value): value is string => typeof value === "string"),
  );
  /*
  Declared ids come from the SAME read that proved the definition exists, not from a second lookup.
  A column carrying no lifecycle trait is invisible to `lanes`, which is why the IR's own column list
  is unioned in — that is what stops an inert column named `todo` being claimed as a planner lane.
  */
  for (const column of (snapshotIr as { columns?: Array<{ id?: unknown }> } | undefined)?.columns ?? []) {
    if (typeof column?.id === "string") declared.add(column.id);
  }

  return { lanes, declared, degraded: false };
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
  const { lanes: startLanes, declared: startDeclared, degraded: startDegraded } = await laneContext(deps.taskStore, taskId);
  if (startDegraded) conflict("start-work", task);
  if (
    !isInPlanningLane(startLanes, String(task.column), startDeclared)
    || START_WORK_BLOCKED_STATUSES.has(String(task.status))
  ) {
    conflict("start-work", task);
  }
  const startTarget = destination(startLanes, "wip");
  if (!startTarget) conflict("start-work", task);
  // Intentional v1 limitation: plugin cannot import engine allocator, so moveTask runs without allocateWorktree.
  await deps.taskStore.moveTask(taskId, startTarget);
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
  const { lanes: approveLanes, declared: approveDeclared, degraded: approveDegraded } = await laneContext(deps.taskStore, taskId);
  if (approveDegraded) conflict("approve-plan", task);
  if (
    !isInPlanningLane(approveLanes, String(task.column), approveDeclared)
    || task.status !== "awaiting-approval"
  ) {
    conflict("approve-plan", task);
  }
  const approveTarget = destination(approveLanes, "hold");
  if (!approveTarget) conflict("approve-plan", task);
  await deps.taskStore.moveTask(taskId, approveTarget);
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

  const { lanes: retryLanes, declared: retryDeclared, degraded: retryDegraded } = await laneContext(deps.taskStore, taskId);
  if (retryDegraded) conflict("retry", task);
  if (
    isInPlanningLane(retryLanes, String(task.column), retryDeclared) &&
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
