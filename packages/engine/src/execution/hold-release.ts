/**
 * Hold/release sweep — the generalized scheduler (U6, KTD-10, R3 behavior half).
 *
 * Flag-ON, the scheduler's poll becomes a *hold/release sweep*: for each
 * workflow in use by live tasks, it finds cards resting at `hold`-trait columns
 * and evaluates their release condition:
 *
 *   - `manual`         — released ONLY by an explicit {@link promoteHeldTask}
 *                        call (U9's promote endpoint / CLI). The sweep never
 *                        auto-releases a manual hold.
 *   - `external-event` — released ONLY by {@link releaseHeldTaskByEvent} (a
 *                        webhook/API release, same shape as manual + an event
 *                        tag).
 *   - `timer`          — released when the injected clock passes the hold's
 *                        deadline (`columnMovedAt + durationMs`, or an explicit
 *                        `deadlineAt`). Fake-timer friendly (FN-5048): the clock
 *                        is injected, never `Date.now()` baked in.
 *   - `capacity`       — released when a downstream capacity (`wip`) column has a
 *                        free slot (same counting rules as the in-txn check).
 *   - `dependency`     — released when the card's dependencies are satisfied
 *                        (KTD-5: dependency task's column has the `complete`
 *                        trait flag in ITS resolved workflow; FN-5719 dual-accept
 *                        also honors the legacy completion signal, logging an
 *                        audit-diff when the two disagree).
 *
 * Eligible cards move via `store.moveTask(..., { moveSource: "scheduler" })`.
 * A scheduler move bypasses trait guards (it is substrate-driven) but the in-txn
 * capacity check is NOT a guard — it still runs (KTD-10), so two holds racing
 * into one slot serialize: exactly one commits, the other rejects with
 * `capacity-exhausted` and retries next sweep.
 *
 * Reservation ordering (KTD-10): for releases into a processing (capacity)
 * column, the sweep reserves worktree + semaphore slots BEFORE issuing the move
 * and releases the reservation if the move rejects on capacity — a card is never
 * moved into a column it cannot actually start in, and a semaphore-exhausted
 * interleaving leaves the card held with no commit.
 */

import {
  resolveColumnCapacity,
  resolveWipBudgetColumns,
  resolveColumnFlags,
  resolveColumnAdjacency,
  PLAN_REVIEW_GROUP_ID,
  ACTIVE_WORKFLOW_WORK_ITEM_STATES,
  resolveCapacityPoolId,
  TransitionRejectionError,
  resolveWorkflowIrForTask,
  isUnplannedSeedPrompt,
  isDuplicateRedirectOnlyPrompt,
  isWorkflowOptionalGroupEnabled,
  resolveEffectiveAutoMerge,
  isTaskBlockedOnApproval,
  isPlanReviewSatisfied,
  type TaskStore,
  type Task,
  type WorkflowIr,
  type WorkflowIrNode,
  type WorkflowIrV2,
  type WorkflowIrColumn,
} from "@fusion/core";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { schedulerLog } from "../logger.js";
import { getPromptPath } from "./spec-staleness.js";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { evaluateStrandedHoldContinuation } from "../plan-review-continuation.js";

// FNXC:StrandedHoldContinuation 2026-07-26-14:15:
// A genuine stranded-plan fault is warned once per held location; ordinary
// unplanned cards remain quiet even when the release sweep revisits them.
const strandedHoldWarningMemo = new Set<string>();

/** A reservation handle returned by {@link HoldReleaseDeps.reserveSlot}. The
 *  sweep calls `release()` if the subsequent move rejects on capacity. */
export interface SlotReservation {
  release(): void;
}

/** Injected dependencies so the sweep stays unit-testable with fake timers and
 *  without real worktree/session allocation. */
export interface HoldReleaseDeps {
  /** Monotonic clock (ms). Inject a fake-timer-driven clock in tests; production
   *  passes `() => Date.now()`. */
  now: () => number;
  /**
   * Reserve a worktree + semaphore slot for a card about to be released into a
   * processing column (KTD-10 reservation-first). Returns `null` when no slot
   * could be reserved (e.g. semaphore exhausted) — the sweep then leaves the
   * card held without issuing a move. Returns a {@link SlotReservation} whose
   * `release()` the sweep calls if the move rejects on capacity.
   *
   * Optional: when absent, releases into processing columns proceed without a
   * reservation (the in-txn capacity check still arbitrates), which is the
   * default-workflow legacy parity path where the scheduler dispatch loop owns
   * worktree allocation via `allocateWorktree`.
   */
  reserveSlot?: (task: Task, targetColumn: string) => SlotReservation | null | Promise<SlotReservation | null>;
  /** Allocate a worktree path for a release into a processing column (passed
   *  through to `moveTask`'s `allocateWorktree`). */
  allocateWorktree?: (task: Task, reservedNames: Set<string>) => string | null;
  /** Optional third leg of the canonical liveness triple for diagnostics. */
  isTaskActive?: (taskId: string) => boolean;
}

/** Outcome of one sweep pass (for tests + observability). */
export interface HoldReleaseResult {
  released: string[];
  /** taskId → reason it stayed held this pass. */
  held: Array<{ taskId: string; reason: string }>;
}

// ── Workflow IR resolution (read-only) ────────────────────────────────────────
// The selection → builtin/custom → default rule lives in @fusion/core's
// resolveWorkflowIrForTask (GitHub #1402); the optional per-sweep irCache Map is
// threaded straight through.

async function effectiveWorkflowId(store: TaskStore, taskId: string): Promise<string> {
  try {
    return resolveCapacityPoolId((await store.getTaskWorkflowSelectionAsync(taskId))?.workflowId);
  } catch {
    /* An unreadable selection is indistinguishable from no selection for pooling
       purposes, so it takes the same bucket rather than a second convention. */
    return resolveCapacityPoolId(undefined);
  }
}

function findColumn(ir: WorkflowIr, columnId: string): WorkflowIrColumn | undefined {
  if (ir.version !== "v2") return undefined;
  return (ir as WorkflowIrV2).columns.find((c) => c.id === columnId);
}

/** The hold trait config on a column, if any. */
function resolveHoldConfig(column: WorkflowIrColumn): Record<string, unknown> | undefined {
  const flags = resolveColumnFlags(column);
  if (!flags.hold) return undefined;
  const ct = column.traits.find((t) => t.trait === "hold");
  return ct?.config ?? {};
}

/** True when the card currently rests at a hold column. */
function isHeldTask(ir: WorkflowIr, task: Task): boolean {
  const column = findColumn(ir, task.column);
  if (!column) return false;
  return resolveColumnFlags(column).hold === true;
}

/**
 * FNXC:WorkflowScheduling 2026-07-07-00:00:
 * A card must never be released into a processing (`countsTowardWip`) column
 * while it is unplanned — regardless of which literal column id it currently
 * rests in. "Unplanned" means: `status === "planning"` (specified-in-place),
 * OR the card's PROMPT.md still equals the bootstrap stub AND the card is
 * resident in the legacy `todo` column OR a column carrying the `intake`
 * trait. Keying the stub check on the literal `"todo"` string alone misses a
 * custom workflow whose intake/planning column is renamed (`ideas`, `Inbox`,
 * default-workflow's renamed "Planning") — this is the general, trait-based
 * predicate shared by the sweep (`issueRelease`) and the scheduler's
 * `reserveSlot` guard (FN-7648) so every release surface (sweep, explicit
 * `promoteHeldTask`, `releaseHeldTaskByEvent`) enforces the same invariant.
 */
/**
 * FNXC:PlanReview 2026-07-21-12:20:
 * Locate a Plan Review node placed before WIP. Disabled optional groups still
 * traverse this node, allowing the graph to persist the same generic capacity
 * continuation without invoking a reviewer.
 */
export function resolvePreReleasePlanReviewNode(ir: WorkflowIr): WorkflowIrNode | undefined {
  const planReviewNode = ir.nodes.find((n) => n.id === PLAN_REVIEW_GROUP_ID);
  if (!planReviewNode?.column) return undefined;
  const column = findColumn(ir, planReviewNode.column);
  if (!column) return undefined;
  // Post-release gate (plan-review lives in a wip column): do not hold release.
  if (resolveColumnFlags(column).countsTowardWip === true) return undefined;
  return planReviewNode;
}

/*
FNXC:PlanningDependencyReseed 2026-08-04-02:14:
A release refusal is otherwise invisible after scheduler dispatch returns early.
Hash only durable state that changes the planning/Plan-Review episode; the core
store atomically claims this project/task episode and appends one task-log entry.
*/
export async function checkAndRecordUnplannedExecutionBlock(
  store: TaskStore,
  task: Task,
  ir: WorkflowIr,
): Promise<void> {
  const recorder = (store as Partial<Pick<TaskStore, "checkAndRecordUnplannedExecutionBlock">>).checkAndRecordUnplannedExecutionBlock;
  if (!recorder) return;
  const planReviewNode = resolvePreReleasePlanReviewNode(ir)?.id ?? "none";
  let promptContent = typeof task.prompt === "string" ? task.prompt : "";
  const tasksDir = typeof store.getTasksDir === "function" ? store.getTasksDir() : undefined;
  if (tasksDir) {
    try {
      promptContent = await readFile(getPromptPath(tasksDir, task.id), "utf8");
    } catch {
      promptContent = "";
    }
  }
  const promptMarker = promptContent.length > 0
    ? createHash("sha256").update(promptContent).digest("hex")
    : "missing";
  const dependencies = [...(task.dependencies ?? [])].sort();
  const episode = createHash("sha256").update(JSON.stringify({
    planReviewNode,
    promptMarker,
    dependencies,
    status: task.status ?? null,
    handoffFingerprint: task.approvedPlanFingerprint ?? null,
  })).digest("hex");
  try {
    await recorder.call(store, task.id, episode);
  } catch (error) {
    // The gate is safety-critical; its diagnostic must not turn an otherwise-safe refusal into a dispatch failure.
    schedulerLog.warn(`Could not persist unplanned dispatch refusal for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function isUnplannedForExecution(store: TaskStore, task: Task, ir: WorkflowIr): Promise<boolean> {
  /*
  FNXC:PlanReview 2026-07-19-00:40 (U3):
  The graph is the SOLE Plan Review owner (triage's out-of-graph gate is deleted).
  When a workflow places the plan-review node in a PRE-RELEASE column (the
  benchmark's Plan Review in the Todo hold column — i.e. NOT a wip column), the
  card must not release into execution until the graph has reached its durable
  capacity boundary. Releasing first would skip the gate. This does not fire
  when Plan Review already lives in a WIP column.
  */
  /*
  FNXC:PlanReview 2026-07-26-14:05:
  The gate is PLAN-IN-PLACE only: it applies when Plan Review runs in the very column the card is
  held in (Coding (Ideas) / the benchmark's Plan Review in Todo), which is the same condition the
  other two consumers of this resolver already require (`seedPreReleasePlanReviewContinuation`,
  `evaluateStrandedHoldContinuation`). Without the column check, moving the default workflow's Plan
  Review out of the wip column into the planning column turned "non-wip" into "pre-release" for every
  card in Todo — including cards whose graph never routes through Todo at all — and the capacity
  sweep stopped releasing them (no continuation for a boundary they never reach). A review node in an
  upstream column the card has already left is not something this sweep gates on.
  */
  /*
  FNXC:PlanReview 2026-07-26-17:10:
  The gate also requires Plan Review to be ENABLED for this task. It exists to stop a card entering
  implementation before its plan gate ran; a task whose plan-review group is toggled OFF has no such
  gate, and holding it produced a deadlock — nothing would ever record the evidence the hold was
  waiting for.
  */
  const preReleaseReview = resolvePreReleasePlanReviewNode(ir);
  const preReleaseReviewEnabled = preReleaseReview
    ? isWorkflowOptionalGroupEnabled(
      task.enabledWorkflowSteps,
      preReleaseReview.id,
      (preReleaseReview.config as { defaultOn?: boolean } | undefined)?.defaultOn ?? false,
    )
    : false;
  if (preReleaseReview && preReleaseReviewEnabled && preReleaseReview.column === task.column) {
    // Compatibility for tasks planned before durable continuations existed and
    // for narrow store adapters that expose only the legacy review result.
    const legacySatisfied = task.workflowStepResults?.some(isPlanReviewSatisfied);
    if (!legacySatisfied) {
      if (typeof store.listWorkflowWorkItemsForTask !== "function") return true;
      // FNXC:StrandedHoldContinuation 2026-07-26-15:45:
      // FN-8592 defines graph idleness over every active continuation kind;
      // filtering to task continuations would allow a live non-task run to be
      // mistaken for an idle graph and receive a duplicate plan-review seed.
      const continuations = await store.listWorkflowWorkItemsForTask(task.id);
      const active = continuations.filter((item) => ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state));
      // Readiness is represented by the graph's durable boundary continuation,
      // not by a special-case review result. Optional groups that are disabled
      // are still traversed and therefore reach the same capacity boundary.
      const readyAtCapacityBoundary = active.some(
        (item) => item.waitReason === "capacity" && item.sourceColumn === task.column,
      );
      if (!readyAtCapacityBoundary) return true;
    }
  }
  // Still-live triage/executor statuses (kept, not triage-plan-review-owned):
  // `planning` = triage is actively writing PROMPT.md; `needs-replan` = the
  // executor's graph replan rebound parked the card for another planning pass.
  if (task.status === "planning") return true;
  /*
  FNXC:WorkflowScheduling 2026-07-13-11:20:
  `needs-replan` is unplanned-by-decree: Plan Review rejected the current PROMPT.md and the
  plan-in-place rebound parks the card in "todo" awaiting the triage service's replan. Without
  this check the capacity-hold sweep read the real (rejected) prompt, judged the card planned,
  and released it into execution — re-running the plan the reviewer just rejected and racing
  triage, which only flips the dispatch-blocking `planning` status after acquiring its
  semaphore slot.
  */
  if (task.status === "needs-replan") return true;

  /*
  FNXC:DuplicateIntake 2026-08-09-01:02:
  The title is already durable task state, so its exact redirect must hold capacity before the
  store capability check and prompt read. This keeps title-only redirects non-dispatchable even
  for adapters without task directories or during prompt I/O failures.
  */
  if (isDuplicateRedirectOnlyPrompt(null, task.title)) return true;

  /*
  FNXC:WorkflowScheduling 2026-07-19-02:10 (U4):
  Gate the bootstrap-stub check on the TRAIT, not the literal "todo" id. An
  unplanned card rests in a pre-wip column — an `intake` column (Ideas / the
  renamed "Planning") OR a `hold` column (the default workflow's `todo` is
  hold+reset-on-entry). Keying the OR-branch on `task.column === "todo"` both
  hard-coded the default id and missed a renamed intake column (FN-7648); the
  trait predicate covers every variant, so the literal-todo branch is removed.
  */
  const currentColumn = findColumn(ir, task.column);
  const currentFlags = currentColumn ? resolveColumnFlags(currentColumn) : {};
  if (currentFlags.intake !== true && currentFlags.hold !== true) return false;

  if (typeof store.getTasksDir !== "function") return false;
  try {
    const promptContent = await readFile(getPromptPath(store.getTasksDir(), task.id), "utf-8");
    // isUnplannedSeedPrompt also matches the refineTask seed shape (no task-id prefix),
    // so an unplanned refinement promoted out of a manual intake is held for planning
    // instead of releasing into execution with a feedback-only prompt.
    /*
    FNXC:DuplicateIntake 2026-08-01-19:24:
    A DUPLICATE-only PROMPT is unplanned for execution (FN-8704). Hold capacity release
    until triage writes a real plan — filesystem validation is the twin of this check.
    */
    if (isDuplicateRedirectOnlyPrompt(promptContent, task.title)) return true;
    return isUnplannedSeedPrompt(promptContent, task.id, task.title, task.description);
  } catch {
    // Missing prompt is handled by filesystem validation elsewhere; do not block on it here.
    return false;
  }
}

/**
 * Resolve the release target column for a held card.
 *
 * For `capacity` holds, the target is the nearest downstream column (by the
 * workflow's column adjacency, breadth-first from the hold column) that carries
 * a capacity (`wip`) trait — for the default workflow this is `in-progress`.
 * For other release kinds the target is the first adjacency neighbor that is not
 * the hold column itself (the forward step out of the hold).
 */
function resolveReleaseTarget(ir: WorkflowIr, fromColumn: string, preferCapacity: boolean): string | undefined {
  const v2 = ir as WorkflowIrV2;
  const orderedIds = Array.isArray(v2.columns) ? v2.columns.map((c) => c.id) : [];
  const fromIdx = orderedIds.indexOf(fromColumn);
  const adjacency = resolveColumnAdjacency(ir);
  const neighbors = adjacency.get(fromColumn) ?? [];

  if (preferCapacity) {
    // Walk FORWARD in declared order for the nearest capacity-bearing column;
    // the hold releases downstream, never backward.
    for (let i = fromIdx + 1; i < orderedIds.length; i++) {
      const col = findColumn(ir, orderedIds[i]);
      if (col && resolveColumnFlags(col).countsTowardWip && neighbors.includes(orderedIds[i])) {
        return orderedIds[i];
      }
    }
    // No directly-adjacent capacity column: fall back to the nearest forward
    // capacity column reachable via adjacency BFS.
    const seen = new Set<string>([fromColumn]);
    const queue = [...neighbors];
    while (queue.length > 0) {
      const candidate = queue.shift()!;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const col = findColumn(ir, candidate);
      if (col && resolveColumnFlags(col).countsTowardWip) return candidate;
      for (const next of adjacency.get(candidate) ?? []) {
        if (!seen.has(next)) queue.push(next);
      }
    }
  }

  // Forward neighbor (declared-order next) if it is adjacent; else any neighbor
  // that is forward in declared order; else the first neighbor.
  const forwardId = fromIdx >= 0 ? orderedIds[fromIdx + 1] : undefined;
  if (forwardId && neighbors.includes(forwardId)) return forwardId;
  const forwardNeighbor = neighbors.find((n) => orderedIds.indexOf(n) > fromIdx);
  if (forwardNeighbor) return forwardNeighbor;
  return neighbors.find((n) => n !== fromColumn);
}

// ── Dependency satisfaction (KTD-5 + FN-5719 dual-accept) ─────────────────────

/*
FNXC:WorkflowLifecycleColumns 2026-07-28-00:20 (Phase B / slice B2) DELIBERATE-LITERAL:
Reviewed as a U5 conversion candidate and deliberately NOT converted. This is the LEGACY
half of the FN-5719 dual-accept pair in `dependencySatisfied` below: the trait half already
handles renamed workflows, and this half exists specifically to honor the pre-trait
completion signal and to log a `merge:dependency-parity-diff` audit event when the two
disagree. Converting it to traits would make both halves compute the same answer — deleting
the compatibility signal AND the divergence detector in one move, while looking like a
cleanup. The literal IS the semantic here.

Its removal is the dual-accept window CLOSING, which is U12's call, not a Phase B refactor.
Recorded for the U12 literal ratchet's allowlist; that ratchet does not exist in the tree
yet, so grep `DELIBERATE-LITERAL` to enumerate the sites it must admit.
*/
/** Legacy completion signal: dependency's column is a terminal/handoff column. */
function legacyDependencySatisfied(dep: Task): boolean {
  return dep.column === "done" || dep.column === "in-review" || dep.column === "archived";
}

/**
 * KTD-5 dependency satisfaction: the dependency task's current column has the
 * `complete` trait flag in ITS resolved workflow. Dual-accept (FN-5719): the
 * legacy completion signal (done/in-review/archived column, or an accepted
 * completion-handoff marker) is also honored; when the two disagree an
 * audit-diff event is logged.
 */
async function dependencySatisfied(store: TaskStore, dep: Task): Promise<boolean> {
  const ir = await resolveWorkflowIrForTask(store, dep.id);
  const column = findColumn(ir, dep.column);
  const completeFlag = column ? resolveColumnFlags(column).complete === true : false;

  let markerAccepted = false;
  try {
    markerAccepted = (await store.getCompletionHandoffAcceptedMarker(dep.id)) !== null;
  } catch {
    markerAccepted = false;
  }
  const legacy = legacyDependencySatisfied(dep) || markerAccepted;

  if (completeFlag !== legacy) {
    try {
      void store.recordRunAuditEvent?.({
        taskId: dep.id,
        agentId: "scheduler",
        runId: `hold-release:${dep.id}`,
        domain: "database",
        mutationType: "merge:dependency-parity-diff",
        target: dep.id,
        metadata: {
          depId: dep.id,
          completeFlagResult: completeFlag,
          legacyResult: legacy,
          source: "hold-release.dependency",
        },
      });
    } catch {
      // Audit is best-effort.
    }
  }
  // Dual-accept: satisfied if EITHER signal says so (the dual-accept window
  // closes at graduation per U12; until then both are accepted).
  return completeFlag || legacy;
}

async function allDependenciesSatisfied(store: TaskStore, task: Task, allTasks: Task[]): Promise<boolean> {
  for (const depId of task.dependencies ?? []) {
    const dep = allTasks.find((t) => t.id === depId);
    if (!dep) continue; // missing dep does not block (matches scheduler posture)
    if (!(await dependencySatisfied(store, dep))) return false;
  }
  return true;
}

// ── Timer release ─────────────────────────────────────────────────────────────

/** Resolve the timer deadline (ms epoch) for a timer hold, or `undefined` if not
 *  resolvable. Supports an explicit `deadlineAt` (ISO or ms) or a relative
 *  `durationMs`/`timerMs` measured from `columnMovedAt`. */
function resolveTimerDeadline(holdConfig: Record<string, unknown>, task: Task): number | undefined {
  const deadlineAt = holdConfig.deadlineAt;
  if (typeof deadlineAt === "number" && Number.isFinite(deadlineAt)) return deadlineAt;
  if (typeof deadlineAt === "string") {
    const parsed = Date.parse(deadlineAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  const duration =
    (typeof holdConfig.durationMs === "number" ? holdConfig.durationMs : undefined) ??
    (typeof holdConfig.timerMs === "number" ? holdConfig.timerMs : undefined);
  if (typeof duration === "number" && Number.isFinite(duration)) {
    const base = Date.parse(task.columnMovedAt ?? task.createdAt);
    if (Number.isFinite(base)) return base + duration;
  }
  return undefined;
}

// ── Capacity availability (same counting rule as the in-txn check) ────────────

/**
 * Count cards occupying the (workflow, column) capacity slot from a task
 * snapshot, mirroring the store's in-txn count: cards in the column now, plus
 * (when countPending) cards mid-`transitionPending` targeting it, scoped to the
 * SAME effective workflow. This is the sweep's *pre-check* — the authoritative
 * arbitration is still the in-txn check, which rejects a losing racer.
 */
function countCapacitySlot(
  allTasks: Task[],
  // Pre-built taskId → effective workflowId map (one pass per sweep) so this
  // counting loop avoids a per-task `effectiveWorkflowId` DB call.
  effectiveWorkflowIdByTask: Map<string, string>,
  // U4/KTD-9: the SET of columns whose occupancy shares one budget with the
  // target (resolveWipBudgetColumns). Two wip columns sharing a `limitSetting`
  // are counted together so the pooled budget cannot silently multiply.
  budgetColumns: ReadonlySet<string>,
  workflowId: string,
  countPending: boolean,
): number {
  let count = 0;
  for (const t of allTasks) {
    if (resolveCapacityPoolId(effectiveWorkflowIdByTask.get(t.id)) !== workflowId) continue;
    if (budgetColumns.has(t.column)) {
      count += 1;
      continue;
    }
    if (!countPending) continue;
    const tp = (t as Task & { transitionPending?: { toColumn?: string } | null }).transitionPending;
    if (tp && typeof tp === "object" && typeof tp.toColumn === "string" && budgetColumns.has(tp.toColumn)) count += 1;
  }
  return count;
}

// ── The sweep ─────────────────────────────────────────────────────────────────

/**
 * Run one hold/release sweep pass for the default workflow-column runtime.
 */
/*
FNXC:HoldReleaseInstrumentation 2026-07-25-14:35:
Operator-reported symptom: "tasks that finish planning and are ready don't move immediately — there
is a long delay." The sweep already logged per-task hold REASONS, but nothing recorded how LONG a
card waited or how long the sweep itself took, so the delay could not be attributed between (a) the
poll cadence, (b) sweep execution cost, and (c) a card legitimately waiting on capacity.

`heldSince` records when each task was first observed held with its current reason. On release the
elapsed time is logged; the entry is dropped when the task releases or stops being held, so the map
tracks only currently-held cards and cannot grow without bound. Reason changes reset the clock, so
"waiting 4m on downstream-full" is never conflated with "waiting 4m on deps-unsatisfied".
*/
const heldSince = new Map<string, { reason: string; sinceMs: number }>();

/** Sweeps slower than this are the delay rather than a symptom of it — log loudly. */
const SLOW_SWEEP_WARN_MS = 2_000;

/** Record/refresh the held-since clock for a task and return how long it has been held. */
function trackHeld(taskId: string, reason: string, nowMs: number): number {
  const existing = heldSince.get(taskId);
  if (!existing || existing.reason !== reason) {
    heldSince.set(taskId, { reason, sinceMs: nowMs });
    return 0;
  }
  return nowMs - existing.sinceMs;
}

/** Exposed for tests: forget all held-since bookkeeping. */
export function resetHoldReleaseInstrumentation(): void {
  heldSince.clear();
}

export async function runHoldReleaseSweep(
  store: TaskStore,
  deps: HoldReleaseDeps,
): Promise<HoldReleaseResult> {
  const result: HoldReleaseResult = { released: [], held: [] };
  const sweepStartedMs = deps.now();

  const settings = await store.getSettings();
  /*
  FNXC:WorkflowScheduling 2026-06-22-00:00:
  Hold/release is the active workflow runtime even when an older persisted settings row still says workflowColumns=false. Do not let stale experimental flags strand default-workflow cards in held columns during scheduler or recovery sweeps.
  */

  const allTasks = await store.listTasks({ includeArchived: false });

  // Per-sweep caches. `allTasks` is a snapshot-stable read within a sweep, so we
  // resolve each workflow's IR at most once (irCache) and pre-build the
  // taskId → effective-workflowId map a single time rather than per-task DB
  // calls inside the capacity counting loop. The authoritative in-txn capacity
  // check is unaffected — this only trims the sweep pre-check cost.
  const irCache = new Map<string, WorkflowIr>();
  const effectiveWorkflowIdByTask = new Map<string, string>();
  /*
  FNXC:HoldReleaseInstrumentation 2026-07-25-14:35:
  This prefetch is a SEQUENTIAL await per non-archived task, so its cost scales with total board
  size rather than with the number of held cards — the prime suspect for a slow sweep on a large
  board. Timed separately from the sweep total so the two are distinguishable in one log line.
  */
  const prefetchStartedMs = deps.now();
  for (const t of allTasks) {
    effectiveWorkflowIdByTask.set(t.id, await effectiveWorkflowId(store, t.id));
  }
  const prefetchMs = deps.now() - prefetchStartedMs;

  for (const task of allTasks) {
    // Skip paused / recovery-backoff tasks exactly as the legacy scheduler does.
    if (task.paused || task.userPaused) {
      continue;
    }
    if (task.nextRecoveryAt && Date.parse(task.nextRecoveryAt) > deps.now()) {
      continue;
    }

    const ir = await resolveWorkflowIrForTask(store, task.id, irCache);
    if (!isHeldTask(ir, task)) continue;

    const column = findColumn(ir, task.column);
    const holdConfig = column ? resolveHoldConfig(column) : undefined;
    if (!column || !holdConfig) continue;
    const release = typeof holdConfig.release === "string" ? holdConfig.release : "manual";

    // manual / external-event are NEVER auto-released by the sweep.
    if (release === "manual" || release === "external-event") {
      trackHeld(task.id, `${release}-only`, deps.now());
      result.held.push({ taskId: task.id, reason: `${release}-only` });
      continue;
    }

    let shouldRelease = false;
    if (release === "timer") {
      const deadline = resolveTimerDeadline(holdConfig, task);
      shouldRelease = deadline !== undefined && deps.now() >= deadline;
      if (!shouldRelease) {
        trackHeld(task.id, "timer-not-elapsed", deps.now());
        result.held.push({ taskId: task.id, reason: "timer-not-elapsed" });
        continue;
      }
    } else if (release === "dependency") {
      shouldRelease = await allDependenciesSatisfied(store, task, allTasks);
      if (!shouldRelease) {
        trackHeld(task.id, "deps-unsatisfied", deps.now());
        result.held.push({ taskId: task.id, reason: "deps-unsatisfied" });
        continue;
      }
    } else if (release === "capacity") {
      // Capacity holds release into the nearest downstream capacity column when a
      // slot is free (pre-check); the in-txn check is the authority.
      const target = resolveReleaseTarget(ir, task.column, true);
      if (!target) {
        trackHeld(task.id, "no-downstream-capacity-column", deps.now());
        result.held.push({ taskId: task.id, reason: "no-downstream-capacity-column" });
        continue;
      }
      const capacity = resolveColumnCapacity(ir, target, settings);
      if (capacity.hasCapacity && Number.isFinite(capacity.limit)) {
        const workflowId = resolveCapacityPoolId(effectiveWorkflowIdByTask.get(task.id));
        // U4/KTD-9: count occupants across every column sharing the target's
        // budget (a shared `limitSetting` pools multiple wip columns).
        const budgetColumns = new Set(resolveWipBudgetColumns(ir, target));
        const occupants = countCapacitySlot(allTasks, effectiveWorkflowIdByTask, budgetColumns, workflowId, capacity.countPending);
        if (occupants >= capacity.limit) {
          trackHeld(task.id, "downstream-full", deps.now());
          result.held.push({ taskId: task.id, reason: "downstream-full" });
          continue;
        }
      }
      shouldRelease = true;
    }

    if (!shouldRelease) continue;

    const target = resolveReleaseTarget(ir, task.column, release === "capacity");
    if (!target) {
      trackHeld(task.id, "no-release-target", deps.now());
      result.held.push({ taskId: task.id, reason: "no-release-target" });
      continue;
    }

    const released = await issueRelease(store, deps, task, target, ir);
    if (released) {
      /*
      FNXC:HoldReleaseInstrumentation 2026-07-25-14:35:
      Report how long the card actually waited. This is the number that answers "why didn't it move
      immediately": a few hundred ms means the sweep is prompt and the wait was the poll cadence; a
      multi-second/minute value with a capacity reason means the card was genuinely queued.
      */
      const waitedMs = deps.now() - (heldSince.get(task.id)?.sinceMs ?? deps.now());
      heldSince.delete(task.id);
      schedulerLog.log(
        `Hold release for ${task.id} → ${target} after ${waitedMs}ms held (release=${release})`,
      );
      result.released.push(task.id);
    } else {
      trackHeld(task.id, "move-rejected-or-no-slot", deps.now());
      result.held.push({ taskId: task.id, reason: "move-rejected-or-no-slot" });
    }
  }

  /*
  FNXC:HoldReleaseInstrumentation 2026-07-25-14:35:
  One summary line per sweep. Held cards carry their longest current wait so a card stuck for
  minutes is visible without turning on debug logging. Info-level only when the sweep did something
  or ran slowly; otherwise debug, so a quiet board does not reprint this every poll.
  */
  const sweepMs = deps.now() - sweepStartedMs;
  const longestHeldMs = result.held.reduce((max, h) => {
    const entry = heldSince.get(h.taskId);
    return entry ? Math.max(max, deps.now() - entry.sinceMs) : max;
  }, 0);
  const summary =
    `Hold-release sweep: ${sweepMs}ms (prefetch ${prefetchMs}ms over ${allTasks.length} tasks), `
    + `released=${result.released.length}, held=${result.held.length}`
    + (longestHeldMs > 0 ? `, longest held ${longestHeldMs}ms` : "");
  if (sweepMs >= SLOW_SWEEP_WARN_MS) {
    schedulerLog.warn(`${summary} — sweep exceeded ${SLOW_SWEEP_WARN_MS}ms and is itself the delay`);
  } else if (result.released.length > 0) {
    schedulerLog.log(summary);
  } else {
    schedulerLog.debug(summary);
  }

  // Drop bookkeeping for tasks no longer held so the map tracks only live holds.
  const stillHeld = new Set(result.held.map((h) => h.taskId));
  for (const taskId of [...heldSince.keys()]) {
    if (!stillHeld.has(taskId)) heldSince.delete(taskId);
  }

  return result;
}

/**
 * Issue a single release move (`moveSource: "scheduler"`). For releases into a
 * processing (capacity) column the reservation-first ordering (KTD-10) reserves
 * worktree + semaphore before the move and releases the reservation if the move
 * rejects on capacity. Returns true on a committed move, false otherwise (the
 * card stays held).
 */
async function issueRelease(
  store: TaskStore,
  deps: HoldReleaseDeps,
  task: Task,
  target: string,
  ir: WorkflowIr,
  options: { allowUnplanned?: boolean } = {},
): Promise<boolean> {
  const targetColumn = findColumn(ir, target);
  const targetIsProcessing = targetColumn ? resolveColumnFlags(targetColumn).countsTowardWip === true : false;

  /*
  FNXC:WorkflowScheduling 2026-07-07-00:00:
  Every release surface funnels through this function (the sweep, explicit
  `promoteHeldTask`, and `releaseHeldTaskByEvent`) so a single defensive check
  here covers all of them — including the operator/webhook release paths that
  do not pass a `reserveSlot` dep at all and would otherwise bypass the
  scheduler's `reserveSlot` guard entirely. An unplanned card (bootstrap-stub
  PROMPT.md, `status: "planning"`, or resident in an `intake`-trait column)
  must never be moved into a processing column, no matter which surface
  requested the release (FN-7648).

  FNXC:WorkflowScheduling 2026-07-25-04:55:
  `allowUnplanned` is the ONLY way past this check, and it is set exclusively by
  an explicit operator force-promote (`promoteHeldTask({ force: true })`). The
  automatic surfaces — the sweep and the webhook release — never pass it, so
  FN-7648's invariant still holds for every non-operator release.
  */
  /*
  FNXC:PlanApprovalHold 2026-07-27-19:30 (U7 / R4):
  A card blocked on a pending human approval decision must never be released into
  a processing column by an AUTOMATED surface. `isTaskBlockedOnApproval` is core's
  declared "single shared predicate ... before rebounding, requeuing, resuming,
  re-planning, or otherwise advancing a task" (task-merge.ts), and this release
  path did not consult it.

  How it was reachable: the manual plan-approval gate parks the card by writing
  `status: "awaiting-approval"` with NO pause flag, so the pre-existing
  `task.paused || task.userPaused` skip in `runHoldReleaseSweep` did not match,
  and `isUnplannedForExecution` enumerates only `planning` / `needs-replan`. Once
  the plan-review gate's evidence landed, the sweep released a card whose plan the
  operator had never approved — the gate was skipped end to end.

  Checked HERE rather than in each caller because `issueRelease` is the single
  choke point every release surface funnels through (sweep, `promoteHeldTask`,
  `releaseHeldTaskByEvent`, and the scheduler's `reserveSlot` guard). Gated on
  `!options.allowUnplanned` for the same reason the unplanned check is: an
  explicit operator force-promote IS a human decision about this card, so it
  waives the human-decision gate, while no automatic surface can.
  */
  if (targetIsProcessing && !options.allowUnplanned && isTaskBlockedOnApproval(task)) {
    schedulerLog.debug(
      `Hold release for ${task.id} blocked — awaiting a human approval decision (status=${task.status ?? "null"}, pausedReason=${task.pausedReason ?? "null"})`,
    );
    return false;
  }

  if (targetIsProcessing && !options.allowUnplanned && (await isUnplannedForExecution(store, task, ir))) {
    await checkAndRecordUnplannedExecutionBlock(store, task, ir);
    /*
    FNXC:StrandedHoldContinuation 2026-07-26-14:15:
    Before FN-8592 this was an undeduplicated `schedulerLog.log`, not debug.
    A real-spec card with no continuation is a repairable fault, so warn only
    when the exact shared predicate confirms every guard; ordinary unplanned
    and capacity-held cards remain quiet. Global/Engine pause participates in
    the predicate and suppresses this warning.
    */
    try {
      const column = findColumn(ir, task.column);
      const tasksDir = typeof store.getTasksDir === "function" ? store.getTasksDir() : undefined;
      if (column && tasksDir) {
        let promptContent: string | null = null;
        try { promptContent = await readFile(getPromptPath(tasksDir, task.id), "utf8"); } catch { /* missing prompt is a quiet non-candidate */ }
        const settings = await store.getSettings();
        const continuations = await store.listWorkflowWorkItemsForTask(task.id);
        const live = activeSessionRegistry.pathsForTask(task.id).some((path) => activeSessionRegistry.isPathActive(path)) || executingTaskLock.has(task.id) || deps.isTaskActive?.(task.id) === true;
        const stranded = evaluateStrandedHoldContinuation({
          task,
          columnFlags: resolveColumnFlags(column),
          ir,
          continuations,
          stepResults: task.workflowStepResults,
          effectiveSettings: { autoMerge: resolveEffectiveAutoMerge(task, settings) },
          enginePaused: settings.globalPause === true || settings.enginePaused === true,
          promptContent,
          live,
          stalenessMs: deps.now() - new Date(task.columnMovedAt ?? task.updatedAt).getTime(),
          graceMs: 60_000,
          now: deps.now(),
        });
        const key = `${task.id}:${task.column}`;
        if (stranded.stranded && !strandedHoldWarningMemo.has(key)) {
          strandedHoldWarningMemo.add(key);
          schedulerLog.warn(`Stranded hold continuation for ${task.id} in ${task.column}; self-healing reconciliation will re-seed Plan Review`);
        }
      }
    } catch {
      // Diagnostics must never widen the release gate or prevent its normal refusal.
    }
    schedulerLog.debug(`Hold release for ${task.id} blocked — card is unplanned and cannot enter processing column ${target}`);
    return false;
  }

  let reservation: SlotReservation | null = null;
  if (targetIsProcessing && deps.reserveSlot) {
    reservation = await deps.reserveSlot(task, target);
    if (!reservation) {
      /*
      Semaphore/worktree exhausted — reservation-first means no move at all.

      FNXC:WorkflowScheduling 2026-07-15-12:55:
      A held card re-attempts release on every sweep, so a full board reprinted this line per task per poll and buried real scheduler events. Being at capacity is the expected steady state, not an event: debug-only (`FUSION_DEBUG=scheduler`).
      */
      schedulerLog.debug(`Hold release for ${task.id} deferred — no reservable slot for ${target}`);
      return false;
    }
  }

  try {
    const originalColumn = task.column;
    /*
    FNXC:UserPausedDispatch 2026-07-21-21:45:
    Hold release must test the source column and both pause flags under the same task lock as the move. This makes an operator pause win atomically against scheduler dispatch and also replaces event-identity inference for concurrent release attempts.

    FNXC:PlanApprovalHold 2026-07-27-19:30 (U7 / R6):
    The approval hold is tested here too, not only in the pre-check above. The
    pre-check reads a task snapshot the sweep loaded earlier in the pass, so a plan
    gate (or an operator) that parks the card between that read and this move would
    otherwise lose the race and the card would release unapproved. Only the
    predicate under the task lock is authoritative; the pre-check is an early exit.
    `allowUnplanned` is carried through so an explicit operator force-promote waives
    the gate here exactly as it does above — one waiver, not two policies.
    */
    const result = await store.moveTaskIf(
      task.id,
      target,
      (live) => live.column === originalColumn && live.paused !== true && live.userPaused !== true
        && !(targetIsProcessing && !options.allowUnplanned && isTaskBlockedOnApproval(live)),
      {
        moveSource: "scheduler",
        allocateWorktree:
          targetIsProcessing && deps.allocateWorktree
            ? (reservedNames) => deps.allocateWorktree!(task, reservedNames)
            : undefined,
      },
    );
    if (!result.moved) {
      reservation?.release();
      schedulerLog.log(`Hold release for ${task.id} skipped — task became paused or left ${originalColumn}`);
      return false;
    }
    return true;
  } catch (error) {
    if (error instanceof TransitionRejectionError && error.rejection.code === "capacity-exhausted") {
      // Lost the in-txn race for the slot — release the reservation, stay held.
      // FNXC:EngineDiagnostics 2026-07-26-08:17: capacity races re-hit every sweep while full; same class as deferred-no-slot → debug.
      reservation?.release();
      schedulerLog.debug(`Hold release for ${task.id} rejected on capacity for ${target} — staying held`);
      return false;
    }
    // Any other failure: release the reservation and let the card stay held.
    reservation?.release();
    schedulerLog.warn(
      `Hold release for ${task.id} into ${target} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

// ── Explicit (manual / external-event) releases ───────────────────────────────

/**
 * Manually promote a held card out of its hold column (U9's promote endpoint /
 * CLI calls this). Releases regardless of the hold's release kind — a manual
 * promote is the explicit operator action the `manual` release kind waits for,
 * and it is also accepted for other kinds as an operator override. The move
 * still serializes through the in-txn capacity check (KTD-10): a promote into a
 * full column rejects with `capacity-exhausted`, surfaced to the caller.
 *
 * FNXC:WorkflowScheduling 2026-07-25-04:55:
 * `options.force` is the operator's "start it anyway" override for the
 * `unplanned-for-execution` rejection: an operator who has read the card and
 * decided the pending replan / Plan Review is not worth waiting for can push it
 * straight into execution. Force ONLY relaxes the unplanned gate — the hold
 * membership, release target, capacity check, and slot reservation are all still
 * enforced, so a forced promote into a full column still rejects on capacity.
 * Force also CLEARS a durable replan signal (`needs-replan` /
 * `plan-review-unavailable`) before the move: those statuses are read by triage's
 * todo rediscovery and by this module's own gate, so leaving one in place would
 * let the card be pulled back for the very replan the operator just waived.
 * `status: "planning"` is deliberately NOT cleared — triage is mid-write on
 * PROMPT.md and clearing it would race the writer; the card still releases.
 */
export async function promoteHeldTask(
  store: TaskStore,
  taskId: string,
  deps: Pick<HoldReleaseDeps, "reserveSlot" | "allocateWorktree"> = {},
  options: { force?: boolean } = {},
): Promise<{ released: boolean; toColumn?: string; rejection?: string; forcedUnplanned?: boolean }> {
  const task = await store.getTask(taskId);
  if (!task) return { released: false, rejection: "task-not-found" };

  const ir = await resolveWorkflowIrForTask(store, taskId);
  if (!isHeldTask(ir, task)) {
    return { released: false, rejection: "not-held" };
  }
  const target = resolveReleaseTarget(ir, task.column, true);
  if (!target) return { released: false, rejection: "no-release-target" };

  /*
  FNXC:WorkflowScheduling 2026-07-21-22:31:
  Surface pre-release Plan Review / unplanned holds distinctly from true WIP
  capacity. issueRelease returns a bare false for both; without this check the
  promote API mislabeled FN-8471-style plan-review waits as capacity-exhausted.
  */
  const targetColumn = findColumn(ir, target);
  const targetIsProcessing = targetColumn
    ? resolveColumnFlags(targetColumn).countsTowardWip === true
    : false;
  const unplanned = targetIsProcessing && (await isUnplannedForExecution(store, task, ir));
  if (unplanned && options.force !== true) {
    await checkAndRecordUnplannedExecutionBlock(store, task, ir);
    return { released: false, rejection: "unplanned-for-execution", toColumn: target };
  }

  let promoted = task;
  if (unplanned) {
    // Clear the durable replan signal so triage's todo rediscovery and this
    // module's own gate do not pull the card back into the waived replan.
    if (task.status === "needs-replan" || task.status === "plan-review-unavailable") {
      try {
        await store.updateTask(task.id, { status: null });
        promoted = { ...task, status: undefined };
      } catch (error) {
        schedulerLog.warn(
          `Force-promote for ${task.id} could not clear replan status: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // ids/outcomes-only audit of the override (no prompt or reason prose).
    if (typeof store.recordRunAuditEvent === "function") {
      try {
        await store.recordRunAuditEvent({
          domain: "database",
          mutationType: "task:promote-forced-unplanned",
          target: task.id,
          taskId: task.id,
          agentId: "system",
          runId: `promote-force-${task.id}`,
          metadata: { fromColumn: task.column, toColumn: target, priorStatus: task.status ?? null },
        });
      } catch {
        // Audit is best-effort — never block the operator's override on it.
      }
    }
    schedulerLog.log(`Force-promote for ${task.id} bypassing unplanned gate into ${target} (operator override)`);
  }

  const released = await issueRelease(
    store,
    { now: () => Date.now(), reserveSlot: deps.reserveSlot, allocateWorktree: deps.allocateWorktree },
    promoted,
    target,
    ir,
    { allowUnplanned: unplanned },
  );
  if (!released) {
    return { released: false, rejection: "capacity-exhausted-or-no-slot" };
  }
  return { released: true, toColumn: target, forcedUnplanned: unplanned || undefined };
}

/**
 * Release a held card on an external event (webhook/API). Same shape as
 * {@link promoteHeldTask} plus an `eventTag` recorded in the audit; only acts on
 * `external-event` holds (a no-op otherwise so a stray webhook can't release a
 * manual/timer/capacity hold).
 */
export async function releaseHeldTaskByEvent(
  store: TaskStore,
  taskId: string,
  eventTag: string,
  deps: Pick<HoldReleaseDeps, "reserveSlot" | "allocateWorktree"> = {},
): Promise<{ released: boolean; toColumn?: string; rejection?: string }> {
  const task = await store.getTask(taskId);
  if (!task) return { released: false, rejection: "task-not-found" };

  const ir = await resolveWorkflowIrForTask(store, taskId);
  const column = findColumn(ir, task.column);
  const holdConfig = column ? resolveHoldConfig(column) : undefined;
  if (!column || !holdConfig || holdConfig.release !== "external-event") {
    return { released: false, rejection: "not-external-event-hold" };
  }
  try {
    void store.recordRunAuditEvent?.({
      taskId,
      agentId: "scheduler",
      runId: `hold-release:event:${taskId}`,
      domain: "database",
      mutationType: "task:hold-release-event",
      target: taskId,
      metadata: { eventTag, fromColumn: task.column },
    });
  } catch {
    // best-effort
  }
  const target = resolveReleaseTarget(ir, task.column, true);
  if (!target) return { released: false, rejection: "no-release-target" };

  const released = await issueRelease(
    store,
    { now: () => Date.now(), reserveSlot: deps.reserveSlot, allocateWorktree: deps.allocateWorktree },
    task,
    target,
    ir,
  );
  return released ? { released: true, toColumn: target } : { released: false, rejection: "capacity-exhausted-or-no-slot" };
}
