export { AgentLogger, type AgentLoggerOptions, summarizeToolArgs } from "./agent-logger.js";
export { reloadExemptTools, addToExemptTools, getExemptToolNames } from "./agent-action-gate.js";
export {
  createTaskCreateTool,
  createTaskDocumentReadTool,
  createTaskDocumentWriteTool,
  createTaskLogTool,
  createSendMessageTool,
  createReadMessagesTool,
  createWorkflowListTool,
  createWorkflowGetTool,
  createWorkflowSelectTool,
  createWorkflowCreateTool,
  createWorkflowUpdateTool,
  createWorkflowDeleteTool,
  createTraitListTool,
  createWorkflowAuthoringTools,
  taskCreateParams,
  taskDocumentReadParams,
  taskDocumentWriteParams,
  taskLogParams,
  workflowListParams,
  workflowSelectParams,
  executeApprovedAgentProvisioning,
} from "./agent-tools.js";
export { AgentSemaphore, PRIORITY_MERGE, PRIORITY_EXECUTE, PRIORITY_SPECIFY } from "./concurrency.js";
export { TriageProcessor, type TriageProcessorOptions } from "./triage.js";
export { TaskExecutor, type TaskExecutorOptions } from "./executor.js";
export {
  WorkflowGraphExecutor,
  type WorkflowGraphExecutorDeps,
  type WorkflowGraphExecutorResult,
} from "./workflow-graph-executor.js";
export {
  runSplitJoin,
  type WorkflowBranchPersistence,
  type WorkflowBranchProgress,
  type WorkflowBranchRunState,
  type WorkflowBranchSemaphore,
} from "./workflow-graph-branches.js";
export {
  createDefaultNodeHandlers,
  createNoopLegacySeams,
  createParseStepsHandler,
  createCodeNodeHandler,
  PARSE_STEPS_DEFAULT_ARTIFACT,
  type WorkflowCustomNodeRunner,
  type WorkflowLegacySeams,
  type WorkflowSeamName,
  type ParseStepsHandlerDeps,
  type CodeNodeRunner,
  type DefaultNodeHandlerDeps,
} from "./workflow-node-handlers.js";
export {
  WorkflowGraphTaskRunner,
  type WorkflowGraphRunDisposition,
  type WorkflowGraphRunnerStore,
  type WorkflowGraphTaskRunResult,
  type WorkflowGraphTaskRunnerDeps,
} from "./workflow-graph-task-runner.js";
export { collectTaskEvaluationEvidence } from "./evaluator-evidence.js";
export { Scheduler, type SchedulerOptions } from "./scheduler.js";
export { MeshLeaseManager, type MeshLeaseManagerOptions, type LeaseRecoveryContext } from "./mesh-lease-manager.js";
export { MissionAutopilot, type MissionAutopilotOptions } from "./mission-autopilot.js";
export { MissionExecutionLoop, type MissionExecutionLoopOptions, type ValidationResult, loopLog } from "./mission-execution-loop.js";
export {
  aiMergeTask,
  listAutostashOrphans,
  applyAutostashBySha,
  dropAutostashBySha,
  getAutostashDiff,
  notifyAutostashOrphans,
  DiffVolumeRegressionError,
  MergeAbortedError,
  SquashAuditError,
  type MergerOptions,
  type AutostashOrphanRecord,
  stashUnrelatedRootDirChanges,
  dropAutostashHandle,
  restoreUnrelatedRootDirChanges,
  tryFastForwardFromOrigin,
  getConflictedFiles,
  type AutostashHandle,
} from "./merger.js";
export {
  registerMergeTraitHooks,
  resolveMergePolicy,
  type ResolvedMergePolicy,
  type MergeFileScopeMode,
  type MergeTraitStrategy,
} from "./merge-trait.js";
export {
  resolveIntegrationBranch,
  resolveIntegrationBranchSync,
  __resetIntegrationBranchCacheForTests,
} from "./integration-branch.js";
export {
  resolveBranchGroupMergeRouting,
  evaluateBranchGroupPromotion,
  evaluateBranchGroupCompletion,
  promoteBranchGroup,
  reconcileBranchGroupPr,
  type BranchGroupMergeRouting,
  type BranchGroupPromotionDecision,
  type BranchGroupCompletionStatus,
  type BranchGroupPromotionResult,
  type PromoteBranchGroupInput,
  type ReconcileBranchGroupPrResult,
  type CreateGroupPrFn,
  type SyncGroupPrFn,
  type CloseGroupPrFn,
  type GroupPrReconcileResult,
} from "./group-merge-coordinator.js";
export {
  resolveMergeIntegrationRoot,
  resolveIntegrationRemote,
  acquireReuseHandoff,
  releaseReuseHandoff,
  MergeHandoffRefusedError,
  type HandoffResult,
  type MergeIntegrationRootResolution,
} from "./merger-integration-worktree.js";
export {
  smartPull,
  type SmartPullInput,
  type SmartPullResult,
  type SmartPullMode,
  type SmartPullAuditEvent,
  type SmartPullAuditEmitter,
} from "./smart-pull.js";
export {
  syncWorktreeToHead,
  type SyncWorktreeInput,
  type SyncWorktreeResult,
  type SyncMode,
  type WorktreeSyncAuditEvent,
  type WorktreeSyncAuditEmitter,
} from "./worktree-ref-sync.js";
export {
  generateSyntheticRunId,
} from "./run-audit.js";
export {
  observeWorkflowParity,
  WORKFLOW_INTERPRETER_DUAL_OBSERVE_FLAG,
  type WorkflowParityObserverInput,
  type WorkflowParityObserverLegacyRunResult,
  type WorkflowParityObserverShadowRunResult,
} from "./workflow-parity-observer.js";
export {
  auditSquashMerge,
  formatSquashAuditReport,
  type SquashAuditFindings,
  type SquashAuditFinding,
  type SquashAuditDuplicateSubjectFinding,
  type SquashAuditTouchedFileOverlapFinding,
  type SquashAuditRecentMainCommit,
} from "./merger-squash-audit.js";
export { reviewStep, type ReviewType, type ReviewVerdict, type ReviewResult, type ReviewOptions } from "./reviewer.js";
export { createFnAgent, promptWithFallback, describeModel, setHostExtensionPaths, getHostExtensionPaths, type AgentOptions, type AgentResult } from "./pi.js";
export {
  createInteractiveAiSessionWith,
  parseAgentResponse as parseInteractiveAgentResponse,
  type InteractiveAgentSession,
  type InteractiveAgentResult,
  type InteractiveAgentFactory,
} from "./interactive-ai-session.js";
export { selectPermanentAgentForTask, listEligibleExecutorAgents } from "./agent-assignment.js";

// Register createFnAgent into core's loader so consumers in @fusion/core
// (e.g. ai-summarize, memory-compaction) can resolve it without a circular
// static import. Runs once at engine module load.
import type {
  AiSessionResult,
  CreateAiSessionFactory,
  CreateAiSessionOptions,
  CreateInteractiveAiSessionFactory,
  CreateInteractiveAiSessionOptions,
} from "@fusion/core";
import { createFnAgent as _createFnAgentForCore } from "./pi.js";
import { createInteractiveAiSessionWith } from "./interactive-ai-session.js";

const _createAiSessionAdapter: CreateAiSessionFactory = async (options: CreateAiSessionOptions): Promise<AiSessionResult> => {
  return _createFnAgentForCore({
    cwd: options.cwd,
    systemPrompt: options.systemPrompt,
    tools: options.tools,
    defaultProvider: options.defaultProvider,
    defaultModelId: options.defaultModelId,
  });
};

// Interactive (multi-turn, await-input) adapter: builds the prompt→parse→
// retry→pause→resume loop on top of the one-shot createFnAgent.
const _createInteractiveAiSessionAdapter: CreateInteractiveAiSessionFactory = (
  options: CreateInteractiveAiSessionOptions,
) =>
  createInteractiveAiSessionWith(
    (opts) =>
      _createFnAgentForCore({
        cwd: opts.cwd,
        systemPrompt: opts.systemPrompt,
        tools: opts.tools,
        defaultProvider: opts.defaultProvider,
        defaultModelId: opts.defaultModelId,
        // Forward skill selection so a plugin can load a specific bundled skill.
        // `skills` (convenience) auto-builds a SkillSelectionContext; the extra
        // discovery dirs make those skills actually visible to the loader.
        ...(opts.requestedSkillNames?.length ? { skills: opts.requestedSkillNames } : {}),
        ...(opts.additionalSkillPaths?.length ? { additionalSkillPaths: opts.additionalSkillPaths } : {}),
        // Live mid-turn visibility: stream thinking/text deltas and tool
        // start/end markers to the caller's onProgress while the pull-based
        // nextEvent() is still pending. Callback errors must never break the
        // agent turn.
        ...(opts.onProgress
          ? {
              onThinking: (delta: string) => {
                try {
                  opts.onProgress!({ type: "thinking", delta });
                } catch { /* consumer error must not break the turn */ }
              },
              onText: (delta: string) => {
                try {
                  opts.onProgress!({ type: "text", delta });
                } catch { /* consumer error must not break the turn */ }
              },
              onToolStart: (name: string) => {
                try {
                  opts.onProgress!({ type: "tool", name, phase: "start" });
                } catch { /* consumer error must not break the turn */ }
              },
              onToolEnd: (name: string, isError: boolean) => {
                try {
                  opts.onProgress!({ type: "tool", name, phase: "end", isError });
                } catch { /* consumer error must not break the turn */ }
              },
            }
          : {}),
      }),
    options,
  );

void import("@fusion/core")
  .then((core) => {
    if ("setCreateFnAgent" in core && typeof core.setCreateFnAgent === "function") {
      core.setCreateFnAgent(_createFnAgentForCore);
    }
    if ("setCreateAiSessionFactory" in core && typeof core.setCreateAiSessionFactory === "function") {
      core.setCreateAiSessionFactory(_createAiSessionAdapter);
    }
    if ("setCreateInteractiveAiSessionFactory" in core && typeof core.setCreateInteractiveAiSessionFactory === "function") {
      core.setCreateInteractiveAiSessionFactory(_createInteractiveAiSessionAdapter);
    }
  })
  .catch(() => {
    // Ignore loader registration failures in constrained test/mocked environments.
  });
export {
  resolveSessionSkills,
  createSkillsOverrideFromSelection,
  type SkillSelectionContext,
  type SkillSelectionResult,
  type SkillDiagnostic,
} from "./skill-resolver.js";
export { AgentReflectionService, type AgentReflectionServiceOptions } from "./agent-reflection.js";
export { AgentSelfImproveService, type AgentSelfImproveServiceOptions } from "./agent-self-improve.js";
export {
  buildAgentChatPrompt,
  resolveAgentInstructionsWithRatings,
  resolveAgentInstructions,
  buildSystemPromptWithInstructions,
  resolveAgentHeartbeatProcedure,
  ensureDefaultHeartbeatProcedureFile,
} from "./agent-instructions.js";
export { HEARTBEAT_PROCEDURE, HEARTBEAT_SYSTEM_PROMPT, HEARTBEAT_NO_TASK_SYSTEM_PROMPT } from "./agent-heartbeat.js";
export {
  MOCK_PROVIDER_ID,
  MOCK_SYNTHETIC_TOKEN_USAGE,
  MockAgentRuntime,
  MockAgentSession,
  mockScriptRegistry,
  setMockScript,
  clearMockScript,
  resetMockScripts,
  resolveMockScript,
  type MockScript,
  type MockScriptContext,
} from "./providers/index.js";
export { activeSessionRegistry } from "./active-session-registry.js";
export { WorktreePool, scanIdleWorktrees, cleanupOrphanedWorktrees, reapOrphanWorktrees } from "./worktree-pool.js";
export {
  pruneWorktreeAdminEntries,
  pruneWorktreeAdminEntriesSync,
  type PruneWorktreeAdminEntriesOptions,
} from "./worktree-prune.js";
export {
  BranchConflictError,
  BranchCrossContaminationError,
  assertCleanBranchAtBase,
  classifyBootstrapMisbinding,
  isBranchConflictError,
  inspectBranchConflict,
  type BranchConflictCommit,
  type BranchConflictDetails,
  type BranchConflictInspectionResult,
  type InspectBranchConflictInput,
} from "./branch-conflicts.js";
export { generateReservedWorktreeName, generateWorktreeName, planTaskWorktreePath, slugify } from "./worktree-names.js";
export { createLogger, type Logger } from "./logger.js";
export {
  validateExternalIntegrationManifest,
  KNOWN_EXTERNAL_INTEGRATIONS,
  type ExternalIntegrationReleaseAsset,
  type ExternalIntegrationReleaseManifest,
  type ExternalIntegrationManifestValidationError,
  type ExternalIntegrationManifestValidationResult,
} from "./external-integrations/index.js";
export { fetchWebContent, assertSafeUrl, WebFetchError, type WebFetchOptions, type WebFetchResult, type WebFetchErrorCode } from "./web-fetch.js";
export { classifyTaskError, type ErrorClass, type TaskErrorClassification } from "./error-classifier.js";
export {
  buildGoalContextSection,
  DEFAULT_GOAL_INJECTION_CHAR_BUDGET,
  MAX_INJECTED_GOALS,
  type GoalInjectionInput,
  type GoalInjectionResult,
  type GoalInjectionTruncationEvent,
} from "./goal-context-injector.js";
export {
  classifyGoalInjectionFailure,
  classifyGoalInjectionResult,
  emitGoalInjectionDiagnostic,
  resolveAndEmitGoalContext,
  type GoalInjectionClassification,
  type GoalInjectionDiagnostic,
  type GoalInjectionDiagnosticInput,
  type GoalInjectionDisabledReason,
  type GoalInjectionOutcome,
  type ResolveAndEmitGoalContextInput,
} from "./goal-injection-diagnostics.js";
export {
  emitGoalAnchoringAudit,
  emitGoalRetrievalAudit,
  GOAL_INJECTION_APPLIED,
  GOAL_INJECTION_SKIPPED,
  GOAL_RETRIEVAL_INVOKED,
  type GoalAnchoringLane,
  type GoalInjectionAuditInput,
  type GoalRetrievalAuditInput,
} from "./goal-anchoring-audit.js";
export {
  resolveWorktrunkBinary,
  installWorktrunk,
  probeWorktrunk,
  clearWorktrunkResolveCache,
  requestWorktrunkInstallApproval,
  executeApprovedWorktrunkInstall,
  validateWorktrunkManifest,
  WorktrunkBinaryUnavailableError,
  WorktrunkInstallDeniedError,
  WorktrunkInstallFailedError,
  WORKTRUNK_BINARY_NAME,
  WORKTRUNK_INSTALL_DIR,
  WORKTRUNK_INSTALL_PATH,
  WORKTRUNK_PINNED_RELEASE,
  WORKTRUNK_PROBE_TIMEOUT_MS,
  WORKTRUNK_DOWNLOAD_TIMEOUT_MS,
  WORKTRUNK_DOWNLOAD_MAX_BYTES,
  WORKTRUNK_CARGO_TIMEOUT_MS,
  type WorktrunkReleaseAsset,
  type WorktrunkReleaseManifest,
  type WorktrunkManifestValidationError,
  type WorktrunkManifestValidationResult,
} from "./worktrunk-installer.js";
export {
  handleWorktrunkOperationFailure,
  truncateWorktrunkStderr,
  type WorktreeOperationResult,
  type WorktrunkDisposition,
  type WorktrunkFailureNotification,
  type WorktrunkOpName,
  type WorktrunkOperationFailure,
} from "./worktrunk-failure-handler.js";
export { isUsageLimitError, UsageLimitPauser } from "./usage-limit-detector.js";
export { withRateLimitRetry } from "./rate-limit-retry.js";
export { ResearchOrchestrator, type ResearchOrchestratorOptions, type ResearchOrchestratorStatus, type ResearchOrchestratorStartOptions } from "./research-orchestrator.js";
export {
  ExperimentExecutor,
  ExperimentMaxIterationsError,
  ExperimentGitNotConfiguredError,
  ExperimentRevertConflictError,
  defaultGitOps,
  type ExperimentExecutorOptions,
  type ExperimentExecutorStatus,
  type InitExperimentInput,
  type RunExperimentInput,
  type RunExperimentResult,
  type LogExperimentInput,
} from "./experiment-executor.js";
export {
  ExperimentFinalizeService,
  __activeFinalizeLocksForTesting,
} from "./experiment/finalize-service.js";
export {
  ExperimentFinalizeStateError,
  ExperimentFinalizeNoKeptRunsError,
  ExperimentFinalizePlanError,
  ExperimentFinalizeMergeBaseError,
  ExperimentFinalizeCherryPickConflictError,
  ExperimentFinalizeBranchExistsError,
  type FinalizeGroup,
  type FinalizePlan,
  type FinalizeResult,
  type FinalizePlanOverride,
  type FinalizePlanOverrideGroup,
} from "./experiment/finalize-types.js";
export {
  ResearchStepRunner,
  ResearchStepTimeoutError,
  ResearchStepAbortError,
  ResearchStepProviderError,
  type ResearchProvider,
  type ResearchStepRunnerApi,
  type ResearchStepRunnerOptions,
  type ResearchStepResult,
} from "./research-step-runner.js";
export { ResearchProviderRegistry } from "./research/provider-registry.js";
export {
  ResearchProviderError,
  type ResearchProviderType,
  type ResearchProviderConfig,
  type ResearchProviderErrorCode,
  type ResearchFetchResult,
} from "./research/types.js";
export {
  WebSearchProvider,
  type WebSearchProviderOptions,
  PageFetchProvider,
  type PageFetchProviderOptions,
  GitHubProvider,
  LocalDocsProvider,
  type LocalDocsProviderOptions,
  LLMSynthesisProvider,
  type LLMSynthesisProviderOptions,
} from "./research/providers/index.js";
export { PrMonitor, type PrComment, type TrackedPr, type OnNewCommentsCallback } from "./pr-monitor.js";
export {
  SECRET_MUTATION_TYPES,
  SECRET_AUDIT_PLAINTEXT_FORBIDDEN_KEYS,
  assertNoSecretPlaintext,
  type FilesystemMutationType,
} from "./run-audit.js";
export { PrCommentHandler } from "./pr-comment-handler.js";
export { writeSecretsEnvFile, cleanupSecretsEnvFile, type WriteSecretsEnvFileOptions, type WriteSecretsEnvFileResult, type CleanupSecretsEnvFileOptions, type CleanupSecretsEnvFileResult } from "./secrets-env-writer.js";
export {
  NtfyNotifier,
  DEFAULT_NTFY_EVENTS,
  resolveNtfyEvents,
  isNtfyEventEnabled,
  buildNtfyClickUrl,
  sendNtfyNotification,
  formatTaskIdentifier,
  getActiveNotificationService,
  type NtfyNotifierOptions,
  type NtfyNotificationPriority,
  type NtfyNotificationConfigInput,
  type SendNtfyNotificationInput,
} from "./notifier.js";
// ── Notification Service ──────────────────────────────────────
export { NtfyNotificationProvider, NotificationService, WebhookNotificationProvider } from "./notification/index.js";
export type { NtfyProviderConfig, NotificationServiceOptions, WebhookProviderConfig } from "./notification/index.js";
export { CronRunner, type CronRunnerOptions, type AiPromptExecutor, createAiPromptExecutor } from "./cron-runner.js";
export { RoutineRunner, type RoutineRunnerOptions } from "./routine-runner.js";
export { RoutineScheduler, type RoutineSchedulerOptions } from "./routine-scheduler.js";
export { StuckTaskDetector, type StuckTaskDetectorOptions, type DisposableSession } from "./stuck-task-detector.js";
export { HeartbeatMonitor, HeartbeatTriggerScheduler, type WakeContext } from "./agent-heartbeat.js";
export { TokenCapDetector, type TokenCapCheckResult } from "./token-cap-detector.js";
export { SelfHealingManager, type SelfHealingOptions, type RebindResult } from "./self-healing.js";
export { PluginRunner, type PluginRunnerOptions } from "./plugin-runner.js";
export {
  registerPluginTraits,
  degradePluginTraits,
  unregisterPluginTraits,
  findLivePluginTraitDependents,
  pluginTraitToDefinition,
  pluginTraitRegistryId,
  evaluatePluginGate,
  PluginTraitHasDependentsError,
  type PluginTraitDependent,
} from "./plugin-trait-adapter.js";
// Step-inversion U12 (KTD-12): plugin step-parser adapter.
export {
  registerPluginStepParsers,
  unregisterPluginStepParsers,
  pluginParserRegistryId,
  pluginParserToRegistryParser,
  PluginParserError,
  PLUGIN_PARSER_TIMEOUT_MS,
  type PluginStepParserContribution,
} from "./plugin-parser-adapter.js";
// Step-inversion U14 (KTD-15): code-node runner + save-time validation helper.
export {
  runCodeNode,
  createCodeNodeRunner,
  compileCodeNodeSource,
  validateCodeNodeSources,
  buildCodeNodeTaskSubset,
  resolveCodeNodeTimeout,
  CodeNodeError,
  CODE_NODE_DEFAULT_TIMEOUT_MS,
  CODE_NODE_MAX_TIMEOUT_MS,
  CODE_NODE_MAX_SOURCE_BYTES,
  CODE_NODE_OUTPUT_CAP_BYTES,
  type CodeNodeContext,
  type CodeNodeResult,
  type CodeNodeRunnerDeps,
  type CodeNodeTaskSubset,
  type CodeNodeFailureReason,
  type RunCodeNodeOptions,
} from "./code-node-runner.js";
// Agent runtime abstraction
export { type AgentRuntime, type AgentRuntimeOptions, type AgentSessionResult } from "./agent-runtime.js";
export {
  resolveRuntime,
  getDefaultPiRuntime,
  buildRuntimeResolutionContext,
  type RuntimeResolutionContext,
  type ResolvedRuntime,
  type SessionPurpose,
} from "./runtime-resolution.js";
// Agent session helpers
export {
  createResolvedAgentSession,
  promptWithAutoRetry,
  describeAgentModel,
  extractRuntimeHint,
  extractRuntimeModel,
  type ResolvedSessionOptions,
  type ResolvedSessionResult,
} from "./agent-session-helpers.js";
export { ProjectManager } from "./project-manager.js";
export { ProjectEngine, type ProjectEngineOptions } from "./project-engine.js";
export { ProjectEngineManager, type EngineManagerOptions } from "./project-engine-manager.js";
export {
  acquireEngineSingleton,
  computeEngineLockFilePath,
  computeEngineSocketPath,
  EngineAlreadyRunningError,
  type EngineSingletonLock,
} from "./engine-singleton-lock.js";
export { NodeHealthMonitor } from "./node-health-monitor.js";
export {
  HybridExecutor,
  type HybridExecutorOptions,
  type HybridExecutorEvents,
} from "./hybrid-executor.js";
export { shouldUseHybridExecutor, type HybridExecutorGateDecision } from "./hybrid-executor-gate.js";
export { applyUnavailableNodePolicy, type PolicyDecision } from "./node-routing-policy.js";
export { PeerExchangeService, type PeerExchangeServiceOptions, type SyncResult } from "./peer-exchange-service.js";
export {
  TunnelProcessManager,
  getTunnelProviderAdapter,
  redactTunnelText,
  type TunnelProcessManagerOptions,
  type CloudflareProviderConfig,
  type ManagedTunnelProcess,
  type PreparedTunnelCommand,
  type TailscaleProviderConfig,
  type TunnelError,
  type TunnelErrorCode,
  type TunnelLifecycleState,
  type TunnelLogEntry,
  type TunnelLogLevel,
  type TunnelLogListener,
  type TunnelManager,
  type TunnelOutputStream,
  type TunnelProvider,
  type TunnelProviderAdapter,
  type TunnelProviderConfig,
  type TunnelReadinessEvent,
  type TunnelRestoreDiagnostics,
  type TunnelRestoreOutcome,
  type TunnelRestoreReasonCode,
  type TunnelStatusListener,
  type TunnelStatusSnapshot,
} from "./remote-access/index.js";
export { RemoteNodeClient } from "./runtimes/remote-node-client.js";
export { RemoteNodeRuntime, type RemoteNodeRuntimeConfig } from "./runtimes/remote-node-runtime.js";
// Hold/release sweep + manual promote (U6/U9). Exported so the dashboard
// promote endpoint can release a manually-held card via the same authority.
export {
  promoteHeldTask,
  releaseHeldTaskByEvent,
  runHoldReleaseSweep,
  type HoldReleaseDeps,
  type HoldReleaseResult,
  type SlotReservation,
} from "./hold-release.js";
export { StepSessionExecutor } from "./step-session-executor.js";
export type { StepResult, ParallelWave, StepSessionExecutorOptions } from "./step-session-executor.js";
export {
  runTaskStep,
  resetStepToBaseline,
  makeAncestryBlastRadiusGuard,
} from "./step-runner.js";
export type {
  RunTaskStepDeps,
  RunTaskStepOptions,
  RunTaskStepResult,
  ResetStepDeps,
  ResetStepResult,
  RunSingleStep,
  SessionRef,
  StepRunnerTask,
} from "./step-runner.js";
// Multi-project runtime types
export {
  type ProjectRuntime,
  type ProjectRuntimeConfig,
  type ProjectRuntimeEvents,
  type RuntimeStatus,
  type RuntimeMetrics,
} from "./project-runtime.js";
// Shared node-pty native-asset loader
export {
  loadPtyModule,
  ensureNodePtyNativePermissions,
  findStagedNativeDir,
  findInstalledNodePtyNativeDir,
  getNativePrebuildName,
  resetPtyModuleCacheForTests,
} from "./pty-native.js";
// CLI agent executor — session manager (U2), telemetry hub (U3), state machine (U3),
// hook scripts (U17); consumed by the dashboard hook route (U17) and transport (U10).
export {
  CliSessionManager,
  CliConcurrencyLimitError,
  CliResumeUnsupportedError,
  UnknownCliSessionError,
  neutralizeInjection,
  DEFAULT_SCROLLBACK_BYTES,
  DEFAULT_CONCURRENCY_CEILING,
  type CliSessionAttachment,
  type CliSessionManagerOptions,
  type SpawnCliSessionOptions,
} from "./cli-agent/session-manager.js";
// CLI Agent Executor — per-project runtime bootstrap (integration).
export {
  createCliAgentRuntime,
  type CreateCliAgentRuntimeOptions,
  type BootstrappedCliAgentRuntime,
} from "./cli-agent/runtime.js";
// CLI Agent Executor — resume coordinator + self-healing/stuck integration (U8).
export {
  CliResumeCoordinator,
  DEFAULT_MAX_RESUME_ATTEMPTS,
  DEFAULT_RESUME_BACKOFF_BASE_MS,
  type CliResumeCoordinatorOptions,
  type ResumeResult,
  type ResumeDisposition,
} from "./cli-agent/resume-coordinator.js";
export {
  TelemetryHub,
  stripAnsiControl,
  DEFAULT_MAX_EVENT_CHARS,
  DEFAULT_MAX_EVENTS_PER_TURN,
  DEFAULT_CHUNK_CARRY_CHARS,
  type TelemetryHubOptions,
  type TelemetryEvent,
  type TelemetryEventKind,
  type SanitizedTelemetryEvent,
  type NotificationDispatch,
  type TelemetryEventListener,
} from "./cli-agent/telemetry-hub.js";
export {
  CliSessionStateMachine,
  classifyTermination,
  isResumeEligible,
  toPersistedState,
  type CliMachineState,
  type CliStateChange,
  type CliStateChangeListener,
  type CliStateMachineOptions,
} from "./cli-agent/state-machine.js";
// CLI Agent Executor — per-session hook scripts / notify shim (U17).
export {
  writeSessionHookScripts,
  cleanupSessionHookDir,
  buildHookScriptContent,
  buildNotifyShimContent,
  HOOK_SCRIPT_NAMES,
  type WriteSessionHookScriptsOptions,
  type WrittenHookScripts,
} from "./cli-agent/hook-scripts.js";
// CLI Agent Executor — adapter registry (U2).
export {
  CliAdapterRegistry,
  defaultCliAdapterRegistry,
  UnknownCliAdapterError,
  DuplicateCliAdapterError,
  type CliAgentAdapter,
  type CliAdapterCapabilities,
  type CliAdapterElevationMarkers,
} from "./cli-agent/adapter.js";
// CLI Agent Executor — autonomy posture resolution + approval gate (U15).
export {
  resolveEffectivePosture,
  assertAutonomyApproved,
  CliAutonomyNotApprovedError,
  GENERIC_ELEVATION_ENV_PATTERNS,
  tierForCapabilities,
  type EffectivePosture,
  type CliElevationFlag,
  type CliAgentResolveSettings,
  type CliAgentNodeConfig,
  type AutonomyApprovalLookup,
  type ResolveEffectivePostureArgs,
  type AssertAutonomyApprovedArgs,
  type CliAdapterTier,
} from "./cli-agent/autonomy.js";
// CLI Agent Executor — bundled adapters + UI descriptors (U15).
export {
  BUNDLED_CLI_ADAPTERS,
  listCliAdapterDescriptors,
  claudeCodeAdapter,
  codexAdapter,
  droidAdapter,
  piAdapter,
  genericCliAdapter,
  type CliAdapterDescriptor,
} from "./cli-agent/adapters/index.js";
// CLI Agent Executor — task ↔ session orchestration (U7).
export {
  CliTaskSession,
  launchCliTaskSession,
  killLiveTaskSessions,
  type CliTaskOutcome,
  type CliTaskOutcomeKind,
  type ResolvedCliExecutorConfig,
  type LaunchCliTaskSessionOptions,
} from "./cli-agent/task-session.js";
