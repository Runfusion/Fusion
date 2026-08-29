import { useState, useEffect, useCallback, useRef } from "react";
import type { ProjectInfo } from "../api";
import { fetchGlobalSettings, updateGlobalSettings } from "../api";
import { getProjectIdFromUrl } from "../utils/projectUrlState";
import { readCache, SWR_CACHE_KEYS, SWR_LONG_MAX_AGE_MS, writeCache } from "../utils/swrCache";

// Legacy localStorage key for migration - no longer used as primary storage
const LEGACY_STORAGE_KEY = "kb-dashboard-current-project";
export const CONSECUTIVE_ABSENCE_THRESHOLD = 3;

function getNodeKey(nodeId: string | null): string {
  return nodeId ?? "local";
}

export interface UseCurrentProjectResult {
  currentProject: ProjectInfo | null;
  setCurrentProject: (project: ProjectInfo | null) => void;
  clearCurrentProject: () => void;
  loading: boolean;
}

interface UseCurrentProjectOptions {
  nodeId?: string | null;
  projectsLoading?: boolean;
}

export function useCurrentProject(
  availableProjects: ProjectInfo[],
  options: UseCurrentProjectOptions = {},
): UseCurrentProjectResult {
  const { nodeId = null, projectsLoading = false } = options;
  const urlProjectId = getProjectIdFromUrl();
  const urlProject = urlProjectId
    ? availableProjects.find((project) => project.id === urlProjectId) ?? null
    : null;
  const cachedProjectId = readCache<string>(SWR_CACHE_KEYS.CURRENT_PROJECT_ID, { maxAgeMs: SWR_LONG_MAX_AGE_MS });
  const cachedProject =
    urlProject ??
    (typeof cachedProjectId === "string" && cachedProjectId.length > 0
      ? availableProjects.find((project) => project.id === cachedProjectId) ?? null
      : null);

  const [currentProject, setCurrentProjectState] = useState<ProjectInfo | null>(cachedProject);
  const [loading, setLoading] = useState(() => {
    if (urlProjectId) {
      return projectsLoading || (availableProjects.length === 0 && !urlProject);
    }
    return cachedProject === null;
  });
  const hydratedRef = useRef(false);
  const hydratedNodeKeyRef = useRef<string | null>(null);
  const explicitlyClearedRef = useRef(false);
  const settingsCacheRef = useRef<Record<string, string> | null>(null);
  const absentCountRef = useRef(0);
  const autoDefaultCountRef = useRef(0);

  const nodeKey = getNodeKey(nodeId);

  const persistCurrentProjectId = useCallback((projectId: string | null) => {
    writeCache(SWR_CACHE_KEYS.CURRENT_PROJECT_ID, projectId ?? "");
  }, []);

  const pickFallbackProject = useCallback((projects: ProjectInfo[]): ProjectInfo | null => {
    return projects.find((p) => p.status === "active") || projects[0] || null;
  }, []);

  const setListDrivenSelection = useCallback(
    (project: ProjectInfo | null) => {
      absentCountRef.current = 0;
      autoDefaultCountRef.current = 0;
      setCurrentProjectState(project);
      persistCurrentProjectId(project?.id ?? null);
    },
    [persistCurrentProjectId],
  );

  useEffect(() => {
    let cancelled = false;

    if (hydratedNodeKeyRef.current !== nodeKey) {
      hydratedNodeKeyRef.current = null;
      hydratedRef.current = false;
    }

    if (hydratedRef.current && hydratedNodeKeyRef.current === nodeKey) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    if (urlProjectId) {
      const foundFromUrl = availableProjects.find((project) => project.id === urlProjectId) ?? null;
      if (foundFromUrl) {
        explicitlyClearedRef.current = false;
        absentCountRef.current = 0;
        autoDefaultCountRef.current = 0;
        setCurrentProjectState(foundFromUrl);
        persistCurrentProjectId(foundFromUrl.id);
        hydratedRef.current = true;
        hydratedNodeKeyRef.current = nodeKey;
        setLoading(false);
      } else if (!projectsLoading) {
        explicitlyClearedRef.current = true;
        absentCountRef.current = 0;
        autoDefaultCountRef.current = 0;
        setCurrentProjectState(null);
        hydratedRef.current = true;
        hydratedNodeKeyRef.current = nodeKey;
        setLoading(false);
      } else {
        setLoading(true);
      }
      return () => {
        cancelled = true;
      };
    }

    const cacheResolvesToKnownProject =
      typeof cachedProjectId === "string" &&
      cachedProjectId.length > 0 &&
      availableProjects.some((project) => project.id === cachedProjectId);

    if (!cacheResolvesToKnownProject) {
      setLoading(true);
    }

    async function loadFromGlobalSettings() {
      try {
        const settings = await fetchGlobalSettings();

        if (cancelled) return;

        settingsCacheRef.current = settings.dashboardCurrentProjectIdByNode ?? {};

        const savedProjectId = settingsCacheRef.current[nodeKey];
        if (savedProjectId) {
          const found = availableProjects.find((p) => p.id === savedProjectId);
          if (found) {
            autoDefaultCountRef.current = 0;
            setCurrentProjectState(found);
            persistCurrentProjectId(found.id);
          }
        }

        if (!savedProjectId) {
          try {
            const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
            if (legacy) {
              const parsed = JSON.parse(legacy) as ProjectInfo;
              if (parsed?.id) {
                const exists = availableProjects.some((p) => p.id === parsed.id);
                if (exists) {
                  autoDefaultCountRef.current = 0;
                  setCurrentProjectState(parsed);
                  persistCurrentProjectId(parsed.id);
                  settingsCacheRef.current = { ...settingsCacheRef.current, [nodeKey]: parsed.id };
                  await updateGlobalSettings({
                    dashboardCurrentProjectIdByNode: settingsCacheRef.current,
                  }).catch(() => {
                    // Non-critical - migration failed, but we have the data in memory.
                  });
                }
              }
            }
          } catch {
            // Ignore legacy localStorage errors.
          }
        }
      } catch {
        // Global settings fetch failed - non-critical.
      } finally {
        if (!cancelled) {
          hydratedRef.current = true;
          hydratedNodeKeyRef.current = nodeKey;
          setLoading(false);
        }
      }
    }

    void loadFromGlobalSettings();

    return () => {
      cancelled = true;
    };
  }, [availableProjects, cachedProjectId, nodeKey, persistCurrentProjectId, projectsLoading, urlProjectId]);

  useEffect(() => {
    absentCountRef.current = 0;
    autoDefaultCountRef.current = 0;
  }, [currentProject?.id]);

  useEffect(() => {
    if (loading) return;

    if (urlProjectId && !currentProject) {
      return;
    }

    if (currentProject) {
      autoDefaultCountRef.current = 0;
      const stillExists = availableProjects.some((p) => p.id === currentProject.id);
      if (stillExists) {
        absentCountRef.current = 0;
      } else if (availableProjects.length === 0) {
        absentCountRef.current = 0;
      } else {
        absentCountRef.current += 1;
        if (absentCountRef.current >= CONSECUTIVE_ABSENCE_THRESHOLD) {
          const fallbackProject = pickFallbackProject(availableProjects);
          setListDrivenSelection(fallbackProject);
          if (!fallbackProject) {
            persistCurrentProjectId(null);
          }
        }
        return;
      }

      const newCache = { ...settingsCacheRef.current, [nodeKey]: currentProject.id };
      settingsCacheRef.current = newCache;
      updateGlobalSettings({ dashboardCurrentProjectIdByNode: newCache }).catch(() => {
        // Non-critical - persistence failed.
      });
      persistCurrentProjectId(currentProject.id);
    } else {
      absentCountRef.current = 0;
      if (availableProjects.length === 0) {
        autoDefaultCountRef.current = 0;
        return;
      }
      if (!explicitlyClearedRef.current) {
        const savedProjectId = settingsCacheRef.current?.[nodeKey];
        if (savedProjectId) {
          const savedProject = availableProjects.find((p) => p.id === savedProjectId) ?? null;
          if (savedProject) {
            autoDefaultCountRef.current = 0;
            setListDrivenSelection(savedProject);
            return;
          }
        }

        autoDefaultCountRef.current += 1;
        if (autoDefaultCountRef.current >= CONSECUTIVE_ABSENCE_THRESHOLD) {
          autoDefaultCountRef.current = 0;
          setListDrivenSelection(pickFallbackProject(availableProjects));
        }
      }
    }
  }, [
    availableProjects,
    currentProject,
    loading,
    nodeKey,
    urlProjectId,
    persistCurrentProjectId,
    pickFallbackProject,
    setListDrivenSelection,
  ]);

  const setCurrentProject = useCallback(
    (project: ProjectInfo | null) => {
      explicitlyClearedRef.current = false;
      absentCountRef.current = 0;
      autoDefaultCountRef.current = 0;
      setCurrentProjectState(project);
      persistCurrentProjectId(project?.id ?? null);

      if (project) {
        const newCache = { ...settingsCacheRef.current, [nodeKey]: project.id };
        settingsCacheRef.current = newCache;
        updateGlobalSettings({ dashboardCurrentProjectIdByNode: newCache }).catch(() => {
          // Non-critical - persistence failed.
        });
      }
    },
    [nodeKey, persistCurrentProjectId],
  );

  const clearCurrentProject = useCallback(() => {
    explicitlyClearedRef.current = true;
    absentCountRef.current = 0;
    autoDefaultCountRef.current = 0;
    setCurrentProjectState(null);
    persistCurrentProjectId(null);

    const newCache = { ...settingsCacheRef.current };
    delete newCache[nodeKey];
    settingsCacheRef.current = newCache;
    updateGlobalSettings({ dashboardCurrentProjectIdByNode: newCache }).catch(() => {
      // Non-critical - persistence failed.
    });
  }, [nodeKey, persistCurrentProjectId]);

  return {
    currentProject,
    setCurrentProject,
    clearCurrentProject,
    loading,
  };
}
