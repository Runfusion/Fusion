import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createTaskStoreForBackend, resolveEffectiveConcurrency, type Task, type CentralCore, type RegisteredProject, type IsolationMode } from "@fusion/core";
import { ProjectManager } from "../project/project-manager.js";
import { NodeHealthMonitor } from "../project/node-health-monitor.js";
import type {
  ProjectRuntime,
  ProjectRuntimeConfig,
  RuntimeStatus,
  GlobalMetrics,
} from "../project/project-runtime.js";

import { hybridExecutorLog } from "../logger.js";

/**
 * How long {@link HybridExecutor.shutdown} waits for project runtime loading to land before it
 * stops what exists and aborts the rest. Five seconds covers a warm per-project settings read and
 * stays far below the window an operator perceives as a stuck shutdown.
 */
export const DEFAULT_SHUTDOWN_INIT_WAIT_TIMEOUT_MS = 5_000;

/**
 * How long a single project's startup capacity probe may take before {@link HybridExecutor} falls
 * back to the registry concurrency snapshot. The probe exists only to pick up live per-project
 * settings; it must never decide how long boot takes.
 */
export const DEFAULT_STARTUP_CAPACITY_PROBE_TIMEOUT_MS = 2_500;

type Settled<A, B> = { status: "value"; value: A } | { status: "timeout"; reason: B } | { status: "rejected"; error: unknown };

/**
 * Settle `promise` within `timeoutMs`, reporting which of the three outcomes happened instead of
 * collapsing them into a rejection. The caller keeps ownership of `promise`, so a late resolution
 * still runs whatever cleanup the caller attached to it — racing it away must never strand a
 * resource (e.g. a task store that finished booting after the probe gave up).
 *
 * A non-finite or non-positive bound disables the deadline and waits for the promise.
 */
async function settleWithin<A>(promise: Promise<A>, timeoutMs: number): Promise<Settled<A, "timeout">> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    try {
      return { status: "value", value: await promise };
    } catch (error) {
      return { status: "rejected", error };
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ status: "value", value }) as Settled<A, "timeout">,
        (error: unknown) => ({ status: "rejected", error }) as Settled<A, "timeout">,
      ),
      new Promise<Settled<A, "timeout">>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timeout", reason: "timeout" }), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * How long a caller may wait for {@link HybridExecutor.whenReady} before it has to answer honestly
 * instead of holding an HTTP request open. Same order as the shutdown bound: long enough to cover a
 * warm per-project settings read, short enough that a slow or wedged boot surfaces as a specific
 * retryable answer rather than as a hung request.
 */
export const DEFAULT_HYBRID_EXECUTOR_READY_WAIT_MS = 5_000;

/** Outcome of a bounded {@link resolveHybridExecutorReadiness} wait. */
export type HybridExecutorReadiness =
  /** Project runtimes are loaded; executor operations against project state are meaningful. */
  | "ready"
  /** Boot is still walking projects when the bound expired. Waiting longer may still succeed. */
  | "starting"
  /** Boot never started or its last attempt rejected. Waiting will not help. */
  | "failed";

/**
 * Wait at most `timeoutMs` for {@link HybridExecutor.whenReady} and classify what happened.
 *
 * Exists so the one route that genuinely needs project-runtime readiness can depend on it without
 * either holding an HTTP request open for an unbounded boot or pretending an unloaded executor is
 * usable. The outcomes stay distinguishable on purpose: `starting` is retryable, `failed` is not.
 */
export async function resolveHybridExecutorReadiness(
  executor: Pick<HybridExecutor, "whenReady">,
  timeoutMs: number = DEFAULT_HYBRID_EXECUTOR_READY_WAIT_MS,
): Promise<HybridExecutorReadiness> {
  /*
  FNXC:HybridExecutorBoot 2026-09-26-03:10:
  A caller asking for a zero, negative or NaN bound means "answer me now", so the bound is floored at
  1ms rather than falling through to `settleWithin`'s "non-positive disables the deadline" contract —
  that reading is right for an internal drain and wrong for an HTTP handler, where a mis-set knob must
  not turn a 503 into a hung request. `Infinity` keeps its literal meaning: wait as long as it takes.
  */
  const bound = timeoutMs > 0 ? timeoutMs : 1;
  const settled = await settleWithin(executor.whenReady(), bound);
  if (settled.status === "value") return "ready";
  return settled.status === "timeout" ? "starting" : "failed";
}

/**
 * Events emitted by HybridExecutor.
 */
export interface HybridExecutorEvents {
  /** Emitted when a task is created in any project */
  "task:created": [data: { projectId: string; projectName: string; task: Task }];
  /** Emitted when a task is moved in any project */
  "task:moved": [
    data: {
      projectId: string;
      projectName: string;
      task: Task;
      from: string;
      to: string;
    }
  ];
  /** Emitted when a task is updated in any project */
  "task:updated": [data: { projectId: string; projectName: string; task: Task }];
  /** Emitted when a task execution completes */
  "task:completed": [data: { projectId: string; taskId: string; success: boolean }];
  /** Emitted when a task execution fails */
  "task:failed": [data: { projectId: string; taskId: string; error: string }];
  /** Emitted when an error occurs in any project */
  "error": [data: { projectId: string; projectName: string; error: Error }];
  /** Emitted when project health status changes */
  "health:changed": [
    data: {
      projectId: string;
      projectName: string;
      status: RuntimeStatus;
      previous: RuntimeStatus;
    }
  ];
  /** Emitted when a project runtime is added */
  "project:added": [data: { projectId: string; projectName: string }];
  /** Emitted when a project runtime is removed */
  "project:removed": [data: { projectId: string; projectName: string }];
  /** Emitted when a project runtime is restarted */
  "project:runtime-restarted": [data: { projectId: string; projectName: string; isolationMode: IsolationMode; reason?: string }];
}

/**
 * Options for creating a HybridExecutor.
 */
export interface HybridExecutorOptions {
  /** Called when a task is scheduled */
  onTaskScheduled?: (projectId: string, task: Task) => void;
  /** Called when a task is blocked by dependencies */
  onTaskBlocked?: (projectId: string, task: Task, blockedBy: string[]) => void;
  /** Called when a task completes */
  onTaskCompleted?: (projectId: string, taskId: string, success: boolean) => void;
  /** Called when a task fails */
  onTaskFailed?: (projectId: string, taskId: string, error: Error) => void;
  /*
  FNXC:HybridExecutorBoot 2026-09-26-02:26:
  RUFU-322: shutdown used to return immediately while a boot was still mid-flight, which left the
  CLI teardown paths (`await hybridExecutor.shutdown().catch(warn)`) with no bound on what they were
  waiting for and no record of the runtimes that were still being constructed. This is the bound for
  that drain; see shutdown().
  */
  /** Upper bound on waiting for in-flight project runtime loading during shutdown. Default 5000ms. */
  shutdownInitWaitTimeoutMs?: number;
  /** Upper bound on one project's startup capacity probe before the registry snapshot is used. Default 2500ms. */
  startupCapacityProbeTimeoutMs?: number;
}

/**
 * HybridExecutor — Multi-project task execution orchestrator.
 *
 * Manages the lifecycle of project runtimes (both in-process and child-process),
 * coordinates task execution across all registered projects, and enforces
 * global concurrency limits from CentralCore.
 *
 * This is the main entry point for multi-project task execution in fn. It sits
 * between CentralCore (project registry) and the individual ProjectRuntimes,
 * routing tasks to the appropriate runtime based on project configuration.
 *
 * ## Architecture
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 * │                     HybridExecutor                          │
 * │  ┌─────────────────────────────────────────────────────┐   │
 * │  │              ProjectManager (internal)                │   │
 * │  │  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │   │
 * │  │  │   Project A  │  │   Project B  │  │  Project C  │ │   │
 * │  │  │ (in-process) │  │(child-process│  │(in-process) │ │   │
 * │  │  └──────────────┘  └──────────────┘  └─────────────┘ │   │
 * │  └─────────────────────────────────────────────────────┘   │
 * └─────────────────────────────────────────────────────────────┘
 *                              │
 *                    ┌─────────┴──────────┐
 *                    ▼                    ▼
 *              ┌──────────┐        ┌──────────┐
 *              │CentralCore│        │ Scheduler │
 *              │ (registry)│        │ (per proj)│
 *              └──────────┘        └──────────┘
 * ```
 *
 * ## Example
 *
 * ```typescript
 * const central = new CentralCore();
 * await central.init();
 *
 * const executor = new HybridExecutor(central);
 * await executor.initialize();
 *
 * // Add a project (must be registered in CentralCore first)
 * const project = await central.registerProject({
 *   name: "My Project",
 *   path: "/path/to/project"
 * });
 *
 * await executor.addProject({
 *   projectId: project.id,
 *   workingDirectory: await central.resolveLocalProjectWorkingDirectory(project.id),
 *   isolationMode: "in-process",
 *   maxConcurrent: 2,
 *   maxWorktrees: 4,
 * });
 *
 * // Listen for events
 * executor.on("task:completed", ({ projectId, taskId }) => {
 *   console.log(`Task ${taskId} completed in ${projectId}`);
 * });
 *
 * // Graceful shutdown
 * await executor.shutdown();
 * ```
 *
 * @see ProjectManager - The underlying project orchestration class
 * @see ProjectRuntime - The runtime interface for individual projects
 */
export class HybridExecutor extends EventEmitter<HybridExecutorEvents> {
  private projectManager: ProjectManager;
  private nodeHealthMonitor: NodeHealthMonitor | null = null;
  private initialized = false;
  /*
  FNXC:HybridExecutorBoot 2026-09-26-02:26:
  RUFU-322 boot-lifecycle state. `initPromise` is the single in-flight boot shared by every
  initialize() caller (a second caller must never start a second walk over the project registry), and
  it is cleared when the boot settles so a failure is never cached as the executor's permanent state.
  `loadingProjectIds` names the projects whose runtime construction is still running, which is what
  shutdown reports when it stops waiting. `shuttingDown` tells an in-flight boot to stop building and
  to tear down any runtime that lands after shutdown already drained its bound.
  */
  private initPromise: Promise<void> | null = null;
  private loadingProjectIds = new Set<string>();
  private shuttingDown = false;

  /**
   * @param centralCore - CentralCore reference for global coordination
   * @param options - Optional configuration callbacks
   */
  constructor(
    private centralCore: CentralCore,
    private options: HybridExecutorOptions = {}
  ) {
    super();
    this.setMaxListeners(100);

    // Create internal ProjectManager
    this.projectManager = new ProjectManager(centralCore);

    // Set up event forwarding from ProjectManager
    this.setupEventForwarding();

    hybridExecutorLog.log("HybridExecutor created");
  }

  /**
   * Initialize the HybridExecutor and load existing projects.
   *
   * Loads all registered projects from CentralCore and creates appropriate
   * runtimes based on their isolation mode configuration.
   *
   * Concurrent callers share one boot: the walk over the project registry happens once, and every
   * caller awaits the same promise. A boot that fails is not cached — the in-flight promise is
   * cleared when it settles, so a later call retries.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      hybridExecutorLog.warn("HybridExecutor already initialized");
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    // A fresh boot is an intentional restart after a completed teardown, so it clears the previous
    // shutdown's abort flags. A boot that is still in flight returns above and never touches them.
    this.shuttingDown = false;
    this.loadingProjectIds.clear();

    const boot = this.bootProjectRuntimes();
    // Assigned synchronously, before the first await, so initialize(), whenReady(), and shutdown()
    // cannot observe a half-started boot or race a second one.
    this.initPromise = boot;
    try {
      await boot;
    } finally {
      if (this.initPromise === boot) this.initPromise = null;
    }
  }

  /*
  FNXC:HybridExecutorBoot 2026-09-26-02:26:
  RUFU-322: boot now backgrounds initialize() so the migration holding server releases and the real
  server binds while project runtimes are still loading. That leaves one question a caller can ask —
  is the executor ready to act on project state yet? `whenReady()` is that answer: the same promise
  initialize() awaits, so a route or command that needs loaded runtimes (the isolation-transition
  route today) can gate on readiness without putting a project-boot cost back in front of the port.
  A never-started or failed boot rejects rather than pretending readiness, because the caller's
  alternative is acting on a registry the executor has not built runtimes for. It holds no HTTP or
  listening logic: readiness is state, the transport stays in the caller.
  */
  /**
   * Resolve once project runtime loading has completed, reject if it has not run or last failed.
   *
   * Safe to call from multiple places: it hands out the in-flight boot promise rather than starting
   * new work.
   */
  whenReady(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    return Promise.reject(
      new Error("HybridExecutor is not ready: project runtime loading has not completed"),
    );
  }

  /**
   * The one walk over the registered projects: build a runtime per active project, then wire
   * CentralCore events and start node health monitoring.
   */
  private async bootProjectRuntimes(): Promise<void> {
    hybridExecutorLog.log("Initializing HybridExecutor...");
    /*
    FNXC:HybridExecutorBoot 2026-09-26-02:26:
    RUFU-322: boot progress was previously only inferable from one "Loaded project runtime for X" line
    per project and the absence of any completion record, so an operator staring at a 15-minute 503
    could not tell "still loading" from "wedged". These counters feed the greppable completion marker
    at the end of the walk, which is the record of full startup (and of how many projects were skipped).
    */
    const bootStartedAt = Date.now();
    let loadedCount = 0;
    let failedCount = 0;

    // Load all registered projects from CentralCore
    const projects = await this.centralCore.listProjects();

    // Start runtimes for all active projects
    for (const project of projects) {
      if (this.shuttingDown) break;
      if (project.status === "active" || project.status === "initializing") {
        this.loadingProjectIds.add(project.id);
        try {
          const workingDirectory = await this.centralCore.resolveLocalProjectWorkingDirectory(
            project.id,
          );

          const capacity = await this.resolveStartupConcurrency(project, workingDirectory);
          await this.addProject({
            projectId: project.id,
            workingDirectory,
            isolationMode: project.isolationMode,
            maxConcurrent: capacity.maxConcurrent,
            maxWorktrees: capacity.worktreeLimit ?? capacity.maxConcurrent,
            settings: project.settings,
          });

          if (this.shuttingDown) {
            /*
            FNXC:HybridExecutorBoot 2026-09-26-02:26:
            RUFU-322: shutdown() stops every runtime that exists, but a runtime that finished
            constructing after shutdown already drained its bound would otherwise be created into a
            torn-down executor. Stop it here — nothing may survive shutdown just because it loaded
            late.
            */
            hybridExecutorLog.warn(
              `Shutdown in progress: stopping project runtime ${project.id} that finished loading late`,
            );
            await this.removeProject(project.id).catch((error: unknown) => {
              hybridExecutorLog.error(
                `Failed to stop late-loaded project runtime ${project.id}:`,
                error instanceof Error ? error.message : String(error),
              );
            });
            break;
          }

          loadedCount++;
          hybridExecutorLog.log(`Loaded project runtime for ${project.name}`);
        } catch (error) {
          failedCount++;
          hybridExecutorLog.error(
            `Failed to load project ${project.id}:`,
            error instanceof Error ? error.message : String(error)
          );
        } finally {
          this.loadingProjectIds.delete(project.id);
        }
      }
    }

    if (this.shuttingDown) {
      hybridExecutorLog.warn("Project runtime loading aborted by shutdown; HybridExecutor stays uninitialized");
      return;
    }

    // Listen for CentralCore project events
    this.setupCentralCoreListeners();

    // Start remote node health monitoring after project runtimes are loaded.
    this.nodeHealthMonitor = new NodeHealthMonitor(this.centralCore);
    await this.nodeHealthMonitor.start();

    this.initialized = true;
    if (failedCount > 0) {
      hybridExecutorLog.warn(
        `Project runtime loading finished with ${failedCount} project(s) failing to load`,
      );
    }
    hybridExecutorLog.log(
      `HybridExecutor initialized: ${loadedCount} project runtimes in ${Date.now() - bootStartedAt}ms`,
    );
  }

  /**
   * Add a project runtime and start it.
   *
   * @param config - Runtime configuration (must match a registered project)
   * @returns The created and started ProjectRuntime
   * @throws Error if project not found in CentralCore or runtime already exists
   */
  async addProject(config: ProjectRuntimeConfig): Promise<ProjectRuntime> {
    const runtime = await this.projectManager.addProject(config);

    const project = await this.centralCore.getProject(config.projectId);
    this.emit("project:added", {
      projectId: config.projectId,
      projectName: project?.name ?? config.projectId,
    });

    return runtime;
  }

  /*
  FNXC:CapacityModel 2026-08-21-15:45:
  FN-9185 requires hybrid runtime startup to read the target project's live settings blob.
  A registry snapshot is a fallback only when the project root cannot open its scoped TaskStore.

  FNXC:HybridExecutorBoot 2026-09-26-02:26:
  RUFU-322: that live read is a full scoped backend boot (`createTaskStoreForBackend` resolves DB
  startup options, constructs the store, then shuts it down), and this call sat unbounded inside a
  serial per-project loop in front of the operator's port release. The probe is now bounded by
  `startupCapacityProbeTimeoutMs` and its outcome is reported as `source`, so a fallback is a logged
  decision instead of an invisible 24-fold serial stall. The probe promise keeps its own store
  teardown: if it lands after the deadline the store is still closed by that chain, never leaked.
  */
  private async resolveStartupConcurrency(
    project: RegisteredProject,
    workingDirectory: string,
  ): Promise<{ maxConcurrent: number; worktreeLimit: number | null; source: "project-settings" | "registry-snapshot" }> {
    if (!existsSync(workingDirectory)) return { ...resolveEffectiveConcurrency(project.settings), source: "registry-snapshot" };

    const timeoutMs = this.options.startupCapacityProbeTimeoutMs ?? DEFAULT_STARTUP_CAPACITY_PROBE_TIMEOUT_MS;
    const probe = (async () => {
      const boot = await createTaskStoreForBackend({ rootDir: workingDirectory, projectId: project.id });
      try {
        return resolveEffectiveConcurrency(await boot.taskStore.getSettingsFast());
      } finally {
        await boot.shutdown();
      }
    })();
    // The probe keeps running (and closing its own store) after a timeout; swallow a late
    // rejection so it cannot surface as an unhandled rejection in the host process.
    probe.catch(() => {});

    const settled = await settleWithin(probe, timeoutMs);
    if (settled.status === "value") return { ...settled.value, source: "project-settings" };

    const reason =
      settled.status === "timeout"
        ? `capacity probe exceeded ${timeoutMs}ms`
        : settled.error instanceof Error
          ? settled.error.message
          : String(settled.error);
    hybridExecutorLog.warn(
      `Startup capacity for ${project.id} fell back to the registry concurrency snapshot (${reason})`,
    );
    return { ...resolveEffectiveConcurrency(project.settings), source: "registry-snapshot" };
  }

  /**
   * Remove a project runtime and stop it.
   *
   * @param projectId - Project ID to remove
   * @throws Error if runtime not found
   */
  async removeProject(projectId: string): Promise<void> {
    const project = await this.centralCore.getProject(projectId);

    await this.projectManager.removeProject(projectId);

    this.emit("project:removed", {
      projectId,
      projectName: project?.name ?? projectId,
    });
  }

  /**
   * Update a project's runtime configuration.
   *
   * If the isolation mode changes, the old runtime will be stopped and a new
   * one started with the new configuration.
   *
   * @param projectId - Project ID to update
   * @param config - New runtime configuration
   */
  async updateProject(
    projectId: string,
    config: Partial<ProjectRuntimeConfig>
  ): Promise<ProjectRuntime> {
    const existingRuntime = this.projectManager.getRuntime(projectId);
    if (!existingRuntime) {
      throw new Error(`Runtime not found for project ${projectId}`);
    }

    const _currentStatus = existingRuntime.getStatus();
    const currentMode =
      existingRuntime instanceof
      (await import("../runtimes/child-process-runtime.js")).ChildProcessRuntime
        ? "child-process"
        : "in-process";

    // If isolation mode changed, need to recreate the runtime
    if (config.isolationMode && config.isolationMode !== currentMode) {
      hybridExecutorLog.log(
        `Isolation mode changed for ${projectId}: ${currentMode} → ${config.isolationMode}`
      );

      const project = await this.centralCore.getProject(projectId);
      if (!project) {
        throw new Error(`Project not found in CentralCore: ${projectId}`);
      }

      const workingDirectory =
        config.workingDirectory ??
        (await this.centralCore.resolveLocalProjectWorkingDirectory(projectId));

      // Stop old runtime
      await this.projectManager.removeProject(projectId);

      // Get the full current config
      const capacity = await this.resolveStartupConcurrency({
        ...project,
        settings: config.settings ?? project.settings,
      }, workingDirectory);
      const fullConfig: ProjectRuntimeConfig = {
        projectId,
        workingDirectory,
        isolationMode: config.isolationMode,
        maxConcurrent: capacity.maxConcurrent,
        maxWorktrees: capacity.worktreeLimit ?? capacity.maxConcurrent,
        settings: config.settings,
      };

      // Start new runtime with new mode
      return await this.addProject(fullConfig);
    }

    // For other config changes, just return the existing runtime
    // (specific config updates can be added here as needed)
    return existingRuntime;
  }


  /**
   * Transition project isolation mode and restart runtime to apply changes.
   *
   * Non-force transitions that fail runtime restart due to active tasks roll back
   * the persisted isolationMode change to its previous value before returning.
   *
   * FNXC:IsolationTransitionBlockers 2026-10-15-06:05 (RUFU-328):
   * A bare `activeTaskCount` was the whole refusal, so an operator staring at `409 active_tasks` could not
   * tell whether work was running or bookkeeping had leaked — the reported saneca case refused for hours
   * over two cards whose rows already read `failed`, and the request named no card. The guard can now name
   * the cards it actually waits for, and this method is the only route that carries that name to the HTTP
   * layer, so the ids travel here as an OPTIONAL key: present when the durable read answered, omitted
   * entirely when it did not. Omitting rather than sending `[]` is load-bearing — an empty array would
   * read as "the read proved nothing blocks, yet we still refused", which is a contradiction, while an
   * absent key honestly means "nothing could be named". The count stays authoritative in both shapes.
   */
  async transitionProjectIsolation(
    projectId: string,
    nextMode: IsolationMode,
    opts?: { force?: boolean },
  ): Promise<
    | { ok: true }
    | { ok: false; reason: string; activeTaskCount?: number; blockingTaskIds?: string[] }
  > {
    const current = await this.centralCore.getProject(projectId);
    if (!current) {
      return { ok: false, reason: "project_not_found" };
    }

    const transition = await this.centralCore.transitionProjectIsolation(projectId, nextMode, opts);
    if (!transition.ok) {
      return transition;
    }

    try {
      await this.projectManager.restartProjectRuntime(projectId, {
        reason: `isolation-transition:${current.isolationMode}->${nextMode}`,
        force: opts?.force,
      });
      return { ok: true };
    } catch (error) {
      if (!opts?.force && error && typeof error === "object" && (error as { kind?: unknown }).kind === "active_tasks") {
        await this.centralCore.updateProject(projectId, { isolationMode: current.isolationMode });
        const named = (error as { taskIds?: unknown }).taskIds;
        const blockingTaskIds = Array.isArray(named)
          ? named.filter((id): id is string => typeof id === "string" && id.length > 0)
          : undefined;
        return {
          ok: false,
          reason: "active_tasks",
          activeTaskCount: Number((error as { count?: unknown }).count) || 0,
          ...(blockingTaskIds && blockingTaskIds.length > 0 ? { blockingTaskIds } : {}),
        };
      }
      throw error;
    }
  }

  /**
   * Get a runtime by project ID.
   */
  getRuntime(projectId: string): ProjectRuntime | undefined {
    return this.projectManager.getRuntime(projectId);
  }

  /**
   * List all managed runtimes.
   */
  listRuntimes(): ProjectRuntime[] {
    return this.projectManager.listRuntimes();
  }

  /**
   * Get all project IDs.
   */
  getProjectIds(): string[] {
    return this.projectManager.getProjectIds();
  }

  /**
   * Get global metrics aggregated across all runtimes.
   */
  async getGlobalMetrics(): Promise<GlobalMetrics> {
    return this.projectManager.getGlobalMetrics();
  }

  /**
   * Get the optional node health monitor instance.
   */
  getNodeHealthMonitor(): NodeHealthMonitor | null {
    return this.nodeHealthMonitor;
  }

  /**
   * Acquire a global concurrency slot.
   *
   * @param projectId - Project requesting the slot
   * @returns true if slot acquired, false if at limit
   */

  /**
   * Release a global concurrency slot.
   *
   * @param projectId - Project releasing the slot
   */

  /**
   * Graceful shutdown of all runtimes.
   *
   * Stops accepting new tasks, waits for active tasks to complete (with timeout),
   * and shuts down all runtimes in parallel.
   */
  async shutdown(): Promise<void> {
    /*
    FNXC:HybridExecutorBoot 2026-09-26-02:26:
    RUFU-322 shutdown drain. The old early return meant a teardown that arrived while boot was still
    walking the project registry stopped nothing at all and reported success: the half-built runtimes
    were left running behind a process that believed it had shut down. Now shutdown waits for the
    in-flight boot up to `shutdownInitWaitTimeoutMs` (default 5s), names the projects still loading
    when that bound is hit, then tears down the health monitor and every runtime that exists — and
    still refuses to report success while a boot is in flight, so a caller can never mistake a
    partial teardown for a clean one.
    */
    const waitMs = this.options.shutdownInitWaitTimeoutMs ?? DEFAULT_SHUTDOWN_INIT_WAIT_TIMEOUT_MS;
    const inFlightBoot = this.initPromise;
    let bootStillInFlight = false;
    if (inFlightBoot) {
      hybridExecutorLog.log(
        `Shutting down with project runtime loading in flight; waiting up to ${waitMs}ms...`,
      );
      const settled = await settleWithin(inFlightBoot, waitMs);
      if (settled.status === "timeout") {
        bootStillInFlight = true;
        hybridExecutorLog.warn(
          `Project runtime loading still in flight after ${waitMs}ms for: ${
            [...this.loadingProjectIds].join(", ") || "unknown project"
          }; stopping the runtimes that exist and aborting the rest`,
        );
      }
    }
    // Set before teardown so an aborted boot stops building and stops anything that lands late.
    this.shuttingDown = true;

    const hasRuntimes = this.projectManager.getProjectIds().length > 0;
    // Silent no-op only when nothing was ever started AND no boot is outstanding: while a boot is in
    // flight, "no runtimes yet" proves nothing, so teardown must still run and the abort flag stands.
    if (!this.initialized && !hasRuntimes && !bootStillInFlight) {
      return;
    }

    hybridExecutorLog.log("Shutting down HybridExecutor...");

    // Stop listening to CentralCore events
    this.centralCore.removeAllListeners("project:registered");
    this.centralCore.removeAllListeners("project:unregistered");
    this.centralCore.removeAllListeners("project:updated");

    // Stop node health monitor before shutting down runtimes.
    if (this.nodeHealthMonitor) {
      await this.nodeHealthMonitor.stop();
      this.nodeHealthMonitor = null;
    }

    // Stop all runtimes
    await this.projectManager.stopAll();

    this.initialized = false;
    hybridExecutorLog.log("HybridExecutor shutdown complete");

    if (bootStillInFlight) {
      // Teardown of everything that existed is done, but this is not a clean shutdown: refuse to
      // report success while a boot is still running so no caller reads a partial stop as a full one.
      throw new Error(
        `HybridExecutor shutdown incomplete: project runtime loading was still in flight after ${waitMs}ms`,
      );
    }
  }

  /**
   * Check if the HybridExecutor is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Set up event forwarding from ProjectManager to HybridExecutor listeners.
   */
  private setupEventForwarding(): void {
    // Forward task:created
    this.projectManager.on("task:created", (data) => {
      this.emit("task:created", data);
    });

    // Forward task:moved
    this.projectManager.on("task:moved", (data) => {
      this.emit("task:moved", data);
    });

    // Forward task:updated
    this.projectManager.on("task:updated", (data) => {
      this.emit("task:updated", data);
    });

    // Forward errors
    this.projectManager.on("error", (data) => {
      this.emit("error", data);
    });

    // Forward health changes
    this.projectManager.on("health:changed", (data) => {
      this.emit("health:changed", data);
    });

    // Forward runtime added/removed as project added/removed
    this.projectManager.on("runtime:added", (data) => {
      this.emit("project:added", data);
    });

    this.projectManager.on("runtime:removed", (data) => {
      this.emit("project:removed", data);
    });

    this.projectManager.on("project:runtime-restarted", (data) => {
      this.emit("project:runtime-restarted", data);
    });
  }

  /**
   * Set up listeners for CentralCore project events.
   *
   * Async guard convention: any async operation triggered from these listeners
   * must end with an explicit `.catch(...)` handler (for example, project
   * removal calls `removeProject(...).catch(...)`) so EventEmitter dispatch
   * cannot surface unhandled promise rejections.
   */
  private setupCentralCoreListeners(): void {
    // When a new project is registered, we don't auto-add it
    // The user must explicitly call addProject()
    this.centralCore.on("project:registered", (project: RegisteredProject) => {
      hybridExecutorLog.log(`New project registered: ${project.name} (${project.id})`);
    });

    // When a project is unregistered, remove its runtime
    this.centralCore.on("project:unregistered", (projectId: string) => {
      hybridExecutorLog.log(`Project unregistered: ${projectId}`);
      const runtime = this.projectManager.getRuntime(projectId);
      if (runtime) {
        this.removeProject(projectId).catch((error: unknown) => {
          hybridExecutorLog.error(
            `Failed to remove runtime for ${projectId}:`,
            error instanceof Error ? error.message : String(error)
          );
        });
      }
    });

    // When a project is updated, check if we need to update the runtime
    this.centralCore.on("project:updated", (project: RegisteredProject) => {
      hybridExecutorLog.log(`Project updated: ${project.name} (${project.id})`);
      // Could trigger runtime reconfiguration here if needed
    });
  }
}
