import { Router, type Request, type Response, type NextFunction } from "express";

// Extend Express Request to include rawBody property set by webhook middleware
declare module "express" {
  interface Request {
    rawBody?: Buffer;
  }
}
import multer from "multer";
import { createReadStream } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve, sep, join, isAbsolute } from "node:path";
import * as nodeFs from "node:fs";
import { promisify } from "node:util";

const {
  access,
} = fsPromises;
import type { TaskStore, ScheduleType, ActivityEventType, ModelPreset, RoutineTriggerType } from "@fusion/core";
import { type BatchStatusEntry, type BatchStatusResponse, type BatchStatusResult, type IssueInfo, type PrInfo, type Task, type PiExtensionEntry, type PiExtensionSettings, getCurrentRepo, isGhAvailable, isGhAuthenticated, AutomationStore, RoutineStore, isWebhookTrigger, MemoryBackendError, listAgentMemoryFiles, readAgentMemoryFile, writeAgentMemoryFile, discoverPiExtensions, getFusionAgentDir, getLegacyPiAgentDir } from "@fusion/core";
import type { ServerOptions } from "./server.js";
import { probeClaudeCli } from "./claude-cli-probe.js";
import { GitHubClient, parseBadgeUrl } from "./github.js";
import { githubRateLimiter } from "./github-poll.js";
import { terminalSessionManager } from "./terminal.js";
import { getTerminalService } from "./terminal-service.js";
import { listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile, searchWorkspaceFiles, copyWorkspaceFile, moveWorkspaceFile, deleteWorkspaceFile, renameWorkspaceFile, getWorkspaceFileForDownload, getWorkspaceFolderForZip, listProjectMarkdownFiles, FileServiceError, type MarkdownFileListResponse } from "./file-service.js";
import { clearUsageCache, fetchAllProviderUsage } from "./usage.js";
import {
  getGitHubAppConfig,
  verifyWebhookSignature,
  classifyWebhookEvent,
  hasPrBadgeFieldsChanged,
  hasIssueBadgeFieldsChanged,
} from "./github-webhooks.js";
import { invalidateAllGlobalSettingsCaches } from "./project-store-resolver.js";
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
  sendErrorResponse,
  unauthorized,
} from "./api-error.js";
import { resolvePluginManifest } from "./plugin-routes.js";
import { createRuntimeLogger, type RuntimeLogger } from "./runtime-logger.js";
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
import { registerProxyRoutes } from "./routes/register-proxy.js";
import { registerIntegratedRouters, registerIntegratedDevServerRouter } from "./routes/register-integrated-routers.js";

const TASK_DETAIL_ACTIVITY_LOG_LIMIT = 500;

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

const execFileAsync = promisify(execFile);

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

// Dynamic import fallback for @fusion/engine with injectable override for tests.
let createFnAgentForRefine: typeof import("@fusion/engine").createFnAgent | undefined;

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

function rethrowAsApiError(error: unknown, fallbackMessage = "Internal server error"): never {
  if (error instanceof ApiError) {
    throw error;
  }

  if (error instanceof Error && error.message) {
    throw internalError(error.message);
  }

  throw internalError(fallbackMessage);
}

function getCommandErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const anyError = error as Error & { stdout?: string; stderr?: string };
    return [anyError.stderr, anyError.stdout, anyError.message].filter(Boolean).join("\n").trim() || anyError.message;
  }
  return String(error);
}

async function runGitCommand(args: string[], cwd?: string, timeout = 10000): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf-8",
  });

  if (typeof result === "string") {
    return result;
  }

  if (Array.isArray(result)) {
    return String(result[0] ?? "");
  }

  if (result && typeof result === "object" && "stdout" in result) {
    return String((result as { stdout?: unknown }).stdout ?? "");
  }

  return "";
}

export interface ResolveDiffBaseTaskInput {
  baseCommitSha?: string;
  baseBranch?: string;
}

/**
 * Resolve the diff base ref for a task worktree.
 *
 * IMPORTANT: `packages/engine/src/merger.ts` mirrors this exact ordering for
 * merge-time scope warnings. Keep both implementations in sync so dashboard
 * changed-files views and merger scope enforcement evaluate the same range.
 *
 * Strategy (in priority order):
 * 1. **Branch merge-base** — Prefer the live merge-base between `headRef` and
 *    local `{baseBranch}` (fallback: `origin/{baseBranch}`).
 * 2. **Task-scoped baseCommitSha** — If merge-base is unavailable or equals
 *    `headRef`, use `baseCommitSha` when still an ancestor of `headRef`.
 * 3. **headRef~1** — Last-resort fallback.
 */
export async function resolveDiffBase(
  task: ResolveDiffBaseTaskInput,
  cwd: string,
  headRef = "HEAD",
  runGit: (args: string[], cwd?: string, timeout?: number) => Promise<string> = runGitCommand,
): Promise<string | undefined> {
  const baseBranch = task.baseBranch ?? "main";
  let mergeBase: string | undefined;

  try {
    try {
      mergeBase = (await runGit(["merge-base", headRef, baseBranch], cwd, 5000)).trim() || undefined;
    } catch {
      mergeBase = (await runGit(["merge-base", headRef, `origin/${baseBranch}`], cwd, 5000)).trim() || undefined;
    }
  } catch {
    // base branch may no longer exist locally/remotely
  }

  // If merge-base equals headRef, the live merge-base would produce an empty
  // diff. Prefer task.baseCommitSha when still valid.
  if (mergeBase) {
    try {
      const head = (await runGit(["rev-parse", headRef], cwd, 5000)).trim();
      if (head && head !== mergeBase) return mergeBase;
    } catch {
      return mergeBase;
    }
  }

  if (task.baseCommitSha) {
    try {
      await runGit(["merge-base", "--is-ancestor", task.baseCommitSha, headRef], cwd, 5000);
      return task.baseCommitSha;
    } catch {
      // stale or unreachable — fall through
    }
  }

  try {
    return (await runGit(["rev-parse", `${headRef}~1`], cwd, 5000)).trim() || undefined;
  } catch {
    return undefined;
  }
}

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

// ── Git Remote Detection ──────────────────────────────────────────

/** Git remote info returned by the remotes endpoint */
export interface GitRemote {
  name: string;
  owner: string;
  repo: string;
  url: string;
}

/**
 * Parse a GitHub URL to extract owner and repo.
 * Handles HTTPS (https://github.com/owner/repo.git) and SSH (git@github.com:owner/repo.git) formats.
 */
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  // HTTPS format: https://github.com/owner/repo.git or https://github.com/owner/repo
  const httpsMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  // SSH format: git@github.com:owner/repo.git or git@github.com:owner/repo
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}

function parseGitHubBadgeUrl(url: string | undefined): { owner: string; repo: string } | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 4) return null;
    const [owner, repo, resourceType] = parts;
    if ((resourceType !== "issues" && resourceType !== "pull") || !owner || !repo) {
      return null;
    }
    return { owner, repo };
  } catch {
    return null;
  }
}

/**
 * Get GitHub remotes from the current git repository.
 * Executes `git remote -v` and parses the output.
 */
async function getGitHubRemotes(cwd?: string): Promise<GitRemote[]> {
  try {
    // Execute git remote -v to get all remotes with their URLs
    const output = await runGitCommand(["remote", "-v"], cwd, 5000);

    const remotes: GitRemote[] = [];
    const seen = new Set<string>();

    for (const line of output.split("\n")) {
      // Parse lines like: "origin  https://github.com/owner/repo.git (fetch)"
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (!match) continue;

      const [, name, url] = match;

      // Skip duplicates (fetch/push entries for same remote)
      const key = `${name}-${url}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Only include GitHub URLs
      const parsed = parseGitHubUrl(url);
      if (parsed) {
        remotes.push({
          name,
          owner: parsed.owner,
          repo: parsed.repo,
          url,
        });
      }
    }

    return remotes;
  } catch {
    // Return empty array if not a git repo, git not available, or any error
    return [];
  }
}

/**
 * Check if the current directory is a git repository.
 * Used to validate git operations before executing commands.
 */
async function isGitRepo(cwd?: string): Promise<boolean> {
  try {
    await runGitCommand(["rev-parse", "--git-dir"], cwd, 5000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current git status including branch, commit hash, and dirty state.
 * Returns structured data for the Git Manager UI.
 */
async function getGitStatus(cwd?: string): Promise<{
  branch: string;
  commit: string;
  isDirty: boolean;
  ahead: number;
  behind: number;
} | null> {
  try {
    // Get current branch
    const branchOutput = await runGitCommand(["branch", "--show-current"], cwd, 5000);
    const branch = branchOutput.trim() || "HEAD detached";

    // Get current commit hash (short)
    const commit = (await runGitCommand(["rev-parse", "--short", "HEAD"], cwd, 5000)).trim();

    // Check if working directory is dirty
    const statusOutput = (await runGitCommand(["status", "--porcelain"], cwd, 5000)).trim();
    const isDirty = statusOutput.length > 0;

    // Get ahead/behind counts from origin
    let ahead = 0;
    let behind = 0;
    try {
      const revListOutput = (await runGitCommand(["rev-list", "--left-right", "--count", "HEAD...@{u}"], cwd, 5000)).trim();
      const match = revListOutput.match(/(\d+)\s+(\d+)/);
      if (match) {
        ahead = parseInt(match[1], 10);
        behind = parseInt(match[2], 10);
      }
    } catch {
      // No upstream or other error - leave as 0
    }

    return { branch, commit, isDirty, ahead, behind };
  } catch {
    return null;
  }
}

/** Git commit info returned by the commits endpoint */
export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  parents: string[];
}

/**
 * Get recent commits from the git log.
 * @param limit Maximum number of commits to return (default 20)
 */
async function getGitCommits(limit: number = 20, cwd?: string): Promise<GitCommit[]> {
  try {
    // Format: hash|shortHash|message|author|date|parents
    const format = "%H|%h|%s|%an|%aI|%P";
    const output = await runGitCommand(["log", `--max-count=${limit}`, `--pretty=format:${format}`], cwd, 10000);

    const commits: GitCommit[] = [];
    for (const line of output.split("\n")) {
      const parts = line.split("|");
      if (parts.length < 5) continue;

      const [hash, shortHash, message, author, date, parentsStr] = parts;
      const parents = parentsStr ? parentsStr.split(" ").filter(Boolean) : [];

      commits.push({
        hash,
        shortHash,
        message: message || "",
        author: author || "",
        date: date || "",
        parents,
      });
    }

    return commits;
  } catch {
    return [];
  }
}

/**
 * Validates a git ref name to prevent command injection.
 * Refs include branch names, remote tracking branches (remote/branch), and tags.
 * Must not contain shell metacharacters or start with dashes.
 */
function isValidGitRef(ref: string): boolean {
  if (!ref || ref.length === 0) return false;
  if (ref.startsWith("-")) return false;
  if (/[;<>&|`$(){}[\]\r\n]/.test(ref)) return false;
  if (/\s/.test(ref)) return false;
  // Allow slashes for remote/branch format, dots, hyphens, underscores, alphanumerics
  if (!/^[a-zA-Z0-9/_.@-]+$/.test(ref)) return false;
  if (ref.includes("..")) return false;
  if (ref.includes("~")) return false;
  if (ref.includes("^")) return false;
  if (ref.includes(":")) return false;
  // Must not look like an option
  if (ref.startsWith("--")) return false;
  return true;
}

/**
 * Get recent commits for a specific branch.
 * @param branch The branch name (validated before calling)
 * @param limit Maximum number of commits to return
 * @param cwd Working directory
 */
async function getGitCommitsForBranch(branch: string, limit: number = 10, cwd?: string): Promise<GitCommit[]> {
  try {
    const format = "%H|%h|%s|%an|%aI|%P";
    const output = await runGitCommand(["log", `--max-count=${limit}`, `--pretty=format:${format}`, branch], cwd, 10000);

    const commits: GitCommit[] = [];
    for (const line of output.split("\n")) {
      const parts = line.split("|");
      if (parts.length < 5) continue;

      const [hash, shortHash, message, author, date, parentsStr] = parts;
      const parents = parentsStr ? parentsStr.split(" ").filter(Boolean) : [];

      commits.push({
        hash,
        shortHash,
        message: message || "",
        author: author || "",
        date: date || "",
        parents,
      });
    }

    return commits;
  } catch {
    return [];
  }
}

/**
 * Get commits ahead of the upstream tracking branch (commits that would be pushed).
 * Returns the list of local commits not yet present on the upstream.
 * Returns an empty array if there is no upstream configured.
 */
async function getAheadCommits(cwd?: string): Promise<GitCommit[]> {
  try {
    // Check if an upstream is configured
    try {
      await runGitCommand(["rev-parse", "--abbrev-ref", "@{u}"], cwd, 10000);
    } catch {
      // No upstream configured
      return [];
    }

    // Format: hash|shortHash|message|author|date|parents
    const format = "%H|%h|%s|%an|%aI|%P";
    const output = await runGitCommand(["log", "@{u}..HEAD", `--pretty=format:${format}`], cwd, 10000);

    const commits: GitCommit[] = [];
    for (const line of output.split("\n")) {
      const parts = line.split("|");
      if (parts.length < 5) continue;

      const [hash, shortHash, message, author, date, parentsStr] = parts;
      const parents = parentsStr ? parentsStr.split(" ").filter(Boolean) : [];

      commits.push({
        hash,
        shortHash,
        message: message || "",
        author: author || "",
        date: date || "",
        parents,
      });
    }

    return commits;
  } catch {
    return [];
  }
}

/**
 * Get recent commits reachable from a remote tracking ref.
 * @param remoteRef The remote ref (e.g. "origin/main") to list commits for
 * @param limit Maximum number of commits to return (default 10)
 */
async function getRemoteCommits(remoteRef: string, limit: number = 10, cwd?: string): Promise<GitCommit[]> {
  try {
    if (!isValidGitRef(remoteRef)) {
      throw new Error("Invalid remote ref");
    }

    try {
      await runGitCommand(["rev-parse", "--verify", remoteRef], cwd, 5000);
    } catch {
      return [];
    }

    // Format: hash|shortHash|message|author|date|parents
    const format = "%H|%h|%s|%an|%aI|%P";
    const safeLimit = Math.min(Math.max(1, limit), 50);
    const output = await runGitCommand(["log", `--max-count=${safeLimit}`, `--pretty=format:${format}`, remoteRef], cwd, 10000);

    const commits: GitCommit[] = [];
    for (const line of output.split("\n")) {
      const parts = line.split("|");
      if (parts.length < 5) continue;

      const [hash, shortHash, message, author, date, parentsStr] = parts;
      const parents = parentsStr ? parentsStr.split(" ").filter(Boolean) : [];

      commits.push({
        hash,
        shortHash,
        message: message || "",
        author: author || "",
        date: date || "",
        parents,
      });
    }

    return commits;
  } catch {
    return [];
  }
}

/**
 * Get the diff for a specific commit.
 * @param hash The commit hash
 * @returns Object with stat and patch
 */
async function getCommitDiff(hash: string, cwd?: string): Promise<{ stat: string; patch: string } | null> {
  try {
    // Validate the hash is a valid git object
    await runGitCommand(["cat-file", "-t", hash], cwd, 5000);

    // Get diff stat (use --format= with empty string, not --format="")
    const stat = (await runGitCommand(["show", "--stat", "--format=", hash], cwd, 10000)).trim();

    // Get patch (use --format= with empty string, not --format="")
    const patch = await runGitCommand(["show", "--format=", hash], cwd, 10000);

    return { stat, patch };
  } catch {
    return null;
  }
}

/** Git branch info returned by the branches endpoint */
export interface GitBranch {
  name: string;
  isCurrent: boolean;
  remote?: string;
  lastCommitDate?: string;
}

/**
 * Get all local branches with their info.
 */
async function getGitBranches(cwd?: string): Promise<GitBranch[]> {
  try {
    // Get current branch name
    let currentBranch = "";
    try {
      currentBranch = (await runGitCommand(["branch", "--show-current"], cwd, 5000)).trim();
    } catch {
      // Detached HEAD - no current branch
    }

    // Get all branches with info
    const format = "%(refname:short)|%(upstream:short)|%(committerdate:iso8601)|%(HEAD)";
    const output = (await runGitCommand(["for-each-ref", `--format=${format}`, "refs/heads/"], cwd, 10000)).trim();

    const branches: GitBranch[] = [];
    for (const line of output.split("\n")) {
      const parts = line.split("|");
      if (parts.length < 4) continue;

      const [name, remote, lastCommitDate, headMarker] = parts;
      const isCurrent = headMarker === "*" || name === currentBranch;

      branches.push({
        name,
        isCurrent,
        remote: remote || undefined,
        lastCommitDate: lastCommitDate || undefined,
      });
    }

    return branches;
  } catch {
    return [];
  }
}

/** Git worktree info returned by the worktrees endpoint */
export interface GitWorktree {
  path: string;
  branch?: string;
  isMain: boolean;
  isBare: boolean;
  taskId?: string;
}

/**
 * Get all git worktrees.
 * @param tasks Optional task list to correlate worktrees with tasks
 */
async function getGitWorktrees(tasks: { id: string; worktree?: string }[] = [], cwd?: string): Promise<GitWorktree[]> {
  try {
    const output = await runGitCommand(["worktree", "list", "--porcelain"], cwd, 10000);

    const worktrees: GitWorktree[] = [];
    let currentWorktree: Partial<GitWorktree> = {};

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        // Save previous worktree if exists
        if (currentWorktree.path) {
          // Find associated task by matching worktree path
          const task = tasks.find((t) => t.worktree && currentWorktree.path === t.worktree);
          worktrees.push({
            path: currentWorktree.path,
            branch: currentWorktree.branch,
            isMain: currentWorktree.isMain || false,
            isBare: currentWorktree.isBare || false,
            taskId: task?.id,
          });
        }
        // Start new worktree
        currentWorktree = { path: line.slice(9).trim() };
      } else if (line.startsWith("branch ")) {
        currentWorktree.branch = line.slice(8).trim().replace(/^refs\/heads\//, "");
      } else if (line === "bare") {
        currentWorktree.isBare = true;
      } else if (line === "main") {
        currentWorktree.isMain = true;
      } else if (line === "" && currentWorktree.path) {
        // Empty line signals end of worktree entry
        const task = tasks.find((t) => t.worktree && currentWorktree.path === t.worktree);
        worktrees.push({
          path: currentWorktree.path,
          branch: currentWorktree.branch,
          isMain: currentWorktree.isMain || false,
          isBare: currentWorktree.isBare || false,
          taskId: task?.id,
        });
        currentWorktree = {};
      }
    }

    // Handle last worktree if no trailing newline
    if (currentWorktree.path) {
      const task = tasks.find((t) => t.worktree && currentWorktree.path === t.worktree);
      worktrees.push({
        path: currentWorktree.path,
        branch: currentWorktree.branch,
        isMain: currentWorktree.isMain || false,
        isBare: currentWorktree.isBare || false,
        taskId: task?.id,
      });
    }

    return worktrees;
  } catch {
    return [];
  }
}

// ── Git Action Helper Functions ──────────────────────────────────────────

/**
 * Validates a branch name to prevent command injection.
 * Branch names must not contain spaces, special shell characters, or start with dashes.
 */
function isValidBranchName(name: string): boolean {
  // Must not be empty
  if (!name || name.length === 0) return false;
  // Must not start with a dash (could be interpreted as an option)
  if (name.startsWith("-")) return false;
  // Must not contain shell metacharacters
  if (/[;<>&|`$(){}[\]\r\n]/.test(name)) return false;
  // Must be valid git ref format (no spaces, no double dots, etc)
  if (/\s/.test(name)) return false;
  if (name.includes("..")) return false;
  if (name.includes("~")) return false;
  if (name.includes("^")) return false;
  if (name.includes(":")) return false;
  // Must not be a reserved git ref name
  const reserved = ["HEAD", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD"];
  if (reserved.includes(name)) return false;
  return true;
}

/**
 * Create a new branch from current HEAD or specified base.
 * Returns the created branch name.
 */
async function createGitBranch(name: string, base?: string, cwd?: string): Promise<string> {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid branch name");
  }
  if (base && !isValidBranchName(base)) {
    throw new Error("Invalid base branch name");
  }
  const args = base ? ["checkout", "-b", name, base] : ["checkout", "-b", name];
  await runGitCommand(args, cwd, 10000);
  return name;
}

/**
 * Checkout an existing branch.
 * Throws if there are uncommitted changes that would be lost.
 */
async function checkoutGitBranch(name: string, cwd?: string): Promise<void> {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid branch name");
  }
  try {
    await runGitCommand(["diff-index", "--quiet", "HEAD", "--"], cwd, 5000);
  } catch {
    const diff = (await runGitCommand(["diff", "--name-only"], cwd, 5000)).trim();
    if (diff) {
      throw new Error("Uncommitted changes would be lost. Commit or stash changes first.");
    }
  }
  await runGitCommand(["checkout", name], cwd, 10000);
}

/**
 * Delete a branch.
 * Throws if it's the current branch or has unmerged commits.
 */
async function deleteGitBranch(name: string, force: boolean = false, cwd?: string): Promise<void> {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid branch name");
  }
  const flag = force ? "-D" : "-d";
  await runGitCommand(["branch", flag, name], cwd, 10000);
}

/** Result of a fetch operation */
export interface GitFetchResult {
  fetched: boolean;
  message: string;
}

/**
 * Fetch from origin or specified remote.
 */
async function fetchGitRemote(remote: string = "origin", cwd?: string): Promise<GitFetchResult> {
  if (!isValidBranchName(remote)) {
    throw new Error("Invalid remote name");
  }
  try {
    const output = await runGitCommand(["fetch", remote], cwd, 30000);
    return { fetched: true, message: output.trim() || "Fetch completed" };
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    const message = getCommandErrorMessage(err);
    if (message.includes("Could not resolve host") || message.includes("Connection refused")) {
      throw new Error("Failed to connect to remote");
    }
    return { fetched: false, message: message || "No updates" };
  }
}

/** Result of a pull operation */
export interface GitPullResult {
  success: boolean;
  message: string;
  conflict?: boolean;
}

/**
 * Pull the current branch.
 */
async function pullGitBranch(cwd?: string): Promise<GitPullResult> {
  try {
    const output = await runGitCommand(["pull"], cwd, 30000);
    return { success: true, message: output.trim() };
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    const message = getCommandErrorMessage(err);
    if (message.includes("CONFLICT") || message.includes("Merge conflict")) {
      return { success: false, message: "Merge conflict detected. Resolve manually.", conflict: true };
    }
    throw new Error(message || "Pull failed");
  }
}

/** Result of a push operation */
export interface GitPushResult {
  success: boolean;
  message: string;
}

/**
 * Push the current branch.
 */
async function pushGitBranch(cwd?: string): Promise<GitPushResult> {
  try {
    const output = await runGitCommand(["push"], cwd, 30000);
    return { success: true, message: output.trim() || "Push completed" };
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    const message = getCommandErrorMessage(err);
    if (message.includes("rejected") || message.includes("non-fast-forward")) {
      throw new Error("Push rejected. Pull latest changes first.");
    }
    if (message.includes("Could not resolve host") || message.includes("Connection refused")) {
      throw new Error("Failed to connect to remote");
    }
    throw new Error(message || "Push failed");
  }
}

// ── Git Remote Management Helper Functions ───────────────────────────────

/** Detailed git remote info with fetch and push URLs */
export interface GitRemoteDetailed {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

/**
 * Validates a git URL format.
 * Accepts: https://, git@, file://, or ssh:// formats
 * Rejects URLs containing shell metacharacters to prevent command injection.
 */
function isValidGitUrl(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  // Reject URLs with shell metacharacters to prevent injection
  if (/[;<>&|`$(){}[\]\r\n]/.test(url)) return false;
  // Reject URLs starting with dash (could be interpreted as option)
  if (url.startsWith("-")) return false;
  // HTTPS URL: https://host.com/path.git or https://host.com/path
  if (/^https?:\/\/.+/.test(url)) return true;
  // SSH URL: git@host.com:path.git or git@host.com:path
  if (/^git@[^:]+:.+/.test(url)) return true;
  // File URL: file:///path/to/repo
  if (/^file:\/\/.+/.test(url)) return true;
  // SSH URL with protocol: ssh://git@host.com/path.git
  if (/^ssh:\/\/.+/.test(url)) return true;
  return false;
}

/**
 * Get all git remotes with their fetch and push URLs.
 * Executes `git remote -v` and parses the output.
 */
async function listGitRemotes(cwd?: string): Promise<GitRemoteDetailed[]> {
  try {
    const output = await runGitCommand(["remote", "-v"], cwd, 5000);

    const remotes = new Map<string, { fetchUrl: string; pushUrl: string }>();

    for (const line of output.split("\n")) {
      // Parse lines like: "origin  https://github.com/owner/repo.git (fetch)"
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (!match) continue;

      const [, name, url, type] = match;

      if (!remotes.has(name)) {
        remotes.set(name, { fetchUrl: "", pushUrl: "" });
      }

      const remote = remotes.get(name)!;
      if (type === "fetch") {
        remote.fetchUrl = url;
      } else {
        remote.pushUrl = url;
      }
    }

    return Array.from(remotes.entries()).map(([name, urls]) => ({
      name,
      fetchUrl: urls.fetchUrl,
      pushUrl: urls.pushUrl,
    }));
  } catch {
    return [];
  }
}

/**
 * Add a new git remote.
 */
async function addGitRemote(name: string, url: string, cwd?: string): Promise<void> {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid remote name");
  }
  if (!isValidGitUrl(url)) {
    throw new Error("Invalid git URL format");
  }
  try {
    await runGitCommand(["remote", "add", name, url], cwd, 10000);
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    const message = getCommandErrorMessage(err);
    if (message.includes("already exists")) {
      throw new Error(`Remote '${name}' already exists`);
    }
    throw new Error(message || "Failed to add remote");
  }
}

/**
 * Remove a git remote.
 */
async function removeGitRemote(name: string, cwd?: string): Promise<void> {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid remote name");
  }
  try {
    await runGitCommand(["remote", "remove", name], cwd, 10000);
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    const message = getCommandErrorMessage(err);
    if (message.includes("No such remote")) {
      throw new Error(`Remote '${name}' does not exist`);
    }
    throw new Error(message || "Failed to remove remote");
  }
}

/**
 * Rename a git remote.
 */
async function renameGitRemote(oldName: string, newName: string, cwd?: string): Promise<void> {
  if (!isValidBranchName(oldName)) {
    throw new Error("Invalid remote name");
  }
  if (!isValidBranchName(newName)) {
    throw new Error("Invalid new remote name");
  }
  try {
    await runGitCommand(["remote", "rename", oldName, newName], cwd, 10000);
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    const message = getCommandErrorMessage(err);
    if (message.includes("No such remote")) {
      throw new Error(`Remote '${oldName}' does not exist`);
    }
    if (message.includes("already exists")) {
      throw new Error(`Remote '${newName}' already exists`);
    }
    throw new Error(message || "Failed to rename remote");
  }
}

/**
 * Set the URL for a git remote.
 */
async function setGitRemoteUrl(name: string, url: string, cwd?: string): Promise<void> {
  if (!isValidBranchName(name)) {
    throw new Error("Invalid remote name");
  }
  if (!isValidGitUrl(url)) {
    throw new Error("Invalid git URL format");
  }
  try {
    await runGitCommand(["remote", "set-url", name, url], cwd, 10000);
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    const message = getCommandErrorMessage(err);
    if (message.includes("No such remote")) {
      throw new Error(`Remote '${name}' does not exist`);
    }
    throw new Error(message || "Failed to update remote URL");
  }
}

// ── Git Stash, Stage, Commit Helper Functions ────────────────────────────

/** Git stash entry */
export interface GitStash {
  index: number;
  message: string;
  date: string;
  branch: string;
}

/** Individual file change with staging status */
export interface GitFileChange {
  file: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked";
  staged: boolean;
  oldFile?: string;
}

/**
 * Get list of stash entries.
 */
async function getGitStashList(cwd?: string): Promise<GitStash[]> {
  try {
    const output = (await runGitCommand(["stash", "list", '--format="%gd|%gs|%ai"'], cwd, 5000)).trim();
    if (!output) return [];

    const stashes: GitStash[] = [];
    for (const line of output.split("\n")) {
      const parts = line.split("|");
      if (parts.length < 3) continue;
      const [ref, message, date] = parts;
      const indexMatch = ref.match(/stash@\{(\d+)\}/);
      const index = indexMatch ? parseInt(indexMatch[1], 10) : stashes.length;
      // Extract branch from message like "WIP on main: abc1234 ..."
      const branchMatch = message.match(/(?:WIP on|On) ([^:]+):/);
      const branch = branchMatch ? branchMatch[1] : "";
      stashes.push({ index, message, date, branch });
    }
    return stashes;
  } catch {
    return [];
  }
}

/**
 * Create a new stash.
 */
async function createGitStash(message?: string, cwd?: string): Promise<string> {
  let output: string;
  if (message) {
    const sanitized = message.replace(/[`$\\!"]/g, "").trim();
    if (!sanitized) {
      throw new Error("Invalid stash message");
    }
    output = (await runGitCommand(["stash", "push", "-m", sanitized], cwd, 10000)).trim();
  } else {
    output = (await runGitCommand(["stash", "push"], cwd, 10000)).trim();
  }
  if (output.includes("No local changes to save")) {
    throw new Error("No local changes to stash");
  }
  return output || "Stash created";
}

/**
 * Apply a stash entry.
 */
async function applyGitStash(index: number, drop: boolean = false, cwd?: string): Promise<string> {
  if (index < 0 || !Number.isInteger(index)) throw new Error("Invalid stash index");
  const args = drop ? ["stash", "pop", `stash@{${index}}`] : ["stash", "apply", `stash@{${index}}`];
  const output = (await runGitCommand(args, cwd, 10000)).trim();
  return output || (drop ? "Stash popped" : "Stash applied");
}

/**
 * Drop a stash entry.
 */
async function dropGitStash(index: number, cwd?: string): Promise<string> {
  if (index < 0 || !Number.isInteger(index)) throw new Error("Invalid stash index");
  const output = (await runGitCommand(["stash", "drop", `stash@{${index}}`], cwd, 10000)).trim();
  return output || "Stash dropped";
}

/**
 * Get file changes (staged and unstaged).
 */
async function getGitFileChanges(cwd?: string): Promise<GitFileChange[]> {
  try {
    const output = (await runGitCommand(["status", "--porcelain=v1"], cwd, 5000)).trim();
    if (!output) return [];

    const changes: GitFileChange[] = [];
    for (const line of output.split("\n")) {
      if (line.length < 3) continue;
      const indexStatus = line[0];
      const workTreeStatus = line[1];
      const filePath = line.slice(3).trim();

      const mapStatus = (code: string): GitFileChange["status"] => {
        switch (code) {
          case "A": return "added";
          case "M": return "modified";
          case "D": return "deleted";
          case "R": return "renamed";
          case "C": return "copied";
          case "?": return "untracked";
          default: return "modified";
        }
      };

      let file = filePath;
      let oldFile: string | undefined;
      if (filePath.includes(" -> ")) {
        const [old, newF] = filePath.split(" -> ");
        oldFile = old.trim();
        file = newF.trim();
      }

      if (indexStatus !== " " && indexStatus !== "?") {
        changes.push({
          file,
          status: mapStatus(indexStatus),
          staged: true,
          oldFile,
        });
      }

      if (workTreeStatus !== " ") {
        changes.push({
          file,
          status: workTreeStatus === "?" ? "untracked" : mapStatus(workTreeStatus),
          staged: false,
          oldFile,
        });
      }
    }
    return changes;
  } catch {
    return [];
  }
}

/**
 * Get working directory diff.
 */
async function getGitWorkingDiff(cwd?: string): Promise<{ stat: string; patch: string }> {
  try {
    const stat = (await runGitCommand(["diff", "--stat"], cwd, 10000)).trim();
    const patch = await runGitCommand(["diff"], cwd, 10000);
    return { stat, patch };
  } catch {
    return { stat: "", patch: "" };
  }
}

/**
 * Validate a file path passed to git commands.
 */
function isValidGitFilePath(filePath: string): boolean {
  if (!filePath || !filePath.trim()) return false;
  if (filePath.startsWith("-")) return false;
  if (isAbsolute(filePath)) return false;
  if (filePath.includes("\0")) return false;
  if (filePath.includes("..")) return false;
  if (/[;&|`$(){}[\]\r\n]/.test(filePath)) return false;
  return true;
}

async function runNoIndexDiff(args: string[], cwd?: string): Promise<string> {
  try {
    return await runGitCommand(args, cwd, 10000);
  } catch (error) {
    const commandError = error as NodeJS.ErrnoException & { stdout?: string };
    if (typeof commandError.stdout === "string") {
      return commandError.stdout;
    }
    throw error;
  }
}

/**
 * Get staged or unstaged diff for a specific file path.
 */
async function getGitFileDiff(filePath: string, staged: boolean, cwd?: string): Promise<{ stat: string; patch: string }> {
  if (!isValidGitFilePath(filePath)) {
    throw new Error(`Invalid file path: ${filePath}`);
  }

  if (staged) {
    const stat = (await runGitCommand(["diff", "--cached", "--stat", "--", filePath], cwd, 10000)).trim();
    const patch = await runGitCommand(["diff", "--cached", "--", filePath], cwd, 10000);
    return { stat, patch };
  }

  const untracked = (await runGitCommand(["ls-files", "--others", "--exclude-standard", "--", filePath], cwd, 5000)).trim();
  if (untracked === filePath) {
    const stat = (await runNoIndexDiff(["diff", "--no-index", "--stat", "/dev/null", filePath], cwd)).trim();
    const patch = await runNoIndexDiff(["diff", "--no-index", "/dev/null", filePath], cwd);
    return { stat, patch };
  }

  const stat = (await runGitCommand(["diff", "--stat", "--", filePath], cwd, 10000)).trim();
  const patch = await runGitCommand(["diff", "--", filePath], cwd, 10000);
  return { stat, patch };
}

/**
 * Stage specific files.
 */
async function stageGitFiles(files: string[], cwd?: string): Promise<string[]> {
  if (!files.length) throw new Error("No files specified");
  for (const f of files) {
    if (!isValidGitFilePath(f)) {
      throw new Error(`Invalid file path: ${f}`);
    }
  }
  await runGitCommand(["add", ...files], cwd, 10000);
  return files;
}

/**
 * Unstage specific files.
 */
async function unstageGitFiles(files: string[], cwd?: string): Promise<string[]> {
  if (!files.length) throw new Error("No files specified");
  for (const f of files) {
    if (!isValidGitFilePath(f)) {
      throw new Error(`Invalid file path: ${f}`);
    }
  }
  await runGitCommand(["reset", "HEAD", "--", ...files], cwd, 10000);
  return files;
}

/**
 * Create a commit with staged changes.
 */
async function createGitCommit(message: string, cwd?: string): Promise<{ hash: string; message: string }> {
  if (!message || !message.trim()) throw new Error("Commit message is required");
  const staged = (await runGitCommand(["diff", "--cached", "--name-only"], cwd, 5000)).trim();
  if (!staged) throw new Error("No staged changes to commit");
  await runGitCommand(["commit", "-m", message.trim()], cwd, 10000);
  const hash = (await runGitCommand(["rev-parse", "--short", "HEAD"], cwd, 5000)).trim();
  return { hash, message: message.trim() };
}

/**
 * Discard changes for specific files.
 */
async function discardGitChanges(files: string[], cwd?: string): Promise<string[]> {
  if (!files.length) throw new Error("No files specified");
  for (const f of files) {
    if (!isValidGitFilePath(f)) {
      throw new Error(`Invalid file path: ${f}`);
    }
  }
  const statusOutput = (await runGitCommand(["status", "--porcelain=v1"], cwd, 5000)).trim();
  const untracked = new Set<string>();
  for (const line of statusOutput.split("\n")) {
    if (line.startsWith("??")) {
      untracked.add(line.slice(3).trim());
    }
  }
  const trackedFiles = files.filter((f) => !untracked.has(f));
  const untrackedFiles = files.filter((f) => untracked.has(f));

  if (trackedFiles.length) {
    await runGitCommand(["checkout", "--", ...trackedFiles], cwd, 10000);
  }
  if (untrackedFiles.length) {
    await runGitCommand(["clean", "-f", "--", ...untrackedFiles], cwd, 10000);
  }
  return files;
}

// ── Module-level batch-import rate limiter state (resettable for testing) ──
const batchImportWindowMs = 10_000; // 10 seconds
const batchImportInstances: Map<string, number>[] = [];
let batchImportCleanupInterval: ReturnType<typeof setInterval> | undefined;

/** @internal Reset batch-import rate limiter state (for test isolation) */
export function __resetBatchImportRateLimiter(): void {
  for (const clients of batchImportInstances) {
    clients.clear();
  }
  batchImportInstances.length = 0;
  if (batchImportCleanupInterval) {
    clearInterval(batchImportCleanupInterval);
    batchImportCleanupInterval = undefined;
  }
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
    proxyLogger,
    chatLogger,
    prioritizeProjectsForCurrentDirectory,
    getProjectIdFromRequest,
    getScopedStore,
    getProjectContext,
    emitRemoteRouteDiagnostic,
    emitAuthSyncAuditLog,
    proxyToRemoteNode,
    parseScopeParam,
    resolveAutomationStore,
    resolveRoutineStore,
    resolveRoutineRunner,
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
    proxyLogger,
    chatLogger,
    prioritizeProjectsForCurrentDirectory,
    getProjectIdFromRequest,
    getScopedStore,
    getProjectContext,
    emitRemoteRouteDiagnostic,
    emitAuthSyncAuditLog,
    proxyToRemoteNode,
    parseScopeParam,
    resolveAutomationStore,
    resolveRoutineStore,
    resolveRoutineRunner,
    rethrowAsApiError,
  };

  const sessionFilesCache = new Map<string, { files: string[]; expiresAt: number }>();
  const fileDiffsCache = new Map<
    string,
    {
      files: Array<{ path: string; status: "added" | "modified" | "deleted" | "renamed"; diff: string; oldPath?: string }>;
      expiresAt: number;
    }
  >();

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
    resolveDiffBase,
    trimTaskDetailActivityLog,
    sessionFilesCache,
    fileDiffsCache,
    triggerCommentWakeForAssignedAgent: (...args) => triggerCommentWakeForAssignedAgent(...args),
    refreshPrInBackground,
    refreshIssueInBackground,
    githubToken,
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
  });
  registerMessagingScriptRoutes(routeContext);
  registerGitGitHubRoutes(routeContext);
  registerFilesTerminalWorkspaceRoutes(routeContext);
  registerAgentsProjectsNodesRoutes(routeContext);
  registerPluginsAutomationRoutes(routeContext);
  registerProxyRoutes(routeContext);

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
   * POST /api/settings/test-ntfy
   * Send a test notification to verify ntfy configuration.
   * Returns: { success: true } on success, { error: string } on failure.
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
  registerModelsRoute(router, options?.modelRegistry, store, runtimeLogger.child("models"));

  /**
   * GET /api/git/remotes
   * Returns GitHub remotes from the current git repository.
   * Response: Array of GitRemote objects [{ name: string, owner: string, repo: string, url: string }]
   */
  router.get("/git/remotes", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      const remotes = await getGitHubRemotes(rootDir);
      res.json(remotes);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/remotes/detailed
   * Returns all git remotes with their fetch and push URLs.
   * Response: Array of GitRemoteDetailed objects [{ name: string, fetchUrl: string, pushUrl: string }]
   */
  router.get("/git/remotes/detailed", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const remotes = await listGitRemotes(rootDir);
      res.json(remotes);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/git/remotes
   * Add a new git remote.
   * Body: { name: string, url: string }
   */
  router.post("/git/remotes", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      const { name, url } = req.body;
      if (!name || typeof name !== "string") {
        throw badRequest("name is required");
      }
      if (!url || typeof url !== "string") {
        throw badRequest("url is required");
      }
      if (!isValidBranchName(name)) {
        throw badRequest("Invalid remote name");
      }
      if (!isValidGitUrl(url)) {
        throw badRequest("Invalid git URL format");
      }
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      await addGitRemote(name, url, rootDir);
      res.status(201).json({ name, added: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("Invalid remote name")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("Invalid git URL")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("already exists")) {
        throw conflict(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * DELETE /api/git/remotes/:name
   * Remove a git remote.
   */
  router.delete("/git/remotes/:name", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { name } = req.params;
      await removeGitRemote(name, rootDir);
      res.json({ name, removed: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("Invalid remote name")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("does not exist")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * PATCH /api/git/remotes/:name
   * Rename a git remote.
   * Body: { newName: string }
   */
  router.patch("/git/remotes/:name", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { name } = req.params;
      const { newName } = req.body;
      if (!newName || typeof newName !== "string") {
        throw badRequest("newName is required");
      }
      await renameGitRemote(name, newName, rootDir);
      res.json({ oldName: name, newName, renamed: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("Invalid")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("does not exist")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("already exists")) {
        throw conflict(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * PUT /api/git/remotes/:name/url
   * Update the URL for a git remote.
   * Body: { url: string }
   */
  router.put("/git/remotes/:name/url", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { name } = req.params;
      const { url } = req.body;
      if (!url || typeof url !== "string") {
        throw badRequest("url is required");
      }
      await setGitRemoteUrl(name, url, rootDir);
      res.json({ name, url, updated: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("Invalid")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("does not exist")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/git/status
   * Returns current git status: branch, commit hash, dirty state, ahead/behind counts.
   * Response: { branch: string, commit: string, isDirty: boolean, ahead: number, behind: number }
   */
  router.get("/git/status", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const status = await getGitStatus(rootDir);
      if (!status) {
        throw internalError("Failed to get git status");
      }
      res.json(status);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/commits
   * Returns recent commits (default 20, configurable via ?limit=).
   * Response: Array of GitCommit objects
   */
  router.get("/git/commits", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
      const commits = await getGitCommits(limit, rootDir);
      res.json(commits);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/commits/:hash/diff
   * Returns diff for a specific commit (stat + patch).
   * Response: { stat: string, patch: string }
   */
  router.get("/git/commits/:hash/diff", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { hash } = req.params;
      // Validate hash format (only hex characters, 7-40 chars)
      if (!/^[a-f0-9]{7,40}$/i.test(hash)) {
        throw badRequest("Invalid commit hash format");
      }
      const diff = await getCommitDiff(hash, rootDir);
      if (!diff) {
        throw notFound("Commit not found");
      }
      res.json(diff);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/commits/ahead
   * Returns local commits ahead of the upstream tracking branch (commits that would be pushed).
   * Response: Array of GitCommit objects (empty when no upstream is configured)
   */
  router.get("/git/commits/ahead", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const commits = await getAheadCommits(rootDir);
      res.json(commits);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/remotes/:name/commits
   * Returns recent commits for a specific remote tracking ref.
   * Query: ?ref=branchName (defaults to HEAD of the remote's default branch)
   * Query: ?limit=N (defaults to 10, max 50)
   * Response: Array of GitCommit objects
   */
  router.get("/git/remotes/:name/commits", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }

      const { name } = req.params;
      if (!isValidBranchName(name)) {
        throw badRequest("Invalid remote name");
      }

      const ref = req.query.ref as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 10, 50);

      // Build the full remote ref: if ref is given, use "remote/ref", otherwise use "remote/HEAD"
      let remoteRef: string;
      if (ref) {
        if (!isValidGitRef(ref)) {
          throw badRequest("Invalid ref name");
        }
        // Strip any leading "refs/" or remote prefix the user might accidentally include
        const cleanRef = ref.replace(/^refs\/(heads\/)?/, "");
        // If the ref already starts with the remote name, use it as-is
        if (cleanRef.startsWith(`${name}/`)) {
          remoteRef = cleanRef;
        } else {
          remoteRef = `${name}/${cleanRef}`;
        }
      } else {
        // Default: try remote/HEAD symbolic ref, fall back to remote/main, remote/master
        try {
          const headRef = (await runGitCommand(["symbolic-ref", `refs/remotes/${name}/HEAD`], rootDir, 5000)).trim();
          // symbolic-ref returns full ref like refs/remotes/origin/main
          remoteRef = headRef.replace(/^refs\/remotes\//, "");
        } catch {
          // Try common defaults
          try {
            await runGitCommand(["rev-parse", "--verify", `${name}/main`], rootDir, 5000);
            remoteRef = `${name}/main`;
          } catch {
            try {
              await runGitCommand(["rev-parse", "--verify", `${name}/master`], rootDir, 5000);
              remoteRef = `${name}/master`;
            } catch {
              // Remote exists but no common branch found
              res.json([]);
              return;
            }
          }
        }
      }

      const commits = await getRemoteCommits(remoteRef, limit, rootDir);
      res.json(commits);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/branches
   * Returns all local branches with current indicator, remote tracking info, and last commit date.
   * Response: Array of GitBranch objects
   */
  router.get("/git/branches", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const branches = await getGitBranches(rootDir);
      res.json(branches);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/branches/:name/commits
   * Returns recent commits for a specific branch.
   * Query params: limit (default 10, max 100)
   * Response: Array of GitCommit objects
   */
  router.get("/git/branches/:name/commits", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { name } = req.params;
      if (!isValidGitRef(name)) {
        throw badRequest("Invalid branch name");
      }
      const limit = Math.min(Math.max(parseInt(String(req.query.limit)) || 10, 1), 100);
      const commits = await getGitCommitsForBranch(name, limit, rootDir);
      res.json(commits);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/worktrees
   * Returns all worktrees with path, branch, isMain, and associated task ID.
   * Response: Array of GitWorktree objects
   */
  router.get("/git/worktrees", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      // Get tasks to correlate with worktrees
      const tasks = await scopedStore.listTasks({ slim: true, includeArchived: false });
      const worktrees = await getGitWorktrees(tasks, rootDir);
      res.json(worktrees);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

// ── Git Action Routes ─────────────────────────────────────────────

  /**
   * POST /api/git/branches
   * Create a new branch from current HEAD or specified base.
   * Body: { name: string, base?: string }
   */
  router.post("/git/branches", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { name, base } = req.body;
      if (!name || typeof name !== "string") {
        throw badRequest("name is required");
      }
      const branchName = await createGitBranch(name, base, rootDir);
      res.status(201).json({ name: branchName, created: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("Invalid branch name")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("already exists")) {
        throw conflict(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/git/branches/:name/checkout
   * Checkout an existing branch.
   */
  router.post("/git/branches/:name/checkout", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { name } = req.params;
      await checkoutGitBranch(name, rootDir);
      res.json({ checkedOut: name });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("Invalid branch name")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("Uncommitted changes")) {
        throw conflict(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * DELETE /api/git/branches/:name
   * Delete a branch.
   * Query: ?force=true to force delete (even with unmerged commits)
   */
  router.delete("/git/branches/:name", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { name } = req.params;
      const force = req.query.force === "true";
      await deleteGitBranch(name, force, rootDir);
      res.json({ deleted: name });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("Invalid branch name")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("Cannot delete branch") || (err instanceof Error ? err.message : String(err)).includes("is currently checked out")) {
        throw conflict(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("not fully merged")) {
        throw conflict("Branch has unmerged commits. Use force=true to delete anyway.");
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/git/fetch
   * Fetch from origin or specified remote.
   * Body: { remote?: string }
   */
  router.post("/git/fetch", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { remote } = req.body;
      const result = await fetchGitRemote(remote || "origin", rootDir);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("Invalid remote name")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("Failed to connect")) {
        throw new ApiError(503, err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/git/pull
   * Pull the current branch.
   */
  router.post("/git/pull", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const result = await pullGitBranch(rootDir);
      if (result.conflict) {
        throw new ApiError(409, result.message ?? "Merge conflict detected. Resolve manually.", {
          ...result,
        });
      }
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/git/push
   * Push the current branch.
   */
  router.post("/git/push", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const result = await pushGitBranch(rootDir);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("rejected") || (err instanceof Error ? err.message : String(err)).includes("Pull latest")) {
        throw conflict(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("Failed to connect")) {
        throw new ApiError(503, err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

// ── Git Stash, Stage, Commit Routes ────────────────────────────────

  /**
   * GET /api/git/stashes
   * Returns list of stash entries.
   */
  router.get("/git/stashes", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const stashes = await getGitStashList(rootDir);
      res.json(stashes);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/git/stashes
   * Create a new stash.
   * Body: { message?: string }
   */
  router.post("/git/stashes", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { message } = req.body;
      const result = await createGitStash(message, rootDir);
      res.status(201).json({ message: result });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("No local changes")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/git/stashes/:index/apply
   * Apply a stash entry.
   * Body: { drop?: boolean }
   */
  router.post("/git/stashes/:index/apply", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const index = parseInt(req.params.index, 10);
      if (isNaN(index) || index < 0) {
        throw badRequest("Invalid stash index");
      }
      const { drop } = req.body;
      const result = await applyGitStash(index, drop === true, rootDir);
      res.json({ message: result });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * DELETE /api/git/stashes/:index
   * Drop a stash entry.
   */
  router.delete("/git/stashes/:index", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const index = parseInt(req.params.index, 10);
      if (isNaN(index) || index < 0) {
        throw badRequest("Invalid stash index");
      }
      const result = await dropGitStash(index, rootDir);
      res.json({ message: result });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/diff
   * Returns working directory diff (unstaged changes).
   */
  router.get("/git/diff", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const diff = await getGitWorkingDiff(rootDir);
      res.json(diff);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/diff/file
   * Returns staged or unstaged diff for a specific file.
   * Query: path=<file-path>&staged=true|false
   */
  router.get("/git/diff/file", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }

      const rawPath = req.query.path;
      const rawStaged = req.query.staged;

      if (typeof rawPath !== "string" || !rawPath.trim()) {
        throw badRequest("path query parameter is required");
      }
      if (rawStaged !== "true" && rawStaged !== "false") {
        throw badRequest("staged query parameter must be 'true' or 'false'");
      }
      if (!isValidGitFilePath(rawPath)) {
        throw badRequest(`Invalid file path: ${rawPath}`);
      }

      const diff = await getGitFileDiff(rawPath, rawStaged === "true", rootDir);
      res.json(diff);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/git/changes
   * Returns file changes (staged and unstaged).
   */
  router.get("/git/changes", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const changes = await getGitFileChanges(rootDir);
      res.json(changes);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/git/stage
   * Stage specific files.
   * Body: { files: string[] }
   */
  router.post("/git/stage", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { files } = req.body;
      if (!Array.isArray(files) || files.length === 0) {
        throw badRequest("files array is required");
      }
      const staged = await stageGitFiles(files, rootDir);
      res.json({ staged });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/git/unstage
   * Unstage specific files.
   * Body: { files: string[] }
   */
  router.post("/git/unstage", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { files } = req.body;
      if (!Array.isArray(files) || files.length === 0) {
        throw badRequest("files array is required");
      }
      const unstaged = await unstageGitFiles(files, rootDir);
      res.json({ unstaged });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/git/commit
   * Create a commit with staged changes.
   * Body: { message: string }
   */
  router.post("/git/commit", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { message } = req.body;
      if (!message || typeof message !== "string" || !message.trim()) {
        throw badRequest("Commit message is required");
      }
      const result = await createGitCommit(message, rootDir);
      res.status(201).json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("No staged changes")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/git/discard
   * Discard working directory changes for specific files.
   * Body: { files: string[] }
   */
  router.post("/git/discard", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      if (!(await isGitRepo(rootDir))) {
        throw badRequest("Not a git repository");
      }
      const { files } = req.body;
      if (!Array.isArray(files) || files.length === 0) {
        throw badRequest("files array is required");
      }
      const discarded = await discardGitChanges(files, rootDir);
      res.json({ discarded });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

// ── GitHub Import Routes ──────────────────────────────────────────

  /**
   * POST /api/github/issues/fetch
   * Fetch open issues from a GitHub repository.
   * Body: { owner: string, repo: string, limit?: number, labels?: string[] }
   * Returns: Array of GitHubIssue objects (filtered, no PRs)
   */
  router.post("/github/issues/fetch", async (req, res) => {
    try {
      const { owner, repo, limit = 30, labels } = req.body;

      if (!owner || typeof owner !== "string") {
        throw badRequest("owner is required");
      }
      if (!repo || typeof repo !== "string") {
        throw badRequest("repo is required");
      }

      // Check gh authentication
      if (!isGhAuthenticated()) {
        throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
      }

      const client = new GitHubClient();

      try {
        const issues = await client.listIssues(owner, repo, { limit, labels });
        res.json(issues);
      } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
        // Handle specific error cases from gh CLI
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (errorMessage.includes("not found") || errorMessage.includes("404")) {
          throw notFound(`Repository not found: ${owner}/${repo}`);
        }
        if (errorMessage.includes("authentication") || errorMessage.includes("401") || errorMessage.includes("403")) {
          throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
        }

        throw new ApiError(502, `GitHub CLI error: ${errorMessage}`);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/github/issues/import
   * Import a specific GitHub issue as a fn task.
   * Body: { owner: string, repo: string, issueNumber: number }
   * Returns: Created Task object
   */
  router.post("/github/issues/import", async (req, res) => {
    try {
      const { owner, repo, issueNumber } = req.body;

      if (!owner || typeof owner !== "string") {
        throw badRequest("owner is required");
      }
      if (!repo || typeof repo !== "string") {
        throw badRequest("repo is required");
      }
      if (!issueNumber || typeof issueNumber !== "number" || issueNumber < 1) {
        throw badRequest("issueNumber is required and must be a positive number");
      }

      // Check gh authentication
      if (!isGhAuthenticated()) {
        throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
      }

      const client = new GitHubClient();
      const { store: scopedStore } = await getProjectContext(req);

      let issue: {
        number: number;
        title: string;
        body: string | null;
        html_url: string;
        state: "open" | "closed";
      } | null;

      try {
        issue = await client.getIssue(owner, repo, issueNumber);

        // getIssue returns null when the issue doesn't exist OR when it's a PR
        // We return a 400 error indicating it might be a PR (consistent with old behavior)
        if (issue === null) {
          throw badRequest(`#${issueNumber} is a pull request, not an issue`);
        }
      } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
        const errorMessage = err instanceof Error ? err.message : String(err);
        
        if (errorMessage.includes("not found") || errorMessage.includes("404")) {
          throw notFound(`Issue #${issueNumber} not found in ${owner}/${repo}`);
        }
        if (errorMessage.includes("authentication") || errorMessage.includes("401") || errorMessage.includes("403")) {
          throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
        }

        throw new ApiError(502, `GitHub CLI error: ${errorMessage}`);
      }

      // Check if already imported
      const existingTasks = await scopedStore.listTasks({ slim: true, includeArchived: false });
      const sourceUrl = issue.html_url;
      for (const existingTask of existingTasks) {
        if (existingTask.description.includes(sourceUrl)) {
          throw new ApiError(409, `Issue #${issueNumber} already imported as ${existingTask.id}`, {
            existingTaskId: existingTask.id,
          });
        }
      }

      // Create the task
      const title = issue.title.slice(0, 200);
      const body = issue.body?.trim() || "(no description)";
      const description = `${body}\n\nSource: ${sourceUrl}`;

      const task = await scopedStore.createTask({
        title: title || undefined,
        description,
        column: "triage",
        dependencies: [],
      });

      // Log the import action
      await scopedStore.logEntry(task.id, "Imported from GitHub", sourceUrl);

      res.status(201).json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/github/issues/batch-import
   * Import multiple GitHub issues as fn tasks with throttling.
   * Body: { owner: string, repo: string, issueNumbers: number[], delayMs?: number }
   * Returns: { results: BatchImportResult[] }
   */
  // Batch import rate limiter: max 1 request per 10 seconds per IP
  const batchImportRateLimiter = (() => {
    const clients = new Map<string, number>();
    batchImportInstances.push(clients);

    if (!batchImportCleanupInterval) {
      batchImportCleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const instanceClients of batchImportInstances) {
          for (const [ip, resetTime] of instanceClients) {
            if (now >= resetTime) {
              instanceClients.delete(ip);
            }
          }
        }
      }, batchImportWindowMs);
      batchImportCleanupInterval.unref?.();
    }

    return (req: Request, res: Response, next: NextFunction): void => {
      const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
      const now = Date.now();

      const resetTime = clients.get(ip);
      if (resetTime && now < resetTime) {
        const retryAfter = Math.ceil((resetTime - now) / 1000);
        res.setHeader("Retry-After", String(retryAfter));
        throw rateLimited("Batch import rate limit exceeded. Try again in a few seconds.");
      }

      clients.set(ip, now + batchImportWindowMs);
      next();
    };
  })();

  router.post("/github/issues/batch-import", batchImportRateLimiter, async (req, res) => {
    try {
      const { owner, repo, issueNumbers, delayMs } = req.body;

      // Validate owner
      if (!owner || typeof owner !== "string") {
        throw badRequest("owner is required");
      }

      // Validate repo
      if (!repo || typeof repo !== "string") {
        throw badRequest("repo is required");
      }

      // Validate issueNumbers
      if (!Array.isArray(issueNumbers)) {
        throw badRequest("issueNumbers is required and must be an array");
      }

      if (issueNumbers.length === 0) {
        throw badRequest("issueNumbers must contain at least 1 issue number");
      }

      if (issueNumbers.length > 50) {
        throw badRequest("issueNumbers cannot contain more than 50 issue numbers");
      }

      if (!issueNumbers.every((n) => typeof n === "number" && n > 0 && Number.isInteger(n))) {
        throw badRequest("issueNumbers must contain only positive integers");
      }

      const token = process.env.GITHUB_TOKEN;
      const githubClient = new GitHubClient(token);
      const { store: scopedStore } = await getProjectContext(req);

      // Get existing tasks to check for duplicates
      const existingTasks = await scopedStore.listTasks({ slim: true, includeArchived: false });

      // Process issues sequentially with throttling
      const results: Array<{
        issueNumber: number;
        success: boolean;
        taskId?: string;
        error?: string;
        skipped?: boolean;
        retryAfter?: number;
      }> = [];

      for (const issueNumber of issueNumbers) {
        const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`;

        // Use throttled fetch to avoid rate limits
        const fetchResult = await githubClient.fetchThrottled<{
          number: number;
          title: string;
          body: string | null;
          html_url: string;
          pull_request?: unknown;
        }>(url, {}, { delayMs: delayMs ?? 1000, maxRetries: 3 });

        if (!fetchResult.success) {
          results.push({
            issueNumber,
            success: false,
            error: fetchResult.error ?? "Failed to fetch issue",
            retryAfter: fetchResult.retryAfter,
          });
          continue;
        }

        const issue = fetchResult.data!;

        // Check if it's a pull request
        if (issue.pull_request) {
          results.push({
            issueNumber,
            success: false,
            error: "This is a pull request, not an issue",
          });
          continue;
        }

        // Check if already imported
        const sourceUrl = issue.html_url;
        const existingTask = existingTasks.find((t) => t.description.includes(sourceUrl));
        if (existingTask) {
          results.push({
            issueNumber,
            success: true,
            skipped: true,
            taskId: existingTask.id,
          });
          continue;
        }

        // Create the task
        const title = issue.title.slice(0, 200);
        const body = issue.body?.trim() || "(no description)";
        const description = `${body}\n\nSource: ${sourceUrl}`;

        try {
          const task = await scopedStore.createTask({
            title: title || undefined,
            description,
            column: "triage",
            dependencies: [],
          });

          // Log the import action
          await scopedStore.logEntry(task.id, "Imported from GitHub", sourceUrl);

          results.push({
            issueNumber,
            success: true,
            taskId: task.id,
          });

          // Add to existingTasks to avoid duplicate imports within the same batch
          existingTasks.push({ ...task, description });
        } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
          results.push({
            issueNumber,
            success: false,
            error: (err instanceof Error ? err.message : String(err)) || "Failed to create task",
          });
        }
      }

      res.json({ results });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/github/pulls/fetch
   * Fetch open pull requests from a GitHub repository.
   * Body: { owner: string, repo: string, limit?: number }
   * Returns: Array of GitHubPull objects
   */
  router.post("/github/pulls/fetch", async (req, res) => {
    try {
      const { owner, repo, limit = 30 } = req.body;

      if (!owner || typeof owner !== "string") {
        throw badRequest("owner is required");
      }
      if (!repo || typeof repo !== "string") {
        throw badRequest("repo is required");
      }

      // Check gh authentication
      if (!isGhAuthenticated()) {
        throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
      }

      const client = new GitHubClient();

      try {
        const pulls = await client.listPullRequests(owner, repo, { limit });
        res.json(pulls);
      } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
        // Handle specific error cases from gh CLI
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (errorMessage.includes("not found") || errorMessage.includes("404")) {
          throw notFound(`Repository not found: ${owner}/${repo}`);
        }
        if (errorMessage.includes("authentication") || errorMessage.includes("401") || errorMessage.includes("403")) {
          throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
        }

        throw new ApiError(502, `GitHub CLI error: ${errorMessage}`);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/github/pulls/import
   * Import a specific GitHub pull request as a fn review task.
   * Body: { owner: string, repo: string, prNumber: number }
   * Returns: Created Task object
   */
  router.post("/github/pulls/import", async (req, res) => {
    try {
      const { owner, repo, prNumber } = req.body;

      if (!owner || typeof owner !== "string") {
        throw badRequest("owner is required");
      }
      if (!repo || typeof repo !== "string") {
        throw badRequest("repo is required");
      }
      if (!prNumber || typeof prNumber !== "number" || prNumber < 1) {
        throw badRequest("prNumber is required and must be a positive number");
      }

      // Check gh authentication
      if (!isGhAuthenticated()) {
        throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
      }

      const client = new GitHubClient();
      const { store: scopedStore } = await getProjectContext(req);

      let pr: {
        number: number;
        title: string;
        body: string | null;
        html_url: string;
        headBranch: string;
        baseBranch: string;
        state: "open" | "closed" | "merged";
      } | null;

      try {
        pr = await client.getPullRequest(owner, repo, prNumber);

        if (pr === null) {
          throw notFound(`PR #${prNumber} not found in ${owner}/${repo}`);
        }
      } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (errorMessage.includes("not found") || errorMessage.includes("404")) {
          throw notFound(`PR #${prNumber} not found in ${owner}/${repo}`);
        }
        if (errorMessage.includes("authentication") || errorMessage.includes("401") || errorMessage.includes("403")) {
          throw unauthorized("Not authenticated with GitHub. Run `gh auth login`.");
        }

        throw new ApiError(502, `GitHub CLI error: ${errorMessage}`);
      }

      // Check if already imported
      const existingTasks = await scopedStore.listTasks({ slim: true, includeArchived: false });
      const sourceUrl = pr.html_url;
      for (const existingTask of existingTasks) {
        if (existingTask.description.includes(sourceUrl)) {
          throw new ApiError(409, `PR #${prNumber} already imported as ${existingTask.id}`, {
            existingTaskId: existingTask.id,
          });
        }
      }

      // Create the task with "Review PR:" prefix
      const title = `Review PR #${pr.number}: ${pr.title.slice(0, 180)}`;
      const body = pr.body?.trim() || "(no description)";
      const description = `Review and address any issues in this pull request.\n\nPR: ${sourceUrl}\nBranch: ${pr.headBranch} → ${pr.baseBranch}\n\n${body}`;

      const task = await scopedStore.createTask({
        title: title || undefined,
        description,
        column: "triage",
        dependencies: [],
      });

      // Log the import action
      await scopedStore.logEntry(task.id, "Imported PR from GitHub", sourceUrl);

      res.status(201).json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ---------- Auth routes ----------
  registerAuthRoutes(router, options?.authStorage, store, options);

  /**
   * POST /api/github/webhooks
   * GitHub App webhook endpoint for badge updates.
   * Accepts signed webhook deliveries for pull_request, issues, and issue_comment events.
   * Verifies X-Hub-Signature-256, fetches canonical badge state, and updates matching tasks.
   * 
   * Responses:
   * - 200: Valid ping event
   * - 202: Valid but unsupported/irrelevant event
   * - 401: Missing required webhook auth headers
   * - 403: Signature mismatch/tampering detected
   * - 503: GitHub App configuration missing or incomplete
   * - 500: Installation token refresh failed
   */
  router.post("/github/webhooks", async (req, res) => {
    const config = getGitHubAppConfig();
    if (!config) {
      throw new ApiError(503, "GitHub App not configured");
    }

    // Get raw body (Buffer from express.raw() middleware)
    const rawBody = req.body as Buffer;
    if (!Buffer.isBuffer(rawBody)) {
      throw badRequest("Invalid request body");
    }

    // Verify signature
    const signatureHeader = req.headers["x-hub-signature-256"] as string | undefined;
    const verification = verifyWebhookSignature(rawBody, signatureHeader, config.webhookSecret);
    if (!verification.valid) {
      throw new ApiError(403, verification.error ?? "Invalid signature");
    }

    // Parse payload after verification
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf-8"));
    } catch {
      throw badRequest("Invalid JSON payload");
    }

    // Classify event
    const eventType = req.headers["x-github-event"] as string | undefined;
    const classification = classifyWebhookEvent(eventType, payload);

    // Handle ping
    if (eventType === "ping") {
      res.status(200).json({ message: "Pong" });
      return;
    }

    // Unsupported event
    if (!classification.supported) {
      res.status(202).json({ message: "Event type not supported" });
      return;
    }

    // Not relevant for badge updates (e.g., issue_comment on regular issue)
    if (!classification.relevant) {
      res.status(202).json({ message: "Event not relevant for badges" });
      return;
    }

    // Missing required data
    if (!classification.owner || !classification.repo || classification.number === undefined || !classification.installationId) {
      throw badRequest("Missing repository or installation data");
    }

    // Fetch installation token
    const installationToken = await GitHubClient.fetchInstallationToken(
      classification.installationId,
      config.appId,
      config.privateKey,
    );
    if (!installationToken) {
      throw internalError("Failed to fetch installation token");
    }

    // Fetch canonical badge state
    let badgeData: Omit<PrInfo, "lastCheckedAt"> | Omit<import("@fusion/core").IssueInfo, "lastCheckedAt"> | null = null;
    if (classification.resourceType === "pr") {
      badgeData = await GitHubClient.fetchPrWithInstallationToken(
        classification.owner,
        classification.repo,
        classification.number,
        installationToken,
      );
    } else {
      badgeData = await GitHubClient.fetchIssueWithInstallationToken(
        classification.owner,
        classification.repo,
        classification.number,
        installationToken,
      );
    }

    if (!badgeData) {
      res.status(202).json({ message: "Badge resource not found or inaccessible" });
      return;
    }

    // Find all matching tasks by badge URL (use project-scoped store if projectId is provided)
    const { store: scopedStore } = await getProjectContext(req);
    const tasks = await scopedStore.listTasks({ slim: true, includeArchived: false });
    const matchingTasks: Array<{ id: string; resourceType: "pr" | "issue"; current: unknown }> = [];

    for (const task of tasks) {
      if (classification.resourceType === "pr" && task.prInfo) {
        const parsed = parseBadgeUrl(task.prInfo.url);
        if (parsed && 
            parsed.owner.toLowerCase() === classification.owner!.toLowerCase() &&
            parsed.repo.toLowerCase() === classification.repo!.toLowerCase() &&
            parsed.number === classification.number) {
          matchingTasks.push({ id: task.id, resourceType: "pr", current: task.prInfo });
        }
      } else if (classification.resourceType === "issue" && task.issueInfo) {
        const parsed = parseBadgeUrl(task.issueInfo.url);
        if (parsed &&
            parsed.owner.toLowerCase() === classification.owner!.toLowerCase() &&
            parsed.repo.toLowerCase() === classification.repo!.toLowerCase() &&
            parsed.number === classification.number) {
          matchingTasks.push({ id: task.id, resourceType: "issue", current: task.issueInfo });
        }
      }
    }

    if (matchingTasks.length === 0) {
      res.status(202).json({ message: "No tasks linked to this resource" });
      return;
    }

    // Update matching tasks
    const checkedAt = new Date().toISOString();
    let badgeFieldsChanged = false;

    for (const match of matchingTasks) {
      if (match.resourceType === "pr") {
        const current = match.current as PrInfo;
        const next = { ...(badgeData as Omit<PrInfo, "lastCheckedAt">), lastCheckedAt: checkedAt };
        const changed = hasPrBadgeFieldsChanged(current, badgeData as Omit<PrInfo, "lastCheckedAt">);
        if (changed || current.lastCheckedAt !== checkedAt) {
          await scopedStore.updatePrInfo(match.id, next);
          if (changed) badgeFieldsChanged = true;
        }
      } else {
        const current = match.current as import("@fusion/core").IssueInfo;
        const next = { ...(badgeData as Omit<import("@fusion/core").IssueInfo, "lastCheckedAt">), lastCheckedAt: checkedAt };
        const changed = hasIssueBadgeFieldsChanged(current, badgeData as Omit<import("@fusion/core").IssueInfo, "lastCheckedAt">);
        if (changed || current.lastCheckedAt !== checkedAt) {
          await scopedStore.updateIssueInfo(match.id, next);
          if (changed) badgeFieldsChanged = true;
        }
      }
    }

    res.status(200).json({
      updated: matchingTasks.length,
      tasks: matchingTasks.map(m => m.id),
      badgeFieldsChanged,
    });
  });

  /**
   * POST /api/github/batch/status
   * Refresh issue/PR badge status for up to 100 tasks in grouped GitHub requests.
   * Body: { taskIds: string[] }
   */
  router.post("/github/batch/status", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { taskIds } = (req.body ?? {}) as import("@fusion/core").BatchStatusRequest;
      if (!Array.isArray(taskIds)) {
        throw badRequest("taskIds must be an array");
      }
      if (taskIds.some((taskId) => typeof taskId !== "string" || taskId.trim().length === 0)) {
        throw badRequest("taskIds must contain non-empty strings");
      }
      if (taskIds.length > 100) {
        throw badRequest("taskIds must contain at most 100 items");
      }
      if (taskIds.length === 0) {
        res.json({ results: {} } satisfies BatchStatusResponse);
        return;
      }

      const fallbackRepo = getDefaultGitHubRepo(scopedStore);
      const results: BatchStatusResult = {};
      const issueGroups = new Map<string, { owner: string; repo: string; numbers: Set<number>; taskIds: Set<string> }>();
      const prGroups = new Map<string, { owner: string; repo: string; numbers: Set<number>; taskIds: Set<string> }>();
      const tasksById = new Map<string, Awaited<ReturnType<TaskStore["getTask"]>>>();

      for (const taskId of taskIds) {
        try {
          const task = await scopedStore.getTask(taskId);
          tasksById.set(taskId, task);

          const entry = ensureBatchStatusEntry(results, taskId);
          if (task.issueInfo) entry.issueInfo = task.issueInfo;
          if (task.prInfo) entry.prInfo = task.prInfo;
          entry.stale = Boolean(
            (task.issueInfo && isBatchStatusStale(task.issueInfo, task.updatedAt))
            || (task.prInfo && isBatchStatusStale(task.prInfo, task.updatedAt)),
          );

          if (!task.issueInfo && !task.prInfo) {
            appendBatchStatusError(results, taskId, "Task has no GitHub badge metadata");
            continue;
          }

          if (task.issueInfo) {
            const issueRepo = parseGitHubBadgeUrl(task.issueInfo.url) ?? fallbackRepo;
            if (!issueRepo) {
              appendBatchStatusError(results, taskId, "Could not determine GitHub repository for issue badge");
            } else {
              const repoKey = `${issueRepo.owner}/${issueRepo.repo}`;
              const group = issueGroups.get(repoKey) ?? {
                owner: issueRepo.owner,
                repo: issueRepo.repo,
                numbers: new Set<number>(),
                taskIds: new Set<string>(),
              };
              group.numbers.add(task.issueInfo.number);
              group.taskIds.add(taskId);
              issueGroups.set(repoKey, group);
            }
          }

          if (task.prInfo) {
            const prRepo = parseGitHubBadgeUrl(task.prInfo.url) ?? fallbackRepo;
            if (!prRepo) {
              appendBatchStatusError(results, taskId, "Could not determine GitHub repository for PR badge");
            } else {
              const repoKey = `${prRepo.owner}/${prRepo.repo}`;
              const group = prGroups.get(repoKey) ?? {
                owner: prRepo.owner,
                repo: prRepo.repo,
                numbers: new Set<number>(),
                taskIds: new Set<string>(),
              };
              group.numbers.add(task.prInfo.number);
              group.taskIds.add(taskId);
              prGroups.set(repoKey, group);
            }
          }
        } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            appendBatchStatusError(results, taskId, `Task ${taskId} not found`);
          } else {
            appendBatchStatusError(results, taskId, err instanceof Error ? err.message : String(err) || `Failed to load task ${taskId}`);
          }
        }
      }

      const client = new GitHubClient(githubToken);
      const applyIssueGroup = async (group: { owner: string; repo: string; numbers: Set<number>; taskIds: Set<string> }) => {
        const repoKey = `${group.owner}/${group.repo}`;
        if (!githubRateLimiter.canMakeRequest(repoKey)) {
          const resetTime = githubRateLimiter.getResetTime(repoKey);
          const retryAfter = resetTime
            ? Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
            : undefined;
          throw new ApiError(429, "GitHub API rate limit exceeded for this repository", {
            retryAfter,
            resetAt: resetTime?.toISOString(),
          });
        }

        try {
          const issueStatuses = await client.getBatchIssueStatus(group.owner, group.repo, [...group.numbers]);
          const refreshedAt = new Date().toISOString();

          for (const taskId of group.taskIds) {
            const task = tasksById.get(taskId);
            if (!task?.issueInfo) continue;
            const issueInfo = issueStatuses.get(task.issueInfo.number);
            if (!issueInfo) {
              appendBatchStatusError(results, taskId, `Issue #${task.issueInfo.number} not found in ${group.owner}/${group.repo}`);
              continue;
            }

            const updatedIssueInfo: IssueInfo = {
              ...issueInfo,
              lastCheckedAt: refreshedAt,
            };
            await scopedStore.updateIssueInfo(taskId, updatedIssueInfo);
            const entry = ensureBatchStatusEntry(results, taskId);
            entry.issueInfo = updatedIssueInfo;
            entry.stale = entry.prInfo ? isBatchStatusStale(entry.prInfo, task.updatedAt) : false;
          }
        } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
          for (const taskId of group.taskIds) {
            appendBatchStatusError(results, taskId, (err instanceof Error ? err.message : String(err)) || `Failed to refresh issue badges for ${repoKey}`);
          }
        }

        return true;
      };

      const applyPrGroup = async (group: { owner: string; repo: string; numbers: Set<number>; taskIds: Set<string> }) => {
        const repoKey = `${group.owner}/${group.repo}`;
        if (!githubRateLimiter.canMakeRequest(repoKey)) {
          const resetTime = githubRateLimiter.getResetTime(repoKey);
          const retryAfter = resetTime
            ? Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
            : undefined;
          throw new ApiError(429, "GitHub API rate limit exceeded for this repository", {
            retryAfter,
            resetAt: resetTime?.toISOString(),
          });
        }

        try {
          const prStatuses = await client.getBatchPrStatus(group.owner, group.repo, [...group.numbers]);
          const refreshedAt = new Date().toISOString();

          for (const taskId of group.taskIds) {
            const task = tasksById.get(taskId);
            if (!task?.prInfo) continue;
            const prInfo = prStatuses.get(task.prInfo.number);
            if (!prInfo) {
              appendBatchStatusError(results, taskId, `PR #${task.prInfo.number} not found in ${group.owner}/${group.repo}`);
              continue;
            }

            const updatedPrInfo: PrInfo = {
              ...prInfo,
              lastCheckedAt: refreshedAt,
            };
            await scopedStore.updatePrInfo(taskId, updatedPrInfo);
            const entry = ensureBatchStatusEntry(results, taskId);
            entry.prInfo = updatedPrInfo;
            entry.stale = entry.issueInfo ? isBatchStatusStale(entry.issueInfo, task.updatedAt) : false;
          }
        } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
          for (const taskId of group.taskIds) {
            appendBatchStatusError(results, taskId, (err instanceof Error ? err.message : String(err)) || `Failed to refresh PR badges for ${repoKey}`);
          }
        }

        return true;
      };

      for (const group of issueGroups.values()) {
        const shouldContinue = await applyIssueGroup(group);
        if (!shouldContinue) return;
      }
      for (const group of prGroups.values()) {
        const shouldContinue = await applyPrGroup(group);
        if (!shouldContinue) return;
      }

      for (const taskId of taskIds) {
        ensureBatchStatusEntry(results, taskId);
      }

      res.json({ results } satisfies BatchStatusResponse);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to batch refresh GitHub status");
    }
  });

  // ── Terminal Routes ─────────────────────────────────────────────────

  /**
   * POST /api/terminal/exec
   * Execute a shell command in the project root directory.
   * Body: { command: string }
   * Returns: { sessionId: string }
   * 
   * Output is streamed via SSE at /api/terminal/sessions/:id/stream
   */
  router.post("/terminal/exec", async (req, res) => {
    try {
      const { command } = req.body;
      
      if (!command || typeof command !== "string") {
        throw badRequest("command is required and must be a string");
      }
      
      if (command.length > 4096) {
        throw badRequest("command exceeds maximum length of 4096 characters");
      }
      
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      const result = terminalSessionManager.createSession(command, rootDir);
      
      if (result.error) {
        throw new ApiError(403, result.error);
      }
      
      res.status(201).json({ sessionId: result.sessionId });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to execute command");
    }
  });

  /**
   * POST /api/terminal/sessions/:id/kill
   * Terminate a running terminal session.
   * Returns: { killed: boolean }
   */
  router.post("/terminal/sessions/:id/kill", (req, res) => {
    try {
      const { id } = req.params;
      const { signal } = req.body;
      
      const validSignals: NodeJS.Signals[] = ["SIGTERM", "SIGKILL", "SIGINT"];
      const killSignal = validSignals.includes(signal) ? signal : "SIGTERM";
      
      const killed = terminalSessionManager.killSession(id, killSignal);
      
      if (!killed) {
        const session = terminalSessionManager.getSession(id);
        if (!session) {
          throw notFound("Session not found");
        }
        throw badRequest("Session is not running");
      }

      res.json({ killed: true, sessionId: id });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/terminal/sessions/:id
   * Get session status and output history.
   * Returns: { id, command, running, exitCode, output }
   */
  router.get("/terminal/sessions/:id", (req, res) => {
    try {
      const session = terminalSessionManager.getSession(req.params.id);
      
      if (!session) {
        throw notFound("Session not found");
      }
      
      res.json({
        id: session.id,
        command: session.command,
        running: session.exitCode === null && !session.killed,
        exitCode: session.exitCode,
        output: session.output.join(""),
        startTime: session.startTime.toISOString(),
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/terminal/sessions/:id/stream
   * SSE endpoint for real-time terminal output streaming.
   * Events: terminal:output (stdout/stderr), terminal:exit
   */
  router.get("/terminal/sessions/:id/stream", (req, res) => {
    try {
      const { id } = req.params;
      const session = terminalSessionManager.getSession(id);
      
      if (!session) {
        throw notFound("Session not found");
      }

      // Set up SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering if present

      // Send initial connection event
      res.write(`event: connected\ndata: ${JSON.stringify({ sessionId: id })}\n\n`);

      // Handler for output events
      const onOutput = (event: import("./terminal.js").TerminalOutputEvent) => {
        if (event.sessionId !== id) return;
        
        const eventName = event.type === "exit" ? "terminal:exit" : "terminal:output";
        const data = JSON.stringify({
          type: event.type,
          data: event.data,
          ...(event.exitCode !== undefined && { exitCode: event.exitCode }),
        });
        
        res.write(`event: ${eventName}\ndata: ${data}\n\n`);
        
        // Close connection on exit after a brief delay to ensure client receives final data
        if (event.type === "exit") {
          setTimeout(() => {
            res.end();
          }, 100);
        }
      };

      // Subscribe to session manager events
      terminalSessionManager.on("output", onOutput);

      // Handle client disconnect
      req.on("close", () => {
        terminalSessionManager.off("output", onOutput);
      });

      // Handle errors
      req.on("error", () => {
        terminalSessionManager.off("output", onOutput);
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── PTY Terminal Routes (WebSocket-based) ────────────────────────────

  /**
   * POST /api/terminal/sessions
   * Create a new PTY terminal session.
   * Body: { cwd?: string, cols?: number, rows?: number }
   * Returns: { sessionId: string, shell: string, cwd: string }
   */
  router.post("/terminal/sessions", async (req, res) => {
    try {
      const { cwd, cols, rows } = req.body;
      const { store: scopedStore } = await getProjectContext(req);
      const terminalService = getTerminalService(scopedStore.getRootDir());

      const result = await terminalService.createSession({
        cwd,
        cols: typeof cols === "number" ? cols : undefined,
        rows: typeof rows === "number" ? rows : undefined,
      });

      if (!result.success) {
        const statusByCode = {
          max_sessions: 503,
          invalid_shell: 400,
          pty_load_failed: 503,
          pty_spawn_failed: 500,
        } as const;

        throw new ApiError(statusByCode[result.code], result.error, { code: result.code });
      }

      res.status(201).json({
        sessionId: result.session.id,
        shell: result.session.shell,
        cwd: result.session.cwd,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to create terminal session");
    }
  });

  /**
   * GET /api/terminal/sessions
   * List all active PTY terminal sessions.
   * Returns: [{ id: string, cwd: string, shell: string, createdAt: string }]
   */
  router.get("/terminal/sessions", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const terminalService = getTerminalService(scopedStore.getRootDir());
      const sessions = terminalService.getAllSessions();

      res.json(
        sessions.map((s) => ({
          id: s.id,
          cwd: s.cwd,
          shell: s.shell,
          createdAt: s.createdAt.toISOString(),
          lastActivityAt: s.lastActivityAt.toISOString(),
        }))
      );
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to list sessions");
    }
  });

  /**
   * DELETE /api/terminal/sessions/:id
   * Kill a PTY terminal session.
   * Returns: { killed: boolean }
   */
  router.delete("/terminal/sessions/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { store: scopedStore } = await getProjectContext(req);
      const terminalService = getTerminalService(scopedStore.getRootDir());

      const killed = terminalService.killSession(id);

      if (!killed) {
        const session = terminalService.getSession(id);
        if (!session) {
          throw notFound("Session not found");
        }
        throw badRequest("Failed to kill session");
      }

      res.json({ killed: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Workspace File API Routes ─────────────────────────────────────

  /**
   * GET /api/workspaces
   * List available file browser workspaces.
   * Returns: { project: string; tasks: Array<{ id: string; title?: string; worktree: string }> }
   */
  router.get("/workspaces", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const tasks = await scopedStore.listTasks({ slim: true, includeArchived: false });

      // Filter to tasks with valid worktrees, checking existence asynchronously
      // to avoid blocking the event loop
      const worktreeCheckPromises = tasks.map(async (task): Promise<{ id: string; title?: string; worktree: string } | null> => {
        if (typeof task.worktree !== "string" || task.worktree.length === 0) {
          return null;
        }
        try {
          await access(task.worktree);
          return {
            id: task.id,
            title: task.title,
            worktree: task.worktree,
          };
        } catch {
          return null;
        }
      });

      const workspaceTasks = (await Promise.all(worktreeCheckPromises)).filter(
        (t): t is { id: string; title?: string; worktree: string } => t !== null
      );

      res.json({
        project: scopedStore.getRootDir(),
        tasks: workspaceTasks,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  /**
   * GET /api/files
   * List files in the requested workspace. Defaults to the project root when omitted.
   * Query params: ?workspace=project|TASK-ID and ?path=relative/path for subdirectory navigation.
   * Returns: { path: string; entries: FileNode[] }
   */
  router.get("/files", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { path: subPath, workspace } = req.query;
      const workspaceId = typeof workspace === "string" && workspace.length > 0 ? workspace : "project";
      const result = await listWorkspaceFiles(scopedStore, workspaceId, typeof subPath === "string" ? subPath : undefined);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /**
   * GET /api/files/markdown-list
   * Recursively list markdown files in the project workspace.
   * Returns: { files: MarkdownFileEntry[] }
   */
  router.get("/files/markdown-list", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const showHiddenQuery = req.query.showHidden;
      const showHidden = showHiddenQuery === "1" || showHiddenQuery === "true";
      const result: MarkdownFileListResponse = await listProjectMarkdownFiles(scopedStore, { showHidden });
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /**
   * GET /api/files/search
   * Search for files matching a query in a workspace.
   * Query params: q (required, search query), workspace (default "project"), projectId (optional)
   * Returns: { files: Array<{ path: string; name: string }> }
   */
  router.get("/files/search", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const q = req.query.q;

      if (!q || typeof q !== "string" || q.trim().length === 0) {
        throw new ApiError(400, "Query parameter 'q' is required and must be a non-empty string");
      }

      const workspace = typeof req.query.workspace === "string" && req.query.workspace.length > 0
        ? req.query.workspace
        : "project";

      const result = await searchWorkspaceFiles(scopedStore, workspace, q);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /**
   * GET /api/files/{*filepath}
   * Read file contents from the requested workspace. Defaults to the project root when omitted.
   * Query param: ?workspace=project|TASK-ID
   * Returns: { content: string; mtime: string; size: number }
   */
  router.get("/files/{*filepath}", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const filePath = Array.isArray(req.params.filepath) ? req.params.filepath[0] : req.params.filepath ?? "";
      const workspace = typeof req.query.workspace === "string" && req.query.workspace.length > 0
        ? req.query.workspace
        : "project";
      const result = await readWorkspaceFile(scopedStore, workspace, filePath);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : err.code === "ETOOLARGE" ? 413
          : err.code === "EINVAL" && (err instanceof Error ? err.message : String(err)).includes("Binary file") ? 415
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  // ── File Operation Routes ─────────────────────────────────────────────
  // IMPORTANT: Operation routes must be defined BEFORE the generic write route.
  // Express matches routes in order, so wildcard routes would shadow specific
  // operation routes if defined first (e.g., POST /files/somefolder/delete
  // would match POST /files/{*filepath} with filepath="somefolder/delete").

  /**
   * Helper to extract filepath and workspace from request.
   */
  function extractFileParams(req: Request): { filePath: string; workspace: string } {
    const filePath = Array.isArray(req.params.filepath) ? req.params.filepath[0] : req.params.filepath ?? "";
    const workspace = typeof req.query.workspace === "string" && req.query.workspace.length > 0
      ? req.query.workspace
      : "project";
    return { filePath, workspace };
  }

  /**
   * POST /api/files/{*filepath}/copy
   * Copy a file or directory to a new location within the workspace.
   * Query param: ?workspace=project|TASK-ID
   * Body: { destination: string }
   * Returns: FileOperationResponse
   */
  router.post("/files/{*filepath}/copy", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { filePath, workspace } = extractFileParams(req);
      const { destination } = req.body;

      if (!destination || typeof destination !== "string") {
        throw badRequest("destination is required and must be a string");
      }

      const result = await copyWorkspaceFile(scopedStore, workspace, filePath, destination);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EEXIST" ? 409
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /**
   * POST /api/files/{*filepath}/move
   * Move a file or directory to a new location within the workspace.
   * Query param: ?workspace=project|TASK-ID
   * Body: { destination: string }
   * Returns: FileOperationResponse
   */
  router.post("/files/{*filepath}/move", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { filePath, workspace } = extractFileParams(req);
      const { destination } = req.body;

      if (!destination || typeof destination !== "string") {
        throw badRequest("destination is required and must be a string");
      }

      const result = await moveWorkspaceFile(scopedStore, workspace, filePath, destination);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EEXIST" ? 409
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /**
   * DELETE /api/files/{*filepath}
   * Note: This conflicts with the existing GET endpoint for files.
   * Instead, use POST /api/files/{*filepath}/delete to avoid route collision.
   * Delete a file or directory within the workspace.
   * Query param: ?workspace=project|TASK-ID
   * Returns: FileOperationResponse
   */
  router.post("/files/{*filepath}/delete", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { filePath, workspace } = extractFileParams(req);
      const result = await deleteWorkspaceFile(scopedStore, workspace, filePath);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /**
   * POST /api/files/{*filepath}/rename
   * Rename a file or directory within the workspace.
   * Query param: ?workspace=project|TASK-ID
   * Body: { newName: string }
   * Returns: FileOperationResponse
   */
  router.post("/files/{*filepath}/rename", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { filePath, workspace } = extractFileParams(req);
      const { newName } = req.body;

      if (!newName || typeof newName !== "string") {
        throw badRequest("newName is required and must be a string");
      }

      const result = await renameWorkspaceFile(scopedStore, workspace, filePath, newName);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EEXIST" ? 409
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /**
   * GET /api/files/{*filepath}/download
   * Download a single file from the workspace.
   * Query param: ?workspace=project|TASK-ID
   * Streams the file with Content-Disposition header.
   */
  router.get("/files/{*filepath}/download", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { filePath, workspace } = extractFileParams(req);
      const { absolutePath, stats, fileName } = await getWorkspaceFileForDownload(scopedStore, workspace, filePath);

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.setHeader("Content-Length", stats.size);
      res.setHeader("Last-Modified", stats.mtime.toUTCString());

      const stream = createReadStream(absolutePath);
      stream.pipe(res);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EISDIR" ? 400
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /**
   * GET /api/files/{*filepath}/download-zip
   * Download a folder as a ZIP archive from the workspace.
   * Query param: ?workspace=project|TASK-ID
   * Streams the ZIP archive with Content-Disposition header.
   */
  router.get("/files/{*filepath}/download-zip", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { filePath, workspace } = extractFileParams(req);
      const { absolutePath, dirName } = await getWorkspaceFolderForZip(scopedStore, workspace, filePath);

      const archiver = await import("archiver");
      const archive = archiver.default("zip", { zlib: { level: 6 } });

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${dirName}.zip"`);

      archive.pipe(res);
      archive.directory(absolutePath, dirName);
      await archive.finalize();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "ENOTDIR" ? 400
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  // ── Generic File Write Route ────────────────────────────────────────────
  // This route must be defined AFTER all operation routes to avoid shadowing.
  // Express matches routes in order, so this wildcard route would catch
  // /copy, /move, /delete, /rename, etc. if defined first.

  /**
   * POST /api/files/{*filepath}
   * Write file contents to the requested workspace. Defaults to the project root when omitted.
   * Query param: ?workspace=project|TASK-ID
   * Body: { content: string }
   * Returns: { success: true; mtime: string; size: number }
   */
  router.post("/files/{*filepath}", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const filePath = Array.isArray(req.params.filepath) ? req.params.filepath[0] : req.params.filepath ?? "";
      const { content } = req.body;
      const workspace = typeof req.query.workspace === "string" && req.query.workspace.length > 0
        ? req.query.workspace
        : "project";

      if (typeof content !== "string") {
        throw badRequest("content is required and must be a string");
      }

      const result = await writeWorkspaceFile(scopedStore, workspace, filePath, content);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : err.code === "ETOOLARGE" ? 413
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

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
      // 2. Project titleSummarizer override (titleSummarizerProvider + titleSummarizerModelId)
      // 3. Global summarization lane (titleSummarizerGlobalProvider + titleSummarizerGlobalModelId)
      // 4. Default pair (defaultProvider + defaultModelId)
      // 5. Automatic model resolution (no explicit model)
      const settings = await scopedStore.getSettings();

      const resolvedProvider =
        (provider && modelId ? provider : undefined) ||
        (settings.titleSummarizerProvider && settings.titleSummarizerModelId ? settings.titleSummarizerProvider : undefined) ||
        (settings.titleSummarizerGlobalProvider && settings.titleSummarizerGlobalModelId ? settings.titleSummarizerGlobalProvider : undefined) ||
        (settings.defaultProvider && settings.defaultModelId ? settings.defaultProvider : undefined);

      const resolvedModelId =
        (provider && modelId ? modelId : undefined) ||
        (settings.titleSummarizerProvider && settings.titleSummarizerModelId ? settings.titleSummarizerModelId : undefined) ||
        (settings.titleSummarizerGlobalProvider && settings.titleSummarizerGlobalModelId ? settings.titleSummarizerGlobalModelId : undefined) ||
        (settings.defaultProvider && settings.defaultModelId ? settings.defaultModelId : undefined);

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

  /**
   * GET /api/usage
   * Fetch AI provider subscription usage (Claude, Codex, Gemini).
   * Returns: { providers: ProviderUsage[] }
   * 
   * Cached for 30 seconds to avoid hitting provider API rate limits.
   * Each provider's status is independent — one failure doesn't break all.
   */
  router.get("/usage", async (_req, res) => {
    try {
      const providers = await fetchAllProviderUsage(options?.authStorage);
      res.json({ providers });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to fetch usage data");
    }
  });

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
      let result: import("@fusion/core").AutomationRunResult;

      if (schedule.steps && schedule.steps.length > 0) {
        // Multi-step execution
        result = await executeScheduleSteps(schedule, startedAt);
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
        let createFnAgent = createFnAgentForRefine;
        if (!createFnAgent) {
          // Dynamic import to avoid resolution issues in tests
          const engineModule = "@fusion/engine";
          const engine = await import(/* @vite-ignore */ engineModule);
          createFnAgent = engine.createFnAgent;
        }

        const settings = await scopedStore.getSettings();

        // Resolve the system prompt using prompt overrides (with fallback to default)
        const systemPrompt = resolveWorkflowStepRefinePrompt(
          "workflow-step-refine",
          settings.promptOverrides
        ) || DEFAULT_WORKFLOW_STEP_REFINE_PROMPT;

        if (!createFnAgent) {
          throw new Error("createFnAgent is not available");
        }
        const { session } = await createFnAgent({
          cwd: scopedStore.getRootDir(),
          systemPrompt,
          tools: "readonly",
          // Resolve planning model using canonical lane hierarchy:
          // 1. Project planning override (planningProvider + planningModelId)
          // 2. Global planning lane (planningGlobalProvider + planningGlobalModelId)
          // 3. Default pair (defaultProvider + defaultModelId)
          defaultProvider: (settings.planningProvider && settings.planningModelId
            ? settings.planningProvider
            : (settings.planningGlobalProvider && settings.planningGlobalModelId
                ? settings.planningGlobalProvider
                : settings.defaultProvider)),
          defaultModelId: (settings.planningProvider && settings.planningModelId
            ? settings.planningModelId
            : (settings.planningGlobalProvider && settings.planningGlobalModelId
                ? settings.planningGlobalModelId
                : settings.defaultModelId)),
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

      const parentPath = resolvedPath === "/" ? null : dirname(resolvedPath);

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
      if (shouldClose) await central.init();
      
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
      if (shouldClose) await central.init();

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
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      
      const projects = await central.listProjects();
      await central.close();
      
      const hasProjects = projects.length > 0;
      const singleProjectPath = projects.length === 1 ? projects[0].path : null;
      
      res.json({ hasProjects, singleProjectPath });
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
      const { FirstRunDetector } = await import("@fusion/core");
      const { CentralCore } = await import("@fusion/core");

      const detector = new FirstRunDetector();
      const state = await detector.detectFirstRunState();
      const detectedProjects = await detector.detectExistingProjects(process.cwd());

      // Get central DB info
      const central = new CentralCore();
      await central.init();
      const projects = await central.listProjects();
      await central.close();

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

      const central = new CentralCore();
      await central.init();

      try {
        const coordinator = new MigrationCoordinator(central);
        const result = await coordinator.completeSetup(projects);

        res.json({
          success: result.success,
          projectsRegistered: result.projectsRegistered,
          errors: result.errors,
        });
      } finally {
        await central.close();
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

  // Remote node proxy routes are registered by registerProxyRoutes().

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
  const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
  const MAX_BUFFER = 1024 * 1024;
  const MAX_OUTPUT = 10240;

  try {
    const { stdout, stderr } = await execAsyncFn(command, {
      timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      shell: "/bin/sh",
    });

    let output = stdout;
    if (stderr) {
      output += stdout ? "\n--- stderr ---\n" : "";
      output += stderr;
    }
    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + "\n[output truncated]";
    }

    return { success: true, output, startedAt, completedAt: new Date().toISOString() };
  } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
    const execErr = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    const stdout = execErr.stdout ?? "";
    const stderr = execErr.stderr ?? "";
    let output = stdout;
    if (stderr) {
      output += stdout ? "\n--- stderr ---\n" : "";
      output += stderr;
    }
    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + "\n[output truncated]";
    }

    return {
      success: false,
      output,
      error: execErr.killed
        ? `Command timed out after ${(timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`
        : (err instanceof Error ? err.message : String(err)),
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
): Promise<import("@fusion/core").AutomationRunResult> {
  const steps = schedule.steps!;
  const stepResults: import("@fusion/core").AutomationStepResult[] = [];
  let overallSuccess = true;
  let stoppedEarly = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepStartedAt = new Date().toISOString();
    const timeoutMs = step.timeoutMs ?? schedule.timeoutMs ?? 300000;

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
      // AI prompt steps return a placeholder in manual run mode
      const model = step.modelProvider && step.modelId
        ? `${step.modelProvider}/${step.modelId}`
        : "default";
      stepResult = {
        stepId: step.id,
        stepName: step.name,
        stepIndex: i,
        success: !!step.prompt?.trim(),
        output: step.prompt?.trim()
          ? `[AI prompt step — model: ${model}]\nPrompt: ${step.prompt}`
          : "",
        error: step.prompt?.trim() ? undefined : "AI prompt step has no prompt specified",
        startedAt: stepStartedAt,
        completedAt: new Date().toISOString(),
      };
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
  if (output.length > 10240) {
    output = output.slice(0, 10240) + "\n[output truncated]";
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

function getDefaultGitHubRepo(store: TaskStore): { owner: string; repo: string } | null {
  const envRepo = process.env.GITHUB_REPOSITORY;
  if (envRepo) {
    const [owner, repo] = envRepo.split("/");
    if (owner && repo) {
      return { owner, repo };
    }
  }

  const rootDir = typeof store.getRootDir === "function" ? store.getRootDir() : process.cwd();
  return getCurrentRepo(rootDir);
}

function isBatchStatusStale(info: { lastCheckedAt?: string } | undefined, updatedAt?: string): boolean {
  const lastChecked = info?.lastCheckedAt ?? updatedAt;
  if (!lastChecked) return true;
  return Date.now() - new Date(lastChecked).getTime() > 5 * 60 * 1000;
}

function ensureBatchStatusEntry(results: BatchStatusResult, taskId: string): BatchStatusEntry {
  results[taskId] ??= { stale: true };
  return results[taskId];
}

function appendBatchStatusError(results: BatchStatusResult, taskId: string, message: string): void {
  const entry = ensureBatchStatusEntry(results, taskId);
  entry.error = entry.error ? `${entry.error}; ${message}` : message;
  entry.stale = true;
}

/**
 * Background PR refresh - updates PR status without blocking the response.
 * Silently logs errors without affecting the user experience.
 * Prefers badge URL for repo resolution to support multi-repo setups.
 */
async function refreshPrInBackground(store: TaskStore, taskId: string, currentPrInfo: PrInfo, token?: string): Promise<void> {
  try {
    // Get owner/repo from badge URL first, then fall back to env/git
    let owner: string;
    let repo: string;

    const badgeParsed = parseBadgeUrl(currentPrInfo.url);
    if (badgeParsed) {
      owner = badgeParsed.owner;
      repo = badgeParsed.repo;
    } else {
      const envRepo = process.env.GITHUB_REPOSITORY;
      if (envRepo) {
        const [o, r] = envRepo.split("/");
        owner = o;
        repo = r;
      } else {
        const gitRepo = getCurrentRepo(store.getRootDir());
        if (!gitRepo) return; // Silent fail - can't determine repo
        owner = gitRepo.owner;
        repo = gitRepo.repo;
      }
    }

    const repoKey = `${owner}/${repo}`;
    if (!githubRateLimiter.canMakeRequest(repoKey)) {
      return;
    }

    const client = new GitHubClient(token);

    const prInfo = await client.getPrStatus(owner, repo, currentPrInfo.number);
    prInfo.lastCheckedAt = new Date().toISOString();
    await store.updatePrInfo(taskId, prInfo);
  } catch {
    // Silent fail - background refresh is best-effort
  }
}

async function refreshIssueInBackground(
  store: TaskStore,
  taskId: string,
  currentIssueInfo: import("@fusion/core").IssueInfo,
  token?: string,
): Promise<void> {
  try {
    let owner: string;
    let repo: string;

    // Get owner/repo from badge URL first, then fall back to env/git
    const badgeParsed = parseBadgeUrl(currentIssueInfo.url);
    if (badgeParsed) {
      owner = badgeParsed.owner;
      repo = badgeParsed.repo;
    } else {
      const envRepo = process.env.GITHUB_REPOSITORY;
      if (envRepo) {
        const [o, r] = envRepo.split("/");
        owner = o;
        repo = r;
      } else {
        const gitRepo = getCurrentRepo(store.getRootDir());
        if (!gitRepo) return;
        owner = gitRepo.owner;
        repo = gitRepo.repo;
      }
    }

    const repoKey = `${owner}/${repo}`;
    if (!githubRateLimiter.canMakeRequest(repoKey)) {
      return;
    }

    const client = new GitHubClient(token);
    const issueInfo = await client.getIssueStatus(owner, repo, currentIssueInfo.number);
    if (!issueInfo) {
      return;
    }

    await store.updateIssueInfo(taskId, {
      ...issueInfo,
      lastCheckedAt: new Date().toISOString(),
    });
  } catch {
    // Silent fail - background refresh is best-effort
  }
}

/**
 * Register the GET /api/models route.
 * Returns available AI models from the ModelRegistry for the UI model selector,
 * along with favoriteProviders for UI ordering.
 * If no ModelRegistry is provided, returns an empty array.
 */
function registerModelsRoute(
  router: Router,
  modelRegistry?: ModelRegistryLike,
  store?: TaskStore,
  runtimeLogger: RuntimeLogger = createRuntimeLogger("models"),
): void {
  router.get("/models", async (_req, res) => {
    // Always return 200 with empty array instead of 404 when no models available.
    // This ensures the frontend can handle empty states gracefully.
    if (!modelRegistry) {
      res.json({ models: [], favoriteProviders: [], favoriteModels: [] });
      return;
    }

    try {
      modelRegistry.refresh();
      let models = modelRegistry.getAvailable().map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
      }));

      // Get favoriteProviders and favoriteModels from global settings
      let favoriteProviders: string[] = [];
      let favoriteModels: string[] = [];
      let useClaudeCli = false;
      if (store) {
        try {
          const globalStore = store.getGlobalSettingsStore();
          const globalSettings = await globalStore.getSettings();
          favoriteProviders = globalSettings.favoriteProviders ?? [];
          favoriteModels = globalSettings.favoriteModels ?? [];
          useClaudeCli = globalSettings.useClaudeCli === true;
        } catch {
          // Silently ignore settings errors - just return empty favorites
        }
      }

      // The vendored pi-claude-cli extension registers its provider as
      // "pi-claude-cli" (distinct from "anthropic") whenever it loads.
      // When the toggle is OFF, hide those entries from pickers so users
      // don't see CLI-routed models they haven't opted into. When ON,
      // surface everything so the CLI-routed entries appear alongside any
      // direct provider auth the user has connected.
      if (!useClaudeCli) {
        models = models.filter((m) => m.provider !== "pi-claude-cli");
      }

      res.json({ models, favoriteProviders, favoriteModels });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      runtimeLogger.warn(`Failed to load models: ${message}`);
      res.json({ models: [], favoriteProviders: [], favoriteModels: [] });
    }
  });
}

/**
 * Register authentication status, login, and logout routes.
 * Uses pi-coding-agent's AuthStorage for credential management.
 * If no AuthStorage is provided, authentication routes return an unavailable status.
 */
function registerAuthRoutes(
  router: Router,
  authStorage?: AuthStorageLike,
  store?: TaskStore,
  options?: ServerOptions,
): void {
  // Use injected AuthStorage or fail gracefully if not provided.
  // When running via the CLI/engine, AuthStorage is passed in via ServerOptions.
  function getAuthStorage(): AuthStorageLike {
    if (!authStorage) {
      throw new Error("Authentication is not configured");
    }
    return authStorage;
  }

  /**
   * Mask an API key for safe display.
   * - If key length <= 8: return 8 bullets (never reveal short keys)
   * - Otherwise: first 3 chars + 5 bullets + last 4 chars
   */
  function maskApiKey(key: string): string {
    if (key.length <= 8) {
      return "••••••••";
    }
    return key.slice(0, 3) + "•••••" + key.slice(-4);
  }

  /**
   * Track in-progress login flows to prevent concurrent logins for the same provider.
   * Maps provider ID → AbortController for the active login.
   */
  const loginInProgress = new Map<string, AbortController>();

  /**
   * GET /api/auth/status
   * Returns list of all providers with their authentication status and type.
   * Includes both OAuth-backed and API-key-backed providers.
   * Response: {
   *   providers: [{ id, name, authenticated, type, keyHint? }],
   *   ghCli: { available: boolean, authenticated: boolean }
   * }
   */
  router.get("/auth/status", async (_req, res) => {
    try {
      const storage = getAuthStorage();
      storage.reload();
      const oauthProviders = storage.getOAuthProviders();
      const providers: { id: string; name: string; authenticated: boolean; type: "oauth" | "api_key" | "cli"; keyHint?: string }[] = oauthProviders.map((p) => ({
        id: p.id,
        name: p.name,
        authenticated: storage.hasAuth(p.id),
        type: "oauth" as const,
      }));

      // Include API-key-backed providers if supported
      if (storage.getApiKeyProviders) {
        const apiKeyProviders = storage.getApiKeyProviders();
        for (const p of apiKeyProviders) {
          // Skip if already listed as an OAuth provider (avoid duplicates)
          if (providers.some((existing) => existing.id === p.id)) continue;
          let keyHint: string | undefined;
          if (storage.get) {
            const cred = storage.get(p.id);
            if (cred?.type === "api_key" && cred?.key) {
              keyHint = maskApiKey(cred.key);
            }
          }
          providers.push({
            id: p.id,
            name: p.name,
            authenticated: storage.hasApiKey ? storage.hasApiKey(p.id) : false,
            type: "api_key" as const,
            keyHint,
          });
        }
      }

      // Inject the synthetic "Anthropic — via Claude CLI" provider. Its
      // "authenticated" state is a product of three facts: the `claude`
      // binary must be on PATH, the user must have enabled useClaudeCli,
      // and the vendored extension must have loaded cleanly. We compute
      // them here once per /auth/status call so the provider list rendered
      // by onboarding + settings stays consistent with what a direct call
      // to /providers/claude-cli/status would return.
      if (store) {
        let enabled = false;
        try {
          const globalSettings = await store.getGlobalSettingsStore().getSettings();
          enabled = globalSettings.useClaudeCli === true;
        } catch {
          // Unreadable settings — fall through with enabled=false
        }
        const extension = options?.getClaudeCliExtensionStatus?.() ?? null;
        const binary = await probeClaudeCli();
        const extensionOk = extension === null || extension.status === "ok";
        providers.push({
          id: "claude-cli",
          name: "Anthropic — via Claude CLI",
          authenticated: enabled && binary.available && extensionOk,
          type: "cli" as const,
        });
      }

      const ghCli = {
        available: isGhAvailable(),
        authenticated: isGhAuthenticated(),
      };

      res.json({ providers, ghCli });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/providers/claude-cli/status
   * Dedicated diagnostic endpoint for the "Anthropic — via Claude CLI"
   * provider card. Runs three checks:
   *   1. `claude --version` binary probe (with short timeout)
   *   2. GlobalSettings.useClaudeCli toggle state
   *   3. Cached @fusion/pi-claude-cli extension resolution from the host
   *
   * Response fields are structured so the frontend can render a clear
   * "what's working, what isn't" breakdown without itself having to know
   * about pi internals.
   */
  /**
   * POST /api/auth/claude-cli
   * Enable or disable the "Anthropic — via Claude CLI" synthetic provider.
   * Body: { enabled: boolean }
   *
   * Rather than add yet another settings API, this delegates to the
   * existing PUT /api/settings/global path — same cache invalidation,
   * same onUseClaudeCliToggled hook firing, same downstream skill
   * backfill behavior. The thin wrapper exists so the frontend provider
   * card has a shape-appropriate endpoint ("turn this provider on/off")
   * without calling a generic settings route.
   *
   * When `enabled=true` is requested we probe the claude binary first
   * and refuse if it's missing — saving the user from a confusing state
   * where the toggle is "on" but nothing actually works.
   */
  router.post("/auth/claude-cli", async (req, res) => {
    try {
      if (!store) {
        throw new ApiError(500, "Settings store unavailable");
      }
      const enabled = req.body?.enabled;
      if (typeof enabled !== "boolean") {
        throw badRequest("enabled must be a boolean");
      }

      if (enabled) {
        const binary = await probeClaudeCli();
        if (!binary.available) {
          throw new ApiError(
            400,
            `Cannot enable Claude CLI routing: ${binary.reason ?? "claude binary not available"}`,
          );
        }
      }

      // Snapshot prior value so we only fire the toggle hook on an actual
      // transition — mirrors the logic in PUT /api/settings/global.
      let prev = false;
      try {
        const priorGlobal = await store.getGlobalSettingsStore().getSettings();
        prev = priorGlobal.useClaudeCli === true;
      } catch {
        // Unreadable prior — treat as false so a first enable still fires.
      }

      const settings = await store.updateGlobalSettings({ useClaudeCli: enabled });
      invalidateAllGlobalSettingsCaches();
      const engineManager = options?.engineManager;
      if (engineManager) {
        for (const engine of engineManager.getAllEngines().values()) {
          engine.getTaskStore().getGlobalSettingsStore().invalidateCache();
        }
      }

      const next = settings.useClaudeCli === true;
      if (options?.onUseClaudeCliToggled && prev !== next) {
        try {
          options.onUseClaudeCliToggled(prev, next);
        } catch (hookErr) {
          console.warn(
            `[auth/claude-cli] onUseClaudeCliToggled callback threw: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
          );
        }
      }

      res.json({
        enabled: next,
        // The pi-claude-cli extension is now always loaded; toggling
        // this setting only flips the /api/models filter, which takes
        // effect on the next picker fetch. No restart needed.
        restartRequired: false,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.get("/providers/claude-cli/status", async (_req, res) => {
    try {
      const binary = await probeClaudeCli();
      let enabled = false;
      if (store) {
        try {
          const globalSettings = await store.getGlobalSettingsStore().getSettings();
          enabled = globalSettings.useClaudeCli === true;
        } catch {
          // Best-effort: unreadable settings still allow the binary probe
          // to surface, just with enabled=false.
        }
      }
      const extension = options?.getClaudeCliExtensionStatus?.() ?? null;

      res.json({
        binary,
        enabled,
        extension,
        // Convenience field: the provider card considers everything "ready"
        // when the binary is available, the user has enabled the toggle,
        // AND the host loaded the extension without error. Surfacing this
        // keeps the UI render logic simple.
        ready:
          binary.available &&
          enabled &&
          (extension === null || extension.status === "ok"),
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/auth/login
   * Initiates OAuth login for a provider.
   * Body: { provider: string }
   * Response: { url: string, instructions?: string }
   *
   * The endpoint starts the OAuth flow and returns the auth URL from the
   * onAuth callback. The client should open this URL in a new tab and
   * poll GET /api/auth/status to detect completion.
   */
  router.post("/auth/login", async (req, res) => {
    try {
      const { provider } = req.body;
      if (!provider || typeof provider !== "string") {
        throw badRequest("provider is required");
      }

      // Prevent concurrent logins for the same provider
      if (loginInProgress.has(provider)) {
        throw conflict(`Login already in progress for ${provider}`);
      }

      const storage = getAuthStorage();
      const oauthProviders = storage.getOAuthProviders();
      const found = oauthProviders.find((p) => p.id === provider);
      if (!found) {
        throw badRequest(`Unknown provider: ${provider}`);
      }

      const abortController = new AbortController();
      loginInProgress.set(provider, abortController);

      // We need to get the URL from the onAuth callback before responding.
      // The login() call continues in the background until the user completes OAuth.
      let authResolve: (info: { url: string; instructions?: string }) => void;
      let authReject: (err: Error) => void;
      const authUrlPromise = new Promise<{ url: string; instructions?: string }>((resolve, reject) => {
        authResolve = resolve;
        authReject = reject;
      });

      // Start login flow in background — don't await the full login
      const loginPromise = storage.login(provider, {
        onAuth: (info) => {
          authResolve({ url: info.url, instructions: info.instructions });
        },
        onPrompt: async (prompt) => {
          // Web UI cannot interactively prompt — return empty string if allowed
          if (prompt.allowEmpty) return "";
          return prompt.placeholder || "";
        },
        onProgress: () => {}, // no-op for web UI
        signal: abortController.signal,
      });

      // Race: either we get the auth URL or the login completes/fails first
      const timeout = setTimeout(() => {
        authReject(new Error("Login initiation timed out"));
      }, 30_000);

      loginPromise
        .then(() => {
          // Login completed (user finished OAuth in browser)
        })
        .catch((err) => {
          // Login failed — also reject auth URL if not yet received
          authReject(err);
        })
        .finally(() => {
          clearTimeout(timeout);
          loginInProgress.delete(provider);
        });

      const authInfo = await authUrlPromise;
      clearTimeout(timeout);
      res.json({ url: authInfo.url, instructions: authInfo.instructions });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      // Clean up on error
      const provider = req.body?.provider;
      if (provider) loginInProgress.delete(provider);
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/auth/logout
   * Removes credentials for a provider.
   * Body: { provider: string }
   * Response: { success: true }
   */
  router.post("/auth/logout", (req, res) => {
    try {
      const { provider } = req.body;
      if (!provider || typeof provider !== "string") {
        throw badRequest("provider is required");
      }

      const storage = getAuthStorage();
      storage.logout(provider);
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/auth/api-key
   * Save an API key for an API-key-backed provider.
   * Body: { provider: string, apiKey: string }
   * Response: { success: true }
   *
   * Validates the provider exists, is API-key-backed, and the key is non-empty.
   * Never returns the key in any response.
   */
  router.post("/auth/api-key", (req, res) => {
    try {
      const { provider, apiKey } = req.body;
      if (!provider || typeof provider !== "string") {
        throw badRequest("provider is required");
      }
      if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
        throw badRequest("apiKey is required and must be a non-empty string");
      }

      const storage = getAuthStorage();

      // Check that the storage supports API key management
      if (!storage.setApiKey) {
        throw badRequest("API key management is not supported");
      }

      // Validate the provider is an API-key-backed provider
      const apiKeyProviders = storage.getApiKeyProviders?.() ?? [];
      const found = apiKeyProviders.find((p) => p.id === provider);
      if (!found) {
        throw badRequest(`Unknown API key provider: ${provider}`);
      }

      storage.setApiKey(provider, apiKey.trim());
      clearUsageCache();
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * DELETE /api/auth/api-key
   * Remove an API key for a provider.
   * Body: { provider: string }
   * Response: { success: true }
   */
  router.delete("/auth/api-key", (req, res) => {
    try {
      const { provider } = req.body;
      if (!provider || typeof provider !== "string") {
        throw badRequest("provider is required");
      }

      const storage = getAuthStorage();
      if (!storage.clearApiKey) {
        throw badRequest("API key management is not supported");
      }

      storage.clearApiKey(provider);
      clearUsageCache();
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });




}
