import type { GlobalSettings, ProjectSettings, Settings } from "./types.js";

type CompleteSettings<T> = { [K in keyof Required<T>]: Required<T>[K] | undefined };

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
  defaultProvider: undefined,
  defaultModelId: undefined,
  fallbackProvider: undefined,
  fallbackModelId: undefined,
  defaultThinkingLevel: undefined,
  ntfyEnabled: false,
  ntfyTopic: undefined,
  ntfyBaseUrl: undefined,
  ntfyEvents: ["in-review", "merged", "failed", "awaiting-approval", "awaiting-user-review", "planning-awaiting-input"],
  ntfyDashboardHost: undefined,
  defaultProjectId: undefined,
  setupComplete: undefined,
  favoriteProviders: undefined,
  favoriteModels: undefined,
  openrouterModelSync: true,
  modelOnboardingComplete: undefined,
  useClaudeCli: undefined,
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
} satisfies CompleteSettings<GlobalSettings>;

/** Default values for project-level settings. */
export const DEFAULT_PROJECT_SETTINGS = {
  globalPause: false,
  globalPauseReason: undefined,
  enginePaused: false,
  maxConcurrent: 2,
  maxTriageConcurrent: 2,
  globalMaxConcurrent: 4,
  maxWorktrees: 4,
  pollIntervalMs: 15000,
  heartbeatMultiplier: 1,
  groupOverlappingFiles: true,
  overlapIgnorePaths: [],
  autoMerge: true,
  mergeStrategy: "direct",
  pushAfterMerge: false,
  pushRemote: "origin",
  worktreeInitCommand: undefined,
  testCommand: undefined,
  buildCommand: undefined,
  recycleWorktrees: false,
  worktreeNaming: "random",
  taskPrefix: "FN",
  includeTaskIdInCommit: true,
  commitAuthorEnabled: true,
  commitAuthorName: "Fusion",
  commitAuthorEmail: "noreply@runfusion.ai",
  planningProvider: undefined,
  planningModelId: undefined,
  planningFallbackProvider: undefined,
  planningFallbackModelId: undefined,
  // Project-level default override and execution lane
  defaultProviderOverride: undefined,
  defaultModelIdOverride: undefined,
  executionProvider: undefined,
  executionModelId: undefined,
  validatorProvider: undefined,
  validatorModelId: undefined,
  validatorFallbackProvider: undefined,
  validatorFallbackModelId: undefined,
  modelPresets: [],
  autoSelectModelPreset: false,
  defaultPresetBySize: {},
  autoResolveConflicts: true,
  smartConflictResolution: true,
  worktreeRebaseBeforeMerge: true,
  worktreeRebaseRemote: "",
  strictScopeEnforcement: false,
  buildRetryCount: 0,
  verificationFixRetries: 3,
  buildTimeoutMs: 300_000,
  requirePlanApproval: false,
  specStalenessEnabled: false,
  specStalenessMaxAgeMs: 6 * 60 * 60 * 1000,
  taskStuckTimeoutMs: undefined,
  aiSessionTtlMs: 7 * 24 * 60 * 60 * 1000,
  aiSessionCleanupIntervalMs: 60 * 60 * 1000,
  autoUnpauseEnabled: true,
  autoUnpauseBaseDelayMs: 300_000,
  autoUnpauseMaxDelayMs: 3_600_000,
  maxStuckKills: 6,
  maxPostReviewFixes: 1,
  maxSpawnedAgentsPerParent: 5,
  maxSpawnedAgentsGlobal: 20,
  maintenanceIntervalMs: 900_000,
  autoArchiveDoneTasksEnabled: true,
  autoArchiveDoneAfterMs: 48 * 60 * 60 * 1000,
  archiveAgentLogMode: "compact",
  autoUpdatePrStatus: false,
  autoCreatePr: false,
  githubCommentOnDone: false,
  githubCommentTemplate: undefined,
  autoBackupEnabled: false,
  autoBackupSchedule: "0 2 * * *",
  autoBackupRetention: 7,
  autoBackupDir: ".fusion/backups",
  autoSummarizeTitles: false,
  titleSummarizerProvider: undefined,
  titleSummarizerModelId: undefined,
  titleSummarizerFallbackProvider: undefined,
  titleSummarizerFallbackModelId: undefined,
  scripts: undefined,
  setupScript: undefined,
  insightExtractionEnabled: false,
  insightExtractionSchedule: "0 2 * * *",
  insightExtractionMinIntervalMs: 86_400_000,
  memoryEnabled: true,
  memoryBackendType: "qmd",
  memoryAutoSummarizeEnabled: false,
  memoryAutoSummarizeThresholdChars: 50_000,
  memoryAutoSummarizeSchedule: "0 3 * * *",
  memoryDreamsEnabled: false,
  memoryDreamsSchedule: "0 4 * * *",
  tokenCap: undefined,
  runStepsInNewSessions: false,
  maxParallelSteps: 2,
  missionStaleThresholdMs: 600_000,
  missionMaxTaskRetries: 3,
  missionHealthCheckIntervalMs: 300_000,
  agentPrompts: undefined,
  promptOverrides: undefined,
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
        quickTunnel: false,
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
  reflectionEnabled: false,
  reflectionIntervalMs: 3_600_000,
  reflectionAfterTask: true,
  reviewHandoffPolicy: "disabled",
  showQuickChatFAB: false,
  experimentalFeatures: {},
} satisfies CompleteSettings<ProjectSettings>;

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
