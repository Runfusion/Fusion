import type {
  AgentStore,
  CentralClaimStore,
  OwningNodeHandoffPolicy,
  RunMutationContext,
  Task,
  TaskStore,
} from "@fusion/core";
import type { NodeHealthMonitor } from "./node-health-monitor.js";
import { decideOwningNodeHandoff } from "./node-routing-policy.js";
import { createLogger } from "../logger.js";
import { createRunAuditor, generateSyntheticRunId } from "../util/run-audit.js";

const meshLeaseManagerLog = createLogger("mesh-lease-manager");

export interface MeshLeaseManagerOptions {
  taskStore: TaskStore;
  agentStore?: AgentStore;
  nodeHealthMonitor?: NodeHealthMonitor;
  getExecutingTaskIds?: () => Set<string>;
  localNodeId?: string;
  getHandoffPolicy?: () => Promise<OwningNodeHandoffPolicy | undefined>;
  centralClaimStore?: CentralClaimStore;
  projectId?: string;
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

  private createAuditor(task: Task) {
    return createRunAuditor(this.options.taskStore, {
      runId: generateSyntheticRunId("mesh-lease", task.id),
      agentId: "mesh-lease-manager",
      taskId: task.id,
      taskLineageId: task.lineageId,
      phase: "recover-unreachable-owner-lease",
    });
  }

  private async emitLeaseAudit(
    task: Task,
    type:
      | "task:auto-recover-lease-released"
      | "task:auto-recover-lease-already-healed"
      | "task:auto-recover-lease-foreign-owner"
      | "task:auto-recover-lease-central-unavailable"
      | "task:auto-recover-lease-partial-write"
      | "task:auto-recover-lease-reconciled",
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.createAuditor(task).database({
        type,
        target: task.id,
        metadata: {
          taskId: task.id,
          projectId: this.options.projectId ?? null,
          ...metadata,
        },
      });
    } catch (error) {
      meshLeaseManagerLog.warn(
        `mesh-lease: failed to emit ${type} for taskId=${task.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async clearLocalLease(task: Task, reason: string, context: LeaseRecoveryContext, nextEpoch: number): Promise<void> {
    await this.options.taskStore.updateTask(
      task.id,
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
      task.id,
      "Recovered abandoned lease",
      `${reason}; epoch=${nextEpoch}`,
      context.runContext,
    );
    if (task.column !== "todo") {
      await this.options.taskStore.moveTask(task.id, "todo", {
        preserveProgress:
          context.preserveProgress ??
          (task.currentStep > 0 || task.steps.some((step) => step.status !== "pending")),
      });
    }
  }

  private async releaseCentralClaim(task: Task, reason: string, nextEpoch: number): Promise<"released" | "already-healed" | "foreign-owner" | "unavailable"> {
    const { centralClaimStore, projectId } = this.options;
    if (!centralClaimStore || !projectId || !task.checkedOutBy || !task.checkoutNodeId) {
      return "released";
    }

    const tryRelease = () =>
      centralClaimStore.releaseTaskClaim({
        projectId,
        taskId: task.id,
        nodeId: task.checkoutNodeId!,
        agentId: task.checkedOutBy!,
      });

    try {
      const released = await tryRelease();
      if (released.ok) {
        return "released";
      }
      if (released.reason === "not_found") {
        await this.emitLeaseAudit(task, "task:auto-recover-lease-already-healed", {
          priorEpoch: task.checkoutLeaseEpoch ?? 0,
          nextEpoch,
          reason,
        });
        return "already-healed";
      }
      await this.emitLeaseAudit(task, "task:auto-recover-lease-foreign-owner", {
        priorEpoch: task.checkoutLeaseEpoch ?? 0,
        nextEpoch,
        reason,
        centralOwnerNodeId: released.current?.ownerNodeId ?? null,
        centralOwnerAgentId: released.current?.ownerAgentId ?? null,
        centralOwnerRunId: released.current?.ownerRunId ?? null,
        centralLeaseEpoch: released.current?.leaseEpoch ?? null,
      });
      return "foreign-owner";
    } catch (_error) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      try {
        const released = await tryRelease();
        if (released.ok) {
          return "released";
        }
        if (released.reason === "not_found") {
          await this.emitLeaseAudit(task, "task:auto-recover-lease-already-healed", {
            priorEpoch: task.checkoutLeaseEpoch ?? 0,
            nextEpoch,
            reason,
          });
          return "already-healed";
        }
        await this.emitLeaseAudit(task, "task:auto-recover-lease-foreign-owner", {
          priorEpoch: task.checkoutLeaseEpoch ?? 0,
          nextEpoch,
          reason,
          centralOwnerNodeId: released.current?.ownerNodeId ?? null,
          centralOwnerAgentId: released.current?.ownerAgentId ?? null,
          centralOwnerRunId: released.current?.ownerRunId ?? null,
          centralLeaseEpoch: released.current?.leaseEpoch ?? null,
        });
        return "foreign-owner";
      } catch (retryError) {
        await this.emitLeaseAudit(task, "task:auto-recover-lease-central-unavailable", {
          priorEpoch: task.checkoutLeaseEpoch ?? 0,
          nextEpoch,
          reason,
          error: retryError instanceof Error ? retryError.message : String(retryError),
        });
        meshLeaseManagerLog.warn(
          `mesh-lease: central release unavailable for taskId=${task.id}: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
        );
        return "unavailable";
      }
    }
  }

  async reconcileLeaseRow(taskId: string): Promise<boolean> {
    const task = await this.options.taskStore.getTask(taskId);
    const { centralClaimStore, projectId } = this.options;
    if (!task || !centralClaimStore || !projectId) {
      return false;
    }

    const claim = await centralClaimStore.getTaskClaim(projectId, taskId);
    const localHasOwner = Boolean(task.checkedOutBy || task.checkoutNodeId);

    if (!claim && localHasOwner) {
      const nextEpoch = (task.checkoutLeaseEpoch ?? 0) + 1;
      await this.options.taskStore.updateTask(task.id, {
        checkedOutBy: null,
        checkedOutAt: null,
        checkoutNodeId: null,
        checkoutRunId: null,
        checkoutLeaseRenewedAt: null,
        checkoutLeaseEpoch: nextEpoch,
      });
      await this.emitLeaseAudit(task, "task:auto-recover-lease-reconciled", {
        direction: "central-cleared->local-cleared",
        priorEpoch: task.checkoutLeaseEpoch ?? 0,
        nextEpoch,
      });
      return true;
    }

    if (claim && !localHasOwner) {
      const status = this.options.nodeHealthMonitor?.getNodeHealth(claim.ownerNodeId);
      const staleCutoff = this.staleThresholdMs();
      const renewedAtMs = Date.parse(claim.leaseRenewedAt);
      const staleByTime = Number.isFinite(renewedAtMs) && Date.now() - renewedAtMs > staleCutoff;
      if (status === "offline" || status === "error" || staleByTime) {
        const released = await centralClaimStore.releaseTaskClaim({
          projectId,
          taskId,
          nodeId: claim.ownerNodeId,
          agentId: claim.ownerAgentId,
        });
        if (released.ok || released.reason === "not_found") {
          await this.emitLeaseAudit(task, "task:auto-recover-lease-reconciled", {
            direction: "local-cleared->central-cleared",
            priorEpoch: task.checkoutLeaseEpoch ?? 0,
            nextEpoch: task.checkoutLeaseEpoch ?? 0,
            staleByTime,
            ownerNodeHealth: status ?? null,
          });
          return true;
        }
      }
      return false;
    }

    if (!claim && !localHasOwner) {
      return true;
    }

    if (
      claim &&
      task.checkedOutBy === claim.ownerAgentId &&
      task.checkoutNodeId === claim.ownerNodeId &&
      (task.checkoutLeaseEpoch ?? 0) === claim.leaseEpoch
    ) {
      return true;
    }

    await this.emitLeaseAudit(task, "task:auto-recover-lease-foreign-owner", {
      priorEpoch: task.checkoutLeaseEpoch ?? 0,
      nextEpoch: task.checkoutLeaseEpoch ?? 0,
      reason: "split-brain-owner-mismatch",
      centralOwnerNodeId: claim?.ownerNodeId ?? null,
      centralOwnerAgentId: claim?.ownerAgentId ?? null,
      centralLeaseEpoch: claim?.leaseEpoch ?? null,
      localOwnerNodeId: task.checkoutNodeId ?? null,
      localOwnerAgentId: task.checkedOutBy ?? null,
    });
    return false;
  }

  async recoverAbandonedLease(taskId: string, reason: string, context: LeaseRecoveryContext = {}): Promise<boolean> {
    const task = await this.options.taskStore.getTask(taskId);
    if (!task) return false;

    const stale = await this.isLeaseRecoverable(task);
    if (!stale.recoverable) {
      return false;
    }

    const isUnreachableOwnerReason = stale.reason === "owner_node_offline" || stale.reason === "owner_node_error";
    const ownerNodeId = task.checkoutNodeId;
    const localNodeId = this.options.localNodeId ?? "local";
    const preRecoveryOwnerHealth =
      task.checkoutNodeId && this.options.nodeHealthMonitor
        ? this.options.nodeHealthMonitor.getNodeHealth(task.checkoutNodeId)
        : undefined;
    const normalizedOwnerNodeHealth =
      preRecoveryOwnerHealth === "offline" || preRecoveryOwnerHealth === "error" || preRecoveryOwnerHealth === "online"
        ? preRecoveryOwnerHealth
        : "unknown";
    const ownerNodeHealth = stale.reason === "owner_node_error" ? "error" : "offline";
    const previousOwnerAgentId = task.checkedOutBy;
    const previousColumn = task.column;
    const auditor = this.createAuditor(task);

    const emitNodeUnreachableRecovery = async ({
      decisionPath,
      newColumn,
      leaseEpoch,
      recoveryReason,
      handoffPolicy,
      handoffAction,
      handoffReason,
    }: {
      decisionPath: "lease-parked-by-handoff-policy" | "lease-recovered-in-place" | "lease-recovered-to-todo";
      newColumn: string;
      leaseEpoch: number;
      recoveryReason: string;
      handoffPolicy: OwningNodeHandoffPolicy | undefined;
      handoffAction: string;
      handoffReason: string;
    }): Promise<void> => {
      if (!isUnreachableOwnerReason || !ownerNodeId) {
        return;
      }
      try {
        await auditor.database({
          type: "task:auto-recover-node-unreachable",
          target: taskId,
          metadata: {
            ownerNodeId,
            ownerNodeHealth,
            previousOwnerAgentId,
            previousColumn,
            newColumn,
            leaseEpoch,
            recoveryReason,
            handoffPolicy,
            handoffAction,
            handoffReason,
            decisionPath,
          },
        });
      } catch (error) {
        meshLeaseManagerLog.warn(
          `mesh-lease: failed to emit node-unreachable auto-recovery audit for taskId=${task.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    let handoffPolicy: OwningNodeHandoffPolicy | undefined;
    let handoffAction = "reassign-to-local";
    let handoffReason = "stale_lease";
    if (isUnreachableOwnerReason && task.checkoutNodeId && this.options.nodeHealthMonitor) {
      const currentOwnerNodeHealth = this.options.nodeHealthMonitor.getNodeHealth(task.checkoutNodeId);
      handoffPolicy = await this.options.getHandoffPolicy?.();
      const handoffDecision = decideOwningNodeHandoff({
        task,
        ownerNodeId: task.checkoutNodeId,
        ownerNodeHealth: currentOwnerNodeHealth,
        localNodeId,
        handoffPolicy,
      });
      handoffAction = handoffDecision.action;
      handoffReason = handoffDecision.reason;

      if (handoffDecision.action === "park") {
        await emitNodeUnreachableRecovery({
          decisionPath: "lease-parked-by-handoff-policy",
          newColumn: task.column,
          leaseEpoch: task.checkoutLeaseEpoch ?? 0,
          recoveryReason: "handoff-policy-park",
          handoffPolicy,
          handoffAction: handoffDecision.action,
          handoffReason: handoffDecision.reason,
        });
        meshLeaseManagerLog.log(`mesh-lease: handoff parked taskId=${task.id} reason=${handoffDecision.reason}`);
        try {
          await this.options.taskStore.recordRunAuditEvent?.({
            taskId: task.id,
            agentId: "mesh-lease-manager",
            runId: generateSyntheticRunId("mesh-lease", task.id),
            domain: "database",
            mutationType: "node:handoff:parked",
            target: task.id,
            metadata: {
              taskId: task.id,
              ownerNodeId,
              ownerNodeHealth:
                currentOwnerNodeHealth === "offline" ||
                currentOwnerNodeHealth === "error" ||
                currentOwnerNodeHealth === "online"
                  ? currentOwnerNodeHealth
                  : "unknown",
              localNodeId,
              handoffPolicy,
              decisionReason: handoffDecision.reason,
              source: "mesh-lease.recover",
              recoveryReason: reason,
            },
          });
        } catch (error) {
          meshLeaseManagerLog.warn(`mesh-lease: failed to emit node:handoff:parked for taskId=${task.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
        return false;
      }
    }

    // FN-4823/FN-4819 §2.5: without central claim store, retain local-only recovery behavior.
    const nextEpoch = (task.checkoutLeaseEpoch ?? 0) + 1;
    let centralResult: "released" | "already-healed" | "foreign-owner" | "unavailable" = "released";
    if (this.options.centralClaimStore && this.options.projectId) {
      centralResult = await this.releaseCentralClaim(task, `${reason} (${stale.reason ?? "stale"})`, nextEpoch);
      if (centralResult === "foreign-owner" || centralResult === "unavailable") {
        return false;
      }
    }

    try {
      await this.clearLocalLease(task, `${reason} (${stale.reason ?? "stale"})`, context, nextEpoch);
    } catch (_error) {
      try {
        await this.clearLocalLease(task, `${reason} (${stale.reason ?? "stale"})`, context, nextEpoch);
      } catch (retryError) {
        if (this.options.centralClaimStore && this.options.projectId) {
          await this.emitLeaseAudit(task, "task:auto-recover-lease-partial-write", {
            priorEpoch: task.checkoutLeaseEpoch ?? 0,
            nextEpoch,
            reason,
            error: retryError instanceof Error ? retryError.message : String(retryError),
          });
        }
        return false;
      }
    }

    if (this.options.centralClaimStore && this.options.projectId && centralResult === "released") {
      await this.emitLeaseAudit(task, "task:auto-recover-lease-released", {
        priorOwnerNodeId: task.checkoutNodeId ?? null,
        priorOwnerAgentId: task.checkedOutBy ?? null,
        priorEpoch: task.checkoutLeaseEpoch ?? 0,
        nextEpoch,
        reason,
        handoffAction,
        handoffReason,
      });
    }

    try {
      await this.options.taskStore.recordRunAuditEvent?.({
        taskId: task.id,
        agentId: "mesh-lease-manager",
        runId: generateSyntheticRunId("mesh-lease", task.id),
        domain: "database",
        mutationType: "node:lease:recovered",
        target: task.id,
        metadata: {
          taskId: task.id,
          ownerNodeId,
          ownerNodeHealth: normalizedOwnerNodeHealth,
          localNodeId,
          handoffPolicy,
          decisionReason: handoffReason,
          source: "mesh-lease.recover",
          epoch: nextEpoch,
          recoveryReason: `${reason} (${stale.reason ?? "stale"})`,
        },
      });
    } catch (error) {
      meshLeaseManagerLog.warn(`mesh-lease: failed to emit node:lease:recovered for taskId=${task.id}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (isUnreachableOwnerReason) {
      await emitNodeUnreachableRecovery({
        decisionPath: task.column === "todo" ? "lease-recovered-in-place" : "lease-recovered-to-todo",
        newColumn: task.column === "todo" ? task.column : "todo",
        leaseEpoch: nextEpoch,
        recoveryReason: reason,
        handoffPolicy,
        handoffAction,
        handoffReason,
      });
    }
    return true;
  }
}
