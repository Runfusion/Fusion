/**
 * ProjectEngineManager — uniform lifecycle management for all project engines.
 *
 * Every registered project gets an identical ProjectEngine. There is no
 * "primary" or "default" engine — each is created from CentralCore metadata
 * and started through the same code path.
 *
 * The manager is the single owner of all engines. It handles:
 *   - Eager startup of all registered projects via `startAll()`
 *   - Background reconciliation of newly registered projects via `startReconciliation()`
 *   - Lazy startup of newly-accessed projects via `ensureEngine()` and `onProjectAccessed()`
 *   - Deduplication of concurrent start requests for the same project
 *   - Graceful shutdown of all engines via `stopAll()`
 */

import { realpathSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type {
  CentralCore,
  TaskStore,
  RegisteredProject,
  MigrationProgressEvent,
} from "@fusion/core";
import { ProjectEngine } from "./project-engine.js";
import type { ProjectEngineOptions } from "./project-engine.js";
import type { ProjectRuntimeConfig } from "./project-runtime.js";
import { AgentSemaphore } from "./concurrency.js";
import {
  acquireEngineSingleton,
  EngineAlreadyRunningError,
  type EngineSingletonLock,
} from "./engine-singleton-lock.js";
import { runtimeLog } from "./logger.js";

/**
 * Options shared across all engines created by the manager.
 * These are injected by the CLI layer (dashboard.ts / serve.ts).
 */
export interface EngineManagerOptions {
  /**
   * FNXC:StorageMigrationNotice 2026-07-12-00:00:
   * The manager carries the resolved CLI package version to each per-project engine so the one-time Postgres-migration inbox message is evaluated per project while remaining gated to the same released runtime version.
   */
  cliPackageVersion?: ProjectEngineOptions["cliPackageVersion"];
  getMergeStrategy?: ProjectEngineOptions["getMergeStrategy"];
  processPullRequestMerge?: ProjectEngineOptions["processPullRequestMerge"];
  createGroupPr?: ProjectEngineOptions["createGroupPr"];
  syncGroupPr?: ProjectEngineOptions["syncGroupPr"];
  prNodeGithubOps?: ProjectEngineOptions["prNodeGithubOps"];
  prReconcileGithubOps?: ProjectEngineOptions["prReconcileGithubOps"];
  getTaskMergeBlocker?: ProjectEngineOptions["getTaskMergeBlocker"];
  onInsightRunProcessed?: ProjectEngineOptions["onInsightRunProcessed"];
  /**
   * FNXC:SqliteFinalRemoval 2026-06-26-11:20: shared TaskStore from the central
   * backend boot so engines reuse one connection pool (no second embedded PG).
   *
   * FNXC:FasterStartup 2026-07-14-23:55:
   * Inject only for the project whose resolved working directory matches this
   * store's rootDir. Multi-project engines must factory-boot (or receive) their
   * own bound store — a cwd-partitioned TaskStore must never back a different
   * project root. Callers may still pass per-call overrides via ensureEngine.
   */
  externalTaskStore?: ProjectEngineOptions["externalTaskStore"];
  /** Forward first-boot SQLite migration progress to a fixed-port holding server. */
  onMigrationProgress?: (event: MigrationProgressEvent) => void;
}

/** Default interval for background reconciliation (30 seconds). */
export const DEFAULT_RECONCILIATION_INTERVAL_MS = 30_000;

export class ProjectEngineManager {
  private engines = new Map<string, ProjectEngine>();
  private starting = new Map<string, Promise<ProjectEngine>>();
  private singletonLocks = new Map<string, EngineSingletonLock>();
  /**
   * FNXC:DashboardHealth 2026-06-21-03:30:
   * Engine availability must reflect machine-level truth, not only engines this
   * process owns. Projects whose engine is owned by ANOTHER fusion process on
   * this machine are tracked here, populated when `acquireEngineSingleton`
   * rejects with {@link EngineAlreadyRunningError} — that error is positive
   * proof an engine is live for the project, just not owned by us. We keep
   * retrying to start (so we take over if the other process dies), but the
   * dashboard must report the engine as available rather than showing a false
   * "engine not running" banner.
   */
  private externalEngines = new Set<string>();
  private stopped = false;

  /**
   * Shared global semaphore — ONE instance across ALL project engines.
   * Enforces the cross-project globalMaxConcurrent limit. Without this,
   * each engine creates its own semaphore and the global limit is not shared.
   */
  private globalSemaphore: AgentSemaphore;
  private currentGlobalLimit = 4;
  private concurrencyListener?: (...args: unknown[]) => void;

  /** Reconciliation state for background project startup. */
  private reconciliationInterval: ReturnType<typeof setInterval> | null = null;
  private reconciliationStopped = false;

  constructor(
    private centralCore: CentralCore,
    private options: EngineManagerOptions = {},
  ) {
    // Dynamic getter so live changes to globalMaxConcurrent take effect immediately
    this.globalSemaphore = new AgentSemaphore(() => this.currentGlobalLimit);

    // Listen for concurrency changes from CentralCore
    if (typeof centralCore.on === "function") {
      this.concurrencyListener = (state: unknown) => {
        const s = state as { globalMaxConcurrent?: number };
        if (typeof s.globalMaxConcurrent === "number") {
          this.currentGlobalLimit = s.globalMaxConcurrent;
          runtimeLog.log(`Global concurrency limit updated to ${this.currentGlobalLimit}`);
        }
      };
      centralCore.on("concurrency:changed", this.concurrencyListener);
    }

    // Read initial limit from CentralCore (async — updates the mutable limit)
    this.refreshGlobalLimit();
  }

  private async refreshGlobalLimit(): Promise<void> {
    try {
      const state = await this.centralCore.getGlobalConcurrencyState();
      this.currentGlobalLimit = state.globalMaxConcurrent;
    } catch {
      // Keep default of 4
    }
  }

  // ── Public accessors ──

  /** Get a running engine by projectId. Returns undefined if not started. */
  getEngine(projectId: string): ProjectEngine | undefined {
    return this.engines.get(projectId);
  }

  /** Get all running engines. */
  getAllEngines(): ReadonlyMap<string, ProjectEngine> {
    return this.engines;
  }

  /**
   * Whether an engine is running for any project on this machine — including
   * engines owned by another fusion process (detected via the singleton lock).
   * Drives the dashboard's "engine available" health so a UI-only launch
   * alongside an already-running engine does not show a false banner.
   */
  hasRunningEngine(): boolean {
    return this.engines.size > 0 || this.externalEngines.size > 0;
  }

  /** Project ids whose engine is owned by another fusion process on this machine. */
  getExternalEngineIds(): ReadonlySet<string> {
    return this.externalEngines;
  }

  /** Get the TaskStore for a project from its engine. */
  getStore(projectId: string): TaskStore | undefined {
    return this.engines.get(projectId)?.getTaskStore();
  }

  /** Check if an engine is running or starting for this project. */
  has(projectId: string): boolean {
    return this.engines.has(projectId) || this.starting.has(projectId);
  }

  // ── Pause / Resume ────────────────────────────────────────────────────

  /**
   * Pause a project: update its status in CentralCore and stop its engine.
   * This prevents the reconciliation loop from restarting the engine.
   */
  async pauseProject(projectId: string): Promise<void> {
    if (this.stopped) throw new Error("ProjectEngineManager is stopped");

    runtimeLog.log(`Pausing project ${projectId}`);

    // Update CentralCore status
    await this.centralCore.updateProject(projectId, { status: "paused" });
    await this.centralCore.updateProjectHealth(projectId, { status: "paused" });

    // Stop the engine if running
    const engine = this.engines.get(projectId);
    if (engine) {
      await engine.stop();
      this.engines.delete(projectId);
      runtimeLog.log(`Stopped engine for paused project ${projectId}`);
    }

    // Remove from starting set to prevent a stalled start from completing
    this.starting.delete(projectId);

    await this.releaseSingleton(projectId);
  }

  /**
   * Resume a paused project: update its status in CentralCore and start its engine.
   */
  async resumeProject(projectId: string): Promise<void> {
    if (this.stopped) throw new Error("ProjectEngineManager is stopped");

    runtimeLog.log(`Resuming project ${projectId}`);

    // Update CentralCore status
    await this.centralCore.updateProject(projectId, { status: "active" });
    await this.centralCore.updateProjectHealth(projectId, { status: "active" });

    // Start the engine
    await this.ensureEngine(projectId);
  }

  // ── Lifecycle ──

  /**
   * Ensure an engine is running for the given project.
   * If already started, returns immediately. If starting, deduplicates.
   * If not started, creates and starts a new engine from CentralCore metadata.
   */
  async ensureEngine(
    projectId: string,
    overrides?: Partial<ProjectEngineOptions>,
  ): Promise<ProjectEngine> {
    if (this.stopped) throw new Error("ProjectEngineManager is stopped");

    // Check if the project is paused before starting
    const project = await this.centralCore.getProject(projectId);
    if (project && (project.status as string) === "paused") {
      throw new Error(`Project ${projectId} is paused`);
    }

    const existing = this.engines.get(projectId);
    if (existing) return existing;

    // Deduplicate concurrent start requests
    const pending = this.starting.get(projectId);
    if (pending) return pending;

    const promise = this.createAndStart(projectId, overrides);
    this.starting.set(projectId, promise);

    try {
      const engine = await promise;
      return engine;
    } catch (err) {
      // Clean up on failure so a retry can attempt again
      this.starting.delete(projectId);
      throw err;
    }
  }

  /**
   * Start engines for all registered projects.
   * Failures for individual projects are logged but don't stop others.
   */
  async startAll(): Promise<void> {
    const projects = await this.centralCore.listProjects();
    if (projects.length === 0) return;

    runtimeLog.log(`Starting engines for ${projects.length} registered project(s)`);

    const results = await Promise.allSettled(
      projects.map((p) => this.ensureEngine(p.id)),
    );

    let started = 0;
    let failed = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        started++;
      } else if (result.reason instanceof EngineAlreadyRunningError) {
        // Engine owned by another process — expected, already logged once.
        continue;
      } else {
        failed++;
        runtimeLog.warn(`Engine start failed: ${result.reason}`);
      }
    }

    runtimeLog.log(`Engine startup complete: ${started} started, ${failed} failed`);
  }

  /** Gracefully stop all engines and reconciliation. */
  async stopAll(): Promise<void> {
    this.stopped = true;
    this.reconciliationStopped = true;

    // Stop reconciliation interval
    if (this.reconciliationInterval !== null) {
      clearInterval(this.reconciliationInterval);
      this.reconciliationInterval = null;
    }

    // Remove concurrency change listener
    if (this.concurrencyListener && typeof this.centralCore.off === "function") {
      this.centralCore.off("concurrency:changed", this.concurrencyListener);
      this.concurrencyListener = undefined;
    }

    /*
    FNXC:PostgresResourceLifecycle 2026-07-14-18:42:
    Project runtimes own the PostgreSQL pools CentralCore may have adopted. Persist mesh-offline state before stopping any engine so runtime backend shutdown cannot race the final central write against a closed pool.
    */
    try {
      this.centralCore.stopDiscovery();
      await this.centralCore.markLocalNodeOffline();
    } catch (error) {
      runtimeLog.warn(`Failed to persist local node offline before engine shutdown: ${error instanceof Error ? error.message : String(error)}`);
    }

    const stops = Array.from(this.engines.entries()).map(
      async ([id, engine]) => {
        try {
          await engine.stop();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          runtimeLog.warn(`Engine ${id} stop error: ${message}`);
        }
      },
    );
    await Promise.all(stops);
    this.engines.clear();
    this.starting.clear();
    this.externalEngines.clear();

    // Release all singleton locks so another fusion process can take over.
    const releases = Array.from(this.singletonLocks.values()).map((lock) =>
      lock.release().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        runtimeLog.warn(`Singleton lock release error: ${message}`);
      }),
    );
    await Promise.all(releases);
    this.singletonLocks.clear();
  }

  private async releaseSingleton(projectId: string): Promise<void> {
    const lock = this.singletonLocks.get(projectId);
    if (!lock) return;
    this.singletonLocks.delete(projectId);
    try {
      await lock.release();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtimeLog.warn(
        `Singleton lock release error for ${projectId}: ${message}`,
      );
    }
  }

  /**
   * Fire-and-forget engine start — suitable as a callback for
   * onProjectFirstAccessed in the server layer.
   */
  onProjectAccessed(projectId: string): void {
    if (this.has(projectId)) return;
    this.ensureEngine(projectId).catch((err) => {
      // Expected when another process owns the engine — already logged once.
      if (err instanceof EngineAlreadyRunningError) return;
      const message = err instanceof Error ? err.message : String(err);
      runtimeLog.warn(
        `Failed to start engine for project ${projectId}: ${message}`,
      );
    });
  }

  // ── Background Reconciliation ────────────────────────────────────────

  /**
   * Start background reconciliation to detect and start engines for
   * newly registered projects without requiring UI access.
   *
   * This runs on an interval, checking for projects that have been
   * registered but don't have running engines yet.
   *
   * Idempotent — safe to call multiple times. Reconciliation stops
   * when `stopReconciliation()` or `stopAll()` is called.
   *
   * @param intervalMs How often to check for new projects (default: 30 seconds)
   */
  startReconciliation(intervalMs: number = DEFAULT_RECONCILIATION_INTERVAL_MS): void {
    if (this.stopped || this.reconciliationStopped) return;
    if (this.reconciliationInterval !== null) return; // Already running

    runtimeLog.log(`Starting project engine reconciliation (interval: ${intervalMs}ms)`);

    // Run an immediate reconciliation tick, then schedule periodic checks
    this.reconcile().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      runtimeLog.warn(`Reconciliation tick failed: ${message}`);
    });

    this.reconciliationInterval = setInterval(() => {
      if (this.reconciliationStopped) {
        this.stopReconciliation();
        return;
      }
      this.reconcile().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        runtimeLog.warn(`Reconciliation tick failed: ${message}`);
      });
    }, intervalMs);

    // Prevent the interval from keeping the process alive
    this.reconciliationInterval.unref?.();
  }

  /**
   * Stop background reconciliation.
   * Idempotent — safe to call even if reconciliation is not running.
   */
  stopReconciliation(): void {
    this.reconciliationStopped = true;
    if (this.reconciliationInterval !== null) {
      clearInterval(this.reconciliationInterval);
      this.reconciliationInterval = null;
      runtimeLog.log("Stopped project engine reconciliation");
    }
  }

  /**
   * Check for registered projects that don't have engines and start them.
   * This is the core reconciliation logic used by both `startReconciliation`
   * and `startAll()`.
   */
  private async reconcile(): Promise<void> {
    if (this.stopped || this.reconciliationStopped) return;

    try {
      const projects = await this.centralCore.listProjects();
      if (projects.length === 0) return;

      // Filter out paused projects — they should not have engines started
      const activeProjects = projects.filter((p) => (p.status as string) !== "paused");

      // Find projects that don't have running or pending engines
      const missing = activeProjects.filter((p) => !this.has(p.id));
      if (missing.length === 0) return;

      runtimeLog.log(
        `Reconciliation: found ${missing.length} project(s) without engines`,
      );

      // Start engines for missing projects (fire-and-forget)
      for (const project of missing) {
        if (this.stopped || this.reconciliationStopped) break;
        this.ensureEngine(project.id).catch((err) => {
          // An engine owned by another process is expected, not a failure —
          // createAndStart already logged it once and recorded it in
          // externalEngines. Swallow it here so reconciliation doesn't warn
          // every interval for the same externally-owned engine.
          if (err instanceof EngineAlreadyRunningError) return;
          const message = err instanceof Error ? err.message : String(err);
          runtimeLog.warn(
            `Failed to start engine for project ${project.id}: ${message}`,
          );
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtimeLog.warn(`Reconciliation failed: ${message}`);
    }
  }

  // ── Internal ──

  private async createAndStart(
    projectId: string,
    overrides?: Partial<ProjectEngineOptions>,
  ): Promise<ProjectEngine> {
    const project = await this.centralCore.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found in CentralCore`);
    }

    // Prevent starting engines for paused projects
    if ((project.status as string) === "paused") {
      throw new Error(`Project ${projectId} is paused`);
    }

    const runtimeConfig = await this.buildRuntimeConfig(project);
    const engineOptions = this.buildEngineOptions(project, runtimeConfig.workingDirectory, overrides);

    // Acquire the per-machine singleton guard before spinning up any engine
    // subsystems. This prevents two fusion processes from running engines for
    // the same project on one machine.
    const singleton = await acquireEngineSingleton(
      projectId,
      runtimeConfig.workingDirectory,
      (err) => {
        runtimeLog.warn(
          `Engine singleton lock for ${projectId} was compromised: ${err.message}`,
        );
      },
    ).catch((err) => {
      if (err instanceof EngineAlreadyRunningError) {
        // An engine IS running for this project — another fusion process owns
        // it. Record it so the dashboard reports the engine as available, and
        // log only on the first detection to avoid spamming every 30s
        // reconciliation tick while the other process stays alive.
        if (!this.externalEngines.has(projectId)) {
          runtimeLog.warn(
            `Refusing to start engine for ${projectId}: ${err.message}`,
          );
        }
        this.externalEngines.add(projectId);
      }
      throw err;
    });
    this.singletonLocks.set(projectId, singleton);
    // Acquiring the singleton proves no other process owns the engine, so clear
    // any prior "owned by another process" marker now — before engine.start().
    // If start fails below we release the lock and a later tick retries; leaving
    // the marker set here would make hasRunningEngine() report a phantom engine.
    this.externalEngines.delete(projectId);

    const engine = new ProjectEngine(
      runtimeConfig,
      this.centralCore,
      engineOptions,
    );

    try {
      await engine.start();
    } catch (err) {
      // If engine start fails we must release the singleton so a retry can
      // re-acquire it.
      await this.releaseSingleton(projectId);
      throw err;
    }

    this.engines.set(projectId, engine);
    this.starting.delete(projectId);
    runtimeLog.log(
      `Started engine for ${project.name ?? projectId} (${projectId})`,
    );

    return engine;
  }

  private async buildRuntimeConfig(project: RegisteredProject): Promise<ProjectRuntimeConfig> {
    const settings = project.settings as
      | Record<string, unknown>
      | undefined;

    return {
      projectId: project.id,
      workingDirectory: await this.centralCore.resolveLocalProjectWorkingDirectory(project.id),
      isolationMode:
        (project.isolationMode as "in-process" | "child-process") ??
        "in-process",
      maxConcurrent: (settings?.maxConcurrent as number) ?? 4,
      maxWorktrees: (settings?.maxWorktrees as number) ?? 10,
      // Shared global semaphore — all engines share one concurrency pool
      globalSemaphore: this.globalSemaphore,
      onMigrationProgress: this.options.onMigrationProgress,
    };
  }

  private buildEngineOptions(
    project: RegisteredProject,
    workingDirectory: string,
    overrides?: Partial<ProjectEngineOptions>,
  ): ProjectEngineOptions {
    /*
    FNXC:FasterStartup 2026-07-14-23:55 / 2026-07-15-00:40:
    Share the CLI-booted TaskStore only when the engine's working directory is
    the same project root as the store. Compare realpath when available so a
    symlinked CLI cwd and a registry-canonical path still share one pool
    (Greptile: path.resolve alone double-boots symlink aliases).
    */
    const sharedStore = this.options.externalTaskStore;
    const shareForThisProject = Boolean(
      sharedStore
      && sameProjectRoot(sharedStore.getRootDir(), workingDirectory),
    );
    return {
      projectId: project.id,
      cliPackageVersion: this.options.cliPackageVersion,
      getMergeStrategy: this.options.getMergeStrategy,
      processPullRequestMerge: this.options.processPullRequestMerge,
      createGroupPr: this.options.createGroupPr,
      syncGroupPr: this.options.syncGroupPr,
      prNodeGithubOps: this.options.prNodeGithubOps,
      prReconcileGithubOps: this.options.prReconcileGithubOps,
      getTaskMergeBlocker: this.options.getTaskMergeBlocker,
      onInsightRunProcessed: this.options.onInsightRunProcessed,
      ...(shareForThisProject && sharedStore ? { externalTaskStore: sharedStore } : {}),
      ...overrides,
    };
  }
}

/**
 * FNXC:FasterStartup 2026-07-15-00:40:
 * Path identity for externalTaskStore matching: resolve then realpath so
 * symlinked project roots compare equal to their canonical registry path.
 */
function sameProjectRoot(a: string, b: string): boolean {
  const normalize = (p: string): string => {
    const resolved = pathResolve(p);
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  };
  return normalize(a) === normalize(b);
}
