import {
  getCurrentRepo,
  resolveDependencyOrder,
  sortTasksByPriorityFanoutThenAgeAndId,
  buildUnblockWeightMap,
  computeBlockerFanoutMap,
  compareTasksByPriorityThenAgeAndId,
  HIGH_FANOUT_BLOCKER_TODO_THRESHOLD,
  type TaskStore,
  type Task,
  type MissionStore,
  type MissionFeature,
  type PrInfo,
  type AgentStore,
  type Settings,
  TransitionRejectionError,
} from "@fusion/core";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { recoverIdleSemaphoreLeakCandidate, type AgentSemaphore } from "./concurrency.js";
import { planTaskWorktreePath, resolveTaskWorkingBranch } from "./worktree-names.js";
import { schedulerLog } from "./logger.js";
import { type PrMonitor, type PrComment } from "./pr-monitor.js";
import { reconcileMissionFeatureState } from "./mission-feature-sync.js";
import { evaluateSpecStaleness, getPromptPath } from "./spec-staleness.js";
import { resolveEffectiveNode } from "./effective-node.js";
import { applyUnavailableNodePolicy, decideOwningNodeHandoff } from "./node-routing-policy.js";
import type { NodeDispatchValidationResult } from "./node-dispatch-validation.js";
import type { MeshLeaseManager } from "./mesh-lease-manager.js";
import { selectPermanentAgentForTask } from "./agent-assignment.js";
import type { AutoClaimSnapshotManager } from "./auto-claim-snapshot.js";
import { StaleTaskReporter } from "./stale-task-reporter.js";
import { BacklogPressureReporter } from "./backlog-pressure-reporter.js";
import { UnlinkedMissionsAdvisoryReporter } from "./unlinked-missions-advisory-reporter.js";
import { createRunAuditor, generateSyntheticRunId } from "./run-audit.js";
import { isWorkflowColumnsEnabled, DEFAULT_WORKFLOW_POOL_ID } from "@fusion/core";
import { runHoldReleaseSweep, type SlotReservation } from "./hold-release.js";
import { evaluateParkedAgentTaskLink } from "./task-agent-sync.js";

function shouldRunWorkflowColumnScheduler(_settings: Settings): boolean {
  /*
  FNXC:WorkflowScheduling 2026-06-22-00:00:
  Workflow columns are the scheduler runtime after cutover. Persisted workflowColumns=false values are stale compatibility data and must not reactivate the legacy todo dispatcher or bypass workflow hold/release gates.
  */
  return true;
}

/**
 * Check whether two sets of file scope paths overlap.
 * Paths overlap if they are identical, or if one is a directory prefix of the other.
 * Glob patterns (ending with `/*`) are treated as directory prefixes.
 *
 * Exported for direct unit testing; used internally by {@link Scheduler}.
 */
export function pathsOverlap(a: string[], b: string[]): boolean {
  for (const pa of a) {
    const prefixA = pa.endsWith("/*") ? pa.slice(0, -1) : null;
    for (const pb of b) {
      const prefixB = pb.endsWith("/*") ? pb.slice(0, -1) : null;

      // Exact match (ignoring glob suffix)
      const cleanA = prefixA ? pa.slice(0, -2) : pa;
      const cleanB = prefixB ? pb.slice(0, -2) : pb;
      if (cleanA === cleanB) return true;

      // Check prefix overlap
      if (prefixA && pb.startsWith(prefixA)) return true;
      if (prefixB && pa.startsWith(prefixB)) return true;
      if (prefixA && prefixB) {
        if (prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA))
          return true;
      }

      // Exact file path match
      if (pa === pb) return true;
    }
  }
  return false;
}

function normalizeOverlapPath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function hasHiddenOverlapPathSegment(path: string): boolean {
  const normalizedPath = normalizeOverlapPath(path);
  if (!normalizedPath) return false;
  return normalizedPath.split("/").some((segment) => segment.startsWith("."));
}

function isIgnoredOverlapPath(path: string, ignorePath: string): boolean {
  const normalizedPath = normalizeOverlapPath(path);
  const normalizedIgnore = normalizeOverlapPath(ignorePath);

  if (normalizedIgnore.endsWith("/*")) {
    const directory = normalizedIgnore.slice(0, -2);
    return normalizedPath === directory || normalizedPath.startsWith(`${directory}/`);
  }

  if (normalizedIgnore.endsWith("/")) {
    const directory = normalizedIgnore.slice(0, -1);
    return normalizedPath === directory || normalizedPath.startsWith(normalizedIgnore);
  }

  return normalizedPath === normalizedIgnore || normalizedPath.startsWith(`${normalizedIgnore}/`);
}

function computeAutoClaimFingerprint(task: Task): string {
  const dependencies = [...(task.dependencies ?? [])].sort().join(",");
  const sortAt = task.columnMovedAt ?? task.createdAt;
  return [
    task.column,
    task.paused === true ? "1" : "0",
    task.assignedAgentId ?? "",
    task.checkedOutBy ?? "",
    task.deletedAt ?? "",
    dependencies,
    sortAt,
  ].join("|");
}

export interface FilterOverlapPathsOptions {
  ignoreHiddenOverlapPaths?: boolean;
}

/**
 * Remove scope entries that should not participate in file-overlap serialization.
 *
 * FNXC:OverlapScheduling 2026-06-23-13:09:
 * Hidden dot paths are ignored by default for overlap blockers because task artifacts and hidden/generated metadata such as `.fusion/`, `.changeset/`, `.github/`, `.env`, and nested `.cache/` directories caused false serialization. Operators can set `ignoreHiddenOverlapPaths=false` to restore legacy counting, while explicit `overlapIgnorePaths` keep their exact/directory/glob-prefix semantics in either mode.
 */
export function filterPathsByIgnoreList(
  paths: string[],
  ignorePaths?: string[],
  options: FilterOverlapPathsOptions = {},
): string[] {
  const shouldIgnoreHidden = options.ignoreHiddenOverlapPaths ?? true;
  const normalizedIgnorePaths = (ignorePaths ?? []).map(normalizeOverlapPath).filter(Boolean);

  if (!shouldIgnoreHidden && normalizedIgnorePaths.length === 0) {
    return paths;
  }

  return paths.filter((path) => {
    if (shouldIgnoreHidden && hasHiddenOverlapPathSegment(path)) return false;
    return !normalizedIgnorePaths.some((ignore) => isIgnoredOverlapPath(path, ignore));
  });
}

export interface QueuedOverlapCandidate {
  id: string;
  priority?: Task["priority"] | null;
  createdAt: string;
  scope: string[];
}

const COORDINATION_SAFE_SCOPE_EXACT = new Set([
  // Literal glob scope entries from PROMPT.md are kept here; concrete
  // `.changeset/<name>.md` files are covered by COORDINATION_SAFE_SCOPE_PREFIXES.
  ".changeset/*.md",
  "scripts/test-all-packages.sh",
]);

const COORDINATION_SAFE_SCOPE_PREFIXES = [
  "docs/",
  ".fusion/tasks/",
  ".changeset/",
];

const DEFAULT_DISPATCH_OSCILLATION_SETTLE_MS = 5_000;
const DEFAULT_DISPATCH_OSCILLATION_THRESHOLD = 5;
const DEFAULT_DISPATCH_OSCILLATION_WINDOW_MS = 60_000;

function isCoordinationSafeScopeEntry(entry: string): boolean {
  const normalized = normalizeOverlapPath(entry).toLowerCase();
  if (!normalized) return false;
  if (COORDINATION_SAFE_SCOPE_EXACT.has(normalized)) return true;
  return COORDINATION_SAFE_SCOPE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isCoordinationSafeScope(scope: string[]): boolean {
  return scope.length === 0 || scope.every((entry) => isCoordinationSafeScopeEntry(entry));
}

function readBooleanMetadataValue(task: Task, key: string): boolean | undefined {
  const metadata = task.sourceMetadata as Record<string, unknown> | undefined;
  const value = metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
}

export function isCoordinationOnlyTask(task: Task, scope: string[]): boolean {
  const explicitNoCommitSignal = task.noCommitsExpected
    ?? readBooleanMetadataValue(task, "noCommitsExpected")
    ?? readBooleanMetadataValue(task, "decisionOnly");
  if (explicitNoCommitSignal !== true) {
    return false;
  }

  return isCoordinationSafeScope(scope);
}

function isLegacyDependencySatisfied(dep: Task | undefined): boolean {
  return !!dep && (dep.column === "done" || dep.column === "in-review" || dep.column === "archived");
}

function isMarkerDependencySatisfied(dep: Task | undefined, markerAccepted: boolean): boolean {
  if (!dep) return false;
  if (dep.column === "done" || dep.column === "archived") return true;
  return markerAccepted;
}

export function computeShadowLeaseParityState(mergeRequestState: string | null): {
  shadowExecutorLeaseApplied: boolean;
  shadowMergeLockApplied: boolean;
  shadowLeaseApplied: boolean;
} {
  const shadowExecutorLeaseApplied = false;
  const shadowMergeLockApplied = mergeRequestState !== null
    && mergeRequestState !== "succeeded"
    && mergeRequestState !== "cancelled"
    && mergeRequestState !== "exhausted"
    && mergeRequestState !== "manual-required";
  return {
    shadowExecutorLeaseApplied,
    shadowMergeLockApplied,
    shadowLeaseApplied: shadowExecutorLeaseApplied || shadowMergeLockApplied,
  };
}

export interface SchedulingDependencyParityDiff {
  taskId: string;
  dependencyId: string;
  legacySatisfied: boolean;
  markerSatisfied: boolean;
}

export function getUnmetSchedulingDependencies(
  task: Task,
  tasks: Task[],
  options?: {
    markerAcceptedByTaskId?: Map<string, boolean>;
    onParityDiff?: (diff: SchedulingDependencyParityDiff) => void;
  },
): string[] {
  return task.dependencies.filter((depId) => {
    const dep = tasks.find((candidate) => candidate.id === depId);
    if (!dep) return false;
    const legacySatisfied = isLegacyDependencySatisfied(dep);
    const markerSatisfied = isMarkerDependencySatisfied(dep, options?.markerAcceptedByTaskId?.get(depId) === true);
    if (options?.onParityDiff && legacySatisfied !== markerSatisfied) {
      options.onParityDiff({
        taskId: task.id,
        dependencyId: depId,
        legacySatisfied,
        markerSatisfied,
      });
    }
    return !legacySatisfied;
  });
}

export function isRunnableQueuedOverlapCandidate(
  task: Task,
  tasks: Task[],
  now = Date.now(),
  activeScopes?: Map<string, string[]>,
  scope: string[] = [],
): boolean {
  if (task.column !== "todo" || task.status !== "queued") return false;
  if (task.paused || task.userPaused) return false;
  if (task.nextRecoveryAt && new Date(task.nextRecoveryAt).getTime() > now) return false;
  if (getUnmetSchedulingDependencies(task, tasks).length > 0) return false;
  if (!activeScopes || activeScopes.size === 0) return true;

  if (scope.length === 0) return true;
  for (const activeScope of activeScopes.values()) {
    if (!activeScope.length) continue;
    if (pathsOverlap(scope, activeScope)) return false;
  }
  return true;
}

export function shouldHoldActiveFileScopeLease(
  task: Task,
  tasks: Task[],
  options?: {
    mergeRequestContractShadowEnabled?: boolean;
    handoffAccepted?: boolean;
    schedulingDependencyOptions?: Parameters<typeof getUnmetSchedulingDependencies>[2];
  },
): boolean {
  /*
  FNXC:OverlapScheduling 2026-06-25-04:34:
  Active file-scope leases are a scheduler contract, not just a column check. Self-healing and repair paths must use this same predicate so stale `overlapBlockedBy` cleanup does not preserve blockers the scheduler would ignore on the next tick.
  */
  if (task.paused || task.userPaused) return false;
  if (task.column === "in-progress") {
    return getUnmetSchedulingDependencies(task, tasks, options?.schedulingDependencyOptions).length === 0;
  }
  if (task.column !== "in-review") return false;
  if (!task.worktree || task.status === "failed") return false;
  if (options?.mergeRequestContractShadowEnabled === true && options.handoffAccepted === true) return false;
  return true;
}

export function findHigherPriorityQueuedOverlap(
  candidate: QueuedOverlapCandidate,
  queuedScopes: QueuedOverlapCandidate[],
  overlap: (a: string[], b: string[]) => boolean,
): QueuedOverlapCandidate | null {
  let higher: QueuedOverlapCandidate | null = null;

  for (const queued of queuedScopes) {
    if (queued.id === candidate.id) continue;
    if (!queued.scope.length || !candidate.scope.length) continue;
    if (!overlap(candidate.scope, queued.scope)) continue;

    if (compareTasksByPriorityThenAgeAndId(queued, candidate) < 0) {
      if (!higher || compareTasksByPriorityThenAgeAndId(queued, higher) < 0) {
        higher = queued;
      }
    }
  }

  return higher;
}

type ConcurrencyGateName = "maxConcurrent" | "maxWorktrees" | "semaphore";

interface ConcurrencyGateSnapshot {
  used: number;
  limit: number;
  slack: number;
}

/**
 * U6 (KTD-10): a per-(workflow, column) capacity gate, the generalization of the
 * three legacy gates to workflow-defined WIP columns. Additive — the three-gate
 * report shape (maxConcurrent/maxWorktrees/semaphore) is preserved verbatim; this
 * is an optional extra field populated only when the workflowColumns flag is ON.
 */
interface PerColumnCapacityGate {
  workflowId: string;
  columnId: string;
  used: number;
  limit: number;
  slack: number;
}

interface ConcurrencyGateDiagnostic {
  available: number;
  bindingGates: ConcurrencyGateName[];
  maxConcurrentGate: ConcurrencyGateSnapshot;
  maxWorktreesGate: ConcurrencyGateSnapshot;
  semaphoreGate?: ConcurrencyGateSnapshot;
  holders: {
    maxConcurrent: string[];
    maxWorktrees: string[];
    semaphore?: string[];
  };
  /** U6: additive per-column capacity gates (flag-ON only; omitted otherwise so
   *  the legacy three-gate report shape is byte-identical when the flag is OFF). */
  perColumnGates?: PerColumnCapacityGate[];
}

function recoverIdleSemaphoreLeak(
  semaphore: AgentSemaphore | undefined,
  tasks: Task[],
  source: string,
  candidateSinceMs: number | null,
): number | null {
  const result = recoverIdleSemaphoreLeakCandidate({
    semaphore,
    tasks,
    candidateSinceMs,
  });
  if (result.reconciliation?.changed) {
    schedulerLog.warn(
      `${source}: recovered stale semaphore active count ${result.reconciliation.before} -> ${result.reconciliation.after} ` +
      "(no persisted in-progress/planning/review agent work)",
    );
  }
  return result.candidateSinceMs;
}

function computeConcurrencyGateDiagnostic(params: {
  agentSlots: number;
  maxConcurrent: number;
  activeWorktrees: number;
  maxWorktrees: number;
  semaphore?: AgentSemaphore;
  inProgressTaskIds: string[];
  startedThisTick?: number;
  /** U6: additive per-column capacity gates (flag-ON only). Omitted → the legacy
   *  three-gate report is byte-identical. */
  perColumnGates?: PerColumnCapacityGate[];
}): ConcurrencyGateDiagnostic {
  const startedThisTick = Math.max(0, Math.floor(params.startedThisTick ?? 0));
  const maxConcurrentUsed = params.agentSlots + startedThisTick;
  const maxWorktreesUsed = params.activeWorktrees + startedThisTick;
  const maxConcurrentGate: ConcurrencyGateSnapshot = {
    used: maxConcurrentUsed,
    limit: params.maxConcurrent,
    slack: params.maxConcurrent - maxConcurrentUsed,
  };
  const maxWorktreesGate: ConcurrencyGateSnapshot = {
    used: maxWorktreesUsed,
    limit: params.maxWorktrees,
    slack: params.maxWorktrees - maxWorktreesUsed,
  };
  const semaphoreGate = params.semaphore
    ? (() => {
      const used = Math.max(0, params.semaphore.activeCount, params.agentSlots) + startedThisTick;
      return {
        used,
        limit: params.semaphore.limit,
        slack: params.semaphore.limit - used,
      };
    })()
    : undefined;
  const available = Math.min(
    maxConcurrentGate.slack,
    maxWorktreesGate.slack,
    semaphoreGate?.slack ?? Infinity,
  );

  const bindingGates: ConcurrencyGateName[] = [];
  if (maxConcurrentGate.used >= maxConcurrentGate.limit) bindingGates.push("maxConcurrent");
  if (maxWorktreesGate.used >= maxWorktreesGate.limit) bindingGates.push("maxWorktrees");
  if (semaphoreGate && semaphoreGate.used >= semaphoreGate.limit) bindingGates.push("semaphore");

  return {
    available,
    bindingGates,
    maxConcurrentGate,
    maxWorktreesGate,
    semaphoreGate,
    holders: {
      maxConcurrent: [...params.inProgressTaskIds],
      maxWorktrees: [...params.inProgressTaskIds],
      semaphore: semaphoreGate ? [...params.inProgressTaskIds] : undefined,
    },
    // U6: additive only — present when flag-ON, omitted otherwise.
    ...(params.perColumnGates ? { perColumnGates: params.perColumnGates } : {}),
  };
}

function formatConcurrencyLimitReason(diagnostic: ConcurrencyGateDiagnostic): string {
  const holdersText = (gate: ConcurrencyGateName): string => {
    const holders = diagnostic.holders[gate];
    return holders && holders.length > 0 ? holders.join(", ") : "none";
  };
  const gateLabel = diagnostic.bindingGates.join(", ");
  const details = [
    `maxConcurrent used=${diagnostic.maxConcurrentGate.used}/${diagnostic.maxConcurrentGate.limit} (holders: ${holdersText("maxConcurrent")})`,
    `maxWorktrees used=${diagnostic.maxWorktreesGate.used}/${diagnostic.maxWorktreesGate.limit} (holders: ${holdersText("maxWorktrees")})`,
  ];
  if (diagnostic.semaphoreGate) {
    const semaphoreUsed = Math.max(0, diagnostic.semaphoreGate.used);
    details.push(
      `semaphore used=${semaphoreUsed}/${diagnostic.semaphoreGate.limit} (holders: ${holdersText("semaphore")}; note: semaphore slots may include triage/merge agents outside in-progress)`,
    );
  }
  return `queued — concurrency limit reached: gate=${gateLabel}; ${details.join("; ")}`;
}

export function formatConcurrencyLimitMemoKey(diagnostic: ConcurrencyGateDiagnostic): string {
  const gates = diagnostic.bindingGates.join(",");
  return `queued-concurrency:${gates || "none"}`;
}

export interface SchedulerOptions {
  /** Max concurrent in-progress tasks. Default: 2 */
  maxConcurrent?: number;
  /** Max worktrees for active (in-progress) tasks. Default: 4 */
  maxWorktrees?: number;
  /** Milliseconds between scheduling polls. Default: 15000 */
  pollIntervalMs?: number;
  /**
   * Shared concurrency semaphore. When provided, the scheduler uses
   * `semaphore.availableCount` to avoid scheduling more tasks than the
   * global concurrency limit allows (accounting for triage and merge
   * agents that also hold slots).
   */
  semaphore?: AgentSemaphore;
  /** Optional AgentStore for durable-agent state rollback during overlap requeue. */
  agentStore?: AgentStore;
  /** Optional live executor signal that preserves parked durable-agent links while work is truly active. */
  hasActiveAgentExecution?: (agentId: string) => boolean;
  /** Called when scheduler starts a task */
  onSchedule?: (task: Task) => void;
  /** Called when a task is blocked by deps */
  onBlocked?: (task: Task, blockedBy: string[]) => void;
  /** Called when a mission-linked task fails and is queued for retry handling. */
  onTaskFailed?: (taskId: string) => void | Promise<void>;
  /** Optional PR monitor for tracking in-review PRs */
  prMonitor?: PrMonitor;
  /** Optional MissionStore for slice activation and auto-advance */
  missionStore?: MissionStore;
  /** Optional lease manager used to recover stale checkout leases before scheduling. */
  leaseManager?: MeshLeaseManager;
  /** Optional MissionAutopilot for autonomous mission progression */
  missionAutopilot?: import("./mission-autopilot.js").MissionAutopilot;
  /**
   * Called when a task with a closed/merged PR moves out of in-review
   * and the PrMonitor has buffered actionable comments.
   * The callback receives the task ID, PR info, and the drained comments.
   * If no comments were buffered, this callback is NOT invoked.
   */
  onClosedPrFeedback?: (
    taskId: string,
    prInfo: PrInfo,
    comments: PrComment[]
  ) => void | Promise<void>;
  /** Optional MissionExecutionLoop for validation cycle handling */
  missionExecutionLoop?: import("./mission-execution-loop.js").MissionExecutionLoop;
  /** Optional NodeHealthMonitor for node health checks during dispatch.
   *  Reserved for FN-2722-C (unavailable node policy enforcement).
   *  Accepted here so the option can be wired at construction time. */
  nodeHealthMonitor?: import("./node-health-monitor.js").NodeHealthMonitor;
  /** Optional dispatch validator used to block dispatch on configuration issues before health policy checks. */
  validateNodeDispatch?: (nodeId: string) => Promise<NodeDispatchValidationResult>;
  /** Local node identifier used to distinguish self-owned leases from foreign-owned leases. Default: "local". */
  localNodeId?: string;
  /** Optional shared auto-claim snapshot manager for invalidation on task mutations. */
  snapshotManager?: AutoClaimSnapshotManager;
}

/**
 * Scheduler watches the "todo" column and moves tasks to "in-progress"
 * when their dependencies are satisfied and concurrency allows.
 *
 * It respects:
 * - Dependency ordering (tasks depending on others wait)
 * - Concurrency limits (max N tasks in-progress at once)
 *
 * **Dynamic settings reload:** On every `schedule()` call the scheduler
 * reads `maxConcurrent`, `maxWorktrees`, and `pollIntervalMs` from the
 * persisted store settings (`store.getSettings()`).  This means changes
 * made via the dashboard Settings modal (`PUT /settings`) take effect on
 * the very next poll cycle without an engine restart.  The poll interval
 * itself is also refreshed: if `pollIntervalMs` differs from the active
 * timer, the `setInterval` is transparently restarted.
 */
export class Scheduler {
  private running = false;
  private scheduling = false;
  private wasWorktreeLimited = false;
  private wasGlobalPaused = false;
  private wasEnginePaused = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  /** The interval (ms) of the currently active `setInterval` timer. */
  private activePollMs: number | null = null;
  /** Tracks which task IDs are currently paused, to detect unpause transitions. */
  private pausedTaskIds = new Set<string>();
  /** Tracks mission-linked tasks observed with status=failed before moveTask clears status/error. */
  private failedTaskIds = new Set<string>();
  /** Tracks tasks blocked by unavailable-node policy to deduplicate block log entries. */
  private wasNodeBlocked = new Set<string>();
  /** Tracks tasks blocked by missing project-node mapping to deduplicate block log entries. */
  private wasNodeDispatchValidationBlocked = new Set<string>();
  /** Tracks tasks queued due to missing permanent executors when ephemeral workers are disabled. */
  private wasPermanentAgentUnavailable = new Set<string>();
  /** Tracks dispatch-queued reason signatures to avoid per-tick log spam. */
  private wasDispatchQueuedReasonLogged = new Set<string>();
  /** Tracks per-task candidacy fingerprints for task:updated auto-claim invalidation gating. */
  private lastAutoClaimFingerprint = new Map<string, string>();
  /** Tracks recent engine-sourced in-progress → todo requeues to prevent immediate re-dispatch races. */
  private recentEngineTodoRequeues = new Map<string, string>();
  private readonly staleTaskReporter: StaleTaskReporter;
  private readonly backlogPressureReporter: BacklogPressureReporter;
  private readonly unlinkedMissionsAdvisoryReporter: UnlinkedMissionsAdvisoryReporter;
  private lastStaleTaskReportAt = 0;
  private lastBacklogPressureReportAt = 0;
  private lastUnlinkedMissionsAdvisoryReportAt = 0;
  private lastHeartbeatWriteMs = 0;
  private idleSemaphoreLeakCandidateSince: number | null = null;
  private readonly lastHighOverlapFanoutWarningKey = new Map<string, string>();

  /**
   * Async listener guard convention:
   * - Any async mission helper invoked from event listeners is wrapped in internal try/catch
   *   (`handleMissionTaskMove` / `handleMissionTaskCompletion`).
   * - Fire-and-forget Promise chains in listeners terminate with `.catch(...)`.
   * Keep this invariant when adding new async EventEmitter callbacks.
   */
  constructor(
    private store: TaskStore,
    private options: SchedulerOptions = {},
  ) {
    this.staleTaskReporter = new StaleTaskReporter({ store: this.store });
    this.backlogPressureReporter = new BacklogPressureReporter({
      store: this.store,
      projectId: this.store.getRootDir(),
      logger: schedulerLog,
    });
    this.unlinkedMissionsAdvisoryReporter = new UnlinkedMissionsAdvisoryReporter({
      store: this.store,
      projectId: this.store.getRootDir(),
      logger: schedulerLog,
    });
    /**
     * Event-driven scheduling: when a task is created, trigger a scheduling
     * pass immediately instead of waiting for the next poll interval.
     * This reduces latency from up to 15 seconds to near-instant.
     */
    this.store.on("task:created", (task) => {
      this.lastAutoClaimFingerprint.set(task.id, computeAutoClaimFingerprint(task));
      this.options.snapshotManager?.invalidate("task:created");
      schedulerLog.log("Task created — triggering scheduling");
      this.schedule();
    });

    /**
     * Immediate unpause resume: when `globalPause` transitions from `true`
     * to `false`, trigger a scheduling pass right away instead of waiting
     * for the next poll interval (up to 15 s). Only reacts to true→false
     * transitions — no-ops on false→false and true→true.
     *
     * The re-entrance guard (`this.scheduling`) inside `schedule()` safely
     * drops the call if a poll-based pass is already in flight.
     */
    this.store.on("settings:updated", ({ settings, previous }) => {
      if (previous.globalPause && !settings.globalPause && this.running) {
        this.schedule();
      }
    });

    /**
     * Immediate soft-unpause resume: when `enginePaused` transitions from
     * `true` to `false`, trigger a scheduling pass right away instead of
     * waiting for the next poll interval. Same pattern as the globalPause
     * unpause handler above.
     */
    this.store.on("settings:updated", ({ settings, previous }) => {
      if (previous.enginePaused && !settings.enginePaused && this.running) {
        this.schedule();
      }
    });

    /**
     * PR Monitoring: Start monitoring when a task moves to "in-review",
     * stop monitoring when it moves out.
     * 
     * Also handles mission auto-advance: when a linked task completes,
     * update feature status and potentially activate next pending slice.
     */
    this.store.on("task:moved", async ({ task, from, to, source }) => {
      this.lastAutoClaimFingerprint.set(task.id, computeAutoClaimFingerprint(task));
      if (from === "todo" || to === "todo") {
        this.options.snapshotManager?.invalidate(`task:moved:${from}->${to}`);
      }
      // PR Monitoring
      if (this.options.prMonitor) {
        if (to === "in-review" && task.prInfo) {
          // Start monitoring existing PR
          const repo = getCurrentRepo(this.store.getRootDir());
          if (repo) {
            this.options.prMonitor.startMonitoring(task.id, repo.owner, repo.repo, task.prInfo);
          }
        } else if (from === "in-review" && to !== "in-review") {
          // If task has a closed/merged PR, drain buffered comments before
          // stopping monitoring (drainComments needs the tracked PR to still exist)
          if (task.prInfo && (task.prInfo.status === "closed" || task.prInfo.status === "merged")) {
            const comments = this.options.prMonitor.drainComments(task.id);
            if (comments.length > 0 && this.options.onClosedPrFeedback) {
              void Promise.resolve(this.options.onClosedPrFeedback(task.id, task.prInfo, comments))
                .then(() => {
                  schedulerLog.log(`Invoked onClosedPrFeedback for ${task.id} with ${comments.length} comment(s)`);
                })
                .catch((err) => {
                  schedulerLog.error(`Error in onClosedPrFeedback for ${task.id}:`, err);
                });
            }
          }

          // Task moved out of in-review, stop monitoring
          this.options.prMonitor.stopMonitoring(task.id);
        }
      }

      // Mission progress tracking. Resolve by linked feature instead of only
      // task.sliceId so older one-way-linked mission tasks are kept in sync too.
      if (this.options.missionStore) {
        void this.handleMissionTaskMove(task.id, to);
      }

      // Mission failure tracking: status/error are cleared during moveTask(in-progress → todo),
      // so we pair this with failedTaskIds captured from task:updated events.
      if (task.sliceId && to === "todo" && this.options.onTaskFailed) {
        if (task.status === "failed" || this.failedTaskIds.has(task.id)) {
          this.failedTaskIds.delete(task.id);
          void Promise.resolve(this.options.onTaskFailed(task.id)).catch((err) => {
            schedulerLog.error(`Error in onTaskFailed for ${task.id}:`, err);
          });
        }
      }

      // FN-3895/FN-3924: complement periodic stale-blockedBy self-healing with immediate
      // blocker reconciliation when a potential blocker reaches a terminal completion column.
      // Invariant: blockedBy must reference a *current* unresolved blocker, else be null.
      if (to === "done" || to === "archived") {
        try {
          const settings = await this.store.getSettings();
          if (!settings.globalPause && !settings.enginePaused) {
            const todoTasks = await this.store.listTasks({ column: "todo", slim: true });
            const allTasks = await this.store.listTasks({ slim: true, includeArchived: true });
            for (const dependent of todoTasks) {
              const mentionsCompletedTask = dependent.dependencies.includes(task.id);
              const currentlyBlockedByCompletedTask = dependent.blockedBy === task.id;
              if (!mentionsCompletedTask && !currentlyBlockedByCompletedTask) continue;

              const markerAcceptedByTaskId = settings.mergeRequestContractShadowEnabled === true
                ? new Map(await Promise.all(dependent.dependencies.map(async (depId) => [depId, (await this.store.getCompletionHandoffAcceptedMarker(depId)) !== null] as const)))
                : undefined;
              const unresolvedDeps = getUnmetSchedulingDependencies(
                dependent,
                [dependent, ...allTasks],
                markerAcceptedByTaskId
                  ? {
                    markerAcceptedByTaskId,
                    onParityDiff: (diff) => {
                      this.emitDependencyParityDiff(diff);
                    },
                  }
                  : undefined,
              );

              try {
                if (unresolvedDeps.length > 0) {
                  await this.store.updateTask(dependent.id, {
                    status: "queued",
                    blockedBy: unresolvedDeps[0],
                  });
                  await this.store.logEntry(
                    dependent.id,
                    `Auto-reblocked: unresolved dependency ${unresolvedDeps[0]} remains after ${task.id} reached ${to}`,
                  );
                } else {
                  await this.store.updateTask(dependent.id, { blockedBy: null, status: null });
                  const unblockMessage = currentlyBlockedByCompletedTask
                    ? `Auto-unblocked: blocker ${task.id} reached ${to}`
                    : `Auto-unblocked: blocker ${task.id} reached ${to} — all dependencies satisfied`;
                  await this.store.logEntry(dependent.id, unblockMessage);
                }
              } catch (error) {
                schedulerLog.error(
                  `Failed to reconcile dependent ${dependent.id} for blocker ${task.id}`,
                  error,
                );
              }
            }
          }
        } catch (error) {
          schedulerLog.error(`Failed event-driven blocker reconciliation for ${task.id}`, error);
        }
      }

      if (from === "in-progress" && to === "todo") {
        if (source === "engine") {
          this.recentEngineTodoRequeues.set(task.id, task.columnMovedAt ?? new Date().toISOString());
        } else {
          this.recentEngineTodoRequeues.delete(task.id);
        }
      } else if (to === "in-review" || to === "done" || to === "archived") {
        this.recentEngineTodoRequeues.delete(task.id);
        if (task.dispatchStormCount != null || task.lastDispatchAt != null) {
          void this.store.updateTask(task.id, {
            dispatchStormCount: null,
            lastDispatchAt: null,
          }).catch((error) => {
            schedulerLog.warn(`Failed to reset dispatch oscillation state for ${task.id} on move to ${to}: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      }

      // Event-driven scheduling: when a task moves to "done" (completion) or "todo" (retry/manual move),
      // trigger scheduling immediately so waiting tasks can start without waiting
      // for the next poll interval (up to 15 seconds).
      if (to === "done" || to === "todo") {
        schedulerLog.log(`Task moved to ${to} — triggering scheduling`);
        this.schedule();
      }
    });

    /**
     * PR Monitoring: Start monitoring when PR is linked to an in-review task.
     * Also detects task-level unpause transitions and triggers immediate scheduling.
     */
    this.store.on("task:updated", (task) => {
      const nextFingerprint = computeAutoClaimFingerprint(task);
      const previousFingerprint = this.lastAutoClaimFingerprint.get(task.id);
      if (!previousFingerprint || previousFingerprint !== nextFingerprint) {
        this.lastAutoClaimFingerprint.set(task.id, nextFingerprint);
        this.options.snapshotManager?.invalidate("task:updated");
      }
      // Track mission failure signals before moveTask clears failure metadata.
      if (task.sliceId && task.column === "in-progress" && task.status === "failed") {
        this.failedTaskIds.add(task.id);
      } else if (task.status !== "failed") {
        this.failedTaskIds.delete(task.id);
      }

      // Track pause state transitions for event-driven scheduling on unpause.
      // When a previously-paused task is unpaused in a schedulable column,
      // trigger a scheduling pass immediately instead of waiting for the next
      // poll interval (up to 15 seconds).
      if (task.paused) {
        this.pausedTaskIds.add(task.id);
      } else if (this.pausedTaskIds.has(task.id)) {
        // Task was paused, now unpaused — trigger scheduling
        this.pausedTaskIds.delete(task.id);
        if (task.userPaused === false && (task.dispatchStormCount != null || task.lastDispatchAt != null)) {
          void this.store.updateTask(task.id, {
            dispatchStormCount: null,
            lastDispatchAt: null,
          }).catch((error) => {
            schedulerLog.warn(`Failed to reset dispatch oscillation state for ${task.id} on unpause: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        if (this.running && (task.column === "todo" || task.column === "triage")) {
          schedulerLog.log(`Task ${task.id} unpaused — triggering scheduling`);
          this.schedule();
        }
      }

      if (!this.options.prMonitor) return;
      if (task.column !== "in-review") return;
      if (!task.prInfo) return;

      // Check if we're already monitoring this task
      const tracked = this.options.prMonitor.getTrackedPrs();
      if (tracked.has(task.id)) {
        this.options.prMonitor.updatePrInfo(task.id, task.prInfo);
        return;
      }

      const repo = getCurrentRepo(this.store.getRootDir());
      if (repo) {
        this.options.prMonitor.startMonitoring(task.id, repo.owner, repo.repo, task.prInfo);
      }
    });

    this.store.on("task:deleted", (task) => {
      this.lastAutoClaimFingerprint.delete(task.id);
      this.options.snapshotManager?.invalidate("task:deleted");
      this.pausedTaskIds.delete(task.id);
      this.failedTaskIds.delete(task.id);
      this.recentEngineTodoRequeues.delete(task.id);
      this.wasNodeDispatchValidationBlocked.delete(task.id);
      this.wasNodeBlocked.delete(task.id);
      this.wasPermanentAgentUnavailable.delete(task.id);
      this.clearDispatchQueuedReasonMemo(task.id);

      void (async () => {
        try {
          const settings = await this.store.getSettings();
          if (settings.globalPause || settings.enginePaused) {
            return;
          }

          const todoTasks = await this.store.listTasks({ column: "todo", slim: true });
          const inProgressTasks = await this.store.listTasks({ column: "in-progress", slim: true });
          const dependents = [...todoTasks, ...inProgressTasks];
          const allTasks = await this.store.listTasks({ slim: true, includeArchived: true });

          for (const dependent of dependents) {
            const mentionsDeletedTask = dependent.dependencies.includes(task.id);
            const currentlyBlockedByDeletedTask = dependent.blockedBy === task.id;
            if (!mentionsDeletedTask && !currentlyBlockedByDeletedTask) continue;

            const markerAcceptedByTaskId = settings.mergeRequestContractShadowEnabled === true
              ? new Map(await Promise.all(dependent.dependencies.map(async (depId) => [depId, (await this.store.getCompletionHandoffAcceptedMarker(depId)) !== null] as const)))
              : undefined;
            const unresolvedDeps = getUnmetSchedulingDependencies(
              dependent,
              [dependent, ...allTasks],
              markerAcceptedByTaskId
                ? {
                  markerAcceptedByTaskId,
                  onParityDiff: (diff) => {
                    this.emitDependencyParityDiff(diff);
                  },
                }
                : undefined,
            );

            try {
              if (unresolvedDeps.length > 0) {
                const nextBlocker = unresolvedDeps[0]!;
                await this.store.updateTask(dependent.id, {
                  blockedBy: nextBlocker,
                  status: "queued",
                });
                await this.store.logEntry(
                  dependent.id,
                  `Auto-reblocked (FN-5496): unresolved dependency ${nextBlocker} remains after blocker ${task.id} was soft-deleted`,
                );
              } else if (dependent.column === "todo") {
                await this.store.updateTask(dependent.id, { blockedBy: null, status: null });
                await this.store.logEntry(dependent.id, `Auto-unblocked (FN-5496): blocker ${task.id} was soft-deleted`);
              } else {
                await this.store.updateTask(dependent.id, { blockedBy: null });
                await this.store.logEntry(dependent.id, `Auto-unblocked (FN-5496): blocker ${task.id} was soft-deleted`);
              }
            } catch (error) {
              schedulerLog.error(`Failed to reconcile dependent ${dependent.id} for soft-deleted blocker ${task.id}`, error);
            }
          }

          this.schedule();
        } catch (error) {
          schedulerLog.error(`Failed event-driven soft-delete blocker reconciliation for ${task.id}`, error);
        }
      })();
    });
  }

  /**
   * Validate that a task's filesystem state is intact.
   * Checks that the task directory exists and PROMPT.md is present and non-empty.
   * 
   * @param id - The task ID to validate
   * @returns Object with `valid: true` if checks pass, or `valid: false` with a `reason` string if they fail
   */
  private async validateTaskFilesystem(id: string): Promise<{ valid: boolean; reason?: string }> {
    if (typeof this.store.getTasksDir !== "function") {
      /*
      FNXC:WorkflowScheduling 2026-06-23-11:38:
      Scheduler test fakes and older embedded stores may not expose task-directory helpers. The production TaskStore still enforces task-dir and PROMPT.md validation, but minimal stores should not abort the workflow sweep before lease recovery and node-routing guards run.
      */
      return { valid: true };
    }
    const taskDir = join(this.store.getTasksDir(), id);
    
    // Check if task directory exists
    if (!existsSync(taskDir)) {
      return { valid: false, reason: "missing directory" };
    }
    
    // Check if PROMPT.md exists and has non-empty content
    const promptPath = join(taskDir, "PROMPT.md");
    if (!existsSync(promptPath)) {
      return { valid: false, reason: "missing or empty PROMPT.md" };
    }
    
    try {
      const content = await readFile(promptPath, "utf-8");
      if (!content || content.trim().length === 0) {
        return { valid: false, reason: "missing or empty PROMPT.md" };
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      schedulerLog.warn(`PROMPT.md read failed for task dispatch validation (${id}): ${errorMessage}`);
      return { valid: false, reason: "missing or empty PROMPT.md" };
    }
    
    return { valid: true };
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const interval = this.options.pollIntervalMs ?? 15_000;
    this.activePollMs = interval;
    this.pollInterval = setInterval(() => this.schedule(), interval);
    this.schedule();
    schedulerLog.log(`Started (poll interval: ${interval}ms)`);

    // Wire up MissionAutopilot: set scheduler reference for lazy injection
    // and start watching all missions with autopilotEnabled: true
    if (this.options.missionAutopilot && this.options.missionStore) {
      this.options.missionAutopilot.setScheduler(this);
      const missions = this.options.missionStore.listMissions();
      for (const mission of missions) {
        if (mission.autopilotEnabled && mission.status !== "complete" && mission.status !== "archived") {
          this.options.missionAutopilot.watchMission(mission.id);
        }
      }
      this.options.missionAutopilot.start();
    }
  }

  stop(): void {
    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      this.activePollMs = null;
    }
    // Stop all PR monitoring when scheduler shuts down
    if (this.options.prMonitor) {
      this.options.prMonitor.stopAll();
    }
    // Stop MissionAutopilot when scheduler shuts down
    if (this.options.missionAutopilot) {
      this.options.missionAutopilot.stop();
    }
    this.failedTaskIds.clear();
    this.wasNodeBlocked.clear();
    this.wasNodeDispatchValidationBlocked.clear();
    this.wasPermanentAgentUnavailable.clear();
    this.wasDispatchQueuedReasonLogged.clear();
    schedulerLog.log("Stopped");
  }

  private clearDispatchQueuedReasonMemo(taskId: string): void {
    for (const key of this.wasDispatchQueuedReasonLogged) {
      if (key.startsWith(`${taskId}:`)) {
        this.wasDispatchQueuedReasonLogged.delete(key);
      }
    }
  }

  private async logDispatchQueuedReason(taskId: string, reason: string, memoKey?: string): Promise<boolean> {
    const key = `${taskId}:${memoKey ?? reason}`;
    if (this.wasDispatchQueuedReasonLogged.has(key)) {
      return false;
    }

    this.clearDispatchQueuedReasonMemo(taskId);
    this.wasDispatchQueuedReasonLogged.add(key);
    await this.store.logEntry(taskId, reason);
    return true;
  }

  private emitDependencyParityDiff(diff: SchedulingDependencyParityDiff): void {
    void this.store.recordRunAuditEvent?.({
      taskId: diff.taskId,
      agentId: "scheduler",
      runId: generateSyntheticRunId("scheduler", diff.taskId),
      domain: "database",
      mutationType: "merge:dependency-parity-diff",
      target: diff.dependencyId,
      metadata: {
        depId: diff.dependencyId,
        legacyResult: diff.legacySatisfied,
        markerResult: diff.markerSatisfied,
      },
    });
  }

  private async emitNodeUnreachableRecoveryAudit(
    task: Task,
    metadata: {
      ownerNodeId: string;
      // Includes FN-4832 online-owner parking (`owner_recovered`) in dispatch handoff audits.
      ownerNodeHealth: "offline" | "error" | "online";
      handoffAction: "park" | "reassign-local" | "reassign-any";
      handoffReason: string;
      decisionPath: "scheduler-handoff-park" | "scheduler-handoff-reassign-local" | "scheduler-handoff-reassign-any";
      newColumn: string;
      dispatchNodeBefore?: string;
      dispatchNodeAfter?: string;
    },
  ): Promise<void> {
    const auditor = createRunAuditor(this.store, {
      runId: generateSyntheticRunId("scheduler", task.id),
      agentId: "scheduler",
      taskId: task.id,
      taskLineageId: task.lineageId,
      phase: "dispatch-owning-node-handoff",
    });

    try {
      await auditor.database({
        type: "task:auto-recover-node-unreachable",
        target: task.id,
        metadata: {
          previousColumn: task.column,
          ...metadata,
        },
      });
    } catch (error) {
      schedulerLog.warn(
        `Task ${task.id} failed to emit node-unreachable auto-recovery audit: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async emitHighOverlapFanoutWarnings(tasks: Task[]): Promise<void> {
    const fanoutMap = computeBlockerFanoutMap(tasks, 3);
    const seenBlockers = new Set<string>();

    for (const [blockerId, fanout] of fanoutMap) {
      if (fanout.overlapBlockedTodoCount < HIGH_FANOUT_BLOCKER_TODO_THRESHOLD) continue;
      const state = fanout.escalation ? "long-lived" : "temporary";
      const dedupeKey = `${fanout.overlapBlockedTodoCount}:${state}`;
      seenBlockers.add(blockerId);

      if (this.lastHighOverlapFanoutWarningKey.get(blockerId) === dedupeKey) {
        continue;
      }

      const message = `Overlap bottleneck: ${blockerId} is currently blocking ${fanout.overlapBlockedTodoCount} todo task(s) via blockedBy (${state}).`;
      schedulerLog.warn(message);
      await this.store.logEntry(blockerId, message);
      this.lastHighOverlapFanoutWarningKey.set(blockerId, dedupeKey);
    }

    for (const blockerId of this.lastHighOverlapFanoutWarningKey.keys()) {
      if (!seenBlockers.has(blockerId)) {
        this.lastHighOverlapFanoutWarningKey.delete(blockerId);
      }
    }
  }

  private async rollbackRunningAgentsForQueuedTodoTask(taskId: string): Promise<void> {
    const agentStore = this.options.agentStore;
    if (!agentStore) return;

    const runningAgents = await agentStore.listAgents({ state: "running", includeEphemeral: false });
    const linkedAgents = runningAgents.filter((agent) => agent.taskId === taskId);

    for (const agent of linkedAgents) {
      const activeRun = await agentStore.getActiveHeartbeatRun?.(agent.id);
      const proof = evaluateParkedAgentTaskLink({
        agent,
        linkedTask: { column: "todo" } as Pick<Task, "column">,
        activeRun,
        hasActiveAgentExecution: this.options.hasActiveAgentExecution,
      });
      if (proof.shouldPreserveParkedLink) {
        schedulerLog.log(
          `Preserved running agent ${agent.id} for queued ${taskId}; live proof freshRun=${proof.hasFreshRun} activeExecution=${proof.hasActiveExecution}`,
        );
        continue;
      }

      await agentStore.updateAgentState(agent.id, "active");
      await agentStore.syncExecutionTaskLink(agent.id, undefined);
      schedulerLog.log(
        `Cleared stale running agent ${agent.id} after overlap requeue of ${taskId}; file-scope lease remains queued`,
      );
    }
  }

  /**
   * If `newIntervalMs` differs from the currently active timer, restart
   * the `setInterval` so the new cadence takes effect immediately.
   */
  private refreshPollInterval(newIntervalMs?: number): void {
    if (!this.running || !newIntervalMs) return;
    if (newIntervalMs === this.activePollMs) return;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    this.activePollMs = newIntervalMs;
    this.pollInterval = setInterval(() => this.schedule(), newIntervalMs);
    schedulerLog.log(`Poll interval updated to ${newIntervalMs}ms`);
  }

  getMissionAutopilot(): import("./mission-autopilot.js").MissionAutopilot | undefined {
    return this.options.missionAutopilot;
  }

  configurePrMonitoring(options: {
    prMonitor?: PrMonitor;
    onClosedPrFeedback?: SchedulerOptions["onClosedPrFeedback"];
  }): void {
    this.options.prMonitor = options.prMonitor;
    this.options.onClosedPrFeedback = options.onClosedPrFeedback;

    if (!options.prMonitor) {
      return;
    }

    void this.store.listTasks({ slim: true, includeArchived: false, startupMemo: true })
      .then((tasks) => {
        const repo = getCurrentRepo(this.store.getRootDir());
        if (!repo) return;

        for (const task of tasks) {
          if (task.column !== "in-review" || !task.prInfo) continue;
          options.prMonitor!.startMonitoring(task.id, repo.owner, repo.repo, task.prInfo);
        }
      })
      .catch((err) => {
        schedulerLog.error("Failed to hydrate PR monitoring from existing in-review tasks:", err);
      });
  }

  /**
   * Resolve the base branch for a task being started.
   *
   * Checks explicit dependencies and implicit `blockedBy` for an in-review
   * task with an unmerged branch. Returns the git branch name to start from,
   * or `null` if the task should start from HEAD (default).
   *
   * Priority: explicit dep in-review (first with worktree) > blockedBy in-review.
   */
  private resolveBaseBranch(task: Task, allTasks: Task[]): string | null {
    // Check explicit dependencies for in-review tasks with worktrees
    for (const depId of task.dependencies) {
      const dep = allTasks.find((t) => t.id === depId);
      if (dep && dep.column === "in-review" && dep.worktree) {
        return resolveTaskWorkingBranch(dep);
      }
    }

    // Check implicit blockedBy for in-review task with worktree
    if (task.blockedBy) {
      const blocker = allTasks.find((t) => t.id === task.blockedBy);
      if (blocker && blocker.column === "in-review" && blocker.worktree) {
        return resolveTaskWorkingBranch(blocker);
      }
    }

    return null;
  }

  /**
   * Delegates to the module-level {@link pathsOverlap} for testability.
   */
  private pathsOverlap(a: string[], b: string[]): boolean {
    return pathsOverlap(a, b);
  }

  /**
   * Reserve the worktree path a task will use before it enters in-progress.
   * This prevents tasks from appearing active without an assigned worktree.
   */
  private planWorktreePath(
    task: Task,
    naming: string | undefined,
    reservedNames: Set<string>,
    settings: Partial<Settings>,
  ): string {
    return planTaskWorktreePath(task, this.store.getRootDir(), naming, reservedNames, settings);
  }

  /**
   * Run one scheduling pass.
   *
   * Uses a re-entrance guard (`this.scheduling`) to prevent overlapping
   * passes. Because `schedule()` is async but triggered by `setInterval`,
   * a slow pass could still be running when the next interval fires.
   * Without the guard, two passes would snapshot the same task list and
   * both could start tasks whose file scopes overlap — defeating the
   * overlap detection that relies on `inProgressScopes` being accurate.
   */
  async schedule(): Promise<void> {
    if (!this.running) return;
    if (this.scheduling) return;
    this.scheduling = true;

    try {
      let tasks = await this.store.listTasks({ slim: true, includeArchived: false, startupMemo: false });
      let settings = await this.store.getSettings();
      this.idleSemaphoreLeakCandidateSince = recoverIdleSemaphoreLeak(
        this.options.semaphore,
        tasks,
        "scheduler",
        this.idleSemaphoreLeakCandidateSince,
      );

      // Refresh the poll interval if the persisted setting has changed
      this.refreshPollInterval(settings.pollIntervalMs);

      // Global pause (hard stop): halt all scheduling activity
      if (settings.globalPause) {
        if (!this.wasGlobalPaused) {
          schedulerLog.warn("⚠ Global pause active — scheduling halted. To resume: set globalPause to false in settings.");
          this.wasGlobalPaused = true;
        }
        return;
      }
      if (this.wasGlobalPaused) {
        schedulerLog.log("Global pause cleared — scheduling resumed");
      }
      this.wasGlobalPaused = false;

      // Engine paused (soft pause): halt new work dispatch, but let agents finish
      if (settings.enginePaused) {
        if (!this.wasEnginePaused) {
          schedulerLog.warn("⚠ Engine paused — scheduling halted (in-flight agents continue). To resume: set enginePaused to false.");
          this.wasEnginePaused = true;
        }
        return;
      }
      if (this.wasEnginePaused) {
        schedulerLog.log("Engine pause cleared — scheduling resumed");
      }
      this.wasEnginePaused = false;

      const heartbeatIntervalMs = Math.max(1, settings.pollIntervalMs ?? 15_000);
      if (Date.now() - this.lastHeartbeatWriteMs >= heartbeatIntervalMs) {
        /*
        FNXC:TaskTiming 2026-06-25-00:00:
        Persist a throttled engineLastActiveAt heartbeat only while the engine is unpaused so process-down wall-clock can be excluded from in-progress task active time after restart without per-tick DB churn.
        */
        await this.store.updateSettings({ engineLastActiveAt: new Date().toISOString() });
        this.lastHeartbeatWriteMs = Date.now();
      }

      // ── U6: hold/release sweep ─────────────────────────────────────────────
      /*
      FNXC:WorkflowScheduling 2026-06-23-10:32:
      Workflow columns graduated from Experimental and are now the scheduler's only dispatch model. The hold/release sweep owns todo→in-progress pickup, so do not fall through into the legacy pull-from-todo dispatcher after the sweep runs.
      */
      if (shouldRunWorkflowColumnScheduler(settings)) {
        await this.runHoldReleaseSweepPass(tasks, settings);
        tasks = await this.store.listTasks({ slim: true, includeArchived: false, startupMemo: false });
        settings = await this.store.getSettings();
        await this.emitHighOverlapFanoutWarnings(tasks);

        const staleWarningWindows = [settings.staleInProgressWarningMs, settings.staleInReviewWarningMs]
          .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
        const minWarningMs = staleWarningWindows.length > 0 ? Math.min(...staleWarningWindows) : 0;
        if (minWarningMs > 0 && Date.now() - this.lastStaleTaskReportAt >= minWarningMs) {
          try {
            await this.staleTaskReporter.report();
            this.lastStaleTaskReportAt = Date.now();
          } catch (error) {
            schedulerLog.warn("Stale task reporter failed", error);
          }
        }

        if (settings.backlogPressureAlertEnabled !== false && Date.now() - this.lastBacklogPressureReportAt >= 60_000) {
          try {
            await this.backlogPressureReporter.report();
          } catch (error) {
            schedulerLog.warn("Backlog pressure reporter failed", error);
          } finally {
            this.lastBacklogPressureReportAt = Date.now();
          }
        }

        if (Date.now() - this.lastUnlinkedMissionsAdvisoryReportAt >= 60_000) {
          try {
            await this.unlinkedMissionsAdvisoryReporter.report();
          } catch (error) {
            schedulerLog.warn("Unlinked missions advisory reporter failed", error);
          } finally {
            this.lastUnlinkedMissionsAdvisoryReportAt = Date.now();
          }
        }
        return;
      }

      const maxConcurrent = settings.maxConcurrent ?? this.options.maxConcurrent ?? 2;
      const maxWorktrees = settings.maxWorktrees ?? this.options.maxWorktrees ?? 4;

      // Count only in-progress tasks toward the worktree limit.
      // In-review tasks with worktrees are idle (waiting to merge) and
      // should not block new tasks from starting.
      const activeWorktrees = tasks.filter(
        (t) => t.column === "in-progress",
      ).length;

      if (activeWorktrees >= maxWorktrees) {
        if (!this.wasWorktreeLimited) {
          schedulerLog.log(`Worktree limit reached (${activeWorktrees}/${maxWorktrees})`);
          this.wasWorktreeLimited = true;
        }
        return;
      }

      this.wasWorktreeLimited = false;

      const inProgress = tasks.filter((t) => t.column === "in-progress");

      // Execution tasks occupy concurrency slots governed by maxConcurrent.
      // Triage/specification tasks have their own limit (maxTriageConcurrent)
      // and do not count against this slot.
      const agentSlots = inProgress.length;

      // When a semaphore is provided, factor in its available slots so we
      // don't schedule more tasks than the global limit allows.
      const inProgressTaskIds = inProgress.map((task) => task.id);
      const computeDispatchCapacityDiagnostic = (startedThisTick: number): ConcurrencyGateDiagnostic => {
        const started = Math.max(0, Math.floor(startedThisTick));
        // U6 (KTD-10): report the default workflow's in-progress capacity as a
        // per-column gate — the generalization of the legacy maxConcurrent gate
        // (which reads through to the same value).
        const perColumnGates = isWorkflowColumnsEnabled(settings)
          ? [{
            workflowId: DEFAULT_WORKFLOW_POOL_ID,
            columnId: "in-progress",
            used: agentSlots + started,
            limit: maxConcurrent,
            slack: maxConcurrent - (agentSlots + started),
          }]
          : undefined;
        return computeConcurrencyGateDiagnostic({
          agentSlots,
          maxConcurrent,
          activeWorktrees,
          maxWorktrees,
          semaphore: this.options.semaphore,
          inProgressTaskIds,
          startedThisTick: started,
          perColumnGates,
        });
      };
      if (computeDispatchCapacityDiagnostic(0).available <= 0) return;

      const now = Date.now();
      let todo = tasks.filter((t) => {
        if (t.column !== "todo" || t.paused) return false;
        // Skip tasks with a recovery backoff that hasn't elapsed yet
        if (t.nextRecoveryAt && new Date(t.nextRecoveryAt).getTime() > now) return false;
        return true;
      });

      // Filter out tasks belonging to blocked missions
      if (todo.length > 0 && this.options.missionStore) {
        const blockedSliceIds = new Set<string>();
        for (const t of todo) {
          if (t.sliceId && !blockedSliceIds.has(t.sliceId)) {
            try {
              const slice = this.options.missionStore.getSlice(t.sliceId);
              if (slice) {
                const milestone = this.options.missionStore.getMilestone(slice.milestoneId);
                if (milestone) {
                  const mission = this.options.missionStore.getMission(milestone.missionId);
                  if (mission && mission.status === "blocked") {
                    blockedSliceIds.add(t.sliceId);
                  }
                }
              }
            } catch (err: unknown) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              schedulerLog.warn(
                `Mission/slice lookup failed during scheduling (task ${t.id}): ${errorMessage} — proceeding without blocked-slice check`,
              );
              // If lookup fails, don't block the task
            }
          }
        }
        if (blockedSliceIds.size > 0) {
          todo = todo.filter((t) => !t.sliceId || !blockedSliceIds.has(t.sliceId));
        }
      }

      if (todo.length === 0) return;

      const maxAutoMergeRetries =
        typeof settings.maxAutoMergeRetries === "number" ? settings.maxAutoMergeRetries : undefined;
      const unblockWeights = buildUnblockWeightMap(tasks, {
        maxAutoMergeRetries,
      });
      todo = sortTasksByPriorityFanoutThenAgeAndId(todo, unblockWeights);
      const topWeightedTask = todo.find((candidate) => (unblockWeights.get(candidate.id) ?? 0) >= 1);
      if (topWeightedTask) {
        schedulerLog.log(
          `Dispatch ordering: priority+fanout (top: ${topWeightedTask.id}=${unblockWeights.get(topWeightedTask.id) ?? 0})`,
        );
      }

      const mergeShadowEnabled = settings.mergeRequestContractShadowEnabled === true;
      const markerAcceptedByTaskId = new Map<string, boolean>();
      if (mergeShadowEnabled) {
        const dependencyIds = new Set(tasks.flatMap((candidate) => candidate.dependencies));
        for (const depId of dependencyIds) {
          markerAcceptedByTaskId.set(depId, (await this.store.getCompletionHandoffAcceptedMarker(depId)) !== null);
        }
      }
      const schedulingDependencyOptions = mergeShadowEnabled
        ? {
          markerAcceptedByTaskId,
          onParityDiff: (diff: SchedulingDependencyParityDiff) => {
            this.emitDependencyParityDiff(diff);
          },
        }
        : undefined;

      /**
       * Pre-compute file scopes for all currently active tasks (in-progress
       * AND in-review with unmerged worktrees) so that todo tasks are never
       * started when their files overlap with work already underway or
       * awaiting merge.
       *
       * Including in-review tasks prevents a blocked task from starting on
       * main HEAD when the blocker's changes haven't been merged yet.
       *
       * The re-entrance guard on this method ensures that this snapshot
       * stays consistent throughout the pass — without it, a concurrent
       * pass could read stale state and start conflicting tasks.
       *
       * Newly started tasks are appended to this map further below so that
       * subsequent todo tasks in the same pass also see them.
       */
      const activeScopes = new Map<string, string[]>();
      const activeScopeColumns = new Map<string, Task["column"]>();
      const setActiveScopeLease = (taskId: string, scope: string[], column: Task["column"]): void => {
        activeScopes.set(taskId, scope);
        activeScopeColumns.set(taskId, column);
      };
      const queuedHigherPriorityScopes: QueuedOverlapCandidate[] = [];
      const queuedHigherPriorityTaskById = new Map<string, Task>();
      const overlapIgnorePaths = settings.overlapIgnorePaths ?? [];
      const filteredScopeByTaskId = new Map<string, string[]>();
      const getFilteredFileScope = async (taskId: string): Promise<string[]> => {
        const cached = filteredScopeByTaskId.get(taskId);
        if (cached !== undefined) return cached;
        const scope = await this.store.parseFileScopeFromPrompt(taskId);
        const filteredScope = filterPathsByIgnoreList(scope, overlapIgnorePaths, { ignoreHiddenOverlapPaths: settings.ignoreHiddenOverlapPaths });
        filteredScopeByTaskId.set(taskId, filteredScope);
        return filteredScope;
      };
      if (settings.groupOverlappingFiles) {
        // In-progress tasks
        for (const t of inProgress) {
          if (!shouldHoldActiveFileScopeLease(t, tasks, { schedulingDependencyOptions })) continue;
          const filteredScope = await getFilteredFileScope(t.id);
          if (isCoordinationOnlyTask(t, filteredScope)) continue;
          if (filteredScope.length === 0) continue;
          setActiveScopeLease(t.id, filteredScope, "in-progress");
        }
        // Only live in-review tasks with a worktree belong in activeScopes.
        // Paused in-review tasks (e.g., failed-merge tasks awaiting human triage) cannot
        // make progress, so they must not contribute to overlap blockers; including them
        // caused a deadlock pattern where a paused task indefinitely re-stamped
        // `blockedBy` on overlapping todo tasks every scheduler tick. (FN-3867 / FN-3857)
        // Permanently-failed in-review tasks from SelfHealingManager.checkStuckBudget()
        // also keep their worktree, but after the stuck-kill budget is exhausted they
        // will never merge, so superseding re-implementation tasks (for example FN-4177
        // replaced by FN-4198) must not stay queued behind them. (FN-4200)
        // FNXC:PostgresCutover 2026-06-27-09:30:
        // Pre-compute handoff markers before the .filter() because
        // getCompletionHandoffAcceptedMarker is async and cannot be awaited
        // inside a synchronous filter callback. Without this, the Promise
        // object is always !== null, making handoffAccepted incorrectly true.
        const handoffMarkerMap = new Map<string, boolean>();
        if (settings.mergeRequestContractShadowEnabled === true) {
          for (const t of tasks) {
            if (t.column === "in-review") {
              handoffMarkerMap.set(t.id, (await this.store.getCompletionHandoffAcceptedMarker(t.id)) !== null);
            }
          }
        }
        const inReviewWithWorktree = tasks.filter(
          (t) => t.column === "in-review" && shouldHoldActiveFileScopeLease(t, tasks, {
            mergeRequestContractShadowEnabled: settings.mergeRequestContractShadowEnabled,
            handoffAccepted: handoffMarkerMap.get(t.id) ?? false,
            schedulingDependencyOptions,
          }),
        );
        for (const t of inReviewWithWorktree) {
          const filteredScope = await getFilteredFileScope(t.id);
          if (isCoordinationOnlyTask(t, filteredScope)) continue;
          if (filteredScope.length === 0) continue;

          const handoffAccepted = settings.mergeRequestContractShadowEnabled === true
            ? (await this.store.getCompletionHandoffAcceptedMarker(t.id)) !== null
            : false;
          if (!handoffAccepted) {
            setActiveScopeLease(t.id, filteredScope, "in-review");
          }

          if (settings.mergeRequestContractShadowEnabled === true) {
            const mergeRequestRecord = this.store.getMergeRequestRecord(t.id);
            const { shadowExecutorLeaseApplied, shadowMergeLockApplied, shadowLeaseApplied } =
              computeShadowLeaseParityState(mergeRequestRecord?.state ?? null);
            if (shadowLeaseApplied !== !handoffAccepted) {
              void this.store.recordRunAuditEvent?.({
                taskId: t.id,
                agentId: "scheduler",
                runId: generateSyntheticRunId("scheduler", t.id),
                domain: "database",
                mutationType: "merge:lease-parity-diff",
                target: t.id,
                metadata: {
                  taskId: t.id,
                  legacyLeaseColumn: "in-review",
                  legacyLeaseApplied: !handoffAccepted,
                  shadowLeaseApplied,
                  shadowExecutorLeaseApplied,
                  shadowMergeLockApplied,
                  mergeRequestState: mergeRequestRecord?.state ?? null,
                },
              });
            }
          }
        }

        for (const t of todo) {
          const filteredScope = await getFilteredFileScope(t.id);
          if (isCoordinationOnlyTask(t, filteredScope)) continue;
          if (filteredScope.length === 0) continue;
          if (!isRunnableQueuedOverlapCandidate(t, tasks, now, activeScopes, filteredScope)) continue;
          queuedHigherPriorityScopes.push({
            id: t.id,
            priority: t.priority,
            createdAt: t.createdAt,
            scope: filteredScope,
          });
          queuedHigherPriorityTaskById.set(t.id, t);
        }
      }

      // Resolve dependency order among todo tasks
      const ordered = resolveDependencyOrder(todo);
      let started = 0;
      let loggedMissingAgentStoreThisPass = false;

      for (const taskId of ordered) {
        const task = tasks.find((t) => t.id === taskId)!;

        if (task.checkedOutBy && this.options.leaseManager) {
          const recovered = await this.options.leaseManager.recoverAbandonedLease(
            task.id,
            "scheduler detected stale todo lease",
            { preserveProgress: true },
          );
          if (!recovered) {
            await this.options.leaseManager.reconcileLeaseRow(task.id);
            await this.store.updateTask(task.id, { status: "queued" });
            await this.logDispatchQueuedReason(task.id, "queued — checkout lease recovery blocked dispatch");
            continue;
          }
        }

        // Check all deps are satisfied (done, in-review, or archived)
        const unmetDeps = getUnmetSchedulingDependencies(task, tasks, schedulingDependencyOptions);

        if (unmetDeps.length > 0) {
          await this.store.updateTask(task.id, {
            status: "queued",
            blockedBy: unmetDeps[0],
          });
          await this.logDispatchQueuedReason(task.id, `queued — unmet dependencies: ${unmetDeps.join(", ")}`);
          this.options.onBlocked?.(task, unmetDeps);
          continue;
        }

        if (task.userPaused === true) {
          if (task.status !== "queued") {
            await this.store.updateTask(task.id, { status: "queued" });
          }
          await this.logDispatchQueuedReason(task.id, "queued — user paused (manual move to todo)");
          continue;
        }

        // Validate filesystem state before starting (only for tasks with satisfied deps)
        const validation = await this.validateTaskFilesystem(task.id);
        if (!validation.valid) {
          schedulerLog.warn(`Task ${task.id} filesystem validation failed: ${validation.reason}`);
          await this.store.moveTask(task.id, "triage");
          await this.store.logEntry(task.id, "Task moved to triage — filesystem validation failed", validation.reason);
          continue;
        }

        // Stale spec enforcement: check if PROMPT.md has aged beyond the configured threshold.
        // When enabled, stale tasks are moved back to triage with status "needs-replan"
        // so they receive fresh specification before execution. This guard runs after
        // filesystem validation so missing/unreadable files skip staleness checks entirely.
        const promptPath = getPromptPath(this.store.getTasksDir(), task.id);
        const staleness = await evaluateSpecStaleness({ settings, promptPath, task });
        if (staleness.isStale) {
          schedulerLog.warn(`Task ${task.id} specification is stale — ${staleness.reason}`);
          await this.store.moveTask(task.id, "triage");
          await this.store.updateTask(task.id, { status: "needs-replan" });
          await this.store.logEntry(task.id, staleness.reason);
          continue;
        }
        // If staleness evaluation was skipped (missing/unreadable file), continue to
        // existing scheduler logic which handles filesystem validation separately.

        // Check file scope overlap when enabled
        if (settings.groupOverlappingFiles) {
          const taskScope = await getFilteredFileScope(task.id);
          const coordinationOnlyTask = isCoordinationOnlyTask(task, taskScope);
          if (taskScope.length > 0 && !coordinationOnlyTask) {
            const activeScopeEntries = Array.from(activeScopes.entries()).sort(([aId], [bId]) => aId.localeCompare(bId));
            const overlapBlockerId = task.overlapBlockedBy || task.blockedBy;
            const currentBlockerScope = overlapBlockerId ? activeScopes.get(overlapBlockerId) : undefined;
            const hasValidCurrentBlocker =
              Boolean(overlapBlockerId)
              && Boolean(currentBlockerScope)
              && this.pathsOverlap(taskScope, currentBlockerScope!);

            /**
             * blockedBy stamping invariants:
             * - sticky when still valid: preserve an existing active overlapping blocker
             * - deterministic when changing: pick the first overlapping active task by sorted taskId
             * - idempotent writes only: update DB only when blockedBy/status must change
             */
            const overlappingTaskId = hasValidCurrentBlocker
              ? overlapBlockerId
              : activeScopeEntries.find(([, ipScope]) => this.pathsOverlap(taskScope, ipScope))?.[0] ?? null;

            const runnableQueuedHigherPriorityScopes = queuedHigherPriorityScopes.filter((queuedCandidate) => {
              const queuedTask = queuedHigherPriorityTaskById.get(queuedCandidate.id);
              if (!queuedTask) return false;
              return isRunnableQueuedOverlapCandidate(queuedTask, tasks, now, activeScopes, queuedCandidate.scope);
            });

            const higherPriorityQueuedOverlap = findHigherPriorityQueuedOverlap(
              {
                id: task.id,
                priority: task.priority,
                createdAt: task.createdAt,
                scope: taskScope,
              },
              runnableQueuedHigherPriorityScopes,
              this.pathsOverlap.bind(this),
            );

            if (higherPriorityQueuedOverlap) {
              const dependencyBlocker = unmetDeps[0] ?? null;
              if (
                task.status !== "queued"
                || task.blockedBy !== dependencyBlocker
                || task.overlapBlockedBy !== higherPriorityQueuedOverlap.id
              ) {
                await this.store.updateTask(task.id, {
                  status: "queued",
                  blockedBy: dependencyBlocker,
                  overlapBlockedBy: higherPriorityQueuedOverlap.id,
                });
              }
              await this.rollbackRunningAgentsForQueuedTodoTask(task.id);
              await this.logDispatchQueuedReason(
                task.id,
                `queued — deferred for higher-priority runnable queued task ${higherPriorityQueuedOverlap.id} (overlap)`,
              );
              continue;
            }

            if (overlappingTaskId) {
              const dependencyBlocker = unmetDeps[0] ?? null;
              if (
                task.status !== "queued"
                || task.blockedBy !== dependencyBlocker
                || task.overlapBlockedBy !== overlappingTaskId
              ) {
                await this.store.updateTask(task.id, {
                  status: "queued",
                  blockedBy: dependencyBlocker,
                  overlapBlockedBy: overlappingTaskId,
                });
              }

              const overlapBlockerTask = tasks.find((candidate) => candidate.id === overlappingTaskId);
              await this.rollbackRunningAgentsForQueuedTodoTask(task.id);
              const activeLeaseColumn = activeScopeColumns.get(overlappingTaskId) ?? overlapBlockerTask?.column ?? "unknown";
              await this.logDispatchQueuedReason(
                task.id,
                `queued — blocked by active file-scope lease ${overlappingTaskId} (column=${activeLeaseColumn})`,
              );
              continue;
            }

            if (task.overlapBlockedBy) {
              await this.store.updateTask(task.id, { overlapBlockedBy: null });
            }
          } else if (coordinationOnlyTask && task.overlapBlockedBy) {
            await this.store.updateTask(task.id, { overlapBlockedBy: null });
            await this.store.logEntry(
              task.id,
              "coordination/no-commit task bypassed non-implementation overlap lease",
            );
          }
        }

        /**
         * FNXC:Scheduler-Concurrency 2026-06-13-20:08:
         * FN-6423 fixes the FN-6420 evidence where queue logs reported `gate=maxWorktrees` with `maxWorktrees used=1/3` and `semaphore used=-9/3`. Recompute capacity at the queue decision point, including tasks already started this tick, so the gate label, memo key, and `started` decision share one authoritative snapshot.
         */
        const queuePointCapacity = computeDispatchCapacityDiagnostic(started);
        if (queuePointCapacity.available <= 0) {
          const reason = formatConcurrencyLimitReason(queuePointCapacity);
          const concurrencySignature = formatConcurrencyLimitMemoKey(queuePointCapacity);
          await this.logDispatchQueuedReason(
            task.id,
            reason,
            concurrencySignature,
          );
          continue;
        }

        // Dependencies met — resolve base branch from in-review deps.
        // Worktree allocation is deferred to moveTask below, where it
        // runs under TaskStore's cross-task allocation lock so it can't
        // race against a concurrent manual-move.
        const baseBranch = this.resolveBaseBranch(task, tasks);

        // Compare-and-swap: re-read the task to verify it's still in "todo" before dispatching.
        // This prevents dispatching a task twice if another schedule() call or user action
        // moved it away from "todo" between our initial snapshot and this dispatch attempt.
        // The re-entrance guard prevents overlapping schedule() passes, but external events
        // (user moves, API calls) can still trigger concurrent state changes.
        const freshTask = await this.store.getTask(task.id);
        if (!freshTask || freshTask.column !== "todo") {
          schedulerLog.log(`Task ${task.id} no longer in "todo" (column=${freshTask?.column ?? "N/A"}) — skipping dispatch`);
          continue;
        }
        if (freshTask.paused) {
          schedulerLog.log(`Task ${task.id} is paused — skipping dispatch`);
          continue;
        }

        const latestSettings = await this.store.getSettings();
        const oscillationSettings = latestSettings as Settings & {
          dispatchOscillationSettleMs?: number;
          dispatchOscillationThreshold?: number;
          dispatchOscillationWindowMs?: number;
        };
        const dispatchSettleMs = oscillationSettings.dispatchOscillationSettleMs
          ?? DEFAULT_DISPATCH_OSCILLATION_SETTLE_MS;
        const dispatchOscillationThreshold = oscillationSettings.dispatchOscillationThreshold
          ?? DEFAULT_DISPATCH_OSCILLATION_THRESHOLD;
        const dispatchOscillationWindowMs = oscillationSettings.dispatchOscillationWindowMs
          ?? DEFAULT_DISPATCH_OSCILLATION_WINDOW_MS;
        const recentEngineTodoMovedAt = this.recentEngineTodoRequeues.get(task.id);
        if (recentEngineTodoMovedAt) {
          if (freshTask.columnMovedAt !== recentEngineTodoMovedAt) {
            this.recentEngineTodoRequeues.delete(task.id);
          } else {
            const movedAtMs = Date.parse(recentEngineTodoMovedAt);
            const settleAgeMs = Number.isFinite(movedAtMs) ? Math.max(0, Date.now() - movedAtMs) : dispatchSettleMs;
            if (settleAgeMs < dispatchSettleMs) {
              schedulerLog.log(`Task ${task.id} was engine-requeued ${settleAgeMs}ms ago — waiting ${dispatchSettleMs}ms settle window before redispatch`);
              continue;
            }
            this.recentEngineTodoRequeues.delete(task.id);
          }
        }
        if (latestSettings.globalPause) {
          schedulerLog.log(`Task ${task.id} dispatch aborted — globalPause became active mid-pass`);
          continue;
        }
        if (latestSettings.enginePaused) {
          schedulerLog.log(`Task ${task.id} dispatch aborted — enginePaused became active mid-pass`);
          continue;
        }

        // Resolve effective node for routing
        let effectiveNode = resolveEffectiveNode(freshTask, settings);
        schedulerLog.log(`Task ${task.id} routed to node=${effectiveNode.nodeId ?? "local"} (source=${effectiveNode.source})`);

        // Enforce dispatch configuration validation before node-health fallback logic.
        if (effectiveNode.nodeId !== undefined && this.options.validateNodeDispatch) {
          const validation = await this.options.validateNodeDispatch(effectiveNode.nodeId);
          if (!validation.allowed) {
            if (!this.wasNodeDispatchValidationBlocked.has(task.id)) {
              this.wasNodeDispatchValidationBlocked.add(task.id);
              schedulerLog.log(`Task ${task.id} dispatch blocked — ${validation.reason}`);
              await this.store.logEntry(task.id, validation.reason);
            }
            continue;
          }

          this.wasNodeDispatchValidationBlocked.delete(task.id);
        }

        // Enforce unavailable-node policy + owning-node handoff policy
        // FN-4832: this guard currently applies only when node routing is explicit; local routing still relies on checkout 409 claim backstops.
        if (effectiveNode.nodeId !== undefined && this.options.nodeHealthMonitor) {
          const localNodeId = this.options.localNodeId ?? "local";
          if (freshTask.checkoutNodeId && freshTask.checkedOutBy && freshTask.checkoutNodeId !== localNodeId) {
            const ownerNodeHealth = this.options.nodeHealthMonitor.getNodeHealth(freshTask.checkoutNodeId);
            // FN-4832 + AGENTS.md Checkout Leasing: never dispatch tasks with active foreign ownership; policy decides park/reassign.
            const handoffDecision = decideOwningNodeHandoff({
              task: freshTask,
              ownerNodeId: freshTask.checkoutNodeId,
              ownerNodeHealth,
              localNodeId,
              handoffPolicy: settings.owningNodeHandoffPolicy,
            });

            if (handoffDecision.action === "park") {
              if (!this.wasNodeBlocked.has(task.id)) {
                this.wasNodeBlocked.add(task.id);
                if (ownerNodeHealth === "offline" || ownerNodeHealth === "error" || ownerNodeHealth === "online") {
                  await this.emitNodeUnreachableRecoveryAudit(freshTask, {
                    ownerNodeId: freshTask.checkoutNodeId,
                    ownerNodeHealth,
                    handoffAction: handoffDecision.action,
                    handoffReason: handoffDecision.reason,
                    decisionPath: "scheduler-handoff-park",
                    newColumn: freshTask.column,
                    dispatchNodeBefore: effectiveNode.nodeId,
                    dispatchNodeAfter: effectiveNode.nodeId,
                  });
                }
                const reason = `Owning-node handoff parked dispatch: ${handoffDecision.reason}`;
                schedulerLog.log(`Task ${task.id} dispatch blocked — ${reason}`);
                await this.store.logEntry(task.id, reason);
                try {
                  await this.store.recordRunAuditEvent?.({
                    taskId: freshTask.id,
                    agentId: "scheduler",
                    runId: generateSyntheticRunId("scheduler", freshTask.id),
                    domain: "database",
                    mutationType: "node:handoff:parked",
                    target: freshTask.id,
                    metadata: {
                      taskId: freshTask.id,
                      ownerNodeId: freshTask.checkoutNodeId,
                      ownerNodeHealth:
                        ownerNodeHealth === "offline" || ownerNodeHealth === "error" || ownerNodeHealth === "online"
                          ? ownerNodeHealth
                          : "unknown",
                      localNodeId,
                      handoffPolicy: settings.owningNodeHandoffPolicy,
                      decisionReason: handoffDecision.reason,
                      source: "scheduler.dispatch",
                    },
                  });
                } catch (error) {
                  schedulerLog.warn(`Task ${task.id} failed to emit node:handoff:parked audit: ${error instanceof Error ? error.message : String(error)}`);
                }
              }
              continue;
            }

            await this.store.logEntry(task.id, `Owning-node handoff applied: ${handoffDecision.reason}`);
            try {
              await this.store.recordRunAuditEvent?.({
                taskId: freshTask.id,
                agentId: "scheduler",
                runId: generateSyntheticRunId("scheduler", freshTask.id),
                domain: "database",
                mutationType: handoffDecision.action === "reassign-local" ? "node:handoff:reassign-local" : "node:handoff:reassign-any",
                target: freshTask.id,
                metadata: {
                  taskId: freshTask.id,
                  ownerNodeId: freshTask.checkoutNodeId,
                  ownerNodeHealth:
                    ownerNodeHealth === "offline" || ownerNodeHealth === "error" || ownerNodeHealth === "online"
                      ? ownerNodeHealth
                      : "unknown",
                  localNodeId,
                  handoffPolicy: settings.owningNodeHandoffPolicy,
                  decisionReason: handoffDecision.reason,
                  source: "scheduler.dispatch",
                },
              });
            } catch (error) {
              schedulerLog.warn(`Task ${task.id} failed to emit node:handoff audit: ${error instanceof Error ? error.message : String(error)}`);
            }
            const dispatchNodeBefore = effectiveNode.nodeId;
            if (handoffDecision.action === "reassign-local") {
              effectiveNode = { nodeId: undefined, source: "local" };
            }
            if (ownerNodeHealth === "offline" || ownerNodeHealth === "error" || ownerNodeHealth === "online") {
              await this.emitNodeUnreachableRecoveryAudit(freshTask, {
                ownerNodeId: freshTask.checkoutNodeId,
                ownerNodeHealth,
                handoffAction: handoffDecision.action,
                handoffReason: handoffDecision.reason,
                decisionPath:
                  handoffDecision.action === "reassign-local"
                    ? "scheduler-handoff-reassign-local"
                    : "scheduler-handoff-reassign-any",
                newColumn: freshTask.column,
                dispatchNodeBefore,
                dispatchNodeAfter: effectiveNode.nodeId,
              });
            }
          }

          const nodeHealth = effectiveNode.nodeId
            ? this.options.nodeHealthMonitor.getNodeHealth(effectiveNode.nodeId)
            : undefined;
          const decision = applyUnavailableNodePolicy({
            effectiveNode,
            nodeHealth,
            policy: settings.unavailableNodePolicy,
          });

          if (!decision.allowed) {
            if (!this.wasNodeBlocked.has(task.id)) {
              this.wasNodeBlocked.add(task.id);
              schedulerLog.log(`Task ${task.id} dispatch blocked — ${decision.reason}`);
              await this.store.logEntry(task.id, decision.reason);
            }
            continue;
          }

          this.wasNodeBlocked.delete(task.id);

          if (decision.fallbackToLocal) {
            schedulerLog.log(`Task ${task.id} falling back to local — ${decision.reason}`);
            await this.store.logEntry(task.id, decision.reason);
            effectiveNode = { nodeId: undefined, source: "local" };
          }
        }

        if (latestSettings.ephemeralAgentsEnabled === false && !freshTask.assignedAgentId) {
          if (!this.options.agentStore) {
            if (!loggedMissingAgentStoreThisPass) {
              loggedMissingAgentStoreThisPass = true;
              schedulerLog.warn("ephemeralAgentsEnabled=false but scheduler has no agentStore; falling back to legacy dispatch behavior");
            }
          } else {
            const selectedAgent = await selectPermanentAgentForTask({
              task: freshTask,
              agentStore: this.options.agentStore,
              taskStore: this.store,
            });

            if (!selectedAgent) {
              await this.store.updateTask(task.id, { status: "queued" });
              if (!this.wasPermanentAgentUnavailable.has(task.id)) {
                await this.logDispatchQueuedReason(
                  task.id,
                  "queued — no permanent executor available (ephemeral agents disabled)",
                );
                this.wasPermanentAgentUnavailable.add(task.id);
              }
              continue;
            }

            await this.store.updateTask(task.id, { assignedAgentId: selectedAgent.id });
            await this.store.logEntry(
              task.id,
              `Auto-assigned to permanent agent ${selectedAgent.id} (ephemeral agents disabled)`,
            );
            this.wasPermanentAgentUnavailable.delete(task.id);
          }
        } else {
          this.wasPermanentAgentUnavailable.delete(task.id);
        }

        // Clear status, reserve worktree path, and then move to in-progress.
        // Reset mergeRetries so a fresh execution gets a fresh merge budget —
        // otherwise a task whose previous run exhausted its 3 retries (e.g.
        // verification failure that was later cleared) lands back in in-review
        // with mergeRetries=MAX, the merger refuses it (canMergeTask false),
        // and the ghost-review fallback bounces it back to todo every 10 min
        // before the 30-min cooldown can elapse — infinite loop. See FN-3305.
        const dispatchTimestamp = new Date().toISOString();
        const lastDispatchAtMs = freshTask.lastDispatchAt ? Date.parse(freshTask.lastDispatchAt) : Number.NaN;
        const priorDispatchWithinWindow = Number.isFinite(lastDispatchAtMs)
          && Date.now() - lastDispatchAtMs <= dispatchOscillationWindowMs;
        const nextDispatchStormCount = priorDispatchWithinWindow
          ? (freshTask.dispatchStormCount ?? 0) + 1
          : 1;

        if (nextDispatchStormCount > dispatchOscillationThreshold) {
          const oscillationError = freshTask.error
            ?? `DISPATCH_OSCILLATION: detected ${nextDispatchStormCount} todo↔in-progress cycles within ${dispatchOscillationWindowMs}ms. Task auto-paused for operator review.`;
          await this.store.updateTask(task.id, {
            dispatchStormCount: nextDispatchStormCount,
            lastDispatchAt: dispatchTimestamp,
            paused: true,
            pausedReason: "dispatch-oscillation",
            status: freshTask.status ?? "queued",
            error: oscillationError,
          });
          await this.store.logEntry(
            task.id,
            `Dispatch oscillation auto-paused after ${nextDispatchStormCount} cycles within ${dispatchOscillationWindowMs}ms`,
          );
          await this.store.appendAgentLog?.(
            task.id,
            "Dispatch oscillation detected — task auto-paused for operator review",
            "text",
            `cycleCount=${nextDispatchStormCount} windowMs=${dispatchOscillationWindowMs}`,
          );
          await this.store.recordRunAuditEvent?.({
            taskId: task.id,
            agentId: "scheduler",
            runId: generateSyntheticRunId("scheduler-dispatch-oscillation", task.id),
            domain: "database",
            mutationType: "task:dispatch-oscillation-terminalized",
            target: task.id,
            metadata: {
              taskId: task.id,
              cycleCount: nextDispatchStormCount,
              windowMs: dispatchOscillationWindowMs,
              lastMoveSource: recentEngineTodoMovedAt ? "engine" : "scheduler",
            },
          });
          schedulerLog.warn(`Task ${task.id} auto-paused after dispatch oscillation threshold ${dispatchOscillationThreshold} was exceeded (${nextDispatchStormCount} cycles)`);
          continue;
        }

        schedulerLog.log(`Starting ${task.id}: ${task.title || task.id} (deps satisfied)`);
        await this.store.updateTask(task.id, {
          status: null,
          blockedBy: null,
          executionStartBranch: baseBranch ?? undefined,
          effectiveNodeId: effectiveNode.nodeId ?? null,
          effectiveNodeSource: effectiveNode.source,
          mergeRetries: 0,
        });
        try {
          await this.store.moveTask(task.id, "in-progress", {
            moveSource: "scheduler",
            allocateWorktree: (reservedNames) =>
              this.planWorktreePath(task, settings.worktreeNaming, reservedNames, settings),
          });
        } catch (error) {
          if (error instanceof TransitionRejectionError && error.rejection.code === "capacity-exhausted") {
            await this.store.updateTask(task.id, { status: "queued" });
            const reason = error.message || "queued — in-progress column at capacity";
            await this.logDispatchQueuedReason(task.id, reason, `capacity-exhausted:${reason}`);
            continue;
          }
          throw error;
        }
        await this.store.updateTask(task.id, {
          dispatchStormCount: nextDispatchStormCount,
          lastDispatchAt: dispatchTimestamp,
        });
        this.recentEngineTodoRequeues.delete(task.id);
        this.wasNodeBlocked.delete(task.id);
        this.wasNodeDispatchValidationBlocked.delete(task.id);
        this.wasPermanentAgentUnavailable.delete(task.id);
        this.clearDispatchQueuedReasonMemo(task.id);
        await this.store.logEntry(task.id, `Node routing resolved: ${effectiveNode.nodeId ?? "local"} (source: ${effectiveNode.source})`);
        this.options.onSchedule?.(task);
        started++;

        // Track newly started task's file scope for overlap with remaining todo tasks
        if (settings.groupOverlappingFiles) {
          const scope = await getFilteredFileScope(task.id);
          if (scope.length > 0 && !isCoordinationOnlyTask(task, scope)) setActiveScopeLease(task.id, scope, "in-progress");
        }
      }

      await this.emitHighOverlapFanoutWarnings(tasks);

      const staleWarningWindows = [settings.staleInProgressWarningMs, settings.staleInReviewWarningMs]
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
      const minWarningMs = staleWarningWindows.length > 0 ? Math.min(...staleWarningWindows) : 0;
      if (minWarningMs > 0 && Date.now() - this.lastStaleTaskReportAt >= minWarningMs) {
        try {
          await this.staleTaskReporter.report();
          this.lastStaleTaskReportAt = Date.now();
        } catch (error) {
          schedulerLog.warn("Stale task reporter failed", error);
        }
      }

      if (settings.backlogPressureAlertEnabled !== false && Date.now() - this.lastBacklogPressureReportAt >= 60_000) {
        try {
          await this.backlogPressureReporter.report();
        } catch (error) {
          schedulerLog.warn("Backlog pressure reporter failed", error);
        } finally {
          this.lastBacklogPressureReportAt = Date.now();
        }
      }

      if (Date.now() - this.lastUnlinkedMissionsAdvisoryReportAt >= 60_000) {
        try {
          await this.unlinkedMissionsAdvisoryReporter.report();
        } catch (error) {
          schedulerLog.warn("Unlinked missions advisory reporter failed", error);
        } finally {
          this.lastUnlinkedMissionsAdvisoryReportAt = Date.now();
        }
      }
    } catch (err) {
      schedulerLog.error("Scheduling error:", err);
    } finally {
      this.scheduling = false;
    }
  }

  /**
   * U6: run one hold/release sweep pass, wiring the scheduler's semaphore +
   * worktree allocation into the reservation-first ordering (KTD-10). Failures
   * are isolated so a sweep error never breaks the scheduling pass.
   */
  private async runHoldReleaseSweepPass(tasks: Task[], settings: Settings): Promise<void> {
    try {
      const maxWorktrees = settings.maxWorktrees ?? this.options.maxWorktrees ?? 4;
      const maxConcurrent = settings.maxConcurrent ?? this.options.maxConcurrent ?? 2;
      let reservedWorktreeSlots = tasks.filter((task) => task.column === "in-progress").length;
      let reservedConcurrentSlots = reservedWorktreeSlots;
      const inProgressTaskIds = tasks.filter((task) => task.column === "in-progress").map((task) => task.id);
      const dispatchPrepByTaskId = new Map<string, {
        baseBranch: string | null;
        dispatchStormCount: number;
        dispatchTimestamp: string;
        effectiveNodeId: string | null;
        effectiveNodeSource: string;
        task: Task;
      }>();
      const activeScopes = new Map<string, string[]>();
      const activeScopeColumns = new Map<string, Task["column"]>();
      const overlapIgnorePaths = settings.overlapIgnorePaths ?? [];
      const filteredScopeByTaskId = new Map<string, string[]>();
      const getFilteredFileScope = async (taskId: string): Promise<string[]> => {
        const cached = filteredScopeByTaskId.get(taskId);
        if (cached !== undefined) return cached;
        const scope = await this.store.parseFileScopeFromPrompt(taskId);
        const filteredScope = filterPathsByIgnoreList(scope, overlapIgnorePaths, { ignoreHiddenOverlapPaths: settings.ignoreHiddenOverlapPaths });
        filteredScopeByTaskId.set(taskId, filteredScope);
        return filteredScope;
      };

      const mergeShadowEnabled = settings.mergeRequestContractShadowEnabled === true;
      const markerAcceptedByTaskId = new Map<string, boolean>();
      if (mergeShadowEnabled) {
        const dependencyIds = new Set(tasks.flatMap((candidate) => candidate.dependencies));
        for (const depId of dependencyIds) {
          markerAcceptedByTaskId.set(depId, (await this.store.getCompletionHandoffAcceptedMarker(depId)) !== null);
        }
      }
      const schedulingDependencyOptions = mergeShadowEnabled
        ? {
          markerAcceptedByTaskId,
          onParityDiff: (diff: SchedulingDependencyParityDiff) => {
            this.emitDependencyParityDiff(diff);
          },
        }
        : undefined;

      if (settings.groupOverlappingFiles) {
        for (const task of tasks) {
          if (task.column !== "in-progress") continue;
          if (!shouldHoldActiveFileScopeLease(task, tasks, { schedulingDependencyOptions })) continue;
          const filteredScope = await getFilteredFileScope(task.id);
          if (isCoordinationOnlyTask(task, filteredScope)) continue;
          if (filteredScope.length === 0) continue;
          activeScopes.set(task.id, filteredScope);
          activeScopeColumns.set(task.id, task.column);
        }

        // FNXC:PostgresCutover 2026-06-27-09:30:
        // Pre-compute handoff markers before the .filter() because
        // getCompletionHandoffAcceptedMarker is async.
        const reviewHandoffMarkerMap = new Map<string, boolean>();
        if (settings.mergeRequestContractShadowEnabled === true) {
          for (const t of tasks) {
            if (t.column === "in-review") {
              reviewHandoffMarkerMap.set(t.id, (await this.store.getCompletionHandoffAcceptedMarker(t.id)) !== null);
            }
          }
        }
        const inReviewWithWorktree = tasks.filter(
          (task) => task.column === "in-review" && shouldHoldActiveFileScopeLease(task, tasks, {
            mergeRequestContractShadowEnabled: settings.mergeRequestContractShadowEnabled,
            handoffAccepted: reviewHandoffMarkerMap.get(task.id) ?? false,
            schedulingDependencyOptions,
          }),
        );
        for (const task of inReviewWithWorktree) {
          const filteredScope = await getFilteredFileScope(task.id);
          if (isCoordinationOnlyTask(task, filteredScope)) continue;
          if (filteredScope.length > 0) {
            activeScopes.set(task.id, filteredScope);
            activeScopeColumns.set(task.id, task.column);
          }
        }
      }

      const result = await runHoldReleaseSweep(this.store, {
        now: () => Date.now(),
        reserveSlot: async (task): Promise<SlotReservation | null> => {
          let reservedScope = false;

          const unmetDeps = getUnmetSchedulingDependencies(task, tasks, schedulingDependencyOptions);
          if (unmetDeps.length > 0) {
            await this.store.updateTask(task.id, {
              status: "queued",
              blockedBy: unmetDeps[0],
            });
            await this.logDispatchQueuedReason(task.id, `queued — unmet dependencies: ${unmetDeps.join(", ")}`);
            this.options.onBlocked?.(task, unmetDeps);
            return null;
          }

          if (this.options.missionStore && task.sliceId) {
            try {
              const slice = this.options.missionStore.getSlice(task.sliceId);
              const milestone = slice ? this.options.missionStore.getMilestone(slice.milestoneId) : undefined;
              const mission = milestone ? this.options.missionStore.getMission(milestone.missionId) : undefined;
              if (mission?.status === "blocked") {
                await this.store.updateTask(task.id, { status: "queued" });
                await this.logDispatchQueuedReason(task.id, "queued — mission is blocked");
                return null;
              }
            } catch (err: unknown) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              schedulerLog.warn(
                `Mission/slice lookup failed during workflow scheduling (task ${task.id}): ${errorMessage} — proceeding without blocked-slice check`,
              );
            }
          }

          /*
          FNXC:WorkflowScheduling 2026-06-23-11:12:
          The workflow sweep is the only dispatcher, so the scheduler-only pre-dispatch gates must run before a capacity hold moves to an execution column. Keep dependency, filesystem, node-routing, permanent-agent, and oscillation checks on this path instead of relying on the retired todo loop.
          */
          const validation = await this.validateTaskFilesystem(task.id);
          if (!validation.valid) {
            schedulerLog.warn(`Task ${task.id} filesystem validation failed: ${validation.reason}`);
            await this.store.moveTask(task.id, "triage");
            await this.store.logEntry(task.id, "Task moved to triage — filesystem validation failed", validation.reason);
            return null;
          }

          if (typeof this.store.getTasksDir === "function") {
            const promptPath = getPromptPath(this.store.getTasksDir(), task.id);
            const staleness = await evaluateSpecStaleness({ settings, promptPath, task });
            if (staleness.isStale) {
              schedulerLog.warn(`Task ${task.id} specification is stale — ${staleness.reason}`);
              await this.store.moveTask(task.id, "triage");
              await this.store.updateTask(task.id, { status: "needs-replan" });
              await this.store.logEntry(task.id, staleness.reason);
              return null;
            }
          }

          const freshTask = await this.store.getTask(task.id);
          if (!freshTask || freshTask.column !== task.column || freshTask.paused || freshTask.userPaused) {
            if (freshTask?.userPaused === true && freshTask.status !== "queued") {
              await this.store.updateTask(task.id, { status: "queued" });
              await this.logDispatchQueuedReason(task.id, "queued — user paused (manual move to todo)");
            }
            return null;
          }

          if (freshTask.checkedOutBy && this.options.leaseManager) {
            const recovered = await this.options.leaseManager.recoverAbandonedLease(
              freshTask.id,
              "scheduler detected stale todo lease",
              { preserveProgress: true },
            );
            if (!recovered) {
              await this.options.leaseManager.reconcileLeaseRow(freshTask.id);
              await this.store.updateTask(freshTask.id, { status: "queued" });
              await this.logDispatchQueuedReason(freshTask.id, "queued — checkout lease recovery blocked dispatch");
              return null;
            }
          }

          const latestSettings = await this.store.getSettings();
          if (latestSettings.globalPause) {
            schedulerLog.log(`Task ${task.id} dispatch aborted — globalPause became active mid-pass`);
            return null;
          }
          if (latestSettings.enginePaused) {
            schedulerLog.log(`Task ${task.id} dispatch aborted — enginePaused became active mid-pass`);
            return null;
          }

          let effectiveNode = resolveEffectiveNode(freshTask, settings);
          schedulerLog.log(`Task ${task.id} routed to node=${effectiveNode.nodeId ?? "local"} (source=${effectiveNode.source})`);

          if (effectiveNode.nodeId !== undefined && this.options.validateNodeDispatch) {
            const nodeValidation = await this.options.validateNodeDispatch(effectiveNode.nodeId);
            if (!nodeValidation.allowed) {
              if (!this.wasNodeDispatchValidationBlocked.has(task.id)) {
                this.wasNodeDispatchValidationBlocked.add(task.id);
                schedulerLog.log(`Task ${task.id} dispatch blocked — ${nodeValidation.reason}`);
                await this.store.logEntry(task.id, nodeValidation.reason);
              }
              return null;
            }
            this.wasNodeDispatchValidationBlocked.delete(task.id);
          }

          if (effectiveNode.nodeId !== undefined && this.options.nodeHealthMonitor) {
            const localNodeId = this.options.localNodeId ?? "local";
            if (freshTask.checkoutNodeId && freshTask.checkedOutBy && freshTask.checkoutNodeId !== localNodeId) {
              const ownerNodeHealth = this.options.nodeHealthMonitor.getNodeHealth(freshTask.checkoutNodeId);
              const handoffDecision = decideOwningNodeHandoff({
                task: freshTask,
                ownerNodeId: freshTask.checkoutNodeId,
                ownerNodeHealth,
                localNodeId,
                handoffPolicy: settings.owningNodeHandoffPolicy,
              });

              if (handoffDecision.action === "park") {
                if (!this.wasNodeBlocked.has(task.id)) {
                  this.wasNodeBlocked.add(task.id);
                  if (ownerNodeHealth === "offline" || ownerNodeHealth === "error" || ownerNodeHealth === "online") {
                    await this.emitNodeUnreachableRecoveryAudit(freshTask, {
                      ownerNodeId: freshTask.checkoutNodeId,
                      ownerNodeHealth,
                      handoffAction: handoffDecision.action,
                      handoffReason: handoffDecision.reason,
                      decisionPath: "scheduler-handoff-park",
                      newColumn: freshTask.column,
                      dispatchNodeBefore: effectiveNode.nodeId,
                      dispatchNodeAfter: effectiveNode.nodeId,
                    });
                  }
                  const reason = `Owning-node handoff parked dispatch: ${handoffDecision.reason}`;
                  schedulerLog.log(`Task ${task.id} dispatch blocked — ${reason}`);
                  await this.store.logEntry(task.id, reason);
                  try {
                    await this.store.recordRunAuditEvent?.({
                      taskId: freshTask.id,
                      agentId: "scheduler",
                      runId: generateSyntheticRunId("scheduler", freshTask.id),
                      domain: "database",
                      mutationType: "node:handoff:parked",
                      target: freshTask.id,
                      metadata: {
                        taskId: freshTask.id,
                        ownerNodeId: freshTask.checkoutNodeId,
                        ownerNodeHealth:
                          ownerNodeHealth === "offline" || ownerNodeHealth === "error" || ownerNodeHealth === "online"
                            ? ownerNodeHealth
                            : "unknown",
                        localNodeId,
                        handoffPolicy: settings.owningNodeHandoffPolicy,
                        decisionReason: handoffDecision.reason,
                        source: "scheduler.dispatch",
                      },
                    });
                  } catch (error) {
                    schedulerLog.warn(`Task ${task.id} failed to emit node:handoff:parked audit: ${error instanceof Error ? error.message : String(error)}`);
                  }
                }
                return null;
              }

              await this.store.logEntry(task.id, `Owning-node handoff applied: ${handoffDecision.reason}`);
              try {
                await this.store.recordRunAuditEvent?.({
                  taskId: freshTask.id,
                  agentId: "scheduler",
                  runId: generateSyntheticRunId("scheduler", freshTask.id),
                  domain: "database",
                  mutationType: handoffDecision.action === "reassign-local" ? "node:handoff:reassign-local" : "node:handoff:reassign-any",
                  target: freshTask.id,
                  metadata: {
                    taskId: freshTask.id,
                    ownerNodeId: freshTask.checkoutNodeId,
                    ownerNodeHealth:
                      ownerNodeHealth === "offline" || ownerNodeHealth === "error" || ownerNodeHealth === "online"
                        ? ownerNodeHealth
                        : "unknown",
                    localNodeId,
                    handoffPolicy: settings.owningNodeHandoffPolicy,
                    decisionReason: handoffDecision.reason,
                    source: "scheduler.dispatch",
                  },
                });
              } catch (error) {
                schedulerLog.warn(`Task ${task.id} failed to emit node:handoff audit: ${error instanceof Error ? error.message : String(error)}`);
              }
              const dispatchNodeBefore = effectiveNode.nodeId;
              if (handoffDecision.action === "reassign-local") {
                effectiveNode = { nodeId: undefined, source: "local" };
              }
              if (ownerNodeHealth === "offline" || ownerNodeHealth === "error" || ownerNodeHealth === "online") {
                await this.emitNodeUnreachableRecoveryAudit(freshTask, {
                  ownerNodeId: freshTask.checkoutNodeId,
                  ownerNodeHealth,
                  handoffAction: handoffDecision.action,
                  handoffReason: handoffDecision.reason,
                  decisionPath:
                    handoffDecision.action === "reassign-local"
                      ? "scheduler-handoff-reassign-local"
                      : "scheduler-handoff-reassign-any",
                  newColumn: freshTask.column,
                  dispatchNodeBefore,
                  dispatchNodeAfter: effectiveNode.nodeId,
                });
              }
            }

            if (effectiveNode.nodeId !== undefined) {
              const nodeHealth = this.options.nodeHealthMonitor.getNodeHealth(effectiveNode.nodeId);
              const decision = applyUnavailableNodePolicy({
                effectiveNode,
                nodeHealth,
                policy: settings.unavailableNodePolicy,
              });
              if (!decision.allowed) {
                if (!this.wasNodeBlocked.has(task.id)) {
                  this.wasNodeBlocked.add(task.id);
                  schedulerLog.log(`Task ${task.id} dispatch blocked — ${decision.reason}`);
                  await this.store.logEntry(task.id, decision.reason);
                }
                return null;
              }
              this.wasNodeBlocked.delete(task.id);
              if (decision.fallbackToLocal) {
                schedulerLog.log(`Task ${task.id} falling back to local — ${decision.reason}`);
                await this.store.logEntry(task.id, decision.reason);
                effectiveNode = { nodeId: undefined, source: "local" };
              }
            }
          }

          if (latestSettings.ephemeralAgentsEnabled === false && !freshTask.assignedAgentId) {
            /*
            FNXC:WorkflowScheduling 2026-06-23-22:33:
            The workflow cutover path must not silently dispatch unassigned work when ephemeral agents are disabled. Queue until permanent-agent selection is available so upgrades preserve the executor contract instead of falling through to local execution.
            */
            if (!this.options.agentStore) {
              await this.store.updateTask(task.id, { status: "queued" });
              if (!this.wasPermanentAgentUnavailable.has(task.id)) {
                await this.logDispatchQueuedReason(
                  task.id,
                  "queued — permanent executor selection unavailable (ephemeral agents disabled)",
                );
                this.wasPermanentAgentUnavailable.add(task.id);
              }
              return null;
            }

            const selectedAgent = await selectPermanentAgentForTask({
              task: freshTask,
              agentStore: this.options.agentStore,
              taskStore: this.store,
            });
            if (!selectedAgent) {
              await this.store.updateTask(task.id, { status: "queued" });
              if (!this.wasPermanentAgentUnavailable.has(task.id)) {
                await this.logDispatchQueuedReason(
                  task.id,
                  "queued — no permanent executor available (ephemeral agents disabled)",
                );
                this.wasPermanentAgentUnavailable.add(task.id);
              }
              return null;
            }
            await this.store.updateTask(task.id, { assignedAgentId: selectedAgent.id });
            await this.store.logEntry(
              task.id,
              `Auto-assigned to permanent agent ${selectedAgent.id} (ephemeral agents disabled)`,
            );
            this.wasPermanentAgentUnavailable.delete(task.id);
          } else {
            this.wasPermanentAgentUnavailable.delete(task.id);
          }

          const oscillationSettings = latestSettings as Settings & {
            dispatchOscillationSettleMs?: number;
            dispatchOscillationThreshold?: number;
            dispatchOscillationWindowMs?: number;
          };
          const dispatchSettleMs = oscillationSettings.dispatchOscillationSettleMs
            ?? DEFAULT_DISPATCH_OSCILLATION_SETTLE_MS;
          const dispatchOscillationThreshold = oscillationSettings.dispatchOscillationThreshold
            ?? DEFAULT_DISPATCH_OSCILLATION_THRESHOLD;
          const dispatchOscillationWindowMs = oscillationSettings.dispatchOscillationWindowMs
            ?? DEFAULT_DISPATCH_OSCILLATION_WINDOW_MS;
          const recentEngineTodoMovedAt = this.recentEngineTodoRequeues.get(task.id);
          if (recentEngineTodoMovedAt) {
            if (freshTask.columnMovedAt !== recentEngineTodoMovedAt) {
              this.recentEngineTodoRequeues.delete(task.id);
            } else {
              const movedAtMs = Date.parse(recentEngineTodoMovedAt);
              const settleAgeMs = Number.isFinite(movedAtMs) ? Math.max(0, Date.now() - movedAtMs) : dispatchSettleMs;
              if (settleAgeMs < dispatchSettleMs) {
                schedulerLog.log(`Task ${task.id} was engine-requeued ${settleAgeMs}ms ago — waiting ${dispatchSettleMs}ms settle window before redispatch`);
                return null;
              }
              this.recentEngineTodoRequeues.delete(task.id);
            }
          }

          const dispatchTimestamp = new Date().toISOString();
          const lastDispatchAtMs = freshTask.lastDispatchAt ? Date.parse(freshTask.lastDispatchAt) : Number.NaN;
          const priorDispatchWithinWindow = Number.isFinite(lastDispatchAtMs)
            && Date.now() - lastDispatchAtMs <= dispatchOscillationWindowMs;
          const nextDispatchStormCount = priorDispatchWithinWindow
            ? (freshTask.dispatchStormCount ?? 0) + 1
            : 1;
          if (nextDispatchStormCount > dispatchOscillationThreshold) {
            const oscillationError = freshTask.error
              ?? `DISPATCH_OSCILLATION: detected ${nextDispatchStormCount} todo↔in-progress cycles within ${dispatchOscillationWindowMs}ms. Task auto-paused for operator review.`;
            await this.store.updateTask(task.id, {
              dispatchStormCount: nextDispatchStormCount,
              lastDispatchAt: dispatchTimestamp,
              paused: true,
              pausedReason: "dispatch-oscillation",
              status: freshTask.status ?? "queued",
              error: oscillationError,
            });
            await this.store.logEntry(
              task.id,
              `Dispatch oscillation auto-paused after ${nextDispatchStormCount} cycles within ${dispatchOscillationWindowMs}ms`,
            );
            await this.store.appendAgentLog?.(
              task.id,
              "Dispatch oscillation detected — task auto-paused for operator review",
              "text",
              `cycleCount=${nextDispatchStormCount} windowMs=${dispatchOscillationWindowMs}`,
            );
            await this.store.recordRunAuditEvent?.({
              taskId: task.id,
              agentId: "scheduler",
              runId: generateSyntheticRunId("scheduler-dispatch-oscillation", task.id),
              domain: "database",
              mutationType: "task:dispatch-oscillation-terminalized",
              target: task.id,
              metadata: {
                taskId: task.id,
                cycleCount: nextDispatchStormCount,
                windowMs: dispatchOscillationWindowMs,
                lastMoveSource: recentEngineTodoMovedAt ? "engine" : "scheduler",
              },
            });
            schedulerLog.warn(`Task ${task.id} auto-paused after dispatch oscillation threshold ${dispatchOscillationThreshold} was exceeded (${nextDispatchStormCount} cycles)`);
            return null;
          }

          if (settings.groupOverlappingFiles) {
            const taskScope = await getFilteredFileScope(task.id);
            if (taskScope.length > 0 && !isCoordinationOnlyTask(task, taskScope)) {
              const overlappingTaskId = Array.from(activeScopes.entries())
                .sort(([aId], [bId]) => aId.localeCompare(bId))
                .find(([, activeScope]) => this.pathsOverlap(taskScope, activeScope))?.[0] ?? null;

              if (overlappingTaskId) {
                const activeLeaseColumn = activeScopeColumns.get(overlappingTaskId) ?? "in-progress";
                await this.store.updateTask(task.id, {
                  status: "queued",
                  blockedBy: null,
                  overlapBlockedBy: overlappingTaskId,
                });
                await this.rollbackRunningAgentsForQueuedTodoTask(task.id);
                await this.logDispatchQueuedReason(
                  task.id,
                  `queued — blocked by active file-scope lease ${overlappingTaskId} (column=${activeLeaseColumn})`,
                );
                return null;
              }

              if (task.overlapBlockedBy) {
                await this.store.updateTask(task.id, { overlapBlockedBy: null });
              }

              activeScopes.set(task.id, taskScope);
              activeScopeColumns.set(task.id, "in-progress");
              reservedScope = true;
            } else if (task.overlapBlockedBy) {
              await this.store.updateTask(task.id, { overlapBlockedBy: null });
              if (isCoordinationOnlyTask(task, taskScope)) {
                await this.store.logEntry(
                  task.id,
                  "coordination/no-commit task bypassed non-implementation overlap lease",
                );
              }
            }
          }

          const concurrencyDiagnostic = computeConcurrencyGateDiagnostic({
            agentSlots: reservedConcurrentSlots,
            maxConcurrent,
            activeWorktrees: reservedWorktreeSlots,
            maxWorktrees,
            semaphore: this.options.semaphore,
            inProgressTaskIds,
          });
          /*
          FNXC:WorkflowScheduling 2026-06-23-20:58:
          The workflow hold/release sweep is the only todo pickup path, so it must honor the same maxConcurrent, maxWorktrees, and shared semaphore pressure before releasing a task to in-progress. This is deliberately a non-mutating preflight: executor owns the actual semaphore acquire, and the scheduler only prevents capacity-obvious over-release without double-acquiring slots.
          */
          if (concurrencyDiagnostic.available <= 0) {
            if (reservedScope) {
              activeScopes.delete(task.id);
              activeScopeColumns.delete(task.id);
            }
            const reason = formatConcurrencyLimitReason(concurrencyDiagnostic);
            await this.store.updateTask(task.id, { status: "queued" });
            await this.logDispatchQueuedReason(task.id, reason, formatConcurrencyLimitMemoKey(concurrencyDiagnostic));
            return null;
          }

          dispatchPrepByTaskId.set(task.id, {
            baseBranch: this.resolveBaseBranch(freshTask, tasks),
            dispatchStormCount: nextDispatchStormCount,
            dispatchTimestamp,
            effectiveNodeId: effectiveNode.nodeId ?? null,
            effectiveNodeSource: effectiveNode.source,
            task: freshTask,
          });

          reservedWorktreeSlots += 1;
          reservedConcurrentSlots += 1;
          let released = false;
          return {
            release: () => {
              if (released) return;
              released = true;
              if (reservedScope) {
                activeScopes.delete(task.id);
                activeScopeColumns.delete(task.id);
              }
              reservedWorktreeSlots = Math.max(0, reservedWorktreeSlots - 1);
              reservedConcurrentSlots = Math.max(0, reservedConcurrentSlots - 1);
              dispatchPrepByTaskId.delete(task.id);
            },
          };
        },
        allocateWorktree: (task, reservedNames) =>
          this.planWorktreePath(task, settings.worktreeNaming, reservedNames, settings),
      });
      for (const taskId of result.released) {
        const prep = dispatchPrepByTaskId.get(taskId);
        if (!prep) continue;
        /*
        FNXC:WorkflowScheduling 2026-06-23-21:49:
        A workflow hold release is not a committed dispatch until moveTask succeeds and appears in result.released. Only then may the scheduler emit "Starting" and clear queued state.

        FNXC:WorkflowScheduling 2026-06-23-22:36:
        Persist dispatch metadata before executor handoff when possible, but isolate update/log failures per task. A metadata failure must not block later released tasks or strand an already released task without onSchedule handoff.
        */
        schedulerLog.log(`Starting ${taskId}: ${prep.task.title || taskId} (deps satisfied)`);
        const latest = await this.store.getTask(taskId).catch(() => null);
        const dispatchUpdate = {
          status: null,
          blockedBy: null,
          executionStartBranch: prep.baseBranch ?? undefined,
          effectiveNodeId: prep.effectiveNodeId,
          effectiveNodeSource: prep.effectiveNodeSource,
          mergeRetries: 0,
          dispatchStormCount: prep.dispatchStormCount,
          lastDispatchAt: prep.dispatchTimestamp,
        };
        const scheduledTask = {
          ...(latest?.id === taskId ? latest : prep.task),
          ...dispatchUpdate,
          status: undefined,
          blockedBy: undefined,
          effectiveNodeId: prep.effectiveNodeId ?? undefined,
          effectiveNodeSource: prep.effectiveNodeSource as Task["effectiveNodeSource"],
          column: "in-progress" as const,
        };
        try {
          await this.store.updateTask(taskId, dispatchUpdate);
        } catch (error) {
          schedulerLog.error(`Post-release dispatch metadata update failed for ${taskId}:`, error);
        }
        try {
          this.options.onSchedule?.(scheduledTask);
        } catch (error) {
          schedulerLog.error(`onSchedule failed for ${taskId}:`, error);
        }
        this.recentEngineTodoRequeues.delete(taskId);
        this.wasNodeBlocked.delete(taskId);
        this.wasNodeDispatchValidationBlocked.delete(taskId);
        this.wasPermanentAgentUnavailable.delete(taskId);
        this.clearDispatchQueuedReasonMemo(taskId);
        try {
          await this.store.logEntry(taskId, `Node routing resolved: ${prep.effectiveNodeId ?? "local"} (source: ${prep.effectiveNodeSource})`);
        } catch (error) {
          schedulerLog.error(`Post-release dispatch log failed for ${taskId}:`, error);
        }
      }
    } catch (error) {
      schedulerLog.error("Hold/release sweep failed:", error);
    }
  }

  /**
   * Handle a mission-linked task column move.
   * Keeps feature state synchronized with task columns across the full task
   * lifecycle, including review/merge transitions and older tasks whose task
   * row has mission/slice metadata but whose feature row lacks taskId.
   */
  private async handleMissionTaskMove(taskId: string, toColumn: import("@fusion/core").ColumnId): Promise<void> {
    if (!this.options.missionStore) return;

    const missionStore = this.options.missionStore;

    try {
      const task = await this.store.getTask(taskId);
      if (!task) {
        return;
      }

      const feature = this.resolveMissionFeatureForTask(missionStore, task);
      if (!feature) {
        schedulerLog.log(`No linked feature found for task ${taskId} (sliceId=${task.sliceId ?? "none"}) — skipping mission status update`);
        return;
      }

      if (task.sliceId && feature.sliceId !== task.sliceId) {
        schedulerLog.warn(
          `Task ${taskId} sliceId ${task.sliceId} does not match linked feature ${feature.id} sliceId ${feature.sliceId}; skipping mission update`,
        );
        return;
      }

      const hasLinkedAssertions = typeof missionStore.listAssertionsForFeature === "function"
        ? missionStore.listAssertionsForFeature(feature.id).length > 0
        : false;

      const reconciliation = await reconcileMissionFeatureState(
        this.store,
        { ...task, column: toColumn },
        feature,
        { hasLinkedAssertions },
      );

      if (reconciliation.kind === "blocked") {
        schedulerLog.warn(`Task ${taskId} mission update blocked — ${reconciliation.reason}`);
        return;
      }

      if (reconciliation.kind === "failure") {
        schedulerLog.warn(`Task ${taskId} mission update reported failure — ${reconciliation.reason}`);
        return;
      }

      const sliceIdBeforeUpdate = feature.sliceId;

      if (reconciliation.kind === "update") {
        missionStore.updateFeatureStatus(feature.id, reconciliation.status);
        schedulerLog.log(
          `Feature ${feature.id} marked ${reconciliation.status} (${reconciliation.reason})`,
        );
      }

      if (toColumn === "done") {
        await this.handleMissionTaskCompletion(taskId, sliceIdBeforeUpdate);
      }
    } catch (err) {
      schedulerLog.error(`Error handling mission task move for ${taskId}:`, err);
    }
  }

  private resolveMissionFeatureForTask(missionStore: MissionStore, task: Task): MissionFeature | undefined {
    const linkedFeature = missionStore.getFeatureByTaskId(task.id);
    if (linkedFeature) {
      return linkedFeature;
    }

    if (!task.sliceId || !task.title) {
      return undefined;
    }

    const normalizedTaskTitle = this.normalizeMissionFeatureTitle(task.title);
    const matchingFeature = missionStore
      .listFeatures(task.sliceId)
      .find((feature) =>
        !feature.taskId
        && this.normalizeMissionFeatureTitle(feature.title) === normalizedTaskTitle
      );

    if (!matchingFeature) {
      return undefined;
    }

    schedulerLog.warn(
      `Repairing one-way mission link: task ${task.id} matched unlinked feature ${matchingFeature.id}`,
    );
    return missionStore.linkFeatureToTask(matchingFeature.id, task.id);
  }

  private normalizeMissionFeatureTitle(title: string): string {
    return title.trim().replace(/\s+/g, " ").toLowerCase();
  }

  /**
   * Handle mission task completion.
   * When a task moves to "done", advance mission execution after the linked
   * feature status has already been reconciled by handleMissionTaskMove().
   * updateFeatureStatus cascades via recomputeSliceStatus — if all features
   * in the slice are done the slice status becomes "complete" automatically.
   *
   * If MissionAutopilot is configured, delegate slice advancement to it
   * (which tracks autopilot state and handles retries). Otherwise fall back
   * to the legacy onSliceComplete() path for non-autopilot missions.
   */
  private async handleMissionTaskCompletion(taskId: string, sliceId: string): Promise<void> {
    if (!this.options.missionStore) return;

    const missionStore = this.options.missionStore;

    try {
      const feature = missionStore.getFeatureByTaskId(taskId);
      if (!feature) return;

      if (feature.sliceId !== sliceId) {
        schedulerLog.warn(
          `Task ${taskId} sliceId ${sliceId} does not match linked feature ${feature.id} sliceId ${feature.sliceId}; skipping mission completion update`,
        );
        return;
      }

      const sliceIdBeforeUpdate = feature.sliceId;

      // Trigger the mission execution loop to run validation
      // This is called regardless of whether the slice is complete - the loop
      // handles the validation cycle independently
      if (this.options.missionExecutionLoop) {
        if (!this.options.missionExecutionLoop.isRunning()) {
          schedulerLog.warn(
            `MissionExecutionLoop was not running during task completion for ${taskId}; starting loop before processing outcome`,
          );
          this.options.missionExecutionLoop.start();
        }

        void this.options.missionExecutionLoop.processTaskOutcome(taskId).catch((err) => {
          schedulerLog.error(`Error in missionExecutionLoop.processTaskOutcome for ${taskId}:`, err);
        });
      }

      // Check if the slice became complete after the feature update
      const slice = missionStore.getSlice(sliceIdBeforeUpdate);
      if (slice && slice.status === "complete") {
        // If MissionAutopilot is available AND actively watching this mission,
        // delegate progression to it. The autopilot handles: watching missions,
        // autoAdvance guard, retry logic, and state tracking. The autopilot
        // will call back into scheduler.activateNextPendingSlice() when appropriate.
        //
        // If autopilot is not watching this mission (e.g., legacy missions with
        // autoAdvance=true but no autopilot instance, or autopilot unwatched),
        // fall back to onSliceComplete() which uses the compatibility rule.
        const autopilot = this.options.missionAutopilot;
        const milestone = missionStore.getMilestone(slice.milestoneId);
        const missionId = milestone?.missionId;
        const isWatching = autopilot && missionId ? autopilot.isWatching(missionId) : false;

        if (autopilot && isWatching) {
          schedulerLog.log(`Slice ${slice.id} is complete — delegating to autopilot`);
          await autopilot.handleTaskCompletion(taskId);
        } else {
          // Fallback path: onSliceComplete uses autopilotEnabled/autoAdvance compat
          schedulerLog.log(`Slice ${slice.id} is complete — triggering auto-advance`);
          await this.onSliceComplete(slice);
        }
      }
    } catch (err) {
      schedulerLog.error(`Error handling mission task completion for ${taskId}:`, err);
    }
  }

  async onSliceComplete(slice: import("@fusion/core").Slice): Promise<void> {
    if (!this.options.missionStore) return;

    const missionStore = this.options.missionStore;

    try {
      const milestone = missionStore.getMilestone(slice.milestoneId);
      if (!milestone) {
        schedulerLog.warn(`Milestone ${slice.milestoneId} not found for slice ${slice.id}`);
        return;
      }

      const mission = missionStore.getMission(milestone.missionId);
      // Use autopilotEnabled as canonical, fall back to autoAdvance for backward compat
      const shouldAutoAdvance =
        mission?.autopilotEnabled === true || mission?.autoAdvance === true;
      if (!mission || mission.status !== "active" || !shouldAutoAdvance) {
        return;
      }

      const missionHierarchy = missionStore.getMissionWithHierarchy(mission.id);
      const hasActiveSlice = missionHierarchy?.milestones.some((candidateMilestone) =>
        candidateMilestone.slices.some((candidateSlice) =>
          candidateSlice.id !== slice.id && candidateSlice.status === "active"
        )
      );
      if (hasActiveSlice) {
        schedulerLog.log(`Mission ${mission.id} already has an active slice; skipping auto-advance`);
        return;
      }

      const nextSlice = await this.activateNextPendingSlice(mission.id);
      if (nextSlice) {
        schedulerLog.log(`Auto-advanced: activated slice ${nextSlice.id} for mission ${mission.id}`);
      }
    } catch (err) {
      schedulerLog.error(`Error handling slice completion for ${slice.id}:`, err);
    }
  }

  /**
   * Activate the next pending slice in a mission.
   * Finds the first milestone with pending slices and activates
   * the first pending slice in that milestone.
   *
   * @param missionId - Mission ID
   * @returns The activated slice, or null if no pending slices
   */
  async activateNextPendingSlice(missionId: string): Promise<import("@fusion/core").Slice | null> {
    if (!this.options.missionStore) return null;

    const missionStore = this.options.missionStore;

    try {
      const mission = missionStore.getMissionWithHierarchy(missionId);
      if (!mission || mission.status !== "active") {
        schedulerLog.log(`Mission ${missionId}: not active, skipping slice activation`);
        return null;
      }

      const sortedMilestones = [...mission.milestones].sort((a, b) => a.orderIndex - b.orderIndex);

      for (const milestone of sortedMilestones) {
        const dependenciesMet = milestone.dependencies.every((dependencyId) => {
          const dependency = mission.milestones.find((candidate) => candidate.id === dependencyId);
          return dependency?.status === "complete";
        });
        if (!dependenciesMet) {
          continue;
        }

        const pendingSlice = [...milestone.slices]
          .sort((a, b) => a.orderIndex - b.orderIndex)
          .find((slice) => slice.status === "pending");
        if (!pendingSlice) {
          continue;
        }

        const activated = await missionStore.activateSlice(pendingSlice.id);
        schedulerLog.log(`Activated slice ${activated.id} for mission ${missionId}`);
        return activated;
      }

      schedulerLog.log(`Mission ${missionId}: no pending slices to activate`);
      return null;
    } catch (err) {
      schedulerLog.error(`Error activating next slice for mission ${missionId}:`, err);
      return null;
    }
  }

  /**
   * Reconcile feature status for all active missions on startup.
   *
   * This ensures that feature statuses are in sync with their linked task
   * columns for all missions, not just autopilot-enabled ones. The
   * reconciliation logic mirrors MissionAutopilot.reconcileMissionConsistency()
   * but runs unconditionally on startup.
   *
   * @returns The total number of fixes applied across all missions
   */
  async reconcileAllMissionFeatures(): Promise<number> {
    if (!this.options.missionStore) {
      return 0;
    }

    const missionStore = this.options.missionStore;
    let totalFixed = 0;

    try {
      const missions = missionStore.listMissions();
      const activeMissions = missions.filter((m) => m.status === "active");
      const activeMissionIds = new Set(activeMissions.map((mission) => mission.id));
      const taskBySliceAndTitle = new Map<string, Task | null>();
      const missionTasks = await this.store.listTasks({ slim: true, includeArchived: false });

      for (const task of missionTasks) {
        if (!task.missionId || !task.sliceId || !task.title || !activeMissionIds.has(task.missionId)) {
          continue;
        }

        const key = this.getMissionFeatureTitleKey(task.sliceId, task.title);
        taskBySliceAndTitle.set(
          key,
          taskBySliceAndTitle.has(key) ? null : task,
        );
      }

      for (const mission of activeMissions) {
        const hierarchy = missionStore.getMissionWithHierarchy(mission.id);
        if (!hierarchy) continue;

        const activeSlices = hierarchy.milestones
          .flatMap((milestone) => milestone.slices)
          .filter((slice) => slice.status === "active");

        for (const slice of activeSlices) {
          const missionAutoTriageEnabled = mission.autopilotEnabled === true || mission.autoAdvance === true;

          for (const feature of slice.features) {
            let featureForReconciliation = feature;
            let task: Task | undefined;
            if (feature.taskId) {
              task = await this.store.getTask(feature.taskId);
            } else {
              const matchedTask = taskBySliceAndTitle.get(
                this.getMissionFeatureTitleKey(feature.sliceId, feature.title),
              );
              if (matchedTask) {
                schedulerLog.warn(
                  `Repairing one-way mission link during reconciliation: task ${matchedTask.id} matched unlinked feature ${feature.id}`,
                );
                featureForReconciliation = missionStore.linkFeatureToTask(feature.id, matchedTask.id);
                task = matchedTask;
                totalFixed++;
                await this.emitStrandedFeatureTriageAudit(mission.id, slice.id, feature.id, matchedTask.id);
              } else if (
                missionAutoTriageEnabled
                && feature.status !== "blocked"
              ) {
                if (feature.status !== "defined" && this.isGeneratedFixFeature(feature)) {
                  try {
                    schedulerLog.warn(
                      `Blocking stranded generated fix feature ${feature.id}: no linked task and no title-matched task available`,
                    );
                    missionStore.updateFeature(feature.id, {
                      status: "blocked",
                      loopState: "blocked",
                      taskId: undefined,
                    });
                    totalFixed++;
                  } catch (error) {
                    schedulerLog.warn(
                      `Failed to block stranded fix feature ${feature.id} during reconciliation: ${error instanceof Error ? error.message : String(error)}`,
                    );
                  }
                } else if (feature.status === "defined" || feature.status === "triaged" || feature.status === "in-progress") {
                  try {
                    const featureToTriage = feature.status === "defined"
                      ? feature
                      : missionStore.updateFeature(feature.id, {
                        status: "defined",
                        loopState: "idle",
                        taskId: undefined,
                      });
                    if (featureToTriage.status !== feature.status) {
                      totalFixed++;
                    }
                    featureForReconciliation = await missionStore.triageFeature(featureToTriage.id);
                    task = featureForReconciliation.taskId
                      ? await this.store.getTask(featureForReconciliation.taskId)
                      : undefined;
                    totalFixed++;
                    if (featureForReconciliation.taskId) {
                      await this.emitStrandedFeatureTriageAudit(
                        mission.id,
                        slice.id,
                        featureForReconciliation.id,
                        featureForReconciliation.taskId,
                      );
                    }
                  } catch (error) {
                    schedulerLog.warn(
                      `Failed to triage stranded feature ${feature.id} during reconciliation: ${error instanceof Error ? error.message : String(error)}`,
                    );
                  }
                } else {
                  schedulerLog.warn(
                    `Skipping stranded feature ${feature.id} with terminal status ${feature.status}: no linked task and no title-matched task available`,
                  );
                }
              }
            }

            if (!task) continue;

            const hasLinkedAssertions = typeof missionStore.listAssertionsForFeature === "function"
              ? missionStore.listAssertionsForFeature(featureForReconciliation.id).length > 0
              : false;
            const reconciliation = await reconcileMissionFeatureState(this.store, task, featureForReconciliation, {
              hasLinkedAssertions,
            });

            if (reconciliation.kind === "failure") {
              if (this.options.onTaskFailed) {
                await this.options.onTaskFailed(task.id);
                totalFixed++;
              } else {
                schedulerLog.warn(`Skipping failed feature reconciliation for ${feature.id} — ${reconciliation.reason}`);
              }
              continue;
            }

            if (reconciliation.kind === "blocked") {
              schedulerLog.warn(`Skipping feature ${feature.id} reconciliation — ${reconciliation.reason}`);
              continue;
            }

            if (reconciliation.kind === "update") {
              missionStore.updateFeatureStatus(featureForReconciliation.id, reconciliation.status);
              totalFixed++;
            }
          }
        }
      }

      if (totalFixed > 0) {
        schedulerLog.log(`Mission feature reconciliation: fixed ${totalFixed} inconsistencies`);
      }
    } catch (err) {
      schedulerLog.error("Error during mission feature reconciliation:", err);
    }

    return totalFixed;
  }

  private async emitStrandedFeatureTriageAudit(
    missionId: string,
    sliceId: string,
    featureId: string,
    taskId: string,
  ): Promise<void> {
    const auditor = createRunAuditor(this.store, {
      runId: generateSyntheticRunId("scheduler-mission-stranded-feature", featureId),
      agentId: "scheduler",
      taskId,
      phase: "mission-stranded-feature-reconcile",
    });

    try {
      await auditor.database({
        type: "mission:stranded-feature-triaged",
        target: featureId,
        metadata: {
          missionId,
          sliceId,
          featureId,
          taskId,
        },
      });
    } catch (error) {
      schedulerLog.warn(
        `Feature ${featureId} failed to emit stranded-feature triage audit: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private getMissionFeatureTitleKey(sliceId: string, title: string): string {
    return `${sliceId}\0${this.normalizeMissionFeatureTitle(title)}`;
  }

  private isGeneratedFixFeature(feature: Pick<MissionFeature, "generatedFromFeatureId" | "generatedFromRunId">): boolean {
    return Boolean(feature.generatedFromFeatureId || feature.generatedFromRunId);
  }
}
