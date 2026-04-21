import { useCallback, useEffect, useState } from "react";
import { fetchConfig, fetchSettings, updateSettings } from "../api";

/**
 * Settings state and actions consumed by the dashboard App shell.
 */
export interface UseAppSettingsResult {
  maxConcurrent: number;
  rootDir: string;
  autoMerge: boolean;
  globalPaused: boolean;
  enginePaused: boolean;
  taskStuckTimeoutMs: number | undefined;
  showQuickChatFAB: boolean;
  githubTokenConfigured: boolean;
  experimentalFeatures: Record<string, boolean>;
  insightsEnabled: boolean;
  roadmapEnabled: boolean;
  memoryEnabled: boolean;
  devServerEnabled: boolean;
  toggleAutoMerge: () => Promise<void>;
  toggleGlobalPause: () => Promise<void>;
  toggleEnginePause: () => Promise<void>;
  toggleShowQuickChatFAB: () => Promise<void>;
  /** Re-fetches settings from the backend to pick up changes made externally (e.g., by SettingsModal). */
  refresh: () => Promise<void>;
}

/**
 * Loads per-project dashboard settings and exposes optimistic toggle handlers.
 */
export function useAppSettings(projectId?: string): UseAppSettingsResult {
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const [rootDir, setRootDir] = useState<string>(".");
  const [autoMerge, setAutoMerge] = useState(true);
  const [globalPaused, setGlobalPaused] = useState(false);
  const [enginePaused, setEnginePaused] = useState(false);
  const [taskStuckTimeoutMs, setTaskStuckTimeoutMs] = useState<number | undefined>(undefined);
  const [showQuickChatFAB, setShowQuickChatFAB] = useState(false);
  const [githubTokenConfigured, setGithubTokenConfigured] = useState(false);
  const [experimentalFeatures, setExperimentalFeatures] = useState<Record<string, boolean>>({});
  const [insightsEnabled, setInsightsEnabled] = useState(false);
  const [roadmapEnabled, setRoadmapEnabled] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState(false);
  const [devServerEnabled, setDevServerEnabled] = useState(false);

  /**
   * Fetches config and settings from the backend and updates local state.
   * Shared between the mount-time useEffect and the refresh() function.
   */
  const refresh = useCallback(async () => {
    const [configResult, settingsResult] = await Promise.allSettled([
      fetchConfig(projectId),
      fetchSettings(projectId),
    ]);

    if (configResult.status === "fulfilled") {
      setMaxConcurrent(configResult.value.maxConcurrent);
      setRootDir(configResult.value.rootDir);
    }

    if (settingsResult.status === "fulfilled") {
      const settings = settingsResult.value;
      setAutoMerge(Boolean(settings.autoMerge));
      setGlobalPaused(Boolean(settings.globalPause));
      setEnginePaused(Boolean(settings.enginePaused));
      setGithubTokenConfigured(Boolean(settings.githubTokenConfigured));
      setTaskStuckTimeoutMs(settings.taskStuckTimeoutMs);
      setShowQuickChatFAB(settings.showQuickChatFAB === true);
      setExperimentalFeatures(settings.experimentalFeatures ?? {});
      const features = settings.experimentalFeatures ?? {};
      setInsightsEnabled(features.insights === true);
      setRoadmapEnabled(features.roadmap === true);
      setMemoryEnabled(features.memoryView === true);
      setDevServerEnabled(features.devServerView === true);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleAutoMerge = useCallback(async () => {
    const next = !autoMerge;
    setAutoMerge(next);

    try {
      await updateSettings({ autoMerge: next }, projectId);
    } catch {
      setAutoMerge(!next);
    }
  }, [autoMerge, projectId]);

  const toggleGlobalPause = useCallback(async () => {
    const next = !globalPaused;
    setGlobalPaused(next);

    try {
      await updateSettings(
        {
          globalPause: next,
          globalPauseReason: next ? "manual" : undefined,
        },
        projectId,
      );
    } catch {
      setGlobalPaused(!next);
    }
  }, [globalPaused, projectId]);

  const toggleEnginePause = useCallback(async () => {
    const next = !enginePaused;
    setEnginePaused(next);

    try {
      await updateSettings({ enginePaused: next }, projectId);
    } catch {
      setEnginePaused(!next);
    }
  }, [enginePaused, projectId]);

  const toggleShowQuickChatFAB = useCallback(async () => {
    const next = !showQuickChatFAB;
    setShowQuickChatFAB(next);

    try {
      await updateSettings({ showQuickChatFAB: next }, projectId);
    } catch {
      setShowQuickChatFAB(!next);
    }
  }, [showQuickChatFAB, projectId]);

  return {
    maxConcurrent,
    rootDir,
    autoMerge,
    globalPaused,
    enginePaused,
    taskStuckTimeoutMs,
    showQuickChatFAB,
    githubTokenConfigured,
    experimentalFeatures,
    insightsEnabled,
    roadmapEnabled,
    memoryEnabled,
    devServerEnabled,
    toggleAutoMerge,
    toggleGlobalPause,
    toggleEnginePause,
    toggleShowQuickChatFAB,
    refresh,
  };
}
