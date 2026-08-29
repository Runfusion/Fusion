import { useTranslation } from "react-i18next";
import { SettingsToggleRow } from "../SettingsToggleRow";
import { SettingsSelectRow } from "../SettingsSelectRow";
import { SettingsNumberRow } from "../SettingsNumberRow";
import { SettingsTextRow } from "../SettingsTextRow";
import type { SectionBaseProps } from "./context";
/*
FNXC:SettingsBackups 2026-07-16-14:35:
Memory backup files are project-owned, so only memory settings remain in this project-scoped section after database backup policy moved to the global cluster section.
*/
export function BackupsSection({ form, setForm }: SectionBaseProps) {
  const { t } = useTranslation("app");
  return (<>
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
    </>);
}
export default BackupsSection;
