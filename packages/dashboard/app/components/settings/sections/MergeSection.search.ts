/**
 * Search entries for the Merge section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per descriptor row the section renders, co-located so a setting and its index entry change in the same edit. Labels and help mirror the section's `t()` calls verbatim: the index matches on the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 * This list is short because most of Merge is deliberately still bespoke — "More details" disclosure rows, custom branch/remote dropdowns, and rows whose help interleaves `<code>` fragments. See the FNXC block in MergeSection.tsx for why each stayed. Those settings remain reachable through the section's own `searchableText` in SETTINGS_SECTIONS; they simply have no per-control anchor yet.
 *
 * FNXC:SettingsSearch 2026-07-15-20:30:
 * The GitHub/GitLab auth entries moved to SourceControlSection.search.ts with their controls. Merge no longer renders any forge auth row, so password inputs are no longer among this section's reasons for staying bespoke.
 */
import type { SettingsSearchEntry } from "../search/types";

export const mergeSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "merge",
    key: "maxAutoMergeRetries",
    labelKey: "settings.merge.autoMergeConflictRetries",
    labelFallback: "Auto-merge conflict retries",
    helpKey: "settings.merge.positiveIntegerRetryCapForAutoMergeConflict",
    helpFallback:
      "Positive integer retry cap for auto-merge conflict resolution before a task parks for human recovery. Default 3.",
    keywords: ["attempts", "give up", "parked", "merge failure"],
  },
  {
    sectionId: "merge",
    key: "merger.maxReviewPasses",
    labelKey: "settings.merge.maxAIReviewPasses",
    labelFallback: "Max AI review passes",
    helpKey: "settings.merge.aICorrectiveRoundsBeforeLandingTheBestResult",
    helpFallback:
      "AI corrective rounds before landing the best result (advisory concern) or hard-failing (unfixable correctness concern). Default 3. The reviewer uses your project's reviewer/validator model.",
    keywords: ["clean room", "audit", "retries", "attempts"],
  },
  {
    sectionId: "merge",
    key: "mergeStrategyOverlapBehavior",
    labelKey: "settings.merge.smartPreferMainOverlapGuard",
    labelFallback: "Smart Prefer Main Overlap Guard",
    helpKey: "settings.merge.whenUsingSmartPreferMainAutomaticallyPreferThe",
    helpFallback:
      " When using smart-prefer-main, automatically prefer the branch side for files that main has recently modified to avoid silently discarding branch work. ",
    keywords: ["ours", "theirs", "lost work", "clobber"],
  },
];
