/**
 * FNXC:PlannerOversight 2026-07-13-22:40:
 * Session-advisor (OMP advisor parity) vocabulary for severity-routed advice
 * notes. The lifecycle planner overseer (FN-7511–7520) remains rule-based;
 * the session advisor layer produces concrete notes that ride the existing
 * steering-comment channel. Severity ranks enable escalation (nit → concern
 * → blocker) while emission-guard dedupe treats equal-or-lower rank as a
 * repeat. Pure, engine-free types only — no I/O.
 */

/** How strongly the session advisor weighs a note for the driving agent. */
export const OVERSEER_ADVICE_SEVERITIES = ["nit", "concern", "blocker"] as const;
export type OverseerAdviceSeverity = (typeof OVERSEER_ADVICE_SEVERITIES)[number];

/**
 * Provenance of an overseer intervention or steering inject. Lets timeline
 * and emission hygiene distinguish canned lifecycle recovery from live
 * session-advisor notes and manual operator nudges.
 */
export const OVERSEER_ADVICE_SOURCES = ["lifecycle", "session-advisor", "manual"] as const;
export type OverseerAdviceSource = (typeof OVERSEER_ADVICE_SOURCES)[number];

/**
 * Rank used for escalation-aware dedupe. Omitted severity is treated as nit
 * (OMP advise-tool contract). Higher rank may re-emit the same note text.
 */
export const OVERSEER_ADVICE_SEVERITY_RANK: Record<OverseerAdviceSeverity, number> = {
  nit: 1,
  concern: 2,
  blocker: 3,
};

/** One concrete piece of advice for the watched agent. */
export interface OverseerAdviceNote {
  note: string;
  severity?: OverseerAdviceSeverity;
  /** Which configured advisor produced this note (multi-advisor roster; optional in v1). */
  advisorSlug?: string;
  source?: OverseerAdviceSource;
}

/**
 * FNXC:PlannerOversight 2026-07-13-22:40:
 * Normalize free-text severity from tool args / metadata. Unknown values
 * degrade to undefined (treated as nit at rank time) rather than throwing.
 */
export function normalizeOverseerAdviceSeverity(value: unknown): OverseerAdviceSeverity | undefined {
  if (typeof value !== "string") return undefined;
  const lowered = value.trim().toLowerCase();
  if ((OVERSEER_ADVICE_SEVERITIES as readonly string[]).includes(lowered)) {
    return lowered as OverseerAdviceSeverity;
  }
  return undefined;
}

/** Severity rank; omitted/unknown severity ranks as nit. */
export function overseerAdviceSeverityRank(severity: OverseerAdviceSeverity | undefined): number {
  return OVERSEER_ADVICE_SEVERITY_RANK[severity ?? "nit"];
}

/**
 * Case-insensitive, punctuation-folded normalization for emission-guard
 * keys. Collapses every run of non-letter / non-digit characters into a
 * single space so `"Stop."`, `"*Stop*"`, and `"  stop  "` share one key.
 */
export function normalizeOverseerAdviceNote(note: string): string {
  return note
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
