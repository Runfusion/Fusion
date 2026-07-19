import type { RetrySummary } from "./types.js";

/*
FNXC:RetryStorm 2026-07-15-21:30:
A retry storm reports that a budget ran out, which is never the whole story — the operator's
next question is always "ran out because WHAT kept failing?". The bare message ("Retry storm: N
retries exceeds cap M") answered the first and hid the second: from the cap onward it replaced
the real error (e.g. `429: overloaded_error`) in logs and `task.error`, so "the provider is down"
and "the reviewer keeps producing bad reviews" looked identical at the point of failure.

Callers that hold the failure which burned the final retry pass it as `cause`. It is folded into
the message, kept as `underlyingError` for structured surfaces, and preserved as the native Error
`cause` for stack-walking. Optional on purpose: some budgets (an UNAVAILABLE verdict) are burned
by a bad result rather than a thrown error, and have nothing meaningful to attach.
*/
export class RetryStormError extends Error {
  readonly category: string;

  readonly total: number;

  readonly cap: number;

  readonly breakdown: RetrySummary;

  /** Message of the failure that burned the final retry, when the caller had one in hand. */
  readonly underlyingError?: string;

  constructor({ category, total, cap, breakdown, cause }: {
    category: string;
    total: number;
    cap: number;
    breakdown: RetrySummary;
    cause?: unknown;
  }) {
    const underlyingError = cause === undefined || cause === null
      ? undefined
      : (cause instanceof Error ? cause.message : String(cause));
    super(
      `Retry storm: ${total} retries exceeds cap ${cap} (top category: ${category})`
        + (underlyingError ? ` — last error: ${underlyingError}` : ""),
      cause === undefined ? undefined : { cause },
    );
    this.name = "RetryStormError";
    this.category = category;
    this.total = total;
    this.cap = cap;
    this.breakdown = breakdown;
    this.underlyingError = underlyingError;
  }
}

export function serializeRetryStormError(err: RetryStormError): {
  type: "RetryStormError";
  category: string;
  total: number;
  cap: number;
  breakdown: RetrySummary;
  underlyingError?: string;
} {
  return {
    type: "RetryStormError",
    category: err.category,
    total: err.total,
    cap: err.cap,
    breakdown: err.breakdown,
    ...(err.underlyingError === undefined ? {} : { underlyingError: err.underlyingError }),
  };
}
