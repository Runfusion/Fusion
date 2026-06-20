import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { BackupListResponse } from "../../../api";
import type { SectionBaseProps } from "./context";
export interface BackupsSectionProps extends SectionBaseProps {
    scopeBanner: ReactNode;
    backupInfo: BackupListResponse | null;
    backupLoading: boolean;
    onBackupNow: () => void;
}
export function BackupsSection({ scopeBanner, form, setForm, backupInfo, backupLoading, onBackupNow }: BackupsSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.backups.databaseBackups", "Database Backups")}</h4>
      <div className="form-group">
        <label htmlFor="autoBackupEnabled" className="checkbox-label">
          <input id="autoBackupEnabled" type="checkbox" checked={form.autoBackupEnabled || false} onChange={(e) => setForm((f) => ({ ...f, autoBackupEnabled: e.target.checked }))}/>{t("settings.backups.enableAutomaticDatabaseBackups", " Enable automatic database backups ")}</label>
        <small>{t("settings.backups.whenEnabledTheDatabaseIsBackedUpAutomatically", "When enabled, the database is backed up automatically on a schedule")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="autoBackupSchedule">{t("settings.backups.backupScheduleCron", "Backup Schedule (Cron)")}</label>
        <input id="autoBackupSchedule" type="text" placeholder={t("settings.backups.02", "0 2 * * *")} value={form.autoBackupSchedule || "0 2 * * *"} onChange={(e) => setForm((f) => ({ ...f, autoBackupSchedule: e.target.value }))} disabled={!form.autoBackupEnabled}/>
        <small>{t("settings.backups.cronExpressionForBackupTimingDefault02", " Cron expression for backup timing. Default: 0 2 * * * (daily at 2 AM). Examples: 0 * * * * (hourly), 0 0 * * 0 (weekly), */15 * * * * (every 15 min) ")}</small>
        {form.autoBackupSchedule && !/^[\s\d*,/-]+$/.test(form.autoBackupSchedule) && (<small className="field-error">{t("settings.backups.invalidCronExpressionFormat", "Invalid cron expression format")}</small>)}
      </div>
      <div className="form-group">
        <label htmlFor="autoBackupRetention">{t("settings.backups.retentionCount", "Retention Count")}</label>
        <input id="autoBackupRetention" type="number" min={1} max={100} value={form.autoBackupRetention ?? ""} onChange={(e) => {
            const val = e.target.value;
            setForm((f) => ({ ...f, autoBackupRetention: val === "" ? undefined : Number(val) }));
        }} disabled={!form.autoBackupEnabled}/>
        <small>{t("settings.backups.numberOfBackupFilesToKeepOldestAre", "Number of backup files to keep (oldest are deleted first). Range: 1-100.")}</small>
        {form.autoBackupRetention !== undefined && (form.autoBackupRetention < 1 || form.autoBackupRetention > 100) && (<small className="field-error">{t("settings.backups.mustBeBetween1And100", "Must be between 1 and 100")}</small>)}
      </div>
      <div className="form-group">
        <label htmlFor="autoBackupDir">{t("settings.backups.backupDirectory", "Backup Directory")}</label>
        <input id="autoBackupDir" type="text" placeholder={t("settings.backups.fusionBackups", ".fusion/backups")} value={form.autoBackupDir || ".fusion/backups"} onChange={(e) => setForm((f) => ({ ...f, autoBackupDir: e.target.value }))} disabled={!form.autoBackupEnabled}/>
        <small>{t("settings.backups.directoryForBackupFilesRelativeToProjectRoot", "Directory for backup files, relative to project root")}</small>
        {form.autoBackupDir && form.autoBackupDir.includes("..") && (<small className="field-error">{t("settings.backups.pathCannotContainParentDirectoryTraversal", "Path cannot contain parent directory traversal (..)")}</small>)}
      </div>

      <h4 className="settings-section-heading">{t("settings.backups.memoryBackups", "Memory Backups")}</h4>
      <div className="form-group">
        <label htmlFor="memoryBackupEnabled" className="checkbox-label">
          <input id="memoryBackupEnabled" type="checkbox" checked={form.memoryBackupEnabled || false} onChange={(e) => setForm((f) => ({ ...f, memoryBackupEnabled: e.target.checked }))}/>{t("settings.backups.enableAutomaticMemoryBackups", " Enable automatic memory backups ")}</label>
        <small>{t("settings.backups.whenEnabledProjectAndAgentMemoryFilesAre", "When enabled, project and agent memory files are backed up automatically on a schedule.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="memoryBackupSchedule">{t("settings.backups.memoryBackupScheduleCron", "Memory Backup Schedule (Cron)")}</label>
        <input id="memoryBackupSchedule" type="text" placeholder={t("settings.backups.03", "0 3 * * *")} value={form.memoryBackupSchedule || "0 3 * * *"} onChange={(e) => setForm((f) => ({ ...f, memoryBackupSchedule: e.target.value }))} disabled={!form.memoryBackupEnabled}/>
        <small>{t("settings.backups.cronExpressionForMemoryBackupTimingDefault0", "Cron expression for memory backup timing. Default: 0 3 * * * (daily at 3 AM).")}</small>
        {form.memoryBackupSchedule && !/^[\s\d*,/-]+$/.test(form.memoryBackupSchedule) && (<small className="field-error">{t("settings.backups.invalidCronExpressionFormat", "Invalid cron expression format")}</small>)}
      </div>
      <div className="form-group">
        <label htmlFor="memoryBackupRetention">{t("settings.backups.memoryRetentionCount", "Memory Retention Count")}</label>
        <input id="memoryBackupRetention" type="number" min={1} max={100} value={form.memoryBackupRetention ?? ""} onChange={(e) => {
            const val = e.target.value;
            setForm((f) => ({ ...f, memoryBackupRetention: val === "" ? undefined : Number(val) }));
        }} disabled={!form.memoryBackupEnabled}/>
        <small>{t("settings.backups.numberOfMemoryBackupsToKeepOldestAre", "Number of memory backups to keep (oldest are deleted first). Range: 1-100.")}</small>
        {form.memoryBackupRetention !== undefined && (form.memoryBackupRetention < 1 || form.memoryBackupRetention > 100) && (<small className="field-error">{t("settings.backups.mustBeBetween1And100", "Must be between 1 and 100")}</small>)}
      </div>
      <div className="form-group">
        <label htmlFor="memoryBackupDir">{t("settings.backups.memoryBackupDirectory", "Memory Backup Directory")}</label>
        <input id="memoryBackupDir" type="text" placeholder={t("settings.backups.fusionBackupsMemory", ".fusion/backups/memory")} value={form.memoryBackupDir || ".fusion/backups/memory"} onChange={(e) => setForm((f) => ({ ...f, memoryBackupDir: e.target.value }))} disabled={!form.memoryBackupEnabled}/>
        <small>{t("settings.backups.directoryForMemoryBackupsRelativeToProjectRoot", "Directory for memory backups, relative to project root.")}</small>
        {form.memoryBackupDir && form.memoryBackupDir.includes("..") && (<small className="field-error">{t("settings.backups.pathCannotContainParentDirectoryTraversal", "Path cannot contain parent directory traversal (..)")}</small>)}
      </div>
      <div className="form-group">
        <label htmlFor="memoryBackupScope">{t("settings.backups.memoryBackupScope", "Memory Backup Scope")}</label>
        <select id="memoryBackupScope" value={form.memoryBackupScope || "all"} onChange={(e) => setForm((f) => ({ ...f, memoryBackupScope: e.target.value as "project" | "agents" | "all" }))} disabled={!form.memoryBackupEnabled}>
          <option value="all">{t("settings.backups.allProjectAgents", "All (project + agents)")}</option>
          <option value="project">{t("settings.backups.projectOnlyFusionMemory", "Project only (.fusion/memory)")}</option>
          <option value="agents">{t("settings.backups.agentsOnlyFusionAgentMemory", "Agents only (.fusion/agent-memory)")}</option>
        </select>
      </div>
      {backupLoading ? (<div className="settings-empty-state">{t("settings.backups.loadingBackupInfo", "Loading backup info\u2026")}</div>) : backupInfo ? (<div className="form-group">
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
