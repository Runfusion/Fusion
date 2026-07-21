import type { SubtaskItem, PlanningSubtaskDraft } from "./ai-text.js";
import type { Agent, AgentCapability, AgentStats, OrgTreeNode } from "@fusion/core";
import type {
  Task,
  TaskDetail,
  TaskReviewData,
  AgentLogEntry,
  GlobalSettings,
  ProjectSettings,
  BatchStatusResult,
  BatchStatusResponse,
  PrConflictDiagnostics,
  PrInfo,
  CommitAssociationDiffBackfillReport,
} from "@fusion/core";
// Consumers import backfill report types from the legacy API barrel.
export type { CommitAssociationDiffBackfillReport };
import type {
  PlanningQuestion,
  PlanningSummary,
} from "@fusion/core";
import type { MissionInterviewDraftSummary } from "../components/mission-types";
import { withTokenHeader } from "../auth";
import { dedupe } from "./dedupe";

/* FNXC:DashboardApi 2026-07-15-13:25: Preserve the legacy API barrel while consumers migrate to focused modules. */
export {
  api,
  ApiRequestError,
  buildApiUrl,
  withNodeId,
  proxyApi,
} from "./client.js";
export type { FetchOptions } from "./client.js";
export {
  fetchDashboardHealth,
  refreshDashboardHealth,
  fetchEngineStatus,
  startEngine,
  checkForUpdates,
  withProjectId,
} from "./health.js";
import type {
  DashboardHealthResponse,
  EngineStatusResponse,
  UpdateCheckResponse,
} from "./health.js";
export type {
  DashboardHealthResponse,
  EngineStatusResponse,
  UpdateCheckResponse,
};

export {
  fetchTasks,
  fetchArchivedTasks,
  fetchTaskDetail,
  fetchTaskRuntimeFallback,
  checkDuplicateTasks,
  createTask,
  repairOverlapBlocker,
  updateTask,
  batchUpdateTaskModels,
  moveTask,
  DuplicateCandidatesError,
} from "./tasks.js";
import type {
  DeleteTaskOptions,
  ArchiveTaskOptions,
  TaskRuntimeFallbackResponse,
  UpdateTaskReviewRequest,
  TaskReviewResponse,
  RefreshTaskReviewResponse,
  SelectedReviewItem,
  ReviseTaskReviewResponse,
  AddressPrFeedbackResponse,
  DuplicateMatch,
  CreateTaskRequestOptions,
  BranchSelectionInput,
  CreateTaskInput,
  RepairOverlapBlockerResult,
} from "./tasks.js";
export type {
  DeleteTaskOptions,
  ArchiveTaskOptions,
  TaskRuntimeFallbackResponse,
  UpdateTaskReviewRequest,
  TaskReviewResponse,
  RefreshTaskReviewResponse,
  SelectedReviewItem,
  ReviseTaskReviewResponse,
  AddressPrFeedbackResponse,
  DuplicateMatch,
  CreateTaskRequestOptions,
  BranchSelectionInput,
  CreateTaskInput,
  RepairOverlapBlockerResult,
};

/*
 * FNXC:CodeOrganization 2026-07-16-12:00:
 * Preserve legacy task-lifecycle imports while implementations live in
 * tasks-lifecycle.ts.
 */
export {
  promoteTask,
  deleteTask,
  mergeTask,
  apiListBranchGroups,
  apiGetBranchGroup,
  apiAssignTaskBranchGroup,
  apiPromoteBranchGroup,
  apiAbandonBranchGroup,
  retryTask,
  bypassReview,
  relaunchCliSession,
  recoverBranchBinding,
  resetTask,
  duplicateTask,
  pauseTask,
  unpauseTask,
  nudgeOverseer,
  stopOverseer,
  explainOverseer,
  fetchPlannerInterventionTimeline,
  archiveTask,
  unarchiveTask,
  revertTask,
  archiveAllDone,
  approvePlan,
  rejectPlan,
} from "./tasks-lifecycle.js";
export type {
  BranchGroupMemberSummary,
  BranchGroupSummary,
  PromoteBranchGroupResult,
  RecoverBranchBindingOutcome,
  OverseerControlResult,
  RevertTaskWorkspaceRepoResult,
  RevertTaskGitResult,
  RevertTaskAiResult,
  RevertTaskResult,
  RevertTaskOptions,
} from "./tasks-lifecycle.js";

export {
  fetchConfig,
  fetchSettings,
  fetchTaskEffectiveSettings,
  updateSettings,
  checkForUpdate,
  refreshUpdateCheck,
  installUpdate,
} from "./settings.js";
export type { UpdateInstallResponse } from "./settings.js";

/*
 * FNXC:CodeOrganization 2026-07-17-12:00:
 * Preserve legacy global/pi settings and task-content imports via satellites.
 */
export {
  fetchGlobalSettings,
  updateGlobalSettings,
  fetchSettingsByScope,
  fetchPiExtensions,
  updatePiExtensions,
  testNotification,
  testNtfyNotification,
  fetchPiSettings,
  updatePiSettings,
  installPiPackage,
  reinstallFusionPiPackage,
} from "./global-and-pi-settings.js";
export type {
  PiExtensionEntry,
  PiExtensionSettings,
  PiSettings,
} from "./global-and-pi-settings.js";

export {
  uploadAttachment,
  deleteAttachment,
  fetchAgentLogs,
  fetchAgentLogsWithMeta,
  fetchSessionFiles,
  fetchTaskVerificationRequest,
  fetchTaskComments,
  addTaskComment,
  updateTaskComment,
  deleteTaskComment,
  fetchTaskDocuments,
  fetchTaskDocument,
  fetchTaskDocumentRevisions,
  fetchArtifacts,
  artifactMediaUrl,
  artifactMediaUrlWithToken,
  fetchArtifact,
  fetchNativeStructurePreview,
  updateArtifact,
  fetchAllDocuments,
  fetchProjectMarkdownFiles,
  putTaskDocument,
  deleteTaskDocument,
} from "./task-content.js";
export type {
  FetchAllDocumentsOptions,
  MarkdownFileEntry,
  MarkdownFileListResponse,
  FetchArtifactsOptions,
  FetchProjectMarkdownFilesOptions,
  UpdateArtifactInput,
} from "./task-content.js";
// Artifact types still re-exported from core for callers of legacy barrel
export type { Artifact, ArtifactType, ArtifactWithTask } from "@fusion/core";


/*
 * FNXC:CodeOrganization 2026-07-16-20:00:
 * Preserve legacy board/remote/memory imports while implementations live in satellites.
 */
export {
  updateTaskCustomFields,
  fetchBoardWorkflows,
} from "./board-workflows.js";
export type {
  BoardWorkflowColumnFlags,
  BoardWorkflowColumn,
  BoardWorkflowDefinition,
  BoardWorkflowsPayload,
  CustomFieldRejection,
  WorkflowFieldDefinition,
  WorkflowFieldType,
  WorkflowFieldOption,
  WorkflowFieldRender,
  WorkflowSettingDefinition,
  WorkflowSettingType,
  WorkflowSettingOption,
  WorkflowSettingRender,
  WorkflowSettingRejection,
} from "./board-workflows.js";

export {
  fetchRemoteSettings,
  updateRemoteSettings,
  fetchRemoteStatus,
  installCloudflared,
  activateRemoteProvider,
  startRemoteTunnel,
  stopRemoteTunnel,
  killExternalTunnel,
  regenerateRemotePersistentToken,
  generateShortLivedRemoteToken,
  fetchRemoteUrl,
  fetchRemoteQr,
} from "./remote.js";
export type {
  RemoteSettings,
  RemoteStatus,
} from "./remote.js";

export {
  fetchMemory,
  saveMemory,
  fetchMemoryFiles,
  fetchMemoryFile,
  saveMemoryFile,
  compactMemory,
  triggerMemoryDreams,
  fetchMemoryInsights,
  saveMemoryInsights,
  triggerInsightExtraction,
  fetchMemoryAudit,
  fetchMemoryStats,
  fetchMemoryBackendStatus,
  installQmd,
  testMemoryRetrieval,
} from "./memory.js";
export type {
  MemoryFileInfo,
  MemoryAuditReport,
  MemoryBackendCapabilities,
  MemoryBackendStatus,
  MemorySearchResult,
  MemoryRetrievalTestResult,
  QmdInstallResult,
} from "./memory.js";

import { api, buildApiUrl } from "./client.js";
import type { FetchOptions } from "./client.js";
import { withProjectId } from "./health.js";

// Import + re-export skills types so legacy monofile bodies can reference them
// while hooks/components keep stable import paths via this barrel.
import type {
  DiscoveredSkill,
  CatalogEntry,
  CatalogFetchResult,
  ToggleSkillResult,
  SkillContent,
  SkillFileEntry,
  SkillFileContent,
} from "@fusion/dashboard";
export type {
  DiscoveredSkill,
  CatalogEntry,
  CatalogFetchResult,
  ToggleSkillResult,
  SkillContent,
  SkillFileEntry,
  SkillFileContent,
};

export function addSteeringComment(id: string, text: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/steer`, projectId), {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export function requestSpecRevision(id: string, feedback: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/spec/revise`, projectId), {
    method: "POST",
    body: JSON.stringify({ feedback }),
  });
}

export function rebuildTaskSpec(id: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/spec/rebuild`, projectId), {
    method: "POST",
  });
}

export function refineTask(id: string, feedback: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/refine`, projectId), {
    method: "POST",
    body: JSON.stringify({ feedback }),
  });
}

function withRepoPath(path: string, repoPath?: string): string {
  if (!repoPath) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}repoPath=${encodeURIComponent(repoPath)}`;
}

// --- Models API ---

/** Available AI model info returned by the models endpoint */
export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
}

/** Response from the models endpoint */
export interface ModelsResponse {
  models: ModelInfo[];
  favoriteProviders: string[];
  favoriteModels: string[];
  defaultProvider?: string;
  defaultModelId?: string;
  resolvedPlanningProvider?: string;
  resolvedPlanningModelId?: string;
}

/** Fetch available AI models from the model registry along with favoriteProviders */
export function fetchModels(): Promise<ModelsResponse> {
  return api<ModelsResponse>("/models");
}

// --- Usage API ---

/** Pace information for weekly usage windows */
export interface UsagePace {
  status: "ahead" | "on-track" | "behind";
  percentElapsed: number; // 0-100, how much of the window time has passed
  message: string; // e.g., "Using 15% over your limit pace"
}

/** Usage window for a provider (e.g., "Session (5h)", "Weekly") */
export interface UsageWindow {
  label: string;
  percentUsed: number; // 0-100
  percentLeft: number; // 0-100
  resetText: string | null; // e.g., "resets in 2h"
  resetMs?: number; // ms until reset
  resetAt?: string; // ISO 8601 timestamp of when the window resets (machine-readable)
  windowDurationMs?: number; // total window length
  pace?: UsagePace; // pace indicator for weekly windows
}

/** Provider usage data */
export interface ProviderUsage {
  name: string;
  icon: string; // emoji
  status: "ok" | "error" | "no-auth";
  error?: string;
  plan?: string | null;
  email?: string | null;
  windows: UsageWindow[];
}

/** Fetch usage data from all configured AI providers */
export function fetchUsageData(): Promise<{ providers: ProviderUsage[] }> {
  return api<{ providers: ProviderUsage[] }>("/usage");
}

// --- Auth API ---

/** OAuth provider with current authentication status */
export interface AuthProvider {
  id: string;
  name: string;
  authenticated: boolean;
  /** True when the server currently has an active OAuth login flow for this provider. */
  loginInProgress?: boolean;
  /** True when an OAuth credential is stored locally but its expires timestamp is in the past — prompt the user to re-login. */
  expired?: boolean;
  /** True when the redirect cannot reach this dashboard host and the user must paste the URL/code back manually. */
  requiresManualCode?: boolean;
  /**
   * Reason the most recent background OAuth login attempt failed, if any.
   * Interactive logins resolve the auth URL immediately and finish in the
   * background; when that background flow rejects (bad/expired code, token
   * exchange rejection, redirect_uri mismatch) this carries the cause so the
   * UI can show why login failed instead of a generic error. Cleared when a
   * fresh login for the provider starts.
   */
  loginError?: string;
  /**
   * How this provider authenticates / is activated.
   * - "oauth": OAuth flow (user clicks Login → redirect)
   * - "api_key": API key stored locally
   * - "cli": a locally-installed CLI binary is the backing transport
   *   (e.g. the synthetic `claude-cli` provider). Cards should render a
   *   one-click Enable/Disable + Test button rather than login/key inputs.
   */
  type?: "oauth" | "api_key" | "cli";
  /** Masked hint of the stored API key (first 3 + bullets + last 4 chars) */
  keyHint?: string;
}

export interface ManualOAuthCodeInfo {
  prompt: string;
  placeholder?: string;
  helpText?: string;
}

export interface OAuthDeviceCodeInfo {
  userCode: string;
  verificationUri: string;
}

/**
 * Snapshot of the Claude-CLI-via-pi health state. Powers the
 * "Anthropic — via Claude CLI" provider card.
 */
export interface ClaudeCliStatus {
  binary: {
    available: boolean;
    version?: string;
    binaryPath?: string;
    reason?: string;
    probeDurationMs: number;
  };
  enabled: boolean;
  extension: {
    status: "ok" | "not-installed" | "missing-entry" | "error";
    path?: string;
    packageVersion?: string;
    reason?: string;
  } | null;
  ready: boolean;
  /** Route A ACP transport state (Claude CLI via the claude-code-cli-acp bridge). */
  acp?: {
    /** experimentalFeatures.claudeCliAcp (default ON). */
    enabled: boolean;
    /** The acp-runtime plugin published a bundled bridge path. */
    bridgeAvailable: boolean;
    /** Claude CLI is actually routing through the bridge (enabled + flag + bridge). */
    active: boolean;
    /** The bridged `claude` returned "Not logged in" — needs fallback or re-auth (R17). */
    authFailed: boolean;
    authReason?: string;
  };
}

export interface DroidCliStatus {
  binary: {
    available: boolean;
    version?: string;
    binaryPath?: string;
    reason?: string;
    probeDurationMs: number;
  };
  enabled: boolean;
  extension: {
    status: "ok" | "not-installed" | "missing-entry" | "error";
    path?: string;
    packageVersion?: string;
    reason?: string;
  } | null;
  ready: boolean;
}

export interface CursorCliStatus {
  binary: {
    available: boolean;
    version?: string;
    binaryPath?: string;
    configuredBinaryPath?: string;
    usingConfiguredBinaryPath?: boolean;
    diagnostics?: string[];
    reason?: string;
    probeDurationMs: number;
  };
  enabled: boolean;
  binaryPath?: string;
  extension: null;
  ready: boolean;
}

export interface GrokCliStatus {
  binary: {
    available: boolean;
    /** FNXC:GrokCli 2026-07-09-00:00: FN-7716 — "ready" (binary available), not "key present"; the grok CLI owns auth. */
    authenticated?: boolean;
    /** FNXC:GrokCli 2026-07-09-00:00: FN-7716 — non-blocking informational hint that Fusion detected a Grok API key. Never gates readiness. */
    apiKeyDetected?: boolean;
    version?: string;
    binaryPath?: string;
    configuredBinaryPath?: string;
    usingConfiguredBinaryPath?: boolean;
    diagnostics?: string[];
    reason?: string;
    probeDurationMs: number;
  };
  enabled: boolean;
  binaryPath?: string;
  extension: null;
  ready: boolean;
}

/*
FNXC:OmpAcp 2026-07-13-22:50:
Status shape for Settings → Oh My Pi (omp) ACP card. ready = enabled + binary available; auth under ~/.omp.
*/
export interface OmpCliStatus {
  binary: {
    available: boolean;
    authenticated?: boolean;
    version?: string;
    binaryPath?: string;
    configuredBinaryPath?: string;
    usingConfiguredBinaryPath?: boolean;
    diagnostics?: string[];
    reason?: string;
    probeDurationMs: number;
  };
  enabled: boolean;
  binaryPath?: string;
  extension: null;
  ready: boolean;
}

export interface LlamaCppStatus {
  enabled: boolean;
  extension: {
    status: "ok" | "not-installed" | "missing-entry" | "error";
    path?: string;
    packageVersion?: string;
    reason?: string;
  } | null;
  ready: boolean;
  server: {
    available: boolean;
    url: string;
    hasApiKey: boolean;
    reason?: string;
  };
}

/** Probe the local Claude CLI binary + setting + extension state. */
export function fetchClaudeCliStatus(): Promise<ClaudeCliStatus> {
  return api<ClaudeCliStatus>("/providers/claude-cli/status");
}

/**
 * Status snapshot for the Fusion CLI binary (`fn` / `fusion`). Used by
 * Settings → General → CLI Binary and the first-launch banner.
 */
export interface FnBinaryStatus {
  binary: {
    installed: boolean;
    binary?: "fn" | "fusion";
    path?: string;
    version?: string;
    invocation: string;
  };
  expectedVersion: string;
  state: "installed" | "missing" | "version-mismatch" | "skipped";
  install: { npm: string; curl: string; package: string };
}

export interface FnBinaryInstallResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  command: string;
  durationMs: number;
  permissionsHint?: string;
}

export interface FnBinaryInstallResponse extends FnBinaryStatus {
  installResult: FnBinaryInstallResult;
}

/** Read CLI binary install state. */
export function fetchFnBinaryStatus(): Promise<FnBinaryStatus> {
  return api<FnBinaryStatus>("/system/fn-binary/status");
}

/** Trigger `npm install -g runfusion.ai`. Returns install log + new status. */
export function installFnBinary(): Promise<FnBinaryInstallResponse> {
  return api<FnBinaryInstallResponse>("/system/fn-binary/install", { method: "POST" });
}

/** Probe the local Droid CLI binary + setting + extension state. */
export function fetchDroidCliStatus(): Promise<DroidCliStatus> {
  return api<DroidCliStatus>("/providers/droid-cli/status");
}

export function fetchCursorCliStatus(): Promise<CursorCliStatus> {
  return api<CursorCliStatus>("/providers/cursor-cli/status");
}

export function fetchGrokCliStatus(): Promise<GrokCliStatus> {
  return api<GrokCliStatus>("/providers/grok-cli/status");
}

export function fetchOmpCliStatus(): Promise<OmpCliStatus> {
  return api<OmpCliStatus>("/providers/omp-cli/status");
}

/** Probe llama.cpp server + setting + extension state. */
export function fetchLlamaCppStatus(): Promise<LlamaCppStatus> {
  return api<LlamaCppStatus>("/providers/llama-cpp/status");
}

// --- Runtime Provider Status Types ---

export interface RuntimeBinaryStatus {
  available: boolean;
  binaryPath?: string;
  version?: string;
  reason?: string;
  probeDurationMs: number;
}

export interface PaperclipConnectionStatus {
  available: boolean;
  apiUrl: string;
  identity?: {
    agentId: string;
    agentName: string;
    role?: string;
    companyId: string;
    companyName?: string;
  };
  reason?: string;
  probeDurationMs: number;
}

export interface HermesProviderStatus {
  binary: RuntimeBinaryStatus;
  ready: boolean;
}

export interface OpenClawProviderStatus {
  binary: RuntimeBinaryStatus;
  ready: boolean;
}

export interface PaperclipProviderStatus {
  connection: PaperclipConnectionStatus;
  ready: boolean;
}

/** Probe the local Hermes binary. */
export async function fetchHermesStatus(opts?: {
  binaryPath?: string;
}): Promise<HermesProviderStatus> {
  const qs = opts?.binaryPath
    ? `?binaryPath=${encodeURIComponent(opts.binaryPath)}`
    : "";
  return api<HermesProviderStatus>(`/providers/hermes/status${qs}`);
}

export interface HermesProfileSummary {
  name: string;
  model?: string;
  gateway?: string;
  alias?: string;
  isDefault: boolean;
}

/** List Hermes profiles from `hermes profile list`. Returns empty array on error. */
export async function fetchHermesProfiles(opts?: {
  binaryPath?: string;
}): Promise<HermesProfileSummary[]> {
  const qs = opts?.binaryPath ? `?binaryPath=${encodeURIComponent(opts.binaryPath)}` : "";
  const r = await api<{ profiles: HermesProfileSummary[]; error?: string }>(
    `/providers/hermes/profiles${qs}`,
  );
  return r.profiles ?? [];
}

/** Probe the local OpenClaw binary. */
export async function fetchOpenClawStatus(opts?: {
  binaryPath?: string;
}): Promise<OpenClawProviderStatus> {
  const qs = opts?.binaryPath
    ? `?binaryPath=${encodeURIComponent(opts.binaryPath)}`
    : "";
  return api<OpenClawProviderStatus>(`/providers/openclaw/status${qs}`);
}

/** Probe the Paperclip API connection. */
export async function fetchPaperclipStatus(opts: {
  apiUrl: string;
  apiKey?: string;
}): Promise<PaperclipProviderStatus> {
  const params = new URLSearchParams({ apiUrl: opts.apiUrl });
  if (opts.apiKey) params.set("apiKey", opts.apiKey);
  return api<PaperclipProviderStatus>(
    `/providers/paperclip/status?${params.toString()}`,
  );
}

export interface PaperclipCompanySummary {
  id: string;
  name: string;
  urlKey?: string;
}

export interface PaperclipAgentSummary {
  id: string;
  name: string;
  role?: string;
  companyId: string;
  status?: string;
  isCurrent?: boolean;
}

export interface PaperclipCliDiscoverySuccess {
  ok: true;
  apiUrl: string;
  apiKey?: string;
  configPath: string;
  deploymentMode?: string;
}

export interface PaperclipCliDiscoveryFailure {
  ok: false;
  reason: string;
  configPath?: string;
}

export type PaperclipCliDiscoveryResult =
  | PaperclipCliDiscoverySuccess
  | PaperclipCliDiscoveryFailure;

/** List Paperclip companies visible to the bearer. Empty array on failure. */
export async function fetchPaperclipCompanies(opts: {
  apiUrl: string;
  apiKey?: string;
}): Promise<PaperclipCompanySummary[]> {
  const params = new URLSearchParams({ apiUrl: opts.apiUrl });
  if (opts.apiKey) params.set("apiKey", opts.apiKey);
  const r = await api<{ companies: PaperclipCompanySummary[] }>(
    `/providers/paperclip/companies?${params.toString()}`,
  );
  return r.companies ?? [];
}

/** List agents in a Paperclip company. Empty array on failure. */
export async function fetchPaperclipAgents(opts: {
  apiUrl: string;
  apiKey?: string;
  companyId: string;
}): Promise<PaperclipAgentSummary[]> {
  const params = new URLSearchParams({
    apiUrl: opts.apiUrl,
    companyId: opts.companyId,
  });
  if (opts.apiKey) params.set("apiKey", opts.apiKey);
  const r = await api<{ agents: PaperclipAgentSummary[] }>(
    `/providers/paperclip/agents?${params.toString()}`,
  );
  return r.agents ?? [];
}

export interface PaperclipMintKeyRequest {
  cliBinaryPath?: string;
  agentRef: string;
  /** Required by paperclipai agent local-cli (`-C/--company-id`). */
  companyId: string;
  keyName?: string;
  configPath?: string;
  dataDir?: string;
}
export type PaperclipMintKeyResult =
  | { ok: true; key: { apiKey: string; apiBase?: string; agentId?: string; companyId?: string } }
  | { ok: false; reason: string };

/**
 * Mints a Paperclip agent API key via the local `paperclipai` CLI.
 * Always resolves (never rejects); on failure the result has `ok: false`.
 */
export async function mintPaperclipApiKey(
  body: PaperclipMintKeyRequest,
): Promise<PaperclipMintKeyResult> {
  return api<PaperclipMintKeyResult>(`/providers/paperclip/cli-mint-key`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Probe Paperclip via the local `paperclipai` CLI (Local CLI tab). Carries the
 * user's onboarded CLI context (profile / api-base / api-key) instead of having
 * the dashboard server make the HTTP call directly.
 */
export async function fetchPaperclipCliStatus(opts: {
  cliBinaryPath?: string;
  cliConfigPath?: string;
}): Promise<PaperclipProviderStatus> {
  const params = new URLSearchParams();
  if (opts.cliBinaryPath) params.set("cliBinaryPath", opts.cliBinaryPath);
  if (opts.cliConfigPath) params.set("cliConfigPath", opts.cliConfigPath);
  const qs = params.toString();
  return api<PaperclipProviderStatus>(
    `/providers/paperclip/cli-status${qs ? `?${qs}` : ""}`,
  );
}

/** List companies via `paperclipai company list --json`. Empty array on failure. */
export async function fetchPaperclipCliCompanies(opts: {
  cliBinaryPath?: string;
  cliConfigPath?: string;
}): Promise<PaperclipCompanySummary[]> {
  const params = new URLSearchParams();
  if (opts.cliBinaryPath) params.set("cliBinaryPath", opts.cliBinaryPath);
  if (opts.cliConfigPath) params.set("cliConfigPath", opts.cliConfigPath);
  const qs = params.toString();
  const r = await api<{ companies: PaperclipCompanySummary[] }>(
    `/providers/paperclip/cli-companies${qs ? `?${qs}` : ""}`,
  );
  return r.companies ?? [];
}

/** List agents in a company via `paperclipai agent list -C <id> --json`. */
export async function fetchPaperclipCliAgents(opts: {
  cliBinaryPath?: string;
  cliConfigPath?: string;
  companyId: string;
}): Promise<PaperclipAgentSummary[]> {
  const params = new URLSearchParams({ companyId: opts.companyId });
  if (opts.cliBinaryPath) params.set("cliBinaryPath", opts.cliBinaryPath);
  if (opts.cliConfigPath) params.set("cliConfigPath", opts.cliConfigPath);
  const r = await api<{ agents: PaperclipAgentSummary[] }>(
    `/providers/paperclip/cli-agents?${params.toString()}`,
  );
  return r.agents ?? [];
}

/** Read the local paperclipai config to discover apiUrl + deploymentMode. */
export async function fetchPaperclipCliDiscovery(opts: {
  cliConfigPath?: string;
} = {}): Promise<PaperclipCliDiscoveryResult> {
  const params = new URLSearchParams();
  if (opts.cliConfigPath) params.set("cliConfigPath", opts.cliConfigPath);
  const qs = params.toString();
  return api<PaperclipCliDiscoveryResult>(
    `/providers/paperclip/cli-discovery${qs ? `?${qs}` : ""}`,
  );
}

/** Enable or disable the Claude CLI provider. Refuses enable if binary is missing. */
export function setClaudeCliEnabled(
  enabled: boolean,
): Promise<{ enabled: boolean; restartRequired: boolean }> {
  return api<{ enabled: boolean; restartRequired: boolean }>("/auth/claude-cli", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

/** Enable or disable the Droid CLI provider. Refuses enable if binary is missing. */
export function setDroidCliEnabled(
  enabled: boolean,
): Promise<{ enabled: boolean; restartRequired: boolean }> {
  return api<{ enabled: boolean; restartRequired: boolean }>("/auth/droid-cli", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export function setCursorCliEnabled(
  enabled: boolean,
): Promise<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }> {
  return api<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }>("/auth/cursor-cli", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export function setCursorCliBinaryPath(
  binaryPath: string | null,
): Promise<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }> {
  return api<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }>("/auth/cursor-cli", {
    method: "POST",
    body: JSON.stringify({ binaryPath }),
  });
}

export function setGrokCliEnabled(
  enabled: boolean,
): Promise<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }> {
  return api<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }>("/auth/grok-cli", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export function setGrokCliBinaryPath(
  binaryPath: string | null,
): Promise<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }> {
  return api<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }>("/auth/grok-cli", {
    method: "POST",
    body: JSON.stringify({ binaryPath }),
  });
}

/*
FNXC:OmpAcp 2026-07-13-22:50:
Client helpers for Oh My Pi ACP enable + binary path (mirror Grok/Cursor).
*/
export function setOmpCliEnabled(
  enabled: boolean,
): Promise<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }> {
  return api<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }>("/auth/omp-cli", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export function setOmpCliBinaryPath(
  binaryPath: string | null,
): Promise<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }> {
  return api<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }>("/auth/omp-cli", {
    method: "POST",
    body: JSON.stringify({ binaryPath }),
  });
}

/** Enable or disable the llama.cpp provider. */
export function setLlamaCppEnabled(
  enabled: boolean,
): Promise<{ enabled: boolean; restartRequired: boolean }> {
  return api<{ enabled: boolean; restartRequired: boolean }>("/auth/llama-cpp", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export interface CustomProvider {
  id: string;
  name: string;
  apiType: "openai-compatible" | "anthropic-compatible" | "google-generative-ai" | "openai-responses";
  baseUrl: string;
  apiKey?: string;
  /**
   * FNXC:ProviderAuth 2026-07-08-00:00:
   * FN-7689: dashboard-local mirror of @fusion/core's CustomProvider.anthropicPromptCaching
   * opt-in. Keep in sync with packages/core/src/types.ts.
   */
  anthropicPromptCaching?: boolean;
  models?: { id: string; name: string }[];
}

export async function fetchCustomProviders(): Promise<CustomProviderConfig[] & { providers: CustomProviderConfig[] }> {
  const providers = await api<CustomProvider[]>("/custom-providers");
  const legacyProviders = providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    api: provider.apiType === "anthropic-compatible" ? "anthropic-messages"
      : provider.apiType === "google-generative-ai" ? "google-generative-ai"
      : provider.apiType === "openai-responses" ? "openai-responses"
      : "openai-completions",
    apiKey: provider.apiKey,
    anthropicPromptCaching: provider.anthropicPromptCaching,
    models: (provider.models ?? []).map((model) => ({ id: model.id, name: model.name })),
  } satisfies CustomProviderConfig));
  return Object.assign(legacyProviders, { providers: legacyProviders });
}

export function addCustomProvider(provider: Omit<CustomProvider, "id">): Promise<CustomProvider> {
  return api<CustomProvider>("/custom-providers", {
    method: "POST",
    body: JSON.stringify(provider),
  });
}

export function updateCustomProvider(
  id: string,
  updates: Partial<Omit<CustomProvider, "id">> | CustomProviderConfig,
): Promise<CustomProvider> {
  const legacy = updates as Partial<CustomProviderConfig>;
  const normalized: Partial<Omit<CustomProvider, "id">> = {
    ...(typeof legacy.name === "string" ? { name: legacy.name } : {}),
    ...(typeof legacy.baseUrl === "string" ? { baseUrl: legacy.baseUrl } : {}),
    ...(typeof legacy.apiKey === "string" ? { apiKey: legacy.apiKey } : {}),
    ...("anthropicPromptCaching" in (updates as Record<string, unknown>)
      ? { anthropicPromptCaching: (updates as Partial<Omit<CustomProvider, "id">>).anthropicPromptCaching }
      : {}),
    ...(Array.isArray(legacy.models)
      ? {
          models: legacy.models.map((model) => ({
            id: model.id,
            name: model.name ?? model.id,
          })),
        }
      : {}),
    ...(legacy.api
      ? {
          apiType: legacy.api === "anthropic-messages" ? "anthropic-compatible"
            : legacy.api === "google-generative-ai" ? "google-generative-ai"
            : legacy.api === "openai-responses" ? "openai-responses"
            : "openai-compatible",
        }
      : {}),
    ...("apiType" in (updates as Record<string, unknown>)
      ? { apiType: (updates as Partial<Omit<CustomProvider, "id">>).apiType }
      : {}),
  };

  return api<CustomProvider>(`/custom-providers/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(normalized),
  });
}

export function deleteCustomProvider(id: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(`/custom-providers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export interface RefreshProviderModelsResponse {
  provider: CustomProvider;
  modelsRefreshed: number;
}

export function refreshProviderModels(id: string): Promise<RefreshProviderModelsResponse> {
  return api<RefreshProviderModelsResponse>(`/custom-providers/${encodeURIComponent(id)}/refresh-models`, {
    method: "POST",
  });
}

// Backward-compatibility exports for existing UI callers; will be removed when
// custom-provider UI migrates to the new core CustomProvider contract.
export interface CustomProviderModelInput {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface CustomProviderConfig {
  id: string;
  name?: string;
  baseUrl: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  apiKey?: string;
  /** FNXC:ProviderAuth 2026-07-08-00:00: FN-7689 caching opt-in, carried through the legacy shape. */
  anthropicPromptCaching?: boolean;
  models: CustomProviderModelInput[];
}

export function createCustomProvider(config: CustomProviderConfig): Promise<CustomProvider> {
  const apiType = config.api === "anthropic-messages" ? "anthropic-compatible"
    : config.api === "google-generative-ai" ? "google-generative-ai"
    : config.api === "openai-responses" ? "openai-responses"
    : "openai-compatible";
  return addCustomProvider({
    name: config.name?.trim() || config.id,
    apiType,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    models: config.models?.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
    })),
  });
}

/**
 * Probe a custom provider's /models endpoint to discover available models.
 * Supports OpenAI-compatible, Anthropic-compatible, and Google Generative AI providers.
 */
export interface ProbeModelResult {
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ProbeModelsResponse {
  models: ProbeModelResult[];
  count: number;
}

export interface ProbeModelsParams {
  baseUrl: string;
  apiKey?: string;
  apiType: "openai-compatible" | "anthropic-compatible" | "google-generative-ai" | "openai-responses";
}

export async function probeProviderModels(params: ProbeModelsParams): Promise<ProbeModelsResponse> {
  return api<ProbeModelsResponse>("/custom-providers/probe-models", {
    method: "POST",
    body: JSON.stringify({
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      apiType: params.apiType,
    }),
  });
}

export interface GitCliStatus {
  available: boolean;
  version?: string;
  installUrl?: string;
}

/** Fetch authentication status for all OAuth providers */
export function fetchAuthStatus(options?: FetchOptions): Promise<{
  providers: AuthProvider[];
  ghCli?: { available: boolean; authenticated: boolean };
  gitCli?: GitCliStatus;
}> {
  return dedupe("/auth/status", () => api<{
    providers: AuthProvider[];
    ghCli?: { available: boolean; authenticated: boolean };
    gitCli?: GitCliStatus;
  }>("/auth/status"), options);
}

/** Initiate OAuth login for a provider. Returns the auth URL to open in a new tab. */
export function loginProvider(provider: string): Promise<{
  url: string;
  instructions?: string;
  manualCode?: ManualOAuthCodeInfo;
  deviceCode?: OAuthDeviceCodeInfo;
}> {
  return api<{
    url: string;
    instructions?: string;
    manualCode?: ManualOAuthCodeInfo;
    deviceCode?: OAuthDeviceCodeInfo;
  }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ provider, origin: window.location.origin }),
  });
}

/** Submit a pasted OAuth callback URL or authorization code for an active login. */
export function submitProviderManualCode(provider: string, code: string): Promise<{ success: boolean; submitted: boolean }> {
  return api<{ success: boolean; submitted: boolean }>("/auth/manual-code", {
    method: "POST",
    body: JSON.stringify({ provider, code }),
  });
}

/** Logout from a provider, removing stored credentials. */
export function logoutProvider(provider: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>("/auth/logout", {
    method: "POST",
    body: JSON.stringify({ provider }),
  });
}

/** Cancel an in-progress OAuth login attempt for a provider. */
export function cancelProviderLogin(provider: string): Promise<{ success: boolean; cancelled: boolean }> {
  return api<{ success: boolean; cancelled: boolean }>("/auth/cancel", {
    method: "POST",
    body: JSON.stringify({ provider }),
  });
}

/** Save an API key for an API-key-backed provider. */
export function saveApiKey(provider: string, apiKey: string): Promise<{
  success: boolean;
  modelsRefreshed?: number;
  refreshReason?: string;
  refreshError?: string;
}> {
  return api<{
    success: boolean;
    modelsRefreshed?: number;
    refreshReason?: string;
    refreshError?: string;
  }>("/auth/api-key", {
    method: "POST",
    body: JSON.stringify({ provider, apiKey }),
  });
}

/** Remove an API key for an API-key-backed provider. */
export function clearApiKey(provider: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>("/auth/api-key", {
    method: "DELETE",
    body: JSON.stringify({ provider }),
  });
}

// --- GitHub Import API ---

/** GitHub issue returned by the fetch endpoint */
/*
FNXC:GitHubImport 2026-06-22-18:30:
The Import Tasks preview pane renders the FULL issue (full body + metadata), so the list response carries the complete body plus author/state.
The GitHub issue-list endpoint already returns the full (untruncated) `body`; no per-item detail fetch is needed. `author`/`state` are surfaced for the preview metadata row.
*/
export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
  state?: "open" | "closed";
  author?: string | null;
}

/** Fetch open GitHub issues from a repository */
export function apiFetchGitHubIssues(
  owner: string,
  repo: string,
  limit?: number,
  labels?: string[]
): Promise<GitHubIssue[]> {
  return api<GitHubIssue[]>("/github/issues/fetch", {
    method: "POST",
    body: JSON.stringify({ owner, repo, limit, labels }),
  });
}

/** Import a specific GitHub issue as a fn task */
/*
FNXC:GitHubImportTranslate 2026-07-15-14:10:
`targetLocale` forwards the panel's ACTIVE locale so an imported task carries the same translation the operator previewed.
The server also falls back to the global `language` setting, so this argument is not load-bearing for the common case — it exists for the one case the server cannot know: a surface whose locale was browser-detected while global `language` is unset (PR #2141 review, P1).
*/
export function apiImportGitHubIssue(owner: string, repo: string, issueNumber: number, projectId?: string, targetLocale?: string): Promise<Task> {
  return api<Task>(withProjectId("/github/issues/import", projectId), {
    method: "POST",
    body: JSON.stringify({ owner, repo, issueNumber, ...(targetLocale ? { targetLocale } : {}) }),
  });
}

/** Result of a batch import operation for a single issue */
export interface BatchImportResult {
  issueNumber: number;
  success: boolean;
  taskId?: string;
  error?: string;
  skipped?: boolean;
  retryAfter?: number;
}

/** Batch import multiple GitHub issues as fn tasks with throttling */
export function apiBatchImportGitHubIssues(
  owner: string,
  repo: string,
  issueNumbers: number[],
  delayMs?: number,
  projectId?: string,
  /** See apiImportGitHubIssue: batch import must carry translations identically. */
  targetLocale?: string,
): Promise<{ results: BatchImportResult[] }> {
  return api<{ results: BatchImportResult[] }>(withProjectId("/github/issues/batch-import", projectId), {
    method: "POST",
    body: JSON.stringify({ owner, repo, issueNumbers, delayMs, ...(targetLocale ? { targetLocale } : {}) }),
  });
}

// --- GitHub Pull Request Import API ---

/*
FNXC:GitHubImport 2026-06-22-18:30:
The PR-list endpoint already returns the full (untruncated) `body`; the import preview renders it in full with no per-item detail fetch. `state`/`author` surface PR metadata in the preview.
*/
export interface GitHubPull {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  headBranch: string;
  baseBranch: string;
  state?: "open" | "closed" | "merged";
  author?: string | null;
}

/** Fetch open GitHub pull requests from a repository */
export function apiFetchGitHubPulls(
  owner: string,
  repo: string,
  limit?: number
): Promise<GitHubPull[]> {
  return api<GitHubPull[]>("/github/pulls/fetch", {
    method: "POST",
    body: JSON.stringify({ owner, repo, limit }),
  });
}

/*
FNXC:GitHubImport 2026-06-23-01:00:
Per-PR detail for the Import Tasks PR preview pane. `gh pr list` (apiFetchGitHubPulls) returns only comment COUNT + no per-check status, so the preview fetches the FULL comment thread + per-check status ON SELECTION via this client fn (never for the whole list — too expensive).
`status` is the gh CheckRun status (queued/in_progress/completed) or StatusContext state; `conclusion` (success/failure/neutral/...) is present once a check completes.
*/
/*
FNXC:GitHubImport 2026-06-23-03:30:
Comment shape carries `authorAvatarUrl?` (optional, backward-compatible) and `authorIsBot` so the preview renders an avatar + human/bot badge per comment. `authorIsBot` is derived server-side (author type is a GitHub Bot OR login ends in `[bot]`); `authorAvatarUrl` is omitted for bots whose synthetic login does not resolve to a real avatar.
*/
export interface GitHubCommentDetail {
  author: string;
  body: string;
  createdAt: string;
  authorAvatarUrl?: string;
  authorIsBot: boolean;
}

export interface GitHubPullDetail {
  comments: GitHubCommentDetail[];
  checks: Array<{ name: string; status: string; conclusion?: string; detailsUrl?: string }>;
}

/** Fetch the full comment thread + per-check status for a single GitHub PR (called on selection in the import preview). */
export function apiFetchGitHubPullDetail(repo: string, number: number): Promise<GitHubPullDetail> {
  return api<GitHubPullDetail>("/github/pulls/detail", {
    method: "POST",
    body: JSON.stringify({ repo, number }),
  });
}

/*
FNXC:GitHubImport 2026-06-23-03:15:
Per-issue detail for the Import Tasks issue preview pane. Mirrors apiFetchGitHubPullDetail: `gh issue list` has no comment thread, so the preview fetches the FULL comment thread ON SELECTION (never for the whole list).
Issues have no checks rollup, so only `comments` is returned.
*/
export interface GitHubIssueDetail {
  comments: GitHubCommentDetail[];
}

/** Fetch the full comment thread for a single GitHub issue (called on selection in the import preview). */
export function apiFetchGitHubIssueDetail(repo: string, number: number): Promise<GitHubIssueDetail> {
  return api<GitHubIssueDetail>("/github/issues/detail", {
    method: "POST",
    body: JSON.stringify({ repo, number }),
  });
}

/** Close a GitHub issue (Close issue button in the import preview). */
export async function apiCloseGitHubIssue(repo: string, number: number): Promise<void> {
  await api<{ ok: boolean }>("/github/issues/close", {
    method: "POST",
    body: JSON.stringify({ repo, number }),
  });
}


/*
FNXC:GitHubImport 2026-07-17-12:00:
Posts a new comment to the upstream GitHub issue. This is deliberately separate from
apiImportGitHubComment, which creates a Fusion resolve-feedback task from an existing comment.
*/
export async function apiAddGitHubIssueComment(repo: string, number: number, body: string): Promise<void> {
  await api<{ ok: boolean }>("/github/issues/comment", {
    method: "POST",
    body: JSON.stringify({ repo, number, body }),
  });
}

/** Import a specific GitHub pull request as a fn review task */
export function apiImportGitHubPull(owner: string, repo: string, prNumber: number, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId("/github/pulls/import", projectId), {
    method: "POST",
    body: JSON.stringify({ owner, repo, prNumber }),
  });
}

/**
 * FNXC:GitHubImport 2026-07-16-18:05:
 * Comment imports preserve the comment payload and issue/PR source context so the server can create a separately auditable resolve-feedback task without closing the detail window.
 */
export function apiImportGitHubComment(
  params: {
    owner: string;
    repo: string;
    number: number;
    type: "issue" | "pull";
    comment: Pick<GitHubCommentDetail, "author" | "body" | "createdAt">;
  },
  projectId?: string,
): Promise<Task> {
  return api<Task>(withProjectId("/github/comments/import", projectId), {
    method: "POST",
    body: JSON.stringify(params),
  });
}

// --- GitLab Import API ---

export interface GitLabImportItem {
  resourceKind: "project_issue" | "group_issue" | "merge_request";
  id?: number;
  iid: number;
  projectId?: number;
  projectPath?: string;
  groupId?: number | string;
  groupPath?: string;
  title: string;
  description: string | null;
  webUrl: string;
  state: string;
  author?: { username?: string; name?: string } | null;
  labels: string[];
  createdAt?: string;
  updatedAt?: string;
  commentsCount?: number;
  sourceBranch?: string;
  targetBranch?: string;
  draft?: boolean;
}

export function apiFetchGitLabProjectIssues(project: string, limit?: number, labels?: string[], state?: string): Promise<GitLabImportItem[]> {
  return api<GitLabImportItem[]>("/gitlab/project/issues/fetch", { method: "POST", body: JSON.stringify({ project, limit, labels, state }) });
}

export function apiFetchGitLabGroupIssues(group: string, limit?: number, labels?: string[], state?: string): Promise<GitLabImportItem[]> {
  return api<GitLabImportItem[]>("/gitlab/group/issues/fetch", { method: "POST", body: JSON.stringify({ group, limit, labels, state }) });
}

export function apiFetchGitLabMergeRequests(project: string, limit?: number, labels?: string[], state?: string): Promise<GitLabImportItem[]> {
  return api<GitLabImportItem[]>("/gitlab/merge-requests/fetch", { method: "POST", body: JSON.stringify({ project, limit, labels, state }) });
}

export function apiImportGitLabProjectIssue(project: string, iid: number, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId("/gitlab/project/issues/import", projectId), { method: "POST", body: JSON.stringify({ project, iid }) });
}

export function apiImportGitLabGroupIssue(issue: GitLabImportItem, group?: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId("/gitlab/group/issues/import", projectId), { method: "POST", body: JSON.stringify({ issue, group }) });
}

export function apiImportGitLabMergeRequest(project: string, iid: number, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId("/gitlab/merge-requests/import", projectId), { method: "POST", body: JSON.stringify({ project, iid }) });
}

export function apiBatchImportGitLab(items: Array<Record<string, unknown>>, projectId?: string): Promise<{ results: Array<{ success: boolean; taskId?: string; error?: string; iid?: number }> }> {
  return api<{ results: Array<{ success: boolean; taskId?: string; error?: string; iid?: number }> }>(withProjectId("/gitlab/batch-import", projectId), { method: "POST", body: JSON.stringify({ items }) });
}

// --- Git Remote Detection API ---

/** Git remote info returned by the remotes endpoint */
export interface GitRemote {
  name: string;
  owner: string;
  repo: string;
  url: string;
}

/** Fetch GitHub remotes from the current git repository */
export function fetchGitRemotes(projectId?: string, repoPath?: string): Promise<GitRemote[]> {
  return api<GitRemote[]>(withRepoPath(withProjectId("/git/remotes", projectId), repoPath));
}

/** Detailed git remote info with fetch and push URLs */
export interface GitRemoteDetailed {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

/** Fetch all git remotes with their fetch and push URLs */
export function fetchGitRemotesDetailed(projectId?: string, repoPath?: string): Promise<GitRemoteDetailed[]> {
  return api<GitRemoteDetailed[]>(withRepoPath(withProjectId("/git/remotes/detailed", projectId), repoPath));
}

/** Add a new git remote */
export function addGitRemote(name: string, url: string, projectId?: string, repoPath?: string): Promise<void> {
  return api<void>(withRepoPath(withProjectId("/git/remotes", projectId), repoPath), {
    method: "POST",
    body: JSON.stringify({ name, url }),
  });
}

/** Remove a git remote */
export function removeGitRemote(name: string, projectId?: string, repoPath?: string): Promise<void> {
  return api<void>(withRepoPath(withProjectId(`/git/remotes/${encodeURIComponent(name)}`, projectId), repoPath), {
    method: "DELETE",
  });
}

/** Rename a git remote */
export function renameGitRemote(name: string, newName: string, projectId?: string, repoPath?: string): Promise<void> {
  return api<void>(withRepoPath(withProjectId(`/git/remotes/${encodeURIComponent(name)}`, projectId), repoPath), {
    method: "PATCH",
    body: JSON.stringify({ newName }),
  });
}

/** Update the URL for a git remote */
export function updateGitRemoteUrl(name: string, url: string, projectId?: string, repoPath?: string): Promise<void> {
  return api<void>(withRepoPath(withProjectId(`/git/remotes/${encodeURIComponent(name)}/url`, projectId), repoPath), {
    method: "PUT",
    body: JSON.stringify({ url }),
  });
}

// --- PR Management API ---

export interface PrCheckStatus {
  name: string;
  required: boolean;
  state: string;
  detailsUrl?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface PrStatusResponse {
  prInfo: PrInfo;
  prInfos?: PrInfo[];
  stale: boolean;
  automationStatus?: string | null;
}

export interface PrRefreshEntry {
  prInfo: PrInfo;
  conflictDiagnostics?: PrConflictDiagnostics;
  mergeReady: boolean;
  mergeable?: PrInfo["mergeable"];
  blockingReasons: string[];
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checks: PrCheckStatus[];
  automationStatus?: string | null;
  conflictReclaimQueued?: boolean;
}

export interface PrRefreshResponse extends PrRefreshEntry {
  primary: PrRefreshEntry;
  all: PrRefreshEntry[];
}

export interface PrMergeResponse {
  prInfo: PrInfo;
  alreadyMerged?: boolean;
}

export interface PrChecksResponse {
  prInfos?: PrInfo[];
  checks: PrCheckStatus[];
  rollup: "success" | "pending" | "failure" | "unknown";
  lastCheckedAt: string;
}

export interface PrReviewThreadItem {
  id: string;
  author: string;
  text: string;
  source?: "github-review" | "github-review-comment";
  externalId?: string;
  reviewState?: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
  createdAt: string;
}

export interface PrReviewsResponse {
  prInfos?: PrInfo[];
  snapshot: {
    decision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
    items: Array<{
      id: string;
      author: { login: string };
      body: string;
      state?: string;
      htmlUrl?: string;
      createdAt: string;
    }>;
  };
  comments: PrReviewThreadItem[];
}

export interface PrMetadataResponse {
  title: string;
  body: string;
  templateUsed: boolean;
}

export interface PrPreflightCommit {
  sha: string;
  subject: string;
  author: string;
}

export interface PrPreflightChangedFile {
  path: string;
  additions: number;
  deletions: number;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface PrPreflightResponse {
  branchOnRemote: boolean;
  commitsPresent: boolean;
  conflictsWithBase: boolean;
  ghAuthOk: boolean;
  defaultBaseBranch: string;
  head: string;
  commits: PrPreflightCommit[];
  changedFiles: PrPreflightChangedFile[];
}

export interface ResolvePrConflictsResult {
  resolved: boolean;
  pushed: boolean;
  conflictedFiles: string[];
  message: string;
}

export interface ResolvePrConflictsResponse {
  result: ResolvePrConflictsResult;
  preflight: PrPreflightResponse;
}

export interface PushPrBranchResult {
  pushed: boolean;
  head: string;
  message: string;
}

export interface PushPrBranchResponse {
  result: PushPrBranchResult;
  preflight: PrPreflightResponse;
}

export interface PrOptionsUser {
  login: string;
  name?: string;
}

export interface PrOptionsLabel {
  name: string;
  color: string;
}

export interface PrOptionsResponse {
  baseBranches: string[];
  reviewers: PrOptionsUser[];
  assignees: PrOptionsUser[];
  labels: PrOptionsLabel[];
}

export interface CreatePrParams {
  title: string;
  body?: string;
  base?: string;
  draft?: boolean;
  reviewers?: string[];
  assignees?: string[];
  labels?: string[];
}

/** Generate AI metadata for creating a GitHub PR for a task */
export function generatePrMetadata(id: string, projectId?: string): Promise<PrMetadataResponse> {
  return api<PrMetadataResponse>(withProjectId(`/tasks/${id}/pr/generate-metadata`, projectId), {
    method: "POST",
  });
}

/** Fetch PR preflight diagnostics for a task */
export function fetchPrPreflight(id: string, projectId?: string, base?: string): Promise<PrPreflightResponse> {
  const baseParam = base ? `?base=${encodeURIComponent(base)}` : "";
  return api<PrPreflightResponse>(withProjectId(`/tasks/${id}/pr/preflight${baseParam}`, projectId));
}

/** Ask Fusion to resolve Create-PR merge conflicts for a task branch */
export function resolvePrConflicts(id: string, base?: string, projectId?: string): Promise<ResolvePrConflictsResponse> {
  return api<ResolvePrConflictsResponse>(withProjectId(`/tasks/${id}/pr/resolve-conflicts`, projectId), {
    method: "POST",
    ...(base ? { body: JSON.stringify({ base }) } : {}),
  });
}

/** Push the Create-PR task branch to origin and refresh preflight state */
export function pushPrBranch(id: string, base?: string, projectId?: string): Promise<PushPrBranchResponse> {
  return api<PushPrBranchResponse>(withProjectId(`/tasks/${id}/pr/push-branch`, projectId), {
    method: "POST",
    ...(base ? { body: JSON.stringify({ base }) } : {}),
  });
}

/** Fetch PR creation options (branches/reviewers/assignees/labels) for a task */
export function fetchPrOptions(id: string, projectId?: string): Promise<PrOptionsResponse> {
  return api<PrOptionsResponse>(withProjectId(`/tasks/${id}/pr/options`, projectId));
}

/** Create a GitHub PR for a task */
export function createPr(
  id: string,
  params: CreatePrParams,
  projectId?: string,
): Promise<PrInfo> {
  return api<PrInfo>(withProjectId(`/tasks/${id}/pr/create`, projectId), {
    method: "POST",
    body: JSON.stringify(params),
  });
}

/** Fetch cached PR status for a task */
export function fetchPrStatus(id: string, projectId?: string): Promise<PrStatusResponse> {
  return api<PrStatusResponse>(withProjectId(`/tasks/${id}/pr/status`, projectId));
}

/** Force refresh PR status from GitHub */
export function refreshPrStatus(id: string, projectId?: string): Promise<PrRefreshResponse> {
  return api<PrRefreshResponse>(withProjectId(`/tasks/${id}/pr/refresh`, projectId), {
    method: "POST",
  });
}

export function unlinkPr(taskId: string, number: number, projectId?: string): Promise<{ task: TaskDetail; prInfos: PrInfo[] }> {
  return api<{ task: TaskDetail; prInfos: PrInfo[] }>(withProjectId(`/tasks/${taskId}/pr/${number}/unlink`, projectId), {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function reclaimPrConflict(id: string, projectId?: string): Promise<{ queued: boolean; reason?: string }> {
  return api<{ queued: boolean; reason?: string }>(withProjectId(`/tasks/${id}/pr/reclaim-conflict`, projectId), {
    method: "POST",
  });
}

export function mergePr(id: string, method?: "merge" | "squash" | "rebase", projectId?: string, prNumber?: number): Promise<PrMergeResponse> {
  const search = prNumber ? `?pr=${encodeURIComponent(String(prNumber))}` : "";
  return api<PrMergeResponse>(withProjectId(`/tasks/${id}/pr/merge${search}`, projectId), {
    method: "POST",
    body: JSON.stringify(method ? { method } : {}),
  });
}

export function setAutoMergeOnGreen(
  id: string,
  enabled: boolean,
  strategy?: "merge" | "squash" | "rebase",
  projectId?: string,
  prNumber?: number,
): Promise<{ prInfo: PrInfo }> {
  const search = prNumber ? `?pr=${encodeURIComponent(String(prNumber))}` : "";
  return api<{ prInfo: PrInfo }>(withProjectId(`/tasks/${id}/pr/auto-merge${search}`, projectId), {
    method: "POST",
    body: JSON.stringify({ enabled, strategy }),
  });
}

/** Fetch all PR checks for a task */
export function fetchPrChecks(id: string, projectId?: string, prNumber?: number): Promise<PrChecksResponse> {
  const search = prNumber ? `?pr=${encodeURIComponent(String(prNumber))}` : "";
  return api<PrChecksResponse>(withProjectId(`/tasks/${id}/pr/checks${search}`, projectId));
}

export function fetchPrReviews(id: string, projectId?: string, prNumber?: number): Promise<PrReviewsResponse> {
  const search = prNumber ? `?pr=${encodeURIComponent(String(prNumber))}` : "";
  return api<PrReviewsResponse>(withProjectId(`/tasks/${id}/pr/reviews${search}`, projectId));
}

// --- Issue Management API ---

/** Re-export GitHub badge-related types for convenience */
export type { IssueInfo, BatchStatusResult, BatchStatusEntry, PrInfo } from "@fusion/core";

/** Fetch cached issue status for a task */
export function fetchIssueStatus(id: string, projectId?: string): Promise<{ issueInfo: import("@fusion/core").IssueInfo; stale: boolean }> {
  return api<{ issueInfo: import("@fusion/core").IssueInfo; stale: boolean }>(withProjectId(`/tasks/${id}/issue/status`, projectId));
}

/** Force refresh issue status from GitHub */
export function refreshIssueStatus(id: string, projectId?: string): Promise<import("@fusion/core").IssueInfo> {
  return api<import("@fusion/core").IssueInfo>(withProjectId(`/tasks/${id}/issue/refresh`, projectId), {
    method: "POST",
  });
}

/** Batch-refresh cached GitHub badge status for multiple tasks. */
export async function fetchBatchStatus(taskIds: string[], projectId?: string): Promise<BatchStatusResult> {
  const response = await api<BatchStatusResponse>(withProjectId("/github/batch/status", projectId), {
    method: "POST",
    body: JSON.stringify({ taskIds }),
  });

  return response.results;
}

// --- Terminal API ---

/** Terminal exec response - returns sessionId for streaming output via SSE */
export interface TerminalExecResponse {
  sessionId: string;
}

/** Terminal session status and output */
export interface TerminalSession {
  id: string;
  command: string;
  running: boolean;
  exitCode: number | null;
  output: string;
  startTime: string;
}

/** Terminal SSE event types */
export interface TerminalOutputEvent {
  type: "stdout" | "stderr";
  data: string;
}

/** Terminal exit event from SSE */
export interface TerminalExitEvent {
  type: "exit";
  exitCode: number;
}

/** Execute a shell command and get a session ID for streaming output */
export function execTerminalCommand(command: string, projectId?: string): Promise<TerminalExecResponse> {
  return api<TerminalExecResponse>(withProjectId("/terminal/exec", projectId), {
    method: "POST",
    body: JSON.stringify({ command }),
  });
}

/** Get terminal session status and accumulated output */
export function getTerminalSession(sessionId: string): Promise<TerminalSession> {
  return api<TerminalSession>(`/terminal/sessions/${encodeURIComponent(sessionId)}`);
}

/** Kill a running terminal session */
export function killTerminalSession(sessionId: string, signal?: "SIGTERM" | "SIGKILL" | "SIGINT"): Promise<{ killed: boolean; sessionId: string }> {
  return api<{ killed: boolean; sessionId: string }>(`/terminal/sessions/${encodeURIComponent(sessionId)}/kill`, {
    method: "POST",
    body: JSON.stringify({ signal: signal ?? "SIGTERM" }),
  });
}

/** Get the SSE stream URL for a terminal session */
export function getTerminalStreamUrl(sessionId: string): string {
  return `/api/terminal/sessions/${encodeURIComponent(sessionId)}/stream`;
}

// --- PTY Terminal API (WebSocket-based) ---

/** PTY Terminal session response */
export interface PtyTerminalSession {
  sessionId: string;
  shell: string;
  cwd: string;
}

/** PTY Terminal session info for listing */
export interface PtyTerminalSessionInfo {
  id: string;
  cwd: string;
  shell: string;
  createdAt: string;
}

/** Create a new PTY terminal session */
export function createTerminalSession(
  cwd?: string,
  cols?: number,
  rows?: number,
  projectId?: string
): Promise<PtyTerminalSession> {
  return api<PtyTerminalSession>(withProjectId("/terminal/sessions", projectId), {
    method: "POST",
    body: JSON.stringify({ cwd, cols, rows }),
  });
}

/** Kill a PTY terminal session */
export function killPtyTerminalSession(sessionId: string, projectId?: string): Promise<{ killed: boolean }> {
  return api<{ killed: boolean }>(withProjectId(`/terminal/sessions/${encodeURIComponent(sessionId)}`, projectId), {
    method: "DELETE",
  });
}

/** List active PTY terminal sessions */
export function listTerminalSessions(projectId?: string): Promise<PtyTerminalSessionInfo[]> {
  return api<PtyTerminalSessionInfo[]>(withProjectId("/terminal/sessions", projectId));
}

// --- Git Management API ---

/** Current git status */
export interface GitStatus {
  branch: string;
  commit: string;
  isDirty: boolean;
  ahead: number;
  behind: number;
  // Returned only when `?extended=1` is passed to GET /api/git/status.
  headSha?: string;
  integrationBranch?: string;
  integrationBranchSource?: "settings" | "origin-head" | "fallback";
  isOnIntegrationBranch?: boolean;
  /** True when `git branch --show-current` failed (transient git error,
   *  permission, etc.). Distinct from detached HEAD (command succeeds with
   *  empty stdout). UI surfaces "branch detection unavailable" rather than
   *  silently hiding the wrong-branch warning. */
  currentBranchDetectionFailed?: boolean;
  integrationTipSha?: string | null;
  /** "local" = `refs/heads/<branch>` exists; "remote-only" = only
   *  `refs/remotes/origin/<branch>` exists and was used as fallback;
   *  "missing" = neither ref exists. */
  integrationTipSource?: "local" | "remote-only" | "missing";
  originIntegrationTipSha?: string | null;
  /** HEAD vs the **local** integration tip. Undefined when the branch
   *  exists only as a remote-tracking ref. */
  aheadOfIntegration?: number;
  behindIntegration?: number;
  /** HEAD vs `origin/<integrationBranch>`. Defined whenever the remote
   *  tracking ref exists, regardless of whether the local ref does. */
  aheadOfIntegrationRemote?: number;
  behindIntegrationRemote?: number;
  /** Local integration tip vs `origin/<integrationBranch>`. Defined only
   *  when both refs exist. */
  aheadOfOriginIntegration?: number;
  behindOriginIntegration?: number;
  dirtyDetails?: {
    staged: number;
    modified: number;
    untracked: number;
    conflicted: number;
    sample: string[];
  };
  indexStaleVsHead?: boolean;
  stashCount?: number;
  recentMergeAdvances?: Array<{
    taskId: string;
    fromSha: string | null;
    toSha: string;
    advancedAt: string;
    autoSyncOutcome?: string;
    needsAction: boolean;
    resolution: "reachable" | "orphaned" | "subsumed" | "superseded" | "pending";
  }>;
}

/** Git commit info */
export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  body?: string;
  author: string;
  date: string;
  parents: string[];
}

/** Git branch info */
export interface GitBranch {
  name: string;
  isCurrent: boolean;
  remote?: string;
  lastCommitDate?: string;
}

/** Git worktree info */
export interface GitWorktree {
  path: string;
  branch?: string;
  isMain: boolean;
  isBare: boolean;
  taskId?: string;
}

/** Result of a fetch operation */
export interface GitFetchResult {
  fetched: boolean;
  message: string;
}

/** Result of a pull operation */
export interface GitPullResult {
  success: boolean;
  message: string;
  conflict?: boolean;
  autostashed?: boolean;
  stashReapplied?: boolean;
  stashConflict?: boolean;
}

/** Result of a push operation */
export interface GitPushResult {
  success: boolean;
  message: string;
}

/** Fetch current git status. Pass `extended` to also get integration-branch
 *  resolution, ahead/behind vs both local and origin integration tip, dirty
 *  breakdown, stash count, index-stale detection, and recent merge-advance
 *  audit events for the project-root worktree. */
export function fetchGitStatus(projectId?: string, opts?: { extended?: boolean }, repoPath?: string): Promise<GitStatus> {
  const base = withRepoPath(withProjectId("/git/status", projectId), repoPath);
  if (!opts?.extended) return api<GitStatus>(base);
  const sep = base.includes("?") ? "&" : "?";
  return api<GitStatus>(`${base}${sep}extended=1`);
}

/** Append the read-only commit worktree target query param used only by commit list/diff endpoints. */
function withCommitWorktreePath(path: string, worktreePath?: string): string {
  if (!worktreePath) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}worktreePath=${encodeURIComponent(worktreePath)}`;
}

/** Fetch recent commits */
export function fetchGitCommits(limit?: number, projectId?: string, repoPath?: string, worktreePath?: string): Promise<GitCommit[]> {
  const query = limit ? `?limit=${limit}` : "";
  return api<GitCommit[]>(withCommitWorktreePath(withRepoPath(withProjectId(`/git/commits${query}`, projectId), repoPath), worktreePath));
}

/** Fetch diff for a specific commit */
export function fetchCommitDiff(hash: string, projectId?: string, repoPath?: string, worktreePath?: string): Promise<{ stat: string; patch: string }> {
  return api<{ stat: string; patch: string }>(withCommitWorktreePath(withRepoPath(withProjectId(`/git/commits/${hash}/diff`, projectId), repoPath), worktreePath));
}

/** Fetch local commits ahead of the upstream tracking branch (commits to push) */
export function fetchAheadCommits(projectId?: string, repoPath?: string): Promise<GitCommit[]> {
  return api<GitCommit[]>(withRepoPath(withProjectId("/git/commits/ahead", projectId), repoPath));
}

/** Fetch recent commits for a specific remote */
export function fetchRemoteCommits(remote: string, ref?: string, limit?: number, projectId?: string, repoPath?: string): Promise<GitCommit[]> {
  const params = new URLSearchParams();
  if (ref) params.set("ref", ref);
  if (limit) params.set("limit", String(limit));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<GitCommit[]>(withRepoPath(withProjectId(`/git/remotes/${encodeURIComponent(remote)}/commits${query}`, projectId), repoPath));
}

/** Fetch branch names known on a specific remote (from local remote-tracking refs). */
export function fetchGitRemoteBranches(remote: string, projectId?: string, repoPath?: string): Promise<string[]> {
  return api<string[]>(withRepoPath(withProjectId(`/git/remotes/${encodeURIComponent(remote)}/branches`, projectId), repoPath));
}

/** Fetch all local branches */
export function fetchGitBranches(projectId?: string, repoPath?: string): Promise<GitBranch[]> {
  return api<GitBranch[]>(withRepoPath(withProjectId("/git/branches", projectId), repoPath));
}

/** Fetch recent commits for a specific branch */
export function fetchBranchCommits(branchName: string, limit?: number, projectId?: string, repoPath?: string): Promise<GitCommit[]> {
  const query = limit ? `?limit=${limit}` : "";
  return api<GitCommit[]>(withRepoPath(withProjectId(`/git/branches/${encodeURIComponent(branchName)}/commits${query}`, projectId), repoPath));
}

/** Fetch all worktrees */
export function fetchGitWorktrees(projectId?: string, repoPath?: string): Promise<GitWorktree[]> {
  return api<GitWorktree[]>(withRepoPath(withProjectId("/git/worktrees", projectId), repoPath));
}

/** Create a new branch */
export function createBranch(name: string, base?: string, projectId?: string, repoPath?: string): Promise<void> {
  return api<void>(withRepoPath(withProjectId("/git/branches", projectId), repoPath), {
    method: "POST",
    body: JSON.stringify({ name, base }),
  });
}

/** Checkout an existing branch */
export function checkoutBranch(name: string, projectId?: string, repoPath?: string): Promise<void> {
  return api<void>(withRepoPath(withProjectId(`/git/branches/${encodeURIComponent(name)}/checkout`, projectId), repoPath), {
    method: "POST",
  });
}

/** Delete a branch */
export function deleteBranch(name: string, force?: boolean, projectId?: string, repoPath?: string): Promise<void> {
  const query = force ? "?force=true" : "";
  return api<void>(withRepoPath(withProjectId(`/git/branches/${encodeURIComponent(name)}${query}`, projectId), repoPath), {
    method: "DELETE",
  });
}

/** Fetch from remote */
export function fetchRemote(remote?: string, projectId?: string, repoPath?: string): Promise<GitFetchResult> {
  return api<GitFetchResult>(withRepoPath(withProjectId("/git/fetch", projectId), repoPath), {
    method: "POST",
    body: JSON.stringify({ remote }),
  });
}

/** Pull current branch */
export function pullBranch(options?: { rebase?: boolean }, projectId?: string, repoPath?: string): Promise<GitPullResult>;
export function pullBranch(projectId?: string, repoPath?: string): Promise<GitPullResult>;
export function pullBranch(
  optionsOrProjectId?: { rebase?: boolean } | string,
  projectId?: string,
  repoPath?: string,
): Promise<GitPullResult> {
  // FNXC:DashboardGitApi 2026-06-24-00:00:
  // pullBranch has two overloads. In the string-arg style pullBranch(projectId, repoPath),
  // the second positional carries repoPath (not the 3rd parameter), so resolve it from `projectId`
  // to avoid dropping repoPath; otherwise multi-repo workspace pulls hit the wrong repo.
  const isStringForm = typeof optionsOrProjectId === "string";
  const options = isStringForm ? undefined : optionsOrProjectId;
  const resolvedProjectId = isStringForm ? optionsOrProjectId : projectId;
  const resolvedRepoPath = isStringForm ? projectId : repoPath;

  return api<GitPullResult>(withRepoPath(withProjectId("/git/pull", resolvedProjectId), resolvedRepoPath), {
    method: "POST",
    body: JSON.stringify({ rebase: options?.rebase ?? false }),
  });
}

/** Push current branch */
export function pushBranch(projectId?: string, repoPath?: string): Promise<GitPushResult> {
  return api<GitPushResult>(withRepoPath(withProjectId("/git/push", projectId), repoPath), {
    method: "POST",
  });
}

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

/** Fetch stash list */
export function fetchGitStashList(projectId?: string, repoPath?: string): Promise<GitStash[]> {
  return api<GitStash[]>(withRepoPath(withProjectId("/git/stashes", projectId), repoPath));
}

/** Create a new stash */
export function createStash(message?: string, projectId?: string, repoPath?: string): Promise<{ message: string }> {
  return api<{ message: string }>(withRepoPath(withProjectId("/git/stashes", projectId), repoPath), {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

/** Apply a stash entry */
export function applyStash(index: number, drop?: boolean, projectId?: string, repoPath?: string): Promise<{ message: string }> {
  return api<{ message: string }>(withRepoPath(withProjectId(`/git/stashes/${index}/apply`, projectId), repoPath), {
    method: "POST",
    body: JSON.stringify({ drop }),
  });
}

/** Drop a stash entry */
export function dropStash(index: number, projectId?: string, repoPath?: string): Promise<{ message: string }> {
  return api<{ message: string }>(withRepoPath(withProjectId(`/git/stashes/${index}`, projectId), repoPath), {
    method: "DELETE",
  });
}

/** Fetch stash diff (stat + patch) */
export function fetchStashDiff(index: number, projectId?: string, repoPath?: string): Promise<{ stat: string; patch: string }> {
  return api<{ stat: string; patch: string }>(withRepoPath(withProjectId(`/git/stashes/${index}/diff`, projectId), repoPath));
}

/** Fetch unstaged diff (working directory changes) */
export function fetchUnstagedDiff(projectId?: string, repoPath?: string): Promise<{ stat: string; patch: string }> {
  return api<{ stat: string; patch: string }>(withRepoPath(withProjectId("/git/diff", projectId), repoPath));
}

/** Fetch diff for a specific file in staged or unstaged mode */
export function fetchGitFileDiff(path: string, staged: boolean, projectId?: string, repoPath?: string): Promise<{ stat: string; patch: string }> {
  const params = new URLSearchParams();
  params.set("path", path);
  params.set("staged", String(staged));
  return api<{ stat: string; patch: string }>(withRepoPath(withProjectId(`/git/diff/file?${params.toString()}`, projectId), repoPath));
}

/** Fetch file changes (staged and unstaged) */
export function fetchFileChanges(projectId?: string, repoPath?: string): Promise<GitFileChange[]> {
  return api<GitFileChange[]>(withRepoPath(withProjectId("/git/changes", projectId), repoPath));
}

/** Stage specific files */
export function stageFiles(files: string[], projectId?: string, repoPath?: string): Promise<{ staged: string[] }> {
  return api<{ staged: string[] }>(withRepoPath(withProjectId("/git/stage", projectId), repoPath), {
    method: "POST",
    body: JSON.stringify({ files }),
  });
}

/** Unstage specific files */
export function unstageFiles(files: string[], projectId?: string, repoPath?: string): Promise<{ unstaged: string[] }> {
  return api<{ unstaged: string[] }>(withRepoPath(withProjectId("/git/unstage", projectId), repoPath), {
    method: "POST",
    body: JSON.stringify({ files }),
  });
}

/** Create a commit */
export function createCommit(message: string, projectId?: string, repoPath?: string): Promise<{ hash: string; message: string }> {
  return api<{ hash: string; message: string }>(withRepoPath(withProjectId("/git/commit", projectId), repoPath), {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

/** Discard changes in working directory for specific files */
export function discardChanges(files: string[], projectId?: string, repoPath?: string): Promise<{ discarded: string[] }> {
  return api<{ discarded: string[] }>(withRepoPath(withProjectId("/git/discard", projectId), repoPath), {
    method: "POST",
    body: JSON.stringify({ files }),
  });
}

// --- File Browser API ---

/** File node in directory listing */
export interface FileNode {
  name: string;
  type: "file" | "directory";
  size?: number;
  mtime?: string;
}

/** File listing response */
export interface FileListResponse {
  path: string;
  entries: FileNode[];
}

/** File content response */
export interface FileContentResponse {
  content: string;
  mtime: string;
  size: number;
}

/** Save file response */
export interface SaveFileResponse {
  success: true;
  mtime: string;
  size: number;
}

/** List files in task directory */
export function fetchFileList(taskId: string, path?: string, projectId?: string): Promise<FileListResponse> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return api<FileListResponse>(withProjectId(`/tasks/${taskId}/files${query}`, projectId));
}

/** Fetch file content */
export function fetchFileContent(taskId: string, filePath: string, projectId?: string): Promise<FileContentResponse> {
  return api<FileContentResponse>(withProjectId(`/tasks/${taskId}/files/${encodeURIComponent(filePath)}`, projectId));
}

/** Save file content */
export function saveFileContent(taskId: string, filePath: string, content: string, projectId?: string): Promise<SaveFileResponse> {
  return api<SaveFileResponse>(withProjectId(`/tasks/${taskId}/files/${encodeURIComponent(filePath)}`, projectId), {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

// --- Workspace File Browser API ---

export interface WorkspaceTaskInfo {
  id: string;
  title?: string;
  worktree: string;
}

export interface WorkspaceListResponse {
  project: string;
  tasks: WorkspaceTaskInfo[];
}

/** Fetch available file browser workspaces. */
export function fetchWorkspaces(projectId?: string): Promise<WorkspaceListResponse> {
  return api<WorkspaceListResponse>(withProjectId("/workspaces", projectId));
}

/** List files in a workspace (project root or task worktree). */
export function fetchWorkspaceFileList(workspace: string, path?: string, projectId?: string): Promise<FileListResponse> {
  const query = new URLSearchParams({ workspace });
  if (path) {
    query.set("path", path);
  }
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileListResponse>(`/files?${query.toString()}`);
}

/** Fetch file content from a workspace. */
export function fetchWorkspaceFileContent(workspace: string, filePath: string, projectId?: string): Promise<FileContentResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileContentResponse>(`/files/${encodeURIComponent(filePath)}?${query.toString()}`);
}

/** Save file content to a workspace. */
export function saveWorkspaceFileContent(workspace: string, filePath: string, content: string, projectId?: string): Promise<SaveFileResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<SaveFileResponse>(`/files/${encodeURIComponent(filePath)}?${query.toString()}`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

/** File search result. */
export interface FileSearchResult {
  files: Array<{ path: string; name: string }>;
}

export interface IssueMentionItem {
  number: number;
  title: string;
  state: "open" | "closed";
  htmlUrl: string;
  repository: string;
  updatedAt?: string;
}

export function fetchRecentIssues(projectId?: string, query?: string): Promise<IssueMentionItem[]> {
  const params = new URLSearchParams();
  if (query && query.trim()) {
    params.set("q", query.trim());
  }
  if (projectId) {
    params.set("projectId", projectId);
  }
  const search = params.toString();
  return api<IssueMentionItem[]>(`/github/issues/recent${search ? `?${search}` : ""}`);
}

/** Search for files matching a query in a workspace. */
export function searchFiles(query: string, workspace?: string, projectId?: string): Promise<FileSearchResult> {
  const params = new URLSearchParams({ q: query });
  if (workspace) {
    params.set("workspace", workspace);
  }
  if (projectId) {
    params.set("projectId", projectId);
  }
  return api<FileSearchResult>(`/files/search?${params.toString()}`);
}

// --- Workspace File Operations API (Create, Copy, Move, Delete, Rename, Download) ---

/** File operation response for create/copy/move/delete/rename operations */
export interface FileOperationResponse {
  success: true;
  message?: string;
  path?: string;
}

/** Create a directory within a workspace. */
export function createWorkspaceDirectory(workspace: string, dirPath: string, projectId?: string): Promise<FileOperationResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileOperationResponse>(`/files/mkdir?${query.toString()}`, {
    method: "POST",
    body: JSON.stringify({ path: dirPath }),
  });
}

/** Create an empty file within a workspace. */
export function createWorkspaceFile(workspace: string, filePath: string, projectId?: string): Promise<FileOperationResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileOperationResponse>(`/files/${encodeURIComponent(filePath)}?${query.toString()}`, {
    method: "POST",
    body: JSON.stringify({ content: "" }),
  });
}

/** Copy a file or directory to a new location within a workspace. */
export function copyFile(workspace: string, filePath: string, destination: string, projectId?: string): Promise<FileOperationResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileOperationResponse>(`/files/${encodeURIComponent(filePath)}/copy?${query.toString()}`, {
    method: "POST",
    body: JSON.stringify({ destination }),
  });
}

/** Move a file or directory to a new location within a workspace. */
export function moveFile(workspace: string, filePath: string, destination: string, projectId?: string): Promise<FileOperationResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileOperationResponse>(`/files/${encodeURIComponent(filePath)}/move?${query.toString()}`, {
    method: "POST",
    body: JSON.stringify({ destination }),
  });
}

/** Delete a file or directory within a workspace. */
export function deleteFile(workspace: string, filePath: string, projectId?: string): Promise<FileOperationResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileOperationResponse>(`/files/${encodeURIComponent(filePath)}/delete?${query.toString()}`, {
    method: "POST",
  });
}

/** Rename a file or directory within a workspace. */
export function renameFile(workspace: string, filePath: string, newName: string, projectId?: string): Promise<FileOperationResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileOperationResponse>(`/files/${encodeURIComponent(filePath)}/rename?${query.toString()}`, {
    method: "POST",
    body: JSON.stringify({ newName }),
  });
}

/** Get the download URL for a single file in a workspace. */
export function downloadFileUrl(workspace: string, filePath: string, projectId?: string, options?: { inline?: boolean }): string {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  /**
   * FNXC:FileBrowser 2026-06-26-00:00:
   * Browser-native preview consumers request `inline=1` so the shared download route serves renderable MIME types with inline disposition. The explicit Download action intentionally omits this option to preserve attachment downloads.
   */
  if (options?.inline === true) {
    query.set("inline", "1");
  }
  return `/api/files/${encodeURIComponent(filePath)}/download?${query.toString()}`;
}

/** Get the download URL for a folder as ZIP in a workspace. */
export function downloadZipUrl(workspace: string, filePath: string, projectId?: string): string {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return `/api/files/${encodeURIComponent(filePath)}/download-zip?${query.toString()}`;
}

// --- Planning Mode API ---

/** Planning session state returned from API */
export interface PlanningSession {
  sessionId: string;
  currentQuestion: PlanningQuestion | null;
  summary: PlanningSummary | null;
}

/** The response endpoint may synchronously return a generated next question before SSE delivers it. */
export type PlanningResponse = PlanningSession | { type: "question"; data: PlanningQuestion };

/** SSE event types for planning session streaming */
export type PlanningStreamEvent =
  | { type: "thinking"; data: string }
  | { type: "question"; data: PlanningQuestion }
  | { type: "summary"; data: PlanningSummary }
  | { type: "error"; data: string }
  | { type: "complete"; data: Record<string, never> };

export interface AgentOnboardingSummary {
  name: string;
  role: AgentCapability | "custom";
  instructionsText: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  maxTurns: number;
  title?: string;
  icon?: string;
  reportsTo?: string;
  soul?: string;
  memory?: string;
  skills?: string[];
  templateId?: string;
  patternAgentId?: string;
  rationale?: string;
  model?: string;
  /** Draft-only AI suggestion for eventual runtimeConfig.model selection. */
  modelHint?: string;
  /** Draft-only AI suggestion for eventual runtimeConfig.runtimeHint plugin runtime selection. */
  runtimeHint?: string;
  heartbeatProcedurePath?: string;
  heartbeatIntervalMs?: number;
  heartbeatEnabled?: boolean;
}

export type OnboardingMode = "create" | "edit";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ExistingAgentOnboardingConfig {
  name?: string;
  role?: AgentCapability | "custom";
  title?: string;
  instructionsText?: string;
  soul?: string;
  memory?: string;
  reportsTo?: string;
  skills?: string[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  maxTurns?: number;
  runtimeHint?: string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  maxConcurrentRuns?: number;
  messageResponseMode?: "immediate" | "on-heartbeat";
}

export type AgentOnboardingStreamEvent =
  | { type: "thinking"; data: string }
  | { type: "question"; data: PlanningQuestion }
  | { type: "summary"; data: AgentOnboardingSummary }
  | { type: "error"; data: string }
  | { type: "complete"; data: Record<string, never> };

/** Start a new planning session with an initial plan */
export function startPlanning(
  initialPlan: string,
  projectId?: string,

): Promise<PlanningSession> {
  return api<PlanningSession>(withProjectId("/planning/start", projectId), {
    method: "POST",
    body: JSON.stringify({
      initialPlan,
    }),
  });
}

export function createPlanningDraft(
  initialPlan: string,
  projectId?: string,
  modelOverride?: { planningModelProvider?: string; planningModelId?: string; thinkingLevel?: ThinkingLevel },
): Promise<{ sessionId: string; title: string }> {
  return api<{ sessionId: string; title: string }>(withProjectId("/planning/create-draft", projectId), {
    method: "POST",
    body: JSON.stringify({
      initialPlan,
      planningModelProvider: modelOverride?.planningModelProvider,
      planningModelId: modelOverride?.planningModelId,
      thinkingLevel: modelOverride?.thinkingLevel,
    }),
  });
}

/** Start a new planning session with AI streaming support */
export function startPlanningStreaming(
  initialPlan: string,
  projectId?: string,
  modelOverride?: { planningModelProvider?: string; planningModelId?: string; thinkingLevel?: ThinkingLevel },
  planningOptions?: { clarificationEnabled?: boolean; workflowId?: string | null },
  existingSessionId?: string,
): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(withProjectId("/planning/start-streaming", projectId), {
    method: "POST",
    body: JSON.stringify({
      initialPlan,
      planningModelProvider: modelOverride?.planningModelProvider,
      planningModelId: modelOverride?.planningModelId,
      thinkingLevel: modelOverride?.thinkingLevel,
      clarificationEnabled: planningOptions?.clarificationEnabled,
      ...(planningOptions?.workflowId ? { workflowId: planningOptions.workflowId } : {}),
      ...(existingSessionId ? { existingSessionId } : {}),
    }),
  });
}

/** Explicitly validate the current running planning summary before creating work. */
export function validatePlanningSession(sessionId: string, projectId?: string): Promise<{ summary: PlanningSummary; validated: boolean }> {
  return api<{ summary: PlanningSummary; validated: boolean }>(withProjectId(`/planning/${encodeURIComponent(sessionId)}/validate`, projectId), { method: "POST" });
}

/** Rename a planning session after the server verifies the session type. */
export function updatePlanningSessionTitle(sessionId: string, title: string, projectId?: string): Promise<{ sessionId: string; title: string }> {
  return api<{ sessionId: string; title: string }>(withProjectId(`/planning/${encodeURIComponent(sessionId)}/title`, projectId), {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

/** Submit a response to the current planning question */
export function respondToPlanning(
  sessionId: string,
  responses: Record<string, unknown>,
  projectId?: string,
): Promise<PlanningResponse> {
  return api<PlanningResponse>(withProjectId("/planning/respond", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, responses }),
  });
}

/** Rewind a planning session to the previous answered question */
export function rewindPlanningSession(
  sessionId: string,
  projectId?: string,
  questionId?: string,
): Promise<{ currentQuestion: PlanningQuestion; summary?: PlanningSummary; history: Array<{ question: PlanningQuestion; response: unknown; thinkingOutput?: string }> }> {
  return api<{ currentQuestion: PlanningQuestion; summary?: PlanningSummary; history: Array<{ question: PlanningQuestion; response: unknown; thinkingOutput?: string }> }>(
    withProjectId(`/planning/${encodeURIComponent(sessionId)}/back`, projectId),
    {
      method: "POST",
      ...(questionId ? { body: JSON.stringify({ questionId }) } : {}),
    },
  );
}

/** Retry a failed planning session turn */
export function retryPlanningSession(
  sessionId: string,
  projectId?: string,
): Promise<{ success: boolean; sessionId: string }> {
  return api<{ success: boolean; sessionId: string }>(
    withProjectId(`/planning/${encodeURIComponent(sessionId)}/retry`, projectId),
    {
      method: "POST",
    },
  );
}

/** Stop in-flight planning generation for a session */
export function stopPlanningGeneration(
  sessionId: string,
  projectId?: string,
): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(
    withProjectId(`/planning/${encodeURIComponent(sessionId)}/stop`, projectId),
    {
      method: "POST",
    },
  );
}

/** Cancel an active planning session */
export function cancelPlanning(sessionId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId("/planning/cancel", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

export function startAgentOnboardingStreaming(
  intent: string,
  context: {
    existingAgents: Array<{ id: string; name: string; role: string }>;
    templates: Array<{ id: string; label: string; description?: string }>;
    mode?: OnboardingMode;
    existingAgentConfig?: ExistingAgentOnboardingConfig;
  },
  projectId?: string,
  modelOverride?: { planningModelProvider?: string; planningModelId?: string },
): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(withProjectId("/agents/onboarding/start-streaming", projectId), {
    method: "POST",
    body: JSON.stringify({
      intent,
      context,
      mode: context.mode,
      existingAgentConfig: context.existingAgentConfig,
      planningModelProvider: modelOverride?.planningModelProvider,
      planningModelId: modelOverride?.planningModelId,
    }),
  });
}

export function respondToAgentOnboarding(
  sessionId: string,
  responses: Record<string, unknown>,
  projectId?: string,
): Promise<{ type: "question" | "complete"; data: PlanningQuestion | AgentOnboardingSummary }> {
  return api(withProjectId("/agents/onboarding/respond", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, responses }),
  });
}

export function retryAgentOnboardingSession(sessionId: string, projectId?: string): Promise<{ success: boolean; sessionId: string }> {
  return api(withProjectId(`/agents/onboarding/${encodeURIComponent(sessionId)}/retry`, projectId), {
    method: "POST",
  });
}

export function stopAgentOnboardingGeneration(sessionId: string, projectId?: string): Promise<{ success: boolean }> {
  return api(withProjectId(`/agents/onboarding/${encodeURIComponent(sessionId)}/stop`, projectId), {
    method: "POST",
  });
}

export function cancelAgentOnboarding(sessionId: string, projectId?: string): Promise<void> {
  return api(withProjectId("/agents/onboarding/cancel", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

/** Create a task from a completed planning session */
export function createTaskFromPlanning(
  sessionId: string,
  summary?: PlanningSummary,
  projectId?: string,
  options?: {
    branch?: string;
    baseBranch?: string;
    branchSelection?: {
      mode: "project-default" | "auto-new" | "existing" | "custom-new";
      branchName?: string;
      baseBranch?: string;
    };
    workflowId?: string | null;
  },
): Promise<Task> {
  return api<{ task: Task; alreadyCreated: boolean }>(withProjectId("/planning/create-task", projectId), {
    method: "POST",
    body: JSON.stringify({
      ...(summary ? { sessionId, summary } : { sessionId }),
      ...(options?.branch !== undefined ? { branch: options.branch } : {}),
      ...(options?.baseBranch !== undefined ? { baseBranch: options.baseBranch } : {}),
      ...(options?.branchSelection ? { branchSelection: options.branchSelection } : {}),
      ...(options?.workflowId !== undefined ? { workflowId: options.workflowId } : {}),
    }),
  }).then((response) => response.task);
}

/** Start subtask breakdown from a completed planning session */
export function startPlanningBreakdown(
  sessionId: string,
  summary?: PlanningSummary,
  projectId?: string,
): Promise<{ sessionId: string; subtasks: SubtaskItem[] }> {
  return api<{ sessionId: string; subtasks: SubtaskItem[] }>(
    withProjectId("/planning/start-breakdown", projectId),
    {
      method: "POST",
      body: JSON.stringify(summary ? { sessionId, summary } : { sessionId }),
    },
  );
}

/** Create multiple tasks from a completed planning session */
export function createTasksFromPlanning(
  planningSessionId: string,
  subtasks: PlanningSubtaskDraft[],
  projectId?: string,
  options?: {
    branchSelection?: {
      mode: "project-default" | "auto-new" | "existing" | "custom-new";
      branchName?: string;
      baseBranch?: string;
    };
    branchAssignment?: {
      mode: "shared" | "per-task-derived";
    };
    workflowId?: string | null;
  },
): Promise<{ tasks: Task[] }> {
  return api<{ tasks: Task[] }>(withProjectId("/planning/create-tasks", projectId), {
    method: "POST",
    body: JSON.stringify({
      planningSessionId,
      subtasks,
      ...(options?.branchSelection ? { branchSelection: options.branchSelection } : {}),
      ...(options?.branchAssignment ? { branchAssignment: options.branchAssignment } : {}),
      ...(options?.workflowId !== undefined ? { workflowId: options.workflowId } : {}),
    }),
  });
}


// FNXC:CodeOrganization 2026-07-19-12:00: SSE reconnect lives in event-source.ts.
export type { StreamConnectionState, ResilientEventSourceOptions, ResilientEventHandlers } from "./event-source.js";
import { createResilientEventSource } from "./event-source.js";
import type { StreamConnectionState } from "./event-source.js";
import { startKeepAlive } from "./ai-sessions.js";
export { createResilientEventSource } from "./event-source.js";

export interface DevServerCandidate {
  scriptName: string;
  command: string;
  packagePath: string;
  confidence: number;
  name: string;
  cwd: string;
  source: string;
  workspaceName?: string;
  label: string;
}

// Backward-compatible alias for backend naming in FN-2178 scope.
export type DetectedCandidate = DevServerCandidate;

export interface DevServerState {
  id: string;
  name: string;
  status: "stopped" | "starting" | "running" | "failed";
  command: string;
  scriptName: string;
  cwd: string;
  pid?: number;
  startedAt?: string;
  previewUrl?: string;
  detectedUrl?: string;
  detectedPort?: number;
  manualPreviewUrl?: string;
  manualUrl?: string;
  logs: string[];
  exitCode?: number | null;
}

export type DevServerStatus = DevServerState;

export interface DevServerStartInput {
  command: string;
  scriptName?: string;
  cwd?: string;
  packagePath?: string;
}

export interface DevServerConfig {
  selectedScript: string | null;
  selectedSource: string | null;
  selectedCommand: string | null;
  previewUrlOverride: string | null;
  detectedPreviewUrl: string | null;
  selectedAt: string | null;
}

export interface DevServerLogHistoryEntry {
  id: number;
  text: string;
  stream: "stdout" | "stderr";
  timestamp: string;
}

export interface DevServerLogHistoryResponse {
  lines: DevServerLogHistoryEntry[];
  totalLines: number;
}

export interface FetchDevServerLogHistoryOptions {
  maxLines?: number;
  offset?: number;
  lastEventId?: number;
}

export interface DevServerConfig {
  selectedScript: string | null;
  selectedSource: string | null;
  selectedCommand: string | null;
  previewUrlOverride: string | null;
  detectedPreviewUrl: string | null;
  selectedAt: string | null;
}

interface BackendDevServerCandidate {
  name: string;
  command: string;
  source?: string;
  packageName?: string;
  packagePath?: string;
  confidence?: number;
}

interface BackendDevServerState {
  id?: string;
  name?: string;
  status?: "stopped" | "starting" | "running" | "failed";
  command?: string;
  scriptId?: string;
  cwd?: string;
  pid?: number;
  startedAt?: string;
  previewUrl?: string;
  detectedUrl?: string;
  detectedPort?: number;
  manualPreviewUrl?: string;
  manualUrl?: string;
  logHistory?: string[];
  exitCode?: number | null;
}

interface BackendDevServerLogHistoryLine {
  id?: number;
  text?: string;
  line?: string;
  stream?: "stdout" | "stderr";
  timestamp?: string;
}

interface BackendDevServerLogHistoryResponse {
  lines?: BackendDevServerLogHistoryLine[];
  totalLines?: number;
}

function mapBackendCandidateToFrontend(candidate: BackendDevServerCandidate): DevServerCandidate {
  const source = typeof candidate.source === "string" && candidate.source.trim().length > 0
    ? candidate.source.trim()
    : "root";
  const cwd = source === "root" ? "." : source;
  const scriptName = candidate.name;
  const packagePath = typeof candidate.packagePath === "string" && candidate.packagePath.trim().length > 0
    ? candidate.packagePath.trim()
    : cwd;
  const confidence = typeof candidate.confidence === "number"
    ? candidate.confidence
    : 1;

  const locationLabel = source === "root" ? "root" : source;
  const packageLabel = typeof candidate.packageName === "string" && candidate.packageName.trim().length > 0
    ? candidate.packageName.trim()
    : "project";

  return {
    name: candidate.name,
    command: candidate.command,
    scriptName,
    packagePath,
    confidence,
    cwd,
    source,
    workspaceName: typeof candidate.packageName === "string" ? candidate.packageName : undefined,
    label: `${packageLabel} · ${scriptName} (${locationLabel})`,
  };
}

function mapBackendStateToFrontend(state: BackendDevServerState): DevServerState {
  const status = state.status;
  const normalizedStatus = status === "starting" || status === "running" || status === "failed" || status === "stopped"
    ? status
    : "stopped";

  const previewUrl = typeof state.previewUrl === "string"
    ? state.previewUrl
    : state.detectedUrl;
  const manualPreviewUrl = typeof state.manualPreviewUrl === "string"
    ? state.manualPreviewUrl
    : state.manualUrl;

  return {
    id: typeof state.id === "string" ? state.id : "",
    name: typeof state.name === "string" && state.name.length > 0 ? state.name : "default",
    status: normalizedStatus,
    command: typeof state.command === "string" ? state.command : "",
    scriptName: typeof state.scriptId === "string" ? state.scriptId : "",
    cwd: typeof state.cwd === "string" ? state.cwd : "",
    pid: state.pid,
    startedAt: state.startedAt,
    previewUrl,
    detectedUrl: typeof state.detectedUrl === "string" ? state.detectedUrl : previewUrl,
    detectedPort: state.detectedPort,
    manualPreviewUrl,
    manualUrl: typeof state.manualUrl === "string" ? state.manualUrl : manualPreviewUrl,
    logs: Array.isArray(state.logHistory) ? state.logHistory : [],
    exitCode: state.exitCode,
  };
}

function normalizeDevServerLogLine(line: BackendDevServerLogHistoryLine, fallbackId: number): DevServerLogHistoryEntry {
  return {
    id: typeof line.id === "number" && Number.isFinite(line.id) ? line.id : fallbackId,
    text: typeof line.text === "string" ? line.text : (typeof line.line === "string" ? line.line : ""),
    stream: line.stream === "stderr" ? "stderr" : "stdout",
    timestamp: typeof line.timestamp === "string" ? line.timestamp : "",
  };
}

function normalizeDevServerLogHistoryResponse(response: BackendDevServerLogHistoryResponse): DevServerLogHistoryResponse {
  const rawLines = Array.isArray(response.lines) ? response.lines : [];
  const lines = rawLines.map((line, index) => normalizeDevServerLogLine(line, index + 1));

  return {
    lines,
    totalLines: typeof response.totalLines === "number" && Number.isFinite(response.totalLines)
      ? response.totalLines
      : lines.length,
  };
}

function mapLegacyDevServerLogs(logs: string[], options: FetchDevServerLogHistoryOptions): DevServerLogHistoryResponse {
  const maxLines = typeof options.maxLines === "number" && Number.isFinite(options.maxLines)
    ? Math.max(1, Math.floor(options.maxLines))
    : 100;
  const offset = typeof options.offset === "number" && Number.isFinite(options.offset)
    ? Math.max(0, Math.floor(options.offset))
    : 0;
  const lastEventId = typeof options.lastEventId === "number" && Number.isFinite(options.lastEventId)
    ? Math.max(0, Math.floor(options.lastEventId))
    : null;

  const totalLines = logs.length;
  const fullLines = logs.map<DevServerLogHistoryEntry>((text, index) => ({
    id: index + 1,
    text,
    stream: "stdout",
    timestamp: "",
  }));

  if (lastEventId !== null) {
    return {
      lines: fullLines.filter((line) => line.id > lastEventId).slice(0, maxLines),
      totalLines,
    };
  }

  const endExclusive = Math.max(totalLines - offset, 0);
  const start = Math.max(endExclusive - maxLines, 0);

  return {
    lines: fullLines.slice(start, endExclusive),
    totalLines,
  };
}

type DevServerCandidatesResponse =
  | { candidates?: BackendDevServerCandidate[] }
  | BackendDevServerCandidate[];

function mapCandidatesResponse(response: DevServerCandidatesResponse): DevServerCandidate[] {
  if (Array.isArray(response)) {
    return response.map(mapBackendCandidateToFrontend);
  }

  return (response.candidates ?? []).map(mapBackendCandidateToFrontend);
}

export async function fetchDevServerCandidates(projectId?: string): Promise<DevServerCandidate[]> {
  try {
    const response = await api<DevServerCandidatesResponse>(withProjectId("/dev-server/candidates", projectId));
    return mapCandidatesResponse(response);
  } catch (error) {
    // Backward compatibility for workspaces that still expose /dev-server/detect.
    if (error instanceof Error && /\/dev-server\/candidates/.test(error.message)) {
      const fallback = await api<DevServerCandidatesResponse>(withProjectId("/dev-server/detect", projectId));
      return mapCandidatesResponse(fallback);
    }
    throw error;
  }
}

export function detectDevServer(projectId?: string): Promise<DevServerCandidate[]> {
  return fetchDevServerCandidates(projectId);
}

export function fetchDevServerConfig(projectId?: string): Promise<DevServerConfig> {
  return api<DevServerConfig>(withProjectId("/dev-server/config", projectId));
}

export function saveDevServerConfig(config: Partial<DevServerConfig>, projectId?: string): Promise<DevServerConfig> {
  return api<DevServerConfig>(withProjectId("/dev-server/config", projectId), {
    method: "PUT",
    body: JSON.stringify(config),
  });
}

export function fetchDevServerStatus(projectId?: string): Promise<DevServerState> {
  return api<BackendDevServerState>(withProjectId("/dev-server/status", projectId)).then(mapBackendStateToFrontend);
}

export async function fetchDevServerLogHistory(
  options: FetchDevServerLogHistoryOptions = {},
  projectId?: string,
): Promise<DevServerLogHistoryResponse> {
  const query = new URLSearchParams();
  if (typeof options.maxLines === "number" && Number.isFinite(options.maxLines)) {
    query.set("maxLines", String(Math.max(1, Math.floor(options.maxLines))));
  }
  if (typeof options.offset === "number" && Number.isFinite(options.offset)) {
    query.set("offset", String(Math.max(0, Math.floor(options.offset))));
  }
  if (typeof options.lastEventId === "number" && Number.isFinite(options.lastEventId)) {
    query.set("lastEventId", String(Math.max(0, Math.floor(options.lastEventId))));
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";

  try {
    const response = await api<BackendDevServerLogHistoryResponse>(
      withProjectId(`/dev-server/logs/history${suffix}`, projectId),
    );
    return normalizeDevServerLogHistoryResponse(response);
  } catch (error) {
    // Backward compatibility for workspaces without /dev-server/logs/history.
    if (error instanceof Error && /\/dev-server\/logs\/history/.test(error.message)) {
      const status = await fetchDevServerStatus(projectId);
      return mapLegacyDevServerLogs(status.logs, options);
    }
    throw error;
  }
}

export function startDevServer(body: DevServerStartInput, projectId?: string): Promise<DevServerState> {
  const cwd = body.cwd ?? body.packagePath ?? ".";
  const scriptName = body.scriptName;

  return api<BackendDevServerState>(withProjectId("/dev-server/start", projectId), {
    method: "POST",
    body: JSON.stringify({
      command: body.command,
      scriptName,
      scriptId: scriptName,
      cwd,
      packagePath: body.packagePath,
    }),
  }).then(mapBackendStateToFrontend);
}

export function stopDevServer(projectId?: string): Promise<DevServerState> {
  return api<BackendDevServerState>(withProjectId("/dev-server/stop", projectId), {
    method: "POST",
  }).then(mapBackendStateToFrontend);
}

export function restartDevServer(projectId?: string): Promise<DevServerState> {
  return api<BackendDevServerState>(withProjectId("/dev-server/restart", projectId), {
    method: "POST",
  }).then(mapBackendStateToFrontend);
}

export async function setDevServerPreviewUrl(urlOrBody: string | { url: string | null }, projectId?: string): Promise<DevServerState> {
  const body = typeof urlOrBody === "string"
    ? { url: urlOrBody }
    : urlOrBody;

  try {
    const response = await api<BackendDevServerState>(withProjectId("/dev-server/preview-url", projectId), {
      method: "POST",
      body: JSON.stringify(body),
    });
    return mapBackendStateToFrontend(response);
  } catch (error) {
    // Backward compatibility for workspaces that still use PUT.
    if (error instanceof Error && /\/dev-server\/preview-url/.test(error.message)) {
      const fallback = await api<BackendDevServerState>(withProjectId("/dev-server/preview-url", projectId), {
        method: "PUT",
        body: JSON.stringify(body),
      });
      return mapBackendStateToFrontend(fallback);
    }
    throw error;
  }
}

export function getDevServerLogsStreamUrl(projectId?: string): string {
  return buildApiUrl(withProjectId("/dev-server/logs/stream", projectId));
}

// =============================================================================
// Session-based DevServer API (FN-2184 / FN-2185)
// Target /api/devserver/* with fallback to /api/dev-server/* for migration safety
// =============================================================================

/**
 * Canonical session-based DevServer types.
 * These align with the new session model introduced in FN-2184.
 */

// Detected dev server command (result of detectDevServerCommands)
export interface DetectedDevServerCommand {
  name: string;
  command: string;
  cwd: string;
  scriptName: string;
  packagePath: string;
  framework?: string;
}

// Dev server log entry format
export interface DevServerLogEntry {
  timestamp: string;
  stream: "stdout" | "stderr";
  text: string;
}

// Preview URL response from backend
export interface DevServerPreviewResponse {
  url: string | null;
  source: "auto" | "manual" | null;
}

// Dev server runtime info (process details)
export interface DevServerRuntime {
  pid: number;
  startedAt: string;
  exitCode?: number;
  previewUrl?: string;
}

// Dev server configuration (saved settings)
export interface DevServerSessionConfig {
  id: string;
  name: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  autoStart?: boolean;
}

// Full DevServer session combining config, status, runtime, and logs
export interface DevServerSession {
  config: DevServerSessionConfig;
  status: "stopped" | "starting" | "running" | "failed" | "stopping";
  runtime?: DevServerRuntime;
  previewUrl?: string;
  logHistory: DevServerLogEntry[];
}

// Options for fetching log history
export interface FetchDevServerLogsOptions {
  maxLines?: number;
  offset?: number;
  lastEventId?: number;
}

// Backend response shape for log history
interface BackendSessionLogResponse {
  lines?: DevServerLogEntry[];
  totalLines?: number;
}

// Backend response for preview endpoint
interface BackendPreviewResponse {
  url?: string | null;
  source?: string | null;
}

// Backend response for list sessions
interface BackendSessionsListResponse {
  sessions?: DevServerSession[];
}

// Backend response for detect commands
interface BackendDetectCommandsResponse {
  candidates?: DetectedDevServerCommand[];
}

/**
 * Fetch all dev server sessions.
 * Targets /api/devserver with fallback to /api/dev-server (legacy compatibility).
 */
export async function fetchDevServers(projectId?: string): Promise<DevServerSession[]> {
  try {
    const response = await api<BackendSessionsListResponse>(withProjectId("/devserver", projectId));
    return response.sessions ?? [];
  } catch {
    // Fallback: try to get the legacy single-server state and wrap it in session format
    try {
      const legacy = await fetchDevServerStatus(projectId);
      // Convert legacy state to session format
      const session: DevServerSession = {
        config: {
          id: legacy.id ?? "default",
          name: legacy.name ?? "Dev Server",
          command: legacy.command ?? "",
          cwd: legacy.cwd ?? ".",
        },
        status: legacy.status,
        runtime: legacy.pid
          ? {
            pid: legacy.pid,
            startedAt: legacy.startedAt ?? new Date().toISOString(),
            exitCode: legacy.exitCode ?? undefined,
            previewUrl: legacy.previewUrl,
          }
          : undefined,
        previewUrl: legacy.previewUrl ?? legacy.detectedUrl ?? undefined,
        logHistory: (legacy.logs ?? []).map<DevServerLogEntry>((text) => ({
          timestamp: new Date().toISOString(),
          stream: text.startsWith("[stderr]") ? "stderr" : "stdout",
          text: text.replace(/^\[stderr\]\s*/, ""),
        })),
      };
      return [session];
    } catch {
      return [];
    }
  }
}

/**
 * Create a new dev server session.
 * Targets /api/devserver with fallback to /api/dev-server/start (legacy compatibility).
 */
export async function createDevServer(
  data: { command: string; cwd?: string; name?: string; env?: Record<string, string> },
  projectId?: string,
): Promise<DevServerSession> {
  const body = {
    command: data.command,
    cwd: data.cwd ?? ".",
    name: data.name,
    env: data.env,
  };

  try {
    return await api<DevServerSession>(withProjectId("/devserver", projectId), {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch {
    // Fallback: use legacy start endpoint
    const legacy = await startDevServer({ command: data.command, cwd: data.cwd }, projectId);
    return {
      config: {
        id: legacy.id ?? "default",
        name: legacy.name ?? data.name ?? "Dev Server",
        command: legacy.command,
        cwd: legacy.cwd ?? data.cwd ?? ".",
      },
      status: legacy.status,
      runtime: legacy.pid
        ? {
          pid: legacy.pid,
          startedAt: legacy.startedAt ?? new Date().toISOString(),
          exitCode: legacy.exitCode ?? undefined,
          previewUrl: legacy.previewUrl,
        }
        : undefined,
      previewUrl: legacy.previewUrl ?? legacy.detectedUrl ?? undefined,
      logHistory: (legacy.logs ?? []).map<DevServerLogEntry>((text) => ({
        timestamp: new Date().toISOString(),
        stream: text.startsWith("[stderr]") ? "stderr" : "stdout",
        text: text.replace(/^\[stderr\]\s*/, ""),
      })),
    };
  }
}

/**
 * Fetch a specific dev server session by ID.
 * Targets /api/devserver/:id with fallback to /api/dev-server/status (legacy compatibility).
 */
export async function fetchDevServer(id: string, projectId?: string): Promise<DevServerSession | null> {
  try {
    return await api<DevServerSession>(withProjectId(`/devserver/${encodeURIComponent(id)}`, projectId));
  } catch {
    // Fallback: try legacy status endpoint (single-server model)
    try {
      const legacy = await fetchDevServerStatus(projectId);
      // If no ID or ID matches default, return legacy state as session
      if (!id || id === "default" || id === legacy.id) {
        return {
          config: {
            id: legacy.id ?? "default",
            name: legacy.name ?? "Dev Server",
            command: legacy.command ?? "",
            cwd: legacy.cwd ?? ".",
          },
          status: legacy.status,
          runtime: legacy.pid
            ? {
              pid: legacy.pid,
              startedAt: legacy.startedAt ?? new Date().toISOString(),
              exitCode: legacy.exitCode ?? undefined,
              previewUrl: legacy.previewUrl,
            }
            : undefined,
          previewUrl: legacy.previewUrl ?? legacy.detectedUrl ?? undefined,
          logHistory: (legacy.logs ?? []).map<DevServerLogEntry>((text) => ({
            timestamp: new Date().toISOString(),
            stream: text.startsWith("[stderr]") ? "stderr" : "stdout",
            text: text.replace(/^\[stderr\]\s*/, ""),
          })),
        };
      }
      return null;
    } catch {
      return null;
    }
  }
}

/**
 * Start a specific dev server by ID.
 * Targets /api/devserver/:id/start with fallback to /api/dev-server/start (legacy compatibility).
 */
export async function startDevServerById(id: string, projectId?: string): Promise<DevServerSession> {
  try {
    return await api<DevServerSession>(withProjectId(`/devserver/${encodeURIComponent(id)}/start`, projectId), {
      method: "POST",
    });
  } catch {
    // Fallback: use legacy start endpoint (single-server model)
    const legacy = await startDevServer({ command: "" }, projectId);
    return {
      config: {
        id: legacy.id ?? id,
        name: legacy.name ?? "Dev Server",
        command: legacy.command ?? "",
        cwd: legacy.cwd ?? ".",
      },
      status: legacy.status,
      runtime: legacy.pid
        ? {
          pid: legacy.pid,
          startedAt: legacy.startedAt ?? new Date().toISOString(),
          exitCode: legacy.exitCode ?? undefined,
          previewUrl: legacy.previewUrl,
        }
        : undefined,
      previewUrl: legacy.previewUrl ?? legacy.detectedUrl ?? undefined,
      logHistory: (legacy.logs ?? []).map<DevServerLogEntry>((text) => ({
        timestamp: new Date().toISOString(),
        stream: text.startsWith("[stderr]") ? "stderr" : "stdout",
        text: text.replace(/^\[stderr\]\s*/, ""),
      })),
    };
  }
}

/**
 * Stop a specific dev server by ID.
 * Targets /api/devserver/:id/stop with fallback to /api/dev-server/stop (legacy compatibility).
 */
export async function stopDevServerById(id: string, projectId?: string): Promise<DevServerSession> {
  try {
    return await api<DevServerSession>(withProjectId(`/devserver/${encodeURIComponent(id)}/stop`, projectId), {
      method: "POST",
    });
  } catch {
    // Fallback: use legacy stop endpoint
    const legacy = await stopDevServer(projectId);
    return {
      config: {
        id: legacy.id ?? id,
        name: legacy.name ?? "Dev Server",
        command: legacy.command ?? "",
        cwd: legacy.cwd ?? ".",
      },
      status: legacy.status,
      runtime: legacy.pid
        ? {
          pid: legacy.pid,
          startedAt: legacy.startedAt ?? new Date().toISOString(),
          exitCode: legacy.exitCode ?? undefined,
          previewUrl: legacy.previewUrl,
        }
        : undefined,
      previewUrl: legacy.previewUrl ?? legacy.detectedUrl ?? undefined,
      logHistory: (legacy.logs ?? []).map<DevServerLogEntry>((text) => ({
        timestamp: new Date().toISOString(),
        stream: text.startsWith("[stderr]") ? "stderr" : "stdout",
        text: text.replace(/^\[stderr\]\s*/, ""),
      })),
    };
  }
}

/**
 * Restart a specific dev server by ID.
 * Targets /api/devserver/:id/restart with fallback to /api/dev-server/restart (legacy compatibility).
 */
export async function restartDevServerById(id: string, projectId?: string): Promise<DevServerSession> {
  try {
    return await api<DevServerSession>(withProjectId(`/devserver/${encodeURIComponent(id)}/restart`, projectId), {
      method: "POST",
    });
  } catch {
    // Fallback: use legacy restart endpoint
    const legacy = await restartDevServer(projectId);
    return {
      config: {
        id: legacy.id ?? id,
        name: legacy.name ?? "Dev Server",
        command: legacy.command ?? "",
        cwd: legacy.cwd ?? ".",
      },
      status: legacy.status,
      runtime: legacy.pid
        ? {
          pid: legacy.pid,
          startedAt: legacy.startedAt ?? new Date().toISOString(),
          exitCode: legacy.exitCode ?? undefined,
          previewUrl: legacy.previewUrl,
        }
        : undefined,
      previewUrl: legacy.previewUrl ?? legacy.detectedUrl ?? undefined,
      logHistory: (legacy.logs ?? []).map<DevServerLogEntry>((text) => ({
        timestamp: new Date().toISOString(),
        stream: text.startsWith("[stderr]") ? "stderr" : "stdout",
        text: text.replace(/^\[stderr\]\s*/, ""),
      })),
    };
  }
}

/**
 * Delete a specific dev server by ID.
 * Targets /api/devserver/:id with fallback (no legacy equivalent).
 */
export async function deleteDevServer(id: string, projectId?: string): Promise<void> {
  try {
    await api<void>(withProjectId(`/devserver/${encodeURIComponent(id)}`, projectId), {
      method: "DELETE",
    });
  } catch {
    // No fallback for delete in legacy API (single-server model)
    // Silently ignore - deletion may not be supported in legacy mode
  }
}

/**
 * Fetch logs for a specific dev server by ID.
 * Targets /api/devserver/:id/logs with fallback to /api/dev-server/logs/history (legacy compatibility).
 */
export async function fetchDevServerLogs(
  id: string,
  opts: FetchDevServerLogsOptions = {},
  projectId?: string,
): Promise<{ lines: DevServerLogEntry[]; totalLines: number }> {
  const query = new URLSearchParams();
  if (typeof opts.maxLines === "number" && Number.isFinite(opts.maxLines)) {
    query.set("maxLines", String(Math.max(1, Math.floor(opts.maxLines))));
  }
  if (typeof opts.offset === "number" && Number.isFinite(opts.offset)) {
    query.set("offset", String(Math.max(0, Math.floor(opts.offset))));
  }
  if (typeof opts.lastEventId === "number" && Number.isFinite(opts.lastEventId)) {
    query.set("lastEventId", String(Math.max(0, Math.floor(opts.lastEventId))));
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";

  try {
    const response = await api<BackendSessionLogResponse>(
      withProjectId(`/devserver/${encodeURIComponent(id)}/logs${suffix}`, projectId),
    );
    return {
      lines: response.lines ?? [],
      totalLines: response.totalLines ?? response.lines?.length ?? 0,
    };
  } catch {
    // Fallback: use legacy log history endpoint
    try {
      const response = await fetchDevServerLogHistory(opts, projectId);
      return {
        lines: response.lines.map<DevServerLogEntry>((entry) => ({
          timestamp: entry.timestamp,
          stream: entry.stream,
          text: entry.text,
        })),
        totalLines: response.totalLines,
      };
    } catch {
      return { lines: [], totalLines: 0 };
    }
  }
}

/**
 * Fetch preview URL for a specific dev server by ID.
 * Targets /api/devserver/:id/preview with fallback to /api/dev-server/status (legacy compatibility).
 */
export async function fetchDevServerPreview(id: string, projectId?: string): Promise<DevServerPreviewResponse> {
  try {
    const response = await api<BackendPreviewResponse>(
      withProjectId(`/devserver/${encodeURIComponent(id)}/preview`, projectId),
    );
    return {
      url: response.url ?? null,
      source: (response.source as DevServerPreviewResponse["source"]) ?? null,
    };
  } catch {
    // Fallback: use legacy status endpoint
    try {
      const legacy = await fetchDevServerStatus(projectId);
      return {
        url: legacy.previewUrl ?? legacy.detectedUrl ?? legacy.manualUrl ?? null,
        source: legacy.manualUrl ? "manual" : "auto",
      };
    } catch {
      return { url: null, source: null };
    }
  }
}

/**
 * Set preview URL for a specific dev server by ID.
 * Targets /api/devserver/:id/preview with fallback to /api/dev-server/preview-url (legacy compatibility).
 */
export async function setDevServerPreviewUrlById(
  id: string,
  url: string | null,
  projectId?: string,
): Promise<DevServerPreviewResponse> {
  try {
    const response = await api<BackendPreviewResponse>(
      withProjectId(`/devserver/${encodeURIComponent(id)}/preview`, projectId),
      {
        method: "POST",
        body: JSON.stringify({ url }),
      },
    );
    return {
      url: response.url ?? null,
      source: (response.source as DevServerPreviewResponse["source"]) ?? null,
    };
  } catch {
    // Fallback: use legacy preview URL endpoint
    const legacy = await setDevServerPreviewUrl({ url }, projectId);
    return {
      url: legacy.previewUrl ?? legacy.manualUrl ?? null,
      source: "manual",
    };
  }
}

/**
 * Detect available dev server commands.
 * Targets /api/devserver/detect with fallback to /api/dev-server/detect (legacy compatibility).
 */
export async function detectDevServerCommands(projectId?: string): Promise<DetectedDevServerCommand[]> {
  try {
    const response = await api<BackendDetectCommandsResponse>(withProjectId("/devserver/detect", projectId));
    return response.candidates ?? [];
  } catch {
    // Fallback: use legacy detect endpoint
    try {
      const legacy = await fetchDevServerCandidates(projectId);
      return legacy.map<DetectedDevServerCommand>((candidate) => ({
        name: candidate.name,
        command: candidate.command,
        cwd: candidate.cwd,
        scriptName: candidate.scriptName,
        packagePath: candidate.packagePath,
      }));
    } catch {
      return [];
    }
  }
}

/**
 * Get the SSE stream URL for a specific dev server session's logs.
 * Targets /api/devserver/:id/logs/stream with fallback to /api/dev-server/logs/stream (legacy compatibility).
 */
export function getDevServerSessionLogsStreamUrl(id: string, projectId?: string): string {
  // Try new session-scoped endpoint first
  return buildApiUrl(withProjectId(`/devserver/${encodeURIComponent(id)}/logs/stream`, projectId));
}


/** Get the SSE stream URL for a planning session */
export function getPlanningStreamUrl(sessionId: string, projectId?: string): string {
  return buildApiUrl(withProjectId(`/planning/${encodeURIComponent(sessionId)}/stream`, projectId));
}

export function getAgentOnboardingStreamUrl(sessionId: string, projectId?: string): string {
  return buildApiUrl(withProjectId(`/agents/onboarding/${encodeURIComponent(sessionId)}/stream`, projectId));
}

export function connectAgentOnboardingStream(
  sessionId: string,
  projectId: string | undefined,
  handlers: {
    onThinking?: (data: string) => void;
    onQuestion?: (data: PlanningQuestion) => void;
    onSummary?: (data: AgentOnboardingSummary) => void;
    onError?: (data: string) => void;
    onComplete?: () => void;
    onConnectionStateChange?: (state: StreamConnectionState) => void;
  },
  options?: { maxReconnectAttempts?: number },
): { close: () => void; isConnected: () => boolean } {
  const url = getAgentOnboardingStreamUrl(sessionId, projectId);
  const resilient = createResilientEventSource(
    url,
    {
      events: {
        thinking: (event) => {
          try { handlers.onThinking?.(JSON.parse(event.data)); } catch { handlers.onThinking?.(event.data); }
        },
        question: (event) => {
          try { handlers.onQuestion?.(JSON.parse(event.data) as PlanningQuestion); } catch { /* ignore parse error */ }
        },
        summary: (event) => {
          try { handlers.onSummary?.(JSON.parse(event.data) as AgentOnboardingSummary); } catch { /* ignore parse error */ }
        },
        error: (event) => {
          try {
            const parsed = JSON.parse(event.data);
            handlers.onError?.(parsed.message || parsed);
          } catch {
            handlers.onError?.(event.data || "Stream error");
          }
        },
        complete: () => {
          handlers.onComplete?.();
        },
      },
    },
    {
      maxReconnectAttempts: options?.maxReconnectAttempts,
      onConnectionStateChange: handlers.onConnectionStateChange,
      onFatalError: (message) => handlers.onError?.(message),
    },
  );

  return {
    close: resilient.close,
    isConnected: resilient.isConnected,
  };
}

/** Connect to planning session SSE stream and handle events
 * 
 * Returns an object with:
 * - close: function to close the connection
 */
export function connectPlanningStream(
  sessionId: string,
  projectId: string | undefined,
  handlers: {
    onThinking?: (data: string) => void;
    onQuestion?: (data: PlanningQuestion) => void;
    onSummary?: (data: PlanningSummary) => void;
    onError?: (data: string) => void;
    onComplete?: () => void;
    onConnectionStateChange?: (state: StreamConnectionState) => void;
  },
  options?: { maxReconnectAttempts?: number },
): { close: () => void; isConnected: () => boolean } {
  const url = getPlanningStreamUrl(sessionId, projectId);
  let keepAlive: { stop: () => void } | null = null;
  let connection: { close: () => void; isConnected: () => boolean } | null = null;

  const stopKeepAlive = () => {
    keepAlive?.stop();
    keepAlive = null;
  };

  const resilient = createResilientEventSource(
    url,
    {
      onOpen: () => {
        stopKeepAlive();
        keepAlive = startKeepAlive(sessionId, projectId);
      },
      onMessage: (event) => {
        if (event.data.startsWith(":")) return;
      },
      events: {
        thinking: (event) => {
          try {
            handlers.onThinking?.(JSON.parse(event.data));
          } catch {
            handlers.onThinking?.(event.data);
          }
        },
        question: (event) => {
          try {
            handlers.onQuestion?.(JSON.parse(event.data) as PlanningQuestion);
          } catch (err) {
            console.error("[planning] Failed to parse question event:", err);
          }
        },
        summary: (event) => {
          try {
            handlers.onSummary?.(JSON.parse(event.data) as PlanningSummary);
          } catch (err) {
            console.error("[planning] Failed to parse summary event:", err);
          }
        },
        error: (event) => {
          try {
            const parsed = JSON.parse(event.data);
            handlers.onError?.(parsed.message || parsed);
          } catch {
            handlers.onError?.(event.data || "Stream error");
          }
          connection?.close();
        },
        complete: () => {
          handlers.onComplete?.();
          connection?.close();
        },
      },
    },
    {
      maxReconnectAttempts: options?.maxReconnectAttempts,
      onConnectionStateChange: handlers.onConnectionStateChange,
      onFatalError: (message) => {
        stopKeepAlive();
        handlers.onError?.(message);
      },
    },
  );

  connection = {
    close: () => {
      stopKeepAlive();
      resilient.close();
    },
    isConnected: resilient.isConnected,
  };

  return connection;
}

/*
 * FNXC:CodeOrganization 2026-07-19-12:00:
 * Preserve legacy `scheduling` imports while implementations live in scheduling.ts.
 */
export {
  clearActivityLog,
  createAutomation,
  createRoutine,
  deleteAutomation,
  deleteRoutine,
  fetchActivityLog,
  fetchAutomation,
  fetchAutomations,
  fetchRoutine,
  fetchRoutineRuns,
  fetchRoutines,
  fetchWorkflowResults,
  fetchWorkflowSteps,
  reorderAutomationSteps,
  runAutomation,
  runRoutine,
  streamRoutineRun,
  toggleAutomation,
  triggerRoutineWebhook,
  updateAutomation,
  updateRoutine,
} from "./scheduling.js";
export type {
  ActivityEventType,
  ActivityLogEntry,
  AutomationRunResponse,
  RoutineRunResponse,
  RoutineRunStreamEvent,
  RoutineRunStreamHandlers,
  SchedulingScopeOptions,
} from "./scheduling.js";

/*
 * FNXC:CodeOrganization 2026-07-19-12:00:
 * Preserve legacy `workflows` imports while implementations live in workflows.ts.
 */
export {
  addScript,
  approveTaskWorkflowCli,
  createWorkflow,
  deleteWorkflow,
  designWorkflow,
  exportWorkflow,
  fetchPluginWorkflowStepTemplates,
  fetchProjectDefaultWorkflow,
  fetchScripts,
  fetchStepParsers,
  fetchTaskWorkflow,
  fetchTraits,
  fetchWorkflow,
  fetchWorkflowOptionalSteps,
  fetchWorkflowPromptOverrides,
  fetchWorkflowSettingValues,
  fetchWorkflowStepTemplates,
  fetchWorkflows,
  importWorkflow,
  removeScript,
  runScript,
  selectTaskWorkflow,
  setProjectDefaultWorkflow,
  submitTaskWorkflowInput,
  updateWorkflow,
  updateWorkflowPromptOverrides,
  updateWorkflowSettingValues,
} from "./workflows.js";
export type {
  DesignWorkflowResult,
  ImportWorkflowResult,
  ScriptEntry,
  ScriptRunResult,
  TraitCatalogEntry,
  WorkflowDefinition,
  WorkflowDefinitionInput,
  WorkflowDefinitionUpdate,
  WorkflowExportEnvelope,
  WorkflowIr,
  WorkflowPromptOverridesPayload,
  WorkflowSettingValuesPayload,
  WorkflowStepTemplate,
} from "./workflows.js";

/*
 * FNXC:CodeOrganization 2026-07-19-12:00:
 * Preserve legacy `ai-text` imports while implementations live in ai-text.ts.
 */
export {
  REFINE_ERROR_MESSAGES,
  TRANSLATE_ERROR_MESSAGES,
  autoTranslateImportIssues,
  cancelSubtaskBreakdown,
  connectSubtaskStream,
  createTasksFromBreakdown,
  draftGoalDescription,
  getRefineErrorMessage,
  getSubtaskStreamUrl,
  getTranslateErrorMessage,
  refineText,
  retrySubtaskSession,
  startSubtaskBreakdown,
  translateImportContent,
} from "./ai-text.js";
export type {
  AutoTranslateImportItem,
  AutoTranslateImportResponse,
  DraftGoalDescriptionResponse,
  PlanningSubtaskDraft,
  RefineTextResponse,
  RefinementType,
  SubtaskItem,
  TranslateImportContentResponse,
  TranslateImportFields,
} from "./ai-text.js";

/*
 * FNXC:CodeOrganization 2026-07-19-12:00:
 * Preserve legacy `agents` imports while implementations live in agents.ts.
 */
export {
  createAgent,
  deleteAgent,
  deleteAgentAvatar,
  fetchAgent,
  fetchAgentHeartbeats,
  fetchAgentMemory,
  fetchAgentMemoryFile,
  fetchAgentMemoryFiles,
  fetchAgentPromptSizes,
  fetchAgentRunDetail,
  fetchAgentRunLogs,
  fetchAgentRuns,
  fetchAgentSoul,
  fetchAgents,
  fetchWorkspaceRepos,
  recordAgentHeartbeat,
  saveAgentMemoryFile,
  startAgentRun,
  stopAgentRun,
  updateAgent,
  updateAgentInstructions,
  updateAgentMemory,
  updateAgentSoul,
  updateAgentState,
  upgradeAgentHeartbeatProcedure,
  uploadAgentAvatar,
} from "./agents.js";
export type {
  Agent,
  AgentBudgetStatus,
  AgentCapability,
  AgentCreateInput,
  AgentDetail,
  AgentHeartbeatEvent,
  AgentHeartbeatRun,
  AgentPerformanceSummary,
  AgentPromptSizePoint,
  AgentReflection,
  AgentState,
  AgentStats,
  AgentTaskSession,
  AgentUpdateInput,
  HeartbeatInvocationSource,
  OrgTreeNode,
  ReflectionTrigger,
} from "./agents.js";

// ── Run-Audit & Timeline API ────────────────────────────────────────────────

/** Valid domain filters for run-audit queries. */
export type RunAuditDomainFilter = "database" | "git" | "filesystem" | "sandbox";

/** Filter options for run-audit queries. */
export interface RunAuditFilters {
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

/** Normalized run-audit event for UI consumption. */
export interface NormalizedRunAuditEvent {
  id: string;
  timestamp: string;
  taskId?: string;
  domain: "database" | "git" | "filesystem" | "sandbox";
  mutationType: string;
  target: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

/** Response shape for run-audit endpoint. */
export interface RunAuditResponse {
  runId: string;
  events: NormalizedRunAuditEvent[];
  filters: {
    taskId?: string;
    domain?: RunAuditDomainFilter;
    startTime?: string;
    endTime?: string;
  };
  totalCount: number;
  hasMore: boolean;
}

/** Unified timeline entry that can represent either an audit event or an agent log entry. */
export interface TimelineEntry {
  timestamp: string;
  type: "audit" | "log";
  sortKey: string;
  audit?: NormalizedRunAuditEvent;
  log?: AgentLogEntry;
}

/** Response shape for run-timeline endpoint. */
export interface RunTimelineResponse {
  run: {
    id: string;
    agentId: string;
    startedAt: string;
    endedAt?: string;
    status: string;
    taskId?: string;
  };
  auditByDomain: {
    database: NormalizedRunAuditEvent[];
    git: NormalizedRunAuditEvent[];
    filesystem: NormalizedRunAuditEvent[];
    sandbox: NormalizedRunAuditEvent[];
  };
  counts: {
    auditEvents: number;
    logEntries: number;
  };
  timeline: TimelineEntry[];
}

/**
 * Fetch normalized run-audit events for a specific agent run.
 *
 * @param agentId - The agent ID
 * @param runId - The run ID
 * @param filters - Optional filter parameters
 * @param projectId - Optional project ID for multi-project workspaces
 * @returns Promise resolving to RunAuditResponse with normalized events
 * @throws Error if runId is blank or whitespace-only
 */
export function fetchAgentRunAudit(
  agentId: string,
  runId: string,
  filters?: RunAuditFilters,
  projectId?: string,
): Promise<RunAuditResponse> {
  // Validate runId before making API call
  if (!runId || runId.trim().length === 0) {
    throw new Error("runId is required");
  }

  const params = new URLSearchParams();
  if (filters?.taskId) params.set("taskId", filters.taskId);
  if (filters?.domain) params.set("domain", filters.domain);
  if (filters?.startTime) params.set("startTime", filters.startTime);
  if (filters?.endTime) params.set("endTime", filters.endTime);
  if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<RunAuditResponse>(
    withProjectId(`/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/audit${query}`, projectId),
  );
}

/**
 * Fetch a correlated timeline combining run-audit events and agent logs for a specific run.
 *
 * @param agentId - The agent ID
 * @param runId - The run ID
 * @param options - Optional parameters
 * @param options.taskId - Override task ID for audit filtering (defaults to run's contextSnapshot.taskId)
 * @param options.domain - Filter audit events by domain
 * @param options.startTime - Start of time range (ISO-8601)
 * @param options.endTime - End of time range (ISO-8601)
 * @param options.includeLogs - Whether to include agent logs (default true)
 * @param options.limit - Maximum audit events to return
 * @param projectId - Optional project ID for multi-project workspaces
 * @returns Promise resolving to RunTimelineResponse with merged timeline
 * @throws Error if runId is blank or whitespace-only
 */
export function fetchAgentRunTimeline(
  agentId: string,
  runId: string,
  options?: {
    taskId?: string;
    domain?: RunAuditDomainFilter;
    startTime?: string;
    endTime?: string;
    includeLogs?: boolean;
    limit?: number;
  },
  projectId?: string,
): Promise<RunTimelineResponse> {
  // Validate runId before making API call
  if (!runId || runId.trim().length === 0) {
    throw new Error("runId is required");
  }

  const params = new URLSearchParams();
  if (options?.taskId) params.set("taskId", options.taskId);
  if (options?.domain) params.set("domain", options.domain);
  if (options?.startTime) params.set("startTime", options.startTime);
  if (options?.endTime) params.set("endTime", options.endTime);
  if (options?.includeLogs !== undefined) params.set("includeLogs", String(options.includeLogs));
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<RunTimelineResponse>(
    withProjectId(`/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/timeline${query}`, projectId),
  );
}

/** Fetch aggregate agent stats */
export function fetchAgentStats(projectId?: string, options?: FetchOptions): Promise<AgentStats> {
  const path = withProjectId("/agents/stats", projectId);
  return dedupe(path, () => api<AgentStats>(path), options);
}

/** Fetch the chain of command for an agent (self → manager → grand-manager → ...) */
export function fetchChainOfCommand(agentId: string, projectId?: string): Promise<Agent[]> {
  return api<Agent[]>(withProjectId(`/agents/${encodeURIComponent(agentId)}/chain-of-command`, projectId));
}

/** Fetch the full org tree as nested nodes */
export function fetchOrgTree(projectId?: string, options?: { includeEphemeral?: boolean }): Promise<OrgTreeNode[]> {
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  if (options?.includeEphemeral) params.set("includeEphemeral", "true");
  const query = params.toString();
  return api<OrgTreeNode[]>(`/agents/org-tree${query ? `?${query}` : ""}`);
}

/** Resolve an agent by shortname or ID */
export function resolveAgent(shortname: string, projectId?: string): Promise<{ agent: Agent }> {
  return api<{ agent: Agent }>(withProjectId(`/agents/resolve/${encodeURIComponent(shortname)}`, projectId));
}

/** Fetch employees (agents that report to a given parent agent) */
export function fetchAgentChildren(agentId: string, projectId?: string): Promise<Agent[]> {
  return api<Agent[]>(withProjectId(`/agents/${encodeURIComponent(agentId)}/children`, projectId)).catch((err: Error) => {
    // Return empty array for 404 (agent may have been deleted)
    if (err.message.includes("not found")) return [];
    throw err;
  });
}

/** Alias for fetchAgentChildren with employee-focused naming */
export const fetchAgentEmployees = fetchAgentChildren;

/** Assign or unassign a task to an explicit agent */
export function assignTask(taskId: string, agentId: string | null, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/assign`, projectId), {
    method: "PATCH",
    body: JSON.stringify({ agentId }),
  });
}

/** Assign or unassign a task to a user (for review handoff) */
export function assignTaskToUser(taskId: string, userId: string | null, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/assign-user`, projectId), {
    method: "PATCH",
    body: JSON.stringify({ userId }),
  });
}

/** Accept review - clear assignee and awaiting-user-review status, keep in in-review */
export function acceptTaskReview(taskId: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/accept-review`, projectId), {
    method: "POST",
  });
}

function mapTaskReviewDataToLegacy(data: TaskReviewData): TaskReviewResponse {
  const fetchedAt = data.fetchedAt ?? undefined;
  const canonicalItems = data.items.map((item) => ({
    id: item.itemId,
    body: item.body,
    author: { login: item.author },
    createdAt: item.createdAt ?? new Date(0).toISOString(),
    updatedAt: item.updatedAt ?? undefined,
    path: item.filePath,
    threadId: item.threadId,
    htmlUrl: item.url,
    state: item.reviewState ?? undefined,
    summary: item.title ?? undefined,
    isResolved: item.isResolved,
    ...(typeof item.line === "number" ? { line: item.line } : {}),
  }));

  return {
    reviewState: {
      source: data.mode,
      summary: data.summary ?? undefined,
      items: canonicalItems,
      addressing: data.items
        .filter((item) => item.progressStatus != null)
        .map((item) => ({
          itemId: item.itemId,
          status: item.progressStatus ?? "queued",
          selectedAt: item.createdAt ?? fetchedAt ?? new Date(0).toISOString(),
          snapshot: {
            itemId: item.itemId,
            sourceMode: item.sourceMode,
            source: item.sourceMode === "pull-request" ? "pr-review" : "reviewer-agent",
            summary: item.title || item.body.slice(0, 120),
            body: item.body,
            authorLogin: item.author,
            filePath: item.filePath,
            lineNumber: item.line,
            threadId: item.threadId,
            url: item.url,
          },
        })),
      lastRefreshedAt: fetchedAt,
      refreshStatus: "ready",
      refreshSource: "initial-load",
    },
    automationStatus: null,
  };
}

/** Fetch normalized task review data (PR mode or direct mode) */
export async function fetchTaskReview(taskId: string, projectId?: string): Promise<TaskReviewResponse> {
  const data = await api<TaskReviewData>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/review`, projectId));
  return mapTaskReviewDataToLegacy(data);
}

/** Fetch canonical review payload for future review-tab rendering. */
export function fetchTaskReviewData(taskId: string, projectId?: string): Promise<TaskReviewData> {
  return api<TaskReviewData>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/review`, projectId));
}

/** Refresh normalized task review data (PR mode or direct mode) */
export async function refreshTaskReview(taskId: string, projectId?: string): Promise<RefreshTaskReviewResponse> {
  const data = await api<TaskReviewData>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/review/refresh`, projectId), {
    method: "POST",
  });
  return mapTaskReviewDataToLegacy(data);
}

/** Refresh canonical review payload for future review-tab rendering. */
export function refreshTaskReviewData(taskId: string, projectId?: string): Promise<TaskReviewData> {
  return api<TaskReviewData>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/review/refresh`, projectId), {
    method: "POST",
  });
}

/** Request an in-place revision pass for selected review items */
export function reviseTaskReviewItems(taskId: string, selectedItems: SelectedReviewItem[], projectId?: string): Promise<ReviseTaskReviewResponse> {
  return api<ReviseTaskReviewResponse>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/review/address`, projectId), {
    method: "POST",
    body: JSON.stringify({ selectedItems, tab: "review" }),
  });
}

/** Request an AI pass that addresses open pull-request feedback for the task's primary PR. */
export function addressPrFeedback(taskId: string, projectId?: string): Promise<AddressPrFeedbackResponse> {
  return api<AddressPrFeedbackResponse>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/pr/address-feedback`, projectId), {
    method: "POST",
  });
}

/** Return task to agent - clear assignee and status, move to todo */
export function returnTaskToAgent(taskId: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/return-to-agent`, projectId), {
    method: "POST",
  });
}

/** Fetch tasks explicitly assigned to an agent */
export function fetchAgentTasks(agentId: string, projectId?: string): Promise<Task[]> {
  return api<Task[]>(withProjectId(`/agents/${encodeURIComponent(agentId)}/tasks`, projectId));
}

// ── Agent Import API ────────────────────────────────────────────────────────

/** Company entry from companies.sh catalog */
export interface CompanyEntry {
  slug: string;
  name: string;
  tagline?: string;
  repo?: string;
  website?: string;
  installs?: number;
}

/** Response from companies.sh catalog API */
export interface CompaniesCatalogResponse {
  companies: CompanyEntry[];
  error?: string;
}

/** Result of importing agents from an Agent Companies source */
export interface AgentImportResult {
  companyName?: string;
  companySlug?: string;
  agents?: Array<{ name: string; role: string; title?: string; skills?: string[] }>;
  /** In dry-run mode: agent name strings. In live mode: agent objects with id and name. */
  created: string[] | Array<{ id: string; name: string }>;
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
  dryRun?: boolean;
}

/**
 * Fetch companies from companies.sh catalog.
 * Returns both companies and optional error message for proper error surfacing.
 */
export function fetchCompanies(): Promise<CompaniesCatalogResponse> {
  return api<CompaniesCatalogResponse>("/agents/companies");
}

/**
 * Import agents from an Agent Companies source via the API.
 * Uses dryRun for preview, then actual import.
 *
 * Supports four input modes:
 * - { manifest: string } - raw AGENTS.md content
 * - { source: string } - server directory path
 * - { agents: unknown[] } - parsed agent manifests
 * - { importSource: "companies.sh", companySlug: string } - companies.sh catalog entry
 */
export function importAgents(
  input:
    | { manifest: string }
    | { source: string }
    | { agents: unknown[] }
    | { importSource: "companies.sh"; companySlug: string },
  options?: { dryRun?: boolean; skipExisting?: boolean },
  projectId?: string,
): Promise<AgentImportResult> {
  return api<AgentImportResult>(withProjectId("/agents/import", projectId), {
    method: "POST",
    body: JSON.stringify({
      ...input,
      dryRun: options?.dryRun ?? false,
      skipExisting: options?.skipExisting ?? true,
    }),
  });
}

// ── Agent Generation API ────────────────────────────────────────────────────

/** Generated agent specification returned by the AI */
export interface AgentGenerationSpec {
  /** Display name for the agent */
  title: string;
  /** Single emoji icon */
  icon: string;
  /** Agent capability/role */
  role: string;
  /** Brief description of the agent's purpose */
  description: string;
  /** Detailed system prompt in markdown */
  systemPrompt: string;
  /** Suggested thinking level */
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Suggested max turns (1-500) */
  maxTurns: number;
}

/** State of an agent generation session */
export interface AgentGenerationSession {
  id: string;
  roleDescription: string;
  spec?: AgentGenerationSpec;
  createdAt: string;
  updatedAt: string;
}

/** Start an agent generation session with a role description */
export function startAgentGeneration(role: string, projectId?: string): Promise<{ sessionId: string; roleDescription: string }> {
  return api<{ sessionId: string; roleDescription: string }>(withProjectId("/agents/generate/start", projectId), {
    method: "POST",
    body: JSON.stringify({ role }),
  });
}

/** Generate the agent specification for an existing session */
export function generateAgentSpec(sessionId: string, projectId?: string): Promise<{ spec: AgentGenerationSpec }> {
  return api<{ spec: AgentGenerationSpec }>(withProjectId("/agents/generate/spec", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

/** Get the current state of an agent generation session */
export function getAgentGenerationSession(sessionId: string, projectId?: string): Promise<{ session: AgentGenerationSession }> {
  return api<{ session: AgentGenerationSession }>(withProjectId(`/agents/generate/${encodeURIComponent(sessionId)}`, projectId));
}

/** Cancel and clean up an agent generation session */
export function cancelAgentGeneration(sessionId: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId(`/agents/generate/${encodeURIComponent(sessionId)}`, projectId), {
    method: "DELETE",
  });
}

// --- Backup API ---

/** Backup metadata from the API */
export interface BackupInfo {
  filename: string;
  createdAt: string;
  size: number;
  path: string;
}

/** Result of listing backups */
export interface BackupListResponse {
  backups: BackupInfo[];
  count: number;
  totalSize: number;
}

/** Result of creating a backup */
export interface BackupCreateResponse {
  success: boolean;
  backupPath?: string;
  output?: string;
  deletedCount?: number;
  error?: string;
}

/** Fetch all database backups */
export function fetchBackups(projectId?: string): Promise<BackupListResponse> {
  return api<BackupListResponse>(withProjectId("/backups", projectId));
}

/** Create a new database backup immediately */
export function createBackup(projectId?: string): Promise<BackupCreateResponse> {
  return api<BackupCreateResponse>(withProjectId("/backups", projectId), { method: "POST" });
}

// --- Settings Export/Import API ---

/** Exported settings data structure */
export interface SettingsExportData {
  version: 1;
  exportedAt: string;
  source?: string;
  global?: GlobalSettings;
  project?: Partial<ProjectSettings>;
}

/** Result of importing settings */
export interface SettingsImportResponse {
  success: boolean;
  globalCount: number;
  projectCount: number;
  workflowSettingsCount: number;
  error?: string;
}

/** Export settings as JSON */
export function exportSettings(scope?: 'global' | 'project' | 'both', projectId?: string): Promise<SettingsExportData> {
  const path = withProjectId("/settings/export", projectId);
  const scopedPath = scope ? `${path}${path.includes("?") ? "&" : "?"}scope=${encodeURIComponent(scope)}` : path;
  return api<SettingsExportData>(scopedPath);
}

/** Import settings from JSON data */
export function importSettings(
  data: SettingsExportData,
  options?: { scope?: 'global' | 'project' | 'both'; merge?: boolean },
  projectId?: string
): Promise<SettingsImportResponse> {
  return api<SettingsImportResponse>(withProjectId("/settings/import", projectId), {
    method: "POST",
    body: JSON.stringify({
      data,
      scope: options?.scope ?? "both",
      merge: options?.merge ?? true,
    }),
  });
}

// --- AI Summarization API ---

/** Response from title summarization endpoint */
export interface SummarizeTitleResponse {
  title: string;
}

/** Summarize a task description into a concise title using AI.
 * @param description - The task description to summarize (must be >200 chars; model input is truncated)
 * @param provider - Optional AI model provider (e.g., "anthropic")
 * @param modelId - Optional AI model ID (e.g., "claude-sonnet-4-5")
 * @param projectId - Optional project ID for scoped settings resolution
 * @returns The generated title (guaranteed ≤60 characters)
 * @throws Error with descriptive message for 400/429/503 errors
 */
export async function summarizeTitle(
  description: string,
  provider?: string,
  modelId?: string,
  projectId?: string
): Promise<string> {
  const url = projectId
    ? `/api/ai/summarize-title?projectId=${encodeURIComponent(projectId)}`
    : "/api/ai/summarize-title";
  const res = await fetch(url, {
    method: "POST",
    headers: withTokenHeader({ "Content-Type": "application/json" }),
    body: JSON.stringify({ description, provider, modelId }),
  });

  const contentType = res.headers.get("content-type") ?? "";
  const bodyText = await res.text();
  const isJson = contentType.includes("application/json");

  if (!isJson) {
    throw new Error(`API returned non-JSON response: ${bodyText.slice(0, 100)}`);
  }

  const data = JSON.parse(bodyText) as { title?: string; error?: string };

  if (!res.ok) {
    const errorMessage = data.error || "Request failed";
    if (res.status === 400) {
      throw new Error(`Invalid request: ${errorMessage}`);
    } else if (res.status === 429) {
      throw new Error(`Rate limit exceeded: ${errorMessage}`);
    } else if (res.status === 503) {
      throw new Error(`AI service temporarily unavailable: ${errorMessage}`);
    } else {
      throw new Error(errorMessage);
    }
  }

  if (!data.title) {
    throw new Error("API returned empty title");
  }

  return data.title;
}

/*
 * FNXC:CodeOrganization 2026-07-19-12:00:
 * Preserve legacy `projects` imports while implementations live in projects.ts.
 */
export {
  apiBackfillGithubSourceIssueClosedAt,
  browseDirectory,
  checkNodeHealth,
  completeSetup,
  connectDiscoveredNode,
  createDirectory,
  createManagedDockerNode,
  detectProjects,
  detectWorkspace,
  discoverRemoteNodeProjects,
  fetchActivityFeed,
  fetchCodebaseMetrics,
  fetchDiscoveredNodes,
  fetchDiscoveryStatus,
  fetchDockerConfigDiff,
  fetchDockerNodeConfig,
  fetchDockerNodeLogs,
  fetchExecutorStats,
  fetchFirstRunStatus,
  fetchGlobalConcurrency,
  fetchManagedDockerNode,
  fetchManagedDockerNodeContainerStatus,
  fetchManagedDockerNodes,
  fetchMeshEngines,
  fetchMeshState,
  fetchNode,
  fetchNodeMetrics,
  fetchNodePathMappings,
  fetchNodeSystemStats,
  fetchNodes,
  fetchProject,
  fetchProjectConfig,
  fetchProjectHealth,
  fetchProjectPathMapping,
  fetchProjectPathMappings,
  fetchProjectTasks,
  fetchProjects,
  fetchProjectsAcrossNodes,
  fetchSetupState,
  fetchSystemStats,
  hasNodeMappingsSupport,
  killVitestProcesses,
  listManagedDockerNodes,
  pauseProject,
  registerNode,
  registerProject,
  removeProjectPathMapping,
  replaceDockerNodeConfig,
  resumeProject,
  startDiscovery,
  stopDiscovery,
  unregisterNode,
  unregisterProject,
  updateDockerNodeConfig,
  updateGlobalConcurrency,
  updateNode,
  updateProject,
  upsertProjectPathMapping,
} from "./projects.js";
export type {
  ActivityFeedEntry,
  BrowseDirectoryResult,
  CodebaseMetrics,
  CompleteSetupInput,
  CompleteSetupResult,
  ContainerStatusInfo,
  DetectedProject,
  DiscoveredNodeInfo,
  DockerNodeConfig,
  DockerNodeConfigInfo,
  DockerNodeInfo,
  ExecutorState,
  ExecutorStats,
  FeedOptions,
  FirstRunStatus,
  GithubSourceIssueClosedAtBackfillResult,
  GlobalConcurrencyState,
  KillVitestResponse,
  ManagedDockerNodeInfo,
  MeshEngineStatusApi,
  MeshEnginesResponse,
  NodeCreateInput,
  NodeHealthCheckResult,
  NodeInfo,
  NodeMetrics,
  NodeOnboardingInput,
  NodeProjectMappingInput,
  NodeUpdateInput,
  ProjectCreateInput,
  ProjectHealth,
  ProjectInfo,
  ProjectInfoWithSource,
  ProjectNodeAvailability,
  RemoteNodeDiscoveredProject,
  RemoteNodeProjectDiscoveryResult,
  SetupState,
  SystemStatsResponse,
  SystemStatsSnapshot,
  TaskStatsSnapshot,
} from "./projects.js";

// ── Task Diff API ──────────────────────────────────────────────────────────

/** Task diff information */
export interface TaskDiff {
  files: Array<{
    path: string;
    status: "added" | "modified" | "deleted";
    additions: number;
    deletions: number;
    patch: string;
  }>;
  stats: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };
}

/** Fetch diff for a task's changes */
export function fetchTaskDiff(taskId: string, worktree?: string, projectId?: string): Promise<TaskDiff> {
  const params = new URLSearchParams();
  if (worktree) params.set("worktree", worktree);
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<TaskDiff>(`/tasks/${encodeURIComponent(taskId)}/diff${query}`);
}

export interface TaskCommitAssociationRow {
  commitSha: string;
  commitSubject: string;
  authoredAt: string;
  matchedBy: "canonical-lineage-trailer" | "legacy-task-id-trailer" | "legacy-subject" | "manual-reconciliation";
  confidence: "canonical" | "legacy" | "ambiguous";
  taskIdSnapshot: string;
  note?: string;
}

export interface TaskCommitAssociationsResponse {
  taskId: string;
  lineageId: string | null;
  associations: TaskCommitAssociationRow[];
}

/** Fetch lineage commit associations for a task */
export function fetchTaskCommitAssociations(taskId: string, projectId?: string): Promise<TaskCommitAssociationsResponse> {
  return api<TaskCommitAssociationsResponse>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/commit-associations`, projectId));
}

/** Individual file diff */
export interface TaskFileDiff {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  diff: string;
  oldPath?: string;
}

/** Fetch file diffs for a task */
export function fetchTaskFileDiffs(taskId: string, projectId?: string): Promise<TaskFileDiff[]> {
  return api<TaskFileDiff[]>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/file-diffs`, projectId));
}

/*
 * FNXC:CodeOrganization 2026-07-18-14:00:
 * Preserve legacy `missions` imports while implementations live in missions.ts.
 */
export {
  activateSlice,
  backfillCommitAssociationDiffStats,
  backfillMissionAssertions,
  createAssertion,
  createFeature,
  createMilestone,
  createMission,
  createSlice,
  deleteAssertion,
  deleteFeature,
  deleteMilestone,
  deleteMission,
  deleteSlice,
  fetchAssertion,
  fetchAssertions,
  fetchAssertionsForFeature,
  fetchFeaturesForAssertion,
  fetchMilestoneValidation,
  fetchMilestoneValidationTelemetry,
  fetchMission,
  fetchMissionAutopilotStatus,
  fetchMissionEvents,
  fetchMissionHealth,
  fetchMissionStatus,
  fetchMissions,
  fetchMissionsHealth,
  fetchValidationLoopState,
  fetchValidationRun,
  fetchValidationRuns,
  linkFeatureToAssertion,
  linkFeatureToTask,
  pauseMission,
  reorderAssertions,
  reorderMilestones,
  reorderSlices,
  resumeMission,
  startMission,
  startMissionAutopilot,
  stopMission,
  stopMissionAutopilot,
  triageAllSliceFeatures,
  triageFeature,
  triggerValidation,
  unlinkFeatureFromAssertion,
  unlinkFeatureFromTask,
  updateAssertion,
  updateFeature,
  updateMilestone,
  updateMission,
  updateMissionAutopilot,
  updateSlice,
} from "./missions.js";
export type {
  AutopilotState,
  AutopilotStatus,
  ContractAssertionCreateInput,
  ContractAssertionUpdateInput,
  FeatureStatus,
  Milestone,
  MilestoneStatus,
  MilestoneValidationRollup,
  MilestoneWithSlices,
  Mission,
  MissionAssertionBackfillErrorRow,
  MissionAssertionBackfillRepairRow,
  MissionAssertionBackfillReport,
  MissionAssertionStatus,
  MissionContractAssertion,
  MissionEventQueryOptions,
  MissionEventsResponse,
  MissionFeature,
  MissionFeatureLoopSnapshot,
  MissionStatus,
  MissionSummary,
  MissionValidatorRun,
  MissionWithHierarchy,
  MissionWithSummary,
  Slice,
  SliceStatus,
  SliceWithFeatures,
  ValidationRunsResponse,
} from "./missions.js";
// FNXC:CodeOrganization 2026-07-18-16:30: re-export does not bind mission types locally; interview helpers still type against them.
import type { Milestone, MissionWithHierarchy, Slice } from "./missions.js";

// ── Mission Interview API ─────────────────────────────────────────────────

/** Mission plan types returned by the interview AI */
export interface MissionPlanFeature {
  title: string;
  description?: string;
  acceptanceCriteria?: string;
}

export interface MissionPlanSlice {
  title: string;
  description?: string;
  verification?: string;
  features: MissionPlanFeature[];
}

export interface MissionPlanMilestone {
  title: string;
  description?: string;
  verification?: string;
  slices: MissionPlanSlice[];
}

export interface MissionPlanSummary {
  missionTitle?: string;
  missionDescription?: string;
  milestones: MissionPlanMilestone[];
}

export type MissionInterviewResponse =
  | { type: "question"; data: PlanningQuestion }
  | { type: "complete"; data: MissionPlanSummary };

/** Start a mission interview session with AI streaming */
export function startMissionInterview(
  missionTitle: string,
  projectId?: string,
  modelOverride?: { modelProvider?: string; modelId?: string; thinkingLevel?: ThinkingLevel },
): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(withProjectId("/missions/interview/start", projectId), {
    method: "POST",
    body: JSON.stringify({
      missionTitle,
      modelProvider: modelOverride?.modelProvider,
      modelId: modelOverride?.modelId,
      thinkingLevel: modelOverride?.thinkingLevel,
    }),
  });
}

/** Submit a response to the current interview question */
export function respondToMissionInterview(
  sessionId: string,
  responses: Record<string, unknown>,
  projectId?: string,
): Promise<MissionInterviewResponse> {
  return api<MissionInterviewResponse>(withProjectId("/missions/interview/respond", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, responses }),
  });
}

/** Retry a failed mission interview turn */
export function retryMissionInterviewSession(
  sessionId: string,
  projectId?: string,
): Promise<{ success: boolean; sessionId: string }> {
  return api<{ success: boolean; sessionId: string }>(
    withProjectId(`/missions/interview/${encodeURIComponent(sessionId)}/retry`, projectId),
    { method: "POST" },
  );
}

/** Cancel an active mission interview session */
export function cancelMissionInterview(sessionId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId("/missions/interview/cancel", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

export async function fetchMissionInterviewDrafts(projectId?: string): Promise<MissionInterviewDraftSummary[]> {
  const query = projectId ? `?${new URLSearchParams({ projectId }).toString()}` : "";
  const result = await api<{ drafts?: MissionInterviewDraftSummary[] }>(`/missions/interview/drafts${query}`);
  return result.drafts ?? [];
}

export function discardMissionInterviewDraft(
  sessionId: string,
  projectId?: string,
): Promise<{ removed: boolean }> {
  return api<{ removed: boolean }>(
    withProjectId(`/missions/interview/drafts/${encodeURIComponent(sessionId)}/discard`, projectId),
    { method: "POST" },
  );
}

/** Create mission from completed interview */
export function createMissionFromInterview(
  sessionId: string,
  summary?: MissionPlanSummary,
  projectId?: string,
  options?: {
    branch?: string;
    baseBranch?: string;
    branchSelection?: {
      mode: "project-default" | "auto-new" | "existing" | "custom-new";
      branchName?: string;
      baseBranch?: string;
    };
    branchAssignment?: { mode: "shared" | "per-task-derived" };
  },
): Promise<MissionWithHierarchy> {
  return api<MissionWithHierarchy>(withProjectId("/missions/interview/create-mission", projectId), {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      summary,
      ...(options?.branch !== undefined ? { branch: options.branch } : {}),
      ...(options?.baseBranch !== undefined ? { baseBranch: options.baseBranch } : {}),
      ...(options?.branchSelection ? { branchSelection: options.branchSelection } : {}),
      ...(options?.branchAssignment ? { branchAssignment: options.branchAssignment } : {}),
    }),
  });
}

const MISSION_INTERVIEW_STREAM_ERROR_MESSAGE = "The mission interview stream was interrupted. Please retry the session.";

function normalizeMissionInterviewStreamError(data: string | undefined): string {
  const raw = data?.trim() ?? "";
  if (!raw) return MISSION_INTERVIEW_STREAM_ERROR_MESSAGE;

  const normalizeMessage = (value: unknown): string => {
    if (typeof value !== "string") return MISSION_INTERVIEW_STREAM_ERROR_MESSAGE;
    const message = value.trim();
    if (!message || message === "Stream error") return MISSION_INTERVIEW_STREAM_ERROR_MESSAGE;
    return message;
  };

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const message = (parsed as { message?: unknown; error?: unknown }).message ?? (parsed as { error?: unknown }).error;
      return normalizeMessage(message);
    }
    return normalizeMessage(parsed);
  } catch {
    return normalizeMessage(raw);
  }
}

/** Connect to mission interview SSE stream and handle events */
export function connectMissionInterviewStream(
  sessionId: string,
  projectId: string | undefined,
  handlers: {
    onThinking?: (data: string) => void;
    onQuestion?: (data: PlanningQuestion) => void;
    onSummary?: (data: MissionPlanSummary) => void;
    onError?: (data: string) => void;
    onComplete?: () => void;
    onConnectionStateChange?: (state: StreamConnectionState) => void;
  },
  options?: { maxReconnectAttempts?: number },
): { close: () => void; isConnected: () => boolean } {
  const url = buildApiUrl(withProjectId(`/missions/interview/${encodeURIComponent(sessionId)}/stream`, projectId));
  let keepAlive: { stop: () => void } | null = null;
  let connection: { close: () => void; isConnected: () => boolean } | null = null;
  let terminalEventHandled = false;

  const stopKeepAlive = () => {
    keepAlive?.stop();
    keepAlive = null;
  };

  const closeTerminalConnection = () => {
    stopKeepAlive();
    connection?.close();
  };

  const notifyTerminalError = (message: string) => {
    if (terminalEventHandled) return;
    terminalEventHandled = true;
    closeTerminalConnection();
    handlers.onError?.(message);
  };

  const notifyTerminalComplete = () => {
    if (terminalEventHandled) return;
    terminalEventHandled = true;
    closeTerminalConnection();
    handlers.onComplete?.();
  };

  const resilient = createResilientEventSource(
    url,
    {
      onOpen: () => {
        stopKeepAlive();
        keepAlive = startKeepAlive(sessionId, projectId);
      },
      onMessage: (event) => {
        if (event.data.startsWith(":")) return;
      },
      events: {
        thinking: (event) => {
          try {
            handlers.onThinking?.(JSON.parse(event.data));
          } catch {
            handlers.onThinking?.(event.data);
          }
        },
        question: (event) => {
          try {
            handlers.onQuestion?.(JSON.parse(event.data) as PlanningQuestion);
          } catch (err) {
            console.error("[mission-interview] Failed to parse question event:", err);
          }
        },
        summary: (event) => {
          try {
            handlers.onSummary?.(JSON.parse(event.data) as MissionPlanSummary);
          } catch (err) {
            console.error("[mission-interview] Failed to parse summary event:", err);
          }
        },
        error: (event) => {
          /*
          FNXC:MissionInterviewStream 2026-06-24-00:00:
          Mission interview stream failures are terminal for the current EventSource. Normalize malformed/empty/generic payloads, close keepalive + SSE once, and ignore duplicate late error/complete events so the modal can show one recoverable Retry state instead of a stale spinner or raw stream failure.
          */
          notifyTerminalError(normalizeMissionInterviewStreamError(event.data));
        },
        complete: () => {
          notifyTerminalComplete();
        },
      },
    },
    {
      maxReconnectAttempts: options?.maxReconnectAttempts,
      onConnectionStateChange: handlers.onConnectionStateChange,
      onFatalError: (message) => {
        notifyTerminalError(normalizeMissionInterviewStreamError(message));
      },
    },
  );

  connection = {
    close: () => {
      stopKeepAlive();
      resilient.close();
    },
    isConnected: resilient.isConnected,
  };

  return connection;
}

// ── Milestone/Slice Interview API ─────────────────────────────────────────

/** Summary type for milestone/slice interview responses */
export interface TargetInterviewSummary {
  title?: string;
  description?: string;
  planningNotes?: string;
  verification?: string;
}

/** Response from milestone/slice interview: either a question or a completed plan */
export type TargetInterviewResponse =
  | { type: "question"; data: PlanningQuestion }
  | { type: "complete"; data: TargetInterviewSummary };

// Helper functions for URL construction
function buildMilestoneInterviewUrl(milestoneId: string, path: string, projectId?: string): string {
  return withProjectId(
    `/missions/milestones/${encodeURIComponent(milestoneId)}/interview${path}`,
    projectId
  );
}

function buildSliceInterviewUrl(sliceId: string, path: string, projectId?: string): string {
  return withProjectId(
    `/missions/slices/${encodeURIComponent(sliceId)}/interview${path}`,
    projectId
  );
}

/** Start a milestone interview session */
export function startMilestoneInterview(
  milestoneId: string,
  projectId?: string,
): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(buildMilestoneInterviewUrl(milestoneId, "/start", projectId), {
    method: "POST",
  });
}

/** Submit a response to a milestone interview question */
export function respondToMilestoneInterview(
  sessionId: string,
  responses: Record<string, unknown>,
  projectId?: string,
): Promise<TargetInterviewResponse> {
  return api<TargetInterviewResponse>(buildMilestoneInterviewUrl(sessionId, "/respond", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, responses }),
  });
}

/** Connect to milestone interview SSE stream and handle events */
export function connectMilestoneInterviewStream(
  sessionId: string,
  projectId: string | undefined,
  handlers: {
    onThinking?: (data: string) => void;
    onQuestion?: (data: PlanningQuestion) => void;
    onSummary?: (data: TargetInterviewSummary) => void;
    onError?: (data: string) => void;
    onComplete?: () => void;
    onConnectionStateChange?: (state: StreamConnectionState) => void;
  },
  options?: { maxReconnectAttempts?: number },
): { close: () => void; isConnected: () => boolean } {
  const url = buildApiUrl(buildMilestoneInterviewUrl(sessionId, `/${encodeURIComponent(sessionId)}/stream`, projectId));
  let keepAlive: { stop: () => void } | null = null;
  let connection: { close: () => void; isConnected: () => boolean } | null = null;

  const stopKeepAlive = () => {
    keepAlive?.stop();
    keepAlive = null;
  };

  const resilient = createResilientEventSource(
    url,
    {
      onOpen: () => {
        stopKeepAlive();
        keepAlive = startKeepAlive(sessionId, projectId);
      },
      onMessage: (event) => {
        if (event.data.startsWith(":")) return;
      },
      events: {
        thinking: (event) => {
          try {
            handlers.onThinking?.(JSON.parse(event.data));
          } catch {
            handlers.onThinking?.(event.data);
          }
        },
        question: (event) => {
          try {
            handlers.onQuestion?.(JSON.parse(event.data) as PlanningQuestion);
          } catch (err) {
            console.error("[milestone-interview] Failed to parse question event:", err);
          }
        },
        summary: (event) => {
          try {
            handlers.onSummary?.(JSON.parse(event.data) as TargetInterviewSummary);
          } catch (err) {
            console.error("[milestone-interview] Failed to parse summary event:", err);
          }
        },
        error: (event) => {
          try {
            const parsed = JSON.parse(event.data);
            handlers.onError?.(parsed.message || parsed);
          } catch {
            handlers.onError?.(event.data || "Stream error");
          }
          connection?.close();
        },
        complete: () => {
          handlers.onComplete?.();
          connection?.close();
        },
      },
    },
    {
      maxReconnectAttempts: options?.maxReconnectAttempts,
      onConnectionStateChange: handlers.onConnectionStateChange,
      onFatalError: (message) => {
        stopKeepAlive();
        handlers.onError?.(message);
      },
    },
  );

  connection = {
    close: () => {
      stopKeepAlive();
      resilient.close();
    },
    isConnected: resilient.isConnected,
  };

  return connection;
}

/** Apply milestone interview results to the milestone */
export function applyMilestoneInterview(
  sessionId: string,
  summary?: TargetInterviewSummary,
  projectId?: string,
): Promise<Milestone> {
  return api<Milestone>(buildMilestoneInterviewUrl(sessionId, "/apply", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, summary }),
  });
}

/** Skip milestone interview and use mission context */
export function skipMilestoneInterview(
  milestoneId: string,
  projectId?: string,
): Promise<Milestone> {
  return api<Milestone>(buildMilestoneInterviewUrl(milestoneId, "/skip", projectId), {
    method: "POST",
  });
}

/** Start a slice interview session */
export function startSliceInterview(
  sliceId: string,
  projectId?: string,
): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(buildSliceInterviewUrl(sliceId, "/start", projectId), {
    method: "POST",
  });
}

/** Submit a response to a slice interview question */
export function respondToSliceInterview(
  sessionId: string,
  responses: Record<string, unknown>,
  projectId?: string,
): Promise<TargetInterviewResponse> {
  return api<TargetInterviewResponse>(buildSliceInterviewUrl(sessionId, "/respond", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, responses }),
  });
}

/** Connect to slice interview SSE stream and handle events */
export function connectSliceInterviewStream(
  sessionId: string,
  projectId: string | undefined,
  handlers: {
    onThinking?: (data: string) => void;
    onQuestion?: (data: PlanningQuestion) => void;
    onSummary?: (data: TargetInterviewSummary) => void;
    onError?: (data: string) => void;
    onComplete?: () => void;
    onConnectionStateChange?: (state: StreamConnectionState) => void;
  },
  options?: { maxReconnectAttempts?: number },
): { close: () => void; isConnected: () => boolean } {
  const url = buildApiUrl(buildSliceInterviewUrl(sessionId, `/${encodeURIComponent(sessionId)}/stream`, projectId));
  let keepAlive: { stop: () => void } | null = null;
  let connection: { close: () => void; isConnected: () => boolean } | null = null;

  const stopKeepAlive = () => {
    keepAlive?.stop();
    keepAlive = null;
  };

  const resilient = createResilientEventSource(
    url,
    {
      onOpen: () => {
        stopKeepAlive();
        keepAlive = startKeepAlive(sessionId, projectId);
      },
      onMessage: (event) => {
        if (event.data.startsWith(":")) return;
      },
      events: {
        thinking: (event) => {
          try {
            handlers.onThinking?.(JSON.parse(event.data));
          } catch {
            handlers.onThinking?.(event.data);
          }
        },
        question: (event) => {
          try {
            handlers.onQuestion?.(JSON.parse(event.data) as PlanningQuestion);
          } catch (err) {
            console.error("[slice-interview] Failed to parse question event:", err);
          }
        },
        summary: (event) => {
          try {
            handlers.onSummary?.(JSON.parse(event.data) as TargetInterviewSummary);
          } catch (err) {
            console.error("[slice-interview] Failed to parse summary event:", err);
          }
        },
        error: (event) => {
          try {
            const parsed = JSON.parse(event.data);
            handlers.onError?.(parsed.message || parsed);
          } catch {
            handlers.onError?.(event.data || "Stream error");
          }
          connection?.close();
        },
        complete: () => {
          handlers.onComplete?.();
          connection?.close();
        },
      },
    },
    {
      maxReconnectAttempts: options?.maxReconnectAttempts,
      onConnectionStateChange: handlers.onConnectionStateChange,
      onFatalError: (message) => {
        stopKeepAlive();
        handlers.onError?.(message);
      },
    },
  );

  connection = {
    close: () => {
      stopKeepAlive();
      resilient.close();
    },
    isConnected: resilient.isConnected,
  };

  return connection;
}

/** Apply slice interview results to the slice */
export function applySliceInterview(
  sessionId: string,
  summary?: TargetInterviewSummary,
  projectId?: string,
): Promise<Slice> {
  return api<Slice>(buildSliceInterviewUrl(sessionId, "/apply", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, summary }),
  });
}

/** Skip slice interview and use mission context */
export function skipSliceInterview(
  sliceId: string,
  projectId?: string,
): Promise<Slice> {
  return api<Slice>(buildSliceInterviewUrl(sliceId, "/skip", projectId), {
    method: "POST",
  });
}

/** Preview enriched description for a feature before triage */
export async function previewEnrichedDescription(
  featureId: string,
  projectId?: string,
): Promise<{ description: string }> {
  try {
    return await api<{ description: string }>(
      withProjectId(`/missions/features/${encodeURIComponent(featureId)}/preview-description`, projectId),
      {
        method: "POST",
      }
    );
  } catch {
    // If endpoint doesn't exist, throw to trigger fallback
    throw new Error("Preview endpoint not available");
  }
}

/*
 * FNXC:CodeOrganization 2026-07-18-14:00:
 * Preserve legacy `todo` imports while implementations live in todo.ts.
 */
export {
  createTodoItem,
  createTodoList,
  deleteTodoItem,
  deleteTodoList,
  fetchTodoLists,
  reorderTodoItems,
  updateTodoItem,
  updateTodoList,
} from "./todo.js";

/*
 * FNXC:CodeOrganization 2026-07-19-12:00:
 * Preserve legacy `ai-sessions` imports while implementations live in ai-sessions.ts.
 */
export {
  archiveAiSession,
  deleteAiSession,
  fetchAiSession,
  fetchAiSessions,
  parseConversationHistory,
  pingSession,
  summarizePlanningDraftTitle,
  unarchiveAiSession,
  updatePlanningSessionDraft,
} from "./ai-sessions.js";
export type {
  AiSessionDetail,
  AiSessionSummary,
  CliNeedsAttentionVariant,
  ConversationHistoryEntry,
} from "./ai-sessions.js";

/*
 * FNXC:CodeOrganization 2026-07-19-12:00:
 * Preserve legacy `chat` imports while implementations live in chat.ts.
 */
export {
  addChatRoomMember,
  attachChatStream,
  attachmentBaseUrlForRoom,
  cancelChatResponse,
  clearChatRoomMessages,
  createChatRoom,
  createChatSession,
  deleteChatMessage,
  deleteChatRoom,
  deleteChatRoomMessage,
  deleteChatSession,
  editChatMessage,
  ensureTaskPlannerChatSession,
  fetchChatMessages,
  fetchChatRoom,
  fetchChatRoomMembers,
  fetchChatRoomMessages,
  fetchChatRooms,
  fetchChatSession,
  fetchChatSessions,
  fetchResumeChatSession,
  fetchTaskPlannerChatSession,
  postChatRoomMessage,
  removeChatRoomMember,
  streamChatResponse,
  updateChatRoom,
  updateChatSession,
  uploadChatRoomAttachment,
} from "./chat.js";
export type {
  ChatFailureInfo,
  ChatFailureReference,
  ChatMessageListResponse,
  ChatRoomListResponse,
  ChatRoomMembersResponse,
  ChatRoomMessageListResponse,
  ChatRoomMessageResponse,
  ChatRoomResponse,
  ChatSessionListResponse,
  ChatSessionResponse,
  ChatSessionResumeLookupInput,
  ChatStreamErrorMeta,
  ChatStreamHandlers,
  FetchChatSessionsOptions,
  TaskPlannerChatSessionInput,
} from "./chat.js";

/*
 * FNXC:CodeOrganization 2026-07-19-12:00:
 * Preserve legacy `research` imports while implementations live in research.ts.
 */
export {
  attachResearchRunToTask,
  cancelResearchRun,
  createResearchRun,
  createTaskFromResearchRun,
  exportResearchRun,
  getEval,
  getResearchAvailability,
  getResearchRun,
  getResearchStats,
  listEvalRuns,
  listEvals,
  listResearchRuns,
  retryResearchRun,
} from "./research.js";
export type {
  CreateResearchRunInput,
  EvalsListOptions,
  ResearchActionError,
  ResearchActionErrorCode,
  ResearchStatsResponse,
} from "./research.js";

/*
 * FNXC:CodeOrganization 2026-07-18-14:00:
 * Preserve legacy `messaging` imports while implementations live in messaging.ts.
 */
export {
  addAgentRating,
  createProposedTask,
  decideApproval,
  deleteAgentRating,
  deleteMessage,
  fetchAgentBudgetStatus,
  fetchAgentMailbox,
  fetchAgentPerformance,
  fetchAgentRatingSummary,
  fetchAgentRatings,
  fetchAgentReflection,
  fetchAgentReflections,
  fetchAllAgentMailbox,
  fetchApprovalDetail,
  fetchApprovals,
  fetchConversation,
  fetchInbox,
  fetchMessage,
  fetchOutbox,
  fetchUnreadCount,
  markAllMessagesRead,
  markMessageRead,
  resetAgentBudget,
  sendMessage,
  triggerAgentReflection,
} from "./messaging.js";
export type {
  AgentMailboxResponse,
  AllAgentsMailboxResponse,
  ApprovalListResponse,
  ApprovalRequestDetail,
  ApprovalRequestSummary,
  InboxResponse,
  MarkAllReadResponse,
  OutboxResponse,
  SendMessageInput,
  UnreadCountResponse,
} from "./messaging.js";

/*
 * FNXC:CodeOrganization 2026-07-18-14:00:
 * Preserve legacy `plugins-and-skills` imports while implementations live in plugins-and-skills.ts.
 */
export {
  disablePlugin,
  enablePlugin,
  fetchDiscoveredSkills,
  fetchPluginDashboardViews,
  fetchPluginDetail,
  fetchPluginRegistry,
  fetchPluginRuntimes,
  fetchPluginSettings,
  fetchPluginSetupStatus,
  fetchPluginUiContributions,
  fetchPluginUiSlots,
  fetchPlugins,
  fetchSkillContent,
  fetchSkillFileContent,
  fetchSkillsCatalog,
  installPlugin,
  installPluginSetup,
  installSkill,
  reloadPlugin,
  rescanPlugin,
  toggleExecutionSkill,
  uninstallPlugin,
  updatePlugin,
  updatePluginSettings,
} from "./plugins-and-skills.js";
export type {
  PluginDashboardViewEntry,
  PluginRuntimeInfo,
  PluginSetupStatusResponse,
  PluginUiContributionEntry,
  PluginUiSlotEntry,
  RegistryPluginEntry,
} from "./plugins-and-skills.js";

/*
 * FNXC:CodeOrganization 2026-07-18-14:00:
 * Preserve legacy `insights` imports while implementations live in insights.ts.
 */
export {
  archiveInsight,
  deleteInsight,
  dismissInsight,
  fetchInsight,
  fetchInsightRun,
  fetchInsightRuns,
  fetchInsights,
  getInsightCreateTaskData,
  triggerInsightRun,
  unarchiveInsight,
  updateInsight,
} from "./insights.js";
export type {
  InsightsListResponse,
  RunsListResponse,
} from "./insights.js";

/*
 * FNXC:CodeOrganization 2026-07-18-14:00:
 * Preserve legacy `system-panel` imports while implementations live in system-panel.ts.
 */
export {
  fetchCurrentSystemRebuild,
  fetchSystemInfo,
  fetchSystemLogs,
  promoteResearchFinding,
  reloadAllSystemPlugins,
  requestSystemRestart,
  restartAllSystemAgents,
  restartSystemEngines,
  startFnBinaryLinkLocal,
  startFnBinaryUseGlobal,
  startSystemRebuild,
} from "./system-panel.js";
export type {
  ResearchFindingPromotionInput,
  SystemInfoResponse,
  SystemLogEntryDto,
  SystemRebuildJobLine,
  SystemRebuildJobSnapshot,
} from "./system-panel.js";
