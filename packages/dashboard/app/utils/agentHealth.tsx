import type { JSX } from "react";
import { Bot, Heart, Activity, Pause, Square } from "lucide-react";
import type { Agent, AgentState } from "../api";

/** Default heartbeat timeout when not configured per-agent */
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;

/** Shape of the health status returned by getAgentHealthStatus */
export interface AgentHealthStatus {
  label: string;
  icon: JSX.Element;
  color: string;
}

/**
 * Extract the heartbeat timeout from agent runtimeConfig.
 * Returns undefined if not set or if monitoring is disabled.
 */
function getHeartbeatTimeoutMs(runtimeConfig?: Record<string, unknown>): number | undefined {
  if (!runtimeConfig) return undefined;
  if (runtimeConfig.enabled === false) return undefined;
  if (typeof runtimeConfig.heartbeatTimeoutMs !== "number") return undefined;
  return runtimeConfig.heartbeatTimeoutMs;
}

/**
 * Determines if heartbeat monitoring is enabled for the agent.
 * Returns false if runtimeConfig.enabled === false, true otherwise.
 */
function isHeartbeatEnabled(runtimeConfig?: Record<string, unknown>): boolean {
  if (!runtimeConfig) return true;
  if (typeof runtimeConfig.enabled === "boolean") return runtimeConfig.enabled;
  return true;
}

/**
 * Computes a single canonical health status for an agent based on its
 * state, runtimeConfig, and last heartbeat timestamp.
 *
 * Health labels (in priority order):
 * - "Terminated" — agent.state === "terminated"
 * - "Error" — agent.state === "error" (uses lastError if available)
 * - "Paused" — agent.state === "paused" (uses pauseReason if available)
 * - "Running" — agent.state === "running"
 * - "Disabled" — runtimeConfig.enabled === false
 * - "Starting..." — state === "active" && no lastHeartbeatAt
 * - "Idle" — state !== "active" && no lastHeartbeatAt
 * - "Healthy" — heartbeat is fresh within the configured timeout
 * - "Unresponsive" — heartbeat exceeded the configured timeout
 *
 * @param agent - The agent object (partial Agent shape is accepted)
 * @returns A health status object with label, icon, and color
 */
export function getAgentHealthStatus(agent: Pick<Agent, "state" | "lastHeartbeatAt" | "lastError" | "pauseReason" | "runtimeConfig">): AgentHealthStatus {
  const { state, lastHeartbeatAt, lastError, pauseReason, runtimeConfig } = agent;

  // Terminal states - these always take precedence
  if (state === "terminated") {
    return {
      label: "Terminated",
      icon: <Square size={14} />,
      color: "var(--state-error-text)",
    };
  }

  if (state === "error") {
    return {
      label: lastError ?? "Error",
      icon: <Activity size={14} />,
      color: "var(--state-error-text)",
    };
  }

  if (state === "paused") {
    const label = pauseReason ? `Paused: ${pauseReason}` : "Paused";
    return {
      label,
      icon: <Pause size={14} />,
      color: "var(--state-paused-text)",
    };
  }

  if (state === "running") {
    return {
      label: "Running",
      icon: <Activity size={14} />,
      color: "var(--state-active-text)",
    };
  }

  // Check if heartbeat monitoring is enabled
  if (!isHeartbeatEnabled(runtimeConfig)) {
    return {
      label: "Disabled",
      icon: <Bot size={14} />,
      color: "var(--text-secondary)",
    };
  }

  // No heartbeat data yet
  if (!lastHeartbeatAt) {
    return {
      label: state === "active" ? "Starting..." : "Idle",
      icon: <Bot size={14} />,
      color: "var(--text-secondary)",
    };
  }

  // Compute elapsed time since last heartbeat
  const lastHeartbeat = new Date(lastHeartbeatAt).getTime();
  const elapsed = Date.now() - lastHeartbeat;
  const timeoutMs = getHeartbeatTimeoutMs(runtimeConfig) ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;

  if (elapsed > timeoutMs) {
    return {
      label: "Unresponsive",
      icon: <Activity size={14} />,
      color: "var(--state-error-text)",
    };
  }

  return {
    label: "Healthy",
    icon: <Heart size={14} />,
    color: "var(--state-active-text)",
  };
}

/**
 * Returns a CSS variable name for the health color.
 * Useful when you need the raw CSS variable name for custom styling.
 */
export function getAgentHealthColorVar(agent: Pick<Agent, "state" | "lastHeartbeatAt" | "lastError" | "pauseReason" | "runtimeConfig">): string {
  const status = getAgentHealthStatus(agent);
  // Extract the CSS variable name from the color string
  // e.g., "var(--state-error-text)" -> "--state-error-text"
  const match = status.color.match(/var\((--[^)]+)\)/);
  return match ? match[1] : status.color;
}
