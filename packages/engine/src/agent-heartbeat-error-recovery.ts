/**
 * FNXC:CodeOrganization 2026-07-15-14:30:
 * Heartbeat error-recovery budget helpers peeled from agent-heartbeat.ts.
 */
import type { Agent, Settings } from "@fusion/core";
import { isEphemeralAgent } from "@fusion/core";
import {
  isStaleWorktreeModuleResolutionError,
  isOperatorActionableAgentError,
} from "./transient-error-detector.js";

export const MAX_HEARTBEAT_ERROR_RECOVERY_ATTEMPTS = 5;
export const HEARTBEAT_ERROR_RECOVERY_METADATA_KEY = "heartbeatErrorRecovery";
export const HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON = "error-retry-exhausted";
export const HEARTBEAT_ERROR_UNRECOVERABLE_PAUSE_REASON = "error-unrecoverable";
export const HEARTBEAT_MODEL_UNAVAILABLE_PAUSE_REASON = "heartbeat-model-unavailable";

/**
 * FNXC:AgentHeartbeat 2026-07-15-13:25:
 * Ephemeral task workers are driven directly by TaskExecutor and must never
 * acquire scheduler timers, which are reserved for durable agents.
 */
export function isHeartbeatManaged(agent: Agent): boolean {
  return !isEphemeralAgent(agent);
}

type HeartbeatErrorRecoveryMetadata = {
  consecutiveAttempts: number;
  updatedAt?: string;
};

export function resolveErrorRecoveryLimit(settings: Settings | null | undefined): number {
  const raw = (settings as { heartbeatErrorRecoveryAttempts?: unknown } | null | undefined)?.heartbeatErrorRecoveryAttempts;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return MAX_HEARTBEAT_ERROR_RECOVERY_ATTEMPTS;
  }
  return Math.max(1, Math.floor(raw));
}

export function readHeartbeatErrorRetryCount(agent: { metadata?: Record<string, unknown> | null }): number {
  /*
  FNXC:AgentHeartbeat 2026-07-11-22:42:
  FN-7844 requires the heartbeat timer and self-healing sweep to honor one durable-agent error-recovery budget. Read the legacy durableErrorRecovery attempt count as part of the shared budget so agents recovered by either entry path cannot receive separate retry pools.
  */
  const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
  const raw = metadata[HEARTBEAT_ERROR_RECOVERY_METADATA_KEY];
  const heartbeatCount = raw && typeof raw === "object"
    ? (raw as Record<string, unknown>).consecutiveAttempts
    : 0;
  const legacyRaw = metadata.durableErrorRecovery;
  const legacyCount = legacyRaw && typeof legacyRaw === "object"
    ? (legacyRaw as Record<string, unknown>).attempts
    : 0;
  const normalizedHeartbeatCount = typeof heartbeatCount === "number" && Number.isFinite(heartbeatCount) && heartbeatCount > 0
    ? Math.floor(heartbeatCount)
    : 0;
  const normalizedLegacyCount = typeof legacyCount === "number" && Number.isFinite(legacyCount) && legacyCount > 0
    ? Math.floor(legacyCount)
    : 0;
  return Math.max(normalizedHeartbeatCount, normalizedLegacyCount);
}

export function buildHeartbeatErrorRecoveryMetadata(agent: { metadata?: Record<string, unknown> | null }, consecutiveAttempts: number): Record<string, unknown> {
  return {
    ...(agent.metadata ?? {}),
    [HEARTBEAT_ERROR_RECOVERY_METADATA_KEY]: {
      consecutiveAttempts: Math.max(0, Math.floor(consecutiveAttempts)),
      updatedAt: new Date().toISOString(),
    } satisfies HeartbeatErrorRecoveryMetadata,
  };
}

export function incrementHeartbeatErrorRecoveryMetadata(agent: { metadata?: Record<string, unknown> | null }): Record<string, unknown> {
  return buildHeartbeatErrorRecoveryMetadata(agent, readHeartbeatErrorRetryCount(agent) + 1);
}

export function resetHeartbeatErrorRecoveryMetadata(agent: { metadata?: Record<string, unknown> | null }): Record<string, unknown> {
  const { durableErrorRecovery: _legacyDurableErrorRecovery, ...metadata } = (agent.metadata ?? {}) as Record<string, unknown>;
  return buildHeartbeatErrorRecoveryMetadata({ metadata }, 0);
}

export function isHeartbeatErrorRecoverable(agent: Pick<Agent, "lastError">): boolean {
  const lastError = agent.lastError ?? "";
  /*
  FNXC:Reliability-ErrorClassification 2026-07-12-16:09:
  FN-7878: a generic durable-agent heartbeat failure that manual Retry immediately fixes is recoverable by policy, even when it does not match curated transient patterns. Give unknown/session/spawn/stream blips the bounded heartbeat retry budget and re-park persistent failures as `error-retry-exhausted`; only operator-actionable auth/model/billing errors park immediately as `error-unrecoverable`. Stale worktree module-resolution errors stay out of naive retry recovery because self-healing has a dedicated stale-host/worktree suppression path.
  */
  return !isStaleWorktreeModuleResolutionError(lastError) && !isOperatorActionableAgentError(lastError);
}

export function isModelUnavailablePark(agent: Pick<Agent, "state" | "pauseReason">): boolean {
  /*
   * FNXC:AgentHeartbeat 2026-07-15-13:25:
   * Key on pauseReason across state transitions: startRun can flip an agent to
   * running before the recovery gate reads it, so state=paused alone would miss
   * the budgeted retry for a failed preload.
   */
  return agent.pauseReason === HEARTBEAT_MODEL_UNAVAILABLE_PAUSE_REASON
    && agent.state !== "active"
    && agent.state !== "idle";
}

/*
FNXC:HeartbeatRecovery 2026-07-15-08:50:
False-positive heartbeat-model-unavailable parks must stay on the timer path with a bounded budget. Operator-actionable lastError text (no API key / registry miss) would otherwise exclude them from isHeartbeatErrorRecoverable forever, so this park reason is an explicit second recovery admission path independent of lastError classification.
*/
export function isModelUnavailableParkRecoveryEligible(agent: Agent, limit: number): boolean {
  return isModelUnavailablePark(agent)
    && isHeartbeatManaged(agent)
    && agent.runtimeConfig?.enabled !== false
    && readHeartbeatErrorRetryCount(agent) < Math.max(1, Math.floor(limit));
}

export function isErrorRecoveryEligible(agent: Agent, limit: number): boolean {
  if (isModelUnavailableParkRecoveryEligible(agent, limit)) {
    return true;
  }
  return agent.state === "error"
    && isHeartbeatManaged(agent)
    && agent.runtimeConfig?.enabled !== false
    && isHeartbeatErrorRecoverable(agent)
    && readHeartbeatErrorRetryCount(agent) < Math.max(1, Math.floor(limit));
}
