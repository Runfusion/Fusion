/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  TaskStore,
  Task,
  CentralCore,
  Settings,
  MergeResult,
  AutostashOrphanRecord,
  AutomationStore as AutomationStoreType,
  ScheduledTask,
  AutomationRunResult,
  ResearchModelSettings,
  ResearchSynthesisRequest,
  ResearchSynthesisResult,
  PlannerOverseerRuntimeSnapshot,
  PlannerInterventionSourceLink,
  PlannerOversightStage,
} from "@fusion/core";
import {
  allowsAutoMergeProcessing,
  compareTasksByPriorityThenAgeAndId,
  emitOverseerConfirmation,
  emitOverseerEscalation,
  emitOverseerObservation,
  emitOverseerRecoveryAttempt,
  emitOverseerRetry,
  emitOverseerSteering,
  getTaskHardMergeBlocker,
  isLiveSharedBranchGroupMemberIntegration,
  isSharedBranchGroupMemberIntegration,
  isWorkspaceTask,
  normalizeMergerMode,
  resolveEffectivePlannerOversightLevel,
  resolveEffectiveSettings,
  resolveMaxAutoMergeRetries,
  resolveTaskSessionAdvisorEnabled,
  sortTasksByPriorityThenAgeAndId,
} from "@fusion/core";
import { assemblePlannerOverseerRuntimeSnapshot } from "./planner-overseer-runtime-snapshot.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { InProcessRuntime } from "./runtimes/in-process-runtime.js";
import type { WorktreePool } from "./worktree-pool.js";
import type { ProjectRuntimeConfig } from "./project-runtime.js";
import { PrMonitor } from "./pr-monitor.js";
import { PlannerOverseerMonitor, resolveExecutorStuckAfterMs } from "./planner-overseer.js";
import { PlannerRecoveryController, type PlannerRecoveryHandlers } from "./planner-recovery-controller.js";
import { evaluateOverseerHumanControl } from "./overseer-human-control-policy.js";
import {
  OverseerAdvisorService,
  createParsingOverseerAgent,
} from "./overseer-advisor-service.js";
import { extractAdvisorAssistantText } from "./overseer-advise-tool.js";
import { createResolvedAgentSession } from "./agent-session-helpers.js";
import type { PrNodeGithubOps } from "./pr-nodes.js";
import { PrReconciler, type PrReconcileGithubOps } from "./pr-reconcile.js";
import { PrCommentHandler } from "./pr-comment-handler.js";
import { NtfyNotifier } from "./notifier.js";
import { NotificationService, OAuthAlertStateStore, OAuthExpiryMonitor, OAuthRefreshScheduler, OAuthValidityLogger } from "./notification/index.js";
import type { NotificationChatStore } from "./notification/notification-service.js";
import { GridlockDetector } from "./gridlock-detector.js";
import { createFusionAuthStorage, getFusionOAuthAlertStatePath } from "./auth-storage.js";
import { CronRunner, createAiPromptExecutor } from "./cron-runner.js";
import type { RoutineRunner } from "./routine-runner.js";
import { sweepStaleAutostashes, VerificationError } from "./merger.js";
import { runAiMerge, landWorkspaceTask, WorkspacePartialLandError, WorkspaceRepoLandBusyError } from "./merger-ai.js";
import { promoteBranchGroup, type BranchGroupPromotionResult, type CreateGroupPrFn, type SyncGroupPrFn } from "./group-merge-coordinator.js";
import { PRIORITY_MERGE } from "./concurrency.js";
import { canStartNextMergeBody } from "./merge-reclaim-policy.js";
import {
  registerProjectVerificationLimit,
  unregisterProjectVerificationLimit,
} from "./verification-concurrency.js";
import { runtimeLog } from "./logger.js";
import type { HeartbeatTriggerScheduler } from "./agent-heartbeat.js";
import { ResearchOrchestrator } from "./research-orchestrator.js";
import { ResearchRunDispatcher } from "./research-dispatcher.js";
import { ResearchStepRunner } from "./research-step-runner.js";
import { ResearchProviderRegistry } from "./research/provider-registry.js";
import { createRunAuditor, generateSyntheticRunId } from "./run-audit.js";
import {
  computeVerificationFailureSignature,
  createAutomatedFollowup,
  extractFailingTestFiles,
} from "./verification-followup-dedup.js";
import { finalizeProvenAutoMergeTask } from "./auto-merge-finalization.js";
import { isTransientError } from "./transient-error-detector.js";
import { classifyTransientMergeError } from "./transient-merge-error-classifier.js";
import { TunnelProcessManager } from "./remote-access/tunnel-process-manager.js";
import {
  deliverPostgresMigrationCompleteNoticeIfNeeded,
  deliverPostgresMigrationNoticeIfNeeded,
} from "./postgres-migration-notice.js";
import type {
  ExternalTunnelInfo,
  TunnelProvider,
  TunnelProviderConfig,
  TunnelRestoreDiagnostics,
  TunnelRestoreReasonCode,
  TunnelStatusSnapshot,
} from "./remote-access/types.js";

/**
 * Callback for processing pull-request merge strategy.
 * Injected from the CLI layer since it depends on GitHubClient.
 */
export type ProcessPullRequestMergeFn = (
  store: TaskStore,
  cwd: string,
  taskId: string,
  pool?: WorktreePool,
) => Promise<"merged" | "waiting" | "skipped">;

const execFileAsync = promisify(execFile);

/**
 * Delay between a task moving to in-review and auto-merge being enqueued.
 * Gives the executor's finally block time to complete session disposal,
 * child-agent termination, and any in-flight reviewer teardown so the merger
 * doesn't start emitting logs while the executor is still cleaning up. See
 * FN-2910 for the observed overlap symptom.
 */
const MERGE_HANDOFF_GRACE_MS = 300;

/*
FNXC:MergerUnification 2026-06-21-19:05:
Master-plan U0 made `runAiMerge` the SOLE merge path; `merger.mode` is now inert
(the type/field are retained as published surface — see types.ts MergerMode). When a
project still resolves `merger.mode === "deterministic"` we WARN (never error) once
per project per process and proceed via `runAiMerge` anyway. The warning is keyed by
project root so EACH project with the stale setting warns once — a single module-level
boolean would suppress the warning for all other projects after the first emission.
*/
const deterministicMergerModeDeprecationWarnedProjects = new Set<string>();

/**
 * Test-only: clears the per-project deprecation-warning ledger so a test can assert
 * the warning fires exactly once per project per process. Not used by production code.
 */
export function __resetDeterministicMergerModeDeprecationWarned(): void {
  deterministicMergerModeDeprecationWarnedProjects.clear();
}

interface RemoteLifecycleEvaluation {
  provider: TunnelProvider;
  config?: TunnelProviderConfig;
  reason?: TunnelRestoreReasonCode;
  message?: string;
}

const isRemoteActive = (ra: Settings["remoteAccess"] | undefined): boolean =>
  ra?.activeProvider != null && (ra.providers[ra.activeProvider]?.enabled ?? false);

function formatErrorDetails(error: unknown): { message: string; detail: string } {
  if (error instanceof Error) {
    return {
      message: error.message || error.name,
      detail: error.stack ?? `${error.name}: ${error.message}`,
    };
  }
  const detail = String(error);
  return { message: detail, detail };
}

/*
FNXC:Workspace 2026-06-22-05:10 (Phase C review B6 — unify partial-land retry seam):
The workspace PARTIAL-land retry decision (some sub-repos landed, one failed) is the SAME
arithmetic as the conflict-retry decision MINUS the `autoResolveConflicts` gate (a partial
land is retryable regardless of conflict-resolution settings, because the landed repos'
`landedSha` is persisted and a re-run skips them — U2 idempotency). To keep the
`resolveMaxAutoMergeRetries(settings)` arithmetic in ONE place we collapse the former
`shouldRetryWorkspacePartialLand` into this function via `skipAutoResolveCheck`. When set,
the `autoResolveConflicts` gate is bypassed; otherwise behavior is byte-identical to before.
`currentRetries + 1 < MAX` keeps the LAST attempt's failure parking in the same tick rather
than scheduling an Nth timer that a restart could strand.
*/
export function shouldRetryAutoMergeConflict(
  currentRetries: number,
  settings: { autoResolveConflicts?: boolean; maxAutoMergeRetries?: unknown } | null | undefined,
  opts?: { skipAutoResolveCheck?: boolean },
): { shouldRetry: boolean; maxAutoMergeRetries: number; nextRetryCount: number } {
  const maxAutoMergeRetries = resolveMaxAutoMergeRetries(settings);
  const autoResolveOk = opts?.skipAutoResolveCheck === true || settings?.autoResolveConflicts !== false;
  return {
    shouldRetry: autoResolveOk && currentRetries + 1 < maxAutoMergeRetries,
    maxAutoMergeRetries,
    nextRetryCount: currentRetries + 1,
  };
}

/**
 * FN-5627: Defense-in-depth gate for the auto-merge "merge already confirmed"
 * fast-path. Verifies the task's recorded `mergeDetails.commitSha` is actually
 * reachable from the integration branch tip before promoting in-review → done.
 *
 * Returns:
 *  - { reachable: true } when commitSha is an ancestor of integrationBranch.
 *  - { reachable: false, reason } when it is NOT reachable (the merger poisoned
 *    the row with mergeConfirmed=true before ref-advance succeeded, OR a self-
 *    healing path set the flag prematurely). Caller must refuse the fast-path.
 *  - { reachable: true, skipped: "no-commit-sha" } when commitSha is unset —
 *    legacy/no-op finalize paths and verified-no-op merges legitimately have
 *    no commitSha; the fast-path must remain functional for those.
 */
async function verifyMergeConfirmedReachability(args: {
  commitSha: string | undefined;
  integrationBranch: string | undefined;
  cwd: string;
}): Promise<
  | { reachable: true; skipped?: "no-commit-sha" | "no-integration-branch" }
  | { reachable: false; reason: "not-ancestor" | "commit-missing" | "git-error"; diagnostic: string }
> {
  const { commitSha, integrationBranch, cwd } = args;
  // No commit sha = legitimate no-op/verified-short-circuit/early-recovery case.
  if (!commitSha || !commitSha.trim()) {
    return { reachable: true, skipped: "no-commit-sha" };
  }
  // No integration branch resolvable = degrade safely (caller continues fast-path);
  // this keeps the gate from breaking ancient tasks missing mergeTargetBranch.
  if (!integrationBranch || !integrationBranch.trim()) {
    return { reachable: true, skipped: "no-integration-branch" };
  }
  // Verify the commit exists locally before testing ancestry — git
  // merge-base --is-ancestor returns exit 128 for missing commits, which we
  // want to surface as "commit-missing" rather than "not-ancestor".
  try {
    await execFileAsync("git", ["cat-file", "-e", `${commitSha}^{commit}`], {
      cwd,
      timeout: 10_000,
    });
  } catch (error: unknown) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    return { reachable: false, reason: "commit-missing", diagnostic };
  }
  try {
    await execFileAsync(
      "git",
      ["merge-base", "--is-ancestor", commitSha, `refs/heads/${integrationBranch}`],
      { cwd, timeout: 10_000 },
    );
    return { reachable: true };
  } catch (error: unknown) {
    // Exit code 1 = not an ancestor. Other non-zero = git error.
    const err = error as { code?: number; message?: string };
    const code = typeof err.code === "number" ? err.code : undefined;
    const diagnostic = err.message ?? String(error);
    if (code === 1) {
      return { reachable: false, reason: "not-ancestor", diagnostic };
    }
    return { reachable: false, reason: "git-error", diagnostic };
  }
}

function buildVerificationFailureSignature(error: VerificationError): string {
  const commandResult = error.verificationResult.testResult ?? error.verificationResult.buildResult;
  const lane = commandResult?.command?.trim()
    || error.verificationResult.failedCommand?.trim()
    || "verification-failure";
  const failingTestFiles = commandResult
    ? extractFailingTestFiles(commandResult.stdout, commandResult.stderr)
    : [];
  return computeVerificationFailureSignature({
    lane,
    failingTestFiles,
    failedCommand: commandResult?.command ?? error.verificationResult.failedCommand ?? null,
  }).signature;
}

export interface AutomationSubsystemHealth {
  status: "not-initialized" | "initializing" | "ready" | "degraded";
  message: string;
  updatedAt: string;
}

export interface ProjectEngineOptions {
  /** Project identifier for notification deep links */
  projectId?: string;
  /** Base URL for ntfy.sh notifications */
  ntfyBaseUrl?: string;
  /**
   * FNXC:StorageMigrationNotice 2026-07-12-00:00:
   * The CLI layer injects the resolved published @runfusion/fusion version so startup-only operator notices can be gated to release lines without importing dashboard/CLI code into the engine. When absent or unresolved, the Postgres-migration inbox notice is skipped safely.
   */
  cliPackageVersion?: string;
  /**
   * An already-initialized TaskStore to use instead of creating a new one.
   * When provided, InProcessRuntime will skip TaskStore construction and init().
   * Useful when the caller (e.g. dashboard.ts) owns and watches the store.
   */
  externalTaskStore?: TaskStore;
  /**
   * Returns the merge strategy for the current settings.
   * If not provided, defaults to "direct".
   */
  getMergeStrategy?: (settings: Settings) => "direct" | "pull-request";
  /**
   * Processes a pull-request merge flow. Required when merge strategy
   * can be "pull-request". Injected from CLI layer.
   */
  processPullRequestMerge?: ProcessPullRequestMergeFn;
  /**
   * Creates (or reuses) the single managed GitHub PR for a branch group during
   * promotion (KTD7). Injected from the CLI layer because it depends on the
   * dashboard `GitHubClient`; the engine must not statically import it. Mirrors
   * the `processPullRequestMerge` seam. When absent, PR-mode promotion flips
   * `prState` to "open" without creating a real PR (legacy behaviour).
   */
  createGroupPr?: CreateGroupPrFn;
  /**
   * Pushes an updated body onto the single managed group PR as members land
   * (KTD7, U6). Injected from the CLI layer alongside `createGroupPr`; closes
   * over the dashboard `GitHubClient`. When absent, member landings do not sync
   * the PR body.
   */
  syncGroupPr?: SyncGroupPrFn;
  /**
   * PR-entity node GitHub ops (U3): the injected `createPr`/`mergePr`/`respond`
   * callbacks (+ source resolver + audit) that back the `pr-create`/`pr-respond`/
   * `pr-merge` workflow nodes. Injected from the CLI layer because they close
   * over the dashboard `GitHubClient`; the engine must not statically import it
   * (FN-3049). Mirrors `createGroupPr`/`syncGroupPr`. When absent, the pr-* node
   * kinds fail closed (value:"pr-nodes-unwired").
   */
  prNodeGithubOps?: PrNodeGithubOps;
  /**
   * Node-agnostic GitHub reconcile ops (U4): the injected ETag-probe +
   * deep-fetch callbacks backing {@link PrReconciler}. Injected from the CLI
   * layer for the same FN-3049 reason as {@link prNodeGithubOps}. When present,
   * the runtime layer (this engine, NOT the scheduler) starts a per-repo
   * reconcile that fires the generic external-event hold releases advancing
   * PR-await cards. When absent, no reconcile runs.
   */
  prReconcileGithubOps?: PrReconcileGithubOps;
  /**
   * Returns the merge blocker reason for a task, or null/undefined if
   * the task is eligible for merge. Imported from @fusion/core.
   */
  getTaskMergeBlocker?: (task: Task) => string | null | undefined;
  /**
   * Callback for insight extraction run processing.
   * Invoked after CronRunner completes a memory insight extraction schedule.
   */
  onInsightRunProcessed?: (schedule: unknown, result: unknown) => void | Promise<void>;
  /**
   * Whether to skip starting NtfyNotifier. Useful when the caller manages
   * notifications independently. Defaults to false (notifier is started).
   */
  skipNotifier?: boolean;
}

/**
 * ProjectEngine composes an InProcessRuntime with the higher-level
 * subsystems that were previously wired inline in serve.ts / dashboard.ts:
 *
 * - **Auto-merge queue** — serialized merge with conflict retry, semaphore gating
 * - **PrMonitor + PrCommentHandler** — GitHub PR feedback loop
 * - **NotificationService** — provider-driven push notifications
 * - **CronRunner + AutomationStore** — scheduled automations
 * - **Settings event listeners** — dynamic reconfiguration
 *
 * This ensures every InProcessRuntime (single-project CLI or multi-project
 * via ProjectManager) gets the full subsystem set, eliminating the class of
 * bugs where a subsystem is forgotten in one code path.
 */
type MergeResolver = { resolve: (result: MergeResult) => void; reject: (err: Error) => void };

export class ProjectEngine {
  private runtime: InProcessRuntime;
  private started = false;
  private prMonitor?: PrMonitor;
  /**
   * FNXC:PlannerOversight 2026-07-04-00:00:
   * FN-7511 records-only planner-overseer monitor. Watches in-flight tasks
   * (in-progress/in-review) across the executor/reviewer/merger/pull-request/
   * workflow-gate stages, gated by the task's effective planner oversight
   * level (`resolveEffectivePlannerOversightLevel`). No lifecycle mutation —
   * steering/recovery land in FN-7512+.
   */
  private plannerOverseer?: PlannerOverseerMonitor;
  private plannerOverseerPollTimer: ReturnType<typeof setInterval> | null = null;
  /** Conservative poll cadence for the records-only planner-overseer monitor (45s). */
  private static readonly PLANNER_OVERSEER_POLL_INTERVAL_MS = 45 * 1000;
  /**
   * FNXC:PlannerOversight 2026-07-04-12:00:
   * FN-7512 bounded autonomous-recovery dispatcher. Consumes the FN-7511
   * `plannerOverseer`'s recorded observations and, ONLY when the task's
   * effective planner oversight level resolves to `"autonomous"`, dispatches
   * one bounded action per poll tick (inject guidance / retry the step /
   * request a targeted fix) through handlers wired to the existing
   * steering-comment API and store retry/re-enqueue path. Never merge/PR or
   * destructive actions (FN-7513 owns those); comprehensive human-control
   * safeguards beyond the userPaused skip are FN-7514's responsibility.
   */
  private plannerRecoveryController?: PlannerRecoveryController;
  /*
  FNXC:PlannerOversight 2026-07-13-23:05:
  Session-advisor service (OMP advisor parity). Soft-disabled until workflow
  plannerOverseerAdvisorProvider + plannerOverseerAdvisorModelId are both set.
  */
  private sessionAdvisor?: OverseerAdvisorService;
  /** Per-task agent-log cursor for poll-fed session-advisor deltas. */
  private readonly sessionAdvisorLogCursor = new Map<string, number>();
  /**
   * FNXC:PlannerOversight 2026-07-04-19:45:
   * FN-7551 requirement: real overseer decision points (observation,
   * steering/retry/targeted-fix, confirmation request+resolution, and
   * bounded-recovery escalation) must emit exactly one `overseer:intervention`
   * run-audit entry through the FN-7520 `emitOverseer*` façade with the real
   * `TaskStore`, so the dashboard intervention timeline reflects live engine
   * activity instead of only synthetic unit-test entries. Emission must be
   * deduped so the 45s poll does not flood the timeline: this map tracks the
   * last emitted `"stage:signal"` per taskId for observations, mirroring
   * FN-7514's `lastWithheldReason` dedup pattern. Cleared alongside the
   * monitor/controller ring buffers whenever a task leaves the in-flight set.
   */
  private readonly plannerObservationEmitDedup = new Map<string, string>();
  /**
   * FNXC:PlannerOversight 2026-07-04-19:45:
   * FN-7551: tracks `(taskId, stage)` pairs that have already had a bounded-
   * recovery escalation emitted so a stage that stays exhausted across many
   * subsequent polls emits exactly one `escalate` entry, not one per poll.
   */
  private readonly plannerEscalationEmitDedup = new Set<string>();
  private prReconciler?: PrReconciler;
  private prCommentHandler?: PrCommentHandler;
  private notifier?: NtfyNotifier;
  private notificationService?: NotificationService;
  private oauthExpiryMonitor?: OAuthExpiryMonitor;
  private oauthRefreshScheduler?: OAuthRefreshScheduler;
  private oauthValidityLogger?: OAuthValidityLogger;
  /*
  FNXC:ProviderAuth 2026-07-09-00:00:
  FN-7747: hold the OAuth subsystem's raw createFusionAuthStorage() instance so createServer
  can derive a persistence fallback (see getAuthStorage() below) instead of silently regressing
  the "desktop provider API keys don't persist" bug (#1948) if a host wires this engine but
  forgets to pass its own authStorage.
  */
  private authStorage?: ReturnType<typeof createFusionAuthStorage>;
  private gridlockDetector?: GridlockDetector;
  private cronRunner?: CronRunner;
  private automationStore?: AutomationStoreType;
  private researchOrchestrator?: ResearchOrchestrator;
  private researchDispatcher?: ResearchRunDispatcher;
  private remoteTunnelManager?: TunnelProcessManager;
  private remoteTunnelRestoreDiagnostics: TunnelRestoreDiagnostics = {
    outcome: "skipped",
    reason: "not_attempted",
    at: new Date().toISOString(),
    provider: null,
  };
  private automationSubsystemHealth: AutomationSubsystemHealth = {
    status: "not-initialized",
    message: "Automation subsystem has not been initialized",
    updatedAt: new Date().toISOString(),
  };

  // ── Auto-merge state ──
  private mergeQueue: string[] = [];
  private mergeActive = new Set<string>();
  private pausedReviewTaskIds = new Set<string>();
  private mergeRunning = false;
  private activeMergeSession: { dispose: () => void } | null = null;
  private activeMergeTaskId: string | null = null;
  /** Wall-clock when `activeMergeTaskId` was claimed; self-healing uses this when agent logs are silent. */
  private activeMergeStartedAtMs: number | null = null;
  /*
  FNXC:MergeQueue 2026-07-15-10:05:
  Tracks the underlying merge body promise (not the abort race). After force-abort the race rejects so drain can continue, but the orphan body may still be mid-tool. The next claim waits for this latch so two runAiMerge/land paths cannot advance main concurrently.
  */
  private mergeBodyInFlight: Promise<unknown> | null = null;
  private mergeAbortController: AbortController | null = null;
  private mergeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private autostashSweepTimer: ReturnType<typeof setTimeout> | null = null;
  private mergeActiveReconcileTimer: ReturnType<typeof setInterval> | null = null;

  /*
  FNXC:Workspace 2026-06-22-05:10 (Phase C review B4 — separate busy-retry quota):
  Transient sub-repo land-lease contention (WorkspaceRepoLandBusyError) must NOT burn the
  persisted `mergeRetries` quota — two tasks contending for the same sub-repo could otherwise
  exhaust all retries on pure busy-errors before a single real land attempt, then park a
  never-failed task. We track busy re-enqueues in this in-memory, per-task counter (transient
  contention need not survive a restart) and CAP it separately from `mergeRetries`. A real
  partial land (WorkspacePartialLandError) still consumes `mergeRetries` up to MAX, then parks.
  Cleared on the first non-busy outcome (success path resets it).
  */
  private workspaceBusyReenqueues = new Map<string, number>();
  private static readonly WORKSPACE_BUSY_MAX_REENQUEUES = 10;

  /**
   * Pending manual merge resolvers — keyed by taskId.
   * When `onMerge` is called, the task is enqueued like auto-merge but a
   * Promise is stored here so the caller can await the result.
   */
  // Per-task LIST of waiters, not a single resolver: both the dashboard "merge
  // now" path and the workflow interpreter's merge seam call onMerge, so a task
  // can have more than one caller awaiting the same merge. A single-entry map
  // would let a second caller overwrite the first, stranding its promise.
  private manualMergeResolvers = new Map<string, Array<MergeResolver>>();
  private shuttingDown = false;
  /**
   * FNXC:FasterStartup 2026-07-15-00:20:
   * stop() clears shuttingDown so the engine can restart, which would otherwise
   * let in-flight deferred startup work resume after stop. Bump this generation
   * on stop (and capture it when scheduling deferred work) so post-stop tails abort.
   */
  private startupGeneration = 0;

  private addMergeResolver(taskId: string, r: MergeResolver): void {
    const list = this.manualMergeResolvers.get(taskId);
    if (list) list.push(r);
    else this.manualMergeResolvers.set(taskId, [r]);
  }

  private removeMergeResolver(taskId: string, resolver: MergeResolver): void {
    const list = this.manualMergeResolvers.get(taskId);
    if (!list) return;
    const next = list.filter((candidate) => candidate !== resolver);
    if (next.length > 0) this.manualMergeResolvers.set(taskId, next);
    else this.manualMergeResolvers.delete(taskId);
  }

  /** Remove and return all waiters for a task (empty array if none). */
  private takeMergeResolvers(taskId: string): MergeResolver[] {
    const list = this.manualMergeResolvers.get(taskId);
    this.manualMergeResolvers.delete(taskId);
    return list ?? [];
  }

  private hasMergeResolvers(taskId: string): boolean {
    return (this.manualMergeResolvers.get(taskId)?.length ?? 0) > 0;
  }

  /** Resolve every waiter for a task with the same result, then clear them. */
  private resolveMergeResolvers(taskId: string, result: MergeResult): void {
    for (const r of this.takeMergeResolvers(taskId)) r.resolve(result);
  }

  /** Reject every waiter for a task with the same error, then clear them. */
  private rejectMergeResolvers(taskId: string, err: Error): void {
    for (const r of this.takeMergeResolvers(taskId)) r.reject(err);
  }

  /** FN-5697/FN-5674: cap transient provider/network abort retries in auto-merge.
   *  Examples: "This operation was aborted", "socket hang up", `server_error`.
   *  After this cap, the task is parked failed for human visibility. */
  private static readonly MAX_AUTO_MERGE_TRANSIENT_RETRIES = 3;
  private static readonly MERGE_REQUEST_RETRY_EXHAUSTED_AGE_MS = 30 * 60 * 1000;
  /** Cap on outer in-review→in-progress bounces caused by deterministic
   *  verification failures during auto-merge. After this many failed merges
   *  for the same task, we stop bouncing it back, mark it failed, and create
   *  a follow-up triage task so a fresh agent (or human) can investigate
   *  the underlying flake/regression instead of looping forever. */
  private static readonly MAX_VERIFICATION_FAILURE_BOUNCES = 3;
  /** Cap on outer in-review→in-progress bounces caused by auto-merge conflict
   *  retries being exhausted. After this many bounces the task is parked in
   *  in-review with status=failed and a follow-up task is created, so the
   *  30-minute cooldown sweep cannot loop forever on a merge that requires
   *  human intervention. */
  private static readonly MAX_MERGE_CONFLICT_BOUNCES = 2;
  /** 30-minute cooldown before a retry-exhausted task gets another sweep attempt */
  private static readonly AUTO_MERGE_COOLDOWN_MS = 30 * 60 * 1000;

  // Event handler references for cleanup
  private settingsHandlers: Array<(...args: any[]) => void> = [];
  private taskMovedHandler?: (...args: any[]) => void;
  private taskUpdatedHandler?: (...args: any[]) => void;
  private taskDeletedHandler?: (...args: any[]) => void;
  private autostashOrphansHandler?: (...args: any[]) => void;
  private legacyAutoMergeStampAdvisoryEmitted = false;

  constructor(
    private config: ProjectRuntimeConfig,
    centralCore: CentralCore,
    private options: ProjectEngineOptions = {},
  ) {
    // Pass through externalTaskStore + PR node GitHub ops (U3) to the runtime
    // config. The runtime binds the engine-owned store and hands the assembled
    // PrNodeDeps to the executor's workflow-graph runner.
    const runtimeConfig: ProjectRuntimeConfig = {
      ...config,
      ...(options.externalTaskStore ? { externalTaskStore: options.externalTaskStore } : {}),
      ...(options.prNodeGithubOps ? { prNodeGithubOps: options.prNodeGithubOps } : {}),
    };
    this.runtime = new InProcessRuntime(runtimeConfig, centralCore);
    // Let the runtime's SelfHealingManager re-enqueue tasks directly into our
    // auto-merge queue when it clears a stale `merging` status, instead of
    // relying on the 15s polling sweep to eventually catch them.
    //
    // Critically: clear the in-memory `mergeActive` entry before re-enqueueing.
    // A stale-merge recovery means the prior merge attempt is dead — but its
    // `try/finally` may never have fired (e.g. an AI provider call is wedged
    // mid-await), so the entry is still in `mergeActive` and would otherwise
    // cause `internalEnqueueMerge` to silently no-op.
    //
    // Tests substitute a minimal runtime mock that may not implement this hook.
    this.runtime.setActiveMergeTaskIdProvider?.(() => this.getActiveMergeTaskId());
    this.runtime.setActiveMergeStartedAtMsProvider?.(() => this.activeMergeStartedAtMs);
    this.runtime.setActiveMergeAborter?.((taskId, reason) => this.abortActiveMerge(taskId, reason));
    this.runtime.setMergeEnqueuer?.((taskId) => {
      // If the wedged attempt was the active one, abort its in-flight signal
      // and dispose its session so subsequent code paths can release file
      // handles / child processes promptly.
      if (this.activeMergeTaskId === taskId) {
        this.abortActiveMerge(taskId, "merge-enqueuer-reclaim");
      }
      this.mergeActive.delete(taskId);
      return this.internalEnqueueMerge(taskId);
    });
    this.runtime.setMergeActiveClearer?.((taskId) => {
      this.mergeActive.delete(taskId);
    });
    // FNXC:Workspace 2026-06-22-16:40 (Phase D P1 TOCTOU): expose the in-memory merge pipeline
    // (mergeQueue + mergeActive) to the workspace self-healing reconcilers so they don't
    // re-dispatch / reclaim a task that is mid-dequeue→rawMerge.
    this.runtime.setMergePendingProvider?.((taskId) => this.isMergePending(taskId));
    // Workflow-graph interpreter merge seam: routes through the auto-merge
    // eligibility gate (requestInterpreterMerge), NOT the human "merge now"
    // bypass, so a graph merge node can't override an autoMerge-off project.
    this.runtime.setMergeRequester?.((taskId, options) => this.requestInterpreterMerge(taskId, options));
  }

  getActiveMergeTaskId(): string | null {
    return this.activeMergeTaskId;
  }

  getActiveMergeStartedAtMs(): number | null {
    return this.activeMergeStartedAtMs;
  }

  /*
  FNXC:MergeQueue 2026-07-15-09:50:
  Self-healing reclaim path for a wedged single-flight merge. Always abort + dispose + clear identity so raceMergeWithAbort can settle drainMergeQueue even when the agent ignores cooperative abort.
  */
  abortActiveMerge(taskId: string, reason: string): boolean {
    if (this.activeMergeTaskId !== taskId) return false;
    runtimeLog.log(`Aborting active merge for ${taskId} (${reason})`);
    this.mergeAbortController?.abort();
    this.mergeAbortController = null;
    if (this.activeMergeSession) {
      this.activeMergeSession.dispose();
      this.activeMergeSession = null;
    }
    this.mergeActive.delete(taskId);
    this.activeMergeTaskId = null;
    this.activeMergeStartedAtMs = null;
    return true;
  }

  private claimActiveMerge(taskId: string): AbortSignal {
    this.activeMergeTaskId = taskId;
    this.activeMergeStartedAtMs = Date.now();
    this.mergeAbortController = new AbortController();
    return this.mergeAbortController.signal;
  }

  private clearActiveMergeClaim(taskId: string): void {
    if (this.activeMergeTaskId === taskId) {
      this.activeMergeTaskId = null;
      this.activeMergeStartedAtMs = null;
    }
  }

  /*
  FNXC:MergeQueue 2026-07-15-10:05:
  Bound how long drain waits for an orphan body after abort. If the agent ignores abort forever, a hard settle timeout releases the latch so the board does not stay permanently blocked — last-resort only; prefer clean body settle. Overridable in tests via mergeBodySettleTimeoutMs.
  */
  private mergeBodySettleTimeoutMs = 60_000;

  private trackMergeBody<T>(body: Promise<T>): Promise<T> {
    const tracked = body.finally(() => {
      if (this.mergeBodyInFlight === tracked) {
        this.mergeBodyInFlight = null;
      }
    });
    this.mergeBodyInFlight = tracked;
    return tracked;
  }

  private async awaitPriorMergeBodySettle(): Promise<void> {
    const prior = this.mergeBodyInFlight;
    if (canStartNextMergeBody(prior)) return;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = this.mergeBodySettleTimeoutMs;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
      timeoutHandle.unref?.();
    });
    try {
      const winner = await Promise.race([
        prior!.then(() => "settled" as const).catch(() => "settled" as const),
        timeout,
      ]);
      if (winner === "timeout") {
        runtimeLog.warn(
          `Prior merge body did not settle within ${timeoutMs}ms after abort — releasing latch for next generation`,
        );
        if (this.mergeBodyInFlight === prior) {
          this.mergeBodyInFlight = null;
        }
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  /**
   * Race a merge body with abort, while tracking the underlying body so the next
   * generation cannot start until the orphan work settles.
   */
  private runAbortableMergeBody<T>(bodyFactory: () => Promise<T>, signal: AbortSignal, taskId: string): Promise<T> {
    const body = this.trackMergeBody(bodyFactory());
    return this.raceMergeWithAbort(body, signal, taskId);
  }

  /*
  FNXC:Workspace 2026-06-22-16:40 (Phase D P1 TOCTOU — merge-queue dispatch blind spot):
  A workspace task is "merge-pending" if it sits ANYWHERE in this engine's in-memory merge
  pipeline: still queued in `mergeQueue`, OR already dequeued-and-dispatching / actively merging
  (tracked by `mergeActive`). `mergeActive.add(taskId)` happens at enqueue time and is only removed
  when the merge fully settles (try/finally, stale-merge recovery, or stop()), so it — unlike the
  liveness signals the workspace reconcilers consult (session registry, executingTaskLock,
  isTaskActive, getActiveMergeTaskId, setStatus("merging"), the workspace-repo-land lease) — covers
  the WHOLE dequeue→rawMerge window. In that window `pickNextMergeTaskId` has shifted the id out of
  `mergeQueue` but `activeMergeTaskId` / `merging` status / the land lease are not yet set (they fire
  later inside the post-semaphore `landWorkspaceTask`). The workspace self-healing reconcilers
  (reconcileWorkspacePartialLands / reclaimPhantomWorkspaceLandLeases) call this as a guard so they
  never re-dispatch (double-squash) or reclaim the not-yet-registered land lease of a task that is
  legitimately mid-dispatch. Because `mergeActive` lingers across the entire dequeue→rawMerge
  window, checking it in addition to `mergeQueue` closes that TOCTOU gap.
  */
  isMergePending(taskId: string): boolean {
    return this.mergeActive.has(taskId) || this.mergeQueue.includes(taskId);
  }

  /**
   * Start the engine: initialize the runtime and all auxiliary subsystems.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    // 1. Start the core runtime (TaskStore, Scheduler, Executor, Triage, etc.)
    await this.runtime.start();

    await deliverPostgresMigrationNoticeIfNeeded({
      messageStore: this.runtime.getMessageStore(),
      version: this.options.cliPackageVersion,
      log: runtimeLog,
    });

    const store = this.runtime.getTaskStore();
    const cwd = this.config.workingDirectory;
    const settings = await store.getSettings();
    const migrationNotice = settings.sqliteMigrationNotice;
    void deliverPostgresMigrationCompleteNoticeIfNeeded({
      messageStore: this.runtime.getMessageStore(),
      notice: migrationNotice,
      projectId: this.config.projectId,
      deliveredAt: settings.postgresMigrationInboxMessageSentAt,
      markDelivered: migrationNotice
        ? async (inboxMessageSentAt) => {
            await store.updateSettings({ postgresMigrationInboxMessageSentAt: inboxMessageSentAt });
          }
        : undefined,
      log: runtimeLog,
    });

    /*
     * FNXC:BackendFlip 2026-06-26-15:30:
     * Wrap the research subsystem init in try/catch so the engine degrades
     * gracefully (no research dispatcher) if getResearchStore() genuinely fails,
     * instead of failing the whole engine start — the same pattern used for
     * MissionStore in InProcessRuntime.start(). Keeps `fn serve` / boot smoke
     * booting even when the research store is unavailable.
     *
     * FNXC:ResearchStore 2026-06-28-11:30:
     * Research run EXECUTION now runs in BOTH backends. getResearchStore() returns
     * the sync EventEmitter ResearchStore (SQLite) or the PG-backed AsyncResearchStore;
     * the orchestrator/dispatcher take the `ResearchStore | AsyncResearchStore` union
     * and await every store call, so a queued run advances queued→running→
     * completed/failed and persists in PG mode. The prior instanceof gate that
     * disabled the orchestrator in PG mode is removed.
     */
    if (typeof (store as { getResearchStore?: () => unknown }).getResearchStore === "function") {
      try {
        const researchStore = store.getResearchStore();
        const registry = new ResearchProviderRegistry(settings, cwd);
        const providers = registry.getAvailableProviders()
          .map((type) => registry.getProvider(type))
          .filter((provider): provider is NonNullable<typeof provider> => Boolean(provider));
        const synthesisProvider = registry.getProvider("llm-synthesis") as ({
          synthesize?: (
            request: ResearchSynthesisRequest,
            modelSelection: { provider?: string; modelId?: string },
            signal?: AbortSignal,
          ) => Promise<ResearchSynthesisResult>;
        } | undefined);
        const synthesisRunner = typeof synthesisProvider?.synthesize === "function"
          ? (request: ResearchSynthesisRequest, _modelSettings: ResearchModelSettings, signal?: AbortSignal) => synthesisProvider.synthesize!(request, {
            provider: settings.researchGlobalDefaults?.synthesisProvider ?? settings.defaultProvider,
            modelId: settings.researchGlobalDefaults?.synthesisModelId ?? settings.defaultModelId,
          }, signal)
          : undefined;
        this.researchOrchestrator = new ResearchOrchestrator({
          store: researchStore,
          stepRunner: new ResearchStepRunner({ providers, synthesisRunner }),
          maxConcurrentRuns: settings.researchMaxConcurrentRuns ?? 3,
        });
        this.researchDispatcher = new ResearchRunDispatcher({
          store: researchStore,
          orchestrator: this.researchOrchestrator,
        });
        this.researchDispatcher.start();
      } catch (rsErr) {
        runtimeLog.warn(
          `Research subsystem unavailable (${
            store.isBackendMode?.() ? "backend mode" : "init error"
          }); research dispatcher disabled:`,
          rsErr instanceof Error ? rsErr.message : rsErr,
        );
      }
    }

    this.remoteTunnelManager = new TunnelProcessManager();
    try {
      await this.restoreRemoteTunnelIfNeeded(store);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setRestoreDiagnostics("failed", "restore_start_failed", null, message);
      runtimeLog.warn(`Remote tunnel restore evaluation failed (continuing startup): ${message}`);
    }

    // FN-7511: Initialize the records-only planner-overseer monitor and start
    // its bounded, gated poll over in-flight tasks.
    this.plannerOverseer = new PlannerOverseerMonitor({
      store,
      // FN-7551: emit one deduped `overseer:intervention` observation entry
      // through the FN-7520 façade for each real observation the monitor
      // records, using the real TaskStore. Best-effort — never throws (the
      // monitor already swallows callback errors around `onObservation`).
      onObservation: (observation) => {
        this.emitOverseerObservationDeduped(store, observation);
      },
    });
    // FN-7512: bounded autonomous-recovery dispatcher, wired to the existing
    // steering-comment API + store retry/re-enqueue path only — no new
    // session/tool/merge channel. Ticked from the same poll as the FN-7511
    // observer, guarded to the "autonomous" effective level there.
    this.plannerRecoveryController = new PlannerRecoveryController({
      snapshotProvider: this.plannerOverseer,
      handlers: this.buildPlannerRecoveryHandlers(store),
    });
    // FNXC:PlannerOversight 2026-07-13-23:05: session advisor (transcript review) alongside lifecycle supervisor.
    this.sessionAdvisor = this.buildSessionAdvisorService(store);
    try {
      this.runtime.getExecutor?.()?.setOnExecutorLogFlushed?.((taskId, entries) => {
        this.notifySessionAdvisorLogDelta(taskId, entries);
      });
    } catch {
      /* executor may not expose the setter on older shims */
    }
    this.startPlannerOverseerPoll(store);

    // 2. Initialize PrMonitor + PrCommentHandler
    this.prMonitor = new PrMonitor();
    this.prCommentHandler = new PrCommentHandler(store);
    this.prMonitor.onNewComments((taskId, prInfo, comments) =>
      this.prCommentHandler!.handleNewComments(taskId, prInfo, comments),
    );
    this.runtime.configurePrMonitoring({
      prMonitor: this.prMonitor,
      onClosedPrFeedback: (taskId, prInfo, comments) =>
        this.prCommentHandler!.createFollowUpTask(taskId, prInfo, comments),
    });

    // 2b. Node-agnostic GitHub reconcile (U4). Started HERE in the runtime layer,
    // NOT in scheduler.ts (R20 invariant: the scheduler stays PR-ignorant). The
    // reconciler keys on active PR entities, fires generic external-event hold
    // releases, and persists audit on error. Only runs when the CLI injected the
    // probe/deep-fetch ops.
    if (this.options.prReconcileGithubOps) {
      this.prReconciler = new PrReconciler({
        store,
        ops: this.options.prReconcileGithubOps,
      });
      this.prReconciler.start();
    }

    /*
    FNXC:FasterStartup 2026-07-14-23:55:
    Route-critical path constructs AutomationStore/CronRunner and wires merge
    listeners so createServer closures bind real subsystems. Notifiers, OAuth
    (refresh-before-monitor order preserved), automation schedule syncs, and
    startupMergeSweep run in the background so ensureEngine returns sooner.
    Do not reintroduce a timed race that hands createServer an undefined engine.
    */
    const engineStartT0 = Date.now();

    // 3. Construct notification services (start deferred — see startDeferredStartupWork)
    let deferredAgentNameResolver: ((agentId: string) => Promise<string | null>) | undefined;
    if (!this.options.skipNotifier) {
      const agentStore = this.runtime.getAgentStore();
      deferredAgentNameResolver = agentStore
        ? async (agentId: string): Promise<string | null> => {
          const agent = await agentStore.getAgent(agentId);
          const name = typeof agent?.name === "string" ? agent.name.trim() : "";
          return name.length > 0 ? name : null;
        }
        : undefined;

      this.notificationService = new NotificationService(store, {
        projectId: this.options.projectId,
        ntfyBaseUrl: this.options.ntfyBaseUrl,
        messageStore: this.runtime.getMessageStore(),
        agentNameResolver: deferredAgentNameResolver,
      });
      const authStorage = createFusionAuthStorage();
      this.authStorage = authStorage;
      // Backward-compatibility shim for gridlock notifications (started in deferred work).
      this.notifier = new NtfyNotifier(
        store,
        {
          projectId: this.options.projectId,
          ntfyBaseUrl: this.options.ntfyBaseUrl,
          agentNameResolver: deferredAgentNameResolver,
        },
        this.notificationService,
      );
    }

    this.gridlockDetector = new GridlockDetector(store, {
      onGridlock: (event) => this.notifier?.notifyGridlock(event),
      onGridlockCleared: () => this.notifier?.notifyGridlock(null),
    });
    this.gridlockDetector.start();

    // 4. Initialize AutomationStore + CronRunner (syncs deferred)
    this.setAutomationSubsystemHealth(
      "initializing",
      "Initializing AutomationStore and CronRunner",
    );
    let coreAutomationModule: typeof import("@fusion/core") | undefined;
    try {
      coreAutomationModule = await import("@fusion/core");
      const { AutomationStore } = coreAutomationModule;
      // FNXC:PhysicalDeleteSqliteClass 2026-06-26-14:05:
      // Propagate the backend mode (asyncLayer) from the owning TaskStore so
      // AutomationStore does not construct a SQLite file under PostgreSQL. The
      // `?? undefined` coerces the `AsyncDataLayer | null` to the optional
      // option shape (null would be a type error; undefined = "not provided").
      const automationLayer = store.getAsyncLayer();
      if (!automationLayer) throw new Error("ProjectEngine AutomationStore requires the project PostgreSQL AsyncDataLayer");
      /* FNXC:PostgresSatelliteCutover 2026-07-14-17:30: Engine automation schedules share the authoritative project PostgreSQL layer. */
      this.automationStore = new AutomationStore(cwd, { asyncLayer: automationLayer });
      await this.automationStore.init();

      const aiPromptExecutor = await createAiPromptExecutor(cwd, store);
      this.cronRunner = new CronRunner(store, this.automationStore, {
        aiPromptExecutor,
        onScheduleRunProcessed: this.buildInsightRunHandler(cwd),
        workingDirectory: cwd,
        projectId: this.config.projectId,
        scope: "project", // Project-scoped execution — global schedules run separately
      });

      this.cronRunner.start();
      this.setAutomationSubsystemHealth(
        "ready",
        "CronRunner started; automation schedule sync continues in background",
      );
      runtimeLog.log("CronRunner initialized and started");
    } catch (err) {
      // Non-fatal — automations are optional
      const { message, detail } = formatErrorDetails(err);
      this.cronRunner = undefined;
      this.automationStore = undefined;
      this.setAutomationSubsystemHealth(
        "degraded",
        `AutomationStore/CronRunner initialization failed: ${message}`,
      );
      runtimeLog.error(
        `AutomationStore/CronRunner initialization failed (continuing without automations):\n${detail}`,
      );
    }

    // 5. Wire settings event listeners
    this.wireSettingsListeners(store);
    /*
    FNXC:VerificationConcurrency 2026-07-15-08:20:
    Apply maxConcurrentVerifications once at start (and on settings:updated) so verification
    slots do not re-race last-writer-wins on every fn_run_verification / merge command.

    FNXC:VerificationConcurrency 2026-07-15-09:05:
    Register per-project so multi-engine hosts take the MIN of all caps (most restrictive wins).
    */
    registerProjectVerificationLimit(this.config.projectId, settings.maxConcurrentVerifications ?? 1);

    // 6. Wire auto-merge on task:moved and task:updated pause interruptions
    this.wireAutoMerge(store, cwd);
    this.wireTaskPauseMergeInterruption(store);
    this.wireAutostashOrphanRecovery(store);

    /*
    FNXC:FasterStartup 2026-07-15-00:20:
    Clear crash-leftover merging/merging-pr statuses on the critical path so
    manual merge is not blocked while deferred work finishes. Auto-merge enqueue
    stays deferred (pause-aware) after the engine handle is returnable.
    */
    const statusClearT0 = Date.now();
    await this.clearStaleMergingStatuses(store);
    runtimeLog.log(`ProjectEngine stale merging status clear: ${Date.now() - statusClearT0}ms`);

    // 7–9. Deferred: notifiers/OAuth (ordered), automation syncs, merge enqueue
    const deferredGeneration = this.startupGeneration;
    void this.startDeferredStartupWork(store, coreAutomationModule, deferredGeneration).catch((err) => {
      if (this.shuttingDown || this.startupGeneration !== deferredGeneration) return;
      const message = err instanceof Error ? err.message : String(err);
      runtimeLog.error(`Deferred ProjectEngine startup work failed: ${message}`);
    });

    // 8. Start periodic merge retry sweep (does not require merge enqueue to have finished)
    this.scheduleMergeRetry(store);
    this.scheduleMergeActiveReconciliation(settings.maintenanceIntervalMs ?? 900_000);

    // 9. Startup + periodic stale autostash sweeps (independent of autoMerge)
    void this.runStaleAutostashSweep(store, "startup");
    this.scheduleStaleAutostashSweep(store);

    this.started = true;
    runtimeLog.log(
      `ProjectEngine started for ${this.config.projectId} (critical path ${Date.now() - engineStartT0}ms; deferred work in background)`,
    );
  }

  /**
   * Non-route-critical startup work. Runs after the engine handle is returnable.
   * OAuth refresh must still complete before the expiry monitor's first check.
   * Aborts cleanly when stop() sets shuttingDown.
   */
  private deferredStartupAborted(generation: number): boolean {
    return this.shuttingDown || this.startupGeneration !== generation;
  }

  private async startDeferredStartupWork(
    store: TaskStore,
    coreAutomationModule: typeof import("@fusion/core") | undefined,
    generation: number,
  ): Promise<void> {
    if (this.deferredStartupAborted(generation)) return;
    const t0 = Date.now();

    if (!this.options.skipNotifier && this.notificationService && this.authStorage) {
      const notifiersT0 = Date.now();
      await this.notificationService.start();
      if (this.deferredStartupAborted(generation)) return;
      const oauthAlertState = new OAuthAlertStateStore({
        statePath: getFusionOAuthAlertStatePath(),
      });
      /*
      FNXC:ClaudeOAuth 2026-07-05-00:00 / 2026-07-08-12:10 / FNXC:FasterStartup 2026-07-14-23:55:
      FN-7574: proactively refresh OAuth before expiry. Refresh scheduler still
      starts BEFORE OAuthExpiryMonitor so a stale-but-refreshable token does not
      fire a false "OAuth token expired" ntfy on restart. Only the await moved
      off the ensureEngine critical path — relative order is unchanged.
      */
      this.oauthRefreshScheduler = new OAuthRefreshScheduler({ authStorage: this.authStorage });
      await this.oauthRefreshScheduler.start();
      if (this.deferredStartupAborted(generation)) return;
      this.oauthExpiryMonitor = new OAuthExpiryMonitor({
        authStorage: this.authStorage,
        notificationService: this.notificationService,
        alertState: oauthAlertState,
      });
      await this.oauthExpiryMonitor.start();
      if (this.deferredStartupAborted(generation)) return;
      this.oauthValidityLogger = new OAuthValidityLogger({
        authStorage: this.authStorage,
        alertState: oauthAlertState,
      });
      await this.oauthValidityLogger.start();
      if (this.deferredStartupAborted(generation)) return;
      if (this.notifier) {
        await this.notifier.start();
      }
      runtimeLog.log(`ProjectEngine deferred notifiers+oauth: ${Date.now() - notifiersT0}ms`);
    }

    if (this.deferredStartupAborted(generation)) return;

    if (this.automationStore && coreAutomationModule) {
      const syncT0 = Date.now();
      const settings = await store.getSettings();
      if (this.deferredStartupAborted(generation)) return;
      const startupSyncFailures: string[] = [];

      if (typeof coreAutomationModule.syncInsightExtractionAutomation === "function") {
        try {
          await coreAutomationModule.syncInsightExtractionAutomation(this.automationStore, settings);
        } catch (err) {
          const { message, detail } = formatErrorDetails(err);
          startupSyncFailures.push(`insight extraction: ${message}`);
          runtimeLog.warn(`Insight extraction automation startup sync failed:\n${detail}`);
        }
      } else {
        runtimeLog.warn("syncInsightExtractionAutomation is unavailable; skipping startup sync");
      }

      if (this.deferredStartupAborted(generation)) return;

      if (typeof coreAutomationModule.syncAutoSummarizeAutomation === "function") {
        try {
          await coreAutomationModule.syncAutoSummarizeAutomation(this.automationStore, settings);
        } catch (err) {
          const { message, detail } = formatErrorDetails(err);
          startupSyncFailures.push(`auto-summarize: ${message}`);
          runtimeLog.warn(`Auto-summarize automation startup sync failed:\n${detail}`);
        }
      } else {
        runtimeLog.warn("syncAutoSummarizeAutomation is unavailable; skipping startup sync");
      }

      if (this.deferredStartupAborted(generation)) return;

      if (typeof coreAutomationModule.syncMemoryDreamsAutomation === "function") {
        try {
          await coreAutomationModule.syncMemoryDreamsAutomation(this.automationStore, settings);
        } catch (err) {
          const { message, detail } = formatErrorDetails(err);
          startupSyncFailures.push(`memory dreams: ${message}`);
          runtimeLog.warn(`Memory dreams automation startup sync failed:\n${detail}`);
        }
      } else {
        runtimeLog.warn("syncMemoryDreamsAutomation is unavailable; skipping startup sync");
      }

      if (this.deferredStartupAborted(generation)) return;

      if (typeof coreAutomationModule.syncScheduledEvalBatchAutomation === "function") {
        try {
          await coreAutomationModule.syncScheduledEvalBatchAutomation(this.automationStore, settings);
        } catch (err) {
          const { message, detail } = formatErrorDetails(err);
          startupSyncFailures.push(`scheduled eval: ${message}`);
          runtimeLog.warn(`Scheduled eval automation startup sync failed:\n${detail}`);
        }
      } else {
        runtimeLog.warn("syncScheduledEvalBatchAutomation is unavailable; skipping startup sync");
      }

      if (startupSyncFailures.length > 0) {
        this.setAutomationSubsystemHealth(
          "degraded",
          `CronRunner started with startup sync warnings: ${startupSyncFailures.join("; ")}`,
        );
      } else {
        this.setAutomationSubsystemHealth(
          "ready",
          "CronRunner initialized and startup automation sync completed",
        );
      }
      runtimeLog.log(`ProjectEngine deferred automation syncs: ${Date.now() - syncT0}ms`);
    }

    if (this.deferredStartupAborted(generation)) return;

    const mergeT0 = Date.now();
    await this.startupMergeEnqueue(store);
    if (this.deferredStartupAborted(generation)) return;
    runtimeLog.log(
      `ProjectEngine deferred mergeEnqueue: ${Date.now() - mergeT0}ms (total deferred ${Date.now() - t0}ms)`,
    );
  }

  /**
   * Gracefully stop the engine and all subsystems.
   *
   * If a merge is currently running, its abort signal is triggered before the
   * active merge session is disposed so merge pipeline checkpoints can exit
   * promptly without continuing git/verification work after shutdown starts.
   */
  async stop(): Promise<void> {
    /*
    FNXC:FasterStartup 2026-07-15-00:20:
    Always raise shuttingDown first so deferred startup work (OAuth, automation
    sync, merge enqueue) observes the flag even if start() has not flipped
    started yet — prevents unhandled post-stop side effects on fast recycle.
    */
    this.shuttingDown = true;
    this.startupGeneration += 1;
    if (!this.started) {
      return;
    }

    // FNXC:VerificationConcurrency 2026-07-15-09:05: Drop this project's cap so it no longer pins process min.
    unregisterProjectVerificationLimit(this.config.projectId);
    // Stop merge retry timer
    if (this.mergeRetryTimer) {
      clearTimeout(this.mergeRetryTimer);
      this.mergeRetryTimer = null;
    }
    if (this.autostashSweepTimer) {
      clearTimeout(this.autostashSweepTimer);
      this.autostashSweepTimer = null;
    }
    if (this.mergeActiveReconcileTimer) {
      clearInterval(this.mergeActiveReconcileTimer);
      this.mergeActiveReconcileTimer = null;
    }
    this.stopPlannerOverseerPoll();

    // Abort active/pending merge work before tearing down sessions.
    this.mergeAbortController?.abort();
    this.mergeAbortController = null;
    this.activeMergeTaskId = null;
    this.activeMergeStartedAtMs = null;
    this.mergeBodyInFlight = null;
    this.pausedReviewTaskIds.clear();

    const queuedTaskIds = [...this.mergeQueue];
    this.mergeQueue.length = 0;
    for (const queuedTaskId of queuedTaskIds) {
      this.mergeActive.delete(queuedTaskId);
    }

    // Terminate active merge session
    if (this.activeMergeSession) {
      this.activeMergeSession.dispose();
      this.activeMergeSession = null;
    }

    // Reject any pending manual merge promises (every waiter per task)
    for (const [taskId, resolvers] of this.manualMergeResolvers) {
      for (const resolver of resolvers) {
        resolver.reject(new Error(`Engine shutting down — merge for ${taskId} aborted`));
      }
    }
    this.manualMergeResolvers.clear();

    // Remove event listeners
    try {
      const store = this.runtime.getTaskStore();
      for (const handler of this.settingsHandlers) {
        store.off("settings:updated", handler);
      }
      if (this.taskMovedHandler) {
        store.off("task:moved", this.taskMovedHandler);
      }
      if (this.taskUpdatedHandler) {
        store.off("task:updated", this.taskUpdatedHandler);
      }
      if (this.taskDeletedHandler) {
        store.off("task:deleted", this.taskDeletedHandler);
      }
      if (this.autostashOrphansHandler) {
        store.off("merger:autostashOrphans", this.autostashOrphansHandler as any);
      }
    } catch {
      // Store may not be initialized if start() failed partway
    }

    // Stop auxiliary subsystems
    this.prReconciler?.stopAll();
    this.prReconciler = undefined;
    this.oauthExpiryMonitor?.stop();
    this.oauthRefreshScheduler?.stop();
    this.oauthValidityLogger?.stop();
    this.notificationService?.stop();
    this.notifier?.stop();
    this.gridlockDetector?.stop();
    this.cronRunner?.stop();
    this.setAutomationSubsystemHealth("not-initialized", "Automation subsystem stopped");
    await this.researchDispatcher?.stop();
    this.researchDispatcher = undefined;
    this.researchOrchestrator = undefined;

    const tunnelManager = this.remoteTunnelManager;
    this.remoteTunnelManager = undefined;
    if (tunnelManager) {
      let shutdownStore: TaskStore | null = null;
      try {
        shutdownStore = this.runtime.getTaskStore();
      } catch {
        shutdownStore = null;
      }

      if (shutdownStore) {
        try {
          await this.persistShutdownRemoteLifecycle(shutdownStore, tunnelManager.getStatus());
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          runtimeLog.warn(`Failed to persist remote lifecycle shutdown markers: ${message}`);
        }
      }

      try {
        await tunnelManager.stop();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        runtimeLog.warn(`Tunnel process manager stop failed (continuing shutdown): ${message}`);
      }
    }

    // Stop the core runtime (Triage, Scheduler, Executor, etc.)
    await this.runtime.stop();

    this.started = false;
    this.shuttingDown = false;
    runtimeLog.log(`ProjectEngine stopped for ${this.config.projectId}`);
  }

  // ── Public accessors ──

  /** Get the underlying InProcessRuntime. */
  getRuntime(): InProcessRuntime {
    return this.runtime;
  }

  /** Get the TaskStore. Throws if not started. */
  getTaskStore(): TaskStore {
    return this.runtime.getTaskStore();
  }

  /** Get the AgentStore (if initialized). Returns undefined before start(). */
  getAgentStore(): import("@fusion/core").AgentStore | undefined {
    return this.runtime.getAgentStore();
  }

  clearTaskPauseAbortState(taskId: string): void {
    this.runtime.clearTaskPauseAbortState?.(taskId);
  }

  /** Get the MessageStore (if initialized). Returns undefined before start(). */
  getMessageStore(): import("@fusion/core").MessageStore | undefined {
    return this.runtime.getMessageStore();
  }

  /** Get the ChatStore (if initialized). Returns undefined before start(). */
  getChatStore(): import("@fusion/core").ChatStore | undefined {
    return this.runtime.getChatStore();
  }

  /** Get the project-scoped PluginRunner (if initialized). */
  getPluginRunner() {
    return this.runtime.getPluginRunner();
  }

  attachChatStore(chatStore: NotificationChatStore): void {
    this.notificationService?.attachChatStore(chatStore);
  }

  /** Get the HeartbeatMonitor (if initialized). */
  getHeartbeatMonitor() {
    return this.runtime.getHeartbeatMonitor();
  }

  getSelfHealingManager() {
    return this.runtime.getSelfHealingManager();
  }

  /**
   * Get the bootstrapped CLI Agent Executor runtime (PTY manager + telemetry hub
   * + adapter registry + resume coordinator), or undefined when the experimental
   * flag is off. The dashboard reads this to resolve the project's TelemetryHub
   * (hook route) and supply the cli-session transport dependency.
   */
  getCliAgentRuntime() {
    return this.runtime.getCliAgentRuntime();
  }

  /** Get the project working directory. */
  getWorkingDirectory(): string {
    return this.config.workingDirectory;
  }

  /** Get the project id. */
  getProjectId(): string {
    return this.config.projectId;
  }

  /** Get the PrMonitor (if initialized). */
  getPrMonitor(): PrMonitor | undefined {
    return this.prMonitor;
  }

  /** Get the records-only PlannerOverseerMonitor (if initialized). See FN-7511. */
  getPlannerOverseer(): PlannerOverseerMonitor | undefined {
    return this.plannerOverseer;
  }

  /** Get the bounded PlannerRecoveryController (if initialized). See FN-7512. */
  getPlannerRecoveryController(): PlannerRecoveryController | undefined {
    return this.plannerRecoveryController;
  }

  /**
   * FNXC:PlannerOversight 2026-07-04-00:00:
   * FN-7531 read-only accessor assembling the transient, serializable
   * `PlannerOverseerRuntimeSnapshot` for one task from the FN-7511
   * `PlannerOverseerMonitor`'s latest observation plus the FN-7512/FN-7513
   * `PlannerRecoveryController`'s attempt/pending-confirmation registries.
   * Never mutates either subsystem, never throws (any failure degrades to
   * `null` so a hot request path like `GET /api/tasks` is never put at
   * risk), and returns `null` when there is no active observation for the
   * task (nothing to show on the card).
   */
  getPlannerOverseerRuntimeSnapshot(taskId: string): PlannerOverseerRuntimeSnapshot | null {
    const base = assemblePlannerOverseerRuntimeSnapshot(taskId, this.plannerOverseer, this.plannerRecoveryController);
    if (!base) return null;
    const advisor = this.sessionAdvisor?.getTaskAdvisorSnapshot(taskId);
    if (!advisor?.active) return base;
    return {
      ...base,
      advisorActive: true,
      advisorBacklog: advisor.backlog,
      lastAdviceSeverity: advisor.lastAdviceSeverity,
    };
  }

  /**
   * FNXC:PlannerOversight 2026-07-13-23:05:
   * Feed executor agent-log entries into the session advisor (AgentLogger hook).
   * Fail-soft; never throws into the logger.
   */
  notifySessionAdvisorLogDelta(taskId: string, entries: Array<{ type?: string; text?: string; detail?: string; agent?: string }>): void {
    try {
      // FNXC:PlannerOversight 2026-07-14-14:00: CodeRabbit — attach .catch so async rejections cannot become unhandled rejections (sync try/catch is not enough).
      void this.sessionAdvisor?.onExecutorLogDelta(taskId, entries)?.catch((err) => {
        runtimeLog.warn(
          `session advisor log-delta notification failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    } catch {
      /* ignore */
    }
  }

  /**
   * FNXC:PlannerOversight 2026-07-04-17:00:
   * FN-7517 manual nudge control: injects one planner-authored steering
   * comment into the task's currently watched stage RIGHT NOW, via the same
   * `store.addSteeringComment` guidance channel FN-7512's `injectGuidance`
   * handler already uses — guidance-only, never a merge/PR/destructive side
   * effect (those remain FN-7513's confirmation-gated executeMergePrAction/
   * executeDestructiveExternalAction, never invoked here). Returns
   * `{applied:false, reason:...}` without mutating anything when: the task
   * does not exist, the human-control guard withholds oversight (user-paused
   * or autoMerge:false/human-review), the effective oversight level is
   * "off", or there is no currently monitorable watched stage.
   */
  async nudgeOverseerTask(taskId: string): Promise<{ applied: boolean; reason: string; task?: Task }> {
    try {
      const store = this.runtime.getTaskStore();
      const task = await store.getTask(taskId).catch(() => undefined);
      if (!task) {
        return { applied: false, reason: "task-not-found" };
      }

      const settings = await store.getSettings().catch(() => undefined);
      const humanControl = evaluateOverseerHumanControl(task, settings);
      if (humanControl.withhold) {
        return { applied: false, reason: `withheld:${humanControl.reason}`, task };
      }

      const workflowEffective = await resolveEffectiveSettings(store, { id: task.id }).catch(() => ({}) as Record<string, unknown>);
      const level = resolveEffectivePlannerOversightLevel(task.plannerOversightLevel, workflowEffective.plannerOversightLevel as string | undefined);
      if (level === "off") {
        return { applied: false, reason: "oversight-off", task };
      }

      let observation = this.plannerOverseer ? this.plannerOverseer.getObservations(taskId).slice(-1)[0] : undefined;
      if (!observation && this.plannerOverseer) {
        observation = (await this.plannerOverseer.observeTask(task, level)) ?? undefined;
      }
      if (!observation) {
        return { applied: false, reason: "no-active-stage", task };
      }

      const text = `[planner-oversight] manual nudge (${observation.stage}): ${observation.reason}`;
      await store.addSteeringComment(taskId, text, "user");
      this.plannerRecoveryController?.recordManualAction(taskId, observation.stage, "manual_nudge");

      const updatedTask = await store.getTask(taskId).catch(() => undefined);
      return { applied: true, reason: "nudged", task: updatedTask ?? task };
    } catch (err) {
      void err;
      return { applied: false, reason: "error" };
    }
  }

  /**
   * FNXC:PlannerOversight 2026-07-04-17:00:
   * FN-7517 stop-oversight control: disables active planner oversight for
   * this task by writing the per-task override `plannerOversightLevel:
   * "off"` (the same FN-7509 scalar-override field/plumbing the quick
   * level-change control writes) and releasing the in-memory monitor/
   * recovery-controller ring buffers for this task (mirrors the poll's
   * leave-in-flight cleanup). This is a user action; it never mutates task
   * lifecycle/column and never performs a merge/PR/destructive side effect.
   */
  async stopOverseerTask(taskId: string): Promise<{ applied: boolean; reason: string; task?: Task }> {
    try {
      const store = this.runtime.getTaskStore();
      const task = await store.getTask(taskId).catch(() => undefined);
      if (!task) {
        return { applied: false, reason: "task-not-found" };
      }

      const observation = this.plannerOverseer ? this.plannerOverseer.getObservations(taskId).slice(-1)[0] : undefined;
      if (observation) {
        this.plannerRecoveryController?.recordManualAction(taskId, observation.stage, "manual_stop");
      }

      const updatedTask = await store.updateTask(taskId, { plannerOversightLevel: "off" });
      this.plannerOverseer?.clear(taskId);
      this.plannerRecoveryController?.clear(taskId);
      // FN-7551: release the observation/escalation emission-dedup state too,
      // so if oversight is later re-enabled for this task, the first new
      // observation/escalation emits rather than staying suppressed by stale
      // dedup keys from before the stop.
      this.plannerObservationEmitDedup.delete(taskId);
      this.clearPlannerEscalationDedup(taskId);

      return { applied: true, reason: "stopped", task: updatedTask };
    } catch (err) {
      void err;
      return { applied: false, reason: "error" };
    }
  }

  /**
   * FNXC:PlannerOversight 2026-07-04-17:00:
   * FN-7517 explain-current-action control: a READ of the current overseer
   * runtime state — watched stage, reason, last action taken, and attempt
   * count/limit — assembled from the exact same FN-7511/FN-7512/FN-7531
   * sources as `getPlannerOverseerRuntimeSnapshot`, plus the human-readable
   * `reason`/`lastAction` fields FN-7517 added to `PlannerOverseerRuntimeSnapshot`.
   * Never mutates anything. Returns `null` when there is no active
   * observation for the task (nothing to explain).
   */
  explainOverseerTask(taskId: string): PlannerOverseerRuntimeSnapshot | null {
    return this.getPlannerOverseerRuntimeSnapshot(taskId);
  }

  /**
   * FNXC:PlannerOversight 2026-07-04-19:45:
   * FN-7551 mapping helper: converts the `{kind, ref, url?}` source-link shape
   * shared by `OverseerSourceLink` (FN-7511 observations) and
   * `PlannerRecoverySourceLink` (FN-7512/FN-7513 decisions) into the FN-7520
   * façade's `PlannerInterventionSourceLink` shape (`{kind, label, target, url}`),
   * using `ref` as both `label` and `target` when no richer label exists.
   * Never throws; an empty/undefined input yields `undefined` so callers can
   * omit `sourceLinks` entirely rather than pass an empty array.
   */
  private toInterventionSourceLinks(
    links: ReadonlyArray<{ kind: string; ref: string; url?: string }> | undefined,
  ): PlannerInterventionSourceLink[] | undefined {
    if (!links || links.length === 0) return undefined;
    return links.map((link) => ({
      kind: link.kind as PlannerInterventionSourceLink["kind"],
      label: link.ref || link.kind,
      target: link.ref,
      url: link.url,
    }));
  }

  /**
   * FNXC:PlannerOversight 2026-07-04-19:45:
   * FN-7551: best-effort wrapper shared by every non-observation emission
   * call-site (steering/retry/targeted-fix/confirmation/escalation) —
   * swallows and logs any façade/store failure so an audit-emission error
   * never breaks the dispatching handler or the poll (mirrors the
   * try/catch-degrade-to-no-op contract every FN-7512/FN-7513/FN-7514
   * handler already follows).
   */
  private emitOverseerInterventionSafe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      runtimeLog.warn(`Failed to emit overseer intervention: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * FNXC:PlannerOversight 2026-07-04-19:45:
   * FN-7551: emits one `overseer:intervention` `observe` entry through
   * `emitOverseerObservation` for a real `OverseerStageObservation`, deduped
   * per `(taskId, stage:signal)` so a 45s poll of an unchanged watched stage
   * does not append a new observation entry every cycle — only a changed
   * `(stage, signal)` pair emits. Best-effort: any store/façade failure is
   * swallowed so it never breaks `PlannerOverseerMonitor#observeTask`/the poll.
   */
  private emitOverseerObservationDeduped(store: TaskStore, observation: import("./planner-overseer.js").OverseerStageObservation): void {
    try {
      const dedupKey = `${observation.stage}:${observation.signal}`;
      const last = this.plannerObservationEmitDedup.get(observation.taskId);
      if (last === dedupKey) {
        return;
      }
      this.plannerObservationEmitDedup.set(observation.taskId, dedupKey);
      emitOverseerObservation({
        store,
        taskId: observation.taskId,
        stage: observation.stage,
        reason: observation.reason,
        sourceLinks: this.toInterventionSourceLinks(observation.sources),
      });
    } catch (err) {
      runtimeLog.warn(
        `Failed to emit overseer observation intervention for ${observation.taskId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * FNXC:PlannerOversight 2026-07-04-19:45:
   * FN-7551: emits one `overseer:intervention` `escalate` entry through
   * `emitOverseerEscalation` when a `(taskId, stage)` pair's bounded-recovery
   * budget is exhausted, deduped so it is emitted exactly once while the
   * stage stays exhausted across subsequent polls (a stage that later
   * un-exhausts — e.g. cleared via `clear(taskId)` on terminal transition —
   * clears the dedup entry and may escalate again in a future exhaustion).
   * Best-effort; never throws out of the poll.
   */
  private emitOverseerEscalationDeduped(
    store: TaskStore,
    taskId: string,
    decision: { watchedStage: PlannerOversightStage | null; reason: string; attemptCount: number; attemptLimit: number; sourceLinks: ReadonlyArray<{ kind: string; ref: string; url?: string }> },
  ): void {
    if (!decision.watchedStage) return;
    const dedupKey = `${taskId}::${decision.watchedStage}`;
    if (this.plannerEscalationEmitDedup.has(dedupKey)) {
      return;
    }
    this.plannerEscalationEmitDedup.add(dedupKey);
    this.emitOverseerInterventionSafe(() =>
      emitOverseerEscalation({
        store,
        taskId,
        stage: decision.watchedStage as PlannerOversightStage,
        reason: decision.reason,
        attemptCount: decision.attemptCount,
        attemptLimit: decision.attemptLimit,
        sourceLinks: this.toInterventionSourceLinks(decision.sourceLinks),
      }),
    );
  }

  /** FN-7551: clears any escalation-dedup entries for `taskId` across every watched stage. */
  private clearPlannerEscalationDedup(taskId: string): void {
    const prefix = `${taskId}::`;
    for (const key of [...this.plannerEscalationEmitDedup]) {
      if (key.startsWith(prefix)) {
        this.plannerEscalationEmitDedup.delete(key);
      }
    }
  }

  /**
   * FNXC:PlannerOversight 2026-07-04-12:00:
   * Concrete FN-7512 handler wiring — ONLY reuses existing mechanisms:
   * `injectGuidance`/`requestTargetedFix` post a planner-authored steering
   * comment via `store.addSteeringComment` (the same channel the executor's
   * real-time injection listener already watches); `retryStep` calls the
   * store's existing in-progress→todo retry/re-enqueue path
   * (`moveTask(id, "todo", { preserveProgress: true })`), preserving
   * progress exactly like the auto-recovery/self-healing retry handlers do.
   * No new session/tool/merge channel is introduced.
   */
  private buildPlannerRecoveryHandlers(store: TaskStore): PlannerRecoveryHandlers {
    return {
      injectGuidance: async (task, decision) => {
        const text = `[planner-oversight] ${decision.reason}`;
        await store.addSteeringComment(task.id, text, "agent");
        // FN-7551: emit the steering intervention entry AFTER the steering
        // comment succeeds, through the real store, so the timeline reflects
        // the same guidance the agent actually saw.
        // FNXC:PlannerOversight 2026-07-13-23:05: tag lifecycle source for timeline vs session-advisor.
        this.emitOverseerInterventionSafe(() =>
          emitOverseerSteering({
            store,
            taskId: task.id,
            stage: (decision.watchedStage ?? "executor") as PlannerOversightStage,
            reason: decision.reason,
            sourceLinks: this.toInterventionSourceLinks(decision.sourceLinks),
            source: "lifecycle",
          }),
        );
      },
      retryStep: async (task, decision) => {
        await store.moveTask(task.id, "todo", { preserveProgress: true, moveSource: "engine" } as Parameters<TaskStore["moveTask"]>[2]);
        // FN-7551: the attempt just dispatched — record it as attemptCount + 1
        // (decision.attemptCount is the count BEFORE this dispatch).
        this.emitOverseerInterventionSafe(() =>
          emitOverseerRetry({
            store,
            taskId: task.id,
            stage: (decision.watchedStage ?? "executor") as PlannerOversightStage,
            reason: decision.reason,
            attemptCount: decision.attemptCount + 1,
            attemptLimit: decision.attemptLimit,
            sourceLinks: this.toInterventionSourceLinks(decision.sourceLinks),
          }),
        );
      },
      requestTargetedFix: async (task, decision) => {
        const sourceRef = decision.sourceLinks[0]?.ref;
        const text = sourceRef
          ? `[planner-oversight] targeted-fix requested: ${decision.reason} (source: ${sourceRef})`
          : `[planner-oversight] targeted-fix requested: ${decision.reason}`;
        await store.addSteeringComment(task.id, text, "agent");
        this.emitOverseerInterventionSafe(() =>
          emitOverseerRecoveryAttempt({
            store,
            taskId: task.id,
            stage: (decision.watchedStage ?? "executor") as PlannerOversightStage,
            reason: decision.reason,
            attemptCount: decision.attemptCount + 1,
            attemptLimit: decision.attemptLimit,
            sourceLinks: this.toInterventionSourceLinks(decision.sourceLinks),
          }),
        );
      },
      // FNXC:PlannerOversight 2026-07-04-13:00:
      // FN-7513 requirement: merge/PR actions beyond guidance/retry, and any
      // destructive/external-service side effect, must never run
      // autonomously — `requestConfirmation` ONLY records a pending
      // `PlannerConfirmationRequest` via a planner-authored steering comment
      // (reusing the same `addSteeringComment` channel as bounded recovery)
      // so a human sees it; it never performs the side effect itself. The
      // dashboard confirmation UI/badge that lets a human act on this is
      // owned by FN-7515+/FN-7517.
      // FNXC:PlannerOversight 2026-07-08-00:00:
      // FN-7692 fix: this prefix previously read "confirmation required"
      // unconditionally, which contradicted `request.reason` once FN-7692
      // made that reason accurately advisory under an active auto-merge
      // policy. "checkpoint" is neutral and consistent whether the trailing
      // `reason` describes an advisory (auto-merge will proceed) or a
      // genuine block (human approval required) — messaging-only, no change
      // to the `addSteeringComment` channel/timing or `emitOverseerConfirmation`
      // below.
      requestConfirmation: async (task, request) => {
        const text = `[planner-oversight] merge checkpoint (${request.sideEffectClass}): ${request.reason}`;
        await store.addSteeringComment(task.id, text, "agent");
        this.emitOverseerInterventionSafe(() =>
          emitOverseerConfirmation({
            store,
            taskId: task.id,
            stage: request.watchedStage as PlannerOversightStage,
            reason: request.reason,
            sourceLinks: this.toInterventionSourceLinks(request.sourceLinks),
          }),
        );
      },
      // FNXC:PlannerOversight 2026-07-04-19:45:
      // FN-7551: audit-only confirmation-RESOLUTION emission. Invoked from
      // `PlannerRecoveryController.resolveConfirmation` for both "approved"
      // and "denied" outcomes, mirroring the request-path emission above so
      // the timeline shows both the request and its resolution. Never touches
      // the approve/deny execution path itself.
      onConfirmationResolved: async (taskId, request, resolution) => {
        this.emitOverseerInterventionSafe(() =>
          emitOverseerConfirmation({
            store,
            taskId,
            stage: request.watchedStage as PlannerOversightStage,
            reason: request.reason,
            outcome: resolution === "approved" ? "succeeded" : "skipped",
            sourceLinks: this.toInterventionSourceLinks(request.sourceLinks),
          }),
        );
      },
      // FNXC:PlannerOversight 2026-07-04-14:30:
      // FN-7513 code-review fix: a `"merge_pr"`-classified confirmation covers
      // TWO distinct proposed actions (`decidePlannerRecovery` sets
      // `proposedAction: "advance_merge"` for the `merger` stage and
      // `"advance_pull_request"` for the `pull-request` stage) — they must NOT
      // share one handler. Calling `store.mergeTask` unconditionally on every
      // approved merge_pr request would let an approved PR-stage confirmation
      // perform a direct task merge/cleanup instead of a PR-specific action,
      // bypassing the PR workflow entirely. Branch on `request.proposedAction`
      // (falling back to `request.watchedStage` defensively) and ONLY reuse
      // the existing `store.mergeTask` merge-advance mechanism for
      // `"advance_merge"` / the `merger` stage. `"advance_pull_request"` has
      // no existing PR-advance mechanism to reuse yet (FN-7515+/FN-7517 own
      // the PR-specific execution wiring) — it is intentionally a no-op here
      // so an approved PR confirmation never falls through to a merge.
      executeMergePrAction: async (taskId, request) => {
        const proposedAction = request.proposedAction;
        const isMergeAdvance = proposedAction === "advance_merge" || (!proposedAction && request.watchedStage === "merger");
        if (!isMergeAdvance) {
          // PR-stage (or any other non-merge-advance) approval: no reusable
          // PR-advance mechanism exists yet — deliberately do nothing rather
          // than fall back to a task merge.
          return;
        }
        await store.mergeTask(taskId);
      },
      // FN-7513: no destructive/external execution handler is wired yet —
      // `decidePlannerRecovery` does not currently produce a
      // `destructive_external` action (FN-7511 has no destructive-action
      // signal), so this is intentionally left unset; a future task can wire
      // a concrete handler using existing safe helpers when one is needed.
      // FNXC:PlannerOverseer 2026-07-04-15:00:
      // FN-7514 requirement: when the human-control guard (user-paused, or
      // autoMerge:false/human-review) withholds ALL oversight for a task,
      // record a bounded `overseer:oversight-withheld-human-control` no-action
      // run-audit event (metadata: taskId/reason/stage/oversightLevel) so the
      // withholding is observable, mirroring the `*-no-action` self-healing
      // convention. Audit-only — this handler performs no lifecycle mutation.
      recordHumanControlWithheld: async (task, decision, ctx) => {
        try {
          const auditor = createRunAuditor(store, {
            runId: generateSyntheticRunId("planner-overseer-human-control", task.id),
            agentId: "planner-overseer",
            taskId: task.id,
            phase: "planner-overseer-poll",
          });
          await auditor.database({
            type: "overseer:oversight-withheld-human-control",
            target: task.id,
            metadata: {
              taskId: task.id,
              reason: decision.reason,
              stage: (ctx as { stage?: string }).stage,
              oversightLevel: (ctx as { oversightLevel?: string }).oversightLevel,
            },
          });
        } catch (err: unknown) {
          runtimeLog.warn(
            `Failed to record overseer:oversight-withheld-human-control for ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    };
  }

  /** Get the CronRunner (if initialized). */
  getCronRunner(): CronRunner | undefined {
    return this.cronRunner;
  }

  /** Get the AutomationStore (if initialized). */
  getAutomationStore(): AutomationStoreType | undefined {
    return this.automationStore;
  }

  /**
   * Get the engine's raw createFusionAuthStorage() instance (if the OAuth subsystem has
   * started; undefined when skipNotifier suppressed it).
   *
   * FNXC:ProviderAuth 2026-07-09-00:00:
   * FN-7747 / #1948: createServer() derives a fallback `authStorage` from this getter when a
   * host wires an engine but forgets to pass its own `authStorage`, so credential persistence
   * degrades gracefully instead of throwing "Authentication is not configured". This is the
   * RAW storage (no API-key/custom-provider wrapping) — hosts needing the full wrapped
   * provider catalog (e.g. desktop's seedDashboardProviders() output) must still pass their
   * own wrapped authStorage explicitly, exactly as packages/desktop already does.
   */
  getAuthStorage(): ReturnType<typeof createFusionAuthStorage> | undefined {
    return this.authStorage;
  }

  /**
   * Get the automation subsystem health for diagnostics and status reporting.
   */
  getAutomationSubsystemHealth(): AutomationSubsystemHealth {
    return { ...this.automationSubsystemHealth };
  }

  /** Get the RoutineStore (if initialized). */
  getRoutineStore(): import("@fusion/core").RoutineStore | undefined {
    return this.runtime.getRoutineStore();
  }

  /** Get the ResearchOrchestrator (if initialized). Returns undefined before start(). */
  getResearchOrchestrator(): ResearchOrchestrator | undefined {
    return this.researchOrchestrator;
  }

  /** Get the ResearchRunDispatcher (if initialized). Returns undefined before start(). */
  getResearchDispatcher(): ResearchRunDispatcher | undefined {
    return this.researchDispatcher;
  }

  /** Get the remote tunnel manager (available after start()). */
  getRemoteTunnelManager(): TunnelProcessManager | undefined {
    return this.remoteTunnelManager;
  }

  getRemoteTunnelRestoreDiagnostics(): TunnelRestoreDiagnostics {
    return { ...this.remoteTunnelRestoreDiagnostics };
  }

  async startRemoteTunnel(): Promise<TunnelStatusSnapshot> {
    const manager = this.remoteTunnelManager;
    if (!manager) {
      throw new Error("remote_tunnel_unavailable:remote tunnel manager is not initialized");
    }

    const store = this.runtime.getTaskStore();
    const settings = await store.getSettings();
    const remoteAccess = settings.remoteAccess;
    if (!remoteAccess || !isRemoteActive(remoteAccess)) {
      throw new Error("invalid_config:no remote access provider enabled");
    }

    const provider = remoteAccess.activeProvider;
    if (!provider) {
      throw new Error("invalid_config:no active remote provider configured");
    }

    const lifecycle = await this.evaluateRemoteLifecycle(settings, provider);
    if (!lifecycle.config) {
      throw new Error(`${lifecycle.reason ?? "invalid_config"}:${lifecycle.message ?? "remote provider prerequisites are not met"}`);
    }

    const current = manager.getStatus();
    if (current.state === "running" && current.provider === provider) {
      await this.writeRemoteLifecycleState(store, remoteAccess, {
        ...remoteAccess.lifecycle,
        wasRunningOnShutdown: true,
        lastRunningProvider: provider,
      });
      return manager.getStatus();
    }

    if (current.state === "running" && current.provider && current.provider !== provider) {
      await manager.switchProvider(provider, lifecycle.config);
    } else {
      await manager.start(provider, lifecycle.config);
    }

    await this.writeRemoteLifecycleState(store, remoteAccess, {
      ...remoteAccess.lifecycle,
      wasRunningOnShutdown: true,
      lastRunningProvider: provider,
    });

    return manager.getStatus();
  }

  async stopRemoteTunnel(): Promise<TunnelStatusSnapshot> {
    const manager = this.remoteTunnelManager;
    if (!manager) {
      throw new Error("remote_tunnel_unavailable:remote tunnel manager is not initialized");
    }

    await manager.stop();

    const store = this.runtime.getTaskStore();
    const settings = await store.getSettings();
    const remoteAccess = settings.remoteAccess;
    if (remoteAccess) {
      await this.writeRemoteLifecycleState(store, remoteAccess, {
        ...remoteAccess.lifecycle,
        wasRunningOnShutdown: false,
        lastRunningProvider: null,
      });
    }

    return manager.getStatus();
  }

  async detectExternalTunnel(): Promise<ExternalTunnelInfo | null> {
    const manager = this.remoteTunnelManager;
    if (!manager) {
      return null;
    }

    const settings = await this.runtime.getTaskStore().getSettings();
    const provider = settings.remoteAccess?.activeProvider ?? null;
    if (provider !== "tailscale") {
      return null;
    }

    return manager.detectExternalFunnel();
  }

  async killExternalTunnel(): Promise<void> {
    const manager = this.remoteTunnelManager;
    if (!manager) {
      return;
    }

    const settings = await this.runtime.getTaskStore().getSettings();
    const provider = settings.remoteAccess?.activeProvider ?? null;
    if (provider !== "tailscale") {
      return;
    }

    await manager.killExternalFunnel();
  }

  /** Get the RoutineRunner (if initialized). */
  getRoutineRunner(): RoutineRunner | undefined {
    return this.runtime.getRoutineRunner();
  }

  /** Get the HeartbeatTriggerScheduler from the underlying runtime, if initialized. */
  getHeartbeatTriggerScheduler(): HeartbeatTriggerScheduler | undefined {
    return this.runtime.getTriggerScheduler();
  }

  /**
   * Enqueue a task ID for auto-merge if it is not already queued or active.
   * Exposed publicly so callers can integrate the engine's merge queue with
   * an external `onMerge` callback (e.g. dashboard's createServer call).
   */
  enqueueMerge(taskId: string): boolean {
    return this.internalEnqueueMerge(taskId);
  }

  /**
   * Promote a shared branch group: merge the group branch into the integration
   * branch and reconcile `prState` (completion-gated, idempotent).
   *
   * This is the single engine bridge method (KTD5) that the dashboard promote
   * route reaches via the `promoteBranchGroup` option callback in
   * `register-integrated-routers.ts`. It resolves the same store / rootDir /
   * settings context the internal auto-promotion path (`attemptBranchGroupPromotion`)
   * uses and delegates to the standalone coordinator function — no logic is
   * duplicated here.
   */
  async promoteBranchGroup(groupId: string): Promise<BranchGroupPromotionResult> {
    const store = this.runtime.getTaskStore();
    const cwd = this.config.workingDirectory;
    const settings = await store.getSettings();
    const promotionSettings = {
      autoMerge: settings.autoMerge,
      globalPause: settings.globalPause,
      enginePaused: settings.enginePaused,
      mergeStrategy: settings.mergeStrategy,
      integrationBranch: settings.integrationBranch,
      baseBranch: settings.baseBranch,
    };
    return await promoteBranchGroup({
      store,
      rootDir: cwd,
      groupId,
      settings: promotionSettings,
      createGroupPr: this.options.createGroupPr,
      recordAudit: async (event) => {
        await store.recordRunAuditEvent({
          domain: event.domain as any,
          mutationType: event.mutationType,
          target: event.target,
          metadata: event.metadata,
        } as any);
      },
    });
  }

  /**
   * Perform an AI-powered merge for a task, serialized through the merge queue.
   * This is the manual "merge now" path — it shares the same queue as auto-merge
   * so only one merge runs at a time per project.
   * Returns the full MergeResult so it can be used as the `onMerge` callback
   * in createServer().
   */
  async onMerge(taskId: string, options: { signal?: AbortSignal } = {}): Promise<MergeResult> {
    const signal = options.signal;
    if (signal?.aborted) {
      throw new Error(`Merge request for ${taskId} aborted`);
    }

    return new Promise<MergeResult>((resolve, reject) => {
      let settled = false;
      let abort: () => void = () => undefined;
      const cleanup = () => {
        signal?.removeEventListener("abort", abort);
      };
      const resolver: MergeResolver = {
        resolve: (result) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        },
      };
      abort = () => {
        this.removeMergeResolver(taskId, resolver);
        if (this.activeMergeTaskId === taskId) {
          this.mergeAbortController?.abort();
          this.mergeAbortController = null;
          this.activeMergeSession?.dispose();
          this.activeMergeSession = null;
        } else if (!this.hasMergeResolvers(taskId)) {
          this.mergeQueue = this.mergeQueue.filter((queuedTaskId) => queuedTaskId !== taskId);
          this.mergeActive.delete(taskId);
        }
        resolver.reject(new Error(`Merge request for ${taskId} aborted`));
      };

      signal?.addEventListener("abort", abort, { once: true });
      this.addMergeResolver(taskId, resolver);

      // If this task is already queued or actively merging, wait for the
      // existing merge to finish rather than starting a second one.
      if (this.mergeActive.has(taskId)) return;

      if (!this.internalEnqueueMerge(taskId)) {
        this.removeMergeResolver(taskId, resolver);
        resolver.reject(new Error(`Merge enqueue rejected for ${taskId}`));
      }
    });
  }

  /**
   * Merge entry point for the workflow graph interpreter's `merge` seam. Unlike
   * onMerge (the human "merge now" bypass), this honors the project's auto-merge
   * eligibility: when autoMerge is off (or the task isn't merge-eligible), it
   * does NOT force the merge. It resolves with `merged: false` so the seam treats
   * it as "manual merge required" and parks the task in review — preserving the
   * contract that autoMerge-off leaves in-review terminal until a human merges.
   */
  async requestInterpreterMerge(taskId: string, options: { signal?: AbortSignal } = {}): Promise<MergeResult> {
    let task: Task | null = null;
    let settings: Settings | undefined;
    const store = this.runtime.getTaskStore();
    try {
      settings = await store.getSettings();
      task = await store.getTask(taskId);
    } catch {
      // Fall through to the not-eligible response below.
    }
    const eligible = !!task && !!settings
      && task.column === "in-review"
      && !settings.globalPause && !settings.enginePaused
      && (await this.allowInReviewMergeProcessing(task, settings, store))
      && !(task.paused && !task.mergeDetails?.mergeConfirmed);
    if (!eligible) {
      // A null task means the lookup failed or the task was deleted; never hand
      // back a MergeResult with `task` cast from null — callers dereference
      // result.task. Throw so the merge seam (which converts seam throws into a
      // clean "failure" outcome) parks the task for human review.
      if (!task) {
        throw new Error(`Interpreter merge for ${taskId} aborted: task not found (deleted or lookup failed)`);
      }
      runtimeLog.log(`Interpreter merge for ${taskId} not auto-eligible (autoMerge off / not ready) — manual merge required`);
      return {
        task,
        branch: task.branch ?? "",
        merged: false,
        // noOp signals "parked cleanly in review, awaiting human merge" so the
        // merge seam treats this as success rather than a graph failure.
        noOp: true,
        worktreeRemoved: false,
        branchDeleted: false,
      } as MergeResult;
    }
    // Eligible: route through the normal serialized merge path.
    return this.onMerge(taskId, options);
  }

  private setRestoreDiagnostics(
    outcome: TunnelRestoreDiagnostics["outcome"],
    reason: TunnelRestoreReasonCode,
    provider: TunnelProvider | null,
    message?: string,
  ): void {
    this.remoteTunnelRestoreDiagnostics = {
      outcome,
      reason,
      provider,
      message,
      at: new Date().toISOString(),
    };
  }

  private setAutomationSubsystemHealth(
    status: AutomationSubsystemHealth["status"],
    message: string,
  ): void {
    this.automationSubsystemHealth = {
      status,
      message,
      updatedAt: new Date().toISOString(),
    };
  }

  private async restoreRemoteTunnelIfNeeded(store: TaskStore): Promise<void> {
    const manager = this.remoteTunnelManager;
    if (!manager) {
      return;
    }

    const settings = await store.getSettings();
    const remoteAccess = settings.remoteAccess;
    if (!remoteAccess || !isRemoteActive(remoteAccess)) {
      this.setRestoreDiagnostics("skipped", "remote_access_disabled", null);
      return;
    }

    const lifecycle = remoteAccess.lifecycle;
    if (!lifecycle.rememberLastRunning) {
      this.setRestoreDiagnostics("skipped", "remember_last_running_disabled", null);
      if (lifecycle.wasRunningOnShutdown || lifecycle.lastRunningProvider) {
        await this.writeRemoteLifecycleState(store, remoteAccess, {
          ...lifecycle,
          wasRunningOnShutdown: false,
          lastRunningProvider: null,
        });
      }
      return;
    }

    if (!lifecycle.wasRunningOnShutdown) {
      this.setRestoreDiagnostics("skipped", "no_prior_running_marker", null);
      return;
    }

    const provider = lifecycle.lastRunningProvider ?? remoteAccess.activeProvider;
    if (!provider) {
      this.setRestoreDiagnostics("skipped", "provider_missing", null);
      await this.writeRemoteLifecycleState(store, remoteAccess, {
        ...lifecycle,
        wasRunningOnShutdown: false,
        lastRunningProvider: null,
      });
      return;
    }

    const evaluation = await this.evaluateRemoteLifecycle(settings, provider);
    if (!evaluation.config) {
      this.setRestoreDiagnostics("skipped", evaluation.reason ?? "provider_not_configured", provider, evaluation.message);
      await this.writeRemoteLifecycleState(store, remoteAccess, {
        ...lifecycle,
        wasRunningOnShutdown: false,
        lastRunningProvider: null,
      });
      return;
    }

    try {
      await manager.start(provider, evaluation.config);
      this.setRestoreDiagnostics("applied", "restore_started", provider);
      await this.writeRemoteLifecycleState(store, remoteAccess, {
        ...lifecycle,
        wasRunningOnShutdown: true,
        lastRunningProvider: provider,
      }, provider);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setRestoreDiagnostics("failed", "restore_start_failed", provider, message);
      runtimeLog.warn(`Remote tunnel restore failed for ${provider}: ${message}`);
      await this.writeRemoteLifecycleState(store, remoteAccess, {
        ...lifecycle,
        wasRunningOnShutdown: false,
        lastRunningProvider: null,
      });
    }
  }

  private async persistShutdownRemoteLifecycle(
    store: TaskStore,
    status: TunnelStatusSnapshot,
  ): Promise<void> {
    const settings = await store.getSettings();
    const remoteAccess = settings.remoteAccess;
    if (!remoteAccess) {
      return;
    }

    const shouldRememberRunning =
      (status.state === "running" || status.state === "starting" || status.state === "stopping") &&
      status.provider !== null;

    await this.writeRemoteLifecycleState(store, remoteAccess, {
      ...remoteAccess.lifecycle,
      wasRunningOnShutdown: shouldRememberRunning,
      lastRunningProvider: shouldRememberRunning ? status.provider : null,
    }, shouldRememberRunning ? status.provider : remoteAccess.activeProvider);
  }

  private async writeRemoteLifecycleState(
    store: TaskStore,
    remoteAccess: NonNullable<Settings["remoteAccess"]>,
    lifecycle: NonNullable<Settings["remoteAccess"]>["lifecycle"],
    activeProviderOverride?: TunnelProvider | null,
  ): Promise<void> {
    await store.updateSettings({
      remoteAccess: {
        ...remoteAccess,
        activeProvider: activeProviderOverride === undefined ? remoteAccess.activeProvider : activeProviderOverride,
        lifecycle,
      },
    });
  }

  private async evaluateRemoteLifecycle(
    settings: Settings,
    provider: TunnelProvider,
  ): Promise<RemoteLifecycleEvaluation> {
    const remoteAccess = settings.remoteAccess;
    if (!remoteAccess || !isRemoteActive(remoteAccess)) {
      return { provider, reason: "remote_access_disabled", message: "No remote provider is enabled" };
    }

    if (provider === "tailscale") {
      const tailscale = remoteAccess.providers.tailscale;
      if (!tailscale.enabled) {
        return { provider, reason: "provider_not_enabled", message: "Tailscale provider is disabled" };
      }
      if (!Number.isFinite(tailscale.targetPort) || tailscale.targetPort <= 0) {
        return { provider, reason: "provider_not_configured", message: "Tailscale target port must be configured" };
      }

      const executable = await this.checkExecutableAvailable("tailscale");
      if (!executable.available) {
        return { provider, reason: "runtime_prerequisite_missing", message: executable.message };
      }

      return {
        provider,
        config: {
          provider: "tailscale",
          executablePath: "tailscale",
          args: ["funnel", String(Math.floor(tailscale.targetPort))],
        },
      };
    }

    const cloudflare = remoteAccess.providers.cloudflare;
    if (!cloudflare.enabled) {
      return { provider, reason: "provider_not_enabled", message: "Cloudflare provider is disabled" };
    }
    if (cloudflare.quickTunnel === true) {
      const executable = await this.checkExecutableAvailable("cloudflared");
      if (!executable.available) {
        return { provider, reason: "runtime_prerequisite_missing", message: executable.message };
      }

      return {
        provider,
        config: {
          provider: "cloudflare",
          quickTunnel: true,
          executablePath: "cloudflared",
          args: ["tunnel", "--url", "http://localhost:4040"],
        },
      };
    }

    if (!cloudflare.tunnelName?.trim() || !cloudflare.ingressUrl?.trim()) {
      return { provider, reason: "provider_not_configured", message: "Cloudflare tunnel name and ingress URL must be configured" };
    }
    if (!cloudflare.tunnelToken?.trim()) {
      return { provider, reason: "provider_not_configured", message: "Cloudflare tunnel token is required" };
    }

    const executable = await this.checkExecutableAvailable("cloudflared");
    if (!executable.available) {
      return { provider, reason: "runtime_prerequisite_missing", message: executable.message };
    }

    return {
      provider,
      config: {
        provider: "cloudflare",
        executablePath: "cloudflared",
        args: ["tunnel", "--no-autoupdate", "run", cloudflare.tunnelName.trim()],
        tokenEnvVar: "TUNNEL_TOKEN",
        env: {
          TUNNEL_TOKEN: cloudflare.tunnelToken,
        },
      },
    };
  }

  private async checkExecutableAvailable(command: string): Promise<{ available: boolean; message?: string }> {
    const checker = process.platform === "win32" ? "where" : "which";
    try {
      await execFileAsync(checker, [command]);
      return { available: true };
    } catch {
      return {
        available: false,
        message: `${command} is not available on PATH`,
      };
    }
  }

  // ── Merge eligibility helpers (richer logic from dashboard.ts) ──

  /**
   * True when a retry-exhausted task in "in-review" has a verification buffer
   * failure that can be auto-healed by resetting mergeRetries and re-running.
   */
  private hasAutoHealableVerificationBufferFailure(task: {
    mergeRetries?: number | null;
    column: string;
    error?: string | null;
    log?: Array<{ action?: string }>;
  }, maxAutoMergeRetries: number): boolean {
    if (task.column !== "in-review") return false;
    if ((task.mergeRetries ?? 0) < maxAutoMergeRetries) return false;
    const err = task.error ?? "";
    const matchesVerificationError =
      err.includes("Deterministic test verification failed") ||
      err.includes("Deterministic build verification failed") ||
      err.includes("Build verification failed") ||
      err.includes("Test verification failed");
    if (!matchesVerificationError) return false;

    return (
      task.log?.some(
        (entry) =>
          entry.action?.includes("[verification] test command failed (exit 0)") ||
          entry.action?.includes("[verification] build command failed (exit 0)") ||
          entry.action?.includes("output exceeded buffer"),
      ) ?? false
    );
  }

  /**
   * True when a retry-exhausted task has been idle long enough for a
   * 30-minute cooldown merge attempt.
   */
  private isRetryCooldownElapsed(task: { updatedAt?: string | null }): boolean {
    if (!task.updatedAt) return false;
    const updated = Date.parse(task.updatedAt);
    if (Number.isNaN(updated)) return false;
    return Date.now() - updated >= ProjectEngine.AUTO_MERGE_COOLDOWN_MS;
  }

  /**
   * Returns true if the task is eligible for auto-merge. Uses richer eligibility
   * checks: merge blocker, retry limit, auto-heal patterns, cooldown elapsed.
   */
  private canMergeTask(task: {
    id?: string;
    mergeRetries?: number | null;
    column: string;
    paused?: boolean;
    status?: string | null;
    error?: string | null;
    steps?: Array<{ status: string }>;
    workflowStepResults?: Array<{ status: string }>;
    log?: Array<{ action?: string }>;
    updatedAt?: string | null;
    mergeDetails?: { mergeConfirmed?: boolean } | null;
  }, maxAutoMergeRetries: number): boolean {
    // Merge-confirmed tasks use the fast-path finalizer, which applies blocker
    // checks after clearing transient status/error state. Once that path parks
    // a blocked task as failed, skip future auto-merge retries.
    if (task.mergeDetails?.mergeConfirmed) {
      return true;
    }
    if (this.options.getTaskMergeBlocker?.(task as Task)) return false;
    // Terminal failure: don't let the cooldown sweep re-attempt a merge that
    // already gave up (verification cap, conflict-bounce cap, or non-conflict
    // error). The task is parked for human/follow-up intervention.
    if (task.status === "failed") return false;
    return (
      (task.mergeRetries ?? 0) < maxAutoMergeRetries ||
      this.hasAutoHealableVerificationBufferFailure(task, maxAutoMergeRetries) ||
      this.isRetryCooldownElapsed(task)
    );
  }

  /**
   * Remove and return the highest-priority taskId from the merge queue.
   * Ordering: priority (urgent→low), then createdAt ASC, then id ASC — matching
   * the triage and scheduler comparators. Manual merges (onMerge resolvers) are
   * preferred over auto-merges so awaited callers aren't starved by a flood of
   * higher-priority auto-enqueues. IDs whose tasks can't be loaded fall back to
   * FIFO order so they still drain.
   */
  private async pickNextMergeTaskId(store: TaskStore): Promise<string | undefined> {
    if (this.mergeQueue.length === 0) return undefined;
    // Fast path: with a single queued task there's nothing to reorder. Avoid an
    // extra getTask round-trip (and keep callers that mock getTask once happy).
    if (this.mergeQueue.length === 1) {
      return this.mergeQueue.shift();
    }

    // Snapshot the queue before awaiting. While we await store.getTask for
    // each id, stop() may clear mergeQueue and pause-handling may filter
    // entries out — so we never trust positional indices afterwards.
    const queueSnapshot = [...this.mergeQueue];
    const entries: Array<{ taskId: string; task: Task | undefined; manual: boolean; order: number }> = [];
    for (let i = 0; i < queueSnapshot.length; i++) {
      const taskId = queueSnapshot[i]!;
      const task = (await store.getTask(taskId).catch(() => undefined)) as Task | undefined;
      entries.push({
        taskId,
        task,
        manual: this.manualMergeResolvers.has(taskId),
        order: i,
      });
    }

    if (this.shuttingDown) return undefined;

    entries.sort((a, b) => {
      if (a.manual !== b.manual) return a.manual ? -1 : 1;
      if (a.task && b.task) return compareTasksByPriorityThenAgeAndId(a.task, b.task);
      if (a.task) return -1;
      if (b.task) return 1;
      return a.order - b.order;
    });

    // Find the highest-priority entry that is still in the live queue.
    // Concurrent mutations (pause filter, stop) may have removed entries.
    for (const entry of entries) {
      const liveIndex = this.mergeQueue.indexOf(entry.taskId);
      if (liveIndex !== -1) {
        this.mergeQueue.splice(liveIndex, 1);
        return entry.taskId;
      }
    }
    return undefined;
  }

  // FNXC:PostgresCutover 2026-07-04-00:00:
  // Async-cascaded to use getMergeRequestRecordAsync (the PG-backed read) so
  // shadow-dequeue parity works in backend mode. The single caller (the merge
  // loop at line ~1868) already runs in an async while-loop.
  private async getShadowMergeRequestCandidateId(): Promise<string | null> {
    const store = this.runtime.getTaskStore() as TaskStore & {
      getMergeRequestRecordAsync?: (taskId: string) => Promise<{ state: string } | null>;
    };
    if (typeof store.getMergeRequestRecordAsync !== "function") {
      return null;
    }

    for (const queuedTaskId of this.mergeQueue) {
      const record = await store.getMergeRequestRecordAsync(queuedTaskId);
      if (!record) continue;
      if (record.state === "manual-required") continue;
      if (record.state === "queued" || record.state === "retrying" || record.state === "running") {
        return queuedTaskId;
      }
    }
    return null;
  }

  private emitMergeRequestShadowDequeueParity(legacyTaskId: string, shadowTaskId: string | null): void {
    const agree = shadowTaskId === legacyTaskId;
    const store = this.runtime.getTaskStore();
    void store.recordRunAuditEvent?.({
      taskId: legacyTaskId,
      agentId: "merger",
      runId: generateSyntheticRunId("merger-shadow-dequeue", legacyTaskId),
      domain: "database",
      mutationType: "merge:request-dequeued-shadow",
      target: legacyTaskId,
      metadata: {
        legacyTaskId,
        shadowTaskId,
        agree,
      },
    });
  }

  private internalEnqueueMerge(taskId: string): boolean {
    if (this.shuttingDown) return false;
    if (this.mergeActive.has(taskId)) {
      // Distinguish "actually being processed" (queued or active) from a
      // leaked entry. Reconcile leaks immediately so recovery paths and fresh
      // in-review handoffs can make forward progress without waiting for the
      // periodic maintenance sweep.
      const isActuallyLive =
        this.mergeQueue.includes(taskId) || this.activeMergeTaskId === taskId;
      if (!isActuallyLive) {
        runtimeLog.warn(
          `internalEnqueueMerge(${taskId}): skipped — mergeActive entry is leaked (not queued, not active). Reconciling stale entry and retrying enqueue now.`,
        );
        this.mergeActive.delete(taskId);
      } else {
        return false;
      }
    }
    this.mergeActive.add(taskId);
    this.mergeQueue.push(taskId);
    void this.drainMergeQueue().catch((err: unknown) => {
      runtimeLog.error(
        `Merge queue drain failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return true;
  }

  /*
  FNXC:MergeQueue 2026-07-15-09:41:
  Operator-visible hang: pause/cancel aborted the merge AbortController and disposed the session, but runAiMerge/promptWithFallback often keeps awaiting a wedged agent tool (e.g. fn_task_show) that never observes the signal. drainMergeQueue stayed parked on that await with mergeRunning=true, so no card got a merging badge and later enqueues no-op'd. Race the merge work with the abort signal so pause always unblocks the single-flight pump even when the agent ignores abort; dispose remains best-effort cleanup for the orphan session.
  */
  private createMergeAbortedError(taskId: string): Error {
    // Name-tagged Error (not a class import) so test mocks of merger.js stay compatible and catch paths that match err.name === "MergeAbortedError" keep working.
    const err = new Error(`Merge aborted for ${taskId}: pause or cancel requested`);
    err.name = "MergeAbortedError";
    return err;
  }

  private raceMergeWithAbort<T>(work: Promise<T>, signal: AbortSignal, taskId: string): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(this.createMergeAbortedError(taskId));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        reject(this.createMergeAbortedError(taskId));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      work.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }

  /**
   * Filter a sweep's listTasks() result to merge-eligible tasks, sort by
   * priority (urgent → low, then createdAt ASC, then id ASC), and enqueue.
   * Sorting before enqueue matters because each enqueue may immediately
   * trigger drainMergeQueue's single-item fast path, so the first task
   * pushed wins. listTasks returns createdAt ASC — without this sort an
   * older low-priority task would start before a later urgent one.
   */
  private async allowInReviewMergeProcessing(task: Pick<Task, "branchContext" | "autoMerge">, settings: Pick<Settings, "autoMerge">, store: Partial<Pick<TaskStore, "getBranchGroup">> = this.runtime.getTaskStore()): Promise<boolean> {
    const groupId = task.branchContext?.groupId?.trim();
    const branchGroup = groupId ? await store.getBranchGroup?.(groupId) : null;
    /*
    FNXC:AutoMergeHold 2026-07-09-16:53:
    FN-7750 / Runfusion#1980: shared-branch member integration may bypass the global `autoMerge:false` hold only while its group row is still open. Stale, finalized, abandoned, or missing groups must flow through the standalone manual-hold gate so no task provenance can solo auto-merge to main.
    */
    return allowsAutoMergeProcessing(task, settings) || isLiveSharedBranchGroupMemberIntegration(task, branchGroup);
  }

  private async emitLegacyAutoMergeStampAdvisory(store: TaskStore): Promise<void> {
    if (this.legacyAutoMergeStampAdvisoryEmitted) {
      return;
    }
    this.legacyAutoMergeStampAdvisoryEmitted = true;

    try {
      const candidates = (await store.listTasks({ column: "in-review" }))
        .filter((task) => task.autoMerge === true && task.autoMergeProvenance !== "user");
      if (candidates.length === 0) {
        return;
      }

      const taskIds = candidates.map((task) => task.id);
      runtimeLog.warn(
        `Global auto-merge was turned off, but ${taskIds.length} legacy in-review task(s) still have task.autoMerge=true without user provenance and may continue to auto-merge: ${taskIds.join(", ")}. Run reconcileLegacyAutoMergeStamps({ apply: true }) to clear these legacy stamps after review.`,
      );
      void store.recordRunAuditEvent({
        agentId: "system",
        runId: `legacy-auto-merge-stamp-advisory-${Date.now()}`,
        domain: "database",
        mutationType: "task:auto-merge-legacy-stamp-advisory",
        target: "settings.autoMerge",
        metadata: {
          taskIds,
          candidateCount: taskIds.length,
          recommendation: "Run reconcileLegacyAutoMergeStamps({ apply: true }) to clear legacy stamps after operator review.",
          changedTaskState: false,
        },
      });
    } catch (err: unknown) {
      runtimeLog.warn(
        `Legacy auto-merge stamp advisory failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async enqueueEligibleInReviewTasks(tasks: readonly Task[], settings: Pick<Settings, "autoMerge" | "maxAutoMergeRetries">): Promise<number> {
    const maxAutoMergeRetries = resolveMaxAutoMergeRetries(settings);
    // FNXC:PostgresCutover 2026-07-10: allowInReviewMergeProcessing awaits the
    // async getBranchGroup read on the PG branch, so eligibility resolves per
    // task before the sync priority sort.
    const candidates = tasks.filter((t) => !t.paused && this.canMergeTask(t as any, maxAutoMergeRetries)) as Task[];
    const allowFlags = await Promise.all(candidates.map((t) => this.allowInReviewMergeProcessing(t, settings, this.runtime.getTaskStore())));
    const eligible = sortTasksByPriorityThenAgeAndId(
      candidates.filter((_, i) => allowFlags[i]),
    );
    for (const t of eligible) {
      this.internalEnqueueMerge(t.id);
    }
    return eligible.length;
  }

  private reconcileStaleMergeActive(): number {
    let cleared = 0;
    for (const taskId of [...this.mergeActive]) {
      if (taskId === this.activeMergeTaskId) continue;
      if (this.mergeQueue.includes(taskId)) continue;
      this.mergeActive.delete(taskId);
      cleared++;
    }
    return cleared;
  }

  /**
   * FNXC:PlannerOversight 2026-07-04-00:00:
   * Bounded, gated poll over in-flight tasks (in-progress/in-review). For
   * each task, resolves the effective planner oversight level and, unless it
   * is "off" or the task resolves to no watched stage, records one
   * `OverseerStageObservation` via `PlannerOverseerMonitor#observeTask`.
   * Records-only: no lifecycle mutation, retry, or notification here.
   * Cleared on `stop()`. Never an unbounded loop — a single bounded
   * `setInterval` at a conservative cadence.
   */
  private startPlannerOverseerPoll(store: TaskStore): void {
    if (this.plannerOverseerPollTimer) {
      return;
    }
    this.plannerOverseerPollTimer = setInterval(() => {
      void this.pollPlannerOverseer(store);
    }, ProjectEngine.PLANNER_OVERSEER_POLL_INTERVAL_MS);
  }

  private async pollPlannerOverseer(store: TaskStore): Promise<void> {
    if (!this.plannerOverseer || this.shuttingDown) {
      return;
    }
    const overseer = this.plannerOverseer;
    try {
      const [inProgress, inReview] = await Promise.all([
        store.listTasks({ column: "in-progress" }).catch(() => [] as Task[]),
        store.listTasks({ column: "in-review" }).catch(() => [] as Task[]),
      ]);
      const inFlight = [...inProgress, ...inReview];
      const inFlightIds = new Set(inFlight.map((t) => t.id));
      // FN-7514: fetch global engine Settings ONCE per poll cycle (not per
      // task) so `PlannerRecoveryController.tick`'s human-control guard can
      // consult `allowsAutoMergeProcessing(task, settings)` — the same
      // FN-5147 predicate `self-healing.ts` gates lifecycle mutation on.
      const engineSettings = await store.getSettings().catch(() => undefined);
      // FNXC:PlannerOversight 2026-07-14-00:10: keep session-advisor human-control on live settings.
      this.sessionAdvisor?.setSettings(engineSettings);

      for (const task of inFlight) {
        try {
          const workflowEffective = await resolveEffectiveSettings(store, { id: task.id }).catch(() => ({}) as Record<string, unknown>);
          const level = resolveEffectivePlannerOversightLevel(
            task.plannerOversightLevel,
            workflowEffective.plannerOversightLevel as string | undefined,
          );
          if (level === "off") {
            continue;
          }
          // FN-7743: resolve the executor-stall threshold from the task's
          // effective workflow settings (same `workflowEffective` fetch used
          // for `plannerOversightLevel` above — no extra store round-trip) and
          // pass it into `observeTask` so a genuinely idle non-paused
          // in-progress task reports `signal: "stuck"` instead of always
          // `progressing` (the FN-7732 symptom).
          const executorStuckAfterMs = resolveExecutorStuckAfterMs(workflowEffective.plannerOverseerExecutorStuckAfterMs);
          await overseer.observeTask(task, level, { executorStuckAfterMs });

          // FN-7512: one guarded, autonomous-only bounded recovery tick at the
          // same passive seam FN-7511 uses for observation. Inert for every
          // other effective level ("off"/"observe"/"steer" already `continue`d
          // above). FN-7514: `PlannerRecoveryController.tick` now consults the
          // full human-control guard (user-paused OR autoMerge:false/
          // human-review) BEFORE any action/confirmation classification —
          // never throws.
          if (level === "autonomous" && this.plannerRecoveryController) {
            const decision = await this.plannerRecoveryController.tick(task, { settings: engineSettings });
            // FN-7551: bounded-recovery exhaustion is an escalation-worthy
            // event — emit exactly one `escalate` entry per (taskId, stage)
            // while the stage remains exhausted across subsequent polls.
            if (decision?.exhausted && decision.watchedStage) {
              this.emitOverseerEscalationDeduped(store, task.id, decision);
            }
          }

          /*
          FNXC:PlannerOversight 2026-07-14-18:11:
          Session-advisor log feed when effective enable resolves true for the task
          (task override → project default → workflow flag → off). Still needs model.
          */
          if (task.column === "in-progress" && this.sessionAdvisor) {
            const advisorEnabled = resolveTaskSessionAdvisorEnabled(
              task,
              engineSettings,
              workflowEffective.plannerOverseerAdvisorEnabled === true,
            ).enabled;
            if (advisorEnabled) {
              await this.feedSessionAdvisorFromAgentLogs(store, task);
            } else if (this.sessionAdvisor.getTaskAdvisorSnapshot(task.id).active) {
              // Operator turned it off mid-flight — drop runtime so no further model spend.
              this.sessionAdvisor.clear(task.id);
              this.sessionAdvisorLogCursor.delete(task.id);
            }
          }
        } catch {
          // Best-effort per-task — never let one task's failure block the poll.
        }
      }

      // Drop retained observations for tasks that have left the in-flight set
      // (moved to done/archived/failed/etc.) so the ring buffers don't leak.
      for (const taskId of overseer.getObservedTaskIds()) {
        if (!inFlightIds.has(taskId)) {
          overseer.clear(taskId);
          this.plannerRecoveryController?.clear(taskId);
          this.sessionAdvisor?.clear(taskId);
          this.sessionAdvisorLogCursor.delete(taskId);
          this.plannerObservationEmitDedup.delete(taskId);
          this.clearPlannerEscalationDedup(taskId);
        }
      }
    } catch {
      // Best-effort poll — degrade silently, never throw out of the interval.
    }
  }

  private stopPlannerOverseerPoll(): void {
    if (this.plannerOverseerPollTimer) {
      clearInterval(this.plannerOverseerPollTimer);
      this.plannerOverseerPollTimer = null;
    }
    this.sessionAdvisor?.clearAll();
    this.sessionAdvisorLogCursor.clear();
  }

  /**
   * FNXC:PlannerOversight 2026-07-13-23:05:
   * Construct the session-advisor service with model gate + LLM complete path
   * via createResolvedAgentSession (mock-safe under testMode).
   */
  private buildSessionAdvisorService(store: TaskStore): OverseerAdvisorService {
    /*
    FNXC:PlannerOversight 2026-07-14-00:10:
    Greptile P1: pass live engine settings into the advisor so
    evaluateOverseerHumanControl honors autoMerge:false / human-review
    (undefined settings previously defaulted autoMerge:true).
    */
    /*
    FNXC:PlannerOversight 2026-07-14-14:00:
    Shared per-task workflow settings loader for session-advisor resolve*
    callbacks (avoids three independent resolveEffectiveSettings shapes with
    diverging fallbacks). Still one store round-trip per callback invocation.
    */
    const loadWorkflowForTask = async (task: Task): Promise<Record<string, unknown>> =>
      resolveEffectiveSettings(store, { id: task.id }).catch(() => ({}) as Record<string, unknown>);

    const resolveAdvisorCwd = (task: Task | undefined): string => {
      if (task && typeof task.worktree === "string" && task.worktree.length > 0) return task.worktree;
      return this.config?.workingDirectory ?? process.cwd();
    };

    const service = new OverseerAdvisorService({
      store: store as ConstructorParameters<typeof OverseerAdvisorService>[0]["store"],
      /*
      FNXC:PlannerOversight 2026-07-14-18:11:
      Session LLM advisor enable: task.sessionAdvisorEnabled → project
      sessionAdvisorEnabledByDefault → workflow plannerOverseerAdvisorEnabled → false.
      Model still requires provider + model id from workflow settings.
      */
      resolveEnabled: async (task) => {
        const workflowEffective = await loadWorkflowForTask(task);
        const projectSettings = await store.getSettings().catch(() => undefined);
        return resolveTaskSessionAdvisorEnabled(
          task,
          projectSettings,
          workflowEffective.plannerOverseerAdvisorEnabled === true,
        ).enabled;
      },
      resolveLevel: async (task) => {
        const workflowEffective = await loadWorkflowForTask(task);
        return resolveEffectivePlannerOversightLevel(
          task.plannerOversightLevel,
          workflowEffective.plannerOversightLevel as string | undefined,
        );
      },
      resolveModel: async (task) => {
        const workflowEffective = await loadWorkflowForTask(task);
        const projectSettings = await store.getSettings().catch(() => undefined);
        const enabled = resolveTaskSessionAdvisorEnabled(
          task,
          projectSettings,
          workflowEffective.plannerOverseerAdvisorEnabled === true,
        ).enabled;
        if (!enabled) return null;
        const provider = String(workflowEffective.plannerOverseerAdvisorProvider ?? "").trim();
        const modelId = String(workflowEffective.plannerOverseerAdvisorModelId ?? "").trim();
        if (!provider || !modelId) return null;
        return { provider, modelId };
      },
      resolveCwd: (task) => resolveAdvisorCwd(task),
      agentFactory: async ({ taskId, model, systemPrompt, onAdvice }) => {
        const task = await store.getTask(taskId).catch(() => undefined);
        const cwd = resolveAdvisorCwd(task);
        return createParsingOverseerAgent({
          systemPrompt,
          onAdvice,
          complete: async (sys, user) => {
            try {
              const settings = await store.getSettings().catch(() => undefined);
              /*
              FNXC:PlannerOversight 2026-07-14-00:10 / 2026-07-14-14:00:
              CodeRabbit critical: do not use sessionPurpose "executor" (coding
              tool surface). Use "reviewer" + tools:"readonly" so the advisor is
              investigative-only; systemPrompt is the advisor contract; user
              batch is the session-update delta only.
              */
              /*
              FNXC:GrokCliRouting 2026-07-15-09:58:
              Session-advisor createResolvedAgentSession must forward the engine PluginRunner so grok-cli advisor models use the same no-visible-key CLI runtime path as chat/executor/merge.
              */
              const { session } = await createResolvedAgentSession({
                sessionPurpose: "reviewer",
                cwd: String(cwd),
                systemPrompt: sys,
                tools: "readonly",
                defaultProvider: model.provider,
                defaultModelId: model.modelId,
                settings,
                pluginRunner: this.getPluginRunner(),
              });
              try {
                await session.prompt(user);
                // FNXC:PlannerOversight 2026-07-14-14:00: runtime-agnostic assistant text extraction.
                return extractAdvisorAssistantText(session);
              } finally {
                try {
                  (session as { dispose?: () => void }).dispose?.();
                } catch {
                  /* ignore */
                }
              }
            } catch (err) {
              runtimeLog.warn(
                `session advisor complete failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
              );
              return '{"silence":true}';
            }
          },
        });
      },
    });

    // Best-effort initial settings; poll refreshes each cycle.
    void store.getSettings().then((s) => service.setSettings(s)).catch(() => undefined);
    return service;
  }

  /**
   * FNXC:PlannerOversight 2026-07-13-23:05:
   * Poll-backed log cursor: push only new agent-log rows into the session advisor.
   */
  private async feedSessionAdvisorFromAgentLogs(store: TaskStore, task: Task): Promise<void> {
    if (!this.sessionAdvisor) return;
    if (typeof store.getAgentLogs !== "function") return;
    try {
      await this.sessionAdvisor.ensureTask(task);
      // FNXC:PlannerOversight 2026-07-13-23:20:
      // getAgentLogs returns chronological entries (oldest→newest within the
      // trailing window). Cursor tracks durable log count so we only feed
      // new rows and never reverse/replay a sliding window incorrectly.
      const total =
        typeof store.getAgentLogCount === "function"
          ? await store.getAgentLogCount(task.id).catch(() => 0)
          : 0;
      if (!Number.isFinite(total) || total <= 0) return;

      const cursor = this.sessionAdvisorLogCursor.get(task.id);
      if (cursor === undefined) {
        // First observation: seed without replaying history (OMP seedTo parity).
        this.sessionAdvisorLogCursor.set(task.id, total);
        return;
      }
      if (total <= cursor) return;

      const need = Math.min(80, total - cursor);
      const logs = await store.getAgentLogs(task.id, { limit: need }).catch(() => [] as Array<{ type?: string; text?: string; detail?: string; agent?: string }>);
      if (!Array.isArray(logs) || logs.length === 0) {
        this.sessionAdvisorLogCursor.set(task.id, total);
        return;
      }
      this.sessionAdvisorLogCursor.set(task.id, total);
      await this.sessionAdvisor.onExecutorLogDelta(task.id, logs, task);
    } catch {
      /* best-effort */
    }
  }

  private scheduleMergeActiveReconciliation(intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }
    this.mergeActiveReconcileTimer = setInterval(() => {
      const cleared = this.reconcileStaleMergeActive();
      if (cleared > 0) {
        runtimeLog.warn(`Reconciled ${cleared} stale mergeActive entr${cleared === 1 ? "y" : "ies"}`);
      }
    }, intervalMs);
  }

  private async findActiveRecoveryFollowUp(
    store: TaskStore,
    parentTaskId: string,
    branch?: string,
  ): Promise<{ task: Task; reason: "parent" | "branch" } | null> {
    const tasks = await store.listTasks({ slim: true }).catch(() => [] as Task[]);
    const activeRecoveryTasks = tasks.filter(
      (task) =>
        task.column !== "done" &&
        task.column !== "archived" &&
        task.sourceType === "recovery",
    );

    const sameParent = activeRecoveryTasks.find(
      (task) => task.sourceParentTaskId === parentTaskId,
    );
    if (sameParent) return { task: sameParent, reason: "parent" };

    if (branch) {
      const sameBranch = activeRecoveryTasks.find((task) => task.branch === branch);
      if (sameBranch) return { task: sameBranch, reason: "branch" };
    }

    return null;
  }

  private async drainMergeQueue(): Promise<void> {
    if (this.mergeRunning) return;
    this.mergeRunning = true;

    try {
      this.reconcileStaleMergeActive();
      const store = this.runtime.getTaskStore();
      /*
      FNXC:AutoMergeLifecycle 2026-07-10 (fork review, TrinaryCompute/postgres-v057):
      Root the merge git operations at the STORE's project root, not the engine
      config's workingDirectory. In the in-process dashboard the config value
      resolved to process.cwd() (the dashboard dir), so
      `git rev-parse --verify refs/heads/fusion/<task>` ran in the wrong repo and
      every merge aborted with `branch "fusion/<task>" is missing — work appears
      lost`. The store is project-rooted (see startup-factory Step 7); the
      config fallback keeps engine test fakes (no getRootDir) green and is a
      no-op in deployments where the two already agree.
      */
      const cwd = store.getRootDir?.() ?? this.config.workingDirectory;

      while (this.mergeQueue.length > 0 && !this.shuttingDown) {
        const shadowCandidateTaskId = await this.getShadowMergeRequestCandidateId();
        const taskId = await this.pickNextMergeTaskId(store);
        if (!taskId) break;
        const shadowSettings = await store.getSettings();
        if (shadowSettings.mergeRequestContractShadowEnabled === true) {
          this.emitMergeRequestShadowDequeueParity(taskId, shadowCandidateTaskId);
          const mergeRequest = await store.getMergeRequestRecordAsync(taskId);
          if (mergeRequest?.state === "manual-required" || mergeRequest?.state === "cancelled" || mergeRequest?.state === "succeeded" || mergeRequest?.state === "exhausted") {
            continue;
          }
          if (mergeRequest && (mergeRequest.state === "queued" || mergeRequest.state === "retrying")) {
            if (mergeRequest.state === "retrying") {
              await store.transitionMergeRequestState(taskId, "queued", { attemptCount: mergeRequest.attemptCount, lastError: mergeRequest.lastError });
            }
            await store.transitionMergeRequestState(taskId, "running", { attemptCount: mergeRequest.attemptCount, lastError: mergeRequest.lastError });
          }
          if (mergeRequest?.state === "running") {
            const ageMs = Date.now() - Date.parse(mergeRequest.updatedAt);
            if ((mergeRequest.attemptCount ?? 0) >= ProjectEngine.MAX_AUTO_MERGE_TRANSIENT_RETRIES && ageMs >= ProjectEngine.MERGE_REQUEST_RETRY_EXHAUSTED_AGE_MS) {
              await store.transitionMergeRequestState(taskId, "exhausted", {
                attemptCount: mergeRequest.attemptCount,
                lastError: mergeRequest.lastError ?? "merge-request-running-age-cap-exhausted",
              });
              await store.logEntry(taskId, "Merge-request retry cap reached in running state; marked merge request exhausted without executor rebound");
              continue;
            }
          }
        }
        // pickNextMergeTaskId awaits store.getTask; re-check shutdown so we
        // don't start a merge whose queue entry was cleared by stop().
        if (this.shuttingDown) break;
        const hasManualResolver = this.hasMergeResolvers(taskId);
        try {
          // Manual merges (onMerge) skip auto-merge eligibility checks
          if (!hasManualResolver) {
            // Re-check autoMerge and pause before each merge
            const settings = await store.getSettings();
            const maxAutoMergeRetries = resolveMaxAutoMergeRetries(settings);
            if (settings.globalPause || settings.enginePaused) {
              runtimeLog.log(
                `Auto-merge skipping ${taskId} — ${settings.globalPause ? "global pause" : "engine paused"} active`,
              );
              continue;
            }
            const task = await store.getTask(taskId);
            if (!task || task.column !== "in-review") {
              continue;
            }
            if (!(await this.allowInReviewMergeProcessing(task, settings, store))) {
              runtimeLog.log(`Auto-merge skipping ${taskId} — autoMerge disabled`);
              continue;
            }
            if (task.paused && !task.mergeDetails?.mergeConfirmed) {
              runtimeLog.log(`Auto-merge skipping ${taskId} — task is paused`);
              continue;
            }

            // Intentional cast to access Task properties needed by merge validation

            if (!this.canMergeTask(task as any, maxAutoMergeRetries)) {
              continue;
            }

            // Fast path: merge already confirmed (e.g. task was moved back to
            // in-review by auto-recovery after a successful merge) — just
            // complete the task without re-running the merge process.
            if (task.mergeDetails?.mergeConfirmed) {
              /*
              FNXC:Workspace 2026-06-22-05:10 (Phase C review B2 — fast-path must skip workspace tasks):
              The FN-5627 reachability gate below runs `git cat-file -e <commitSha>` in cwd = the
              project/workspace ROOT. For a WORKSPACE task, `finalizeWorkspaceTask` records
              `mergeDetails.commitSha` = the FIRST sorted sub-repo's squash sha, which lives in
              `join(workspaceRoot, <repo>)`, NOT in the workspace root (which is not even a git repo).
              So `cat-file -e` against the root cwd ALWAYS reports commit-missing → the gate would
              clear `mergeConfirmed` and demote/park a FULLY-MERGED workspace task. Workspace tasks
              are merge-verified by each sub-repo's persisted `landedSha`, not a single root-cwd
              commitSha, so the root-cwd reachability gate does not apply to them. SKIP the gate for
              workspace tasks and take the fast-path. (Per-sub-repo cwd reachability verification is a
              larger change deferred past Phase C; skipping here is the correct minimal fix.)
              */
              // FN-5627: Reachability defense-in-depth. The merger has a TOCTOU
              // window where `mergeConfirmed: true` can be persisted to the task
              // row before `git update-ref refs/heads/<integration>` actually
              // advances the integration branch. If ref-advance then fails for any
              // reason (lock contention, hook rejection, misclassified errors via
              // merger-ref-update-advance.ts string heuristic), the task row is
              // poisoned. Without this gate, the next auto-merge tick would
              // silently promote the poisoned row to `done` — exactly the
              // false-positive completion class that lost FN-5612/5613/5614/5616/
              // 5623/5625 work on 2026-05-27/28.
              const branchGroupForFastPathCandidate = isSharedBranchGroupMemberIntegration(task)
                ? (store as any).getBranchGroup?.(task.branchContext?.groupId)
                : null;
              /*
              FNXC:AutoMergeHold 2026-07-09-16:58:
              FN-7750: merge-confirmed fast-path rerouting to a branch-group integration branch is safe only for a live/open group. A missing or terminal group must leave the row on its stored standalone target instead of reviving a stale group route that could bypass the manual merge hold.
              */
              const branchGroupForFastPath = isLiveSharedBranchGroupMemberIntegration(task, branchGroupForFastPathCandidate)
                ? branchGroupForFastPathCandidate
                : null;
              const routedFastPathTarget = branchGroupForFastPath?.branchName?.trim();
              const integrationBranchForGate =
                routedFastPathTarget || task.mergeDetails.mergeTargetBranch || task.baseBranch || "main";
              const expectedFastPathTargetSource = routedFastPathTarget
                ? "branch-group-integration"
                : task.mergeDetails.mergeTargetSource;
              if (routedFastPathTarget && task.mergeDetails.mergeTargetBranch && task.mergeDetails.mergeTargetBranch !== routedFastPathTarget) {
                runtimeLog.warn(
                  `Auto-merge: ${taskId} merge-confirmed fast-path rerouting shared-group member from ${task.mergeDetails.mergeTargetBranch} to ${routedFastPathTarget}`,
                );
              }
              if (!isWorkspaceTask(task)) {
              const reachability = await verifyMergeConfirmedReachability({
                commitSha: task.mergeDetails.commitSha,
                integrationBranch: integrationBranchForGate,
                cwd,
              });
              if (!reachability.reachable) {
                /*
                 * FNXC:AutoMergeRetries 2026-06-17-04:20:
                 * Fast-path recovery must consume the resolved project retry cap, not a class constant, because poisoned merge-confirmed rows otherwise park or retry at the old fixed value after operators tune maxAutoMergeRetries.
                 */
                const sha = task.mergeDetails.commitSha || "";
                const shortSha = sha ? sha.slice(0, 8) : "<no-sha>";
                const currentRetries = task.mergeRetries ?? 0;
                const budgetExhausted = currentRetries >= maxAutoMergeRetries;

                // Clear poisoned mergeDetails fields. These persisted before
                // the integration ref-advance actually succeeded (pre-FN-5627
                // optimistic-write TOCTOU). Drop the lies but keep diagnostic
                // context (mergeTargetBranch, attemptsMade, etc.).
                const cleanedMergeDetails = {
                  ...task.mergeDetails,
                  mergeConfirmed: false,
                  commitSha: undefined,
                  mergedAt: undefined,
                  landedFiles: undefined,
                  filesChanged: undefined,
                  insertions: undefined,
                  deletions: undefined,
                  noOpVerifiedShortCircuit: undefined,
                  landedFilesAttributionRestricted: undefined,
                };

                if (budgetExhausted) {
                  // Retry budget exhausted — terminal park for manual review.
                  // FN-4538-class invariant: failed `in-review` blockers at the
                  // retry ceiling are recognized by downstream `clearStaleBlockedBy`
                  // fast paths (FN-5488), so dependents won't deadlock.
                  const errorMsg =
                    `Auto-merge fast-path refused after ${currentRetries} attempts: commit ${shortSha} is not reachable from ` +
                    `${integrationBranchForGate} (${reachability.reason}). Manual review required.`;
                  runtimeLog.warn(
                    `Auto-merge: ${taskId} fast-path REFUSED + budget exhausted — ${reachability.reason}: ${reachability.diagnostic}`,
                  );
                  await store.logEntry(
                    taskId,
                    `[FN-5627] Auto-merge fast-path refused (retry budget exhausted) — ${errorMsg}`,
                  );
                  await store.updateTask(taskId, {
                    mergeDetails: cleanedMergeDetails,
                    status: "failed",
                    error: errorMsg,
                  });
                  try {
                    const auditor = createRunAuditor(store, {
                      runId: generateSyntheticRunId("merger-fast-path-refused", taskId),
                      agentId: "merger",
                      taskId,
                      phase: "auto-merge-fast-path-gate",
                    });
                    await auditor.database({
                      type: "merger:fast-path-blocked-foreign-commit",
                      target: taskId,
                      metadata: {
                        taskId,
                        commitSha: sha,
                        integrationBranch: integrationBranchForGate,
                        reason: reachability.reason,
                        diagnostic: reachability.diagnostic,
                        mergeRetries: currentRetries,
                        budgetExhausted: true,
                      },
                    });
                  } catch (auditErr) {
                    runtimeLog.warn(
                      `Auto-merge: ${taskId} fast-path audit emit failed: ${
                        auditErr instanceof Error ? auditErr.message : String(auditErr)
                      }`,
                    );
                  }
                  continue;
                }

                // FN-5627 auto-recovery: clear the poisoned mergeDetails,
                // increment the merge retry counter, and re-enqueue. The next
                // dequeue runs a fresh `runAiMerge` against the task branch —
                // because the merger's TOCTOU is now fixed, the redo either
                // lands cleanly or fails with a real merger error that surfaces
                // through normal lifecycle. We don't need an executor to be
                // re-engaged for this kind of recovery; the branch already
                // has the work, it just needs to be re-applied to the
                // integration tip.
                const nextRetries = currentRetries + 1;
                runtimeLog.warn(
                  `Auto-merge: ${taskId} fast-path REFUSED — auto-recovering (attempt ${nextRetries}/${maxAutoMergeRetries}): ${reachability.reason}: ${reachability.diagnostic}`,
                );
                // Prefix MUST be "Auto-recovered:" so NotificationService's
                // maybeSuppressTransientFailedNotification cancels the pending
                // ntfy fired off the underlying task:failed event.
                await store.logEntry(
                  taskId,
                  `Auto-recovered: fast-path refused — cleared poisoned mergeDetails (commit ${shortSha} not reachable from ${integrationBranchForGate}, ${reachability.reason}). Re-enqueueing for fresh merge attempt ${nextRetries}/${maxAutoMergeRetries} [FN-5627].`,
                );
                await store.updateTask(taskId, {
                  mergeDetails: cleanedMergeDetails,
                  mergeRetries: nextRetries,
                  status: null,
                  error: null,
                });
                try {
                  const auditor = createRunAuditor(store, {
                    runId: generateSyntheticRunId("merger-fast-path-auto-recovered", taskId),
                    agentId: "merger",
                    taskId,
                    phase: "auto-merge-fast-path-gate",
                  });
                  await auditor.database({
                    type: "merger:fast-path-auto-recovered",
                    target: taskId,
                    metadata: {
                      taskId,
                      commitSha: sha,
                      integrationBranch: integrationBranchForGate,
                      reason: reachability.reason,
                      diagnostic: reachability.diagnostic,
                      mergeRetries: nextRetries,
                      maxRetries: maxAutoMergeRetries,
                    },
                  });
                } catch (auditErr) {
                  runtimeLog.warn(
                    `Auto-merge: ${taskId} fast-path audit emit failed: ${
                      auditErr instanceof Error ? auditErr.message : String(auditErr)
                    }`,
                  );
                }
                // Re-enqueue this task for the next cycle. We continue past
                // the current iteration because `task` is a stale snapshot;
                // the re-enqueued tick reads fresh state with mergeConfirmed=false
                // and falls through to the normal `runAiMerge` path.
                this.internalEnqueueMerge(taskId);
                continue;
              }
              } // end !isWorkspaceTask reachability gate (B2): workspace tasks skip the root-cwd commitSha check
              const blockerReason = getTaskHardMergeBlocker({
                ...(task as Task),
                // Merge-confirmed tasks have already landed. Treat stale merge
                // in-flight statuses as soft state to clear during finalization,
                // not hard blockers that park an otherwise confirmed merge as failed.
                paused: false,
                status: task.status === "merging" || task.status === "merging-pr" ? undefined : task.status,
                error: undefined,
              });
              if (blockerReason) {
                await store.updateTask(taskId, {
                  status: "failed",
                  error: `Merge confirmed but finalization blocked: ${blockerReason}`,
                });
                await store.logEntry(
                  taskId,
                  `Merge confirmed finalization blocked — ${blockerReason}. Task parked in in-review for manual completion.`,
                );
                runtimeLog.warn(
                  `Auto-merge: ${taskId} merge-confirmed finalize blocked — ${blockerReason}`,
                );
                continue;
              }

              if (routedFastPathTarget && (
                task.mergeDetails.mergeTargetBranch !== routedFastPathTarget ||
                task.mergeDetails.mergeTargetSource !== "branch-group-integration"
              )) {
                await store.updateTask(taskId, {
                  mergeDetails: {
                    ...task.mergeDetails,
                    mergeTargetBranch: routedFastPathTarget,
                    mergeTargetSource: expectedFastPathTargetSource,
                  },
                });
                task.mergeDetails = {
                  ...task.mergeDetails,
                  mergeTargetBranch: routedFastPathTarget,
                  mergeTargetSource: expectedFastPathTargetSource,
                } as typeof task.mergeDetails;
              }
              if (routedFastPathTarget && branchGroupForFastPath?.id) {
                try {
                  await Promise.resolve((store as any).recordBranchGroupMemberLanded?.(branchGroupForFastPath.id, {
                    taskId,
                    branchName: routedFastPathTarget,
                    worktreePath: task.worktree ?? null,
                    status: "open",
                  }));
                } catch (landingErr) {
                  runtimeLog.warn(
                    `Auto-merge: ${taskId} failed to record shared-group member landing: ${
                      landingErr instanceof Error ? landingErr.message : String(landingErr)
                    }`,
                  );
                }
              }

              runtimeLog.log(
                `Auto-merge: ${taskId} already has mergeConfirmed — refreshing row and finalizing to done`,
              );
              await store.logEntry(
                taskId,
                "Merge already confirmed; refreshing row and completing task (recovered from post-merge state inconsistency)",
              );
              const auditor = createRunAuditor(store, {
                runId: generateSyntheticRunId("merger-fast-path-finalize", taskId),
                agentId: "merger",
                taskId,
                phase: "auto-merge-fast-path-finalize",
              });
              /*
              FNXC:AutoMergeFinalization 2026-06-23-03:29:
              The merge-confirmed fast path must pass its in-memory merge proof into the shared finalizer because test stores can return stale rows without commit evidence. Reusing the proven task/result keeps landed rows from being parked as missing merge confirmation.
              */
              const finalization = await finalizeProvenAutoMergeTask({
                store,
                taskId,
                result: {
                  task,
                  ok: true,
                  merged: true,
                  commitSha: task.mergeDetails?.commitSha,
                  noOp: task.mergeDetails?.noOpMerge === true,
                  reason: task.mergeDetails?.noOpReason,
                  mergeConfirmed: task.mergeDetails?.mergeConfirmed === true,
                } as MergeResult,
                rootDir: cwd,
                audit: auditor,
                auditAgentId: "merger",
                auditPhase: "auto-merge-fast-path-finalize",
                source: "merge-confirmed-fast-path",
                log: (message) => runtimeLog.warn(message),
              });
              if (finalization.outcome === "blocked") {
                runtimeLog.warn(
                  `Auto-merge: ${taskId} merge-confirmed finalize blocked — ${finalization.reason ?? "unknown"}`,
                );
                await store.logEntry(
                  taskId,
                  `Merge confirmed finalization blocked — ${finalization.reason ?? "unknown"}. Task parked for manual completion.`,
                );
                continue;
              }
              const mergedTask = finalization.task ?? (await store.getTask(taskId).catch(() => null)) ?? task;
              store.emit("task:merged", {
                task: mergedTask,
                branch: mergedTask.branch ?? task.branch ?? "",
                merged: true,
                worktreeRemoved: false,
                branchDeleted: false,
                mergeConfirmed: true,
                mergedAt: mergedTask.mergeDetails?.mergedAt,
                mergeTargetBranch: mergedTask.mergeDetails?.mergeTargetBranch,
                mergeTargetSource: mergedTask.mergeDetails?.mergeTargetSource,
              } as MergeResult);
              continue;
            }

            // Auto-heal verification buffer failures by resetting retry counter

            if (this.hasAutoHealableVerificationBufferFailure(task as any, maxAutoMergeRetries)) {
              await store.logEntry(
                taskId,
                "Auto-healing stale deterministic verification buffer failure; retrying merge verification",
              );
              await store.updateTask(taskId, { mergeRetries: 0, error: null, status: null });
            } else if (
              (task.mergeRetries ?? 0) >= maxAutoMergeRetries &&

              this.isRetryCooldownElapsed(task as any)
            ) {
              await store.logEntry(
                taskId,
                `Auto-merge retry cooldown elapsed (${Math.round(ProjectEngine.AUTO_MERGE_COOLDOWN_MS / 60000)}m idle); resetting retries for another attempt`,
              );
              await store.updateTask(taskId, { mergeRetries: 0 });
            }
          }

          const settings = await store.getSettings();

          // Cross-process guard: check if another process is already merging a
          // task for this project. The in-memory mergeQueue serializes within
          // this process, but multiple processes (e.g. dashboard + serve) share
          // the same SQLite database and can race.
          const activeMergingTask = await store.getActiveMergingTask(taskId);
          if (activeMergingTask) {
            const retryMs = settings.pollIntervalMs ?? 15_000;
            runtimeLog.log(
              `Merge deferred for ${taskId} — ${activeMergingTask} is already merging (cross-process guard, retry in ${retryMs / 1000}s)`,
            );
            // Temporarily stash the waiters so the finally block doesn't
            // prematurely resolve them. The re-enqueue restores them.
            const stashedResolvers = this.takeMergeResolvers(taskId);
            // Re-queue after the poll interval so we retry once the other merge finishes
            setTimeout(() => {
              if (this.shuttingDown) {
                for (const r of stashedResolvers) r.reject(new Error("Engine shutting down"));
                return;
              }
              for (const r of stashedResolvers) this.addMergeResolver(taskId, r);
              this.internalEnqueueMerge(taskId);
            }, retryMs);
            continue;
          }

          const mergeStrategy = this.options.getMergeStrategy?.(settings) ?? "direct";
          const promotionSettings = {
            autoMerge: settings.autoMerge,
            globalPause: settings.globalPause,
            enginePaused: settings.enginePaused,
            mergeStrategy: settings.mergeStrategy,
            integrationBranch: settings.integrationBranch,
            baseBranch: settings.baseBranch,
          };
          const attemptBranchGroupPromotion = async (taskForPromotion: Task | null): Promise<void> => {
            // groupId is optional on TaskBranchContext (non-shared members carry none);
            // isSharedBranchGroupMemberIntegration guarantees it semantically, but capture
            // it explicitly so TypeScript narrows.
            const promotionGroupId = taskForPromotion?.branchContext?.groupId;
            if (!taskForPromotion || !promotionGroupId || !isSharedBranchGroupMemberIntegration(taskForPromotion)) {
              return;
            }
            try {
              await promoteBranchGroup({
                store,
                rootDir: cwd,
                groupId: promotionGroupId,
                settings: promotionSettings,
                createGroupPr: this.options.createGroupPr,
                recordAudit: async (event) => {
                  await store.recordRunAuditEvent({
                    domain: event.domain as any,
                    mutationType: event.mutationType,
                    target: event.target,
                    metadata: event.metadata,
                  } as any);
                },
              });
            } catch (promotionError) {
              const message =
                promotionError instanceof Error ? promotionError.message : String(promotionError);
              runtimeLog.warn(
                `Branch-group promotion evaluation failed for ${taskId}: ${message}`,
              );
              // Fix #4 (1): a promotion failure here (e.g. createGroupPr throwing
              // after the local integration merge) must NOT be swallowed silently —
              // the group stays active/prState:none and is only recoverable via an
              // explicit re-promote. Record an audit event so the failure is
              // observable and operators/the dashboard can drive recovery.
              try {
                await store.recordRunAuditEvent({
                  taskId,
                  agentId: "merger",
                  runId: `merge-${taskId}`,
                  domain: "git",
                  mutationType: "merge:branch-group-promotion-failed",
                  target: promotionGroupId,
                  metadata: {
                    groupId: promotionGroupId,
                    taskId,
                    error: message,
                  },
                });
              } catch {
                // best-effort audit
              }
            }
          };

          // FNXC:Workspace 2026-07-05-00:00 (FN-7610):
          // The PR-merge branch previously had NO isWorkspaceTask guard, so a
          // workspace-mode task (non-empty task.workspaceWorktrees) reaching
          // auto-merge under project mergeStrategy:"pull-request" would
          // unconditionally call processPullRequestMerge -> getCurrentRepo(cwd),
          // which throws "could not determine repository" because the workspace
          // root is a plain container of independent git sub-repos, not itself a
          // git repo. That looped in-review <-> failed until retries exhausted.
          // Hoist the workspace check here so workspace tasks ALWAYS fall through
          // to the existing direct/else `rawMerge` branch below, whose
          // isWorkspaceTask(mergeTask) routing already calls landWorkspaceTask
          // correctly, regardless of the configured mergeStrategy — until true
          // per-repo PR merge for workspace tasks (master-plan U6) ships.
          const mergeCandidate = await store.getTask(taskId).catch(() => null);
          const routeWorkspaceDirect = !!mergeCandidate && isWorkspaceTask(mergeCandidate);

          // FNXC:MergeQueue 2026-07-15-10:05: Wait for any orphan body from a prior abort race before claiming the next generation.
          await this.awaitPriorMergeBodySettle();

          if (mergeStrategy === "pull-request" && this.options.processPullRequestMerge && !routeWorkspaceDirect) {
            /*
            FNXC:MergeQueue 2026-07-15-10:05:
            PR merge dispatch shares the single-flight pump. Race the PR body with abort so pause/reclaim unblocks drainMergeQueue even when processPullRequestMerge ignores cooperative abort.
            */
            const abortSignal = this.claimActiveMerge(taskId);
            runtimeLog.log(`${hasManualResolver ? "Manual" : "Auto"}-merge processing PR flow for ${taskId}...`);
            const result = await this.runAbortableMergeBody(
              () =>
                this.options.processPullRequestMerge!(
                  store,
                  cwd,
                  taskId,
                  (this.runtime as any).worktreePool,
                ),
              abortSignal,
              taskId,
            );
            if (result === "merged") {
              runtimeLog.log(`${hasManualResolver ? "Manual" : "Auto"}-merge PR merged: ${taskId}`);
              const mergedTask = await store.getTask(taskId).catch(() => null);
              if (mergedTask) {
                store.emit("task:merged", {
                  task: mergedTask,
                  branch: mergedTask.branch ?? "",
                  merged: true,
                  worktreeRemoved: false,
                  branchDeleted: false,
                  mergeConfirmed: mergedTask.mergeDetails?.mergeConfirmed,
                  mergedAt: mergedTask.mergeDetails?.mergedAt,
                  mergeTargetBranch: mergedTask.mergeDetails?.mergeTargetBranch,
                } as MergeResult);
              }
              await attemptBranchGroupPromotion(mergedTask);
            } else if (result === "waiting") {
              runtimeLog.log(`${hasManualResolver ? "Manual" : "Auto"}-merge PR waiting: ${taskId}`);
            }
            if (hasManualResolver) {
              // PR merge path doesn't produce a full MergeResult — fetch the task
              // and construct one so the dashboard endpoint can respond.
              const prTask = await store.getTask(taskId).catch(() => null);
              this.resolveMergeResolvers(taskId, {
                task: prTask!,
                branch: prTask?.branch ?? "",
                merged: result === "merged",
                worktreeRemoved: false,
                branchDeleted: false,
              } as MergeResult);
            }
          } else {
            // Direct merge via AI agent, gated by semaphore
            runtimeLog.log(`${hasManualResolver ? "Manual" : "Auto"}-merge merging ${taskId}...`);

            const semaphore = (this.runtime as any).projectSemaphore ?? (this.runtime as any).globalSemaphore;

            const pool = (this.runtime as any).worktreePool;

            const agentStore = (this.runtime as any).agentStore;

            const usageLimitPauser = (this.runtime as any).usageLimitPauser;

            const rawMerge = async () => {
              const abortSignal = this.claimActiveMerge(taskId);
              /*
              FNXC:GrokCliRouting 2026-07-15-09:45:
              AI merge creates sessions via createResolvedAgentSession with the same Grok CLI no-visible-key auto-derive seam as chat/executor. Without pluginRunner, getRuntimeById("grok") is unavailable and grok-cli merger/fallback selections throw "Grok CLI models require the bundled Grok CLI runtime" even when chat works (ChatManager already receives engine.getPluginRunner()). Forward the engine PluginRunner so merge can route to the logged-in grok CLI like every other lane.
              */
              const mergerOptions = {
                manual: hasManualResolver,
                pool,
                usageLimitPauser,
                agentStore,
                pluginRunner: this.getPluginRunner(),
                signal: abortSignal,
                syncGroupPr: this.options.syncGroupPr,
                onSession: (session: { dispose: () => void }) => {
                  this.activeMergeSession = session;
                },
              };
              /*
              FNXC:MergeQueue 2026-07-15-09:41:
              Always race the merge body with the pause/cancel abort signal. Cooperative abort inside runAiMerge is best-effort; without this outer race a wedged agent tool parks drainMergeQueue forever (no merging badge board-wide).
              FNXC:MergeQueue 2026-07-15-10:05:
              Track the underlying body so abort-race reject does not allow a concurrent second generation while orphan work still runs.
              */
              return this.runAbortableMergeBody(async () => {
              // FNXC:Workspace 2026-06-21-23:40 (Phase C U1, KTD2):
              // Engine merge dispatch door. A workspace-mode task (non-empty
              // `workspaceWorktrees`) routes to the per-repo merge loop
              // `landWorkspaceTask` (Phase C U1) instead of the singular runAiMerge —
              // each sub-repo lands on its own LOCAL integration ref, no push. The
              // U0 R7 throw is REPLACED by this routing (the runAiMerge chokepoint
              // + store.mergeTask/aiMergeTask keep throwing as defense-in-depth).
              // FAST-FAIL note preserved: a getTask failure is swallowed to null and
              // routing falls through to runAiMerge, whose chokepoint guard re-reads
              // the task and is the authoritative workspace enforcement.
              const mergeTask = await store.getTask(taskId).catch(() => null);
              const isWorkspaceMerge = !!mergeTask && isWorkspaceTask(mergeTask);
              if (isWorkspaceMerge) {
                // FNXC:Workspace 2026-06-22-00:30 (Phase C U2, KTD3):
                // Land each acquired sub-repo on its own local integration ref;
                // `landWorkspaceTask` records each landed `landedSha`, skips
                // already-landed repos on a retry (idempotent), and on full success
                // finalizes the task to `done` EXACTLY ONCE. On a PARTIAL land it does
                // NOT finalize — it returns `allLanded:false`, which we surface as a
                // WorkspacePartialLandError so the catch-block auto-retry consumes a
                // mergeRetry and re-runs (skipping landed repos) up to MAX, then parks.
                const settings = await store.getSettings().catch(() => ({}) as Settings);
                const workspaceResult = await landWorkspaceTask(
                  store,
                  mergeTask!,
                  cwd,
                  { ...mergerOptions, allowDirtyLocalCheckoutSync: settings.merger?.allowDirtyLocalCheckoutSync === true },
                );
                if (!workspaceResult.allLanded) {
                  // FNXC:Workspace 2026-06-22-05:10 (Phase C review B7):
                  // Throw the real exported WorkspacePartialLandError class (not a bare Error with
                  // a patched `.name`) so the catch below can match via `instanceof` and read the
                  // typed payload (landedCount, failedRepos).
                  const failed = workspaceResult.repos.filter((r) => r.status === "failed");
                  const landedCount = workspaceResult.repos.filter((r) => r.status === "landed").length;
                  const detail = failed.map((r) => `${r.repo}: ${r.error ?? "land failed"}`).join("; ");
                  throw new WorkspacePartialLandError(
                    landedCount,
                    failed.map((r) => r.repo),
                    `Workspace partial land for ${taskId}: ${landedCount} repo(s) landed, ${failed.length} failed — ${detail}`,
                  );
                }
                // Finalized to done by landWorkspaceTask; report the merge as merged so
                // the success path (retry reset + branch-group promotion) runs normally.
                const latest = await store.getTask(taskId).catch(() => mergeTask!);
                const anyLanded = workspaceResult.repos.some((r) => r.status === "landed");
                return {
                  task: latest ?? mergeTask!,
                  branch: mergeTask!.branch ?? "",
                  merged: anyLanded,
                  noOp: !anyLanded,
                  ok: true,
                  commitSha: workspaceResult.repos.find((r) => r.status === "landed")?.landedSha,
                  mergeConfirmed: anyLanded,
                  worktreeRemoved: false,
                  branchDeleted: false,
                } as MergeResult;
              }

              // FNXC:MergerUnification 2026-06-21-19:05:
              // Master-plan U0 collapsed the merge dispatch: `runAiMerge` (the
              // FN-5633 clean-room AI merge path) is the SOLE merge path. The
              // `merger.mode` setting is inert — we no longer branch on it. A
              // resolved "deterministic" value only triggers a once-per-project
              // deprecation warning (warn, never error) before proceeding via
              // `runAiMerge`; the warning is keyed by project root (cwd) so each
              // stale project warns once rather than just the first project seen.
              const settings = await store.getSettings().catch(() => ({}) as Settings);
              if (
                normalizeMergerMode(settings.merger?.mode) === "deterministic"
                && !deterministicMergerModeDeprecationWarnedProjects.has(cwd)
              ) {
                deterministicMergerModeDeprecationWarnedProjects.add(cwd);
                runtimeLog.warn(
                  'merger.mode "deterministic" is deprecated and inert: all merges now use the unified AI merge path (runAiMerge). Remove the setting; the legacy aiMergeTask pipeline is soft-deprecated.',
                );
              }
              const mergeOptionsWithSettings = {
                ...mergerOptions,
                allowDirtyLocalCheckoutSync: settings.merger?.allowDirtyLocalCheckoutSync === true,
              };
              return runAiMerge(store, cwd, taskId, mergeOptionsWithSettings);
              }, abortSignal, taskId);
            };

            let result: MergeResult;
            if (semaphore) {
              result = await semaphore.run(rawMerge, PRIORITY_MERGE);
            } else {
              result = await rawMerge();
            }

            this.activeMergeSession = null;
            runtimeLog.log(`${hasManualResolver ? "Manual" : "Auto"}-merge merged: ${taskId}`);

            if (hasManualResolver) {
              this.resolveMergeResolvers(taskId, result);
            }

            // Reset retries on success
            const latestTask = await store.getTask(taskId).catch(() => null);
            if (latestTask?.mergeRetries && latestTask.mergeRetries > 0) {
              await store.updateTask(taskId, { mergeRetries: 0 });
            }
            // FNXC:Workspace 2026-06-22-05:10 (Phase C review B4): clear the in-memory busy
            // re-enqueue counter once the merge succeeds so a later unrelated contention starts fresh.
            this.workspaceBusyReenqueues.delete(taskId);

            await attemptBranchGroupPromotion(latestTask);
          }
        } catch (err: unknown) {
          this.activeMergeSession = null;
          const errorMsg = err instanceof Error ? err.message : String(err);
          const mergeWasAborted = err instanceof Error && err.name === "MergeAbortedError";

          if (mergeWasAborted) {
            runtimeLog.log(`${hasManualResolver ? "Manual" : "Auto"}-merge aborted for ${taskId}: ${errorMsg}`);
            this.mergeAbortController = null;
            if (hasManualResolver) {
              this.rejectMergeResolvers(taskId, err instanceof Error ? err : new Error(errorMsg));
            } else {
              await store.updateTask(taskId, { status: null }).catch(() => undefined);
            }
            continue;
          }

          // FNXC:Workspace 2026-06-21-19:40:
          // R7 workspace merge-boundary park (master-plan U0). A WorkspaceTaskMergeError
          // is a PERMANENT config error (workspace task hit a merge door before the
          // per-repo merge loop exists — master-plan U6), NOT a transient merge failure.
          // Park with status:"failed" so the auto-merge cooldown sweep STOPS re-attempting:
          // `canMergeTask` short-circuits on status==="failed". (Parking with status:null +
          // mergeRetries:0 passes every eligibility gate, so the sweep re-enqueues every tick
          // → tight WorkspaceTaskMergeError re-throw/re-park loop.) Keep mergeRetries:0 (not
          // the cap) so a human's manual merge after the config is addressed is not blocked by
          // exhausted retries — and manual merge flows through the manual-resolver branch
          // (rejectMergeResolvers), which bypasses canMergeTask, so "failed" never blocks it.
          // Detect by err.name (matches the VerificationError/MergeAbortedError convention and
          // is robust across the @fusion/core→@fusion/engine package boundary).
          const isWorkspaceMergeError =
            err instanceof Error && err.name === "WorkspaceTaskMergeError";
          if (isWorkspaceMergeError) {
            runtimeLog.error(
              `${hasManualResolver ? "Manual" : "Auto"}-merge blocked for ${taskId}: workspace-mode tasks cannot merge until per-repo merge support (master-plan U6) lands; parking as failed (manual retry still works) without exhausting mergeRetries: ${errorMsg}`,
            );
            await store
              .logEntry(taskId, `Merge blocked: ${errorMsg}`, "WorkspaceTaskMergeError")
              .catch(() => undefined);
            if (hasManualResolver) {
              this.rejectMergeResolvers(taskId, err instanceof Error ? err : new Error(errorMsg));
            } else {
              await store
                .updateTask(taskId, { status: "failed", mergeRetries: 0, error: errorMsg })
                .catch(() => undefined);
            }
            continue;
          }

          /*
          FNXC:Workspace 2026-06-22-05:10 (Phase C review B4/B7 — busy contention split from real partial land):
          A `WorkspaceRepoLandBusyError` (a second task holds the same sub-repo's land lease) is
          TRANSIENT contention, not a land failure: re-enqueue it with backoff WITHOUT consuming the
          persisted `mergeRetries` quota, bounded separately by `workspaceBusyReenqueues`
          (WORKSPACE_BUSY_MAX_REENQUEUES). This stops two contending tasks from exhausting all merge
          retries on busy-errors before either makes a real land attempt, then parking a never-failed
          task. Detect via `instanceof` now that both are exported classes (B7).
          */
          /*
          FNXC:Workspace 2026-06-22-09:30 (Phase C review B7b — manual-merge busy must NOT burn mergeRetries):
          A manual merge (hasManualResolver) that hits sub-repo land contention is the SAME transient
          lease contention as the auto path, NOT a real land failure. Without this branch it falls
          through to the generic handler below, which increments the persisted `mergeRetries` quota —
          so a user mashing the merge button during contention could exhaust retries before any real
          land attempt. Reject the resolver so the busy error surfaces to the user (they can retry),
          WITHOUT consuming a mergeRetry. No re-enqueue: manual merges are user-driven, not engine-timed.
          */
          if (err instanceof WorkspaceRepoLandBusyError && hasManualResolver) {
            await store
              .logEntry(taskId, `Workspace sub-repo land busy (contention): ${errorMsg}`, "WorkspaceRepoLandBusy")
              .catch(() => undefined);
            this.rejectMergeResolvers(taskId, err instanceof Error ? err : new Error(errorMsg));
            continue;
          }

          if (err instanceof WorkspaceRepoLandBusyError && !hasManualResolver) {
            const busyCount = this.workspaceBusyReenqueues.get(taskId) ?? 0;
            await store
              .logEntry(taskId, `Workspace sub-repo land busy (contention): ${errorMsg}`, "WorkspaceRepoLandBusy")
              .catch(() => undefined);
            if (busyCount < ProjectEngine.WORKSPACE_BUSY_MAX_REENQUEUES) {
              this.workspaceBusyReenqueues.set(taskId, busyCount + 1);
              // Capped exponential backoff (B5): never exceed 60s even at the busy ceiling.
              const delayMs = Math.min(5000 * Math.pow(2, busyCount), 60_000);
              await store.updateTask(taskId, { status: null }).catch(() => undefined);
              runtimeLog.log(
                `Workspace land busy re-enqueue ${busyCount + 1}/${ProjectEngine.WORKSPACE_BUSY_MAX_REENQUEUES} for ${taskId} in ${delayMs / 1000}s (no mergeRetry consumed — pure lease contention)`,
              );
              setTimeout(() => {
                if (!this.shuttingDown) this.internalEnqueueMerge(taskId);
              }, delayMs);
            } else {
              // Pathological sustained contention — surface but do NOT burn mergeRetries; park as
              // failed so the cooldown sweep stops re-attempting and an operator can intervene.
              this.workspaceBusyReenqueues.delete(taskId);
              await store
                .updateTask(taskId, { status: "failed", error: errorMsg })
                .catch(() => undefined);
              runtimeLog.error(
                `Auto-merge: ${taskId} workspace land busy ${ProjectEngine.WORKSPACE_BUSY_MAX_REENQUEUES} times — parked as failed (sustained sub-repo lease contention)`,
              );
            }
            continue;
          }

          // FNXC:Workspace 2026-06-22-00:30 (Phase C U2, KTD3):
          // Workspace PARTIAL-LAND auto-retry-then-park (user decision). Unlike the R7
          // WorkspaceTaskMergeError above (a permanent config error that must NOT burn
          // retries), a partial land — repo A landed, repo B failed — is RETRYABLE: the
          // landed repos' `landedSha` is persisted, so a re-run of `landWorkspaceTask`
          // skips them and re-attempts only the failed repo (idempotent). So this CONSUMES
          // a `mergeRetry` and re-enqueues the merge with capped exponential backoff up to the
          // existing MAX (resolveMaxAutoMergeRetries), then OPERATOR-PARKS (status:"failed")
          // — reusing the unified shouldRetryAutoMergeConflict seam with skipAutoResolveCheck
          // (B6). Detect via `instanceof` (B7). Manual merges fall through to
          // rejectMergeResolvers at the hasManualResolver early-return below.
          if (err instanceof WorkspacePartialLandError && !hasManualResolver) {
            /*
            FNXC:Workspace 2026-06-22-09:30 (Phase C review B8 — clear stale busy quota on real outcome):
            Reaching a REAL partial land means the prior transient busy contention is over. The
            `workspaceBusyReenqueues` counter is otherwise only cleared on success or busy-cap
            exhaustion, so a few transient busy failures followed by a real partial land would leave
            a stale count — later UNRELATED contention would then resume from it and park the task
            early. Clear it here so each fresh contention episode gets the full busy budget.
            */
            this.workspaceBusyReenqueues.delete(taskId);
            const wsSettings = await store.getSettings().catch(() => null);
            const wsTask = await store.getTask(taskId).catch(() => null);
            /*
            FNXC:Workspace 2026-06-22-05:10 (Phase C review B1 — fail closed on getTask null):
            If getTask returns null (DB outage), we CANNOT read `mergeRetries`. Defaulting to 0
            would make `shouldRetry` always true while the increment updateTask also fails against
            the non-responsive DB → an indefinite setTimeout retry storm against a dead DB. FAIL
            CLOSED: do not schedule a retry. Attempt a best-effort park to `failed`; if that write
            also fails it throws away cleanly and the cooldown sweep (canMergeTask) will re-evaluate
            once the DB recovers, rather than hammering it on a tight timer.
            */
            if (!wsTask) {
              runtimeLog.error(
                `Auto-merge: ${taskId} workspace partial land but getTask failed (DB outage?) — failing closed, NOT scheduling a retry storm: ${errorMsg}`,
              );
              await store
                .logEntry(
                  taskId,
                  `Workspace partial land — task state unreadable (DB error); parking as failed instead of scheduling a retry storm: ${errorMsg}`,
                  "WorkspacePartialLand",
                )
                .catch(() => undefined);
              await store
                .updateTask(taskId, { status: "failed", error: errorMsg })
                .catch(() => undefined);
              continue;
            }
            const wsRetries = wsTask.mergeRetries ?? 0;
            const decision = shouldRetryAutoMergeConflict(
              wsRetries,
              wsSettings as { autoResolveConflicts?: boolean; maxAutoMergeRetries?: unknown } | null,
              { skipAutoResolveCheck: true },
            );
            await store
              .logEntry(taskId, `Workspace partial land: ${errorMsg}`, "WorkspacePartialLand")
              .catch(() => undefined);
            if (decision.shouldRetry) {
              /*
              FNXC:Workspace 2026-06-22-09:30 (Phase C review B9 — persist retry count BEFORE arming the timer):
              The retry-count write must succeed before we schedule the retry. A swallowed
              `.catch(() => undefined)` here armed the timer even when the `mergeRetries` increment
              never landed — so the next attempt re-read the OLD `mergeRetries` and could loop without
              consuming budget, defeating the fail-closed DB-outage guard above. FAIL CLOSED: if the
              write throws, park as failed (best-effort) and do NOT schedule a retry storm against a
              non-responsive DB; the cooldown sweep re-evaluates once the DB recovers.
              */
              try {
                await store.updateTask(taskId, { mergeRetries: decision.nextRetryCount, status: null });
              } catch (persistErr: unknown) {
                const pmsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
                runtimeLog.error(
                  `Auto-merge: ${taskId} workspace partial land retry NOT scheduled — mergeRetries could not be persisted (DB outage?), failing closed instead of a retry storm: ${pmsg}`,
                );
                await store
                  .updateTask(taskId, { status: "failed", error: errorMsg })
                  .catch(() => undefined);
                continue;
              }
              // Capped exponential backoff (B5): cap at 60s so a tuned maxAutoMergeRetries doesn't
              // push the delay toward ~85 minutes at the ceiling.
              const delayMs = Math.min(5000 * Math.pow(2, wsRetries), 60_000);
              runtimeLog.log(
                `Workspace partial-land retry ${decision.nextRetryCount}/${decision.maxAutoMergeRetries} for ${taskId} in ${delayMs / 1000}s (re-runs skipping landed repos)`,
              );
              setTimeout(() => {
                if (!this.shuttingDown) this.internalEnqueueMerge(taskId);
              }, delayMs);
            } else {
              await store
                .updateTask(taskId, { status: "failed", mergeRetries: decision.maxAutoMergeRetries, error: errorMsg })
                .catch(() => undefined);
              await store
                .logEntry(
                  taskId,
                  `Workspace partial land exhausted ${decision.maxAutoMergeRetries} retries — parking as failed for operator intervention (landed repos remain landed locally): ${errorMsg}`,
                  "WorkspacePartialLand",
                )
                .catch(() => undefined);
              runtimeLog.error(
                `Auto-merge: ${taskId} workspace partial land exhausted ${decision.maxAutoMergeRetries} retries — parked as failed`,
              );
            }
            continue;
          }

          runtimeLog.error(`${hasManualResolver ? "Manual" : "Auto"}-merge failed for ${taskId}: ${errorMsg}`);

          // Surface every merge failure on the task log so the dashboard shows
          // *why* a merge didn't complete instead of silently looping.
          await store
            .logEntry(
              taskId,
              `${hasManualResolver ? "Manual" : "Auto"}-merge failed: ${errorMsg}`,
              err instanceof Error ? err.name : undefined,
            )
            .catch((logErr: unknown) => {
              runtimeLog.warn(
                `Auto-merge: failed to log merge-failure entry on ${taskId}: ${logErr instanceof Error ? logErr.message : String(logErr)}`,
              );
            });

          // If this was a manual merge, reject the promise and skip auto-retry logic
          if (hasManualResolver) {
            this.rejectMergeResolvers(taskId, err instanceof Error ? err : new Error(errorMsg));
            continue;
          }

          const settingsOnErr = await store
            .getSettings()
            .catch(() => ({ autoResolveConflicts: true }));
          const maxAutoMergeRetriesOnErr = resolveMaxAutoMergeRetries(settingsOnErr as { maxAutoMergeRetries?: unknown });
          const taskOnErr = await store.getTask(taskId).catch(() => null);
          const mergeStrategyOnErr =
            this.options.getMergeStrategy?.(settingsOnErr as Settings) ?? "direct";

          // Deterministic verification failure: move back to in-progress
          const isVerificationError =
            err instanceof Error && err.name === "VerificationError" ||
            errorMsg.includes("Deterministic test verification failed") ||
            errorMsg.includes("Deterministic build verification failed");

          if (taskOnErr && isVerificationError) {
            const refreshedTaskOnVerificationError = await store.getTask(taskId).catch(() => null);
            if (
              refreshedTaskOnVerificationError?.column === "done"
              && refreshedTaskOnVerificationError.mergeDetails?.mergeConfirmed === true
            ) {
              const commitSha = refreshedTaskOnVerificationError.mergeDetails.commitSha;
              const shortSha = typeof commitSha === "string" && commitSha.length > 0
                ? commitSha.slice(0, 8)
                : "unknown";
              const failedCommand = err instanceof VerificationError
                ? err.verificationResult?.testResult?.command ?? err.verificationResult?.buildResult?.command ?? null
                : null;
              const exitCode = err instanceof VerificationError
                ? err.verificationResult?.testResult?.exitCode ?? err.verificationResult?.buildResult?.exitCode ?? null
                : null;
              const errorTail = errorMsg.length > 200 ? `${errorMsg.slice(0, 200)}…` : errorMsg;
              const message = `[verification] post-finalize verification failed for already-on-main fast-path; no action (commit=${shortSha}, error=${errorTail})`;
              await store.logEntry(taskId, message, "VerificationError").catch(() => undefined);
              runtimeLog.log(`Auto-merge: ${taskId} ${message}`);
              const auditor = createRunAuditor(store, {
                runId: generateSyntheticRunId("auto-merge", taskId),
                agentId: "auto-merge",
                taskId,
                phase: "merge",
              });
              await auditor.database({
                type: "task:post-finalize-verification-no-op",
                target: taskId,
                metadata: {
                  taskId,
                  commitSha,
                  failedCommand,
                  exitCode,
                  errorTail,
                },
              }).catch(() => undefined);
              continue;
            }

            if (
              err instanceof VerificationError
              && err.verificationResult?.environmentFault?.kind === "missing-workspace-entry"
              && err.verificationResult.environmentFault.recovered === false
            ) {
              const packageName = err.verificationResult.environmentFault.packageName;
              const message = `${taskId}: verification failed with environment fault (missing-workspace-entry: ${packageName}) — leaving in-review for next sweep, not incrementing verificationFailureCount`;
              await store.logEntry(taskId, message, "VerificationError").catch(() => undefined);
              runtimeLog.log(`Auto-merge: ${message}`);
              continue;
            }

            const failedKind = errorMsg.includes("build verification") ? "build" : "test";
            const previousBounces = taskOnErr.verificationFailureCount ?? 0;
            const nextBounces = previousBounces + 1;
            const cap = ProjectEngine.MAX_VERIFICATION_FAILURE_BOUNCES;

            if (nextBounces >= cap) {
              // Cap reached — stop bouncing the task and create a follow-up.
              // The original task stays in in-review with status=failed so a
              // human can inspect; the follow-up captures the failure context
              // so a fresh agent can investigate (often a flaky test or an
              // unrelated regression that won't be fixed by re-running this
              // task's branch).
              try {
                const checkBeforeWrite = await store.getTask(taskId).catch(() => null);
                if (checkBeforeWrite?.column === "done" && checkBeforeWrite.mergeDetails?.mergeConfirmed === true) {
                  const commitSha = checkBeforeWrite.mergeDetails.commitSha;
                  const shortSha = typeof commitSha === "string" && commitSha.length > 0
                    ? commitSha.slice(0, 8)
                    : "unknown";
                  const failedCommand = err instanceof VerificationError
                    ? err.verificationResult?.testResult?.command ?? err.verificationResult?.buildResult?.command ?? null
                    : null;
                  const exitCode = err instanceof VerificationError
                    ? err.verificationResult?.testResult?.exitCode ?? err.verificationResult?.buildResult?.exitCode ?? null
                    : null;
                  const errorTail = errorMsg.length > 200 ? `${errorMsg.slice(0, 200)}…` : errorMsg;
                  const message = `[verification] post-finalize VerificationError on already-done task — no action (commit=${shortSha}, cmd=${failedCommand ?? "unknown"}, exit=${exitCode ?? "unknown"}, error=${errorTail})`;
                  await store.logEntry(taskId, message, "VerificationError").catch(() => undefined);
                  runtimeLog.log(`Auto-merge: ${taskId} ${message}`);
                  const auditor = createRunAuditor(store, {
                    runId: generateSyntheticRunId("auto-merge", taskId),
                    agentId: "auto-merge",
                    taskId,
                    phase: "merge",
                  });
                  await auditor.database({
                    type: "task:post-finalize-verification-no-op",
                    target: taskId,
                    metadata: {
                      taskId,
                      commitSha,
                      failedCommand,
                      exitCode,
                      errorTail,
                    },
                  }).catch(() => undefined);
                  continue;
                }
                await store.updateTask(taskId, {
                  status: "failed",
                  verificationFailureCount: nextBounces,
                  error: `Deterministic ${failedKind} verification failed ${nextBounces}× — auto-merge giving up to avoid infinite retry loop. See follow-up task for investigation.`,
                });
                const followUpDescription =
                  `Investigate repeated ${failedKind} verification failure on ${taskId} (${taskOnErr.title || "untitled"}). ` +
                  `Auto-merge attempted to fix and re-verify ${nextBounces} times without success — likely a flaky test or unrelated regression rather than a fix this task can produce on its own. ` +
                  `Look at the most recent [verification] log entries on ${taskId} for the failing command and output, then either fix the underlying issue or quarantine the flake.`;
                const verificationAuditor = createRunAuditor(store, {
                  runId: generateSyntheticRunId("auto-merge", taskId),
                  agentId: "auto-merge",
                  taskId,
                  phase: "merge",
                });
                const followUpResult = await createAutomatedFollowup(store, {
                  kind: "verification-failure",
                  parentTaskId: taskId,
                  signature: err instanceof VerificationError ? buildVerificationFailureSignature(err) : undefined,
                  createInput: {
                    description: followUpDescription,
                    column: "triage",
                    priority: "high",
                    source: {
                      sourceType: "recovery",
                      sourceParentTaskId: taskId,
                    },
                  },
                  auditor: verificationAuditor,
                });
                if (followUpResult.outcome === "deduped") {
                  await store.addTaskComment(
                    taskId,
                    `Auto-merge giving up after ${nextBounces} verification-failure bounces. Reusing existing follow-up ${followUpResult.existingTaskId}.`,
                    "agent",
                  );
                  await store.logEntry(
                    taskId,
                    `Auto-merge gave up after ${nextBounces} verification-failure bounces — skipped creating duplicate follow-up (existing ${followUpResult.existingTaskId})`,
                    "VerificationError",
                  );
                  runtimeLog.warn(
                    `Auto-merge: ${taskId} hit verification-failure cap (${nextBounces}/${cap}) — skipped duplicate follow-up (existing ${followUpResult.existingTaskId})`,
                  );
                } else {
                  await store.addTaskComment(
                    taskId,
                    `Auto-merge giving up after ${nextBounces} verification-failure bounces. Created follow-up ${followUpResult.task.id} to investigate.`,
                    "agent",
                  );
                  await store.logEntry(
                    taskId,
                    `Auto-merge gave up after ${nextBounces} verification-failure bounces — created follow-up ${followUpResult.task.id}`,
                    "VerificationError",
                  );
                  runtimeLog.warn(
                    `Auto-merge: ${taskId} hit verification-failure cap (${nextBounces}/${cap}) — failed task and created follow-up ${followUpResult.task.id}`,
                  );
                }
              } catch (followUpErr) {
                runtimeLog.error(
                  `Auto-merge: failed to fail-and-followup ${taskId} after verification cap: ${followUpErr instanceof Error ? followUpErr.message : String(followUpErr)}`,
                );
              }
              continue;
            }

            // Under cap — bounce back as before, but record the increment.
            try {
              const checkBeforeWrite = await store.getTask(taskId).catch(() => null);
              if (checkBeforeWrite?.column === "done" && checkBeforeWrite.mergeDetails?.mergeConfirmed === true) {
                const commitSha = checkBeforeWrite.mergeDetails.commitSha;
                const shortSha = typeof commitSha === "string" && commitSha.length > 0
                  ? commitSha.slice(0, 8)
                  : "unknown";
                const failedCommand = err instanceof VerificationError
                  ? err.verificationResult?.testResult?.command ?? err.verificationResult?.buildResult?.command ?? null
                  : null;
                const exitCode = err instanceof VerificationError
                  ? err.verificationResult?.testResult?.exitCode ?? err.verificationResult?.buildResult?.exitCode ?? null
                  : null;
                const errorTail = errorMsg.length > 200 ? `${errorMsg.slice(0, 200)}…` : errorMsg;
                const message = `[verification] post-finalize VerificationError on already-done task — no action (commit=${shortSha}, cmd=${failedCommand ?? "unknown"}, exit=${exitCode ?? "unknown"}, error=${errorTail})`;
                await store.logEntry(taskId, message, "VerificationError").catch(() => undefined);
                runtimeLog.log(`Auto-merge: ${taskId} ${message}`);
                const auditor = createRunAuditor(store, {
                  runId: generateSyntheticRunId("auto-merge", taskId),
                  agentId: "auto-merge",
                  taskId,
                  phase: "merge",
                });
                await auditor.database({
                  type: "task:post-finalize-verification-no-op",
                  target: taskId,
                  metadata: {
                    taskId,
                    commitSha,
                    failedCommand,
                    exitCode,
                    errorTail,
                  },
                }).catch(() => undefined);
                continue;
              }
              await store.addTaskComment(
                taskId,
                `Deterministic ${failedKind} verification failed during merge (attempt ${nextBounces}/${cap}). ` +
                  `See the prior [verification] log entry for the truncated command output. ` +
                  `Please fix the failing ${failedKind} and push the update so the merge can retry.`,
                "agent",
              );
              await store.updateTask(taskId, {
                status: "merging-fix",
                mergeRetries: 0,
                error: null,
                verificationFailureCount: nextBounces,
              });
              await store.moveTask(taskId, "in-progress");
              await store.logEntry(
                taskId,
                `Deterministic ${failedKind} verification failed (${nextBounces}/${cap}) — moved back to in-progress with status=merging-fix for remediation`,
              );
              runtimeLog.log(
                `Auto-merge: ${taskId} deterministic ${failedKind} verification failed (${nextBounces}/${cap}) — moved to in-progress with status=merging-fix`,
              );
            } catch {
              runtimeLog.error(
                `Auto-merge: failed to return ${taskId} to in-progress after verification failure`,
              );
            }
            continue;
          }

          if (mergeStrategyOnErr === "direct") {
            const isConflictError =
              errorMsg.includes("conflict") || errorMsg.includes("Conflict");

            if (taskOnErr && isConflictError) {
              const currentRetries = taskOnErr.mergeRetries ?? 0;

              /*
               * FNXC:AutoMergeRetries 2026-06-17-04:20:
               * The conflict retry loop resolves maxAutoMergeRetries from settings on every caught merge failure so changed project policy affects the next retry/bounce decision without changing the historical default of 3.
               */
              // Use `currentRetries + 1 < MAX` (not `currentRetries < MAX`) so
              // the LAST retry's failure goes straight to the bounce code in
              // this same engine tick. The previous condition scheduled a
              // separate Nth setTimeout attempt — if the engine restarted
              // before that timer fired (common during dev), the task was
              // stranded with mergeRetries=MAX and only the cooldown sweep
              // could ever try again (silent loop).
              const retryDecision = shouldRetryAutoMergeConflict(currentRetries, settingsOnErr);
              if (retryDecision.shouldRetry) {
                const newRetryCount = retryDecision.nextRetryCount;
                await store.updateTask(taskId, { mergeRetries: newRetryCount, status: null });

                // Exponential backoff: 5s, 10s, 20s
                const delayMs = 5000 * Math.pow(2, currentRetries);
                runtimeLog.log(
                  `Auto-merge conflict retry ${newRetryCount}/${maxAutoMergeRetriesOnErr} for ${taskId} in ${delayMs / 1000}s`,
                );
                setTimeout(() => {
                  if (!this.shuttingDown) this.internalEnqueueMerge(taskId);
                }, delayMs);
              } else {
                // Conflict retries exhausted (or auto-resolve disabled).
                // Previous behavior: silently clear status, leaving the task in
                // in-review with mergeRetries=MAX. The 30-min cooldown sweep
                // would then reset retries and re-attempt the same impossible
                // merge forever, with no error surface for the user.
                //
                // New behavior: bounce the task back to in-progress so the
                // executor can rebase against the latest main and retry. Cap
                // bounces at MAX_MERGE_CONFLICT_BOUNCES — past that, park in
                // in-review with status=failed and create a follow-up task so
                // a human can resolve the conflict manually.
                const previousBounces = taskOnErr.mergeConflictBounceCount ?? 0;
                const nextBounces = previousBounces + 1;
                const bounceCap = ProjectEngine.MAX_MERGE_CONFLICT_BOUNCES;
                const autoResolveDisabled =
                  (settingsOnErr as Settings).autoResolveConflicts === false;

                if (autoResolveDisabled || nextBounces > bounceCap) {
                  // Park for human intervention.
                  const reason = autoResolveDisabled
                    ? "autoResolveConflicts is disabled"
                    : `merge-conflict bounce cap reached (${nextBounces - 1}/${bounceCap})`;
                  try {
                    await store.updateTask(taskId, {
                      status: "failed",
                      mergeRetries: maxAutoMergeRetriesOnErr,
                      error: `Auto-merge gave up: ${reason}. ${errorMsg}`,
                    });
                    await store.addTaskComment(
                      taskId,
                      `Auto-merge gave up after ${maxAutoMergeRetriesOnErr} conflict-resolution retries (${reason}). ` +
                        `Resolve the conflict on branch \`${taskOnErr.branch ?? "?"}\` manually, then unpause/retry.`,
                      "agent",
                    );
                    await store.logEntry(
                      taskId,
                      `Auto-merge gave up after conflict retries exhausted (${reason}); task parked for human intervention`,
                      "MergeConflictGiveUp",
                    );
                    if (!autoResolveDisabled) {
                      // Create a follow-up only when we capped on bounces; if
                      // auto-resolve is just disabled, the user is presumed to
                      // be handling merges manually and a follow-up is noise.
                      try {
                        const followUpResult = await createAutomatedFollowup(store, {
                          kind: "merge-conflict",
                          parentTaskId: taskId,
                          branch: taskOnErr.branch,
                          signature: computeVerificationFailureSignature({
                            lane: "merge-conflict",
                            failingTestFiles: [],
                          }).signature,
                          createInput: {
                            description:
                              `Resolve auto-merge conflict on ${taskId} (${taskOnErr.title || "untitled"}). ` +
                              `Auto-merge attempted to rebase + resolve ${nextBounces - 1} times against main and exhausted retries each pass. ` +
                              `Branch: \`${taskOnErr.branch ?? "?"}\`. Worktree: \`${taskOnErr.worktree ?? "?"}\`. ` +
                              `Last merge error: ${errorMsg}`,
                            column: "triage",
                            priority: "high",
                            source: {
                              sourceType: "recovery",
                              sourceParentTaskId: taskId,
                            },
                          },
                          auditor: createRunAuditor(store, {
                            runId: generateSyntheticRunId("auto-merge", taskId),
                            agentId: "auto-merge",
                            taskId,
                            phase: "merge",
                          }),
                        });
                        if (followUpResult.outcome === "deduped") {
                          await store.addTaskComment(
                            taskId,
                            `Auto-merge recovery follow-up already exists (${followUpResult.existingTaskId}). Skipping duplicate follow-up creation.`,
                            "agent",
                          );
                          await store.logEntry(
                            taskId,
                            `Auto-merge conflict recovery skipped duplicate follow-up (existing ${followUpResult.existingTaskId})`,
                            "MergeConflictGiveUp",
                          );
                          runtimeLog.warn(
                            `Auto-merge: ${taskId} conflict give-up skipped duplicate follow-up (existing ${followUpResult.existingTaskId})`,
                          );
                        } else {
                          await store.addTaskComment(
                            taskId,
                            `Created follow-up ${followUpResult.task.id} to track manual conflict resolution.`,
                            "agent",
                          );
                        }
                      } catch (followUpErr) {
                        runtimeLog.warn(
                          `Auto-merge: failed to create follow-up for ${taskId}: ${followUpErr instanceof Error ? followUpErr.message : String(followUpErr)}`,
                        );
                      }
                    }
                  } catch (recoveryErr) {
                    runtimeLog.error(
                      `Auto-merge: failed to park ${taskId} after conflict-bounce cap: ${recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)}`,
                    );
                  }
                } else {
                  // Bounce to in-progress for a fresh rebase + retry pass.
                  try {
                    await store.addTaskComment(
                      taskId,
                      `Auto-merge could not resolve conflicts within ${maxAutoMergeRetriesOnErr} retries (bounce ${nextBounces}/${bounceCap}). ` +
                        `Bouncing back to in-progress for a fresh rebase against main; the executor will re-run quality gates and re-attempt the merge.`,
                      "agent",
                    );
                    await store.updateTask(taskId, {
                      status: null,
                      mergeRetries: 0,
                      error: null,
                      mergeConflictBounceCount: nextBounces,
                    });
                    await store.moveTask(taskId, "in-progress");
                    await store.logEntry(
                      taskId,
                      `Auto-merge conflicts unresolved (${maxAutoMergeRetriesOnErr}/${maxAutoMergeRetriesOnErr}) — bounced to in-progress for re-rebase (bounce ${nextBounces}/${bounceCap})`,
                      "MergeConflictBounce",
                    );
                    runtimeLog.log(
                      `Auto-merge: ${taskId} conflict retries exhausted — bounced to in-progress (${nextBounces}/${bounceCap})`,
                    );
                  } catch (recoveryErr) {
                    runtimeLog.error(
                      `Auto-merge: failed to bounce ${taskId} after conflict exhaustion: ${recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)}`,
                    );
                  }
                }
              }
            } else {
              // Non-conflict error — stop retrying until user intervenes.
              // Mark status=failed so the cooldown sweep won't silently
              // re-attempt; the catch-block-top logEntry already recorded the
              // failure on the task log.
              try {
                if (await this.maybeRetryTransientMerge(store, taskId, taskOnErr, errorMsg)) {
                  continue;
                }
                if (this.isTransientMergeRetryExhausted(taskOnErr, errorMsg)) {
                  const settings = await store.getSettings().catch(() => null);
                  const useMergeRequestContract = settings?.mergeRequestContractShadowEnabled === true;
                  if (useMergeRequestContract) {
                    const record = await store.getMergeRequestRecordAsync(taskId);
                    if (record && record.state !== "exhausted" && record.state !== "cancelled" && record.state !== "succeeded") {
                      if (record.state === "running") {
                        await store.transitionMergeRequestState(taskId, "retrying", {
                          attemptCount: record.attemptCount,
                          lastError: errorMsg,
                        });
                      }
                      const refreshed = await store.getMergeRequestRecordAsync(taskId);
                      if (refreshed && refreshed.state === "retrying") {
                        await store.transitionMergeRequestState(taskId, "exhausted", {
                          attemptCount: refreshed.attemptCount,
                          lastError: errorMsg,
                        });
                      }
                    }
                    await store.logEntry(
                      taskId,
                      `Auto-merge transient retries exhausted (${ProjectEngine.MAX_AUTO_MERGE_TRANSIENT_RETRIES}/${ProjectEngine.MAX_AUTO_MERGE_TRANSIENT_RETRIES}); marked merge request exhausted without column rebound: ${errorMsg}`,
                      "MergeTransientRetryExhausted",
                    );
                    continue;
                  }
                  await store.logEntry(
                    taskId,
                    `Auto-merge transient retries exhausted (${ProjectEngine.MAX_AUTO_MERGE_TRANSIENT_RETRIES}/${ProjectEngine.MAX_AUTO_MERGE_TRANSIENT_RETRIES}); parking task as failed: ${errorMsg}`,
                    "MergeTransientRetryExhausted",
                  );
                }
                await store.updateTask(taskId, {
                  status: "failed",
                  mergeRetries: maxAutoMergeRetriesOnErr,
                  error: errorMsg,
                });
                await store.logEntry(
                  taskId,
                  `Auto-merge failed with a non-conflict error and stopped retrying: ${errorMsg}`,
                  "MergeNonConflictFailure",
                );
              } catch (recoveryErr) {
                runtimeLog.error(
                  `Auto-merge: failed to update ${taskId} after non-conflict error: ${recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)}`,
                );
              }
            }
          } else {
            // Non-direct merge strategy (e.g. pull-request) errored — park as
            // failed so the cooldown sweep stops re-attempting silently.
            try {
              if (await this.maybeRetryTransientMerge(store, taskId, taskOnErr, errorMsg)) {
                continue;
              }
              if (this.isTransientMergeRetryExhausted(taskOnErr, errorMsg)) {
                const settings = await store.getSettings().catch(() => null);
                const useMergeRequestContract = settings?.mergeRequestContractShadowEnabled === true;
                if (useMergeRequestContract) {
                  const record = await store.getMergeRequestRecordAsync(taskId);
                  if (record && record.state !== "exhausted" && record.state !== "cancelled" && record.state !== "succeeded") {
                    if (record.state === "running") {
                      await store.transitionMergeRequestState(taskId, "retrying", {
                        attemptCount: record.attemptCount,
                        lastError: errorMsg,
                      });
                    }
                    const refreshed = await store.getMergeRequestRecordAsync(taskId);
                    if (refreshed && refreshed.state === "retrying") {
                      await store.transitionMergeRequestState(taskId, "exhausted", {
                        attemptCount: refreshed.attemptCount,
                        lastError: errorMsg,
                      });
                    }
                  }
                  await store.logEntry(
                    taskId,
                    `Auto-merge transient retries exhausted (${ProjectEngine.MAX_AUTO_MERGE_TRANSIENT_RETRIES}/${ProjectEngine.MAX_AUTO_MERGE_TRANSIENT_RETRIES}); marked merge request exhausted without column rebound: ${errorMsg}`,
                    "MergeTransientRetryExhausted",
                  );
                  continue;
                }
                await store.logEntry(
                  taskId,
                  `Auto-merge transient retries exhausted (${ProjectEngine.MAX_AUTO_MERGE_TRANSIENT_RETRIES}/${ProjectEngine.MAX_AUTO_MERGE_TRANSIENT_RETRIES}); parking task as failed: ${errorMsg}`,
                  "MergeTransientRetryExhausted",
                );
              }
              await store.updateTask(taskId, {
                status: "failed",
                mergeRetries: maxAutoMergeRetriesOnErr,
                error: errorMsg,
              });
            } catch (recoveryErr) {
              runtimeLog.error(
                `Auto-merge: failed to update ${taskId} after merge strategy error: ${recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)}`,
              );
            }
          }
        } finally {
          this.clearActiveMergeClaim(taskId);
          this.mergeAbortController = null;
          this.mergeActive.delete(taskId);
          // If a manual merge was requested while this task was already in-flight,
          // the waiter(s) were set but not consumed above. Resolve them now.
          if (this.hasMergeResolvers(taskId)) {
            const finalTask = await store.getTask(taskId).catch(() => null);
            this.resolveMergeResolvers(taskId, {
              task: finalTask!,
              branch: finalTask?.branch ?? "",
              merged: finalTask?.column === "done",
              worktreeRemoved: false,
              branchDeleted: false,
            } as MergeResult);
          }
        }
      }
    } finally {
      this.mergeRunning = false;
    }
  }

  private isTransientMergeRetryExhausted(task: Task | null, errorMsg: string): boolean {
    if (!task || (!isTransientError(errorMsg) && classifyTransientMergeError(errorMsg) === null)) {
      return false;
    }
    const current = task.mergeTransientRetryCount ?? 0;
    return current >= ProjectEngine.MAX_AUTO_MERGE_TRANSIENT_RETRIES;
  }

  private async maybeRetryTransientMerge(
    store: TaskStore,
    taskId: string,
    taskOnErr: Task | null,
    errorMsg: string,
  ): Promise<boolean> {
    if (!taskOnErr || (!isTransientError(errorMsg) && classifyTransientMergeError(errorMsg) === null)) {
      return false;
    }

    const currentRetries = taskOnErr.mergeTransientRetryCount ?? 0;
    if (currentRetries >= ProjectEngine.MAX_AUTO_MERGE_TRANSIENT_RETRIES) {
      return false;
    }

    const nextRetryCount = currentRetries + 1;
    const delayMs = 5000 * Math.pow(2, currentRetries);
    const settings = await store.getSettings().catch(() => null);
    const useMergeRequestContract = settings?.mergeRequestContractShadowEnabled === true;
    if (useMergeRequestContract) {
      const record = await store.getMergeRequestRecordAsync(taskId);
      if (record && record.state !== "manual-required" && record.state !== "cancelled" && record.state !== "succeeded" && record.state !== "exhausted") {
        if (record.state === "running") {
          await store.transitionMergeRequestState(taskId, "retrying", {
            attemptCount: nextRetryCount,
            lastError: errorMsg,
          });
        }
        if ((await store.getMergeRequestRecordAsync(taskId))?.state === "retrying") {
          await store.transitionMergeRequestState(taskId, "queued", {
            attemptCount: nextRetryCount,
            lastError: errorMsg,
          });
        }
      }
    }
    await store.updateTask(taskId, {
      mergeTransientRetryCount: nextRetryCount,
      status: null,
    });
    await store.logEntry(
      taskId,
      `Auto-merge transient retry ${nextRetryCount}/${ProjectEngine.MAX_AUTO_MERGE_TRANSIENT_RETRIES} scheduled in ${delayMs / 1000}s: ${errorMsg}`,
      "MergeTransientRetry",
    );
    runtimeLog.log(
      `Auto-merge transient retry ${nextRetryCount}/${ProjectEngine.MAX_AUTO_MERGE_TRANSIENT_RETRIES} for ${taskId} in ${delayMs / 1000}s`,
    );
    setTimeout(() => {
      if (!this.shuttingDown) this.internalEnqueueMerge(taskId);
    }, delayMs);
    return true;
  }

  private wireAutoMerge(store: TaskStore, _cwd: string): void {
    this.taskMovedHandler = async ({ task, to }: { task: Task; to: string }) => {
      if (to !== "in-review") return;
      if (task.paused) return;
      if (this.options.getTaskMergeBlocker?.(task)) return;

      // Grace period before handing off to the merger. The executor's finally
      // block (session disposal, child-agent termination, in-flight reviewer
      // teardown) runs *after* the moveTask("in-review") that fires this
      // event. Without a delay, the merger's session can start emitting logs
      // while the executor is still cleaning up — observed in FN-2910 as
      // overlapping [reviewer]/[merger] log streams. The delay is also a
      // belt-and-braces guard against any in-flight reviewer that the
      // executor spawned just before transitioning.
      setTimeout(async () => {
        try {
          // Re-validate eligibility after the grace period — the task may
          // have been paused, moved, or had its merge blocked.
          const latestTask = await store.getTask(task.id).catch(() => null);
          if (!latestTask) {
            runtimeLog.warn(`Auto-merge handoff (${task.id}): task disappeared during grace period`);
            return;
          }
          if (latestTask.column !== "in-review") {
            runtimeLog.log(`Auto-merge handoff (${task.id}) skipped: column changed to ${latestTask.column}`);
            return;
          }
          if (latestTask.paused) {
            runtimeLog.log(`Auto-merge handoff (${task.id}) skipped: task paused`);
            return;
          }
          const blockerReason = this.options.getTaskMergeBlocker?.(latestTask);
          if (blockerReason) {
            runtimeLog.log(`Auto-merge handoff (${task.id}) skipped: ${blockerReason}`);
            return;
          }
          const settings = await store.getSettings();
          if (settings.globalPause || settings.enginePaused) {
            runtimeLog.log(`Auto-merge handoff (${task.id}) skipped: ${settings.globalPause ? "globalPause" : "enginePaused"} active`);
            return;
          }
          if (!(await this.allowInReviewMergeProcessing(latestTask, settings, store))) {
            runtimeLog.log(`Auto-merge handoff (${task.id}) skipped: autoMerge disabled`);
            return;
          }
          // Belt-and-braces: eager handoff still clears a stale mergeActive
          // entry before enqueue so freshly completed review tasks do not wait
          // for a later queue reconciliation pass before their merge starts.
          if (
            this.mergeActive.has(task.id) &&
            !this.mergeQueue.includes(task.id) &&
            this.activeMergeTaskId !== task.id
          ) {
            runtimeLog.warn(`Auto-merge handoff (${task.id}): clearing stale mergeActive before enqueue`);
            this.mergeActive.delete(task.id);
          }
          this.internalEnqueueMerge(task.id);
        } catch (err: unknown) {
          runtimeLog.warn(
            `Auto-merge handoff (${task.id}) failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }, MERGE_HANDOFF_GRACE_MS);
    };
    store.on("task:moved", this.taskMovedHandler);
  }

  private wireAutostashOrphanRecovery(store: TaskStore): void {
    this.autostashOrphansHandler = async ({ records }: { rootDir: string; records: AutostashOrphanRecord[] }) => {
      const liveRecords = records.filter((record) => record.classification === "live");
      for (const record of liveRecords) {
        const parentTaskId = record.sourceTaskId;
        if (!parentTaskId) continue;
        try {
          const sourcePhase = record.sourcePhase ?? "unknown";
          const followUpResult = await createAutomatedFollowup(store, {
            kind: "autostash-orphan",
            parentTaskId,
            signature: computeVerificationFailureSignature({
              lane: "autostash-orphan",
              failingTestFiles: [],
            }).signature,
            createInput: {
              description:
                `Investigate preserved merger autostash leftover from ${parentTaskId} (${record.sha.slice(0, 7)}). ` +
                `Detected by ${record.detectedByTaskId ?? "merge sweep"} during ${sourcePhase}; ` +
                `stash label: ${record.label}. Recover from stash-recovery before dropping.`,
              source: {
                sourceType: "recovery",
                sourceParentTaskId: parentTaskId,
              },
            },
            auditor: createRunAuditor(store, {
              runId: generateSyntheticRunId("auto-merge", parentTaskId),
              agentId: "auto-merge",
              taskId: parentTaskId,
              phase: "merge",
            }),
          });
          await store.logEntry(
            parentTaskId,
            followUpResult.outcome === "deduped"
              ? `Auto-detected live autostash orphan ${record.sha.slice(0, 7)} — reused follow-up ${followUpResult.existingTaskId}`
              : `Auto-created recovery follow-up ${followUpResult.task.id} for live autostash orphan ${record.sha.slice(0, 7)}`,
            `detectedBy=${record.detectedByTaskId ?? "unknown"}; phase=${sourcePhase}; stash=${record.label}`,
          ).catch(() => undefined);
        } catch (err: unknown) {
          runtimeLog.warn(`Autostash orphan recovery follow-up failed for ${parentTaskId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };

    store.on("merger:autostashOrphans", this.autostashOrphansHandler as any);
  }

  private wireTaskPauseMergeInterruption(store: TaskStore): void {
    this.taskUpdatedHandler = async (task: Task) => {
      if (task.column !== "in-review") {
        this.pausedReviewTaskIds.delete(task.id);
        return;
      }

      if (task.paused) {
        this.pausedReviewTaskIds.add(task.id);

        const queueLengthBefore = this.mergeQueue.length;
        this.mergeQueue = this.mergeQueue.filter((queuedTaskId) => queuedTaskId !== task.id);
        const removedFromQueue = this.mergeQueue.length !== queueLengthBefore;

        if (removedFromQueue) {
          this.mergeActive.delete(task.id);
          runtimeLog.log(`Paused in-review task removed from merge queue: ${task.id}`);
        }

        if (this.activeMergeTaskId !== task.id) {
          return;
        }

        /*
        FNXC:MergeQueue 2026-07-15-09:41:
        Pause of the active merge must free the single-flight lane the same way soft-delete does. Abort + dispose alone left activeMergeTaskId set and, when the agent ignored abort, drainMergeQueue wedged with mergeRunning=true (no merging badge on any card). Clear identity now; raceMergeWithAbort rejects the parked await so the drain finally settles and later enqueues can start.
        */
        this.abortActiveMerge(task.id, "task-paused");
        return;
      }

      const wasPaused = this.pausedReviewTaskIds.delete(task.id);
      if (!wasPaused) {
        return;
      }

      try {
        const settings = await store.getSettings();
        if (settings.globalPause || settings.enginePaused || !(await this.allowInReviewMergeProcessing(task, settings, store))) {
          return;
        }
        if (this.options.getTaskMergeBlocker?.(task)) {
          return;
        }

        runtimeLog.log(`Unpaused in-review task re-enqueued for auto-merge: ${task.id}`);
        this.internalEnqueueMerge(task.id);
      } catch (err: unknown) {
        runtimeLog.warn(
          `In-review unpause: failed to re-enqueue ${task.id} for auto-merge: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    this.taskDeletedHandler = (task: Task) => {
      this.pausedReviewTaskIds.delete(task.id);

      const queueLengthBefore = this.mergeQueue.length;
      this.mergeQueue = this.mergeQueue.filter((queuedTaskId) => queuedTaskId !== task.id);
      const removedFromQueue = this.mergeQueue.length !== queueLengthBefore;

      if (removedFromQueue) {
        if (this.activeMergeTaskId !== task.id) {
          this.mergeActive.delete(task.id);
        }
        runtimeLog.log(`Soft-deleted task removed from merge queue: ${task.id}`);
      }

      if (this.activeMergeTaskId !== task.id) {
        return;
      }

      this.abortActiveMerge(task.id, "task-soft-deleted");
    };

    store.on("task:updated", this.taskUpdatedHandler);
    store.on("task:deleted", this.taskDeletedHandler);
  }

  /**
   * Clear crash-leftover merging statuses so manual merge is unblocked.
   * Unconditional (not gated on autoMerge). Safe to run on the critical path.
   */
  private async clearStaleMergingStatuses(store: TaskStore): Promise<Task[]> {
    const tasks = await store.listTasks({ column: "in-review" });
    // No merge is actually running at startup, so any task still marked
    // as merging is a leftover from a previous engine lifecycle.
    const staleStatuses = new Set(["merging", "merging-pr"]);
    for (const t of tasks) {
      if (t.status && staleStatuses.has(t.status)) {
        runtimeLog.log(`Startup sweep: clearing stale '${t.status}' status on ${t.id}`);
        await store.updateTask(t.id, { status: null });
        // Update in-memory object so canMergeTask sees the cleared status
        (t as any).status = null;
      }
    }
    return tasks as Task[];
  }

  /**
   * Enqueue auto-merge-eligible in-review tasks. Pause-aware; deferred after
   * status clear so ensureEngine is not blocked by enqueue work.
   */
  private async startupMergeEnqueue(store: TaskStore): Promise<void> {
    if (this.shuttingDown) return;
    try {
      const settings = await store.getSettings();
      if (settings.globalPause || settings.enginePaused) {
        runtimeLog.log("Auto-merge startup enqueue skipped: pause active");
        return;
      }
      const tasks = await store.listTasks({ column: "in-review" });
      if (this.shuttingDown) return;
      const enqueued = await this.enqueueEligibleInReviewTasks(tasks as Task[], settings);
      if (enqueued > 0) {
        runtimeLog.log(`Auto-merge startup sweep: enqueueing ${enqueued} task(s)`);
      }
    } catch (err: unknown) {
      runtimeLog.warn(
        `Auto-merge startup enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Full startup merge sweep (status clear + enqueue). Kept for tests/callers. */
  private async startupMergeSweep(store: TaskStore): Promise<void> {
    try {
      await this.clearStaleMergingStatuses(store);
      await this.startupMergeEnqueue(store);
    } catch (err: unknown) {
      runtimeLog.warn(
        `Auto-merge startup sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private resolveAutostashMaxAgeMs(settings: Settings): number {
    const hours = Math.max(1, Math.trunc(settings.mergerAutostashMaxAgeHours ?? 24));
    return hours * 60 * 60 * 1000;
  }

  private async runStaleAutostashSweep(store: TaskStore, reason: "startup" | "periodic"): Promise<void> {
    try {
      const settings = await store.getSettings();
      if (settings.globalPause || settings.enginePaused) return;
      const maxAgeMs = this.resolveAutostashMaxAgeMs(settings);
      const result = await sweepStaleAutostashes(this.config.workingDirectory, {
        maxAgeMs,
        taskStore: store,
      });
      if (result.dropped > 0) {
        runtimeLog.log(`${reason === "startup" ? "Startup" : "Periodic"} stale autostash sweep dropped ${result.dropped} stash(es)`);
      }
    } catch (err: unknown) {
      runtimeLog.warn(`Stale autostash ${reason} sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private scheduleStaleAutostashSweep(store: TaskStore): void {
    if (this.shuttingDown) return;
    const schedule = async () => {
      if (this.shuttingDown) return;
      try {
        await this.runStaleAutostashSweep(store, "periodic");
      } finally {
        if (!this.shuttingDown) {
          this.autostashSweepTimer = setTimeout(() => void schedule(), 60 * 60 * 1000);
        }
      }
    };

    this.autostashSweepTimer = setTimeout(() => void schedule(), 60 * 60 * 1000);
  }

  private scheduleMergeRetry(store: TaskStore): void {
    if (this.shuttingDown) return;

    const schedule = async () => {
      if (this.shuttingDown) return;

      try {
        const settings = await store.getSettings();
        if (!settings.globalPause && !settings.enginePaused) {
          const tasks = await store.listTasks({ column: "in-review" });
          await this.enqueueEligibleInReviewTasks(tasks as Task[], settings);
        }
      } catch (err: unknown) {
        runtimeLog.warn(
          `Auto-merge periodic sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        if (!this.shuttingDown) {
          let interval = 15_000;
          try {
            const settings = await store.getSettings();
            interval = settings.pollIntervalMs ?? 15_000;
          } catch (err: unknown) {
            runtimeLog.warn(
              `Auto-merge retry: failed to read pollIntervalMs, using default 15s: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          this.mergeRetryTimer = setTimeout(() => void schedule(), interval);
        }
      }
    };

    // Kick off the first sweep after a delay
    this.mergeRetryTimer = setTimeout(() => void schedule(), 15_000);
  }

  // ── Settings event listeners ──

  private async resumeAfterUnpauseAndSweepInReview(
    store: TaskStore,
    settings: Settings,
    source: "Global unpause" | "Engine unpause",
  ): Promise<void> {
    try {
      const runtime = this.runtime as any;
      runtime.resumeAfterUnpause?.().catch((err: Error) =>
        runtimeLog.error(
          `Failed to resume agentic activity on ${source.toLowerCase()}:`,
          err,
        ),
      );
    } catch (err: unknown) {
      runtimeLog.warn(
        `${source}: failed to dispatch resumeAfterUnpause: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      await store.updateSettings({ engineActiveSinceMs: Date.now() });
    } catch (err: unknown) {
      runtimeLog.warn(
        `${source}: failed to stamp engineActiveSinceMs: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (settings.globalPause || settings.enginePaused) {
      return;
    }

    try {
      const tasks = await store.listTasks({ column: "in-review" });
      await this.enqueueEligibleInReviewTasks(tasks as Task[], settings);
    } catch (err: unknown) {
      runtimeLog.warn(
        `${source}: failed to scan in-review tasks for auto-merge: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private wireSettingsListeners(store: TaskStore): void {
    const applyDetectorPauseLifecycle = (paused: boolean, source: string): void => {
      try {
        const detector = (this.runtime as any).stuckTaskDetector;
        if (paused) {
          detector?.pause?.();
        } else {
          detector?.resume?.();
        }
      } catch (err: unknown) {
        runtimeLog.warn(
          `${source}: stuck detector ${paused ? "pause" : "resume"} hook failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    // 1. Unified pause lifecycle — detector only resumes once BOTH pause sources
    // are clear, and pauses when either source engages.
    const onPauseLifecycleTransition = ({
      settings: s,
      previous: prev,
    }: {
      settings: Settings;
      previous: Settings;
    }) => {
      const wasPaused = prev.globalPause || prev.enginePaused;
      const isPaused = s.globalPause || s.enginePaused;

      if (!wasPaused && isPaused) {
        const source = s.globalPause && !prev.globalPause ? "Global pause" : "Engine pause";
        applyDetectorPauseLifecycle(true, source);
      }

      if (wasPaused && !isPaused) {
        const source = prev.globalPause && !s.globalPause ? "Global unpause" : "Engine unpause";
        applyDetectorPauseLifecycle(false, source);
      }
    };
    store.on("settings:updated", onPauseLifecycleTransition);
    this.settingsHandlers.push(onPauseLifecycleTransition);

    // 2. Global pause — terminate active merge session AND abort any running
    // deterministic verification (pnpm test/build). The abort controller gates
    // both the AI merge agent and the spawned child processes; without it,
    // verification commands keep churning until they finish naturally.
    const onGlobalPause = ({ settings, previous }: { settings: Settings; previous: Settings }) => {
      if (settings.globalPause && !previous.globalPause) {
        if (this.mergeAbortController) {
          runtimeLog.log("Global pause — aborting in-flight merge verification");
          this.mergeAbortController.abort();
          this.mergeAbortController = null;
        }
        if (this.activeMergeSession) {
          runtimeLog.log("Global pause — terminating active merge session");
          this.activeMergeSession.dispose();
          this.activeMergeSession = null;
        }
      }
    };
    store.on("settings:updated", onGlobalPause);
    this.settingsHandlers.push(onGlobalPause);

    // 3. Auto-merge OFF — legacy pre-provenance stamps are ambiguous, so only
    // advise operators about clearable candidates; do not mutate task state.
    const onAutoMergeDisabled = async ({
      settings: s,
      previous: prev,
    }: {
      settings: Settings;
      previous: Settings;
    }) => {
      if (prev.autoMerge !== false && s.autoMerge === false) {
        await this.emitLegacyAutoMergeStampAdvisory(store);
      }
    };
    store.on("settings:updated", onAutoMergeDisabled);
    this.settingsHandlers.push(onAutoMergeDisabled);

    // 4. Global unpause — resume orphaned tasks + sweep in-review
    const onGlobalUnpause = async ({
      settings: s,
      previous: prev,
    }: {
      settings: Settings;
      previous: Settings;
    }) => {
      if (prev.globalPause && !s.globalPause) {
        runtimeLog.log("Global unpause — resuming agentic activity");
        await this.resumeAfterUnpauseAndSweepInReview(store, s, "Global unpause");
      }
    };
    store.on("settings:updated", onGlobalUnpause);
    this.settingsHandlers.push(onGlobalUnpause);

    // 5. Engine unpause — same as global unpause
    const onEngineUnpause = async ({
      settings: s,
      previous: prev,
    }: {
      settings: Settings;
      previous: Settings;
    }) => {
      if (prev.enginePaused && !s.enginePaused) {
        runtimeLog.log("Engine unpaused — resuming agentic activity");
        await this.resumeAfterUnpauseAndSweepInReview(store, s, "Engine unpause");
      }
    };
    store.on("settings:updated", onEngineUnpause);
    this.settingsHandlers.push(onEngineUnpause);

    // 6. Maintenance interval change — reschedule mergeActive reconciliation
    const onMaintenanceIntervalChange = ({
      settings: s,
      previous: prev,
    }: {
      settings: Settings;
      previous: Settings;
    }) => {
      if (s.maintenanceIntervalMs === prev.maintenanceIntervalMs) {
        return;
      }
      if (this.mergeActiveReconcileTimer) {
        clearInterval(this.mergeActiveReconcileTimer);
        this.mergeActiveReconcileTimer = null;
      }
      this.scheduleMergeActiveReconciliation(s.maintenanceIntervalMs ?? 900_000);
    };
    store.on("settings:updated", onMaintenanceIntervalChange);
    this.settingsHandlers.push(onMaintenanceIntervalChange);

    // 7. Stuck task timeout change — trigger immediate check
    const onStuckTimeoutChange = async ({
      settings: s,
      previous: prev,
    }: {
      settings: Settings;
      previous: Settings;
    }) => {
      if (s.taskStuckTimeoutMs !== prev.taskStuckTimeoutMs) {
        runtimeLog.log(
          `Stuck task timeout changed to ${s.taskStuckTimeoutMs}ms — running immediate check`,
        );
        try {

          const detector = (this.runtime as any).stuckTaskDetector;
          await detector?.checkNow?.();
        } catch (err: unknown) {
          runtimeLog.warn(
            `Stuck-timeout change: detector.checkNow() failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };
    store.on("settings:updated", onStuckTimeoutChange);
    this.settingsHandlers.push(onStuckTimeoutChange);

    // 7b. Verification concurrency — process-wide slot cap (clamped 1–8, min across projects)
    const onVerificationConcurrencyChange = ({
      settings: s,
      previous: prev,
    }: {
      settings: Settings;
      previous: Settings;
    }) => {
      if (s.maxConcurrentVerifications === prev.maxConcurrentVerifications) return;
      registerProjectVerificationLimit(this.config.projectId, s.maxConcurrentVerifications ?? 1);
      runtimeLog.log(
        `maxConcurrentVerifications updated for ${this.config.projectId} to ${s.maxConcurrentVerifications ?? 1}`,
      );
    };
    store.on("settings:updated", onVerificationConcurrencyChange);
    this.settingsHandlers.push(onVerificationConcurrencyChange);

    // 8. Memory maintenance settings change — sync automations
    const onInsightSettingsChange = async ({
      settings: s,
      previous: prev,
    }: {
      settings: Settings;
      previous: Settings;
    }) => {
      const insightKeys = [
        "insightExtractionEnabled",
        "insightExtractionSchedule",
        "insightExtractionMinIntervalMs",
      ] as const;
      const dreamKeys = [
        "memoryDreamsEnabled",
        "memoryDreamsSchedule",
      ] as const;


      const changed = insightKeys.some((key) => (s as any)[key] !== (prev as any)[key]);

      const dreamsChanged = dreamKeys.some((key) => (s as any)[key] !== (prev as any)[key]);
      if ((!changed && !dreamsChanged) || !this.automationStore) return;

      try {
        const { syncInsightExtractionAutomation, syncMemoryDreamsAutomation } = await import("@fusion/core");
        if (changed && typeof syncInsightExtractionAutomation === "function") {
          await syncInsightExtractionAutomation(this.automationStore, s);
          runtimeLog.log("Insight extraction automation synced with settings");
        }
        if (dreamsChanged && typeof syncMemoryDreamsAutomation === "function") {
          await syncMemoryDreamsAutomation(this.automationStore, s);
          runtimeLog.log("Memory dreams automation synced with settings");
        }
      } catch (err) {
        const { message, detail } = formatErrorDetails(err);
        this.setAutomationSubsystemHealth(
          "degraded",
          `Failed to sync memory maintenance automation: ${message}`,
        );
        runtimeLog.warn(`Failed to sync memory maintenance automation:\n${detail}`);
      }
    };
    store.on("settings:updated", onInsightSettingsChange);
    this.settingsHandlers.push(onInsightSettingsChange);

    // 9. Auto-summarize settings change — sync automation
    const onAutoSummarizeSettingsChange = async ({
      settings: s,
      previous: prev,
    }: {
      settings: Settings;
      previous: Settings;
    }) => {
      const autoSummarizeKeys = [
        "memoryAutoSummarizeEnabled",
        "memoryAutoSummarizeThresholdChars",
        "memoryAutoSummarizeSchedule",
      ] as const;


      const changed = autoSummarizeKeys.some((key) => (s as any)[key] !== (prev as any)[key]);
      if (!changed || !this.automationStore) return;

      try {
        const { syncAutoSummarizeAutomation } = await import("@fusion/core");
        if (typeof syncAutoSummarizeAutomation === "function") {
          await syncAutoSummarizeAutomation(this.automationStore, s);
          runtimeLog.log("Auto-summarize automation synced with settings");
        }
      } catch (err) {
        const { message, detail } = formatErrorDetails(err);
        this.setAutomationSubsystemHealth(
          "degraded",
          `Failed to sync auto-summarize automation: ${message}`,
        );
        runtimeLog.warn(`Failed to sync auto-summarize automation:\n${detail}`);
      }
    };
    store.on("settings:updated", onAutoSummarizeSettingsChange);
    this.settingsHandlers.push(onAutoSummarizeSettingsChange);

    // 10. Scheduled eval settings change — sync automation
    const onScheduledEvalSettingsChange = async ({
      settings: s,
      previous: prev,
    }: {
      settings: Settings;
      previous: Settings;
    }) => {
      const evalKeys = [
        "taskEvaluationEnabled",
        "taskEvaluationSchedule",
      ] as const;

      const changed = evalKeys.some((key) => (s as any)[key] !== (prev as any)[key]);
      if (!changed || !this.automationStore) return;

      try {
        const { syncScheduledEvalBatchAutomation } = await import("@fusion/core");
        if (typeof syncScheduledEvalBatchAutomation === "function") {
          await syncScheduledEvalBatchAutomation(this.automationStore, s);
          runtimeLog.log("Scheduled eval automation synced with settings");
        }
      } catch (err) {
        const { message, detail } = formatErrorDetails(err);
        this.setAutomationSubsystemHealth(
          "degraded",
          `Failed to sync scheduled eval automation: ${message}`,
        );
        runtimeLog.warn(`Failed to sync scheduled eval automation:\n${detail}`);
      }
    };
    store.on("settings:updated", onScheduledEvalSettingsChange);
    this.settingsHandlers.push(onScheduledEvalSettingsChange);
  }

  /**
   * Build the onScheduleRunProcessed callback for CronRunner.
   * Chains the built-in processAndAuditInsightExtraction with any
   * caller-provided onInsightRunProcessed callback.
   */
  private buildInsightRunHandler(
    cwd: string,
  ): (schedule: ScheduledTask, result: AutomationRunResult) => Promise<void> {
    const callerCallback = this.options.onInsightRunProcessed;

    return async (schedule: ScheduledTask, result: AutomationRunResult): Promise<void> => {
      // Invoke caller-provided callback first (e.g. for test hooks)
      if (callerCallback) {
        try {
          await callerCallback(schedule, result);
        } catch (err) {
          runtimeLog.warn(
            "onInsightRunProcessed callback error:",
            err instanceof Error ? err.message : err,
          );
        }
      }

      // Run built-in processAndAuditInsightExtraction
      try {
        const { INSIGHT_EXTRACTION_SCHEDULE_NAME, processAndAuditInsightExtraction } =
          await import("@fusion/core");

        if (
          typeof INSIGHT_EXTRACTION_SCHEDULE_NAME !== "string" ||
          typeof processAndAuditInsightExtraction !== "function"
        ) {
          return;
        }

        if (schedule.name !== INSIGHT_EXTRACTION_SCHEDULE_NAME) {
          return;
        }

        const stepResults = result.stepResults ?? [];
        const aiStep = stepResults.find(
          (sr) =>
            sr.stepName === "Extract Memory Insights and Prune" ||
            sr.stepName === "Extract Memory Insights",
        );

        if (!aiStep) {
          runtimeLog.log(`No insight extraction step found in ${schedule.name} result`);
          return;
        }

        runtimeLog.log("Processing memory insight extraction run...");

        const auditReport = await processAndAuditInsightExtraction(cwd, {
          rawResponse: aiStep.output ?? "",
          stepSuccess: aiStep.success,
          runAt: result.startedAt,
          error: aiStep.error,
        });

        const pruneStatus = auditReport.pruning.applied
          ? ` | Pruned: ${auditReport.pruning.originalSize} -> ${auditReport.pruning.newSize} chars`
          : ` | Pruning: ${auditReport.pruning.reason}`;

        runtimeLog.log(
          `Memory audit complete — Health: ${auditReport.health}, ` +
            `Insights: ${auditReport.insightsMemory.insightCount}${pruneStatus}`,
        );
      } catch (err) {
        runtimeLog.warn(
          "Failed to process insight extraction:",
          err instanceof Error ? err.message : err,
        );
      }
    };
  }
}
