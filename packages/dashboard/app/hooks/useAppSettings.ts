import { useCallback, useEffect, useState } from "react";
import { fetchConfig, fetchSettings, updateSettings, updateGlobalSettings } from "../api";
import { setAutoReloadEnabled } from "../versionCheck";

/**
 * Settings state and actions consumed by the dashboard App shell.
 */
export interface UseAppSettingsResult {
  maxConcurrent: number;
  rootDir: string;
  autoMerge: boolean;
  testMode: boolean;
  isTestMode: boolean;
  globalPaused: boolean;
  enginePaused: boolean;
  taskStuckTimeoutMs: number | undefined;
  staleHighFanoutBlockerAgeThresholdMs: number;
  capacityRiskBannerEnabled: boolean;
  capacityRiskTodoThreshold: number;
  showQuickChatFAB: boolean;
  maxTotalRetriesBeforeFail: number;
  prAuthAvailable: boolean;
  settingsLoaded: boolean;
  experimentalFeatures: Record<string, boolean>;
  insightsEnabled: boolean;
  memoryEnabled: boolean;
  devServerEnabled: boolean;
  todosEnabled: boolean;
  goalsEnabled: boolean;
  autoReloadOnVersionChange: boolean;
  toggleAutoMerge: () => Promise<void>;
  toggleGlobalPause: () => Promise<void>;
  toggleEnginePause: () => Promise<void>;
  toggleShowQuickChatFAB: () => Promise<void>;
  toggleAutoReloadOnVersionChange: () => Promise<void>;
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
  const [testMode, setTestMode] = useState(false);
  const [isTestMode, setIsTestMode] = useState(false);
  const [globalPaused, setGlobalPaused] = useState(false);
  const [enginePaused, setEnginePaused] = useState(false);
  const [taskStuckTimeoutMs, setTaskStuckTimeoutMs] = useState<number | undefined>(undefined);
  const [staleHighFanoutBlockerAgeThresholdMs, setStaleHighFanoutBlockerAgeThresholdMs] = useState(2 * 60 * 60 * 1000);
  const [capacityRiskBannerEnabled, setCapacityRiskBannerEnabled] = useState(false);
  const [capacityRiskTodoThreshold, setCapacityRiskTodoThreshold] = useState(20);
  const [showQuickChatFAB, setShowQuickChatFAB] = useState(false);
  const [maxTotalRetriesBeforeFail, setMaxTotalRetriesBeforeFail] = useState(25);
  const [prAuthAvailable, setPrAuthAvailable] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [experimentalFeatures, setExperimentalFeatures] = useState<Record<string, boolean>>({});
  const [insightsEnabled, setInsightsEnabled] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState(false);
  const [devServerEnabled, setDevServerEnabled] = useState(false);
  const [todosEnabled, setTodosEnabled] = useState(false);
  const [goalsEnabled, setGoalsEnabled] = useState(false);
  const [autoReloadOnVersionChange, setAutoReloadOnVersionChangeState] = useState(true);

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
      const nextTestMode = settings.testMode === true;
      const nextIsTestMode = nextTestMode || settings.defaultProvider?.trim().toLowerCase() === "mock";
      setTestMode(nextTestMode);
      setIsTestMode(nextIsTestMode);
      setGlobalPaused(Boolean(settings.globalPause));
      setEnginePaused(Boolean(settings.enginePaused));
      setPrAuthAvailable(Boolean(settings.prAuthAvailable));
      setTaskStuckTimeoutMs(settings.taskStuckTimeoutMs);
      setStaleHighFanoutBlockerAgeThresholdMs(
        settings.staleHighFanoutBlockerAgeThresholdMs ?? 2 * 60 * 60 * 1000,
      );
      setShowQuickChatFAB(settings.showQuickChatFAB === true);
      setMaxTotalRetriesBeforeFail(settings.maxTotalRetriesBeforeFail ?? 25);
      setCapacityRiskBannerEnabled(settings.capacityRiskBannerEnabled === true);
      setCapacityRiskTodoThreshold(settings.capacityRiskTodoThreshold ?? 20);
      setExperimentalFeatures(settings.experimentalFeatures ?? {});
      const features = settings.experimentalFeatures ?? {};
      setInsightsEnabled(features.insights === true);
      setMemoryEnabled(features.memoryView === true);
      setDevServerEnabled(features.devServerView === true || features.devServer === true);
      setTodosEnabled(features.todoView === true);
      setGoalsEnabled(features.goalsView === true);
      // Sync the module-level auto-reload guard with the persisted setting
      const autoReload = settings.autoReloadOnVersionChange !== false;
      setAutoReloadOnVersionChangeState(autoReload);
      setAutoReloadEnabled(autoReload);
    }

    setSettingsLoaded(true);
  }, [projectId]);

  useEffect(() => {
    setSettingsLoaded(false);
    setExperimentalFeatures({});
    setInsightsEnabled(false);
    setMemoryEnabled(false);
    setDevServerEnabled(false);
    setTodosEnabled(false);
    setGoalsEnabled(false);
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

  const toggleAutoReloadOnVersionChange = useCallback(async () => {
    const next = !autoReloadOnVersionChange;
    setAutoReloadOnVersionChangeState(next);
    setAutoReloadEnabled(next);

    try {
      await updateGlobalSettings({ autoReloadOnVersionChange: next });
    } catch {
      setAutoReloadOnVersionChangeState(!next);
      setAutoReloadEnabled(!next);
    }
  }, [autoReloadOnVersionChange]);

  return {
    maxConcurrent,
    rootDir,
    autoMerge,
    testMode,
    isTestMode,
    globalPaused,
    enginePaused,
    taskStuckTimeoutMs,
    staleHighFanoutBlockerAgeThresholdMs,
    capacityRiskBannerEnabled,
    capacityRiskTodoThreshold,
    showQuickChatFAB,
    maxTotalRetriesBeforeFail,
    prAuthAvailable,
    settingsLoaded,
    experimentalFeatures,
    insightsEnabled,
    memoryEnabled,
    devServerEnabled,
    todosEnabled,
    goalsEnabled,
    autoReloadOnVersionChange,
    toggleAutoMerge,
    toggleGlobalPause,
    toggleEnginePause,
    toggleShowQuickChatFAB,
    toggleAutoReloadOnVersionChange,
    refresh,
  };
}
