import { Router, type Request, type Response, type NextFunction } from "express";

// Extend Express Request to include rawBody property set by webhook middleware
declare module "express" {
  interface Request {
    rawBody?: Buffer;
  }
}
import multer from "multer";
import { resolve, sep, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import * as nodeFs from "node:fs";
import os from "node:os";
import v8 from "node:v8";

import type { AnthropicProviderRegistration, TaskStore, ScheduleType, ActivityEventType, ModelPreset, RoutineTriggerType, McpServerDefinition, ThinkingLevel } from "@fusion/core";
import {
  type Task,
  type PiExtensionEntry,
  type PiExtensionSettings,
  AutomationStore,
  AUTOMATION_SELECTABLE_TOOLS,
  THINKING_LEVELS,
  MemoryBackendError,
  RoutineStore,
  discoverPiExtensions,
  findVitestProcessIds,
  getAvailableMemoryBytes,
  getFusionAgentDir,
  getLegacyPiAgentDir,
  isWebhookTrigger,
  listAgentMemoryFiles,
  readAgentMemoryFile,
  resolvePluginEntryPath,
  resolveExecutionSettingsModel,
  resolveTitleSummarizerSettingsModel,
  resolveImportTranslateSettingsModel,
  writeAgentMemoryFile,
  validateMcpServerDefinitionDetailed,
} from "@fusion/core";
import type { ServerOptions } from "./server.js";
import { verifyWebhookSignature } from "./github-webhooks.js";
import { SESSION_CLEANUP_DEFAULT_MAX_AGE_MS, type AiSessionType } from "./ai-session-store.js";
import { getSession as getPlanningSession, cleanupSession as cleanupPlanningSession, normalizePlanningSummaryPayload } from "./planning.js";
import { getSubtaskSession, cleanupSubtaskSession } from "./subtask-breakdown.js";
import { getMissionInterviewSession, cleanupMissionInterviewSession } from "./mission-interview.js";
import { getTargetInterviewSession, cleanupTargetInterviewSession } from "./milestone-slice-interview.js";
import { SessionEventBuffer, writeSSEEvent } from "./sse-buffer.js";
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
import { createPluginRouter, resolvePluginManifest } from "./plugin-routes.js";
import { fetchFromRemoteNode } from "./routes/register-settings-sync-helpers.js";
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
const BUNDLED_PLUGIN_IDS = new Set([
  "fusion-plugin-dependency-graph",
  "fusion-plugin-reports",
  "fusion-plugin-whatsapp-chat",
  "fusion-plugin-roadmap",
  "fusion-plugin-hermes-runtime",
  "fusion-plugin-openclaw-runtime",
  "fusion-plugin-paperclip-runtime",
  "fusion-plugin-cursor-runtime",
  "fusion-plugin-grok-runtime",
  "fusion-plugin-claude-runtime",
  "fusion-plugin-omp-runtime",
  "fusion-plugin-cli-printing-press",
  "fusion-plugin-compound-engineering",
  "fusion-plugin-quality",
]);

function extractBundledPluginId(pathInput: string): string | null {
  const normalized = pathInput.replace(/\\/gu, "/").replace(/\/+$/u, "").trim();
  if (BUNDLED_PLUGIN_IDS.has(normalized)) {
    return normalized;
  }

  for (const pluginId of BUNDLED_PLUGIN_IDS) {
    if (normalized.endsWith(`/plugins/${pluginId}`)) {
      return pluginId;
    }
  }

  return null;
}

function resolveBundledPluginDirInDashboard(pluginId: string): string | null {
  const moduleDir = resolve(fileURLToPath(import.meta.url), "..");
  const dashboardPackageRoot = resolve(moduleDir, "..");
  const candidates = [
    join(dashboardPackageRoot, "dist", "plugins", pluginId),
    join(dashboardPackageRoot, "plugins", pluginId),
    join(dashboardPackageRoot, "..", "..", "plugins", pluginId),
  ];

  for (const candidate of candidates) {
    if (nodeFs.existsSync(join(candidate, "manifest.json"))) {
      return candidate;
    }
  }

  return null;
}

import { createSessionDiagnostics } from "./ai-session-diagnostics.js";
import { createApiRoutesContext } from "./routes/context.js";
import type { ScopeValue } from "./routes/types.js";
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
import { registerAgentSkillsRoutes } from "./routes/register-agent-skills-routes.js";
import { registerPluginsAutomationRoutes } from "./routes/register-plugins-automation.js";
import { registerProxyRoutes } from "./routes/register-proxy-routes.js";
import { registerModelRoutes } from "./routes/register-model-routes.js";
import { registerCustomProviderRoutes } from "./routes/register-custom-provider-routes.js";
import { registerUsageRoutes } from "./routes/register-usage-routes.js";
import { registerCommandCenterRoutes } from "./routes/register-command-center-routes.js";
import { registerKnowledgeRoutes } from "./routes/register-knowledge-routes.js";
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
  promptWithFallback as enginePromptWithFallback,
  reloadExemptTools as engineReloadExemptTools,
  resolveIntegrationBranch,
  discoverMcpServers,
  resolveMcpServersForRuntime,
  resolveMcpServersForStore,
  validateMcpServer,
  isInProcessBackupCommand,
  isInProcessMemoryBackupCommand,
  formatInProcessBackupError,
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

  const isGitRepo = async (cwd: string): Promise<boolean> => {
    try {
      await runGitCommand(["rev-parse", "--git-dir"], cwd, 5_000);
      return true;
    } catch {
      return false;
    }
  };

  // Registrar mount order is precedence-sensitive and mirrors
  // .fusion/tasks/FN-2541/route-order-blueprint.md.
  // Keep this sequence stable unless route-matching invariants are re-audited.
  registerSettingsMemoryRoutes(routeContext, {
    githubToken,
    validateModelPresets,
    sanitizeBooleanSetting,
    sanitizeOverlapIgnorePaths,
    discoverDashboardPiExtensions,
  });
  registerSecretsRoutes(routeContext);
  registerTaskWorkflowRoutes(routeContext, {
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
  });
  registerWorkflowRoutes(routeContext);
  registerPlanningSubtaskRoutes(routeContext, {
    store,
    aiSessionStore,
    parseLastEventId,
    replayBufferedSSE,
  });
  registerChatRoutes(routeContext, {
    parseLastEventId,
    replayBufferedSSE,
    validateOptionalModelField,
    upload,
  });
  registerChatRoomRoutes(routeContext, { upload });
  registerMessagingScriptRoutes(routeContext);
  registerGitGitHubRoutes(routeContext);
  registerGitLabRoutes(routeContext);
  registerFilesTerminalWorkspaceRoutes(routeContext);
  registerAgentsProjectsNodesRoutes(routeContext);
  registerPluginsAutomationRoutes(routeContext);
  registerApprovalRoutes(routeContext);
  registerWorktrunkRoutes(routeContext);

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

  let lastCpuUsageSample: NodeJS.CpuUsage | null = null;
  let lastCpuSampleAt: number | null = null;

  const getAppCpuPercent = (): number | null => {
    const currentCpuUsage = process.cpuUsage();
    const currentSampleAt = Date.now();

    if (lastCpuUsageSample === null || lastCpuSampleAt === null) {
      lastCpuUsageSample = { user: currentCpuUsage.user, system: currentCpuUsage.system };
      lastCpuSampleAt = currentSampleAt;
      return null;
    }

    const elapsedMs = currentSampleAt - lastCpuSampleAt;
    const cpuUsageDelta = process.cpuUsage(lastCpuUsageSample);

    lastCpuUsageSample = { user: currentCpuUsage.user, system: currentCpuUsage.system };
    lastCpuSampleAt = currentSampleAt;

    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
      return null;
    }

    const elapsedMicros = elapsedMs * 1_000;
    const usedMicros = cpuUsageDelta.user + cpuUsageDelta.system;
    if (!Number.isFinite(usedMicros) || usedMicros < 0) {
      return null;
    }

    return Math.max(0, Number(((usedMicros / elapsedMicros) * 100).toFixed(1)));
  };

  const getVitestProcessIds = async (): Promise<number[]> => {
    // Async pgrep/ps via findVitestProcessIds so the dashboard's event loop
    // stays responsive while the process table is walked. The helper filters
    // matches to actual node processes — a bare `pgrep -f vitest` also matches
    // wrapper shells, monitors, and editors whose command line merely mentions
    // vitest, and SIGKILLing those took out unrelated process trees
    // (2026-06-03 incident).
    return findVitestProcessIds();
  };

  const collectSystemStatsResponse = async (req: Request) => {
    const mem = process.memoryUsage();
    const heapStats = v8.getHeapStatistics();
    const load = os.loadavg();
    const vitestProcessIds = await getVitestProcessIds();
    const cpuPercent = getAppCpuPercent();

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
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
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

    return {
      systemStats: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        heapLimit: heapStats.heap_size_limit,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
        cpuPercent,
        loadAvg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
        cpuCount: os.cpus().length,
        systemTotalMem: os.totalmem(),
        /*
        FNXC:CommandCenter 2026-06-21-13:01:
        The public `systemFreeMem` field carries OS-available memory so SystemStatsArea derives Memory Used from reclaimable-aware bytes and matches Activity Monitor on macOS.
        */
        systemFreeMem: getAvailableMemoryBytes(),
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
    };
  };

  /**
   * GET /api/system-stats
   * Returns process/system metrics plus task and agent aggregates.
   */
  router.get("/system-stats", async (req, res) => {
    try {
      res.json(await collectSystemStatsResponse(req));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /*
  FNXC:CommandCenter 2026-06-21-00:00:
  The Command Center System area can view per-node stats by defaulting to this local process and proxying remote selections to the node's own /api/system-stats endpoint through the existing authenticated remote-node helper.
  Keep this route in routes.ts, rather than a domain registrar, because it intentionally reuses the local getAppCpuPercent/getVitestProcessIds closures and the shared local stats builder.
  */
  router.get("/nodes/:id/system-stats", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      let node: Awaited<ReturnType<typeof central.getNode>>;
      await central.init();
      try {
        node = await central.getNode(req.params.id);
      } finally {
        await central.close();
      }

      if (!node) {
        throw notFound("Node not found");
      }

      if (node.type === "local") {
        res.json(await collectSystemStatsResponse(req));
        return;
      }

      res.json(await fetchFromRemoteNode(node, "/api/system-stats"));
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

  // ── Maintenance Routes ─────────────────────────────────────────────

  /**
   * GET /api/maintenance/legacy-automerge-stamps
   * Dry-run the legacy auto-merge stamp cleanup and list candidates.
   */
  router.get("/maintenance/legacy-automerge-stamps", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const candidates = await scopedStore.reconcileLegacyAutoMergeStamps();
      res.json({ candidates, count: candidates.length });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to list legacy auto-merge stamps");
    }
  });

  /**
   * POST /api/maintenance/legacy-automerge-stamps/apply
   * Apply the legacy auto-merge stamp cleanup via the store-owned reconcile API.
   */
  router.post("/maintenance/legacy-automerge-stamps/apply", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const cleared = await scopedStore.reconcileLegacyAutoMergeStamps({ apply: true });
      res.json({ cleared, count: cleared.length });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to apply legacy auto-merge stamp cleanup");
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
      const { createBackupManager, resolveGlobalBackupRoot } = await import("@fusion/core");
      const settings = await scopedStore.getSettings();
      const manager = createBackupManager(resolveGlobalBackupRoot(scopedStore), settings);
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
      const { runBackupCommand, resolveGlobalBackupRoot } = await import("@fusion/core");
      const settings = await scopedStore.getSettings();
      const result = await runBackupCommand(resolveGlobalBackupRoot(scopedStore), settings);
      
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
  registerCustomProviderRoutes(routeContext);

  // ---------- Auth routes ----------
  registerAuthRoutes(routeContext);

  // ---------- Runtime-plugin probe routes (Hermes / OpenClaw / Paperclip) ----------
  registerRuntimeProviderRoutes(routeContext);

  // ---------- CLI binary install / status routes ----------
  registerFnBinaryRoutes(routeContext);

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
        scopedStore,
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
   * POST /api/ai/translate-text
   * AI-powered translation for GitHub/GitLab import preview title+body.
   * Body: { fields: { title?: string, body?: string }, targetLocale: string, sourceLocale?: string }
   * Returns: { fields: { title?: string, body?: string } }
   *
   * Rate limited: shared AI-helper budget (10 requests per hour per IP with refine/draft)
   *
   * FNXC:GitHubImportTranslate 2026-07-14-12:00:
   * Import Tasks offers on-demand translation when selected content is not the dashboard language.
   */
  router.post("/ai/translate-text", async (req, res) => {
    try {
      const { fields, targetLocale, sourceLocale } = req.body ?? {};
      const ip = req.ip || req.socket.remoteAddress || "unknown";

      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      const settings = await scopedStore.getSettings();

      const {
        validateTranslateRequest,
        checkRateLimit,
        getRateLimitResetTime,
        translateText,
        AiServiceError: _AiServiceErrorTranslate,
        ValidationError,
      } = await import("./ai-translate.js");

      if (!checkRateLimit(ip)) {
        const resetTime = getRateLimitResetTime(ip);
        throw rateLimited(
          `Rate limit exceeded. Maximum 10 AI helper requests per hour. Reset at ${resetTime?.toISOString() || "unknown"}`,
        );
      }

      let validated;
      try {
        validated = validateTranslateRequest(fields, targetLocale, sourceLocale);
      } catch (err) {
        if (err instanceof ValidationError) {
          throw badRequest(err instanceof Error ? err.message : String(err));
        }
        throw err;
      }

      /*
      FNXC:GitHubImportTranslate 2026-07-15-09:30:
      Manual (operator-clicked) translation resolves the same translate lane as auto-translation, so the model shown in Settings is the model that actually runs on both paths.
      */
      const resolvedTranslateModel = resolveImportTranslateSettingsModel(settings);
      const translated = await translateText(
        validated,
        rootDir,
        settings.promptOverrides,
        scopedStore,
        resolvedTranslateModel.provider,
        resolvedTranslateModel.modelId,
      );
      res.json({ fields: translated });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "RateLimitError") {
        throw rateLimited(err.message);
      } else if (err instanceof Error && err.name === "AiServiceError") {
        rethrowAsApiError(err, "AI service error");
      } else {
        rethrowAsApiError(err, "Failed to translate text");
      }
    }
  });

  /**
   * POST /api/ai/draft-goal-description
   * AI-powered goal description drafting from a goal title.
   * Body: { title: string }
   * Returns: { description: string }
   *
   * Rate limited: 10 requests per hour per IP
   */
  router.post("/ai/draft-goal-description", async (req, res) => {
    try {
      const { title } = req.body;
      const ip = req.ip || req.socket.remoteAddress || "unknown";

      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      const settings = await scopedStore.getSettings();

      const {
        validateGoalDraftRequest,
        checkRateLimit,
        getRateLimitResetTime,
        draftGoalDescription,
        RateLimitError: _RateLimitError4,
        ValidationError,
        AiServiceError: _AiServiceError2,
      } = await import("./ai-refine.js");

      if (!checkRateLimit(ip)) {
        const resetTime = getRateLimitResetTime(ip);
        throw rateLimited(`Rate limit exceeded. Maximum 10 draft requests per hour. Reset at ${resetTime?.toISOString() || "unknown"}`);
      }

      let validatedTitle: string;
      try {
        validatedTitle = validateGoalDraftRequest(title);
      } catch (err) {
        if (err instanceof ValidationError) {
          throw badRequest(err instanceof Error ? err.message : String(err));
        }
        throw err;
      }

      const description = await draftGoalDescription(validatedTitle, rootDir, settings.promptOverrides, scopedStore);
      res.json({ description });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "RateLimitError") {
        throw rateLimited(err.message);
      } else if (err instanceof Error && err.name === "AiServiceError") {
        rethrowAsApiError(err, "AI service error");
      } else {
        rethrowAsApiError(err, "Failed to draft goal description");
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
   * Long descriptions are accepted; core truncates model input before prompting.
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
  /*
  FNXC:DashboardRoutes 2026-06-16-09:46:
  PR #1683 wires the Command Center / SDLC registrars into the dashboard router: U9 analytics+live, U14 knowledge index, U11 external-signal webhooks, U13 monitor ingest/metrics. All inherit the server-level daemon bearer auth and getScopedStore project scoping; the signal/monitor ingest paths add their own per-provider/ingest-secret verification on top — none is an unauthenticated task-creation endpoint.
  */
  // U9 — Command Center analytics + live snapshot endpoints. Thin adapters over
  // the core aggregators; inherit standard auth + getScopedStore project scoping.
  registerCommandCenterRoutes(routeContext);
  // U14 — persistent knowledge index query + incremental-refresh endpoints.
  // Inherit standard auth + getScopedStore project scoping (same as U9); the
  // index holds sensitive repo/PR content so no endpoint is unauthenticated or
  // cross-project readable.
  registerKnowledgeRoutes(routeContext);
  // U11 — inbound external signal webhooks (Sentry/Datadog/PagerDuty/generic).
  // Each route HMAC-verifies against a per-provider secret; never an
  // unauthenticated task-creation endpoint.
  registerSignalRoutes(routeContext);
  // U13 — Monitor stage: deployment + incident ingestion (bearer-token authed,
  // never unauthenticated) + MTTR/deploy/incident metrics read. Closes the loop
  // by opening storm-guarded fix tasks back in triage.
  registerMonitorRoutes(routeContext);
  registerUpdateCheckRoutes(routeContext);
  registerDiagnosticsRoutes(routeContext);
  // CLI Agent Executor hook ingestion (U17) — per-session token auth, exempt from
  // the daemon bearer-token middleware (hook scripts only hold the session token).
  registerCliAgentHooksRoute(routeContext);

  // CLI Agent Executor adapter settings + autonomy approval (U15) — daemon-token
  // authed like the rest of /api (the approving principal is the token holder).
  registerCliAgentSettingsRoutes(routeContext);

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
    let liveRunId: string | undefined;

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const schedule = await automationStore.getSchedule(id);

      // Scope isolation: if scope is specified, verify the schedule belongs to that scope
      if (scope && schedule.scope !== scope) {
        throw notFound("Schedule not found");
      }

      const liveRun = automationLiveRuns.start(schedule.id);
      liveRunId = liveRun.runId;
      const liveCallbacks = createAutomationLiveRunCallbacks(liveRun.runId);
      const startedAt = new Date().toISOString();
      const scopedStore = await getScopedStore(req);
      let result: import("@fusion/core").AutomationRunResult;

      if (schedule.steps && schedule.steps.length > 0) {
        // Multi-step execution
        result = await executeScheduleSteps(schedule, startedAt, scopedStore, liveCallbacks);
      } else {
        // Legacy single-command execution
        // FNXC:Automations 2026-07-04-00:00:
        // FN-7537: command/backup runs (including the new in-process backup branch inside
        // executeSingleCommand) stream through the same onStep/onText live-run callbacks as every other
        // step type, so the live-output panel populates during the run (step-start immediately, output once
        // available) rather than only at the terminal `complete` event.
        liveCallbacks.onStep?.({ stepIndex: 0, stepId: "command", stepName: schedule.name, stepType: "command", status: "started" });
        result = await executeSingleCommand(schedule.command, schedule.timeoutMs, startedAt, scopedStore);
        liveCallbacks.onStep?.({ stepIndex: 0, stepId: "command", stepName: schedule.name, stepType: "command", status: "completed", success: result.success, error: result.error });
        if (result.output) liveCallbacks.onText?.(result.output);
      }

      // Record the result
      const updated = await automationStore.recordRun(schedule.id, result);
      automationLiveRuns.complete(liveRun.runId, result);
      res.json({ schedule: updated, result, liveRunId: liveRun.runId });
    } catch (err: unknown) {
      if (liveRunId) {
        automationLiveRuns.fail(liveRunId, err instanceof Error ? err.message : String(err));
      }
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Schedule not found");
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * FNXC:AutomationLiveOutput 2026-07-07-08:30 (FN-7663, follow-up from FN-7652):
   * `/automations/:id/run/stream` and `/routines/:id/run/stream` are otherwise-identical SSE
   * endpoints layered over the same `AutomationLiveRunRegistry` (`automationLiveRuns`). Before
   * this consolidation, each route carried its own copy of the header/replay/subscribe/teardown
   * logic — the FN-7652 live-output fix had to be applied twice, and any future fix could drift
   * between the two copies. This single generic factory is parameterized ONLY by what actually
   * differs between the two routes (store resolver, entity getter, not-found message) so a fix
   * to the streaming behavior is written once and applies to both endpoints.
   */
  function makeRunStreamHandler<TStore, TEntity extends { id: string; scope?: ScopeValue }>(config: {
    resolveStore: (req: Request, scope: ScopeValue | undefined) => TStore;
    getEntity: (store: TStore, id: string) => Promise<TEntity>;
    notFoundMessage: string;
  }): (req: Request, res: Response) => Promise<void> {
    const { resolveStore, getEntity, notFoundMessage } = config;
    return async (req: Request, res: Response) => {
      const scope = parseScopeParam(req);
      const store = resolveStore(req, scope);
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

      try {
        const entity = await getEntity(store, id);
        if (scope && entity.scope !== scope) {
          throw notFound(notFoundMessage);
        }

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
        res.write(": connected\n\n");

        const requestedRunId = typeof req.query.runId === "string" ? req.query.runId : undefined;
        const lastEventId = parseLastEventId(req);
        let unsubscribeRun: (() => void) | undefined;
        let unsubscribeStart: (() => void) | undefined;

        const attachRun = (run: AutomationLiveRunRecord) => {
          const buffered = automationLiveRuns.getBufferedEvents(run.runId, lastEventId ?? 0);
          if (!replayBufferedSSE(res, buffered)) {
            res.end();
            return;
          }
          if (run.status !== "running") {
            res.end();
            return;
          }
          unsubscribeRun = automationLiveRuns.subscribe(run.runId, (event, eventId) => {
            if (!writeSSEEvent(res, event.type, JSON.stringify(event.data ?? {}), eventId)) {
              unsubscribeRun?.();
              return;
            }
            if (event.type === "complete" || event.type === "error") {
              unsubscribeRun?.();
              res.end();
            }
          });
        };

        // FNXC:AutomationLiveOutput 2026-07-07-00:00 (FN-7652): no explicit runId means "attach me to
        // this request's own run" — use getForAutoAttach so a stale finished run from before this
        // trigger isn't mistaken for it (see AutomationLiveRunRegistry.getForAutoAttach).
        const existingRun = requestedRunId
          ? automationLiveRuns.get(requestedRunId, entity.id)
          : automationLiveRuns.getForAutoAttach(entity.id);
        if (existingRun) {
          attachRun(existingRun);
        } else if (requestedRunId) {
          writeSSEEvent(res, "error", JSON.stringify({ message: "Live run not found or expired", runId: requestedRunId }));
          res.end();
        } else {
          unsubscribeStart = automationLiveRuns.subscribeToScheduleStart(entity.id, (run) => {
            unsubscribeStart?.();
            attachRun(run);
          });
        }

        req.on("close", () => {
          unsubscribeRun?.();
          unsubscribeStart?.();
        });
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          throw err;
        }
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw notFound(notFoundMessage);
        }
        rethrowAsApiError(err);
      }
    };
  }

  // GET /automations/:id/run/stream — stream live manual-run output.
  router.get(
    "/automations/:id/run/stream",
    makeRunStreamHandler({
      resolveStore: resolveAutomationStore,
      getEntity: (store, id) => store.getSchedule(id),
      notFoundMessage: "Schedule not found",
    }),
  );

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

      const liveRun = automationLiveRuns.start(routine.id);
      const liveCallbacks = createAutomationLiveRunCallbacks(liveRun.runId);
      try {
        // Execute via RoutineRunner (persistence handled by RoutineRunner.completeRoutineExecution)
        const result = await routineRunner.triggerManual(id, liveCallbacks);
        const updated = await routineStore.getRoutine(id);
        automationLiveRuns.complete(liveRun.runId, result);
        res.json({ routine: updated, result, liveRunId: liveRun.runId });
      } catch (err) {
        automationLiveRuns.fail(liveRun.runId, err instanceof Error ? err.message : String(err));
        throw err;
      }
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

      const liveRun = automationLiveRuns.start(routine.id);
      const liveCallbacks = createAutomationLiveRunCallbacks(liveRun.runId);
      try {
        // Execute via RoutineRunner (persistence handled by RoutineRunner.completeRoutineExecution)
        const result = await routineRunner.triggerManual(id, liveCallbacks);
        const updated = await routineStore.getRoutine(id);
        automationLiveRuns.complete(liveRun.runId, result);
        res.json({ routine: updated, result, liveRunId: liveRun.runId });
      } catch (err) {
        automationLiveRuns.fail(liveRun.runId, err instanceof Error ? err.message : String(err));
        throw err;
      }
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

  // GET /routines/:id/run/stream — stream live manual routine output.
  router.get(
    "/routines/:id/run/stream",
    makeRunStreamHandler({
      resolveStore: resolveRoutineStore,
      getEntity: (store, id) => store.getRoutine(id),
      notFoundMessage: "Routine not found",
    }),
  );

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

      // Parse and validate limit. Omitted limit intentionally defaults to 100
      // to match the documented API contract and avoid unbounded history reads.
      let limit = 100;
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
  registerAgentCoreListCreateRoutes(routeContext, {
    sanitizeAgentTaskLinks,
    validateAgentInstructionsPayload,
    upload,
  });

  registerAgentImportExportRoutes(routeContext);

  registerAgentCoreRoutes(routeContext, {
    sanitizeAgentTaskLinks,
    validateAgentInstructionsPayload,
    upload,
  });

  registerAgentRuntimeRoutes(routeContext, {
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
  });

  // ── System Panel Routes (Command Center → System) ─────────────────────────
  // FNXC:SystemPanel 2026-07-12-11:25: operator restart/rebuild/logs/debug
  // controls. Registered here so the same heartbeat-monitor resolution used by
  // agent runtime routes powers "restart all agents".
  registerSystemRoutes(routeContext, {
    hasHeartbeatExecutor,
    heartbeatMonitor,
    isHeartbeatMonitorForProject,
    resolveHeartbeatMonitor,
  });

  // ── Agent Reflection Routes ──────────────────────────────────────────────

  registerAgentReflectionRatingRoutes(routeContext);

  registerAgentGenerationRoutes(routeContext);

  // ── Integrated domain routers ──────────────────────────────────────────────
  // Keep this call at the current position to preserve precedence with
  // surrounding route handlers. registerIntegratedRouters() mounts:
  // - /missions
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
    const normalizedSlots = slots
      .map((entry) => ({
        pluginId: entry.pluginId,
        slot: {
          ...entry.slot,
          surface: entry.slot.surface ?? (typeof entry.slot.slotId === "string" ? entry.slot.slotId : undefined),
          order: entry.slot.order ?? null,
        },
      }))
      .sort((a, b) => {
        const orderA = typeof a.slot.order === "number" ? a.slot.order : Number.MAX_SAFE_INTEGER;
        const orderB = typeof b.slot.order === "number" ? b.slot.order : Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        if (a.pluginId !== b.pluginId) return a.pluginId.localeCompare(b.pluginId);
        return String(a.slot.slotId).localeCompare(String(b.slot.slotId));
      });
    res.json(normalizedSlots);
  });

  /**
   * GET /api/plugins/ui-contributions
   * Get all structured UI contributions from active plugins.
   */
  router.get("/plugins/ui-contributions", async (_req: Request, res: Response) => {
    const contributions = options?.pluginLoader?.getPluginUiContributions() ?? [];
    const normalizedContributions = contributions
      .map((entry) => ({
        pluginId: entry.pluginId,
        contribution: {
          ...entry.contribution,
          order: entry.contribution.order ?? null,
        },
      }))
      .sort((a, b) => {
        const orderA = typeof a.contribution.order === "number" ? a.contribution.order : Number.MAX_SAFE_INTEGER;
        const orderB = typeof b.contribution.order === "number" ? b.contribution.order : Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        if (a.pluginId !== b.pluginId) return a.pluginId.localeCompare(b.pluginId);
        return a.contribution.contributionId.localeCompare(b.contribution.contributionId);
      });
    res.json(normalizedContributions);
  });


  /**
   * GET /api/plugins/dashboard-views
   * Get all plugin top-level dashboard view definitions from active plugins.
   * Returns aggregated array of { pluginId, view } objects.
   */
  router.get("/plugins/dashboard-views", async (_req: Request, res: Response) => {
    const views = await options?.pluginLoader?.getPluginDashboardViews() ?? [];
    res.json(views);
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
  router.get("/plugins/:id", async (req: Request, res: Response, next: NextFunction) => {
    // "registry" is a static sub-route (GET /plugins/registry) owned by the
    // plugin sub-router mounted further below. Because this generic ":id" route
    // is registered first, Express would otherwise match it for the literal
    // path "/plugins/registry" (id === "registry") and throw
    // 'Plugin "registry" not found', shadowing the real registry handler.
    // Fall through so the mounted sub-router can serve the registry listing.
    if (req.params.id === "registry") {
      next();
      return;
    }
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
      const isNotFoundError = err instanceof Error && (err instanceof Error ? err.message : String(err)).includes("not found");
      const isBundledFallback = BUNDLED_PLUGIN_RUNTIMES.some((r) => r.pluginId === id);
      if (isNotFoundError && isBundledFallback) {
        // Bundled runtime plugins can be surfaced in settings before they've
        // been lazily installed. Return empty defaults so cards can open.
        res.json({});
        return;
      }
      if (isNotFoundError) {
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

      const aiScanOnLoad = body.aiScanOnLoad;
      if (aiScanOnLoad !== undefined && typeof aiScanOnLoad !== "boolean") {
        throw badRequest("'aiScanOnLoad' must be a boolean when provided");
      }

      const requestPath = (body.path as string).trim();
      const absoluteRequestPath = isAbsolute(requestPath) ? requestPath : resolve(process.cwd(), requestPath);

      let manifestPathForInstall = absoluteRequestPath;
      let manifestResolutionError: ApiError | null = null;
      let attemptedBundledLookup = false;

      try {
        await resolvePluginManifest(manifestPathForInstall);
      } catch (err) {
        if (err instanceof ApiError && err.statusCode === 404) {
          manifestResolutionError = err;
          const bundledPluginId = extractBundledPluginId(requestPath) ?? extractBundledPluginId(absoluteRequestPath);
          if (bundledPluginId) {
            attemptedBundledLookup = true;
            const bundledPath = resolveBundledPluginDirInDashboard(bundledPluginId);
            if (bundledPath) {
              manifestPathForInstall = bundledPath;
            }
          }
        } else {
          throw err;
        }
      }

      if (manifestResolutionError && manifestPathForInstall === absoluteRequestPath) {
        if (attemptedBundledLookup) {
          throw notFound(
            `Plugin install path not found: ${requestPath}. `
            + "Checked resolved local path and bundled plugin locations.",
          );
        }
        throw manifestResolutionError;
      }

      // Resolve manifest — supports package root and dist-folder selections
      const { manifestDir, manifest } = await resolvePluginManifest(manifestPathForInstall);

      // Register the loadable entry FILE, not the package directory — Node ESM
      // cannot import directories, so the loader rejects directory paths.
      const entryPath = resolvePluginEntryPath(manifestDir);
      if (!entryPath) {
        throw badRequest(
          `Plugin at ${manifestDir} has no loadable entry file `
          + "(expected bundled.js, dist/index.js, or src/index.ts)",
        );
      }

      try {
        const plugin = await pluginStore.registerPlugin({
          manifest,
          path: entryPath,
          ...(typeof aiScanOnLoad === "boolean" ? { aiScanOnLoad } : {}),
        });

        // If enabled, try to load it. If load fails while aiScanOnLoad=true,
        // remove the new registration so install does not leave a broken record.
        if (plugin.enabled) {
          try {
            await options.pluginLoader.loadPlugin(plugin.id);
          } catch (loadErr) {
            if (plugin.aiScanOnLoad) {
              await pluginStore.unregisterPlugin(plugin.id);
              throw badRequest(loadErr instanceof Error ? loadErr.message : String(loadErr));
            }
            runtimeLogger.child("plugin-routes").error(`Failed to load plugin ${plugin.id}`, {
              error: loadErr instanceof Error ? loadErr.message : String(loadErr),
            });
          }
        }

        res.status(201).json(plugin);
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          throw err;
        }
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

    // Heal legacy registrations that stored the package directory instead of
    // a loadable entry file (Node ESM cannot import directories). Mirrors the
    // CLI's startup heal in ensureBundledPluginInstalled.
    try {
      if (nodeFs.statSync(plugin.path).isDirectory()) {
        const entryPath = resolvePluginEntryPath(plugin.path);
        if (entryPath) {
          plugin = await pluginStore.updatePlugin(id, { path: entryPath });
        }
      }
    } catch {
      // Path missing or unreadable — let loadPlugin surface the real error.
    }

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
   * PATCH /api/plugins/:id
   * Update plugin config.
   * Body: { aiScanOnLoad: boolean }
   */
  router.patch("/plugins/:id", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    if (!req.body || typeof req.body !== "object" || typeof (req.body as { aiScanOnLoad?: unknown }).aiScanOnLoad !== "boolean") {
      throw badRequest("Request body must be { aiScanOnLoad: boolean }");
    }

    try {
      const plugin = await pluginStore.updatePlugin(id, {
        aiScanOnLoad: (req.body as { aiScanOnLoad: boolean }).aiScanOnLoad,
      });
      res.json(plugin);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("not found")) {
        throw notFound(`Plugin "${id}" not found`);
      }
      throw internalError(err instanceof Error ? err.message : "Failed to update plugin");
    }
  });

  /**
   * POST /api/plugins/:id/rescan
   * Trigger a fresh plugin scan/load gate via reload or load flow.
   */
  router.post("/plugins/:id/rescan", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    let plugin: import("@fusion/core").PluginInstallation;
    try {
      plugin = await pluginStore.getPlugin(id);
    } catch {
      throw notFound(`Plugin "${id}" not found`);
    }

    if (!options?.pluginLoader) {
      throw internalError("Plugin loader not available");
    }

    try {
      if (plugin.state === "started" && options.pluginRunner?.reloadPlugin) {
        await options.pluginRunner.reloadPlugin(id);
      } else if (plugin.enabled) {
        await options.pluginLoader.loadPlugin(id);
      }
    } catch (reloadErr) {
      runtimeLogger.child("plugin-routes").error(`Failed to rescan plugin ${id}`, {
        error: reloadErr instanceof Error ? reloadErr.message : String(reloadErr),
      });
    }

    res.json(await pluginStore.getPlugin(id));
  });

  /**
   * GET /api/plugins/:id/setup-status
   * Check plugin setup status.
   */
  router.get("/plugins/:id/setup-status", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    let plugin: import("@fusion/core").PluginInstallation;
    try {
      plugin = await pluginStore.getPlugin(id);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("not found")) {
        throw notFound(`Plugin "${id}" not found`);
      }
      throw internalError(err instanceof Error ? err.message : "Unknown error");
    }

    if (!options?.pluginRunner?.checkPluginSetup || !options?.pluginRunner?.getPluginSetupInfo) {
      throw internalError("Plugin runner not available");
    }

    const setupInfo = options.pluginRunner.getPluginSetupInfo();
    const hasSetup = setupInfo.some((entry) => entry.pluginId === id);

    if (!hasSetup) {
      res.json({ hasSetup: false });
      return;
    }

    if (plugin.state !== "started") {
      res.json({
        hasSetup: true,
        setupCheckDeferred: true,
        deferredReason: "plugin-not-started",
        pluginState: plugin.state,
      });
      return;
    }

    const status = await options.pluginRunner.checkPluginSetup(id);
    res.json({ hasSetup: true, ...status });
  });

  /**
   * POST /api/plugins/:id/setup/install
   * Trigger plugin setup install hook.
   */
  router.post("/plugins/:id/setup/install", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    const plugin = await pluginStore.getPlugin(id);
    if (!plugin.enabled) {
      throw badRequest("Plugin must be enabled before setup install");
    }

    if (!options?.pluginRunner?.installPluginSetup || !options?.pluginRunner?.getPluginSetupInfo) {
      throw internalError("Plugin runner not available");
    }

    const setupInfo = options.pluginRunner.getPluginSetupInfo();
    const setup = setupInfo.find((entry) => entry.pluginId === id);
    if (!setup?.hooks.install) {
      throw badRequest("Plugin has no install hook");
    }

    const result = await options.pluginRunner.installPluginSetup(id);
    res.json(result ?? { success: true });
  });

  /**
   * POST /api/plugins/:id/setup/uninstall
   * Trigger plugin setup uninstall hook.
   */
  router.post("/plugins/:id/setup/uninstall", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    await pluginStore.getPlugin(id);

    if (!options?.pluginRunner?.uninstallPluginSetup || !options?.pluginRunner?.getPluginSetupInfo) {
      throw internalError("Plugin runner not available");
    }

    const setupInfo = options.pluginRunner.getPluginSetupInfo();
    const setup = setupInfo.find((entry) => entry.pluginId === id);
    if (!setup) {
      res.json({ success: true });
      return;
    }

    const result = await options.pluginRunner.uninstallPluginSetup(id);
    res.json(result ?? { success: true });
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

    // Auto-install bundled runtime plugins (Hermes/OpenClaw/Paperclip) on
    // first save. The Settings UI surfaces these as fallback cards before
    // they're actually registered, so the first PUT must lazily install them
    // rather than 404. The host (CLI) injects ensureBundledPluginInstalled
    // because dashboard doesn't know the on-disk bundle layout.
    const isBundledFallback = BUNDLED_PLUGIN_RUNTIMES.some((r) => r.pluginId === id);
    if (isBundledFallback && options?.ensureBundledPluginInstalled) {
      let alreadyRegistered = true;
      try {
        await pluginStore.getPlugin(id);
      } catch {
        alreadyRegistered = false;
      }
      if (!alreadyRegistered) {
        try {
          const installOk = await options.ensureBundledPluginInstalled(id);
          if (!installOk) {
            throw internalError(
              `Bundled plugin "${id}" is unavailable in this build and could not be auto-installed`,
            );
          }
        } catch (installErr) {
          if (installErr instanceof ApiError) {
            throw installErr;
          }
          throw internalError(
            `Failed to auto-install bundled plugin "${id}": ${installErr instanceof Error ? installErr.message : String(installErr)}`,
          );
        }
      }
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

  registerProjectRoutes(routeContext);

  // ── Node Management Routes (Multi-Node Support) ───────────────────────────

  registerNodeRoutes(routeContext);
  registerDockerNodeRoutes(routeContext);
  registerDockerProvisioningRoutes(routeContext);

  // ── Remote Node Settings Sync Routes ──────────────────────────────────────

  registerSettingsSyncRoutes(routeContext);
  registerSecretsSyncRoutes(routeContext);

  // ── Mesh Topology Routes ────────────────────────────────────────────────

  registerMeshRoutes(routeContext);

  // ── Node Discovery Routes (mDNS / DNS-SD) ────────────────────────────────

  registerDiscoveryRoutes(routeContext);

  // ── Inbound Settings/Auth Sync Routes ─────────────────────────────────────

  registerSettingsSyncInboundRoutes(routeContext);
  registerSecretsSyncInboundRoutes(routeContext);

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
      const liveCounts = await central.getLiveRunningAgentCounts();

      /*
      FNXC:GlobalConcurrencyControls 2026-06-26-17:22:
      The published global-concurrency route reads currentlyActive/projectsActive through CentralCore's live seam while preserving globalMaxConcurrent/queuedCount from slot bookkeeping. The dashboard-registered source only inspects already-open project stores, so this read stays side-effect-safe and never opens watchers or starts project runtimes.
      */
      const liveState = {
        ...state,
        currentlyActive: liveCounts.currentlyActive,
        projectsActive: liveCounts.projectsActive,
      };

      if (shouldClose) await central.close();
      
      res.json(liveState);
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
      let state: "fresh-install" | "setup-wizard" | "normal-operation" = detectedProjects.length > 0
        ? "setup-wizard"
        : "fresh-install";
      let projects: Array<{ id: string; name: string; path: string }> = [];
      let centralBackendAvailable = false;

      try {
        if (shouldClose || (typeof central.isInitialized === "function" && !central.isInitialized())) {
          await central.init();
        }
        centralBackendAvailable = true;
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
        // FNXC:PostgresProjectDiscovery 2026-07-14-17:30: Report PostgreSQL
        // central-registry availability, never legacy fusion-central.db presence.
        hasCentralDb: centralBackendAvailable,
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
      if (step.allowedTools !== undefined) {
        if (!Array.isArray(step.allowedTools)) {
          return `Step ${i + 1}: allowedTools must be an array when provided`;
        }
        const selectableTools = new Set(AUTOMATION_SELECTABLE_TOOLS.map((tool) => tool.toLowerCase()));
        for (const tool of step.allowedTools) {
          if (typeof tool !== "string" || !selectableTools.has(tool.trim().toLowerCase())) {
            return `Step ${i + 1}: allowedTools contains unknown tool "${String(tool)}"`;
          }
        }
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
    /*
    FNXC:Automations 2026-07-12-19:14:
    Schedule and routine AI-capable steps can persist an optional reasoning-effort override. Validate it against the central THINKING_LEVELS set so routes accept omission/inherit plus known levels and reject drift before JSON step storage.
    */
    if (step.thinkingLevel !== undefined) {
      if (typeof step.thinkingLevel !== "string" || !THINKING_LEVELS.includes(step.thinkingLevel as (typeof THINKING_LEVELS)[number])) {
        return `Step ${i + 1}: thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`;
      }
    }
  }
  return null;
}

const DEFAULT_AUTOMATION_TIMEOUT_MS = 5 * 60 * 1000;
const AUTOMATION_MAX_BUFFER = 1024 * 1024;
const AUTOMATION_MAX_OUTPUT = 10240;
const AUTOMATION_LIVE_RUN_TTL_MS = 60 * 1000;
const AUTOMATION_LIVE_EVENT_CAPACITY = 200;

type AutomationLiveRunStatus = "running" | "complete" | "error";
type AutomationLiveEvent = { type: string; data?: unknown };
type AutomationLiveRunCallbacks = {
  onStep?: (data: Record<string, unknown>) => void;
  onText?: (delta: string) => void;
  onToolStart?: (name: string, args?: Record<string, unknown>) => void;
  onToolEnd?: (name: string, isError: boolean, result?: unknown) => void;
};

type AutomationLiveRunRecord = {
  runId: string;
  scheduleId: string;
  status: AutomationLiveRunStatus;
  buffer: SessionEventBuffer;
  listeners: Set<(event: AutomationLiveEvent, eventId: number) => void>;
  output: string;
  cleanupTimer?: NodeJS.Timeout;
  /*
   * FNXC:AutomationLiveOutput 2026-07-07-00:00 (FN-7652):
   * Wall-clock start time (ms since epoch) used solely to decide whether a runId-less GET
   * .../run/stream request should auto-attach to this run (see getForAutoAttach). Distinct from the
   * result's own ISO `startedAt`/`completedAt` timestamps, which describe the automation's execution
   * window, not stream-attach freshness.
   */
  startedAt: number;
};

function createAutomationRunId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `automation-run-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function capAutomationLiveText(current: string, delta: string): { next: string; delta: string } {
  if (!delta) return { next: current, delta: "" };
  const remaining = AUTOMATION_MAX_OUTPUT - current.length;
  if (remaining <= 0) return { next: current, delta: "" };
  const marker = "\n[output truncated]";
  const cappedDelta = delta.length > remaining
    ? remaining > marker.length
      ? `${delta.slice(0, remaining - marker.length)}${marker}`
      : delta.slice(0, remaining)
    : delta;
  return { next: `${current}${cappedDelta}`, delta: cappedDelta };
}

function previewAutomationLiveValue(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text.length <= 1000) return value;
    return `${text.slice(0, 1000)}…`;
  } catch {
    return "[unserializable]";
  }
}

/*
FNXC:AutomationLiveOutput 2026-06-26-00:00:
Manual automation runs need replayable live output without changing the POST /run result contract. Keep events in memory by runId, let schedule streams wait for the next run, and expire completed buffers so missed EventSource clients do not leak registry entries.
*/
class AutomationLiveRunRegistry {
  private readonly runs = new Map<string, AutomationLiveRunRecord>();
  private readonly latestRunBySchedule = new Map<string, string>();
  private readonly scheduleStartListeners = new Map<string, Set<(run: AutomationLiveRunRecord) => void>>();

  /*
   * FNXC:AutomationLiveOutput 2026-07-07-00:00 (FN-7652):
   * A runId-less GET .../run/stream auto-attach must not pick up a run that finished well before this
   * specific trigger (e.g. the previous manual run for the same schedule/routine, still within the
   * AUTOMATION_LIVE_RUN_TTL_MS replay window). Auto-attaching to that stale run replays its own
   * (unrelated) terminal `complete`/`error` event onto a brand-new trigger's stream, which is exactly
   * the false "Run failed"-for-a-success-run bug (FN-7652). Bound how old a *finished* run may be and
   * still be auto-attached; a still-`running` run has no age limit since it IS the in-flight trigger.
   */
  private static readonly AUTO_ATTACH_STALE_WINDOW_MS = 10_000;

  start(scheduleId: string, runId = createAutomationRunId()): AutomationLiveRunRecord {
    const run: AutomationLiveRunRecord = {
      runId,
      scheduleId,
      status: "running",
      buffer: new SessionEventBuffer(AUTOMATION_LIVE_EVENT_CAPACITY),
      listeners: new Set(),
      output: "",
      startedAt: Date.now(),
    };
    this.runs.set(runId, run);
    this.latestRunBySchedule.set(scheduleId, runId);
    this.broadcast(runId, { type: "run", data: { runId, scheduleId, status: "running" } });
    const starters = this.scheduleStartListeners.get(scheduleId);
    if (starters) {
      for (const listener of [...starters]) listener(run);
    }
    return run;
  }

  get(runId: string | undefined, scheduleId: string): AutomationLiveRunRecord | undefined {
    if (runId) {
      const run = this.runs.get(runId);
      return run?.scheduleId === scheduleId ? run : undefined;
    }
    const latestRunId = this.latestRunBySchedule.get(scheduleId);
    return latestRunId ? this.runs.get(latestRunId) : undefined;
  }

  /*
   * FNXC:AutomationLiveOutput 2026-07-07-00:00 (FN-7652):
   * Used by GET .../run/stream instead of `get()` when the caller supplied no explicit runId. Returns
   * the latest run for the schedule/routine only when it is still live, or finished recently enough
   * (AUTO_ATTACH_STALE_WINDOW_MS) to plausibly be the run this very request is racing against.
   * Otherwise returns undefined so the caller falls back to `subscribeToScheduleStart` and waits for
   * its own fresh `run` event, instead of replaying an unrelated older run's terminal outcome.
   */
  getForAutoAttach(scheduleId: string): AutomationLiveRunRecord | undefined {
    const latestRunId = this.latestRunBySchedule.get(scheduleId);
    if (!latestRunId) return undefined;
    const run = this.runs.get(latestRunId);
    if (!run) return undefined;
    if (run.status === "running") return run;
    if (Date.now() - run.startedAt < AutomationLiveRunRegistry.AUTO_ATTACH_STALE_WINDOW_MS) return run;
    return undefined;
  }

  getBufferedEvents(runId: string, lastEventId = 0) {
    return this.runs.get(runId)?.buffer.getEventsSince(lastEventId) ?? [];
  }

  subscribe(runId: string, listener: (event: AutomationLiveEvent, eventId: number) => void): () => void {
    const run = this.runs.get(runId);
    if (!run) return () => {};
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  subscribeToScheduleStart(scheduleId: string, listener: (run: AutomationLiveRunRecord) => void): () => void {
    let listeners = this.scheduleStartListeners.get(scheduleId);
    if (!listeners) {
      listeners = new Set();
      this.scheduleStartListeners.set(scheduleId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.scheduleStartListeners.delete(scheduleId);
    };
  }

  broadcast(runId: string, event: AutomationLiveEvent): number | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const eventId = run.buffer.push(event.type, JSON.stringify(event.data ?? {}));
    for (const listener of [...run.listeners]) listener(event, eventId);
    return eventId;
  }

  appendText(runId: string, delta: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const capped = capAutomationLiveText(run.output, delta);
    run.output = capped.next;
    if (capped.delta) this.broadcast(runId, { type: "output", data: { text: capped.delta } });
  }

  complete(runId: string, result: import("@fusion/core").AutomationRunResult): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = result.success ? "complete" : "error";
    this.broadcast(runId, { type: result.success ? "complete" : "error", data: result.success ? { runId, result } : { runId, result, message: result.error ?? "Automation run failed" } });
    this.scheduleCleanup(run);
  }

  fail(runId: string, message: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = "error";
    this.broadcast(runId, { type: "error", data: { runId, message } });
    this.scheduleCleanup(run);
  }

  private scheduleCleanup(run: AutomationLiveRunRecord): void {
    if (run.cleanupTimer) clearTimeout(run.cleanupTimer);
    run.cleanupTimer = setTimeout(() => {
      this.runs.delete(run.runId);
      if (this.latestRunBySchedule.get(run.scheduleId) === run.runId) {
        this.latestRunBySchedule.delete(run.scheduleId);
      }
    }, AUTOMATION_LIVE_RUN_TTL_MS);
    run.cleanupTimer.unref?.();
  }
}

const automationLiveRuns = new AutomationLiveRunRegistry();
const MANUAL_RUN_AI_SYSTEM_PROMPT = [
  "You are an AI automation agent executing a scheduled task.",
  "You may use the coding tools selected for this automation step; follow any tool restrictions exactly.",
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

function createAutomationLiveRunCallbacks(runId: string): AutomationLiveRunCallbacks {
  return {
    onStep: (data) => automationLiveRuns.broadcast(runId, { type: "step", data: { runId, ...data } }),
    onText: (delta) => automationLiveRuns.appendText(runId, delta),
    onToolStart: (name, args) => automationLiveRuns.broadcast(runId, {
      type: "tool",
      data: { runId, status: "started", name, args: previewAutomationLiveValue(args) },
    }),
    onToolEnd: (name, isError, result) => automationLiveRuns.broadcast(runId, {
      type: "tool",
      data: { runId, status: "completed", name, isError, result: previewAutomationLiveValue(result) },
    }),
  };
}

/**
 * Execute a single shell command (used by manual run endpoint).
 *
 * FNXC:DatabaseBackup 2026-07-04-00:00:
 * FN-7537: the dashboard's manual automation/schedule run path (legacy single-command schedules and
 * `command`-type steps in `executeScheduleSteps`) previously always shelled the command out via `exec()`,
 * unlike the scheduler (`CronRunner`) and routine runner (`RoutineRunner.executeCommand`), which both
 * intercept the auto-backup command and run it in-process via the engine's already-open `TaskStore`. On
 * hosts without a global `fn`/`runfusion.ai` binary on PATH this made a manual "Database Backup" run fail
 * while the identical cron-triggered run succeeded. Mirror the cron/routine-runner interception here so a
 * manual run behaves identically: when a `taskStore` is available and the command matches
 * `isInProcessBackupCommand`/`isInProcessMemoryBackupCommand`, run the backup in-process instead of
 * shelling out, using the same `formatInProcessBackupError` message shape on failure (parity with FN-7095).
 */
async function executeSingleCommand(
  command: string,
  timeoutMs: number | undefined,
  startedAt: string,
  taskStore?: TaskStore,
): Promise<import("@fusion/core").AutomationRunResult> {
  if (taskStore && isInProcessBackupCommand(command)) {
    const fusionDir = taskStore.getFusionDir();
    try {
      const { runBackupCommand, resolveGlobalBackupRoot } = await import("@fusion/core");
      const settings = await taskStore.getSettings();
      const result = await runBackupCommand(resolveGlobalBackupRoot(taskStore), settings);
      const output = truncateAutomationOutput(result.output ?? "", "");
      return {
        success: result.success,
        output,
        error: result.success ? undefined : formatInProcessBackupError(output, fusionDir),
        startedAt,
        completedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        success: false,
        output: "",
        error: formatInProcessBackupError(err, fusionDir),
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
  }

  if (taskStore && isInProcessMemoryBackupCommand(command)) {
    const fusionDir = taskStore.getFusionDir();
    try {
      const { runMemoryBackupCommand } = await import("@fusion/core");
      const settings = await taskStore.getSettings();
      const result = await runMemoryBackupCommand(fusionDir, settings);
      return {
        success: result.success,
        output: truncateAutomationOutput(result.output ?? "", ""),
        error: result.success ? undefined : result.output,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        success: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
  }

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

export async function resolveManualAiPromptMcpServers(taskStore: TaskStore) {
  return (await resolveMcpServersForStore(taskStore)).servers;
}

async function executeAiPromptStep(
  step: import("@fusion/core").AutomationStep,
  timeoutMs: number,
  startedAt: string,
  taskStore: TaskStore,
  liveCallbacks?: AutomationLiveRunCallbacks,
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

  const createFnAgent = createFnAgentForRefine;
  const promptWithFallback = enginePromptWithFallback;
  if (!createFnAgent) {
    return {
      stepId: step.id,
      stepName: step.name,
      stepIndex: 0,
      success: false,
      output: "",
      error: "AI agent not available",
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  const settings = await taskStore.getSettings();
  // Resolve model: step override → project execution lane → global execution lane → project default override → global default
  // FNXC:ModelResolution 2026-06-25-12:00: FN-7039 requires manual AI-prompt workflow runs to use execution-lane settings before default settings because these runs have no task/runtime model context.
  const defaultModel = resolveExecutionSettingsModel(settings);
  const modelProvider = step.modelProvider?.trim() || defaultModel.provider;
  const modelId = step.modelId?.trim() || defaultModel.modelId;
  let responseText = "";
  /*
   * FNXC:McpConfig 2026-06-26-00:00:
   * Manual AI-prompt workflow runs are operator-triggered coding-agent sessions, so they must receive the task-store resolved MCP set just like task executor lanes. Do not log resolved MCP payloads because env/header values may contain materialized secrets.
   *
   * FNXC:Automations 2026-07-12-20:30:
   * Manual/inline automation AI runs bypass CronRunner's executor seam, so they must pass the persisted step thinking level directly as createFnAgent.defaultThinkingLevel. Undefined or blank values preserve inherited defaults.
   */
  const mcpServers = await resolveManualAiPromptMcpServers(taskStore);
  const defaultThinkingLevel = step.thinkingLevel?.trim() || undefined;

  const { session } = await createFnAgent({
    cwd: process.cwd(),
    systemPrompt: MANUAL_RUN_AI_SYSTEM_PROMPT,
    tools: "coding",
    toolsAllowlist: step.allowedTools,
    defaultProvider: modelProvider,
    defaultModelId: modelId,
    defaultThinkingLevel,
    mcpServers,
    onText: (delta: string) => {
      responseText += delta;
      liveCallbacks?.onText?.(delta);
    },
    onToolStart: liveCallbacks?.onToolStart,
    onToolEnd: liveCallbacks?.onToolEnd,
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
    /*
    FNXC:Automations 2026-07-12-20:30:
    Manual/inline create-task automation runs map the persisted step thinking level onto the created task so manual execution matches scheduled and routine behavior.
    */
    const task = await taskStore.createTask({
      title: step.taskTitle?.trim() || undefined,
      description: step.taskDescription.trim(),
      column: (step.taskColumn as import("@fusion/core").Column) || "triage",
      modelProvider: step.modelProvider?.trim() || undefined,
      modelId: step.modelId?.trim() || undefined,
      thinkingLevel: (step.thinkingLevel?.trim() || undefined) as import("@fusion/core").TaskCreateInput["thinkingLevel"],
      source: {
        sourceType: "workflow_step",
        sourceMetadata: { stepId: step.id },
      },
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
  liveCallbacks?: AutomationLiveRunCallbacks,
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
    liveCallbacks?.onStep?.({ stepIndex: i, stepId: step.id, stepName: step.name, stepType: step.type, status: "started" });

    if (step.type === "command") {
      const cmdResult = await executeSingleCommand(step.command ?? "", timeoutMs, stepStartedAt, taskStore);
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
      stepResult = await executeAiPromptStep(step, timeoutMs, stepStartedAt, taskStore, liveCallbacks);
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
    liveCallbacks?.onStep?.({ stepIndex: i, stepId: step.id, stepName: step.name, stepType: step.type, status: "completed", success: stepResult.success, error: stepResult.error });
    if (step.type !== "ai-prompt" && stepResult.output) {
      liveCallbacks?.onText?.(stepResult.output);
    }

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
