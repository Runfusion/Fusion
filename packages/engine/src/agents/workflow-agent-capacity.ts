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

  /**
   * FNXC:WorkflowAgentRouting 2026-08-11-09:12:
   * Workflow principals have NO execution cap. Admission always succeeds; the lease is taken purely as
   * bookkeeping — it is what `activeSessions` counts and what the renewal timer keeps warm — never as a
   * gate.
   *
   * Why the caps went away: the workflow roles (triage, executor, reviewer, merger) stand in for STAGES,
   * not for workers, and there are typically one of each. Capping their concurrent sessions therefore
   * capped the whole board — a project with a single Workflow Executor serialized every implementation
   * task behind one session regardless of what `maxConcurrent`/`maxWorktrees` allowed. The refusal was
   * also invisible: it surfaced as a durable `held` row reading
   * `workflow-principal-agent-capacity:executor`, and until the FN reclaim sweep shipped alongside this
   * change, nothing re-polled a `held` row at all. Task parallelism is already bounded where it belongs
   * (worktree + concurrency admission on the task itself); a second bound at the principal was pure
   * serialization with no safety value.
   *
   * `maxProjectSessions` is deliberately REMOVED from the input rather than defaulted to undefined, so a
   * caller cannot silently reintroduce the cap without first deleting this contract.
   * `runtimeConfig.maxWorkflowSessions` is likewise no longer consulted, here or in
   * `routeWorkflowPrincipal`'s availability test.
   */
  public async acquire(input: {
    projectId: string;
    agent: Pick<Agent, "id" | "runtimeConfig">;
    attemptId: string;
  }): Promise<WorkflowAgentCapacityResult> {
    const attemptKey = this.attemptKey(input.projectId, input.attemptId);
    const existing = this.leases.get(attemptKey);
    if (existing) return { status: "acquired", lease: existing };
    if (this.leaseStore) {
      /*
      FNXC:WorkflowAgentRouting 2026-08-11-09:12:
      No limits are passed, so the durable store records the lease and returns "acquired". The store
      KEEPS its limit parameters: they remain the correct cross-process gate for a caller that genuinely
      needs one, and the reclaim of expired rows there is still what frees leases after a crash.
      */
      const outcome = await this.leaseStore.acquireWorkflowSessionCapacity({
        agentId: input.agent.id,
        attemptId: input.attemptId,
        leaseDurationMs: WorkflowAgentCapacity.LEASE_DURATION_MS,
      });
      if (outcome !== "acquired") return { status: "held", reason: outcome };
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
