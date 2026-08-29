/**
 * Search entries for the Node Sync section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per descriptor row the section renders, co-located so a setting and its index entry change in the same edit. Labels and help mirror the section's `t()` calls verbatim — search matches the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 * The three gated rows are indexed even though they only render while `settingsSyncEnabled` is on: search lands the operator on the section, and hiding a setting from search because it is currently gated would make it undiscoverable exactly when someone is trying to find out how to turn it on.
 */
import type { SettingsSearchEntry } from "../search/types";

export const nodeSyncSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "node-sync",
    key: "settingsSyncEnabled",
    labelKey: "settings.nodeSync.enableAutomaticSettingsSync",
    labelFallback: " Enable automatic settings sync ",
    helpKey: "settings.nodeSync.automaticallySynchronizeSettingsBetweenThisNodeAndConnected",
    helpFallback:
      "Automatically synchronize settings between this node and connected remote nodes. Default: disabled.",
  },
  {
    sectionId: "node-sync",
    key: "settingsSyncAuth",
    labelKey: "settings.nodeSync.syncModelAuthCredentials",
    labelFallback: " Sync model auth credentials ",
    helpKey: "settings.nodeSync.includeAPIKeysAndOAuthTokensInSync",
    helpFallback: "Include API keys and OAuth tokens in sync operations. Default: disabled.",
    keywords: ["secrets", "authentication"],
  },
  {
    sectionId: "node-sync",
    key: "settingsSyncInterval",
    labelKey: "settings.nodeSync.syncInterval",
    labelFallback: "Sync interval",
    helpKey: "settings.nodeSync.syncIntervalHint",
    helpFallback: "Default: every 15 minutes.",
    keywords: ["frequency", "how often", "schedule"],
  },
  {
    sectionId: "node-sync",
    key: "settingsSyncConflictResolution",
    labelKey: "settings.nodeSync.conflictResolution",
    labelFallback: "Conflict resolution",
    helpKey: "settings.nodeSync.conflictResolutionHint",
    helpFallback: "Default: last write wins.",
  },
];
