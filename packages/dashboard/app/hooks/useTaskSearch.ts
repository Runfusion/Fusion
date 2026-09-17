/**
 * FNXC:TaskSearch 2026-09-17-09:41:
 * FN-477 header-search controller. It owns an EPHEMERAL collection that is independent of the board:
 * before this, suggestions could only contain tasks the board had already paged in, so a task whose
 * page had not loaded was unfindable no matter what the operator typed.
 *
 * Two lanes, never blended:
 *  - TEXT: debounced, paginated `GET /tasks/page?q=...`. Server order and membership are preserved;
 *    every page stays reachable, so there is no fixed suggestion ceiling.
 *  - AI: `POST /ai/search-tasks`, issued ONLY on Enter, exactly once per press, never on typing or
 *    focus. It replaces the panel contents and is not paginated.
 *
 * Every publication is fenced by `(nodeId, projectId, query, lane, monotonic generation)`. A stale
 * success, a stale error, and a stale `finally` are all ignored, which is what makes A→B→A safe: the
 * first A incarnation can never republish over the second one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "@fusion/core";
import { fetchTaskPage } from "../api";
import { aiSearchTasks } from "../api/tasks/tasks-search";
import {
  TASK_SEARCH_TEXT_DEBOUNCE_MS,
  TASK_SEARCH_TEXT_PAGE_LIMIT,
} from "../../src/shared/task-search";

export type TaskSearchLane = "text" | "ai";

export type TaskSearchErrorKind = "text" | "ai";

export interface TaskSearchError {
  kind: TaskSearchErrorKind;
  /** Stable server code when the server supplied one; otherwise a generic transport marker. */
  code: string;
  status?: number;
}

export interface UseTaskSearchOptions {
  query: string;
  projectId?: string;
  nodeId?: string;
  localNodeId?: string;
  /** The panel is closed/unmounted when false; all in-flight work is cancelled. */
  active?: boolean;
  pageLimit?: number;
  debounceMs?: number;
}

export interface UseTaskSearchResult {
  /** Rows currently shown in the panel. Their provenance is `lane`. */
  tasks: Task[];
  lane: TaskSearchLane;
  loading: boolean;
  /** True while the AI lane is generating. */
  aiLoading: boolean;
  hasMore: boolean;
  error: TaskSearchError | null;
  /** Total text matches reported by the server, independent of how many pages have loaded. */
  total: number;
  /** Changes only when a page or an AI answer is accepted. Feeds the pagination sentinel. */
  progressKey: string;
  /** Stable incarnation key for the current (node, project, query, lane). */
  collectionKey: string;
  loadMore: () => Promise<void>;
  /** Run the AI lane for the current query. Safe to call repeatedly; only one request is in flight. */
  runAiSearch: () => Promise<void>;
  /** Discard results and cancel in-flight work without changing the query. */
  reset: () => void;
}

interface LaneState {
  tasks: Task[];
  lane: TaskSearchLane;
  hasMore: boolean;
  total: number;
  cursor: string | null;
  error: TaskSearchError | null;
  progress: number;
}

const EMPTY_STATE: LaneState = {
  tasks: [],
  lane: "text",
  hasMore: false,
  total: 0,
  cursor: null,
  error: null,
  progress: 0,
};

function toSearchError(kind: TaskSearchErrorKind, err: unknown): TaskSearchError {
  const status = (err as { status?: number } | null)?.status;
  const message = err instanceof Error ? err.message : String(err ?? "");
  // Server codes are stable identifiers; anything else is reported as a generic transport failure so
  // provider or gateway prose is never rendered as if it were an operator-actionable code.
  const code = /^[A-Z][A-Z0-9_]+$/.test(message) ? message : "REQUEST_FAILED";
  return { kind, code, ...(typeof status === "number" ? { status } : {}) };
}

export function useTaskSearch(options: UseTaskSearchOptions): UseTaskSearchResult {
  const {
    query,
    projectId,
    nodeId,
    localNodeId,
    active = true,
    pageLimit = TASK_SEARCH_TEXT_PAGE_LIMIT,
    debounceMs = TASK_SEARCH_TEXT_DEBOUNCE_MS,
  } = options;

  const trimmedQuery = query.trim();
  const enabled = active && Boolean(projectId) && trimmedQuery.length > 0;

  /*
  The incarnation key deliberately EXCLUDES the lane: switching lanes must not discard the text
  collection identity used by the pagination sentinel, while switching node/project/query must.
  */
  const contextKey = `${nodeId ?? ""}\u0000${projectId ?? ""}\u0000${trimmedQuery}`;

  const [state, setState] = useState<LaneState>(EMPTY_STATE);
  const [loading, setLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);

  const generationRef = useRef(0);
  const [renderedContextKey, setRenderedContextKey] = useState(contextKey);
  const controllersRef = useRef(new Map<number, AbortController>());
  const seenIdsRef = useRef(new Set<string>());
  const stateRef = useRef(state);
  stateRef.current = state;
  const aiInFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /** Invalidate every in-flight request and start a fresh generation. */
  const bumpGeneration = useCallback((): number => {
    for (const controller of controllersRef.current.values()) controller.abort();
    controllersRef.current.clear();
    aiInFlightRef.current = false;
    generationRef.current += 1;
    return generationRef.current;
  }, []);

  const isCurrent = useCallback(
    (generation: number) => mountedRef.current && generation === generationRef.current,
    [],
  );

  /*
  FNXC:TaskSearch 2026-09-17-09:41:
  Context changes clear foreign rows DURING RENDER, not in an effect. Two projects (and two nodes)
  legitimately contain the same task ids, so leaving the previous context's rows mounted for even one
  committed render would paint another project's card under the current project's identity. React
  re-renders immediately on this pattern, so nothing foreign is ever committed.
  */
  if (renderedContextKey !== contextKey) {
    setRenderedContextKey(contextKey);
    for (const controller of controllersRef.current.values()) controller.abort();
    controllersRef.current.clear();
    aiInFlightRef.current = false;
    generationRef.current += 1;
    seenIdsRef.current = new Set();
    stateRef.current = EMPTY_STATE;
    setState(EMPTY_STATE);
    setLoading(false);
    setAiLoading(false);
  }

  const runRequest = useCallback(async <T,>(
    generation: number,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: unknown } | { ok: false; stale: true }> => {
    const controller = new AbortController();
    controllersRef.current.set(generation, controller);
    try {
      const value = await run(controller.signal);
      if (!isCurrent(generation)) return { ok: false, stale: true };
      return { ok: true, value };
    } catch (err) {
      if (!isCurrent(generation)) return { ok: false, stale: true };
      return { ok: false, error: err };
    } finally {
      /*
      A stale request's `finally` must never release the CURRENT request's owner. Delete only its own
      entry, keyed by the generation that created it.
      */
      if (controllersRef.current.get(generation) === controller) controllersRef.current.delete(generation);
    }
  }, [isCurrent]);

  /** Fetch one text page. `append` continues the current collection; otherwise it replaces it. */
  const fetchTextPage = useCallback(async (generation: number, cursor: string | null, append: boolean) => {
    if (!isCurrent(generation)) return;
    setLoading(true);
    const result = await runRequest(generation, (signal) => fetchTaskPage(projectId, {
      limit: pageLimit,
      query: trimmedQuery,
      signal,
      ...(cursor ? { cursor } : {}),
      ...(nodeId ? { nodeId } : {}),
      ...(localNodeId ? { localNodeId } : {}),
    }));
    if ("stale" in result) return;
    if (!isCurrent(generation)) return;

    if (!result.ok) {
      setLoading(false);
      setState((previous) => ({ ...previous, error: toSearchError("text", result.error) }));
      return;
    }

    const page = result.value;
    if (!append) seenIdsRef.current = new Set();
    const seen = seenIdsRef.current;
    const fresh: Task[] = [];
    for (const task of page.tasks ?? []) {
      const key = task.id.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(task);
    }

    setLoading(false);
    setState((previous) => ({
      tasks: append ? [...previous.tasks, ...fresh] : fresh,
      lane: "text",
      /*
      A page whose rows were ALL duplicates still advanced the server cursor. Progress therefore
      tracks the accepted continuation, not the row count, so the sentinel keeps paging instead of
      concluding the collection is exhausted.
      */
      hasMore: Boolean(page.hasMore && page.nextCursor),
      total: page.total ?? 0,
      cursor: page.nextCursor ?? null,
      error: null,
      progress: previous.progress + 1,
    }));
  }, [isCurrent, localNodeId, nodeId, pageLimit, projectId, runRequest, trimmedQuery]);

  // Debounced first text page. Typing NEVER reaches the AI lane.
  useEffect(() => {
    if (!enabled) {
      bumpGeneration();
      seenIdsRef.current = new Set();
      setLoading(false);
      setAiLoading(false);
      setState(EMPTY_STATE);
      return;
    }
    const generation = bumpGeneration();
    const timer = setTimeout(() => { void fetchTextPage(generation, null, false); }, debounceMs);
    return () => {
      clearTimeout(timer);
      const controller = controllersRef.current.get(generation);
      controller?.abort();
      controllersRef.current.delete(generation);
    };
  }, [bumpGeneration, debounceMs, enabled, fetchTextPage, contextKey]);

  // Teardown: closing the panel or unmounting cancels every in-flight request.
  useEffect(() => () => { bumpGeneration(); }, [bumpGeneration]);

  const loadMore = useCallback(async () => {
    const current = stateRef.current;
    if (!enabled || current.lane !== "text" || !current.hasMore || !current.cursor) return;
    await fetchTextPage(generationRef.current, current.cursor, true);
  }, [enabled, fetchTextPage]);

  const runAiSearch = useCallback(async () => {
    if (!enabled) return;
    /*
    Repeated Enter presses while a search is generating must not open a second session. The guard is
    the in-flight flag, not a debounce, so the FIRST press is honoured immediately even when the text
    lane's debounce has not yet elapsed.
    */
    if (aiInFlightRef.current) return;

    const generation = bumpGeneration();
    aiInFlightRef.current = true;
    setAiLoading(true);
    // Keep any existing text rows visible while generating; they remain labelled as the text lane.
    setState((previous) => ({ ...previous, error: null }));

    const result = await runRequest(generation, (signal) => aiSearchTasks(trimmedQuery, {
      signal,
      ...(projectId ? { projectId } : {}),
      ...(nodeId ? { nodeId } : {}),
      ...(localNodeId ? { localNodeId } : {}),
    }));

    if ("stale" in result) return;
    if (!isCurrent(generation)) return;
    aiInFlightRef.current = false;
    setAiLoading(false);

    if (!result.ok) {
      /*
      A failed AI search must NOT masquerade as a successful empty AI answer. The panel keeps the
      text rows it already had, still labelled `text`, and surfaces a recoverable error the operator
      can retry with Enter. Nothing retries a model automatically.
      */
      setState((previous) => ({ ...previous, lane: "text", error: toSearchError("ai", result.error) }));
      return;
    }

    // Fence on the echoed query: a response for a phrase the field no longer holds is discarded.
    if (result.value.query !== trimmedQuery) return;

    const tasks = result.value.tasks ?? [];
    seenIdsRef.current = new Set(tasks.map((task) => task.id.toLocaleLowerCase()));
    setState((previous) => ({
      tasks,
      lane: "ai",
      hasMore: false,
      total: tasks.length,
      cursor: null,
      error: null,
      progress: previous.progress + 1,
    }));
  }, [bumpGeneration, enabled, isCurrent, localNodeId, nodeId, projectId, runRequest, trimmedQuery]);

  const reset = useCallback(() => {
    bumpGeneration();
    seenIdsRef.current = new Set();
    setLoading(false);
    setAiLoading(false);
    setState(EMPTY_STATE);
  }, [bumpGeneration]);

  const collectionKey = useMemo(() => `${contextKey}\u0000${state.lane}`, [contextKey, state.lane]);

  return {
    tasks: state.tasks,
    lane: state.lane,
    loading,
    aiLoading,
    hasMore: state.hasMore,
    error: state.error,
    total: state.total,
    progressKey: `${collectionKey}\u0000${state.progress}`,
    collectionKey,
    loadMore,
    runAiSearch,
    reset,
  };
}
