import "./UpdateAvailableBanner.css";
import { useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { useTranslation, Trans } from "react-i18next";
import { getErrorMessage } from "@fusion/core";
import { installUpdate } from "../api";
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

  const installSucceeded = installResult?.updated === true;
  const installError = installResult?.error;

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
            <span className="update-available-banner__install-status update-available-banner__install-status--success" aria-live="polite">
              {t("updateBanner.updateSuccess", "Updated to v{{version}} — restart Fusion to apply", {
                version: installResult.latestVersion ?? latestVersion,
              })}
            </span>
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
