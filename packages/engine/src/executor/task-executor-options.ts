/**
 * FNXC:CodeOrganization 2026-08-03-21:00:
 * TaskExecutorOptions / CliAgentRuntime / ActiveExecutorSessionState peeled from
 * executor.ts preamble (U4) so the facade file keeps options types out of line.
 *
 * FNXC:WorkflowExecution 2026-07-19-01:30:
 * U5d (R9) — the `graphCompletionInterceptors` Map is DELETED. It was shared per-task
 * mutable state used to signal "this execute() call is a graph implementation phase":
 * the graph set an entry, re-entered execute(), and execute() read the Map at ~12 sites
 * to decide whether to stop at the implementation-complete boundary, skip outer routing,
 * suppress `fn_review_step`, and mark review gates graph-owned. Signalling through a
 * shared Map made the graph/legacy split invisible at the call site and left stale
 * entries to clean up on abort. It is replaced by an EXPLICIT optional
 * `graphCompletion` callback: presence of the callback IS the "graph-owned implementation
 * phase" signal, and invoking it hands the captured modifiedFiles back to the graph runner.
 *
 * FNXC:WorkflowExecution 2026-07-19-02:10:
 * U5e (R9) — the RE-ENTRY is now gone too. `executeCore`'s implementation body was lifted
 * into `runImplementation()`, which the graph seam calls DIRECTLY; `executeCore` is routing
 * only and `execute()` no longer carries a completion parameter. There is no longer any path
 * by which the graph runner calls back into `execute()`.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { MissionStore, AsyncMissionStore, Slice, Task, CliSessionStore } from "@fusion/core";
import type { AgentSemaphore } from "../concurrency/concurrency.js";
import type { WorktreePool } from "../worktree/worktree-pool.js";
import type { UsageLimitPauser } from "../errors/usage-limit-detector.js";
import type { CredentialInstanceRotator } from "../credential-instance-rotation.js";
import type { StuckTaskDetector } from "../healing/stuck-task-detector.js";
import type { AgentReflectionService } from "../agents/agent-reflection.js";
import type { PluginRunner } from "../plugins/plugin-runner.js";
import type { AutoRecoveryDispatcher } from "../healing/auto-recovery.js";
import type { GenerateFeatureVideoOptions } from "../review-artifacts/feature-video.js";
import type { CliSessionManager } from "../cli-agent/session-manager.js";
import type { TelemetryHub } from "../cli-agent/telemetry-hub.js";
import type { CliAdapterRegistry } from "../cli-agent/adapter.js";

export interface TaskExecutorOptions {
  /*
   * FNXC:PlanReviewLease 2026-07-26-21:07:
   * Resolves this engine's cluster node id for review-gate lease attribution. A GETTER, not a
   * value: the runtime resolves the id asynchronously during start(), which can complete after
   * the executor is constructed, so a snapshot taken at construction would be permanently
   * undefined. Read at runner-construction time instead.
   */
  getLocalNodeId?: () => string | undefined;
  semaphore?: AgentSemaphore;
  /** Worktree pool for recycling idle worktrees across tasks. */
  pool?: WorktreePool;
  /**
   * FNXC:ProviderRateLimitIsolation 2026-07-21-18:00:
   * Parks only tasks routed through the provider whose API limit was detected.
   */
  usageLimitPauser?: UsageLimitPauser;
  /** Runtime-owned credential rotation inventory/cooldown coordinator. */
  credentialRotator?: CredentialInstanceRotator;
  /** Stuck task detector — monitors agent sessions for stagnation and triggers recovery. */
  stuckTaskDetector?: StuckTaskDetector;
  /** AgentStore for tracking spawned child agents. If not provided, spawning is disabled. */
  agentStore?: import("@fusion/core").AgentStore;
  /** Reflection service used to generate self-reflection insights for agents. */
  reflectionService?: AgentReflectionService;
  /** Plugin runner for invoking plugin hooks and providing plugin tools. */
  pluginRunner?: PluginRunner;
  /** MessageStore for sending messages to other agents. When provided, executor agents gain fn_send_message capability. */
  messageStore?: import("@fusion/core").MessageStore;
  missionStore?: MissionStore | AsyncMissionStore;
  secretsStore?: Pick<import("@fusion/core").SecretsStore, "listEnvExportable">;
  onSliceComplete?: (slice: Slice) => void;
  onStart?: (task: Task, worktreePath: string) => void;
  onComplete?: (task: Task) => void;
  onError?: (task: Task, error: Error) => void;
  /** Testable, best-effort completion-deliverable seam; production uses generateFeatureVideo. */
  reviewArtifactGenerator?: (options: GenerateFeatureVideoOptions) => Promise<import("../review-artifacts/feature-video.js").FeatureVideoResult>;
  onAgentText?: (taskId: string, delta: string) => void;
  /**
   * FNXC:StuckDetector 2026-07-22-19:25:
   * Optional third arg is the primary-arg summary from AgentLogger so downstream
   * telemetry (and any external onAgentTool subscribers) keep the same fingerprint contract
   * the stuck detector uses — do not drop `detail` at the executor boundary.
   */
  onAgentTool?: (taskId: string, toolName: string, detail?: string) => void;
  /*
  FNXC:PlannerOversight 2026-07-13-23:05:
  Session-advisor live delta path — AgentLogger invokes this after durable
  log flushes. Fail-soft; must not throw.
  */
  onExecutorLogFlushed?: (
    taskId: string,
    entries: Array<{ type?: string; text?: string; detail?: string; agent?: string }>,
  ) => void;
  autoRecoveryDispatcher?: AutoRecoveryDispatcher;
  /** PR-entity node deps (U3): assembled `PrNodeDeps` (store + injected GitHub
   *  callbacks) for the `pr-create`/`pr-respond`/`pr-merge` workflow nodes. The
   *  runtime binds the store and threads the CLI-injected ops. Absent → the pr-*
   *  node kinds fail closed. */
  prNodes?: import("../merge/pr-nodes.js").PrNodeDeps;
  /**
   * CLI Agent Executor runtime (U7). When present, workflow nodes with
   * `config.executor === "cli-agent"` drive an engine-owned CLI session via the
   * task-session orchestration. Absent → cli-agent nodes report a clear config
   * error (the runtime was not wired). Bundled so a single option threads the
   * PTY manager + telemetry hub + adapter registry + hook endpoint together.
   */
  cliAgentRuntime?: CliAgentRuntime;
}

/** Bundled CLI Agent Executor runtime dependencies (U7). */
export interface CliAgentRuntime {
  /** Engine-owned PTY session manager (U2). */
  manager: CliSessionManager;
  /** In-process telemetry hub (U3) — owns per-session tokens + state machines. */
  hub: TelemetryHub;
  /** Adapter registry (U2) — resolves adapter id → adapter. */
  registry: CliAdapterRegistry;
  /** Durable session store (U1) — for re-entry / follow-up session lookups. */
  store: CliSessionStore;
  /** Project this runtime drives (the executor is per-project; `cli_sessions` needs it). */
  projectId: string;
  /**
   * Absolute URL of the dashboard hook ingestion endpoint the hook scripts POST
   * to (e.g. `http://127.0.0.1:4040/api/cli-agent/hooks`).
   */
  hookEndpointUrl: string;
  /** Optional override for the hook scratch-dir root (tests). */
  hookDirRoot?: string;
}

export interface ActiveExecutorSessionState {
  session: AgentSession;
  seenSteeringIds: Set<string>;
  lastResolvedModelProvider?: string;
  lastResolvedModelId?: string;
  lastTaskModelProvider?: string | null;
  lastTaskModelId?: string | null;
  lastAssignedAgentId?: string | null;
  lastEffectiveColumnAgentId?: string | null;
}

/*
FNXC:WorkflowExecution 2026-07-19-01:30:
U5d (R9): explicit replacement for the deleted `graphCompletionInterceptors` Map. When this
callback is present the run IS a graph-owned implementation phase: execution stops at the
implementation-complete boundary (no workflow steps, no legacy in-review handoff),
`fn_review_step` is not injected, review gates are marked graph-owned, and the captured
modifiedFiles are handed back through the callback. Absent callback == the legacy path.

FNXC:WorkflowExecution 2026-07-19-02:10:
U5e (R9): this is now a parameter of `runImplementation()`, NOT of `execute()`. The graph
calls the runner directly, so the callback no longer travels through routing.

FNXC:CodeOrganization 2026-08-04-02:35:
Remaining U5e work: the callback should become MANDATORY and collapse into an ordinary
return value. It is still optional only because `executeWorkflowGraph` keeps one
legacy fallback (executor.ts, the workflow-selection-api-unavailable branch) that minimal
TEST stores reach; production stores always expose a workflow-selection reader and are
always graph-owned. Deleting that fallback makes every `runImplementation` call
graph-owned, at which point this type disappears in favor of a returned outcome. See
docs/plans/2026-07-19-002-u5e-remaining-deletions-handoff.md.
*/
export type GraphCompletionCallback = (info: { modifiedFiles: string[] }) => void;
