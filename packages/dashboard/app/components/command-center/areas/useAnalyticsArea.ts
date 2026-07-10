import { useCallback, useEffect, useRef, useState } from "react";
import { api, withProjectId } from "../../../api/legacy";
import type { DateRange } from "../DateRangePicker";
import { isInvalidRange, rangeQuery } from "./areaShared";

export interface AnalyticsAreaState<T> {
  data: T | null;
  isLoading: boolean;
  /** Non-null only for a hard error with no prior data to fall back on. */
  error: string | null;
  reload: () => void;
}

export interface AnalyticsAreaOptions {
  /** Opt-in bounded polling interval in milliseconds; omitted means no polling. */
  pollMs?: number;
  /** Currently-selected project id; when supplied, scopes the request via `projectId` query param. */
  projectId?: string;
}

function withRangeQuery(endpoint: string, query: string): string {
  if (query === "") return endpoint;
  const suffix = query.slice(1);
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}${suffix}`;
}

/**
 * Fetch one Command Center analytics endpoint for the selected date range.
 *
 * - Refetches whenever the resolved range query changes (range change → refetch).
 * - An inverted custom range (`from > to`) never fires a request; the area
 *   surfaces the picker's client-side rejection instead.
 * - Keeps the previous `data` visible across a refetch so revalidation does not
 *   flash the empty/loading state (and so consumers' derived-keyed effects can
 *   distinguish a real content change from a re-fetch of identical content).
 * - Polling is opt-in via `options.pollMs`; invalid ranges never schedule an
 *   interval, and the interval is cleaned up on unmount/range/endpoint changes.
 *
 * FNXC:CommandCenterTokenLive 2026-06-25-09:06:
 * Live token refresh is background revalidation after the first successful payload, not a loading-state replacement. Command Center must keep Overview and Tokens surfaces mounted while a 15s poll is in flight so increased token totals render without manual refresh or range toggles.
 *
 * NOTE on the SWR-identity trap: this hook intentionally replaces `data`
 * identity on every successful fetch. Consumers MUST key any selection / sort /
 * drill-down reset effect on a DERIVED value (e.g. `rows.map(r => r.id).join()`),
 * never on the fetched object's identity, or that state resets on every tick.
 */
export function useAnalyticsArea<T>(
  endpoint: string,
  range: DateRange,
  options: AnalyticsAreaOptions = {},
): AnalyticsAreaState<T> {
  const [data, setData] = useState<T | null>(null);
  const dataRef = useRef<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const query = rangeQuery(range);
  const invalid = isInvalidRange(range);
  const { projectId } = options;

  const load = useCallback(async () => {
    if (invalid) {
      // Client-side rejection: do not call the server with an inverted range.
      setIsLoading(false);
      return;
    }
    const hasFallbackData = dataRef.current !== null;
    if (!hasFallbackData) {
      setIsLoading(true);
    }
    setError(null);
    try {
      const result = await api<T>(withProjectId(withRangeQuery(endpoint, query), projectId));
      dataRef.current = result;
      setData(result);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load analytics");
    } finally {
      setIsLoading(false);
    }
  }, [endpoint, query, invalid, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (invalid || options.pollMs === undefined) {
      return undefined;
    }
    const interval = window.setInterval(() => {
      void load();
    }, options.pollMs);
    return () => window.clearInterval(interval);
  }, [invalid, load, options.pollMs]);

  const reload = useCallback(() => {
    void load();
  }, [load]);

  return {
    data,
    isLoading,
    // Only surface a blocking error when we have nothing to show.
    error: error !== null && data === null ? error : null,
    reload,
  };
}
