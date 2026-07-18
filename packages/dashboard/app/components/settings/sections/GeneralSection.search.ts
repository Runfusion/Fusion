/**
 * Search entries for the Project General section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per descriptor row the section renders, co-located so a setting and its index entry change in the same edit. Labels and help mirror the section's `t()` calls verbatim: the index matches on the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 * The section's bespoke rows are deliberately absent — the workflow pickers, built-in workflow enablement list, tracking-repo select, GitLab disclosure, and the Clear-local-data button are not descriptor rows, so they carry no `data-settings-key` anchor for a result to scroll to.
 */
import type { SettingsSearchEntry } from "../search/types";

export const generalSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "general",
    key: "taskPrefix",
    labelKey: "settings.general.taskPrefix",
    labelFallback: "Task Prefix",
    helpKey: "settings.general.prefixForNewTaskIDsEGKB",
    helpFallback: "Prefix for new task IDs (e.g. KB, PROJ). No default — unset.",
    keywords: ["task id", "identifier", "naming"],
  },
  {
    sectionId: "general",
    key: "ephemeralAgentTaskCreationPolicy",
    labelKey: "settings.general.ephemeralAgentTaskCreationPolicy",
    labelFallback: "Ephemeral agent follow-up tasks",
    helpKey: "settings.general.ephemeralAgentTaskCreationPolicyHint",
    helpFallback: "Allow creates follow-up tasks immediately. Upon validation sends a proposal to your mailbox for one-click approval. Deny rejects follow-up task creation.",
    keywords: ["follow-up", "permissions", "validation", "proposal"],
  },
  {
    sectionId: "general",
    key: "workspaceMode",
    labelKey: "settings.general.workspaceMode",
    labelFallback: " Workspace mode (multi-repo) ",
    helpKey: "settings.general.workspaceModeHint",
    helpFallback:
      "When enabled, the project root is treated as a workspace containing multiple git sub-repos. Tasks run per-sub-repo and no git repo is created at the root. Disable for single-repo projects. No default — unset (disabled).",
    keywords: ["monorepo", "polyrepo"],
  },
  {
    sectionId: "general",
    key: "allowAbsoluteFileBrowserPaths",
    labelKey: "settings.general.allowAbsoluteFileBrowserPaths",
    labelFallback: " Allow absolute file-browser paths ",
    helpKey: "settings.general.allowAbsoluteFileBrowserPathsHint",
    helpFallback:
      "When enabled, slash-prefixed paths such as /tmp can be opened in the workspace file browser. Windows drive-letter paths remain blocked, and other path validators are unchanged. Default: disabled.",
    keywords: ["outside workspace", "root paths"],
  },
  {
    sectionId: "general",
    key: "mobileNavPrimaryItems",
    labelKey: "settings.general.mobileNavPrimaryItems",
    labelFallback: "Mobile footer quick actions",
    helpKey: "settings.general.mobileNavPrimaryItemsHint",
    helpFallback: "Default: Dashboard, Tasks, Agents, Missions, Chat, Mailbox. Unselected destinations remain in More.",
    keywords: ["mobile", "footer", "navigation", "planning", "more"],
  },
  {
    sectionId: "general",
    key: "quickChatButtonMode",
    labelKey: "settings.general.quickChatLauncher",
    labelFallback: "Quick Chat launcher",
    helpKey: "settings.general.quickChatLauncherHint",
    helpFallback:
      "Choose whether Quick Chat opens from the draggable floating button, a footer button beside Terminal, or stays hidden. Default: off (hidden).",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    "FAB" is indexed as a keyword rather than left to the copy: the legacy stored key is `showQuickChatFAB`, so operators and older docs still call this the Quick Chat FAB even though the label never says it.
    */
    keywords: ["FAB", "floating action button"],
  },
  {
    sectionId: "general",
    key: "quickChatCloseOnOutsideClick",
    labelKey: "settings.general.quickChatCloseOnOutsideClick",
    labelFallback: "Close Quick Chat on outside click",
    helpKey: "settings.general.quickChatCloseOnOutsideClickHint",
    helpFallback:
      "When enabled, clicking outside the Quick Chat window closes it. Disable to keep it open until you close it explicitly. Default: enabled.",
    keywords: ["dismiss", "backdrop"],
  },
  {
    sectionId: "general",
    key: "showTaskChatsInCommonFeed",
    labelKey: "settings.general.showTaskChatsInCommonFeed",
    labelFallback: "Show task chats in common Chat feed",
    helpKey: "settings.general.showTaskChatsInCommonFeedHint",
    helpFallback:
      "When enabled, populated task-detail Chat conversations appear in the common Direct feed. Empty task chats stay hidden. Default: disabled.",
    keywords: ["planner chats", "inbox"],
  },
  {
    sectionId: "general",
    key: "chatAutoCleanupDays",
    labelKey: "settings.general.autoCleanupOldChats",
    labelFallback: "Auto-cleanup old chats",
    helpKey: "settings.general.deleteChatSessionsAndRoomsThatHaveBeen",
    helpFallback:
      "Delete chat sessions and rooms that have been idle for this many days. Default: Off.",
    keywords: ["retention", "prune", "purge"],
  },
  {
    sectionId: "general",
    key: "mailAutoCleanupDays",
    labelKey: "settings.general.autoPruneOldMail",
    labelFallback: "Auto-prune old mail",
    helpKey: "settings.general.deleteInboxOutboxMessagesOlderThanThisMany",
    helpFallback:
      "Delete inbox/outbox messages older than this many days. Default: Off. 7 days is the suggested setting.",
    keywords: ["retention", "purge", "mailbox"],
  },
  {
    sectionId: "general",
    key: "operationalLogRetentionDays",
    labelKey: "settings.general.operationalLogRetention",
    labelFallback: "Operational log retention",
    helpKey: "settings.general.loweringThisWindowMeansReliabilityMetricsChartsAnd",
    helpFallback:
      " Lowering this window means Reliability metrics/charts and the Activity feed will not show history older than the selected range. Per-task task detail history is unaffected. Default: 30 days. ",
    keywords: ["run audit", "database size", "purge", "disk"],
  },
  {
    sectionId: "general",
    key: "chatRoomRecentVerbatimMessages",
    labelKey: "settings.general.recentVerbatimRoomMessages",
    labelFallback: "Recent verbatim room messages",
    helpKey: "settings.general.numberOfMostRecentChatRoomMessagesKept",
    helpFallback:
      "Number of most-recent chat-room messages kept verbatim in the responder transcript. Older messages are compacted into a summary block. Default: 25.",
    keywords: ["context window", "history depth"],
  },
  {
    sectionId: "general",
    key: "chatRoomCompactionFetchLimit",
    labelKey: "settings.general.roomCompactionFetchLimit",
    labelFallback: "Room compaction fetch limit",
    helpKey: "settings.general.upperBoundOnMessagesFetchedFromTheRoom",
    helpFallback:
      "Upper bound on messages fetched from the room store for compaction consideration. Default: 200.",
    keywords: ["summarization", "context window"],
  },
  {
    sectionId: "general",
    key: "chatRoomSummaryMaxChars",
    labelKey: "settings.general.roomSummaryMaxCharacters",
    labelFallback: "Room summary max characters",
    helpKey: "settings.general.hardCapOnTheSynthesizedEarlierRoomContext",
    helpFallback:
      'Hard cap on the synthesized "Earlier room context" summary block. Default: 3000.',
    keywords: ["compaction", "length limit"],
  },
  {
    sectionId: "general",
    key: "capacityRiskBannerEnabled",
    labelKey: "settings.general.showCapacityRiskBanner",
    labelFallback: " Show capacity risk banner ",
    helpKey: "settings.general.warnOnTheBoardWhenTodoWorkExceeds",
    helpFallback:
      "Warn on the board when todo work exceeds the threshold and no idle agents are available. Default: disabled.",
    keywords: ["backlog warning", "overload", "alert"],
  },
  {
    sectionId: "general",
    key: "capacityRiskTodoThreshold",
    labelKey: "settings.general.todoThreshold",
    labelFallback: "Todo threshold",
    helpKey: "settings.general.bannerFiresWhenTodoCountIsStrictlyGreater",
    helpFallback:
      "Banner fires when todo count is strictly greater than this value (default 20). Applies when the banner is enabled.",
    keywords: ["capacity risk", "backlog limit"],
  },
  {
    sectionId: "general",
    key: "sessionAdvisorEnabledByDefault",
    labelKey: "settings.general.defaultSessionAdvisorForNewTasks",
    labelFallback: "Default for new tasks",
    helpKey: "settings.general.sessionAdvisorHelp",
    helpFallback:
      "Controls whether newly created tasks enable the session advisor (live LLM overseer of the executor). Individual tasks can override this from Quick Add or task detail. Also set Session advisor model provider and model id under workflow settings before the advisor can run.",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    The label is just "Default for new tasks" — it only reads as the session advisor because of the heading above it, which the index does not see. The feature's own names are keywords so a search for "session advisor" reaches the control that turns it on.
    */
    keywords: ["session advisor", "overseer", "oversight", "planner"],
  },
  {
    sectionId: "general",
    key: "githubImportAutoTranslate",
    labelKey: "settings.general.autoTranslateImportedIssues",
    labelFallback: "Auto-translate imported issues",
    helpKey: "settings.general.autoTranslateImportedIssuesHelp",
    helpFallback:
      "When enabled, the Import Tasks panel automatically translates foreign-language issue titles and bodies into the target language below and shows the translation by default. You can always switch back to the original text, and imported tasks carry the translated text. Default: disabled.",
    keywords: ["localization", "foreign language"],
  },
  {
    sectionId: "general",
    key: "importTranslateTargetLocale",
    labelKey: "settings.general.translationTargetLanguage",
    labelFallback: "Translation target language",
    helpKey: "settings.general.translationTargetLanguageHelp",
    helpFallback:
      "Language imported issues are translated into when auto-translation is enabled. No default — unset inherits the dashboard language.",
    keywords: ["locale", "localization"],
  },
];
