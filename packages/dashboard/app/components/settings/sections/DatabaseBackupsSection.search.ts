/**
 * Search entries for the global Database Backups section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per settings control the section renders, co-located so a setting and its index entry change in the same edit. Labels and help mirror the section's `t()` calls verbatim: the index matches on the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 * The section's backup-stats panel and "Backup Now" button are deliberately absent — they report and trigger, they do not configure.
 */
import type { SettingsSearchEntry } from "../search/types";

export const databaseBackupsSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "backups-global",
    key: "autoBackupEnabled",
    labelKey: "settings.backups.enableAutomaticDatabaseBackups",
    labelFallback: " Enable automatic database backups ",
    helpKey: "settings.backups.whenEnabledTheDatabaseIsBackedUpAutomatically",
    helpFallback:
      "When enabled, the database is backed up automatically on a schedule. Default: disabled.",
    keywords: ["sqlite", "snapshot", "restore"],
  },
  {
    sectionId: "backups-global",
    key: "autoBackupSchedule",
    labelKey: "settings.backups.backupScheduleCron",
    labelFallback: "Backup Schedule (Cron)",
    helpKey: "settings.backups.cronExpressionForBackupTimingDefault02",
    helpFallback:
      " Cron expression for backup timing. Default: 0 2 * * * (daily at 2 AM). Examples: 0 * * * * (hourly), 0 0 * * 0 (weekly), */15 * * * * (every 15 min) ",
    keywords: ["timing", "frequency"],
  },
  {
    sectionId: "backups-global",
    key: "autoBackupRetention",
    labelKey: "settings.backups.retentionCount",
    labelFallback: "Retention Count",
    helpKey: "settings.backups.numberOfBackupFilesToKeepOldestAre",
    helpFallback:
      "Number of backup files to keep (oldest are deleted first). Range: 1-100. Default: 7.",
    keywords: ["how many", "prune", "rotation"],
  },
  {
    sectionId: "backups-global",
    key: "autoBackupDir",
    labelKey: "settings.backups.backupDirectory",
    labelFallback: "Backup Directory",
    helpKey: "settings.backups.directoryForBackupFilesRelativeToProjectRoot",
    helpFallback:
      "Directory for backup files, relative to project root. Default: .fusion/backups.",
    keywords: ["location", "folder", "destination"],
  },
];
