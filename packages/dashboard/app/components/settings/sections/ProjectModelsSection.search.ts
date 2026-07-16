/**
 * Search entries for the Project Models section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per descriptor row the section renders, co-located so a setting and its index entry change in the same edit. Labels and help mirror the section's `t()` calls verbatim: the index matches on the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 * This section is the reason the index was rewritten. Operators searched "summarize" and Project Models did not surface, because the old index was a hand-written keyword list per nav entry; it was patched twice (FN-7907, then again 2026-07-14) and still only covered whatever someone had thought to type. `autoSummarizeTitles` now carries NO keywords on purpose — "Auto-summarize" is in its own label and "summarization" in its help, and both are indexed automatically. Adding "summarize" back as a keyword would restate the label and re-create the list that rotted.
 * Absent by design: the model-lane pickers, the Chat default target picker, preset CRUD and its per-size grid, and the workflow lane rows. They are bespoke widgets, not descriptor rows — there is no `data-settings-key` anchor for a result to jump to.
 */
import type { SettingsSearchEntry } from "../search/types";

export const projectModelsSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "project-models",
    key: "tokenCap",
    labelKey: "settings.projectModels.tokenCap",
    labelFallback: "Token Cap",
    helpKey: "settings.projectModels.automaticallyCompactContextWhenApproachingThisTokenCount",
    helpFallback:
      "Automatically compact context when approaching this token count. Leave empty for no cap (compact only on overflow errors). Set a number to proactively compact when reaching this token count. No default — unset (no cap).",
    keywords: ["context window", "limit", "budget"],
  },
  {
    sectionId: "project-models",
    key: "chatNewSessionMode",
    labelKey: "settings.projectModels.chatNewSessionMode",
    labelFallback: "New Chat behavior",
    helpKey: "settings.projectModels.chatNewSessionModeHelp",
    helpFallback:
      "Prompt mode opens New Chat with this default preselected. Always-default mode skips the dialog when the configured default is complete.",
    keywords: ["direct chat", "skip dialog"],
  },
  {
    sectionId: "project-models",
    key: "autoSelectModelPreset",
    labelKey: "settings.projectModels.autoSelectPresetBasedOnTaskSize",
    labelFallback: " Auto-select preset based on task size ",
    helpKey: "settings.projectModels.autoSelectModelPresetHint",
    helpFallback: "Default: disabled.",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    The help is just "Default: disabled.", so this row's only indexable copy is its label. The sizes it selects between (S/M/L) live in the grid below, which is bespoke and unindexed, hence the size keywords here.
    */
    keywords: ["small", "medium", "large", "S M L"],
  },
  {
    sectionId: "project-models",
    key: "taskDefinitionInInputLanguage",
    labelKey: "settings.projectModels.taskDefinitionInInputLanguage",
    labelFallback: "Write task definitions in the operator's input language",
    helpKey: "settings.projectModels.taskDefinitionInInputLanguageHelp",
    helpFallback:
      "When enabled, generated task-definition prose uses supported detectable input languages (Spanish, French, Korean, or Chinese as zh-CN). Headings, markers, and code stay English. Unsupported or undetectable input stays English. Default: disabled.",
    keywords: ["task definition", "prompt language", "localized prose", "Spanish", "French", "Korean", "Chinese"],
  },
  {
    sectionId: "project-models",
    key: "autoSummarizeTitles",
    labelKey: "settings.projectModels.autoSummarizeLongDescriptionsAsTitles",
    labelFallback: " Auto-summarize long descriptions as titles ",
    helpKey: "settings.projectModels.whenEnabledTasksCreatedWithoutATitleBut",
    helpFallback:
      " When enabled, tasks created without a title but with descriptions over 200 characters will automatically get an AI-generated title (max 60 characters). The same model is also used to generate fallback merge commit message bodies when the branch's commit log is empty (e.g. squash merges with no unique commits), and GitHub tracking issue titles when a tracked task has no title yet. Default: disabled. ",
  },
  {
    sectionId: "project-models",
    key: "useAiMergeCommitSummary",
    labelKey: "settings.projectModels.aIMergeCommitSummaries",
    labelFallback: " AI merge commit summaries ",
    helpKey: "settings.projectModels.whenEnabledMergeCommitMessagesIncludeAnAI",
    helpFallback:
      " When enabled, merge commit messages include an AI-generated subject plus body summary (narrative + bullets + diff-stat) instead of just listing step commit subjects. Uses the title summarization model. Default: enabled. ",
  },
  {
    sectionId: "project-models",
    key: "prTitlePromptInstructions",
    labelKey: "settings.projectModels.prTitlePromptInstructions",
    labelFallback: "PR title prompt guidance",
    helpKey: "settings.projectModels.prTitlePromptInstructionsHelp",
    helpFallback:
      "Guides the AI-generated Create PR title. Leave blank to use the default PR metadata prompt. No default — unset.",
    keywords: ["pull request", "conventional commit"],
  },
  {
    sectionId: "project-models",
    key: "prDescriptionPromptInstructions",
    labelKey: "settings.projectModels.prDescriptionPromptInstructions",
    labelFallback: "PR description prompt guidance",
    helpKey: "settings.projectModels.prDescriptionPromptInstructionsHelp",
    helpFallback:
      "Guides the AI-generated Create PR summary, changes, and testing sections. Leave blank to use the default PR metadata prompt. No default — unset.",
    keywords: ["pull request", "body"],
  },
];
