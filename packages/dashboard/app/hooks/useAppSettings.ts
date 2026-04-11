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
  toggleAutoMerge: () => Promise<void>;
  toggleGlobalPause: () => Promise<void>;
  toggleEnginePause: () => Promise<void>;
  toggleShowQuickChatFAB: () => Promise<void>;
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
  const [showQuickChatFAB, setShowQuickChatFAB] = useState(true);
  const [githubTokenConfigured, setGithubTokenConfigured] = useState(false);

  useEffect(() => {
    fetchConfig(projectId)
      .then((cfg) => {
        setMaxConcurrent(cfg.maxConcurrent);
        setRootDir(cfg.rootDir);
      })
      .catch(() => {
        // Keep defaults on fetch failure.
      });

    fetchSettings(projectId)
      .then((settings) => {
        setAutoMerge(Boolean(settings.autoMerge));
        setGlobalPaused(Boolean(settings.globalPause));
        setEnginePaused(Boolean(settings.enginePaused));
        setGithubTokenConfigured(Boolean(settings.githubTokenConfigured));
        setTaskStuckTimeoutMs(settings.taskStuckTimeoutMs);
        setShowQuickChatFAB(settings.showQuickChatFAB !== false);
      })
      .catch(() => {
        // Keep defaults on fetch failure.
      });
  }, [projectId]);

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
      await updateSettings({ globalPause: next }, projectId);
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
    toggleAutoMerge,
    toggleGlobalPause,
    toggleEnginePause,
    toggleShowQuickChatFAB,
  };
}
