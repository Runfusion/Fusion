import type { EventEmitter } from "node:events";
import type { TaskStore, Task, IsolationMode, ProjectSettings } from "@fusion/core";
import type { Scheduler } from "./scheduler.js";

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
  /** Number of tasks currently in-progress */
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
   * This includes initializing the TaskStore, Scheduler, Executor, and WorktreePool.
   */
  start(): Promise<void>;

  /**
   * Stop the runtime with graceful shutdown.
   * Waits for active tasks to complete (with timeout), stops the scheduler,
   * and cleans up resources.
   */
  stop(): Promise<void>;

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
   * Get current runtime metrics.
   * @returns Metrics including in-flight tasks, active agents, and memory usage
   */
  getMetrics(): RuntimeMetrics;
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
