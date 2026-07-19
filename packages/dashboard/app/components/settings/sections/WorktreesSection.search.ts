/**
 * Search entries for the Worktrees section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per descriptor row the section renders, co-located so a setting and its index entry change in the same edit. `settings-search-index.test.ts` fails the build if a descriptor `key` here and in WorktreesSection.tsx ever diverge, which is what keeps the index honest without anyone maintaining a keyword list by hand.
 * Labels and help mirror the section's `t()` calls verbatim: the index matches on the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 * The section's bespoke controls (worktree copy-file list, worktrees directory picker, sibling-branch-rename toggle, rebase remote select, and the worktrunk block) render no descriptor rows and so carry no entries; the nav entry's own `searchableText` still surfaces the section for those.
 */
import type { SettingsSearchEntry } from "../search/types";

export const worktreesSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "worktrees",
    key: "maxWorktrees",
    labelKey: "settings.worktrees.maxWorktrees",
    labelFallback: "Max Worktrees",
    helpKey: "settings.worktrees.limitsTotalGitWorktreesIncludingInReviewTasks",
    helpFallback: "Limits total git worktrees including in-review tasks. Default: 4.",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    Concurrency vocabulary is indexed here because this key — not `maxConcurrent` — is the real task-parallelism cap (it gates in-progress worktree holders), and operators searching "concurrency" or "parallel" would otherwise land only on Scheduling.
    */
    keywords: ["concurrency", "parallel tasks", "capacity", "limit"],
  },
  {
    sectionId: "worktrees",
    key: "worktreeInitCommand",
    labelKey: "settings.worktrees.worktreeInitCommand",
    labelFallback: "Worktree Init Command",
    helpKey: "settings.worktrees.shellCommandToRunInEachNewWorktree",
    helpFallback: "Shell command to run in each new worktree after creation. No default — unset.",
    keywords: ["setup script", "bootstrap", "install dependencies", "post-create"],
  },
  {
    sectionId: "worktrees",
    key: "recycleWorktrees",
    labelKey: "settings.worktrees.recycleWorktrees",
    labelFallback: " Recycle worktrees ",
    helpKey: "settings.worktrees.offByDefaultOptInWhenEnabledCompleted",
    helpFallback:
      "Off by default (opt-in). When enabled, completed task worktrees are returned to an idle pool instead of being deleted, preserving build caches for faster startup",
    keywords: ["reuse", "warm pool"],
  },
  {
    sectionId: "worktrees",
    key: "showWorktreeGrouping",
    labelKey: "settings.worktrees.showWorktreeGrouping",
    labelFallback: " Show worktree grouping on the board ",
    helpKey: "settings.worktrees.showWorktreeGroupingHelp",
    helpFallback:
      "Off by default. When enabled, WIP and processing columns always group tasks by worktree and show worktree names, including workflow-mode processing columns.",
    keywords: ["group by", "swimlane"],
  },
  {
    sectionId: "worktrees",
    key: "worktreeNaming",
    labelKey: "settings.worktrees.worktreeNamingStyle",
    labelFallback: "Worktree Naming Style",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    Indexed against the enabled help string. The disabled variant ("not applicable when recycling") is a transient state of one checkbox, not a second setting, so indexing it would make search results read as though recycling were on.
    */
    helpKey: "settings.worktrees.howToNameFreshWorktreeDirectories",
    helpFallback: "How to name fresh worktree directories. Only applies when recycling is off. Default: random.",
    keywords: ["folder name", "directory name", "branch naming"],
  },
  {
    sectionId: "worktrees",
    key: "worktreeRebaseBeforeMerge",
    labelKey: "settings.worktrees.rebaseFromRemoteBeforeMerge",
    labelFallback: " Rebase from remote before merge ",
    helpKey: "settings.worktrees.whenEnabledTheMergerFetchesFromTheConfigured",
    helpFallback:
      "When enabled, the merger fetches from the configured remote and rebases the task branch onto the latest default-branch tip before merging — catching concurrent pushes from other collaborators or fusion workers. Any conflicts the rebase surfaces flow into the existing smart/AI resolve pipeline. Default: enabled.",
    keywords: ["pull", "up to date", "prerebase"],
  },
  {
    sectionId: "worktrees",
    key: "worktreeRebaseLocalBase",
    labelKey: "settings.worktrees.alsoRebaseOntoLocalDefaultBranchHEAD",
    labelFallback: " Also rebase onto local default-branch HEAD ",
    helpKey: "settings.worktrees.inAdditionToTheRemoteRebaseAboveAlso",
    helpFallback:
      " In addition to the remote rebase above, also rebase the task branch onto the local default-branch HEAD (rootDir). This catches sibling tasks that merged locally but haven't been pushed yet — without it, two concurrent tasks where one deletes code can have the other silently re-introduce it via the fallback strategy. Enabled by default; only disable if it causes issues with your workflow. ",
    keywords: ["main", "unpushed", "prerebase"],
  },
];
