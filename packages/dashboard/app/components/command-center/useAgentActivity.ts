import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAgentActivity, type AgentActivityEvent, type AgentActivityEventType, type AgentActivityPage } from "../../api";
import { subscribeSse } from "../../sse-bus";
import type { DateRange } from "./DateRangePicker";
import {
  AGENT_ACTIVITY_PAGE_SIZE,
  cursorToQuery,
  isTruncationFrame,
  mergeAgentActivity,
  resolvePageOutcome,
  type PageExhaustionReason,
} from "./agentActivityCursor";

export const MAX_RANGE_AUTOPAGE_PAGES = 5;

/**
 * FNXC:CommandCenterAgentActivity 2026-08-10-19:35:
 * The history endpoint is a trust boundary too: discard malformed rows before BigInt cursor ordering.
 * Unknown event types remain rows so the presentation default can make newly-added server types visible.
 */
function normalizeAgentActivityPage(response: unknown): AgentActivityPage {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Invalid agent activity response");
  }
  const page = response as { events?: unknown; nextCursor?: unknown };
  if (!Array.isArray(page.events) || (page.nextCursor !== null && (typeof page.nextCursor !== "string" || !/^\d+$/.test(page.nextCursor)))) {
    throw new Error("Invalid agent activity response");
  }
  return { events: page.events.filter(isAgentActivityRow), nextCursor: page.nextCursor };
}

/** Reject malformed SSE payloads before they can reach BigInt ordering or the render tree. */
function isAgentActivityRow(frame: unknown): frame is AgentActivityEvent {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return false;
  const row = frame as Record<string, unknown>;
  const nullableString = (value: unknown) => value === null || typeof value === "string";
  return typeof row.seq === "string"
    && /^\d+$/.test(row.seq)
    && typeof row.eventId === "string"
    && typeof row.projectId === "string"
    && typeof row.agentId === "string"
    && typeof row.type === "string"
    && typeof row.summary === "string"
    && typeof row.occurredAt === "string"
    && nullableString(row.taskId)
    && nullableString(row.fromAgentId)
    && nullableString(row.toAgentId)
    && (row.metadata === null || (typeof row.metadata === "object" && !Array.isArray(row.metadata)));
}

export interface AgentActivityFilters {
  agentId?: string;
  taskId?: string;
  type?: AgentActivityEventType;
}

export interface UseAgentActivityOptions {
  projectId?: string;
  filters: AgentActivityFilters;
  range?: DateRange;
}

/*
FNXC:CommandCenterAgentActivity 2026-08-10-02:03:
This hook owns the org-wide live log and scroll-back timeline. SSE rows merge into the retained list but never advance history continuation; a truncation marker reloads authoritative history. `/api/agent-activity` has no range query, so DateRange is a client-side window and must never be conflated with the `before` cursor.
*/
export function useAgentActivity({ projectId, filters, range }: UseAgentActivityOptions) {
  const [events, setEvents] = useState<AgentActivityEvent[]>([]);
  const eventsRef = useRef<AgentActivityEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [exhaustedReason, setExhaustedReason] = useState<PageExhaustionReason | null>(null);
  const versionRef = useRef(0);
  const pendingCursorRef = useRef<string | null>(null);
  const progressRef = useRef(0);
  const rangePagesRef = useRef(0);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const filterKey = JSON.stringify([projectId, filters.agentId, filters.taskId, filters.type]);
  const rangeKey = `${range?.from ?? ""}|${range?.to ?? ""}|${range?.preset ?? ""}`;

  const applyRows = useCallback((rows: AgentActivityEvent[]) => {
    eventsRef.current = rows;
    setEvents(rows);
  }, []);

  const request = useCallback(async (cursor: string | null, seed: boolean) => {
    const version = versionRef.current;
    if (!projectId) {
      applyRows([]);
      setIsLoading(false);
      return;
    }
    if (!seed && (cursor === null || pendingCursorRef.current === cursor)) return;
    if (seed) {
      setIsLoading(true);
      setError(null);
    } else {
      pendingCursorRef.current = cursor;
      setIsLoadingOlder(true);
    }

    try {
      const response = await getAgentActivity({
        projectId,
        limit: AGENT_ACTIVITY_PAGE_SIZE,
        ...filtersRef.current,
        ...cursorToQuery(cursor),
      });
      const page = normalizeAgentActivityPage(response);
      if (version !== versionRef.current) return;
      const outcome = resolvePageOutcome({
        requestedCursor: cursor,
        existing: eventsRef.current,
        page,
        consecutiveNoProgress: progressRef.current,
      });
      applyRows(outcome.merged);
      setNextCursor(outcome.nextCursor);
      setHasMore(outcome.hasMore);
      setExhaustedReason(outcome.reason);
      progressRef.current = outcome.consecutiveNoProgress;
    } catch (cause) {
      if (version === versionRef.current) {
        setError(cause instanceof Error ? cause.message : "Failed to load agent activity");
      }
    } finally {
      if (version === versionRef.current) {
        setIsLoading(false);
        setIsLoadingOlder(false);
        pendingCursorRef.current = null;
      }
    }
  }, [applyRows, filterKey, projectId]);

  const reload = useCallback(() => {
    versionRef.current += 1;
    pendingCursorRef.current = null;
    progressRef.current = 0;
    rangePagesRef.current = 0;
    setNextCursor(null);
    setHasMore(false);
    setExhaustedReason(null);
    applyRows([]);
    void request(null, true);
  }, [applyRows, request]);

  useEffect(() => {
    reload();
  }, [filterKey, reload]);

  const loadOlder = useCallback(() => {
    if (!hasMore || nextCursor === null) return;
    void request(nextCursor, false);
  }, [hasMore, nextCursor, request]);

  useEffect(() => {
    const unsubscribe = subscribeSse("/api/events", {
      events: {
        "agent:activity": (message) => {
          let frame: unknown;
          try {
            frame = JSON.parse(message.data);
          } catch {
            return;
          }
          if (isTruncationFrame(frame)) {
            reload();
            return;
          }
          if (!isAgentActivityRow(frame)) return;
          const row = frame;
          const activeFilters = filtersRef.current;
          if (
            row.projectId !== projectId ||
            !row.eventId ||
            !row.seq ||
            (activeFilters.agentId && row.agentId !== activeFilters.agentId) ||
            (activeFilters.taskId && row.taskId !== activeFilters.taskId) ||
            (activeFilters.type && row.type !== activeFilters.type)
          ) return;
          applyRows(mergeAgentActivity(eventsRef.current, [row]));
        },
      },
      onReconnect: reload,
    });
    return unsubscribe;
  }, [applyRows, projectId, reload]);

  const visibleEvents = useMemo(() => {
    if (!range || (!range.from && !range.to)) return events;
    const from = range.from ? Date.parse(range.from) : -Infinity;
    const to = range.to ? Date.parse(range.to) : Infinity;
    if (Number.isNaN(from) || Number.isNaN(to)) return events;
    return events.filter((row) => {
      const occurredAt = Date.parse(row.occurredAt);
      return Number.isFinite(occurredAt) && occurredAt >= from && occurredAt <= to;
    });
  }, [events, range]);

  useEffect(() => {
    rangePagesRef.current = 0;
  }, [rangeKey]);

  useEffect(() => {
    if (!range?.from || !hasMore || nextCursor === null || rangePagesRef.current >= MAX_RANGE_AUTOPAGE_PAGES) return;
    const rangeStart = Date.parse(range.from);
    const oldest = events.at(-1);
    if (!Number.isFinite(rangeStart) || !oldest || Date.parse(oldest.occurredAt) <= rangeStart) return;
    rangePagesRef.current += 1;
    loadOlder();
  }, [events, hasMore, loadOlder, nextCursor, range?.from, rangeKey]);

  return { events, visibleEvents, isLoading, isLoadingOlder, error, hasMore, exhaustedReason, loadOlder, reload };
}
