/**
 * Backups section (U9 / KTD-10).
 *
 * Project-scoped database-backup and memory-backup schedules/retention/dirs plus
 * the current-backups summary and the manual "Backup Now" action. The backup
 * info fetch and the backup-now handler live in the shell (they touch the API and
 * toast) and are relayed as props. Keys, validation regexes, and conditional
 * disabling preserved verbatim from the original inline JSX.
 */
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
  return (
    <>
      {scopeBanner}
      <h4 className="settings-section-heading">Database Backups</h4>
      <div className="form-group">
        <label htmlFor="autoBackupEnabled" className="checkbox-label">
          <input
            id="autoBackupEnabled"
            type="checkbox"
            checked={form.autoBackupEnabled || false}
            onChange={(e) =>
              setForm((f) => ({ ...f, autoBackupEnabled: e.target.checked }))
            }
          />
          Enable automatic database backups
        </label>
        <small>When enabled, the database is backed up automatically on a schedule</small>
      </div>
      <div className="form-group">
        <label htmlFor="autoBackupSchedule">Backup Schedule (Cron)</label>
        <input
          id="autoBackupSchedule"
          type="text"
          placeholder="0 2 * * *"
          value={form.autoBackupSchedule || "0 2 * * *"}
          onChange={(e) =>
            setForm((f) => ({ ...f, autoBackupSchedule: e.target.value }))
          }
          disabled={!form.autoBackupEnabled}
        />
        <small>
          Cron expression for backup timing. Default: 0 2 * * * (daily at 2 AM).
          Examples: 0 * * * * (hourly), 0 0 * * 0 (weekly), */15 * * * * (every 15 min)
        </small>
        {form.autoBackupSchedule && !/^[\s\d*,/-]+$/.test(form.autoBackupSchedule) && (
          <small className="field-error">Invalid cron expression format</small>
        )}
      </div>
      <div className="form-group">
        <label htmlFor="autoBackupRetention">Retention Count</label>
        <input
          id="autoBackupRetention"
          type="number"
          min={1}
          max={100}
          value={form.autoBackupRetention ?? ""}
          onChange={(e) => {
            const val = e.target.value;
            setForm((f) => ({ ...f, autoBackupRetention: val === "" ? undefined : Number(val) }));
          }}
          disabled={!form.autoBackupEnabled}
        />
        <small>Number of backup files to keep (oldest are deleted first). Range: 1-100.</small>
        {form.autoBackupRetention !== undefined && (form.autoBackupRetention < 1 || form.autoBackupRetention > 100) && (
          <small className="field-error">Must be between 1 and 100</small>
        )}
      </div>
      <div className="form-group">
        <label htmlFor="autoBackupDir">Backup Directory</label>
        <input
          id="autoBackupDir"
          type="text"
          placeholder=".fusion/backups"
          value={form.autoBackupDir || ".fusion/backups"}
          onChange={(e) =>
            setForm((f) => ({ ...f, autoBackupDir: e.target.value }))
          }
          disabled={!form.autoBackupEnabled}
        />
        <small>Directory for backup files, relative to project root</small>
        {form.autoBackupDir && form.autoBackupDir.includes("..") && (
          <small className="field-error">Path cannot contain parent directory traversal (..)</small>
        )}
      </div>

      <h4 className="settings-section-heading">Memory Backups</h4>
      <div className="form-group">
        <label htmlFor="memoryBackupEnabled" className="checkbox-label">
          <input
            id="memoryBackupEnabled"
            type="checkbox"
            checked={form.memoryBackupEnabled || false}
            onChange={(e) => setForm((f) => ({ ...f, memoryBackupEnabled: e.target.checked }))}
          />
          Enable automatic memory backups
        </label>
        <small>When enabled, project and agent memory files are backed up automatically on a schedule.</small>
      </div>
      <div className="form-group">
        <label htmlFor="memoryBackupSchedule">Memory Backup Schedule (Cron)</label>
        <input
          id="memoryBackupSchedule"
          type="text"
          placeholder="0 3 * * *"
          value={form.memoryBackupSchedule || "0 3 * * *"}
          onChange={(e) => setForm((f) => ({ ...f, memoryBackupSchedule: e.target.value }))}
          disabled={!form.memoryBackupEnabled}
        />
        <small>Cron expression for memory backup timing. Default: 0 3 * * * (daily at 3 AM).</small>
        {form.memoryBackupSchedule && !/^[\s\d*,/-]+$/.test(form.memoryBackupSchedule) && (
          <small className="field-error">Invalid cron expression format</small>
        )}
      </div>
      <div className="form-group">
        <label htmlFor="memoryBackupRetention">Memory Retention Count</label>
        <input
          id="memoryBackupRetention"
          type="number"
          min={1}
          max={100}
          value={form.memoryBackupRetention ?? ""}
          onChange={(e) => {
            const val = e.target.value;
            setForm((f) => ({ ...f, memoryBackupRetention: val === "" ? undefined : Number(val) }));
          }}
          disabled={!form.memoryBackupEnabled}
        />
        <small>Number of memory backups to keep (oldest are deleted first). Range: 1-100.</small>
        {form.memoryBackupRetention !== undefined && (form.memoryBackupRetention < 1 || form.memoryBackupRetention > 100) && (
          <small className="field-error">Must be between 1 and 100</small>
        )}
      </div>
      <div className="form-group">
        <label htmlFor="memoryBackupDir">Memory Backup Directory</label>
        <input
          id="memoryBackupDir"
          type="text"
          placeholder=".fusion/backups/memory"
          value={form.memoryBackupDir || ".fusion/backups/memory"}
          onChange={(e) => setForm((f) => ({ ...f, memoryBackupDir: e.target.value }))}
          disabled={!form.memoryBackupEnabled}
        />
        <small>Directory for memory backups, relative to project root.</small>
        {form.memoryBackupDir && form.memoryBackupDir.includes("..") && (
          <small className="field-error">Path cannot contain parent directory traversal (..)</small>
        )}
      </div>
      <div className="form-group">
        <label htmlFor="memoryBackupScope">Memory Backup Scope</label>
        <select
          id="memoryBackupScope"
          value={form.memoryBackupScope || "all"}
          onChange={(e) => setForm((f) => ({ ...f, memoryBackupScope: e.target.value as "project" | "agents" | "all" }))}
          disabled={!form.memoryBackupEnabled}
        >
          <option value="all">All (project + agents)</option>
          <option value="project">Project only (.fusion/memory)</option>
          <option value="agents">Agents only (.fusion/agent-memory)</option>
        </select>
      </div>
      {backupLoading ? (
        <div className="settings-empty-state">Loading backup info…</div>
      ) : backupInfo ? (
        <div className="form-group">
          <label>Current Backups</label>
          <div className="backup-stats">
            <div className="backup-stat">
              <span className="backup-stat-value">{backupInfo.count}</span>
              <span className="backup-stat-label">backups</span>
            </div>
            <div className="backup-stat">
              <span className="backup-stat-value">
                {backupInfo.totalSize > 1024 * 1024
                  ? `${(backupInfo.totalSize / (1024 * 1024)).toFixed(1)} MB`
                  : `${(backupInfo.totalSize / 1024).toFixed(1)} KB`}
              </span>
              <span className="backup-stat-label">total size</span>
            </div>
          </div>
          {backupInfo.backups.length > 0 && (
            <details className="backup-list">
              <summary>View {backupInfo.backups.length} backup(s)</summary>
              <ul>
                {backupInfo.backups.slice(0, 10).map((backup) => (
                  <li key={backup.filename}>
                    <code>{backup.filename}</code>
                    <span className="backup-size">
                      {backup.size > 1024 * 1024
                        ? `${(backup.size / (1024 * 1024)).toFixed(1)} MB`
                        : `${(backup.size / 1024).toFixed(1)} KB`}
                    </span>
                  </li>
                ))}
                {backupInfo.backups.length > 10 && (
                  <li><em>...and {backupInfo.backups.length - 10} more</em></li>
                )}
              </ul>
            </details>
          )}
        </div>
      ) : null}
      <div className="form-group">
        <button
          type="button"
          className="btn btn-sm"
          onClick={onBackupNow}
          disabled={backupLoading}
        >
          {backupLoading ? t("settings.backups.creating", "Creating…") : t("settings.backups.backupNow", "Backup Now")}
        </button>
      </div>
    </>
  );
}

export default BackupsSection;
