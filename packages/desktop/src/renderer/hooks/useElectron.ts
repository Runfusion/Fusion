import { useMemo } from "react";
import type { ElectronAPI } from "../types";

export interface UseElectronResult {
  isElectron: boolean;
  electronAPI: ElectronAPI | null;
}

export function useElectron(): UseElectronResult {
  return useMemo(() => {
    if (typeof window === "undefined") {
      return { isElectron: false, electronAPI: null };
    }

    const electronAPI = window.electronAPI ?? null;
    return {
      isElectron: Boolean(electronAPI),
      electronAPI,
    };
  }, []);
}
