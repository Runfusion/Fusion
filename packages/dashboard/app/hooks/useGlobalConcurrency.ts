import { useCallback, useEffect, useReducer } from "react";
import { fetchGlobalConcurrency } from "../api/legacy";

/*
FNXC:CapacityModel 2026-07-28-23:45 (drop the cross-project cap — settings half):
READ-ONLY NOW. This hook owned an editable machine-wide concurrency cap. That
limiter is deleted (capacity is two numbers PER PROJECT), so everything that existed
only to PERSIST a value went with it: the 500ms debounce, the save-state machine,
the commit-on-close/unmount flush, the slider clamp/bounds, and the `interactive`
gate that guarded a writable control.

What remains is live utilization TELEMETRY — "N running (all projects)" plus the
per-project breakdown — which the footer and Command Center still display. Nothing
gates on it.

The module-level shared store is KEPT even though no write can race any more. Two
independently-mounted consumers (footer EngineControlMenu, Command Center card)
read this, and the original reason for the singleton was that separate copies
drift — that argument holds for a polled read exactly as it did for a cap. It also
means one fetch serves both.

Retained deliberately, because they were about READS, not writes:
- Language changes (i18n `t`) must never refetch, so `t` is not a dependency here.
- `activeWhen` gates fetching so the footer menu only loads while open.
- A failed read reports zero rather than presenting stale counts as current.
*/

type GlobalConcurrencyStatus = "idle" | "loading" | "loaded" | "error";

const cache: {
  status: GlobalConcurrencyStatus;
  currentlyActive: number | null;
  projectsActive: Record<string, number>;
} = {
  status: "idle",
  currentlyActive: null,
  projectsActive: {},
};
const subscribers = new Set<() => void>();
let inFlight: Promise<void> | null = null;

function notify() {
  for (const subscriber of subscribers) subscriber();
}

function setCache(next: {
  status: GlobalConcurrencyStatus;
  currentlyActive?: number | null;
  projectsActive?: Record<string, number>;
}) {
  cache.status = next.status;
  if (next.currentlyActive !== undefined) cache.currentlyActive = next.currentlyActive;
  if (next.projectsActive !== undefined) cache.projectsActive = next.projectsActive;
  notify();
}

/** Fetch live counts, deduping concurrent callers via an in-flight promise. */
function ensureFetched(force = false): Promise<void> {
  if (inFlight) return inFlight;
  if (!force && cache.status === "loaded") return Promise.resolve();
  setCache({ status: "loading" });
  inFlight = (async () => {
    try {
      const result = await fetchGlobalConcurrency();
      setCache({
        status: "loaded",
        currentlyActive: result.currentlyActive,
        projectsActive: result.projectsActive,
      });
    } catch {
      setCache({ status: "error", currentlyActive: null, projectsActive: {} });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export interface UseGlobalConcurrencyResult {
  status: GlobalConcurrencyStatus;
  /** Live running-agent count across all projects; 0 unless loaded. */
  currentlyActive: number;
  projectActiveCount: (projectId?: string) => number;
}

export function useGlobalConcurrency(opts?: { activeWhen?: boolean }): UseGlobalConcurrencyResult {
  const activeWhen = opts?.activeWhen ?? true;

  // Force a re-render whenever the shared store notifies this instance.
  const [, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    subscribers.add(bump);
    return () => {
      subscribers.delete(bump);
    };
  }, []);

  // Force-revalidate each time the surface activates (menu opens / card mounts):
  // the counts are live, so a fetch-once cache would show a stale figure.
  useEffect(() => {
    if (!activeWhen) return;
    void ensureFetched(true);
  }, [activeWhen]);

  const countsAreLoaded = cache.status === "loaded";
  const projectActiveCount = useCallback((projectId?: string) => {
    if (!countsAreLoaded || !projectId) return 0;
    return cache.projectsActive[projectId] ?? 0;
  }, [countsAreLoaded]);

  return {
    status: cache.status,
    currentlyActive: countsAreLoaded ? (cache.currentlyActive ?? 0) : 0,
    projectActiveCount,
  };
}
