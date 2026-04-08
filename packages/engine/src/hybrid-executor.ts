import { EventEmitter } from "node:events";
import type { Task, CentralCore, RegisteredProject } from "@fusion/core";
import { ProjectManager } from "./project-manager.js";
import { NodeHealthMonitor } from "./node-health-monitor.js";
import type {
  ProjectRuntime,
  ProjectRuntimeConfig,
  RuntimeStatus,
  GlobalMetrics,
} from "./project-runtime.js";
import type { ProjectManagerEvents } from "./project-manager.js";
import { hybridExecutorLog } from "./logger.js";

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
 *   workingDirectory: project.path,
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
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      hybridExecutorLog.warn("HybridExecutor already initialized");
      return;
    }

    hybridExecutorLog.log("Initializing HybridExecutor...");

    // Load all registered projects from CentralCore
    const projects = await this.centralCore.listProjects();

    // Start runtimes for all active projects
    for (const project of projects) {
      if (project.status === "active" || project.status === "initializing") {
        try {
          await this.addProject({
            projectId: project.id,
            workingDirectory: project.path,
            isolationMode: project.isolationMode,
            maxConcurrent: project.settings?.maxConcurrent ?? 2,
            maxWorktrees: project.settings?.maxWorktrees ?? 4,
            settings: project.settings,
          });
          hybridExecutorLog.log(`Loaded project runtime for ${project.name}`);
        } catch (error) {
          hybridExecutorLog.error(
            `Failed to load project ${project.id}:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    }

    // Listen for CentralCore project events
    this.setupCentralCoreListeners();

    // Start remote node health monitoring after project runtimes are loaded.
    this.nodeHealthMonitor = new NodeHealthMonitor(this.centralCore);
    await this.nodeHealthMonitor.start();

    this.initialized = true;
    hybridExecutorLog.log("HybridExecutor initialized");
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

    const currentStatus = existingRuntime.getStatus();
    const currentMode =
      existingRuntime instanceof
      (await import("./runtimes/child-process-runtime.js")).ChildProcessRuntime
        ? "child-process"
        : "in-process";

    // If isolation mode changed, need to recreate the runtime
    if (config.isolationMode && config.isolationMode !== currentMode) {
      hybridExecutorLog.log(
        `Isolation mode changed for ${projectId}: ${currentMode} → ${config.isolationMode}`
      );

      // Stop old runtime
      await this.projectManager.removeProject(projectId);

      // Get the full current config
      const fullConfig: ProjectRuntimeConfig = {
        projectId,
        workingDirectory: config.workingDirectory ?? "/tmp",
        isolationMode: config.isolationMode,
        maxConcurrent: config.maxConcurrent ?? 2,
        maxWorktrees: config.maxWorktrees ?? 4,
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
  async acquireGlobalSlot(projectId: string): Promise<boolean> {
    return this.projectManager.acquireGlobalSlot(projectId);
  }

  /**
   * Release a global concurrency slot.
   *
   * @param projectId - Project releasing the slot
   */
  async releaseGlobalSlot(projectId: string): Promise<void> {
    return this.projectManager.releaseGlobalSlot(projectId);
  }

  /**
   * Graceful shutdown of all runtimes.
   *
   * Stops accepting new tasks, waits for active tasks to complete (with timeout),
   * and shuts down all runtimes in parallel.
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) {
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
