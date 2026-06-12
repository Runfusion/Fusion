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
} from "@fusion/core";
import { allowsAutoMergeProcessing, compareTasksByPriorityThenAgeAndId, getTaskHardMergeBlocker, isSharedBranchGroupMemberIntegration, normalizeMergerMode, sortTasksByPriorityThenAgeAndId } from "@fusion/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { InProcessRuntime } from "./runtimes/in-process-runtime.js";
import type { WorktreePool } from "./worktree-pool.js";
import type { ProjectRuntimeConfig } from "./project-runtime.js";
import { PrMonitor } from "./pr-monitor.js";
import type { PrNodeGithubOps } from "./pr-nodes.js";
import { PrReconciler, type PrReconcileGithubOps } from "./pr-reconcile.js";
import { PrCommentHandler } from "./pr-comment-handler.js";
import { NtfyNotifier } from "./notifier.js";
import { NotificationService, OAuthAlertStateStore, OAuthExpiryMonitor, OAuthValidityLogger } from "./notification/index.js";
import type { NotificationChatStore } from "./notification/notification-service.js";
import { GridlockDetector } from "./gridlock-detector.js";
import { createFusionAuthStorage, getFusionOAuthAlertStatePath } from "./auth-storage.js";
import { CronRunner, createAiPromptExecutor } from "./cron-runner.js";
import type { RoutineRunner } from "./routine-runner.js";
import { aiMergeTask, sweepStaleAutostashes, VerificationError } from "./merger.js";
import { runAiMerge } from "./merger-ai.js";
import { promoteBranchGroup, type BranchGroupPromotionResult, type CreateGroupPrFn, type SyncGroupPrFn } from "./group-merge-coordinator.js";
import { PRIORITY_MERGE } from "./concurrency.js";
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
import { isTransientError } from "./transient-error-detector.js";
import { classifyTransientMergeError } from "./transient-merge-error-classifier.js";
import { TunnelProcessManager } from "./remote-access/tunnel-process-manager.js";
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

function isInvalidDoneTransitionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Invalid transition:") && message.includes("→ 'done'");
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
  private prReconciler?: PrReconciler;
  private prCommentHandler?: PrCommentHandler;
  private notifier?: NtfyNotifier;
  private notificationService?: NotificationService;
  private oauthExpiryMonitor?: OAuthExpiryMonitor;
  private oauthValidityLogger?: OAuthValidityLogger;
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
  private mergeAbortController: AbortController | null = null;
  private mergeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private autostashSweepTimer: ReturnType<typeof setTimeout> | null = null;
  private mergeActiveReconcileTimer: ReturnType<typeof setInterval> | null = null;

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

  private static readonly MAX_AUTO_MERGE_RETRIES = 3;
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
    this.runtime.setMergeEnqueuer?.((taskId) => {
      // If the wedged attempt was the active one, abort its in-flight signal
      // and dispose its session so subsequent code paths can release file
      // handles / child processes promptly.
      if (this.activeMergeTaskId === taskId) {
        this.mergeAbortController?.abort();
        this.mergeAbortController = null;
        this.activeMergeSession?.dispose();
        this.activeMergeSession = null;
        this.activeMergeTaskId = null;
      }
      this.mergeActive.delete(taskId);
      return this.internalEnqueueMerge(taskId);
    });
    this.runtime.setMergeActiveClearer?.((taskId) => {
      this.mergeActive.delete(taskId);
    });
    // Workflow-graph interpreter merge seam: routes through the auto-merge
    // eligibility gate (requestInterpreterMerge), NOT the human "merge now"
    // bypass, so a graph merge node can't override an autoMerge-off project.
    this.runtime.setMergeRequester?.((taskId, options) => this.requestInterpreterMerge(taskId, options));
  }

  getActiveMergeTaskId(): string | null {
    return this.activeMergeTaskId;
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

    const store = this.runtime.getTaskStore();
    const cwd = this.config.workingDirectory;
    const settings = await store.getSettings();

    if (typeof (store as { getResearchStore?: () => unknown }).getResearchStore === "function") {
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
        store: store.getResearchStore(),
        stepRunner: new ResearchStepRunner({ providers, synthesisRunner }),
        maxConcurrentRuns: settings.researchMaxConcurrentRuns ?? 3,
      });
      this.researchDispatcher = new ResearchRunDispatcher({
        store: store.getResearchStore(),
        orchestrator: this.researchOrchestrator,
      });
      this.researchDispatcher.start();
    }

    this.remoteTunnelManager = new TunnelProcessManager();
    try {
      await this.restoreRemoteTunnelIfNeeded(store);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setRestoreDiagnostics("failed", "restore_start_failed", null, message);
      runtimeLog.warn(`Remote tunnel restore evaluation failed (continuing startup): ${message}`);
    }

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

    // 3. Initialize notification services (unless caller manages them externally)
    if (!this.options.skipNotifier) {
      const agentStore = this.runtime.getAgentStore();
      const agentNameResolver = agentStore
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
        agentNameResolver,
      });
      await this.notificationService.start();
      const authStorage = createFusionAuthStorage();
      const oauthAlertState = new OAuthAlertStateStore({
        statePath: getFusionOAuthAlertStatePath(),
      });
      this.oauthExpiryMonitor = new OAuthExpiryMonitor({
        authStorage,
        notificationService: this.notificationService,
        alertState: oauthAlertState,
      });
      await this.oauthExpiryMonitor.start();
      this.oauthValidityLogger = new OAuthValidityLogger({
        authStorage,
        alertState: oauthAlertState,
      });
      await this.oauthValidityLogger.start();

      // Backward-compatibility shim for gridlock notifications.
      this.notifier = new NtfyNotifier(
        store,
        {
          projectId: this.options.projectId,
          ntfyBaseUrl: this.options.ntfyBaseUrl,
          agentNameResolver,
        },
        this.notificationService,
      );
      await this.notifier.start();
    }

    this.gridlockDetector = new GridlockDetector(store, {
      onGridlock: (event) => this.notifier?.notifyGridlock(event),
      onGridlockCleared: () => this.notifier?.notifyGridlock(null),
    });
    this.gridlockDetector.start();

    // 4. Initialize AutomationStore + CronRunner
    this.setAutomationSubsystemHealth(
      "initializing",
      "Initializing AutomationStore and CronRunner",
    );
    try {
      const coreAutomationModule = await import("@fusion/core");
      const { AutomationStore } = coreAutomationModule;
      this.automationStore = new AutomationStore(cwd);
      await this.automationStore.init();

      const aiPromptExecutor = await createAiPromptExecutor(cwd);
      this.cronRunner = new CronRunner(store, this.automationStore, {
        aiPromptExecutor,
        onScheduleRunProcessed: this.buildInsightRunHandler(cwd),
        workingDirectory: cwd,
        projectId: this.config.projectId,
        scope: "project", // Project-scoped execution — global schedules run separately
      });

      const settings = await store.getSettings();
      const startupSyncFailures: string[] = [];

      // Sync insight extraction automation on startup
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

      // Sync auto-summarize automation on startup
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

      // Sync memory dreams automation on startup
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

      // Sync scheduled eval batch automation on startup
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

      this.cronRunner.start();

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

    // 6. Wire auto-merge on task:moved and task:updated pause interruptions
    this.wireAutoMerge(store, cwd);
    this.wireTaskPauseMergeInterruption(store);
    this.wireAutostashOrphanRecovery(store);

    // 7. Auto-merge startup sweep
    await this.startupMergeSweep(store);

    // 8. Start periodic merge retry sweep
    this.scheduleMergeRetry(store);
    this.scheduleMergeActiveReconciliation(settings.maintenanceIntervalMs ?? 900_000);

    // 9. Startup + periodic stale autostash sweeps (independent of autoMerge)
    void this.runStaleAutostashSweep(store, "startup");
    this.scheduleStaleAutostashSweep(store);

    this.started = true;
    runtimeLog.log(`ProjectEngine started for ${this.config.projectId}`);
  }

  /**
   * Gracefully stop the engine and all subsystems.
   *
   * If a merge is currently running, its abort signal is triggered before the
   * active merge session is disposed so merge pipeline checkpoints can exit
   * promptly without continuing git/verification work after shutdown starts.
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.shuttingDown = true;

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

    // Abort active/pending merge work before tearing down sessions.
    this.mergeAbortController?.abort();
    this.mergeAbortController = null;
    this.activeMergeTaskId = null;
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

  /** Get the MessageStore (if initialized). Returns undefined before start(). */
  getMessageStore(): import("@fusion/core").MessageStore | undefined {
    return this.runtime.getMessageStore();
  }

  /** Get the ChatStore (if initialized). Returns undefined before start(). */
  getChatStore(): import("@fusion/core").ChatStore | undefined {
    return this.runtime.getChatStore();
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

  /** Get the CronRunner (if initialized). */
  getCronRunner(): CronRunner | undefined {
    return this.cronRunner;
  }

  /** Get the AutomationStore (if initialized). */
  getAutomationStore(): AutomationStoreType | undefined {
    return this.automationStore;
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
    try {
      const store = this.runtime.getTaskStore();
      settings = await store.getSettings();
      task = await store.getTask(taskId);
    } catch {
      // Fall through to the not-eligible response below.
    }
    const eligible = !!task && !!settings
      && task.column === "in-review"
      && !settings.globalPause && !settings.enginePaused
      && this.allowInReviewMergeProcessing(task, settings)
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
  }): boolean {
    if (task.column !== "in-review") return false;
    if ((task.mergeRetries ?? 0) < ProjectEngine.MAX_AUTO_MERGE_RETRIES) return false;
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
  }): boolean {
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
      (task.mergeRetries ?? 0) < ProjectEngine.MAX_AUTO_MERGE_RETRIES ||
      this.hasAutoHealableVerificationBufferFailure(task) ||
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

  private getShadowMergeRequestCandidateId(): string | null {
    const store = this.runtime.getTaskStore() as TaskStore & {
      getMergeRequestRecord?: (taskId: string) => { state: string } | null;
    };
    if (typeof store.getMergeRequestRecord !== "function") {
      return null;
    }

    for (const queuedTaskId of this.mergeQueue) {
      const record = store.getMergeRequestRecord(queuedTaskId);
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

  /**
   * Filter a sweep's listTasks() result to merge-eligible tasks, sort by
   * priority (urgent → low, then createdAt ASC, then id ASC), and enqueue.
   * Sorting before enqueue matters because each enqueue may immediately
   * trigger drainMergeQueue's single-item fast path, so the first task
   * pushed wins. listTasks returns createdAt ASC — without this sort an
   * older low-priority task would start before a later urgent one.
   */
  private allowInReviewMergeProcessing(task: Pick<Task, "branchContext" | "autoMerge">, settings: Pick<Settings, "autoMerge">): boolean {
    return allowsAutoMergeProcessing(task, settings) || isSharedBranchGroupMemberIntegration(task);
  }

  private enqueueEligibleInReviewTasks(tasks: readonly Task[], settings: Pick<Settings, "autoMerge">): number {
    const eligible = sortTasksByPriorityThenAgeAndId(
      tasks.filter((t) => !t.paused && this.canMergeTask(t as any) && this.allowInReviewMergeProcessing(t, settings)) as Task[],
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
      const cwd = this.config.workingDirectory;

      while (this.mergeQueue.length > 0 && !this.shuttingDown) {
        const shadowCandidateTaskId = this.getShadowMergeRequestCandidateId();
        const taskId = await this.pickNextMergeTaskId(store);
        if (!taskId) break;
        const shadowSettings = await store.getSettings();
        if (shadowSettings.mergeRequestContractShadowEnabled === true) {
          this.emitMergeRequestShadowDequeueParity(taskId, shadowCandidateTaskId);
          const mergeRequest = store.getMergeRequestRecord(taskId);
          if (mergeRequest?.state === "manual-required" || mergeRequest?.state === "cancelled" || mergeRequest?.state === "succeeded" || mergeRequest?.state === "exhausted") {
            continue;
          }
          if (mergeRequest && (mergeRequest.state === "queued" || mergeRequest.state === "retrying")) {
            if (mergeRequest.state === "retrying") {
              store.transitionMergeRequestState(taskId, "queued", { attemptCount: mergeRequest.attemptCount, lastError: mergeRequest.lastError });
            }
            store.transitionMergeRequestState(taskId, "running", { attemptCount: mergeRequest.attemptCount, lastError: mergeRequest.lastError });
          }
          if (mergeRequest?.state === "running") {
            const ageMs = Date.now() - Date.parse(mergeRequest.updatedAt);
            if ((mergeRequest.attemptCount ?? 0) >= ProjectEngine.MAX_AUTO_MERGE_TRANSIENT_RETRIES && ageMs >= ProjectEngine.MERGE_REQUEST_RETRY_EXHAUSTED_AGE_MS) {
              store.transitionMergeRequestState(taskId, "exhausted", {
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
            if (!this.allowInReviewMergeProcessing(task, settings)) {
              runtimeLog.log(`Auto-merge skipping ${taskId} — autoMerge disabled`);
              continue;
            }
            if (task.paused && !task.mergeDetails?.mergeConfirmed) {
              runtimeLog.log(`Auto-merge skipping ${taskId} — task is paused`);
              continue;
            }

            // Intentional cast to access Task properties needed by merge validation

            if (!this.canMergeTask(task as any)) {
              continue;
            }

            // Fast path: merge already confirmed (e.g. task was moved back to
            // in-review by auto-recovery after a successful merge) — just
            // complete the task without re-running the merge process.
            if (task.mergeDetails?.mergeConfirmed) {
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
              const branchGroupForFastPath = isSharedBranchGroupMemberIntegration(task)
                ? (store as any).getBranchGroup?.(task.branchContext?.groupId)
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
              const reachability = await verifyMergeConfirmedReachability({
                commitSha: task.mergeDetails.commitSha,
                integrationBranch: integrationBranchForGate,
                cwd,
              });
              if (!reachability.reachable) {
                const sha = task.mergeDetails.commitSha || "";
                const shortSha = sha ? sha.slice(0, 8) : "<no-sha>";
                const currentRetries = task.mergeRetries ?? 0;
                const budgetExhausted =
                  currentRetries >= ProjectEngine.MAX_AUTO_MERGE_RETRIES;

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
                // dequeue runs a fresh `aiMergeTask` against the task branch —
                // because the merger's TOCTOU is now fixed, the redo either
                // lands cleanly or fails with a real merger error that surfaces
                // through normal lifecycle. We don't need an executor to be
                // re-engaged for this kind of recovery; the branch already
                // has the work, it just needs to be re-applied to the
                // integration tip.
                const nextRetries = currentRetries + 1;
                runtimeLog.warn(
                  `Auto-merge: ${taskId} fast-path REFUSED — auto-recovering (attempt ${nextRetries}/${ProjectEngine.MAX_AUTO_MERGE_RETRIES}): ${reachability.reason}: ${reachability.diagnostic}`,
                );
                // Prefix MUST be "Auto-recovered:" so NotificationService's
                // maybeSuppressTransientFailedNotification cancels the pending
                // ntfy fired off the underlying task:failed event.
                await store.logEntry(
                  taskId,
                  `Auto-recovered: fast-path refused — cleared poisoned mergeDetails (commit ${shortSha} not reachable from ${integrationBranchForGate}, ${reachability.reason}). Re-enqueueing for fresh merge attempt ${nextRetries}/${ProjectEngine.MAX_AUTO_MERGE_RETRIES} [FN-5627].`,
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
                      maxRetries: ProjectEngine.MAX_AUTO_MERGE_RETRIES,
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
                // and falls through to the normal `aiMergeTask` path.
                this.internalEnqueueMerge(taskId);
                continue;
              }
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
                `Auto-merge: ${taskId} already has mergeConfirmed — unpausing and moving to done`,
              );
              await store.logEntry(
                taskId,
                "Merge already confirmed; unpausing and completing task (recovered from post-merge state inconsistency)",
              );
              await store.updateTask(taskId, { paused: false, status: null, error: null });
              try {
                const movedTask = await store.moveTask(taskId, "done");
                const mergedTask = movedTask ?? (await store.getTask(taskId).catch(() => null)) ?? task;
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
              } catch (error) {
                if (isInvalidDoneTransitionError(error)) {
                  const latest = await store.getTask(taskId).catch(() => null);
                  if (latest && latest.column !== "in-review") {
                    runtimeLog.warn(
                      `Auto-merge: ${taskId} merge-confirmed finalize skipped — task moved to ${latest.column} before done transition`,
                    );
                    await store.logEntry(
                      taskId,
                      `Merge confirmed finalize skipped: task moved to '${latest.column}' before in-review → done transition`,
                    );
                    continue;
                  }
                }
                throw error;
              }
              continue;
            }

            // Auto-heal verification buffer failures by resetting retry counter

            if (this.hasAutoHealableVerificationBufferFailure(task as any)) {
              await store.logEntry(
                taskId,
                "Auto-healing stale deterministic verification buffer failure; retrying merge verification",
              );
              await store.updateTask(taskId, { mergeRetries: 0, error: null, status: null });
            } else if (
              (task.mergeRetries ?? 0) >= ProjectEngine.MAX_AUTO_MERGE_RETRIES &&

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
          const activeMergingTask = store.getActiveMergingTask(taskId);
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

          if (mergeStrategy === "pull-request" && this.options.processPullRequestMerge) {
            this.activeMergeTaskId = taskId;
            runtimeLog.log(`${hasManualResolver ? "Manual" : "Auto"}-merge processing PR flow for ${taskId}...`);
            const result = await this.options.processPullRequestMerge(
              store,
              cwd,
              taskId,
              (this.runtime as any).worktreePool,
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

            const semaphore = (this.runtime as any).globalSemaphore;

            const pool = (this.runtime as any).worktreePool;

            const agentStore = (this.runtime as any).agentStore;

            const usageLimitPauser = (this.runtime as any).usageLimitPauser;

            const rawMerge = async () => {
              this.activeMergeTaskId = taskId;
              this.mergeAbortController = new AbortController();
              const mergerOptions = {
                manual: hasManualResolver,
                pool,
                usageLimitPauser,
                agentStore,
                signal: this.mergeAbortController.signal,
                syncGroupPr: this.options.syncGroupPr,
                onSession: (session: { dispose: () => void }) => {
                  this.activeMergeSession = session;
                },
              };
              // FN-5633: "ai" mode (default) uses the standalone AI merge path
              // (clean-room worktree + AI merge + AI reviewer); "deterministic"
              // keeps the legacy aiMergeTask pipeline.
              const settings = await store.getSettings().catch(() => ({}) as Settings);
              const mergerMode = normalizeMergerMode(settings.merger?.mode);
              const mergeOptionsWithSettings = {
                ...mergerOptions,
                allowDirtyLocalCheckoutSync: settings.merger?.allowDirtyLocalCheckoutSync === true,
              };
              return mergerMode === "ai"
                ? runAiMerge(store, cwd, taskId, mergeOptionsWithSettings)
                : aiMergeTask(store, cwd, taskId, mergerOptions);
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

              // Use `currentRetries + 1 < MAX` (not `currentRetries < MAX`) so
              // the LAST retry's failure goes straight to the bounce code in
              // this same engine tick. The previous condition scheduled a
              // separate Nth setTimeout attempt — if the engine restarted
              // before that timer fired (common during dev), the task was
              // stranded with mergeRetries=MAX and only the cooldown sweep
              // could ever try again (silent loop).
              if (
                (settingsOnErr as Settings).autoResolveConflicts !== false &&
                currentRetries + 1 < ProjectEngine.MAX_AUTO_MERGE_RETRIES
              ) {
                const newRetryCount = currentRetries + 1;
                await store.updateTask(taskId, { mergeRetries: newRetryCount, status: null });

                // Exponential backoff: 5s, 10s, 20s
                const delayMs = 5000 * Math.pow(2, currentRetries);
                runtimeLog.log(
                  `Auto-merge conflict retry ${newRetryCount}/${ProjectEngine.MAX_AUTO_MERGE_RETRIES} for ${taskId} in ${delayMs / 1000}s`,
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
                      mergeRetries: ProjectEngine.MAX_AUTO_MERGE_RETRIES,
                      error: `Auto-merge gave up: ${reason}. ${errorMsg}`,
                    });
                    await store.addTaskComment(
                      taskId,
                      `Auto-merge gave up after ${ProjectEngine.MAX_AUTO_MERGE_RETRIES} conflict-resolution retries (${reason}). ` +
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
                      `Auto-merge could not resolve conflicts within ${ProjectEngine.MAX_AUTO_MERGE_RETRIES} retries (bounce ${nextBounces}/${bounceCap}). ` +
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
                      `Auto-merge conflicts unresolved (${ProjectEngine.MAX_AUTO_MERGE_RETRIES}/${ProjectEngine.MAX_AUTO_MERGE_RETRIES}) — bounced to in-progress for re-rebase (bounce ${nextBounces}/${bounceCap})`,
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
                    const record = store.getMergeRequestRecord(taskId);
                    if (record && record.state !== "exhausted" && record.state !== "cancelled" && record.state !== "succeeded") {
                      if (record.state === "running") {
                        store.transitionMergeRequestState(taskId, "retrying", {
                          attemptCount: record.attemptCount,
                          lastError: errorMsg,
                        });
                      }
                      const refreshed = store.getMergeRequestRecord(taskId);
                      if (refreshed && refreshed.state === "retrying") {
                        store.transitionMergeRequestState(taskId, "exhausted", {
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
                  mergeRetries: ProjectEngine.MAX_AUTO_MERGE_RETRIES,
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
                  const record = store.getMergeRequestRecord(taskId);
                  if (record && record.state !== "exhausted" && record.state !== "cancelled" && record.state !== "succeeded") {
                    if (record.state === "running") {
                      store.transitionMergeRequestState(taskId, "retrying", {
                        attemptCount: record.attemptCount,
                        lastError: errorMsg,
                      });
                    }
                    const refreshed = store.getMergeRequestRecord(taskId);
                    if (refreshed && refreshed.state === "retrying") {
                      store.transitionMergeRequestState(taskId, "exhausted", {
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
                mergeRetries: ProjectEngine.MAX_AUTO_MERGE_RETRIES,
                error: errorMsg,
              });
            } catch (recoveryErr) {
              runtimeLog.error(
                `Auto-merge: failed to update ${taskId} after merge strategy error: ${recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)}`,
              );
            }
          }
        } finally {
          if (this.activeMergeTaskId === taskId) {
            this.activeMergeTaskId = null;
          }
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
      const record = store.getMergeRequestRecord(taskId);
      if (record && record.state !== "manual-required" && record.state !== "cancelled" && record.state !== "succeeded" && record.state !== "exhausted") {
        if (record.state === "running") {
          store.transitionMergeRequestState(taskId, "retrying", {
            attemptCount: nextRetryCount,
            lastError: errorMsg,
          });
        }
        if (store.getMergeRequestRecord(taskId)?.state === "retrying") {
          store.transitionMergeRequestState(taskId, "queued", {
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
          if (!this.allowInReviewMergeProcessing(latestTask, settings)) {
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

        runtimeLog.log(`Paused in-review task interrupting active merge: ${task.id}`);
        this.mergeAbortController?.abort();
        this.mergeAbortController = null;

        if (this.activeMergeSession) {
          this.activeMergeSession.dispose();
          this.activeMergeSession = null;
        }

        this.mergeActive.delete(task.id);
        return;
      }

      const wasPaused = this.pausedReviewTaskIds.delete(task.id);
      if (!wasPaused) {
        return;
      }

      try {
        const settings = await store.getSettings();
        if (settings.globalPause || settings.enginePaused || !this.allowInReviewMergeProcessing(task, settings)) {
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

      runtimeLog.log(`Soft-deleted task interrupting active merge: ${task.id}`);
      this.mergeAbortController?.abort();
      this.mergeAbortController = null;

      if (this.activeMergeSession) {
        this.activeMergeSession.dispose();
        this.activeMergeSession = null;
      }

      this.mergeActive.delete(task.id);
      this.activeMergeTaskId = null;
    };

    store.on("task:updated", this.taskUpdatedHandler);
    store.on("task:deleted", this.taskDeletedHandler);
  }

  private async startupMergeSweep(store: TaskStore): Promise<void> {
    try {
      const tasks = await store.listTasks({ column: "in-review" });

      // Clear stale "merging"/"merging-pr" statuses left by a prior crash.
      // No merge is actually running at startup, so any task still marked
      // as merging is a leftover from a previous engine lifecycle.
      // This runs unconditionally (regardless of autoMerge setting) because
      // stale statuses block manual merges too.
      const staleStatuses = new Set(["merging", "merging-pr"]);
      for (const t of tasks) {
        if (t.status && staleStatuses.has(t.status)) {
          runtimeLog.log(`Startup sweep: clearing stale '${t.status}' status on ${t.id}`);
          await store.updateTask(t.id, { status: null });
          // Update in-memory object so canMergeTask sees the cleared status

          (t as any).status = null;
        }
      }

      const settings = await store.getSettings();

      const enqueued = this.enqueueEligibleInReviewTasks(tasks as Task[], settings);
      if (enqueued > 0) {
        runtimeLog.log(`Auto-merge startup sweep: enqueueing ${enqueued} task(s)`);
      }
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
          this.enqueueEligibleInReviewTasks(tasks as Task[], settings);
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
      this.enqueueEligibleInReviewTasks(tasks as Task[], settings);
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

    // 3. Global unpause — resume orphaned tasks + sweep in-review
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

    // 4. Engine unpause — same as global unpause
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

    // 5. Maintenance interval change — reschedule mergeActive reconciliation
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

    // 6. Stuck task timeout change — trigger immediate check
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

    // 7. Memory maintenance settings change — sync automations
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

    // 8. Auto-summarize settings change — sync automation
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

    // 9. Scheduled eval settings change — sync automation
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
