import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_SETTINGS, DEFAULT_PROJECT_SETTINGS, DEFAULT_SETTINGS } from "@fusion/core";
import realEnApp from "../../../../../../i18n/locales/en/app.json";

/*
 * FNXC:SettingsDefaults 2026-07-04-00:00:
 * FN-7505 requires every user-editable setting surfaced in the dashboard Settings
 * UI to state its DEFAULT VALUE (or "inherits global" / "no default \u2014 unset")
 * in its description/help text. This guard test encodes the invariant two ways:
 *
 * 1. `SETTING_DESCRIPTION_KEYS` maps each surfaced setting key to the i18n
 *    `settings.<section>.<key>` description path whose resolved English string
 *    must mention a default-value indicator (`Default:`, `inherits`, `No default`,
 *    or a rendered `(default)` option tag). Adding a new surfaced setting without
 *    adding it here (or to `NOT_SURFACED_ALLOWLIST` with a reason) fails this test.
 * 2. `NOT_SURFACED_ALLOWLIST` documents every `DEFAULT_SETTINGS` key that is NOT
 *    a plain user-editable Settings UI field (moved-to-workflow-settings keys,
 *    internal/engine bookkeeping, nested config editors delegated to components
 *    outside `settings/sections/`, session/runtime state, etc.) with a one-line
 *    reason each, so a genuinely new setting cannot silently skip documentation.
 *
 * Source of truth for canonical default values: `DEFAULT_GLOBAL_SETTINGS` /
 * `DEFAULT_PROJECT_SETTINGS` / `DEFAULT_SETTINGS` in `packages/core/src/config/settings-schema.ts`.
 * See task document "plan" on FN-7505 for the full field \u2192 default \u2192 i18n-key table.
 */

type SettingsDict = Record<string, unknown>;

function resolveDescription(dict: SettingsDict, dottedPath: string): string | undefined {
  const parts = dottedPath.split(".");
  let node: unknown = dict;
  for (const part of parts) {
    if (node == null || typeof node !== "object") return undefined;
    node = (node as SettingsDict)[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** Regex matching any of the accepted default-value phrasings for FN-7505. */
const DEFAULT_INDICATOR_RE = /default|inherits|unset/i;

/**
 * FNXC:SettingsDefaults 2026-07-04-00:00:
 * FN-7505 code review caught GlobalGeneralSection/GeneralSection/MergeSection stating
 * `gitlabEnabled` defaults to "enabled" and GlobalModelsSection stating
 * `openrouterAppAttribution` defaults to a literal URL/title, when both are actually
 * `undefined` in DEFAULT_GLOBAL_SETTINGS/DEFAULT_PROJECT_SETTINGS (`packages/core/src/config/settings-schema.ts`).
 * A generic "mentions the word default" check cannot catch a WRONG default value, only
 * a missing one. `resolveCanonicalDefault` + the checks in the third `it()` below assert
 * the description's stated default agrees with the actual schema default for every mapped
 * setting: booleans must state the correct enabled/disabled (and never the opposite), and
 * settings whose canonical default is `undefined` must say so ("no default"/"inherits")
 * rather than fabricating a concrete enabled/disabled/value claim.
 */
function resolveCanonicalDefault(settingKey: string): unknown {
  const globalDict = DEFAULT_GLOBAL_SETTINGS as SettingsDict;
  const projectDict = DEFAULT_PROJECT_SETTINGS as SettingsDict;
  const mergedDict = DEFAULT_SETTINGS as unknown as SettingsDict;
  if (settingKey in globalDict) return globalDict[settingKey];
  if (settingKey in projectDict) return projectDict[settingKey];
  return mergedDict[settingKey];
}

/**
 * Maps every surfaced user-editable setting key to the i18n path (under the
 * `settings` namespace in `packages/i18n/locales/en/app.json`) whose resolved
 * English description states that setting's default value.
 */
const SETTING_DESCRIPTION_KEYS: Record<string, string> = {
  githubNativeAutoMerge: "merge.githubNativeAutoMergeHelp",
  requiredChecks: "merge.requiredChecksHelp",
  // AuthenticationSection — Anthropic dual-credential precedence (default api-key)
  anthropicAuthPreference: "auth.anthropicPreferenceHint",
  // GlobalGeneralSection
  githubTrackingDefaultRepo: "globalGeneral.projectsInheritThisValueWhenTheyDoNot",
  gitlabEnabled: "merge.gitLabAuthDetails",
  gitlabInstanceUrl: "globalGeneral.gitLabInstanceUrlHint",
  jiraEnabled: "jira.enabledHelp",
  jiraBaseUrl: "jira.baseUrlHelp",
  jiraApiBaseUrl: "jira.apiBaseUrlHelp",
  jiraAuthEmail: "jira.emailHelp",
  jiraAuthTokenSecretKey: "jira.secretHelp",
  jiraAuthTokenSecretScope: "jira.scopeHelp",
  jiraBranchNameTemplate: "jira.templateHelp",
  gitlabApiBaseUrl: "globalGeneral.gitLabApiBaseUrlHint",
  gitlabAuthTokenType: "globalGeneral.gitLabTokenTypeHint",
  gitlabAuthToken: "globalGeneral.gitLabAuthTokenHint",
  dismissModalsOnOutsideClick: "globalGeneral.dismissModalsByClickingOutsideHint",
  skipConfirmationDialogs: "globalGeneral.skipConfirmationDialogsHint",
  quickAddSubmitOnEnter: "globalGeneral.quickAddSubmitOnEnterHint",
  chatSubmitOnEnter: "globalGeneral.chatSubmitOnEnterHint",
  persistAgentToolOutput: "globalGeneral.whenDisabledToolRowsAreStillLoggedBut",
  agentToolOutputMaxChars: "globalGeneral.agentToolOutputLimitHint",
  proactiveTaskChatEnabled: "globalGeneral.enableProactiveTaskChatHint",
  persistAgentThinkingLogPermanent: "globalGeneral.rowsAndDoesNotAffectAssistantTextOr",
  persistAgentThinkingLogEphemeral: "globalGeneral.rowsAndDoesNotAffectAssistantTextOr",
  fnBinaryCheckEnabled: "globalGeneral.disableThisIfYourLocalDevProcessIs",
  updateCheckEnabled: "globalGeneral.andShowsUpdateNoticesInTheCLIAnd",
  updateCheckFrequency: "globalGeneral.controlsHowOftenTheDashboardReFetchesThe",
  updateChannel: "globalGeneral.releaseChannelHelp",
  autoUpdateAndRestart: "globalGeneral.autoUpdateAndRestartHelp",
  autoUpdateEnabled: "globalGeneral.autoUpdateEnabledHelp",
  autoRestartAfterUpdate: "globalGeneral.autoRestartAfterUpdateHelp",
  // AppearanceSection
  chatMessageLayout: "appearance.chatMessageLayoutHelp",
  openTasksInRightSidebar: "appearance.openTasksInRightSidebarHelp",
  openMobileTasksInPopup: "appearance.openMobileTasksInPopupHelp",
  taskPopupsBoardListOnly: "appearance.taskPopupsBoardListOnlyHelp",
  showCostBadgeOnCards: "appearance.showCostBadgeOnCardsHelp",
  taskDetailChatFirst: "appearance.taskDetailChatFirstHelp",
  // AgentPermissionsSection
  defaultAgentPermissionPolicy: "agentPermissions.perAgentSettingsOverrideProjectDefaultsEachCategory",
  agentProvisioning: "agentPermissions.configureProjectLevelApprovalBehaviorForDurableProvisioning",
  // GlobalModelsSection
  defaultProvider: "globalModels.defaultAIModelUsedForTaskExecutionWhen",
  defaultModelId: "globalModels.defaultAIModelUsedForTaskExecutionWhen",
  fallbackProvider: "globalModels.usedAutomaticallyIfThePrimaryDefaultModelHits",
  fallbackModelId: "globalModels.usedAutomaticallyIfThePrimaryDefaultModelHits",
  defaultThinkingLevel: "globalModels.controlsHowMuchReasoningEffortTheAIModel",
  openrouterModelSync: "globalModels.whenEnabledStartupFetchesTheLatestAvailableModels",
  opencodeGoModelSync: "globalModels.flowAndPublishesThemUnderTheOpencodeGo",
  /* FNXC:SettingsHelp 2026-08-23-20:45: OrcaRouter catalog sync ships its own SettingsToggleRow help in GlobalModelsSection. */
  orcarouterModelSync: "globalModels.whenEnabledStartupFetchesTheLatestOrcaRouterModels",
  openrouterAppAttribution: "globalModels.leaveEmptyToOmitThisHeaderDefaultHttps",
  openrouterModelFilters: "globalModels.commaSeparatedValuesSentToOpenRouterModelSync",
  openrouterProviderPreferences: "globalModels.openRouterRoutingOrderHint",
  // McpServersCard (global + project MCP sections)
  mcpServers: "mcp.enabledHint",
  // NodeSyncSection
  settingsSyncEnabled: "nodeSync.automaticallySynchronizeSettingsBetweenThisNodeAndConnected",
  settingsSyncAuth: "nodeSync.includeAPIKeysAndOAuthTokensInSync",
  settingsSyncInterval: "nodeSync.syncIntervalHint",
  settingsSyncConflictResolution: "nodeSync.conflictResolutionHint",
  // NodeRoutingSection
  defaultNodeId: "nodeRouting.usedWhenATaskHasNoNodeOverride",
  unavailableNodePolicy: "nodeRouting.unavailableNodePolicyHint",
  // ResearchGlobalSection
  researchGlobalSearxngUrl: "researchGlobal.searXNGURLHint",
  researchGlobalGoogleSearchApiKey: "researchGlobal.googleSearchCXHint",
  researchGlobalGoogleSearchCx: "researchGlobal.googleSearchCXHint",
  researchGlobalMaxConcurrentRuns: "researchGlobal.maxConcurrentRunsHint",
  researchGlobalMaxSourcesPerRun: "researchGlobal.maxSourcesPerRunHint",
  researchGlobalDefaultTimeout: "researchGlobal.defaultMaxDurationMsHint",
  researchGlobalFetchTimeoutMs: "researchGlobal.requestTimeoutMsHint",
  researchGlobalMaxSynthesisRounds: "researchGlobal.maxSynthesisRoundsHint",
  researchGlobalGitHubEnabled: "researchGlobal.gitHubSourceHint",
  researchGlobalLocalDocsEnabled: "researchGlobal.localDocsSourceHint",
  researchGlobalWebSearchProvider: "researchGlobal.searchesAndFetchesUseTheAgentsNativeWebSearch",
  // NotificationsSection
  /*
   * FNXC:SettingsDefaults 2026-07-16-10:05:
   * FN-8216 classifies the NotificationsSection clarification checkbox and SchedulingSection
   * duplicate-resolution select as surfaced fields: their existing help text states each default.
   */
  agentClarificationEnabled: "notifications.agentClarificationHint",
  failureNotificationDelayMs: "notifications.howLongAFailureMustPersistBeforeA",
  wedgeNotificationSettleMs: "notifications.wedgeNotificationSettleMsHelp",
  failureNotificationMode: "notifications.stickyFailuresOnlyDefault",
  ntfyEnabled: "notifications.ntfyEnabledHint",
  ntfyTopic: "notifications.yourNtfyShTopicName164Alphanumeric",
  ntfyBaseUrl: "notifications.leaveBlankToKeepTheDefaultServerHttps",
  ntfyAccessToken: "notifications.leaveBlankToPublishWithoutAuthenticationWhenSet",
  ntfyDashboardHost: "notifications.baseURLForDeepLinksInNotificationsWhen",
  webhookEnabled: "notifications.webhookEnabledHint",
  webhookUrl: "notifications.webhookUrlHint",
  webhookFormat: "notifications.webhookFormatHint",
  // RemoteSection
  remoteAccess: "remote.acceptRoutesHint",
  // ExperimentalSection
  experimentalFeatures: "experimental.experimentalFeaturesAreEarlyCapabilitiesThatAreNot",
  // CommandsSection
  testCommand: "commands.commandUsedToRunTestsInjectedIntoGenerated",
  buildCommand: "commands.commandUsedToBuildTheProjectInjectedInto",
  // PromptsSection
  agentPrompts: "prompts.surfaceExplanation",
  promptOverrides: "prompts.surfaceExplanation",
  // BackupsSection
  autoBackupEnabled: "backups.whenEnabledTheDatabaseIsBackedUpAutomatically",
  autoBackupSchedule: "backups.cronExpressionForBackupTimingDefault02",
  autoBackupRetention: "backups.numberOfBackupFilesToKeepOldestAre",
  autoBackupDir: "backups.directoryForBackupFilesRelativeToProjectRoot",
  memoryBackupEnabled: "backups.whenEnabledProjectAndAgentMemoryFilesAre",
  memoryBackupSchedule: "backups.cronExpressionForMemoryBackupTimingDefault0",
  memoryBackupRetention: "backups.numberOfMemoryBackupsToKeepOldestAre",
  memoryBackupDir: "backups.directoryForMemoryBackupsRelativeToProjectRoot",
  memoryBackupScope: "backups.memoryBackupScopeHint",
  /*
  FNXC:SettingsDefaults 2026-07-17-13:55:
  FN-8335 restores FN-7505 default-value parity for the surfaced embeddedPostgresMaxConnections
  control. Issue #2411 made the schema default undefined (server resolves win32 150 / else 500),
  so the canonical English copy now uses unset phrasing ("Unset by default — Fusion picks …")
  and must not make a concrete "Default:" colon claim.
  */
  embeddedPostgresMaxConnections: "database.embeddedConnectionCapHelp",
  // MemorySection
  memoryEnabled: "memory.agentsGetMemorySearchMemoryGetAndMemory",
  memoryAutoSummarizeEnabled: "memory.automaticallyCompactMemoryWhenItExceedsTheThreshold",
  memoryAutoSummarizeThresholdChars: "memory.memoryWillBeCompactedWhenItExceedsThis",
  memoryAutoSummarizeSchedule: "memory.cronExpressionForAutoSummarizeScheduleDefaultDaily",
  memoryDreamsEnabled: "memory.turnsDailyNotesIntoDREAMSMdAndPromotes",
  memoryDreamsSchedule: "memory.cronExpressionForDreamProcessing",
  memoryBackendType: "memory.agentsGetMemorySearchMemoryGetAndMemory",
  stashUrl: "memory.stashUrlHelp",
  /*
  FNXC:StashSessionCapture 2026-08-19-05:09:
  (RUFU-122) Task-terminal transcript upload controls (Stash backend only).
  */
  executorSessionCaptureEnabled: "memory.uploadTaskAgentLogTranscriptToStash",
  executorSessionCaptureMaxEvents: "memory.capOnTranscriptEventsUploadedPerTask",
  // MergeSection
  autoMerge: "merge.whenEnabledTasksThatPassReviewAreAutomatically",
  // FN-7557: planApprovalMode defaults to auto-approve-all; the "(default)" marker moved to the auto-approve option.
  planApprovalMode: "merge.planApprovalModeAutoApproveAll",
  maxAutoMergeRetries: "merge.positiveIntegerRetryCapForAutoMergeConflict",
  merger: "merge.dangerousCompatibilityEscapeHatchLeaveOffUnlessYou",
  testMode: "merge.forcesAllAILanesToUseTheDeterministic",
  mergeStrategy: "merge.directMergeIntoTheCurrentBranch",
  integrationBranch: "merge.theCanonicalBranchFusionMergesTasksIntoAnd",
  directMergeCommitStrategy: "merge.alwaysSquashDirectMerges",
  mergeIntegrationWorktree: "merge.reuseTaskWorktreeDefault",
  mergeAdvanceAutoSync: "merge.stashFastForwardDefaultPreserveLocalEdits",
  githubAuthMode: "merge.gitHubCLIGhAuth",
  githubAuthToken: "merge.githubAuthTokenHint",
  includeTaskIdInCommit: "merge.includeTaskIdInCommitDefault",
  commitAuthorEnabled: "merge.trailerCreditingFusionRecognizedByGitHubForShared",
  commitAuthorName: "merge.trailer",
  commitAuthorEmail: "merge.trailerEmail",
  autoResolveConflicts: "merge.whenEnabledLockFilesPackageLockJsonPnpm",
  smartConflictResolution: "merge.whenEnabledLockFilesPackageLockJsonPnpm2",
  mergeConflictStrategy: "merge.smartPreferMainOnFallbackFetchFfOrigin",
  mergeStrategyOverlapBehavior: "merge.flipOverlappingFilesToPreferTheTaskBranch",
  postMergeAuditMode: "merge.warnDefaultLogFindingsContinue",
  pushAfterMerge: "merge.whenEnabledTheMergedResultIsAutomaticallyPushed",
  pushRemote: "merge.gitRemoteToPushToEGOrigin",
  // NodeRouting / node sync covered above
  // SchedulingSection
  maxConcurrent: "scheduling.maxConcurrentTasksHint",
  maxConcurrentVerifications: "scheduling.maxConcurrentVerificationsHint",
  pollIntervalMs: "scheduling.pollIntervalMsHint",
  heartbeatScopeDiscipline: "scheduling.strictDefault",
  engineerBacklogAutoClaim: "scheduling.backlogNoTaskAutoClaimIsExecutorOnly",
  executorToolFailureRetryCount: "scheduling.executorToolFailureRetryCountHelp",
  executorToolFailureRetryBackoffMs: "scheduling.executorToolFailureRetryBackoffMsHelp",
  executorToolFailureThreshold: "scheduling.executorToolFailureThresholdHelp",
  executorModelEscalationEnabled: "scheduling.executorModelEscalationEnabledHelp",
  executorEscalationProvider: "projectModels.executorEscalationModelHelp",
  executorEscalationModelId: "projectModels.executorEscalationModelHelp",
  executorEscalationNodeId: "scheduling.executorEscalationNodeIdHelp",
  taskStuckTimeoutMs: "scheduling.timeoutInMinutesForDetectingStuckTasksWhen",
  staleHighFanoutBlockerAgeThresholdMs: "scheduling.escalateHighFanOutBlockersOnlyAfterThey",
  preserveProgressOnStuckRequeue: "scheduling.whenTheStuckDetectorKillsAndReQueues",
  specStalenessEnabled: "scheduling.whenEnabledTasksWithStalePlansPROMPTMd",
  specStalenessMaxAgeMs: "scheduling.maximumAgeInHoursBeforeAPlanIs",
  triageDuplicateResolution: "scheduling.triageDuplicateResolutionHelp",
  maxStuckKills: "scheduling.maximumStuckDetectorRetriesBeforeATaskIs",
  groupOverlappingFiles: "scheduling.whenEnabledTasksThatModifyTheSameFiles",
  ignoreHiddenOverlapPaths: "scheduling.ignoreHiddenDotPathsHelp",
  overlapIgnorePaths: "scheduling.optionalFileOrDirectoryPathsToIgnoreWhen",
  // WorktreesSection
  maxWorktrees: "worktrees.limitsTotalGitWorktreesIncludingInReviewTasks",
  worktreeLimitEnabled: "worktrees.worktreeLimitEnabledHelp",
  worktreeInitCommand: "worktrees.shellCommandToRunInEachNewWorktree",
  showWorktreeGrouping: "worktrees.showWorktreeGroupingHelp",
  worktreeCopyFiles: "worktrees.copyFilesHelp",
  executorAllowSiblingBranchRename: "worktrees.andCanHidePriorCommitsFromTheDefault",
  worktreesDir: "worktrees.whenUnsetOnlyAffectsNewlyCreatedWorktrees",
  worktreeRebaseBeforeMerge: "worktrees.whenEnabledTheMergerFetchesFromTheConfigured",
  worktreeRebaseRemote: "worktrees.whichRemoteToFetchForThePreMerge",
  worktreeRebaseLocalBase: "worktrees.inAdditionToTheRemoteRebaseAboveAlso",
  worktrunk: "worktrees.disabledByDefaultOptInWhenEnabledFusion",
  // GeneralSection (project)
  allowAbsoluteFileBrowserPaths: "general.allowAbsoluteFileBrowserPathsHint",
  capacityRiskBannerEnabled: "general.warnOnTheBoardWhenTodoWorkExceeds",
  capacityRiskTodoThreshold: "general.bannerFiresWhenTodoCountIsStrictlyGreater",
  chatAutoCleanupDays: "general.deleteChatSessionsAndRoomsThatHaveBeen",
  chatRoomCompactionFetchLimit: "general.upperBoundOnMessagesFetchedFromTheRoom",
  chatRoomRecentVerbatimMessages: "general.numberOfMostRecentChatRoomMessagesKept",
  chatRoomSummaryMaxChars: "general.hardCapOnTheSynthesizedEarlierRoomContext",
  completionDocumentationMode: "general.workflowsOrChangelogModeWhenContributorsShouldUpdate",
  reviewArtifacts: "general.reviewArtifactsHint",
  ephemeralAgentTaskCreationPolicy: "general.ephemeralAgentTaskCreationPolicyHint",
  githubLinkImportedIssuesToTracking: "general.whenEnabledImportedGitHubIssuesUseTheirSource",
  // FNXC:GitHubImportTranslate 2026-07-15-09:30: surfaced as plain rows in
  // GeneralSection beside the other import-scoped GitHub settings.
  githubImportAutoTranslate: "general.autoTranslateImportedIssuesHelp",
  importTranslateTargetLocale: "general.translationTargetLanguageHelp",
  /*
  FNXC:SettingsDefaults 2026-07-17-13:55:
  FN-8335 restores FN-7505 default-value parity for the surfaced reportMode and reportModeByAction
  controls. reportMode states the draft-review default; undefined per-action overrides state that unset actions inherit it.
  */
  reportTarget: "general.reportTargetHelp",
  reportTargetByAction: "general.reportTargetByActionHelp",
  reportDiscussionCategory: "general.reportDiscussionCategoryHelp",
  reportMode: "general.reportModeHelp",
  reportModeByAction: "general.reportModeByActionHelp",
  reportRoadmapDedupeEnabled: "globalGeneral.reportRoadmapDedupeEnabledHelp",
  reportRoadmapLabel: "globalGeneral.reportRoadmapLabelHelp",
  reportRoadmapRepo: "globalGeneral.reportRoadmapRepoHelp",
  githubTrackingDedupEnabled: "general.whenEnabledFusionChecksOpenAndClosedIssues",
  githubTrackingEnabledByDefault: "general.offDefault",
  sessionAdvisorEnabledByDefault: "general.offDefault",
  mailAutoCleanupDays: "general.deleteInboxOutboxMessagesOlderThanThisMany",
  operationalLogRetentionDays: "general.loweringThisWindowMeansReliabilityMetricsChartsAnd",
  quickChatButtonMode: "general.quickChatLauncherHint",
  mobileNavPrimaryItems: "general.mobileNavPrimaryItemsHint",
  quickChatCloseOnOutsideClick: "general.quickChatCloseOnOutsideClickHint",
  showTaskChatsInCommonFeed: "general.showTaskChatsInCommonFeedHint",
  taskPrefix: "general.prefixForNewTaskIDsEGKB",
  maxRecommendationsPerTask: "general.maxRecommendationsPerTaskHelp",
  requireTaskRecommendations: "general.requireTaskRecommendationsHelp",
  recommendationMailboxNoticeEnabled: "general.recommendationMailboxNoticeEnabledHelp",
  workspaceMode: "general.workspaceModeHint",
  defaultWorkflowId: "general.newTasksInheritThisCustomWorkflowsStepsOverridable",
  enabledBuiltinWorkflowIds: "general.disabledFusionWorkflowsAreHiddenFromWorkflow",
  aiUndoTaskWorkflowId: "general.aiUndoTaskWorkflowHelp",
  // FNXC:OriginWorkflowSelection 2026-07-26-19:40: both default to unset = "Selected workflow".
  taskCreateWorkflowId: "general.taskCreateWorkflowHelp",
  refinementTaskWorkflowId: "general.refinementTaskWorkflowHelp",
  // ProjectModelsSection
  autoSelectModelPreset: "projectModels.autoSelectModelPresetHint",
  autoSummarizeTitles: "projectModels.whenEnabledTasksCreatedWithoutATitleBut",
  taskOutputLanguage: "projectModels.taskOutputLanguageHelp",
  defaultPresetBySize: "projectModels.autoSelectModelPresetHint",
  modelPresets: "projectModels.autoSelectModelPresetHint",
  prDescriptionPromptInstructions: "projectModels.prDescriptionPromptInstructionsHelp",
  prTitlePromptInstructions: "projectModels.prTitlePromptInstructionsHelp",
  tokenCap: "projectModels.automaticallyCompactContextWhenApproachingThisTokenCount",
  useAiMergeCommitSummary: "projectModels.whenEnabledMergeCommitMessagesIncludeAnAI",
  // Model pricing
  modelPricingOverrides: "modelPricing.description",
  // ResearchProjectSection
  researchSettings: "researchProject.enableResearchInThisProjectHint",
  // ScheduledEvalsSection
  evalSettings: "scheduledEvals.enabledHint",
};

/** Setting keys intentionally not surfaced as a plain Settings UI description field, with reasons. */
const NOT_SURFACED_ALLOWLIST: Record<string, string> = {
  // FNXC:TaskOutputLanguage 2026-08-19-14:56: Legacy compatibility remains persisted but hidden behind the three-mode selector.
  taskDefinitionInInputLanguage: "legacy task-output-language compatibility flag, not a rendered Settings field",
  // FNXC:GitHubStarPrompt 2026-08-24-00:34: Internal dismissal timestamp written by useGitHubStarPrompt when the operator dismisses the star ask; runtime bookkeeping state, not a user-editable Settings field.
  githubStarPromptDismissedAt: "internal star-prompt dismissal timestamp written by useGitHubStarPrompt; not a rendered Settings field",
  /*
  FNXC:OriginWorkflowSelection 2026-07-26-19:40:
  Server-side mirror of the operator's Board workflow lane, written by the dashboard
  whenever the lane changes so non-browser callers can resolve the "Selected workflow"
  option. It is UI state echoed into settings, not a user-editable Settings field —
  there is deliberately no picker for it, so it has no description to document.
  */
  boardSelectedWorkflowId: "Board lane mirror written by the dashboard; not a user-editable Settings field",
  // Legacy compatibility input; GeneralSection exposes its policy replacement instead.
  ephemeralAgentsCanCreateTasks: "legacy compatibility input replaced by ephemeralAgentTaskCreationPolicy",
  // Global-only serve/dashboard LAN discovery switch; no Settings UI description field exists.
  localNetworkDiscoveryEnabled: "global-only LAN discovery runtime switch",
  /*
  FNXC:VoiceInput 2026-07-25-09:05:
  Nested Voice Input settings object. DEFAULT_SETTINGS stores voiceInput as undefined
  (opt-in object); the VoiceInputSection enable toggle documents Default: off for the
  nested enabled flag rather than a top-level plain description field.
  */
  voiceInput: "nested Voice Input section object; enable toggle owns Default: off for voiceInput.enabled",
  /*
  FNXC:StashVectorSearch 2026-08-21-13:35:
  RUFU-146 review (PRRT_kwDOSA-8Y86a7RZs): the duplicate earlier stashApiKey
  allowlist entry was removed — NOT_SURFACED_ALLOWLIST carried the key twice
  (the second entry silently overrode the first); the single remaining entry
  below is the more complete one.
  */
  // FNXC:StashVectorSearch 2026-08-20-16:32:
  // (RUFU-126) schema-only vector search toggle with no Settings UI row
  // (same treatment as stashApiKey below): config-file-managed knob for the
  // Stash backend, which is inert without a stashUrl anyway. Registered here
  // so the FN-7505 guard does not flag the RUFU-126 schema addition.
  stashVectorSearch: "RUFU-126 schema-only Stash vector search toggle; no Settings UI row",
  /*
  FNXC:StashSessionCapture 2026-08-19-05:09:
  (RUFU-122) Schema-only transcript flag: when enabled, status entries are
  included in the uploaded agent-log transcript. Deliberately rendered as NO
  Settings row (operator-managed via the config file), so there is no
  user-editable description field to document.
  */
  executorSessionCaptureIncludeStatus: "schema-only transcript flag (status-entry inclusion); deliberately not rendered as a Settings row",
  // Moved to workflow settings (U4) — see MOVED_SETTINGS_KEYS in `packages/core/src/config/settings-schema.ts`.
  workflowStepTimeoutMs: "moved to workflow settings (U4)",
  workflowStepScopeEnforcement: "moved to workflow settings (U4)",
  planOnlyScopeLeakEnforcement: "moved to workflow settings (U4)",
  workflowRevisionForkOnScopeMismatch: "moved to workflow settings (U4)",
  strictScopeEnforcement: "moved to workflow settings (U4)",
  runStepsInNewSessions: "moved to workflow settings (U4)",
  maxParallelSteps: "moved to workflow settings (U4)",
  buildRetryCount: "moved to workflow settings (U4)",
  verificationFixRetries: "moved to workflow settings (U4)",
  maxPostReviewFixes: "moved to workflow settings (U4)",
  requirePrApproval: "moved to workflow settings (U4)",
  requirePlanApproval: "moved to workflow settings (U4)",
  reviewHandoffPolicy: "moved to workflow settings (U4)",
  maxReviewerContextRetries: "moved to workflow settings (U4)",
  maxReviewerFallbackRetries: "moved to workflow settings (U4)",
  reflectionEnabled: "moved to workflow settings (U4)",
  executionProvider: "moved to workflow settings (U4)",
  executionModelId: "moved to workflow settings (U4)",
  planningProvider: "moved to workflow settings (U4)",
  planningModelId: "moved to workflow settings (U4)",
  planningFallbackProvider: "moved to workflow settings (U4)",
  planningFallbackModelId: "moved to workflow settings (U4)",
  validatorProvider: "moved to workflow settings (U4)",
  validatorModelId: "moved to workflow settings (U4)",
  validatorFallbackProvider: "moved to workflow settings (U4)",
  validatorFallbackModelId: "moved to workflow settings (U4)",

  /*
  FNXC:SettingsCredentialInstance 2026-08-01-17:06:
  Credential-instance selectors are inline companions to their provider/model pickers. They inherit the provider default when unset, so each has no standalone Settings description while this narrow inventory keeps the default-description census complete.
  */
  defaultCredentialInstanceId: "inline companion for the global default model picker; unset inherits the provider default",
  fallbackCredentialInstanceId: "inline companion for the global fallback model picker; unset inherits the provider default",
  executionGlobalCredentialInstanceId: "inline companion for the global execution model picker; unset inherits the provider default",
  planningGlobalCredentialInstanceId: "inline companion for the global planning model picker; unset inherits the provider default",
  validatorGlobalCredentialInstanceId: "inline companion for the global validator model picker; unset inherits the provider default",
  titleSummarizerGlobalCredentialInstanceId: "inline companion for the global title-summarizer model picker; unset inherits the provider default",
  mergerGlobalCredentialInstanceId: "inline companion for the global merger model picker; unset inherits the provider default",
  importTranslateGlobalCredentialInstanceId: "inline companion for the global import-translate model picker; unset inherits the provider default",
  fastCheapGlobalProvider: "configured by the global Fast & Cheap Model picker for the no-plan/no-review Fast mode lane",
  fastCheapGlobalModelId: "configured by the global Fast & Cheap Model picker for the no-plan/no-review Fast mode lane",
  fastCheapGlobalCredentialInstanceId: "inline companion for the global Fast & Cheap Model picker; unset inherits the provider default",
  fastCheapGlobalThinkingLevel: "inline thinking companion for the global Fast & Cheap Model picker",
  fastCheapProvider: "configured by the project Fast & Cheap Model picker for the no-plan/no-review Fast mode lane",
  fastCheapModelId: "configured by the project Fast & Cheap Model picker for the no-plan/no-review Fast mode lane",
  fastCheapCredentialInstanceId: "inline companion for the project Fast & Cheap Model picker; unset inherits the provider default",
  fastCheapThinkingLevel: "inline thinking companion for the project Fast & Cheap Model picker",
  defaultCredentialInstanceIdOverride: "inline companion for the project default model picker; unset inherits the provider default",
  titleSummarizerCredentialInstanceId: "inline companion for the project title-summarizer model picker; unset inherits the provider default",
  titleSummarizerFallbackCredentialInstanceId: "inline companion for the project title-summarizer fallback model picker; unset inherits the provider default",
  importTranslateCredentialInstanceId: "inline companion for the project import-translate model picker; unset inherits the provider default",
  mergerCredentialInstanceId: "inline companion for the project merger model picker; unset inherits the provider default",
  mergerFallbackCredentialInstanceId: "inline companion for the project merger fallback model picker; unset inherits the provider default",

  /*
  FNXC:SettingsDefaults 2026-08-12-01:00:
  FN-8993 classifies this CLI/engine-owned graph output path as not surfaced: it has
  zero dashboard render sites and i18n keys, while only `fn knowledge-graph build`
  and the memory-consolidation tick consume it. Operators can find its default in
  docs/settings-reference.md and docs/knowledge-graph.md rather than a Settings field.
  */
  knowledgeGraphDir: "CLI/engine-owned knowledge-graph output directory (fn knowledge-graph build --dir); no Settings UI field renders it",

  // Internal/engine bookkeeping, session state, or reliability telemetry — not
  // rendered as a plain user-facing description field anywhere in Settings.
  globalPause: "engine-managed pause flag, not a plain description field",
  globalPauseReason: "engine-managed pause flag, not a plain description field",
  enginePaused: "engine-managed pause flag, not a plain description field",
  engineLastActiveAt: "internal engine bookkeeping timestamp",
  engineActiveSinceMs: "internal engine bookkeeping timestamp",
  engineActivationGraceMs: "internal engine tuning constant, no UI field",
  reliabilityStatsResetAt: "internal engine bookkeeping timestamp",
  /*
  FNXC:SettingsDefaults 2026-07-16-12:25:
  Single allowlist entry per key (noDuplicateObjectKeys). FN-8038 classifies PostgreSQL
  migration bookkeeping as engine-managed records, not user-editable Settings descriptions.
  */
  sqliteMigrationNotice: "startup-factory-managed PostgreSQL migration banner record, not a plain description field",
  backupSettingsMigrationConflicts: "startup migration conflict record is rendered conditionally, not a plain settings row",
  postgresMigrationInboxMessageSentAt: "engine-written PostgreSQL migration inbox completion-message marker, not a plain description field",
  dashboardCurrentNodeId: "dashboard session/PWA restore state, not a setting field",
  dashboardCurrentProjectIdByNode: "dashboard session/PWA restore state, not a setting field",
  daemonToken: "daemon runtime secret, not rendered as a description field",
  daemonPort: "daemon runtime config, not exposed in Settings UI",
  daemonHost: "daemon runtime config, not exposed in Settings UI",
  setupComplete: "onboarding wizard completion flag, not a Settings field",
  cliOnboardingCompletedAt: "onboarding wizard completion flag, not a Settings field",
  modelOnboardingComplete: "onboarding wizard completion flag, not a Settings field",
  defaultProjectId: "internal navigation state, not a Settings field",
  favoriteProviders: "derived UI favorite-star state, not a described field",
  favoriteModels: "derived UI favorite-star state, not a described field",
  secretsAccessPolicy: "managed via the Secrets view, not a plain description field",
  secretsSyncPassphraseConfigured: "derived boolean status flag, not a user-set field",
  secretsEnv: "managed via the Secrets view, not a plain description field",
  testMode2: "not a real key (placeholder guard)",
  autoUpdatePrStatus: "internal PR-status sync flag, no dedicated UI field",
  githubCommentOnDone: "not yet exposed as a distinct Settings field",
  githubCommentTemplate: "not yet exposed as a distinct Settings field",
  githubCloseSourceIssueOnDone: "not yet exposed as a distinct Settings field",
  githubTrackingDedupEnabled2: "not a real key (placeholder guard)",
  gitlabCommentOnDone: "not yet exposed as a distinct Settings field",
  gitlabCommentTemplate: "not yet exposed as a distinct Settings field",
  gitlabCloseSourceIssueOnDone: "not yet exposed as a distinct Settings field",
  // FNXC:GitHubImportTranslate 2026-07-15-09:30: the import-translate lane is a
  // model-lane picker (Settings -> Project/Global Models), not a description field.
  importTranslateProvider: "configured via the model-lane picker, not a plain description field",
  importTranslateModelId: "configured via the model-lane picker, not a plain description field",
  importTranslateThinkingLevel: "configured via the model-lane picker, not a plain description field",
  importTranslateGlobalProvider: "configured via the model-lane picker, not a plain description field",
  importTranslateGlobalModelId: "configured via the model-lane picker, not a plain description field",
  importTranslateGlobalThinkingLevel: "configured via the model-lane picker, not a plain description field",
  titleSummarizerProvider: "configured via the model-lane picker, not a plain description field",
  titleSummarizerModelId: "configured via the model-lane picker, not a plain description field",
  titleSummarizerFallbackProvider: "configured via the model-lane picker, not a plain description field",
  titleSummarizerFallbackModelId: "configured via the model-lane picker, not a plain description field",
  titleSummarizerGlobalProvider: "configured via the model-lane picker, not a plain description field",
  titleSummarizerGlobalModelId: "configured via the model-lane picker, not a plain description field",
  mergerProvider: "configured via the model-lane picker, not a plain description field",
  mergerModelId: "configured via the model-lane picker, not a plain description field",
  mergerFallbackProvider: "configured via the inline merger-fallback model picker, not a plain description field",
  mergerFallbackModelId: "configured via the inline merger-fallback model picker, not a plain description field",
  mergerGlobalProvider: "configured via the model-lane picker, not a plain description field",
  mergerGlobalModelId: "configured via the model-lane picker, not a plain description field",
  executionGlobalProvider: "configured via the model-lane picker, not a plain description field",
  executionGlobalModelId: "configured via the model-lane picker, not a plain description field",
  planningGlobalProvider: "configured via the model-lane picker, not a plain description field",
  planningGlobalModelId: "configured via the model-lane picker, not a plain description field",
  validatorGlobalProvider: "configured via the model-lane picker, not a plain description field",
  validatorGlobalModelId: "configured via the model-lane picker, not a plain description field",
  defaultProviderOverride: "configured via the model-lane picker, not a plain description field",
  defaultModelIdOverride: "configured via the model-lane picker, not a plain description field",
  // FNXC:Settings-ThinkingLevel 2026-07-10: FN-7770 (commit 5f14a58d3) / FN-7772 (commit df8ad460a) /
  // FN-7795 (commit 3d5cc0ada) added inline thinking-level companion selectors rendered inside the
  // model-lane pickers (GlobalModelsSection / ProjectModelsSection). They are NOT standalone
  // description fields — they ride alongside their provider/model lane pair, exactly like
  // executionGlobalProvider / titleSummarizerProvider etc. above.
  // FNXC:Settings-MergerModel 2026-07-13-07:52: merger lane thinking companions follow the same picker pattern.
  executionGlobalThinkingLevel: "inline thinking companion for the global execution lane, configured via the model-lane picker, not a plain description field",
  planningGlobalThinkingLevel: "inline thinking companion for the global planning lane, configured via the model-lane picker, not a plain description field",
  validatorGlobalThinkingLevel: "inline thinking companion for the global validator lane, configured via the model-lane picker, not a plain description field",
  titleSummarizerGlobalThinkingLevel: "inline thinking companion for the global title-summarizer lane, configured via the model-lane picker, not a plain description field",
  mergerGlobalThinkingLevel: "inline thinking companion for the global merger lane, configured via the model-lane picker, not a plain description field",
  defaultThinkingLevelOverride: "project-scoped Default-lane inline thinking companion, configured via the model-lane picker, not a plain description field",
  titleSummarizerThinkingLevel: "project title-summarizer inline thinking companion, configured via the model-lane picker, not a plain description field",
  titleSummarizerFallbackThinkingLevel: "project title-summarizer fallback inline thinking companion, configured via the model-lane picker, not a plain description field",
  mergerThinkingLevel: "project merger inline thinking companion, configured via the model-lane picker, not a plain description field",
  mergerFallbackThinkingLevel: "project merger-fallback inline thinking companion, configured via the model-lane picker, not a plain description field",
  fallbackThinkingLevel: "global fallback model inline thinking companion, configured via the model-lane picker, not a plain description field",
  agentPrompts2: "not a real key (placeholder guard)",
  promptOverrides2: "not a real key (placeholder guard)",
  taskTokenBudget: "not yet exposed as a distinct Settings field",
  tokenCap2: "not a real key (placeholder guard)",
  scripts: "not yet exposed as a distinct Settings field",
  setupScript: "not yet exposed as a distinct Settings field",
  agentProvisioning2: "not a real key (placeholder guard)",
  sandboxProvisioning: "configured via the Agent Permissions provisioning editor, not a plain description field",
  sandbox: "not yet exposed as a distinct Settings field",
  approvedWorkflowCliCommands: "internal workflow CLI-approval bookkeeping, not a Settings field",
  approvedCliAutonomyAdapters: "internal workflow CLI-approval bookkeeping, not a Settings field",
  owningNodeHandoffPolicy: "not yet exposed as a distinct Settings field",
  unavailableNodePolicy2: "not a real key (placeholder guard)",
  defaultNodeId2: "not a real key (placeholder guard)",
  taskAttributionTrailerNames: "not yet exposed as a distinct Settings field",
  commitMsgHookEnabled: "not yet exposed as a distinct Settings field",
  autoResolveReviewComments: "not yet exposed as a distinct Settings field",
  mergeRequestContractShadowEnabled: "internal shadow-diagnostic flag, not a Settings field",
  mergeAuditAutoRecovery: "not yet exposed as a distinct Settings field",
  autoRecovery: "not yet exposed as a distinct Settings field",
  buildTimeoutMs: "not yet exposed as a distinct Settings field",
  verificationCommandTimeoutMs: "not yet exposed as a distinct Settings field",
  scopeVerificationToChangedFiles: "not yet exposed as a distinct Settings field",
  specStalenessMaxAgeMs2: "not a real key (placeholder guard)",
  dispatchOscillationThreshold: "internal scheduler tuning constant, no UI field",
  dispatchOscillationWindowMs: "internal scheduler tuning constant, no UI field",
  dispatchOscillationSettleMs: "internal scheduler tuning constant, no UI field",
  runtimeStopDrainMs: "internal scheduler tuning constant, no UI field",
  inReviewStallDeadlockThreshold: "internal reliability tuning constant, no UI field",
  stalePausedReviewThresholdMs: "internal reliability tuning constant, no UI field",
  inReviewStalledThresholdMs: "internal reliability tuning constant, no UI field",
  stalePausedTodoThresholdMs: "internal reliability tuning constant, no UI field",
  pausedScopeDecayMs: "internal reliability tuning constant, no UI field",
  boardStallSweepWindowMs: "internal reliability tuning constant, no UI field",
  boardStallBlockedGrowthThreshold: "internal reliability tuning constant, no UI field",
  backlogPressureAlertEnabled: "internal reliability tuning constant, no UI field",
  backlogPressureRatioThreshold: "internal reliability tuning constant, no UI field",
  backlogPressureMinTodoCount: "internal reliability tuning constant, no UI field",
  backlogPressureAlertCooldownMs: "internal reliability tuning constant, no UI field",
  staleInProgressWarningMs: "internal reliability tuning constant, no UI field",
  staleInProgressCriticalMs: "internal reliability tuning constant, no UI field",
  staleInReviewWarningMs: "internal reliability tuning constant, no UI field",
  staleInReviewCriticalMs: "internal reliability tuning constant, no UI field",
  aiSessionTtlMs: "internal session-cleanup tuning constant, no UI field",
  aiSessionCleanupIntervalMs: "internal session-cleanup tuning constant, no UI field",
  autoUnpauseEnabled: "not yet exposed as a distinct Settings field",
  autoUnpauseBaseDelayMs: "internal auto-unpause tuning constant, no UI field",
  autoUnpauseMaxDelayMs: "internal auto-unpause tuning constant, no UI field",
  maxBranchConflictRecoveries: "internal reliability tuning constant, no UI field",
  maxTotalRetriesBeforeFail: "internal reliability tuning constant, no UI field",
  maintenanceIntervalMs: "internal engine maintenance interval, no UI field",
  autoClaimCandidatesInPrompt: "internal prompt-shaping constant, no UI field",
  tombstoneStickyWindowDays: "internal tombstone-retention constant, no UI field",
  heartbeatMultiplier: "internal scheduler tuning constant, no UI field",
  heartbeatPromptTemplate: "internal prompt-template selector, no UI field",
  agentLogFileRetentionDays: "not yet exposed as a distinct Settings field",
  chatRoomCompactionFetchLimit2: "not a real key (placeholder guard)",
  missionStaleThresholdMs: "internal mission-health tuning constant, no UI field",
  missionMaxTaskRetries: "internal mission-health tuning constant, no UI field",
  missionHealthCheckIntervalMs: "internal mission-health tuning constant, no UI field",
  reflectionIntervalMs: "internal reflection-scheduling constant, no UI field",
  reflectionAfterTask: "internal reflection-scheduling constant, no UI field",
  showQuickChatFAB: "derived from quickChatButtonMode, not independently described",
  taskEvaluationEnabled: "not yet exposed as a distinct Settings field",
  taskEvaluationSchedule: "not yet exposed as a distinct Settings field",
  taskEvaluationProvider: "not yet exposed as a distinct Settings field",
  taskEvaluationModelId: "not yet exposed as a distinct Settings field",
  taskEvaluationFollowUpPolicy: "not yet exposed as a distinct Settings field",
  taskEvaluationRetention: "not yet exposed as a distinct Settings field",
  insightExtractionEnabled: "not yet exposed as a distinct Settings field",
  insightExtractionSchedule: "not yet exposed as a distinct Settings field",
  insightExtractionMinIntervalMs: "not yet exposed as a distinct Settings field",

  // Global settings not rendered by a plain description field.
  themeMode: "configured via ThemeSelector, not a plain description field",
  colorTheme: "configured via ThemeSelector, not a plain description field",
  shadcnCustomColors: "configured via ThemeSelector, not a plain description field",
  dashboardFontScalePct: "configured via ThemeSelector, not a plain description field",
  dashboardKeyboardShortcuts: "described inline per-shortcut (quickChatShortcutHint / terminalShortcutHint), not a single field",
  language: "configured via LanguageSelector, not a plain description field",
  modelPricingFetchedAt: "derived fetch-status timestamp, not a user-set field",
  modelPricingSource: "derived fetch-status metadata, not a user-set field",
  modelRouterEnabled: "not yet exposed as a distinct Settings field",
  modelRouterCheapProvider: "not yet exposed as a distinct Settings field",
  modelRouterCheapModelId: "not yet exposed as a distinct Settings field",
  openrouterModelFilters2: "not a real key (placeholder guard)",
  openrouterProviderPreferences2: "not a real key (placeholder guard)",
  ntfyEvents: "described per-checkbox in the event list, not a single field",
  webhookEvents: "described per-checkbox in the event list, not a single field",
  notificationProviders: "not yet exposed as a distinct Settings field",
  customProviders: "not yet exposed as a distinct Settings field",
  cliAgents: "configured via per-adapter Runtime Cards (Hermes/OpenClaw/Paperclip) outside settings/sections scope",
  useClaudeCli: "configured via CliBinaryPanel, not a plain description field",
  useDroidCli: "configured via CliBinaryPanel, not a plain description field",
  useLlamaCpp: "configured via CliBinaryPanel, not a plain description field",
  useCursorCli: "configured via CliBinaryPanel, not a plain description field",
  cursorCliBinaryPath: "configured via CliBinaryPanel, not a plain description field",
  // FNXC:GrokCli 2026-07-09: FN-7705 (commit 081dae0e0) / FN-7790 (commit db9b9d22c) added the Grok
  // CLI runtime adapter. Its enable toggle + binary path are managed by GrokCliProviderCard in the
  // Authentication section (POSTs /auth/grok-cli), not rendered as a plain description field.
  useGrokCli: "managed via GrokCliProviderCard in the Authentication section, not a plain description field",
  grokCliBinaryPath: "managed via GrokCliProviderCard in the Authentication section, not a plain description field",
  useOmpCli: "managed via OmpCliProviderCard in the Authentication section, not a plain description field",
  ompCliBinaryPath: "managed via OmpCliProviderCard in the Authentication section, not a plain description field",
  vitestAutoKillEnabled: "dashboard TUI memory guard, no Settings UI field",
  vitestKillThresholdPct: "dashboard TUI memory guard, no Settings UI field",
  agentMemoryInclusionMode: "not yet exposed as a distinct Settings field",
  researchGlobalDefaults: "superseded by discrete researchGlobal* fields, which are individually documented",
  researchGlobalEnabled: "superseded by the per-source enabledSources toggles, which are individually documented",
  researchGlobalUserAgent: "not yet exposed as a distinct Settings field",

  // Research (legacy top-level project research settings superseded by researchSettings).
  researchEnabled: "superseded by researchSettings.enabled, which is documented",
  researchMaxConcurrentRuns: "superseded by researchSettings.limits.maxConcurrentRuns, which is documented",
  researchDefaultTimeout: "superseded by researchSettings.limits.maxDurationMs, which is documented",
  researchMaxSourcesPerRun: "superseded by researchSettings.limits.maxSourcesPerRun, which is documented",
  researchMaxSynthesisRounds: "not yet exposed as a distinct Settings field",

  // Session/legacy fields with no dedicated description field in any section.
  persistAgentThinkingLog: "legacy base flag superseded by granular Permanent/Ephemeral toggles, which are documented",
  researchGlobalBraveApiKey: "configured via the Authentication section's provider API key flow, not a plain description field",
  researchGlobalTavilyApiKey: "configured via the Authentication section's provider API key flow, not a plain description field",
  researchGlobalMaxSearchResults: "not yet exposed as a distinct Settings field",
  mergerAutostashMaxAgeHours: "internal AI-merger autostash tuning constant, no UI field",
  prerebaseAutoEnabled: "internal pre-rebase tuning constant, no UI field",
  prerebaseHotFiles: "internal pre-rebase tuning constant, no UI field",
  prerebaseDivergenceThreshold: "internal pre-rebase tuning constant, no UI field",
  /*
   * FNXC:SettingsDefaults 2026-09-01-14:52:
   * Chat defaults are rendered by ProjectModelsSection's Chat group, where help is
   * attached to the shared SettingsHelpTip "?" affordance instead of a plain
   * description field. chatNewSessionMode is retained schema-parity state with no
   * rendered control.
   */
  chatNewSessionMode: "retired create-time mode flag with no rendered control, retained in DEFAULT_SETTINGS for settings parity",
  chatSnippets: "global slash-command content managed by the Skills view rather than a plain Settings description field",
  chatDefaultKind: "configured by ProjectModelsSection's Chat group with SettingsHelpTip help, not a plain description field",
  chatDefaultAgentId: "configured by ProjectModelsSection's Chat group with SettingsHelpTip help, not a plain description field",
  chatDefaultModelProvider: "configured by ProjectModelsSection's Chat group with SettingsHelpTip help, not a plain description field",
  chatDefaultModelId: "configured by ProjectModelsSection's Chat group with SettingsHelpTip help, not a plain description field",
  chatDefaultThinkingLevel: "configured by ProjectModelsSection's Chat group with SettingsHelpTip help, not a plain description field",
  /*
   * FNXC:Rufu043MemoryBackends 2026-08-08-17:38:
   * RUFU-040 foundation commit 8c595f5cd added three project-scoped Stash/TencentDB
   * memory-backend settings keys to DEFAULT_PROJECT_SETTINGS without registering them
   * here, breaking this guard's "every DEFAULT_SETTINGS key is either mapped to a
   * description or explicitly allowlisted" assertion on any base carrying the
   * foundation. They are allowlisted (not mapped) because their canonical schema
   * default is the empty string `""` (meaning "use the runtime localhost constant"),
   * so a description-field `Default:` claim would be a fabricated-default defect that
   * the guard's canonical-default assertion rejects; their concrete defaults are the
   * http://127.0.0.1 runtime fallbacks conveyed by each row's placeholder/help, not a
   * description-field claim.
   *
   * FNXC:StashSessionCapture 2026-08-19-05:09:
   * (RUFU-122) stashUrl left this allowlist: it is now a genuinely rendered
   * Settings row whose help copy accurately states its empty-string canonical
   * default ("Default: empty (uses the built-in default Stash URL)"), so it is
   * mapped in SETTING_DESCRIPTION_KEYS instead — a key in BOTH maps fails the
   * overlap assertion below.
   */
  memoryBackendUrl: "project-scoped TencentDB gateway URL row (rendered in MemorySection only for the tencentdb backend); canonical schema default is empty (`''`) = use the runtime DEFAULT_GATEWAY_URL (http://127.0.0.1:8420), conveyed by the row's placeholder/help, not a description-field claim",
  stashApiKey: "Stash API-key secret override, not rendered as a settings field (the primary key lives in the global secrets store `stash-api-key` per MemorySection help, never in settings); canonical schema default is empty (`''`) = use the resolved global secret",
};

const CHAT_DEFAULT_ALLOWLIST_KEYS = [
  "chatNewSessionMode",
  "chatDefaultKind",
  "chatDefaultAgentId",
  "chatDefaultModelProvider",
  "chatDefaultModelId",
  "chatDefaultThinkingLevel",
] as const;

const RETIRED_CHAT_FLOW_PHRASES = [
  "New Chat dialog",
  "New Chat picker",
  "chat defaults picker",
  "New Session defaults picker",
] as const;

describe("FN-7505 settings default-value description guard", () => {
  it("uses the active English catalog's first-error tool retry default", () => {
    /*
     * FNXC:ExecutorToolFailureRetry 2026-08-06-14:56:
     * Import the active runtime English catalog rather than inspecting a
     * component fallback. A stale translation otherwise overrides the correct
     * form value and tells desktop and mobile operators the retired default.
     */
    expect(resolveDescription(realEnApp.settings as SettingsDict, "scheduling.executorToolFailureThresholdHelp"))
      .toBe("Terminal tool errors required before retrying. Default: 1.");
    expect(DEFAULT_PROJECT_SETTINGS.executorToolFailureThreshold).toBe(1);
  });

  it("every surfaced setting's resolved English description states its default", () => {
    const missing: string[] = [];
    const noIndicator: string[] = [];

    for (const [settingKey, i18nPath] of Object.entries(SETTING_DESCRIPTION_KEYS)) {
      const value = resolveDescription(realEnApp.settings as SettingsDict, i18nPath);
      if (value === undefined) {
        missing.push(`${settingKey} -> settings.${i18nPath} (key not found in locale)`);
        continue;
      }
      if (!DEFAULT_INDICATOR_RE.test(value)) {
        noIndicator.push(`${settingKey} -> settings.${i18nPath}: ${JSON.stringify(value)}`);
      }
    }

    expect(missing, `Missing locale keys:\n${missing.join("\n")}`).toEqual([]);
    expect(
      noIndicator,
      `Descriptions missing a default-value indicator (Default:/inherits/No default/(default)):\n${noIndicator.join("\n")}`,
    ).toEqual([]);
  });

  it("every DEFAULT_SETTINGS key is either mapped to a description or explicitly allowlisted", () => {
    const unaccounted = Object.keys(DEFAULT_SETTINGS).filter(
      (key) => !(key in SETTING_DESCRIPTION_KEYS) && !(key in NOT_SURFACED_ALLOWLIST),
    );

    expect(
      unaccounted,
      `Settings keys with no default-value description mapping and no allowlist reason:\n${unaccounted.join("\n")}`,
    ).toEqual([]);
  });

  /*
  FNXC:SettingsDefaults 2026-08-12-01:00:
  FN-8993 prevents knowledgeGraphDir from silently returning to the unaccounted-default
  census failure. The CLI/engine-owned path belongs only in the not-surfaced allowlist.
  */
  it("pins FN-8993 knowledgeGraphDir as an allowlisted, non-Settings field", () => {
    expect(
      DEFAULT_SETTINGS,
      "FN-8993 requires knowledgeGraphDir to remain a DEFAULT_SETTINGS key",
    ).toHaveProperty("knowledgeGraphDir");
    expect(
      NOT_SURFACED_ALLOWLIST.knowledgeGraphDir,
      "FN-8993 requires knowledgeGraphDir's non-empty not-surfaced allowlist reason",
    ).toEqual(expect.any(String));
    expect(
      NOT_SURFACED_ALLOWLIST.knowledgeGraphDir,
      "FN-8993 requires a non-empty knowledgeGraphDir allowlist reason",
    ).not.toBe("");
    expect(
      SETTING_DESCRIPTION_KEYS,
      "FN-8993 requires knowledgeGraphDir to stay out of SETTING_DESCRIPTION_KEYS",
    ).not.toHaveProperty("knowledgeGraphDir");
  });

  it("chat default allowlist reasons name their real host and carry no retired-flow claim", () => {
    for (const settingKey of CHAT_DEFAULT_ALLOWLIST_KEYS) {
      expect(DEFAULT_SETTINGS).toHaveProperty(settingKey);

      const reason = NOT_SURFACED_ALLOWLIST[settingKey];
      expect(reason).toEqual(expect.any(String));
      expect(reason).not.toBe("");

      for (const retiredPhrase of RETIRED_CHAT_FLOW_PHRASES) {
        expect(reason).not.toMatch(new RegExp(retiredPhrase, "i"));
      }

      if (settingKey === "chatNewSessionMode") {
        expect(reason).toMatch(/\b(retired|inert)\b/i);
        expect(reason).toMatch(/no rendered control/i);
      } else {
        expect(reason).toContain("ProjectModelsSection");
      }
    }
  });

  it("does not allowlist a key that is also mapped to a description (would mask real coverage gaps)", () => {
    const overlap = Object.keys(SETTING_DESCRIPTION_KEYS).filter((key) => key in NOT_SURFACED_ALLOWLIST);
    expect(overlap).toEqual([]);
  });

  it("mapped settings state their ACTUAL canonical default, not a fabricated one", () => {
    /*
     * FNXC:SettingsDefaults 2026-07-04-00:00:
     * Deliberately narrow: this only anchors on the explicit "Default: <claim>" colon
     * phrasing rather than every free-form "off by default"/"(default)" variant, because
     * requiring one exact phrasing across ~140 hand-written descriptions would produce
     * false positives unrelated to the actual defect class. The defect class this guards
     * against (caught in FN-7505 code review) is a description making an explicit,
     * WRONG "Default: X" claim — e.g. "Default: enabled" for a setting whose canonical
     * schema default is `undefined`, or "Default: https://runfusion.ai" for a field whose
     * schema default is `undefined` (a UI placeholder/runtime-fallback value mistaken for
     * the setting's own default). Settings whose canonical default is undefined must use
     * unset/inherits phrasing instead of a bare "Default:" claim.
     */
    const UNSET_INDICATOR_RE = /no default|inherits|\bunset\b/i;
    const mismatches: string[] = [];

    for (const [settingKey, i18nPath] of Object.entries(SETTING_DESCRIPTION_KEYS)) {
      const description = resolveDescription(realEnApp.settings as SettingsDict, i18nPath);
      if (description === undefined) continue; // already asserted by the first test above

      const actualDefault = resolveCanonicalDefault(settingKey);

      if (actualDefault === undefined) {
        // Genuinely unset (no default, or inherits another value) — the description must
        // say so and must NOT fabricate a concrete "Default: X" claim (FN-7505 review fix).
        if (!UNSET_INDICATOR_RE.test(description)) {
          mismatches.push(
            `${settingKey} -> settings.${i18nPath}: canonical default is undefined but description doesn't say "no default"/"unset"/"inherits": ${JSON.stringify(description)}`,
          );
        }
        const colonClaim = description.match(/default:\s*([^.\n]+)/i);
        if (colonClaim && !UNSET_INDICATOR_RE.test(colonClaim[1])) {
          mismatches.push(
            `${settingKey} -> settings.${i18nPath}: canonical default is undefined but description fabricates a concrete "Default: ${colonClaim[1].trim()}" claim: ${JSON.stringify(description)}`,
          );
        }
        continue;
      }

      if (typeof actualDefault === "boolean") {
        const colonClaim = description.match(/default:\s*([a-z]+)/i);
        if (colonClaim) {
          const stated = colonClaim[1].toLowerCase();
          const statedTrue = stated === "enabled" || stated === "true" || stated === "on";
          const statedFalse = stated === "disabled" || stated === "false" || stated === "off";
          if (statedTrue && actualDefault !== true) {
            mismatches.push(
              `${settingKey} -> settings.${i18nPath}: description claims "Default: ${stated}" but canonical default is ${actualDefault}: ${JSON.stringify(description)}`,
            );
          }
          if (statedFalse && actualDefault !== false) {
            mismatches.push(
              `${settingKey} -> settings.${i18nPath}: description claims "Default: ${stated}" but canonical default is ${actualDefault}: ${JSON.stringify(description)}`,
            );
          }
        }
      }
    }

    expect(mismatches, `Mismatched default-value claims:\n${mismatches.join("\n")}`).toEqual([]);
  });
});
