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
  DEFAULT_WORKFLOW_POOL_ID,
  TransitionRejectionError,
  resolveWorkflowIrForTask,
  isUnplannedSeedPrompt,
  type TaskStore,
  type Task,
  type WorkflowIr,
  type WorkflowIrNode,
  type WorkflowIrV2,
  type WorkflowIrColumn,
} from "@fusion/core";
import { readFile } from "node:fs/promises";
import { schedulerLog } from "./logger.js";
import { getPromptPath } from "./spec-staleness.js";

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
    return (await store.getTaskWorkflowSelectionAsync(taskId))?.workflowId ?? DEFAULT_WORKFLOW_POOL_ID;
  } catch {
    return DEFAULT_WORKFLOW_POOL_ID;
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
  const preReleaseReview = resolvePreReleasePlanReviewNode(ir);
  if (preReleaseReview) {
    // Compatibility for tasks planned before durable continuations existed and
    // for narrow store adapters that expose only the legacy review result.
    const legacyPassed = task.workflowStepResults?.some(
      (result) => result.workflowStepId === PLAN_REVIEW_GROUP_ID && result.status === "passed",
    );
    if (!legacyPassed) {
      if (typeof store.listWorkflowWorkItemsForTask !== "function") return true;
      const continuations = await store.listWorkflowWorkItemsForTask(task.id, { kinds: ["task"] });
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
    if ((effectiveWorkflowIdByTask.get(t.id) ?? DEFAULT_WORKFLOW_POOL_ID) !== workflowId) continue;
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
export async function runHoldReleaseSweep(
  store: TaskStore,
  deps: HoldReleaseDeps,
): Promise<HoldReleaseResult> {
  const result: HoldReleaseResult = { released: [], held: [] };

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
  for (const t of allTasks) {
    effectiveWorkflowIdByTask.set(t.id, await effectiveWorkflowId(store, t.id));
  }

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
      result.held.push({ taskId: task.id, reason: `${release}-only` });
      continue;
    }

    let shouldRelease = false;
    if (release === "timer") {
      const deadline = resolveTimerDeadline(holdConfig, task);
      shouldRelease = deadline !== undefined && deps.now() >= deadline;
      if (!shouldRelease) {
        result.held.push({ taskId: task.id, reason: "timer-not-elapsed" });
        continue;
      }
    } else if (release === "dependency") {
      shouldRelease = await allDependenciesSatisfied(store, task, allTasks);
      if (!shouldRelease) {
        result.held.push({ taskId: task.id, reason: "deps-unsatisfied" });
        continue;
      }
    } else if (release === "capacity") {
      // Capacity holds release into the nearest downstream capacity column when a
      // slot is free (pre-check); the in-txn check is the authority.
      const target = resolveReleaseTarget(ir, task.column, true);
      if (!target) {
        result.held.push({ taskId: task.id, reason: "no-downstream-capacity-column" });
        continue;
      }
      const capacity = resolveColumnCapacity(ir, target, settings);
      if (capacity.hasCapacity && Number.isFinite(capacity.limit)) {
        const workflowId = effectiveWorkflowIdByTask.get(task.id) ?? DEFAULT_WORKFLOW_POOL_ID;
        // U4/KTD-9: count occupants across every column sharing the target's
        // budget (a shared `limitSetting` pools multiple wip columns).
        const budgetColumns = new Set(resolveWipBudgetColumns(ir, target));
        const occupants = countCapacitySlot(allTasks, effectiveWorkflowIdByTask, budgetColumns, workflowId, capacity.countPending);
        if (occupants >= capacity.limit) {
          result.held.push({ taskId: task.id, reason: "downstream-full" });
          continue;
        }
      }
      shouldRelease = true;
    }

    if (!shouldRelease) continue;

    const target = resolveReleaseTarget(ir, task.column, release === "capacity");
    if (!target) {
      result.held.push({ taskId: task.id, reason: "no-release-target" });
      continue;
    }

    const released = await issueRelease(store, deps, task, target, ir);
    if (released) {
      result.released.push(task.id);
    } else {
      result.held.push({ taskId: task.id, reason: "move-rejected-or-no-slot" });
    }
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
  */
  if (targetIsProcessing && (await isUnplannedForExecution(store, task, ir))) {
    schedulerLog.log(`Hold release for ${task.id} blocked — card is unplanned and cannot enter processing column ${target}`);
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

  // A concurrent sweep (or explicit promote) can win the move for this same card
  // while we hold a reservation. The store serializes the move under a per-task
  // lock and resolves a redundant same-column move to a silent no-op: it returns
  // the card already at the target WITHOUT re-allocating a slot or emitting a
  // `task:moved`. A snapshot/pre-read can't tell winner from loser (both reads
  // race ahead of either commit on the per-task lock). Instead we attribute the
  // transition by OBJECT IDENTITY: a real move emits `task:moved` with the very
  // Task object it then returns, whereas a no-op returns a freshly-read object
  // and emits nothing. So the call whose `moveTask` result IS the emitted task is
  // the real mover; any other call that reserved performed a redundant no-op and
  // must release the slot it grabbed (FN-1415).
  const movedTaskObjects = new Set<object>();
  let sawMovedEventForTask = false;
  const onMoved = (data: { task: Task; to: string }): void => {
    if (data.to === target && data.task.id === task.id) {
      sawMovedEventForTask = true;
      movedTaskObjects.add(data.task);
    }
  };
  store.on?.("task:moved", onMoved);

  try {
    const originalColumn = task.column;
    const result = await store.moveTask(task.id, target, {
      moveSource: "scheduler",
      allocateWorktree:
        targetIsProcessing && deps.allocateWorktree
          ? (reservedNames) => deps.allocateWorktree!(task, reservedNames)
          : undefined,
    });
    /*
    FNXC:WorkflowScheduling 2026-06-23-21:57:
    The cutover scheduler uses hold/release in tests and older embedded stores that may not expose task:moved events. Treat a returned task that clearly moved from the original column to the target as the committed release so minimal stores do not leak reservations or falsely report a racing same-column no-op.

    FNXC:WorkflowScheduling 2026-06-23-22:39:
    Eventless-release fallback is scoped to the current task. Other cards moving to the same target column during the same sweep must not disable this task's fallback and leak its reservation.

    FNXC:WorkflowScheduling 2026-06-23-22:59:
    Void-returning legacy stores are ambiguous: no event plus no returned task cannot prove the current task moved. Require a returned current-task row before keeping the reservation so same-column no-ops do not leak slots.
    */
    const returnedMovedTask = !sawMovedEventForTask
      && result?.id === task.id
      && result.column === target
      && originalColumn !== target;
    if (reservation && !movedTaskObjects.has(result) && !returnedMovedTask) {
      // Same-column no-op: a racing sweep already moved this card to the target.
      reservation.release();
      schedulerLog.log(`Hold release for ${task.id} skipped — already at ${target} (racing sweep won)`);
      return false;
    }
    return true;
  } catch (error) {
    if (error instanceof TransitionRejectionError && error.rejection.code === "capacity-exhausted") {
      // Lost the in-txn race for the slot — release the reservation, stay held.
      reservation?.release();
      schedulerLog.log(`Hold release for ${task.id} rejected on capacity for ${target} — staying held`);
      return false;
    }
    // Any other failure: release the reservation and let the card stay held.
    reservation?.release();
    schedulerLog.warn(
      `Hold release for ${task.id} into ${target} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  } finally {
    store.off?.("task:moved", onMoved);
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
 */
export async function promoteHeldTask(
  store: TaskStore,
  taskId: string,
  deps: Pick<HoldReleaseDeps, "reserveSlot" | "allocateWorktree"> = {},
): Promise<{ released: boolean; toColumn?: string; rejection?: string }> {
  const task = await store.getTask(taskId);
  if (!task) return { released: false, rejection: "task-not-found" };

  const ir = await resolveWorkflowIrForTask(store, taskId);
  if (!isHeldTask(ir, task)) {
    return { released: false, rejection: "not-held" };
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
