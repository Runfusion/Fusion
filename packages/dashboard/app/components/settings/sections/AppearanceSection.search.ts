/**
 * Search entries for the Appearance section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per control the section renders, co-located so a setting and its index entry change in the same edit. `settings-search-index.test.ts` fails the build if a descriptor `key` here and in AppearanceSection.tsx ever diverge, which is what keeps the index honest without anyone maintaining a keyword list by hand.
 * Labels and help mirror the section's `t()` calls verbatim: the index matches on the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 */
import type { SettingsSearchEntry } from "../search/types";

export const appearanceSearchEntries: SettingsSearchEntry[] = [
  /*
   * FNXC:SettingsSearch 2026-08-19-14:19:
   * Every rendered descriptor must have one co-located searchable entry. Keep
   * the project-scoped conversation layout metadata identical to AppearanceSection
   * so label, help, and field-key queries all reach the existing control.
   */
  /*
   * FNXC:SettingsSearch 2026-09-15-14:41:
   * FN-419 navigation placement control. Label and help mirror the section's `t()` calls verbatim.
   */
  {
    sectionId: "appearance",
    key: "navigationPlacement",
    labelKey: "settings.appearance.navigationPlacement",
    labelFallback: "Navigation menu placement",
    helpKey: "settings.appearance.navigationPlacementHelp",
    helpFallback:
      "Choose whether the main menu sits in the bottom bar or in a left sidebar. Only one is ever shown. Project-scoped; default: Bottom bar.",
    keywords: ["menu", "navigation", "sidebar", "footer", "bottom bar"],
  },
  /*
   * FNXC:SettingsSearch 2026-09-15-16:04:
   * FN-426 right tool dock opt-in. Label and help mirror the section's `t()` calls verbatim.
   */
  {
    sectionId: "appearance",
    key: "rightSidebarEnabled",
    labelKey: "settings.appearance.rightSidebarEnabled",
    labelFallback: "Show the right tool sidebar",
    helpKey: "settings.appearance.rightSidebarEnabledHelp",
    helpFallback:
      "When enabled, tablet and desktop show an optional right sidebar with Files, Chat, List, and Notes shortcuts. Every tool stays reachable without it. Project-scoped; default: disabled.",
    keywords: ["right sidebar", "dock", "tools", "panel", "files", "notes"],
  },
  {
    sectionId: "appearance",
    key: "chatMessageLayout",
    labelKey: "settings.appearance.chatMessageLayout",
    labelFallback: "Conversation layout",
    helpKey: "settings.appearance.chatMessageLayoutHelp",
    helpFallback:
      "Choose Bubbles or Full width for Chat, task Activity, and Planner Chat. Project-scoped; default: Bubbles.",
  },
  /*
  FNXC:SettingsSearch 2026-09-16-02:53:
  FN-442 deleted the `openTasksInRightSidebar` and `openMobileTasksInPopup` entries with their settings: the floating task
  window is the unconditional route, so searching for them must surface nothing rather than a control that no longer exists.
  */
  {
    sectionId: "appearance",
    key: "showCostBadgeOnCards",
    labelKey: "settings.appearance.showCostBadgeOnCards",
    labelFallback: "Show cost badges on task cards",
    helpKey: "settings.appearance.showCostBadgeOnCardsHelp",
    helpFallback:
      "Default: disabled. When enabled, board cards show derived model cost next to execution time; unavailable pricing displays — and tasks without token usage show no badge.",
    keywords: ["spend", "price", "tokens", "usage"],
  },
  {
    sectionId: "appearance",
    key: "taskDetailDefaultTab",
    labelKey: "settings.appearance.taskDetailDefaultTab",
    labelFallback: "Open task details on",
    helpKey: "settings.appearance.taskDetailDefaultTabHelp",
    helpFallback:
      "Choose which tab a task opens on and leads the task detail tab bar: Definition, Chat, or Activity. Explicit task links keep their destination. Project-scoped; default: Activity.",
    keywords: ["default tab", "activity first", "chat first", "definition", "landing tab", "tab order"],
  },
  {
    sectionId: "appearance",
    key: "sessionBannersHidden",
    labelKey: "settings.appearance.hideAISessionNotificationBanners",
    labelFallback: "Hide AI session notification banners",
    helpKey: "settings.appearance.suppressTheLdquoNeedsYourInputRdquoBanner",
    helpFallback:
      "Suppress the “needs your input” banner that appears when AI sessions are awaiting input or have failed.",
    keywords: ["needs your input", "toast", "alert"],
  },
];
