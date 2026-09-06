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


/**
 * Wall-clock bound for a startup phase whose work cannot be cancelled.
 *
 * FNXC:FasterStartup 2026-09-06-05:22:
 * A startup phase with no bound is a boot that can hang forever on one slow
 * dependency. Measured 2026-09-06: `discoverAndLoadExtensions` took 399,809ms
 * while every other phase finished under 1.5s, and the dashboard sat on
 * "Loading extensions..." for the whole 6m40s with no way out. This mirrors the
 * bound already applied to the model-registry refresh directly below that call
 * site. Rejecting is the point: callers are expected to have a degradation path
 * (an empty extension runtime, cached models) that is strictly better than an
 * unbounded wait, so the phase must fail loudly rather than block boot.
 *
 * Known limit, so nobody mistakes this for a general hang cure: the bound is a
 * timer, so it only fires if the event loop is turning. It covers a phase stalled
 * on an await; it cannot interrupt one blocking the loop synchronously (a large
 * module compile, a sync fs walk). A phase that can block the loop needs to stop
 * doing that -- no timer can rescue it.
 */
export class StartupPhaseTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`startup phase ${label} timed out after ${timeoutMs}ms`);
    this.name = "StartupPhaseTimeoutError";
  }
}

/**
 * Time a startup phase like `phaseTime`, but reject with StartupPhaseTimeoutError
 * once `timeoutMs` elapses. The underlying work keeps running (it owns resources
 * this helper cannot cancel); its eventual rejection is retained so a late failure
 * after the bound never surfaces as an unhandled rejection.
 */
export async function boundedPhaseTime<T>(
  label: string,
  fn: () => Promise<T> | T,
  log: StartupPhaseLogger,
  timeoutMs: number,
  scope = "startup",
): Promise<T> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const underlying = Promise.resolve().then(fn);
  void underlying.catch(() => {});
  try {
    return await Promise.race([
      underlying,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StartupPhaseTimeoutError(label, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    log(`startup phase ${label}: ${Date.now() - t0}ms`, scope);
  }
}
