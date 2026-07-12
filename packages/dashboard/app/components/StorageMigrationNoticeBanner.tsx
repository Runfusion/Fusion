import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import "./StorageMigrationNoticeBanner.css";

export const STORAGE_MIGRATION_NOTICE_DISMISS_KEY = "fusion:storage-migration-notice-dismissed";

/*
FNXC:StorageMigrationNotice 2026-07-12-00:00:
The dashboard must announce the next-version SQLite → embedded Postgres storage change before operators upgrade. Dismissal is global rather than project-scoped because the notice describes an app-wide on-disk storage engine change, not a per-project condition; localStorage persistence makes the one-time acknowledgement permanent on this browser profile.
*/
function isDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_MIGRATION_NOTICE_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function persistDismissal(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_MIGRATION_NOTICE_DISMISS_KEY, "1");
  } catch {
    // Ignore quota / private-mode errors — the click still hides this in-memory render.
  }
}

/** One-time informational banner for the upcoming dashboard storage backend change. */
export function StorageMigrationNoticeBanner() {
  const { t } = useTranslation("app");
  const [dismissed, setDismissed] = useState<boolean>(() => isDismissed());

  const handleDismiss = useCallback(() => {
    persistDismissal();
    setDismissed(true);
  }, []);

  if (dismissed) return null;

  return (
    <div className="storage-migration-notice-banner" role="status" aria-live="polite">
      <div className="storage-migration-notice-banner__body">
        <div className="storage-migration-notice-banner__title">
          {t("storageMigrationNotice.title", "Storage update coming in the next Fusion version")}
        </div>
        <p className="storage-migration-notice-banner__text">
          {t(
            "storageMigrationNotice.body",
            "The next Fusion version will replace the current SQLite data store with an embedded Postgres backend for data storage. No migration runs from this notice; it is an advance heads-up for operators who rely on the current .fusion/fusion.db SQLite file.",
          )}
        </p>
      </div>
      <button
        type="button"
        className="storage-migration-notice-banner__dismiss touch-target"
        aria-label={t("storageMigrationNotice.dismissLabel", "Dismiss storage update notice")}
        onClick={handleDismiss}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
