export type RelativeTimeBucket = "just-now" | "minutes" | "hours" | "days" | "weeks" | "older";

export interface RelativeTimeBucketResult {
  bucket: RelativeTimeBucket;
  count: number;
  days: number;
  date: Date;
}

/**
 * FNXC:RelativeTime 2026-06-17-17:22:
 * FN-6601 consolidates relative-time bucket math while preserving each surface's existing i18n keys, capitalization, and fallback policy.
 * Callers map buckets to their local strings instead of sharing rendered copy.
 */
export function getRelativeTimeBucket(iso: string, now: number = Date.now()): RelativeTimeBucketResult | null {
  if (!iso) return null;

  const timestampMs = Date.parse(iso);
  if (!Number.isFinite(timestampMs)) return null;

  const diffMs = now - timestampMs;
  if (diffMs < 0) return null;

  const diffSeconds = Math.floor(diffMs / 1_000);
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  const diffWeeks = Math.floor(diffDays / 7);
  const date = new Date(timestampMs);

  if (diffSeconds < 60) return { bucket: "just-now", count: 0, days: 0, date };
  if (diffMinutes < 60) return { bucket: "minutes", count: diffMinutes, days: 0, date };
  if (diffHours < 24) return { bucket: "hours", count: diffHours, days: 0, date };
  if (diffDays < 7) return { bucket: "days", count: diffDays, days: diffDays, date };
  if (diffDays < 28) return { bucket: "weeks", count: diffWeeks, days: diffDays, date };

  return { bucket: "older", count: diffWeeks, days: diffDays, date };
}

/**
 * FNXC:TaskChatTimestamps 2026-06-17-15:40:
 * FN-6597 requires compact relative timestamps for task-chat agent groups and user messages without live polling.
 * Invalid or missing timestamps must return an empty string so UI callers can omit the label instead of rendering NaN or Invalid Date.
 */
export function formatRelativeTimeAgo(iso: string, now: number = Date.now()): string {
  const bucket = getRelativeTimeBucket(iso, now);
  if (!bucket) {
    const timestampMs = Date.parse(iso);
    return iso && Number.isFinite(timestampMs) && now - timestampMs < 0 ? "just now" : "";
  }

  switch (bucket.bucket) {
    case "just-now":
      return "just now";
    case "minutes":
      return `${bucket.count}m ago`;
    case "hours":
      return `${bucket.count}h ago`;
    case "days":
      return `${bucket.count}d ago`;
    case "weeks":
    case "older":
      return bucket.date.toLocaleDateString();
  }
}
