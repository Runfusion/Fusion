import type { EventEmitter } from "node:events";
import type { TaskStore, Task, IsolationMode, ProjectSettings, GithubIssueAction, MigrationProgressEvent } from "@fusion/core";
import type { Scheduler } from "../scheduler.js";
import type { IsolationBlockerAnswer } from "./isolation-transition-blockers.js";

/**
 * Options accepted by {@link ProjectRuntime.stop}.
 *
 * FNXC:IsolationTransitionBlockers 2026-10-15-00:02 (RUFU-328):
 * A transition that proved its cards were settled spent part of its wall-clock bound proving it, and
 * that time is still owed by the shutdown that follows. `drainMs` carries the already-paid-for budget
 * so one attempt cannot bill the drain in full a second time. Absent means "derive your own", which is
 * every historical caller (startup shutdown, `stopAll`, engine stop) — their behaviour is unchanged.
 */
export interface RuntimeStopOptions {
  /**
   * Post-abort drain budget in milliseconds, already charged for the time a preceding guard consumed.
   * A number here is authoritative — including `0`, which means the runtime declared no drain at all.
   */
  drainMs?: number;
}

/**
 * Runtime status for a ProjectRuntime instance.
 * Represents the lifecycle states of a project runtime.
 */
export type RuntimeStatus =
  | "active"     // Runtime is running and processing tasks
  | "paused"     // Runtime is temporarily suspended
  | "errored"    // Runtime encountered a fatal error
  | "stopped"    // Runtime is stopped (graceful shutdown complete)
  | "starting"   // Runtime is in the process of starting
  | "stopping";  // Runtime is in the process of stopping

/**
 * Metrics for a ProjectRuntime instance.
 * Used for monitoring and health tracking.
 */
export interface RuntimeMetrics {
  /**
   * Worktree-holding tasks that are live on an execution surface — not the size of the executor's
   * worktree-ownership registry. A card whose run ended can still own a checkout while it waits in a
   * lane for its operator, and counting that as in-flight work would refuse an isolation transition
   * (`{ kind: "active_tasks" }`) for a project that is executing nothing.
   *
   * FNXC:WorktreeLiveness 2026-10-08-04:04 (RUFU-323)
   */
  inFlightTasks: number;
  /** Number of active agents currently running */
  activeAgents: number;
  /** ISO-8601 timestamp of the last activity */
  lastActivityAt: string;
  /** Memory usage in bytes (optional, may not be available in all modes) */
  memoryBytes?: number;
}

/**
 * Configuration for creating a ProjectRuntime instance.
 */
export interface ProjectRuntimeConfig {
  /** Unique project ID (e.g., "proj_abc123") */
  projectId: string;
  /** Absolute path to the project working directory */
  workingDirectory: string;
  /** Execution isolation mode */
  isolationMode: IsolationMode;
  /** Maximum concurrent agents for this project */
  maxConcurrent: number;
  /** Maximum worktrees for this project */
  maxWorktrees: number;
  /** Optional project settings override */
  settings?: ProjectSettings;
  /** Shared global semaphore from ProjectManager. When provided, the runtime
   *  uses this semaphore for concurrency control instead of creating its own.
   *  This ensures cross-project concurrency limits are enforced. */
  globalSemaphore?: import("../concurrency/concurrency.js").AgentSemaphore;
  /**
   * An already-initialized TaskStore to use instead of creating a new one.
   * When provided, the runtime will skip TaskStore construction and init().
   * Useful when the caller (e.g. dashboard.ts) owns and watches the store.
   */
  externalTaskStore?: TaskStore;
  /**
   * FNXC:MigrationHoldingPage 2026-07-19-12:00:
   * A fixed-port daemon binds a temporary holding server before engine startup.
   * Forward factory migration progress through the runtime so that server can
   * report live cutover status until the real dashboard listener takes over.
   */
  onMigrationProgress?: (event: MigrationProgressEvent) => void;
  /**
   * PR-entity node GitHub ops (U3): the injected `createPr`/`mergePr`/`respond`
   * callbacks (+ source resolver + audit) for the `pr-create`/`pr-respond`/
   * `pr-merge` workflow nodes. Threaded from the CLI layer; the runtime binds the
   * engine-owned store and hands the assembled deps to the executor. Absent → the
   * pr-* node kinds fail closed.
   */
  prNodeGithubOps?: import("../merge/pr-nodes.js").PrNodeGithubOps;
  /**
   * Builds PR-node GitHub callbacks after this runtime has selected its own
   * TaskStore. This binds project settings to the executing engine rather than
   * asking process-wide CLI wiring to rediscover task ownership.
   */
  createPrNodeGithubOps?: (store: TaskStore) => import("../merge/pr-nodes.js").PrNodeGithubOps;
  /** Host-owned, read-only mission validation evidence factory bound to this project store. */
  createMissionValidationEvidenceProvider?: (store: TaskStore) => import("../missions/mission-validation-evidence.js").MissionValidationEvidenceProvider;
  /**
   * Absolute URL of the dashboard's CLI-agent hook ingestion endpoint that
   * generated hook scripts POST to (e.g. `http://127.0.0.1:4040/api/cli-agent/hooks`).
   * Threaded from the dashboard boot once the listening port is known. When
   * absent, the runtime derives a localhost URL from `FUSION_DASHBOARD_PORT`
   * (falling back to 4040).
   */
  cliAgentHookEndpointUrl?: string;
}

/**
 * Events emitted by a ProjectRuntime instance.
 */
export interface ProjectRuntimeEvents {
  /** Emitted when a task is created in the project */
  "task:created": [task: Task];
  /** Emitted when a task is moved between columns */
  "task:moved": [data: { task: Task; from: string; to: string }];
  /** Emitted when a task is updated */
  "task:updated": [task: Task];
  /** Emitted when a task is deleted */
  "task:deleted": [task: Task, meta?: { githubIssueAction?: GithubIssueAction; observed?: boolean; outboxEventId?: string }];
  /** Emitted when a cross-node assignment event is observed */
  "task:assigned": [data: { taskId: string; agentId: string; assignedAt: string; source?: string }];
  /** Emitted when an error occurs in the runtime */
  "error": [error: Error];
  /** Emitted when the runtime health status changes */
  "health-changed": [data: { status: RuntimeStatus; previous: RuntimeStatus }];
}

/**
 * ProjectRuntime interface — core abstraction for multi-project support.
 *
 * Each project instance runs as a ProjectRuntime, either in-process (default)
 * or in an isolated child process (opt-in). The ProjectManager orchestrates
 * all runtimes and enforces global concurrency limits from CentralCore.
 *
 * @example
 * ```typescript
 * const runtime = new InProcessRuntime(config, centralCore);
 * await runtime.start();
 *
 * // Access project TaskStore
 * const taskStore = runtime.getTaskStore();
 *
 * // Listen for events
 * runtime.on("task:created", (task) => {
 *   console.log(`Task ${task.id} created`);
 * });
 *
 * // Shutdown gracefully
 * await runtime.stop();
 * ```
 */
export interface ProjectRuntime extends EventEmitter<ProjectRuntimeEvents> {
  /**
   * Start the runtime and initialize all subsystems.
   * This includes initializing the TaskStore, Scheduler, and Executor.
   */
  start(): Promise<void>;

  /**
   * Stop the runtime with graceful shutdown.
   * Waits for active tasks to complete (with timeout), stops the scheduler,
   * and cleans up resources.
   */
  stop(options?: RuntimeStopOptions): Promise<void>;

  /**
   * Get the current runtime status.
   * @returns The current status of the runtime
   */
  getStatus(): RuntimeStatus;

  /**
   * Get the project's TaskStore instance.
   * @returns The TaskStore for this project
   * @throws Error if called on a ChildProcessRuntime (not accessible in child mode)
   */
  getTaskStore(): TaskStore;

  /**
   * Get the project's Scheduler instance.
   * @returns The Scheduler for this project
   * @throws Error if called on a ChildProcessRuntime (not accessible in child mode)
   */
  getScheduler(): Scheduler;

  /**
   * Clear volatile executor pause-abort provenance for a task before a manual retry.
   * Optional because isolated runtimes do not expose in-memory executor state.
   */
  clearTaskPauseAbortState?(taskId: string): void;

  /**
   * Get current runtime metrics.
   * @returns Metrics including in-flight tasks, active agents, and memory usage
   */
  getMetrics(): RuntimeMetrics;

  /*
  FNXC:IsolationTransitionBlockers 2026-10-15-00:02 (RUFU-328):
  Durability parity for the in-flight guard. `getMetrics()` answers from process memory, and process
  memory lags the durable board in both directions, so an operator-facing "is anything running?" that
  consults only it can be answered wrongly for hours. This method is consulted ONLY when the metric
  says busy, and its option bag carries a budget rather than a retry policy — a transport that could
  ask for a longer wait would make the bound a suggestion.

  Optional on purpose: an isolated or remote runtime whose engine cannot reach durable state keeps
  compiling and simply does not answer, which leaves the guard on its historical (conservative) path.
  Every implementation must answer `{ taskIds: null }` rather than throwing or answering `[]`, because
  an empty list is a claim that nothing blocks, and cannot-answer earns no such claim.
  */
  getInFlightBlockers?(options?: { budgetMs?: number }): Promise<IsolationBlockerAnswer>;
}

/**
 * Global metrics aggregated across all project runtimes.
 */
export interface GlobalMetrics {
  /** Total number of in-flight tasks across all runtimes */
  totalInFlightTasks: number;
  /** Total number of active agents across all runtimes */
  totalActiveAgents: number;
  /** Number of runtimes by status */
  runtimeCountByStatus: Record<RuntimeStatus, number>;
  /** Total number of registered runtimes */
  totalRuntimes: number;
}
