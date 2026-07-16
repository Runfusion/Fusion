/**
 * Search entries for the Appearance section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per control the section renders, co-located so a setting and its index entry change in the same edit. `settings-search-index.test.ts` fails the build if a descriptor `key` here and in AppearanceSection.tsx ever diverge, which is what keeps the index honest without anyone maintaining a keyword list by hand.
 * Labels and help mirror the section's `t()` calls verbatim: the index matches on the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 */
import type { SettingsSearchEntry } from "../search/types";

export const appearanceSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "appearance",
    key: "openTasksInRightSidebar",
    labelKey: "settings.appearance.openTasksInRightSidebar",
    labelFallback: "Open tasks in the right sidebar",
    helpKey: "settings.appearance.openTasksInRightSidebarHelp",
    helpFallback:
      "When enabled, board task cards open detail in the right sidebar when it is available; mobile and hidden-sidebar states keep the full task panel. Default: disabled.",
    keywords: ["dock", "right dock", "side panel"],
  },
  {
    sectionId: "appearance",
    key: "openMobileTasksInPopup",
    labelKey: "settings.appearance.openMobileTasksInPopup",
    labelFallback: "Open tasks as popups",
    helpKey: "settings.appearance.openMobileTasksInPopupHelp",
    helpFallback:
      "When enabled, ordinary board task-card, List row/card, and right-dock Tasks-list clicks open the existing movable task popup so the board or list remains visible. Deep-tab and other task opens keep their current behavior. Default: disabled.",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    "mobile" is indexed as a keyword rather than left to the copy: the stored key is `openMobileTasksInPopup` and the setting was mobile-only until FN-7945 made it all-viewport, so operators and older docs still call it the mobile popup setting even though the label no longer says it.
    */
    keywords: ["mobile", "floating window", "modal"],
  },
  {
    sectionId: "appearance",
    key: "taskPopupsBoardListOnly",
    labelKey: "settings.appearance.taskPopupsBoardListOnly",
    labelFallback: "Keep task popups on the view where they were opened",
    helpKey: "settings.appearance.taskPopupsBoardListOnlyHelp",
    helpFallback:
      "When enabled, each open task-detail popup appears only on the view where it was opened. Switching views hides it without closing; returning restores it in the same position. Default: enabled.",
    keywords: ["popup view attachment", "pin popup"],
  },
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
    key: "taskDetailChatFirst",
    labelKey: "settings.appearance.taskDetailChatFirst",
    labelFallback: "Open task details with Chat first",
    helpKey: "settings.appearance.taskDetailChatFirstHelp",
    helpFallback:
      "Off by default: task details list Activity first and omitted non-done opens land on Activity. Turn on to restore Chat-first order/default; explicit Chat links still work either way.",
    keywords: ["activity first", "default tab"],
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
