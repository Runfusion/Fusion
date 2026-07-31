/*
FNXC:MobileTabDiscard 2026-07-26-10:16:
Single source of the `dataAsOfMs` contract. Any "is this thing stale / stuck / unresponsive" verdict
computed in the client must measure a server timestamp against the AGE OF THE DATA IT CAME WITH, not
against wall-clock now.

Why this module exists rather than an inline `dataAsOfMs ?? Date.now()` at each call site: raising the
SWR hydration TTL means a mobile tab discard can restore a board from a snapshot that is hours old.
Every such verdict computed against `Date.now()` then reads uniformly overdue — every in-progress task
"stuck" (fixed in taskStuck.ts), every agent "Unresponsive" (fixed in agentHealth.tsx). That is one
defect class, found on three surfaces, because the clock choice was re-decided at each call site and
was silently omissible.

The ratchet: `dataAsOfMs` is a REQUIRED positional parameter here, typed `number | undefined`. A caller
may still pass `undefined` (no snapshot hydrated -> now really is the data's age), but it cannot forget
to decide — TypeScript rejects the two-argument call. Keep it required; the omissibility was the bug.
*/

/**
 * Milliseconds elapsed between `timestampMs` and the moment the containing data was last confirmed
 * fresh by the server.
 *
 * @param timestampMs - Server-provided instant being aged (epoch ms). `NaN` propagates so callers can
 *   detect an unparseable timestamp instead of receiving a plausible-looking `0`.
 * @param dataAsOfMs - When the record carrying `timestampMs` was last confirmed fresh. Pass the SWR
 *   envelope's `savedAt` for hydrated snapshots, the fetch time for live data, and `undefined` only
 *   when the data provably came from the current wall-clock moment (falls back to `Date.now()`).
 *
 * Clamped at zero: a timestamp newer than its own snapshot is clock skew or an optimistic local write,
 * never negative age.
 */
export function elapsedSinceMs(timestampMs: number, dataAsOfMs: number | undefined): number {
  return Math.max(0, (dataAsOfMs ?? Date.now()) - timestampMs);
}

/**
 * True when `timestampMs` is older than `thresholdMs` relative to the age of the data it arrived with.
 *
 * Returns false for an unparseable (`NaN`) `timestampMs` — absence of proof of staleness is not proof
 * of staleness. Surfaces that must treat an invalid timestamp as a failure (agentHealth does) should
 * check `Number.isFinite` themselves before calling.
 */
export function isOverdue(
  timestampMs: number,
  thresholdMs: number,
  dataAsOfMs: number | undefined,
): boolean {
  return elapsedSinceMs(timestampMs, dataAsOfMs) > thresholdMs;
}
