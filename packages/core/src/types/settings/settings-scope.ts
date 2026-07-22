/**
 * FNXC:CodeOrganization 2026-07-22-12:00:
 * Global/project settings scope types peeled from types.ts.
 * Defaults and key helpers re-export from settings-schema.ts.
 */

import type { ThinkingLevel } from "../board/board.js";
import type {
  ColorTheme,
  CompletionDocumentationMode,
  Locale,
  ReviewArtifactsMode,
  ThemeMode,
} from "../ui/execution-and-ui.js";
import type {
  AutoRecoverySettings,
  DirectMergeCommitStrategy,
  MergeAdvanceAutoSyncMode,
  MergeAuditAutoRecoveryMode,
  MergeConflictStrategy,
  MergeIntegrationWorktreeMode,
  MergeStrategy,
  MergeStrategyOverlapBehavior,
  MergerSettings,
  OwningNodeHandoffPolicy,
  PostMergeAuditMode,
  UnavailableNodePolicy,
} from "../merge/merge-policy.js";
import type { EphemeralTaskCreationPolicy } from "../messaging/messages.js";
import type {
  AgentPermissionPolicyRules,
  AgentPermissionPolicyToolRules,
  AgentProvisioningApprovalMode,
  SandboxProvisioningApprovalMode,
  SecretAccessPolicy,
} from "../agents/agents.js";
import type {
  CustomProvider,
  ModelPreset,
  NotificationProviderConfig,
  NtfyNotificationEvent,
} from "../workflow/workflow-steps.js";
import type { UpdateChannel } from "../../i18n/app-version.js";
import type { ModelPricing } from "../../ai/model-pricing.js";
import type { SecretScope } from "../../secrets/secrets-store.js";
// Structural deps still defined in types.ts — import type-only (cycle is type-only).
import type { AgentPromptsConfig, ArchiveAgentLogMode, TaskTokenBudget } from "../../types.js";

// ── Settings Scope Types ────────────────────────────────────────────────
//
// Settings are split into two scopes:
//
// 1. **GlobalSettings** — User preferences stored in `~/.fusion/settings.json`.
//    These persist across all fn projects for the current user (theme, default
//    AI models, notification preferences).
//
// 2. **ProjectSettings** — Project-specific workflow and resource settings stored
//    in `.fusion/config.json`. These control how the engine operates for this
//    particular project (concurrency, merge strategy, worktree management, etc.).
//
// The merged view (`Settings`) combines both scopes: project values override
// global values. This is the type returned by `TaskStore.getSettings()` and
// used by most consumers.
//
// Computed/server-only fields (like `prAuthAvailable`) live only on
// `Settings` and are injected at read time by the API layer.

/** Settings scope discriminator for UI and validation. */
export type SettingsScope = "global" | "project";

/**
 * Settings for daemon mode authentication token and server configuration.
 * Stored in global settings alongside user preferences.
 */
export interface DaemonTokenSettings {
  /** The daemon authentication token (format: fn_<32 hex chars>).
   *  Used for authenticating CLI clients to the daemon server. */
  daemonToken?: string;
  /** Port for daemon mode server binding. Default: 4040. */
  daemonPort?: number;
  /** Host for daemon mode server binding. Default: "127.0.0.1" (localhost only).
   *  Set to "0.0.0.0" explicitly to expose the API on all interfaces — only do
   *  this if you understand the implications (terminal/exec endpoints become
   *  reachable from the LAN even with a bearer token). */
  daemonHost?: string;
}

/**
 * Global (user-level) settings stored in `~/.fusion/settings.json`.
 *
 * These are user preferences that persist across all fn projects.
 * The dashboard UI shows these under a "Global" section.
 */
/** Web search backend for auto-research provider. */
export type WebSearchBackend = "builtin" | "searxng" | "brave" | "google" | "tavily";

export interface ResearchEnabledSources {
  webSearch: boolean;
  pageFetch: boolean;
  github: boolean;
  localDocs: boolean;
  llmSynthesis: boolean;
}

export interface ResearchGlobalDefaults {
  searchProvider?: string;
  synthesisProvider?: string;
  synthesisModelId?: string;
  enabledSources?: ResearchEnabledSources;
  maxSourcesPerRun?: number;
  defaultExportFormat?: "markdown" | "json";
}

export interface ResearchProjectLimits {
  maxConcurrentRuns?: number;
  maxSourcesPerRun?: number;
  maxDurationMs?: number;
  requestTimeoutMs?: number;
}

export interface ResearchProjectSettings {
  enabled?: boolean;
  searchProvider?: string;
  synthesisProvider?: string;
  synthesisModelId?: string;
  enabledSources?: Partial<ResearchEnabledSources>;
  limits?: ResearchProjectLimits;
}

export type SandboxBackendName = "native" | "sandbox-exec" | "bubblewrap" | "docker" | "podman" | "custom";

export type SandboxFailureMode = "fail-hard" | "fallback-native";

export interface SandboxPolicy {
  allowNetwork?: boolean;
  allowedPaths?: string[];
}

export interface SandboxProjectSettings {
  backend?: SandboxBackendName;
  policy?: SandboxPolicy;
  failureMode?: SandboxFailureMode;
}

export type EvalFollowUpPolicy = "disabled" | "suggest-only" | "auto-create";

export interface EvalProjectSettings {
  enabled?: boolean;
  intervalMs?: number;
  evaluatorProvider?: string;
  evaluatorModelId?: string;
  followUpPolicy?: EvalFollowUpPolicy;
  retentionDays?: number;
}

export interface ResolvedEvalSettings {
  enabled: boolean;
  intervalMs: number;
  evaluatorProvider?: string;
  evaluatorModelId?: string;
  followUpPolicy: EvalFollowUpPolicy;
  retentionDays: number;
}

export type AgentMemoryInclusionMode = "full" | "index" | "off";
export type HeartbeatScopeDisciplineMode = "strict" | "lite" | "off";
export type HeartbeatPromptTemplate = "default" | "compact";

export interface OpenRouterModelFilters {
  supported_parameters?: string[];
  output_modalities?: string[];
}

export interface OpenRouterProviderPreferences {
  order?: string[];
  ignore?: string[];
  only?: string[];
  allow_fallbacks?: boolean;
  sort?: "price" | "throughput" | "latency";
  require_parameters?: boolean;
}

export type WorktrunkOnFailure = "fail" | "fallback-native";

/** Worktrunk integration settings. Mirrored across global and project tiers
 *  with field-level project-overrides-global precedence. See
 *  `resolveWorktrunkSettings` and FN-4621 in docs/settings-reference.md. */
export interface WorktrunkSettings {
  /** Master toggle. When true, Fusion delegates worktree create/sync/prune/remove
   *  to the external `worktrunk` CLI via the WorktreeBackend abstraction (FN-4622).
   *  Default: false. */
  enabled?: boolean;
  /** Absolute path to the `worktrunk` binary. When undefined, Fusion resolves via
   *  $PATH and falls back to the auto-install flow (FN-4624). */
  binaryPath?: string;
  /** Behavior when a delegated worktrunk operation fails.
   *  - "fail" (default): operation fails, task is paused with
   *    pausedReason "worktrunk_operation_failed", error surfaces to dashboard.
   *  - "fallback-native": fall back to Fusion's built-in worktree-pool and
   *    emit a one-shot dashboard alert. */
  onFailure?: WorktrunkOnFailure;
  /** Cached install path discovered by the auto-install flow.
   *  Set by Fusion engine; not intended for manual edits. */
  installedBinaryPath?: string;
}

/**
 * FNXC:McpConfig 2026-06-25-00:00:
 * MCP servers are trusted once enabled because downstream runtime slices may launch local commands or connect to operator-provided URLs. Store only declarations here; sensitive env, header, and token material MUST be represented as Fusion-managed secret references, never inline plaintext.
 */
export interface McpSecretRef {
  secretRef: string;
  scope: SecretScope;
}

export function isMcpSecretRef(value: unknown): value is McpSecretRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.secretRef === "string" &&
    candidate.secretRef.trim().length > 0 &&
    (candidate.scope === "project" || candidate.scope === "global")
  );
}

export type McpSensitiveValue = McpSecretRef | string;

export interface McpStdioTransport {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, McpSensitiveValue>;
}

export interface McpSseTransport {
  transport: "sse";
  url: string;
  headers?: Record<string, McpSensitiveValue>;
}

export interface McpStreamableHttpTransport {
  transport: "streamable-http";
  url: string;
  headers?: Record<string, McpSensitiveValue>;
}

export type McpTransport = McpStdioTransport | McpSseTransport | McpStreamableHttpTransport;

export type McpServerDefinition = {
  name: string;
  enabled?: boolean;
} & McpTransport;

export interface McpServersSettings {
  enabled?: boolean;
  servers?: McpServerDefinition[];
}

/*
FNXC:DashboardShortcuts 2026-07-04-00:00:
FN-7553 adds four more configurable actions on top of the FN-7494/FN-7507 base (quickChat, terminal), each reusing an existing App navigation handler (no new nav destinations). All fields share blank-to-disable semantics: an empty string disables that action's runtime listener.
*/
export interface DashboardKeyboardShortcuts {
  /** Opens the dashboard Quick Chat surface. Empty string disables this shortcut. Default: "Space". */
  quickChat?: string;
  /** Opens or toggles the dashboard Terminal surface. Empty string disables this shortcut. Default: "Ctrl+`". */
  terminal?: string;
  /** Opens the dashboard Files browser. Empty string disables this shortcut. Default: "Ctrl+E". */
  openFiles?: string;
  /** Opens the dashboard Settings view. Empty string disables this shortcut. Default: "Ctrl+,". */
  openSettings?: string;
  /** Opens the dashboard Command Center view. Empty string disables this shortcut. Default: "Ctrl+K". */
  openCommandCenter?: string;
  /** Opens the New Task modal. Empty string disables this shortcut. Default: "Ctrl+Shift+N". */
  newTask?: string;
}

export interface BackupSettingsMigrationCandidate {
  source: "global" | "project";
  projectId?: string;
  value: unknown;
}

/** A preserved operator-choice record when legacy project backup values diverge. */
export interface BackupSettingsMigrationConflict {
  key: "autoBackupEnabled" | "autoBackupSchedule" | "autoBackupRetention" | "autoBackupDir";
  candidates: BackupSettingsMigrationCandidate[];
  recordedAt: string;
}

export interface GlobalSettings {
  /** Maximum PostgreSQL server connections for Fusion's embedded database. Applied on the next Fusion restart. */
  embeddedPostgresMaxConnections?: number;
  /** Theme mode preference: dark, light, or system (follows OS). Default: "dark". */
  themeMode?: ThemeMode;
  /** Color theme preference for accent colors and styling. Default: "shadcn-ember"; "default" and "ocean" remain valid explicit legacy selections. */
  colorTheme?: ColorTheme;
  /** Token→hex override map for the customizable shadcn theme. Applied only when `colorTheme === "shadcn-custom"`; dashboard sanitizes keys and values before writing CSS custom properties. */
  shadcnCustomColors?: Record<string, string>;
  /** Dashboard font size scale percentage. Bounded to 85-125. Default: 100. */
  dashboardFontScalePct?: number;
  /** When true, automatic database backups for the shared PostgreSQL cluster are enabled. Default: false. */
  autoBackupEnabled?: boolean;
  /** Cron expression for the shared database backup schedule. Default: "0 2 * * *". */
  autoBackupSchedule?: string;
  /** Number of shared database backup files to retain. Default: 7. */
  autoBackupRetention?: number;
  /** Directory for shared database backup files, relative to the global Fusion directory. Default: ".fusion/backups". */
  autoBackupDir?: string;
  /** Durable candidates requiring an operator choice after project-to-global backup migration. */
  backupSettingsMigrationConflicts?: BackupSettingsMigrationConflict[];
  /** When false, fn dashboard and fn serve skip automatic mDNS/DNS-SD LAN discovery. Default: true (FN-8202 opt-out). */
  localNetworkDiscoveryEnabled?: boolean;
  /**
   * FNXC:DashboardShortcuts 2026-07-04-00:00:
   * Dashboard keyboard shortcuts are global operator preferences because they control browser UI affordances, not project execution policy. Defaults keep Space for Quick Chat and Ctrl+` for Terminal; blank values intentionally disable an action.
   */
  dashboardKeyboardShortcuts?: DashboardKeyboardShortcuts;
  /**
   * FNXC:ModalDismissal 2026-06-29-00:00:
   * Modal backdrop dismissal is a global operator preference, not project policy. Default false keeps fixed modal overlays from closing on accidental outside clicks unless the operator opts in.
   */
  dismissModalsOnOutsideClick?: boolean;
  /**
   * FNXC:Settings 2026-07-16-05:30:
   * This global operator preference defaults to false. When enabled, the dashboard skips centralized critical-action confirmations and proceeds with their primary/default choice. It must never be project-scoped so shared projects cannot force destructive actions without a prompt.
   */
  skipConfirmationDialogs?: boolean;
  /** Active UI locale (e.g. `"en"`, `"zh-CN"`, `"fr"`). One of `SUPPORTED_LOCALES`.
   *  When unset, each surface resolves the locale at runtime (browser/env
   *  detection) and falls back to `DEFAULT_LOCALE` ("en"). */
  language?: Locale;
  /** Default AI model provider name (e.g. `"anthropic"`, `"openai"`).
   *  Must be set together with `defaultModelId`. When both are undefined,
   *  the engine uses pi's automatic model resolution. */
  defaultProvider?: string;
  /** Default AI model ID within the provider (e.g. `"claude-sonnet-4-5"`).
   *  Must be set together with `defaultProvider`. When both are undefined,
   *  the engine uses pi's automatic model resolution. */
  defaultModelId?: string;
  /** When true, force every AI lane onto the deterministic mock provider regardless
   *  of per-task or per-lane overrides. No network calls, zero token cost.
   *  Project `testMode` takes precedence over the global value. */
  testMode?: boolean;
  /**
   * User-edited or one-click-fetched pricing entries keyed by lowercased `provider:model`.
   *
   * FNXC:CommandCenter 2026-06-22-00:00:
   * Global pricing overrides let Command Center cost estimates reflect user-maintained or LiteLLM-refreshed rates while preserving the built-in MODEL_PRICING fallback for unedited models.
   */
  modelPricingOverrides?: Record<string, ModelPricing>;
  /** ISO timestamp for the last successful pricing refresh from the configured source. */
  modelPricingFetchedAt?: string;
  /** Source label or URL for the current global pricing override set. */
  modelPricingSource?: string;
  /** Fusion Model Router opt-in (U17/KTD9). When true, a conservative selection
   *  layer may down-route an allowlist of mechanical steps (dependabot bumps,
   *  lint-only fixes) to a cheap model tier before a session starts; everything
   *  else resolves to the configured default pair. OFF by default — when unset or
   *  false, model resolution is byte-identical to its non-router behavior.
   *  Selection is governed: it never returns a pair the model controls forbid and
   *  always defers to a column-agent override. */
  modelRouterEnabled?: boolean;
  /** Provider for the Model Router's cheap tier (U17). Used only when
   *  `modelRouterEnabled` is true and a step is allowlisted for down-routing.
   *  Must be set together with `modelRouterCheapModelId`; if either is unset the
   *  router falls back to the configured default pair. */
  modelRouterCheapProvider?: string;
  /** Model ID for the Model Router's cheap tier (U17). See
   *  `modelRouterCheapProvider`. */
  modelRouterCheapModelId?: string;
  /** Phase-1 FN-5741 write-only shadow seam toggle.
   *  When true, executor/self-healing/merger persist additive merge-request contract
   *  records and completion-handoff markers without changing merge authority.
   *  Project value (if set) takes precedence over this global value. Default: false. */
  mergeRequestContractShadowEnabled?: boolean;
  /** Fallback AI model provider used when the primary default model fails due to
   *  transient provider-side issues such as rate limits or overloaded capacity.
   *  Must be set together with `fallbackModelId`. */
  fallbackProvider?: string;
  /** Fallback AI model ID used with `fallbackProvider` when the primary default
   *  model fails due to transient provider-side issues such as rate limits or
   *  overloaded capacity. Must be set together with `fallbackProvider`. */
  fallbackModelId?: string;
  /**
   * FNXC:Settings-ThinkingLevel 2026-07-10-11:13:
   * Fallback model lanes carry optional thinking companions so a swapped-in fallback can run at its own reasoning effort. Undefined means inherit; FN-7793 stores the schema foundation only, without runtime application or UI wiring.
   * Optional thinking effort for the global fallback model pair. Inherits the default thinking level when unset.
   */
  fallbackThinkingLevel?: ThinkingLevel;
  /** Default thinking effort level for AI agent sessions.
   *  Controls how much reasoning effort the model uses — higher levels
   *  produce better results but cost more. When undefined, the engine
   *  uses the model's default thinking level. */
  defaultThinkingLevel?: ThinkingLevel;
  /** When true, enables ntfy.sh push notifications for task completion and failures.
   *  Requires ntfyTopic to be set. Default: false. */
  ntfyEnabled?: boolean;
  /**
   * FNXC:AgentClarification 2026-07-16-12:00:
   * Controls proactive planner clarification checkpoints. Disabled sessions re-prompt
   * for a final summary; enabled sessions hold for input and notify via ntfy/mailbox.
   */
  agentClarificationEnabled?: boolean;
  /** ntfy.sh topic name for push notifications. When set along with ntfyEnabled,
   *  notifications are sent to {ntfyBaseUrl}/{topic} (default: https://ntfy.sh/{topic})
   *  when tasks complete or fail. */
  ntfyTopic?: string;
  /** Optional ntfy server base URL for push notifications.
   *  Must be an http:// or https:// URL. When omitted, notifications default to
   *  https://ntfy.sh. Example: "https://ntfy.internal.example" */
  ntfyBaseUrl?: string;
  /** Optional ntfy access token used for authenticated publishes.
   *  When set, Fusion sends `Authorization: Bearer <token>` with ntfy requests.
   *  Leave undefined to publish without authentication. */
  ntfyAccessToken?: string;
  /** List of notification events to send via ntfy.sh.
   *  When ntfyEnabled is true, only events in this list will trigger notifications.
   *  If undefined or empty when ntfyEnabled is true, all events are sent (backward compatible).
   *  Default: ["in-review", "merged", "failed"] */
  ntfyEvents?: NtfyNotificationEvent[];
  /** Dashboard hostname for ntfy.sh deep links. When set along with ntfyEnabled
   *  and ntfyTopic, notifications include a Click URL that opens the dashboard
   *  directly to the task. In multi-project setups the URL includes both
   *  ?project=<id>&task=<id> so the dashboard opens the correct project first.
   *  Example: "http://localhost:3000" or "https://fusion.example.com" */
  ntfyDashboardHost?: string;
  /** Optional global fallback per-task token budget defaults. */
  taskTokenBudget?: TaskTokenBudget;
  /** Default access policy applied to a secret when its row-level `access_policy`
   *  is null/unset. One of "auto" (return value to caller and audit),
   *  "prompt" (route through approvals), or "deny" (reject without prompt).
   *  Default when unset: "prompt". */
  secretsAccessPolicy?: SecretAccessPolicy;
  /** Read-only derived probe for cross-node secrets sync passphrase state.
   * Mirrors `hasSyncPassphraseConfigured(secretsStore)` against the reserved
   * `__sync_passphrase__` row in `secrets_global`. Never includes plaintext and
   * cannot be persisted via `updateSettings` / `updateGlobalSettings`. */
  secretsSyncPassphraseConfigured?: boolean;
  /** Policy for recovering tasks whose existing owning node becomes unavailable. */
  owningNodeHandoffPolicy?: OwningNodeHandoffPolicy;
  /** How long a task must remain in `status='failed'` before a push notification fires.
   *  Set to 0 to dispatch immediately (legacy behavior). Default: 30000 ms. */
  failureNotificationDelayMs?: number;
  /** `sticky-only` (default) defers failure notifications by `failureNotificationDelayMs`
   *  and suppresses them if the task self-recovers. `all` restores the legacy
   *  immediate-dispatch behavior. `terminal-only` suppresses failure notifications
   *  while the engine is still auto-retrying, and only notifies once the task is
   *  parked paused (`task.paused === true`) or escalated (`column === "in-review"`
   *  with `status === "failed"`). */
  failureNotificationMode?: "sticky-only" | "all" | "terminal-only";
  /** When true, enables webhook notifications for task lifecycle events.
   *  Requires webhookUrl to be set. Default: false. */
  webhookEnabled?: boolean;
  /** URL to send webhook notifications to.
   *  Must be an http:// or https:// URL. */
  webhookUrl?: string;
  /** Format of the webhook payload.
   *  - "slack": Slack incoming webhook format ({ text: message })
   *  - "discord": Discord webhook format ({ content: message })
   *  - "generic": Structured JSON with event/task/timestamp fields
   *  Default: "generic". */
  webhookFormat?: "slack" | "discord" | "generic";
  /** List of notification events to send via webhook.
   *  When webhookEnabled is true, only events in this list trigger webhooks.
   *  If undefined or empty when webhookEnabled is true, all events are sent.
   *  Default: [] (all events). */
  webhookEvents?: string[];
  /** Pluggable notification providers configuration. Additive to legacy ntfy
   *  settings so existing ntfy configuration continues working unchanged. */
  notificationProviders?: NotificationProviderConfig[];
  /** User-defined OpenAI/Anthropic-compatible API providers. */
  customProviders?: CustomProvider[];
  /** The default project ID for CLI operations when --project flag is not provided.
   *  Used to determine which project to operate on when not in a project directory.
   *  Set via `fn project set-default <name>`. */
  defaultProjectId?: string;
  /** Whether the first-run setup wizard has been completed.
   *  Set to true when the user completes the multi-project setup process.
   *  Default: false (undefined until setup is completed). */
  setupComplete?: boolean;
  /** ISO timestamp for completion of the `fn onboard` CLI wizard.
   *  Distinct from dashboard `setupComplete` first-run flow state.
   *  Undefined means CLI onboarding has not completed yet. */
  cliOnboardingCompletedAt?: string;
  /** List of favorite provider names. Favorite providers appear at the top of
   *  model selection dropdowns. Order is preserved - earlier entries appear higher. */
  favoriteProviders?: string[];
  /** List of favorite model identifiers. Each entry is formatted as `{provider}/{modelId}`
   *  (e.g., `"anthropic/claude-sonnet-4-5"`). Favorited models appear as pinned rows
   *  at the very top of model selection dropdowns, before provider groups. Order is
   *  preserved - earlier entries appear higher. */
  favoriteModels?: string[];
  /** When true, the dashboard eagerly fetches the latest model catalog from
   *  the OpenRouter API at startup so the model picker shows all available
   *  OpenRouter models (not just the static built-in list). Default: true. */
  openrouterModelSync?: boolean;
  /** Optional OpenRouter app-attribution header overrides.
   *  Use-time defaults are referer=`https://runfusion.ai` and title=`Fusion`.
   *  Empty string values intentionally suppress sending that header. */
  openrouterAppAttribution?: { referer?: string; title?: string };
  /** Optional OpenRouter model-catalog filters for startup sync fetches.
   *  Values are sent as comma-joined query params (`supported_parameters`,
   *  `output_modalities`) when configured. */
  openrouterModelFilters?: OpenRouterModelFilters;
  /** Optional OpenRouter provider routing preferences forwarded to chat
   *  completions as `compat.openRouterRouting`.
   *  Supports order/ignore/only provider lists, fallback behavior, sort mode,
   *  and require-parameters preference. */
  openrouterProviderPreferences?: OpenRouterProviderPreferences;
  /** When true, startup refreshes the opencode-go model catalog via
   *  `opencode models opencode --refresh` so model pickers expose an up-to-date
   *  opencode-go provider list without waiting for a later session bootstrap.
   *  Default: true. */
  opencodeGoModelSync?: boolean;
  /** When true (default), checks npm for new versions of @runfusion/fusion and
   *  shows update notices in the CLI and dashboard. The actual cadence is
   *  governed by `updateCheckFrequency`. Disabled = no automatic checks at all. */
  updateCheckEnabled?: boolean;
  /** When true (default), the dashboard probes PATH for a globally-installed
   *  `fn`/`fusion` CLI binary so it can advertise install/upgrade actions in
   *  the UI. The probe spawns `<bin> --version`, which executes whichever
   *  `runfusion.ai` is on PATH. Set to false to skip the probe entirely —
   *  useful when the local dev process is the source of truth and shelling
   *  out to an outdated globally-installed binary is unwanted. */
  fnBinaryCheckEnabled?: boolean;
  /** Global fallback GitHub tracking repo in `owner/repo` format (FN-3868).
   *  Used when a project has no githubTrackingDefaultRepo. */
  githubTrackingDefaultRepo?: string;
  /** Global fallback configuration for public-roadmap report deduplication. */
  reportRoadmapDedupeEnabled?: boolean;
  reportRoadmapLabel?: string;
  reportRoadmapRepo?: string;
  /** Global GitLab integration enable flag. Undefined is effectively enabled for backward compatibility; projects can override this value. */
  gitlabEnabled?: boolean;
  /** Global fallback GitLab web instance URL. Defaults effectively to https://gitlab.com when unset.
   *  Project gitlabInstanceUrl overrides this value. */
  gitlabInstanceUrl?: string;
  /** Global fallback GitLab REST API base URL. When unset, Fusion derives `<instance>/api/v4`.
   *  Project gitlabApiBaseUrl overrides this value. */
  gitlabApiBaseUrl?: string;
  /**
   * FNXC:GitLabAuthentication 2026-07-02-00:00:
   * FN-7423 accepts personal, project, and group GitLab access tokens for later HTTP API import/tracking/comment/close tasks. Global values are fallbacks only; project settings override them and project/group token resource membership still constrains runtime access.
   */
  /** Global fallback GitLab access token. Stored as a plain settings string in this phase; UI must render it only as a password field. */
  gitlabAuthToken?: string;
  /** Global fallback GitLab token type label. Defaults effectively to "personal" when a token exists and this is unset. */
  gitlabAuthTokenType?: GitlabAuthTokenType;
  /** Cadence for automatic update checks. The dashboard's `/update-check`
   *  route uses this to decide whether to consult npm or return a cached
   *  result.
   *  - `manual`: never auto-check; only when the user clicks "Check now"
   *  - `on-startup`: refresh once when the server starts, then cache
   *    indefinitely until next startup
   *  - `daily` (default): 24h cache TTL
   *  - `weekly`: 7-day cache TTL
   */
  updateCheckFrequency?: "manual" | "on-startup" | "daily" | "weekly";
  /**
   * FNXC:UpdateChannels 2026-07-19-12:30:
   * See `UpdateChannel` in app-version.ts for the channel semantics.
   * Fusion ships on two release tracks: `stable` (npm dist-tag `latest`, GitHub
   * releases marked latest) and `beta` (npm dist-tag `beta`, GitHub prereleases
   * tagged `vX.Y.Z-beta.N`, cut from `main`). This setting selects which track
   * every update surface (CLI `fn update`, dashboard update check, desktop
   * electron-updater) offers. Channel resolution: `stable` sees only `latest`;
   * `beta` sees the semver-max of `latest` and `beta` so beta users are moved
   * forward when a promoted stable overtakes their prerelease. Switching
   * beta → stable never offers a downgrade; the user stays on their beta build
   * until the next stable release surpasses it (`fn update --channel stable --force`
   * is the explicit downgrade escape hatch). Default: `stable`.
   */
  updateChannel?: UpdateChannel;
  /** When true (default), the dashboard automatically reloads when a new build
   *  version is detected via /version.json polling or service worker activation.
   *  Set to false to suppress automatic reloads — the user must manually
   *  refresh to pick up updates. */
  autoReloadOnVersionChange?: boolean;
  /** When true, indicates the user has completed the AI model onboarding flow
   *  (connected at least one provider and selected a default model). When
   *  false/undefined, the dashboard will auto-open the onboarding modal.
   *  Also set to true when the user explicitly dismisses onboarding. */
  modelOnboardingComplete?: boolean;
  /** When true, route AI model calls through the locally-installed Claude CLI
   *  via the `pi-claude-cli` pi extension (instead of the direct Anthropic
   *  API). Enabling this also causes Fusion to symlink its skill into each
   *  project's `.claude/skills/fusion/` on `fn init`, `fn project add`,
   *  dashboard project creation, and server startup — so the skill is
   *  available inside Claude Code sessions that pi spawns.
   *
   *  When left undefined, detection falls back to scanning the `packages`
   *  array in the agent settings for `"npm:pi-claude-cli"` (legacy signal).
   *  Setting this field explicitly (true/false) always wins. */
  useClaudeCli?: boolean;
  /** When true, route Factory AI model calls through the locally-installed Droid CLI
   *  via the `droid-cli` provider path (instead of direct API provider calls).
   *
   *  When left undefined, Droid CLI routing stays disabled unless explicitly enabled
   *  by the dashboard auth toggle. Setting this field explicitly (true/false)
   *  always wins. */
  useDroidCli?: boolean;
  /** When true, enable llama.cpp model-provider support (provider ID: `llama-server`)
   *  via Fusion's bundled `@fusion/pi-llama-cpp` extension.
   *
   *  When left undefined, llama.cpp routing stays disabled unless explicitly enabled
   *  by the dashboard auth toggle. Setting this field explicitly (true/false)
   *  always wins. */
  useLlamaCpp?: boolean;
  /** When true, enable Cursor CLI model-provider support (provider ID: `cursor-cli`)
   *  through an operator-local Cursor CLI installation. */
  useCursorCli?: boolean;
  /**
   * FNXC:CursorCli 2026-07-02-00:00:
   * Operators need a global machine-local Cursor CLI executable override when PATH discovery resolves the wrong `cursor-agent`, `cursor`, `.cmd`, or `.bat` shim. Blank/undefined means Fusion must keep auto-detecting through PATH candidates.
   */
  cursorCliBinaryPath?: string;
  /** When true, enable Grok CLI model-provider support (provider ID: `grok-cli`)
   *  through an operator-local Grok CLI installation. Grok is API-key auth (not
   *  OAuth/session) — see `grokCliBinaryPath` below and the plugin's probe. */
  useGrokCli?: boolean;
  /**
   * FNXC:GrokCli 2026-07-08-00:00:
   * Operators need a global machine-local Grok CLI executable override when PATH discovery resolves the wrong `grok`/`.cmd`/`.bat` shim. Blank/undefined means Fusion must keep auto-detecting through PATH candidates.
   */
  grokCliBinaryPath?: string;
  /**
   * FNXC:OmpAcp 2026-07-13-22:50:
   * When true, enable Oh My Pi (omp) CLI model-provider support (provider ID: `omp-cli`)
   * through an operator-local `omp` install driven over ACP (`omp acp`).
   */
  useOmpCli?: boolean;
  /**
   * FNXC:OmpAcp 2026-07-13-22:50:
   * Global machine-local OMP CLI executable override when PATH discovery resolves the wrong
   * `omp`/`.cmd`/`.bat` shim. Blank/undefined means PATH auto-detection.
   */
  ompCliBinaryPath?: string;
  /** Global baseline AI model provider for task execution (executor agent).
   *  This is the global lane that project-level `executionProvider` can override.
   *  Must be set together with `executionGlobalModelId`. Falls back to
   *  `defaultProvider`/`defaultModelId` when undefined. */
  executionGlobalProvider?: string;
  /** Global baseline AI model ID for task execution.
   *  Must be set together with `executionGlobalProvider`. */
  executionGlobalModelId?: string;
  /** Global baseline AI model provider for planning/triage (specification) agent.
   *  This is the global lane that project-level `planningProvider` can override.
   *  Must be set together with `planningGlobalModelId`. Falls back to
   *  `defaultProvider`/`defaultModelId` when undefined. */
  planningGlobalProvider?: string;
  /** Global baseline AI model ID for planning/triage.
   *  Must be set together with `planningGlobalProvider`. */
  planningGlobalModelId?: string;
  /** Global baseline AI model provider for validator/reviewer agent.
   *  This is the global lane that project-level `validatorProvider` can override.
   *  Must be set together with `validatorGlobalModelId`. Falls back to
   *  `defaultProvider`/`defaultModelId` when undefined. */
  validatorGlobalProvider?: string;
  /** Global baseline AI model ID for validator/reviewer.
   *  Must be set together with `validatorGlobalProvider`. */
  validatorGlobalModelId?: string;
  /** Global baseline AI model provider for title summarization.
   *  This is the global lane that project-level `titleSummarizerProvider` can override.
   *  Must be set together with `titleSummarizerGlobalModelId`. Falls back to
   *  `defaultProvider`/`defaultModelId` when undefined. */
  titleSummarizerGlobalProvider?: string;
  /** Global baseline AI model ID for title summarization.
   *  Must be set together with `titleSummarizerGlobalProvider`. */
  titleSummarizerGlobalModelId?: string;
  /*
  FNXC:Settings-MergerModel 2026-07-13-07:52:
  Merger AI sessions (conflict resolution, clean-room merge, stash-conflict, PR-response helpers, merge commit agent) need a dedicated global baseline lane so operators can pin a merge-capable model without forcing the same choice onto executor/planner/reviewer. Project `mergerProvider`/`mergerModelId` override this pair; unset falls through to project/global default.
  */
  /** Global baseline AI model provider for merger agent sessions.
   *  Must be set together with `mergerGlobalModelId`. Falls back to
   *  `defaultProvider`/`defaultModelId` when undefined. */
  mergerGlobalProvider?: string;
  /** Global baseline AI model ID for merger agent sessions.
   *  Must be set together with `mergerGlobalProvider`. */
  mergerGlobalModelId?: string;
  /*
  FNXC:GitHubImportTranslate 2026-07-15-09:30:
  Global baseline translate lane. Import auto-translation runs one short readonly call per issue, so operators typically pin a cheap/fast model here rather than inheriting the executor/planner model.
  */
  /** Global baseline AI model provider for import auto-translation.
   *  Must be set together with `importTranslateGlobalModelId`. Falls back to the
   *  summarization lane, then `defaultProvider`/`defaultModelId`. */
  importTranslateGlobalProvider?: string;
  /** Global baseline AI model ID for import auto-translation.
   *  Must be set together with `importTranslateGlobalProvider`. */
  importTranslateGlobalModelId?: string;
  /** Optional global translate-lane thinking override. Inherits `defaultThinkingLevel` when unset. */
  importTranslateGlobalThinkingLevel?: ThinkingLevel;
  /** Optional global execution-lane thinking override. Inherits `defaultThinkingLevel` when unset. */
  executionGlobalThinkingLevel?: ThinkingLevel;
  /** Optional global planning-lane thinking override. Inherits `defaultThinkingLevel` when unset. */
  planningGlobalThinkingLevel?: ThinkingLevel;
  /** Optional global reviewer-lane thinking override. Inherits `defaultThinkingLevel` when unset. */
  validatorGlobalThinkingLevel?: ThinkingLevel;
  /** Optional global summarization-lane thinking override. Inherits `defaultThinkingLevel` when unset. */
  titleSummarizerGlobalThinkingLevel?: ThinkingLevel;
  /** Optional global merger-lane thinking override. Inherits `defaultThinkingLevel` when unset. */
  mergerGlobalThinkingLevel?: ThinkingLevel;
  /** The daemon authentication token (format: fn_<32 hex chars>).
   *  Used for authenticating CLI clients to the daemon server. */
  daemonToken?: string;
  /** Port for daemon mode server binding. Default: 4040. */
  daemonPort?: number;
  /** Host for daemon mode server binding. Default: "127.0.0.1" (localhost only).
   *  Set to "0.0.0.0" explicitly to expose the API on all interfaces — only do
   *  this if you understand the implications (terminal/exec endpoints become
   *  reachable from the LAN even with a bearer token). */
  daemonHost?: string;
  /** When true, enables automatic settings synchronization between nodes.
   *  Settings are pushed/pulled on the configured interval. Default: false. */
  settingsSyncEnabled?: boolean;
  /** When true, model auth credentials (API keys) are included in sync operations.
   *  Only applies when settingsSyncEnabled is also true. Default: false. */
  settingsSyncAuth?: boolean;
  /** How often automatic settings sync runs, in milliseconds.
   *  Valid values: 300000 (5m), 900000 (15m), 1800000 (30m), 3600000 (1h).
   *  Default: 900000 (15m). */
  settingsSyncInterval?: number;
  /** Conflict resolution strategy when synced settings differ between nodes.
   *  - "last-write-wins": The most recent change overwrites (default)
   *  - "always-ask": Prompt the user to choose
   *  - "keep-local": Keep the local version on conflict
   *  - "keep-remote": Accept the remote version on conflict
   *  Default: "last-write-wins". */
  settingsSyncConflictResolution?: "last-write-wins" | "always-ask" | "keep-local" | "keep-remote";
  /** Currently selected dashboard node ID. Used to restore the last-viewed node
   *  on fresh browser/PWA sessions. Null or undefined means viewing the local node.
   *  Persisted to global settings so it survives across browser restarts. */
  dashboardCurrentNodeId?: string;
  /** Map of node ID to the last-selected project ID for that node.
   *  The key is the node ID (use `"local"` for the local node).
   *  Persisted to global settings so project context is restored on fresh sessions.
   *  Clear individual entries by setting them to `undefined` (omitting from update).
   *  Clearing all entries returns the dashboard to overview mode. */
  dashboardCurrentProjectIdByNode?: Record<string, string>;
  /** When true, the dashboard TUI's memory guard will SIGKILL any running
   *  vitest processes once system memory usage crosses
   *  {@link vitestKillThresholdPct}. The kill is throttled to once per 30
   *  seconds. Default: true. */
  vitestAutoKillEnabled?: boolean;
  /** System-memory usage percent (0–100) at which the TUI memory guard
   *  triggers a vitest auto-kill. Clamped to [50, 99] in the UI.
   *  Default: 90. */
  vitestKillThresholdPct?: number;
  /** When true (default), persist tool argument/result payloads in task agent
   *  logs for `tool`, `tool_result`, and `tool_error` entries. Very large tool
   *  payloads may still be clipped server-side to keep dashboard log reads
   *  responsive. When false, tool timeline rows are still stored, but their
   *  verbose `detail` payload is omitted to reduce log size/noise. Distinct
   *  from `persistAgentThinkingLog`, which controls `thinking` rows. */
  persistAgentToolOutput?: boolean;
  /** When true, task chat receives engine-authored progress, failure, and rollback updates. Default: false. */
  proactiveTaskChatEnabled?: boolean;
  /** When true, persist `thinking` log entries from agent reasoning deltas for
   *  permanent (non-ephemeral) agents. Default: false (suppressed). */
  persistAgentThinkingLogPermanent?: boolean;
  /** When true, persist `thinking` log entries from agent reasoning deltas for
   *  ephemeral / task-worker / spawned agents. Default: false (suppressed). */
  persistAgentThinkingLogEphemeral?: boolean;
  /** @deprecated Use `persistAgentThinkingLogPermanent` and
   *  `persistAgentThinkingLogEphemeral` instead.
   *
   *  Legacy fallback: when explicitly set and one of the granular fields is
   *  undefined, this value seeds that undefined granular kind at read time.
   *  Default: false (suppressed). */
  persistAgentThinkingLog?: boolean;
  /** Global default for memory prompt inclusion mode across projects/agents.
   *  - "full": inline full curated memory content into prompts (default)
   *  - "index": include only a compact memory index, then fetch on demand via memory tools
   *  - "off": omit agent-memory prompt sections entirely
   */
  agentMemoryInclusionMode?: AgentMemoryInclusionMode;
  /** Research defaults shared across all projects.
   * Project settings may override these via `researchSettings`. */
  researchGlobalDefaults?: ResearchGlobalDefaults;
  /** Enable or disable the research subsystem globally.
   *  When false, dashboard/API entrypoints should reject new research runs.
   *  Default: true when research store exists. */
  researchGlobalEnabled?: boolean;
  /** Maximum concurrent research runs allowed by default.
   *  Default: 3. */
  researchGlobalMaxConcurrentRuns?: number;
  /** Default timeout for end-to-end research runs in milliseconds.
   *  Default: 300000 (5 minutes). */
  researchGlobalDefaultTimeout?: number;
  /** Default maximum number of sources the orchestrator may fetch per run.
   *  Default: 20. */
  researchGlobalMaxSourcesPerRun?: number;
  /** Default maximum number of synthesis rounds per run.
   *  Default: 2. */
  researchGlobalMaxSynthesisRounds?: number;
  /** Web search backend for auto-research. Default: "builtin"; web search itself cannot be disabled. */
  researchGlobalWebSearchProvider?: WebSearchBackend;
  /** SearXNG instance URL (required when researchGlobalWebSearchProvider is "searxng"). */
  researchGlobalSearxngUrl?: string;
  /** Brave Search API key (required when researchGlobalWebSearchProvider is "brave"). */
  researchGlobalBraveApiKey?: string;
  /** Google Custom Search API key (required when researchGlobalWebSearchProvider is "google"). */
  researchGlobalGoogleSearchApiKey?: string;
  /** Google Custom Search engine ID (required when researchGlobalWebSearchProvider is "google"). */
  researchGlobalGoogleSearchCx?: string;
  /** Tavily API key (required when researchGlobalWebSearchProvider is "tavily"). */
  researchGlobalTavilyApiKey?: string;
  /** Enable GitHub repository/issue search provider. Default: false. */
  researchGlobalGitHubEnabled?: boolean;
  /** Enable local project documentation search provider. Default: true. */
  researchGlobalLocalDocsEnabled?: boolean;
  /** Maximum search results per provider query. Default: 10. */
  researchGlobalMaxSearchResults?: number;
  /** HTTP fetch timeout in milliseconds for page/content fetching. Default: 30000. */
  researchGlobalFetchTimeoutMs?: number;
  /** User-Agent header for HTTP requests made by research providers. Default: "FusionResearchBot/1.0". */
  researchGlobalUserAgent?: string;
  /** Global-scoped remote access configuration persisted in `~/.fusion/settings.json`.
   *  Stores both provider configs, active provider selection, token strategy,
   *  and lifecycle restart metadata for remote tunnel orchestration. */
  remoteAccess?: RemoteAccessProjectSettings;
  /** Global defaults for user-configurable MCP servers.
   *  Project-level `mcpServers` entries override by server name and may disable
   *  a global server without deleting the global declaration. */
  mcpServers?: McpServersSettings;
  /** Global defaults for worktrunk integration.
   *  Merged with project-level `worktrunk` field-by-field in `getSettings()`/
   *  `getSettingsFast()` so partial project overrides inherit unspecified fields. */
  worktrunk?: WorktrunkSettings;
  /** Global-scoped experimental feature toggles.
   *  Each key is a feature flag name, and the value indicates whether it is enabled.
   *  Features not present in this map are considered disabled (fallback to false).
   *  This allows users to explicitly mark capabilities as experimental and toggle
   *  them on/off from the Settings dashboard.
   *
   *  Example shape:
   *  {
   *    "my-new-feature": true,
   *    "another-experiment": false
   *  }
   *
   *  Default: only dual-observe is emitted and remains disabled because it runs
   *  diagnostic shadow parity observation. Workflow columns and graph execution
   *  have graduated from this map; stale persisted values are ignored by their
   *  runtime helpers.
   *
   *  `claudeCliAcp` (default ON): routes the Claude CLI provider through the
   *  `claude-code-cli-acp` ACP bridge instead of `claude -p`. Effective only when
   *  the acp-runtime plugin is installed (it publishes the bundled bridge path);
   *  otherwise the provider fails closed to `-p`. Set false to force `-p`. */
  experimentalFeatures?: Record<string, boolean>;
  /** Per-adapter CLI-agent launch configuration (CLI Agent Executor, U15).
   *  Keyed by adapter id (e.g. `"claude-code"`, `"codex"`, `"generic"`). Each
   *  entry carries operator overrides layered over the adapter's shipped
   *  defaults: a command override, extra args, an autonomy mode, and env
   *  allowlist additions. Validated + sanitized at the write boundary
   *  (`sanitizeCliAgentsSettings`); invalid entries/fields are dropped.
   *
   *  Note: elevation expressed through ANY of these channels (autonomy mode,
   *  extra args, env additions, a non-default command override) is gated by a
   *  stored per-project approval at launch — see `@fusion/engine`'s
   *  `resolveEffectivePosture`. These settings only describe *intent*; the
   *  engine resolves and enforces posture. Default: {} (no overrides). */
  cliAgents?: Record<string, CliAgentSettings>;
}

/** Operator launch config for one CLI-agent adapter (U15). Values are layered
 *  over the adapter's shipped defaults at launch. All fields optional; an empty
 *  object means "use shipped defaults". */
export interface CliAgentSettings {
  /** Override for the binary path/name to invoke. A non-default value is treated
   *  as privileged (routes through the autonomy approval gate). */
  commandOverride?: string;
  /** Extra args appended after the adapter's computed base args. Free-form; the
   *  engine's elevation detector scans these for bypass markers. */
  extraArgs?: string[];
  /** Autonomy mode above the adapter baseline. `"default"` is the baseline (no
   *  elevation); `"elevated"` requests bypass-permissions-style autonomy and is
   *  gated. Kept as a string enum so adapters can map it to their own flags. */
  autonomyMode?: "default" | "elevated";
  /** Additional env var KEYS to forward from the parent process to the child.
   *  Names only (never values); the engine copies these from `process.env`.
   *  Service credentials (`FUSION_*`) are always excluded regardless. */
  envAdditions?: string[];
}

export type RemoteAccessProvider = "tailscale" | "cloudflare";

export interface RemoteAccessProvidersConfig {
  tailscale: {
    enabled: boolean;
    hostname: string;
    targetPort: number;
    acceptRoutes: boolean;
  };
  cloudflare: {
    enabled: boolean;
    quickTunnel: boolean;
    tunnelName: string;
    tunnelToken: string | null;
    ingressUrl: string;
  };
}

export interface RemoteAccessTokenStrategyConfig {
  persistent: {
    enabled: boolean;
    token: string | null;
  };
  shortLived: {
    enabled: boolean;
    ttlMs: number;
    maxTtlMs: number;
  };
}

export interface RemoteAccessLifecycleConfig {
  rememberLastRunning: boolean;
  wasRunningOnShutdown: boolean;
  lastRunningProvider: RemoteAccessProvider | null;
}

export interface RemoteAccessProjectSettings {
  activeProvider: RemoteAccessProvider | null;
  providers: RemoteAccessProvidersConfig;
  tokenStrategy: RemoteAccessTokenStrategyConfig;
  lifecycle: RemoteAccessLifecycleConfig;
}

/** GitHub authentication strategy used by project issue-tracking settings (FN-3868). */
export type GithubAuthMode = "gh-cli" | "token";

/** GitLab access-token family configured for future HTTP API integrations (FN-7423). */
export type GitlabAuthTokenType = "personal" | "project" | "group";

export interface SecretsEnvSettings {
  /** Default: false. When true, materialize env_exportable secrets into the worktree on creation. */
  enabled?: boolean;
  /** Default: ".env". Must be a relative path with no separators, "..", or null bytes. */
  filename?: string;
  /** Default: "merge". skip = leave existing file untouched; merge = preserve non-managed lines, overlay Fusion-managed block; replace = overwrite with managed block only. */
  overwritePolicy?: "skip" | "merge" | "replace";
  /** Optional case-sensitive key prefix filter — only secrets whose `key` starts with this prefix are exported. */
  keyPrefix?: string;
  /** Default: true. When true, refuse to write if `git check-ignore <filename>` reports the path is NOT ignored. */
  requireGitignored?: boolean;
}

/** @deprecated Use SecretsEnvSettings. */
export type SecretsEnvConfig = SecretsEnvSettings;

/**
 * Project-level settings stored in `.fusion/config.json`.
 *
 * These control how the engine operates for this particular project:
 * concurrency, merge strategy, worktree management, build/test commands, etc.
 * Runtime state fields (globalPause, enginePaused) also live here because
 * different projects may need independent pause control.
 */
export type ReportMode = "draft-review" | "auto-file";
export type ReportActionType = "bug" | "feedback" | "idea" | "help";
export type ReportTarget = "issue" | "discussion";

export interface ProjectSettings {
  /** Hard stop: when true, all automated agent activity is **immediately**
   *  terminated — active triage, execution, and merge agent sessions are
   *  killed, and the scheduler stops dispatching new work. Acts as a
   *  global emergency stop for the entire AI engine.
   *  Individual per-task pause flags are unaffected. */
  globalPause?: boolean;
  /** Tracks why globalPause was activated. "rate-limit" for automatic pauses,
   *  "manual" for user-initiated. Cleared on unpause. */
  globalPauseReason?: string;
  /** Default custom workflow (WF-…) applied to newly created tasks when the
   *  caller does not specify enabledWorkflowSteps. Overridable per task. */
  defaultWorkflowId?: string;
  /**
   * FNXC:TaskRevert 2026-07-05-00:00 (FN-7556):
   * Workflow selected for AI-undo board tasks (`createAiUndoTask`, engine
   * `task-revert.ts`) — these tasks surgically reverse ALREADY-SHIPPED code
   * while preserving unrelated later changes to the same files, so they
   * warrant a stricter default review posture than ordinary new work.
   * Defaults to `builtin:review-heavy` (see `DEFAULT_PROJECT_SETTINGS`).
   * Empty/unset means AI-undo tasks inherit the project default workflow
   * (today's pre-FN-7556 behavior). The route resolving this setting
   * (`POST /api/tasks/:id/revert`) validates the configured id exists and
   * falls back to inherit (undefined) on a blank/unknown value so a
   * misconfigured id never breaks AI-undo task creation.
   */
  aiUndoTaskWorkflowId?: string;
  /** Built-in workflow ids visible/selectable in project workflow pickers.
   *  Undefined preserves the default of showing every built-in workflow. */
  enabledBuiltinWorkflowIds?: string[];
  /** Raw CLI commands a user has explicitly approved for workflow CLI nodes
   *  (trust-on-first-use). A node's command must appear here before it runs;
   *  named scripts (settings.scripts) never require approval. */
  approvedWorkflowCliCommands?: string[];
  /** CLI-agent adapter ids the project owner has approved for ELEVATED autonomy
   *  (CLI Agent Executor, U15). An adapter must appear here before a launch whose
   *  resolved posture is elevated (bypass-permissions-style) is permitted; an
   *  unapproved elevation fails the launch with a typed error. Approving
   *  principal in v1: the daemon-token holder (the single workspace owner). */
  approvedCliAutonomyAdapters?: string[];
  /** Engine pause (soft pause): when true, the scheduler and triage
   *  processor stop dispatching **new** work (scheduling, triage
   *  specification, and auto-merge), but currently running agent sessions
   *  are allowed to finish naturally — no sessions are terminated.
   *  This is the normal on/off toggle for the AI engine.
   *  Contrast with {@link globalPause}, which is a hard stop that
   *  immediately terminates all active agent sessions. Has no additional
   *  effect when {@link globalPause} is also true (hard stop already
   *  covers everything). */
  enginePaused?: boolean;
  /**
   * FNXC:TaskTiming 2026-06-25-00:00:
   * Records the last time the engine process proved it was alive so startup recovery can exclude process-down wall-clock time from active task duration without changing firstExecutionAt.
   */
  engineLastActiveAt?: string;
  /** Maximum number of concurrent AI agents across all activity types
   *  (triage specification, task execution, and merge operations). */
  maxConcurrent: number;
  /**
   * FNXC:ExecutorToolFailureRetry 2026-07-16-12:00:
   * Bounded same-model retry before the executor terminal park. Tool markers are ignored, terminal tool_error counts, tool_result resets; per-run cursor claims prevent concurrent over-retry and count 0 preserves prior behavior. Values are floored and the backoff timer is unref'd. FN-7998 consumes this stable policy shape for escalation.
   */
  executorToolFailureRetryCount?: number;
  executorToolFailureRetryBackoffMs?: number;
  executorToolFailureThreshold?: number;
  /**
   * FNXC:ExecutorEscalation 2026-07-16-21:00:
   * Opt-in single-shot escalation runs only after FN-7996 exhausts same-model retries. The task model target enters the model-selection hierarchy as an override and the node target enters routing as a task override; default off prevents surprise cost or behavior changes.
   */
  executorModelEscalationEnabled?: boolean;
  executorEscalationProvider?: string;
  executorEscalationModelId?: string;
  executorEscalationNodeId?: string;
  /**
   * FNXC:VerificationConcurrency 2026-07-15-03:35:
   * Max concurrent verification subprocesses (fn_run_verification / merge testCommand builds) across all tasks in this process. Caps stacked monorepo typecheck/build pegging CPU when many tasks are in-progress. Default 1. Raise only on high-core hosts.
   */
  maxConcurrentVerifications?: number;
  /** Maximum number of concurrent triage/specification agents. When undefined,
   *  falls back to maxConcurrent. */
  maxTriageConcurrent?: number;
  /** System-wide maximum concurrent agents across ALL projects.
   *  When multiple projects are active, the sum of their in-flight agents
   *  will not exceed this limit. Applies to triage, execution, and merge.
   *  Default: 4. When undefined, falls back to CentralCore default (4). */
  globalMaxConcurrent?: number;
  maxWorktrees: number;
  pollIntervalMs: number;
  /** Global multiplier applied to all agent heartbeat intervals.
   *  For example, 0.5 halves the interval (faster checks), 2.0 doubles it (slower checks).
   *  Must be > 0. Default: 1 (no change). */
  heartbeatMultiplier?: number;
  /** Number of auto-claim candidates rendered in no-task heartbeat prompts. Range: 0-10. Default: 5. */
  autoClaimCandidatesInPrompt?: number;
  /** Opt engineer-role agents into no-task backlog auto-claim. Default: false. */
  engineerBacklogAutoClaim?: boolean;
  /** Sticky window for intake duplicate checks against soft-deleted tasks.
   * Unit: days. Default: 7. Set to 0 to disable tombstone-window widening. */
  tombstoneStickyWindowDays?: number;
  /** Heartbeat scope-discipline procedure mode.
   * - "strict": coordination-focused scope discipline (default)
   * - "lite": pre-FN-3884 behavior
   * - "off": minimal procedure with no scope-classification step
   */
  heartbeatScopeDiscipline?: HeartbeatScopeDisciplineMode;
  /** Heartbeat execution prompt template mode.
   * - "default": richer context with higher caps (default)
   * - "compact": lower caps to reduce prompt size
   */
  heartbeatPromptTemplate?: HeartbeatPromptTemplate;
  groupOverlappingFiles: boolean;
  /**
   * When true (default), file-overlap serialization ignores project-relative paths
   * containing any hidden dot segment (for example `.fusion/`, `.changeset/`,
   * `.github/`, `.env`, or `packages/.cache/out.js`). Set false to restore the
   * legacy behavior that counts hidden paths as overlap blockers.
   */
  ignoreHiddenOverlapPaths?: boolean;
  /** File/directory paths to ignore when evaluating overlap serialization.
   *  Entries are project-relative paths (for example: `docs/README.md`, `docs/`, `generated/*`).
   *  Absolute paths and `..` traversal are not allowed.
   *  When set, matching paths are excluded from overlap checks for both
   *  active in-progress tasks and in-review tasks with unmerged worktrees. */
  overlapIgnorePaths?: string[];
  /**
   * FNXC:FileBrowser 2026-06-29-00:00:
   * Project owners can opt the workspace file browser into slash-prefixed absolute paths for local admin workflows. Default false keeps browsing confined to the selected project/task workspace; this does not apply to task-local file APIs, memory, plugin bundles, worktree-copy validation, or Windows drive-letter paths.
   */
  allowAbsoluteFileBrowserPaths?: boolean;
  autoMerge: boolean;
  /** When true, force every AI lane onto the deterministic mock provider regardless
   *  of per-task or per-lane overrides. No network calls, zero token cost. */
  testMode?: boolean;
  /** Phase-1 FN-5741 write-only shadow seam toggle.
   *  Overrides global `mergeRequestContractShadowEnabled` when defined.
   *  Default: false. */
  mergeRequestContractShadowEnabled?: boolean;
  /** How completed in-review tasks should be finalized when autoMerge is enabled.
   *  - "direct": preserve the existing local squash-merge flow into the current branch
   *  - "pull-request": create or reuse a GitHub PR and wait for GitHub-side checks/reviews
   *    before merging through GitHub
   *  Default: "direct" for backward compatibility. */
  mergeStrategy?: MergeStrategy;
  /** When true, only auto-merge a pull request after it has at least one approving
   *  review (`reviewDecision === "APPROVED"`). Independent of GitHub's branch-protection
   *  `required` flag, so this works on free private repos where required reviewers can't
   *  be enforced server-side. Only applies when `mergeStrategy === "pull-request"`.
   *  Default: false. */
  requirePrApproval?: boolean;
  /** When true (default), the Review-response loop automatically acts on PR review
   *  threads (human + bot): it dispatches an agent that fixes + pushes + replies, or
   *  disagrees with reasoning. When false, the loop is inert — review threads are left
   *  untouched for a human to handle. Independent of `autoMerge`: with auto-resolution
   *  on but auto-merge off, threads are still resolved but the PR is NOT merged (the
   *  human checkpoint remains merge). U18, R15. Default: true. */
  autoResolveReviewComments?: boolean;
  /** Direct-merge commit routing mode.
   *  - "auto": squash single-substantive branches, preserve history for multi-substantive branches
   *  - "always-squash": always use the legacy squash path for direct merges
   *  - "always-rebase": always preserve individual branch commits during direct merges
   *  Only applies when mergeStrategy is "direct". Default: "always-squash". */
  directMergeCommitStrategy?: DirectMergeCommitStrategy;
  /** Auto-merge integration-root mode.
   *  - "reuse-task-worktree" (default): run the auto-merge cascade in the task worktree
   *  - "cwd-integration-branch": explicit opt-in only. Runs merge operations in the user's
   *    checked-out integration-branch worktree, violating the FN-5349 invariant unless the user
   *    explicitly accepts that risk.
   *  - "cwd-main": legacy alias for "cwd-integration-branch" (normalized at read time)
   *  Auto-merge only; manual/direct merge entrypoints outside auto-merge are unchanged. */
  mergeIntegrationWorktree?: MergeIntegrationWorktreeMode;
  /** After the merger advances the integration branch ref, what to do in *other*
   *  worktrees that have the same branch checked out (typically the user's
   *  project-root checkout that sat at the previous tip).
   *  - "off": do nothing; the user must `git pull` (or click the Merge Advance
   *    Notice banner's Pull button) to bring their checkout forward.
   *  - "ff-only": fast-forward the other worktree only when its index and
   *    working tree are clean. Dirty worktrees are left alone and the banner
   *    still surfaces for manual handling.
   *  - "stash-and-ff" (default): run the Smart Pull pipeline
   *    (stash → fast-forward → pop) so local edits survive across the
   *    auto-sync. Pop conflicts surface as `merge:auto-sync` audit events with
   *    `outcome: "stash-pop-conflict"` and are forwarded to the dashboard's
   *    existing stash-conflict modal.
   *  Only applies to direct merges (`mergeStrategy === "direct"`). */
  mergeAdvanceAutoSync?: MergeAdvanceAutoSyncMode;
  /** Explicit integration branch name (e.g. `main`, `master`, `trunk`, `develop`).
   *  Resolution order: `integrationBranch` → `baseBranch` → `origin/HEAD` → `main`.
   *  This value is used as the `projectDefaultBranch` input to `resolveTaskMergeTarget`. */
  integrationBranch?: string;
  /** When true, automatically push to the configured remote after a successful direct merge.
   *  The push process includes pulling the latest from the remote (rebase) first.
   *  If conflicts arise during the pull, they are resolved using the AI conflict resolution pipeline.
   *  Only applies when mergeStrategy is "direct". Default: false. */
  pushAfterMerge?: boolean;
  /** The git remote and branch to push to after merging (e.g. "origin", "origin main").
   *  When set to just a remote name (e.g. "origin"), the current branch is pushed.
   *  When set to "remote branch" format, both the remote and branch are specified.
   *  Only used when pushAfterMerge is true. Default: "origin". */
  pushRemote?: string;
  /** Policy for how to route execution when the selected node is unavailable/unhealthy.
   *  Applies to both project default node selection and per-task node overrides.
   *  - "block": prevent execution until the selected node is healthy/available (default)
   *  - "fallback-local": run on the local node when the selected node is unavailable */
  unavailableNodePolicy?: UnavailableNodePolicy;
  /** Policy for tasks already owned by an unavailable node.
   *  - "block": keep parked until owner recovers
   *  - "reassign-to-local": let local node take over (default)
   *  - "reassign-any-healthy": any healthy node may claim */
  owningNodeHandoffPolicy?: OwningNodeHandoffPolicy;
  /** Project-level research configuration overrides. */
  researchSettings?: ResearchProjectSettings;
  /** Optional per-project `.env` materialization settings for exportable secrets. */
  secretsEnv?: SecretsEnvSettings;
  /** Project-scoped MCP server overrides.
   *  Entries override global server declarations by name; `enabled: false` on a
   *  same-named entry disables that server for this project. */
  mcpServers?: McpServersSettings;
  /** Sandbox command-execution settings.
   *  When omitted, runtime behavior is preserved via native passthrough defaults. */
  sandbox?: SandboxProjectSettings;
  /** Project-level scheduled eval configuration overrides. */
  evalSettings?: EvalProjectSettings;
  /** Enable scheduled evaluation batches for recently completed tasks. */
  taskEvaluationEnabled?: boolean;
  /** Cron expression for scheduled task-evaluation batches. */
  taskEvaluationSchedule?: string;
  /** Optional provider override for scheduled task evaluation runs. */
  taskEvaluationProvider?: string;
  /** Optional model override for scheduled task evaluation runs. */
  taskEvaluationModelId?: string;
  /** Follow-up policy for scheduled task evaluation findings. */
  taskEvaluationFollowUpPolicy?: "off" | "suggest" | "create";
  /** Optional retention window (days) for task evaluation history. */
  taskEvaluationRetention?: number;
  /** Enable or disable the research subsystem for this project.
   *  When undefined, falls back to global settings.
   *  @deprecated Prefer researchSettings.enabled */
  researchEnabled?: boolean;
  /** Project-level maximum concurrent research runs.
   *  When undefined, falls back to global settings (default 3). */
  researchMaxConcurrentRuns?: number;
  /** Project-level default run timeout in milliseconds.
   *  When undefined, falls back to global settings (default 300000). */
  researchDefaultTimeout?: number;
  /** Project-level source fetch cap per run.
   *  When undefined, falls back to global settings (default 20). */
  researchMaxSourcesPerRun?: number;
  /** Project-level synthesis round cap per run.
   *  When undefined, falls back to global settings (default 2). */
  researchMaxSynthesisRounds?: number;
  /** ID of the pinned default execution node. Tasks without a per-task override run on this node. */
  defaultNodeId?: string;
  /** Shell command to run inside each new worktree immediately after creation.
   *  Useful for project-specific setup (e.g. `pnpm install --frozen-lockfile`, `cp .env.local .env`). */
  worktreeInitCommand?: string;
  /**
   * Repository-root-relative regular files copied into newly assigned non-resume task worktrees.
   *
   * FNXC:WorktreeCopyFiles 2026-06-24-00:00:
   * Operators need `.env`-style repo files available before worktree init commands run without embedding shell copy commands in setup. Entries stay root-relative, copy only regular files, and apply only when Fusion prepares a fresh or pooled assignment so resume worktrees keep their existing on-disk state.
   */
  worktreeCopyFiles?: string[];
  /** Custom test command for the project (e.g. "pnpm test") */
  testCommand?: string;
  /** Custom build command for the project (e.g. "pnpm build") */
  buildCommand?: string;
  /** When true, completed task worktrees are returned to an idle pool instead
   *  of being deleted. New tasks acquire a warm worktree from the pool,
   *  preserving build caches (node_modules, target/, dist/). Default: false. */
  recycleWorktrees?: boolean;
  /**
   * Controls whether the board shows worktree grouping and worktree-name labels in WIP/processing columns.
   *
   * FNXC:WorktreeGroupingSetting 2026-06-27-22:30:
   * This is an explicit show/hide project setting. The default-off state hides worktree grouping and labels in both legacy and workflow-mode WIP columns; when enabled, operators see grouping in every WIP/processing column, including workflow-mode columns flagged as counting toward WIP.
   */
  showWorktreeGrouping?: boolean;
  /**
   * When true, board task-card clicks open task detail in the right dock when that dock surface is active; otherwise board clicks keep the full main-panel task detail. Default: false.
   *
   * FNXC:OpenTasksInRightSidebar 2026-06-28-00:00:
   * This project-scoped setting is default-off so current board navigation is unchanged. When enabled, only Board card clicks may route to the tablet/desktop right dock; all non-board task-open paths and dock-inactive/mobile states must preserve the full-panel or existing modal behavior.
   */
  openTasksInRightSidebar?: boolean;
  /**
   * When true, ordinary board task-card clicks open task detail in the existing popped-out FloatingWindow task surface instead of the full main-panel task detail. Default: false.
   *
   * FNXC:MobileTaskPopups 2026-07-01-12:00:
   * This project-scoped setting is default-off so board navigation is unchanged until operators opt in. When enabled, it applies to board-card clicks on every viewport with no deep initial tab and reuses the existing task pop-out/FloatingWindow path; the popup route takes precedence over right-dock routing for those ordinary clicks while all non-board task-open paths remain governed by their existing settings and handlers.
   */
  openMobileTasksInPopup?: boolean;
  /**
   * When true, open task-detail popups render only on the view where they were opened. Default: true.
   *
   * FNXC:TaskPopupViewGating 2026-07-15-15:20:
   * FN-8016 removed the Board/List restriction so every dashboard view can own task-detail FloatingWindows. This project-scoped setting defaults on; explicit false retains legacy globally shared popups. Scoped popup state is preserved across view switches and returning restores the same persisted position.
   */
  taskPopupsBoardListOnly?: boolean;
  /**
   * FNXC:TaskCardCostBadge 2026-07-11-12:15:
   * Default-off project setting that lets operators opt board cards into showing derived read-time task cost next to the execution-time badge. Missing/false preserves existing card density and no badge shell renders unless a task has positive token usage.
   */
  showCostBadgeOnCards?: boolean;
  /**
   * FNXC:TaskDetailActivityFirst 2026-06-30-23:59:
   * Default-off keeps task details Activity-first so omitted non-done opens land on the legacy `chat` Activity → Live surface. Operators can set true to restore Chat-first ordering/default while explicit Activity/Chat/Logs deep links remain stable.
   */
  taskDetailChatFirst?: boolean;
  /** When true, restores the legacy behavior of silently creating sibling
   *  branches like `fusion/FN-123-2` when the canonical task branch is already
   *  checked out elsewhere. Default: false. */
  executorAllowSiblingBranchRename?: boolean;
  /** Controls how worktree directory names are generated when creating fresh worktrees.
   *  - "random": Human-friendly adjective-noun names (e.g., swift-falcon) — default
   *  - "task-id": Use the task ID (e.g., fn-042) — ALSO enables task-pinned worktrees (see below)
   *  - "task-title": Use a slugified version of the task title (e.g., fix-login-bug)
   *  Default: "random".
   *
   *  For "random" and "task-title", this only affects the generated name and applies when
   *  recycleWorktrees is NOT enabled (pooled worktrees retain their existing names).
   *
   *  FNXC:TaskPinnedWorktrees 2026-07-16-00:00:
   *  "task-id" additionally enables the TASK-PINNED invariant: a task lives in exactly one derivable
   *  directory `<worktreesDir>/<lowercased-task-id>` for its whole lifecycle. Acquisition
   *  derives→validates→reuses-or-recreates at that same path (never suffixed), and `task.worktree` becomes a
   *  self-correcting cache. Task pinning and `recycleWorktrees` are MUTUALLY EXCLUSIVE — enabling both is
   *  rejected at the settings-write boundary (see `assertWorktreeNamingRecycleExclusive`), because pinning
   *  each task to its own directory is incompatible with the cross-task recycle pool. Pinning therefore only
   *  applies when `recycleWorktrees` is off; the runtime also degrades a legacy config that carries both back
   *  to recycling. Worktrunk-managed layouts own their own path derivation, so pinning is bypassed when that
   *  backend is on. */
  worktreeNaming?: "random" | "task-id" | "task-title";
  /** Project-level worktrunk integration overrides.
   *  Merged with global `worktrunk` field-by-field so partial project values
   *  override only specified fields and inherit the rest. */
  worktrunk?: WorktrunkSettings;
  /** Optional container directory for task worktrees.
   *  When unset, worktrees default to `<projectRoot>/.worktrees`.
   *  Supports leading `~` expansion and the `{repo}` token (basename of the project root).
   *  Accepts absolute paths or paths relative to the project root.
   *  Affects newly-created worktrees and pool/self-healing directory scans only;
   *  existing `task.worktree` absolute paths are honored as-is. */
  worktreesDir?: string;
  /** Prefix for generated task IDs (e.g. `"KB"` produces `KB-001`).
   *  Defaults to `"KB"`. Only affects new tasks — existing tasks retain
   *  their original IDs. */
  taskPrefix?: string;
  /** Preferred commit trailer keys for task attribution in priority order.
   *  The first value is used by commit-msg hook installation when enabled.
   *  Defaults to `["Fusion-Task-Id"]`. */
  taskAttributionTrailerNames?: string[];
  /** When true, Fusion installs a commit-msg hook in managed task worktrees
   *  that appends the configured task attribution trailer (e.g. `Fusion-Task-Id: FN-123`).
   *  Set to false for projects with custom hook infrastructure. Default: true. */
  commitMsgHookEnabled?: boolean;
  /** When true, merge commit messages include the task ID as the conventional
   *  commit scope (e.g. `feat(KB-001): ...`). When false, the scope is
   *  omitted (e.g. `feat: ...`). Default: true. */
  includeTaskIdInCommit?: boolean;
  /** When true, fusion appends a `Co-authored-by` trailer to all commits it
   *  creates so Fusion is credited alongside the user's git identity (which
   *  remains the primary author/committer). When false, no co-author trailer
   *  is added. Default: true. */
  commitAuthorEnabled?: boolean;
  /** Name used in the `Co-authored-by` trailer for Fusion commits.
   *  Only used when commitAuthorEnabled is true. Default: "Fusion". */
  commitAuthorName?: string;
  /** Email used in the `Co-authored-by` trailer for Fusion commits.
   *  Only used when commitAuthorEnabled is true. Default: "noreply@runfusion.ai". */
  commitAuthorEmail?: string;
  /** AI model provider for planning/triage (specification) agent.
   *  Must be set together with `planningModelId`. When both are undefined,
   *  falls back to `defaultProvider`/`defaultModelId`. */
  planningProvider?: string;
  /** AI model ID for planning/triage (specification) agent.
   *  Must be set together with `planningProvider`. When both are undefined,
   *  falls back to `defaultProvider`/`defaultModelId`. */
  planningModelId?: string;
  /** Fallback model provider for planning/triage. When unset, falls back to the
   *  global fallback model. Must be set together with `planningFallbackModelId`. */
  planningFallbackProvider?: string;
  /** Fallback model ID for planning/triage. When unset, falls back to the
   *  global fallback model. Must be set together with `planningFallbackProvider`. */
  planningFallbackModelId?: string;
  /** Workflow-declared planning fallback thinking override. Companion to the planning fallback provider/model pair; inherits when unset. */
  planningFallbackThinkingLevel?: ThinkingLevel;
  /** Project-level override for the base default AI model provider.
   *  When set, this overrides the global `defaultProvider`/`defaultModelId` baseline
   *  for all lanes that don't have their own explicit project override.
   *  Must be set together with `defaultModelIdOverride`. */
  defaultProviderOverride?: string;
  /** Project-level override for the base default AI model ID.
   *  Must be set together with `defaultProviderOverride`. */
  defaultModelIdOverride?: string;
  /**
   * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
   * Settings model lanes carry optional thinking overrides that inherit `defaultThinkingLevel` when unset. Runtime precedence is task `thinkingLevel` > lane thinking override > global `defaultThinkingLevel`.
   * Optional project default-lane thinking override used when a task does not set its own thinking level.
   */
  defaultThinkingLevelOverride?: ThinkingLevel;
  /**
   * FNXC:ChatModels 2026-07-12-20:45:
   * Projects can pin a default Direct-chat target as either a model pair with optional thinking level or a durable agent, then choose whether New Chat prompts with that default preselected or creates the session immediately.
   */
  chatNewSessionMode?: "prompt" | "always-default";
  /** Which configured default target kind New Chat should use or preselect. */
  chatDefaultKind?: "model" | "agent";
  /** Durable agent id used when `chatDefaultKind === "agent"`. */
  chatDefaultAgentId?: string;
  /** Model provider used when `chatDefaultKind === "model"`; must be paired with `chatDefaultModelId`. */
  chatDefaultModelProvider?: string;
  /** Model id used when `chatDefaultKind === "model"`; must be paired with `chatDefaultModelProvider`. */
  chatDefaultModelId?: string;
  /** Optional thinking-level override for the model chat default; undefined inherits the resolved project/global default. */
  chatDefaultThinkingLevel?: ThinkingLevel;
  /** Project-level AI model provider for task execution (executor agent).
   *  This is the execution lane that overrides the global `executionGlobalProvider`.
   *  Must be set together with `executionModelId`. Falls back to
   *  `executionGlobalProvider`/`executionGlobalModelId` or
   *  `defaultProviderOverride`/`defaultModelIdOverride` or
   *  `defaultProvider`/`defaultModelId` when undefined. */
  executionProvider?: string;
  /** Project-level AI model ID for task execution.
   *  Must be set together with `executionProvider`. */
  executionModelId?: string;
  /** Workflow-declared execution-lane thinking override. Inherits through task/default thinking when unset. */
  executionThinkingLevel?: ThinkingLevel;
  /*
   * FNXC:Settings-ExecutorModel 2026-07-16-00:00:
   * FN-8098 lets execution sessions select their own recovery model before the shared
   * fallback pair, so reviewer, merger, planning, and executor lanes can recover independently.
   */
  /** Workflow fallback provider for executor sessions. Must pair with `executionFallbackModelId`; resolves before the shared global fallback pair. */
  executionFallbackProvider?: string;
  /** Workflow fallback model ID for executor sessions. Must pair with `executionFallbackProvider`; resolves before the shared global fallback pair. */
  executionFallbackModelId?: string;
  /** Workflow executor-fallback thinking override. Inherits shared fallback thinking, then executor primary thinking. */
  executionFallbackThinkingLevel?: ThinkingLevel;
  /** Workflow-declared planning-lane thinking override. Inherits through task/default thinking when unset. */
  planningThinkingLevel?: ThinkingLevel;
  /** AI model provider for validator/reviewer agent.
   *  Must be set together with `validatorModelId`. When both are undefined,
   *  falls back to `defaultProvider`/`defaultModelId`. */
  validatorProvider?: string;
  /** AI model ID for validator/reviewer agent.
   *  Must be set together with `validatorProvider`. When both are undefined,
   *  falls back to `defaultProvider`/`defaultModelId`. */
  validatorModelId?: string;
  /** Fallback model provider for validator/reviewer. When unset, falls back to
   *  the global fallback model. Must be set together with
   *  `validatorFallbackModelId`. */
  validatorFallbackProvider?: string;
  /** Fallback model ID for validator/reviewer. When unset, falls back to the
   *  global fallback model. Must be set together with `validatorFallbackProvider`. */
  validatorFallbackModelId?: string;
  /** Workflow-declared validator fallback thinking override. Companion to the validator fallback provider/model pair; inherits when unset. */
  validatorFallbackThinkingLevel?: ThinkingLevel;
  /** Workflow-declared validator-lane thinking override. Inherits through task/default thinking when unset. */
  validatorThinkingLevel?: ThinkingLevel;
  /** Reusable model configuration presets for task creation. */
  modelPresets?: ModelPreset[];
  /** When true, task creation UIs automatically recommend/apply a preset based on task size. */
  autoSelectModelPreset?: boolean;
  /** Controls whether planning specs should require release documentation artifacts on completion.
   *  - "off": do not inject any release-documentation requirement
   *  - "changeset": require a `.changeset/*.md` entry when relevant
   *  - "changelog": require updating an existing changelog file (do not invent a new one)
   *  Default: "off" */
  completionDocumentationMode?: CompletionDocumentationMode;
  /** Controls whether task review deliverables are generated: off, user-facing, or on. PROMPT.md may override it. */
  reviewArtifacts?: ReviewArtifactsMode;
  /** Mapping of task sizes to preset IDs used for auto-selection during task creation. */
  defaultPresetBySize?: { S?: string; M?: string; L?: string };
  /** When true, auto-merge will automatically resolve common conflict patterns
   *  (lock files, generated files, trivial conflicts) without requiring AI
   *  intervention. When AI resolution fails, the system will retry with escalating
   *  strategies. Default: true. */
  autoResolveConflicts?: boolean;
  /** Alias for autoResolveConflicts. When true, enables automatic resolution of
   *  lock files (ours), generated files (theirs), and trivial whitespace conflicts
   *  without spawning an AI agent. Default: true. */
  smartConflictResolution?: boolean;
  /** Drop stale merger autostashes older than this age in hours. Minimum 1. Default: 24. */
  mergerAutostashMaxAgeHours?: number;
  /** When true, the merger fetches the remote and rebases the task branch
   *  onto the latest `<remote>/<defaultBranch>` before attempting to merge
   *  it back into the main branch. This catches upstream changes from
   *  other collaborators (or from a running fusion worker on another host)
   *  before they become a merge conflict. Auto-resolve still runs on any
   *  conflicts the rebase surfaces, so most of the time this is invisible.
   *  Default: true. */
  worktreeRebaseBeforeMerge?: boolean;
  /** Git remote to fetch from for the pre-merge rebase. When unset or empty,
   *  the merger resolves the default remote from the repo's configuration
   *  (typically `origin`). Exposed as a dropdown in the dashboard's
   *  Worktrees settings. */
  worktreeRebaseRemote?: string;
  /** When true, the worktree is also rebased onto the local default-branch
   *  HEAD (in addition to the remote rebase). Catches sibling tasks that
   *  merged into local main *after* this task's worktree was created but
   *  *before* its merge — including merges that haven't been pushed yet.
   *  Without this, concurrent task branches based on stale main can silently
   *  re-introduce code that an earlier sibling task already deleted.
   *  Default: true. */
  worktreeRebaseLocalBase?: boolean;
  /** Master switch for pre-merge auto-prerebase policy. When false, merger
   *  bypasses hot-file and divergence-threshold prerebase triggers.
   *  Default: true. */
  prerebaseAutoEnabled?: boolean;
  /** Shared-infrastructure file paths that trigger pre-merge auto-prerebase
   *  when they changed between `<task.baseCommitSha>` and local main HEAD.
   *  Empty array disables hot-file triggering.
   *  Default: curated project hot-file list. */
  prerebaseHotFiles?: string[];
  /** Commit-count threshold for pre-merge auto-prerebase. When the commit
   *  count of `<task.baseCommitSha>..localMainHead` exceeds this value, the
   *  merger auto-prerebases regardless of hot-file overlap.
   *  Set to 0 or undefined to disable count-based triggering.
   *  Default: 50. */
  prerebaseDivergenceThreshold?: number;
  /** Strategy used when a merge conflict can't be resolved by AI. See
   *  {@link MergeConflictStrategy}. Default: "smart". */
  mergeConflictStrategy?: MergeConflictStrategy;
  /**
   * FNXC:AutoMergeRetries 2026-06-17-04:20:
   * The auto-merge conflict-resolution retry cap is project-configurable so operators can tune when tasks park for human visibility. Default 3 preserves the historical fixed cap; non-positive or non-finite values fall back to the default.
   *
   * Maximum number of auto-merge conflict-resolution retries before a task is
   * parked as failed for manual recovery. Must be a positive integer. Default: 3.
   */
  maxAutoMergeRetries?: number;
  /** AI merge path configuration (FN-5633). See {@link MergerSettings}.
   *  When mode is "ai" (default), the standalone AI merge path is used and the
   *  legacy merge settings above/below it do not apply. */
  merger?: MergerSettings;
  /** Minimum branch net line volume before the pre-commit diff-volume gate evaluates a file. Default applied at read site: 20. */
  mergeDiffVolumeMinLines?: number;
  /** Minimum staged/branch-net ratio required by the pre-commit diff-volume gate. Default applied at read site: 0.2. */
  mergeDiffVolumeThreshold?: number;
  /** Additional file globs allowlisted by the pre-commit diff-volume gate on top of generated/lockfile patterns. Default applied at read site: []. */
  mergeDiffVolumeAllowlist?: string[];
  /** Controls overlap protection when `mergeConflictStrategy="smart-prefer-main"`
   *  reaches its Attempt 3 fallback. Default: "flip-to-prefer-branch". */
  mergeStrategyOverlapBehavior?: MergeStrategyOverlapBehavior;
  /** Controls how the merger reacts to a dirty post-merge / post-rebase audit (FN-4333).
   *  - "block" (default): throw `SquashAuditError`, park task as failed (today's behavior).
   *  - "warn": log audit findings on the agent log but auto-complete the merge.
   *  - "off": skip the post-merge audit entirely.
   *
   *  Regardless of mode, the merger short-circuits overlap-only findings on the
   *  rebase-strategy path when deterministic merge verification has already proven
   *  the resulting tree (silent drops are impossible by construction in that case). */
  postMergeAuditMode?: PostMergeAuditMode;
  /** Controls Stage 1–3 post-merge audit auto-recovery behavior before bounce/park.
   *  - "deterministic-only": verified-rebase short-circuit only.
   *  - "programmatic": deterministic + per-file contribution survival checks.
   *  - "ai-assisted" (default): programmatic + one AI restoration commit attempt.
   *  - "off": disable all recovery; audit blocks immediately.
   */
  mergeAuditAutoRecovery?: MergeAuditAutoRecoveryMode;
  /** Dispatcher-level reliability recovery policy (FN-4533/FN-4534). */
  autoRecovery?: AutoRecoverySettings;
  /** Optional ISO-8601 timestamp baseline for reliability metrics.
   *  When set, reliability windows are floored at this instant so historical
   *  events before the reset are excluded from aggregates (but not deleted). */
  reliabilityStatsResetAt?: string;
  /** Wall-clock timeout (ms) for a single pre-merge workflow step's AI call.
   *  When a step exceeds this, the session is aborted and the executor is
   *  given one shot to retry with the configured fallback model before the
   *  step is reported as failed. Default: 900_000 (15 minutes). */
  workflowStepTimeoutMs?: number;
  /** How pre-merge prompt workflow steps enforce declared File Scope at step end.
   *  - "block" (default): mark the step failed/revision-requested on off-scope writes
   *  - "warn": log off-scope writes but allow the step to pass
   *  - "off": disable workflow-step scope enforcement and keep legacy behavior */
  workflowStepScopeEnforcement?: "block" | "warn" | "off";
  /** Executor-side scope-leak policy at fn_task_done time for plan-only tasks (review level 1).
   *  - "off": disable guard
   *  - "warn" (default): log [scope-leak] activity but allow completion
   *  - "block": refuse fn_task_done when off-scope files are detected */
  planOnlyScopeLeakEnforcement?: "off" | "warn" | "block";
  /** When true (default), workflow revision feedback that explicitly names files
   *  outside the task's declared File Scope is forked into a dependent follow-up
   *  task instead of being appended to the original PROMPT.md. Set to false to
   *  preserve the legacy append-and-rerun behavior. */
  workflowRevisionForkOnScopeMismatch?: boolean;
  /** When true, out-of-scope file changes block merge instead of just logging warnings.
   *  Useful for teams that want strict enforcement of declared File Scope.
   *  Default: false (soft guardrail — warnings only). */
  strictScopeEnforcement?: boolean;
  /** Maximum number of build retry attempts during merge when a build fails with a
   *  transient error. Default: 0 (no retry). Set to 1 to allow one retry. */
  buildRetryCount?: number;
  /** Maximum number of times to attempt in-merge verification fixes when test/build
   *  commands fail during merge. The fix agent runs on the main branch with the merged
   *  code to resolve failures before aborting the merge. Default: 3. Set to 0 to disable. */
  verificationFixRetries?: number;
  /** Timeout in milliseconds for build commands during merge. Default: 300000 (5 min). */
  buildTimeoutMs?: number;
  /**
   * FNXC:Verification 2026-06-17-14:20:
   * Engine verification commands need a durable project-level budget so marathon test runs abort cleanly instead of tripping the stuck detector and requeueing forever.
   * When set, this millisecond value overrides both fn_run_verification scope defaults (package 300s, workspace 900s); when unset, the legacy per-scope defaults still apply.
   */
  verificationCommandTimeoutMs?: number;
  /**
   * FNXC:Verification 2026-06-25-00:00:
   * When true (default), merge/executor verification is narrowed to ONLY the
   * test files implicated by the task's branch diff — changed `*.test`/`*.spec`
   * files plus the co-located tests of changed source files — run via
   * `pnpm --filter <pkg> exec vitest run <files> --silent=passed-only
   * --reporter=dot`. This keeps verification proportional to the change
   * (seconds-to-<2min) and relies on the thin merge gate for cross-cutting
   * coverage. Applies to BOTH explicit and inferred test commands. When no test
   * files resolve from the diff, verification falls back to the existing
   * package-scoped/explicit command. Set false to always run the broader
   * package/full command. Default: true. */
  scopeVerificationToChangedFiles?: boolean;
  /** When enabled, AI-generated task specifications require manual approval
   *  before the task can move from triage to todo. Tasks with approved specs
   *  remain in triage with status "awaiting-approval" until a user approves
   *  or rejects the plan. Default: false. */
  requirePlanApproval?: boolean;
  /**
   * FNXC:PlanApproval 2026-06-26-00:00:
   * Per-project setting to control plan approval for every task: workflow defers to the per-workflow requirePlanApproval setting, auto-approve-all bypasses approval for all tasks, and require-all parks every approved spec for manual approval.
   *
   * FNXC:PlanApproval 2026-07-04-00:00:
   * FN-7557: default is now "auto-approve-all" (previously deferred to workflow via "workflow"). Unset/new projects bypass the manual awaiting-approval gate by default; projects with an explicit stored value are unaffected.
   */
  planApprovalMode?: "workflow" | "auto-approve-all" | "require-all";
  /** Controls task-worker execution mode.
   *  - true (default): spawn short-lived `executor-FN-XXXX` ephemeral workers per task
   *  - false: disable ephemeral workers; scheduler auto-assigns dispatchable tasks
   *    to permanent executor agents using the reporting chain heuristic.
   *  Tasks without an eligible permanent executor remain queued. */
  ephemeralAgentsEnabled?: boolean;
  /*
  FNXC:EphemeralAgentTaskCreation 2026-07-30-12:00:
  The three-state policy routes ephemeral-worker follow-ups to allow, operator validation, or deny.
  The policy has no schema default because resolver fallback must preserve persisted legacy false as deny.
  */
  ephemeralAgentTaskCreationPolicy?: EphemeralTaskCreationPolicy;
  /** @deprecated Legacy compatibility read only; resolve with resolveEphemeralTaskCreationPolicy. */
  ephemeralAgentsCanCreateTasks?: boolean;
  /** Approval policy for agent provisioning tools (fn_agent_create/fn_agent_delete). */
  agentProvisioning?: {
    approvalMode?: AgentProvisioningApprovalMode;
    trustedRoles?: string[];
    trustedAgentIds?: string[];
    alwaysApproveDelete?: boolean;
  };
  /** Approval policy for sandbox provisioning/bootstrap actions that mutate the host. */
  sandboxProvisioning?: {
    approvalMode?: SandboxProvisioningApprovalMode;
    trustedRoles?: string[];
    trustedAgentIds?: string[];
    /** Backend ids that may bootstrap without approval. Default: ["native"]. */
    autoApproveBackendIds?: string[];
  };
  /** Project default runtime permission-policy overrides for all agent lifetimes.
   *  Rules are a partial map of category -> disposition (`allow` | `block` | `require-approval`).
   *  Tool rules are exact tool-name overrides that take precedence over category rules.
   *  Missing categories and tools inherit the built-in `unrestricted` seed (`allow`). Agents without an explicit policy, including legacy ephemeral task workers, inherit this project default at runtime. */
  defaultAgentPermissionPolicy?: {
    rules?: Partial<AgentPermissionPolicyRules>;
    toolRules?: AgentPermissionPolicyToolRules;
  };
  /** When true, enforces that task specifications (PROMPT.md) are refreshed if they
   *  become stale. Stale specs are detected based on specStalenessMaxAgeMs.
   *  Default: false. */
  specStalenessEnabled?: boolean;
  /** Maximum age in milliseconds for a task specification before it is considered stale
   *  and requires regeneration. Only enforced when specStalenessEnabled is true.
   *  Default: 21600000 (6 hours). */
  specStalenessMaxAgeMs?: number;
  /** Timeout in milliseconds for detecting stuck tasks. When a task's agent session
   *  shows no activity (no text deltas, tool calls, or progress updates) for longer
   *  than this duration, the task is considered stuck and will be terminated and retried.
   *  Default: 600000 (10 minutes). Set to 0 to disable. */
  taskStuckTimeoutMs?: number;
  /** Number of rapid todo↔in-progress cycles allowed before auto-pausing the task.
   *  Default: 5. */
  dispatchOscillationThreshold?: number;
  /** Sliding time window in milliseconds used to count rapid todo↔in-progress cycles.
   *  Default: 60000 (1 minute). */
  dispatchOscillationWindowMs?: number;
  /** Delay before scheduler may re-dispatch an engine-requeued todo task.
   *  Default: 5000 (5 seconds). */
  dispatchOscillationSettleMs?: number;
  /** Maximum milliseconds InProcessRuntime.stop() waits for in-flight tasks to drain
   *  AFTER aborting their AI sessions. Default: 2000. Set to 0 to skip drain waits
   *  entirely (test/CI). Set to 30000 to preserve the historical 30s grace window. */
  runtimeStopDrainMs?: number;
  /** Epoch ms when the in-process runtime last became active (startup or transition
   *  out of globalPause/enginePaused). Time-based stuck/stalled/stale detectors floor
   *  their activity anchor at this value so engine downtime is not counted as quiet time.
   *  Stamped by the runtime; undefined when no runtime has come up yet. */
  engineActiveSinceMs?: number;
  /** Extra grace period in milliseconds added to engineActiveSinceMs before any
   *  time-based stuck/stalled/stale signal may fire after activation.
   *  Default: 300000 (5 minutes). Set to 0 to disable the grace period. */
  engineActivationGraceMs?: number;
  /** Minimum number of identical consecutive in-review stall log entries (same code + reason)
   *  before the task is auto-disposed with `pausedReason='in-review-stall-deadlock'`.
   *  Default: 3. Set to 0 to disable. */
  inReviewStallDeadlockThreshold?: number;
  /** Threshold in milliseconds for surfacing paused in-review tasks as stale.
   *  Age is measured from columnMovedAt when present, otherwise updatedAt.
   *  Default: 86400000 (24 hours). Set to 0 or undefined to disable surfacing. */
  stalePausedReviewThresholdMs?: number;
  /** Threshold in milliseconds for surfacing unpaused in-review tasks quiet beyond a time window.
   *  Default: 86400000 (24 hours). Set to 0 to disable. Gates `surfaceInReviewStalled`
   *  and the `Task.inReviewStalled` hydration.
   */
  inReviewStalledThresholdMs?: number;
  /** Threshold in milliseconds for surfacing paused todo tasks as stale.
   *  Age is measured from columnMovedAt when present, otherwise updatedAt.
   *  Default: 86400000 (24 hours). Set to 0 or undefined to disable surfacing. */
  stalePausedTodoThresholdMs?: number;
  /** Minimum age in milliseconds that a paused in-progress task may continue holding
   *  file-scope reservation while one or more followers are blocked by it.
   *  Self-healing rebounds qualifying holders to todo when this threshold is met.
   *  Default: 1800000 (30 minutes). Set to 0 to disable. */
  pausedScopeDecayMs?: number;
  /** Maximum age in milliseconds a meta-task may remain blocked without its target
   *  advancing before self-healing auto-archives it as superseded.
   *  Default: 7200000 (2 hours). Set to 0 to disable. */
  metaTaskStallAutoCloseMs?: number;
  /** Grace period in milliseconds used by meta-task auto-archive guards to treat
   *  recent executor activity as in-flight and skip destructive auto-archive.
   *  Default: 1800000 (30 minutes). Set to 0 to disable this guard. */
  metaTaskActiveExecutionGraceMs?: number;
  /** Rolling window in milliseconds for board-stall auto-recovery evaluation.
   *  Default: 7200000 (2 hours). */
  boardStallSweepWindowMs?: number;
  /** Minimum blocked-edge growth within the board-stall window that qualifies as a
   *  stall signal when there are zero transitions out of in-progress.
   *  Default: 3. */
  boardStallBlockedGrowthThreshold?: number;
  /** Age threshold in milliseconds before a blocker with high todo fan-out is escalated.
   *  Blocker age is measured from columnMovedAt when available, otherwise updatedAt.
   *  Only blockers currently in in-progress or in-review are eligible. */
  staleHighFanoutBlockerAgeThresholdMs?: number;
  /** Staleness warning threshold for tasks in in-progress, measured by column age.
   *  0 or undefined disables surfacing at this level. */
  staleInProgressWarningMs?: number;
  /** Staleness critical threshold for tasks in in-progress, measured by column age.
   *  0 or undefined disables surfacing at this level. */
  staleInProgressCriticalMs?: number;
  /** Staleness warning threshold for tasks in in-review, measured by column age.
   *  0 or undefined disables surfacing at this level. */
  staleInReviewWarningMs?: number;
  /** Staleness critical threshold for tasks in in-review, measured by column age.
   *  0 or undefined disables surfacing at this level. */
  staleInReviewCriticalMs?: number;
  /** When true, the dashboard shows the capacity-risk banner once
   *  capacityRiskTodoThreshold is exceeded with zero idle non-ephemeral agents.
   *  Default: false. */
  capacityRiskBannerEnabled?: boolean;
  /** Todo count threshold for raising a capacity-risk warning when there are zero
   *  idle non-ephemeral agents available. Warning fires only when todo is strictly
   *  greater than this threshold. Default: 20. */
  capacityRiskTodoThreshold?: number;
  /** Enables scheduler backlog-pressure imbalance alerts. Default: true. */
  backlogPressureAlertEnabled?: boolean;
  /** Todo/max(In-Progress,1) ratio above which backlog pressure alerting triggers.
   *  Must be a positive finite number. Default: 10. */
  backlogPressureRatioThreshold?: number;
  /** Minimum todo inventory required before backlog pressure alerting can trigger.
   *  Must be a positive finite number. Default: 5. */
  backlogPressureMinTodoCount?: number;
  /** Minimum cooldown in milliseconds between backlog-pressure alerts.
   *  Default: 24 * 60 * 60_000. */
  backlogPressureAlertCooldownMs?: number;
  /** Enables dependency-blocked todo backlog-health reporting. Default: true. */
  dependencyBlockedTodoReportEnabled?: boolean;
  /** Blocker age in milliseconds below which dependency-blocked todo groups are fresh.
   *  Default: 30 * 60_000 (30 minutes). */
  dependencyBlockedTodoFreshAgeMs?: number;
  /** Blocker age in milliseconds at or above which dependency-blocked todo groups are stale.
   *  Default: 4 * 60 * 60_000 (4 hours). */
  dependencyBlockedTodoStaleAgeMs?: number;
  /** Minimum dependency-blocked todo count required to include a blocker group.
   *  Default: 1. */
  dependencyBlockedTodoMinCount?: number;
  /** Minimum cooldown in milliseconds between dependency-blocked todo insight emissions.
   *  Default: 6 * 60 * 60_000. */
  dependencyBlockedTodoReportCooldownMs?: number;
  /** TTL in milliseconds for persisted AI planning/subtask/mission interview sessions.
   *  Sessions older than this cutoff are expired by the dashboard session cleanup loop.
   *  Valid range: 600000 (10 minutes) to 2592000000 (30 days).
   *  Default: 604800000 (7 days). */
  aiSessionTtlMs?: number;
  /** Interval in milliseconds for scheduled AI session cleanup sweeps.
   *  Valid range: 60000 (1 minute) to 86400000 (24 hours).
   *  Default: 3600000 (1 hour). */
  aiSessionCleanupIntervalMs?: number;
  /** When true, automatically unpause after rate-limit-triggered globalPause using
   *  escalating backoff. Allows unattended recovery from transient API rate limits.
   *  Default: true. */
  autoUnpauseEnabled?: boolean;
  /** Base delay in milliseconds before first auto-unpause attempt after rate-limit pause.
   *  Subsequent attempts use exponential backoff (2x). Default: 300000 (5 min). */
  autoUnpauseBaseDelayMs?: number;
  /** Maximum delay cap in milliseconds for auto-unpause backoff. Default: 3600000 (60 min). */
  autoUnpauseMaxDelayMs?: number;
  /** Maximum number of times the stuck-task detector can kill and re-queue a task
   *  before it is marked as permanently failed. Default: 6. */
  maxStuckKills?: number;
  /** Maximum branch-conflict auto-recovery retries before failing the task.
   *  Default: 5. */
  maxBranchConflictRecoveries?: number;
  /** Maximum reviewer context-limit compact-and-retry attempts before failing.
   *  Default: 2. */
  maxReviewerContextRetries?: number;
  /** Maximum reviewer fallback-model retry attempts before failing.
   *  Default: 2. */
  maxReviewerFallbackRetries?: number;
  /** Master cap across all retry categories before throwing RetryStormError.
   *  Default: 25. */
  maxTotalRetriesBeforeFail?: number;
  /** When the stuck-task detector kills and re-queues a task, preserve the
   *  task's recoverable step progress (step statuses + currentStep) instead
   *  of resetting every step to `pending`. Before clearing the worktree/branch
   *  for a fresh checkout, stuck-requeue cleanup resets completed/in-progress
   *  steps to `pending` if the branch has no unique commits, preventing deleted
   *  uncommitted-only work from being skipped on retry. Default: true. */
  preserveProgressOnStuckRequeue?: boolean;
  /** Maximum number of times the self-healing manager may auto-revive a task parked
   *  in `in-review` with a failed pre-merge workflow step. Also bounds the inline
   *  pre-merge optional-step fix → re-review cycle for Code Review and Browser
   *  Verification. Each revival injects the failure feedback into `PROMPT.md`, resets
   *  steps, and sends the task back through the normal todo → in-progress flow. Set
   *  to 0 to disable. Default: 3. */
  maxPostReviewFixes?: number;
  /** Maximum number of child agents a single parent agent can spawn.
   *  Limits the fan-out per executor task to prevent resource exhaustion.
   *  Default: 5. */
  maxSpawnedAgentsPerParent?: number;
  /** Maximum total spawned agents across all parent agents in a single executor instance.
   *  Provides a global safety cap regardless of how many parent agents are running.
   *  Default: 20. */
  maxSpawnedAgentsGlobal?: number;
  /** Interval in milliseconds for periodic maintenance (worktree pruning, WAL checkpoint,
   *  orphan cleanup). 0 disables. Default: 900000 (15 min). */
  maintenanceIntervalMs?: number;
  /** When true, periodic maintenance archives done tasks after the configured age. Default: true. */
  autoArchiveDoneTasksEnabled?: boolean;
  /** Age in milliseconds after a task enters done before auto-archive. Default: 172800000 (48h). */
  autoArchiveDoneAfterMs?: number;
  /** Retention in integer days before done tasks are auto-archived.
   *  0 disables this days-based override. When > 0, takes precedence over autoArchiveDoneAfterMs. */
  doneAutoArchiveDays?: number;
  /**
   * FNXC:DuplicateIntake 2026-07-07-00:00 (FN-7658):
   * Operators do not want same-agent duplicate tasks silently archived on
   * creation (FN-4892 intake heuristic) — they want visibility and a chance
   * to decide. When `true`, `_maybeAutoArchiveSameAgentDuplicate` archives the
   * later task as before. When `false` (the default), the heuristic still
   * detects the duplicate but flags it in place via the existing near-duplicate
   * marker (`nearDuplicateOf`/`nearDuplicateScore`) instead of moving it to
   * `archived`, so the dashboard's yellow "Duplicate" chip with Keep/Archive
   * actions surfaces it for a human decision. Default: false. */
  autoArchiveDuplicateTasksEnabled?: boolean;
  /**
   * FNXC:DuplicateIntake 2026-07-16-13:00:
   * Issue #2225 requires triage marker duplicates to stay visible by default: `prompt`
   * blocks for Keep/Delete, `keep` replans, and `delete` restores legacy deletion.
   */
  triageDuplicateResolution?: "prompt" | "keep" | "delete";
  /** How much agent log content to preserve when a task is moved to cold archive storage.
   *  - "compact": deterministic summary plus a small recent-entry snapshot (default)
   *  - "full": copy the full agent.log into archive.db
   *  - "none": do not copy agent.log content */
  archiveAgentLogMode?: ArchiveAgentLogMode;
  /** When true, automatically poll and update PR status badges for tasks linked to GitHub PRs.
   *  Default: false. */
  autoUpdatePrStatus?: boolean;
  /** When true, automatically post a comment to the originating GitHub issue
   *  when an imported task is moved to done. Default: false. */
  githubCommentOnDone?: boolean;
  /** Optional template used for GitHub issue comments posted on task completion.
   *  Supports `{taskId}` and `{taskTitle}` placeholders. */
  githubCommentTemplate?: string;
  /** When true, automatically close linked source-imported GitHub issues
   *  when a task moves to done. Default: false. */
  githubCloseSourceIssueOnDone?: boolean;
  /** When true, new tasks default GitHub tracking to enabled for this project (FN-3868).
   *  Default: false. */
  githubTrackingEnabledByDefault?: boolean;
  /**
   * FNXC:PlannerOversight 2026-07-14-18:11:
   * When true, new tasks default the session advisor (LLM overseer agent) to enabled.
   * Individual tasks can override via `sessionAdvisorEnabled`. Default: false (opt-in).
   * Provider/model still come from workflow settings (`plannerOverseerAdvisorProvider` /
   * `plannerOverseerAdvisorModelId`).
   */
  sessionAdvisorEnabledByDefault?: boolean;
  /**
   * FNXC:GithubImportTracking 2026-07-01-00:00:
   * This project-scoped switch is intentionally narrower than githubTrackingEnabledByDefault: it only forces imported GitHub issues to become GitHub-tracked tasks so the source issue is adopted, while ordinary new tasks keep their existing default behavior.
   * Default: false.
   */
  githubLinkImportedIssuesToTracking?: boolean;
  /** Project default GitHub tracking repo in `owner/repo` format (FN-3868).
   *  Falls back to global githubTrackingDefaultRepo when unset. */
  githubTrackingDefaultRepo?: string;
  /**
   * FNXC:ReportPipeline 2026-07-16-12:00:
   * In-app reports default to review before egress; operators can opt into
   * direct filing globally or for one of the four guided report actions.
   */
  reportMode?: ReportMode;
  reportModeByAction?: Partial<Record<ReportActionType, ReportMode>>;
  /*
  FNXC:ReportPipeline 2026-07-16-20:15:
  Report filing targets remain unset by default so the report pipeline retains
  its established action-specific routing. Operators may select a project-wide
  Issue/Discussion target, a per-action exception, and a Discussion category.
  */
  reportTarget?: ReportTarget;
  reportTargetByAction?: Partial<Record<ReportActionType, ReportTarget>>;
  reportDiscussionCategory?: string;
  /**
   * FNXC:ReportPipeline 2026-07-18-12:00:
   * FR-30 public-roadmap dedupe is an additive GitHub Issue source. Effective
   * values resolve project → global → built-in defaults and reuse tracking-repo
   * resolution when no dedicated roadmap repo is configured.
   */
  reportRoadmapDedupeEnabled?: boolean;
  reportRoadmapLabel?: string;
  reportRoadmapRepo?: string;
  /**
   * FNXC:GitLabConfiguration 2026-07-02-00:00:
   * FN-7422 adds durable GitLab instance/API URL settings for GitLab.com and self-managed hosts. FN-7423 layers token settings onto the same project-over-global configuration contract without adding runtime GitLab imports or tracking.
   */
  /** Project GitLab integration enable flag. Undefined inherits global gitlabEnabled, then defaults effectively enabled for backward compatibility. */
  gitlabEnabled?: boolean;
  /** Project GitLab web instance URL. Falls back to global gitlabInstanceUrl, then https://gitlab.com. */
  gitlabInstanceUrl?: string;
  /** Project GitLab REST API base URL. Falls back to global gitlabApiBaseUrl, then derives `<instance>/api/v4`. */
  gitlabApiBaseUrl?: string;
  /** Project GitLab access token for HTTP API auth. Stored as a plain settings string in this phase; UI must render it only as a password field. */
  gitlabAuthToken?: string;
  /** Project GitLab token type label. Defaults effectively to "personal" when a token exists and this is unset. */
  gitlabAuthTokenType?: GitlabAuthTokenType;
  /**
   * FNXC:GitLabLifecycle 2026-07-02-00:00:
   * GitLab comment and auto-close settings mirror GitHub lifecycle side effects but remain disabled by default and use the configured GitLab instance/API URL so GitLab.com and self-managed hosts behave consistently.
   */
  /** When true, automatically post a comment to the originating GitLab issue or merge request when an imported task is moved to done. Default: false. */
  gitlabCommentOnDone?: boolean;
  /** Optional template used for GitLab source comments posted on task completion. Supports `{taskId}` and `{taskTitle}` placeholders. */
  gitlabCommentTemplate?: string;
  /** When true, automatically close/reopen linked source-imported GitLab issues or merge requests on task done/undone lifecycle moves. Default: false. */
  gitlabCloseSourceIssueOnDone?: boolean;
  /** When true, tracking issue creation searches open/closed repo issues for likely duplicates before opening a new issue.
   *  Default: true (set false to opt out). */
  githubTrackingDedupEnabled?: boolean;
  /** GitHub auth strategy for issue-tracking API calls in this project (FN-3868).
   *  Default: "gh-cli". */
  githubAuthMode?: GithubAuthMode;
  /** Personal access token used when githubAuthMode is "token" (FN-3868).
   *  Stored as a plain settings string in this phase. */
  githubAuthToken?: string;
  /** When true, scheduled memory backups are enabled. Default: false. */
  memoryBackupEnabled?: boolean;
  /** Cron expression for memory backup schedule. Default: "0 3 * * *" (daily at 3 AM). */
  memoryBackupSchedule?: string;
  /** Number of memory backups to retain (oldest deleted when exceeded). Default: 14. */
  memoryBackupRetention?: number;
  /** Directory for memory backup snapshots, relative to project root.
   *  Default: ".fusion/backups/memory". */
  memoryBackupDir?: string;
  /** Scope of memory backup snapshots.
   *  - "project": backups `.fusion/memory` only
   *  - "agents": backups `.fusion/agent-memory` only
   *  - "all": backups both project and per-agent memory
   *  Default: "all". */
  memoryBackupScope?: "project" | "agents" | "all";
  /** When true, tasks created without titles but with descriptions longer than 200
   *  characters will automatically receive an AI-generated title (max 60 chars).
   *  Default: false. */
  autoSummarizeTitles?: boolean;
  /*
  FNXC:TaskDefinitionInputLanguage 2026-07-16-05:00:
  This opt-in localizes only planner-authored task-definition prose for supported detectable
  locales (en/es/fr/ko/zh-CN). Chinese always resolves to zh-CN because Traditional Chinese
  is not variant-detected; headings, markers, code, and unsupported input such as Japanese
  remain canonical English so deterministic PROMPT.md gates keep parsing safely.
  */
  /** When true, writes generated task-definition prose in the operator's detected supported
   *  input language. Default: false; uncertain or unsupported input falls back to English. */
  taskDefinitionInInputLanguage?: boolean;
  /** When true, merge commit messages include an AI-generated summary of the
   *  changes instead of just listing step commit subjects. Body composition
   *  includes a narrative line, bullet summary, and `git diff --stat` when
   *  available. Uses the title summarizer model. Default: true. */
  useAiMergeCommitSummary?: boolean;
  /** AI model provider for title summarization (when autoSummarizeTitles is enabled).
   *  Must be set together with `titleSummarizerModelId`. Falls back to planningProvider,
   *  then defaultProvider if not specified. */
  titleSummarizerProvider?: string;
  /** AI model ID for title summarization (when autoSummarizeTitles is enabled).
   *  Must be set together with `titleSummarizerProvider`. Falls back to planningModelId,
   *  then defaultModelId if not specified. */
  titleSummarizerModelId?: string;
  /** Optional project summarization-lane thinking override. Inherits `defaultThinkingLevel` when unset. */
  titleSummarizerThinkingLevel?: ThinkingLevel;
  /*
  FNXC:Settings-MergerModel 2026-07-13-07:52:
  Project-scoped merger lane overrides the global merger baseline for conflict resolution and related merge-agent sessions. Both provider and model id must be set together; partial pairs are ignored and fall through. Unset inherits global merger lane then project/global default.
  */
  /** Project AI model provider for merger agent sessions.
   *  Must be set together with `mergerModelId`. Falls back to
   *  `mergerGlobalProvider`/`mergerGlobalModelId`, then project/global default. */
  mergerProvider?: string;
  /** Project AI model ID for merger agent sessions.
   *  Must be set together with `mergerProvider`. */
  mergerModelId?: string;
  /** Optional project merger-lane thinking override. Inherits through global merger thinking then default thinking when unset. */
  mergerThinkingLevel?: ThinkingLevel;
  /*
  FNXC:Settings-MergerModel 2026-07-16-00:00:
  Merger session retries need a project-scoped fallback lane so operators can pin a merge-capable recovery model without changing the shared global fallback. Both provider and model id must be set; partial pairs fall through to the shared global fallback pair.
  */
  /** Project fallback AI model provider for merger agent sessions.
   *  Must be set together with `mergerFallbackModelId`. Resolves before the global
   *  `fallbackProvider`/`fallbackModelId` pair. */
  mergerFallbackProvider?: string;
  /** Project fallback AI model ID for merger agent sessions.
   *  Must be set together with `mergerFallbackProvider`. */
  mergerFallbackModelId?: string;
  /** Optional project merger-fallback thinking override. Falls through to global fallback thinking, then merger thinking. */
  mergerFallbackThinkingLevel?: ThinkingLevel;
  /*
  FNXC:GitHubImportTranslate 2026-07-15-09:30:
  Import Tasks auto-translation is a dedicated one-off AI helper lane, kept separate from the summarization lane so operators can pin a cheap/fast translation model without dragging title summarization onto it.
  Both provider and model id must be set together; partial pairs are ignored and fall through to global translate lane, then summarization, then project/global default.
  */
  /** Project AI model provider for GitHub/GitLab import auto-translation.
   *  Must be set together with `importTranslateModelId`. Falls back to
   *  `importTranslateGlobalProvider`/`importTranslateGlobalModelId`, then the
   *  summarization lane, then project/global default. */
  importTranslateProvider?: string;
  /** Project AI model ID for import auto-translation.
   *  Must be set together with `importTranslateProvider`. */
  importTranslateModelId?: string;
  /** Optional project translate-lane thinking override. Inherits through global translate thinking then default thinking when unset. */
  importTranslateThinkingLevel?: ThinkingLevel;
  /*
  FNXC:GitHubImportTranslate 2026-07-15-09:30:
  Auto-translation is OFF by default. This reverses the original opt-in-only stance (PR #2128) at operator request: import panels routinely list issues in languages the operator cannot read, so translation may now run automatically — but only when explicitly enabled, so import provenance stays faithful for operators who never opt in.
  */
  /** When true, the import panel automatically translates foreign-language issue
   *  title+body into `importTranslateTargetLocale` and shows the translation by
   *  default. Default: false (opt-in). */
  githubImportAutoTranslate?: boolean;
  /** Target language for import auto-translation. When unset, follows the
   *  operator's active dashboard locale. */
  importTranslateTargetLocale?: Locale;
  /** Fallback model provider for title summarization. When unset, falls back to
   *  planning fallback, then global fallback. Must be set together with
   *  `titleSummarizerFallbackModelId`. */
  titleSummarizerFallbackProvider?: string;
  /** Fallback model ID for title summarization. When unset, falls back to
   *  planning fallback, then global fallback. Must be set together with
   *  `titleSummarizerFallbackProvider`. */
  titleSummarizerFallbackModelId?: string;
  /** Optional project summarization fallback thinking override. Companion to the title summarizer fallback provider/model pair; inherits when unset. */
  titleSummarizerFallbackThinkingLevel?: ThinkingLevel;
  /**
   * FNXC:PrMetadataGeneration 2026-06-27-00:00:
   * Project operators can add title-specific guidance to the Create PR metadata prompt without replacing the strict JSON schema contract. Blank or whitespace-only values are treated as unset so the default prompt remains byte-for-byte unchanged.
   * Optional project-scoped guidance appended to the PR metadata system prompt for the generated `title` field. Default: undefined.
   */
  prTitlePromptInstructions?: string;
  /**
   * FNXC:PrMetadataGeneration 2026-06-27-00:00:
   * Project operators can add body-specific guidance to the Create PR metadata prompt without replacing the strict JSON schema contract. Blank or whitespace-only values are treated as unset so the default prompt remains byte-for-byte unchanged.
   * Optional project-scoped guidance appended to the PR metadata system prompt for the generated `summary`, `changes`, and `testing` fields. Default: undefined.
   */
  prDescriptionPromptInstructions?: string;
  /** Named scripts that can be referenced by setupScript or other automation.
   *  A map of script name to shell command. */
  scripts?: Record<string, string>;
  /** Reference to a named script in the scripts map that runs before task execution.
   *  Used for pre-task setup like environment preparation. */
  setupScript?: string;
  /** When true, enables periodic AI-powered extraction of insights from working memory
   *  into a distilled long-term memory file. Creates an automation schedule that reads
   *  `.fusion/memory/MEMORY.md`, identifies patterns/principles/pitfalls, and writes to
   *  `.fusion/memory/memory-insights.md`. Default: false. */
  insightExtractionEnabled?: boolean;
  /** Cron expression for insight extraction schedule. Only used when
   *  insightExtractionEnabled is true. Default: "0 2 * * *" (daily at 2 AM). */
  insightExtractionSchedule?: string;
  /** Minimum interval between insight extractions in milliseconds. Prevents
   *  excessive AI calls when working memory hasn't changed significantly.
   *  Extraction only runs if BOTH this time has elapsed AND memory has grown
   *  by more than MIN_INSIGHT_GROWTH_CHARS characters. Default: 86400000 (24h). */
  insightExtractionMinIntervalMs?: number;
  /** When enabled, agents will consult and update files under .fusion/memory/ with durable
   *  project learnings. When disabled, agents will not include memory instructions
   *  in their prompts and will not read or write to .fusion/memory/ files.
   *  Default: true (enabled for backward compatibility). */
  memoryEnabled?: boolean;
  /** Memory backend type for pluggable memory storage.
   *  Available built-in backends:
   *  - "qmd": QMD (Quantized Memory Distillation) backend using the qmd CLI tool (default)
   *  - "file": File-based backend storing memory in `.fusion/memory/`
   *  - "readonly": Read-only backend that returns empty memory (for external management)
   *  - Any registered custom backend type
   *  Default: "qmd" */
  memoryBackendType?: string;
  /** When true, enables automatic AI-powered summarization and compression of the
   *  working memory file when it exceeds the configured size threshold.
   *  Creates an automation schedule that checks memory size and compacts when needed.
   *  Default: false. */
  memoryAutoSummarizeEnabled?: boolean;
  /** Character count threshold that triggers automatic memory summarization.
   *  When working memory exceeds this size, the auto-summarize automation will
   *  compress it. Only used when memoryAutoSummarizeEnabled is true.
   *  Default: 50000. */
  memoryAutoSummarizeThresholdChars?: number;
  /** Cron expression for the auto-summarize check schedule. Only used when
   *  memoryAutoSummarizeEnabled is true.
   *  Default: "0 3 * * *" (daily at 3 AM, offset from insight extraction at 2 AM). */
  memoryAutoSummarizeSchedule?: string;
  /** When true, daily memory notes are periodically synthesized into DREAMS.md
   *  and durable lessons are promoted into `.fusion/memory/MEMORY.md`.
   *  Default: false. */
  memoryDreamsEnabled?: boolean;
  /** Cron expression for dream processing. Only used when memoryDreamsEnabled
   *  is true. Default: "0 4 * * *" (daily at 4 AM). */
  memoryDreamsSchedule?: string;
  /** Maximum token count before auto-compact triggers. When undefined, compact
   *  only on overflow errors. When set, the engine monitors token usage after
   *  each prompt and proactively compacts context when the token count reaches
   *  this threshold. */
  tokenCap?: number;
  /** Optional per-task token budget defaults (soft/hard with optional size overrides). */
  taskTokenBudget?: TaskTokenBudget;
  /** When true, each task step runs in its own fresh agent session instead of a
   *  single session for the entire task. Enables per-step error recovery and
   *  optional parallel execution when steps have non-overlapping file scopes.
   *  Default: false. */
  runStepsInNewSessions?: boolean;
  /** Maximum number of steps to run in parallel when runStepsInNewSessions is
   *  enabled and steps have non-overlapping file scopes. Range: 1–4.
   *  Default: 2. */
  maxParallelSteps?: number;
  /** Time in milliseconds after which a mission in `activating` state is
   *  considered stale and eligible for self-healing recovery.
   *  Default: 600000 (10 minutes). */
  missionStaleThresholdMs?: number;
  /** Maximum automatic retry attempts for a failed mission-linked task before
   *  its feature is marked as blocked for manual intervention.
   *  Default: 3. */
  missionMaxTaskRetries?: number;
  /** Interval in milliseconds between mission feature/task consistency checks.
   *  Set to 0 to disable periodic health checks.
   *  Default: 300000 (5 minutes). */
  missionHealthCheckIntervalMs?: number;
  /** Configurable agent role prompt templates and assignments.
   *  When set, allows per-project customization of system prompts
   *  for different agent roles (executor, triage, reviewer, merger). */
  agentPrompts?: AgentPromptsConfig;
  /** Prompt segment overrides for fine-grained customization of agent prompts.
   *  Each key maps to a customizable prompt segment (e.g., "executor-welcome",
   *  "triage-context"). When a key is present with a non-empty value, that
   *  override replaces the default prompt segment. Missing or empty values
   *  fall back to the default prompt content. Null values delete the key.
   *
   *  This is separate from `agentPrompts` which controls full role templates.
   *  `promptOverrides` allows surgical customization of specific prompt segments
   *  without replacing entire role prompts.
   *
   *  Supported keys: "executor-welcome", "executor-guardrails", "executor-spawning",
   *  "executor-completion", "triage-welcome", "triage-context", "reviewer-verdict",
   *  "merger-conflicts". */
  promptOverrides?: Record<string, string | null>;
  /** Enable/disable agent self-reflection workflows. Default: false. */
  reflectionEnabled?: boolean;
  /** How often periodic reflections occur in milliseconds. Default: 3_600_000 (1 hour). */
  reflectionIntervalMs?: number;
  /** When true, automatically trigger reflection after task completion. Default: true. */
  reflectionAfterTask?: boolean;
  /** Policy for agent-to-user review handoff. When enabled, agents can hand off
   *  tasks to users for human review via steering comments.
   *  - "disabled": No handoff detection (default)
   *  - "comment-triggered": Detect handoff phrases in agent steering comments
   *  - "always": Always handoff after completion (not implemented, reserved for future)
   */
  reviewHandoffPolicy?: "disabled" | "comment-triggered" | "always";
  /** Quick Chat launcher placement. "floating" shows the draggable FAB, "footer" shows a footer button, "off" hides both. */
  quickChatButtonMode?: "floating" | "footer" | "off";
  /*
   * FNXC:Navigation 2026-07-17-00:00:
   * Ordered quick-action ids shown before the always-present mobile More tab. Only command-center,
   * tasks, agents, missions, chat, mailbox, and planning are eligible; unset falls back to the
   * default order, invalid/overflow-only ids (including more) are ignored, and omitted ids stay in More.
   */
  mobileNavPrimaryItems?: string[];
  /**
   * FNXC:ChatModal 2026-06-28-00:00:
   * Outside-click dismissal of Quick Chat is now user-configurable; default true preserves the prior always-on behavior from FN-7152.
   * When true (default), the Quick Chat floating window closes when the user clicks outside it. Set false to keep it open until explicitly closed.
   */
  quickChatCloseOnOutsideClick?: boolean;
  /** Legacy Quick Chat FAB toggle. Prefer quickChatButtonMode for new callers. */
  showQuickChatFAB?: boolean;
  /**
   * FNXC:ChatModal 2026-07-01-00:00:
   * Task planner sessions (`task-planner:<taskId>`) are hidden from the common Chat feed by default to keep task-detail planning conversations out of Direct chat clutter. Operators can opt back into the previous shared-feed behavior with this project setting.
   */
  showTaskChatsInCommonFeed?: boolean;
  /** Number of days of chat inactivity before old chat sessions/rooms are auto-cleaned.
   *  Allowed values: 0 (off, default), 7, 14, 30, 60, 90. Uses updatedAt inactivity age. */
  chatAutoCleanupDays?: number;
  /** Number of days of inactivity before old inbox/outbox messages are auto-pruned.
   *  Allowed values: 0 (off, default) or one of 7 | 14 | 30 | 60 | 90. Uses messages.updatedAt inactivity age. */
  mailAutoCleanupDays?: number;
  /** Number of days to retain append-only operational-log rows (activityLog,
   *  runAuditEvents, agentHeartbeats, terminal agentRuns by `endedAt`, and
   *  agentConfigRevisions by `createdAt`) before periodic maintenance prunes
   *  them. In-flight agentRuns (`endedAt IS NULL`) and the most-recent config
   *  revision per agent are always preserved. Agent logs are now stored in
   *  per-task JSONL files — see agentLogFileRetentionDays. Default: 30. Set 0
   *  to disable pruning. */
  operationalLogRetentionDays?: number;
  /*
  FNXC:PostgresMigrationBanner 2026-07-12:
  Written by the startup factory after the first-boot SQLite → PostgreSQL
  auto-migration succeeds, so the dashboard can show a one-time banner telling
  the operator their data was migrated and the original SQLite files were
  kept as backups. Dismissing the banner sets dismissed: true (the notice is
  retained for support/audit rather than deleted). Inbox delivery has a
  separate top-level marker so writing it cannot revert a concurrent banner
  dismissal. null/absent = no migration happened on this project.
  */
  sqliteMigrationNotice?: {
    /** ISO timestamp of the auto-migration. */
    migratedAt: string;
    /** Total rows imported across all tables. */
    migratedRows: number;
    /** Number of tables imported. */
    tables: number;
    /** Absolute paths of the original SQLite files kept as backups. */
    sqliteBackups: string[];
    /** True once the operator dismissed the banner. */
    dismissed?: boolean;
  } | null;
  /** ISO timestamp after the one-time post-migration system inbox message was durably inserted. */
  postgresMigrationInboxMessageSentAt?: string;
  /** Number of days to retain per-task agent-log JSONL files for soft-deleted
   *  and archived tasks. Only affects tasks that are no longer active. Entries
   *  older than this window are removed from the JSONL file during periodic
   *  maintenance. Default: 0 (disabled). Set to a positive integer (e.g. 90)
   *  to enable pruning. */
  agentLogFileRetentionDays?: number;
  /** Number of most-recent chat-room messages kept verbatim in the responder transcript.
   *  Older messages are compacted into a summary block. Default: 12. */
  chatRoomRecentVerbatimMessages?: number;
  /** Upper bound on messages fetched from the room store for compaction consideration.
   *  Default: 80. */
  chatRoomCompactionFetchLimit?: number;
  /** Hard cap on the synthesized "Earlier room context" summary block.
   *  Default: 1500. */
  chatRoomSummaryMaxChars?: number;
  /**
   * FNXC:Workspace 2026-06-24-16:00:
   * When true, the project root is treated as a workspace-mode parent directory containing
   * multiple git sub-repos (recorded in .fusion/workspace.json), not a single git repo.
   * ensureGitRepositoryForProjectPath skips `git init` for workspace roots, and the executor
   * runs tasks per-sub-repo instead of at the root. Auto-detected at registration time when
   * sub-repos are found, with an interactive confirmation prompt. Can be toggled per-project
   * via the dashboard Settings modal or PUT /settings.
   */
  workspaceMode?: boolean;
}

/**
 * Merged settings view combining global and project scopes.
 *
 * This is the primary type returned by `TaskStore.getSettings()` and used
 * by most consumers. Project settings override global settings.
 *
 * Also includes computed/server-only fields like `prAuthAvailable`
 * that are injected at read time by the API layer.
 */
export interface Settings extends GlobalSettings, ProjectSettings {
  /** Whether PR authentication is currently available (read-only, set by server).
   *  True when authenticated gh CLI access is available or token fallback exists. */
  prAuthAvailable?: boolean;
  /** Use the lean fast-path planning prompt variant instead of the full triage spec prompt. */
  leanPlanning?: boolean;
  /** Auto-approve generated specs and skip the independent spec reviewer. */
  autoApproveSpec?: boolean;
  /** Index signature for dynamic settings access */
  [key: string]: unknown;
}

export {
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_PROJECT_SETTINGS,
  DEFAULT_SETTINGS,
  GLOBAL_SETTINGS_KEYS,
  PROJECT_SETTINGS_KEYS,
  isGlobalOnlySettingsKey,
  isGlobalSettingsKey,
  isProjectSettingsKey,
  isMergeRequestContractShadowEnabled,
  resolvePersistAgentThinkingLog,
  sanitizeCliAgentSettings,
  sanitizeCliAgentsSettings,
  sanitizeMcpServers,
  CLI_AGENT_ADAPTER_IDS,
  CLI_AGENT_AUTONOMY_MODES,
} from "../../config/settings-schema.js";

