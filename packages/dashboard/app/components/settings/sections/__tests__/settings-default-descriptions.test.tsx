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
 * `DEFAULT_PROJECT_SETTINGS` / `DEFAULT_SETTINGS` in `packages/core/src/settings-schema.ts`.
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
 * `undefined` in DEFAULT_GLOBAL_SETTINGS/DEFAULT_PROJECT_SETTINGS (settings-schema.ts).
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
  // GlobalGeneralSection
  githubTrackingDefaultRepo: "globalGeneral.projectsInheritThisValueWhenTheyDoNot",
  gitlabEnabled: "merge.gitLabAuthDetails",
  gitlabInstanceUrl: "globalGeneral.gitLabInstanceUrlHint",
  gitlabApiBaseUrl: "globalGeneral.gitLabApiBaseUrlHint",
  gitlabAuthTokenType: "globalGeneral.gitLabTokenTypeHint",
  gitlabAuthToken: "globalGeneral.gitLabAuthTokenHint",
  dismissModalsOnOutsideClick: "globalGeneral.dismissModalsByClickingOutsideHint",
  persistAgentToolOutput: "globalGeneral.whenDisabledToolRowsAreStillLoggedBut",
  persistAgentThinkingLogPermanent: "globalGeneral.rowsAndDoesNotAffectAssistantTextOr",
  persistAgentThinkingLogEphemeral: "globalGeneral.rowsAndDoesNotAffectAssistantTextOr",
  fnBinaryCheckEnabled: "globalGeneral.disableThisIfYourLocalDevProcessIs",
  updateCheckEnabled: "globalGeneral.andShowsUpdateNoticesInTheCLIAnd",
  updateCheckFrequency: "globalGeneral.controlsHowOftenTheDashboardReFetchesThe",
  autoReloadOnVersionChange: "globalGeneral.whenEnabledDefaultTheDashboardAutomaticallyReloadsWhen",
  // AppearanceSection
  openTasksInRightSidebar: "appearance.openTasksInRightSidebarHelp",
  openMobileTasksInPopup: "appearance.openMobileTasksInPopupHelp",
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
  failureNotificationDelayMs: "notifications.howLongAFailureMustPersistBeforeA",
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
  // MemorySection
  memoryEnabled: "memory.agentsGetMemorySearchMemoryGetAndMemory",
  memoryAutoSummarizeEnabled: "memory.automaticallyCompactMemoryWhenItExceedsTheThreshold",
  memoryAutoSummarizeThresholdChars: "memory.memoryWillBeCompactedWhenItExceedsThis",
  memoryAutoSummarizeSchedule: "memory.cronExpressionForAutoSummarizeScheduleDefaultDaily",
  memoryDreamsEnabled: "memory.turnsDailyNotesIntoDREAMSMdAndPromotes",
  memoryDreamsSchedule: "memory.cronExpressionForDreamProcessing",
  memoryBackendType: "memory.agentsGetMemorySearchMemoryGetAndMemory",
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
  globalMaxConcurrent: "scheduling.maximumConcurrentAgentsAcrossAllProjects",
  maxConcurrent: "scheduling.maxConcurrentTasksHint",
  maxTriageConcurrent: "scheduling.maximumConcurrentPlanningAgents",
  pollIntervalMs: "scheduling.pollIntervalMsHint",
  heartbeatScopeDiscipline: "scheduling.strictDefault",
  engineerBacklogAutoClaim: "scheduling.backlogNoTaskAutoClaimIsExecutorOnly",
  taskStuckTimeoutMs: "scheduling.timeoutInMinutesForDetectingStuckTasksWhen",
  staleHighFanoutBlockerAgeThresholdMs: "scheduling.escalateHighFanOutBlockersOnlyAfterThey",
  preserveProgressOnStuckRequeue: "scheduling.whenTheStuckDetectorKillsAndReQueues",
  specStalenessEnabled: "scheduling.whenEnabledTasksWithStalePlansPROMPTMd",
  specStalenessMaxAgeMs: "scheduling.maximumAgeInHoursBeforeAPlanIs",
  autoArchiveDoneTasksEnabled: "scheduling.completedTasksOlderThanTheThresholdAreMoved",
  autoArchiveDoneAfterMs: "scheduling.numberOfDaysATaskCanStayIn",
  archiveAgentLogMode: "scheduling.compactModeKeepsArchiveSizeLowWhilePreserving",
  autoArchiveDuplicateTasksEnabled: "scheduling.autoArchiveDuplicateTasksHelp",
  maxStuckKills: "scheduling.maximumStuckDetectorRetriesBeforeATaskIs",
  groupOverlappingFiles: "scheduling.whenEnabledTasksThatModifyTheSameFiles",
  ignoreHiddenOverlapPaths: "scheduling.ignoreHiddenDotPathsHelp",
  overlapIgnorePaths: "scheduling.optionalFileOrDirectoryPathsToIgnoreWhen",
  // WorktreesSection
  maxWorktrees: "worktrees.limitsTotalGitWorktreesIncludingInReviewTasks",
  worktreeInitCommand: "worktrees.shellCommandToRunInEachNewWorktree",
  recycleWorktrees: "worktrees.offByDefaultOptInWhenEnabledCompleted",
  showWorktreeGrouping: "worktrees.showWorktreeGroupingHelp",
  worktreeCopyFiles: "worktrees.copyFilesHelp",
  executorAllowSiblingBranchRename: "worktrees.andCanHidePriorCommitsFromTheDefault",
  worktreeNaming: "worktrees.howToNameFreshWorktreeDirectories",
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
  ephemeralAgentsCanCreateTasks: "general.allowEphemeralAgentsToCreateTasksHint",
  ephemeralAgentsEnabled: "general.whenEnabledDefaultFusionSpawnsShortLived",
  githubLinkImportedIssuesToTracking: "general.whenEnabledImportedGitHubIssuesUseTheirSource",
  githubTrackingDedupEnabled: "general.whenEnabledFusionChecksOpenAndClosedIssues",
  githubTrackingEnabledByDefault: "general.offDefault",
  mailAutoCleanupDays: "general.deleteInboxOutboxMessagesOlderThanThisMany",
  operationalLogRetentionDays: "general.loweringThisWindowMeansReliabilityMetricsChartsAnd",
  quickChatButtonMode: "general.quickChatLauncherHint",
  quickChatCloseOnOutsideClick: "general.quickChatCloseOnOutsideClickHint",
  showTaskChatsInCommonFeed: "general.showTaskChatsInCommonFeedHint",
  taskPrefix: "general.prefixForNewTaskIDsEGKB",
  workspaceMode: "general.workspaceModeHint",
  defaultWorkflowId: "general.newTasksInheritThisCustomWorkflowsStepsOverridable",
  enabledBuiltinWorkflowIds: "general.disabledFusionWorkflowsAreHiddenFromWorkflow",
  aiUndoTaskWorkflowId: "general.aiUndoTaskWorkflowHelp",
  // ProjectModelsSection
  autoSelectModelPreset: "projectModels.autoSelectModelPresetHint",
  autoSummarizeTitles: "projectModels.whenEnabledTasksCreatedWithoutATitleBut",
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
  // Moved to workflow settings (U4) — see MOVED_SETTINGS_KEYS in settings-schema.ts.
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

  // Internal/engine bookkeeping, session state, or reliability telemetry — not
  // rendered as a plain user-facing description field anywhere in Settings.
  globalPause: "engine-managed pause flag, not a plain description field",
  globalPauseReason: "engine-managed pause flag, not a plain description field",
  enginePaused: "engine-managed pause flag, not a plain description field",
  engineLastActiveAt: "internal engine bookkeeping timestamp",
  engineActiveSinceMs: "internal engine bookkeeping timestamp",
  engineActivationGraceMs: "internal engine tuning constant, no UI field",
  reliabilityStatsResetAt: "internal engine bookkeeping timestamp",
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
  titleSummarizerProvider: "configured via the model-lane picker, not a plain description field",
  titleSummarizerModelId: "configured via the model-lane picker, not a plain description field",
  titleSummarizerFallbackProvider: "configured via the model-lane picker, not a plain description field",
  titleSummarizerFallbackModelId: "configured via the model-lane picker, not a plain description field",
  titleSummarizerGlobalProvider: "configured via the model-lane picker, not a plain description field",
  titleSummarizerGlobalModelId: "configured via the model-lane picker, not a plain description field",
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
  executionGlobalThinkingLevel: "inline thinking companion for the global execution lane, configured via the model-lane picker, not a plain description field",
  planningGlobalThinkingLevel: "inline thinking companion for the global planning lane, configured via the model-lane picker, not a plain description field",
  validatorGlobalThinkingLevel: "inline thinking companion for the global validator lane, configured via the model-lane picker, not a plain description field",
  titleSummarizerGlobalThinkingLevel: "inline thinking companion for the global title-summarizer lane, configured via the model-lane picker, not a plain description field",
  defaultThinkingLevelOverride: "project-scoped Default-lane inline thinking companion, configured via the model-lane picker, not a plain description field",
  titleSummarizerThinkingLevel: "project title-summarizer inline thinking companion, configured via the model-lane picker, not a plain description field",
  titleSummarizerFallbackThinkingLevel: "project title-summarizer fallback inline thinking companion, configured via the model-lane picker, not a plain description field",
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
  mergeDiffVolumeMinLines: "not yet exposed as a distinct Settings field",
  mergeDiffVolumeThreshold: "not yet exposed as a distinct Settings field",
  mergeDiffVolumeAllowlist: "not yet exposed as a distinct Settings field",
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
  metaTaskStallAutoCloseMs: "internal reliability tuning constant, no UI field",
  metaTaskActiveExecutionGraceMs: "internal reliability tuning constant, no UI field",
  boardStallSweepWindowMs: "internal reliability tuning constant, no UI field",
  boardStallBlockedGrowthThreshold: "internal reliability tuning constant, no UI field",
  backlogPressureAlertEnabled: "internal reliability tuning constant, no UI field",
  backlogPressureRatioThreshold: "internal reliability tuning constant, no UI field",
  backlogPressureMinTodoCount: "internal reliability tuning constant, no UI field",
  backlogPressureAlertCooldownMs: "internal reliability tuning constant, no UI field",
  dependencyBlockedTodoReportEnabled: "internal reliability tuning constant, no UI field",
  dependencyBlockedTodoFreshAgeMs: "internal reliability tuning constant, no UI field",
  dependencyBlockedTodoStaleAgeMs: "internal reliability tuning constant, no UI field",
  dependencyBlockedTodoMinCount: "internal reliability tuning constant, no UI field",
  dependencyBlockedTodoReportCooldownMs: "internal reliability tuning constant, no UI field",
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
  doneAutoArchiveDays: "legacy alias superseded by autoArchiveDoneAfterMs, no UI field",
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
  maxSpawnedAgentsPerParent: "internal spawn-limit constant, no UI field",
  maxSpawnedAgentsGlobal: "internal spawn-limit constant, no UI field",
};

describe("FN-7505 settings default-value description guard", () => {
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
