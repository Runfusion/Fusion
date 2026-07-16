import { useTranslation } from "react-i18next";
import type { BackupListResponse } from "../../../api";
import { SettingsToggleRow } from "../SettingsToggleRow";
import { SettingsSelectRow } from "../SettingsSelectRow";
import { SettingsNumberRow } from "../SettingsNumberRow";
import { SettingsTextRow } from "../SettingsTextRow";
import type { SectionBaseProps } from "./context";
import { LoadingSpinner } from "../../LoadingSpinner";
export interface BackupsSectionProps extends SectionBaseProps {
    backupInfo: BackupListResponse | null;
    backupLoading: boolean;
    onBackupNow: () => void;
}
/*
FNXC:SettingsBackups 2026-07-15-17:35:
Every schedule/retention/directory row is gated on its own `*Enabled` toggle: the cron, retention count, and target directory only describe an automatic backup that is actually scheduled, so they are disabled rather than hidden — an operator turning backups on needs to see the values that will take effect.
Per-row validation (cron shape, 1-100 retention range, `..` traversal) rides the primitive's `error` band instead of a trailing `field-error` small, so an invalid value reports against the control that owns it.
*/
export function BackupsSection({ form, setForm, backupInfo, backupLoading, onBackupNow }: BackupsSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      <h4 className="settings-section-heading">{t("settings.backups.databaseBackups", "Database Backups")}</h4>
      <SettingsToggleRow
        descriptor={{
          key: "autoBackupEnabled",
          label: t("settings.backups.enableAutomaticDatabaseBackups", " Enable automatic database backups "),
          help: t("settings.backups.whenEnabledTheDatabaseIsBackedUpAutomatically", "When enabled, the database is backed up automatically on a schedule. Default: disabled."),
          scope: "project",
        }}
        value={form.autoBackupEnabled || false}
        onChange={(v) => setForm((f) => ({ ...f, autoBackupEnabled: v === true }))}
      />
      <SettingsTextRow
        descriptor={{
          key: "autoBackupSchedule",
          label: t("settings.backups.backupScheduleCron", "Backup Schedule (Cron)"),
          help: t("settings.backups.cronExpressionForBackupTimingDefault02", " Cron expression for backup timing. Default: 0 2 * * * (daily at 2 AM). Examples: 0 * * * * (hourly), 0 0 * * 0 (weekly), */15 * * * * (every 15 min) "),
          scope: "project",
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
          scope: "project",
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
          help: t("settings.backups.directoryForBackupFilesRelativeToProjectRoot", "Directory for backup files, relative to project root. Default: .fusion/backups."),
          scope: "project",
          placeholder: t("settings.backups.fusionBackups", ".fusion/backups"),
          disabled: !form.autoBackupEnabled,
        }}
        value={form.autoBackupDir || ".fusion/backups"}
        onChange={(v) => setForm((f) => ({ ...f, autoBackupDir: v ?? "" }))}
        error={form.autoBackupDir && form.autoBackupDir.includes("..")
          ? t("settings.backups.pathCannotContainParentDirectoryTraversal", "Path cannot contain parent directory traversal (..)")
          : undefined}
      />

      <h4 className="settings-section-heading">{t("settings.backups.memoryBackups", "Memory Backups")}</h4>
      <SettingsToggleRow
        descriptor={{
          key: "memoryBackupEnabled",
          label: t("settings.backups.enableAutomaticMemoryBackups", " Enable automatic memory backups "),
          help: t("settings.backups.whenEnabledProjectAndAgentMemoryFilesAre", "When enabled, project and agent memory files are backed up automatically on a schedule. Default: disabled."),
          scope: "project",
        }}
        value={form.memoryBackupEnabled || false}
        onChange={(v) => setForm((f) => ({ ...f, memoryBackupEnabled: v === true }))}
      />
      <SettingsTextRow
        descriptor={{
          key: "memoryBackupSchedule",
          label: t("settings.backups.memoryBackupScheduleCron", "Memory Backup Schedule (Cron)"),
          help: t("settings.backups.cronExpressionForMemoryBackupTimingDefault0", "Cron expression for memory backup timing. Default: 0 3 * * * (daily at 3 AM)."),
          scope: "project",
          placeholder: t("settings.backups.03", "0 3 * * *"),
          disabled: !form.memoryBackupEnabled,
        }}
        value={form.memoryBackupSchedule || "0 3 * * *"}
        onChange={(v) => setForm((f) => ({ ...f, memoryBackupSchedule: v ?? "" }))}
        error={form.memoryBackupSchedule && !/^[\s\d*,/-]+$/.test(form.memoryBackupSchedule)
          ? t("settings.backups.invalidCronExpressionFormat", "Invalid cron expression format")
          : undefined}
      />
      <SettingsNumberRow
        descriptor={{
          key: "memoryBackupRetention",
          label: t("settings.backups.memoryRetentionCount", "Memory Retention Count"),
          help: t("settings.backups.numberOfMemoryBackupsToKeepOldestAre", "Number of memory backups to keep (oldest are deleted first). Range: 1-100. Default: 14."),
          scope: "project",
          min: 1,
          max: 100,
          disabled: !form.memoryBackupEnabled,
        }}
        value={form.memoryBackupRetention ?? null}
        onChange={(v) => setForm((f) => ({ ...f, memoryBackupRetention: v ?? undefined }))}
        error={form.memoryBackupRetention !== undefined && (form.memoryBackupRetention < 1 || form.memoryBackupRetention > 100)
          ? t("settings.backups.mustBeBetween1And100", "Must be between 1 and 100")
          : undefined}
      />
      <SettingsTextRow
        descriptor={{
          key: "memoryBackupDir",
          label: t("settings.backups.memoryBackupDirectory", "Memory Backup Directory"),
          help: t("settings.backups.directoryForMemoryBackupsRelativeToProjectRoot", "Directory for memory backups, relative to project root. Default: .fusion/backups/memory."),
          scope: "project",
          placeholder: t("settings.backups.fusionBackupsMemory", ".fusion/backups/memory"),
          disabled: !form.memoryBackupEnabled,
        }}
        value={form.memoryBackupDir || ".fusion/backups/memory"}
        onChange={(v) => setForm((f) => ({ ...f, memoryBackupDir: v ?? "" }))}
        error={form.memoryBackupDir && form.memoryBackupDir.includes("..")
          ? t("settings.backups.pathCannotContainParentDirectoryTraversal", "Path cannot contain parent directory traversal (..)")
          : undefined}
      />
      <SettingsSelectRow
        descriptor={{
          key: "memoryBackupScope",
          label: t("settings.backups.memoryBackupScope", "Memory Backup Scope"),
          help: t("settings.backups.memoryBackupScopeHint", "Default: all (project + agents)."),
          scope: "project",
          disabled: !form.memoryBackupEnabled,
          options: [
            { value: "all", label: t("settings.backups.allProjectAgents", "All (project + agents)") },
            { value: "project", label: t("settings.backups.projectOnlyFusionMemory", "Project only (.fusion/memory)") },
            { value: "agents", label: t("settings.backups.agentsOnlyFusionAgentMemory", "Agents only (.fusion/agent-memory)") },
          ],
        }}
        value={form.memoryBackupScope || "all"}
        onChange={(v) => setForm((f) => ({ ...f, memoryBackupScope: (v ?? "all") as "project" | "agents" | "all" }))}
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
export default BackupsSection;
