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
  sortTasksByPriorityThenAgeAndId,
  TransitionRejectionError,
  resolveWorkflowIrForTask,
  isUnplannedSeedPrompt,
  isDuplicateRedirectOnlyPrompt,
  isFastExecutionMode,
  isWorkflowOptionalGroupEnabled,
  resolveEffectiveAutoMerge,
  isTaskBlockedOnApproval,
  isPlanReviewSatisfied,
  type TaskStore,
  type Task,
  type TaskReleaseGateVerdict,
  type WorkflowIr,
  type WorkflowIrNode,
  type WorkflowIrV2,
  type WorkflowIrColumn,
  type WorkflowSelectionCache,
  type WorkflowSelectionReadTally,
  type WorkflowIrResolverStore,
} from "@fusion/core";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { schedulerLog } from "../logger.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
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
  /** Caller-owned cache, valid for this scheduler pass only. */
  selectionCache?: WorkflowSelectionCache;
  /** Maximum sweep work budget; in-flight store operations cannot be cancelled. */
  budgetMs?: number;
}

/** Outcome of one sweep pass (for tests + observability). */
export interface HoldReleaseResult {
  released: string[];
  /** taskId → reason it stayed held this pass. */
  held: Array<{ taskId: string; reason: string }>;
  skippedConcurrent?: boolean;
  budgetTruncated?: boolean;
  unevaluatedCount?: number;
}

type IssueReleaseResult =
  | { released: true }
  | { released: false; rejection?: "unplanned-for-execution" };

// ── Workflow IR resolution (read-only) ────────────────────────────────────────
// The selection → builtin/custom → default rule lives in @fusion/core's
// resolveWorkflowIrForTask (GitHub #1402); the optional per-sweep irCache Map is
// threaded straight through.

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
 * rests in. For standard cards, "unplanned" means `status === "planning"`
 * (specified-in-place), OR the card's PROMPT.md still equals the bootstrap stub AND the card is
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

export interface UnplannedForExecutionEvaluation {
  unplanned: boolean;
  reason: "plan-review-pending" | "planning-status" | "needs-replan" | "duplicate-prompt" | "seed-prompt" | null;
  readyAtCapacityBoundary: boolean;
  planReview?: NonNullable<TaskReleaseGateVerdict["planReview"]>;
}

/*
FNXC:PromoteVisibility 2026-08-11-20:38:
Release dispatch and board enrichment consume one structured decision so the browser does not keep a
second gate. Continuations, PROMPT.md, and workflow IR are invisible to the browser, so verdicts carry expiry evidence.
*/
export async function evaluateUnplannedForExecution(store: TaskStore, task: Task, ir: WorkflowIr): Promise<UnplannedForExecutionEvaluation> {
  const preReleaseReview = resolvePreReleasePlanReviewNode(ir);
  const defaultOn = (preReleaseReview?.config as { defaultOn?: boolean } | undefined)?.defaultOn ?? false;
  const enabled = preReleaseReview ? isWorkflowOptionalGroupEnabled(task.enabledWorkflowSteps, preReleaseReview.id, defaultOn) : false;
  const appliesToColumn = preReleaseReview?.column === task.column;
  const satisfied = task.workflowStepResults?.some(isPlanReviewSatisfied) === true;
  const planReview = preReleaseReview ? { nodeId: preReleaseReview.id, column: preReleaseReview.column!, defaultOn, enabled, appliesToColumn, satisfied } : undefined;
  let readyAtCapacityBoundary = false;
  if (!isFastExecutionMode(task) && preReleaseReview && enabled && appliesToColumn && !satisfied) {
    if (typeof store.listWorkflowWorkItemsForTask !== "function") return { unplanned: true, reason: "plan-review-pending", readyAtCapacityBoundary, planReview };
    const active = (await store.listWorkflowWorkItemsForTask(task.id)).filter((item) => ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state));
    readyAtCapacityBoundary = active.some((item) => item.waitReason === "capacity" && item.sourceColumn === task.column);
    if (!readyAtCapacityBoundary) return { unplanned: true, reason: "plan-review-pending", readyAtCapacityBoundary, planReview };
  }
  /*
  FNXC:FastLane 2026-08-29-04:23:
  A Fast toggle can arrive after the ordinary planner claimed the card. Fast is intentionally
  planless, so its admission must supersede that stale `planning` claim; otherwise triage skips the
  card while hold release refuses it forever. `needs-replan` remains a real revision request and
  still blocks every mode.
  */
  if (task.status === "planning" && !isFastExecutionMode(task)) return { unplanned: true, reason: "planning-status", readyAtCapacityBoundary, planReview };
  if (task.status === "needs-replan") return { unplanned: true, reason: "needs-replan", readyAtCapacityBoundary, planReview };
  const flags = findColumn(ir, task.column) ? resolveColumnFlags(findColumn(ir, task.column)!) : {};
  if (flags.intake !== true && flags.hold !== true) return { unplanned: false, reason: null, readyAtCapacityBoundary, planReview };
  /*
  FNXC:DuplicateIntake 2026-08-11-20:53:
  A durable duplicate-only title is executable-state evidence even when a narrow store adapter
  cannot expose PROMPT.md. Check it before filesystem access so every release surface preserves
  the duplicate redirect refusal rather than accidentally releasing the card.
  */
  if (isDuplicateRedirectOnlyPrompt(undefined, task.title)) return { unplanned: true, reason: "duplicate-prompt", readyAtCapacityBoundary, planReview };
  /*
  FNXC:FastLane 2026-08-29-02:55:
  A bootstrap PROMPT.md is the intended original-request payload for Fast execution, not evidence
  that specification is missing. Keep earlier duplicate and replan refusals intact, then admit the
  lane before any filesystem seed read so capacity/manual/event release all agree.
  */
  if (isFastExecutionMode(task)) return { unplanned: false, reason: null, readyAtCapacityBoundary, planReview };
  if (typeof store.getTasksDir !== "function") return { unplanned: false, reason: null, readyAtCapacityBoundary, planReview };
  try {
    const prompt = await readFile(getPromptPath(store.getTasksDir(), task.id), "utf-8");
    if (isDuplicateRedirectOnlyPrompt(prompt, task.title)) return { unplanned: true, reason: "duplicate-prompt", readyAtCapacityBoundary, planReview };
    const unplanned = isUnplannedSeedPrompt(prompt, task.id, task.title, task.description);
    return { unplanned, reason: unplanned ? "seed-prompt" : null, readyAtCapacityBoundary, planReview };
  } catch {
    return { unplanned: false, reason: null, readyAtCapacityBoundary, planReview };
  }
}

/** Compatibility wrapper retained for scheduler and release callers. */
export async function isUnplannedForExecution(store: TaskStore, task: Task, ir: WorkflowIr): Promise<boolean> {
  return (await evaluateUnplannedForExecution(store, task, ir)).unplanned;
}

export type CapacityHoldReadiness =
  | { releasable: true }
  | { releasable: false; kind: "awaiting-planning" | "awaiting-approval"; reason: string };

/*
FNXC:WorkflowScheduling 2026-08-28-21:24:
A background hold-release pass must classify an unplanned or approval-held card as a non-candidate rather than manufacture a refusal for work nobody requested. Durable refusal recording belongs to explicit operator and external-event release requests inside `issueRelease`; this helper never records one and accepts no force or waiver input. The FN-7648 execution-entry invariant remains enforced at `issueRelease` for every release surface.
*/
export async function evaluateCapacityHoldReadiness(
  store: TaskStore,
  deps: HoldReleaseDeps,
  task: Task,
  ir: WorkflowIr,
  targetColumnId: string,
): Promise<CapacityHoldReadiness> {
  const targetColumn = findColumn(ir, targetColumnId);
  const targetIsProcessing = targetColumn ? resolveColumnFlags(targetColumn).countsTowardWip === true : false;
  if (!targetIsProcessing) return { releasable: true };
  if (isTaskBlockedOnApproval(task)) {
    return { releasable: false, kind: "awaiting-approval", reason: "awaiting-approval" };
  }

  const evaluation = await evaluateUnplannedForExecution(store, task, ir);
  if (!evaluation.unplanned) return { releasable: true };

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

  return { releasable: false, kind: "awaiting-planning", reason: evaluation.reason ?? "unplanned" };
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

/** Evaluate the exact hold-to-target refusal without dispatch side effects. */
export async function evaluateTaskReleaseGate(store: TaskStore, task: Task, options: { ir?: WorkflowIr } = {}): Promise<TaskReleaseGateVerdict | undefined> {
  const ir = options.ir ?? await resolveWorkflowIrForTask(store, task.id);
  if (!isHeldTask(ir, task)) return undefined;
  const releaseTargetColumn = resolveReleaseTarget(ir, task.column, true);
  if (!releaseTargetColumn) return undefined;
  const targetColumn = findColumn(ir, releaseTargetColumn);
  const targetCountsTowardWip = targetColumn ? resolveColumnFlags(targetColumn).countsTowardWip === true : false;
  const result = targetCountsTowardWip
    ? await evaluateUnplannedForExecution(store, task, ir)
    : { unplanned: false, reason: null, readyAtCapacityBoundary: false };
  const blockedOnApproval = targetCountsTowardWip && isTaskBlockedOnApproval(task);
  return {
    promoteBlocked: result.unplanned || blockedOnApproval,
    unplannedForExecution: result.unplanned,
    blockedOnApproval,
    reason: result.reason ?? (blockedOnApproval ? "awaiting-approval" : null),
    readyAtCapacityBoundary: result.readyAtCapacityBoundary,
    ...(result.planReview ? { planReview: result.planReview } : {}),
    releaseTargetColumn,
    targetCountsTowardWip,
    evaluatedAt: new Date().toISOString(),
    ...(task.updatedAt ? { evaluatedForUpdatedAt: task.updatedAt } : {}),
  };
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
type DependencyEvaluation = { satisfied: boolean; truncated: boolean };
type SweepCounters = { settings: number; tasks: number; batchSelections: number; selections: number; definitions: number; handoffMarkers: number; heldCandidates: number };
type SweepCtx = {
  store: TaskStore;
  resolverStore: WorkflowIrResolverStore;
  irCache: Map<string, WorkflowIr>;
  selectionCache: WorkflowSelectionCache;
  handoffMemo: Map<string, boolean>;
  counters: SweepCounters;
  expired: () => boolean;
};

async function dependencySatisfied(ctx: SweepCtx, dep: Task): Promise<DependencyEvaluation> {
  if (ctx.expired()) return { satisfied: false, truncated: true };
  const ir = await resolveWorkflowIrForTask(ctx.resolverStore, dep.id, ctx.irCache, ctx.selectionCache);
  const column = findColumn(ir, dep.column);
  const completeFlag = column ? resolveColumnFlags(column).complete === true : false;

  let markerAccepted = ctx.handoffMemo.get(dep.id);
  // FNXC:WorkflowScheduling 2026-08-09-08:16: false is the normal memoized
  // result for an absent handoff marker; test membership rather than its value
  // so several dependents sharing an unfinished dependency issue one read.
  if (!ctx.handoffMemo.has(dep.id)) {
    if (ctx.expired()) return { satisfied: false, truncated: true };
    try {
      ctx.counters.handoffMarkers += 1;
      markerAccepted = (await ctx.store.getCompletionHandoffAcceptedMarker(dep.id)) !== null;
    } catch {
      markerAccepted = false;
    }
    ctx.handoffMemo.set(dep.id, markerAccepted);
  }
  const legacy = legacyDependencySatisfied(dep) || markerAccepted === true;

  if (completeFlag !== legacy) {
    /*
    FNXC:RunAudit 2026-08-29-00:24:
    FN-245 removes force-promote; hold-release telemetry remains best-effort so a
    hostile audit sink never gates a sweep, explicit promote, or event release.
    */
    void emitBoundedRunAudit(ctx.store, {
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
      }, { log: schedulerLog });
  }
  // Dual-accept: satisfied if EITHER signal says so (the dual-accept window
  // closes at graduation per U12; until then both are accepted).
  return { satisfied: completeFlag || legacy, truncated: false };
}

async function allDependenciesSatisfied(ctx: SweepCtx, task: Task, allTasks: Task[]): Promise<DependencyEvaluation> {
  for (const depId of task.dependencies ?? []) {
    if (ctx.expired()) return { satisfied: false, truncated: true };
    const dep = allTasks.find((t) => t.id === depId);
    if (!dep) continue; // missing dep does not block (matches scheduler posture)
    const evaluation = await dependencySatisfied(ctx, dep);
    if (evaluation.truncated || !evaluation.satisfied) return evaluation;
  }
  return { satisfied: true, truncated: false };
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
function createCountingResolverStore(store: TaskStore, counters: SweepCounters): WorkflowIrResolverStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      // FNXC:WorkflowScheduling 2026-08-09-10:39: The counting facade must
      // preserve an absent optional async reader. Replacing `undefined` with a
      // wrapper makes the resolver select a throwing async path instead of its
      // established synchronous fallback.
      if (typeof value === "function" && (property === "getTaskWorkflowSelectionAsync" || property === "getTaskWorkflowSelection")) {
        return (...args: unknown[]) => { counters.selections += 1; return Reflect.apply(value as (...values: unknown[]) => unknown, target, args); };
      }
      if (typeof value === "function" && property === "getWorkflowDefinition") {
        return (...args: unknown[]) => { counters.definitions += 1; return Reflect.apply(value as (...values: unknown[]) => unknown, target, args); };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as WorkflowIrResolverStore;
}

const SLOW_SWEEP_WARN_MS = 2_000;
/*
FNXC:WorkflowScheduling 2026-08-09-08:16:
Issue #3364 requires a bounded sweep to stop starting new awaits after its budget, not to claim cancellation of an already-issued database call. Preamble truncation therefore emits the same measured one-line warning as loop truncation, including the unscanned count and overrun, so a stalled control plane is diagnosable even before card evaluation begins.
*/
const SWEEP_BUDGET_MS = 10_000;
const inFlightSweepProjects = new Set<string>();
const syntheticSweepProjects = new WeakMap<object, string>();
let syntheticSweepProjectCounter = 0;

/*
FNXC:WorkflowScheduling 2026-08-09-06:07:
Issue #3364 requires one in-flight sweep per project, not per TaskStore: central deployments can have separate store objects for the same project rows. Concurrent callers are skipped rather than joined because their reservation, clock, cache, and budget closures are not interchangeable.
*/
function sweepProjectKey(store: TaskStore): string {
  try {
    const projectId = store.getWorkflowSettingsProjectId?.();
    // FNXC:WorkflowScheduling 2026-08-09-10:35: A present but blank project id
    // is the same legacy-unscoped partition used by selection reads, not an
    // identity-less mock. Guard those stores together so they cannot contend.
    if (typeof projectId === "string") return projectId.trim() || "__legacy_unscoped__";
  } catch {
    // Compatibility stores below degrade to a unique instance key.
  }
  const object = store as object;
  let key = syntheticSweepProjects.get(object);
  if (!key) {
    key = `sweep-store:${++syntheticSweepProjectCounter}`;
    syntheticSweepProjects.set(object, key);
  }
  return key;
}

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
  inFlightSweepProjects.clear();
}

export async function runHoldReleaseSweep(
  store: TaskStore,
  deps: HoldReleaseDeps,
): Promise<HoldReleaseResult> {
  const projectKey = sweepProjectKey(store);
  if (inFlightSweepProjects.has(projectKey)) {
    schedulerLog.debug(`Hold-release sweep skipped: another sweep is active for ${projectKey}`);
    return { released: [], held: [], skippedConcurrent: true };
  }
  inFlightSweepProjects.add(projectKey);
  try {
    const result: HoldReleaseResult = { released: [], held: [] };
    const sweepStartedMs = deps.now();
    const budgetMs = deps.budgetMs ?? SWEEP_BUDGET_MS;
    const expired = () => deps.now() >= sweepStartedMs + budgetMs;
    const evaluatedTaskIds = new Set<string>();
    const irCache = new Map<string, WorkflowIr>();
    const selectionCache = deps.selectionCache ?? new Map<string, { workflowId: string; stepIds: string[] } | undefined>();
    const counters: SweepCounters = { settings: 0, tasks: 0, batchSelections: 0, selections: 0, definitions: 0, handoffMarkers: 0, heldCandidates: 0 };
    const resolverStore = createCountingResolverStore(store, counters);
    const ctx: SweepCtx = { store, resolverStore, irCache, selectionCache, handoffMemo: new Map(), counters, expired };
    const prefetchStartedMs = sweepStartedMs;
    let prefetchMs = 0;
    let irResolveMs = 0;
    const logPreambleTruncation = (unevaluatedCount: number): HoldReleaseResult => {
      prefetchMs = deps.now() - prefetchStartedMs;
      const sweepMs = deps.now() - sweepStartedMs;
      const summary = `Hold-release sweep: ${sweepMs}ms (prefetch ${prefetchMs}ms, ir-resolve ${irResolveMs}ms, evaluate 0ms over ${unevaluatedCount} tasks), released=0, held=0`
        + `, budget-truncated unevaluated=${unevaluatedCount}`
        + (sweepMs > budgetMs ? `, budgetOverrunMs=${sweepMs - budgetMs}` : "")
        + `, reads(settings=${counters.settings}, tasks=${counters.tasks}, batchSelections=${counters.batchSelections}, selections=${counters.selections}, definitions=${counters.definitions}, handoffMarkers=${counters.handoffMarkers}), scanned=0, heldCandidates=0`;
      schedulerLog.warn(summary);
      return { ...result, budgetTruncated: true, unevaluatedCount };
    };

    counters.settings += 1;
    const settings = await store.getSettings();
    if (expired()) return logPreambleTruncation(0);
    counters.tasks += 1;
    /*
    FNXC:WorkflowScheduling 2026-09-05-23:12:
    listTasks used to hide N individual selection reads behind one list call, making this diagnostic
    claim selections=0. Its reported tally is folded in directly: cache-size growth is not evidence,
    because both a successful batch and degraded individual reads populate the same cache.
    */
    const selectionReadTally: WorkflowSelectionReadTally = { batched: 0, singles: 0 };
    const allTasks = await store.listTasks({ includeArchived: false, selectionCache, selectionReadTally });
    counters.batchSelections += selectionReadTally.batched;
    counters.selections += selectionReadTally.singles;
    if (expired()) return logPreambleTruncation(allTasks.length);


    const effectiveWorkflowIdByTask = new Map<string, string>();
    const missingIds = [...new Set(allTasks.map((task) => task.id))].filter((id) => !selectionCache.has(id));
    let useSingleSelectionFallback = !store.getTaskWorkflowSelectionsAsync;
    try {
      if (missingIds.length > 0 && !expired() && store.getTaskWorkflowSelectionsAsync) {
        counters.batchSelections += 1;
        const selections = await store.getTaskWorkflowSelectionsAsync(missingIds);
        for (const id of missingIds) selectionCache.set(id, selections.get(id));
      }
    } catch {
      // FNXC:WorkflowScheduling 2026-08-09-06:29:
      // A failed batch read must retain the legacy per-task fallback for both
      // capacity accounting and release decisions; defaulting every task here
      // would merge distinct workflow pools and change hold behavior.
      useSingleSelectionFallback = true;
    }
    if (useSingleSelectionFallback) {
      for (const id of missingIds) {
        if (expired()) break;
        try { counters.selections += 1; selectionCache.set(id, await store.getTaskWorkflowSelectionAsync(id)); } catch { /* retry on next pass */ }
      }
    }
    for (const task of allTasks) {
      effectiveWorkflowIdByTask.set(task.id, resolveCapacityPoolId(selectionCache.get(task.id)?.workflowId));
    }
    prefetchMs = deps.now() - prefetchStartedMs;
    if (expired()) return logPreambleTruncation(allTasks.length);

    /*
    FNXC:TaskDispatch 2026-08-09-21:04:
    Capacity and file-scope reservations are assigned in sweep evaluation order.
    After hard eligibility gates reject paused, dependency-blocked, or overlapping
    work, operators require priority first and older work before newer work within
    a priority tier. Reuse core's priority → createdAt → id comparator so this
    dispatcher and board ordering cannot drift; retain allTasks as the occupancy
    and dependency snapshot rather than changing the global listTasks order.
    */
    const tasksForReleaseEvaluation = sortTasksByPriorityThenAgeAndId(allTasks);

    let breakIndex: number | undefined;
    for (let index = 0; index < tasksForReleaseEvaluation.length; index += 1) {
      if (expired()) { breakIndex = index; break; }
      const task = tasksForReleaseEvaluation[index]!;
      if (task.paused || task.userPaused || (task.nextRecoveryAt && Date.parse(task.nextRecoveryAt) > deps.now())) continue;
      if (expired()) { breakIndex = index; break; }
      const irStartedMs = deps.now();
      const ir = await resolveWorkflowIrForTask(resolverStore, task.id, irCache, selectionCache);
      irResolveMs += deps.now() - irStartedMs;
      if (!isHeldTask(ir, task)) { evaluatedTaskIds.add(task.id); continue; }
      const column = findColumn(ir, task.column);
      const holdConfig = column ? resolveHoldConfig(column) : undefined;
      if (!column || !holdConfig) { evaluatedTaskIds.add(task.id); continue; }
      counters.heldCandidates += 1;
      const release = typeof holdConfig.release === "string" ? holdConfig.release : "manual";
      if (release === "manual" || release === "external-event") {
        trackHeld(task.id, `${release}-only`, deps.now()); result.held.push({ taskId: task.id, reason: `${release}-only` }); evaluatedTaskIds.add(task.id); continue;
      }
      let shouldRelease = false;
      if (release === "timer") {
        const deadline = resolveTimerDeadline(holdConfig, task);
        shouldRelease = deadline !== undefined && deps.now() >= deadline;
        if (!shouldRelease) { trackHeld(task.id, "timer-not-elapsed", deps.now()); result.held.push({ taskId: task.id, reason: "timer-not-elapsed" }); evaluatedTaskIds.add(task.id); continue; }
      } else if (release === "dependency") {
        const evaluation = await allDependenciesSatisfied(ctx, task, allTasks);
        if (evaluation.truncated) { result.held.push({ taskId: task.id, reason: "sweep-budget-exhausted" }); breakIndex = index + 1; break; }
        if (!evaluation.satisfied) { trackHeld(task.id, "deps-unsatisfied", deps.now()); result.held.push({ taskId: task.id, reason: "deps-unsatisfied" }); evaluatedTaskIds.add(task.id); continue; }
        shouldRelease = true;
      } else if (release === "capacity") {
        const target = resolveReleaseTarget(ir, task.column, true);
        if (!target) { trackHeld(task.id, "no-downstream-capacity-column", deps.now()); result.held.push({ taskId: task.id, reason: "no-downstream-capacity-column" }); evaluatedTaskIds.add(task.id); continue; }
        const capacity = resolveColumnCapacity(ir, target, settings);
        if (capacity.hasCapacity && Number.isFinite(capacity.limit)) {
          const workflowId = resolveCapacityPoolId(effectiveWorkflowIdByTask.get(task.id));
          const occupants = countCapacitySlot(allTasks, effectiveWorkflowIdByTask, new Set(resolveWipBudgetColumns(ir, target)), workflowId, capacity.countPending);
          if (occupants >= capacity.limit) { trackHeld(task.id, "downstream-full", deps.now()); result.held.push({ taskId: task.id, reason: "downstream-full" }); evaluatedTaskIds.add(task.id); continue; }
        }
        shouldRelease = true;
      }
      if (!shouldRelease) { evaluatedTaskIds.add(task.id); continue; }
      const target = resolveReleaseTarget(ir, task.column, release === "capacity");
      if (!target) { trackHeld(task.id, "no-release-target", deps.now()); result.held.push({ taskId: task.id, reason: "no-release-target" }); evaluatedTaskIds.add(task.id); continue; }
      /*
      FNXC:WorkflowScheduling 2026-08-28-21:24:
      The automatic sweep records readiness as a held reason and never calls the refusal-producing release path for a card nobody requested to start. Explicit promote and external-event requests still reach `issueRelease`, where FN-7648 records their durable refusal.
      */
      const readiness = await evaluateCapacityHoldReadiness(store, deps, task, ir, target);
      if (!readiness.releasable) {
        const reason = readiness.kind === "awaiting-planning"
          ? `awaiting-planning:${readiness.reason}`
          : "awaiting-approval";
        trackHeld(task.id, reason, deps.now());
        result.held.push({ taskId: task.id, reason });
        evaluatedTaskIds.add(task.id);
        continue;
      }
      // Once issueRelease starts it must complete: it may own a reservation and move transaction.
      if (expired()) { breakIndex = index; break; }
      const releaseResult = await issueRelease(store, deps, task, target, ir);
      if (releaseResult.released) { const waitedMs = deps.now() - (heldSince.get(task.id)?.sinceMs ?? deps.now()); heldSince.delete(task.id); schedulerLog.log(`Hold release for ${task.id} → ${target} after ${waitedMs}ms held (release=${release})`); result.released.push(task.id); }
      else { trackHeld(task.id, "move-rejected-or-no-slot", deps.now()); result.held.push({ taskId: task.id, reason: "move-rejected-or-no-slot" }); }
      evaluatedTaskIds.add(task.id);
    }
    if (breakIndex !== undefined) { result.budgetTruncated = true; result.unevaluatedCount = tasksForReleaseEvaluation.length - breakIndex; }
    const sweepMs = deps.now() - sweepStartedMs;
    const longestHeldMs = result.held.reduce((max, held) => Math.max(max, deps.now() - (heldSince.get(held.taskId)?.sinceMs ?? deps.now())), 0);
    const summary = `Hold-release sweep: ${sweepMs}ms (prefetch ${prefetchMs}ms, ir-resolve ${irResolveMs}ms, evaluate ${Math.max(0, sweepMs - prefetchMs - irResolveMs)}ms over ${allTasks.length} tasks), released=${result.released.length}, held=${result.held.length}`
      + (result.budgetTruncated ? `, budget-truncated unevaluated=${result.unevaluatedCount ?? 0}` : "")
      + (sweepMs > budgetMs ? `, budgetOverrunMs=${sweepMs - budgetMs}` : "")
      + `, reads(settings=${counters.settings}, tasks=${counters.tasks}, batchSelections=${counters.batchSelections}, selections=${counters.selections}, definitions=${counters.definitions}, handoffMarkers=${counters.handoffMarkers})`
      + `, scanned=${allTasks.length}, heldCandidates=${counters.heldCandidates}`
      + (longestHeldMs > 0 ? `, longest held ${longestHeldMs}ms` : "");
    if (result.budgetTruncated) schedulerLog.warn(summary);
    else if (sweepMs >= SLOW_SWEEP_WARN_MS) schedulerLog.warn(`${summary} — sweep exceeded ${SLOW_SWEEP_WARN_MS}ms and is itself the delay`);
    else if (result.released.length > 0) schedulerLog.log(summary); else schedulerLog.debug(summary);
    const stillHeld = new Set(result.held.map((held) => held.taskId));
    for (const taskId of [...heldSince.keys()]) if (evaluatedTaskIds.has(taskId) && !stillHeld.has(taskId)) heldSince.delete(taskId);
    return result;
  } finally {
    inFlightSweepProjects.delete(projectKey);
  }
}
/**
 * Issue a single release move (`moveSource: "scheduler"`). For releases into a
 * processing (capacity) column the reservation-first ordering (KTD-10) reserves
 * worktree + semaphore before the move and releases the reservation if the move
 * rejects on capacity. Its classified result lets explicit callers retain a
 * planning-gate refusal that is discovered from the locked live task.
 */
async function issueRelease(
  store: TaskStore,
  deps: HoldReleaseDeps,
  task: Task,
  target: string,
  ir: WorkflowIr,
): Promise<IssueReleaseResult> {
  const targetColumn = findColumn(ir, target);
  const targetIsProcessing = targetColumn ? resolveColumnFlags(targetColumn).countsTowardWip === true : false;

  /*
  FNXC:WorkflowScheduling 2026-08-29-00:24:
  FN-245 removes the operator force-promote override and its `allowUnplanned`
  waiver. Every release surface funnels through this choke point, so an
  unplanned or approval-held card is refused before it can enter a processing
  column; no caller can bypass either gate.
  */
  if (targetIsProcessing) {
    const readiness = await evaluateCapacityHoldReadiness(store, deps, task, ir, target);
    if (!readiness.releasable && readiness.kind === "awaiting-approval") {
      schedulerLog.debug(
        `Hold release for ${task.id} blocked — awaiting a human approval decision (status=${task.status ?? "null"}, pausedReason=${task.pausedReason ?? "null"})`,
      );
      return { released: false };
    }
    if (!readiness.releasable) {
      await checkAndRecordUnplannedExecutionBlock(store, task, ir);
      schedulerLog.debug(`Hold release for ${task.id} blocked — card is unplanned and cannot enter processing column ${target}`);
      return { released: false, rejection: "unplanned-for-execution" };
    }
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
      return { released: false };
    }
  }

  try {
    const originalColumn = task.column;
    let liveUnplanned: Task | undefined;
    /*
    FNXC:UserPausedDispatch 2026-07-21-21:45:
    Hold release must test the source column and both pause flags under the same task lock as the move. This makes an operator pause win atomically against scheduler dispatch and also replaces event-identity inference for concurrent release attempts.

    FNXC:WorkflowScheduling 2026-08-29-00:24:
    FN-245 keeps the approval gate under the task lock and removes its former
    operator waiver. A release that races an approval hold is refused on every
    surface instead of entering a processing column.

    FNXC:WorkflowScheduling 2026-08-29-00:59:
    FN-245 requires the execution-entry gate to inspect the task held by
    `moveTaskIf`'s lock, not the earlier release candidate. A replan or newly
    pending Plan Review that lands while capacity is reserved keeps the card
    held; refusal evidence is recorded after the lock releases.
    */
    const result = await store.moveTaskIf(
      task.id,
      target,
      async (live) => {
        if (live.column !== originalColumn || live.paused === true || live.userPaused === true
          || (targetIsProcessing && isTaskBlockedOnApproval(live))) {
          return false;
        }
        if (targetIsProcessing && await isUnplannedForExecution(store, live, ir)) {
          liveUnplanned = live;
          return false;
        }
        return true;
      },
      {
        /*
        FNXC:SchedulerMoveAttribution 2026-08-29-07:37:
        Scheduler hold release is a forward execution admission, not a graph/review reopen. Name
        this authority so the timeline distinguishes its deliberate todo-to-WIP dispatch from an
        unexplained automatic move; plugin move policies receive the same source literal.
        */
        moveSource: "scheduler",
        workflowMoveSource: "scheduler-hold-release",
        allocateWorktree:
          targetIsProcessing && deps.allocateWorktree
            ? (reservedNames) => deps.allocateWorktree!(task, reservedNames)
            : undefined,
      },
    );
    if (!result.moved) {
      reservation?.release();
      if (liveUnplanned) {
        await checkAndRecordUnplannedExecutionBlock(store, liveUnplanned, ir);
        schedulerLog.debug(`Hold release for ${task.id} blocked — card became unplanned before entering processing column ${target}`);
        return { released: false, rejection: "unplanned-for-execution" };
      }
      schedulerLog.log(`Hold release for ${task.id} skipped — task became paused or left ${originalColumn}`);
      return { released: false };
    }
    return { released: true };
  } catch (error) {
    if (error instanceof TransitionRejectionError && error.rejection.code === "capacity-exhausted") {
      // Lost the in-txn race for the slot — release the reservation, stay held.
      // FNXC:EngineDiagnostics 2026-07-26-08:17: capacity races re-hit every sweep while full; same class as deferred-no-slot → debug.
      reservation?.release();
      schedulerLog.debug(`Hold release for ${task.id} rejected on capacity for ${target} — staying held`);
      return { released: false };
    }
    // Any other failure: release the reservation and let the card stay held.
    reservation?.release();
    schedulerLog.warn(
      `Hold release for ${task.id} into ${target} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { released: false };
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
 * FNXC:WorkflowScheduling 2026-08-29-00:24:
 * FN-245 makes explicit promotion a non-waivable release attempt. An unplanned
 * or approval-held card remains held on every promote surface until planning
 * and any required approval genuinely complete; capacity and slot reservation
 * checks continue to protect planned cards.
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

  /*
  FNXC:WorkflowScheduling 2026-08-29-00:24:
  FN-245 replaces the synthetic skipped Plan Review result and replan-status
  clear with a terminal refusal. The explicit promotion path records the
  existing refusal evidence but cannot manufacture a waiver for plan review.
  */
  const targetColumn = findColumn(ir, target);
  const targetIsProcessing = targetColumn
    ? resolveColumnFlags(targetColumn).countsTowardWip === true
    : false;
  const unplanned = targetIsProcessing && (await isUnplannedForExecution(store, task, ir));
  if (unplanned) {
    await checkAndRecordUnplannedExecutionBlock(store, task, ir);
    return { released: false, rejection: "unplanned-for-execution", toColumn: target };
  }

  const releaseResult = await issueRelease(
    store,
    { now: () => Date.now(), reserveSlot: deps.reserveSlot, allocateWorktree: deps.allocateWorktree },
    task,
    target,
    ir,
  );
  if (!releaseResult.released) {
    return {
      released: false,
      rejection: releaseResult.rejection ?? "capacity-exhausted-or-no-slot",
      ...(releaseResult.rejection ? { toColumn: target } : {}),
    };
  }
  return { released: true, toColumn: target };
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
  void emitBoundedRunAudit(store, {
      taskId,
      agentId: "scheduler",
      runId: `hold-release:event:${taskId}`,
      domain: "database",
      mutationType: "task:hold-release-event",
      target: taskId,
      metadata: { eventTag, fromColumn: task.column },
    }, { log: schedulerLog });
  const target = resolveReleaseTarget(ir, task.column, true);
  if (!target) return { released: false, rejection: "no-release-target" };

  /*
  FNXC:WorkflowScheduling 2026-08-29-00:50:
  FN-245 requires an external-event release to report the same terminal
  unplanned refusal as manual promotion. Classify and record the refusal before
  the boolean release helper so a planning gate cannot be reported as capacity.
  */
  const targetColumn = findColumn(ir, target);
  const targetIsProcessing = targetColumn
    ? resolveColumnFlags(targetColumn).countsTowardWip === true
    : false;
  if (targetIsProcessing && await isUnplannedForExecution(store, task, ir)) {
    await checkAndRecordUnplannedExecutionBlock(store, task, ir);
    return { released: false, rejection: "unplanned-for-execution", toColumn: target };
  }

  const releaseResult = await issueRelease(
    store,
    { now: () => Date.now(), reserveSlot: deps.reserveSlot, allocateWorktree: deps.allocateWorktree },
    task,
    target,
    ir,
  );
  return releaseResult.released
    ? { released: true, toColumn: target }
    : {
        released: false,
        rejection: releaseResult.rejection ?? "capacity-exhausted-or-no-slot",
        ...(releaseResult.rejection ? { toColumn: target } : {}),
      };
}
