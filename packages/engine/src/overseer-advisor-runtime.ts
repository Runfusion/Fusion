/**
 * FNXC:PlannerOversight 2026-07-13-22:50:
 * Session-advisor runtime control plane (OMP AdvisorRuntime parity).
 * Queues transcript deltas from the executor log stream, drains them through
 * an injected advisor agent (or fake in tests), and routes accepted notes
 * back via the host. Never throws out of public methods; advisor failures
 * retry up to 3 times then drop backlog so the executor is never stalled.
 *
 * v1 does not block the executor on advisor catch-up (syncBacklog default
 * off). The waitForCatchup API is present for a future setting.
 */

import { createLogger, type Logger } from "./logger.js";
import { formatOverseerSessionDelta, type OverseerLogEntry } from "./overseer-session-delta.js";

const runtimeLog = createLogger("overseer-advisor-runtime");

/** Minimal advisor agent the runtime drives — satisfied by a real session or a test fake. */
export interface OverseerAdvisorAgent {
  prompt(input: string): Promise<void>;
  abort?(reason?: unknown): void;
  reset?(): void;
}

export interface OverseerAdvisorRuntimeHost {
  /** Surface one accepted advice note to the executor (after emission guard). */
  enqueueAdvice(note: string, severity?: "nit" | "concern" | "blocker"): void | Promise<void>;
  /** Clear per-update emission-guard budget before each prompt cycle. */
  beginAdvisorUpdate?(): void;
  onTurnError?(error: unknown): void | Promise<void>;
  notifyFailure?(error: unknown): void;
}

interface PendingDelta {
  text: string;
  turns: number;
}

export interface OverseerAdvisorRuntimeOptions {
  agent: OverseerAdvisorAgent;
  host: OverseerAdvisorRuntimeHost;
  retryDelayMs?: number;
  logger?: Logger;
  /** Injectable sleep for tests (defaults to real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * FNXC:PlannerOversight 2026-07-13-22:50:
 * Per-task session advisor drain loop. Cursor tracks how many log entries
 * have been rendered; seedTo jumps the cursor when advising enables mid-task.
 */
export class OverseerAdvisorRuntime {
  #agent: OverseerAdvisorAgent;
  #host: OverseerAdvisorRuntimeHost;
  #retryDelayMs: number;
  #logger: Logger;
  #sleep: (ms: number) => Promise<void>;

  #lastCount = 0;
  #pending: PendingDelta[] = [];
  #busy = false;
  #backlog = 0;
  #consecutiveFailures = 0;
  #failureNotified = false;
  #latestEntries: OverseerLogEntry[] = [];
  #epoch = 0;
  disposed = false;

  constructor(options: OverseerAdvisorRuntimeOptions) {
    this.#agent = options.agent;
    this.#host = options.host;
    this.#retryDelayMs = options.retryDelayMs ?? 1000;
    this.#logger = options.logger ?? runtimeLog;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  get backlog(): number {
    return this.#backlog;
  }

  get lastCount(): number {
    return this.#lastCount;
  }

  /**
   * Notify that the executor log grew. Pass the full entry list (or a
   * snapshot); only entries after the internal cursor are rendered.
   */
  onLogSnapshot(entries: ReadonlyArray<OverseerLogEntry>): void {
    if (this.disposed) return;
    try {
      this.#latestEntries = [...entries];
      const render = this.#renderDelta(this.#latestEntries);
      if (render) {
        this.#pending.push({ text: render, turns: 1 });
        this.#backlog++;
        void this.#drain();
      }
    } catch (err) {
      this.#logger.warn(`onLogSnapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Append-only convenience: notify with only the new entries since last call
   * when the host cannot provide a full list. Advances the cursor by the
   * number of entries provided.
   */
  onLogDelta(newEntries: ReadonlyArray<OverseerLogEntry>): void {
    if (this.disposed) return;
    try {
      if (!newEntries || newEntries.length === 0) return;
      this.#latestEntries = this.#latestEntries.concat(newEntries);
      const render = formatOverseerSessionDelta(newEntries);
      // Advance cursor even when render is null (all filtered) so we don't reprocess.
      this.#lastCount = this.#latestEntries.length;
      if (render) {
        this.#pending.push({ text: render, turns: 1 });
        this.#backlog++;
        void this.#drain();
      }
    } catch (err) {
      this.#logger.warn(`onLogDelta failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Seed the cursor to the current transcript length when advising is enabled
   * mid-session — avoid replaying the entire history on the first update.
   */
  seedTo(count: number): void {
    this.#lastCount = Math.max(0, count);
    this.#pending = [];
    this.#backlog = 0;
    this.#consecutiveFailures = 0;
    this.#failureNotified = false;
  }

  /**
   * Re-prime after history rewrite (session switch, compaction, worktree rebind).
   */
  reset(): void {
    this.#epoch++;
    this.#lastCount = 0;
    this.#pending = [];
    this.#backlog = 0;
    this.#consecutiveFailures = 0;
    this.#failureNotified = false;
    try {
      this.#agent.reset?.();
    } catch {
      /* ignore */
    }
    try {
      this.#agent.abort?.("advisor reset");
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    this.disposed = true;
    this.#epoch++;
    this.#pending = [];
    this.#backlog = 0;
    this.#consecutiveFailures = 0;
    this.#failureNotified = false;
    try {
      this.#agent.abort?.("advisor disposed");
    } catch {
      /* ignore */
    }
  }

  #renderDelta(all: ReadonlyArray<OverseerLogEntry>): string | null {
    if (all.length < this.#lastCount) {
      this.#lastCount = all.length;
      return null;
    }
    const delta = all.slice(this.#lastCount);
    this.#lastCount = all.length;
    if (delta.length === 0) return null;
    return formatOverseerSessionDelta(delta);
  }

  async #drain(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      while (!this.disposed && this.#pending.length > 0) {
        const popped = this.#pending.splice(0);
        const epoch = this.#epoch;
        const batch = popped.map((b) => b.text).join("\n\n");
        const turnsCovered = popped.reduce((sum, b) => sum + b.turns, 0);
        if (!batch.trim()) {
          this.#backlog = Math.max(0, this.#backlog - turnsCovered);
          continue;
        }

        let success = false;
        try {
          this.#host.beginAdvisorUpdate?.();
          await this.#agent.prompt(batch);
          success = true;
          this.#consecutiveFailures = 0;
          this.#failureNotified = false;
        } catch (err) {
          if (this.#epoch !== epoch) continue;
          this.#logger.warn(`advisor turn failed: ${err instanceof Error ? err.message : String(err)}`);
          try {
            await this.#host.onTurnError?.(err);
          } catch {
            /* ignore */
          }
          if (this.#epoch !== epoch) continue;
          this.#consecutiveFailures++;
          if (this.#consecutiveFailures >= 3) {
            this.#logger.warn("advisor failed consecutively 3 times; dropping backlog");
            if (!this.#failureNotified) {
              this.#failureNotified = true;
              try {
                this.#host.notifyFailure?.(err);
              } catch {
                /* ignore */
              }
            }
            this.#consecutiveFailures = 0;
            // FNXC:PlannerOversight 2026-07-14-14:00: CodeRabbit — allow a *new* 3-failure streak to notify again after this drop is handled (do not latch forever until a success).
            this.#failureNotified = false;
            success = true; // treat as handled drop
          } else {
            this.#pending.unshift({ text: batch, turns: turnsCovered });
            await this.#sleep(this.#retryDelayMs);
          }
        }

        if (success && this.#epoch === epoch) {
          this.#backlog = Math.max(0, this.#backlog - turnsCovered);
        }
      }
    } finally {
      this.#busy = false;
    }
  }
}
