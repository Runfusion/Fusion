import { CONSECUTIVE_TOOL_FAILURE_RETRY_THRESHOLD, DEFAULT_MAX_AUTO_MERGE_RETRIES } from "../tasks/in-review-stall.js";
import type { ChatSnippet, CliAgentSettings, GlobalSettings, McpSecretRef, McpServerDefinition, ProjectSettings, Settings } from "../types.js";

export const CHAT_SNIPPET_MAX_ENTRIES = 50;
export const CHAT_SNIPPET_MAX_NAME_LENGTH = 48;
export const CHAT_SNIPPET_MAX_PROMPT_LENGTH = 4_000;
export const CHAT_SNIPPET_RESERVED_NAMES = Object.freeze([
  "steer",
  "focus",
  "clear",
  "new",
  "skill",
] as const);

const CHAT_SNIPPET_NAME_PATTERN = /^[\p{L}\p{N}_-]+$/u;

export function normalizeChatSnippetName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFKC").trim().toLowerCase();
  if (
    name.length === 0
    || name.length > CHAT_SNIPPET_MAX_NAME_LENGTH
    || !CHAT_SNIPPET_NAME_PATTERN.test(name)
    || (CHAT_SNIPPET_RESERVED_NAMES as readonly string[]).includes(name)
  ) {
    return null;
  }
  return name;
}

/*
FNXC:ChatSnippets 2026-09-03-15:56:
Normalize global snippets at one shared browser/core boundary. The first valid canonical duplicate wins, prompts remain byte-for-byte operator text, and invalid entries are removed rather than truncated or silently repaired.
*/
export function normalizeChatSnippets(value: unknown): ChatSnippet[] {
  if (!Array.isArray(value)) return [];
  const snippets: ChatSnippet[] = [];
  const seenNames = new Set<string>();
  for (const candidate of value) {
    if (snippets.length >= CHAT_SNIPPET_MAX_ENTRIES) break;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const entry = candidate as Record<string, unknown>;
    const name = normalizeChatSnippetName(entry.name);
    if (!name || seenNames.has(name) || typeof entry.prompt !== "string") continue;
    if (entry.prompt.trim().length === 0 || entry.prompt.length > CHAT_SNIPPET_MAX_PROMPT_LENGTH) continue;
    seenNames.add(name);
    snippets.push({ name, prompt: entry.prompt });
  }
  return snippets;
}

export function readChatSnippets(settings: { chatSnippets?: unknown }): ChatSnippet[] {
  return normalizeChatSnippets(settings.chatSnippets);
}

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
 * Enforcement note (corrected 2026-08-23): this block long claimed enforcement lives in
 * `src/__tests__/settings-consistency.test.ts`, but NO SUCH FILE EXISTS — the "every key belongs to
 * exactly one regime" union has no direct guard today. What does exist:
 * `builtin-workflow-settings-triage.test.ts` (core) pins the workflow-native catalogs key by key, and
 * `workflow-settings-fallback-alignment.test.ts` (engine) catches a key declared in both regimes. A STALE entry here only loosens the `Omit`
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
  /*
  FNXC:ReviewConvergence 2026-08-23-23:20 (comment corrected after review):
  FN-149 declared these six in `BUILTIN_REVIEW_REVISION_SETTINGS` but left them inside
  `ProjectSettingsSchema`, so `DEFAULT_PROJECT_SETTINGS` had to re-declare their defaults — the
  dual-regime drift `workflow-settings-fallback-alignment` guards. Listing them here removes them
  from that schema `Omit`, which is the whole effect: the workflow declaration becomes the single
  source of each default.

  PRECISION, because the earlier wording of this note ("they belong to the moved regime") was read as
  a stronger claim than the change makes: this type is consumed ONLY by the `ProjectSettingsSchema`
  Omit. It does NOT add them to the runtime moved catalog (`BUILTIN_MOVED_WORKFLOW_SETTINGS`), so
  `MOVED_SETTINGS_KEYS` does not contain them and they are not tombstoned on the project-settings
  write path. That is deliberate and matches FN-149: they are workflow-native settings, not migrated
  project settings, and `builtin-workflow-settings-triage.test.ts` asserts exactly that regime split.
  */
  | "reviewConvergenceEscalationEnabled"
  | "reviewConvergenceEscalationProvider"
  | "reviewConvergenceEscalationModelId"
  | "reviewArbitrationEnabled"
  | "reviewArbitrationProvider"
  | "reviewArbitrationModelId"
  | "executionProvider"
  | "executionCredentialInstanceId"
  | "executionModelId"
  | "executionThinkingLevel"
  | "executionFallbackProvider"
  | "executionFallbackCredentialInstanceId"
  | "executionFallbackModelId"
  | "executionFallbackThinkingLevel"
  | "planningProvider"
  | "planningCredentialInstanceId"
  | "planningModelId"
  | "planningThinkingLevel"
  | "planningFallbackProvider"
  | "planningFallbackCredentialInstanceId"
  | "planningFallbackModelId"
  | "planningFallbackThinkingLevel"
  | "validatorProvider"
  | "validatorCredentialInstanceId"
  | "validatorModelId"
  | "validatorThinkingLevel"
  | "validatorFallbackProvider"
  | "validatorFallbackCredentialInstanceId"
  | "validatorFallbackModelId"
  | "validatorFallbackThinkingLevel";

type NonDefaultProjectSettingsKey = "ephemeralAgentTaskCreationPolicy" | "selectedWorkflowModelLanes";
type ProjectSettingsSchema = Omit<ProjectSettings, MovedProjectSettingsKey | NonDefaultProjectSettingsKey>;

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
  FNXC:Identity 2026-08-09-03:04:
  The identity/authorization master switch (U5, KTD20/KTD22). DAEMON-GLOBAL, never per-project, and
  its scope is the enforcement: one daemon serves N projects from a shared database while actors and
  sessions are global, so a per-project switch would let an actor denied in project A operate freely
  in project B — where every caller resolves to the bootstrap actor with full authority. Declaring it
  here (and NOT in DEFAULT_PROJECT_SETTINGS) is what makes `isProjectSettingsKey("identityEnabled")`
  false, so a project-scoped patch cannot carry it and no project can locally disable enforcement.

  Defaults to false so existing installs behave exactly as they do today until U16 turns it on;
  `can()` short-circuits to allow while it is off, so only the CHECK is bypassed — attribution still
  runs. Writing this key is gated on `identity:configure` rather than `settings:update` (KTD20):
  otherwise anyone who can edit settings could switch authorization off from inside.
  */
  identityEnabled: false as boolean,
  /*
  FNXC:PostgresEmbedded 2026-07-22-23:55:
  Embedded PostgreSQL is shared by all local Fusion projects and processes.
  Deliberately undefined (not 500): getSettings() merges these defaults, so a
  concrete value here would be indistinguishable from an operator choice and
  would mask the platform-aware server-side default in
  resolveEmbeddedMaxConnections (win32 150, else 500). Issue #2411: Windows
  backends are separate processes; a 500-connection cap exhausts the desktop
  heap under load and forked backends die with 0xC0000142, taking the embedded
  cluster and dashboard down.
  */
  embeddedPostgresMaxConnections: undefined,
  /*
  FNXC:DashboardTheming 2026-07-03-00:00:
  Fresh installs must follow the operating system theme until the user explicitly chooses Light, Dark, or System. Keep this global default aligned with dashboard and desktop pre-hydration fallbacks.
  */
  /*
  FNXC:ProviderAuth 2026-07-24-17:05:
  Default to the historical precedence (raw API key beats subscription OAuth, FN-7391/FN-7396)
  so upgrading never silently moves an operator's traffic from their key onto their subscription.
  */
  anthropicAuthPreference: "api-key",
  themeMode: "system",
  /*
  FNXC:DashboardTheming 2026-06-30-00:00:
  New users and unset installs should start on Shadcn Ember. Existing users who explicitly stored colorTheme "default", "ocean", or another valid theme must remain on that selection, so the ids stay valid and only the absence/default seed changes to "shadcn-ember".
  */
  colorTheme: "shadcn-ember",
  shadcnCustomColors: undefined,
  dashboardFontScalePct: 100,
  /*
  FNXC:SettingsBackups 2026-07-16-14:20:
  PostgreSQL holds every project in one shared cluster, so database backup policy is global.
  Memory snapshots remain project-scoped because their files live under each project’s .fusion directory.
  */
  autoBackupEnabled: false,
  autoBackupSchedule: "0 2 * * *",
  autoBackupRetention: 7,
  autoBackupDir: ".fusion/backups",
  backupSettingsMigrationConflicts: undefined,
  /*
  FNXC:NodeDiscovery 2026-07-17-12:00:
  LAN discovery remains automatic for existing operators, while FN-8202 provides a global opt-out from dashboard and serve mDNS/DNS-SD auto-start.
  */
  localNetworkDiscoveryEnabled: true,
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
  /*
  FNXC:Settings 2026-07-16-05:30:
  Critical-action confirmation dialogs stay enabled by default. This global-only preference may opt an operator into primary/default auto-approval, but project settings cannot enable it for collaborators.
  */
  skipConfirmationDialogs: false,
  /*
  FNXC:QuickEntry 2026-08-16-03:15:
  Quick Add keeps its historical Enter-to-submit behavior by default; only an operator's global preference may opt into newline-first entry.
  */
  quickAddSubmitOnEnter: true,
  /*
  FNXC:ChatSnippets 2026-09-03-15:56:
  Keep the optional global key present but undefined so scope-key derivation remains complete without sharing a mutable default array. readChatSnippets supplies a fresh effective empty list.
  */
  chatSnippets: undefined,
  language: undefined,
  defaultProvider: undefined,
  defaultCredentialInstanceId: undefined,
  defaultModelId: undefined,
  testMode: undefined,
  voiceInput: undefined,
  modelPricingOverrides: undefined,
  modelPricingFetchedAt: undefined,
  modelPricingSource: undefined,
  modelRouterEnabled: undefined,
  modelRouterCheapProvider: undefined,
  modelRouterCheapModelId: undefined,
  mergeRequestContractShadowEnabled: false,
  fallbackProvider: undefined,
  fallbackCredentialInstanceId: undefined,
  fallbackModelId: undefined,
  /*
  FNXC:Settings-ThinkingLevel 2026-07-10-11:13:
  Fallback thinking levels mirror their provider/model scope: global fallbackThinkingLevel is global, planning/validator fallback thinking levels are workflow-moved, and titleSummarizerFallbackThinkingLevel stays project-scoped. Undefined preserves inheritance until runtime/UI follow-ups consume the stored values.
  */
  fallbackThinkingLevel: undefined,
  defaultThinkingLevel: undefined,
  ntfyEnabled: false,
  // FNXC:AgentClarification 2026-07-16-12:00: Planner clarification pauses are opt-in; disabled planners must complete a summary instead of waiting for proactive answers.
  agentClarificationEnabled: false,
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
  wedgeNotificationSettleMs: 300000,
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
  githubStarPromptDismissedAt: undefined,
  favoriteProviders: undefined,
  favoriteModels: undefined,
  openrouterModelSync: true,
  openrouterAppAttribution: undefined,
  openrouterModelFilters: undefined,
  openrouterProviderPreferences: undefined,
  orcarouterModelSync: true,
  opencodeGoModelSync: true,
  updateCheckEnabled: true,
  fnBinaryCheckEnabled: true,
  updateCheckFrequency: "daily",
  // FNXC:UpdateChannels 2026-07-19-12:30: release track for update surfaces;
  // "stable" follows npm dist-tag `latest`, "beta" follows max(latest, beta).
  updateChannel: "stable",
  /*
  FNXC:AutoUpdate 2026-07-25-10:05:
  Unattended update install + supervised restart. Default OFF — an operator must
  opt in before Fusion replaces its own binary and bounces the process under them.
  */
  autoUpdateAndRestart: false,
  /*
  FNXC:UpdateAutomation 2026-08-21-02:17:
  Fresh installations require separate opt-ins for unattended installation and
  restart. The legacy combined switch remains false and is only a fallback for
  older persisted settings.
  */
  /* FNXC:UpdateAutomation 2026-08-21-02:48: Keep these schema keys unset because defaults merge into effective settings and `undefined` is distinct from explicit false. */
  autoUpdateEnabled: undefined,
  autoRestartAfterUpdate: undefined,
  /*
  FNXC:VersionAutoReload 2026-08-23-04:03:
  Version-change reload is mandatory, so its key is retired. Older persisted values are ignored because GLOBAL_SETTINGS_KEYS derives from this object and rejects unknown keys before save patches.
  */
  githubTrackingDefaultRepo: undefined,
  reportRoadmapDedupeEnabled: undefined,
  reportRoadmapLabel: undefined,
  reportRoadmapRepo: undefined,
  gitlabEnabled: undefined,
  gitlabInstanceUrl: undefined,
  gitlabApiBaseUrl: undefined,
  gitlabAuthToken: undefined,
  gitlabAuthTokenType: undefined,
  jiraEnabled: undefined,
  jiraBaseUrl: undefined,
  jiraApiBaseUrl: undefined,
  jiraAuthEmail: undefined,
  jiraAuthTokenSecretKey: undefined,
  jiraAuthTokenSecretScope: undefined,
  jiraBranchNameTemplate: undefined,
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
  useGrokCli: undefined,
  /*
  FNXC:GrokCli 2026-07-08-00:00:
  Grok CLI binary overrides are global operator settings because executable locations are machine-local. Blank/undefined preserves PATH auto-detection through grok.
  */
  grokCliBinaryPath: undefined,
  /*
  FNXC:OmpAcp 2026-07-13-22:50:
  Oh My Pi (omp) CLI enable + binary override are global operator settings (machine-local), mirroring Grok/Cursor.
  */
  useOmpCli: undefined,
  ompCliBinaryPath: undefined,
  // Global baseline lanes for per-role model selection
  executionGlobalProvider: undefined,
  executionGlobalCredentialInstanceId: undefined,
  executionGlobalModelId: undefined,
  planningGlobalProvider: undefined,
  planningGlobalCredentialInstanceId: undefined,
  planningGlobalModelId: undefined,
  validatorGlobalProvider: undefined,
  validatorGlobalCredentialInstanceId: undefined,
  validatorGlobalModelId: undefined,
  titleSummarizerGlobalProvider: undefined,
  titleSummarizerGlobalCredentialInstanceId: undefined,
  titleSummarizerGlobalModelId: undefined,
  /*
  FNXC:Settings-MergerModel 2026-07-13-07:52:
  Global merger baseline lane (provider/model/thinking) is independent of executor/planner/reviewer so operators can pin a merge-capable model under Settings → Global Models without changing other lanes. Undefined falls through to defaultProvider/defaultModelId at resolve time.
  */
  mergerGlobalProvider: undefined,
  mergerGlobalCredentialInstanceId: undefined,
  mergerGlobalModelId: undefined,
  /*
  FNXC:GitHubImportTranslate 2026-07-15-09:30:
  Global import-translate baseline lane. Undefined falls through to the summarization lane then defaultProvider/defaultModelId at resolve time.
  */
  importTranslateGlobalProvider: undefined,
  importTranslateGlobalCredentialInstanceId: undefined,
  importTranslateGlobalModelId: undefined,
  importTranslateGlobalThinkingLevel: undefined,
  // FNXC:FastCheapModelLane 2026-08-29-02:43: The Fast & Cheap route owns an optional global lane and otherwise inherits normal execution resolution.
  fastCheapGlobalProvider: undefined,
  fastCheapGlobalCredentialInstanceId: undefined,
  fastCheapGlobalModelId: undefined,
  fastCheapGlobalThinkingLevel: undefined,
  /*
  FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
  Global model lanes can override the default thinking effort independently. Undefined preserves the existing inheritance to `defaultThinkingLevel`.
  */
  executionGlobalThinkingLevel: undefined,
  planningGlobalThinkingLevel: undefined,
  validatorGlobalThinkingLevel: undefined,
  titleSummarizerGlobalThinkingLevel: undefined,
  mergerGlobalThinkingLevel: undefined,
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
  FNXC:AgentLogs 2026-08-29-04:32:
  FN-253 makes complete tool arguments and results visible by default: AgentLogger redacts them at
  its single write boundary, persistence and delivery lanes bound each row, and operators can retain
  the previous low-volume behavior by explicitly setting persistAgentToolOutput: false.
  */
  persistAgentToolOutput: true,
  /*
  FNXC:ToolOutputBudget 2026-08-03-16:00:
  FN-8616 lets operators raise, lower, or disable the FN-8614 per-result tool-output
  budget. Undefined preserves the finite 16,000-character default; only 0 means no limit.
  */
  agentToolOutputMaxChars: undefined,
  // Task chat remains an operator-directed conversation by default. Enable this
  // explicitly to add engine-authored lifecycle narration to the transcript.
  proactiveTaskChatEnabled: false,
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
  // FNXC:TaskRecommendations 2026-08-08-05:02: completion follows-ups stay bounded by default; 0 disables writing them.
  maxRecommendationsPerTask: 3,
  // FNXC:TaskRecommendations 2026-08-19-13:05: explicit recommendation evaluation is opt-in and only applies while the positive cap enables capture; relevance always outranks count.
  requireTaskRecommendations: false,
  // FNXC:TaskRecommendations 2026-08-13-03:56: surface completed-task proposals by default; operators can suppress the notice without suppressing capture.
  recommendationMailboxNoticeEnabled: true,
  globalPause: false,
  globalPauseReason: undefined,
  defaultWorkflowId: undefined,
  // FNXC:TaskRevert 2026-07-05-00:00 (FN-7556): AI-undo tasks reverse
  // already-shipped code, so default them to the stricter review-heavy
  // workflow; empty/unset means inherit the project default workflow.
  aiUndoTaskWorkflowId: "builtin:review-heavy",
  // FNXC:OriginWorkflowSelection 2026-07-26-19:40: unset = "Selected workflow"
  // (board lane mirror, then project default). A concrete id pins the origin.
  taskCreateWorkflowId: undefined,
  refinementTaskWorkflowId: undefined,
  boardSelectedWorkflowId: undefined,
  enabledBuiltinWorkflowIds: undefined,
  approvedWorkflowCliCommands: undefined,
  approvedCliAutonomyAdapters: undefined,
  enginePaused: false,
  engineLastActiveAt: undefined,
  /*
  FNXC:CapacityModel 2026-09-01-14:49:
  Max Concurrent Tasks limits every AI-active task, including checkout-free planning. It is the
  provider/LLM-load dimension and remains independent from execution-worktree capacity.
  */
  maxConcurrent: 2,
  /*
  FNXC:VerificationConcurrency 2026-07-15-03:35:
  Default one verification at a time process-wide so concurrent tasks cannot each run verify:fast / full builds simultaneously and peg the host. Operators with spare cores may raise this in Scheduling settings (clamped 1–8 at runtime).
  */
  maxConcurrentVerifications: 1,
  /* Execution-worktree holders only; planning runs read-only on the project root. */
  maxWorktrees: 4,
  /*
  FNXC:CapacityModel 2026-09-01-14:49:
  Worktree limiting is ON by default and independently caps tasks that hold or are entering an
  execution checkout. OFF removes that gate structurally; write-capable execution remains isolated
  in task worktrees while checkout-free planning continues to count only against maxConcurrent.
  */
  worktreeLimitEnabled: true,
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
  /*
  FNXC:ToolOutputBudget 2026-08-03-16:00:
  Project settings participate in the existing effective-settings merge, allowing a
  project-specific tool-output cap or explicit no-limit sentinel to override global policy.
  */
  agentToolOutputMaxChars: undefined,
  voiceInput: undefined,
  mergeRequestContractShadowEnabled: false,
  mergeStrategy: "direct",
  githubNativeAutoMerge: false,
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
  showWorktreeGrouping: false,
  openTasksInRightSidebar: false,
  /*
  FNXC:MobileTaskPopups 2026-07-01-12:00:
  Default off preserves current board-card task detail behavior. The dashboard only consults this project setting for ordinary board-card clicks without a deep tab across mobile, tablet, and desktop viewports, and reuses the existing task pop-out surface before falling back to right-dock or main-panel routing.
  */
  openMobileTasksInPopup: false,
  /*
  FNXC:TaskPopupViewGating 2026-07-15-15:20:
  FN-8016 defaults task-detail popups to their opening view on every dashboard surface. Explicit false retains globally shared popup behavior for operators who need it; hidden popups preserve snapshots and shared persisted geometry.
  */
  taskPopupsBoardListOnly: true,
  /*
  FNXC:TaskCardCostBadge 2026-07-11-12:15:
  Default off preserves existing board-card density. When true, the dashboard may render a read-time derived cost badge only for tasks with positive token usage; unavailable pricing remains the guess-free “—” sentinel.
  */
  showCostBadgeOnCards: false,
  /*
  FNXC:ChatMessageLayout 2026-08-18-20:27:
  The project preference applies one reversible layout choice to every standard and task chat surface. Explicitly seed the historical bubbles presentation so upgraded projects preserve their existing UI.
  */
  chatMessageLayout: "bubbles",
  /*
  FNXC:TaskDetailActivityFirst 2026-06-30-23:59:
  Project task-detail defaults are Activity-first unless this opt-in is true. Keeping the default false preserves explicit deep-link ids while making omitted non-done task opens land on Activity → Live.
  */
  taskDetailChatFirst: false,
  executorAllowSiblingBranchRename: false,
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
  defaultCredentialInstanceIdOverride: undefined,
  defaultModelIdOverride: undefined,
  /*
  FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
  Project model lanes can carry optional thinking overrides. Undefined means inherit the global default thinking effort; runtime precedence remains task > lane override > global default.
  */
  defaultThinkingLevelOverride: undefined,
  modelPresets: [],
  autoSelectModelPreset: false,
  completionDocumentationMode: "off",
  reviewArtifacts: "off",
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
  /*
  FNXC:ExecutorToolFailureRetry 2026-08-06-14:56:
  Fresh projects retry the existing bounded same-model continuation after one
  terminal tool error. Persisted project values are not migrated, so explicit
  operator thresholds remain authoritative.
  */
  executorToolFailureRetryCount: 2,
  executorToolFailureRetryBackoffMs: 2000,
  executorToolFailureThreshold: CONSECUTIVE_TOOL_FAILURE_RETRY_THRESHOLD,
  executorModelEscalationEnabled: false,
  executorEscalationProvider: undefined,
  executorEscalationModelId: undefined,
  executorEscalationNodeId: undefined,
  /*
  FNXC:ReviewConvergence 2026-08-23-21:05:
  FN-149's six review-convergence/arbitration keys are declared in BUILTIN_WORKFLOW_SETTINGS, which
  the U4 hard-move made the SINGLE source of truth for a moved key's default. Re-declaring them here
  put them back in the legacy object the hard-move emptied, so an undeclared key on a custom workflow
  could resolve to this literal instead of the declaration default — the exact drift
  `workflow-settings-fallback-alignment` guards. The declaration defaults are identical (both
  `*Enabled` default true, the provider/model lanes carry no default), and the reader uses
  `!== false`, so removing them here preserves behaviour and restores the invariant.
  */
  /**
   * FNXC:Merge 2026-06-26-00:00:
   * New and unconfigured projects default AI merge to sync a dirty checked-out integration branch, restoring the legacy stash → fast-forward → restore landing behavior. Explicit persisted merger.allowDirtyLocalCheckoutSync values still win, and no existing-project migration stamps this default into storage.
   */
  merger: { mode: "ai", maxReviewPasses: 3, allowDirtyLocalCheckoutSync: true },
  requiredChecks: undefined,
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
  boardStallSweepWindowMs: 2 * 60 * 60_000,
  boardStallBlockedGrowthThreshold: 3,
  // Capacity risk warning default: only warn once todo is meaningfully backlogged.
  capacityRiskBannerEnabled: false,
  capacityRiskTodoThreshold: 20,
  backlogPressureAlertEnabled: true,
  backlogPressureRatioThreshold: 10,
  backlogPressureMinTodoCount: 5,
  backlogPressureAlertCooldownMs: 24 * 60 * 60_000,
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
  // Run maintenance (including WAL checkpointing) every 5 minutes by default.
  maintenanceIntervalMs: 300_000,
  autoArchiveDoneTasksEnabled: true,
  autoArchiveDoneAfterMs: 48 * 60 * 60 * 1000,
  doneAutoArchiveDays: 0,
  // FNXC:DuplicateIntake 2026-07-07-00:00 (FN-7658): default OFF — operators
  // decide via the near-duplicate flag/UI instead of tasks silently vanishing
  // into `archived` during intake. Set true to restore the pre-FN-7658 behavior.
  autoArchiveDuplicateTasksEnabled: false,
  triageDuplicateResolution: "prompt",
  archiveAgentLogMode: "compact",
  autoUpdatePrStatus: false,
  githubCommentOnDone: false,
  githubCommentTemplate: undefined,
  githubCloseSourceIssueOnDone: false,
  githubTrackingEnabledByDefault: false,
  // FNXC:PlannerOversight 2026-07-14-18:11: session advisor (LLM overseer agent) off by default; operators opt in per project / task.
  sessionAdvisorEnabledByDefault: false,
  githubLinkImportedIssuesToTracking: false,
  githubTrackingDefaultRepo: undefined,
  reportMode: "draft-review" as const,
  reportModeByAction: undefined,
  // FNXC:ReportPipeline 2026-07-16-20:15: Unset targets preserve action-specific routing.
  reportTarget: undefined,
  reportTargetByAction: undefined,
  reportDiscussionCategory: undefined,
  reportRoadmapDedupeEnabled: true,
  reportRoadmapLabel: "roadmap",
  reportRoadmapRepo: undefined,
  gitlabEnabled: undefined,
  gitlabInstanceUrl: undefined,
  gitlabApiBaseUrl: undefined,
  gitlabAuthToken: undefined,
  gitlabAuthTokenType: undefined,
  jiraEnabled: undefined,
  jiraBaseUrl: undefined,
  jiraApiBaseUrl: undefined,
  jiraAuthEmail: undefined,
  jiraAuthTokenSecretKey: undefined,
  jiraAuthTokenSecretScope: undefined,
  jiraBranchNameTemplate: undefined,
  gitlabCommentOnDone: false,
  gitlabCommentTemplate: undefined,
  gitlabCloseSourceIssueOnDone: false,
  githubTrackingDedupEnabled: true,
  githubAuthMode: "gh-cli",
  githubAuthToken: undefined,
  memoryBackupEnabled: false,
  memoryBackupSchedule: "0 3 * * *",
  memoryBackupRetention: 14,
  memoryBackupDir: ".fusion/backups/memory",
  // FNXC:KnowledgeGraph 2026-08-10-10:00: The graph must stay outside gitignored .fusion so operators may commit it.
  knowledgeGraphDir: ".fusion-knowledge/graph",
  memoryBackupScope: "all" as const,
  autoSummarizeTitles: false,
  /*
  FNXC:TaskDefinitionInputLanguage 2026-07-16-05:00:
  Default off preserves byte-faithful English task definitions unless operators opt into
  prose localization for the detector's supported locales (en/es/fr/ko/zh-CN); zh-TW is
  not variant-detected and unsupported input, including Japanese, remains English.
  */
  taskDefinitionInInputLanguage: false,
  /* FNXC:TaskOutputLanguage 2026-08-19-14:56: Undefined preserves legacy true compatibility; the resolver supplies English for fresh projects. */
  taskOutputLanguage: undefined,
  useAiMergeCommitSummary: true,
  // Title-summarizer model lanes stay project-scoped (not moved in U4).
  titleSummarizerProvider: undefined,
  titleSummarizerCredentialInstanceId: undefined,
  titleSummarizerModelId: undefined,
  titleSummarizerThinkingLevel: undefined,
  titleSummarizerFallbackProvider: undefined,
  titleSummarizerFallbackCredentialInstanceId: undefined,
  titleSummarizerFallbackModelId: undefined,
  titleSummarizerFallbackThinkingLevel: undefined,
  /*
  FNXC:GitHubImportTranslate 2026-07-15-09:30:
  Import auto-translation defaults OFF: operators who never opt in keep byte-faithful import provenance. Target locale undefined means "follow the active dashboard locale". Translate model lane stays project-scoped like the summarizer lane.
  */
  githubImportAutoTranslate: false,
  importTranslateTargetLocale: undefined,
  importTranslateProvider: undefined,
  importTranslateCredentialInstanceId: undefined,
  importTranslateModelId: undefined,
  importTranslateThinkingLevel: undefined,
  // FNXC:FastCheapModelLane 2026-08-29-02:43: Project Fast & Cheap overrides stay separate from ordinary execution models so fast routing remains opt-in.
  fastCheapProvider: undefined,
  fastCheapCredentialInstanceId: undefined,
  fastCheapModelId: undefined,
  fastCheapThinkingLevel: undefined,
  /*
  FNXC:Settings-MergerModel 2026-07-13-07:52:
  Merger model lane stays project-scoped (not workflow-moved) like title summarizer: Settings → Project Models can override the global merger baseline without binding the choice to a workflow graph.
  */
  mergerProvider: undefined,
  mergerCredentialInstanceId: undefined,
  mergerModelId: undefined,
  mergerThinkingLevel: undefined,
  // FNXC:Settings-MergerModel 2026-07-16-00:00: project merger fallback overrides shared global fallback only when its provider/model pair is complete.
  mergerFallbackProvider: undefined,
  mergerFallbackCredentialInstanceId: undefined,
  mergerFallbackModelId: undefined,
  mergerFallbackThinkingLevel: undefined,
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
  // FNXC:StashConfig 2026-08-13-16:35: (RUFU-068) Optional per-project Stash LCM
  // memory backend config. stashUrl points at the operator's Stash server
  // (default http://127.0.0.1:3457). stashApiKey is an override for hard
  // isolation (separate Stash instance/account); the PRIMARY API key lives in
  // the global secrets store ("stash-api-key") and is NEVER committed. Project
  // value wins over global. TencentDB's URL setting is intentionally NOT ported.
  stashUrl: "",
  stashApiKey: "",
  /*
  FNXC:Rufu126VectorSearch 2026-08-19-10:50:
  RUFU-126 (D3): opt-in vector (semantic) recall for the Stash memory backend.
  Default OFF — zero behavior change until the operator enables it (this is a
  prototype; rejected alternative was automatic capability detection, which
  would change default behavior and pay a per-process 404 round-trip against
  unpatched servers). When true, multi-word (≥2 tokens) recall queries try the
  Stash GET /api/v1/me/sessions/events/semantic-search endpoint first and fall
  back byte-identically to the RUFU-121 keyword path on any vector failure
  (see memory-backend-stash.ts search() + docs/research/stash-vector-search-evaluation.md
  for D1–D5). Schema-only, consistent with stashUrl/stashApiKey (no UI row).
  */
  stashVectorSearch: false,
  /*
  FNXC:StashSessionCapture 2026-08-19-04:37:
  (RUFU-122) Task-terminal transcript upload defaults. All are inert unless
  memoryBackendType === "stash". executorSessionCaptureEnabled gates ONLY the
  transcript upload (the RUFU-068 terminal anchor event still fires when it is
  off) and defaults ON. executorSessionCaptureMaxEvents caps transcript events
  per task; the engine keeps the most recent N (default 20000).
  executorSessionCaptureIncludeStatus is the schema-only "keep a setting" for
  uploading `status` log entries (default off; no UI row).
  */
  executorSessionCaptureEnabled: true,
  executorSessionCaptureMaxEvents: 20_000,
  executorSessionCaptureIncludeStatus: false,
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
  mobileNavPrimaryItems: ["command-center", "tasks", "agents", "missions", "chat", "mailbox"],
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
  chatNewSessionMode: undefined,
  chatDefaultKind: undefined,
  chatDefaultAgentId: undefined,
  chatDefaultModelProvider: undefined,
  chatDefaultModelId: undefined,
  chatDefaultThinkingLevel: undefined,
  mailAutoCleanupDays: 0,
  operationalLogRetentionDays: 30,
  // FNXC:PostgresMigrationBanner 2026-07-12: set by the startup factory after
  // the first-boot SQLite → PostgreSQL auto-migration; drives the one-time
  // "your data was migrated" dashboard banner. null = no migration.
  sqliteMigrationNotice: null,
  // FNXC:PostgresMigrationInbox 2026-07-14-12:10: independent from the banner
  // record so a completion-message marker write cannot revert a concurrent dismissal.
  postgresMigrationInboxMessageSentAt: undefined,
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
  /*
   * FNXC:CredentialInstanceSelection 2026-08-01-05:38:
   * Optional credential-instance settings share each provider lane's scope and remain inert
   * until runtime credential selection is introduced by the follow-up slice.
   */
  ...DEFAULT_GLOBAL_SETTINGS,
  ...DEFAULT_PROJECT_SETTINGS,
};

/** Keys that belong to the global settings scope. */
export const GLOBAL_SETTINGS_KEYS = Object.freeze(
  Object.keys(DEFAULT_GLOBAL_SETTINGS) as Array<keyof GlobalSettings>,
);

/*
FNXC:EphemeralAgentTaskCreation 2026-07-30-12:00:
The validation policy is persisted as a project setting but intentionally absent from defaults.
The resolver owns fallback so a legacy-only explicit false remains deny after settings merge.
*/
export const NON_DEFAULT_PROJECT_SETTINGS_KEYS = Object.freeze([
  "ephemeralAgentTaskCreationPolicy",
] as const satisfies readonly NonDefaultProjectSettingsKey[]);

/** Keys that belong to the project settings scope. */
export const PROJECT_SETTINGS_KEYS = Object.freeze([
  ...Object.keys(DEFAULT_PROJECT_SETTINGS),
  ...NON_DEFAULT_PROJECT_SETTINGS_KEYS,
] as Array<keyof ProjectSettings>);

export function isGlobalSettingsKey(key: string): key is keyof GlobalSettings {
  return (GLOBAL_SETTINGS_KEYS as readonly string[]).includes(key);
}

export function isProjectSettingsKey(key: string): key is keyof ProjectSettings {
  return (PROJECT_SETTINGS_KEYS as readonly string[]).includes(key);
}

/*
FNXC:ConfigVersioning 2026-08-09-04:09:
`engineLastActiveAt` is liveness bookkeeping written every pollIntervalMs tick. Versioning it evicted real settings changes from the audit window within about 25 minutes, so project revision payloads omit these keys and restores overlay their live values.
*/
export const NON_VERSIONED_SETTINGS_KEYS = Object.freeze(["engineLastActiveAt"] as const);

export function isNonVersionedSettingsKey(key: string): key is (typeof NON_VERSIONED_SETTINGS_KEYS)[number] {
  return (NON_VERSIONED_SETTINGS_KEYS as readonly string[]).includes(key);
}

/** Preserve live liveness fields when an exact historic project snapshot is restored. */
export function mergeRestoredProjectSettings(snapshot: Record<string, unknown>, live: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...snapshot };
  for (const key of NON_VERSIONED_SETTINGS_KEYS) {
    delete merged[key];
    if (Object.hasOwn(live, key)) merged[key] = live[key];
  }
  return merged;
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
