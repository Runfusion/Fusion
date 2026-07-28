import "./UpdateAvailableBanner.css";
import { useEffect, useState } from "react";
import { Power, RefreshCw, X } from "lucide-react";
import { useTranslation, Trans } from "react-i18next";
import { getErrorMessage } from "@fusion/core";
import { fetchSystemInfo, installUpdate, requestSystemRestart } from "../api";
import type { UpdateInstallResponse } from "../api";

interface UpdateAvailableBannerProps {
  latestVersion: string;
  currentVersion: string;
  onDismiss: () => void;
}

export function UpdateAvailableBanner({ latestVersion, currentVersion, onDismiss }: UpdateAvailableBannerProps) {
  const { t } = useTranslation("app");
  const [installLoading, setInstallLoading] = useState(false);
  const [installResult, setInstallResult] = useState<UpdateInstallResponse | null>(null);
  const [restartSupported, setRestartSupported] = useState<boolean | undefined>();
  const [restartLoading, setRestartLoading] = useState(false);
  const [restartScheduled, setRestartScheduled] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    void fetchSystemInfo()
      .then((info) => {
        if (active) setRestartSupported(info.restartSupported);
      })
      .catch(() => {
        // Fail closed: an unavailable capability response must not offer a restart that cannot run.
        if (active) setRestartSupported(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const handleInstallUpdate = async () => {
    setInstallLoading(true);
    setInstallResult(null);

    try {
      setInstallResult(await installUpdate());
    } catch (error) {
      setInstallResult({
        currentVersion,
        latestVersion,
        updated: false,
        error: getErrorMessage(error) || t("updateBanner.updateFailed", "Update failed"),
      });
    } finally {
      setInstallLoading(false);
    }
  };

  /*
  FNXC:UpdateBanner 2026-07-16-00:00:
  Issue #1799 requires a successful in-app update to offer the supervised restart hook in-place.

  FNXC:UpdateBanner 2026-07-25-10:05:
  Capability is advisory, never a hard block — same contract as the Settings footer.
  A failed or stale /system/info probe must not turn this into a button that silently
  does nothing; let the request reach the server and show its refusal reason instead.
  */
  const handleRestart = async () => {
    if (restartLoading) return;

    setRestartLoading(true);
    setRestartError(null);
    try {
      const result = await requestSystemRestart("update-banner");
      if (result.scheduled) {
        setRestartScheduled(true);
      } else {
        setRestartError(t("updateBanner.restartFailed", "Restart could not be scheduled. Try restarting Fusion manually."));
      }
    } catch (error) {
      setRestartError(getErrorMessage(error) || t("updateBanner.restartFailed", "Restart could not be scheduled. Try restarting Fusion manually."));
    } finally {
      setRestartLoading(false);
    }
  };

  const installSucceeded = installResult?.updated === true;
  const installError = installResult?.error;
  // Advisory guidance only — shown when the host explicitly reported no supervising parent.
  const restartUnavailable = restartSupported === false;

  return (
    <div className="update-available-banner" role="status" aria-live="polite">
      <div className="update-available-banner__content">
        <p className="update-available-banner__text">
          <Trans
            i18nKey="app:updateBanner.message"
            defaults="Update available: v{{latestVersion}} (current: v{{currentVersion}}). Run <code>fn update</code> for an installed CLI, or pull this source checkout."
            values={{ latestVersion, currentVersion }}
            components={{ code: <code /> }}
          />{" "}
          <a
            className="update-available-banner__link"
            href="https://github.com/Runfusion/Fusion/blob/main/CHANGELOG.md"
            target="_blank"
            rel="noreferrer"
          >
            {t("updateBanner.releaseNotes", "Release notes")}
          </a>{" "}
          ·{" "}
          <a className="update-available-banner__link" href="https://runfusion.ai" target="_blank" rel="noreferrer">
            {t("updateBanner.learnMore", "Learn more")}
          </a>
        </p>
        <div className="update-available-banner__actions">
          {installSucceeded ? (
            <>
              <span className="update-available-banner__install-status update-available-banner__install-status--success" aria-live="polite">
                {t("updateBanner.updateSuccess", "Updated to v{{version}} — restart Fusion to apply", {
                  version: installResult.latestVersion ?? latestVersion,
                })}
              </span>
              {restartScheduled ? (
                <span className="update-available-banner__install-status" aria-live="polite">
                  {t("updateBanner.restarting", "Restarting… Your connection will close shortly.")}
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm update-available-banner__restart-btn"
                  onClick={() => {
                    void handleRestart();
                  }}
                  disabled={restartLoading}
                >
                  {restartLoading ? (
                    <>
                      <RefreshCw size={12} className="spinning" aria-hidden="true" />
                      {t("updateBanner.restarting", "Restarting…")}
                    </>
                  ) : (
                    <>
                      <Power size={12} aria-hidden="true" />
                      {t("updateBanner.restartNow", "Restart Fusion")}
                    </>
                  )}
                </button>
              )}
              {restartUnavailable && (
                <span className="update-available-banner__install-status" aria-live="polite">
                  {t("updateBanner.restartUnavailable", "Needs a supervising parent — restart Fusion manually without --no-supervise.")}
                </span>
              )}
              {restartError && (
                <span className="update-available-banner__install-status update-available-banner__install-status--error" aria-live="polite">
                  {restartError}
                </span>
              )}
            </>
          ) : (
            <button
              type="button"
              className="btn btn-sm update-available-banner__update-btn"
              onClick={() => {
                void handleInstallUpdate();
              }}
              disabled={installLoading}
            >
              {installLoading ? (
                <>
                  <RefreshCw size={12} className="spinning" aria-hidden="true" />
                  {t("updateBanner.updating", "Updating…")}
                </>
              ) : (
                t("updateBanner.updateNow", "Update now")
              )}
            </button>
          )}
          {installError && (
            <span className="update-available-banner__install-status update-available-banner__install-status--error" aria-live="polite">
              {t("updateBanner.updateFailedWithMessage", "Update failed: {{message}}", { message: installError })}
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        className="update-available-banner__dismiss touch-target"
        aria-label={t("updateBanner.dismissLabel", "Dismiss update notice")}
        onClick={onDismiss}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
