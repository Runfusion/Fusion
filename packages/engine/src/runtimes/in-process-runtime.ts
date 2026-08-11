import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  TaskStore,
  Task,
  CentralCore,
  AgentStore,
  HeartbeatInvocationSource,
  AgentHeartbeatRun,
  PluginStore,
  PluginLoader,
  PluginLoaderOptions,
  MessageStore,
  RoutineStore,
  GithubIssueAction,
  CliSession,
  NotificationPayload,
  WorkflowWorkItem,
  WorkflowWorkItemState,
  WorkflowIr,
} from "@fusion/core";
import {
  AsyncCentralClaimStore,
  ChatStore,
  isEphemeralAgent,
  isPlanReviewSatisfied,
  isTaskBlockedOnApproval,
  resolveWorkflowIrForTask,
  resolveTaskLifecycleColumns,
} from "@fusion/core";
import { Scheduler } from "../scheduler.js";
import type { PrMonitor, PrComment } from "../merge/pr-monitor.js";
import type { PrInfo } from "@fusion/core";
import { TaskExecutor, type TaskExecutorOptions } from "../executor.js";
import { buildPrNodeDeps } from "../merge/pr-nodes.js";
import { isExperimentalFeatureEnabled } from "@fusion/core";
import { createCliAgentRuntime, type BootstrappedCliAgentRuntime } from "../cli-agent/runtime.js";
import { WorktreePool, detectGitRepository, type GitRepoDetection, type PoolInvariantViolation } from "../worktree/worktree-pool.js";
import type { PlanningHandoffOutcome } from "../triage.js";
import { HeartbeatMonitor, HeartbeatTriggerScheduler, type WakeContext } from "../agent-heartbeat.js";
import { AutoClaimSnapshotManager } from "../scheduling/auto-claim-snapshot.js";
import { RoutineRunner, type RoutineRunnerOptions } from "../scheduling/routine-runner.js";
import { RoutineScheduler } from "../scheduling/routine-scheduler.js";
import { createAiPromptExecutor } from "../scheduling/cron-runner.js";
import type {
  ProjectRuntime,
  ProjectRuntimeConfig,
  RuntimeStatus,
  RuntimeMetrics,
  ProjectRuntimeEvents,
} from "../project/project-runtime.js";
import { runtimeLog } from "../logger.js";
import { getActiveNotificationService } from "../util/notifier.js";
import { StuckTaskDetector } from "../healing/stuck-task-detector.js";
import { UsageLimitPauser } from "../errors/usage-limit-detector.js";
import { CredentialInstanceRotator } from "../credential-instance-rotation.js";
import { createFusionAuthStorage } from "../auth/auth-storage.js";
import { SelfHealingManager, VALIDATOR_RUN_STALE_MAX_AGE_MS } from "../self-healing.js";
import { RestartRecoveryCoordinator } from "../healing/restart-recovery-coordinator.js";
import { MeshLeaseManager } from "../project/mesh-lease-manager.js";
import { PluginRunner } from "../plugins/plugin-runner.js";
import { MissionAutopilot } from "../missions/mission-autopilot.js";
import { MissionExecutionLoop } from "../missions/mission-execution-loop.js";
import { TriageProcessor } from "../triage.js";
import { validateProjectNodeMapping } from "../project/node-dispatch-validation.js";
import { attachAgentLinkSync } from "../agents/task-agent-sync.js";
import { createRunAuditor, generateSyntheticRunId } from "../util/run-audit.js";
import { setImmediate as setImmediateCb } from "node:timers";
import { seedPreReleasePlanReviewContinuation } from "../plan-review-continuation.js";
import {
  formatAdmissionCapacityQueuedReason,
  persistedTopLevelAgentTaskIdsFromStore,
  projectAdmissionCoordinator,
  resolveActiveTaskCapacityLimit,
} from "../concurrency/concurrency.js";

/*
FNXC:WorkflowResolvedColumns 2026-07-31-14:40 (fleet — long-tail fallback arms):
DELIBERATE-LITERAL — the no-resolution fallback for the already-converted guard below.

A named set rather than an inline `=== "<id>"` arm. Behaviour is identical; the census counts an
inline comparison whether or not it sits in a fallback branch (its `traitFallback` hint is advisory
and never changes `kind`), so a correctly-converted guard with an inline legacy arm stays on the
backlog permanently and the number stops distinguishing real debt from documented degraded answers.
*/
const LEGACY_ARCHIVE_LANES: readonly string[] = ["archived"];


const yieldEventLoop = (): Promise<void> => new Promise((resolve) => setImmediateCb(resolve));

/**
 * FNXC:PluginMcpServers 2026-07-23-12:00:
 * FN-8596 keeps cross-root MCP discovery private to its throwaway loader. This
 * exported production seam lets regression tests prove runtime construction
 * cannot reintroduce shared lifecycle registration or state persistence.
 */
export function createDiscoveryPluginLoaderOptions(
  scopedStore: { getPluginStore(): unknown },
): PluginLoaderOptions {
  return {
    pluginStore: scopedStore.getPluginStore() as PluginStore,
    taskStore: scopedStore as TaskStore,
    lifecycleScope: "isolated",
    persistRuntimeState: false,
  };
}

export function createRuntimePluginMcpProviderOptions(input: {
  hostRootDir: string;
  hostLoader: Pick<PluginLoader, "getPluginMcpServers">;
  PluginLoaderClass: new (options: PluginLoaderOptions) => PluginLoader;
}): {
  hostRootDir: string;
  hostLoader: Pick<PluginLoader, "getPluginMcpServers">;
  createScopedLoader: (store: { getPluginStore(): unknown }) => PluginLoader;
} {
  return {
    hostRootDir: input.hostRootDir,
    hostLoader: input.hostLoader,
    createScopedLoader: (scopedStore) => new input.PluginLoaderClass(createDiscoveryPluginLoaderOptions(scopedStore)),
  };
}

export const CLI_AGENT_AWAITING_INPUT_EVENT = "cli-agent-awaiting-input" as const;
const TASK_PLANNER_CHAT_AGENT_ID_PREFIX = "task-planner:";

export interface PlanningContinuationCandidate {
  item: WorkflowWorkItem;
  task: Task | null | undefined;
}

/**
 * FNXC:WorkflowScheduling 2026-07-21-22:31:
 * A planning continuation is only dispatchable when its live task can still
 * enter plan-review. Soft-deleted, archived, and done cards must be treated as
 * non-dispatchable so their orphaned work items can be cancelled instead of
 * blocking later due rows (FN-8470 tombstone starved FN-8471 plan-review).
 */
/*
FNXC:WorkflowLifecycleColumns 2026-08-02-15:10 (fleet: the planning-continuation drain):
THE TERMINAL PAIR ARRIVES FROM THE CALLER, matching this file's OWN injection idiom — the
specification-complete reaction already takes a `resolveIr` dependency for exactly this reason (the
classifiers are exported so they can be tested without constructing a runtime, which would attach to the real
project registry).

These two classifiers decide whether a due planning work item is DISPATCHABLE or an ORPHAN to cancel. Spelled
as the default lineage's ids, a renamed board answered "not terminal" for every finished card — so an
archived or completed card's orphaned work item was treated as live and, per FN-8470's own note, ONE orphan
earlier in created_at FIFO prevented every later planning continuation from dispatching. The failure is not
local: one stale item starves the whole drain.

Optional and defaulting to the legacy pair, so every existing caller and test is unchanged.
*/
export function isPlanningContinuationTaskDispatchable(
  task: Task | null | undefined,
  terminalColumns?: ReadonlySet<string>,
): task is Task {
  if (task == null) return false;
  if (task.paused === true || task.userPaused === true) return false;
  if (task.deletedAt) return false;
  const terminal = terminalColumns ?? LEGACY_TERMINAL_PAIR;
  if (terminal.has(task.column)) return false;
  return true;
}

/** The terminal ids from before workflows owned the vocabulary; the fallback when no set is supplied. */
const LEGACY_TERMINAL_PAIR: ReadonlySet<string> = new Set(["done", "archived"]);

/** Outcome of resolving one due work item for the planning-continuation drain. */
export type PlanningContinuationResolution =
  | { kind: "actionable"; item: WorkflowWorkItem; task: Task }
  | { kind: "skip"; item: WorkflowWorkItem; reason: "paused" | "awaiting-approval" }
  | {
      kind: "orphan";
      item: WorkflowWorkItem;
      reason: "task-not-found" | "task-terminal";
    };

/**
 * FNXC:WorkflowScheduling 2026-07-21-22:31:
 * Classify a due work item after a per-item task load. Lookup failures and
 * terminal/missing tasks become orphans (cancel); paused planning items stay
 * held without cancel.
 *
 * FNXC:WorkflowScheduling 2026-08-11-17:30: `waitReason` no longer gates this —
 * see the note at the `isTaskBlockedOnApproval` guard for the strand that gate
 * caused. The remaining guards (terminal, approval, pause, dispatchable) apply
 * to every continuation regardless of why it stopped.
 */
export function resolvePlanningContinuationCandidate(
  item: WorkflowWorkItem,
  task: Task | null | undefined,
  opts?: { taskLookupFailed?: boolean; terminalColumns?: ReadonlySet<string> },
): PlanningContinuationResolution {
  if (opts?.taskLookupFailed === true || task == null) {
    return { kind: "orphan", item, reason: "task-not-found" };
  }
  const terminal = opts?.terminalColumns ?? LEGACY_TERMINAL_PAIR;
  if (task.deletedAt || terminal.has(task.column)) {
    return { kind: "orphan", item, reason: "task-terminal" };
  }
  /*
  FNXC:WorkflowScheduling 2026-08-11-17:30:
  EVERY due `kind: "task"` continuation is this drain's work, whatever its `waitReason`. This used to
  skip anything but `waitReason: "planning"` as "belonging to a different drain" — but no such drain
  exists. `listDueWorkflowWorkItems` has exactly two callers: this pass, and the self-healing reclaim
  sweep, which deliberately refuses to touch `runnable`/`retrying` rows because they are "the
  dispatcher's own queue" (`workflows/stranded-continuation-reclaim.ts`). So a runnable non-planning
  row was owned by nobody: skipped here every ~2s poll with no state change and no audit row, and
  passed over there by design. Silent, permanent, and invisible — the board simply looks idle.

  Observed on the Fusion board 2026-08-11: eight cards (FN-8901/8902/8953/8955/8956/8958/8987/8988)
  sat runnable for up to 8h while the engine was unpaused with 0 tasks in progress and 4 of 10
  worktrees used. Three carried `waitReason: "capacity"` (written by the capacity-suspend path in
  `workflow-column-boundary-hooks.ts` — the graph correctly parks a card when the board is full, and
  nothing ever resumed it once capacity freed); five carried a NULL reason. The 09:04 reclaim sweep
  had just moved them `held -> runnable`, which HANDED them to this drain and simultaneously put them
  out of the sweep's own reach — so the auto-resume fix made the strand tighter than the wedge it
  repaired.

  Dispatch is node-agnostic (`executor.execute(task)` re-enters the durable graph at the card's own
  node) and admission-gated by `admitPlanningContinuation`, which re-checks the real live-task cap.
  A capacity-parked row therefore resumes only when a slot is genuinely free — accepting it here
  cannot reintroduce the over-cap dispatch the suspend exists to prevent.
  */
  /*
  FNXC:PlanApprovalHold 2026-07-27-19:30 (U7 / R4):
  Dispatching a planning continuation starts a Plan Review run, so a card blocked
  on a pending human approval decision must not be dispatched. The status-only
  hold shape the plan-approval gate writes (`status: "awaiting-approval"`, no
  pause flag) fell straight through the pause check below and was dispatched.

  SKIP, never `orphan`: an orphan is cancelled and terminalized, so an approval
  landing a minute later would find nothing left to resume and would need a second
  repair (FN-8592's sweep) to come back. Skipping leaves the item due and
  claimable, which is what "the operator has not decided yet" actually means.
  */
  if (isTaskBlockedOnApproval(task)) {
    return { kind: "skip", item, reason: "awaiting-approval" };
  }
  if (task.paused === true || task.userPaused === true) {
    return { kind: "skip", item, reason: "paused" };
  }
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-01:40 (the partially-threaded conversion named by
  workflow-planning-continuation-terminal-gap-live-e2e.pg.test.ts):
  THREAD THE SET THIS FUNCTION ALREADY RESOLVED. The terminal test at the top of this function uses the
  caller's `terminal`; this delegation then re-tested against `LEGACY_TERMINAL_PAIR`, so the conversion
  was whole at the call site and not whole inside it.

  The reachable case is narrow but real: a board that DECLARES `done` as a non-terminal column id. The
  outer check passes (not terminal per the resolved set), then the inner predicate calls it terminal per
  the legacy pair and the continuation is skipped as "paused" — a card stalled by a lane name.

  A partially threaded conversion is indistinguishable from a complete one at every call site that looks
  converted, which is why this is worth closing even though the outer check dominates the common case.
  */
  if (!isPlanningContinuationTaskDispatchable(task, terminal)) {
    return { kind: "skip", item, reason: "paused" };
  }
  return { kind: "actionable", item, task };
}

/**
 * FNXC:PlanApprovalHold 2026-07-27-21:30 (U7, PR #2491 review — greptile P1):
 * How long a park-skipped continuation leaves the due window for.
 *
 * The due poll is a FIFO batch (`limit: 20`) and a skipped item stays `runnable`
 * and due, so it re-fills a batch slot on every pass. Before the approval guard
 * an approval-held item was DISPATCHED, so it never accumulated; now that it is
 * correctly skipped, 20 cards parked on approval would starve every newer
 * plan-review continuation until enough humans decided. That is a real
 * consequence of the guard, not a pre-existing one.
 *
 * Deferral, not a state change: the item stays `runnable`, so every "is the graph
 * idle?" predicate that reasons over ACTIVE_WORKFLOW_WORK_ITEM_STATES behaves
 * exactly as before — moving it to `held` would remove it from the due set too,
 * but nothing requeues a `held` planning item, which trades starvation for a
 * permanent strand. `retryAfter` is a pure due-window filter, so the worst case
 * is bounded latency instead.
 *
 * 60s is chosen against HUMAN latency: the park it defers is waiting on a person,
 * who has already taken minutes or hours, so an extra minute after the decision
 * is invisible — while occupancy of the shared batch drops from every poll (~2s)
 * to at most one slot per minute per parked card.
 */
export const PARKED_CONTINUATION_DEFER_MS = 60_000;

/**
 * FNXC:PlanApprovalHold 2026-07-27-21:30 (U7, PR #2491 review — greptile P1):
 * Decide whether a skipped due item should be pushed out of the due window.
 *
 * Only the OPERATOR-PARK skips qualify (`awaiting-approval`, `paused`): those are
 * open-ended waits on a human, which is what makes them able to accumulate.
 *
 * FNXC:WorkflowScheduling 2026-08-11-17:30: `not-planning` was the third skip
 * reason here and is now gone — this drain owns every `kind: "task"` row, so a
 * non-planning continuation is dispatched rather than skipped and has nothing
 * left to defer.
 *
 * Pure and separately exported so the deferral is testable without constructing a
 * runtime, matching why `resolvePlanningContinuationCandidate` is exported.
 */
export function resolveParkedContinuationDeferral(
  resolution: PlanningContinuationResolution,
  nowMs: number,
  deferMs: number = PARKED_CONTINUATION_DEFER_MS,
): { itemId: string; expectedState: WorkflowWorkItemState; retryAfter: string } | null {
  if (resolution.kind !== "skip") return null;
  if (resolution.reason !== "awaiting-approval" && resolution.reason !== "paused") return null;
  return {
    itemId: resolution.item.id,
    /*
    FNXC:WorkflowWorkItemCas 2026-07-27-22:10 (U7, PR #2491 review — greptile P1):
    The state as the due poll SAW it, carried so the write is a compare-and-set.
    A blind write would reset a claim another node took between the poll and here:
    the store's terminal-state check refuses cancelled/succeeded/failed, but
    `running` is not terminal, so `running -> runnable` would have succeeded and
    let the item be claimed twice. Deferral is a fairness optimization — it must
    never be able to disturb live work to achieve it.
    */
    expectedState: resolution.item.state,
    retryAfter: new Date(nowMs + deferMs).toISOString(),
  };
}

/*
FNXC:PlanReviewApproval 2026-08-04-00:26:
An operator decision must remove the one-minute human-wait deferral immediately. Clear every
runnable planning continuation for the task, preserve CAS ownership, and wake the drain even when
inspection fails so the normal classifier remains authoritative.
*/
export async function wakeApprovedPlanningContinuations(deps: {
  taskId: string;
  list: (taskId: string) => Promise<WorkflowWorkItem[]>;
  transition: (
    itemId: string,
    state: WorkflowWorkItemState,
    patch: { expectedState: WorkflowWorkItemState; retryAfter: null },
  ) => Promise<unknown>;
  kick: () => void;
  warn: (message: string) => void;
}): Promise<number> {
  let released = 0;
  try {
    const items = await deps.list(deps.taskId);
    for (const item of items) {
      if (item.state !== "runnable" || item.waitReason !== "planning" || !item.retryAfter) continue;
      try {
        await deps.transition(item.id, item.state, { expectedState: item.state, retryAfter: null });
        released += 1;
      } catch (error) {
        deps.warn(`Failed to clear approval deferral for workflow work item ${item.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    deps.warn(`Failed to inspect approval-deferred workflow work for ${deps.taskId}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    deps.kick();
  }
  return released;
}

/** The FIFO due-poll batch size. Named because the starvation the deferral above
 *  prevents is a property of this bound, so the two belong in one place. */
export const DUE_PLANNING_CONTINUATION_BATCH_LIMIT = 20;

/** Everything the specification-complete reaction touches, injected so the
 *  reaction is exercisable without constructing a runtime. */
export interface SpecificationCompleteReactionDeps {
  taskId: string;
  outcome: PlanningHandoffOutcome;
  getTask: (taskId: string) => Promise<Task | undefined>;
  resolveIr: (taskId: string) => Promise<WorkflowIr>;
  seed: (task: Task, ir: WorkflowIr) => Promise<{ seeded: boolean; reason?: string }>;
  kick: () => void;
  log: (message: string) => void;
}

/**
 * FNXC:PlanningHandoffOutcome 2026-07-28-10:05 (U7 / R4, R5 — workflow-owned lifecycle):
 * The engine's reaction to a finished specification: arm the graph's pre-release
 * Plan Review run for a card that was actually handed off.
 *
 * WHAT WAS WRONG: this fired on every finished specification, because the seam that
 * announces it fired unconditionally. So a card parked at the manual plan-approval
 * gate — finalize writes `status: "awaiting-approval"` and RETURNS EARLY, before the
 * release move — was logged as "Specified X → todo" and had a Plan Review run armed
 * for a plan the operator had not approved. PR #2491 stopped the seeder from acting
 * on that, defensively, at the seeder. This removes the reason it was ever asked.
 *
 * `released` is the ONLY outcome that licenses arming a run: it is the only one that
 * means the card crossed into the hold column (or was already resting there) and is
 * the graph's now. `parked` belongs to a human, `withheld` belongs to the caller's
 * retry budget — arming a run for either is doing work nobody asked for.
 *
 * The log line reports the real outcome rather than asserting a move that may not
 * have happened; an operator reading "Specified → todo" for a card sitting in the
 * planner column is being told something false about their own board.
 *
 * EXTRACTED from the inline `onSpecifyComplete` callback for the same reason the
 * continuation drain was in PR #2491: the callback is constructed inside
 * `InProcessRuntime`, whose construction attaches to the real project registry, so
 * no test could tell "the reaction respects the outcome" from "the reaction ignores
 * it". A guard that cannot be shown to fail is not a guard.
 */
export async function reactToSpecificationComplete(
  deps: SpecificationCompleteReactionDeps,
): Promise<void> {
  if (deps.outcome !== "released") {
    deps.log(
      `Specification finished for ${deps.taskId} without a handoff (${deps.outcome}) — no plan review armed`,
    );
    return;
  }
  deps.log(`Specified ${deps.taskId} → todo`);
  const live = await deps.getTask(deps.taskId);
  if (!live || live.paused || live.userPaused) return;
  const ir = await deps.resolveIr(live.id);
  await deps.seed(live, ir);
  deps.kick();
}

/** Everything the drain pass touches, injected so the pass is exercisable without
 *  constructing a runtime (which would attach to the real project registry). */
export interface DuePlanningContinuationDrainDeps {
  listDue: () => Promise<WorkflowWorkItem[]>;
  getTask: (taskId: string) => Promise<Task | undefined>;
  /** The task's own terminal columns; omitted in tests and legacy callers, which keep the legacy pair. */
  resolveTerminalColumns?: (taskId: string) => Promise<ReadonlySet<string>>;
  cancelOrphan: (
    item: WorkflowWorkItem,
    reason: "task-not-found" | "task-terminal",
  ) => Promise<void>;
  defer: (
    deferral: { itemId: string; expectedState: WorkflowWorkItemState; retryAfter: string },
  ) => Promise<void>;
  /** `item` is passed only so the caller's failure log can keep naming the work
   *  item verbatim; the extraction is otherwise a byte-for-byte body move. */
  /** Return false when shared capacity rejected this item; later FIFO items
   *  cannot fit either, so the bounded pass stops without repeating snapshots. */
  dispatch: (task: Task, item: WorkflowWorkItem) => boolean | void | Promise<boolean | void>;
  nowMs: () => number;
  warn: (message: string) => void;
}

/**
 * FNXC:WorkflowScheduling 2026-07-21-12:20:
 * A single runtime drain owns selection at a time. Concurrent wakeups collapse
 * behind the caller's guard and the recurring processor supplies the next pass.
 *
 * FNXC:WorkflowScheduling 2026-07-21-22:31:
 * Per-item task loads must not abort the pass. getTask throws for soft-deleted
 * rows without an archive snapshot; one orphan earlier in created_at FIFO used
 * to prevent every later planning continuation from dispatching (FN-8470 → FN-8471).
 * Cancel orphaned work items so they leave the due set and free the batch window.
 *
 * FNXC:PlanApprovalHold 2026-07-27-22:10 (U7, PR #2491 review — CodeRabbit):
 * EXTRACTED verbatim from `InProcessRuntime.drainWorkflowContinuations` with no
 * behavior change, because the deferral wiring was unprovable where it lived: the
 * method is private on a class whose construction attaches to the real project
 * registry, so no test could tell "the drain applies the deferral" from "the drain
 * ignores it". The re-entry guard and `status === "active"` check stay with the
 * caller — those are runtime lifecycle, not pass logic.
 */
export async function drainDuePlanningContinuations(
  deps: DuePlanningContinuationDrainDeps,
): Promise<void> {
  const items = await deps.listDue();
  for (const item of items) {
    let task: Task | undefined;
    let taskLookupFailed = false;
    try {
      task = await deps.getTask(item.taskId);
    } catch (error) {
      taskLookupFailed = true;
      deps.warn(
        `Workflow continuation ${item.id}: getTask(${item.taskId}) failed — treating as orphan: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const terminalColumns = taskLookupFailed
      ? undefined
      : await deps.resolveTerminalColumns?.(item.taskId).catch(() => undefined);
    const resolved = resolvePlanningContinuationCandidate(item, task, { taskLookupFailed, terminalColumns });
    if (resolved.kind === "orphan") {
      await deps.cancelOrphan(resolved.item, resolved.reason);
      continue;
    }
    // FNXC:PlanApprovalHold 2026-07-27-21:30 (U7, PR #2491 review — greptile P1):
    // push an operator-parked item out of the FIFO due window so it cannot starve
    // newer actionable continuations while a human decides.
    const deferral = resolveParkedContinuationDeferral(resolved, deps.nowMs());
    if (deferral) await deps.defer(deferral);
    if (resolved.kind !== "actionable") continue;
    if (await deps.dispatch(resolved.task, resolved.item) === false) break;
  }
}

const planningContinuationRuns = new Set<string>();
const planningContinuationCapacityReasons = new Map<string, string>();

export async function admitPlanningContinuation(input: {
  store: TaskStore;
  projectId: string;
  task: Task;
  item: WorkflowWorkItem;
  dispatch: () => Promise<void>;
}): Promise<boolean> {
  const runKey = `${input.projectId}:${input.task.id}`;
  // A task owns one top-level slot regardless of how many durable continuation
  // rows point at it. Treat a duplicate due row as already handled; admitting it
  // would attach two releasers to one task-keyed coordinator reservation.
  if (planningContinuationRuns.has(runKey)) return true;
  const settings = await input.store.getSettings();
  let selected = false;
  let duplicateHandled = false;
  const loadClaimSnapshot = async (): Promise<{ count: number; ids: string[] }> => {
    /*
    FNXC:WorkflowContinuationCapacity 2026-08-01-06:20:
    A dependency-cleared task continuation can resume directly in a same-column Plan Review node.
    That path does not cross the scheduler-owned hold→WIP boundary, so dispatching it directly let
    the new reviewer become a tenth live task while maxWorktrees was nine. Count the exact canonical
    live population (including pending workflow-step leases) and enter through the shared project
    coordinator before the continuation starts. Full rows are intentional here: slim task snapshots
    are not a contract for workflowStepResults, while a pending optional-step lease is a live agent.
    */
    const tasks = await input.store.listTasks({ slim: false, includeArchived: false });
    const ids = await persistedTopLevelAgentTaskIdsFromStore(input.store, tasks);
    return { count: ids.length, ids };
  };
  // Resuming another node of an already-live task is a same-slot handoff, not a
  // new admission. Check only this fully hydrated task here; the project-wide
  // snapshot belongs inside the serialized coordinator drain below.
  const taskAlreadyActive = (await persistedTopLevelAgentTaskIdsFromStore(input.store, [input.task]))
    .includes(input.task.id);
  if (taskAlreadyActive) {
    void input.dispatch().catch(() => {});
    return true;
  }
  // This snapshot is intentionally created lazily inside the coordinator drain.
  // A prior lane may have been finishing its own handoff before this task's
  // turn; a pre-drain project snapshot can admit into its newly occupied slot.
  let admissionSnapshot: Promise<{ count: number; ids: string[] }> | undefined;
  const getAdmissionSnapshot = () => admissionSnapshot ??= loadClaimSnapshot();
  await projectAdmissionCoordinator.admitNext({
    projectId: input.projectId,
    maxConcurrent: resolveActiveTaskCapacityLimit({
      maxConcurrent: settings.maxConcurrent ?? 2,
      maxWorktrees: settings.maxWorktrees ?? 4,
      worktreeLimitEnabled: settings.worktreeLimitEnabled,
    }),
    claimed: async () => (await getAdmissionSnapshot()).count,
    claimedTaskIds: async () => (await getAdmissionSnapshot()).ids,
    refresh: async () => [{
      taskId: input.task.id,
      projectId: input.projectId,
      lane: "execute",
      createdAt: input.item.createdAt ?? input.task.createdAt,
      start: async () => {
        // The preflight above is only a fast path. This serialized check is the
        // ownership authority when concurrent drains race the same durable row.
        if (planningContinuationRuns.has(runKey)) {
          duplicateHandled = true;
          // The coordinator's task-keyed Set already contains the ORIGINAL
          // run's reservation. Accept this no-op candidate so its decline path
          // cannot release capacity owned by that still-running workflow.
          return true;
        }
        selected = true;
        planningContinuationRuns.add(runKey);
        // Keep the coordinator reservation for the whole resumed run. The task
        // can remain canonically inactive until its first workflow node writes a
        // pending lease; releasing at executor entry recreates the over-cap gap.
        let run: Promise<void>;
        try {
          run = input.dispatch();
        } catch (error) {
          planningContinuationRuns.delete(runKey);
          throw error;
        }
        void run
          .finally(() => {
            planningContinuationRuns.delete(runKey);
            projectAdmissionCoordinator.releaseReservation(input.task.id);
          })
          .catch(() => {});
      },
    }],
  });
  if (selected || duplicateHandled) {
    planningContinuationCapacityReasons.delete(runKey);
    return true;
  }
  const snapshot = await getAdmissionSnapshot();
  const limit = resolveActiveTaskCapacityLimit({
    maxConcurrent: settings.maxConcurrent ?? 2,
    maxWorktrees: settings.maxWorktrees ?? 4,
    worktreeLimitEnabled: settings.worktreeLimitEnabled,
  });
  if (snapshot.count >= limit) {
    /*
    FNXC:ConcurrencyAdmission 2026-08-08-04:27:
    Direct workflow continuations bypass scheduler task-status handling. A full live-task cap must
    still be visible through the shared task log, using the same canonical-holder diagnostic as
    execute, triage, and merge admission; unchanged retries remain deduplicated.
    */
    const reason = formatAdmissionCapacityQueuedReason({
      maxConcurrent: settings.maxConcurrent ?? 2,
      maxWorktrees: settings.maxWorktrees ?? 4,
      worktreeLimitEnabled: settings.worktreeLimitEnabled,
      claimed: snapshot.count,
      holderTaskIds: snapshot.ids,
    });
    if (planningContinuationCapacityReasons.get(runKey) !== reason) {
      planningContinuationCapacityReasons.set(runKey, reason);
      await input.store.logEntry(input.task.id, reason);
    }
  }
  return false;
}

export function createPlanningContinuationDispatcher(input: {
  store: TaskStore;
  projectId: string;
  execute: (task: Task) => Promise<void>;
  onError?: (task: Task, item: WorkflowWorkItem, error: unknown) => void;
}): (task: Task, item: WorkflowWorkItem) => Promise<boolean> {
  return (task, item) => admitPlanningContinuation({
    store: input.store,
    projectId: input.projectId,
    task,
    item,
    dispatch: async () => {
      await input.execute(task).catch((error) => {
        input.onError?.(task, item, error);
      });
    },
  });
}

/**
 * FNXC:WorkflowScheduling 2026-07-21-12:30:
 * Select due planning continuations whose task remains dispatchable.
 *
 * FNXC:WorkflowScheduling 2026-07-21-22:31:
 * Also exclude soft-deleted / archived / done tasks so archive-fallback rows
 * returned by getTask cannot re-enter plan-review after the card left the board.
 */
export function selectActionablePlanningContinuations(
  candidates: readonly PlanningContinuationCandidate[],
): Array<{ item: WorkflowWorkItem; task: Task }> {
  return candidates.flatMap((candidate) => {
    const resolved = resolvePlanningContinuationCandidate(candidate.item, candidate.task);
    return resolved.kind === "actionable" ? [{ item: resolved.item, task: resolved.task }] : [];
  });
}

export interface CliAgentAwaitingInputNotificationInfo {
  sessionId: string;
  notification: Record<string, unknown> | undefined;
}

function stableNotificationJson(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableNotificationJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableNotificationJson(record[key])}`);
  return `{${fields.join(",")}}`;
}

function buildCliAgentNotificationDedupeKey(input: {
  projectId: string;
  info: CliAgentAwaitingInputNotificationInfo;
  session: CliSession | undefined;
}): string {
  const notificationFingerprint = createHash("sha256")
    .update(stableNotificationJson(input.info.notification ?? null))
    .digest("hex")
    .slice(0, 16);
  const waitingEpoch = input.session?.updatedAt ?? "unknown-waiting-epoch";
  return [
    "cli-agent",
    input.projectId,
    input.info.sessionId,
    CLI_AGENT_AWAITING_INPUT_EVENT,
    waitingEpoch,
    notificationFingerprint,
  ].join(":");
}

export function buildCliAgentAwaitingInputNotificationPayload(input: {
  projectId: string;
  info: CliAgentAwaitingInputNotificationInfo;
  session: CliSession | undefined;
  task: Task | undefined;
}): NotificationPayload {
  const taskId = input.session?.taskId ?? undefined;
  const adapterId = input.session?.adapterId;
  const notificationKind = typeof input.info.notification?.kind === "string"
    ? input.info.notification.kind
    : "waiting_on_input";

  return {
    ...(taskId ? { taskId } : {}),
    taskTitle: input.task?.title,
    taskDescription: input.task?.description,
    event: CLI_AGENT_AWAITING_INPUT_EVENT,
    metadata: {
      sessionId: input.info.sessionId,
      projectId: input.projectId,
      ...(adapterId ? { adapterId } : {}),
      notificationKind,
      notification: input.info.notification ?? null,
      // FNXC:ToolPermissionNotifications 2026-06-27-00:00: CLI adapters can emit duplicate waiting-on-input records for one blocked prompt. The external notification path carries a waiting-epoch plus prompt-fingerprint key so repeated telemetry for the same blocked prompt does not spam providers, while later tool requests in the same session still notify operators.
      notificationDedupeKey: buildCliAgentNotificationDedupeKey(input),
    },
  };
}

/**
 * InProcessRuntime runs a project within the main process.
 *
 * This is the default execution mode — all components (TaskStore, Scheduler,
 * Executor, WorktreePool) share the same memory space and event loop.
 *
 * Features:
 * - Direct access to TaskStore and Scheduler via getter methods
 * - Synchronous event forwarding from TaskStore to runtime listeners
 * - Graceful shutdown with configurable timeout
 * - Automatic orphaned task recovery on startup
 *
 * Lifecycle boundary:
 * - Mesh networking services (PeerExchangeService + mDNS discovery) are process-level
 *   concerns owned by CLI startup paths (`runServe`/`runDashboard`) because discovery
 *   requires the final bound HTTP port. InProcessRuntime remains project-scoped and
 *   intentionally does not start process-level mesh services.
 *
 * @example
 * ```typescript
 * const config: ProjectRuntimeConfig = {
 *   projectId: "proj_abc123",
 *   workingDirectory: "/path/to/project",
 *   isolationMode: "in-process",
 *   maxConcurrent: 2,
 *   maxWorktrees: 4,
 * };
 *
 * const runtime = new InProcessRuntime(config, centralCore);
 * await runtime.start();
 *
 * // Access components directly
 * const taskStore = runtime.getTaskStore();
 * const scheduler = runtime.getScheduler();
 *
 * await runtime.stop();
 * ```
 */
/*
FNXC:CodeOrganization 2026-08-03-12:15:
Match executor formatGitRepositoryDetectionError: never interpolate the working directory into the
copy-paste safe.directory shell remedy (quote/metachar injection if pasted). Path stays in prose only.
*/
function formatRuntimeGitDetectionWarning(workingDirectory: string, detection: Extract<GitRepoDetection, { status: "error" }>): string {
  const stderr = detection.stderr.trim() || "git rev-parse --git-dir failed without stderr";
  const remedy = detection.reason === "dubious-ownership"
    ? " Resolve Git safe-directory ownership with: git config --global --add safe.directory <project-directory>"
    : "";
  return `Project directory "${workingDirectory}" could not be verified as a Git repository. ` +
    `Task execution will fail until the Git error is resolved. Git reported: ${stderr}.${remedy}`;
}

export class InProcessRuntime
  extends EventEmitter<ProjectRuntimeEvents>
  implements ProjectRuntime
{
  private status: RuntimeStatus = "stopped";
  private taskStore!: TaskStore;
  /**
   * FNXC:RuntimeStartupWiring 2026-06-24-09:55:
   * When the engine booted a PostgreSQL-backed TaskStore via
   * createTaskStoreForBackend, this holds the result's shutdown() handle so
   * the runtime's stop() path can release the connection pool and stop the
   * embedded PostgreSQL process (if one was started). Undefined on the legacy
   * SQLite path (the TaskStore owns its own SQLite teardown).
   */
  private backendShutdown?: () => Promise<void>;
  private scheduler!: Scheduler;
  private executor!: TaskExecutor;
  private worktreePool!: WorktreePool;
  /*
  FNXC:CapacityModel 2026-07-28-20:10 (drop the cross-project cap):
  The global and project-scoped semaphores are DELETED. Capacity is two numbers
  per project; the machine-wide cap was a third limiter with a separate authority
  (a central-DB singleton row) that the per-project gates then had to be reconciled
  against. The scheduler/triage semaphore gate is now simply ABSENT rather than
  holding an infinite limit — absence cannot start binding again by accident.
  */
  private stuckTaskDetector?: StuckTaskDetector;
  /**
   * Per-project CLI Agent Executor runtime bundle (PTY manager + telemetry hub +
   * adapter registry + resume coordinator). Built in `start()` when the
   * `cliAgentExecutor` experimental flag is on; threaded into the executor +
   * self-healing/stuck seams; disposed in `stop()`.
   */
  private cliAgentRuntime?: BootstrappedCliAgentRuntime;
  private usageLimitPauser?: UsageLimitPauser;
  /** One runtime-owned cooldown map keeps executor and recovery paths coherent. */
  private credentialRotator?: CredentialInstanceRotator;
  /** FNXC:PlanReviewLease 2026-07-26-20:42: cluster node id stamped onto review-gate leases; undefined until start() resolves it, or if resolution fails. */
  private localNodeId?: string;
  private selfHealingManager?: SelfHealingManager;
  private leaseManager?: MeshLeaseManager;
  private leaseCentralClaimStore?: AsyncCentralClaimStore;
  private agentStore?: AgentStore;
  private heartbeatMonitor?: HeartbeatMonitor;
  private triggerScheduler?: HeartbeatTriggerScheduler;
  private lastActivityAt: string = new Date().toISOString();
  private pluginRunner?: PluginRunner;
  private pluginStore?: PluginStore;
  private pluginLoader?: PluginLoader;
  private routineRunner?: RoutineRunner;
  private routineStore?: RoutineStore;
  private routineScheduler?: RoutineScheduler;
  private missionExecutionLoop?: MissionExecutionLoop;
  private missionAutopilot?: MissionAutopilot;
  private triageProcessor?: TriageProcessor;
  private workflowContinuationTimer?: ReturnType<typeof setInterval>;
  private workflowContinuationDrainActive = false;
  private workflowContinuationDrainSince = 0;
  /*
  FNXC:PlanReviewApproval 2026-08-04-00:26:
  Track the event edge and the durable approval marker. The marker covers engine restarts and
  cross-process updates that did not deliver the earlier awaiting-approval event.
  */
  private approvalHeldTaskIds = new Set<string>();
  private approvalReleasedTaskIds = new Set<string>();
  private messageStore?: MessageStore;
  /** FNXC:TaskDeleteNotice 2026-07-26-16:10: identity-guarded teardown for the delete-notice mailbox seam. */
  private unregisterTaskDeleteNoticeMailbox?: () => void;
  private chatStore?: ChatStore;
  private detachAgentLinkSync?: () => void;
  /**
   * Optional callback the runtime forwards to SelfHealingManager so that
   * stale-merge recovery can re-enqueue tasks immediately. Set by ProjectEngine
   * before `start()` via `setMergeEnqueuer`.
   */
  private mergeEnqueuer?: (taskId: string) => boolean;
  private mergeRequester?: (
    taskId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<import("@fusion/core").MergeResult>;
  private clearMergeActive?: (taskId: string) => void;
  private activeMergeTaskIdProvider?: () => string | null;
  private activeMergeStartedAtMsProvider?: () => number | null;
  private activeMergeAborter?: (taskId: string, reason: string) => boolean;
  /**
   * FNXC:Workspace 2026-06-22-16:40 (Phase D P1 TOCTOU): predicate that reports whether a task is
   * anywhere in ProjectEngine's in-memory merge pipeline (queued OR dequeued-and-merging). Set by
   * ProjectEngine before `start()` via `setMergePendingProvider`. Used by the workspace
   * self-healing reconcilers to avoid re-dispatching / reclaiming a task mid-dequeue→rawMerge.
   */
  private mergePendingProvider?: (taskId: string) => boolean;
  /** Tracks whether startup recovery was intentionally deferred due to pause state. */
  private startupRecoveryDeferred = false;
  /** Prevent duplicate unpause recovery dispatches from racing each other. */
  private resumeAfterUnpauseRunning = false;
  private restartRecoveryCoordinator?: RestartRecoveryCoordinator;

  /**
   * @param config - Runtime configuration
   * @param centralCore - CentralCore reference for global coordination
   */
  constructor(
    private config: ProjectRuntimeConfig,
    private centralCore: CentralCore
  ) {
    super();
    this.setMaxListeners(100);
    runtimeLog.log(`Created InProcessRuntime for project ${config.projectId}`);
  }

  /**
   * Start the runtime and initialize all subsystems.
   *
   * Initialization order:
   * 1. Initialize TaskStore
   * 2. Initialize WorktreePool
   * 3. Initialize Scheduler (with TaskStore)
   * 4. Initialize TaskExecutor (with TaskStore, worktree pool, global semaphore)
   * 5. Resume orphaned in-progress tasks
   * 6. Start scheduler
   */
  async start(): Promise<void> {
    if (this.status !== "stopped") {
      throw new Error(`Cannot start runtime: current status is ${this.status}`);
    }

    this.setStatus("starting");
    runtimeLog.log(`Starting InProcessRuntime for project ${this.config.projectId}`);

    try {
      // 1. Initialize TaskStore (use external if provided, otherwise create new)
      const {
        PluginStore: PluginStoreClass,
        PluginLoader: PluginLoaderClass,
        MessageStore: MessageStoreClass,
        // FNXC:BackendFlip 2026-06-26-14:40:
        // createTaskStoreForBackend is the startup factory that boots a
        // PostgreSQL-backed TaskStore. Post default-flip: it boots embedded PG
        // by default when DATABASE_URL is unset (the zero-config production
        // path) and external PG when DATABASE_URL is set. The engine is the primary construction site for `fn serve`
        // / dashboard: every project's TaskStore flows through
        // InProcessRuntime.start(). When the factory returns a backend result,
        // the engine owns the result's shutdown() for process teardown.
        createTaskStoreForBackend,
        buildConsumerId,
        createProjectScopedPluginMcpProvider,
        registerTaskDeleteNoticeMailbox,
      } = await import("@fusion/core");
      if (this.config.externalTaskStore) {
        this.taskStore = this.config.externalTaskStore;
        runtimeLog.log(`TaskStore provided externally for project ${this.config.projectId}`);
      } else {
        const backendBoot = await createTaskStoreForBackend({
          rootDir: this.config.workingDirectory,
          projectId: this.config.projectId,
          /* FNXC:CrossProcessDeleteObservation 2026-08-01-11:39: the engine owns this store, so its role-only identity is restart-stable and never derives from boot state. */
          consumerId: buildConsumerId("engine"),
          onMigrationProgress: this.config.onMigrationProgress,
        });
        // FNXC:PostgresFinalCutover 2026-07-14-17:20: Engine runtimes must fail
        // startup when PostgreSQL cannot boot; constructing a SQLite TaskStore is no longer valid.
        this.taskStore = backendBoot.taskStore;
        this.backendShutdown = backendBoot.shutdown;
        runtimeLog.log(
          `TaskStore initialized on PostgreSQL (${backendBoot.backend.mode}) for project ${this.config.projectId}`,
        );
      }

      /*
      FNXC:ProviderRateLimitIsolation 2026-07-19-19:10:
      Every project runtime owns one usage-limit coordinator and shares it across executor, triage, reviewer, and merger surfaces. Runtime isolation replaced the old dashboard-level construction site; constructing it here prevents a silently undefined pauser while keeping a provider outage local to the affected project/task.
      */
      this.credentialRotator ??= new CredentialInstanceRotator({
        instanceSource: createFusionAuthStorage(),
        // FNXC:CredentialInstanceRotation 2026-08-01-11:05:
        // Rotation evidence is emitted through the runtime-owned audit seam. Metadata
        // is supplied by the rotator as ids/counts/outcomes only; audit failures stay
        // non-fatal so an observability outage cannot prevent rate-limit recovery.
        recordRunAuditEvent: async (mutationType, metadata) => {
          await this.taskStore.recordRunAuditEvent?.({
            taskId: typeof metadata.taskId === "string" ? metadata.taskId : undefined,
            agentId: typeof metadata.agentId === "string" ? metadata.agentId : "runtime",
            runId: generateSyntheticRunId("credential-instance-rotation", typeof metadata.taskId === "string" ? metadata.taskId : String(metadata.providerId ?? "unknown")),
            domain: "database",
            mutationType,
            target: String(metadata.providerId ?? "unknown"),
            metadata,
          });
        },
      });
      this.usageLimitPauser ??= new UsageLimitPauser(this.taskStore, {
        credentialRotator: this.credentialRotator,
      });

      // Initialize MessageStore early so TaskExecutor receives send_message capability.
      // FNXC:RuntimeSatelliteAsync 2026-06-24-12:45:
      // In backend mode, pass the AsyncDataLayer so MessageStore delegates to the
      // async helpers; otherwise pass the sync SQLite Database (legacy path).
      const messageLayer = this.taskStore.getAsyncLayer();
      if (!messageLayer) {
        throw new Error("PostgreSQL TaskStore did not expose its AsyncDataLayer");
      }
      // FNXC:PostgresMeshClaims 2026-07-14-17:31: Cross-node checkout and
      // recovery share the central.task_claims table through the project pool.
      this.leaseCentralClaimStore = new AsyncCentralClaimStore(messageLayer);

      // FNXC:CentralCore 2026-06-26-13:30:
      // In backend mode, attach the TaskStore's AsyncDataLayer to the shared
      // CentralCore so it migrates off its SQLite CentralDatabase and shares the
      // SAME PostgreSQL connection pool as everything else. The shared CentralCore
      // is constructed before the backend is resolved (serve.ts/daemon.ts), so we
      // attach the layer here once the TaskStore is available. If the CentralCore
      // is already in backend mode (constructed with the layer) this is a no-op
      // via the init() idempotency guard. Safe in legacy mode (messageLayer null).
      if (messageLayer && !this.centralCore.backendMode) {
        try {
          await this.centralCore.attachBackendLayer(messageLayer);
        } catch (err) {
          runtimeLog.warn(
            `Failed to attach backend layer to CentralCore: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      this.messageStore = new MessageStoreClass(null, { asyncLayer: messageLayer });

      /*
      FNXC:TaskDeleteNotice 2026-07-26-16:10:
      Core owns the delete path but has no mailbox, so it exposes a store-scoped seam and the
      runtime supplies the MessageStore. Registering here (rather than process-globally) keeps one
      project's "a task was deleted by someone who is not you" notice out of another project's
      inbox. A store with no registration degrades to no notice — never to a failed delete.
      */
      this.unregisterTaskDeleteNoticeMailbox = registerTaskDeleteNoticeMailbox(
        this.taskStore,
        this.messageStore,
      );

      await yieldEventLoop();

      // 2. Initialize Plugin system (PluginStore + PluginLoader + PluginRunner)
      // FNXC:SqliteFinalRemoval 2026-06-26-10:50:
      // In backend mode, pass the AsyncDataLayer so PluginStore delegates to the
      // async helpers; otherwise use the legacy SQLite path.
      const pluginLayer = this.taskStore.getAsyncLayer();
      if (!pluginLayer) {
        throw new Error("PostgreSQL TaskStore did not expose the plugin AsyncDataLayer");
      }
      this.pluginStore = new PluginStoreClass(this.config.workingDirectory, { asyncLayer: pluginLayer });
      await this.pluginStore.init();

      this.pluginLoader = new PluginLoaderClass({
        pluginStore: this.pluginStore,
        taskStore: this.taskStore,
      });

      this.pluginRunner = new PluginRunner({
        pluginLoader: this.pluginLoader,
        pluginStore: this.pluginStore,
        taskStore: this.taskStore,
        rootDir: this.config.workingDirectory,
      });
      await this.pluginRunner.init();
      /*
       * FNXC:PluginMcpServers 2026-07-22-12:00:
       * FN-8491 installs the sole session-facing provider on the project store.
       * resolveMcpServersForStore consumes this filtered seam across every AI
       * lane; it never sees PluginRunner's raw contribution list.
       */
      const projectScopedPluginMcpProvider = createProjectScopedPluginMcpProvider(
        createRuntimePluginMcpProviderOptions({
          hostRootDir: this.config.workingDirectory,
          hostLoader: this.pluginLoader,
          PluginLoaderClass,
        }),
      );
      (this.taskStore as TaskStore & { getProjectScopedPluginMcpServers?: () => Promise<ReturnType<PluginRunner["getPluginMcpServers"]>> }).getProjectScopedPluginMcpServers = () => projectScopedPluginMcpProvider.get(this.taskStore);
      /*
       * FNXC:PluginMcpServers 2026-07-22-15:35:
       * FN-8491 / #2401 requires the runtime seam to use the core provider,
       * not an ad-hoc enabled-ID filter. The provider owns same-root caching
       * and non-persisting other-root discovery so all project contexts retain
       * their own plugin enablement state.
       */
      runtimeLog.log(`PluginRunner initialized`);

      await yieldEventLoop();

      // 3. Initialize WorktreePool

      // Reap half-initialized orphan worktree directories before doing anything
      // else with the pool.  These are directories under .worktrees/ that exist
      // on disk but were never fully registered with git (e.g. the process was
      // killed between `mkdir` and `git worktree add`).  Removing them here
      // ensures scanIdleWorktrees / rehydrate never sees broken entries, and
      // prevents assertValidWorktreeSession from permanently blocking retries.
      const { reapOrphanWorktrees, scanIdleWorktrees } = await import("../worktree/worktree-pool.js");
      const settings = await this.taskStore.getSettings();
      try {
        const reaped = await reapOrphanWorktrees(this.config.workingDirectory, settings);
        if (reaped > 0) {
          runtimeLog.log(`Reaped ${reaped} half-initialized orphan worktree(s) on startup`);
        }
      } catch (err: unknown) {
        // Non-fatal — log and continue; a missed orphan is better than a failed start.
        const msg = err instanceof Error ? err.message : String(err);
        runtimeLog.warn(`reapOrphanWorktrees failed (continuing): ${msg}`);
      }

      const gitDetection = await detectGitRepository(this.config.workingDirectory);
      if (gitDetection.status === "not-repo") {
        runtimeLog.warn(
          `Project directory "${this.config.workingDirectory}" is not a Git repository. ` +
          `Task execution will fail until a Git repository is initialized. ` +
          `Run 'git init' in the project directory to enable worktree-based task execution.`,
        );
      } else if (gitDetection.status === "error") {
        runtimeLog.warn(formatRuntimeGitDetectionWarning(this.config.workingDirectory, gitDetection));
      }

      this.worktreePool = new WorktreePool();

      // Rehydrate pool from disk state (idle worktrees)
      const idleWorktrees = await scanIdleWorktrees(
        this.config.workingDirectory,
        this.taskStore,
        settings,
      );
      if (idleWorktrees.length > 0) {
        this.worktreePool.rehydrate(idleWorktrees);
        runtimeLog.log(
          `Rehydrated worktree pool with ${idleWorktrees.length} idle worktrees`
        );
      }

      await yieldEventLoop();

      await yieldEventLoop();

      // 5a. Initialize AgentStore (required for scheduler assignment, reflection service, and heartbeat monitoring)
      // FNXC:SqliteFinalRemoval 2026-06-26-10:50:
      // In backend mode, pass the AsyncDataLayer so AgentStore delegates to the
      // async helpers; otherwise use the legacy SQLite path.
      let agentStoreForReflection: import("@fusion/core").AgentStore | undefined;
      try {
        const { AgentStore: AgentStoreClass } = await import("@fusion/core");
        const agentLayer = this.taskStore.getAsyncLayer();
        agentStoreForReflection = new AgentStoreClass({
          rootDir: this.taskStore.getFusionDir(),
          taskStore: this.taskStore,
          claimStore: this.leaseCentralClaimStore,
          projectId: this.config.projectId,
          ...(agentLayer ? { asyncLayer: agentLayer } : {}),
        });
        await agentStoreForReflection.init();
        runtimeLog.log("AgentStore initialized for reflection service");

        /*
         * FNXC:AgentStore 2026-07-09-08:15:
         * FN-7723 — this is the ONE long-lived engine AgentStore instance for
         * this project/runtime, so it is the only one that should opt into
         * cross-process change detection (fs.watch + poll re-emitting
         * agent:updated/agent:stateChanged). The CLI's short-lived AgentStore
         * (packages/cli/src/commands/agent.ts) and dashboard per-request
         * stores never call startWatching(). Failure here is non-fatal — the
         * 60s auditTimerRegistrations sweep remains the durable backstop.
         */
        try {
          await agentStoreForReflection.startWatching();
          runtimeLog.log("AgentStore cross-process change detection started");
        } catch (watchErr) {
          runtimeLog.warn(`AgentStore.startWatching() failed (falling back to the 60s audit sweep only):`, watchErr instanceof Error ? watchErr.message : watchErr);
        }
      } catch (agentErr) {
        runtimeLog.warn(`AgentStore initialization failed (reflection service will be unavailable):`, agentErr instanceof Error ? agentErr.message : agentErr);
      }
      this.agentStore = agentStoreForReflection;

      await yieldEventLoop();

      // 5. Initialize Scheduler
      /*
       * FNXC:PostgresMissionRuntime 2026-07-14-17:20:
       * Resolve one mission store for autopilot, scheduler, and validator-loop
       * behavior. Each consumer awaits the sync-or-async union, so backend mode
       * no longer disables mission execution or feature reconciliation.
       */
      let missionStore:
        | import("@fusion/core").MissionStore
        | import("@fusion/core").AsyncMissionStore
        | undefined;
      // FNXC:MissionStore 2026-06-28-12:45:
      // MissionAutopilot, Scheduler, and MissionExecutionLoop all await the
      // MissionStore | AsyncMissionStore contract, so one resolved instance
      // drives every mission lifecycle surface in both backends.
      let autopilotMissionStore:
        | import("@fusion/core").MissionStore
        | import("@fusion/core").AsyncMissionStore
        | undefined;
      try {
        const resolvedMissionStore = this.taskStore.getMissionStore();
        // Union store for the autopilot — works in both SQLite and PG backends.
        autopilotMissionStore = resolvedMissionStore;
        // FNXC:PostgresMissionRuntime 2026-07-14-17:20:
        // Scheduler and validator execution await the MissionStore union, so
        // PostgreSQL receives the same mission recovery/validation lifecycle.
        missionStore = resolvedMissionStore;
      } catch (msErr) {
        runtimeLog.warn(
          `MissionStore unavailable (${this.taskStore.isBackendMode() ? "backend mode" : "init error"}); mission autopilot disabled:`,
          msErr instanceof Error ? msErr.message : msErr,
        );
        missionStore = undefined;
        autopilotMissionStore = undefined;
      }
      this.missionAutopilot = autopilotMissionStore
        ? new MissionAutopilot(this.taskStore, autopilotMissionStore)
        : undefined;
      const missionAutopilot = this.missionAutopilot;

      // Initialize MissionExecutionLoop for validation cycle handling
      const missionExecutionLoop = missionStore
        ? new MissionExecutionLoop({
            taskStore: this.taskStore,
            missionStore,
            missionAutopilot: missionAutopilot
              ? {
                  notifyValidationComplete: async (featureId: string) => {
                    // Pass the feature's linked taskId to handleTaskCompletion, not the featureId
                    const feature = await missionStore.getFeature(featureId);
                    if (!feature?.taskId) {
                      return;
                    }
                    const slice = await missionStore.getSlice(feature.sliceId);
                    const milestone = slice ? await missionStore.getMilestone(slice.milestoneId) : undefined;
                    const missionId = milestone?.missionId;
                    if (missionId) {
                      const mission = await missionStore.getMission(missionId);
                      if (mission?.autopilotEnabled && !missionAutopilot.isWatching(missionId)) {
                        missionAutopilot.watchMission(missionId);
                      }
                    }
                    await missionAutopilot.handleTaskCompletion(feature.taskId);
                  },
                }
              : undefined,
            rootDir: this.config.workingDirectory,
            pluginRunner: this.pluginRunner,
            agentStore: this.agentStore,
          })
        : undefined;

      this.leaseManager = new MeshLeaseManager({
        taskStore: this.taskStore,
        agentStore: this.agentStore,
        getHandoffPolicy: () => this.taskStore.getSettings().then((settings) => settings.owningNodeHandoffPolicy),
        getExecutingTaskIds: () => this.executor?.getExecutingTaskIds() ?? new Set<string>(),
        centralClaimStore: this.leaseCentralClaimStore,
        projectId: this.config.projectId,
      });

      const autoClaimSnapshotManager = new AutoClaimSnapshotManager({ taskStore: this.taskStore });

      this.scheduler = new Scheduler(this.taskStore, {
        maxConcurrent: this.config.maxConcurrent,
        maxWorktrees: this.config.maxWorktrees,
        // FNXC:GlobalConcurrencyControls 2026-07-17-00:00: Feed the triage service's
        // live pre-planning in-flight count into the scheduler's stale-semaphore
        // recovery so a triage session holding a slot before it writes
        // status:"planning" is never mistaken for a leaked slot. Read lazily —
        // triageProcessor is constructed after the scheduler but exists by the
        // time the first scheduling pass runs.
        getInFlightTopLevelCount: () => this.triageProcessor?.getProcessingTaskIds().size ?? 0,
        agentStore: this.agentStore,
        hasActiveAgentExecution: (agentId: string) => this.heartbeatMonitor?.getTrackedAgents().includes(agentId) ?? false,
        missionStore,
        missionAutopilot,
        missionExecutionLoop,
        leaseManager: this.leaseManager,
        onTaskFailed: (taskId) => {
          if (missionAutopilot) {
            void missionAutopilot.handleTaskFailure(taskId);
          }
        },
        onSchedule: (task) => {
          this.recordActivity();
          /*
          FNXC:EngineDiagnostics 2026-08-03-05:54:
          Redundant with scheduler `Starting ${id}` — keep the dispatch side-effect silent by default.
          */
          runtimeLog.debug(`Scheduled task ${task.id}`);
        },
        onBlocked: () => {},
        validateNodeDispatch: async (nodeId) => {
          const mappedPath = await this.centralCore.getProjectNodePath(this.config.projectId, nodeId);
          return validateProjectNodeMapping({ nodeId, mappedPath });
        },
        snapshotManager: autoClaimSnapshotManager,

      });

      await yieldEventLoop();

      // 5a-cli. Initialize the CLI Agent Executor runtime (behind the
      // `cliAgentExecutor` experimental flag). Reuses the project's existing
      // PostgreSQL data layer; predicates feed self-healing + stuck-task seams.
      if (isExperimentalFeatureEnabled(settings, "cliAgentExecutor")) {
        /*
         * FNXC:CliAgentPostgres 2026-07-14-12:00:
         * The experimental executor is a supported PostgreSQL runtime surface;
         * enabling it must not silently disable sessions after the cutover.
         */
        try {
          const asyncLayer = this.taskStore.getAsyncLayer();
          if (!asyncLayer) {
            throw new Error("CLI Agent Executor requires the PostgreSQL data layer");
          }
          this.cliAgentRuntime = await createCliAgentRuntime({
            fusionDir: this.taskStore.getFusionDir(),
            asyncLayer,
            projectId: this.config.projectId,
            hookEndpointUrl: this.resolveCliAgentHookEndpointUrl(),
            onNotification: (info) => {
              /*
               * FNXC:ToolPermissionNotifications 2026-06-27-00:00:
               * CLI tool-permission prompts must notify operators through configured external providers, not only through in-app session state. Keep this callback wired to the active NotificationService so ntfy/webhook users see blocked terminal sessions.
               */
              void this.dispatchCliAgentAwaitingInputNotification(info);
            },
          });
          runtimeLog.log("CLI Agent Executor runtime initialized");
        } catch (cliErr) {
          runtimeLog.warn(
            `CLI Agent Executor runtime initialization failed (cli-agent nodes will report a config error):`,
            cliErr instanceof Error ? cliErr.message : cliErr,
          );
        }
      }

      // 5b. Initialize TaskExecutor
      this.stuckTaskDetector = new StuckTaskDetector(this.taskStore, {
        isCliSessionWaitingOnInput: this.cliAgentRuntime?.isCliSessionWaitingOnInput,
        beforeRequeue: (taskId, reason, event) => this.selfHealingManager?.checkStuckBudget(taskId, reason, event) ?? Promise.resolve(true),
        onLoopDetected: (event) => this.executor?.handleLoopDetected(event) ?? Promise.resolve(false),
        onStuck: (event) => {
          this.triageProcessor?.markStuckAborted(event.taskId);
          this.executor?.markStuckAborted(event.taskId, event.shouldRequeue);
          runtimeLog.warn(
            `Task ${event.taskId} stuck (${event.reason}) — ` +
            `${event.shouldRequeue ? "will retry" : "budget exhausted"}`,
          );
        },
      });

      // 5b. Initialize ReflectionStore for agent reflections
      let reflectionStoreForService: import("@fusion/core").ReflectionStore | undefined;
      try {
        const { ReflectionStore: ReflectionStoreClass } = await import("@fusion/core");
        reflectionStoreForService = new ReflectionStoreClass({ rootDir: this.taskStore.getFusionDir() });
        await reflectionStoreForService.init();
        runtimeLog.log("ReflectionStore initialized for reflection service");
      } catch (reflErr) {
        runtimeLog.warn(`ReflectionStore initialization failed (reflection service will be unavailable):`, reflErr instanceof Error ? reflErr.message : reflErr);
      }

      // 5c. Initialize AgentReflectionService (requires agentStore and reflectionStore)
      let recallCaptureWriter: import("@fusion/core").RecallCaptureWriter | undefined;
      try {
        const layer = this.taskStore.getAsyncLayer?.();
        if (layer) {
          const { createRecallCaptureWriter } = await import("@fusion/core");
          recallCaptureWriter = createRecallCaptureWriter({ layer, logger: runtimeLog });
        }
      } catch (captureInitError) {
        // FNXC:MemoryRecallCapture 2026-08-11-10:55: optional recall initialization cannot block runtime startup.
        runtimeLog.warn("Recall capture initialization failed; automatic capture remains disabled:", captureInitError instanceof Error ? captureInitError.message : captureInitError);
      }
      let reflectionService: import("../agents/agent-reflection.js").AgentReflectionService | undefined;
      if (agentStoreForReflection && reflectionStoreForService) {
        try {
          const { AgentReflectionService: AgentReflectionServiceClass } = await import("../agents/agent-reflection.js");
          reflectionService = new AgentReflectionServiceClass({
            agentStore: agentStoreForReflection,
            taskStore: this.taskStore,
            reflectionStore: reflectionStoreForService,
            rootDir: this.config.workingDirectory,
            ...(recallCaptureWriter ? { captureWriter: recallCaptureWriter } : {}),
          });
          runtimeLog.log("AgentReflectionService initialized");
        } catch (reflServiceErr) {
          runtimeLog.warn(`AgentReflectionService initialization failed:`, reflServiceErr instanceof Error ? reflServiceErr.message : reflServiceErr);
        }
      }

      let selfImproveService: import("../agents/agent-self-improve.js").AgentSelfImproveService | undefined;
      if (agentStoreForReflection && reflectionStoreForService) {
        try {
          const { AgentSelfImproveService: AgentSelfImproveServiceClass } = await import("../agents/agent-self-improve.js");
          selfImproveService = new AgentSelfImproveServiceClass({
            agentStore: agentStoreForReflection,
            reflectionStore: reflectionStoreForService,
            rootDir: this.config.workingDirectory,
          });
          runtimeLog.log("AgentSelfImproveService initialized");
        } catch (selfImproveErr) {
          runtimeLog.warn(`AgentSelfImproveService initialization failed:`, selfImproveErr instanceof Error ? selfImproveErr.message : selfImproveErr);
        }
      }

      /*
      FNXC:PrMergeAutoMerge 2026-08-09-10:59:
      Native auto-merge is project policy, so construct its CLI callbacks only
      after this runtime owns the TaskStore. A process-wide callback cannot
      safely infer which concurrently running project's setting applies.
      */
      const prNodeGithubOps = this.config.createPrNodeGithubOps?.(this.taskStore)
        ?? this.config.prNodeGithubOps;
      /*
      FNXC:SecretsEnvRuntimeWiring 2026-08-05-21:30:
      `secretsEnv` materializes only through fresh executor and heartbeat worktree acquisitions.
      Resolve the project-scoped store once at this composition boundary and share it with both
      consumers; omitting either dependency silently degrades that path to the defensive no-store skip.
      */
      const secretsStore = await this.taskStore.getSecretsStore();
      const executorOptions: TaskExecutorOptions = {
        /*
        FNXC:PlanReviewLease 2026-07-26-21:12:
        Getter, not a value: `this.localNodeId` is resolved later in start() (it needs an async
        CentralCore read), so capturing it here would freeze `undefined` and silently disable lease
        attribution. Reading it lazily at runner-construction time picks up the resolved id.
        */
        getLocalNodeId: () => this.localNodeId,
        /*
        FNXC:WorkflowAgentRouting 2026-08-07-22:39:
        FN-8764 made every role-classified graph node (execute / step-execute / review / merge)
        resolve a permanent principal through `options.agentStore`, and fail closed with
        `workflow-principal-routing-unavailable:<role>` when that store is absent. The runtime built
        the one long-lived engine AgentStore above but never handed it to the executor, so EVERY
        task deadlocked on entry to `steps#0:step-execute`: routing failed closed, the executor's
        `workflow-principal-*` hold branch swallowed the result as a recoverable wait, and the card
        sat in-progress with its foreach instance pinned `in-progress` and no session, no log, and
        no audit row. Wire the same instance the scheduler, triage, merger, and heartbeat already
        receive — an executor without it can no longer run any classified node at all.
        */
        agentStore: this.agentStore,
        pool: this.worktreePool,
        usageLimitPauser: this.usageLimitPauser,
        credentialRotator: this.credentialRotator,
        stuckTaskDetector: this.stuckTaskDetector,
        cliAgentRuntime: this.cliAgentRuntime?.bundle,
        pluginRunner: this.pluginRunner,
        messageStore: this.messageStore,
        secretsStore,
        missionStore,
        reflectionService,
        // PR-entity nodes (U3): assemble the handler deps from the CLI-injected
        // GitHub ops (createPr/mergePr/respond) + the engine-owned store. The CLI
        // layer never holds a store reference; the engine binds it here. Absent
        // ops → undefined → the pr-* node kinds fail closed.
        /*
         * FNXC:GrokCliRouting 2026-07-15-09:58:
         * Thread this.pluginRunner into buildPrNodeDeps so pr-respond agent sessions share chat/executor Grok CLI plugin-runtime injection.
         */
        prNodes: prNodeGithubOps
          ? buildPrNodeDeps(() => this.taskStore, prNodeGithubOps, this.pluginRunner)
          : undefined,
        onSliceComplete: (slice) => {
          void this.scheduler.onSliceComplete(slice);
        },
        onStart: (task, worktreePath) => {
          this.recordActivity();
          /*
          FNXC:EngineDiagnostics 2026-08-03-05:54:
          Executor already emits `Starting ${id}` at dispatch; worktree path is also on
          worktree-created / node-acquired lines. Demote this echo to debug.
          */
          runtimeLog.debug(`Started executing task ${task.id} in ${worktreePath}`);
        },
        onComplete: (task) => {
          this.recordActivity();
          runtimeLog.log(`Completed task ${task.id}`);
          this.recordTaskCompletion(task.id, true);
        },
        onError: (task, error) => {
          this.recordActivity();
          runtimeLog.error(`Task ${task.id} failed:`, error.message);
          this.recordTaskCompletion(task.id, false);

          // Mission-linked failures should be re-queued to todo so autopilot retry
          // policies can decide whether to retry or block the feature.
          if (task.sliceId) {
            void (async () => {
              try {
                const latest = await this.taskStore.getTask(task.id);
                /*
                FNXC:WorkflowLifecycleColumns 2026-08-02-15:30 (fleet — GUARD AND DESTINATION together):
                A mission task that errored is requeued from the WIP lane back to the HOLD lane. Both ends were
                literals, so on a renamed board the guard never matched and the requeue never happened — the
                errored mission task stayed in the wip lane holding a slot, which is worse than a requeue that
                fails loudly.

                Converting the guard alone would be worse still: it would admit the card and then move it to a
                `todo` the board may not declare, `moveTask` rejects an unknown column, and the task stays put
                with an exception in the log. A board that declares no hold lane keeps the card in place
                deliberately — the same outcome it has today.
                */
                const requeueLifecycle = await resolveTaskLifecycleColumns(this.taskStore, task.id);
                const requeueWip = requeueLifecycle?.wip ?? "in-progress";
                const requeueHold = requeueLifecycle ? requeueLifecycle.hold : "todo";
                if (latest?.column === requeueWip && requeueHold !== undefined) {
                  await this.taskStore.moveTask(task.id, requeueHold as never);
                }
              } catch (moveErr) {
                runtimeLog.warn(`Failed to requeue mission task ${task.id} after error:`, moveErr);
              }
            })();
          }

        },
      };

      this.executor = new TaskExecutor(
        this.taskStore,
        this.config.workingDirectory,
        executorOptions
      );
      if (this.mergeRequester) {
        this.executor.setMergeRequester(this.mergeRequester);
      }

      this.worktreePool.setInvariantViolationHandler((violation: PoolInvariantViolation) => {
        void (async () => {
          try {
            runtimeLog.warn(
              `[worktree-pool] invariant violation detected (${violation.phase}) path=${violation.path} holder=${violation.existingHolder} requester=${violation.requestingTaskId}`,
            );
            const audit = createRunAuditor(this.taskStore, {
              runId: generateSyntheticRunId("worktree-pool-invariant", violation.requestingTaskId),
              taskId: violation.requestingTaskId,
              agentId: "system",
              phase: "execute",
            });
            await audit.database({
              type: "worktree:pool-double-lease-detected",
              target: violation.path,
              metadata: violation,
            });
            await this.taskStore.logEntry(
              violation.requestingTaskId,
              `Worktree pool invariant violation (${violation.phase}): ${violation.path} is held by ${violation.existingHolder}`,
            );
          } catch (error) {
            runtimeLog.warn(`Failed to process worktree pool invariant violation: ${error instanceof Error ? error.message : String(error)}`);
          }
        })();
      });

      await yieldEventLoop();

      // 6. Initialize HeartbeatMonitor (reuses AgentStore from step 5a)
      if (this.heartbeatMonitor) {
        // Already started — nothing to do
      }
      if (!this.heartbeatMonitor && this.agentStore) {
        const chatLayer = this.taskStore.getAsyncLayer();
        if (!chatLayer) throw new Error("Heartbeat ChatStore requires the project PostgreSQL AsyncDataLayer");
        /* FNXC:PostgresSatelliteCutover 2026-07-14-17:30: Engine chat services share the authoritative project PostgreSQL layer and never reopen SQLite. */
        this.chatStore ??= new ChatStore(chatLayer);
        this.heartbeatMonitor = new HeartbeatMonitor({
          store: this.agentStore,
          agentStore: this.agentStore, // enables per-agent config resolution
          taskStore: this.taskStore,
          rootDir: this.config.workingDirectory,
          messageStore: this.messageStore,
          chatStore: this.chatStore,
          pluginRunner: this.pluginRunner,
          reflectionStore: reflectionStoreForService,
          reflectionService,
          selfImproveService,
          credentialRotator: this.credentialRotator,
          secretsStore,
          snapshotManager: autoClaimSnapshotManager,
          onMissed: (agentId, reason) => {
            runtimeLog.warn(`Agent ${agentId} missed heartbeat: ${reason}`);
          },
          onTerminated: (agentId, reason) => {
            runtimeLog.warn(`Agent ${agentId} terminated (unresponsive): ${reason}`);
          },
          onRunCompleted: (agentId) => {
            if (this.executor) {
              void this.executor.resumeTaskForAgent(agentId).catch((err) => {
                runtimeLog.warn(`resumeTaskForAgent failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
              });
            }
            void this.triggerScheduler?.drainPendingAssignment(agentId).catch((err) => {
              runtimeLog.warn(`drainPendingAssignment failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
            });
          },
          /*
           * FNXC:WorktreeAcquisition 2026-07-09-00:00:
           * A heartbeat-driven task worktree acquisition that exhausts its bounded
           * retry cap (agent-heartbeat.ts MAX_HEARTBEAT_WORKTREE_ACQUISITION_RETRIES)
           * is a real task failure that must be counted the same way `Executor`'s
           * `onError` counts a failure, so `performanceSummary.totalTasksFailed` /
           * project health stats are not silently starved (FN-7721).
           */
          onTaskAcquisitionExhausted: (taskId, detail) => {
            runtimeLog.error(`Heartbeat worktree acquisition exhausted retry cap for ${taskId}:`, detail);
            this.recordTaskCompletion(taskId, false);
          },
        });
        this.heartbeatMonitor.start();
      }

      // 6a. Initialize HeartbeatTriggerScheduler (only if agentStore is available)
      if (this.agentStore) {
        this.triggerScheduler = new HeartbeatTriggerScheduler(
          this.agentStore,
          async (agentId, source, context: WakeContext) => {
            if (!this.heartbeatMonitor) return;

            await this.heartbeatMonitor.executeHeartbeat({
              agentId,
              source,
              triggerDetail: context.triggerDetail,
              taskId: typeof context.taskId === "string" ? context.taskId : undefined,
              triggeringCommentIds: Array.isArray(context.triggeringCommentIds)
                ? context.triggeringCommentIds.filter((id): id is string => typeof id === "string" && id.length > 0)
                : undefined,
              triggeringCommentType:
                context.triggeringCommentType === "steering"
                || context.triggeringCommentType === "task"
                || context.triggeringCommentType === "pr"
                  ? context.triggeringCommentType
                  : undefined,
              contextSnapshot: { ...context },
            });
          },
          this.taskStore,
          {
            isTaskExecuting: (taskId) => this.executor.getExecutingTaskIds().has(taskId),
            // Column-agent principal alignment (plan U5, R6): reverse-direction guard
            // — an override/defer column agent must not heartbeat concurrently with a
            // column-bound session it runs but is not assigned to.
            isAgentEffectivelyExecuting: (agentId) => this.executor.isAgentEffectivelyExecuting(agentId),
          },
        );
        this.triggerScheduler.start();

        // Startup bootstrap for already-persisted agents. Ongoing lifecycle
        // updates are handled inside HeartbeatTriggerScheduler itself.
        const isHeartbeatEnabledAgent = (agent: import("@fusion/core").Agent) =>
          !isEphemeralAgent(agent) && agent.runtimeConfig?.enabled !== false;
        const isTickableHeartbeatState = (state: import("@fusion/core").AgentState) =>
          state === "active" || state === "running" || state === "idle";
        const isTimerManagedAgent = (agent: import("@fusion/core").Agent) =>
          isHeartbeatEnabledAgent(agent) && isTickableHeartbeatState(agent.state);


        // Register existing non-ephemeral, heartbeat-enabled agents in tickable states.
        try {
          const agents = await this.agentStore.listAgents();
          let registeredCount = 0;
          for (const agent of agents) {
            if (!isTimerManagedAgent(agent)) continue;
            const rc = agent.runtimeConfig;
            this.triggerScheduler.registerAgent(
              agent.id,
              {
                enabled: rc?.enabled as boolean | undefined,
                heartbeatIntervalMs: rc?.heartbeatIntervalMs as number | undefined,
                maxConcurrentRuns: rc?.maxConcurrentRuns as number | undefined,
              },
              { lastHeartbeatAt: agent.lastHeartbeatAt },
            );
            registeredCount++;
          }
          if (agents.length > 0) {
            runtimeLog.log(`Registered ${registeredCount} of ${agents.length} agents for heartbeat triggers`);
          }
        } catch (regErr) {
          runtimeLog.warn(`Failed to register agents for heartbeat triggers:`, regErr);
        }

        runtimeLog.log(`HeartbeatMonitor and TriggerScheduler initialized`);
      }

      // 7. Initialize TriageProcessor (task specification)
      // Created after AgentStore so per-agent custom instructions are available.
      this.triageProcessor = new TriageProcessor(
        this.taskStore,
        this.config.workingDirectory,
        {
          stuckTaskDetector: this.stuckTaskDetector,
          usageLimitPauser: this.usageLimitPauser,
          agentStore: this.agentStore,
          messageStore: this.messageStore,
          pluginRunner: this.pluginRunner,
          // FNXC:NodeWorktreeIsolation 2026-07-25-22:10: planning acquires (or reuses) the task's own
          // worktree through the executor's acquisition path, so no lane runs in the shared checkout.
          acquirePlanningWorktree: (taskId) => this.executor.ensureTaskWorktreeForPlanning(taskId),
          onSpecifyStart: (t) => {
            this.recordActivity();
            /*
            FNXC:EngineDiagnostics 2026-08-01-18:11:
            Duplicate of triage's richer `Specifying ${id}: ${title}` planLog line. Keep this
            short runtime echo on debug (FUSION_DEBUG=runtime) so planning start is not double-logged.
            */
            runtimeLog.debug(`Specifying ${t.id}...`);
          },
          onSpecifyComplete: (t, report) => {
            // Activity is recorded for EVERY outcome: a planning session ran either
            // way, and idle detection must not depend on whether it released.
            this.recordActivity();
            void reactToSpecificationComplete({
              taskId: t.id,
              outcome: report.outcome,
              getTask: (id) => Promise.resolve(this.taskStore.getTask(id)),
              resolveIr: (id) => resolveWorkflowIrForTask(this.taskStore, id),
              seed: (task, ir) => seedPreReleasePlanReviewContinuation(this.taskStore, task, ir),
              kick: () => this.kickWorkflowContinuationProcessor(),
              log: (message) => runtimeLog.log(message),
            }).catch((error) => {
              runtimeLog.error(`Failed to start Todo plan review for ${t.id}:`, error);
            });
          },
          onSpecifyError: (t, e) => {
            runtimeLog.error(`Triage failed for ${t.id}: ${e.message}`);
          },
        },
      );

      // Initialize RoutineScheduler (requires RoutineStore from FN-1519)
      try {
        const { RoutineStore: RoutineStoreClass } = await import("@fusion/core");
        // Verify RoutineStore actually has the expected methods (FN-1519 complete)
        if (typeof RoutineStoreClass.prototype.getDueRoutines === "function") {
          // FNXC:SqliteFinalRemoval 2026-06-26-10:55:
          // In backend mode, pass the AsyncDataLayer so RoutineStore delegates
          // to the async helpers; otherwise use the legacy SQLite path.
          const routineLayer = this.taskStore.getAsyncLayer();
          const routineStore = routineLayer
            ? new RoutineStoreClass(this.config.workingDirectory, { asyncLayer: routineLayer })
            : new RoutineStoreClass(this.config.workingDirectory);
          await routineStore.init();
          this.routineStore = routineStore;

          if (this.heartbeatMonitor) {
            const aiPromptExecutor = await createAiPromptExecutor(this.config.workingDirectory);
            const routineRunnerOptions: RoutineRunnerOptions = {
              routineStore,
              heartbeatMonitor: this.heartbeatMonitor,
              rootDir: this.config.workingDirectory,
              taskStore: this.taskStore,
              aiPromptExecutor,
            };
            this.routineRunner = new RoutineRunner(routineRunnerOptions);

            this.routineScheduler = new RoutineScheduler({
              taskStore: this.taskStore,
              routineStore,
              routineRunner: this.routineRunner,
              pollIntervalMs: 60000,
              scope: "project", // Project-scoped execution — global routines run separately
            });
            this.routineScheduler.start();
            runtimeLog.log("RoutineScheduler initialized and started");
          }
        } else {
          runtimeLog.log("RoutineStore not available (FN-1519 types not complete) — skipping RoutineScheduler");
        }
      } catch (routineErr) {
        // Non-fatal — RoutineStore may not be exported if FN-1519 is not complete
        runtimeLog.warn("RoutineScheduler initialization skipped:", routineErr instanceof Error ? routineErr.message : routineErr);
      }

      await yieldEventLoop();

      // 7. Initialize SelfHealingManager
      {
        const chatLayer2 = this.taskStore.getAsyncLayer();
        if (!chatLayer2) throw new Error("Self-healing ChatStore requires the project PostgreSQL AsyncDataLayer");
        this.chatStore ??= new ChatStore(chatLayer2);
      }
      /*
      FNXC:PlanReviewLease 2026-07-26-20:40:
      Resolve this engine's cluster node id once at start so review-gate leases can be attributed.
      Attribution is what lets self-healing tell "a lease my own dead process left behind" from "a
      peer node's lease that is genuinely running" — the former is reclaimed immediately, the latter
      keeps the 15-minute staleness floor. Fail-soft: on any error the id stays undefined, leases are
      written unattributed, and floor-only semantics (the pre-existing behavior) apply.
      */
      let localNodeId: string | undefined;
      try {
        const registeredNodes = await this.centralCore.listNodes();
        localNodeId = registeredNodes.find((node) => node.type === "local")?.id;
      } catch (error) {
        runtimeLog.warn(`Could not resolve local node id for review-gate lease attribution: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.localNodeId = localNodeId;

      this.selfHealingManager = new SelfHealingManager(this.taskStore, {
        rootDir: this.config.workingDirectory,
        localNodeId,
        agentStore: this.agentStore,
        isWorktreeResumeReserved: this.cliAgentRuntime?.isWorktreeResumeReserved,
        recoverCompletedTask: (task) => this.executor.recoverCompletedTask(task),
        recoverFailedPreMergeStep: (task) => this.executor.recoverFailedPreMergeWorkflowStep(task),
        getExecutingTaskIds: () => this.executor?.getExecutingTaskIds() ?? new Set<string>(),
        clearPhantomExecutorBinding: (taskId: string, options?: { preserveWorktrees?: boolean }) => this.executor?.clearPhantomExecutorBinding(taskId, options),
        /*
        FNXC:NodeWorktreeIsolation 2026-07-29-06:05 (FN-6756):
        Wire the read-only liveness probe. self-healing.ts's own comment records that
        `releaseExecutorWorktreeOwnership` was a declared-but-never-wired option that
        silently no-opped; an unwired probe here would be worse — `?.() === true` is
        false when unwired, so every sweep gating on it would silently stop deferring
        for live sessions and the FN-6756 fix would evaporate without a test failing.
        */
        hasLiveSessionSurface: (taskId: string) => this.executor?.hasLiveSessionSurface(taskId) ?? false,
        listWorktreeHolders: () => this.executor?.listWorktreeHolders() ?? [],
        // FNXC:PlanningEvacuation 2026-07-25-23:00: the executor owns the release safety conditions.
        releasePreExecutionWorktree: (taskId, reason) =>
          this.executor?.releasePreExecutionWorktree(taskId, reason) ?? Promise.resolve(false),
        recoverApprovedTriageTask: (task) => this.triageProcessor?.recoverApprovedTask(task) ?? Promise.resolve(false),
        getPlanningTaskIds: () => this.triageProcessor?.getPlanningTaskIds() ?? new Set<string>(),
        // FNXC:TaskTiming 2026-07-20-12:00: orphan planning recovery must defer
        // while executor-owned graph Plan Review holds the sole planning anchor.
        hasActivePlanningWorkflowSession: (taskId) => this.executor?.hasActivePlanningWorkflowSession(taskId) ?? false,
        reserveAdvancedTriageRecovery: (taskId) => this.triageProcessor?.tryReserveAdvancedRecovery(taskId),
        evictStaleTriageProcessing: () => this.triageProcessor?.evictStaleProcessing() ?? new Set<string>(),
        enqueueMerge: this.mergeEnqueuer ? (taskId: string) => this.mergeEnqueuer?.(taskId) ?? false : undefined,
        requeueForAutoMerge: this.mergeEnqueuer ? (taskId: string) => this.mergeEnqueuer?.(taskId) ?? false : undefined,
        isTaskActive: (taskId: string) => this.executor.isTaskActive(taskId),
        clearMergeActive: this.clearMergeActive ? (taskId: string) => this.clearMergeActive?.(taskId) : undefined,
        getActiveMergeTaskId: () => this.activeMergeTaskIdProvider?.() ?? null,
        getActiveMergeStartedAtMs: () => this.activeMergeStartedAtMsProvider?.() ?? null,
        abortActiveMerge: this.activeMergeAborter
          ? (taskId: string, reason: string) => this.activeMergeAborter?.(taskId, reason) ?? false
          : undefined,
        // FNXC:Workspace 2026-06-22-16:40 (Phase D P1 TOCTOU): undefined provider → "not pending"
        // (graceful when unwired; existing guards still apply). In production it is always wired.
        isMergePending: this.mergePendingProvider ? (taskId: string) => this.mergePendingProvider?.(taskId) ?? false : undefined,
        leaseManager: this.leaseManager,
        hasActiveAgentExecution: (agentId: string) => this.heartbeatMonitor?.getTrackedAgents().includes(agentId) ?? false,
        resumeAssignedTaskForAgent: (agentId: string) => this.executor.resumeTaskForAgent(agentId),
        recoverActiveMissionValidations: async () => {
          if (!this.missionExecutionLoop) {
            return { recoveredCount: 0 };
          }
          return this.missionExecutionLoop.recoverActiveMissions();
        },
        reapStaleMissionValidatorRuns: async () => {
          if (!this.missionExecutionLoop) {
            return { reapedCount: 0 };
          }
          return this.missionExecutionLoop.reapStaleValidatorRuns(VALIDATOR_RUN_STALE_MAX_AGE_MS);
        },
        reconcileAllMissionFeatures: async () => this.scheduler.reconcileAllMissionFeatures("self-healing"),
        chatStore: this.chatStore,
        messageStore: this.messageStore,
        restartDurableAgentHeartbeat: async (agentId: string, context: { reason: string; attempt: number }) => {
          if (!this.heartbeatMonitor) {
            return false;
          }
          const run = await this.heartbeatMonitor.executeHeartbeat({
            agentId,
            source: "automation",
            triggerDetail: `self-healing durable-agent transient recovery (${context.reason}, attempt ${context.attempt})`,
            contextSnapshot: {
              selfHealing: {
                reason: context.reason,
                attempt: context.attempt,
                source: "durable-agent-transient-error-recovery",
              },
            },
          });
          return !!run;
        },
      });
      this.selfHealingManager.start();
      this.stuckTaskDetector.start();
      this.detachAgentLinkSync = attachAgentLinkSync({
        store: this.taskStore,
        agentStore: this.agentStore!,
        hasActiveAgentExecution: (agentId: string) => this.heartbeatMonitor?.getTrackedAgents().includes(agentId) ?? false,
        logger: runtimeLog,
      });
      this.restartRecoveryCoordinator = new RestartRecoveryCoordinator(this.taskStore, this.executor);

      // 8. Set up event forwarding from TaskStore
      this.setupEventForwarding();
      /*
      FNXC:CrossProcessDeleteObservation 2026-08-01-13:03:
      Engine-owned stores do not call watch(), so runtime startup owns durable delete observation.
      Start only after its bridge is attached so the initial poll cannot lose a cross-process delete.
      */
      await this.taskStore.startTaskDeletedOutboxConsumer();

      const startupSettings = await this.taskStore.getSettings();
      if (startupSettings.globalPause || startupSettings.enginePaused) {
        this.startupRecoveryDeferred = true;
        runtimeLog.log(
          `Startup recovery deferred — ${
            startupSettings.globalPause ? "global pause" : "engine pause"
          } is active`,
        );
      } else {
        this.startupRecoveryDeferred = false;
        // Defer recovery sequence so the runtime start() returns quickly.
        // The sequence runs git operations and may resume orphaned tasks,
        // both of which can block the event loop for several seconds.
        // Running it in the background lets the HTTP server become
        // responsive sooner while still performing the recovery work.
        void this.resumeStartupRecoverySequence().catch((err) => {
          runtimeLog.error("Deferred startup recovery sequence failed:", err);
        });
      }

      // 11. Start scheduler and triage processor
      this.scheduler.start();
      this.triageProcessor?.start();

      // 12. Start MissionExecutionLoop for validation cycle handling
      this.missionExecutionLoop = missionExecutionLoop;
      if (missionExecutionLoop) {
        missionExecutionLoop.start();
        // Recover active missions to re-enqueue pending validations
        void missionExecutionLoop.recoverActiveMissions().catch((err) => {
          runtimeLog.error("Failed to recover active missions:", err);
        });
      }

      // Mission crash recovery: restore autopilot state for missions that were active before crash
      /*
       * FNXC:PostgresMissionRuntime 2026-07-14-17:20:
       * Crash recovery and scheduler reconciliation use the same union store in
       * both backends; initialization errors remain fail-soft for engine boot.
       */
      let activeMissionStore:
        | import("@fusion/core").MissionStore
        | import("@fusion/core").AsyncMissionStore
        | undefined;
      // FNXC:MissionStore 2026-06-28-12:45: autopilot crash-recovery now runs in BOTH
      // backends. `recoverMissions` accepts the `MissionStore | AsyncMissionStore`
      // union and awaits every store call, so resolve the store WITHOUT an instanceof
      // gate here. Scheduler reconciliation now awaits that same union.
      let activeAutopilotMissionStore:
        | import("@fusion/core").MissionStore
        | import("@fusion/core").AsyncMissionStore
        | undefined;
      try {
        const resolvedActive = this.taskStore.getMissionStore();
        activeAutopilotMissionStore = resolvedActive;
        activeMissionStore = resolvedActive;
      } catch (error) {
        activeMissionStore = undefined;
        activeAutopilotMissionStore = undefined;
        runtimeLog.warn(`[runtime] mission crash recovery skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
      const activeMissionAutopilot = this.scheduler.getMissionAutopilot?.();
      if (activeAutopilotMissionStore && activeMissionAutopilot) {
        void activeMissionAutopilot.recoverMissions(activeAutopilotMissionStore);
      }

      // 13. Reconcile feature status for all active missions (not just autopilot)
      if (activeMissionStore) {
        void this.scheduler.reconcileAllMissionFeatures("startup");
      }

      // 14. Start MissionAutopilot background polling
      this.missionAutopilot?.start();

      try {
        await this.taskStore.updateSettings({ engineActiveSinceMs: Date.now() });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        runtimeLog.warn(`Failed to stamp engineActiveSinceMs on runtime start: ${message}`);
      }

      // 15. CLI Agent Executor: recover orphaned-live sessions left by a prior
      // engine death. Non-blocking; errors are logged, never thrown.
      if (this.cliAgentRuntime) {
        const cliRuntime = this.cliAgentRuntime;
        void cliRuntime.resumeCoordinator
          .recoverOnStart()
          .then((results) => {
            if (results.length > 0) {
              runtimeLog.log(`CLI Agent Executor recovered ${results.length} orphaned session(s) on start`);
            }
          })
          .catch((err) => {
            runtimeLog.warn(
              `CLI Agent Executor recoverOnStart failed (continuing):`,
              err instanceof Error ? err.message : err,
            );
          });
      }

      this.setStatus("active");
      this.workflowContinuationTimer = setInterval(() => {
        this.kickWorkflowContinuationProcessor();
      }, 2_000);
      this.workflowContinuationTimer.unref?.();
      this.kickWorkflowContinuationProcessor();
      runtimeLog.log(`InProcessRuntime started for project ${this.config.projectId}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      /*
      FNXC:RuntimeStartupWiring 2026-07-14-18:18:
      A failed partial startup must unwind every initialized subsystem and the owned PostgreSQL backend before surfacing the original startup error. The normal stop path is deliberately safe against partially initialized fields.
      */
      try {
        await this.stop();
      } catch (cleanupError) {
        runtimeLog.warn(
          `Failed to fully unwind partial runtime startup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
      this.setStatus("errored");
      runtimeLog.error(`Failed to start InProcessRuntime:`, err.message);
      this.emit("error", err);
      throw err;
    }
  }

  /**
   * Close every process-local admission source without aborting work that is
   * already running. Development source reload uses this boundary before it
   * waits for the live-agent count to reach zero.
   */
  beginDrain(): void {
    if (this.status !== "active") return;

    this.setStatus("paused");
    if (this.workflowContinuationTimer) {
      clearInterval(this.workflowContinuationTimer);
      this.workflowContinuationTimer = undefined;
    }
    const admissionStops: Array<readonly [string, () => void]> = [
      ["self-healing manager", () => this.selfHealingManager?.stop()],
      ["routine scheduler", () => this.routineScheduler?.stop()],
      ["trigger scheduler", () => this.triggerScheduler?.stop()],
      ["stuck task detector", () => this.stuckTaskDetector?.stop()],
      ["heartbeat monitor", () => this.heartbeatMonitor?.stop()],
      ["triage processor", () => this.triageProcessor?.stop()],
      ["scheduler", () => this.scheduler?.stop()],
      ["mission autopilot", () => this.missionAutopilot?.stop()],
      ["mission execution loop", () => this.missionExecutionLoop?.stop()],
    ];
    for (const [label, stop] of admissionStops) {
      try {
        stop();
      } catch (error) {
        runtimeLog.warn(
          `Failed to stop ${label} while draining ${this.config.projectId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    runtimeLog.log(`InProcessRuntime draining for ${this.config.projectId}`);
  }

  /**
   * Stop the runtime with graceful shutdown.
   *
   * Shutdown sequence:
   * 1. Set status to "stopping"
   * 2. Stop self-healing manager
   * 3. Stop routine scheduler
   * 4. Stop trigger scheduler
   * 5. Stop stuck task detector
   * 6. Stop heartbeat monitor
   * 7. Stop scheduler
   * 8. Stop mission execution loop
   * 9. Wait for executor to finish active tasks (with timeout)
   * 10. Shutdown plugin runner
   * 11. Drain and cleanup worktree pool
   * 12. Set status to "stopped"
   *
   * @throws Error if shutdown timeout is exceeded
   */
  async stop(): Promise<void> {
    if (this.status === "stopped" || this.status === "stopping") {
      return;
    }

    this.setStatus("stopping");
    runtimeLog.log(`Stopping InProcessRuntime for project ${this.config.projectId}`);

    /*
    FNXC:PostgresResourceLifecycle 2026-07-14-18:42:
    Runtime shutdown owns the startup-factory backend handle. Capture and clear it before any subsystem cleanup so concurrent/retried stop calls cannot invoke it twice, then release it from finally even when settings, plugins, or worktree cleanup fails. The first subsystem error remains the observable stop failure; backend cleanup is best-effort and never masks it.
    */
    const backendShutdown = this.backendShutdown;
    this.backendShutdown = undefined;
    // FNXC:TaskDeleteNotice 2026-07-26-16:10: drop the mailbox seam first so a stopping runtime
    // cannot keep writing notices; the unregister is identity-guarded against a newer runtime.
    this.unregisterTaskDeleteNoticeMailbox?.();
    this.unregisterTaskDeleteNoticeMailbox = undefined;
    let stopError: Error | undefined;
    try {
      if (this.workflowContinuationTimer) {
        clearInterval(this.workflowContinuationTimer);
        this.workflowContinuationTimer = undefined;
      }
      // 2. Stop self-healing manager
      if (this.selfHealingManager) {
        this.selfHealingManager.stop();
        runtimeLog.log("SelfHealingManager stopped");
      }

      // 2c. Dispose the CLI Agent Executor runtime (scoped SIGKILL of this
      // runtime's own PTYs only — never the dashboard / port 4040).
      if (this.cliAgentRuntime) {
        try {
          await this.cliAgentRuntime.dispose();
          runtimeLog.log("CLI Agent Executor runtime disposed");
        } catch (cliErr) {
          runtimeLog.warn(
            `CLI Agent Executor dispose failed:`,
            cliErr instanceof Error ? cliErr.message : cliErr,
          );
        }
        this.cliAgentRuntime = undefined;
      }

      // 2. Stop routine scheduler (stops new routine triggers; in-flight executions continue)
      if (this.routineScheduler) {
        this.routineScheduler.stop();
        runtimeLog.log("RoutineScheduler stopped");
      }

      this.detachAgentLinkSync?.();
      this.detachAgentLinkSync = undefined;

      // 3. Tear down the ephemeral worker manager (detaches the
      // agent:stateChanged listener and clears in-memory tracking). Safe to
      // call when uninitialized.
      this.executor?.disposeEphemeralTimers();

      // 4. Stop trigger scheduler
      if (this.triggerScheduler) {
        this.triggerScheduler.stop();
        runtimeLog.log("TriggerScheduler stopped");
      }

      // 4a. Stop AgentStore cross-process change detection (FN-7723). This
      // engine store is the only AgentStore instance in this process that
      // ever called startWatching(); stopping it here clears the fs.watch
      // handle and poll interval so shutdown does not leak them.
      if (this.agentStore) {
        try {
          this.agentStore.stopWatching();
          runtimeLog.log("AgentStore cross-process change detection stopped");
        } catch (watchStopErr) {
          runtimeLog.warn(`AgentStore.stopWatching() failed:`, watchStopErr instanceof Error ? watchStopErr.message : watchStopErr);
        }
      }

      // 4. Stop stuck task detector
      if (this.stuckTaskDetector) {
        this.stuckTaskDetector.stop();
        runtimeLog.log("StuckTaskDetector stopped");
      }

      // 5. Stop heartbeat monitor
      if (this.heartbeatMonitor) {
        this.heartbeatMonitor.stop();
        runtimeLog.log("HeartbeatMonitor stopped");
      }

      // 6. Stop triage processor (prevents new specifications)
      if (this.triageProcessor) {
        this.triageProcessor.stop();
        runtimeLog.log("TriageProcessor stopped");
      }

      // 7. Stop scheduler (prevents new task scheduling)
      if (this.scheduler) {
        this.scheduler.stop();
        runtimeLog.log("Scheduler stopped");
      }

      // 7. Stop mission autopilot background polling
      if (this.missionAutopilot) {
        this.missionAutopilot.stop();
        runtimeLog.log("MissionAutopilot stopped");
      }

      // 7. Stop mission execution loop
      if (this.missionExecutionLoop) {
        this.missionExecutionLoop.stop();
        runtimeLog.log("MissionExecutionLoop stopped");
      }

      // 7b. Abort in-flight bash subprocess trees on every active agent
      // session. Each bash command was spawned with `detached: true` (own
      // process group), so killing the worker alone leaks vitest / npm / build
      // grandchildren as orphans. This call routes through pi-coding-agent's
      // AbortController -> killProcessTree, taking down the whole subtree.
      if (this.executor) {
        try {
          this.executor.abortAllSessionBash();
          runtimeLog.log("Aborted in-flight bash subprocesses on active sessions");
        } catch (err) {
          runtimeLog.warn(`Failed to abort in-flight bash subprocesses: ${err}`);
        }
      }

      // 7c. Abort and dispose all in-flight AI sessions so shutdown does not
      // continue streaming LLM output or tool calls during the drain phase.
      if (this.executor) {
        try {
          await this.executor.abortAllInFlight("engine stop");
          this.executor.disposeStoreLifecycleDisposers();
          runtimeLog.log("Aborted in-flight executor AI sessions");
        } catch (err) {
          runtimeLog.warn(`Failed to abort in-flight executor AI sessions: ${err}`);
        }
      }

      // 8. Wait for active tasks to drain after aborting live sessions.
      const settings = this.taskStore ? await this.taskStore.getSettings() : undefined;
      const shutdownTimeout = settings?.runtimeStopDrainMs ?? 2000;
      const startTime = Date.now();

      if (shutdownTimeout > 0) {
        const pollIntervalMs = Math.min(500, shutdownTimeout);
        while (Date.now() - startTime < shutdownTimeout) {
          const metrics = this.getMetrics();
          if (metrics.inFlightTasks === 0) {
            break;
          }
          runtimeLog.log(
            `Waiting for ${metrics.inFlightTasks} in-flight tasks to complete...`
          );
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
      }

      // Check if we timed out
      const finalMetrics = this.getMetrics();
      if (finalMetrics.inFlightTasks > 0) {
        runtimeLog.warn(
          `post-abort drain timeout: shutdown reached with ${finalMetrics.inFlightTasks} tasks still in-flight`
        );
      }

      /*
      FNXC:CapacityModel 2026-07-28-20:10 (drop the cross-project cap):
      The residual-slot return on stop is GONE with the scoped semaphore it drained.
      There is no shared cross-project pool left to leak INTO, so a session that
      skips its finally path can no longer strand capacity belonging to another
      project. Per-project capacity is derived from live task rows by the hold/
      release sweep, which recomputes occupancy every pass rather than tracking a
      counter that can drift.
      */

      // 8. Shutdown plugin runner
      if (this.pluginRunner) {
        await this.pluginRunner.shutdown();
        runtimeLog.log("PluginRunner shutdown complete");
      }

      // 9. Drain and cleanup worktree pool
      if (this.worktreePool) {
        const worktrees = this.worktreePool.drain();
        if (worktrees.length > 0) {
          runtimeLog.log(`Drained ${worktrees.length} worktrees from pool`);
        }
      }

      this.leaseCentralClaimStore = undefined;

      this.setStatus("stopped");
      runtimeLog.log(`InProcessRuntime stopped for project ${this.config.projectId}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      stopError = err;
      this.setStatus("errored");
      runtimeLog.error(`Error during shutdown:`, err.message);
      this.emit("error", err);
    } finally {
      if (backendShutdown) {
        try {
          await backendShutdown();
        } catch (err) {
          runtimeLog.warn(
            `Backend shutdown failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
    if (stopError) throw stopError;
  }

  /**
   * Get the current runtime status.
   */
  getStatus(): RuntimeStatus {
    return this.status;
  }

  /**
   * Register a callback used by SelfHealingManager to re-enqueue tasks for
   * auto-merge after clearing a stale `merging` status. Must be called before
   * `start()` because SelfHealingManager is constructed during startup.
   */
  setMergeEnqueuer(enqueueMerge: (taskId: string) => boolean): void {
    this.mergeEnqueuer = enqueueMerge;
  }

  /**
   * Wire the workflow-graph merge seam to ProjectEngine.onMerge. Late-bindable:
   * forwards immediately when the executor already exists, and is re-applied at
   * executor construction during start().
   */
  setMergeRequester(
    requestMerge: (
      taskId: string,
      options?: { signal?: AbortSignal },
    ) => Promise<import("@fusion/core").MergeResult>,
  ): void {
    this.mergeRequester = requestMerge;
    this.executor?.setMergeRequester(requestMerge);
  }

  setMergeActiveClearer(clearMergeActive: (taskId: string) => void): void {
    this.clearMergeActive = clearMergeActive;
  }

  setActiveMergeTaskIdProvider(getActiveMergeTaskId: () => string | null): void {
    this.activeMergeTaskIdProvider = getActiveMergeTaskId;
  }

  setActiveMergeStartedAtMsProvider(getActiveMergeStartedAtMs: () => number | null): void {
    this.activeMergeStartedAtMsProvider = getActiveMergeStartedAtMs;
  }

  setActiveMergeAborter(abortActiveMerge: (taskId: string, reason: string) => boolean): void {
    this.activeMergeAborter = abortActiveMerge;
  }

  setMergePendingProvider(isMergePending: (taskId: string) => boolean): void {
    this.mergePendingProvider = isMergePending;
  }

  /**
   * Resume executor/self-healing activity after an unpause transition.
   *
   * When startup recovery had been deferred, this replays the original startup
   * ordering so orphan resume and self-healing cannot race each other.
   */
  async resumeAfterUnpause(): Promise<void> {
    if (!this.taskStore || !this.executor || !this.selfHealingManager) {
      return;
    }
    if (this.resumeAfterUnpauseRunning) {
      return;
    }

    this.resumeAfterUnpauseRunning = true;
    try {
      const settings = await this.taskStore.getSettings();
      if (settings.globalPause || settings.enginePaused) {
        runtimeLog.log(
          `Unpause recovery still blocked — ${
            settings.globalPause ? "global pause" : "engine pause"
          } remains active`,
        );
        return;
      }

      if (this.startupRecoveryDeferred) {
        await this.resumeStartupRecoverySequence();
        this.startupRecoveryDeferred = false;
        return;
      }

      await this.executor.resumeOrphaned();
    } finally {
      this.resumeAfterUnpauseRunning = false;
    }
  }

  private async resumeStartupRecoverySequence(): Promise<void> {
    // Restart recovery decides when interrupted runs can safely resume versus
    // when they must be reset to todo for a clean retry.
    await this.restartRecoveryCoordinator!.recoverInterruptedRuns();

    // Some "stuck" tasks are already orphaned by the time the runtime boots:
    // they no longer have a tracked session/worktree, so the stuck detector
    // cannot recover them. Delegate the startup recovery pass to
    // SelfHealingManager so the policy lives in one place.
    void this.selfHealingManager!.runStartupRecovery().catch((err) => {
      runtimeLog.error("Self-healing startup recovery failed:", err);
    });
  }

  /**
   * Get the project's TaskStore instance.
   * @throws Error if runtime has not been started
   */
  getTaskStore(): TaskStore {
    if (!this.taskStore) {
      throw new Error("TaskStore not initialized. Call start() first.");
    }
    return this.taskStore;
  }

  /**
   * FNXC:PlannerOversight 2026-07-13-23:05:
   * Expose TaskExecutor so ProjectEngine can wire session-advisor log flush.
   */
  getExecutor(): TaskExecutor | undefined {
    return this.executor;
  }

  /**
   * Get the AgentStore instance (if initialized).
   * Returns undefined before start() or if init fails.
   */
  getAgentStore(): import("@fusion/core").AgentStore | undefined {
    return this.agentStore;
  }

  /**
   * Get the MessageStore instance (if initialized).
   * Returns undefined before start() or if initialization fails.
   */
  getMessageStore(): import("@fusion/core").MessageStore | undefined {
    return this.messageStore;
  }

  /**
   * Get the ChatStore instance (if initialized).
   * Returns undefined before start() or if initialization fails.
   */
  getChatStore(): import("@fusion/core").ChatStore | undefined {
    return this.chatStore;
  }

  /**
   * Get the project-scoped PluginRunner (if initialized).
   * Dashboard chat needs this runner, not the top-level PluginLoader, so
   * runtime hints such as `hermes` can resolve plugin runtimes correctly.
   */
  getPluginRunner(): PluginRunner | undefined {
    return this.pluginRunner;
  }

  /**
   * Get the project's Scheduler instance.
   * @throws Error if runtime has not been started
   */
  getScheduler(): Scheduler {
    if (!this.scheduler) {
      throw new Error("Scheduler not initialized. Call start() first.");
    }
    return this.scheduler;
  }

  clearTaskPauseAbortState(taskId: string): void {
    this.executor?.clearPauseAbortStateForManualRetry(taskId);
  }

  configurePrMonitoring(options: {
    prMonitor: PrMonitor;
    onClosedPrFeedback?: (taskId: string, prInfo: PrInfo, comments: PrComment[]) => void | Promise<void>;
  }): void {
    if (!this.scheduler) {
      throw new Error("Scheduler not initialized. Call start() first.");
    }

    this.scheduler.configurePrMonitoring(options);
  }

  /**
   * Get current runtime metrics.
   */
  getMetrics(): RuntimeMetrics {
    // Estimate in-flight tasks by checking active sessions
    const inFlightTasks = this.executor
      ? (this.executor as unknown as { activeWorktrees?: Map<string, string> }).activeWorktrees?.size ?? 0
      : 0;

    /*
    FNXC:CapacityModel 2026-07-28-20:10 (drop the cross-project cap):
    Active-agent load now comes from the executor's live worktree map rather than a
    semaphore counter. The counter was a second bookkeeping of the same fact and
    needed its own leak reaper when the two drifted.
    */
    const activeAgents = inFlightTasks;

    // Get memory usage if available
    const memoryBytes = process.memoryUsage?.().heapUsed;

    return {
      inFlightTasks,
      activeAgents,
      lastActivityAt: this.lastActivityAt,
      memoryBytes,
    };
  }

  /**
   * Get the HeartbeatMonitor instance (if initialized).
   * Returns undefined when agent monitoring is not available.
   */
  getHeartbeatMonitor(): HeartbeatMonitor | undefined {
    return this.heartbeatMonitor;
  }

  getSelfHealingManager(): SelfHealingManager | undefined {
    return this.selfHealingManager;
  }

  /**
   * Get the bootstrapped CLI Agent Executor runtime (if the experimental flag is
   * on and construction succeeded). The dashboard reads this to resolve the
   * project's TelemetryHub (hook route) and supply the cli-session transport.
   */
  getCliAgentRuntime(): BootstrappedCliAgentRuntime | undefined {
    return this.cliAgentRuntime;
  }

  private async dispatchCliAgentAwaitingInputNotification(
    info: CliAgentAwaitingInputNotificationInfo,
  ): Promise<void> {
    const notificationService = getActiveNotificationService();
    if (!notificationService) {
      return;
    }

    const session = this.cliAgentRuntime?.bundle.store.getSession(info.sessionId);
    let task: Task | undefined;
    if (session?.taskId) {
      try {
        task = await this.taskStore.getTask(session.taskId);
      } catch {
        task = undefined;
      }
    }

    const payload = buildCliAgentAwaitingInputNotificationPayload({
      projectId: this.config.projectId,
      info,
      session,
      task,
    });
    await notificationService.dispatch(CLI_AGENT_AWAITING_INPUT_EVENT, payload);
  }

  /**
   * Resolve the dashboard CLI-agent hook ingestion endpoint URL. Prefers the
   * value threaded from server boot (once the listening port is known); falls
   * back to a localhost URL derived from `FUSION_DASHBOARD_PORT` (default 4040).
   */
  private resolveCliAgentHookEndpointUrl(): string {
    if (this.config.cliAgentHookEndpointUrl) {
      return this.config.cliAgentHookEndpointUrl;
    }
    const port = Number(process.env.FUSION_DASHBOARD_PORT) || 4040;
    return `http://127.0.0.1:${port}/api/cli-agent/hooks`;
  }

  /**
   * Get the HeartbeatTriggerScheduler instance (if initialized).
   * Returns undefined when agent monitoring is not available.
   */
  getTriggerScheduler(): HeartbeatTriggerScheduler | undefined {
    return this.triggerScheduler;
  }

  /**
   * Get the RoutineRunner instance (if initialized).
   * Returns undefined when RoutineStore is not available.
   */
  getRoutineRunner(): RoutineRunner | undefined {
    return this.routineRunner;
  }

  /**
   * Get the RoutineStore instance (if initialized).
   * Returns undefined when RoutineStore is not available.
   */
  getRoutineStore(): RoutineStore | undefined {
    return this.routineStore;
  }

  /**
   * Get the RoutineScheduler instance (if initialized).
   * Returns undefined when RoutineStore is not available.
   */
  getRoutineScheduler(): RoutineScheduler | undefined {
    return this.routineScheduler;
  }

  /**
   * Get the TriageProcessor instance (if initialized).
   * Returns undefined before start() completes.
   */
  getTriageProcessor(): TriageProcessor | undefined {
    return this.triageProcessor;
  }

  /**
   * Get the MissionAutopilot instance (if initialized).
   * Returns undefined when no MissionStore is available.
   */
  getMissionAutopilot(): MissionAutopilot | undefined {
    return this.missionAutopilot;
  }

  /**
   * Get the MissionExecutionLoop instance (if initialized).
   * Returns undefined when no MissionStore is available.
   */
  getMissionExecutionLoop(): MissionExecutionLoop | undefined {
    return this.missionExecutionLoop;
  }

  /**
   * FNXC:WorkflowScheduling 2026-07-21-12:20:
   * Wake the durable task-continuation consumer in a microtask so triage can
   * release its own execution slot before continuation dispatch begins.
   */
  private kickWorkflowContinuationProcessor(): void {
    queueMicrotask(() => {
      void this.drainWorkflowContinuations().catch((error) => {
        runtimeLog.error("Workflow continuation processor failed:", error);
      });
    });
  }

  /**
   * FNXC:WorkflowScheduling 2026-07-21-12:20:
   * A single runtime drain owns selection at a time. Concurrent wakeups collapse
   * behind this guard and the recurring processor supplies the next bounded pass.
   *
   * The pass itself lives in `drainDuePlanningContinuations` (see its header for
   * the FN-8470/FN-8471 orphan rationale and the deferral); this method is the
   * runtime-lifecycle wrapper — re-entry guard, active-status check, and the
   * adapters that bind the pass to this runtime's store and executor.
   */
  private async drainWorkflowContinuations(): Promise<void> {
    if (this.status !== "active") return;
    if (this.workflowContinuationDrainActive) {
      /* FNXC:PumpWatchdog 2026-08-01-02:00: one hung pass leaves the guard closed forever and every later tick/wake drops SILENTLY (the triage-poll death, 00769fad7c/e51ebff381). Past the threshold, warn with the stuck duration and force the guard open; the hung pass's own finally re-clearing it later is harmless. */
      const stuckMs = this.workflowContinuationDrainSince > 0 ? Date.now() - this.workflowContinuationDrainSince : 0;
      if (stuckMs < 300_000) return;
      runtimeLog.warn(`continuation-drain watchdog: previous drain still marked in-flight after ${Math.round(stuckMs / 1000)}s — forcing the guard open`);
    }
    this.workflowContinuationDrainActive = true;
    this.workflowContinuationDrainSince = Date.now();
    /*
    FNXC:EnginePause 2026-08-01-00:20:
    A pause-suspended run persists a runnable continuation (same mechanism as capacity). Without
    this gate the drain would re-dispatch it on the next tick and the graph would bounce
    suspend→dispatch→suspend forever while paused — and worse, dispatch genuinely new work under
    Stop AI Engine. Settings are re-read here (not event-driven) for the same reason as the
    boundary probe: the pause must bind even if `settings:updated` never reaches this instance.
    */
    try {
      const settings = await this.taskStore.getSettings();
      if (settings.globalPause === true || settings.enginePaused === true) return;
    } catch {
      /* unreadable settings: proceed as before rather than wedging the pump */
    }
    try {
      await drainDuePlanningContinuations({
        listDue: () => this.taskStore.listDueWorkflowWorkItems({
          kinds: ["task"],
          states: ["runnable", "retrying"],
          limit: DUE_PLANNING_CONTINUATION_BATCH_LIMIT,
        }),
        getTask: (taskId) => Promise.resolve(this.taskStore.getTask(taskId)),
        /* FNXC:WorkflowLifecycleColumns 2026-08-02-15:20 (fleet): the PRODUCTION resolver for the drain's
           terminal check — the pure pass keeps the legacy pair when this is omitted, which is what every
           existing test relies on. One IR read per due item, and the batch is capped by
           DUE_PLANNING_CONTINUATION_BATCH_LIMIT. */
        resolveTerminalColumns: async (taskId) => {
          const lifecycle = await resolveTaskLifecycleColumns(this.taskStore, taskId);
          return new Set([
            lifecycle?.complete ?? "done",
            lifecycle?.archived ?? "archived",
            "done",
            "archived",
          ]);
        },
        cancelOrphan: (item, reason) => this.cancelOrphanedWorkflowWorkItem(item, reason),
        defer: (deferral) => this.deferParkedWorkflowWorkItem(deferral),
        dispatch: createPlanningContinuationDispatcher({
          store: this.taskStore,
          projectId: this.taskStore.getRootDir(),
          execute: (task) => this.executor.execute(task),
          onError: (_task, item, error) => {
            runtimeLog.error(`Workflow continuation ${item.id} failed:`, error);
          },
        }),
        nowMs: () => Date.now(),
        warn: (message) => runtimeLog.warn(message),
      });
    } finally {
      this.workflowContinuationDrainActive = false;
    }
  }

  /**
   * FNXC:PlanApprovalHold 2026-07-27-21:30 (U7, PR #2491 review — greptile P1):
   * Push an operator-parked item's `retryAfter` forward so it leaves the due
   * window. State stays `runnable` on purpose (see
   * `PARKED_CONTINUATION_DEFER_MS`).
   *
   * Fail-soft: if the write loses, the item simply stays due and is re-skipped
   * next pass — exactly the pre-deferral behavior — so a store hiccup degrades to
   * the old starvation risk rather than dropping the card's continuation.
   */
  private async deferParkedWorkflowWorkItem(
    deferral: { itemId: string; expectedState: WorkflowWorkItemState; retryAfter: string },
  ): Promise<void> {
    if (typeof this.taskStore.transitionWorkflowWorkItem !== "function") return;
    try {
      // `expectedState` makes this a compare-and-set: if another node claimed or
      // terminalized the item since the due poll, the store returns it untouched.
      await this.taskStore.transitionWorkflowWorkItem(deferral.itemId, deferral.expectedState, {
        expectedState: deferral.expectedState,
        retryAfter: deferral.retryAfter,
      });
    } catch (error) {
      runtimeLog.warn(
        `Failed to defer parked workflow work item ${deferral.itemId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * FNXC:WorkflowScheduling 2026-07-21-22:31:
   * Terminalize a due work item whose task can no longer host graph work so the
   * FIFO due poll no longer revisits it every 2s. Fail-soft: a transition race
   * must not abort the rest of the drain.
   */
  private async cancelOrphanedWorkflowWorkItem(
    item: WorkflowWorkItem,
    reason: "task-not-found" | "task-terminal",
  ): Promise<void> {
    if (typeof this.taskStore.transitionWorkflowWorkItem !== "function") return;
    try {
      await this.taskStore.transitionWorkflowWorkItem(item.id, "cancelled", {
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: `orphaned-continuation:${reason}`,
        blockedReason: reason,
      });
      runtimeLog.log(
        `Cancelled orphaned workflow work item ${item.id} (task=${item.taskId}, node=${item.nodeId}, reason=${reason})`,
      );
    } catch (error) {
      runtimeLog.warn(
        `Failed to cancel orphaned workflow work item ${item.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Execute a heartbeat run for an agent.
   *
   * Delegates to HeartbeatMonitor.executeHeartbeat().
   * Throws if the runtime is not active or the heartbeat monitor is not initialized.
   *
   * @param agentId - The agent ID to execute a heartbeat for
   * @param source - What triggered this heartbeat
   * @param options - Optional task ID override and trigger detail
   * @returns The completed heartbeat run
   */
  async executeHeartbeat(
    agentId: string,
    source: HeartbeatInvocationSource,
    options?: { taskId?: string; triggerDetail?: string; contextSnapshot?: Record<string, unknown> }
  ): Promise<AgentHeartbeatRun | null> {
    if (this.status !== "active") {
      throw new Error(`Cannot execute heartbeat: runtime status is ${this.status}`);
    }
    if (!this.heartbeatMonitor) {
      return null;
    }

    runtimeLog.log(`Executing heartbeat for agent ${agentId} (source=${source})`);
    const result = await this.heartbeatMonitor.executeHeartbeat({
      agentId,
      source,
      ...options,
    });
    runtimeLog.log(`Heartbeat completed for agent ${agentId}`);
    return result;
  }

  /**
   * Set the StuckTaskDetector for this runtime.
   */
  setStuckTaskDetector(detector: StuckTaskDetector): void {
    this.stuckTaskDetector = detector;
  }

  /**
   * Set the UsageLimitPauser for this runtime.
   */
  setUsageLimitPauser(pauser: UsageLimitPauser): void {
    this.usageLimitPauser = pauser;
    pauser.setCredentialRotator(this.credentialRotator);
  }

  /**
   * Set up event forwarding from TaskStore to runtime listeners
   * for task:created, task:moved, task:updated, and task:deleted.
   */
  private setupEventForwarding(): void {
    // Forward task:created events
    this.taskStore.on("task:created", (task: Task) => {
      this.recordActivity();
      this.emit("task:created", task);
    });

    // Forward task:moved events
    this.taskStore.on("task:moved", (data: { task: Task; from: string; to: string }) => {
      this.recordActivity();
      /*
      FNXC:TaskDetailPlannerChatRetention 2026-06-30-18:45:
      In-process task archival is the retention cutoff for task-local planner chats. Keep interacted planner chats when tasks reach done, but delete exact task-planner sessions on archive through ChatStore so normal conversations and other tasks remain untouched.

      FNXC:WorkflowLifecycleColumns 2026-08-02-15:50 (fleet):
      ARCHIVAL IS THE CUTOFF, and on a renamed board the literal never matched — so task-planner chats were
      never deleted on archive. That is the quiet direction of this defect class: nothing breaks, data that
      should have been cleaned up simply accumulates, and the only symptom is storage growth nobody attributes
      to a column name.

      The resolution is async and this is a sync event handler, so the branch moves inside a `void (async …)`
      — the deletion was already fire-and-forget (`void this.chatStore?.…`), so nothing about the handler's
      timing contract changes. `data.to` is still accepted when it equals the legacy `archived`, because a row
      moved into a column the workflow no longer declares is still archived.
      */
      void (async () => {
        const archivedLifecycle = await resolveTaskLifecycleColumns(this.taskStore, data.task.id)
          .catch(() => undefined);
        const archivedColumn = archivedLifecycle?.archived ?? "archived";
        /* Resolved archive lane UNION the legacy id — the guard already accepted either. */
        const archivedLanes = new Set<string>([archivedColumn, ...LEGACY_ARCHIVE_LANES]);
        if (!archivedLanes.has(data.to)) return;
        await this.chatStore?.deleteSessionsForAgentId(
          `${TASK_PLANNER_CHAT_AGENT_ID_PREFIX}${data.task.id}`,
          { projectId: this.config.projectId },
        );
      })();
      this.emit("task:moved", data);
    });

    // Forward task:updated events
    this.taskStore.on("task:updated", (task: Task) => {
      this.recordActivity();
      if (task.status === "awaiting-approval") {
        this.approvalHeldTaskIds.add(task.id);
        this.approvalReleasedTaskIds.delete(task.id);
      } else if (
        !task.status
        && !task.paused
        && !task.userPaused
        && (
          this.approvalHeldTaskIds.delete(task.id)
          || (
            (Boolean(task.approvedPlanFingerprint) || task.workflowStepResults?.some(isPlanReviewSatisfied) === true)
            && !this.approvalReleasedTaskIds.has(task.id)
          )
        )
      ) {
        this.approvalReleasedTaskIds.add(task.id);
        void wakeApprovedPlanningContinuations({
          taskId: task.id,
          list: (taskId) => this.taskStore.listWorkflowWorkItemsForTask(taskId),
          transition: (itemId, state, patch) => this.taskStore.transitionWorkflowWorkItem(itemId, state, patch),
          kick: () => this.kickWorkflowContinuationProcessor(),
          warn: (message) => runtimeLog.warn(message),
        });
      }
      this.emit("task:updated", task);
    });

    /*
    FNXC:CrossProcessDeleteObservation 2026-08-01-12:02:
    Preserve observed outbox provenance through the runtime bridge. Downstream project and IPC
    bridges must distinguish cross-process deletion delivery without re-running writer effects.
    */
    this.taskStore.on("task:deleted", (task: Task, meta?: { githubIssueAction?: GithubIssueAction; observed?: boolean; outboxEventId?: string }) => {
      this.recordActivity();
      this.approvalHeldTaskIds.delete(task.id);
      this.approvalReleasedTaskIds.delete(task.id);
      this.emit("task:deleted", task, meta);
    });

    runtimeLog.log("Event forwarding setup complete");
  }

  /**
   * Update status and emit health-changed event.
   */
  private setStatus(newStatus: RuntimeStatus): void {
    const previous = this.status;
    this.status = newStatus;

    if (previous !== newStatus) {
      this.emit("health-changed", { status: newStatus, previous });
    }
  }

  /**
   * Record activity timestamp.
   */
  private recordActivity(): void {
    this.lastActivityAt = new Date().toISOString();
  }

  /*
  FNXC:CapacityModel 2026-07-28-23:30 (drop the cross-project cap — settings half):
  `getGlobalConcurrencyLimit` is DELETED. Its only caller was the global semaphore
  construction removed in the enforcement half, so it has been reading a limit
  nothing consults. Capacity is two numbers per project.
  */

  /**
   * Record task completion in CentralCore.
   */
  private async recordTaskCompletion(_taskId: string, success: boolean): Promise<void> {
    try {
      // Estimate duration (simplified - in reality, we'd track start time)
      const durationMs = 0; // Placeholder
      await this.centralCore.recordTaskCompletion(this.config.projectId, durationMs, success);
    } catch (error) {
      // Non-fatal: logging is best-effort
      runtimeLog.warn(`Failed to record task completion: ${error}`);
    }
  }
}
