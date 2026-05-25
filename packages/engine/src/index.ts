export { AgentLogger, type AgentLoggerOptions, summarizeToolArgs } from "./agent-logger.js";
export { reloadExemptTools, addToExemptTools, getExemptToolNames } from "./agent-action-gate.js";
export {
  createTaskCreateTool,
  createTaskDocumentReadTool,
  createTaskDocumentWriteTool,
  createTaskLogTool,
  createSendMessageTool,
  createReadMessagesTool,
  taskCreateParams,
  taskDocumentReadParams,
  taskDocumentWriteParams,
  taskLogParams,
  executeApprovedAgentProvisioning,
} from "./agent-tools.js";
export { AgentSemaphore, PRIORITY_MERGE, PRIORITY_EXECUTE, PRIORITY_SPECIFY } from "./concurrency.js";
export { TriageProcessor, type TriageProcessorOptions } from "./triage.js";
export { TaskExecutor, type TaskExecutorOptions } from "./executor.js";
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
  resolveIntegrationBranch,
  resolveIntegrationBranchSync,
  __resetIntegrationBranchCacheForTests,
} from "./integration-branch.js";
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

// Register createFnAgent into core's loader so consumers in @fusion/core
// (e.g. ai-summarize, memory-compaction) can resolve it without a circular
// static import. Runs once at engine module load.
import type { AiSessionResult, CreateAiSessionFactory, CreateAiSessionOptions } from "@fusion/core";
import { createFnAgent as _createFnAgentForCore } from "./pi.js";

const _createAiSessionAdapter: CreateAiSessionFactory = async (options: CreateAiSessionOptions): Promise<AiSessionResult> => {
  return _createFnAgentForCore({
    cwd: options.cwd,
    systemPrompt: options.systemPrompt,
    tools: options.tools,
    defaultProvider: options.defaultProvider,
    defaultModelId: options.defaultModelId,
  });
};

void import("@fusion/core")
  .then((core) => {
    if ("setCreateFnAgent" in core && typeof core.setCreateFnAgent === "function") {
      core.setCreateFnAgent(_createFnAgentForCore);
    }
    if ("setCreateAiSessionFactory" in core && typeof core.setCreateAiSessionFactory === "function") {
      core.setCreateAiSessionFactory(_createAiSessionAdapter);
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
export { StepSessionExecutor } from "./step-session-executor.js";
export type { StepResult, ParallelWave, StepSessionExecutorOptions } from "./step-session-executor.js";
// Multi-project runtime types
export {
  type ProjectRuntime,
  type ProjectRuntimeConfig,
  type ProjectRuntimeEvents,
  type RuntimeStatus,
  type RuntimeMetrics,
} from "./project-runtime.js";
