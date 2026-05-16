import type {
  AgentStore,
  OwningNodeHandoffPolicy,
  RunMutationContext,
  Task,
  TaskStore,
} from "@fusion/core";
import type { NodeHealthMonitor } from "./node-health-monitor.js";
import { decideOwningNodeHandoff } from "./node-routing-policy.js";
import { createLogger } from "./logger.js";

const meshLeaseManagerLog = createLogger("mesh-lease-manager");

export interface MeshLeaseManagerOptions {
  taskStore: TaskStore;
  agentStore?: AgentStore;
  nodeHealthMonitor?: NodeHealthMonitor;
  getExecutingTaskIds?: () => Set<string>;
  localNodeId?: string;
  getHandoffPolicy?: () => Promise<OwningNodeHandoffPolicy | undefined>;
}

export interface LeaseRecoveryContext {
  runContext?: RunMutationContext;
  preserveProgress?: boolean;
}

export class MeshLeaseManager {
  constructor(private readonly options: MeshLeaseManagerOptions) {}

  private staleThresholdMs(agentHeartbeatTimeoutMs?: number): number {
    return Math.max((agentHeartbeatTimeoutMs ?? 60_000) * 2, 120_000);
  }

  async isLeaseRecoverable(task: Task, now = Date.now()): Promise<{ recoverable: boolean; reason?: string }> {
    if (!task.checkedOutBy) {
      return { recoverable: false, reason: "no_lease" };
    }

    if (this.options.getExecutingTaskIds?.().has(task.id)) {
      return { recoverable: false, reason: "active_local_execution" };
    }

    if (task.checkoutNodeId && this.options.nodeHealthMonitor) {
      const status = this.options.nodeHealthMonitor.getNodeHealth(task.checkoutNodeId);
      if (status === "offline" || status === "error") {
        return { recoverable: true, reason: `owner_node_${status}` };
      }
    }

    const renewedAtIso = task.checkoutLeaseRenewedAt ?? task.checkedOutAt;
    if (!renewedAtIso) {
      return { recoverable: false, reason: "lease_never_renewed" };
    }

    let heartbeatTimeoutMs = 60_000;
    let ownerLastHeartbeatAt: string | undefined;
    if (this.options.agentStore && task.checkedOutBy) {
      const owner = await this.options.agentStore.getAgent(task.checkedOutBy);
      if (owner?.runtimeConfig && typeof owner.runtimeConfig.heartbeatTimeoutMs === "number") {
        heartbeatTimeoutMs = owner.runtimeConfig.heartbeatTimeoutMs;
      }
      ownerLastHeartbeatAt = owner?.lastHeartbeatAt;
    }

    const staleMs = this.staleThresholdMs(heartbeatTimeoutMs);
    const renewedAtMs = Date.parse(renewedAtIso);
    if (!Number.isFinite(renewedAtMs) || now - renewedAtMs < staleMs) {
      return { recoverable: false, reason: "lease_not_stale" };
    }

    if (!ownerLastHeartbeatAt) {
      return { recoverable: true, reason: "owner_heartbeat_missing" };
    }

    const ownerHeartbeatMs = Date.parse(ownerLastHeartbeatAt);
    if (!Number.isFinite(ownerHeartbeatMs) || now - ownerHeartbeatMs >= staleMs) {
      return { recoverable: true, reason: "owner_heartbeat_stale" };
    }

    return { recoverable: false, reason: "owner_heartbeat_fresh" };
  }

  async recoverAbandonedLease(taskId: string, reason: string, context: LeaseRecoveryContext = {}): Promise<boolean> {
    const task = await this.options.taskStore.getTask(taskId);
    if (!task) return false;

    const stale = await this.isLeaseRecoverable(task);
    if (!stale.recoverable) {
      return false;
    }

    if ((stale.reason === "owner_node_offline" || stale.reason === "owner_node_error")
      && task.checkoutNodeId
      && this.options.nodeHealthMonitor) {
      const ownerNodeHealth = this.options.nodeHealthMonitor.getNodeHealth(task.checkoutNodeId);
      const handoffPolicy = await this.options.getHandoffPolicy?.();
      const handoffDecision = decideOwningNodeHandoff({
        task,
        ownerNodeId: task.checkoutNodeId,
        ownerNodeHealth,
        localNodeId: this.options.localNodeId ?? "local",
        handoffPolicy,
      });

      if (handoffDecision.action === "park") {
        meshLeaseManagerLog.log(
          `mesh-lease: handoff parked taskId=${task.id} reason=${handoffDecision.reason}`,
        );
        return false;
      }
    }

    const nextEpoch = (task.checkoutLeaseEpoch ?? 0) + 1;
    await this.options.taskStore.updateTask(
      taskId,
      {
        checkedOutBy: null,
        checkedOutAt: null,
        checkoutNodeId: null,
        checkoutRunId: null,
        checkoutLeaseRenewedAt: null,
        checkoutLeaseEpoch: nextEpoch,
      },
      context.runContext,
    );
    await this.options.taskStore.logEntry(
      taskId,
      "Recovered abandoned lease",
      `${reason} (${stale.reason ?? "stale"}); epoch=${nextEpoch}`,
      context.runContext,
    );
    if (task.column !== "todo") {
      await this.options.taskStore.moveTask(taskId, "todo", {
        preserveProgress: context.preserveProgress ?? (task.currentStep > 0 || task.steps.some((step) => step.status !== "pending")),
      });
    }
    return true;
  }
}
