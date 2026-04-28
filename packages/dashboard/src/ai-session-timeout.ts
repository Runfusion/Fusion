/**
 * Per-session generation guard: bounds the runtime of an in-flight AI
 * `prompt()` call with a timeout and an `AbortController`, so a silently-
 * stalled model stream or hung tool call cannot leave a session pinned in
 * `generating` forever.
 *
 * The guard is module-scoped: planning, subtask-breakdown, mission-interview,
 * and milestone-slice-interview each instantiate their own. The session ID is
 * the key, so concurrent generations across modules don't collide.
 */

export interface TimeoutHandlers {
  /** Fired exactly once when the timeout elapses, before the abort propagates. */
  onTimeout: () => void;
  /** Fired when abort happens for a non-timeout reason (e.g. manual stop). */
  onUserStop?: () => void;
}

interface ActiveEntry {
  abort: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

type AbortCause = "timeout" | "user-stop" | "displaced";

export class GenerationGuard {
  private readonly active = new Map<string, ActiveEntry>();
  /**
   * Tracks the cause of a pending abort so the original `run()` can
   * distinguish a user-initiated stop from re-entrant displacement. The flag
   * is consumed (deleted) by the catch block of the displaced `run()`.
   */
  private readonly abortCause = new Map<AbortController, AbortCause>();

  /**
   * Wrap `op` with a timeout + abort. If a previous generation is still
   * registered for the same id, it is aborted first (the prior `run()`
   * rejects with `AbortError`, marked as `displaced` so its `onUserStop`
   * handler does NOT fire).
   */
  async run<T>(
    sessionId: string,
    timeoutMs: number,
    handlers: TimeoutHandlers,
    op: () => Promise<T>,
  ): Promise<T> {
    this.cancelInternal(sessionId, "displaced");

    const abort = new AbortController();
    const timer = setTimeout(() => {
      this.abortCause.set(abort, "timeout");
      try {
        handlers.onTimeout();
      } catch {
        // swallow — handler errors must not prevent abort
      }
      abort.abort();
    }, timeoutMs);

    const entry: ActiveEntry = { abort, timer };
    this.active.set(sessionId, entry);

    const abortPromise = new Promise<never>((_, reject) => {
      abort.signal.addEventListener(
        "abort",
        () => reject(createAbortError()),
        { once: true },
      );
    });

    try {
      return await Promise.race([op(), abortPromise]);
    } catch (err) {
      if (isAbortError(err)) {
        const cause = this.abortCause.get(abort) ?? "user-stop";
        if (cause === "user-stop") {
          try {
            handlers.onUserStop?.();
          } catch {
            // swallow
          }
        }
      }
      throw err;
    } finally {
      clearTimeout(timer);
      this.abortCause.delete(abort);
      if (this.active.get(sessionId) === entry) {
        this.active.delete(sessionId);
      }
    }
  }

  /** AbortSignal of the in-flight generation, if any — for tools that honor it. */
  signal(sessionId: string): AbortSignal | undefined {
    return this.active.get(sessionId)?.abort.signal;
  }

  has(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /**
   * Manually abort the active generation. Returns true if there was one.
   * The wrapped operation will reject with `AbortError`, and the `onUserStop`
   * handler from the original `run()` call will fire.
   */
  stop(sessionId: string): boolean {
    return this.cancelInternal(sessionId, "user-stop");
  }

  /** Reset all in-flight generations (test/shutdown only). */
  reset(): void {
    for (const sessionId of [...this.active.keys()]) {
      this.cancelInternal(sessionId, "user-stop");
    }
  }

  private cancelInternal(sessionId: string, cause: AbortCause): boolean {
    const entry = this.active.get(sessionId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.abortCause.set(entry.abort, cause);
    entry.abort.abort();
    this.active.delete(sessionId);
    return true;
  }
}

export function createAbortError(): Error {
  const error = new Error("Generation aborted");
  error.name = "AbortError";
  return error;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
