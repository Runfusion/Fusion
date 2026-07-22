import type { CentralCore, NodeStatus } from "@fusion/core";
import { nodeHealthMonitorLog } from "../logger.js";

export interface NodeHealthMonitorOptions {
  checkIntervalMs?: number;
  onNodeRecovered?: (nodeId: string, previousStatus: NodeStatus) => Promise<void> | void;
}

export interface NodeHealthCheckSummary {
  checked: number;
  online: number;
  offline: number;
  error: number;
  connecting: number;
}

export class NodeHealthMonitor {
  private readonly checkIntervalMs: number;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastKnownStatus = new Map<string, NodeStatus>();
  private activeCheck: Promise<NodeHealthCheckSummary> | null = null;
  private readonly onNodeRecovered?: (nodeId: string, previousStatus: NodeStatus) => Promise<void> | void;

  constructor(
    private readonly centralCore: CentralCore,
    options: NodeHealthMonitorOptions = {}
  ) {
    this.checkIntervalMs = options.checkIntervalMs ?? 60_000;
    this.onNodeRecovered = options.onNodeRecovered;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    const nodes = await this.centralCore.listNodes();
    for (const node of nodes) {
      if (node.type === "remote") {
        this.lastKnownStatus.set(node.id, node.status);
      }
    }

    this.interval = setInterval(() => {
      void this.checkAllNodes();
    }, this.checkIntervalMs);

    nodeHealthMonitorLog.log(
      `NodeHealthMonitor started (${this.lastKnownStatus.size} remote nodes, interval=${this.checkIntervalMs}ms)`
    );
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    if (this.activeCheck) {
      await this.activeCheck.catch(() => {
        // Best-effort: pending check errors are already logged.
      });
    }

    nodeHealthMonitorLog.log("NodeHealthMonitor stopped");
  }

  async checkAllNodes(): Promise<NodeHealthCheckSummary> {
    if (!this.running) {
      return {
        checked: 0,
        online: 0,
        offline: 0,
        error: 0,
        connecting: 0,
      };
    }

    if (this.activeCheck) {
      return this.activeCheck;
    }

    this.activeCheck = this.runCheckAllNodes();
    try {
      return await this.activeCheck;
    } finally {
      this.activeCheck = null;
    }
  }

  getNodeHealth(nodeId: string): NodeStatus | undefined {
    return this.lastKnownStatus.get(nodeId);
  }

  private async runCheckAllNodes(): Promise<NodeHealthCheckSummary> {
    const nodes = await this.centralCore.listNodes();
    const remoteNodes = nodes.filter((node) => node.type === "remote");

    if (remoteNodes.length === 0) {
      return {
        checked: 0,
        online: 0,
        offline: 0,
        error: 0,
        connecting: 0,
      };
    }

    const summary: NodeHealthCheckSummary = {
      checked: 0,
      online: 0,
      offline: 0,
      error: 0,
      connecting: 0,
    };

    for (const node of remoteNodes) {
      try {
        const previousStatus = this.lastKnownStatus.get(node.id) ?? node.status;
        const nextStatus = await this.centralCore.checkNodeHealth(node.id);

        this.lastKnownStatus.set(node.id, nextStatus);
        summary.checked += 1;
        summary[nextStatus] += 1;

        if (previousStatus !== nextStatus) {
          if (previousStatus === "online" && (nextStatus === "offline" || nextStatus === "error")) {
            nodeHealthMonitorLog.warn(
              `Remote node ${node.name} (${node.id}) degraded: ${previousStatus} → ${nextStatus}`
            );
          } else if (previousStatus !== "online" && nextStatus === "online") {
            nodeHealthMonitorLog.log(
              `Remote node ${node.name} (${node.id}) recovered: ${previousStatus} → online`
            );
            if (this.onNodeRecovered) {
              await this.onNodeRecovered(node.id, previousStatus);
            }
          }
        }
      } catch (error) {
        this.lastKnownStatus.set(node.id, "error");
        summary.checked += 1;
        summary.error += 1;
        nodeHealthMonitorLog.warn(
          `Failed to check node ${node.name} (${node.id}) health: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    return summary;
  }
}
