import { useCallback, useEffect, useState } from "react";

export const FILE_EDITOR_AUTO_SAVE_STORAGE_KEY = "fn-file-editor-auto-save";
const FILE_EDITOR_AUTO_SAVE_CHANGED_EVENT = "fn:file-editor-auto-save-changed";

function readBooleanPref(key: string, defaultValue: boolean): boolean {
  if (typeof window === "undefined") return defaultValue;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return raw === "true";
  } catch {
    return defaultValue;
  }
}

function writeBooleanPref(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "true" : "false");
  } catch {
    // Ignore storage failures (quota, private mode, etc.).
  }
}

export interface UseAutoSavePreferenceReturn {
  autoSaveEnabled: boolean;
  toggleAutoSave: () => void;
  setAutoSaveEnabled: (value: boolean) => void;
}

/*
FNXC:FileEditor 2026-07-12-00:00:
Workspace file-editor auto-save defaults ON and is toggled from the shared toolbar. Persist one preference key for every workspace editor surface, and broadcast same-window changes because the native storage event only reaches other documents.
*/
export function useAutoSavePreference(): UseAutoSavePreferenceReturn {
  const [autoSaveEnabled, setAutoSaveEnabledState] = useState(() => readBooleanPref(FILE_EDITOR_AUTO_SAVE_STORAGE_KEY, true));

  const setAutoSaveEnabled = useCallback((value: boolean) => {
    setAutoSaveEnabledState(value);
    writeBooleanPref(FILE_EDITOR_AUTO_SAVE_STORAGE_KEY, value);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(FILE_EDITOR_AUTO_SAVE_CHANGED_EVENT, { detail: value }));
    }
  }, []);

  const toggleAutoSave = useCallback(() => {
    setAutoSaveEnabledState((current) => {
      const next = !current;
      writeBooleanPref(FILE_EDITOR_AUTO_SAVE_STORAGE_KEY, next);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(FILE_EDITOR_AUTO_SAVE_CHANGED_EVENT, { detail: next }));
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const syncFromStorage = (event: StorageEvent) => {
      if (event.key !== FILE_EDITOR_AUTO_SAVE_STORAGE_KEY) return;
      setAutoSaveEnabledState(readBooleanPref(FILE_EDITOR_AUTO_SAVE_STORAGE_KEY, true));
    };
    const syncFromLocalEvent = (event: Event) => {
      const nextValue = (event as CustomEvent<boolean>).detail;
      setAutoSaveEnabledState(typeof nextValue === "boolean" ? nextValue : readBooleanPref(FILE_EDITOR_AUTO_SAVE_STORAGE_KEY, true));
    };

    window.addEventListener("storage", syncFromStorage);
    window.addEventListener(FILE_EDITOR_AUTO_SAVE_CHANGED_EVENT, syncFromLocalEvent);
    return () => {
      window.removeEventListener("storage", syncFromStorage);
      window.removeEventListener(FILE_EDITOR_AUTO_SAVE_CHANGED_EVENT, syncFromLocalEvent);
    };
  }, []);

  return { autoSaveEnabled, toggleAutoSave, setAutoSaveEnabled };
}
