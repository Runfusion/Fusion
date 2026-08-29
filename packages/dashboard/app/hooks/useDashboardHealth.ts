/*
FNXC:DashboardHealth 2026-06-24-00:00:
Dashboard backend health (engine availability, task-id integrity, db-corruption status), fetched on mount and refreshable on demand. Extracted from AppInner; exposes setHealth so the TaskIdIntegrityBanner can patch the cached health from its own remediation callback.
*/

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { DashboardHealthResponse } from "../api";
import { fetchDashboardHealth, refreshDashboardHealth } from "../api";
import { useVisibilityAwarePoll } from "./visibilitySuspension";

const HEALTH_POLL_INTERVAL_MS = 15_000;

export interface UseDashboardHealthResult {
  health: DashboardHealthResponse | null;
  setHealth: Dispatch<SetStateAction<DashboardHealthResponse | null>>;
  refreshing: boolean;
  refreshError: string | null;
  refresh: () => Promise<void>;
}

export function useDashboardHealth(): UseDashboardHealthResult {
  const [health, setHealth] = useState<DashboardHealthResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const next = await refreshDashboardHealth();
      setHealth(next);
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Failed to refresh database health.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  const cancelledRef = useRef(false);
  const settledOnceRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  /*
   * FNXC:DashboardHealth 2026-07-03-08:40:
   * Poll health periodically instead of fetching once on mount. Engine availability is transient:
   * right after a project is created the engine is still starting, so the first fetch reports
   * engine.available=false and the "AI engine is not running" banner shows. Without polling, health
   * was never refreshed, so the banner stayed up permanently even after the engine came online.
   * Re-fetching every 15s lets the banner clear on its own. Preserve the previous value on transient
   * poll errors (only clear to null if we never had a value) so banners don't flicker.
   */
  const load = useCallback(() => {
    fetchDashboardHealth()
      .then((next) => {
        if (cancelledRef.current) return;
        settledOnceRef.current = true;
        setHealth(next);
      })
      .catch(() => {
        if (cancelledRef.current) return;
        setHealth((prev) => (settledOnceRef.current ? prev : null));
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /*
  FNXC:MobileTabRetention 2026-07-26-10:46:
  The 15s health poll is suspended while the document is hidden. A backgrounded page that keeps hitting the
  network is discarded by iOS Safari/PWA and Chrome Android, which is the cold white-splash reload operators
  saw on return; the banner's self-clearing behavior above is preserved because the hidden -> visible edge
  re-fetches once before the interval re-arms.
  */
  useVisibilityAwarePoll(load, HEALTH_POLL_INTERVAL_MS);

  return { health, setHealth, refreshing, refreshError, refresh };
}
