/**
 * FNXC:PlannerOversight 2026-07-13-22:40:
 * Session-advisor emission guard (OMP AdvisorEmissionGuard parity).
 * Makes "prefer silence", "at most one advise per update", and "never
 * repeat the same advice" load-bearing in code so a misbehaving model
 * cannot flood the executor transcript with content-free or duplicate
 * notes. Pure in-memory policy — never throws, never performs I/O.
 *
 * Accept order: empty → content-free phrase → exact-text+severity-rank
 * dedupe → per-update rate limit. Suppressed calls do not consume the
 * per-update budget so a noise call does not displace a later real note
 * in the same update cycle.
 */

import {
  normalizeOverseerAdviceNote,
  overseerAdviceSeverityRank,
  type OverseerAdviceSeverity,
} from "./overseer-advice.js";

/**
 * Normalized phrases that carry no concrete actionable content. Silence is
 * the correct expression of "no concerns". Keys must be outputs of
 * {@link normalizeOverseerAdviceNote}.
 */
const SUPPRESSED_NORMALIZED_PHRASES: ReadonlySet<string> = new Set([
  "stop",
  "stop here",
  "stop now",
  "halt",
  "abort",
  "done",
  "task done",
  "task complete",
  "complete",
  "finished",
  "ok",
  "okay",
  "ok done",
  "no issue",
  "no issues",
  "no issue continue",
  "no concerns",
  "no concern",
  "nothing to add",
  "nothing to flag",
  "nothing to report",
  "no notes",
  "no further input",
  "no further input needed",
  "no further input required",
  "no further watcher input",
  "no further watcher input needed",
  "no further advice",
  "no further advice needed",
  "lgtm",
  "looks good",
  "all good",
  "agent is on track",
  "agent on track",
  "on track",
  "continue",
  "carry on",
]);

/** Bounds dedupe history growth on long sessions (OMP default 4096). */
const DEFAULT_HISTORY_CAPACITY = 4096;

export interface OverseerEmissionGuardOptions {
  capacity?: number;
}

export interface OverseerEmissionGuardAcceptInput {
  note: string;
  severity?: OverseerAdviceSeverity;
}

/**
 * FNXC:PlannerOversight 2026-07-13-22:40:
 * Per-session (or per-task) gate for session-advisor `advise()` results
 * before they reach `addSteeringComment` / the intervention timeline.
 */
export class OverseerEmissionGuard {
  /** Highest delivered severity rank per normalized note key. */
  #deliveredRanks = new Map<string, number>();
  /** Insertion order for FIFO eviction. */
  #seenOrder: string[] = [];
  #consumedThisUpdate = false;
  readonly #capacity: number;

  constructor(opts: OverseerEmissionGuardOptions = {}) {
    this.#capacity = opts.capacity ?? DEFAULT_HISTORY_CAPACITY;
  }

  /**
   * Drop all dedupe and per-update state. Call when the advisor runtime is
   * reset (session switch, re-prime) so a re-primed reviewer can re-raise
   * issues against a rewritten transcript.
   */
  reset(): void {
    this.#deliveredRanks.clear();
    this.#seenOrder.length = 0;
    this.#consumedThisUpdate = false;
  }

  /**
   * Clear the per-update rate-limit gate. Call immediately before each
   * advisor model `prompt()` cycle.
   */
  beginUpdate(): void {
    this.#consumedThisUpdate = false;
  }

  /**
   * Whether the proposed note should reach the executor. On true the gate
   * has already recorded the note (consumed the per-update budget and
   * stored the severity rank). On false the caller must drop it silently.
   */
  accept(input: OverseerEmissionGuardAcceptInput | string): boolean {
    try {
      const note = typeof input === "string" ? input : input?.note;
      const severity = typeof input === "string" ? undefined : input?.severity;
      if (typeof note !== "string") return false;

      const key = normalizeOverseerAdviceNote(note);
      if (!key) return false;
      if (SUPPRESSED_NORMALIZED_PHRASES.has(key)) return false;

      const rank = overseerAdviceSeverityRank(severity);
      const previousRank = this.#deliveredRanks.get(key) ?? 0;
      if (rank <= previousRank) return false;

      if (this.#consumedThisUpdate) return false;

      this.#consumedThisUpdate = true;
      const isNewKey = !this.#deliveredRanks.has(key);
      this.#deliveredRanks.set(key, rank);
      if (isNewKey) {
        this.#seenOrder.push(key);
        while (this.#seenOrder.length > this.#capacity) {
          const stale = this.#seenOrder.shift();
          if (stale !== undefined) this.#deliveredRanks.delete(stale);
        }
      }
      return true;
    } catch {
      return false;
    }
  }
}
