import { useState, useEffect, useRef, useCallback } from "react";
import type { ArtifactType, ArtifactWithTask } from "@fusion/core";
import { fetchArtifacts } from "../api";
import { subscribeSse } from "../sse-bus";
import { readCache, SWR_CACHE_KEYS, SWR_DEFAULT_MAX_AGE_MS, writeCache } from "../utils/swrCache";

export interface UseArtifactsResult {
  /** List of artifacts across agents and tasks */
  artifacts: ArtifactWithTask[];
  /** Loading state - true only for initial fetch, false during refresh/search */
  loading: boolean;
  /** Error message if artifact fetch failed */
  error: string | null;
  /** Refresh artifacts from the server */
  refresh: () => Promise<void>;
}

/**
 * FNXC:ArtifactRegistry 2026-06-21-04:46:
 * The Documents Artifacts tab lists registry entries created by any agent, user, or system actor. Mirror the documents SWR pattern so cross-agent artifact search revalidates in the background without hiding the existing gallery during debounce or manual refresh.
 */
export function useArtifacts(options?: {
  /** Project ID for project-scoped fetching */
  projectId?: string;
  /** Filter artifacts by media type */
  type?: ArtifactType;
  /** Filter artifacts by author id */
  authorId?: string;
  /** Filter artifacts by parent task id */
  taskId?: string;
  /** Search query for artifact title/description */
  searchQuery?: string;
}): UseArtifactsResult {
  const { projectId, type, authorId, taskId, searchQuery } = options ?? {};
  const filterKey = JSON.stringify({ type: type ?? null, authorId: authorId ?? null, taskId: taskId ?? null });
  const projectScopeKey = projectId ?? "__default__";
  const cacheKey = `${SWR_CACHE_KEYS.ARTIFACTS_PREFIX}${projectScopeKey}:${filterKey}`;
  const [artifacts, setArtifacts] = useState<ArtifactWithTask[]>(() => {
    const cached = readCache<ArtifactWithTask[]>(cacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    return Array.isArray(cached) ? cached : [];
  });
  const [loading, setLoading] = useState(() => artifacts.length === 0);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const initialLoadCompleteRef = useRef(artifacts.length > 0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const sseRefreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }

    const requestController = new AbortController();
    abortRef.current = requestController;

    const isInitial = !initialLoadCompleteRef.current;
    if (isInitial) {
      setLoading(true);
    }
    setError(null);

    try {
      const fetched = await fetchArtifacts({
        type,
        authorId,
        taskId,
        q: searchQuery,
      }, projectId);

      if (requestController.signal.aborted) {
        return;
      }

      setArtifacts(fetched);
      if (cacheKey) {
        const cachedPayload = fetched.length > 500 ? fetched.slice(0, 500) : fetched;
        writeCache(cacheKey, cachedPayload, { maxBytes: 500_000 });
      }
      initialLoadCompleteRef.current = true;
    } catch (err) {
      if (requestController.signal.aborted) {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!requestController.signal.aborted && isInitial) {
        setLoading(false);
      }
    }
  }, [authorId, cacheKey, projectId, searchQuery, taskId, type]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    const cached = readCache<ArtifactWithTask[]>(cacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    if (Array.isArray(cached)) {
      setArtifacts(cached);
      initialLoadCompleteRef.current = true;
      setLoading(false);
    } else {
      initialLoadCompleteRef.current = false;
      setArtifacts([]);
      setLoading(true);
    }
  }, [cacheKey]);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      void refresh();
    }, 300);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [refresh]);

  useEffect(() => {
    /*
     * FNXC:ArtifactRegistry 2026-06-27-00:00:
     * Already-open task and project artifact lists must live-refresh from TaskStore's authoritative artifact:registered SSE event and also accept the best-effort agent/chat message notifications as an additional signal. Task-scoped hooks filter by artifact/task metadata while project-scoped hooks rely on the projectId refetch and optional payload projectId guard, preserving SWR cached rendering, search filters, and scoped fetch behavior without showing a loading flash.
     *
     * FNXC:ArtifactRegistry 2026-07-10-00:00:
     * Single-project dashboards do not always have a currentProject id when the Documents view mounts. The Artifacts tab must still fetch the server's default project scope and subscribe to unscoped SSE; otherwise the hook returns [] forever and the tab count stays 0 even though GET /api/artifacts and agent-created image media are valid.
     */
    const handleArtifactRegistration = (event: MessageEvent, source: "artifact" | "message") => {
      try {
        const payload = JSON.parse(event.data) as {
          id?: string | null;
          projectId?: string | null;
          taskId?: string | null;
          metadata?: {
            artifactId?: string | null;
            taskId?: string | null;
          } | null;
        };
        const artifactId = source === "artifact" ? payload.id : payload.metadata?.artifactId;
        const artifactTaskId = source === "artifact" ? payload.taskId : payload.metadata?.taskId;
        if (!artifactId) return;
        if (projectId && payload.projectId && payload.projectId !== projectId) return;
        if (taskId && artifactTaskId !== taskId) return;

        if (sseRefreshDebounceRef.current) {
          return;
        }

        sseRefreshDebounceRef.current = setTimeout(() => {
          sseRefreshDebounceRef.current = null;
          void refreshRef.current();
        }, 300);
      } catch {
        // no-op: malformed or non-JSON SSE payloads must not trigger artifact refetches.
      }
    };
    const handleAuthoritativeArtifact = (event: MessageEvent) => handleArtifactRegistration(event, "artifact");
    const handleArtifactMessage = (event: MessageEvent) => handleArtifactRegistration(event, "message");

    const params = new URLSearchParams();
    if (projectId) {
      params.set("projectId", projectId);
    }
    const query = params.size > 0 ? `?${params.toString()}` : "";
    const unsubscribe = subscribeSse(`/api/events${query}`, {
      events: {
        "artifact:registered": handleAuthoritativeArtifact,
        "message:received": handleArtifactMessage,
        "message:sent": handleArtifactMessage,
      },
    });

    return () => {
      unsubscribe();
      if (sseRefreshDebounceRef.current) {
        clearTimeout(sseRefreshDebounceRef.current);
        sseRefreshDebounceRef.current = null;
      }
    };
  }, [projectId, taskId]);

  useEffect(() => {
    void refresh();

    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
      if (sseRefreshDebounceRef.current) {
        clearTimeout(sseRefreshDebounceRef.current);
        sseRefreshDebounceRef.current = null;
      }
    };
  }, []);

  return {
    artifacts,
    loading,
    error,
    refresh,
  };
}
