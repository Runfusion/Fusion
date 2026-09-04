import { useCallback, useEffect, useState } from "react";
import { checkForUpdate } from "../api";
import type { UpdateInstallResponse } from "../api";
import { pendingUpdateInstallState, usePendingUpdateInstall } from "./usePendingUpdateInstall";

/*
 * FNXC:UpdateBanner 2026-09-03-06:18:
 * Update-banner dismissal must survive page sessions but apply only to the reported latestVersion.
 * Persisting the dismissed version lets a genuinely newer release re-surface the notice automatically.
 */
const UPDATE_BANNER_DISMISSED_VERSION_KEY = "kb-update-banner-dismissed-version";
const LEGACY_UPDATE_BANNER_DISMISSED_KEY = "kb-update-banner-dismissed";

function readDismissedUpdateVersion(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const version = window.localStorage.getItem(UPDATE_BANNER_DISMISSED_VERSION_KEY);
    return version?.trim() ? version : null;
  } catch {
    return null;
  }
}

function persistDismissedUpdateVersion(version: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UPDATE_BANNER_DISMISSED_VERSION_KEY, version);
  } catch {
    // Ignore quota / private-mode errors — dismissal remains visible only in memory.
  }
}

export interface UseUpdateCheckResult {
  updateAvailable: boolean;
  latestVersion: string | null;
  currentVersion: string | null;
  loading: boolean;
  dismissed: boolean;
  pendingInstall?: UpdateInstallResponse;
  dismiss: () => void;
}

export function useUpdateCheck(): UseUpdateCheckResult {
  const pendingInstall = usePendingUpdateInstall({ hydrate: false });
  const [loading, setLoading] = useState(true);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState(readDismissedUpdateVersion);

  useEffect(() => {
    try {
      window.sessionStorage.removeItem(LEGACY_UPDATE_BANNER_DISMISSED_KEY);
    } catch {
      // Ignore unavailable session storage; the version-aware local record is authoritative.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void checkForUpdate()
      .then((result) => {
        // Record before ordinary update state so a hydrated pending restart never
        // flashes a second Update now action through a competing stale response.
        pendingUpdateInstallState.record(result.pendingInstall);
        // Externally managed deployments are disabled by the server and must never mount an update offer.
        if (cancelled || result.disabled || result.externallyManaged) return;

        setUpdateAvailable(result.updateAvailable === true);
        setLatestVersion(typeof result.latestVersion === "string" ? result.latestVersion : null);
        setCurrentVersion(typeof result.currentVersion === "string" ? result.currentVersion : null);
      })
      .catch(() => {
        // Fail silently. Update checks are best-effort.
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = useCallback(() => {
    if (latestVersion === null) return;
    setDismissedVersion(latestVersion);
    persistDismissedUpdateVersion(latestVersion);
  }, [latestVersion]);

  const dismissed = latestVersion !== null && dismissedVersion === latestVersion;

  return {
    updateAvailable,
    latestVersion,
    currentVersion,
    loading,
    dismissed,
    pendingInstall,
    dismiss,
  };
}
