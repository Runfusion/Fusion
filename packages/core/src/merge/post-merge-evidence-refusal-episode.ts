/*
FNXC:PostMergeEvidenceRefusalEpisode 2026-11-02-18:16 (RUFU-450, Half 1):
The finalize lane restates a refusal it cannot satisfy at the poll rate. Measured on VLLM-081: 5
`task:auto-merge-finalize-column-mismatch-no-action` rows inside the single minute 19:44, plus more at 19:43
and 19:45, with no backoff and no operator notice, until a human waiver ended the episode (and then ZERO
further rows — proof the churn was driven entirely by the unsatisfiable requirement).

The shipped in-process gate (`finalization-refusal-notice.ts`, RUFU-431/386) keys on the refusal's metadata
identity, so it DOES collapse repeats within one engine lifetime — but it holds no cross-pass durable state:
an engine restart, or a second process that also polls the lane, starts counting from zero, and nothing about
the card itself records that this refusal has already been reported. This module adds the durable half, in
the shape RUFU-393 shipped for a withheld hold->WIP crossing and RUFU-273 before it: one episode object at
KEY level in `sourceMetadata` (`postMergeEvidenceRefusal`), written through `sourceMetadataPatch`, never a
lifecycle field, plus a code-owned refresh floor.

The floor value is RUFU-393/RUFU-273's 15 minutes deliberately, not a new bound: same fault class observed
at a poll rate. At 15 min an unchanged refusal collapses from ~180 rows/hour/card to at most 4.

Signature hygiene is RUFU-442's measured lesson: the growth counter (`refusalCount`) and every field that
churns within one ongoing refusal stay OUT of the identity, because a bound whose key changes each cycle is
not a bound — it just re-announces with extra steps.
*/

/** Key of the episode inside `Task.sourceMetadata`. Written key-level only; never a whole-field wipe. */
export const POST_MERGE_EVIDENCE_REFUSAL_METADATA_KEY = "postMergeEvidenceRefusal" as const;

/**
 * Minimum spacing between two records of one card's UNCHANGED unsatisfiable finalize refusal.
 * A changed refusal signature always records immediately; this bounds only repetition.
 */
export const POST_MERGE_EVIDENCE_REFUSAL_REFRESH_FLOOR_MS = 15 * 60_000;

/** The episode as stored. Diagnostic-only: no read path gates a lifecycle decision on it. */
export interface PostMergeEvidenceRefusalEpisode {
  /** Fixed-key identity of the refusal: `gateId:state:reseedReason`. Never contains a counter. */
  signature: string;
  /** ISO instant of the most recent accepted record of this refusal. */
  lastAt: string;
  /** ISO instant of the FIRST record of this episode; age derives from this, never `updatedAt`. */
  firstAt: string;
  /** How many records this episode has produced. Forensic, and deliberately NOT part of `signature`. */
  refusalCount: number;
  /** Which gate was refused (forensic; already inside `signature`). */
  gateId?: string;
  /** Which evidence state produced it (forensic). */
  state?: string;
  /** Which re-seed refusal accompanied it, when the seam was reached (forensic). */
  reseedReason?: string;
}

/** What a caller observed this pass, before any episode arithmetic. */
export interface PostMergeEvidenceRefusalObservation {
  gateId: string;
  /** The gate's evidence state (`missing` / `not-approved`), or `"finalize-blocked"` when the lane declined. */
  state: string;
  /** The re-seed refusal reason, when the seam was reached at all. */
  reseedReason?: string | null;
}

/**
 * The refusal's identity: which gate, which state, which refusal — and nothing else.
 *
 * `state` and `reseedReason` are fixed vocabularies, so an unchanged condition yields a byte-stable key and
 * any real change (a gate that finally reports, a different refusal) is a new episode recorded immediately.
 */
export function postMergeEvidenceRefusalSignature(observation: PostMergeEvidenceRefusalObservation): string {
  return `${observation.gateId}:${observation.state}:${observation.reseedReason ?? "none"}`;
}

/** Fail-open reader: a malformed stored payload degrades to "no episode", never to a thrown hydration. */
export function readPostMergeEvidenceRefusalEpisode(raw: unknown): PostMergeEvidenceRefusalEpisode | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const candidate = raw as Partial<PostMergeEvidenceRefusalEpisode>;
  if (typeof candidate.signature !== "string" || !candidate.signature) return undefined;
  if (typeof candidate.lastAt !== "string" || typeof candidate.firstAt !== "string") return undefined;
  if (!Number.isFinite(Date.parse(candidate.lastAt)) || !Number.isFinite(Date.parse(candidate.firstAt))) return undefined;
  const count = typeof candidate.refusalCount === "number" && Number.isFinite(candidate.refusalCount)
    ? Math.max(0, Math.floor(candidate.refusalCount))
    : 0;
  return {
    signature: candidate.signature,
    lastAt: candidate.lastAt,
    firstAt: candidate.firstAt,
    refusalCount: count,
    ...(typeof candidate.gateId === "string" ? { gateId: candidate.gateId } : {}),
    ...(typeof candidate.state === "string" ? { state: candidate.state } : {}),
    ...(typeof candidate.reseedReason === "string" ? { reseedReason: candidate.reseedReason } : {}),
  };
}

/** Outcome of one episode pass: whether to record, and what to persist when the answer is yes. */
export interface PostMergeEvidenceRefusalDecision {
  /** True when this refusal may produce a record (audit row + one History line). */
  write: boolean;
  /** The episode to persist when `write` is true; absent when the refusal is already recorded. */
  episode?: PostMergeEvidenceRefusalEpisode;
  /** True when this is a refresh of an already-open episode rather than a new one. */
  refresh: boolean;
}

/**
 * Decide whether this pass may record the refusal, and produce the episode to store.
 *
 * A different signature is a NEW episode and always records. The same signature records again only after
 * `floorMs` has elapsed since `lastAt`, which bounds an unchanged refusal to one record per floor regardless
 * of how often the finalize lane polls.
 */
export function decidePostMergeEvidenceRefusal(
  existing: PostMergeEvidenceRefusalEpisode | undefined,
  observation: PostMergeEvidenceRefusalObservation,
  observedAt: number = Date.now(),
  floorMs: number = POST_MERGE_EVIDENCE_REFUSAL_REFRESH_FLOOR_MS,
): PostMergeEvidenceRefusalDecision {
  const signature = postMergeEvidenceRefusalSignature(observation);
  const now = new Date(observedAt).toISOString();
  const shape = {
    signature,
    ...(observation.gateId ? { gateId: observation.gateId } : {}),
    ...(observation.state ? { state: observation.state } : {}),
    ...(observation.reseedReason ? { reseedReason: observation.reseedReason } : {}),
  };

  if (existing && existing.signature !== signature) {
    return { write: true, refresh: false, episode: { ...shape, lastAt: now, firstAt: now, refusalCount: 1 } };
  }

  const lastAtMs = existing ? Date.parse(existing.lastAt) : Number.NaN;
  if (existing && Number.isFinite(lastAtMs) && observedAt - lastAtMs < floorMs) {
    return { write: false, refresh: false };
  }

  return {
    write: true,
    // A first record opens an episode; only a later record of the SAME refusal is a refresh.
    refresh: existing !== undefined,
    episode: {
      ...shape,
      lastAt: now,
      // Same refusal, better timing: the start of the wait is the first observation, not the last one.
      firstAt: existing?.firstAt ?? now,
      refusalCount: (existing?.refusalCount ?? 0) + 1,
    },
  };
}

/** Elapsed duration of an episode, from the ONE field that proves its start. Never `updatedAt` (RUFU-350). */
export function postMergeEvidenceRefusalAgeMs(
  episode: PostMergeEvidenceRefusalEpisode,
  now: number = Date.now(),
): number {
  const first = Date.parse(episode.firstAt);
  if (!Number.isFinite(first)) return 0;
  return Math.max(0, now - first);
}

/**
 * Key-preserving clear patch. `moves.ts`'s existing column-change rule is the sanctioned release site for
 * this key; a whole-`sourceMetadata` write would orphan `duplicateOf`, `handoffFrom`, and the RUFU-273 /
 * RUFU-393 episodes that share the field.
 */
export function clearPostMergeEvidenceRefusalPatch(): Record<string, unknown> {
  return { [POST_MERGE_EVIDENCE_REFUSAL_METADATA_KEY]: null };
}
