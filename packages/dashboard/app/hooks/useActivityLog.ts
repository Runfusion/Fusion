import { useState, useEffect, useCallback, useRef } from "react";
import type { ActivityFeedEntry } from "../api";
import { fetchActivityFeed, fetchActivityLog } from "../api";
import { useVisibilityAwarePoll } from "./visibilitySuspension";

export interface UseActivityLogResult {
  /** Activity log entries */
  entries: ActivityFeedEntry[];
  /** Loading state */
  loading: boolean;
  /** Error message if fetch failed */
  error: string | null;
  /** Manually refresh activity log */
  refresh: () => Promise<void>;
  /** Clear all entries from state */
  clear: () => void;
  /** Whether there are more entries to load */
  hasMore: boolean;
  /** Load more (older) entries */
  loadMore: () => Promise<void>;
}

const POLL_INTERVAL_MS = 5000; // 5 seconds
/** Upper bound on retained activity entries; matches the 500-line cap in useMultiAgentLogs. */
const MAX_RETAINED_ENTRIES = 500;

export interface UseActivityLogOptions {
  /** Filter by project ID (used with unified central feed) */
  projectId?: string;
  /** Filter by event type */
  type?: ActivityFeedEntry["type"];
  /** Exact normalized task ID filter */
  taskId?: string;
  /** Number of entries to fetch per page */
  limit?: number;
  /** Whether to auto-refresh */
  autoRefresh?: boolean;
  /**
   * When true, fetch from the unified central activity feed (/api/activity-feed).
   * When false (default), fetch from the per-project activity log (/api/activity).
   *
   * Set to true when the modal operates in a multi-project context (projects
   * list provided) so it reads from the unified feed. Default (false) reads
   * from the per-project log which is always populated with task events.
   */
  useCentralFeed?: boolean;
}

/**
 * Hook for fetching and managing the activity log.
 * Automatically polls for updates every 5 seconds when enabled.
 * Supports filtering by project and event type.
 *
 * Data source selection:
 * - Default (single-project): reads from per-project activity log (/api/activity)
 *   which is always populated with task lifecycle events for the current project.
 * - Multi-project (useCentralFeed=true): reads from unified activity feed
 *   (/api/activity-feed) which aggregates activity across all registered projects.
 */
export function useActivityLog(options: UseActivityLogOptions = {}): UseActivityLogResult {
  const { projectId, type, taskId, limit = 50, autoRefresh = true, useCentralFeed = false } = options;

  const [entries, setEntries] = useState<ActivityFeedEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const lastTimestampRef = useRef<string | undefined>(undefined);

  /*
  FNXC:ActivityScopeFencing 2026-09-15-16:04:
  FN-426: both `refresh` and `loadMore` published their results unconditionally. A project switch, a type/task filter
  change, a `clear()`, or simply unmounting the popover could not stop an in-flight response from writing rows,
  `hasMore`, `error`, `loading`, and the pagination cursor for a scope the reader had already left — which is exactly
  how an old project's activity appeared under a new project's header.

  The fence is a REQUEST GENERATION, bumped on every scope change and on `clear()`/unmount. A response, an error, and
  even the `finally` block each check their captured generation before touching state, so nothing an obsolete request
  does is observable. Retention (500), pagination, and the visibility-aware poll are unchanged.
  */
  const generationRef = useRef(0);
  const scopeKey = `${useCentralFeed ? "central" : "project"}|${projectId ?? ""}|${type ?? ""}|${taskId ?? ""}|${limit}`;
  const scopeKeyRef = useRef(scopeKey);
  if (scopeKeyRef.current !== scopeKey) {
    scopeKeyRef.current = scopeKey;
    generationRef.current += 1;
    lastTimestampRef.current = undefined;
  }
  useEffect(() => () => { generationRef.current += 1; }, []);

  /**
   * Fetch entries using the appropriate data source.
   *
   * Per-project log (/api/activity) — the default — reads the project's own
   * store and always contains task lifecycle events. (Corrected 2026-09-15: the
   * runtime store is PostgreSQL; the route is unchanged either way.)
   *
   * Unified feed (/api/activity-feed) reads from the central database and
   * supports cross-project aggregation.
   */
  const refresh = useCallback(async () => {
    const generation = generationRef.current;
    try {
      setLoading(true);
      setError(null);

      let data: ActivityFeedEntry[];

      if (useCentralFeed) {
        data = await fetchActivityFeed({ limit, projectId, type, taskId });
      } else {
        // Per-project: fetchActivityLog returns ActivityLogEntry[] which is a
        // subset of ActivityFeedEntry (missing projectId/projectName). Map to
        // the full shape so downstream consumers see a uniform interface.
        const logEntries = await fetchActivityLog({ limit, type, projectId, taskId });
        data = logEntries.map((entry) => ({
          ...entry,
          projectId: projectId ?? "",
          projectName: "",
        }));
      }

      if (generation !== generationRef.current) return;
      setEntries(data);
      setHasMore(data.length === limit);

      /*
      FNXC:ActivityScopeFencing 2026-09-15-16:04:
      The cursor is part of the published result. A refresh that lost its generation must not advance it, or the next
      `loadMore` in the NEW scope would page from a timestamp that belongs to the old one.
      */
      lastTimestampRef.current = data.length > 0 ? data[data.length - 1].timestamp : undefined;
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load activity log");
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [limit, projectId, taskId, type, useCentralFeed]);

  const loadMore = useCallback(async () => {
    if (!lastTimestampRef.current) return;

    const generation = generationRef.current;
    try {
      setLoading(true);

      let data: ActivityFeedEntry[];

      if (useCentralFeed) {
        data = await fetchActivityFeed({
          limit,
          projectId,
          type,
          since: lastTimestampRef.current,
          taskId,
        });
      } else {
        const logEntries = await fetchActivityLog({
          limit,
          type,
          since: lastTimestampRef.current,
          projectId,
          taskId,
        });
        data = logEntries.map((entry) => ({
          ...entry,
          projectId: projectId ?? "",
          projectName: "",
        }));
      }

      /*
      FNXC:MobileTabRetention 2026-07-26-10:22:
      loadMore appended pages unbounded, so a long session grew the entry array without limit and inflated
      the page's resident set — large-memory pages are the second discard trigger on mobile. Cap retained
      entries at MAX_RETAINED_ENTRIES (same bound as useMultiAgentLogs).

      FNXC:ActivityLogPaging 2026-07-26-18:30:
      CORRECTION to the note above, which claimed "the cap truncates the tail rather than evicting what is
      on screen" and used `merged.slice(0, MAX_RETAINED_ENTRIES)`. That was wrong in the only case where
      the cap actually bites: the tail being truncated IS the page loadMore just fetched. At the cap
      (limit 50 -> the 11th click) every further click fetched 50 older entries, dropped all 50, advanced
      `lastTimestampRef` past them, and left `hasMore` true — so the feed stopped paginating while still
      offering a "Load more" button that provably did nothing, and the skipped entries became unreachable
      because the cursor had already moved beyond them.
      Drop from the HEAD instead (`slice(-MAX)`): the appended older page survives, so the control keeps
      doing what it exists for — paging backwards. Evicting the newest entries is the recoverable
      direction: `refresh` (manual, and the 5s visibility-aware poll) refetches the newest page from
      offset 0 and resets the buffer, so anything dropped off the head comes straight back.
      */
      /*
      FNXC:ActivityScopeFencing 2026-09-15-16:04:
      A page that raced a scope change, a clear, or a reset cursor must not be appended: the rows below it are no
      longer the ones it continues. Checking the generation AND the still-present cursor covers both orderings
      (loadMore before refresh, and refresh before loadMore).
      */
      if (generation !== generationRef.current || !lastTimestampRef.current) return;
      setEntries((prev) => {
        const merged = [...prev, ...data];
        return merged.length > MAX_RETAINED_ENTRIES ? merged.slice(-MAX_RETAINED_ENTRIES) : merged;
      });
      setHasMore(data.length === limit);

      if (data.length > 0) {
        lastTimestampRef.current = data[data.length - 1].timestamp;
      }
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load more entries");
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [limit, projectId, taskId, type, useCentralFeed]);

  /*
  FNXC:ActivityScopeFencing 2026-09-15-16:04:
  Clearing is a scope boundary too: a response already in flight belongs to the cleared view, so it is invalidated
  rather than allowed to repopulate the list the caller just emptied.
  */
  const clear = useCallback(() => {
    generationRef.current += 1;
    setEntries([]);
    setHasMore(false);
    setError(null);
    setLoading(false);
    lastTimestampRef.current = undefined;
  }, []);

  // Initial fetch
  useEffect(() => {
    refresh();
  }, [refresh]);

  /*
  FNXC:MobileTabRetention 2026-07-26-10:18:
  Auto-refresh polling must stop while the tab is backgrounded. A page that keeps fetching in the
  background is a primary discard signal on iOS Safari/PWA and Chrome Android, which is what made the
  dashboard white-splash reload on return. `useVisibilityAwarePoll` suspends the interval while hidden
  and issues exactly one refresh when the tab becomes visible again.
  */
  useVisibilityAwarePoll(refresh, POLL_INTERVAL_MS, { enabled: autoRefresh });

  return {
    entries,
    loading,
    error,
    refresh,
    clear,
    hasMore,
    loadMore,
  };
}
