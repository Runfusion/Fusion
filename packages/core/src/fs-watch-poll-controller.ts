import { watch, type FSWatcher } from "node:fs";

/**
 * FNXC:CoreStores 2026-07-09-14:20:
 * `TaskStore` and `AgentStore` both need cross-process change detection over
 * the shared `.fusion/fusion.db` — an in-process instance must notice writes
 * made by ANOTHER process (or another store instance) sharing the same DB
 * file, without a message bus. Both stores independently hand-rolled the
 * identical mechanism: a fail-soft `fs.watch()` fast-path nudge (some
 * platforms/filesystems don't support it) plus an always-on `setInterval`
 * poll fallback, with identical teardown. `FsWatchPollController` owns ONLY
 * that mechanical watch/poll lifecycle so the two stores stop duplicating it
 * (FN-7726, follow-up from FN-7723 which intentionally duplicated it rather
 * than block on this extraction).
 *
 * Deliberately NOT owned here: the `getLastModified()` gating and the
 * `pollingInProgress` re-entrancy guard stay inside each store's own
 * `checkForChanges()` (the `onPoll` callback passed to `start()`), because
 * that guard is already a couple of one-line checks local to each store's
 * diff body — lifting it in here would add API surface without removing any
 * further duplication. See task FN-7726's `plan` document for the full
 * rejected-alternatives rationale.
 */

/** Minimal logger shape the controller needs — satisfied by `storeLog`/`agentStoreLog`. */
export interface FsWatchPollLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface FsWatchPollStartOptions {
  /** Directory to fs.watch (fail-soft — a poll fallback always runs regardless). */
  dir: string;
  /** Pass `true` for a recursive directory watch (TaskStore's `tasksDir`); omit/false for a flat watch (AgentStore's `rootDir`). */
  recursive?: boolean;
  /** Poll interval in ms for the `setInterval` fallback. */
  pollIntervalMs: number;
  /** Invoked on every poll tick AND is the only place diff/emit logic lives — callers keep their own gating inside this callback. */
  onPoll: () => void | Promise<void>;
  /** Logger used for the two canonical fail-soft warn strings. */
  log: FsWatchPollLogger;
  /** Extra fields merged into both warn calls' metadata (e.g. `{ tasksDir }` / `{ rootDir }`) so log context stays store-specific. */
  errorContext?: Record<string, unknown>;
}

/**
 * Shared fail-soft fs.watch + poll lifecycle controller.
 *
 * Owns exactly the watcher/interval handles, their fail-soft setup, and
 * idempotent teardown. Callers supply their own diff/emit logic via
 * `onPoll` and their own gating (e.g. `pollingInProgress`/`getLastModified()`)
 * inside that callback — this controller does not gate ticks itself.
 */
export class FsWatchPollController {
  private watcherHandle: FSWatcher | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /**
   * The live `FSWatcher` instance (or null if not watching / fs.watch
   * unavailable). Exposed so tests can simulate a degraded watcher via
   * `controller.watcher.emit("error", ...)`, mirroring the pre-extraction
   * behavior both stores' existing test suites already rely on.
   */
  get watcher(): FSWatcher | null {
    return this.watcherHandle;
  }

  /** Whether a watcher and/or poll interval is currently registered. */
  isWatching(): boolean {
    return this.watcherHandle !== null || this.intervalHandle !== null;
  }

  /**
   * Start the fail-soft fs.watch + poll lifecycle. No-op if already
   * watching (mirrors both stores' pre-extraction `if (this.watcher ||
   * this.pollInterval) return;` guard).
   */
  start(opts: FsWatchPollStartOptions): void {
    if (this.watcherHandle || this.intervalHandle) return; // already watching

    try {
      this.watcherHandle = opts.recursive
        ? watch(opts.dir, { recursive: true }, (_event, _filename) => {
            // No-op — the poll fallback below does the actual diffing;
            // fs.watch here only exists as a fast-path nudge candidate and
            // for API/close symmetry.
          })
        : watch(opts.dir, (_event, _filename) => {
            // No-op — see above.
          });
      this.watcherHandle.on("error", (err) => {
        opts.log.warn("fs.watch emitted an error; polling will continue", {
          phase: "watch:fs-watch-error",
          error: err instanceof Error ? err.message : String(err),
          ...opts.errorContext,
        });
      });
    } catch (err) {
      // fs.watch may not be available on this platform/filesystem — that's
      // fine, the poll fallback below is the reliable path.
      opts.log.warn("fs.watch unavailable; falling back to polling-only updates", {
        phase: "watch:fs-watch-setup",
        error: err instanceof Error ? err.message : String(err),
        ...opts.errorContext,
      });
    }

    this.intervalHandle = setInterval(() => {
      void opts.onPoll();
    }, opts.pollIntervalMs);
  }

  /** Stop watching and clear all handles. Idempotent. */
  stop(): void {
    if (this.watcherHandle) {
      this.watcherHandle.close();
      this.watcherHandle = null;
    }
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }
}
