import { EventEmitter } from "node:events";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  Task,
  TaskStore,
  CentralCore,
} from "@fusion/core";
import type { Scheduler } from "../scheduler.js";
import type {
  ProjectRuntime,
  ProjectRuntimeConfig,
  RuntimeStatus,
  RuntimeMetrics,
  ProjectRuntimeEvents,
} from "../project-runtime.js";
import { IpcHost } from "../ipc/ipc-host.js";
import {
  START_RUNTIME,
  STOP_RUNTIME,
  GET_STATUS,
  GET_METRICS,
  TASK_CREATED,
  TASK_MOVED,
  TASK_UPDATED,
  ERROR_EVENT,
  HEALTH_CHANGED,
  type TaskCreatedPayload,
  type TaskMovedPayload,
  type TaskUpdatedPayload,
  type ErrorEventPayload,
  type HealthChangedPayload,
} from "../ipc/ipc-protocol.js";
import { runtimeLog } from "../logger.js";

/**
 * Health monitor for tracking child process health.
 */
class HealthMonitor {
  private running = false;
  private missedHeartbeats = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private restartAttempts = 0;
  private restartDelays = [1000, 5000, 15000]; // Exponential backoff: 1s, 5s, 15s

  constructor(
    private onHealthCheck: () => Promise<boolean>,
    private onUnhealthy: () => void,
    private options: {
      intervalMs?: number;
      maxMissedHeartbeats?: number;
      maxRestartAttempts?: number;
    } = {}
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    const intervalMs = this.options.intervalMs ?? 5000;
    const maxMissed = this.options.maxMissedHeartbeats ?? 3;

    this.interval = setInterval(async () => {
      const healthy = await this.onHealthCheck();

      if (healthy) {
        if (this.missedHeartbeats > 0) {
          runtimeLog.log(`Health recovered after ${this.missedHeartbeats} missed heartbeats`);
        }
        this.missedHeartbeats = 0;
        this.restartAttempts = 0; // Reset restart attempts on success
      } else {
        this.missedHeartbeats++;
        runtimeLog.warn(`Missed heartbeat ${this.missedHeartbeats}/${maxMissed}`);

        if (this.missedHeartbeats >= maxMissed) {
          runtimeLog.error(`Health check failed after ${maxMissed} attempts`);
          this.onUnhealthy();
        }
      }
    }, intervalMs);

    runtimeLog.log(`Health monitor started (interval: ${intervalMs}ms)`);
  }

  stop(): void {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.missedHeartbeats = 0;
    runtimeLog.log("Health monitor stopped");
  }

  getRestartDelay(): number {
    const delay = this.restartDelays[this.restartAttempts] ?? this.restartDelays[this.restartDelays.length - 1];
    return delay;
  }

  incrementRestartAttempts(): void {
    this.restartAttempts++;
  }

  getRestartAttempts(): number {
    return this.restartAttempts;
  }

  getMissedHeartbeats(): number {
    return this.missedHeartbeats;
  }
}

/**
 * ChildProcessRuntime runs a project in an isolated child process.
 *
 * This provides stronger isolation between projects at the cost of
 * IPC overhead. The child process runs an InProcessRuntime internally
 * and communicates with the host via IPC messages.
 *
 * Features:
 * - Process isolation (separate memory space)
 * - Automatic restart on crash with exponential backoff
 * - Health monitoring via heartbeat protocol
 * - Graceful shutdown with configurable timeout
 * - Event forwarding from child process to host listeners
 *
 * @example
 * ```typescript
 * const config: ProjectRuntimeConfig = {
 *   projectId: "proj_abc123",
 *   workingDirectory: "/path/to/project",
 *   isolationMode: "child-process",
 *   maxConcurrent: 2,
 *   maxWorktrees: 4,
 * };
 *
 * const runtime = new ChildProcessRuntime(config, centralCore);
 * await runtime.start();
 *
 * // Access metrics via IPC
 * const metrics = runtime.getMetrics();
 *
 * await runtime.stop();
 * ```
 */
export class ChildProcessRuntime
  extends EventEmitter<ProjectRuntimeEvents>
  implements ProjectRuntime
{
  private status: RuntimeStatus = "stopped";
  private child: ChildProcess | null = null;
  private ipcHost: IpcHost | null = null;
  private healthMonitor: HealthMonitor;
  private lastMetrics: RuntimeMetrics = {
    inFlightTasks: 0,
    activeAgents: 0,
    lastActivityAt: new Date().toISOString(),
  };

  /**
   * @param config - Runtime configuration
   * @param centralCore - CentralCore reference for global coordination
   */
  constructor(
    private config: ProjectRuntimeConfig,
    private centralCore: CentralCore
  ) {
    super();
    this.setMaxListeners(100);

    // Initialize health monitor
    this.healthMonitor = new HealthMonitor(
      async () => this.checkHealth(),
      () => this.handleUnhealthy(),
      { intervalMs: 5000, maxMissedHeartbeats: 3, maxRestartAttempts: 3 }
    );

    runtimeLog.log(`Created ChildProcessRuntime for project ${config.projectId}`);
  }

  /**
   * Start the runtime by spawning a child process.
   *
   * Startup sequence:
   * 1. Set status to "starting"
   * 2. Fork child process pointing to worker entry point
   * 3. Set up IPC host with the child process
   * 4. Send START_RUNTIME command with serialized config
   * 5. Wait for OK response or timeout (10s)
   * 6. Start health monitoring heartbeat
   * 7. Set status to "active"
   */
  async start(): Promise<void> {
    if (this.status !== "stopped") {
      throw new Error(`Cannot start runtime: current status is ${this.status}`);
    }

    this.setStatus("starting");
    runtimeLog.log(`Starting ChildProcessRuntime for project ${this.config.projectId}`);

    try {
      await this.spawnChild();
      this.setStatus("active");
      runtimeLog.log(`ChildProcessRuntime started for project ${this.config.projectId}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus("errored");
      runtimeLog.error(`Failed to start ChildProcessRuntime:`, err.message);
      this.emit("error", err);
      throw err;
    }
  }

  /**
   * Spawn the child process and set up IPC.
   */
  private async spawnChild(): Promise<void> {
    // Determine worker entry point
    const workerPath = this.getWorkerPath();

    runtimeLog.log(`Forking child process: ${workerPath}`);

    // Fork child process
    this.child = fork(workerPath, [], {
      silent: true, // Pipe stdout/stderr
      execArgv: [], // Don't inherit exec arguments
    });

    // Set up IPC host
    this.ipcHost = new IpcHost(this.child, { commandTimeoutMs: 10000 });

    // Set up event forwarding
    this.setupEventForwarding();

    // Send START_RUNTIME command
    runtimeLog.log("Sending START_RUNTIME command to child");
    await this.ipcHost.sendCommand(START_RUNTIME, { config: this.config });

    // Start health monitoring
    this.healthMonitor.start();

    // Handle child process exit
    this.child.on("exit", (code, signal) => {
      runtimeLog.warn(`Child process exited (code: ${code}, signal: ${signal})`);
      this.handleChildExit(code, signal);
    });
  }

  /**
   * Get the path to the worker entry point.
   */
  private getWorkerPath(): string {
    // In production, use the compiled .js file
    // In development/tests, use .ts with tsx
    const isCompiled = !import.meta.url.endsWith(".ts");

    const currentDir = dirname(fileURLToPath(import.meta.url));
    const workerFile = isCompiled ? "child-process-worker.js" : "child-process-worker.ts";

    return join(currentDir, workerFile);
  }

  /**
   * Set up event forwarding from IPC host to runtime listeners.
   */
  private setupEventForwarding(): void {
    if (!this.ipcHost) return;

    // Forward task events
    this.ipcHost.on(TASK_CREATED, (payload: TaskCreatedPayload) => {
      this.emit("task:created", payload.task);
    });

    this.ipcHost.on(TASK_MOVED, (payload: TaskMovedPayload) => {
      this.emit("task:moved", { task: payload.task, from: payload.from, to: payload.to });
    });

    this.ipcHost.on(TASK_UPDATED, (payload: TaskUpdatedPayload) => {
      this.emit("task:updated", payload.task);
    });

    // Forward error events
    this.ipcHost.on(ERROR_EVENT, (payload: ErrorEventPayload) => {
      const error = new Error(payload.message);
      if (payload.code) {
        (error as Error & { code: string }).code = payload.code;
      }
      this.emit("error", error);
    });

    // Forward health change events
    this.ipcHost.on(HEALTH_CHANGED, (payload: HealthChangedPayload) => {
      this.status = payload.status as RuntimeStatus;
      this.emit("health-changed", { status: payload.status, previous: payload.previous });
    });

    // Handle disconnect
    this.ipcHost.on("disconnect", () => {
      runtimeLog.warn("IPC host disconnected");
      this.handleDisconnection();
    });
  }

  /**
   * Stop the runtime with graceful shutdown.
   *
   * Shutdown sequence:
   * 1. Set status to "stopping"
   * 2. Stop health monitoring
   * 3. Send STOP_RUNTIME command with 30s timeout
   * 4. Kill child process if graceful shutdown fails
   * 5. Set status to "stopped"
   */
  async stop(): Promise<void> {
    if (this.status === "stopped" || this.status === "stopping") {
      return;
    }

    this.setStatus("stopping");
    runtimeLog.log(`Stopping ChildProcessRuntime for project ${this.config.projectId}`);

    // Stop health monitoring
    this.healthMonitor.stop();

    try {
      // Send graceful shutdown command
      if (this.ipcHost?.isConnected()) {
        runtimeLog.log("Sending STOP_RUNTIME command to child");
        await this.ipcHost.sendCommand(STOP_RUNTIME, { timeoutMs: 30000 }, 35000);
      }
    } catch (error) {
      runtimeLog.warn(`Graceful shutdown failed: ${error}`);
    }

    // Kill child process if still running
    this.killChild();

    this.setStatus("stopped");
    runtimeLog.log(`ChildProcessRuntime stopped for project ${this.config.projectId}`);
  }

  /**
   * Kill the child process forcefully.
   */
  private killChild(): void {
    if (this.child && !this.child.killed) {
      runtimeLog.log("Killing child process");
      this.child.kill("SIGTERM");

      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (this.child && !this.child.killed) {
          runtimeLog.warn("Force killing child process");
          this.child.kill("SIGKILL");
        }
      }, 5000);
    }

    this.child = null;
    this.ipcHost = null;
  }

  /**
   * Get the current runtime status.
   */
  getStatus(): RuntimeStatus {
    return this.status;
  }

  /**
   * Get the project's TaskStore instance.
   * @throws Error - Not accessible in child mode (use IPC instead)
   */
  getTaskStore(): TaskStore {
    throw new Error(
      "TaskStore is not accessible in ChildProcessRuntime. " +
        "Use IPC methods to access task data."
    );
  }

  /**
   * Get the project's Scheduler instance.
   * @throws Error - Not accessible in child mode
   */
  getScheduler(): Scheduler {
    throw new Error(
      "Scheduler is not accessible in ChildProcessRuntime. " +
        "Use IPC methods to interact with the scheduler."
    );
  }

  /**
   * Get current runtime metrics (via IPC query).
   */
  getMetrics(): RuntimeMetrics {
    // Query metrics via IPC if connected
    if (this.ipcHost?.isConnected()) {
      // Fire-and-forget metrics request - returns cached value immediately
      this.ipcHost
        .sendCommand(GET_METRICS, {})
        .then((metrics: unknown) => {
          this.lastMetrics = metrics as RuntimeMetrics;
        })
        .catch(() => {
          // Ignore errors, use cached value
        });
    }

    return {
      ...this.lastMetrics,
      lastActivityAt: new Date().toISOString(),
    };
  }

  /**
   * Check health by pinging the child process.
   */
  private async checkHealth(): Promise<boolean> {
    if (!this.ipcHost?.isConnected()) {
      return false;
    }

    try {
      await this.ipcHost.ping(5000);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Handle unhealthy child process (restart or error).
   */
  private handleUnhealthy(): void {
    const maxRestarts = 3;

    if (this.healthMonitor.getRestartAttempts() >= maxRestarts) {
      runtimeLog.error(`Max restart attempts (${maxRestarts}) reached, transitioning to errored`);
      this.setStatus("errored");
      this.emit("error", new Error("Child process failed after max restart attempts"));
      return;
    }

    const delay = this.healthMonitor.getRestartDelay();
    this.healthMonitor.incrementRestartAttempts();

    runtimeLog.log(`Attempting restart ${this.healthMonitor.getRestartAttempts()}/${maxRestarts} after ${delay}ms`);

    setTimeout(async () => {
      try {
        this.killChild();
        await this.spawnChild();
        runtimeLog.log("Child process restarted successfully");
      } catch (error) {
        runtimeLog.error("Failed to restart child process:", error);
        this.setStatus("errored");
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      }
    }, delay);
  }

  /**
   * Handle child process exit.
   */
  private handleChildExit(code: number | null, signal: string | null): void {
    // Don't restart if we're intentionally stopping
    if (this.status === "stopping" || this.status === "stopped") {
      return;
    }

    // Unexpected exit - trigger restart
    runtimeLog.warn(`Unexpected child exit (code: ${code}, signal: ${signal})`);
    this.handleUnhealthy();
  }

  /**
   * Handle IPC disconnection.
   */
  private handleDisconnection(): void {
    if (this.status !== "stopping" && this.status !== "stopped") {
      runtimeLog.error("IPC channel disconnected unexpectedly");
      this.handleUnhealthy();
    }
  }

  /**
   * Update status and emit health-changed event.
   */
  private setStatus(newStatus: RuntimeStatus): void {
    const previous = this.status;
    this.status = newStatus;

    if (previous !== newStatus) {
      this.emit("health-changed", { status: newStatus, previous });
    }
  }
}
