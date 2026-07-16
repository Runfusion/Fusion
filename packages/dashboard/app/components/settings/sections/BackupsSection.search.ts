/**
 * Search entries for the Backups section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per settings control the section renders, co-located so a setting and its index entry change in the same edit. Labels and help mirror the section's `t()` calls verbatim: the index matches on the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 * The section's backup-stats panel and "Backup Now" button are deliberately absent — they report and trigger, they do not configure.
 */
import type { SettingsSearchEntry } from "../search/types";

export const backupsSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "backups",
    key: "autoBackupEnabled",
    labelKey: "settings.backups.enableAutomaticDatabaseBackups",
    labelFallback: " Enable automatic database backups ",
    helpKey: "settings.backups.whenEnabledTheDatabaseIsBackedUpAutomatically",
    helpFallback:
      "When enabled, the database is backed up automatically on a schedule. Default: disabled.",
    keywords: ["sqlite", "snapshot", "restore"],
  },
  {
    sectionId: "backups",
    key: "autoBackupSchedule",
    labelKey: "settings.backups.backupScheduleCron",
    labelFallback: "Backup Schedule (Cron)",
    helpKey: "settings.backups.cronExpressionForBackupTimingDefault02",
    helpFallback:
      " Cron expression for backup timing. Default: 0 2 * * * (daily at 2 AM). Examples: 0 * * * * (hourly), 0 0 * * 0 (weekly), */15 * * * * (every 15 min) ",
    keywords: ["timing", "frequency"],
  },
  {
    sectionId: "backups",
    key: "autoBackupRetention",
    labelKey: "settings.backups.retentionCount",
    labelFallback: "Retention Count",
    helpKey: "settings.backups.numberOfBackupFilesToKeepOldestAre",
    helpFallback:
      "Number of backup files to keep (oldest are deleted first). Range: 1-100. Default: 7.",
    keywords: ["how many", "prune", "rotation"],
  },
  {
    sectionId: "backups",
    key: "autoBackupDir",
    labelKey: "settings.backups.backupDirectory",
    labelFallback: "Backup Directory",
    helpKey: "settings.backups.directoryForBackupFilesRelativeToProjectRoot",
    helpFallback:
      "Directory for backup files, relative to project root. Default: .fusion/backups.",
    keywords: ["location", "folder", "destination"],
  },
  {
    sectionId: "backups",
    key: "memoryBackupEnabled",
    labelKey: "settings.backups.enableAutomaticMemoryBackups",
    labelFallback: " Enable automatic memory backups ",
    helpKey: "settings.backups.whenEnabledProjectAndAgentMemoryFilesAre",
    helpFallback:
      "When enabled, project and agent memory files are backed up automatically on a schedule. Default: disabled.",
    keywords: ["snapshot", "restore"],
  },
  {
    sectionId: "backups",
    key: "memoryBackupSchedule",
    labelKey: "settings.backups.memoryBackupScheduleCron",
    labelFallback: "Memory Backup Schedule (Cron)",
    helpKey: "settings.backups.cronExpressionForMemoryBackupTimingDefault0",
    helpFallback:
      "Cron expression for memory backup timing. Default: 0 3 * * * (daily at 3 AM).",
    keywords: ["timing", "frequency"],
  },
  {
    sectionId: "backups",
    key: "memoryBackupRetention",
    labelKey: "settings.backups.memoryRetentionCount",
    labelFallback: "Memory Retention Count",
    helpKey: "settings.backups.numberOfMemoryBackupsToKeepOldestAre",
    helpFallback:
      "Number of memory backups to keep (oldest are deleted first). Range: 1-100. Default: 14.",
    keywords: ["how many", "prune", "rotation"],
  },
  {
    sectionId: "backups",
    key: "memoryBackupDir",
    labelKey: "settings.backups.memoryBackupDirectory",
    labelFallback: "Memory Backup Directory",
    helpKey: "settings.backups.directoryForMemoryBackupsRelativeToProjectRoot",
    helpFallback:
      "Directory for memory backups, relative to project root. Default: .fusion/backups/memory.",
    keywords: ["location", "folder", "destination"],
  },
  {
    sectionId: "backups",
    key: "memoryBackupScope",
    labelKey: "settings.backups.memoryBackupScope",
    labelFallback: "Memory Backup Scope",
    helpKey: "settings.backups.memoryBackupScopeHint",
    helpFallback: "Default: all (project + agents).",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    The paths this setting selects between (.fusion/memory, .fusion/agent-memory) live in the option labels, which the index does not read — only the row's label and help. They are keywords so an operator searching a path they saw in the dropdown still lands here.
    */
    keywords: ["agent memory", ".fusion/memory", ".fusion/agent-memory", "what to back up"],
  },
];
