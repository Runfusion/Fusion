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
  adoptDismissalLocally();
  void updateGlobalSettings({ githubStarPromptDismissedAt: new Date().toISOString() }).catch(() => {
    // Best-effort: the local record above already suppresses the prompt on this machine.
  });
}

/*
FNXC:GithubStarAsk 2026-08-23-23:35:
Two different facts, deliberately kept apart. `dismissed` is the durable answer — this operator already
answered, on some surface. `resolved` says only whether the durable lookup has finished, so callers can
tell "not asked yet" from "we have not looked yet".

Collapsing them into one boolean breaks one caller or the other. Reporting "shown" while unresolved is
right for the DISPLAY gate (an unknown must never render a duplicate ask) but wrong for the TRIGGER
that records a completed task: that transition is one-shot, so a trigger suppressed during the lookup
window is dropped for good and the prompt never appears even when nobody had dismissed it. So the
display gate consumes `dismissed || !resolved`, while the trigger consumes `dismissed` alone.
*/
export interface GitHubStarPromptState {
  /** The durable answer: this operator already answered on some surface. */
  dismissed: boolean;
  /** False only while the durable lookup is still in flight; a FAILED lookup resolves too. */
  resolved: boolean;
}

/** Records the durable answer in this profile so the store and every mounted hook see it at once. */
function adoptDismissalLocally(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
    window.dispatchEvent(new Event(EVENT_NAME));
  } catch {
    // ignore
  }
}

/*
FNXC:GithubStarAsk 2026-08-23-23:47:
Re-reads the durable answer at the moment a trigger wants to SHOW the ask, and returns whether it is
already answered. The mount-time lookup alone is not enough: first-run setup routinely has a dashboard
tab already open while the operator answers `fn onboard` in a terminal, so a stamp can land after that
lookup and this tab would otherwise ask a second time — exactly the duplicate the shared record exists
to prevent. A stamp found here is adopted locally, so the banner gate closes even if a trigger races it.
An unreachable server falls back to the local record and asks, rather than suppressing the ask forever.
*/
export async function refreshGitHubStarPromptDismissal(): Promise<boolean> {
  if (read()) return true;
  try {
    const settings = await fetchGlobalSettings();
    const dismissedAt = settings.githubStarPromptDismissedAt;
    if (typeof dismissedAt === "string" && dismissedAt.trim().length > 0) {
      adoptDismissalLocally();
      return true;
    }
  } catch {
    // Unreachable settings mean the local record stays the answer.
  }
  return false;
}

export function useGitHubStarPromptState(): GitHubStarPromptState {
  const dismissed = useSyncExternalStore(subscribe, read, () => false);
  const [resolved, setResolved] = useState(false);

  /*
  FNXC:GithubStarAsk 2026-08-19-03:59:
  Adopt a dismissal recorded elsewhere (the `fn onboard` ask, or another browser) into this profile's
  local record, so a fresh dashboard on an already-answered install never re-asks. Runs only while the
  local record is unset, so it is a single request on the machines that still might ask.
  */
  useEffect(() => {
    if (dismissed || typeof window === "undefined") return;
    let cancelled = false;
    void fetchGlobalSettings()
      .then((settings) => {
        if (cancelled) return;
        const dismissedAt = settings.githubStarPromptDismissedAt;
        if (typeof dismissedAt === "string" && dismissedAt.trim().length > 0) {
          adoptDismissalLocally();
        }
      })
      .catch(() => {
        // Unreachable settings mean we simply keep the local record as-is.
      })
      .finally(() => {
        /*
        FNXC:GithubStarAsk 2026-08-23-23:20:
        A failed lookup resolves as well: an unreachable server must leave the local record as the
        answer rather than suppressing the ask forever.
        */
        if (!cancelled) setResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [dismissed]);

  return { dismissed, resolved };
}

/**
 * FNXC:GithubStarAsk 2026-08-23-23:35:
 * The DISPLAY gate: true when the ask must stay hidden — either it was already answered, or we do not
 * yet know. Trigger sites must use `useGitHubStarPromptState().dismissed` instead, or they will drop a
 * one-shot trigger that arrives during the lookup window.
 */
export function useGitHubStarPromptShown(): boolean {
  const { dismissed, resolved } = useGitHubStarPromptState();
  return dismissed || !resolved;
}
