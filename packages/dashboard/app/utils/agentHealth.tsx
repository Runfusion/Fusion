import type { JSX } from "react";
import { Bot, Heart, Activity, Pause } from "lucide-react";
import type { Agent } from "../api";
import { resolveHeartbeatIntervalMs } from "./heartbeatIntervals";

// Heartbeat scheduling depends on both state and `runtimeConfig.enabled`.
// Durable agents with heartbeat disabled should render distinctly from healthy
// or merely-starting agents, while task-worker agents still follow their
// execution lifecycle regardless of the scheduler toggle.

/**
 * Grace multiplier applied to an agent's configured interval before flagging
 * it Unresponsive. We require several missed scheduled ticks before raising
 * the alarm — momentary timer jitter, an engine restart, or a single skipped
 * tick should never flip the UI to "Unresponsive".
 */
const HEARTBEAT_GRACE_MULTIPLIER = 4;

/**
 * Staleness floor. Even on an agent configured for 1s heartbeats we don't
 * want the UI flickering between Healthy/Unresponsive on every tick. Five
 * minutes is enough wall-clock buffer for any reasonable agent to recover
 * from an engine pause/resume cycle.
 */
const MIN_HEARTBEAT_STALENESS_MS = 5 * 60_000;

/** Shape of the health status returned by getAgentHealthStatus */
export interface AgentHealthStatus {
  label: string;
  icon: JSX.Element;
  color: string;
  /** True when label only mirrors agent.state and adds no extra context */
  stateDerived: boolean;
  /** Human-readable reason for the current status (e.g. "No heartbeat for 45m (threshold: 20m)") */
  reason?: string;
}

type AgentHealthInput = Pick<
  Agent,
  | "state"
  | "lastHeartbeatAt"
  | "lastError"
  | "pauseReason"
  | "runtimeConfig"
  | "metadata"
  | "name"
  | "role"
  | "taskId"
>;

/**
 * Compute the staleness threshold for an agent. Elapsed time beyond this is
 * classified as Unresponsive.
 *
 * Uses the same interval resolver as the dashboard dropdown — if the agent
 * has no explicit heartbeatIntervalMs persisted, the server-side default
 * (1h) applies — so agents that were never configured (no dropdown write)
 * and agents that were explicitly configured both get consistent treatment,
 * differing only by their scheduled cadence.
 */
function getStalenessThresholdMs(
  runtimeConfig?: Record<string, unknown>,
  heartbeatMultiplier: number = 1,
): number {
  const intervalMs = resolveHeartbeatIntervalMs(runtimeConfig?.heartbeatIntervalMs);
  const resolvedMultiplier = Number.isFinite(heartbeatMultiplier) && heartbeatMultiplier > 0
    ? heartbeatMultiplier
    : 1;

  /*
  FNXC:AgentHeartbeat 2026-07-17-00:25:
  FN-8190 requires dashboard health labels to use the project-resolved heartbeat
  multiplier exactly once. The dashboard cannot import engine timing helpers, so
  callers supply this settings value and raw persisted intervals remain the input.
  */
  const effectiveIntervalMs = Math.max(1000, Math.round(intervalMs * resolvedMultiplier));
  return Math.max(effectiveIntervalMs * HEARTBEAT_GRACE_MULTIPLIER, MIN_HEARTBEAT_STALENESS_MS);
}

/** Format milliseconds into a human-readable duration string (e.g. "5m", "1h 20m", "2h"). */
function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "<1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function isTaskWorkerAgent(agent: AgentHealthInput): boolean {
  const metadata = agent.metadata as Record<string, unknown> | null | undefined;
  if (metadata) {
    if (metadata.agentKind === "task-worker") return true;
    if (metadata.taskWorker === true) return true;
    if (metadata.managedBy === "task-executor") return true;
  }

  return Boolean(
    agent.role === "executor" &&
    agent.name?.startsWith("executor-") &&
    agent.taskId,
  );
}

/**
 * Computes a single canonical health status for an agent based on its
 * state, runtimeConfig, and last heartbeat timestamp.
 *
 * Health labels (in priority order):
 * - "Error" — agent.state === "error" (uses lastError if available)
 * - "Paused" — agent.state === "paused" (uses pauseReason if available)
 * - "Running" — agent.state === "running", or a detected task worker in "active"
 * - "Heartbeat Disabled" — durable agent with `runtimeConfig.enabled === false`
 * - "Starting..." — state === "active" && no lastHeartbeatAt
 * - "Idle" — state !== "active" && no lastHeartbeatAt
 * - "Healthy" — heartbeat is fresh within the configured interval's 4× grace window
 * - "Unresponsive" — heartbeat exceeded the configured interval's 4× grace window
 *
 * @param agent - The agent object (partial Agent shape is accepted)
 * @returns A health status object with label, icon, color, and stateDerived metadata
 */
function getHeartbeatRepairMetadata(agent: AgentHealthInput): {
  repairedAt?: string;
  staleAtRepair?: boolean;
  staleRepairReason?: string;
} {
  const metadata = agent.metadata as Record<string, unknown> | null | undefined;
  const raw = metadata?.heartbeatTimerRepair;
  if (!raw || typeof raw !== "object") return {};
  const value = raw as Record<string, unknown>;
  return {
    repairedAt: typeof value.repairedAt === "string" ? value.repairedAt : undefined,
    staleAtRepair: typeof value.staleAtRepair === "boolean" ? value.staleAtRepair : undefined,
    staleRepairReason: typeof value.staleRepairReason === "string" ? value.staleRepairReason : undefined,
  };
}

export function getAgentHealthStatus(
  agent: AgentHealthInput,
  heartbeatMultiplier: number = 1,
): AgentHealthStatus {
  const { state, lastHeartbeatAt, lastError, pauseReason, runtimeConfig } = agent;
  const isTaskWorker = isTaskWorkerAgent(agent);
  const isHeartbeatEnabled = isTaskWorker || runtimeConfig?.enabled !== false;

  // Explicit non-running states always take precedence.
  if (state === "error") {
    return {
      label: lastError ?? "Error",
      icon: <Activity size={14} />,
      color: "var(--state-error-text)",
      stateDerived: !lastError,
    };
  }

  if (state === "paused") {
    const label = pauseReason ? `Paused: ${pauseReason}` : "Paused";
    return {
      label,
      icon: <Pause size={14} />,
      color: "var(--state-paused-text)",
      stateDerived: !pauseReason,
    };
  }

  if (state === "running" || (isTaskWorker && state === "active")) {
    return {
      label: "Running",
      icon: <Activity size={14} />,
      color: "var(--state-active-text)",
      stateDerived: true,
    };
  }

  if (!isHeartbeatEnabled) {
    return {
      label: "Heartbeat Disabled",
      icon: <Pause size={14} />,
      color: "var(--state-paused-text)",
      stateDerived: false,
    };
  }

  // No heartbeat data yet
  if (!lastHeartbeatAt) {
    return {
      label: state === "active" ? "Starting..." : "Idle",
      icon: <Bot size={14} />,
      color: "var(--text-muted)",
      stateDerived: false,
    };
  }

  const heartbeatRepair = getHeartbeatRepairMetadata(agent);
  if (heartbeatRepair.staleAtRepair && heartbeatRepair.repairedAt) {
    const repairedMs = Date.parse(heartbeatRepair.repairedAt);
    const lastHeartbeatMs = Date.parse(lastHeartbeatAt);
    if (Number.isFinite(repairedMs) && Number.isFinite(lastHeartbeatMs) && lastHeartbeatMs < repairedMs) {
      return {
        label: "Unresponsive",
        icon: <Activity size={14} />,
        color: "var(--state-error-text)",
        stateDerived: false,
        reason: heartbeatRepair.staleRepairReason ?? "Heartbeat scheduler repaired a missing timer; waiting for recovery heartbeat",
      };
    }
  }

  // Every non-task-worker agent has an effective interval — either explicitly
  // configured, or the scheduler's 1h default. Compare elapsed time to that
  // interval (with grace) rather than to `heartbeatTimeoutMs`, which is the
  // per-run work budget and has nothing to do with between-tick freshness.
  const lastHeartbeat = Date.parse(lastHeartbeatAt);
  const stalenessThresholdMs = getStalenessThresholdMs(runtimeConfig, heartbeatMultiplier);

  /*
  FNXC:AgentHeartbeat 2026-07-15-18:00:
  A persisted but unparseable heartbeat cannot prove agent freshness. Treat it
  as Unresponsive rather than letting NaN bypass the elapsed-time comparison,
  matching the engine's persisted-heartbeat classification surfaces. Future
  timestamps clamp to zero so clock skew does not create a false stale label.
  */
  if (!Number.isFinite(lastHeartbeat)) {
    return {
      label: "Unresponsive",
      icon: <Activity size={14} />,
      color: "var(--state-error-text)",
      stateDerived: false,
      reason: "Last heartbeat timestamp is invalid",
    };
  }

  const elapsed = Math.max(0, Date.now() - lastHeartbeat);

  if (elapsed > stalenessThresholdMs) {
    const reason = `No heartbeat for ${formatDuration(elapsed)} (threshold: ${formatDuration(stalenessThresholdMs)})`;
    return {
      label: "Unresponsive",
      icon: <Activity size={14} />,
      color: "var(--state-error-text)",
      stateDerived: false,
      reason,
    };
  }

  return {
    label: "Healthy",
    icon: <Heart size={14} />,
    color: "var(--state-active-text)",
    stateDerived: false,
  };
}

/**
 * Returns a CSS variable name for the health color.
 * Useful when you need the raw CSS variable name for custom styling.
 */
export function getAgentHealthColorVar(agent: AgentHealthInput): string {
  const status = getAgentHealthStatus(agent);
  // Extract the CSS variable name from the color string
  // e.g., "var(--state-error-text)" -> "--state-error-text"
  const match = status.color.match(/var\((--[^)]+)\)/);
  return match ? match[1] : status.color;
}
