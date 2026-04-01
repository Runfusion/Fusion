export { COLUMNS, COLUMN_LABELS, COLUMN_DESCRIPTIONS, VALID_TRANSITIONS, DEFAULT_SETTINGS, DEFAULT_GLOBAL_SETTINGS, DEFAULT_PROJECT_SETTINGS, GLOBAL_SETTINGS_KEYS, PROJECT_SETTINGS_KEYS, THINKING_LEVELS, THEME_MODES, COLOR_THEMES, WORKFLOW_STEP_TEMPLATES } from "./types.js";
export type { Column, IssueInfo, IssueState, PrInfo, PrStatus, Task, TaskAttachment, TaskComment, TaskCommentInput, TaskCreateInput, TaskDetail, AgentLogEntry, AgentLogType, AgentRole, BoardConfig, MergeDetails, MergeResult, Settings, GlobalSettings, ProjectSettings, SettingsScope, TaskStep, StepStatus, TaskLogEntry, ActivityLogEntry, ActivityEventType, ThinkingLevel, ThemeMode, ColorTheme, PlanningQuestion, PlanningSummary, PlanningResponse, PlanningQuestionType, ArchivedTaskEntry, BatchStatusRequest, BatchStatusResponse, BatchStatusEntry, BatchStatusResult, ModelPreset, WorkflowStep, WorkflowStepInput, WorkflowStepResult, WorkflowStepTemplate, Agent, AgentState, AgentDetail, AgentCreateInput, AgentUpdateInput, AgentCapability, AgentHeartbeatEvent } from "./types.js";
export { AgentStore } from "./agent-store.js";
export type { AgentStoreEvents } from "./agent-store.js";
export { TaskStore } from "./store.js";
export { Database, createDatabase, toJson, toJsonNullable, fromJson } from "./db.js";
export type { Statement } from "./db.js";
export { detectLegacyData, migrateFromLegacy, getMigrationStatus } from "./db-migrate.js";
export { GlobalSettingsStore } from "./global-settings.js";
export { canTransition, getValidTransitions, resolveDependencyOrder } from "./board.js";
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

// ── Mission Hierarchy Types ────────────────────────────────────────────

export {
  MISSION_STATUSES,
  MILESTONE_STATUSES,
  SLICE_STATUSES,
  FEATURE_STATUSES,
  INTERVIEW_STATES,
} from "./mission-types.js";
export type {
  MissionStatus,
  MilestoneStatus,
  SliceStatus,
  FeatureStatus,
  InterviewState,
  Mission,
  Milestone,
  Slice,
  MissionFeature,
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
} from "./mission-types.js";
export { MissionStore } from "./mission-store.js";
export type { MissionStoreEvents } from "./mission-store.js";

// ── Central Infrastructure (Multi-Project Support) ───────────────────────────

export { CentralCore } from "./central-core.js";
export type { CentralCoreEvents } from "./central-core.js";
export { CentralDatabase, createCentralDatabase } from "./central-db.js";
export type { 
  RegisteredProject, 
  IsolationMode, 
  ProjectStatus, 
  ProjectHealth, 
  CentralActivityLogEntry, 
  GlobalConcurrencyState,
  DetectedProject,
  MigrationOptions,
  MigrationResult,
  ProjectSetupInput,
  SetupState,
  SetupCompletionResult,
} from "./types.js";

// ── Migration & First-Run (Multi-Project Support) ───────────────────────────

export {
  MigrationOrchestrator,
  createMigrationOrchestrator,
  MAX_AUTO_REGISTER_PROJECTS,
  DEFAULT_MAX_DEPTH,
  EXCLUDED_DIRS,
} from "./migration-orchestrator.js";

export {
  FirstRunExperience,
  createFirstRunExperience,
} from "./first-run.js";
