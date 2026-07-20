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

import type { AnthropicProviderRegistration, TaskStore, ModelPreset, McpServerDefinition, ThinkingLevel } from "@fusion/core";
import {
  type Task,
  type PiExtensionEntry,
  type PiExtensionSettings,
  THINKING_LEVELS,
  MemoryBackendError,
  discoverPiExtensions,
  getFusionAgentDir,
  getLegacyPiAgentDir,
  listAgentMemoryFiles,
  readAgentMemoryFile,
  writeAgentMemoryFile,
  validateMcpServerDefinitionDetailed,
} from "@fusion/core";
import type { ServerOptions } from "./server.js";
import { SESSION_CLEANUP_DEFAULT_MAX_AGE_MS, type AiSessionType } from "./ai-session-store.js";
import { getSession as getPlanningSession, cleanupSession as cleanupPlanningSession, normalizePlanningSummaryPayload } from "./planning.js";
import { getSubtaskSession, cleanupSubtaskSession } from "./subtask-breakdown.js";
import { getMissionInterviewSession, cleanupMissionInterviewSession } from "./mission-interview.js";
import { getTargetInterviewSession, cleanupTargetInterviewSession } from "./milestone-slice-interview.js";
import { writeSSEEvent } from "./sse-buffer.js";
import {
  ApiError,
  badRequest,
  notFound,
  rethrowAsApiError,
  sendErrorResponse,
  unauthorized,
} from "./api-error.js";
import { createPluginRouter } from "./plugin-routes.js";
import { createApiRoutesContext } from "./routes/context.js";
import { createRegistrarMounter } from "./routes/create-api-routes-mount-sequence.js";
import { registerTaskWorkflowRoutes } from "./routes/register-task-workflow-routes.js";
import { registerWorkflowRoutes } from "./routes/register-workflow-routes.js";
import { registerPlanningSubtaskRoutes } from "./routes/register-planning-subtask-routes.js";
import { registerChatRoutes } from "./routes/register-chat-routes.js";
import { registerChatRoomRoutes } from "./routes/register-chat-room-routes.js";
import { registerSettingsMemoryRoutes } from "./routes/register-settings-memory-routes.js";
import { registerSecretsRoutes } from "./routes/register-secrets-routes.js";
import { registerMessagingScriptRoutes } from "./routes/register-messaging-scripts.js";
import { registerGitGitHubRoutes } from "./routes/register-git-github.js";
import { registerGitLabRoutes } from "./routes/register-gitlab.js";
import { registerFilesTerminalWorkspaceRoutes } from "./routes/register-files-terminal-workspaces.js";
import { registerAgentsProjectsNodesRoutes } from "./routes/register-agents-projects-nodes.js";
import { registerProjectRoutes } from "./routes/register-project-routes.js";
import { registerNodeRoutes } from "./routes/register-node-routes.js";
import { registerDockerNodeRoutes } from "./routes/register-docker-node-routes.js";
import { registerDockerProvisioningRoutes } from "./routes/register-docker-provisioning-routes.js";
import { registerSettingsSyncRoutes } from "./routes/register-settings-sync-routes.js";
import { registerSecretsSyncRoutes } from "./routes/register-secrets-sync-routes.js";
import { registerMeshRoutes } from "./routes/register-mesh-routes.js";
import { registerDiscoveryRoutes } from "./routes/register-discovery-routes.js";
import { registerSettingsSyncInboundRoutes } from "./routes/register-settings-sync-inbound-routes.js";
import { registerSecretsSyncInboundRoutes } from "./routes/register-secrets-sync-inbound-routes.js";
import { registerAgentCoreListCreateRoutes, registerAgentCoreRoutes } from "./routes/register-agent-core-routes.js";
import { registerAgentRuntimeRoutes } from "./routes/register-agent-runtime-routes.js";
import { registerAgentReflectionRatingRoutes } from "./routes/register-agent-reflection-rating-routes.js";
import { registerAgentImportExportRoutes, registerAgentGenerationRoutes } from "./routes/register-agent-import-export-generation-routes.js";
import { registerOrgPortabilityRoutes } from "./routes/register-org-portability-routes.js";
import { registerAgentSkillsRoutes } from "./routes/register-agent-skills-routes.js";
import { registerPluginsAutomationRoutes } from "./routes/register-plugins-automation.js";
import { registerProxyRoutes } from "./routes/register-proxy-routes.js";
import { registerModelRoutes } from "./routes/register-model-routes.js";
import { registerCustomProviderRoutes } from "./routes/register-custom-provider-routes.js";
import { registerUsageRoutes } from "./routes/register-usage-routes.js";
import { registerCommandCenterRoutes } from "./routes/register-command-center-routes.js";
import { registerKnowledgeRoutes } from "./routes/register-knowledge-routes.js";
import { registerReportRoutes } from "./routes/register-report-routes.js";
import { registerSignalRoutes } from "./routes/register-signal-routes.js";
import { registerMonitorRoutes } from "./routes/monitor-routes.js";
import { registerAuthRoutes } from "./routes/register-auth-routes.js";
import { registerRuntimeProviderRoutes } from "./routes/register-runtime-provider-routes.js";
import { registerFnBinaryRoutes } from "./routes/register-fn-binary-routes.js";
import { registerUpdateCheckRoutes } from "./routes/register-update-check-routes.js";
import { registerDiagnosticsRoutes } from "./routes/register-diagnostics-routes.js";
import { registerSystemRoutes } from "./routes/register-system-routes.js";
import { registerCliAgentHooksRoute } from "./routes/cli-agent-hooks.js";
import { registerCliAgentSettingsRoutes } from "./routes/cli-agent-settings.js";
import { registerIntegratedRouters, registerIntegratedDevServerRouter } from "./routes/register-integrated-routers.js";
import { registerApprovalRoutes } from "./routes/register-approval-routes.js";
import { registerWorktrunkRoutes } from "./routes/register-worktrunk-routes.js";
import { registerSystemMaintenanceRoutes } from "./routes/register-system-maintenance-routes.js";
import { registerAiTextAssistantRoutes } from "./routes/register-ai-text-assistant-routes.js";
import { registerActivityLogRoutes, registerSetupActivityRoutes } from "./routes/register-setup-activity-routes.js";
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
 * Minimal interface matching pi 0.80.8+ ModelRuntime's ModelRegistry
 * compatibility facade. Avoids a direct dependency on the pi-coding-agent package.
 */
export interface ModelRegistryLike {
  /**
   * FNXC:ModelCatalog 2026-07-16-17:55:
   * pi 0.80.8 refreshes asynchronously, so the models endpoint must wait for it
   * before reading getAvailable() and surface any refresh failure to the caller.
   */
  refresh(): Promise<void>;
  /** Get models that have auth configured. */
  getAvailable(): Array<{ id: string; name: string; provider: string; reasoning: boolean; contextWindow: number }>;
  /** Optional pi ModelRegistry surface used for supplemental model registration. */
  getAll?: () => Array<{ id: string; name?: string; provider: string; reasoning?: boolean; input?: string[]; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }; contextWindow?: number; maxTokens?: number; compat?: unknown }>;
  /** Optional pi ModelRegistry surface used for supplemental model registration. */
  registerProvider?: (providerName: string, config: AnthropicProviderRegistration) => void;
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
      onDeviceCode?: (info: {
        userCode: string;
        verificationUri: string;
        intervalSeconds?: number;
        expiresInSeconds?: number;
      }) => void;
      onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
      onManualCodeInput?: () => Promise<string>;
      onProgress?: (message: string) => void;
      onSelect?: (prompt: { message: string; options: Array<{ id: string; label: string }> }) => Promise<string | undefined>;
      signal?: AbortSignal;
    },
  ): Promise<void>;
  logout(provider: string): Promise<void>;
  /** Get providers that accept API keys (non-OAuth). Returns provider id and name. */
  getApiKeyProviders?(): Array<{ id: string; name: string }>;
  /** Save an API key for a provider. Creates or overwrites the existing key. */
  setApiKey?(providerId: string, apiKey: string): Promise<void>;
  /** Remove the stored API key for a provider. No-op if not set. */
  clearApiKey?(providerId: string): Promise<void>;
  /** Check if a provider has an API key configured. */
  hasApiKey?(providerId: string): boolean;
  /** Get the configured API key for usage providers. */
  getApiKey?(providerId: string): string | null | undefined | Promise<string | null | undefined>;
  /** Get raw stored credentials for usage providers. */
  get?(providerId: string): { type?: string; key?: string; access?: string; refresh?: string; expires?: number; [key: string]: unknown } | null | undefined;
}

/*
FNXC:ArtifactRegistry 2026-07-11-10:20:
The multer ceiling only guards transport; the real per-type caps live in TaskStore.addAttachment (5MB non-video, 100MB video). Raised from 5MB so video attachments (screen recordings, demo reels) can reach the store at all.
*/
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB transport ceiling; store enforces per-type caps
});

// Async variants — sync fs.* on a settings route blocks every concurrent
// request. discoverDashboardPiExtensions is called from 3 settings endpoints,
// and the previous sync implementation paid 6+ blocking syscalls per call.
async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await nodeFs.promises.readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    // ENOENT, parse errors, etc. — treat as missing/empty.
    return {};
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await nodeFs.promises.access(path);
    return true;
  } catch {
    return false;
  }
}

function hasPackageManagerSettings(settings: Record<string, unknown>): boolean {
  return Array.isArray(settings.packages) || Array.isArray(settings.npmCommand);
}

async function getPiPackageManagerAgentDir(): Promise<string> {
  const fusionAgentDir = getFusionAgentDir();
  const legacyAgentDir = getLegacyPiAgentDir();
  const [fusionSettings, legacySettings, legacyExists, fusionExists] = await Promise.all([
    readJsonObject(join(fusionAgentDir, "settings.json")),
    readJsonObject(join(legacyAgentDir, "settings.json")),
    pathExists(legacyAgentDir),
    pathExists(fusionAgentDir),
  ]);

  if (hasPackageManagerSettings(fusionSettings) || !legacyExists) {
    return fusionAgentDir;
  }
  if (hasPackageManagerSettings(legacySettings)) {
    return legacyAgentDir;
  }
  return fusionExists ? fusionAgentDir : legacyAgentDir;
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
    const { DefaultPackageManager } = await import("@earendil-works/pi-coding-agent");
    const [agentDir, legacyGlobalSettings, fusionGlobalSettings, projectSettings] = await Promise.all([
      getPiPackageManagerAgentDir(),
      readJsonObject(join(getLegacyPiAgentDir(), "settings.json")),
      readJsonObject(join(getFusionAgentDir(), "settings.json")),
      readJsonObject(join(cwd, ".fusion", "settings.json")),
    ]);
    const globalSettings = { ...legacyGlobalSettings, ...fusionGlobalSettings };
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

import {
  createFnAgent as engineCreateFnAgentForRefine,
  getExemptToolNames as engineGetExemptToolNames,
  reloadExemptTools as engineReloadExemptTools,
  resolveIntegrationBranch,
  discoverMcpServers,
  resolveMcpServersForRuntime,
  resolveMcpServersForStore,
  validateMcpServer,
} from "@fusion/engine";

interface McpValidateRequestBody {
  name?: unknown;
  server?: unknown;
  definition?: unknown;
  timeoutMs?: unknown;
}

function parseMcpValidationTimeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw badRequest("timeoutMs must be a positive number when provided");
  }
  return Math.min(value, 30_000);
}

function parseMcpValidationBody(body: unknown): { name?: string; definition?: McpServerDefinition; timeoutMs?: number } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Request body must be an object");
  }

  const input = body as McpValidateRequestBody;
  const name = typeof input.name === "string" ? input.name.trim() : undefined;
  const rawDefinition = input.server ?? input.definition;
  if (!name && rawDefinition === undefined) {
    throw badRequest("Provide either name or server");
  }
  if (input.name !== undefined && !name) {
    throw badRequest("name must be a non-empty string when provided");
  }

  let definition: McpServerDefinition | undefined;
  if (rawDefinition !== undefined) {
    const parsed = validateMcpServerDefinitionDetailed(rawDefinition, "server");
    if (!parsed.value) {
      throw badRequest("Invalid MCP server definition", { errors: parsed.errors.map((error) => error.message) });
    }
    definition = parsed.value;
  }

  return { name, definition, timeoutMs: parseMcpValidationTimeout(input.timeoutMs) };
}

function parseMcpDiscoveryScope(value: unknown): "global" | "project" {
  if (value === undefined) return "project";
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === "global" || raw === "project") return raw;
  throw badRequest("scope must be either global or project");
}

function stripMcpSecretDescriptor(secret: { field: "env" | "headers" | "token"; key: string; suggestedKey: string; scope: "global" | "project" }) {
  return {
    field: secret.field,
    key: secret.key,
    suggestedKey: secret.suggestedKey,
    scope: secret.scope,
  };
}

async function resolveMcpServerForValidation(
  scopedStore: TaskStore,
  request: { name?: string; definition?: McpServerDefinition },
) {
  if (request.definition) {
    const secrets = await scopedStore.getSecretsStore();
    const resolved = await resolveMcpServersForRuntime({
      globalSettings: { mcpServers: { enabled: true, servers: [request.definition] } },
      projectSettings: undefined,
      secrets,
      reader: {},
    });
    if (resolved.errors.length > 0 || resolved.servers.length === 0) {
      throw badRequest("Unable to resolve MCP server secrets", { errors: resolved.errors.map((error) => ({ serverName: error.serverName, path: error.path, message: error.message })) });
    }
    return resolved.servers[0];
  }

  const resolved = await resolveMcpServersForStore(scopedStore);
  const server = resolved.servers.find((candidate) => candidate.name === request.name);
  if (!server) {
    throw badRequest("MCP server was not found or could not be resolved");
  }
  return server;
}

// Test-injectable override; defaults to the statically imported engine binding.
let createFnAgentForRefine: typeof import("@fusion/engine").createFnAgent | undefined = engineCreateFnAgentForRefine;

/** @internal Inject a mock createFnAgent function for workflow-step refine route tests. */
export function __setCreateFnAgentForRefine(mock: typeof createFnAgentForRefine): void {
  createFnAgentForRefine = mock;
}

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

function sanitizeBooleanSetting(name: string, value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw badRequest(`${name} must be a boolean`);
  }
  return value;
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
export type RunAuditDomainFilter = "database" | "git" | "filesystem" | "sandbox";

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
  /** Domain category: database, git, filesystem, or sandbox */
  domain: "database" | "git" | "filesystem" | "sandbox";
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
 * Response shape for GET /api/tasks/:id/runtime-fallback
 *
 * Normalized view of the most recent "session:runtime-resolved" run-audit
 * event for a task, used to drive the dashboard's runtime-fallback
 * badge/toast affordance. `showFallbackBadge` is the single field UI
 * consumers should branch on: true only when the latest resolution had
 * `wasConfigured: false` for a non-empty configured `runtimeHint`.
 */
export interface TaskRuntimeFallbackResponse {
  taskId: string;
  /** Whether any session:runtime-resolved audit event exists for this task yet. */
  hasEvent: boolean;
  /** Whether the resolved runtime matched an explicitly configured hint. Null when hasEvent is false. */
  wasConfigured: boolean | null;
  /** The configured runtime hint from the most recent event, or null when absent/blank. */
  runtimeHint: string | null;
  /** FallbackReason ("not_found" | "factory_error" | "init_error") when wasConfigured is false, else null. */
  reason: string | null;
  /** Audit event ID, usable as a stable dedupe key for one-shot toasts. */
  eventId: string | null;
  /** ISO-8601 timestamp of the most recent event. */
  timestamp: string | null;
  /** True only when wasConfigured === false AND runtimeHint is non-empty. */
  showFallbackBadge: boolean;
}

/**
 * Response shape for GET /api/agents/:id/runs/:runId/cited-goals
 */
export interface RunCitedGoalsResponse {
  runId: string;
  taskId?: string;
  injectedGoalIds: string[];
  retrievedGoalIds: string[];
  citedGoalIds: string[];
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
    sandbox: NormalizedRunAuditEvent[];
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
    if (domain !== "database" && domain !== "git" && domain !== "filesystem" && domain !== "sandbox") {
      throw new ApiError(400, "domain must be one of: database, git, filesystem, sandbox");
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
    case "sandbox":
      parts.push("Sandbox");
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

  const registrarMounter = createRegistrarMounter();

  // Get GitHub token from options or env
  const githubToken = options?.githubToken ?? process.env.GITHUB_TOKEN;
  const aiSessionStore = options?.aiSessionStore;

  const isGitRepo = async (cwd: string): Promise<boolean> => {
    try {
      await runGitCommand(["rev-parse", "--git-dir"], cwd, 5_000);
      return true;
    } catch {
      return false;
    }
  };

  /*
  FNXC:RouteModularity 2026-07-19-12:00:
  The runtime mounter enforces the canonical registrar order in
  routes/create-api-routes-mount-sequence.ts. Keep its documentation synchronized
  with routes/README.md when changing a precedence-sensitive registrar mount.
  */
  registrarMounter.mount("registerSettingsMemoryRoutes", () => registerSettingsMemoryRoutes(routeContext, {
    githubToken,
    validateModelPresets,
    sanitizeBooleanSetting,
    sanitizeOverlapIgnorePaths,
    discoverDashboardPiExtensions,
  }));
  registrarMounter.mount("registerSecretsRoutes", () => registerSecretsRoutes(routeContext));
  registrarMounter.mount("registerTaskWorkflowRoutes", () => registerTaskWorkflowRoutes(routeContext, {
    runtimeLogger,
    upload,
    taskDetailActivityLogLimit: TASK_DETAIL_ACTIVITY_LOG_LIMIT,
    validateOptionalModelField,
    normalizeModelSelectionPair,
    runGitCommand,
    isGitRepo,
    resolveIntegrationBranch: (rootDir, settings) => resolveIntegrationBranch(rootDir, settings as { integrationBranch?: string; baseBranch?: unknown } | null | undefined),
    trimTaskDetailActivityLog,
    triggerCommentWakeForAssignedAgent: (...args) => triggerCommentWakeForAssignedAgent(...args),
    resolveSelfHealingManager: (...args) => resolveSelfHealingManager(...args),
  }));
  registrarMounter.mount("registerWorkflowRoutes", () => registerWorkflowRoutes(routeContext));
  registrarMounter.mount("registerPlanningSubtaskRoutes", () => registerPlanningSubtaskRoutes(routeContext, {
    store,
    aiSessionStore,
    parseLastEventId,
    replayBufferedSSE,
  }));
  registrarMounter.mount("registerChatRoutes", () => registerChatRoutes(routeContext, {
    parseLastEventId,
    replayBufferedSSE,
    validateOptionalModelField,
    upload,
  }));
  registrarMounter.mount("registerChatRoomRoutes", () => registerChatRoomRoutes(routeContext, { upload }));
  registrarMounter.mount("registerMessagingScriptRoutes", () => registerMessagingScriptRoutes(routeContext));
  registrarMounter.mount("registerGitGitHubRoutes", () => registerGitGitHubRoutes(routeContext));
  registrarMounter.mount("registerGitLabRoutes", () => registerGitLabRoutes(routeContext));
  registrarMounter.mount("registerFilesTerminalWorkspaceRoutes", () => registerFilesTerminalWorkspaceRoutes(routeContext));
  registrarMounter.mount("registerAgentsProjectsNodesRoutes", () => registerAgentsProjectsNodesRoutes(routeContext));
  registrarMounter.mount("registerPluginsAutomationRoutes", () => registerPluginsAutomationRoutes(routeContext, { parseLastEventId, replayBufferedSSE, getCreateFnAgent: () => createFnAgentForRefine }));
  registrarMounter.mount("registerApprovalRoutes", () => registerApprovalRoutes(routeContext));
  registrarMounter.mount("registerWorktrunkRoutes", () => registerWorktrunkRoutes(routeContext));

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
   * Resolve the HeartbeatMonitor for the engine that owns the given scopedStore.
   *
   * In multi-project setups each ProjectEngine has its own HeartbeatMonitor.
   * This function walks all engines in the engineManager and returns the one
   * whose working directory matches the scopedStore's root.
   * Returns undefined when no matching engine is found.
   */
  function resolveHeartbeatMonitor(scopedStore: TaskStore): ServerOptions["heartbeatMonitor"] {
    const engineManager = options?.engineManager;
    if (!engineManager) return undefined;
    try {
      const storeRoot = resolve(scopedStore.getRootDir());
      for (const engine of engineManager.getAllEngines().values()) {
        if (resolve(engine.getWorkingDirectory()) === storeRoot) {
          return (engine.getHeartbeatMonitor() ?? undefined) as ServerOptions["heartbeatMonitor"];
        }
      }
    } catch {
      // path resolution failure — fall through
    }
    return undefined;
  }

  function resolveSelfHealingManager(scopedStore: TaskStore): ServerOptions["selfHealingManager"] {
    const configuredManager = options?.selfHealingManager;
    if (configuredManager) {
      if (!configuredManager.rootDir) {
        return configuredManager;
      }
      try {
        if (resolve(configuredManager.rootDir) === resolve(scopedStore.getRootDir())) {
          return configuredManager;
        }
      } catch {
        return configuredManager;
      }
    }

    const engineManager = options?.engineManager;
    if (!engineManager) return undefined;
    try {
      const storeRoot = resolve(scopedStore.getRootDir());
      for (const engine of engineManager.getAllEngines().values()) {
        if (resolve(engine.getWorkingDirectory()) === storeRoot) {
          const selfHealing = engine.getSelfHealingManager();
          if (!selfHealing) return undefined;
          return {
            rootDir: engine.getWorkingDirectory(),
            reconcileInReviewBranchRebind: selfHealing.reconcileInReviewBranchRebind.bind(selfHealing),
            getActiveMergeTaskId: selfHealing.getActiveMergeTaskId.bind(selfHealing),
            getStaleMergingStatusMinAgeMs: selfHealing.getStaleMergingStatusMinAgeMs.bind(selfHealing),
          };
        }
      }
    } catch {
      // path resolution failure — fall through
    }
    return undefined;
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

    // Resolve the correct HeartbeatMonitor for this project.
    const resolvedMonitor =
      isHeartbeatMonitorForProject(scopedStore)
        ? heartbeatMonitor
        : resolveHeartbeatMonitor(scopedStore);

    // Skip: no heartbeat executor available for this project
    if (!resolvedMonitor) {
      return;
    }

    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
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

    await resolvedMonitor.executeHeartbeat({
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

  router.get("/mcp/discovered", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const scope = parseMcpDiscoveryScope(req.query.scope);
      const [discovered, settingsByScope] = await Promise.all([
        discoverMcpServers({ scope, projectRootDir: scopedStore.getRootDir() }),
        scopedStore.getSettingsByScopeFast(),
      ]);
      const configured = new Set((scope === "global" ? settingsByScope.global.mcpServers?.servers : settingsByScope.project.mcpServers?.servers)?.map((server) => server.name) ?? []);
      /*
       * FNXC:McpConfig 2026-06-26-10:31:
       * The discovery API is read-only: it reports inert third-party MCP definitions for explicit user opt-in and strips plaintextValue before crossing the wire. The dashboard can create Fusion-managed secret references from these descriptors, but API clients never receive raw env/header/token material.
       */
      res.json({
        sources: discovered.sources,
        servers: discovered.servers.map((server) => ({
          source: server.source,
          definition: server.definition,
          alreadyConfigured: configured.has(server.definition.name),
          hasPlaintextSecrets: server.secretsToCreate.length > 0,
          secretDescriptors: server.secretsToCreate.map(stripMcpSecretDescriptor),
        })),
        errors: discovered.errors,
      });
    } catch (error) {
      rethrowAsApiError(error, "Failed to discover MCP servers");
    }
  });

  router.post("/mcp/validate", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const request = parseMcpValidationBody(req.body);
      const server = await resolveMcpServerForValidation(scopedStore, request);
      // FNXC:McpConfig 2026-06-25-23:38: The validation API materializes MCP secrets only for the bounded probe and returns only status metadata, never resolved env/header values.
      const result = await validateMcpServer(server, {
        timeoutMs: request.timeoutMs,
        cwd: scopedStore.getRootDir(),
      });
      res.json(result);
    } catch (error) {
      rethrowAsApiError(error, "Failed to validate MCP server");
    }
  });

  router.get("/pi-settings", async (_req, res) => {
    try {
      const { SettingsManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
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

      const { SettingsManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
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

      const { SettingsManager, DefaultPackageManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
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
      const { SettingsManager, DefaultPackageManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
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
   * POST /api/action-gate/reload
   * Reloads action-gate exempt tools from defaults or a provided override list.
   */
  router.post("/action-gate/reload", async (req, res) => {
    try {
      const body = (req.body && typeof req.body === "object") ? (req.body as Record<string, unknown>) : {};
      const hasTools = Object.hasOwn(body, "tools");
      if (hasTools) {
        const tools = body.tools;
        if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string")) {
          throw badRequest("Request body must provide tools as string[] when present");
        }
        engineReloadExemptTools(tools);
      } else {
        engineReloadExemptTools();
      }

      res.json({ ok: true, tools: engineGetExemptToolNames() });
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

  registrarMounter.mount("registerSystemMaintenanceRoutes", () => registerSystemMaintenanceRoutes(routeContext));

  // Models
  registrarMounter.mount("registerModelRoutes", () => registerModelRoutes(routeContext));
  registrarMounter.mount("registerCustomProviderRoutes", () => registerCustomProviderRoutes(routeContext));

  // ---------- Auth routes ----------
  registrarMounter.mount("registerAuthRoutes", () => registerAuthRoutes(routeContext));

  // ---------- Runtime-plugin probe routes (Hermes / OpenClaw / Paperclip) ----------
  registrarMounter.mount("registerRuntimeProviderRoutes", () => registerRuntimeProviderRoutes(routeContext));

  // ---------- CLI binary install / status routes ----------
  registrarMounter.mount("registerFnBinaryRoutes", () => registerFnBinaryRoutes(routeContext));

  registrarMounter.mount("registerAiTextAssistantRoutes", () => registerAiTextAssistantRoutes(routeContext));

  registrarMounter.mount("registerUsageRoutes", () => registerUsageRoutes(routeContext));
  /*
  FNXC:DashboardRoutes 2026-06-16-09:46:
  PR #1683 wires the Command Center / SDLC registrars into the dashboard router: U9 analytics+live, U14 knowledge index, U11 external-signal webhooks, U13 monitor ingest/metrics. All inherit the server-level daemon bearer auth and getScopedStore project scoping; the signal/monitor ingest paths add their own per-provider/ingest-secret verification on top — none is an unauthenticated task-creation endpoint.
  */
  // U9 — Command Center analytics + live snapshot endpoints. Thin adapters over
  // the core aggregators; inherit standard auth + getScopedStore project scoping.
  registrarMounter.mount("registerCommandCenterRoutes", () => registerCommandCenterRoutes(routeContext));
  // U14 — persistent knowledge index query + incremental-refresh endpoints.
  // Inherit standard auth + getScopedStore project scoping (same as U9); the
  // index holds sensitive repo/PR content so no endpoint is unauthenticated or
  // cross-project readable.
  registrarMounter.mount("registerKnowledgeRoutes", () => registerKnowledgeRoutes(routeContext));
  registrarMounter.mount("registerReportRoutes", () => registerReportRoutes({ ...routeContext, reportUpload: upload }));
  // U11 — inbound external signal webhooks (Sentry/Datadog/PagerDuty/generic).
  // Each route HMAC-verifies against a per-provider secret; never an
  // unauthenticated task-creation endpoint.
  registrarMounter.mount("registerSignalRoutes", () => registerSignalRoutes(routeContext));
  // U13 — Monitor stage: deployment + incident ingestion (bearer-token authed,
  // never unauthenticated) + MTTR/deploy/incident metrics read. Closes the loop
  // by opening storm-guarded fix tasks back in triage.
  registrarMounter.mount("registerMonitorRoutes", () => registerMonitorRoutes(routeContext));
  registrarMounter.mount("registerUpdateCheckRoutes", () => registerUpdateCheckRoutes(routeContext));
  registrarMounter.mount("registerDiagnosticsRoutes", () => registerDiagnosticsRoutes(routeContext));
  // CLI Agent Executor hook ingestion (U17) — per-session token auth, exempt from
  // the daemon bearer-token middleware (hook scripts only hold the session token).
  registrarMounter.mount("registerCliAgentHooksRoute", () => registerCliAgentHooksRoute(routeContext));

  // CLI Agent Executor adapter settings + autonomy approval (U15) — daemon-token
  // authed like the rest of /api (the approving principal is the token holder).
  registrarMounter.mount("registerCliAgentSettingsRoutes", () => registerCliAgentSettingsRoutes(routeContext));

  registrarMounter.mount("registerActivityLogRoutes", () => registerActivityLogRoutes(routeContext));

  // ── Workflow Step Templates (palette) ────────────────────────────────

  /*
  FNXC:WorkflowStepCRUD 2026-06-25-00:00:
  U5/U6 removed the legacy workflow-step management surface: the
  GET/POST/PATCH/DELETE `/workflow-steps` CRUD routes, the `/workflow-steps/:id/refine`
  route, and the `/workflow-step-templates/:id/create` route are gone (their Settings
  manager UI and the built-in step-template catalog were deleted). Workflow
  quality gates now live as graph optional-group nodes, authored in the workflow editor.
  Only the plugin-contributed step-template palette survives below.
  */

  /**
   * GET /api/workflow-step-templates
   * List the plugin-contributed workflow step templates that feed the workflow
   * editor's optional-group palette. The built-in step-template catalog
   * was deleted in U6, so only plugin templates remain.
   * Returns: { templates: WorkflowStepTemplate[] }
   */
  router.get("/workflow-step-templates", (_req, res) => {
    try {
      const pluginTemplates = options?.pluginRunner?.getPluginWorkflowStepTemplates?.() ?? [];
      res.json({ templates: pluginTemplates.map(({ template }) => template) });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.get("/plugin-workflow-step-templates", (_req, res) => {
    try {
      const templates = options?.pluginRunner?.getPluginWorkflowStepTemplates?.() ?? [];
      res.json({ templates });
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
  const UNRESOLVED_AGENT_TASK_COLUMN = "unresolved";

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
    // Batch lookup all unique taskIds to avoid per-task detail hydration.
    const taskIds = [...new Set(agents.map((a) => a.taskId).filter((id): id is string => id !== undefined))];

    let taskStatusMap = new Map<string, string>();
    try {
      taskStatusMap = await scopedStore.getTaskColumns(taskIds);
    } catch {
      // Lookup failed — treat all linked tasks as non-terminal (preserve taskId)
      taskStatusMap = new Map<string, string>();
    }

    return agents.map((agent) => {
      if (!agent.taskId) return agent;

      const taskStatus = taskStatusMap.get(agent.taskId);
      if (isTerminalTaskStatus(taskStatus)) {
        // Omit taskId for terminal tasks — use spread to create shallow copy without taskId
        const { taskId: _omitted, taskColumn: _taskColumnOmitted, ...sanitized } = agent;
        return sanitized as import("@fusion/core").Agent;
      }

      /*
       * FNXC:AgentTaskStateDrift 2026-06-27-16:20:
       * Dashboard agent surfaces show the linked task column so coordinators can tell legitimate triage/queued or active linkage apart from execution drift, matching the FN-7138 text-surface invariant.
       *
       * FNXC:AgentTaskStateDrift 2026-06-27-17:08:
       * Missing/deleted linked tasks and lookup failures must be explicit too; otherwise a stale task link is indistinguishable from an un-enriched dashboard response.
       */
      return { ...agent, taskColumn: taskStatus ?? UNRESOLVED_AGENT_TASK_COLUMN };
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
  registrarMounter.mount("registerAgentCoreListCreateRoutes", () => registerAgentCoreListCreateRoutes(routeContext, {
    sanitizeAgentTaskLinks,
    validateAgentInstructionsPayload,
    upload,
  }));

  registrarMounter.mount("registerAgentImportExportRoutes", () => registerAgentImportExportRoutes(routeContext));
  registrarMounter.mount("registerOrgPortabilityRoutes", () => registerOrgPortabilityRoutes(routeContext));

  registrarMounter.mount("registerAgentCoreRoutes", () => registerAgentCoreRoutes(routeContext, {
    sanitizeAgentTaskLinks,
    validateAgentInstructionsPayload,
    upload,
  }));

  registrarMounter.mount("registerAgentRuntimeRoutes", () => registerAgentRuntimeRoutes(routeContext, {
    validateAgentInstructionsPayload,
    serializeAccessState,
    hasHeartbeatExecutor,
    heartbeatMonitor,
    isHeartbeatMonitorForProject,
    resolveHeartbeatMonitor,
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
  }));

  // ── System Panel Routes (Command Center → System) ─────────────────────────
  // FNXC:SystemPanel 2026-07-12-11:25: operator restart/rebuild/logs/debug
  // controls. Registered here so the same heartbeat-monitor resolution used by
  // agent runtime routes powers "restart all agents".
  registrarMounter.mount("registerSystemRoutes", () => registerSystemRoutes(routeContext, {
    hasHeartbeatExecutor,
    heartbeatMonitor,
    isHeartbeatMonitorForProject,
    resolveHeartbeatMonitor,
  }));

  // ── Agent Reflection Routes ──────────────────────────────────────────────

  registrarMounter.mount("registerAgentReflectionRatingRoutes", () => registerAgentReflectionRatingRoutes(routeContext));

  registrarMounter.mount("registerAgentGenerationRoutes", () => registerAgentGenerationRoutes(routeContext));

  // ── Integrated domain routers ──────────────────────────────────────────────
  // Keep this call at the current position to preserve precedence with
  // surrounding route handlers. registerIntegratedRouters() mounts:
  // - /missions
  // - /insights
  // - /todos
  registrarMounter.mount("registerIntegratedRouters", () => registerIntegratedRouters({
    router,
    store,
    options,
    aiSessionStore,
  }));

  // ── AI Session Routes ─────────────────────────────────────────────────────

  /**
   * GET /api/ai-sessions
   * List background AI sessions. By default returns only active/retryable
   * statuses (generating, awaiting_input, error). Pass `includeCompleted=1`
   * to also include `complete` sessions — used by the planning sidebar so a
   * session that finished while the modal was closed remains selectable.
   * Pass `includeArchived=1` (only meaningful with `includeCompleted`) to
   * also surface sessions the user has explicitly archived.
   * Query: { projectId?, includeCompleted?, includeArchived?, type? }
   */
  router.get("/ai-sessions", async (req, res) => {
    if (!aiSessionStore) {
      res.json({ sessions: [] });
      return;
    }
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const includeCompleted =
      req.query.includeCompleted === "1" || req.query.includeCompleted === "true";
    const includeArchived =
      req.query.includeArchived === "1" || req.query.includeArchived === "true";
    const requestedType = typeof req.query.type === "string" ? req.query.type : undefined;
    const type = requestedType && ["planning", "subtask", "mission_interview", "milestone_interview", "slice_interview"].includes(requestedType)
      ? requestedType as AiSessionType
      : undefined;
    /*
    FNXC:PlanningMode 2026-07-15-00:00:
    FN-7994 lets the Planning sidebar request only planning summaries, avoiding
    non-planning inputPayload transfer. Invalid or absent values preserve the
    historical all-types response.
    */
    const sessions = includeCompleted
      ? await aiSessionStore.listAll(projectId, { includeArchived, type })
      : await aiSessionStore.listActive(projectId);
    res.json({ sessions });
  });

  /**
   * DELETE /api/ai-sessions/cleanup
   * Cleanup stale AI sessions with optional max-age override.
   */
  router.delete("/ai-sessions/cleanup", async (req, res) => {
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

    const result = await aiSessionStore.cleanupStaleSessions(maxAgeMs);
    res.json({
      ...result,
      maxAgeMs,
    });
  });

  /**
   * GET /api/ai-sessions/:id
   * Get full session state for modal reconnection.
   */
  router.get("/ai-sessions/:id", async (req, res) => {
    if (!aiSessionStore) {
      throw notFound("AI sessions not available");
    }
    const session = await aiSessionStore.get(req.params.id);
    if (!session) {
      throw notFound("Session not found");
    }
    if (session.type === "planning" && session.result) {
      try {
        res.json({
          ...session,
          result: JSON.stringify(normalizePlanningSummaryPayload(JSON.parse(session.result), {
            title: session.title,
            description: session.title,
          })),
        });
        return;
      } catch {
        // Preserve the existing invalid-result behavior for callers that can still recover client-side.
      }
    }
    res.json(session);
  });

  /**
   * POST /api/ai-sessions/:id/archive
   * Hide a completed/errored session from the planning sidebar without
   * deleting it. Only terminal sessions are archivable; archiving an
   * in-flight session is rejected so we don't orphan a live agent.
   */
  router.post("/ai-sessions/:id/archive", async (req, res) => {
    if (!aiSessionStore) {
      throw notFound("AI sessions not available");
    }
    const session = await aiSessionStore.get(req.params.id);
    if (!session) {
      throw notFound("Session not found");
    }
    if (session.status !== "complete" && session.status !== "error") {
      throw badRequest("Only completed or errored sessions can be archived");
    }
    await aiSessionStore.archive(req.params.id);
    const after = await aiSessionStore.get(req.params.id);
    res.json({ archived: Number(after?.archived ?? 0) === 1 });
  });

  /**
   * POST /api/ai-sessions/:id/unarchive
   * Restore a previously archived session.
   */
  router.post("/ai-sessions/:id/unarchive", async (req, res) => {
    if (!aiSessionStore) {
      throw notFound("AI sessions not available");
    }
    if (!(await aiSessionStore.get(req.params.id))) {
      throw notFound("Session not found");
    }
    await aiSessionStore.unarchive(req.params.id);
    const after = await aiSessionStore.get(req.params.id);
    res.json({ archived: Number(after?.archived ?? 0) === 1 });
  });

  /*
  FNXC:PlanningMultiTab 2026-07-14-00:00:
  The /ai-sessions/:id/lock, /lock/force, and /lock/beacon endpoints were removed along with
  the whole per-tab session-lock machinery. AI interview sessions (planning, subtask, mission,
  milestone) are multi-tab: the persisted session row is the shared source of truth and any
  tab may read and interact.
  */

  /**
   * POST /api/ai-sessions/:id/ping
   * Lightweight keep-alive touch for active AI sessions.
   */
  router.post("/ai-sessions/:id/ping", async (req, res) => {
    if (!aiSessionStore) {
      throw notFound("AI sessions not available");
    }

    const { id } = req.params;
    const updated = await aiSessionStore.ping(id);
    if (!updated) {
      throw notFound("Session not found");
    }

    res.json({ ok: true });
  });

  /**
   * PATCH /api/ai-sessions/:id/draft
   * Keep planning draft title/text synchronized while editing.
   * Body: { title: string, initialPlan: string, thinkingLevel?: ThinkingLevel }
   */
  router.patch("/ai-sessions/:id/draft", async (req, res) => {
    if (!aiSessionStore) {
      throw notFound("AI sessions not available");
    }

    const { id } = req.params;
    const session = await aiSessionStore.get(id);
    if (!session) {
      throw notFound("Session not found");
    }

    if (session.type !== "planning") {
      throw badRequest("Only planning sessions support draft updates");
    }

    const rawInitialPlan = typeof req.body?.initialPlan === "string" ? req.body.initialPlan : "";
    const initialPlan = rawInitialPlan.trim();

    if (!initialPlan) {
      throw badRequest("initialPlan is required");
    }

    // Optional model override — pair-validated. Either both fields are
    // strings (kept) or any other shape is dropped silently so a partial
    // payload doesn't end up half-set in the persisted draft.
    const rawProvider = typeof req.body?.modelProvider === "string" ? req.body.modelProvider.trim() : "";
    const rawModelId = typeof req.body?.modelId === "string" ? req.body.modelId.trim() : "";
    const modelProvider = rawProvider && rawModelId ? rawProvider : undefined;
    const modelId = rawProvider && rawModelId ? rawModelId : undefined;

    const thinkingLevel = req.body?.thinkingLevel;
    if (thinkingLevel !== undefined && !THINKING_LEVELS.includes(thinkingLevel as ThinkingLevel)) {
      throw badRequest("thinkingLevel must be one of: " + THINKING_LEVELS.join(", "));
    }

    const updated = await aiSessionStore.updateDraft(id, { initialPlan, modelProvider, modelId, thinkingLevel });
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
  router.delete("/ai-sessions/:id", async (req, res) => {
    if (!aiSessionStore) {
      throw notFound("AI sessions not available");
    }
    const { id } = req.params;
    const session = await aiSessionStore.get(id);
    if (!session) {
      throw notFound("Session not found");
    }

    let deletedByPlanningCleanup = false;
    try {
      if (await getPlanningSession(id)) {
        await cleanupPlanningSession(id);
        deletedByPlanningCleanup = true;
      }
    } catch {
      // Session may not belong to planning or may already be cleaned up.
    }

    if (!deletedByPlanningCleanup) {
      await aiSessionStore.delete(id);
    }

    try {
      if (await getSubtaskSession(id)) cleanupSubtaskSession(id);
    } catch {
      // Session may not belong to subtask breakdown or may already be cleaned up.
    }

    try {
      if (await getMissionInterviewSession(id)) cleanupMissionInterviewSession(id);
    } catch {
      // Session may not belong to mission interview or may already be cleaned up.
    }

    try {
      if (await getTargetInterviewSession(id)) cleanupTargetInterviewSession(id);
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
        // FNXC:GlobalDirGuard 2026-06-25-22:40: Node-aware proxy lookup uses GLOBAL central state — use getGlobalSettingsDir(), never getFusionDir() (project .fusion/), which spawns a stray per-project central DB and resets global settings.
        const central = new CentralCore(store.getGlobalSettingsDir());
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

  /**
   * POST /api/create-directory
   * Create a new directory at the specified path.
   * Body: { path: string }
   * Returns: { success: true, path: string }
   */
  router.post("/create-directory", async (req, res) => {
    try {
      const { resolve, isAbsolute } = await import("node:path");
      const { mkdir, stat } = await import("node:fs/promises");

      const rawPath = typeof req.body?.path === "string" ? req.body.path.trim() : "";
      if (!rawPath) {
        throw badRequest("Path is required");
      }

      // Validate: must be absolute, no .. traversal
      if (!isAbsolute(rawPath)) {
        throw badRequest("Path must be absolute");
      }
      if (rawPath.includes("..")) {
        throw badRequest("Path must not contain '..' traversal");
      }
      const resolvedPath = resolve(rawPath);

      // Check if path already exists
      try {
        const existingStat = await stat(resolvedPath);
        if (existingStat.isDirectory()) {
          throw badRequest("Directory already exists");
        }
        throw badRequest("A file already exists at this path");
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e.code !== "ENOENT") {
          throw err;
        }
        // ENOENT means it doesn't exist — proceed
      }

      // Ensure parent directory exists
      const { dirname } = await import("node:path");
      const parentPath = dirname(resolvedPath);
      try {
        const parentStat = await stat(parentPath);
        if (!parentStat.isDirectory()) {
          throw badRequest("Parent path is not a directory");
        }
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e.code === "ENOENT") {
          throw badRequest("Parent directory does not exist");
        }
        throw err;
      }

      // Create the directory
      try {
        await mkdir(resolvedPath);
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "EEXIST") {
          throw badRequest("Directory already exists");
        }
        if (e.code === "ENOENT") {
          throw badRequest("Parent directory does not exist");
        }
        if (e.code === "ENOTDIR") {
          throw badRequest("Parent path is not a directory");
        }
        throw err;
      }

      res.json({ success: true, path: resolvedPath });
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

  registrarMounter.mount("registerProjectRoutes", () => registerProjectRoutes(routeContext));

  // ── Node Management Routes (Multi-Node Support) ───────────────────────────

  registrarMounter.mount("registerNodeRoutes", () => registerNodeRoutes(routeContext));
  registrarMounter.mount("registerDockerNodeRoutes", () => registerDockerNodeRoutes(routeContext));
  registrarMounter.mount("registerDockerProvisioningRoutes", () => registerDockerProvisioningRoutes(routeContext));

  // ── Remote Node Settings Sync Routes ──────────────────────────────────────

  registrarMounter.mount("registerSettingsSyncRoutes", () => registerSettingsSyncRoutes(routeContext));
  registrarMounter.mount("registerSecretsSyncRoutes", () => registerSecretsSyncRoutes(routeContext));

  // ── Mesh Topology Routes ────────────────────────────────────────────────

  registrarMounter.mount("registerMeshRoutes", () => registerMeshRoutes(routeContext));

  // ── Node Discovery Routes (mDNS / DNS-SD) ────────────────────────────────

  registrarMounter.mount("registerDiscoveryRoutes", () => registerDiscoveryRoutes(routeContext));

  // ── Inbound Settings/Auth Sync Routes ─────────────────────────────────────

  registrarMounter.mount("registerSettingsSyncInboundRoutes", () => registerSettingsSyncInboundRoutes(routeContext));
  registrarMounter.mount("registerSecretsSyncInboundRoutes", () => registerSecretsSyncInboundRoutes(routeContext));

  registrarMounter.mount("registerSetupActivityRoutes", () => registerSetupActivityRoutes(routeContext));

  // Dev server mount intentionally stays in this late position to keep route
  // precedence unchanged relative to existing wildcard handlers.
  registrarMounter.mount("registerIntegratedDevServerRouter", () => registerIntegratedDevServerRouter({ router, store }));

  if (options?.pluginStore && options?.pluginLoader) {
    const pluginRunner = options.pluginRunner as Parameters<typeof createPluginRouter>[2];
    router.use(
      "/plugins",
      createPluginRouter(
        options.pluginStore,
        options.pluginLoader,
        pluginRunner,
        store,
      ),
    );
  }

  // Scripts and messaging routes are registered by registerMessagingScriptRoutes().

  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
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

  registrarMounter.mount("registerAgentSkillsRoutes", () => registerAgentSkillsRoutes(routeContext));

  // Remote node proxy routes stay last so explicit handlers always precede
  // the wildcard /proxy/:nodeId/{*splat} route in Express match order.
  registrarMounter.mount("registerProxyRoutes", () => registerProxyRoutes(router, { store, runtimeLogger }));

  registrarMounter.assertComplete();

  (router as Router & { dispose?: () => void }).dispose = dispose;
  return router;
}
