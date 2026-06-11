export { COLUMNS, DEFAULT_COLUMN, isColumn, normalizeColumn, COLUMN_LABELS, COLUMN_DESCRIPTIONS, VALID_TRANSITIONS, DEFAULT_SETTINGS, DEFAULT_GLOBAL_SETTINGS, DEFAULT_PROJECT_SETTINGS, GLOBAL_SETTINGS_KEYS, PROJECT_SETTINGS_KEYS, isGlobalSettingsKey, isProjectSettingsKey, isMergeRequestContractShadowEnabled, resolvePersistAgentThinkingLog, THINKING_LEVELS, THEME_MODES, COLOR_THEMES, SUPPORTED_LOCALES, DEFAULT_LOCALE, isLocale, WORKFLOW_STEP_TEMPLATES, AGENT_PERMISSIONS, PERMANENT_AGENT_ACTION_CATEGORIES, AGENT_PERMISSION_POLICY_ACTION_CATEGORIES, AGENT_PROVISIONING_APPROVAL_MODES, SANDBOX_PROVISIONING_APPROVAL_MODES, AGENT_PERMISSION_POLICY_PRESET_IDS, LEGACY_AGENT_PERMISSION_POLICY_ACTION_CATEGORY_ALIASES, APPROVAL_REQUEST_STATUSES, APPROVAL_REQUEST_AUDIT_EVENT_TYPES, normalizeApprovalRequestActionCategory, isValidApprovalRequestTransition, agentToConfigSnapshot, diffConfigSnapshots, isEphemeralAgent, hasAgentIdentity, CheckoutConflictError, DEFAULT_HEARTBEAT_PROCEDURE_PATH, getDefaultHeartbeatProcedurePath, EXECUTION_MODES, DEFAULT_EXECUTION_MODE, TASK_PRIORITIES, DEFAULT_TASK_PRIORITY, WORKFLOW_WORK_ITEM_KINDS, WORKFLOW_WORK_ITEM_STATES, HIGH_FANOUT_BLOCKER_TODO_THRESHOLD, STALE_HIGH_FANOUT_BLOCKER_AGE_THRESHOLD_MS, DASHBOARD_USER_ID, normalizeMessageParticipant, validateMessageMetadata, validateDockerNodeConfig, sanitizeDockerNodeConfigForResponse, normalizeMergeIntegrationWorktreeMode, normalizeMergeAdvanceAutoSyncMode, MERGE_ADVANCE_AUTO_SYNC_MODES, normalizeMergeConflictStrategy, normalizeMergeStrategyOverlapBehavior, normalizePostMergeAuditMode, POST_MERGE_AUDIT_MODES, normalizeMergeAuditAutoRecovery, MERGE_AUDIT_AUTO_RECOVERY_MODES, normalizeMergerMode, MERGER_MODES, normalizeAutoRecovery, AUTO_RECOVERY_MODES, buildResearchDocumentKey, REPO_OVERRIDE_RE, SHARED_STATE_SNAPSHOT_VERSION, sanitizeCliAgentSettings, sanitizeCliAgentsSettings, CLI_AGENT_ADAPTER_IDS, CLI_AGENT_AUTONOMY_MODES } from "./types.js";
export type { Column, ColumnId, IssueInfo, IssueState, TaskSourceIssue, PrInfo, PrConflictState, PrConflictDiagnostics, PrCheckState, PrCheckStatus, PrStatus, BranchGroup, BranchGroupCreateInput, BranchGroupUpdate, BranchGroupPrState, Task, TaskTokenUsage, TaskAttachment, TaskComment, TaskCommentInput, TaskDocument, TaskDocumentRevision, TaskDocumentCreateInput, TaskDocumentWithTask, TaskCreateInput, MeshReplicatedTaskCreatePayload, MeshReplicatedTaskApplyResult, TaskSource, SourceType, TaskDetail, RetrySummary, InboxTask, TodoList, TodoItem, TodoListCreateInput, TodoListUpdateInput, TodoItemCreateInput, TodoItemUpdateInput, TodoListWithItems, AgentLogEntry, AgentLogType, AgentRole, BoardConfig, DistributedTaskIdReserveInput, DistributedTaskIdReserveResult, DistributedTaskIdCommitInput, DistributedTaskIdCommitResult, DistributedTaskIdAbortInput, DistributedTaskIdAbortResult, DistributedTaskIdStateInput, DistributedTaskIdStateResult, AutostashOrphanRecord, AutostashOutcome, MergeDetails, MergeResult, MergeIntegrationWorktreeMode, MergeAdvanceAutoSyncMode, MergeConflictStrategy, CanonicalMergeConflictStrategy, MergeStrategyOverlapBehavior, PostMergeAuditMode, MergeAuditAutoRecoveryMode, MergerMode, MergerSettings, AutoRecoveryMode, AutoRecoveryFailureClass, AutoRecoverySettings, DirectMergeCommitStrategy, Settings, GlobalSettings, ProjectSettings, SecretsEnvConfig, WebSearchBackend, ResearchEnabledSources, ResearchGlobalDefaults, ResearchProjectLimits, ResearchProjectSettings, SandboxBackendName, SandboxFailureMode, SandboxPolicy, SandboxProjectSettings, EvalFollowUpPolicy, EvalProjectSettings, ResolvedEvalSettings, SettingsScope, DaemonTokenSettings, TaskStep, StepStatus, TaskLogEntry, RunMutationContext, ActivityLogEntry, ActivityEventType, ThinkingLevel, ThemeMode, ColorTheme, Locale, ExecutionMode, TaskPriority, MergeQueueEntry, MergeQueueEnqueueOptions, MergeQueueAcquireOptions, MergeQueueReleaseOutcome, MergeRequestState, MergeRequestRecord, MergeRequestWorkflowProjectionOptions, CompletionHandoffMarker, WorkflowWorkItem, WorkflowWorkItemDueFilter, WorkflowWorkItemKind, WorkflowWorkItemState, WorkflowWorkItemTransitionPatch, WorkflowWorkItemUpsertInput, HandoffEvidence, HandoffToReviewOptions, UnavailableNodePolicy, OwningNodeHandoffPolicy, PlanningQuestion, PlanningSummary, PlanningResponse, PlanningQuestionType, ArchivedTaskEntry, BatchStatusRequest, BatchStatusResponse, BatchStatusEntry, BatchStatusResult, GithubIssueAction, ModelPreset, WorkflowStep, WorkflowStepMode, WorkflowStepGateMode, WorkflowStepPhase, WorkflowStepInput, WorkflowStepResult, WorkflowStepTemplate, Agent, OrgTreeNode, AgentState, AgentDetail, AgentCreateInput, AgentUpdateInput, AgentApiKey, AgentApiKeyCreateResult, AgentCapability, AgentPromptTemplate, AgentPromptsConfig, AgentPermission, PermanentAgentActionCategory, PermanentAgentSensitiveActionCategory, PermanentAgentGatingContext, AgentPermissionPolicy, AgentPermissionPolicyRules, AgentPermissionPolicyActionCategory, AgentProvisioningApprovalMode, SandboxProvisioningApprovalMode, LegacyAgentPermissionPolicyActionCategory, ApprovalRequestActionCategoryInput, ApprovalRequestActionCategory, AgentPermissionPolicyDisposition, AgentPermissionPolicyPresetId, ApprovalRequestStatus, ApprovalRequestAuditEventType, ApprovalRequestActorSnapshot, ApprovalRequestTargetAction, ApprovalRequestAuditEvent, ApprovalRequest, ApprovalRequestCreateInput, ApprovalRequestDecisionInput, ApprovalRequestCompletionInput, ApprovalRequestListInput, TaskAssignSource, AgentAccessState, AgentHeartbeatConfig, AgentBudgetConfig, AgentBudgetStatus, InstructionsBundleConfig, MessageResponseMode, AgentHeartbeatEvent, AgentHeartbeatRun, BlockedStateSnapshot, HeartbeatInvocationSource, AgentTaskSession, AgentRating, AgentRatingSummary, AgentRatingInput, AgentConfigSnapshot, RevisionFieldDiff, AgentConfigRevision, AgentStats, ReflectionTrigger, ReflectionMetrics, AgentReflection, AgentPerformanceSummary, NtfyNotificationEvent, NotificationEvent, NotificationPayload, NotificationProviderConfig, CustomProvider, SteeringComment, ParticipantType, MessageType, Message, MessageCreateInput, MessageFilter, MessageMetadata, MessageReplyReference, Mailbox, CheckoutLease, CheckoutClaimPrecondition, TaskClaimRow, CentralClaimStore, RunAuditDomain, RunAuditEvent, RunAuditEventInput, RunAuditEventFilter, AgentMemoryInclusionMode, HeartbeatPromptTemplate, HeartbeatScopeDisciplineMode, WorktrunkSettings, WorktrunkOnFailure, TaskBranchContext, CliAgentSettings } from "./types.js";
export { AGENT_VALID_TRANSITIONS, DUPLICATE_OF_METADATA_KEY } from "./types.js";
export {
  resolveEntryPointBranchAssignment,
  sanitizeBranchSegment,
  derivePerTaskBranchName,
  deriveAutoTaskBranchName,
  isValidBranchGroupBranchName,
  validateBranchGroupBranchName,
  filterTasksByBranchGroup,
} from "./branch-assignment.js";
export type {
  EntryPointAssignmentMode,
  EntryPointBranchAssignmentInput,
  EntryPointBranchAssignment,
} from "./branch-assignment.js";
export { customProviderRegistryKey } from "./custom-provider-key.js";
export { redactSecrets } from "./redact-secrets.js";
export { MOCK_PROVIDER_ID } from "./mock-provider-constants.js";
export type { MockProviderId, MockSessionPurpose } from "./mock-provider-constants.js";
export {
  resolveWorktrunkSettings,
  requiresWorktrunkInstallVerification,
  validateWorktrunkSettings,
  DEFAULT_WORKTRUNK_SETTINGS,
} from "./worktrunk-settings.js";
export {
  resolveAgentMemoryInclusionMode,
  type AgentMemoryInclusionModeSource,
  type ResolveAgentMemoryInclusionModeInput,
  type ResolvedAgentMemoryInclusionMode,
} from "./agent-memory-mode.js";
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
export {
  parseWorkflowIr,
  serializeWorkflowIr,
  stripApprovalBypassFlags,
  WorkflowIrError,
  DEFAULT_WORKFLOW_COLUMN_IDS,
  WORKFLOW_SETTING_TYPES,
  SETTING_RENDER_WIDGETS,
} from "./workflow-ir.js";
export type {
  WorkflowIr,
  WorkflowIrV1,
  WorkflowIrV2,
  WorkflowIrNode,
  WorkflowIrEdge,
  WorkflowIrNodeKind,
  WorkflowIrColumn,
  WorkflowIrColumnTrait,
  WorkflowColumnAgent,
  WorkflowHoldRelease,
  WorkflowJoinMode,
  WorkflowJoinBranchFailure,
  // Step-inversion (KTD-3/12/13): foreach / artifacts / custom-field IR types.
  WorkflowForeachConfig,
  WorkflowLoopConfig,
  WorkflowLoopExitCondition,
  WorkflowIrArtifact,
  WorkflowFieldDefinition,
  WorkflowFieldType,
  WorkflowFieldOption,
  WorkflowFieldRender,
  // Workflow-settings (U1): typed setting declaration IR types.
  WorkflowSettingDefinition,
  WorkflowSettingType,
  WorkflowSettingOption,
  WorkflowSettingRender,
  // CLI Agent Executor (U7): node-config executor typing.
  WorkflowNodeExecutorKind,
  WorkflowNodeExecutorConfig,
} from "./workflow-ir-types.js";
export {
  DEFAULT_MAX_REWORK_CYCLES,
  MAX_REWORK_CYCLES_CAP,
  resolveMaxReworkCycles,
} from "./workflow-ir-types.js";
export {
  instanceNodeId,
  parseInstanceNodeId,
  resolveColumnAgentBinding,
  resolveEffectiveAgent,
} from "./column-agent-resolver.js";
export type {
  ParsedInstanceNodeId,
  EffectiveAgentInput,
  EffectiveAgentResult,
} from "./column-agent-resolver.js";
export { BUILTIN_CODING_WORKFLOW_IR } from "./builtin-coding-workflow-ir.js";
export { BUILTIN_STEPWISE_CODING_WORKFLOW_IR } from "./builtin-stepwise-coding-workflow-ir.js";
export { BUILTIN_PR_WORKFLOW_IR } from "./builtin-pr-workflow-ir.js";
export { BUILTIN_WORKFLOW_SETTINGS } from "./builtin-workflow-settings.js";
export {
  MOVED_SETTINGS_KEYS,
  SETTINGS_MIGRATION_VERSION,
  SETTINGS_MIGRATION_MARKER_KEY,
  isMovedSettingsKey,
  stripMovedSettingsKeys,
  patchContainsMovedKey,
} from "./moved-settings.js";
export {
  ensureGitRepositoryForProjectPath,
  GitRepositoryInitializationError,
} from "./git-repository.js";
export {
  projectWorkflowWorkStatus,
  type WorkflowWorkProjection,
  type WorkflowWorkProjectionStatus,
} from "./workflow-work-projection.js";
export type {
  GitRepositoryCommandResult,
  GitRepositoryCommandRunner,
  GitRepositoryEnsureOutcome,
  EnsureGitRepositoryOptions,
} from "./git-repository.js";

// ── Trait model (U2) ─────────────────────────────────────────────────
export type {
  TraitDefinition,
  TraitFlags,
  TraitConfigSchema,
  TraitConfigField,
  TraitHookDescriptors,
  TraitHookKind,
  TraitHookImpl,
  RestrictedTraitFlag,
} from "./trait-types.js";
export { RESTRICTED_TRAIT_FLAGS, traitHookKey } from "./trait-types.js";
export {
  TraitRegistry,
  TraitRegistrationError,
  getTraitRegistry,
  getTrait,
  listTraits,
  resolveColumnFlags,
  validateColumnTraits,
  assertColumnTraitsValid,
  ColumnTraitValidationError,
  registerTraitHookImpl,
  __resetTraitRegistryForTests,
} from "./trait-registry.js";
export type {
  TraitRegistrationReason,
  TraitViolation,
  TraitViolationCode,
  TraitViolationSeverity,
  TraitAuditWarning,
} from "./trait-registry.js";
export {
  BUILTIN_TRAIT_IDS,
  BUILTIN_TRAIT_DEFINITIONS,
  registerBuiltinTraits,
} from "./builtin-traits.js";
export type { BuiltinTraitId } from "./builtin-traits.js";
// Step-inversion U12 (KTD-12): step-parser registry + built-ins.
export {
  StepParserRegistry,
  StepParserRegistrationError,
  getStepParserRegistry,
  registerStepParser,
  getStepParser,
  listStepParsers,
  unregisterStepParser,
  registerBuiltinStepParsers,
  parseStepHeadings,
  parseJsonSteps,
  __resetStepParserRegistryForTests,
} from "./step-parsers.js";
export type {
  StepParser,
  StepParseResult,
  ParsedStep,
  StepParserRegistrationReason,
} from "./step-parsers.js";
export {
  registerDefaultWorkflowHooks,
  __resetDefaultWorkflowHooksForTests,
} from "./default-workflow-hooks.js";
// ── Typed transition contract + crash-safe marker (U3) ───────────────
export type {
  TransitionRejection,
  TransitionRejectionCode,
  TransitionResult,
  TransitionPending,
} from "./transition-types.js";
export {
  TRANSITION_REJECTION_CODES,
  makeTransitionRejection,
  makeTransitionPending,
  transitionOk,
  transitionRejected,
  serializeTransitionRejection,
  deserializeTransitionRejection,
  serializeTransitionPending,
  deserializeTransitionPending,
} from "./transition-types.js";
export type {
  TransitionPendingDbHandle,
  ReconcileHooksResult,
} from "./transition-pending.js";
// ── U4: workflow-resolved transition adjacency + flag accessor ───────────────
export {
  resolveColumnAdjacency,
  resolveAllowedColumns,
  workflowHasColumn,
} from "./workflow-transitions.js";
export type { ColumnAdjacency } from "./workflow-transitions.js";
export { isWorkflowColumnsEnabled } from "./workflow-columns-settings.js";
// ── U8: pre-evaluated plugin gate verdicts (KTD-2) ───────────────────────────
export {
  findWorkflowColumn,
  resolveColumnPluginGates,
} from "./plugin-gate-verdict.js";
export type { PluginGateVerdict, ColumnPluginGate } from "./plugin-gate-verdict.js";
// ── U6: workflow capacity (WIP) resolution shared by store + sweep ───────────
export { resolveColumnCapacity, DEFAULT_WORKFLOW_POOL_ID } from "./workflow-capacity.js";
export type { ColumnCapacity } from "./workflow-capacity.js";
// ── U5: workflow lifecycle reconciliation (switch / edit / delete) ───────────
export {
  OccupiedColumnsError,
  InvalidRehomeTargetError,
  IncompatibleFieldChangeError,
  resolveEntryColumnId,
  resolveSwitchReconciliation,
  computeRemovedOccupiedColumns,
  computeIncompatibleFieldChanges,
  assertRehomeTargetValid,
  setReconciliationAbort,
  runReconciliationAbort,
  __resetReconciliationAbortForTests,
} from "./workflow-reconciliation.js";
export type {
  SwitchReconciliation,
  ColumnOccupancy,
  IncompatibleFieldChange,
  ReconciliationAbort,
  ReconciliationAbortContext,
} from "./workflow-reconciliation.js";
export {
  validateCustomFieldPatch,
  applyFieldDefaults,
  reconcileFieldsOnWorkflowChange,
  makeCustomFieldRejection,
  CustomFieldRejectionError,
  CUSTOM_FIELD_REJECTION_CODES,
} from "./task-fields.js";
export type {
  CustomFieldRejection,
  CustomFieldRejectionCode,
  CustomFieldPatchResult,
  FieldReconciliation,
} from "./task-fields.js";
export {
  validateSettingValuePatch,
  resolveEffectiveSettingValues,
  findOrphanedSettingValues,
  makeWorkflowSettingRejection,
  WorkflowSettingRejectionError,
  WORKFLOW_SETTING_REJECTION_CODES,
} from "./workflow-settings.js";
export type {
  WorkflowSettingRejection,
  WorkflowSettingRejectionCode,
  SettingValuePatchResult,
  OrphanedSettingValue,
} from "./workflow-settings.js";
export {
  readTransitionPending,
  writeTransitionPending,
  clearTransitionPending,
  reconcileHooksRemaining,
} from "./transition-pending.js";
export type {
  WorkflowDefinition,
  WorkflowDefinitionInput,
  WorkflowDefinitionUpdate,
  WorkflowDefinitionKind,
  WorkflowNodeLayout,
} from "./workflow-definition-types.js";
export {
  compileWorkflowToSteps,
  validateLinearity,
  WorkflowCompileError,
} from "./workflow-compiler.js";
export {
  stepsToWorkflowIr,
  stepToFragmentIr,
  layoutForIr,
} from "./workflow-steps-to-ir.js";
export {
  BUILTIN_WORKFLOWS,
  BUILTIN_WORKFLOW_ID_PREFIX,
  getBuiltinWorkflow,
  isBuiltinWorkflowId,
} from "./builtin-workflows.js";
export {
  resolveWorkflowIrForTask,
  resolveWorkflowIrById,
  type WorkflowIrResolverStore,
} from "./workflow-ir-resolver.js";
export {
  resolveEffectiveSettings,
  resolveEffectiveSettingsDetailed,
  resolveEffectiveSettingsById,
  type WorkflowSettingsResolverStore,
  type EffectiveSettingsResult,
  type EffectiveSettingsTaskRef,
} from "./workflow-settings-resolver.js";

// ── Engine wiring (set by @fusion/engine at module load) ────────────
export {
  setCreateFnAgent,
  getFnAgent,
  setCreateAiSessionFactory,
  getCreateAiSessionFactory,
  setCreateInteractiveAiSessionFactory,
  getCreateInteractiveAiSessionFactory,
  type AgentMessage,
} from "./ai-engine-loader.js";
export {
  setTaskCreatedHook,
  getTaskCreatedHook,
  type TaskCreatedHook,
} from "./task-creation-hooks.js";

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
  AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES,
  AGENT_PERMISSION_POLICY_EXEMPT_TOOL_EXAMPLES,
  getBuiltInAgentPermissionPolicyPresets,
  resolveAgentPermissionPolicyPreset,
  normalizeAgentPermissionPolicyFromPreset,
  normalizeAgentPermissionPolicy,
  resolveEffectiveAgentPermissionPolicy,
  isAgentPermissionPolicyPresetId,
  isPolicyBroaderThanDefault,
} from "./agent-permission-policy.js";
export type { BuiltInAgentPermissionPolicyPreset } from "./agent-permission-policy.js";
export {
  validateColumnAgentBindings,
  ColumnAgentBindingError,
} from "./column-agent-binding-validation.js";
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
export {
  resolveSandboxProvisioningPolicy,
  extractSandboxProvisioningRequest,
} from "./sandbox-provisioning-policy.js";
export { SECRET_ACCESS_POLICIES } from "./types.js";
export {
  SECRET_ACCESS_POLICY_FALLBACK,
  isSecretAccessPolicy,
  resolveSecretAccessPolicy,
} from "./secret-access-policy.js";
export type {
  AgentProvisioningTool,
  AgentProvisioningPolicyInput,
  AgentProvisioningPolicyDecision,
} from "./agent-provisioning-policy.js";
export type {
  SandboxProvisioningPolicyInput,
  SandboxProvisioningPolicyDecision,
} from "./sandbox-provisioning-policy.js";
export type {
  ResolveSecretAccessPolicyInput,
  ResolveSecretAccessPolicyDecision,
} from "./secret-access-policy.js";
export {
  TaskStore,
  SELF_DEFEATING_OPERATION_VERBS,
  detectSelfDefeatingDependency,
  detectDependencyCycle,
  SelfDefeatingDependencyError,
  DependencyCycleError,
  TaskDeletedError,
  TombstonedTaskResurrectionError,
  MergeQueueTaskNotFoundError,
  MergeQueueInvalidColumnError,
  MergeQueueLeaseOwnershipError,
  InvalidMergeQueueLeaseDurationError,
  HandoffInvariantViolationError,
  TransitionRejectionError,
} from "./store.js";
export {
  STOPWORDS,
  tokenize,
  computeContentFingerprint,
  findDuplicateMatches,
  type ContentFingerprintInput,
  type DuplicateCandidate,
  type DuplicateMatch,
  type DuplicateMatchInput,
} from "./duplicate-detection.js";
export {
  extractIntentSignature,
  findNearDuplicates,
  type IntentSignature,
  type NearDuplicateInput,
  type NearDuplicateCandidate,
  type NearDuplicateMatch,
} from "./near-duplicate.js";
export { getTaskDuplicateLineage } from "./duplicate-lineage.js";
export {
  parseExplicitDuplicateMarker,
  type ExplicitDuplicateMarker,
} from "./explicit-duplicate-marker.js";
export {
  __getDeterministicGuardMutexSize,
  deterministicGuardLocks,
  runDeterministicDuplicateGuard,
  reconcileDeterministicDuplicate,
  __deterministicGuardLocksForTests,
  type DeterministicGuardOptions,
  type DeterministicGuardOutcome,
} from "./duplicate-guard.js";
export type { TaskDependencyMutation } from "./store.js";
export {
  findSameAgentDuplicates,
  archiveAsSameAgentDuplicate,
  type SameAgentDuplicateInput,
  type SameAgentDuplicateCandidate,
  type SameAgentDuplicateMatch,
} from "./duplicate-intake.js";
export { computeRetrySummary, RETRY_STORM_WARNING_RATIO } from "./retry-summary.js";
export { RetryStormError, serializeRetryStormError } from "./retry-storm-error.js";
export { aggregateAgentTokenUsage } from "./agent-token-usage.js";
export type { AgentTokenUsageSummary, AgentTokenUsageWindowSummary } from "./agent-token-usage.js";
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
export {
  TASK_ID_TOKEN_RE,
  extractTaskIdTokens,
  hasTitleIdDrift,
  normalizeTitleForTaskId,
} from "./task-title-id-drift.js";
export { getPrimaryPrInfo } from "./task-helpers.js";
export {
  IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
  MANUAL_RETRY_RESET_COUNTER_KEYS,
  buildAutoPauseClearPatch,
  buildManualRetryResetPatch,
} from "./manual-retry-reset.js";
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
export {
  Database,
  createDatabase,
  toJson,
  toJsonNullable,
  fromJson,
  SCHEMA_VERSION,
} from "./db.js";
export {
  ProjectIdentityConflictError,
  ProjectIdentityMismatchError,
  readProjectIdentity,
  writeProjectIdentity,
} from "./project-identity.js";
export { ProcessSupervisor, superviseSpawn } from "./process-supervisor.js";
export type {
  SuperviseSpawnOptions,
  SupervisedChild,
  SupervisedExit,
} from "./process-supervisor.js";
export { DatabaseSync } from "./sqlite-adapter.js";
export type { Statement, VacuumResult } from "./db.js";
export type { ProjectIdentity } from "./project-identity.js";
export type { EnsureProjectForPathInput, EnsureProjectForPathResult } from "./central-core.js";
export { ArchiveDatabase } from "./archive-db.js";
export { detectLegacyData, migrateFromLegacy, getMigrationStatus } from "./db-migrate.js";
export { GlobalSettingsStore, resolveGlobalDir, resolveGlobalDirForHome } from "./global-settings.js";
export { isValidSqliteDatabaseFile } from "./sqlite-validation.js";
export { DaemonTokenManager, DAEMON_TOKEN_PREFIX, DAEMON_TOKEN_HEX_LENGTH, isDaemonTokenFormat } from "./daemon-token.js";
export {
  MasterKeyManager,
  MASTER_KEY_KEYCHAIN_SERVICE,
  MASTER_KEY_KEYCHAIN_ACCOUNT,
  MASTER_KEY_FILENAME,
  MasterKeyPermissionError,
  MasterKeyCorruptError,
} from "./master-key.js";
export {
  assertNotLinkedWorktreeOfExistingProject,
  assertProjectRootDir,
  LinkedWorktreeBootstrapRefusedError,
} from "./project-root-guard.js";
export { discoverPiExtensions, formatPiExtensionSource, getEnabledPiExtensionPaths, getFusionAgentDir, getFusionAgentSettingsPath, getLegacyPiAgentDir, getPiExtensionDiscoveryDirs, getProjectRootFromWorktree, reconcileClaudeCliPaths, reconcileDroidCliPaths, resolvePiExtensionProjectRoot, updatePiExtensionDisabledIds } from "./pi-extensions.js";
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
  computeDependencyBlockedTodoReport,
  DEFAULT_DEPENDENCY_BLOCKED_TODO_FRESH_MS,
  DEFAULT_DEPENDENCY_BLOCKED_TODO_STALE_MS,
  DEFAULT_DEPENDENCY_BLOCKED_TODO_MIN_COUNT,
  DEFAULT_DEPENDENCY_BLOCKED_TODO_MAX_GROUPS,
} from "./dependency-blocked-todo-report.js";
export type {
  DependencyBlockedTodoCode,
  DependencyBlockedTodoGroup,
  DependencyBlockedTodoReport,
  DependencyBlockedTodoReportContext,
} from "./dependency-blocked-todo-report.js";
export {
  getTaskMergeBlocker,
  getTaskHardMergeBlocker,
  getTaskCompletionBlocker,
  isTaskReadyForMerge,
  allowsAutoMergeProcessing,
  isSharedBranchGroupMemberIntegration,
  resolveEffectiveAutoMerge,
  resolveEffectiveGroupAutoMerge,
  resolveTaskMergeTarget,
  type MergeTargetResolution,
  type MergeTargetResolverOptions,
} from "./task-merge.js";
export {
  isBranchGroupMemberLanded,
  isBranchGroupComplete,
} from "./branch-group-completion.js";
export type {
  PrEntity,
  PrEntityCreateInput,
  PrEntityUpdate,
  PrEntityState,
  PrEntitySourceType,
  PrReviewDecision,
  PrChecksRollup,
  PrThreadState,
  PrThreadOutcome,
} from "./types.js";
export {
  isPrEntityActive,
  isPrBacked,
  isPrEntityActionable,
  isPrEntityAutoMergeReady,
  autoMergeGateReason,
} from "./pr-entity.js";
export {
  findVitestProcessIds,
  type FindVitestProcessIdsOptions,
} from "./vitest-processes.js";
export {
  countRecentIdenticalStallEntries,
  getInReviewStallReason,
  IN_REVIEW_STALL_DEADLOCK_LOG_PREFIX,
  IN_REVIEW_STALL_LOG_PREFIX,
  DEFAULT_STALE_MERGING_MIN_AGE_MS,
  DEFAULT_MAX_AUTO_MERGE_RETRIES,
} from "./in-review-stall.js";
export type { InReviewStallSignal, InReviewStallCode } from "./in-review-stall.js";
export {
  getStalePausedReviewSignal,
  DEFAULT_STALE_PAUSED_REVIEW_THRESHOLD_MS,
} from "./stale-paused-review.js";
export type { StalePausedReviewCode, StalePausedReviewSignal } from "./stale-paused-review.js";
export {
  getInReviewStalledSignal,
  DEFAULT_IN_REVIEW_STALLED_THRESHOLD_MS,
} from "./in-review-stalled.js";
export type { InReviewStalledCode, InReviewStalledSignal } from "./in-review-stalled.js";
export {
  getStalePausedTodoSignal,
  DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS,
} from "./stale-paused-todo.js";
export type { StalePausedTodoCode, StalePausedTodoSignal } from "./stale-paused-todo.js";
export {
  getTaskAgeStalenessSignal,
  DEFAULT_TASK_AGE_STALENESS_THRESHOLDS,
} from "./task-age-staleness.js";
export type {
  TaskAgeStalenessLevel,
  TaskAgeStalenessSignal,
  TaskAgeStalenessThresholds,
} from "./task-age-staleness.js";
export {
  isGhAvailable,
  isGhAuthenticated,
  resetGhAvailabilityCache,
  runGh,
  runGhAsync, 
  runGhJson, 
  runGhJsonAsync, 
  getGhErrorMessage, 
  classifyGhError,
  ensureGhAuth,
  parseRepoFromRemote,
  getCurrentRepo,
  type GhError,
  type GhErrorCode,
  type StructuredGhError,
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
  EXPERIMENT_SESSION_STATUSES,
  EXPERIMENT_METRIC_DIRECTIONS,
  EXPERIMENT_RECORD_TYPES,
  EXPERIMENT_RUN_OUTCOMES,
  isRunRecord,
  isConfigRecord,
  isHookRecord,
  isFinalizeRecord,
} from "./experiment-session-types.js";
export type {
  ExperimentSessionStatus,
  ExperimentMetricDirection,
  ExperimentMetricDefinition,
  ExperimentRecordType,
  ExperimentRunOutcome,
  ExperimentSecondaryMetric,
  ExperimentRunRecordPayload,
  ExperimentConfigRecordPayload,
  ExperimentHookRecordPayload,
  ExperimentFinalizeRecordPayload,
  ExperimentSessionRecord,
  ExperimentSession,
  ExperimentSessionCreateInput,
  ExperimentSessionUpdateInput,
  ExperimentSessionRecordAppendInput,
  ExperimentSessionListOptions,
  ExperimentSessionStoreEvents,
} from "./experiment-session-types.js";
export { ExperimentSessionStore } from "./experiment-session-store.js";
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
  SANDBOX_BACKEND_NAMES,
  SANDBOX_FAILURE_MODES,
  validateDirectMergeCommitStrategy,
  validateGithubAuthMode,
  validateGithubRepoSlug,
  validateLocale,
  validateSandboxBackendName,
  validateSandboxFailureMode,
  validateSandboxPolicy,
  validateSandboxProjectSettings,
  validateUnavailableNodePolicy,
} from "./settings-validation.js";

export { parseSandboxPromptOverride, resolveSandboxBackend } from "./sandbox-prompt-override.js";

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
  CreateInteractiveAiSessionOptions,
  InteractiveAiSessionProgressEvent,
  InteractiveAiSessionEvent,
  InteractiveAiSession,
  CreateInteractiveAiSessionResult,
  CreateInteractiveAiSessionFactory,
  PluginLogger,
  PluginSkillContribution,
  PluginWorkflowStepContribution,
  PluginTraitContribution,
  PluginTraitHookDescriptor,
  PluginTraitFlags,
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
export {
  validatePluginManifest,
  validatePluginTraitContribution,
  validateWorkflowExtensionContribution,
  PLUGIN_TRAIT_RESTRICTED_FLAGS,
  PLUGIN_TRAIT_ALLOWED_HOOK_POINTS,
  PLUGIN_TRAIT_SCHEMA_VERSION,
  normalizePluginUiContributionSurface,
  normalizePluginUiContributionDefinition,
} from "./plugin-types.js";
export type {
  WorkflowExtensionContribution,
  WorkflowExtensionMetadata,
  WorkflowExtensionBaseContribution,
  WorkflowColumnMetadataExtensionContribution,
  WorkflowMovePolicyExtensionContribution,
  WorkflowWorkEngineExtensionContribution,
  WorkflowNodeHandlerExtensionContribution,
  TaskVerdictProviderExtensionContribution,
  AutoMergeFactProviderExtensionContribution,
  WorkflowExtensionConfigField,
  WorkflowExtensionConfigSchema,
  WorkflowExtensionFallback,
  WorkflowExtensionKind,
  WorkflowMovePolicyDecision,
  WorkflowMovePolicyInput,
  WorkflowMovePolicyHandler,
  WorkflowWorkEngineDispatchResult,
  WorkflowWorkEngineInput,
  WorkflowWorkEngineHandler,
  WorkflowNodeExtensionResult,
  WorkflowNodeHandlerInput,
  WorkflowNodeExtensionHandler,
  TaskVerdictStatus,
  TaskVerdictProviderInput,
  TaskVerdictProviderResult,
  TaskVerdictProviderHandler,
  AutoMergeRoute,
  AutoMergeFactProviderInput,
  AutoMergeFactProviderResult,
  AutoMergeFactProviderHandler,
} from "./workflow-extension-types.js";
export {
  WORKFLOW_EXTENSION_SCHEMA_VERSION,
  workflowExtensionRegistryId,
} from "./workflow-extension-types.js";
export {
  WorkflowExtensionRegistry,
  WorkflowExtensionRegistrationError,
  getWorkflowExtensionRegistry,
  __resetWorkflowExtensionRegistryForTests,
} from "./workflow-extension-registry.js";
export type {
  WorkflowExtensionDefinition,
  WorkflowExtensionRegistrationReason,
} from "./workflow-extension-registry.js";
export {
  createBoardActionServices,
} from "./board-action-services.js";
export type {
  BoardActionServices,
  BoardActionTaskStore,
  MoveBoardTaskInput,
  UpdateBoardTaskInput,
} from "./board-action-services.js";
export { PluginStore } from "./plugin-store.js";
export type { PluginStoreEvents, PluginRegistrationInput, PluginUpdateInput } from "./plugin-store.js";
export { PluginLoader, resolvePluginEntryPath } from "./plugin-loader.js";
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
  generateCentralBackupFilename,
  currentBackupTimestamp,
  validateBackupSchedule,
  validateBackupRetention,
  validateBackupDir,
  runBackupCommand,
  syncBackupAutomation,
  syncBackupRoutine,
  BACKUP_SCHEDULE_NAME,
} from "./backup.js";
export type { BackupInfo, BackupOptions, BackupFileInfo, BackupPairInfo } from "./backup.js";
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
  SETTINGS_EXPORT_VERSION,
} from "./settings-export.js";
export type {
  SettingsExportData,
  ExportSettingsOptions,
  ImportSettingsOptions,
  ImportResult,
  WorkflowSettingsExportSection,
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
  applyTestModeOverrides,
  isTestModeActive,
  resolveExecutionSettingsModel,
  resolvePlanningSettingsModel,
  resolveProjectDefaultModel,
  resolveTaskExecutionModel,
  resolveTaskPlanningModel,
  resolveTaskValidatorModel,
  resolveTitleSummarizerSettingsModel,
  resolveValidatorSettingsModel,
  TEST_MODE_RESOLVED,
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
  compareTasksByPriorityFanoutThenAgeAndId,
  sortTasksByPriorityThenAgeAndId,
  sortTasksByPriorityFanoutThenAgeAndId,
  buildUnblockWeightMap,
  compareTaskIdNumeric,
  sortTasksForDisplayColumn,
} from "./task-priority.js";
export type {
  TaskPrioritySortable,
  TaskColumnSortable,
  BuildUnblockWeightMapOptions,
  PriorityFanoutComparatorContext,
} from "./task-priority.js";

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
  MissionBranchStrategy,
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
export { ACTIVE_GOAL_LIMIT, ActiveGoalLimitExceededError } from "./goal-types.js";
export type { Goal, GoalCreateInput, GoalListFilter, GoalStatus, GoalUpdateInput } from "./goal-types.js";
export { GoalStore } from "./goal-store.js";
export type { GoalStoreEvents } from "./goal-store.js";
export type {
  GoalCitation,
  GoalCitationSurface,
  GoalCitationInput,
  GoalCitationFilter,
  GoalCitationMatch,
} from "./types.js";
export {
  extractGoalCitations,
  buildSnippet,
  collectCitedGoalIdsFromAudit,
  GOAL_ID_PATTERN,
  GOAL_CITATION_SNIPPET_MAX,
} from "./goal-citation-extractor.js";

// ── Central Infrastructure (Multi-Project Support) ───────────────────────────

export { CentralCore } from "./central-core.js";
export type { CentralCoreEvents } from "./central-core.js";
export { CentralDatabase, createCentralDatabase, getDefaultCentralDbPath } from "./central-db.js";
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
export {
  WORKFLOW_COMPARABLE_AUDIT_MUTATIONS,
  WORKFLOW_PARITY_OBSERVED_MUTATION,
  WORKFLOW_PARITY_DRIFT_MUTATION,
  compareWorkflowRunAudits,
  compareWorkflowRunObservations,
  extractWorkflowAuditObservations,
  DEFAULT_WORKFLOW_INVARIANTS,
  deriveStageTransitions,
  buildWorkflowObservationFromTask,
  buildWorkflowObservation,
  checkTransitionParity,
  countDualAcceptDisagreements,
  computeWorkflowColumnsGraduationReport,
  DUAL_ACCEPT_PARITY_MUTATIONS,
} from "./workflow-parity.js";
export type {
  WorkflowAuditObservation,
  WorkflowParityDiff,
  WorkflowParityDiffCategory,
  WorkflowParityDiffSeverity,
  WorkflowParityDriftReport,
  WorkflowReliabilityInvariantSignals,
  WorkflowRunObservation,
  WorkflowStage,
  WorkflowObservationTaskInput,
  WorkflowObservationBuildOptions,
  WorkflowObservationParts,
  WorkflowParitySummary,
  TransitionParityDiff,
  TransitionParityReport,
  DualAcceptDisagreementReport,
  WorkflowColumnsGraduationReport,
  GraduationReportInputs,
} from "./workflow-parity.js";
export {
  WORKFLOW_INTERPRETER_AUTHORITATIVE_FLAG,
  evaluateInterpreterCutoverReadiness,
} from "./workflow-cutover.js";
export type {
  InterpreterCutoverReadinessInput,
  InterpreterCutoverReadinessResult,
} from "./workflow-cutover.js";
export { isResearchExperimentalEnabled, resolveResearchSettings } from "./research-settings.js";
export type { ResolvedResearchSettings } from "./research-settings.js";
export { isEvalsExperimentalEnabled, resolveEvalSettings } from "./eval-settings.js";
export { isSandboxExperimentalEnabled } from "./sandbox-settings.js";

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
  CLI_AGENT_STATES,
  CLI_TERMINATION_REASONS,
  CLI_SESSION_PURPOSES,
  isCliAgentState,
  isCliTerminationReason,
  isCliSessionPurpose,
} from "./cli-session-types.js";
export type {
  CliAgentState,
  CliTerminationReason,
  CliSessionPurpose,
  CliAutonomyPosture,
  CliSession,
  CliSessionCreateInput,
  CliSessionUpdateInput,
} from "./cli-session-types.js";
export { CliSessionStore } from "./cli-session-store.js";
export type { CliSessionStoreEvents } from "./cli-session-store.js";
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

// ── Secrets crypto ───────────────────────────────────────
export {
  createSecretCipher,
  SecretCryptoError,
  redactForLog,
} from "./secrets-crypto.js";
export type {
  MasterKeyProvider,
  EncryptedSecret,
} from "./secrets-crypto.js";
export {
  isSecretScope,
  SecretsStore,
  SecretsStoreError,
} from "./secrets-store.js";
export type {
  SecretScope,
  SecretRecord,
} from "./secrets-store.js";
export {
  wrapSecretsBundle,
  unwrapSecretsBundle,
  SecretsSyncError,
} from "./secrets-sync.js";
export type {
  WrappedSecretsBundle,
  SecretsSyncRecord,
} from "./secrets-sync.js";
export {
  RESERVED_SYNC_PASSPHRASE_KEY,
  getSyncPassphrase,
  setSyncPassphrase,
  clearSyncPassphrase,
  hasSyncPassphraseConfigured,
} from "./secrets-sync-passphrase.js";
