import { useState, useEffect, useCallback, useRef } from "react";
import type { ProjectInfo } from "../api";
import { fetchGlobalSettings, updateGlobalSettings } from "../api";

// Legacy localStorage key for migration - no longer used as primary storage
const LEGACY_STORAGE_KEY = "kb-dashboard-current-project";

/**
 * Get the node key used in dashboardCurrentProjectIdByNode.
 * Use "local" for the local node, otherwise use the node ID.
 */
function getNodeKey(nodeId: string | null): string {
  return nodeId ?? "local";
}

export interface UseCurrentProjectResult {
  /** Currently selected project or null if none selected */
  currentProject: ProjectInfo | null;
  /** Set the current project */
  setCurrentProject: (project: ProjectInfo | null) => void;
  /** Clear the current project selection (suppresses auto-select) */
  clearCurrentProject: () => void;
  /** Whether we're still loading from global settings */
  loading: boolean;
}

interface UseCurrentProjectOptions {
  /** Node ID from NodeContext - used to key project selection per node */
  nodeId?: string | null;
}

/**
 * Hook for managing the currently selected project.
 * Persists selection to global settings (server-backed) instead of localStorage.
 * This enables PWA fresh sessions to restore the correct project context.
 */
export function useCurrentProject(
  availableProjects: ProjectInfo[],
  options: UseCurrentProjectOptions = {},
): UseCurrentProjectResult {
  const { nodeId = null } = options;
  const [currentProject, setCurrentProjectState] = useState<ProjectInfo | null>(null);
  const [loading, setLoading] = useState(true);
  // Track if we've hydrated from global settings (vs just initialized)
  const hydratedRef = useRef(false);
  // When true, the user explicitly cleared the project (e.g. clicked "Projects")
  // and we should not auto-select until they pick one manually.
  const explicitlyClearedRef = useRef(false);
  // Cache of current settings to avoid repeated fetches
  const settingsCacheRef = useRef<Record<string, string> | null>(null);

  const nodeKey = getNodeKey(nodeId);

  // Load from global settings on mount
  useEffect(() => {
    let cancelled = false;

    async function loadFromGlobalSettings() {
      try {
        const settings = await fetchGlobalSettings();

        if (cancelled) return;

        // Build cache from settings
        settingsCacheRef.current = settings.dashboardCurrentProjectIdByNode ?? {};

        const savedProjectId = settingsCacheRef.current[nodeKey];
        if (savedProjectId) {
          // Try to find the saved project in available projects
          const found = availableProjects.find((p) => p.id === savedProjectId);
          if (found) {
            setCurrentProjectState(found);
            hydratedRef.current = true;
          }
          // If project not found, we'll handle in the next effect
          // (project may still be loading or was unregistered)
        }

        // Also migrate legacy localStorage if no global settings entry exists
        if (!savedProjectId) {
          try {
            const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
            if (legacy) {
              const parsed = JSON.parse(legacy) as ProjectInfo;
              if (parsed?.id) {
                // Check if project still exists
                const exists = availableProjects.some((p) => p.id === parsed.id);
                if (exists) {
                  setCurrentProjectState(parsed);
                  hydratedRef.current = true;
                  // Migrate to global settings
                  settingsCacheRef.current = { ...settingsCacheRef.current, [nodeKey]: parsed.id };
                  await updateGlobalSettings({
                    dashboardCurrentProjectIdByNode: settingsCacheRef.current,
                  }).catch(() => {
                    // Non-critical - migration failed, but we have the data in memory
                  });
                }
              }
            }
          } catch {
            // Ignore legacy localStorage errors
          }
        }
      } catch {
        // Global settings fetch failed - this is non-critical
        // We'll fall back to default behavior
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadFromGlobalSettings();

    return () => {
      cancelled = true;
    };
  }, [nodeKey, availableProjects]);

  // Validate project still exists and persist to global settings
  useEffect(() => {
    if (loading) return;

    if (currentProject) {
      // Validate project still exists in available projects
      const stillExists = availableProjects.some((p) => p.id === currentProject.id);
      if (!stillExists && availableProjects.length > 0) {
        // Project was unregistered - clear selection and default to first active
        const firstActive = availableProjects.find((p) => p.status === "active");
        setCurrentProjectState(firstActive || availableProjects[0] || null);
        return;
      }

      // Persist to global settings
      const newCache = { ...settingsCacheRef.current, [nodeKey]: currentProject.id };
      settingsCacheRef.current = newCache;
      updateGlobalSettings({ dashboardCurrentProjectIdByNode: newCache }).catch(() => {
        // Non-critical - persistence failed
      });
    } else if (availableProjects.length > 0 && !explicitlyClearedRef.current) {
      // No selection but projects available - default to first active
      // Skip if user explicitly cleared (navigated to overview)
      const firstActive = availableProjects.find((p) => p.status === "active");
      if (firstActive) {
        setCurrentProjectState(firstActive);
      }
    }
  }, [currentProject, availableProjects, loading, nodeKey]);

  const setCurrentProject = useCallback(
    (project: ProjectInfo | null) => {
      explicitlyClearedRef.current = false;
      setCurrentProjectState(project);

      if (project) {
        const newCache = { ...settingsCacheRef.current, [nodeKey]: project.id };
        settingsCacheRef.current = newCache;
        updateGlobalSettings({ dashboardCurrentProjectIdByNode: newCache }).catch(() => {
          // Non-critical - persistence failed
        });
      }
    },
    [nodeKey],
  );

  const clearCurrentProject = useCallback(() => {
    explicitlyClearedRef.current = true;
    setCurrentProjectState(null);

    // Remove from cache and persist
    const newCache = { ...settingsCacheRef.current };
    delete newCache[nodeKey];
    settingsCacheRef.current = newCache;
    updateGlobalSettings({ dashboardCurrentProjectIdByNode: newCache }).catch(() => {
      // Non-critical - persistence failed
    });
  }, [nodeKey]);

  return {
    currentProject,
    setCurrentProject,
    clearCurrentProject,
    loading,
  };
}
