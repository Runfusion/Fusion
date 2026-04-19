import { useState, useEffect, useCallback, useRef } from "react";
import type { ProjectInfo } from "../api";
import {
  fetchProjectsAcrossNodes,
  registerProject,
  unregisterProject,
  updateProject,
  type ProjectCreateInput,
  type ProjectInfoWithSource,
} from "../api";

export interface UseProjectsResult {
  /** List of all registered projects (local + remote) */
  projects: ProjectInfoWithSource[];
  /** Loading state for initial fetch */
  loading: boolean;
  /** Error message if fetch failed */
  error: string | null;
  /** Manually refresh projects list */
  refresh: () => Promise<void>;
  /** Register a new project */
  register: (input: ProjectCreateInput) => Promise<ProjectInfo>;
  /** Update an existing project */
  update: (id: string, updates: Partial<ProjectInfo>) => Promise<ProjectInfo>;
  /** Unregister a project */
  unregister: (id: string) => Promise<void>;
}

const POLL_INTERVAL_MS = 5000; // 5 seconds
const VISIBILITY_REFRESH_DEBOUNCE_MS = 1000;

/**
 * Hook for fetching and managing projects.
 * Automatically polls for updates every 5 seconds.
 * Refetches when the tab becomes visible again.
 * Provides optimistic updates for UI responsiveness.
 */
export function useProjects(): UseProjectsResult {
  const [projects, setProjects] = useState<ProjectInfoWithSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastVisibilityRefreshRef = useRef<number>(0);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchProjectsAcrossNodes();
      setProjects(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch projects");
      // Don't clear existing projects on error - keep showing stale data
    }
  }, []);

  // Initial fetch and visibility change handler
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const data = await fetchProjectsAcrossNodes();
        if (!cancelled) {
          setProjects(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to fetch projects");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

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
  }, [refresh]);

  // Polling for updates
  useEffect(() => {
    // Only start polling after initial load completes
    if (loading) return;

    intervalRef.current = setInterval(() => {
      refresh();
    }, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [loading, refresh]);

  const register = useCallback(async (input: ProjectCreateInput): Promise<ProjectInfo> => {
    const project = await registerProject(input);
    // Optimistically add to list
    setProjects((prev) => [...prev, project]);
    return project;
  }, []);

  const update = useCallback(async (id: string, updates: Partial<ProjectInfo>): Promise<ProjectInfo> => {
    const project = await updateProject(id, updates);
    // Optimistically update in list
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? project : p))
    );
    return project;
  }, []);

  const unregister = useCallback(async (id: string): Promise<void> => {
    await unregisterProject(id);
    // Optimistically remove from list
    setProjects((prev) => prev.filter((p) => p.id !== id));
  }, []);

  return {
    projects,
    loading,
    error,
    refresh,
    register,
    update,
    unregister,
  };
}
