import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NodeMeshState } from "@fusion/core";
import { fetchMeshState } from "../api";
import { recordResumeEvent } from "../utils/resumeInstrumentation";
import { isVisibilityResumeError, useTabVisibilitySuspension, useVisibilityAwarePoll } from "./visibilitySuspension";

const POLL_INTERVAL_MS = 10000;
const VISIBILITY_REFRESH_DEBOUNCE_MS = 1000;

export interface UseMeshStateResult {
  meshState: NodeMeshState[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useMeshState(): UseMeshStateResult {
  const { t } = useTranslation("app");
  const [meshState, setMeshState] = useState<NodeMeshState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastVisibilityRefreshRef = useRef<number>(0);
  const meshStateRef = useRef(meshState);
  const visibilitySuspension = useTabVisibilitySuspension();

  useEffect(() => {
    meshStateRef.current = meshState;
  }, [meshState]);

  const shouldSuppressVisibilityResumeError = useCallback((errorMessage: string): boolean => {
    return meshStateRef.current.length > 0 && isVisibilityResumeError(errorMessage, visibilitySuspension.wasRecentlyHidden());
  }, [visibilitySuspension]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchMeshState();
      setMeshState(data.nodes);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : t("mesh.failedToFetchMeshState", "Failed to fetch mesh state");
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
        const data = await fetchMeshState();
        if (!cancelled) {
          setMeshState(data.nodes);
          setError(null);
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : t("mesh.failedToFetchMeshState", "Failed to fetch mesh state");
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
        recordResumeEvent({
          view: "useMeshState",
          trigger: "visibility",
          projectId: undefined,
          replayAttempted: false,
          reason: "debounce-skipped",
          detail: { timeSinceLastRefreshMs: timeSinceLastRefresh },
        });
        return;
      }
      lastVisibilityRefreshRef.current = now;
      recordResumeEvent({
        view: "useMeshState",
        trigger: "visibility",
        projectId: undefined,
        replayAttempted: false,
        reason: "debounced-refresh",
      });
      void refresh();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refresh, shouldSuppressVisibilityResumeError, t]);

  /*
  FNXC:MobileTabRetention 2026-07-26-16:05:
  This 10s mesh-state poll was NOT visibility-gated: the `visibilitychange` listener above only ADDS a refresh
  on the visible edge and never cleared the interval, so a backgrounded tab kept fetching mesh state every 10
  seconds. Background network work is the primary signal iOS Safari / iOS PWA / Chrome Android use to discard
  a tab, producing the white-splash reload on return.

  `refreshOnVisible: false` because the debounced, instrumented listener above already owns the visible-edge
  refresh; letting the helper refresh too would fetch twice on one edge.
  */
  useVisibilityAwarePoll(refresh, POLL_INTERVAL_MS, { enabled: !loading, refreshOnVisible: false });

  return { meshState, loading, error, refresh };
}
