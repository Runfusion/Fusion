import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchPluginUiSlots } from "../api";
import type { PluginUiSlotEntry } from "../api";

const uiSlotsCache = new Map<string, { slots: PluginUiSlotEntry[]; expiresAt: number }>();
const CACHE_TTL_MS = 60_000; // 60 seconds — slots don't change frequently

interface UsePluginUiSlotsResult {
  /** All UI slot entries from active plugins */
  slots: PluginUiSlotEntry[];
  /** Look up slots matching a specific slotId */
  getSlotsForId: (slotId: string) => PluginUiSlotEntry[];
  /** True only during initial fetch, false during background refreshes */
  loading: boolean;
  /** Error message if fetch failed */
  error: string | null;
}

/**
 * Clears all entries from the UI slots cache.
 * Exported for testing purposes.
 */
export function __test_clearCache(): void {
  uiSlotsCache.clear();
}

/**
 * Hook for fetching and caching plugin UI slot definitions.
 *
 * Slots change rarely (only on plugin install/enable/disable), so this hook
 * uses a 60-second TTL cache rather than polling. No SSE invalidation for now.
 *
 * Loading contract (FN-1734): `loading` is `true` ONLY during the initial fetch.
 * Background refreshes (e.g., manual refetch) do NOT set `loading` to `true`,
 * preventing skeleton flicker during cache refreshes.
 */
export function usePluginUiSlots(projectId?: string): UsePluginUiSlotsResult {
  const [slots, setSlots] = useState<PluginUiSlotEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const initialLoadCompleteRef = useRef(false);
  const cancelledRef = useRef(false);

  const getSlotsForId = useCallback(
    (slotId: string): PluginUiSlotEntry[] => {
      return slots.filter((entry) => entry.slot.slotId === slotId);
    },
    [slots],
  );

  useEffect(() => {
    const cacheKey = projectId ?? "default";
    let cancelled = false;

    async function load(): Promise<void> {
      // Check cache first — return immediately without loading flicker
      const cached = uiSlotsCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        if (cancelled || cancelledRef.current) return;
        setSlots(cached.slots);
        setLoading(false);
        return;
      }

      // Determine if this is the initial load
      const isInitial = !initialLoadCompleteRef.current;
      if (isInitial) {
        setLoading(true);
      }
      setError(null);

      try {
        const data = await fetchPluginUiSlots(projectId);
        if (cancelled || cancelledRef.current) return;

        // Store in cache
        uiSlotsCache.set(cacheKey, {
          slots: data,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });

        setSlots(data);
        initialLoadCompleteRef.current = true;
      } catch (err) {
        if (cancelled || cancelledRef.current) return;
        setError(err instanceof Error ? err.message : "Failed to fetch UI slots");
        initialLoadCompleteRef.current = true;
      } finally {
        if (!cancelled && !cancelledRef.current) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Reset state when projectId changes
  useEffect(() => {
    initialLoadCompleteRef.current = false;
    cancelledRef.current = false;
  }, [projectId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  return useMemo(
    () => ({
      slots,
      getSlotsForId,
      loading,
      error,
    }),
    [slots, getSlotsForId, loading, error],
  );
}
