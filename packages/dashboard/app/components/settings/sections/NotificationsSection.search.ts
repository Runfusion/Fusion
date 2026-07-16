/**
 * Search entries for the Notifications section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per descriptor row the section renders, co-located so a setting and its index entry change in the same edit. Labels and help mirror the section's `t()` calls verbatim: the index matches on the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 * The section's still-bespoke controls are deliberately absent — they are not descriptor rows, so indexing them would point search at an anchor that does not exist: the ntfy/webhook Enable switches (card headers), the ntfy topic + Advanced disclosure (server URL, access token), the per-event checkbox grids, and the Test notification buttons.
 */
import type { SettingsSearchEntry } from "../search/types";

export const notificationsSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "notifications",
    key: "failureNotificationMode",
    labelKey: "settings.notifications.failureNotificationMode",
    labelFallback: "Failure notification mode",
    helpKey: "settings.notifications.stickyOnlySuppressesRecoveredFailuresTerminalOnlyWaits",
    helpFallback:
      "Sticky-only suppresses recovered failures; terminal-only waits for paused/in-review failed tasks; all restores legacy alerts.",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    "retry" and "noise" are indexed because this control is what an operator reaches for when auto-retried failures are spamming them — vocabulary the copy never uses, since it describes the modes rather than the problem they solve.
    */
    keywords: ["retry", "noise", "alerts"],
  },
  {
    sectionId: "notifications",
    key: "failureNotificationDelayMs",
    labelKey: "settings.notifications.failureNotificationDelayMs",
    labelFallback: "Failure notification delay (ms)",
    helpKey: "settings.notifications.howLongAFailureMustPersistBeforeA",
    helpFallback:
      " How long a failure must persist before a push notification is sent. 0 = notify immediately. Default: 30000 (30 seconds). ",
    keywords: ["debounce", "wait", "throttle"],
  },
  {
    sectionId: "notifications",
    key: "ntfyDashboardHost",
    labelKey: "settings.notifications.dashboardHostname",
    labelFallback: "Dashboard Hostname",
    helpKey: "settings.notifications.baseURLForDeepLinksInNotificationsWhen",
    helpFallback:
      " Base URL for deep links in notifications. When set, clicking a notification opens the dashboard directly to the task. No default — unset. ",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    "ntfy" is a keyword rather than left to the copy: the stored key is `ntfyDashboardHost` and the row renders inside the ntfy provider card, but its label and help never say "ntfy", so an operator scanning for their ntfy configuration would otherwise miss it.
    */
    keywords: ["ntfy", "deep link", "base url"],
  },
  {
    sectionId: "notifications",
    key: "webhookUrl",
    labelKey: "settings.notifications.webhookURL",
    labelFallback: "Webhook URL",
    helpKey: "settings.notifications.webhookUrlHint",
    helpFallback: "No default — unset.",
    keywords: ["endpoint", "hook", "callback"],
  },
  {
    sectionId: "notifications",
    key: "webhookFormat",
    labelKey: "settings.notifications.format",
    labelFallback: "Format",
    helpKey: "settings.notifications.webhookFormatHint",
    helpFallback: "Default: generic.",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    The destinations this setting selects between live in the option labels, which the index does not read — only the row's label and help. "Slack"/"Discord" are the words an operator actually searches, and the label is the single word "Format", so without these keywords the row is effectively unfindable.
    */
    keywords: ["slack", "discord", "payload", "webhook"],
  },
];
