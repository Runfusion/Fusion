/**
 * Plugin System Type Definitions for Fusion
 *
 * This module defines all types for the Fusion plugin system, including:
 * - PluginManifest: metadata and capability declaration
 * - Plugin hooks: lifecycle callbacks
 * - Plugin tools: AI agent tool definitions
 * - Plugin routes: custom dashboard API routes
 * - PluginContext: API surface available to plugins at runtime
 * - FusionPlugin: loaded plugin instance
 * - PluginInstallation: persisted plugin record
 */

import type { Database } from "./db.js";
import type { TaskStore } from "./store.js";
import type { Task, WorkflowStepMode, WorkflowStepToolMode } from "./types.js";

const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const PROMPT_CONTRIBUTION_SURFACES = ["executor-system", "executor-task", "triage", "reviewer", "heartbeat"] as const;
const SETUP_CHANNELS = ["stable", "beta", "nightly"] as const;

// ── Plugin Manifest ───────────────────────────────────────────────────

/**
 * Metadata and capability declaration for a plugin.
 */
export interface PluginManifest {
  /** Unique identifier (e.g., "fusion-plugin-slack") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semver version string */
  version: string;
  /** Short description */
  description?: string;
  /** Author name or org */
  author?: string;
  /** URL to plugin docs/repo */
  homepage?: string;
  /** Minimum Fusion version required */
  fusionVersion?: string;
  /** IDs of other plugins this depends on */
  dependencies?: string[];
  /** Settings schema for validation */
  settingsSchema?: Record<string, PluginSettingSchema>;
  /** Optional agent runtime metadata for discovery (runtime factory is in FusionPlugin.runtime) */
  runtime?: PluginRuntimeManifestMetadata;
  /** Optional skill metadata used for discovery UIs. */
  skills?: Array<{ skillId: string; name: string }>;
  /** Optional workflow step metadata used for discovery UIs. */
  workflowSteps?: Array<{ stepId: string; name: string }>;
  /** Prompt surfaces this plugin contributes to. */
  promptSurfaces?: PluginPromptSurface[];
  /** Setup metadata for plugin-managed binaries/runtimes. */
  setup?: PluginSetupManifest;
}

// ── Plugin Setting Schema ──────────────────────────────────────────────

export type PluginSettingType = "string" | "number" | "boolean" | "enum" | "password" | "array";

/**
 * Schema for a single plugin setting.
 */
export interface PluginSettingSchema {
  type: PluginSettingType;
  /** Human-readable label for UI */
  label?: string;
  description?: string;
  defaultValue?: unknown;
  required?: boolean;
  /** Only when type is "enum" */
  enumValues?: string[];
  /** Only when type is "string" - renders as textarea when true */
  multiline?: boolean;
  /** Optional UI grouping label used by settings forms */
  group?: string;
  /** Only when type is "array" - type of items in the array */
  itemType?: "string" | "number";
}

// ── Plugin Hooks ─────────────────────────────────────────────────────

/**
 * Options for creating an AI session from plugin runtime context.
 * This is a focused subset of engine agent options exposed to plugin authors.
 */
export interface CreateAiSessionOptions {
  /** Working directory for the agent session */
  cwd: string;
  /** System prompt for the agent */
  systemPrompt: string;
  /** Tool mode: "coding" for full tools, "readonly" for read-only */
  tools?: "coding" | "readonly";
  /** Default model provider (e.g., "anthropic") */
  defaultProvider?: string;
  /** Default model ID within the provider */
  defaultModelId?: string;
}

/**
 * Result returned from creating an AI session through PluginContext.
 */
export interface AiSessionResult {
  /** The underlying agent session — plugins call .prompt() on it */
  session: {
    prompt(text: string): Promise<void>;
    state: {
      messages: Array<{
        role: string;
        content?: unknown;
      }>;
    };
  };
  /** Path to persisted session file, if any */
  sessionFile?: string;
}

/**
 * Engine-injected factory for plugin AI sessions.
 */
export type CreateAiSessionFactory = (options: CreateAiSessionOptions) => Promise<AiSessionResult>;

/**
 * Context object passed to plugins at runtime.
 * Contains task store access, settings, logging, and event emission.
 */
export interface PluginContext {
  pluginId: string;
  /** Read-only access to task data */
  taskStore: TaskStore;
  /** Plugin's own settings */
  settings: Record<string, unknown>;
  /** Structured logger */
  logger: PluginLogger;
  /** Emit custom events */
  emitEvent: (event: string, data: unknown) => void;
  /** Engine-injected AI session factory (undefined when engine is not loaded) */
  createAiSession?: CreateAiSessionFactory;
  /** Optional host capability to resolve a project-scoped TaskStore by projectId. */
  resolveProjectTaskStore?: (projectId: string) => Promise<TaskStore>;
}

/**
 * Structured logger interface for plugins.
 */
export interface PluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/** Lifecycle hook: called when plugin is loaded */
export type PluginOnLoad = (ctx: PluginContext) => Promise<void> | void;
/** Lifecycle hook: called when plugin is unloaded */
export type PluginOnUnload = (ctx: PluginContext) => Promise<void> | void;
/** Lifecycle hook: called during database schema initialization */
export type PluginOnSchemaInit = (db: Database) => Promise<void> | void;
/** Lifecycle hook: called when a task is created */
export type PluginOnTaskCreated = (task: Task, ctx: PluginContext) => Promise<void> | void;
/** Lifecycle hook: called when a task moves between columns */
export type PluginOnTaskMoved = (task: Task, fromColumn: string, toColumn: string, ctx: PluginContext) => Promise<void> | void;
/** Lifecycle hook: called when a task is completed */
export type PluginOnTaskCompleted = (task: Task, ctx: PluginContext) => Promise<void> | void;
/** Lifecycle hook: called when an error occurs */
export type PluginOnError = (error: Error, ctx: PluginContext) => Promise<void> | void;
/** Lifecycle hook: called when an agent session begins running for a task. */
export type PluginOnAgentRunStart = (taskId: string, ctx: PluginContext) => Promise<void> | void;
/** Lifecycle hook: called when an agent session ends for a task. */
export type PluginOnAgentRunEnd = (taskId: string, ctx: PluginContext) => Promise<void> | void;

// ── Plugin Tools ─────────────────────────────────────────────────────

/**
 * Tool registration for AI agents.
 * Tools are prefixed with "plugin_" at runtime.
 */
export interface PluginToolDefinition {
  /** Tool name (prefixed with "plugin_" at runtime) */
  name: string;
  /** Description for the AI agent */
  description: string;
  /** TypeBox-style parameter schema */
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>, ctx: PluginContext) => Promise<PluginToolResult>;
}

/**
 * Result returned by a plugin tool execution.
 */
export interface PluginToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
}

// ── Plugin Routes ────────────────────────────────────────────────────

export type PluginRouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Custom dashboard API route definition.
 */
export interface PluginRouteResponse {
  status: number;
  body?: unknown;
  /** Optional response headers to set on the outgoing HTTP response. */
  headers?: Record<string, string>;
  /** Optional explicit content type; when set, body is sent without JSON serialization. */
  contentType?: string;
}

export type PluginRouteResult = unknown | PluginRouteResponse;

export interface PluginRouteDefinition {
  method: PluginRouteMethod;
  /** Relative path under /api/plugins/:pluginId/ */
  path: string;
  handler: (req: unknown, ctx: PluginContext) => Promise<PluginRouteResult>;
  description?: string;
}

// ── Plugin UI Slots ─────────────────────────────────────────────────

/**
 * Host-defined dashboard UI surfaces that plugins can contribute to.
 * Existing generic surfaces remain supported for backward compatibility.
 */
export type PluginUiSurface =
  | "header-action"
  | "task-detail-tab"
  | "task-card-badge"
  | "board-column-footer"
  | "settings-section"
  | "settings-provider-card"
  | "settings-integration-card"
  | "onboarding-provider-card"
  | "onboarding-recommendation-card"
  | "onboarding-setup-help"
  | "post-onboarding-recommendation";

/**
 * UI slot definition for plugin-provided dashboard components.
 * Each slot represents a host-owned mount point where a plugin can render UI.
 */
export interface PluginUiSlotDefinition {
  /**
   * Unique slot identifier. Should match one of the known host surfaces above,
   * but string is retained for compatibility with legacy plugins.
   */
  slotId: PluginUiSurface | string;
  /** Human-readable label for the UI slot */
  label: string;
  /** Optional icon name (lucide-react icon name or custom icon identifier) */
  icon?: string;
  /**
   * Path to the JS module that exports the component.
   * Path is relative to the plugin's root directory.
   */
  componentPath: string;
  /** Optional explicit surface metadata (defaults to slotId). */
  surface?: PluginUiSurface;
  /** Optional deterministic render order; lower values render first. */
  order?: number;
  /** Optional host placement hint for the surface. */
  placement?: "before-default" | "after-default" | "replace-default";
}

/**
 * Top-level dashboard view definition for plugin-provided navigation destinations.
 * This is separate from embedded uiSlots and is rendered via host-managed registry.
 */
export type PluginUiContributionSurface =
  | "settings-provider-card"
  | "settings-config-section"
  | "onboarding-provider-card"
  | "onboarding-setup-help"
  | "onboarding-provider-recommendation"
  | "post-onboarding-recommendation";

export interface PluginUiContributionWhen {
  providerIds?: string[];
  runtimeIds?: string[];
  authState?: "required" | "authenticated" | "unauthenticated";
  onboardingState?: "required" | "in-progress" | "complete";
}

export interface PluginUiActionDescriptor {
  kind:
    | "open-settings-section"
    | "open-onboarding"
    | "refresh-auth-status"
    | "save-api-key"
    | "toggle-cli-provider"
    | "open-external-url";
  target?: string;
  label?: string;
}

interface PluginUiContributionBase {
  surface: PluginUiContributionSurface;
  contributionId: string;
  title: string;
  description?: string;
  order?: number;
  when?: PluginUiContributionWhen;
}

interface PluginUiProviderCardBase extends PluginUiContributionBase {
  providerId: string;
  providerType: "cli" | "oauth" | "api_key" | "custom";
  settingsSectionId?: string;
  statusSource?: { kind: string; providerId: string; route?: string };
  actions?: PluginUiActionDescriptor[];
}

export interface SettingsProviderCardContribution extends PluginUiProviderCardBase {
  surface: "settings-provider-card";
}

export interface SettingsConfigSectionContribution extends PluginUiContributionBase {
  surface: "settings-config-section";
  sectionId: string;
  pluginSettingKeys: string[];
  layout?: "section" | "card" | "disclosure";
}

export interface OnboardingProviderCardContribution extends PluginUiProviderCardBase {
  surface: "onboarding-provider-card";
  quickStart?: string;
  recommended?: boolean;
}

export interface OnboardingSetupHelpContribution extends PluginUiContributionBase {
  surface: "onboarding-setup-help";
  providerId?: string;
  body: string;
  bodyFormat: "text" | "markdown";
  actions?: PluginUiActionDescriptor[];
}

export interface OnboardingProviderRecommendationContribution extends PluginUiContributionBase {
  surface: "onboarding-provider-recommendation";
  providerId: string;
  reason: string;
  actions?: PluginUiActionDescriptor[];
  priority?: number;
}

export interface PostOnboardingRecommendationContribution extends PluginUiContributionBase {
  surface: "post-onboarding-recommendation";
  description: string;
  actions?: PluginUiActionDescriptor[];
  priority?: number;
  dismissible?: boolean;
}

export type PluginUiContributionDefinition =
  | SettingsProviderCardContribution
  | SettingsConfigSectionContribution
  | OnboardingProviderCardContribution
  | OnboardingSetupHelpContribution
  | OnboardingProviderRecommendationContribution
  | PostOnboardingRecommendationContribution;

type LegacyPluginUiContributionSurface =
  | "settings-integration-card"
  | "onboarding-recommendation-card";

export type PluginUiContributionInputDefinition = Omit<PluginUiContributionDefinition, "surface"> & {
  surface: PluginUiContributionSurface | LegacyPluginUiContributionSurface;
};

export function normalizePluginUiContributionSurface(
  surface: PluginUiContributionSurface | LegacyPluginUiContributionSurface,
): PluginUiContributionSurface {
  if (surface === "settings-integration-card") {
    return "settings-config-section";
  }
  if (surface === "onboarding-recommendation-card") {
    return "onboarding-provider-recommendation";
  }
  return surface;
}

export function normalizePluginUiContributionDefinition(
  contribution: PluginUiContributionInputDefinition,
): PluginUiContributionDefinition {
  return {
    ...contribution,
    surface: normalizePluginUiContributionSurface(contribution.surface),
  } as PluginUiContributionDefinition;
}

export interface PluginDashboardViewDefinition {
  /** Unique view identifier within a plugin namespace. */
  viewId: string;
  /** Human-readable label shown in dashboard navigation. */
  label: string;
  /**
   * Path to module exporting the dashboard view component.
   * Stored for authoring symmetry/future expansion; host currently resolves via static registry.
   */
  componentPath: string;
  /** Optional icon name (lucide-react icon name or custom icon identifier). */
  icon?: string;
  /** Optional sort order for nav presentation. Lower numbers appear first. */
  order?: number;
  /** Preferred navigation placement for this top-level view. */
  placement?: "primary" | "overflow" | "more";
  /** Optional short description used by navigation/help UI. */
  description?: string;
}

// ── Plugin Runtimes ─────────────────────────────────────────────────

/**
 * Runtime manifest metadata for plugin-provided agent runtimes.
 * Declares the capabilities and requirements of a runtime.
 */
export interface PluginRuntimeManifestMetadata {
  /** Unique runtime identifier within the plugin (e.g., "code-interpreter", "web-search") */
  runtimeId: string;
  /** Human-readable name for the runtime */
  name: string;
  /** Short description of what the runtime provides */
  description?: string;
  /** Semantic version of the runtime implementation */
  version?: string;
}

/**
 * Factory function for creating a runtime instance.
 * The factory receives plugin context and returns the runtime handle.
 *
 * @param ctx - Plugin context with access to task store, settings, and logging
 * @returns The runtime instance, or void/null if initialization fails
 */
export type PluginRuntimeFactory = (
  ctx: PluginContext,
) => Promise<unknown> | unknown;

/**
 * Runtime registration combining manifest metadata with the factory function.
 * Plugins declare runtimes by providing both metadata (for discovery) and
 * a factory function (for instantiation).
 */
export interface PluginRuntimeRegistration {
  /** Runtime metadata for discovery and display */
  metadata: PluginRuntimeManifestMetadata;
  /** Factory function that creates the runtime instance */
  factory: PluginRuntimeFactory;
}

export type CliProviderType = "cli" | "oauth" | "api_key" | "custom";

export interface CliProviderActionMetadata {
  actionId: string;
  label: string;
  actionType: "enable" | "disable" | "test" | "open-url" | "custom";
  route?: string;
  method?: "GET" | "POST";
}

export interface CliProviderProbeResult {
  available: boolean;
  authenticated?: boolean;
  binaryPath?: string;
  binaryName?: string;
  version?: string;
  reason?: string;
  hostReady?: boolean;
  pluginReady?: boolean;
}

export interface CliProviderModelDiscoveryResult {
  models: Array<{ id: string; label?: string; metadata?: Record<string, unknown> }>;
  source: string;
  fallbackUsed: boolean;
  reason?: string;
}

export interface CliProviderRuntimeRegistration {
  runtimeId?: string;
  createAdapter?: PluginRuntimeFactory;
}

export interface CliProviderContribution {
  providerId: string;
  displayName: string;
  binaryName: string;
  providerType: CliProviderType;
  statusRoute: string;
  authRoute: string;
  onboarding?: {
    title?: string;
    description?: string;
  };
  settings?: {
    sectionId?: string;
    pluginSettingKeys?: string[];
  };
  actions?: CliProviderActionMetadata[];
  probe?: (ctx: PluginContext) => Promise<CliProviderProbeResult>;
  discoverModels?: (ctx: PluginContext) => Promise<CliProviderModelDiscoveryResult>;
  runtime?: CliProviderRuntimeRegistration;
}

// ── Plugin Contribution Types ───────────────────────────────────────

/**
 * Plugin-contributed skill surfaced in agent sessions via the skill-selection system.
 */
export interface PluginSkillContribution {
  /** Unique skill identifier within the plugin namespace (kebab-case). */
  skillId: string;
  /** Human-readable skill name. */
  name: string;
  /** What the skill does. */
  description: string;
  /** Paths (relative to plugin root) to SKILL.md or equivalent definitions. */
  skillFiles: string[];
  /** Whether this skill is enabled by default. Defaults to true. */
  enabled?: boolean;
  /** Optional keyword/pattern hints used by skill matching. */
  triggerPatterns?: string[];
}

/**
 * Workflow step template contributed by a plugin. These templates are
 * materialized into concrete WorkflowStep instances when selected for a task.
 */
export interface PluginWorkflowStepContribution {
  /** Unique step identifier within the plugin namespace (kebab-case). */
  stepId: string;
  /** Human-readable step name. */
  name: string;
  /** Short description for UI. */
  description: string;
  /** Execution mode, aligned with WorkflowStepMode. */
  mode: WorkflowStepMode;
  /** Task lifecycle phase where this step runs. Defaults to "pre-merge". */
  phase?: "pre-merge" | "post-merge";
  /** Prompt text used when mode is "prompt". */
  prompt?: string;
  /** Script name used when mode is "script". */
  scriptName?: string;
  /** Tool access level, aligned with WorkflowStepToolMode. */
  toolMode?: WorkflowStepToolMode;
  /** Whether this step is enabled by default. Defaults to true. */
  enabled?: boolean;
  /** Whether this step is auto-selected on new tasks. */
  defaultOn?: boolean;
  /** Optional model provider override for prompt steps. */
  modelProvider?: string;
  /** Optional model ID override for prompt steps. */
  modelId?: string;
}

/**
 * Prompt injection surfaces for plugin-contributed instructions.
 * - executor-system: Appended to executor agent system prompt
 * - executor-task: Injected into per-task execution context
 * - triage: Appended to triage/planning prompts
 * - reviewer: Appended to reviewer/validation prompts
 * - heartbeat: Appended to heartbeat agent system prompts
 */
export type PluginPromptSurface = (typeof PROMPT_CONTRIBUTION_SURFACES)[number];

export interface PluginPromptContribution {
  /** Which prompt surface this contribution targets. */
  surface: PluginPromptSurface;
  /** Prompt text to inject. */
  content: string;
  /** Position relative to existing prompt content. Defaults to "append". */
  position?: "append" | "prepend";
  /** Human-readable applicability description, reserved for future filtering. */
  condition?: string;
}

export interface PluginPromptContributions {
  contributions: PluginPromptContribution[];
  /** Whether contributions are active by default. Defaults to false for safety. */
  enabledByDefault?: boolean;
}

export interface ExecutorRuntimeTaskContext {
  taskId: string;
  worktreePath: string;
  rootDir: string;
  branch?: string;
}

export interface ExecutorRuntimeEnvContribution {
  pathPrepend?: string[];
  env?: Record<string, string>;
  description?: string;
}

export type PluginExecutorRuntimeEnvHook = (
  taskCtx: ExecutorRuntimeTaskContext,
  ctx: PluginContext,
) => Promise<ExecutorRuntimeEnvContribution> | ExecutorRuntimeEnvContribution;

export type PluginSetupStatus = "not-installed" | "installing" | "installed" | "error";

export interface PluginSetupCheckResult {
  status: PluginSetupStatus;
  /** Installed version if available. */
  version?: string;
  /** Installed binary path if detected. */
  binaryPath?: string;
  /** Error details when status is "error". */
  error?: string;
}

/**
 * Plugin-managed setup hooks. All process execution in hooks MUST be async
 * (never execSync) to avoid blocking the engine event loop.
 */
export interface PluginSetupHooks {
  /** Check whether required binaries/runtimes are installed and ready. */
  checkSetup: (ctx: PluginContext) => Promise<PluginSetupCheckResult>;
  /** Install required binaries/runtimes. */
  install?: (ctx: PluginContext) => Promise<void>;
  /** Uninstall managed binaries/runtimes. */
  uninstall?: (ctx: PluginContext) => Promise<void>;
}

export interface PluginSetupManifest {
  /** Binary/runtime name being managed (e.g. "agent-browser"). */
  binaryName: string;
  /** What this binary/runtime provides. */
  description: string;
  /** Expected or pinned version. */
  version?: string;
  /** Installation channel. */
  channel?: (typeof SETUP_CHANNELS)[number];
  /** Timeout for setup/install commands. Defaults to 120000. */
  defaultTimeoutMs?: number;
}

// ── Fusion Plugin ────────────────────────────────────────────────────

export type PluginState = "installed" | "started" | "stopped" | "error";

export interface PluginSecurityFinding {
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  file: string;
  excerpt: string;
  reason: string;
}

export interface PluginSecurityScanResult {
  verdict: "clean" | "warning" | "blocked" | "error" | "unavailable";
  summary: string;
  findings: PluginSecurityFinding[];
  scannedAt: string;
  scannedFiles: string[];
  scanDurationMs?: number;
  modelProvider?: string;
  modelId?: string;
}

/**
 * Loaded plugin instance with all hooks, tools, routes, and runtimes.
 */
export interface FusionPlugin {
  manifest: PluginManifest;
  state: PluginState;
  hooks: {
    onLoad?: PluginOnLoad;
    onUnload?: PluginOnUnload;
    onTaskCreated?: PluginOnTaskCreated;
    onTaskMoved?: PluginOnTaskMoved;
    onTaskCompleted?: PluginOnTaskCompleted;
    onError?: PluginOnError;
    onSchemaInit?: PluginOnSchemaInit;
    onAgentRunStart?: PluginOnAgentRunStart;
    onAgentRunEnd?: PluginOnAgentRunEnd;
  };
  tools?: PluginToolDefinition[];
  routes?: PluginRouteDefinition[];
  uiSlots?: PluginUiSlotDefinition[];
  uiContributions?: PluginUiContributionInputDefinition[];
  /** Plugin-contributed top-level dashboard views. */
  dashboardViews?: PluginDashboardViewDefinition[];
  /** Agent runtime registration for providing custom runtime implementations */
  runtime?: PluginRuntimeRegistration;
  /** CLI-backed provider metadata and integration hooks. */
  cliProviders?: CliProviderContribution[];
  /** Plugin-contributed skills surfaced by the skill resolver. */
  skills?: PluginSkillContribution[];
  /** Plugin-contributed workflow step templates. */
  workflowSteps?: PluginWorkflowStepContribution[];
  /** Plugin-contributed prompt injections. */
  promptContributions?: PluginPromptContributions;
  /** Plugin-managed setup metadata and lifecycle hooks. */
  setup?: {
    manifest: PluginSetupManifest;
    hooks: PluginSetupHooks;
  };
  /** Plugin-contributed executor runtime env for task-scoped subprocesses. */
  executorRuntimeEnv?: PluginExecutorRuntimeEnvHook;
}

// ── Plugin Installation ───────────────────────────────────────────────

/**
 * Persisted plugin record in the store.
 */
export interface PluginInstallation {
  /** Same as manifest.id */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  /** Absolute path to plugin directory or npm package */
  path: string;
  enabled: boolean;
  state: PluginState;
  settings: Record<string, unknown>;
  settingsSchema?: Record<string, PluginSettingSchema>;
  /** Last error message (if state is "error") */
  error?: string;
  dependencies?: string[];
  aiScanOnLoad?: boolean;
  lastSecurityScan?: PluginSecurityScanResult;
  createdAt: string;
  updatedAt: string;
}

// ── Manifest Validation ──────────────────────────────────────────────

/**
 * Validate a plugin manifest.
 *
 * @returns Object with valid=true and empty errors array on success,
 *          or valid=false with descriptive error messages on failure.
 */
export function validatePluginManifest(manifest: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (manifest === null || manifest === undefined) {
    return { valid: false, errors: ["Manifest is required"] };
  }

  if (typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, errors: ["Manifest must be an object"] };
  }

  const m = manifest as Record<string, unknown>;

  // Required fields
  if (!m.id || typeof m.id !== "string" || m.id.trim() === "") {
    errors.push("id is required and must be a non-empty string");
  } else if (!SLUG_PATTERN.test(m.id)) {
    errors.push("id must be a valid slug (lowercase, alphanumeric, hyphens only, cannot start or end with hyphen)");
  }

  if (!m.name || typeof m.name !== "string" || m.name.trim() === "") {
    errors.push("name is required and must be a non-empty string");
  }

  if (!m.version || typeof m.version !== "string" || m.version.trim() === "") {
    errors.push("version is required and must be a non-empty string");
  } else if (!/^\d+\.\d+\.\d+$/.test(m.version)) {
    errors.push("version must be a valid semver string (e.g., 1.0.0)");
  }

  // Optional: dependencies
  if (m.dependencies !== undefined) {
    if (!Array.isArray(m.dependencies)) {
      errors.push("dependencies must be an array");
    } else {
      const invalidDeps = m.dependencies.filter(
        (d) => typeof d !== "string" || d.trim() === "",
      );
      if (invalidDeps.length > 0) {
        errors.push("All dependencies must be non-empty strings");
      }
    }
  }

  // Optional: settingsSchema
  if (m.settingsSchema !== undefined) {
    if (typeof m.settingsSchema !== "object" || m.settingsSchema === null) {
      errors.push("settingsSchema must be an object");
    } else {
      const settingsSchema = m.settingsSchema as Record<string, unknown>;
      for (const [key, schema] of Object.entries(settingsSchema)) {
        if (!schema || typeof schema !== "object") {
          errors.push(`settingsSchema.${key} must be an object`);
          continue;
        }
        const setting = schema as Record<string, unknown>;
        if (!setting.type || !["string", "number", "boolean", "enum", "password", "array"].includes(setting.type as string)) {
          errors.push(`settingsSchema.${key}.type must be one of: string, number, boolean, enum, password, array`);
        }
        if (setting.type === "enum" && (!Array.isArray(setting.enumValues) || setting.enumValues.length === 0)) {
          errors.push(`settingsSchema.${key}.enumValues is required and must be a non-empty array when type is enum`);
        }
        if (setting.type === "array" && (!setting.itemType || !["string", "number"].includes(setting.itemType as string))) {
          errors.push(`settingsSchema.${key}.itemType is required and must be "string" or "number" when type is array`);
        }
      }
    }
  }

  // Optional: runtime manifest metadata validation
  if (m.runtime !== undefined) {
    if (typeof m.runtime !== "object" || m.runtime === null) {
      errors.push("runtime must be an object");
    } else {
      const runtime = m.runtime as Record<string, unknown>;

      // runtimeId is required
      if (!runtime.runtimeId || typeof runtime.runtimeId !== "string" || runtime.runtimeId.trim() === "") {
        errors.push("runtime.runtimeId is required and must be a non-empty string");
      } else if (!SLUG_PATTERN.test(runtime.runtimeId as string)) {
        errors.push("runtime.runtimeId must be a valid slug (lowercase, alphanumeric, hyphens only, cannot start or end with hyphen)");
      }

      // name is required
      if (!runtime.name || typeof runtime.name !== "string" || runtime.name.trim() === "") {
        errors.push("runtime.name is required and must be a non-empty string");
      }

      // version is optional but must be valid semver if provided
      if (runtime.version !== undefined) {
        if (typeof runtime.version !== "string") {
          errors.push("runtime.version must be a string");
        } else if (!/^\d+\.\d+\.\d+$/.test(runtime.version)) {
          errors.push("runtime.version must be a valid semver string (e.g., 1.0.0)");
        }
      }
    }
  }

  // Optional: plugin skill discovery metadata
  if (m.skills !== undefined) {
    if (!Array.isArray(m.skills)) {
      errors.push("skills must be an array");
    } else {
      for (const [index, skill] of m.skills.entries()) {
        if (!skill || typeof skill !== "object") {
          errors.push(`skills[${index}] must be an object`);
          continue;
        }
        const skillMeta = skill as Record<string, unknown>;
        if (!skillMeta.skillId || typeof skillMeta.skillId !== "string" || skillMeta.skillId.trim() === "") {
          errors.push(`skills[${index}].skillId is required and must be a non-empty string`);
        } else if (!SLUG_PATTERN.test(skillMeta.skillId)) {
          errors.push(`skills[${index}].skillId must be a valid slug (lowercase, alphanumeric, hyphens only, cannot start or end with hyphen)`);
        }
        if (!skillMeta.name || typeof skillMeta.name !== "string" || skillMeta.name.trim() === "") {
          errors.push(`skills[${index}].name is required and must be a non-empty string`);
        }
      }
    }
  }

  // Optional: plugin workflow step discovery metadata
  if (m.workflowSteps !== undefined) {
    if (!Array.isArray(m.workflowSteps)) {
      errors.push("workflowSteps must be an array");
    } else {
      for (const [index, step] of m.workflowSteps.entries()) {
        if (!step || typeof step !== "object") {
          errors.push(`workflowSteps[${index}] must be an object`);
          continue;
        }
        const stepMeta = step as Record<string, unknown>;
        if (!stepMeta.stepId || typeof stepMeta.stepId !== "string" || stepMeta.stepId.trim() === "") {
          errors.push(`workflowSteps[${index}].stepId is required and must be a non-empty string`);
        } else if (!SLUG_PATTERN.test(stepMeta.stepId)) {
          errors.push(`workflowSteps[${index}].stepId must be a valid slug (lowercase, alphanumeric, hyphens only, cannot start or end with hyphen)`);
        }
        if (!stepMeta.name || typeof stepMeta.name !== "string" || stepMeta.name.trim() === "") {
          errors.push(`workflowSteps[${index}].name is required and must be a non-empty string`);
        }
        if (stepMeta.mode !== undefined && (typeof stepMeta.mode !== "string" || !["prompt", "script"].includes(stepMeta.mode))) {
          errors.push(`workflowSteps[${index}].mode must be one of: prompt, script`);
        }
      }
    }
  }

  // Optional: prompt surface metadata
  if (m.promptSurfaces !== undefined) {
    if (!Array.isArray(m.promptSurfaces)) {
      errors.push("promptSurfaces must be an array");
    } else {
      for (const [index, surface] of m.promptSurfaces.entries()) {
        if (typeof surface !== "string" || !PROMPT_CONTRIBUTION_SURFACES.includes(surface as PluginPromptSurface)) {
          errors.push(`promptSurfaces[${index}] must be one of: ${PROMPT_CONTRIBUTION_SURFACES.join(", ")}`);
        }
      }
    }
  }

  // Optional: top-level dashboard view metadata
  if (m.dashboardViews !== undefined) {
    if (!Array.isArray(m.dashboardViews)) {
      errors.push("dashboardViews must be an array");
    } else {
      for (const [index, view] of m.dashboardViews.entries()) {
        if (!view || typeof view !== "object") {
          errors.push(`dashboardViews[${index}] must be an object`);
          continue;
        }

        const dashboardView = view as Record<string, unknown>;

        if (!dashboardView.viewId || typeof dashboardView.viewId !== "string" || dashboardView.viewId.trim() === "") {
          errors.push(`dashboardViews[${index}].viewId is required and must be a non-empty string`);
        } else if (!SLUG_PATTERN.test(dashboardView.viewId)) {
          errors.push(`dashboardViews[${index}].viewId must be a valid slug (lowercase, alphanumeric, hyphens only, cannot start or end with hyphen)`);
        }

        if (!dashboardView.label || typeof dashboardView.label !== "string" || dashboardView.label.trim() === "") {
          errors.push(`dashboardViews[${index}].label is required and must be a non-empty string`);
        }

        if (
          !dashboardView.componentPath
          || typeof dashboardView.componentPath !== "string"
          || dashboardView.componentPath.trim() === ""
        ) {
          errors.push(`dashboardViews[${index}].componentPath is required and must be a non-empty string`);
        }

        if (
          dashboardView.placement !== undefined
          && (typeof dashboardView.placement !== "string" || !["primary", "overflow", "more"].includes(dashboardView.placement))
        ) {
          errors.push(`dashboardViews[${index}].placement must be one of: primary, overflow, more`);
        }
      }
    }
  }

  // Optional: setup manifest metadata
  if (m.setup !== undefined) {
    if (typeof m.setup !== "object" || m.setup === null) {
      errors.push("setup must be an object");
    } else {
      const setup = m.setup as Record<string, unknown>;
      if (!setup.binaryName || typeof setup.binaryName !== "string" || setup.binaryName.trim() === "") {
        errors.push("setup.binaryName is required and must be a non-empty string");
      }
      if (!setup.description || typeof setup.description !== "string" || setup.description.trim() === "") {
        errors.push("setup.description is required and must be a non-empty string");
      }
      if (setup.channel !== undefined && (typeof setup.channel !== "string" || !SETUP_CHANNELS.includes(setup.channel as (typeof SETUP_CHANNELS)[number]))) {
        errors.push(`setup.channel must be one of: ${SETUP_CHANNELS.join(", ")}`);
      }
      if (setup.defaultTimeoutMs !== undefined && (typeof setup.defaultTimeoutMs !== "number" || !Number.isFinite(setup.defaultTimeoutMs) || setup.defaultTimeoutMs <= 0)) {
        errors.push("setup.defaultTimeoutMs must be a positive finite number");
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

