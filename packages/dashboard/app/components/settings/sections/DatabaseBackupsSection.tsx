import { useTranslation } from "react-i18next";
import type { BackupListResponse } from "../../../api";
import { SettingsToggleRow } from "../SettingsToggleRow";
import { SettingsNumberRow } from "../SettingsNumberRow";
import { SettingsTextRow } from "../SettingsTextRow";
import type { BackupSettingsMigrationCandidate, BackupSettingsMigrationConflict } from "@fusion/core";
import type { SectionBaseProps } from "./context";
import { LoadingSpinner } from "../../LoadingSpinner";
export interface DatabaseBackupsSectionProps extends SectionBaseProps {
  backupInfo: BackupListResponse | null;
  backupLoading: boolean;
  onBackupNow: () => void;
}
/*
FNXC:SettingsBackups 2026-07-16-14:35:
The global PostgreSQL cluster contains every project, so database controls and the one shared backup destination live in this global section. Memory snapshots remain in the project section.
*/
export function DatabaseBackupsSection({ form, setForm, backupInfo, backupLoading, onBackupNow }: DatabaseBackupsSectionProps) {
    const { t } = useTranslation("app");
    const conflicts = form.backupSettingsMigrationConflicts ?? [];
    const chooseCandidate = (conflict: BackupSettingsMigrationConflict, candidate: BackupSettingsMigrationCandidate) => {
      setForm((current) => ({
        ...current,
        [conflict.key]: candidate.value,
        backupSettingsMigrationConflicts: conflicts.filter((entry) => entry.key !== conflict.key),
      }));
    };
    return (<>
      {conflicts.length > 0 && <div className="settings-notice settings-notice-warning" role="status">
        <strong>{t("settings.backups.migrationConflict", "Choose database backup settings")}</strong>
        <p>{t("settings.backups.migrationConflictHelp", "Existing projects used different backup settings. Choose the value to use globally.")}</p>
        {conflicts.map((conflict) => <div key={conflict.key}>
          <span>{conflict.key}</span>
          {conflict.candidates.map((candidate, index) => <button
            type="button"
            className="btn btn-sm"
            key={`${candidate.source}-${candidate.projectId ?? "global"}-${index}`}
            onClick={() => chooseCandidate(conflict, candidate)}
          >
            {candidate.source === "global"
              ? t("settings.backups.existingGlobalValue", "Existing global value")
              : `${t("settings.backups.projectValue", "Project value")}: ${candidate.projectId}`}
          </button>)}
        </div>)}
      </div>}
      <h4 className="settings-section-heading">{t("settings.backups.databaseBackups", "Database Backups")}</h4>
      <details className="settings-advanced-disclosure">
        <summary>{t("settings.database.advanced", "Advanced database settings")}</summary>
        <SettingsNumberRow
          descriptor={{
            key: "embeddedPostgresMaxConnections",
            label: t("settings.database.embeddedConnectionCap", "Embedded PostgreSQL connection cap"),
            help: t("settings.database.embeddedConnectionCapHelp", "Maximum server connections for Fusion's embedded PostgreSQL. Applies after restarting Fusion. Range: 32–2,000. Unset by default — Fusion picks 500, or 150 on Windows where each connection is a separate process and higher caps can crash backends. External PostgreSQL uses its provider's connection limit."),
            scope: "global",
            min: 32,
            max: 2000,
            placeholder: t("settings.database.embeddedConnectionCapPlaceholder", "auto"),
          }}
          value={form.embeddedPostgresMaxConnections ?? null}
          onChange={(v) => setForm((f) => ({ ...f, embeddedPostgresMaxConnections: v ?? undefined }))}
          error={form.embeddedPostgresMaxConnections !== undefined && (form.embeddedPostgresMaxConnections < 32 || form.embeddedPostgresMaxConnections > 2000)
            ? t("settings.database.embeddedConnectionCapError", "Enter a value between 32 and 2,000.")
            : undefined}
        />
      </details>
      <SettingsToggleRow
        descriptor={{
          key: "autoBackupEnabled",
          label: t("settings.backups.enableAutomaticDatabaseBackups", " Enable automatic database backups "),
          help: t("settings.backups.whenEnabledTheDatabaseIsBackedUpAutomatically", "When enabled, the database is backed up automatically on a schedule. Default: disabled."),
          scope: "global",
        }}
        value={form.autoBackupEnabled || false}
        onChange={(v) => setForm((f) => ({ ...f, autoBackupEnabled: v === true }))}
      />
      <SettingsTextRow
        descriptor={{
          key: "autoBackupSchedule",
          label: t("settings.backups.backupScheduleCron", "Backup Schedule (Cron)"),
          help: t("settings.backups.cronExpressionForBackupTimingDefault02", " Cron expression for backup timing. Default: 0 2 * * * (daily at 2 AM). Examples: 0 * * * * (hourly), 0 0 * * 0 (weekly), */15 * * * * (every 15 min) "),
          scope: "global",
          placeholder: t("settings.backups.02", "0 2 * * *"),
          disabled: !form.autoBackupEnabled,
        }}
        value={form.autoBackupSchedule || "0 2 * * *"}
        onChange={(v) => setForm((f) => ({ ...f, autoBackupSchedule: v ?? "" }))}
        error={form.autoBackupSchedule && !/^[\s\d*,/-]+$/.test(form.autoBackupSchedule)
          ? t("settings.backups.invalidCronExpressionFormat", "Invalid cron expression format")
          : undefined}
      />
      <SettingsNumberRow
        descriptor={{
          key: "autoBackupRetention",
          label: t("settings.backups.retentionCount", "Retention Count"),
          help: t("settings.backups.numberOfBackupFilesToKeepOldestAre", "Number of backup files to keep (oldest are deleted first). Range: 1-100. Default: 7."),
          scope: "global",
          min: 1,
          max: 100,
          disabled: !form.autoBackupEnabled,
        }}
        value={form.autoBackupRetention ?? null}
        onChange={(v) => setForm((f) => ({ ...f, autoBackupRetention: v ?? undefined }))}
        error={form.autoBackupRetention !== undefined && (form.autoBackupRetention < 1 || form.autoBackupRetention > 100)
          ? t("settings.backups.mustBeBetween1And100", "Must be between 1 and 100")
          : undefined}
      />
      <SettingsTextRow
        descriptor={{
          key: "autoBackupDir",
          label: t("settings.backups.backupDirectory", "Backup Directory"),
          help: t("settings.backups.directoryForBackupFilesRelativeToProjectRoot", "Directory for backup files, relative to the global Fusion directory. Default: .fusion/backups."),
          scope: "global",
          placeholder: t("settings.backups.fusionBackups", ".fusion/backups"),
          disabled: !form.autoBackupEnabled,
        }}
        value={form.autoBackupDir || ".fusion/backups"}
        onChange={(v) => setForm((f) => ({ ...f, autoBackupDir: v ?? "" }))}
        error={form.autoBackupDir && form.autoBackupDir.includes("..")
          ? t("settings.backups.pathCannotContainParentDirectoryTraversal", "Path cannot contain parent directory traversal (..)")
          : undefined}
      />

      {backupLoading ? (<div className="settings-empty-state"><LoadingSpinner label={t("settings.backups.loadingBackupInfo", "Loading backup info\u2026")} /></div>) : backupInfo ? (<div className="form-group">
          <label>{t("settings.backups.currentBackups", "Current Backups")}</label>
          <div className="backup-stats">
            <div className="backup-stat">
              <span className="backup-stat-value">{backupInfo.count}</span>
              <span className="backup-stat-label">{t("settings.backups.backups", "backups")}</span>
            </div>
            <div className="backup-stat">
              <span className="backup-stat-value">
                {backupInfo.totalSize > 1024 * 1024
                ? `${(backupInfo.totalSize / (1024 * 1024)).toFixed(1)} MB`
                : `${(backupInfo.totalSize / 1024).toFixed(1)} KB`}
              </span>
              <span className="backup-stat-label">{t("settings.backups.totalSize", "total size")}</span>
            </div>
          </div>
          {backupInfo.backups.length > 0 && (<details className="backup-list">
              <summary>{t("settings.backups.view", "View ")}{backupInfo.backups.length}{t("settings.backups.backupS", " backup(s)")}</summary>
              <ul>
                {backupInfo.backups.slice(0, 10).map((backup) => (<li key={backup.filename}>
                    <code>{backup.filename}</code>
                    <span className="backup-size">
                      {backup.size > 1024 * 1024
                        ? `${(backup.size / (1024 * 1024)).toFixed(1)} MB`
                        : `${(backup.size / 1024).toFixed(1)} KB`}
                    </span>
                  </li>))}
                {backupInfo.backups.length > 10 && (<li><em>{t("settings.backups.and", "...and ")}{backupInfo.backups.length - 10}{t("settings.backups.more", " more")}</em></li>)}
              </ul>
            </details>)}
        </div>) : null}
      <div className="form-group">
        <button type="button" className="btn btn-sm" onClick={onBackupNow} disabled={backupLoading}>
          {backupLoading ? t("settings.backups.creating", "Creating…") : t("settings.backups.backupNow", "Backup Now")}
        </button>
      </div>
    </>);
}
export default DatabaseBackupsSection;
