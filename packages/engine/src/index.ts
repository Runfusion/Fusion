export { AgentLogger, type AgentLoggerOptions, summarizeToolArgs } from "./agent-logger.js";
export {
  createTaskCreateTool,
  createTaskDocumentReadTool,
  createTaskDocumentWriteTool,
  createTaskLogTool,
  taskCreateParams,
  taskDocumentReadParams,
  taskDocumentWriteParams,
  taskLogParams,
} from "./agent-tools.js";
export { AgentSemaphore, PRIORITY_MERGE, PRIORITY_EXECUTE, PRIORITY_SPECIFY } from "./concurrency.js";
export { TriageProcessor, type TriageProcessorOptions } from "./triage.js";
export { TaskExecutor, type TaskExecutorOptions } from "./executor.js";
export { Scheduler, type SchedulerOptions } from "./scheduler.js";
export { MissionAutopilot, type MissionAutopilotOptions } from "./mission-autopilot.js";
export { MissionExecutionLoop, type MissionExecutionLoopOptions, type ValidationResult, loopLog } from "./mission-execution-loop.js";
export { aiMergeTask, type MergerOptions } from "./merger.js";
export { reviewStep, type ReviewType, type ReviewVerdict, type ReviewResult, type ReviewOptions } from "./reviewer.js";
export { createFnAgent, promptWithFallback, describeModel, setHostExtensionPaths, getHostExtensionPaths, type AgentOptions, type AgentResult } from "./pi.js";

// Register createFnAgent into core's loader so consumers in @fusion/core
// (e.g. ai-summarize, memory-compaction) can resolve it without a circular
// static import. Runs once at engine module load.
import { createFnAgent as _createFnAgentForCore } from "./pi.js";
void import("@fusion/core")
  .then((core) => {
    if ("setCreateFnAgent" in core && typeof core.setCreateFnAgent === "function") {
      core.setCreateFnAgent(_createFnAgentForCore);
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
export {
  buildAgentChatPrompt,
  resolveAgentInstructionsWithRatings,
  resolveAgentInstructions,
  buildSystemPromptWithInstructions,
} from "./agent-instructions.js";
export { WorktreePool, scanIdleWorktrees, cleanupOrphanedWorktrees, reapOrphanWorktrees } from "./worktree-pool.js";
export { createLogger, type Logger } from "./logger.js";
export { isUsageLimitError, UsageLimitPauser } from "./usage-limit-detector.js";
export { withRateLimitRetry } from "./rate-limit-retry.js";
export { PrMonitor, type PrComment, type TrackedPr, type OnNewCommentsCallback } from "./pr-monitor.js";
export { PrCommentHandler } from "./pr-comment-handler.js";
export {
  NtfyNotifier,
  DEFAULT_NTFY_EVENTS,
  resolveNtfyEvents,
  isNtfyEventEnabled,
  buildNtfyClickUrl,
  sendNtfyNotification,
  type NtfyNotifierOptions,
  type NtfyNotificationPriority,
  type NtfyNotificationConfigInput,
  type SendNtfyNotificationInput,
} from "./notifier.js";
export { CronRunner, type CronRunnerOptions, type AiPromptExecutor, createAiPromptExecutor } from "./cron-runner.js";
export { RoutineRunner, type RoutineRunnerOptions } from "./routine-runner.js";
export { RoutineScheduler, type RoutineSchedulerOptions } from "./routine-scheduler.js";
export { StuckTaskDetector, type StuckTaskDetectorOptions, type DisposableSession } from "./stuck-task-detector.js";
export { HeartbeatMonitor, HeartbeatTriggerScheduler, type WakeContext } from "./agent-heartbeat.js";
export { TokenCapDetector, type TokenCapCheckResult } from "./token-cap-detector.js";
export { SelfHealingManager, type SelfHealingOptions } from "./self-healing.js";
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
  type ResolvedSessionOptions,
  type ResolvedSessionResult,
} from "./agent-session-helpers.js";
export { ProjectManager } from "./project-manager.js";
export { ProjectEngine, type ProjectEngineOptions } from "./project-engine.js";
export { ProjectEngineManager, type EngineManagerOptions } from "./project-engine-manager.js";
export { NodeHealthMonitor } from "./node-health-monitor.js";
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
