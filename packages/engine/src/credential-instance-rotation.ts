import {
  formatProviderInstanceKey,
  parseProviderInstanceKey,
  type ProviderInstanceRef,
} from "@fusion/core";

export const CREDENTIAL_INSTANCE_COOLDOWN_MS = 15 * 60_000;

export type RotationLane = "executor-step" | "executor-agent" | "agent-heartbeat";

type InstanceSource = {
  listInstances(providerId: string): ProviderInstanceRef[] | Promise<ProviderInstanceRef[]>;
  getDefaultInstance(providerId: string): ProviderInstanceRef | undefined | Promise<ProviderInstanceRef | undefined>;
};

type RotationAudit = (type: string, metadata: Record<string, unknown>) => void | Promise<void>;
type CooldownState = ReadonlyMap<string, number>;

export interface RotationEvent {
  readonly candidateCount: number;
  next(): Promise<ProviderInstanceRef | undefined>;
  recordOutcome(outcome: "rotation-succeeded" | "rotation-failed-limit"): void;
  finishExhausted(): void;
}

/**
 * Produce the finite, round-robin candidate list for one limit event.
 * Exported independently so cooldown and ordering rules remain testable without sessions.
 */
export function createRotationPlan(
  providerId: string,
  startingInstanceId: string,
  instances: readonly ProviderInstanceRef[],
  cooldownState: CooldownState,
  now: number,
): { candidates: ProviderInstanceRef[]; skippedCooldownInstanceIds: string[] } {
  const providerInstances = instances
    .filter((ref) => ref.providerId === providerId)
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  const startIndex = providerInstances.findIndex((ref) => ref.instanceId === startingInstanceId);
  const ordered = startIndex < 0
    ? providerInstances
    : [...providerInstances.slice(startIndex + 1), ...providerInstances.slice(0, startIndex)];
  const skippedCooldownInstanceIds: string[] = [];
  const candidates = ordered.filter((ref) => {
    if (ref.instanceId === startingInstanceId) return false;
    if ((cooldownState.get(formatProviderInstanceKey(ref)) ?? 0) > now) {
      skippedCooldownInstanceIds.push(ref.instanceId);
      return false;
    }
    return true;
  });
  return { candidates, skippedCooldownInstanceIds };
}

/*
FNXC:CredentialInstanceRotation 2026-08-01-06:19:
A provider usage limit rotates to the next eligible credential instance before the existing pause and backoff fallback. Eligibility is configured inventory, not the starting instance, no active cooldown, and no earlier offer in this finite event; no provider health probe is introduced.

Providers with zero or one configured instance are an intentionally total no-op: they create no event, write no cooldown, and emit no audit rows, preserving single-instance behavior byte-for-byte. A multi-instance event with every other instance cooling down is different: it is real exhaustion and emits the fallback audit row.

The runtime owns one process-local, self-expiring cooldown map for all lanes. It is a best-effort skip hint, never persisted or a correctness gate, so a dashboard health monitor pauser without this rotator can at worst leave a candidate skipped until expiry. The finite RotationEvent is the sole boundedness authority; retry wrappers deliberately keep no candidate counter.
*/
export class CredentialInstanceRotator {
  private readonly cooldowns = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly options: {
    instanceSource: InstanceSource;
    now?: () => number;
    recordRunAuditEvent?: RotationAudit;
  }) {
    this.now = options.now ?? Date.now;
  }

  async beginEvent(input: {
    providerId: string;
    startingInstanceId: string;
    lane: RotationLane;
    taskId?: string;
    agentId?: string;
  }): Promise<RotationEvent | undefined> {
    const instances = await this.options.instanceSource.listInstances(input.providerId);
    // The inventory-size gate must precede all observable rotation state.
    if (instances.length <= 1) return undefined;

    this.pruneExpiredCooldowns();
    const { candidates, skippedCooldownInstanceIds } = createRotationPlan(
      input.providerId,
      input.startingInstanceId,
      instances,
      this.cooldowns,
      this.now(),
    );
    let nextIndex = 0;
    let lastAttempt: { ref: ProviderInstanceRef; attempt: number } | undefined;
    let exhausted = false;
    const attempted: ProviderInstanceRef[] = [];
    const audit = (type: string, metadata: Record<string, unknown>) => {
      try { void Promise.resolve(this.options.recordRunAuditEvent?.(type, metadata)).catch(() => undefined); } catch { /* audit is non-fatal */ }
    };
    const common = {
      providerId: input.providerId,
      lane: input.lane,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    };
    return {
      candidateCount: candidates.length,
      next: async () => {
        const ref = candidates[nextIndex++];
        if (!ref) return undefined;
        lastAttempt = { ref, attempt: nextIndex };
        attempted.push(ref);
        audit("credential:instance-rotation-attempt", {
          ...common, fromInstanceId: input.startingInstanceId, toInstanceId: ref.instanceId,
          attempt: nextIndex, candidateCount: candidates.length, outcome: "rotated",
        });
        return ref;
      },
      recordOutcome: (outcome) => {
        if (!lastAttempt) return;
        audit("credential:instance-rotation-outcome", {
          ...common, toInstanceId: lastAttempt.ref.instanceId, attempt: lastAttempt.attempt, outcome,
        });
        lastAttempt = undefined;
      },
      finishExhausted: () => {
        if (exhausted) return;
        exhausted = true;
        audit("credential:instance-rotation-exhausted", {
          ...common, instanceCount: instances.length, attemptedCount: attempted.length,
          attemptedInstanceIds: attempted.map((ref) => ref.instanceId), startingInstanceId: input.startingInstanceId,
          skippedCooldownCount: skippedCooldownInstanceIds.length, skippedCooldownInstanceIds,
          outcome: "fell-back-to-pause",
        });
      },
    };
  }

  markLimited(ref: ProviderInstanceRef): void {
    this.pruneExpiredCooldowns();
    this.cooldowns.set(formatProviderInstanceKey(ref), this.now() + CREDENTIAL_INSTANCE_COOLDOWN_MS);
  }

  /**
   * FNXC:CredentialInstanceRotation 2026-08-01-11:22:
   * Cooldowns are process-local hints, so planning removes elapsed entries before
   * reading them. This prevents providers that are only occasionally limited from
   * retaining stale map state, while preserving the no-op gate before any cleanup.
   */
  private pruneExpiredCooldowns(): void {
    const now = this.now();
    for (const [key, until] of this.cooldowns) {
      if (until <= now) this.cooldowns.delete(key);
    }
  }

  clearCooldowns(providerId: string): void {
    for (const key of this.cooldowns.keys()) {
      // Reuse core's grammar rather than coupling cooldown cleanup to its encoding.
      if (parseProviderInstanceKey(key)?.providerId === providerId) this.cooldowns.delete(key);
    }
  }

  isCoolingDown(ref: ProviderInstanceRef): boolean {
    const key = formatProviderInstanceKey(ref);
    const until = this.cooldowns.get(key) ?? 0;
    if (until <= this.now()) {
      this.cooldowns.delete(key);
      return false;
    }
    return true;
  }
}
