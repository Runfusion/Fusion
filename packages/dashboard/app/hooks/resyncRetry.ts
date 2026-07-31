/*
FNXC:SseResync 2026-07-26-18:05:
ONE bounded retry ladder for every "the SSE channel just reopened, refetch what we missed" handler.

Why it exists: those handlers were each written as `void refetch().catch(() => {})` with a comment
saying the next reconnect retries. That claim is false in the case that matters — after a mobile
hidden-tab suspend the stream reopens ONCE, and if that single refetch fails (the same flaky network
that caused the suspend) the surface stays silently wrong until the operator reloads. For the
approval banner that means a pending decision is never rendered and the requesting agent blocks
indefinitely.

Bounded, not unbounded: the resume edge is already congested (every suspended channel refetches at
the same instant), so a failing surface gets a short ladder and then STOPS and reports degradation
via `onExhausted` — it does not hammer the server.

Shared rather than copied: three near-identical hand-rolled fixes in one change set is the documented
recurring failure mode here (AGENTS.md "Reuse Components, Design Tokens, and Systems (No Drift)"), so
every resync handler imports this runner instead of growing its own variant.
*/

/** Delays before retry attempts 2 and 3. Two retries ≈ 10s of coverage for a transient failure. */
export const DEFAULT_RESYNC_RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000];

export interface ResyncRetryOptions {
  /** One resync attempt. MUST reject on failure — a promise that swallows its own error is not retryable. */
  run: () => Promise<void>;
  /** Delay before each retry. Length bounds the number of retries (default: two). */
  delaysMs?: readonly number[];
  /**
   * Every attempt in the ladder failed. The surface's data is now KNOWN to be possibly incomplete;
   * callers use this to raise an operator-visible signal rather than render a confident wrong view.
   */
  onExhausted?: (error: unknown) => void;
  /** An attempt succeeded after a previous ladder had been exhausted. Callers clear their signal. */
  onRecovered?: () => void;
}

export interface ResyncRetryRunner {
  /** Run the resync now, cancelling any pending retry (a fresh reconnect supersedes a scheduled one). */
  trigger: () => void;
  /** Cancel pending retries and suppress all further callbacks. Call from effect cleanup. */
  dispose: () => void;
}

export function createResyncRetryRunner(options: ResyncRetryOptions): ResyncRetryRunner {
  const delays = options.delaysMs ?? DEFAULT_RESYNC_RETRY_DELAYS_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let disposed = false;
  // True once a full ladder failed; drives the single onRecovered edge.
  let exhausted = false;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const onFailure = (retryIndex: number, error: unknown) => {
    inFlight = false;
    if (disposed) return;
    if (retryIndex < delays.length) {
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        attempt(retryIndex + 1);
      }, delays[retryIndex]);
      return;
    }
    exhausted = true;
    options.onExhausted?.(error);
  };

  const onSuccess = () => {
    inFlight = false;
    if (disposed) return;
    if (exhausted) {
      exhausted = false;
      options.onRecovered?.();
    }
  };

  function attempt(retryIndex: number): void {
    // Overlapping attempts are pointless: they converge on the same server state and double the
    // load on the resume edge this ladder is trying not to congest.
    if (disposed || inFlight) return;
    inFlight = true;
    /*
    `run()` is invoked SYNCHRONOUSLY, never deferred through a microtask. Callers set their
    "resync in flight — park live events" flag in the first synchronous statement of run(), and an
    event delivered during an intervening microtask would slip past that flag and then be overwritten
    by the page the resync applies: exactly the silent data loss these resyncs exist to prevent.
    */
    let started: Promise<void>;
    try {
      started = options.run();
    } catch (error: unknown) {
      onFailure(retryIndex, error);
      return;
    }
    void started.then(onSuccess, (error: unknown) => onFailure(retryIndex, error));
  }

  return {
    trigger: () => {
      if (disposed) return;
      clearTimer();
      attempt(0);
    },
    dispose: () => {
      disposed = true;
      clearTimer();
    },
  };
}
