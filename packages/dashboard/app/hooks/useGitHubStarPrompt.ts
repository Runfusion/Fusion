import { useSyncExternalStore } from "react";

const STORAGE_KEY = "fusion:github-star-prompt-shown";
const EVENT_NAME = "fusion:github-star-prompt-changed";

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

  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      onChange();
    }
  };
  const handleCustom = () => onChange();

  window.addEventListener("storage", handleStorage);
  window.addEventListener(EVENT_NAME, handleCustom);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(EVENT_NAME, handleCustom);
  };
}

export function markGitHubStarPromptShown(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
    window.dispatchEvent(new Event(EVENT_NAME));
  } catch {
    // ignore
  }
}

export function useGitHubStarPromptShown(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
