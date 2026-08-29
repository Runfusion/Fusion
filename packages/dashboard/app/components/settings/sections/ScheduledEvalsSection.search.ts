/**
 * Search entries for the Scheduled Evals section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per descriptor row the section renders, co-located so a setting and its index entry change in the same edit. Labels and help mirror the section's `t()` calls verbatim — search matches the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 * Keys are the dotted `evalSettings.*` paths the section's descriptors declare: the index matches on `key` as the row's scroll anchor, so it must be the same string the descriptor renders, not the enclosing blob name.
 */
import type { SettingsSearchEntry } from "../search/types";

export const scheduledEvalsSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "scheduled-evals",
    key: "evalSettings.enabled",
    labelKey: "settings.scheduledEvals.enableScheduledEvalRunsForThisProject",
    labelFallback: " Enable scheduled eval runs for this project ",
    helpKey: "settings.scheduledEvals.enabledHint",
    helpFallback: "Default: disabled.",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    "eval" is the product's word; operators arriving from the quality side search "evaluation" or "benchmark", neither of which appears in this control's copy.
    */
    keywords: ["evaluation", "benchmark", "quality"],
  },
  {
    sectionId: "scheduled-evals",
    key: "evalSettings.intervalMs",
    labelKey: "settings.scheduledEvals.intervalMs",
    labelFallback: "Interval (ms)",
    helpKey: "settings.scheduledEvals.intervalMsHint",
    helpFallback: "Default: 86400000 (24 hours).",
    keywords: ["frequency", "how often", "schedule"],
  },
  {
    sectionId: "scheduled-evals",
    key: "evalSettings.evaluatorProvider",
    labelKey: "settings.scheduledEvals.evaluatorProvider",
    labelFallback: "Evaluator Provider",
    helpKey: "settings.scheduledEvals.evaluatorProviderHint",
    helpFallback: "No default — unset (inherits the project validator lane provider).",
  },
  {
    sectionId: "scheduled-evals",
    key: "evalSettings.evaluatorModelId",
    labelKey: "settings.scheduledEvals.evaluatorModel",
    labelFallback: "Evaluator Model",
    helpKey: "settings.scheduledEvals.leaveProviderAndModelBlankToInheritThe",
    helpFallback:
      " Leave provider and model blank to inherit the project validator lane model settings. No default — unset. ",
  },
  {
    sectionId: "scheduled-evals",
    key: "evalSettings.followUpPolicy",
    labelKey: "settings.scheduledEvals.followUpPolicy",
    labelFallback: "Follow-up Policy",
    helpKey: "settings.scheduledEvals.followUpPolicyHint",
    helpFallback: "Default: suggest only.",
    keywords: ["auto-create tasks", "suggestions"],
  },
  {
    sectionId: "scheduled-evals",
    key: "evalSettings.retentionDays",
    labelKey: "settings.scheduledEvals.retentionDays",
    labelFallback: "Retention (days)",
    helpKey: "settings.scheduledEvals.retentionDaysHint",
    helpFallback: "Default: 30.",
    keywords: ["prune", "cleanup", "history"],
  },
];
