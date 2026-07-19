/*
FNXC:MigrationHoldingPage 2026-07-17-12:40:
When the Fusion server restarts and performs the one-time SQLite→PostgreSQL
migration, an already-open dashboard tab keeps polling /api/health (every 15s
via useDashboardHealth) and reaches the CLI's boot-window holding server, which
answers with status "migrating" plus a progress label. This banner surfaces
that state so the open tab explains the outage instead of failing silently.
It renders from health status alone (no project gate — during the boot window
no project data is fetchable) and disappears on the next poll of the real
server. Fresh navigations during migration get the holding page instead.
*/
import { useTranslation } from "react-i18next";
import { DatabaseZap } from "lucide-react";
import "./MigrationInProgressBanner.css";

interface MigrationInProgressBannerProps {
  isActive: boolean;
  progressLabel?: string;
}

export function MigrationInProgressBanner({ isActive, progressLabel }: MigrationInProgressBannerProps) {
  const { t } = useTranslation("app");
  if (!isActive) {
    return null;
  }

  return (
    <div className="migration-in-progress-banner" role="status" aria-live="polite">
      <DatabaseZap aria-hidden="true" />
      <span>
        {t("app.migrationInProgress", "Database migration in progress — the dashboard will reconnect when it completes.")}
        {progressLabel ? (
          <span className="migration-in-progress-banner-progress">{progressLabel}</span>
        ) : null}
      </span>
    </div>
  );
}
