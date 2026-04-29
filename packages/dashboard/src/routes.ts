import { Router, type Request, type Response, type NextFunction } from "express";

// Extend Express Request to include rawBody property set by webhook middleware
declare module "express" {
  interface Request {
    rawBody?: Buffer;
  }
}
import multer from "multer";
import { resolve, sep, join, isAbsolute } from "node:path";
import * as nodeFs from "node:fs";
import os from "node:os";
import v8 from "node:v8";

import type { TaskStore, ScheduleType, ActivityEventType, ModelPreset, RoutineTriggerType } from "@fusion/core";
import {
  type Task,
  type PiExtensionEntry,
  type PiExtensionSettings,
  AutomationStore,
  MemoryBackendError,
  RoutineStore,
  discoverPiExtensions,
  getFusionAgentDir,
  getLegacyPiAgentDir,
  isWebhookTrigger,
  listAgentMemoryFiles,
  readAgentMemoryFile,
  resolvePlanningSettingsModel,
  resolveProjectDefaultModel,
  resolveTitleSummarizerSettingsModel,
  writeAgentMemoryFile,
} from "@fusion/core";
import type { ServerOptions } from "./server.js";
import { verifyWebhookSignature } from "./github-webhooks.js";
import { AiSessionStore, SESSION_CLEANUP_DEFAULT_MAX_AGE_MS } from "./ai-session-store.js";
import { getSession as getPlanningSession, cleanupSession as cleanupPlanningSession } from "./planning.js";
import { getSubtaskSession, cleanupSubtaskSession } from "./subtask-breakdown.js";
import { getMissionInterviewSession, cleanupMissionInterviewSession } from "./mission-interview.js";
import { getTargetInterviewSession, cleanupTargetInterviewSession } from "./milestone-slice-interview.js";
import { writeSSEEvent } from "./sse-buffer.js";
import {
  ApiError,
  badRequest,
  conflict,
  internalError,
  notFound,
  rateLimited,
  rethrowAsApiError,
  sendErrorResponse,
  unauthorized,
} from "./api-error.js";
import { resolvePluginManifest } from "./plugin-routes.js";
import { hermesRuntimeMetadata } from "@fusion-plugin-examples/hermes-runtime";
import { openclawRuntimeMetadata } from "@fusion-plugin-examples/openclaw-runtime";

// Bundled runtime metadata exposed in /api/plugins/runtimes even when the
// corresponding plugin has not been explicitly installed. Installed plugins
// override these entries by runtimeId.
const BUNDLED_PLUGIN_RUNTIMES: Array<{
  pluginId: string;
  runtimeId: string;
  name: string;
  description?: string;
  version: string;
}> = [
  {
    pluginId: "fusion-plugin-hermes-runtime",
    runtimeId: hermesRuntimeMetadata.runtimeId,
    name: hermesRuntimeMetadata.name,
    ...(hermesRuntimeMetadata.description ? { description: hermesRuntimeMetadata.description } : {}),
    version: hermesRuntimeMetadata.version ?? "0.0.0",
  },
  {
    pluginId: "fusion-plugin-openclaw-runtime",
    runtimeId: openclawRuntimeMetadata.runtimeId,
    name: openclawRuntimeMetadata.name,
    ...(openclawRuntimeMetadata.description ? { description: openclawRuntimeMetadata.description } : {}),
    version: openclawRuntimeMetadata.version ?? "0.0.0",
  },
  {
    pluginId: "fusion-plugin-paperclip-runtime",
    runtimeId: "paperclip",
    name: "Paperclip Runtime",
    description: "Drives a Paperclip agent via the wakeup + heartbeat-run REST API",
    version: "1.0.0",
  },
];
import { createSessionDiagnostics } from "./ai-session-diagnostics.js";
import { createApiRoutesContext } from "./routes/context.js";
import { registerTaskWorkflowRoutes } from "./routes/register-task-workflow-routes.js";
import { registerPlanningSubtaskRoutes } from "./routes/register-planning-subtask-routes.js";
import { registerChatRoutes } from "./routes/register-chat-routes.js";
import { registerSettingsMemoryRoutes } from "./routes/register-settings-memory-routes.js";
import { registerMessagingScriptRoutes } from "./routes/register-messaging-scripts.js";
import { registerGitGitHubRoutes } from "./routes/register-git-github.js";
import { registerFilesTerminalWorkspaceRoutes } from "./routes/register-files-terminal-workspaces.js";
import { registerAgentsProjectsNodesRoutes } from "./routes/register-agents-projects-nodes.js";
import { registerProjectRoutes } from "./routes/register-project-routes.js";
import { registerNodeRoutes } from "./routes/register-node-routes.js";
import { registerSettingsSyncRoutes } from "./routes/register-settings-sync-routes.js";
import { registerMeshRoutes } from "./routes/register-mesh-routes.js";
import { registerDiscoveryRoutes } from "./routes/register-discovery-routes.js";
import { registerSettingsSyncInboundRoutes } from "./routes/register-settings-sync-inbound-routes.js";
import { registerAgentCoreListCreateRoutes, registerAgentCoreRoutes } from "./routes/register-agent-core-routes.js";
import { registerAgentRuntimeRoutes } from "./routes/register-agent-runtime-routes.js";
import { registerAgentReflectionRatingRoutes } from "./routes/register-agent-reflection-rating-routes.js";
import { registerAgentImportExportRoutes, registerAgentGenerationRoutes } from "./routes/register-agent-import-export-generation-routes.js";
import { registerAgentSkillsRoutes } from "./routes/register-agent-skills-routes.js";
import { registerPluginsAutomationRoutes } from "./routes/register-plugins-automation.js";
import { registerProxyRoutes } from "./routes/register-proxy-routes.js";
import { registerModelRoutes } from "./routes/register-model-routes.js";
import { registerUsageRoutes } from "./routes/register-usage-routes.js";
import { registerAuthRoutes } from "./routes/register-auth-routes.js";
import { registerRuntimeProviderRoutes } from "./routes/register-runtime-provider-routes.js";
import { registerUpdateCheckRoutes } from "./routes/register-update-check-routes.js";
import { registerIntegratedRouters, registerIntegratedDevServerRouter } from "./routes/register-integrated-routers.js";
import { runGitCommand } from "./routes/resolve-diff-base.js";

const TASK_DETAIL_ACTIVITY_LOG_LIMIT = 500;

/**
 * Compatibility export surface:
 * `createApiRoutes`, `AuthStorageLike`, `ModelRegistryLike`,
 * `__resetBatchImportRateLimiter`, and `__setCreateFnAgentForRefine`
 * intentionally remain exported from this file for existing tests/importers.
 */
export { __resetBatchImportRateLimiter } from "./routes/register-git-github.js";

/**
 * Minimal interface matching pi-coding-agent's ModelRegistry API surface
 * used by the models route. Avoids a direct dependency on the pi-coding-agent package.
 */
export interface ModelRegistryLike {
  /** Reload models from disk to pick up changes. */
  refresh(): void;
  /** Get models that have auth configured. */
  getAvailable(): Array<{ id: string; name: string; provider: string; reasoning: boolean; contextWindow: number }>;
}

/**
 * Minimal interface matching pi-coding-agent's AuthStorage API surface
 * used by the auth routes. Avoids a direct dependency on the pi-coding-agent package.
 */
export interface AuthStorageLike {
  reload(): void;
  getOAuthProviders(): Array<{ id: string; name: string }>;
  hasAuth(provider: string): boolean;
  login(
    providerId: string,
    callbacks: {
      onAuth: (info: { url: string; instructions?: string }) => void;
      onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
      onProgress?: (message: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<void>;
  logout(provider: string): void;
  /** Get providers that accept API keys (non-OAuth). Returns provider id and name. */
  getApiKeyProviders?(): Array<{ id: string; name: string }>;
  /** Save an API key for a provider. Creates or overwrites the existing key. */
  setApiKey?(providerId: string, apiKey: string): void;
  /** Remove the stored API key for a provider. No-op if not set. */
  clearApiKey?(providerId: string): void;
  /** Check if a provider has an API key configured. */
  hasApiKey?(providerId: string): boolean;
  /** Get the configured API key for usage providers. */
  getApiKey?(providerId: string): string | null | undefined | Promise<string | null | undefined>;
  /** Get raw stored credentials for usage providers. */
  get?(providerId: string): { type?: string; key?: string } | null | undefined;
}

/**
 * Extended session interface for workflow step refinement.
 * The AgentSession from @mariozechner/pi-coding-agent has on() and prompt() methods
 * but the local AgentSession type is minimal.
 */
interface RefineAgentSession {
  on(event: "text", listener: (delta: string) => void): void;
  prompt(text: string): Promise<void>;
  dispose(): void;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

function readJsonObject(path: string): Record<string, unknown> {
  if (!nodeFs.existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(nodeFs.readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function hasPackageManagerSettings(settings: Record<string, unknown>): boolean {
  return Array.isArray(settings.packages) || Array.isArray(settings.npmCommand);
}

function getPiPackageManagerAgentDir(): string {
  const fusionAgentDir = getFusionAgentDir();
  const legacyAgentDir = getLegacyPiAgentDir();
  const fusionSettings = readJsonObject(join(fusionAgentDir, "settings.json"));
  const legacySettings = readJsonObject(join(legacyAgentDir, "settings.json"));

  if (hasPackageManagerSettings(fusionSettings) || !nodeFs.existsSync(legacyAgentDir)) {
    return fusionAgentDir;
  }
  if (hasPackageManagerSettings(legacySettings)) {
    return legacyAgentDir;
  }
  return nodeFs.existsSync(fusionAgentDir) ? fusionAgentDir : legacyAgentDir;
}

function packageExtensionName(extensionPath: string, source: string): string {
  const base = resolve(extensionPath).split(sep).pop()?.replace(/\.(ts|js)$/i, "") || source;
  if (base !== "index") {
    return base;
  }
  return source.replace(/^(npm:|git:)/, "").split(/[/:@#]/).filter(Boolean).pop() || base;
}

async function discoverDashboardPiExtensions(cwd: string): Promise<PiExtensionSettings> {
  const settings = discoverPiExtensions(cwd);
  const disabled = new Set(settings.disabledIds.map((id) => resolve(id)));
  const byPath = new Map(settings.extensions.map((entry) => [entry.id, entry]));

  try {
    const { DefaultPackageManager } = await import("@mariozechner/pi-coding-agent");
    const agentDir = getPiPackageManagerAgentDir();
    const legacyGlobalSettings = readJsonObject(join(getLegacyPiAgentDir(), "settings.json"));
    const fusionGlobalSettings = readJsonObject(join(getFusionAgentDir(), "settings.json"));
    const globalSettings = { ...legacyGlobalSettings, ...fusionGlobalSettings };
    const projectSettings = readJsonObject(join(cwd, ".fusion", "settings.json"));
    const mergedSettings = { ...globalSettings, ...projectSettings };
    const packageManager = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: {
        getGlobalSettings: () => structuredClone(globalSettings),
        getProjectSettings: () => structuredClone(projectSettings),
        getNpmCommand: () => Array.isArray(mergedSettings.npmCommand)
          ? [...mergedSettings.npmCommand]
          : undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- settingsManager shape varies across pi-coding-agent versions; typed as any per upstream API
      } as any,
    });
    const resolved = await packageManager.resolve(async () => "skip");

    for (const extension of resolved.extensions) {
      const id = resolve(extension.path);
      const source = extension.metadata?.source || "package";
      byPath.set(id, {
        id,
        name: packageExtensionName(id, source),
        path: id,
        source: "package",
        enabled: extension.enabled && !disabled.has(id),
      } satisfies PiExtensionEntry);
    }
  } catch {
    // Filesystem-discovered extensions are still useful if package resolution fails.
  }

  return {
    ...settings,
    extensions: [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
  };
}

import { createFnAgent as engineCreateFnAgentForRefine } from "@fusion/engine";

// Test-injectable override; defaults to the statically imported engine binding.
let createFnAgentForRefine: typeof import("@fusion/engine").createFnAgent | undefined = engineCreateFnAgentForRefine;

/** @internal Inject a mock createFnAgent function for workflow-step refine route tests. */
export function __setCreateFnAgentForRefine(mock: typeof createFnAgentForRefine): void {
  createFnAgentForRefine = mock;
}

// Default system prompt for workflow step refinement (fallback when overrides unavailable)

let resolveWorkflowStepRefinePrompt: (key: string, overrides?: Record<string, string | null>) => string = () => DEFAULT_WORKFLOW_STEP_REFINE_PROMPT;
let promptOverridesReady = false;

async function initPromptOverrides() {
  if (promptOverridesReady) return;
  try {
    const core = await import("@fusion/core");
    resolveWorkflowStepRefinePrompt = (key: string, overrides?: Record<string, string | null>) =>
      core.resolvePrompt(key as keyof typeof core.PROMPT_KEY_CATALOG, overrides);
    promptOverridesReady = true;
  } catch {
    resolveWorkflowStepRefinePrompt = () => DEFAULT_WORKFLOW_STEP_REFINE_PROMPT;
    promptOverridesReady = true;
  }
}

// Initialize on module load
initPromptOverrides();

/** Default system prompt for workflow step refinement */
const DEFAULT_WORKFLOW_STEP_REFINE_PROMPT = `You are an expert at creating detailed agent prompts for workflow steps.

A workflow step is a quality gate that runs after a task is implemented but before it's marked complete.

Given a rough description, create a detailed prompt that an AI agent can follow to execute this workflow step.

The prompt should:
1. Define the purpose clearly
2. Specify what files/context to examine
3. List specific criteria to check
4. Describe what "success" looks like
5. Include guidance on handling common edge cases

Output ONLY the prompt text (no markdown, no explanations).`;

function validateOptionalModelField(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeModelSelectionPair(provider: string | undefined, modelId: string | undefined) {
  if (!provider || !modelId) {
    return { provider: undefined, modelId: undefined };
  }

  return { provider, modelId };
}

function assertConsistentOptionalPair(
  provider: unknown,
  modelId: unknown,
  pairName: string,
): { provider?: string; modelId?: string } {
  const normalizedProvider = validateOptionalModelField(provider, `${pairName} provider`);
  const normalizedModelId = validateOptionalModelField(modelId, `${pairName} modelId`);

  if ((normalizedProvider && !normalizedModelId) || (!normalizedProvider && normalizedModelId)) {
    throw new Error(`${pairName} must include both provider and modelId or neither`);
  }

  return {
    provider: normalizedProvider,
    modelId: normalizedModelId,
  };
}

export { resolveDiffBase, type ResolveDiffBaseTaskInput, runGitCommand } from "./routes/resolve-diff-base.js";

function slugifyPresetName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 32);
  return slug || "preset";
}

function validateModelPresets(value: unknown): ModelPreset[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("modelPresets must be an array");
  }

  const seenIds = new Set<string>();

  return value.map((preset, index) => {
    if (!preset || typeof preset !== "object") {
      throw new Error(`modelPresets[${index}] must be an object`);
    }

    const candidate = preset as Record<string, unknown>;
    const rawId = validateOptionalModelField(candidate.id, `modelPresets[${index}].id`);
    const name = validateOptionalModelField(candidate.name, `modelPresets[${index}].name`);

    if (!name) {
      throw new Error(`modelPresets[${index}].name is required`);
    }

    // Auto-generate ID from name when not provided
    let id = rawId || slugifyPresetName(name);

    // If the explicit ID collides, fall back to the slugified name
    if (seenIds.has(id)) {
      const slugId = slugifyPresetName(name);
      if (!seenIds.has(slugId)) {
        id = slugId;
      } else {
        // Both explicit ID and slug collide — append -1, -2, etc.
        const maxBase = 30;
        let idx = 1;
        while (seenIds.has(id) && idx < 100) {
          const suffix = `-${idx}`;
          id = `${slugId.slice(0, maxBase - suffix.length)}${suffix}`;
          idx++;
        }
      }
    }
    seenIds.add(id);

    const executor = assertConsistentOptionalPair(
      candidate.executorProvider,
      candidate.executorModelId,
      `modelPresets[${index}].executor`,
    );
    const validator = assertConsistentOptionalPair(
      candidate.validatorProvider,
      candidate.validatorModelId,
      `modelPresets[${index}].validator`,
    );

    return {
      id,
      name,
      executorProvider: executor.provider,
      executorModelId: executor.modelId,
      validatorProvider: validator.provider,
      validatorModelId: validator.modelId,
    };
  });
}

function sanitizeOverlapIgnorePaths(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw badRequest("overlapIgnorePaths must be an array of project-relative paths");
  }

  const normalized = value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw badRequest(`overlapIgnorePaths[${index}] must be a string`);
    }

    const trimmed = entry.trim().replaceAll("\\", "/");
    if (!trimmed) {
      throw badRequest(`overlapIgnorePaths[${index}] cannot be empty`);
    }

    if (isAbsolute(trimmed) || /^[a-zA-Z]:\//.test(trimmed)) {
      throw badRequest(`overlapIgnorePaths[${index}] must be a project-relative path`);
    }

    if (/^\.{1,2}(\/|$)/.test(trimmed) || /(^|\/)\.\.(\/|$)/.test(trimmed)) {
      throw badRequest(`overlapIgnorePaths[${index}] cannot include '..' traversal`);
    }

    return trimmed;
  });

  return [...new Set(normalized)];
}

// ── Run-Audit Timeline Types & Helpers ─────────────────────────────────────

/** Valid domain filters for run-audit queries. */
export type RunAuditDomainFilter = "database" | "git" | "filesystem";

/** Filter options for run-audit queries. */
export interface RunAuditQueryFilters {
  /** Filter by task ID */
  taskId?: string;
  /** Filter by domain category */
  domain?: RunAuditDomainFilter;
  /** Start of time range (inclusive, ISO-8601) */
  startTime?: string;
  /** End of time range (inclusive, ISO-8601) */
  endTime?: string;
  /** Maximum number of events to return */
  limit?: number;
}

/**
 * Normalized run-audit event for UI consumption.
 * Provides stable, user-friendly field names.
 */
export interface NormalizedRunAuditEvent {
  /** Unique event identifier */
  id: string;
  /** ISO-8601 timestamp when the event occurred */
  timestamp: string;
  /** Task ID associated with this event (if applicable) */
  taskId?: string;
  /** Domain category: database, git, or filesystem */
  domain: "database" | "git" | "filesystem";
  /** Type of mutation (e.g., "task:update", "git:commit", "file:write") */
  mutationType: string;
  /** Target of the mutation (e.g., task ID, file path, branch name) */
  target: string;
  /** Human-readable summary of the mutation */
  summary: string;
  /** Structured metadata about the mutation */
  metadata?: Record<string, unknown>;
}

/**
 * Unified timeline entry that can represent either an audit event or an agent log entry.
 * Used for correlated timeline views.
 */
export interface TimelineEntry {
  /** ISO-8601 timestamp when the entry occurred */
  timestamp: string;
  /** Entry type discriminator */
  type: "audit" | "log";
  /** Stable sort key to ensure deterministic ordering for identical timestamps */
  sortKey: string;
  /** Normalized audit event (when type is "audit") */
  audit?: NormalizedRunAuditEvent;
  /** Agent log entry (when type is "log") */
  log?: import("@fusion/core").AgentLogEntry;
}

/**
 * Response shape for GET /api/agents/:id/runs/:runId/audit
 */
export interface RunAuditResponse {
  /** The run ID these events belong to */
  runId: string;
  /** Normalized audit events */
  events: NormalizedRunAuditEvent[];
  /** Filter metadata */
  filters: {
    taskId?: string;
    domain?: RunAuditDomainFilter;
    startTime?: string;
    endTime?: string;
  };
  /** Total count of events matching filters */
  totalCount: number;
  /** Whether there are more events (when limit was applied) */
  hasMore: boolean;
}

/**
 * Response shape for GET /api/agents/:id/runs/:runId/timeline
 */
export interface RunTimelineResponse {
  /** Run metadata */
  run: {
    id: string;
    agentId: string;
    startedAt: string;
    endedAt?: string;
    status: string;
    taskId?: string;
  };
  /** Grouped audit events by domain */
  auditByDomain: {
    database: NormalizedRunAuditEvent[];
    git: NormalizedRunAuditEvent[];
    filesystem: NormalizedRunAuditEvent[];
  };
  /** Count metadata */
  counts: {
    auditEvents: number;
    logEntries: number;
  };
  /** Merged and deterministically sorted timeline */
  timeline: TimelineEntry[];
}

/**
 * Parse and validate run-audit query filters from request query params.
 * Throws ApiError with 400 for invalid values.
 */
function parseRunAuditFilters(query: Record<string, unknown>): RunAuditQueryFilters {
  const filters: RunAuditQueryFilters = {};

  // Parse taskId
  if (query.taskId !== undefined) {
    if (typeof query.taskId !== "string" || !query.taskId.trim()) {
      throw new ApiError(400, "taskId must be a non-empty string");
    }
    filters.taskId = query.taskId.trim();
  }

  // Parse domain
  if (query.domain !== undefined) {
    if (typeof query.domain !== "string") {
      throw new ApiError(400, "domain must be a string");
    }
    const domain = query.domain.toLowerCase();
    if (domain !== "database" && domain !== "git" && domain !== "filesystem") {
      throw new ApiError(400, "domain must be one of: database, git, filesystem");
    }
    filters.domain = domain as RunAuditDomainFilter;
  }

  // Parse startTime
  if (query.startTime !== undefined) {
    if (typeof query.startTime !== "string" || !query.startTime.trim()) {
      throw new ApiError(400, "startTime must be a non-empty ISO-8601 string");
    }
    const date = new Date(query.startTime);
    if (isNaN(date.getTime())) {
      throw new ApiError(400, "startTime must be a valid ISO-8601 date string");
    }
    filters.startTime = query.startTime.trim();
  }

  // Parse endTime
  if (query.endTime !== undefined) {
    if (typeof query.endTime !== "string" || !query.endTime.trim()) {
      throw new ApiError(400, "endTime must be a non-empty ISO-8601 string");
    }
    const date = new Date(query.endTime);
    if (isNaN(date.getTime())) {
      throw new ApiError(400, "endTime must be a valid ISO-8601 date string");
    }
    filters.endTime = query.endTime.trim();
  }

  // Validate time range consistency
  if (filters.startTime && filters.endTime) {
    const start = new Date(filters.startTime);
    const end = new Date(filters.endTime);
    if (start > end) {
      throw new ApiError(400, "startTime must be before or equal to endTime");
    }
  }

  // Parse limit
  if (query.limit !== undefined) {
    const limitStr = typeof query.limit === "string" ? query.limit : String(query.limit);
    const limit = parseInt(limitStr, 10);
    if (!Number.isFinite(limit) || limit < 1) {
      throw new ApiError(400, "limit must be a positive integer");
    }
    filters.limit = Math.min(limit, 1000); // Cap at 1000
  }

  return filters;
}

/**
 * Normalize a raw RunAuditEvent to a NormalizedRunAuditEvent for UI consumption.
 */
function normalizeRunAuditEvent(event: import("@fusion/core").RunAuditEvent): NormalizedRunAuditEvent {
  // Generate a human-readable summary based on domain and mutation type
  const summary = generateAuditSummary(event.domain, event.mutationType, event.target, event.metadata);

  return {
    id: event.id,
    timestamp: event.timestamp,
    taskId: event.taskId,
    domain: event.domain,
    mutationType: event.mutationType,
    target: event.target,
    summary,
    metadata: event.metadata,
  };
}

/**
 * Generate a human-readable summary for an audit event.
 */
function generateAuditSummary(
  domain: string,
  mutationType: string,
  target: string,
  _metadata?: Record<string, unknown>,
): string {
  const parts: string[] = [];

  // Add domain prefix
  switch (domain) {
    case "database":
      parts.push("DB");
      break;
    case "git":
      parts.push("Git");
      break;
    case "filesystem":
      parts.push("FS");
      break;
    default:
      parts.push(domain);
  }

  // Add mutation action
  const action = mutationType.split(":").pop() ?? mutationType;
  parts.push(action);

  // Add target context
  if (target) {
    // Truncate long targets for readability
    const displayTarget = target.length > 50 ? `${target.slice(0, 47)}...` : target;
    parts.push(`(${displayTarget})`);
  }

  return parts.join(" ");
}

/**
 * Sort comparator for timeline entries with deterministic tie-breaking.
 * Primary sort: timestamp ascending
 * Tie-breaker: sortKey ascending (which incorporates type and event ID)
 */
function compareTimelineEntries(a: TimelineEntry, b: TimelineEntry): number {
  const timeA = new Date(a.timestamp).getTime();
  const timeB = new Date(b.timestamp).getTime();

  if (timeA !== timeB) {
    return timeA - timeB;
  }

  // Deterministic tie-breaker: sortKey ascending
  // This ensures consistent ordering when timestamps are identical
  return a.sortKey.localeCompare(b.sortKey);
}

/**
 * Create a stable sort key for a timeline entry.
 * Format: "{type_prefix}_{timestamp_ms}_{entry_id}"
 * The type prefix ensures audit events and log entries don't conflict.
 * The timestamp in ms ensures microsecond precision.
 * The entry ID provides final tie-breaking.
 */
function createTimelineSortKey(
  type: "audit" | "log",
  timestamp: string,
  id: string,
): string {
  const ms = new Date(timestamp).getTime();
  const typePrefix = type === "audit" ? "A" : "L";
  // Use a sanitized ID that won't interfere with sorting
  const sanitizedId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${typePrefix}_${String(ms).padStart(16, "0")}_${sanitizedId}`;
}

/**
 * Convert an audit event to a timeline entry.
 */
function auditEventToTimelineEntry(event: import("@fusion/core").RunAuditEvent): TimelineEntry {
  const normalized = normalizeRunAuditEvent(event);
  return {
    timestamp: event.timestamp,
    type: "audit",
    sortKey: createTimelineSortKey("audit", event.timestamp, event.id),
    audit: normalized,
  };
}

/**
 * Convert an agent log entry to a timeline entry.
 */
function logEntryToTimelineEntry(entry: import("@fusion/core").AgentLogEntry): TimelineEntry {
  // Use timestamp as the unique sort key for log entries (AgentLogEntry has no id field)
  return {
    timestamp: entry.timestamp,
    type: "log",
    sortKey: createTimelineSortKey("log", entry.timestamp, entry.timestamp),
    log: entry,
  };
}

function runExcerptToAgentLogs(run: import("@fusion/core").AgentHeartbeatRun): import("@fusion/core").AgentLogEntry[] {
  const entries: import("@fusion/core").AgentLogEntry[] = [];
  const taskId = typeof run.contextSnapshot?.taskId === "string" ? run.contextSnapshot.taskId : "agent-run";

  if (run.stdoutExcerpt?.trim()) {
    entries.push({
      timestamp: run.endedAt ?? run.startedAt,
      taskId,
      type: "text",
      text: run.stdoutExcerpt,
    });
  }

  if (run.stderrExcerpt?.trim()) {
    entries.push({
      timestamp: run.endedAt ?? run.startedAt,
      taskId,
      type: "tool_error",
      text: "stderr",
      detail: run.stderrExcerpt,
    });
  }

  if (run.resultJson && Object.keys(run.resultJson).length > 0 && entries.length === 0) {
    entries.push({
      timestamp: run.endedAt ?? run.startedAt,
      taskId,
      type: "text",
      text: JSON.stringify(run.resultJson, null, 2),
    });
  }

  return entries;
}

function trimTaskDetailActivityLog<T extends Task>(task: T): T {
  if (!Array.isArray(task.log) || task.log.length <= TASK_DETAIL_ACTIVITY_LOG_LIMIT) {
    return task;
  }

  return {
    ...task,
    log: task.log.slice(-TASK_DETAIL_ACTIVITY_LOG_LIMIT),
    activityLogTotal: task.log.length,
    activityLogTruncatedCount: task.log.length - TASK_DETAIL_ACTIVITY_LOG_LIMIT,
  } as T;
}

function parseLastEventId(req: Request): number | undefined {
  const rawHeader = req.headers["last-event-id"];
  const rawQuery = req.query.lastEventId;

  const raw = Array.isArray(rawHeader)
    ? rawHeader[0]
    : (typeof rawHeader === "string" ? rawHeader : Array.isArray(rawQuery) ? rawQuery[0] : rawQuery);

  if (raw === undefined || raw === null) return undefined;

  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;

  return parsed;
}

function replayBufferedSSE(
  res: Response,
  bufferedEvents: Array<{ id: number; event: string; data: string }>,
): boolean {
  for (const bufferedEvent of bufferedEvents) {
    if (!writeSSEEvent(res, bufferedEvent.event, bufferedEvent.data, bufferedEvent.id)) {
      return false;
    }
  }
  return true;
}

function checkSessionLock(
  sessionId: string,
  tabId: string | undefined,
  store: AiSessionStore | undefined,
): { allowed: true } | { allowed: false; currentHolder: string | null } {
  if (!tabId || !store) {
    return { allowed: true };
  }

  const result = store.acquireLock(sessionId, tabId);
  if (result.acquired) {
    return { allowed: true };
  }

  return { allowed: false, currentHolder: result.currentHolder };
}

/**
 * Public API route entrypoint used by server.ts.
 *
 * `createApiRoutes()` is intentionally an orchestrator: it builds shared
 * request/project context once, mounts registrar modules (including integrated
 * router registrars) in precedence-safe order, and keeps compatibility exports
 * in this module stable for tests and
 * downstream consumers (`resolveDiffBase`, `__resetBatchImportRateLimiter`,
 * `__setCreateFnAgentForRefine`, `AuthStorageLike`, `ModelRegistryLike`).
 */
export function createApiRoutes(store: TaskStore, options?: ServerOptions): Router {
  const {
    router,
    runtimeLogger,
    planningLogger,
    chatLogger,
    prioritizeProjectsForCurrentDirectory,
    getProjectIdFromRequest,
    getScopedStore,
    getProjectContext,
    emitRemoteRouteDiagnostic,
    emitAuthSyncAuditLog,
    parseScopeParam,
    resolveAutomationStore,
    resolveRoutineStore,
    resolveRoutineRunner,
    registerDispose,
    dispose,
  } = createApiRoutesContext(store, options);
  const summarizeDiagnostics = createSessionDiagnostics("ai-summarize");

  // Registrar mount order is part of the API contract. Keep specific routes
  // before generic parameter/wildcard routes to preserve Express precedence.
  // Proxy registrar must remain last so explicit /proxy handlers stay ahead
  // of the fallback /proxy/:nodeId/{*splat} wildcard route.
  const routeContext = {
    router,
    store,
    options,
    runtimeLogger,
    planningLogger,
    chatLogger,
    prioritizeProjectsForCurrentDirectory,
    getProjectIdFromRequest,
    getScopedStore,
    getProjectContext,
    emitRemoteRouteDiagnostic,
    emitAuthSyncAuditLog,
    parseScopeParam,
    resolveAutomationStore,
    resolveRoutineStore,
    resolveRoutineRunner,
    registerDispose,
    dispose,
    rethrowAsApiError,
  };

  // Get GitHub token from options or env
  const githubToken = options?.githubToken ?? process.env.GITHUB_TOKEN;
  const aiSessionStore = options?.aiSessionStore;

  // Registrar mount order is precedence-sensitive and mirrors
  // .fusion/tasks/FN-2541/route-order-blueprint.md.
  // Keep this sequence stable unless route-matching invariants are re-audited.
  registerSettingsMemoryRoutes(routeContext, {
    githubToken,
    validateModelPresets,
    sanitizeOverlapIgnorePaths,
    discoverDashboardPiExtensions,
  });
  registerTaskWorkflowRoutes(routeContext, {
    runtimeLogger,
    upload,
    taskDetailActivityLogLimit: TASK_DETAIL_ACTIVITY_LOG_LIMIT,
    validateOptionalModelField,
    normalizeModelSelectionPair,
    runGitCommand,
    trimTaskDetailActivityLog,
    triggerCommentWakeForAssignedAgent: (...args) => triggerCommentWakeForAssignedAgent(...args),
  });
  registerPlanningSubtaskRoutes(routeContext, {
    store,
    aiSessionStore,
    checkSessionLock,
    parseLastEventId,
    replayBufferedSSE,
  });
  registerChatRoutes(routeContext, {
    parseLastEventId,
    validateOptionalModelField,
    upload,
  });
  registerMessagingScriptRoutes(routeContext);
  registerGitGitHubRoutes(routeContext);
  registerFilesTerminalWorkspaceRoutes(routeContext);
  registerAgentsProjectsNodesRoutes(routeContext);
  registerPluginsAutomationRoutes(routeContext);

  // HeartbeatMonitor for triggering agent execution runs
  const heartbeatMonitor = options?.heartbeatMonitor;
  const hasHeartbeatExecutor = Boolean(heartbeatMonitor);

  /**
   * Check whether the heartbeatMonitor is bound to the same project as scopedStore.
   * Returns false when the monitor's rootDir is set and differs from the store's root.
   * Returns true when rootDir is not exposed (backward compatible) or paths match.
   */
  function isHeartbeatMonitorForProject(scopedStore: TaskStore): boolean {
    if (!heartbeatMonitor?.rootDir) return true; // no rootDir exposed — assume compatible
    try {
      const monitorRoot = resolve(heartbeatMonitor.rootDir);
      const storeRoot = resolve(scopedStore.getRootDir());
      return monitorRoot === storeRoot;
    } catch {
      return true; // path resolution failure — assume compatible
    }
  }

  /**
   * Trigger a heartbeat wake for an assigned agent based on a comment event.
   *
   * UTILITY PATH: This function is on the heartbeat control-plane lane and is
   * independent of task-lane saturation. It must NOT be gated on maxConcurrent,
   * semaphore state, or queue depth.
   *
   * Skip reasons (these are normal operation, not saturation gates):
   * - No HeartbeatMonitor available (heartbeat executor not configured)
   * - No agent assigned to the task
   * - HeartbeatMonitor is bound to a different project
   * - Agent's responseMode is not "immediate" (non-immediate mode skips on-demand wakes)
   * - Agent already has an active heartbeat run (prevents duplicate runs)
   */
  const triggerCommentWakeForAssignedAgent = async (
    scopedStore: TaskStore,
    task: Task,
    wake: {
      triggeringCommentType: "steering" | "task" | "pr";
      triggeringCommentIds?: string[];
      triggerDetail: string;
    },
  ): Promise<void> => {
    // Skip: no HeartbeatMonitor available
    if (!hasHeartbeatExecutor || !heartbeatMonitor || !task.assignedAgentId) {
      return;
    }

    // Guard: heartbeatMonitor is bound to a specific project root directory.
    // Skip the wake when the scoped store belongs to a different project.
    if (!isHeartbeatMonitorForProject(scopedStore)) {
      return;
    }

    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
    await agentStore.init();

    const assignedAgent = await agentStore.getAgent(task.assignedAgentId);
    // Skip: agent not found
    if (!assignedAgent) {
      return;
    }

    // Skip: agent's responseMode is not "immediate" (non-immediate mode skips on-demand wakes)
    const responseMode = (assignedAgent.runtimeConfig as { messageResponseMode?: string } | undefined)?.messageResponseMode;
    if (responseMode !== "immediate") {
      return;
    }

    // Skip: agent already has an active heartbeat run (prevents duplicate runs)
    const activeRun = await agentStore.getActiveHeartbeatRun(assignedAgent.id);
    if (activeRun) {
      return;
    }

    const triggeringCommentIds = wake.triggeringCommentIds?.filter((id) => typeof id === "string" && id.length > 0);
    const contextSnapshot: Record<string, unknown> = {
      wakeReason: "on_demand",
      triggerDetail: wake.triggerDetail,
      taskId: task.id,
      ...(triggeringCommentIds?.length ? { triggeringCommentIds } : {}),
      triggeringCommentType: wake.triggeringCommentType,
    };

    await heartbeatMonitor.executeHeartbeat({
      agentId: assignedAgent.id,
      source: "on_demand",
      triggerDetail: wake.triggerDetail,
      taskId: task.id,
      triggeringCommentIds,
      triggeringCommentType: wake.triggeringCommentType,
      contextSnapshot,
    });
  };

  // Scheduler config (includes persisted settings — only needs maxConcurrent/maxTriageConcurrent/maxWorktrees)
  router.get("/config", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettingsFast();
      res.json({
        maxConcurrent: settings.maxConcurrent ?? options?.maxConcurrent ?? 2,
        maxTriageConcurrent: settings.maxTriageConcurrent ?? settings.maxConcurrent ?? 2,
        maxWorktrees: settings.maxWorktrees ?? 4,
        rootDir: scopedStore.getRootDir(),
      });
    } catch {
      const { store: scopedStore } = await getProjectContext(req);
      res.json({ maxConcurrent: options?.maxConcurrent ?? 2, maxTriageConcurrent: options?.maxConcurrent ?? 2, maxWorktrees: 4, rootDir: scopedStore.getRootDir() });
    }
  });

  router.get("/pi-settings", async (_req, res) => {
    try {
      const { SettingsManager, getAgentDir } = await import("@mariozechner/pi-coding-agent");
      const agentDir = getAgentDir();
      const settingsManager = SettingsManager.create(process.cwd(), agentDir);
      const packages = settingsManager.getPackages();
      const extensions = settingsManager.getExtensionPaths();
      const skills = settingsManager.getSkillPaths();
      const prompts = settingsManager.getPromptTemplatePaths();
      const themes = settingsManager.getThemePaths();
      res.json({ packages, extensions, skills, prompts, themes });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PUT /api/pi-settings
   * Updates the user's global pi extension settings in ~/.pi/agent/settings.json.
   * Accepts partial updates: only provided fields are updated.
   * Body: { packages?: PackageSource[], extensions?: string[], skills?: string[], prompts?: string[], themes?: string[] }
   */
  router.put("/pi-settings", async (req, res) => {
    try {
      const { packages, extensions, skills, prompts, themes } = req.body as {
        packages?: unknown;
        extensions?: unknown;
        skills?: unknown;
        prompts?: unknown;
        themes?: unknown;
      };

      // Validate that at least one field is provided
      if (packages === undefined && extensions === undefined && skills === undefined && prompts === undefined && themes === undefined) {
        throw badRequest("At least one setting field must be provided (packages, extensions, skills, prompts, or themes)");
      }

      const { SettingsManager, getAgentDir } = await import("@mariozechner/pi-coding-agent");
      const agentDir = getAgentDir();
      const settingsManager = SettingsManager.create(process.cwd(), agentDir);

      if (packages !== undefined) {
        if (!Array.isArray(packages)) {
          throw badRequest("packages must be an array");
        }
        settingsManager.setPackages(packages as string[]);
      }
      if (extensions !== undefined) {
        if (!Array.isArray(extensions)) {
          throw badRequest("extensions must be an array of strings");
        }
        settingsManager.setExtensionPaths(extensions as string[]);
      }
      if (skills !== undefined) {
        if (!Array.isArray(skills)) {
          throw badRequest("skills must be an array of strings");
        }
        settingsManager.setSkillPaths(skills as string[]);
      }
      if (prompts !== undefined) {
        if (!Array.isArray(prompts)) {
          throw badRequest("prompts must be an array of strings");
        }
        settingsManager.setPromptTemplatePaths(prompts as string[]);
      }
      if (themes !== undefined) {
        if (!Array.isArray(themes)) {
          throw badRequest("themes must be an array of strings");
        }
        settingsManager.setThemePaths(themes as string[]);
      }

      await settingsManager.flush();
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/pi-settings/packages
   * Installs a new pi package source and adds it to the global settings.
   * Body: { source: string }
   */
  router.post("/pi-settings/packages", async (req, res) => {
    try {
      const { source } = req.body as { source?: unknown };
      if (typeof source !== "string" || !source.trim()) {
        throw badRequest("source must be a non-empty string");
      }

      const { SettingsManager, DefaultPackageManager, getAgentDir } = await import("@mariozechner/pi-coding-agent");
      const agentDir = getAgentDir();
      const cwd = process.cwd();
      const settingsManager = SettingsManager.create(process.cwd(), agentDir);
      const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

      await packageManager.install(source.trim());
      const added = packageManager.addSourceToSettings(source.trim());
      if (!added) {
        // Already in settings (setPackages deduplicates), treat as success
        res.json({ success: true });
        return;
      }

      await settingsManager.flush();
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/pi-settings/reinstall-fusion
   * Reinstalls Fusion's bundled pi package and ensures it remains configured in global settings.
   */
  router.post("/pi-settings/reinstall-fusion", async (_req, res) => {
    try {
      const source = "npm:@runfusion/fusion";
      const { SettingsManager, DefaultPackageManager, getAgentDir } = await import("@mariozechner/pi-coding-agent");
      const agentDir = getAgentDir();
      const cwd = process.cwd();
      const settingsManager = SettingsManager.create(process.cwd(), agentDir);
      const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

      await packageManager.install(source);
      const added = packageManager.addSourceToSettings(source);
      if (added) {
        await settingsManager.flush();
      }

      res.json({ success: true, source });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/executor/stats
   * Returns executor status metadata for dashboard status surfaces.
   */
  router.get("/executor/stats", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      
      // Get the most recent activity timestamp from the activity log
      let lastActivityAt: string | undefined;
      try {
        const activityLog = await scopedStore.getActivityLog({ limit: 1 });
        if (activityLog.length > 0) {
          lastActivityAt = activityLog[0].timestamp;
        }
      } catch {
        // If we can't get activity log, that's OK - just leave lastActivityAt undefined
      }

      res.json({
        globalPause: settings.globalPause ?? false,
        enginePaused: settings.enginePaused ?? false,
        maxConcurrent: settings.maxConcurrent ?? 2,
        lastActivityAt,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  const getVitestProcessIds = async (): Promise<number[]> => {
    const { execSync } = await import("node:child_process");

    try {
      const output = execSync("pgrep -f vitest", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });

      return output
        .split(/\r?\n/)
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
    } catch {
      return [];
    }
  };

  /**
   * GET /api/system-stats
   * Returns process/system metrics plus task and agent aggregates.
   */
  router.get("/system-stats", async (req, res) => {
    try {
      const mem = process.memoryUsage();
      const heapStats = v8.getHeapStatistics();
      const load = os.loadavg();
      const vitestProcessIds = await getVitestProcessIds();

      let totalTasks = 0;
      let activeTasks = 0;
      const byColumn: Record<string, number> = {
        triage: 0,
        todo: 0,
        "in-progress": 0,
        "in-review": 0,
        done: 0,
        archived: 0,
      };
      const agentCounts = { idle: 0, active: 0, running: 0, error: 0 };
      let vitestLastAutoKillAt: string | null = null;

      try {
        const { store: scopedStore } = await getProjectContext(req);

        const globalSettingsStore = scopedStore.getGlobalSettingsStore?.();
        if (globalSettingsStore?.getSettings) {
          const globalSettings = await globalSettingsStore.getSettings();
          const candidate = (globalSettings as Record<string, unknown>).vitestLastAutoKillAt;
          if (typeof candidate === "string" && candidate.length > 0) {
            vitestLastAutoKillAt = candidate;
          }
        }

        const tasks = await scopedStore.listTasks({ slim: true, includeArchived: false });
        totalTasks = tasks.length;

        for (const task of tasks) {
          byColumn[task.column] = (byColumn[task.column] ?? 0) + 1;
          if (task.column === "in-progress" || task.column === "in-review") {
            activeTasks += 1;
          }
        }

        const { AgentStore } = await import("@fusion/core");
        const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
        await agentStore.init();
        const agents = await agentStore.listAgents();
        for (const agent of agents) {
          const state = agent.state as keyof typeof agentCounts;
          if (state in agentCounts) {
            agentCounts[state] += 1;
          }
        }
      } catch {
        // System stats should still be available even when project resolution/scoped store fails.
      }

      res.json({
        systemStats: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          heapLimit: heapStats.heap_size_limit,
          external: mem.external,
          arrayBuffers: mem.arrayBuffers,
          cpuPercent: null,
          loadAvg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
          cpuCount: os.cpus().length,
          systemTotalMem: os.totalmem(),
          systemFreeMem: os.freemem(),
          pid: process.pid,
          nodeVersion: process.version,
          platform: `${process.platform}/${process.arch}`,
        },
        taskStats: {
          total: totalTasks,
          byColumn,
          active: activeTasks,
          agents: agentCounts,
        },
        vitestProcessCount: vitestProcessIds.length,
        vitestLastAutoKillAt,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/kill-vitest
   * Kill all running vitest processes (excluding this process).
   */
  router.post("/kill-vitest", async (_req, res) => {
    try {
      const vitestProcessIds = await getVitestProcessIds();
      const killedPids: number[] = [];

      for (const pid of vitestProcessIds) {
        try {
          process.kill(pid, "SIGKILL");
          killedPids.push(pid);
        } catch {
          // Process may have exited before kill.
        }
      }

      res.json({
        killed: killedPids.length,
        pids: killedPids,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to kill vitest processes");
    }
  });

  // ── Backup Routes ─────────────────────────────────────────────────

  /**
   * GET /api/backups
   * List all database backups with metadata.
   */
  router.get("/backups", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { createBackupManager } = await import("@fusion/core");
      const settings = await scopedStore.getSettings();
      const manager = createBackupManager(scopedStore.getFusionDir(), settings);
      const backups = await manager.listBackups();
      
      // Calculate total size
      const totalSize = backups.reduce((sum, b) => sum + b.size, 0);
      
      res.json({
        backups,
        count: backups.length,
        totalSize,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to list backups");
    }
  });

  /**
   * POST /api/backups
   * Create a new database backup immediately.
   */
  router.post("/backups", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { runBackupCommand } = await import("@fusion/core");
      const settings = await scopedStore.getSettings();
      const result = await runBackupCommand(scopedStore.getFusionDir(), settings);
      
      if (result.success) {
        res.json({
          success: true,
          backupPath: result.backupPath,
          output: result.output,
          deletedCount: result.deletedCount,
        });
      } else {
        throw new ApiError(500, result.output);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to create backup");
    }
  });

  // Models
  registerModelRoutes(routeContext);

  // ---------- Auth routes ----------
  registerAuthRoutes(routeContext);

  // ---------- Runtime-plugin probe routes (Hermes / OpenClaw / Paperclip) ----------
  registerRuntimeProviderRoutes(routeContext);

  /**
   * POST /api/ai/refine-text
   * AI-powered text refinement for task descriptions.
   * Body: { text: string, type: string }
   * Returns: { refined: string }
   *
   * Refinement types: clarify, add-details, expand, simplify
   * Rate limited: 10 requests per hour per IP
   */
  router.post("/ai/refine-text", async (req, res) => {
    try {
      const { text, type } = req.body;
      const ip = req.ip || req.socket.remoteAddress || "unknown";

      // Get scoped store and settings for prompt overrides
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      const settings = await scopedStore.getSettings();

      const {
        validateRefineRequest,
        checkRateLimit,
        getRateLimitResetTime,
        refineText,
        RateLimitError: _RateLimitError3,
        ValidationError,
        InvalidTypeError,
        AiServiceError: _AiServiceError,
      } = await import("./ai-refine.js");

      // Check rate limit first
      if (!checkRateLimit(ip)) {
        const resetTime = getRateLimitResetTime(ip);
        throw rateLimited(`Rate limit exceeded. Maximum 10 refinement requests per hour. Reset at ${resetTime?.toISOString() || "unknown"}`);
      }

      // Validate request body
      let validated;
      try {
        validated = validateRefineRequest(text, type);
      } catch (err) {
        if (err instanceof ValidationError) {
          throw badRequest(err instanceof Error ? err.message : String(err));
        }
        if (err instanceof InvalidTypeError) {
          throw new ApiError(422, err instanceof Error ? err.message : String(err));
        }
        throw err;
      }

      // Process refinement with prompt overrides
      const refined = await refineText(
        validated.text,
        validated.type,
        rootDir,
        settings.promptOverrides,
      );
      res.json({ refined });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      // Check error by name since error classes are from dynamic import
      if (err instanceof Error && err.name === "RateLimitError") {
        throw rateLimited(err.message);
      } else if (err instanceof Error && err.name === "AiServiceError") {
        rethrowAsApiError(err, "AI service error");
      } else {
        rethrowAsApiError(err, "Failed to refine text");
      }
    }
  });

  /**
   * POST /api/ai/summarize-title
   * AI-powered title generation from task descriptions.
   * Body: { description: string, provider?: string, modelId?: string }
   * Returns: { title: string }
   *
   * Generates a concise title (≤60 characters) from descriptions longer than 200 characters.
   * Rate limited: 10 requests per hour per IP
   */
  router.post("/ai/summarize-title", async (req, res) => {
    try {
      const { description, provider, modelId } = req.body;
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();

      const {
        checkRateLimit,
        getRateLimitResetTime,
        summarizeTitle,
        validateDescription,
        MIN_DESCRIPTION_LENGTH,
        MAX_DESCRIPTION_LENGTH: _MAX_DESCRIPTION_LENGTH,
        RateLimitError: _RateLimitError4,
        ValidationError: _ValidationError2,
        AiServiceError: _AiServiceError2,
      } = await import("@fusion/core");

      // Optional debug tracing for summarize flows.
      if (process.env.FUSION_DEBUG_AI) {
        summarizeDiagnostics.info("Summarize title request", {
          ip,
          descriptionLength: typeof description === "string" ? description.length : 0,
          operation: "summarize-title-request",
        });
      }

      // Check rate limit first
      if (!checkRateLimit(ip)) {
        const resetTime = getRateLimitResetTime(ip);
        throw rateLimited(`Rate limit exceeded. Maximum 10 summarization requests per hour. Reset at ${resetTime?.toISOString() || "unknown"}`);
      }

      // Validate request body
      try {
        validateDescription(description);
      } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
        if (err instanceof Error && err.name === "ValidationError") {
          throw badRequest(err instanceof Error ? err.message : String(err));
        }
        throw err;
      }

      // Resolve model selection hierarchy for summarization:
      // 1. Request body provider+modelId (request override)
      // 2. Project title summarizer lane
      // 3. Global title summarizer lane
      // 4. Project planning lane
      // 5. Project default override
      // 6. Global default
      // 7. Automatic model resolution (no explicit model)
      const settings = await scopedStore.getSettings();
      const resolvedSummarySettings = resolveTitleSummarizerSettingsModel(settings);

      const resolvedProvider =
        (provider && modelId ? provider : undefined) ||
        resolvedSummarySettings.provider;

      const resolvedModelId =
        (provider && modelId ? modelId : undefined) ||
        resolvedSummarySettings.modelId;

      if (process.env.FUSION_DEBUG_AI) {
        summarizeDiagnostics.info("Summarize title model resolved", {
          provider: resolvedProvider ?? "auto",
          modelId: resolvedModelId ?? "auto",
          operation: "summarize-title-model-resolution",
        });
      }

      // Process summarization
      const title = await summarizeTitle(description, rootDir, resolvedProvider, resolvedModelId);

      if (!title) {
        throw badRequest(`Description must be at least ${MIN_DESCRIPTION_LENGTH} characters for summarization`);
      }

      res.json({ title });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      // Check error by name since error classes are from dynamic import
      if (err instanceof Error && err.name === "RateLimitError") {
        throw rateLimited(err.message);
      } else if (err instanceof Error && err.name === "AiServiceError") {
        throw new ApiError(503, err.message || "AI service temporarily unavailable");
      } else if (err instanceof Error && err.name === "ValidationError") {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else {
        summarizeDiagnostics.errorFromException("Unexpected summarize title error", err, {
          operation: "summarize-title",
        });
        rethrowAsApiError(err, "Failed to generate title");
      }
    }
  });

  registerUsageRoutes(routeContext);
  registerUpdateCheckRoutes(routeContext);

  // ── Automation / Scheduled Task Routes ────────────────────────────
  //
  // Scope-aware endpoints: Accept `scope=global|project` query param or body field.
  // - When scope=global: Operations target the global automation store
  // - When scope=project: Operations target project-scoped automations (filtered by scope)
  // - When scope is omitted: Legacy default behavior (global store, backward compatible)
  //
  // Error codes:
  // - 400: Invalid scope value or validation failure
  // - 404: Schedule not found
  // - 503: Automation store unavailable

  // GET /automations — list all scheduled tasks (optionally filtered by scope)
  router.get("/automations", async (req: Request, res: Response) => {
    // Return empty array when no store available (legacy backward-compatible behavior)
    if (!options?.automationStore) {
      return res.json([]);
    }

    try {
      const scope = parseScopeParam(req);
      const automationStore = resolveAutomationStore(req, scope);

      // Get all schedules and filter by scope if specified
      // When scope is omitted, return all schedules (legacy behavior)
      const allSchedules = await automationStore.listSchedules();
      if (scope) {
        const filteredSchedules = allSchedules.filter((s) => s.scope === scope);
        res.json(filteredSchedules);
      } else {
        res.json(allSchedules);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // POST /automations — create a new schedule (with optional scope)
  router.post("/automations", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const automationStore = resolveAutomationStore(req, scope);

    try {
      const { name, description, scheduleType, cronExpression, command, enabled, timeoutMs, steps } = req.body;

      // Validation
      if (!name?.trim()) {
        throw badRequest("Name is required");
      }
      const hasSteps = Array.isArray(steps) && steps.length > 0;
      if (!hasSteps && !command?.trim()) {
        throw badRequest("Command is required when no steps are provided");
      }
      const validTypes = ["hourly", "daily", "weekly", "monthly", "custom", "every15Minutes", "every30Minutes", "every2Hours", "every6Hours", "every12Hours", "weekdays"];
      if (!scheduleType || !validTypes.includes(scheduleType)) {
        throw badRequest(`Invalid schedule type. Must be one of: ${validTypes.join(", ")}`);
      }
      if (scheduleType === "custom") {
        if (!cronExpression?.trim()) {
          throw badRequest("Cron expression is required for custom schedule type");
        }
        if (!AutomationStore.isValidCron(cronExpression)) {
          throw badRequest(`Invalid cron expression: "${cronExpression}"`);
        }
      }
      // Validate steps if provided
      if (hasSteps) {
        const stepErr = validateAutomationSteps(steps);
        if (stepErr) {
          throw badRequest(stepErr);
        }
      }

      // Determine scope for the new schedule
      // Default to "project" for backward compatibility when scope is omitted
      const scheduleScope = scope ?? "project";

      const schedule = await automationStore.createSchedule({
        name,
        description,
        scheduleType: scheduleType as ScheduleType,
        cronExpression,
        command: command ?? "",
        enabled,
        timeoutMs,
        steps: hasSteps ? steps : undefined,
        scope: scheduleScope,
      });
      res.status(201).json(schedule);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // GET /automations/:id — get a single schedule
  router.get("/automations/:id", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const automationStore = resolveAutomationStore(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const schedule = await automationStore.getSchedule(id);

      // Scope isolation: if scope is specified, verify the schedule belongs to that scope
      if (scope && schedule.scope !== scope) {
        throw notFound("Schedule not found");
      }

      res.json(schedule);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Schedule not found");
      }
      rethrowAsApiError(err);
    }
  });

  // PATCH /automations/:id — update a schedule
  router.patch("/automations/:id", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const automationStore = resolveAutomationStore(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

      // Scope isolation: if scope is specified, verify the schedule belongs to that scope
      // by fetching it first (can't filter in update without scope support in store)
      if (scope) {
        const existing = await automationStore.getSchedule(id);
        if (existing.scope !== scope) {
          throw notFound("Schedule not found");
        }
      }

      const { name, description, scheduleType, cronExpression, command, enabled, timeoutMs, steps } = req.body;

      // Validate cron if switching to custom
      if (scheduleType === "custom" && cronExpression) {
        if (!AutomationStore.isValidCron(cronExpression)) {
          throw badRequest(`Invalid cron expression: "${cronExpression}"`);
        }
      }

      // Validate steps if provided
      if (Array.isArray(steps) && steps.length > 0) {
        const stepErr = validateAutomationSteps(steps);
        if (stepErr) {
          throw badRequest(stepErr);
        }
      }

      const schedule = await automationStore.updateSchedule(id, {
        name,
        description,
        scheduleType,
        cronExpression,
        command,
        enabled,
        timeoutMs,
        steps: steps !== undefined ? steps : undefined,
      });
      res.json(schedule);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Schedule not found");
      }
      if ((err instanceof Error ? err.message : String(err)).includes("cannot be empty") || (err instanceof Error ? err.message : String(err)).includes("Invalid cron")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  // DELETE /automations/:id — delete a schedule
  router.delete("/automations/:id", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const automationStore = resolveAutomationStore(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

      // Scope isolation: if scope is specified, verify the schedule belongs to that scope
      if (scope) {
        const existing = await automationStore.getSchedule(id);
        if (existing.scope !== scope) {
          throw notFound("Schedule not found");
        }
      }

      const deleted = await automationStore.deleteSchedule(id);
      res.json(deleted);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Schedule not found");
      }
      rethrowAsApiError(err);
    }
  });

  // POST /automations/:id/run — trigger a manual run
  router.post("/automations/:id/run", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const automationStore = resolveAutomationStore(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const schedule = await automationStore.getSchedule(id);

      // Scope isolation: if scope is specified, verify the schedule belongs to that scope
      if (scope && schedule.scope !== scope) {
        throw notFound("Schedule not found");
      }

      const startedAt = new Date().toISOString();
      const scopedStore = await getScopedStore(req);
      let result: import("@fusion/core").AutomationRunResult;

      if (schedule.steps && schedule.steps.length > 0) {
        // Multi-step execution
        result = await executeScheduleSteps(schedule, startedAt, scopedStore);
      } else {
        // Legacy single-command execution
        result = await executeSingleCommand(schedule.command, schedule.timeoutMs, startedAt);
      }

      // Record the result
      const updated = await automationStore.recordRun(schedule.id, result);
      res.json({ schedule: updated, result });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Schedule not found");
      }
      rethrowAsApiError(err);
    }
  });

  // POST /automations/:id/toggle — toggle enabled/disabled
  router.post("/automations/:id/toggle", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const automationStore = resolveAutomationStore(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const schedule = await automationStore.getSchedule(id);

      // Scope isolation: if scope is specified, verify the schedule belongs to that scope
      if (scope && schedule.scope !== scope) {
        throw notFound("Schedule not found");
      }

      const updated = await automationStore.updateSchedule(id, {
        enabled: !schedule.enabled,
      });
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Schedule not found");
      }
      rethrowAsApiError(err);
    }
  });

  // POST /automations/:id/steps/reorder — reorder steps
  router.post("/automations/:id/steps/reorder", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const automationStore = resolveAutomationStore(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

      // Scope isolation: if scope is specified, verify the schedule belongs to that scope
      if (scope) {
        const existing = await automationStore.getSchedule(id);
        if (existing.scope !== scope) {
          throw notFound("Schedule not found");
        }
      }

      const { stepIds } = req.body;
      if (!Array.isArray(stepIds)) {
        throw badRequest("stepIds must be an array");
      }
      const schedule = await automationStore.reorderSteps(id, stepIds);
      res.json(schedule);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Schedule not found");
      }
      if ((err instanceof Error ? err.message : String(err)).includes("mismatch") || (err instanceof Error ? err.message : String(err)).includes("Unknown step") || (err instanceof Error ? err.message : String(err)).includes("no steps")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  // ── Routine Routes ──────────────────────────────────────────────────
  //
  // Scope-aware endpoints: Accept `scope=global|project` query param or body field.
  // - When scope=global: Operations target the global routine store
  // - When scope=project: Operations target project-scoped routines (filtered by scope)
  // - When scope is omitted: Legacy default behavior (global store, backward compatible)
  //
  // Error codes:
  // - 400: Invalid scope value or validation failure
  // - 401: Webhook signature verification failed
  // - 403: Webhook disabled/forbidden
  // - 404: Routine not found
  // - 503: Routine store or runner unavailable

  // GET /routines — list all routines (optionally filtered by scope)
  router.get("/routines", async (req: Request, res: Response) => {
    // Return empty array when no store available (legacy backward-compatible behavior)
    if (!options?.routineStore) {
      return res.json([]);
    }

    try {
      const scope = parseScopeParam(req);
      const routineStore = resolveRoutineStore(req, scope);

      // Get all routines and filter by scope if specified
      // When scope is omitted, return all routines (legacy behavior)
      const allRoutines = await routineStore.listRoutines();
      if (scope) {
        const filteredRoutines = allRoutines.filter((r) => r.scope === scope);
        res.json(filteredRoutines);
      } else {
        res.json(allRoutines);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // POST /routines — create a new routine (with optional scope)
  router.post("/routines", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const routineStore = resolveRoutineStore(req, scope);

    try {
      const { name, agentId, description, trigger, command, steps, timeoutMs, catchUpPolicy, executionPolicy, enabled } = req.body;

      // Validation
      if (!name?.trim()) {
        throw badRequest("Name is required");
      }
      if (!trigger) {
        throw badRequest("Trigger is required");
      }
      if (!trigger.type) {
        throw badRequest("Trigger must have a type field");
      }
      const validTriggerTypes: RoutineTriggerType[] = ["cron", "webhook", "api", "manual"];
      if (!validTriggerTypes.includes(trigger.type)) {
        throw badRequest(`Invalid trigger type. Must be one of: ${validTriggerTypes.join(", ")}`);
      }
      if (trigger.type === "cron") {
        if (!trigger.cronExpression?.trim()) {
          throw badRequest("Cron expression is required for cron trigger");
        }
        if (!RoutineStore.isValidCron(trigger.cronExpression)) {
          throw badRequest(`Invalid cron expression: "${trigger.cronExpression}"`);
        }
      }
      if (trigger.type === "webhook") {
        // Require an HMAC secret so the webhook endpoint authenticates callers
        // via signed payloads. Without this, anyone who can reach the server
        // and knows the routine id could trigger execution by sending an empty
        // POST to /routines/:id/webhook.
        if (typeof trigger.secret !== "string" || trigger.secret.trim().length < 16) {
          throw badRequest(
            "Webhook trigger requires a secret of at least 16 characters for HMAC signature verification",
          );
        }
      }
      const hasSteps = Array.isArray(steps) && steps.length > 0;
      const hasCommand = typeof command === "string" && command.trim().length > 0;
      if (hasSteps) {
        const stepErr = validateAutomationSteps(steps);
        if (stepErr) {
          throw badRequest(stepErr);
        }
      }
      if (catchUpPolicy !== undefined) {
        const validCatchUpPolicies: Array<"run" | "skip" | "run_one"> = ["run", "skip", "run_one"];
        if (!validCatchUpPolicies.includes(catchUpPolicy)) {
          throw badRequest(`Invalid catchUpPolicy. Must be one of: ${validCatchUpPolicies.join(", ")}`);
        }
      }
      if (executionPolicy !== undefined) {
        const validExecutionPolicies: Array<"parallel" | "queue" | "reject"> = ["parallel", "queue", "reject"];
        if (!validExecutionPolicies.includes(executionPolicy)) {
          throw badRequest(`Invalid executionPolicy. Must be one of: ${validExecutionPolicies.join(", ")}`);
        }
      }

      // Determine scope for the new routine
      // Default to "project" for backward compatibility when scope is omitted
      const routineScope = scope ?? "project";

      const routine = await routineStore.createRoutine({
        name: name.trim(),
        agentId: typeof agentId === "string" ? agentId.trim() : "",
        description,
        trigger,
        command: hasCommand ? command : undefined,
        steps: hasSteps ? steps : undefined,
        timeoutMs,
        catchUpPolicy,
        executionPolicy,
        enabled,
        scope: routineScope,
      });
      res.status(201).json(routine);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // GET /routines/:id — get a single routine
  router.get("/routines/:id", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const routineStore = resolveRoutineStore(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const routine = await routineStore.getRoutine(id);

      // Scope isolation: if scope is specified, verify the routine belongs to that scope
      if (scope && routine.scope !== scope) {
        throw notFound("Routine not found");
      }

      res.json(routine);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Routine not found");
      }
      rethrowAsApiError(err);
    }
  });

  // PATCH /routines/:id — update a routine
  router.patch("/routines/:id", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const routineStore = resolveRoutineStore(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

      // Scope isolation: if scope is specified, verify the routine belongs to that scope
      if (scope) {
        const existing = await routineStore.getRoutine(id);
        if (existing.scope !== scope) {
          throw notFound("Routine not found");
        }
      }

      const { name, description, trigger, command, steps, timeoutMs, catchUpPolicy, executionPolicy, enabled } = req.body;

      // Validate name if provided
      if (name !== undefined && !name.trim()) {
        throw badRequest("Name cannot be empty");
      }

      // Validate trigger if provided
      if (trigger !== undefined) {
        if (trigger.type) {
          const validTriggerTypes: RoutineTriggerType[] = ["cron", "webhook", "api", "manual"];
          if (!validTriggerTypes.includes(trigger.type)) {
            throw badRequest(`Invalid trigger type. Must be one of: ${validTriggerTypes.join(", ")}`);
          }
          if (trigger.type === "cron" && trigger.cronExpression) {
            if (!RoutineStore.isValidCron(trigger.cronExpression)) {
              throw badRequest(`Invalid cron expression: "${trigger.cronExpression}"`);
            }
          }
          if (trigger.type === "webhook") {
            if (typeof trigger.secret !== "string" || trigger.secret.trim().length < 16) {
              throw badRequest(
                "Webhook trigger requires a secret of at least 16 characters for HMAC signature verification",
              );
            }
          }
        }
      }
      if (Array.isArray(steps) && steps.length > 0) {
        const stepErr = validateAutomationSteps(steps);
        if (stepErr) {
          throw badRequest(stepErr);
        }
      }

      const routine = await routineStore.updateRoutine(id, {
        name: name !== undefined ? name.trim() : undefined,
        description,
        trigger,
        command: command !== undefined ? command : undefined,
        steps: steps !== undefined ? steps : undefined,
        timeoutMs,
        catchUpPolicy,
        executionPolicy,
        enabled,
      });
      res.json(routine);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Routine not found");
      }
      if ((err instanceof Error ? err.message : String(err)).includes("cannot be empty") || (err instanceof Error ? err.message : String(err)).includes("Invalid cron")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  // DELETE /routines/:id — delete a routine
  router.delete("/routines/:id", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const routineStore = resolveRoutineStore(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

      // Scope isolation: if scope is specified, verify the routine belongs to that scope
      if (scope) {
        const existing = await routineStore.getRoutine(id);
        if (existing.scope !== scope) {
          throw notFound("Routine not found");
        }
      }

      const deleted = await routineStore.deleteRoutine(id);
      res.json(deleted);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Routine not found");
      }
      rethrowAsApiError(err);
    }
  });

  // POST /routines/:id/run — manual trigger (backward-compatible alias for /trigger)
  router.post("/routines/:id/run", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const routineStore = resolveRoutineStore(req, scope);
    const routineRunner = resolveRoutineRunner(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const routine = await routineStore.getRoutine(id);

      // Scope isolation: if scope is specified, verify the routine belongs to that scope
      if (scope && routine.scope !== scope) {
        throw notFound("Routine not found");
      }

      // Validate routine is enabled
      if (!routine.enabled) {
        throw badRequest("Routine is disabled");
      }

      // Execute via RoutineRunner (persistence handled by RoutineRunner.completeRoutineExecution)
      const result = await routineRunner.triggerManual(id);
      const updated = await routineStore.getRoutine(id);
      res.json({ routine: updated, result });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Routine not found");
      }
      rethrowAsApiError(err);
    }
  });

  // POST /routines/:id/trigger — canonical manual trigger (uses RoutineRunner)
  // POST /routines/:id/run is a backward-compatible alias with identical behavior
  router.post("/routines/:id/trigger", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const routineStore = resolveRoutineStore(req, scope);
    const routineRunner = resolveRoutineRunner(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const routine = await routineStore.getRoutine(id);

      // Scope isolation: if scope is specified, verify the routine belongs to that scope
      if (scope && routine.scope !== scope) {
        throw notFound("Routine not found");
      }

      // Validate routine is enabled
      if (!routine.enabled) {
        throw badRequest("Routine is disabled");
      }

      // Execute via RoutineRunner (persistence handled by RoutineRunner.completeRoutineExecution)
      const result = await routineRunner.triggerManual(id);
      const updated = await routineStore.getRoutine(id);
      res.json({ routine: updated, result });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Routine not found");
      }
      rethrowAsApiError(err);
    }
  });

  // GET /routines/:id/runs — get execution history
  router.get("/routines/:id/runs", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const routineStore = resolveRoutineStore(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const routine = await routineStore.getRoutine(id);

      // Scope isolation: if scope is specified, verify the routine belongs to that scope
      if (scope && routine.scope !== scope) {
        throw notFound("Routine not found");
      }

      res.json(routine.runHistory);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Routine not found");
      }
      rethrowAsApiError(err);
    }
  });

  // POST /routines/:id/webhook — incoming webhook trigger
  // Note: Webhook routes do NOT use scope params from the request - webhooks are triggered
  // externally and the routine's own scope determines which store to use.
  // The webhook URL should include the scope implicitly via the routine ID.
  router.post("/routines/:id/webhook", async (req: Request, res: Response) => {
    // Webhook triggers don't accept scope params from the request
    // The routine's scope field determines which store to use
    const routineStore = resolveRoutineStore(req, undefined);
    const routineRunner = resolveRoutineRunner(req, undefined);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const routine = await routineStore.getRoutine(id);

      // Validate this is a webhook-type routine
      if (!isWebhookTrigger(routine.trigger)) {
        throw badRequest("Routine is not configured for webhook triggers");
      }

      // Validate routine is enabled
      if (!routine.enabled) {
        throw badRequest("Routine is disabled");
      }

      // Get raw body for HMAC verification
      const rawBody = req.rawBody;
      const signatureHeader = req.headers["x-hub-signature-256"] as string | undefined;

      // A webhook routine without a secret is treated as a misconfiguration
      // and refused. New routines require a secret at create time (see POST
      // /routines), but legacy routines persisted before that validation was
      // added could still reach this branch without one.
      if (!routine.trigger.secret) {
        throw new ApiError(
          401,
          "Webhook trigger is not configured with a secret; set routine.trigger.secret before use",
        );
      }
      if (!rawBody) {
        throw badRequest("Raw body not available for signature verification");
      }
      if (!signatureHeader) {
        throw new ApiError(401, "Missing signature header");
      }
      const verification = verifyWebhookSignature(rawBody, signatureHeader, routine.trigger.secret);
      if (!verification.valid) {
        throw new ApiError(401, verification.error ?? "Invalid signature");
      }

      // Execute via RoutineRunner (persistence handled by RoutineRunner.completeRoutineExecution)
      const payload = req.body;
      const result = await routineRunner.triggerWebhook(id, payload, signatureHeader);
      const updated = await routineStore.getRoutine(id);
      res.json({ routine: updated, result });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Routine not found");
      }
      rethrowAsApiError(err);
    }
  });

  // ── Activity Log Routes ─────────────────────────────────────────────

  /**
   * GET /api/activity
   * Get activity log entries.
   * Query params: limit (default 100, max 1000), since (ISO timestamp), type (event type filter)
   * Returns: ActivityLogEntry[] sorted newest first
   */
  router.get("/activity", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const limitParam = req.query.limit;
      const sinceParam = req.query.since;
      const typeParam = req.query.type;

      // Parse and validate limit
      let limit: number | undefined;
      if (limitParam !== undefined) {
        const parsed = Number.parseInt(limitParam as string, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw badRequest("limit must be a non-negative integer");
        }
        limit = Math.min(parsed, 1000); // Max 1000
      }

      // Validate type if provided
      const validTypes = ["task:created", "task:moved", "task:updated", "task:deleted", "task:merged", "task:failed", "settings:updated"];
      if (typeParam !== undefined && !validTypes.includes(typeParam as string)) {
        throw badRequest(`Invalid type. Must be one of: ${validTypes.join(", ")}`);
      }

      const options: { limit?: number; since?: string; type?: ActivityEventType } = {
        limit,
        since: sinceParam as string | undefined,
        type: typeParam as ActivityEventType | undefined,
      };

      const entries = await scopedStore.getActivityLog(options);
      res.json(entries);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * DELETE /api/activity
   * Clear all activity log entries (maintenance endpoint).
   * Returns: { success: true }
   */
  router.delete("/activity", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      await scopedStore.clearActivityLog();
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Workflow Step Routes ──────────────────────────────────────────────

  /**
   * GET /api/workflow-steps
   * List all workflow step definitions.
   * Returns: WorkflowStep[]
   */
  router.get("/workflow-steps", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const steps = await scopedStore.listWorkflowSteps();
      res.json(steps);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/workflow-steps
   * Create a new workflow step.
   * Body: { name: string, description: string, mode?: "prompt"|"script", prompt?: string, scriptName?: string, enabled?: boolean, modelProvider?: string, modelId?: string }
   * Returns: WorkflowStep
   */
  router.post("/workflow-steps", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { name, description, mode, phase, prompt, toolMode, scriptName, enabled, defaultOn, modelProvider, modelId } = req.body;

      if (!name || typeof name !== "string" || !name.trim()) {
        throw badRequest("name is required");
      }
      if (!description || typeof description !== "string" || !description.trim()) {
        throw badRequest("description is required");
      }

      // Validate mode
      const resolvedMode: "prompt" | "script" = mode || "prompt";
      if (resolvedMode !== "prompt" && resolvedMode !== "script") {
        throw badRequest("mode must be 'prompt' or 'script'");
      }

      // Validate phase
      if (phase !== undefined && phase !== "pre-merge" && phase !== "post-merge") {
        throw badRequest("phase must be 'pre-merge' or 'post-merge'");
      }

      if (prompt !== undefined && typeof prompt !== "string") {
        throw badRequest("prompt must be a string");
      }
      if (toolMode !== undefined && toolMode !== "readonly" && toolMode !== "coding") {
        throw badRequest("toolMode must be 'readonly' or 'coding'");
      }
      if (scriptName !== undefined && typeof scriptName !== "string") {
        throw badRequest("scriptName must be a string");
      }
      if (enabled !== undefined && typeof enabled !== "boolean") {
        throw badRequest("enabled must be a boolean");
      }
      if (defaultOn !== undefined && typeof defaultOn !== "boolean") {
        throw badRequest("defaultOn must be a boolean");
      }

      // Validate script mode: scriptName must reference a named script in settings
      if (resolvedMode === "script") {
        if (!scriptName?.trim()) {
          throw badRequest("scriptName is required when mode is 'script'");
        }
        const settings = await scopedStore.getSettings();
        const scripts = settings.scripts || {};
        if (!(scriptName.trim() in scripts)) {
          throw badRequest(`Script '${scriptName.trim()}' not found in project settings. Available scripts: ${Object.keys(scripts).join(", ") || "none"}`);
        }
      }

      // Validate model override pair (only relevant for prompt mode)
      const modelPair = assertConsistentOptionalPair(modelProvider, modelId, "workflow step model");

      // Check for name conflicts
      const existing = await scopedStore.listWorkflowSteps();
      if (existing.some((ws) => ws.name.toLowerCase() === name.trim().toLowerCase())) {
        throw conflict(`A workflow step named '${name.trim()}' already exists`);
      }

      const step = await scopedStore.createWorkflowStep({
        name: name.trim(),
        description: description.trim(),
        mode: resolvedMode,
        phase,
        prompt: prompt?.trim(),
        toolMode,
        scriptName: scriptName?.trim(),
        enabled,
        defaultOn: defaultOn === true,
        modelProvider: modelPair.provider,
        modelId: modelPair.modelId,
      });
      res.status(201).json(step);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = typeof (err instanceof Error ? err.message : String(err)) === "string" && ((err instanceof Error ? err.message : String(err)).includes("must include both provider and modelId") || (err instanceof Error ? err.message : String(err)).includes("Script mode requires")) ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * PATCH /api/workflow-steps/:id
   * Update a workflow step.
   * Body: Partial<{ name, description, mode, prompt, scriptName, enabled, modelProvider, modelId }>
   * Returns: WorkflowStep
   */
  router.patch("/workflow-steps/:id", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { name, description, mode, phase, prompt, toolMode, scriptName, enabled, defaultOn, modelProvider, modelId } = req.body;

      const updates: Record<string, unknown> = {};
      if (name !== undefined) {
        if (typeof name !== "string" || !name.trim()) {
          throw badRequest("name must be a non-empty string");
        }
        updates.name = name.trim();
      }
      if (description !== undefined) {
        if (typeof description !== "string" || !description.trim()) {
          throw badRequest("description must be a non-empty string");
        }
        updates.description = description.trim();
      }
      if (mode !== undefined) {
        if (mode !== "prompt" && mode !== "script") {
          throw badRequest("mode must be 'prompt' or 'script'");
        }
        updates.mode = mode;
      }
      if (phase !== undefined) {
        if (phase !== "pre-merge" && phase !== "post-merge") {
          throw badRequest("phase must be 'pre-merge' or 'post-merge'");
        }
        updates.phase = phase;
      }
      if (prompt !== undefined) {
        if (typeof prompt !== "string") {
          throw badRequest("prompt must be a string");
        }
        updates.prompt = prompt;
      }
      if (toolMode !== undefined) {
        if (toolMode !== "readonly" && toolMode !== "coding") {
          throw badRequest("toolMode must be 'readonly' or 'coding'");
        }
        updates.toolMode = toolMode;
      }
      if (scriptName !== undefined) {
        if (typeof scriptName !== "string") {
          throw badRequest("scriptName must be a string");
        }
        updates.scriptName = scriptName;
      }
      if (enabled !== undefined) {
        if (typeof enabled !== "boolean") {
          throw badRequest("enabled must be a boolean");
        }
        updates.enabled = enabled;
      }
      if (defaultOn !== undefined) {
        if (typeof defaultOn !== "boolean") {
          throw badRequest("defaultOn must be a boolean");
        }
        updates.defaultOn = defaultOn;
      }

      // Validate script-mode requirements against the resulting state (existing + updates)
      // This catches cases where an existing script-mode step has its scriptName updated
      // without the mode field being explicitly sent.
      const existingStep = await scopedStore.getWorkflowStep(req.params.id);
      const resultingMode: string | undefined = updates.mode !== undefined ? (updates.mode as string) : existingStep?.mode;
      const resultingScriptName: string | undefined = updates.scriptName !== undefined ? (updates.scriptName as string) : existingStep?.scriptName;

      if (resultingMode === "script") {
        if (!resultingScriptName?.trim()) {
          throw badRequest("scriptName is required when mode is 'script'");
        }
        const settings = await scopedStore.getSettings();
        const scripts = settings.scripts || {};
        if (!(resultingScriptName.trim() in scripts)) {
          throw badRequest(`Script '${resultingScriptName.trim()}' not found in project settings. Available scripts: ${Object.keys(scripts).join(", ") || "none"}`);
        }
      }

      // Validate and apply model override pair
      if (modelProvider !== undefined || modelId !== undefined) {
        const modelPair = assertConsistentOptionalPair(modelProvider, modelId, "workflow step model");
        updates.modelProvider = modelPair.provider;
        updates.modelId = modelPair.modelId;
      }

      const step = await scopedStore.updateWorkflowStep(req.params.id, updates);
      res.json(step);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        const status = typeof (err instanceof Error ? err.message : String(err)) === "string" && ((err instanceof Error ? err.message : String(err)).includes("must include both provider and modelId") || (err instanceof Error ? err.message : String(err)).includes("Script mode requires")) ? 400 : 500;
        throw new ApiError(status, err instanceof Error ? err.message : String(err));
      }
    }
  });

  /**
   * DELETE /api/workflow-steps/:id
   * Delete a workflow step.
   * Returns: 204 No Content
   */
  router.delete("/workflow-steps/:id", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      await scopedStore.deleteWorkflowStep(req.params.id);
      res.status(204).send();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/workflow-steps/:id/refine
   * Use AI to refine the workflow step's description into a detailed agent prompt.
   * Only available for prompt-mode steps.
   * Returns: { prompt: string, workflowStep: WorkflowStep }
   */
  router.post("/workflow-steps/:id/refine", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const step = await scopedStore.getWorkflowStep(req.params.id);
      if (!step) {
        throw notFound(`Workflow step '${req.params.id}' not found`);
      }

      if (step.mode === "script") {
        throw badRequest("Cannot refine prompt for script-mode workflow steps");
      }

      if (!step.description?.trim()) {
        throw badRequest("Workflow step has no description to refine");
      }

      // Use AI to refine the description into a detailed agent prompt
      let refinedPrompt: string;
      try {
        const createFnAgent = createFnAgentForRefine;

        const settings = await scopedStore.getSettings();

        // Resolve the system prompt using prompt overrides (with fallback to default)
        const systemPrompt = resolveWorkflowStepRefinePrompt(
          "workflow-step-refine",
          settings.promptOverrides
        ) || DEFAULT_WORKFLOW_STEP_REFINE_PROMPT;

        if (!createFnAgent) {
          throw new Error("createFnAgent is not available");
        }
        const planningModel = resolvePlanningSettingsModel(settings);
        const { session } = await createFnAgent({
          cwd: scopedStore.getRootDir(),
          systemPrompt,
          tools: "readonly",
          // Resolve planning model using canonical lane hierarchy:
          // 1. Project planning lane
          // 2. Global planning lane
          // 3. Project default override
          // 4. Global default
          defaultProvider: planningModel.provider,
          defaultModelId: planningModel.modelId,
          defaultThinkingLevel: settings.defaultThinkingLevel,
        });

        const refineSession = session as unknown as RefineAgentSession;
        let output = "";
        refineSession.on("text", (delta: string) => {
          output += delta;
        });

        await refineSession.prompt(
          `Refine this workflow step description into a detailed agent prompt:\n\nName: ${step.name}\nDescription: ${step.description}`
        );
        refineSession.dispose();

        refinedPrompt = output.trim();
      } catch {
        // Fallback: return the description as-is if AI is unavailable
        refinedPrompt = step.description;
      }

      // Update the workflow step with the refined prompt
      const updated = await scopedStore.updateWorkflowStep(step.id, { prompt: refinedPrompt });
      res.json({ prompt: refinedPrompt, workflowStep: updated });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Workflow Step Templates ───────────────────────────────────────────

  /**
   * GET /api/workflow-step-templates
   * List all built-in workflow step templates.
   * Returns: { templates: WorkflowStepTemplate[] }
   */
  router.get("/workflow-step-templates", async (_req, res) => {
    try {
      const { WORKFLOW_STEP_TEMPLATES } = await import("@fusion/core");
      res.json({ templates: WORKFLOW_STEP_TEMPLATES });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/workflow-step-templates/:id/create
   * Create a workflow step from a built-in template.
   * Returns: WorkflowStep
   */
  router.post("/workflow-step-templates/:id/create", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { WORKFLOW_STEP_TEMPLATES } = await import("@fusion/core");
      const template = WORKFLOW_STEP_TEMPLATES.find((t) => t.id === req.params.id);

      if (!template) {
        throw notFound(`Template '${req.params.id}' not found`);
      }

      // Check for name conflicts with existing workflow steps
      const existing = await scopedStore.listWorkflowSteps();
      if (existing.some((ws) => ws.name.toLowerCase() === template.name.toLowerCase())) {
        throw conflict(`A workflow step named '${template.name}' already exists`);
      }

      const step = await scopedStore.createWorkflowStep({
        templateId: template.id,
        name: template.name,
        description: template.description,
        prompt: template.prompt,
        toolMode: template.toolMode,
        enabled: true,
      });

      res.status(201).json(step);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Agent Routes ───────────────────────────────────────────────────────────

  /**
   * Terminal task statuses — tasks in these states should not be displayed
   * as "working on" in agent UI surfaces to avoid stale activity indicators.
   */
  const TERMINAL_TASK_STATUSES = new Set(["done", "archived"]);

  /**
   * Check if a task status is terminal (done or archived).
   */
  function isTerminalTaskStatus(status: string | undefined): boolean {
    return status !== undefined && TERMINAL_TASK_STATUSES.has(status);
  }

  /**
   * Sanitize agent responses to omit taskId when the linked task is in a terminal state.
   * This prevents stale "working on" UI indicators for completed/archived tasks.
   *
   * @param agents - Array of agents to sanitize
   * @param scopedStore - Task store for looking up linked task status
   * @returns Agents with terminal-linked taskId omitted from response
   */
  async function sanitizeAgentTaskLinks(
    agents: Array<import("@fusion/core").Agent>,
    scopedStore: TaskStore,
  ): Promise<Array<import("@fusion/core").Agent>> {
    // Batch lookup all unique taskIds to minimize individual store calls
    const taskIds = [...new Set(agents.map((a) => a.taskId).filter((id): id is string => id !== undefined))];
    const taskStatusMap = new Map<string, string>();

    // Parallel fetch all linked tasks
    await Promise.all(
      taskIds.map(async (taskId) => {
        try {
          const task = await scopedStore.getTask(taskId);
          if (task) {
            taskStatusMap.set(taskId, task.column);
          }
        } catch {
          // Task lookup failed — treat as non-terminal (preserve taskId)
        }
      }),
    );

    return agents.map((agent) => {
      if (!agent.taskId) return agent;

      const taskStatus = taskStatusMap.get(agent.taskId);
      if (isTerminalTaskStatus(taskStatus)) {
        // Omit taskId for terminal tasks — use spread to create shallow copy without taskId
        const { taskId: _omitted, ...sanitized } = agent;
        return sanitized as import("@fusion/core").Agent;
      }
      return agent;
    });
  }

  function validateAgentInstructionsPayload(
    instructionsPath: unknown,
    instructionsText: unknown,
  ): boolean {
    if (instructionsPath !== undefined && instructionsPath !== null && instructionsPath !== "") {
      if (typeof instructionsPath !== "string") {
        throw badRequest("instructionsPath must be a string");
      }
      if (instructionsPath.length > 500) {
        throw badRequest("instructionsPath must be at most 500 characters");
      }
      if (instructionsPath.includes("..")) {
        throw badRequest("instructionsPath must not contain parent directory traversal (..)");
      }
      const isAbsoluteUnix = instructionsPath.startsWith("/");
      const isAbsoluteWindows = /^[A-Za-z]:[\\/]/.test(instructionsPath);
      if (isAbsoluteUnix || isAbsoluteWindows) {
        throw badRequest("instructionsPath must be a project-relative path");
      }
      if (!instructionsPath.endsWith(".md")) {
        throw badRequest("instructionsPath must end in .md");
      }
    }

    if (instructionsText !== undefined && instructionsText !== null && instructionsText !== "") {
      if (typeof instructionsText !== "string") {
        throw badRequest("instructionsText must be a string");
      }
      if (instructionsText.length > 50000) {
        throw badRequest("instructionsText must be at most 50,000 characters");
      }
    }

    return true;
  }

  function serializeAccessState(state: import("@fusion/core").AgentAccessState) {
    return {
      ...state,
      resolvedPermissions: Array.from(state.resolvedPermissions),
      explicitPermissions: Array.from(state.explicitPermissions),
      roleDefaultPermissions: Array.from(state.roleDefaultPermissions),
    };
  }

  // Agent registrar order is contract-sensitive. Keep this sequence stable:
  // 1) /agents + create, 2) import/export, 3) ordering-sensitive core lookups + /agents/:id,
  // 4) runtime control-plane (/runs/stop before /runs/:runId),
  // 5) reflections/ratings (latest before list), 6) generation routes.
  registerAgentCoreListCreateRoutes(routeContext, {
    sanitizeAgentTaskLinks,
    validateAgentInstructionsPayload,
  });

  registerAgentImportExportRoutes(routeContext);

  registerAgentCoreRoutes(routeContext, {
    sanitizeAgentTaskLinks,
    validateAgentInstructionsPayload,
  });

  registerAgentRuntimeRoutes(routeContext, {
    validateAgentInstructionsPayload,
    serializeAccessState,
    hasHeartbeatExecutor,
    heartbeatMonitor,
    isHeartbeatMonitorForProject,
    runExcerptToAgentLogs,
    parseRunAuditFilters,
    normalizeRunAuditEvent,
    auditEventToTimelineEntry,
    logEntryToTimelineEntry,
    compareTimelineEntries,
    listAgentMemoryFiles: (...args) => listAgentMemoryFiles(...args),
    readAgentMemoryFile: (...args) => readAgentMemoryFile(...args),
    writeAgentMemoryFile: (...args) => writeAgentMemoryFile(...args),
    isMemoryBackendError: (error): error is { code: string; backend?: string; message: string } => error instanceof MemoryBackendError,
  });

  // ── Agent Reflection Routes ──────────────────────────────────────────────

  registerAgentReflectionRatingRoutes(routeContext);

  registerAgentGenerationRoutes(routeContext);

  // ── Integrated domain routers ──────────────────────────────────────────────
  // Keep this call at the current position to preserve precedence with
  // surrounding route handlers. registerIntegratedRouters() mounts:
  // - /missions
  // - /roadmaps
  // - /insights
  // - /todos
  registerIntegratedRouters({
    router,
    store,
    options,
    aiSessionStore,
  });

  // ── Plugin Routes ─────────────────────────────────────────────────────────
  // Plugin management endpoints with projectId scoping support.
  // Uses getScopedStore(req) pattern for multi-project support.
  // Requires pluginStore in options.

  /**
   * GET /api/plugins
   * List all installed plugins.
   * Query: { projectId?: string, enabled?: boolean }
   */
  router.get("/plugins", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();

    const filter: { enabled?: boolean } = {};
    if (req.query.enabled !== undefined) {
      filter.enabled = req.query.enabled === "true";
    }

    const plugins = await pluginStore.listPlugins(filter);
    res.json(plugins);
  });

  /**
   * GET /api/plugins/ui-slots
   * Get all UI slot definitions from active plugins.
   * Returns aggregated array of { pluginId, slot } objects.
   */
  router.get("/plugins/ui-slots", async (_req: Request, res: Response) => {
    const slots = options?.pluginLoader?.getPluginUiSlots() ?? [];
    res.json(slots);
  });

  /**
   * GET /api/plugins/runtimes
   * Get all plugin runtime metadata from active plugins.
   * Returns aggregated array of { pluginId, runtimeId, name, description, version }.
   */
  router.get("/plugins/runtimes", async (_req: Request, res: Response) => {
    const runtimes = options?.pluginLoader?.getPluginRuntimes() ?? [];
    const installed = runtimes.map(({ pluginId, runtime }) => ({
      pluginId,
      runtimeId: runtime.metadata.runtimeId,
      name: runtime.metadata.name,
      description: runtime.metadata.description,
      version: runtime.metadata.version,
    }));
    const installedRuntimeIds = new Set(installed.map((r) => r.runtimeId));
    const bundledFallback = BUNDLED_PLUGIN_RUNTIMES.filter(
      (r) => !installedRuntimeIds.has(r.runtimeId),
    );
    res.json([...installed, ...bundledFallback]);
  });

  /**
   * GET /api/plugins/:id
   * Get a single plugin by ID.
   * Query: { projectId?: string }
   */
  router.get("/plugins/:id", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    try {
      const plugin = await pluginStore.getPlugin(id);
      res.json(plugin);
    } catch (err: unknown) {
      if (err instanceof Error && (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(`Plugin "${id}" not found`);
      }
      throw internalError(err instanceof Error ? err.message : "Unknown error");
    }
  });

  /**
   * GET /api/plugins/:id/settings
   * Get plugin settings by plugin ID.
   * Query: { projectId?: string }
   */
  router.get("/plugins/:id/settings", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    try {
      const plugin = await pluginStore.getPlugin(id);
      res.json(plugin.settings);
    } catch (err: unknown) {
      if (err instanceof Error && (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(`Plugin "${id}" not found`);
      }
      throw internalError(err instanceof Error ? err.message : "Unknown error");
    }
  });

  /**
   * POST /api/plugins
   * Create or register a plugin.
   * Requires `mode` discriminator in body:
   *   - mode: "register" → body must include { id, name, version, path }, optional { enabled, settings, projectId }
   *   - mode: "install" → body must include { path }, optional { projectId }
   * Returns 201 on success, 400 for validation errors, 409 for conflicts.
   */
  router.post("/plugins", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();

    if (!req.body || typeof req.body !== "object") {
      throw badRequest("Request body is required");
    }

    const body = req.body as Record<string, unknown>;

    // Validate mode discriminator is present
    if (!("mode" in body) || typeof body.mode !== "string") {
      throw badRequest("Request body must have a 'mode' field with value 'register' or 'install'");
    }

    const mode = body.mode as string;

    if (mode === "register") {
      // Register mode: requires id, name, version, path
      if (typeof body.id !== "string" || !body.id.trim()) {
        throw badRequest("'id' is required for register mode and must be a non-empty string");
      }
      if (typeof body.name !== "string" || !body.name.trim()) {
        throw badRequest("'name' is required for register mode and must be a non-empty string");
      }
      if (typeof body.version !== "string" || !body.version.trim()) {
        throw badRequest("'version' is required for register mode and must be a non-empty string");
      }
      if (typeof body.path !== "string" || !body.path.trim()) {
        throw badRequest("'path' is required for register mode and must be a non-empty string");
      }

      const manifest: import("@fusion/core").PluginManifest = {
        id: body.id as string,
        name: body.name as string,
        version: body.version as string,
        description: typeof body.description === "string" ? body.description : undefined,
        author: typeof body.author === "string" ? body.author : undefined,
        homepage: typeof body.homepage === "string" ? body.homepage : undefined,
        dependencies: Array.isArray(body.dependencies) ? (body.dependencies as string[]) : undefined,
        settingsSchema: typeof body.settingsSchema === "object" && body.settingsSchema !== null
          ? (body.settingsSchema as Record<string, import("@fusion/core").PluginSettingSchema>)
          : undefined,
      };

      const settings = typeof body.settings === "object" && body.settings !== null
        ? (body.settings as Record<string, unknown>)
        : undefined;

      // If enabled and loader is available, try to load the plugin
      let plugin: import("@fusion/core").PluginInstallation;
      try {
        plugin = await pluginStore.registerPlugin({
          manifest,
          path: body.path as string,
          settings,
        });

        if (plugin.enabled && options?.pluginLoader) {
          try {
            await options.pluginLoader.loadPlugin(plugin.id);
          } catch (loadErr) {
            // Log but don't fail - plugin is registered, just not loaded
            runtimeLogger.child("plugin-routes").error(`Failed to load plugin ${plugin.id}`, {
              error: loadErr instanceof Error ? loadErr.message : String(loadErr),
            });
          }
        }

        res.status(201).json(plugin);
      } catch (err: unknown) {
        if (err instanceof Error && (err instanceof Error ? err.message : String(err)).includes("already registered")) {
          throw conflict(err instanceof Error ? err.message : String(err));
        }
        throw internalError(err instanceof Error ? err.message : "Failed to register plugin");
      }
    } else if (mode === "install") {
      // Install mode: requires path, loads manifest from path
      // Supports package root and dist-folder selections via resolvePluginManifest
      if (typeof body.path !== "string" || !body.path.trim()) {
        throw badRequest("'path' is required for install mode and must be a non-empty string");
      }

      // Check if runtime install interface is available
      if (!options?.pluginLoader) {
        throw badRequest("Plugin install mode is not supported: plugin loader not available");
      }

      // Resolve manifest — supports package root and dist-folder selections
      const { manifestDir, manifest } = await resolvePluginManifest(body.path as string);

      try {
        const plugin = await pluginStore.registerPlugin({
          manifest,
          path: manifestDir,
        });

        // If enabled, try to load the plugin
        if (plugin.enabled) {
          try {
            await options.pluginLoader.loadPlugin(plugin.id);
          } catch (loadErr) {
            runtimeLogger.child("plugin-routes").error(`Failed to load plugin ${plugin.id}`, {
              error: loadErr instanceof Error ? loadErr.message : String(loadErr),
            });
          }
        }

        res.status(201).json(plugin);
      } catch (err: unknown) {
        if (err instanceof Error && (err instanceof Error ? err.message : String(err)).includes("already registered")) {
          throw conflict(err instanceof Error ? err.message : String(err));
        }
        throw internalError(err instanceof Error ? err.message : "Failed to register plugin");
      }
    } else {
      throw badRequest(`Invalid mode: '${mode}'. Must be 'register' or 'install'`);
    }
  });

  /**
   * POST /api/plugins/:id/enable
   * Enable a plugin and start it.
   * Body: { projectId?: string }
   */
  router.post("/plugins/:id/enable", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    let plugin = await pluginStore.enablePlugin(id);

    // Start the plugin if loader is available
    if (options?.pluginLoader) {
      try {
        await options.pluginLoader.loadPlugin(id);
      } catch (loadErr) {
        // Update state to error
        await pluginStore.updatePluginState(
          id,
          "error",
          loadErr instanceof Error ? loadErr.message : String(loadErr),
        );
        plugin = await pluginStore.getPlugin(id);
      }
    }

    res.json(plugin);
  });

  /**
   * POST /api/plugins/:id/disable
   * Disable a plugin and stop it.
   * Body: { projectId?: string }
   */
  router.post("/plugins/:id/disable", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    // Stop the plugin if loader is available
    if (options?.pluginLoader) {
      try {
        await options.pluginLoader.stopPlugin(id);
      } catch {
        // Ignore errors from stopping - plugin might not be loaded
      }
    }

    const plugin = await pluginStore.disablePlugin(id);
    res.json(plugin);
  });

  /**
   * POST /api/plugins/:id/reload
   * Reload a running plugin with updated code.
   * Body: { projectId?: string }
   */
  router.post("/plugins/:id/reload", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    let plugin: import("@fusion/core").PluginInstallation;
    try {
      plugin = await pluginStore.getPlugin(id);
    } catch (err: unknown) {
      if (err instanceof Error && (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(`Plugin "${id}" not found`);
      }
      throw internalError(err instanceof Error ? err.message : "Unknown error");
    }

    if (plugin.state !== "started") {
      throw badRequest("Plugin is not currently loaded. Use enable instead.");
    }

    if (!options?.pluginRunner?.reloadPlugin) {
      throw internalError("Plugin runner not available");
    }

    try {
      await options.pluginRunner.reloadPlugin(id);
    } catch (reloadErr: unknown) {
      throw internalError(`Reload failed: ${reloadErr instanceof Error ? reloadErr.message : String(reloadErr)}`);
    }

    const updatedPlugin = await pluginStore.getPlugin(id);
    res.json(updatedPlugin);
  });

  /**
   * PUT /api/plugins/:id/settings
   * Update plugin settings.
   * Body: { settings: Record<string, unknown>, projectId?: string }
   */
  router.put("/plugins/:id/settings", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    if (!req.body || typeof req.body !== "object") {
      throw badRequest("Request body must be an object with 'settings' field");
    }

    const body = req.body as Record<string, unknown>;
    const settings = body.settings as Record<string, unknown> | undefined;

    if (!settings || typeof settings !== "object") {
      throw badRequest("Request body must have a 'settings' object");
    }

    try {
      const plugin = await pluginStore.updatePluginSettings(id, settings);
      res.json(plugin);
    } catch (err: unknown) {
      if (err instanceof Error && (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(`Plugin "${id}" not found`);
      }
      if (err instanceof Error && (err instanceof Error ? err.message : String(err)).includes("validation failed")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
      throw internalError(err instanceof Error ? err.message : "Failed to update settings");
    }
  });

  /**
   * DELETE /api/plugins/:id
   * Uninstall a plugin.
   * Query: { projectId?: string }
   */
  router.delete("/plugins/:id", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    // Stop the plugin if loader is available
    if (options?.pluginLoader) {
      try {
        await options.pluginLoader.stopPlugin(id);
      } catch {
        // Ignore - plugin might not be loaded
      }
    }

    await pluginStore.unregisterPlugin(id);
    res.status(204).send();
  });

  // ── AI Session Routes (Background Tasks) ─────────────────────────────────

  /**
   * GET /api/ai-sessions
   * List active background AI sessions (generating or awaiting_input).
   * Query: { projectId?: string }
   */
  router.get("/ai-sessions", (req, res) => {
    if (!aiSessionStore) {
      res.json({ sessions: [] });
      return;
    }
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const sessions = aiSessionStore.listActive(projectId);
    res.json({ sessions });
  });

  /**
   * DELETE /api/ai-sessions/cleanup
   * Cleanup stale AI sessions with optional max-age override.
   */
  router.delete("/ai-sessions/cleanup", (req, res) => {
    if (!aiSessionStore) {
      sendErrorResponse(res, 503, "Session store not available");
      return;
    }

    const minimumMaxAgeMs = 60 * 60 * 1000;
    let maxAgeMs = SESSION_CLEANUP_DEFAULT_MAX_AGE_MS;

    if (typeof req.query.maxAgeMs === "string") {
      const parsed = Number(req.query.maxAgeMs);
      if (!Number.isFinite(parsed)) {
        throw badRequest("maxAgeMs must be a valid number");
      }
      maxAgeMs = Math.max(minimumMaxAgeMs, Math.floor(parsed));
    }

    const result = aiSessionStore.cleanupStaleSessions(maxAgeMs);
    res.json({
      ...result,
      maxAgeMs,
    });
  });

  /**
   * GET /api/ai-sessions/:id
   * Get full session state for modal reconnection.
   */
  router.get("/ai-sessions/:id", (req, res) => {
    if (!aiSessionStore) {
      throw notFound("AI sessions not available");
    }
    const session = aiSessionStore.get(req.params.id);
    if (!session) {
      throw notFound("Session not found");
    }
    res.json(session);
  });

  router.post("/ai-sessions/:id/lock", (req, res) => {
    if (!aiSessionStore) {
      throw notFound("AI sessions not available");
    }

    const { id } = req.params;
    const session = aiSessionStore.get(id);
    if (!session) {
      throw notFound("Session not found");
    }

    const tabId = typeof req.body?.tabId === "string" ? req.body.tabId.trim() : "";
    if (!tabId) {
      throw badRequest("tabId is required");
    }

    const result = aiSessionStore.acquireLock(id, tabId);
    if (!result.acquired) {
      res.json({ acquired: false, currentHolder: result.currentHolder });
      return;
    }

    res.json({ acquired: true });
  });

  router.delete("/ai-sessions/:id/lock", (req, res) => {
    if (!aiSessionStore) {
      throw notFound("AI sessions not available");
    }

    const { id } = req.params;
    const tabId = typeof req.body?.tabId === "string" ? req.body.tabId.trim() : "";
    if (!tabId) {
      throw badRequest("tabId is required");
    }

    aiSessionStore.releaseLock(id, tabId);
    res.json({ success: true });
  });

  router.post("/ai-sessions/:id/lock/force", (req, res) => {
    if (!aiSessionStore) {
      throw notFound("AI sessions not available");
    }

    const { id } = req.params;
    const session = aiSessionStore.get(id);
    if (!session) {
      throw notFound("Session not found");
    }

    const tabId = typeof req.body?.tabId === "string" ? req.body.tabId.trim() : "";
    if (!tabId) {
      throw badRequest("tabId is required");
    }

    aiSessionStore.forceAcquireLock(id, tabId);
    res.json({ success: true });
  });

  router.delete("/ai-sessions/:id/lock/beacon", (req, res) => {
    if (!aiSessionStore) {
      throw notFound("AI sessions not available");
    }

    const { id } = req.params;
    const tabId = typeof req.query.tabId === "string" ? req.query.tabId.trim() : "";
    if (tabId) {
      aiSessionStore.releaseLock(id, tabId);
    }

    res.status(200).end();
  });

  /**
   * POST /api/ai-sessions/:id/ping
   * Lightweight keep-alive touch for active AI sessions.
   */
  router.post("/ai-sessions/:id/ping", (req, res) => {
    if (!aiSessionStore) {
      throw notFound("AI sessions not available");
    }

    const { id } = req.params;
    const updated = aiSessionStore.ping(id);
    if (!updated) {
      throw notFound("Session not found");
    }

    res.json({ ok: true });
  });

  /**
   * DELETE /api/ai-sessions/:id
   * Dismiss/cancel a background AI session.
   * Also cleans up the in-memory agent if still alive.
   */
  router.delete("/ai-sessions/:id", (req, res) => {
    if (!aiSessionStore) {
      throw notFound("AI sessions not available");
    }
    const { id } = req.params;
    const session = aiSessionStore.get(id);
    if (!session) {
      throw notFound("Session not found");
    }

    aiSessionStore.delete(id);

    try {
      if (getPlanningSession(id)) cleanupPlanningSession(id);
    } catch {
      // Session may not belong to planning or may already be cleaned up.
    }

    try {
      if (getSubtaskSession(id)) cleanupSubtaskSession(id);
    } catch {
      // Session may not belong to subtask breakdown or may already be cleaned up.
    }

    try {
      if (getMissionInterviewSession(id)) cleanupMissionInterviewSession(id);
    } catch {
      // Session may not belong to mission interview or may already be cleaned up.
    }

    try {
      if (getTargetInterviewSession(id)) cleanupTargetInterviewSession(id);
    } catch {
      // Session may not belong to milestone/slice interview or may already be cleaned up.
    }

    res.json({ ok: true });
  });

  // ── Directory Browsing ────────────────────────────────────────────────────────

  /**
   * GET /api/browse-directory
   * Browse filesystem directories for the directory picker.
   * Query: { path?: string, showHidden?: "true", nodeId?: string }
   * Returns: { currentPath: string, parentPath: string | null, entries: Array<{ name: string, path: string, hasChildren: boolean }> }
   */
  router.get("/browse-directory", async (req, res) => {
    try {
      const nodeId = req.query.nodeId as string | undefined;

      // Node-aware proxying: route to remote node if nodeId is provided and not local
      if (nodeId) {
        const { CentralCore } = await import("@fusion/core");
        const central = new CentralCore(store.getFusionDir());
        await central.init();

        const localNodes = await central.listNodes();
        const localNode = localNodes.find((n: { type?: string; id?: string }) => n.type === "local");

        if (localNode && localNode.id === nodeId) {
          // Local node — fall through to existing filesystem logic below
          await central.close();
        } else {
          // Remote node — look up node config and proxy directly
          const node = await central.getNode(nodeId);
          await central.close();

          if (!node) {
            throw notFound("Node not found");
          }
          if (!node.url) {
            throw badRequest("Node has no URL configured");
          }

          const queryString = req.url.split('?').slice(1).join('?');
          const targetUrl = `${node.url.replace(/\/$/, '')}/api/browse-directory${queryString ? '?' + queryString : ''}`;
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (node.apiKey) {
            headers["Authorization"] = `Bearer ${node.apiKey}`;
          }

          try {
            const proxyRes = await fetch(targetUrl, {
              method: "GET",
              headers,
              signal: AbortSignal.timeout(30000),
            });

            if (proxyRes.status === 401 && !node.apiKey) {
              throw unauthorized("Remote node rejected directory browse request. Configure an apiKey for that node in Fusion settings.");
            }

            const body = Buffer.from(await proxyRes.arrayBuffer());
            // Filter hop-by-hop headers
            const skipHeaders = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade"]);
            for (const [key, value] of proxyRes.headers.entries()) {
              if (!skipHeaders.has(key.toLowerCase())) {
                res.setHeader(key, value);
              }
            }
            res.status(proxyRes.status);
            res.send(body);
          } catch (fetchErr) {
            const e = fetchErr as { name?: string; code?: string; message?: string };
            if (e.name === "AbortError" || e.code === "ETIMEDOUT") {
              throw new ApiError(504, `Remote node timeout: ${e.message ?? String(fetchErr)}`);
            }
            throw new ApiError(502, `Remote node error: ${e.message ?? String(fetchErr)}`);
          }
          return;
        }
      }

      // Local node logic
      const { resolve, dirname, join } = await import("node:path");
      const { readdir, stat } = await import("node:fs/promises");

      const rawPath = (req.query.path as string) || process.env.HOME || process.env.USERPROFILE || "/";
      const showHidden = req.query.showHidden === "true";

      // Validate: must be absolute, no .. traversal
      const resolvedPath = resolve(rawPath);
      if (rawPath.includes("..")) {
        throw badRequest("Path must not contain '..' traversal");
      }
      if (resolvedPath !== resolve(resolvedPath)) {
        throw badRequest("Path must be absolute");
      }

      // Check path exists and is a directory
      let pathStat;
      try {
        pathStat = await stat(resolvedPath);
      } catch {
        throw notFound("Directory not found");
      }
      if (!pathStat.isDirectory()) {
        throw badRequest("Path is not a directory");
      }

      // Read directory entries
      const dirEntries = await readdir(resolvedPath, { withFileTypes: true });
      const entries: Array<{ name: string; path: string; hasChildren: boolean }> = [];

      for (const entry of dirEntries) {
        if (!entry.isDirectory()) continue;
        if (!showHidden && entry.name.startsWith(".")) continue;

        const entryPath = join(resolvedPath, entry.name);
        let hasChildren = false;
        try {
          const subEntries = await readdir(entryPath, { withFileTypes: true });
          hasChildren = subEntries.some((e) => e.isDirectory());
        } catch {
          // Can't read subdirectory — treat as no children
        }

        entries.push({ name: entry.name, path: entryPath, hasChildren });
      }

      entries.sort((a, b) => a.name.localeCompare(b.name));

      const parentPath = dirname(resolvedPath) === resolvedPath ? null : dirname(resolvedPath);

      res.json({ currentPath: resolvedPath, parentPath, entries });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Registrar order is API-contract sensitive. Keep this domain sequence stable:
  // 1) project routes (`/projects/across-nodes|detect` before `/projects/:id`)
  // 2) node CRUD/operational routes
  // 3) node settings/auth sync routes
  // 4) mesh routes (`/mesh/state` before `/mesh/sync`)
  // 5) discovery routes
  // 6) inbound settings/auth receive/export routes
  // ── Project Management Routes (Multi-Project Support) ───────────────────────

  registerProjectRoutes(routeContext);

  // ── Node Management Routes (Multi-Node Support) ───────────────────────────

  registerNodeRoutes(routeContext);

  // ── Remote Node Settings Sync Routes ──────────────────────────────────────

  registerSettingsSyncRoutes(routeContext);

  // ── Mesh Topology Routes ────────────────────────────────────────────────

  registerMeshRoutes(routeContext);

  // ── Node Discovery Routes (mDNS / DNS-SD) ────────────────────────────────

  registerDiscoveryRoutes(routeContext);

  // ── Inbound Settings/Auth Sync Routes ─────────────────────────────────────

  registerSettingsSyncInboundRoutes(routeContext);

  /**
   * GET /api/activity-feed
   * Get unified activity feed across all projects.
   * Query: limit, projectId, types
   * Returns: ActivityFeedEntry[]
   */
  router.get("/activity-feed", async (req, res) => {
    try {
      const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 50;
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
      const typesParam = typeof req.query.types === "string" ? req.query.types.split(",") : undefined;
      const types = typesParam as import("@fusion/core").ActivityEventType[] | undefined;
      
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      
      const entries = await central.getRecentActivity({ limit, projectId, types });
      await central.close();
      
      res.json(entries);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/global-concurrency
   * Get global concurrency state across all projects.
   * Returns: GlobalConcurrencyState
   */
  router.get("/global-concurrency", async (_req, res) => {
    try {
      const central = options?.centralCore ?? new (await import("@fusion/core")).CentralCore();
      const shouldClose = !options?.centralCore;
      if (shouldClose || (typeof central.isInitialized === "function" && !central.isInitialized())) await central.init();
      
      const state = await central.getGlobalConcurrencyState();
      if (shouldClose) await central.close();
      
      res.json(state);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PUT /api/global-concurrency
   * Update the system-wide concurrency limit across all projects.
   * Body: { globalMaxConcurrent: number }
   * Returns: GlobalConcurrencyState
   */
  router.put("/global-concurrency", async (req, res) => {
    const { globalMaxConcurrent } = req.body ?? {};
    if (!Number.isInteger(globalMaxConcurrent) || globalMaxConcurrent < 1 || globalMaxConcurrent > 10000) {
      throw badRequest("globalMaxConcurrent must be an integer between 1 and 10000");
    }

    try {
      const central = options?.centralCore ?? new (await import("@fusion/core")).CentralCore();
      const shouldClose = !options?.centralCore;
      if (shouldClose || (typeof central.isInitialized === "function" && !central.isInitialized())) await central.init();

      const state = await central.updateGlobalConcurrency({ globalMaxConcurrent });
      if (shouldClose) await central.close();

      res.json(state);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/first-run-status
   * Check if user has projects or needs setup wizard.
   * Returns: { hasProjects: boolean, singleProjectPath: string | null }
   */
  router.get("/first-run-status", async (_req, res) => {
    try {
      const { CentralCore, FirstRunDetector } = await import("@fusion/core");
      const central = options?.centralCore ?? new CentralCore();
      const shouldClose = !options?.centralCore;
      const detector = new FirstRunDetector(central.getGlobalDir());

      try {
        if (shouldClose || (typeof central.isInitialized === "function" && !central.isInitialized())) {
          await central.init();
        }

        const projects = await central.listProjects();
        const hasProjects = projects.length > 0;
        const singleProjectPath = projects.length === 1 ? projects[0].path : null;

        res.json({ hasProjects, singleProjectPath });
      } catch (error) {
        const detectedProjects = await detector.detectExistingProjects(process.cwd());
        const hasProjects = detectedProjects.length > 0;
        const singleProjectPath = detectedProjects.length === 1 ? detectedProjects[0].path : null;

        console.warn(
          `[routes:first-run-status] Falling back to detected projects after central DB error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );

        res.json({ hasProjects, singleProjectPath });
      } finally {
        if (shouldClose) {
          await central.close();
        }
      }
      
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/setup-state
   * Returns the first-run state and any detected projects for migration.
   * This is used by the dashboard to determine what UI to show on startup.
   */
  router.get("/setup-state", async (_req, res) => {
    try {
      const { CentralCore, FirstRunDetector } = await import("@fusion/core");
      const central = options?.centralCore ?? new CentralCore();
      const shouldClose = !options?.centralCore;
      const detector = new FirstRunDetector(central.getGlobalDir());
      const detectedProjects = await detector.detectExistingProjects(process.cwd());
      let state = await detector.detectFirstRunState();
      let projects: Array<{ id: string; name: string; path: string }> = [];

      try {
        if (shouldClose || (typeof central.isInitialized === "function" && !central.isInitialized())) {
          await central.init();
        }
        state = await detector.detectFirstRunState(central);
        projects = await central.listProjects();
      } catch (error) {
        console.warn(
          `[routes:setup-state] Unable to read central DB state: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (shouldClose) {
          await central.close();
        }
      }

      res.json({
        state,
        detectedProjects,
        hasCentralDb: detector.hasCentralDb(),
        registeredProjects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          path: p.path,
        })),
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/complete-setup
   * Complete the first-run setup by registering projects.
   * Body: { projects: Array<{ path: string, name: string, isolationMode?: "in-process" | "child-process" }> }
   */
  router.post("/complete-setup", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const { MigrationCoordinator } = await import("@fusion/core");

      const { projects } = req.body as {
        projects: Array<{ path: string; name: string; isolationMode?: "in-process" | "child-process" }>;
      };

      if (!Array.isArray(projects)) {
        throw badRequest("projects must be an array");
      }

      const central = options?.centralCore ?? new CentralCore();
      const shouldClose = !options?.centralCore;

      if (shouldClose || (typeof central.isInitialized === "function" && !central.isInitialized())) {
        await central.init();
      }

      try {
        const coordinator = new MigrationCoordinator(central);
        const result = await coordinator.completeSetup(projects);

        res.json({
          success: result.success,
          projectsRegistered: result.projectsRegistered,
          errors: result.errors,
        });
      } finally {
        if (shouldClose) {
          await central.close();
        }
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Dev server mount intentionally stays in this late position to keep route
  // precedence unchanged relative to existing wildcard handlers.
  registerIntegratedDevServerRouter({ router, store });

  // Scripts and messaging routes are registered by registerMessagingScriptRoutes().

  router.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    if (err instanceof ApiError) {
      sendErrorResponse(res, err.statusCode, err.message, { details: err.details });
      return;
    }

    if (err instanceof Error) {
      sendErrorResponse(res, 500, err.message);
      return;
    }

    sendErrorResponse(res, 500, "Internal server error");
  });


  // ── Skills Routes ──────────────────────────────────────────────────────────

  registerAgentSkillsRoutes(routeContext);

  // Remote node proxy routes stay last so explicit handlers always precede
  // the wildcard /proxy/:nodeId/{*splat} route in Express match order.
  registerProxyRoutes(router, { store, runtimeLogger });

  (router as Router & { dispose?: () => void }).dispose = dispose;
  return router;
}

// ── Automation step helpers ─────────────────────────────────────────

/**
 * Validate an array of automation steps.
 * Returns an error string if invalid, or null if valid.
 */
function validateAutomationSteps(steps: unknown[]): string | null {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as Record<string, unknown>;
    if (!step.id || typeof step.id !== "string") {
      return `Step ${i + 1}: id is required`;
    }
    if (!step.type || (step.type !== "command" && step.type !== "ai-prompt" && step.type !== "create-task")) {
      return `Step ${i + 1}: type must be "command", "ai-prompt", or "create-task"`;
    }
    if (!step.name || typeof step.name !== "string" || !step.name.trim()) {
      return `Step ${i + 1}: name is required`;
    }
    if (step.type === "command") {
      if (!step.command || typeof step.command !== "string" || !step.command.trim()) {
        return `Step ${i + 1}: command is required for command steps`;
      }
    }
    if (step.type === "ai-prompt") {
      if (!step.prompt || typeof step.prompt !== "string" || !step.prompt.trim()) {
        return `Step ${i + 1}: prompt is required for ai-prompt steps`;
      }
    }
    if (step.type === "create-task") {
      if (!step.taskDescription || typeof step.taskDescription !== "string" || !step.taskDescription.trim()) {
        return `Step ${i + 1}: taskDescription is required for create-task steps`;
      }
    }
    // Validate model fields are both present or both absent
    const hasProvider = step.modelProvider && typeof step.modelProvider === "string";
    const hasModelId = step.modelId && typeof step.modelId === "string";
    if ((hasProvider && !hasModelId) || (!hasProvider && hasModelId)) {
      return `Step ${i + 1}: modelProvider and modelId must both be present or both absent`;
    }
  }
  return null;
}

const DEFAULT_AUTOMATION_TIMEOUT_MS = 5 * 60 * 1000;
const AUTOMATION_MAX_BUFFER = 1024 * 1024;
const AUTOMATION_MAX_OUTPUT = 10240;
const MANUAL_RUN_AI_SYSTEM_PROMPT = [
  "You are an AI automation agent executing a scheduled task.",
  "You have read-only access to the project files.",
  "Execute the prompt precisely and return concise, structured results.",
  "When analyzing code or data, provide actionable summaries.",
].join("\n");

function truncateAutomationOutput(stdout: string, stderr: string): string {
  let output = stdout;
  if (stderr) {
    output += stdout ? "\n--- stderr ---\n" : "";
    output += stderr;
  }
  if (output.length > AUTOMATION_MAX_OUTPUT) {
    return output.slice(0, AUTOMATION_MAX_OUTPUT) + "\n[output truncated]";
  }
  return output;
}

/**
 * Execute a single shell command (used by manual run endpoint).
 */
async function executeSingleCommand(
  command: string,
  timeoutMs: number | undefined,
  startedAt: string,
): Promise<import("@fusion/core").AutomationRunResult> {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsyncFn = promisify(exec);

  const isWindows = process.platform === "win32";

  try {
    const { stdout, stderr } = await execAsyncFn(command, {
      timeout: timeoutMs ?? DEFAULT_AUTOMATION_TIMEOUT_MS,
      maxBuffer: AUTOMATION_MAX_BUFFER,
      shell: isWindows ? "cmd.exe" : "/bin/sh",
    });

    return {
      success: true,
      output: truncateAutomationOutput(stdout, stderr),
      startedAt,
      completedAt: new Date().toISOString(),
    };
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    const execErr = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };

    return {
      success: false,
      output: truncateAutomationOutput(execErr.stdout ?? "", execErr.stderr ?? ""),
      error: execErr.killed
        ? `Command timed out after ${(timeoutMs ?? DEFAULT_AUTOMATION_TIMEOUT_MS) / 1000}s`
        : (err instanceof Error ? err.message : String(err)),
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
}

async function executeAiPromptStep(
  step: import("@fusion/core").AutomationStep,
  timeoutMs: number,
  startedAt: string,
  taskStore: TaskStore,
): Promise<import("@fusion/core").AutomationStepResult> {
  if (!step.prompt?.trim()) {
    return {
      stepId: step.id,
      stepName: step.name,
      stepIndex: 0,
      success: false,
      output: "",
      error: "AI prompt step has no prompt specified",
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  const { createFnAgent, promptWithFallback } = await import("@fusion/engine");
  const settings = await taskStore.getSettings();
  const defaultModel = resolveProjectDefaultModel(settings);
  const modelProvider = step.modelProvider?.trim() || defaultModel.provider;
  const modelId = step.modelId?.trim() || defaultModel.modelId;
  let responseText = "";

  const { session } = await createFnAgent({
    cwd: process.cwd(),
    systemPrompt: MANUAL_RUN_AI_SYSTEM_PROMPT,
    tools: "readonly",
    defaultProvider: modelProvider,
    defaultModelId: modelId,
    onText: (delta: string) => {
      responseText += delta;
    },
  });

  try {
    const promptPromise = promptWithFallback(session, step.prompt);
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`AI prompt step timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    });

    await Promise.race([promptPromise, timeoutPromise]);

    return {
      stepId: step.id,
      stepName: step.name,
      stepIndex: 0,
      success: true,
      output: responseText.length > AUTOMATION_MAX_OUTPUT
        ? responseText.slice(0, AUTOMATION_MAX_OUTPUT) + "\n[output truncated]"
        : responseText,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  } catch (err: unknown) {
    return {
      stepId: step.id,
      stepName: step.name,
      stepIndex: 0,
      success: false,
      output: "",
      error: err instanceof Error ? err.message : String(err),
      startedAt,
      completedAt: new Date().toISOString(),
    };
  } finally {
    try {
      session.dispose();
    } catch {
      // best-effort cleanup
    }
  }
}

async function executeCreateTaskStep(
  step: import("@fusion/core").AutomationStep,
  startedAt: string,
  taskStore: TaskStore,
): Promise<import("@fusion/core").AutomationStepResult> {
  if (!step.taskDescription?.trim()) {
    return {
      stepId: step.id,
      stepName: step.name,
      stepIndex: 0,
      success: false,
      output: "",
      error: "Create-task step has no task description specified",
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  try {
    const task = await taskStore.createTask({
      title: step.taskTitle?.trim() || undefined,
      description: step.taskDescription.trim(),
      column: (step.taskColumn as import("@fusion/core").Column) || "triage",
      modelProvider: step.modelProvider?.trim() || undefined,
      modelId: step.modelId?.trim() || undefined,
    });

    return {
      stepId: step.id,
      stepName: step.name,
      stepIndex: 0,
      success: true,
      output: `Created task ${task.id}: ${task.title || task.description.slice(0, 80)}`,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  } catch (err: unknown) {
    return {
      stepId: step.id,
      stepName: step.name,
      stepIndex: 0,
      success: false,
      output: "",
      error: err instanceof Error ? err.message : String(err),
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
}

/**
 * Execute all steps in a multi-step schedule (used by manual run endpoint).
 */
async function executeScheduleSteps(
  schedule: import("@fusion/core").ScheduledTask,
  startedAt: string,
  taskStore: TaskStore,
): Promise<import("@fusion/core").AutomationRunResult> {
  const steps = schedule.steps!;
  const stepResults: import("@fusion/core").AutomationStepResult[] = [];
  let overallSuccess = true;
  let stoppedEarly = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepStartedAt = new Date().toISOString();
    const timeoutMs = step.timeoutMs ?? schedule.timeoutMs ?? DEFAULT_AUTOMATION_TIMEOUT_MS;

    let stepResult: import("@fusion/core").AutomationStepResult;

    if (step.type === "command") {
      const cmdResult = await executeSingleCommand(step.command ?? "", timeoutMs, stepStartedAt);
      stepResult = {
        stepId: step.id,
        stepName: step.name,
        stepIndex: i,
        success: cmdResult.success,
        output: cmdResult.output,
        error: cmdResult.error,
        startedAt: stepStartedAt,
        completedAt: cmdResult.completedAt,
      };
    } else if (step.type === "ai-prompt") {
      stepResult = await executeAiPromptStep(step, timeoutMs, stepStartedAt, taskStore);
      stepResult.stepIndex = i;
    } else if (step.type === "create-task") {
      stepResult = await executeCreateTaskStep(step, stepStartedAt, taskStore);
      stepResult.stepIndex = i;
    } else {
      stepResult = {
        stepId: step.id,
        stepName: step.name,
        stepIndex: i,
        success: false,
        output: "",
        error: `Unknown step type: "${step.type}"`,
        startedAt: stepStartedAt,
        completedAt: new Date().toISOString(),
      };
    }

    stepResults.push(stepResult);

    if (!stepResult.success) {
      overallSuccess = false;
      if (!step.continueOnFailure) {
        stoppedEarly = true;
        break;
      }
    }
  }

  // Aggregate output
  const outputParts: string[] = [];
  for (const sr of stepResults) {
    outputParts.push(`=== Step ${sr.stepIndex + 1}: ${sr.stepName} (${sr.success ? "success" : "FAILED"}) ===`);
    if (sr.output) outputParts.push(sr.output);
    if (sr.error) outputParts.push(`Error: ${sr.error}`);
  }
  let output = outputParts.join("\n");
  if (output.length > AUTOMATION_MAX_OUTPUT) {
    output = output.slice(0, AUTOMATION_MAX_OUTPUT) + "\n[output truncated]";
  }

  const failedSteps = stepResults.filter((sr) => !sr.success);
  const error = failedSteps.length > 0
    ? `${failedSteps.length} step(s) failed: ${failedSteps.map((s) => s.stepName).join(", ")}${stoppedEarly ? " (execution stopped)" : ""}`
    : undefined;

  return {
    success: overallSuccess,
    output,
    error,
    startedAt,
    completedAt: new Date().toISOString(),
    stepResults,
  };
}
