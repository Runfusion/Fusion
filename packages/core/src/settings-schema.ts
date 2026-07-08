import { DEFAULT_MAX_AUTO_MERGE_RETRIES } from "./in-review-stall.js";
import type { CliAgentSettings, GlobalSettings, McpSecretRef, McpServerDefinition, ProjectSettings, Settings } from "./types.js";

export interface MergeRequestContractShadowSettingsSource {
  mergeRequestContractShadowEnabled?: boolean;
}

type CompleteSettings<T> = { [K in keyof Required<T>]: Required<T>[K] | undefined };

/**
 * The settings keys hard-MOVED to workflow settings in U4 (see
 * `moved-settings.ts`). They are REMOVED from `DEFAULT_PROJECT_SETTINGS` (so they
 * leave `PROJECT_SETTINGS_KEYS` / the save-split), but their FIELDS are retained
 * on the `ProjectSettings` type for the engine's flat `settings.<key>` reads and
 * the U3 effective-settings merge. `DEFAULT_PROJECT_SETTINGS` is therefore
 * type-checked against `ProjectSettings` MINUS these keys — the type-vs-schema
 * split documented in `moved-settings.ts`.
 *
 * This union is NOT compile-time-enforced against `MOVED_SETTINGS_KEYS`.
 * Enforcement lives in `src/__tests__/settings-consistency.test.ts` (every key
 * must belong to exactly one regime). A STALE entry here only loosens the `Omit`
 * type — at worst it lets `DEFAULT_PROJECT_SETTINGS` drop a key it should keep;
 * it can never re-add a key to the schema object. A MISSING entry surfaces as a
 * type error on `DEFAULT_PROJECT_SETTINGS` if that key still has a default.
 */
type MovedProjectSettingsKey =
  | "workflowStepTimeoutMs"
  | "workflowStepScopeEnforcement"
  | "planOnlyScopeLeakEnforcement"
  | "workflowRevisionForkOnScopeMismatch"
  | "strictScopeEnforcement"
  | "runStepsInNewSessions"
  | "maxParallelSteps"
  | "buildRetryCount"
  | "verificationFixRetries"
  | "maxPostReviewFixes"
  | "requirePrApproval"
  | "requirePlanApproval"
  | "reviewHandoffPolicy"
  | "maxReviewerContextRetries"
  | "maxReviewerFallbackRetries"
  | "reflectionEnabled"
  | "executionProvider"
  | "executionModelId"
  | "planningProvider"
  | "planningModelId"
  | "planningFallbackProvider"
  | "planningFallbackModelId"
  | "validatorProvider"
  | "validatorModelId"
  | "validatorFallbackProvider"
  | "validatorFallbackModelId";

type ProjectSettingsSchema = Omit<ProjectSettings, MovedProjectSettingsKey>;

/**
 * Settings schema source of truth.
 *
 * The default objects intentionally include optional keys with `undefined`
 * values so `Object.keys()` can derive complete scope key lists. This keeps
 * persistence filters, UI save splitting, and parity tests aligned.
 */

/** Default values for global (user-level) settings. */
export const DEFAULT_GLOBAL_SETTINGS = {
  /*
  FNXC:DashboardTheming 2026-07-03-00:00:
  Fresh installs must follow the operating system theme until the user explicitly chooses Light, Dark, or System. Keep this global default aligned with dashboard and desktop pre-hydration fallbacks.
  */
  themeMode: "system",
  /*
  FNXC:DashboardTheming 2026-06-30-00:00:
  New users and unset installs should start on Shadcn Ember. Existing users who explicitly stored colorTheme "default", "ocean", or another valid theme must remain on that selection, so the ids stay valid and only the absence/default seed changes to "shadcn-ember".
  */
  colorTheme: "shadcn-ember",
  shadcnCustomColors: undefined,
  dashboardFontScalePct: 100,
  /*
  FNXC:DashboardShortcuts 2026-07-04-00:00:
  Global dashboard shortcuts must hydrate with documented safe defaults even when old settings files are missing the object. Space opens Quick Chat; Ctrl+` opens Terminal without colliding with common browser find/search accelerators. FN-7553 adds openFiles (Ctrl+E), openSettings (Ctrl+,), openCommandCenter (Ctrl+K), and newTask (Ctrl+Shift+N) — chosen to avoid colliding with the base two or each other. Empty strings are preserved so operators can disable an action.
  */
  dashboardKeyboardShortcuts: {
    quickChat: "Space",
    terminal: "Ctrl+`",
    openFiles: "Ctrl+E",
    openSettings: "Ctrl+,",
    openCommandCenter: "Ctrl+K",
    newTask: "Ctrl+Shift+N",
  },
  /*
  FNXC:ModalDismissal 2026-06-29-00:00:
  Fixed dashboard modals must ignore backdrop clicks by default so accidental outside taps do not discard in-progress form state. Operators can globally opt in to the legacy outside-click dismissal behavior.
  */
  dismissModalsOnOutsideClick: false,
  language: undefined,
  defaultProvider: undefined,
  defaultModelId: undefined,
  testMode: undefined,
  modelPricingOverrides: undefined,
  modelPricingFetchedAt: undefined,
  modelPricingSource: undefined,
  modelRouterEnabled: undefined,
  modelRouterCheapProvider: undefined,
  modelRouterCheapModelId: undefined,
  mergeRequestContractShadowEnabled: false,
  fallbackProvider: undefined,
  fallbackModelId: undefined,
  defaultThinkingLevel: undefined,
  ntfyEnabled: false,
  ntfyTopic: undefined,
  ntfyBaseUrl: undefined,
  ntfyAccessToken: undefined,
  ntfyEvents: [
    "in-review",
    "merged",
    "failed",
    "awaiting-approval",
    "awaiting-user-review",
    "planning-awaiting-input",
    "cli-agent-awaiting-input",
    "message:agent-to-user",
    "message:agent-to-agent",
    "message:room",
    "gridlock",
    "board-stall-unrecovered",
    "fallback-used",
    "memory-dreams-processed",
    "token-budget",
  ],
  ntfyDashboardHost: undefined,
  taskTokenBudget: undefined,
  failureNotificationDelayMs: 30000,
  failureNotificationMode: "sticky-only",
  webhookEnabled: false,
  webhookUrl: undefined,
  webhookFormat: "generic",
  webhookEvents: [],
  notificationProviders: [],
  customProviders: [],
  defaultProjectId: undefined,
  setupComplete: undefined,
  cliOnboardingCompletedAt: undefined,
  favoriteProviders: undefined,
  favoriteModels: undefined,
  openrouterModelSync: true,
  openrouterAppAttribution: undefined,
  openrouterModelFilters: undefined,
  openrouterProviderPreferences: undefined,
  opencodeGoModelSync: true,
  updateCheckEnabled: true,
  fnBinaryCheckEnabled: true,
  updateCheckFrequency: "daily",
  autoReloadOnVersionChange: true,
  githubTrackingDefaultRepo: undefined,
  gitlabEnabled: undefined,
  gitlabInstanceUrl: undefined,
  gitlabApiBaseUrl: undefined,
  gitlabAuthToken: undefined,
  gitlabAuthTokenType: undefined,
  modelOnboardingComplete: undefined,
  useClaudeCli: undefined,
  useDroidCli: undefined,
  useLlamaCpp: undefined,
  useCursorCli: undefined,
  /*
  FNXC:CursorCli 2026-07-02-00:00:
  Cursor CLI binary overrides are global operator settings because executable locations are machine-local. Blank/undefined preserves PATH auto-detection through cursor-agent and cursor.
  */
  cursorCliBinaryPath: undefined,
  // Global baseline lanes for per-role model selection
  executionGlobalProvider: undefined,
  executionGlobalModelId: undefined,
  planningGlobalProvider: undefined,
  planningGlobalModelId: undefined,
  validatorGlobalProvider: undefined,
  validatorGlobalModelId: undefined,
  titleSummarizerGlobalProvider: undefined,
  titleSummarizerGlobalModelId: undefined,
  // Daemon mode settings
  daemonToken: undefined,
  daemonPort: 4040,
  daemonHost: "127.0.0.1",
  // Node settings sync
  settingsSyncEnabled: false,
  settingsSyncAuth: false,
  settingsSyncInterval: 900000,
  settingsSyncConflictResolution: "last-write-wins",
  // Dashboard session state (persisted to global settings for PWA/offline restore)
  dashboardCurrentNodeId: undefined,
  dashboardCurrentProjectIdByNode: undefined,
  // Dashboard TUI memory guard
  vitestAutoKillEnabled: true,
  vitestKillThresholdPct: 90,
  // Agent log persistence controls
  /*
  FNXC:AgentLogs 2026-06-23-00:00:
  Verbose tool arguments and results are default-off to reduce persisted log volume and payload exposure. Operators who need saved tool details can explicitly opt in with persistAgentToolOutput: true; tool timeline rows remain logged either way.
  */
  persistAgentToolOutput: false,
  persistAgentThinkingLogPermanent: false,
  persistAgentThinkingLogEphemeral: false,
  persistAgentThinkingLog: false,
  agentMemoryInclusionMode: "full",
  secretsAccessPolicy: undefined,
  secretsSyncPassphraseConfigured: false,
  researchGlobalDefaults: {
    searchProvider: undefined,
    synthesisProvider: undefined,
    synthesisModelId: undefined,
    enabledSources: {
      webSearch: true,
      pageFetch: true,
      github: false,
      localDocs: true,
      llmSynthesis: true,
    },
    maxSourcesPerRun: 20,
    defaultExportFormat: "markdown",
  },
  researchGlobalEnabled: true,
  researchGlobalMaxConcurrentRuns: 3,
  researchGlobalDefaultTimeout: 300000,
  researchGlobalMaxSourcesPerRun: 20,
  researchGlobalMaxSynthesisRounds: 2,
  researchGlobalWebSearchProvider: "builtin",
  researchGlobalSearxngUrl: undefined,
  researchGlobalBraveApiKey: undefined,
  researchGlobalGoogleSearchApiKey: undefined,
  researchGlobalGoogleSearchCx: undefined,
  researchGlobalTavilyApiKey: undefined,
  researchGlobalGitHubEnabled: false,
  researchGlobalLocalDocsEnabled: true,
  researchGlobalMaxSearchResults: 10,
  researchGlobalFetchTimeoutMs: 30_000,
  researchGlobalUserAgent: "FusionResearchBot/1.0",
  mcpServers: {
    enabled: false,
    servers: [],
  },
  remoteAccess: {
    activeProvider: null,
    providers: {
      tailscale: {
        enabled: false,
        hostname: "",
        targetPort: 0,
        acceptRoutes: false,
      },
      cloudflare: {
        enabled: false,
        quickTunnel: true,
        tunnelName: "",
        tunnelToken: null,
        ingressUrl: "",
      },
    },
    tokenStrategy: {
      persistent: {
        enabled: true,
        token: null,
      },
      shortLived: {
        enabled: false,
        ttlMs: 900000,
        maxTtlMs: 86400000,
      },
    },
    lifecycle: {
      rememberLastRunning: false,
      wasRunningOnShutdown: false,
      lastRunningProvider: null,
    },
  },
  worktrunk: {
    enabled: false,
    binaryPath: undefined,
    installedBinaryPath: undefined,
    onFailure: "fail",
  },
  owningNodeHandoffPolicy: "reassign-to-local",
  /*
  FNXC:WorkflowSettings 2026-06-22-18:05:
  New installs default dual-observe parity diagnostics explicitly off unless an operator opts in outside the normal Settings UI.

  FNXC:WorkflowSettings 2026-06-22-18:00:
  workflowGraphExecutor and workflowColumns are no longer experimental settings. The workflow graph engine and workflow-defined columns are the default runtime paths; stale persisted values are tolerated but no default flags are emitted.
  */
  experimentalFeatures: {
    workflowInterpreterDualObserve: false,
  },
  cliAgents: {},
} satisfies CompleteSettings<GlobalSettings>;

/** Default values for project-level settings. */
export const DEFAULT_PROJECT_SETTINGS = {
  globalPause: false,
  globalPauseReason: undefined,
  defaultWorkflowId: undefined,
  // FNXC:TaskRevert 2026-07-05-00:00 (FN-7556): AI-undo tasks reverse
  // already-shipped code, so default them to the stricter review-heavy
  // workflow; empty/unset means inherit the project default workflow.
  aiUndoTaskWorkflowId: "builtin:review-heavy",
  enabledBuiltinWorkflowIds: undefined,
  approvedWorkflowCliCommands: undefined,
  approvedCliAutonomyAdapters: undefined,
  enginePaused: false,
  engineLastActiveAt: undefined,
  maxConcurrent: 2,
  maxTriageConcurrent: 2,
  globalMaxConcurrent: 4,
  maxWorktrees: 4,
  pollIntervalMs: 15000,
  heartbeatMultiplier: 1,
  autoClaimCandidatesInPrompt: 5,
  engineerBacklogAutoClaim: false,
  tombstoneStickyWindowDays: 7,
  heartbeatScopeDiscipline: "strict",
  heartbeatPromptTemplate: "default",
  groupOverlappingFiles: true,
  ignoreHiddenOverlapPaths: true,
  overlapIgnorePaths: [],
  /*
  FNXC:FileBrowser 2026-06-29-00:00:
  Absolute file-browser paths are disabled unless a project explicitly opts in, preserving the workspace boundary for normal installs while allowing local admin browsing through the same file-size, binary, type, and permission checks.
  */
  allowAbsoluteFileBrowserPaths: false,
  autoMerge: true,
  /*
  FNXC:PlanApproval 2026-07-04-00:00:
  FN-7557: plan auto-approval is the default project posture; unset projects bypass the manual awaiting-approval gate. Previously defaulted to "workflow" (deferring to each workflow's requirePlanApproval); projects with an explicit stored value are unaffected.
  */
  planApprovalMode: "auto-approve-all",
  // U18 (R15): the Review-response loop is default-on. Independent of `autoMerge` —
  // with this on but auto-merge off, review threads are resolved but the PR is not merged.
  autoResolveReviewComments: true,
  testMode: undefined,
  mergeRequestContractShadowEnabled: false,
  mergeStrategy: "direct",
  directMergeCommitStrategy: "always-squash",
  mergeIntegrationWorktree: "reuse-task-worktree",
  mergeAdvanceAutoSync: "stash-and-ff",
  integrationBranch: undefined,
  // `requirePrApproval` MOVED to workflow settings (U4) — see MOVED_SETTINGS_KEYS.
  pushAfterMerge: false,
  pushRemote: "origin",
  unavailableNodePolicy: "block",
  owningNodeHandoffPolicy: "reassign-to-local",
  defaultNodeId: undefined,
  secretsEnv: undefined,
  mcpServers: {
    enabled: false,
    servers: [],
  },
  worktreeInitCommand: undefined,
  /*
  FNXC:WorktreeCopyFiles 2026-06-24-00:00:
  The safe default is an empty allowlist so new worktrees never copy potentially sensitive repository files until the project owner explicitly configures root-relative regular-file paths.
  */
  worktreeCopyFiles: [],
  testCommand: undefined,
  buildCommand: undefined,
  recycleWorktrees: false,
  showWorktreeGrouping: false,
  openTasksInRightSidebar: false,
  /*
  FNXC:MobileTaskPopups 2026-07-01-12:00:
  Default off preserves current board-card task detail behavior. The dashboard only consults this project setting for ordinary board-card clicks without a deep tab across mobile, tablet, and desktop viewports, and reuses the existing task pop-out surface before falling back to right-dock or main-panel routing.
  */
  openMobileTasksInPopup: false,
  /*
  FNXC:TaskDetailActivityFirst 2026-06-30-23:59:
  Project task-detail defaults are Activity-first unless this opt-in is true. Keeping the default false preserves explicit deep-link ids while making omitted non-done task opens land on Activity → Live.
  */
  taskDetailChatFirst: false,
  executorAllowSiblingBranchRename: false,
  worktreeNaming: "random",
  worktrunk: {
    enabled: false,
    binaryPath: undefined,
    installedBinaryPath: undefined,
    onFailure: "fail",
  },
  worktreesDir: undefined,
  taskPrefix: undefined,
  taskAttributionTrailerNames: ["Fusion-Task-Id"],
  commitMsgHookEnabled: true,
  includeTaskIdInCommit: true,
  commitAuthorEnabled: true,
  commitAuthorName: "Fusion",
  commitAuthorEmail: "noreply@runfusion.ai",
  // Per-phase model lanes (planning/execution/validator) MOVED to workflow
  // settings (U4) — see MOVED_SETTINGS_KEYS. The GLOBAL baseline lanes
  // (executionGlobalProvider etc.) stay global; project default overrides stay.
  // Project-level default override (NOT moved — stays project-scoped)
  defaultProviderOverride: undefined,
  defaultModelIdOverride: undefined,
  modelPresets: [],
  autoSelectModelPreset: false,
  completionDocumentationMode: "off",
  defaultPresetBySize: {},
  autoResolveConflicts: true,
  smartConflictResolution: true,
  mergerAutostashMaxAgeHours: 24,
  worktreeRebaseBeforeMerge: true,
  worktreeRebaseRemote: "",
  worktreeRebaseLocalBase: true,
  prerebaseAutoEnabled: true,
  prerebaseHotFiles: [
    "AGENTS.md",
    "packages/core/src/store.ts",
    "packages/core/src/db.ts",
    "packages/engine/src/executor.ts",
    "packages/engine/src/scheduler.ts",
    "packages/engine/src/merger.ts",
    "packages/dashboard/app/styles.css",
  ],
  prerebaseDivergenceThreshold: 50,
  mergeConflictStrategy: "smart-prefer-main",
  /**
   * FNXC:AutoMergeRetries 2026-06-17-04:20:
   * Project settings own the auto-merge conflict retry cap because existing engine/dashboard consumers already resolve project settings; the default imports core's stall-detection fallback to keep every surface on the historical value of 3.
   */
  maxAutoMergeRetries: DEFAULT_MAX_AUTO_MERGE_RETRIES,
  /**
   * FNXC:Merge 2026-06-26-00:00:
   * New and unconfigured projects default AI merge to sync a dirty checked-out integration branch, restoring the legacy stash → fast-forward → restore landing behavior. Explicit persisted merger.allowDirtyLocalCheckoutSync values still win, and no existing-project migration stamps this default into storage.
   */
  merger: { mode: "ai", maxReviewPasses: 3, allowDirtyLocalCheckoutSync: true },
  mergeDiffVolumeMinLines: undefined,
  mergeDiffVolumeThreshold: undefined,
  mergeDiffVolumeAllowlist: undefined,
  mergeStrategyOverlapBehavior: "flip-to-prefer-branch",
  postMergeAuditMode: "warn",
  mergeAuditAutoRecovery: "ai-assisted",
  autoRecovery: {
    mode: "deterministic-only",
    maxRetries: 3,
  },
  reliabilityStatsResetAt: undefined,
  // Step-execution knobs (workflowStepTimeoutMs, workflowStepScopeEnforcement,
  // planOnlyScopeLeakEnforcement, workflowRevisionForkOnScopeMismatch,
  // strictScopeEnforcement, buildRetryCount, verificationFixRetries,
  // requirePlanApproval) MOVED to workflow settings (U4) — see
  // MOVED_SETTINGS_KEYS. `planApprovalMode`, `buildTimeoutMs`, and `verificationCommandTimeoutMs`
  // are NOT moved and stay plain project settings. Keep verificationCommandTimeoutMs
  // undefined so fn_run_verification preserves legacy per-scope defaults until a
  // project opts into a single default budget.
  buildTimeoutMs: 300_000,
  verificationCommandTimeoutMs: undefined,
  // FNXC:Verification 2026-06-25-00:00: default-on file-scoped verification —
  // run only the branch diff's own test files so merge verification stays
  // proportional to the change; the thin merge gate carries cross-cutting
  // coverage. Falls back to package/explicit command when no tests resolve.
  scopeVerificationToChangedFiles: true,
  ephemeralAgentsEnabled: true,
  /*
  FNXC:EphemeralAgentTaskCreation 2026-07-01-00:00:
  Default-on so ephemeral task-worker agents keep the ability to open follow-up tasks via fn_task_create. Operators who want to confine task creation to humans/permanent agents flip this off.
  */
  ephemeralAgentsCanCreateTasks: true,
  agentProvisioning: {},
  sandboxProvisioning: {},
  defaultAgentPermissionPolicy: undefined,
  specStalenessEnabled: false,
  specStalenessMaxAgeMs: 6 * 60 * 60 * 1000,
  taskStuckTimeoutMs: 600_000,
  /** Number of rapid todo↔in-progress cycles allowed before auto-pausing the task. */
  dispatchOscillationThreshold: 5,
  /** Sliding time window used to count rapid todo↔in-progress cycles. */
  dispatchOscillationWindowMs: 60_000,
  /** Delay before scheduler may re-dispatch an engine-requeued todo task. */
  dispatchOscillationSettleMs: 5_000,
  runtimeStopDrainMs: 2_000,
  engineActiveSinceMs: undefined,
  engineActivationGraceMs: 5 * 60_000,
  inReviewStallDeadlockThreshold: 3,
  stalePausedReviewThresholdMs: 24 * 60 * 60_000,
  inReviewStalledThresholdMs: 24 * 60 * 60_000,
  stalePausedTodoThresholdMs: 24 * 60 * 60_000,
  pausedScopeDecayMs: 30 * 60_000,
  metaTaskStallAutoCloseMs: 2 * 60 * 60_000,
  metaTaskActiveExecutionGraceMs: 30 * 60_000,
  boardStallSweepWindowMs: 2 * 60 * 60_000,
  boardStallBlockedGrowthThreshold: 3,
  // Capacity risk warning default: only warn once todo is meaningfully backlogged.
  capacityRiskBannerEnabled: false,
  capacityRiskTodoThreshold: 20,
  backlogPressureAlertEnabled: true,
  backlogPressureRatioThreshold: 10,
  backlogPressureMinTodoCount: 5,
  backlogPressureAlertCooldownMs: 24 * 60 * 60_000,
  dependencyBlockedTodoReportEnabled: true,
  dependencyBlockedTodoFreshAgeMs: 30 * 60_000,
  dependencyBlockedTodoStaleAgeMs: 4 * 60 * 60_000,
  dependencyBlockedTodoMinCount: 1,
  dependencyBlockedTodoReportCooldownMs: 6 * 60 * 60_000,
  staleHighFanoutBlockerAgeThresholdMs: 2 * 60 * 60 * 1000,
  staleInProgressWarningMs: 4 * 60 * 60_000,
  staleInProgressCriticalMs: 24 * 60 * 60_000,
  staleInReviewWarningMs: 24 * 60 * 60_000,
  staleInReviewCriticalMs: 3 * 24 * 60 * 60_000,
  aiSessionTtlMs: 7 * 24 * 60 * 60 * 1000,
  aiSessionCleanupIntervalMs: 60 * 60 * 1000,
  autoUnpauseEnabled: true,
  autoUnpauseBaseDelayMs: 300_000,
  autoUnpauseMaxDelayMs: 3_600_000,
  maxStuckKills: 6,
  maxBranchConflictRecoveries: 5,
  // maxReviewerContextRetries / maxReviewerFallbackRetries MOVED to workflow
  // settings (U4) — see MOVED_SETTINGS_KEYS.
  maxTotalRetriesBeforeFail: 25,
  preserveProgressOnStuckRequeue: true,
  // maxPostReviewFixes MOVED to workflow settings (U4).
  maxSpawnedAgentsPerParent: 5,
  maxSpawnedAgentsGlobal: 20,
  // Run maintenance (including WAL checkpointing) every 5 minutes by default.
  maintenanceIntervalMs: 300_000,
  autoArchiveDoneTasksEnabled: true,
  autoArchiveDoneAfterMs: 48 * 60 * 60 * 1000,
  doneAutoArchiveDays: 0,
  // FNXC:DuplicateIntake 2026-07-07-00:00 (FN-7658): default OFF — operators
  // decide via the near-duplicate flag/UI instead of tasks silently vanishing
  // into `archived` during intake. Set true to restore the pre-FN-7658 behavior.
  autoArchiveDuplicateTasksEnabled: false,
  archiveAgentLogMode: "compact",
  autoUpdatePrStatus: false,
  githubCommentOnDone: false,
  githubCommentTemplate: undefined,
  githubCloseSourceIssueOnDone: false,
  githubTrackingEnabledByDefault: false,
  githubLinkImportedIssuesToTracking: false,
  githubTrackingDefaultRepo: undefined,
  gitlabEnabled: undefined,
  gitlabInstanceUrl: undefined,
  gitlabApiBaseUrl: undefined,
  gitlabAuthToken: undefined,
  gitlabAuthTokenType: undefined,
  gitlabCommentOnDone: false,
  gitlabCommentTemplate: undefined,
  gitlabCloseSourceIssueOnDone: false,
  githubTrackingDedupEnabled: true,
  githubAuthMode: "gh-cli",
  githubAuthToken: undefined,
  autoBackupEnabled: false,
  autoBackupSchedule: "0 2 * * *",
  autoBackupRetention: 7,
  autoBackupDir: ".fusion/backups",
  memoryBackupEnabled: false,
  memoryBackupSchedule: "0 3 * * *",
  memoryBackupRetention: 14,
  memoryBackupDir: ".fusion/backups/memory",
  memoryBackupScope: "all" as const,
  autoSummarizeTitles: false,
  useAiMergeCommitSummary: true,
  // Title-summarizer model lanes stay project-scoped (not moved in U4).
  titleSummarizerProvider: undefined,
  titleSummarizerModelId: undefined,
  titleSummarizerFallbackProvider: undefined,
  titleSummarizerFallbackModelId: undefined,
  prTitlePromptInstructions: undefined,
  prDescriptionPromptInstructions: undefined,
  scripts: undefined,
  setupScript: undefined,
  insightExtractionEnabled: false,
  insightExtractionSchedule: "0 2 * * *",
  insightExtractionMinIntervalMs: 86_400_000,
  taskEvaluationEnabled: false,
  taskEvaluationSchedule: "0 5 * * *",
  taskEvaluationProvider: undefined,
  taskEvaluationModelId: undefined,
  taskEvaluationFollowUpPolicy: "off",
  taskEvaluationRetention: undefined,
  memoryEnabled: true,
  memoryBackendType: "qmd",
  memoryAutoSummarizeEnabled: false,
  memoryAutoSummarizeThresholdChars: 50_000,
  memoryAutoSummarizeSchedule: "0 3 * * *",
  memoryDreamsEnabled: false,
  memoryDreamsSchedule: "0 4 * * *",
  tokenCap: undefined,
  taskTokenBudget: undefined,
  // runStepsInNewSessions / maxParallelSteps MOVED to workflow settings (U4) —
  // see MOVED_SETTINGS_KEYS.
  missionStaleThresholdMs: 600_000,
  missionMaxTaskRetries: 3,
  missionHealthCheckIntervalMs: 300_000,
  agentPrompts: undefined,
  promptOverrides: undefined,
  // reflectionEnabled MOVED to workflow settings (U4). reflectionIntervalMs /
  // reflectionAfterTask have no engine reader, so they STAY plain project
  // settings (catalog-shrink rule) and are NOT in MOVED_SETTINGS_KEYS.
  reflectionIntervalMs: 3_600_000,
  reflectionAfterTask: true,
  // reviewHandoffPolicy MOVED to workflow settings (U4) — see MOVED_SETTINGS_KEYS.
  quickChatButtonMode: "off",
  /*
  FNXC:ChatModal 2026-06-28-00:00:
  Quick Chat outside-click dismissal remains default-on for upgrades, but it is now a project setting so operators can disable accidental board-click closes.
  */
  quickChatCloseOnOutsideClick: true,
  showQuickChatFAB: false,
  /*
  FNXC:ChatModal 2026-07-01-00:00:
  Task-scoped planner chats stay available from each task's Chat tab, but the common Chat feed hides them by default. This project-level opt-in preserves the previous populated-task-chat feed behavior only for operators who request it.
  */
  showTaskChatsInCommonFeed: false,
  chatAutoCleanupDays: 0,
  mailAutoCleanupDays: 0,
  operationalLogRetentionDays: 30,
  agentLogFileRetentionDays: 0,
  chatRoomRecentVerbatimMessages: 25,
  chatRoomCompactionFetchLimit: 200,
  chatRoomSummaryMaxChars: 3_000,
  researchSettings: {
    enabled: true,
    searchProvider: undefined,
    synthesisProvider: undefined,
    synthesisModelId: undefined,
    enabledSources: {
      webSearch: true,
      pageFetch: true,
      github: false,
      localDocs: true,
      llmSynthesis: true,
    },
    limits: {
      maxConcurrentRuns: 3,
      maxSourcesPerRun: 20,
      maxDurationMs: 300000,
      requestTimeoutMs: 30000,
    },
  },
  sandbox: {
    backend: "native",
    policy: {
      allowNetwork: true,
      allowedPaths: [],
    },
    failureMode: "fail-hard",
  },
  evalSettings: {
    enabled: false,
    intervalMs: 86_400_000,
    evaluatorProvider: undefined,
    evaluatorModelId: undefined,
    followUpPolicy: "suggest-only",
    retentionDays: 30,
  },
  researchEnabled: true,
  researchMaxConcurrentRuns: 3,
  researchDefaultTimeout: 300000,
  researchMaxSourcesPerRun: 20,
  researchMaxSynthesisRounds: 2,
  workspaceMode: undefined,
} satisfies CompleteSettings<ProjectSettingsSchema>;

/**
 * Merged default settings (backward compatible).
 * This combines global and project defaults into a single object
 * that matches the legacy `DEFAULT_SETTINGS` shape.
 */
export const DEFAULT_SETTINGS: Settings = {
  ...DEFAULT_GLOBAL_SETTINGS,
  ...DEFAULT_PROJECT_SETTINGS,
};

/** Keys that belong to the global settings scope. */
export const GLOBAL_SETTINGS_KEYS = Object.freeze(
  Object.keys(DEFAULT_GLOBAL_SETTINGS) as Array<keyof GlobalSettings>,
);

/** Keys that belong to the project settings scope. */
export const PROJECT_SETTINGS_KEYS = Object.freeze(
  Object.keys(DEFAULT_PROJECT_SETTINGS) as Array<keyof ProjectSettings>,
);

export function isGlobalSettingsKey(key: string): key is keyof GlobalSettings {
  return (GLOBAL_SETTINGS_KEYS as readonly string[]).includes(key);
}

export function isProjectSettingsKey(key: string): key is keyof ProjectSettings {
  return (PROJECT_SETTINGS_KEYS as readonly string[]).includes(key);
}

export function isGlobalOnlySettingsKey(key: string): key is keyof GlobalSettings {
  return isGlobalSettingsKey(key) && !isProjectSettingsKey(key);
}

export function isMergeRequestContractShadowEnabled(
  sources:
    | {
        project?: MergeRequestContractShadowSettingsSource;
        global?: MergeRequestContractShadowSettingsSource;
      }
    | MergeRequestContractShadowSettingsSource
    | undefined,
): boolean {
  if (!sources) return false;

  const scoped = sources as {
    project?: MergeRequestContractShadowSettingsSource;
    global?: MergeRequestContractShadowSettingsSource;
  };
  if (typeof scoped.project !== "undefined" || typeof scoped.global !== "undefined") {
    const projectValue = scoped.project?.mergeRequestContractShadowEnabled;
    if (typeof projectValue === "boolean") return projectValue;
    return scoped.global?.mergeRequestContractShadowEnabled === true;
  }

  return (sources as MergeRequestContractShadowSettingsSource).mergeRequestContractShadowEnabled === true;
}

export function resolvePersistAgentThinkingLog(
  settings: Partial<GlobalSettings> | undefined,
  opts: { ephemeral: boolean },
): boolean {
  const granular = opts.ephemeral
    ? settings?.persistAgentThinkingLogEphemeral
    : settings?.persistAgentThinkingLogPermanent;

  if (typeof granular === "boolean") return granular;
  if (typeof settings?.persistAgentThinkingLog === "boolean") return settings.persistAgentThinkingLog;
  return false;
}

// ── CLI-agent settings sanitization (U15) ───────────────────────────────────

/** Adapter ids accepted in `cliAgents`. Unknown ids are dropped at the write
 *  boundary so a settings file cannot carry config for non-existent adapters. */
export const CLI_AGENT_ADAPTER_IDS = Object.freeze([
  "claude-code",
  "codex",
  "droid",
  "pi",
  "generic",
] as const);

/** Autonomy modes accepted in a `CliAgentSettings` entry. */
export const CLI_AGENT_AUTONOMY_MODES = Object.freeze(["default", "elevated"] as const);

function sanitizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Sanitize a single adapter's launch settings (U15). Drops unknown fields and
 * invalid values; returns `undefined` when nothing survives (so the caller can
 * omit an empty entry). Pure — no I/O.
 *
 * Validation rules:
 * - `commandOverride`: non-empty trimmed string, else dropped.
 * - `extraArgs` / `envAdditions`: arrays of non-empty trimmed strings, else dropped.
 * - `autonomyMode`: one of CLI_AGENT_AUTONOMY_MODES, else dropped (falls back to
 *   the adapter baseline at resolution time).
 */
export function sanitizeCliAgentSettings(value: unknown): CliAgentSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const out: CliAgentSettings = {};

  if (typeof input.commandOverride === "string") {
    const trimmed = input.commandOverride.trim();
    if (trimmed.length > 0) out.commandOverride = trimmed;
  }

  const extraArgs = sanitizeStringArray(input.extraArgs);
  if (extraArgs) out.extraArgs = extraArgs;

  const envAdditions = sanitizeStringArray(input.envAdditions);
  if (envAdditions) out.envAdditions = envAdditions;

  if (
    typeof input.autonomyMode === "string" &&
    (CLI_AGENT_AUTONOMY_MODES as readonly string[]).includes(input.autonomyMode)
  ) {
    out.autonomyMode = input.autonomyMode as CliAgentSettings["autonomyMode"];
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Sanitize the whole `cliAgents` map at the write boundary (U15). Drops unknown
 * adapter ids and any entry that sanitizes to nothing. Returns a fresh object;
 * always returns an object (possibly empty) so the field round-trips cleanly.
 */
export function sanitizeCliAgentsSettings(value: unknown): Record<string, CliAgentSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const out: Record<string, CliAgentSettings> = {};
  for (const adapterId of CLI_AGENT_ADAPTER_IDS) {
    if (!(adapterId in input)) continue;
    const entry = sanitizeCliAgentSettings(input[adapterId]);
    if (entry) out[adapterId] = entry;
  }
  return out;
}

function sanitizeMcpSecretRef(value: unknown): McpSecretRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.secretRef !== "string") return undefined;
  const secretRef = input.secretRef.trim();
  if (!secretRef || (input.scope !== "project" && input.scope !== "global")) return undefined;
  return { secretRef, scope: input.scope };
}

function sanitizeMcpSensitiveMap(value: unknown): Record<string, McpSecretRef> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, McpSecretRef> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key) continue;
    const ref = sanitizeMcpSecretRef(rawValue);
    if (ref) out[key] = ref;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeMcpServerDefinition(value: unknown): McpServerDefinition | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.name !== "string") return undefined;
  const name = input.name.trim();
  if (!name) return undefined;
  const enabled = typeof input.enabled === "boolean" ? input.enabled : undefined;
  const base = { name, ...(enabled !== undefined ? { enabled } : {}) };

  if (input.transport === "stdio") {
    if (typeof input.command !== "string" || input.command.trim().length === 0) return undefined;
    const args = sanitizeStringArray(input.args);
    const env = sanitizeMcpSensitiveMap(input.env);
    return {
      ...base,
      transport: "stdio",
      command: input.command.trim(),
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
    };
  }

  if (input.transport === "sse" || input.transport === "streamable-http") {
    if (typeof input.url !== "string" || input.url.trim().length === 0) return undefined;
    const headers = sanitizeMcpSensitiveMap(input.headers);
    return {
      ...base,
      transport: input.transport,
      url: input.url.trim(),
      ...(headers ? { headers } : {}),
    };
  }

  return undefined;
}

/**
 * Sanitize MCP settings at the write boundary. Malformed server declarations are
 * dropped, duplicate names collapse to the last valid declaration, and sensitive
 * env/header values survive only as Fusion secret references. Pure — no I/O.
 */
export function sanitizeMcpServers(value: unknown): { enabled?: boolean; servers: McpServerDefinition[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { enabled: false, servers: [] };
  }
  const input = value as Record<string, unknown>;
  const byName = new Map<string, McpServerDefinition>();
  if (Array.isArray(input.servers)) {
    for (const rawServer of input.servers) {
      const server = sanitizeMcpServerDefinition(rawServer);
      if (server) byName.set(server.name, server);
    }
  }
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : false,
    servers: [...byName.values()],
  };
}
