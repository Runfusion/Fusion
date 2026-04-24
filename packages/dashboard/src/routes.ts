import { Router, type Request, type Response, type NextFunction } from "express";

// Extend Express Request to include rawBody property set by webhook middleware
declare module "express" {
  interface Request {
    rawBody?: Buffer;
  }
}
import multer from "multer";
import { createReadStream, createWriteStream } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { resolve, sep, join } from "node:path";
import { tmpdir } from "node:os";
import * as nodeFs from "node:fs";
import { promisify } from "node:util";

const {
  mkdtemp,
  access,
  stat,
  mkdir,
  readdir,
  rm,
  readFile: fsReadFile,
  writeFile: fsWriteFile,
} = fsPromises;
import type { TaskStore, Column, ScheduleType, ActivityEventType, ModelPreset, MessageType, ParticipantType, RoutineTriggerType, ProjectSettings, EnrichedChatSession, PlanningSummary } from "@fusion/core";
import { COLUMNS, VALID_TRANSITIONS, GLOBAL_SETTINGS_KEYS, type BatchStatusEntry, type BatchStatusResponse, type BatchStatusResult, type IssueInfo, type PrInfo, type Task, type PiExtensionEntry, type PiExtensionSettings, getCurrentRepo, isGhAvailable, isGhAuthenticated, AutomationStore, validateBackupSchedule, validateBackupRetention, validateBackupDir, syncBackupRoutine, exportSettings, importSettings, validateImportData, MessageStore, validateMessageMetadata, RoutineStore, isWebhookTrigger, resolveMemoryBackend, getMemoryBackendCapabilities, listMemoryBackendTypes, listProjectMemoryFiles, readProjectMemoryFile, readProjectMemoryFileContent, writeProjectMemoryFile, listAgentMemoryFiles, readAgentMemoryFile, writeAgentMemoryFile, readMemory, writeMemory, searchProjectMemory, isQmdAvailable, installQmd, refreshQmdProjectMemoryIndex, QMD_INSTALL_COMMAND, MemoryBackendError, scheduleQmdProjectMemoryRefresh, discoverPiExtensions, updatePiExtensionDisabledIds, getFusionAgentDir, getLegacyPiAgentDir, ensureMemoryFileWithBackend, readInsightsMemory, writeInsightsMemory, generateMemoryAudit, buildInsightExtractionPrompt, parseInsightExtractionResponse, processAndAuditInsightExtraction } from "@fusion/core";
import type { ServerOptions } from "./server.js";
import { probeClaudeCli } from "./claude-cli-probe.js";
import { GitHubClient, parseBadgeUrl } from "./github.js";
import { githubRateLimiter } from "./github-poll.js";
import { terminalSessionManager } from "./terminal.js";
import { getTerminalService } from "./terminal-service.js";
import { listFiles, readFile, writeFile, listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile, searchWorkspaceFiles, copyWorkspaceFile, moveWorkspaceFile, deleteWorkspaceFile, renameWorkspaceFile, getWorkspaceFileForDownload, getWorkspaceFolderForZip, listProjectMarkdownFiles, scanMarkdownFiles, FileServiceError, type MarkdownFileListResponse } from "./file-service.js";
import { clearUsageCache, fetchAllProviderUsage } from "./usage.js";
import {
  getGitHubAppConfig,
  verifyWebhookSignature,
  classifyWebhookEvent,
  hasPrBadgeFieldsChanged,
  hasIssueBadgeFieldsChanged,
} from "./github-webhooks.js";
import { createMissionRouter } from "./mission-routes.js";
import { createRoadmapRouter } from "./roadmap-routes.js";
import { createInsightsRouter } from "./insights-routes.js";
import { getOrCreateProjectStore, invalidateAllGlobalSettingsCaches } from "./project-store-resolver.js";
import { AiSessionStore, SESSION_CLEANUP_DEFAULT_MAX_AGE_MS } from "./ai-session-store.js";
import { getSession as getPlanningSession, cleanupSession as cleanupPlanningSession } from "./planning.js";
import { getSubtaskSession, cleanupSubtaskSession } from "./subtask-breakdown.js";
import {
  startAgentGeneration,
  generateAgentSpec,
  getAgentGenerationSession,
  cleanupAgentGenerationSession,
  RateLimitError as AgentGenerationRateLimitError,
  SessionNotFoundError as AgentGenerationSessionNotFoundError,
} from "./agent-generation.js";
import { getMissionInterviewSession, cleanupMissionInterviewSession } from "./mission-interview.js";
import { getTargetInterviewSession, cleanupTargetInterviewSession } from "./milestone-slice-interview.js";
import { writeSSEEvent } from "./sse-buffer.js";
import { createDevServerRouter } from "./dev-server-routes.js";
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
import { rateLimit, RATE_LIMITS } from "./rate-limit.js";
import { resolvePluginManifest } from "./plugin-routes.js";
import { getAuthFileCandidates, getFusionAuthPath, type StoredAuthProvider } from "./auth-paths.js";
import { createRuntimeLogger, type RuntimeLogger } from "./runtime-logger.js";

const TASK_DETAIL_ACTIVITY_LOG_LIMIT = 500;

async function readStoredAuthProvidersFromDisk(): Promise<Record<string, StoredAuthProvider>> {
  for (const authJsonPath of getAuthFileCandidates()) {
    try {
      const authContent = await fsReadFile(authJsonPath, "utf-8");
      return JSON.parse(authContent) as Record<string, StoredAuthProvider>;
    } catch {
      // Try the next candidate, preferring .fusion and falling back to legacy .pi.
    }
  }
  return {};
}

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

function readJsonObject(path: string): Record<string, any> {
  if (!nodeFs.existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(nodeFs.readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, any> : {};
  } catch {
    return {};
  }
}

function hasPackageManagerSettings(settings: Record<string, any>): boolean {
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

/**
 * Extract RunMutationContext from the X-Run-Context header.
 * Used to correlate dashboard mutations with agent runs for audit trails.
 */
function _extractRunContext(req: { headers: { [key: string]: string | string[] | undefined } }): import("@fusion/core").RunMutationContext | undefined {
  const header = req.headers['x-run-context'];
  if (typeof header !== 'string') return undefined;
  try {
    const parsed = JSON.parse(header);
    if (parsed && typeof parsed.runId === 'string' && typeof parsed.agentId === 'string') {
      return parsed as import("@fusion/core").RunMutationContext;
    }
  } catch { /* invalid JSON, ignore */ }
  return undefined;
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
 * Stage specific files.
 */
async function stageGitFiles(files: string[], cwd?: string): Promise<string[]> {
  if (!files.length) throw new Error("No files specified");
  for (const f of files) {
    if (/[;&|`$(){}[\]\r\n]/.test(f)) {
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
    if (/[;&|`$(){}[\]\r\n]/.test(f)) {
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
    if (/[;&|`$(){}[\]\r\n]/.test(f)) {
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

export function createApiRoutes(store: TaskStore, options?: ServerOptions): Router {
  const router = Router();
  const runtimeLogger = options?.runtimeLogger?.child("routes") ?? createRuntimeLogger("routes");
  const planningLogger = runtimeLogger.child("planning");
  const proxyLogger = runtimeLogger.child("proxy");
  const chatLogger = runtimeLogger.child("chat");

  function prioritizeProjectsForCurrentDirectory<T extends { path: string }>(projects: T[]): T[] {
    const cwd = resolve(process.cwd());

    const rankProject = (projectPath: string): number => {
      const normalizedProjectPath = resolve(projectPath);
      if (normalizedProjectPath === cwd) {
        return Number.MAX_SAFE_INTEGER;
      }

      const prefix = normalizedProjectPath.endsWith(sep)
        ? normalizedProjectPath
        : `${normalizedProjectPath}${sep}`;

      if (!cwd.startsWith(prefix)) {
        return -1;
      }

      return normalizedProjectPath.length;
    };

    return [...projects].sort((a, b) => rankProject(b.path) - rankProject(a.path));
  }

  function getProjectIdFromRequest(req: Request): string | undefined {
    if (req.query && typeof req.query.projectId === "string" && req.query.projectId.length > 0) {
      return req.query.projectId;
    }
    if (req.body && typeof req.body.projectId === "string" && req.body.projectId.length > 0) {
      return req.body.projectId;
    }
    return undefined;
  }

  async function getScopedStore(req: Request): Promise<TaskStore> {
    const projectId = getProjectIdFromRequest(req);
    if (!projectId) return store;

    // Use the shared project-store resolver so mutations emit events
    // on the same EventEmitter that SSE listeners are attached to.
    return getOrCreateProjectStore(projectId);
  }

  /**
   * Forward an HTTP request to a remote node.
   * Validates the node exists, is remote, and has a URL, then proxies the request.
   * Always closes the CentralCore instance in a finally block.
   */
  async function proxyToRemoteNode(
    req: Request,
    res: Response,
    remotePath: string,
    options?: { timeoutMs?: number },
  ): Promise<void> {
    const nodeId = req.params.nodeId as string;
    const timeoutMs = options?.timeoutMs ?? 10_000;

    const { CentralCore } = await import("@fusion/core");
    const central = new CentralCore(store.getFusionDir());

    try {
      await central.init();

      const node = await central.getNode(nodeId);
      if (!node) {
        throw notFound("Node not found");
      }

      if (node.type === "local") {
        throw badRequest("Cannot proxy to local node");
      }

      if (!node.url) {
        throw badRequest("Node has no URL configured");
      }

      // Parse query string from original request URL
      const parsedUrl = new URL(req.url, "http://localhost");
      const queryString = parsedUrl.search;

      // Build target URL: node.url + /api + remotePath + queryString
      const targetPath = `/api${remotePath}${queryString}`;
      const targetUrl = new URL(targetPath, node.url).toString();

      // Build headers, injecting Authorization if apiKey is present
      const headers: Record<string, string> = {};
      if (node.apiKey) {
        headers["Authorization"] = `Bearer ${node.apiKey}`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(targetUrl, {
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // Filter out hop-by-hop headers that should not be forwarded
      const hopByHopHeaders = new Set([
        "transfer-encoding",
        "connection",
        "keep-alive",
        "upgrade",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
      ]);

      // Forward safe headers from remote response
      response.headers.forEach((value, key) => {
        if (!hopByHopHeaders.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });

      res.status(response.status);

      if (!response.body) {
        res.end();
        return;
      }

      // Convert web ReadableStream to Node Readable and pipe
      const { Readable } = await import("node:stream");
      const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);

      nodeStream.on("data", (chunk: Buffer) => {
        res.write(chunk);
      });

      nodeStream.on("end", () => {
        res.end();
      });

      nodeStream.on("error", (err: Error) => {
        // Log but don't crash — stream may already be closing
        proxyLogger.error(`Stream error for node ${nodeId}`, { error: err.message });
        if (!res.writableEnded) {
          res.end();
        }
      });
    } catch (err: unknown) {
      // Only send error response if headers haven't been sent yet
      if (res.headersSent) {
        return;
      }
      if (err instanceof Error && err.name === "AbortError") {
        res.status(504).json({ error: "Remote node timeout" });
      } else if (err instanceof TypeError) {
        // DNS failure, connection refused, etc.
        res.status(502).json({ error: "Remote node unreachable" });
      } else if (err instanceof ApiError) {
        throw err;
      } else {
        rethrowAsApiError(err, "Proxy request failed");
      }
    } finally {
      await central.close();
    }
  }

  interface ProjectContext {
    store: TaskStore;
    engine: import("@fusion/engine").ProjectEngine | undefined;
    projectId: string | undefined;
  }

  async function getProjectContext(req: Request): Promise<ProjectContext> {
    const projectId = getProjectIdFromRequest(req);
    const engineManager = options?.engineManager;

    if (projectId && engineManager) {
      let engine = engineManager.getEngine(projectId);
      if (!engine) {
        try {
          engine = await engineManager.ensureEngine(projectId);
        } catch {
          // Engine start failed — fall through to store-only path
        }
      }
      if (engine) {
        return { store: engine.getTaskStore(), engine, projectId };
      }
    }

    // Fallback: use getScopedStore (for dev mode or when engineManager not available)
    const scopedStore = await getScopedStore(req);
    return { store: scopedStore, engine: undefined, projectId };
  }

  // ── Scope Parsing for Automation/Routine Routes ─────────────────────

  /**
   * Valid scope values for automation/routine routes.
   * When scope is omitted, the route defaults to "project" for backward compatibility.
   */
  type ScopeValue = "global" | "project";

  /**
   * Parse and validate the scope parameter from request query/body.
   * Accepts scope in query param `?scope=global|project` or in body `{ scope: "global"|"project" }`.
   *
   * @returns The parsed scope value, or undefined if scope is omitted (legacy default)
   * @throws ApiError(400) if scope is present but invalid
   */
  function parseScopeParam(req: Request): ScopeValue | undefined {
    // Check query param first, then body
    const rawScope =
      (typeof req.query.scope === "string" ? req.query.scope : undefined) ??
      (req.body && typeof req.body.scope === "string" ? req.body.scope : undefined);

    // If scope is not provided, return undefined (legacy default behavior)
    if (rawScope === undefined || rawScope === "") {
      return undefined;
    }

    // Validate scope value
    if (rawScope !== "global" && rawScope !== "project") {
      throw new ApiError(400, `Invalid scope value "${rawScope}". Must be "global" or "project".`);
    }

    return rawScope;
  }

  /**
   * Resolve the AutomationStore for the given scope.
   *
   * Scope resolution:
   * - "global": Returns the default AutomationStore from options (process-level)
   * - "project": Returns the project-scoped AutomationStore from engine or project-store resolver
   * - undefined (legacy): Returns the default AutomationStore for backward compatibility
   *
   * For project scope, this function prefers the engine's AutomationStore when an engine
   * is available for the project. This ensures the same EventEmitter instance is used
   * for both engine runtime events and HTTP route handlers.
   *
   * @throws ApiError(503) if the store is unavailable for the requested scope
   */
  function resolveAutomationStore(req: Request, scope: ScopeValue | undefined): import("@fusion/core").AutomationStore {
    const projectId = getProjectIdFromRequest(req);
    const engineManager = options?.engineManager;

    if (scope === "global" || scope === undefined) {
      // Global scope: use the default process-level store
      const defaultStore = options?.automationStore;
      if (!defaultStore) {
        throw new ApiError(503, "Automation store not available");
      }
      return defaultStore;
    }

    // Project scope: prefer engine's store when available for multi-project isolation
    if (projectId && engineManager) {
      const engine = engineManager.getEngine(projectId);
      if (engine) {
        const engineStore = engine.getAutomationStore();
        if (engineStore) {
          return engineStore;
        }
      }
    }

    // Fallback: use the default store (scope filtering happens at query time)
    const defaultStore = options?.automationStore;
    if (!defaultStore) {
      throw new ApiError(503, "Automation store not available");
    }
    return defaultStore;
  }

  /**
   * Resolve the RoutineStore for the given scope.
   *
   * Scope resolution:
   * - "global": Returns the default RoutineStore from options (process-level)
   * - "project": Returns the project-scoped RoutineStore from engine or project-store resolver
   * - undefined (legacy): Returns the default RoutineStore for backward compatibility
   *
   * For project scope, this function prefers the engine's RoutineStore when an engine
   * is available for the project. This ensures the same EventEmitter instance is used
   * for both engine runtime events and HTTP route handlers.
   *
   * @throws ApiError(503) if the store is unavailable for the requested scope
   */
  function resolveRoutineStore(req: Request, scope: ScopeValue | undefined): import("@fusion/core").RoutineStore {
    const projectId = getProjectIdFromRequest(req);
    const engineManager = options?.engineManager;

    if (scope === "global" || scope === undefined) {
      // Global scope: use the default process-level store
      const defaultStore = options?.routineStore;
      if (!defaultStore) {
        throw new ApiError(503, "Routine store not available");
      }
      return defaultStore;
    }

    // Project scope: prefer engine's store when available for multi-project isolation
    if (projectId && engineManager) {
      const engine = engineManager.getEngine(projectId);
      if (engine) {
        const engineStore = engine.getRoutineStore();
        if (engineStore) {
          return engineStore;
        }
      }
    }

    // Fallback: use the default store (scope filtering happens at query time)
    const defaultStore = options?.routineStore;
    if (!defaultStore) {
      throw new ApiError(503, "Routine store not available");
    }
    return defaultStore;
  }

  /**
   * Resolve the RoutineRunner for the given scope.
   * The RoutineRunner handles execution and must be scoped consistently with store lookups.
   *
   * For project scope, this function prefers the engine's RoutineRunner when an engine
   * is available for the project. This ensures routine execution happens in the correct
   * project context with proper concurrency management.
   *
   * @throws ApiError(503) if the runner is unavailable for the requested scope
   */
  function resolveRoutineRunner(req: Request, scope: ScopeValue | undefined): NonNullable<ServerOptions["routineRunner"]> {
    const projectId = getProjectIdFromRequest(req);
    const engineManager = options?.engineManager;

    // For project scope, prefer engine's RoutineRunner when available
    if (scope === "project" && projectId && engineManager) {
      const engine = engineManager.getEngine(projectId);
      if (engine) {
        const engineRunner = engine.getRoutineRunner();
        if (engineRunner) {
          return {
            triggerManual: engineRunner.triggerManual.bind(engineRunner),
            triggerWebhook: engineRunner.triggerWebhook.bind(engineRunner),
          };
        }
      }
    }

    // Fallback: use the default runner
    const runner = options?.routineRunner;
    if (!runner) {
      throw new ApiError(503, "Routine execution not available");
    }
    return runner;
  }

  if (process.env.FUSION_DEBUG_PLANNING_ROUTES === "1") {
    const planningRoutes = [
      "POST /planning/start",
      "POST /planning/start-streaming",
      "POST /planning/respond",
      "POST /planning/:sessionId/retry",
      "POST /planning/cancel",
      "POST /planning/create-task",
      "POST /planning/start-breakdown",
      "POST /planning/create-tasks",
      "GET /planning/:sessionId/stream",
    ];
    planningLogger.info("routes registered", { planningRoutes });
  }
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

  // HeartbeatMonitor for triggering agent execution runs
  const heartbeatMonitor = options?.heartbeatMonitor;
  const hasHeartbeatExecutor = Boolean(heartbeatMonitor);
  const aiSessionStore = options?.aiSessionStore;

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

  // Settings CRUD
  router.get("/settings", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettingsFast();
      const prAuthAvailable = (isGhAvailable() && isGhAuthenticated()) || Boolean(githubToken);
      // Inject server-side configuration flags
      res.json({
        ...settings,
        prAuthAvailable,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.put("/settings", async (req, res) => {
    try {
      const { store: scopedStore, engine } = await getProjectContext(req);
      // Strip server-owned fields that should never be persisted to config.json.
      // These are computed server-side and injected only on GET /settings.
       
      const { githubTokenConfigured, prAuthAvailable, ...clientSettings } = req.body;

      // Reject global-only fields with a helpful error pointing to the correct endpoint
      const globalKeySet = new Set<string>(GLOBAL_SETTINGS_KEYS);
      const globalFieldsFound = Object.keys(clientSettings).filter((k) => globalKeySet.has(k));
      if (globalFieldsFound.length > 0) {
        throw badRequest(`Cannot update global settings via this endpoint. Use PUT /settings/global instead. Global fields found: ${globalFieldsFound.join(", ")}`);
      }

      if (Object.prototype.hasOwnProperty.call(clientSettings, "modelPresets")) {
        clientSettings.modelPresets = validateModelPresets(clientSettings.modelPresets);
      }

      // Validate backup settings if provided
      if (clientSettings.autoBackupSchedule !== undefined && !validateBackupSchedule(clientSettings.autoBackupSchedule)) {
        throw badRequest("Invalid cron expression for autoBackupSchedule");
      }
      if (clientSettings.autoBackupRetention !== undefined && !validateBackupRetention(clientSettings.autoBackupRetention)) {
        throw badRequest("autoBackupRetention must be between 1 and 100");
      }
      if (clientSettings.autoBackupDir !== undefined && !validateBackupDir(clientSettings.autoBackupDir)) {
        throw badRequest("autoBackupDir must be a relative path without '..' traversal");
      }
      if (clientSettings.autoArchiveDoneAfterMs !== undefined) {
        const ageMs = clientSettings.autoArchiveDoneAfterMs;
        if (!Number.isInteger(ageMs) || ageMs < 60_000 || ageMs > 10 * 365 * 24 * 60 * 60 * 1000) {
          throw badRequest("autoArchiveDoneAfterMs must be between 60000 and 315360000000");
        }
      }
      if (
        clientSettings.archiveAgentLogMode !== undefined &&
        !["none", "compact", "full"].includes(clientSettings.archiveAgentLogMode)
      ) {
        throw badRequest("archiveAgentLogMode must be one of: none, compact, full");
      }

      // Validate memoryBackendType if provided - must be string or null (for explicit clear)
      // Unknown backend IDs are accepted and persisted verbatim (for custom backend compatibility)
      // Fallback-to-file is runtime resolution behavior only
      if (clientSettings.memoryBackendType !== undefined) {
        if (clientSettings.memoryBackendType !== null && typeof clientSettings.memoryBackendType !== "string") {
          throw badRequest("memoryBackendType must be a string or null");
        }
      }

      const settings = await scopedStore.updateSettings(clientSettings);
      
      // Sync backup routine when backup settings change.
      const routineStoreForProject = engine?.getRoutineStore() ?? options?.routineStore;
      if (routineStoreForProject) {
        try {
          await syncBackupRoutine(routineStoreForProject, settings);
        } catch (err) {
          // Log but don't fail the settings update if routine sync fails
          runtimeLogger.error("Failed to sync backup routine", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      
      res.json(settings);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = typeof (err instanceof Error ? err.message : String(err)) === "string" && (
        (err instanceof Error ? err.message : String(err)).includes("modelPresets") || (err instanceof Error ? err.message : String(err)).includes("must include both provider and modelId")
      ) ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // ── Project Memory Routes ─────────────────────────────────────

  /**
   * GET /api/memory
   * Returns the project memory file content using the configured backend.
   * If memory does not exist yet, returns an empty string.
   *
   * Uses backend-aware read via `readMemory()` which delegates to the
   * configured memory backend (file, readonly, qmd, etc.).
   */
  router.get("/memory", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const rootDir = scopedStore.getRootDir();

      // Use backend-aware memory read
      const result = await readMemory(rootDir, settings);
      res.json({ content: result.content });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      // readMemory returns empty content for read failures (graceful degradation)
      // so we should not normally get here for read operations
      rethrowAsApiError(err, "Failed to read memory");
    }
  });

  /**
   * PUT /api/memory
   * Updates the project memory file content using the configured backend.
   * Body: { content: string }
   *
   * Uses backend-aware write via `writeMemory()` which delegates to the
   * configured memory backend. Write-disabled backends (readonly) will
   * return 409 Conflict.
   *
   * Error mapping:
   * - READ_ONLY → 409 Conflict
   * - BACKEND_UNAVAILABLE → 503 Service Unavailable
   * - QUOTA_EXCEEDED → 413 Payload Too Large
   * - UNSUPPORTED → 409 Conflict
   * - CONFLICT → 409 Conflict
   * - Other errors → 500 Internal Server Error
   */
  router.put("/memory", async (req, res) => {
    try {
      const { content } = req.body ?? {};
      if (typeof content !== "string") {
        throw badRequest("content must be a string");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const rootDir = scopedStore.getRootDir();

      // Use backend-aware memory write with explicit error mapping
      await writeMemory(rootDir, content, settings);
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }

      // Map MemoryBackendError codes to appropriate HTTP status codes
      if (err instanceof MemoryBackendError) {
        const details = { code: err.code, backend: err.backend };
        switch (err.code) {
          case "READ_ONLY":
          case "UNSUPPORTED":
          case "CONFLICT":
            throw new ApiError(409, `Memory operation failed: ${err instanceof Error ? err.message : String(err)}`, details);
          case "BACKEND_UNAVAILABLE":
            res.status(503).json({
              error: `Memory backend unavailable: ${err instanceof Error ? err.message : String(err)}`,
              ...details,
            });
            return;
          case "QUOTA_EXCEEDED":
            res.status(413).json({
              error: `Memory quota exceeded: ${err instanceof Error ? err.message : String(err)}`,
              ...details,
            });
            return;
          default:
            // READ_FAILED, WRITE_FAILED, NOT_FOUND, etc.
            throw new ApiError(500, `Memory operation failed: ${err instanceof Error ? err.message : String(err)}`, details);
        }
      }

      rethrowAsApiError(err, "Failed to save memory");
    }
  });

  /**
   * GET /api/memory/files
   * Lists editable project memory files across the layered memory workspace.
   */
  router.get("/memory/files", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      const files = await listProjectMemoryFiles(rootDir);
      res.json({ files });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to list memory files");
    }
  });

  /**
   * GET /api/memory/file?path=.fusion/memory/MEMORY.md
   * Reads one validated memory file. Paths outside memory are rejected by core.
   */
  router.get("/memory/file", async (req, res) => {
    try {
      const path = typeof req.query.path === "string" ? req.query.path : "";
      if (!path) {
        throw badRequest("path is required");
      }
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      const result = await readProjectMemoryFile(rootDir, { path, lineCount: 400 });
      res.json({ path: result.path, content: result.content });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof MemoryBackendError) {
        const status = err.code === "NOT_FOUND" ? 404 : err.code === "UNSUPPORTED" ? 400 : 500;
        throw new ApiError(status, `Memory operation failed: ${err.message}`, { code: err.code, backend: err.backend });
      }
      rethrowAsApiError(err, "Failed to read memory file");
    }
  });

  /**
   * PUT /api/memory/file
   * Writes one validated memory file. Read-only backends reject writes.
   */
  router.put("/memory/file", async (req, res) => {
    try {
      const { path, content } = req.body ?? {};
      if (typeof path !== "string" || !path) {
        throw badRequest("path must be a string");
      }
      if (typeof content !== "string") {
        throw badRequest("content must be a string");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const backend = resolveMemoryBackend(settings);
      if (!backend.capabilities.writable) {
        throw new MemoryBackendError("READ_ONLY", "This backend is read-only and cannot write memory", backend.type);
      }

      const rootDir = scopedStore.getRootDir();
      await writeProjectMemoryFile(rootDir, path, content);
      if (backend.type === "qmd") {
        scheduleQmdProjectMemoryRefresh(rootDir);
      }
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof MemoryBackendError) {
        const details = { code: err.code, backend: err.backend };
        switch (err.code) {
          case "READ_ONLY":
          case "UNSUPPORTED":
          case "CONFLICT":
            throw new ApiError(409, `Memory operation failed: ${err.message}`, details);
          case "NOT_FOUND":
            throw new ApiError(404, `Memory operation failed: ${err.message}`, details);
          default:
            throw new ApiError(500, `Memory operation failed: ${err.message}`, details);
        }
      }
      rethrowAsApiError(err, "Failed to save memory file");
    }
  });

  // ── Memory Backend Routes ─────────────────────────────────────

  /**
   * GET /api/memory/backend
   * Returns the current memory backend status and capabilities.
   *
   * The `currentBackend` field reflects the **effective** backend after runtime
   * resolution. If a custom/unknown backend type is persisted in settings, it
   * is returned as-is in the response, but `currentBackend` reflects the
   * fallback backend (file) used at runtime.
   *
   * Response shape:
   * - `currentBackend`: The effective backend type after runtime resolution
   * - `capabilities`: The capabilities of the effective backend
   * - `availableBackends`: List of registered backend types
   */
  router.get("/memory/backend", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const capabilities = getMemoryBackendCapabilities(settings);
      const availableBackends = listMemoryBackendTypes();

      res.json({
        currentBackend: resolveMemoryBackend(settings).type,
        capabilities,
        availableBackends,
        qmdAvailable: await isQmdAvailable(),
        qmdInstallCommand: QMD_INSTALL_COMMAND,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to get memory backend status");
    }
  });

  router.post("/memory/install-qmd", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const installed = await installQmd();
      const qmdAvailable = await isQmdAvailable();
      if (installed && qmdAvailable) {
        scheduleQmdProjectMemoryRefresh(scopedStore.getRootDir());
      }

      res.json({
        success: installed,
        qmdAvailable,
        qmdInstallCommand: QMD_INSTALL_COMMAND,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to install qmd");
    }
  });

  router.post("/memory/test", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const rootDir = scopedStore.getRootDir();
      const query = typeof req.body?.query === "string" && req.body.query.trim()
        ? req.body.query.trim()
        : "project memory";
      const qmdAvailable = await isQmdAvailable();
      if (qmdAvailable) {
        await refreshQmdProjectMemoryIndex(rootDir, { force: true });
      }
      const results = await searchProjectMemory(
        rootDir,
        { query, limit: 5 },
        { ...settings, memoryBackendType: "qmd" },
      );

      res.json({
        query,
        qmdAvailable,
        usedFallback: !qmdAvailable,
        qmdInstallCommand: QMD_INSTALL_COMMAND,
        results,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to test memory retrieval");
    }
  });

  /**
   * POST /api/memory/compact
   * AI-powered memory compaction using the memory compaction service.
   * Reads one selected memory file, compacts it using AI, and writes back the result.
   *
   * Body: { path?: string } (defaults to .fusion/memory/MEMORY.md)
   *
   * Error mapping:
   * - Memory content too short (< 200 chars) → 400 Bad Request
   * - READ_ONLY → 409 Conflict
   * - BACKEND_UNAVAILABLE → 503 Service Unavailable
   * - AiServiceError → 503 Service Unavailable
   * - Other errors → 500 Internal Server Error
   */
  router.post("/memory/compact", async (req, res) => {
    try {
      const requestedPath = typeof req.body?.path === "string" && req.body.path.trim()
        ? req.body.path
        : ".fusion/memory/MEMORY.md";
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const backend = resolveMemoryBackend(settings);
      if (!backend.capabilities.writable) {
        throw new MemoryBackendError("READ_ONLY", "This backend is read-only and cannot write memory", backend.type);
      }
      const rootDir = scopedStore.getRootDir();

      // Read the selected file in full before compaction.
      const result = await readProjectMemoryFileContent(rootDir, requestedPath);
      const content = result.content;

      // Validate content length (must be at least 200 chars to compact)
      if (content.length < 200) {
        throw badRequest("Memory content too short to compact");
      }

      // Resolve model selection hierarchy for compaction:
      // 1. Project titleSummarizer override (titleSummarizerProvider + titleSummarizerModelId)
      // 2. Planning lane settings (planningProvider + planningModelId)
      // 3. Default pair (defaultProvider + defaultModelId)
      // 4. Automatic model resolution (no explicit model)
      const resolvedProvider =
        (settings.titleSummarizerProvider && settings.titleSummarizerModelId ? settings.titleSummarizerProvider : undefined) ||
        (settings.planningProvider && settings.planningModelId ? settings.planningProvider : undefined) ||
        (settings.defaultProvider && settings.defaultModelId ? settings.defaultProvider : undefined);

      const resolvedModelId =
        (settings.titleSummarizerProvider && settings.titleSummarizerModelId ? settings.titleSummarizerModelId : undefined) ||
        (settings.planningProvider && settings.planningModelId ? settings.planningModelId : undefined) ||
        (settings.defaultProvider && settings.defaultModelId ? settings.defaultModelId : undefined);

      // Import and call the compaction service
      const { compactMemoryWithAi } = await import("@fusion/core");
      const compacted = await compactMemoryWithAi(content, rootDir, resolvedProvider, resolvedModelId);

      // Write compacted content back to the same selected memory file.
      await writeProjectMemoryFile(rootDir, result.path, compacted);
      if (backend.type === "qmd") {
        scheduleQmdProjectMemoryRefresh(rootDir);
      }

      res.json({ path: result.path, content: compacted });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }

      // Map MemoryBackendError codes to appropriate HTTP status codes
      if (err instanceof MemoryBackendError) {
        const details = { code: err.code, backend: err.backend };
        switch (err.code) {
          case "READ_ONLY":
          case "UNSUPPORTED":
          case "CONFLICT":
            throw new ApiError(409, `Memory operation failed: ${err instanceof Error ? err.message : String(err)}`, details);
          case "BACKEND_UNAVAILABLE":
            res.status(503).json({
              error: `Memory backend unavailable: ${err instanceof Error ? err.message : String(err)}`,
              ...details,
            });
            return;
          default:
            // READ_FAILED, WRITE_FAILED, NOT_FOUND, etc.
            throw new ApiError(500, `Memory operation failed: ${err instanceof Error ? err.message : String(err)}`, details);
        }
      }

      // Map AI service errors to 503
      if (err instanceof Error && err.name === "AiServiceError") {
        throw new ApiError(503, err.message || "AI service temporarily unavailable");
      }

      rethrowAsApiError(err, "Failed to compact memory");
    }
  });

  // ── Memory Insights Routes ───────────────────────────────────────────

  // Lazy-loaded createFnAgent for AI operations (same pattern as ai-refine.ts)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let createFnAgentForInsights: any;

  async function initCreateFnAgentForInsights(): Promise<void> {
    if (createFnAgentForInsights) return;
    try {
      // Use dynamic import with @vite-ignore to prevent static analysis issues
      const engine = await import(/* @vite-ignore */ "@fusion/engine");
      createFnAgentForInsights = engine.createFnAgent;
    } catch {
      createFnAgentForInsights = undefined;
    }
  }

  /**
   * GET /api/memory/insights
   * Returns the insights memory file content.
   * Returns { content: null, exists: false } if no insights file exists yet.
   */
  router.get("/memory/insights", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();

      const content = await readInsightsMemory(rootDir);
      res.json({ content, exists: content !== null });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      // If the file doesn't exist, return null with exists: false
      if (err instanceof Error && err.message.includes("no such file")) {
        res.json({ content: null, exists: false });
        return;
      }
      rethrowAsApiError(err, "Failed to read memory insights");
    }
  });

  /**
   * PUT /api/memory/insights
   * Updates the insights memory file content.
   * Body: { content: string }
   */
  router.put("/memory/insights", async (req, res) => {
    try {
      const { content } = req.body ?? {};
      if (typeof content !== "string") {
        throw badRequest("content must be a string");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();

      await writeInsightsMemory(rootDir, content);
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to save memory insights");
    }
  });

  /**
   * POST /api/memory/extract
   * Triggers AI-powered insight extraction from working memory.
   * Reads working memory, generates insights via AI, merges/prunes existing insights,
   * and generates an audit report.
   *
   * Returns: { success: boolean, summary: string, insightCount: number, pruned: boolean }
   * Errors: 400 if working memory is empty, 503 if AI service unavailable
   */
  router.post("/memory/extract", async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let session: any = null;
    try {
      await initCreateFnAgentForInsights();

      if (!createFnAgentForInsights) {
        throw new ApiError(503, "AI engine not available");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const rootDir = scopedStore.getRootDir();

      // Read working memory and existing insights
      // Use readMemory (from memory-backend.ts) to handle both legacy and multi-file paths
      const memoryResult = await readMemory(rootDir, settings);
      const workingMemory = memoryResult.content;
      const existingInsights = await readInsightsMemory(rootDir);

      // Validate working memory is not empty
      if (!workingMemory || workingMemory.trim().length === 0) {
        throw badRequest("No working memory to extract insights from");
      }

      // Build the extraction prompt
      const extractionPrompt = buildInsightExtractionPrompt(workingMemory, existingInsights ?? "");

      // Resolve model selection hierarchy for insight extraction
      const resolvedProvider =
        (settings.planningProvider && settings.planningModelId ? settings.planningProvider : undefined) ||
        (settings.defaultProvider && settings.defaultModelId ? settings.defaultProvider : undefined);

      const resolvedModelId =
        (settings.planningProvider && settings.planningModelId ? settings.planningModelId : undefined) ||
        (settings.defaultProvider && settings.defaultModelId ? settings.defaultModelId : undefined);

      // Create AI agent session for extraction
      const agentResult = await createFnAgentForInsights({
        cwd: rootDir,
        tools: "readonly",
        defaultProvider: resolvedProvider,
        defaultModelId: resolvedModelId,
        systemPrompt: "You are a helpful AI assistant that extracts insights from working memory.",
      });

      if (!agentResult?.session) {
        throw new ApiError(503, "Failed to initialize AI agent for insight extraction");
      }

      session = agentResult.session;

      // Send extraction prompt to AI
      const responseText = await session.prompt(extractionPrompt);

      // Process the result: merge insights, prune duplicates, and generate audit
      const result = await processAndAuditInsightExtraction(rootDir, {
        rawResponse: responseText,
        stepSuccess: true,
        runAt: new Date().toISOString(),
      });

      res.json({
        success: true,
        summary: result.extraction?.summary ?? `Extracted ${result.extraction?.insightCount ?? 0} insights`,
        insightCount: result.extraction?.insightCount ?? 0,
        pruned: result.pruning?.applied ?? false,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }

      // Map AI service errors to 503
      if (err instanceof Error && err.name === "AiServiceError") {
        throw new ApiError(503, err.message || "AI service temporarily unavailable");
      }

      // Map model not found errors to 400 with helpful message
      if (err instanceof Error && err.message.includes("not found in the pi model registry")) {
        throw badRequest(
          "AI model not configured. Please open Settings → AI and select a valid model for insight extraction.",
        );
      }

      // Map other extraction errors
      if (err instanceof Error && err.message.includes("No working memory")) {
        throw badRequest(err.message);
      }

      rethrowAsApiError(err, "Failed to extract insights");
    } finally {
      // Always dispose the session
      if (session) {
        try {
          session.dispose();
        } catch {
          // Ignore disposal errors
        }
      }
    }
  });

  /**
   * GET /api/memory/audit
   * Returns a comprehensive memory audit report.
   * The audit checks working memory and insights memory state, extraction history,
   * and generates health recommendations.
   */
  router.get("/memory/audit", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();

      const report = await generateMemoryAudit(rootDir);
      res.json(report);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to generate memory audit");
    }
  });

  /**
   * GET /api/memory/stats
   * Returns lightweight quick stats about memory files (no AI, no full audit).
   * Useful for dashboard displays showing memory size and insight counts.
   *
   * Returns: { workingMemorySize: number, insightsSize: number, insightsExists: boolean }
   */
  router.get("/memory/stats", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const rootDir = scopedStore.getRootDir();

      // Read both files concurrently
      // Use readMemory to handle both legacy and multi-file memory paths
      const [workingResult, insightsContent] = await Promise.all([
        readMemory(rootDir, settings),
        readInsightsMemory(rootDir).catch(() => null),
      ]);

      res.json({
        workingMemorySize: workingResult.content.length,
        insightsSize: insightsContent?.length ?? 0,
        insightsExists: insightsContent !== null,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to fetch memory stats");
    }
  });

  // ── Inbound Settings Sync Endpoints ────────────────────────────────
  // These endpoints are called by remote nodes to deliver settings or request auth data.
  // They validate apiKey auth before accepting data.

  /**
   * POST /api/settings/sync-receive
   * Receive pushed settings from a remote node.
   * Body: SettingsSyncPayload with global, projects, exportedAt, checksum, version
   * Returns: { success: true, appliedFields: string[], skippedFields: string[] }
   */
  router.post("/settings/sync-receive", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore(store.getFusionDir());
      await central.init();

      // Validate auth - find local node and check apiKey
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        await central.close();
        throw new ApiError(401, "Missing or invalid Authorization header");
      }

      const token = authHeader.slice(7);
      const nodes = await central.listNodes();
      const localNode = nodes.find((n: import("@fusion/core").NodeConfig) => n.type === "local");
      if (!localNode) {
        await central.close();
        throw new ApiError(401, "Local node not configured");
      }
      if (localNode.apiKey !== token) {
        await central.close();
        throw new ApiError(401, "Invalid apiKey");
      }

      const payload = req.body;

      // Validate required fields
      if (!payload?.sourceNodeId) {
        await central.close();
        throw badRequest("Missing required field: sourceNodeId");
      }
      if (!payload?.exportedAt) {
        await central.close();
        throw badRequest("Missing required field: exportedAt");
      }

      // Apply remote settings
      const result = await central.applyRemoteSettings(payload);

      // Build applied/skipped field lists
      const appliedFields = [
        ...Object.keys(payload.global || {}),
        ...Object.keys(payload.projects || {}),
      ];
      const skippedFields = result.error ? appliedFields : [];

      await central.close();

      res.json({
        success: result.success,
        appliedFields,
        skippedFields,
        error: result.error,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/settings/auth-receive
   * Receive auth credentials from a remote node.
   * Body: { providers: Record<string, { type: string; key: string }>, sourceNodeId: string, timestamp: string }
   * Returns: { success: true, receivedProviders: string[] }
   */
  router.post("/settings/auth-receive", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore(store.getFusionDir());
      await central.init();

      // Validate auth
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        await central.close();
        throw new ApiError(401, "Missing or invalid Authorization header");
      }

      const token = authHeader.slice(7);
      const nodes = await central.listNodes();
      const localNode = nodes.find((n: import("@fusion/core").NodeConfig) => n.type === "local");
      if (!localNode) {
        await central.close();
        throw new ApiError(401, "Local node not configured");
      }
      if (localNode.apiKey !== token) {
        await central.close();
        throw new ApiError(401, "Invalid apiKey");
      }

      const { providers, sourceNodeId, timestamp } = req.body || {};

      // Validate required fields
      if (!providers || typeof providers !== "object") {
        await central.close();
        throw badRequest("Missing required field: providers");
      }
      if (!sourceNodeId) {
        await central.close();
        throw badRequest("Missing required field: sourceNodeId");
      }
      if (!timestamp) {
        await central.close();
        throw badRequest("Missing required field: timestamp");
      }

      // Import AuthStorage and write credentials
      const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
      const authStorage = AuthStorage.create(getFusionAuthPath());

      const receivedProviders: string[] = [];
      for (const [providerId, credential] of Object.entries(providers)) {
        if (typeof credential === "object" && credential !== null) {
          const cred = credential as { type: string; key?: string; access?: string; refresh?: string; expires?: number; accountId?: string };
          if (cred.type === "api_key" && cred.key) {
            authStorage.set(providerId, { type: "api_key", key: cred.key });
            receivedProviders.push(providerId);
          }
        }
      }

      // Log without actual credentials
      runtimeLogger.child("settings-sync").info(
        `Auth credentials received: providers=${receivedProviders.join(",")}, source=${sourceNodeId}`,
      );

      await central.close();

      res.json({ success: true, receivedProviders });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/settings/auth-export
   * Export local auth credentials for a requesting remote node.
   * Returns: { providers: Record<string, { type: string; key: string }>, sourceNodeId: string, timestamp: string }
   */
  router.get("/settings/auth-export", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore(store.getFusionDir());
      await central.init();

      // Validate auth
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        await central.close();
        throw new ApiError(401, "Missing or invalid Authorization header");
      }

      const token = authHeader.slice(7);
      const nodes = await central.listNodes();
      const localNode = nodes.find((n: import("@fusion/core").NodeConfig) => n.type === "local");
      if (!localNode) {
        await central.close();
        throw new ApiError(401, "Local node not configured");
      }
      if (localNode.apiKey !== token) {
        await central.close();
        throw new ApiError(401, "Invalid apiKey");
      }

      // Get local node ID
      const localPeerInfo = await central.getLocalPeerInfo();

      const allProviders = await readStoredAuthProvidersFromDisk();

      // Filter to only API-key-based providers (skip OAuth)
      const apiKeyProviders: Record<string, { type: string; key: string }> = {};
      for (const [providerId, cred] of Object.entries(allProviders)) {
        if (cred.type === "api_key" && cred.key) {
          apiKeyProviders[providerId] = { type: "api_key", key: cred.key };
        }
      }

      await central.close();

      res.json({
        providers: apiKeyProviders,
        sourceNodeId: localPeerInfo.nodeId,
        timestamp: new Date().toISOString(),
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Global Settings Routes ─────────────────────────────────────

  /**
   * GET /api/settings/global
   * Returns the global (user-level) settings from ~/.fusion/settings.json.
   * Does NOT include computed/server-only fields like prAuthAvailable.
   */
  router.get("/settings/global", async (_req, res) => {
    try {
      const globalStore = store.getGlobalSettingsStore();
      const settings = await globalStore.getSettings();
      res.json(settings);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PUT /api/settings/global
   * Update global (user-level) settings in ~/.fusion/settings.json.
   * These settings persist across all fn projects for the current user.
   */
  router.put("/settings/global", async (req, res) => {
    try {
      // Snapshot the prior value of useClaudeCli *before* writing so we can
      // detect a toggle transition and trigger the onUseClaudeCliToggled
      // hook (used to install the fusion Claude-skill into every registered
      // project without waiting for a server restart).
      let prevUseClaudeCli = false;
      try {
        const priorGlobal = await store.getGlobalSettingsStore().getSettings();
        prevUseClaudeCli = priorGlobal.useClaudeCli === true;
      } catch {
        // Best-effort: on read failure assume false so a flip-on still fires.
      }

      const settings = await store.updateGlobalSettings(req.body);
      // Invalidate global settings caches in all project-scoped stores so the
      // next GET /settings?projectId=xxx reads fresh values from disk rather
      // than returning a stale per-project cache.
      invalidateAllGlobalSettingsCaches();
      // Also invalidate caches in engine manager stores (separate GlobalSettingsStore
      // instances that are NOT part of the project-store-resolver cache).
      const engineManager = options?.engineManager;
      if (engineManager) {
        for (const engine of engineManager.getAllEngines().values()) {
          engine.getTaskStore().getGlobalSettingsStore().invalidateCache();
        }
      }

      // Fire the toggle hook only on an actual transition — avoids redundant
      // skill-install sweeps when the user saves unrelated settings.
      const nextUseClaudeCli = settings.useClaudeCli === true;
      if (options?.onUseClaudeCliToggled && prevUseClaudeCli !== nextUseClaudeCli) {
        try {
          options.onUseClaudeCliToggled(prevUseClaudeCli, nextUseClaudeCli);
        } catch (hookErr) {
          runtimeLogger.warn(
            `onUseClaudeCliToggled callback threw: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
          );
        }
      }

      res.json(settings);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/settings/scopes
   * Returns settings separated by scope: { global, project }.
   * Useful for the UI to show which scope each setting comes from.
   */
  router.get("/settings/scopes", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const scopes = await scopedStore.getSettingsByScope();
      res.json(scopes);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/settings/pi-extensions
   * List Pi/Fusion extension entry points and their Fusion-owned enabled state.
   */
  router.get("/settings/pi-extensions", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      res.json(await discoverDashboardPiExtensions(scopedStore.getRootDir()));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PUT /api/settings/pi-extensions
   * Persist Fusion-owned disabled extension ids in ~/.fusion/agent/settings.json.
   */
  router.put("/settings/pi-extensions", async (req, res) => {
    try {
      const disabledIds = (req.body as { disabledIds?: unknown }).disabledIds;
      if (!Array.isArray(disabledIds) || disabledIds.some((entry) => typeof entry !== "string")) {
        throw badRequest("disabledIds must be an array of extension ids");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const currentSettings = await discoverDashboardPiExtensions(scopedStore.getRootDir());
      updatePiExtensionDisabledIds(
        scopedStore.getRootDir(),
        disabledIds,
        undefined,
        currentSettings.extensions.map((extension) => extension.id),
      );
      res.json(await discoverDashboardPiExtensions(scopedStore.getRootDir()));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Pi Settings Routes ────────────────────────────────────────────

  /**
   * GET /api/pi-settings
   * Returns the user's global pi extension settings from ~/.pi/agent/settings.json.
   * Includes packages, extension paths, skill paths, prompt template paths, and theme paths.
   */
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
   * POST /api/settings/test-ntfy
   * Send a test notification to verify ntfy configuration.
   * Returns: { success: true } on success, { error: string } on failure.
   */
  router.post("/settings/test-ntfy", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();

      // Validate ntfy is enabled
      if (!settings.ntfyEnabled) {
        throw badRequest("ntfy notifications are not enabled");
      }

      // Validate topic exists and matches required format
      const topic = settings.ntfyTopic;
      if (!topic || !/^[a-zA-Z0-9_-]{1,64}$/.test(topic)) {
        throw badRequest("ntfy topic is not configured or invalid");
      }

      // Send test notification to ntfy.sh
      const ntfyBaseUrl = "https://ntfy.sh";
      const url = `${ntfyBaseUrl}/${topic}`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Title": "Fusion test notification",
          "Priority": "default",
          "Content-Type": "text/plain",
        },
        body: "Fusion test notification — your notifications are working!",
      });

      if (!response.ok) {
        throw new ApiError(502, `ntfy.sh returned ${response.status}: ${response.statusText}`);
      }

      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to send test notification");
    }
  });

  // ── Settings Export/Import Routes ─────────────────────────────────

  /**
   * GET /api/settings/export
   * Export settings as JSON for backup or migration.
   * Query params: ?scope=global|project|both (default: both)
   * Returns: SettingsExportData structure
   */
  router.get("/settings/export", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const scopeParam = req.query.scope as string | undefined;
      const scope = scopeParam === "global" || scopeParam === "project" || scopeParam === "both"
        ? scopeParam
        : "both";

      const exportData = await exportSettings(scopedStore, { scope });
      res.json(exportData);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to export settings");
    }
  });

  /**
   * POST /api/settings/import
   * Import settings from JSON data.
   * Body: { data: SettingsExportData, scope?: 'global'|'project'|'both', merge?: boolean }
   * Returns: { success: true, globalCount: number, projectCount: number }
   */
  router.post("/settings/import", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { data, scope = "both", merge = true } = req.body;

      // Validate the import data
      const validationErrors = validateImportData(data);
      if (validationErrors.length > 0) {
        throw badRequest(`Validation failed: ${validationErrors.join("; ")}`);
      }

      // Perform the import
      const result = await importSettings(scopedStore, data, { scope, merge });

      if (!result.success) {
        throw new ApiError(500, result.error ?? "Import failed", {
          globalCount: result.globalCount,
          projectCount: result.projectCount,
        });
      }

      res.json({
        success: true,
        globalCount: result.globalCount,
        projectCount: result.projectCount,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to import settings");
    }
  });

  // ── Executor Stats Route ────────────────────────────────────────────

  /**
   * GET /api/executor/stats
   * Returns executor statistics for the status bar.
   * 
   * Counts (running, blocked, queued, in-review, stuck) are derived client-side
   * from the tasks array. This endpoint returns settings-based values and
   * lastActivityAt from the activity log.
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

  // List all tasks
  router.get("/tasks", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
      const offset = typeof req.query.offset === "string" ? Number.parseInt(req.query.offset, 10) : undefined;
      const q = typeof req.query.q === "string" ? req.query.q.trim() : undefined;
      const includeArchived = req.query.includeArchived === "1" || req.query.includeArchived === "true";

      if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
        throw badRequest("limit must be a non-negative integer");
      }

      if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
        throw badRequest("offset must be a non-negative integer");
      }

      let tasks;
      if (q && q.length > 0) {
        tasks = await scopedStore.searchTasks(q, { limit, offset, slim: true, includeArchived });
      } else {
        // Board-view list: omit the heavy agent log payload and exclude
        // archived tasks unless explicitly requested. Full task detail still loads via
        // GET /api/tasks/:id. Without this, every dashboard load shipped tens of MB of agent logs.
        tasks = await scopedStore.listTasks({ limit, offset, slim: true, includeArchived });
      }
      res.json(tasks);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Create task
  router.post("/tasks", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const {
        title,
        description,
        column,
        dependencies,
        breakIntoSubtasks,
        enabledWorkflowSteps,
        modelPresetId,
        modelProvider,
        modelId,
        validatorModelProvider,
        validatorModelId,
        planningModelProvider,
        planningModelId,
        thinkingLevel,
        reviewLevel,
        executionMode,
      } = req.body;
      if (!description || typeof description !== "string") {
        throw badRequest("description is required");
      }
      if (breakIntoSubtasks !== undefined && typeof breakIntoSubtasks !== "boolean") {
        throw badRequest("breakIntoSubtasks must be a boolean");
      }

      const validatedModelProvider = validateOptionalModelField(modelProvider, "modelProvider");
      const validatedModelId = validateOptionalModelField(modelId, "modelId");
      const validatedValidatorModelProvider = validateOptionalModelField(validatorModelProvider, "validatorModelProvider");
      const validatedValidatorModelId = validateOptionalModelField(validatorModelId, "validatorModelId");
      const validatedPlanningModelProvider = validateOptionalModelField(planningModelProvider, "planningModelProvider");
      const validatedPlanningModelId = validateOptionalModelField(planningModelId, "planningModelId");

      // Validate thinkingLevel if provided
      const validThinkingLevels = ["off", "minimal", "low", "medium", "high"];
      if (thinkingLevel !== undefined && thinkingLevel !== null && !validThinkingLevels.includes(thinkingLevel)) {
        throw badRequest(`thinkingLevel must be one of: ${validThinkingLevels.join(", ")}`);
      }

      // Validate reviewLevel if provided (must be integer 0-3)
      if (reviewLevel !== undefined && reviewLevel !== null) {
        if (typeof reviewLevel !== "number" || !Number.isInteger(reviewLevel) || reviewLevel < 0 || reviewLevel > 3) {
          throw badRequest("reviewLevel must be an integer between 0 and 3");
        }
      }

      // Validate executionMode if provided (must be "standard" or "fast")
      const validExecutionModes = ["standard", "fast"];
      if (executionMode !== undefined && executionMode !== null && !validExecutionModes.includes(executionMode)) {
        throw badRequest(`executionMode must be one of: ${validExecutionModes.join(", ")}`);
      }

      const executorModel = normalizeModelSelectionPair(validatedModelProvider, validatedModelId);
      const validatorModel = normalizeModelSelectionPair(validatedValidatorModelProvider, validatedValidatorModelId);
      const planningModel = normalizeModelSelectionPair(validatedPlanningModelProvider, validatedPlanningModelId);

      // Validate enabledWorkflowSteps if provided
      if (enabledWorkflowSteps !== undefined) {
        if (!Array.isArray(enabledWorkflowSteps) || !enabledWorkflowSteps.every((id: unknown) => typeof id === "string")) {
          throw badRequest("enabledWorkflowSteps must be an array of strings");
        }
      }

      // Check for summarize flag in request
      const summarize = req.body.summarize === true;

      // Get settings for auto-summarization (fast path — skips expensive workflow steps query)
      const settings = await scopedStore.getSettingsFast();

      // Create onSummarize callback if summarization is enabled
      const onSummarize = (summarize || settings.autoSummarizeTitles)
        ? async (desc: string): Promise<string | null> => {
            try {
              const { summarizeTitle } = await import("@fusion/core");

              // Resolve model selection hierarchy for summarization:
              // 1. Project titleSummarizer override (titleSummarizerProvider + titleSummarizerModelId)
              // 2. Global summarization lane (titleSummarizerGlobalProvider + titleSummarizerGlobalModelId)
              // 3. Default pair (defaultProvider + defaultModelId)
              const resolvedProvider =
                (settings.titleSummarizerProvider && settings.titleSummarizerModelId ? settings.titleSummarizerProvider : undefined) ||
                (settings.titleSummarizerGlobalProvider && settings.titleSummarizerGlobalModelId ? settings.titleSummarizerGlobalProvider : undefined) ||
                (settings.defaultProvider && settings.defaultModelId ? settings.defaultProvider : undefined);

              const resolvedModelId =
                (settings.titleSummarizerProvider && settings.titleSummarizerModelId ? settings.titleSummarizerModelId : undefined) ||
                (settings.titleSummarizerGlobalProvider && settings.titleSummarizerGlobalModelId ? settings.titleSummarizerGlobalModelId : undefined) ||
                (settings.defaultProvider && settings.defaultModelId ? settings.defaultModelId : undefined);

              return await summarizeTitle(desc, scopedStore.getRootDir(), resolvedProvider, resolvedModelId);
            } catch (err) {
              // Log the full error so server logs show what went wrong
              const errorMessage = err instanceof Error ? err.message : String(err);
              runtimeLogger.error(`Title summarization failed: ${errorMessage}`, {
                error: errorMessage,
              });
              // Return null on error so task creation continues without title
              return null;
            }
          }
        : undefined;

      const task = await scopedStore.createTask(
        {
          title,
          description,
          column,
          dependencies,
          breakIntoSubtasks,
          enabledWorkflowSteps,
          modelPresetId: validateOptionalModelField(modelPresetId, "modelPresetId"),
          modelProvider: executorModel.provider,
          modelId: executorModel.modelId,
          validatorModelProvider: validatorModel.provider,
          validatorModelId: validatorModel.modelId,
          planningModelProvider: planningModel.provider,
          planningModelId: planningModel.modelId,
          thinkingLevel: thinkingLevel || undefined,
          summarize,
          reviewLevel: reviewLevel ?? undefined,
          executionMode: executionMode || undefined,
        },
        { onSummarize, settings: { autoSummarizeTitles: settings.autoSummarizeTitles } }
      );
      res.status(201).json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("must be a string") || (err instanceof Error ? err.message : String(err)).includes("must be an array of strings") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Move task to column
  router.post("/tasks/:id/move", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { column } = req.body;
      if (!column || !COLUMNS.includes(column as Column)) {
        throw badRequest(`Invalid column. Must be one of: ${COLUMNS.join(", ")}`);
      }
      const task = await scopedStore.moveTask(req.params.id, column as Column);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("Invalid transition") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Merge task (in-review → done, merges branch + cleans worktree)
  // Uses AI merge handler if provided, falls back to store.mergeTask
  router.post("/tasks/:id/merge", async (req, res) => {
    try {
      const { store: scopedStore, engine } = await getProjectContext(req);
      const merge = engine
        ? (id: string) => engine.onMerge(id)
        : options?.onMerge ?? ((id: string) => scopedStore.mergeTask(id));
      const result = await merge(req.params.id);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("Cannot merge") ? 400
        : (err instanceof Error ? err.message : String(err)).includes("conflict") ? 409
        : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Retry failed, stuck-killed, or stranded triage/specification task
  router.post("/tasks/:id/retry", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      const retrySpecification =
        task.column === "triage" &&
        (task.status === "failed" ||
          task.status === "specifying" ||
          task.status === "needs-respecify" ||
          (task.stuckKillCount ?? 0) > 0);
      if (task.status !== "failed" && task.status !== "stuck-killed" && !retrySpecification) {
        throw badRequest(`Task is not in a retryable state (current status: ${task.status || 'none'})`);
      }
      await scopedStore.updateTask(req.params.id, {
        status: retrySpecification ? "needs-respecify" : null,
        error: null,
        worktree: null,
        branch: null,
        baseBranch: null,
        baseCommitSha: null,
        stuckKillCount: 0,
        recoveryRetryCount: null,
        nextRecoveryAt: null,
      });

      if (retrySpecification) {
        const { rm } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
        await rm(promptPath, { force: true });
        await scopedStore.logEntry(req.params.id, "Retry requested from dashboard (specification retry budget reset)");
        const updated = await scopedStore.getTask(req.params.id);
        res.json(updated);
        return;
      }

      // Reset steps if the branch has no unique commits (work was lost with worktree)
      const completedSteps = task.steps.filter(
        (s: { status: string }) => s.status === "done" || s.status === "in-progress",
      );
      if (completedSteps.length > 0) {
        const branchName = task.branch || `fusion/${task.id.toLowerCase()}`;
        try {
          const rootDir = scopedStore.getRootDir();
          const mergeBase = (await runGitCommand(["merge-base", branchName, "HEAD"], rootDir, 5000)).trim();
          const branchHead = (await runGitCommand(["rev-parse", branchName], rootDir, 5000)).trim();

          if (mergeBase === branchHead) {
            for (let i = 0; i < task.steps.length; i++) {
              if (task.steps[i].status === "done" || task.steps[i].status === "in-progress") {
                await scopedStore.updateStep(req.params.id, i, "pending");
              }
            }
            await scopedStore.logEntry(
              req.params.id,
              `Reset ${completedSteps.length} step(s) to pending — branch had no commits (uncommitted work lost)`,
            );
          }
        } catch {
          // Branch may not exist — non-fatal, steps keep their status
        }
      }

      await scopedStore.logEntry(req.params.id, "Retry requested from dashboard (stuck kill budget reset)");
      const updated = await scopedStore.moveTask(req.params.id, "todo");
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Duplicate task
  router.post("/tasks/:id/duplicate", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const newTask = await scopedStore.duplicateTask(req.params.id);
      res.status(201).json(newTask);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Create refinement task from a completed or in-review task
  router.post("/tasks/:id/refine", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { feedback } = req.body;
      if (!feedback || typeof feedback !== "string") {
        throw badRequest("feedback is required and must be a string");
      }
      // Trim before checking length to catch whitespace-only input
      const trimmedFeedback = feedback.trim();
      if (trimmedFeedback.length === 0 || trimmedFeedback.length > 2000) {
        throw badRequest("feedback must be between 1 and 2000 characters");
      }

      const refinedTask = await scopedStore.refineTask(req.params.id, trimmedFeedback);
      await scopedStore.logEntry(req.params.id, "Refinement requested", trimmedFeedback);
      res.status(201).json(refinedTask);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404
        : (err instanceof Error ? err.message : String(err)).includes("must be in 'done' or 'in-review'") ? 400
        : (err instanceof Error ? err.message : String(err)).includes("Feedback is required") ? 400
        : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Archive task (done → archived)
  router.post("/tasks/:id/archive", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.archiveTask(req.params.id);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("must be in") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Unarchive task (archived → done)
  router.post("/tasks/:id/unarchive", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.unarchiveTask(req.params.id);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("must be in") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Archive all done tasks
  router.post("/tasks/archive-all-done", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const archived = await scopedStore.archiveAllDone();
      res.json({ archived });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/tasks/batch-update-models
   * Batch update AI model configuration for multiple tasks.
   * Body: { taskIds: string[], modelProvider?: string | null, modelId?: string | null, validatorModelProvider?: string | null, validatorModelId?: string | null, planningModelProvider?: string | null, planningModelId?: string | null }
   * Returns: { updated: Task[], count: number }
   */
  router.post("/tasks/batch-update-models", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { taskIds, modelProvider, modelId, validatorModelProvider, validatorModelId, planningModelProvider, planningModelId } = req.body;

      // Validate taskIds
      if (!Array.isArray(taskIds)) {
        throw badRequest("taskIds must be an array");
      }
      if (taskIds.length === 0) {
        throw badRequest("taskIds must contain at least one task ID");
      }
      if (taskIds.some((id) => typeof id !== "string" || id.trim().length === 0)) {
        throw badRequest("taskIds must contain non-empty strings");
      }

      // Validate that at least one model field is being updated
      const hasExecutorModel = modelProvider !== undefined || modelId !== undefined;
      const hasValidatorModel = validatorModelProvider !== undefined || validatorModelId !== undefined;
      const hasPlanningModel = planningModelProvider !== undefined || planningModelId !== undefined;
      if (!hasExecutorModel && !hasValidatorModel && !hasPlanningModel) {
        throw badRequest("At least one model field must be provided");
      }

      // Validate model field pairs (both provider and modelId must be provided together or neither)
      const validateModelPair = (provider: unknown, modelIdValue: unknown, name: string): { provider?: string | null; modelId?: string | null } => {
        if (provider === undefined && modelIdValue === undefined) {
          return { provider: undefined, modelId: undefined };
        }
        if ((provider !== undefined && modelIdValue === undefined) || (provider === undefined && modelIdValue !== undefined)) {
          throw new Error(`${name} must include both provider and modelId or neither`);
        }
        if (provider !== null && typeof provider !== "string") {
          throw new Error(`${name} provider must be a string or null`);
        }
        if (modelIdValue !== null && typeof modelIdValue !== "string") {
          throw new Error(`${name} modelId must be a string or null`);
        }
        return { provider: provider as string | null, modelId: modelIdValue as string | null };
      };

      let validatedExecutor: { provider?: string | null; modelId?: string | null };
      let validatedValidator: { provider?: string | null; modelId?: string | null };
      let validatedPlanning: { provider?: string | null; modelId?: string | null };

      try {
        validatedExecutor = validateModelPair(modelProvider, modelId, "Executor model");
        validatedValidator = validateModelPair(validatorModelProvider, validatorModelId, "Validator model");
        validatedPlanning = validateModelPair(planningModelProvider, planningModelId, "Planning model");
      } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
        throw badRequest(err instanceof Error ? err.message : String(err));
      }

      // Verify all tasks exist
      const tasksById = new Map<string, Awaited<ReturnType<TaskStore["getTask"]>>>();
      for (const taskId of taskIds) {
        try {
          const task = await scopedStore.getTask(taskId);
          tasksById.set(taskId, task);
        } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
          if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err instanceof Error ? err.message : String(err)).includes("not found")) {
            throw notFound(`Task ${taskId} not found`);
          }
          throw err;
        }
      }

      // Build update payload (only include fields that were explicitly provided)
      const updates: { modelProvider?: string | null; modelId?: string | null; validatorModelProvider?: string | null; validatorModelId?: string | null; planningModelProvider?: string | null; planningModelId?: string | null } = {};
      if (validatedExecutor.provider !== undefined) {
        updates.modelProvider = validatedExecutor.provider;
      }
      if (validatedExecutor.modelId !== undefined) {
        updates.modelId = validatedExecutor.modelId;
      }
      if (validatedValidator.provider !== undefined) {
        updates.validatorModelProvider = validatedValidator.provider;
      }
      if (validatedValidator.modelId !== undefined) {
        updates.validatorModelId = validatedValidator.modelId;
      }
      if (validatedPlanning.provider !== undefined) {
        updates.planningModelProvider = validatedPlanning.provider;
      }
      if (validatedPlanning.modelId !== undefined) {
        updates.planningModelId = validatedPlanning.modelId;
      }

      // Update all tasks in parallel
      const updatePromises = taskIds.map(async (taskId) => {
        try {
          const updated = await scopedStore.updateTask(taskId, updates);
          return { success: true, task: updated };
        } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
          runtimeLogger.error(`Failed to update task ${taskId}`, {
            error: err instanceof Error ? err.message : String(err),
          });
          const success = false;
          return { success, taskId, error: err instanceof Error ? err.message : String(err) };
        }
      });

      const results = await Promise.all(updatePromises);

      // Collect successful updates
      const updated: Task[] = [];
      const errors: Array<{ taskId: string; error: string | undefined }> = [];

      for (const result of results) {
        if (result.success && "task" in result && result.task) {
          updated.push(result.task);
        } else if (!result.success) {
          errors.push({ taskId: result.taskId, error: result.error });
        }
      }

      // Log errors but don't fail the entire request
      if (errors.length > 0) {
        runtimeLogger.error(`${errors.length} tasks failed to update`, { errors });
      }

      res.json({ updated, count: updated.length });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to batch update models");
    }
  });

  // Upload attachment
  router.post("/tasks/:id/attachments", upload.single("file"), async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      if (!req.file) {
        throw badRequest("No file provided");
      }
      const attachment = await scopedStore.addAttachment(
        req.params.id as string,
        req.file.originalname,
        req.file.buffer,
        req.file.mimetype,
      );
      res.status(201).json(attachment);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("Invalid mime type") || (err instanceof Error ? err.message : String(err)).includes("File too large") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Download attachment
  router.get("/tasks/:id/attachments/:filename", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { path, mimeType } = await scopedStore.getAttachment(req.params.id, req.params.filename);
      res.setHeader("Content-Type", mimeType);
      createReadStream(path).pipe(res);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Attachment not found");
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // Delete attachment
  router.delete("/tasks/:id/attachments/:filename", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.deleteAttachment(req.params.id, req.params.filename);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Attachment not found");
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // Get historical agent logs for a task.
  // Per-entry text and detail fields are returned in full — no truncation.
  // The 500-entry cap (MAX_LOG_ENTRIES) is a client-side whole-list limit.
  // When limit is provided, includes X-Total-Count and X-Has-More headers for pagination.
  router.get("/tasks/:id/logs", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const limit = typeof req.query.limit === "string"
        ? Number.parseInt(req.query.limit, 10)
        : undefined;
      const offset = typeof req.query.offset === "string"
        ? Number.parseInt(req.query.offset, 10)
        : undefined;

      // Only include options object when we have explicit parameters
      const options: { limit?: number; offset?: number } | undefined =
        limit !== undefined && Number.isFinite(limit)
          ? { limit, ...(offset !== undefined && Number.isFinite(offset) ? { offset } : {}) }
          : undefined;

      const logs = await scopedStore.getAgentLogs(req.params.id, options);

      // Include pagination headers for bounded reads, including the initial page.
      // This enables the frontend to show Load More before an offset is present.
      if (limit !== undefined && Number.isFinite(limit)) {
        const total = await scopedStore.getAgentLogCount(req.params.id);
        res.setHeader("X-Total-Count", String(total));

        const effectiveOffset = offset !== undefined && Number.isFinite(offset) ? offset : 0;
        const hasMore = total > (effectiveOffset + logs.length);
        res.setHeader("X-Has-More", hasMore ? "true" : "false");
      }

      res.json(logs);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * Resolve the diff base ref for a task's worktree.
   *
   * Strategy (in priority order):
   * 1. **Branch merge-base** — Prefer the live merge-base between HEAD and
   *    `origin/{baseBranch}` (or bare `{baseBranch}`). This stays correct as
   *    the base branch advances and is merged into the feature branch.
   * 2. **Task-scoped baseCommitSha** — Only when no merge-base is available
   *    (e.g. the base branch was deleted), fall back to the stored SHA if it
   *    is still an ancestor of HEAD.
   * 3. **HEAD~1** — Last resort when neither merge-base nor baseCommitSha
   *    can be resolved.
   *
   * Why not prefer baseCommitSha: a stored SHA captured at worktree creation
   * goes stale as upstream merges land on the feature branch. The ancestor
   * check passes but the diff now includes every upstream file that was
   * merged in, inflating the changed-files count.
   */
  async function resolveDiffBase(task: { baseCommitSha?: string; baseBranch?: string }, cwd: string): Promise<string | undefined> {
    const baseBranch = task.baseBranch ?? "main";
    let mergeBase: string | undefined;
    try {
      try {
        mergeBase = (await runGitCommand(["merge-base", "HEAD", `origin/${baseBranch}`], cwd, 5000)).trim() || undefined;
      } catch {
        mergeBase = (await runGitCommand(["merge-base", "HEAD", baseBranch], cwd, 5000)).trim() || undefined;
      }
    } catch {
      // base branch may no longer exist locally
    }

    // If the merge-base equals HEAD, we're on the base branch with no feature
    // divergence — the live merge-base would give an empty diff, so prefer the
    // task-scoped baseCommitSha instead.
    if (mergeBase) {
      try {
        const head = (await runGitCommand(["rev-parse", "HEAD"], cwd, 5000)).trim();
        if (head && head !== mergeBase) return mergeBase;
      } catch {
        return mergeBase;
      }
    }

    if (task.baseCommitSha) {
      try {
        await runGitCommand(["merge-base", "--is-ancestor", task.baseCommitSha, "HEAD"], cwd, 5000);
        return task.baseCommitSha;
      } catch {
        // stale or unreachable — fall through
      }
    }

    try {
      return (await runGitCommand(["rev-parse", "HEAD~1"], cwd, 5000)).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  router.get("/tasks/:id/session-files", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      // Check worktree existence asynchronously to avoid blocking event loop
      if (!task.worktree) {
        res.json([]);
        return;
      }
      let worktreeExists = false;
      try {
        await access(task.worktree);
        worktreeExists = true;
      } catch {
        worktreeExists = false;
      }
      if (!worktreeExists) {
        res.json([]);
        return;
      }
      const worktree = task.worktree; // Capture after check

      const cached = sessionFilesCache.get(task.id);
      if (cached && cached.expiresAt > Date.now()) {
        res.json(cached.files);
        return;
      }

      let files: string[] = [];

      try {
        const fileSet = new Set<string>();
        const baseRef = await resolveDiffBase(task, worktree);

        if (baseRef) {
          // Committed changes since baseRef
          const committedOutput = (await runGitCommand(["diff", "--name-only", `${baseRef}..HEAD`], worktree, 5000)).trim();
          for (const file of committedOutput.split("\n").filter(Boolean)) {
            fileSet.add(file);
          }
        }

        // Staged changes (in git index)
        const stagedOutput = (await runGitCommand(["diff", "--cached", "--name-only"], worktree, 5000)).trim();
        for (const file of stagedOutput.split("\n").filter(Boolean)) {
          fileSet.add(file);
        }

        // Unstaged working tree changes
        const workingTreeOutput = (await runGitCommand(["diff", "--name-only"], worktree, 5000)).trim();
        for (const file of workingTreeOutput.split("\n").filter(Boolean)) {
          fileSet.add(file);
        }

        // Untracked files (new files not yet staged)
        const untrackedOutput = (await runGitCommand(["ls-files", "--others", "--exclude-standard"], worktree, 5000)).trim();
        for (const file of untrackedOutput.split("\n").filter(Boolean)) {
          fileSet.add(file);
        }

        files = Array.from(fileSet);
      } catch {
        files = [];
      }

      sessionFilesCache.set(task.id, {
        files,
        expiresAt: Date.now() + 10000,
      });

      res.json(files);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /**
   * GET /api/tasks/:id/workflow-results
   * Get workflow step execution results for a task.
   * Returns: WorkflowStepResult[]
   */
  router.get("/tasks/:id/workflow-results", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      res.json(task.workflowStepResults || []);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  // Get single task with prompt content
  router.get("/tasks/:id", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id, {
        activityLogLimit: TASK_DETAIL_ACTIVITY_LOG_LIMIT,
      });
      res.json(trimTaskDetailActivityLog(task));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      // ENOENT means the task directory/file genuinely doesn't exist → 404.
      // Any other error (e.g. JSON parse failure from a concurrent partial write,
      // or a transient FS error) should surface as 500 so clients can retry.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  // Pause task
  router.post("/tasks/:id/pause", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.pauseTask(req.params.id, true);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Unpause task
  router.post("/tasks/:id/unpause", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.pauseTask(req.params.id, false);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Approve plan for a task in awaiting-approval status
  router.post("/tasks/:id/approve-plan", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);

      // Verify task is in triage column with awaiting-approval status
      if (task.column !== "triage") {
        throw badRequest("Task must be in 'triage' column to approve plan");
      }
      if (task.status !== "awaiting-approval") {
        throw badRequest("Task must have status 'awaiting-approval' to approve plan");
      }

      // Log the approval
      await scopedStore.logEntry(task.id, "Plan approved by user");

      // Move to todo and clear status
      const updated = await scopedStore.moveTask(task.id, "todo");
      await scopedStore.updateTask(task.id, { status: undefined });

      res.json({ ...updated, status: undefined });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Reject plan for a task in awaiting-approval status
  router.post("/tasks/:id/reject-plan", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);

      // Verify task is in triage column with awaiting-approval status
      if (task.column !== "triage") {
        throw badRequest("Task must be in 'triage' column to reject plan");
      }
      if (task.status !== "awaiting-approval") {
        throw badRequest("Task must have status 'awaiting-approval' to reject plan");
      }

      // Log the rejection
      await scopedStore.logEntry(task.id, "Plan rejected by user", "Specification will be regenerated");

      // Clear status to return to normal triage state
      await scopedStore.updateTask(task.id, { status: undefined });

      // Remove PROMPT.md to force regeneration
      const { rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
      await rm(promptPath, { force: true });

      const updated = await scopedStore.getTask(task.id);
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  router.get("/tasks/:id/comments", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      res.json(task.comments || []);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  router.post("/tasks/:id/comments", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { text, author } = req.body;
      if (!text || typeof text !== "string") {
        throw badRequest("text is required and must be a string");
      }
      if (text.length === 0 || text.length > 2000) {
        throw badRequest("text must be between 1 and 2000 characters");
      }
      if (author !== undefined && typeof author !== "string") {
        throw badRequest("author must be a string");
      }
      const task = await scopedStore.addTaskComment(req.params.id, text, author?.trim() || "user");

      const newCommentId = task.comments?.at(-1)?.id;
      void triggerCommentWakeForAssignedAgent(scopedStore, task, {
        triggeringCommentType: "task",
        triggeringCommentIds: newCommentId ? [newCommentId] : undefined,
        triggerDetail: "task-comment",
      }).catch((error) => {
        runtimeLogger.warn(
          `failed to trigger task-comment heartbeat for ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  router.patch("/tasks/:id/comments/:commentId", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { text } = req.body;
      if (!text || typeof text !== "string") {
        throw badRequest("text is required and must be a string");
      }
      if (text.length === 0 || text.length > 2000) {
        throw badRequest("text must be between 1 and 2000 characters");
      }
      const task = await scopedStore.updateTaskComment(req.params.id, req.params.commentId, text);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404
        : (err instanceof Error ? err.message : String(err)).includes("not found") ? 404
        : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  router.delete("/tasks/:id/comments/:commentId", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.deleteTaskComment(req.params.id, req.params.commentId);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404
        : (err instanceof Error ? err.message : String(err)).includes("not found") ? 404
        : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // ── Task Document Routes ──────────────────────────────────────────────────

  // Key validation regex: alphanumeric, hyphens, underscores, 1-64 chars
  const DOCUMENT_KEY_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

  // GET /tasks/:id/documents — List all documents for a task
  router.get("/tasks/:id/documents", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const documents = await scopedStore.getTaskDocuments(req.params.id);
      res.json(documents);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // GET /tasks/:id/documents/:key — Get latest revision of a specific document
  router.get("/tasks/:id/documents/:key", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const document = await scopedStore.getTaskDocument(req.params.id, req.params.key);
      if (!document) {
        throw new ApiError(404, "Document not found");
      }
      res.json(document);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // GET /tasks/:id/documents/:key/revisions — List all revisions for a document
  router.get("/tasks/:id/documents/:key/revisions", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const revisions = await scopedStore.getTaskDocumentRevisions(req.params.id, req.params.key);
      res.json(revisions);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      // Return empty array if document doesn't exist (not an error)
      res.json([]);
    }
  });

  // PUT /tasks/:id/documents/:key — Create or update a document (optimistic revision)
  router.put("/tasks/:id/documents/:key", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);

      // Validate key format
      if (!DOCUMENT_KEY_REGEX.test(req.params.key)) {
        throw badRequest("Invalid document key. Must be 1-64 alphanumeric characters, hyphens, or underscores.");
      }

      const { content, author, metadata } = req.body;

      // Validate content
      if (content === undefined || content === null) {
        throw badRequest("content is required");
      }
      if (typeof content !== "string") {
        throw badRequest("content must be a string");
      }
      if (content.length < 1 || content.length > 100000) {
        throw badRequest("content must be between 1 and 100000 characters");
      }

      // Validate author (optional, defaults to "user")
      if (author !== undefined && typeof author !== "string") {
        throw badRequest("author must be a string");
      }

      // Validate metadata (optional)
      if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))) {
        throw badRequest("metadata must be an object");
      }

      const document = await scopedStore.upsertTaskDocument(req.params.id, {
        key: req.params.key,
        content,
        author: author?.trim() || "user",
        metadata: metadata as Record<string, unknown> | undefined,
      });

      // Return 201 for new documents (revision === 1), 200 for updates
      const status = document.revision === 1 ? 201 : 200;
      res.status(status).json(document);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // DELETE /tasks/:id/documents/:key — Delete a document and all its revisions
  router.delete("/tasks/:id/documents/:key", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      await scopedStore.deleteTaskDocument(req.params.id, req.params.key);
      res.status(204).send();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("not found") ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // GET /documents — List all documents across all tasks
  router.get("/documents", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);

      // Parse query parameters
      const { q, limit: limitStr, offset: offsetStr } = req.query as Record<string, string | undefined>;

      // Validate limit
      let limit = 200;
      if (limitStr !== undefined) {
        const parsed = parseInt(limitStr, 10);
        if (isNaN(parsed) || parsed < 1) {
          throw badRequest("limit must be a positive integer");
        }
        limit = Math.min(parsed, 1000);
      }

      // Validate offset
      let offset = 0;
      if (offsetStr !== undefined) {
        const parsed = parseInt(offsetStr, 10);
        if (isNaN(parsed) || parsed < 0) {
          throw badRequest("offset must be a non-negative integer");
        }
        offset = parsed;
      }

      const documents = await scopedStore.getAllDocuments({
        searchQuery: q,
        limit,
        offset,
      });

      res.json(documents);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw new ApiError(500, err instanceof Error ? err.message : String(err));
    }
  });

  // GET /project-files/md — List Markdown files in the project directory
  router.get("/project-files/md", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const files = await scanMarkdownFiles(scopedStore);
      const query = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";

      const filteredFiles = query.length > 0
        ? files.filter((file) => file.name.toLowerCase().includes(query) || file.contentPreview.toLowerCase().includes(query))
        : files;

      res.json(filteredFiles);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  // Add steering comment to task
  router.post("/tasks/:id/steer", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { text } = req.body;
      if (!text || typeof text !== "string") {
        throw badRequest("text is required and must be a string");
      }
      if (text.length === 0 || text.length > 2000) {
        throw badRequest("text must be between 1 and 2000 characters");
      }
      const task = await scopedStore.addSteeringComment(req.params.id, text, "user");

      const newSteeringCommentId = task.steeringComments?.at(-1)?.id;
      void triggerCommentWakeForAssignedAgent(scopedStore, task, {
        triggeringCommentType: "steering",
        triggeringCommentIds: newSteeringCommentId ? [newSteeringCommentId] : undefined,
        triggerDetail: "steering-comment",
      }).catch((error) => {
        runtimeLogger.warn(
          `failed to trigger steering-comment heartbeat for ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Request AI revision of task spec
  router.post("/tasks/:id/spec/revise", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { feedback } = req.body;
      if (!feedback || typeof feedback !== "string") {
        throw badRequest("feedback is required and must be a string");
      }
      if (feedback.length === 0 || feedback.length > 2000) {
        throw badRequest("feedback must be between 1 and 2000 characters");
      }

      // Get current task state
      const task = await scopedStore.getTask(req.params.id);

      // If task is already in triage, skip the transition check and moveTask.
      // Just reset for re-specification in place.
      if (task.column === "triage") {
        // Log the revision request
        await scopedStore.logEntry(task.id, "AI spec revision requested", feedback);

        // Remove the existing spec so re-specification starts from the task
        // description and feedback rather than revising stale PROMPT.md content.
        const { rm } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
        await rm(promptPath, { force: true });

        // Update status to indicate needs re-specification
        await scopedStore.updateTask(task.id, { status: "needs-respecify" });

        const updated = await scopedStore.getTask(task.id);
        res.json(updated);
        return;
      }

      // Check if task can transition to triage
      const canTransition = VALID_TRANSITIONS[task.column]?.includes("triage");
      if (!canTransition) {
        throw badRequest(
          `Cannot request spec revision for tasks in '${task.column}' column. Move task to 'todo' or 'in-progress' first.`,
        );
      }

      // Log the revision request
      await scopedStore.logEntry(task.id, "AI spec revision requested", feedback);

      // Move to triage for re-specification
      const updated = await scopedStore.moveTask(task.id, "triage");

      // Remove the existing spec so re-specification starts from the task
      // description and feedback rather than revising stale PROMPT.md content.
      const { rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
      await rm(promptPath, { force: true });

      // Update status to indicate needs re-specification
      await scopedStore.updateTask(task.id, { status: "needs-respecify" });

      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404
        : (err instanceof Error ? err.message : String(err)).includes("Invalid transition") ? 400
        : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Rebuild task spec without feedback
  router.post("/tasks/:id/spec/rebuild", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);

      // Get current task state
      const task = await scopedStore.getTask(req.params.id);

      // If task is already in triage, skip the transition check and moveTask.
      // Just reset for re-specification in place.
      if (task.column === "triage") {
        // Log the rebuild request
        await scopedStore.logEntry(task.id, "Specification rebuild requested by user");

        // Remove the existing spec so rebuilds produce a fresh PROMPT.md instead
        // of asking triage to revise whatever was already on disk.
        const { rm } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
        await rm(promptPath, { force: true });

        // Update status to indicate needs re-specification
        await scopedStore.updateTask(task.id, { status: "needs-respecify" });

        const updated = await scopedStore.getTask(task.id);
        res.json(updated);
        return;
      }

      // Check if task can transition to triage
      const canTransition = VALID_TRANSITIONS[task.column]?.includes("triage");
      if (!canTransition) {
        throw badRequest(`Cannot rebuild spec for tasks in '${task.column}' column. Move task to a valid column first.`);
      }

      // Log the rebuild request
      await scopedStore.logEntry(task.id, "Specification rebuild requested by user");

      // Move to triage for re-specification
      const updated = await scopedStore.moveTask(task.id, "triage");

      // Remove the existing spec so rebuilds produce a fresh PROMPT.md instead
      // of asking triage to revise whatever was already on disk.
      const { rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
      await rm(promptPath, { force: true });

      // Update status to indicate needs re-specification
      await scopedStore.updateTask(task.id, { status: "needs-respecify" });

      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404
        : (err instanceof Error ? err.message : String(err)).includes("Invalid transition") ? 400
        : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Update task
  router.patch("/tasks/:id", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { title, description, prompt, dependencies, enabledWorkflowSteps, modelProvider, modelId, validatorModelProvider, validatorModelId, planningModelProvider, planningModelId, thinkingLevel, assigneeUserId, reviewLevel, executionMode } = req.body;
      const hasBodyField = (field: string) => Object.prototype.hasOwnProperty.call(req.body, field);

      // Validate model fields are strings or undefined/null
      const validateModelField = (value: unknown, name: string): string | null | undefined => {
        if (value === undefined) return undefined;
        if (value === null) return null;
        if (typeof value !== "string") {
          throw new Error(`${name} must be a string`);
        }
        return value;
      };

      const validatedModelProvider = validateModelField(modelProvider, "modelProvider");
      const validatedModelId = validateModelField(modelId, "modelId");
      const validatedValidatorModelProvider = validateModelField(validatorModelProvider, "validatorModelProvider");
      const validatedValidatorModelId = validateModelField(validatorModelId, "validatorModelId");
      const validatedPlanningModelProvider = validateModelField(planningModelProvider, "planningModelProvider");
      const validatedPlanningModelId = validateModelField(planningModelId, "planningModelId");
      const validatedAssigneeUserId = validateModelField(assigneeUserId, "assigneeUserId");

      // Validate thinkingLevel if provided
      const validThinkingLevels = ["off", "minimal", "low", "medium", "high"];
      if (thinkingLevel !== undefined && thinkingLevel !== null && !validThinkingLevels.includes(thinkingLevel)) {
        throw new Error(`thinkingLevel must be one of: ${validThinkingLevels.join(", ")}`);
      }

      // Validate reviewLevel if provided (must be integer 0-3)
      if (reviewLevel !== undefined && reviewLevel !== null) {
        if (typeof reviewLevel !== "number" || !Number.isInteger(reviewLevel) || reviewLevel < 0 || reviewLevel > 3) {
          throw new Error("reviewLevel must be an integer between 0 and 3");
        }
      }

      // Validate executionMode if provided (must be "standard" or "fast")
      const validExecutionModes = ["standard", "fast"];
      if (executionMode !== undefined && executionMode !== null && !validExecutionModes.includes(executionMode)) {
        throw new Error(`executionMode must be one of: ${validExecutionModes.join(", ")}`);
      }

      if (enabledWorkflowSteps !== undefined) {
        if (!Array.isArray(enabledWorkflowSteps) || !enabledWorkflowSteps.every((id: unknown) => typeof id === "string")) {
          throw new Error("enabledWorkflowSteps must be an array of strings");
        }
      }

      const updates: Parameters<typeof scopedStore.updateTask>[1] = {};
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (prompt !== undefined) updates.prompt = prompt;
      if (dependencies !== undefined) updates.dependencies = dependencies;
      if (enabledWorkflowSteps !== undefined) updates.enabledWorkflowSteps = enabledWorkflowSteps;
      if (hasBodyField("modelProvider")) updates.modelProvider = validatedModelProvider;
      if (hasBodyField("modelId")) updates.modelId = validatedModelId;
      if (hasBodyField("validatorModelProvider")) updates.validatorModelProvider = validatedValidatorModelProvider;
      if (hasBodyField("validatorModelId")) updates.validatorModelId = validatedValidatorModelId;
      if (hasBodyField("planningModelProvider")) updates.planningModelProvider = validatedPlanningModelProvider;
      if (hasBodyField("planningModelId")) updates.planningModelId = validatedPlanningModelId;
      if (hasBodyField("thinkingLevel")) updates.thinkingLevel = thinkingLevel === null ? null : thinkingLevel;
      if (hasBodyField("assigneeUserId")) updates.assigneeUserId = validatedAssigneeUserId;
      if (hasBodyField("reviewLevel")) updates.reviewLevel = reviewLevel;
      if (hasBodyField("executionMode")) updates.executionMode = executionMode === null ? null : executionMode;

      const task = await scopedStore.updateTask(req.params.id, updates);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("must be a string") || (err instanceof Error ? err.message : String(err)).includes("must be an array of strings") || (err instanceof Error ? err.message : String(err)).includes("thinkingLevel must be one of") || (err instanceof Error ? err.message : String(err)).includes("reviewLevel must be an integer") || (err instanceof Error ? err.message : String(err)).includes("executionMode must be one of") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Assign or unassign a task to an explicit agent
  router.patch("/tasks/:id/assign", async (req, res) => {
    try {
      const { agentId } = req.body as { agentId?: string | null };
      if (agentId !== null && typeof agentId !== "string") {
        throw badRequest("agentId must be a string or null");
      }
      if (typeof agentId === "string" && agentId.trim().length === 0) {
        throw badRequest("agentId must be a non-empty string or null");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      if (typeof agentId === "string") {
        const agent = await agentStore.getAgent(agentId);
        if (!agent) {
          throw notFound("Agent not found");
        }
      }

      const task = await scopedStore.updateTask(req.params.id, {
        assignedAgentId: agentId === null ? null : agentId,
      });
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // Assign or unassign a task to a user (for review handoff)
  router.patch("/tasks/:id/assign-user", async (req, res) => {
    try {
      const { userId } = req.body as { userId?: string | null };
      if (userId !== null && typeof userId !== "string") {
        throw badRequest("userId must be a string or null");
      }
      if (typeof userId === "string" && userId.trim().length === 0) {
        throw badRequest("userId must be a non-empty string or null");
      }

      const { store: scopedStore } = await getProjectContext(req);

      // When assigning a user, also clear the awaiting-user-review status
      // so the task can proceed to merge
      const updates: Record<string, unknown> = {
        assigneeUserId: userId === null ? null : userId,
      };

      // Clear awaiting-user-review status when explicitly assigning a user
      if (userId !== null) {
        updates.status = null;
      }

      const task = await scopedStore.updateTask(req.params.id, updates as Parameters<typeof scopedStore.updateTask>[1]);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // Accept review - clear assignee and awaiting-user-review status, keep in in-review
  router.post("/tasks/:id/accept-review", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);

      // Clear assignee and status to allow auto-merge to proceed
      const task = await scopedStore.updateTask(req.params.id, {
        assigneeUserId: null,
        status: null,
      });
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // Return task to agent - clear assignee and status, move to todo
  router.post("/tasks/:id/return-to-agent", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);

      // Clear assignee and status, move to todo so scheduler re-dispatches
      await scopedStore.updateTask(req.params.id, {
        assigneeUserId: null,
        status: null,
      });
      const task = await scopedStore.moveTask(req.params.id, "todo");
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // Acquire checkout lease for a task
  router.post("/tasks/:id/checkout", async (req, res) => {
    try {
      const { agentId } = req.body ?? {};
      if (typeof agentId !== "string" || agentId.trim().length === 0) {
        throw badRequest("agentId is required");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({
        rootDir: scopedStore.getFusionDir(),
        taskStore: scopedStore,
      });
      await agentStore.init();

      const task = await agentStore.checkoutTask(agentId, req.params.id);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "CheckoutConflictError") {
        const checkoutErr = err as Error & { currentHolderId?: string; taskId?: string };
        res.status(409).json({
          error: "Task is already checked out",
          currentHolder: checkoutErr.currentHolderId,
          taskId: checkoutErr.taskId,
        });
        return;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  // Release checkout lease for a task
  router.post("/tasks/:id/release", async (req, res) => {
    try {
      const { agentId } = req.body ?? {};
      if (typeof agentId !== "string" || agentId.trim().length === 0) {
        throw badRequest("agentId is required");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({
        rootDir: scopedStore.getFusionDir(),
        taskStore: scopedStore,
      });
      await agentStore.init();

      const task = await agentStore.releaseTask(agentId, req.params.id);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not the checkout holder")) {
        throw new ApiError(403, "Not the checkout holder");
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  // Force release checkout lease for a task
  router.post("/tasks/:id/force-release", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({
        rootDir: scopedStore.getFusionDir(),
        taskStore: scopedStore,
      });
      await agentStore.init();

      const task = await agentStore.forceReleaseTask(req.params.id);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  // Get checkout lease state for a task
  router.get("/tasks/:id/checkout", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (!task) {
        throw notFound("Task not found");
      }

      res.json({
        checkedOutBy: task.checkedOutBy ?? null,
        checkedOutAt: task.checkedOutAt ?? null,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Delete task
  router.delete("/tasks/:id", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.deleteTask(req.params.id);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

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

  // ── PR Management Routes ─────────────────────────────────────────

  /**
   * POST /api/tasks/:id/pr/create
   * Create a GitHub PR for an in-review task.
   * Body: { title: string, body?: string, base?: string }
   * Returns: Created PrInfo
   */
  router.post("/tasks/:id/pr/create", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { title, body, base } = req.body;

      if (!title || typeof title !== "string") {
        throw badRequest("title is required and must be a string");
      }

      // Get task and validate
      const task = await scopedStore.getTask(req.params.id);
      if (task.column !== "in-review") {
        throw badRequest("Task must be in 'in-review' column to create a PR");
      }

      if (task.prInfo) {
        throw conflict(`Task already has PR #${task.prInfo.number}: ${task.prInfo.url}`);
      }

      // Determine branch name from task
      const branchName = `fusion/${task.id.toLowerCase()}`;

      // Get owner/repo from git remote or GITHUB_REPOSITORY env
      let owner: string;
      let repo: string;

      const envRepo = process.env.GITHUB_REPOSITORY;
      if (envRepo) {
        const [o, r] = envRepo.split("/");
        owner = o;
        repo = r;
      } else {
        const gitRepo = getCurrentRepo(scopedStore.getRootDir());
        if (!gitRepo) {
          throw badRequest("Could not determine GitHub repository. Set GITHUB_REPOSITORY env var or configure git remote.");
        }
        owner = gitRepo.owner;
        repo = gitRepo.repo;
      }

      // Check rate limit
      const repoKey = `${owner}/${repo}`;
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

      // Create the PR
      const client = new GitHubClient();

      const prInfo = await client.createPr({
        owner,
        repo,
        title,
        body,
        head: branchName,
        base,
      });

      // Store PR info
      await scopedStore.updatePrInfo(task.id, prInfo);
      await scopedStore.logEntry(task.id, "Created PR", `PR #${prInfo.number}: ${prInfo.url}`);

      res.status(201).json(prInfo);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else if ((err instanceof Error ? err.message : String(err)).includes("already exists")) {
        throw conflict(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("No commits between")) {
        throw badRequest("Branch has no commits. Push changes before creating PR.");
      } else {
        rethrowAsApiError(err, "Failed to create PR");
      }
    }
  });

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
   * GET /api/tasks/:id/pr/status
   * Get cached PR status for a task. Triggers background refresh if stale (>5 min).
   * Uses only persisted badge timestamps (no in-memory poller state).
   */
  router.get("/tasks/:id/pr/status", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);

      if (!task.prInfo) {
        throw notFound("Task has no associated PR");
      }

      // Check if data is stale (>5 minutes since last check)
      const fiveMinutesMs = 5 * 60 * 1000;
      const lastChecked = task.prInfo.lastCheckedAt || task.updatedAt;
      const lastCheckedTime = new Date(lastChecked).getTime();
      const isStale = Date.now() - lastCheckedTime > fiveMinutesMs;

      // Return cached data immediately
      res.json({
        prInfo: task.prInfo,
        stale: isStale,
        automationStatus: task.status ?? null,
      });

      // Trigger background refresh if stale (don't await, let it run)
      if (isStale) {
        refreshPrInBackground(scopedStore, task.id, task.prInfo, githubToken);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/tasks/:id/pr/refresh
   * Force refresh PR status from GitHub API.
   * Returns: Updated PrInfo
   */
  router.post("/tasks/:id/pr/refresh", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);

      if (!task.prInfo) {
        throw notFound("Task has no associated PR");
      }

      // Get owner/repo from badge URL first, then fall back to env/git
      let owner: string;
      let repo: string;

      const badgeParsed = parseBadgeUrl(task.prInfo.url);
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
          const gitRepo = getCurrentRepo(scopedStore.getRootDir());
          if (!gitRepo) {
            throw badRequest("Could not determine GitHub repository");
          }
          owner = gitRepo.owner;
          repo = gitRepo.repo;
        }
      }

      // Check rate limit
      const repoKey = `${owner}/${repo}`;
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

      // Fetch fresh PR status + merge readiness
      const client = new GitHubClient();
      const mergeStatus = await client.getPrMergeStatus(owner, repo, task.prInfo.number);

      const prInfo = {
        ...mergeStatus.prInfo,
        lastCheckedAt: new Date().toISOString(),
      };

      // Update stored PR info
      await scopedStore.updatePrInfo(task.id, prInfo);

      res.json({
        prInfo,
        mergeReady: mergeStatus.mergeReady,
        blockingReasons: mergeStatus.blockingReasons,
        reviewDecision: mergeStatus.reviewDecision,
        checks: mergeStatus.checks,
        automationStatus: task.status ?? null,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/tasks/:id/issue/status
   * Get cached issue status for a task. Triggers background refresh if stale (>5 min).
   * Uses only persisted badge timestamps (no in-memory poller state).
   */
  router.get("/tasks/:id/issue/status", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);

      if (!task.issueInfo) {
        throw notFound("Task has no associated issue");
      }

      const fiveMinutesMs = 5 * 60 * 1000;
      const lastChecked = task.issueInfo.lastCheckedAt || task.updatedAt;
      const lastCheckedTime = new Date(lastChecked).getTime();
      const isStale = Date.now() - lastCheckedTime > fiveMinutesMs;

      res.json({
        issueInfo: task.issueInfo,
        stale: isStale,
      });

      if (isStale) {
        refreshIssueInBackground(scopedStore, task.id, task.issueInfo, githubToken);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/tasks/:id/issue/refresh
   * Force refresh issue status from GitHub API.
   * Returns: Updated IssueInfo
   */
  router.post("/tasks/:id/issue/refresh", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);

      if (!task.issueInfo) {
        throw notFound("Task has no associated issue");
      }

      let owner: string;
      let repo: string;

      // Get owner/repo from badge URL first, then fall back to env/git
      const badgeParsed = parseBadgeUrl(task.issueInfo.url);
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
          const gitRepo = getCurrentRepo(scopedStore.getRootDir());
          if (!gitRepo) {
            throw badRequest("Could not determine GitHub repository");
          }
          owner = gitRepo.owner;
          repo = gitRepo.repo;
        }
      }

      const repoKey = `${owner}/${repo}`;
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

      const client = new GitHubClient(githubToken);
      const issueInfo = await client.getIssueStatus(owner, repo, task.issueInfo.number);

      if (!issueInfo) {
        throw notFound(`Issue #${task.issueInfo.number} not found in ${owner}/${repo}`);
      }

      const updatedIssueInfo = {
        ...issueInfo,
        lastCheckedAt: new Date().toISOString(),
      };

      await scopedStore.updateIssueInfo(task.id, updatedIssueInfo);
      res.json(updatedIssueInfo);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
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
        } else {
          throw badRequest("Session is not running");
        }
        return;
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
        } else {
          throw badRequest("Failed to kill session");
        }
        return;
      }

      res.json({ killed: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── File API Routes ───────────────────────────────────────────────

  /**
   * GET /api/tasks/:id/files
   * List files in task directory (or worktree if available).
   * Query param: ?path=relative/path for subdirectory navigation.
   * Returns: { path: string; entries: FileNode[] }
   */
  router.get("/tasks/:id/files", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { path: subPath } = req.query;
      const result = await listFiles(scopedStore, req.params.id, typeof subPath === "string" ? subPath : undefined);
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
   * GET /api/tasks/:id/files/:filepath
   * Read file contents.
   * Returns: { content: string; mtime: string; size: number }
   */
  router.get("/tasks/:id/files/{*filepath}", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const filePath = Array.isArray(req.params.filepath) ? req.params.filepath[0] : req.params.filepath ?? "";
      const result = await readFile(scopedStore, req.params.id, filePath);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404
          : err.code === "ENOTASK" ? 404
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

  /**
   * POST /api/tasks/:id/files/:filepath
   * Write file contents.
   * Body: { content: string }
   * Returns: { success: true; mtime: string; size: number }
   */
  router.post("/tasks/:id/files/{*filepath}", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const filePath = Array.isArray(req.params.filepath) ? req.params.filepath[0] : req.params.filepath ?? "";
      const { content } = req.body;
      
      if (typeof content !== "string") {
        throw badRequest("content is required and must be a string");
      }

      const result = await writeFile(scopedStore, req.params.id, filePath, content);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404
          : err.code === "ENOTASK" ? 404
          : err.code === "EACCES" ? 403
          : err.code === "ETOOLARGE" ? 413
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
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
      const result: MarkdownFileListResponse = await listProjectMarkdownFiles(scopedStore);
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

  // ── Planning Mode Routes ──────────────────────────────────────────────────
  // UTILITY PATH: Planning and subtask session routes are on a separate control-plane lane.
  // They must NOT be gated on task-lane saturation (maxConcurrent, semaphore, queue depth).
  // These routes create/manage AI planning and subtask breakdown sessions.

  router.post("/subtasks/start-streaming", async (req, res) => {
    try {
      const { description } = req.body;

      if (!description || typeof description !== "string") {
        throw badRequest("description is required and must be a string");
      }

      if (description.length > 1000) {
        throw badRequest("description must be 1000 characters or less");
      }

      const { store: scopedStore, projectId } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const { createSubtaskSession } = await import("./subtask-breakdown.js");
      const session = await createSubtaskSession(
        description,
        scopedStore,
        scopedStore.getRootDir(),
        settings.promptOverrides,
        projectId,
      );
      res.status(201).json({ sessionId: session.sessionId });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to start subtask breakdown");
    }
  });

  router.get("/subtasks/:sessionId/stream", async (req, res) => {
    const { sessionId } = req.params;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(": connected\n\n");

    try {
      const { subtaskStreamManager, getSubtaskSession } = await import("./subtask-breakdown.js");
      const session = getSubtaskSession(sessionId);
      if (!session) {
        writeSSEEvent(res, "error", JSON.stringify("Session not found or expired"));
        res.end();
        return;
      }

      const lastEventId = parseLastEventId(req);
      if (lastEventId !== undefined) {
        const buffered = subtaskStreamManager.getBufferedEvents(sessionId, lastEventId);
        if (!replayBufferedSSE(res, buffered)) {
          res.end();
          return;
        }
      }

      if (session.status === "complete") {
        const existing = subtaskStreamManager.getBufferedEvents(sessionId, 0);

        const lastSubtasksEvent = [...existing].reverse().find((event) => event.event === "subtasks");
        const subtasksEventId = lastSubtasksEvent?.id
          ?? subtaskStreamManager.broadcast(sessionId, {
            type: "subtasks",
            data: session.subtasks,
          });

        if (lastEventId === undefined || subtasksEventId > lastEventId) {
          if (!writeSSEEvent(res, "subtasks", JSON.stringify(session.subtasks), subtasksEventId)) {
            res.end();
            return;
          }
        }

        const lastCompleteEvent = [...existing].reverse().find((event) => event.event === "complete");
        const completeEventId = lastCompleteEvent?.id
          ?? subtaskStreamManager.broadcast(sessionId, { type: "complete" });

        if (lastEventId === undefined || completeEventId > lastEventId) {
          writeSSEEvent(res, "complete", JSON.stringify({}), completeEventId);
        }

        res.end();
        return;
      }

      if (session.status === "error") {
        const errorMessage = String(session.error || "Unknown error");
        const existing = subtaskStreamManager.getBufferedEvents(sessionId, 0);
        const lastErrorEvent = [...existing].reverse().find((event) => event.event === "error");
        const errorEventId = lastErrorEvent?.id
          ?? subtaskStreamManager.broadcast(sessionId, {
            type: "error",
            data: errorMessage,
          });

        if (lastEventId === undefined || errorEventId > lastEventId) {
          writeSSEEvent(res, "error", JSON.stringify(errorMessage), errorEventId);
        }

        res.end();
        return;
      }

      const unsubscribe = subtaskStreamManager.subscribe(sessionId, (event, eventId) => {
        const data = (event as { data?: unknown }).data;
        if (!writeSSEEvent(res, event.type, JSON.stringify(data ?? {}), eventId)) {
          unsubscribe();
          return;
        }

        if (event.type === "complete" || event.type === "error") {
          unsubscribe();
          res.end();
        }
      });

      const heartbeat = setInterval(() => {
        if (res.writableEnded) {
          clearInterval(heartbeat);
          return;
        }
        res.write(": heartbeat\n\n");
      }, 30_000);

      req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      writeSSEEvent(res, "error", JSON.stringify(err instanceof Error ? err.message : String(err)));
      res.end();
    }
  });

  router.post("/subtasks/create-tasks", async (req, res) => {
    try {
      const { sessionId, subtasks, parentTaskId } = req.body as {
        sessionId?: string;
        subtasks?: Array<{ tempId: string; title: string; description: string; size?: "S" | "M" | "L"; dependsOn?: string[] }>;
        parentTaskId?: string;
      };

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      if (!Array.isArray(subtasks) || subtasks.length === 0) {
        throw badRequest("subtasks must be a non-empty array");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { getSubtaskSession, cleanupSubtaskSession } = await import("./subtask-breakdown.js");
      const session = getSubtaskSession(sessionId);
      if (!session) {
        throw notFound(`Subtask session ${sessionId} not found or expired`);
      }

      // Fetch parent task to inherit model settings if parentTaskId is provided
      let parentTask: Awaited<ReturnType<typeof store.getTask>> | undefined;
      if (typeof parentTaskId === "string" && parentTaskId.trim()) {
        try {
          parentTask = await scopedStore.getTask(parentTaskId);
        } catch {
          // Parent task not found or error - proceed without inheritance
          parentTask = undefined;
        }
      }

      const createdTasks = [] as Awaited<ReturnType<typeof store.createTask>>[];
      const tempIdToTaskId = new Map<string, string>();

      for (const item of subtasks) {
        if (!item || typeof item.tempId !== "string" || typeof item.title !== "string" || !item.title.trim()) {
          throw badRequest("Each subtask must include tempId and title");
        }

        const task = await scopedStore.createTask({
          title: item.title.trim(),
          description: typeof item.description === "string" ? item.description.trim() : item.title.trim(),
          column: "triage",
          dependencies: undefined,
          // Inherit parent's model settings if available
          modelProvider: parentTask?.modelProvider,
          modelId: parentTask?.modelId,
          validatorModelProvider: parentTask?.validatorModelProvider,
          validatorModelId: parentTask?.validatorModelId,
        });

        tempIdToTaskId.set(item.tempId, task.id);
        createdTasks.push(task);

        if (item.size === "S" || item.size === "M" || item.size === "L") {
          await scopedStore.updateTask(task.id, { size: item.size });
        }
      }

      // Resolve each subtask's dependsOn list:
      //   - map tempIds to the newly-created sibling task ids
      //   - drop any reference to the parent being split (would be a dangling id after delete)
      //   - record dropped ids so the caller can surface them instead of silently losing them
      const droppedDependencies: Array<{ taskId: string; dropped: string[] }> = [];
      const normalizedParentId = typeof parentTaskId === "string" ? parentTaskId.trim() : "";

      for (let index = 0; index < subtasks.length; index++) {
        const item = subtasks[index]!;
        const created = createdTasks[index]!;
        const rawDeps = Array.isArray(item.dependsOn) ? item.dependsOn : [];
        const resolvedDependencies: string[] = [];
        const dropped: string[] = [];

        for (const dep of rawDeps) {
          if (typeof dep !== "string" || !dep) continue;
          if (normalizedParentId && dep === normalizedParentId) {
            // Parent is about to be deleted — depending on it would permanently
            // block the dependent.
            dropped.push(dep);
            continue;
          }
          const siblingId = tempIdToTaskId.get(dep);
          if (siblingId) {
            resolvedDependencies.push(siblingId);
            continue;
          }
          // Not a sibling tempId and not the parent — it could be an existing
          // task id. Keep it only if it resolves to a live task; otherwise drop.
          try {
            await scopedStore.getTask(dep);
            resolvedDependencies.push(dep);
          } catch {
            dropped.push(dep);
          }
        }

        if (resolvedDependencies.length > 0) {
          const updated = await scopedStore.updateTask(created.id, { dependencies: resolvedDependencies });
          createdTasks[index] = updated;
        }
        if (dropped.length > 0) {
          droppedDependencies.push({ taskId: created.id, dropped });
          await scopedStore.logEntry(
            created.id,
            `Subtask breakdown: dropped invalid dependencies [${dropped.join(", ")}] (parent-id or unknown task id)`,
          );
        }

        await scopedStore.logEntry(created.id, "Created via subtask breakdown", `Source: ${session.initialDescription.slice(0, 200)}`);
      }

      let parentTaskClosed = false;
      let parentTaskCloseError: string | undefined;
      if (normalizedParentId) {
        try {
          await scopedStore.deleteTask(normalizedParentId);
          parentTaskClosed = true;
        } catch (err: unknown) {
          // deleteTask refuses when live tasks still reference the parent id.
          // Keep the parent alive and surface the reason; silently failing here
          // is what left FN-2164 blocked by the ghost of FN-2163.
          parentTaskClosed = false;
          parentTaskCloseError = err instanceof Error ? err.message : String(err);
        }
      }

      cleanupSubtaskSession(sessionId);
      res.status(201).json({
        tasks: createdTasks,
        parentTaskClosed,
        parentTaskCloseError,
        droppedDependencies,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to create tasks from breakdown");
    }
  });

  router.post("/subtasks/cancel", async (req, res) => {
    try {
      const { sessionId, tabId } = req.body;
      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const normalizedTabId = typeof tabId === "string" && tabId.trim().length > 0 ? tabId.trim() : undefined;
      const lockCheck = checkSessionLock(sessionId, normalizedTabId, aiSessionStore);
      if (!lockCheck.allowed) {
        res.status(409).json({
          error: "Session locked by another tab",
          lockedByTab: lockCheck.currentHolder,
        });
        return;
      }

      const { cancelSubtaskSession } = await import("./subtask-breakdown.js");
      await cancelSubtaskSession(sessionId);
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "SessionNotFoundError") {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err, "Failed to cancel subtask session");
      }
    }
  });

  /**
   * POST /api/subtasks/:sessionId/retry
   * Retry a failed subtask breakdown session.
   *
   * UTILITY PATH: This route is independent of task-lane saturation.
   * Session-lock 409 with { error, lockedByTab } is preserved.
   */
  router.post("/subtasks/:sessionId/retry", async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const tabId = typeof req.body?.tabId === "string" && req.body.tabId.trim().length > 0
        ? req.body.tabId.trim()
        : undefined;
      const lockCheck = checkSessionLock(sessionId, tabId, aiSessionStore);
      if (!lockCheck.allowed) {
        res.status(409).json({
          error: "Session locked by another tab",
          lockedByTab: lockCheck.currentHolder,
        });
        return;
      }

      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const { retrySubtaskSession } = await import("./subtask-breakdown.js");
      await retrySubtaskSession(sessionId, scopedStore.getRootDir(), settings.promptOverrides);
      res.json({ success: true, sessionId });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "SessionNotFoundError") {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else if (err instanceof Error && err.name === "InvalidSessionStateError") {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err, "Failed to retry subtask session");
      }
    }
  });

  /**
   * POST /api/planning/start
   * Start a new planning session.
   * Body: { initialPlan: string }
   * Returns: { sessionId: string, firstQuestion: PlanningQuestion }
   *
   * UTILITY PATH: This route is independent of task-lane saturation.
   */
  router.post("/planning/start", async (req, res) => {
    try {
      const { initialPlan } = req.body;

      if (!initialPlan || typeof initialPlan !== "string") {
        throw badRequest("initialPlan is required and must be a string");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const rootDir = scopedStore.getRootDir();

      const { createSession, RateLimitError: _RateLimitError } = await import("./planning.js");
      const result = await createSession(
        ip,
        initialPlan,
        scopedStore,
        rootDir,
        settings.promptOverrides,
      );
      res.status(201).json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "RateLimitError") {
        throw rateLimited(err.message);
      } else {
        rethrowAsApiError(err, "Failed to start planning session");
      }
    }
  });

  /**
   * POST /api/planning/start-streaming
   * Start a new planning session with AI agent streaming.
   * Body: { initialPlan: string }
   * Returns: { sessionId: string }
   *
   * After receiving sessionId, connect to GET /api/planning/:sessionId/stream
   * for real-time thinking output and questions.
   *
   * UTILITY PATH: This route is independent of task-lane saturation.
   */
  router.post("/planning/start-streaming", async (req, res) => {
    try {
      const { initialPlan, planningModelProvider, planningModelId } = req.body;

      if (!initialPlan || typeof initialPlan !== "string") {
        throw badRequest("initialPlan is required and must be a string");
      }

      if (planningModelProvider !== undefined && typeof planningModelProvider !== "string") {
        throw badRequest("planningModelProvider must be a string when provided");
      }

      if (planningModelId !== undefined && typeof planningModelId !== "string") {
        throw badRequest("planningModelId must be a string when provided");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const rootDir = scopedStore.getRootDir();

      // Resolve planning model using canonical lane hierarchy:
      // 1. Request body planning override (planningModelProvider + planningModelId)
      // 2. Project planning override (settings.planningProvider + settings.planningModelId)
      // 3. Global planning lane (settings.planningGlobalProvider + settings.planningGlobalModelId)
      // 4. Default pair (settings.defaultProvider + settings.defaultModelId)
      const resolvedPlanningProvider =
        (planningModelProvider && planningModelId ? planningModelProvider : undefined) ||
        (settings.planningProvider && settings.planningModelId ? settings.planningProvider : undefined) ||
        (settings.planningGlobalProvider && settings.planningGlobalModelId ? settings.planningGlobalProvider : undefined) ||
        settings.defaultProvider;

      const resolvedPlanningModelId =
        (planningModelProvider && planningModelId ? planningModelId : undefined) ||
        (settings.planningProvider && settings.planningModelId ? settings.planningModelId : undefined) ||
        (settings.planningGlobalProvider && settings.planningGlobalModelId ? settings.planningGlobalModelId : undefined) ||
        settings.defaultModelId;

      const { createSessionWithAgent, RateLimitError: _RateLimitError2 } = await import("./planning.js");
      const sessionId = await createSessionWithAgent(
        ip,
        initialPlan,
        rootDir,
        resolvedPlanningProvider,
        resolvedPlanningModelId,
        settings.promptOverrides,
      );
      res.status(201).json({ sessionId });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "RateLimitError") {
        throw rateLimited(err.message);
      } else {
        rethrowAsApiError(err, "Failed to start planning session");
      }
    }
  });

  /**
   * POST /api/planning/respond
   * Submit a response to the current planning question.
   * Body: { sessionId: string, responses: Record<string, unknown> }
   * Returns: { type: "question" | "complete", data: PlanningQuestion | PlanningSummary }
   *
   * UTILITY PATH: This route is independent of task-lane saturation.
   * Session-lock 409 with { error, lockedByTab } is preserved (multi-tab coordination, not saturation).
   */
  router.post("/planning/respond", async (req, res) => {
    try {
      const { sessionId, responses, tabId } = req.body;

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      if (!responses || typeof responses !== "object") {
        throw badRequest("responses is required and must be an object");
      }

      const normalizedTabId = typeof tabId === "string" && tabId.trim().length > 0 ? tabId.trim() : undefined;
      const lockCheck = checkSessionLock(sessionId, normalizedTabId, aiSessionStore);
      if (!lockCheck.allowed) {
        res.status(409).json({
          error: "Session locked by another tab",
          lockedByTab: lockCheck.currentHolder,
        });
        return;
      }

      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const { submitResponse, SessionNotFoundError: _SessionNotFoundError, InvalidSessionStateError: _InvalidSessionStateError } = await import("./planning.js");
      const result = await submitResponse(
        sessionId,
        responses,
        scopedStore.getRootDir(),
        settings.promptOverrides,
      );
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "SessionNotFoundError") {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else if (err instanceof Error && err.name === "InvalidSessionStateError") {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err, "Failed to process response");
      }
    }
  });

  /**
   * POST /api/planning/:sessionId/retry
   * Retry a failed planning session.
   *
   * UTILITY PATH: This route is independent of task-lane saturation.
   * Session-lock 409 with { error, lockedByTab } is preserved.
   */
  router.post("/planning/:sessionId/retry", async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const tabId = typeof req.body?.tabId === "string" && req.body.tabId.trim().length > 0
        ? req.body.tabId.trim()
        : undefined;
      const lockCheck = checkSessionLock(sessionId, tabId, aiSessionStore);
      if (!lockCheck.allowed) {
        res.status(409).json({
          error: "Session locked by another tab",
          lockedByTab: lockCheck.currentHolder,
        });
        return;
      }

      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const { retrySession } = await import("./planning.js");
      await retrySession(sessionId, scopedStore.getRootDir(), settings.promptOverrides);
      res.json({ success: true, sessionId });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "SessionNotFoundError") {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else if (err instanceof Error && err.name === "InvalidSessionStateError") {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err, "Failed to retry planning session");
      }
    }
  });

  /**
   * POST /api/planning/cancel
   * Cancel and cleanup a planning session.
   * Body: { sessionId: string }
   */
  router.post("/planning/cancel", async (req, res) => {
    try {
      const { sessionId, tabId } = req.body;

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const normalizedTabId = typeof tabId === "string" && tabId.trim().length > 0 ? tabId.trim() : undefined;
      const lockCheck = checkSessionLock(sessionId, normalizedTabId, aiSessionStore);
      if (!lockCheck.allowed) {
        res.status(409).json({
          error: "Session locked by another tab",
          lockedByTab: lockCheck.currentHolder,
        });
        return;
      }

      const { cancelSession, SessionNotFoundError: _SessionNotFoundError2 } = await import("./planning.js");
      await cancelSession(sessionId);
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "SessionNotFoundError") {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err, "Failed to cancel session");
      }
    }
  });

  const parsePlanningSummaryOverride = (summaryInput: unknown): PlanningSummary | undefined => {
    if (summaryInput === undefined) {
      return undefined;
    }

    if (!summaryInput || typeof summaryInput !== "object" || Array.isArray(summaryInput)) {
      throw badRequest("summary must be an object");
    }

    const summary = summaryInput as Partial<PlanningSummary>;

    if (typeof summary.title !== "string" || summary.title.trim().length === 0) {
      throw badRequest("summary.title is required and must be a non-empty string");
    }

    if (typeof summary.description !== "string" || summary.description.trim().length === 0) {
      throw badRequest("summary.description is required and must be a non-empty string");
    }

    return {
      title: summary.title.trim(),
      description: summary.description.trim(),
      suggestedSize:
        summary.suggestedSize === "S" || summary.suggestedSize === "M" || summary.suggestedSize === "L"
          ? summary.suggestedSize
          : "M",
      suggestedDependencies: Array.isArray(summary.suggestedDependencies)
        ? summary.suggestedDependencies.filter((dep): dep is string => typeof dep === "string" && dep.trim().length > 0)
        : [],
      keyDeliverables: Array.isArray(summary.keyDeliverables)
        ? summary.keyDeliverables.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [],
    };
  };

  /**
   * POST /api/planning/create-task
   * Create a task from a completed planning session.
   * Body: { sessionId: string }
   * Returns: Created Task
   */
  router.post("/planning/create-task", async (req, res) => {
    try {
      const { sessionId, summary: summaryInput } = req.body as {
        sessionId?: unknown;
        summary?: unknown;
      };

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const summaryOverride = parsePlanningSummaryOverride(summaryInput);

      const { store: scopedStore } = await getProjectContext(req);
      const { getSession, getSummary, cleanupSession } = await import("./planning.js");

      const session = getSession(sessionId);
      let summary = summaryOverride ?? getSummary(sessionId);
      let initialPlan = session?.initialPlan;
      let usedPersistedFallback = false;

      if (!session) {
        if (!aiSessionStore) {
          throw notFound(`Planning session ${sessionId} not found or expired`);
        }

        const persistedSession = aiSessionStore.get(sessionId);
        if (!persistedSession || persistedSession.type !== "planning") {
          throw notFound(`Planning session ${sessionId} not found or expired`);
        }

        if (persistedSession.status !== "complete") {
          throw badRequest("Planning session is not complete");
        }

        if (!persistedSession.result) {
          throw badRequest("Planning session result is not available");
        }

        if (!summaryOverride) {
          try {
            const parsedSummary = JSON.parse(persistedSession.result) as {
              title?: unknown;
              description?: unknown;
              suggestedSize?: unknown;
              suggestedDependencies?: unknown;
              keyDeliverables?: unknown;
            };

            summary = {
              title:
                typeof parsedSummary.title === "string" && parsedSummary.title.trim().length > 0
                  ? parsedSummary.title
                  : persistedSession.title,
              description:
                typeof parsedSummary.description === "string" && parsedSummary.description.trim().length > 0
                  ? parsedSummary.description
                  : persistedSession.title,
              suggestedSize:
                parsedSummary.suggestedSize === "S" ||
                parsedSummary.suggestedSize === "M" ||
                parsedSummary.suggestedSize === "L"
                  ? parsedSummary.suggestedSize
                  : "M",
              suggestedDependencies: Array.isArray(parsedSummary.suggestedDependencies)
                ? parsedSummary.suggestedDependencies.filter((dep): dep is string => typeof dep === "string")
                : [],
              keyDeliverables: Array.isArray(parsedSummary.keyDeliverables)
                ? parsedSummary.keyDeliverables.filter((item): item is string => typeof item === "string")
                : [],
            };
          } catch {
            throw badRequest("Planning session result is invalid");
          }
        }

        try {
          const parsedInput = JSON.parse(persistedSession.inputPayload) as { initialPlan?: unknown };
          if (typeof parsedInput.initialPlan === "string" && parsedInput.initialPlan.trim().length > 0) {
            initialPlan = parsedInput.initialPlan;
          }
        } catch {
          // Keep fallback value below
        }

        if (!initialPlan) {
          initialPlan = persistedSession.title;
        }

        usedPersistedFallback = true;
      }

      if (!summary) {
        throw badRequest("Planning session is not complete");
      }

      // Create the task
      const task = await scopedStore.createTask({
        title: summary.title,
        description: summary.description,
        column: "triage",
        dependencies: summary.suggestedDependencies.length > 0 ? summary.suggestedDependencies : undefined,
      });

      // Update task with suggested size if provided
      if (summary.suggestedSize) {
        await scopedStore.updateTask(task.id, { size: summary.suggestedSize });
      }

      // Log the planning mode creation
      await scopedStore.logEntry(task.id, "Created via Planning Mode", `Initial plan: ${(initialPlan ?? "").slice(0, 200)}`);

      // Cleanup the session
      if (usedPersistedFallback) {
        aiSessionStore?.delete(sessionId);
      } else {
        cleanupSession(sessionId);
      }

      res.status(201).json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to create task");
    }
  });

  /**
   * POST /api/planning/start-breakdown
   * Start subtask breakdown from a completed planning session.
   * Body: { sessionId: string }
   * Returns: { sessionId: string } — ID of the generated subtask breakdown
   */
  router.post("/planning/start-breakdown", async (req, res) => {
    try {
      const { sessionId, summary: summaryInput } = req.body as {
        sessionId?: unknown;
        summary?: unknown;
      };

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const summaryOverride = parsePlanningSummaryOverride(summaryInput);

      const { getSession, generateSubtasksFromPlanning } = await import("./planning.js");

      const session = getSession(sessionId);
      if (!session) {
        throw notFound(`Planning session ${sessionId} not found or expired`);
      }

      if (summaryOverride) {
        session.summary = summaryOverride;
      }

      if (!session.summary) {
        throw badRequest("Planning session is not complete");
      }

      const subtasks = generateSubtasksFromPlanning(sessionId);
      if (subtasks.length === 0) {
        throw badRequest("Could not generate subtasks from planning session");
      }

      // Return a synthetic session ID (based on the planning session) and the generated subtasks
      // We use the planning session ID directly as the breakdown session ID
      res.json({ sessionId, subtasks });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to start planning breakdown");
    }
  });

  /**
   * POST /api/planning/create-tasks
   * Create multiple tasks from a completed planning session (after optional editing).
   * Body: { planningSessionId: string, subtasks: Array<{id, title, description, suggestedSize, dependsOn}> }
   * Returns: { tasks: Task[] }
   */
  router.post("/planning/create-tasks", async (req, res) => {
    try {
      const { planningSessionId, subtasks } = req.body as {
        planningSessionId?: string;
        subtasks?: Array<{
          id: string;
          title: string;
          description: string;
          suggestedSize: "S" | "M" | "L";
          dependsOn: string[];
        }>;
      };

      if (!planningSessionId || typeof planningSessionId !== "string") {
        throw badRequest("planningSessionId is required");
      }

      if (!Array.isArray(subtasks) || subtasks.length === 0) {
        throw badRequest("subtasks must be a non-empty array");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { getSession, cleanupSession, formatInterviewQA } = await import("./planning.js");

      const session = getSession(planningSessionId);
      if (!session) {
        throw notFound(`Planning session ${planningSessionId} not found or expired`);
      }

      if (!session.summary) {
        throw badRequest("Planning session is not complete");
      }

      const qaSection = formatInterviewQA(session.history);
      const logDetails = qaSection
        ? `Source: ${session.initialPlan.slice(0, 200)}\n\n${qaSection}`
        : `Source: ${session.initialPlan.slice(0, 200)}`;

      // Validate each subtask
      for (const item of subtasks) {
        if (!item || typeof item.id !== "string" || typeof item.title !== "string" || !item.title.trim()) {
          throw badRequest("Each subtask must include id and title");
        }
      }

      const createdTasks = [] as Awaited<ReturnType<typeof store.createTask>>[];
      const tempIdToTaskId = new Map<string, string>();

      // Create tasks
      for (const item of subtasks) {
        const task = await scopedStore.createTask({
          title: item.title.trim(),
          description: typeof item.description === "string" ? item.description.trim() : item.title.trim(),
          column: "triage",
          dependencies: undefined,
        });

        tempIdToTaskId.set(item.id, task.id);
        createdTasks.push(task);

        if (item.suggestedSize === "S" || item.suggestedSize === "M" || item.suggestedSize === "L") {
          await scopedStore.updateTask(task.id, { size: item.suggestedSize });
        }
      }

      // Resolve dependencies
      for (let index = 0; index < subtasks.length; index++) {
        const item = subtasks[index]!;
        const created = createdTasks[index]!;
        const resolvedDependencies = Array.isArray(item.dependsOn)
          ? item.dependsOn.map((dep) => tempIdToTaskId.get(dep)).filter((dep): dep is string => Boolean(dep))
          : [];

        if (resolvedDependencies.length > 0) {
          const updated = await scopedStore.updateTask(created.id, { dependencies: resolvedDependencies });
          createdTasks[index] = updated;
        }

        await scopedStore.logEntry(created.id, "Created via Planning Mode (multi-task)", logDetails);
      }

      // Cleanup the planning session
      cleanupSession(planningSessionId);

      res.status(201).json({ tasks: createdTasks });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to create tasks from planning");
    }
  });

  /**
   * GET /api/planning/:sessionId/stream
   * SSE endpoint for real-time planning session updates.
   * Streams thinking output, questions, summaries, and errors.
   * 
   * Event types:
   * - thinking: AI thinking output chunks
   * - question: New question to display
   * - summary: Planning summary when complete
   * - error: Error message
   * - complete: Stream completed
   */
  router.get("/planning/:sessionId/stream", async (req, res) => {
    const { sessionId } = req.params;

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Send initial connection confirmation
    res.write(": connected\n\n");

    try {
      const { planningStreamManager, getSession } = await import("./planning.js");

      // Verify session exists
      const session = getSession(sessionId);
      if (!session) {
        writeSSEEvent(res, "error", JSON.stringify({ message: "Session not found or expired" }));
        res.end();
        return;
      }

      const lastEventId = parseLastEventId(req);
      if (lastEventId !== undefined) {
        const buffered = planningStreamManager.getBufferedEvents(sessionId, lastEventId);
        if (!replayBufferedSSE(res, buffered)) {
          res.end();
          return;
        }
      }

      if (session.summary) {
        const existing = planningStreamManager.getBufferedEvents(sessionId, 0);
        const lastSummaryEvent = [...existing].reverse().find((event) => event.event === "summary");
        const summaryEventId = lastSummaryEvent?.id
          ?? planningStreamManager.broadcast(sessionId, {
            type: "summary",
            data: session.summary,
          });

        if (lastEventId === undefined || summaryEventId > lastEventId) {
          if (!writeSSEEvent(res, "summary", JSON.stringify(session.summary), summaryEventId)) {
            res.end();
            return;
          }
        }

        const lastCompleteEvent = [...existing].reverse().find((event) => event.event === "complete");
        const completeEventId = lastCompleteEvent?.id
          ?? planningStreamManager.broadcast(sessionId, { type: "complete" });

        if (lastEventId === undefined || completeEventId > lastEventId) {
          writeSSEEvent(res, "complete", JSON.stringify({}), completeEventId);
        }

        res.end();
        return;
      }

      // Catch-up for awaiting_input sessions: emit current question immediately
      // so late subscribers don't miss the transition and see the question without delay
      if (session.currentQuestion) {
        const existing = planningStreamManager.getBufferedEvents(sessionId, 0);
        const lastQuestionEvent = [...existing].reverse().find((event) => event.event === "question");
        const questionEventId = lastQuestionEvent?.id
          ?? planningStreamManager.broadcast(sessionId, {
            type: "question",
            data: session.currentQuestion,
          });

        if (lastEventId === undefined || questionEventId > lastEventId) {
          if (!writeSSEEvent(res, "question", JSON.stringify(session.currentQuestion), questionEventId)) {
            res.end();
            return;
          }
        }
        // Don't return — subscribe to continue receiving events (thinking, next question, etc.)
      }

      // Subscribe to session events
      const unsubscribe = planningStreamManager.subscribe(sessionId, (event, eventId) => {
        const data = (event as { data?: unknown }).data;
        if (!writeSSEEvent(res, event.type, JSON.stringify(data ?? {}), eventId)) {
          unsubscribe();
          return;
        }

        // End stream on complete or error
        if (event.type === "complete" || event.type === "error") {
          unsubscribe();
          res.end();
        }
      });

      // Handle client disconnect
      req.on("close", () => {
        unsubscribe();
      });

      // Send heartbeat every 30s to keep connection alive
      const heartbeat = setInterval(() => {
        if (res.writableEnded) {
          clearInterval(heartbeat);
          return;
        }
        res.write(": heartbeat\n\n");
      }, 30_000);

      req.on("close", () => {
        clearInterval(heartbeat);
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      writeSSEEvent(res, "error", JSON.stringify({ message: err instanceof Error ? err.message : String(err) || "Stream error" }));
      res.end();
    }
  });

  // ── Chat Routes ────────────────────────────────────────────────────────────

  /**
   * GET /api/chat/sessions
   * List chat sessions with optional filtering.
   * Query params: projectId?, status?, agentId?
   *
   * Response is enriched with lastMessagePreview and lastMessageAt for each session.
   */
  router.get("/chat/sessions", rateLimit(RATE_LIMITS.api), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) {
        throw internalError("Chat store not available");
      }

      const { projectId, status, agentId } = req.query as {
        projectId?: string;
        status?: string;
        agentId?: string;
      };

      const sessions = chatStore.listSessions({
        ...(projectId && { projectId }),
        ...(status && { status: status as "active" | "archived" }),
        ...(agentId && { agentId }),
      });

      // Enrich sessions with last message preview
      if (sessions.length > 0) {
        const sessionIds = sessions.map((s) => s.id);
        const lastMessages = chatStore.getLastMessageForSessions(sessionIds);

        for (const session of sessions) {
          const lastMessage = lastMessages.get(session.id);
          if (lastMessage) {
            // Truncate content to 100 chars for preview
            const content = lastMessage.content || "";
            const enriched: EnrichedChatSession = session;
            enriched.lastMessagePreview =
              content.length > 100 ? content.slice(0, 100) + "…" : content;
            enriched.lastMessageAt = lastMessage.createdAt;
          }
        }
      }

      res.json({ sessions });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to list chat sessions");
    }
  });

  /**
   * POST /api/chat/sessions
   * Create a new chat session.
   * Body: { agentId: string, title?: string, modelProvider?: string, modelId?: string }
   * If modelProvider and modelId are provided, those are used. Otherwise the model is
   * resolved from the agent's runtimeConfig.model setting.
   * The session is scoped to the project identified by projectId query param or header.
   */
  router.post("/chat/sessions", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) {
        throw internalError("Chat store not available");
      }

      // Get project context to scope the session and resolve agent from the correct store
      const { store: scopedStore, projectId } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const { agentId, title, modelProvider, modelId } = req.body as {
        agentId?: string;
        title?: string;
        modelProvider?: string;
        modelId?: string;
      };

      if (!agentId || typeof agentId !== "string" || !agentId.trim()) {
        throw badRequest("agentId is required");
      }

      // Validate that if one model field is provided, the other must also be provided
      const hasClientModelProvider = typeof modelProvider === "string" && modelProvider.trim() !== "";
      const hasClientModelId = typeof modelId === "string" && modelId.trim() !== "";
      if (hasClientModelProvider !== hasClientModelId) {
        throw badRequest("Both modelProvider and modelId must be provided together, or neither should be provided");
      }

      // Fetch the agent to resolve model configuration (only if client didn't provide model)
      let resolvedProvider: string | null = null;
      let resolvedModelId: string | null = null;

      if (hasClientModelProvider && hasClientModelId) {
        // Use client-provided model
        resolvedProvider = modelProvider!.trim();
        resolvedModelId = modelId!.trim();
      } else {
        // Resolve from agent's runtimeConfig.model
        const agent = await agentStore.getAgent(agentId);
        if (!agent) {
          throw notFound(`Agent ${agentId} not found`);
        }

        // Parse the agent's model config from runtimeConfig.model
        // Format: "provider/modelId" (e.g., "anthropic/claude-sonnet-4-5")
        const runtimeModel = typeof agent.runtimeConfig?.model === "string" ? agent.runtimeConfig.model : "";
        const slashIdx = runtimeModel.indexOf("/");
        resolvedProvider = slashIdx > 0 ? runtimeModel.slice(0, slashIdx) : null;
        resolvedModelId = slashIdx > 0 ? runtimeModel.slice(slashIdx + 1) : null;
      }

      // Create the chat session with projectId for multi-project scoping
      const session = chatStore.createSession({
        agentId: agentId.trim(),
        title: title?.trim() || null,
        projectId: projectId ?? null,
        modelProvider: resolvedProvider,
        modelId: resolvedModelId,
      });

      res.status(201).json({ session });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to create chat session");
    }
  });

  /**
   * GET /api/chat/sessions/:id
   * Get a single chat session.
   */
  router.get("/chat/sessions/:id", async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) {
        throw internalError("Chat store not available");
      }

      const sessionId = String(req.params.id);
      const session = chatStore.getSession(sessionId);
      if (!session) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      res.json({ session });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to get chat session");
    }
  });

  /**
   * PATCH /api/chat/sessions/:id
   * Update a chat session (title, status).
   * Body: { title?: string, status?: "active" | "archived" }
   */
  router.patch("/chat/sessions/:id", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) {
        throw internalError("Chat store not available");
      }

      const sessionId = String(req.params.id);
      const { title, status } = req.body as { title?: string; status?: string };

      // Validate status if provided
      if (status !== undefined && status !== "active" && status !== "archived") {
        throw badRequest("status must be 'active' or 'archived'");
      }

      const session = chatStore.updateSession(sessionId, {
        ...(title !== undefined && { title: title?.trim() || null }),
        ...(status !== undefined && { status }),
      });

      if (!session) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      res.json({ session });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to update chat session");
    }
  });

  /**
   * DELETE /api/chat/sessions/:id
   * Delete a chat session and all its messages.
   */
  router.delete("/chat/sessions/:id", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      const sessionId = String(req.params.id);
      if (!chatStore) {
        throw internalError("Chat store not available");
      }

      const deleted = chatStore.deleteSession(sessionId);
      if (!deleted) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to delete chat session");
    }
  });

  /**
   * GET /api/chat/sessions/:id/messages
   * Get messages for a chat session with pagination.
   * Query params: limit? (default 50, max 200), offset? (default 0), before? (ISO timestamp)
   */
  router.get("/chat/sessions/:id/messages", async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) {
        throw internalError("Chat store not available");
      }

      const sessionId = String(req.params.id);

      // Verify session exists
      const session = chatStore.getSession(sessionId);
      if (!session) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      const { limit: limitStr, offset: offsetStr, before } = req.query as {
        limit?: string;
        offset?: string;
        before?: string;
      };

      // Validate pagination params
      const limit = limitStr !== undefined ? parseInt(String(limitStr), 10) : 50;
      const offset = offsetStr !== undefined ? parseInt(String(offsetStr), 10) : 0;

      if (!Number.isFinite(limit) || limit < 1) {
        throw badRequest("limit must be a positive integer");
      }
      if (!Number.isFinite(offset) || offset < 0) {
        throw badRequest("offset must be a non-negative integer");
      }

      const effectiveLimit = Math.min(limit, 200);

      const messages = chatStore.getMessages(sessionId, {
        limit: effectiveLimit,
        offset,
        ...(before && { before }),
      });

      res.json({ messages });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to get chat messages");
    }
  });

  /**
   * POST /api/chat/sessions/:id/messages
   * Send a message and stream AI response via SSE.
   * Body: { content: string, modelProvider?: string, modelId?: string }
   *
   * Event types:
   * - thinking: AI thinking output chunks
   * - text: AI response text chunks
   * - done: Message sent successfully with messageId
   * - error: Error message
   */
  router.post("/chat/sessions/:id/messages", rateLimit(RATE_LIMITS.sse), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      const chatManager = options?.chatManager;
      if (!chatStore || !chatManager) {
        throw internalError("Chat store or manager not available");
      }

      const { content, modelProvider, modelId } = req.body as {
        content?: string;
        modelProvider?: string;
        modelId?: string;
      };
      const sessionId = String(req.params.id);

      if (!content || typeof content !== "string" || !content.trim()) {
        throw badRequest("content is required and must be a non-empty string");
      }

      // Verify session exists
      const session = chatStore.getSession(sessionId);
      if (!session) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      // Set SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      // Send initial connection confirmation
      res.write(": connected\n\n");

      // Import chat modules
      const { chatStreamManager, checkRateLimit: checkChatRateLimit, getRateLimitResetTime: getChatRateLimitResetTime } = await import("./chat.js");

      // Check rate limit
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      if (!checkChatRateLimit(ip)) {
        const resetTime = getChatRateLimitResetTime(ip);
        writeSSEEvent(res, "error", JSON.stringify({
          message: `Rate limit exceeded. Reset at ${resetTime?.toISOString() || "unknown"}`,
        }));
        res.end();
        return;
      }

      // Replay buffered events if client sent Last-Event-ID
      const lastEventId = parseLastEventId(req);
      if (lastEventId !== undefined) {
        const buffered = chatStreamManager.getBufferedEvents(sessionId, lastEventId);
        for (const bufferedEvent of buffered) {
          if (!writeSSEEvent(res, bufferedEvent.event, bufferedEvent.data, bufferedEvent.id)) {
            res.end();
            return;
          }
        }
      }

      // Subscribe to session events
      const unsubscribe = chatStreamManager.subscribe(sessionId, (event, eventId) => {
        const data = (event as { data?: unknown }).data;
        if (!writeSSEEvent(res, event.type, JSON.stringify(data ?? {}), eventId)) {
          unsubscribe();
          return;
        }

        // End stream on done or error
        if (event.type === "done" || event.type === "error") {
          unsubscribe();
          res.end();
        }
      });

      // Handle client disconnect
      req.on("close", () => {
        unsubscribe();
      });

      // Send heartbeat every 30s to keep connection alive
      const heartbeat = setInterval(() => {
        if (res.writableEnded) {
          clearInterval(heartbeat);
          return;
        }
        res.write(": heartbeat\n\n");
      }, 30_000);

      req.on("close", () => {
        clearInterval(heartbeat);
      });

      // Send message in background (non-blocking)
      // Validate optional model pair consistency
      const normalizedProvider = validateOptionalModelField(modelProvider, "modelProvider");
      const normalizedModelId = validateOptionalModelField(modelId, "modelId");
      if ((normalizedProvider && !normalizedModelId) || (!normalizedProvider && normalizedModelId)) {
        chatStreamManager.broadcast(sessionId, {
          type: "error",
          data: "modelProvider and modelId must both be provided or neither",
        });
        unsubscribe();
        res.end();
        return;
      }

      // Fire and forget - streaming happens via callbacks
      chatManager.sendMessage(
        sessionId,
        content.trim(),
        normalizedProvider,
        normalizedModelId,
      ).catch((err: Error) => {
        chatLogger.error("Error in sendMessage", {
          error: err.message,
        });
        chatStreamManager.broadcast(sessionId, {
          type: "error",
          data: err.message || "Failed to process message",
        });
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to send chat message");
    }
  });

  /**
   * POST /api/chat/sessions/:id/cancel
   * Cancel an in-flight chat generation.
   */
  router.post("/chat/sessions/:id/cancel", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const chatManager = options?.chatManager;
      if (!chatManager) {
        throw new ApiError(503, "Chat manager not available");
      }

      const sessionId = String(req.params.id);
      const success = chatManager.cancelGeneration(sessionId);
      res.json({ success });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to cancel chat generation");
    }
  });

  /**
   * DELETE /api/chat/sessions/:id/messages/:messageId
   * Delete a specific message from a chat session.
   */
  router.delete("/chat/sessions/:id/messages/:messageId", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) {
        throw internalError("Chat store not available");
      }

      const sessionId = String(req.params.id);
      const messageId = String(req.params.messageId);

      // Verify session exists
      const session = chatStore.getSession(sessionId);
      if (!session) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      // Check if message exists
      const message = chatStore.getMessage(messageId);
      if (!message) {
        throw notFound(`Message ${messageId} not found`);
      }

      // Delete the message
      const deleted = chatStore.deleteMessage(messageId);
      if (!deleted) {
        throw notFound(`Message ${messageId} not found`);
      }
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to delete chat message");
    }
  });

  if (process.env.FUSION_DEBUG_CHAT_ROUTES === "1") {
    const chatRoutes = [
      "GET /chat/sessions",
      "POST /chat/sessions",
      "GET /chat/sessions/:id",
      "PATCH /chat/sessions/:id",
      "DELETE /chat/sessions/:id",
      "GET /chat/sessions/:id/messages",
      "POST /chat/sessions/:id/messages",
      "POST /chat/sessions/:id/cancel",
      "DELETE /chat/sessions/:id/messages/:messageId",
    ];
    chatLogger.info("routes registered", { chatRoutes });
  }

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

      // Debug logging
      if (process.env.FUSION_DEBUG_AI) {
        runtimeLogger.child("ai-summarize").info(
          `Request from ${ip}, description length: ${description?.length || 0}`,
        );
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
        runtimeLogger.child("ai-summarize").info(
          `Resolved model: ${resolvedProvider || "auto"}/${resolvedModelId || "auto"}`,
        );
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
        runtimeLogger.child("ai-summarize").error("Unexpected error", {
          error: err instanceof Error ? err.message : String(err),
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

  // ── Scripts Routes ──────────────────────────────────────────────────────────

  /**
   * POST /api/scripts/:name/run
   * Execute a saved script by name using terminal service.
   * Body: { args?: string[] } - Optional arguments to append to the command
   * Returns: { sessionId: string, command: string }
   */
  router.post("/scripts/:name/run", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const scriptName = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;

      if (!scriptName) {
        throw badRequest("Script name is required");
      }

      if (!/^[a-zA-Z0-9_-]+$/.test(scriptName)) {
        throw badRequest("Script name must contain only alphanumeric characters, hyphens, and underscores (no spaces)");
      }

      // Get the script from settings
      const settings = await scopedStore.getSettings();
      const currentScripts = settings.scripts ?? {};

      if (currentScripts[scriptName] === undefined) {
        throw notFound(`Script '${scriptName}' not found`);
      }

      const baseCommand = currentScripts[scriptName];
      const { args } = req.body ?? {};

      // Validate args if provided
      if (args !== undefined && !Array.isArray(args)) {
        throw badRequest("args must be an array of strings");
      }
      if (args && !args.every((a: unknown) => typeof a === "string")) {
        throw badRequest("args must be an array of strings");
      }

      // Build the full command with args
      let fullCommand = baseCommand;
      if (args && args.length > 0) {
        // Properly escape arguments for shell execution
        const escapedArgs = args.map((arg: unknown) => {
          // Quote and escape the argument for shell
          const str = String(arg);
          // If the arg contains special characters, use double quotes with escaping
          if (str.includes('"') || str.includes("$") || str.includes("`")) {
            // Use single quotes and escape embedded single quotes
            return `'${str.replace(/'/g, "'\\''")}'`;
          }
          // Simple case: use double quotes
          return `"${str}"`;
        });
        fullCommand = `${baseCommand} ${escapedArgs.join(" ")}`;
      }

      // Execute via terminal service
      const terminalService = getTerminalService(scopedStore.getRootDir());
      const result = await terminalService.createSession({
        cwd: scopedStore.getRootDir(),
      });

      if (!result.success) {
        const statusByCode = {
          max_sessions: 503,
          invalid_shell: 400,
          pty_load_failed: 503,
          pty_spawn_failed: 500,
        } as const;
        const status = result.code ? (statusByCode[result.code] ?? 500) : 500;
        throw new ApiError(status, result.error || "Failed to create terminal session");
      }

      const sessionId = result.session.id;

      // Write the command to the PTY (use writeInput for compatibility with test mocks)
      terminalService.writeInput(sessionId, `${fullCommand}\n`);

      res.status(201).json({
        sessionId,
        command: fullCommand,
      });
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

  /**
   * GET /api/agents
   * List all agents with optional filtering.
   * Query params: state, role, includeEphemeral
   */
  router.get("/agents", async (req, res) => {
    try {
      const filter: { state?: string; role?: string; includeEphemeral?: boolean } = {};
      if (req.query.state && typeof req.query.state === "string") {
        filter.state = req.query.state;
      }
      if (req.query.role && typeof req.query.role === "string") {
        filter.role = req.query.role;
      }
      if (req.query.includeEphemeral === "true") {
        filter.includeEphemeral = true;
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agents = await agentStore.listAgents(filter as { state?: "idle" | "active" | "paused" | "terminated"; role?: import("@fusion/core").AgentCapability; includeEphemeral?: boolean });
      const sanitizedAgents = await sanitizeAgentTaskLinks(agents, scopedStore);
      res.json(sanitizedAgents);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  function validateAgentInstructionsPayload(
    res: Response,
    instructionsPath: unknown,
    instructionsText: unknown,
  ): boolean {
    if (instructionsPath !== undefined && instructionsPath !== null && instructionsPath !== "") {
      if (typeof instructionsPath !== "string") {
        throw badRequest("instructionsPath must be a string");
        return false;
      }
      if (instructionsPath.length > 500) {
        throw badRequest("instructionsPath must be at most 500 characters");
        return false;
      }
      if (instructionsPath.includes("..")) {
        throw badRequest("instructionsPath must not contain parent directory traversal (..)");
        return false;
      }
      const isAbsoluteUnix = instructionsPath.startsWith("/");
      const isAbsoluteWindows = /^[A-Za-z]:[\\/]/.test(instructionsPath);
      if (isAbsoluteUnix || isAbsoluteWindows) {
        throw badRequest("instructionsPath must be a project-relative path");
        return false;
      }
      if (!instructionsPath.endsWith(".md")) {
        throw badRequest("instructionsPath must end in .md");
        return false;
      }
    }

    if (instructionsText !== undefined && instructionsText !== null && instructionsText !== "") {
      if (typeof instructionsText !== "string") {
        throw badRequest("instructionsText must be a string");
        return false;
      }
      if (instructionsText.length > 50000) {
        throw badRequest("instructionsText must be at most 50,000 characters");
        return false;
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

  /**
   * POST /api/agents
   * Create a new agent.
   */
  router.post("/agents", async (req, res) => {
    try {
      const {
        name,
        role,
        metadata,
        title,
        icon,
        reportsTo,
        runtimeConfig,
        permissions,
        instructionsPath,
        instructionsText,
        soul,
        memory,
        bundleConfig,
      } = req.body ?? {};

      if (!name || typeof name !== "string") {
        throw badRequest("name is required");
      }
      if (!role || typeof role !== "string") {
        throw badRequest("role is required");
      }
      if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))) {
        throw badRequest("metadata must be an object");
      }
      if (title !== undefined && title !== null && typeof title !== "string") {
        throw badRequest("title must be a string");
      }
      if (icon !== undefined && icon !== null && typeof icon !== "string") {
        throw badRequest("icon must be a string");
      }
      if (reportsTo !== undefined && reportsTo !== null && typeof reportsTo !== "string") {
        throw badRequest("reportsTo must be a string");
      }
      if (runtimeConfig !== undefined && (typeof runtimeConfig !== "object" || runtimeConfig === null || Array.isArray(runtimeConfig))) {
        throw badRequest("runtimeConfig must be an object");
      }
      if (permissions !== undefined && (typeof permissions !== "object" || permissions === null || Array.isArray(permissions))) {
        throw badRequest("permissions must be an object");
      }
      if (!validateAgentInstructionsPayload(res, instructionsPath, instructionsText)) {
        return;
      }
      if (soul !== undefined && soul !== null && typeof soul !== "string") {
        throw badRequest("soul must be a string");
      }
      if (typeof soul === "string" && soul.length > 10000) {
        throw badRequest("soul must be at most 10,000 characters");
      }
      if (memory !== undefined && memory !== null && typeof memory !== "string") {
        throw badRequest("memory must be a string");
      }
      if (typeof memory === "string" && memory.length > 50000) {
        throw badRequest("memory must be at most 50,000 characters");
      }
      if (bundleConfig !== undefined && bundleConfig !== null) {
        if (typeof bundleConfig !== "object" || Array.isArray(bundleConfig)) {
          throw badRequest("bundleConfig must be an object");
        }
        if (typeof bundleConfig.mode !== "string" || !["managed", "external"].includes(bundleConfig.mode)) {
          throw badRequest("bundleConfig.mode must be 'managed' or 'external'");
        }
        if (typeof bundleConfig.entryFile !== "string") {
          throw badRequest("bundleConfig.entryFile must be a string");
        }
        if (!Array.isArray(bundleConfig.files)) {
          throw badRequest("bundleConfig.files must be an array");
        }
        if (bundleConfig.externalPath !== undefined && typeof bundleConfig.externalPath !== "string") {
          throw badRequest("bundleConfig.externalPath must be a string");
        }
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.createAgent({
        name,
        role: role as import("@fusion/core").AgentCapability,
        metadata,
        title: title ?? undefined,
        icon: icon ?? undefined,
        reportsTo: reportsTo ?? undefined,
        runtimeConfig,
        permissions,
        instructionsPath: instructionsPath ?? undefined,
        instructionsText: instructionsText ?? undefined,
        soul: soul ?? undefined,
        memory: memory ?? undefined,
        bundleConfig: bundleConfig ?? undefined,
      });
      res.status(201).json(agent);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("required") || (err instanceof Error ? err.message : String(err)).includes("cannot be empty")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/agents/export
   * Export agents to an Agent Companies package directory.
   *
   * Body:
   *  - { agentIds?: string[]; companyName?: string; companySlug?: string; outputDir?: string }
   */
  router.post("/agents/export", async (req, res) => {
    try {
      const { agentIds, companyName, companySlug, outputDir } = req.body ?? {};

      if (agentIds !== undefined) {
        if (!Array.isArray(agentIds)) {
          throw badRequest("agentIds must be an array of strings");
        }
        if (agentIds.some((id: unknown) => typeof id !== "string" || id.trim().length === 0)) {
          throw badRequest("agentIds must contain non-empty strings");
        }
      }

      if (companyName !== undefined && typeof companyName !== "string") {
        throw badRequest("companyName must be a string");
      }
      if (companySlug !== undefined && typeof companySlug !== "string") {
        throw badRequest("companySlug must be a string");
      }
      if (outputDir !== undefined && typeof outputDir !== "string") {
        throw badRequest("outputDir must be a string");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore, exportAgentsToDirectory } = await import("@fusion/core");

      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const allAgents = await agentStore.listAgents();
      const requestedIds = Array.isArray(agentIds) ? [...new Set(agentIds.map((id) => id.trim()))] : [];
      const agentsToExport = requestedIds.length > 0
        ? allAgents.filter((agent) => requestedIds.includes(agent.id))
        : allAgents;

      if (agentsToExport.length === 0) {
        throw badRequest("No agents found to export");
      }

      let resolvedOutputDir: string;
      if (typeof outputDir === "string" && outputDir.trim().length > 0) {
        resolvedOutputDir = resolve(outputDir.trim());
      } else if (typeof outputDir === "string") {
        throw badRequest("outputDir cannot be empty");
      } else {
        resolvedOutputDir = await mkdtemp(join(tmpdir(), "fusion-agent-export-"));
      }

      const result = await exportAgentsToDirectory(agentsToExport, resolvedOutputDir, {
        companyName: typeof companyName === "string" ? companyName : undefined,
        companySlug: typeof companySlug === "string" ? companySlug : undefined,
      });

      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * Companies.sh company entry from the catalog API.
   */
  interface CompaniesShCompany {
    slug: string;
    name: string;
    tagline?: string;
    repo?: string;
    website?: string;
    installs?: number;
  }

  /**
   * Validate a company slug from companies.sh.
   * Slugs must be lowercase alphanumeric with hyphens, 1-50 chars.
   */
  function isValidCompanySlug(slug: unknown): slug is string {
    if (typeof slug !== "string") return false;
    return /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(slug) || /^[a-z0-9]$/.test(slug);
  }

  /**
   * GET /api/agents/companies
   * Browse companies from companies.sh catalog.
   * Returns normalized company entries for UI display.
   */
  router.get("/agents/companies", async (_req, res) => {
    try {
      const COMPANIES_SH_API = "https://companies.sh/api/companies";

      let companies: CompaniesShCompany[] = [];

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(COMPANIES_SH_API, {
          signal: controller.signal,
          headers: {
            "Accept": "application/json",
            "User-Agent": "fn-dashboard/1.0",
          },
        });

        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`companies.sh API returned ${response.status}: ${response.statusText}`);
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          throw new Error(`companies.sh API returned non-JSON content: ${contentType}`);
        }

        const data = await response.json() as unknown;

        // Handle array response directly
        if (Array.isArray(data)) {
          companies = data.map((item): CompaniesShCompany | null => {
            if (typeof item !== "object" || item === null) return null;
            const entry = item as Record<string, unknown>;
            const slug = typeof entry.slug === "string" ? entry.slug : undefined;
            const name = typeof entry.name === "string" ? entry.name : undefined;

            // Skip entries without required fields or with invalid slugs
            if (!slug || !name || !isValidCompanySlug(slug)) return null;

            return {
              slug,
              name,
              tagline: typeof entry.tagline === "string" ? entry.tagline : undefined,
              repo: typeof entry.repo === "string" ? entry.repo : undefined,
              website: typeof entry.website === "string" ? entry.website : undefined,
              installs: typeof entry.installs === "number" ? entry.installs
                : typeof entry.installs === "string" ? parseInt(entry.installs, 10) || undefined
                : undefined,
            };
          }).filter((c): c is CompaniesShCompany => c !== null);
        } else if (typeof data === "object" && data !== null) {
          // Handle wrapped response: { items: [...] }, { companies: [...] }, or { data: [...] }
          const obj = data as Record<string, unknown>;
          const arr = Array.isArray(obj.items) ? obj.items
            : Array.isArray(obj.companies) ? obj.companies
            : Array.isArray(obj.data) ? obj.data
            : [];

          companies = (arr as unknown[]).map((item): CompaniesShCompany | null => {
            if (typeof item !== "object" || item === null) return null;
            const entry = item as Record<string, unknown>;
            const slug = typeof entry.slug === "string" ? entry.slug : undefined;
            const name = typeof entry.name === "string" ? entry.name : undefined;

            if (!slug || !name || !isValidCompanySlug(slug)) return null;

            return {
              slug,
              name,
              tagline: typeof entry.tagline === "string" ? entry.tagline : undefined,
              repo: typeof entry.repo === "string" ? entry.repo : undefined,
              website: typeof entry.website === "string" ? entry.website : undefined,
              installs: typeof entry.installs === "number" ? entry.installs
                : typeof entry.installs === "string" ? parseInt(entry.installs, 10) || undefined
                : undefined,
            };
          }).filter((c): c is CompaniesShCompany => c !== null);
        }
      } catch (fetchErr) {
        // Return empty array + error message on network/parsing errors
        const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        if (message.includes("aborted")) {
          throw new Error("companies.sh request timed out");
        }
        // Log and include error in response so frontend can display it
        runtimeLogger.child("agents/companies").warn(`Failed to fetch catalog: ${message}`);
        res.json({ companies, error: `Failed to fetch companies.sh catalog: ${message}` });
        return;
      }

      res.json({ companies });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Agent Import Skill Persistence Helpers ─────────────────────────────────

/**
 * Slugify a string for safe use in filesystem paths.
 * Removes dangerous characters, normalizes whitespace/unicode, limits to alphanumeric + hyphens.
 */
function slugifyPathSegment(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.length > 0 ? normalized : fallback;
}

/**
 * Generate YAML frontmatter + markdown body string.
 */
function toSkillMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${String(item)}`);
      }
    } else if (typeof value === "object") {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }

  return `---\n${lines.join("\n")}\n---\n${body}`;
}

interface SkillImportResult {
  imported: Array<{ name: string; path: string }>;
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
}

interface SkillManifestForImport {
  name?: unknown;
  description?: unknown;
  slug?: unknown;
  schema?: unknown;
  kind?: unknown;
  version?: unknown;
  license?: unknown;
  authors?: unknown;
  tags?: unknown;
  instructionBody?: unknown;
}

/**
 * Persist skill manifests from an Agent Companies package to the project skills directory.
 * Skills are written to: {projectRoot}/skills/imported/{companySlug}/{skillSlug}/SKILL.md
 *
 * Collision handling: if a SKILL.md already exists, the skill is skipped (not overwritten).
 * Path safety: all segments are slugified to prevent directory traversal attacks.
 */
async function persistImportedSkills(
  projectRoot: string,
  skills: SkillManifestForImport[],
  companySlug: string | undefined,
): Promise<SkillImportResult> {
  const result: SkillImportResult = {
    imported: [],
    skipped: [],
    errors: [],
  };

  if (!skills || skills.length === 0) {
    return result;
  }

  // Slugify company slug for directory safety
  const safeCompanySlug = companySlug
    ? slugifyPathSegment(companySlug, "unknown-company")
    : "unknown-company";

  const skillsBaseDir = join(projectRoot, "skills", "imported", safeCompanySlug);

  const usedSlugs = new Set<string>();

  for (const skill of skills) {
    const name = typeof skill.name === "string" && skill.name.trim().length > 0
      ? skill.name.trim()
      : null;

    if (!name) {
      result.errors.push({ name: String(skill.name ?? "?"), error: "Skill missing valid name" });
      continue;
    }

    // Generate unique slug
    let skillSlug = slugifyPathSegment(name, "unnamed-skill");
    if (usedSlugs.has(skillSlug)) {
      let counter = 2;
      while (usedSlugs.has(`${skillSlug}-${counter}`)) {
        counter++;
      }
      skillSlug = `${skillSlug}-${counter}`;
    }
    usedSlugs.add(skillSlug);

    const skillDir = join(skillsBaseDir, skillSlug);
    const skillPath = join(skillDir, "SKILL.md");

    // Check for collision
    try {
      await access(skillPath);
      // File exists, skip
      result.skipped.push(name);
      continue;
    } catch {
      // File doesn't exist, proceed
    }

    // Build frontmatter
    const frontmatter: Record<string, unknown> = {
      name,
      schema: "agentcompanies/v1",
      kind: "skill",
    };

    if (typeof skill.description === "string" && skill.description.trim()) {
      frontmatter.description = skill.description.trim();
    }
    if (typeof skill.slug === "string" && skill.slug.trim()) {
      frontmatter.slug = skill.slug.trim();
    }
    if (typeof skill.version === "string" && skill.version.trim()) {
      frontmatter.version = skill.version.trim();
    }
    if (typeof skill.license === "string" && skill.license.trim()) {
      frontmatter.license = skill.license.trim();
    }
    if (Array.isArray(skill.authors)) {
      const validAuthors = skill.authors.filter((a): a is string => typeof a === "string");
      if (validAuthors.length > 0) frontmatter.authors = validAuthors;
    }
    if (Array.isArray(skill.tags)) {
      const validTags = skill.tags.filter((t): t is string => typeof t === "string");
      if (validTags.length > 0) frontmatter.tags = validTags;
    }

    // Build body from instructionBody
    const body = typeof skill.instructionBody === "string"
      ? skill.instructionBody
      : `# ${name}\n\n<!-- Add skill instructions here. -->`;

    try {
      await mkdir(skillDir, { recursive: true });
      const content = toSkillMarkdown(frontmatter, body);
      await fsWriteFile(skillPath, content, "utf-8");
      result.imported.push({ name, path: `skills/imported/${safeCompanySlug}/${skillSlug}/SKILL.md` });
    } catch (err) {
      result.errors.push({ name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

  /**
   * POST /api/agents/import
   * Import agents from Agent Companies sources.
   *
   * Body modes (checked in order):
   *  - { importSource: "companies.sh", companySlug: string, skipExisting?, dryRun? }
   *  - { agents: AgentManifest[], skipExisting?, dryRun? }
   *  - { source: string, skipExisting?, dryRun? }   // server directory path
   *  - { manifest: string, skipExisting?, dryRun? } // raw AGENTS.md content
   */
  router.post("/agents/import", async (req, res) => {
    try {
      const {
        agents,
        source,
        manifest,
        importSource,
        companySlug: importCompanySlug,
        selectedAgents,
        selectedSkills,
        skipExisting,
        dryRun,
      } = req.body ?? {};
      const {
        AgentStore,
        parseCompanyDirectory,
        parseCompanyArchive,
        parseSingleAgentManifest,
        prepareAgentCompaniesImport,
        AgentCompaniesParseError: _AgentCompaniesParseError,
      } = await import("@fusion/core");

      const { store: scopedStore } = await getProjectContext(req);
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const existingAgents = await agentStore.listAgents();
      const existingNames = new Set(existingAgents.map((a) => a.name));
      const conversionOptions = {
        ...(skipExisting ? { skipExisting: [...existingNames] } : {}),
        existingAgents,
      };

      let pkg: {
        company?: { name?: string; slug?: string };
        agents: unknown[];
        teams: unknown[];
        projects: unknown[];
        tasks: unknown[];
        skills?: unknown[];
      };

      if (Array.isArray(agents)) {
        pkg = {
          company: undefined,
          agents,
          teams: [],
          projects: [],
          tasks: [],
        };
      } else if (typeof source === "string" && source.trim()) {
        const sourcePath = resolve(source);

        const isArchive = sourcePath.endsWith(".tar.gz")
          || sourcePath.endsWith(".tgz")
          || sourcePath.endsWith(".zip");

        if (isArchive) {
          try {
            await stat(sourcePath);
          } catch {
            throw badRequest(`source does not exist: ${sourcePath}`);
          }
          pkg = await parseCompanyArchive(sourcePath);
        } else {
          let sourceStat: import("node:fs").Stats;
          try {
            sourceStat = await stat(sourcePath);
          } catch {
            throw badRequest(`source does not exist: ${sourcePath}`);
          }
          if (sourceStat.isDirectory()) {
            pkg = parseCompanyDirectory(sourcePath);
          } else {
            throw badRequest("Source must be a server-side directory or archive path");
          }
        }
      } else if (typeof manifest === "string") {
        const { manifest: singleAgent } = parseSingleAgentManifest(manifest);
        pkg = {
          company: undefined,
          agents: [singleAgent],
          teams: [],
          projects: [],
          tasks: [],
        };
      } else if (importSource === "companies.sh" && typeof importCompanySlug === "string") {
        // Import from companies.sh catalog
        if (!isValidCompanySlug(importCompanySlug)) {
          throw badRequest(`Invalid companies.sh slug: "${importCompanySlug}". Slugs must be lowercase alphanumeric with hyphens.`);
        }

        // Fetch company info from companies.sh catalog API
        // Note: The per-company endpoint (/api/companies/:slug) returns HTML (SPA),
        // so we fetch the full list and filter by slug.
        const companyApiUrl = "https://companies.sh/api/companies";
        let companyInfo: { name: string; repo?: string; tagline?: string } | null = null;

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);

          const response = await fetch(companyApiUrl, {
            signal: controller.signal,
            headers: {
              "Accept": "application/json",
              "User-Agent": "fn-dashboard/1.0",
            },
          });

          clearTimeout(timeout);

          if (!response.ok) {
            throw new Error(`companies.sh API returned ${response.status}`);
          }

          const contentType = response.headers.get("content-type") ?? "";
          if (!contentType.includes("application/json")) {
            throw new Error("companies.sh API returned non-JSON content");
          }

          const data = await response.json() as Record<string, unknown>;

          // The API returns { items: [...] } — find the matching company by slug
          const items = Array.isArray(data.items)
            ? data.items as Record<string, unknown>[]
            : Array.isArray(data)
              ? data as Record<string, unknown>[]
              : [];

          const match = items.find((item) => item.slug === importCompanySlug);
          if (!match) {
            throw badRequest(`Company not found: "${importCompanySlug}"`);
          }

          const name = typeof match.name === "string" ? match.name : importCompanySlug;
          const repo = typeof match.repo === "string" ? match.repo : undefined;
          const tagline = typeof match.tagline === "string" ? match.tagline : undefined;

          companyInfo = { name, repo, tagline };
        } catch (fetchErr) {
          const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          if (fetchErr instanceof ApiError) throw fetchErr;
          if (message.includes("aborted")) {
            throw new Error("companies.sh request timed out");
          }
          throw badRequest(`Failed to fetch company "${importCompanySlug}": ${message}`);
        }

        // Determine download URL from repo
        if (!companyInfo?.repo) {
          throw badRequest(`Company "${importCompanySlug}" has no repository URL`);
        }

        // Parse the repo URL to determine the archive URL
        // Accept HTTPS GitHub URLs: https://github.com/owner/repo or shorthand: owner/repo
        const repoMatch = companyInfo.repo.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i)
          ?? companyInfo.repo.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
        if (!repoMatch) {
          throw badRequest(`Unsupported repository URL format: ${companyInfo.repo}. Only GitHub HTTPS URLs and owner/repo shorthand are supported.`);
        }

        const [, repoOwner, repoName] = repoMatch;
        // Use GitHub's archive API to get the default branch archive
        const archiveUrl = `https://github.com/${repoOwner}/${repoName}/archive/refs/heads/main.tar.gz`;

        // Download and extract to temp directory
        let tempDir: string | null = null;
        try {
          tempDir = await mkdtemp(join(tmpdir(), `fn-agent-import-${importCompanySlug}-`));

          // Download the archive
          const archivePath = join(tempDir, "archive.tar.gz");

          // Download with 30-second timeout
          const downloadController = new AbortController();
          const downloadTimeout = setTimeout(() => downloadController.abort(), 30000);

          let archiveResponse: globalThis.Response;
          try {
            archiveResponse = await fetch(archiveUrl, { signal: downloadController.signal });
          } finally {
            clearTimeout(downloadTimeout);
          }

          let downloadResponse: globalThis.Response;
          if (archiveResponse.ok) {
            downloadResponse = archiveResponse;
          } else {
            // Try fallback branch (master) with its own timeout
            const fallbackController = new AbortController();
            const fallbackTimeout = setTimeout(() => fallbackController.abort(), 30000);

            try {
              downloadResponse = await fetch(
                `https://github.com/${repoOwner}/${repoName}/archive/refs/heads/master.tar.gz`,
                { signal: fallbackController.signal },
              );
            } finally {
              clearTimeout(fallbackTimeout);
            }
          }

          if (!downloadResponse.ok) {
            throw badRequest(`Failed to download repository archive: ${downloadResponse.status} ${downloadResponse.statusText}`);
          }
          if (!downloadResponse.body) {
            throw new Error("No response body");
          }

          await streamPipeline(
            Readable.fromWeb(downloadResponse.body as import("node:stream/web").ReadableStream),
            createWriteStream(archivePath),
          );

          // Parse the downloaded archive directly to avoid requiring shell tar tools.
          pkg = await parseCompanyArchive(archivePath);

          // Override company info if available from API
          if (companyInfo) {
            pkg.company = {
              name: companyInfo.name,
              slug: importCompanySlug,
            };
          }
        } finally {
          // Clean up temp directory
          if (tempDir) {
            try {
              await rm(tempDir, { recursive: true, force: true });
            } catch {
              // Best-effort cleanup
            }
          }
        }
      } else {
        throw badRequest("Provide one of: agents (array), source (path), manifest (string), or importSource + companySlug");
      }

      const normalizeSelectionNames = (value: unknown): string[] | undefined => {
        if (!Array.isArray(value)) return undefined;
        const normalized = value
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        return normalized.length > 0 ? normalized : undefined;
      };

      const selectedAgentNameList = normalizeSelectionNames(selectedAgents);
      const selectedSkillNameList = normalizeSelectionNames(selectedSkills);

      if (selectedAgentNameList) {
        const selectedAgentSet = new Set(selectedAgentNameList);
        pkg.agents = pkg.agents.filter((agent) => (
          typeof agent === "object"
          && agent !== null
          && typeof (agent as { name?: unknown }).name === "string"
          && selectedAgentSet.has((agent as { name: string }).name)
        ));
      }

      if (selectedSkillNameList) {
        const selectedSkillSet = new Set(selectedSkillNameList);
        pkg.skills = (pkg.skills ?? []).filter((skill) => (
          typeof skill === "object"
          && skill !== null
          && typeof (skill as { name?: unknown }).name === "string"
          && selectedSkillSet.has((skill as { name: string }).name)
        ));
      }

      const { items: importItems, result } = prepareAgentCompaniesImport(pkg as import("@fusion/core").AgentCompaniesPackage, conversionOptions);
      const companyName = pkg.company?.name ?? "Unknown";
      const companySlug = typeof pkg.company?.slug === "string" ? pkg.company.slug : undefined;
      const selectedSkillsCount = (pkg.skills ?? []).length;

      if (importItems.length === 0 && selectedSkillsCount === 0 && result.errors.length === 0 && result.skipped.length === 0) {
        throw badRequest("No agents or skills found in manifest");
      }

      if (dryRun) {
        const agentPreview = importItems.map((item) => ({
          name: item.input.name,
          role: item.input.role,
          title: typeof item.input.title === "string" ? item.input.title : undefined,
          icon: typeof item.input.icon === "string" ? item.input.icon : undefined,
          reportsTo: item.reportsTo?.resolvedAgentId,
          instructionsText: typeof item.input.instructionsText === "string"
            ? item.input.instructionsText.slice(0, 200) + (item.input.instructionsText.length > 200 ? "..." : "")
            : undefined,
          skills: Array.isArray(item.input.metadata?.skills)
            ? item.input.metadata.skills.filter((skill: unknown): skill is string => typeof skill === "string")
            : undefined,
        }));

        const skillPreview = (pkg.skills ?? [])
          .filter((skill): skill is Record<string, unknown> => typeof skill === "object" && skill !== null)
          .map((skill) => ({
            name: typeof skill.name === "string" && skill.name.length > 0 ? skill.name : "Unnamed Skill",
            description: typeof skill.description === "string" ? skill.description : undefined,
          }));

        res.json({
          dryRun: true,
          companyName,
          ...(companySlug ? { companySlug } : {}),
          agents: agentPreview,
          skills: skillPreview,
          created: result.created,
          skipped: result.skipped,
          errors: result.errors,
        });
        return;
      }

      const created: Array<{ id: string; name: string }> = [];
      const errors: Array<{ name: string; error: string }> = [...result.errors];
      const createdAgentIdsByManifestKey = new Map<string, string>();

      for (const item of importItems) {
        if (!skipExisting && existingNames.has(item.input.name)) {
          errors.push({ name: item.input.name, error: "Agent with this name already exists" });
          continue;
        }

        const input = {
          ...item.input,
          ...(item.input.metadata ? { metadata: { ...item.input.metadata } } : {}),
        };

        if (item.reportsTo?.deferredManifestKey) {
          const resolvedReportsTo = createdAgentIdsByManifestKey.get(item.reportsTo.deferredManifestKey);
          if (!resolvedReportsTo) {
            errors.push({
              name: item.input.name,
              error: `Could not resolve reportsTo reference "${item.reportsTo.raw}" because the manager was not created`,
            });
            continue;
          }
          input.reportsTo = resolvedReportsTo;
        } else if (item.reportsTo?.resolvedAgentId) {
          input.reportsTo = item.reportsTo.resolvedAgentId;
        }

        try {
          const agent = await agentStore.createAgent(input);
          created.push({ id: agent.id, name: agent.name });
          createdAgentIdsByManifestKey.set(item.manifestKey, agent.id);
        } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
          errors.push({ name: item.input.name, error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Persist package skills to project skills directory
      const projectRoot = scopedStore.getRootDir();
      const skillImportResult = await persistImportedSkills(
        projectRoot,
        (pkg.skills ?? []) as SkillManifestForImport[],
        companySlug,
      );

      res.json({
        companyName,
        ...(companySlug ? { companySlug } : {}),
        created,
        skipped: result.skipped,
        errors,
        skillsCount: (pkg.skills ?? []).length,
        skills: skillImportResult,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "AgentCompaniesParseError") {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
      // Handle AbortError from timed-out fetch calls
      if (err instanceof Error && err.name === "AbortError") {
        throw badRequest("Downloading company repository timed out after 30 seconds");
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/stats
   * Return aggregate stats across all agents.
   * Must be registered before /agents/:id to avoid "stats" matching :id.
   * Note: assignedTaskCount excludes agents whose linked task is in a terminal state.
   */
  router.get("/agents/stats", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agents = await agentStore.listAgents();
      const activeCount = agents.filter((a) => a.state === "active" || a.state === "running").length;

      // Count only agents with non-terminal linked tasks
      const sanitizedAgents = await sanitizeAgentTaskLinks(agents, scopedStore);
      const assignedTaskCount = sanitizedAgents.filter((a) => a.taskId).length;

      let completedRuns = 0;
      let failedRuns = 0;
      for (const agent of agents) {
        const runs = await agentStore.getRecentRuns(agent.id, 100);
        completedRuns += runs.filter((r) => r.status === "completed").length;
        failedRuns += runs.filter((r) => r.status === "failed" || r.status === "terminated").length;
      }

      const total = completedRuns + failedRuns;
      const successRate = total > 0 ? completedRuns / total : 0;
      res.json({ activeCount, assignedTaskCount, completedRuns, failedRuns, successRate });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/org-tree
   * Return full agent org chart tree.
   * Must be registered before /agents/:id to avoid "org-tree" matching :id.
   */
  router.get("/agents/org-tree", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const includeEphemeral = req.query.includeEphemeral === "true";
      const tree = await agentStore.getOrgTree({ includeEphemeral });
      res.json(tree);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/resolve/:shortname
   * Resolve an agent by shortname or ID.
   * Must be registered before /agents/:id to avoid "resolve" matching :id.
   */
  router.get("/agents/resolve/:shortname", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.resolveAgent(req.params.shortname);
      if (!agent) {
        throw notFound("Agent not found");
      }

      res.json({ agent });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id
   * Get agent by ID with heartbeat history.
   * taskId is omitted from response if the linked task is in a terminal state.
   */
  router.get("/agents/:id", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgentDetail(req.params.id, 50);
      if (!agent) {
        throw notFound("Agent not found");
      }
      // Sanitize taskId for single-agent responses (omit if linked task is terminal)
      const [sanitizedAgent] = await sanitizeAgentTaskLinks([agent], scopedStore);
      res.json(sanitizedAgent);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PATCH /api/agents/:id
   * Update agent fields.
   */
  router.patch("/agents/:id", async (req, res) => {
    try {
      const body = req.body ?? {};
      const updates: import("@fusion/core").AgentUpdateInput = {};

      if ("name" in body) {
        if (body.name !== null && typeof body.name !== "string") {
          throw badRequest("name must be a string");
        }
        updates.name = body.name ?? undefined;
      }

      if ("role" in body) {
        if (body.role !== null && typeof body.role !== "string") {
          throw badRequest("role must be a string");
        }
        updates.role = body.role ?? undefined;
      }

      if ("metadata" in body) {
        if (body.metadata !== null && (typeof body.metadata !== "object" || Array.isArray(body.metadata))) {
          throw badRequest("metadata must be an object");
        }
        updates.metadata = body.metadata ?? undefined;
      }

      if ("title" in body) {
        if (body.title !== null && typeof body.title !== "string") {
          throw badRequest("title must be a string");
        }
        updates.title = body.title ?? undefined;
      }

      if ("icon" in body) {
        if (body.icon !== null && typeof body.icon !== "string") {
          throw badRequest("icon must be a string");
        }
        updates.icon = body.icon ?? undefined;
      }

      if ("reportsTo" in body) {
        if (body.reportsTo !== null && typeof body.reportsTo !== "string") {
          throw badRequest("reportsTo must be a string");
        }
        updates.reportsTo = body.reportsTo ?? undefined;
      }

      if ("pauseReason" in body) {
        if (body.pauseReason !== null && typeof body.pauseReason !== "string") {
          throw badRequest("pauseReason must be a string");
        }
        updates.pauseReason = body.pauseReason ?? undefined;
      }

      if ("runtimeConfig" in body) {
        if (body.runtimeConfig !== null && (typeof body.runtimeConfig !== "object" || Array.isArray(body.runtimeConfig))) {
          throw badRequest("runtimeConfig must be an object");
        }
        updates.runtimeConfig = body.runtimeConfig ?? undefined;
      }

      if ("permissions" in body) {
        if (body.permissions !== null && (typeof body.permissions !== "object" || Array.isArray(body.permissions))) {
          throw badRequest("permissions must be an object");
        }
        updates.permissions = body.permissions ?? undefined;
      }

      if ("totalInputTokens" in body) {
        if (body.totalInputTokens !== null && typeof body.totalInputTokens !== "number") {
          throw badRequest("totalInputTokens must be a number");
        }
        updates.totalInputTokens = body.totalInputTokens ?? undefined;
      }

      if ("totalOutputTokens" in body) {
        if (body.totalOutputTokens !== null && typeof body.totalOutputTokens !== "number") {
          throw badRequest("totalOutputTokens must be a number");
        }
        updates.totalOutputTokens = body.totalOutputTokens ?? undefined;
      }

      if (!validateAgentInstructionsPayload(res, body.instructionsPath, body.instructionsText)) {
        return;
      }
      if ("instructionsPath" in body) {
        updates.instructionsPath = body.instructionsPath ?? undefined;
      }
      if ("instructionsText" in body) {
        updates.instructionsText = body.instructionsText ?? undefined;
      }

      if ("soul" in body) {
        if (body.soul !== null && typeof body.soul !== "string") {
          throw badRequest("soul must be a string");
        }
        if (typeof body.soul === "string" && body.soul.length > 10000) {
          throw badRequest("soul must be at most 10,000 characters");
        }
        updates.soul = body.soul ?? undefined;
      }

      if ("memory" in body) {
        if (body.memory !== null && typeof body.memory !== "string") {
          throw badRequest("memory must be a string");
        }
        if (typeof body.memory === "string" && body.memory.length > 50000) {
          throw badRequest("memory must be at most 50,000 characters");
        }
        updates.memory = body.memory ?? undefined;
      }

      if ("bundleConfig" in body) {
        if (body.bundleConfig !== null) {
          if (typeof body.bundleConfig !== "object" || Array.isArray(body.bundleConfig)) {
            throw badRequest("bundleConfig must be an object");
          }
          if (typeof body.bundleConfig.mode !== "string" || !["managed", "external"].includes(body.bundleConfig.mode)) {
            throw badRequest("bundleConfig.mode must be 'managed' or 'external'");
          }
          if (typeof body.bundleConfig.entryFile !== "string") {
            throw badRequest("bundleConfig.entryFile must be a string");
          }
          if (!Array.isArray(body.bundleConfig.files)) {
            throw badRequest("bundleConfig.files must be an array");
          }
          if (body.bundleConfig.externalPath !== undefined && typeof body.bundleConfig.externalPath !== "string") {
            throw badRequest("bundleConfig.externalPath must be a string");
          }
        }
        updates.bundleConfig = body.bundleConfig ?? undefined;
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.updateAgent(req.params.id, updates);
      res.json(agent);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("cannot be empty")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/access
   * Get computed access state for an agent.
   */
  router.get("/agents/:id/access", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore, computeAccessState } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const state = computeAccessState(agent);
      res.json(serializeAccessState(state));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PATCH /api/agents/:id/permissions
   * Update agent permission grants.
   */
  router.patch("/agents/:id/permissions", async (req, res) => {
    try {
      const { permissions } = req.body ?? {};

      if (permissions === undefined || permissions === null || typeof permissions !== "object" || Array.isArray(permissions)) {
        throw badRequest("permissions must be an object");
      }

      const { AgentStore, isValidPermission } = await import("@fusion/core");

      for (const [key, value] of Object.entries(permissions as Record<string, unknown>)) {
        if (key.startsWith("budget:")) {
          throw badRequest("Budget permissions are not supported");
        }
        if (!isValidPermission(key)) {
          throw badRequest(`Invalid permission: ${key}`);
        }
        if (typeof value !== "boolean") {
          throw badRequest(`Permission value for ${key} must be boolean`);
        }
      }

      const { store: scopedStore } = await getProjectContext(req);
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.updateAgent(req.params.id, {
        permissions: permissions as Record<string, boolean>,
      });
      res.json(agent);
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
   * PATCH /api/agents/:id/instructions
   * Update agent custom instructions.
   * Body: { instructionsPath?: string, instructionsText?: string }
   */
  router.patch("/agents/:id/instructions", async (req, res) => {
    try {
      const { instructionsPath, instructionsText } = req.body ?? {};
      if (!validateAgentInstructionsPayload(res, instructionsPath, instructionsText)) {
        return;
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.updateAgent(req.params.id, {
        instructionsPath: instructionsPath ?? undefined,
        instructionsText: instructionsText ?? undefined,
      });
      res.json(agent);
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
   * GET /api/agents/:id/soul
   * Fetch agent soul/personality text.
   */
  router.get("/agents/:id/soul", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      res.json({ soul: agent.soul ?? null });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PATCH /api/agents/:id/soul
   * Update agent soul/personality text.
   * Body: { soul: string }
   */
  router.patch("/agents/:id/soul", async (req, res) => {
    try {
      const { soul } = req.body ?? {};
      if (typeof soul !== "string") {
        throw badRequest("soul must be a string");
      }
      if (soul.length > 10000) {
        throw badRequest("soul must be at most 10,000 characters");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.updateAgent(req.params.id, { soul });
      res.json(agent);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/memory
   * Fetch per-agent memory text.
   */
  router.get("/agents/:id/memory", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      res.json({ memory: agent.memory ?? null });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PATCH /api/agents/:id/memory
   * Update per-agent memory text.
   * Body: { memory: string }
   */
  router.patch("/agents/:id/memory", async (req, res) => {
    try {
      const { memory } = req.body ?? {};
      if (typeof memory !== "string") {
        throw badRequest("memory must be a string");
      }
      if (memory.length > 50000) {
        throw badRequest("memory must be at most 50,000 characters");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.updateAgent(req.params.id, { memory });
      res.json(agent);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/memory/files
   * Lists OpenClaw memory files for one agent.
   */
  router.get("/agents/:id/memory/files", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agentId = req.params.id;
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const rootDir = scopedStore.getRootDir();
      const files = await listAgentMemoryFiles(rootDir, agentId);
      res.json({ files });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof MemoryBackendError) {
        const status = err.code === "NOT_FOUND" ? 404 : err.code === "UNSUPPORTED" ? 400 : 500;
        throw new ApiError(status, `Memory operation failed: ${err.message}`, { code: err.code, backend: err.backend });
      }
      rethrowAsApiError(err, "Failed to list agent memory files");
    }
  });

  /**
   * GET /api/agents/:id/memory/file?path=.fusion/agent-memory/:id/MEMORY.md
   * Reads a validated agent memory file.
   */
  router.get("/agents/:id/memory/file", async (req, res) => {
    try {
      const path = typeof req.query.path === "string" ? req.query.path : "";
      if (!path) {
        throw badRequest("path is required");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agentId = req.params.id;
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const rootDir = scopedStore.getRootDir();
      const result = await readAgentMemoryFile(rootDir, agentId, path);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof MemoryBackendError) {
        const status = err.code === "NOT_FOUND" ? 404 : err.code === "UNSUPPORTED" ? 400 : 500;
        throw new ApiError(status, `Memory operation failed: ${err.message}`, { code: err.code, backend: err.backend });
      }
      rethrowAsApiError(err, "Failed to read agent memory file");
    }
  });

  /**
   * PUT /api/agents/:id/memory/file
   * Writes one validated agent memory file.
   */
  router.put("/agents/:id/memory/file", async (req, res) => {
    try {
      const { path, content } = req.body ?? {};
      if (typeof path !== "string" || !path.trim()) {
        throw badRequest("path must be a string");
      }
      if (typeof content !== "string") {
        throw badRequest("content must be a string");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agentId = req.params.id;
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const rootDir = scopedStore.getRootDir();
      const result = await writeAgentMemoryFile(rootDir, agentId, path, content);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof MemoryBackendError) {
        const status = err.code === "NOT_FOUND" ? 404 : err.code === "UNSUPPORTED" ? 400 : 500;
        throw new ApiError(status, `Memory operation failed: ${err.message}`, { code: err.code, backend: err.backend });
      }
      rethrowAsApiError(err, "Failed to save agent memory file");
    }
  });

  /**
   * POST /api/agents/:id/state
   * Update agent state.
   * Body: { state: AgentState }
   */
  router.post("/agents/:id/state", async (req, res) => {
    try {
      const { state } = req.body;
      if (!state || typeof state !== "string") {
        throw badRequest("state is required");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.updateAgentState(req.params.id, state as import("@fusion/core").AgentState);
      res.json(agent);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else if (/invalid state transition/i.test(err instanceof Error ? err.message : String(err))) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * DELETE /api/agents/:id
   * Delete an agent.
   */
  router.delete("/agents/:id", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      await agentStore.deleteAgent(req.params.id);
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
   * GET /api/agents/:id/config-revisions
   * List config revisions for an agent.
   * Query: limit (default: 50)
   */
  router.get("/agents/:id/config-revisions", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const rawLimit = req.query.limit;
      const limit = rawLimit === undefined ? 50 : Number.parseInt(String(rawLimit), 10);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw badRequest("limit must be a positive integer");
      }

      const revisions = await agentStore.getConfigRevisions(req.params.id, limit);
      res.json(revisions);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/config-revisions/:revisionId
   * Get a specific config revision for an agent.
   */
  router.get("/agents/:id/config-revisions/:revisionId", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const revision = await agentStore.getConfigRevision(req.params.id, req.params.revisionId);
      if (!revision) {
        throw notFound("Config revision not found");
      }

      res.json(revision);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/agents/:id/config-revisions/:revisionId/rollback
   * Roll back an agent to a previous config revision.
   */
  router.post("/agents/:id/config-revisions/:revisionId/rollback", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const result = await agentStore.rollbackConfig(req.params.id, req.params.revisionId);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("belongs to agent")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/budget
   * Get budget status for an agent.
   */
  router.get("/agents/:id/budget", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const budgetStatus = await agentStore.getBudgetStatus(req.params.id);
      res.json(budgetStatus);
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
   * POST /api/agents/:id/budget/reset
   * Reset budget usage for an agent.
   */
  router.post("/agents/:id/budget/reset", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      await agentStore.resetBudgetUsage(req.params.id);
      res.json({ success: true });
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
   * POST /api/agents/:id/keys
   * Create a new API key for an agent.
   * Body: { label?: string }
   */
  router.post("/agents/:id/keys", async (req, res) => {
    try {
      const { label } = req.body ?? {};
      if (label !== undefined && typeof label !== "string") {
        throw badRequest("label must be a string");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const result = await agentStore.createApiKey(req.params.id, { label });
      res.status(201).json(result);
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
   * GET /api/agents/:id/keys
   * List all API keys for an agent.
   */
  router.get("/agents/:id/keys", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const keys = await agentStore.listApiKeys(req.params.id);
      res.json(keys);
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
   * DELETE /api/agents/:id/keys/:keyId
   * Revoke an API key for an agent.
   */
  router.delete("/agents/:id/keys/:keyId", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const revoked = await agentStore.revokeApiKey(req.params.id, req.params.keyId);
      res.json(revoked);
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
   * GET /api/agents/:id/tasks
   * List tasks explicitly assigned to the given agent.
   */
  router.get("/agents/:id/tasks", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const tasks = await scopedStore.listTasks({ slim: true, includeArchived: false });
      res.json(tasks.filter((task) => task.assignedAgentId === req.params.id));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/agents/:id/inbox
   * Select the next inbox-lite task candidate for an agent.
   *
   * Returns `{ task, priority, reason }` when work is available,
   * or `{ task: null }` when no matching work is found.
   */
  router.post("/agents/:id/inbox", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agentId = req.params.id;
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const selection = await scopedStore.selectNextTaskForAgent(agentId);
      if (!selection) {
        res.json({ task: null });
        return;
      }

      res.json({
        task: selection.task,
        priority: selection.priority,
        reason: selection.reason,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/agents/:id/heartbeat
   * Record a heartbeat for an agent.
   * Body: { status?: "ok"|"missed"|"recovered", triggerExecution?: boolean }
   *
   * When triggerExecution is true AND HeartbeatMonitor is available,
   * also executes a heartbeat run after recording the heartbeat event.
   *
   * UTILITY PATH: Heartbeat routes are on a separate control-plane lane and are
   * independent of task-lane saturation. They must NOT be gated on maxConcurrent,
   * semaphore state, or queue depth.
   */
  router.post("/agents/:id/heartbeat", async (req, res) => {
    try {
      const { status = "ok", triggerExecution } = req.body;

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const event = await agentStore.recordHeartbeat(req.params.id, status as "ok" | "missed" | "recovered");

      // Optionally trigger execution
      let run: import("@fusion/core").AgentHeartbeatRun | undefined;
      if (triggerExecution && hasHeartbeatExecutor && heartbeatMonitor && isHeartbeatMonitorForProject(scopedStore)) {
        run = await heartbeatMonitor.executeHeartbeat({
          agentId: req.params.id,
          source: "on_demand",
          triggerDetail: "Triggered from heartbeat",
          contextSnapshot: {
            wakeReason: "on_demand",
            triggerDetail: "Triggered from heartbeat",
          },
        });
      }

      res.json(run ? { event, run } : event);
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
   * GET /api/agents/:id/heartbeats
   * Get heartbeat history for an agent.
   * Query: limit (default: 50)
   */
  router.get("/agents/:id/heartbeats", async (req, res) => {
    try {
      const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 50;

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const history = await agentStore.getHeartbeatHistory(req.params.id, limit);
      res.json(history);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/runs
   * List recent runs for an agent.
   * Query: limit (default: 20)
   */
  router.get("/agents/:id/runs", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 20;
      const runs = await agentStore.getRecentRuns(req.params.id, limit);
      res.json(runs);
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
   * POST /api/agents/:id/runs
   * Manually start a heartbeat run for an agent.
   * Body: {
   *   source?: HeartbeatInvocationSource,
   *   triggerDetail?: string,
   *   taskId?: string,
   *   triggeringCommentIds?: string[],
   *   triggeringCommentType?: "steering" | "task" | "pr",
   * }
   *
   * When HeartbeatMonitor is available, delegates to executeHeartbeat() with
   * a structured wake context snapshot. This ensures a single authoritative run
   * record is created and fully completed without duplicate startRun calls.
   *
   * Returns 409 Conflict if the agent already has an active run.
   *
   * UTILITY PATH: Agent run routes are on a separate control-plane lane and are
   * independent of task-lane saturation. They must NOT be gated on maxConcurrent,
   * semaphore state, or queue depth. The active-run 409 contract is preserved:
   * { error: "Agent already has an active run", details: { runId } }.
   */
  router.post("/agents/:id/runs", async (req, res) => {
    try {
      const { source, triggerDetail, taskId, triggeringCommentIds, triggeringCommentType } = req.body || {};
      const invocationSource = source ?? "on_demand";
      const trigger = triggerDetail ?? "Triggered from dashboard";

      if (triggeringCommentIds !== undefined) {
        if (!Array.isArray(triggeringCommentIds) || triggeringCommentIds.some((id) => typeof id !== "string")) {
          throw badRequest("triggeringCommentIds must be an array of strings");
        }
      }
      if (
        triggeringCommentType !== undefined
        && triggeringCommentType !== "steering"
        && triggeringCommentType !== "task"
        && triggeringCommentType !== "pr"
      ) {
        throw badRequest("triggeringCommentType must be one of: steering, task, pr");
      }

      const normalizedTriggeringCommentIds = Array.isArray(triggeringCommentIds)
        ? triggeringCommentIds.map((id) => id.trim()).filter((id) => id.length > 0)
        : undefined;
      const normalizedTriggeringCommentType =
        triggeringCommentType === "steering" || triggeringCommentType === "task" || triggeringCommentType === "pr"
          ? triggeringCommentType
          : undefined;

      // Build structured wake context
      const contextSnapshot: Record<string, unknown> = {
        wakeReason: invocationSource,
        triggerDetail: trigger,
      };
      if (taskId) {
        contextSnapshot.taskId = taskId;
      }
      if (normalizedTriggeringCommentIds?.length) {
        contextSnapshot.triggeringCommentIds = normalizedTriggeringCommentIds;
      }
      if (normalizedTriggeringCommentType) {
        contextSnapshot.triggeringCommentType = normalizedTriggeringCommentType;
      }

      if (hasHeartbeatExecutor && heartbeatMonitor) {
        // Check for existing active run
        const { store: scopedStore } = await getProjectContext(req);

        // Guard: heartbeatMonitor is bound to a specific project root directory.
        // Reject when the scoped store belongs to a different project.
        if (!isHeartbeatMonitorForProject(scopedStore)) {
          throw new ApiError(400, "Agent execution is only available for the server's primary project. The heartbeat monitor is not bound to this project.");
        }

        const { AgentStore: AgentStoreClass } = await import("@fusion/core");
        const agentStore = new AgentStoreClass({ rootDir: scopedStore.getFusionDir() });
        await agentStore.init();

        const agent = await agentStore.getAgent(req.params.id);
        if (!agent) {
          throw notFound(`Agent ${req.params.id} not found`);
        }

        const activeRun = await agentStore.getActiveHeartbeatRun(req.params.id);
        if (activeRun) {
          throw new ApiError(409, "Agent already has an active run", { runId: activeRun.id });
        }

        // Execute heartbeat end-to-end (single run record, no duplicate startRun call)
        const run = await heartbeatMonitor.executeHeartbeat({
          agentId: req.params.id,
          source: invocationSource,
          triggerDetail: trigger,
          taskId,
          triggeringCommentIds: normalizedTriggeringCommentIds,
          triggeringCommentType: normalizedTriggeringCommentType,
          contextSnapshot,
        });

        res.status(201).json(run);
      } else {
        // Fallback: record-only behavior without HeartbeatMonitor
        const { store: scopedStore } = await getProjectContext(req);
        const { AgentStore } = await import("@fusion/core");
        const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
        await agentStore.init();

        const agent = await agentStore.getAgent(req.params.id);
        if (!agent) {
          throw notFound(`Agent ${req.params.id} not found`);
        }

        // Check for existing active run
        const activeRun = await agentStore.getActiveHeartbeatRun(req.params.id);
        if (activeRun) {
          throw new ApiError(409, "Agent already has an active run", { runId: activeRun.id });
        }

        const run = await agentStore.startHeartbeatRun(req.params.id);

        // Enrich with invocation source, trigger detail, and context snapshot
        run.invocationSource = invocationSource;
        run.triggerDetail = trigger;
        run.contextSnapshot = contextSnapshot;

        await agentStore.saveRun(run);
        res.status(201).json(run);
      }
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
   * POST /api/agents/:id/runs/stop
   * Stop the currently active heartbeat run for an agent.
   */
  router.post("/agents/:id/runs/stop", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const activeRun = await agentStore.getActiveHeartbeatRun(req.params.id);
      if (!activeRun) {
        res.status(200).json({ ok: true, message: "No active run" });
        return;
      }

      if (hasHeartbeatExecutor && heartbeatMonitor && isHeartbeatMonitorForProject(scopedStore)) {
        await heartbeatMonitor.stopRun(req.params.id);
      } else {
        const existingRun = await agentStore.getRunDetail(req.params.id, activeRun.id);
        if (existingRun) {
          await agentStore.saveRun({
            ...existingRun,
            endedAt: new Date().toISOString(),
            status: "terminated",
            stderrExcerpt: existingRun.stderrExcerpt ?? "Run stopped by user",
          });
        }

        await agentStore.endHeartbeatRun(activeRun.id, "terminated");

        try {
          await agentStore.updateAgentState(req.params.id, "active");
        } catch {
          // Best effort to restore an idle/active state for follow-up runs.
        }
      }

      res.status(200).json({ ok: true, runId: activeRun.id });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/runs/:runId
   * Get detail for a specific agent run.
   */
  router.get("/agents/:id/runs/:runId", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const run = await agentStore.getRunDetail(req.params.id, req.params.runId);
      if (!run) {
        throw notFound("Run not found");
      }
      res.json(run);
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
   * GET /api/agents/:id/runs/:runId/logs
   * Get agent log entries for a specific run's time window.
   * Uses the run's contextSnapshot.taskId to locate the task's agent log,
   * then filters entries by the run's startedAt/endedAt timestamps.
   * Returns an empty array if the run has no associated task.
   */
  router.get("/agents/:id/runs/:runId/logs", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const run = await agentStore.getRunDetail(req.params.id, req.params.runId);
      if (!run) {
        throw notFound("Run not found");
      }

      // Only use the run's context snapshot for task ID — do not fall back
      // to agent.taskId since that represents the agent's *current* task,
      // not the task active during a historical run.
      const taskId = run.contextSnapshot?.taskId as string | undefined;
      if (!taskId) {
        res.json(runExcerptToAgentLogs(run));
        return;
      }

      const logs = await scopedStore.getAgentLogsByTimeRange(
        taskId,
        run.startedAt,
        run.endedAt,
      );
      res.json(logs.length > 0 ? logs : runExcerptToAgentLogs(run));
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
   * GET /api/agents/:id/runs/:runId/mutations
   * Get the mutation trail for a specific agent run.
   * Returns all TaskLogEntry objects correlated with the given runId via runContext.
   */
  router.get("/agents/:id/runs/:runId/mutations", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      // Verify the run exists
      const run = await agentStore.getRunDetail(req.params.id, req.params.runId);
      if (!run) {
        throw notFound("Run not found");
      }

      // Query mutation trail
      const mutations = await scopedStore.getMutationsForRun(req.params.runId);
      res.json({ runId: req.params.runId, mutations });
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
   * GET /api/agents/:id/runs/:runId/audit
   * Get normalized run-audit events for a specific agent run.
   *
   * Query params:
   *   - taskId: Filter by task ID
   *   - domain: Filter by domain (database, git, filesystem)
   *   - startTime: Start of time range (ISO-8601)
   *   - endTime: End of time range (ISO-8601)
   *   - limit: Maximum events to return (default 100, max 1000)
   *
   * Response: RunAuditResponse with normalized events and filter metadata
   */
  router.get("/agents/:id/runs/:runId/audit", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      // Validate runId is not blank/whitespace
      const runId = req.params.runId;
      if (!runId || runId.trim().length === 0) {
        throw badRequest("runId is required");
      }

      // Verify the run exists
      const run = await agentStore.getRunDetail(req.params.id, req.params.runId);
      if (!run) {
        throw notFound("Run not found");
      }

      // Parse and validate query filters
      const filters = parseRunAuditFilters(req.query as Record<string, unknown>);

      // Query run-audit events with runId as the primary filter
      const auditEvents = scopedStore.getRunAuditEvents({
        runId: req.params.runId,
        taskId: filters.taskId,
        domain: filters.domain,
        startTime: filters.startTime,
        endTime: filters.endTime,
        limit: filters.limit,
      });

      // Normalize events for UI consumption
      const normalizedEvents = auditEvents.map(normalizeRunAuditEvent);

      // Get total count (without limit) for pagination metadata
      const totalEvents = scopedStore.getRunAuditEvents({
        runId: req.params.runId,
        taskId: filters.taskId,
        domain: filters.domain,
        startTime: filters.startTime,
        endTime: filters.endTime,
      });

      const response: RunAuditResponse = {
        runId: req.params.runId,
        events: normalizedEvents,
        filters: {
          taskId: filters.taskId,
          domain: filters.domain,
          startTime: filters.startTime,
          endTime: filters.endTime,
        },
        totalCount: totalEvents.length,
        hasMore: filters.limit !== undefined && totalEvents.length > filters.limit,
      };

      res.json(response);
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
   * GET /api/agents/:id/runs/:runId/timeline
   * Get a correlated timeline combining run-audit events and agent logs for a specific run.
   *
   * Query params:
   *   - taskId: Override task ID for audit filtering (defaults to run's contextSnapshot.taskId)
   *   - domain: Filter audit events by domain (database, git, filesystem)
   *   - startTime: Start of time range (ISO-8601)
   *   - endTime: End of time range (ISO-8601)
   *   - includeLogs: Whether to include agent logs (default true)
   *   - limit: Maximum audit events to return (default 100, max 1000)
   *
   * Response: RunTimelineResponse with run metadata, grouped audit events, and merged timeline
   */
  router.get("/agents/:id/runs/:runId/timeline", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      // Validate runId is not blank/whitespace
      const runId = req.params.runId;
      if (!runId || runId.trim().length === 0) {
        throw badRequest("runId is required");
      }

      // Verify the run exists
      const run = await agentStore.getRunDetail(req.params.id, req.params.runId);
      if (!run) {
        throw notFound("Run not found");
      }

      // Parse and validate query filters
      const filters = parseRunAuditFilters(req.query as Record<string, unknown>);

      // Check includeLogs flag (default true)
      const includeLogs = (() => {
        if (req.query.includeLogs === undefined) return true;
        if (typeof req.query.includeLogs === "string") {
          const val = req.query.includeLogs.toLowerCase();
          return val === "true" || val === "1";
        }
        if (typeof req.query.includeLogs === "boolean") {
          return req.query.includeLogs;
        }
        return true;
      })();

      // Determine the task ID for audit filtering
      // Use explicit taskId filter if provided, otherwise fall back to run's contextSnapshot.taskId
      const auditTaskId = (filters.taskId ?? run.contextSnapshot?.taskId ?? undefined) as string | undefined;

      // Query run-audit events
      const auditEvents = scopedStore.getRunAuditEvents({
        runId: req.params.runId,
        taskId: auditTaskId,
        domain: filters.domain,
        startTime: filters.startTime,
        endTime: filters.endTime,
        limit: filters.limit,
      });

      // Normalize events
      const normalizedAuditEvents = auditEvents.map(normalizeRunAuditEvent);

      // Group audit events by domain
      const auditByDomain: RunTimelineResponse["auditByDomain"] = {
        database: [],
        git: [],
        filesystem: [],
      };

      for (const event of normalizedAuditEvents) {
        if (event.domain === "database") {
          auditByDomain.database.push(event);
        } else if (event.domain === "git") {
          auditByDomain.git.push(event);
        } else if (event.domain === "filesystem") {
          auditByDomain.filesystem.push(event);
        }
      }

      // Build timeline entries
      const timelineEntries: TimelineEntry[] = [];

      // Add audit events to timeline
      for (const event of auditEvents) {
        timelineEntries.push(auditEventToTimelineEntry(event));
      }

      // Add agent logs to timeline if requested and we have a task ID
      if (includeLogs && run.startedAt) {
        const taskId = auditTaskId;
        if (taskId) {
          const logs = await scopedStore.getAgentLogsByTimeRange(
            taskId,
            run.startedAt,
            run.endedAt,
          );

          for (const log of logs) {
            timelineEntries.push(logEntryToTimelineEntry(log));
          }
        }
      }

      // Sort timeline deterministically
      timelineEntries.sort(compareTimelineEntries);

      const response: RunTimelineResponse = {
        run: {
          id: run.id,
          agentId: run.agentId,
          startedAt: run.startedAt,
          endedAt: run.endedAt ?? undefined,
          status: run.status,
          taskId: (auditTaskId ?? undefined) as string | undefined,
        },
        auditByDomain,
        counts: {
          auditEvents: normalizedAuditEvents.length,
          logEntries: includeLogs && auditTaskId ? (await scopedStore.getAgentLogsByTimeRange(
            auditTaskId,
            run.startedAt,
            run.endedAt,
          )).length : 0,
        },
        timeline: timelineEntries,
      };

      res.json(response);
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
   * GET /api/agents/:id/chain-of-command
   * Fetch agent reporting chain from self to top-most manager.
   * Response 200: Agent[] — [self, manager, grand-manager, ...]
   * Response 404: { error: "Agent not found" } — When target agent doesn't exist
   */
  router.get("/agents/:id/chain-of-command", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const chain = await agentStore.getChainOfCommand(req.params.id);
      res.json(chain);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/children
   * Fetch agents that report to a given agent (parent-child hierarchy).
   * Response 200: Agent[] — Array of agents where reportsTo equals :id
   * Response 404: { error: "Agent not found" } — When parent agent doesn't exist
   */
  const getAgentEmployeesHandler = async (req: Request, res: Response) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!agentId) {
        throw badRequest("Agent id is required");
      }

      // Validate the parent agent exists
      const parent = await agentStore.getAgent(agentId);
      if (!parent) {
        throw notFound("Agent not found");
      }

      const children = await agentStore.getAgentsByReportsTo(agentId);
      res.json(children);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  };

  router.get("/agents/:id/children", getAgentEmployeesHandler);

  /**
   * GET /api/agents/:id/employees
   * Alias for /api/agents/:id/children.
   */
  router.get("/agents/:id/employees", getAgentEmployeesHandler);

  // ── Agent Reflection Routes ──────────────────────────────────────────────

  /**
   * GET /api/agents/:id/reflections/latest
   * Fetch the most recent reflection for an agent.
   * Must be registered before /agents/:id/reflections to avoid matching "latest" as a limit.
   * Response 200: AgentReflection | null — The most recent reflection or null
   * Response 404: { error: "Agent not found" } — When agent doesn't exist
   *             { error: "No reflections found" } — When agent has no reflections
   */
  router.get("/agents/:id/reflections/latest", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore, ReflectionStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      const reflectionStore = new ReflectionStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();
      await reflectionStore.init();

      const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!agentId) {
        throw badRequest("Agent id is required");
      }

      // Validate the agent exists
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const reflection = await reflectionStore.getLatestReflection(agentId);
      if (!reflection) {
        throw notFound("No reflections found");
      }

      res.json(reflection);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/reflections
   * List reflection history for an agent.
   * Query params: limit (optional, default 50)
   * Response 200: AgentReflection[] — Array of reflections
   * Response 404: { error: "Agent not found" } — When agent doesn't exist
   */
  router.get("/agents/:id/reflections", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore, ReflectionStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      const reflectionStore = new ReflectionStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();
      await reflectionStore.init();

      const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!agentId) {
        throw badRequest("Agent id is required");
      }

      // Validate the agent exists
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      // Parse limit from query params (default 50)
      const limitParam = req.query.limit;
      const limit = limitParam ? parseInt(String(limitParam), 10) : 50;

      const reflections = await reflectionStore.getReflections(agentId, limit);
      res.json(reflections);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/agents/:id/reflections
   * Trigger a manual reflection for an agent.
   * Response 201: AgentReflection — The created reflection
   * Response 404: { error: "Agent not found" } — When agent doesn't exist
   * Response 500: { error: message } — When reflection generation fails
   */
  router.post("/agents/:id/reflections", async (req, res) => {
    try {
      const { store: taskStore } = await getProjectContext(req);
      const { AgentStore, ReflectionStore } = await import("@fusion/core");
      const { AgentReflectionService } = await import("@fusion/engine");
      const agentStore = new AgentStore({ rootDir: taskStore.getFusionDir() });
      const reflectionStore = new ReflectionStore({ rootDir: taskStore.getFusionDir() });
      await agentStore.init();
      await reflectionStore.init();

      const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!agentId) {
        throw badRequest("Agent id is required");
      }

      // Validate the agent exists
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      // Create the reflection service and generate a reflection
      const reflectionService = new AgentReflectionService({
        agentStore,
        taskStore,
        reflectionStore,
        rootDir: taskStore.getRootDir(),
      });

      const reflection = await reflectionService.generateReflection(agentId, "manual");
      if (!reflection) {
        throw internalError("Unable to generate reflection — insufficient history or AI unavailable");
      }

      res.status(201).json(reflection);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/performance
   * Get aggregated performance summary for an agent.
   * Query params: windowMs (optional, default 7 days)
   * Response 200: AgentPerformanceSummary
   * Response 404: { error: "Agent not found" } — When agent doesn't exist
   */
  router.get("/agents/:id/performance", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore, ReflectionStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      const reflectionStore = new ReflectionStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();
      await reflectionStore.init();

      const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!agentId) {
        throw badRequest("Agent id is required");
      }

      // Validate the agent exists
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      // Parse windowMs from query params (default 7 days)
      const windowMsParam = req.query.windowMs;
      const windowMs = windowMsParam ? parseInt(String(windowMsParam), 10) : undefined;

      const summary = await reflectionStore.getPerformanceSummary(agentId, { windowMs });
      res.json(summary);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/reflection-context
   * Get raw context for debugging agent reflections.
   * Response 200: { context: object } — The built reflection context
   * Response 404: { error: "Agent not found" } — When agent doesn't exist
   * Response 503: { error: "Reflection service not available" } — When engine not initialized
   */
  router.get("/agents/:id/reflection-context", async (req, res) => {
    try {
      const { store: taskStore } = await getProjectContext(req);
      const { AgentStore, ReflectionStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: taskStore.getFusionDir() });
      const reflectionStore = new ReflectionStore({ rootDir: taskStore.getFusionDir() });
      await agentStore.init();
      await reflectionStore.init();

      const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!agentId) {
        throw badRequest("Agent id is required");
      }

      // Validate the agent exists
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      // Check if AgentReflectionService is available
      let AgentReflectionService: typeof import("@fusion/engine").AgentReflectionService | undefined;
      try {
        const engine = await import("@fusion/engine");
        AgentReflectionService = engine.AgentReflectionService;
      } catch {
        res.status(503).json({ error: "Reflection service not available" });
        return;
      }

      if (!AgentReflectionService) {
        res.status(503).json({ error: "Reflection service not available" });
        return;
      }

      // Create the service and build the context
      const reflectionService = new AgentReflectionService({
        agentStore,
        taskStore,
        reflectionStore,
        rootDir: taskStore.getRootDir(),
      });

      const context = await reflectionService.buildReflectionContext(agentId);
      res.json({ context });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Agent Rating Routes ─────────────────────────────────────────────────

  /**
   * GET /api/agents/:id/ratings
   * Fetch ratings for an agent.
   * Query params: limit (number, default 50), category (string, optional)
   * Response 200: AgentRating[]
   */
  router.get("/agents/:id/ratings", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 50;
      const category = typeof req.query.category === "string" ? req.query.category : undefined;

      const ratings = await agentStore.getRatings(req.params.id, { limit, category });
      res.json(ratings);
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
   * POST /api/agents/:id/ratings
   * Add a rating for an agent.
   * Body: { score: number, category?: string, comment?: string, runId?: string, taskId?: string, raterType?: string }
   * Response 201: AgentRating — The created rating
   * Response 400: { error: "score is required" } — When score is missing
   *             { error: "score must be a number between 1 and 5" } — When score is invalid
   */
  router.post("/agents/:id/ratings", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const { score, category, comment, runId, taskId, raterType } = req.body || {};

      // Validate score
      if (score === undefined || score === null) {
        throw badRequest("score is required");
      }
      if (typeof score !== "number" || !Number.isFinite(score) || score < 1 || score > 5) {
        throw badRequest("score must be a number between 1 and 5");
      }

      // Default raterType to "user" if not provided
      const resolvedRaterType = raterType || "user";

      const rating = await agentStore.addRating(req.params.id, {
        score,
        category,
        comment,
        runId,
        taskId,
        raterType: resolvedRaterType,
      });

      res.status(201).json(rating);
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
   * GET /api/agents/:id/ratings/summary
   * Fetch rating summary for an agent.
   * Response 200: AgentRatingSummary
   */
  router.get("/agents/:id/ratings/summary", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const summary = await agentStore.getRatingSummary(req.params.id);
      res.json(summary);
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
   * DELETE /api/agents/:id/ratings/:ratingId
   * Delete a specific rating.
   * Response 204: No Content
   */
  router.delete("/agents/:id/ratings/:ratingId", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      await agentStore.deleteRating(req.params.ratingId);
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

  // ── Agent Generation Routes ──────────────────────────────────────────────

  /**
   * POST /api/agents/generate/start
   * Start a new agent generation session.
   * Body: { role: string }
   * Response: { sessionId, roleDescription }
   */
  router.post("/agents/generate/start", async (req, res) => {
    try {
      const { role } = req.body as { role?: string };
      if (!role || typeof role !== "string") {
        throw badRequest("role is required and must be a string");
      }

      const trimmedRole = role.trim();
      if (trimmedRole.length === 0) {
        throw badRequest("role must not be empty");
      }
      if (trimmedRole.length > 1000) {
        throw badRequest("role must not exceed 1000 characters");
      }

      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const session = await startAgentGeneration(ip, trimmedRole);

      res.status(201).json({
        sessionId: session.id,
        roleDescription: session.roleDescription,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof AgentGenerationRateLimitError) {
        throw rateLimited(err.message);
      }
      runtimeLogger.child("agent-generation").error("Error starting session", {
        error: err instanceof Error ? err.message : String(err),
      });
      rethrowAsApiError(err, "Failed to start agent generation session");
    }
  });

  /**
   * POST /api/agents/generate/spec
   * Generate the agent specification for an existing session.
   * Body: { sessionId: string }
   * Response: { spec: AgentGenerationSpec }
   */
  router.post("/agents/generate/spec", async (req, res) => {
    try {
      const { sessionId } = req.body as { sessionId?: string };
      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      const settings = await scopedStore.getSettings();

      const spec = await generateAgentSpec(sessionId, rootDir, settings.promptOverrides);
      res.json({ spec });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof AgentGenerationSessionNotFoundError) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      runtimeLogger.child("agent-generation").error("Error generating spec", {
        error: err instanceof Error ? err.message : String(err),
      });
      rethrowAsApiError(err, "Failed to generate agent specification");
    }
  });

  /**
   * GET /api/agents/generate/:sessionId
   * Get the current state of an agent generation session.
   * Response: { session: AgentGenerationSession }
   */
  router.get("/agents/generate/:sessionId", async (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = getAgentGenerationSession(sessionId);

      if (!session) {
        throw notFound(`Session ${sessionId} not found or expired`);
      }

      res.json({ session });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * DELETE /api/agents/generate/:sessionId
   * Cancel and clean up an agent generation session.
   * Response: { success: true }
   */
  router.delete("/agents/generate/:sessionId", async (req, res) => {
    try {
      const { sessionId } = req.params;
      cleanupAgentGenerationSession(sessionId);
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Mission Routes ─────────────────────────────────────────────────────────
  // Mount mission routes at /api/missions
  router.use("/missions", createMissionRouter(store, options?.missionAutopilot, aiSessionStore, options?.missionExecutionLoop, options?.engineManager));

  // ── Roadmap Routes ─────────────────────────────────────────────────────────
  // Mount roadmap routes at /api/roadmaps
  router.use("/roadmaps", createRoadmapRouter(store));

  // ── Insights Routes ─────────────────────────────────────────────────────────
  // Mount insights routes at /api/insights
  // Uses projectId from query/body for scoping
  router.use("/insights", createInsightsRouter(store));

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
        const localNode = localNodes.find((n: any) => n.type === "local");

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
          } catch (fetchErr: any) {
            if (fetchErr.name === "AbortError" || fetchErr.code === "ETIMEDOUT") {
              throw new ApiError(504, `Remote node timeout: ${fetchErr.message}`);
            }
            throw new ApiError(502, `Remote node error: ${fetchErr.message}`);
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

  // ── Project Management Routes (Multi-Project Support) ───────────────────────
  // These routes require CentralCore which is imported dynamically to avoid
  // circular dependencies and ensure the central database is initialized.

  /**
   * GET /api/projects
   * List all registered projects with their basic info.
   * Returns: ProjectInfo[]
   */
  router.get("/projects", async (_req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      // Reconcile stale "initializing" projects before listing so the
      // dashboard never shows permanent loading spinners for legacy records.
      await central.reconcileProjectStatuses();

      const projects = prioritizeProjectsForCurrentDirectory(await central.listProjects());
      await central.close();
      
      res.json(projects);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/projects/across-nodes
   * List all registered projects from all nodes (local + remote).
   * Fetches projects from online remote nodes and merges with local projects.
   * Returns: Array of projects with nodeId and _sourceNodeName for remote projects.
   */
  router.get("/projects/across-nodes", async (_req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      // Reconcile stale "initializing" projects before listing
      await central.reconcileProjectStatuses();

      // Get local projects and registered nodes in parallel
      const [localProjects, allNodes] = await Promise.all([
        central.listProjects(),
        central.listNodes(),
      ]);

      // Filter to online remote nodes with URLs
      const remoteNodes = allNodes.filter(
        (node) => node.type === "remote" && node.status === "online" && node.url
      );

      // Short-circuit: zero remote nodes means we behave exactly like /projects.
      // Skip the Promise.allSettled machinery entirely so local-only setups pay
      // no cross-node aggregation overhead.
      if (remoteNodes.length === 0) {
        const prioritizedProjects = prioritizeProjectsForCurrentDirectory(localProjects);
        await central.close();
        res.json(prioritizedProjects);
        return;
      }

      // Fetch projects from all remote nodes in parallel
      const remoteProjectArrays = await Promise.allSettled(
        remoteNodes.map(async (node) => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);

          try {
            const response = await fetch(`${node.url}/api/projects`, {
              headers: {
                Authorization: `Bearer ${node.apiKey}`,
              },
              signal: controller.signal,
            });

            if (!response.ok) {
              throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const projects = (await response.json()) as Array<{
              id: string;
              name: string;
              path: string;
              status: "active" | "paused" | "errored" | "initializing";
              isolationMode: "in-process" | "child-process";
              nodeId?: string;
              createdAt: string;
              updatedAt: string;
              lastActivityAt?: string;
            }>;

            // Tag each remote project with the source node info
            return projects.map((project) => ({
              ...project,
              nodeId: node.id,
              _sourceNodeName: node.name,
            }));
          } finally {
            clearTimeout(timeoutId);
          }
        })
      );

      // Collect successful remote projects, log failures
      type RemoteProject = {
        id: string;
        name: string;
        path: string;
        status: "active" | "paused" | "errored" | "initializing";
        isolationMode: "in-process" | "child-process";
        nodeId: string;
        _sourceNodeName: string;
        createdAt: string;
        updatedAt: string;
        lastActivityAt?: string;
      };
      const remoteProjects = remoteProjectArrays
        .filter((result): result is PromiseFulfilledResult<RemoteProject[]> => result.status === "fulfilled")
        .flatMap((result) => result.value);

      // Log failures for any unreachable nodes
      remoteProjectArrays.forEach((result, index) => {
        if (result.status === "rejected") {
          const node = remoteNodes[index];
          runtimeLogger.child("projects:across-nodes").warn(
            `Failed to fetch projects from node ${node?.id}: ${result.reason?.message ?? result.reason}`,
          );
        }
      });

      // Merge local and remote projects
      const mergedProjects = [...localProjects, ...remoteProjects];

      // Apply directory prioritization
      const prioritizedProjects = prioritizeProjectsForCurrentDirectory(mergedProjects);

      await central.close();

      res.json(prioritizedProjects);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/projects
   * Register a new project.
   * Body: { name: string, path: string, isolationMode?: "in-process" | "child-process" }
   * Returns: RegisteredProject
   */
  router.post("/projects", async (req, res) => {
    try {
      const { name, path, isolationMode = "in-process", nodeId } = req.body;
      
      if (!name || typeof name !== "string" || !name.trim()) {
        throw badRequest("name is required and must be a non-empty string");
      }
      if (!path || typeof path !== "string" || !path.trim()) {
        throw badRequest("path is required and must be a non-empty string");
      }
      if (!["in-process", "child-process"].includes(isolationMode)) {
        throw badRequest("isolationMode must be 'in-process' or 'child-process'");
      }
      
      // Check if path exists and has .fusion/ directory (async to avoid blocking event loop)
      try {
        await access(path);
      } catch {
        throw badRequest("Project path does not exist");
      }
      let hasFusionDir = false;
      const fusionDirPath = join(path, ".fusion");
      try {
        await access(fusionDirPath);
        hasFusionDir = true;
      } catch {
        hasFusionDir = false;
      }
      
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      
      const project = await central.registerProject({
        name: name.trim(),
        path: path.trim(),
        isolationMode,
        nodeId,
      });

      // Activate the project (registration sets it to 'initializing')
      const activeProject = await central.updateProject(project.id, { status: "active" });

      // Bootstrap memory files (non-blocking, non-fatal)
      ensureMemoryFileWithBackend(path.trim()).catch(() => {
        // Memory bootstrap failure is non-fatal - project registration succeeded
      });

      // Notify the host (serve.ts/daemon.ts) so it can run project-setup
      // side-effects like installing the fusion Claude-skill into
      // .claude/skills/fusion when pi-claude-cli is configured. The callback
      // is responsible for catching its own errors — a failure here must not
      // fail the registration response.
      if (options?.onProjectRegistered) {
        try {
          options.onProjectRegistered({
            id: activeProject.id,
            name: activeProject.name,
            path: activeProject.path,
          });
        } catch (hookErr) {
          runtimeLogger.warn(
            `onProjectRegistered callback threw: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
          );
        }
      }

      await central.close();

      res.status(201).json({ ...activeProject, _meta: { hasFusionDir: hasFusionDir ? undefined : false } });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("already registered") ? 409 
        : (err instanceof Error ? err.message : String(err)).includes("Duplicate path") ? 409
        : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * POST /api/projects/detect
   * Auto-detect fn projects in a directory.
   * Body: { basePath?: string }
   * Returns: { projects: DetectedProject[] }
   */
  router.post("/projects/detect", async (req, res) => {
    try {
      const { basePath } = req.body;
      
      // Default to home directory if no basePath provided
      const searchPath = basePath || process.env.HOME || process.env.USERPROFILE || ".";
      
      // Check search path exists (async to avoid blocking event loop)
      try {
        await access(searchPath);
      } catch {
        throw badRequest("Base path does not exist");
      }

      // Get list of existing projects to check for duplicates
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      const existingProjects = await central.listProjects();
      await central.close();
      
      const existingPaths = new Set(existingProjects.map((p: { path: string }) => p.path));
      
      // Scan for .fusion/fusion.db or .fusion/fusion.db files (indicating fn projects)
      const detected: Array<{ path: string; suggestedName: string; existing: boolean }> = [];
      
      try {
        const entries = await readdir(searchPath, { withFileTypes: true });
        
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          
          const dirPath = join(searchPath, entry.name);
          // Check for .fusion/fusion.db or .fusion directory (async to avoid blocking event loop)
          let hasKbDb = false;
          let hasFusionDir = false;
          try {
            await access(join(dirPath, ".fusion", "fusion.db"));
            hasKbDb = true;
          } catch {
            hasKbDb = false;
          }
          if (!hasKbDb) {
            try {
              await access(join(dirPath, ".fusion"));
              hasFusionDir = true;
            } catch {
              hasFusionDir = false;
            }
          }
          
          if (hasKbDb || hasFusionDir) {
            detected.push({
              path: dirPath,
              suggestedName: entry.name,
              existing: existingPaths.has(dirPath),
            });
          }
        }
      } catch {
        // Ignore read errors
      }
      
      res.json({ projects: detected });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/projects/:id
   * Get a single project by ID.
   */
  router.get("/projects/:id", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      
      const project = await central.getProject(req.params.id);
      await central.close();
      
      if (!project) {
        throw notFound("Project not found");
      }
      
      res.json(project);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PATCH /api/projects/:id
   * Update a project.
   */
  router.patch("/projects/:id", async (req, res) => {
    try {
      const { name, status, isolationMode, nodeId } = req.body;
      
      const updates: Partial<import("@fusion/core").RegisteredProject> = {};
      if (name !== undefined) updates.name = name;
      if (status !== undefined) updates.status = status as import("@fusion/core").ProjectStatus;
      if (isolationMode !== undefined) updates.isolationMode = isolationMode as "in-process" | "child-process";
      
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      
      const project = await central.updateProject(req.params.id, updates);
      if (!project) {
        await central.close();
        throw notFound("Project not found");
      }

      let resultProject = project;
      if (nodeId !== undefined) {
        if (nodeId === null) {
          resultProject = await central.unassignProjectFromNode(req.params.id);
        } else if (typeof nodeId === "string" && nodeId.trim()) {
          resultProject = await central.assignProjectToNode(req.params.id, nodeId.trim());
        } else {
          await central.close();
          throw badRequest("nodeId must be a non-empty string or null");
        }
      }

      await central.close();
      
      res.json(resultProject);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("not found") ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * DELETE /api/projects/:id
   * Unregister a project.
   */
  router.delete("/projects/:id", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      
      await central.unregisterProject(req.params.id);
      await central.close();
      
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("not found") ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * GET /api/projects/:id/health
   * Get health metrics for a specific project.
   * Computes live task counts from the project-scoped task store to ensure
   * accurate stats for all projects, not just the default/first project.
   * Returns: ProjectHealth
   */
  router.get("/projects/:id/health", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const project = await central.getProject(req.params.id);
      if (!project) {
        await central.close();
        throw notFound("Project not found");
      }

      // Use the project-scoped store resolver to get the correct store for
      // this project. This ensures we compute counts from the right project,
      // regardless of which project is the dashboard's default.
      const projectStore = await getOrCreateProjectStore(req.params.id);

      // Compute live task counts from the project-specific store
      const tasks = await projectStore.listTasks({ slim: true });
      const activeCols = new Set(["triage", "todo", "in-progress", "in-review"]);
      const activeTaskCount = tasks.filter((t) => activeCols.has(t.column)).length;
      const inFlightAgentCount = tasks.filter((t) => t.column === "in-progress").length;
      const totalTasksCompleted = tasks.filter((t) => t.column === "done" || t.column === "archived").length;

      // Get central health metadata (if available) to preserve non-count fields
      const centralHealth = await central.getProjectHealth(req.params.id);
      await central.close();

      // Build response: use central health as base if available, otherwise synthesize
      const healthBase = centralHealth ?? {
        projectId: req.params.id,
        status: project.status ?? "active",
        activeTaskCount: 0,
        inFlightAgentCount: 0,
        totalTasksCompleted: 0,
        totalTasksFailed: 0,
        updatedAt: new Date().toISOString(),
      };

      res.json({
        ...healthBase,
        activeTaskCount,
        inFlightAgentCount,
        totalTasksCompleted,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/projects/:id/config
   * Get project-specific configuration.
   * Returns: { maxConcurrent: number, rootDir: string }
   */
  router.get("/projects/:id/config", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      
      const project = await central.getProject(req.params.id);
      await central.close();
      
      if (!project) {
        throw notFound("Project not found");
      }
      
      res.json({
        maxConcurrent: 2,
        rootDir: project.path,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/projects/:id/pause
   * Pause a project.
   */
  router.post("/projects/:id/pause", async (req, res) => {
    try {
      const projectId = req.params.id;

      // Use engineManager if available (production mode)
      if (options?.engineManager) {
        await options.engineManager.pauseProject(projectId);
      } else {
        // Fallback: update CentralCore directly (dev mode)
        const { CentralCore } = await import("@fusion/core");
        const central = new CentralCore();
        await central.init();
        await central.updateProject(projectId, { status: "paused" });
        await central.updateProjectHealth(projectId, { status: "paused" });
        await central.close();
      }

      // Fetch and return the updated project
      const { CentralCore: CentralCore2 } = await import("@fusion/core");
      const central = new CentralCore2();
      await central.init();
      const project = await central.getProject(projectId);
      await central.close();

      if (!project) {
        throw new ApiError(404, `Project ${projectId} not found`);
      }

      res.json(project);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("not found") ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * POST /api/projects/:id/resume
   * Resume a paused project.
   */
  router.post("/projects/:id/resume", async (req, res) => {
    try {
      const projectId = req.params.id;

      // Use engineManager if available (production mode)
      if (options?.engineManager) {
        await options.engineManager.resumeProject(projectId);
      } else {
        // Fallback: update CentralCore directly (dev mode)
        const { CentralCore } = await import("@fusion/core");
        const central = new CentralCore();
        await central.init();
        await central.updateProject(projectId, { status: "active" });
        await central.updateProjectHealth(projectId, { status: "active" });
        await central.close();
      }

      // Fetch and return the updated project
      const { CentralCore: CentralCore2 } = await import("@fusion/core");
      const central = new CentralCore2();
      await central.init();
      const project = await central.getProject(projectId);
      await central.close();

      if (!project) {
        throw new ApiError(404, `Project ${projectId} not found`);
      }

      res.json(project);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("not found") ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // ── Remote Node Settings Sync Helpers ─────────────────────────────────────

  /**
   * Helper: Validate node and make an authenticated fetch call to a remote node.
   * Returns parsed JSON on success, throws ApiError on failure.
   */
  async function fetchFromRemoteNode(
    node: import("@fusion/core").NodeConfig,
    path: string,
    options?: { method?: string; body?: unknown; timeoutMs?: number },
  ): Promise<unknown> {
    // Validate node has URL (can't fetch from local node or node without URL)
    if (!node.url) {
      throw new ApiError(400, "Node has no URL configured");
    }

    // Validate node has apiKey (secure sync requires node authentication)
    if (!node.apiKey) {
      throw new ApiError(400, "Remote node requires an apiKey for authenticated sync");
    }

    const method = options?.method ?? "GET";
    const timeoutMs = options?.timeoutMs ?? 15_000;

    // Construct full URL
    const targetUrl = new URL(path, node.url).toString();

    // Build headers with auth
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${node.apiKey}`,
      "Content-Type": "application/json",
    };

    // Build fetch options
    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (options?.body !== undefined && method !== "GET") {
      fetchOptions.body = JSON.stringify(options.body);
    }

    // Create AbortController for timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    fetchOptions.signal = controller.signal;

    try {
      const response = await fetch(targetUrl, fetchOptions);
      clearTimeout(timeout);

      // Handle auth failures from remote
      if (response.status === 401 || response.status === 403) {
        throw new ApiError(502, "Remote node authentication failed");
      }

      // Handle other non-200 responses
      if (!response.ok) {
        throw new ApiError(502, `Remote node returned ${response.status}`);
      }

      // Parse and return JSON
      return await response.json();
    } catch (err: unknown) {
      clearTimeout(timeout);

      if (err instanceof ApiError) {
        throw err;
      }

      if (err instanceof Error) {
        if (err.name === "AbortError") {
          throw new ApiError(504, "Remote node unreachable");
        }
        // Network errors (DNS, connection refused, etc.)
        throw new ApiError(504, "Remote node unreachable");
      }

      throw new ApiError(502, "Remote node request failed");
    }
  }

  // ── Node Management Routes (Multi-Node Support) ───────────────────────────

  /**
   * GET /api/nodes
   * List all registered nodes.
   * Returns: NodeConfig[]
   */
  router.get("/nodes", async (_req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const nodes = await central.listNodes();
      await central.close();

      nodes.sort((a, b) => a.name.localeCompare(b.name));
      res.json(nodes);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/nodes
   * Register a new node.
   * Body: { name, type, url?, apiKey?, maxConcurrent?, capabilities? }
   */
  router.post("/nodes", async (req, res) => {
    try {
      const { name, type, url, apiKey, maxConcurrent, capabilities } = req.body;

      if (!name || typeof name !== "string" || !name.trim()) {
        throw badRequest("name is required and must be a non-empty string");
      }

      // Default to "remote" for backward compatibility with frontend API calls
      const nodeType = type === "local" || type === "remote" ? type : "remote";

      if (nodeType === "remote" && (!url || typeof url !== "string" || !url.trim())) {
        throw badRequest("url is required for remote nodes");
      }

      if (
        maxConcurrent !== undefined
        && (typeof maxConcurrent !== "number" || !Number.isFinite(maxConcurrent) || maxConcurrent < 1)
      ) {
        throw badRequest("maxConcurrent must be a number >= 1");
      }

      if (
        capabilities !== undefined
        && (!Array.isArray(capabilities) || capabilities.some((capability) => typeof capability !== "string"))
      ) {
        throw badRequest("capabilities must be an array of strings");
      }

      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.registerNode({
        name: name.trim(),
        type: nodeType,
        url: typeof url === "string" ? url.trim() : undefined,
        apiKey: typeof apiKey === "string" ? apiKey : undefined,
        maxConcurrent,
        capabilities,
      });

      await central.close();
      res.status(201).json(node);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("already exists") ? 409 : (err instanceof Error ? err.message : String(err)).includes("must") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * GET /api/nodes/:id
   * Get node details by ID.
   */
  router.get("/nodes/:id", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.getNode(req.params.id);
      await central.close();

      if (!node) {
        throw notFound("Node not found");
      }

      res.json(node);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PATCH /api/nodes/:id
   * Update node config.
   */
  router.patch("/nodes/:id", async (req, res) => {
    try {
      const { name, url, apiKey, maxConcurrent, status, capabilities } = req.body;

      const updates: Partial<Omit<import("@fusion/core").NodeConfig, "id" | "createdAt">> = {};
      if (name !== undefined) updates.name = name;
      if (url !== undefined) updates.url = url;
      if (apiKey !== undefined) updates.apiKey = apiKey;
      if (maxConcurrent !== undefined) updates.maxConcurrent = maxConcurrent;
      if (status !== undefined) updates.status = status as import("@fusion/core").NodeStatus;
      if (capabilities !== undefined) updates.capabilities = capabilities;

      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.updateNode(req.params.id, updates);
      await central.close();

      res.json(node);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("not found") ? 404 : (err instanceof Error ? err.message : String(err)).includes("must") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * DELETE /api/nodes/:id
   * Unregister a node.
   */
  router.delete("/nodes/:id", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const existing = await central.getNode(req.params.id);
      if (!existing) {
        await central.close();
        throw notFound("Node not found");
      }

      await central.unregisterNode(req.params.id);
      await central.close();

      res.status(204).end();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/nodes/:id/health-check
   * Trigger health check for a node.
   */
  router.post("/nodes/:id/health-check", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const healthStatus = await central.checkNodeHealth(req.params.id);
      await central.close();

      res.json({ status: healthStatus });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("not found") ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * GET /api/nodes/:id/metrics
   * Get node runtime metrics (SystemMetrics from node's systemMetrics field).
   */
  router.get("/nodes/:id/metrics", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.getNode(req.params.id);
      await central.close();

      if (!node) {
        throw notFound("Node not found");
      }

      // Return the systemMetrics field which contains SystemMetrics or null
      res.json(node.systemMetrics ?? null);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/nodes/:id/version
   * Get version information for a node.
   * Returns NodeVersionInfo when present, null when no version info has been stored yet.
   */
  router.get("/nodes/:id/version", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.getNode(req.params.id);
      await central.close();

      if (!node) {
        throw notFound("Node not found");
      }

      // Return versionInfo if present, null if not yet stored
      res.json(node.versionInfo ?? null);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/nodes/:id/sync-plugins
   * Compare plugin versions between the local node and a remote node.
   * Returns PluginSyncResult with recommendations for each plugin.
   */
  router.post("/nodes/:id/sync-plugins", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      // Validate target node exists
      const targetNode = await central.getNode(req.params.id);
      if (!targetNode) {
        await central.close();
        throw notFound("Node not found");
      }

      // Reject local target nodes - sync-plugins is for remote nodes only
      if (targetNode.type === "local") {
        await central.close();
        throw badRequest("Cannot sync plugins to a local node - sync-plugins is for remote nodes only");
      }

      // Find the local node
      const nodes = await central.listNodes();
      const localNode = nodes.find((n) => n.type === "local");
      if (!localNode) {
        await central.close();
        throw badRequest("Local node not registered - cannot perform sync");
      }

      // Perform plugin sync comparison
      const result = await central.syncPlugins(localNode.id, targetNode.id);
      await central.close();

      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/nodes/:id/compatibility
   * Check version compatibility between the local node and a target node.
   * Returns VersionCompatibilityResult based on app version comparison.
   */
  router.get("/nodes/:id/compatibility", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      // Validate target node exists
      const targetNode = await central.getNode(req.params.id);
      if (!targetNode) {
        await central.close();
        throw notFound("Node not found");
      }

      // Find the local node
      const nodes = await central.listNodes();
      const localNode = nodes.find((n) => n.type === "local");
      if (!localNode) {
        await central.close();
        throw badRequest("Local node not registered - cannot check compatibility");
      }

      // Get version info for both nodes
      const localVersionInfo = await central.getNodeVersionInfo(localNode.id);
      const targetVersionInfo = await central.getNodeVersionInfo(targetNode.id);

      // Validate both have version info
      if (!localVersionInfo) {
        await central.close();
        throw badRequest("Local node has no version info yet");
      }
      if (!targetVersionInfo) {
        await central.close();
        throw badRequest("Target node has no version info yet");
      }

      // Check compatibility using version strings
      const result = central.checkVersionCompatibility(
        localVersionInfo.appVersion,
        targetVersionInfo.appVersion,
      );
      await central.close();

      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Node Settings Sync Routes ────────────────────────────────────────────

  /**
   * GET /api/nodes/:id/settings
   * Fetch settings from a remote node by proxying to the remote's /api/settings/scopes endpoint.
   * Returns: { global: GlobalSettings, project: Partial<ProjectSettings> }
   */
  router.get("/nodes/:id/settings", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.getNode(req.params.id);
      await central.close();

      if (!node) {
        throw notFound("Node not found");
      }

      if (node.type === "local") {
        throw badRequest("Cannot fetch settings from a local node");
      }

      const result = await fetchFromRemoteNode(node, "/api/settings/scopes");
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/nodes/:id/settings/push
   * Push local settings to a remote node.
   * Body: {} (empty, uses local settings automatically)
   * Returns: { success: true, syncedFields: string[] }
   */
  router.post("/nodes/:id/settings/push", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.getNode(req.params.id);
      if (!node) {
        await central.close();
        throw notFound("Node not found");
      }

      if (node.type === "local") {
        await central.close();
        throw badRequest("Cannot push settings to a local node");
      }

      // Get local project settings
      const projectSettings = await store.getSettingsByScope();

      // Get local global settings
      const globalSettingsStore = store.getGlobalSettingsStore();
      const globalSettings = await globalSettingsStore.getSettings();

      // Get local node ID for source tracking
      const localPeerInfo = await central.getLocalPeerInfo();

      // Build sync payload
      const payload = {
        global: globalSettings,
        projects: { [store.getRootDir().split("/").pop()!]: projectSettings.project },
        exportedAt: new Date().toISOString(),
        version: 1 as const,
      };

      // Compute checksum
      const { createHash } = await import("node:crypto");
      const checksum = createHash("sha256").update(JSON.stringify(payload)).digest("hex");

      // Send to remote node
      await fetchFromRemoteNode(node, "/api/settings/sync-receive", {
        method: "POST",
        body: { ...payload, checksum },
      });

      // Record sync
      await central.updateSettingsSyncState(node.id, {
        lastSyncedAt: new Date().toISOString(),
        localChecksum: checksum,
      });

      await central.close();

      // Collect synced field names
      const syncedFields = [
        ...Object.keys(globalSettings),
        ...Object.keys(projectSettings.project),
      ];

      res.json({ success: true, syncedFields });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/nodes/:id/settings/pull
   * Pull settings from a remote node and apply locally.
   * Body: { conflictResolution?: "last-write-wins" | "manual" }
   * Returns (last-write-wins): { success: true, appliedFields: string[], skippedFields: string[] }
   * Returns (manual): { diff: { global: string[], project: string[] }, remoteSettings, localSettings }
   */
  router.post("/nodes/:id/settings/pull", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.getNode(req.params.id);
      if (!node) {
        await central.close();
        throw notFound("Node not found");
      }

      if (node.type === "local") {
        await central.close();
        throw badRequest("Cannot pull settings from a local node");
      }

      const conflictResolution = req.body?.conflictResolution ?? "last-write-wins";
      if (conflictResolution !== "last-write-wins" && conflictResolution !== "manual") {
        await central.close();
        throw badRequest("conflictResolution must be 'last-write-wins' or 'manual'");
      }

      // Fetch remote settings
      const remoteSettings = await fetchFromRemoteNode(node, "/api/settings/scopes") as {
        global: Record<string, unknown>;
        project: Record<string, unknown>;
      };

      if (conflictResolution === "manual") {
        // Get local settings for diff comparison
        const localProjectSettings = await store.getSettingsByScope();
        const localGlobalSettings = await store.getGlobalSettingsStore().getSettings();

        // Compute diff: field names that differ between local and remote
        const diffGlobal = Object.keys(remoteSettings.global || {}).filter(
          (key) => JSON.stringify(remoteSettings.global?.[key]) !== JSON.stringify(localGlobalSettings[key as keyof typeof localGlobalSettings])
        );
        const diffProject = Object.keys(remoteSettings.project || {}).filter(
          (key) => JSON.stringify(remoteSettings.project?.[key]) !== JSON.stringify(localProjectSettings.project?.[key as keyof typeof localProjectSettings.project])
        );

        await central.close();

        res.json({
          diff: { global: diffGlobal, project: diffProject },
          remoteSettings,
          localSettings: { global: localGlobalSettings, project: localProjectSettings.project },
        });
        return;
      }

      // last-write-wins: apply remote settings
      // Build payload with checksum
      const { createHash } = await import("node:crypto");
      const exportedAt = new Date().toISOString();
      const payloadWithoutChecksum = {
        global: remoteSettings.global,
        projects: remoteSettings.project as Record<string, ProjectSettings>,
        exportedAt,
        version: 1 as const,
      };
      const checksum = createHash("sha256").update(JSON.stringify(payloadWithoutChecksum)).digest("hex");

      const result = await central.applyRemoteSettings({
        ...payloadWithoutChecksum,
        checksum,
      });

      // Record sync
      await central.updateSettingsSyncState(node.id, {
        lastSyncedAt: new Date().toISOString(),
        remoteChecksum: checksum,
      });

      await central.close();

      // Build applied/skipped field lists
      const appliedFields = [
        ...Object.keys(remoteSettings.global || {}),
        ...Object.keys(remoteSettings.project || {}),
      ];
      const skippedFields = result.error ? Object.keys(remoteSettings.global || {}) : [];

      res.json({
        success: result.success,
        appliedFields,
        skippedFields,
        error: result.error,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/nodes/:id/settings/sync-status
   * Returns last sync timestamp and diff summary between local and remote.
   * Returns: {
   *   lastSyncAt: string | null,
   *   lastSyncDirection: string | null,
   *   localUpdatedAt: string,
   *   remoteReachable: boolean,
   *   diff: { global: string[], project: string[] }
   * }
   */
  router.get("/nodes/:id/settings/sync-status", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.getNode(req.params.id);
      if (!node) {
        await central.close();
        throw notFound("Node not found");
      }

      if (node.type === "local") {
        await central.close();
        throw badRequest("Cannot check sync status for a local node");
      }

      // Get sync state
      const syncState = await central.getSettingsSyncState(node.id);

      // Get local settings for comparison
      const localProjectSettings = await store.getSettingsByScope();
      const localGlobalSettings = await store.getGlobalSettingsStore().getSettings();

      // Try to fetch remote settings
      let remoteReachable = false;
      let remoteSettings: { global: Record<string, unknown>; project: Record<string, unknown> } | null = null;
      let diffGlobal: string[] = [];
      let diffProject: string[] = [];

      try {
        remoteSettings = await fetchFromRemoteNode(node, "/api/settings/scopes") as {
          global: Record<string, unknown>;
          project: Record<string, unknown>;
        };
        remoteReachable = true;

        // Compute diff
        const rs = remoteSettings!;
        diffGlobal = Object.keys(rs.global || {}).filter(
          (key) => JSON.stringify(rs.global?.[key]) !== JSON.stringify(localGlobalSettings[key as keyof typeof localGlobalSettings])
        );
        diffProject = Object.keys(rs.project || {}).filter(
          (key) => JSON.stringify(rs.project?.[key]) !== JSON.stringify(localProjectSettings.project?.[key as keyof typeof localProjectSettings.project])
        );
      } catch {
        // Remote unreachable - diff will be empty arrays
      }

      await central.close();

      res.json({
        lastSyncAt: syncState?.lastSyncedAt ?? null,
        lastSyncDirection: syncState ? "sync" : null, // Direction not tracked in new schema
        localUpdatedAt: syncState?.updatedAt ?? new Date().toISOString(),
        remoteReachable,
        diff: { global: diffGlobal, project: diffProject },
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/nodes/:id/auth/sync
   * Synchronize model auth credentials with a remote node.
   * Body: { direction?: "push" | "pull" }
   * Returns: { success: true, syncedProviders: string[] }
   */
  router.post("/nodes/:id/auth/sync", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.getNode(req.params.id);
      if (!node) {
        await central.close();
        throw notFound("Node not found");
      }

      if (node.type === "local") {
        await central.close();
        throw badRequest("Cannot sync auth with a local node");
      }

      if (!node.apiKey) {
        await central.close();
        throw badRequest("Remote node requires an apiKey for auth sync");
      }

      const direction = req.body?.direction ?? "push";
      if (direction !== "push" && direction !== "pull") {
        await central.close();
        throw badRequest("direction must be 'push' or 'pull'");
      }

      // Get local node ID
      const localPeerInfo = await central.getLocalPeerInfo();
      const timestamp = new Date().toISOString();

      // Import AuthStorage
      const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
      const authStorage = AuthStorage.create(getFusionAuthPath());

      if (direction === "push") {
        // Get OAuth provider IDs to exclude
        const oauthProviders = authStorage.getOAuthProviders();
        const oauthIds = new Set(oauthProviders.map((p) => p.id));

        const allProviders = await readStoredAuthProvidersFromDisk();

        // Filter to only API-key-based providers (skip OAuth)
        const apiKeyProviders: Record<string, { type: string; key: string }> = {};
        for (const [providerId, cred] of Object.entries(allProviders)) {
          if (oauthIds.has(providerId)) continue;
          if (cred.type === "api_key" && cred.key) {
            apiKeyProviders[providerId] = { type: "api_key", key: cred.key };
          }
        }

        // Send to remote
        await fetchFromRemoteNode(node, "/api/settings/auth-receive", {
          method: "POST",
          body: {
            providers: apiKeyProviders,
            sourceNodeId: localPeerInfo.nodeId,
            timestamp,
          },
        });

        // Record sync
        await central.updateSettingsSyncState(node.id, {
          lastSyncedAt: timestamp,
        });

        await central.close();

        // Log without actual credentials
        const providerNames = Object.keys(apiKeyProviders);
        runtimeLogger.child("settings-sync").info(
          `Auth sync completed: direction=push, providers=${providerNames.join(",")}, targetNode=${node.id}`,
        );

        res.json({ success: true, syncedProviders: providerNames });
      } else {
        // Pull: fetch remote auth and apply locally
        const remoteAuth = await fetchFromRemoteNode(node, "/api/settings/auth-export") as {
          providers: Record<string, { type: string; key: string }>;
          sourceNodeId: string;
          timestamp: string;
        };

        // Write received credentials to local AuthStorage
        const syncedProviders: string[] = [];
        for (const [providerId, credential] of Object.entries(remoteAuth.providers || {})) {
          if (credential.type === "api_key" && credential.key) {
            authStorage.set(providerId, { type: "api_key", key: credential.key });
            syncedProviders.push(providerId);
          }
        }

        // Record sync
        await central.updateSettingsSyncState(node.id, {
          lastSyncedAt: timestamp,
        });

        await central.close();

        // Log without actual credentials
        runtimeLogger.child("settings-sync").info(
          `Auth sync completed: direction=pull, providers=${syncedProviders.join(",")}, targetNode=${node.id}`,
        );

        res.json({ success: true, syncedProviders });
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Mesh Topology Routes ────────────────────────────────────────────────

  /**
   * GET /api/mesh/state
   * Returns the full mesh topology state with peer connections between nodes.
   */
  router.get("/mesh/state", async (_req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const nodes = await central.listNodes();
      const remoteNodes = nodes.filter((n) => n.type === "remote");
      const meshState: unknown[] = [];
      for (const node of nodes) {
        const state = typeof (central as InstanceType<typeof CentralCore>).getMeshState === "function"
          ? await (central as InstanceType<typeof CentralCore>).getMeshState(node.id)
          : null;
        if (state) {
          meshState.push(state);
        } else {
          const connections =
            node.type === "local"
              ? remoteNodes.map((peer) => ({
                  peerId: peer.id,
                  peerName: peer.name,
                  peerUrl: peer.url ?? null,
                  status: peer.status,
                }))
              : [];
          meshState.push({
            nodeId: node.id,
            nodeName: node.name,
            nodeUrl: node.url ?? null,
            type: node.type,
            status: node.status,
            metrics: null,
            lastSeen: node.updatedAt ?? null,
            connectedAt: node.createdAt ?? null,
            knownPeers: connections,
            connections,
          });
        }
      }
      await central.close();

      res.json(meshState);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/mesh/sync
   * Exchange peer information with another node for gossip protocol.
   *
   * Request body: PeerSyncRequest (may include optional settings field)
   * Response body: PeerSyncResponse (may include optional settings field)
   */
  router.post("/mesh/sync", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      // Validate required fields
      const senderNodeId = req.body?.senderNodeId;
      if (!senderNodeId) {
        throw badRequest("senderNodeId is required");
      }

      const knownPeers = req.body?.knownPeers;
      if (!Array.isArray(knownPeers)) {
        throw badRequest("knownPeers must be an array");
      }

      // Optional: validate knownPeers entries have required fields
      for (const peer of knownPeers) {
        if (!peer?.nodeId || !peer?.nodeName || typeof peer?.status !== "string") {
          throw badRequest("Each knownPeers entry must have nodeId, nodeName, and status");
        }
      }

      // Get sender node from registry to validate auth
      const senderNode = await central.getNode(senderNodeId);

      // Auth validation: if sender is registered with an apiKey, validate it
      if (senderNode?.apiKey) {
        const authHeader = req.headers.authorization;
        const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

        if (!token || token !== senderNode.apiKey) {
          await central.close();
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
      }

      // Merge incoming peer data
      await central.mergePeers(knownPeers);

      // Update sender node status to online (it sent us a request, so it's alive)
      try {
        await central.updateNode(senderNodeId, { status: "online" });
      } catch {
        // Silently skip if sender node not found in local registry
      }

      // Get all known peers
      const allKnownPeers = await central.getAllKnownPeerInfo();

      // Calculate newPeers - peers the sender doesn't know about
      const senderKnownIds = new Set(knownPeers.map((p: { nodeId: string }) => p.nodeId));
      const newPeers = allKnownPeers.filter((peer) => !senderKnownIds.has(peer.nodeId));

      // Get local node info
      const localPeer = await central.getLocalPeerInfo();

      // ── Settings sync: handle incoming settings and prepare response ──
      let responseSettings: import("@fusion/core").SettingsSyncPayload | undefined;
      const remoteSettings = req.body?.settings;

      if (remoteSettings) {
        try {
          // Get local settings from the dashboard's GlobalSettingsStore
          const localGlobal = await store.getGlobalSettingsStore().getSettings();
          const localPayload = await central.getSettingsForSync(localGlobal);
          const localChecksum = localPayload.checksum;

          // Apply remote settings if checksum differs (remote is newer/different)
          if (remoteSettings.checksum !== localChecksum) {
            const applyResult = await central.applyRemoteSettings(remoteSettings);

            if (applyResult.success) {
              runtimeLogger.child("mesh/sync").info(
                `Applied remote settings from ${senderNodeId}: global=${applyResult.globalCount}, projects=${applyResult.projectCount}, auth=${applyResult.authCount}`,
              );
            } else {
              runtimeLogger.child("mesh/sync").warn(`Failed to apply remote settings: ${applyResult.error}`);
            }
          }

          // Always respond with our settings if sender included theirs
          responseSettings = localPayload;
        } catch (err) {
          // Log but don't fail the sync - peers are more important
          runtimeLogger.child("mesh/sync").error("Settings sync error", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      await central.close();

      // Return sync response
      const response: Record<string, unknown> = {
        senderNodeId: localPeer.nodeId,
        senderNodeUrl: localPeer.nodeUrl,
        knownPeers: allKnownPeers,
        newPeers,
        timestamp: new Date().toISOString(),
      };

      // Include settings in response if sender sent settings
      if (responseSettings) {
        response.settings = responseSettings;
      }

      res.json(response);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Node Discovery Routes (mDNS / DNS-SD) ────────────────────────────────

  /**
   * GET /api/discovery/status
   * Returns whether discovery is active and the current config.
   */
  router.get("/discovery/status", async (_req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const active = central.isDiscoveryActive();
      const config = central.getDiscoveryConfig();
      await central.close();

      res.json({ active, config });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/discovery/start
   * Body: { broadcast?: boolean, listen?: boolean, port?: number, serviceType?: string }
   */
  router.post("/discovery/start", async (req, res) => {
    try {
      const broadcast = req.body?.broadcast ?? true;
      const listen = req.body?.listen ?? true;
      const requestPort = req.body?.port;
      const serviceType = typeof req.body?.serviceType === "string" && req.body.serviceType.trim().length > 0
        ? req.body.serviceType.trim()
        : "_fusion._tcp";

      if (typeof broadcast !== "boolean") {
        throw badRequest("broadcast must be a boolean");
      }
      if (typeof listen !== "boolean") {
        throw badRequest("listen must be a boolean");
      }
      if (
        requestPort !== undefined
        && (typeof requestPort !== "number" || !Number.isFinite(requestPort) || requestPort < 1)
      ) {
        throw badRequest("port must be a number >= 1");
      }

      const localPort = typeof req.socket.localPort === "number" && req.socket.localPort > 0
        ? req.socket.localPort
        : 4040;
      const port = requestPort ?? localPort;

      const config: import("@fusion/core").DiscoveryConfig = {
        broadcast,
        listen,
        serviceType,
        port,
        staleTimeoutMs: 300_000,
      };

      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      await central.startDiscovery(config);
      await central.close();

      res.json({ success: true, config });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/discovery/stop
   * Stops active mDNS discovery.
   */
  router.post("/discovery/stop", async (_req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      central.stopDiscovery();
      await central.close();

      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/discovery/nodes
   * List currently discovered nodes.
   */
  router.get("/discovery/nodes", async (_req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const nodes = central.getDiscoveredNodes();
      await central.close();

      res.json(nodes);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/discovery/connect
   * Register a discovered node in the node registry.
   * Body: { name: string, host: string, port: number, apiKey?: string }
   */
  router.post("/discovery/connect", async (req, res) => {
    try {
      const { name, host, port, apiKey } = req.body as {
        name?: unknown;
        host?: unknown;
        port?: unknown;
        apiKey?: unknown;
      };

      if (typeof name !== "string" || !name.trim()) {
        throw badRequest("name is required and must be a non-empty string");
      }
      if (typeof host !== "string" || !host.trim()) {
        throw badRequest("host is required and must be a non-empty string");
      }
      if (typeof port !== "number" || !Number.isFinite(port) || port < 1) {
        throw badRequest("port is required and must be a number >= 1");
      }
      if (apiKey !== undefined && typeof apiKey !== "string") {
        throw badRequest("apiKey must be a string");
      }

      let normalizedHost = host.trim();
      try {
        const url = new URL(normalizedHost);
        normalizedHost = url.hostname;
      } catch {
        normalizedHost = normalizedHost.replace(/^https?:\/\//, "");
      }
      normalizedHost = normalizedHost.split("/")[0] ?? normalizedHost;

      const normalizedUrl = `http://${normalizedHost}:${port}`;

      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.registerNode({
        name: name.trim(),
        type: "remote",
        url: normalizedUrl,
        apiKey: typeof apiKey === "string" && apiKey.length > 0 ? apiKey : undefined,
      });

      try {
        await central.checkNodeHealth(node.id);
      } catch {
        // Best effort only; registration itself succeeded.
      }

      await central.close();
      res.json(node);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("already exists") ? 409 : (err instanceof Error ? err.message : String(err)).includes("must") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

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

  /**
   * GET /api/tasks/:id/diff
   * Fetch git diff for a task's changes.
   * Query: ?worktree=path
   * Returns: TaskDiff
   */
  router.get("/tasks/:id/diff", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (!task) {
        throw notFound("Task not found");
      }

      // Done tasks: diff from the squash commit's first parent.
      // The merger only performs squash merges, so sha^..sha contains exactly
      // this task's merged changes and excludes unrelated tasks merged in between.
      if (task.column === "done" && task.mergeDetails?.commitSha) {
        const rootDir = scopedStore.getRootDir();
        const sha = task.mergeDetails.commitSha;

        let mergeBase: string | undefined;

        try {
          mergeBase = (await runGitCommand(["rev-parse", `${sha}^`], rootDir, 5000)).trim();
        } catch {
          // Last resort: no diff available
          res.json({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } });
          return;
        }

        const nameStatus = (await runGitCommand(["diff", "--name-status", `${mergeBase}..${sha}`], rootDir, 10000)).trim();

        const doneFiles: Array<{
          path: string;
          status: "added" | "modified" | "deleted";
          additions: number;
          deletions: number;
          patch: string;
        }> = [];

        for (const line of nameStatus.split("\n").filter(Boolean)) {
          const parts = line.split("\t");
          const statusCode = parts[0] ?? "M";
          const filePath = parts[1] ?? "";
          if (!filePath) continue;

          let status: "added" | "modified" | "deleted" = "modified";
          if (statusCode.startsWith("A")) status = "added";
          else if (statusCode.startsWith("D")) status = "deleted";

          let patch = "";
          try {
            patch = await runGitCommand(["diff", `${mergeBase}..${sha}`, "--", filePath], rootDir, 10000);
          } catch { /* ignore */ }

          const additions = (patch.match(/^\+[^+]/gm) || []).length;
          const deletions = (patch.match(/^-[^-]/gm) || []).length;
          doneFiles.push({ path: filePath, status, additions, deletions, patch });
        }

        const doneStats = {
          filesChanged: doneFiles.length,
          additions: doneFiles.reduce((s, f) => s + f.additions, 0),
          deletions: doneFiles.reduce((s, f) => s + f.deletions, 0),
        };

        res.json({ files: doneFiles, stats: doneStats });
        return;
      }

      // Done tasks without a commit SHA: return safe, deterministic response.
      // Do NOT fall through to the worktree-based diff logic, which would use
      // the repo root as cwd and return an inflated repository-wide diff.
      if (task.column === "done") {
        const md = task.mergeDetails;
        res.json({
          files: [],
          stats: {
            filesChanged: md?.filesChanged ?? 0,
            additions: md?.insertions ?? 0,
            deletions: md?.deletions ?? 0,
          },
        });
        return;
      }

      const worktree = typeof req.query.worktree === "string" ? req.query.worktree : undefined;
      const resolvedWorktree = worktree || task.worktree;

      // Check worktree existence asynchronously to avoid blocking event loop
      if (!resolvedWorktree) {
        res.json({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } });
        return;
      }
      let worktreeExists = false;
      try {
        await access(resolvedWorktree);
        worktreeExists = true;
      } catch {
        worktreeExists = false;
      }
      if (!worktreeExists) {
        res.json({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } });
        return;
      }
      const cwd = resolvedWorktree;

      // Use resolveDiffBase for consistent diff base across all endpoints
      const diffBase = await resolveDiffBase(task, cwd);
      const diffRange = diffBase ? `${diffBase}..HEAD` : "HEAD";

      // Get list of changed files — include committed, staged, unstaged, and untracked
      const fileMap = new Map<string, string>();

      if (diffBase) {
        try {
          const committedOutput = (await runGitCommand(["diff", "--name-status", `${diffBase}..HEAD`], cwd, 10000)).trim();
          for (const line of committedOutput.split("\n").filter(Boolean)) {
            const parts = line.split("\t");
            fileMap.set(parts[1] ?? "", parts[0] ?? "M");
          }
        } catch {
          // committed diff failed
        }
      }

      // Staged changes (in git index)
      try {
        const stagedOutput = (await runGitCommand(["diff", "--cached", "--name-status"], cwd, 10000)).trim();
        for (const line of stagedOutput.split("\n").filter(Boolean)) {
          const parts = line.split("\t");
          // Use staged status (don't overwrite committed status)
          const filePath = parts[1] ?? "";
          if (filePath && !fileMap.has(filePath)) {
            fileMap.set(filePath, parts[0] ?? "M");
          }
        }
      } catch {
        // staged diff failed
      }

      try {
        const workingTreeOutput = (await runGitCommand(["diff", "--name-status"], cwd, 10000)).trim();
        for (const line of workingTreeOutput.split("\n").filter(Boolean)) {
          const parts = line.split("\t");
          const filePath = parts[1] ?? "";
          // Unstaged changes only affect files not already in map (to avoid overwrite)
          if (filePath && !fileMap.has(filePath)) {
            fileMap.set(filePath, parts[0] ?? "M");
          }
        }
      } catch {
        // working tree diff failed
      }

      // Untracked files (new files not yet staged)
      try {
        const untrackedOutput = (await runGitCommand(["ls-files", "--others", "--exclude-standard"], cwd, 10000)).trim();
        for (const line of untrackedOutput.split("\n").filter(Boolean)) {
          // Mark as untracked with special status "U" - will be converted to "added"
          fileMap.set(line, "U");
        }
      } catch {
        // untracked listing failed
      }

      const files: Array<{
        path: string;
        status: "added" | "modified" | "deleted";
        additions: number;
        deletions: number;
        patch: string;
      }> = [];

      for (const [filePath, statusCode] of fileMap) {
        if (!filePath) continue;

        let status: "added" | "modified" | "deleted";
        if (statusCode.startsWith("A") || statusCode === "U") status = "added";
        else if (statusCode.startsWith("D")) status = "deleted";
        else status = "modified";

        // Get patch for this file
        let patch = "";
        try {
          // For untracked files, generate synthetic diff against /dev/null
          if (statusCode === "U") {
            patch = await runGitCommand(["diff", "--no-index", "/dev/null", filePath], cwd, 10000).catch(() => "");
          } else {
            patch = await runGitCommand(["diff", diffRange, "--", filePath], cwd, 10000);
          }
        } catch {
          // Ignore errors for individual files
        }

        const additions = (patch.match(/^\+[^+]/gm) || []).length;
        const deletions = (patch.match(/^-[^-]/gm) || []).length;

        files.push({ path: filePath, status, additions, deletions, patch });
      }

      const stats = {
        filesChanged: files.length,
        additions: files.reduce((sum, f) => sum + f.additions, 0),
        deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      };

      res.json({ files, stats });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/tasks/:id/file-diffs
   * Fetch changed files with individual git diffs for a task worktree.
   * Uses the shared resolveDiffBase() helper so the board card count and the
   * changed-files viewer always agree. Prefers task.baseCommitSha when valid,
   * falling back to branch merge-base / HEAD~1.
   * Returns: Array<{ path, status, diff, oldPath? }>
   */
  router.get("/tasks/:id/file-diffs", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);

      // Done tasks: diff from the squash commit's first parent.
      // The merger only performs squash merges, so sha^..sha contains exactly
      // this task's merged changes and excludes unrelated tasks merged in between.
      if (task.column === "done" && task.mergeDetails?.commitSha) {
        const rootDir = scopedStore.getRootDir();
        const sha = task.mergeDetails.commitSha;

        let mergeBase: string | undefined;

        try {
          mergeBase = (await runGitCommand(["rev-parse", `${sha}^`], rootDir, 5000)).trim();
        } catch {
          res.json([]);
          return;
        }

        try {
          const nameStatus = (await runGitCommand(["diff", "--name-status", `${mergeBase}..${sha}`], rootDir, 5000)).trim();
          const doneFiles = [];
          for (const line of nameStatus.split("\n").filter(Boolean)) {
            const parts = line.split("\t");
            const statusCode = parts[0] ?? "M";
            const filePath = parts[1] ?? "";
            let status: "added" | "modified" | "deleted" | "renamed" = "modified";
            if (statusCode.startsWith("A")) status = "added";
            else if (statusCode.startsWith("D")) status = "deleted";
            else if (statusCode.startsWith("R")) status = "renamed";
            let diff = "";
            try {
              diff = await runGitCommand(["diff", `${mergeBase}..${sha}`, "--", filePath], rootDir, 5000);
            } catch { /* ignore */ }
            doneFiles.push({ path: filePath, status, diff });
          }
          res.json(doneFiles);
        } catch {
          res.json([]);
        }
        return;
      }

      // Done tasks without a commit SHA: return safe, empty response.
      // Do NOT fall through to worktree-based logic that could scan the
      // entire repository when the worktree has been cleaned up.
      if (task.column === "done") {
        res.json([]);
        return;
      }

      // Check worktree existence asynchronously to avoid blocking event loop
      if (!task.worktree) {
        res.json([]);
        return;
      }
      let worktreeExists = false;
      try {
        await access(task.worktree);
        worktreeExists = true;
      } catch {
        worktreeExists = false;
      }
      if (!worktreeExists) {
        res.json([]);
        return;
      }
      const worktree = task.worktree; // Capture after check

      const cached = fileDiffsCache.get(task.id);
      if (cached && cached.expiresAt > Date.now()) {
        res.json(cached.files);
        return;
      }

      const cwd = worktree;

      // Resolve a diff base using the shared strategy so both endpoints
      // always agree on which files have changed.  Prefer task-scoped
      // baseCommitSha when it is still valid for the current HEAD.
      const diffBase = await resolveDiffBase(task, cwd);

      // Collect file statuses from committed, staged, unstaged, and untracked changes.
      // Deduplicate by path to match session-files.
      const fileMap = new Map<string, { statusCode: string; oldPath?: string; isUntracked?: boolean }>();

      if (diffBase) {
        try {
          const committedOutput = (await runGitCommand(["diff", "--name-status", `${diffBase}..HEAD`], cwd, 5000)).trim();
          for (const line of committedOutput.split("\n").filter(Boolean)) {
            const parts = line.split("\t");
            const statusCode = parts[0] ?? "M";
            if (statusCode.startsWith("R")) {
              fileMap.set(parts[2] ?? parts[1] ?? "", { statusCode, oldPath: parts[1] });
            } else {
              fileMap.set(parts[1] ?? "", { statusCode });
            }
          }
        } catch {
          // committed diff failed — continue with working-tree only
        }
      }

      // Staged changes (in git index)
      try {
        const stagedOutput = (await runGitCommand(["diff", "--cached", "--name-status"], cwd, 5000)).trim();
        for (const line of stagedOutput.split("\n").filter(Boolean)) {
          const parts = line.split("\t");
          const statusCode = parts[0] ?? "M";
          const filePath = parts[1] ?? "";
          // Only add if not already in map (committed takes precedence)
          if (filePath && !fileMap.has(filePath)) {
            if (statusCode.startsWith("R")) {
              fileMap.set(filePath, { statusCode, oldPath: parts[2] });
            } else {
              fileMap.set(filePath, { statusCode });
            }
          }
        }
      } catch {
        // staged diff failed
      }

      // Unstaged working tree changes
      try {
        const workingTreeOutput = (await runGitCommand(["diff", "--name-status"], cwd, 5000)).trim();
        for (const line of workingTreeOutput.split("\n").filter(Boolean)) {
          const parts = line.split("\t");
          const statusCode = parts[0] ?? "M";
          const filePath = parts[1] ?? "";
          // Only add if not already in map (committed/staged takes precedence)
          if (filePath && !fileMap.has(filePath)) {
            if (statusCode.startsWith("R")) {
              fileMap.set(filePath, { statusCode, oldPath: parts[2] });
            } else {
              fileMap.set(filePath, { statusCode });
            }
          }
        }
      } catch {
        // working tree diff failed
      }

      // Untracked files (new files not yet staged)
      try {
        const untrackedOutput = (await runGitCommand(["ls-files", "--others", "--exclude-standard"], cwd, 5000)).trim();
        for (const line of untrackedOutput.split("\n").filter(Boolean)) {
          // Only add if not already tracked (committed/staged/unstaged)
          if (line && !fileMap.has(line)) {
            fileMap.set(line, { statusCode: "U", isUntracked: true });
          }
        }
      } catch {
        // untracked listing failed
      }

      // Build the result array with per-file diffs using the two-dot range
      // against the resolved merge-base.
      const diffRange = diffBase ? `${diffBase}..HEAD` : "HEAD";

      const files = [];
      for (const [filePath, { statusCode, oldPath, isUntracked }] of fileMap.entries()) {
        let status: "added" | "modified" | "deleted" | "renamed" = "modified";

        if (statusCode.startsWith("A") || statusCode === "U") {
          status = "added";
        } else if (statusCode.startsWith("D")) {
          status = "deleted";
        } else if (statusCode.startsWith("R")) {
          status = "renamed";
        }

        let diff = "";
        try {
          // For untracked files, generate synthetic diff against /dev/null
          if (isUntracked) {
            diff = await runGitCommand(["diff", "--no-index", "/dev/null", filePath], cwd, 5000).catch(() => "");
          } else {
            diff = await runGitCommand(["diff", diffRange, "--", filePath], cwd, 5000);
          }
        } catch {
          diff = "";
        }

        // Skip files with empty diffs (mode-only changes, binary files)
        // BUT keep untracked files which have synthetic diffs
        if (!diff && !isUntracked) {
          continue;
        }

        files.push(oldPath ? { path: filePath, status, diff, oldPath } : { path: filePath, status, diff });
      }

      fileDiffsCache.set(task.id, {
        files,
        expiresAt: Date.now() + 10000,
      });

      res.json(files);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  // Dev server management routes
  const devServerRouter = createDevServerRouter({
    projectRoot: store.getRootDir(),
  });
  router.use("/dev-server", devServerRouter);

  // ── Scripts API ──────────────────────────────────────────────────────────

  /**
   * GET /api/scripts
   * Fetch all saved scripts.
   * Returns: Record<string, string> (name -> command)
   */
  router.get("/scripts", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      res.json(settings.scripts ?? {});
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/scripts
   * Add or update a script.
   * Body: { name: string, command: string }
   * Returns: Record<string, string> (updated scripts)
   */
  router.post("/scripts", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { name, command } = req.body;
      
      if (!name || typeof name !== "string" || !name.trim()) {
        throw badRequest("name is required");
      }
      if (command === undefined || typeof command !== "string") {
        throw badRequest("command is required");
      }
      
      const settings = await scopedStore.getSettings();
      const scripts = {
        ...(settings.scripts ?? {}),
        [name.trim()]: command.trim(),
      };
      await scopedStore.updateSettings({ scripts });
      res.json(scripts);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * DELETE /api/scripts/:name
   * Remove a script.
   * Returns: Record<string, string> (updated scripts)
   */
  router.delete("/scripts/:name", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { name } = req.params;
      const settings = await scopedStore.getSettings();
      const scripts = { ...(settings.scripts ?? {}) };
      delete scripts[name];
      await scopedStore.updateSettings({ scripts });
      res.json(scripts);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Messaging Routes ──────────────────────────────────────────────────

  /** Cache of MessageStore instances keyed by rootDir */
  const messageStoreCache = new Map<string, MessageStore>();

  async function getMessageStore(req: Request): Promise<MessageStore> {
    const { store: scopedStore, engine, projectId } = await getProjectContext(req);
    const rootDir = scopedStore.getRootDir();

    // Prefer the runtime's MessageStore when available so routes and SSE share
    // the same EventEmitter instance (required for live mailbox updates).
    const runtimeMessageStore = engine?.getMessageStore()
      ?? (!projectId ? options?.engine?.getMessageStore() : undefined);
    if (runtimeMessageStore) {
      messageStoreCache.set(rootDir, runtimeMessageStore);
      return runtimeMessageStore;
    }

    let msgStore = messageStoreCache.get(rootDir);
    if (!msgStore) {
      const db = scopedStore.getDatabase();
      msgStore = new MessageStore(db);
      messageStoreCache.set(rootDir, msgStore);
    }
    return msgStore;
  }

  const VALID_MESSAGE_TYPES: MessageType[] = ["agent-to-agent", "agent-to-user", "user-to-agent", "system"];
  const VALID_PARTICIPANT_TYPES: ParticipantType[] = ["agent", "user", "system"];
  const DASHBOARD_USER_ID = "dashboard";

  /**
   * GET /api/messages/inbox
   * Fetch inbox messages for the dashboard user.
   * Query params: limit, offset, unreadOnly, type
   */
  router.get("/messages/inbox", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const filter = {
        limit: parseInt(req.query.limit as string) || 20,
        offset: parseInt(req.query.offset as string) || 0,
        read: req.query.unreadOnly === "true" ? false : undefined,
        type: req.query.type as MessageType | undefined,
      };
      const messages = await msgStore.getInbox(DASHBOARD_USER_ID, "user", filter);
      const mailbox = await msgStore.getMailbox(DASHBOARD_USER_ID, "user");
      res.json({ messages, total: messages.length, unreadCount: mailbox.unreadCount });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/messages/outbox
   * Fetch sent messages for the dashboard user.
   * Query params: limit, offset, type
   */
  router.get("/messages/outbox", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const filter = {
        limit: parseInt(req.query.limit as string) || 20,
        offset: parseInt(req.query.offset as string) || 0,
        type: req.query.type as MessageType | undefined,
      };
      const messages = await msgStore.getOutbox(DASHBOARD_USER_ID, "user", filter);
      res.json({ messages, total: messages.length });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/messages/unread-count
   * Get unread message count (lightweight for header badge).
   */
  router.get("/messages/unread-count", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const mailbox = await msgStore.getMailbox(DASHBOARD_USER_ID, "user");
      res.json({ unreadCount: mailbox.unreadCount });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/messages/read-all
   * Mark all inbox messages as read.
   * IMPORTANT: Must be registered before /messages/:id to avoid path conflicts.
   */
  router.post("/messages/read-all", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const count = await msgStore.markAllAsRead(DASHBOARD_USER_ID, "user");
      res.json({ markedAsRead: count });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/messages
   * Send a new message.
   * Body: { toId, toType, content, type, metadata? }
   */
  router.post("/messages", async (req, res) => {
    try {
      const { toId, toType, content, type, metadata } = req.body;

      // Validate required fields
      if (!toId || typeof toId !== "string") {
        throw badRequest("toId is required");
      }
      if (!toType || !VALID_PARTICIPANT_TYPES.includes(toType)) {
        throw badRequest(`toType must be one of: ${VALID_PARTICIPANT_TYPES.join(", ")}`);
      }
      if (!content || typeof content !== "string" || content.length === 0 || content.length > 2000) {
        throw badRequest("content is required and must be 1-2000 characters");
      }
      if (!type || !VALID_MESSAGE_TYPES.includes(type)) {
        throw badRequest(`type must be one of: ${VALID_MESSAGE_TYPES.join(", ")}`);
      }

      if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))) {
        throw badRequest("metadata must be an object");
      }

      try {
        validateMessageMetadata(metadata);
      } catch (err: unknown) {
        throw badRequest(err instanceof Error ? err.message : "metadata.replyTo is invalid");
      }

      const msgStore = await getMessageStore(req);
      const message = await msgStore.sendMessage({
        fromId: DASHBOARD_USER_ID,
        fromType: "user",
        toId,
        toType,
        content,
        type,
        metadata,
      });
      res.status(201).json(message);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/messages/conversation/:participantType/:participantId
   * Get conversation between dashboard user and a specific participant.
   */
  router.get("/messages/conversation/:participantType/:participantId", async (req, res) => {
    try {
      const { participantType, participantId } = req.params;
      if (!VALID_PARTICIPANT_TYPES.includes(participantType as ParticipantType)) {
        throw badRequest(`participantType must be one of: ${VALID_PARTICIPANT_TYPES.join(", ")}`);
      }

      const msgStore = await getMessageStore(req);
      const messages = await msgStore.getConversation(
        { id: DASHBOARD_USER_ID, type: "user" },
        { id: participantId, type: participantType as ParticipantType },
      );
      res.json(messages);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/messages/:id
   * Fetch a single message.
   */
  router.get("/messages/:id", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const message = await msgStore.getMessage(req.params.id);
      if (!message) {
        throw notFound("Message not found");
      }
      res.json(message);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/messages/:id/read
   * Mark a specific message as read.
   */
  router.post("/messages/:id/read", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const message = await msgStore.markAsRead(req.params.id);
      res.json(message);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * DELETE /api/messages/:id
   * Delete a message.
   */
  router.delete("/messages/:id", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      await msgStore.deleteMessage(req.params.id);
      res.status(204).send();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/mailbox
   * View an agent's mailbox (admin read-only access).
   */
  router.get("/agents/:id/mailbox", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const agentId = req.params.id;
      const mailbox = await msgStore.getMailbox(agentId, "agent");
      const inbox = await msgStore.getInbox(agentId, "agent");
      const outbox = await msgStore.getOutbox(agentId, "agent");
      res.json({ ...mailbox, messages: inbox, inbox, outbox });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

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

  /**
   * GET /api/skills/discovered
   * List all discovered skills with their enabled state.
   * Query: projectId (optional) for multi-project context
   * Response: { skills: DiscoveredSkill[] }
   */
  router.get("/skills/discovered", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const skillsAdapter = options?.skillsAdapter;

      if (!skillsAdapter) {
        res.status(404).json({ error: "Skills adapter not configured", code: "adapter_not_configured" });
        return;
      }

      const rootDir = scopedStore.getRootDir();
      const skills = await skillsAdapter.discoverSkills(rootDir);

      res.json({ skills });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to discover skills");
    }
  });

  /**
   * GET /api/skills/:id/content
   * Read the contents of a skill's SKILL.md file and list supplementary files.
   * Params: id (URL-encoded skill ID)
   * Query: projectId (optional) for multi-project context
   * Response: { content: SkillContent }
   * Error: 404 { error: string; code: "skill_not_found" | "adapter_not_configured" }
   */
  router.get("/skills/:id/content", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const skillsAdapter = options?.skillsAdapter;

      if (!skillsAdapter) {
        res.status(404).json({ error: "Skills adapter not configured", code: "adapter_not_configured" });
        return;
      }

      const encodedSkillId = req.params.id as string;
      let skillId = encodedSkillId;
      try {
        skillId = decodeURIComponent(encodedSkillId);
      } catch {
        res.status(400).json({ error: "Invalid skill ID", code: "invalid_skill_id" });
        return;
      }

      const rootDir = scopedStore.getRootDir();
      const content = await skillsAdapter.readSkillContent(rootDir, skillId);

      res.json({ content });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.message.includes("Skill not found")) {
        res.status(404).json({ error: "Skill not found", code: "skill_not_found" });
        return;
      }
      if (err instanceof Error && err.message.includes("Invalid skill ID")) {
        res.status(400).json({ error: err.message, code: "invalid_skill_id" });
        return;
      }
      rethrowAsApiError(err, "Failed to read skill content");
    }
  });

  /**
   * PATCH /api/skills/execution
   * Toggle a skill's enabled/disabled state.
   * Body: { skillId: string; enabled: boolean }
   * Query: projectId (optional) for multi-project context
   * Response: { success: true; skillId: string; enabled: boolean; persistence: { scope: "project"; targetFile: string; settingsPath: string; pattern: string } }
   */
  router.patch("/skills/execution", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const skillsAdapter = options?.skillsAdapter;

      if (!skillsAdapter) {
        res.status(404).json({ error: "Skills adapter not configured", code: "adapter_not_configured" });
        return;
      }

      const { skillId, enabled } = req.body as { skillId?: string; enabled?: boolean };

      if (!skillId || typeof skillId !== "string") {
        res.status(400).json({ error: "skillId is required", code: "invalid_body" });
        return;
      }

      if (typeof enabled !== "boolean") {
        res.status(400).json({ error: "enabled must be a boolean", code: "invalid_body" });
        return;
      }

      const rootDir = scopedStore.getRootDir();
      const persistence = await skillsAdapter.toggleExecutionSkill(rootDir, { skillId, enabled });

      res.json({
        success: true,
        skillId,
        enabled,
        persistence: {
          scope: "project",
          targetFile: persistence.targetFile,
          settingsPath: persistence.settingsPath,
          pattern: persistence.pattern,
        },
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && (err instanceof Error ? err.message : String(err)).includes("Invalid skill ID")) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err), code: "invalid_skill_id" });
        return;
      }
      if (err instanceof Error && (err instanceof Error ? err.message : String(err)).includes("Skill not found")) {
        res.status(404).json({ error: err instanceof Error ? err.message : String(err), code: "skill_not_found" });
        return;
      }
      rethrowAsApiError(err, "Failed to toggle skill execution");
    }
  });

  /**
   * GET /api/skills/catalog
   * Fetch the skills.sh catalog with optional authentication.
   * Query:
   *   - limit: number (default 20, max 100)
   *   - q: optional search query
   *   - projectId (optional) for multi-project context
   * Response: { entries: CatalogEntry[]; auth: { mode: string; tokenPresent: boolean; fallbackUsed: boolean } }
   * Error: 502 { error: string; code: "upstream_timeout"|"upstream_http_error"|"upstream_invalid_payload" }
   */
  router.get("/skills/catalog", async (req, res) => {
    try {
      const skillsAdapter = options?.skillsAdapter;

      if (!skillsAdapter) {
        res.status(404).json({ error: "Skills adapter not configured", code: "adapter_not_configured" });
        return;
      }

      const limitStr = typeof req.query.limit === "string" ? req.query.limit : "20";
      const limit = Math.min(Math.max(1, parseInt(limitStr, 10) || 20), 100);
      const query = typeof req.query.q === "string" ? req.query.q : undefined;

      const result = await skillsAdapter.fetchCatalog({ limit, query });

      // Check if result is an upstream error
      if ("code" in result) {
        res.status(502).json(result);
        return;
      }

      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to fetch skills catalog");
    }
  });

  // ── Remote Node Proxy Routes ───────────────────────────────────────────

  /** GET /api/proxy/:nodeId/health — Forward health check to remote node */
  router.get("/proxy/:nodeId/health", async function (req, res) {
    try {
      await proxyToRemoteNode(req, res, "/health");
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /** GET /api/proxy/:nodeId/projects — Forward projects list to remote node */
  router.get("/proxy/:nodeId/projects", async function (req, res) {
    try {
      await proxyToRemoteNode(req, res, "/projects");
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /** GET /api/proxy/:nodeId/tasks — Forward tasks list to remote node (forwards projectId, q query params) */
  router.get("/proxy/:nodeId/tasks", async function (req, res) {
    try {
      await proxyToRemoteNode(req, res, "/tasks");
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /** GET /api/proxy/:nodeId/project-health — Forward project health to remote node (forwards projectId query param) */
  router.get("/proxy/:nodeId/project-health", async function (req, res) {
    try {
      await proxyToRemoteNode(req, res, "/project-health");
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/proxy/:nodeId/events — SSE proxy to remote node events stream.
   * Uses a 30-second timeout since SSE connections are long-lived.
   * Handles client disconnect gracefully.
   */
  router.get("/proxy/:nodeId/events", async function (req, res) {
    const nodeId = req.params.nodeId as string;

    const { CentralCore } = await import("@fusion/core");
    const central = new CentralCore(store.getFusionDir());

    try {
      await central.init();

      const node = await central.getNode(nodeId);
      if (!node) {
        res.status(404).json({ error: "Node not found" });
        return;
      }

      if (node.type === "local") {
        res.status(400).json({ error: "Cannot proxy to local node" });
        return;
      }

      if (!node.url) {
        res.status(400).json({ error: "Node has no URL configured" });
        return;
      }

      // Parse query string and build target URL
      const parsedUrl = new URL(req.url, "http://localhost");
      const queryString = parsedUrl.search;
      const targetUrl = new URL(`/api/events${queryString}`, node.url).toString();

      // Build headers, injecting Authorization if apiKey is present
      const headers: Record<string, string> = {};
      if (node.apiKey) {
        headers["Authorization"] = `Bearer ${node.apiKey}`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      const response = await fetch(targetUrl, {
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        res.status(response.status).json({ error: "Remote node events unavailable" });
        return;
      }

      if (!response.body) {
        res.status(502).json({ error: "Remote node unreachable" });
        return;
      }

      // Set SSE headers on Express response
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      res.write(": connected\n\n");

      // Convert web ReadableStream to Node Readable and pipe chunks to client
      const { Readable } = await import("node:stream");
      const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);

      let destroyed = false;

      // Handle client disconnect — abort remote fetch and destroy stream
      req.on("close", () => {
        if (!destroyed) {
          destroyed = true;
          controller.abort();
          nodeStream.destroy();
        }
      });

      nodeStream.on("data", (chunk: Buffer) => {
        if (!res.writableEnded) {
          res.write(chunk);
        }
      });

      nodeStream.on("end", () => {
        if (!res.writableEnded) {
          res.end();
        }
      });

      nodeStream.on("error", (err: Error) => {
        // Log but don't crash — stream may already be closing
        runtimeLogger.child("proxy:sse").error(`Stream error for node ${nodeId}`, {
          error: err.message,
        });
        if (!res.writableEnded) {
          res.end();
        }
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        if (!res.headersSent) {
          res.status(504).json({ error: "Remote node timeout" });
        } else if (!res.writableEnded) {
          res.end();
        }
      } else if (err instanceof TypeError) {
        if (!res.headersSent) {
          res.status(502).json({ error: "Remote node unreachable" });
        } else if (!res.writableEnded) {
          res.end();
        }
      } else {
        runtimeLogger.child("proxy:sse").error(`Unexpected error for node ${nodeId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          if (err instanceof ApiError) {
            throw err;
          }
          rethrowAsApiError(err);
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    } finally {
      await central.close();
    }
  });

  /**
   * Generic wildcard proxy route — forwards any HTTP request to a remote node.
   * Matches /api/proxy/:nodeId/*
   */
  router.all("/proxy/:nodeId/*splat", async (req: Request, res: Response) => {
    const nodeId = req.params.nodeId as string;
    // Splat is an array of path segments (e.g., ["browse-directory", "path"] for /browse-directory/path)
    const splat = req.params.splat as string | string[];
    const remainingPath = Array.isArray(splat) ? splat.join("/") : splat;

    const { CentralCore } = await import("@fusion/core");
    const central = new CentralCore(store.getFusionDir());

    try {
      await central.init();

      const node = await central.getNode(nodeId);
      if (!node) {
        res.status(404).json({ error: "Node not found" });
        return;
      }

      if (!node.url) {
        res.status(400).json({ error: "Node has no URL" });
        return;
      }

      // Build target URL: node.url + remainingPath + queryString
      const parsedUrl = new URL(req.url ?? "/", "http://localhost");
      const queryString = parsedUrl.search;
      const targetPath = `/${remainingPath}${queryString}`;
      const targetUrl = new URL(targetPath, node.url).toString();

      // Build headers
      const headers: Record<string, string> = {};
      // Forward Content-Type if present
      if (typeof req.headers['content-type'] === "string") {
        headers['Content-Type'] = req.headers['content-type'];
      }
      // Inject Authorization if apiKey is present
      if (node.apiKey) {
        headers['Authorization'] = `Bearer ${node.apiKey}`;
      }

      // Collect request body for non-GET/HEAD methods
      let body: Buffer | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const chunks: Buffer[] = [];
        // Check if body was already collected (e.g., by multer or raw body middleware)
        if (req.rawBody && req.rawBody.length > 0) {
          body = req.rawBody;
        } else {
          await new Promise<void>((resolve, reject) => {
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", resolve);
            req.on("error", reject);
          });
          if (chunks.length > 0) {
            body = Buffer.concat(chunks);
          }
        }
      }

      const response = await fetch(targetUrl, {
        method: req.method,
        headers,
        // TypeScript is strict about BodyInit types; Buffer is binary-safe but not in the type definition
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        body: body as any,
        signal: AbortSignal.timeout(30_000),
      });

      // Filter hop-by-hop headers
      const hopByHopHeaders = new Set([
        "connection",
        "keep-alive",
        "transfer-encoding",
        "upgrade",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
      ]);

      response.headers.forEach((value, key) => {
        if (!hopByHopHeaders.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });

      res.status(response.status);

      if (!response.body) {
        res.end();
        return;
      }

      const { Readable } = await import("node:stream");
      const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);

      nodeStream.on("data", (chunk: Buffer) => {
        res.write(chunk);
      });

      nodeStream.on("end", () => {
        res.end();
      });

      nodeStream.on("error", (err: Error) => {
        proxyLogger.error(`Stream error for node ${nodeId}`, {
          error: err.message,
        });
        if (!res.writableEnded) {
          res.end();
        }
      });
    } catch (err: unknown) {
      if (res.headersSent) {
        return;
      }
      // Check for AbortError by name property (works for both native Error and jsdom DOMException)
      const errorObj = err as { name?: string } | null;
      const isAbortError = errorObj?.name === "AbortError";
      if (isAbortError) {
        res.status(504).json({ error: "Gateway Timeout" });
      } else if (err instanceof TypeError) {
        res.status(502).json({ error: "Bad Gateway" });
      } else {
        proxyLogger.error(`Unexpected error for node ${nodeId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(502).json({ error: "Bad Gateway" });
      }
    } finally {
      await central.close();
    }
  });

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

      // When the user has opted to route AI through pi-claude-cli, only
      // Anthropic Claude models are reachable — pi-claude-cli wraps the
      // local Claude CLI and does not bridge other providers. Surface only
      // those models so every picker in the app (settings, onboarding, per
      // lane overrides) stays honest about what'll actually run.
      // OpenRouter-proxied Claude (provider: "openrouter") is excluded on
      // purpose: it hits OpenRouter's API, not the local CLI.
      if (useClaudeCli) {
        models = models.filter((m) => m.provider === "anthropic");
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
        // Pi extension registrations can't be added/removed mid-process,
        // so flipping on/off requires a restart for the model routing
        // itself to take effect. Skill install/backfill happens
        // immediately either way. Surface this so the UI can show a
        // "Restart Fusion to activate" prompt when next !== prev.
        restartRequired: prev !== next,
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
