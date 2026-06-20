import type { DateRange } from "../DateRangePicker";

/*
FNXC:CommandCenter 2026-06-16-09:42:
Shared Command Center area helpers (PR #1683): date-range query building and count formatting reused across the analytics areas so range-to-query and unavailable-vs-zero rendering stay consistent.
*/

/**
 * Build the `?from=&to=` query string for an analytics endpoint from a
 * {@link DateRange}. Open bounds (null) are omitted so the server applies its
 * documented default window. The picker already rejects `from > to`
 * client-side, but we guard here too so a programmatic caller cannot send an
 * inverted range.
 */
export function rangeQuery(range: DateRange): string {
  const params = new URLSearchParams();
  if (range.from) {
    params.set("from", range.from);
  }
  if (range.to) {
    params.set("to", range.to);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Format an integer with locale grouping (e.g. 12,345). */
export function formatCount(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : "0";
}

/** Format milliseconds as compact active execution duration text. */
export function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "";
  const totalSeconds = Math.max(0, Math.round(ms / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

/** Format a USD cost result, returning the unavailable sentinel "—" when unknown. */
export function formatCost(usd: number | null, unavailable: boolean): string {
  if (unavailable || usd === null || !Number.isFinite(usd)) {
    return "—";
  }
  return `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** True when the picker's custom range is invalid (from after to). */
export function isInvalidRange(range: DateRange): boolean {
  return Boolean(range.from && range.to && range.from > range.to);
}
