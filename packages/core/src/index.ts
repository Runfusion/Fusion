export { COLUMNS, DEFAULT_COLUMN, isColumn, normalizeColumn, normalizeColumnId, COLUMN_LABELS, COLUMN_DESCRIPTIONS, VALID_TRANSITIONS, DEFAULT_SETTINGS, DEFAULT_GLOBAL_SETTINGS, DEFAULT_PROJECT_SETTINGS, GLOBAL_SETTINGS_KEYS, PROJECT_SETTINGS_KEYS, isGlobalSettingsKey, isProjectSettingsKey, isMergeRequestContractShadowEnabled, resolvePersistAgentThinkingLog, THINKING_LEVELS, THEME_MODES, COLOR_THEMES, SUPPORTED_LOCALES, DEFAULT_LOCALE, isLocale, AGENT_PERMISSIONS, PERMANENT_AGENT_ACTION_CATEGORIES, AGENT_PERMISSION_POLICY_ACTION_CATEGORIES, AGENT_PROVISIONING_APPROVAL_MODES, SANDBOX_PROVISIONING_APPROVAL_MODES, AGENT_PERMISSION_POLICY_PRESET_IDS, LEGACY_AGENT_PERMISSION_POLICY_ACTION_CATEGORY_ALIASES, APPROVAL_REQUEST_STATUSES, APPROVAL_REQUEST_AUDIT_EVENT_TYPES, normalizeApprovalRequestActionCategory, isValidApprovalRequestTransition, agentToConfigSnapshot, diffConfigSnapshots, isEphemeralAgent, hasAgentIdentity, CheckoutConflictError, DEFAULT_HEARTBEAT_PROCEDURE_PATH, getDefaultHeartbeatProcedurePath, EXECUTION_MODES, DEFAULT_EXECUTION_MODE, PLANNER_OVERSIGHT_LEVELS, DEFAULT_PLANNER_OVERSIGHT_LEVEL, TASK_PRIORITIES, DEFAULT_TASK_PRIORITY, WORKFLOW_WORK_ITEM_KINDS, WORKFLOW_WORK_ITEM_STATES, HIGH_FANOUT_BLOCKER_TODO_THRESHOLD, STALE_HIGH_FANOUT_BLOCKER_AGE_THRESHOLD_MS, REVIEW_ARTIFACTS_MODES, LIVE_DEMO_ARTIFACT_MIME_TYPE, isReviewArtifact, parseReviewArtifactsModeOverride, resolveReviewArtifactsMode, classifyReviewArtifactTask, isReviewArtifactGenerationEligible, DASHBOARD_USER_ID, normalizeMessageParticipant, validateMessageMetadata, resolveEphemeralTaskCreationPolicy, validateDockerNodeConfig, sanitizeDockerNodeConfigForResponse, normalizeMergeIntegrationWorktreeMode, normalizeMergeAdvanceAutoSyncMode, DEFAULT_GITLAB_API_BASE_URL, DEFAULT_GITLAB_INSTANCE_URL, resolveGitlabConfig, resolveGitlabEnabled, MERGE_ADVANCE_AUTO_SYNC_MODES, normalizeMergeConflictStrategy, normalizeMergeStrategyOverlapBehavior, normalizePostMergeAuditMode, POST_MERGE_AUDIT_MODES, normalizeMergeAuditAutoRecovery, MERGE_AUDIT_AUTO_RECOVERY_MODES, normalizeMergerMode, MERGER_MODES, normalizeAutoRecovery, AUTO_RECOVERY_MODES, buildResearchDocumentKey, REPO_OVERRIDE_RE, SHARED_STATE_SNAPSHOT_VERSION, sanitizeCliAgentSettings, sanitizeCliAgentsSettings, sanitizeMcpServers, CLI_AGENT_ADAPTER_IDS, CLI_AGENT_AUTONOMY_MODES, isMcpSecretRef, OVERSEER_INTERVENTION_MUTATION } from "./types.js";
export type { Column, ColumnId, IssueInfo, IssueState, TaskSourceIssue, TaskGitLabTracking, TaskGitLabTrackedItem, GitLabTrackedItemKind, PrInfo, PrConflictState, PrConflictDiagnostics, PrCheckState, PrCheckStatus, PrStatus, BranchGroup, BranchGroupCreateInput, BranchGroupUpdate, BranchGroupPrState, Task, TaskTokenUsage, TaskTokenUsagePerModel, TaskAttachment, TaskComment, TaskCommentInput, TaskDocument, TaskDocumentRevision, TaskDocumentCreateInput, ArchivedTaskDocumentAdditionInput, ArchivedTaskDocumentAdditionResult, TaskDocumentWithTask, ArtifactType, Artifact, ArtifactCreateInput, ArtifactWithTask, TaskCreateInput, TaskSource, SourceType, TaskDetail, RetrySummary, InboxTask, TodoList, TodoItem, TodoListCreateInput, TodoListUpdateInput, TodoItemCreateInput, TodoItemUpdateInput, TodoListWithItems, AgentLogEntry, AgentLogType, AgentRole, BoardConfig, DistributedTaskIdReserveInput, DistributedTaskIdReserveResult, DistributedTaskIdCommitInput, DistributedTaskIdCommitResult, DistributedTaskIdAbortInput, DistributedTaskIdAbortResult, DistributedTaskIdStateInput, DistributedTaskIdStateResult, AutostashOrphanRecord, AutostashOutcome, MergeDetails, MergeResult, MergeIntegrationWorktreeMode, MergeAdvanceAutoSyncMode, MergeConflictStrategy, CanonicalMergeConflictStrategy, MergeStrategyOverlapBehavior, PostMergeAuditMode, MergeAuditAutoRecoveryMode, MergerMode, MergerSettings, AutoRecoveryMode, AutoRecoveryFailureClass, AutoRecoverySettings, DirectMergeCommitStrategy, Settings, GlobalSettings, ProjectSettings, ReportMode, ReportActionType, ReportTarget, SecretsEnvConfig, WebSearchBackend, ResearchEnabledSources, ResearchGlobalDefaults, ResearchProjectLimits, ResearchProjectSettings, SandboxBackendName, SandboxFailureMode, SandboxPolicy, SandboxProjectSettings, EvalFollowUpPolicy, EvalProjectSettings, ResolvedEvalSettings, SettingsScope, DaemonTokenSettings, TaskStep, StepStatus, TaskLogEntry, RunMutationContext, ActivityLogEntry, ActivityEventType, ThinkingLevel, ThemeMode, ColorTheme, Locale, ExecutionMode, PlannerOversightLevel, ReviewArtifactsMode, ReviewArtifactTaskClassification, TaskPriority, MergeQueueEntry, MergeQueueEnqueueOptions, MergeQueueAcquireOptions, MergeQueueReleaseOutcome, MergeRequestState, MergeRequestRecord, MergeRequestWorkflowProjectionOptions, CompletionHandoffMarker, WorkflowWorkItem, WorkflowWorkItemDueFilter, WorkflowWorkItemKind, WorkflowWorkItemState, WorkflowWorkItemTransitionPatch, WorkflowWorkItemUpsertInput, HandoffEvidence, HandoffToReviewOptions, UnavailableNodePolicy, OwningNodeHandoffPolicy, PlanningQuestion, PlanningSummary, PlanningResponse, PlanningQuestionType, ArchivedTaskEntry, BatchStatusRequest, BatchStatusResponse, BatchStatusEntry, BatchStatusResult, GithubIssueAction, ModelPreset, WorkflowStep, WorkflowStepMode, WorkflowStepGateMode, WorkflowStepPhase, WorkflowStepInput, WorkflowStepResult, WorkflowStepTemplate, Agent, OrgTreeNode, AgentState, AgentDetail, AgentCreateInput, AgentUpdateInput, AgentApiKey, AgentApiKeyCreateResult, AgentCapability, AgentPromptTemplate, AgentPromptsConfig, AgentPermission, PermanentAgentActionCategory, PermanentAgentSensitiveActionCategory, PermanentAgentGatingContext, AgentPermissionPolicy, AgentPermissionPolicyRules, AgentPermissionPolicyToolRules, AgentPermissionPolicyActionCategory, AgentProvisioningApprovalMode, SandboxProvisioningApprovalMode, LegacyAgentPermissionPolicyActionCategory, ApprovalRequestActionCategoryInput, ApprovalRequestActionCategory, AgentPermissionPolicyDisposition, AgentPermissionPolicyPresetId, ApprovalRequestStatus, ApprovalRequestAuditEventType, ApprovalRequestActorSnapshot, ApprovalRequestTargetAction, ApprovalRequestAuditEvent, ApprovalRequest, ApprovalRequestCreateInput, ApprovalRequestDecisionInput, ApprovalRequestCompletionInput, ApprovalRequestListInput, TaskAssignSource, AgentAccessState, AgentHeartbeatConfig, AgentBudgetConfig, AgentBudgetStatus, InstructionsBundleConfig, MessageResponseMode, AgentHeartbeatEvent, AgentHeartbeatRun, BlockedStateSnapshot, HeartbeatInvocationSource, AgentTaskSession, AgentRating, AgentRatingSummary, AgentRatingInput, AgentConfigSnapshot, RevisionFieldDiff, AgentConfigRevision, AgentStats, ReflectionTrigger, ReflectionMetrics, AgentReflection, AgentPerformanceSummary, NtfyNotificationEvent, NotificationEvent, NotificationPayload, NotificationProviderConfig, CustomProvider, SteeringComment, ParticipantType, MessageType, Message, MessageCreateInput, MessageFilter, MessageMetadata, ProposedTaskMetadata, EphemeralTaskCreationPolicy, MessageReplyReference, Mailbox, CheckoutLease, CheckoutClaimPrecondition, TaskClaimRow, CentralClaimStore, RunAuditDomain, RunAuditEvent, RunAuditEventInput, RunAuditEventFilter, AgentMemoryInclusionMode, HeartbeatPromptTemplate, HeartbeatScopeDisciplineMode, WorktrunkSettings, WorktrunkOnFailure, TaskBranchContext, CliAgentSettings, McpSecretRef, McpSensitiveValue, McpStdioTransport, McpSseTransport, McpStreamableHttpTransport, McpTransport, McpServerDefinition, McpServersSettings, GitlabConfigSettingsSource, ResolvedGitlabConfig, ResolveGitlabConfigInput, GitlabAuthTokenType, PlannerOversightStage, PlannerInterventionAction, PlannerInterventionOutcome, PlannerInterventionSourceLink, PlannerInterventionEntry, ExecutorOverseerSignalMemory, BackupSettingsMigrationCandidate, BackupSettingsMigrationConflict } from "./types.js";
export type { NativeStructureRef, NativeStructureEmbed, NativeStructureOpenTarget, NativeStructurePreviewPayload, NativeStructureUnavailablePayload, NativeStructurePreviewResult } from "./types.js";
export type {
  SymbolLockStatus,
  SymbolLockIdentity,
  SymbolLockOwner,
  SymbolLockLease,
  SymbolLock,
  SymbolLockConflict,
  AcquireSymbolLocksResult,
  RenewSymbolLocksResult,
  ReleaseSymbolLocksResult,
  ReconcileStaleSymbolLocksResult,
} from "./tasks/symbol-lock-types.js";
export {
  normalizeSymbolLockKey,
  extractSymbolLockIdentity,
  symbolLocksConflict,
} from "./task-store/symbol-locks.js";
export {
  hasOwnDeclaredSymbols,
  normalizeDeclaredSymbols,
  extractDeclaredSymbolsFromPrompt,
  resolveCreateDeclaredSymbols,
  resolveTaskSymbolsFromSources,
  resolveTaskSymbolsForTask,
  type TaskSymbolResolution,
  type TaskSymbolResolutionSource,
} from "./tasks/task-symbol-resolution.js";
export {
  MISSION_LINEAGE_APPROVAL_REQUIRED,
  evaluateMissionLineageApproval,
  isMissionLineageApproved,
} from "./tasks/symbol-lock-lineage-approval.js";
export type {
  MissionLineageApprovalReason,
  MissionLineageApprovalResult,
  MissionLineageSnapshot,
} from "./tasks/symbol-lock-lineage-approval.js";
export { AGENT_VALID_TRANSITIONS, DUPLICATE_OF_METADATA_KEY, REPORT_ATTACHMENT_SOURCE, assertNotWorkspaceTaskMerge, isWorkspaceTask, WorkspaceTaskMergeError } from "./types.js";
export {
  resolveEntryPointBranchAssignment,
  sanitizeBranchSegment,
  derivePerTaskBranchName,
  deriveAutoTaskBranchName,
  isValidBranchGroupBranchName,
  validateBranchGroupBranchName,
  filterTasksByBranchGroup,
} from "./branch/branch-assignment.js";
export type {
  EntryPointAssignmentMode,
  EntryPointBranchAssignmentInput,
  EntryPointBranchAssignment,
} from "./branch/branch-assignment.js";
export { customProviderRegistryKey } from "./ai/custom-provider-key.js";
export {
  ANTHROPIC_PROVIDER_ID,
  CLAUDE_SONNET_5_MODEL_ID,
  SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION,
  mergeSupplementalAnthropicModels,
} from "./ai/anthropic-models.js";
export type { AnthropicProviderRegistration } from "./ai/anthropic-models.js";
export {
  OPENAI_CODEX_PROVIDER_ID,
  GPT_5_6_LUNA_MODEL_ID,
  GPT_5_6_SOL_MODEL_ID,
  GPT_5_6_TERRA_MODEL_ID,
  SUPPLEMENTAL_OPENAI_CODEX_PROVIDER_REGISTRATION,
  mergeSupplementalOpenAiCodexModels,
} from "./ai/openai-models.js";
export type { OpenAiCodexProviderRegistration } from "./ai/openai-models.js";
export { detectImageMimeFromBytes } from "./i18n/image-mime.js";
export type { DetectedImageMime } from "./i18n/image-mime.js";
export {
  computeSkillId,
  getSkillSettingState,
  normalizeStoredSkillPath,
  parseSkillId,
  resolvePluginSkillEnabled,
} from "./config/skill-settings.js";
export type { SkillSettingState, SkillSettingsScope } from "./config/skill-settings.js";
export {
  resolvePluginRootFromEntryPath,
  resolvePluginSkillBodyPath,
} from "./plugins/plugin-skill-paths.js";
export type { PluginSkillBodyPath } from "./plugins/plugin-skill-paths.js";
export { redactSecrets } from "./secrets/redact-secrets.js";
export {
  evaluatePromptCondition,
  evaluatePromptConditionDetailed,
  resolveEffectivePluginSettings,
} from "./plugins/plugin-prompt-condition.js";
export type { PromptConditionEvaluationResult } from "./plugins/plugin-prompt-condition.js";
export { computePlanApprovalFingerprint, resolvePlanApprovalRequired } from "./planner/plan-approval.js";
export type { PlanApprovalMode } from "./planner/plan-approval.js";
export { isActiveNearDuplicateColumn, isNearDuplicateCanonicalInactive } from "./duplicates/near-duplicate-canonical.js";
export type { NearDuplicateCanonicalState } from "./duplicates/near-duplicate-canonical.js";
export { formatGitLabTrackedItemRef, isGitLabTrackingStale } from "./git/gitlab-tracking.js";
export * from "./planner/planner-intervention.js";
export {
  emitOverseerObservation,
  emitOverseerSteering,
  emitOverseerRecoveryAttempt,
  emitOverseerRetry,
  emitOverseerConfirmation,
  emitOverseerEscalation,
} from "./planner/planner-overseer-events.js";
export type { OverseerEventInput } from "./planner/planner-overseer-events.js";
/*
FNXC:PlannerOversight 2026-07-13-22:40:
Session-advisor (OMP advisor parity) vocabulary + emission guard. Pure
types/policy for severity-routed notes before they reach steering inject.
*/
export * from "./planner/overseer-advice.js";
export * from "./planner/overseer-emission-guard.js";
export * from "./tasks/frontend-ux-policy.js";
export * from "./tasks/original-description-policy.js";
export * from "./planner/planning-plan-md.js";
export * from "./tasks/file-scope-classification.js";
export { MAX_TASK_LIST_TEXT_CHARS, clampTaskListText, formatTaskListText } from "./tasks/task-list-format.js";
export {
  WAKE_DELTA_ASSIGNED_TASKS_CAP,
  rankAssignedTasksForWakeDelta,
  formatAssignedTasksWakeDeltaSection,
} from "./agents/assigned-task-ranking.js";
export type {
  AssignedTaskLike,
  AssignedTaskRankTier,
  RankedAssignedTaskLine,
  RankAssignedTasksForWakeDeltaResult,
} from "./agents/assigned-task-ranking.js";
export { MOCK_PROVIDER_ID } from "./ai/mock-provider-constants.js";
export type { MockProviderId, MockSessionPurpose } from "./ai/mock-provider-constants.js";
export {
  ZAI_PROVIDER_ID,
  ZAI_PROVIDER_REGISTRATION,
  mergeBuiltInZaiProviderModels,
  registerBuiltInZaiProvider,
} from "./ai/zai-provider.js";
export type { ZaiProviderRegistration } from "./ai/zai-provider.js";
export {
  GROK_CLI_PROVIDER_ID,
  GROK_PROVIDER_REGISTRATION,
  isGrokApiKeyFusionVisible,
  mergeBuiltInGrokProviderModels,
  registerBuiltInGrokProvider,
} from "./ai/grok-provider.js";
export type { GrokProviderRegistration } from "./ai/grok-provider.js";
export {
  resolveWorktrunkSettings,
  requiresWorktrunkInstallVerification,
  validateWorktrunkSettings,
  DEFAULT_WORKTRUNK_SETTINGS,
} from "./config/worktrunk-settings.js";
export {
  resolveEffectiveMcpServers,
  mapPluginMcpServerContribution,
  materializeMcpServerSecrets,
  materializeMcpServersSecrets,
  importMcpServersJson,
  exportMcpServersJson,
} from "./config/mcp-config.js";
export { createProjectScopedPluginMcpProvider } from "./plugin-mcp-servers.js";
export type {
  McpSecretReaderIdentity,
  McpSecretReader,
  ResolvedMcpStdioTransport,
  ResolvedMcpSseTransport,
  ResolvedMcpStreamableHttpTransport,
  ResolvedMcpServerDefinition,
  McpSecretResolutionError,
  McpSecretResolutionResult,
  McpSecretImportDescriptor,
  McpServersImportResult,
} from "./config/mcp-config.js";
export {
  getMcpDiscoverySources,
  parseDiscoveredMcpServersFromFile,
  type McpDiscoverySource,
  type McpDiscoverySourcesOptions,
  type DiscoveredMcpServer,
} from "./config/mcp-discovery.js";
export {
  resolveAgentMemoryInclusionMode,
  type AgentMemoryInclusionModeSource,
  type ResolveAgentMemoryInclusionModeInput,
  type ResolvedAgentMemoryInclusionMode,
} from "./agents/agent-memory-mode.js";
export type { TaskReviewData, TaskReviewSummary, TaskReviewItem } from "./types.js";
/* FNXC:TaskVerificationRequest 2026-07-30-00:00: FN-8296 makes the persisted verification read model available to dashboard task and Command Center surfaces without exporting a subprocess runner. */
export type { TaskVerificationRequest, TaskVerificationResultSummary, TaskVerificationStatus, TaskVerificationProfile } from "./types.js";
export type {
  TaskCommitAssociation,
  TaskCommitAssociationConfidence,
  TaskCommitAssociationMatchSource,
  CommitAssociationDiffBackfillReport,
  PluginActivation,
  PluginActivationInput,
} from "./types.js";
export * from "./mesh/mesh-replication-protocol.js";
export * from "./mesh/mesh-task-replication.js";
export * from "./mesh/shared-mesh-state.js";
export {
  BUILTIN_AGENT_PROMPTS,
  resolveAgentPrompt,
  buildTriageHeartbeatGuidance,
  buildConciseTriageHeartbeatGuidance,
  TRIAGE_HEARTBEAT_PATROL_DISABLED_INSTRUCTION,
  getAvailableTemplates,
  getTemplatesForRole,
  FUSION_RUNTIME_SELF_AWARENESS,
} from "./agents/agent-prompts.js";
export {
  parseWorkflowIr,
  serializeWorkflowIr,
  stripApprovalBypassFlags,
  resolveCreationColumn,
  WorkflowIrError,
  DEFAULT_WORKFLOW_COLUMN_IDS,
  WORKFLOW_SETTING_TYPES,
  SETTING_RENDER_WIDGETS,
} from "./workflows/workflow-ir.js";
export {
  analyzeWorkflowLifecycle,
  type AnalyzeWorkflowLifecycleOptions,
  type WorkflowLifecycleWarning,
  type WorkflowLifecycleWarningCode,
} from "./workflows/workflow-lifecycle-validation.js";
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
  WorkflowOptionalGroupConfig,
  OptionalStepRevisionBudget,
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
} from "./workflows/workflow-ir-types.js";
export {
  DEFAULT_MAX_REWORK_CYCLES,
  MAX_REWORK_CYCLES_CAP,
  resolveMaxReworkCycles,
  resolveOptionalStepRevisionBudget,
} from "./workflows/workflow-ir-types.js";
export {
  instanceNodeId,
  parseInstanceNodeId,
  resolveColumnAgentBinding,
  resolveEffectiveAgent,
} from "./agents/column-agent-resolver.js";
export type {
  ParsedInstanceNodeId,
  EffectiveAgentInput,
  EffectiveAgentResult,
} from "./agents/column-agent-resolver.js";
export { BUILTIN_CODING_WORKFLOW_IR } from "./workflows/builtin-coding-workflow-ir.js";
export { BUILTIN_CODING_IDEAS_WORKFLOW_IR } from "./workflows/builtin-coding-ideas-workflow-ir.js";
export { PLAN_REVIEW_GROUP_ID } from "./workflows/builtin-plan-review-group.js";
export { BUILTIN_MARKETING_WORKFLOW_IR } from "./workflows/builtin-marketing-workflow-ir.js";
export {
  resolveWorkflowOptionalSteps,
  resolveDefaultOnOptionalGroupIds,
  isWorkflowOptionalGroupEnabled,
} from "./workflows/workflow-optional-steps.js";
export type { ResolvedWorkflowOptionalStep } from "./workflows/workflow-optional-steps.js";
export {
  applyPromptOverridesToIr,
  enumeratePromptBearingWorkflowNodes,
  isPromptBearingWorkflowNode,
  normalizeWorkflowPromptOverrides,
} from "./workflows/workflow-prompt-overrides.js";
export type { WorkflowPromptDefault, WorkflowPromptOverrides } from "./workflows/workflow-prompt-overrides.js";
export { BUILTIN_STEPWISE_CODING_WORKFLOW_IR } from "./workflows/builtin-stepwise-coding-workflow-ir.js";
export { BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR } from "./workflows/builtin-stepwise-final-review-coding-workflow-ir.js";
export { BUILTIN_PR_WORKFLOW_IR } from "./workflows/builtin-pr-workflow-ir.js";
export { BUILTIN_LEAD_GENERATION_WORKFLOW_IR } from "./workflows/builtin-lead-generation-workflow-ir.js";
export {
  BUILTIN_WORKFLOW_SETTINGS,
  BUILTIN_MOVED_WORKFLOW_SETTINGS,
  BUILTIN_TRIAGE_POLICY_SETTINGS,
  BUILTIN_OVERSIGHT_SETTINGS,
  DEFAULT_PLANNER_OVERSEER_EXECUTOR_STUCK_AFTER_MS,
  PLANNER_HEARTBEAT_PATROL_ENABLED_SETTING_ID,
  renderTriagePolicyPlaceholders,
} from "./workflows/builtin-workflow-settings.js";
export {
  BUILTIN_SEAM_PROMPTS,
  builtinPromptConfig,
  builtinSeamPrompt,
} from "./workflows/builtin-workflow-prompts.js";
export {
  MOVED_SETTINGS_KEYS,
  SETTINGS_MIGRATION_VERSION,
  SETTINGS_MIGRATION_MARKER_KEY,
  isMovedSettingsKey,
  stripMovedSettingsKeys,
  patchContainsMovedKey,
} from "./config/moved-settings.js";
export {
  ensureGitRepositoryForProjectPath,
  GitRepositoryInitializationError,
  detectWorkspaceRepos,
  loadWorkspaceConfig,
  saveWorkspaceConfig,
} from "./git/git-repository.js";
export type {
  GitRepositoryCommandResult,
  GitRepositoryCommandRunner,
  GitRepositoryEnsureOutcome,
  EnsureGitRepositoryOptions,
  WorkspaceConfig,
} from "./git/git-repository.js";

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
} from "./workflows/trait-types.js";
export { RESTRICTED_TRAIT_FLAGS, traitHookKey } from "./workflows/trait-types.js";
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
} from "./workflows/trait-registry.js";
export type {
  TraitRegistrationReason,
  TraitViolation,
  TraitViolationCode,
  TraitViolationSeverity,
  TraitAuditWarning,
} from "./workflows/trait-registry.js";
export {
  BUILTIN_TRAIT_IDS,
  BUILTIN_TRAIT_DEFINITIONS,
  registerBuiltinTraits,
} from "./workflows/builtin-traits.js";
export type { BuiltinTraitId } from "./workflows/builtin-traits.js";
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
} from "./tasks/step-parsers.js";
export type {
  StepParser,
  StepParseResult,
  ParsedStep,
  StepParserRegistrationReason,
} from "./tasks/step-parsers.js";
export {
  registerDefaultWorkflowHooks,
  __resetDefaultWorkflowHooksForTests,
} from "./workflows/default-workflow-hooks.js";
// ── Typed transition contract + crash-safe marker (U3) ───────────────
export type {
  TransitionRejection,
  TransitionRejectionCode,
  TransitionResult,
  TransitionPending,
} from "./tasks/transition-types.js";
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
} from "./tasks/transition-types.js";
export type {
  TransitionPendingDbHandle,
  ReconcileHooksResult,
} from "./tasks/transition-pending.js";
// ── U4: workflow-resolved transition adjacency + flag accessor ───────────────
export {
  resolveColumnAdjacency,
  resolveAllowedColumns,
  workflowHasColumn,
} from "./workflows/workflow-transitions.js";
export type { ColumnAdjacency } from "./workflows/workflow-transitions.js";
export { isWorkflowColumnsEnabled } from "./workflows/workflow-columns-settings.js";
// ── U8: pre-evaluated plugin gate verdicts (KTD-2) ───────────────────────────
export {
  findWorkflowColumn,
  resolveColumnPluginGates,
} from "./plugins/plugin-gate-verdict.js";
export type { PluginGateVerdict, ColumnPluginGate } from "./plugins/plugin-gate-verdict.js";
// ── U6: workflow capacity (WIP) resolution shared by store + sweep ───────────
export { resolveColumnCapacity, resolveWipBudgetColumns, DEFAULT_WORKFLOW_POOL_ID } from "./workflows/workflow-capacity.js";
export { columnsWithFlag, columnHasFlag, resolveReboundTarget, resolveCompleteColumn, resolveMergeOrchestrationColumn } from "./workflows/workflow-lifecycle-traits.js";
export { resolveReviewLevelSteps, applyReviewLevelPreset } from "./tasks/review-level-preset.js";
export {
  LEGACY_STATUS_ADOPTION,
  resolveLegacyStatusAdoption,
  resolveReviewLevelBackfill,
  type LegacyAdoptionKind,
  type LegacyAdoptionAction,
  type ReviewLevelBackfillDecision,
  planLegacyAdoption,
  resolveOrphanedPendingStepResults,
  type LegacyAdoptionPlan,
  type LegacyAdoptionCandidate,
} from "./db/legacy-adoption.js";
export type { ColumnCapacity } from "./workflows/workflow-capacity.js";
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
} from "./workflows/workflow-reconciliation.js";
export type {
  SwitchReconciliation,
  ColumnOccupancy,
  IncompatibleFieldChange,
  ReconciliationAbort,
  ReconciliationAbortContext,
} from "./workflows/workflow-reconciliation.js";
export {
  validateCustomFieldPatch,
  applyFieldDefaults,
  reconcileFieldsOnWorkflowChange,
  makeCustomFieldRejection,
  CustomFieldRejectionError,
  CUSTOM_FIELD_REJECTION_CODES,
} from "./tasks/task-fields.js";
export type {
  CustomFieldRejection,
  CustomFieldRejectionCode,
  CustomFieldPatchResult,
  FieldReconciliation,
} from "./tasks/task-fields.js";
export {
  validateSettingValuePatch,
  resolveEffectiveSettingValues,
  findOrphanedSettingValues,
  makeWorkflowSettingRejection,
  WorkflowSettingRejectionError,
  WORKFLOW_SETTING_REJECTION_CODES,
} from "./workflows/workflow-settings.js";
export type {
  WorkflowSettingRejection,
  WorkflowSettingRejectionCode,
  SettingValuePatchResult,
  OrphanedSettingValue,
} from "./workflows/workflow-settings.js";
export {
  readTransitionPending,
  writeTransitionPending,
  clearTransitionPending,
  reconcileHooksRemaining,
} from "./tasks/transition-pending.js";
export type {
  WorkflowDefinition,
  WorkflowDefinitionInput,
  WorkflowDefinitionUpdate,
  WorkflowDefinitionKind,
  WorkflowNodeLayout,
} from "./workflows/workflow-definition-types.js";
export {
  MAX_WORKFLOW_ICON_LENGTH,
  normalizeWorkflowIcon,
} from "./workflows/workflow-definition-types.js";
export {
  stepsToWorkflowIr,
  stepToFragmentIr,
  layoutForIr,
} from "./workflows/workflow-steps-to-ir.js";
export { DEPRECATED_BUILTIN_WORKFLOW_IDS } from "./types.js";
export {
  BUILTIN_WORKFLOWS,
  BUILTIN_WORKFLOW_ID_PREFIX,
  getBuiltinWorkflow,
  getRequiredPluginIdForBuiltinWorkflow,
  isBuiltinWorkflowId,
  isBuiltinWorkflowPluginGated,
  isBuiltinWorkflowDeprecated,
  DEFAULT_WORKFLOW_ID,
  resolveDefaultWorkflowIr,
} from "./workflows/builtin-workflows.js";
export {
  COMPLETION_SUMMARY_NODE_ID,
  completionSummaryNode,
  isCompletionSummaryNode,
} from "./workflows/builtin-completion-summary-node.js";
export {
  resolveWorkflowIrForTask,
  resolveWorkflowIrById,
  resolveSeamPromptFromIr,
  resolvePlanningPromptFromIr,
  resolveTaskSeamPrompt,
  resolveTaskPlanningPrompt,
  hashWorkflowIr,
  computeWorkflowIrPin,
  detectWorkflowDrift,
  type WorkflowIrPin,
  type WorkflowDriftReason,
  type WorkflowIrResolverStore,
} from "./workflows/workflow-ir-resolver.js";
export {
  type TransitionColumnFacts,
  type CapacityFacts,
  type TransitionInvariantInput,
  type TransitionPolicyDecision,
  evaluateTransitionInvariants,
  evaluateMergeBlockerPostcondition,
  evaluateTerminalReentryPostcondition,
  evaluateCapacityRejection,
  isWipColumn,
  isTerminalColumn,
  isCompleteColumn,
  isHoldColumn,
  isHoldToWipBoundary,
} from "./workflows/workflow-transition-policy.js";
export {
  resolveEffectiveSettings,
  resolveEffectiveSettingsDetailed,
  resolveProjectWorkflowModelLaneBaseline,
  resolveEffectiveSettingsById,
  resolveOptionalReviewRevisionBudget,
  resolveEffectivePlannerOversightLevel,
  resolveEffectivePlannerHeartbeatPatrolEnabled,
  PLAN_REVIEW_MAX_REVISIONS_SETTING_ID,
  CODE_REVIEW_MAX_REVISIONS_SETTING_ID,
  PLAN_REVIEW_REPLAN_CAP_SETTING_ID,
  type WorkflowSettingsResolverStore,
  type EffectiveSettingsResult,
  type EffectiveSettingsTaskRef,
  type OptionalReviewRevisionBudget,
  type ResolveOptionalReviewRevisionBudgetInput,
} from "./workflows/workflow-settings-resolver.js";
export {
  applyWorkflowSettingsOverlay,
  type WorkflowSettingsOverlayInput,
} from "./config/effective-settings-overlay.js";
export {
  decidePlannerRecovery,
  PLANNER_RECOVERY_MAX_ATTEMPTS,
  type PlannerRecoveryActionKind,
  type PlannerRecoveryWatchedStage,
  type PlannerRecoveryObservationSignal,
  type PlannerRecoverySourceLink,
  type PlannerRecoveryObservation,
  type PlannerRecoveryAttemptState,
  type PlannerRecoveryDecision,
  type DecidePlannerRecoveryInput,
} from "./planner/planner-recovery.js";
export {
  PLANNER_OVERSEER_STATES,
  derivePlannerOverseerState,
  type PlannerOverseerState,
  type PlannerOverseerRuntimeSnapshot,
  type DerivePlannerOverseerStateInput,
} from "./planner/planner-overseer-state.js";
export {
  classifyPlannerActionSideEffect,
  requiresPlannerConfirmation,
  type PlannerActionSideEffectClass,
  type PlannerConfirmationRequest,
  type ClassifyPlannerActionSideEffectInput,
} from "./planner/planner-confirmation.js";

// ── Engine wiring (set by @fusion/engine at module load) ────────────
export {
  setCreateFnAgent,
  getFnAgent,
  setCreateAiSessionFactory,
  getCreateAiSessionFactory,
  setCreateInteractiveAiSessionFactory,
  getCreateInteractiveAiSessionFactory,
  type AgentMessage,
} from "./ai/ai-engine-loader.js";
export {
  registerArchiveWorktreeDisposer,
  getArchiveWorktreeDisposer,
  registerArchiveWorkspaceWorktreeDisposer,
  getArchiveWorkspaceWorktreeDisposer,
  ArchiveWorkspaceDisposalError,
  ArchiveWorkspaceDisposalIncompleteError,
  ArchiveWorkspaceWorktreeDisposerMissingError,
  type ArchiveWorktreeDisposer,
  type ArchiveWorkspaceWorktreeDisposer,
  type WorkspaceDisposalPlanEntry,
  type ArchiveWorkspaceDisposalResult,
} from "./db/archive-worktree-disposer.js";
export {
  disposeTaskBeforeMove,
  getTaskMoveDisposer,
  registerTaskMoveDisposer,
  type TaskMoveDisposer,
  type TaskMoveDisposalInput,
  type TaskMoveSource,
} from "./tasks/task-move-disposer.js";
export {
  acquireWorktreePathReservation,
  withWorktreePathReservation,
  readWorktreePathReservation,
  canonicalizeWorktreePath,
  type WorktreePathReservation,
  type WorktreePathReservationOptions,
} from "./tasks/worktree-path-reservation.js";
export {
  setRunningAgentCountSource,
  getRunningAgentCountSource,
  deriveRunningAgentCounts,
  isRunningAgentTask,
  isWaitingAgentTask,
  countRunningAgentTasks,
  enrichRunningAgentTaskShape,
  enrichRunningAgentTaskShapeFromFlags,
  resolveColumnTerminalKind,
  type RunningAgentTaskShape,
  type ColumnTerminalKind,
  type RunningAgentCountSource,
  type RunningAgentCounts,
} from "./agents/live-agent-count.js";
export {
  ACTIVE_MERGE_PIPELINE_STATUSES,
  isActiveMergeStatus,
} from "./merge/active-merge-status.js";
export {
  setTaskCreatedHook,
  getTaskCreatedHook,
  type TaskCreatedHook,
} from "./tasks/task-creation-hooks.js";

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
} from "./tasks/prompt-overrides.js";
export type {
  PromptKey,
  PromptKeyMetadata,
  PromptKeyCatalog,
  PromptOverrideEntry,
  PromptOverrideMap,
} from "./tasks/prompt-overrides.js";
export {
  ROLE_DEFAULT_PERMISSIONS,
  normalizePermissions,
  computeAccessState,
  isValidPermission,
} from "./agents/agent-permissions.js";
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
} from "./agents/agent-permission-policy.js";
export type { BuiltInAgentPermissionPolicyPreset } from "./agents/agent-permission-policy.js";
export {
  validateColumnAgentBindings,
  ColumnAgentBindingError,
} from "./agents/column-agent-binding-validation.js";
export { AgentStore, DEFAULT_AGENT_HEARTBEAT_INTERVAL_MS, formatCurrentTaskLine } from "./agents/agent-store.js";
export type { AgentStoreEvents } from "./agents/agent-store.js";
export {
  isImplementationTask,
  isExecutorRoleAgent,
  canAgentTakeImplementationTask,
  canAgentTakeImplementationTaskForExplicitRouting,
  canAgentTakeImplementationTaskForBacklogPickup,
  formatRoleMismatchReason,
  getAgentAssignmentPolicy,
  isAgentAutoAssignable,
  canAgentReceiveImplementationTasks,
  evaluateImplementationTaskBind,
  assertImplementationTaskBindAllowed,
  AgentTaskRoutingPolicyError,
} from "./agents/agent-role-policy.js";
export type { AgentAssignmentPolicy, ImplementationTaskBindContext, ImplementationTaskBindVerdict } from "./agents/agent-role-policy.js";
export { ReflectionStore } from "./agents/reflection-store.js";
export type { ReflectionStoreEvents } from "./agents/reflection-store.js";
export { MessageStore } from "./stores/message-store.js";
export type { MessageStoreEvents } from "./stores/message-store.js";
export { ApprovalRequestStore } from "./agents/approval-request-store.js";
export {
  resolveAgentProvisioningPolicy,
  extractAgentProvisioningRequest,
} from "./agents/agent-provisioning-policy.js";
export {
  resolveSandboxProvisioningPolicy,
  extractSandboxProvisioningRequest,
} from "./sandbox/sandbox-provisioning-policy.js";
export { SECRET_ACCESS_POLICIES } from "./types.js";
export {
  SECRET_ACCESS_POLICY_FALLBACK,
  isSecretAccessPolicy,
  resolveSecretAccessPolicy,
} from "./secrets/secret-access-policy.js";
export type {
  AgentProvisioningTool,
  AgentProvisioningPolicyInput,
  AgentProvisioningPolicyDecision,
} from "./agents/agent-provisioning-policy.js";
export type {
  SandboxProvisioningPolicyInput,
  SandboxProvisioningPolicyDecision,
} from "./sandbox/sandbox-provisioning-policy.js";
export type {
  ResolveSecretAccessPolicyInput,
  ResolveSecretAccessPolicyDecision,
} from "./secrets/secret-access-policy.js";
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
  type LegacyAutoMergeStampReconcileResult,
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
} from "./duplicates/duplicate-detection.js";
export {
  extractIntentSignature,
  findNearDuplicates,
  type IntentSignature,
  type NearDuplicateInput,
  type NearDuplicateCandidate,
  type NearDuplicateMatch,
} from "./duplicates/near-duplicate.js";
export { getTaskDuplicateLineage } from "./duplicates/duplicate-lineage.js";
export {
  parseExplicitDuplicateMarker,
  type ExplicitDuplicateMarker,
} from "./duplicates/explicit-duplicate-marker.js";
export {
  parseNoOpCompletionMarker,
  type NoOpCompletionMarker,
  type NoOpCompletionMarkerKind,
} from "./merge/no-op-completion-marker.js";
export { evaluateNoCommitsNoOpFinalize } from "./merge/no-commits-finalize-guard.js";
export type { NoCommitsNoOpFinalizeEvaluation } from "./merge/no-commits-finalize-guard.js";
export { evaluateCompletedPromotionFailureProvenance, CLEAN_COMPLETION_MARKERS } from "./merge/completed-promotion-failure-provenance.js";
export type { CompletedPromotionFailureProvenanceEvaluation } from "./merge/completed-promotion-failure-provenance.js";
export { evaluateSkipBypassTaint } from "./merge/skip-bypass-taint-guard.js";
export type { SkipBypassTaintEvaluation } from "./merge/skip-bypass-taint-guard.js";
export {
  __getDeterministicGuardMutexSize,
  deterministicGuardLocks,
  runDeterministicDuplicateGuard,
  reconcileDeterministicDuplicate,
  __deterministicGuardLocksForTests,
  type DeterministicGuardOptions,
  type DeterministicGuardOutcome,
} from "./duplicates/duplicate-guard.js";
export type { TaskDependencyMutation } from "./store.js";
export {
  findSameAgentDuplicates,
  computeParentIntentClaimId,
  computeCrossParentDiagnosticClaim,
  computeCrossParentDiagnosticClaimId,
  archiveAsSameAgentDuplicate,
  flagSameAgentDuplicate,
  flagTriageDuplicate,
  isTriageDuplicateKeepAcknowledged,
  type SameAgentDuplicateInput,
  type SameAgentDuplicateCandidate,
  type SameAgentDuplicateMatch,
} from "./duplicates/duplicate-intake.js";
export { computeRetrySummary, RETRY_STORM_WARNING_RATIO } from "./tasks/retry-summary.js";
export { RetryStormError, serializeRetryStormError } from "./tasks/retry-storm-error.js";
export { aggregateAgentTokenUsage, aggregateTaskTokenTotalsByAgentLink, aggregateTaskTokenTotalsByAgentLinkAsync } from "./agents/agent-token-usage.js";
export type { AgentTaskTokenTotals, AgentTokenUsageSummary, AgentTokenUsageWindowSummary } from "./agents/agent-token-usage.js";
export {
  emitUsageEvent,
  queryUsageEvents,
  countUsageEventsBy,
  categorizeToolName,
  USAGE_EVENT_META_MAX_BYTES,
} from "./tasks/usage-events.js";
export type {
  UsageEvent,
  UsageEventInput,
  UsageEventKind,
  UsageEventRangeQuery,
} from "./tasks/usage-events.js";
export {
  costFor,
  lookupPricing,
  parseLiteLLMPricing,
  MODEL_PRICING,
  LITELLM_PRICING_SOURCE_LABEL,
  LITELLM_PRICING_SOURCE_URL,
  pricingAsOf,
  PRICING_STALE_AFTER_MS,
} from "./ai/model-pricing.js";
export type {
  ModelPricing,
  ModelPricingOverrides,
  ModelRef,
  UsageForCost,
  CostResult,
} from "./ai/model-pricing.js";
export { aggregateTokenAnalytics } from "./board/token-analytics.js";
export type {
  TokenAnalytics,
  TokenAnalyticsQuery,
  TokenGroupBy,
  TokenGroupSummary,
  TokenTimeGranularity,
  TokenTimePoint,
  TokenTotals,
} from "./board/token-analytics.js";
export { aggregateToolAnalytics, countInterventions } from "./board/tool-analytics.js";
export type {
  ToolAnalytics,
  ToolAnalyticsQuery,
  ToolCategoryCount,
  InterventionBreakdown,
} from "./board/tool-analytics.js";
export { aggregateActivityAnalytics, aggregateMonitorMetrics } from "./board/activity-analytics.js";
export type {
  ActivityAnalytics,
  ActivityAnalyticsQuery,
  DailyActivity,
  MttrSummary,
  MonitorMetrics,
} from "./board/activity-analytics.js";
export { aggregateProductivityAnalytics, HUMAN_LINES_PER_HOUR } from "./board/productivity-analytics.js";
export type {
  ProductivityAnalytics,
  ProductivityAnalyticsQuery,
  LanguageCount,
  LocSummary,
  HoursSavedSummary,
} from "./board/productivity-analytics.js";
export { aggregatePluginActivations } from "./plugins/plugin-activation-analytics.js";
export type {
  PluginActivationAnalytics,
  PluginActivationAnalyticsQuery,
  PluginActivationPluginCount,
} from "./plugins/plugin-activation-analytics.js";
export { aggregateTeamAnalytics } from "./board/team-analytics.js";
export type {
  TeamAnalytics,
  TeamAnalyticsQuery,
  TeamAgentSummary,
  TeamMetricTotals,
} from "./board/team-analytics.js";
export { aggregateWorkflowAnalytics } from "./board/workflow-analytics.js";
export type {
  WorkflowAnalytics,
  WorkflowAnalyticsQuery,
  WorkflowSummary,
  WorkflowMetricTotals,
} from "./board/workflow-analytics.js";
export { aggregateGithubIssueAnalytics } from "./board/github-issue-analytics.js";
export type {
  GithubIssueAnalytics,
  GithubIssueAnalyticsQuery,
  GithubIssueDailyPoint,
  GithubIssueRepoBreakdown,
  GithubResolvedIssue,
} from "./board/github-issue-analytics.js";
export { aggregateGitlabIssueAnalytics } from "./board/gitlab-issue-analytics.js";
export type {
  GitlabIssueAnalytics,
  GitlabIssueAnalyticsQuery,
  GitlabIssueDailyPoint,
  GitlabIssueProjectBreakdown,
  GitlabResolvedIssue,
} from "./board/gitlab-issue-analytics.js";
export { aggregateSignalsAnalytics } from "./board/activity-analytics.js";
export type {
  SignalSourceCount,
  SignalSeverityCount,
  SignalsAnalytics,
  ActivityAnalyticsQuery as SignalsAnalyticsQuery,
} from "./board/activity-analytics.js";
export { composeLiveSnapshot } from "./board/command-center-live.js";
export type {
  LiveSnapshot,
  LiveSession,
  LiveRun,
  ColumnCount,
} from "./board/command-center-live.js";
export { mapAnalyticsToOtlp, OTEL_METRIC_PREFIX } from "./process/otel-metrics.js";
export type {
  OtelMappingInput,
  OtlpExportPayload,
  OtlpMetric,
  OtlpNumberDataPoint,
  OtlpAttribute,
} from "./process/otel-metrics.js";
export {
  STALLED_REVIEW_REENQUEUE_THRESHOLD,
  STALLED_REVIEW_INVALID_TRANSITION_THRESHOLD,
  STALLED_REVIEW_WINDOW_MS,
  STALLED_REVIEW_REENQUEUE_PATTERN,
  STALLED_REVIEW_INVALID_TRANSITION_PATTERN,
  detectStalledReview,
} from "./tasks/stalled-review-detector.js";
export type { StalledReviewSignal } from "./tasks/stalled-review-detector.js";
export {
  detectTaskIdIntegrityAnomalies,
} from "./tasks/task-id-integrity.js";
export {
  TASK_ID_TOKEN_RE,
  extractTaskIdTokens,
  hasTitleIdDrift,
  normalizeTitleForTaskId,
} from "./tasks/task-title-id-drift.js";
export {
  IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
  MANUAL_RETRY_RESET_COUNTER_KEYS,
  buildAutoPauseClearPatch,
  buildManualRetryResetPatch,
} from "./tasks/manual-retry-reset.js";
export type {
  TaskIdIntegrityAnomaly,
  TaskIdIntegrityAnomalyKind,
  TaskIdIntegrityReport,
} from "./tasks/task-id-integrity.js";
export {
  FUSION_TASK_LINEAGE_TRAILER_KEY,
  buildTaskLineageTrailer,
  classifyTaskCommitAssociationConfidence,
  generateTaskLineageId,
  normalizeTaskCommitAssociation,
  parseTaskLineageTrailer,
} from "./tasks/task-lineage.js";
export {
  createDistributedTaskIdAllocator,
  formatDistributedTaskId,
  resolveLocalNodeId,
  DistributedTaskIdError,
} from "./tasks/distributed-task-id.js";
export type { DistributedTaskIdAllocator } from "./tasks/distributed-task-id.js";
export {
  Database,
  createDatabase,
  toJson,
  toJsonNullable,
  fromJson,
  SCHEMA_VERSION,
  // FNXC:CoreTests 2026-06-25-16:30: test-only migrated-DB snapshot hook so
  // cross-package suites (dashboard route tests) can amortize db.init() cost.
  setInMemoryTemplateSnapshot,
  // FNXC:CliBoardMutation 2026-07-09-00:00: exported so the CLI-level
  // lock-retry wrapper (packages/cli/src/lock-retry.ts, FN-7731) can classify
  // SQLite lock errors identically to the DB layer's own runWithLockRecovery,
  // instead of re-implementing (and risking drift in) the detection regex.
  isSqliteLockError,
} from "./db/db.js";
export {
  ProjectIdentityConflictError,
  ProjectIdentityMismatchError,
  readProjectIdentity,
  writeProjectIdentity,
  hasProjectIdentity,
  PROJECT_IDENTITY_FILENAME,
  readProjectIdentityAsync,
  writeProjectIdentityAsync,
} from "./central/project-identity.js";
export { ProcessSupervisor, superviseSpawn, FUSION_RESTART_EXIT_CODE, FUSION_NON_RETRYABLE_EXIT_CODE } from "./process/process-supervisor.js";
export { isPostgresUniqueError } from "./db/postgres-errors.js";
export type {
  SuperviseSpawnOptions,
  SupervisedChild,
  SupervisedExit,
} from "./process/process-supervisor.js";
export { DatabaseSync } from "./db/sqlite-adapter.js";
export type { Statement, VacuumResult } from "./db/db.js";
export type { ProjectIdentity } from "./central/project-identity.js";
export type { EnsureProjectForPathInput, EnsureProjectForPathResult } from "./central/central-core.js";
export { ArchiveDatabase } from "./db/archive-db.js";
export { GlobalSettingsStore, resolveGlobalDir, resolveGlobalDirForHome } from "./config/global-settings.js";
export { ConfigurationRevisionStore, GLOBAL_CONFIGURATION_OWNER_ID } from "./config/configuration-revision-store.js";
export { configurationTargetKey, createConfigurationRevision, diffConfigurationSnapshots, appendConfigurationRevision, appendGlobalConfigurationRevision, listConfigurationRevisions, listGlobalConfigurationRevisions, getConfigurationRevision, getGlobalConfigurationRevision, rollbackConfiguration } from "./async-stores/async-configuration-revision-store.js";
export type { ConfigKind, ConfigChangedBy, ConfigurationOwnerScope, ConfigurationTarget, ConfigurationRevision } from "./types.js";
export { isValidSqliteDatabaseFile } from "./db/sqlite-validation.js";
export { DaemonTokenManager, DAEMON_TOKEN_PREFIX, DAEMON_TOKEN_HEX_LENGTH, isDaemonTokenFormat } from "./cli/daemon-token.js";
export {
  MasterKeyManager,
  MASTER_KEY_KEYCHAIN_SERVICE,
  MASTER_KEY_KEYCHAIN_ACCOUNT,
  MASTER_KEY_FILENAME,
  MasterKeyPermissionError,
  MasterKeyCorruptError,
} from "./secrets/master-key.js";
export {
  assertNotLinkedWorktreeOfExistingProject,
  assertProjectRootDir,
  LinkedWorktreeBootstrapRefusedError,
} from "./central/project-root-guard.js";
export { discoverPiExtensions, formatPiExtensionSource, getEnabledPiExtensionPaths, getFusionAgentDir, getFusionAgentSettingsPath, getLegacyPiAgentDir, getPiExtensionDiscoveryDirs, getProjectRootFromWorktree, reconcileClaudeCliPaths, reconcileDroidCliPaths, resolvePiExtensionProjectRoot, updatePiExtensionDisabledIds } from "./plugins/pi-extensions.js";
export type { PiExtensionEntry, PiExtensionSettings, PiExtensionSource } from "./plugins/pi-extensions.js";
export { canTransition, getValidTransitions, resolveDependencyOrder } from "./board/board.js";
export { computeBlockerFanoutMap, BLOCKER_ESCALATION_COLUMNS, isStaleBlockedByBlocker } from "./tasks/blocker-fanout.js";
export type { BlockerFanoutEntry, BlockerEscalation, ComputeBlockerFanoutOptions } from "./tasks/blocker-fanout.js";
export {
  computeCapacityRisk,
  DEFAULT_CAPACITY_RISK_TODO_THRESHOLD,
} from "./board/capacity.js";
export type { CapacityRiskSignal } from "./board/capacity.js";
export {
  computeDependencyBlockedTodoReport,
  DEFAULT_DEPENDENCY_BLOCKED_TODO_FRESH_MS,
  DEFAULT_DEPENDENCY_BLOCKED_TODO_STALE_MS,
  DEFAULT_DEPENDENCY_BLOCKED_TODO_MIN_COUNT,
  DEFAULT_DEPENDENCY_BLOCKED_TODO_MAX_GROUPS,
} from "./tasks/dependency-blocked-todo-report.js";
export type {
  DependencyBlockedTodoCode,
  DependencyBlockedTodoGroup,
  DependencyBlockedTodoReport,
  DependencyBlockedTodoReportContext,
} from "./tasks/dependency-blocked-todo-report.js";
export { getPrimaryPrInfo, taskHasManualOpenPullRequest } from "./tasks/task-helpers.js";
export {
  getTaskMergeBlocker,
  getTaskHardMergeBlocker,
  getTaskCompletionBlocker,
  getLatestFailedPreMergeReviewStep,
  isTaskReadyForMerge,
  allowsAutoMergeProcessing,
  isSharedBranchGroupMemberIntegration,
  isLiveSharedBranchGroupMemberIntegration,
  resolveEffectiveAutoMerge,
  resolveEffectiveGroupAutoMerge,
  resolveTaskMergeTarget,
  AWAITING_APPROVAL_PAUSE_REASON,
  isTaskBlockedOnApproval,
  type MergeTargetResolution,
  type MergeTargetResolverOptions,
} from "./merge/task-merge.js";
export {
  isBranchGroupMemberLanded,
  isBranchGroupComplete,
} from "./branch/branch-group-completion.js";
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
  summarizePrThreadActivity,
  type PrThreadActivity,
} from "./merge/pr-entity.js";
export {
  findVitestProcessIds,
  type FindVitestProcessIdsOptions,
} from "./process/vitest-processes.js";
export {
  classifyProviderError,
  countRecentIdenticalStallEntries,
  getInReviewStallReason,
  IN_REVIEW_STALL_DEADLOCK_LOG_PREFIX,
  IN_REVIEW_STALL_LOG_PREFIX,
  IN_REVIEW_STALL_TERMINAL_LOG_PREFIX,
  DEFAULT_STALE_MERGING_MIN_AGE_MS,
  DEFAULT_MAX_AUTO_MERGE_RETRIES,
  resolveMaxAutoMergeRetries,
  DEFAULT_MAX_CONSECUTIVE_TOOL_FAILURE_RETRIES,
  DEFAULT_CONSECUTIVE_TOOL_FAILURE_RETRY_BACKOFF_MS,
  CONSECUTIVE_TOOL_FAILURE_RETRY_THRESHOLD,
  resolveMaxConsecutiveToolFailureRetries,
  resolveConsecutiveToolFailureRetryBackoffMs,
  resolveConsecutiveToolFailureThreshold,
  resolveExecutorEscalationTarget,
} from "./tasks/in-review-stall.js";
export type { ExecutorEscalationTarget, InReviewStallSignal, InReviewStallCode, ProviderErrorClassification } from "./tasks/in-review-stall.js";
export {
  getStalePausedReviewSignal,
  DEFAULT_STALE_PAUSED_REVIEW_THRESHOLD_MS,
} from "./tasks/stale-paused-review.js";
export type { StalePausedReviewCode, StalePausedReviewSignal } from "./tasks/stale-paused-review.js";
export {
  getInReviewStalledSignal,
  DEFAULT_IN_REVIEW_STALLED_THRESHOLD_MS,
} from "./tasks/in-review-stalled.js";
export type { InReviewStalledCode, InReviewStalledSignal } from "./tasks/in-review-stalled.js";
export {
  getStalePausedTodoSignal,
  DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS,
} from "./tasks/stale-paused-todo.js";
export type { StalePausedTodoCode, StalePausedTodoSignal } from "./tasks/stale-paused-todo.js";
export {
  getTaskAgeStalenessSignal,
  DEFAULT_TASK_AGE_STALENESS_THRESHOLDS,
} from "./tasks/task-age-staleness.js";
export type {
  TaskAgeStalenessLevel,
  TaskAgeStalenessSignal,
  TaskAgeStalenessThresholds,
} from "./tasks/task-age-staleness.js";
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
} from "./cli/gh-cli.js";
export {
  DEFAULT_GIT_CLI_STATUS_TIMEOUT_MS,
  GIT_INSTALL_URL,
  probeGitCliStatus,
  type GitCliStatus,
  type ProbeGitCliStatusOptions,
} from "./cli/git-cli-status.js";
export { resolveGitBinary, invalidateGitBinaryCache, isSpawnGitEnoent, wellKnownGitBinaryPaths } from "./cli/git-binary.js";
export {
  parseRepoSlug,
  isValidRepoSlug,
  resolveTaskGithubTracking,
} from "./git/github-tracking.js";
export type { RepoSlug, ResolvedTaskGithubTracking } from "./git/github-tracking.js";
export { resolveTaskSessionAdvisorEnabled } from "./agents/session-advisor.js";
export type { ResolvedTaskSessionAdvisor } from "./agents/session-advisor.js";
export { AUTOMATION_PRESETS, AUTOMATION_SELECTABLE_TOOLS, MAX_RUN_HISTORY } from "./automation/automation.js";
export type { ScheduleType, ScheduledTask, ScheduledTaskCreateInput, ScheduledTaskUpdateInput, AutomationRunResult, AutomationStepType, AutomationStep, AutomationStepResult, AutomationSelectableTool } from "./automation/automation.js";
export { AutomationStore } from "./automation/automation-store.js";
export type { AutomationStoreEvents } from "./automation/automation-store.js";
export { runCommandAsync } from "./process/run-command.js";
export type { RunCommandOptions, RunCommandResult } from "./process/run-command.js";
export {
  EXPERIMENT_SESSION_STATUSES,
  EXPERIMENT_METRIC_DIRECTIONS,
  EXPERIMENT_RECORD_TYPES,
  EXPERIMENT_RUN_OUTCOMES,
  isRunRecord,
  isConfigRecord,
  isHookRecord,
  isFinalizeRecord,
} from "./eval/experiment-session-types.js";
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
} from "./eval/experiment-session-types.js";
export { ExperimentSessionStore } from "./eval/experiment-session-store.js";
export {
  detectFnBinary,
  FN_NPM_PACKAGE,
  FN_INSTALL_NPM,
  FN_INSTALL_CURL,
  FN_NPX_INVOCATION,
} from "./cli/fn-binary.js";
export type { FnBinaryStatus, FnBinaryName } from "./cli/fn-binary.js";
export {
  validateNodeOverrideChange,
  type NodeOverrideValidationResult,
  type NodeOverrideBlockReason,
} from "./mesh/node-override-guard.js";
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
  validateMcpServerDefinition,
  validateMcpServerDefinitionDetailed,
  validateMcpServerDefinitions,
  validateMcpServerDefinitionsDetailed,
  validateMcpServersSettings,
  validateMcpServersSettingsDetailed,
  validateUnavailableNodePolicy,
  assertWorktreeNamingRecycleExclusive,
  isRecycleWorktreeNamingConflict,
  RECYCLE_WORKTREE_NAMING_CONFLICT_MESSAGE,
} from "./config/settings-validation.js";
export type { McpValidationError, McpValidationResult } from "./config/settings-validation.js";

export { parseSandboxPromptOverride, resolveSandboxBackend } from "./sandbox/sandbox-prompt-override.js";

// ── Routine System ───────────────────────────────────────────────────
export {
  MAX_ROUTINE_RUN_HISTORY,
  isCronTrigger,
  isWebhookTrigger,
  isApiTrigger,
  isManualTrigger,
} from "./automation/routine.js";
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
} from "./automation/routine.js";
export { RoutineStore } from "./automation/routine-store.js";
export type { RoutineStoreEvents } from "./automation/routine-store.js";

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
  PluginOnPostgresSchemaInit,
  PluginPostgresSchemaDefinition,
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
  PluginMcpServerContribution,
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
} from "./plugins/plugin-types.js";
export {
  validatePluginManifest,
  validatePluginTraitContribution,
  validateWorkflowExtensionContribution,
  PLUGIN_TRAIT_RESTRICTED_FLAGS,
  PLUGIN_TRAIT_ALLOWED_HOOK_POINTS,
  PLUGIN_TRAIT_SCHEMA_VERSION,
  normalizePluginUiContributionSurface,
  normalizePluginUiContributionDefinition,
} from "./plugins/plugin-types.js";
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
} from "./workflows/workflow-extension-types.js";
export {
  WORKFLOW_EXTENSION_SCHEMA_VERSION,
  workflowExtensionRegistryId,
} from "./workflows/workflow-extension-types.js";
export {
  WorkflowExtensionRegistry,
  WorkflowExtensionRegistrationError,
  getWorkflowExtensionRegistry,
  __resetWorkflowExtensionRegistryForTests,
} from "./workflows/workflow-extension-registry.js";
export type {
  WorkflowExtensionDefinition,
  WorkflowExtensionRegistrationReason,
} from "./workflows/workflow-extension-registry.js";
export {
  createBoardActionServices,
} from "./board/board-action-services.js";
export type {
  BoardActionServices,
  BoardActionTaskStore,
  MoveBoardTaskInput,
  UpdateBoardTaskInput,
} from "./board/board-action-services.js";
export { PluginStore } from "./stores/plugin-store.js";
export type { PluginStoreEvents, PluginRegistrationInput, PluginUpdateInput } from "./stores/plugin-store.js";
export { PluginLoader, resolvePluginEntryPath } from "./plugins/plugin-loader.js";
export {
  BUNDLED_PLUGIN_IDS,
  isBundledPluginId,
  ensureBundledPluginInstalled,
  ensureBundledDependencyGraphPluginInstalled,
  ensureBundledCursorRuntimePluginInstalled,
  ensureBundledGrokRuntimePluginInstalled,
} from "./plugins/bundled-plugin-install.js";
export type { BundledPluginId, EnsureBundledResult, BundledPluginDirResolver } from "./plugins/bundled-plugin-install.js";
export { scanPluginSecurity } from "./plugins/plugin-security-scan.js";
export type { PluginSecurityScanResult, PluginSecurityFinding } from "./plugins/plugin-security-scan.js";
export type {
  PluginLoaderOptions,
  PluginLoadedEvent,
  PluginUnloadedEvent,
  PluginReloadedEvent,
  PluginErrorEvent,
} from "./plugins/plugin-loader.js";
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
  resolveBackendConnectionString,
  resolveGlobalBackupRoot,
} from "./backup/backup.js";
export type { BackupInfo, BackupOptions, BackupFileInfo, BackupPairInfo } from "./backup/backup.js";
export { GlobalRoutineStore } from "./automation/global-routine-store.js";
export { migrateBackupSettingsToGlobalOnce, planBackupSettingsMigration, resolveBackupSettingsMigrationConflict } from "./backup/backup-settings-migration.js";
export type { BackupSettingKey } from "./backup/backup-settings-migration.js";
export {
  registerEmbeddedRuntimeUrl,
  releaseEmbeddedRuntimeLease,
  invalidateEmbeddedRuntimeUrl,
  getActiveEmbeddedRuntimeUrl,
  clearActiveEmbeddedRuntimeUrl,
} from "./postgres/active-backend-registry.js";
export type { EmbeddedRuntimeLease } from "./postgres/active-backend-registry.js";
export {
  MemoryBackupManager,
  createMemoryBackupManager,
  runMemoryBackupCommand,
  validateMemoryBackupSchedule,
  MEMORY_BACKUP_SCHEDULE_NAME,
  syncMemoryBackupAutomation,
  syncMemoryBackupRoutine,
} from "./memory/memory-backup.js";
export type { MemoryBackupInfo, MemoryBackupOptions } from "./memory/memory-backup.js";
export {
  exportSettings,
  importSettings,
  validateImportData,
  generateExportFilename,
  readExportFile,
  writeExportFile,
  SETTINGS_EXPORT_VERSION,
} from "./config/settings-export.js";
export type {
  SettingsExportData,
  ExportSettingsOptions,
  ImportSettingsOptions,
  ImportResult,
  WorkflowSettingsExportSection,
} from "./config/settings-export.js";

// ── AI Summarization ─────────────────────────────────────────────────────

export {
  summarizeTitle,
  summarizeMergeCommit,
  summarizeCommitBody,
  summarizeCommitSubject,
  sanitizeCommitSubject,
  deriveFallbackTaskTitle,
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
  MAX_TITLE_SUMMARIZE_INPUT_LENGTH,
  MIN_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_MERGE_COMMIT_SUMMARY_LENGTH,
  FALLBACK_TASK_TITLE,
  MAX_COMMIT_BODY_INPUT_LENGTH,
  MAX_COMMIT_BODY_LENGTH,
  DEFAULT_COMMIT_BODY_TIMEOUT_MS,
  MAX_REQUESTS_PER_HOUR,
  ValidationError,
  RateLimitError,
  AiServiceError,
  __resetSummarizeState,
} from "./ai/ai-summarize.js";
export {
  applyTestModeOverrides,
  hasConfiguredFallbackLane,
  isTestModeActive,
  resolveExecutionSettingsModel,
  resolveExecutorFallbackModel,
  resolvePlanningFallbackModel,
  resolveValidatorFallbackModel,
  resolveSelectedWorkflowModelLane,
  resolveMergerFallbackModel,
  resolveMergerSettingsModel,
  resolvePhaseThinkingLevel,
  resolvePlanningSettingsModel,
  resolveProjectDefaultModel,
  resolveSettingsLaneThinkingLevel,
  resolveTaskExecutionModel,
  resolveTaskMergerModel,
  resolveTaskPlanningModel,
  resolveTaskValidatorModel,
  resolveTitleSummarizerSettingsModel,
  resolveImportTranslateSettingsModel,
  resolveValidatorSettingsModel,
  TEST_MODE_RESOLVED,
  routeTaskExecutionModel,
  routeTaskPlanningModel,
  routeTaskValidatorModel,
} from "./ai/model-resolution.js";
export type { ModelThinkingPhase, ResolvedModelSelection, RouterLaneOptions } from "./ai/model-resolution.js";
export {
  routeModel,
  routeModelAndEmit,
  isMechanicalRoutableContext,
} from "./ai/model-router.js";
export type {
  RouterLane,
  RouterReason,
  RouterPair,
  RouterTaskContext,
  RouteModelInput,
  RouterDecision,
  RouterEscalation,
  ModelGovernancePredicate,
} from "./ai/model-router.js";

// ── Memory Compaction ─────────────────────────────────────────────────

export {
  compactMemoryWithAi,
  COMPACT_MEMORY_SYSTEM_PROMPT,
  createAutoSummarizeAutomation,
  syncAutoSummarizeAutomation,
  AUTO_SUMMARIZE_SCHEDULE_NAME,
  DEFAULT_AUTO_SUMMARIZE_SCHEDULE,
  __resetCompactionState,
} from "./memory/memory-compaction.js";
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
} from "./tasks/task-priority.js";
export type {
  TaskPrioritySortable,
  TaskColumnSortable,
  BuildUnblockWeightMapOptions,
  PriorityFanoutComparatorContext,
} from "./tasks/task-priority.js";

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
  MISSION_ASSERTION_TYPES,
  DEFAULT_MISSION_ASSERTION_TYPE,
  normalizeMissionAssertionType,
  MILESTONE_VALIDATION_STATES,
} from "./missions/mission-types.js";
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
  MissionAssertionType,
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
} from "./missions/mission-types.js";
export { MissionStore } from "./missions/mission-store.js";
export type { MissionStoreEvents, MissionSummary } from "./missions/mission-store.js";
export { AsyncMissionStore, TerminalTaskReconciliationError } from "./async-stores/async-mission-store.js";
export type { TerminalTaskReconciliationErrorCode } from "./async-stores/async-mission-store.js";
export { AsyncIdeationStore } from "./async-stores/async-ideation-store.js";
export { IDEATION_SESSION_STATUSES, IDEATION_CANDIDATE_ORIGINS } from "./ideation/ideation-types.js";
export type { IdeationSessionStatus, IdeationCandidateOrigin, IdeationSession, IdeationCandidate, IdeationSessionCreateInput, IdeationCandidateCreateInput, IdeationCandidateUpdateInput, IdeationConvergeInput, IdeationSessionWithCandidates } from "./ideation/ideation-types.js";
export { ACTIVE_GOAL_LIMIT, ActiveGoalLimitExceededError } from "./goals/goal-types.js";
export type { Goal, GoalCreateInput, GoalListFilter, GoalStatus, GoalUpdateInput } from "./goals/goal-types.js";
export { GoalStore } from "./goals/goal-store.js";
export type { GoalStoreEvents } from "./goals/goal-store.js";
export { AsyncGoalStore } from "./async-stores/async-goal-store.js";
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
} from "./goals/goal-citation-extractor.js";

// ── Central Infrastructure (Multi-Project Support) ───────────────────────────

export { CentralCore } from "./central/central-core.js";
export type { CentralCoreEvents } from "./central/central-core.js";
export { CentralDatabase, createCentralDatabase, getDefaultCentralDbPath } from "./central/central-db.js";
export { NodeConnection } from "./mesh/node-connection.js";
export { NodeDiscovery } from "./mesh/node-discovery.js";
export { getAvailableMemoryBytes, getAvailableMemoryInfo, type AvailableMemoryReading } from "./process/available-memory.js";
export { collectSystemMetrics } from "./mesh/system-metrics.js";
export { getAppVersion, parseSemver, compareVersions, isVersionNewer, resolveUpdateTargetVersion } from "./i18n/app-version.js";
export type { UpdateChannel, UpdateDistTags } from "./i18n/app-version.js";
export { DockerClientService } from "./docker/docker-client.js";
export { MeshConfigGenerator } from "./mesh/mesh-config-generator.js";
export { DockerProvisioningService } from "./docker/docker-provisioning.js";
export type {
  ConnectionErrorType,
  ConnectionOptions,
  ConnectionResult,
  TestAndRegisterOptions,
  TestAndRegisterResult,
} from "./mesh/node-connection.js";
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
} from "./central/migration.js";
export type {
  FirstRunState,
  DetectedProject,
  MigrationResult,
  ProjectSetupInput,
  ResolvedContext,
} from "./central/migration.js";

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
} from "./memory/memory-insights.js";
export type {
  MemoryInsightCategory,
  MemoryInsight,
  InsightExtractionResult,
  MemoryAuditCheck,
  MemoryAuditReport,
  ProcessRunInput,
} from "./memory/memory-insights.js";

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
} from "./memory/project-memory.js";

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
} from "./memory/memory-backend.js";

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
} from "./memory/memory-backend.js";

export { MemoryBackendError } from "./memory/memory-backend.js";

export type { MemoryBackendCapabilities, MemoryFileInfo, MemoryGetOptions, MemoryGetResult, MemorySearchOptions, MemorySearchResult } from "./memory/memory-backend.js";

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
} from "./memory/memory-dreams.js";
export type { AgentDreamProcessorResult, DreamProcessorResult, DreamPromptExecutor } from "./memory/memory-dreams.js";

// ── Project Insights ──────────────────────────────────────────────────────

export { InsightLifecycleError, InsightStore, computeInsightFingerprint } from "./insights/insight-store.js";
// FNXC:InsightStore 2026-06-28-10:10: export the PostgreSQL-backed AsyncInsightStore
// so the dashboard insights routes + run sweeper can type the run-execution store
// path as the `InsightStore | AsyncInsightStore` union (insight-run execution in PG mode).
export { AsyncInsightStore } from "./async-stores/async-insight-store.js";
export { AsyncCentralClaimStore } from "./async-stores/async-central-db.js";
export {
  classifyInsightRunError,
  executeInsightRunLifecycle,
  retryInsightRunLifecycle,
} from "./insights/insight-run-executor.js";
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
} from "./insights/insight-types.js";
export type {
  InsightRunAttemptContext,
  InsightRunAttemptResult,
  InsightRunExecutorErrorClassification,
  InsightRunExecutorOptions,
} from "./insights/insight-run-executor.js";

// ── Research System ───────────────────────────────────────────────────────

export { ResearchLifecycleError, ResearchStore } from "./research/research-store.js";
// FNXC:ResearchStore 2026-06-28-11:30: export the PostgreSQL-backed AsyncResearchStore
// so the engine's ResearchOrchestrator/ResearchRunDispatcher can type their store as
// the `ResearchStore | AsyncResearchStore` union (research run execution in PG mode).
export { AsyncResearchStore } from "./async-stores/async-research-store.js";
export {
  RESEARCH_RUN_STATUSES,
  RESEARCH_SOURCE_STATUSES,
  RESEARCH_EXPORT_FORMATS,
  RESEARCH_SOURCE_TYPES,
  RESEARCH_EVENT_TYPES,
  RESEARCH_ORCHESTRATION_PHASES,
  RESEARCH_ORCHESTRATION_STEP_STATUSES,
  RESEARCH_RUN_FAILURE_CLASSES,
  resolveResearchFindingId,
} from "./research/research-types.js";
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
} from "./research/research-types.js";

export { isExperimentalFeatureEnabled, GRAPH_NATIVE_POST_MERGE_FLAG } from "./config/experimental-features.js";
export {
  DEFAULT_MOBILE_NAV_PRIMARY_ITEMS,
  MAX_MOBILE_NAV_PRIMARY_ITEMS,
  MOBILE_NAV_SELECTABLE_ITEMS,
  MOBILE_NAV_SELECTABLE_ITEM_LABEL_KEYS,
  resolveMobileNavPrimaryItems,
  type MobileNavSelectableItem,
  type ResolvedMobileNavPrimaryItems,
} from "./board/mobile-nav-primary-items.js";
export {
  POST_MERGE_VERIFICATION_GROUP_ID,
  postMergeOptionalGroupNode,
  postMergeVerificationOptionalGroupNode,
} from "./workflows/builtin-post-merge-group.js";
export type { PostMergeOptionalGroupSpec } from "./workflows/builtin-post-merge-group.js";
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
} from "./workflows/workflow-parity.js";
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
} from "./workflows/workflow-parity.js";
export { isResearchExperimentalEnabled, resolveResearchSettings } from "./research/research-settings.js";
export type { ResolvedResearchSettings } from "./research/research-settings.js";
export { isEvalsExperimentalEnabled, resolveEvalSettings } from "./eval/eval-settings.js";
export { isSandboxExperimentalEnabled } from "./sandbox/sandbox-settings.js";

export { TodoStore } from "./stores/todo-store.js";
export type { TodoStoreEvents } from "./stores/todo-store.js";
export { EvalLifecycleError, EvalStore } from "./eval/eval-store.js";
export { AsyncEvalStore } from "./async-stores/async-eval-store.js";
export { collectDeterministicSignals } from "./eval/eval-signal-collector.js";
export type { EvalRunContext } from "./eval/eval-signal-collector.js";
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
} from "./eval/eval-types.js";
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
} from "./eval/eval-types.js";
export {
  EVAL_CATEGORY_WEIGHTS,
  assertValidScore,
  clampScore,
  computeCategoryFinalScore,
  computeOverallScore,
  normalizeCategoryScore,
  resolveScoreBand,
} from "./eval/eval-scoring.js";
export {
  TASK_EVALUATION_SCHEDULE_NAME,
  DEFAULT_TASK_EVALUATION_SCHEDULE,
  TASK_EVALUATION_SCHEDULE_COMMAND,
  resolveTaskEvaluationSettings,
  createScheduledEvalBatchAutomation,
  syncScheduledEvalBatchAutomation,
  runScheduledEvalBatch,
} from "./eval/eval-automation.js";
export type {
  ResolvedTaskEvaluationSettings,
  EvalBatchWindow,
  CompletedTaskEvaluationContext,
  CompletedTaskEvaluator,
  EvalBatchTaskStore,
  RunScheduledEvalBatchParams,
  ScheduledEvalBatchResult,
} from "./eval/eval-automation.js";

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
} from "./agents/agent-companies-types.js";

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
} from "./agents/agent-companies-parser.js";
export type {
  PreparedAgentCompaniesImportItem,
  PreparedAgentCompaniesImportResult,
} from "./agents/agent-companies-parser.js";

// ── Agent Companies Exporter ──────────────────────────────

export {
  slugify,
  agentToCompaniesManifest,
  generateCompanyMd,
  generateAgentMd,
  exportAgentsToDirectory,
} from "./agents/agent-companies-exporter.js";
export type {
  ExportOptions,
  ExportResult,
} from "./agents/agent-companies-exporter.js";

// ── Organization portability ──────────────────────────────
export {
  ORG_BUNDLE_VERSION,
  assembleOrgBundle,
  materializeOrgBundle,
  scrubOrgBundleSecrets,
} from "./agents/org-bundle.js";
export type {
  OrgBundle,
  OrgBundleAgent,
  OrgBundleSkill,
  OrgBundleRoutine,
  OrgBundleStores,
  OrgBundleMaterializeOptions,
  OrgBundleMaterializeResult,
} from "./agents/org-bundle.js";

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
  ChatTokenUsageSourceKind,
  ChatTokenUsageRecord,
  ChatTokenUsageCreateInput,
} from "./chat/chat-types.js";
export { ChatStore } from "./chat/chat-store.js";
export type { ChatStoreEvents } from "./chat/chat-store.js";
export {
  CLI_AGENT_STATES,
  CLI_TERMINATION_REASONS,
  CLI_SESSION_PURPOSES,
  isCliAgentState,
  isCliTerminationReason,
  isCliSessionPurpose,
} from "./cli/cli-session-types.js";
export type {
  CliAgentState,
  CliTerminationReason,
  CliSessionPurpose,
  CliAutonomyPosture,
  CliSession,
  CliSessionCreateInput,
  CliSessionUpdateInput,
} from "./cli/cli-session-types.js";
export { CliSessionStore } from "./cli/cli-session-store.js";
export type { CliSessionStoreEvents } from "./cli/cli-session-store.js";
export {
  choosePreferredStoredCredential,
  extractClaudeCliStoredCredential,
  extractCodexCliStoredCredential,
  getClaudeCodeCredentialPaths,
  getCodexCliAuthPath,
  readStoredCredentialsFromAuthFile,
  shouldHydrateStoredCredential,
} from "./secrets/oauth-credential-interop.js";
export type { StoredAuthCredential } from "./secrets/oauth-credential-interop.js";

// ── Error helpers ─────────────────────────────────────────
export { getErrorMessage } from "./process/error-message.js";

// ── Secrets crypto ───────────────────────────────────────
export {
  createSecretCipher,
  SecretCryptoError,
  redactForLog,
} from "./secrets/secrets-crypto.js";
export type {
  MasterKeyProvider,
  EncryptedSecret,
} from "./secrets/secrets-crypto.js";
export {
  isSecretScope,
  SecretsStore,
  SecretsStoreError,
} from "./secrets/secrets-store.js";
export type {
  SecretScope,
  SecretRecord,
} from "./secrets/secrets-store.js";
export {
  wrapSecretsBundle,
  unwrapSecretsBundle,
  SecretsSyncError,
} from "./secrets/secrets-sync.js";
export type {
  WrappedSecretsBundle,
  SecretsSyncRecord,
} from "./secrets/secrets-sync.js";
export {
  RESERVED_SYNC_PASSPHRASE_KEY,
  getSyncPassphrase,
  setSyncPassphrase,
  clearSyncPassphrase,
  hasSyncPassphraseConfigured,
} from "./secrets/secrets-sync-passphrase.js";
export { suggestTaskPrefix } from "./tasks/task-prefix.js";

// ── U1: PostgreSQL connection layer (backend resolution + connection pool) ──
export {
  resolveBackend,
  resolveBackendWithOptions,
  looksLikePoolerUrl,
  poolerWarning,
  describeBackendForLog,
  DATABASE_URL_ENV,
  DATABASE_MIGRATION_URL_ENV,
  POOLER_PREPARED_STATEMENT_WARNING,
  createConnectionSet,
  createConnectionSetFromUrl,
  verifyConnection,
  DatabaseConnectionError,
  redactUrlPassword,
  redactKeywordPassword,
  redactConnectionString,
  redactCredentialsFromMessage,
  REDACTED_PASSWORD_PLACEHOLDER,
  createAsyncDataLayer,
  recordRunAuditEvent,
  recordRunAuditEventWithinTransaction,
  checkPostgresHealth,
  detectSchemaDrift,
  healSchemaDrift,
  validateAndHealSchema,
  vacuumAnalyze,
  detectTaskIdIntegrityAnomaliesAsync,
  EXPECTED_PROJECT_COLUMNS,
  // FNXC:SqliteRemoval 2026-06-25-00:00:
  // SQLite migrator (U9) exports. The dual-read cutover harness (U10) has been
  // removed — it was a transitional operator tool that should not ship to end
  // users. The upgrade path is auto-migrate + keep the SQLite file as a backup.
  PgBackupManager,
  PROJECT_BACKUP_SCHEMAS,
  CENTRAL_BACKUP_SCHEMAS,
  migrateSqliteToPostgres,
  isSqliteMigrationComplete,
  getSqliteMigrationState,
  completeSqliteMigration,
  defaultMigrationSources,
  formatMigrationProgress,
  // FNXC:CentralProjectIdentity 2026-07-13-23:10:
  // Post-migration project-partition stamping, shared by the startup-factory
  // first-boot auto-migration and `fn db migrate` so migrated rows are re-keyed
  // to the central-registry project id on BOTH cutover paths.
  stampMigratedProjectRows,
  lookupRegisteredProjectIdByPath,
  rekeyFallbackProjectPartition,
  ProjectPartitionRekeyError,
  selectDegradedBindTarget,
  applySchemaBaseline,
  getAppliedMigrations,
  SCHEMA_BASELINE_VERSION,
  // FNXC:StaleBinaryGuard 2026-07-19-03:10 (U9b / R10): old-binary write refusal.
  StaleBinarySchemaError,
  assertBinaryNotOlderThanDatabase,
  // FNXC:BackendFlip 2026-06-26-14:30:
  // Runtime startup factory (cutover milestone). Production construction sites
  // (engine, dashboard, CLI serve/dashboard, desktop) consult this to boot
  // against PostgreSQL. Post default-flip: embedded PG is the default when
  // DATABASE_URL is unset; obsolete SQLite opt-out settings fail explicitly.
  createTaskStoreForBackend,
  createCentralBackendLayer,
  shouldUsePostgresBackend,
  isEmbeddedPgRequested,
  isEmbeddedPgOptedOut,
  EMBEDDED_PG_ENV,
  NO_EMBEDDED_PG_ENV,
  TEST_MODE_ENV,
  TEST_DATABASE_URL_ENV,
  TEST_DATABASE_MIGRATION_URL_ENV,
} from "./postgres/index.js";
export type {
  BackendMode,
  ResolvedBackend,
  ResolveBackendOptions,
  PostgresConnections,
  CreateConnectionOptions,
  AsyncDataLayer,
  CentralBackendLayerResult,
  DrizzleDb,
  DbTransaction,
  TransactionOptions,
  PostgresHealthSnapshot,
  SchemaDriftFinding,
  SchemaValidationReport,
  VacuumAnalyzeStats,
  VacuumAnalyzeResult,
  PgBackupOptions,
  PgBackupPair,
  PgDumpResult,
  SqliteMigrationSource,
  SqliteMigrationState,
  SchemaName,
  MigrationReport,
  MigrationProgressEvent,
  MigrationProgressPhase,
  TableMigrationResult,
  StampMigratedProjectRowsInput,
  StampMigratedProjectRowsResult,
  ProjectPartitionOwnership,
  ProjectPartitionRekeyReason,
  BackendBootResult,
  CreateTaskStoreForBackendOptions,
  LoadedPluginSchemaContract,
} from "./postgres/index.js";

// FNXC:RuntimeSatelliteAsync 2026-06-24-13:30:
// Async monitor helpers exported for the dashboard monitor-store dual-path.
export {
  recordDeploymentAsync,
  resolveIncidentAsync,
  ingestIncidentSignalAsync,
  getOpenIncidentByGroupingKeyAsync,
  getIncidentAsync,
  // FNXC:Monitor 2026-06-28-10:10:
  // Storm-guard async helpers exported so the dashboard monitor-trait can run
  // the full create→link→release sequence in PG backend mode (no longer
  // early-returns "absorbed" when store.backendMode).
  countRecentAutoFixTasksAsync,
  claimIncidentForFixTaskAsync,
  attachFixTaskAsync,
  releaseIncidentFixTaskClaimAsync,
} from "./task-store/async/async-monitor.js";
export type { Deployment as AsyncDeployment, Incident as AsyncIncident } from "./task-store/async/async-monitor.js";

// FNXC:RuntimeSatelliteCompletion 2026-06-24-23:40:
// Async AiSessionStore helpers exported for the dashboard AiSessionStore dual-path.
export {
  upsertAiSession,
  getAiSession,
  claimPlanningSessionTaskCreation,
  finalizePlanningSessionTaskCreation,
  reconcilePlanningSessionTaskCreation,
  releasePlanningSessionTaskCreation,
  listActiveAiSessions,
  listAllAiSessions,
  listRecoverableAiSessions,
  updateAiSessionStatus,
  updateAiSessionTitle,
  markDraftSummarized,
  updateDraft,
  pingAiSession,
  updateThinking as updateThinkingAsync,
  archiveAiSession,
  unarchiveAiSession,
  deleteAiSession,
  deleteAiSessionByIdAndType,
  recoverStaleAiSessions,
  cleanupOldAiSessions,
  cleanupStaleAiSessions,
} from "./async-stores/async-ai-session-store.js";
export type {
  AiSessionRow as AsyncAiSessionRow,
  AiSessionStatus as AsyncAiSessionStatus,
  AiSessionType as AsyncAiSessionType,
  AiSessionSummary as AsyncAiSessionSummary,
  AiSessionCleanupSummary as AsyncAiSessionCleanupSummary,
} from "./async-stores/async-ai-session-store.js";

// Re-export the drizzle-orm `sql` template tag so dashboard/engine consumers
// can build raw queries against the AsyncDataLayer without depending on
// drizzle-orm directly.
export { sql as drizzleSql, eq as drizzleEq } from "drizzle-orm";

// FNXC:PostgresSchema 2026-07-04-00:00:
// Re-export the PostgreSQL Drizzle schema namespace so plugin stores (which
// run in backend mode via ctx.taskStore.getAsyncLayer()) can build type-safe
// Drizzle queries against their own plugin-owned tables (materialized via the
// plugin schema-init hook) without a direct relative import into core's
// postgres internals. The shape definitions are harmless to expose: they only
// describe tables the AsyncDataLayer can already reach.
export { schema as postgresSchema } from "./postgres/index.js";
export {
  countKnowledgePagesInPostgres,
  queryKnowledgePagesInPostgres,
  upsertKnowledgePageInPostgres,
  type AsyncKnowledgePage,
  type AsyncKnowledgePageInput,
  type AsyncKnowledgeQueryOptions,
} from "./async-stores/async-knowledge.js";
export {
  upsertWorkflowStepResult,
  MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS,
  PLAN_REVIEW_LEASE_STALENESS_MS,
  classifyReviewLease,
  makeReviewLeaseRecord,
  isTerminalStepResult,
  type ReviewLeaseDisposition,
} from "./workflows/workflow-step-results.js";
// FNXC:SqliteRemoval 2026-07-14: Export async audit reader so engine tests can
// query run-audit events in backend mode (sync getRunAuditEvents returns [] in PG mode).
export { queryRunAuditEvents } from "./task-store/async/async-audit.js";

/*
FNXC:GitHubImportTranslate 2026-07-15-09:30:
Language detection is shared by the dashboard translate banner and the server-side auto-translate skip decision; exporting it from core keeps both surfaces on one heuristic.
*/
export {
  MIN_DETECTABLE_CHARS,
  detectContentLanguage,
  contentNeedsTranslation,
  localeDisplayName,
} from "./i18n/detect-content-language.js";
export type { LanguageFamily, DetectedContentLanguage } from "./i18n/detect-content-language.js";
export { promoteResearchFinding } from "./research/research-feature-promotion.js";
export type { ResearchFeaturePromotionInput } from "./research/research-feature-promotion.js";
export { getTotalAgentActiveMs, startPlanningSegment, finalizePlanningSegment } from "./tasks/task-timing.js";
export { ACTIVE_WORKFLOW_WORK_ITEM_STATES } from "./types.js";
export * from "./task-document-concurrency.js";
