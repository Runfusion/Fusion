/*
FNXC:TaskQueueOrder 2026-09-17-13:51:
FN-509 — load the HEAD of every visible board lane in that lane's own server order.

WHY THIS EXISTS. The board's generic page (`GET /tasks/page`) selects live work by creation
ascending across every lane and truncates at its limit. For a project whose current work exceeds one
page that truncation happens BEFORE any client sort, so a boosted card — or a freshly captured Ideas
card — that starts beyond the limit is simply not in the payload, and reloading never brings it to
the head of its column. This hook asks the server for each lane's own ordered head instead
(`order=queue` for processing lanes, `order=intake` for manual capture), so the rows the operator
must see first are always present.

ADDITIVE BY CONSTRUCTION. It only CONTRIBUTES rows; the board keeps its own snapshot as the
authority for any id it already holds, so SSE freshness, live mutation fences and the Done
accumulator are untouched. A failed or unavailable fetch degrades to the generic page.

FENCING. Every response carries the generation and project it was requested under. A project switch,
a scope change, or a newer refresh invalidates in-flight work, so a late response from the previous
incarnation can never publish rows into the current one.
*/
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "@fusion/core";
import * as api from "../api";

export interface TaskQueueScope {
  /** Stable identity of this lane scope within the current board view. */
  key: string;
  /** Column ids sharing this order. */
  columns: readonly string[];
  order: "queue" | "intake";
}

export interface UseTaskQueuePagesOptions {
  /** Rows requested per lane head. */
  limit?: number;
  /** When false the hook performs no request and reports no rows. */
  enabled?: boolean;
  /** Bump to re-request every lane head (for example after a Boost is confirmed). */
  refreshToken?: number;
}

export interface UseTaskQueuePagesResult {
  /** The union of every loaded lane head, deduplicated by id. */
  tasks: Task[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const EMPTY_TASKS: Task[] = [];

/*
FNXC:TaskQueueOrder 2026-09-17-13:51:
Resolve the lane reader DEFENSIVELY. Hosts that render the board against a partial `../api` double
(every existing Board suite does) expose no `fetchTaskQueuePage`, and merely READING an undeclared
export off such a module throws. A missing reader is the documented degradation — the generic board
page still supplies the project's live rows — so it must not take the board down.
*/
function resolveLaneReader(): typeof api.fetchTaskQueuePage | undefined {
  try {
    return typeof api.fetchTaskQueuePage === "function" ? api.fetchTaskQueuePage : undefined;
  } catch {
    return undefined;
  }
}

function scopeSignature(scopes: readonly TaskQueueScope[]): string {
  return scopes
    .map((scope) => `${scope.key}:${scope.order}:${[...scope.columns].sort().join(",")}`)
    .sort()
    .join("|");
}

export function useTaskQueuePages(
  projectId: string | undefined,
  scopes: readonly TaskQueueScope[],
  options?: UseTaskQueuePagesOptions,
): UseTaskQueuePagesResult {
  const limit = options?.limit ?? 50;
  const enabled = options?.enabled !== false;
  const refreshToken = options?.refreshToken ?? 0;
  const [tasks, setTasks] = useState<Task[]>(EMPTY_TASKS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualToken, setManualToken] = useState(0);
  const generationRef = useRef(0);
  const signature = scopeSignature(scopes);
  // The signature is the identity; the array reference changes on every parent render.
  const scopesRef = useRef(scopes);
  scopesRef.current = scopes;

  const refresh = useCallback(() => setManualToken((value) => value + 1), []);

  useEffect(() => {
    const generation = ++generationRef.current;
    const activeScopes = scopesRef.current;
    const fetchLane = resolveLaneReader();
    if (!enabled || !projectId || activeScopes.length === 0 || !fetchLane) {
      setTasks(EMPTY_TASKS);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const pages = await Promise.all(activeScopes.map(async (scope) => {
          try {
            const page = await fetchLane(projectId, {
              columns: scope.columns,
              order: scope.order,
              limit,
              signal: controller.signal,
            });
            return page.tasks ?? [];
          } catch {
            /*
            One unavailable lane must not blank the others: the generic board page still carries
            the project's live rows, so a lane head is strictly supplementary evidence.
            */
            return [] as Task[];
          }
        }));
        if (generationRef.current !== generation) return;
        const byId = new Map<string, Task>();
        for (const page of pages) for (const task of page) byId.set(task.id, task);
        setTasks(byId.size === 0 ? EMPTY_TASKS : [...byId.values()]);
        setLoading(false);
      } catch (err) {
        if (generationRef.current !== generation) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
    return () => {
      controller.abort();
    };
  }, [enabled, limit, projectId, signature, refreshToken, manualToken]);

  return useMemo(() => ({ tasks, loading, error, refresh }), [tasks, loading, error, refresh]);
}
