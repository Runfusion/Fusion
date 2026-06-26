import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { fetchGlobalConcurrency, updateGlobalConcurrency } from "../api/legacy";

/*
FNXC:GlobalConcurrencyControls 2026-06-25-22:45:
The global Max Concurrent cap is ONE shared, cross-project value persisted via /api/global-concurrency. Two independently-mounted sliders (the footer EngineControlMenu and the Command Center Concurrency card) must read and write a single source of truth, so this hook is backed by a MODULE-LEVEL shared store (a singleton cache plus a Set of subscriber callbacks). Without a shared store the two sliders kept private copies and produced last-writer-wins / stale-clobber bugs: dragging one slider, then opening the other, showed (and could re-persist) a stale value over the real cap.

Invariants this hook enforces, all of which prior duplicated logic broke:
- Revalidate after EVERY successful PUT: commit() calls setCache(), which notifies ALL subscribers so both sliders re-sync to the just-persisted value.
- Treat fetch-error as NON-interactive: a failed load left the old slider enabled showing the floor value (1); a drag then persisted 1 over the real cap. interactive is true ONLY when status === "loaded".
- Surface save-state (saving / saved / error) like the per-project sliders, including a retry-friendly error that KEEPS the user's value (never silently reverts).
- Flush pending debounced edits on close/unmount: dragging then closing the menu (or unmounting the card) used to drop the in-flight write. A cleanup flush commits it immediately.
- Language changes (i18n `t`) must NOT refetch/reset, so `t` is intentionally never in a dependency array here.
*/

const SLIDER_MIN = 1;
const SLIDER_BASE_MAX = 32;
const DEBOUNCE_MS = 500;

type GlobalConcurrencyStatus = "idle" | "loading" | "loaded" | "error";

// FNXC:GlobalConcurrencyControls 2026-06-25-22:45: Module-level singleton cache + subscriber set is the single source of truth shared by every mounted hook instance.
const cache: { value: number | null; status: GlobalConcurrencyStatus } = {
  value: null,
  status: "idle",
};
const subscribers = new Set<() => void>();
let inFlight: Promise<void> | null = null;

function notify() {
  for (const subscriber of subscribers) subscriber();
}

function setCache(next: { value: number | null; status: GlobalConcurrencyStatus }) {
  cache.value = next.value;
  cache.status = next.status;
  notify();
}

// FNXC:GlobalConcurrencyControls 2026-06-25-22:45: Fetch once and dedupe concurrent callers via an in-flight promise. On error keep the previous value and mark status "error" so the slider goes non-interactive instead of falsely showing the floor.
function ensureFetched(force = false): Promise<void> {
  if (inFlight) return inFlight;
  if (!force && cache.status === "loaded") return Promise.resolve();
  setCache({ value: cache.value, status: "loading" });
  inFlight = (async () => {
    try {
      const result = await fetchGlobalConcurrency();
      setCache({ value: result.globalMaxConcurrent, status: "loaded" });
    } catch {
      // Keep the previous value; non-interactive while in error state.
      setCache({ value: cache.value, status: "error" });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export interface UseGlobalConcurrencyResult {
  value: number;
  min: number;
  sliderMax: number;
  interactive: boolean;
  status: GlobalConcurrencyStatus;
  saveState: "idle" | "saving" | "saved" | "error";
  setValue: (raw: string) => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * FNXC:GlobalConcurrencyControls 2026-06-25-22:45:
 * Shared hook for the cross-project global concurrency cap. `activeWhen` (default true)
 * gates fetching so the footer menu only loads when open; the Command Center card calls
 * it with no args. Backed by the module-level shared store above.
 */
export function useGlobalConcurrency(opts?: { activeWhen?: boolean }): UseGlobalConcurrencyResult {
  const activeWhen = opts?.activeWhen ?? true;

  // Force a re-render whenever the shared store notifies this instance.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  // Local optimistic state for snappy dragging.
  const dirtyRef = useRef(false);
  const pendingValueRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [localValue, setLocalValue] = useState<number | null>(null);

  // Subscribe to the shared store on mount.
  useEffect(() => {
    subscribers.add(bump);
    return () => {
      subscribers.delete(bump);
    };
  }, []);

  const currentValue = (dirtyRef.current ? localValue : cache.value) ?? SLIDER_MIN;
  // FNXC:GlobalConcurrencyControls 2026-06-25-22:45: sliderMax expands past the base cap so already-persisted values >32 still render truthfully.
  const sliderMax = Math.max(SLIDER_BASE_MAX, currentValue);
  // FNXC:GlobalConcurrencyControls 2026-06-26-06:05: Track the current value in a ref so setValue (a stable useCallback) clamps against the real ceiling without going stale; used to give the clamp an actual upper bound.
  const currentValueRef = useRef(currentValue);
  currentValueRef.current = currentValue;

  const commit = useCallback((v: number) => {
    // FNXC:GlobalConcurrencyControls 2026-06-26-06:05: Synchronously null the pending ref BEFORE the async PUT so the close-flush and unmount-cleanup guards (`dirtyRef && pendingValueRef != null`) are already false — otherwise a close-then-unmount within the in-flight window fires commit() twice and sends a duplicate PUT. dirtyRef stays true until the PUT resolves so the slider keeps showing the user's value (no snap-back) during save.
    pendingValueRef.current = null;
    setSaveState("saving");
    void updateGlobalConcurrency({ globalMaxConcurrent: v })
      .then(() => {
        // Notifies ALL subscribers → both sliders re-sync to the persisted value.
        setCache({ value: v, status: "loaded" });
        dirtyRef.current = false;
        pendingValueRef.current = null;
        setLocalValue(null);
        setSaveState("saved");
      })
      .catch(() => {
        // KEEP dirty + the user's value so the next drag retries; never silently revert.
        setSaveState("error");
      });
  }, []);

  const setValue = useCallback((raw: string) => {
    // FNXC:GlobalConcurrencyControls 2026-06-26-06:05: Clamp against a real ceiling (base cap expanded only by the already-persisted value), not Number(raw) — the latter made the upper bound equal the input, so there was no effective ceiling and a programmatic caller could set an arbitrarily large cap.
    const next = clamp(Number(raw), SLIDER_MIN, Math.max(SLIDER_BASE_MAX, currentValueRef.current));
    dirtyRef.current = true;
    pendingValueRef.current = next;
    setLocalValue(next);
    setSaveState("saving");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      commit(next);
    }, DEBOUNCE_MS);
  }, [commit]);

  // FNXC:GlobalConcurrencyControls 2026-06-26-06:05: Force-revalidate each time the surface activates (menu opens / card mounts). The cap can be written out-of-band — notably the Settings modal persists globalMaxConcurrent directly via updateGlobalConcurrency() without going through this store — so a plain "fetch once then never again" cache would show a stale value after such a save. Forcing on activate keeps every consumer truthful; concurrent forces still dedupe via the in-flight promise. `t` deliberately excluded so language changes never refetch/reset.
  useEffect(() => {
    if (!activeWhen) return;
    void ensureFetched(true);
  }, [activeWhen]);

  // FNXC:GlobalConcurrencyControls 2026-06-25-22:45: When the shared cache changes and we are not mid-edit, drop the local pending so the slider reflects the new shared value.
  useEffect(() => {
    if (!dirtyRef.current) {
      setLocalValue(null);
      pendingValueRef.current = null;
    }
  }, [cache.value]);

  // FLUSH ON CLOSE/UNMOUNT: commit any pending debounced write immediately so a drag-then-close/unmount never drops it.
  useEffect(() => {
    if (activeWhen) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (dirtyRef.current && pendingValueRef.current != null) {
      commit(pendingValueRef.current);
    }
  }, [activeWhen, commit]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (dirtyRef.current && pendingValueRef.current != null) {
        commit(pendingValueRef.current);
      }
    };
  }, [commit]);

  return {
    value: currentValue,
    min: SLIDER_MIN,
    sliderMax,
    // interactive ONLY when loaded; loading/error → disabled slider.
    interactive: cache.status === "loaded",
    status: cache.status,
    saveState,
    setValue,
  };
}
