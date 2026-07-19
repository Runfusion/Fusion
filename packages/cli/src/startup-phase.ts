/**
 * Shared startup phase timing for CLI surfaces (dashboard, serve).
 *
 * FNXC:FasterStartup 2026-07-14-23:55:
 * Operators and developers need wall-clock labels for each boot phase so
 * time-to-listen regressions are attributable. Dashboard already had an
 * inline phaseTime helper; serve and factory/engine paths need the same
 * cheap pattern without inventing a separate metrics product.
 */

export type StartupPhaseLogger = (message: string, scope?: string) => void;

/**
 * Time an async or sync startup phase and log `startup phase <label>: Nms`.
 * Always logs in `finally` so failures still surface their duration.
 */
export async function phaseTime<T>(
  label: string,
  fn: () => Promise<T> | T,
  log: StartupPhaseLogger,
  scope = "startup",
): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    log(`startup phase ${label}: ${Date.now() - t0}ms`, scope);
  }
}
