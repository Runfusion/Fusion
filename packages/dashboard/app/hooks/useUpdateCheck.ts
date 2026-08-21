import { useCallback, useEffect, useState } from "react";
import { checkForUpdate } from "../api";
import type { UpdateInstallResponse } from "../api";
import { pendingUpdateInstallState, usePendingUpdateInstall } from "./usePendingUpdateInstall";

const UPDATE_BANNER_DISMISSED_KEY = "kb-update-banner-dismissed";

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
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const isDismissed = sessionStorage.getItem(UPDATE_BANNER_DISMISSED_KEY) === "true";
    setDismissed(isDismissed);

    let cancelled = false;

    void checkForUpdate()
      .then((result) => {
        // Record before ordinary update state so a hydrated pending restart never
        // flashes a second Update now action through a competing stale response.
        pendingUpdateInstallState.record(result.pendingInstall);
        if (cancelled || result.disabled) return;

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
    setDismissed(true);
    sessionStorage.setItem(UPDATE_BANNER_DISMISSED_KEY, "true");
  }, []);

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
