/*
FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
`tasks.log` was the single heaviest column on the live board (31.4 MB of 73.6 MB, 42.7% of live-row
bytes over 2 417 rows) and the only reason a board refresh had to read it: five read-time derivations
(`computeTimedExecutionMs`, `detectStalledReview`, `hasRecentReasonDrivenStall`,
`getLatestLogTimestamp`, `countRecentIdenticalStallEntries`) consume it. A SQL-side derivation of the
same five signals was prototyped, proven equivalent (482 709 entries → 12 939 kept) and REJECTED on
cost: 4.5-11.5 s of PostgreSQL CPU per full-board read, because locating `[timing]` entries or the max
timestamp forces per-row jsonb expansion and ANY per-row touch of `log` decompresses the whole 31 MB
(no-`log` baseline: 0.2-0.35 s). The rejected shape is therefore off the table permanently: a
derivation of these signals may only run where the full log is already in memory — at WRITE time.

This module owns that write-time derivation. It is a pure function of the whole log array (never an
append delta) so a wholesale `task.log = []` rewrite is correct by construction, and its output is
carried by two narrow columns: `tasks.timing_total_ms` and `tasks.log_recent`.

Two implementations of the same rules exist on purpose: this TypeScript one (the write seam) and
`project.fusion_task_log_projections()` in migration 0092 (the one-time backfill only). They are held
equal by `__tests__/postgres/task-log-projections.pg.test.ts`; neither may be edited without the other.

The projection is a TIMESTAMP-SIGNAL ENVELOPE, not a slice of the log. A slice cannot reproduce two of
the five rules provably: `getLatestLogTimestamp` is a MAX over the WHOLE log (a tail slice loses the
max when timestamps are non-monotonic), and `detectStalledReview` matches
`STALLED_REVIEW_INVALID_TRANSITION_PATTERN` against `outcome` too, which is capped at 4 000 chars per
entry — so any truncated-outcome slice is not match-equivalent. Storing signals instead keeps every
pattern match running against full text, where the full text still exists: at write time.
*/

import type { TaskLogEntry } from "../types.js";
import { computeTimedExecutionMs } from "../tasks/log-timing.js";
import {
  IN_REVIEW_STALL_LOG_PREFIX,
  type InReviewStallCode,
  type InReviewStallSignal,
} from "../tasks/in-review-stall.js";
import {
  STALLED_REVIEW_INVALID_TRANSITION_PATTERN,
  STALLED_REVIEW_INVALID_TRANSITION_THRESHOLD,
  STALLED_REVIEW_REENQUEUE_PATTERN,
  STALLED_REVIEW_REENQUEUE_THRESHOLD,
  STALLED_REVIEW_WINDOW_MS,
  type StalledReviewSignal,
} from "../tasks/stalled-review-detector.js";

/** Envelope shape version. A reader that cannot recognise the version treats it as absent. */
export const LOG_RECENT_SCHEMA_VERSION = 1;

/**
 * The byte ceiling the envelope must respect. PostgreSQL diverts a value out of line once the tuple
 * passes `toast_tuple_threshold` (default 2040 bytes), and the whole point of `log_recent` is that a
 * board read never pays a TOAST fetch — an envelope that overflows reintroduces exactly the read
 * amplification this task exists to remove. Asserted against the worst-case fixture in the pg test.
 */
export const LOG_RECENT_INLINE_BYTE_BUDGET = 2_040;

/**
 * Per-array ceilings — they exist because the byte budget is finite, and they are made honest by a
 * companion `…NewestDroppedAt` marker: a reader whose window starts before that boundary CANNOT prove
 * its answer from the envelope, and the resolver says so through `provablyComplete`.
 *
 * FNXC:TaskLogProjections 2026-10-10-23:07 (RUFU-636): as shipped, no reader consumes that flag. The
 * board feed selects `log` or it does not BEFORE the rows arrive, so it has no per-row fallback to make;
 * an unprovable envelope therefore answers from what it holds (a `stalledReview` matchCount can be
 * understated, never invented upward past the stored array). RUFU-636 either makes the read refuse — a
 * board-level sufficiency gate over `log_recent`, which never touches `log` — or documents the flag as
 * informational. Do not re-add the words "keeps the `log` column" here unless the reader really does.
 * Both thresholds these signals feed are 3 and 2, so a cap of 16 covers any reportable episode with headroom.
 */
export const LOG_RECENT_MATCH_ARRAY_CAP = 16;
export const LOG_RECENT_TAIL_ARRAY_CAP = 16;

/** Ceiling on the stored trailing-run reason; a longer reason is marked truncated, never silently clipped. */
export const LOG_RECENT_TAIL_REASON_MAX_CHARS = 200;

/** Column names, exported so the descriptor, the migration and the guard test cite one source. */
export const TASK_TIMING_TOTAL_MS_COLUMN = "timingTotalMs";
export const TASK_LOG_RECENT_COLUMN = "logRecent";

export interface TaskLogRecentEnvelope {
  v: number;
  /** Verbatim `timestamp` string of the entry holding the MAX parseable timestamp over the WHOLE log. */
  latestAt: string | null;
  /** Verbatim `timestamp` string of the newest parseable `In-review stall surfaced [` entry. */
  stallSurfacedAt: string | null;
  /** Entries whose `timestamp` failed the shared strict parse rule — the envelope's own sufficiency proof. */
  unparseableCount: number;
  /** Re-enqueue-churn match timestamps in log-array order (the reader's `firstMatchAt` is array order, not time order). */
  reenqueueAt: string[];
  reenqueueNewestDroppedAt: number | null;
  invalidTransitionAt: string[];
  invalidTransitionNewestDroppedAt: number | null;
  tailCode: string | null;
  tailReason: string | null;
  tailReasonTruncated: boolean;
  tailCount: number;
  /** Trailing-run timestamps in WALK order (newest first), which is what the reader consumes. */
  tailAt: string[];
  tailTruncated: boolean;
}

export interface TaskLogProjections {
  timingTotalMs: number;
  logRecent: TaskLogRecentEnvelope;
}

/*
FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
THE SHARED TIMESTAMP RULE. Both implementations parse timestamps with this shape and NOTHING else,
because `Date.parse` is implementation-defined (`"2026-10-10 19:13"` parses in V8 and reads differently
in PostgreSQL) and an equivalence proof cannot rest on it. Strict ISO-8601 with an explicit `Z` or
`±HH:MM` offset, calendar-validated, result in milliseconds = floor(microseconds / 1000). Anything
else is an unparseable entry: excluded from the envelope AND counted, and that count is what tells a
reader the envelope cannot prove its answer.
*/
const ISO_8601_STRICT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** @returns milliseconds since the epoch, or `null` when the string is not a strictly-valid UTC instant. */
export function parseProjectionTimestamp(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = ISO_8601_STRICT.exec(raw);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12) return null;
  // Year 0099 means 1900 to the JavaScript Date constructor and 99 to PostgreSQL, so both reject it.
  if (year < 1000) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  // Leap seconds are rejected rather than normalised: PostgreSQL's cast would shift the instant, and a
  // silent one-second disagreement between the two implementations is worse than an unparseable entry.
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMinutes = 0;
  const zone = m[8]!;
  if (zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const offHour = Number(zone.slice(1, 3));
    const offMinute = Number(zone.slice(4, 6));
    if (offHour > 23 || offMinute > 59) return null;
    offsetMinutes = sign * (offHour * 60 + offMinute);
  }
  // Extra fractional digits are truncated toward zero, matching the SQL side's microsecond floor.
  const frac = m[7] ?? "";
  const microseconds = frac.length === 0 ? 0 : Number(frac.padEnd(6, "0").slice(0, 6));
  const base = Date.UTC(year, month - 1, day, hour, minute, second, 0) - offsetMinutes * 60_000;
  if (!Number.isFinite(base)) return null;
  return base + Math.floor(microseconds / 1000);
}

/** A matched entry kept for a windowed rule; `ord` preserves log-array order across the retention cut. */
interface MatchCandidate {
  readonly ord: number;
  readonly timestamp: string;
  readonly tsMs: number;
}

/**
 * Retain the `cap` candidates with the LARGEST timestamps and return them in log-array order, so a
 * window filter applied to them reproduces the reader's `filter()` order — `firstMatchAt` and
 * `lastMatchAt` are array-order values and both reach the operator-visible reason sentence.
 */
function retainNewestInArrayOrder(candidates: MatchCandidate[], cap: number): { kept: MatchCandidate[]; newestDroppedAt: number | null } {
  if (candidates.length <= cap) return { kept: candidates, newestDroppedAt: null };
  const byTime = [...candidates].sort((a, b) => b.tsMs - a.tsMs);
  const keptSet = new Set(byTime.slice(0, cap));
  return {
    kept: candidates.filter((c) => keptSet.has(c)),
    // Every dropped candidate is older than every kept one, so the newest dropped one IS the boundary.
    newestDroppedAt: byTime[cap]?.tsMs ?? null,
  };
}

/** Empty envelope: what a row with no usable log entries carries. The SQL backfill produces the same value. */
export function emptyTaskLogRecent(): TaskLogRecentEnvelope {
  return {
    v: LOG_RECENT_SCHEMA_VERSION,
    latestAt: null,
    stallSurfacedAt: null,
    unparseableCount: 0,
    reenqueueAt: [],
    reenqueueNewestDroppedAt: null,
    invalidTransitionAt: [],
    invalidTransitionNewestDroppedAt: null,
    tailCode: null,
    tailReason: null,
    tailReasonTruncated: false,
    tailCount: 0,
    tailAt: [],
    tailTruncated: false,
  };
}

interface DerivableEntry {
  action: string;
  outcome: string;
  timestamp: string;
}

/*
FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
THE MALFORMED-`log` CONTRACT, mirrored rather than invented. `rowToTask` assigns
`fromJson<TaskLogEntry[]>(row.log) || []` and `pgRowToTaskRow` has already re-`JSON.stringify`-ed every
non-string jsonb value — so a jsonb-typed `string` (one live row has one today) arrives as a JS STRING
and every reader iterates it character-wise and finds nothing. A non-array log therefore derives the
empty envelope, which is exactly what `jsonb_typeof(log) <> 'array'` means on the SQL side. Neither
implementation repairs the row.
*/
function toDerivableEntries(log: unknown): DerivableEntry[] {
  if (!Array.isArray(log)) return [];
  const entries: DerivableEntry[] = [];
  for (const raw of log) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    entries.push({
      action: typeof entry.action === "string" ? entry.action : "",
      outcome: typeof entry.outcome === "string" ? entry.outcome : "",
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
    });
  }
  return entries;
}

/*
FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
`countRecentIdenticalStallEntries` walks the log BACKWARDS and stops at the first entry that is not a
stall entry of the SAME code and reason as the live signal. That makes the answer a property of the
trailing run alone: if the newest trailing stall entry does not match the signal the count is 0, and
when it does match, "matches the live signal" and "matches the newest trailing entry" are the same
predicate. So the write seam computes the run against the newest entry's own identity and the reader
only has to test the live signal against the stored identity.
*/
function deriveStallTail(entries: DerivableEntry[]): Pick<
  TaskLogRecentEnvelope,
  "tailCode" | "tailReason" | "tailReasonTruncated" | "tailCount" | "tailAt" | "tailTruncated"
> {
  const none = { tailCode: null as string | null, tailReason: null as string | null, tailReasonTruncated: false, tailCount: 0, tailAt: [] as string[], tailTruncated: false };
  const last = entries[entries.length - 1];
  if (!last) return none;
  const code = stallCodeOfEntry(last.action);
  if (code === null) return none;
  const reason = (stallReasonOfEntry(last.action) ?? "").trim();
  let count = 0;
  const at: string[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (stallCodeOfEntry(entry.action) !== code) break;
    if ((stallReasonOfEntry(entry.action) ?? "").trim() !== reason) break;
    count += 1;
    // Walk order is newest-first, so the retained array is exactly the prefix the reader would walk.
    if (at.length < LOG_RECENT_TAIL_ARRAY_CAP) at.push(entry.timestamp);
  }
  return {
    tailCode: code,
    tailReason: reason.length > LOG_RECENT_TAIL_REASON_MAX_CHARS
      ? reason.slice(0, LOG_RECENT_TAIL_REASON_MAX_CHARS)
      : reason,
    tailReasonTruncated: reason.length > LOG_RECENT_TAIL_REASON_MAX_CHARS,
    tailCount: count,
    tailAt: at,
    tailTruncated: count > LOG_RECENT_TAIL_ARRAY_CAP,
  };
}

/** `In-review stall surfaced [<code>]: <reason>` — the shape a surfaced stall is logged in. */
function stallCodeOfEntry(action: string): string | null {
  if (!action.startsWith(IN_REVIEW_STALL_LOG_PREFIX)) return null;
  const rest = action.slice(IN_REVIEW_STALL_LOG_PREFIX.length);
  const close = rest.indexOf("]");
  if (close <= 0) return null;
  return rest.slice(0, close);
}

function stallReasonOfEntry(action: string): string | null {
  const code = stallCodeOfEntry(action);
  if (code === null) return null;
  return action.slice(`${IN_REVIEW_STALL_LOG_PREFIX}${code}]:`.length);
}

/** The pure write-time derivation. Called from the column descriptors and from every log-writing UPDATE seam. */
export function deriveTaskLogProjections(log: unknown): TaskLogProjections {
  const entries = toDerivableEntries(log);
  // One shared `[timing]` arithmetic: the reader's exported function, never a second implementation.
  const timingTotalMs = computeTimedExecutionMs(entries as TaskLogEntry[]);

  let latestAt: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  let stallSurfacedAt: string | null = null;
  let stallSurfacedMs = Number.NEGATIVE_INFINITY;
  let unparseableCount = 0;
  const reenqueue: MatchCandidate[] = [];
  const invalidTransition: MatchCandidate[] = [];

  for (let ord = 0; ord < entries.length; ord += 1) {
    const entry = entries[ord]!;
    const tsMs = parseProjectionTimestamp(entry.timestamp);
    if (tsMs === null) {
      unparseableCount += 1;
      continue;
    }
    // Independent tests, exactly as the reader runs them: one entry can match both heuristics.
    if (entry.action.includes(STALLED_REVIEW_REENQUEUE_PATTERN)) {
      reenqueue.push({ ord, timestamp: entry.timestamp, tsMs });
    }
    if (
      STALLED_REVIEW_INVALID_TRANSITION_PATTERN.test(entry.action)
      || STALLED_REVIEW_INVALID_TRANSITION_PATTERN.test(entry.outcome)
    ) {
      invalidTransition.push({ ord, timestamp: entry.timestamp, tsMs });
    }
    if (tsMs > latestMs) {
      latestMs = tsMs;
      latestAt = entry.timestamp;
    }
    if (entry.action.startsWith(IN_REVIEW_STALL_LOG_PREFIX) && tsMs > stallSurfacedMs) {
      stallSurfacedMs = tsMs;
      stallSurfacedAt = entry.timestamp;
    }
  }

  const reenqueueRetained = retainNewestInArrayOrder(reenqueue, LOG_RECENT_MATCH_ARRAY_CAP);
  const invalidRetained = retainNewestInArrayOrder(invalidTransition, LOG_RECENT_MATCH_ARRAY_CAP);

  return {
    timingTotalMs,
    logRecent: {
      v: LOG_RECENT_SCHEMA_VERSION,
      latestAt,
      stallSurfacedAt,
      unparseableCount,
      reenqueueAt: reenqueueRetained.kept.map((c) => c.timestamp),
      reenqueueNewestDroppedAt: reenqueueRetained.newestDroppedAt,
      invalidTransitionAt: invalidRetained.kept.map((c) => c.timestamp),
      invalidTransitionNewestDroppedAt: invalidRetained.newestDroppedAt,
      ...deriveStallTail(entries),
    },
  };
}

/**
 * JSON string for the SQLite-shaped descriptor. Derived for ANY value the column can hold, including
 * `null` and a non-array, because the backfill derives the empty envelope for those rows too — a row
 * whose `log` is NULL still has to be answered from `log_recent` once the reader stops loading `log`.
 */
export function serializeTaskLogRecent(log: unknown): string {
  return JSON.stringify(deriveTaskLogProjections(log).logRecent);
}

/** Defensive read of the jsonb column: an unknown or future shape reads as absent, never as a partial truth. */
export function parseTaskLogRecent(value: unknown): TaskLogRecentEnvelope | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  if (raw.v !== LOG_RECENT_SCHEMA_VERSION) return null;
  const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    v: LOG_RECENT_SCHEMA_VERSION,
    latestAt: typeof raw.latestAt === "string" ? raw.latestAt : null,
    stallSurfacedAt: typeof raw.stallSurfacedAt === "string" ? raw.stallSurfacedAt : null,
    unparseableCount: typeof raw.unparseableCount === "number" ? raw.unparseableCount : 0,
    reenqueueAt: strArray(raw.reenqueueAt),
    reenqueueNewestDroppedAt: typeof raw.reenqueueNewestDroppedAt === "number" ? raw.reenqueueNewestDroppedAt : null,
    invalidTransitionAt: strArray(raw.invalidTransitionAt),
    invalidTransitionNewestDroppedAt: typeof raw.invalidTransitionNewestDroppedAt === "number" ? raw.invalidTransitionNewestDroppedAt : null,
    tailCode: typeof raw.tailCode === "string" ? raw.tailCode : null,
    tailReason: typeof raw.tailReason === "string" ? raw.tailReason : null,
    tailReasonTruncated: raw.tailReasonTruncated === true,
    tailCount: typeof raw.tailCount === "number" ? raw.tailCount : 0,
    tailAt: strArray(raw.tailAt),
    tailTruncated: raw.tailTruncated === true,
  };
}

/*
FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
THE WRITE PAIRING INVARIANT — no SQL statement may write `log` without also writing
`timing_total_ms` and `log_recent`. This is the single helper every targeted log-writing UPDATE seam
uses; the full-row path gets the same values from the column descriptors.
`__tests__/task-log-projection-pairing.test.ts` holds the seam list, because a raw
`tx.update(tasks).set({ log })` that skips this call silently drifts the projection, and a badge then
disagrees with the card it came from.
*/
export function withTaskLogProjections<T extends Record<string, unknown>>(updates: T): Record<string, unknown> {
  // `undefined` is how Drizzle spells "do not touch this column", so pairing must not fire for it —
  // writing a fresh envelope while leaving `log` alone is exactly the drift this invariant prevents.
  if (!("log" in updates) || updates.log === undefined) return updates;
  const derived = deriveTaskLogProjections(updates.log);
  return {
    ...updates,
    [TASK_TIMING_TOTAL_MS_COLUMN]: derived.timingTotalMs,
    [TASK_LOG_RECENT_COLUMN]: derived.logRecent,
  };
}

/* ------------------------------------------------------------------ *
 * Reader-side resolvers. Each one answers "can this envelope PROVE the answer a full-log read would
 * have produced?" through `provablyComplete`. The answer to "what does a caller do with it" is, today,
 * nothing: every production reader ignores the flag (RUFU-636). What a caller CANNOT do is re-read the
 * `log` column per row, because a log-free caller did not select it — the only honest fallback is
 * board-level and precedes the SELECT. Treat the flag as derivation metadata until RUFU-636 lands.
 * ------------------------------------------------------------------ */

/** What the envelope may stand in for. `logLoaded` stays the caller's authority, defaulting to true. */
export interface TaskLogProjectionInput {
  /** The row carried the `log` column — the log-based path wins and stays byte-identical to today. */
  logLoaded?: boolean;
  projection?: TaskLogRecentEnvelope | null;
}

/** Opt-in by construction: absent input or a loaded log means today's code path, so no existing caller changes. */
export function projectionOverride(input: TaskLogProjectionInput | undefined): TaskLogRecentEnvelope | null {
  if (input?.logLoaded !== false) return null;
  return input.projection ?? null;
}

export interface StalledReviewProjectionResult {
  signal: Omit<StalledReviewSignal, "reason"> | undefined;
  /** False when the envelope cannot prove the window's contents — only a loaded `log` may answer. */
  provablyComplete: boolean;
}

/**
 * Windowed `detectStalledReview` arithmetic over the stored match timestamps. Both patterns and both
 * thresholds are the detector's own; the envelope only records WHICH entries matched, because only
 * the writer ever sees an uncapped `outcome`.
 */
export function stalledReviewFromProjection(
  envelope: TaskLogRecentEnvelope,
  options: { now?: number; windowMs?: number },
): StalledReviewProjectionResult {
  if (envelope.unparseableCount > 0) return { signal: undefined, provablyComplete: false };
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? STALLED_REVIEW_WINDOW_MS;
  const windowStart = now - windowMs;
  const indicesInWindow = (list: string[]): number[] => {
    const out: number[] = [];
    for (let i = 0; i < list.length; i += 1) {
      const ms = parseProjectionTimestamp(list[i]);
      if (ms !== null && ms >= windowStart && ms <= now) out.push(i);
    }
    return out;
  };
  const reenqueueHits = indicesInWindow(envelope.reenqueueAt);
  const invalidHits = indicesInWindow(envelope.invalidTransitionAt);
  const provablyComplete =
    (envelope.reenqueueNewestDroppedAt === null || envelope.reenqueueNewestDroppedAt < windowStart)
    && (envelope.invalidTransitionNewestDroppedAt === null || envelope.invalidTransitionNewestDroppedAt < windowStart);

  if (reenqueueHits.length >= STALLED_REVIEW_REENQUEUE_THRESHOLD) {
    return {
      provablyComplete,
      signal: {
        heuristic: "reenqueue-churn",
        matchCount: reenqueueHits.length,
        firstMatchAt: envelope.reenqueueAt[reenqueueHits[0]!] ?? "",
        lastMatchAt: envelope.reenqueueAt[reenqueueHits[reenqueueHits.length - 1]!] ?? "",
      },
    };
  }
  if (invalidHits.length >= STALLED_REVIEW_INVALID_TRANSITION_THRESHOLD) {
    return {
      provablyComplete,
      signal: {
        heuristic: "invalid-transition-loop",
        matchCount: invalidHits.length,
        firstMatchAt: envelope.invalidTransitionAt[invalidHits[0]!] ?? "",
        lastMatchAt: envelope.invalidTransitionAt[invalidHits[invalidHits.length - 1]!] ?? "",
      },
    };
  }
  return { signal: undefined, provablyComplete };
}

/** MAX-over-whole-log timestamp; `-Infinity` mirrors the log-based helper's "no candidate" answer. */
export function latestLogTimestampFromProjection(envelope: TaskLogRecentEnvelope): { ms: number; provablyComplete: boolean } {
  if (envelope.unparseableCount > 0) return { ms: Number.NEGATIVE_INFINITY, provablyComplete: false };
  if (envelope.latestAt === null) return { ms: Number.NEGATIVE_INFINITY, provablyComplete: true };
  const ms = parseProjectionTimestamp(envelope.latestAt);
  return { ms: ms ?? Number.NEGATIVE_INFINITY, provablyComplete: ms !== null };
}

/** MAX ts over the stall prefix; the caller applies the LIVE threshold — a setting is never baked into the column. */
export function stallSurfacedAtFromProjection(envelope: TaskLogRecentEnvelope): { ms: number | null; provablyComplete: boolean } {
  if (envelope.unparseableCount > 0) return { ms: null, provablyComplete: false };
  if (envelope.stallSurfacedAt === null) return { ms: null, provablyComplete: true };
  const ms = parseProjectionTimestamp(envelope.stallSurfacedAt);
  return { ms, provablyComplete: ms !== null };
}

export interface IdenticalStallProjectionResult {
  count: number;
  /** False when the stored run identity cannot be proved equal to (or different from) the live signal. */
  provablyComplete: boolean;
}

/**
 * Trailing-run answer. `signal` is the LIVE stall signal the caller just computed; the run was keyed on
 * the newest trailing stall entry's own identity, so an identity test is the whole decision.
 */
export function countIdenticalStallFromProjection(
  envelope: TaskLogRecentEnvelope,
  signal: Pick<InReviewStallSignal, "code" | "reason">,
  progressAt?: number,
): IdenticalStallProjectionResult {
  const trimmedReason = signal.reason.trim();
  if (envelope.tailCode === null || envelope.tailCount === 0) return { count: 0, provablyComplete: true };
  if (envelope.tailCode !== signal.code) return { count: 0, provablyComplete: true };
  if (envelope.tailReasonTruncated) {
    // A clipped reason cannot prove equality; it can still disprove it when the live reason diverges.
    if (!trimmedReason.startsWith(envelope.tailReason ?? "")) return { count: 0, provablyComplete: true };
    return { count: 0, provablyComplete: false };
  }
  if ((envelope.tailReason ?? "") !== trimmedReason) return { count: 0, provablyComplete: true };
  let count = 0;
  for (const ts of envelope.tailAt) {
    const observedAt = parseProjectionTimestamp(ts);
    if (progressAt !== undefined && observedAt !== null && progressAt > observedAt) break;
    count += 1;
  }
  return {
    count,
    provablyComplete: !envelope.tailTruncated && envelope.unparseableCount === 0 && count === envelope.tailCount,
  };
}

export function stallReasonOfTaskLogEntry(action: string): string | null {
  return stallReasonOfEntry(action);
}

export function stallCodeOfTaskLogEntry(action: string): InReviewStallCode | null {
  return stallCodeOfEntry(action) as InReviewStallCode | null;
}
