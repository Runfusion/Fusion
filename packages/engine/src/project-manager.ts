import { EventEmitter } from "node:events";
import type { Task, CentralCore, RegisteredProject } from "@fusion/core";
import { InProcessRuntime } from "./runtimes/in-process-runtime.js";
import { ChildProcessRuntime } from "./runtimes/child-process-runtime.js";
import { RemoteNodeRuntime } from "./runtimes/remote-node-runtime.js";
import { AgentSemaphore } from "./concurrency.js";
import type {
  ProjectRuntime,
  ProjectRuntimeConfig,
  RuntimeStatus,
  GlobalMetrics,
} from "./project-runtime.js";
import { projectManagerLog } from "./logger.js";

/**
 * Events emitted by ProjectManager with project attribution.
 */
export interface ProjectManagerEvents {
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
  /** Emitted when a runtime is added */
  "runtime:added": [data: { projectId: string; projectName: string }];
  /** Emitted when a runtime is removed */
  "runtime:removed": [data: { projectId: string; projectName: string }];
}

/**
 * ProjectManager orchestrates all project runtimes and enforces global
 * concurrency limits from CentralCore.
 *
 * This is the main entry point for multi-project support in the engine.
 * It manages multiple ProjectRuntime instances (one per project) and:
 * - Creates appropriate runtime type based on isolation mode
 * - Forwards runtime events with project attribution
 * - Enforces global concurrency limits via CentralCore
 * - Updates project health in CentralCore
 * - Logs activity to CentralCore's unified feed
 *
 * **Project Registration Assumption:**
 * ProjectManager assumes projects are already registered in CentralCore.
 * Call `centralCore.registerProject()` before `addProject()`.
 *
 * @example
 * ```typescript
 * const central = new CentralCore();
 * await central.init();
 *
 * const manager = new ProjectManager(central);
 *
 * // Register project in CentralCore first
 * const project = await central.registerProject({
 *   name: "My Project",
 *   path: "/path/to/project"
 * });
 *
 * // Then add runtime
 * const runtime = await manager.addProject({
 *   projectId: project.id,
 *   workingDirectory: project.path,
 *   isolationMode: "in-process",
 *   maxConcurrent: 2,
 *   maxWorktrees: 4,
 * });
 *
 * // Listen to all project events
 * manager.on("task:created", ({ projectId, projectName, task }) => {
 *   console.log(`${projectName}: Task ${task.id} created`);
 * });
 * ```
 */
export class ProjectManager extends EventEmitter<ProjectManagerEvents> {
  private runtimes = new Map<string, ProjectRuntime>();
  private projectNames = new Map<string, string>();
  private globalSemaphore: AgentSemaphore;
  /** Mutable limit read by the shared semaphore's getter function. */
  private currentGlobalLimit = 4;

  /**
   * @param centralCore - CentralCore reference for global coordination
   */
  constructor(private centralCore: CentralCore) {
    super();
    this.setMaxListeners(100);

    // Initialize global semaphore with a getter that reads the mutable limit.
    // This single semaphore instance is shared across all runtimes so
    // cross-project concurrency is enforced correctly.
    this.globalSemaphore = new AgentSemaphore(() => this.currentGlobalLimit);

    // Refresh the global limit periodically
    this.refreshGlobalLimit();
    setInterval(() => this.refreshGlobalLimit(), 30000); // Refresh every 30s

    projectManagerLog.log("ProjectManager initialized");
  }

  /**
   * Refresh the global concurrency limit from CentralCore.
   */
  private async refreshGlobalLimit(): Promise<void> {
    try {
      const state = await this.centralCore.getGlobalConcurrencyState();
      this.currentGlobalLimit = state.globalMaxConcurrent;
    } catch (error) {
      projectManagerLog.warn("Failed to refresh global concurrency limit:", error);
    }
  }

  /**
   * Add a project runtime and start it.
   *
   * **Prerequisite:** Project must already be registered in CentralCore.
   *
   * @param config - Runtime configuration (must match a registered project)
   * @returns The created and started ProjectRuntime
   * @throws Error if project not found in CentralCore or runtime already exists
   */
  async addProject(config: ProjectRuntimeConfig): Promise<ProjectRuntime> {
    // Validate project exists in CentralCore
    const project = await this.centralCore.getProject(config.projectId);
    if (!project) {
      throw new Error(
        `Project ${config.projectId} not found in CentralCore. ` +
          "Register the project first with centralCore.registerProject()."
      );
    }

    // Check if runtime already exists
    if (this.runtimes.has(config.projectId)) {
      throw new Error(`Runtime already exists for project ${config.projectId}`);
    }

    projectManagerLog.log(`Adding project runtime for ${config.projectId} (${project.name})`);

    // Store project name for event attribution
    this.projectNames.set(config.projectId, project.name);

    // Create appropriate runtime based on isolation mode
    let runtime: ProjectRuntime;
    // Inject the shared global semaphore so all runtimes share one concurrency pool.
    const configWithSemaphore = { ...config, globalSemaphore: this.globalSemaphore };

    if (config.isolationMode === "child-process") {
      runtime = new ChildProcessRuntime(configWithSemaphore, this.centralCore);
    } else {
      let assignedNode = undefined;

      if (project.nodeId) {
        assignedNode = await this.centralCore.getNode(project.nodeId);

        if (!assignedNode) {
          projectManagerLog.warn(
            `Assigned node ${project.nodeId} not found for project ${project.id}; falling back to InProcessRuntime`
          );
        }
      }

      if (assignedNode?.type === "remote") {
        runtime = new RemoteNodeRuntime({
          nodeConfig: assignedNode,
          projectId: config.projectId,
          projectName: project.name,
        });
      } else {
        // Default to local in-process runtime (includes unassigned + local-node assigned)
        runtime = new InProcessRuntime(configWithSemaphore, this.centralCore);
      }
    }

    // Set up event forwarding with project attribution
    this.setupEventForwarding(runtime, config.projectId, project.name);

    // Start the runtime
    await runtime.start();

    // Update project health to active
    await this.centralCore.updateProjectHealth(config.projectId, {
      status: "active",
      activeTaskCount: 0,
      inFlightAgentCount: 0,
      totalTasksCompleted: 0,
      totalTasksFailed: 0,
      updatedAt: new Date().toISOString(),
    });

    // Update project status from "initializing" to "active"
    await this.centralCore.updateProject(project.id, {
      status: "active",
    });

    // Store runtime
    this.runtimes.set(config.projectId, runtime);

    // Log to activity feed
    await this.centralCore.logActivity({
      type: "task:created", // Using task:created as a generic activity type
      projectId: config.projectId,
      projectName: project.name,
      timestamp: new Date().toISOString(),
      details: `Project runtime started for ${project.name}`,
    });

    this.emit("runtime:added", { projectId: config.projectId, projectName: project.name });

    projectManagerLog.log(`Project runtime added for ${config.projectId}`);
    return runtime;
  }

  /**
   * Remove a project runtime and stop it.
   *
   * @param id - Project ID to remove
   * @throws Error if runtime not found
   */
  async removeProject(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) {
      throw new Error(`Runtime not found for project ${id}`);
    }

    const projectName = this.projectNames.get(id) ?? id;
    projectManagerLog.log(`Removing project runtime for ${id}`);

    // Stop the runtime
    await runtime.stop();

    // Remove from maps
    this.runtimes.delete(id);
    this.projectNames.delete(id);

    // Update project health to paused
    await this.centralCore.updateProjectHealth(id, {
      status: "paused",
      activeTaskCount: 0,
      inFlightAgentCount: 0,
      updatedAt: new Date().toISOString(),
    });

    // Log to activity feed
    await this.centralCore.logActivity({
      type: "task:created",
      projectId: id,
      projectName: projectName,
      timestamp: new Date().toISOString(),
      details: `Project runtime stopped for ${projectName}`,
    });

    this.emit("runtime:removed", { projectId: id, projectName });

    projectManagerLog.log(`Project runtime removed for ${id}`);
  }

  /**
   * Get a runtime by project ID.
   */
  getRuntime(id: string): ProjectRuntime | undefined {
    return this.runtimes.get(id);
  }

  /**
   * List all managed runtimes.
   */
  listRuntimes(): ProjectRuntime[] {
    return Array.from(this.runtimes.values());
  }

  /**
   * Get all project IDs.
   */
  getProjectIds(): string[] {
    return Array.from(this.runtimes.keys());
  }

  /**
   * Get global metrics aggregated across all runtimes.
   */
  async getGlobalMetrics(): Promise<GlobalMetrics> {
    const statusCounts: Record<RuntimeStatus, number> = {
      active: 0,
      paused: 0,
      errored: 0,
      stopped: 0,
      starting: 0,
      stopping: 0,
    };

    let totalInFlight = 0;
    let totalActiveAgents = 0;

    for (const [id, runtime] of this.runtimes) {
      const status = runtime.getStatus();
      statusCounts[status]++;

      try {
        const metrics = runtime.getMetrics();
        totalInFlight += metrics.inFlightTasks;
        totalActiveAgents += metrics.activeAgents;

        // Update health in CentralCore
        const project = await this.centralCore.getProject(id);
        if (project) {
          await this.centralCore.updateProjectHealth(id, {
            status: status as "active" | "paused" | "errored" | "initializing",
            activeTaskCount: metrics.inFlightTasks,
            inFlightAgentCount: metrics.activeAgents,
            lastActivityAt: metrics.lastActivityAt,
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (error) {
        projectManagerLog.warn(`Failed to get metrics for ${id}:`, error);
      }
    }

    return {
      totalInFlightTasks: totalInFlight,
      totalActiveAgents: totalActiveAgents,
      runtimeCountByStatus: statusCounts,
      totalRuntimes: this.runtimes.size,
    };
  }

  /**
   * Set up event forwarding from runtime to ProjectManager listeners.
   */
  private setupEventForwarding(
    runtime: ProjectRuntime,
    projectId: string,
    projectName: string
  ): void {
    // Forward task:created
    runtime.on("task:created", (task: Task) => {
      this.emit("task:created", { projectId, projectName, task });
      this.logActivity("task:created", projectId, projectName, `Task ${task.id} created`, task.id, task.title).catch((err: unknown) => {
        projectManagerLog.warn(`Failed to log task:created activity for ${projectId}:`, err);
      });
    });

    // Forward task:moved
    runtime.on("task:moved", (data: { task: Task; from: string; to: string }) => {
      this.emit("task:moved", { projectId, projectName, task: data.task, from: data.from, to: data.to });
      this.logActivity(
        "task:moved",
        projectId,
        projectName,
        `Task ${data.task.id} moved: ${data.from} → ${data.to}`,
        data.task.id,
        data.task.title,
        { from: data.from, to: data.to }
      ).catch((err: unknown) => {
        projectManagerLog.warn(`Failed to log task:moved activity for ${projectId}:`, err);
      });
    });

    // Forward task:updated
    runtime.on("task:updated", (task: Task) => {
      this.emit("task:updated", { projectId, projectName, task });
    });

    // Forward errors
    runtime.on("error", (error: Error) => {
      this.emit("error", { projectId, projectName, error });
      this.logActivity(
        "task:failed",
        projectId,
        projectName,
        `Error in ${projectName}: ${error.message}`
      ).catch((err: unknown) => {
        projectManagerLog.warn(`Failed to log task:failed activity for ${projectId}:`, err);
      });
    });

    // Forward health changes
    runtime.on("health-changed", (data: { status: RuntimeStatus; previous: RuntimeStatus }) => {
      this.emit("health:changed", { projectId, projectName, status: data.status, previous: data.previous });

      // Update health in CentralCore
      this.centralCore.updateProjectHealth(projectId, {
        status: data.status as "active" | "paused" | "errored" | "initializing",
        updatedAt: new Date().toISOString(),
      }).catch((err: unknown) => {
        projectManagerLog.warn(`Failed to update health for ${projectId}:`, err);
      });
    });
  }

  /**
   * Log activity to CentralCore's unified feed.
   */
  private async logActivity(
    type: "task:created" | "task:moved" | "task:failed",
    projectId: string,
    projectName: string,
    details: string,
    taskId?: string,
    taskTitle?: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.centralCore.logActivity({
        type,
        projectId,
        projectName,
        timestamp: new Date().toISOString(),
        details,
        taskId,
        taskTitle,
        metadata,
      });
    } catch (error) {
      // Best-effort logging
      projectManagerLog.warn("Failed to log activity:", error);
    }
  }

  /**
   * Acquire a global concurrency slot.
   * Call this before starting task execution.
   */
  async acquireGlobalSlot(projectId: string): Promise<boolean> {
    try {
      return await this.centralCore.acquireGlobalSlot(projectId);
    } catch (error) {
      projectManagerLog.error(`Failed to acquire global slot for ${projectId}:`, error);
      return false;
    }
  }

  /**
   * Release a global concurrency slot.
   * Call this after task execution completes.
   */
  async releaseGlobalSlot(projectId: string): Promise<void> {
    try {
      await this.centralCore.releaseGlobalSlot(projectId);
    } catch (error) {
      projectManagerLog.error(`Failed to release global slot for ${projectId}:`, error);
    }
  }

  /**
   * Stop all runtimes and clean up.
   */
  async stopAll(): Promise<void> {
    projectManagerLog.log("Stopping all project runtimes...");

    const stopPromises = Array.from(this.runtimes.keys()).map((id) =>
      this.removeProject(id).catch((error) => {
        projectManagerLog.error(`Failed to stop runtime ${id}:`, error);
      })
    );

    await Promise.all(stopPromises);

    projectManagerLog.log("All project runtimes stopped");
    this.removeAllListeners();
  }
}
