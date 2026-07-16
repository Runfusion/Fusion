/**
 * Search entries for the Global General section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per descriptor row the section renders, co-located so a setting and its index entry change in the same edit. Labels and help mirror the section's `t()` calls verbatim: the index matches on the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 * The section's bespoke rows are deliberately absent — CliBinaryPanel, the thinking-log pair, the `fn` binary check, and the update-check toggle are not descriptor rows, so they carry no `data-settings-key` anchor for a result to scroll to.
 *
 * FNXC:SettingsSearch 2026-07-15-20:30:
 * The global GitLab rows and the global tracking-repo select moved to SourceControlGlobalSection.search.ts with their controls; neither was indexed from here before (both were bespoke), so this is a move of the section's contents, not of its entries.
 */
import type { SettingsSearchEntry } from "../search/types";

export const globalGeneralSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "global-general",
    key: "dismissModalsOnOutsideClick",
    labelKey: "settings.globalGeneral.dismissModalsByClickingOutside",
    labelFallback: " Dismiss modals by clicking outside ",
    helpKey: "settings.globalGeneral.dismissModalsByClickingOutsideHint",
    helpFallback:
      " When enabled, clicking or tapping a modal backdrop closes the modal. Default: disabled, to prevent accidental dismissal. ",
    keywords: ["dialog", "backdrop", "accidental close"],
  },
  {
    sectionId: "global-general",
    key: "persistAgentToolOutput",
    labelKey: "settings.globalGeneral.saveToolOutputInAgentLogs",
    labelFallback: " Save tool output in agent logs ",
    helpKey: "settings.globalGeneral.whenDisabledToolRowsAreStillLoggedBut",
    helpFallback:
      " When disabled, tool rows are still logged but detailed tool payloads are omitted. Very large tool payloads may still be clipped even when this stays enabled. Default: disabled. ",
    keywords: ["persist", "transcript", "disk usage"],
  },
  {
    sectionId: "global-general",
    key: "updateCheckFrequency",
    labelKey: "settings.globalGeneral.frequency",
    labelFallback: "Frequency",
    helpKey: "settings.globalGeneral.controlsHowOftenTheDashboardReFetchesThe",
    helpFallback:
      " Controls how often the dashboard re-fetches the npm registry. Use the version + refresh control in the header to trigger an immediate check at any time. Default: daily. ",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    The label is the bare word "Frequency" — it only reads as the update cadence because of the "Updates" heading above it, which the index does not see. The feature's own vocabulary is keyworded so a search for "update check" reaches this control.
    */
    keywords: ["update check", "cadence", "how often", "version check"],
  },
  {
    sectionId: "global-general",
    key: "autoReloadOnVersionChange",
    labelKey: "settings.globalGeneral.autoReloadDashboardOnVersionChange",
    labelFallback: " Auto-reload dashboard on version change ",
    helpKey: "settings.globalGeneral.whenEnabledDefaultTheDashboardAutomaticallyReloadsWhen",
    helpFallback:
      " When enabled (default), the dashboard automatically reloads when it detects a new build version — either from server rebuilds or service worker updates. Disable this to stay on the current version until you manually refresh. Default: enabled. ",
    keywords: ["refresh", "service worker", "hot reload"],
  },
];
