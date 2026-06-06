import type { CliAgentSettings, GlobalSettings, ProjectSettings, Settings } from "./types.js";

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
  | "validatorFallbackModelId"
  | "titleSummarizerProvider"
  | "titleSummarizerModelId"
  | "titleSummarizerFallbackProvider"
  | "titleSummarizerFallbackModelId";

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
  themeMode: "dark",
  colorTheme: "default",
  dashboardFontScalePct: 100,
  language: undefined,
  defaultProvider: undefined,
  defaultModelId: undefined,
  testMode: undefined,
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
  modelOnboardingComplete: undefined,
  useClaudeCli: undefined,
  useDroidCli: undefined,
  useLlamaCpp: undefined,
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
  persistAgentToolOutput: true,
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
  experimentalFeatures: {},
  cliAgents: {},
} satisfies CompleteSettings<GlobalSettings>;

/** Default values for project-level settings. */
export const DEFAULT_PROJECT_SETTINGS = {
  globalPause: false,
  globalPauseReason: undefined,
  defaultWorkflowId: undefined,
  approvedWorkflowCliCommands: undefined,
  approvedCliAutonomyAdapters: undefined,
  enginePaused: false,
  maxConcurrent: 2,
  maxTriageConcurrent: 2,
  globalMaxConcurrent: 4,
  maxWorktrees: 4,
  pollIntervalMs: 15000,
  heartbeatMultiplier: 1,
  autoClaimCandidatesInPrompt: 5,
  tombstoneStickyWindowDays: 7,
  heartbeatScopeDiscipline: "strict",
  heartbeatPromptTemplate: "default",
  groupOverlappingFiles: true,
  overlapIgnorePaths: [],
  autoMerge: true,
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
  worktreeInitCommand: undefined,
  testCommand: undefined,
  buildCommand: undefined,
  recycleWorktrees: false,
  executorAllowSiblingBranchRename: false,
  worktreeNaming: "random",
  worktrunk: {
    enabled: false,
    binaryPath: undefined,
    installedBinaryPath: undefined,
    onFailure: "fail",
  },
  worktreesDir: undefined,
  taskPrefix: "FN",
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
  merger: { mode: "ai", maxReviewPasses: 3, allowDirtyLocalCheckoutSync: false },
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
  // MOVED_SETTINGS_KEYS. `buildTimeoutMs` is NOT moved (no engine reader) and
  // stays a plain project setting:
  buildTimeoutMs: 300_000,
  ephemeralAgentsEnabled: true,
  agentProvisioning: {},
  sandboxProvisioning: {},
  defaultAgentPermissionPolicy: undefined,
  specStalenessEnabled: false,
  specStalenessMaxAgeMs: 6 * 60 * 60 * 1000,
  taskStuckTimeoutMs: 600_000,
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
  archiveAgentLogMode: "compact",
  autoUpdatePrStatus: false,
  githubCommentOnDone: false,
  githubCommentTemplate: undefined,
  githubCloseSourceIssueOnDone: false,
  githubTrackingEnabledByDefault: false,
  githubTrackingDefaultRepo: undefined,
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
  // Title-summarizer model lanes MOVED to workflow settings (U4) —
  // see MOVED_SETTINGS_KEYS.
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
  showQuickChatFAB: false,
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
