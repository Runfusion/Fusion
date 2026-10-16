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
  isFailedWipPark,
  sortTasksByQueueOrder,
  TransitionRejectionError,
  resolveWorkflowIrForTask,
  isUnplannedSeedPrompt,
  isDuplicateRedirectOnlyPrompt,
  isFastExecutionMode,
  PLAN_PREMISE_REJECTION_METADATA_KEY,
  isWorkflowOptionalGroupEnabled,
  resolveEffectiveAutoMerge,
  isTaskBlockedOnApproval,
  isPlanReviewSatisfied,
  type PlanPremiseRejectionEpisode,
  /* FNXC:HumanPlanApproval 2026-09-15-06:24: FN-408 per-card decision gate. */
  isHumanPlanApprovalEnabled,
  isHumanPlanApprovalPending,
  type TaskStore,
  type Task,
  type TaskReleaseGateVerdict,
  type WorkflowIr,
  type WorkflowIrNode,
  type WorkflowIrV2,
  type WorkflowIrColumn,
  type WorkflowSelectionCache,
  type WorkflowSelectionReadTally,
  type WorkflowDefinitionReadTally,
  type WorkflowIrResolverStore,
} from "@fusion/core";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { schedulerLog } from "../logger.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { getPromptPath } from "./spec-staleness.js";
import { isTaskPlanningOrExecutionLive } from "../agents/planning-execution-liveness.js";
import { evaluateStrandedHoldContinuation } from "../plan-review-continuation.js";
import { checkPlanPremises, type PlanPremiseCheckResult } from "./plan-premise-check.js";
import {
  advancePlanPremiseRejectionEpisode,
  buildPlanPremiseExhaustedError,
  isPlanPremiseParkTerminal,
  PLAN_PREMISE_REFUSAL_LOG_WINDOW_MS,
  TRIAGE_PLAN_PREMISE_INVALIDATED_BY_DELIVERY_LOG_ACTION,
  TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION,
  type PlanPremiseEscalation,
} from "./plan-premise-ladder.js";

// FNXC:StrandedHoldContinuation 2026-07-26-14:15:
// A genuine stranded-plan fault is warned once per held location; ordinary
// unplanned cards remain quiet even when the release sweep revisits them.
const strandedHoldWarningMemo = new Set<string>();

/** A reservation handle returned by {@link HoldReleaseDeps.reserveSlot}. The
 *  sweep calls `release()` if the subsequent move rejects on capacity. */
export interface SlotReservation {
  release(): void;
  /** Revalidate external admission facts under the task move lock after reserving capacity. */
  validateAdmission?: (task: Task) => boolean | Promise<boolean>;
}

/*
FNXC:HoldReleaseAttribution 2026-09-09-21:15 (RUFU-209):
The sweep's `evaluate=<ms>` token had no structure, so when it dominated the sweep budget
(field evidence: boards of 151-215 tasks took 2132-10327 ms per sweep — 71 of 76 logged sweeps
over the 2000 ms warn threshold, one 20117 ms — with the evaluate residual alone sampled at
2012-8928 ms) the operator could not tell which sub-phase to cut, and the same task's
PROMPT.md / work-item list / settings were re-read by every consumer of the same scheduler pass —
twice for an ordinary card, three times when a second card depends on it. This pass object is the
per-scheduler-pass observation record: it accumulates non-overlapping phase timings and memoises
STABLE INPUT FACTS (prompt contents, work-item list, settings snapshot) keyed by task id for the
pass only. It is deliberately never module-scoped — a cross-pass cache would be a stale-read bug.
Computed release VERDICTS are never cached here; only the facts a verdict reads.
*/

/** A settings snapshot as the sweep's own store returns it (structural to avoid a new import). */
type HoldReleaseSettingsSnapshot = Awaited<ReturnType<TaskStore["getSettings"]>>;
/** A workflow work item row, taken from the store reader's own return type. */
type WorkflowWorkItemRow = NonNullable<Awaited<ReturnType<TaskStore["listWorkflowWorkItemsForTask"]>>>[number];

/** Per-scheduler-pass observation: phase timings + memoised stable input facts. */
export interface HoldReleasePass {
  /** Controllable clock (ms) so phase durations are exact under fake timers. */
  now: () => number;
  /** Accumulated ms per named phase bucket. Leaves are subtracted from the coarser net that contains them. */
  phases: Map<string, number>;
  /** PROMPT.md contents per task id for THIS pass only (a stable input fact, not a verdict). */
  promptMemo: Map<string, string | null>;
  /** Workflow work items per task id for THIS pass only. `null` records "this store exposes no reader". */
  workItemMemo: Map<string, WorkflowWorkItemRow[] | null>;
  /** Memoised settings snapshot for THIS pass (prefetched once at the top of the sweep). */
  settings?: HoldReleaseSettingsSnapshot;
  /** The sweep's read tally. Present only for sweep-created passes so memo-backed helpers can
   *  count the round trips they ACTUALLY perform (cache hits cost nothing and must not be
   *  counted); direct scheduler callers create passes without a tally. RUFU-209. */
  counters?: SweepCounters;
  /** Record the wall time of `fn` under `name` (a leaf). */
  time<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  /** Record `fn`'s wall time MINUS the time already recorded by nested `time`/`net` calls (a net). */
  net<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  /** Total ms recorded so far (used by `net` to subtract nested leaves). */
  recordedMs(): number;
  /*
  FNXC:HoldReleaseSlotAttribution 2026-10-16-17:19 (RUFU-698 Step 1):
  The `slot` bucket was the sweep's only un-attributed giant (field: `slot=13770ms` inside a 30038ms
  sweep with `released=0`), but the work behind it lives inside the scheduler's `reserveSlot` closure,
  which the sweep cannot see into. `slotChildren` holds FULL wall ms per `slot:*` child so the
  reservation leg becomes measurable at call granularity. Children deliberately do NOT go through
  `phases`/`recorded`: a child that contained an inner sweep net (e.g. `unplanned`, which
  `isUnplannedForExecution` records itself) would be subtracted twice — once from `slot` and once from
  the child — which would shrink `slot` and inflate `unattributed` while leaving the reconciling list
  wrong. Keeping them in a separate map is what preserves both contracts at once: the printed
  `(release-config=…, unattributed=…)` list keeps its exact meaning, and `sum(slotChildren) ≤
  netWallMs("slot")` holds by construction because every child is a sequential wall window inside the
  slot window.
  */
  slotChildren: Map<string, number>;
  /** FULL wall ms per `net()` bucket name. Never printed in the reconciling list; used to bound `slotChildren`. */
  netWallMs: Map<string, number>;
  /** Capacity reservations THIS pass performed — the divisor that turns a `slot` total into a per-call cost. */
  slotCalls: number;
  /** Record `fn`'s FULL wall time under a `slot:*` child name without touching the reconciling buckets. */
  wall<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
}

/** Build a fresh per-pass observation record. Never reuse across passes. */
function createHoldReleasePass(now: () => number, counters?: SweepCounters): HoldReleasePass {
  const phases = new Map<string, number>();
  const slotChildren = new Map<string, number>();
  const netWallMs = new Map<string, number>();
  let recorded = 0;
  const add = (name: string, ms: number): void => {
    phases.set(name, (phases.get(name) ?? 0) + ms);
    recorded += ms;
  };
  const pass: HoldReleasePass = {
    now,
    phases,
    slotChildren,
    netWallMs,
    slotCalls: 0,
    promptMemo: new Map(),
    workItemMemo: new Map(),
    counters,
    recordedMs: () => recorded,
    async wall<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
      const start = now();
      const value = await fn();
      slotChildren.set(name, (slotChildren.get(name) ?? 0) + Math.max(0, now() - start));
      return value;
    },
    async time<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
      const start = now();
      const value = await fn();
      add(name, Math.max(0, now() - start));
      return value;
    },
    async net<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
      const start = now();
      const before = recorded;
      const value = await fn();
      const wallMs = Math.max(0, now() - start);
      // Net = wall time minus everything attributed inside `fn`, so buckets stay non-overlapping.
      add(name, Math.max(0, wallMs - (recorded - before)));
      netWallMs.set(name, (netWallMs.get(name) ?? 0) + wallMs);
      return value;
    },
  };
  return pass;
}

/**
 * Read a task's PROMPT.md through the pass memo. Returns `null` for a missing/unreadable prompt or
 * a store without a tasks dir — the same "no prompt" signal each caller already handled in a catch.
 * Without a pass (direct scheduler callers) it reads the file every time, preserving prior behavior.
 */
async function readPromptObs(pass: HoldReleasePass | undefined, store: TaskStore, taskId: string): Promise<string | null> {
  let attempted = false;
  const read = async (): Promise<string | null> => {
    try {
      const tasksDir = (store as { getTasksDir?: () => string }).getTasksDir?.();
      if (!tasksDir) return null;
      attempted = true;
      return await readFile(getPromptPath(tasksDir, taskId), "utf-8");
    } catch {
      return null;
    }
  };
  if (!pass) return read();
  if (pass.promptMemo.has(taskId)) return pass.promptMemo.get(taskId) ?? null;
  const value = await pass.time("prompt", read);
  // RUFU-209: count the PROMPT.md read that actually happened. A memo hit performs no I/O and
  // must stay uncounted — the sweep summary's `prompts=` field is the honest per-pass read tally.
  if (attempted && pass.counters) pass.counters.prompts += 1;
  pass.promptMemo.set(taskId, value);
  return value;
}

/**
 * Read a task's workflow work items through the pass memo. Returns `null` when the store exposes no
 * such reader — matching the unplanned gate's `typeof !== "function"` guard and the stranded block's
 * absent-reader case (which threw into its catch and stayed quiet). Without a pass it reads every time.
 */
async function listWorkItemsObs(pass: HoldReleasePass | undefined, store: TaskStore, taskId: string): Promise<WorkflowWorkItemRow[] | null> {
  let attempted = false;
  const read = async (): Promise<WorkflowWorkItemRow[] | null> => {
    if (typeof store.listWorkflowWorkItemsForTask !== "function") return null;
    attempted = true;
    return (await store.listWorkflowWorkItemsForTask.call(store, taskId)) ?? [];
  };
  if (!pass) return read();
  if (pass.workItemMemo.has(taskId)) return pass.workItemMemo.get(taskId) ?? null;
  const value = await pass.time("workitem", read);
  // RUFU-209: honest per-pass tally of work-item reads actually issued (memo hits cost nothing).
  if (attempted && pass.counters) pass.counters.workItems += 1;
  pass.workItemMemo.set(taskId, value);
  return value;
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
  /**
   * `pass` (RUFU-209) is the sweep's per-pass observation record, threaded so a scheduler-provided
   * reservation can share the pass's prompt memo (its own planning guard re-checks the SAME snapshot
   * task the sweep just checked) and record its cost into the `slot` phase instead of vanishing from
   * attribution. Callers that do not pass it keep their own live read.
   */
  reserveSlot?: (task: Task, targetColumn: string, pass?: HoldReleasePass) => SlotReservation | null | Promise<SlotReservation | null>;
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
  /** Cards moved to the front of this pass because a truncated pass never evaluated them (RUFU-698). */
  rotatedDeferredCount?: number;
}

export type WipAdmissionRejection =
  | "unplanned-for-execution"
  | "plan-premise-stale"
  | "plan-premise-invalid"
  | "plan-premise-unavailable"
  /*
  FNXC:PlanPremises 2026-09-16-04:08:
  RUFU-246 — the terminal refusal. The card was refused for the identical premise violation three
  times and parked (`failed` + PLAN PREMISE CONTRACT EXHAUSTED sentinel); every release entry point
  short-circuits to this code without re-evaluating anything until an operator Retry/Reset clears
  the refusal episode. Non-retryable by policy (the dashboard classifies it so).
  */
  | "plan-premise-exhausted"
  | "capacity-exhausted-or-no-slot"
  | "source-changed";

export type WipAdmissionResult =
  | { released: true; task: Task }
  | { released: false; rejection?: WipAdmissionRejection; detail?: string };

type IssueReleaseResult = WipAdmissionResult;

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
  pass?: HoldReleasePass,
): Promise<void> {
  const recorder = (store as Partial<Pick<TaskStore, "checkAndRecordUnplannedExecutionBlock">>).checkAndRecordUnplannedExecutionBlock;
  if (!recorder) return;
  const planReviewNode = resolvePreReleasePlanReviewNode(ir)?.id ?? "none";
  let promptContent = typeof task.prompt === "string" ? task.prompt : "";
  const tasksDir = typeof store.getTasksDir === "function" ? store.getTasksDir() : undefined;
  if (tasksDir) {
    // RUFU-209: route through the pass memo so the durable refusal marker shares the PROMPT.md read
    // the readiness gate already paid for this pass. A failed/absent read still yields the empty
    // content → `missing` marker, exactly as the old direct readFile + catch did.
    promptContent = (await readPromptObs(pass, store, task.id)) ?? "";
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
  /* FNXC:HumanPlanApproval 2026-09-15-06:24: FN-408's per-card decision hold is its OWN reason, distinct from the revision-cap and generic approval parks. */
  reason: "plan-review-pending" | "human-plan-approval-pending" | "planning-status" | "needs-replan" | "duplicate-prompt" | "seed-prompt" | null;
  readyAtCapacityBoundary: boolean;
  planReview?: NonNullable<TaskReleaseGateVerdict["planReview"]>;
}

/*
FNXC:PromoteVisibility 2026-08-11-20:38:
Release dispatch and board enrichment consume one structured decision so the browser does not keep a
second gate. Continuations, PROMPT.md, and workflow IR are invisible to the browser, so verdicts carry expiry evidence.
*/
export async function evaluateUnplannedForExecution(store: TaskStore, task: Task, ir: WorkflowIr, pass?: HoldReleasePass): Promise<UnplannedForExecutionEvaluation> {
  if (!pass) return evaluateUnplannedForExecutionInner(store, task, ir, undefined);
  // Net: the unplanned gate's own CPU/gating time, excluding the prompt/workitem leaves it records.
  return pass.net("unplanned", () => evaluateUnplannedForExecutionInner(store, task, ir, pass));
}

async function evaluateUnplannedForExecutionInner(store: TaskStore, task: Task, ir: WorkflowIr, pass: HoldReleasePass | undefined): Promise<UnplannedForExecutionEvaluation> {
  const preReleaseReview = resolvePreReleasePlanReviewNode(ir);
  const defaultOn = (preReleaseReview?.config as { defaultOn?: boolean } | undefined)?.defaultOn ?? false;
  const enabled = preReleaseReview ? isWorkflowOptionalGroupEnabled(task.enabledWorkflowSteps, preReleaseReview.id, defaultOn) : false;
  const appliesToColumn = preReleaseReview?.column === task.column;
  const satisfied = task.workflowStepResults?.some(isPlanReviewSatisfied) === true;
  const planReview = preReleaseReview ? { nodeId: preReleaseReview.id, column: preReleaseReview.column!, defaultOn, enabled, appliesToColumn, satisfied } : undefined;
  let readyAtCapacityBoundary = false;
  /*
  FNXC:HumanPlanApproval 2026-09-15-06:24:
  FN-408 — the per-card human requirement has priority over Fast and over project auto-approve-all.
  Fast is planless by design and normally short-circuits the Plan Review wait below, so an armed card
  must keep that wait: its mandated order is plan -> Plan Review -> human decision -> execution.

  FNXC:HumanPlanApproval 2026-09-15-07:30:
  Since the remediation, `isFastExecutionMode` already reports an armed card as non-fast (Fast is
  neutralized at creation/update AND in that shared predicate, so triage plans the card and the
  graph does not bypass plan review). The explicit `|| humanApprovalArmed` stays as a local, readable
  statement of the invariant — this gate must never be the place that lets an armed card through.
  */
  const humanApprovalArmed = isHumanPlanApprovalEnabled(task);
  if ((!isFastExecutionMode(task) || humanApprovalArmed) && preReleaseReview && enabled && appliesToColumn && !satisfied) {
    if (typeof store.listWorkflowWorkItemsForTask !== "function") return { unplanned: true, reason: "plan-review-pending", readyAtCapacityBoundary, planReview };
    const active = (await listWorkItemsObs(pass, store, task.id) ?? []).filter((item) => ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state));
    readyAtCapacityBoundary = active.some((item) => item.waitReason === "capacity" && item.sourceColumn === task.column);
    if (!readyAtCapacityBoundary) return { unplanned: true, reason: "plan-review-pending", readyAtCapacityBoundary, planReview };
  }
  /*
  FNXC:HumanPlanApproval 2026-09-15-06:24:
  FN-408 — THE convergence point. Every release surface (background hold release, explicit promote,
  expedite, direct move, event release, restart recovery) reaches execution through this evaluation,
  so the per-card decision is enforced once here instead of in each caller. It is deliberately NOT
  keyed on `task.status`: a stop between persisting the satisfied Plan Review result and publishing
  `awaiting-approval` would otherwise leave an open execution window. Planning and review columns are
  unaffected because this evaluation only gates release into a capacity-bearing column.
  */
  if (humanApprovalArmed && isHumanPlanApprovalPending(task)) {
    return { unplanned: true, reason: "human-plan-approval-pending", readyAtCapacityBoundary: false, planReview };
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
  const prompt = await readPromptObs(pass, store, task.id);
  if (prompt === null) return { unplanned: false, reason: null, readyAtCapacityBoundary, planReview };
  if (isDuplicateRedirectOnlyPrompt(prompt, task.title)) return { unplanned: true, reason: "duplicate-prompt", readyAtCapacityBoundary, planReview };
  const unplanned = isUnplannedSeedPrompt(prompt, task.id, task.title, task.description);
  return { unplanned, reason: unplanned ? "seed-prompt" : null, readyAtCapacityBoundary, planReview };
}

/** Compatibility wrapper retained for scheduler and release callers. `pass` shares the prompt memo
 *  across every consumer of one scheduler pass (RUFU-209); a caller that passes no `pass` keeps its
 *  own live read. */
export async function isUnplannedForExecution(store: TaskStore, task: Task, ir: WorkflowIr, pass?: HoldReleasePass): Promise<boolean> {
  return (await evaluateUnplannedForExecution(store, task, ir, pass)).unplanned;
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
  pass?: HoldReleasePass,
): Promise<CapacityHoldReadiness> {
  if (!pass) return evaluateCapacityHoldReadinessInner(store, deps, task, ir, targetColumnId, undefined);
  // Net: the readiness gate's own gating time, excluding the unplanned/prompt/work-item work it records.
  return pass.net("readiness", () => evaluateCapacityHoldReadinessInner(store, deps, task, ir, targetColumnId, pass));
}

async function evaluateCapacityHoldReadinessInner(
  store: TaskStore,
  deps: HoldReleaseDeps,
  task: Task,
  ir: WorkflowIr,
  targetColumnId: string,
  pass: HoldReleasePass | undefined,
): Promise<CapacityHoldReadiness> {
  const targetColumn = findColumn(ir, targetColumnId);
  const targetIsProcessing = targetColumn ? resolveColumnFlags(targetColumn).countsTowardWip === true : false;
  if (!targetIsProcessing) return { releasable: true };
  if (isTaskBlockedOnApproval(task)) {
    return { releasable: false, kind: "awaiting-approval", reason: "awaiting-approval" };
  }

  const evaluation = await evaluateUnplannedForExecution(store, task, ir, pass);
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
      // RUFU-209: the unplanned gate above may already have read this task's prompt for the pass;
      // reuse the memo, and reuse the sweep's prefetched settings snapshot rather than re-reading it.
      const promptContent = await readPromptObs(pass, store, task.id);
      let settings = pass?.settings;
      if (!settings) {
        settings = await store.getSettings();
        // RUFU-209: the sweep prefetches settings once; a fallback read here is real extra work and
        // must show up in the summary as `evalSettings>0` instead of hiding behind `settings=1`.
        if (pass?.counters) pass.counters.evalSettings += 1;
      }
      const continuations = await listWorkItemsObs(pass, store, task.id);
      if (!continuations) throw new Error("no-work-item-reader");
      /*
      FNXC:PlanningExecutionLiveness 2026-09-06-00:29:
      This shared liveness classification only suppresses a stranded-continuation warning; it does not
      widen or release the execution gate. Including the planner here keeps diagnostics aligned with the
      self-healing decisions without turning an in-flight plan into a release candidate.
      */
      const live = isTaskPlanningOrExecutionLive(task.id, { isTaskActive: deps.isTaskActive });
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
  return dep.column === "done" || dep.column === "in-review";
}

/**
 * KTD-5 dependency satisfaction: the dependency task's current column has the
 * `complete` trait flag in ITS resolved workflow. Dual-accept (FN-5719): the
 * legacy completion signal (done/in-review column, or an accepted
 * completion-handoff marker) is also honored; when the two disagree an
 * audit-diff event is logged.
 */
type DependencyEvaluation = { satisfied: boolean; truncated: boolean };
type SweepCounters = { settings: number; tasks: number; batchSelections: number; selections: number; definitions: number; handoffMarkers: number; prompts: number; workItems: number; evalSettings: number; heldCandidates: number };
type SweepCtx = {
  store: TaskStore;
  resolverStore: WorkflowIrResolverStore;
  irCache: Map<string, WorkflowIr>;
  selectionCache: WorkflowSelectionCache;
  handoffMemo: Map<string, boolean>;
  /**
   * RUFU-209: per-pass non-truncated verdict per dependency id. `handoffMemo` only de-duplicated the
   * marker read; two cards depending on the same unfinished task still re-resolved its IR and
   * re-emitted `merge:dependency-parity-diff` once each. The verdict is pure over pass-stable inputs
   * (IR + selection + marker are all memoised), so computing it once per dependency id and reusing it
   * changes no release decision — it just stops the redundant pass. Truncated (budget) results are
   * deliberately NOT stored, so a card re-entered under budget still gets a fresh, non-truncated answer.
   */
  dependencyMemo: Map<string, DependencyEvaluation>;
  counters: SweepCounters;
  expired: () => boolean;
  pass: HoldReleasePass;
};

async function dependencySatisfied(ctx: SweepCtx, dep: Task): Promise<DependencyEvaluation> {
  if (ctx.expired()) return { satisfied: false, truncated: true };
  /*
  FNXC:HoldReleaseAttribution 2026-09-09-23:25 (RUFU-209):
  Every edge used to re-run the dependency's readiness decision — IR resolve, handoff-marker
  read, column scan — so a fan-out board (K cards on one dependency) paid K× for the same
  answer. The decision is a pure function of the dependency's ROW in this pass's board snapshot
  plus pass-cached facts, so it is memoised per distinct dependency id for THIS PASS only
  (ctx.dependencyMemo dies with the pass). Budget-truncated outcomes never reach the memo: the
  expiry checks above return before the memo write, so a timing cut is never laundered into a
  durable "unsatisfied" verdict for later dependents.
  */
  const memo = ctx.dependencyMemo.get(dep.id);
  if (memo) return memo;
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
      markerAccepted = (await ctx.pass.time("handoff", () => ctx.store.getCompletionHandoffAcceptedMarker(dep.id))) !== null;
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
  const result: DependencyEvaluation = { satisfied: completeFlag || legacy, truncated: false };
  ctx.dependencyMemo.set(dep.id, result);
  return result;
}

/**
 * RUFU-209: the sweep's `dependency` phase = one card's whole dependency-gate wall time, with the
 * handoff-marker leaf subtracted so `handoff` is not double-counted. Memoised verdicts make the
 * shared-dependency re-check near-instant, so the recorded time reflects real work, not re-derivation.
 */
async function evaluateDependenciesPhase(ctx: SweepCtx, task: Task, allTasks: Task[]): Promise<DependencyEvaluation> {
  return ctx.pass.net("dependency", () => allDependenciesSatisfied(ctx, task, allTasks));
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
 *
 * FNXC:ColumnCapacity 2026-10-10-19:52 (RUFU-362): the mirror holds only while the
 * failed-park exclusion is present here too. This loop previously counted every
 * non-deleted row, so a lane filled with `status:"failed"` parks reported itself full
 * and this sweep refused to release a ready card into it (`downstream-full`) even
 * though live WIP was zero — the mirror agreed with the store while BOTH disagreed
 * with FN-8704. Occupancy now filters through `isFailedWipPark`, the same predicate
 * `isRunningAgentTask` and both store counters use, so the four consumers cannot drift
 * again: the exclusion sits before BOTH count arms, so a dead row also cannot keep a
 * `transitionPending` reservation on the column.
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
    // Dead parks hold no slot — see `isFailedWipPark` for the ruling and its history.
    if (isFailedWipPark(t)) continue;
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
/*
FNXC:HoldReleaseTruncationRotation 2026-10-16-19:56 (RUFU-698 Step 3):
A budget-truncated pass stops at `breakIndex`, and the next pass re-sorts the SAME list into the SAME
order (core's priority → createdAt → id comparator is deterministic), so the cards behind the break are
re-skipped every single time. Field evidence: `budget-truncated unevaluated=444` on every pass of a
642-task project while `released=0` and `capacity_refused=0` — that is a starved tail, not saturation.
Recording the tail per project key and evaluating it FIRST on the next pass is a deliberate BOUNDED
priority inversion: a card the sweep never examined goes before cards it never competed with. It is
bounded twice — to `MAX_ROTATED_DEFERRED_IDS`, keeping the front of the tail because that is the part
the next pass would reach anyway — and it ends by construction at the first pass that finishes inside
its budget, which deletes the entry.
*/
const MAX_ROTATED_DEFERRED_IDS = 500;
const deferredTailsByProject = new Map<string, string[]>();
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

/** Put the previously-deferred cards first, keeping queue order WITHIN each partition. */
function rotateDeferredToFront(
  ordered: Task[],
  deferredIds: readonly string[] | undefined,
): { tasks: Task[]; rotatedCount: number } {
  if (!deferredIds || deferredIds.length === 0) return { tasks: ordered, rotatedCount: 0 };
  const deferred = new Set(deferredIds);
  const first: Task[] = [];
  const rest: Task[] = [];
  // Ids that left the board simply never appear, so a stale tail cannot shift any other card.
  for (const task of ordered) (deferred.has(task.id) ? first : rest).push(task);
  if (first.length === 0) return { tasks: ordered, rotatedCount: 0 };
  return { tasks: [...first, ...rest], rotatedCount: first.length };
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
  // RUFU-698: rotation state is per-process test-isolated state, and 11 suites call this between files.
  deferredTailsByProject.clear();
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
    const counters: SweepCounters = { settings: 0, tasks: 0, batchSelections: 0, selections: 0, definitions: 0, handoffMarkers: 0, prompts: 0, workItems: 0, evalSettings: 0, heldCandidates: 0 };
    const resolverStore = createCountingResolverStore(store, counters);
    // RUFU-209: one observation record per scheduler pass — phase timings + per-pass fact memos.
    // Never module-scoped: a cross-pass cache would serve stale prompt/settings reads.
    const pass = createHoldReleasePass(deps.now, counters);
    const ctx: SweepCtx = { store, resolverStore, irCache, selectionCache, handoffMemo: new Map(), dependencyMemo: new Map(), counters, expired, pass };
    /*
    FNXC:HoldReleaseAttribution 2026-09-09-23:25 (RUFU-209):
    The phase buckets in the sweep summary, in one shared definition so BOTH summary sites
    (preamble budget-truncation and the full line) print the same field set. The buckets are
    disjoint by construction: every wrapper is recorded with `net`, which subtracts the time its
    nested buckets already claimed, so the listed values plus `unattributed` reconcile to
    `evaluate` — `unattributed` is the honest residual, never a hidden slice.
    */
    const PHASE_ORDER = ["release-config", "dependency", "readiness", "issue-release", "prompt", "unplanned", "workitem", "handoff", "slot"] as const;
    /*
    FNXC:HoldReleaseSlotAttribution 2026-10-16-17:19 (RUFU-698 Step 1):
    Printed as its OWN group after the reconciling parenthesis, never inside it: the existing
    `(release-config=…, slot=…, unattributed=…)` list is an operator contract (docs/diagnostics.md) and
    is asserted literally by hold-release-sweep-evaluate-attribution.test.ts. `slot-calls` is the field
    that replaces an inference with a measurement — before it, a `slot=12074ms` line with `released=0`
    and `held=5` only allowed a ~2s-per-call guess, because the handful of candidates that reached the
    reservation line was unknown.
    */
    const SLOT_PHASE_ORDER = ["slot:dispatch-guard", "slot:scope", "slot:claim-snapshot", "slot:admission", "slot:lease-write"] as const;
    const slotFields = (): string => {
      const named = SLOT_PHASE_ORDER.filter((name) => pass.slotChildren.has(name));
      // An unlisted child is still printed (sorted) — an unexpected cost must not be silently dropped.
      const extra = [...pass.slotChildren.keys()].filter((name) => !(SLOT_PHASE_ORDER as readonly string[]).includes(name)).sort();
      const children = [...named, ...extra];
      if (children.length === 0) return `, slot-calls=${pass.slotCalls}`;
      /*
      FNXC:HoldReleaseSlotAttribution 2026-10-16-17:19 (RUFU-698 Step 1):
      `slot:residual` is the slot WINDOW minus every named child, so the detail group reconciles with
      the reservation leg the same way `unattributed` reconciles the phase list. A cost nobody named is
      therefore visible as a number instead of disappearing, which is what makes the next step (cut the
      dominant child) decidable from one log line.
      */
      const residualMs = Math.max(0, (pass.netWallMs.get("slot") ?? 0) - [...pass.slotChildren.values()].reduce((sum, ms) => sum + ms, 0));
      const parts = children.map((name) => `${name}=${Math.max(0, pass.slotChildren.get(name) ?? 0)}ms`);
      if (residualMs > 0) parts.push(`slot:residual=${residualMs}ms`);
      return `, slot-calls=${pass.slotCalls}, slot-detail=(${parts.join(", ")})`;
    };
    const phasesSummary = (evaluateMs: number): string => {
      const bucket = (name: string): number => Math.max(0, pass.phases.get(name) ?? 0);
      const attributedMs = PHASE_ORDER.reduce((sum, name) => sum + bucket(name), 0);
      return ` (${PHASE_ORDER.map((name) => `${name}=${bucket(name)}ms`).join(", ")}, unattributed=${Math.max(0, evaluateMs - attributedMs)}ms)`;
    };
    const prefetchStartedMs = sweepStartedMs;
    let prefetchMs = 0;
    let irResolveMs = 0;
    const logPreambleTruncation = (unevaluatedCount: number): HoldReleaseResult => {
      prefetchMs = deps.now() - prefetchStartedMs;
      const sweepMs = deps.now() - sweepStartedMs;
      const summary = `Hold-release sweep: project=${projectKey}: ${sweepMs}ms (prefetch ${prefetchMs}ms, ir-resolve ${irResolveMs}ms, evaluate 0ms over ${unevaluatedCount} tasks${phasesSummary(0)})${slotFields()}, released=0, held=0`
        + `, budget-truncated unevaluated=${unevaluatedCount}`
        + (sweepMs > budgetMs ? `, budgetOverrunMs=${sweepMs - budgetMs}` : "")
        + `, reads(settings=${counters.settings}, tasks=${counters.tasks}, batchSelections=${counters.batchSelections}, selections=${counters.selections}, definitions=${counters.definitions}, handoffMarkers=${counters.handoffMarkers}, prompts=${counters.prompts}, workItems=${counters.workItems}, evalSettings=${counters.evalSettings}), scanned=0, heldCandidates=0`;
      schedulerLog.warn(summary);
      return { ...result, budgetTruncated: true, unevaluatedCount };
    };

    counters.settings += 1;
    const settings = await store.getSettings();
    pass.settings = settings;
    if (expired()) return logPreambleTruncation(0);
    counters.tasks += 1;
    /*
    FNXC:WorkflowScheduling 2026-09-05-23:12:
    listTasks used to hide N individual selection reads behind one list call, making this diagnostic
    claim selections=0. Its reported tally is folded in directly: cache-size growth is not evidence,
    because both a successful batch and degraded individual reads populate the same cache.
    */
    const selectionReadTally: WorkflowSelectionReadTally = { batched: 0, singles: 0 };
    const definitionReadTally: WorkflowDefinitionReadTally = { definitions: 0 };
    /*
    FNXC:WorkflowScheduling 2026-09-08-04:11:
    List hydration uses the raw store and its observed-read tally; evaluation uses the counting proxy.
    Each definition read uses exactly one accounting mechanism, since cache growth is not read evidence.
    */
    /*
    FNXC:ListTasksDeriveOptOut 2026-09-09-00:55 (RUFU-202):
    This full-board read is the engine's single most expensive one. Live it measured avg 10.6 s /
    max 159.8 s once per scheduler pass, with `prefetch` at ~100 % of the sweep and `evaluate` at
    0 ms, so it starved dispatch (`[backlog-pressure] todo=11 inProgress=0`), left 489 passes
    budget-truncated, and forced scheduler/continuation-drain/triage guard openings.

    A field-read audit over all 1118 lines of this file proves no consumer reads a derived UI signal:
    none of `inReviewStall`, `stalePausedReview`, `inReviewStalled`, `stalePausedTodo`, `ageStaleness`,
    `stalledReview`, `retrySummary`, `stallReason`, `reviewBypass`, `timedExecutionMs` appears here,
    while release decisions do read persisted fields (`column`, `status`, `paused`/`userPaused`/
    `pausedReason`, `nextRecoveryAt`, `columnMovedAt`, `dependencies`, `enabledWorkflowSteps`,
    `workflowStepResults`, `approvedPlanFingerprint`, `prompt`, `title`, `description`, timestamps).
    UI-signal derivation is therefore pure cost at this call site.

    The selection read this sweep still needs is not lost with the derivation feed: the batch fallback
    below resolves every id through `getTaskWorkflowSelectionsAsync(missingIds)` in one round trip, so
    `selectionReadTally` reports 0 from `listTasks` while `counters.batchSelections` counts that batch
    and the logged read tally stays truthful. All three accounting objects are still passed so a future
    caller that re-enables derivation gets the shared caches back.

    FNXC:WorkflowScheduling 2026-09-09-15:10 (origin/main sync):
    Upstream concurrently added `definitionReadTally` (its own comment above) to this same call. The two
    changes compose: upstream accounts for workflow-definition reads, while derivation and the log column
    stay switched off here. Do not drop either half — removing `derive: false`/`excludeLog: true` restores
    the 10.6 s avg board read; removing `definitionReadTally` loses upstream's read accounting.

    FNXC:ListTasksExcludeLog 2026-09-09-01:49 (RUFU-202):
    `excludeLog` is the second, bigger half: `log` is ~11 KB/row and this sweep never reads it, nor
    does any of the 14 `@fusion/core` helpers it calls with a task (`resolveColumnCapacity`,
    `isUnplannedSeedPrompt`, `isTaskBlockedOnApproval`, `isPlanReviewSatisfied`, ...) — none touches
    `task.log`, and the log-backed merge/heal readers that do exist (`hasAutoHealableVerification
    BufferFailure`) are reached from the merge lane, not from here.

    Two cheaper-looking variants are deliberately NOT used because each costs more than it saves:
    - `slim: true` also drops `log`, but it bundles the drop with `finalizeSlimListTask`, which
      re-parses PROMPT.md for every task whose persisted `steps` is empty via the unmemoised
      `parseStepsFromPromptImpl` — one `existsSync` + `readFile` per such task, per pass, on the
      sweep's hot path. It additionally blanks `prInfo`/`review`/`attachments` and can newly populate
      `steps`, and the sweep's own release decisions must not shift as a side effect of a bandwidth
      change. `excludeLog` buys the same byte saving with neither.
    - `excludeColumns: ["log"]` is not a column projection at all: it filters board LANES, and setting
      it also switches off `listTasksImpl`'s `excludeColumn: "archived"` narrowing, which would put
      archived cards back into a release-decision pass.
    */
    const allTasks = await store.listTasks({ includeArchived: false, selectionCache, selectionReadTally, irCache, definitionReadTally, derive: false, excludeLog: true });
    counters.batchSelections += selectionReadTally.batched;
    counters.selections += selectionReadTally.singles;
    counters.definitions += definitionReadTally.definitions;
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
    const tasksForReleaseEvaluation = (() => {
      // RUFU-698: the cards the last truncated pass never reached get their turn first (see helper).
      const rotation = rotateDeferredToFront(sortTasksByQueueOrder(allTasks), deferredTailsByProject.get(projectKey));
      if (rotation.rotatedCount > 0) result.rotatedDeferredCount = rotation.rotatedCount;
      return rotation.tasks;
    })();

    let breakIndex: number | undefined;
    for (let index = 0; index < tasksForReleaseEvaluation.length; index += 1) {
      if (expired()) { breakIndex = index; break; }
      const task = tasksForReleaseEvaluation[index]!;
      if (task.paused || task.userPaused || (task.nextRecoveryAt && Date.parse(task.nextRecoveryAt) > deps.now())) continue;
      /*
      FNXC:PlanPremises 2026-09-16-04:08:
      RUFU-246 — a premise-exhausted park is skipped here, at the top of the candidate loop and
      before the per-task IR resolve: a parked card draws no PROMPT.md read (`reads(prompts=…)`
      stays flat), no premise evaluation, no reservation, no refusal log, and no audit row on later
      passes. Like the paused-skip above it is deliberately NOT marked evaluated — it was not.
      */
      if (isPlanPremiseParkTerminal(task)) continue;
      if (expired()) { breakIndex = index; break; }
      const irStartedMs = deps.now();
      const ir = await resolveWorkflowIrForTask(resolverStore, task.id, irCache, selectionCache);
      irResolveMs += deps.now() - irStartedMs;
      if (!isHeldTask(ir, task)) { evaluatedTaskIds.add(task.id); continue; }
      /*
      FNXC:HoldReleaseAttribution 2026-09-09-23:25 (RUFU-209):
      The release-config decision — hold-kind resolution, manual/external-event short-circuit,
      timer deadline, dependency gate, capacity pre-check — was previously unmeasured, so when it
      dominated, `evaluate`'s residual blamed an anonymous number. It is now one net bucket:
      nested measured phases (dependency, handoff) are subtracted from it, keeping the summary's
      buckets disjoint. The `continue`/`break` control flow became a tagged return consumed
      immediately below; the release decisions themselves are byte-identical.
      */
      const decision = await pass.net("release-config", async (): Promise<
        { kind: "skip" } | { kind: "budget-break"; at: number } | { kind: "proceed"; target: string; release: string }
      > => {
        const column = findColumn(ir, task.column);
        const holdConfig = column ? resolveHoldConfig(column) : undefined;
        if (!column || !holdConfig) { evaluatedTaskIds.add(task.id); return { kind: "skip" };
        }
        counters.heldCandidates += 1;
        const release = typeof holdConfig.release === "string" ? holdConfig.release : "manual";
        if (release === "manual" || release === "external-event") {
          trackHeld(task.id, `${release}-only`, deps.now()); result.held.push({ taskId: task.id, reason: `${release}-only` }); evaluatedTaskIds.add(task.id); return { kind: "skip" };
        }
        let shouldRelease = false;
        if (release === "timer") {
          const deadline = resolveTimerDeadline(holdConfig, task);
          shouldRelease = deadline !== undefined && deps.now() >= deadline;
          if (!shouldRelease) { trackHeld(task.id, "timer-not-elapsed", deps.now()); result.held.push({ taskId: task.id, reason: "timer-not-elapsed" }); evaluatedTaskIds.add(task.id); return { kind: "skip" }; }
        } else if (release === "dependency") {
          const evaluation = await evaluateDependenciesPhase(ctx, task, allTasks);
          if (evaluation.truncated) { result.held.push({ taskId: task.id, reason: "sweep-budget-exhausted" }); return { kind: "budget-break", at: index + 1 }; }
          if (!evaluation.satisfied) { trackHeld(task.id, "deps-unsatisfied", deps.now()); result.held.push({ taskId: task.id, reason: "deps-unsatisfied" }); evaluatedTaskIds.add(task.id); return { kind: "skip" }; }
          shouldRelease = true;
        } else if (release === "capacity") {
          const capacityTarget = resolveReleaseTarget(ir, task.column, true);
          if (!capacityTarget) { trackHeld(task.id, "no-downstream-capacity-column", deps.now()); result.held.push({ taskId: task.id, reason: "no-downstream-capacity-column" }); evaluatedTaskIds.add(task.id); return { kind: "skip" }; }
          const capacity = resolveColumnCapacity(ir, capacityTarget, settings);
          if (capacity.hasCapacity && Number.isFinite(capacity.limit)) {
            const workflowId = resolveCapacityPoolId(effectiveWorkflowIdByTask.get(task.id));
            const occupants = countCapacitySlot(allTasks, effectiveWorkflowIdByTask, new Set(resolveWipBudgetColumns(ir, capacityTarget)), workflowId, capacity.countPending);
            if (occupants >= capacity.limit) { trackHeld(task.id, "downstream-full", deps.now()); result.held.push({ taskId: task.id, reason: "downstream-full" }); evaluatedTaskIds.add(task.id); return { kind: "skip" }; }
          }
          shouldRelease = true;
        }
        if (!shouldRelease) { evaluatedTaskIds.add(task.id); return { kind: "skip" }; }
        const target = resolveReleaseTarget(ir, task.column, release === "capacity");
        if (!target) { trackHeld(task.id, "no-release-target", deps.now()); result.held.push({ taskId: task.id, reason: "no-release-target" }); evaluatedTaskIds.add(task.id); return { kind: "skip" }; }
        return { kind: "proceed", target, release };
      });
      if (decision.kind === "skip") continue;
      if (decision.kind === "budget-break") { breakIndex = decision.at; break; }
      const { target, release } = decision;
      /*
      FNXC:WorkflowScheduling 2026-08-28-21:24:
      The automatic sweep records readiness as a held reason and never calls the refusal-producing release path for a card nobody requested to start. Explicit promote and external-event requests still reach `issueRelease`, where FN-7648 records their durable refusal.
      */
      const readiness = await evaluateCapacityHoldReadiness(store, deps, task, ir, target, pass);
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
      const releaseResult = await issueRelease(store, deps, task, target, ir, { pass, readinessAlreadyVerified: true });
      if (releaseResult.released) { const waitedMs = deps.now() - (heldSince.get(task.id)?.sinceMs ?? deps.now()); heldSince.delete(task.id); schedulerLog.log(`Hold release for ${task.id} → ${target} after ${waitedMs}ms held (release=${release})`); result.released.push(task.id); }
      else { trackHeld(task.id, "move-rejected-or-no-slot", deps.now()); result.held.push({ taskId: task.id, reason: "move-rejected-or-no-slot" }); }
      evaluatedTaskIds.add(task.id);
    }
    if (breakIndex !== undefined) { result.budgetTruncated = true; result.unevaluatedCount = tasksForReleaseEvaluation.length - breakIndex;
      /*
      FNXC:HoldReleaseTruncationRotation 2026-10-16-19:56 (RUFU-698 Step 3):
      Remember who was never evaluated, so the next pass starts with them. Only the LOOP-truncation site
      can do this: a preamble-truncated pass never built an ordered list, which is also why the preamble
      line prints no `rotated-deferred` field — it has not rotated anything.
      */
      const tail = tasksForReleaseEvaluation.slice(breakIndex).map((task) => task.id);
      deferredTailsByProject.set(projectKey, tail.slice(0, MAX_ROTATED_DEFERRED_IDS));
    } else {
      // A pass that finished inside its budget examined everyone: the inversion is over by definition.
      deferredTailsByProject.delete(projectKey);
    }
    const sweepMs = deps.now() - sweepStartedMs;
    const longestHeldMs = result.held.reduce((max, held) => Math.max(max, deps.now() - (heldSince.get(held.taskId)?.sinceMs ?? deps.now())), 0);
    const evaluateMs = Math.max(0, sweepMs - prefetchMs - irResolveMs);
    /*
    FNXC:HoldReleaseAttribution 2026-09-09-21:15 (RUFU-209):
    `evaluate` was the sweep's largest phase (field evidence: the residual alone sampled at
    2012-8928 ms while whole sweeps ran 2132-10327 ms, 71 of 76 over the 2000 ms warn threshold)
    and had zero structure, so an operator could not tell which sub-phase to cut. These buckets are
    the answer: each is non-overlapping (a net has its nested leaves subtracted), and `unattributed`
    is the honest residual so the phase list always reconciles with `evaluate` rather than silently
    hiding a slice of it.
    */
    const rotationField = (): string => (result.rotatedDeferredCount ? `, rotated-deferred=${result.rotatedDeferredCount}` : "");
    const summary = `Hold-release sweep: project=${projectKey}: ${sweepMs}ms (prefetch ${prefetchMs}ms, ir-resolve ${irResolveMs}ms, evaluate ${evaluateMs}ms over ${allTasks.length} tasks${phasesSummary(evaluateMs)})${slotFields()}${rotationField()}, released=${result.released.length}, held=${result.held.length}`
      + (result.budgetTruncated ? `, budget-truncated unevaluated=${result.unevaluatedCount ?? 0}` : "")
      + (sweepMs > budgetMs ? `, budgetOverrunMs=${sweepMs - budgetMs}` : "")
      + `, reads(settings=${counters.settings}, tasks=${counters.tasks}, batchSelections=${counters.batchSelections}, selections=${counters.selections}, definitions=${counters.definitions}, handoffMarkers=${counters.handoffMarkers}, prompts=${counters.prompts}, workItems=${counters.workItems}, evalSettings=${counters.evalSettings})`
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
export function isFirstPlanningToWipAdmission(ir: WorkflowIr, sourceColumn: string, targetColumn: string): boolean {
  const source = findColumn(ir, sourceColumn);
  const target = findColumn(ir, targetColumn);
  if (!target || resolveColumnFlags(target).countsTowardWip !== true) return false;
  if (!source) return sourceColumn === "todo" || sourceColumn === "triage";
  const flags = resolveColumnFlags(source);
  return flags.hold === true || flags.intake === true || sourceColumn === "todo";
}

/*
FNXC:PlanPremises 2026-09-16-03:20:
RUFU-246 turned this single-shot replan into the escalation ladder's single choke point. Every
stale/invalid-contract premise refusal from any release door funnels through here under the task
lock: the re-check runs against the LIVE row, the durable episode (sourceMetadata.planPremiseRejection)
is advanced, and the patch follows the ladder — refusal 1 records the episode and stays held, refusal
2 sets needs-replan, refusal 3 parks failed with the exhaustion sentinel. An outcome race (re-check
came back satisfied/unavailable/other) still writes nothing and reports the race to the door.
*/
async function publishPremiseReplan(
  store: TaskStore,
  taskId: string,
  expectedColumn: string,
  expected: "stale" | "invalid-contract",
  door: { planReviewNodeId: string },
): Promise<{ check: PlanPremiseCheckResult; escalation: PlanPremiseEscalation | null }> {
  let final: { check: PlanPremiseCheckResult; escalation: PlanPremiseEscalation | null } = {
    check: { outcome: "unavailable", detail: "Plan premise check lost its source-column race", promptFingerprint: "", premiseViolations: [] },
    escalation: null,
  };
  let episode: PlanPremiseRejectionEpisode | null = null;
  let parkedNow = false;
  await store.updateTaskAtomic(taskId, async (live) => {
    if (live.column !== expectedColumn || live.paused === true || live.userPaused === true) return null;
    /*
    FNXC:PlanPremises 2026-09-16-04:08:
    RUFU-246 refuse-to-touch: once the live row carries a terminal premise park, this publisher
    writes NOTHING at all — the episode, sentinel error, and failed status stay exactly as parked.
    Release doors short-circuit parked cards before reaching here; this guard closes the race where
    the park lands between a door's candidate read and this lock.
    */
    if (isPlanPremiseParkTerminal(live)) return null;
    /*
    FNXC:PlanPremises 2026-09-16-04:08:
    RUFU-246 removes the synthetic fast-lane "satisfied" verdict: Fast cards evaluate their premises
    for real, so the door and this under-lock re-check can no longer disagree on a fast card — a
    disagreement there reported a permanent source-changed race and stalled escalation forever.
    */
    const checked: PlanPremiseCheckResult = await checkPlanPremises(store, live);
    final = { check: checked, escalation: null };
    if (checked.outcome !== expected) return null;
    const step = advancePlanPremiseRejectionEpisode(live, { planReviewNodeId: door.planReviewNodeId, check: checked });
    final = { check: checked, escalation: step.escalation };
    episode = step.episode;
    const sourceMetadataPatch = { [PLAN_PREMISE_REJECTION_METADATA_KEY]: step.episode };
    if (step.escalation === "park") {
      parkedNow = true;
      return { status: "failed", error: buildPlanPremiseExhaustedError(checked.detail), recoveryRetryCount: null, nextRecoveryAt: null, sourceMetadataPatch };
    }
    if (step.escalation === "replan") {
      return { status: "needs-replan", error: null, sourceMetadataPatch };
    }
    return { sourceMetadataPatch };
  });
  const { check } = final;
  // Re-widen past control-flow analysis: `episode` is assigned inside the transaction closure.
  const refusalEpisode = episode as PlanPremiseRejectionEpisode | null;
  /*
  FNXC:PlanPremises 2026-09-16-03:36:
  RUFU-246 — one action-keyed History entry per action+detail: `logEntryOnce` dedupes on the
  refusal detail's hash over a wide window, so the whole hold→replan→park walk over one unchanged
  rejection (and every sticky-park re-refusal) writes a single entry instead of one line per gate
  poll. The planner-facing detail rides the durable episode, never this log. Stores without the
  once-seam keep the historical single-message shape.
  */
  if (refusalEpisode && (check.outcome === "stale" || check.outcome === "invalid-contract")) {
    const logOnce = (store as Partial<TaskStore>).logEntryOnce;
    if (typeof logOnce === "function") {
      await logOnce.call(store, taskId, {
        action: TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION,
        outcome: check.detail,
        dedupeKey: `plan-premise-refusal:${refusalEpisode.detailHash}`,
        windowMs: PLAN_PREMISE_REFUSAL_LOG_WINDOW_MS,
      }).catch(() => undefined);
    } else {
      await store.logEntry(taskId, `${TRIAGE_PLAN_PREMISE_REJECTED_REPLAN_LOG_ACTION}: ${check.detail}`).catch(() => undefined);
    }
  }
  /*
  FNXC:PlanPremises 2026-09-16-04:08:
  RUFU-246 — the FRESH park transition is the one audit-worthy moment of an episode: refusals 1/2
  stay quiet (History and the durable episode carry them), but a card that now sits failed until an
  operator acts records exactly one `task:plan-premise-parked` row with ids/counts/fixed enums only.
  Bounded best-effort so a hostile audit sink can never gate or delay the park itself.
  */
  if (parkedNow) {
    void emitBoundedRunAudit(store, {
      taskId,
      agentId: "scheduler",
      runId: `hold-release:${taskId}`,
      domain: "database",
      mutationType: "task:plan-premise-parked",
      target: taskId,
      metadata: {
        taskId,
        refusalCount: refusalEpisode?.refusalCount ?? 0,
        escalation: "park",
        reason: "plan-premise-exhausted",
        source: "hold-release.premise",
      },
    }, { log: schedulerLog });
  }
  return final;
}

/*
FNXC:PlanPremises 2026-09-27-03:05:
STAS-282 — `premise-invalidated-by-delivery` RELEASES. The assumed facts were destroyed by commits
this card itself produced, which is the ordinary shape of work that removed a flag or renamed a module
its plan had assumed stable. Refusing such a card parks finished work behind a gate no executor can
satisfy — the premise is self-refuting, so it cannot be made true again on any tree that carries the
delivery — and replanning it would dispatch a second implementation of work that already exists. The
door therefore records the evidence once and lets the release proceed. The dedupe key carries the
prompt fingerprint and the evaluated commit, so a re-plan or a new commit re-reports while repeated
polls of the same verdict stay one History line. This path never touches the refusal episode, never
sets `needs-replan`, and never parks: the ladder is for plans that are wrong, not for plans that came
true. The card's `premise-invalidated` document carries the same facts in readable form.
*/
const PLAN_PREMISE_EVIDENCE_DOCUMENT_KEY = "premise-invalidated";

async function recordDeliveryInvalidatedPremises(
  store: TaskStore,
  taskId: string,
  check: Extract<PlanPremiseCheckResult, { outcome: "premise-invalidated-by-delivery" }>,
): Promise<void> {
  const dedupeKey = `plan-premise-delivery-invalidated:${createHash("sha256").update(`${check.promptFingerprint}|${check.detail}`).digest("hex")}`;
  const logOnce = (store as Partial<TaskStore>).logEntryOnce;
  if (typeof logOnce === "function") {
    await logOnce.call(store, taskId, {
      action: TRIAGE_PLAN_PREMISE_INVALIDATED_BY_DELIVERY_LOG_ACTION,
      outcome: check.detail,
      dedupeKey,
      windowMs: PLAN_PREMISE_REFUSAL_LOG_WINDOW_MS,
    }).catch(() => undefined);
  } else {
    await store.logEntry(taskId, `${TRIAGE_PLAN_PREMISE_INVALIDATED_BY_DELIVERY_LOG_ACTION}: ${check.detail}`).catch(() => undefined);
  }
  await recordPremiseEvidenceDocument(store, taskId, check);
}

/*
FNXC:PlanPremises 2026-09-27-03:30:
The card's `premise-invalidated` document is the readable half of the same evidence: the operator who
has to amend the plan needs the premise JSON, the commit that consumed it, and the instruction that the
PLAN changes rather than the delivered code (deleting delivered content to satisfy a stale assumption
would un-ship the card — the trap this verdict exists to prevent). The History entry above is the
mandatory record, so identical bytes are skipped (a repeated door pass adds no revision) and a document
that cannot be written is reported to the scheduler log instead of un-authorising the release.
*/
async function recordPremiseEvidenceDocument(
  store: TaskStore,
  taskId: string,
  check: Extract<PlanPremiseCheckResult, { outcome: "premise-invalidated-by-delivery" }>,
): Promise<void> {
  const content = [
    `# Plan premises invalidated by \`${taskId}\`'s own delivery`,
    "",
    `Verdict: \`${check.outcome}\`. Release is not refused and the card was not re-planned: the`,
    "assumption was destroyed by the very commits that satisfy the card, so the disagreement is fixed by",
    "amending the PLAN — never by deleting delivered content to make an old assumption true again.",
    "",
    check.detail,
    "",
    ...check.premiseViolations.map((violation) => `- \`${JSON.stringify(violation.premise)}\`: ${violation.reason}`),
    "",
    `Prompt fingerprint: \`${check.promptFingerprint}\``,
  ].join("\n");
  try {
    const existing = await store.getTaskDocument(taskId, PLAN_PREMISE_EVIDENCE_DOCUMENT_KEY);
    if (existing?.content === content) return;
    await store.upsertTaskDocument(taskId, {
      key: PLAN_PREMISE_EVIDENCE_DOCUMENT_KEY,
      content,
      author: "engine:plan-premises",
    });
  } catch (error) {
    schedulerLog.warn(`plan premise evidence document for ${taskId} could not be written: ${String(error)}`);
  }
}

/*
FNXC:PlanPremises 2026-09-13-04:01:
Every first planning/hold-to-WIP public admission uses this release authority. Premises are checked before reservation and again from the live row inside moveTaskIf; stale contracts re-enter the existing needs-replan loop without allocating a worktree or creating validation state.
*/
export async function admitTaskToWip(
  store: TaskStore,
  deps: HoldReleaseDeps,
  task: Task,
  target: string,
  ir: WorkflowIr,
  options: {
    expectedColumn?: string;
    moveSource?: "scheduler" | "user";
    workflowMoveSource?: string;
    preserveProgress?: boolean;
  } = {},
): Promise<WipAdmissionResult> {
  return issueRelease(store, deps, task, target, ir, options);
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
  options: {
    expectedColumn?: string;
    moveSource?: "scheduler" | "user";
    workflowMoveSource?: string;
    preserveProgress?: boolean;
    pass?: HoldReleasePass;
    readinessAlreadyVerified?: boolean;
  } = {},
): Promise<IssueReleaseResult> {
  /*
  FNXC:PlanPremises 2026-09-16-04:08:
  RUFU-246 — the terminal premise park is honored at this single choke point: the scheduler sweep,
  the automatic admission in admitTaskToWip, operator promoteHeldTask, and event release all funnel
  through here. A parked card is refused BEFORE any PROMPT.md read, premise evaluation, capacity
  reservation, status write, log append, or audit row. The park is durable by design — only an
  operator Retry/Reset, which clears the refusal episode, lifts it.
  */
  if (isPlanPremiseParkTerminal(task)) {
    return { released: false, rejection: "plan-premise-exhausted", detail: task.error ?? undefined };
  }
  const targetColumn = findColumn(ir, target);
  const targetIsProcessing = targetColumn ? resolveColumnFlags(targetColumn).countsTowardWip === true : false;
  /*
  FNXC:PlanPremises 2026-09-16-03:20: RUFU-246 — the pre-release plan-review node identity is part
  of the refusal-episode signature, resolved once per release from the same IR the door acts on.
  */
  const planReviewNodeId = resolvePreReleasePlanReviewNode(ir)?.id ?? "";

  /*
  FNXC:WorkflowScheduling 2026-08-29-00:24:
  FN-245 removes the operator force-promote override and its `allowUnplanned`
  waiver. Every release surface funnels through this choke point, so an
  unplanned or approval-held card is refused before it can enter a processing
  column; no caller can bypass either gate.

  FNXC:HoldReleaseAttribution 2026-09-09-21:15 (RUFU-209):
  The background sweep already ran `evaluateCapacityHoldReadiness` on this exact
  snapshot task immediately before calling here (and `continue`d when it was not
  releasable), so re-running it here evaluated the SAME task a second time and
  re-read its PROMPT.md. `readinessAlreadyVerified` suppresses only that
  automatic-path duplicate; the under-lock `moveTaskIf` predicate still
  re-checks the LIVE row, so a replan/approval that lands mid-release is still
  refused. Operator/event surfaces pass no `readinessAlreadyVerified` and keep
  this pre-move check (and its FN-7648 refusal recording) exactly as before.
  */
  if (targetIsProcessing) {
    /*
    FNXC:PlanPremises 2026-09-16-04:08:
    RUFU-246 removes the fast-lane premise bypass here: whether the plan's stated facts still match
    the repository is a plain evaluation, not a planning-requiredness rule, so Fast/FN-8304 cards
    verify premises too. What stays UNTOUCHED is what this bypass was conflating with — FN-8304's
    Fast exemptions from planning-requiredness readiness (evaluateCapacityHoldReadiness /
    evaluateExecutionReadiness): fast cards remain exempt there and are never made plan-required.
    */
    const premiseCheck = await checkPlanPremises(store, task);
    if (premiseCheck.outcome === "stale" || premiseCheck.outcome === "invalid-contract") {
      const recorded = await publishPremiseReplan(store, task.id, options.expectedColumn ?? task.column, premiseCheck.outcome, { planReviewNodeId });
      if (recorded.check.outcome === "unavailable" || recorded.check.outcome === "satisfied") {
        return { released: false, rejection: "source-changed", detail: "detail" in recorded.check ? recorded.check.detail : "Plan premise changed during release" };
      }
      return {
        released: false,
        rejection: recorded.check.outcome === "stale" ? "plan-premise-stale" : "plan-premise-invalid",
        detail: "detail" in recorded.check ? recorded.check.detail : premiseCheck.detail,
      };
    }
    if (premiseCheck.outcome === "premise-invalidated-by-delivery") {
      // STAS-282: evidence, not a refusal — record it and fall through to a normal release.
      await recordDeliveryInvalidatedPremises(store, task.id, premiseCheck);
    }
    if (premiseCheck.outcome === "unavailable") {
      return { released: false, rejection: "plan-premise-unavailable", detail: premiseCheck.detail };
    }
    /*
    FNXC:HoldReleaseReadinessDedup 2026-09-14-21:42 (upstream sync merge):
    The RUFU-209 readinessAlreadyVerified gate suppresses ONLY the duplicated evaluateCapacityHoldReadiness
    call on the automatic sweep path. The upstream plan-premise check added above must run on every
    non-fast release regardless of that flag — so the premise check sits directly in the
    targetIsProcessing branch and the readiness block is the one nested under the dedup gate.
    */
    if (!options.readinessAlreadyVerified) {
      const readiness = await evaluateCapacityHoldReadiness(store, deps, task, ir, target);
      if (!readiness.releasable && readiness.kind === "awaiting-approval") {
        schedulerLog.debug(
          `Hold release for ${task.id} blocked — awaiting a human approval decision (status=${task.status ?? "null"}, pausedReason=${task.pausedReason ?? "null"})`,
        );
        return { released: false };
      }
      if (!readiness.releasable) {
        await checkAndRecordUnplannedExecutionBlock(store, task, ir, options.pass);
        schedulerLog.debug(`Hold release for ${task.id} blocked — card is unplanned and cannot enter processing column ${target}`);
        return { released: false, rejection: "unplanned-for-execution" };
      }
    }
  }

  let reservation: SlotReservation | null = null;
  if (targetIsProcessing && deps.reserveSlot) {
    // RUFU-209: thread the pass so the scheduler reservation's own planning guard shares the
    // pass's prompt memo and its cost lands in the `slot` phase rather than vanishing from attribution.
    const doReserve = () => deps.reserveSlot!(task, target, options.pass);
    reservation = options.pass ? await options.pass.net("slot", doReserve) : await doReserve();
    if (options.pass) options.pass.slotCalls += 1;
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
    const originalColumn = options.expectedColumn ?? task.column;
    let liveUnplanned: Task | undefined;
    let livePremiseFailure: Extract<PlanPremiseCheckResult, { outcome: "stale" | "invalid-contract" | "unavailable" }> | undefined;
    let livePremiseDeliveryInvalidated: Extract<PlanPremiseCheckResult, { outcome: "premise-invalidated-by-delivery" }> | undefined;
    // RUFU-246: set when the locked live row already carries a terminal premise park (see predicate).
    let livePremiseExhausted = false;
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
    const doMove = () => store.moveTaskIf(
      task.id,
      target,
      async (live) => {
        if (live.column !== originalColumn || live.paused === true || live.userPaused === true
          || (targetIsProcessing && isTaskBlockedOnApproval(live))) {
          return false;
        }
        if (reservation?.validateAdmission && !await reservation.validateAdmission(live)) return false;
        // RUFU-209: the verdict stays live — it runs against the row held by the move lock, so a
        // replan (`status=needs-replan`), newly pending Plan Review, or approval hold that landed
        // mid-pass still refuses the move. Only the STABLE INPUT FACTS (PROMPT.md contents, work
        // items, settings) come from the pass memo; like the selection/IR caches this pass owns, a
        // mid-pass change to them can at worst delay a release to the next pass, never force one.
        if (targetIsProcessing && await isUnplannedForExecution(store, live, ir, options.pass)) {
          liveUnplanned = live;
          return false;
        }
        /*
        FNXC:PlanPremises 2026-09-16-04:08:
        RUFU-246 — under-lock park preservation: a concurrent release surface may have terminally
        parked this card since the pre-move check. The live park wins — refuse the move WITHOUT
        evaluating premises or recording a new refusal (no episode, History, or audit write), and
        report the terminal code after the lock releases.
        */
        if (isPlanPremiseParkTerminal(live)) {
          livePremiseExhausted = true;
          return false;
        }
        // RUFU-246: the fast-lane premise bypass is removed here too (see the pre-move door note);
        // premises are repository facts, not planning-requiredness rules.
        if (targetIsProcessing) {
          const checked = await checkPlanPremises(store, live);
          if (checked.outcome === "premise-invalidated-by-delivery") {
            // STAS-282: releases on the same terms as a satisfied verdict. The verdict is only
            // remembered here — the History entry is written once the move lock is released, so a
            // premise evaluation never performs a write inside the move transaction.
            livePremiseDeliveryInvalidated = checked;
          } else if (checked.outcome !== "satisfied") {
            livePremiseFailure = checked;
            return false;
          }
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
        moveSource: options.moveSource ?? "scheduler",
        workflowMoveSource: options.workflowMoveSource ?? "scheduler-hold-release",
        preserveProgress: options.preserveProgress,
        allocateWorktree:
          targetIsProcessing && deps.allocateWorktree
            ? (reservedNames) => deps.allocateWorktree!(task, reservedNames)
            : undefined,
      },
    );
    const result = options.pass ? await options.pass.net("issue-release", doMove) : await doMove();
    if (!result.moved) {
      reservation?.release();
      if (liveUnplanned) {
        await checkAndRecordUnplannedExecutionBlock(store, liveUnplanned, ir, options.pass);
        schedulerLog.debug(`Hold release for ${task.id} blocked — card became unplanned before entering processing column ${target}`);
        return { released: false, rejection: "unplanned-for-execution" };
      }
      if (livePremiseExhausted) {
        return { released: false, rejection: "plan-premise-exhausted", detail: "Plan premise contract exhausted; operator Retry/Reset required to clear the refusal episode" };
      }
      if (livePremiseFailure) {
        if (livePremiseFailure.outcome === "unavailable") {
          return { released: false, rejection: "plan-premise-unavailable", detail: livePremiseFailure.detail };
        }
        const recorded = await publishPremiseReplan(store, task.id, originalColumn, livePremiseFailure.outcome, { planReviewNodeId });
        return {
          released: false,
          rejection: recorded.check.outcome === "stale" ? "plan-premise-stale" : recorded.check.outcome === "invalid-contract" ? "plan-premise-invalid" : "source-changed",
          detail: "detail" in recorded.check ? recorded.check.detail : livePremiseFailure.detail,
        };
      }
      schedulerLog.log(`Hold release for ${task.id} skipped — task became paused or left ${originalColumn}`);
      return { released: false };
    }
    if (livePremiseDeliveryInvalidated) await recordDeliveryInvalidatedPremises(store, task.id, livePremiseDeliveryInvalidated);
    return { released: true, task: result.task };
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
