import { useSyncExternalStore } from "react";

const STORAGE_KEY = "fusion:hide-session-banners";
const EVENT_NAME = "fusion:session-banner-pref-changed";

function read(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handleStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) onChange();
  };
  const handleCustom = () => onChange();
  window.addEventListener("storage", handleStorage);
  window.addEventListener(EVENT_NAME, handleCustom);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(EVENT_NAME, handleCustom);
  };
}

export function setSessionBannersHidden(hidden: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (hidden) {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    window.dispatchEvent(new Event(EVENT_NAME));
  } catch {
    // ignore
  }
}

export function useSessionBannersHidden(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
