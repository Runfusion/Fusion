/**
 * Typed transition contract (U3).
 *
 * `moveTaskInternal` (the single transition authority, KTD-3/R13) stops throwing
 * bare strings on a rejected move and instead returns a typed {@link TransitionResult}.
 * The rejection shape is shared verbatim across surfaces — the dashboard drop
 * handler, the CLI, the HTTP move endpoint, and the recovery sweep — so every
 * caller speaks one rejection contract. Because the rejection crosses the HTTP
 * API boundary, the type is intentionally a flat, JSON-safe object (no class
 * instances, no functions, no `undefined`-only fields that would survive a JSON
 * round-trip differently than declared) and ships with explicit
 * (de)serialization helpers below.
 *
 * The {@link TransitionPending} marker is the crash-safe hook protocol (KTD-2/KTD-9):
 * it is written in the same SQLite transaction as the column change and records
 * which post-commit, idempotent enter/exit hooks still owe execution. A crash
 * mid-transition leaves the marker behind; the recovery sweep re-reads it from
 * SQLite (the authoritative store per ADR-0001 — `task.json` is a stale follower
 * across a crash) and re-runs the remaining idempotent hooks. The marker, like
 * the rejection, crosses no class boundary and round-trips cleanly through JSON.
 */

/**
 * Reason codes for a rejected transition. Stable string literals — they are
 * persisted in audit and matched by surfaces to choose user-facing copy, so
 * they must not change without a migration of the consumers.
 */
export type TransitionRejectionCode =
  | "guard-rejected"
  | "capacity-exhausted"
  | "unknown-column"
  | "workflow-mismatch"
  | "merge-blocked";

/** The full, immutable set of rejection codes (handy for exhaustive validation). */
export const TRANSITION_REJECTION_CODES: readonly TransitionRejectionCode[] = [
  "guard-rejected",
  "capacity-exhausted",
  "unknown-column",
  "workflow-mismatch",
  "merge-blocked",
] as const;

/**
 * A typed transition rejection. Flat and JSON-safe by construction.
 *
 * - `code` — machine-stable {@link TransitionRejectionCode}.
 * - `messageKey` — i18n key the surface resolves to user-facing copy (never a
 *   pre-translated string; translation is the surface's job).
 * - `retryable` — whether re-issuing the same move could succeed later (e.g. a
 *   capacity exhaustion frees up) versus a structural rejection that will not
 *   (e.g. unknown column).
 * - `detail` — optional, non-localized diagnostic context for audit/logs only.
 */
export interface TransitionRejection {
  code: TransitionRejectionCode;
  messageKey: string;
  retryable: boolean;
  detail?: string;
}

/**
 * Result of an attempted transition. Discriminated on `ok` so callers branch
 * exhaustively. The success arm carries the resolved destination column so the
 * caller need not re-read it.
 */
export type TransitionResult =
  | { ok: true; toColumn: string }
  | { ok: false; rejection: TransitionRejection };

/**
 * Crash-safe marker persisted alongside the column change. `hooksRemaining`
 * holds the IDs of post-commit enter/exit hooks that have not yet completed;
 * recovery re-runs exactly these (idempotently) and clears the marker when the
 * list empties. `startedAt` is an epoch-millis timestamp used for stall/age
 * diagnostics and ordering during recovery.
 */
export interface TransitionPending {
  toColumn: string;
  hooksRemaining: string[];
  startedAt: number;
}

// ---------------------------------------------------------------------------
// Helper constructors
// ---------------------------------------------------------------------------

/**
 * Construct a {@link TransitionRejection}. `detail` is omitted from the object
 * when not supplied so the serialized shape stays minimal and stable.
 */
export function makeTransitionRejection(
  code: TransitionRejectionCode,
  messageKey: string,
  retryable: boolean,
  detail?: string,
): TransitionRejection {
  const rejection: TransitionRejection = { code, messageKey, retryable };
  if (detail !== undefined) {
    rejection.detail = detail;
  }
  return rejection;
}

/** Construct a successful {@link TransitionResult}. */
export function transitionOk(toColumn: string): TransitionResult {
  return { ok: true, toColumn };
}

/** Construct a rejected {@link TransitionResult} from a rejection. */
export function transitionRejected(rejection: TransitionRejection): TransitionResult {
  return { ok: false, rejection };
}

/**
 * Construct a {@link TransitionPending} marker. `startedAt` defaults to now so
 * the common call site (`moveTaskInternal` writing the marker in-txn) stays
 * terse; callers reconstructing a marker from a stored value pass it explicitly.
 * The `hooksRemaining` array is copied so the marker does not alias caller state.
 */
export function makeTransitionPending(
  toColumn: string,
  hooksRemaining: string[],
  startedAt: number = Date.now(),
): TransitionPending {
  return { toColumn, hooksRemaining: [...hooksRemaining], startedAt };
}

// ---------------------------------------------------------------------------
// (De)serialization — JSON-safe round-trip across the API boundary
// ---------------------------------------------------------------------------

function isTransitionRejectionCode(value: unknown): value is TransitionRejectionCode {
  return typeof value === "string" && (TRANSITION_REJECTION_CODES as readonly string[]).includes(value);
}

/** Serialize a rejection to a JSON string for transport/persistence. */
export function serializeTransitionRejection(rejection: TransitionRejection): string {
  return JSON.stringify(rejection);
}

/**
 * Parse a rejection from a JSON string produced by
 * {@link serializeTransitionRejection}. Returns `null` for malformed or
 * structurally invalid input rather than throwing, so a corrupt audit payload
 * can never crash a recovery path.
 */
export function deserializeTransitionRejection(json: string): TransitionRejection | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (!isTransitionRejectionCode(obj.code)) return null;
  if (typeof obj.messageKey !== "string") return null;
  if (typeof obj.retryable !== "boolean") return null;
  if (obj.detail !== undefined && typeof obj.detail !== "string") return null;
  return makeTransitionRejection(obj.code, obj.messageKey, obj.retryable, obj.detail as string | undefined);
}

/** Serialize a pending marker to a JSON string for the `tasks.transitionPending` column. */
export function serializeTransitionPending(pending: TransitionPending): string {
  return JSON.stringify(pending);
}

/**
 * Parse a pending marker from the JSON stored in `tasks.transitionPending`.
 * Returns `null` for malformed/invalid input. Non-string entries in
 * `hooksRemaining` are dropped defensively (a corrupt array element must not
 * strand the card); the structural shape is otherwise required.
 */
export function deserializeTransitionPending(json: string): TransitionPending | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.toColumn !== "string") return null;
  if (!Array.isArray(obj.hooksRemaining)) return null;
  if (typeof obj.startedAt !== "number" || !Number.isFinite(obj.startedAt)) return null;
  const hooksRemaining = obj.hooksRemaining.filter((h): h is string => typeof h === "string");
  return { toColumn: obj.toColumn, hooksRemaining, startedAt: obj.startedAt };
}
