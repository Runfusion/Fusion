import { useEffect, useState } from "react";
import { getScopedItem, removeScopedItem, setScopedItem } from "../utils/projectStorage";

export const GITHUB_SETUP_WARNING_DELAY_MS = 86_400_000;
export const GITHUB_SETUP_WARNING_MISSING_SINCE_KEY = "kb-github-setup-warning-missing-since";

export interface UseGithubSetupWarningDelayOptions {
  projectId?: string;
  hasGithub: boolean;
  loading: boolean;
  now?: () => number;
}

function readMissingSince(projectId: string): number | null {
  try {
    const stored = getScopedItem(GITHUB_SETUP_WARNING_MISSING_SINCE_KEY, projectId);
    if (!stored) {
      return null;
    }

    const parsed = Number(stored);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function writeMissingSince(projectId: string, missingSince: number): void {
  try {
    setScopedItem(GITHUB_SETUP_WARNING_MISSING_SINCE_KEY, String(missingSince), projectId);
  } catch {
    // Best effort only: storage failures must not break dashboard rendering.
  }
}

function clearMissingSince(projectId: string): void {
  try {
    removeScopedItem(GITHUB_SETUP_WARNING_MISSING_SINCE_KEY, projectId);
  } catch {
    // Best effort only: storage failures must not break dashboard rendering.
  }
}

export function useGithubSetupWarningDelay({
  projectId,
  hasGithub,
  loading,
  now = Date.now,
}: UseGithubSetupWarningDelayOptions): boolean {
  const [showWarning, setShowWarning] = useState(false);

  useEffect(() => {
    if (!projectId) {
      setShowWarning(false);
      return undefined;
    }

    if (loading) {
      setShowWarning(false);
      return undefined;
    }

    if (hasGithub) {
      clearMissingSince(projectId);
      setShowWarning(false);
      return undefined;
    }

    /*
    FNXC:SetupWarning 2026-07-03-00:00:
    GitHub setup prompts are intentionally delayed for one day after a project first observes GitHub missing. AI-provider warnings remain immediate, but GitHub import/auth nudges should not interrupt new projects during their first 24 hours.
    */
    const observedAt = now();
    const existingMissingSince = readMissingSince(projectId);
    const missingSince = existingMissingSince ?? observedAt;
    if (existingMissingSince == null) {
      writeMissingSince(projectId, missingSince);
    }

    const elapsedMs = observedAt - missingSince;
    if (elapsedMs >= GITHUB_SETUP_WARNING_DELAY_MS) {
      setShowWarning(true);
      return undefined;
    }

    setShowWarning(false);
    const timeoutMs = GITHUB_SETUP_WARNING_DELAY_MS - elapsedMs;
    const timer = window.setTimeout(() => {
      setShowWarning(true);
    }, timeoutMs);

    return () => window.clearTimeout(timer);
  }, [hasGithub, loading, now, projectId]);

  return showWarning;
}
