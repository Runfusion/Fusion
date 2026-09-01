import "./PreciseTimestamp.css";
import { formatPreciseClockTime, formatPreciseTimestampFull } from "../utils/preciseTimestamp";

export interface PreciseTimestampProps {
  timestamp: string | undefined;
  className?: string;
  testId?: string;
}

/**
 * FNXC:PreciseTaskLogTimestamps 2026-09-01-01:03:
 * FN-272 introduces one shared task-log timestamp primitive because no equivalent existed and four independent implementations would drift.
 * The element returns no shell for missing or invalid input so every activity surface can add precise time beside its unchanged relative label safely.
 */
export function PreciseTimestamp({ timestamp, className, testId }: PreciseTimestampProps) {
  const clockTime = formatPreciseClockTime(timestamp);
  if (!clockTime) return null;

  return (
    <time
      className={["precise-timestamp", className].filter(Boolean).join(" ")}
      dateTime={timestamp}
      title={formatPreciseTimestampFull(timestamp)}
      data-testid={testId}
    >
      {clockTime}
    </time>
  );
}
