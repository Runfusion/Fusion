/**
 * Search entries for the Memory section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per settings control the section renders, co-located so a setting and its index entry change in the same edit. Labels and help mirror the section's `t()` calls verbatim: the index matches on the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 * The section's retrieval tester, memory-file picker, and file editor are deliberately absent — they edit no settings key, so they are not settings an operator can search for.
 */
import type { SettingsSearchEntry } from "../search/types";

export const memorySearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "memory",
    key: "memoryEnabled",
    labelKey: "settings.memory.enableMemoryTools",
    labelFallback: " Enable memory tools ",
    helpKey: "settings.memory.agentsGetMemorySearchMemoryGetAndMemory",
    helpFallback:
      "Agents get memory_search, memory_get, and memory_append tools. Search defaults to qmd with a local file fallback. Default: enabled.",
    keywords: ["recall", "knowledge"],
  },
  {
    sectionId: "memory",
    key: "memoryAutoSummarizeEnabled",
    labelKey: "settings.memory.autoSummarizeMemory",
    labelFallback: " Auto-Summarize Memory ",
    helpKey: "settings.memory.automaticallyCompactMemoryWhenItExceedsTheThreshold",
    helpFallback:
      "Automatically compact memory when it exceeds the threshold on a schedule. Default: disabled.",
    keywords: ["condense", "prune", "shrink"],
  },
  {
    sectionId: "memory",
    key: "memoryAutoSummarizeThresholdChars",
    labelKey: "settings.memory.compactionThresholdChars",
    labelFallback: "Compaction Threshold (chars)",
    helpKey: "settings.memory.memoryWillBeCompactedWhenItExceedsThis",
    helpFallback:
      "Memory will be compacted when it exceeds this character count. Default: 50000.",
    keywords: ["size limit", "trigger"],
  },
  {
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    Auto-summarize and insight extraction share the label "Schedule (cron)" and its i18n key, so entries are distinguished by `key` alone. This is exactly why the index is keyed by settings field name rather than i18n key — two controls here would otherwise collide.
    */
    sectionId: "memory",
    key: "memoryAutoSummarizeSchedule",
    labelKey: "settings.memory.scheduleCron",
    labelFallback: "Schedule (cron)",
    helpKey: "settings.memory.cronExpressionForAutoSummarizeScheduleDefaultDaily",
    helpFallback:
      "Cron expression for auto-summarize schedule. Default: 0 3 * * * (daily at 3 AM).",
    keywords: ["auto-summarize", "compaction schedule", "timing"],
  },
  {
    sectionId: "memory",
    key: "insightExtractionEnabled",
    labelKey: "settings.memory.enableInsightExtraction",
    labelFallback: " Enable Insight Extraction ",
    helpKey: "settings.memory.periodicallyExtractDurableInsightsFromCompletedTasks",
    helpFallback:
      "Periodically extract durable insights/learnings from completed tasks into memory",
    keywords: ["lessons", "retrospective"],
  },
  {
    sectionId: "memory",
    key: "insightExtractionSchedule",
    labelKey: "settings.memory.scheduleCron",
    labelFallback: "Schedule (cron)",
    helpKey: "settings.memory.cronExpressionForInsightExtractionScheduleDefaultDaily",
    helpFallback:
      "Cron expression for insight extraction schedule (default: daily at 2 AM)",
    keywords: ["insight", "timing"],
  },
  {
    sectionId: "memory",
    key: "memoryDreamsEnabled",
    labelKey: "settings.memory.processDreamsFromDailyMemory",
    labelFallback: " Process dreams from daily memory ",
    helpKey: "settings.memory.turnsDailyNotesIntoDREAMSMdAndPromotes",
    helpFallback:
      "Turns daily notes into DREAMS.md and promotes reusable lessons into MEMORY.md. Default: disabled.",
    keywords: ["synthesis", "consolidation"],
  },
  {
    sectionId: "memory",
    key: "memoryDreamsSchedule",
    labelKey: "settings.memory.dreamSchedule",
    labelFallback: "Dream Schedule",
    helpKey: "settings.memory.cronExpressionForDreamProcessing",
    helpFallback:
      "Cron expression for dream processing. Default: 0 4 * * * (daily at 4 AM).",
    keywords: ["timing"],
  },
];
