export { COLUMNS, COLUMN_LABELS, COLUMN_DESCRIPTIONS, VALID_TRANSITIONS, DEFAULT_SETTINGS, DEFAULT_GLOBAL_SETTINGS, DEFAULT_PROJECT_SETTINGS, GLOBAL_SETTINGS_KEYS, PROJECT_SETTINGS_KEYS, isGlobalSettingsKey, isProjectSettingsKey, THINKING_LEVELS, THEME_MODES, COLOR_THEMES, WORKFLOW_STEP_TEMPLATES, AGENT_PERMISSIONS, agentToConfigSnapshot, diffConfigSnapshots, isEphemeralAgent, CheckoutConflictError } from "./types.js";
export type { Column, IssueInfo, IssueState, PrInfo, PrStatus, Task, TaskAttachment, TaskComment, TaskCommentInput, TaskDocument, TaskDocumentRevision, TaskDocumentCreateInput, TaskDocumentWithTask, TaskCreateInput, TaskDetail, InboxTask, AgentLogEntry, AgentLogType, AgentRole, BoardConfig, MergeDetails, MergeResult, Settings, GlobalSettings, ProjectSettings, SettingsScope, DaemonTokenSettings, TaskStep, StepStatus, TaskLogEntry, RunMutationContext, ActivityLogEntry, ActivityEventType, ThinkingLevel, ThemeMode, ColorTheme, PlanningQuestion, PlanningSummary, PlanningResponse, PlanningQuestionType, ArchivedTaskEntry, BatchStatusRequest, BatchStatusResponse, BatchStatusEntry, BatchStatusResult, ModelPreset, WorkflowStep, WorkflowStepMode, WorkflowStepPhase, WorkflowStepInput, WorkflowStepResult, WorkflowStepTemplate, Agent, OrgTreeNode, AgentState, AgentDetail, AgentCreateInput, AgentUpdateInput, AgentApiKey, AgentApiKeyCreateResult, AgentCapability, AgentPromptTemplate, AgentPromptsConfig, AgentPermission, TaskAssignSource, AgentAccessState, AgentHeartbeatConfig, AgentBudgetConfig, AgentBudgetStatus, InstructionsBundleConfig, MessageResponseMode, AgentHeartbeatEvent, AgentHeartbeatRun, BlockedStateSnapshot, HeartbeatInvocationSource, AgentTaskSession, AgentRating, AgentRatingSummary, AgentRatingInput, AgentConfigSnapshot, RevisionFieldDiff, AgentConfigRevision, AgentStats, ReflectionTrigger, ReflectionMetrics, AgentReflection, AgentPerformanceSummary, NtfyNotificationEvent, SteeringComment, ParticipantType, MessageType, Message, MessageCreateInput, MessageFilter, Mailbox, CheckoutLease, RunAuditDomain, RunAuditEvent, RunAuditEventInput, RunAuditEventFilter } from "./types.js";
export { AGENT_VALID_TRANSITIONS } from "./types.js";
export {
  BUILTIN_AGENT_PROMPTS,
  resolveAgentPrompt,
  getAvailableTemplates,
  getTemplatesForRole,
} from "./agent-prompts.js";

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
export { AgentStore } from "./agent-store.js";
export type { AgentStoreEvents } from "./agent-store.js";
export { ReflectionStore } from "./reflection-store.js";
export type { ReflectionStoreEvents } from "./reflection-store.js";
export { MessageStore } from "./message-store.js";
export type { MessageStoreEvents } from "./message-store.js";
export { TaskStore } from "./store.js";
export { Database, createDatabase, toJson, toJsonNullable, fromJson } from "./db.js";
export type { Statement } from "./db.js";
export { detectLegacyData, migrateFromLegacy, getMigrationStatus } from "./db-migrate.js";
export { GlobalSettingsStore, resolveGlobalDir } from "./global-settings.js";
export { DaemonTokenManager, DAEMON_TOKEN_PREFIX, DAEMON_TOKEN_HEX_LENGTH, isDaemonTokenFormat } from "./daemon-token.js";
export { canTransition, getValidTransitions, resolveDependencyOrder } from "./board.js";
export { getTaskMergeBlocker, getTaskCompletionBlocker, isTaskReadyForMerge } from "./task-merge.js";
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
export { AUTOMATION_PRESETS, MAX_RUN_HISTORY } from "./automation.js";
export type { ScheduleType, ScheduledTask, ScheduledTaskCreateInput, ScheduledTaskUpdateInput, AutomationRunResult, AutomationStepType, AutomationStep, AutomationStepResult } from "./automation.js";
export { AutomationStore } from "./automation-store.js";
export type { AutomationStoreEvents } from "./automation-store.js";

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

// ── Plugin System ─────────────────────────────────────────────────────
export type {
  PluginManifest,
  PluginSettingSchema,
  PluginSettingType,
  PluginOnLoad,
  PluginOnUnload,
  PluginOnTaskCreated,
  PluginOnTaskMoved,
  PluginOnTaskCompleted,
  PluginOnError,
  PluginToolDefinition,
  PluginToolResult,
  PluginRouteDefinition,
  PluginRouteMethod,
  PluginUiSlotDefinition,
  PluginContext,
  PluginLogger,
  FusionPlugin,
  PluginState,
  PluginInstallation,
} from "./plugin-types.js";
export { validatePluginManifest } from "./plugin-types.js";
export { PluginStore } from "./plugin-store.js";
export type { PluginStoreEvents, PluginRegistrationInput, PluginUpdateInput } from "./plugin-store.js";
export { PluginLoader } from "./plugin-loader.js";
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
  BACKUP_SCHEDULE_NAME,
} from "./backup.js";
export type { BackupInfo, BackupOptions } from "./backup.js";
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
  checkRateLimit,
  getRateLimitResetTime,
  validateDescription,
  SUMMARIZE_SYSTEM_PROMPT,
  MAX_DESCRIPTION_LENGTH,
  MIN_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_REQUESTS_PER_HOUR,
  ValidationError,
  RateLimitError,
  AiServiceError,
  __resetSummarizeState,
} from "./ai-summarize.js";

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

// ── Standalone Roadmap Model ───────────────────────────────────────────

export type {
  Roadmap,
  RoadmapMilestone,
  RoadmapFeature,
  RoadmapCreateInput,
  RoadmapUpdateInput,
  RoadmapMilestoneCreateInput,
  RoadmapMilestoneUpdateInput,
  RoadmapFeatureCreateInput,
  RoadmapFeatureUpdateInput,
  RoadmapMilestoneReorderInput,
  RoadmapFeatureReorderInput,
  RoadmapFeatureMoveInput,
  RoadmapFeatureMoveResult,
  RoadmapMilestoneWithFeatures,
  RoadmapWithHierarchy,
  RoadmapExportBundle,
  RoadmapFeatureSourceRef,
  RoadmapFeatureTaskPlanningHandoff,
  RoadmapMissionPlanningMilestoneHandoff,
  RoadmapMissionPlanningHandoff,
} from "./roadmap-types.js";
export {
  normalizeRoadmapMilestoneOrder,
  applyRoadmapMilestoneReorder,
  normalizeRoadmapFeatureOrder,
  applyRoadmapFeatureReorder,
  moveRoadmapFeature,
} from "./roadmap-ordering.js";
export {
  mapFeatureToTaskHandoff,
  mapRoadmapToMissionHandoff,
  mapRoadmapWithHierarchyToMissionHandoff,
  mapAllFeaturesToTaskHandoffs,
} from "./roadmap-handoff.js";

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
export { RoadmapStore } from "./roadmap-store.js";
export type { RoadmapStoreEvents } from "./roadmap-store.js";

// ── Central Infrastructure (Multi-Project Support) ───────────────────────────

export { CentralCore } from "./central-core.js";
export type { CentralCoreEvents } from "./central-core.js";
export { CentralDatabase, createCentralDatabase } from "./central-db.js";
export { NodeConnection } from "./node-connection.js";
export { NodeDiscovery } from "./node-discovery.js";
export { collectSystemMetrics } from "./system-metrics.js";
export { getAppVersion, parseSemver } from "./app-version.js";
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
  MigrationOptions,
  NodeConfig,
  NodeMeshState,
  NodeStatus,
  NodeVersionInfo,
  NodeVersionInfoInput,
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
  ProviderAuthEntry,
  /** @deprecated Use RegisteredProject instead */
  ProjectInfo,
  SettingsSyncPayload,
  SettingsSyncState,
  SettingsSyncResult,
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
export {
  needsCentralMigration,
  detectExistingProjects,
  autoMigrateToCentral,
} from "./db-migrate.js";

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
  MEMORY_FILE_PATH,
  memoryFilePath,
  getDefaultMemoryScaffold,
  ensureMemoryFile,
  ensureMemoryFileWithBackend,
  buildTriageMemoryInstructions,
  buildExecutionMemoryInstructions,
  readProjectMemory,
  readProjectMemoryWithBackend,
  resolveMemoryInstructionContext,
  type MemoryInstructionContext,
} from "./project-memory.js";

// ── Memory Backend ───────────────────────────────────────

export {
  FileMemoryBackend,
  ReadOnlyMemoryBackend,
  QmdMemoryBackend,
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
} from "./memory-backend.js";

export { MemoryBackendError } from "./memory-backend.js";

export type { MemoryBackendCapabilities } from "./memory-backend.js";

// ── Project Insights ──────────────────────────────────────────────────────

export { InsightStore, computeInsightFingerprint } from "./insight-store.js";
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
  InsightRunInputMetadata,
  InsightRunOutputMetadata,
  InsightRunCreateInput,
  InsightRunUpdateInput,
  InsightRunListOptions,
  InsightStoreEvents,
} from "./insight-types.js";

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
  ChatSession,
  ChatSessionSummary,
  ChatMessage,
  ChatMessageCreateInput,
  ChatSessionCreateInput,
  ChatSessionUpdateInput,
  ChatMessagesFilter,
} from "./chat-types.js";
export { ChatStore } from "./chat-store.js";
export type { ChatStoreEvents } from "./chat-store.js";
