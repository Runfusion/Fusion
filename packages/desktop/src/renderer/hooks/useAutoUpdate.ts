import { useCallback, useEffect, useState } from "react";
import { useElectron } from "./useElectron";

export interface UseAutoUpdateResult {
  updateAvailable: boolean;
  updateInfo: Record<string, unknown> | null;
  downloadAndInstall: () => Promise<void>;
}

export function useAutoUpdate(): UseAutoUpdateResult {
  const { isElectron, electronAPI } = useElectron();
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!isElectron || !electronAPI?.onUpdateAvailable) {
      return;
    }

    const unsubscribe = electronAPI.onUpdateAvailable((info: Record<string, unknown>) => {
      setUpdateAvailable(true);
      setUpdateInfo(info);
    });

    return () => {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    };
  }, [isElectron, electronAPI]);

  const downloadAndInstall = useCallback(async () => {
    if (!isElectron || !electronAPI?.installUpdate) {
      return;
    }

    await electronAPI.installUpdate();
  }, [isElectron, electronAPI]);

  return {
    updateAvailable,
    updateInfo,
    downloadAndInstall,
  };
}
