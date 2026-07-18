import type {
  Task,
  TaskDetail,
  TaskReviewData,
  TaskAttachment,
  TaskComment,
  AgentLogEntry,
  Settings,
  GlobalSettings,
  ProjectSettings,
  BatchStatusResult,
  BatchStatusResponse,
  ActivityLogEntry,
  ActivityEventType,
  WorkflowStep,
  WorkflowStepResult,
  PluginInstallation,
  PluginSetupCheckResult,
  PluginState,
  PluginUiSlotDefinition,
  PluginUiContributionDefinition,
  PluginDashboardViewDefinition,
  TaskDocument,
  TaskDocumentRevision,
  TaskDocumentWithTask,
  Artifact,
  ArtifactType,
  ArtifactWithTask,

  Message,
  MessageMetadata,
  MessageType,
  ParticipantType,
  NodeConfig,
  NodeStatus,
  MeshClusterSnapshot,
  SystemMetrics,
  DiscoveryConfig,
  MissionEvent,
  MissionHealth,
  MissionEventType,
  AgentRating,
  AgentRatingSummary,
  AgentRatingInput,
  ChatAttachment,
  ChatMessage,
  ChatRoom,
  ChatRoomMember,
  ChatRoomMessage,
  EnrichedChatSession,
  TodoList,
  TodoItem,
  TodoListWithItems,
  TodoListCreateInput,
  TodoListUpdateInput,
  TodoItemCreateInput,
  TodoItemUpdateInput,
  Insight,
  InsightCategory,
  InsightStatus,
  InsightRun,
  InsightRunTrigger,
  EvalRun,
  EvalTaskResult,
  ResearchRunStatus,
  TaskPriority,
  PrConflictDiagnostics,
  PrInfo,
  ManagedDockerNodeInput,
  DockerNodeConfig,
  DockerHostConfig,
  DockerResourceSizing,
  DockerVolumeMount,
  DockerExtraCli,
  DockerNodeStatus,
  ProjectNodePathMapping,
  ApprovalRequestStatus,
  CommitAssociationDiffBackfillReport,
} from "@fusion/core";
// Consumers import backfill report types from the legacy API barrel.
export type { CommitAssociationDiffBackfillReport };
import type { PlanningQuestion, PlanningSummary } from "@fusion/core";
import type { ScheduledTask, ScheduledTaskCreateInput, ScheduledTaskUpdateInput, AutomationRunResult, Routine, RoutineCreateInput, RoutineUpdateInput, RoutineExecutionResult } from "@fusion/core";
import type { MilestoneValidationTelemetry, MissionInterviewDraftSummary } from "../components/mission-types";
import type {
  ResearchAvailability,
  ResearchRunDetail,
  ResearchRunsResponse,
  ResearchRunResponse,
  ResearchProviderOption,
} from "../research-types";
import { appendTokenQuery, getAuthToken, withTokenHeader } from "../auth";
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
import type { MemoryFileInfo } from "./memory.js";

import { api, ApiRequestError, buildApiUrl, looksLikeHtml, proxyApi } from "./client.js";
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

export function fetchGlobalSettings(options?: FetchOptions): Promise<GlobalSettings> {
  return dedupe("/settings/global", () => api<GlobalSettings>("/settings/global"), options);
}

/** Update global (user-level) settings. These persist across all fn projects. */
export function updateGlobalSettings(settings: Partial<GlobalSettings>): Promise<Settings> {
  return api<Settings>("/settings/global", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

/** Fetch settings separated by scope: { global, project } */
export function fetchSettingsByScope(projectId?: string): Promise<{ global: GlobalSettings; project: Partial<ProjectSettings> }> {
  return api<{ global: GlobalSettings; project: Partial<ProjectSettings> }>(withProjectId("/settings/scopes", projectId));
}

export interface PiExtensionEntry {
  id: string;
  name: string;
  path: string;
  source: "fusion-global" | "pi-global" | "fusion-project" | "pi-project" | "package";
  enabled: boolean;
}

export interface PiExtensionSettings {
  extensions: PiExtensionEntry[];
  disabledIds: string[];
  settingsPath: string;
}

export function fetchPiExtensions(projectId?: string): Promise<PiExtensionSettings> {
  return api<PiExtensionSettings>(withProjectId("/settings/pi-extensions", projectId));
}

export function updatePiExtensions(disabledIds: string[], projectId?: string): Promise<PiExtensionSettings> {
  return api<PiExtensionSettings>(withProjectId("/settings/pi-extensions", projectId), {
    method: "PUT",
    body: JSON.stringify({ disabledIds }),
  });
}

/**
 * Test a notification provider by sending a test notification.
 * Supports "ntfy" and "webhook" provider IDs.
 */
export function testNotification(providerId: string, config?: Record<string, unknown>, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId("/settings/test-notification", projectId), {
    method: "POST",
    body: JSON.stringify({ providerId, ...(config ?? {}) }),
  });
}

/**
 * Backward-compatible ntfy test helper.
 * Wraps testNotification() while preserving the legacy function signature.
 */
export function testNtfyNotification(
  config?: {
    ntfyEnabled?: boolean;
    ntfyTopic?: string;
    ntfyBaseUrl?: string;
    ntfyAccessToken?: string;
  },
  projectId?: string,
): Promise<{ success: boolean }> {
  return testNotification("ntfy", config as Record<string, unknown> | undefined, projectId);
}

/** Pi extension settings from ~/.pi/agent/settings.json (global scope) */
export interface PiSettings {
  packages: Array<string | { source: string; extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[] }>;
  extensions: string[];
  skills: string[];
  prompts: string[];
  themes: string[];
}

/** Fetch pi extension settings (global scope from ~/.pi/agent/settings.json) */
export function fetchPiSettings(): Promise<PiSettings> {
  return api<PiSettings>("/pi-settings");
}

/** Update pi extension settings (partial update, global scope) */
export async function updatePiSettings(settings: Partial<PiSettings>): Promise<{ success: boolean }> {
  return api<{ success: boolean }>("/pi-settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

/** Install a new pi package source (adds to ~/.pi/agent/settings.json) */
export async function installPiPackage(source: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>("/pi-settings/packages", {
    method: "POST",
    body: JSON.stringify({ source }),
  });
}

/** Reinstall Fusion's bundled pi package and ensure it remains in global Pi settings. */
export async function reinstallFusionPiPackage(projectId?: string): Promise<{ success: boolean; source: string }> {
  return api<{ success: boolean; source: string }>(withProjectId("/pi-settings/reinstall-fusion", projectId), {
    method: "POST",
  });
}

export async function uploadAttachment(id: string, file: File, projectId?: string): Promise<TaskAttachment> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(buildApiUrl(withProjectId(`/tasks/${id}/attachments`, projectId)), {
    method: "POST",
    headers: withTokenHeader(),
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error || "Upload failed");
  return data as TaskAttachment;
}

export async function deleteAttachment(id: string, filename: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/attachments/${filename}`, projectId), { method: "DELETE" });
}

export function fetchAgentLogs(
  taskId: string,
  projectId?: string,
  options?: { limit?: number; offset?: number },
): Promise<AgentLogEntry[]> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options?.offset !== undefined) {
    params.set("offset", String(options.offset));
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return api<AgentLogEntry[]>(withProjectId(`/tasks/${taskId}/logs${suffix}`, projectId));
}

/**
 * Fetch agent logs with pagination metadata.
 * Returns entries along with total count and hasMore flag from response headers.
 */
export async function fetchAgentLogsWithMeta(
  taskId: string,
  projectId?: string,
  options?: { limit?: number; offset?: number },
): Promise<{ entries: AgentLogEntry[]; total: number; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options?.offset !== undefined) {
    params.set("offset", String(options.offset));
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const url = withProjectId(`/tasks/${taskId}/logs${suffix}`, projectId);

  const response = await fetch(buildApiUrl(url), {
    headers: withTokenHeader(),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "Failed to fetch agent logs" }));
    throw new Error((data as { error?: string }).error || `HTTP ${response.status}`);
  }

  const entries = await response.json() as AgentLogEntry[];

  // Read pagination headers
  const total = response.headers.has("X-Total-Count")
    ? parseInt(response.headers.get("X-Total-Count")!, 10)
    : entries.length;
  const hasMore = response.headers.has("X-Has-More")
    ? response.headers.get("X-Has-More") === "true"
    : false;

  return { entries, total, hasMore };
}

export function fetchSessionFiles(taskId: string, projectId?: string): Promise<string[]> {
  return api<string[]>(withProjectId(`/tasks/${taskId}/session-files`, projectId));
}

export function fetchTaskComments(id: string, projectId?: string): Promise<TaskComment[]> {
  return api<TaskComment[]>(withProjectId(`/tasks/${id}/comments`, projectId));
}

export function addTaskComment(id: string, text: string, author?: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/comments`, projectId), {
    method: "POST",
    body: JSON.stringify({ text, author }),
  });
}

export function updateTaskComment(id: string, commentId: string, text: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/comments/${commentId}`, projectId), {
    method: "PATCH",
    body: JSON.stringify({ text }),
  });
}

export function deleteTaskComment(id: string, commentId: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/comments/${commentId}`, projectId), {
    method: "DELETE",
  });
}

// ── Task Document API Functions ──────────────────────────────────────────────

export function fetchTaskDocuments(taskId: string, projectId?: string): Promise<TaskDocument[]> {
  return api<TaskDocument[]>(withProjectId(`/tasks/${taskId}/documents`, projectId));
}

export function fetchTaskDocument(taskId: string, key: string, projectId?: string): Promise<TaskDocument> {
  return api<TaskDocument>(withProjectId(`/tasks/${taskId}/documents/${key}`, projectId));
}

export function fetchTaskDocumentRevisions(taskId: string, key: string, projectId?: string): Promise<TaskDocumentRevision[]> {
  return api<TaskDocumentRevision[]>(withProjectId(`/tasks/${taskId}/documents/${key}/revisions`, projectId));
}

export interface FetchAllDocumentsOptions {
  q?: string;
  limit?: number;
  offset?: number;
}

export interface MarkdownFileEntry {
  path: string;
  name: string;
  size: number;
  mtime: string;
}

export interface MarkdownFileListResponse {
  files: MarkdownFileEntry[];
}

export type { Artifact, ArtifactType, ArtifactWithTask };

export interface FetchArtifactsOptions {
  type?: ArtifactType;
  authorId?: string;
  taskId?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export async function fetchArtifacts(
  options?: FetchArtifactsOptions,
  projectId?: string,
): Promise<ArtifactWithTask[]> {
  const params = new URLSearchParams();
  if (options?.type) params.set("type", options.type);
  if (options?.authorId) params.set("authorId", options.authorId);
  if (options?.taskId) params.set("taskId", options.taskId);
  if (options?.q) params.set("q", options.q);
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
  const queryString = params.toString();
  const path = `/artifacts${queryString ? `?${queryString}` : ""}`;
  return api<ArtifactWithTask[]>(withProjectId(path, projectId));
}

/*
FNXC:ArtifactRegistry 2026-07-15-12:00:
Keep artifactMediaUrl token-free so fetch callers and script-capable HTML previews can authenticate via Authorization without putting the daemon token into a URL that executable artifact content could read.

FNXC:ArtifactMediaAuth 2026-07-15-14:24:
Main previously always-tokenized this helper for browser-native media loads. FN-7976 supersedes that by splitting tokenized element/link loads into artifactMediaUrlWithToken while this base URL stays clean for header-auth fetch and HTML blob previews.
*/
export function artifactMediaUrl(id: string, projectId?: string): string {
  return buildApiUrl(withProjectId(`/artifacts/${encodeURIComponent(id)}/media`, projectId));
}

/*
FNXC:ArtifactRegistry 2026-07-15-12:00:
Artifact media element loads and link navigations cannot attach an Authorization header, so authenticated daemon media routes require the dashboard-owned fn_token query fallback. Keep artifactMediaUrl token-free for fetch callers and script-capable HTML previews; consumers that hand the URL to an img, video, audio, iframe, or anchor must use this helper unless executable content could read the URL.
*/
export function artifactMediaUrlWithToken(id: string, projectId?: string): string {
  return appendTokenQuery(artifactMediaUrl(id, projectId));
}

/*
FNXC:ArtifactRegistry 2026-07-10-15:20:
The Artifacts view document viewer needs the full artifact INCLUDING inline content (list responses strip content), and edit mode persists title/description/content through PATCH.
*/
export async function fetchArtifact(id: string, projectId?: string): Promise<Artifact> {
  return api<Artifact>(withProjectId(`/artifacts/${encodeURIComponent(id)}`, projectId));
}

export interface UpdateArtifactInput {
  title?: string;
  description?: string;
  content?: string;
}

export async function updateArtifact(id: string, updates: UpdateArtifactInput, projectId?: string): Promise<Artifact> {
  return api<Artifact>(withProjectId(`/artifacts/${encodeURIComponent(id)}`, projectId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
}

export async function fetchAllDocuments(
  options?: FetchAllDocumentsOptions,
  projectId?: string,
): Promise<TaskDocumentWithTask[]> {
  const params = new URLSearchParams();
  if (options?.q) params.set("q", options.q);
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
  const queryString = params.toString();
  const path = `/documents${queryString ? `?${queryString}` : ""}`;
  return api<TaskDocumentWithTask[]>(withProjectId(path, projectId));
}

export interface FetchProjectMarkdownFilesOptions {
  showHidden?: boolean;
}

export function fetchProjectMarkdownFiles(
  projectId?: string,
  options?: FetchProjectMarkdownFilesOptions,
): Promise<MarkdownFileListResponse> {
  const params = new URLSearchParams();
  if (options?.showHidden) {
    params.set("showHidden", "1");
  }

  const query = params.toString();
  const path = `/files/markdown-list${query ? `?${query}` : ""}`;

  return api<MarkdownFileListResponse>(withProjectId(path, projectId));
}

export function putTaskDocument(
  taskId: string,
  key: string,
  content: string,
  opts?: { author?: string; metadata?: Record<string, unknown> },
  projectId?: string,
): Promise<TaskDocument> {
  return api<TaskDocument>(withProjectId(`/tasks/${taskId}/documents/${key}`, projectId), {
    method: "PUT",
    body: JSON.stringify({
      content,
      author: opts?.author,
      metadata: opts?.metadata,
    }),
  });
}

export function deleteTaskDocument(taskId: string, key: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/tasks/${taskId}/documents/${key}`, projectId), {
    method: "DELETE",
  });
}

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

export interface SubtaskItem {
  id: string;
  title: string;
  description: string;
  suggestedSize: "S" | "M" | "L";
  priority?: TaskPriority;
  dependsOn: string[];
}

export interface PlanningSubtaskDraft {
  id: string;
  title?: string;
  description?: string;
  suggestedSize?: "S" | "M" | "L";
  priority?: TaskPriority;
  dependsOn?: string[];
}

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
  planningOptions?: { planningDepth?: "small" | "medium" | "large"; customQuestionCount?: number },
): Promise<PlanningSession> {
  return api<PlanningSession>(withProjectId("/planning/start", projectId), {
    method: "POST",
    body: JSON.stringify({
      initialPlan,
      planningDepth: planningOptions?.planningDepth,
      customQuestionCount: planningOptions?.customQuestionCount,
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
  planningOptions?: { planningDepth?: "small" | "medium" | "large"; customQuestionCount?: number; clarificationEnabled?: boolean },
  existingSessionId?: string,
): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(withProjectId("/planning/start-streaming", projectId), {
    method: "POST",
    body: JSON.stringify({
      initialPlan,
      planningModelProvider: modelOverride?.planningModelProvider,
      planningModelId: modelOverride?.planningModelId,
      thinkingLevel: modelOverride?.thinkingLevel,
      planningDepth: planningOptions?.planningDepth,
      customQuestionCount: planningOptions?.customQuestionCount,
      clarificationEnabled: planningOptions?.clarificationEnabled,
      ...(existingSessionId ? { existingSessionId } : {}),
    }),
  });
}

/** Submit a response to the current planning question */
export function respondToPlanning(
  sessionId: string,
  responses: Record<string, unknown>,
  projectId?: string,
): Promise<PlanningSession> {
  return api<PlanningSession>(withProjectId("/planning/respond", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId, responses }),
  });
}

/** Rewind a planning session to the previous answered question */
export function rewindPlanningSession(
  sessionId: string,
  projectId?: string,
): Promise<{ currentQuestion: PlanningQuestion; history: Array<{ question: PlanningQuestion; response: unknown; thinkingOutput?: string }> }> {
  return api<{ currentQuestion: PlanningQuestion; history: Array<{ question: PlanningQuestion; response: unknown; thinkingOutput?: string }> }>(
    withProjectId(`/planning/${encodeURIComponent(sessionId)}/back`, projectId),
    {
      method: "POST",
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
  return api<Task>(withProjectId("/planning/create-task", projectId), {
    method: "POST",
    body: JSON.stringify({
      ...(summary ? { sessionId, summary } : { sessionId }),
      ...(options?.branch !== undefined ? { branch: options.branch } : {}),
      ...(options?.baseBranch !== undefined ? { baseBranch: options.baseBranch } : {}),
      ...(options?.branchSelection ? { branchSelection: options.branchSelection } : {}),
      ...(options?.workflowId !== undefined ? { workflowId: options.workflowId } : {}),
    }),
  });
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


type StreamConnectionState = "connected" | "reconnecting";

// Track every live createResilientEventSource instance so we can close their
// underlying EventSource sockets on page unload. Without this, Chrome holds
// the HTTP/1.1 sockets open in its keep-alive pool across refreshes, exhausts
// its 6-per-origin limit after ~3 refreshes, and every new fetch stalls —
// leaving the dashboard frozen on "Initializing...". sse-bus.ts has its own
// handler; this one covers the parallel EventSource path in api.ts.
const activeResilientEventSources = new Set<{ close: () => void }>();
if (typeof window !== "undefined") {
  const closeAll = () => {
    for (const handle of Array.from(activeResilientEventSources)) {
      try { handle.close(); } catch { /* best effort */ }
    }
  };
  window.addEventListener("pagehide", closeAll);
  window.addEventListener("beforeunload", closeAll);
}

interface ResilientEventSourceOptions {
  maxReconnectAttempts?: number;
  onConnectionStateChange?: (state: StreamConnectionState) => void;
  onFatalError?: (message: string) => void;
}

interface ResilientEventHandlers {
  onOpen?: () => void;
  onMessage?: (event: MessageEvent) => void;
  events?: Record<string, (event: MessageEvent) => void>;
}

function appendLastEventId(url: string, lastEventId: number | null): string {
  if (lastEventId === null || lastEventId <= 0) {
    return url;
  }

  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}lastEventId=${encodeURIComponent(String(lastEventId))}`;
}

function createResilientEventSource(
  url: string,
  handlers: ResilientEventHandlers,
  options: ResilientEventSourceOptions = {},
): { close: () => void; isConnected: () => boolean } {
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
  let eventSource: EventSource | null = null;
  let closedByUser = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSeenEventId: number | null = null;
  let reconnectingNotified = false;

  const shouldDispatch = (event: MessageEvent): boolean => {
    const rawId = event.lastEventId;
    if (!rawId) {
      return true;
    }

    const parsedId = Number.parseInt(rawId, 10);
    if (!Number.isFinite(parsedId)) {
      return true;
    }

    if (lastSeenEventId !== null && parsedId <= lastSeenEventId) {
      return false;
    }

    lastSeenEventId = parsedId;
    return true;
  };

  const connect = (): void => {
    if (closedByUser) return;

    const nextUrl = appendLastEventId(url, lastSeenEventId);
    // EventSource can't set headers — carry the bearer token via `fn_token=`.
    const source = new EventSource(appendTokenQuery(nextUrl));
    eventSource = source;

    source.onopen = () => {
      reconnectAttempts = 0;
      reconnectingNotified = false;
      options.onConnectionStateChange?.("connected");
      handlers.onOpen?.();
    };

    source.onmessage = (event) => {
      const messageEvent = event as MessageEvent;
      if (!shouldDispatch(messageEvent)) return;
      handlers.onMessage?.(messageEvent);
    };

    for (const [eventName, handler] of Object.entries(handlers.events ?? {})) {
      source.addEventListener(eventName, (event: Event) => {
        const messageEvent = event as MessageEvent;
        if (!shouldDispatch(messageEvent)) return;
        handler(messageEvent);
      });
    }

    source.onerror = () => {
      if (closedByUser || eventSource !== source) return;

      const readyState = source.readyState;
      if (readyState === EventSource.CONNECTING) {
        if (!reconnectingNotified) {
          reconnectingNotified = true;
          options.onConnectionStateChange?.("reconnecting");
        }
        return;
      }

      source.close();
      if (eventSource === source) {
        eventSource = null;
      }

      if (reconnectAttempts >= maxReconnectAttempts) {
        options.onFatalError?.("Connection lost");
        return;
      }

      reconnectingNotified = true;
      options.onConnectionStateChange?.("reconnecting");
      reconnectAttempts += 1;

      const delayMs = Math.min(1000 * 2 ** (reconnectAttempts - 1), 30000);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delayMs);
    };
  };

  connect();

  const handle = {
    close: () => {
      closedByUser = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      eventSource?.close();
      activeResilientEventSources.delete(handle);
    },
    isConnected: () => !closedByUser && eventSource?.readyState === EventSource.OPEN,
  };
  activeResilientEventSources.add(handle);
  return handle;
}

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

function startKeepAlive(
  sessionId: string,
  projectId?: string,
  intervalMs = 25_000,
): { stop: () => void } {
  const timer = setInterval(() => {
    void pingSession(sessionId, projectId).catch(() => {
      // Best-effort keepalive: ignore failures so streams remain active.
    });
  }, intervalMs);

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
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

// ── Automation / Scheduled Tasks ──────────────────────────────────

/**
 * Options for scheduling scope (global vs project-scoped automations/routines).
 * When scope is "project", projectId must be provided.
 */
export type SchedulingScopeOptions = {
  /** Scope for scheduling operations: "global" or "project". Defaults to "project" on the server. */
  scope?: "global" | "project";
  /** Project ID required when scope is "project". */
  projectId?: string;
};

/**
 * Build URL suffix with scope and projectId query params.
 * Mirrors the backend's parseScopeParam logic: scope goes in query param.
 */
function withSchedulingScope(path: string, options?: SchedulingScopeOptions): string {
  const params = new URLSearchParams();
  if (options?.scope) {
    params.set("scope", options.scope);
  }
  if (options?.projectId) {
    params.set("projectId", options.projectId);
  }
  const suffix = params.toString();
  if (!suffix) return path;
  return `${path}?${suffix}`;
}

/** Response from the manual run trigger endpoint. */
export interface AutomationRunResponse {
  schedule: ScheduledTask;
  result: AutomationRunResult;
}

export function fetchAutomations(options?: SchedulingScopeOptions): Promise<ScheduledTask[]> {
  return api<ScheduledTask[]>(withSchedulingScope("/automations", options));
}

export function fetchAutomation(id: string, options?: SchedulingScopeOptions): Promise<ScheduledTask> {
  return api<ScheduledTask>(withSchedulingScope(`/automations/${id}`, options));
}

export function createAutomation(input: ScheduledTaskCreateInput, options?: SchedulingScopeOptions): Promise<ScheduledTask> {
  // Forward all input fields including scope metadata (scope may be set on input or in options)
  return api<ScheduledTask>(withSchedulingScope("/automations", options), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateAutomation(id: string, updates: ScheduledTaskUpdateInput, options?: SchedulingScopeOptions): Promise<ScheduledTask> {
  // Forward all update fields including scope metadata
  return api<ScheduledTask>(withSchedulingScope(`/automations/${id}`, options), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function deleteAutomation(id: string, options?: SchedulingScopeOptions): Promise<void> {
  await api(withSchedulingScope(`/automations/${id}`, options), {
    method: "DELETE",
  });
}

export function runAutomation(id: string, options?: SchedulingScopeOptions): Promise<AutomationRunResponse> {
  return api<AutomationRunResponse>(withSchedulingScope(`/automations/${id}/run`, options), {
    method: "POST",
  });
}

export function toggleAutomation(id: string, options?: SchedulingScopeOptions): Promise<ScheduledTask> {
  return api<ScheduledTask>(withSchedulingScope(`/automations/${id}/toggle`, options), {
    method: "POST",
  });
}

export function reorderAutomationSteps(id: string, stepIds: string[], options?: SchedulingScopeOptions): Promise<ScheduledTask> {
  return api<ScheduledTask>(withSchedulingScope(`/automations/${id}/steps/reorder`, options), {
    method: "POST",
    body: JSON.stringify({ stepIds }),
  });
}

// ── Routines API ────────────────────────────────────────────────

export interface RoutineRunResponse {
  routine: Routine;
  result: RoutineExecutionResult;
  liveRunId?: string;
}

export type RoutineRunStreamEvent =
  | { type: "run"; runId?: string; scheduleId?: string; status?: string }
  | { type: "step"; runId?: string; stepIndex?: number; stepId?: string; stepName?: string; stepType?: string; status?: string; success?: boolean; error?: string }
  | { type: "output"; runId?: string; text?: string }
  | { type: "tool"; runId?: string; status?: string; name?: string; args?: unknown; isError?: boolean; result?: unknown }
  | { type: "complete"; runId?: string; result?: RoutineExecutionResult }
  | { type: "error"; runId?: string; message?: string; result?: RoutineExecutionResult };

export interface RoutineRunStreamHandlers {
  onEvent: (event: RoutineRunStreamEvent) => void;
  onConnectionStateChange?: (state: StreamConnectionState) => void;
  onFatalError?: (message: string) => void;
}

export function fetchRoutines(options?: SchedulingScopeOptions): Promise<Routine[]> {
  return api<Routine[]>(withSchedulingScope("/routines", options));
}

export function fetchRoutine(id: string, options?: SchedulingScopeOptions): Promise<Routine> {
  return api<Routine>(withSchedulingScope(`/routines/${id}`, options));
}

export function createRoutine(input: RoutineCreateInput, options?: SchedulingScopeOptions): Promise<Routine> {
  // Forward all input fields including scope metadata
  return api<Routine>(withSchedulingScope("/routines", options), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateRoutine(id: string, updates: RoutineUpdateInput, options?: SchedulingScopeOptions): Promise<Routine> {
  // Forward all update fields including scope metadata
  return api<Routine>(withSchedulingScope(`/routines/${id}`, options), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function deleteRoutine(id: string, options?: SchedulingScopeOptions): Promise<void> {
  await api(withSchedulingScope(`/routines/${id}`, options), {
    method: "DELETE",
  });
}

export function runRoutine(id: string, options?: SchedulingScopeOptions): Promise<RoutineRunResponse> {
  return api<RoutineRunResponse>(withSchedulingScope(`/routines/${id}/trigger`, options), {
    method: "POST",
  });
}

export function streamRoutineRun(id: string, handlers: RoutineRunStreamHandlers, options?: SchedulingScopeOptions & { runId?: string }) {
  const baseUrl = withSchedulingScope(`/routines/${id}/run/stream`, options);
  const separator = baseUrl.includes("?") ? "&" : "?";
  const url = options?.runId ? `${baseUrl}${separator}runId=${encodeURIComponent(options.runId)}` : baseUrl;
  const parse = (type: RoutineRunStreamEvent["type"], event: MessageEvent) => {
    let data: Record<string, unknown> = {};
    try {
      data = event.data ? JSON.parse(event.data) : {};
    } catch {
      data = { message: event.data };
    }
    handlers.onEvent({ type, ...data } as RoutineRunStreamEvent);
  };
  return createResilientEventSource(
    url,
    {
      events: {
        run: (event) => parse("run", event),
        step: (event) => parse("step", event),
        output: (event) => parse("output", event),
        tool: (event) => parse("tool", event),
        complete: (event) => parse("complete", event),
        error: (event) => parse("error", event),
      },
    },
    {
      maxReconnectAttempts: 2,
      onConnectionStateChange: handlers.onConnectionStateChange,
      onFatalError: handlers.onFatalError,
    },
  );
}

export function fetchRoutineRuns(id: string, options?: SchedulingScopeOptions): Promise<RoutineExecutionResult[]> {
  return api<RoutineExecutionResult[]>(withSchedulingScope(`/routines/${id}/runs`, options));
}

export function triggerRoutineWebhook(id: string, payload?: Record<string, unknown>, options?: SchedulingScopeOptions): Promise<RoutineRunResponse> {
  return api<RoutineRunResponse>(withSchedulingScope(`/routines/${id}/webhook`, options), {
    method: "POST",
    body: payload ? JSON.stringify(payload) : undefined,
  });
}

// ── Activity Log API ────────────────────────────────────────────

/** Re-export ActivityLogEntry type from core for convenience */
export type { ActivityLogEntry, ActivityEventType } from "@fusion/core";

/** Fetch activity log entries */
export function fetchActivityLog(options?: { limit?: number; since?: string; type?: ActivityEventType; projectId?: string }): Promise<ActivityLogEntry[]> {
  const search = new URLSearchParams();
  if (options?.limit !== undefined) search.set("limit", String(options.limit));
  if (options?.since !== undefined) search.set("since", options.since);
  if (options?.type !== undefined) search.set("type", options.type);
  if (options?.projectId) search.set("projectId", options.projectId);
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  return api<ActivityLogEntry[]>(`/activity${suffix}`);
}

/** Clear all activity log entries */
export function clearActivityLog(projectId?: string): Promise<{ success: boolean }> {
  const path = withProjectId("/activity", projectId);
  return api<{ success: boolean }>(path, { method: "DELETE" });
}

// ── Workflow Steps ─────────────────────────────────────────────────────

/*
FNXC:WorkflowStepCRUD 2026-06-25-00:00:
U5 removed the legacy `/workflow-steps` CRUD/REST surface (GET list, POST create,
PATCH update, DELETE, refine) along with its Settings management UI. The client
mutation helpers (`createWorkflowStep`/`updateWorkflowStep`/`deleteWorkflowStep`/
`refineWorkflowStepPrompt`/`createWorkflowStepFromTemplate`) had no remaining callers
and were deleted. `fetchWorkflowSteps` is retained as a stable, no-network shim
returning `[]`: its only remaining consumers are the plugin dashboard context's
`workflowSteps` field and the WorkflowResultsTab option list, both of which now source
step state from the graph (optional-group nodes) — the legacy definition list no longer
exists. Removing the field outright is graph-native U3 plumbing work, out of scope here.
*/
/** Legacy workflow-step definition list (removed in U5). Resolves to an empty list:
 *  built-in/custom step definitions are now graph optional-group nodes, not DB rows. */
export function fetchWorkflowSteps(_projectId?: string): Promise<WorkflowStep[]> {
  return Promise.resolve([]);
}

/** Fetch workflow step results for a task */
export function fetchWorkflowResults(taskId: string, projectId?: string): Promise<WorkflowStepResult[]> {
  return api<WorkflowStepResult[]>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/workflow-results`, projectId));
}

// ── Workflow definitions (graph-authored custom workflows) ───────────────

export type {
  WorkflowDefinition,
  WorkflowDefinitionInput,
  WorkflowDefinitionUpdate,
  WorkflowIr,
} from "@fusion/core";

/** List all workflow definitions for the project. */
export function fetchWorkflows(projectId?: string, options?: { includeDisabledBuiltins?: boolean } & FetchOptions): Promise<import("@fusion/core").WorkflowDefinition[]> {
  const query = options?.includeDisabledBuiltins ? "?includeDisabledBuiltins=true" : "";
  const path = withProjectId(`/workflows${query}`, projectId);
  return dedupe(path, () => api<import("@fusion/core").WorkflowDefinition[]>(path), options);
}

/** A trait catalog entry as returned by GET /api/traits (U10). Mirrors the
 *  registry's TraitDefinition projection (flags + hook descriptors + schema). */
export interface TraitCatalogEntry {
  id: string;
  name: string;
  description?: string;
  builtin: boolean;
  flags: import("@fusion/core").TraitFlags;
  hooks?: import("@fusion/core").TraitHookDescriptors;
  configSchema?: import("@fusion/core").TraitConfigSchema;
}

/** Fetch the trait catalog (built-ins + registered plugin traits) for the
 *  workflow editor's trait picker. Registry-backed, read-only, session-scoped. */
export function fetchTraits(projectId?: string): Promise<TraitCatalogEntry[]> {
  const path = withProjectId("/traits", projectId);
  return dedupe(path, () =>
    api<{ traits: TraitCatalogEntry[] }>(path).then((res) => res.traits),
  );
}

/** Fetch the step-parser id catalog (built-ins + registered plugin parsers) for
 *  the parse-steps node inspector (KTD-12). Registry-backed, read-only,
 *  session-scoped. Mirrors fetchTraits. */
export function fetchStepParsers(projectId?: string): Promise<string[]> {
  const path = withProjectId("/step-parsers", projectId);
  return dedupe(path, () =>
    api<{ parsers: Array<{ id: string }> }>(path).then((res) => res.parsers.map((p) => p.id)),
  );
}

/** Fetch a single workflow definition. */
export function fetchWorkflow(id: string, projectId?: string): Promise<import("@fusion/core").WorkflowDefinition> {
  return api<import("@fusion/core").WorkflowDefinition>(withProjectId(`/workflows/${encodeURIComponent(id)}`, projectId));
}

/** Fetch resolved optional step declarations for a workflow. */
export function fetchWorkflowOptionalSteps(
  workflowId: string,
  projectId?: string,
): Promise<import("@fusion/core").ResolvedWorkflowOptionalStep[]> {
  return api<import("@fusion/core").ResolvedWorkflowOptionalStep[]>(
    withProjectId(`/workflows/${encodeURIComponent(workflowId)}/optional-steps`, projectId),
  );
}

/** Create a workflow definition. */
export function createWorkflow(
  input: import("@fusion/core").WorkflowDefinitionInput,
  projectId?: string,
): Promise<import("@fusion/core").WorkflowDefinition> {
  return api<import("@fusion/core").WorkflowDefinition>(withProjectId("/workflows", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update a workflow definition (partial). */
export function updateWorkflow(
  id: string,
  updates: import("@fusion/core").WorkflowDefinitionUpdate,
  projectId?: string,
): Promise<import("@fusion/core").WorkflowDefinition> {
  return api<import("@fusion/core").WorkflowDefinition>(withProjectId(`/workflows/${encodeURIComponent(id)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete a workflow definition. */
export function deleteWorkflow(id: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/workflows/${encodeURIComponent(id)}`, projectId), { method: "DELETE" });
}

/** The per-`(workflowId, project)` setting-value payload returned by the
 *  workflow setting-value endpoints (U6/R5): the raw `stored` map, the
 *  `effective` map (stored ?? declaration default, drop-on-orphan), and the
 *  `orphaned` stored entries that no longer validate against the declarations. */
export interface WorkflowSettingValuesPayload {
  stored: Record<string, unknown>;
  effective: Record<string, unknown>;
  orphaned: Array<{ id: string; value: unknown }>;
}

/** Per-project workflow prompt override payload. `defaults` is the shipped prompt
 *  by node id, `stored` is the persisted override map, and `effective` is the
 *  prompt text the editor/executor sees after stored-over-default resolution. */
export interface WorkflowPromptOverridesPayload {
  stored: Record<string, string>;
  effective: Record<string, string>;
  defaults: Record<string, string>;
}

/** Read the setting VALUES (stored/effective/orphaned) for a workflow in the
 *  current project context (U6). The project is bound server-side to the
 *  scoped store. */
export function fetchWorkflowSettingValues(
  id: string,
  projectId?: string,
): Promise<WorkflowSettingValuesPayload> {
  return api<WorkflowSettingValuesPayload>(
    withProjectId(`/workflows/${encodeURIComponent(id)}/setting-values`, projectId),
  );
}

/** Write setting VALUES for a workflow in the current project context (U6). The
 *  `values` map is validated against the named workflow's declarations; a `null`
 *  value deletes that key. A typed rejection surfaces as an ApiRequestError with
 *  `status: 400` and `details.rejections: WorkflowSettingRejection[]`. */
export function updateWorkflowSettingValues(
  id: string,
  values: Record<string, unknown>,
  projectId?: string,
): Promise<WorkflowSettingValuesPayload> {
  return api<WorkflowSettingValuesPayload>(
    withProjectId(`/workflows/${encodeURIComponent(id)}/setting-values`, projectId),
    {
      method: "PATCH",
      body: JSON.stringify({ values }),
    },
  );
}

/** Read per-node prompt overrides for a workflow in the current project context. */
export function fetchWorkflowPromptOverrides(
  id: string,
  projectId?: string,
): Promise<WorkflowPromptOverridesPayload> {
  return api<WorkflowPromptOverridesPayload>(
    withProjectId(`/workflows/${encodeURIComponent(id)}/prompt-overrides`, projectId),
  );
}

/** Patch per-node prompt overrides. Null, empty, and whitespace values reset to the shipped default. */
export function updateWorkflowPromptOverrides(
  id: string,
  overrides: Record<string, string | null>,
  projectId?: string,
): Promise<WorkflowPromptOverridesPayload> {
  return api<WorkflowPromptOverridesPayload>(
    withProjectId(`/workflows/${encodeURIComponent(id)}/prompt-overrides`, projectId),
    {
      method: "PATCH",
      body: JSON.stringify({ overrides }),
    },
  );
}

/** A workflow export envelope (U5/R9/KTD-5). `schemaVersion` is the SERVER's
 *  schema version at export time — the import route version-gates against it
 *  (the app build aliases @fusion/core to types-only, so the value can only come
 *  from the server, never an app-side core import).
 *
 *  FNXC:WorkflowPortability 2026-06-30-00:00:
 *  Dashboard downloads must carry project-scoped setting values and prompt overrides with the workflow graph so the same shared API path supports portable desktop and mobile Workflow Editor imports.
 */
export interface WorkflowExportEnvelope {
  fusionWorkflowExport: 1;
  schemaVersion: number;
  kind: import("@fusion/core").WorkflowDefinition["kind"];
  name: string;
  description: string;
  ir: import("@fusion/core").WorkflowIr;
  layout: import("@fusion/core").WorkflowDefinition["layout"];
  settingValues: Record<string, unknown>;
  promptOverrides: Record<string, string>;
}

/** Fetch a workflow's export envelope and trigger a browser download as
 *  `<name>.workflow.json` (U5/R9). Built-ins are exportable too. Mirrors the
 *  SettingsModal export pattern (Blob + createObjectURL + a.download). */
export async function exportWorkflow(id: string, projectId?: string): Promise<WorkflowExportEnvelope> {
  const envelope = await api<WorkflowExportEnvelope>(
    withProjectId(`/workflows/${encodeURIComponent(id)}/export`, projectId),
  );
  const safeName = (envelope.name || "workflow").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeName}.workflow.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  return envelope;
}

/** Result of POST /api/workflows/import (U5/R10). `strippedApprovalFlags` is set
 *  when `cliSkipApproval`/`autoApprove` were removed from any node config at the
 *  trust boundary; `warnings` lists non-blocking issues (e.g. unknown scriptName). */
export interface ImportWorkflowResult {
  workflow: import("@fusion/core").WorkflowDefinition;
  strippedApprovalFlags: boolean;
  warnings: string[];
  settingValues: Record<string, unknown>;
  promptOverrides: Record<string, string>;
}

/** Import a workflow export envelope (U5/R10). The server is the sole validator;
 *  validation failures reject with an ApiError carrying the server message. */
export function importWorkflow(
  envelope: unknown,
  projectId?: string,
): Promise<ImportWorkflowResult> {
  return api<ImportWorkflowResult>(withProjectId("/workflows/import", projectId), {
    method: "POST",
    body: JSON.stringify(envelope),
  });
}

// FNXC:WorkflowStepCRUD 2026-06-26-14:00: U7c removed migrateLegacyWorkflowSteps and
// MigrateLegacyStepsResult along with the legacy workflow_steps table and its route.

/** Result of POST /api/workflows/design (U10/R11). The server validates the
 *  AI-produced IR (parseWorkflowIr) and strips trust-escalating flags
 *  (`strippedApprovalFlags`). Persists nothing — the client decides what to do
 *  with the returned graph. */
export interface DesignWorkflowResult {
  ir: import("@fusion/core").WorkflowIr;
  layout: import("@fusion/core").WorkflowDefinition["layout"];
  strippedApprovalFlags: boolean;
}

/** Design a workflow from a natural-language prompt (U10/R11). When `workflowId`
 *  is supplied the route reads that workflow's persisted IR server-side and folds
 *  it into the prompt as the base graph (the client never posts IR). An optional
 *  AbortSignal cancels the in-flight request. Validation failures reject with an
 *  ApiError carrying the server message; 429 on rate limit. */
export function designWorkflow(
  input: { prompt: string; workflowId?: string },
  projectId?: string,
  signal?: AbortSignal,
): Promise<DesignWorkflowResult> {
  return api<DesignWorkflowResult>(withProjectId("/workflows/design", projectId), {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
}

/** Read the workflow currently selected for a task. */
export function fetchTaskWorkflow(taskId: string, projectId?: string): Promise<{ workflowId: string | null; enabledWorkflowSteps?: string[] | null }> {
  return api<{ workflowId: string | null; enabledWorkflowSteps?: string[] | null }>(
    withProjectId(`/tasks/${encodeURIComponent(taskId)}/workflow`, projectId),
  );
}

/** Select (or clear, with null) a workflow for a task. Returns the resulting
 *  enabled step ids so callers can reflect the change without a refetch. */
export function selectTaskWorkflow(
  taskId: string,
  workflowId: string | null,
  projectId?: string,
): Promise<{
  workflowId: string | null;
  enabledWorkflowSteps: string[];
  // U5 (R20): present (flag ON) when the switch re-homed the card; `preserved`
  // false means the card moved columns and the board needs a refresh.
  reconciliation?: { preserved: boolean; fromColumn: string; toColumn: string };
}> {
  return api<{
    workflowId: string | null;
    enabledWorkflowSteps: string[];
    reconciliation?: { preserved: boolean; fromColumn: string; toColumn: string };
  }>(
    withProjectId(`/tasks/${encodeURIComponent(taskId)}/workflow`, projectId),
    {
      method: "PUT",
      body: JSON.stringify({ workflowId }),
    },
  );
}

/** Approve the raw CLI command a task is paused on, and resume it. */
export function approveTaskWorkflowCli(taskId: string, projectId?: string): Promise<{ approved: string }> {
  return api<{ approved: string }>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/workflow/approve-cli`, projectId), {
    method: "POST",
  });
}

/** Submit the user's answer to an await-input node and resume the task. */
export function submitTaskWorkflowInput(taskId: string, text: string, projectId?: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/workflow/input`, projectId), {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

/** Read the project default workflow. */
export function fetchProjectDefaultWorkflow(projectId?: string): Promise<{ workflowId: string | null }> {
  return api<{ workflowId: string | null }>(withProjectId("/project/default-workflow", projectId));
}

/** Set (or clear, with null) the project default workflow. */
export function setProjectDefaultWorkflow(
  workflowId: string | null,
  projectId?: string,
): Promise<{ workflowId: string | null }> {
  return api<{ workflowId: string | null }>(withProjectId("/project/default-workflow", projectId), {
    method: "PUT",
    body: JSON.stringify({ workflowId }),
  });
}

// ── Workflow Step Templates ──────────────────────────────────────────────

/** Re-export WorkflowStepTemplate type from core */
export type { WorkflowStepTemplate } from "@fusion/core";

/** Fetch the workflow step templates that feed the editor palette. The built-in
 *  built-in step-template catalog was deleted in U6, so this now returns only
 *  plugin-contributed templates. */
export function fetchWorkflowStepTemplates(): Promise<{ templates: import("@fusion/core").WorkflowStepTemplate[] }> {
  return api<{ templates: import("@fusion/core").WorkflowStepTemplate[] }>("/workflow-step-templates");
}

/** Fetch plugin-contributed workflow step templates */
export function fetchPluginWorkflowStepTemplates(): Promise<{
  templates: Array<{ pluginId: string; template: import("@fusion/core").WorkflowStepTemplate }>;
}> {
  return api<{
    templates: Array<{ pluginId: string; template: import("@fusion/core").WorkflowStepTemplate }>;
  }>("/plugin-workflow-step-templates");
}

// ── Scripts API ────────────────────────────────────────────────────────

/** Script entry returned from the API */
export interface ScriptEntry {
  name: string;
  command: string;
}

/** Result of running a script via POST /api/scripts/:name/run */
export interface ScriptRunResult {
  sessionId: string;
  command: string;
}

/** Fetch all saved scripts from project settings */
export function fetchScripts(projectId?: string): Promise<Record<string, string>> {
  return api<Record<string, string>>(withProjectId("/scripts", projectId));
}

/** Add or update a script */
export function addScript(name: string, command: string, projectId?: string): Promise<ScriptEntry> {
  return api<ScriptEntry>(withProjectId("/scripts", projectId), {
    method: "POST",
    body: JSON.stringify({ name, command }),
  });
}

/** Remove a script by name */
export function removeScript(name: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/scripts/${encodeURIComponent(name)}`, projectId), { method: "DELETE" });
}

/** Run a saved script by name */
export function runScript(name: string, args?: string[], projectId?: string): Promise<ScriptRunResult> {
  return api<ScriptRunResult>(withProjectId(`/scripts/${encodeURIComponent(name)}/run`, projectId), {
    method: "POST",
    body: JSON.stringify({ args }),
  });
}

// ── AI Text Refinement API ────────────────────────────────────────────

/** Refinement types for AI text refinement */
export type RefinementType = "clarify" | "add-details" | "expand" | "simplify";

/** Response from text refinement endpoint */
export interface RefineTextResponse {
  refined: string;
}

export interface DraftGoalDescriptionResponse {
  description: string;
}

/**
 * Refine task description text using AI.
 * @param text - The text to refine (1-2000 characters)
 * @param type - The refinement type: clarify, add-details, expand, or simplify
 * @param projectId - Optional project ID for scoped settings resolution
 * @returns The refined text
 * @throws Error with message for rate limit (429), invalid type (422), validation (400), or server errors
 */
export async function refineText(text: string, type: RefinementType, projectId?: string): Promise<string> {
  const response = await api<RefineTextResponse>(withProjectId("/ai/refine-text", projectId), {
    method: "POST",
    body: JSON.stringify({ text, type }),
  });
  return response.refined;
}

/**
 * Error messages for refineText failures (to use with toast notifications).
 */
export const REFINE_ERROR_MESSAGES = {
  /** Rate limit exceeded (429) */
  RATE_LIMIT: "Too many refinement requests. Please wait an hour.",
  /** Invalid refinement type (422) */
  INVALID_TYPE: "Invalid refinement option selected.",
  /** Network or server errors */
  NETWORK: "Failed to refine text. Please try again.",
} as const;

/**
 * Get user-friendly error message for a refineText error.
 * @param error - The error thrown by refineText
 * @returns A user-friendly error message suitable for toast display
 */
export function getRefineErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return REFINE_ERROR_MESSAGES.NETWORK;
  }

  const message = error.message.toLowerCase();

  // Rate limit errors (429)
  if (message.includes("rate limit") || message.includes("429")) {
    return REFINE_ERROR_MESSAGES.RATE_LIMIT;
  }

  // Invalid type errors (422)
  if (message.includes("invalid") && message.includes("type")) {
    return REFINE_ERROR_MESSAGES.INVALID_TYPE;
  }

  // Validation errors (400) - pass through from backend
  if (
    message.startsWith("text must") ||
    message.startsWith("title must") ||
    message.includes("text is required") ||
    message.includes("type is required") ||
    message.includes("title is required")
  ) {
    return error.message;
  }

  // Default network/server error
  return REFINE_ERROR_MESSAGES.NETWORK;
}

/**
 * Draft a goal description using AI from a goal title.
 * @param title - The goal title to expand into a draft description
 * @param projectId - Optional project ID for scoped settings resolution
 * @returns The drafted goal description
 * @throws Error with message for rate limit (429), validation (400), or server errors
 */
export async function draftGoalDescription(title: string, projectId?: string): Promise<string> {
  const response = await api<DraftGoalDescriptionResponse>(withProjectId("/ai/draft-goal-description", projectId), {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  return response.description;
}

/*
FNXC:GitHubImportTranslate 2026-07-14-12:00:
Client for POST /api/ai/translate-text — used by the GitHub/GitLab import preview when issue/PR prose is not the dashboard language.
Structured title+body fields keep markdown import content intact; shares the AI-helper rate-limit budget with refine/draft.
*/
export interface TranslateImportFields {
  title?: string;
  body?: string;
}

export interface TranslateImportContentResponse {
  fields: TranslateImportFields;
}

/**
 * Translate import-preview title/body into the dashboard locale via AI.
 * @param fields - Original title and/or body
 * @param targetLocale - Active dashboard locale
 * @param projectId - Optional project scope for settings/MCP
 * @param sourceLocale - Optional detection hint for the model
 */
export async function translateImportContent(
  fields: TranslateImportFields,
  targetLocale: string,
  projectId?: string,
  sourceLocale?: string,
): Promise<TranslateImportFields> {
  const response = await api<TranslateImportContentResponse>(
    withProjectId("/ai/translate-text", projectId),
    {
      method: "POST",
      body: JSON.stringify({
        fields,
        targetLocale,
        ...(sourceLocale ? { sourceLocale } : {}),
      }),
    },
  );
  return response.fields;
}

/*
FNXC:GitHubImportTranslate 2026-07-15-09:30:
Auto-translate the visible import list in ONE request. The server reads through its durable cache, so a repeat load of the same repo returns instantly and bills nothing; the same cache is what the import path reads, so an imported task carries the translation shown here.
The server enforces the auto-translate setting and the 50-issue cap itself and echoes `enabled`/`capped` back, so the client never has to duplicate that policy.
*/
export interface AutoTranslateImportItem {
  number: number;
  title: string;
  body: string | null;
  state?: "open" | "closed";
}

export interface AutoTranslateImportResponse {
  translations: Record<number, { title: string; body: string }>;
  enabled: boolean;
  targetLocale: string | null;
  /** True when more foreign issues existed than the per-load cap. */
  capped: boolean;
}

export async function autoTranslateImportIssues(
  owner: string,
  repo: string,
  items: AutoTranslateImportItem[],
  targetLocale: string,
  projectId?: string,
): Promise<AutoTranslateImportResponse> {
  return api<AutoTranslateImportResponse>(
    withProjectId("/github/issues/auto-translate", projectId),
    {
      method: "POST",
      body: JSON.stringify({ owner, repo, items, targetLocale }),
    },
  );
}

/** User-facing error copy for translateImportContent failures (toast/banner). */
export const TRANSLATE_ERROR_MESSAGES = {
  RATE_LIMIT: "Too many translation requests. Please wait an hour.",
  NETWORK: "Failed to translate content. Please try again.",
} as const;

/**
 * Map a translateImportContent error to banner-safe copy.
 */
export function getTranslateErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return TRANSLATE_ERROR_MESSAGES.NETWORK;
  }

  const message = error.message.toLowerCase();
  if (message.includes("rate limit") || message.includes("429")) {
    return TRANSLATE_ERROR_MESSAGES.RATE_LIMIT;
  }
  if (
    message.startsWith("fields") ||
    message.startsWith("text to translate") ||
    message.startsWith("targetlocale") ||
    message.includes("targetlocale must") ||
    message.includes("sourceLocale must")
  ) {
    return error.message;
  }
  return TRANSLATE_ERROR_MESSAGES.NETWORK;
}

export function startSubtaskBreakdown(description: string, projectId?: string): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(withProjectId("/subtasks/start-streaming", projectId), {
    method: "POST",
    body: JSON.stringify({ description }),
  });
}

export function retrySubtaskSession(
  sessionId: string,
  projectId?: string,
): Promise<{ success: boolean; sessionId: string }> {
  return api<{ success: boolean; sessionId: string }>(
    withProjectId(`/subtasks/${encodeURIComponent(sessionId)}/retry`, projectId),
    { method: "POST" },
  );
}

export function getSubtaskStreamUrl(sessionId: string, projectId?: string): string {
  return buildApiUrl(withProjectId(`/subtasks/${encodeURIComponent(sessionId)}/stream`, projectId));
}

export function connectSubtaskStream(
  sessionId: string,
  projectId: string | undefined,
  handlers: {
    onThinking?: (data: string) => void;
    onSubtasks?: (data: SubtaskItem[]) => void;
    onError?: (data: string) => void;
    onComplete?: () => void;
    onConnectionStateChange?: (state: StreamConnectionState) => void;
  },
  options?: { maxReconnectAttempts?: number },
): { close: () => void; isConnected: () => boolean } {
  let keepAlive: { stop: () => void } | null = null;
  let connection: { close: () => void; isConnected: () => boolean } | null = null;

  const stopKeepAlive = () => {
    keepAlive?.stop();
    keepAlive = null;
  };

  const resilient = createResilientEventSource(
    getSubtaskStreamUrl(sessionId, projectId),
    {
      onOpen: () => {
        stopKeepAlive();
        keepAlive = startKeepAlive(sessionId, projectId);
      },
      events: {
        thinking: (event) => {
          try {
            handlers.onThinking?.(JSON.parse(event.data));
          } catch {
            handlers.onThinking?.(event.data);
          }
        },
        subtasks: (event) => {
          try {
            handlers.onSubtasks?.(JSON.parse(event.data) as SubtaskItem[]);
          } catch (err) {
            console.error("[subtasks] Failed to parse subtasks event:", err);
          }
        },
        error: (event) => {
          try {
            const parsedData = JSON.parse(event.data);
            const errorMessage = typeof parsedData === "string" && parsedData.length > 0 ? parsedData : null;
            handlers.onError?.(errorMessage || "Stream error");
          } catch {
            handlers.onError?.("Stream error");
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

export function createTasksFromBreakdown(
  sessionId: string,
  subtasks: SubtaskItem[],
  parentTaskId?: string,
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
    workflowId?: string | null;
  },
): Promise<{ tasks: Task[]; parentTaskClosed?: boolean }> {
  return api<{ tasks: Task[]; parentTaskClosed?: boolean }>(withProjectId("/subtasks/create-tasks", projectId), {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      parentTaskId,
      ...(options?.branch !== undefined ? { branch: options.branch } : {}),
      ...(options?.baseBranch !== undefined ? { baseBranch: options.baseBranch } : {}),
      ...(options?.branchSelection ? { branchSelection: options.branchSelection } : {}),
      ...(options?.branchAssignment ? { branchAssignment: options.branchAssignment } : {}),
      ...(options?.workflowId !== undefined ? { workflowId: options.workflowId } : {}),
      subtasks: subtasks.map((subtask) => ({
        tempId: subtask.id,
        title: subtask.title,
        description: subtask.description,
        size: subtask.suggestedSize,
        dependsOn: subtask.dependsOn,
      })),
    }),
  });
}

export function cancelSubtaskBreakdown(sessionId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId("/subtasks/cancel", projectId), {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

// ── Agent API ────────────────────────────────────────────────────────────

import type {
  Agent,
  AgentDetail,
  AgentCapability,
  AgentState,
  AgentHeartbeatEvent,
  AgentHeartbeatRun,
  AgentCreateInput,
  AgentUpdateInput,
  AgentTaskSession,
  AgentStats,
  HeartbeatInvocationSource,
  OrgTreeNode,
  AgentReflection,
  AgentPerformanceSummary,
  ReflectionTrigger,
  AgentBudgetStatus,
} from "@fusion/core";
export type { Agent, AgentDetail, AgentCapability, AgentState, AgentHeartbeatEvent, AgentHeartbeatRun, AgentCreateInput, AgentUpdateInput, AgentTaskSession, AgentStats, HeartbeatInvocationSource, OrgTreeNode, AgentReflection, AgentPerformanceSummary, ReflectionTrigger, AgentBudgetStatus };

export interface AgentPromptSizePoint {
  runId: string;
  createdAt: string;
  systemChars: number;
  execChars: number;
  totalChars: number;
}


/** Append repoPath query param for workspace-mode sub-repo targeting */
function withRepoPath(path: string, repoPath?: string): string {
  if (!repoPath) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}repoPath=${encodeURIComponent(repoPath)}`;
}

/** Fetch workspace sub-repos for a project */
export function fetchWorkspaceRepos(projectId?: string): Promise<{ repos: string[] }> {
  return api<{ repos: string[] }>(withProjectId("/git/workspace-repos", projectId));
}

/** Fetch all agents, optionally filtered by state or role */
export function fetchAgents(
  filter?: { state?: AgentState; role?: AgentCapability; includeEphemeral?: boolean },
  projectId?: string,
  options?: FetchOptions,
): Promise<Agent[]> {
  const params = new URLSearchParams();
  if (filter?.state) params.set("state", filter.state);
  if (filter?.role) params.set("role", filter.role);
  if (filter?.includeEphemeral === true) params.set("includeEphemeral", "true");
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const path = `/agents${query}`;
  return dedupe(path, () => api<Agent[]>(path), options);
}

/** Fetch a single agent with heartbeat history */
export function fetchAgent(agentId: string, projectId?: string): Promise<AgentDetail> {
  return api<AgentDetail>(withProjectId(`/agents/${encodeURIComponent(agentId)}`, projectId));
}

/** Create a new agent */
export function createAgent(input: AgentCreateInput, projectId?: string): Promise<Agent> {
  return api<Agent>(withProjectId("/agents", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update an agent */
export function updateAgent(agentId: string, updates: AgentUpdateInput, projectId?: string): Promise<Agent> {
  return api<Agent>(withProjectId(`/agents/${encodeURIComponent(agentId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Upload an agent avatar image. */
export async function uploadAgentAvatar(agentId: string, file: File, projectId?: string): Promise<Agent> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(buildApiUrl(withProjectId(`/agents/${encodeURIComponent(agentId)}/avatar`, projectId)), {
    method: "POST",
    headers: withTokenHeader(),
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || "Avatar upload failed");
  }
  return data as Agent;
}

/** Delete an agent avatar image. */
export function deleteAgentAvatar(agentId: string, projectId?: string): Promise<Agent> {
  return api<Agent>(withProjectId(`/agents/${encodeURIComponent(agentId)}/avatar`, projectId), {
    method: "DELETE",
  });
}

/** Backfill an existing agent onto the default heartbeat procedure file. */
export function upgradeAgentHeartbeatProcedure(
  agentId: string,
  projectId?: string,
): Promise<{ agent: Agent; heartbeatProcedurePath: string; procedureFileSeeded: boolean }> {
  return api(
    withProjectId(`/agents/${encodeURIComponent(agentId)}/upgrade-heartbeat-procedure`, projectId),
    { method: "POST" },
  );
}

/** Update agent custom instructions */
export function updateAgentInstructions(
  agentId: string,
  instructions: { instructionsPath?: string; instructionsText?: string },
  projectId?: string,
): Promise<Agent> {
  return api<Agent>(withProjectId(`/agents/${encodeURIComponent(agentId)}/instructions`, projectId), {
    method: "PATCH",
    body: JSON.stringify(instructions),
  });
}

/** Fetch agent soul/personality text */
export function fetchAgentSoul(agentId: string, projectId?: string): Promise<{ soul: string | null }> {
  return api<{ soul: string | null }>(withProjectId(`/agents/${encodeURIComponent(agentId)}/soul`, projectId));
}

/** Update agent soul/personality text */
export function updateAgentSoul(agentId: string, soul: string, projectId?: string): Promise<Agent> {
  return api<Agent>(withProjectId(`/agents/${encodeURIComponent(agentId)}/soul`, projectId), {
    method: "PATCH",
    body: JSON.stringify({ soul }),
  });
}

/** Fetch per-agent memory text */
export function fetchAgentMemory(agentId: string, projectId?: string): Promise<{ memory: string | null }> {
  return api<{ memory: string | null }>(withProjectId(`/agents/${encodeURIComponent(agentId)}/memory`, projectId));
}

/** Update per-agent memory text */
export function updateAgentMemory(agentId: string, memory: string, projectId?: string): Promise<Agent> {
  return api<Agent>(withProjectId(`/agents/${encodeURIComponent(agentId)}/memory`, projectId), {
    method: "PATCH",
    body: JSON.stringify({ memory }),
  });
}

/** List file-based memory entries for a specific agent */
export function fetchAgentMemoryFiles(agentId: string, projectId?: string): Promise<{ files: MemoryFileInfo[] }> {
  return api<{ files: MemoryFileInfo[] }>(withProjectId(`/agents/${encodeURIComponent(agentId)}/memory/files`, projectId));
}

/** Read one file-based memory entry for a specific agent */
export function fetchAgentMemoryFile(agentId: string, path: string, projectId?: string): Promise<{ path: string; content: string }> {
  const query = `path=${encodeURIComponent(path)}`;
  return api<{ path: string; content: string }>(withProjectId(`/agents/${encodeURIComponent(agentId)}/memory/file?${query}`, projectId));
}

/** Save one file-based memory entry for a specific agent */
export function saveAgentMemoryFile(agentId: string, path: string, content: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId(`/agents/${encodeURIComponent(agentId)}/memory/file`, projectId), {
    method: "PUT",
    body: JSON.stringify({ path, content }),
  });
}

/** Update an agent's state */
export function updateAgentState(agentId: string, state: AgentState, projectId?: string): Promise<Agent> {
  return api<Agent>(withProjectId(`/agents/${encodeURIComponent(agentId)}/state`, projectId), {
    method: "POST",
    body: JSON.stringify({ state }),
  });
}

/** Delete an agent */
export function deleteAgent(agentId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/agents/${encodeURIComponent(agentId)}`, projectId), {
    method: "DELETE",
  });
}

/** Record a heartbeat for an agent */
export function recordAgentHeartbeat(
  agentId: string,
  status: "ok" | "missed" | "recovered" = "ok",
  projectId?: string,
): Promise<AgentHeartbeatEvent> {
  return api<AgentHeartbeatEvent>(withProjectId(`/agents/${encodeURIComponent(agentId)}/heartbeat`, projectId), {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}

/** Fetch heartbeat history for an agent */
export function fetchAgentHeartbeats(agentId: string, limit?: number, projectId?: string): Promise<AgentHeartbeatEvent[]> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<AgentHeartbeatEvent[]>(`/agents/${encodeURIComponent(agentId)}/heartbeats${query}`);
}

/** Fetch heartbeat runs for an agent */
export function fetchAgentRuns(agentId: string, limit?: number, projectId?: string): Promise<AgentHeartbeatRun[]> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<AgentHeartbeatRun[]>(`/agents/${encodeURIComponent(agentId)}/runs${query}`);
}

/** Fetch a single heartbeat run detail */
export function fetchAgentRunDetail(agentId: string, runId: string, projectId?: string): Promise<AgentHeartbeatRun> {
  return api<AgentHeartbeatRun>(withProjectId(`/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`, projectId));
}

/** Fetch agent logs for a specific run's time window */
export function fetchAgentRunLogs(agentId: string, runId: string, projectId?: string): Promise<AgentLogEntry[]> {
  return api<AgentLogEntry[]>(withProjectId(`/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/logs`, projectId));
}

/** Fetch recent prompt size points for an agent */
export function fetchAgentPromptSizes(agentId: string, limit?: number, projectId?: string): Promise<AgentPromptSizePoint[]> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<AgentPromptSizePoint[]>(`/agents/${encodeURIComponent(agentId)}/prompt-sizes${query}`);
}

/** Manually start a heartbeat run for an agent */
export function startAgentRun(
  agentId: string,
  projectId?: string,
  options?: { source?: HeartbeatInvocationSource; triggerDetail?: string },
): Promise<AgentHeartbeatRun> {
  const source = options?.source ?? "manual";
  const triggerDetail = options?.triggerDetail ?? "Agent activated via dashboard";
  return api<AgentHeartbeatRun>(withProjectId(`/agents/${encodeURIComponent(agentId)}/runs`, projectId), {
    method: "POST",
    body: JSON.stringify({ source, triggerDetail }),
  });
}

/** Stop an active heartbeat run for an agent */
export function stopAgentRun(
  agentId: string,
  projectId?: string,
): Promise<{ ok: boolean; runId?: string; message?: string }> {
  return api<{ ok: boolean; runId?: string; message?: string }>(
    withProjectId(`/agents/${encodeURIComponent(agentId)}/runs/stop`, projectId),
    {
      method: "POST",
    },
  );
}

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

// ── Project Management API (Multi-Project Support) ───────────────────────

/** Project information returned by project endpoints */
export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  status: "active" | "paused" | "errored" | "initializing";
  isolationMode: "in-process" | "child-process";
  nodeId?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
}

/** Project health metrics */
export interface CodebaseMetrics {
  tokenEstimate: number;
  sourceFileCount: number;
  sourceByteCount: number;
  diskBytes: number;
  diskFileCount: number;
  method: string;
  truncated: boolean;
}

export interface ProjectHealth {
  projectId: string;
  status: "active" | "paused" | "errored" | "initializing";
  activeTaskCount: number;
  inFlightAgentCount: number;
  lastActivityAt?: string;
  lastErrorAt?: string;
  lastErrorMessage?: string;
  totalTasksCompleted: number;
  totalTasksFailed: number;
  averageTaskDurationMs?: number;
  updatedAt: string;
}

/**
 * Executor state values.
 *
 * FNXC:EngineControls 2026-06-22-00:00:
 * A globally stopped AI engine (`globalPause`) is an operator action, not idleness; the footer must expose it as "Stopped" in error red with the stop-rectangle icon.
 */
export type ExecutorState = "idle" | "running" | "paused" | "stopped";

/** Aggregated executor statistics for the status bar.
 * 
 * Counts (runningTaskCount, blockedTaskCount, queuedTaskCount, inReviewCount, stuckTaskCount)
 * are derived client-side from the same tasks array shared with the board, ensuring
 * the footer counts always match the active work states displayed on screen. Queued covers
 * todo plus planning/triage work; Done is intentionally not exposed unless a footer Done
 * segment is added.
 * The API returns settings-based values (globalPause, enginePaused, maxConcurrent) and
 * lastActivityAt from the activity log.
 * 
 * The executorState is derived from:
 * - "stopped": globalPause is true
 * - "idle": (enginePaused is true AND runningTaskCount is 0) OR not paused with nothing running
 * - "paused": enginePaused is true AND runningTaskCount > 0
 * - "running": globalPause is false AND enginePaused is false AND runningTaskCount > 0
 */
export interface ExecutorStats {
  /** Number of tasks currently in "in-progress" column */
  runningTaskCount: number;
  /** Number of tasks with blockedBy field set (waiting on file overlap) */
  blockedTaskCount: number;
  /** Number of "in-progress" tasks with no activity for > 10 minutes */
  stuckTaskCount: number;
  /** Number of tasks in "todo" plus planning/triage work states */
  queuedTaskCount: number;
  /** Number of tasks in "in-review" column */
  inReviewCount: number;
  /** Derived executor state: "idle", "running", "paused", or "stopped" */
  executorState: ExecutorState;
  /** Maximum concurrent tasks allowed from settings */
  maxConcurrent: number;
  /** ISO timestamp of most recent task event from activity log */
  lastActivityAt?: string;
}

/** Unified activity feed entry */
export interface ActivityFeedEntry {
  id: string;
  timestamp: string;
  type: ActivityEventType;
  projectId: string;
  projectName: string;
  taskId?: string;
  taskTitle?: string;
  details: string;
  metadata?: Record<string, unknown>;
}

/** Input for creating a new project */
export interface ProjectCreateInput {
  name: string;
  path: string;
  isolationMode?: "in-process" | "child-process";
  nodeId?: string;
  gitSetupMode?: "existing" | "init" | "clone";
  cloneUrl?: string;
  workspaceMode?: boolean;
  taskPrefix?: string;
}

export type DockerNodeConfigInfo = DockerNodeConfig;
export type { DockerNodeConfig };

/** Node information returned by node endpoints */
export interface NodeInfo {
  id: NodeConfig["id"];
  name: NodeConfig["name"];
  type: NodeConfig["type"];
  url?: NodeConfig["url"];
  apiKey?: NodeConfig["apiKey"];
  status: NodeStatus;
  capabilities?: NodeConfig["capabilities"];
  maxConcurrent: NodeConfig["maxConcurrent"];
  createdAt: NodeConfig["createdAt"];
  updatedAt: NodeConfig["updatedAt"];
  dockerConfig?: DockerNodeConfigInfo;
}

/** Managed Docker node information returned by docker node endpoints */
export interface DockerNodeInfo {
  id: string;
  nodeId: string | null;
  name: string;
  nodeType: "docker-managed";
  imageName: string;
  imageTag: string;
  containerId: string | null;
  status: DockerNodeStatus;
  hostConfig: DockerHostConfig;
  envVars: Record<string, string>;
  volumeMounts: DockerVolumeMount[];
  resourceSizing: DockerResourceSizing;
  extraClis: DockerExtraCli[];
  persistentStorage: boolean;
  reachableUrl: string | null;
  apiKey: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedDockerNodeInfo {
  id: string;
  nodeId?: string;
  name: string;
  containerId?: string;
  status: string;
  hostConfig: {
    type: "local" | "remote";
    host?: string;
    context?: string;
    tlsOptions?: Record<string, unknown>;
  };
  envVars: Record<string, string>;
  reachableUrl?: string;
  imageName: string;
  imageTag: string;
  volumeMounts: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>;
  persistentStorage: boolean;
  resourceSizing?: { cpuLimit?: string; memoryLimit?: string };
  errorMessage?: string;
  linkedNode?: NodeInfo;
  createdAt: string;
  updatedAt: string;
}

export interface ContainerStatusInfo {
  running: boolean;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
  ports?: Record<string, string>;
}

/** Node discovered over local network mDNS/DNS-SD */
export interface DiscoveredNodeInfo {
  name: string;
  host: string;
  port: number;
  nodeType: "local" | "remote";
  nodeId?: string;
  discoveredAt: string;
  lastSeenAt: string;
}

/** Input for creating a new node */
export interface NodeCreateInput {
  name: string;
  type: "local" | "remote";
  url?: string;
  apiKey?: string;
  maxConcurrent?: number;
  dockerConfig?: DockerNodeConfigInfo;
}

/** Input for assigning a project path for a specific node during onboarding. */
export interface NodeProjectMappingInput {
  projectId: string;
  path: string;
}

export interface RemoteNodeDiscoveredProject {
  id: string;
  name: string;
  path: string;
  status: "active" | "paused" | "errored" | "initializing";
  isolationMode: "in-process" | "child-process";
}

export interface RemoteNodeProjectDiscoveryResult {
  projects: RemoteNodeDiscoveredProject[];
}

/**
 * Node onboarding payload used by dashboard UI.
 *
 * `projectMappings` is intentionally separate from `ProjectInfo.path` and `projects.nodeId`.
 * It captures node-specific filesystem paths for selected existing projects.
 */
export interface NodeOnboardingInput extends NodeCreateInput {
  projectMappings: NodeProjectMappingInput[];
}

/** Input for updating an existing node */
export type NodeUpdateInput = Partial<Pick<NodeCreateInput, "name" | "type" | "url" | "apiKey" | "maxConcurrent" | "dockerConfig">> & {
  status?: NodeStatus;
  capabilities?: string[];
};

/** Result from a node health check */
export interface NodeHealthCheckResult {
  nodeId: string;
  status: NodeStatus;
  responseTimeMs?: number;
  error?: string;
  checkedAt: string;
}

/** Runtime metrics for a node */
export interface NodeMetrics {
  nodeId: string;
  activeTaskCount: number;
  inFlightAgentCount: number;
  uptimeMs: number;
  lastActivityAt?: string;
}

/** Options for fetching activity feed */
export interface FeedOptions {
  limit?: number;
  since?: string;
  projectId?: string;
  type?: ActivityFeedEntry["type"];
}

/** Global concurrency state across all projects */
export interface GlobalConcurrencyState {
  globalMaxConcurrent: number;
  currentlyActive: number;
  queuedCount: number;
  projectsActive: Record<string, number>;
}

/** First run status response */
export interface FirstRunStatus {
  hasProjects: boolean;
  singleProjectPath: string | null;
}

/** Setup state for first-run wizard */
export interface SetupState {
  /** The first-run state: fresh-install, setup-wizard, normal-operation */
  state: "fresh-install" | "setup-wizard" | "normal-operation";
  /** Projects detected on the filesystem (not yet registered) */
  detectedProjects: Array<{
    path: string;
    name: string;
    hasDb: boolean;
  }>;
  /** Whether the central database exists */
  hasCentralDb: boolean;
  /** Projects already registered in the central database */
  registeredProjects: Array<{
    id: string;
    name: string;
    path: string;
  }>;
}

/** Input for completing setup */
export interface CompleteSetupInput {
  projects: Array<{
    path: string;
    name: string;
    isolationMode?: "in-process" | "child-process";
  }>;
}

/** Result of completing setup */
export interface CompleteSetupResult {
  success: boolean;
  projectsRegistered: string[];
  errors: string[];
}

/** Fetch all registered projects */
export function fetchProjects(): Promise<ProjectInfo[]> {
  return api<ProjectInfo[]>("/projects");
}

/** Dashboard-facing mapping contract for project availability on nodes. */
export interface ProjectNodeAvailability {
  nodeId: string;
  nodeName?: string;
  path: string;
  available: boolean;
}

/** Project info with source node metadata (added by server for remote projects). */
export interface ProjectInfoWithSource extends ProjectInfo {
  /** Name of the source node (added by server for remote projects). */
  _sourceNodeName?: string;
  /** Normalized per-node project mappings for dashboard UI. */
  nodeMappings?: ProjectNodeAvailability[];
  /** Compatibility fields accepted from in-flight server rollouts. */
  projectNodeMappings?: ProjectNodeAvailability[];
  pathMappings?: ProjectNodeAvailability[];
}

export function hasNodeMappingsSupport(project: ProjectInfoWithSource): boolean {
  return Array.isArray(project.nodeMappings)
    || Array.isArray(project.projectNodeMappings)
    || Array.isArray(project.pathMappings);
}

/** Fetch all registered projects from all nodes (local + remote) */
export function fetchProjectsAcrossNodes(): Promise<ProjectInfoWithSource[]> {
  return dedupe("/projects/across-nodes", () => api<ProjectInfoWithSource[]>("/projects/across-nodes"));
}

/** Fetch all registered nodes */
export function fetchNodes(): Promise<NodeInfo[]> {
  return dedupe("/nodes", () => api<NodeInfo[]>("/nodes"));
}

/** Fetch discovery runtime status and active config. */
export function fetchDiscoveryStatus(): Promise<{ active: boolean; config: DiscoveryConfig | null }> {
  return api<{ active: boolean; config: DiscoveryConfig | null }>("/discovery/status");
}

/** Fetch all managed Docker nodes */
export function listManagedDockerNodes(): Promise<DockerNodeInfo[]> {
  return api<DockerNodeInfo[]>("/docker-nodes");
}

export function fetchManagedDockerNodes(): Promise<ManagedDockerNodeInfo[]> {
  return api<ManagedDockerNodeInfo[]>("/docker/nodes");
}

export function fetchManagedDockerNode(id: string): Promise<ManagedDockerNodeInfo> {
  return api<ManagedDockerNodeInfo>(`/docker/nodes/${encodeURIComponent(id)}`);
}

export function fetchManagedDockerNodeContainerStatus(id: string): Promise<ContainerStatusInfo> {
  return api<ContainerStatusInfo>(`/docker/nodes/${encodeURIComponent(id)}/container-status`);
}

export function fetchDockerNodeLogs(id: string, options?: { tail?: number }): Promise<{ logs: string }> {
  const params = new URLSearchParams();
  if (typeof options?.tail === "number") {
    params.set("tail", String(options.tail));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return api<{ logs: string }>(`/docker/nodes/${encodeURIComponent(id)}/logs${suffix}`);
}

/** Create a managed Docker node */
export function createManagedDockerNode(input: ManagedDockerNodeInput): Promise<DockerNodeInfo> {
  return api<DockerNodeInfo>("/docker-nodes", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Start local-network discovery service. */
export function startDiscovery(input?: {
  broadcast?: boolean;
  listen?: boolean;
  port?: number;
}): Promise<{ success: boolean; config: DiscoveryConfig }> {
  return api<{ success: boolean; config: DiscoveryConfig }>("/discovery/start", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

/** Stop local-network discovery service. */
export function stopDiscovery(): Promise<{ success: boolean }> {
  return api<{ success: boolean }>("/discovery/stop", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/** Fetch currently discovered nodes from mDNS/DNS-SD. */
export function fetchDiscoveredNodes(): Promise<DiscoveredNodeInfo[]> {
  return api<DiscoveredNodeInfo[]>("/discovery/nodes");
}

/** Register a discovered node into the central node registry. */
export function connectDiscoveredNode(input: {
  name: string;
  host: string;
  port: number;
  apiKey?: string;
}): Promise<NodeInfo> {
  return api<NodeInfo>("/discovery/connect", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Register a new node */
export function registerNode(input: NodeCreateInput): Promise<NodeInfo> {
  return api<NodeInfo>("/nodes", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Discover projects from a remote node before registering it. */
export function discoverRemoteNodeProjects(input: { url: string; apiKey?: string }): Promise<RemoteNodeProjectDiscoveryResult> {
  return api<RemoteNodeProjectDiscoveryResult>("/nodes/discover-projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Fetch a single node by ID */
export function fetchNode(id: string): Promise<NodeInfo> {
  return api<NodeInfo>(`/nodes/${encodeURIComponent(id)}`);
}

/** Fetch all project path mappings for a node */
export function fetchNodePathMappings(nodeId: string): Promise<ProjectNodePathMapping[]> {
  return api<ProjectNodePathMapping[]>(`/nodes/${encodeURIComponent(nodeId)}/path-mappings`);
}

/** Update an existing node */
export function updateNode(id: string, updates: NodeUpdateInput): Promise<NodeInfo> {
  return api<NodeInfo>(`/nodes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Fetch sanitized docker config for a node */
export function fetchDockerNodeConfig(nodeId: string): Promise<DockerNodeConfigInfo | null> {
  return api<DockerNodeConfigInfo | null>(`/nodes/${encodeURIComponent(nodeId)}/docker-config`);
}

/** Replace full docker config for a node */
export function replaceDockerNodeConfig(nodeId: string, config: DockerNodeConfig): Promise<DockerNodeConfigInfo> {
  return api<DockerNodeConfigInfo>(`/nodes/${encodeURIComponent(nodeId)}/docker-config`, {
    method: "PUT",
    body: JSON.stringify(config),
  });
}

/** Patch docker config for a node */
export function updateDockerNodeConfig(nodeId: string, config: Partial<DockerNodeConfig>): Promise<DockerNodeConfigInfo> {
  return api<DockerNodeConfigInfo>(`/nodes/${encodeURIComponent(nodeId)}/docker-config`, {
    method: "PATCH",
    body: JSON.stringify(config),
  });
}

/** Fetch docker config diff status for a node */
export function fetchDockerConfigDiff(nodeId: string): Promise<{
  persistedVersion: number;
  deployedVersion: number | null;
  needsRecreate: boolean;
}> {
  return api<{ persistedVersion: number; deployedVersion: number | null; needsRecreate: boolean }>(
    `/nodes/${encodeURIComponent(nodeId)}/docker-config/diff`,
  );
}

/** Unregister a node */
export function unregisterNode(id: string): Promise<void> {
  return api<void>(`/nodes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Trigger a node health check */
export async function checkNodeHealth(id: string): Promise<NodeHealthCheckResult> {
  const result = await api<Partial<NodeHealthCheckResult> & { status: NodeStatus }>(`/nodes/${encodeURIComponent(id)}/health-check`, {
    method: "POST",
  });

  return {
    nodeId: result.nodeId ?? id,
    status: result.status,
    responseTimeMs: result.responseTimeMs,
    error: result.error,
    checkedAt: result.checkedAt ?? new Date().toISOString(),
  };
}

/** Fetch runtime metrics for a node */
export async function fetchNodeMetrics(id: string): Promise<SystemMetrics | null> {
  return api<SystemMetrics | null>(`/nodes/${encodeURIComponent(id)}/metrics`);
}

/** Fetch full mesh topology state (all nodes with their metrics and known peers) */
export async function fetchMeshState(): Promise<MeshClusterSnapshot> {
  return api<MeshClusterSnapshot>("/mesh/state");
}

/*
 * FNXC:MeshSharedPg 2026-06-25-00:00:
 * With the mesh on shared PostgreSQL, the dashboard needs to surface which
 * engines are actively connected to the shared DB, their in-flight tasks, and
 * heartbeat status. GET /api/mesh/engines joins the local engineManager with
 * the central node registry and per-project health. The shape matches the
 * MeshTopology `engines` prop (MeshEngineStatus) so the dashboard can render it
 * without transformation.
 */
export interface MeshEnginesResponse {
  collectedAt: string;
  backend: string;
  engines: MeshEngineStatusApi[];
}

/** Per-engine status entry returned by GET /api/mesh/engines. Mirrors MeshEngineStatus. */
export interface MeshEngineStatusApi {
  projectId: string;
  projectName?: string;
  projectPath?: string;
  workingDirectory?: string;
  runtimeStatus: string;
  inFlightTasks: number;
  activeAgents: number;
  lastActivityAt?: string;
  memoryBytes?: number;
  nodeId?: string;
}

/** Fetch active engine connections reading from shared PG (GET /api/mesh/engines). */
export async function fetchMeshEngines(): Promise<MeshEnginesResponse> {
  return api<MeshEnginesResponse>("/mesh/engines");
}

/** Browse directory entries for the directory picker */
export interface BrowseDirectoryResult {
  currentPath: string;
  parentPath: string | null;
  entries: Array<{ name: string; path: string; hasChildren: boolean }>;
}

export function browseDirectory(
  path?: string,
  showHidden?: boolean,
  nodeId?: string,
  localNodeId?: string,
): Promise<BrowseDirectoryResult> {
  const effectiveNodeId = nodeId && nodeId !== localNodeId ? nodeId : undefined;
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (showHidden) params.set("showHidden", "true");
  if (effectiveNodeId) params.set("nodeId", effectiveNodeId);
  const token = getAuthToken();
  if (token) {
    params.set("fn_token", token);
  }
  const qs = params.toString();
  const fullPath = `/browse-directory${qs ? `?${qs}` : ""}`;
  return api<BrowseDirectoryResult>(fullPath);
}

/** Create a new directory */
export function createDirectory(path: string): Promise<{ success: true; path: string }> {
  return api<{ success: true; path: string }>("/create-directory", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

/** Register a new project */
export function registerProject(input: ProjectCreateInput): Promise<ProjectInfo> {
  return api<ProjectInfo>("/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
/** Detect git sub-repos in a directory (workspace mode detection) */
export function detectWorkspace(path: string): Promise<{ repos: string[]; isWorkspace: boolean }> {
  return api<{ repos: string[]; isWorkspace: boolean }>("/projects/detect-workspace", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

/** Unregister a project */
export function unregisterProject(id: string): Promise<void> {
  return api<void>(`/projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Fetch all per-node path mappings for a project */
export function fetchProjectPathMappings(projectId: string): Promise<ProjectNodePathMapping[]> {
  return api<ProjectNodePathMapping[]>(`/projects/${encodeURIComponent(projectId)}/path-mappings`);
}

/** Fetch a single project-node path mapping */
export function fetchProjectPathMapping(projectId: string, nodeId: string): Promise<ProjectNodePathMapping> {
  return api<ProjectNodePathMapping>(
    `/projects/${encodeURIComponent(projectId)}/path-mappings/${encodeURIComponent(nodeId)}`,
  );
}

/** Create or update a project-node path mapping */
export function upsertProjectPathMapping(
  projectId: string,
  nodeId: string,
  path: string,
): Promise<ProjectNodePathMapping> {
  return api<ProjectNodePathMapping>(
    `/projects/${encodeURIComponent(projectId)}/path-mappings/${encodeURIComponent(nodeId)}`,
    {
      method: "PUT",
      body: JSON.stringify({ path }),
    },
  );
}

/** Remove a project-node path mapping */
export function removeProjectPathMapping(projectId: string, nodeId: string): Promise<void> {
  return api<void>(
    `/projects/${encodeURIComponent(projectId)}/path-mappings/${encodeURIComponent(nodeId)}`,
    {
      method: "DELETE",
    },
  );
}

/** Fetch health metrics for a specific project */
export function fetchProjectHealth(id: string): Promise<ProjectHealth> {
  return api<ProjectHealth>(`/projects/${encodeURIComponent(id)}/health`);
}

export function fetchCodebaseMetrics(id: string): Promise<CodebaseMetrics> {
  return api<CodebaseMetrics>(`/projects/${encodeURIComponent(id)}/codebase-metrics`);
}

/** Fetch executor statistics for the status bar.
 * 
 * Returns settings-based values and lastActivityAt.
 * Counts are derived client-side from the tasks array.
 */
export function fetchExecutorStats(projectId?: string): Promise<{
  globalPause: boolean;
  enginePaused: boolean;
  maxConcurrent: number;
  lastActivityAt?: string;
}> {
  const path = withProjectId("/executor/stats", projectId);
  return dedupe(path, () => api<{
    globalPause: boolean;
    enginePaused: boolean;
    maxConcurrent: number;
    lastActivityAt?: string;
  }>(path));
}

export interface SystemStatsSnapshot {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  heapLimit: number;
  external: number;
  arrayBuffers: number;
  // Null until at least two samples are available to compute process CPU delta.
  cpuPercent: number | null;
  loadAvg: [number, number, number];
  cpuCount: number;
  systemTotalMem: number;
  systemFreeMem: number;
  pid: number;
  nodeVersion: string;
  platform: string;
}

export interface TaskStatsSnapshot {
  total: number;
  byColumn: Record<string, number>;
  active: number;
  agents: {
    idle: number;
    active: number;
    running: number;
    error: number;
  };
}

export interface SystemStatsResponse {
  systemStats: SystemStatsSnapshot;
  taskStats: TaskStatsSnapshot;
  vitestProcessCount?: number;
  vitestLastAutoKillAt?: string | null;
}

export interface KillVitestResponse {
  killed: number;
  pids: number[];
}

export interface GithubSourceIssueClosedAtBackfillResult {
  scanned: number;
  filled: number;
  skipped: number;
  errors: number;
  hasMore: boolean;
}

/*
FNXC:CommandCenter 2026-06-21-00:00:
The Command Center System area keeps the direct local /system-stats client and uses the explicit /nodes/:id/system-stats route for selected remote nodes so authenticated node proxying stays server-side and local project scoping is not forwarded across nodes.
*/
export function fetchSystemStats(projectId?: string): Promise<SystemStatsResponse> {
  return api<SystemStatsResponse>(withProjectId("/system-stats", projectId));
}

export function fetchNodeSystemStats(nodeId: string, projectId?: string): Promise<SystemStatsResponse> {
  return api<SystemStatsResponse>(withProjectId(`/nodes/${encodeURIComponent(nodeId)}/system-stats`, projectId));
}

export function killVitestProcesses(projectId?: string, nodeId?: string, localNodeId?: string): Promise<KillVitestResponse> {
  return proxyApi<KillVitestResponse>(withProjectId("/kill-vitest", projectId), {
    method: "POST",
    nodeId,
    localNodeId,
  });
}

/**
 * FNXC:GithubSourceIssueBackfill 2026-06-18-19:20:
 * Thin client for the FN-6674 manual source-issue closed-at backfill endpoint. Callers own bounded pagination until `hasMore === false`; this helper keeps the GitHub lookup in the explicit operator action path and out of analytics/render-time data loading.
 */
export function apiBackfillGithubSourceIssueClosedAt(
  options: { offset?: number; limit?: number } = {},
  projectId?: string,
): Promise<GithubSourceIssueClosedAtBackfillResult> {
  return api<GithubSourceIssueClosedAtBackfillResult>(
    withProjectId("/git/github/backfill-source-issue-closed-at", projectId),
    {
      method: "POST",
      body: JSON.stringify({ offset: options.offset, limit: options.limit }),
    },
  );
}

/** Fetch unified activity feed */
export function fetchActivityFeed(options?: FeedOptions): Promise<ActivityFeedEntry[]> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.since) params.set("since", options.since);
  if (options?.projectId) params.set("projectId", options.projectId);
  if (options?.type) params.set("type", options.type);
  
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<ActivityFeedEntry[]>(`/activity-feed${query}`);
}

/** Pause a project */
export function pauseProject(id: string): Promise<ProjectInfo> {
  return api<ProjectInfo>(`/projects/${encodeURIComponent(id)}/pause`, {
    method: "POST",
  });
}

/** Resume a paused project */
export function resumeProject(id: string): Promise<ProjectInfo> {
  return api<ProjectInfo>(`/projects/${encodeURIComponent(id)}/resume`, {
    method: "POST",
  });
}

/** Fetch first run status to detect if user needs setup wizard */
export function fetchFirstRunStatus(): Promise<FirstRunStatus> {
  return api<FirstRunStatus>("/first-run-status");
}

/** Fetch detailed setup state including detected projects */
export function fetchSetupState(): Promise<SetupState> {
  return api<SetupState>("/setup-state");
}

/** Complete first-run setup by registering projects */
export function completeSetup(input: CompleteSetupInput): Promise<CompleteSetupResult> {
  return api<CompleteSetupResult>("/complete-setup", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Fetch global concurrency state */
export function fetchGlobalConcurrency(): Promise<GlobalConcurrencyState> {
  return api<GlobalConcurrencyState>("/global-concurrency");
}

/** Update the system-wide concurrency limit shared across all projects. */
export function updateGlobalConcurrency(input: {
  globalMaxConcurrent: number;
}): Promise<GlobalConcurrencyState> {
  return api<GlobalConcurrencyState>("/global-concurrency", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/** Fetch tasks for a specific project */
export function fetchProjectTasks(projectId: string, limit?: number, offset?: number): Promise<Task[]> {
  const params = new URLSearchParams();
  params.set("projectId", projectId);
  if (limit !== undefined) params.set("limit", String(limit));
  if (offset !== undefined) params.set("offset", String(offset));
  return api<Task[]>(`/tasks?${params.toString()}`);
}

/** Fetch project-specific config */
export function fetchProjectConfig(projectId: string): Promise<{ maxConcurrent: number; rootDir: string }> {
  return api<{ maxConcurrent: number; rootDir: string }>(`/projects/${encodeURIComponent(projectId)}/config`);
}

/** Detected project information */
export interface DetectedProject {
  path: string;
  suggestedName: string;
  existing: boolean;
}

/** Detect projects in a base path */
export function detectProjects(basePath?: string): Promise<{ projects: DetectedProject[] }> {
  return api<{ projects: DetectedProject[] }>("/projects/detect", {
    method: "POST",
    body: JSON.stringify({ basePath }),
  });
}

/** Fetch a single project by ID */
export function fetchProject(id: string): Promise<ProjectInfo> {
  return api<ProjectInfo>(`/projects/${encodeURIComponent(id)}`);
}

/** Update an existing project */
export function updateProject(id: string, updates: Partial<ProjectInfo>): Promise<ProjectInfo> {
  return api<ProjectInfo>(`/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

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

// ── Mission API ───────────────────────────────────────────────────────────

/** Mission status values */
export type MissionStatus = "planning" | "active" | "blocked" | "complete" | "archived";

/** Milestone status values */
export type MilestoneStatus = "planning" | "active" | "blocked" | "complete";

/** Slice status values */
export type SliceStatus = "pending" | "active" | "complete";

/** Feature status values */
export type FeatureStatus = "defined" | "triaged" | "in-progress" | "done" | "blocked";

/** Autopilot state values for mission autonomous progression */
export type AutopilotState = "inactive" | "watching" | "activating" | "completing";

/** Autopilot status for a mission */
export interface AutopilotStatus {
  enabled: boolean;
  state: AutopilotState;
  watched: boolean;
  lastActivityAt?: string;
  nextScheduledCheck?: string;
}

/** Mission entity */
export interface Mission {
  id: string;
  title: string;
  description?: string;
  baseBranch?: string;
  branchStrategy?: {
    mode: "project-default" | "existing" | "custom-new" | "auto-per-task";
    branchName?: string;
  };
  status: MissionStatus;
  interviewState: "not_started" | "in_progress" | "completed" | "needs_update";
  autoAdvance?: boolean;
  /** When true, enable autopilot monitoring system for this mission */
  autopilotEnabled?: boolean;
  /** Current autopilot runtime state */
  autopilotState?: AutopilotState;
  /** ISO-8601 timestamp of last autopilot activity */
  lastAutopilotActivityAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Status summary for a mission card, computed from hierarchy */
export interface MissionSummary {
  totalMilestones: number;
  completedMilestones: number;
  totalFeatures: number;
  completedFeatures: number;
  linkedGoalCount: number;
  eventCount: number;
  progressPercent: number;
}

/** Mission with optional status summary (returned by list endpoint) */
export type MissionWithSummary = Mission & { summary?: MissionSummary };

/** Milestone entity */
export interface Milestone {
  id: string;
  missionId: string;
  title: string;
  description?: string;
  status: MilestoneStatus;
  orderIndex: number;
  interviewState: "not_started" | "in_progress" | "completed" | "needs_update";
  dependencies: string[];
  acceptanceCriteria?: string;
  createdAt: string;
  updatedAt: string;
}

/** Slice entity */
export interface Slice {
  id: string;
  milestoneId: string;
  title: string;
  description?: string;
  status: SliceStatus;
  orderIndex: number;
  activatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Feature entity */
export interface MissionFeature {
  id: string;
  sliceId: string;
  taskId?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  status: FeatureStatus;
  createdAt: string;
  updatedAt: string;
}

/** Milestone with slices (each slice has features) */
export interface MilestoneWithSlices extends Milestone {
  slices: SliceWithFeatures[];
}

/** Slice with features */
export interface SliceWithFeatures extends Slice {
  features: MissionFeature[];
}

/** Full mission hierarchy */
export interface MissionWithHierarchy extends Mission {
  /** Unfiltered total of all mission lifecycle events, matching MissionSummary.eventCount and getMissionEvents total with no eventType filter */
  eventCount?: number;
  milestones: MilestoneWithSlices[];
}

/** Fetch all missions with status summary */
export function fetchMissions(projectId?: string): Promise<MissionWithSummary[]> {
  return api<MissionWithSummary[]>(withProjectId("/missions", projectId));
}

/** Create a new mission */
export function createMission(input: { title: string; description?: string; autoAdvance?: boolean; autopilotEnabled?: boolean; baseBranch?: string; branchStrategy?: Mission["branchStrategy"] }, projectId?: string): Promise<Mission> {
  return api<Mission>(withProjectId("/missions", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Get mission with full hierarchy */
export function fetchMission(missionId: string, projectId?: string): Promise<MissionWithHierarchy> {
  return api<MissionWithHierarchy>(withProjectId(`/missions/${encodeURIComponent(missionId)}`, projectId));
}

/** Update mission */
export function updateMission(missionId: string, updates: Partial<Mission>, projectId?: string): Promise<Mission> {
  return api<Mission>(withProjectId(`/missions/${encodeURIComponent(missionId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete mission */
export function deleteMission(missionId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/${encodeURIComponent(missionId)}`, projectId), {
    method: "DELETE",
  });
}

/** Get mission computed status */
export function fetchMissionStatus(missionId: string, projectId?: string): Promise<{ status: string }> {
  return api<{ status: string }>(withProjectId(`/missions/${encodeURIComponent(missionId)}/status`, projectId));
}

export interface MissionAssertionBackfillRepairRow {
  featureId: string;
  milestoneId: string;
  assertionId: string;
  textSource: "acceptanceCriteria" | "description" | "title" | "fallback";
}

export interface MissionAssertionBackfillErrorRow {
  featureId: string;
  message: string;
}

export interface MissionAssertionBackfillReport {
  scanned: number;
  alreadyLinked: number;
  repaired: MissionAssertionBackfillRepairRow[];
  skippedErrors: MissionAssertionBackfillErrorRow[];
}

/** Backfill store-managed mission assertions for unlinked features. Defaults to dry-run. */
export function backfillMissionAssertions(
  missionId: string,
  options?: { dryRun?: boolean },
  projectId?: string,
): Promise<MissionAssertionBackfillReport> {
  return api<MissionAssertionBackfillReport>(
    withProjectId(`/missions/${encodeURIComponent(missionId)}/backfill-assertions`, projectId),
    {
      method: "POST",
      body: JSON.stringify({ dryRun: options?.dryRun ?? true }),
    },
  );
}

/** Backfill historical Command Center LOC stats for commit associations. Defaults to dry-run. */
export function backfillCommitAssociationDiffStats(
  options?: { dryRun?: boolean },
  projectId?: string,
): Promise<CommitAssociationDiffBackfillReport> {
  return api<CommitAssociationDiffBackfillReport>(
    withProjectId("/command-center/productivity/backfill-loc", projectId),
    {
      method: "POST",
      body: JSON.stringify({ dryRun: options?.dryRun ?? true }),
    },
  );
}

/** Query options for paginated mission event logs. */
export interface MissionEventQueryOptions {
  limit?: number;
  offset?: number;
  eventType?: MissionEventType;
}

/** Paginated mission event log response. */
export interface MissionEventsResponse {
  events: MissionEvent[];
  total: number;
  limit: number;
  offset: number;
}

/** Fetch paginated mission observability events. */
export function fetchMissionEvents(
  missionId: string,
  options?: MissionEventQueryOptions,
  projectId?: string,
): Promise<MissionEventsResponse> {
  const query = new URLSearchParams();
  if (options?.limit !== undefined) query.set("limit", String(options.limit));
  if (options?.offset !== undefined) query.set("offset", String(options.offset));
  if (options?.eventType !== undefined) query.set("eventType", options.eventType);

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return api<MissionEventsResponse>(
    withProjectId(`/missions/${encodeURIComponent(missionId)}/events${suffix}`, projectId),
  );
}

/** Fetch computed mission health metrics. */
export function fetchMissionHealth(missionId: string, projectId?: string): Promise<MissionHealth> {
  return api<MissionHealth>(withProjectId(`/missions/${encodeURIComponent(missionId)}/health`, projectId));
}

/** Fetch health metrics for all missions in a single batched request. */
export function fetchMissionsHealth(projectId?: string): Promise<Record<string, MissionHealth>> {
  return api<Record<string, MissionHealth>>(withProjectId("/missions/health", projectId));
}

/** Add milestone to mission */
export function createMilestone(
  missionId: string,
  input: { title: string; description?: string; acceptanceCriteria?: string; dependencies?: string[] },
  projectId?: string
): Promise<Milestone> {
  return api<Milestone>(withProjectId(`/missions/${encodeURIComponent(missionId)}/milestones`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update milestone */
export function updateMilestone(milestoneId: string, updates: Partial<Milestone>, projectId?: string): Promise<Milestone> {
  return api<Milestone>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete milestone */
export function deleteMilestone(milestoneId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}`, projectId), {
    method: "DELETE",
  });
}

/** Reorder milestones */
export function reorderMilestones(missionId: string, orderedIds: string[], projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/${encodeURIComponent(missionId)}/milestones/reorder`, projectId), {
    method: "POST",
    body: JSON.stringify({ orderedIds }),
  });
}

/** Add slice to milestone */
export function createSlice(
  milestoneId: string,
  input: { title: string; description?: string },
  projectId?: string
): Promise<Slice> {
  return api<Slice>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/slices`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update slice */
export function updateSlice(sliceId: string, updates: Partial<Slice>, projectId?: string): Promise<Slice> {
  return api<Slice>(withProjectId(`/missions/slices/${encodeURIComponent(sliceId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete slice */
export function deleteSlice(sliceId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/slices/${encodeURIComponent(sliceId)}`, projectId), {
    method: "DELETE",
  });
}

/** Activate slice */
export function activateSlice(sliceId: string, projectId?: string): Promise<Slice> {
  return api<Slice>(withProjectId(`/missions/slices/${encodeURIComponent(sliceId)}/activate`, projectId), {
    method: "POST",
  });
}

/** Reorder slices */
export function reorderSlices(milestoneId: string, orderedIds: string[], projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/slices/reorder`, projectId), {
    method: "POST",
    body: JSON.stringify({ orderedIds }),
  });
}

/** Add feature to slice */
export function createFeature(
  sliceId: string,
  input: { title: string; description?: string; acceptanceCriteria?: string },
  projectId?: string
): Promise<MissionFeature> {
  return api<MissionFeature>(withProjectId(`/missions/slices/${encodeURIComponent(sliceId)}/features`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update feature */
export function updateFeature(featureId: string, updates: Partial<MissionFeature>, projectId?: string): Promise<MissionFeature> {
  return api<MissionFeature>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete feature */
export function deleteFeature(featureId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}`, projectId), {
    method: "DELETE",
  });
}

/** Link feature to task */
export function linkFeatureToTask(featureId: string, taskId: string, projectId?: string): Promise<MissionFeature> {
  return api<MissionFeature>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/link-task`, projectId), {
    method: "POST",
    body: JSON.stringify({ taskId }),
  });
}

/** Unlink feature from task */
export function unlinkFeatureFromTask(featureId: string, projectId?: string): Promise<MissionFeature> {
  return api<MissionFeature>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/unlink-task`, projectId), {
    method: "POST",
  });
}

/** Triage a feature — create a task from the feature and link it */
export function triageFeature(
  featureId: string,
  taskTitle?: string,
  taskDescription?: string,
  projectId?: string,
  options?: {
    branchSelection?: {
      mode: "project-default" | "auto-new" | "existing" | "custom-new";
      branchName?: string;
      baseBranch?: string;
    };
    branchAssignment?: { mode: "shared" | "per-task-derived" };
    workflowId?: string | null;
  },
): Promise<MissionFeature> {
  return api<MissionFeature>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/triage`, projectId), {
    method: "POST",
    body: JSON.stringify({ taskTitle, taskDescription, ...options }),
  });
}

/** Triage all "defined" features in a slice */
export function triageAllSliceFeatures(
  sliceId: string,
  projectId?: string,
  options?: {
    branchSelection?: {
      mode: "project-default" | "auto-new" | "existing" | "custom-new";
      branchName?: string;
      baseBranch?: string;
    };
    branchAssignment?: { mode: "shared" | "per-task-derived" };
    workflowId?: string | null;
  },
): Promise<{ triaged: MissionFeature[]; count: number }> {
  return api<{ triaged: MissionFeature[]; count: number }>(withProjectId(`/missions/slices/${encodeURIComponent(sliceId)}/triage-all`, projectId), {
    method: "POST",
    body: JSON.stringify(options ?? {}),
  });
}

// ── Contract Assertion API ─────────────────────────────────────────────────────

/** Contract assertion status */
export type MissionAssertionStatus = "pending" | "passed" | "failed" | "blocked";

/** A contract assertion represents an explicit behavioral test or requirement associated with a milestone */
export interface MissionContractAssertion {
  id: string;
  milestoneId: string;
  title: string;
  assertion: string;
  status: MissionAssertionStatus;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
}

/** Input for creating a contract assertion */
export interface ContractAssertionCreateInput {
  title: string;
  assertion: string;
  status?: MissionAssertionStatus;
}

/** Input for updating a contract assertion */
export interface ContractAssertionUpdateInput {
  title?: string;
  assertion?: string;
  status?: MissionAssertionStatus;
}

/** List assertions for a milestone, ordered by orderIndex */
export function fetchAssertions(milestoneId: string, projectId?: string): Promise<MissionContractAssertion[]> {
  return api<MissionContractAssertion[]>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/assertions`, projectId));
}

/** Create a new assertion for a milestone */
export function createAssertion(milestoneId: string, input: ContractAssertionCreateInput, projectId?: string): Promise<MissionContractAssertion> {
  return api<MissionContractAssertion>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/assertions`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Reorder assertions within a milestone */
export function reorderAssertions(milestoneId: string, orderedIds: string[], projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/assertions/reorder`, projectId), {
    method: "POST",
    body: JSON.stringify({ orderedIds }),
  });
}

/** Get a single assertion by ID */
export function fetchAssertion(assertionId: string, projectId?: string): Promise<MissionContractAssertion> {
  return api<MissionContractAssertion>(withProjectId(`/missions/assertions/${encodeURIComponent(assertionId)}`, projectId));
}

/** Update an assertion */
export function updateAssertion(assertionId: string, updates: ContractAssertionUpdateInput, projectId?: string): Promise<MissionContractAssertion> {
  return api<MissionContractAssertion>(withProjectId(`/missions/assertions/${encodeURIComponent(assertionId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete an assertion */
export function deleteAssertion(assertionId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/assertions/${encodeURIComponent(assertionId)}`, projectId), {
    method: "DELETE",
  });
}

/** Link a feature to an assertion */
export function linkFeatureToAssertion(featureId: string, assertionId: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/assertions/${encodeURIComponent(assertionId)}/link`, projectId), {
    method: "POST",
  });
}

/** Unlink a feature from an assertion */
export function unlinkFeatureFromAssertion(featureId: string, assertionId: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/assertions/${encodeURIComponent(assertionId)}/unlink`, projectId), {
    method: "POST",
  });
}

/** List assertions linked to a feature */
export function fetchAssertionsForFeature(featureId: string, projectId?: string): Promise<MissionContractAssertion[]> {
  return api<MissionContractAssertion[]>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/assertions`, projectId));
}

/** List features linked to an assertion */
export function fetchFeaturesForAssertion(assertionId: string, projectId?: string): Promise<MissionFeature[]> {
  return api<MissionFeature[]>(withProjectId(`/missions/assertions/${encodeURIComponent(assertionId)}/features`, projectId));
}

/** Validation rollup for a milestone */
export interface MilestoneValidationRollup {
  milestoneId: string;
  totalAssertions: number;
  passedAssertions: number;
  failedAssertions: number;
  blockedAssertions: number;
  pendingAssertions: number;
  unlinkedAssertions: number;
  hasProseButNoAssertions: boolean;
  state: "not_started" | "needs_coverage" | "ready" | "passed" | "failed" | "blocked";
}

/** Get milestone validation rollup */
export function fetchMilestoneValidation(milestoneId: string, projectId?: string): Promise<MilestoneValidationRollup> {
  return api<MilestoneValidationRollup>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/validation`, projectId));
}

/** Fetch grouped validation telemetry for a milestone */
export function fetchMilestoneValidationTelemetry(milestoneId: string, projectId?: string): Promise<MilestoneValidationTelemetry> {
  return api<MilestoneValidationTelemetry>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/validation-telemetry`, projectId));
}

// ── Validation Loop API ───────────────────────────────────────────────────────

/** Loop state snapshot for a feature */
export interface MissionFeatureLoopSnapshot {
  featureId: string;
  feature: MissionFeature;
  loopState: "idle" | "implementing" | "validating" | "needs_fix" | "passed" | "blocked";
  implementationAttemptCount: number;
  validatorAttemptCount: number;
  lastValidatorRunId?: string;
  lastValidatorStatus?: "running" | "passed" | "failed" | "blocked" | "error";
  generatedFromFeatureId?: string;
  generatedFromRunId?: string;
  retryBudgetRemaining: number;
}

/** Validator run */
export interface MissionValidatorRun {
  id: string;
  featureId: string;
  milestoneId: string;
  sliceId: string;
  status: "running" | "passed" | "failed" | "blocked" | "error";
  triggerType: string;
  implementationAttempt: number;
  validatorAttempt: number;
  summary?: string;
  blockedReason?: string;
  startedAt: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Trigger validation for a feature */
export function triggerValidation(featureId: string, projectId?: string): Promise<{ runId: string; featureId: string; status: string; triggerType: string; implementationAttempt: number; validatorAttempt: number; startedAt: string }> {
  return api(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/validate`, projectId), {
    method: "POST",
  });
}

/** Get validation loop state for a feature */
export function fetchValidationLoopState(featureId: string, projectId?: string): Promise<MissionFeatureLoopSnapshot> {
  return api<MissionFeatureLoopSnapshot>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/validation-loop`, projectId));
}

/** Paginated response wrapper for validation runs */
export interface ValidationRunsResponse {
  runs: MissionValidatorRun[];
  total: number;
  limit: number;
  offset: number;
}

/** List validation runs for a feature */
export function fetchValidationRuns(featureId: string, options?: { limit?: number; offset?: number }, projectId?: string): Promise<MissionValidatorRun[]> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return api<ValidationRunsResponse>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/validation-runs${suffix}`, projectId))
    .then((response) => response.runs);
}

/** Get a single validator run */
export function fetchValidationRun(runId: string, projectId?: string): Promise<MissionValidatorRun & { failures?: Array<{ id: string; assertionId: string; message?: string; expected?: string; actual?: string }> }> {
  return api(withProjectId(`/missions/validation-runs/${encodeURIComponent(runId)}`, projectId));
}

/** Pause a mission (sets status to "blocked", in-flight tasks continue) */
export function pauseMission(missionId: string, projectId?: string): Promise<Mission> {
  return api<Mission>(withProjectId(`/missions/${encodeURIComponent(missionId)}/pause`, projectId), {
    method: "POST",
  });
}

/** Resume a paused mission (sets status back to "active") */
export function resumeMission(missionId: string, projectId?: string): Promise<Mission> {
  return api<Mission>(withProjectId(`/missions/${encodeURIComponent(missionId)}/resume`, projectId), {
    method: "POST",
  });
}

/** Stop a mission (sets status to "blocked" and pauses all linked tasks) */
export function stopMission(missionId: string, projectId?: string): Promise<Mission & { pausedTaskIds: string[] }> {
  return api<Mission & { pausedTaskIds: string[] }>(withProjectId(`/missions/${encodeURIComponent(missionId)}/stop`, projectId), {
    method: "POST",
  });
}

/** Start a planning mission: sets status to "active" and activates the first pending slice */
export function startMission(missionId: string, projectId?: string): Promise<MissionWithHierarchy> {
  return api<MissionWithHierarchy>(withProjectId(`/missions/${encodeURIComponent(missionId)}/start`, projectId), {
    method: "POST",
  });
}

// ── Mission Autopilot API ────────────────────────────────────────────────

/** Fetch autopilot status for a mission */
export function fetchMissionAutopilotStatus(missionId: string, projectId?: string): Promise<AutopilotStatus> {
  return api<AutopilotStatus>(withProjectId(`/missions/${encodeURIComponent(missionId)}/autopilot`, projectId));
}

/** Update autopilot settings for a mission (enable/disable) */
export function updateMissionAutopilot(missionId: string, updates: { enabled?: boolean }, projectId?: string): Promise<AutopilotStatus> {
  return api<AutopilotStatus>(withProjectId(`/missions/${encodeURIComponent(missionId)}/autopilot`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Manually start autopilot watching for a mission */
export function startMissionAutopilot(missionId: string, projectId?: string): Promise<AutopilotStatus> {
  return api<AutopilotStatus>(withProjectId(`/missions/${encodeURIComponent(missionId)}/autopilot/start`, projectId), {
    method: "POST",
  });
}

/** Manually stop autopilot watching for a mission */
export function stopMissionAutopilot(missionId: string, projectId?: string): Promise<AutopilotStatus> {
  return api<AutopilotStatus>(withProjectId(`/missions/${encodeURIComponent(missionId)}/autopilot/stop`, projectId), {
    method: "POST",
  });
}

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

// ── Todo API ─────────────────────────────────────────────────────────────────

/** Fetch all todo lists with their items */
export function fetchTodoLists(projectId?: string): Promise<TodoListWithItems[]> {
  return api<TodoListWithItems[]>(withProjectId("/todos", projectId));
}

/** Create a new todo list */
export function createTodoList(title: string, projectId?: string): Promise<TodoList> {
  const input: TodoListCreateInput = { title };
  return api<TodoList>(withProjectId("/todos", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update a todo list title */
export function updateTodoList(id: string, title: string, projectId?: string): Promise<TodoList> {
  const updates: TodoListUpdateInput = { title };
  return api<TodoList>(withProjectId(`/todos/${encodeURIComponent(id)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete a todo list and all its items */
export function deleteTodoList(id: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/todos/${encodeURIComponent(id)}`, projectId), {
    method: "DELETE",
  });
}

/** Create a new item in a todo list */
export function createTodoItem(listId: string, text: string, projectId?: string): Promise<TodoItem> {
  const input: TodoItemCreateInput = { text };
  return api<TodoItem>(withProjectId(`/todos/${encodeURIComponent(listId)}/items`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update a todo item (text and/or completed) */
export function updateTodoItem(
  id: string,
  data: { text?: string; completed?: boolean },
  projectId?: string
): Promise<TodoItem> {
  const updates: TodoItemUpdateInput = data;
  return api<TodoItem>(withProjectId(`/todos/items/${encodeURIComponent(id)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete a todo item */
export function deleteTodoItem(id: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/todos/items/${encodeURIComponent(id)}`, projectId), {
    method: "DELETE",
  });
}

/** Reorder items within a todo list */
export function reorderTodoItems(listId: string, itemIds: string[], projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/todos/${encodeURIComponent(listId)}/items/reorder`, projectId), {
    method: "POST",
    body: JSON.stringify({ itemIds }),
  });
}

// ── AI Sessions ────────────────────────────────────────────────────────────

/**
 * Needs-attention variants for a CLI agent session (CLI Agent Executor, U11).
 * Each carries pinned banner copy + action verbs:
 *  - userExited        → Advance / Retry / Cancel task
 *  - authFailed        → Re-authenticate / Retry
 *  - resume-exhausted  → Relaunch fresh / Cancel task
 */
export type CliNeedsAttentionVariant = "userExited" | "authFailed" | "resume-exhausted";

export interface AiSessionSummary {
  id: string;
  type:
    | "planning"
    | "subtask"
    | "mission_interview"
    | "milestone_interview"
    | "slice_interview"
    | "cli-agent";
  status:
    | "draft"
    | "generating"
    | "awaiting_input"
    | "complete"
    | "error"
    | "waiting_on_input"
    | "needs_attention";
  /** For cli-agent sessions: which needs-attention variant (drives pinned copy/actions). */
  cliVariant?: CliNeedsAttentionVariant;
  /** Underlying CLI session id, for action wiring (confirm-advance / re-auth / etc.). */
  cliSessionId?: string;
  title: string;
  /** Server-derived preview of the in-progress initialPlan; only set for draft planning sessions. */
  preview?: string;
  projectId: string | null;
  updatedAt: string;
  archived?: boolean;
}

export interface ConversationHistoryEntry {
  question?: PlanningQuestion;
  response?: Record<string, unknown>;
  thinkingOutput?: string;
}

export interface AiSessionDetail extends AiSessionSummary {
  inputPayload: string;
  conversationHistory: string;
  currentQuestion: string | null;
  result: string | null;
  thinkingOutput: string;
  error: string | null;
  createdAt: string;
}

export function parseConversationHistory(raw: string): ConversationHistoryEntry[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function fetchAiSessions(
  projectId?: string,
  options?: { includeCompleted?: boolean; includeArchived?: boolean; type?: AiSessionSummary["type"] },
): Promise<AiSessionSummary[]> {
  const search = new URLSearchParams();
  if (projectId) search.set("projectId", projectId);
  if (options?.includeCompleted) search.set("includeCompleted", "1");
  if (options?.includeArchived) search.set("includeArchived", "1");
  if (options?.type) search.set("type", options.type);
  const qs = search.toString();
  const res = await fetch(buildApiUrl(`/ai-sessions${qs ? `?${qs}` : ""}`), {
    headers: withTokenHeader(),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.sessions ?? [];
}

export async function archiveAiSession(id: string): Promise<void> {
  return api<void>(`/ai-sessions/${encodeURIComponent(id)}/archive`, {
    method: "POST",
  });
}

export async function unarchiveAiSession(id: string): Promise<void> {
  return api<void>(`/ai-sessions/${encodeURIComponent(id)}/unarchive`, {
    method: "POST",
  });
}

export async function fetchAiSession(id: string): Promise<AiSessionDetail | null> {
  const res = await fetch(buildApiUrl(`/ai-sessions/${encodeURIComponent(id)}`), {
    headers: withTokenHeader(),
  });
  if (!res.ok) return null;
  return res.json();
}

/*
FNXC:PlanningMultiTab 2026-07-14-00:00:
acquireSessionLock / releaseSessionLock / forceAcquireSessionLock were removed with the rest of
the per-tab session lock; their routes no longer exist. AI interview sessions are multi-tab —
the persisted session row is the shared source of truth and any tab may read and interact.
*/

export async function deleteAiSession(id: string): Promise<void> {
  const url = buildApiUrl(`/ai-sessions/${encodeURIComponent(id)}`);
  const res = await fetch(url, {
    method: "DELETE",
    headers: withTokenHeader(),
  });

  if (res.ok || res.status === 404) {
    return;
  }

  const contentType = res.headers.get("content-type") ?? "";
  const bodyText = await res.text();
  const isJson = contentType.includes("application/json");
  const isHtml = contentType.includes("text/html") || looksLikeHtml(bodyText);

  if (isHtml) {
    throw new Error(
      `API returned HTML instead of JSON for ${url}. ` +
      `The endpoint may not be properly configured. (${res.status} ${res.statusText})`
    );
  }

  if (!isJson) {
    const preview = bodyText.length > 160 ? `${bodyText.slice(0, 160)}...` : bodyText;
    throw new Error(
      `API returned ${contentType || "an unknown content type"} instead of JSON for ${url}. ` +
      `(${res.status} ${res.statusText})${preview ? ` Response: ${preview}` : ""}`
    );
  }

  let data: unknown;
  try {
    data = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    throw new Error(`API returned invalid JSON for ${url}. (${res.status} ${res.statusText})`);
  }

  const payload = data as { error?: string; details?: Record<string, unknown> } | null;
  throw new ApiRequestError(
    payload?.error || `Request failed for ${url}: ${res.status} ${res.statusText}`,
    res.status,
    payload?.details,
  );
}

export function pingSession(sessionId: string, projectId?: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(withProjectId(`/ai-sessions/${encodeURIComponent(sessionId)}/ping`, projectId), {
    method: "POST",
  });
}

export function updatePlanningSessionDraft(
  sessionId: string,
  draft: { initialPlan: string; modelProvider?: string; modelId?: string; thinkingLevel?: ThinkingLevel },
  projectId?: string,
): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(withProjectId(`/ai-sessions/${encodeURIComponent(sessionId)}/draft`, projectId), {
    method: "PATCH",
    body: JSON.stringify(draft),
  });
}

/**
 * Ask the server to (re)generate the sidebar title for a draft planning
 * session from its persisted initialPlan. Server-side is idempotent and
 * a no-op once the session has been started, so callers can fire-and-
 * forget on textarea blur and modal close.
 */
export function summarizePlanningDraftTitle(
  sessionId: string,
  projectId?: string,
): Promise<{ title: string | null }> {
  return api<{ title: string | null }>(
    withProjectId(`/planning/${encodeURIComponent(sessionId)}/summarize-draft-title`, projectId),
    { method: "POST" },
  );
}

// ── Messages API ──────────────────────────────────────────────────────────

/** Response shape for GET /messages/inbox */
export interface InboxResponse {
  messages: Message[];
  total: number;
  unreadCount: number;
}

/** Response shape for GET /messages/outbox */
export interface OutboxResponse {
  messages: Message[];
  total: number;
}

/** Response shape for GET /messages/unread-count */
export interface UnreadCountResponse {
  unreadCount: number;
  pendingApprovalCount?: number;
}

/** Response shape for POST /messages/read-all */
export interface MarkAllReadResponse {
  markedAsRead: number;
}

/** Response shape for GET /agents/:id/mailbox */
export interface AgentMailboxResponse {
  ownerId: string;
  ownerType: ParticipantType;
  unreadCount: number;
  lastMessage?: Message;
  messages: Message[];      // Backward compat alias for inbox
  inbox: Message[];
  outbox: Message[];
}

/** Response shape for GET /agents/mailbox/all */
export interface AllAgentsMailboxResponse {
  messages: Message[];
  total: number;
  unreadCount: number;
}

/** Input for sending a message via the dashboard */
export interface SendMessageInput {
  toId: string;
  toType: ParticipantType;
  content: string;
  type: MessageType;
  metadata?: MessageMetadata;
  wakeImmediately?: boolean;
}

export interface ApprovalRequestSummary {
  id: string;
  status: ApprovalRequestStatus;
  actionCategory: string;
  actionSummary: string;
  agentId: string;
  taskId?: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export interface ApprovalRequestDetail extends ApprovalRequestSummary {
  requester: {
    actorId: string;
    actorType: "agent" | "user" | "system";
    actorName: string;
  };
  runId?: string;
  requestedAt: string;
  completedAt?: string;
  targetAction: {
    category: string;
    action: string;
    summary: string;
    resourceType: string;
    resourceId: string;
    context?: Record<string, unknown>;
  };
  history: Array<{
    id: string;
    eventType: string;
    actor: {
      actorId: string;
      actorType: "agent" | "user" | "system";
      actorName: string;
    };
    note?: string;
    createdAt: string;
  }>;
}

export interface ApprovalListResponse {
  requests: ApprovalRequestSummary[];
  total: number;
  pendingCount: number;
}

/** Fetch inbox messages for the current user. */
export function fetchInbox(
  options?: { limit?: number; offset?: number; unreadOnly?: boolean; type?: MessageType },
  projectId?: string,
): Promise<InboxResponse> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
  if (options?.unreadOnly) params.set("unreadOnly", "true");
  if (options?.type) params.set("type", options.type);
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<InboxResponse>(`/messages/inbox${query}`);
}

/** Fetch sent messages for the current user. */
export function fetchOutbox(
  options?: { limit?: number; offset?: number; type?: MessageType },
  projectId?: string,
): Promise<OutboxResponse> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
  if (options?.type) params.set("type", options.type);
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<OutboxResponse>(`/messages/outbox${query}`);
}

/** Fetch unread message count (lightweight, for header badge). */
export function fetchUnreadCount(projectId?: string): Promise<UnreadCountResponse> {
  return api<UnreadCountResponse>(withProjectId("/messages/unread-count", projectId));
}

/** Fetch a single message by ID. */
export function fetchMessage(id: string, projectId?: string): Promise<Message> {
  return api<Message>(withProjectId(`/messages/${encodeURIComponent(id)}`, projectId));
}

/** Send a new message. */
export function sendMessage(input: SendMessageInput, projectId?: string): Promise<Message> {
  return api<Message>(withProjectId("/messages", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Mark a specific message as read. */
export function markMessageRead(id: string, projectId?: string): Promise<Message> {
  return api<Message>(withProjectId(`/messages/${encodeURIComponent(id)}/read`, projectId), {
    method: "POST",
  });
}

/** Mark all inbox messages as read. */
export function markAllMessagesRead(projectId?: string): Promise<MarkAllReadResponse> {
  return api<MarkAllReadResponse>(withProjectId("/messages/read-all", projectId), {
    method: "POST",
  });
}

/** Delete a message. */
export function deleteMessage(id: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/messages/${encodeURIComponent(id)}`, projectId), {
    method: "DELETE",
  });
}

/** Fetch conversation between current user and a specific participant. */
export function fetchConversation(
  participantId: string,
  participantType: ParticipantType,
  projectId?: string,
): Promise<Message[]> {
  const path = `/messages/conversation/${encodeURIComponent(participantType)}/${encodeURIComponent(participantId)}`;
  return api<Message[]>(withProjectId(path, projectId));
}

/** Fetch an agent's mailbox (admin read-only view). */
export function fetchAgentMailbox(agentId: string, projectId?: string): Promise<AgentMailboxResponse> {
  return api<AgentMailboxResponse>(withProjectId(`/agents/${encodeURIComponent(agentId)}/mailbox`, projectId));
}

/** Fetch aggregate mailbox across all agent-to-agent messages (admin read-only view). */
export function fetchAllAgentMailbox(projectId?: string): Promise<AllAgentsMailboxResponse> {
  return api<AllAgentsMailboxResponse>(withProjectId("/agents/mailbox/all", projectId));
}

export function fetchApprovals(
  options?: { status?: ApprovalRequestStatus; limit?: number; offset?: number },
  projectId?: string,
): Promise<ApprovalListResponse> {
  const params = new URLSearchParams();
  if (options?.status) params.set("status", options.status);
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<ApprovalListResponse>(`/approvals${query}`);
}

export function fetchApprovalDetail(id: string, projectId?: string): Promise<ApprovalRequestDetail> {
  return api<ApprovalRequestDetail>(withProjectId(`/approvals/${encodeURIComponent(id)}`, projectId));
}

export function decideApproval(
  id: string,
  input: { decision: "approve" | "deny"; comment?: string },
  projectId?: string,
): Promise<ApprovalRequestDetail> {
  return api<ApprovalRequestDetail>(withProjectId(`/approvals/${encodeURIComponent(id)}/decision`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Fetch reflection history for an agent. */
export function fetchAgentReflections(agentId: string, limit?: number, projectId?: string): Promise<AgentReflection[]> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<AgentReflection[]>(`/agents/${encodeURIComponent(agentId)}/reflections${query}`);
}

/** Fetch the most recent reflection for an agent. */
export function fetchAgentReflection(agentId: string, projectId?: string): Promise<AgentReflection> {
  return api<AgentReflection>(withProjectId(`/agents/${encodeURIComponent(agentId)}/reflections/latest`, projectId));
}

/** Trigger a manual reflection for an agent. */
export function triggerAgentReflection(agentId: string, projectId?: string): Promise<AgentReflection | null> {
  return api<AgentReflection | null>(withProjectId(`/agents/${encodeURIComponent(agentId)}/reflections`, projectId), {
    method: "POST",
  });
}

/** Fetch aggregated performance summary for an agent. */
export function fetchAgentPerformance(agentId: string, windowMs?: number, projectId?: string): Promise<AgentPerformanceSummary> {
  const params = new URLSearchParams();
  if (windowMs !== undefined) params.set("windowMs", String(windowMs));
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<AgentPerformanceSummary>(`/agents/${encodeURIComponent(agentId)}/performance${query}`);
}

/** Fetch ratings for an agent */
export function fetchAgentRatings(
  agentId: string,
  options?: { limit?: number; category?: string },
  projectId?: string,
): Promise<AgentRating[]> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.category) params.set("category", options.category);
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<AgentRating[]>(`/agents/${encodeURIComponent(agentId)}/ratings${query}`);
}

/** Add a rating for an agent */
export function addAgentRating(
  agentId: string,
  input: AgentRatingInput,
  projectId?: string,
): Promise<AgentRating> {
  return api<AgentRating>(withProjectId(`/agents/${encodeURIComponent(agentId)}/ratings`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Fetch rating summary for an agent */
export function fetchAgentRatingSummary(agentId: string, projectId?: string): Promise<AgentRatingSummary> {
  return api<AgentRatingSummary>(withProjectId(`/agents/${encodeURIComponent(agentId)}/ratings/summary`, projectId));
}

/** Delete a specific rating */
export function deleteAgentRating(agentId: string, ratingId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/agents/${encodeURIComponent(agentId)}/ratings/${encodeURIComponent(ratingId)}`, projectId), {
    method: "DELETE",
  });
}

// ── Agent Budget API ──────────────────────────────────────────────────────

/** Fetch budget status for an agent */
export function fetchAgentBudgetStatus(agentId: string, projectId?: string): Promise<AgentBudgetStatus> {
  return api<AgentBudgetStatus>(withProjectId(`/agents/${encodeURIComponent(agentId)}/budget`, projectId));
}

/** Reset budget usage for an agent */
export function resetAgentBudget(agentId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/agents/${encodeURIComponent(agentId)}/budget/reset`, projectId), {
    method: "POST",
  });
}

// ── Plugin Management ────────────────────────────────────────────────────────

export interface RegistryPluginEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category: "runtime" | "integration";
  npmPackage?: string;
  path?: string;
  homepage?: string;
  tags?: string[];
  installed: boolean;
  state?: PluginState;
  installedVersion?: string;
  canInstall: boolean;
}

/** Fetch all installed plugins */
export async function fetchPlugins(projectId?: string): Promise<PluginInstallation[]> {
  return api<PluginInstallation[]>(withProjectId("/plugins", projectId));
}

/** Fetch curated registry plugins with installed-state metadata */
export async function fetchPluginRegistry(
  query?: string,
  category?: string,
  projectId?: string,
): Promise<RegistryPluginEntry[]> {
  const params = new URLSearchParams();
  if (query?.trim()) {
    params.set("q", query.trim());
  }
  if (category?.trim()) {
    params.set("category", category.trim());
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const response = await api<{ plugins: RegistryPluginEntry[] }>(withProjectId(`/plugins/registry${suffix}`, projectId));
  return response.plugins;
}

/** Fetch a single plugin by ID */
export async function fetchPluginDetail(id: string, projectId?: string): Promise<PluginInstallation> {
  return api<PluginInstallation>(withProjectId(`/plugins/${encodeURIComponent(id)}`, projectId));
}

/** Install a plugin from local path or npm package */
export async function installPlugin(
  source: { path: string; aiScanOnLoad?: boolean } | { package: string; aiScanOnLoad?: boolean },
  projectId?: string,
): Promise<PluginInstallation> {
  return api<PluginInstallation>(withProjectId("/plugins", projectId), {
    method: "POST",
    body: JSON.stringify({ mode: "install", ...source }),
  });
}

/** Enable a plugin */
export async function enablePlugin(id: string, projectId?: string): Promise<PluginInstallation> {
  return api<PluginInstallation>(withProjectId(`/plugins/${encodeURIComponent(id)}/enable`, projectId), {
    method: "POST",
  });
}

/** Disable a plugin */
export async function disablePlugin(id: string, projectId?: string): Promise<PluginInstallation> {
  return api<PluginInstallation>(withProjectId(`/plugins/${encodeURIComponent(id)}/disable`, projectId), {
    method: "POST",
  });
}

/** Uninstall a plugin */
export async function uninstallPlugin(id: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/plugins/${encodeURIComponent(id)}`, projectId), {
    method: "DELETE",
  });
}

/** Fetch plugin settings */
export async function fetchPluginSettings(id: string, projectId?: string): Promise<Record<string, unknown>> {
  return api<Record<string, unknown>>(withProjectId(`/plugins/${encodeURIComponent(id)}/settings`, projectId));
}

/** Update plugin settings */
export async function updatePluginSettings(
  id: string,
  settings: Record<string, unknown>,
  projectId?: string,
): Promise<Record<string, unknown>> {
  return api<Record<string, unknown>>(withProjectId(`/plugins/${encodeURIComponent(id)}/settings`, projectId), {
    method: "PUT",
    body: JSON.stringify({ settings }),
  });
}

export type PluginSetupStatusResponse =
  | { hasSetup: false }
  | ({ hasSetup: true } & PluginSetupCheckResult)
  | {
    hasSetup: true;
    setupCheckDeferred: true;
    deferredReason: "plugin-not-started";
    pluginState: PluginInstallation["state"];
  };

/** Fetch plugin setup status */
export async function fetchPluginSetupStatus(id: string, projectId?: string): Promise<PluginSetupStatusResponse> {
  return api<PluginSetupStatusResponse>(withProjectId(`/plugins/${encodeURIComponent(id)}/setup-status`, projectId));
}

/** Trigger plugin setup install hook */
export async function installPluginSetup(id: string, projectId?: string): Promise<{ success: boolean; error?: string }> {
  return api<{ success: boolean; error?: string }>(withProjectId(`/plugins/${encodeURIComponent(id)}/setup/install`, projectId), {
    method: "POST",
  });
}

/** Reload a running plugin with updated code */
export async function reloadPlugin(id: string, projectId?: string): Promise<PluginInstallation> {
  return api<PluginInstallation>(withProjectId(`/plugins/${encodeURIComponent(id)}/reload`, projectId), {
    method: "POST",
  });
}

/** Update plugin security-scan configuration */
export async function updatePlugin(id: string, updates: { aiScanOnLoad: boolean }, projectId?: string): Promise<PluginInstallation> {
  return api<PluginInstallation>(withProjectId(`/plugins/${encodeURIComponent(id)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Trigger plugin rescan + reload flow */
export async function rescanPlugin(id: string, projectId?: string): Promise<PluginInstallation> {
  return api<PluginInstallation>(withProjectId(`/plugins/${encodeURIComponent(id)}/rescan`, projectId), {
    method: "POST",
  });
}

/** A UI slot entry returned by GET /api/plugins/ui-slots */
export interface PluginUiSlotEntry {
  pluginId: string;
  slot: PluginUiSlotDefinition;
}

/** A structured UI contribution entry returned by GET /api/plugins/ui-contributions */
export interface PluginUiContributionEntry {
  pluginId: string;
  contribution: PluginUiContributionDefinition;
}

/** A dashboard view entry returned by GET /api/plugins/dashboard-views */
export interface PluginDashboardViewEntry {
  pluginId: string;
  view: PluginDashboardViewDefinition;
}

/** Plugin runtime metadata returned by GET /api/plugins/runtimes */
export interface PluginRuntimeInfo {
  pluginId: string;
  runtimeId: string;
  name: string;
  description?: string;
  version?: string;
}

/** Fetch all UI slot definitions from active plugins */
export async function fetchPluginUiSlots(projectId?: string): Promise<PluginUiSlotEntry[]> {
  const path = withProjectId("/plugins/ui-slots", projectId);
  return dedupe(path, () => api<PluginUiSlotEntry[]>(path));
}


/** Fetch all structured UI contributions from active plugins */
export async function fetchPluginUiContributions(projectId?: string): Promise<PluginUiContributionEntry[]> {
  return api<PluginUiContributionEntry[]>(withProjectId("/plugins/ui-contributions", projectId));
}

/** Fetch all top-level dashboard view definitions from active plugins */
export async function fetchPluginDashboardViews(projectId?: string): Promise<PluginDashboardViewEntry[]> {
  return api<PluginDashboardViewEntry[]>(withProjectId("/plugins/dashboard-views", projectId));
}

/** Fetch all plugin runtime metadata from active plugins */
export async function fetchPluginRuntimes(projectId?: string): Promise<PluginRuntimeInfo[]> {
  return api<PluginRuntimeInfo[]>(withProjectId("/plugins/runtimes", projectId));
}

// ── Skills Management ─────────────────────────────────────────────────────────

/** Fetch all discovered skills with their enabled state */
export async function fetchDiscoveredSkills(projectId?: string): Promise<DiscoveredSkill[]> {
  const response = await api<{ skills: DiscoveredSkill[] }>(withProjectId("/skills/discovered", projectId));
  return response.skills;
}

/** Toggle a skill's enabled/disabled state */
export async function toggleExecutionSkill(
  skillId: string,
  enabled: boolean,
  projectId?: string,
): Promise<ToggleSkillResult> {
  return api<ToggleSkillResult>(withProjectId("/skills/execution", projectId), {
    method: "PATCH",
    body: JSON.stringify({ skillId, enabled }),
  });
}

/** Install a catalog skill from skills.sh */
export async function installSkill(
  source: string,
  skill: string | undefined,
  projectId?: string,
): Promise<{ success: true }> {
  return api<{ success: true }>(withProjectId("/skills/install", projectId), {
    method: "POST",
    body: JSON.stringify({ source, skill }),
  });
}

/** Fetch the skills.sh catalog */
export async function fetchSkillsCatalog(
  query?: string,
  limit?: number,
  projectId?: string,
): Promise<CatalogFetchResult> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (limit !== undefined) params.set("limit", String(limit));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return api<CatalogFetchResult>(withProjectId(`/skills/catalog${suffix}`, projectId));
}

/** Fetch the contents of a skill's SKILL.md file */
export async function fetchSkillContent(skillId: string, projectId?: string): Promise<SkillContent> {
  const response = await api<{ content: SkillContent }>(
    withProjectId(`/skills/${encodeURIComponent(skillId)}/content`, projectId)
  );
  return response.content;
}

/*
FNXC:Skills 2026-06-23-04:15:
Fetch one supplementary file's content for the SkillsView detail-pane file viewer. The skill-dir-relative path is passed as an encoded `path` query param; the server resolves + traversal-guards it. Returns isText:false for binary/oversized files so the UI shows a non-previewable notice.
*/
export async function fetchSkillFileContent(skillId: string, relativePath: string, projectId?: string): Promise<SkillFileContent> {
  const base = withProjectId(`/skills/${encodeURIComponent(skillId)}/file`, projectId);
  const sep = base.includes("?") ? "&" : "?";
  const response = await api<{ file: SkillFileContent }>(
    `${base}${sep}path=${encodeURIComponent(relativePath)}`
  );
  return response.file;
}

// ── Chat API ─────────────────────────────────────────────────────────────────

// EnrichedChatSession is imported from @fusion/core above

export interface ChatSessionListResponse {
  sessions: EnrichedChatSession[];
}

export interface ChatSessionResponse {
  session: EnrichedChatSession;
}

export interface ChatMessageListResponse {
  messages: ChatMessage[];
}

export interface TaskPlannerChatSessionInput {
  modelProvider?: string;
  modelId?: string;
}

export interface ChatRoomListResponse {
  rooms: ChatRoom[];
}

export interface ChatRoomResponse {
  room: ChatRoom;
  members?: ChatRoomMember[];
}

export interface ChatRoomMembersResponse {
  members: ChatRoomMember[];
}

export interface ChatRoomMessageListResponse {
  messages: ChatRoomMessage[];
}

export interface ChatRoomMessageResponse {
  message: ChatRoomMessage;
}

/**
 * FNXC:ChatSearch 2026-07-07-00:00:
 * `q`/`titleOnly` mirror the server's GET /chat/sessions content-search params (see
 * register-chat-routes.ts). `q` triggers server-side message-content search; `titleOnly=true`
 * (or omitting `q`) preserves the pre-existing client-side title/agent-only filtering.
 */
export interface FetchChatSessionsOptions {
  status?: string;
  q?: string;
  titleOnly?: boolean;
}

/** Fetch all chat sessions for a project */
export function fetchChatSessions(
  projectId?: string,
  status?: string,
  options?: FetchChatSessionsOptions,
): Promise<ChatSessionListResponse> {
  const search = new URLSearchParams();
  if (projectId) search.set("projectId", projectId);
  const resolvedStatus = options?.status ?? status;
  if (resolvedStatus) search.set("status", resolvedStatus);
  if (options?.q && options.q.trim()) search.set("q", options.q.trim());
  if (options?.titleOnly) search.set("titleOnly", "true");
  const qs = search.toString();
  return api<ChatSessionListResponse>(`/chat/sessions${qs ? `?${qs}` : ""}`);
}

export interface ChatSessionResumeLookupInput {
  agentId: string;
  modelProvider?: string;
  modelId?: string;
}

/**
 * Fetch the most relevant active session for chat resume semantics.
 * Returns at most one session for the provided target.
 */
export async function fetchResumeChatSession(
  input: ChatSessionResumeLookupInput,
  projectId?: string,
): Promise<{ session: EnrichedChatSession | null }> {
  const normalizedAgentId = input.agentId.trim();
  if (!normalizedAgentId) {
    throw new Error("agentId is required");
  }

  const normalizedProvider = input.modelProvider?.trim();
  const normalizedModelId = input.modelId?.trim();

  if ((normalizedProvider && !normalizedModelId) || (!normalizedProvider && normalizedModelId)) {
    throw new Error("Both modelProvider and modelId must be provided together, or neither should be provided");
  }

  const search = new URLSearchParams();
  search.set("lookup", "resume");
  search.set("agentId", normalizedAgentId);
  if (projectId) search.set("projectId", projectId);
  if (normalizedProvider && normalizedModelId) {
    search.set("modelProvider", normalizedProvider);
    search.set("modelId", normalizedModelId);
  }

  const data = await api<ChatSessionListResponse>(`/chat/sessions?${search.toString()}`);
  return { session: data.sessions[0] ?? null };
}

/** Create a new chat session */
export function createChatSession(
  input: { agentId: string; title?: string; modelProvider?: string; modelId?: string; thinkingLevel?: string },
  projectId?: string,
): Promise<ChatSessionResponse> {
  return api<ChatSessionResponse>(withProjectId("/chat/sessions", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Fetch a single chat session */
export function fetchChatSession(id: string, projectId?: string): Promise<ChatSessionResponse> {
  return api<ChatSessionResponse>(withProjectId(`/chat/sessions/${encodeURIComponent(id)}`, projectId));
}

function normalizeTaskPlannerChatInput(taskId: string, input: TaskPlannerChatSessionInput = {}) {
  const normalizedTaskId = taskId.trim();
  if (!normalizedTaskId) {
    throw new Error("taskId is required");
  }
  const normalizedProvider = input.modelProvider?.trim();
  const normalizedModelId = input.modelId?.trim();
  if ((normalizedProvider && !normalizedModelId) || (!normalizedProvider && normalizedModelId)) {
    throw new Error("Both modelProvider and modelId must be provided together, or neither should be provided");
  }
  return { normalizedTaskId, normalizedProvider, normalizedModelId };
}

export function fetchTaskPlannerChatSession(
  taskId: string,
  input: TaskPlannerChatSessionInput = {},
  projectId?: string,
): Promise<{ session: EnrichedChatSession | null }> {
  const { normalizedTaskId, normalizedProvider, normalizedModelId } = normalizeTaskPlannerChatInput(taskId, input);

  /*
  FNXC:TaskDetailPlannerChat 2026-06-30-18:20:
  Task-detail planner chats are task-local but no longer pre-created by opening the Chat tab. Use lookup-only resume here so global Chat history only receives planner sessions after an explicit user message creates one.
  */
  return fetchResumeChatSession({
    agentId: `task-planner:${normalizedTaskId}`,
    ...(normalizedProvider && normalizedModelId ? { modelProvider: normalizedProvider, modelId: normalizedModelId } : {}),
  }, projectId);
}

export function ensureTaskPlannerChatSession(
  taskId: string,
  input: TaskPlannerChatSessionInput = {},
  projectId?: string,
): Promise<ChatSessionResponse> {
  const { normalizedTaskId, normalizedProvider, normalizedModelId } = normalizeTaskPlannerChatInput(taskId, input);

  /*
  FNXC:TaskDetailPlannerChat 2026-06-30-22:30:
  Task planner chat uses a task-scoped session seam instead of the generic agent-chat creator so it can bind the conversation to the task and planning model without requiring a real executor/reviewer agent or turning the message into steering.

  FNXC:TaskDetailPlannerChat 2026-06-30-18:20:
  This mutating helper is reserved for explicit user sends (composer, starter prompts, and planner-question answers). Tab activation must call fetchTaskPlannerChatSession instead so empty task-detail visits do not create chat history.
  */
  return api<ChatSessionResponse>(
    withProjectId(`/chat/task-planner/${encodeURIComponent(normalizedTaskId)}/session`, projectId),
    {
      method: "POST",
      body: JSON.stringify({
        ...(normalizedProvider && normalizedModelId ? { modelProvider: normalizedProvider, modelId: normalizedModelId } : {}),
      }),
    },
  );
}

/** Update a chat session (title, status, thinkingLevel, model, or agent target) */
export function updateChatSession(
  id: string,
  updates: {
    title?: string | null;
    status?: string;
    modelProvider?: string | null;
    modelId?: string | null;
    agentId?: string;
    thinkingLevel?: string | null;
    pinned?: boolean;
  },
  projectId?: string,
): Promise<ChatSessionResponse> {
  return api<ChatSessionResponse>(withProjectId(`/chat/sessions/${encodeURIComponent(id)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete a chat session */
export function deleteChatSession(id: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId(`/chat/sessions/${encodeURIComponent(id)}`, projectId), {
    method: "DELETE",
  });
}

/** Fetch messages for a chat session */
export function fetchChatMessages(
  sessionId: string,
  opts?: { limit?: number; offset?: number; before?: string; order?: "asc" | "desc" },
  projectId?: string,
): Promise<ChatMessageListResponse> {
  const search = new URLSearchParams();
  if (opts?.limit !== undefined) search.set("limit", String(opts.limit));
  if (opts?.offset !== undefined) search.set("offset", String(opts.offset));
  if (opts?.before) search.set("before", opts.before);
  if (opts?.order) search.set("order", opts.order);
  const qs = search.toString();
  return api<ChatMessageListResponse>(
    withProjectId(`/chat/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ""}`, projectId),
  );
}

/** Delete a specific message from a chat session */
export function deleteChatMessage(
  sessionId: string,
  messageId: string,
  projectId?: string,
): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(
    withProjectId(`/chat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`, projectId),
    {
      method: "DELETE",
    },
  );
}

/**
 * FNXC:ChatMessageEdit 2026-07-07-09:00:
 * Edit an earlier user message in a direct (model-loop) chat session. Truncates the persisted
 * transcript from (and including) the target message onward AND rewinds the pi session context
 * server-side, so the returned `retained` list is the surviving pre-edit history. Does NOT
 * trigger regeneration — the caller resends the edited content via the existing streaming send.
 */
export function editChatMessage(
  sessionId: string,
  messageId: string,
  content: string,
  projectId?: string,
): Promise<{ retained: ChatMessage[] }> {
  return api<{ retained: ChatMessage[] }>(
    withProjectId(`/chat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`, projectId),
    {
      method: "PATCH",
      body: JSON.stringify({ content }),
    },
  );
}

export function fetchChatRooms(
  options: { status?: string; agentId?: string } = {},
  projectId?: string,
): Promise<ChatRoomListResponse> {
  const search = new URLSearchParams();
  if (projectId) search.set("projectId", projectId);
  if (options.status) search.set("status", options.status);
  if (options.agentId) search.set("agentId", options.agentId);
  const qs = search.toString();
  return api<ChatRoomListResponse>(`/chat/rooms${qs ? `?${qs}` : ""}`);
}

export function fetchChatRoom(id: string, projectId?: string): Promise<ChatRoomResponse> {
  return api<ChatRoomResponse>(withProjectId(`/chat/rooms/${encodeURIComponent(id)}`, projectId));
}

export function createChatRoom(
  input: { name: string; description?: string | null; createdBy?: string | null; memberAgentIds?: string[]; thinkingLevel?: string | null },
  projectId?: string,
): Promise<ChatRoomResponse> {
  const body = { ...input, ...(projectId ? { projectId } : {}) };
  return api<ChatRoomResponse>(withProjectId("/chat/rooms", projectId), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateChatRoom(
  id: string,
  updates: { name?: string; description?: string | null; status?: "active" | "archived"; thinkingLevel?: string | null },
  projectId?: string,
): Promise<{ room: ChatRoom }> {
  return api<{ room: ChatRoom }>(withProjectId(`/chat/rooms/${encodeURIComponent(id)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export function deleteChatRoom(id: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId(`/chat/rooms/${encodeURIComponent(id)}`, projectId), {
    method: "DELETE",
  });
}

export function fetchChatRoomMembers(id: string, projectId?: string): Promise<ChatRoomMembersResponse> {
  return api<ChatRoomMembersResponse>(withProjectId(`/chat/rooms/${encodeURIComponent(id)}/members`, projectId));
}

export function addChatRoomMember(
  id: string,
  input: { agentId: string; role?: "owner" | "member" },
  projectId?: string,
): Promise<{ member: ChatRoomMember }> {
  return api<{ member: ChatRoomMember }>(withProjectId(`/chat/rooms/${encodeURIComponent(id)}/members`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function removeChatRoomMember(id: string, agentId: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(
    withProjectId(`/chat/rooms/${encodeURIComponent(id)}/members/${encodeURIComponent(agentId)}`, projectId),
    { method: "DELETE" },
  );
}

export function fetchChatRoomMessages(
  id: string,
  opts?: { limit?: number; offset?: number; before?: string; order?: "asc" | "desc" },
  projectId?: string,
): Promise<ChatRoomMessageListResponse> {
  const search = new URLSearchParams();
  if (opts?.limit !== undefined) search.set("limit", String(opts.limit));
  if (opts?.offset !== undefined) search.set("offset", String(opts.offset));
  if (opts?.before) search.set("before", opts.before);
  if (opts?.order) search.set("order", opts.order);
  const qs = search.toString();
  return api<ChatRoomMessageListResponse>(
    withProjectId(`/chat/rooms/${encodeURIComponent(id)}/messages${qs ? `?${qs}` : ""}`, projectId),
  );
}

export async function uploadChatRoomAttachment(
  roomId: string,
  file: File,
  projectId?: string,
): Promise<{ attachment: ChatAttachment }> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(buildApiUrl(withProjectId(`/chat/rooms/${encodeURIComponent(roomId)}/attachments`, projectId)), {
    method: "POST",
    headers: withTokenHeader(),
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error || "Upload failed");
  return data as { attachment: ChatAttachment };
}

export function attachmentBaseUrlForRoom(roomId: string, projectId?: string): string {
  return buildApiUrl(withProjectId(`/chat/rooms/${encodeURIComponent(roomId)}/attachments/`, projectId));
}

export function postChatRoomMessage(
  id: string,
  input: { content: string; senderAgentId?: null; mentions?: string[]; attachments?: ChatAttachment[] },
  projectId?: string,
): Promise<ChatRoomMessageResponse> {
  return api<ChatRoomMessageResponse>(withProjectId(`/chat/rooms/${encodeURIComponent(id)}/messages`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteChatRoomMessage(
  id: string,
  messageId: string,
  projectId?: string,
): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(
    withProjectId(`/chat/rooms/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`, projectId),
    { method: "DELETE" },
  );
}

export function clearChatRoomMessages(
  id: string,
  projectId?: string,
): Promise<{ success: boolean; deletedCount: number }> {
  return api<{ success: boolean; deletedCount: number }>(
    withProjectId(`/chat/rooms/${encodeURIComponent(id)}/messages`, projectId),
    { method: "DELETE" },
  );
}

/**
 * Room POST /messages in FN-3808 is persist-only (201 JSON response).
 * Do not add streamChatRoomResponse until FN-3810 introduces AI invocation/streaming.
 */

/** Cancel an in-flight chat generation. */
export function cancelChatResponse(
  sessionId: string,
  projectId?: string,
): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(
    withProjectId(`/chat/sessions/${encodeURIComponent(sessionId)}/cancel`, projectId),
    {
      method: "POST",
    },
  );
}

/** Send a chat message and receive the AI response via SSE streaming.
 *
 *  The backend exposes `POST /api/chat/sessions/:id/messages` which returns an SSE
 *  stream (not JSON). Events: `thinking`, `text`, `fallback`, `done`, `error`.
 *
 *  Since `EventSource` only supports GET requests, this function uses `fetch()`
 *  with a ReadableStream to parse SSE events from the POST response body.
 *  When attachments are provided, the request body is sent as multipart form data;
 *  otherwise it uses the existing JSON payload path.
 */
export interface ChatFailureReference {
  kind: string;
  id: string;
  label?: string;
}

export interface ChatFailureInfo {
  summary: string;
  errorClass?: string;
  code?: string;
  detail?: string;
  reference?: ChatFailureReference;
}

function extractChatFailureInfo(value: unknown): ChatFailureInfo | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  if (!summary) {
    return null;
  }

  const reference = (() => {
    const rawReference = record.reference;
    if (!rawReference || typeof rawReference !== "object") {
      return undefined;
    }
    const referenceRecord = rawReference as Record<string, unknown>;
    const kind = typeof referenceRecord.kind === "string" ? referenceRecord.kind.trim() : "";
    const id = typeof referenceRecord.id === "string" ? referenceRecord.id.trim() : "";
    if (!kind || !id) {
      return undefined;
    }
    return {
      kind,
      id,
      ...(typeof referenceRecord.label === "string" && referenceRecord.label.trim()
        ? { label: referenceRecord.label.trim() }
        : {}),
    } satisfies ChatFailureReference;
  })();

  return {
    summary,
    ...(typeof record.errorClass === "string" && record.errorClass.trim()
      ? { errorClass: record.errorClass.trim() }
      : {}),
    ...(typeof record.code === "string" && record.code.trim()
      ? { code: record.code.trim() }
      : {}),
    ...(typeof record.detail === "string" && record.detail.trim()
      ? { detail: record.detail.trim() }
      : {}),
    ...(reference ? { reference } : {}),
  };
}

function parseChatErrorPayload(rawData: string): string | ChatFailureInfo {
  try {
    const parsed = JSON.parse(rawData);
    const structured = extractChatFailureInfo(parsed);
    if (structured) {
      return structured;
    }
    if (parsed && typeof parsed === "object" && typeof (parsed as { message?: unknown }).message === "string") {
      return (parsed as { message: string }).message;
    }
    return typeof parsed === "string" ? parsed : rawData || "Stream error";
  } catch {
    return rawData || "Stream error";
  }
}

export interface ChatStreamErrorMeta {
  /** True once the POST stream was accepted and the server started an SSE response. */
  requestAccepted: boolean;
  /** True when the error came from an SSE event rather than the initial HTTP response. */
  receivedStreamEvent: boolean;
}

export interface ChatStreamHandlers {
  onThinking?: (data: string) => void;
  onText?: (data: string) => void;
  onToolStart?: (data: { toolName: string; args?: Record<string, unknown> }) => void;
  onToolEnd?: (data: { toolName: string; isError: boolean; result?: unknown }) => void;
  onFallback?: (data: { primaryModel: string; fallbackModel: string; triggerPoint: "session-creation" | "prompt-time" }) => void;
  onDone?: (data: { messageId: string; message?: ChatMessage }) => void;
  onError?: (data: string | ChatFailureInfo, meta?: ChatStreamErrorMeta) => void;
  onConnectionStateChange?: (state: StreamConnectionState) => void;
}

export function streamChatResponse(
  sessionId: string,
  content: string,
  handlers: ChatStreamHandlers,
  attachments?: File[],
  projectId?: string,
  options?: { maxReconnectAttempts?: number; firstEventTimeoutMs?: number; taskId?: string },
): { close: () => void; isConnected: () => boolean } {
  const url = buildApiUrl(withProjectId(`/chat/sessions/${encodeURIComponent(sessionId)}/messages`, projectId));

  const abortController = new AbortController();
  let closedByUser = false;
  let terminated = false;
  let requestAccepted = false;
  let receivedStreamEvent = false;
  const firstEventTimeoutMs = Math.max(1_000, options?.firstEventTimeoutMs ?? 60_000);
  let firstEventTimer: ReturnType<typeof setTimeout> | null = null;

  const clearFirstEventTimer = (): void => {
    if (firstEventTimer) {
      clearTimeout(firstEventTimer);
      firstEventTimer = null;
    }
  };

  const markFirstEventReceived = (): void => {
    if (receivedStreamEvent) {
      return;
    }
    receivedStreamEvent = true;
    clearFirstEventTimer();
  };

  const dispatchEvent = (eventName: string, rawData: string): void => {
    if (!eventName) {
      return;
    }

    markFirstEventReceived();

    switch (eventName) {
      case "thinking":
        try {
          handlers.onThinking?.(JSON.parse(rawData));
        } catch {
          handlers.onThinking?.(rawData);
        }
        break;
      case "text":
        try {
          handlers.onText?.(JSON.parse(rawData));
        } catch {
          handlers.onText?.(rawData);
        }
        break;
      case "tool_start":
        try {
          handlers.onToolStart?.(JSON.parse(rawData));
        } catch {
          // skip malformed event
        }
        break;
      case "tool_end":
        try {
          handlers.onToolEnd?.(JSON.parse(rawData));
        } catch {
          // skip malformed event
        }
        break;
      case "fallback":
        try {
          handlers.onFallback?.(JSON.parse(rawData));
        } catch {
          // skip malformed event
        }
        break;
      case "done":
        terminated = true;
        try {
          const parsed = JSON.parse(rawData) as { messageId?: unknown; message?: unknown };
          handlers.onDone?.({
            messageId: typeof parsed.messageId === "string" ? parsed.messageId : "",
            ...(parsed.message && typeof parsed.message === "object" ? { message: parsed.message as ChatMessage } : {}),
          });
        } catch {
          handlers.onDone?.({ messageId: "" });
        }
        break;
      case "error":
        terminated = true;
        handlers.onError?.(parseChatErrorPayload(rawData), { requestAccepted: true, receivedStreamEvent: true });
        break;
    }
  };

  // Start streaming via POST
  (async () => {
    try {
      const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
      const body = hasAttachments
        ? (() => {
            const formData = new FormData();
            formData.append("content", content);
            if (options?.taskId) formData.append("taskId", options.taskId);
            attachments.forEach((file) => formData.append("attachments", file));
            return formData;
          })()
        : JSON.stringify({ content, ...(options?.taskId ? { taskId: options.taskId } : {}) });

      const res = await fetch(url, {
        method: "POST",
        headers: hasAttachments ? withTokenHeader() : withTokenHeader({ "Content-Type": "application/json" }),
        body,
        signal: abortController.signal,
      });

      if (!res.ok) {
        const errorBody = await res.text();
        let errorMsg = `Request failed: ${res.status}`;
        try {
          const parsed = JSON.parse(errorBody);
          errorMsg = parsed.error || errorMsg;
        } catch { /* use default */ }
        handlers.onError?.(errorMsg, { requestAccepted: false, receivedStreamEvent: false });
        return;
      }

      if (!res.body) {
        handlers.onError?.("No response body", { requestAccepted: true, receivedStreamEvent: false });
        return;
      }

      requestAccepted = true;
      handlers.onConnectionStateChange?.("connected");
      firstEventTimer = setTimeout(() => {
        if (terminated || closedByUser || receivedStreamEvent) {
          return;
        }
        /*
        FNXC:ChatReliability 2026-07-04-00:00:
        Accepted chat requests can keep generating after the dashboard has not yet seen the first SSE event. Treat this timer as a non-terminal wait marker so the UI stays in-progress and can reconcile late persisted output instead of showing a false Response failed bubble.
        */
        firstEventTimer = null;
      }, firstEventTimeoutMs);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let currentDataLines: string[] = [];

      // POST-based chat responses still speak SSE, so parser state must persist
      // across ReadableStream chunks. Networks can split `event:` and `data:`
      // lines arbitrarily, and resetting state per-read drops assistant output.
      const processLines = (chunk: string, flushPendingEvent = false): void => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        // At stream end, flush any remaining buffered line so complete trailing
        // events are parsed even when the payload has no final newline.
        if (flushPendingEvent && buffer.length > 0) {
          lines.push(buffer);
          buffer = "";
        }

        for (const rawLine of lines) {
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const value = line.slice(5);
            // Strip only the optional SSE protocol delimiter-space after `data:`.
            // Payload whitespace (including JSON-string leading spaces) must stay verbatim.
            currentDataLines.push(value.startsWith(" ") ? value.slice(1) : value);
          } else if (line === "") {
            const currentData = currentDataLines.join("\n");
            dispatchEvent(currentEvent, currentData);
            currentEvent = "";
            currentDataLines = [];
          }
        }

        // Flush any pending event/data at stream end.
        // Only dispatch if we have both a valid event type and accumulated data.
        if (flushPendingEvent && currentEvent && currentDataLines.length > 0) {
          const trailingData = currentDataLines.join("\n");
          dispatchEvent(currentEvent, trailingData);
          currentEvent = "";
          currentDataLines = [];
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          processLines(decoder.decode(), true);
          break;
        }

        processLines(decoder.decode(value, { stream: true }));
      }

      const hasUndispatchedTrailingFragment =
        buffer.length > 0 || currentEvent.length > 0 || currentDataLines.length > 0;

      // Server closed the stream without emitting a terminal `done` or `error`
      // SSE event (common on flaky mobile networks, proxy idle-kill, or
      // backgrounded tabs). Surface as an error so the client unwinds
      // streaming state instead of getting stuck with isStreaming=true.
      // Ignore dangling partial fragments at EOF: those indicate a truncated
      // trailing event that should be dropped rather than surfaced as transport
      // failure.
      if (!terminated && !closedByUser && !hasUndispatchedTrailingFragment) {
        handlers.onError?.("Connection closed unexpectedly", { requestAccepted, receivedStreamEvent });
      }
      clearFirstEventTimer();
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        if (!closedByUser && !terminated) {
          handlers.onError?.("Connection aborted", { requestAccepted, receivedStreamEvent });
        }
        clearFirstEventTimer();
        return;
      }
      if (closedByUser) {
        clearFirstEventTimer();
        return;
      }
      clearFirstEventTimer();
      handlers.onError?.(err instanceof Error ? err.message : "Connection error", { requestAccepted, receivedStreamEvent });
    }
  })();

  return {
    close: () => {
      closedByUser = true;
      clearFirstEventTimer();
      abortController.abort();
    },
    isConnected: () => !closedByUser,
  };
}

export function attachChatStream(
  sessionId: string,
  handlers: ChatStreamHandlers,
  projectId?: string,
  options?: { lastEventId?: number },
): { close: () => void; isConnected: () => boolean } {
  const url = buildApiUrl(withProjectId(`/chat/sessions/${encodeURIComponent(sessionId)}/stream`, projectId));
  const abortController = new AbortController();
  let closedByUser = false;
  let terminated = false;

  const dispatchEvent = (eventName: string, rawData: string): void => {
    if (!eventName) {
      return;
    }

    switch (eventName) {
      case "thinking":
        try {
          handlers.onThinking?.(JSON.parse(rawData));
        } catch {
          handlers.onThinking?.(rawData);
        }
        break;
      case "text":
        try {
          handlers.onText?.(JSON.parse(rawData));
        } catch {
          handlers.onText?.(rawData);
        }
        break;
      case "tool_start":
        try {
          handlers.onToolStart?.(JSON.parse(rawData));
        } catch {
          // skip malformed event
        }
        break;
      case "tool_end":
        try {
          handlers.onToolEnd?.(JSON.parse(rawData));
        } catch {
          // skip malformed event
        }
        break;
      case "fallback":
        try {
          handlers.onFallback?.(JSON.parse(rawData));
        } catch {
          // skip malformed event
        }
        break;
      case "done":
        terminated = true;
        try {
          const parsed = JSON.parse(rawData) as { messageId?: unknown; message?: unknown };
          handlers.onDone?.({
            messageId: typeof parsed.messageId === "string" ? parsed.messageId : "",
            ...(parsed.message && typeof parsed.message === "object" ? { message: parsed.message as ChatMessage } : {}),
          });
        } catch {
          handlers.onDone?.({ messageId: "" });
        }
        break;
      case "error":
        terminated = true;
        handlers.onError?.(parseChatErrorPayload(rawData));
        break;
    }
  };

  (async () => {
    try {
      const requestHeaders = new Headers(withTokenHeader() as HeadersInit);
      if (typeof options?.lastEventId === "number") {
        requestHeaders.set("Last-Event-ID", String(options.lastEventId));
      }

      const res = await fetch(url, {
        method: "GET",
        headers: requestHeaders,
        signal: abortController.signal,
      });

      if (!res.ok) {
        const errorBody = await res.text();
        let errorMsg = `Request failed: ${res.status}`;
        try {
          const parsed = JSON.parse(errorBody);
          errorMsg = parsed.error || errorMsg;
        } catch { /* use default */ }
        handlers.onError?.(errorMsg);
        return;
      }

      if (!res.body) {
        handlers.onError?.("No response body");
        return;
      }

      handlers.onConnectionStateChange?.("connected");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let currentDataLines: string[] = [];

      const processLines = (chunk: string, flushPendingEvent = false): void => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        if (flushPendingEvent && buffer.length > 0) {
          lines.push(buffer);
          buffer = "";
        }

        for (const rawLine of lines) {
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const value = line.slice(5);
            // Strip only the optional SSE protocol delimiter-space after `data:`.
            // Payload whitespace (including JSON-string leading spaces) must stay verbatim.
            currentDataLines.push(value.startsWith(" ") ? value.slice(1) : value);
          } else if (line === "") {
            const currentData = currentDataLines.join("\n");
            dispatchEvent(currentEvent, currentData);
            currentEvent = "";
            currentDataLines = [];
          }
        }

        if (flushPendingEvent && currentEvent && currentDataLines.length > 0) {
          const trailingData = currentDataLines.join("\n");
          dispatchEvent(currentEvent, trailingData);
          currentEvent = "";
          currentDataLines = [];
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          processLines(decoder.decode(), true);
          break;
        }

        processLines(decoder.decode(value, { stream: true }));
      }

      const hasUndispatchedTrailingFragment =
        buffer.length > 0 || currentEvent.length > 0 || currentDataLines.length > 0;

      if (!terminated && !closedByUser && !hasUndispatchedTrailingFragment) {
        return;
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        if (!closedByUser && !terminated) {
          handlers.onError?.("Connection aborted");
        }
        return;
      }
      if (closedByUser) {
        return;
      }
      handlers.onError?.(err instanceof Error ? err.message : "Connection error");
    }
  })();

  return {
    close: () => {
      closedByUser = true;
      abortController.abort();
    },
    isConnected: () => !closedByUser,
  };
}


// ── Insights API ─────────────────────────────────────────────────────────────

export interface InsightsListResponse {
  insights: Insight[];
  count: number;
}

export interface RunsListResponse {
  runs: InsightRun[];
}

/**
 * List insights for a project with optional filtering.
 */
export function fetchInsights(
  options: {
    category?: InsightCategory;
    status?: InsightStatus;
    runId?: string;
    limit?: number;
    offset?: number;
  } = {},
  projectId?: string,
): Promise<InsightsListResponse> {
  const params = new URLSearchParams();
  if (options.category) params.set("category", options.category);
  if (options.status) params.set("status", options.status);
  if (options.runId) params.set("runId", options.runId);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return api<InsightsListResponse>(withProjectId(`/insights${suffix}`, projectId));
}

/**
 * Get a single insight by ID.
 */
export function fetchInsight(id: string, projectId?: string): Promise<Insight> {
  return api<Insight>(withProjectId(`/insights/${encodeURIComponent(id)}`, projectId));
}

/**
 * Update an insight.
 */
export function updateInsight(
  id: string,
  updates: {
    title?: string;
    content?: string | null;
    category?: InsightCategory;
    status?: InsightStatus;
  },
  projectId?: string,
): Promise<Insight> {
  return api<Insight>(withProjectId(`/insights/${encodeURIComponent(id)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/**
 * Delete an insight.
 */
export function deleteInsight(id: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/insights/${encodeURIComponent(id)}`, projectId), {
    method: "DELETE",
  });
}

/**
 * Dismiss an insight (set status to dismissed).
 */
export function dismissInsight(id: string, projectId?: string): Promise<Insight> {
  return api<Insight>(withProjectId(`/insights/${encodeURIComponent(id)}/dismiss`, projectId), {
    method: "POST",
  });
}

/**
 * Archive an insight (set status to archived).
 */
export function archiveInsight(id: string, projectId?: string): Promise<Insight> {
  return api<Insight>(withProjectId(`/insights/${encodeURIComponent(id)}/archive`, projectId), {
    method: "POST",
  });
}

/**
 * Unarchive an insight (set status back to confirmed).
 */
export function unarchiveInsight(id: string, projectId?: string): Promise<Insight> {
  return api<Insight>(withProjectId(`/insights/${encodeURIComponent(id)}/unarchive`, projectId), {
    method: "POST",
  });
}

/**
 * Trigger a manual insight generation run.
 */
export function triggerInsightRun(
  trigger: InsightRunTrigger = "manual",
  inputMetadata?: InsightRun["inputMetadata"],
  projectId?: string,
  modelProvider?: string,
  modelId?: string,
  thinkingLevel?: string,
): Promise<InsightRun> {
  const body: Record<string, unknown> = { trigger, inputMetadata };
  if (modelProvider) body.modelProvider = modelProvider;
  if (modelId) body.modelId = modelId;
  if (thinkingLevel) body.thinkingLevel = thinkingLevel;
  return api<InsightRun>(withProjectId("/insights/run", projectId), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * List insight generation runs.
 */
export function fetchInsightRuns(projectId?: string): Promise<RunsListResponse> {
  return api<RunsListResponse>(withProjectId("/insights/runs", projectId));
}

/**
 * Get a single insight run by ID.
 */
export function fetchInsightRun(id: string, projectId?: string): Promise<InsightRun> {
  return api<InsightRun>(withProjectId(`/insights/runs/${encodeURIComponent(id)}`, projectId));
}

/**
 * Get data needed to create a task from an insight.
 */
export function getInsightCreateTaskData(
  id: string,
  projectId?: string,
): Promise<{
  success: boolean;
  insight: Insight;
  suggestedTitle: string;
  suggestedDescription: string;
}> {
  return api(withProjectId(`/insights/${encodeURIComponent(id)}/create-task`, projectId), {
    method: "POST",
  });
}

// ── Research API ────────────────────────────────────────────────────────────

export interface EvalsListOptions {
  q?: string;
  runId?: string;
  scoreMin?: number;
  scoreMax?: number;
  limit?: number;
  offset?: number;
}

export function listEvals(options: EvalsListOptions = {}, projectId?: string): Promise<{ results: EvalTaskResult[]; count: number }> {
  const params = new URLSearchParams();
  if (options.q) params.set("q", options.q);
  if (options.runId) params.set("runId", options.runId);
  if (options.scoreMin !== undefined) params.set("scoreMin", String(options.scoreMin));
  if (options.scoreMax !== undefined) params.set("scoreMax", String(options.scoreMax));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return api<{ results: EvalTaskResult[]; count: number }>(withProjectId(`/evals${suffix}`, projectId));
}

export function getEval(id: string, projectId?: string): Promise<{ result: EvalTaskResult }> {
  return api<{ result: EvalTaskResult }>(withProjectId(`/evals/${encodeURIComponent(id)}`, projectId));
}

export function listEvalRuns(projectId?: string): Promise<{ runs: EvalRun[] }> {
  return api<{ runs: EvalRun[] }>(withProjectId("/evals/runs", projectId));
}

export interface CreateResearchRunInput {
  query: string;
  providers: ResearchProviderOption[];
  githubRepo?: string;
  githubIssueNumber?: number;
  includeLocalDocs?: boolean;
  enableSynthesis?: boolean;
  maxResults?: number;
  depth?: "shallow" | "normal" | "deep";
}

export function listResearchRuns(
  options: { q?: string; status?: ResearchRunStatus; limit?: number } = {},
  projectId?: string,
): Promise<ResearchRunsResponse> {
  const params = new URLSearchParams();
  if (options.q) params.set("q", options.q);
  if (options.status) params.set("status", options.status);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return api<ResearchRunsResponse>(withProjectId(`/research/runs${suffix}`, projectId));
}

export function createResearchRun(input: CreateResearchRunInput, projectId?: string): Promise<ResearchRunResponse> {
  return api<ResearchRunResponse>(withProjectId("/research/runs", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getResearchRun(id: string, projectId?: string): Promise<ResearchRunResponse> {
  return api<ResearchRunResponse>(withProjectId(`/research/runs/${encodeURIComponent(id)}`, projectId));
}

export type ResearchActionErrorCode =
  | "FEATURE_DISABLED"
  | "MISSING_CREDENTIALS"
  | "PROVIDER_UNAVAILABLE"
  | "RATE_LIMITED"
  | "PROVIDER_TIMEOUT"
  | "RUN_CANCELLED"
  | "RETRY_EXHAUSTED"
  | "INVALID_TRANSITION"
  | "NON_RETRYABLE_PROVIDER_ERROR"
  | "INTERNAL_ERROR";

export interface ResearchActionError extends ApiRequestError {
  researchCode: ResearchActionErrorCode;
  setupHint?: string;
  retryable?: boolean;
}

function asResearchActionError(error: unknown): never {
  if (error instanceof ApiRequestError) {
    const codeCandidate = error.details?.code;
    const code = typeof codeCandidate === "string" ? codeCandidate : "INTERNAL_ERROR";
    const setupHint = typeof error.details?.setupHint === "string" ? error.details.setupHint : undefined;
    const retryable = typeof error.details?.retryable === "boolean" ? error.details.retryable : undefined;
    const enriched = error as ResearchActionError;
    enriched.researchCode = code as ResearchActionErrorCode;
    enriched.setupHint = setupHint;
    enriched.retryable = retryable;
    throw enriched;
  }
  throw error;
}

export async function cancelResearchRun(id: string, projectId?: string): Promise<{ run: ResearchRunDetail }> {
  try {
    return await api<{ run: ResearchRunDetail }>(withProjectId(`/research/runs/${encodeURIComponent(id)}/cancel`, projectId), {
      method: "POST",
    });
  } catch (error) {
    asResearchActionError(error);
  }
}

export async function retryResearchRun(id: string, projectId?: string): Promise<{ run: ResearchRunDetail }> {
  try {
    return await api<{ run: ResearchRunDetail }>(withProjectId(`/research/runs/${encodeURIComponent(id)}/retry`, projectId), {
      method: "POST",
    });
  } catch (error) {
    asResearchActionError(error);
  }
}

export function exportResearchRun(
  id: string,
  format: "markdown" | "json" | "html",
  projectId?: string,
): Promise<{ format: string; content: string; filename: string }> {
  return api<{ format: string; content: string; filename: string }>(
    withProjectId(`/research/runs/${encodeURIComponent(id)}/export?format=${encodeURIComponent(format)}`, projectId),
  );
}

export function createTaskFromResearchRun(
  id: string,
  input: { findingId?: string; title?: string; description?: string; priority?: "low" | "normal" | "high" | "urgent"; attachExport?: boolean },
  projectId?: string,
): Promise<{ task: Task; documentKey: string; attachmentFilename?: string }> {
  const findingId = input.findingId ?? "finding-1";
  return api<{ task: Task; documentKey: string; attachmentFilename?: string }>(
    withProjectId(`/research/runs/${encodeURIComponent(id)}/findings/${encodeURIComponent(findingId)}/task`, projectId),
    {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        description: input.description,
        priority: input.priority,
        attachExport: input.attachExport,
      }),
    },
  );
}

export function attachResearchRunToTask(
  id: string,
  input: { findingId?: string; taskId: string; attachExport?: boolean },
  projectId?: string,
): Promise<{ taskId: string; documentKey: string; revision: number; attachmentFilename?: string }> {
  const findingId = input.findingId ?? "finding-1";
  return api<{ taskId: string; documentKey: string; revision: number; attachmentFilename?: string }>(
    withProjectId(
      `/research/runs/${encodeURIComponent(id)}/findings/${encodeURIComponent(findingId)}/tasks/${encodeURIComponent(input.taskId)}/enrich`,
      projectId,
    ),
    {
      method: "POST",
      body: JSON.stringify({
        attachExport: input.attachExport,
      }),
    },
  );
}

export function getResearchAvailability(projectId?: string): Promise<ResearchAvailability> {
  return listResearchRuns({}, projectId).then((response) => response.availability);
}

export interface ResearchStatsResponse {
  total: number;
  byStatus: Record<ResearchRunStatus, number>;
}

export function getResearchStats(projectId?: string): Promise<ResearchStatsResponse> {
  return api<ResearchStatsResponse>(withProjectId("/research/stats", projectId));
}

// ── System Panel (Command Center → System) ──────────────────────────────────

/*
FNXC:SystemPanel 2026-07-12-11:35:
Typed client for the /api/system operator controls: capability discovery,
in-place restart, rebuild jobs with streamed output, engine/agent restarts,
plugin reload, and the host-process log viewer.
*/

/*
FNXC:SystemPanelFnBinary 2026-07-15-09:54:
Job snapshots cover rebuild scopes and the fn-binary link-local / use-global
actions that stream into the same System panel log viewer.
*/
export interface SystemRebuildJobSnapshot {
  id: string;
  kind: "rebuild" | "fn-binary";
  scope: "app" | "full" | "plugins" | "link-local" | "use-global";
  restartAfter: boolean;
  status: "running" | "succeeded" | "failed";
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  error?: string;
  restartScheduled?: boolean;
  pluginsReloaded?: string[];
  droppedLines: number;
  lineCount: number;
  lines?: SystemRebuildJobLine[];
}

export interface SystemRebuildJobLine {
  i: number;
  ts: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export interface SystemInfoResponse {
  supervised: boolean;
  restartSupported: boolean;
  rebuildSupported: boolean;
  /** True when the host is a Fusion source checkout (dev) — can build & link local fn. */
  fnBinaryLinkLocalSupported?: boolean;
  /** Always true when the route is wired; UI may still disable while a job runs. */
  fnBinaryUseGlobalSupported?: boolean;
  sourceWorkspaceRoot?: string;
  logsSupported: boolean;
  engineAvailable: boolean;
  pluginReloadSupported: boolean;
  pid: number;
  uptimeSeconds: number;
  nodeVersion: string;
  platform: string;
  arch: string;
  memoryRssBytes: number;
  activeRebuild: SystemRebuildJobSnapshot | null;
  lastRebuild: SystemRebuildJobSnapshot | null;
}

export interface SystemLogEntryDto {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  prefix?: string;
}

export function fetchSystemInfo(): Promise<SystemInfoResponse> {
  return api<SystemInfoResponse>("/system/info");
}

export function requestSystemRestart(reason?: string): Promise<{ scheduled: boolean }> {
  return api<{ scheduled: boolean }>("/system/restart", {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function startSystemRebuild(
  scope: "app" | "full" | "plugins",
  restart?: boolean,
): Promise<SystemRebuildJobSnapshot> {
  return api<SystemRebuildJobSnapshot>("/system/rebuild", {
    method: "POST",
    body: JSON.stringify({ scope, restart }),
  });
}

/*
FNXC:SystemPanelFnBinary 2026-07-15-09:54:
Client wrappers for System panel fn-binary actions. Both return a job snapshot
that the panel streams via /system/jobs/:id/stream (same path as rebuild).
*/
export function startFnBinaryLinkLocal(): Promise<SystemRebuildJobSnapshot> {
  return api<SystemRebuildJobSnapshot>("/system/fn-binary/link-local", { method: "POST" });
}

export function startFnBinaryUseGlobal(): Promise<SystemRebuildJobSnapshot> {
  return api<SystemRebuildJobSnapshot>("/system/fn-binary/use-global", { method: "POST" });
}

export function fetchCurrentSystemRebuild(): Promise<{ job: SystemRebuildJobSnapshot | null }> {
  return api<{ job: SystemRebuildJobSnapshot | null }>("/system/rebuild/current");
}

export function restartSystemEngines(): Promise<{
  restarted: string[];
  failed: Array<{ projectId: string; error: string }>;
}> {
  return api("/system/engine/restart", { method: "POST" });
}

export function restartAllSystemAgents(projectId?: string): Promise<{
  restarted: string[];
  failed: Array<{ agentId: string; error: string }>;
}> {
  return api(withProjectId("/system/agents/restart-all", projectId), { method: "POST" });
}

export function reloadAllSystemPlugins(): Promise<{
  reloaded: string[];
  failed: Array<{ id: string; error: string }>;
}> {
  return api("/system/plugins/reload-all", { method: "POST" });
}

export function fetchSystemLogs(limit?: number): Promise<{ entries: SystemLogEntryDto[] }> {
  const suffix = limit ? `?limit=${limit}` : "";
  return api<{ entries: SystemLogEntryDto[] }>(`/system/logs${suffix}`);
}
