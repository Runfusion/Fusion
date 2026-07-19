/**
 * Search entries for the Scheduling · Global section.
 *
 * FNXC:SettingsSearch 2026-07-15-18:52:
 * `globalMaxConcurrent` moved here with its control when Scheduling was split into a Global/Project pair. The entry's `sectionId` must track the section that actually RENDERS the row — a stale id would surface the result, jump to a section that no longer holds the anchor, and do nothing.
 */
import type { SettingsSearchEntry } from "../search/types";

export const schedulingGlobalSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "scheduling-global",
    key: "globalMaxConcurrent",
    labelKey: "settings.scheduling.globalMaxConcurrent",
    labelFallback: "Global Max Concurrent",
    helpKey: "settings.scheduling.maximumConcurrentAgentsAcrossAllProjects",
    helpFallback: "Maximum concurrent agents across all projects. Default: 4.",
    keywords: ["parallelism", "capacity", "machine wide", "cap"],
  },
];
