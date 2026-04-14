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

import type {
  CentralCore,
  TaskStore,
  RegisteredProject,
} from "@fusion/core";
import { ProjectEngine } from "./project-engine.js";
import type { ProjectEngineOptions } from "./project-engine.js";
import type { ProjectRuntimeConfig } from "./project-runtime.js";
import { AgentSemaphore } from "./concurrency.js";
import { runtimeLog } from "./logger.js";

/**
 * Options shared across all engines created by the manager.
 * These are injected by the CLI layer (dashboard.ts / serve.ts).
 */
export interface EngineManagerOptions {
  getMergeStrategy?: ProjectEngineOptions["getMergeStrategy"];
  processPullRequestMerge?: ProjectEngineOptions["processPullRequestMerge"];
  getTaskMergeBlocker?: ProjectEngineOptions["getTaskMergeBlocker"];
  onInsightRunProcessed?: ProjectEngineOptions["onInsightRunProcessed"];
}

/** Default interval for background reconciliation (30 seconds). */
export const DEFAULT_RECONCILIATION_INTERVAL_MS = 30_000;

export class ProjectEngineManager {
  private engines = new Map<string, ProjectEngine>();
  private starting = new Map<string, Promise<ProjectEngine>>();
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

  /** Get the TaskStore for a project from its engine. */
  getStore(projectId: string): TaskStore | undefined {
    return this.engines.get(projectId)?.getTaskStore();
  }

  /** Check if an engine is running or starting for this project. */
  has(projectId: string): boolean {
    return this.engines.has(projectId) || this.starting.has(projectId);
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
  }

  /**
   * Fire-and-forget engine start — suitable as a callback for
   * onProjectFirstAccessed in the server layer.
   */
  onProjectAccessed(projectId: string): void {
    if (this.has(projectId)) return;
    this.ensureEngine(projectId).catch((err) => {
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

      // Find projects that don't have running or pending engines
      const missing = projects.filter((p) => !this.has(p.id));
      if (missing.length === 0) return;

      runtimeLog.log(
        `Reconciliation: found ${missing.length} project(s) without engines`,
      );

      // Start engines for missing projects (fire-and-forget)
      for (const project of missing) {
        if (this.stopped || this.reconciliationStopped) break;
        this.ensureEngine(project.id).catch((err) => {
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

    const runtimeConfig = this.buildRuntimeConfig(project);
    const engineOptions = this.buildEngineOptions(project, overrides);

    const engine = new ProjectEngine(
      runtimeConfig,
      this.centralCore,
      engineOptions,
    );

    await engine.start();

    this.engines.set(projectId, engine);
    this.starting.delete(projectId);
    runtimeLog.log(
      `Started engine for ${project.name ?? projectId} (${projectId})`,
    );

    return engine;
  }

  private buildRuntimeConfig(project: RegisteredProject): ProjectRuntimeConfig {
    const settings = project.settings as
      | Record<string, unknown>
      | undefined;

    return {
      projectId: project.id,
      workingDirectory: project.path,
      isolationMode:
        (project.isolationMode as "in-process" | "child-process") ??
        "in-process",
      maxConcurrent: (settings?.maxConcurrent as number) ?? 4,
      maxWorktrees: (settings?.maxWorktrees as number) ?? 10,
      // Shared global semaphore — all engines share one concurrency pool
      globalSemaphore: this.globalSemaphore,
    };
  }

  private buildEngineOptions(
    project: RegisteredProject,
    overrides?: Partial<ProjectEngineOptions>,
  ): ProjectEngineOptions {
    return {
      projectId: project.id,
      getMergeStrategy: this.options.getMergeStrategy,
      processPullRequestMerge: this.options.processPullRequestMerge,
      getTaskMergeBlocker: this.options.getTaskMergeBlocker,
      onInsightRunProcessed: this.options.onInsightRunProcessed,
      ...overrides,
    };
  }
}
