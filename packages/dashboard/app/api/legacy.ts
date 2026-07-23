import type {
  CommitAssociationDiffBackfillReport,
} from "@fusion/core";
// Consumers import backfill report types from the legacy API barrel.
export type { CommitAssociationDiffBackfillReport };

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


// Re-export skills types so hooks/components keep stable import paths via this barrel.
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

/*
 * FNXC:CodeOrganization 2026-07-20-14:00:
 * Preserve legacy `task-steer` imports while implementations live in task-steer.js.
 */
export {
  addSteeringComment,
  requestSpecRevision,
  rebuildTaskSpec,
  refineTask,
} from "./task-steer.js";

/*
 * FNXC:CodeOrganization 2026-07-20-14:00:
 * Preserve legacy `models-usage` imports while implementations live in models-usage.js.
 */
export {
  fetchModels,
  fetchUsageData,
} from "./models-usage.js";
export type {
  ModelInfo,
  ModelsResponse,
  UsagePace,
  UsageWindow,
  ProviderUsage,
} from "./models-usage.js";

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

/*
 * FNXC:CodeOrganization 2026-07-20-14:00:
 * Preserve legacy `planning` imports while implementations live in planning.js.
 */
export {
  startPlanning,
  createPlanningDraft,
  startPlanningStreaming,
  validatePlanningSession,
  updatePlanningSessionTitle,
  respondToPlanning,
  rewindPlanningSession,
  retryPlanningSession,
  stopPlanningGeneration,
  cancelPlanning,
  startAgentOnboardingStreaming,
  respondToAgentOnboarding,
  retryAgentOnboardingSession,
  stopAgentOnboardingGeneration,
  cancelAgentOnboarding,
  createTaskFromPlanning,
  startPlanningBreakdown,
  createTasksFromPlanning,
  getPlanningStreamUrl,
  getAgentOnboardingStreamUrl,
  connectAgentOnboardingStream,
  connectPlanningStream,
} from "./planning.js";
export type {
  PlanningSession,
  PlanningResponse,
  PlanningContextualComment,
  PlanningStreamEvent,
  AgentOnboardingSummary,
  OnboardingMode,
  ThinkingLevel,
  ExistingAgentOnboardingConfig,
  AgentOnboardingStreamEvent,
} from "./planning.js";

// FNXC:CodeOrganization 2026-07-19-12:00: SSE reconnect lives in event-source.ts.
export type { StreamConnectionState, ResilientEventSourceOptions, ResilientEventHandlers } from "./event-source.js";
export { createResilientEventSource } from "./event-source.js";

/*
 * FNXC:CodeOrganization 2026-07-20-14:00:
 * Preserve legacy `dev-server` imports while implementations live in dev-server.js.
 */
export {
  fetchDevServerCandidates,
  detectDevServer,
  fetchDevServerConfig,
  saveDevServerConfig,
  fetchDevServerStatus,
  fetchDevServerLogHistory,
  startDevServer,
  stopDevServer,
  restartDevServer,
  setDevServerPreviewUrl,
  getDevServerLogsStreamUrl,
  fetchDevServers,
  createDevServer,
  fetchDevServer,
  startDevServerById,
  stopDevServerById,
  restartDevServerById,
  deleteDevServer,
  fetchDevServerLogs,
  fetchDevServerPreview,
  setDevServerPreviewUrlById,
  detectDevServerCommands,
  getDevServerSessionLogsStreamUrl,
} from "./dev-server.js";
export type {
  DevServerCandidate,
  DetectedCandidate,
  DevServerState,
  DevServerStatus,
  DevServerStartInput,
  DevServerConfig,
  DevServerLogHistoryEntry,
  DevServerLogHistoryResponse,
  FetchDevServerLogHistoryOptions,
  DetectedDevServerCommand,
  DevServerLogEntry,
  DevServerPreviewResponse,
  DevServerRuntime,
  DevServerSessionConfig,
  DevServerSession,
  FetchDevServerLogsOptions,
} from "./dev-server.js";

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
  isAgentHeartbeatEnabled,
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
  withAgentHeartbeatEnabled,
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

/*
 * FNXC:CodeOrganization 2026-07-20-14:00:
 * Preserve legacy `ai-summarize` imports while implementations live in ai-summarize.js.
 */
export {
  summarizeTitle,
} from "./ai-summarize.js";
export type {
  SummarizeTitleResponse,
} from "./ai-summarize.js";

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
/*
 * FNXC:CodeOrganization 2026-07-20-14:00:
 * Preserve legacy `mission-interview` imports while implementations live in mission-interview.js.
 */
export {
  startMissionInterview,
  respondToMissionInterview,
  retryMissionInterviewSession,
  cancelMissionInterview,
  fetchMissionInterviewDrafts,
  discardMissionInterviewDraft,
  createMissionFromInterview,
  connectMissionInterviewStream,
  startMilestoneInterview,
  respondToMilestoneInterview,
  connectMilestoneInterviewStream,
  applyMilestoneInterview,
  skipMilestoneInterview,
  startSliceInterview,
  respondToSliceInterview,
  connectSliceInterviewStream,
  applySliceInterview,
  skipSliceInterview,
  previewEnrichedDescription,
} from "./mission-interview.js";
export type {
  MissionPlanFeature,
  MissionPlanSlice,
  MissionPlanMilestone,
  MissionPlanSummary,
  MissionInterviewResponse,
  TargetInterviewSummary,
  TargetInterviewResponse,
} from "./mission-interview.js";

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
