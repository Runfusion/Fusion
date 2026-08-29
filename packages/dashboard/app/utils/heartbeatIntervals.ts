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
