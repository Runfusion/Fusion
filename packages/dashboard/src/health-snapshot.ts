/**
 * FNXC:HealthProbeLatency 2026-11-01-22:53 (RUFU-674):
 * `/api/health` used to await the full Postgres health evaluation on EVERY request: a 5 s internal
 * budget (`DEFAULT_HEALTH_PROBE_BUDGET_MS`) over a route measured at 1.7–3.1 s while idle. The
 * dashboard watchdog probes with `curl -m 10` every 45 s and restarts the process after three
 * consecutive failures, so roughly seven seconds of event-loop latency was enough to lose a probe and
 * kill a server that was only slow — measured on 2026-11-01: `rss_sum=8888236 … health=000 fails=3 →
 * restart` at 8.9 GB RSS, far under the memory ceiling, aborting every live session with it.
 *
 * This module serves the health payload from a background-refreshed snapshot so the probe handler does
 * ZERO awaited I/O and needs only one event-loop turn — the principle `/metrics` already documents for
 * its own scrape path ("served synchronously from the sampler snapshot with zero awaited I/O").
 *
 * It stays fail-closed on purpose: once the snapshot ages past `HEALTH_SNAPSHOT_STALE_CEILING_MS` the
 * caller must answer non-2xx, so a process whose loop is genuinely wedged is still restarted — and
 * faster than before, because a stale snapshot answers immediately instead of waiting out the probe
 * timeout. Only the slow-but-alive case stops being fatal.
 */

/** Refresh cadence. Must stay well inside the watchdog's 45 s probe interval so a probe never pays for a read. */
export const HEALTH_SNAPSHOT_REFRESH_MS = 5_000;
/**
 * Age after which a snapshot must be answered as degraded. Kept under the watchdog's kill window
 * (3 failed probes × 45 s ≈ 135 s) so a wedged process still loses its liveness claim before the kill
 * would have happened anyway.
 */
export const HEALTH_SNAPSHOT_STALE_CEILING_MS = 90_000;

export type HealthSnapshotRead<T> = {
  /** The last successfully evaluated payload, or null before the first one lands. */
  value: T | null;
  /** True once `value` exists but is older than the stale ceiling. False while `value` is null. */
  stale: boolean;
  /** Milliseconds since the snapshot was produced; `Number.NaN` before the first one. */
  ageMs: number;
};

/**
 * Holds one health payload refreshed off the request path.
 *
 * A failed refresh KEEPS the previous value rather than clearing it: the age is what makes the
 * snapshot unsafe, not the failure itself, so one transient probe error cannot flip a healthy server
 * to degraded-and-restarting.
 *
 * @param evaluate Produces the payload. Rejects only for a genuine failure; the evaluation itself is
 *   expected to resolve with a degraded payload on a degraded backend (VAL-HEALTH-002).
 * @param now Clock injection for tests; defaults to `Date.now`.
 * @param refreshMs / `staleCeilingMs` Overridable for tests; production uses the exported constants.
 */
export function createHealthSnapshot<T>(input: {
  evaluate: () => Promise<T>;
  now?: () => number;
  refreshMs?: number;
  staleCeilingMs?: number;
}): {
  read(): HealthSnapshotRead<T>;
  refreshNow(): Promise<T | null>;
  start(): void;
  stop(): void;
} {
  const now = input.now ?? Date.now;
  const refreshMs = input.refreshMs ?? HEALTH_SNAPSHOT_REFRESH_MS;
  const staleCeilingMs = input.staleCeilingMs ?? HEALTH_SNAPSHOT_STALE_CEILING_MS;
  let value: T | null = null;
  let takenAt = Number.NaN;
  let inFlight: Promise<T | null> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const read = (): HealthSnapshotRead<T> => {
    if (value === null || Number.isNaN(takenAt)) {
      return { value: null, stale: false, ageMs: Number.NaN };
    }
    const ageMs = now() - takenAt;
    return { value, stale: ageMs > staleCeilingMs, ageMs };
  };

  /** Coalescing refresh: concurrent callers share one evaluation, and a rejection keeps the last value. */
  const refreshNow = (): Promise<T | null> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const next = await input.evaluate();
        value = next;
        takenAt = now();
        return value;
      } catch {
        return value;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const start = (): void => {
    if (timer) return;
    void refreshNow();
    timer = setInterval(() => {
      void refreshNow();
    }, refreshMs);
    // The snapshot must never hold the process open by itself.
    timer.unref?.();
  };

  const stop = (): void => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  return { read, refreshNow, start, stop };
}
