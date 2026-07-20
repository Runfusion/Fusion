import type { SubtaskItem, PlanningSubtaskDraft } from "./ai-text.js";
import type { AgentCapability } from "@fusion/core";
import type {
  Task,
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

/*
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * Preserve legacy `provider-status` imports while implementations live in provider-status.ts.
 */
export {
  addCustomProvider,
  cancelProviderLogin,
  clearApiKey,
  createCustomProvider,
  deleteCustomProvider,
  fetchAuthStatus,
  fetchClaudeCliStatus,
  fetchCursorCliStatus,
  fetchCustomProviders,
  fetchDroidCliStatus,
  fetchFnBinaryStatus,
  fetchGrokCliStatus,
  fetchHermesProfiles,
  fetchHermesStatus,
  fetchLlamaCppStatus,
  fetchOmpCliStatus,
  fetchOpenClawStatus,
  fetchPaperclipAgents,
  fetchPaperclipCliAgents,
  fetchPaperclipCliCompanies,
  fetchPaperclipCliDiscovery,
  fetchPaperclipCliStatus,
  fetchPaperclipCompanies,
  fetchPaperclipStatus,
  installFnBinary,
  loginProvider,
  logoutProvider,
  mintPaperclipApiKey,
  probeProviderModels,
  refreshProviderModels,
  saveApiKey,
  setClaudeCliEnabled,
  setCursorCliBinaryPath,
  setCursorCliEnabled,
  setDroidCliEnabled,
  setGrokCliBinaryPath,
  setGrokCliEnabled,
  setLlamaCppEnabled,
  setOmpCliBinaryPath,
  setOmpCliEnabled,
  submitProviderManualCode,
  updateCustomProvider,
} from "./provider-status.js";
export type {
  AuthProvider,
  ClaudeCliStatus,
  CursorCliStatus,
  CustomProvider,
  CustomProviderConfig,
  CustomProviderModelInput,
  DroidCliStatus,
  FnBinaryInstallResponse,
  FnBinaryInstallResult,
  FnBinaryStatus,
  GitCliStatus,
  GrokCliStatus,
  HermesProfileSummary,
  HermesProviderStatus,
  LlamaCppStatus,
  ManualOAuthCodeInfo,
  OAuthDeviceCodeInfo,
  OmpCliStatus,
  OpenClawProviderStatus,
  PaperclipAgentSummary,
  PaperclipCliDiscoveryFailure,
  PaperclipCliDiscoveryResult,
  PaperclipCliDiscoverySuccess,
  PaperclipCompanySummary,
  PaperclipConnectionStatus,
  PaperclipMintKeyRequest,
  PaperclipMintKeyResult,
  PaperclipProviderStatus,
  ProbeModelResult,
  ProbeModelsParams,
  ProbeModelsResponse,
  RefreshProviderModelsResponse,
  RuntimeBinaryStatus,
} from "./provider-status.js";

/*
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * Preserve legacy `github-import` imports while implementations live in github-import.ts.
 */
export {
  apiAddGitHubIssueComment,
  apiBatchImportGitHubIssues,
  apiCloseGitHubIssue,
  apiFetchGitHubIssueDetail,
  apiFetchGitHubIssues,
  apiFetchGitHubPullDetail,
  apiFetchGitHubPulls,
  apiImportGitHubComment,
  apiImportGitHubIssue,
  apiImportGitHubPull,
} from "./github-import.js";
export type {
  BatchImportResult,
  GitHubCommentDetail,
  GitHubIssue,
  GitHubIssueDetail,
  GitHubPull,
  GitHubPullDetail,
} from "./github-import.js";

/*
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * Preserve legacy `gitlab-import` imports while implementations live in gitlab-import.ts.
 */
export {
  apiBatchImportGitLab,
  apiFetchGitLabGroupIssues,
  apiFetchGitLabMergeRequests,
  apiFetchGitLabProjectIssues,
  apiImportGitLabGroupIssue,
  apiImportGitLabMergeRequest,
  apiImportGitLabProjectIssue,
} from "./gitlab-import.js";
export type {
  GitLabImportItem,
} from "./gitlab-import.js";

/*
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * Preserve legacy `git` imports while implementations live in git.ts.
 */
export {
  addGitRemote,
  applyStash,
  checkoutBranch,
  createBranch,
  createCommit,
  createPr,
  createStash,
  createTerminalSession,
  deleteBranch,
  discardChanges,
  dropStash,
  execTerminalCommand,
  fetchAheadCommits,
  fetchBatchStatus,
  fetchBranchCommits,
  fetchCommitDiff,
  fetchFileChanges,
  fetchGitBranches,
  fetchGitCommits,
  fetchGitFileDiff,
  fetchGitRemoteBranches,
  fetchGitRemotes,
  fetchGitRemotesDetailed,
  fetchGitStashList,
  fetchGitStatus,
  fetchGitWorktrees,
  fetchIssueStatus,
  fetchPrChecks,
  fetchPrOptions,
  fetchPrPreflight,
  fetchPrReviews,
  fetchPrStatus,
  fetchRemote,
  fetchRemoteCommits,
  fetchStashDiff,
  fetchUnstagedDiff,
  generatePrMetadata,
  getTerminalSession,
  getTerminalStreamUrl,
  killPtyTerminalSession,
  killTerminalSession,
  listTerminalSessions,
  mergePr,
  pullBranch,
  pushBranch,
  pushPrBranch,
  reclaimPrConflict,
  refreshIssueStatus,
  refreshPrStatus,
  removeGitRemote,
  renameGitRemote,
  resolvePrConflicts,
  setAutoMergeOnGreen,
  stageFiles,
  unlinkPr,
  unstageFiles,
  updateGitRemoteUrl,
} from "./git.js";
export type {
  BatchStatusEntry,
  BatchStatusResult,
  CreatePrParams,
  GitBranch,
  GitCommit,
  GitFetchResult,
  GitFileChange,
  GitPullResult,
  GitPushResult,
  GitRemote,
  GitRemoteDetailed,
  GitStash,
  GitStatus,
  GitWorktree,
  IssueInfo,
  PrCheckStatus,
  PrChecksResponse,
  PrInfo,
  PrMergeResponse,
  PrMetadataResponse,
  PrOptionsLabel,
  PrOptionsResponse,
  PrOptionsUser,
  PrPreflightChangedFile,
  PrPreflightCommit,
  PrPreflightResponse,
  PrRefreshEntry,
  PrRefreshResponse,
  PrReviewThreadItem,
  PrReviewsResponse,
  PrStatusResponse,
  PtyTerminalSession,
  PtyTerminalSessionInfo,
  PushPrBranchResponse,
  PushPrBranchResult,
  ResolvePrConflictsResponse,
  ResolvePrConflictsResult,
  TerminalExecResponse,
  TerminalExitEvent,
  TerminalOutputEvent,
  TerminalSession,
} from "./git.js";

/*
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * Preserve legacy `workspace-files` imports while implementations live in workspace-files.ts.
 */
export {
  copyFile,
  createWorkspaceDirectory,
  createWorkspaceFile,
  deleteFile,
  downloadFileUrl,
  downloadZipUrl,
  fetchFileContent,
  fetchFileList,
  fetchRecentIssues,
  fetchWorkspaceFileContent,
  fetchWorkspaceFileList,
  fetchWorkspaces,
  moveFile,
  renameFile,
  saveFileContent,
  saveWorkspaceFileContent,
  searchFiles,
} from "./workspace-files.js";
export type {
  FileContentResponse,
  FileListResponse,
  FileNode,
  FileOperationResponse,
  FileSearchResult,
  IssueMentionItem,
  SaveFileResponse,
  WorkspaceListResponse,
  WorkspaceTaskInfo,
} from "./workspace-files.js";

// --- Planning Mode API ---

/** Planning session state returned from API */
export interface PlanningSession {
  sessionId: string;
  currentQuestion: PlanningQuestion | null;
  summary: PlanningSummary | null;
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
  planningOptions?: { clarificationEnabled?: boolean },
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

/*
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * Preserve legacy `run-audit` imports while implementations live in run-audit.ts.
 */
export {
  acceptTaskReview,
  addressPrFeedback,
  assignTask,
  assignTaskToUser,
  fetchAgentChildren,
  fetchAgentEmployees,
  fetchAgentRunAudit,
  fetchAgentRunTimeline,
  fetchAgentStats,
  fetchAgentTasks,
  fetchChainOfCommand,
  fetchOrgTree,
  fetchTaskReview,
  fetchTaskReviewData,
  refreshTaskReview,
  refreshTaskReviewData,
  resolveAgent,
  returnTaskToAgent,
  reviseTaskReviewItems,
} from "./run-audit.js";
export type {
  NormalizedRunAuditEvent,
  RunAuditDomainFilter,
  RunAuditFilters,
  RunAuditResponse,
  RunTimelineResponse,
  TimelineEntry,
} from "./run-audit.js";

/*
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * Preserve legacy `agent-import-generation` imports while implementations live in agent-import-generation.ts.
 */
export {
  cancelAgentGeneration,
  createBackup,
  exportSettings,
  fetchBackups,
  fetchCompanies,
  generateAgentSpec,
  getAgentGenerationSession,
  importAgents,
  importSettings,
  startAgentGeneration,
} from "./agent-import-generation.js";
export type {
  AgentGenerationSession,
  AgentGenerationSpec,
  AgentImportResult,
  BackupCreateResponse,
  BackupInfo,
  BackupListResponse,
  CompaniesCatalogResponse,
  CompanyEntry,
  SettingsExportData,
  SettingsImportResponse,
} from "./agent-import-generation.js";

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

/*
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * Preserve legacy `task-diff` imports while implementations live in task-diff.ts.
 */
export {
  fetchTaskCommitAssociations,
  fetchTaskDiff,
  fetchTaskFileDiffs,
} from "./task-diff.js";
export type {
  TaskCommitAssociationRow,
  TaskCommitAssociationsResponse,
  TaskDiff,
  TaskFileDiff,
} from "./task-diff.js";

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
