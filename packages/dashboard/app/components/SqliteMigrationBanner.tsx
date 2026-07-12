/*
FNXC:PostgresMigrationBanner 2026-07-12:
One-time notice shown after the startup factory auto-migrated a legacy SQLite
database into PostgreSQL (settings.sqliteMigrationNotice, written in
startup-factory Step 7.5). Requirements:
- tell the operator their data was migrated and the original SQLite files were
  kept as backups (paths listed on demand),
- a "Need help?" button that opens the Fusion Discord,
- dismissible; dismissal persists (PUT /api/settings with dismissed: true) so
  the banner never reappears, while the notice itself is retained for audit.
Self-contained like EngineStatusBanner: fetches its own settings snapshot on
mount so DashboardBanners needs no new prop plumbing.
*/
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DatabaseZap } from "lucide-react";
import { fetchSettings, updateSettings } from "../api";
import "./SqliteMigrationBanner.css";

export const FUSION_DISCORD_URL = "https://discord.gg/ksrfuy7WYR";

interface SqliteMigrationNotice {
  migratedAt: string;
  migratedRows: number;
  tables: number;
  sqliteBackups: string[];
  dismissed?: boolean;
}

export function SqliteMigrationBanner({ projectId }: { projectId: string }) {
  const { t } = useTranslation("app");
  const [notice, setNotice] = useState<SqliteMigrationNotice | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const settings = await fetchSettings(projectId);
        const migrationNotice = (settings as { sqliteMigrationNotice?: SqliteMigrationNotice | null }).sqliteMigrationNotice;
        if (!cancelled && migrationNotice && !migrationNotice.dismissed) {
          setNotice(migrationNotice);
        }
      } catch {
        // Banner is best-effort; a failed settings read just hides it.
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-check when the user switches projects (settings are project-scoped).
  }, [projectId]);

  if (!notice) {
    return null;
  }

  const dismiss = async () => {
    setNotice(null);
    try {
      await updateSettings({ sqliteMigrationNotice: { ...notice, dismissed: true } }, projectId);
    } catch {
      // Best-effort persistence; the banner is already hidden locally.
    }
  };

  return (
    <div className="sqlite-migration-banner" role="status" aria-live="polite">
      <DatabaseZap aria-hidden="true" />
      <div className="sqlite-migration-banner-body">
        <strong>
          {t("app.sqliteMigration.title", "Your data was migrated to PostgreSQL")}
        </strong>
        <span>
          {t(
            "app.sqliteMigration.detail",
            "{{rows}} row(s) across {{tables}} table(s) were imported from your previous SQLite database. Your original database files were kept as backups:",
            { rows: notice.migratedRows, tables: notice.tables },
          )}{" "}
          <code>{notice.sqliteBackups.join(", ")}</code>
        </span>
      </div>
      <div className="sqlite-migration-banner-actions">
        <a
          className="btn btn-sm"
          href={FUSION_DISCORD_URL}
          target="_blank"
          rel="noreferrer"
        >
          {t("app.sqliteMigration.needHelp", "Need help?")}
        </a>
        <button type="button" className="btn btn-sm btn-ghost" onClick={dismiss}>
          {t("app.sqliteMigration.dismiss", "Dismiss")}
        </button>
      </div>
    </div>
  );
}
