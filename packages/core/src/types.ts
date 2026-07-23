/*
 * FNXC:CodeOrganization 2026-07-22-14:00:
 * After peels moved Task (and its signal field types) out of this barrel, the prior
 * `import type { …Signal }` lines became unused and failed eslint. Keep type-only
 * re-exports instead so the dashboard vite alias (`@fusion/core` → types.ts) still
 * resolves stall/staleness/overseer types for browser-safe pure helpers.
 */
// FNXC:PlannerOversight 2026-07-04-18:00: FN-7563 needs `PlannerOverseerState`/
// `PlannerOverseerRuntimeSnapshot` as TYPE-ONLY imports in the dashboard's pure
// `plannerOverseerBadge.ts` helper. The dashboard's vite alias for "@fusion/core"
// resolves only to this file (types.ts), not the package barrel, so the types must
// be re-exported here (type-only — no engine/runtime code crosses into the browser
// bundle) rather than requiring dashboard code to import the source module path.
export type { PlannerOverseerState, PlannerOverseerRuntimeSnapshot } from "./planner-overseer-state.js";
export type { ExecutorEscalationTarget, InReviewStallCode, InReviewStallSignal, ProviderErrorClassification } from "./in-review-stall.js";
export type { InReviewStalledCode, InReviewStalledSignal } from "./in-review-stalled.js";
export type { StalePausedReviewCode, StalePausedReviewSignal } from "./stale-paused-review.js";
export type { StalePausedTodoCode, StalePausedTodoSignal } from "./stale-paused-todo.js";
export type { StalledReviewSignal } from "./stalled-review-detector.js";
export type { TaskAgeStalenessLevel, TaskAgeStalenessSignal } from "./task-age-staleness.js";
// FNXC:UpdateChannels 2026-07-19-12:30: re-export type-only so browser-side
// dashboard code (whose "@fusion/core" vite alias resolves to types.ts, not the
// package barrel) can name the update channel union.
export type { UpdateChannel } from "./app-version.js";

export {
  computeCapacityRisk,
  DEFAULT_CAPACITY_RISK_TODO_THRESHOLD,
} from "./capacity.js";
export type { CapacityRiskSignal } from "./capacity.js";

// FNXC:McpConfig 2026-06-26-02:10: The dashboard Vite build aliases @fusion/core to this browser-safe module, so the pure MCP config helpers are re-exported here for Settings UI import/export, validation, and project-over-global resolution without pulling Node-only stores into the client bundle.
export { exportMcpServersJson, importMcpServersJson, mapPluginMcpServerContribution, resolveEffectiveMcpServers } from "./mcp-config.js";
export {
  DEFAULT_GITLAB_API_BASE_URL,
  DEFAULT_GITLAB_INSTANCE_URL,
  resolveGitlabConfig,
  resolveGitlabEnabled,
} from "./gitlab-config.js";
export type { GitlabConfigSettingsSource, ResolvedGitlabConfig, ResolveGitlabConfigInput } from "./gitlab-config.js";
export { validateMcpServerDefinitionDetailed, validateMcpServerDefinitionsDetailed } from "./settings-validation.js";

/*
 * FNXC:WorkflowDeprecation 2026-07-15-16:35:
 * Keep deprecated IDs browser-safe because Settings loads the management list
 * (including disabled built-ins) but must not re-offer retired workflows for new
 * selection. FN-7970 and FN-7969 preserve direct resolution for pre-existing
 * Brainstorming and Coding (Ideas) task selections while hiding them elsewhere.
 */
export const DEPRECATED_BUILTIN_WORKFLOW_IDS: ReadonlySet<string> = new Set([
  "builtin:brainstorming",
]);


/*
FNXC:CodeOrganization 2026-07-15-00:00:
Domain peels live under types/*.ts. Import locally so residual interfaces in this
barrel can reference them, then re-export so the Vite @fusion/core alias and
package consumers keep stable import paths.
*/
import {
  THINKING_LEVELS,
  COLUMNS,
  DEFAULT_COLUMN,
  isColumn,
  normalizeColumn, normalizeColumnId,
  TASK_PRIORITIES,
  DEFAULT_TASK_PRIORITY,
} from "./types/board.js";
import type { ThinkingLevel, Column, ColumnId, TaskPriority } from "./types/board.js";
export {
  THINKING_LEVELS,
  COLUMNS,
  DEFAULT_COLUMN,
  isColumn,
  normalizeColumn, normalizeColumnId,
  TASK_PRIORITIES,
  DEFAULT_TASK_PRIORITY,
};
export type { ThinkingLevel, Column, ColumnId, TaskPriority };

import {
  MERGE_REQUEST_STATES,
  ACTIVE_WORKFLOW_WORK_ITEM_STATES,
  WORKFLOW_WORK_ITEM_KINDS,
  WORKFLOW_WORK_ITEM_STATES,
} from "./types/merge-queue.js";
import type {
  MergeRequestState,
  WorkflowWorkItemKind,
  WorkflowWorkItemState,
  WorkflowWorkItem,
  WorkflowWorkItemUpsertInput,
  WorkflowWorkItemTransitionPatch,
  WorkflowWorkItemDueFilter,
  MergeRequestWorkflowProjectionOptions,
  MergeQueueEntry,
  MergeRequestRecord,
  CompletionHandoffMarker,
  MergeQueueEnqueueOptions,
  MergeQueueAcquireOptions,
  MergeQueueReleaseOutcome,
  HandoffEvidence,
  HandoffToReviewOptions,
} from "./types/merge-queue.js";
export {
  MERGE_REQUEST_STATES,
  ACTIVE_WORKFLOW_WORK_ITEM_STATES,
  WORKFLOW_WORK_ITEM_KINDS,
  WORKFLOW_WORK_ITEM_STATES,
};
export type {
  MergeRequestState,
  WorkflowWorkItemKind,
  WorkflowWorkItemState,
  WorkflowWorkItem,
  WorkflowWorkItemUpsertInput,
  WorkflowWorkItemTransitionPatch,
  WorkflowWorkItemDueFilter,
  MergeRequestWorkflowProjectionOptions,
  MergeQueueEntry,
  MergeRequestRecord,
  CompletionHandoffMarker,
  MergeQueueEnqueueOptions,
  MergeQueueAcquireOptions,
  MergeQueueReleaseOutcome,
  HandoffEvidence,
  HandoffToReviewOptions,
};

import {
  HIGH_FANOUT_BLOCKER_TODO_THRESHOLD,
  STALE_HIGH_FANOUT_BLOCKER_AGE_THRESHOLD_MS,
  EXECUTION_MODES,
  DEFAULT_EXECUTION_MODE,
  PLANNER_OVERSIGHT_LEVELS,
  DEFAULT_PLANNER_OVERSIGHT_LEVEL,
  COMPLETION_DOCUMENTATION_MODES,
  REVIEW_ARTIFACTS_MODES,
  THEME_MODES,
  COLOR_THEMES,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  isLocale,
} from "./types/execution-and-ui.js";
import type {
  ExecutionMode,
  PlannerOversightLevel,
  CompletionDocumentationMode,
  ReviewArtifactsMode,
  ThemeMode,
  ColorTheme,
  Locale,
} from "./types/execution-and-ui.js";
export {
  HIGH_FANOUT_BLOCKER_TODO_THRESHOLD,
  STALE_HIGH_FANOUT_BLOCKER_AGE_THRESHOLD_MS,
  EXECUTION_MODES,
  DEFAULT_EXECUTION_MODE,
  PLANNER_OVERSIGHT_LEVELS,
  DEFAULT_PLANNER_OVERSIGHT_LEVEL,
  COMPLETION_DOCUMENTATION_MODES,
  REVIEW_ARTIFACTS_MODES,
  THEME_MODES,
  COLOR_THEMES,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  isLocale,
};
export type {
  ExecutionMode,
  PlannerOversightLevel,
  CompletionDocumentationMode,
  ReviewArtifactsMode,
  ThemeMode,
  ColorTheme,
  Locale,
};

import {
  __resetLegacyCwdMainWarningForTests,
  normalizeMergeIntegrationWorktreeMode,
  DIRECT_MERGE_COMMIT_STRATEGIES,
  MERGE_ADVANCE_AUTO_SYNC_MODES,
  normalizeMergeAdvanceAutoSyncMode,
  normalizeMergeConflictStrategy,
  MERGE_STRATEGY_OVERLAP_BEHAVIORS,
  normalizeMergeStrategyOverlapBehavior,
  POST_MERGE_AUDIT_MODES,
  normalizePostMergeAuditMode,
  MERGE_AUDIT_AUTO_RECOVERY_MODES,
  normalizeMergeAuditAutoRecovery,
  MERGER_MODES,
  normalizeMergerMode,
  AUTO_RECOVERY_MODES,
  normalizeAutoRecovery,
} from "./types/merge-policy.js";
import type {
  PrStatus,
  MergeStrategy,
  MergeIntegrationWorktreeMode,
  DirectMergeCommitStrategy,
  MergeAdvanceAutoSyncMode,
  MergeConflictStrategy,
  CanonicalMergeConflictStrategy,
  MergeStrategyOverlapBehavior,
  PostMergeAuditMode,
  MergeAuditAutoRecoveryMode,
  MergerMode,
  MergerSettings,
  AutoRecoveryMode,
  AutoRecoveryFailureClass,
  AutoRecoverySettings,
  UnavailableNodePolicy,
  OwningNodeHandoffPolicy,
} from "./types/merge-policy.js";
export {
  __resetLegacyCwdMainWarningForTests,
  normalizeMergeIntegrationWorktreeMode,
  DIRECT_MERGE_COMMIT_STRATEGIES,
  MERGE_ADVANCE_AUTO_SYNC_MODES,
  normalizeMergeAdvanceAutoSyncMode,
  normalizeMergeConflictStrategy,
  MERGE_STRATEGY_OVERLAP_BEHAVIORS,
  normalizeMergeStrategyOverlapBehavior,
  POST_MERGE_AUDIT_MODES,
  normalizePostMergeAuditMode,
  MERGE_AUDIT_AUTO_RECOVERY_MODES,
  normalizeMergeAuditAutoRecovery,
  MERGER_MODES,
  normalizeMergerMode,
  AUTO_RECOVERY_MODES,
  normalizeAutoRecovery,
};
export type {
  PrStatus,
  MergeStrategy,
  MergeIntegrationWorktreeMode,
  DirectMergeCommitStrategy,
  MergeAdvanceAutoSyncMode,
  MergeConflictStrategy,
  CanonicalMergeConflictStrategy,
  MergeStrategyOverlapBehavior,
  PostMergeAuditMode,
  MergeAuditAutoRecoveryMode,
  MergerMode,
  MergerSettings,
  AutoRecoveryMode,
  AutoRecoveryFailureClass,
  AutoRecoverySettings,
  UnavailableNodePolicy,
  OwningNodeHandoffPolicy,
};

import { NOTIFICATION_EVENTS } from "./types/workflow-steps.js";
import type {
  ModelPreset,
  WorkflowStepMode,
  WorkflowStepToolMode,
  WorkflowStepGateMode,
  WorkflowStepPhase,
  WorkflowStep,
  NtfyNotificationEvent,
  NotificationEvent,
  NotificationPayload,
  NotificationProviderConfig,
  CustomProvider,
  WorkflowStepInput,
  WorkflowStepResult,
  WorkflowRunStepInstanceStatus,
  WorkflowRunStepInstance,
  WorkflowStepTemplate,
} from "./types/workflow-steps.js";
export { NOTIFICATION_EVENTS };
export type {
  ModelPreset,
  WorkflowStepMode,
  WorkflowStepToolMode,
  WorkflowStepGateMode,
  WorkflowStepPhase,
  WorkflowStep,
  NtfyNotificationEvent,
  NotificationEvent,
  NotificationPayload,
  NotificationProviderConfig,
  CustomProvider,
  WorkflowStepInput,
  WorkflowStepResult,
  WorkflowRunStepInstanceStatus,
  WorkflowRunStepInstance,
  WorkflowStepTemplate,
};


import type {
  PrConflictState,
  PrConflictDiagnostics,
  PrInfo,
  IssueState,
  IssueInfo,
  TaskGithubTrackedIssue,
  GithubIssueAction,
  GitLabTrackedItemKind,
  TaskGitLabTrackedItem,
  TaskGitLabTracking,
  TaskGithubTracking,
  TaskSourceIssue,
} from "./types/task-tracking.js";
export type {
  PrConflictState,
  PrConflictDiagnostics,
  PrInfo,
  IssueState,
  IssueInfo,
  TaskGithubTrackedIssue,
  GithubIssueAction,
  GitLabTrackedItemKind,
  TaskGitLabTrackedItem,
  TaskGitLabTracking,
  TaskGithubTracking,
  TaskSourceIssue,
};

export interface BatchStatusRequest {
  taskIds: string[];
}

export interface BatchStatusEntry {
  issueInfo?: IssueInfo;
  prInfo?: PrInfo;
  prInfos?: PrInfo[];
  stale: boolean;
  error?: string;
}

export type BatchStatusResult = Record<string, BatchStatusEntry>;

export interface BatchStatusResponse {
  results: BatchStatusResult;
}

// ── task-log ──────────────────────────────────────────────────────────
// FNXC:CodeOrganization 2026-07-22-14:00: Peels live in types/task-log.ts

import type {
  StepStatus,
  WorkflowTransitionNotificationKind,
  ActivityEventType,
  AgentRole,
  AgentLogType,
  ArchiveAgentLogMode,
  TaskStep,
  RunMutationContext,
  TaskLogEntry,
  WorkflowTransitionNotificationMarker,
  ActivityLogEntry,
  AgentLogEntry,
  TaskAttachment,
  SteeringComment,
  TaskComment,
  TaskCommentInput,
} from "./types/task-log.js";
export type {
  StepStatus,
  WorkflowTransitionNotificationKind,
  ActivityEventType,
  AgentRole,
  AgentLogType,
  ArchiveAgentLogMode,
  TaskStep,
  RunMutationContext,
  TaskLogEntry,
  WorkflowTransitionNotificationMarker,
  ActivityLogEntry,
  AgentLogEntry,
  TaskAttachment,
  SteeringComment,
  TaskComment,
  TaskCommentInput,
};

// ── task-review ──────────────────────────────────────────────────────────
// FNXC:CodeOrganization 2026-07-21-12:00: Peels live in types/task-review.ts

import type {
  TaskReviewMode,
  TaskReviewSource,
  TaskReviewDecision,
  TaskReviewVerdict,
  TaskReviewerType,
  TaskReviewItemStatus,
  PrCheckState,
  ReviewAddressingStatus,
  TaskReviewRefreshSource,
  TaskReviewRefreshStatus,
  TaskReviewItem,
  LegacyTaskReviewItem,
  TaskReview,
  PrCheckStatus,
  TaskReviewAuthor,
  PrTaskReviewSummaryReviewer,
  PrTaskReviewSummary,
  TaskReviewStateItem,
  ReviewAddressingSnapshot,
  ReviewAddressingRecord,
  ReviewerTaskReviewSummary,
  TaskReviewState,
  TaskReviewSummary,
  TaskReviewDataItem,
  TaskReviewData,
} from "./types/task-review.js";
export type {
  TaskReviewMode,
  TaskReviewSource,
  TaskReviewDecision,
  TaskReviewVerdict,
  TaskReviewerType,
  TaskReviewItemStatus,
  PrCheckState,
  ReviewAddressingStatus,
  TaskReviewRefreshSource,
  TaskReviewRefreshStatus,
  TaskReviewItem,
  LegacyTaskReviewItem,
  TaskReview,
  PrCheckStatus,
  TaskReviewAuthor,
  PrTaskReviewSummaryReviewer,
  PrTaskReviewSummary,
  TaskReviewStateItem,
  ReviewAddressingSnapshot,
  ReviewAddressingRecord,
  ReviewerTaskReviewSummary,
  TaskReviewState,
  TaskReviewSummary,
  TaskReviewDataItem,
  TaskReviewData,
};

// ── documents-artifacts ──────────────────────────────────────────────────────────
// FNXC:CodeOrganization 2026-07-21-12:00: Peels live in types/documents-artifacts.ts

import {
  isReviewArtifact,
  parseReviewArtifactsModeOverride,
  resolveReviewArtifactsMode,
  classifyReviewArtifactTask,
  isReviewArtifactGenerationEligible,
  validateDocumentKey,
  buildResearchDocumentKey,
  REPORT_ATTACHMENT_SOURCE,
  LIVE_DEMO_ARTIFACT_MIME_TYPE,
  DOCUMENT_KEY_RE,
  REPO_OVERRIDE_RE,
} from "./types/documents-artifacts.js";
export {
  isReviewArtifact,
  parseReviewArtifactsModeOverride,
  resolveReviewArtifactsMode,
  classifyReviewArtifactTask,
  isReviewArtifactGenerationEligible,
  validateDocumentKey,
  buildResearchDocumentKey,
  REPORT_ATTACHMENT_SOURCE,
  LIVE_DEMO_ARTIFACT_MIME_TYPE,
  DOCUMENT_KEY_RE,
  REPO_OVERRIDE_RE,
};

import type {
  ArtifactType,
  ReviewArtifactTaskClassification,
  NativeStructurePreviewResult,
  GoalCitationSurface,
  TaskDocument,
  TaskDocumentRevision,
  TaskDocumentCreateInput,
  ArchivedTaskDocumentAdditionInput,
  ArchivedTaskDocumentAdditionResult,
  TaskDocumentWithTask,
  Artifact,
  ArtifactCreateInput,
  ArtifactWithTask,
  NativeStructureRef,
  NativeStructureOpenTarget,
  NativeStructurePreviewPayload,
  NativeStructureUnavailablePayload,
  GoalCitationMatch,
  GoalCitationInput,
  GoalCitation,
  GoalCitationFilter,
} from "./types/documents-artifacts.js";
export type {
  ArtifactType,
  ReviewArtifactTaskClassification,
  NativeStructurePreviewResult,
  GoalCitationSurface,
  TaskDocument,
  TaskDocumentRevision,
  TaskDocumentCreateInput,
  ArchivedTaskDocumentAdditionInput,
  ArchivedTaskDocumentAdditionResult,
  TaskDocumentWithTask,
  Artifact,
  ArtifactCreateInput,
  ArtifactWithTask,
  NativeStructureRef,
  NativeStructureOpenTarget,
  NativeStructurePreviewPayload,
  NativeStructureUnavailablePayload,
  GoalCitationMatch,
  GoalCitationInput,
  GoalCitation,
  GoalCitationFilter,
};

// ── task-core ──────────────────────────────────────────────────────────
// FNXC:CodeOrganization 2026-07-22-14:00: Peels live in types/task-core.ts

import {
  assertNotWorkspaceTaskMerge,
  isWorkspaceTask,
  CheckoutConflictError,
  WorkspaceTaskMergeError,
  DUPLICATE_OF_METADATA_KEY,
} from "./types/task-core.js";
export {
  assertNotWorkspaceTaskMerge,
  isWorkspaceTask,
  CheckoutConflictError,
  WorkspaceTaskMergeError,
  DUPLICATE_OF_METADATA_KEY,
};

import type {
  SourceType,
  TaskBranchGroupSource,
  TaskBranchAssignmentMode,
  BranchGroupPrState,
  BranchGroupStatus,
  PrEntitySourceType,
  PrEntityState,
  PrReviewDecision,
  PrChecksRollup,
  PrThreadOutcome,
  RetrySummary,
  TaskVerificationStatus,
  TaskVerificationProfile,
  MergeDetails,
  CheckoutLease,
  CheckoutClaimContext,
  CheckoutClaimPrecondition,
  TaskClaimRow,
  CentralClaimStore,
  TaskTokenUsagePerModel,
  TaskTokenUsage,
  TaskTokenBudget,
  TaskTokenBudgetOverride,
  TaskSource,
  TaskBranchContext,
  BranchGroup,
  BranchGroupCreateInput,
  BranchGroupUpdate,
  PrEntity,
  PrEntityCreateInput,
  PrEntityUpdate,
  PrThreadState,
  ExecutorOverseerSignalMemory,
  TaskWedgeNotificationState,
  Task,
  TaskVerificationResultSummary,
  TaskVerificationRequest,
  TaskDetail,
  InboxTask,
  TaskCreateInput,
} from "./types/task-core.js";
export type {
  SourceType,
  TaskBranchGroupSource,
  TaskBranchAssignmentMode,
  BranchGroupPrState,
  BranchGroupStatus,
  PrEntitySourceType,
  PrEntityState,
  PrReviewDecision,
  PrChecksRollup,
  PrThreadOutcome,
  RetrySummary,
  TaskVerificationStatus,
  TaskVerificationProfile,
  MergeDetails,
  CheckoutLease,
  CheckoutClaimContext,
  CheckoutClaimPrecondition,
  TaskClaimRow,
  CentralClaimStore,
  TaskTokenUsagePerModel,
  TaskTokenUsage,
  TaskTokenBudget,
  TaskTokenBudgetOverride,
  TaskSource,
  TaskBranchContext,
  BranchGroup,
  BranchGroupCreateInput,
  BranchGroupUpdate,
  PrEntity,
  PrEntityCreateInput,
  PrEntityUpdate,
  PrThreadState,
  ExecutorOverseerSignalMemory,
  TaskWedgeNotificationState,
  Task,
  TaskVerificationResultSummary,
  TaskVerificationRequest,
  TaskDetail,
  InboxTask,
  TaskCreateInput,
};

// ── todo-list ──────────────────────────────────────────────────────────
// FNXC:CodeOrganization 2026-07-22-14:00: Peels live in types/todo-list.ts

import {
  SHARED_STATE_SNAPSHOT_VERSION,
} from "./types/todo-list.js";
export {
  SHARED_STATE_SNAPSHOT_VERSION,
};

import type {
  TodoList,
  TodoItem,
  TodoListCreateInput,
  TodoListUpdateInput,
  TodoItemCreateInput,
  TodoItemUpdateInput,
  TodoListWithItems,
} from "./types/todo-list.js";
export type {
  TodoList,
  TodoItem,
  TodoListCreateInput,
  TodoListUpdateInput,
  TodoItemCreateInput,
  TodoItemUpdateInput,
  TodoListWithItems,
};

// ── settings-scope ──────────────────────────────────────────────────────────
// FNXC:CodeOrganization 2026-07-22-12:00: Peels live in types/settings-scope.ts

import {
  isMcpSecretRef,
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_PROJECT_SETTINGS,
  DEFAULT_SETTINGS,
  GLOBAL_SETTINGS_KEYS,
  PROJECT_SETTINGS_KEYS,
  isGlobalOnlySettingsKey,
  isGlobalSettingsKey,
  isProjectSettingsKey,
  isMergeRequestContractShadowEnabled,
  resolvePersistAgentThinkingLog,
  sanitizeCliAgentSettings,
  sanitizeCliAgentsSettings,
  sanitizeMcpServers,
  CLI_AGENT_ADAPTER_IDS,
  CLI_AGENT_AUTONOMY_MODES,
} from "./types/settings-scope.js";
export {
  isMcpSecretRef,
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_PROJECT_SETTINGS,
  DEFAULT_SETTINGS,
  GLOBAL_SETTINGS_KEYS,
  PROJECT_SETTINGS_KEYS,
  isGlobalOnlySettingsKey,
  isGlobalSettingsKey,
  isProjectSettingsKey,
  isMergeRequestContractShadowEnabled,
  resolvePersistAgentThinkingLog,
  sanitizeCliAgentSettings,
  sanitizeCliAgentsSettings,
  sanitizeMcpServers,
  CLI_AGENT_ADAPTER_IDS,
  CLI_AGENT_AUTONOMY_MODES,
};

import type {
  SettingsScope,
  WebSearchBackend,
  SandboxBackendName,
  SandboxFailureMode,
  EvalFollowUpPolicy,
  AgentMemoryInclusionMode,
  HeartbeatScopeDisciplineMode,
  HeartbeatPromptTemplate,
  WorktrunkOnFailure,
  McpSensitiveValue,
  McpTransport,
  McpServerDefinition,
  RemoteAccessProvider,
  GithubAuthMode,
  GitlabAuthTokenType,
  SecretsEnvConfig,
  ReportMode,
  ReportActionType,
  ReportTarget,
  DaemonTokenSettings,
  ResearchEnabledSources,
  ResearchGlobalDefaults,
  ResearchProjectLimits,
  ResearchProjectSettings,
  SandboxPolicy,
  SandboxProjectSettings,
  EvalProjectSettings,
  ResolvedEvalSettings,
  OpenRouterModelFilters,
  OpenRouterProviderPreferences,
  WorktrunkSettings,
  McpSecretRef,
  McpStdioTransport,
  McpSseTransport,
  McpStreamableHttpTransport,
  McpServersSettings,
  DashboardKeyboardShortcuts,
  BackupSettingsMigrationCandidate,
  BackupSettingsMigrationConflict,
  GlobalSettings,
  CliAgentSettings,
  RemoteAccessProvidersConfig,
  RemoteAccessTokenStrategyConfig,
  RemoteAccessLifecycleConfig,
  RemoteAccessProjectSettings,
  SecretsEnvSettings,
  ProjectSettings,
  Settings,
} from "./types/settings-scope.js";
export type {
  SettingsScope,
  WebSearchBackend,
  SandboxBackendName,
  SandboxFailureMode,
  EvalFollowUpPolicy,
  AgentMemoryInclusionMode,
  HeartbeatScopeDisciplineMode,
  HeartbeatPromptTemplate,
  WorktrunkOnFailure,
  McpSensitiveValue,
  McpTransport,
  McpServerDefinition,
  RemoteAccessProvider,
  GithubAuthMode,
  GitlabAuthTokenType,
  SecretsEnvConfig,
  ReportMode,
  ReportActionType,
  ReportTarget,
  DaemonTokenSettings,
  ResearchEnabledSources,
  ResearchGlobalDefaults,
  ResearchProjectLimits,
  ResearchProjectSettings,
  SandboxPolicy,
  SandboxProjectSettings,
  EvalProjectSettings,
  ResolvedEvalSettings,
  OpenRouterModelFilters,
  OpenRouterProviderPreferences,
  WorktrunkSettings,
  McpSecretRef,
  McpStdioTransport,
  McpSseTransport,
  McpStreamableHttpTransport,
  McpServersSettings,
  DashboardKeyboardShortcuts,
  BackupSettingsMigrationCandidate,
  BackupSettingsMigrationConflict,
  GlobalSettings,
  CliAgentSettings,
  RemoteAccessProvidersConfig,
  RemoteAccessTokenStrategyConfig,
  RemoteAccessLifecycleConfig,
  RemoteAccessProjectSettings,
  SecretsEnvSettings,
  ProjectSettings,
  Settings,
};

// ── board-config ──────────────────────────────────────────────────────────
// FNXC:CodeOrganization 2026-07-22-14:00: Peels live in types/board-config.ts

import {
  COLUMN_LABELS,
  COLUMN_DESCRIPTIONS,
  VALID_TRANSITIONS,
} from "./types/board-config.js";
export {
  COLUMN_LABELS,
  COLUMN_DESCRIPTIONS,
  VALID_TRANSITIONS,
};

import type {
  AutostashOutcome,
  TaskCommitAssociationMatchSource,
  TaskCommitAssociationConfidence,
  BoardConfig,
  DistributedTaskIdReserveInput,
  DistributedTaskIdReserveResult,
  DistributedTaskIdCommitInput,
  DistributedTaskIdCommitResult,
  DistributedTaskIdAbortInput,
  DistributedTaskIdAbortResult,
  DistributedTaskIdStateInput,
  DistributedTaskIdStateResult,
  AutostashOrphanRecord,
  MergeResult,
  TaskCommitAssociation,
  CommitAssociationDiffBackfillReport,
} from "./types/board-config.js";
export type {
  AutostashOutcome,
  TaskCommitAssociationMatchSource,
  TaskCommitAssociationConfidence,
  BoardConfig,
  DistributedTaskIdReserveInput,
  DistributedTaskIdReserveResult,
  DistributedTaskIdCommitInput,
  DistributedTaskIdCommitResult,
  DistributedTaskIdAbortInput,
  DistributedTaskIdAbortResult,
  DistributedTaskIdStateInput,
  DistributedTaskIdStateResult,
  AutostashOrphanRecord,
  MergeResult,
  TaskCommitAssociation,
  CommitAssociationDiffBackfillReport,
};

// ── archive-planning ──────────────────────────────────────────────────────────
// FNXC:CodeOrganization 2026-07-22-12:00: Peels live in types/archive-planning.ts

import {
  formatPlanningPlanMd,
  validateDockerNodeConfig,
  sanitizeDockerNodeConfigForResponse,
} from "./types/archive-planning.js";
export {
  formatPlanningPlanMd,
  validateDockerNodeConfig,
  sanitizeDockerNodeConfigForResponse,
};

import type {
  PlanningQuestionType,
  IsolationMode,
  ProjectStatus,
  NodeStatus,
  NodeDiscoveryEvent,
  MeshWriteQueueStatus,
  PluginSyncAction,
  VersionCompatibilityStatus,
  ProjectInfo,
  PlanningResponse,
  ArchivedTaskEntry,
  DiscoveredNode,
  DiscoveryConfig,
  SystemMetrics,
  PeerNode,
  NodeMeshState,
  MeshClusterSnapshot,
  MeshDiscovery,
  PeerInfo,
  SnapshotBase,
  MeshSnapshotQuery,
  MeshSnapshotRecordInput,
  MeshSnapshotRecord,
  MeshWriteQueueInput,
  MeshWriteQueueFilter,
  MeshWriteQueueEntry,
  MeshWriteApplyResult,
  MeshWriteFailureResult,
  MeshWriteReplaySummary,
  MeshDegradedReadState,
  SharedMeshStatePayload,
  PeerSyncRequest,
  PeerSyncResponse,
  ProviderAuthEntry,
  SettingsSyncPayload,
  SettingsSyncState,
  SettingsSyncResult,
  NodeConfig,
  MeshConfigResult,
  PluginVersionEntry,
  PluginSyncEntry,
  PluginSyncResult,
  VersionCompatibilityResult,
  RegisteredProject,
  ProjectNodePathMapping,
  ProjectNodePathMappingUpsertInput,
  ProjectNodePathMappingDeleteInput,
  ProjectHealth,
  CentralActivityLogEntry,
  GlobalConcurrencyState,
  PlanningQuestion,
  PlanningSummary,
  PlanningSession,
  DockerNodeConfig,
  DockerNodeVolumeMount,
  DockerNodeContainerResourceConfig,
  DockerNodeHostConfig,
  DockerNodePersistenceConfig,
  NodeVersionInfo,
  NodeVersionInfoInput,
  DockerNodeStatus,
  DockerHostConfig,
  DockerResourceSizing,
  DockerVolumeMount,
  DockerExtraCli,
  ManagedDockerNode,
  ManagedDockerNodeInput,
  ManagedDockerNodeUpdate,
  MeshConfigGeneratorInput,
  FullProvisioningInput,
  MeshConnectionConfig,
  DockerContextInfo,
  DockerConnectivityResult,
  DockerContainerInspectResult,
  DockerNodeImageConfig,
  DockerNodeResourceConfig,
  DockerProvisionInput,
  DockerProvisionResult,
} from "./types/archive-planning.js";
export type {
  PlanningQuestionType,
  IsolationMode,
  ProjectStatus,
  NodeStatus,
  NodeDiscoveryEvent,
  MeshWriteQueueStatus,
  PluginSyncAction,
  VersionCompatibilityStatus,
  ProjectInfo,
  PlanningResponse,
  ArchivedTaskEntry,
  DiscoveredNode,
  DiscoveryConfig,
  SystemMetrics,
  PeerNode,
  NodeMeshState,
  MeshClusterSnapshot,
  MeshDiscovery,
  PeerInfo,
  SnapshotBase,
  MeshSnapshotQuery,
  MeshSnapshotRecordInput,
  MeshSnapshotRecord,
  MeshWriteQueueInput,
  MeshWriteQueueFilter,
  MeshWriteQueueEntry,
  MeshWriteApplyResult,
  MeshWriteFailureResult,
  MeshWriteReplaySummary,
  MeshDegradedReadState,
  SharedMeshStatePayload,
  PeerSyncRequest,
  PeerSyncResponse,
  ProviderAuthEntry,
  SettingsSyncPayload,
  SettingsSyncState,
  SettingsSyncResult,
  NodeConfig,
  MeshConfigResult,
  PluginVersionEntry,
  PluginSyncEntry,
  PluginSyncResult,
  VersionCompatibilityResult,
  RegisteredProject,
  ProjectNodePathMapping,
  ProjectNodePathMappingUpsertInput,
  ProjectNodePathMappingDeleteInput,
  ProjectHealth,
  CentralActivityLogEntry,
  GlobalConcurrencyState,
  PlanningQuestion,
  PlanningSummary,
  PlanningSession,
  DockerNodeConfig,
  DockerNodeVolumeMount,
  DockerNodeContainerResourceConfig,
  DockerNodeHostConfig,
  DockerNodePersistenceConfig,
  NodeVersionInfo,
  NodeVersionInfoInput,
  DockerNodeStatus,
  DockerHostConfig,
  DockerResourceSizing,
  DockerVolumeMount,
  DockerExtraCli,
  ManagedDockerNode,
  ManagedDockerNodeInput,
  ManagedDockerNodeUpdate,
  MeshConfigGeneratorInput,
  FullProvisioningInput,
  MeshConnectionConfig,
  DockerContextInfo,
  DockerConnectivityResult,
  DockerContainerInspectResult,
  DockerNodeImageConfig,
  DockerNodeResourceConfig,
  DockerProvisionInput,
  DockerProvisionResult,
};

// ── Agent Types ────────────────────────────────────────────────────────────


import {
  AGENT_STATES,
  AGENT_VALID_TRANSITIONS,
  isEphemeralAgent,
  hasAgentIdentity,
} from "./types/agent-state.js";
import type { AgentState } from "./types/agent-state.js";
export {
  AGENT_STATES,
  AGENT_VALID_TRANSITIONS,
  isEphemeralAgent,
  hasAgentIdentity,
};
export type { AgentState };

/** Heartbeat event/run types peeled into types/agents.ts */
import type { AgentHeartbeatEvent, AgentHeartbeatRun, HeartbeatInvocationSource } from "./types/agents.js";
export type { AgentHeartbeatEvent, AgentHeartbeatRun, HeartbeatInvocationSource };

/*
FNXC:AutomationTools 2026-06-26-00:00:
Dashboard source-checkout builds alias @fusion/core to this frontend-safe module, so mirror the automation AI-step tool catalog here as a runtime export for UI selectors.
*/
export const AUTOMATION_SELECTABLE_TOOLS = ["Read", "Bash", "Edit", "Write", "Grep", "Find", "Ls"] as const;

/** Snapshot of the last blocked state for a task, used for dedup comparison. */
export interface BlockedStateSnapshot {
  /** The task ID that was blocked */
  taskId: string;
  /** What the task was blocked by (dependency IDs, overlapping task ID) */
  blockedBy: string;
  /** ISO-8601 timestamp when this blocked state was recorded */
  recordedAt: string;
  /** Hash of relevant context at the time (comment count, last comment ID) */
  contextHash: string;
}

/** Capabilities/roles an agent can have */
import type { AgentCapability } from "./types/agents.js";
export type { AgentCapability };

/** A configurable agent role prompt template. */
export interface AgentPromptTemplate {
  /** Unique identifier (e.g., "default-executor", "senior-engineer") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of this template's behavioral style */
  description: string;
  /** The agent role this template applies to */
  role: AgentCapability;
  /** The system prompt content for this template */
  prompt: string;
  /** Whether this is a built-in template (true) or user-created (false) */
  builtIn?: boolean;
}

/** Configuration for per-agent prompts stored in project settings. */
export interface AgentPromptsConfig {
  /** Custom prompt templates. Built-in templates are always available. */
  templates?: AgentPromptTemplate[];
  /** Mapping from agent role to template ID.
   *  When set, overrides the default built-in prompt for that role.
   *  Key is the AgentCapability string, value is a template ID. */
  roleAssignments?: Partial<Record<AgentCapability, string>>;
}

// ── plugin-activation ──────────────────────────────────────────────────────────
// FNXC:CodeOrganization 2026-07-22-14:00: Peels live in types/plugin-activation.ts

import type {
  PluginActivation,
  PluginActivationInput,
} from "./types/plugin-activation.js";
export type {
  PluginActivation,
  PluginActivationInput,
};

// ── run-audit ──────────────────────────────────────────────────────────
// FNXC:CodeOrganization 2026-07-20-10:00: Peels live in types/run-audit.ts

import type {
  RunAuditDomain,
  RunAuditEvent,
  RunAuditEventFilter,
  RunAuditEventInput,
  RunAuditMutationType,
} from "./types/run-audit.js";
export type {
  RunAuditDomain,
  RunAuditEvent,
  RunAuditEventFilter,
  RunAuditEventInput,
  RunAuditMutationType,
};

// ── planner-intervention ──────────────────────────────────────────────────────────
// FNXC:CodeOrganization 2026-07-20-10:00: Peels live in types/planner-intervention.ts

import {
  OVERSEER_INTERVENTION_MUTATION,
} from "./types/planner-intervention.js";
export {
  OVERSEER_INTERVENTION_MUTATION,
};
import type {
  PlannerInterventionAction,
  PlannerInterventionEntry,
  PlannerInterventionOutcome,
  PlannerInterventionSourceLink,
  PlannerOversightStage,
} from "./types/planner-intervention.js";
export type {
  PlannerInterventionAction,
  PlannerInterventionEntry,
  PlannerInterventionOutcome,
  PlannerInterventionSourceLink,
  PlannerOversightStage,
};

// ── Agent Permission / Entity Types ─────────────────────────────────────────
// FNXC:CodeOrganization 2026-07-18-14:00: Peels live in types/agents.ts; keep stable re-exports here.

import {
  AGENT_PERMISSIONS,
  AGENT_PERMISSION_POLICY_ACTION_CATEGORIES,
  AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES,
  AGENT_PERMISSION_POLICY_EXEMPT_TOOL_EXAMPLES,
  AGENT_PERMISSION_POLICY_PRESET_IDS,
  AGENT_PROVISIONING_APPROVAL_MODES,
  APPROVAL_REQUEST_AUDIT_EVENT_TYPES,
  APPROVAL_REQUEST_STATUSES,
  DEFAULT_HEARTBEAT_PROCEDURE_PATH,
  LEGACY_AGENT_PERMISSION_POLICY_ACTION_CATEGORY_ALIASES,
  PERMANENT_AGENT_ACTION_CATEGORIES,
  SANDBOX_PROVISIONING_APPROVAL_MODES,
  SECRET_ACCESS_POLICIES,
  agentToConfigSnapshot,
  diffConfigSnapshots,
  getCanonicalAgentAssetDirectoryName,
  getCanonicalAgentInstructionsBundleDirName,
  getDefaultHeartbeatProcedurePath,
  getLegacyAgentAssetDirectoryName,
  getLegacyAgentInstructionsBundleDirName,
  getSafeAgentAssetIdSegment,
  isValidApprovalRequestTransition,
  normalizeApprovalRequestActionCategory,
} from "./types/agents.js";
export {
  AGENT_PERMISSIONS,
  AGENT_PERMISSION_POLICY_ACTION_CATEGORIES,
  AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES,
  AGENT_PERMISSION_POLICY_EXEMPT_TOOL_EXAMPLES,
  AGENT_PERMISSION_POLICY_PRESET_IDS,
  AGENT_PROVISIONING_APPROVAL_MODES,
  APPROVAL_REQUEST_AUDIT_EVENT_TYPES,
  APPROVAL_REQUEST_STATUSES,
  DEFAULT_HEARTBEAT_PROCEDURE_PATH,
  LEGACY_AGENT_PERMISSION_POLICY_ACTION_CATEGORY_ALIASES,
  PERMANENT_AGENT_ACTION_CATEGORIES,
  SANDBOX_PROVISIONING_APPROVAL_MODES,
  SECRET_ACCESS_POLICIES,
  agentToConfigSnapshot,
  diffConfigSnapshots,
  getCanonicalAgentAssetDirectoryName,
  getCanonicalAgentInstructionsBundleDirName,
  getDefaultHeartbeatProcedurePath,
  getLegacyAgentAssetDirectoryName,
  getLegacyAgentInstructionsBundleDirName,
  getSafeAgentAssetIdSegment,
  isValidApprovalRequestTransition,
  normalizeApprovalRequestActionCategory,
};
import type {
  Agent,
  AgentAccessState,
  AgentApiKey,
  AgentApiKeyCreateResult,
  AgentBudgetConfig,
  AgentBudgetStatus,
  AgentConfigRevision,
  AgentConfigSnapshot,
  AgentCreateInput,
  AgentDetail,
  AgentHeartbeatConfig,
  AgentPerformanceSummary,
  AgentPermission,
  AgentPermissionPolicy,
  AgentPermissionPolicyActionCategory,
  AgentPermissionPolicyDisposition,
  AgentPermissionPolicyPresetId,
  AgentPermissionPolicyRules,
  AgentPermissionPolicyToolRules,
  AgentProvisioningApprovalMode,
  AgentRating,
  AgentRatingInput,
  AgentRatingSummary,
  AgentReflection,
  AgentStats,
  AgentTaskSession,
  AgentUpdateInput,
  ApprovalRequest,
  ApprovalRequestActionCategory,
  ApprovalRequestActionCategoryInput,
  ApprovalRequestActorSnapshot,
  ApprovalRequestAuditEvent,
  ApprovalRequestAuditEventType,
  ApprovalRequestCompletionInput,
  ApprovalRequestCreateInput,
  ApprovalRequestDecisionInput,
  ApprovalRequestListInput,
  ApprovalRequestStatus,
  ApprovalRequestTargetAction,
  ConfigChangedBy,
  ConfigKind,
  ConfigurationOwnerScope,
  ConfigurationRevision,
  ConfigurationTarget,
  InstructionsBundleConfig,
  LegacyAgentPermissionPolicyActionCategory,
  MessageResponseMode,
  OrgTreeNode,
  PermanentAgentActionCategory,
  PermanentAgentGatingContext,
  PermanentAgentSensitiveActionCategory,
  ReflectionMetrics,
  ReflectionTrigger,
  RevisionFieldDiff,
  SandboxProvisioningApprovalMode,
  SecretAccessPolicy,
  TaskAssignSource,
} from "./types/agents.js";
export type {
  Agent,
  AgentAccessState,
  AgentApiKey,
  AgentApiKeyCreateResult,
  AgentBudgetConfig,
  AgentBudgetStatus,
  AgentConfigRevision,
  AgentConfigSnapshot,
  AgentCreateInput,
  AgentDetail,
  AgentHeartbeatConfig,
  AgentPerformanceSummary,
  AgentPermission,
  AgentPermissionPolicy,
  AgentPermissionPolicyActionCategory,
  AgentPermissionPolicyDisposition,
  AgentPermissionPolicyPresetId,
  AgentPermissionPolicyRules,
  AgentPermissionPolicyToolRules,
  AgentProvisioningApprovalMode,
  AgentRating,
  AgentRatingInput,
  AgentRatingSummary,
  AgentReflection,
  AgentStats,
  AgentTaskSession,
  AgentUpdateInput,
  ApprovalRequest,
  ApprovalRequestActionCategory,
  ApprovalRequestActionCategoryInput,
  ApprovalRequestActorSnapshot,
  ApprovalRequestAuditEvent,
  ApprovalRequestAuditEventType,
  ApprovalRequestCompletionInput,
  ApprovalRequestCreateInput,
  ApprovalRequestDecisionInput,
  ApprovalRequestListInput,
  ApprovalRequestStatus,
  ApprovalRequestTargetAction,
  ConfigChangedBy,
  ConfigKind,
  ConfigurationOwnerScope,
  ConfigurationRevision,
  ConfigurationTarget,
  InstructionsBundleConfig,
  LegacyAgentPermissionPolicyActionCategory,
  MessageResponseMode,
  OrgTreeNode,
  PermanentAgentActionCategory,
  PermanentAgentGatingContext,
  PermanentAgentSensitiveActionCategory,
  ReflectionMetrics,
  ReflectionTrigger,
  RevisionFieldDiff,
  SandboxProvisioningApprovalMode,
  SecretAccessPolicy,
  TaskAssignSource,
};

// ── multiproject-setup ──────────────────────────────────────────────────────────
// FNXC:CodeOrganization 2026-07-22-14:00: Peels live in types/multiproject-setup.ts

import type {
  DetectedProject,
  SetupState,
  ProjectSetupInput,
  SetupCompletionResult,
  MigrationOptions,
  MigrationResult,
} from "./types/multiproject-setup.js";
export type {
  DetectedProject,
  SetupState,
  ProjectSetupInput,
  SetupCompletionResult,
  MigrationOptions,
  MigrationResult,
};

// ── Messaging Types ──────────────────────────────────────────────────────────
// FNXC:CodeOrganization 2026-07-18-00:35: Keep stable re-exports after main
// landed task-proposal metadata + ephemeral policy on the mailbox contract.

import {
  DASHBOARD_USER_ID,
  normalizeMessageParticipant,
  resolveEphemeralTaskCreationPolicy,
} from "./types/messages.js";
export {
  DASHBOARD_USER_ID,
  normalizeMessageParticipant,
  resolveEphemeralTaskCreationPolicy,
};
import type {
  ParticipantType,
  MessageType,
  MessageReplyReference,
  EphemeralTaskCreationPolicy,
  ProposedTaskMetadata,
  NativeStructureEmbed,
  MessageMetadata,
  Message,
  MessageCreateInput,
  MessageFilter,
} from "./types/messages.js";
export type {
  ParticipantType,
  MessageType,
  MessageReplyReference,
  EphemeralTaskCreationPolicy,
  ProposedTaskMetadata,
  NativeStructureEmbed,
  MessageMetadata,
  Message,
  MessageCreateInput,
  MessageFilter,
};

/** Validate mailbox metadata, including reply-link contract when present. */
export function validateMessageMetadata(metadata: MessageMetadata | undefined): void {
  if (!metadata) {
    return;
  }

  if (metadata.replyTo !== undefined) {
    if (typeof metadata.replyTo !== "object" || metadata.replyTo === null || Array.isArray(metadata.replyTo)) {
      throw new Error("metadata.replyTo must be an object");
    }

    if (typeof metadata.replyTo.messageId !== "string" || metadata.replyTo.messageId.trim().length === 0) {
      throw new Error("metadata.replyTo.messageId must be a non-empty string");
    }
  }

  if (metadata.wakeRecipient !== undefined && typeof metadata.wakeRecipient !== "boolean") {
    throw new Error("metadata.wakeRecipient must be a boolean");
  }

  /*
  FNXC:NativeStructureEmbed 2026-07-19-12:30:
  Mail accepts only the shared six-kind NativeStructureRef union. The roadmap item uses the
  plugin-owned read adapter at render time, so attachment metadata remains a ref rather than a
  duplicated persistence snapshot; labels are optional attach-time fallbacks.
  */
  if (metadata.nativeStructures !== undefined) {
    if (!Array.isArray(metadata.nativeStructures)) {
      throw new Error("metadata.nativeStructures must be an array");
    }
    const supportedKinds: NativeStructureRef["kind"][] = ["mission", "milestone", "research-finding", "eval-result", "goal", "roadmap-item"];
    for (const embed of metadata.nativeStructures) {
      if (typeof embed !== "object" || embed === null || Array.isArray(embed)) {
        throw new Error("metadata.nativeStructures entries must be objects");
      }
      if (!supportedKinds.includes(embed.kind)) {
        throw new Error("metadata.nativeStructures.kind is invalid");
      }
      if (typeof embed.id !== "string" || embed.id.trim().length === 0) {
        throw new Error("metadata.nativeStructures.id must be a non-empty string");
      }
      if (embed.projectId !== undefined && (typeof embed.projectId !== "string" || embed.projectId.trim().length === 0)) {
        throw new Error("metadata.nativeStructures.projectId must be a non-empty string");
      }
      if (embed.label !== undefined && typeof embed.label !== "string") {
        throw new Error("metadata.nativeStructures.label must be a string");
      }
    }
  }

  const proposalFieldsPresent = metadata.proposalStatus !== undefined || metadata.createdTaskId !== undefined || metadata.proposalIdempotencyKey !== undefined || metadata.claimOwnerToken !== undefined || metadata.claimStartedAt !== undefined;
  if (metadata.kind === "task-proposal" || proposalFieldsPresent || metadata.proposedTask !== undefined) {
    if (metadata.kind !== "task-proposal" || !metadata.proposedTask) throw new Error("task proposal metadata requires kind and proposedTask");
    const proposal = metadata.proposedTask;
    if (typeof proposal.title !== "string" || !proposal.title.trim() || typeof proposal.description !== "string" || !proposal.description.trim()) throw new Error("metadata.proposedTask requires non-empty title and description");
    if (proposal.dependencies !== undefined && (!Array.isArray(proposal.dependencies) || proposal.dependencies.some((id) => typeof id !== "string"))) throw new Error("metadata.proposedTask.dependencies must be string[]");
    if (proposal.priority !== undefined && !["low", "normal", "high", "urgent"].includes(proposal.priority)) throw new Error("metadata.proposedTask.priority is invalid");
    if (metadata.proposalStatus !== undefined && !["pending", "creating", "created", "dismissed"].includes(metadata.proposalStatus)) throw new Error("metadata.proposalStatus is invalid");
    if (typeof metadata.proposalIdempotencyKey !== "string" || !metadata.proposalIdempotencyKey.trim()) throw new Error("task proposal requires proposalIdempotencyKey");
    if (metadata.claimStartedAt !== undefined && (typeof metadata.claimStartedAt !== "string" || Number.isNaN(Date.parse(metadata.claimStartedAt)))) throw new Error("metadata.claimStartedAt must be an ISO timestamp");
    if (metadata.proposalStatus === "pending" && (metadata.claimOwnerToken !== undefined || metadata.claimStartedAt !== undefined)) throw new Error("pending proposal cannot have a creation lease");
  }
}

/** Mailbox summary for a participant */
export interface Mailbox {
  /** Owner identifier */
  ownerId: string;
  /** Owner type */
  ownerType: ParticipantType;
  /** Number of unread messages */
  unreadCount: number;
  /** Most recent message (if any) */
  lastMessage?: Message;
}


// Re-export PROMPT_KEY_CATALOG for backward compatibility with vite alias
export { PROMPT_KEY_CATALOG } from "./prompt-overrides.js";

// Re-exported here so the dashboard's `@fusion/core` → types.ts alias resolves
// client-side consumers (see packages/dashboard/vite.config.ts).
export { getErrorMessage } from "./error-message.js";
export {
  resolveExecutionSettingsModel,
  resolvePlanningSettingsModel,
  resolveProjectDefaultModel,
  resolveTaskExecutionModel,
  resolveTaskMergerModel,
  resolveTaskPlanningModel,
  resolveTaskValidatorModel,
  resolveTitleSummarizerSettingsModel,
  resolveValidatorSettingsModel,
} from "./model-resolution.js";
export type { ResolvedModelSelection } from "./model-resolution.js";
export { resolveResearchSettings } from "./research-settings.js";
export { resolveResearchFindingId } from "./research-types.js";
export type { ResolvedResearchSettings } from "./research-settings.js";

/*
FNXC:WorkflowLifecycleAutofix 2026-07-12-13:00:
The workflow editor recomputes lifecycle warnings client-side as the graph is
edited (so the banner clears without a save round-trip) and offers one-click
fixes that insert the canonical completion-summary node. Both helpers are
pure (types + string constants only), so they are safe to re-export through
this browser-safe alias entry.
*/
export { analyzeWorkflowLifecycle } from "./workflow-lifecycle-validation.js";
export type { WorkflowLifecycleWarning, WorkflowLifecycleWarningCode } from "./workflow-lifecycle-validation.js";
export {
  completionSummaryNode,
  isCompletionSummaryNode,
  COMPLETION_SUMMARY_NODE_ID,
} from "./builtin-completion-summary-node.js";
