import { useEffect, useState, useSyncExternalStore } from "react";
import { fetchGlobalSettings, updateGlobalSettings } from "../api";

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

/*
FNXC:GithubStarAsk 2026-08-19-03:59:
The ask is one per operator, not one per browser profile. localStorage stays the fast local record —
it suppresses the prompt on this render without waiting on a request — while `githubStarPromptDismissedAt`
in global settings is the durable, cross-surface one: the CLI's post-onboarding ask reads and writes
the same field, so answering in either place retires the ask in both. The settings write is
best-effort; losing it costs at most one repeat ask on another browser, never a broken dismissal here.
*/
export function markGitHubStarPromptShown(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
    window.dispatchEvent(new Event(EVENT_NAME));
  } catch {
    // ignore
  }
  void updateGlobalSettings({ githubStarPromptDismissedAt: new Date().toISOString() }).catch(() => {
    // Best-effort: the local record above already suppresses the prompt on this machine.
  });
}

export function useGitHubStarPromptShown(): boolean {
  const shown = useSyncExternalStore(subscribe, read, () => false);
  /*
  FNXC:GithubStarAsk 2026-08-23-23:20:
  "Not asked yet" and "we have not looked yet" are different answers, and only the first may show the
  prompt. Until the durable lookup settles, this profile cannot know whether the operator already
  answered in the CLI or another browser, so the hook reports shown=true and the ask stays hidden —
  an unknown must never produce the duplicate ask the whole cross-surface record exists to prevent.
  A FAILED lookup also settles: an unreachable server leaves the local record as the answer rather
  than suppressing the ask forever.
  */
  const [hydrated, setHydrated] = useState(false);

  /*
  FNXC:GithubStarAsk 2026-08-19-03:59:
  Adopt a dismissal recorded elsewhere (the `fn onboard` ask, or another browser) into this profile's
  local record, so a fresh dashboard on an already-answered install never re-asks. Runs only while the
  local record is unset, so it is a single request on the machines that still might ask.
  */
  useEffect(() => {
    if (shown || typeof window === "undefined") return;
    let cancelled = false;
    void fetchGlobalSettings()
      .then((settings) => {
        if (cancelled) return;
        const dismissedAt = settings.githubStarPromptDismissedAt;
        if (typeof dismissedAt === "string" && dismissedAt.trim().length > 0) {
          try {
            window.localStorage.setItem(STORAGE_KEY, "1");
            window.dispatchEvent(new Event(EVENT_NAME));
          } catch {
            // ignore
          }
        }
      })
      .catch(() => {
        // Unreachable settings mean we simply keep the local record as-is.
      })
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [shown]);

  return shown || !hydrated;
}
