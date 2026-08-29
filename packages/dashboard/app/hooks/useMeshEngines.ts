import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchMeshEngines, type MeshEngineStatusApi } from "../api";
import { isVisibilityResumeError, useTabVisibilitySuspension } from "./visibilitySuspension";

const POLL_INTERVAL_MS = 10000;
const VISIBILITY_REFRESH_DEBOUNCE_MS = 1000;

export interface UseMeshEnginesResult {
  engines: MeshEngineStatusApi[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/*
 * FNXC:MeshSharedPg 2026-06-25-00:00:
 * Sibling hook to useMeshState that fetches ACTIVE ENGINE CONNECTIONS from
 * shared PostgreSQL via GET /api/mesh/engines. Whereas useMeshState surfaces
 * node/peer discovery (mDNS + central registry), this hook surfaces per-engine
 * runtime status (in-flight tasks, active agents, last activity) read directly
 * from shared PG. NodesView passes `engines` into <MeshTopology> so the topology
 * view renders both the peer graph and the live engine connections.
 *
 * Mirrors useMeshState's polling + visibility-resume shape but is intentionally
 * lighter: engines status is a secondary panel, so a transient fetch failure
 * surfaces as an error string but does not tear down the topology graph
 * (handled in NodesView by reading meshState independently).
 */
export function useMeshEngines(): UseMeshEnginesResult {
  const { t } = useTranslation("app");
  const [engines, setEngines] = useState<MeshEngineStatusApi[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastVisibilityRefreshRef = useRef<number>(0);
  const enginesRef = useRef(engines);
  const visibilitySuspension = useTabVisibilitySuspension();

  useEffect(() => {
    enginesRef.current = engines;
  }, [engines]);

  const shouldSuppressVisibilityResumeError = useCallback((errorMessage: string): boolean => {
    return enginesRef.current.length > 0 && isVisibilityResumeError(errorMessage, visibilitySuspension.wasRecentlyHidden());
  }, [visibilitySuspension]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchMeshEngines();
      setEngines(data.engines);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : t("mesh.failedToFetchEngines", "Failed to fetch engine status");
      if (!shouldSuppressVisibilityResumeError(errorMessage)) {
        setError(errorMessage);
      }
    }
  }, [shouldSuppressVisibilityResumeError, t]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const data = await fetchMeshEngines();
        if (!cancelled) {
          setEngines(data.engines);
          setError(null);
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : t("mesh.failedToFetchEngines", "Failed to fetch engine status");
        if (!cancelled && !shouldSuppressVisibilityResumeError(errorMessage)) {
          setError(errorMessage);
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
      const timeSinceLastRefresh = now - lastVisibilityRefreshRef.current;
      if (timeSinceLastRefresh < VISIBILITY_REFRESH_DEBOUNCE_MS) {
        return;
      }
      lastVisibilityRefreshRef.current = now;
      void refresh();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refresh, shouldSuppressVisibilityResumeError, t]);

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

  return { engines, loading, error, refresh };
}
