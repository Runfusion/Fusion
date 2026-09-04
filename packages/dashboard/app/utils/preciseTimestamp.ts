/**
 * FNXC:PreciseTaskLogTimestamps 2026-09-01-01:03:
 * FN-272 requires task log feeds to show the local wall-clock time of each logged action to the millisecond beside, not instead of, its relative label.
 * Build this value from local Date getters rather than locale formatters: locale output can omit milliseconds, use a 12-hour clock, and make the operator's precise reading and test assertions ambiguous.
 */

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function parseTimestamp(iso: string | undefined): Date | null {
  if (!iso) return null;
  const timestampMs = Date.parse(iso);
  return Number.isFinite(timestampMs) ? new Date(timestampMs) : null;
}

function formatLocalDate(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatLocalClock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function isSameLocalCalendarDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

/** Formats a valid timestamp as a local precise clock reading, adding its date when it is not today. */
export function formatPreciseClockTime(iso: string | undefined, now: number = Date.now()): string {
  const date = parseTimestamp(iso);
  if (!date) return "";

  const clock = formatLocalClock(date);
  return isSameLocalCalendarDay(date, new Date(now)) ? clock : `${formatLocalDate(date)} ${clock}`;
}

/** Formats a valid timestamp as an unambiguous local date and precise clock reading for hover text. */
export function formatPreciseTimestampFull(iso: string | undefined): string {
  const date = parseTimestamp(iso);
  return date ? `${formatLocalDate(date)} ${formatLocalClock(date)}` : "";
}
