/*
FNXC:HeartbeatIdleBackoff 2026-11-01-12:05 (RUFU-268):
The idle ladder is read-side-relevant, so this file reaches the SAME pure implementation the scheduler
and the health pill use. It comes from `@fusion/core` (browser-aliased to the types leaf) rather than a
local copy: this module imports nothing else, the ladder module imports nothing, and a second copy of the
arithmetic is how one surface would keep calling an idling agent overdue while another stayed quiet.
*/
import { resolveHeartbeatSilenceBudgetMs } from "@fusion/core";

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 3_600_000;

/** Minimum heartbeat interval enforced by the dashboard (5 minutes in ms) */
export const MIN_HEARTBEAT_INTERVAL_MS = 300_000;

export const HEARTBEAT_INTERVAL_PRESETS = [
  { value: 300000, label: "5m" },
  { value: 900000, label: "15m" },
  { value: 1800000, label: "30m" },
  { value: 3600000, label: "1h" },
  { value: 10800000, label: "3h" },
  { value: 21600000, label: "6h" },
  { value: 43200000, label: "12h" },
  { value: 86400000, label: "24h" },
  { value: 172800000, label: "48h" },
  { value: 259200000, label: "72h" },
  { value: 604800000, label: "1w" },
] as const;

export function formatHeartbeatInterval(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  if (ms < 604_800_000) return `${Math.round(ms / 86_400_000)}d`;
  return `${Math.round(ms / 604_800_000)}w`;
}

export function resolveHeartbeatIntervalMs(intervalMs: unknown): number {
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs)) {
    return DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  return Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.round(intervalMs));
}

/*
FNXC:HeartbeatIdleBackoff 2026-11-01-12:05 (RUFU-268):
Every "Next heartbeat in …" / "Heartbeat overdue …" surface in the dashboard asked the same question in
four copies: last beat + the CONFIGURED interval. RUFU-268 gave the engine a reason to wait longer than
that on purpose — an idling agent's dispatch cadence doubles up to a 30-minute ceiling — so an unadjusted
anchor starts accusing an agent that is deliberately left alone, in four places at once.

One function, because four hand-copied expressions is how three of them would keep lying while the fourth
was fixed. It returns the cadence the SCHEDULER is actually holding this agent to (the configured interval
stretched by that agent's own idle step), which is the honest anchor for a promise about the next beat.
An agent that is not idling gets back exactly `resolveHeartbeatIntervalMs`, so no existing countdown moves.

Deliberately NOT the staleness threshold: the countdown stays earlier and softer than "Unresponsive"
(RUFU-176), and the grace multiplier belongs to `agentHealth.tsx` alone.
*/
export function resolveHeartbeatCadenceMs(runtimeConfig: {
  heartbeatIntervalMs?: unknown;
  heartbeatIdleStreak?: unknown;
} | undefined): number {
  return resolveHeartbeatSilenceBudgetMs({
    streak: runtimeConfig?.heartbeatIdleStreak,
    baseIntervalMs: resolveHeartbeatIntervalMs(runtimeConfig?.heartbeatIntervalMs),
  });
}

export function getHeartbeatIntervalOptions(currentIntervalMs: number): Array<{ value: number; label: string }> {
  if (HEARTBEAT_INTERVAL_PRESETS.some((preset) => preset.value === currentIntervalMs)) {
    return [...HEARTBEAT_INTERVAL_PRESETS];
  }

  const customOption = {
    value: currentIntervalMs,
    label: `${formatHeartbeatInterval(currentIntervalMs)} (custom)`,
  };

  return [...HEARTBEAT_INTERVAL_PRESETS, customOption]
    .sort((a, b) => a.value - b.value);
}
