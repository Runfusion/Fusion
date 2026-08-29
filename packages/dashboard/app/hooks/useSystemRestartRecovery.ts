import { useSyncExternalStore } from "react";
import { fetchDashboardHealth, fetchSystemInfo } from "../api";

export type RestartRecoveryState = { phase: "idle" | "waiting" | "back" | "timeout"; version?: string };
type Listener = () => void;
type Attempt = { generation: number; version: string; priorPid?: number; deadline: number; expired?: boolean };
const listeners = new Set<Listener>();
let state: RestartRecoveryState = { phase: "idle" };
let attempt: Attempt | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
let polling = false;
let reloadRequested = false;
const POLL_MS = 1500;
const TIMEOUT_MS = 90_000;

function publish(next: RestartRecoveryState) { state = next; listeners.forEach((listener) => listener()); }
function clearTimers() {
  if (pollTimer) clearTimeout(pollTimer);
  if (deadlineTimer) clearTimeout(deadlineTimer);
  pollTimer = undefined;
  deadlineTimer = undefined;
}

/*
FNXC:UpdateRestartRecovery 2026-08-21-03:28:
The recovery deadline is independent of readiness transports. A hung request must
terminalize the old generation at 90 seconds, and late replies cannot reload it.
*/
function expire(expectedGeneration: number): void {
  const live = attempt;
  if (!live || live.generation !== expectedGeneration || live.expired) return;
  live.expired = true;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = undefined;
  deadlineTimer = undefined;
  publish({ phase: "timeout", version: live.version });
}
function isReady(health: Awaited<ReturnType<typeof fetchDashboardHealth>>, version: string) {
  return health.version === version && health.holding !== true && health.status !== "starting" && health.status !== "migrating";
}

/**
 * FNXC:UpdateRestartRecovery 2026-08-21-02:48:
 * Update restarts outlive their initiating component. A stale page may reload only
 * after the replacement host reports the installed version, non-holding health,
 * and a changed PID when the old process identity was available.
 */
export const systemRestartRecovery = {
  arm(version: string, priorPid?: number) {
    const nextGeneration = (attempt?.generation ?? 0) + 1;
    clearTimers();
    attempt = { generation: nextGeneration, version, priorPid, deadline: Date.now() + TIMEOUT_MS };
    reloadRequested = false;
    publish({ phase: "waiting", version });
    deadlineTimer = setTimeout(() => expire(nextGeneration), TIMEOUT_MS);
    void poll(nextGeneration);
  },
  retry() { if (state.version) this.arm(state.version, attempt?.priorPid); },
  subscribe(listener: Listener) { listeners.add(listener); return () => listeners.delete(listener); },
  getSnapshot: () => state,
};

async function poll(expectedGeneration: number): Promise<void> {
  const current = attempt;
  if (!current || current.generation !== expectedGeneration) return;
  if (polling) {
    // A replacement generation must get a turn after the old request settles.
    pollTimer = setTimeout(() => void poll(expectedGeneration), 0);
    return;
  }
  polling = true;
  try {
    const [info, health] = await Promise.all([fetchSystemInfo(), fetchDashboardHealth()]);
    const live = attempt;
    if (live?.generation !== expectedGeneration || live.expired || Date.now() >= live.deadline) {
      if (live?.generation === expectedGeneration) expire(expectedGeneration);
      return;
    }
    if (isReady(health, live.version) && (live.priorPid === undefined || info.pid !== live.priorPid)) {
      clearTimers();
      publish({ phase: "back", version: live.version });
      if (!reloadRequested) {
        reloadRequested = true;
        window.location.reload();
      }
      return;
    }
  } catch {
    /* FNXC:UpdateRestartRecovery 2026-08-21-02:48: Transport failure is normal while the old host exits; it cannot prove readiness. */
  } finally {
    polling = false;
  }
  const live = attempt;
  if (!live || live.generation !== expectedGeneration) {
    if (live && !live.expired) pollTimer = setTimeout(() => void poll(live.generation), 0);
    return;
  }
  if (live.expired || Date.now() >= live.deadline) {
    expire(expectedGeneration);
    return;
  }
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => void poll(expectedGeneration), POLL_MS);
}

/* FNXC:UpdateRestartRecovery 2026-08-21-03:11: Reset the process-local controller between isolated fake-timer tests. */
export function __test_resetSystemRestartRecovery(): void {
  clearTimers();
  attempt = undefined;
  polling = false;
  reloadRequested = false;
  publish({ phase: "idle" });
}

export function useSystemRestartRecovery(): RestartRecoveryState {
  return useSyncExternalStore(systemRestartRecovery.subscribe, systemRestartRecovery.getSnapshot, systemRestartRecovery.getSnapshot);
}
