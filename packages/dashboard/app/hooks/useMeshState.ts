import { useCallback, useEffect, useRef, useState } from "react";
import type { MeshClusterSnapshot } from "@fusion/core";
import { fetchMeshState } from "../api";

const POLL_INTERVAL_MS = 10000;
const VISIBILITY_REFRESH_DEBOUNCE_MS = 1000;

export interface UseMeshStateResult {
  meshState: MeshClusterSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useMeshState(): UseMeshStateResult {
  const [meshState, setMeshState] = useState<MeshClusterSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastVisibilityRefreshRef = useRef<number>(0);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchMeshState();
      setMeshState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch mesh state");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const data = await fetchMeshState();
        if (!cancelled) {
          setMeshState(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to fetch mesh state");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastVisibilityRefreshRef.current < VISIBILITY_REFRESH_DEBOUNCE_MS) return;
      lastVisibilityRefreshRef.current = now;
      void refresh();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refresh]);

  useEffect(() => {
    if (loading) return;
    intervalRef.current = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [loading, refresh]);

  return { meshState, loading, error, refresh };
}
