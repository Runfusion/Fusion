import { EventEmitter } from "node:events";
import type { NodeConfig, Task, TaskStore } from "@fusion/core";
import type { Scheduler } from "../scheduler.js";
import type {
  ProjectRuntime,
  ProjectRuntimeEvents,
  RuntimeMetrics,
  RuntimeStatus,
} from "../project/project-runtime.js";
import { remoteNodeLog } from "../logger.js";
import {
  RemoteNodeClient,
  type RemoteNodeEvent,
  type RemoteNodeTaskAssignedPayload,
} from "./remote-node-client.js";

export interface RemoteNodeRuntimeConfig {
  nodeConfig: NodeConfig;
  projectId: string;
  projectName: string;
}

export class RemoteNodeRuntime
  extends EventEmitter<ProjectRuntimeEvents>
  implements ProjectRuntime
{
  private status: RuntimeStatus = "stopped";
  private client: RemoteNodeClient;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private streamLoopAbortController: AbortController | null = null;
  private streamLoopPromise: Promise<void> | null = null;
  private lastSuccessfulMetricsAt: string;
  private cachedMetrics: RuntimeMetrics;

  // Kept as mutable fields for testability.
  private reconnectBaseDelayMs = 5_000;
  private maxReconnectDelayMs = 60_000;
  private maxReconnectAttempts = 10;
  private lastAssignmentCursor: string | null = null;
  private readonly seenAssignmentKeys = new Set<string>();

  constructor(private config: RemoteNodeRuntimeConfig) {
    super();
    this.setMaxListeners(100);

    this.cachedMetrics = {
      inFlightTasks: 0,
      activeAgents: 0,
      lastActivityAt: new Date().toISOString(),
    };
    this.lastSuccessfulMetricsAt = this.cachedMetrics.lastActivityAt;

    this.client = new RemoteNodeClient({
      baseUrl: config.nodeConfig.url ?? "",
      apiKey: config.nodeConfig.apiKey ?? "",
    });

    remoteNodeLog.log(
      `Created RemoteNodeRuntime for project ${config.projectId} on node ${config.nodeConfig.name}`
    );
  }

  async start(): Promise<void> {
    if (this.status !== "stopped") {
      throw new Error(`Cannot start runtime: current status is ${this.status}`);
    }

    this.validateRemoteNodeConfig();

    this.setStatus("starting");
    try {
      await this.client.health();
      await this.refreshMetrics();

      this.setStatus("active");
      this.startHealthChecks();
      this.startEventStreamLoop();

      remoteNodeLog.log(
        `RemoteNodeRuntime started for ${this.config.projectId} (${this.config.projectName})`
      );
    } catch (error) {
      const err = this.toError(error);
      this.setStatus("errored");
      this.emitRuntimeError(err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.status === "stopped" || this.status === "stopping") {
      return;
    }

    this.setStatus("stopping");

    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }

    if (this.streamLoopAbortController) {
      this.streamLoopAbortController.abort();
    }

    if (this.streamLoopPromise) {
      try {
        await this.streamLoopPromise;
      } catch {
        // Best-effort shutdown. Errors are already emitted via runtime events.
      }
    }

    this.streamLoopAbortController = null;
    this.streamLoopPromise = null;

    this.setStatus("stopped");
    remoteNodeLog.log(`RemoteNodeRuntime stopped for ${this.config.projectId}`);
  }

  getStatus(): RuntimeStatus {
    return this.status;
  }

  getTaskStore(): TaskStore {
    throw new Error(
      "TaskStore not accessible for remote node runtime. Use the remote Fusion API directly."
    );
  }

  getScheduler(): Scheduler {
    throw new Error("Scheduler not accessible for remote node runtime.");
  }

  getMetrics(): RuntimeMetrics {
    void this.refreshMetrics();
    return { ...this.cachedMetrics };
  }

  private validateRemoteNodeConfig(): void {
    if (this.config.nodeConfig.type !== "remote") {
      throw new Error(
        `RemoteNodeRuntime requires a remote node configuration (received: ${this.config.nodeConfig.type})`
      );
    }

    if (!this.config.nodeConfig.url) {
      throw new Error("Remote node runtime requires nodeConfig.url for remote nodes.");
    }

    if (!this.config.nodeConfig.apiKey) {
      throw new Error("Remote node runtime requires nodeConfig.apiKey for authentication.");
    }
  }

  private startHealthChecks(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
    }

    this.healthInterval = setInterval(() => {
      void this.client.health().catch((error) => {
        this.emitRuntimeError(this.toError(error));
      });
    }, 30_000);
  }

  private startEventStreamLoop(): void {
    if (this.streamLoopPromise) {
      return;
    }

    this.streamLoopAbortController = new AbortController();
    this.streamLoopPromise = this.runEventStreamLoop(this.streamLoopAbortController.signal)
      .catch((error) => {
        this.emitRuntimeError(this.toError(error));
      })
      .finally(() => {
        this.streamLoopPromise = null;
      });
  }

  private async runEventStreamLoop(signal: AbortSignal): Promise<void> {
    let reconnectAttempts = 0;

    while (!signal.aborted && !this.isShuttingDown()) {
      let sawAnyEvent = false;

      try {
        for await (const event of this.client.streamEvents({ signal })) {
          if (signal.aborted || this.isShuttingDown()) {
            return;
          }

          sawAnyEvent = true;
          this.forwardRemoteEvent(event);
        }

        if (signal.aborted || this.isShuttingDown()) {
          return;
        }

        if (sawAnyEvent) {
          reconnectAttempts = 0;
        }

        throw new Error("Remote event stream ended unexpectedly");
      } catch (error) {
        if (signal.aborted || this.isShuttingDown()) {
          return;
        }

        reconnectAttempts += 1;
        this.emitRuntimeError(this.toError(error));

        if (reconnectAttempts >= this.maxReconnectAttempts) {
          this.setStatus("errored");
          return;
        }

        const delayMs = Math.min(
          this.reconnectBaseDelayMs * 2 ** (reconnectAttempts - 1),
          this.maxReconnectDelayMs
        );

        remoteNodeLog.warn(
          `Remote event stream disconnected for ${this.config.projectId}; reconnecting in ${delayMs}ms ` +
            `(attempt ${reconnectAttempts}/${this.maxReconnectAttempts})`
        );

        await this.pollPendingAssignments("cross-node-poll");

        await this.sleep(delayMs, signal);
        if (signal.aborted) {
          return;
        }

        try {
          await this.client.health();
        } catch (healthError) {
          this.emitRuntimeError(this.toError(healthError));
        }
      }
    }
  }

  private forwardRemoteEvent(event: RemoteNodeEvent): void {
    switch (event.type) {
      case "task:created":
        this.emit("task:created", event.payload as Task);
        break;
      case "task:moved": {
        const payload = event.payload as { task: Task; from: string; to: string };
        this.emit("task:moved", {
          task: payload.task,
          from: payload.from,
          to: payload.to,
        });
        break;
      }
      case "task:updated":
        this.emit("task:updated", event.payload as Task);
        break;
      case "task:assigned":
        this.emitAssignmentWake(event.payload as RemoteNodeTaskAssignedPayload, "cross-node-push");
        break;
      case "error": {
        const payload = event.payload;
        if (payload instanceof Error) {
          this.emitRuntimeError(payload);
        } else if (typeof payload === "object" && payload && "message" in payload) {
          const message = String((payload as { message: unknown }).message);
          this.emitRuntimeError(new Error(message));
        } else {
          this.emitRuntimeError(new Error(String(payload)));
        }
        break;
      }
      default:
        remoteNodeLog.warn(
          `Ignoring unsupported remote event type "${event.type}" for ${this.config.projectId}`
        );
    }
  }

  async reconcileAssignments(assignments: RemoteNodeTaskAssignedPayload[]): Promise<void> {
    for (const assignment of assignments) {
      this.emitAssignmentWake(assignment, "cross-node-reconcile");
    }
  }

  private async pollPendingAssignments(source: "cross-node-poll" | "cross-node-reconcile"): Promise<void> {
    try {
      const assignments = await this.client.pollPendingAssignments({
        since: this.lastAssignmentCursor ?? undefined,
      });
      for (const assignment of assignments) {
        this.emitAssignmentWake(assignment, source);
      }
    } catch (error) {
      this.emitRuntimeError(this.toError(error));
    }
  }

  private emitAssignmentWake(
    assignment: RemoteNodeTaskAssignedPayload,
    source: "cross-node-push" | "cross-node-poll" | "cross-node-reconcile"
  ): void {
    const key = `${assignment.taskId}:${assignment.agentId}:${assignment.assignedAt}`;
    if (this.seenAssignmentKeys.has(key)) {
      return;
    }
    this.seenAssignmentKeys.add(key);
    this.lastAssignmentCursor = assignment.assignedAt;
    remoteNodeLog.log(
      `[wake-trigger-diagnostics] source=${source} taskId=${assignment.taskId} agentId=${assignment.agentId}`
    );
    this.emit("task:assigned", {
      taskId: assignment.taskId,
      agentId: assignment.agentId,
      assignedAt: assignment.assignedAt,
      source,
    });
  }

  private async refreshMetrics(): Promise<RuntimeMetrics> {
    try {
      const metrics = await this.client.getMetrics();
      this.cachedMetrics = { ...metrics };
      this.lastSuccessfulMetricsAt = metrics.lastActivityAt;
      return metrics;
    } catch {
      const fallback: RuntimeMetrics = {
        inFlightTasks: 0,
        activeAgents: 0,
        lastActivityAt: this.lastSuccessfulMetricsAt,
      };
      this.cachedMetrics = fallback;
      return fallback;
    }
  }

  private setStatus(newStatus: RuntimeStatus): void {
    const previous = this.status;
    this.status = newStatus;

    if (previous !== newStatus) {
      this.emit("health-changed", {
        status: newStatus,
        previous,
      });
    }
  }

  private emitRuntimeError(error: Error): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", error);
      return;
    }

    remoteNodeLog.error(
      `Unhandled remote runtime error for ${this.config.projectId}: ${error.message}`
    );
  }

  private isShuttingDown(): boolean {
    return this.status === "stopping" || this.status === "stopped";
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);

      const onAbort = () => {
        cleanup();
        resolve();
      };

      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
