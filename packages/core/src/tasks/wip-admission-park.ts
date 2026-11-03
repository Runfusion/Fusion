/*
FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
The read/write contract for the durable withheld-hold->WIP-crossing episode, in the shape RUFU-273
established for `planAdmissionStall`: one module holding BOTH halves so a writer and the read path can
never drift, one fixed refresh floor owned by code rather than by a setting, and a decision function
that returns NOTHING when a write would add no information.

Why each rule below exists is measured on the card this task implements:

- **Signature stability.** RUFU-442 deployed a first cut of a bound that keyed on the continuation
  identity and re-reported every cycle of the loop it was meant to bound (SANE-556, 7 identical
  `(parse, capacity)` waits in 4 minutes) — in a re-dispatch loop the continuation row is re-installed
  each pass, so those fields churn by construction. `wipAdmissionParkSignature` therefore contains only
  node / reason / column boundary / refusing-source enum / pool id / occupancy VERDICT. RUFU-372
  separately proved counts fluctuate within one ongoing wait, so `occupants`/`limit` ride in the
  episode as forensics and are deliberately absent from the signature.
- **The floor.** The pre-fix emitter fired at the poll rate forever: ~3 refusals per minute for 2 d 19 h
  on one card (16 536 rows), 973 rows/32 cards/6 h on another. A refresh floor of
  `WIP_ADMISSION_STALL_REFRESH_FLOOR_MS` bounds an unchanged episode to 4 rows/hour/card — arithmetic a
  test pins, not a hope.
- **Age comes from `firstAt`, never `updatedAt`.** RUFU-350 measured that naming a card bumps the shared
  row clock, so an age claim built on `updatedAt` retracts its own badge one pass after it appeared.
- **Fail-open validation.** This episode is read on every task hydration. A stored payload with an
  unknown `code` or a non-ISO timestamp degrades to "no episode" rather than surfacing a code the
  dashboard has no copy for — the same posture `readPlanAdmissionStallEpisode` takes.
*/
import {
  WIP_ADMISSION_STALL_METADATA_KEY,
  type TaskWipAdmissionStallCode,
  type TaskWipAdmissionStallEpisode,
} from "../types.js";

/**
 * How much a gate's label tells an operator. Used to stop a less informed observation from overwriting
 * a more informed one — see `wipAdmissionStallWrite`'s precedence arm.
 *
 * `scheduler-seam` is deliberately the least specific value: it means only "the graph declined to move",
 * which the hold/release sweep routinely refines into "the column is at its limit" or "the card is not
 * planned yet". The two writers observe the SAME wait at different precision, and whichever polls last
 * would otherwise own the label — so the label would flicker between "no pool was consulted" and "the
 * pool is full" on one unchanged condition, which is RUFU-372's two-shapes-one-label defect re-created
 * one level up.
 */
const WIP_ADMISSION_GATE_SPECIFICITY: Record<TaskWipAdmissionStallCode, number> = {
  "scheduler-seam": 0,
  "capacity-rejection-without-facts": 1,
  "awaiting-planning": 2,
  "awaiting-approval": 2,
  "no-downstream-capacity-column": 3,
  "move-rejected-or-no-slot": 3,
  "downstream-full": 4,
  "column-capacity": 4,
};

/**
 * Same wait, better information: on a refresh the gate may be sharpened, never duller. Without this the
 * label an operator sees depends on which of the two writers polled last, and the graph's `scheduler-seam`
 * would repeatedly erase the arm the hold/release sweep actually measured.
 */
function moreSpecificWipAdmissionGate(
  existing: TaskWipAdmissionStallCode,
  incoming: TaskWipAdmissionStallCode,
): TaskWipAdmissionStallCode {
  return WIP_ADMISSION_GATE_SPECIFICITY[incoming] >= WIP_ADMISSION_GATE_SPECIFICITY[existing] ? incoming : existing;
}

/**
 * Minimum spacing between two records (row write + audit row) of one card's UNCHANGED withheld
 * crossing. A changed condition always records immediately; this bounds only repetition.
 *
 * The value matches RUFU-273's `PLAN_ADMISSION_STALL_REFRESH_FLOOR_MS` deliberately: the two lanes are
 * the same fault class observed at a poll rate, and a floor that differs per lane would make the
 * operator-visible row budget depend on which gate refused rather than on the fault. At 15 min an
 * unbounded ~180 rows/hour/card becomes at most 4.
 */
export const WIP_ADMISSION_STALL_REFRESH_FLOOR_MS = 15 * 60_000;

/**
 * How long an unchanged withheld crossing must hold before it earns the card face.
 *
 * Deliberately LONGER than the refresh floor: the first park is normal scheduling and stays off the
 * chip (a capacity wait self-clears the moment a slot frees — branding routine work abnormal is how a
 * badge loses its meaning), while a refusal still holding an hour later is no longer a transient and has
 * no other announcer on the execution lane (RUFU-180's stall sweep is review-lane only, RUFU-273's is
 * planning-lane only).
 */
export const WIP_ADMISSION_STALL_ESCALATION_FLOOR_MS = 60 * 60_000;

/** Fixed vocabulary guard: a stored code outside this set is treated as no episode at all. */
const WIP_ADMISSION_STALL_CODES: readonly TaskWipAdmissionStallCode[] = [
  "scheduler-seam",
  "column-capacity",
  "capacity-rejection-without-facts",
  "downstream-full",
  "move-rejected-or-no-slot",
  "no-downstream-capacity-column",
  "awaiting-planning",
  "awaiting-approval",
];

/** True when `code` is one the row may carry. Keeps the union the single source of truth. */
export function isWipAdmissionStallCode(code: unknown): code is TaskWipAdmissionStallCode {
  return typeof code === "string" && (WIP_ADMISSION_STALL_CODES as readonly string[]).includes(code);
}

/**
 * The one signature shape for a withheld hold->WIP crossing: the boundary itself and nothing else.
 *
 * What is deliberately NOT in the identity is the whole design, and the rule is one sentence: a field may
 * enter the identity only if it cannot change while the SAME wait continues. Three candidates fail that
 * test, and each of them re-creates the row flood or destroys the age claim when included:
 *
 * - the refusing GATE and the POOL: two writers observe one wait at different precision. The graph can only
 *   ever report that the seam declined; the hold/release sweep reads the pool and the readiness probes and
 *   names the actual arm. If either were identity, arriving at better information would read as a brand-new
 *   wait — resetting `firstAt`, so a card refused for two days would suddenly report fifteen minutes.
 * - the OBSERVING NODE: the graph reports the node that declined (`parse`, say) and the release sweep has no
 *   node at all, so a sweep-authored episode would carry a sentinel and the graph's later park would look
 *   like a different wait. The node names WHO saw the refusal, not WHICH wait it is.
 *
 * Node, pool, occupants, limit, and gate therefore live on the episode as PROPERTIES that a refresh may
 * sharpen in place, while the identity stays the crossing. The engine's own regression test
 * (`wip-admission-park.test.ts > publishes a measured sweep verdict under the graph's node`) is what proved
 * the pool had to come out: with it in, the sweep's first measurement of a pool the graph never consulted
 * split one two-day wait into a fresh fifteen-minute episode.
 */
export function wipAdmissionParkSignature(input: {
  reason: string;
  fromColumn: string | null;
  toColumn: string | null;
}): string {
  return [input.reason, `${input.fromColumn ?? "-"}->${input.toColumn ?? "-"}`].join("|");
}

/** The observation a writer supplies; `signature` is computed by the caller from stable facts only. */
export interface WipAdmissionStallObservation {
  code: TaskWipAdmissionStallCode;
  signature: string;
  nodeId: string;
  fromColumn: string;
  toColumn: string;
  poolId?: string;
  occupants?: number;
  limit?: number;
  /*
  FNXC:CapacityGateFacts 2026-11-02-22:12 (RUFU-372): who holds the refused pool, and how long its
  longest-held occupant has been there. Both are forensic like `occupants`/`limit` — they never enter
  `signature` (see `wipAdmissionParkSignature`) because a holder list churns whenever any card on the
  board moves, which would restart the age of a wait that has not changed. They exist so the card face
  can answer "who is holding my slot, and for how long" from the board payload alone; absent means the
  refusal carried no holder set, which the notice renders as UNRECORDED, never as an empty pool.
  */
  heldBy?: string[];
  oldestHolderAgeMs?: number;
}

/** Upper bound on persisted holder ids. A pool's occupants can exceed any display budget, so the stored
 *  set is capped at write time — an unbounded id array in `sourceMetadata` would ride along on every
  task hydration for a card that needs five names at most. */
export const WIP_ADMISSION_HOLDER_ID_CAP = 20;

/** Normalize a writer-supplied holder list to the storable shape: task ids only, capped, `undefined`
 *  when nothing provable was supplied. An EMPTY array survives as empty — "full at zero occupancy" is a
 *  real refusal shape (limit 0) and collapsing it to undefined would erase the distinction. */
function normalizeHeldBy(heldBy: string[] | undefined): string[] | undefined {
  if (!Array.isArray(heldBy)) return undefined;
  const ids = heldBy.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  return ids.slice(0, WIP_ADMISSION_HOLDER_ID_CAP);
}

/** Normalize a holder age: a finite non-negative number, or undefined. A negative or non-finite sample
 *  (a clock skew between the writer and a holder's own row) is dropped rather than stored, because a
 *  nonsense age is worse than an unrecorded one — the notice would render it as a fact. */
function normalizeHolderAgeMs(ms: number | undefined): number | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return undefined;
  return Math.floor(ms);
}

/**
 * Read the persisted withheld-crossing episode off a row. Validation is structural, not permissive: a
 * malformed or hand-edited value degrades to silence (see the module FNXC).
 */
export function readWipAdmissionStallEpisode(
  sourceMetadata: Record<string, unknown> | undefined,
): TaskWipAdmissionStallEpisode | undefined {
  const raw = sourceMetadata?.[WIP_ADMISSION_STALL_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const candidate = raw as Partial<TaskWipAdmissionStallEpisode>;
  if (!isWipAdmissionStallCode(candidate.code)) return undefined;
  if (typeof candidate.signature !== "string" || candidate.signature.length === 0) return undefined;
  if (typeof candidate.nodeId !== "string" || candidate.nodeId.length === 0) return undefined;
  if (typeof candidate.fromColumn !== "string" || typeof candidate.toColumn !== "string") return undefined;
  if (typeof candidate.lastAt !== "string" || typeof candidate.firstAt !== "string") return undefined;
  if (Number.isNaN(Date.parse(candidate.lastAt)) || Number.isNaN(Date.parse(candidate.firstAt))) return undefined;
  if (typeof candidate.stallCount !== "number" || !Number.isFinite(candidate.stallCount)) return undefined;
  /*
  FNXC:CapacityGateFacts 2026-11-02-22:12 (RUFU-372):
  The holder forensics are the ONE place this reader degrades a FIELD instead of the whole episode, and
  the asymmetry is deliberate. The episode's identity fields are load-bearing for a lifecycle bound, so
  a malformed one means the payload is not an episode at all. A holder list or age is decoration on a
  valid episode: an older writer, a hand-edited row, or a partial JSON round-trip must not silence the
  wait notice itself — it loses the names and keeps the truth that the card is being refused. Dropped
  values read back as absent, which every consumer renders as "not recorded".
  */
  const heldBy = Array.isArray(candidate.heldBy)
    ? candidate.heldBy.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : undefined;
  const oldestHolderAgeMs = typeof candidate.oldestHolderAgeMs === "number"
      && Number.isFinite(candidate.oldestHolderAgeMs)
      && candidate.oldestHolderAgeMs >= 0
    ? candidate.oldestHolderAgeMs
    : undefined;
  const { heldBy: _rawHeldBy, oldestHolderAgeMs: _rawAge, ...rest } = candidate;
  return {
    ...(rest as TaskWipAdmissionStallEpisode),
    ...(heldBy ? { heldBy } : {}),
    ...(oldestHolderAgeMs !== undefined ? { oldestHolderAgeMs } : {}),
  };
}

/**
 * Decide whether an observation justifies a record, and produce the episode to write.
 *
 * Returns `undefined` when the write must be skipped — an unchanged episode inside the refresh floor.
 * The caller writes the returned episode through `sourceMetadataPatch` keyed by
 * `WIP_ADMISSION_STALL_METADATA_KEY`, which is what keeps every unrelated provenance key alive.
 *
 * `stallCount` resets when the SIGNATURE changes (a genuinely different wait, which must record
 * immediately) and `firstAt` is preserved across refreshes of the same signature, so an episode that
 * has run for two days reads as two days old rather than as fifteen minutes old.
 */
export function wipAdmissionStallWrite(
  existing: TaskWipAdmissionStallEpisode | undefined,
  observation: WipAdmissionStallObservation,
  observedAt: number = Date.now(),
): TaskWipAdmissionStallEpisode | undefined {
  const now = new Date(observedAt).toISOString();
  const forensics = {
    ...(observation.poolId !== undefined ? { poolId: observation.poolId } : {}),
    ...(observation.occupants !== undefined ? { occupants: observation.occupants } : {}),
    ...(observation.limit !== undefined ? { limit: observation.limit } : {}),
    ...(normalizeHeldBy(observation.heldBy) !== undefined ? { heldBy: normalizeHeldBy(observation.heldBy) } : {}),
    ...(normalizeHolderAgeMs(observation.oldestHolderAgeMs) !== undefined
      ? { oldestHolderAgeMs: normalizeHolderAgeMs(observation.oldestHolderAgeMs) }
      : {}),
  };
  const shape = {
    code: observation.code,
    signature: observation.signature,
    nodeId: observation.nodeId,
    fromColumn: observation.fromColumn,
    toColumn: observation.toColumn,
    ...forensics,
  };

  // A different wait is a new episode: it restarts the clock and resets the repeat counter.
  if (existing && existing.signature !== observation.signature) {
    return { ...shape, lastAt: now, firstAt: now, stallCount: 1 };
  }

  const lastAtMs = existing ? Date.parse(existing.lastAt) : Number.NaN;
  if (existing && Number.isFinite(lastAtMs) && observedAt - lastAtMs < WIP_ADMISSION_STALL_REFRESH_FLOOR_MS) {
    return undefined;
  }

  return {
    ...shape,
    // Same wait, better information: the gate may be sharpened, never duller. See the specificity table.
    code: existing ? moreSpecificWipAdmissionGate(existing.code, observation.code) : observation.code,
    lastAt: now,
    firstAt: existing?.firstAt ?? now,
    stallCount: (existing?.stallCount ?? 0) + 1,
  };
}

/**
 * The key-preserving clear patch for the episode. Writers must use this rather than touching
 * `sourceMetadata` wholesale — a whole-field wipe would orphan `duplicateOf`, `handoffFrom`, and the
 * RUFU-273 planning episode alongside it.
 */
export function clearWipAdmissionStallPatch(): Record<string, unknown> {
  return { [WIP_ADMISSION_STALL_METADATA_KEY]: null };
}

/** Elapsed wait of an episode, measured from the ONE field that proves the start. Never `updatedAt`. */
export function wipAdmissionStallAgeMs(
  episode: TaskWipAdmissionStallEpisode,
  now: number = Date.now(),
): number {
  const first = Date.parse(episode.firstAt);
  if (!Number.isFinite(first)) return 0;
  return Math.max(0, now - first);
}

/** Compact, translator-free elapsed rendering (`2 d 4 h`, `53 m`) shared by every surface. */
export function formatWipAdmissionStallWait(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} m`;
  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
}
