/*
FNXC:DashboardHealth 2026-06-24-00:00:
Dashboard backend health (engine availability, task-id integrity, db-corruption status), fetched on mount and refreshable on demand. Extracted from AppInner; exposes setHealth so the TaskIdIntegrityBanner can patch the cached health from its own remediation callback.
*/

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { DashboardHealthResponse } from "../api";
import { fetchDashboardHealth, refreshDashboardHealth } from "../api";

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

  useEffect(() => {
    let cancelled = false;

    fetchDashboardHealth()
      .then((next) => {
        if (!cancelled) {
          setHealth(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHealth(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { health, setHealth, refreshing, refreshError, refresh };
}
