import type { Agent } from "@fusion/core";

/** A capacity lease is intentionally separate from heartbeat run accounting. */
export interface WorkflowAgentCapacityLease {
  readonly projectId: string;
  readonly agentId: string;
  readonly attemptId: string;
}

export type WorkflowAgentCapacityResult =
  | { status: "acquired"; lease: WorkflowAgentCapacityLease }
  | { status: "held"; reason: "project-capacity" | "agent-capacity" };

/** The durable AgentStore seam keeps capacity correct when engine processes scale out. */
export interface WorkflowCapacityLeaseStore {
  acquireWorkflowSessionCapacity(input: {
    agentId: string;
    attemptId: string;
    maxProjectSessions?: number;
    maxAgentSessions?: number;
    leaseDurationMs?: number;
  }): Promise<"acquired" | "project-capacity" | "agent-capacity">;
  renewWorkflowSessionCapacity?(attemptId: string, leaseDurationMs?: number): Promise<boolean>;
  releaseWorkflowSessionCapacity(attemptId: string): Promise<void>;
}

/**
 * FNXC:WorkflowAgentRouting 2026-08-07-05:52:
 * Workflow sessions use database-backed, project-scoped reservations so two
 * engines cannot admit the same slot. Heartbeat concurrency remains separate.
 * The local map is only a reentrancy cache; durable AgentStore leases are the
 * cross-process source of truth and releases are intentionally idempotent.
 */
export class WorkflowAgentCapacity {
  private static readonly LEASE_DURATION_MS = 10 * 60_000;
  private readonly leases = new Map<string, WorkflowAgentCapacityLease>();
  private readonly renewals = new Map<string, ReturnType<typeof setInterval>>();

  public constructor(private readonly leaseStore?: WorkflowCapacityLeaseStore) {}

  private attemptKey(projectId: string, attemptId: string): string {
    return `${projectId}\u0000${attemptId}`;
  }

  public async acquire(input: {
    projectId: string;
    agent: Pick<Agent, "id" | "runtimeConfig">;
    attemptId: string;
    maxProjectSessions?: number;
  }): Promise<WorkflowAgentCapacityResult> {
    const attemptKey = this.attemptKey(input.projectId, input.attemptId);
    const existing = this.leases.get(attemptKey);
    if (existing) return { status: "acquired", lease: existing };
    const agentLimit = input.agent.runtimeConfig?.maxWorkflowSessions;
    const maxAgentSessions = typeof agentLimit === "number" && Number.isFinite(agentLimit)
      ? agentLimit
      : undefined;
    if (this.leaseStore) {
      const outcome = await this.leaseStore.acquireWorkflowSessionCapacity({
        agentId: input.agent.id,
        attemptId: input.attemptId,
        maxProjectSessions: input.maxProjectSessions,
        maxAgentSessions,
        leaseDurationMs: WorkflowAgentCapacity.LEASE_DURATION_MS,
      });
      if (outcome !== "acquired") return { status: "held", reason: outcome };
    } else {
      // Unit-test/local fallback retains deterministic semantics without pretending to coordinate processes.
      const local = [...this.leases.values()].filter((lease) => lease.projectId === input.projectId);
      if (input.maxProjectSessions !== undefined && local.length >= input.maxProjectSessions) return { status: "held", reason: "project-capacity" };
      if (maxAgentSessions !== undefined && local.filter((lease) => lease.agentId === input.agent.id).length >= maxAgentSessions) return { status: "held", reason: "agent-capacity" };
    }
    const lease = { projectId: input.projectId, agentId: input.agent.id, attemptId: input.attemptId };
    this.leases.set(attemptKey, lease);
    this.startRenewal(attemptKey, input.attemptId);
    return { status: "acquired", lease };
  }

  private startRenewal(key: string, attemptId: string): void {
    if (!this.leaseStore?.renewWorkflowSessionCapacity || this.renewals.has(key)) return;
    /*
     * FNXC:WorkflowAgentRouting 2026-08-07-07:16:
     * Live model work may outlast the crash-reclaim TTL. Renew below half-life;
     * if the process dies this timer dies too and the durable row becomes safely
     * reclaimable, while a failed renewal never revives an expired attempt.
     */
    const timer = setInterval(() => {
      void this.leaseStore?.renewWorkflowSessionCapacity?.(attemptId, WorkflowAgentCapacity.LEASE_DURATION_MS)
        .catch(() => false);
    }, WorkflowAgentCapacity.LEASE_DURATION_MS / 3);
    timer.unref?.();
    this.renewals.set(key, timer);
  }

  public async release(attemptId: string, projectId?: string): Promise<boolean> {
    const key = projectId
      ? this.attemptKey(projectId, attemptId)
      : [...this.leases.entries()].find(([, lease]) => lease.attemptId === attemptId)?.[0];
    if (!key) return false;
    const lease = this.leases.get(key);
    if (!lease) return false;
    this.leases.delete(key);
    const timer = this.renewals.get(key);
    if (timer) clearInterval(timer);
    this.renewals.delete(key);
    await this.leaseStore?.releaseWorkflowSessionCapacity(attemptId);
    return true;
  }

  public activeSessions(agentId: string, projectId?: string): number {
    return [...this.leases.values()].filter((lease) => lease.agentId === agentId && (!projectId || lease.projectId === projectId)).length;
  }
}
