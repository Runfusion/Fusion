import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchDevServerLogHistory,
  getDevServerLogsStreamUrl,
  type DevServerLogHistoryEntry,
} from "../api";
import { subscribeSse } from "../sse-bus";

export interface DevServerLogEntry {
  id: number;
  text: string;
  stream: "stdout" | "stderr";
  timestamp: string;
}

export const MAX_LOG_ENTRIES = 500;

const INITIAL_LOAD_LIMIT = 100;

function capLogEntries(entries: DevServerLogEntry[]): DevServerLogEntry[] {
  return entries.length > MAX_LOG_ENTRIES ? entries.slice(-MAX_LOG_ENTRIES) : entries;
}

function normalizeStream(stream: unknown): "stdout" | "stderr" {
  return stream === "stderr" ? "stderr" : "stdout";
}

function parseEventData<T>(event: MessageEvent<string>): T | null {
  try {
    return JSON.parse(event.data) as T;
  } catch {
    return null;
  }
}

function normalizeHistoryEntry(
  line: DevServerLogHistoryEntry,
  fallbackId: number,
): DevServerLogEntry {
  return {
    id: typeof line.id === "number" && Number.isFinite(line.id) ? line.id : fallbackId,
    text: typeof line.text === "string" ? line.text : "",
    stream: normalizeStream(line.stream),
    timestamp: typeof line.timestamp === "string" ? line.timestamp : "",
  };
}

function normalizeLegacyHistoryLine(line: string, fallbackId: number): DevServerLogEntry {
  return {
    id: fallbackId,
    text: line,
    stream: "stdout",
    timestamp: "",
  };
}

interface IncomingLogPayload {
  id?: number;
  text?: string;
  line?: string;
  timestamp?: string;
  stream?: "stdout" | "stderr";
}

function mergeUniqueEntries(prev: DevServerLogEntry[], incoming: DevServerLogEntry[]): DevServerLogEntry[] {
  if (incoming.length === 0) {
    return prev;
  }

  const merged = [...prev];
  const seenById = new Set(prev.map((entry) => entry.id));

  for (const entry of incoming) {
    if (seenById.has(entry.id)) {
      continue;
    }
    seenById.add(entry.id);
    merged.push(entry);
  }

  merged.sort((a, b) => a.id - b.id);
  return capLogEntries(merged);
}

export function useDevServerLogs(projectId: string | undefined, enabled: boolean) {
  const [entries, setEntries] = useState<DevServerLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);

  const unsubscribeRef = useRef<(() => void) | null>(null);
  const cancelledRef = useRef(false);
  const projectContextVersionRef = useRef(0);
  const requestVersionRef = useRef(0);
  const previousProjectIdRef = useRef<string | undefined>(projectId);
  const previousEnabledRef = useRef(enabled);
  const lastSeenEventIdRef = useRef(0);
  const nextSyntheticIdRef = useRef(1);

  const contextChanged =
    previousProjectIdRef.current !== projectId ||
    previousEnabledRef.current !== enabled;

  if (contextChanged) {
    previousProjectIdRef.current = projectId;
    previousEnabledRef.current = enabled;
    projectContextVersionRef.current++;
    cancelledRef.current = true;
    lastSeenEventIdRef.current = 0;
    nextSyntheticIdRef.current = 1;

    setEntries([]);
    setLoading(false);
    setLoadingMore(false);
    setHasMore(false);
    setTotal(null);

    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
  }

  useEffect(() => {
    if (!enabled) {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
      return;
    }

    const contextVersionAtStart = projectContextVersionRef.current;
    const requestVersion = ++requestVersionRef.current;
    cancelledRef.current = false;

    setLoading(true);

    const applyHistory = (historyLines: DevServerLogEntry[], totalLines: number | null) => {
      const normalized = capLogEntries(historyLines);
      setEntries(normalized);
      setTotal(totalLines);
      setHasMore(totalLines !== null ? totalLines > normalized.length : false);

      const maxId = normalized.length > 0 ? normalized[normalized.length - 1]!.id : 0;
      lastSeenEventIdRef.current = maxId;
      nextSyntheticIdRef.current = maxId + 1;
    };

    const applyHistoryFromSse = (payload: unknown) => {
      if (cancelledRef.current || projectContextVersionRef.current !== contextVersionAtStart) {
        return;
      }

      if (!payload || typeof payload !== "object") {
        return;
      }

      const linesRaw = (payload as { lines?: unknown }).lines;
      if (!Array.isArray(linesRaw)) {
        return;
      }

      if (linesRaw.length > 0 && typeof linesRaw[0] === "string") {
        const normalized = linesRaw
          .filter((line): line is string => typeof line === "string")
          .map((line, index) => normalizeLegacyHistoryLine(line, index + 1));
        applyHistory(normalized, normalized.length);
        return;
      }

      const structured = linesRaw
        .filter((line): line is DevServerLogHistoryEntry => Boolean(line) && typeof line === "object")
        .map((line, index) => normalizeHistoryEntry(line, index + 1));
      applyHistory(structured, structured.length);
    };

    const handleLiveEvent = (payload: IncomingLogPayload) => {
      if (cancelledRef.current || projectContextVersionRef.current !== contextVersionAtStart) {
        return;
      }

      const text = typeof payload.text === "string"
        ? payload.text
        : (typeof payload.line === "string" ? payload.line : null);

      if (!text) {
        return;
      }

      const fallbackId = nextSyntheticIdRef.current;
      const id = typeof payload.id === "number" && Number.isFinite(payload.id)
        ? payload.id
        : fallbackId;

      const entry: DevServerLogEntry = {
        id,
        text,
        stream: normalizeStream(payload.stream),
        timestamp: typeof payload.timestamp === "string" ? payload.timestamp : "",
      };

      lastSeenEventIdRef.current = Math.max(lastSeenEventIdRef.current, id);
      nextSyntheticIdRef.current = Math.max(nextSyntheticIdRef.current, id + 1);

      setEntries((prev) => mergeUniqueEntries(prev, [entry]));
      setTotal((prev) => {
        if (prev === null) {
          return prev;
        }
        return Math.max(prev + 1, entry.id);
      });
    };

    async function init(): Promise<void> {
      try {
        const result = await fetchDevServerLogHistory({ maxLines: INITIAL_LOAD_LIMIT }, projectId);

        if (cancelledRef.current ||
          projectContextVersionRef.current !== contextVersionAtStart ||
          requestVersionRef.current !== requestVersion) {
          return;
        }

        const normalized = result.lines.map((line, index) => normalizeHistoryEntry(line, index + 1));
        applyHistory(normalized, result.totalLines);
      } catch {
        if (cancelledRef.current ||
          projectContextVersionRef.current !== contextVersionAtStart ||
          requestVersionRef.current !== requestVersion) {
          return;
        }

        applyHistory([], null);
      } finally {
        if (!cancelledRef.current &&
          projectContextVersionRef.current === contextVersionAtStart &&
          requestVersionRef.current === requestVersion) {
          setLoading(false);
        }
      }

      const streamUrl = getDevServerLogsStreamUrl(projectId);
      unsubscribeRef.current = subscribeSse(streamUrl, {
        events: {
          "dev-server:log": (event) => {
            const parsed = parseEventData<IncomingLogPayload>(event);
            if (!parsed) {
              return;
            }
            handleLiveEvent(parsed);
          },
          log: (event) => {
            const parsed = parseEventData<IncomingLogPayload>(event);
            if (!parsed) {
              return;
            }
            handleLiveEvent(parsed);
          },
          history: (event) => {
            const parsed = parseEventData<{ lines?: unknown }>(event);
            applyHistoryFromSse(parsed);
          },
          "dev-server:history": (event) => {
            const parsed = parseEventData<{ lines?: unknown }>(event);
            applyHistoryFromSse(parsed);
          },
        },
        onReconnect: () => {
          if (cancelledRef.current || projectContextVersionRef.current !== contextVersionAtStart) {
            return;
          }

          void fetchDevServerLogHistory(
            {
              lastEventId: lastSeenEventIdRef.current,
              maxLines: 50,
            },
            projectId,
          ).then((result) => {
            if (cancelledRef.current || projectContextVersionRef.current !== contextVersionAtStart) {
              return;
            }

            const normalized = result.lines.map((line, index) =>
              normalizeHistoryEntry(line, nextSyntheticIdRef.current + index));

            if (normalized.length > 0) {
              const maxId = normalized[normalized.length - 1]!.id;
              lastSeenEventIdRef.current = Math.max(lastSeenEventIdRef.current, maxId);
              nextSyntheticIdRef.current = Math.max(nextSyntheticIdRef.current, maxId + 1);
            }

            setEntries((prev) => mergeUniqueEntries(prev, normalized));
            setTotal(result.totalLines);
          }).catch(() => {
            // Keep stream alive and fail silently.
          });
        },
      });
    }

    void init();

    return () => {
      cancelledRef.current = true;
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, [enabled, projectId]);

  const loadMore = useCallback(async () => {
    if (!enabled || loadingMore) {
      return;
    }

    const contextVersionAtStart = projectContextVersionRef.current;
    const currentEntriesCount = entries.length;

    setLoadingMore(true);

    try {
      const result = await fetchDevServerLogHistory(
        {
          maxLines: INITIAL_LOAD_LIMIT,
          offset: currentEntriesCount,
        },
        projectId,
      );

      if (cancelledRef.current || projectContextVersionRef.current !== contextVersionAtStart) {
        return;
      }

      const normalized = result.lines.map((line, index) => normalizeHistoryEntry(line, index + 1));

      setEntries((prev) => mergeUniqueEntries(normalized, prev));
      setHasMore(result.totalLines > currentEntriesCount + normalized.length);
      setTotal(result.totalLines);
    } catch {
      // Silent by design: pagination failures should not block live logs.
    } finally {
      setLoadingMore(false);
    }
  }, [enabled, entries.length, loadingMore, projectId]);

  const clear = useCallback(() => {
    setEntries([]);
  }, []);

  return {
    entries,
    loading,
    loadingMore,
    hasMore,
    total,
    loadMore,
    clear,
  };
}

export { capLogEntries };
