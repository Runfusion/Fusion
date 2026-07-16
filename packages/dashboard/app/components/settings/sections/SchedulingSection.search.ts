/**
 * Search entries for the Scheduling section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per descriptor row the section renders, co-located so a setting and its index entry change in the same edit. Labels and help mirror the section's `t()` calls verbatim: the index matches on the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 * The `overlapIgnorePaths` repeating-row editor, the Global/This-project scope group headers, and the moved step-execution stub are deliberately absent — they are bespoke chrome or a repeating editor, not descriptor rows.
 */
import type { SettingsSearchEntry } from "../search/types";

export const schedulingSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "scheduling",
    key: "maxConcurrent",
    labelKey: "settings.scheduling.maxConcurrentTasks",
    labelFallback: "Max Concurrent Tasks",
    helpKey: "settings.scheduling.maxConcurrentTasksHint",
    helpFallback: "Default: 2.",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    This row's help is just "Default: 2.", so the label is nearly all the index has to match on. The keywords carry the vocabulary the copy never spells out — an operator hunting for how many tasks run at once has no other way to land here.
    */
    keywords: ["parallelism", "capacity", "how many tasks at once", "agents", "cap"],
  },
  {
    sectionId: "scheduling",
    key: "maxConcurrentVerifications",
    labelKey: "settings.scheduling.maxConcurrentVerifications",
    labelFallback: "Max Concurrent Verifications",
    helpKey: "settings.scheduling.maxConcurrentVerificationsHint",
    helpFallback: "Caps stacked typecheck/build verification across tasks. Default: 1. Range: 1–8.",
    keywords: ["parallelism", "tests", "cpu", "load"],
  },
  {
    sectionId: "scheduling",
    key: "maxTriageConcurrent",
    labelKey: "settings.scheduling.maxTriageConcurrent",
    labelFallback: "Max Triage Concurrent",
    helpKey: "settings.scheduling.maximumConcurrentPlanningAgents",
    helpFallback: "Maximum concurrent planning agents. Default: 2.",
    keywords: ["parallelism", "capacity", "spec"],
  },
  {
    sectionId: "scheduling",
    key: "executorToolFailureRetryCount",
    labelKey: "settings.scheduling.executorToolFailureRetryCount",
    labelFallback: "Executor tool-failure retries",
    helpKey: "settings.scheduling.executorToolFailureRetryCountHelp",
    helpFallback: "Same-model retries after consecutive tool-call failures. Set 0 to disable. Default: 2.",
    keywords: ["executor", "tool error", "auto retry", "same model", "failure"],
  },
  {
    sectionId: "scheduling",
    key: "executorToolFailureRetryBackoffMs",
    labelKey: "settings.scheduling.executorToolFailureRetryBackoffMs",
    labelFallback: "Tool-failure retry backoff (ms)",
    helpKey: "settings.scheduling.executorToolFailureRetryBackoffMsHelp",
    helpFallback: "Unref'd wait before retrying. Default: 2000.",
    keywords: ["executor", "delay", "wait", "auto retry", "tool error"],
  },
  {
    sectionId: "scheduling",
    key: "executorToolFailureThreshold",
    labelKey: "settings.scheduling.executorToolFailureThreshold",
    labelFallback: "Consecutive tool failures",
    helpKey: "settings.scheduling.executorToolFailureThresholdHelp",
    helpFallback: "Terminal tool errors required before retrying. Default: 3.",
    keywords: ["executor", "tool error", "threshold", "auto retry"],
  },
  {
    sectionId: "scheduling",
    key: "pollIntervalMs",
    labelKey: "settings.scheduling.pollIntervalMs",
    labelFallback: "Poll Interval (ms)",
    helpKey: "settings.scheduling.pollIntervalMsHint",
    helpFallback: "Default: 15000 (15 seconds).",
    keywords: ["tick", "engine loop", "frequency", "refresh"],
  },
  {
    sectionId: "scheduling",
    key: "heartbeatScopeDiscipline",
    labelKey: "settings.scheduling.heartbeatScopeDiscipline",
    labelFallback: "Heartbeat Scope Discipline",
    helpKey: "settings.scheduling.strictCoordinationFocusedHigherPerTickTokensLite",
    helpFallback:
      "Strict — coordination-focused; higher per-tick tokens. Lite — pre-2026-05-11 behavior. Off — minimal procedure.",
    keywords: ["agent prompt", "token cost"],
  },
  {
    sectionId: "scheduling",
    key: "engineerBacklogAutoClaim",
    labelKey: "settings.scheduling.letEngineerAgentsAutoClaimBacklogTasks",
    labelFallback: " Let engineer agents auto-claim backlog tasks ",
    helpKey: "settings.scheduling.backlogNoTaskAutoClaimIsExecutorOnly",
    helpFallback:
      "Backlog/no-task auto-claim is executor-only by default. Enable to let engineer-role agents auto-claim unowned backlog tasks; explicit routing and delegation are unchanged. Default: off.",
    keywords: ["pick up work", "unassigned", "todo"],
  },
  {
    sectionId: "scheduling",
    key: "taskStuckTimeoutMs",
    labelKey: "settings.scheduling.stuckTaskTimeoutMinutes",
    labelFallback: "Stuck Task Timeout (minutes)",
    helpKey: "settings.scheduling.timeoutInMinutesForDetectingStuckTasksWhen",
    helpFallback:
      "Timeout in minutes for detecting stuck tasks. When a task's agent session shows no activity for longer than this duration, the task is terminated and retried. Leave empty to disable. Suggested: 10. Default: 10 minutes (600000ms).",
    keywords: ["hung", "frozen", "watchdog", "kill"],
  },
  {
    sectionId: "scheduling",
    key: "buildTimeoutMs",
    labelKey: "settings.scheduling.buildTimeoutMinutes",
    labelFallback: "Build/Verification Timeout (minutes)",
    helpKey: "settings.scheduling.maximumTimeInMinutesForBuildVerificationCommands",
    helpFallback:
      "Maximum time in minutes for build/verification commands before they are killed. Raise for large monorepo or Docker builds. Default: 5.",
    keywords: ["test timeout", "compile", "slow build"],
  },
  {
    sectionId: "scheduling",
    key: "staleHighFanoutBlockerAgeThresholdMs",
    labelKey: "settings.scheduling.staleHighFanOutEscalationHours",
    labelFallback: "Stale High Fan-out Escalation (hours)",
    helpKey: "settings.scheduling.escalateHighFanOutBlockersOnlyAfterThey",
    helpFallback:
      "Escalate high fan-out blockers only after they remain in in-progress or in-review for this many hours (age source: columnMovedAt, fallback updatedAt). Default: 2 hours.",
    keywords: ["dependencies", "alert", "notify"],
  },
  {
    sectionId: "scheduling",
    key: "preserveProgressOnStuckRequeue",
    labelKey: "settings.scheduling.preserveStepProgressOnStuckTaskRequeue",
    labelFallback: " Preserve step progress on stuck-task requeue ",
    helpKey: "settings.scheduling.whenTheStuckDetectorKillsAndReQueues",
    helpFallback:
      "When the stuck detector kills and re-queues a task, keep completed step statuses so the agent can resume from where it left off. Disable to reset every step to pending on each stuck retry. Default: enabled.",
    keywords: ["resume", "restart", "retry"],
  },
  {
    sectionId: "scheduling",
    key: "specStalenessEnabled",
    labelKey: "settings.scheduling.enablePlanStalenessEnforcement",
    labelFallback: " Enable plan staleness enforcement ",
    helpKey: "settings.scheduling.whenEnabledTasksWithStalePlansPROMPTMd",
    helpFallback:
      "When enabled, tasks with stale plans (PROMPT.md older than the threshold) are automatically sent back to planning for replanning. Default: disabled.",
    keywords: ["spec", "replan", "outdated"],
  },
  {
    sectionId: "scheduling",
    key: "specStalenessMaxAgeMs",
    labelKey: "settings.scheduling.staleSpecThresholdHours",
    labelFallback: "Stale Spec Threshold (hours)",
    helpKey: "settings.scheduling.maximumAgeInHoursBeforeAPlanIs",
    helpFallback: "Maximum age in hours before a plan is considered stale. Default: 6 hours.",
    keywords: ["PROMPT.md", "replan", "age"],
  },
  {
    sectionId: "scheduling",
    key: "autoArchiveDoneTasksEnabled",
    labelKey: "settings.scheduling.enableAutomaticTaskArchiving",
    labelFallback: " Enable automatic task archiving ",
    helpKey: "settings.scheduling.completedTasksOlderThanTheThresholdAreMoved",
    helpFallback:
      "Completed tasks older than the threshold are moved out of the active task database. Default: enabled.",
    keywords: ["done column", "cleanup", "prune", "board clutter"],
  },
  {
    sectionId: "scheduling",
    key: "autoArchiveDoneAfterMs",
    labelKey: "settings.scheduling.archiveCompletedTasksAfterDays",
    labelFallback: "Archive Completed Tasks After (days)",
    helpKey: "settings.scheduling.numberOfDaysATaskCanStayIn",
    helpFallback:
      "Number of days a task can stay in Done before it is archived. Default: 2 days (48 hours).",
    keywords: ["retention", "cleanup", "age"],
  },
  {
    sectionId: "scheduling",
    key: "archiveAgentLogMode",
    labelKey: "settings.scheduling.archiveAgentLog",
    labelFallback: "Archive Agent Log",
    helpKey: "settings.scheduling.compactModeKeepsArchiveSizeLowWhilePreserving",
    helpFallback:
      "Compact mode keeps archive size low while preserving recent agent activity for context. Default: compact.",
    keywords: ["history", "transcript", "disk space", "retention"],
  },
  {
    sectionId: "scheduling",
    key: "autoArchiveDuplicateTasksEnabled",
    labelKey: "settings.scheduling.autoArchiveDuplicateTasks",
    labelFallback: " Automatically archive duplicate tasks ",
    helpKey: "settings.scheduling.autoArchiveDuplicateTasksHelp",
    helpFallback:
      "Automatically archive tasks detected as same-agent duplicates on creation (off by default). When disabled, duplicates are flagged in place with the yellow Duplicate chip and Keep/Archive actions instead of being archived automatically.",
    keywords: ["near duplicate", "dedupe", "repeat"],
  },
  {
    sectionId: "scheduling",
    key: "maxStuckKills",
    labelKey: "settings.scheduling.maxStuckRetries",
    labelFallback: "Max Stuck Retries",
    helpKey: "settings.scheduling.maximumStuckDetectorRetriesBeforeATaskIs",
    helpFallback: "Maximum stuck-detector retries before a task is marked failed. Default: 6.",
    keywords: ["give up", "attempts", "hung"],
  },
  {
    sectionId: "scheduling",
    key: "groupOverlappingFiles",
    labelKey: "settings.scheduling.serializeTasksWithOverlappingFiles",
    labelFallback: " Serialize tasks with overlapping files ",
    helpKey: "settings.scheduling.whenEnabledTasksThatModifyTheSameFiles",
    helpFallback:
      "When enabled, tasks that modify the same files are queued serially to avoid merge conflicts. Default: enabled.",
    keywords: ["file scope", "collision", "queue", "lease"],
  },
  {
    sectionId: "scheduling",
    key: "ignoreHiddenOverlapPaths",
    labelKey: "settings.scheduling.ignoreHiddenDotPathsInOverlapChecks",
    labelFallback: " Ignore hidden dot paths in overlap checks ",
    helpKey: "settings.scheduling.ignoreHiddenDotPathsHelp",
    helpFallback:
      "When enabled, overlap checks ignore hidden path segments such as .fusion/, .changeset/, .github/, .env, and nested .cache/ directories. Uncheck to restore legacy counting for stricter serialization. Default: enabled.",
    keywords: ["dotfiles", "collision", "file scope"],
  },
];
