import type { JSX } from "react";
import { Bot, Heart, Activity, Pause, Square } from "lucide-react";
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
function getStalenessThresholdMs(runtimeConfig?: Record<string, unknown>): number {
  const intervalMs = resolveHeartbeatIntervalMs(runtimeConfig?.heartbeatIntervalMs);
  return Math.max(intervalMs * HEARTBEAT_GRACE_MULTIPLIER, MIN_HEARTBEAT_STALENESS_MS);
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
 * - "Terminated" — agent.state === "terminated"
 * - "Error" — agent.state === "error" (uses lastError if available)
 * - "Paused" — agent.state === "paused" (uses pauseReason if available)
 * - "Running" — agent.state === "running", or a detected task worker in "active"
 * - "Heartbeat Disabled" — durable agent with `runtimeConfig.enabled === false`
 * - "Starting..." — state === "active" && no lastHeartbeatAt
 * - "Idle" — state !== "active" && no lastHeartbeatAt
 * - "Healthy" — heartbeat is fresh within 2× the configured interval
 * - "Unresponsive" — heartbeat exceeded 2× the configured interval
 *
 * @param agent - The agent object (partial Agent shape is accepted)
 * @returns A health status object with label, icon, color, and stateDerived metadata
 */
export function getAgentHealthStatus(agent: AgentHealthInput): AgentHealthStatus {
  const { state, lastHeartbeatAt, lastError, pauseReason, runtimeConfig } = agent;
  const isTaskWorker = isTaskWorkerAgent(agent);
  const isHeartbeatEnabled = isTaskWorker || runtimeConfig?.enabled !== false;

  // Terminal states - these always take precedence
  if (state === "terminated") {
    return {
      label: "Terminated",
      icon: <Square size={14} />,
      color: "var(--state-error-text)",
      stateDerived: true,
    };
  }

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
      color: "var(--text-secondary)",
      stateDerived: false,
    };
  }

  // Every non-task-worker agent has an effective interval — either explicitly
  // configured, or the scheduler's 1h default. Compare elapsed time to that
  // interval (with grace) rather than to `heartbeatTimeoutMs`, which is the
  // per-run work budget and has nothing to do with between-tick freshness.
  const lastHeartbeat = new Date(lastHeartbeatAt).getTime();
  const elapsed = Date.now() - lastHeartbeat;
  const stalenessThresholdMs = getStalenessThresholdMs(runtimeConfig);

  if (elapsed > stalenessThresholdMs) {
    return {
      label: "Unresponsive",
      icon: <Activity size={14} />,
      color: "var(--state-error-text)",
      stateDerived: false,
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
