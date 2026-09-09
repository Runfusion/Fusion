/**
 * FNXC:CodeOrganization 2026-08-04-07:10:
 * TaskExecutor instance state fields peeled to a base class (U4) so executor.ts keeps
 * thin method facades only. Fields are protected (not private) so TaskExecutor methods
 * and runtime tests that poke (executor as any).fieldName keep working.
 */
import type {
  Agent,
  AgentStore,
  TaskStore,
  RunMutationContext,
  MergeResult,
  ThinkingLevel,
  WorkflowColumnAgent,
  ApprovalRequestStore,
  WorkspaceConfig,
} from "@fusion/core";
import type { ImplementationExit } from "./implementation-exit.js";
import type { ForeachActiveContext } from "../workflows/workflow-node-handlers.js";
import { ModelRegistry, type AgentSession } from "@earendil-works/pi-coding-agent";
import { CliTaskSession } from "../cli-agent/task-session.js";
import { TokenCapDetector } from "../errors/token-cap-detector.js";
import { StepSessionExecutor } from "../execution/step-session-executor.js";
import type { PausedAbortProvenance } from "./paused-abort-provenance.js";
import type { ActiveExecutorSessionState, TaskExecutorOptions } from "./task-executor-options.js";
import type { WorkflowAgentCapacity } from "../agents/workflow-agent-capacity.js";
import { invalidateWorkspaceConfigCache } from "./workspace-config-resolver.js";

export abstract class TaskExecutorState {
  /**
   * FNXC:CodeOrganization 2026-08-04-08:05:
   * Constructor-injected store/rootDir/options live on the state base (U4) so pure
   * worktree facades and bags can share them without TaskExecutor parameter properties.
   */
  protected store!: TaskStore;
  protected rootDir!: string;
  protected options: TaskExecutorOptions = {};
  protected activeWorktrees = new Map<string, Set<string>>();
  /**
   * FNXC:WorkflowAgentRouting 2026-08-07-03:46:
   * Workflow stage reservations are intentionally independent from heartbeat slots.
   * Constructed in wireTaskExecutorLifecycle so direct graph admission and triage share the same class.
   */
  protected workflowAgentCapacity!: WorkflowAgentCapacity;
  /**
   * FNXC:WorkflowAgentRouting 2026-08-07-03:46:
   * Process-local index carrying a durable work item's narrow authority to the model tool gate.
   * Keyed by task for the live graph turn; removed in graph cleanup. isLive revalidates the exact record.
   */
  protected activeWorkflowAuthorities = new Map<string, {
    agentId: string;
    taskId: string;
    runId: string;
    workItemId: string;
    nodeInstanceId: string;
    /** Direct graph runs have no work-item row; claimed continuations must recheck it per tool call. */
    requiresDurableFence: boolean;
    kind: "task-assignee" | "review-node-override";
  }>();
  /**
   * FNXC:WorkflowAgentRouting 2026-08-07-03:46:
   * Live fenced principal per task for execute/review session identity (exact graph-selected agent).
   * `agent` is the admission-time row so session identity does not depend on a second getAgent round-trip.
   */
  protected activeWorkflowPrincipals = new Map<string, { agentId: string; nodeInstanceId: string; agent?: Agent }>();
  /**
   * FNXC:AgentActivityStream 2026-08-09-13:59 (restored 2026-08-15-22:15 after wave-18 shell-ification dropped it):
   * Node-scoped routed-principal retention (`taskId\0nodeId` -> agentId) that outlives release-principal,
   * because the graph can emit a terminal gate result AFTER the per-attempt reservation is released while
   * the activity outbox must still attribute that gate to the exact routed principal (FN-8864).
   */
  protected workflowGateActivityPrincipals = new Map<string, string>();
  protected executing = new Set<string>();
  /** Deferred terminal-park callbacks currently in flight (restart-recovery intent chain). */
  protected deferredTerminalParksInFlight = new Set<string>();
  protected resumingUnpaused = new Set<string>();
  protected approvalSuspended = new Set<string>();
  protected approvalResumeAfterUnwind = new Set<string>();
  protected recoveringCompleted = new Set<string>();
  protected capturedReflectionTaskIds = new Set<string>();
  /** Task ids that already had their Stash memory capture attempted (completion-gated). */
  protected capturedMemoryTaskIds = new Set<string>();
  protected workflowRerunPending = new Set<string>();
  protected workflowLifecycleMovesInFlight = new Set<string>();
  protected pendingTaskDisposals = new Map<string, Promise<void>>();
  protected unregisterTaskMoveDisposer: (() => void) | undefined;
  protected activeSessions = new Map<string, ActiveExecutorSessionState>();
  protected activeStepExecutors = new Map<string, StepSessionExecutor>();
  protected activeStepExecutorSeenSteeringIds = new Map<string, Set<string>>();
  protected effectiveColumnAgentByTask = new Map<string, string>();
  protected activeWorkflowStepSessions = new Map<string, AgentSession>();
  protected activePlanningWorkflowSessions = new Set<string>();
  protected activeWorkflowStepSessionSeenSteeringIds = new Map<string, Set<string>>();
  protected activeConfiguredCommandControllers = new Map<string, Set<AbortController>>();
  protected authoritativeAssignedAgentStore: AgentStore | null = null;
  protected activeWorkflowGraphAbortControllers = new Map<string, AbortController>();
  protected activeCliTaskSessions = new Map<string, CliTaskSession>();
  protected readonlyWorkflowStepAuditDone = false;
  protected activeSubagentSessions = new Map<string, Set<AgentSession>>();
  protected pausedAborted = new Set<string>();
  protected pausedAbortProvenance = new Map<string, PausedAbortProvenance>();
  protected completionFinalizedTaskIds = new Set<string>();
  protected depAborted = new Set<string>();
  protected stuckAborted = new Map<string, boolean>();
  protected userCanceledTaskIds = new Set<string>();
  protected graphExecuteSelfRequeued = new Set<string>();
  protected loopRecoveryState = new Map<string, { attempts: number; pending: boolean }>();
  protected spawnedAgents = new Map<string, Set<string>>();
  protected tokenUsageBaselines = new Map<string, { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; totalTokens: number }>();
  protected branchConflictErrorCount = new Map<string, number>();
  protected completedTaskWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  protected workflowRerunWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  protected pendingEphemeralDeletions = new Set<string>();
  protected workspaceConfig: WorkspaceConfig | null | undefined = undefined;
  /** Workspace mode is memoized per executor host; a real settings transition must refresh it live. */
  public invalidateWorkspaceConfig(): void {
    this.workspaceConfig = undefined;
    invalidateWorkspaceConfigCache(this);
  }
  protected childSessions = new Map<string, AgentSession>();
  protected totalSpawnedCount = 0;
  protected tokenCapDetector = new TokenCapDetector();
  protected _modelRegistry?: Promise<ModelRegistry>;
  protected _approvalRequestStore?: ApprovalRequestStore;
  protected currentRunContexts = new Map<string, RunMutationContext>();
  protected outerConcurrencyClaims = new Set<string>();
  protected graphToolFailureRunCursors = new Map<string, number>();
  protected graphStepSessionPinned = new Set<string>();
  protected graphStepRunOnce = new Map<string, Promise<{ taskDone: boolean; modifiedFiles: string[]; exit?: ImplementationExit }>>();
  protected graphStepActiveContext = new Map<string, ForeachActiveContext>();
  protected graphRethinkNarrations = new Map<string, string>();
  protected graphColumnAgentResolver = new Map<string, (nodeId: string) => WorkflowColumnAgent | undefined>();
  protected graphUnattendedRuns = new Set<string>();
  protected graphSeamGoverningNodeId = new Map<string, string>();
  protected graphSeamThinkingLevel = new Map<string, ThinkingLevel>();
  protected graphSeamSkillName = new Map<string, string>();
  protected mergeRequester?: (taskId: string, options?: { signal?: AbortSignal }) => Promise<MergeResult>;
  protected sessionContentionHoldAttempts = new Map<string, number>();
  /**
   * FNXC:CodeOrganization 2026-08-04-07:40:
   * Process-wide graph-routing set lives on the state base (U4). Instance getter keeps
   * host.graphRouting / host.constructor.processWideGraphRouting bag access unchanged.
   */
  protected static processWideGraphRouting = new Set<string>();
  protected get graphRouting(): Set<string> {
    return (this.constructor as typeof TaskExecutorState).processWideGraphRouting;
  }
}
