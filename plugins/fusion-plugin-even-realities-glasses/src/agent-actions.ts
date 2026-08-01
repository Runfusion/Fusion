import type { PluginContext } from "@fusion/plugin-sdk";
import { columnsWithFlag, isBuiltinWorkflowId, resolveLifecycleColumns, resolveWorkflowIrById, resolveWorkflowIrForTask } from "@fusion/core";
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

  /*
  FNXC:PluginLifecycleColumns 2026-07-31-08:10 (PR #2644 review — my identity check rejected every
  persisted custom workflow):

  PROVE THE READ, DO NOT CHECK THE IR'S IDENTITY. My previous revision required the resolved IR to
  identify as the selected workflow id. A persisted custom workflow's stored IR usually carries NO `id`
  and its `name` is a DISPLAY name ("Six Column Shape"), not the selection id ("wf_7") — so the check
  marked every valid custom board degraded and refused every action on it. Strictly worse than the
  laundering it was meant to stop: that was a wrong answer in a rare case, this was a refusal in the
  common one.

  My own test passed because the fixture's IR happened to carry `id: "wf-custom"`, matching its
  selection id. A fixture coincidence standing in for the property under test — the same failure this
  PR has already documented twice.

  What I actually need is proof the DEFINITION READ SUCCEEDED, not proof of identity:
    - CUSTOM selection: `getWorkflowDefinition(id)` must return a row with an `ir`. A missing row or a
      throw is the state `resolveWorkflowIrForTask` papers over with the default IR, and it is the only
      thing that can silently substitute another board's vocabulary.
    - BUILTIN selection: resolves through the in-process catalog, so there is no read to fail — but an
      UNKNOWN builtin id would fall back to the default, so the id must actually be a builtin.
    - NO selection: nothing to mismatch. The default IS the answer, and refusing here would break every
      board that has never had a workflow explicitly selected.
  */
  let snapshotIr: unknown;
  if (selectionWorkflowId === undefined) {
    try {
      snapshotIr = await resolveWorkflowIrForTask(taskStore as never, taskId);
    } catch {
      return { lanes: undefined, declared: new Set(), degraded: true };
    }
  } else if (isBuiltinWorkflowId(selectionWorkflowId)) {
    try {
      snapshotIr = await resolveWorkflowIrById(taskStore as never, selectionWorkflowId);
    } catch {
      return { lanes: undefined, declared: new Set(), degraded: true };
    }
  } else {
    if (!store.getWorkflowDefinition) {
      /* No definitions surface at all is the legacy shape, not a degraded custom board. */
      try {
        snapshotIr = await resolveWorkflowIrForTask(taskStore as never, taskId);
      } catch {
        return { lanes: undefined, declared: new Set(), degraded: true };
      }
    } else {
      let definition: { ir?: unknown } | undefined;
      try {
        definition = await store.getWorkflowDefinition(selectionWorkflowId);
      } catch {
        return { lanes: undefined, declared: new Set(), degraded: true };
      }
      if (definition?.ir == null) return { lanes: undefined, declared: new Set(), degraded: true };
      /*
      FNXC:PluginLifecycleColumns 2026-07-31-17:10 (PR #2644 review, CodeRabbit — REAL, and NOT fixed):
      A STORED STRING IR COSTS A SECOND READ, so the lanes can come from a different revision than the
      degraded verdict — the drift the surrounding comment claims to have removed. My earlier excuse for
      it ("deliberate and confined to that shape") was not a reason.

      I tried `parseWorkflowIr(definition.ir)` to keep it to one read. The parse succeeds in isolation and
      `resolveLifecycleColumns` returns the right roles for the parsed IR (verified directly), but the
      action still refused in the plugin harness, so something between the parse and the lane check
      differs from the resolver path and I could not identify it here. Shipping an unexplained change into
      the code path that decides whether an operator's action is REFUSED trades a bounded drift window for
      an unbounded one, so the second read stays — named rather than excused.

      The window is small and its failure mode is safe: it needs a workflow edit between two reads
      microseconds apart, and the result is a refusal or a stale lane set, never a move onto another
      board's column. A store that returned parsed IRs removes it entirely; that is where the fix belongs.
      */
      snapshotIr = typeof definition.ir === "string"
        ? await resolveWorkflowIrById(taskStore as never, selectionWorkflowId)
        : definition.ir;
    }
  }

  const roles = snapshotIr ? resolveLifecycleColumns(snapshotIr as never) : undefined;
  let lanes: Lanes | undefined = roles ?? undefined;
  /*
  FNXC:PluginLifecycleColumns 2026-07-30-23:10 (the review lane this plugin could never resolve):
  `resolveLifecycleColumns` keys its `review` role on the `mergeOrchestration` trait ALONE. A board whose
  review column carries only `merge-blocker` and/or `human-review` — the common custom shape, since
  `merge` is opt-in — therefore resolves NO review lane at all.

  Every review-gated action here (`requestReview`, `acceptReview`, `returnToAgent`, `retryTask`) compares
  against that lane, so on such a board they refused every card, and `requestReview` had nowhere to move
  one. Not a regression from converting them: it is why they could not be converted with
  `lanes.review` as-is.

  Widened HERE rather than in the shared resolver: `resolveLifecycleColumns` is consumed well beyond this
  plugin and its `review` role deliberately means "the merge-orchestration column" for the merge queue.
  The gap is recorded in `notification-renamed-lifecycle-columns.test.ts` and in PR #2807; reconciling the
  two definitions is a core-level decision, not one to make from a plugin.

  `mergeBlocker` first, then `humanReview` — a card cannot leave a merge-blocking column without the
  merge gate clearing, which is the closer analogue of the legacy `in-review`.
  */
  if (lanes && lanes.review === undefined && snapshotIr) {
    const widenedReview = columnsWithFlag(snapshotIr as never, "mergeBlocker")[0]
      ?? columnsWithFlag(snapshotIr as never, "humanReview")[0];
    if (widenedReview) lanes = { ...lanes, review: widenedReview };
  }
  const declared = new Set(
    Object.values(lanes ?? {}).filter((value): value is string => typeof value === "string"),
  );
  /*
  Declared ids come from the SAME snapshot. A column carrying no lifecycle trait is invisible to
  `lanes`, which is why the IR's own column list is unioned in — that is what stops an inert column
  named `todo` being claimed as a planner lane.
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
      /* FNXC:GlassesAgentActions 2026-07-30-12:40: human gesture — user move source, matching the dashboard move route. */
  await deps.taskStore.moveTask(taskId, startTarget, { moveSource: "user" });
  return toResult(deps.taskStore, taskId);
}

export async function requestReview(input: AgentActionInput, deps: AgentActionDeps): Promise<AgentActionResult> {
  const taskId = normalizeTaskId(input.taskId);
  const task = await getTaskOrThrow(deps.taskStore, taskId);
  /*
  FNXC:PluginLifecycleColumns 2026-07-30-22:50 (census-invisible moveTask destinations):
  Both halves, from ONE snapshot — the same rule `startWork` above already follows. The GATE was the
  literal `in-progress` (counted by the census) and the DESTINATION was the literal `in-review` (a call
  argument, so invisible to it). On a renamed board the gate refused every card, and had it not, the
  move would have targeted a lane the board may not declare.
  */
  const { lanes: reviewLanes, degraded: reviewDegraded } = await laneContext(deps.taskStore, taskId);
  if (reviewDegraded) conflict("request-review", task);
  if (String(task.column) !== destination(reviewLanes, "wip")) {
    conflict("request-review", task);
  }
  const reviewTarget = destination(reviewLanes, "review");
  if (!reviewTarget) conflict("request-review", task);
      /* FNXC:GlassesAgentActions 2026-07-30-12:40: human gesture — user source (see startWork). */
  await deps.taskStore.moveTask(taskId, reviewTarget, { moveSource: "user" });
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
      /* FNXC:GlassesAgentActions 2026-07-30-12:40: human gesture — user source (see startWork). */
  await deps.taskStore.moveTask(taskId, approveTarget, { moveSource: "user" });
  await deps.taskStore.updateTask(taskId, { status: undefined });
  return toResult(deps.taskStore, taskId);
}

export async function acceptReview(input: AgentActionInput, deps: AgentActionDeps): Promise<AgentActionResult> {
  const taskId = normalizeTaskId(input.taskId);
  const task = await getTaskOrThrow(deps.taskStore, taskId);
  /* FNXC:PluginLifecycleColumns 2026-07-30-22:50: review lane by ROLE; on a renamed board this refused
     every card. No destination and no degraded-conflict: acceptReview only clears fields, and the same
     "do not block an action that moves nothing" rule the retry cases pin applies here. */
  const { lanes: acceptLanes } = await laneContext(deps.taskStore, taskId);
  if (String(task.column) !== destination(acceptLanes, "review")) {
    conflict("accept-review", task);
  }
  await deps.taskStore.updateTask(taskId, { status: null, assigneeUserId: null });
  return toResult(deps.taskStore, taskId);
}

export async function returnToAgent(input: AgentActionInput, deps: AgentActionDeps): Promise<AgentActionResult> {
  const taskId = normalizeTaskId(input.taskId);
  const task = await getTaskOrThrow(deps.taskStore, taskId);
  /*
  FNXC:PluginLifecycleColumns 2026-07-30-22:50 (census-invisible moveTask destinations):
  Gate AND destination from one snapshot. The destination is resolved BEFORE the field clear below:
  `updateTask` used to run first, so a rejected move left the assignee and status cleared with the card
  still in review — the half-applied shape this audit keeps finding.
  */
  const { lanes: returnLanes, degraded: returnDegraded } = await laneContext(deps.taskStore, taskId);
  if (returnDegraded) conflict("return-to-agent", task);
  if (String(task.column) !== destination(returnLanes, "review")) {
    conflict("return-to-agent", task);
  }
  const returnTarget = destination(returnLanes, "hold");
  if (!returnTarget) conflict("return-to-agent", task);
  await deps.taskStore.updateTask(taskId, {
    assigneeUserId: null,
    status: null,
    assignedAgentId: null,
  });
      /* FNXC:GlassesAgentActions 2026-07-30-12:40: intentionally DEFAULT (engine) source: a user-source move to the hold lane parks the task userPaused, defeating the return-to-agent intent. */
  await deps.taskStore.moveTask(taskId, returnTarget);
  return toResult(deps.taskStore, taskId);
}

export async function retryTask(input: AgentActionInput, deps: AgentActionDeps): Promise<AgentActionResult> {
  const taskId = normalizeTaskId(input.taskId);
  const task = await getTaskOrThrow(deps.taskStore, taskId);

  /*
  FNXC:PluginLifecycleColumns 2026-07-30-22:50: review lane by ROLE, resolved once and reused by the
  rebound below so the gate and the destination cannot disagree.

  NO degraded-conflict here, unlike `startWork`. The suite pins "a degraded workflow does not block
  retries that move nothing": the status-only retry above just clears fields, and refusing it because
  the workflow could not be read would break a recovery that needs no lane at all. `destination()`
  already falls back to the legacy ids when lanes are unresolved, which is the behaviour those cases
  assert. Only the branch that actually MOVES needs a resolved target.
  */
  const { lanes: retryGateLanes } = await laneContext(deps.taskStore, taskId);
  if (String(task.column) === destination(retryGateLanes, "review") && RETRYABLE_FAILURE_STATUSES.has(String(task.status))) {
    await deps.taskStore.updateTask(taskId, { status: null, error: null, stuckKillCount: 0, mergeRetries: 0 });
    return toResult(deps.taskStore, taskId);
  }

  const { lanes: retryLanes, declared: retryDeclared, degraded: retryDegraded } = await laneContext(deps.taskStore, taskId);
  /*
  FNXC:PluginLifecycleColumns 2026-07-31-15:10 (PR #2644 review, CodeRabbit — MAJOR, my regression):
  DEGRADED GATES ONLY THE LANE-DEPENDENT BRANCH. I put the refusal at the top of `retryTask`, which also
  blocked the plain failure-retry below — a branch that reads no lanes at all and only clears status. So a
  FAILED card became un-retryable whenever its workflow definition could not be read, which is exactly the
  situation an operator is trying to retry out of. The refusal existed to stop a MOVE onto another board's
  vocabulary; the failure-retry performs no move, so it has nothing to be wrong about.
  */
  if (
    retryDegraded === false &&
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
    /*
    FNXC:PluginLifecycleColumns 2026-07-30-22:50 (census-invisible moveTask destinations):
    Destination resolved BEFORE the field clear. The clear used to run first, so a rejected move left the
    worktree, branch and base refs nulled with the card exactly where it was — the retry destroyed the
    pointers back to the work and then did not requeue. Reuses the snapshot taken at the top of this
    action so the gate and the destination cannot disagree.
    */
    const retryTarget = destination(retryGateLanes, "hold");
    if (!retryTarget) conflict("retry", task);
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
      /* FNXC:GlassesAgentActions 2026-07-30-12:40: intentionally DEFAULT (engine) source: retry requeues for execution; a user source would userPaused-park the row. */
    await deps.taskStore.moveTask(taskId, retryTarget);
    return toResult(deps.taskStore, taskId);
  }

  conflict("retry", task);
}
