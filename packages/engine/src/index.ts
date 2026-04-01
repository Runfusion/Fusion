export { AgentLogger, type AgentLoggerOptions, summarizeToolArgs } from "./agent-logger.js";
export { AgentSemaphore, PRIORITY_MERGE, PRIORITY_EXECUTE, PRIORITY_SPECIFY } from "./concurrency.js";
export { TriageProcessor, type TriageProcessorOptions } from "./triage.js";
export { TaskExecutor, type TaskExecutorOptions } from "./executor.js";
export { Scheduler, type SchedulerOptions } from "./scheduler.js";
export { aiMergeTask, type MergerOptions } from "./merger.js";
export { reviewStep, type ReviewType, type ReviewVerdict, type ReviewResult, type ReviewOptions } from "./reviewer.js";
export { createKbAgent, type AgentOptions, type AgentResult } from "./pi.js";
export { WorktreePool, scanIdleWorktrees, cleanupOrphanedWorktrees } from "./worktree-pool.js";
export { createLogger, type Logger } from "./logger.js";
export { isUsageLimitError, UsageLimitPauser } from "./usage-limit-detector.js";
export { PrMonitor, type PrComment, type TrackedPr, type OnNewCommentsCallback } from "./pr-monitor.js";
export { PrCommentHandler } from "./pr-comment-handler.js";
export { NtfyNotifier, type NtfyNotifierOptions } from "./notifier.js";
export { CronRunner, type CronRunnerOptions } from "./cron-runner.js";
export { StuckTaskDetector, type StuckTaskDetectorOptions, type DisposableSession } from "./stuck-task-detector.js";

// ── Project Runtime (Multi-Project Support) ────────────────────────────────

export {
  type ProjectRuntime,
  type ProjectRuntimeConfig,
  type RuntimeStatus,
  type RuntimeMetrics,
  type ProjectRuntimeEvents,
  type GlobalMetrics,
} from "./project-runtime.js";

export { InProcessRuntime } from "./runtimes/in-process-runtime.js";
export { ChildProcessRuntime } from "./runtimes/child-process-runtime.js";
export { ProjectManager, type ProjectManagerEvents } from "./project-manager.js";

// ── IPC Protocol ───────────────────────────────────────────────────────

export {
  type IpcMessage,
  type IpcCommandType,
  type IpcResponseType,
  type IpcEventType,
  START_RUNTIME,
  STOP_RUNTIME,
  GET_STATUS,
  GET_METRICS,
  GET_TASK_STORE,
  GET_SCHEDULER,
  PING,
  OK,
  ERROR,
  PONG,
  TASK_CREATED,
  TASK_MOVED,
  TASK_UPDATED,
  ERROR_EVENT,
  HEALTH_CHANGED,
  type StartRuntimePayload,
  type StopRuntimePayload,
  type OkPayload,
  type ErrorPayload,
  type PongPayload,
  type TaskCreatedPayload,
  type TaskMovedPayload,
  type TaskUpdatedPayload,
  type ErrorEventPayload,
  type HealthChangedPayload,
  isIpcCommand,
  isIpcResponse,
  isIpcEvent,
  createCommand,
  createResponse,
  createEvent,
  generateCorrelationId,
} from "./ipc/ipc-protocol.js";

export { IpcHost } from "./ipc/ipc-host.js";
export { IpcWorker } from "./ipc/ipc-worker.js";
