export { COLUMNS, DEFAULT_COLUMN, isColumn, normalizeColumn, COLUMN_LABELS, COLUMN_DESCRIPTIONS, VALID_TRANSITIONS, DEFAULT_SETTINGS, DEFAULT_GLOBAL_SETTINGS, DEFAULT_PROJECT_SETTINGS, GLOBAL_SETTINGS_KEYS, PROJECT_SETTINGS_KEYS, isGlobalSettingsKey, isProjectSettingsKey, THINKING_LEVELS, THEME_MODES, COLOR_THEMES, WORKFLOW_STEP_TEMPLATES, AGENT_PERMISSIONS, PERMANENT_AGENT_ACTION_CATEGORIES, AGENT_PERMISSION_POLICY_ACTION_CATEGORIES, AGENT_PROVISIONING_APPROVAL_MODES, AGENT_PERMISSION_POLICY_PRESET_IDS, LEGACY_AGENT_PERMISSION_POLICY_ACTION_CATEGORY_ALIASES, APPROVAL_REQUEST_STATUSES, APPROVAL_REQUEST_AUDIT_EVENT_TYPES, normalizeApprovalRequestActionCategory, isValidApprovalRequestTransition, agentToConfigSnapshot, diffConfigSnapshots, isEphemeralAgent, hasAgentIdentity, CheckoutConflictError, DEFAULT_HEARTBEAT_PROCEDURE_PATH, getDefaultHeartbeatProcedurePath, EXECUTION_MODES, DEFAULT_EXECUTION_MODE, TASK_PRIORITIES, DEFAULT_TASK_PRIORITY, HIGH_FANOUT_BLOCKER_TODO_THRESHOLD, STALE_HIGH_FANOUT_BLOCKER_AGE_THRESHOLD_MS, DASHBOARD_USER_ID, normalizeMessageParticipant, validateMessageMetadata, validateDockerNodeConfig, sanitizeDockerNodeConfigForResponse, normalizeMergeConflictStrategy, normalizeMergeStrategyOverlapBehavior, buildResearchDocumentKey, REPO_OVERRIDE_RE, SHARED_STATE_SNAPSHOT_VERSION } from "./types.js";
export type { Column, IssueInfo, IssueState, TaskSourceIssue, PrInfo, PrStatus, Task, TaskTokenUsage, TaskAttachment, TaskComment, TaskCommentInput, TaskDocument, TaskDocumentRevision, TaskDocumentCreateInput, TaskDocumentWithTask, TaskCreateInput, MeshReplicatedTaskCreatePayload, MeshReplicatedTaskApplyResult, TaskSource, SourceType, TaskDetail, InboxTask, TodoList, TodoItem, TodoListCreateInput, TodoListUpdateInput, TodoItemCreateInput, TodoItemUpdateInput, TodoListWithItems, AgentLogEntry, AgentLogType, AgentRole, BoardConfig, DistributedTaskIdReserveInput, DistributedTaskIdReserveResult, DistributedTaskIdCommitInput, DistributedTaskIdCommitResult, DistributedTaskIdAbortInput, DistributedTaskIdAbortResult, DistributedTaskIdStateInput, DistributedTaskIdStateResult, AutostashOrphanRecord, AutostashOutcome, MergeDetails, MergeResult, MergeConflictStrategy, CanonicalMergeConflictStrategy, MergeStrategyOverlapBehavior, DirectMergeCommitStrategy, Settings, GlobalSettings, ProjectSettings, WebSearchBackend, ResearchEnabledSources, ResearchGlobalDefaults, ResearchProjectLimits, ResearchProjectSettings, EvalFollowUpPolicy, EvalProjectSettings, ResolvedEvalSettings, SettingsScope, DaemonTokenSettings, TaskStep, StepStatus, TaskLogEntry, RunMutationContext, ActivityLogEntry, ActivityEventType, ThinkingLevel, ThemeMode, ColorTheme, ExecutionMode, TaskPriority, UnavailableNodePolicy, PlanningQuestion, PlanningSummary, PlanningResponse, PlanningQuestionType, ArchivedTaskEntry, BatchStatusRequest, BatchStatusResponse, BatchStatusEntry, BatchStatusResult, ModelPreset, WorkflowStep, WorkflowStepMode, WorkflowStepPhase, WorkflowStepInput, WorkflowStepResult, WorkflowStepTemplate, Agent, OrgTreeNode, AgentState, AgentDetail, AgentCreateInput, AgentUpdateInput, AgentApiKey, AgentApiKeyCreateResult, AgentCapability, AgentPromptTemplate, AgentPromptsConfig, AgentPermission, PermanentAgentActionCategory, PermanentAgentSensitiveActionCategory, PermanentAgentGatingContext, AgentPermissionPolicy, AgentPermissionPolicyRules, AgentPermissionPolicyActionCategory, AgentProvisioningApprovalMode, LegacyAgentPermissionPolicyActionCategory, ApprovalRequestActionCategoryInput, ApprovalRequestActionCategory, AgentPermissionPolicyDisposition, AgentPermissionPolicyPresetId, ApprovalRequestStatus, ApprovalRequestAuditEventType, ApprovalRequestActorSnapshot, ApprovalRequestTargetAction, ApprovalRequestAuditEvent, ApprovalRequest, ApprovalRequestCreateInput, ApprovalRequestDecisionInput, ApprovalRequestCompletionInput, ApprovalRequestListInput, TaskAssignSource, AgentAccessState, AgentHeartbeatConfig, AgentBudgetConfig, AgentBudgetStatus, InstructionsBundleConfig, MessageResponseMode, AgentHeartbeatEvent, AgentHeartbeatRun, BlockedStateSnapshot, HeartbeatInvocationSource, AgentTaskSession, AgentRating, AgentRatingSummary, AgentRatingInput, AgentConfigSnapshot, RevisionFieldDiff, AgentConfigRevision, AgentStats, ReflectionTrigger, ReflectionMetrics, AgentReflection, AgentPerformanceSummary, NtfyNotificationEvent, NotificationEvent, NotificationPayload, NotificationProviderConfig, CustomProvider, SteeringComment, ParticipantType, MessageType, Message, MessageCreateInput, MessageFilter, MessageMetadata, MessageReplyReference, Mailbox, CheckoutLease, RunAuditDomain, RunAuditEvent, RunAuditEventInput, RunAuditEventFilter } from "./types.js";
export { AGENT_VALID_TRANSITIONS } from "./types.js";
export type { TaskReviewData, TaskReviewSummary, TaskReviewItem } from "./types.js";
export type {
  TaskCommitAssociation,
  TaskCommitAssociationConfidence,
  TaskCommitAssociationMatchSource,
} from "./types.js";
export * from "./mesh-replication-protocol.js";
export * from "./mesh-task-replication.js";
export * from "./shared-mesh-state.js";
export {
  BUILTIN_AGENT_PROMPTS,
  resolveAgentPrompt,
  getAvailableTemplates,
  getTemplatesForRole,
} from "./agent-prompts.js";

// ── Engine wiring (set by @fusion/engine at module load) ────────────
export {
  setCreateFnAgent,
  getFnAgent,
  setCreateAiSessionFactory,
  getCreateAiSessionFactory,
  type AgentMessage,
} from "./ai-engine-loader.js";

// ── Prompt Overrides ─────────────────────────────────────────────────
export {
  PROMPT_KEY_CATALOG,
  resolvePrompt,
  resolveRolePrompts,
  hasRoleOverrides,
  getOverriddenKeys,
  clearOverrides,
  getPromptKeyMetadata,
  getPromptKeysForRole,
  isValidPromptKey,
  isValidPromptOverrideMap,
  assertValidPromptOverrideMap,
} from "./prompt-overrides.js";
export type {
  PromptKey,
  PromptKeyMetadata,
  PromptKeyCatalog,
  PromptOverrideEntry,
  PromptOverrideMap,
} from "./prompt-overrides.js";
export {
  ROLE_DEFAULT_PERMISSIONS,
  normalizePermissions,
  computeAccessState,
  isValidPermission,
} from "./agent-permissions.js";
export {
  DEFAULT_AGENT_PERMISSION_POLICY_PRESET_ID,
  getBuiltInAgentPermissionPolicyPresets,
  resolveAgentPermissionPolicyPreset,
  normalizeAgentPermissionPolicyFromPreset,
  resolveEffectiveAgentPermissionPolicy,
  isAgentPermissionPolicyPresetId,
} from "./agent-permission-policy.js";
export type { BuiltInAgentPermissionPolicyPreset } from "./agent-permission-policy.js";
export { AgentStore, DEFAULT_AGENT_HEARTBEAT_INTERVAL_MS } from "./agent-store.js";
export type { AgentStoreEvents } from "./agent-store.js";
export {
  isImplementationTask,
  isExecutorRoleAgent,
  canAgentTakeImplementationTask,
  canAgentTakeImplementationTaskForExplicitRouting,
  canAgentTakeImplementationTaskForBacklogPickup,
  formatRoleMismatchReason,
} from "./agent-role-policy.js";
export { ReflectionStore } from "./reflection-store.js";
export type { ReflectionStoreEvents } from "./reflection-store.js";
export { MessageStore } from "./message-store.js";
export type { MessageStoreEvents } from "./message-store.js";
export { ApprovalRequestStore } from "./approval-request-store.js";
export {
  resolveAgentProvisioningPolicy,
  extractAgentProvisioningRequest,
} from "./agent-provisioning-policy.js";
export type {
  AgentProvisioningTool,
  AgentProvisioningPolicyInput,
  AgentProvisioningPolicyDecision,
} from "./agent-provisioning-policy.js";
export { TaskStore } from "./store.js";
export {
  STALLED_REVIEW_REENQUEUE_THRESHOLD,
  STALLED_REVIEW_INVALID_TRANSITION_THRESHOLD,
  STALLED_REVIEW_WINDOW_MS,
  STALLED_REVIEW_REENQUEUE_PATTERN,
  STALLED_REVIEW_INVALID_TRANSITION_PATTERN,
  detectStalledReview,
} from "./stalled-review-detector.js";
export type { StalledReviewSignal } from "./stalled-review-detector.js";
export {
  detectTaskIdIntegrityAnomalies,
} from "./task-id-integrity.js";
export type {
  TaskIdIntegrityAnomaly,
  TaskIdIntegrityAnomalyKind,
  TaskIdIntegrityReport,
} from "./task-id-integrity.js";
export {
  FUSION_TASK_LINEAGE_TRAILER_KEY,
  buildTaskLineageTrailer,
  classifyTaskCommitAssociationConfidence,
  generateTaskLineageId,
  normalizeTaskCommitAssociation,
  parseTaskLineageTrailer,
} from "./task-lineage.js";
export {
  createDistributedTaskIdAllocator,
  formatDistributedTaskId,
  resolveLocalNodeId,
  DistributedTaskIdError,
} from "./distributed-task-id.js";
export type { DistributedTaskIdAllocator } from "./distributed-task-id.js";
export { Database, createDatabase, toJson, toJsonNullable, fromJson } from "./db.js";
export { DatabaseSync } from "./sqlite-adapter.js";
export type { Statement, VacuumResult } from "./db.js";
export { ArchiveDatabase } from "./archive-db.js";
export { detectLegacyData, migrateFromLegacy, getMigrationStatus } from "./db-migrate.js";
export { GlobalSettingsStore, resolveGlobalDir } from "./global-settings.js";
export { isValidSqliteDatabaseFile } from "./sqlite-validation.js";
export { DaemonTokenManager, DAEMON_TOKEN_PREFIX, DAEMON_TOKEN_HEX_LENGTH, isDaemonTokenFormat } from "./daemon-token.js";
export { discoverPiExtensions, formatPiExtensionSource, getEnabledPiExtensionPaths, getFusionAgentDir, getFusionAgentSettingsPath, getLegacyPiAgentDir, getPiExtensionDiscoveryDirs, reconcileClaudeCliPaths, reconcileDroidCliPaths, resolvePiExtensionProjectRoot, updatePiExtensionDisabledIds } from "./pi-extensions.js";
export type { PiExtensionEntry, PiExtensionSettings, PiExtensionSource } from "./pi-extensions.js";
export { canTransition, getValidTransitions, resolveDependencyOrder } from "./board.js";
export { computeBlockerFanoutMap, BLOCKER_ESCALATION_COLUMNS, isStaleBlockedByBlocker } from "./blocker-fanout.js";
export type { BlockerFanoutEntry, BlockerEscalation, ComputeBlockerFanoutOptions } from "./blocker-fanout.js";
export {
  computeCapacityRisk,
  DEFAULT_CAPACITY_RISK_TODO_THRESHOLD,
} from "./capacity.js";
export type { CapacityRiskSignal } from "./capacity.js";
export {
  getTaskMergeBlocker,
  getTaskCompletionBlocker,
  isTaskReadyForMerge,
  resolveTaskMergeTarget,
  type MergeTargetResolution,
  type MergeTargetResolverOptions,
} from "./task-merge.js";
export {
  getInReviewStallReason,
  DEFAULT_STALE_MERGING_MIN_AGE_MS,
  DEFAULT_MAX_AUTO_MERGE_RETRIES,
} from "./in-review-stall.js";
export type { InReviewStallSignal, InReviewStallCode } from "./in-review-stall.js";
export {
  isGhAvailable, 
  isGhAuthenticated, 
  runGh, 
  runGhAsync, 
  runGhJson, 
  runGhJsonAsync, 
  getGhErrorMessage, 
  ensureGhAuth,
  parseRepoFromRemote,
  getCurrentRepo,
  type GhError,
} from "./gh-cli.js";
export {
  parseRepoSlug,
  isValidRepoSlug,
  resolveTaskGithubTracking,
} from "./github-tracking.js";
export type { RepoSlug, ResolvedTaskGithubTracking } from "./github-tracking.js";
export { AUTOMATION_PRESETS, MAX_RUN_HISTORY } from "./automation.js";
export type { ScheduleType, ScheduledTask, ScheduledTaskCreateInput, ScheduledTaskUpdateInput, AutomationRunResult, AutomationStepType, AutomationStep, AutomationStepResult } from "./automation.js";
export { AutomationStore } from "./automation-store.js";
export type { AutomationStoreEvents } from "./automation-store.js";
export { runCommandAsync } from "./run-command.js";
export type { RunCommandOptions, RunCommandResult } from "./run-command.js";
export {
  detectFnBinary,
  FN_NPM_PACKAGE,
  FN_INSTALL_NPM,
  FN_INSTALL_CURL,
  FN_NPX_INVOCATION,
} from "./fn-binary.js";
export type { FnBinaryStatus, FnBinaryName } from "./fn-binary.js";
export {
  validateNodeOverrideChange,
  type NodeOverrideValidationResult,
  type NodeOverrideBlockReason,
} from "./node-override-guard.js";
export {
  validateDirectMergeCommitStrategy,
  validateGithubAuthMode,
  validateGithubRepoSlug,
  validateUnavailableNodePolicy,
} from "./settings-validation.js";

// ── Routine System ───────────────────────────────────────────────────
export {
  MAX_ROUTINE_RUN_HISTORY,
  isCronTrigger,
  isWebhookTrigger,
  isApiTrigger,
  isManualTrigger,
} from "./routine.js";
export type {
  RoutineTriggerType,
  RoutineCronTrigger,
  RoutineWebhookTrigger,
  RoutineApiTrigger,
  RoutineManualTrigger,
  RoutineTrigger,
  RoutineCatchUpPolicy,
  RoutineExecutionPolicy,
  RoutineExecutionResult,
  Routine,
  RoutineCreateInput,
  RoutineUpdateInput,
} from "./routine.js";
export { RoutineStore } from "./routine-store.js";
export type { RoutineStoreEvents } from "./routine-store.js";

// ── Notification Provider System ────────────────────────────────
export type { NotificationProvider } from "./notification/provider.js";
export { NotificationDispatcher } from "./notification/dispatcher.js";
export type {
  NotificationDispatcherConfig,
  NotificationResult,
} from "./notification/types.js";
export { NOTIFICATION_EVENTS } from "./types.js";

// ── Plugin System ─────────────────────────────────────────────────────
export type {
  PluginManifest,
  PluginSettingSchema,
  PluginSettingType,
  PluginOnLoad,
  PluginOnUnload,
  PluginOnSchemaInit,
  PluginOnTaskCreated,
  PluginOnTaskMoved,
  PluginOnTaskCompleted,
  PluginOnError,
  PluginToolDefinition,
  PluginToolResult,
  PluginRouteDefinition,
  PluginRouteMethod,
  PluginRouteResponse,
  PluginRouteResult,
  PluginUiSurface,
  PluginUiSlotDefinition,
  PluginUiContributionSurface,
  PluginUiContributionWhen,
  PluginUiActionDescriptor,
  SettingsProviderCardContribution,
  SettingsConfigSectionContribution,
  OnboardingProviderCardContribution,
  OnboardingSetupHelpContribution,
  OnboardingProviderRecommendationContribution,
  PostOnboardingRecommendationContribution,
  PluginUiContributionDefinition,
  PluginUiContributionInputDefinition,
  PluginDashboardViewDefinition,
  PluginRuntimeManifestMetadata,
  PluginRuntimeFactory,
  PluginRuntimeRegistration,
  CliProviderType,
  CliProviderActionMetadata,
  CliProviderProbeResult,
  CliProviderModelDiscoveryResult,
  CliProviderRuntimeRegistration,
  CliProviderContribution,
  PluginContext,
  CreateAiSessionOptions,
  AiSessionResult,
  CreateAiSessionFactory,
  PluginLogger,
  PluginSkillContribution,
  PluginWorkflowStepContribution,
  PluginPromptSurface,
  PluginPromptContribution,
  PluginPromptContributions,
  ExecutorRuntimeTaskContext,
  ExecutorRuntimeEnvContribution,
  PluginExecutorRuntimeEnvHook,
  PluginSetupStatus,
  PluginSetupCheckResult,
  PluginSetupHooks,
  PluginSetupManifest,
  FusionPlugin,
  PluginState,
  PluginInstallation,
} from "./plugin-types.js";
export { validatePluginManifest, normalizePluginUiContributionSurface, normalizePluginUiContributionDefinition } from "./plugin-types.js";
export { PluginStore } from "./plugin-store.js";
export type { PluginStoreEvents, PluginRegistrationInput, PluginUpdateInput } from "./plugin-store.js";
export { PluginLoader } from "./plugin-loader.js";
export { scanPluginSecurity } from "./plugin-security-scan.js";
export type { PluginSecurityScanResult, PluginSecurityFinding } from "./plugin-security-scan.js";
export type {
  PluginLoaderOptions,
  PluginLoadedEvent,
  PluginUnloadedEvent,
  PluginReloadedEvent,
  PluginErrorEvent,
} from "./plugin-loader.js";
export {
  BackupManager,
  createBackupManager,
  generateBackupFilename,
  validateBackupSchedule,
  validateBackupRetention,
  validateBackupDir,
  runBackupCommand,
  syncBackupAutomation,
  syncBackupRoutine,
  BACKUP_SCHEDULE_NAME,
} from "./backup.js";
export type { BackupInfo, BackupOptions } from "./backup.js";
export {
  MemoryBackupManager,
  createMemoryBackupManager,
  runMemoryBackupCommand,
  validateMemoryBackupSchedule,
  MEMORY_BACKUP_SCHEDULE_NAME,
  syncMemoryBackupAutomation,
  syncMemoryBackupRoutine,
} from "./memory-backup.js";
export type { MemoryBackupInfo, MemoryBackupOptions } from "./memory-backup.js";
export {
  exportSettings,
  importSettings,
  validateImportData,
  generateExportFilename,
  readExportFile,
  writeExportFile,
} from "./settings-export.js";
export type {
  SettingsExportData,
  ExportSettingsOptions,
  ImportSettingsOptions,
  ImportResult,
} from "./settings-export.js";

// ── AI Summarization ─────────────────────────────────────────────────────

export {
  summarizeTitle,
  summarizeMergeCommit,
  summarizeCommitBody,
  summarizeCommitSubject,
  sanitizeCommitSubject,
  checkRateLimit,
  getRateLimitResetTime,
  validateDescription,
  SUMMARIZE_SYSTEM_PROMPT,
  MERGE_COMMIT_SUMMARIZE_SYSTEM_PROMPT,
  COMMIT_BODY_SYSTEM_PROMPT,
  COMMIT_SUBJECT_SYSTEM_PROMPT,
  MAX_COMMIT_SUBJECT_LENGTH,
  DEFAULT_COMMIT_SUBJECT_TIMEOUT_MS,
  MAX_DESCRIPTION_LENGTH,
  MIN_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_MERGE_COMMIT_SUMMARY_LENGTH,
  MAX_COMMIT_BODY_INPUT_LENGTH,
  MAX_COMMIT_BODY_LENGTH,
  DEFAULT_COMMIT_BODY_TIMEOUT_MS,
  MAX_REQUESTS_PER_HOUR,
  ValidationError,
  RateLimitError,
  AiServiceError,
  __resetSummarizeState,
} from "./ai-summarize.js";
export {
  resolveExecutionSettingsModel,
  resolvePlanningSettingsModel,
  resolveProjectDefaultModel,
  resolveTaskExecutionModel,
  resolveTaskPlanningModel,
  resolveTaskValidatorModel,
  resolveTitleSummarizerSettingsModel,
  resolveValidatorSettingsModel,
} from "./model-resolution.js";
export type { ResolvedModelSelection } from "./model-resolution.js";

// ── Memory Compaction ─────────────────────────────────────────────────

export {
  compactMemoryWithAi,
  COMPACT_MEMORY_SYSTEM_PROMPT,
  createAutoSummarizeAutomation,
  syncAutoSummarizeAutomation,
  AUTO_SUMMARIZE_SCHEDULE_NAME,
  DEFAULT_AUTO_SUMMARIZE_SCHEDULE,
  __resetCompactionState,
} from "./memory-compaction.js";
// Note: AiServiceError is shared with ai-summarize.ts and re-exported from there

export {
  isTaskPriority,
  normalizeTaskPriority,
  getTaskPriorityRank,
  compareTaskPriority,
  compareTasksByPriorityThenAgeAndId,
  sortTasksByPriorityThenAgeAndId,
  compareTaskIdNumeric,
  sortTasksForDisplayColumn,
} from "./task-priority.js";
export type { TaskPrioritySortable, TaskColumnSortable } from "./task-priority.js";

// ── Mission Hierarchy Types ────────────────────────────────────────────

export {
  MISSION_STATUSES,
  MILESTONE_STATUSES,
  SLICE_STATUSES,
  FEATURE_STATUSES,
  INTERVIEW_STATES,
  AUTOPILOT_STATES,
  MISSION_EVENT_TYPES,
  SLICE_PLAN_STATES,
  FEATURE_LOOP_STATES,
  VALIDATOR_RUN_STATUSES,
  MISSION_ASSERTION_STATUSES,
  MILESTONE_VALIDATION_STATES,
} from "./mission-types.js";
export type {
  MissionStatus,
  MilestoneStatus,
  SliceStatus,
  FeatureStatus,
  InterviewState,
  AutopilotState,
  SlicePlanState,
  FeatureLoopState,
  ValidatorRunStatus,
  MissionEventType,
  AutopilotStatus,
  Mission,
  Milestone,
  Slice,
  MissionFeature,
  MissionEvent,
  MissionHealth,
  MissionCreateInput,
  MilestoneCreateInput,
  SliceCreateInput,
  FeatureCreateInput,
  MissionWithHierarchy,
  MilestoneWithSlices,
  SliceWithFeatures,
  MissionEventPayload,
  MissionDeletedPayload,
  MilestoneEventPayload,
  MilestoneDeletedPayload,
  SliceEventPayload,
  SliceDeletedPayload,
  SliceActivatedPayload,
  FeatureEventPayload,
  FeatureDeletedPayload,
  FeatureLinkedPayload,
  FixFeatureCreatedPayload,
  // Validator run types
  MissionValidatorRun,
  MissionAssertionFailureRecord,
  MissionFixFeatureLineage,
  MissionFeatureLoopSnapshot,
  // Contract assertion types
  MissionAssertionStatus,
  MilestoneValidationState,
  MissionContractAssertion,
  FeatureAssertionLink,
  MilestoneValidationRollup,
  ContractAssertionCreateInput,
  ContractAssertionUpdateInput,
  AssertionCreatedPayload,
  AssertionUpdatedPayload,
  AssertionDeletedPayload,
  AssertionLinkedPayload,
  AssertionUnlinkedPayload,
  MilestoneValidationUpdatedPayload,
} from "./mission-types.js";
export { MissionStore } from "./mission-store.js";
export type { MissionStoreEvents, MissionSummary } from "./mission-store.js";

// ── Central Infrastructure (Multi-Project Support) ───────────────────────────

export { CentralCore } from "./central-core.js";
export type { CentralCoreEvents } from "./central-core.js";
export { CentralDatabase, createCentralDatabase } from "./central-db.js";
export { NodeConnection } from "./node-connection.js";
export { NodeDiscovery } from "./node-discovery.js";
export { collectSystemMetrics } from "./system-metrics.js";
export { getAppVersion, parseSemver } from "./app-version.js";
export { DockerClientService } from "./docker-client.js";
export { MeshConfigGenerator } from "./mesh-config-generator.js";
export { DockerProvisioningService } from "./docker-provisioning.js";
export type {
  ConnectionErrorType,
  ConnectionOptions,
  ConnectionResult,
  TestAndRegisterOptions,
  TestAndRegisterResult,
} from "./node-connection.js";
export type {
  CentralActivityLogEntry,
  GlobalConcurrencyState,
  IsolationMode,
  MeshDiscovery,
  MeshClusterSnapshot,
  MeshDegradedReadState,
  MeshSnapshotQuery,
  MeshSnapshotRecord,
  MeshSnapshotRecordInput,
  MeshWriteApplyResult,
  MeshWriteFailureResult,
  MeshWriteQueueEntry,
  MeshWriteQueueFilter,
  MeshWriteQueueInput,
  MeshWriteQueueStatus,
  MeshWriteReplaySummary,
  MigrationOptions,
  NodeConfig,
  NodeMeshState,
  NodeStatus,
  NodeVersionInfo,
  NodeVersionInfoInput,
  DockerNodeStatus,
  DockerNodeConfig,
  DockerNodeVolumeMount,
  DockerNodeContainerResourceConfig,
  DockerNodeHostConfig,
  DockerNodePersistenceConfig,
  DockerHostConfig,
  DockerResourceSizing,
  DockerVolumeMount,
  DockerExtraCli,
  DockerContextInfo,
  DockerConnectivityResult,
  DockerContainerInspectResult,
  DockerNodeImageConfig,
  DockerNodeResourceConfig,
  DockerProvisionInput,
  DockerProvisionResult,
  ManagedDockerNode,
  ManagedDockerNodeInput,
  ManagedDockerNodeUpdate,
  MeshConfigGeneratorInput,
  FullProvisioningInput,
  MeshConnectionConfig,
  MeshConfigResult,
  NodeDiscoveryEvent,
  DiscoveryConfig,
  DiscoveredNode,
  PeerInfo,
  PeerNode,
  PeerSyncRequest,
  PeerSyncResponse,
  PluginSyncResult,
  PluginSyncEntry,
  PluginSyncAction,
  ProjectHealth,
  ProjectNodePathMapping,
  ProviderAuthEntry,
  /** @deprecated Use RegisteredProject instead */
  ProjectInfo,
  SettingsSyncPayload,
  SettingsSyncState,
  SettingsSyncResult,
  SharedMeshStatePayload,
  SnapshotBase,
  SystemMetrics,
  ProjectStatus,
  RegisteredProject,
  SetupCompletionResult,
  SetupState,
  VersionCompatibilityResult,
  VersionCompatibilityStatus,
} from "./types.js";

// ── Migration and First-Run Experience ────────────────────────────────

export {
  FirstRunDetector,
  MigrationCoordinator,
  BackwardCompat,
  ProjectRequiredError,
} from "./migration.js";
export type {
  FirstRunState,
  DetectedProject,
  MigrationResult,
  ProjectSetupInput,
  ResolvedContext,
} from "./migration.js";

// ── Memory Insights ──────────────────────────────────────────────────────

export {
  MEMORY_WORKING_PATH,
  MEMORY_INSIGHTS_PATH,
  MEMORY_AUDIT_PATH,
  DEFAULT_INSIGHT_SCHEDULE,
  DEFAULT_MIN_INTERVAL_MS,
  MIN_INSIGHT_GROWTH_CHARS,
  INSIGHT_EXTRACTION_SCHEDULE_NAME,
  readWorkingMemory,
  readInsightsMemory,
  writeInsightsMemory,
  readMemoryAudit,
  writeMemoryAudit,
  buildInsightExtractionPrompt,
  parseInsightExtractionResponse,
  mergeInsights,
  shouldTriggerExtraction,
  getDefaultInsightsTemplate,
  createInsightExtractionAutomation,
  syncInsightExtractionAutomation,
  processInsightExtractionRun,
  processAndAuditInsightExtraction,
  generateMemoryAudit,
  renderMemoryAuditMarkdown,
} from "./memory-insights.js";
export type {
  MemoryInsightCategory,
  MemoryInsight,
  InsightExtractionResult,
  MemoryAuditCheck,
  MemoryAuditReport,
  ProcessRunInput,
} from "./memory-insights.js";

export {
  getDefaultMemoryScaffold,
  ensureMemoryFile,
  ensureMemoryFileWithBackend,
  buildTriageMemoryInstructions,
  buildExecutionMemoryInstructions,
  buildReviewerMemoryInstructions,
  readProjectMemory,
  readProjectMemoryWithBackend,
  searchProjectMemory,
  getProjectMemory,
  resolveMemoryInstructionContext,
  type MemoryInstructionContext,
} from "./project-memory.js";

// ── Memory Backend ───────────────────────────────────────

export {
  FileMemoryBackend,
  ReadOnlyMemoryBackend,
  QmdMemoryBackend,
  MEMORY_WORKSPACE_PATH,
  MEMORY_LONG_TERM_FILENAME,
  MEMORY_DREAMS_FILENAME,
  QMD_INSTALL_COMMAND,
  QMD_REFRESH_INTERVAL_MS,
  memoryWorkspacePath,
  memoryLongTermPath,
  memoryDreamsPath,
  qmdMemoryCollectionName,
  buildQmdSearchArgs,
  buildQmdCollectionAddArgs,
  buildQmdRefreshCommands,
  refreshQmdProjectMemoryIndex,
  scheduleQmdProjectMemoryRefresh,
  shouldSkipBackgroundQmdRefresh,
  installQmd,
  ensureQmdInstalled,
  ensureQmdInstalledAndRefresh,
  scheduleQmdInstallAndRefresh,
  dailyMemoryPath,
  getDefaultLongTermMemoryScaffold,
  getDefaultDailyMemoryScaffold,
  getDefaultDreamsScaffold,
  ensureOpenClawMemoryFiles,
  listProjectMemoryFiles,
  readProjectMemoryFile,
  readProjectMemoryFileContent,
  writeProjectMemoryFile,
  listAgentMemoryFiles,
  readAgentMemoryFile,
  writeAgentMemoryFile,
} from "./memory-backend.js";

export {
  registerMemoryBackend,
  getMemoryBackend,
  listMemoryBackendTypes,
  resolveMemoryBackend,
  getMemoryBackendCapabilities,
  readMemory,
  writeMemory,
  memoryExists,
  MEMORY_BACKEND_SETTINGS_KEYS,
  DEFAULT_MEMORY_BACKEND,
  isQmdAvailable,
} from "./memory-backend.js";

export { MemoryBackendError } from "./memory-backend.js";

export type { MemoryBackendCapabilities, MemoryFileInfo, MemoryGetOptions, MemoryGetResult, MemorySearchOptions, MemorySearchResult } from "./memory-backend.js";

export {
  agentDailyMemoryPath,
  agentMemoryDreamsPath,
  agentMemoryLongTermPath,
  agentMemoryWorkspacePath,
  buildDreamProcessingPrompt,
  createMemoryDreamsAutomation,
  DEFAULT_MEMORY_DREAMS_SCHEDULE,
  ensureAgentMemoryFiles,
  extractDreamProcessorResult,
  MEMORY_DREAMS_SCHEDULE_NAME,
  processAgentMemoryDreams,
  processMemoryDreams,
  syncMemoryDreamsAutomation,
} from "./memory-dreams.js";
export type { AgentDreamProcessorResult, DreamProcessorResult, DreamPromptExecutor } from "./memory-dreams.js";

// ── Project Insights ──────────────────────────────────────────────────────

export { InsightLifecycleError, InsightStore, computeInsightFingerprint } from "./insight-store.js";
export {
  classifyInsightRunError,
  executeInsightRunLifecycle,
  retryInsightRunLifecycle,
} from "./insight-run-executor.js";
export type {
  InsightCategory,
  InsightStatus,
  InsightProvenance,
  Insight,
  InsightCreateInput,
  InsightUpdateInput,
  InsightUpsertInput,
  InsightListOptions,
  InsightRun,
  InsightRunStatus,
  InsightRunTrigger,
  InsightRunFailureClass,
  InsightRunLifecycle,
  InsightRunEventType,
  InsightRunEvent,
  InsightRunInputMetadata,
  InsightRunOutputMetadata,
  InsightRunCreateInput,
  InsightRunUpdateInput,
  InsightRunListOptions,
  InsightStoreEvents,
} from "./insight-types.js";
export type {
  InsightRunAttemptContext,
  InsightRunAttemptResult,
  InsightRunExecutorErrorClassification,
  InsightRunExecutorOptions,
} from "./insight-run-executor.js";

// ── Research System ───────────────────────────────────────────────────────

export { ResearchLifecycleError, ResearchStore } from "./research-store.js";
export {
  RESEARCH_RUN_STATUSES,
  RESEARCH_SOURCE_STATUSES,
  RESEARCH_EXPORT_FORMATS,
  RESEARCH_SOURCE_TYPES,
  RESEARCH_EVENT_TYPES,
  RESEARCH_ORCHESTRATION_PHASES,
  RESEARCH_ORCHESTRATION_STEP_STATUSES,
  RESEARCH_RUN_FAILURE_CLASSES,
} from "./research-types.js";
export type {
  ResearchRunStatus,
  ResearchSourceStatus,
  ResearchExportFormat,
  ResearchSourceType,
  ResearchEventType,
  ResearchSource,
  ResearchEvent,
  ResearchFinding,
  ResearchResult,
  ResearchTokenUsage,
  ResearchRun,
  ResearchRunLifecycle,
  ResearchRunFailureClass,
  ResearchRunEvent,
  ResearchExport,
  ResearchRunCreateInput,
  ResearchRunUpdateInput,
  ResearchRunListOptions,
  ResearchStoreEvents,
  ResearchOrchestrationPhase,
  ResearchOrchestrationStepStatus,
  ResearchOrchestrationStepType,
  ResearchOrchestrationStep,
  ResearchOrchestrationEventType,
  ResearchOrchestrationEvent,
  ResearchProviderConfig,
  ResearchOrchestrationProvider,
  ResearchModelSettings,
  ResearchOrchestrationConfig,
  ResearchSynthesisRequest,
  ResearchSynthesisResult,
  ResearchCancellationState,
} from "./research-types.js";

export { isExperimentalFeatureEnabled } from "./experimental-features.js";
export { isResearchExperimentalEnabled, resolveResearchSettings } from "./research-settings.js";
export type { ResolvedResearchSettings } from "./research-settings.js";
export { isEvalsExperimentalEnabled, resolveEvalSettings } from "./eval-settings.js";

export { TodoStore } from "./todo-store.js";
export type { TodoStoreEvents } from "./todo-store.js";
export { EvalLifecycleError, EvalStore } from "./eval-store.js";
export { collectDeterministicSignals } from "./eval-signal-collector.js";
export type { EvalRunContext } from "./eval-signal-collector.js";
export type {
  EvalRun,
  EvalRunStatus,
  EvalRunTrigger,
  EvalRunWindow,
  EvalRunCounts,
  EvalRunEvent,
  EvalRunCreateInput,
  EvalRunUpdateInput,
  EvalRunListOptions,
  EvalTaskSnapshot,
  EvalTaskResult,
  EvalTaskResultCreateInput,
  EvalTaskResultUpdateInput,
  EvalTaskResultListOptions,
  EvalScoreBand,
  EvalScoreCategory,
  EvalCategoryScore,
  EvalEvidenceReference,
  TaskEvaluationEvidenceSource,
  TaskEvidenceEntryBase,
  TaskMetadataEvidence,
  CommitEvidence,
  WorkflowEvidence,
  ReviewEvidence,
  DocumentEvidence,
  TaskActivityEvidence,
  AgentLogEvidence,
  RunAuditEvidence,
  TaskEvaluationEvidenceBundle,
  EvalSignal,
  EvalFollowUpPolicyMode,
  EvalFollowUpSuggestionState,
  EvalFollowUpSuppressionReason,
  EvalFollowUpEvidenceReference,
  EvalFollowUpCreationRecommendation,
  EvalFollowUpSuggestion,
  EvalProvenance,
  EvalStoreEvents,
  DeterministicSignals,
  EvaluationEvidenceRef,
  FollowUpDraft,
  TaskEvaluation,
} from "./eval-types.js";
export {
  EVAL_RUN_STATUSES,
  EVAL_RUN_TRIGGERS,
  EVAL_SCORE_CATEGORIES,
  EVAL_SCORE_BANDS,
  EVAL_SCORE_SCALE_MIN,
  EVAL_SCORE_SCALE_MAX,
  EVAL_FOLLOW_UP_POLICY_MODES,
  EVAL_FOLLOW_UP_SUGGESTION_STATES,
  EVAL_FOLLOW_UP_SUPPRESSION_REASONS,
  TASK_EVALUATION_EVIDENCE_SOURCE_ORDER,
  EVIDENCE_LIMITS,
  MAX_EVIDENCE_EXCERPT_LENGTH,
  EVIDENCE_EXCERPT_TRUNCATION_MARKER,
  normalizeEvalFollowUpText,
  buildEvalFollowUpSuggestionId,
} from "./eval-types.js";
export {
  EVAL_CATEGORY_WEIGHTS,
  assertValidScore,
  clampScore,
  computeCategoryFinalScore,
  computeOverallScore,
  normalizeCategoryScore,
  resolveScoreBand,
} from "./eval-scoring.js";
export {
  TASK_EVALUATION_SCHEDULE_NAME,
  DEFAULT_TASK_EVALUATION_SCHEDULE,
  TASK_EVALUATION_SCHEDULE_COMMAND,
  resolveTaskEvaluationSettings,
  createScheduledEvalBatchAutomation,
  syncScheduledEvalBatchAutomation,
  runScheduledEvalBatch,
} from "./eval-automation.js";
export type {
  ResolvedTaskEvaluationSettings,
  EvalBatchWindow,
  CompletedTaskEvaluationContext,
  CompletedTaskEvaluator,
  EvalBatchTaskStore,
  RunScheduledEvalBatchParams,
  ScheduledEvalBatchResult,
} from "./eval-automation.js";

// ── Agent Companies Types ──────────────────────────────────

export type {
  AgentCompaniesPackage,
  AgentCompaniesKind,
  AgentCompaniesSchema,
  AgentCompaniesFrontmatter,
  AgentCompaniesImportResult,
  CompanyManifest,
  TeamManifest,
  AgentManifest,
  ProjectManifest,
  TaskManifest,
  SkillManifest,
  SourceReference,
} from "./agent-companies-types.js";

// ── Agent Companies Parser ────────────────────────────────

export {
  parseYamlFrontmatter,
  parseCompanyManifest,
  parseTeamManifest,
  parseAgentManifest,
  parseSingleAgentManifest,
  parseProjectManifest,
  parseTaskManifest,
  parseSkillManifest,
  parseCompanyDirectory,
  parseCompanyArchive,
  mapRoleToCapability,
  agentManifestToAgentCreateInput,
  prepareAgentCompaniesImport,
  convertAgentCompanies,
  AgentCompaniesParseError,
} from "./agent-companies-parser.js";
export type {
  PreparedAgentCompaniesImportItem,
  PreparedAgentCompaniesImportResult,
} from "./agent-companies-parser.js";

// ── Agent Companies Exporter ──────────────────────────────

export {
  slugify,
  agentToCompaniesManifest,
  generateCompanyMd,
  generateAgentMd,
  exportAgentsToDirectory,
} from "./agent-companies-exporter.js";
export type {
  ExportOptions,
  ExportResult,
} from "./agent-companies-exporter.js";

// ── Chat System ───────────────────────────────────────────

export type {
  ChatSessionStatus,
  ChatMessageRole,
  ChatInFlightToolCall,
  ChatInFlightGenerationState,
  ChatSession,
  ChatSessionSummary,
  EnrichedChatSession,
  ChatMention,
  ChatAttachment,
  ChatMessage,
  ChatMessageCreateInput,
  ChatSessionCreateInput,
  ChatSessionUpdateInput,
  ChatMessagesFilter,
  ChatRoomStatus,
  RoomMemberRole,
  ChatRoom,
  ChatRoomMember,
  ChatRoomMessage,
  ChatRoomMessageWithMentions,
  ChatRoomCreateInput,
  ChatRoomUpdateInput,
  ChatRoomMessageCreateInput,
  ChatRoomMessagesFilter,
} from "./chat-types.js";
export { ChatStore } from "./chat-store.js";
export type { ChatStoreEvents } from "./chat-store.js";
export {
  choosePreferredStoredCredential,
  extractClaudeCliStoredCredential,
  extractCodexCliStoredCredential,
  getClaudeCodeCredentialPaths,
  getCodexCliAuthPath,
  readStoredCredentialsFromAuthFile,
  shouldHydrateStoredCredential,
} from "./oauth-credential-interop.js";
export type { StoredAuthCredential } from "./oauth-credential-interop.js";

// ── Error helpers ─────────────────────────────────────────
export { getErrorMessage } from "./error-message.js";
