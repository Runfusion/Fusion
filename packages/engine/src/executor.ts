// port-4040-allowlist: this file embeds the "never kill port 4040" rule in the executor prompt.
import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
import { setImmediate as setImmediateCb } from "node:timers";

// Internal git plumbing intentionally bypasses sandbox backends.
const execAsync = promisify(exec);
import { delimiter, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import type { TaskStore, Task, TaskDetail, TaskTokenUsage, StepStatus, Settings, WorkflowStep, MissionStore, Slice, AgentState, AgentCapability, RunMutationContext, AgentHeartbeatConfig, Agent, AgentMemoryInclusionMode, ProjectSettings, MergeResult, WorkflowIrNode } from "@fusion/core";
import { RetryStormError, TaskDeletedError, serializeRetryStormError, isExperimentalFeatureEnabled, isWorkflowColumnsEnabled, resolveWorkflowIrForTask, resolveColumnAgentBinding, resolveEffectiveAgent, instanceNodeId } from "@fusion/core";
import { mergeEffectiveSettings } from "./effective-settings.js";
import type { TaskStep, WorkflowIr, WorkflowFieldDefinition, WorkflowColumnAgent, EffectiveAgentInput } from "@fusion/core";
import {
  buildWorkflowObservationFromTask,
  buildWorkflowObservation,
  type WorkflowStage,
  type WorkflowRunObservation,
} from "@fusion/core";
import { WorkflowGraphTaskRunner, type WorkflowGraphTaskRunResult } from "./workflow-graph-task-runner.js";
import { createCodeNodeRunner } from "./code-node-runner.js";
import type { ParseStepsHandlerDeps, CodeNodeRunner } from "./workflow-node-handlers.js";
import type { WorkflowBranchPersistence, WorkflowBranchRunState } from "./workflow-graph-branches.js";
import type {
  WorkflowStepInstancePersistence,
  WorkflowStepInstanceState,
} from "./workflow-graph-foreach.js";
import { observeWorkflowParity, WORKFLOW_INTERPRETER_DUAL_OBSERVE_FLAG } from "./workflow-parity-observer.js";
import {
  FOREACH_ACTIVE_CONTEXT_KEY,
  SEAM_GOVERNING_NODE_CONTEXT_KEY,
  type ForeachActiveContext,
  type WorkflowLegacySeams,
} from "./workflow-node-handlers.js";
import type { WorkflowNodeResult } from "./workflow-graph-executor.js";
import {
  ApprovalRequestStore,
  buildExecutionMemoryInstructions,
  getTaskMergeBlocker,
  isEphemeralAgent,
  isMergeRequestContractShadowEnabled,
  resolveAgentPrompt,
  resolvePersistAgentThinkingLog,
  resolveEffectiveAgentPermissionPolicy,
  resolveProjectDefaultModel,
  resolveAgentMemoryInclusionMode,
  type RunCommandResult,
} from "@fusion/core";
import { findWorktreeUser, getConflictedFiles } from "./merger.js";
import {
  runVerificationCommand,
  summarizeVerificationOutput,
  VERIFICATION_LOG_MAX_CHARS,
  type VerificationResult,
} from "./verification-utils.js";
import { canonicalStepInstanceBranchName, generateWorktreeName, resolveTaskWorkingBranch } from "./worktree-names.js";
import { resolveTaskWorktreePath, resolveWorktreesDir } from "./worktree-paths.js";
import { Type, type Static } from "@earendil-works/pi-ai";
import { describeModel, promptWithFallback, compactSessionContext } from "./pi.js";
import { accumulateSessionTokenUsage } from "./session-token-usage.js";
import {
  createResolvedAgentSession,
  extractRuntimeHint,
  resolveExecutorSessionModel,
} from "./agent-session-helpers.js";
import { buildSessionSkillContext } from "./session-skill-context.js";
import { reviewStep, type ReviewVerdict } from "./reviewer.js";
import { resolveSandboxBackend } from "./sandbox/index.js";
import type { SandboxBackend } from "./sandbox/types.js";
import { ModelRegistry, SessionManager, type ToolDefinition, type AgentSession } from "@earendil-works/pi-coding-agent";
import { PRIORITY_EXECUTE, type AgentSemaphore } from "./concurrency.js";
import { RemovalReason, classifyTaskWorktree, describeRegisteredWorktrees, detectNestedWorktreeRoot, getRegisteredWorktreePaths, isGitRepository, isInsideWorktreesDir, isRegisteredGitWorktree, removeWorktree, type WorktreePool } from "./worktree-pool.js";
import { attemptBranchAutocorrect } from "./branch-autocorrect.js";
import { ActiveSessionWorktreeRemovalError } from "./worktree-backend.js";
import {
  activeSessionRegistry,
  executingTaskLock,
  reconcileSelfOwnedActiveSessionForRemoval,
} from "./active-session-registry.js";
// CLI Agent Executor (U7): task ↔ CLI session orchestration seam.
import {
  CliTaskSession,
  launchCliTaskSession,
  killLiveTaskSessions,
  type CliTaskOutcome,
  type ResolvedCliExecutorConfig,
} from "./cli-agent/task-session.js";
import type { CliSessionManager } from "./cli-agent/session-manager.js";
import { CliConcurrencyLimitError } from "./cli-agent/session-manager.js";
import type { TelemetryHub } from "./cli-agent/telemetry-hub.js";
import type { CliAdapterRegistry } from "./cli-agent/adapter.js";
import type { CliSessionStore } from "@fusion/core";
import {
  StaleWorktreeIndexLockError,
  classifyStaleLock,
  parseIndexLockPath,
  tryRemoveStaleLock,
} from "./worktree-stale-lock.js";
import { parseStaleRegistrationPath, recoverStaleRegistration } from "./worktree-stale-registration.js";
import {
  BranchConflictError,
  BranchCrossContaminationError,
  assertCleanBranchAtBase,
  autoRecoverCrossContamination,
  classifyBootstrapMisbinding,
  classifyForeignCommits,
  classifyForeignOnlyContamination,
  classifyMisroutedForeignCommit,
  isBranchConflictError,
  reanchorBranchToBase,
  inspectBranchConflict,
  reportBranchAttribution,
} from "./branch-conflicts.js";
import {
  classifyOrphanOurAdvance,
  rehomeOrphanOntoIntegration,
} from "./merger-orphan-rehome.js";
import { BranchAttributionError, filterFilesToOwnTaskCommits } from "./branch-attribution.js";
import { resolveIntegrationBranch } from "./integration-branch.js";
import { AgentLogger } from "./agent-logger.js";
import { createLogger, executorLog, reviewerLog, formatError } from "./logger.js";
import { TokenCapDetector } from "./token-cap-detector.js";
import { isUsageLimitError, checkSessionError, type UsageLimitPauser } from "./usage-limit-detector.js";
import { isNonContinuableSessionError, isTransientError, isSilentTransientError } from "./transient-error-detector.js";
import { withRateLimitRetry } from "./rate-limit-retry.js";
import { computeRecoveryDecision, formatDelay, MAX_RECOVERY_RETRIES } from "./recovery-policy.js";
import type { StuckTaskDetector, StuckTaskEvent } from "./stuck-task-detector.js";
import type { PluginRunner } from "./plugin-runner.js";
import { isContextLimitError } from "./context-limit-detector.js";
import { StepSessionExecutor } from "./step-session-executor.js";
import { makeAncestryBlastRadiusGuard, resetStepToBaseline, runTaskStep } from "./step-runner.js";
import { acquireTaskWorktree } from "./worktree-acquisition.js";
import { resolveCapturedBaseCommitSha } from "./base-commit-capture.js";
import { installTaskWorktreeIdentityGuard } from "./worktree-hooks.js";
import {
  resolveAgentInstructions,
  buildSystemPromptWithInstructions,
  buildPluginPromptSection,
} from "./agent-instructions.js";
import { buildPromptLayers, collapsePromptLayers } from "./prompt-layers.js";
import { resolveAndEmitGoalContext } from "./goal-injection-diagnostics.js";
import type { AgentReflectionService } from "./agent-reflection.js";
import { createRunAuditor, generateSyntheticRunId, type EngineRunContext, type RunAuditor } from "./run-audit.js";
import { AutoRecoveryDispatcher } from "./auto-recovery.js";
import {
  classifyMissingWorktreeSessionStartFailure,
  extractMissingWorktreePathFromSessionStartFailure,
  isMissingWorktreeSessionStartFailure,
} from "./restart-recovery-coordinator.js";
import { BranchWorktreeAutoRecoveryHandler } from "./auto-recovery-handlers/branch-worktree.js";
import { autoRecoverWorktreeSessionStartFailure, MAX_WORKTREE_SESSION_RETRIES } from "./self-healing.js";
import { ContaminationAutoRecoveryHandler } from "./auto-recovery-handlers/contamination.js";
import { createFileScopeAutoRecoveryHandler } from "./auto-recovery-handlers/file-scope.js";
import { ReadonlyViolationError, filterCustomToolsForReadonly } from "./workflow-step-tool-policy.js";
import { evaluateSpecStaleness, getPromptPath } from "./spec-staleness.js";
import {
  createAgentCreateTool,
  createAgentDeleteTool,
  createDelegateTaskTool,
  createGetAgentConfigTool,
  createListAgentsTool,
  createMemoryTools,
  createWebFetchTool,
  createReadMessagesTool,
  createReflectOnPerformanceTool,
  createUpdateAgentConfigTool,
  createResearchTools,
  createSendMessageTool,
  createTaskCreateTool as sharedCreateTaskCreateTool,
  createTaskDocumentReadTool as sharedCreateTaskDocumentReadTool,
  createTaskDocumentWriteTool as sharedCreateTaskDocumentWriteTool,
  createTaskLogTool as sharedCreateTaskLogTool,
  createWorkflowListTool as sharedCreateWorkflowListTool,
  createWorkflowGetTool as sharedCreateWorkflowGetTool,
  createWorkflowSelectTool as sharedCreateWorkflowSelectTool,
  createTaskPromoteTool as sharedCreateTaskPromoteTool,
  createWorkflowCreateTool as sharedCreateWorkflowCreateTool,
  createWorkflowUpdateTool as sharedCreateWorkflowUpdateTool,
  createWorkflowDeleteTool as sharedCreateWorkflowDeleteTool,
  createWorkflowSettingsTool as sharedCreateWorkflowSettingsTool,
  createTraitListTool as sharedCreateTraitListTool,
} from "./agent-tools.js";
import { getTaskCompletionBlockerForStore } from "./task-completion.js";
import { createStreamingDeltaNormalizer } from "./streaming-delta.js";
import {
  getEnabledPluginTools,
  getResearchGuidanceForSurface,
  isResearchToolSurfaceEnabled,
} from "./tool-availability.js";
import { createFusionAuthStorage, getModelRegistryModelsPath } from "./auth-storage.js";
import { createRunVerificationTool } from "./run-verification-tool.js";
import { createFallbackModelObserver } from "./fallback-model-observer.js";
import { recordRetry } from "./retry-burned-logger.js";
import type { AgentActionGateContext } from "./agent-action-gate.js";

// Re-export for backward compatibility (tests import from executor.ts)
export { summarizeToolArgs } from "./agent-logger.js";
export {
  createAgentCreateTool,
  createAgentDeleteTool,
  createDelegateTaskTool,
  createGetAgentConfigTool,
  createListAgentsTool,
  createReadMessagesTool,
  createUpdateAgentConfigTool,
  createSendMessageTool,
  createTaskCreateTool,
  createTaskDocumentReadTool,
  createTaskDocumentWriteTool,
  createTaskLogTool,
  delegateTaskParams,
  listAgentsParams,
  memoryAppendParams,
  memoryGetParams,
  memorySearchParams,
  readMessagesParams,
  sendMessageParams,
  taskCreateParams,
  taskLogParams,
} from "./agent-tools.js";

const yieldEventLoop = (): Promise<void> => new Promise((resolve) => setImmediateCb(resolve));

/**
 * How long to wait after engine startup before spawning AI agent sessions for
 * orphaned in-progress tasks. The work itself (worktree setup, pi-coding-agent
 * session creation, child process spawn) is heavy and saturates the event
 * loop, which makes the dashboard unresponsive during cold start when there
 * are orphaned tasks from a prior run. Pushing this work past the initial
 * load window keeps the UI snappy; the tasks still resume — just after the
 * user has had time to see the board.
 *
 * Override via FUSION_RESUME_ORPHAN_DELAY_MS. Defaults to 0 under Vitest so
 * existing tests that expect immediate resumption keep passing without
 * needing per-test plumbing.
 *
 * Read lazily so an env-var change between module load and resumeOrphaned()
 * call (e.g. set in a test setup file) is observed.
 */
function getResumeOrphanDelayMs(): number {
  const raw = process.env.FUSION_RESUME_ORPHAN_DELAY_MS;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  if (process.env.VITEST || process.env.NODE_ENV === "test") return 0;
  return 30_000;
}

const tokenCacheMetricsLog = createLogger("token-cache-metrics");

const STEP_STATUSES: StepStatus[] = ["pending", "in-progress", "done", "skipped"];

function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolvePath(path);
  }
}

/** Maximum retry attempts for workflow step hard failures before giving up */
const MAX_WORKFLOW_STEP_RETRIES = 3;
/** Maximum in-session retries when an agent exits without calling fn_task_done(). */
const MAX_TASK_DONE_SESSION_RETRIES = 3;
/** Maximum todo requeues after exhausting in-session fn_task_done retries. */
const MAX_TASK_DONE_REQUEUE_RETRIES = 3;
/** How long to wait before recovering a completed task still stuck in in-progress. */
const COMPLETED_TASK_WATCHDOG_MS = 60_000;
/** How long to wait before retrying a workflow rerun handoff that never reached in-progress. */
const WORKFLOW_RERUN_WATCHDOG_MS = 15_000;

const TASK_DONE_REFUSAL_SUFFIX = "Either finish the work and resubmit, or do not call fn_task_done — exit the session and the engine will requeue.";

const TRANSIENT_WORKTREE_TASK_JSON_ENOENT_PATTERN = /ENOENT:\s+no such file or directory,\s+open\s+'([^']+\/\.fusion\/tasks\/([^/]+)\/task\.json)'/;

export function isTransientMissingTaskJsonError(error: unknown, task: Pick<Task, "id" | "worktree">): boolean {
  if (error instanceof TaskDeletedError) {
    return false;
  }
  const message = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "";
  const match = TRANSIENT_WORKTREE_TASK_JSON_ENOENT_PATTERN.exec(message);
  if (!match) {
    return false;
  }
  const [, filePath, taskIdFromPath] = match;
  if (taskIdFromPath !== task.id) {
    return false;
  }
  if (typeof task.worktree !== "string" || task.worktree.length === 0) {
    return false;
  }
  const normalizedWorktree = resolvePath(task.worktree);
  const normalizedTaskJsonPath = resolvePath(filePath);
  return normalizedTaskJsonPath.startsWith(`${normalizedWorktree}/`);
}

export const DISSENT_PATTERNS: RegExp[] = [
  /\btask (is|was)(?: not|n['’]?t) complete\b/i,
  /\b(?:i (?:could|can)(?:not|n['’]?t)|unable to|failed to) (?:complete|finish|implement)\b/i,
  /\b(?:partially|not fully) (?:complete|implemented|done|finished)\b/i,
  /\b(?:i['’]?m blocked|blocked from|blocking issue prevents)\b/i,
  /\bto unblock\b/i,
  /\b(?:needs|requires) (?:FN-\d+|further work|additional work|follow[- ]?up)\b/i,
];

type TaskDoneRefusalClass =
  | "summary-claims-incomplete"
  | "bulk-step-completion-without-review"
  | "pending-code-review-revise";

type TaskDoneRefusalResult =
  | { ok: true }
  | {
    ok: false;
    refusalClass: TaskDoneRefusalClass;
    message: string;
    reason: string;
  };

type PendingReviewBlockResult =
  | {
    blocked: true;
    reason:
      | "review-request-without-verdict"
      | "code-review-rethink-or-unavailable-outstanding"
      | "code-review-unavailable-blocking";
    stepIndex: number;
  }
  | { blocked: false };

function detectPendingReviewBlock(
  task: Task,
  _codeReviewVerdicts: Map<number, ReviewVerdict>,
): PendingReviewBlockResult {
  const inProgressStepIndices: number[] = [];
  for (let stepIndex = 0; stepIndex < task.steps.length; stepIndex++) {
    if (task.steps[stepIndex]?.status === "in-progress") {
      inProgressStepIndices.push(stepIndex);
    }
  }

  if (inProgressStepIndices.length === 0) {
    return { blocked: false };
  }

  const recentActions = (task.log ?? [])
    .slice(-30)
    .map((entry) => entry.action?.trim())
    .filter((action): action is string => Boolean(action));

  for (const stepIndex of inProgressStepIndices) {
    const stepDisplay = stepIndex + 1;
    const codeRequest = `code review requested for Step ${stepDisplay}`;
    const planRequest = `plan review requested for Step ${stepDisplay}`;
    const codeVerdictPrefix = `code review Step ${stepDisplay}:`;
    const planVerdictPrefix = `plan review Step ${stepDisplay}:`;

    for (let i = recentActions.length - 1; i >= 0; i--) {
      const action = recentActions[i];
      if (!action) {
        continue;
      }

      if (action.startsWith(codeRequest) || action.startsWith(planRequest)) {
        return { blocked: true, reason: "review-request-without-verdict", stepIndex };
      }

      if (action.startsWith(`${codeVerdictPrefix} RETHINK`)) {
        return { blocked: true, reason: "code-review-rethink-or-unavailable-outstanding", stepIndex };
      }

      if (action.startsWith(`${codeVerdictPrefix} UNAVAILABLE`)
        && action.includes("blocking until reviewer returns a usable verdict")) {
        return { blocked: true, reason: "code-review-unavailable-blocking", stepIndex };
      }

      if (action.startsWith(codeVerdictPrefix) || action.startsWith(planVerdictPrefix)) {
        break;
      }
    }
  }

  return { blocked: false };
}

function formatTaskDoneRefusal(refusalClass: TaskDoneRefusalClass, reason: string): string {
  return `fn_task_done refused (${refusalClass}): ${reason}. ${TASK_DONE_REFUSAL_SUFFIX}`;
}

export function evaluateTaskDoneRefusal(
  task: Task,
  params: { summary?: string },
  codeReviewVerdicts: Map<number, ReviewVerdict>,
): TaskDoneRefusalResult {
  const pendingSteps: number[] = [];
  for (let stepIndex = 0; stepIndex < task.steps.length; stepIndex++) {
    const step = task.steps[stepIndex];
    if (!step || step.status === "done" || step.status === "skipped") {
      continue;
    }
    pendingSteps.push(stepIndex);
    if (codeReviewVerdicts.get(stepIndex) === "REVISE") {
      const reason = `Step ${stepIndex + 1} (${step.name}) has a pending code review verdict of REVISE`;
      return {
        ok: false,
        refusalClass: "pending-code-review-revise",
        reason,
        message: formatTaskDoneRefusal("pending-code-review-revise", reason),
      };
    }
  }

  const summary = params.summary?.trim();
  // Preflight escape hatch: when the agent's preflight finds PROMPT.md is out
  // of sync with HEAD (work already done on the base), it marks remaining
  // steps `skipped` and calls fn_task_done with a `PREMISE STALE:` summary.
  // Skip the summary-text refusals (dissent + scoped-incomplete) for this
  // sentinel so a natural premise-stale explanation like "...the work is
  // already done on HEAD" cannot deadlock the executor. The pending-review
  // and bulk-step-completion guards above/below still apply.
  const isPremiseStale = !!summary && /^premise stale:/i.test(summary);
  if (summary && !isPremiseStale) {
    const dissentMatch = DISSENT_PATTERNS.find((pattern) => pattern.test(summary));
    if (dissentMatch) {
      const matchText = summary.match(dissentMatch)?.[0] ?? dissentMatch.source;
      const reason = `summary indicates incomplete work (${JSON.stringify(matchText)})`;
      return {
        ok: false,
        refusalClass: "summary-claims-incomplete",
        reason,
        message: formatTaskDoneRefusal("summary-claims-incomplete", reason),
      };
    }

    const scopedPattern = /\b(incomplete|not implemented|not done|not finished)\b/i;
    const scopedMatch = scopedPattern.exec(summary);
    if (scopedMatch) {
      const start = Math.max(0, scopedMatch.index - 40);
      const end = Math.min(summary.length, scopedMatch.index + scopedMatch[0].length + 40);
      const scopedWindow = summary.slice(start, end);
      const hasFirstPersonContext = /\b(i|i['’]?m|i['’]?ve|my|we)\b/i.test(scopedWindow)
        || /\b(the task|this task)\b/i.test(scopedWindow);
      if (hasFirstPersonContext) {
        const reason = `summary indicates incomplete work (${JSON.stringify(scopedMatch[0])})`;
        return {
          ok: false,
          refusalClass: "summary-claims-incomplete",
          reason,
          message: formatTaskDoneRefusal("summary-claims-incomplete", reason),
        };
      }
    }
  }

  if (pendingSteps.length >= 2) {
    const allPendingApproved = pendingSteps.every((stepIndex) => codeReviewVerdicts.get(stepIndex) === "APPROVE");
    if (!allPendingApproved) {
      const reason = `attempted to auto-complete ${pendingSteps.length} pending steps without APPROVE verdicts on all of them`;
      return {
        ok: false,
        refusalClass: "bulk-step-completion-without-review",
        reason,
        message: formatTaskDoneRefusal("bulk-step-completion-without-review", reason),
      };
    }
  }

  return { ok: true };
}

/**
 * Determines the step index from which revision should restart given a set of
 * completed steps and user feedback. Exported for unit tests; no longer called
 * from the executor (revision is now handled via `reopenLastStepForRevision`).
 */
export function determineRevisionResetStart(
  steps: ReadonlyArray<{ name: string }>,
  feedback: string,
): number {
  const total = steps.length;
  if (total === 0) return 0;
  const skipPreflight = /preflight/i.test(steps[0].name);
  const firstCandidate = skipPreflight ? 1 : 0;
  if (firstCandidate >= total) return total;
  const fb = feedback.toLowerCase();
  for (let i = firstCandidate; i < total; i++) {
    const tokens = steps[i].name.toLowerCase().match(/[a-z][a-z]{4,}/g) ?? [];
    if (tokens.some((t) => fb.includes(t))) return i;
  }
  return firstCandidate;
}

export interface WorkflowRevisionFeedbackPartition {
  inScopeFeedback: string;
  outOfScopeFeedback: string;
  inScopeSegments: string[];
  outOfScopeSegments: string[];
  detectedPaths: string[];
}

const WORKFLOW_SCRIPT_OUTPUT_MAX_CHARS = 4_000;
const WORKFLOW_FEEDBACK_PATH_REGEX = /`([^`\n]+)`|(?<![A-Za-z0-9_.-])((?:\.\.?\/)?(?:@?[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+(?:\.[A-Za-z0-9._-]+)?)/g;

function normalizeWorkflowScopePath(pathValue: string): string {
  return pathValue
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

function stripTrailingPathPunctuation(pathValue: string): string {
  return pathValue.replace(/[),.:;!?]+$/g, "");
}

export function extractReferencedPathsFromWorkflowFeedback(feedback: string): string[] {
  const extracted: string[] = [];
  const seen = new Set<string>();
  for (const match of feedback.matchAll(WORKFLOW_FEEDBACK_PATH_REGEX)) {
    const candidate = stripTrailingPathPunctuation(match[1] ?? match[2] ?? "");
    const normalized = normalizeWorkflowScopePath(candidate);
    if (!normalized.includes("/") || !normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    extracted.push(normalized);
  }
  return extracted;
}

/**
 * FN-4811 follow-up: paths the scope-leak guard never flags, regardless of declared
 * scope. These are file types every task may legitimately touch as part of standard
 * delivery (e.g., `.changeset/` per AGENTS.md's "Finalizing Changes" section).
 * Cross-task contamination of these paths is caught by stronger guards downstream
 * (file-scope invariant at squash commit, branch-tip checks, post-merge audit).
 */
export function isAlwaysAllowedScopeLeakPath(filePath: string): boolean {
  const normalizedPath = normalizeWorkflowScopePath(filePath);
  return normalizedPath.startsWith(".changeset/");
}

export function workflowPathMatchesDeclaredScope(filePath: string, scopePatterns: readonly string[]): boolean {
  const normalizedPath = normalizeWorkflowScopePath(filePath);
  for (const rawPattern of scopePatterns) {
    const pattern = normalizeWorkflowScopePath(rawPattern);
    if (!pattern) continue;
    if (/\/\*+$/.test(pattern)) {
      const directory = pattern.replace(/\/\*+$/, "");
      if (normalizedPath === directory || normalizedPath.startsWith(`${directory}/`)) return true;
      continue;
    }
    if (pattern.endsWith("/")) {
      if (normalizedPath.startsWith(pattern)) return true;
      continue;
    }
    if (normalizedPath === pattern) return true;
  }
  return false;
}

export function parseReviewLevelFromPrompt(prompt: string): number {
  const reviewMatch = prompt.match(/##\s*Review Level[:\s]*(\d)/);
  return reviewMatch ? parseInt(reviewMatch[1], 10) : 0;
}

export function partitionWorkflowRevisionFeedback(
  feedback: string,
  declaredFileScope: readonly string[],
): WorkflowRevisionFeedbackPartition {
  const trimmedFeedback = feedback.trim();
  if (!trimmedFeedback || declaredFileScope.length === 0) {
    return {
      inScopeFeedback: trimmedFeedback,
      outOfScopeFeedback: "",
      inScopeSegments: trimmedFeedback ? [trimmedFeedback] : [],
      outOfScopeSegments: [],
      detectedPaths: extractReferencedPathsFromWorkflowFeedback(trimmedFeedback),
    };
  }

  const segments = trimmedFeedback.split(/\n\s*\n/).map((segment) => segment.trim()).filter(Boolean);
  const allDetectedPaths = extractReferencedPathsFromWorkflowFeedback(trimmedFeedback);
  if (allDetectedPaths.length === 0) {
    return {
      inScopeFeedback: trimmedFeedback,
      outOfScopeFeedback: "",
      inScopeSegments: trimmedFeedback ? [trimmedFeedback] : [],
      outOfScopeSegments: [],
      detectedPaths: [],
    };
  }

  const inScopeSegments: string[] = [];
  const outOfScopeSegments: string[] = [];
  for (const segment of segments) {
    const segmentPaths = extractReferencedPathsFromWorkflowFeedback(segment);
    if (segmentPaths.length === 0) {
      inScopeSegments.push(segment);
      continue;
    }

    const hasOutOfScopePath = segmentPaths.some((path) => !workflowPathMatchesDeclaredScope(path, declaredFileScope));
    if (hasOutOfScopePath) {
      outOfScopeSegments.push(segment);
    } else {
      inScopeSegments.push(segment);
    }
  }

  return {
    inScopeFeedback: inScopeSegments.join("\n\n"),
    outOfScopeFeedback: outOfScopeSegments.join("\n\n"),
    inScopeSegments,
    outOfScopeSegments,
    detectedPaths: allDetectedPaths,
  };
}

class NonRetryableWorktreeError extends Error {}

function buildSessionWorktreePathRegex(rootDir: string, settings: Partial<Settings>): RegExp {
  const configuredBase = resolveWorktreesDir(rootDir, settings).split(/[\\/]/).filter(Boolean).pop() ?? ".worktrees";
  const escapedBase = configuredBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`([A-Za-z]:)?[^"'\\s]*(?:\\.worktrees|${escapedBase})[\\\\/][^"'\\s]+`, "g");
}

function normalizeWorktreePath(pathValue: string): string {
  return resolvePath(pathValue).replace(/\\/g, "/").replace(/\/+$/, "");
}

async function extractPersistedSessionWorktreePath(
  sessionFile: string,
  rootDir: string,
  settings: Partial<Settings>,
): Promise<string | null> {
  try {
    const content = await readFile(sessionFile, "utf-8");
    const matches = content.match(buildSessionWorktreePathRegex(rootDir, settings)) ?? [];
    if (matches.length === 0) return null;

    const normalizedCounts = new Map<string, number>();
    for (const match of matches) {
      const normalized = normalizeWorktreePath(match);
      normalizedCounts.set(normalized, (normalizedCounts.get(normalized) ?? 0) + 1);
    }

    let best: { path: string; count: number } | null = null;
    for (const [path, count] of normalizedCounts.entries()) {
      if (!best || count > best.count) best = { path, count };
    }
    return best?.path ?? null;
  } catch {
    return null;
  }
}

function isSessionWorktreeCompatible(
  persistedWorktreePath: string | null,
  currentWorktreePath: string,
): boolean {
  if (!persistedWorktreePath) return true;
  return persistedWorktreePath === normalizeWorktreePath(currentWorktreePath);
}

function truncateWorkflowScriptOutput(output: string): string {
  if (output.length <= WORKFLOW_SCRIPT_OUTPUT_MAX_CHARS) return output;
  return `... output truncated to last ${WORKFLOW_SCRIPT_OUTPUT_MAX_CHARS} characters ...\n${output.slice(-WORKFLOW_SCRIPT_OUTPUT_MAX_CHARS)}`;
}

function configuredCommandErrorMessage(result: RunCommandResult): string {
  if (result.spawnError) return result.spawnError.message;
  const parts: string[] = [];
  if (result.timedOut) parts.push("Timed out");
  if (result.exitCode !== null) parts.push(`Exit code: ${result.exitCode}`);
  if (result.signal) parts.push(`Signal: ${result.signal}`);
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout) parts.push(`stdout: ${truncateWorkflowScriptOutput(stdout)}`);
  if (stderr) parts.push(`stderr: ${truncateWorkflowScriptOutput(stderr)}`);
  return parts.length ? parts.join("\n") : "Command failed";
}

function getConfiguredCommandSandboxBackend(auditor?: RunAuditor): SandboxBackend {
  return resolveSandboxBackend({ auditor });
}

async function runConfiguredCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  extraEnv?: NodeJS.ProcessEnv,
  auditor?: RunAuditor,
  signal?: AbortSignal,
): Promise<RunCommandResult> {
  const backend = getConfiguredCommandSandboxBackend(auditor);
  const result = await backend.run(command, {
    cwd,
    timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf-8",
    ...(extraEnv !== undefined && { env: extraEnv }),
    ...(signal !== undefined && { signal }),
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    signal: result.signal,
    bufferExceeded: result.bufferExceeded,
    timedOut: result.timedOut,
    spawnError: result.spawnError,
  };
}

export async function __runConfiguredCommandForTests(
  command: string,
  cwd: string,
  timeoutMs: number,
  extraEnv?: NodeJS.ProcessEnv,
  auditor?: RunAuditor,
  signal?: AbortSignal,
): Promise<RunCommandResult> {
  return runConfiguredCommand(command, cwd, timeoutMs, extraEnv, auditor, signal);
}

// ── Tool parameter schemas (module-level for reuse in ToolDefinition generics) ──

const taskUpdateParams = Type.Object({
  step: Type.Optional(Type.Number({ description: "Step number (1-indexed). Omit when updating only custom_fields/dependencies." })),
  status: Type.Optional(Type.Union(
    STEP_STATUSES.map((s) => Type.Literal(s)),
    { description: "New status: pending, in-progress, done, or skipped. Required when step is set." },
  )),
  dependencies: Type.Optional(Type.Array(Type.String(), {
    description: "Optional task dependency array. Replaces existing dependencies. Pass ['FN-001', 'FN-002'] to set dependencies. Pass [] to clear all dependencies. Omit parameter to preserve existing dependencies.",
  })),
  custom_fields: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description:
      "Optional patch of workflow-defined custom field values, keyed by field id. " +
      "Values are validated against the task's workflow field schema (type/enum membership); " +
      "pass null for a field to clear it. Rejected writes return the offending field id and reason. " +
      "Only fields declared by the task's workflow may be written.",
  })),
});

// taskLogParams and taskCreateParams are imported from agent-tools.ts

const taskAddDepParams = Type.Object({
  task_id: Type.String({ description: "The ID of the task to depend on (e.g. \"KB-001\")" }),
  confirm: Type.Optional(Type.Boolean({ description: "Set to true to confirm adding the dependency. Required because adding a dep to an in-progress task will stop execution and discard current work." })),
});

const spawnAgentParams = Type.Object({
  name: Type.String({ description: "Name for the child agent" }),
  role: Type.Union([
    Type.Literal("triage"),
    Type.Literal("executor"),
    Type.Literal("reviewer"),
    Type.Literal("merger"),
    Type.Literal("engineer"),
    Type.Literal("custom"),
  ], { description: "Role for the child agent" }),
  task: Type.String({ description: "Task description for the child agent to execute" }),
});

/** Result returned from fn_spawn_agent tool */
interface SpawnAgentResult {
  agentId: string;
  name: string;
  state: AgentState;
  role: AgentCapability;
  message: string;
}

/**
 * Outcome of a single workflow step execution.
 * Supports three states: pass, hard failure, or revision requested with feedback.
 */
export interface WorkflowStepOutcome {
  success: boolean;
  revisionRequested?: boolean;
  output?: string;
  error?: string;
  /** Machine-readable verdict extracted from structured JSON output. */
  verdict?: "APPROVE" | "APPROVE_WITH_NOTES" | "REVISE";
  /** Notes extracted from structured JSON output (distinct from raw output). */
  notes?: string;
  /** Set when the call exceeded `settings.workflowStepTimeoutMs`. Signals the
   *  caller to escalate to the fallback model rather than treat the failure
   *  as a generic revision request. */
  timedOut?: boolean;
  /** True when no structured or prose verdict could be inferred. */
  malformed?: boolean;
}

/**
 * Result of running all pre-merge workflow steps.
 * Returns true if all passed, false if any hard failure, or a structured
 * revision result if a revision was requested.
 */
export type WorkflowStepResult =
  | { allPassed: true }
  | { allPassed: false; revisionRequested: false; feedback: string; stepName: string }
  | { allPassed: false; revisionRequested: true; feedback: string; stepName: string };

const WORKFLOW_STEP_VERDICTS = new Set(["APPROVE", "APPROVE_WITH_NOTES", "REVISE"] as const);

export function parseWorkflowStepVerdict(rawOutput: string): { verdict: "APPROVE" | "APPROVE_WITH_NOTES" | "REVISE"; notes: string } | null {
  const trimmed = rawOutput.trim();
  const candidates: string[] = [];
  const fencedMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const match of fencedMatches) {
    candidates.push(match[1].trim());
  }
  const jsonObjectMatches = trimmed.match(/\{[\s\S]*\}/g);
  if (jsonObjectMatches) {
    candidates.push(...jsonObjectMatches.map((value) => value.trim()));
  }

  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(candidates[i]) as { verdict?: string; notes?: unknown };
      if (!parsed || typeof parsed.verdict !== "string" || !WORKFLOW_STEP_VERDICTS.has(parsed.verdict as "APPROVE")) {
        continue;
      }
      return {
        verdict: parsed.verdict as "APPROVE" | "APPROVE_WITH_NOTES" | "REVISE",
        notes: typeof parsed.notes === "string" ? parsed.notes : "",
      };
    } catch {
      // continue
    }
  }

  return null;
}

export function inferWorkflowStepVerdictFromProse(rawOutput: string): { verdict: "APPROVE" | "REVISE"; notes: string } | null {
  const trimmed = rawOutput.trim();
  const revisionMatch = trimmed.match(/^REQUEST REVISION\s*\n*/i);
  if (revisionMatch) {
    return { verdict: "REVISE", notes: trimmed.slice(revisionMatch[0].length).trim() || "Revision requested" };
  }
  if (/\b(approve|approved|looks good|no issues|out of scope)\b/i.test(trimmed)) {
    return { verdict: "APPROVE", notes: "" };
  }
  return null;
}

const reviewStepParams = Type.Object({
  step: Type.Number({ description: "Step number to review" }),
  type: Type.Union(
    [Type.Literal("plan"), Type.Literal("code")],
    { description: 'Review type: "plan" or "code"' },
  ),
  step_name: Type.String({ description: "Name of the step being reviewed" }),
  baseline: Type.Optional(
    Type.String({
      description:
        "Git commit SHA for code review diff baseline. " +
        "Capture HEAD before starting a step and pass it here.",
    }),
  ),
});

const EXECUTOR_SYSTEM_PROMPT = `You are a task execution agent for "fn", an AI-orchestrated task board.

You are working in a git worktree isolated from the main branch. Your job is to implement the task described in the PROMPT.md specification you're given.

## Your Role in the System
You are the primary implementation agent in Fusion.
You execute task specs in isolated worktrees, produce production-quality changes, and hand off work that can pass independent review and merge.

## Turn-ending rules — read carefully

You MUST end every turn by either:
- (a) calling another tool to make progress, OR
- (b) calling \`fn_task_done\` if the entire task is complete, OR
- (c) calling \`fn_task_done\` with a summary explaining what is blocked, if you cannot make progress for any reason

You MUST NOT end a turn by writing prose that asks the user a question, summarizes progress, or requests permission to continue. The following are FORBIDDEN turn-endings:
- "If you want, I can continue with..."
- "Should I proceed with...?"
- "Let me know if you'd like me to..."
- "Ready to move on to step N. Want me to continue?"
- Any markdown progress summary at the end of a turn instead of a tool call

If you have just finished a step's work, immediately call \`fn_task_update\` to mark the step done and continue with the next pending step in the SAME turn. Do not pause to summarize.

The user is not watching this conversation in real-time. They will read the final result. Asking permission wastes a full retry cycle and may orphan committed work.

If you genuinely cannot proceed (blocked on a dependency, missing information, or an unresolvable error), call \`fn_task_done\` with a clear explanation of what is blocked and what is needed to unblock it. Never write the question as plain prose.

## How to work
1. Read the PROMPT.md carefully — it contains your mission, steps, file scope, acceptance criteria, and Do NOT constraints
2. Before touching code, read all files listed in "Context to Read First" and understand the full step outcome
3. Check existing patterns in the codebase before introducing new structure, naming, or APIs
4. Work through each step in order
5. Write clean, production-quality code
6. Test your changes continuously
7. Commit at meaningful boundaries (step completion)

## Reporting progress via tools

You have tools to report progress. The board updates in real-time.

**Step lifecycle:**
- Before starting a step: \`fn_task_update(step=N, status="in-progress")\`
- After completing a step: \`fn_task_update(step=N, status="done")\`
- If skipping a step: \`fn_task_update(step=N, status="skipped")\`

**Preflight escape hatch — stale premise.**
PROMPT.md is captured at task-creation time; HEAD may have moved on since then. During Preflight (Step 0), reproduce the failure or symptom described in the PROMPT. If reproduction shows the work is **already done or the premise no longer matches HEAD** — for example, the test that PROMPT claims is failing already passes on the current base, or the file PROMPT says to change already contains the described change — do NOT march through the remaining steps producing empty commits. Instead:

1. Call \`fn_task_log\` with a clear premise-stale finding: what PROMPT.md claimed vs. what HEAD actually shows (include the exact reproduction command + its result).
2. Mark Step 0 done: \`fn_task_update(step=0, status="done")\`.
3. Mark every remaining step skipped with a one-line reason: \`fn_task_update(step=N, status="skipped")\`.
4. Call \`fn_task_done\` with a summary that begins \`PREMISE STALE:\` followed by the concrete reason (e.g. \`PREMISE STALE: targeted reproduction passes unchanged on HEAD; PROMPT claimed MOBILE_MEDIA_QUERY had been expanded but useViewportMode.ts:9 still exports the legacy value\`).

This path exists specifically to prevent the executor from looping when PROMPT.md is out of sync with HEAD. Use it only after running the actual reproduction — do not invoke it to dodge real work.

**Logging important actions:** \`fn_task_log(message="what happened")\`

**Out-of-scope work found during execution:** \`fn_task_create(description="what needs doing")\`
When creating multiple related tasks, declare dependencies between them:
\`fn_task_create(description="load door sounds", dependencies=[])\` → returns KB-050
\`fn_task_create(description="play sound on door open/close", dependencies=["KB-050"])\`

**Discovered a dependency:** \`fn_task_add_dep(task_id="KB-XXX")\` — use when you discover mid-execution that another task must be completed first. This will return a warning first — you must call again with \`confirm=true\` to proceed. Adding a dependency stops execution, discards current work, and moves the task to triage for re-planning.

## Cross-model review via fn_review_step tool

You have a \`fn_review_step\` tool. It spawns a SEPARATE reviewer agent (different
model, read-only access) to independently assess your work.

**When to call it** — based on the Review Level in the PROMPT.md:

| Review Level | Before implementing | After implementing + committing |
|-------------|--------------------|---------------------------------|
| 0 (None)    | —                  | —                               |
| 1 (Plan)    | \`fn_review_step(step, "plan", step_name)\` | —              |
| 2 (Plan+Code) | \`fn_review_step(step, "plan", step_name)\` | \`fn_review_step(step, "code", step_name, baseline)\` |
| 3 (Full)    | plan review        | code review + test review       |

**Skip reviews for** Step 0 (Preflight) and the final documentation/delivery step.

**Code review flow:**
1. Before starting a step, capture baseline: \`git rev-parse HEAD\`
2. Implement the step
3. Commit
4. Call \`fn_review_step\` with the baseline SHA so the reviewer sees only your changes

**Handling verdicts:**
- **APPROVE** → proceed to next step
- **REVISE (code review)** → **enforced**. You MUST fix the issues, commit again,
  and re-run \`fn_review_step(type="code")\` before the step can be marked done.
  \`fn_task_update(status="done")\` will be rejected until the code review passes.
- **REVISE (plan review)** → advisory. Incorporate the feedback at your discretion
  and proceed with implementation. No re-review is required.
- **RETHINK (code review)** → your code changes have been reverted and conversation rewound. Read the feedback carefully and take a fundamentally different approach. Do NOT repeat the rejected strategy.
- **RETHINK (plan review)** → conversation rewound to before the step (no git reset since no code was written). Read the feedback and take a fundamentally different approach to planning this step.

## Task Documents

You can save and retrieve named documents for this task. Use these to store planning notes, research findings, or any persistent data that should survive across sessions.

- **Save a document:** \`fn_task_document_write(key="plan", content="...")\`
- **Read a document:** \`fn_task_document_read(key="plan")\`
- **List all documents:** \`fn_task_document_read()\` (no key)

Documents are versioned — each write creates a new revision. Use meaningful keys like "plan", "notes", "research", "architecture".

**IMPORTANT — Save your deliverables as documents:** When your task produces written output (documentation, specifications, reports, API references, README updates, guides, or any other content), you MUST save that content as a task document using \`fn_task_document_write\`. Use a key that describes the deliverable (e.g., key="readme", key="api-docs", key="changelog"). Do this in addition to writing the file to disk — the document persists in the task for review even after the worktree is cleaned up.

If the task's PROMPT.md includes a "Documentation Requirements" section listing files to update, save each updated file's final content as a task document with a matching key.

## Git discipline
- Commit after completing each step (not after every file change)
- Use conventional commit messages prefixed with the task ID
- Always include a short, specific summary after the em dash (5–10 words)
- Do NOT commit just \`complete Step N\` — the summary is what makes the commit useful in \`git log\`, merger subject derivation, and step reconciliation
- When the task has a GitHub issue reference, include \`Ref: owner/repo#N\` in the commit body
- Do NOT commit broken or half-implemented code

Good commit message examples:
- \`feat(FN-1234): complete Step 2 — add retry guard for workflow step timeouts\`
- \`feat(FN-1234): complete Step 4 — tighten prompt examples for commit summaries\`
- \`test(FN-1234): add regression tests for paused-session cleanup\`

Bad commit message examples:
- \`feat(FN-1234): complete Step 2\`
- \`misc updates\`
- \`fix stuff\`
- \`wip\`

## Worktree Boundaries

You are running in an **isolated git worktree**. This means:

- **All code changes must be made inside the current worktree directory.** Do not modify files outside the worktree — the worktree is your isolated execution environment.
- **Exception — Project memory:** You MAY read and write to files under .fusion/memory/ at the project root to save durable project learnings (architecture patterns, conventions, pitfalls).
- **Exception — Task attachments:** You MAY read files under .fusion/tasks/{taskId}/attachments/ at the project root for context screenshots and documents attached to this task.
- **Exception — Sibling task specs:** You MAY read .fusion/tasks/{taskId}/PROMPT.md and .fusion/tasks/{taskId}/task.json at the project root (read-only) to consult dependency tasks' specifications. If those files do not exist, the dependency has been archived — call \`fn_task_show\` with its ID to load the spec from the archive.
- **Shell commands** run inside the worktree by default. Avoid using cd to navigate outside the worktree.

If you attempt to write to a path outside the worktree, the file tools will reject the operation with an error explaining the boundary.

## Guardrails
- **NEVER kill processes on port 4040.** Port 4040 is the production dashboard. Do not run \`kill\`, \`pkill\`, \`killall\`, or \`lsof -ti:4040 | xargs kill\` against it. If you need to start a test server, use \`--port 0\` for a random free port. If port 4040 is occupied, pick a different port — do NOT kill the occupant.
- Treat the File Scope in PROMPT.md as the expected starting scope, not a hard boundary when quality gates fail
- Read "Context to Read First" files before starting
- Follow the "Do NOT" section strictly — these are hard constraints, not suggestions
- If tests, lint, build, or typecheck fail and the fix requires touching code outside the declared File Scope, fix those failures directly and keep the repo green
- Use \`fn_task_create\` for genuinely separate follow-up work, not for mandatory fixes required to make this task land cleanly
- Update documentation listed in "Must Update" and check "Check If Affected"
- NEVER delete, remove, or gut modules, interfaces, settings, exports, or test files outside your File Scope
- NEVER remove features as "cleanup" — if something seems unused, create a task for investigation instead
- Removing code is acceptable ONLY when it is explicitly part of your task's mission
- If you remove existing functionality, you MUST create a changeset in \`.changeset/\` explaining the removal and rationale

## Spawning Child Agents

You can spawn child agents to handle parallel work or specialized sub-tasks:

**When to use \`fn_spawn_agent\`:**
- Parallel work that can be divided into independent chunks with minimal overlap
- Specialized tasks requiring different expertise or tools
- Delegation of sub-tasks whose outputs can be validated independently

**When NOT to spawn:**
- The work is small enough to finish directly in your current step
- Subtasks are tightly coupled and would create merge/cherry-pick overhead
- You have not yet clarified expected outputs and acceptance criteria for the child

**How to spawn:**
\`\`\`javascript
fn_spawn_agent({
  name: "researcher",
  role: "engineer",
  task: "Research best practices for authentication in React applications"
})
\`\`\`

**Child agent behavior:**
- Each child runs in its own git worktree (branched from your worktree)
- Children execute autonomously and report completion
- When you end (fn_task_done), all spawned children are terminated
- Check AgentStore for spawned agent status

**Limits:**
- Max 5 spawned agents per parent by default (configurable via settings)
- Max 20 total spawned agents system-wide (configurable via settings)

## Completion
After all steps are done, lint passes, tests pass, typecheck passes, and docs are updated:
\`\`\`bash
Call \`fn_task_done()\` to signal completion.
\`\`\`

If a project build command is listed in the prompt, it is a hard completion gate:
- Run the exact build command in the current worktree before \`fn_task_done()\`
- Do not claim the build passes unless you actually ran it and got exit code 0
- If the build fails, do NOT call \`fn_task_done()\`; keep working until it passes

Lint, tests, and typecheck are also hard quality gates:
- Keep fixing failures until lint, the configured/full test suite, and typecheck all pass
- If the repository exposes a typecheck command, run it and keep fixing failures until it passes
- Do not stop at "out of scope" if additional fixes are required to restore green lint, tests, build, or typecheck
- When tests fail, first identify whether the failure is caused by your change, a pre-existing defect, or an outdated test expectation; then fix code or tests accordingly so behavior and assertions match
- Update tests when intended behavior changed; fix implementation when behavior regressed unintentionally
- **CRITICAL: Resolve ALL lint failures and test failures before completing the task, even if they appear unrelated or pre-existing.** Unrelated failures left unfixed accumulate technical debt and block future integrations. Investigate and fix or suppress them — do not defer them to a separate task.

## Verification commands — use fn_run_verification

For ALL test/lint/build/typecheck verification, use the \`fn_run_verification\` tool, NOT raw bash.
The tool prevents your session from being killed by the inactivity watchdog during long compiles.

- Prefer **package-scoped** verification first: e.g. \`pnpm --filter @fusion/<pkg> test\` with \`scope: "package"\`. This is faster and isolated.
- Only run **workspace-scoped** verification (\`pnpm test\`, \`pnpm lint\`, \`pnpm build\` from root) at the FINAL integration step, when you are about to call \`fn_task_done\`.
- If you need to run \`pnpm install\` (e.g. you added a new package), use \`fn_run_verification\` with \`scope: "workspace"\` and \`timeoutSec: 600\`.
- If a verification command times out, do NOT blindly retry — investigate. Check for hung subprocesses, infinite test loops, or tests waiting on missing dependencies. Use \`node_modules/.modules.yaml\` presence to confirm bootstrap.

## Common Pitfalls
- Editing files outside the assigned worktree (except allowed memory/attachment paths)
- Skipping or partially running required quality gates
- Leaving TODO/FIXME placeholders instead of completing required implementation
- Introducing new patterns when existing local patterns should be reused
- Marking a step done before required review/tooling gates are satisfied`;

/** Resolve the executor system prompt from settings, falling back to the hardcoded constant. */
function getExecutorSystemPrompt(settings: Settings): string {
  const customPrompt = resolveAgentPrompt("executor", settings.agentPrompts);
  const basePrompt = customPrompt || EXECUTOR_SYSTEM_PROMPT;
  const sections = [
    basePrompt,
    isResearchToolSurfaceEnabled(settings) ? getResearchGuidanceForSurface("executor") : "",
  ].filter((section) => section.trim());
  return sections.join("\n\n");
}


export interface TaskExecutorOptions {
  semaphore?: AgentSemaphore;
  /** Worktree pool for recycling idle worktrees across tasks. */
  pool?: WorktreePool;
  /** Usage limit pauser — triggers global pause when API limits are detected. */
  usageLimitPauser?: UsageLimitPauser;
  /** Stuck task detector — monitors agent sessions for stagnation and triggers recovery. */
  stuckTaskDetector?: StuckTaskDetector;
  /** AgentStore for tracking spawned child agents. If not provided, spawning is disabled. */
  agentStore?: import("@fusion/core").AgentStore;
  /** Reflection service used to generate self-reflection insights for agents. */
  reflectionService?: AgentReflectionService;
  /** Plugin runner for invoking plugin hooks and providing plugin tools. */
  pluginRunner?: PluginRunner;
  /** MessageStore for sending messages to other agents. When provided, executor agents gain fn_send_message capability. */
  messageStore?: import("@fusion/core").MessageStore;
  missionStore?: MissionStore;
  secretsStore?: Pick<import("@fusion/core").SecretsStore, "listEnvExportable">;
  onSliceComplete?: (slice: Slice) => void;
  onStart?: (task: Task, worktreePath: string) => void;
  onComplete?: (task: Task) => void;
  onError?: (task: Task, error: Error) => void;
  onAgentText?: (taskId: string, delta: string) => void;
  onAgentTool?: (taskId: string, toolName: string) => void;
  autoRecoveryDispatcher?: AutoRecoveryDispatcher;
  /**
   * CLI Agent Executor runtime (U7). When present, workflow nodes with
   * `config.executor === "cli-agent"` drive an engine-owned CLI session via the
   * task-session orchestration. Absent → cli-agent nodes report a clear config
   * error (the runtime was not wired). Bundled so a single option threads the
   * PTY manager + telemetry hub + adapter registry + hook endpoint together.
   */
  cliAgentRuntime?: CliAgentRuntime;
}

/** Bundled CLI Agent Executor runtime dependencies (U7). */
export interface CliAgentRuntime {
  /** Engine-owned PTY session manager (U2). */
  manager: CliSessionManager;
  /** In-process telemetry hub (U3) — owns per-session tokens + state machines. */
  hub: TelemetryHub;
  /** Adapter registry (U2) — resolves adapter id → adapter. */
  registry: CliAdapterRegistry;
  /** Durable session store (U1) — for re-entry / follow-up session lookups. */
  store: CliSessionStore;
  /** Project this runtime drives (the executor is per-project; `cli_sessions` needs it). */
  projectId: string;
  /**
   * Absolute URL of the dashboard hook ingestion endpoint the hook scripts POST
   * to (e.g. `http://127.0.0.1:4040/api/cli-agent/hooks`).
   */
  hookEndpointUrl: string;
  /** Optional override for the hook scratch-dir root (tests). */
  hookDirRoot?: string;
}

export class TaskExecutor {
  private activeWorktrees = new Map<string, string>();
  private executing = new Set<string>();
  /** Tasks currently being prepared for unpause resume, before execute() has registered them. */
  private resumingUnpaused = new Set<string>();
  /** Completed orphan recovery tasks currently running during startup. */
  private recoveringCompleted = new Set<string>();
  /** Tracks tasks whose workflow-rerun bounce is in flight (todo→in-progress).
   *  Prevents the task:moved handler from dispatching execute() before the
   *  bounce finishes its own dispatch. */
  private workflowRerunPending = new Set<string>();
  /** FN-5256: in-flight session-disposal promises keyed by taskId. The
   *  task:moved (away from in-progress) and task:deleted listeners populate
   *  this so a fast re-dispatch (task:moved → in-progress) awaits the prior
   *  session being fully reaped before creating/acquiring a new worktree. */
  private pendingTaskDisposals = new Map<string, Promise<void>>();
  /** Active agent sessions per task, used to terminate on pause and inject steering. */
  private activeSessions = new Map<string, {
    session: AgentSession;
    seenSteeringIds: Set<string>;
    lastResolvedModelProvider?: string;
    lastResolvedModelId?: string;
    lastTaskModelProvider?: string | null;
    lastTaskModelId?: string | null;
    lastAssignedAgentId?: string | null;
    // Column-agent restart-invalidation (plan U5, R7/KTD-4). The effective
    // column-agent id governing this session's seam (undefined when no binding
    // governs — the legacy path). Tracked so the watcher can detect a workflow-
    // definition edit or agent runtimeConfig change that re-keys the column-
    // effective agent/model mid-flight and trigger the same restart path a
    // task.modelProvider change does today.
    lastEffectiveColumnAgentId?: string | null;
  }>();
  /** Active step-session executors per task (mutually exclusive with activeSessions). */
  private activeStepExecutors = new Map<string, StepSessionExecutor>();
  /** Column-agent principal alignment (plan U5, R6): the EFFECTIVE column-agent id
   *  currently running each executing task's coding/step session, when an
   *  override/defer binding governs the in-flight seam. Keyed by task id, populated
   *  by the execute / step-execute seam right after `resolveSeamColumnAgent` yields a
   *  column agent, and cleared alongside the session (deleteActiveSession /
   *  deleteActiveStepExecutor). Powers `isAgentEffectivelyExecuting`, the
   *  reverse-direction heartbeat-scheduler guard that must know an agent is running a
   *  task it is not `assignedAgentId` on. Empty for the legacy/no-binding path, so
   *  that path is byte-identical. */
  private effectiveColumnAgentByTask = new Map<string, string>();
  /** Active pre-merge workflow step sessions per task. */
  private activeWorkflowStepSessions = new Map<string, AgentSession>();
  /** Active configured-command abort controllers keyed by task. */
  private activeConfiguredCommandControllers = new Map<string, Set<AbortController>>();
  /**
   * Active CLI agent task sessions per task (U7). Mirrors activeSessions for the
   * cli-agent executor kind so the hard-cancel / abort path can SIGKILL the PTY
   * and mark `killed` (never resume-eligible), and the in-review handoff can reap
   * the PTY. A task has at most one live CLI session at a time.
   */
  private activeCliTaskSessions = new Map<string, CliTaskSession>();
  private readonlyWorkflowStepAuditDone = false;
  /**
   * Reviewer subagent sessions per task. Reviewers (`reviewer.ts`) create their
   * own AgentSessions that aren't part of `activeSessions`/`activeStepExecutors`,
   * so without this map they survive when the parent task is stopped — they
   * keep producing log entries and step transitions after the user thinks they
   * killed the task. Disposed alongside the main session in the move-out,
   * pause, and global-pause handlers below.
   */
  private activeSubagentSessions = new Map<string, Set<AgentSession>>();
  /** Tasks that were paused mid-execution (to avoid marking them as "failed"). */
  private pausedAborted = new Set<string>();
  /** Tasks that had a dependency added mid-execution (abort + discard worktree). */
  private depAborted = new Set<string>();
  /** Tasks killed by stuck task detector. Value = shouldRequeue (budget not exhausted). */
  private stuckAborted = new Map<string, boolean>();
  /** Tasks explicitly canceled by user move (in-progress → todo). */
  private userCanceledTaskIds = new Set<string>();
  /** In-memory loop recovery state per task. Keyed by taskId, not persisted.
   *  Tracks compact-and-resume attempt count per execute() lifecycle.
   *  Reset at execute() lifecycle end (finally block). */
  private loopRecoveryState = new Map<string, { attempts: number; pending: boolean }>();
  /** Spawned child agent IDs per parent task ID. Used for lifecycle tracking. */
  private spawnedAgents = new Map<string, Set<string>>();
  /** Per-task baseline of session stats used for delta persistence across repeated updates. */
  private tokenUsageBaselines = new Map<string, { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; totalTokens: number }>();
  /** In-memory branch conflict error counters per task for tripwire protection. */
  private branchConflictErrorCount = new Map<string, number>();
  /** One-shot watchdogs for completed tasks that should have transitioned to in-review. */
  private completedTaskWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  /** One-shot watchdogs for workflow reruns that should have bounced back to in-progress. */
  private workflowRerunWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  /** Set of ephemeral spawned agent IDs with in-flight cleanup (prevents duplicate deletion attempts). */
  private pendingEphemeralDeletions = new Set<string>();

  private setActiveSession(taskId: string, sessionState: {
    session: AgentSession;
    seenSteeringIds: Set<string>;
    lastResolvedModelProvider?: string;
    lastResolvedModelId?: string;
    lastTaskModelProvider?: string | null;
    lastTaskModelId?: string | null;
    lastAssignedAgentId?: string | null;
    lastEffectiveColumnAgentId?: string | null;
  }, worktreePath: string): void {
    this.activeSessions.set(taskId, sessionState);
    activeSessionRegistry.registerPath(worktreePath, { taskId, kind: "executor", ownerKey: taskId });
  }

  private deleteActiveSession(taskId: string, worktreePath?: string): void {
    this.activeSessions.delete(taskId);
    // U5: drop the effective column-agent principal for this task's session.
    this.effectiveColumnAgentByTask.delete(taskId);
    const resolvedWorktreePath = worktreePath ?? this.activeWorktrees.get(taskId);
    if (resolvedWorktreePath) {
      activeSessionRegistry.unregisterPath(resolvedWorktreePath);
    }
  }

  private setActiveStepExecutor(taskId: string, stepExecutor: StepSessionExecutor, worktreePath: string): void {
    this.activeStepExecutors.set(taskId, stepExecutor);
    activeSessionRegistry.registerPath(worktreePath, { taskId, kind: "step-session", ownerKey: `${taskId}#step-session` });
  }

  private deleteActiveStepExecutor(taskId: string, worktreePath?: string): void {
    this.activeStepExecutors.delete(taskId);
    // U5: drop the effective column-agent principal for this task's step session.
    this.effectiveColumnAgentByTask.delete(taskId);
    const resolvedWorktreePath = worktreePath ?? this.activeWorktrees.get(taskId);
    if (resolvedWorktreePath) {
      activeSessionRegistry.unregisterPath(resolvedWorktreePath);
    }
  }

  private setActiveWorkflowStepSession(taskId: string, session: AgentSession, worktreePath: string): void {
    this.activeWorkflowStepSessions.set(taskId, session);
    activeSessionRegistry.registerPath(worktreePath, { taskId, kind: "workflow-step", ownerKey: `${taskId}#workflow-step` });
  }

  private deleteActiveWorkflowStepSession(taskId: string, worktreePath?: string): void {
    this.activeWorkflowStepSessions.delete(taskId);
    const resolvedWorktreePath = worktreePath ?? this.activeWorktrees.get(taskId);
    if (resolvedWorktreePath) {
      activeSessionRegistry.unregisterPath(resolvedWorktreePath);
    }
  }

  private registerConfiguredCommandController(taskId: string, controller: AbortController): void {
    const controllers = this.activeConfiguredCommandControllers.get(taskId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.activeConfiguredCommandControllers.set(taskId, controllers);
  }

  private unregisterConfiguredCommandController(taskId: string, controller: AbortController): void {
    const controllers = this.activeConfiguredCommandControllers.get(taskId);
    if (!controllers) return;
    controllers.delete(controller);
    if (controllers.size === 0) {
      this.activeConfiguredCommandControllers.delete(taskId);
    }
  }

  private createConfiguredCommandAbortError(taskId: string, command: string): Error {
    const error = new Error(`Configured command aborted for ${taskId}: ${command}`);
    error.name = "AbortError";
    return error;
  }

  private getAutoRecoveryDispatcher(audit: RunAuditor): AutoRecoveryDispatcher {
    if (this.options.autoRecoveryDispatcher) return this.options.autoRecoveryDispatcher;
    const fileScopeHandler = createFileScopeAutoRecoveryHandler({
      taskStore: this.store,
      runAudit: audit,
      logger: executorLog,
      spawnAgent: async () => ({ agentId: "unavailable" }),
      classifyPatchIds: async () => ({ unique: [], alreadyUpstream: [] }),
      settings: () => ({ autoRecovery: { mode: "deterministic-only", maxRetries: 3 } } as ProjectSettings),
    });
    const branchWorktreeHandler = new BranchWorktreeAutoRecoveryHandler({
      taskStore: this.store,
      runAudit: audit,
      logger: executorLog,
    });
    const contaminationHandler = new ContaminationAutoRecoveryHandler({
      taskStore: this.store,
      runAudit: audit,
      logger: executorLog,
      repoDir: this.rootDir,
    });
    return new AutoRecoveryDispatcher({
      taskStore: this.store,
      auditEmitter: audit,
      handlers: {
        issueRetry: async (failure, decision, ctx) => {
          if (failure.class === "branch-cross-contamination") {
            return contaminationHandler.issueRetry(failure, decision, ctx);
          }
          if (failure.class === "branch-conflict-unrecoverable") {
            return branchWorktreeHandler.issueRetry(failure, decision, ctx);
          }
          return fileScopeHandler.issueRetry(failure, decision, ctx);
        },
        spawnAiRecovery: async (failure, decision, ctx) => {
          if (failure.class === "branch-conflict-unrecoverable") {
            return branchWorktreeHandler.spawnAiRecovery(failure, decision, ctx);
          }
          return fileScopeHandler.spawnAiRecovery(failure, decision, ctx);
        },
      },
    });
  }

  private async renewTaskLease(
    taskId: string,
    agentId: string,
    leaseEpoch: number,
    nodeId: string,
    runId: string | undefined,
  ): Promise<void> {
    const renewedAt = new Date().toISOString();
    if (this.options.agentStore) {
      await this.options.agentStore.checkoutTask(
        agentId,
        taskId,
        {
          nodeId,
          runId,
          leaseEpoch,
          renewedAt,
        },
        this.getRunContextFor(taskId),
      );
      return;
    }
    await this.store.updateTask(taskId, {
      checkoutRunId: runId ?? null,
      checkoutLeaseRenewedAt: renewedAt,
    });
  }

  private async finalizeAlreadyReviewedTask(taskId: string): Promise<"merged" | "blocked" | "missing"> {
    const latestTask = await this.store.getTask(taskId);
    if (!latestTask || latestTask.column !== "in-review") {
      return "missing";
    }

    const blocker = getTaskMergeBlocker(latestTask);
    if (blocker) {
      await this.store.logEntry(taskId, "Task already in-review; merge deferred", blocker, this.getRunContextFor(taskId));
      return "blocked";
    }

    await this.store.logEntry(
      taskId,
      "Task already in-review after completion — finalizing merge",
      undefined,
      this.getRunContextFor(taskId),
    );
    await this.store.mergeTask(taskId);
    return "merged";
  }

  private async getExecutionPauseLabel(): Promise<"global pause" | "engine pause" | null> {
    const settings = await this.store.getSettings();
    if (settings.globalPause) return "global pause";
    if (settings.enginePaused) return "engine pause";
    return null;
  }

  private async shouldDeferCompletionForGlobalPause(
    taskId: string,
    context: string,
  ): Promise<boolean> {
    const settings = await this.store.getSettings();
    if (!settings.globalPause) {
      return false;
    }

    this.clearCompletedTaskWatchdog(taskId);
    executorLog.log(`${taskId}: completion handoff deferred — global pause active (${context})`);
    await this.store.logEntry(
      taskId,
      `Completion handoff deferred — global pause active (${context})`,
      undefined,
      this.getRunContextFor(taskId),
    ).catch(() => undefined);
    return true;
  }

  private async shouldDeferWorkflowStepCompletion(
    taskId: string,
    context: string,
  ): Promise<boolean> {
    let latestTask: Task | null = null;
    try {
      latestTask = await this.store.getTask(taskId);
    } catch {
      latestTask = null;
    }

    if (latestTask?.paused || this.pausedAborted.has(taskId)) {
      this.clearCompletedTaskWatchdog(taskId);
      executorLog.log(`${taskId}: completion handoff deferred — task paused (${context})`);
      await this.store.logEntry(
        taskId,
        `Completion handoff deferred — task paused (${context})`,
        undefined,
        this.getRunContextFor(taskId),
      ).catch(() => undefined);
      return true;
    }

    if ((latestTask && latestTask.column !== "in-progress") || this.userCanceledTaskIds.has(taskId)) {
      this.clearCompletedTaskWatchdog(taskId);
      executorLog.log(`${taskId}: completion handoff deferred — task no longer active (${context})`);
      await this.store.logEntry(
        taskId,
        `Completion handoff deferred — task no longer active (${context})`,
        undefined,
        this.getRunContextFor(taskId),
      ).catch(() => undefined);
      return true;
    }

    return this.shouldDeferCompletionForGlobalPause(taskId, context);
  }

  private async parkTaskAfterWorkflowStepPause(taskId: string): Promise<boolean> {
    let latestTask: Task | null = null;
    try {
      latestTask = await this.store.getTask(taskId);
    } catch {
      latestTask = null;
    }

    if (!latestTask?.paused) {
      return false;
    }

    executorLog.log(`${taskId}: workflow step interrupted by task pause — moving to todo`);
    await this.store.logEntry(
      taskId,
      "Execution paused during pre-merge workflow step — moved to todo",
      undefined,
      this.getRunContextFor(taskId),
    ).catch(() => undefined);
    // FN-5256: synchronously reap any spawned shells BEFORE moving the task so
    // a fast re-dispatch (task:moved → in-progress) doesn't race a live shell.
    // The task:moved (away) listener also tracks an awaited disposal as a
    // backstop, but doing it here keeps `parkTaskAfterWorkflowStepPause`'s
    // contract straightforward for its callers.
    await this.awaitAbortInFlightTaskWork(taskId, "pause-before-park").catch((err) => {
      executorLog.warn(`${taskId}: awaitAbortInFlightTaskWork failed in pause-before-park: ${err}`);
    });
    if (latestTask.column === "in-progress") {
      await this.store.moveTask(taskId, "todo", { preserveResumeState: true });
    }
    return true;
  }
  /** Child agent sessions keyed by agent ID. Used for termination. */
  private childSessions = new Map<string, AgentSession>();
  /** Total count of currently spawned agents (across all parents). */
  private totalSpawnedCount = 0;
  /** Token cap detector for proactive context compaction. */
  private tokenCapDetector = new TokenCapDetector();
  private _modelRegistry?: ModelRegistry;
  private _approvalRequestStore?: ApprovalRequestStore;
  /** Current run context for mutation correlation, keyed by task id. */
  private currentRunContexts = new Map<string, RunMutationContext>();

  private getRunContextFor(taskId: string): RunMutationContext | undefined {
    return this.currentRunContexts.get(taskId);
  }

  /**
   * Stable handoff reasons used on task:handoff audit events.
   * Keep values greppable for executor/self-healing forensics: review-handoff-requested,
   * completed-task-recovered, worktree-liveness-failed, step-session-completed,
   * step-session-failed, transient-retries-exhausted, paused-after-completion,
   * fn_task_done, fn_task_done-retry-completed, max-task-done-retries-exhausted,
   * execution-failed, implicit-fn_task_done-refused, invariant-check-failed,
   * fn_task_done-refused.
   */
  private async handoffTaskToReview(task: Task, reason: string, runId = this.getRunContextFor(task.id)?.runId): Promise<Task> {
    const agentId = this.getRunContextFor(task.id)?.agentId;
    const handedOff = await this.store.handoffToReview(task.id, {
      ownerAgentId: agentId ?? null,
      evidence: {
        reason,
        runId,
        agentId,
      },
    });

    const settings = await this.store.getSettings();
    if (isMergeRequestContractShadowEnabled(settings)) {
      this.store.setCompletionHandoffAcceptedMarker(task.id, {
        source: `executor:${reason}`,
      });
      this.store.upsertMergeRequestRecord(task.id, {
        state: handedOff.autoMerge === false ? "manual-required" : "queued",
      });
    }

    // Dual-observe parity (CU-U5): post-execute observation point. Flag-gated
    // and fully isolated — never affects the authoritative handoff result.
    await this.maybeObserveWorkflowParity(task.id, settings);

    return handedOff;
  }

  private get modelRegistry(): ModelRegistry {
    if (!this._modelRegistry) {
      const authStorage = createFusionAuthStorage();
      this._modelRegistry = ModelRegistry.create(authStorage, getModelRegistryModelsPath());
      this._modelRegistry.refresh();
    }
    return this._modelRegistry;
  }

  private get approvalRequestStore(): ApprovalRequestStore {
    if (!this._approvalRequestStore) {
      this._approvalRequestStore = new ApprovalRequestStore(this.store.getDatabase());
    }
    return this._approvalRequestStore;
  }

  private buildActionGateContext(taskId: string | undefined, agent: Agent | null | undefined, projectDefaultPolicy?: { rules?: Partial<import("@fusion/core").AgentPermissionPolicy["rules"]> }): AgentActionGateContext | undefined {
    if (!agent || isEphemeralAgent(agent)) {
      return undefined;
    }
    const policy = resolveEffectiveAgentPermissionPolicy(agent.permissionPolicy, projectDefaultPolicy);
    return {
      agentId: agent.id,
      agentName: agent.name,
      isEphemeral: false,
      taskId,
      runId: taskId ? this.getRunContextFor(taskId)?.runId : undefined,
      permissionPolicy: policy,
      createApprovalRequest: async (decision, args) => this.approvalRequestStore.create({
        requester: {
          actorId: agent.id,
          actorType: "agent",
          actorName: agent.name,
        },
        taskId,
        runId: taskId ? this.getRunContextFor(taskId)?.runId : undefined,
        targetAction: {
          category: decision.category === "exempt" ? "command_execution" : decision.category,
          action: decision.operation,
          summary: decision.summary,
          resourceType: decision.resourceType,
          resourceId: decision.resourceId ?? "",
          context: {
            ...decision.metadata,
            approvalDedupeKey: decision.approvalDedupeKey,
            toolName: decision.toolName,
            toolArgs: args,
          },
        },
      }),
      findApprovalByDedupeKey: async (dedupeKey) => {
        const latest = this.approvalRequestStore.findLatestByDedupeKey({ requesterActorId: agent.id, taskId, dedupeKey });
        return latest ? { id: latest.id, status: latest.status } : null;
      },
      findPendingApprovalByDedupeKey: async (dedupeKey) => {
        const latest = this.approvalRequestStore.findLatestByDedupeKey({ requesterActorId: agent.id, taskId, dedupeKey });
        return latest?.status === "pending" ? { id: latest.id } : null;
      },
      pauseForApproval: async ({ approvalRequestId, decision }) => {
        if (taskId) {
          await this.store.pauseTask(taskId, true, this.getRunContextFor(taskId), { pausedByAgentId: agent.id });
          await this.store.logEntry(
            taskId,
            `Approval required for ${decision.toolName}. Request ${approvalRequestId} created; task and agent paused awaiting decision.`,
            undefined,
            this.getRunContextFor(taskId),
          );
        }
        if (this.options.agentStore) {
          await this.options.agentStore.updateAgentState(agent.id, "paused");
          await this.options.agentStore.updateAgent(agent.id, { pauseReason: "awaiting-approval" });
        }
      },
      markApprovalCompleted: async (approvalRequestId) => {
        await this.approvalRequestStore.markCompleted(approvalRequestId, {
          actor: { actorId: agent.id, actorType: "agent", actorName: agent.name },
          note: "Tool executed after approval",
        });
      },
    };
  }

  private buildPermanentAgentGatingContext(taskId: string | undefined, agent: Agent | null | undefined, projectDefaultPolicy?: { rules?: Partial<import("@fusion/core").AgentPermissionPolicy["rules"]> }): import("@fusion/core").PermanentAgentGatingContext | undefined {
    if (!agent || isEphemeralAgent(agent)) {
      return undefined;
    }

    return {
      permissionPolicy: resolveEffectiveAgentPermissionPolicy(agent.permissionPolicy, projectDefaultPolicy),
      requester: {
        actorId: agent.id,
        actorType: "agent",
        actorName: agent.name,
      },
      taskId,
      runId: taskId ? this.getRunContextFor(taskId)?.runId : undefined,
      createApprovalRequest: async ({ category, toolName, args }) => this.approvalRequestStore.create({
        requester: {
          actorId: agent.id,
          actorType: "agent",
          actorName: agent.name,
        },
        taskId,
        runId: taskId ? this.getRunContextFor(taskId)?.runId : undefined,
        targetAction: {
          category,
          action: toolName,
          summary: `Permanent-agent gated action for ${toolName}`,
          resourceType: "tool",
          resourceId: toolName,
          context: {
            toolName,
            toolArgs: args,
            source: "permanent-agent-gating",
          },
        },
      }),
      findPendingApprovalRequest: async (dedupeKey) => {
        const pending = this.approvalRequestStore.list({ status: "pending", requesterActorId: agent.id, taskId, limit: 100 });
        return pending.find((request) => request.targetAction.context?.approvalDedupeKey === dedupeKey) ?? null;
      },
    };
  }

  /** Returns the set of task IDs currently being executed. */
  getExecutingTaskIds(): Set<string> {
    // Graph-routed tasks count as executing for their WHOLE interpreter run —
    // between seams the inner execute() has released this.executing, but the
    // graph still owns the lifecycle; self-healing/recovery must not touch it.
    return new Set([
      ...this.executing,
      ...this.recoveringCompleted,
      ...this.resumingUnpaused,
      ...TaskExecutor.processWideGraphRouting,
    ]);
  }

  isTaskActive(taskId: string): boolean {
    return (
      this.executing.has(taskId)
      || this.activeSessions.has(taskId)
      || this.recoveringCompleted.has(taskId)
      || TaskExecutor.processWideGraphRouting.has(taskId)
    );
  }

  isEphemeralDeletionPending(agentId: string): boolean {
    return this.pendingEphemeralDeletions.has(agentId);
  }

  disposeEphemeralTimers(): void {
    this.pendingEphemeralDeletions.clear();
  }

  private isBenignEphemeralDeleteRaceError(agentId: string, err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    if (lower.includes("not found") || lower.includes("already deleted") || lower.includes("does not exist")) {
      executorLog.log(`Skip spawned-agent cleanup for ${agentId}: already deleted by another pathway`);
      return true;
    }
    return false;
  }

  /**
   * Abort the in-flight bash subprocess (if any) on every active agent session.
   *
   * Invoked at runtime shutdown so detached subprocess trees spawned by agent
   * bash tools — including grandchildren like vitest workers — are killed via
   * pi-coding-agent's killProcessTree. Without this, when the worker is killed
   * those process groups are orphaned because they're detached.
   *
   * Sessions are not disposed here so any near-complete agent loop still has a
   * chance to wrap up during the runtime's graceful drain window.
   */

  /**
   * Register a subagent session (e.g. reviewer) under its parent task ID so it
   * can be disposed when the parent stops. Used as the `onSessionCreated`
   * callback passed to `reviewStep`.
   */
  private registerSubagentSession(taskId: string, session: AgentSession): void {
    let set = this.activeSubagentSessions.get(taskId);
    if (!set) {
      set = new Set();
      this.activeSubagentSessions.set(taskId, set);
    }
    set.add(session);
  }

  /**
   * Deregister a subagent session that has finished naturally. The reviewer's
   * own `finally` block disposes the session — this just removes it from the
   * map.
   */
  private unregisterSubagentSession(taskId: string, session: AgentSession): void {
    const set = this.activeSubagentSessions.get(taskId);
    if (!set) return;
    set.delete(session);
    if (set.size === 0) this.activeSubagentSessions.delete(taskId);
  }

  /**
   * Dispose all subagent sessions for a task and remove them from the map.
   * Called by the kill paths (move-out-of-in-progress, pause, global pause)
   * so subagents stop alongside the main session.
   */
  private disposeSubagentsForTask(taskId: string, reason: string): void {
    const set = this.activeSubagentSessions.get(taskId);
    if (!set || set.size === 0) return;
    executorLog.log(`${taskId}: disposing ${set.size} subagent session(s) — ${reason}`);
    for (const session of set) {
      try {
        session.dispose();
      } catch (err) {
        executorLog.warn(`${taskId}: failed to dispose subagent session: ${err}`);
      }
    }
    this.activeSubagentSessions.delete(taskId);
  }

  /**
   * FN-5256: register an in-flight disposal so a subsequent dispatch (task:moved
   * → in-progress) can await it before acquiring/creating a worktree. Swallows
   * errors so a failed disposal doesn't poison the map; surfaces them via the
   * executor log instead.
   */
  private trackTaskDisposal(taskId: string, disposal: Promise<void>): void {
    const wrapped = disposal
      .catch((err) => {
        executorLog.warn(`${taskId}: tracked disposal failed: ${err}`);
      })
      .finally(() => {
        if (this.pendingTaskDisposals.get(taskId) === wrapped) {
          this.pendingTaskDisposals.delete(taskId);
        }
      });
    this.pendingTaskDisposals.set(taskId, wrapped);
  }

  /**
   * FN-5256: synchronously await session disposal so callers (e.g. pause-before-park)
   * can rely on the worktree-bound shells being reaped before they return. Mirrors
   * `abortInFlightTaskWork`, but awaits the async `abort()` / `terminateAllSessions()`
   * calls instead of fire-and-forget.
   */
  async awaitAbortInFlightTaskWork(taskId: string, reason: string, options: { userCanceled?: boolean } = {}): Promise<void> {
    let hadActiveSurface = false;

    if (options.userCanceled) {
      this.userCanceledTaskIds.add(taskId);
    }
    this.pausedAborted.add(taskId);
    this.options.stuckTaskDetector?.untrackTask(taskId);
    this.clearWorkflowRerunWatchdog(taskId);
    this.clearCompletedTaskWatchdog(taskId);
    // Defensive graph-interpreter cleanup: a pause/abort mid-graph must not
    // leave a stale completion interceptor or routing claim behind. The graph
    // runner's own finally blocks also clear these; double-delete is harmless.
    this.graphCompletionInterceptors.delete(taskId);
    TaskExecutor.processWideGraphRouting.delete(taskId);

    // FN-5256: claim each surface synchronously BEFORE awaiting any async
    // abort. Without this, two concurrent disposal calls for the same task
    // (e.g., task:moved-away followed immediately by task:deleted) both pass
    // the `has(taskId)` guards and double-call abort/dispose.
    const claimedSession = this.activeSessions.get(taskId);
    if (claimedSession) {
      hadActiveSurface = true;
      this.deleteActiveSession(taskId);
    }
    const claimedStepExecutor = this.activeStepExecutors.get(taskId);
    if (claimedStepExecutor) {
      hadActiveSurface = true;
      this.deleteActiveStepExecutor(taskId);
    }
    const claimedWorkflowSession = this.activeWorkflowStepSessions.get(taskId);
    if (claimedWorkflowSession) {
      hadActiveSurface = true;
      this.deleteActiveWorkflowStepSession(taskId);
    }
    const claimedConfiguredCommands = this.activeConfiguredCommandControllers.get(taskId);
    if (claimedConfiguredCommands && claimedConfiguredCommands.size > 0) {
      hadActiveSurface = true;
      this.activeConfiguredCommandControllers.delete(taskId);
      for (const controller of claimedConfiguredCommands) {
        controller.abort();
      }
    }
    const claimedSubagents = this.activeSubagentSessions.has(taskId);
    if (claimedSubagents) {
      hadActiveSurface = true;
      this.disposeSubagentsForTask(taskId, reason);
    }
    // CLI Agent Executor (U7): a cli-agent session is a hard-cancel surface like
    // any API session. Claim it synchronously, then SIGKILL the PTY and mark
    // `killed` (never resume-eligible) — the same dispose/abort contract API
    // sessions honor. moveTask(in-progress→todo) routes here (AGENTS.md hard
    // cancel), so this is what guarantees the PTY tree is reaped on column exit.
    const claimedCliSession = this.activeCliTaskSessions.get(taskId);
    if (claimedCliSession) {
      hadActiveSurface = true;
      this.activeCliTaskSessions.delete(taskId);
    }

    if (claimedSession) {
      const { session } = claimedSession;
      const sessionWithAbort = session as AgentSession & { abort?: () => Promise<void> };
      if (typeof sessionWithAbort.abort === "function") {
        await sessionWithAbort.abort().catch((err) => {
          executorLog.warn(`Failed to abort agent session for ${taskId}: ${err}`);
        });
      }
      try {
        session.dispose();
      } catch (err) {
        executorLog.warn(`Failed to dispose agent session for ${taskId}: ${err}`);
      }
    }

    if (claimedStepExecutor) {
      const stepExecutorWithAbort = claimedStepExecutor as StepSessionExecutor & { abortAllSessionBash?: () => void };
      if (typeof stepExecutorWithAbort.abortAllSessionBash === "function") {
        try {
          stepExecutorWithAbort.abortAllSessionBash();
        } catch (err) {
          executorLog.warn(`Failed to abort step-session bash for ${taskId}: ${err}`);
        }
      }
      await claimedStepExecutor.terminateAllSessions().catch((err) =>
        executorLog.error(`Failed to terminate step sessions for ${taskId}:`, err),
      );
    }

    if (claimedWorkflowSession) {
      const sessionWithAbort = claimedWorkflowSession as AgentSession & { abort?: () => Promise<void> };
      if (typeof sessionWithAbort.abort === "function") {
        await sessionWithAbort.abort().catch((err) => {
          executorLog.warn(`Failed to abort workflow step session for ${taskId}: ${err}`);
        });
      }
      try {
        claimedWorkflowSession.dispose();
      } catch (err) {
        executorLog.warn(`Failed to dispose workflow step session for ${taskId}: ${err}`);
      }
    }

    if (claimedCliSession) {
      await claimedCliSession.kill("killed").catch((err) => {
        executorLog.warn(`Failed to kill CLI agent session for ${taskId}: ${err}`);
      });
    }

    this.loopRecoveryState.delete(taskId);
    this.spawnedAgents.delete(taskId);
    this.stuckAborted.delete(taskId);

    if (hadActiveSurface) {
      executorLog.log(`${taskId}: awaited abort of in-flight work — ${reason}`);
    }
  }

  async abortAllInFlight(reason: string): Promise<void> {
    const taskIds = new Set<string>([
      ...this.activeSessions.keys(),
      ...this.activeStepExecutors.keys(),
      ...this.activeWorkflowStepSessions.keys(),
      ...this.activeConfiguredCommandControllers.keys(),
      ...this.activeSubagentSessions.keys(),
      ...this.activeCliTaskSessions.keys(),
    ]);

    for (const taskId of taskIds) {
      try {
        await this.awaitAbortInFlightTaskWork(taskId, reason);
      } catch (err) {
        executorLog.warn(`abortAllInFlight: failed to abort task ${taskId} — ${reason}: ${err}`);
      }
    }

    for (const [agentId, session] of this.childSessions) {
      try {
        const sessionWithAbort = session as AgentSession & { abort?: () => Promise<void> };
        if (typeof sessionWithAbort.abort === "function") {
          await sessionWithAbort.abort();
        }
      } catch (err) {
        executorLog.warn(`abortAllInFlight: failed to abort child session ${agentId} — ${reason}: ${err}`);
      }

      try {
        session.dispose();
      } catch (err) {
        executorLog.warn(`abortAllInFlight: failed to dispose child session ${agentId} — ${reason}: ${err}`);
      }
    }
    this.childSessions.clear();

    executorLog.log(`abortAllInFlight: aborted ${taskIds.size} task surface(s) — ${reason}`);
  }

  abortAllSessionBash(): void {
    for (const [taskId, { session }] of this.activeSessions) {
      try {
        session.abortBash();
      } catch (err) {
        executorLog.warn(`abortAllSessionBash: failed for task ${taskId}: ${err}`);
      }
    }
    for (const [agentId, session] of this.childSessions) {
      try {
        session.abortBash();
      } catch (err) {
        executorLog.warn(`abortAllSessionBash: failed for child agent ${agentId}: ${err}`);
      }
    }
    for (const [taskId, stepExecutor] of this.activeStepExecutors) {
      try {
        stepExecutor.abortAllSessionBash();
      } catch (err) {
        executorLog.warn(`abortAllSessionBash: failed for step executor ${taskId}: ${err}`);
      }
    }
  }

  /**
   * @param store — Task store instance (also used to listen for events)
   * @param rootDir — Project root directory
   * @param options — Executor configuration
   *
   * Listens for `task:moved` to auto-execute tasks moved to `in-progress`,
   * `task:updated` to terminate agent sessions when individual tasks are paused,
   * and `settings:updated` to terminate **all** active agent sessions when
   * `globalPause` transitions from `false` to `true`. `enginePaused` only
   * prevents new work dispatch — running sessions continue to completion.
   * Paused tasks are moved back to `todo` rather than marked as `failed`.
   */
  constructor(
    private store: TaskStore,
    private rootDir: string,
    private options: TaskExecutorOptions = {},
  ) {
    executorLog.log(`TaskExecutor constructed (rootDir=${rootDir}, hasSemaphore=${!!options.semaphore}, hasStuckDetector=${!!options.stuckTaskDetector})`);

    store.on("task:moved", ({ task, from, to, source }) => {
      executorLog.log(`[event:task:moved] ${task.id}: ${from} → ${to}`);
      if (to === "in-progress") {
        this.userCanceledTaskIds.delete(task.id);
        if (this.recoveringCompleted.has(task.id)) {
          executorLog.log(`[event:task:moved] Skipping execute() for ${task.id} — completed-task recovery in progress`);
          return;
        }
        this.clearWorkflowRerunWatchdog(task.id);
        executorLog.log(`[event:task:moved] Initiating execute() for ${task.id}`);
        void (async () => {
          // FN-5256: if the prior session is still being torn down (because the
          // task was just moved away from in-progress), wait for the worktree-
          // bound shells to reap before we acquire/create a new worktree. Without
          // this, a fast bounce (in-progress → todo → in-progress) races the
          // executor's own conflict cleanup against a still-live shell.
          const pending = this.pendingTaskDisposals.get(task.id);
          if (pending) {
            executorLog.log(`[event:task:moved] Awaiting pending disposal for ${task.id} before dispatch`);
            await pending;
          }
          const taskForExecution = await this.resetMergeStateIfNeeded(task, from);
          await this.execute(taskForExecution);
        })().catch((err) =>
          executorLog.error(`Failed to start ${task.id}:`, err),
        );
      } else if (from === "in-progress") {
        this.trackTaskDisposal(
          task.id,
          this.awaitAbortInFlightTaskWork(task.id, `parent moved from in-progress to ${to}`, {
            userCanceled: source === "user" && to === "todo",
          }),
        );
      }
    });

    store.on("task:deleted", (task) => {
      this.trackTaskDisposal(
        task.id,
        this.awaitAbortInFlightTaskWork(task.id, "task soft-deleted", { userCanceled: true }),
      );
    });

    // When a task is paused while executing, terminate the agent session.
    // When steering comments are added during execution, inject them into the running session.
    //
    // Real-time steering comment injection mechanism:
    // 1. When execution starts, we initialize seenSteeringIds with all existing comment IDs
    // 2. On each task:updated event, we check if there are new comments not in seenSteeringIds
    // 3. New comments are injected via session.steer() which queues them for delivery
    //    after the current assistant turn completes (before the next LLM call)
    // 4. Comments are marked as seen BEFORE injection to prevent retry loops on failure
    // 5. Each injection is logged to the task for user visibility
    store.on("task:updated", async (task) => {
      try {
        // FN-5256: handle pause by synchronously reaping every active session
        // surface in one shot. Awaiting the abort ensures spawned shells are
        // disposed before any re-dispatch can race the worktree.
        if (
          task.paused
          && (
            this.activeSessions.has(task.id)
            || this.activeStepExecutors.has(task.id)
            || this.activeWorkflowStepSessions.has(task.id)
            || this.activeConfiguredCommandControllers.has(task.id)
          )
        ) {
          executorLog.log(`Pausing ${task.id} — awaiting in-flight session disposal`);
          await this.awaitAbortInFlightTaskWork(task.id, "task paused");
          return;
        }

        // Handle unpause of an in-progress task with no active session.
        // This covers orphaned states (e.g., engine restarted while task was
        // paused in-progress) where the task needs to resume execution.
        // The executing/resuming guards prevent duplicate runs.
        if (
          !task.paused
          && task.column === "in-progress"
          && !this.activeSessions.has(task.id)
          && !this.activeStepExecutors.has(task.id)
          && !this.activeWorkflowStepSessions.has(task.id)
        ) {
          if (
            !this.executing.has(task.id)
            && !this.resumingUnpaused.has(task.id)
            && !this.recoveringCompleted.has(task.id)
          ) {
            const pauseLabel = await this.getExecutionPauseLabel();
            if (pauseLabel) {
              executorLog.log(`Skipping unpause resume for ${task.id} — ${pauseLabel} active`);
              return;
            }

            if (this.isTaskWorkComplete(task) && !task.mergeDetails) {
              this.recoveringCompleted.add(task.id);
              executorLog.log(`${task.id} unpaused with completed work and no session — recovering directly to in-review`);
              void this.recoverCompletedTask(task)
                .catch((err) =>
                  executorLog.error(`Failed to recover completed unpaused task ${task.id}:`, err),
                )
                .finally(() => {
                  this.recoveringCompleted.delete(task.id);
                });
              return;
            }

            this.resumingUnpaused.add(task.id);
            executorLog.log(`Unpaused ${task.id} in-progress with no session — resuming execution`);
            try {
              await this.clearResumeFailureState(task);
              await this.store.updateTask(task.id, {
                resumeLimboCount: 0,
                resumeLimboTipSha: null,
                resumeLimboStepSignature: null,
              });
              await this.store.logEntry(task.id, "Resuming execution after unpause", undefined, this.getRunContextFor(task.id));
              await this.recoverApprovedStepsOnResume(task.id);
            } catch (clearErr) {
              executorLog.warn(`${task.id} clearResumeFailureState failed during unpause: ${clearErr instanceof Error ? clearErr.message : String(clearErr)}`);
            }
            this.execute(task)
              .catch((err) =>
                executorLog.error(`Failed to resume unpaused ${task.id}:`, err),
              )
              .finally(() => {
                this.resumingUnpaused.delete(task.id);
              });
          }
          return;
        }

        // Column-agent restart-invalidation (plan U5, R7/KTD-4). A workflow-
        // definition edit (re-pointing a column's agent) or an agent runtimeConfig
        // change mutates NOTHING the task-field diff below observes — the watcher
        // would never see it. KTD-4's primary mechanism is event-driven invalidation,
        // but no `workflow:updated`/`agent:updated` store event exists on TaskStore
        // today (only task:/settings: events). Per the unit's documented fallback, we
        // re-resolve the column-effective agent/model on each `task:updated` tick for
        // GRAPH-MODE active entries ONLY (those whose session adopted a column agent —
        // `lastEffectiveColumnAgentId != null`). This is bounded by the active session
        // count, and only graph runs with a real column binding pay any cost. The
        // weaker guarantee (vs an arbitrary-time diff) is that a stale session
        // restarts on the next tick, not instantly — acceptable per the Risks note.
        //
        // agent-DELETED → fall back per R8 (no restart; the running session finishes
        // on its current model). agent-CHANGED (different effective agent OR same
        // agent with a new runtimeConfig model) → hot-swap, same path as a
        // task.modelProvider change.
        if (
          this.activeSessions.has(task.id)
          && !task.paused
          && (this.activeSessions.get(task.id)!.lastEffectiveColumnAgentId ?? null) !== null
          && this.graphSeamGoverningNodeId.has(task.id)
          && this.graphColumnAgentResolver.has(task.id)
        ) {
          const activeEntry = this.activeSessions.get(task.id)!;
          const governingNodeId = this.graphSeamGoverningNodeId.get(task.id)!;
          const resolveBinding = this.graphColumnAgentResolver.get(task.id)!;
          const binding = resolveBinding(governingNodeId);
          const effective = binding
            ? resolveEffectiveAgent({ binding, ...this.extractOwnSettings(task) })
            : undefined;
          if (!effective || effective.source !== "column-agent") {
            // Binding RELEASED (PR #1432 review): a workflow edit removed the
            // binding, or `defer` now resolves to the task's own settings. Hand the
            // session back to normal resolution: hot-swap to the assigned/task
            // model (the same resolution the legacy block below owns), clear the
            // column-agent tracking, and release the reverse heartbeat guard so
            // isAgentEffectivelyExecuting() stops blocking the OLD agent.
            executorLog.log(`${task.id}: column-agent binding released — reverting session to own-settings resolution`);
            activeEntry.lastEffectiveColumnAgentId = null;
            this.effectiveColumnAgentByTask.delete(task.id);
            // Fire-and-forget audit (matches the deletion-fallback posture above).
            this.store.logEntry(
              task.id,
              "Column-agent binding released — session reverts to its own model/agent resolution",
              undefined,
              this.getRunContextFor(task.id),
            ).catch((err: unknown) => executorLog.warn(`${task.id}: failed to log column-agent release: ${err instanceof Error ? err.message : String(err)}`));
            const settings = await this.store.getSettings();
            const assignedRuntimeConfig = await this.getAssignedAgentRuntimeConfig(task.assignedAgentId);
            const { provider: ownProvider, modelId: ownModelId } = resolveExecutorSessionModel(
              task.modelProvider,
              task.modelId,
              settings,
              assignedRuntimeConfig,
            );
            const providerChanged = ownProvider !== activeEntry.lastResolvedModelProvider;
            const modelIdChanged = ownModelId !== activeEntry.lastResolvedModelId;
            if ((providerChanged || modelIdChanged) && ownProvider && ownModelId) {
              activeEntry.lastResolvedModelProvider = ownProvider;
              activeEntry.lastResolvedModelId = ownModelId;
              try {
                const model = this.modelRegistry.find(ownProvider, ownModelId);
                if (model) {
                  await activeEntry.session.setModel(model);
                  executorLog.log(`${task.id}: binding released — model reverted to ${ownProvider}/${ownModelId}`);
                }
              } catch (err: unknown) {
                executorLog.error(`${task.id}: failed to revert model after binding release: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          } else {
            {
              // Fetch the (possibly changed) effective column agent, best-effort.
              const newAgent = await this.options.agentStore?.getAgent(effective.agentId).catch(() => null) ?? null;
              if (!newAgent) {
                // agent-DELETED (R8): fall back, NO restart. The running session
                // keeps its current model; the NEXT resolution falls back. Update the
                // tracked id so we stop probing for the missing agent every tick.
                if (activeEntry.lastEffectiveColumnAgentId !== null) {
                  executorLog.log(`${task.id}: column agent '${effective.agentId}' deleted mid-session — falling back, no restart (R8)`);
                  // Fire-and-forget audit (matches the rework-log posture at ~3582):
                  // a logEntry failure must not abort this task:updated tick and skip
                  // the model-change detection below.
                  this.store.logEntry(
                    task.id,
                    `Column agent '${effective.agentId}' deleted mid-session — falling back to current model, no restart (R8)`,
                    undefined,
                    this.getRunContextFor(task.id),
                  ).catch((err: unknown) => executorLog.warn(`${task.id}: failed to log column-agent deletion fallback: ${err instanceof Error ? err.message : String(err)}`));
                  activeEntry.lastEffectiveColumnAgentId = null;
                  // Release the reverse heartbeat guard for the deleted agent
                  // (PR #1432 review): isAgentEffectivelyExecuting() must not keep
                  // blocking an agent that no longer governs this session.
                  this.effectiveColumnAgentByTask.delete(task.id);
                }
              } else {
                const settings = await this.store.getSettings();
                const { provider: newProvider, modelId: newModelId } = resolveExecutorSessionModel(
                  task.modelProvider,
                  task.modelId,
                  settings,
                  (newAgent.runtimeConfig ?? undefined) as Record<string, unknown> | undefined,
                );
                const agentChanged = (activeEntry.lastEffectiveColumnAgentId ?? null) !== newAgent.id;
                const providerChanged = newProvider !== activeEntry.lastResolvedModelProvider;
                const modelIdChanged = newModelId !== activeEntry.lastResolvedModelId;
                if (agentChanged || providerChanged || modelIdChanged) {
                  activeEntry.lastEffectiveColumnAgentId = newAgent.id;
                  // Re-key the reverse heartbeat guard to the NEW agent (PR #1432
                  // review): the old agent stops being blocked, the new one starts.
                  this.effectiveColumnAgentByTask.set(task.id, newAgent.id);
                  activeEntry.lastResolvedModelProvider = newProvider;
                  activeEntry.lastResolvedModelId = newModelId;
                  if (newProvider && newModelId) {
                    try {
                      const model = this.modelRegistry.find(newProvider, newModelId);
                      if (model) {
                        await activeEntry.session.setModel(model);
                        executorLog.log(`${task.id}: column-agent hot-swap → agent '${newAgent.id}' model ${newProvider}/${newModelId}`);
                        await this.store.logEntry(task.id, `Column agent changed — model now ${newProvider}/${newModelId} (agent ${newAgent.id})`, undefined, this.getRunContextFor(task.id));
                      } else {
                        executorLog.log(`${task.id}: column-agent model ${newProvider}/${newModelId} not found in registry for hot-swap`);
                      }
                    } catch (err: unknown) {
                      const errorMessage = err instanceof Error ? err.message : String(err);
                      executorLog.error(`${task.id}: failed to column-agent hot-swap: ${errorMessage}`);
                      // Fire-and-forget audit (see ~3582): a logEntry failure here must
                      // not abort the tick and skip later model-change detection.
                      this.store.logEntry(task.id, `Column-agent change failed: ${errorMessage}`, undefined, this.getRunContextFor(task.id))
                        .catch((logErr: unknown) => executorLog.warn(`${task.id}: failed to log column-agent change failure: ${logErr instanceof Error ? logErr.message : String(logErr)}`));
                    }
                  }
                }
              }
            }
          }
        }

        // Handle executor model hot-swap on active single-session executions
        if (this.activeSessions.has(task.id) && !task.paused) {
          const activeEntry = this.activeSessions.get(task.id)!;
          // R3 guard: when an OVERRIDE column agent governs this running session, the
          // column-agent watcher block above OWNS the model (override supersedes the
          // task's own model/assigned-agent settings). The legacy task-model hot-swap
          // would otherwise resolve a model from task.assignedAgentId's runtimeConfig
          // and clobber the column agent's model on a mid-flight task edit. Skip it
          // entirely when override governs; defer-resolved-to-own-settings (or no
          // binding) keeps the legacy behavior identical.
          let overrideColumnGoverns = false;
          if ((activeEntry.lastEffectiveColumnAgentId ?? null) !== null) {
            const governingNodeId = this.graphSeamGoverningNodeId.get(task.id);
            const resolveBinding = this.graphColumnAgentResolver.get(task.id);
            if (governingNodeId && resolveBinding) {
              const binding = resolveBinding(governingNodeId);
              if (binding?.mode === "override") overrideColumnGoverns = true;
            }
          }

          const taskModelProviderChanged = task.modelProvider !== activeEntry.lastTaskModelProvider;
          const taskModelIdChanged = task.modelId !== activeEntry.lastTaskModelId;
          const assignedAgentChanged = (task.assignedAgentId ?? null) !== (activeEntry.lastAssignedAgentId ?? null);

          if (!overrideColumnGoverns && (taskModelProviderChanged || taskModelIdChanged || assignedAgentChanged)) {
            activeEntry.lastTaskModelProvider = task.modelProvider;
            activeEntry.lastTaskModelId = task.modelId;
            activeEntry.lastAssignedAgentId = task.assignedAgentId ?? null;

            const settings = await this.store.getSettings();
            const assignedRuntimeConfig = await this.getAssignedAgentRuntimeConfig(task.assignedAgentId);
            const { provider: newProvider, modelId: newModelId } = resolveExecutorSessionModel(
              task.modelProvider,
              task.modelId,
              settings,
              assignedRuntimeConfig,
            );

            const providerChanged = newProvider !== activeEntry.lastResolvedModelProvider;
            const modelIdChanged = newModelId !== activeEntry.lastResolvedModelId;
            if (!providerChanged && !modelIdChanged) {
              return;
            }
            activeEntry.lastResolvedModelProvider = newProvider;
            activeEntry.lastResolvedModelId = newModelId;

            if (newProvider && newModelId) {
              try {
                const model = this.modelRegistry.find(newProvider, newModelId);
                if (model) {
                  await activeEntry.session.setModel(model);
                  executorLog.log(`${task.id}: executor model hot-swapped to ${newProvider}/${newModelId}`);
                  await this.store.logEntry(task.id, `Model changed to ${newProvider}/${newModelId}`, undefined, this.getRunContextFor(task.id));
                } else {
                  executorLog.log(`${task.id}: model ${newProvider}/${newModelId} not found in registry for hot-swap`);
                }
              } catch (err: unknown) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                executorLog.error(`${task.id}: failed to hot-swap model: ${errorMessage}`);
                await this.store.logEntry(task.id, `Model change failed: ${errorMessage}`, undefined, this.getRunContextFor(task.id));
              }
            }
          }
        }

        // Handle steering comments - inject new ones into the running session
        // Only process if session is active (activeSessions check is sufficient
        // since entries are only added when a task is in-progress)
        if (this.activeSessions.has(task.id) && task.steeringComments) {
          const activeSession = this.activeSessions.get(task.id)!;
          const { session, seenSteeringIds } = activeSession;

          // Find new steering comments that haven't been seen yet
          const newComments = task.steeringComments.filter(c => !seenSteeringIds.has(c.id));

          if (newComments.length > 0) {
            for (const comment of newComments) {
              const summary = comment.text.length > 80
                ? comment.text.slice(0, 80) + "..."
                : comment.text;

              // Mark as seen BEFORE attempting injection to prevent retry loops on failure
              seenSteeringIds.add(comment.id);

              // Format and inject the comment
              const commentMessage = formatCommentForInjection(comment);
              try {
                executorLog.log(`Injecting comment into ${task.id}: ${summary}`);
                await session.steer(commentMessage);
                executorLog.log(`Successfully injected comment into ${task.id}`);

                // Log to the task that comment was received
                await this.store.logEntry(
                  task.id,
                  `Comment received mid-execution: ${summary}`,
                  `by ${comment.author}`
                );
              } catch (err) {
                executorLog.error(`Failed to inject comment for ${task.id}:`, err);
                // Comment is already marked as seen - we won't retry to avoid spamming
                // the agent with failed injections. The error is logged for debugging.
              }
            }

            // After injecting comments, check for review handoff intent
            // Only detect handoff in agent-authored comments when policy is enabled.
            // Merge per-task effective workflow settings (U3, KTD-3) so
            // reviewHandoffPolicy resolves from the workflow. Behavior-inert by default.
            const settings = await mergeEffectiveSettings(this.store, task, await this.store.getSettings());
            if (settings.reviewHandoffPolicy === "comment-triggered") {
              const agentComments = newComments.filter(c => c.author !== "user");
              for (const comment of agentComments) {
                if (detectReviewHandoffIntent(comment.text)) {
                  executorLog.log(`Review handoff detected in ${task.id}: ${comment.text.slice(0, 50)}...`);
                  await this.executeReviewHandoff(task, session, activeSession);
                  return; // Exit early - handoff handles session disposal
                }
              }
            }
          }
        }
      } catch (err) {
        executorLog.error("Uncaught error in task:updated listener:", err);
      }
    });

    // When globalPause transitions from false → true, terminate all active agent sessions.
    store.on("settings:updated", ({ settings, previous }) => {
      if (settings.globalPause && !previous.globalPause) {
        for (const [taskId, controllers] of this.activeConfiguredCommandControllers) {
          executorLog.log(`Global pause — aborting configured command(s) for ${taskId}`);
          this.pausedAborted.add(taskId);
          this.options.stuckTaskDetector?.untrackTask(taskId);
          for (const controller of controllers) {
            controller.abort();
          }
          this.activeConfiguredCommandControllers.delete(taskId);
          this.loopRecoveryState.delete(taskId);
          this.spawnedAgents.delete(taskId);
          this.stuckAborted.delete(taskId);
        }
        // Dispose every reviewer subagent across every task. The per-task loops
        // below handle main + step sessions; reviewers live in their own map
        // and would otherwise outlive the global pause.
        for (const taskId of [...this.activeSubagentSessions.keys()]) {
          this.disposeSubagentsForTask(taskId, "global pause");
        }
        for (const [taskId, { session }] of this.activeSessions) {
          executorLog.log(`Global pause — terminating agent session for ${taskId}`);
          this.pausedAborted.add(taskId);
          this.options.stuckTaskDetector?.untrackTask(taskId);
          // abort() interrupts any in-flight LLM stream / tool call;
          // dispose() then releases session resources.
          const sessionWithAbort = session as unknown as { abort?: () => Promise<void> };
          if (typeof sessionWithAbort.abort === "function") {
            void sessionWithAbort.abort().catch((err) => {
              executorLog.warn(`Failed to abort agent session for ${taskId}: ${err}`);
            });
          }
          session.dispose();
          // Clean up all in-memory state so nothing leaks when tasks are later unpaused
          this.loopRecoveryState.delete(taskId);
          this.spawnedAgents.delete(taskId);
          this.stuckAborted.delete(taskId);
        }
        for (const [taskId, stepExecutor] of this.activeStepExecutors) {
          executorLog.log(`Global pause — terminating step sessions for ${taskId}`);
          this.pausedAborted.add(taskId);
          this.options.stuckTaskDetector?.untrackTask(taskId);
          stepExecutor.terminateAllSessions().catch(err =>
            executorLog.warn(`Failed to terminate step sessions for global pause ${taskId}: ${err}`)
          );
          // Clean up all in-memory state so nothing leaks when tasks are later unpaused
          this.loopRecoveryState.delete(taskId);
          this.spawnedAgents.delete(taskId);
          this.stuckAborted.delete(taskId);
        }
        for (const [taskId, workflowSession] of this.activeWorkflowStepSessions) {
          executorLog.log(`Global pause — terminating workflow step session for ${taskId}`);
          this.pausedAborted.add(taskId);
          this.options.stuckTaskDetector?.untrackTask(taskId);
          const sessionWithAbort = workflowSession as AgentSession & { abort?: () => Promise<void> };
          if (typeof sessionWithAbort.abort === "function") {
            void sessionWithAbort.abort().catch((err) => {
              executorLog.warn(`Failed to abort workflow step session for ${taskId}: ${err}`);
            });
          }
          workflowSession.dispose();
          this.deleteActiveWorkflowStepSession(taskId);
          this.loopRecoveryState.delete(taskId);
          this.spawnedAgents.delete(taskId);
          this.stuckAborted.delete(taskId);
        }
      }
    });

  }

  /**
   * Check whether a task's work is complete — all steps are done or skipped.
   * Used to detect tasks that called fn_task_done() but never transitioned to in-review
   * (e.g., killed by stuck detector after fn_task_done but before moveTask).
   */
  private isTaskWorkComplete(task: Task): boolean {
    if (task.steps.length === 0) return false;
    return task.steps.every((s) => s.status === "done" || s.status === "skipped");
  }

  private async resetMergeStateIfNeeded(task: Task, from: Task["column"]): Promise<Task> {
    if (from !== "in-review" && from !== "done") {
      return task;
    }

    const hasMergeEvidence = Boolean(task.mergeDetails)
      || (task.mergeRetries ?? 0) > 0
      || (task.verificationFailureCount ?? 0) > 0
      || task.status === "merging"
      || task.status === "merging-pr"
      || task.status === "merging-fix";

    if (!hasMergeEvidence) {
      return task;
    }

    return this.cleanupMergeStateForReverification(
      task,
      `Task returned to in-progress from ${from} column — resetting verification steps and merge state for re-verification`,
      {
        // Keep deterministic merge-verification bounce budget across remediation
        // cycles. Status may be cleared by intermediate paths, so the counter is
        // the canonical signal once a bounce has started.
        preserveVerificationFailureCount: (task.verificationFailureCount ?? 0) > 0,
      },
    );
  }

  private async cleanupMergeStateForReverification(
    task: Task,
    logMessage: string,
    options?: { preserveVerificationFailureCount?: boolean },
  ): Promise<Task> {
    await this.store.updateTask(task.id, {
      mergeDetails: null,
      mergeRetries: 0,
      verificationFailureCount: options?.preserveVerificationFailureCount ? task.verificationFailureCount ?? 0 : 0,
      workflowStepResults: [],
    });

    const refreshedTask = await this.store.getTask(task.id);
    const steps = refreshedTask.steps ?? [];
    if (steps.length > 0) {
      const allStepsComplete = this.isTaskWorkComplete(refreshedTask);
      if (allStepsComplete) {
        await this.reopenLastStepForRevision(task.id, refreshedTask);
      } else {
        const resetIndexes = new Set<number>();
        for (let i = 0; i < steps.length; i++) {
          const name = steps[i].name.toLowerCase();
          if (/testing|verification/.test(name) || /documentation|delivery/.test(name)) {
            resetIndexes.add(i);
          }
        }

        if (resetIndexes.size === 0) {
          const reopened = await this.reopenLastStepForRevision(task.id, refreshedTask);
          if (reopened) {
            resetIndexes.add(reopened.index);
          }
        } else {
          for (const index of resetIndexes) {
            if (steps[index].status !== "pending") {
              await this.store.updateStep(task.id, index, "pending");
            }
          }
          const earliestIndex = Math.min(...Array.from(resetIndexes));
          await this.store.updateTask(task.id, { currentStep: earliestIndex });
        }
      }
    }

    await this.store.logEntry(task.id, logMessage, undefined, this.getRunContextFor(task.id));
    return this.store.getTask(task.id);
  }

  private isNoProgressNoTaskDoneFailure(task: Task): boolean {
    return task.status === "failed" &&
      task.error?.includes("without calling fn_task_done") === true &&
      task.steps.every((step) => step.status === "pending");
  }

  private async clearResumeFailureState(task: Task): Promise<void> {
    const updates: { status?: null; error?: null; blockedBy?: null } = {};
    if (task.status === "failed" || task.error) {
      updates.status = null;
      updates.error = null;
    }
    // Pre-dispatch gating state must not survive into a resumed in-progress run.
    // The scheduler sets status="queued" + blockedBy on dep/file-scope conflicts
    // (scheduler.ts:618, 660) and clears them on the todo→in-progress transition
    // (scheduler.ts:696). Resume paths (unpause, drift recovery, engine restart)
    // bypass that clear, so a task can end up actively executing while still
    // labeled "queued" in the UI.
    if (task.status === "queued") {
      updates.status = null;
    }
    if (task.blockedBy) {
      updates.blockedBy = null;
    }
    if (Object.keys(updates).length > 0) {
      await this.store.updateTask(task.id, updates);
    }
  }

  private clearCompletedTaskWatchdog(taskId: string): void {
    const handle = this.completedTaskWatchdogs.get(taskId);
    if (!handle) return;
    clearTimeout(handle);
    this.completedTaskWatchdogs.delete(taskId);
  }

  private clearWorkflowRerunWatchdog(taskId: string): void {
    const handle = this.workflowRerunWatchdogs.get(taskId);
    if (!handle) return;
    clearTimeout(handle);
    this.workflowRerunWatchdogs.delete(taskId);
  }

  private scheduleCompletedTaskWatchdog(taskId: string, trigger: string): void {
    this.clearCompletedTaskWatchdog(taskId);

    const handle = setTimeout(async () => {
      this.completedTaskWatchdogs.delete(taskId);

      // Claim recovery slot atomically (synchronously) before any async work.
      // Without this, two paths can pass the in-flight guards on the same
      // event-loop turn and both call recoverCompletedTask() concurrently.
      if (
        this.recoveringCompleted.has(taskId)
        || this.executing.has(taskId)
        || this.activeSessions.has(taskId)
        || this.activeStepExecutors.has(taskId)
        || this.activeWorkflowStepSessions.has(taskId)
        || this.resumingUnpaused.has(taskId)
      ) {
        return;
      }
      this.recoveringCompleted.add(taskId);

      try {
        const pauseLabel = await this.getExecutionPauseLabel();
        if (pauseLabel) {
          return;
        }

        let currentTask: Task | null = null;
        try {
          currentTask = await this.store.getTask(taskId);
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          executorLog.warn(`${taskId}: completed-task watchdog could not read latest task state: ${errorMessage}`);
          return;
        }

        if (!currentTask || currentTask.column !== "in-progress" || currentTask.paused) {
          return;
        }
        if (!this.isTaskWorkComplete(currentTask)) {
          return;
        }

        executorLog.warn(
          `${taskId}: completed-task watchdog fired after ${COMPLETED_TASK_WATCHDOG_MS / 1000}s ` +
          `(${trigger}) — attempting direct recovery to in-review`,
        );
        await this.store.logEntry(
          taskId,
          `Watchdog: task remained in-progress ${COMPLETED_TASK_WATCHDOG_MS / 1000}s after ${trigger} — attempting direct recovery to in-review`,
        ).catch(() => undefined);

        const recovered = await this.recoverCompletedTask(currentTask);
        if (!recovered) {
          await this.store.logEntry(
            taskId,
            "Watchdog recovery attempt could not finalize completed task — leaving for follow-up recovery",
          ).catch(() => undefined);
        }
      } finally {
        this.recoveringCompleted.delete(taskId);
      }
    }, COMPLETED_TASK_WATCHDOG_MS);

    this.completedTaskWatchdogs.set(taskId, handle);
  }

  /**
   * Result of a workflow-rerun bounce attempt.
   *
   * - `bounced` — the move sequence completed successfully and the task is
   *   back in `in-progress` ready for re-execution.
   * - `skipped-pending` — another bounce for the same task is mid-flight;
   *   this attempt is a no-op. Callers (notably the watchdog) must NOT log
   *   this as a successful retry, since the original bounce may itself be
   *   stuck.
   */
  private async performWorkflowRerunBounce(
    taskId: string,
    worktreePath: string,
    preserveResumeState: boolean = true,
  ): Promise<"bounced" | "skipped-pending" | "deferred-paused"> {
    const pauseLabel = await this.getExecutionPauseLabel();
    if (pauseLabel) {
      executorLog.log(`${taskId}: workflow rerun deferred — ${pauseLabel} active`);
      return "deferred-paused";
    }

    // Re-entry guard: if a previous bounce for the same task is still
    // mid-flight (e.g., the watchdog fired before the original sequence
    // completed), skip rather than racing two concurrent moveTask sequences.
    if (this.workflowRerunPending.has(taskId)) {
      executorLog.warn(`${taskId}: workflow rerun bounce already in flight — skipping re-entry`);
      return "skipped-pending";
    }
    this.workflowRerunPending.add(taskId);
    try {
      // moveTask(in-progress → todo) clears `task.worktree`; restore it before
      // the return trip so the dashboard never renders the task under
      // "Unassigned" and self-healing can't reclaim the worktree as idle.
      const latestTask = await this.store.getTask(taskId);
      if (!latestTask) {
        throw new Error("task missing during workflow rerun bounce");
      }
      if (latestTask.paused) {
        executorLog.log(`${taskId}: workflow rerun deferred — task is paused`);
        return "deferred-paused";
      }

      if (latestTask.column === "in-progress") {
        const originalExecutionStartedAt = latestTask.executionStartedAt;
        // Preserve step progress across the in-progress → todo hop:
        // moveTask's default reopen-to-todo path resets every step to
        // pending and rewrites PROMPT.md checkboxes, which would discard
        // the partial progress this bounce is supposed to retry on top of.
        // `preserveWorktree` keeps the same checkout assigned across the
        // hop so listeners never observe an interim `worktree=null` state
        // — this bounce immediately re-promotes the task on the same
        // directory, so releasing it would publish a misleading snapshot
        // and could let self-healing reclaim the worktree as idle.
        if (preserveResumeState) {
          await this.store.moveTask(taskId, "todo", {
            preserveResumeState: true,
            preserveWorktree: true,
          });
        } else {
          await this.store.moveTask(taskId, "todo", { preserveWorktree: true });
        }
        // Restore worktree + executionStartedAt unconditionally to match
        // the original bounce contract: even with preserveWorktree the
        // worktree pointer could have been cleared by an in-flight
        // updateTask, and executionStartedAt is reset by moveTask when
        // preserveResumeState is false. Keep the writes so callers and
        // tests can observe the restoration deterministically.
        await this.store.updateTask(taskId, {
          worktree: worktreePath,
          executionStartedAt: originalExecutionStartedAt ?? null,
        });
        const pauseLabelAfterTodo = await this.getExecutionPauseLabel();
        if (pauseLabelAfterTodo) {
          executorLog.log(`${taskId}: workflow rerun parked in todo — ${pauseLabelAfterTodo} became active during bounce`);
          return "deferred-paused";
        }
        await this.store.moveTask(taskId, "in-progress");
        return "bounced";
      }

      if (latestTask.column === "todo") {
        await this.store.updateTask(taskId, { worktree: worktreePath });
        const pauseLabelBeforeResume = await this.getExecutionPauseLabel();
        if (pauseLabelBeforeResume) {
          executorLog.log(`${taskId}: workflow rerun parked in todo — ${pauseLabelBeforeResume} became active before resume`);
          return "deferred-paused";
        }
        await this.store.moveTask(taskId, "in-progress");
        return "bounced";
      }

      throw new Error(`task is in '${latestTask.column}', cannot bounce to in-progress`);
    } finally {
      this.workflowRerunPending.delete(taskId);
    }
  }

  private scheduleWorkflowRerun(
    taskId: string,
    worktreePath: string,
    successMessage: string,
    preserveResumeState: boolean = true,
  ): void {
    this.clearWorkflowRerunWatchdog(taskId);

    setTimeout(async () => {
      try {
        const outcome = await this.performWorkflowRerunBounce(taskId, worktreePath, preserveResumeState);
        if (outcome === "bounced") {
          executorLog.log(successMessage);
        } else if (outcome === "skipped-pending") {
          executorLog.warn(`${taskId}: rerun bounce skipped — another bounce already in flight`);
        } else {
          executorLog.log(`${taskId}: rerun bounce deferred while pause is active`);
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        executorLog.error(`${taskId}: failed to schedule rerun bounce: ${errorMessage}`);
      }
    }, 0);

    const watchdog = setTimeout(async () => {
      this.workflowRerunWatchdogs.delete(taskId);

      const pauseLabel = await this.getExecutionPauseLabel();
      if (pauseLabel) {
        executorLog.log(`${taskId}: workflow rerun watchdog skipped — ${pauseLabel} active`);
        return;
      }

      let currentTask: Task | null = null;
      try {
        currentTask = await this.store.getTask(taskId);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        executorLog.warn(`${taskId}: workflow rerun watchdog could not read latest task state: ${errorMessage}`);
        return;
      }

      if (!currentTask || currentTask.paused || currentTask.column === "in-progress") {
        return;
      }

      executorLog.warn(
        `${taskId}: workflow rerun watchdog fired after ${WORKFLOW_RERUN_WATCHDOG_MS / 1000}s ` +
        `— task is still ${currentTask.column}; retrying handoff once`,
      );
      await this.store.logEntry(
        taskId,
        `Watchdog: workflow rerun handoff stalled for ${WORKFLOW_RERUN_WATCHDOG_MS / 1000}s ` +
        `(still ${currentTask.column}) — retrying once`,
      ).catch(() => undefined);

      try {
        const outcome = await this.performWorkflowRerunBounce(taskId, worktreePath, preserveResumeState);
        if (outcome === "bounced") {
          executorLog.warn(`${taskId}: workflow rerun watchdog retry succeeded`);
        } else if (outcome === "skipped-pending") {
          // The original bounce is still mid-flight, which means *it* is the
          // one that's hung — not us. Log honestly so operators don't see a
          // false "succeeded" message while the task is actually stranded.
          executorLog.error(
            `${taskId}: workflow rerun watchdog retry skipped — original bounce still in flight after ${WORKFLOW_RERUN_WATCHDOG_MS / 1000}s; task may be stuck`,
          );
          await this.store.logEntry(
            taskId,
            `Workflow rerun watchdog retry skipped — original bounce still in flight after ${WORKFLOW_RERUN_WATCHDOG_MS / 1000}s; task may be stuck`,
          ).catch(() => undefined);
        } else {
          executorLog.log(`${taskId}: workflow rerun watchdog retry deferred while pause is active`);
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        executorLog.error(`${taskId}: workflow rerun watchdog retry failed: ${errorMessage}`);
      }
    }, WORKFLOW_RERUN_WATCHDOG_MS);

    this.workflowRerunWatchdogs.set(taskId, watchdog);
  }

  private async shouldFinalizeCompletedTask(taskId: string, taskDone: boolean): Promise<boolean> {
    const task = await this.store.getTask(taskId);
    const completionBlocker = await this.getTaskCompletionBlocker(task);
    if (completionBlocker) {
      executorLog.log(`${taskId} completion blocked — ${completionBlocker}`);
      return false;
    }
    if (taskDone) return true;
    return this.isTaskWorkComplete(task);
  }

  private isTaskAlreadyCompleteForNonContinuableSession(task: Task, taskDone: boolean): boolean {
    return taskDone || task.column === "in-review" || this.isTaskWorkComplete(task);
  }

  private async handleNonContinuableSessionError(task: Task, taskDone: boolean, errorMessage: string): Promise<boolean> {
    if (!isNonContinuableSessionError(errorMessage)) {
      return false;
    }

    const liveTask = await this.store.getTask(task.id);
    if (!liveTask || !this.isTaskAlreadyCompleteForNonContinuableSession(liveTask, taskDone)) {
      return false;
    }

    const diagnosticMessage = "Post-done session continuation suppressed — session not continuable (last role assistant); task work already complete, leaving clean in-review";
    executorLog.warn(`${task.id} ${diagnosticMessage}`);
    await this.store.logEntry(task.id, diagnosticMessage, errorMessage, this.getRunContextFor(task.id));

    if (liveTask.status === "failed" || liveTask.error) {
      await this.store.updateTask(task.id, { status: null, error: null });
    }

    await this.persistTokenUsage(task.id);

    if (liveTask.column === "in-review") {
      this.clearCompletedTaskWatchdog(task.id);
      this.options.onComplete?.(liveTask);
      return true;
    }

    const refreshedTask = await this.store.getTask(task.id);
    await this.handoffTaskToReview(refreshedTask ?? liveTask, "post-done-noncontinuable");
    this.clearCompletedTaskWatchdog(task.id);
    this.options.onComplete?.(refreshedTask ?? liveTask);
    return true;
  }

  private async handleNonContinuableSessionRetry(task: Task, errorMessage: string): Promise<boolean> {
    if (!isNonContinuableSessionError(errorMessage)) {
      return false;
    }

    const liveTask = await this.store.getTask(task.id);
    if (!liveTask) {
      return false;
    }

    const decision = computeRecoveryDecision({
      recoveryRetryCount: liveTask.recoveryRetryCount,
      nextRecoveryAt: liveTask.nextRecoveryAt,
    });

    if (decision.shouldRetry) {
      const attempt = decision.nextState.recoveryRetryCount;
      const delay = formatDelay(decision.delayMs);
      executorLog.warn(`⚡ ${task.id} non-continuable session — fresh-session retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}`);
      await this.store.logEntry(task.id, `Non-continuable session — fresh-session retry (${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}): ${errorMessage}`, undefined, this.getRunContextFor(task.id));
      await this.store.updateTask(task.id, {
        recoveryRetryCount: decision.nextState.recoveryRetryCount,
        nextRecoveryAt: decision.nextState.nextRecoveryAt,
        sessionFile: null,
      });
      await this.store.moveTask(task.id, "todo", { preserveResumeState: true });
      return true;
    }

    executorLog.error(`✗ ${task.id} non-continuable session fresh-session retries exhausted (${MAX_RECOVERY_RETRIES} attempts): ${errorMessage}`);
    await this.store.logEntry(task.id, `Non-continuable session fresh-session retries exhausted after ${MAX_RECOVERY_RETRIES} attempts: ${errorMessage}`, undefined, this.getRunContextFor(task.id));
    await this.store.updateTask(task.id, {
      recoveryRetryCount: null,
      nextRecoveryAt: null,
    });
    return false;
  }

  private async getTaskCompletionBlocker(task: Task): Promise<string | undefined> {
    return getTaskCompletionBlockerForStore(this.store, task);
  }

  private accumulateTokenUsage(
    existing: TaskTokenUsage | undefined,
    delta: Pick<TaskTokenUsage, "inputTokens" | "outputTokens" | "cachedTokens" | "cacheWriteTokens" | "totalTokens"> | undefined,
    timestamp = new Date().toISOString(),
  ): TaskTokenUsage | undefined {
    if (!delta) return existing;

    const merged: TaskTokenUsage = {
      inputTokens: (existing?.inputTokens ?? 0) + delta.inputTokens,
      outputTokens: (existing?.outputTokens ?? 0) + delta.outputTokens,
      cachedTokens: (existing?.cachedTokens ?? 0) + delta.cachedTokens,
      cacheWriteTokens: (existing?.cacheWriteTokens ?? 0) + delta.cacheWriteTokens,
      totalTokens: (existing?.totalTokens ?? 0) + delta.totalTokens,
      firstUsedAt: existing?.firstUsedAt ?? timestamp,
      lastUsedAt: timestamp,
    };

    return merged;
  }

  private async extractSessionTokenUsage(
    session: AgentSession | undefined,
  ): Promise<Pick<TaskTokenUsage, "inputTokens" | "outputTokens" | "cachedTokens" | "cacheWriteTokens" | "totalTokens"> | undefined> {
    if (!session) return undefined;

    try {
      const statsResult = (session as AgentSession & {
        getSessionStats?: () =>
          | {
              tokens?: {
                input?: number;
                output?: number;
                cacheRead?: number;
                cacheWrite?: number;
                total?: number;
              };
            }
          | Promise<{
              tokens?: {
                input?: number;
                output?: number;
                cacheRead?: number;
                cacheWrite?: number;
                total?: number;
              };
            }>;
      }).getSessionStats?.();
      const stats = await Promise.resolve(statsResult);
      const tokens = stats?.tokens;
      if (!tokens) return undefined;

      const inputTokens = tokens.input ?? 0;
      const outputTokens = tokens.output ?? 0;
      const cachedTokens = tokens.cacheRead ?? 0;
      const cacheWriteTokens = tokens.cacheWrite ?? 0;
      const totalTokens = tokens.total ?? (inputTokens + outputTokens + cachedTokens + cacheWriteTokens);

      return {
        inputTokens,
        outputTokens,
        cachedTokens,
        cacheWriteTokens,
        totalTokens,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      executorLog.warn(`Failed to read session stats for token usage: ${message}`);
      return undefined;
    }
  }

  private async persistTokenUsage(taskId: string, session?: AgentSession): Promise<void> {
    const activeSession = session ?? this.activeSessions.get(taskId)?.session;
    const currentUsage = await this.extractSessionTokenUsage(activeSession);
    if (!currentUsage) return;

    const baseline = this.tokenUsageBaselines.get(taskId);
    this.tokenUsageBaselines.set(taskId, currentUsage);

    const delta = baseline
      ? {
          inputTokens: Math.max(0, currentUsage.inputTokens - baseline.inputTokens),
          outputTokens: Math.max(0, currentUsage.outputTokens - baseline.outputTokens),
          cachedTokens: Math.max(0, currentUsage.cachedTokens - baseline.cachedTokens),
          cacheWriteTokens: Math.max(0, currentUsage.cacheWriteTokens - baseline.cacheWriteTokens),
          totalTokens: Math.max(0, currentUsage.totalTokens - baseline.totalTokens),
        }
      : currentUsage;

    if (
      delta.inputTokens === 0
      && delta.outputTokens === 0
      && delta.cachedTokens === 0
      && delta.cacheWriteTokens === 0
      && delta.totalTokens === 0
    ) {
      return;
    }

    const task = await this.store.getTask(taskId);
    const merged = this.accumulateTokenUsage(task.tokenUsage, delta);
    if (!merged) return;

    tokenCacheMetricsLog.log(JSON.stringify({
      taskId,
      agentId: task.assignedAgentId ?? undefined,
      role: "executor",
      inputTokens: merged.inputTokens,
      cachedTokens: merged.cachedTokens,
      cacheWriteTokens: merged.cacheWriteTokens,
      hitRatio: merged.inputTokens + merged.cachedTokens > 0 ? merged.cachedTokens / (merged.inputTokens + merged.cachedTokens) : 0,
    }));

    await this.store.updateTask(taskId, { tokenUsage: merged });
  }

  /**
   * Execute a review handoff: move the task to in-review column with
   * awaiting-user-review status, assign the requesting user, and dispose
   * the agent session.
   */
  private async executeReviewHandoff(
    task: Task,
    _session: AgentSession,
    _sessionEntry: { session: AgentSession; seenSteeringIds: Set<string>; lastResolvedModelProvider?: string; lastResolvedModelId?: string; lastTaskModelProvider?: string | null; lastTaskModelId?: string | null; lastAssignedAgentId?: string | null },
  ): Promise<void> {
    try {
      executorLog.log(`Executing review handoff for ${task.id}`);

      // Log the handoff event
      await this.store.logEntry(
        task.id,
        "Review handoff requested by agent — moving to in-review for user review",
        undefined,
        this.getRunContextFor(task.id)
      );

      // Update task with awaiting-user-review status and assignee
      // Use a single updateTask call for atomicity
      await this.store.updateTask(
        task.id,
        {
          status: "awaiting-user-review",
          assigneeUserId: "requesting-user",
        },
        this.getRunContextFor(task.id)
      );

      // Move the task to in-review column (this will also emit task:moved event)
      // The task:moved handler will clean up activeSessions
      await this.persistTokenUsage(task.id);
      await this.handoffTaskToReview(task, "review-handoff-requested");

      // Dispose the agent session (this may already be done by task:moved handler)
      // but we do it here to be explicit
      if (this.activeSessions.has(task.id)) {
        const { session: activeSession } = this.activeSessions.get(task.id)!;
        activeSession.dispose();
        this.deleteActiveSession(task.id);
      }

      // Untrack from stuck detector
      this.options.stuckTaskDetector?.untrackTask(task.id);

      executorLog.log(`Review handoff complete for ${task.id} — task moved to in-review`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.error(`Failed to execute review handoff for ${task.id}: ${errorMessage}`);
    }
  }

  /**
   * Fast-path a completed task directly to in-review without spawning a new agent.
   * Captures modified files, runs workflow steps, and transitions the task.
   *
   * @returns true if the task was successfully transitioned, false otherwise.
   */
  async recoverCompletedTask(task: Task): Promise<boolean> {
    try {
      if (
        this.executing.has(task.id)
        || this.activeSessions.has(task.id)
        || this.activeStepExecutors.has(task.id)
        || this.activeWorkflowStepSessions.has(task.id)
        || this.resumingUnpaused.has(task.id)
        || TaskExecutor.processWideGraphRouting.has(task.id)
      ) {
        executorLog.log(`${task.id}: skipping recoverCompletedTask — task has active execution in flight`);
        return false;
      }
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) {
        executorLog.log(
          `${task.id}: skipping recoverCompletedTask — ${
            settings.globalPause ? "global pause" : "engine pause"
          } active`,
        );
        return false;
      }

      // Capture modified files if the worktree still exists
      if (task.worktree && existsSync(task.worktree)) {
        const modifiedFiles = await this.captureModifiedFiles(task.worktree, task.baseCommitSha, task.id, undefined, "recovery");
        if (modifiedFiles.length > 0) {
          await this.store.updateTask(task.id, { modifiedFiles });
          executorLog.log(`${task.id}: recovered ${modifiedFiles.length} modified files`);
        }

        // Run workflow steps before transitioning — skip in fast mode
        if (task.executionMode !== "fast") {
          if (await this.shouldDeferCompletionForGlobalPause(task.id, "before workflow steps during completed-task recovery")) {
            return false;
          }
          const workflowResult = await this.runWorkflowSteps(task, task.worktree, settings, undefined);
          if (workflowResult === "deferred-paused") {
            if (this.pausedAborted.has(task.id)) {
              this.pausedAborted.delete(task.id);
            }
            return false;
          }
          if (!workflowResult.allPassed) {
            // For recovery path, treat any failure (including revision) as hard failure
            // Send back to in-progress so executor can attempt to fix the issues
            await this.sendTaskBackForFix(task, task.worktree!, workflowResult.feedback, workflowResult.stepName || "Unknown", "Workflow step failed during recovery", false);
            return true; // Still transitioned out of in-progress
          }
        } else {
          executorLog.log(`${task.id}: fast mode — skipping workflow steps on auto-recovery`);
        }
      }

      if (await this.shouldDeferCompletionForGlobalPause(task.id, "before in-review transition during completed-task recovery")) {
        return false;
      }
      await this.persistTokenUsage(task.id);
      const originColumn = task.column;
      const promotedFromTodo = originColumn === "todo";
      if (promotedFromTodo) {
        this.recoveringCompleted.add(task.id);
        await this.store.moveTask(task.id, "in-progress");
      }
      await this.handoffTaskToReview(task, "completed-task-recovered");
      if (promotedFromTodo) {
        this.recoveringCompleted.delete(task.id);
      }
      this.clearCompletedTaskWatchdog(task.id);
      await this.store.logEntry(task.id, `Auto-recovered: task work was complete but stranded in ${originColumn} — moved to in-review`);
      executorLog.log(`✓ ${task.id} auto-recovered completed task → in-review`);
      this.options.onComplete?.(task);
      return true;
    } catch (err: unknown) {
      this.recoveringCompleted.delete(task.id);
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.error(`Failed to recover completed task ${task.id}: ${errorMessage}`);
      return false;
    }
  }

  /**
   * Auto-revive an `in-review` task whose pre-merge workflow step(s) failed, by
   * replaying the same send-back-for-fix flow the executor uses during a live
   * run. Invoked by SelfHealingManager's `recoverReviewTasksWithFailedPreMergeSteps`
   * scan when a task is parked in review with a failed pre-merge step and no
   * active session.
   *
   * Picks the latest failed pre-merge workflow step result (there is usually only
   * one, but if several ran we want the most recent), injects its feedback into
   * `PROMPT.md`, resets steps, and schedules todo → in-progress. The call site
   * is responsible for enforcing the `maxPostReviewFixes` budget before invoking
   * this method — this method itself does no accounting.
   *
   * @returns true when the task was sent back, false when no eligible failed
   *          step exists (caller should skip).
   */
  async recoverFailedPreMergeWorkflowStep(task: Task): Promise<boolean> {
    try {
      const preMergeFailed = (task.workflowStepResults ?? [])
        .filter((r) => (r.phase || "pre-merge") === "pre-merge" && r.status === "failed")
        .sort((a, b) => {
          const aTs = Date.parse(a.completedAt || a.startedAt || "");
          const bTs = Date.parse(b.completedAt || b.startedAt || "");
          return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
        });

      const gateModeCache = new Map<string, "gate" | "advisory">();
      const failed: typeof preMergeFailed = [];
      for (const result of preMergeFailed) {
        let mode = gateModeCache.get(result.workflowStepId);
        if (!mode) {
          const step = await this.store.getWorkflowStep(result.workflowStepId).catch(() => null);
          mode = step?.gateMode || (step?.mode === "script" ? "gate" : "advisory");
          gateModeCache.set(result.workflowStepId, mode);
        }
        if (mode === "gate") failed.push(result);
      }

      const target = failed[0];
      if (!target) {
        executorLog.warn(`${task.id}: no failed pre-merge workflow step to recover from`);
        return false;
      }

      const feedback = target.output?.trim() || "(no feedback captured)";
      const stepName = target.workflowStepName || target.workflowStepId || "Unknown";

      await this.sendTaskBackForFix(
        task,
        task.worktree ?? "",
        feedback,
        stepName,
        `Auto-revived from in-review: pre-merge workflow step "${stepName}" had failed`,
      );
      return true;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.error(`Failed to recover failed pre-merge workflow step for ${task.id}: ${errorMessage}`);
      return false;
    }
  }

  /**
   * Returns true when execute() should be deferred because the agent bound to
   * this task has an active heartbeat run and allowParallelExecution=false.
   *
   * Only applies to permanent (non-ephemeral) agents. Always returns false
   * when agentStore is unavailable or the agent cannot be resolved.
   */
  private async shouldDeferForHeartbeat(agentId: string): Promise<boolean> {
    if (!this.options.agentStore) return false;
    const agent = await this.options.agentStore.getAgent(agentId).catch(() => null);
    if (!agent) return false;
    if (isEphemeralAgent(agent)) return false;
    const rc = (agent.runtimeConfig ?? {}) as AgentHeartbeatConfig;
    if (rc.allowParallelExecution !== false) return false;
    const activeRun = await this.options.agentStore.getActiveHeartbeatRun(agentId).catch(() => null);
    return activeRun !== null;
  }

  private async getAssignedAgentRuntimeConfig(
    assignedAgentId: string | null | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    const normalizedId = assignedAgentId?.trim();
    if (!normalizedId || !this.options.agentStore) return undefined;
    const agent = await this.options.agentStore.getAgent(normalizedId).catch(() => null);
    return (agent?.runtimeConfig ?? undefined) as Record<string, unknown> | undefined;
  }

  /**
   * Re-dispatch execute() for any unstarted in-progress task whose EFFECTIVE
   * principal is the given agent. Called after a heartbeat run completes to unblock
   * tasks that were deferred by the allowParallelExecution=false gate.
   *
   * TWO-PASS (plan U5, R6) — the `assignedAgentId`-only filter alone misses tasks an
   * override/defer column binding re-keys to the column agent:
   *   1. Tasks directly `assignedAgentId === agentId` (legacy, byte-identical).
   *   2. Tasks whose effective column agent resolves to `agentId` for their
   *      governing execute / step-execute seam — resolved per candidate via the core
   *      column-agent resolver against the task's workflow IR. Bounded: only
   *      not-already-executing in-progress tasks are probed, and the IR resolution is
   *      best-effort (failure → skip, never strands resume).
   * A task re-dispatched by pass 1 is not re-dispatched by pass 2 (dedupe set).
   */
  async resumeTaskForAgent(agentId: string): Promise<void> {
    const settings = await this.store.getSettings();
    if (settings.globalPause || settings.enginePaused) return;
    const tasks = await this.store.listTasks({ slim: true, column: "in-progress" });
    const dispatched = new Set<string>();
    const isDispatchable = (task: Task): boolean =>
      !task.deletedAt
      && !task.paused
      && !this.executing.has(task.id)
      && !this.activeSessions.has(task.id)
      && !this.activeStepExecutors.has(task.id)
      && !this.activeWorkflowStepSessions.has(task.id);
    const dispatch = (task: Task, reason: string): void => {
      if (dispatched.has(task.id)) return;
      dispatched.add(task.id);
      executorLog.log(`${task.id}: re-dispatching execute() after heartbeat completion for agent ${agentId} (${reason})`);
      this.execute(task).catch((err) =>
        executorLog.error(`Failed to resume ${task.id} after heartbeat completion:`, err),
      );
    };

    // Pass 1: directly-assigned tasks (legacy behavior, byte-identical).
    for (const task of tasks) {
      if (task.assignedAgentId === agentId && isDispatchable(task)) {
        dispatch(task, "assigned");
      }
    }

    // Pass 2: tasks whose EFFECTIVE column agent resolves to `agentId`. Only
    // experimental graph-executor tasks can carry a column binding; the IR resolve
    // is best-effort and skipped for tasks already dispatched/executing.
    if (!isExperimentalFeatureEnabled(settings, "workflowGraphExecutor")) return;
    for (const task of tasks) {
      if (dispatched.has(task.id) || !isDispatchable(task)) continue;
      // Skip tasks the assigned-agent filter already covers — a redundant column
      // binding to the same agent would only re-confirm pass 1.
      if (task.assignedAgentId === agentId) continue;
      let matches = false;
      try {
        matches = await this.taskEffectiveAgentMatches(task, agentId);
      } catch {
        matches = false;
      }
      if (matches) dispatch(task, "effective-column-agent");
    }
  }

  /** Column-agent principal alignment (plan U5, R6). True when the EFFECTIVE agent
   *  governing `task`'s execute or step-execute seam — resolved through the shared
   *  core resolver against the task's workflow IR — is `agentId`. Used by the
   *  `resumeTaskForAgent` second pass to re-dispatch column-bound tasks the
   *  `assignedAgentId` filter misses. Best-effort: an unresolvable IR yields false. */
  private async taskEffectiveAgentMatches(task: Task, agentId: string): Promise<boolean> {
    // R10 kill-switch (PR #1432 review): this path resolves the IR directly (it
    // does not go through the per-run resolver map), so it needs its own flag
    // guard — resume pass 2 must be inert when workflowColumns is off.
    const settings = await this.store.getSettings();
    if (!isWorkflowColumnsEnabled(settings)) return false;
    const ir = await resolveWorkflowIrForTask(this.store, task.id);
    if (!ir || ir.version !== "v2") return false;

    const ownSettings = this.extractOwnSettings(task);
    const matchesNodeId = (nodeId: string): boolean => {
      const binding = resolveColumnAgentBinding(ir, nodeId);
      if (!binding) return false;
      const effective = resolveEffectiveAgent({ binding, ...ownSettings });
      return effective.source === "column-agent" && effective.agentId === agentId;
    };

    // Governing seam nodes: the execute-seam prompt node lives at the top level.
    for (const node of ir.nodes) {
      const seam = node.kind === "prompt" ? node.config?.seam : undefined;
      if (seam !== "execute" && seam !== "step-execute") continue;
      if (matchesNodeId(node.id)) return true;
    }

    // step-execute seam nodes are legal ONLY inside a foreach template
    // (workflow-ir.ts), so they never appear in ir.nodes above. Walk each foreach
    // node's template subgraph and resolve the binding via a synthesized instance
    // node id. Step index 0 is sufficient — column resolution is index-independent
    // (all instances share the same template node and thus the same binding, R4).
    for (const node of ir.nodes) {
      if (node.kind !== "foreach") continue;
      const templateNodes = (node.config as { template?: { nodes?: WorkflowIrNode[] } } | undefined)?.template?.nodes ?? [];
      for (const templateNode of templateNodes) {
        const seam = templateNode.kind === "prompt" ? templateNode.config?.seam : undefined;
        if (seam !== "step-execute") continue;
        if (matchesNodeId(instanceNodeId(node.id, 0, templateNode.id))) return true;
      }
    }
    return false;
  }

  /**
   * Resume orphaned in-progress tasks (e.g., after crash/restart).
   * Call once after engine startup.
   *
   * Tasks that are already complete (all steps done/skipped) are fast-pathed
   * directly to in-review without spawning a new agent session.
   */
  async resumeOrphaned(): Promise<void> {
    const settings = await this.store.getSettings();
    if (settings.globalPause || settings.enginePaused) {
      executorLog.log(
        `resumeOrphaned skipped — ${
          settings.globalPause ? "global pause" : "engine pause"
        } is active`,
      );
      return;
    }

    const tasks = await this.store.listTasks({ slim: true, column: "in-progress" });
    const inProgress = tasks.filter(
      (t) => t.column === "in-progress" && !t.deletedAt && !this.executing.has(t.id) && !t.paused,
    );

    if (inProgress.length === 0) return;

    executorLog.log(`Found ${inProgress.length} orphaned in-progress task(s)`);
    const resumeDelayMs = getResumeOrphanDelayMs();
    if (resumeDelayMs > 0) {
      executorLog.log(
        `Deferring orphan task resumption for ${resumeDelayMs}ms to keep dashboard responsive during cold start`,
      );
    }
    // When the delay is zero (default in tests and when explicitly disabled),
    // skip the setTimeout indirection so the spawn happens on the current
    // microtask — matching the legacy behavior callers may rely on.
    const scheduleResume = resumeDelayMs > 0
      ? (fn: () => void) => { setTimeout(fn, resumeDelayMs); }
      : (fn: () => void) => { fn(); };
    let yieldNext = false;
    for (const task of inProgress) {
      if (yieldNext) await yieldEventLoop();
      yieldNext = true;
      // Fast-path: if the task already completed its work (all steps done),
      // move it directly to in-review instead of re-executing from scratch.
      if (this.isTaskWorkComplete(task) && !task.mergeDetails) {
        if (this.recoveringCompleted.has(task.id)) {
          executorLog.log(`${task.id} completed-task recovery already running - skipping duplicate startup recovery`);
          continue;
        }
        if (TaskExecutor.processWideGraphRouting.has(task.id)) {
          executorLog.log(`${task.id} owned by the workflow graph interpreter — skipping completed-task fast-path`);
          continue;
        }
        executorLog.log(`${task.id} is already complete — fast-pathing to in-review`);
        this.recoveringCompleted.add(task.id);
        scheduleResume(() => {
          void this.recoverCompletedTask(task)
            .catch((err) =>
              executorLog.error(`Failed to recover completed orphan ${task.id}:`, err),
            )
            .finally(() => {
              this.recoveringCompleted.delete(task.id);
            });
        });
        continue;
      }

      if (this.isNoProgressNoTaskDoneFailure(task)) {
        executorLog.log(`${task.id} failed without fn_task_done and has no step progress — leaving for self-healing requeue`);
        continue;
      }

      executorLog.log(`Resuming ${task.id}: ${task.title || task.description.slice(0, 60)}`);
      try {
        await this.clearResumeFailureState(task);
        await this.store.logEntry(task.id, "Resumed after engine restart");
        await this.recoverApprovedStepsOnResume(task.id);
      } catch (err) {
        executorLog.error(`Failed to write resume log for ${task.id}:`, err);
      }
      scheduleResume(() => {
        this.execute(task).catch((err) =>
          executorLog.error(`Failed to resume ${task.id}:`, err),
        );
      });
    }
  }

  /**
   * Execute a task in an isolated git worktree.
   *
   * Worktree acquisition flow:
   * 1. If the worktree already exists on disk (resume after crash), reuse it.
   * 2. If a {@link WorktreePool} is provided and `recycleWorktrees` is enabled,
   *    attempt to acquire a warm worktree from the pool. Pooled worktrees skip
   *    the `worktreeInitCommand` since their build caches are already warm.
   * 3. Otherwise, create a fresh worktree via `git worktree add` and run the
   *    `worktreeInitCommand` if configured.
   */

  /**
   * Resolve custom instructions for a given agent role by looking up agents
   * in the AgentStore that have instructions configured.
   * Returns an empty string if no instructions are found.
   */
  private async resolveInstructionsForRole(role: string, settings?: Settings): Promise<string> {
    if (!this.options.agentStore) return "";
    try {
      const agents = await this.options.agentStore.listAgents({ role: role as AgentCapability });
      for (const agent of agents) {
        if (agent.instructionsText || agent.instructionsPath) {
          try {
            const ratingSummary = await this.options.agentStore.getRatingSummary(agent.id);
            const mode = resolveAgentMemoryInclusionMode({ agent, globalSettings: settings }).mode;
            return await resolveAgentInstructions(agent, this.rootDir, ratingSummary, mode);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            executorLog.warn(`${agent.id}: failed to load rating summary for instruction resolution, falling back to default instructions: ${msg}`);
            const mode = resolveAgentMemoryInclusionMode({ agent, globalSettings: settings }).mode;
            return await resolveAgentInstructions(agent, this.rootDir, undefined, mode);
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`Failed to resolve instructions for role '${role}', continuing without custom instructions: ${msg}`);
    }
    return "";
  }

  /**
   * Execute a task in an isolated git worktree.
   *
   * **Worktree assignment:** New worktrees get humanized random names
   * (e.g., `.worktrees/swift-falcon/`) via `generateWorktreeName()` rather
   * than being named after the task ID. This decouples directory names from
   * tasks, enabling worktree reuse across dependency chains. When resuming
   * a task that already has `task.worktree` set, the existing path is used
   * as-is. Branches remain task-scoped (`fusion/{task-id}`).
   */
  // ── Workflow graph interpreter (cutover M-B/M-C) ─────────────────────────
  //
  // When `experimentalFeatures.workflowGraphExecutor` is enabled and a task has
  // a selected custom workflow, the graph runner owns lifecycle SEQUENCING:
  // custom prompt/script/gate nodes run via the WorkflowStep machinery, and the
  // planning/execute/review/merge seam nodes delegate to the legacy engine
  // implementations. Any interpreter-level error falls back to the legacy
  // pipeline — a task is never stranded by interpreter bugs.

  /** Completion interceptors for graph-driven tasks: when present for a task,
   *  execute() stops at the implementation-complete boundary (no workflow
   *  steps, no review handoff) and hands control back to the graph runner.
   *  Doubles as the re-entrancy guard for graph routing. */
  private graphCompletionInterceptors = new Map<string, (info: { modifiedFiles: string[] }) => void>();

  /** Step-inversion (KTD-2/KTD-8, U6/U8): tasks whose graph-owned step-execute
   *  driver has pinned step-session physics for the run. Forces the step-session
   *  path in execute() regardless of the `runStepsInNewSessions` setting, so the
   *  graph/step-sessions flag matrix cannot select an unsupported physics combo.
   *  Cleared when the graph run ends (maybeExecuteWorkflowGraph finally). */
  private graphStepSessionPinned = new Set<string>();

  /** Step-inversion (U6/U8): caches the per-run implementation-phase result for a
   *  graph-owned task so the foreach sub-walk's per-step `runTaskStep` driver runs
   *  the (step-session) implementation exactly once per run and lets later step
   *  instances observe the projection rather than re-running execute() per step.
   *  Keyed by task id; cleared alongside the pin. */
  private graphStepRunOnce = new Map<string, Promise<{ taskDone: boolean; modifiedFiles: string[] }>>();

  /** Step-inversion (KTD-4): the foreach instance the step-execute seam is
   *  currently driving for a graph-owned task, so `runGraphTaskStep` can honor
   *  `deferDoneToReview` when deciding whether a non-terminal step is a success
   *  (review will author done) or a failure (implementation left it incomplete).
   *  Stamped by the stepExecute seam around the runTaskStep call; cleared with the
   *  per-run pins. Keyed by `${task.id}:${instanceId}` so parallel foreach
   *  instances of the same task cannot clobber each other's active context
   *  (the read path threads the same instanceId through `runGraphTaskStep`). */
  private graphStepActiveContext = new Map<string, ForeachActiveContext>();

  /** Composite key for {@link graphStepActiveContext}: per-instance, not per-task. */
  private graphActiveContextKey(taskId: string, instanceId: string): string {
    return `${taskId}:${instanceId}`;
  }

  /** Column-agent seam wiring (column-agent plan U4, R2/R3/R4). Per-run binding
   *  resolver keyed by task id: maps a governing node id to its column-agent
   *  binding (if any), computed once per run in maybeExecuteWorkflowGraph from the
   *  resolved IR. The execute / step-execute seams consume it to decide whether the
   *  coding/step session runs as a column agent. Cleared in the run's finally. */
  private graphColumnAgentResolver = new Map<string, (nodeId: string) => WorkflowColumnAgent | undefined>();

  /** Column-agent seam wiring (column-agent plan U4). The governing graph node id
   *  for the implementation pass currently in flight for a task — the execute-seam
   *  prompt node's id (execute seam), or the foreach instance node id (step-execute
   *  seam, which the core resolver maps through template inheritance). Stamped by
   *  the seam from the reserved {@link SEAM_GOVERNING_NODE_CONTEXT_KEY} context key
   *  right before it drives the implementation phase, read inside execute()'s
   *  session build, and cleared by the seam afterward. Keyed by task id. */
  private graphSeamGoverningNodeId = new Map<string, string>();

  /** Tasks currently being orchestrated by the graph runner. Process-wide for
   *  the same reason as executingTaskLock (FN-4811): duplicate execute()
   *  invocations can arrive from different TaskExecutor instances in one
   *  process (engine restart race, hybrid runtimes), and the graph runner does
   *  not hold the executing-task lock between seams. */
  private get graphRouting(): Set<string> {
    return TaskExecutor.processWideGraphRouting;
  }

  private static processWideGraphRouting = new Set<string>();

  /** Wired by the runtime to ProjectEngine.onMerge — resolves with the merge outcome. */
  private mergeRequester?: (taskId: string) => Promise<MergeResult>;

  setMergeRequester(requestMerge: (taskId: string) => Promise<MergeResult>): void {
    this.mergeRequester = requestMerge;
  }

  /**
   * Route a task through the workflow graph interpreter when eligible.
   * Returns true when the graph owned the task to a terminal disposition
   * (completed or failed); false when the legacy pipeline should run.
   */
  private async maybeExecuteWorkflowGraph(task: Task): Promise<boolean> {
    // Claim synchronously before any await so concurrent execute() calls for
    // the same task cannot both enter graph routing (mirrors executingTaskLock).
    this.graphRouting.add(task.id);
    try {
      let settings: Settings;
      try {
        settings = await this.store.getSettings();
      } catch {
        return false;
      }
      if (!isExperimentalFeatureEnabled(settings, "workflowGraphExecutor")) return false;
      if (typeof this.store.getTaskWorkflowSelection !== "function") return false;

      let selection: { workflowId: string; stepIds: string[] } | undefined;
      try {
        selection = this.store.getTaskWorkflowSelection(task.id);
      } catch {
        return false;
      }
      if (!selection) return false;

      // Resolve the production run id ONCE, here, so it is the single source of
      // truth shared by the runner AND the executor-side persistence deps
      // (parse-steps pin probe, foreach instance-row flips, resume reconcile). The
      // runner derives `${task.id}:${definition.id}`; we mirror that derivation
      // from the resolved definition and thread it everywhere. Best-effort: if the
      // definition cannot be resolved (older store), the runner falls back to its
      // own derivation and the deps fall back to the legacy `:run` literal — the
      // prior behavior — so this never strands a task.
      let resolvedRunId: string | undefined;
      try {
        const definition = await this.store.getWorkflowDefinition?.(selection.workflowId);
        if (definition) resolvedRunId = `${task.id}:${definition.id}`;
      } catch {
        // Definition load failure — leave undefined; deps/runner use fallbacks.
      }

      // Column-agent binding (plan U3): the IR is NOT in scope inside
      // runGraphCustomNode, so resolve it here (the seam wiring) where the
      // selection is known, and thread a per-node binding lookup into the custom
      // node callback. Resolve the IR ONCE per run (never an uncached per-node
      // fetch — mirrors the hold-release.ts irCache posture); best-effort, so a
      // resolution failure simply yields no bindings (R8 graceful degradation).
      // R10 kill-switch (PR #1432 review): column agents require BOTH flags. The
      // graph executor gate above covers workflowGraphExecutor; this guard makes
      // disabling workflowColumns alone actually render bindings inert at
      // execution time (the documented rollback) — no resolver installed means
      // every downstream consumer (custom nodes, seams, watcher) sees no binding.
      const columnAgentsEnabled = isWorkflowColumnsEnabled(settings);
      let columnAgentIr: WorkflowIr | undefined;
      if (columnAgentsEnabled) {
        try {
          columnAgentIr = await resolveWorkflowIrForTask(this.store, task.id);
        } catch {
          columnAgentIr = undefined;
        }
      }
      const resolveBindingForNode = (nodeId: string): WorkflowColumnAgent | undefined =>
        columnAgentIr ? resolveColumnAgentBinding(columnAgentIr, nodeId) : undefined;
      // Column-agent seam wiring (U4): expose the same per-run resolver to the
      // execute / step-execute seams (which key off a governing node id stamped
      // into context), so the coding/step session runs as the column agent under
      // the SAME binding lookup the custom-node seam uses (KTD-2 single resolver).
      if (columnAgentsEnabled) {
        this.graphColumnAgentResolver.set(task.id, resolveBindingForNode);
      }

      const runner = new WorkflowGraphTaskRunner({
        store: this.store,
        runId: resolvedRunId,
        seams: this.createGraphSeams(settings),
        runCustomNode: (node, nodeTask) =>
          this.runGraphCustomNode(node, nodeTask, settings, resolveBindingForNode(node.id)),
        onEvent: (event) => executorLog.log(`[workflow-graph] ${event.type} ${event.taskId}: ${event.detail}`),
        // Wire SQLite-backed per-branch persistence in production (#1407): the
        // executor writes each branch's currentNodeId/status to
        // workflow_run_branches so fan-out crash-resume and the U9 badges have
        // real data, and prunes stale runs (#1412). Adapter degrades to no-op
        // when the store predates these methods (additive guard).
        branchPersistence: this.buildBranchPersistence(),
        // Step-inversion (KTD-6, U3/U4): per-instance run-state persistence.
        stepInstancePersistence: this.buildStepInstancePersistence(),
        // Step-inversion (KTD-4, U5): RETHINK reset-on-rework — when the foreach
        // sub-walk traverses a rework edge triggered by `outcome:rethink`, reset
        // the active instance's step to its persisted per-step baseline (git reset
        // + session rewind + step→pending) before re-entering step-execute.
        onReworkReset: (active) => this.applyGraphRethinkReset(task.id, active),
        // Step-inversion (KTD-12, U12): parse-steps node handler deps — artifact
        // read (through task-documents with PROMPT.md fallback), step-list write
        // (graph-source projection), pin-protection probe, and audit.
        parseStepsDeps: this.buildParseStepsDeps(resolvedRunId),
        // Step-inversion (KTD-15, U14): code node runner — esbuild compile +
        // child-process execution with the harness contract.
        runCode: this.buildCodeNodeRunner(),
        // Step-inversion (KTD-11, U10): worktree isolation + ordered integration +
        // parallel scheduling. Per-instance worktrees branched off the task's main
        // branch tip; integration rebases each branch in step order; the projection
        // flips done-iff-integrated. Shared isolation never invokes these.
        ...this.buildForeachWorktreeDeps(task, resolvedRunId),
        // FIX 4 (context gap): task-level log sink so an integration-conflict
        // rework writes a visible "reworking on updated base (files: ...)" entry
        // the re-running agent can read. Best-effort; logging failures swallowed.
        logTaskEntry: (summary: string, detail?: string) => {
          void this.store
            .logEntry(task.id, summary, detail, this.getRunContextFor(task.id))
            .catch(() => {});
        },
      });
      let result: WorkflowGraphTaskRunResult;
      try {
        const detail = await this.store.getTask(task.id);
        result = await runner.run(detail, settings);
      } catch (err) {
        // A thrown interpreter error must not strand the task in-progress: fall
        // back to the legacy pipeline so the normal executor lock + flow runs.
        executorLog.error(
          `[workflow-graph] ${task.id} interpreter threw — falling back to legacy pipeline: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
      if (result.disposition === "fell-back") {
        executorLog.log(`[workflow-graph] ${task.id} fell back to legacy pipeline: ${result.reason}`);
        return false;
      }
      if (result.disposition === "failed") {
        await this.handleGraphFailure(task, result);
      }
      return true;
    } finally {
      this.graphRouting.delete(task.id);
      // Clear per-run step-inversion pins (KTD-8: pinned only for the run's life).
      this.graphStepSessionPinned.delete(task.id);
      this.graphStepRunOnce.delete(task.id);
      // Clear per-run column-agent seam wiring (U4): the resolver and any dangling
      // governing-node-id are scoped to this run only.
      this.graphColumnAgentResolver.delete(task.id);
      this.graphSeamGoverningNodeId.delete(task.id);
      // Per-instance keys: clear every instance slot owned by this task.
      const ctxPrefix = `${task.id}:`;
      for (const key of this.graphStepActiveContext.keys()) {
        if (key.startsWith(ctxPrefix)) this.graphStepActiveContext.delete(key);
      }
    }
  }

  /**
   * Build the store-backed WorkflowBranchPersistence wired into production
   * fan-out runs (#1407/#1412). Returns undefined when the store predates the
   * persistence methods (older embedded DBs) so the runner stays fully
   * in-memory — purely additive. Each adapter method is itself guarded so a
   * mixed/partial store never throws into the run.
   */
  private buildBranchPersistence(): WorkflowBranchPersistence | undefined {
    const store = this.store as unknown as {
      saveWorkflowRunBranch?: (state: WorkflowBranchRunState) => void;
      loadWorkflowRunBranches?: (taskId: string, runId: string) => WorkflowBranchRunState[];
      clearWorkflowRunBranches?: (taskId: string, keepRunId: string) => void;
    };
    if (typeof store.saveWorkflowRunBranch !== "function") return undefined;
    return {
      saveBranchState: (state) => store.saveWorkflowRunBranch?.(state),
      loadBranchStates: (taskId, runId) => store.loadWorkflowRunBranches?.(taskId, runId) ?? [],
      clearStaleBranchStates: (taskId, keepRunId) => store.clearWorkflowRunBranches?.(taskId, keepRunId),
    };
  }

  /**
   * Build the store-backed WorkflowStepInstancePersistence for graph-owned
   * foreach runs (KTD-6, U3/U4 seam). Returns undefined when the store predates
   * the instance CRUD methods (the SQLite migration is U4) so the sub-walk stays
   * fully in-memory — purely additive, same posture as buildBranchPersistence.
   */
  private buildStepInstancePersistence(): WorkflowStepInstancePersistence | undefined {
    const store = this.store as unknown as {
      saveWorkflowRunStepInstance?: (state: WorkflowStepInstanceState) => void;
      loadWorkflowRunStepInstances?: (taskId: string, runId: string) => WorkflowStepInstanceState[];
      clearWorkflowRunStepInstances?: (taskId: string, keepRunId: string) => void;
    };
    if (typeof store.saveWorkflowRunStepInstance !== "function") return undefined;
    return {
      saveInstanceState: (state) => store.saveWorkflowRunStepInstance?.(state),
      loadInstanceStates: (taskId, runId) => store.loadWorkflowRunStepInstances?.(taskId, runId) ?? [],
      clearStaleInstanceStates: (taskId, keepRunId) => store.clearWorkflowRunStepInstances?.(taskId, keepRunId),
    };
  }

  /**
   * Resolve which artifact/parser governs a graph-owned task's step list from its
   * workflow's `parse-steps` declaration (KTD-12). Returns undefined for legacy
   * tasks (no parse-steps node) so reconcile/resume keep their unchanged behavior.
   * Used by reconcile read-through to know which artifact backs the step source.
   */
  private resolveTaskStepSource(ir: WorkflowIr | undefined): { artifact: string; parser: string } | undefined {
    if (!ir) return undefined;
    for (const node of ir.nodes) {
      if (node.kind !== "parse-steps") continue;
      const cfg = (node.config ?? {}) as { artifact?: unknown; parser?: unknown };
      const parser = typeof cfg.parser === "string" ? cfg.parser : undefined;
      if (!parser) continue;
      const artifact = typeof cfg.artifact === "string" && cfg.artifact.trim() !== "" ? cfg.artifact : "PROMPT.md";
      return { artifact, parser };
    }
    return undefined;
  }

  /**
   * Resolve the custom field definitions declared by a task's selected workflow
   * (KTD-13) so the executor prompt can surface the schema and current values to
   * the agent. Pure read; degrades to undefined on any resolution failure (no
   * selection, missing/corrupt definition, older store) so prompt-building never
   * throws and legacy tasks see no custom-fields section.
   */
  private async resolveTaskCustomFieldDefs(taskId: string): Promise<WorkflowFieldDefinition[] | undefined> {
    try {
      const ir = await resolveWorkflowIrForTask(this.store, taskId);
      const fields = ir.version === "v2" ? ir.fields : undefined;
      return fields && fields.length > 0 ? fields : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Build the parse-steps node handler deps (KTD-12, U12): artifact read through
   * the task-documents machinery (PROMPT.md falls back to the task's own PROMPT
   * content the way step-init does), step-list write through the graph-source
   * projection (`updateTask({ steps })`), pin-protection probe (persisted instance
   * rows exist → re-parse illegal, KTD-3), and a logEntry-backed audit sink.
   */
  /**
   * Read a task artifact by key through the task-documents layer, falling back to
   * the task's own PROMPT content for the default `PROMPT.md` step-source artifact
   * (the same source the legacy step-init reads). Shared by the parse-steps and
   * code-node deps (FIX 7: one source of truth for the fallback).
   */
  private async readTaskArtifact(taskId: string, key: string): Promise<string | undefined> {
    // Declared artifacts ride the task-documents layer.
    try {
      const doc = await this.store.getTaskDocument(taskId, key);
      if (doc) return doc.content;
    } catch {
      // Fall through to the PROMPT fallback below.
    }
    if (key === "PROMPT.md") {
      try {
        const detail = await this.store.getTask(taskId);
        if (typeof detail.prompt === "string") return detail.prompt;
      } catch {
        // No PROMPT available.
      }
    }
    return undefined;
  }

  private buildParseStepsDeps(runId?: string): ParseStepsHandlerDeps {
    return {
      readArtifact: (task, key): Promise<string | undefined> => this.readTaskArtifact(task.id, key),
      writeSteps: async (task, steps: TaskStep[]): Promise<void> => {
        await this.store.updateTask(task.id, { steps });
      },
      hasExpandedForeach: async (task): Promise<boolean> => {
        const store = this.store as unknown as {
          loadWorkflowRunStepInstances?: (taskId: string, runId: string) => WorkflowStepInstanceState[];
        };
        if (typeof store.loadWorkflowRunStepInstances !== "function") return false;
        try {
          // Any persisted instance row for THIS run means a foreach has expanded —
          // re-parsing would desynchronize the pinned instance set (KTD-3). Probe
          // under the REAL run id (threaded from maybeExecuteWorkflowGraph) so the
          // pin protection actually fires; fall back to the legacy literal only when
          // the run id was not threaded (older store / no definition).
          const rows = store.loadWorkflowRunStepInstances(task.id, runId ?? `${task.id}:run`);
          return Array.isArray(rows) && rows.length > 0;
        } catch {
          return false;
        }
      },
      audit: (reason, detail) => {
        // The detail string carries the task id (handler convention); emit on the
        // engine log so the routable failure is auditable without a taskId arg.
        executorLog.warn(`[parse-steps] ${reason}: ${detail}`);
      },
    };
  }

  /**
   * Build the code node runner (KTD-15, U14): worktree cwd resolution, pre-read of
   * declared artifacts into the harness ctx, and customFields writes through the
   * U11 validation authority. Drives the esbuild-compile + child-process runner
   * in code-node-runner.ts.
   */
  private buildCodeNodeRunner(): CodeNodeRunner {
    return createCodeNodeRunner({
      resolveCwd: async (task): Promise<string> => {
        try {
          return (await this.store.getTask(task.id)).worktree || this.rootDir;
        } catch {
          return this.rootDir;
        }
      },
      readArtifacts: async (task): Promise<Record<string, string>> => {
        const out: Record<string, string> = {};
        try {
          const docs = await this.store.getTaskDocuments(task.id);
          for (const doc of docs) out[doc.key] = doc.content;
        } catch {
          // No documents — pass an empty artifact map.
        }
        // Surface PROMPT.md from the task prompt when not already a document
        // (shared artifact-read fallback — FIX 7).
        if (out["PROMPT.md"] === undefined) {
          const prompt = await this.readTaskArtifact(task.id, "PROMPT.md");
          if (typeof prompt === "string") out["PROMPT.md"] = prompt;
        }
        return out;
      },
      writeCustomFields: async (task, patch) => {
        if (typeof this.store.updateTaskCustomFields !== "function") {
          return {
            ok: false as const,
            rejection: { code: "no-fields-defined" as const, fieldId: "", detail: "custom fields unsupported by store" },
          };
        }
        const result = await this.store.updateTaskCustomFields(task.id, patch);
        return result.ok ? { ok: true as const } : { ok: false as const, rejection: result.rejection };
      },
      audit: (reason, detail) => {
        executorLog.warn(`[code-node] ${reason}: ${detail}`);
      },
    });
  }

  /**
   * Build the worktree-isolation + ordered-integration + parallel-scheduling deps
   * for a graph-owned foreach (KTD-11, U10). Returns the additive set the
   * WorkflowGraphTaskRunner forwards to the foreach sub-walk:
   *
   *   - `allocateInstanceWorktree(i, base)` — a per-instance worktree on a
   *     canonical `fusion/<task>-step-<i>` branch off `base` (the main tip),
   *     created via the existing `createWorktree` path (the file-scope guard the
   *     session machinery installs applies unchanged to anything the instance
   *     session commits in this worktree — we do NOT bypass it);
   *   - `resolveIntegrationBase()` — the task's main branch tip, re-read before each
   *     (re)allocation so a rework lands on the UPDATED base;
   *   - `integrationGitOps` — rebase the instance branch onto the main branch in
   *     the task's MAIN worktree, fast-forward main on success; on conflict reuse
   *     merger.ts `getConflictedFiles` (NOT reimplemented) and abort the rebase so
   *     the next instance can integrate; `discardBranch` deletes the branch + frees
   *     the instance worktree (pool hygiene);
   *   - `integrationProjection` — projection-first ordering (KTD-7): `markStepDone`
   *     flips the step `done` via `updateStep(source:"graph")` (the dependency-order
   *     guard admits it), THEN `markInstanceIntegrated` flips the persisted row;
   *   - `semaphoreAvailability` — the live free-slot count so parallel scheduling
   *     clamps without hold-and-wait.
   *
   * Best-effort throughout: a git failure routes the foreach to a clean failure
   * (parked for human review) rather than crashing the run.
   */
  private buildForeachWorktreeDeps(task: Task, runId?: string): {
    allocateInstanceWorktree: (
      stepIndex: number,
      base: string | undefined,
    ) => Promise<{ worktreePath: string; branchName: string }>;
    resolveIntegrationBase: () => Promise<string | undefined>;
    integrationGitOps: import("./step-integration.js").IntegrationGitOps;
    integrationProjection: import("./step-integration.js").IntegrationProjection;
    semaphoreAvailability: () => number;
    resumeReconcile: (
      pinned: number,
    ) => Promise<Array<{ stepIndex: number; disposition: "integrated" | "reintegrate" | "rerun"; branchName?: string }>>;
  } {
    const taskId = task.id;
    // Per-instance worktree paths, so discard can free them.
    const instancePaths = new Map<number, string>();

    const mainWorktree = async (): Promise<string> => {
      try {
        return (await this.store.getTask(taskId)).worktree || this.rootDir;
      } catch {
        return this.rootDir;
      }
    };
    const mainBranch = async (): Promise<string> => {
      try {
        const detail = await this.store.getTask(taskId);
        return resolveTaskWorkingBranch(detail);
      } catch {
        return resolveTaskWorkingBranch(task);
      }
    };

    return {
      resolveIntegrationBase: async (): Promise<string | undefined> => {
        // The main branch tip (HEAD of the task's working branch in its worktree).
        try {
          const { stdout } = await execAsync("git rev-parse HEAD", { cwd: await mainWorktree() });
          const sha = stdout.trim();
          return sha.length > 0 ? sha : await mainBranch();
        } catch {
          return await mainBranch();
        }
      },
      allocateInstanceWorktree: async (stepIndex, base): Promise<{ worktreePath: string; branchName: string }> => {
        const branchName = canonicalStepInstanceBranchName(taskId, stepIndex);
        const worktreePath = resolveTaskWorktreePath(
          this.rootDir,
          undefined,
          `${taskId.toLowerCase()}-step-${stepIndex}`,
        );
        // createWorktree installs the file-scope guard (session machinery,
        // unchanged) and branches off `base` (the integration base / updated tip).
        const created = await this.createWorktree(branchName, worktreePath, taskId, base);
        instancePaths.set(stepIndex, created.path);
        return { worktreePath: created.path, branchName: created.branch };
      },
      integrationGitOps: {
        integrate: async (branchName, stepIndex): Promise<import("./step-integration.js").IntegrationAttemptResult> => {
          const cwd = await mainWorktree();
          const target = await mainBranch();
          // The instance branch is checked out in its OWN worktree, so the rebase
          // (which checks out `branchName`) must run THERE — running it from the
          // main worktree fails with "branch is already checked out in another
          // worktree". The final fast-forward merge still runs from the main
          // worktree (it only advances `target`, which is checked out there).
          const instanceCwd = instancePaths.get(stepIndex) ?? cwd;
          try {
            // Rebase the instance branch onto the current main tip (in its own
            // worktree), then ff main from the main worktree.
            await execAsync(`git rebase ${target} ${branchName}`, { cwd: instanceCwd });
            await execAsync(`git checkout ${target}`, { cwd });
            await execAsync(`git merge --ff-only ${branchName}`, { cwd });
            return { kind: "integrated", integratedAt: new Date().toISOString() };
          } catch (err) {
            // Conflict (or other rebase failure): classify via merger helper, abort.
            // The rebase ran in the instance worktree, so conflicts live there and
            // the abort must target that same cwd.
            const conflictedFiles = await getConflictedFiles(instanceCwd);
            try {
              await execAsync("git rebase --abort", { cwd: instanceCwd });
            } catch {
              // best-effort; leave the worktree recoverable.
            }
            // Restore main checkout so the next instance integrates cleanly.
            try {
              await execAsync(`git checkout ${target}`, { cwd });
            } catch {
              // best-effort.
            }
            executorLog.warn(
              `[step-integration] ${taskId} step ${stepIndex} branch ${branchName} conflict: ${err instanceof Error ? err.message : String(err)}`,
            );
            return { kind: "conflict", conflictedFiles };
          }
        },
        discardBranch: async (branchName, stepIndex): Promise<void> => {
          const cwd = await mainWorktree();
          const path = instancePaths.get(stepIndex);
          if (path) {
            // Remove the instance worktree (pool hygiene). Best-effort; force so a
            // dirty/conflicting tree is still cleaned up.
            try {
              await execAsync(`git worktree remove --force "${path}"`, { cwd: this.rootDir });
            } catch {
              // best-effort cleanup.
            }
            instancePaths.delete(stepIndex);
          }
          // Delete the (now-merged or conflicting) branch.
          try {
            await execAsync(`git branch -D ${branchName}`, { cwd });
          } catch {
            // best-effort — the branch may already be gone.
          }
        },
      },
      integrationProjection: {
        markStepDone: async (stepIndex): Promise<void> => {
          // Projection-first (KTD-7): graph-source write relaxes the guard to
          // dependency order; predecessors are integrated (done) by construction.
          await this.store.updateStep(taskId, stepIndex, "done", { source: "graph" });
        },
        markInstanceIntegrated: async (stepIndex, integratedAt, identity): Promise<void> => {
          const store = this.store as unknown as {
            saveWorkflowRunStepInstance?: (state: WorkflowStepInstanceState) => void;
            loadWorkflowRunStepInstances?: (taskId: string, runId: string) => WorkflowStepInstanceState[];
          };
          if (typeof store.saveWorkflowRunStepInstance !== "function") return;
          // The upsert is keyed by (taskId, runId, foreachNodeId, stepIndex). The
          // queue passes the REAL identity (the same runId + foreachNodeId the
          // foreach sub-walk persisted the row under) so this FLIPS the existing
          // row to completed/integratedAt instead of writing an orphan (FIX 1).
          // Load the current row to preserve its fields (currentNodeId, baseline,
          // reworkCount) we don't otherwise carry on the identity.
          let existing: WorkflowStepInstanceState | undefined;
          try {
            const rows = store.loadWorkflowRunStepInstances?.(taskId, identity.runId) ?? [];
            existing = rows.find(
              (r) => r.foreachNodeId === identity.foreachNodeId && r.stepIndex === stepIndex,
            );
          } catch {
            // Best-effort read; fall back to a minimal flip below.
          }
          try {
            store.saveWorkflowRunStepInstance({
              ...(existing ?? {}),
              taskId,
              runId: identity.runId,
              foreachNodeId: identity.foreachNodeId,
              stepIndex,
              pinnedStepCount: identity.pinnedStepCount,
              currentNodeId: existing?.currentNodeId ?? "",
              status: "completed",
              reworkCount: existing?.reworkCount ?? 0,
              branchName: identity.branchName || canonicalStepInstanceBranchName(taskId, stepIndex),
              integratedAt,
            } as WorkflowStepInstanceState);
          } catch {
            // Persistence is additive bookkeeping — never fail the integration.
          }
        },
      },
      semaphoreAvailability: (): number => this.options.semaphore?.availableCount ?? 1,
      resumeReconcile: async (
        pinned,
      ): Promise<Array<{ stepIndex: number; disposition: "integrated" | "reintegrate" | "rerun"; branchName?: string }>> => {
        // Crash-resume reconciliation (KTD-11): reconcile each persisted instance
        // row against branch existence. integrated → done; branch exists not
        // integrated → re-enter the integration queue; branch missing → re-run.
        // NOTE (handoff): this is the per-run resume seeding only; the full
        // self-healing sweep across stale runs (recoverStaleTransitionPending
        // analogue) is out of scope for U10.
        const store = this.store as unknown as {
          loadWorkflowRunStepInstances?: (taskId: string, runId: string) => WorkflowStepInstanceState[];
        };
        if (typeof store.loadWorkflowRunStepInstances !== "function") return [];
        let rows: WorkflowStepInstanceState[] = [];
        try {
          // Load under the REAL run id (threaded) so resume actually sees the rows
          // the sub-walk persisted; the legacy literal is the unthreaded fallback.
          rows = store.loadWorkflowRunStepInstances(taskId, runId ?? `${taskId}:run`) ?? [];
        } catch {
          return [];
        }
        const cwd = await mainWorktree();
        const out: Array<{ stepIndex: number; disposition: "integrated" | "reintegrate" | "rerun"; branchName?: string }> = [];
        for (const row of rows) {
          if (row.stepIndex < 0 || row.stepIndex >= pinned) continue;
          if (row.status === "completed" || row.integratedAt) {
            out.push({ stepIndex: row.stepIndex, disposition: "integrated" });
            continue;
          }
          const branchName = row.branchName || canonicalStepInstanceBranchName(taskId, row.stepIndex);
          let branchExists = false;
          try {
            await execAsync(`git rev-parse --verify --quiet ${branchName}`, { cwd });
            branchExists = true;
          } catch {
            branchExists = false;
          }
          if (branchExists && row.status === "awaiting-integration") {
            out.push({ stepIndex: row.stepIndex, disposition: "reintegrate", branchName });
          } else {
            out.push({ stepIndex: row.stepIndex, disposition: "rerun" });
          }
        }
        return out;
      },
    };
  }

  /**
   * RETHINK reset-on-rework (KTD-4, U5): reset the active foreach instance's step
   * to its per-step baseline before the rework edge re-enters step-execute. Drives
   * the single extracted `resetStepToBaseline` (step-runner.ts) with the
   * instance's persisted `baselineSha`/`checkpointId`. Session rewind is best-effort
   * for graph-owned runs (the per-step session lives inside StepSessionExecutor and
   * is not exposed as a single ref here) — missing-checkpoint partial recovery is
   * the documented KTD-2 semantics; the git reset + step→pending are authoritative.
   */
  private async applyGraphRethinkReset(taskId: string, active: ForeachActiveContext): Promise<void> {
    // Clear the memoized implementation pass so the next `runGraphTaskStep`
    // re-executes (T9): the per-run pass is memoized in `graphStepRunOnce` keyed
    // by task id and is normally only cleared on REJECTION. A RETHINK fires AFTER
    // a SUCCESSFUL pass (a review verdict resets git/step state via this reset),
    // so without clearing the memo the rework re-awaits the already-resolved
    // promise and implementation never re-runs — leaving the instance permanently
    // pending or falsely successful under `deferDoneToReview`. Mirrors the
    // rejection-clear guard: only delete the memo when the stored promise is the
    // SETTLED pass (a fresh in-flight attempt another caller installed is left
    // untouched). At rethink time the pass under review has already resolved, so
    // checking settled-ness avoids clobbering a concurrent re-dispatch.
    const memo = this.graphStepRunOnce.get(taskId);
    if (memo) {
      let settled = false;
      await Promise.race([memo.then(
        () => { settled = true; },
        () => { settled = true; },
      ), Promise.resolve()]);
      if (settled && this.graphStepRunOnce.get(taskId) === memo) {
        this.graphStepRunOnce.delete(taskId);
      }
    }
    // Worktree isolation (KTD-11): reset the instance's OWN branch/worktree only —
    // sibling instances and the integration base are untouched, so the blast-radius
    // guard is STRUCTURAL (skipped) in this mode. Shared isolation resets the task's
    // main worktree and keeps the KTD-2 ancestry guard as written.
    const branchScoped = typeof active.worktreePath === "string" && active.worktreePath.length > 0;
    let worktreePath = active.worktreePath ?? this.rootDir;
    if (!branchScoped) {
      try {
        worktreePath = (await this.store.getTask(taskId)).worktree || this.rootDir;
      } catch {
        // Best-effort worktree resolution; fall back to rootDir.
      }
    }
    const liveSteps = await this.store.getTask(taskId).then((t) => t.steps).catch(() => []);
    await resetStepToBaseline(
      {
        store: this.store,
        worktreePath,
        // No single session ref for graph-owned step-sessions — rewind is skipped
        // when checkpointId resolves but no session is current (KTD-2 partial path).
        sessionRef: { current: null },
        reviewType: "code",
        // Branch-scoped RETHINK under worktree isolation makes the guard structural
        // (the reset can only touch the instance's own branch); shared isolation
        // keeps the defensive ancestry guard (KTD-2/KTD-11).
        blastRadiusGuard: branchScoped
          ? undefined
          : makeAncestryBlastRadiusGuard({
              worktreePath,
              task: { id: taskId, steps: liveSteps },
              stepIndex: active.stepIndex,
            }),
      },
      { id: taskId, steps: liveSteps },
      active.stepIndex,
      active.baselineSha,
      active.checkpointId,
    );
  }

  /**
   * Dual-observe parity (CU-U5): for a workflow-selected task, compare the
   * selected graph's routing against the legacy authoritative run for the SAME
   * task and record the result as workflow:parity-observed / -drift audit
   * events. Observe-only — the shadow walks the graph with no-side-effect seams
   * driven by the legacy task's actual outcomes, so it never mutates anything.
   * Gated by workflowInterpreterDualObserve (off by default) and fully isolated
   * (never throws into the caller). Hooked at the post-execute handoff point.
   *
   * Scope: this validates execute→review→merge ROUTING parity. Full
   * execution-fidelity parity (a real isolated shadow run) is future work.
   */
  private async maybeObserveWorkflowParity(taskId: string, settings: Settings): Promise<void> {
    if (!isExperimentalFeatureEnabled(settings, WORKFLOW_INTERPRETER_DUAL_OBSERVE_FLAG)) return;
    if (typeof this.store.getTaskWorkflowSelection !== "function") return;
    try {
      const selection = this.store.getTaskWorkflowSelection(taskId);
      if (!selection) return;
      const def = await this.store.getWorkflowDefinition?.(selection.workflowId);
      if (!def) return;
      const live = await this.store.getTask(taskId);

      const legacyObs = buildWorkflowObservationFromTask(
        {
          column: live.column,
          status: live.status ?? null,
          review: live.review as { verdict?: string } | null,
          mergeDetails: live.mergeDetails as { outcome?: string } | null,
        },
        { columnSequence: this.inferLegacyColumnSequence(live.column) },
      );
      const legacyAudit = typeof this.store.getRunAuditEvents === "function"
        ? this.store.getRunAuditEvents({ taskId })
        : [];

      await observeWorkflowParity({
        settings,
        store: this.store,
        agentId: "workflow-shadow",
        legacy: { taskId, observation: legacyObs, auditEvents: legacyAudit },
        runShadow: async () => ({
          observation: await this.buildShadowObservation(live, def, settings, legacyObs),
          auditEvents: [],
        }),
      });
    } catch (err) {
      executorLog.warn(
        `${taskId}: dual-observe parity skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Canonical column path a legacy run took to reach its terminal column
   *  (excluding the pre-execute todo/triage prefix so it lines up with the
   *  graph's execute→review→merge seam nodes). */
  private inferLegacyColumnSequence(terminalColumn: string): string[] {
    switch (terminalColumn) {
      case "done": return ["in-progress", "in-review", "done"];
      case "in-review": return ["in-progress", "in-review"];
      case "in-progress": return ["in-progress"];
      default: return [terminalColumn];
    }
  }

  /** Build the interpreter-side observation by walking the selected graph with
   *  no-side-effect seams whose outcomes mirror the legacy task's reality. */
  private async buildShadowObservation(
    live: TaskDetail,
    def: { ir: { nodes: Array<{ id: string; kind: string; config?: Record<string, unknown> }> } },
    settings: Settings,
    legacyObs: WorkflowRunObservation,
  ): Promise<WorkflowRunObservation> {
    const reachedReview = live.column === "in-review" || live.column === "done";
    const merged = live.column === "done";
    const verdict = (live.review as { verdict?: string } | undefined)?.verdict;
    const outcome = (ok: boolean): WorkflowNodeResult => ({ outcome: ok ? "success" : "failure" });
    const seams: WorkflowLegacySeams = {
      planning: async () => outcome(true),
      execute: async () => outcome(reachedReview || merged),
      review: async () => outcome(verdict !== "REVISE"),
      merge: async () => outcome(merged),
      schedule: async () => outcome(true),
    };
    const runner = new WorkflowGraphTaskRunner({
      store: this.store,
      seams,
      runCustomNode: async () => outcome(true),
    });
    const result = await runner.run(live, settings);

    const stageByNodeId = new Map<string, WorkflowStage>();
    for (const node of def.ir.nodes) {
      const seam = typeof node.config?.seam === "string" ? node.config.seam : undefined;
      if (seam === "execute" || seam === "review" || seam === "merge") {
        stageByNodeId.set(node.id, seam);
      }
    }
    // Stop the shadow walk at the live terminal seam. The graph walker visits a
    // node *before* invoking its seam, so even a failing merge seam (the case
    // when the live task is parked in-review with autoMerge off) still records a
    // "merge" stage. The legacy side never reports merge for an in-review task,
    // so that phantom stage manufactures stageTransitions drift on healthy runs.
    // Truncate the visited-stage sequence at the stage the live task actually
    // reached: merged → merge, reachedReview → review, else → execute.
    const terminalStage: WorkflowStage = merged ? "merge" : reachedReview ? "review" : "execute";
    const stages: WorkflowStage[] = [];
    for (const nodeId of result.visitedNodeIds) {
      const stage = stageByNodeId.get(nodeId);
      if (!stage || stages[stages.length - 1] === stage) continue;
      stages.push(stage);
      if (stage === terminalStage) break;
    }

    return buildWorkflowObservation({
      stageTransitions: stages,
      terminalColumn: result.disposition === "completed" ? (merged ? "done" : "in-review") : live.column,
      terminalStatus: live.status ?? null,
      reviewVerdict: legacyObs.reviewVerdict,
      mergeOutcome: merged ? "merged" : null,
    });
  }

  /**
   * Run ONLY the implementation phase of execute() for a graph-driven task —
   * full legacy setup plus the agent session up to fn_task_done. The registered
   * interceptor makes execute() stop at the completion boundary instead of
   * running workflow steps and the review handoff.
   */
  private async runImplementationPhase(task: Task): Promise<{ taskDone: boolean; modifiedFiles: string[] }> {
    let captured: { taskDone: boolean; modifiedFiles: string[] } = { taskDone: false, modifiedFiles: [] };
    this.graphCompletionInterceptors.set(task.id, (info) => {
      captured = { taskDone: true, modifiedFiles: info.modifiedFiles };
    });
    try {
      await this.execute(task);
    } finally {
      this.graphCompletionInterceptors.delete(task.id);
    }
    return captured;
  }

  /**
   * Step-inversion per-step driver (KTD-2/KTD-8, closes the U3 interim gap).
   *
   * The U3 stand-in ran `runImplementationPhase` once per foreach instance, which
   * re-ran the whole implementation for every step. The real driver:
   *
   *   1. PINS step-session physics for the run (graph-owned runs force
   *      StepSessionExecutor regardless of `runStepsInNewSessions`, KTD-2/KTD-8) —
   *      the only path with a discrete per-step boundary (`onStepStart`/
   *      `onStepComplete`); the monolithic single-session path has no "run one
   *      step and return control" seam.
   *   2. Drives the (step-session) implementation phase exactly ONCE per run,
   *      memoized by task id. StepSessionExecutor itself walks every step in step
   *      order inside that single pass and writes the projection per step via its
   *      `onStepStart`/`onStepComplete` callbacks (executor.ts step-session path).
   *      Each foreach instance's `runTaskStep` therefore observes the projection
   *      truth for its step rather than re-running the agent per step.
   *
   * Worktree/taskEnv/agent/semaphore state is threaded exactly the way
   * `runImplementationPhase` gets it — by re-entering `execute()` under a
   * completion interceptor — because that state is assembled inside `execute()`
   * and is not available standalone at createGraphSeams time (the plan's
   * documented threading approach for full step-session wiring).
   *
   * Returns whether the targeted step ended up `done`/`skipped` in the projection.
   */
  private async runGraphTaskStep(
    task: Task,
    stepIndex: number,
    instanceId?: string,
    governingNodeId?: string,
  ): Promise<{ success: boolean; error?: string }> {
    // Pin step-session physics for the run before the implementation pass.
    this.graphStepSessionPinned.add(task.id);

    // Single-flight per attempt (KTD-2/KTD-8): the implementation phase runs once
    // per run, memoized by task id, so each foreach instance's `runStep` observes
    // the projection rather than re-running the agent. A REJECTED phase must NOT
    // poison later attempts: a rework cycle re-enters `runStep` and would otherwise
    // re-await the same stored rejection forever, so the implementation is never
    // retried. On rejection we therefore clear the memo entry so the NEXT call
    // (the rework re-run) re-invokes the implementation phase. Concurrent
    // in-flight callers within a single attempt still share the one promise.
    let phase = this.graphStepRunOnce.get(task.id);
    if (!phase) {
      // Column-agent governing-node ownership (PR #1432 review): the slot is
      // written ONLY by the caller that CREATES the memoized pass, and cleared
      // when that pass settles. One step-session pass serves every foreach
      // instance, so the session-identity binding is the pass-INITIATING
      // instance's — deterministic, instead of concurrent seam invocations
      // racing set/delete on a shared per-task slot (parallel foreach could
      // otherwise stamp another instance's node mid-build or clear it before
      // the session resolved the binding).
      if (typeof governingNodeId === "string") {
        this.graphSeamGoverningNodeId.set(task.id, governingNodeId);
      }
      phase = this.runImplementationPhase(task);
      this.graphStepRunOnce.set(task.id, phase);
      void phase
        .catch(() => undefined)
        .finally(() => {
          // Clear only our own stamp — a rework re-run may have installed a new one.
          if (typeof governingNodeId === "string" && this.graphSeamGoverningNodeId.get(task.id) === governingNodeId) {
            this.graphSeamGoverningNodeId.delete(task.id);
          }
        });
    }
    try {
      await phase;
    } catch (err) {
      // Clear the poisoned memo so a rework cycle can retry the implementation
      // (only if it is still the same rejected promise — do not clobber a fresh
      // attempt another caller may have already installed).
      if (this.graphStepRunOnce.get(task.id) === phase) {
        this.graphStepRunOnce.delete(task.id);
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    // Consult the projection (the single source of truth, KTD-7) for this step's
    // terminal state. The step-session pass marks each step done/skipped as it
    // completes; a step-review node (when present) decides done-ness instead.
    try {
      const live = await this.store.getTask(task.id);
      const active = this.foreachActiveForTask(task.id, instanceId);
      const status = live.steps[stepIndex]?.status;
      if (status === "done" || status === "skipped") return { success: true };
      // Step not terminal after the pass: when a review will author done-ness
      // (deferDoneToReview), the pass having RUN is the success signal — the review
      // gates the projection write. Otherwise the implementation pass failed to
      // complete this step, so report failure rather than masking it (FIX 3: the
      // prior code returned success on both branches, hiding step-session failures).
      if (active?.deferDoneToReview === true) return { success: true };
      return {
        success: false,
        error: `step ${stepIndex} not completed by implementation pass (status: ${status ?? "unknown"})`,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Read the active foreach instance context for a graph-owned task (if any) so
   *  the step driver can honor `deferDoneToReview`. The active context is threaded
   *  through the foreach sub-walk; we surface it via a per-task slot the
   *  step-execute seam stamps. Returns undefined outside a foreach instance. */
  private foreachActiveForTask(taskId: string, instanceId?: string): ForeachActiveContext | undefined {
    if (typeof instanceId === "string") {
      const byInstance = this.graphStepActiveContext.get(this.graphActiveContextKey(taskId, instanceId));
      if (byInstance) return byInstance;
    }
    // Fallback (single-instance / no instanceId threaded): return the sole slot
    // owned by this task if exactly one exists.
    const prefix = `${taskId}:`;
    let only: ForeachActiveContext | undefined;
    for (const [key, value] of this.graphStepActiveContext) {
      if (!key.startsWith(prefix)) continue;
      if (only) return undefined; // ambiguous: more than one instance active
      only = value;
    }
    return only;
  }

  /** Seam implementations delegating to the legacy engine (KTD-1: delegate, never reimplement). */
  private createGraphSeams(_settings: Settings): WorkflowLegacySeams {
    return {
      // Built-in triage/spec generation runs upstream of the interpreter today,
      // so planning is a no-op for already-specified tasks. Custom planning
      // behavior is expressed as a custom prompt node before the execute seam.
      planning: async () => ({ outcome: "success", value: "pre-specified" }),
      execute: async (seamTask, context) => {
        // Column-agent seam wiring (U4, R4): record the governing node id (the
        // execute-seam prompt node, stamped into context by createPromptLikeHandler)
        // so execute()'s session build can resolve the column-agent binding for the
        // node's DECLARED column. Cleared after the pass so a later seam without a
        // binding cannot inherit a stale node id.
        const governingNodeId = context?.[SEAM_GOVERNING_NODE_CONTEXT_KEY];
        if (typeof governingNodeId === "string") {
          this.graphSeamGoverningNodeId.set(seamTask.id, governingNodeId);
        }
        let result: { taskDone: boolean; modifiedFiles: string[] };
        try {
          result = await this.runImplementationPhase(seamTask);
        } finally {
          this.graphSeamGoverningNodeId.delete(seamTask.id);
        }
        if (result.taskDone) {
          return { outcome: "success", value: "implemented" };
        }
        // Distinguish pause/abort from genuine implementation failure so the
        // failure handler can leave paused tasks to the pause machinery.
        let paused = this.pausedAborted.has(seamTask.id);
        if (!paused) {
          try {
            paused = Boolean((await this.store.getTask(seamTask.id)).paused);
          } catch {
            // Best-effort pause probe; fall through to the failure value.
          }
        }
        return {
          outcome: "failure",
          value: paused ? "implementation-paused" : "implementation-incomplete",
        };
      },
      review: async (seamTask) => {
        // The legacy "review" stage is the in-review handoff: per-step AI review
        // already ran during implementation (fn_review_step), and the in-review
        // column is the staging state the merge queue consumes.
        const live = await this.store.getTask(seamTask.id);
        await this.persistTokenUsage(seamTask.id);
        await this.handoffTaskToReview(live, "workflow-graph-review");
        return { outcome: "success", value: "in-review" };
      },
      merge: async (seamTask) => {
        if (!this.mergeRequester) {
          return { outcome: "failure", value: "merge-unavailable" };
        }
        // Bound the wait: a wedged merge queue must not strand the graph walk
        // holding the routing claim. On timeout the run fails cleanly and the
        // task is parked for human review; the queue can still finish later.
        const GRAPH_MERGE_TIMEOUT_MS = 30 * 60 * 1000;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((resolve) => {
          timeoutHandle = setTimeout(() => resolve("timeout"), GRAPH_MERGE_TIMEOUT_MS);
          timeoutHandle.unref?.();
        });
        try {
          const result = await Promise.race([this.mergeRequester(seamTask.id), timeout]);
          if (result === "timeout") {
            executorLog.warn(`${seamTask.id}: graph merge seam timed out after ${GRAPH_MERGE_TIMEOUT_MS}ms`);
            return { outcome: "failure", value: "merge-timeout" };
          }
          if (result.merged || result.noOp) {
            return { outcome: "success", value: result.noOp ? "merge-noop" : "merged" };
          }
          return { outcome: "failure", value: result.reason ?? result.error ?? "merge-failed" };
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
      },
      schedule: async () => ({ outcome: "success" }),
      // Step-inversion (KTD-2/KTD-4, U3): run exactly the foreach-active step.
      // The foreach sub-walk has set `foreach:active` with the step index; here
      // we drive runTaskStep (step-runner.ts) over the task's worktree, then
      // capture the per-step baselineSha/checkpointId back INTO the active
      // context object so a later RETHINK (U5) can reset the step. The full
      // single-step session physics (a StepSessionExecutor scoped to one step)
      // is U5/U7 territory; U3 wires the seam and the context capture, using the
      // existing implementation phase as the single-pass step driver.
      stepExecute: async (seamTask, context) => {
        const active = context[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext | undefined;
        if (!active || typeof active.stepIndex !== "number") {
          return { outcome: "failure", value: "no-active-step-instance" };
        }
        const live = await this.store.getTask(seamTask.id);
        // Worktree isolation (KTD-11, U10): run the instance's session in ITS OWN
        // worktree when the foreach allocated one; otherwise the task's main
        // worktree (shared isolation — unchanged). The file-scope guard the session
        // machinery installs applies to either worktree unchanged (not bypassed).
        const worktreePath = active.worktreePath || live.worktree || this.rootDir;
        // Stamp the active instance so `runGraphTaskStep` can honor
        // `deferDoneToReview` when judging a non-terminal step (FIX 3).
        this.graphStepActiveContext.set(this.graphActiveContextKey(seamTask.id, active.instanceId), active);
        // Column-agent seam wiring (U4, R4): the governing node id — the foreach
        // INSTANCE node id (`<foreachId>#<i>:<templateNodeId>`) stamped into
        // context by createPromptLikeHandler — threads INTO runGraphTaskStep,
        // which stamps the per-task slot only when it CREATES the memoized
        // implementation pass and clears it when that pass settles (PR #1432
        // review). One step-session pass serves every instance, so the
        // session-identity binding is deterministically the pass-initiating
        // instance's; per-invocation set/delete here would race under parallel
        // foreach (overwrite mid-build, or clear while the shared pass is live).
        const stepGoverningNodeId = context[SEAM_GOVERNING_NODE_CONTEXT_KEY];
        const result: Awaited<ReturnType<typeof runTaskStep>> = await runTaskStep(
          {
            store: this.store,
            worktreePath,
            // U6/U8: per-step session physics — graph-owned runs force
            // step-session mode for the run (KTD-2/KTD-8) regardless of the
            // runStepsInNewSessions setting. The agent authors the step's commit;
            // this driver only observes (KTD-2). Thread the instanceId so the
            // active-context read is per-instance (parallel-foreach safe).
            runStep: (stepIndex) =>
              this.runGraphTaskStep(
                seamTask,
                stepIndex,
                active.instanceId,
                typeof stepGoverningNodeId === "string" ? stepGoverningNodeId : undefined,
              ),
          },
          { id: seamTask.id, steps: live.steps },
          active.stepIndex,
          {
            // Single-authority done-marking (U6/KTD-4): when the foreach template
            // has a step-review node, leave the step in-progress so the review's
            // APPROVE marks it done (the review is the single done authority).
            markDoneOnSuccess: active.deferDoneToReview !== true,
          },
        );
        // Capture baseline/checkpoint back into the reserved active context so the
        // foreach sub-walk threads them to later template nodes (step-review/reset).
        active.baselineSha = result.baselineSha;
        active.checkpointId = result.checkpointId;
        return {
          outcome: result.outcome,
          value: result.outcome === "success" ? "step-done" : "step-failed",
          contextPatch: {
            [FOREACH_ACTIVE_CONTEXT_KEY]: active,
          },
        };
      },
      // Step-inversion (KTD-4, U5): review the foreach-active step. Mirrors the
      // in-session fn_review_step call (executor.ts createReviewStepTool): run
      // reviewStep under semaphore.runNested against the instance's step number/
      // name and the task's PROMPT content. On an authoritative (non-advisory)
      // APPROVE, mark the step done through the projection (updateStep, KTD-7) —
      // the step-execute seam left it in-progress (markDoneOnSuccess:false) so the
      // review is the single done authority. The handler maps the returned verdict
      // to outcome edges and applies the UNAVAILABLE bounded-retry limiter.
      stepReview: async (seamTask, context, config) => {
        const active = context[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext | undefined;
        if (!active || typeof active.stepIndex !== "number") {
          // No active instance — surface UNAVAILABLE so the handler routes it
          // rather than fabricating an authoritative verdict.
          return { verdict: "UNAVAILABLE", review: "no active step instance" };
        }
        const stepIndex = active.stepIndex;
        const detail = await this.store.getTask(seamTask.id);
        // Worktree isolation (KTD-11): review the instance's OWN worktree when set.
        const worktreePath = active.worktreePath || detail.worktree || this.rootDir;
        const stepName = detail.steps[stepIndex]?.name ?? `Step ${stepIndex + 1}`;
        const promptContent = detail.prompt ?? "";
        // Merge per-task effective workflow settings (U3, KTD-3) so the validator
        // model-lane reads below pick up workflow values. Behavior-inert by default.
        const settings = await mergeEffectiveSettings(this.store, detail, await this.store.getSettings());

        const sem = this.options.semaphore;
        const invokeReviewer = () =>
          reviewStep(
            worktreePath,
            seamTask.id,
            stepIndex + 1, // reviewStep is 1-indexed (matches fn_review_step)
            stepName,
            config.type,
            promptContent,
            // Code reviews diff against the per-step baseline captured at
            // step-execute; plan reviews pass no baseline (advisory).
            config.type === "code" ? active.baselineSha : undefined,
            {
              defaultProvider: settings.defaultProvider,
              defaultModelId: settings.defaultModelId,
              fallbackProvider: settings.fallbackProvider,
              fallbackModelId: settings.fallbackModelId,
              defaultThinkingLevel: detail.thinkingLevel ?? settings.defaultThinkingLevel,
              taskValidatorProvider: detail.validatorModelProvider,
              taskValidatorModelId: detail.validatorModelId,
              projectValidatorProvider: settings.validatorProvider,
              projectValidatorModelId: settings.validatorModelId,
              projectValidatorFallbackProvider: settings.validatorFallbackProvider,
              projectValidatorFallbackModelId: settings.validatorFallbackModelId,
              globalValidatorProvider: settings.validatorGlobalProvider,
              globalValidatorModelId: settings.validatorGlobalModelId,
              projectDefaultOverrideProvider: settings.defaultProviderOverride,
              projectDefaultOverrideModelId: settings.defaultModelIdOverride,
              store: this.store,
              taskId: seamTask.id,
              task: detail,
              agentPrompts: settings.agentPrompts,
              agentStore: this.options.agentStore,
              rootDir: this.rootDir,
              settings,
              onSessionCreated: (s) => this.registerSubagentSession(seamTask.id, s),
              onSessionEnded: (s) => this.unregisterSubagentSession(seamTask.id, s),
            },
          );

        let review: { verdict: ReviewVerdict; review: string; summary: string };
        try {
          review = sem ? await sem.runNested(invokeReviewer) : await invokeReviewer();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          reviewerLog.error(`${seamTask.id}: step-review failed: ${message}`);
          return { verdict: "UNAVAILABLE", review: `reviewer error: ${message}` };
        }

        await this.store.logEntry(
          seamTask.id,
          `${config.type} step-review Step ${stepIndex + 1}: ${review.verdict}${config.advisory ? " (advisory)" : ""}`,
          review.summary,
        );

        // Single-writer rule (KTD-4): advisory (split-branch) reviews never write
        // the projection — they are fan-out checks that cannot clobber the
        // authoritative verdict. Only an on-path APPROVE marks the step done.
        if (review.verdict === "APPROVE" && !config.advisory) {
          try {
            const cur = await this.store.getTask(seamTask.id);
            const status = cur.steps[stepIndex]?.status;
            if (stepIndex >= 0 && stepIndex < cur.steps.length && status !== "done" && status !== "skipped") {
              await this.updateStepGraph(seamTask.id, stepIndex, "done");
              await this.store.logEntry(
                seamTask.id,
                `Step ${stepIndex + 1} (${stepName}) marked done by step-review APPROVE (graph)`,
              );
            }
          } catch (err) {
            reviewerLog.warn(
              `${seamTask.id}: failed to mark Step ${stepIndex + 1} done after APPROVE: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        return { verdict: review.verdict, review: review.review, summary: review.summary };
      },
    };
  }

  /**
   * Graph-source projection write (U6/KTD-7): a thin wrapper over
   * `store.updateStep` that tags the write with `source: "graph"` when the store
   * supports it (additive) so the out-of-order-done guard relaxes to dependency
   * order and a suppressed write audits loudly instead of silently. Falls back to
   * the legacy single-arg call on older stores.
   */
  private async updateStepGraph(
    taskId: string,
    stepIndex: number,
    status: import("@fusion/core").StepStatus,
  ): Promise<void> {
    const store = this.store as unknown as {
      updateStep: (
        id: string,
        idx: number,
        status: import("@fusion/core").StepStatus,
        opts?: { source?: "graph" },
      ) => Promise<unknown>;
    };
    await store.updateStep(taskId, stepIndex, status, { source: "graph" });
  }

  /**
   * Pause the graph for user input: park the task paused with status
   * "awaiting-user-input" and the node's question as pausedReason. On a later
   * re-run (after the user unpauses), consume the newest steering comment as
   * the answer. Pre-execute placement is fully supported; post-execute
   * placement re-walks earlier read-only nodes until CU-U5 checkpoints land.
   */
  private async runAwaitInputNode(node: WorkflowIrNode, live: TaskDetail): Promise<WorkflowNodeResult> {
    const question = typeof node.config?.prompt === "string" && node.config.prompt.trim()
      ? node.config.prompt.trim()
      : "This workflow is waiting for your input.";
    const marker = `workflow-input:${node.id}`;

    const steering = Array.isArray(live.steeringComments) ? live.steeringComments : [];
    // Resume only when THIS node previously paused the task (its marker is on
    // pausedReason). A pre-existing steering comment (e.g. one added at task
    // creation) must never short-circuit the pause on the node's first run —
    // otherwise the node consumes a stale comment and never asks the user.
    const pausedReason = live.pausedReason ?? "";
    const pausedByThisNode = pausedReason.startsWith(marker);
    if (!live.paused && pausedByThisNode) {
      // Correlate the reply to THIS pause: the marker embeds a watermark
      // (`${marker}@${pauseEpochMs}: …`) recorded when the node paused. Only
      // count steering comments created at/after that watermark as the answer,
      // so an unpause-without-reply can't consume a comment that predates the
      // pause. The watermark is epoch milliseconds (colon-free) so it never
      // collides with the `:` that separates the marker from the question, nor
      // with the dashboard's colon-delimited question parser.
      const watermark = (() => {
        const m = pausedReason.slice(marker.length).match(/^@(\d+)/);
        const t = m ? Number(m[1]) : NaN;
        return Number.isFinite(t) ? t : undefined;
      })();
      const replies = watermark === undefined
        ? steering
        : steering.filter((c) => {
            const created = Date.parse((c as { createdAt?: string }).createdAt ?? "");
            return Number.isFinite(created) ? created >= watermark : false;
          });
      if (replies.length > 0) {
        // Input has arrived (user replied and unpaused): consume the latest
        // post-pause comment and clear this node's marker so a future fresh
        // visit re-asks instead of silently consuming a stale comment.
        const latest = replies[replies.length - 1] as { text?: string; comment?: string };
        const answer = (latest?.text ?? latest?.comment ?? "").toString();
        await this.store.updateTask(live.id, { status: null, pausedReason: null }, this.getRunContextFor(live.id));
        await this.store.logEntry(live.id, `Workflow input received for node '${node.id}'`, undefined, this.getRunContextFor(live.id));
        return { outcome: "success", value: "input-received", contextPatch: { [`input:${node.id}`]: answer } };
      }
      // Unpaused but no post-pause reply yet — re-park below and keep waiting.
    }

    await this.store.logEntry(live.id, `Workflow paused for user input: ${question}`, undefined, this.getRunContextFor(live.id));
    await this.store.updateTask(
      live.id,
      { status: "awaiting-user-input", paused: true, pausedReason: `${marker}@${Date.now()}: ${question}` },
      this.getRunContextFor(live.id),
    );
    // Failure outcome ends the walk; handleGraphFailure leaves paused tasks
    // untouched, so the task sits awaiting input until the user responds.
    return { outcome: "failure", value: "awaiting-user-input" };
  }

  /** Pause the task for explicit user approval of a raw CLI command. The user
   *  approves via the dashboard, which records the command and unpauses; on the
   *  next run isWorkflowCliCommandApproved returns true and the node executes. */
  private async pauseForCliApproval(node: WorkflowIrNode, live: TaskDetail, command: string): Promise<WorkflowNodeResult> {
    const marker = `workflow-cli-approval:${node.id}`;
    await this.store.logEntry(live.id, `Workflow paused for CLI command approval: ${command}`, undefined, this.getRunContextFor(live.id));
    await this.store.updateTask(
      live.id,
      { status: "awaiting-cli-approval", paused: true, pausedReason: `${marker}: ${command}` },
      this.getRunContextFor(live.id),
    );
    return { outcome: "failure", value: "awaiting-cli-approval" };
  }

  /** Run an arbitrary (approved) CLI command in the task worktree, supervised. */
  private async runRawCliCommand(
    task: TaskDetail,
    label: string,
    command: string,
    worktreePath: string,
    extraEnv?: NodeJS.ProcessEnv,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    executorLog.log(`${task.id}: workflow node '${label}' executing approved CLI command: ${command}`);
    await this.store.logEntry(task.id, `Workflow node '${label}' executing CLI command: ${command}`, undefined, this.getRunContextFor(task.id));
    const abort = new AbortController();
    this.registerConfiguredCommandController(task.id, abort);
    try {
      const result = await runConfiguredCommand(
        command,
        worktreePath,
        120_000,
        extraEnv,
        createRunAuditor(this.store, {
          runId: this.getRunContextFor(task.id)?.runId ?? generateSyntheticRunId("exec-cli", task.id),
          agentId: this.getRunContextFor(task.id)?.agentId ?? (task.assignedAgentId ?? "executor"),
          taskId: task.id,
          phase: "execute",
        }),
        abort.signal,
      );
      if (abort.signal.aborted) throw this.createConfiguredCommandAbortError(task.id, command);
      if (result.spawnError || result.timedOut || result.exitCode !== 0) {
        return { success: false, error: configuredCommandErrorMessage(result) };
      }
      return { success: true, output: `CLI command completed successfully` };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.unregisterConfiguredCommandController(task.id, abort);
    }
  }

  /** Build the persona prefix for an agent from its TYPED identity fields (KTD-6).
   *  Reads `soul` and `instructionsText` — the fields the `Agent` type actually
   *  exposes (`packages/core/src/types.ts`) — and joins them. The custom-node
   *  `"agent"` branch historically read a non-existent `customInstructions`
   *  field (silently undefined); this is the single consistent source used by
   *  both the node-agent and column-agent paths. */
  /** Extract a task's OWN settings for the effective-agent resolver: its assigned
   *  agent identity (trimmed, non-empty) and a COMPLETE model pair (an incomplete
   *  pair does not count — KTD-5, mirrors resolveExecutorSessionModel's both-present
   *  rule). Centralizes the previously-duplicated extraction so the four call sites
   *  (restart watcher, taskEffectiveAgentMatches, resolveSeamColumnAgent,
   *  resolveEffectivePrincipalId) share one normalized idiom. */
  private extractOwnSettings(
    task: Pick<Task, "assignedAgentId" | "modelProvider" | "modelId">,
  ): Pick<EffectiveAgentInput, "ownAgentId" | "ownModelProvider" | "ownModelId"> {
    const ownAgentId = typeof task.assignedAgentId === "string" && task.assignedAgentId.trim()
      ? task.assignedAgentId.trim()
      : undefined;
    const ownModelComplete = Boolean(task.modelProvider && task.modelId);
    return {
      ownAgentId,
      ownModelProvider: ownModelComplete ? task.modelProvider : undefined,
      ownModelId: ownModelComplete ? task.modelId : undefined,
    };
  }

  private buildAgentPersona(agent: Agent): string | undefined {
    const parts = [agent.soul, agent.instructionsText]
      .map((p) => (typeof p === "string" ? p.trim() : ""))
      .filter((p) => p.length > 0);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  /** Fetch the column agent and surface its model + persona for adoption by a
   *  custom node (plan U3). Best-effort, mirroring the node-agent posture at the
   *  `"agent"` branch: on null/throw, log and return undefined so the caller
   *  falls back to the node's own/default resolution (R8). Emits a logEntry
   *  naming the substitution and mode so the audit trail explains who ran. */
  private async adoptColumnAgentForNode(
    node: WorkflowIrNode,
    live: TaskDetail,
    columnAgentId: string,
    mode: WorkflowColumnAgent["mode"] | undefined,
  ): Promise<{ modelProvider?: string; modelId?: string; persona?: string } | undefined> {
    try {
      const agent = await this.options.agentStore?.getAgent(columnAgentId);
      if (!agent) {
        await this.store.logEntry(
          live.id,
          `Workflow node '${node.id}': column agent '${columnAgentId}' not found — falling back to node/default resolution`,
          undefined,
          this.getRunContextFor(live.id),
        );
        return undefined;
      }
      const rc = (agent.runtimeConfig ?? {}) as { executorProvider?: string; executorModelId?: string };
      await this.store.logEntry(
        live.id,
        `Workflow node '${node.id}': running as column agent '${columnAgentId}' (${mode})`,
        undefined,
        this.getRunContextFor(live.id),
      );
      return {
        modelProvider: rc.executorProvider,
        modelId: rc.executorModelId,
        persona: this.buildAgentPersona(agent),
      };
    } catch {
      // Agent lookup is best-effort; fall back to node/default resolution (R8).
      // A secondary logEntry failure (DB locked / mid-recovery) must NOT propagate
      // out of this error handler and escalate the node to a hard failure.
      try {
        await this.store.logEntry(
          live.id,
          `Workflow node '${node.id}': column agent '${columnAgentId}' lookup failed — falling back to node/default resolution`,
          undefined,
          this.getRunContextFor(live.id),
        );
      } catch (logErr: unknown) {
        executorLog.warn(`${live.id}: failed to log column-agent lookup failure: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
      }
      return undefined;
    }
  }

  /**
   * Resolve the effective COLUMN AGENT governing the coding/step session currently
   * being built for a task (column-agent plan U4, R2/R3/R4/R8).
   *
   * Reads the governing node id stamped by the active seam ({@link
   * graphSeamGoverningNodeId}) and the per-run binding resolver ({@link
   * graphColumnAgentResolver}), both scoped to a graph-owned run. Feeds the task's
   * OWN settings (`assignedAgentId` + complete `modelProvider`/`modelId` pair) into
   * the shared core resolver (`resolveEffectiveAgent`, KTD-2/KTD-5) so defer/override
   * precedence is never reimplemented here. When the verdict is `column-agent`,
   * fetches the full Agent best-effort and audits the adoption; on a missing/deleted
   * agent it logs and returns undefined so the caller falls back to the
   * `assignedAgentId` path (R8). Returns undefined for the legacy/no-binding path so
   * the session build is byte-identical (characterization parity).
   *
   * Exposes the resolved Agent object (not just an id) so U5 can consume the same
   * effective principal for gating/heartbeat/restart without re-resolving.
   */
  private async resolveSeamColumnAgent(
    task: Task,
    detail: TaskDetail,
  ): Promise<{ agent: Agent; mode: WorkflowColumnAgent["mode"] | undefined } | undefined> {
    const governingNodeId = this.graphSeamGoverningNodeId.get(task.id);
    const resolveBinding = this.graphColumnAgentResolver.get(task.id);
    if (!governingNodeId || !resolveBinding) return undefined;

    const binding = resolveBinding(governingNodeId);
    if (!binding) return undefined;

    // The task's OWN settings: its assigned agent identity and a COMPLETE model
    // pair (an incomplete pair does not count — KTD-5, mirrors
    // resolveExecutorSessionModel's both-present rule).
    const effective = resolveEffectiveAgent({
      binding,
      ...this.extractOwnSettings(detail),
    });
    if (effective.source !== "column-agent") return undefined;

    // Column agent governs: fetch the full Agent (best-effort, R8 fallback).
    let agent: Agent | null = null;
    try {
      agent = (await this.options.agentStore?.getAgent(effective.agentId)) ?? null;
    } catch {
      agent = null;
    }
    if (!agent) {
      // Best-effort audit: a logEntry failure (DB locked / mid-recovery) must NOT
      // escalate this graceful fallback into a hard session failure (R8).
      try {
        await this.store.logEntry(
          task.id,
          `Workflow seam node '${governingNodeId}': column agent '${effective.agentId}' not found — falling back to assigned-agent resolution`,
          undefined,
          this.getRunContextFor(task.id),
        );
      } catch (logErr: unknown) {
        executorLog.warn(`${task.id}: failed to log column-agent fallback: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
      }
      return undefined;
    }
    try {
      await this.store.logEntry(
        task.id,
        `Workflow seam node '${governingNodeId}': running as column agent '${effective.agentId}' (${binding.mode})`,
        undefined,
        this.getRunContextFor(task.id),
      );
    } catch (logErr: unknown) {
      executorLog.warn(`${task.id}: failed to log column-agent adoption: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
    }
    return { agent, mode: binding.mode };
  }

  /**
   * Column-agent principal alignment (plan U5, R6). Resolve the EFFECTIVE
   * principal id for the in-flight seam WITHOUT fetching the full Agent or
   * emitting an adoption log — a light counterpart to {@link resolveSeamColumnAgent}
   * used by the heartbeat-deferral gate (which only needs the id to call
   * {@link shouldDeferForHeartbeat}, which itself loads the agent).
   *
   * Returns the column-agent id when a governing binding selects it via the shared
   * core resolver (`resolveEffectiveAgent`, KTD-2/KTD-5), else `task.assignedAgentId`
   * (the legacy principal). Returns `undefined` only when there is no principal at
   * all (no binding AND no assigned agent) — keeping the no-binding path
   * byte-identical to the prior `assignedAgentId` deferral behavior.
   */
  private resolveEffectivePrincipalId(
    task: Task,
    detail: Task,
  ): string | undefined {
    const ownSettings = this.extractOwnSettings(detail);
    const assignedAgentId = ownSettings.ownAgentId;

    const governingNodeId = this.graphSeamGoverningNodeId.get(task.id);
    const resolveBinding = this.graphColumnAgentResolver.get(task.id);
    if (!governingNodeId || !resolveBinding) return assignedAgentId;

    const binding = resolveBinding(governingNodeId);
    if (!binding) return assignedAgentId;

    const effective = resolveEffectiveAgent({ binding, ...ownSettings });
    if (effective.source === "column-agent") return effective.agentId;
    return assignedAgentId;
  }

  /**
   * Column-agent principal alignment (plan U5, R6). True when `agentId` is the
   * EFFECTIVE column-agent principal currently running some executing task's
   * coding/step session — i.e. an override/defer-bound column staffs it, even
   * though the agent is not the task's `assignedAgentId`. Injected into the
   * heartbeat scheduler's reverse-direction parallel-execution guards
   * (`agent-heartbeat.ts`) so an `allowParallelExecution=false` column agent does
   * not heartbeat concurrently with its own override session. Returns false for the
   * legacy/no-binding path (the map is empty), preserving prior behavior exactly.
   */
  isAgentEffectivelyExecuting(agentId: string): boolean {
    if (!agentId) return false;
    for (const effectiveId of this.effectiveColumnAgentByTask.values()) {
      if (effectiveId === agentId) return true;
    }
    return false;
  }

  /** Run a custom (non-seam) graph node on the proven WorkflowStep machinery.
   *
   *  `columnBinding` (plan U3) is the agent binding governing this node's
   *  declared column, resolved by the seam wiring in maybeExecuteWorkflowGraph
   *  (the IR is not in scope here). When present, the core resolver decides
   *  whether the column agent supersedes (override) or defers to the node's own
   *  `cfg.agentId`/model pair — never a reimplemented precedence. */
  private async runGraphCustomNode(
    node: WorkflowIrNode,
    nodeTask: TaskDetail,
    settings: Settings,
    columnBinding?: WorkflowColumnAgent,
  ): Promise<WorkflowNodeResult> {
    const cfg = node.config ?? {};
    const live = await this.store.getTask(nodeTask.id);

    // Await-input nodes never run a session — they pause for the user.
    if (cfg.awaitInput === true) {
      return this.runAwaitInputNode(node, live);
    }

    const executorKind = typeof cfg.executor === "string" ? cfg.executor : "model";

    // CLI Agent Executor (U7): a `cli-agent` node drives an engine-owned CLI
    // session through the task-session orchestration — NOT through the
    // executeWorkflowStep / model machinery. It is write-capable (the agent edits
    // the worktree), so it requires a task worktree like any coding node.
    if (executorKind === "cli-agent") {
      return this.runCliAgentNode(node, live, cfg);
    }

    const scriptName = typeof cfg.scriptName === "string" && cfg.scriptName.trim() ? cfg.scriptName : undefined;
    const rawCliCommand = executorKind === "cli" && typeof cfg.cliCommand === "string" && cfg.cliCommand.trim()
      ? cfg.cliCommand.trim()
      : undefined;

    // Isolation guard: write-capable nodes must run inside a task worktree, not
    // the shared repo root. Before the execute seam runs, live.worktree is unset
    // — a coding/script/CLI node falling back to this.rootDir would mutate the
    // main checkout and cross-contaminate other tasks. Reject such nodes until a
    // worktree exists. Read-only nodes (default toolMode) are safe against root.
    const writeCapable = cfg.toolMode === "coding" || node.kind === "script" || Boolean(scriptName) || Boolean(rawCliCommand);
    if (writeCapable && !live.worktree) {
      await this.store.logEntry(
        live.id,
        `Workflow node '${node.id}' is write-capable but no task worktree exists yet — place it after the execute seam`,
        undefined,
        this.getRunContextFor(live.id),
      );
      return { outcome: "failure", value: "no-worktree-for-write-node" };
    }

    const worktreePath = live.worktree || this.rootDir;
    let prompt = typeof cfg.prompt === "string" ? cfg.prompt : "";
    let modelProvider = typeof cfg.modelProvider === "string" && cfg.modelProvider.trim() ? cfg.modelProvider : undefined;
    let modelId = typeof cfg.modelId === "string" && cfg.modelId.trim() ? cfg.modelId : undefined;

    // ── Column-agent binding (plan U3, KTD-2/KTD-3) ──────────────────────────
    // When the node's declared column names an agent, the CORE resolver decides
    // whether the column agent supersedes (override) or defers to the node's own
    // settings — we never reimplement precedence. The node's own `cfg.agentId`
    // and complete model pair feed the resolver as "own settings" (KTD-5).
    const ownModelComplete = Boolean(modelProvider && modelId);
    const effective = resolveEffectiveAgent({
      binding: columnBinding,
      ownAgentId: typeof cfg.agentId === "string" && cfg.agentId.trim() ? cfg.agentId.trim() : undefined,
      ownModelProvider: ownModelComplete ? modelProvider : undefined,
      ownModelId: ownModelComplete ? modelId : undefined,
    });
    // The effective executor identity: a column agent supersedes the node's own
    // `executor: "agent"` adoption wholesale (identity + model + persona). When
    // the resolver yields the column agent, we run the column-agent adoption
    // path below INSTEAD of the node's own agent branch.
    const columnAgentId = effective.source === "column-agent" ? effective.agentId : undefined;
    const columnAgentMode = columnBinding?.mode;

    if (columnAgentId) {
      // CLI executor with a raw command runs no session — the column agent
      // cannot contribute a model/persona to raw process execution, so it is a
      // no-op here. Log the skip so the audit trail explains why the column
      // agent did not apply (plan U3). Skill / model / script-via-session nodes
      // DO adopt the column agent below.
      if (executorKind === "cli" && rawCliCommand) {
        await this.store.logEntry(
          live.id,
          `Workflow node '${node.id}': column agent '${columnAgentId}' (${columnAgentMode}) not applied — raw CLI execution runs no session`,
          undefined,
          this.getRunContextFor(live.id),
        );
      } else {
        const adopted = await this.adoptColumnAgentForNode(node, live, columnAgentId, columnAgentMode);
        if (adopted) {
          modelProvider = adopted.modelProvider ?? modelProvider;
          modelId = adopted.modelId ?? modelId;
          if (adopted.persona) prompt = `${adopted.persona}\n\n${prompt}`;
        }
        // Whether or not the agent resolved, the column agent SUPERSEDES the
        // node's own `executor: "agent"` adoption — skip that branch so we never
        // blend the column agent's model with the node agent's persona.
      }
    }

    // Executor kinds for prompt nodes:
    // - "model"  (default): run the prompt on the configured/override model.
    // - "agent": run as a named agent — adopt its model and persona prompt.
    // - "skill": invoke a named skill with the prompt as its input.
    // - "cli":   run a named project script with the prompt passed via env
    //            (FUSION_NODE_PROMPT). Named scripts only — raw commands are
    //            never accepted from node config.
    if (!columnAgentId && executorKind === "agent" && typeof cfg.agentId === "string" && cfg.agentId.trim()) {
      try {
        const agent = await this.options.agentStore?.getAgent(cfg.agentId);
        if (agent) {
          const rc = (agent.runtimeConfig ?? {}) as { executorProvider?: string; executorModelId?: string };
          modelProvider = rc.executorProvider ?? modelProvider;
          modelId = rc.executorModelId ?? modelId;
          // KTD-6: read the TYPED persona fields (soul / instructionsText), not
          // the non-existent `customInstructions` (which was silently undefined,
          // so node-agent persona injection never actually fired). Same fields
          // the column-agent path uses — one consistent persona source.
          const persona = this.buildAgentPersona(agent);
          if (persona) prompt = `${persona}\n\n${prompt}`;
        } else {
          await this.store.logEntry(live.id, `Workflow node '${node.id}': agent '${cfg.agentId}' not found — using default model`, undefined, this.getRunContextFor(live.id));
        }
      } catch {
        // Agent lookup is best-effort; fall back to the default model.
      }
    } else if (executorKind === "skill" && typeof cfg.skillName === "string" && cfg.skillName.trim()) {
      prompt = `Invoke the "${cfg.skillName}" skill with the following input, following the skill's instructions exactly:\n\n${prompt}`;
    } else if (executorKind === "cli") {
      const rawCommand = rawCliCommand;
      if (rawCommand) {
        // Arbitrary command: gated by trust-on-first-use approval unless the
        // node explicitly opts out. Two node flags bypass the pause:
        //   - cliSkipApproval: CLI-specific "skip first-run approval".
        //   - autoApprove:     the node's general "Auto-approve requests"
        //     toggle. The only human-approval pause reachable from a custom
        //     node is this CLI gate (review-style nodes run as ephemeral
        //     readonly agents with no permission gate), so honoring it here is
        //     what makes that toggle actually do something.
        // The exact command string must otherwise have been approved by the user.
        //
        // SECURITY: both flags are intentional project-owner-only escape hatches.
        // They are only reachable by someone who can author/edit a workflow
        // definition for this project through the trusted dashboard editor /
        // executor lane — the same trust boundary that already lets them add
        // named scripts. They are NOT enforced at the IR-validation layer.
        // Prompt-injectable surfaces strip these flags at the write boundary
        // before persisting: the import / AI-design routes (stripApprovalFlags
        // in register-workflow-routes.ts) and the chat/planning workflow
        // authoring tools (createWorkflowAuthoringTools(..., {stripApprovalFlags:
        // true}) in chat.ts / planning.ts) — all via stripApprovalBypassFlags in
        // @fusion/core. Only the executor lane keeps these flags intact.
        const skipApproval = cfg.cliSkipApproval === true || cfg.autoApprove === true;
        if (!skipApproval && !(await this.store.isWorkflowCliCommandApproved(rawCommand))) {
          return this.pauseForCliApproval(node, live, rawCommand);
        }
        // We are proceeding to execute. If this task was previously paused by
        // THIS node's CLI-approval gate, clear that status/pausedReason now —
        // otherwise the task keeps the "awaiting-cli-approval" status through
        // later graph nodes even though approval already happened (mirrors the
        // status reset in runAwaitInputNode).
        const approvalMarker = `workflow-cli-approval:${node.id}`;
        if ((live.pausedReason ?? "").startsWith(approvalMarker)) {
          await this.store.updateTask(live.id, { status: null, pausedReason: null }, this.getRunContextFor(live.id));
        }
        const env = prompt ? { ...process.env, FUSION_NODE_PROMPT: prompt } : undefined;
        const out = await this.runRawCliCommand(
          live,
          typeof cfg.name === "string" && cfg.name.trim() ? cfg.name : node.id,
          rawCommand,
          worktreePath,
          env,
        );
        const blocking = node.kind === "gate" || cfg.gateMode === "gate";
        return { outcome: out.success || !blocking ? "success" : "failure", value: out.success ? "passed" : "failed" };
      }
      // No raw command: fall back to a named script (still required).
      if (!scriptName) {
        return { outcome: "failure", value: "cli-command-missing" };
      }
    }

    const mode: "prompt" | "script" = executorKind === "cli" || node.kind === "script" || (node.kind === "gate" && scriptName) ? "script" : "prompt";
    const now = new Date().toISOString();
    const step: WorkflowStep = {
      id: `graph:${node.id}`,
      name: typeof cfg.name === "string" && cfg.name.trim() ? cfg.name : node.id,
      description: typeof cfg.description === "string" ? cfg.description : "",
      mode,
      phase: "pre-merge",
      gateMode: node.kind === "gate" || cfg.gateMode === "gate" ? "gate" : "advisory",
      prompt,
      toolMode: cfg.toolMode === "coding" ? "coding" : "readonly",
      scriptName,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      ...(modelProvider && modelId ? { modelProvider, modelId } : {}),
    };

    // CLI executor passes the node prompt to the named script via env.
    const nodeEnv: NodeJS.ProcessEnv | undefined =
      executorKind === "cli" && prompt ? { ...process.env, FUSION_NODE_PROMPT: prompt } : undefined;

    const outcome = mode === "script"
      ? await this.executeScriptWorkflowStep(live, step, worktreePath, settings, nodeEnv)
      : await this.executeWorkflowStep(live, step, worktreePath, settings, nodeEnv);

    const blocking = step.gateMode === "gate";
    // Script-mode outcomes carry no structured verdict; prompt-mode may.
    const verdict = (outcome as { verdict?: string }).verdict;
    return {
      outcome: outcome.success || !blocking ? "success" : "failure",
      value: verdict ?? (outcome.success ? "passed" : "failed"),
    };
  }

  /**
   * Resolve the cli-agent executor config off a workflow node (U7), snapshotting
   * the launch-time values. A mid-run node-config edit therefore applies to the
   * NEXT run only. Per-task overrides follow the existing per-task settings
   * precedent: when reachable cheaply we read a task field; otherwise the node
   * config is authoritative (documented hook point — `task.cliAdapterId` etc. are
   * not modeled on TaskDetail in v1, so node config is the sole source here).
   */
  private resolveCliExecutorConfig(cfg: Record<string, unknown>): ResolvedCliExecutorConfig | null {
    const cliAdapterId = typeof cfg.cliAdapterId === "string" && cfg.cliAdapterId.trim()
      ? cfg.cliAdapterId.trim()
      : undefined;
    if (!cliAdapterId) return null;
    const cliAutonomy = cfg.cliAutonomy && typeof cfg.cliAutonomy === "object"
      ? (cfg.cliAutonomy as ResolvedCliExecutorConfig["cliAutonomy"])
      : null;
    const cliNotify = cfg.cliNotify && typeof cfg.cliNotify === "object"
      ? (cfg.cliNotify as Record<string, unknown>)
      : null;
    const settings = cfg.cliSettings && typeof cfg.cliSettings === "object"
      ? (cfg.cliSettings as Record<string, unknown>)
      : undefined;
    return { cliAdapterId, cliAutonomy, cliNotify, settings };
  }

  /**
   * CLI Agent Executor seam (U7): run a `cli-agent` workflow node by driving an
   * engine-owned CLI session through the task-session orchestration.
   *
   * Re-entry policy (KTD): a re-entry into execute launches a FRESH session — any
   * prior live session for the task is killed first (context reset). The resolved
   * config is snapshotted at launch.
   *
   * Outcome mapping (R20 positive-completion gating):
   *   - success         → node success (pipeline advances; PTY reaped at handoff
   *                       to in-review via reapCliTaskSessionForHandoff).
   *   - needs-attention / user-exited / auth-failed → node failure (the graph
   *     failure handler parks the task for a human — never a silent stall).
   *   - killed          → node failure value "cli-agent-killed" (hard cancel
   *     already moved the task; this just unwinds the graph walk).
   *
   * A CliConcurrencyLimitError at spawn surfaces as a clear typed error value
   * ("cli-agent-at-capacity") rather than a hang.
   */
  private async runCliAgentNode(
    node: WorkflowIrNode,
    live: TaskDetail,
    cfg: Record<string, unknown>,
  ): Promise<WorkflowNodeResult> {
    const runtime = this.options.cliAgentRuntime;
    if (!runtime) {
      await this.store.logEntry(
        live.id,
        `Workflow node '${node.id}' uses the cli-agent executor but no CLI agent runtime is wired`,
        undefined,
        this.getRunContextFor(live.id),
      );
      return { outcome: "failure", value: "cli-agent-runtime-unavailable" };
    }
    if (!live.worktree) {
      await this.store.logEntry(
        live.id,
        `Workflow node '${node.id}' (cli-agent) is write-capable but no task worktree exists yet — place it after the execute seam`,
        undefined,
        this.getRunContextFor(live.id),
      );
      return { outcome: "failure", value: "no-worktree-for-write-node" };
    }
    const config = this.resolveCliExecutorConfig(cfg);
    if (!config) {
      await this.store.logEntry(
        live.id,
        `Workflow node '${node.id}' (cli-agent) is missing 'cliAdapterId'`,
        undefined,
        this.getRunContextFor(live.id),
      );
      return { outcome: "failure", value: "cli-agent-adapter-missing" };
    }

    const prompt = typeof cfg.prompt === "string" ? cfg.prompt : (live.prompt ?? "");

    // Re-entry: kill any prior LIVE session for this task (RETHINK/replan context
    // reset) before launching fresh.
    killLiveTaskSessions(live.id, runtime.manager, runtime.store);

    let session: CliTaskSession;
    try {
      session = await launchCliTaskSession({
        taskId: live.id,
        projectId: runtime.projectId,
        worktreePath: live.worktree,
        prompt,
        config,
        manager: runtime.manager,
        hub: runtime.hub,
        registry: runtime.registry,
        hookEndpointUrl: runtime.hookEndpointUrl,
        hookDirRoot: runtime.hookDirRoot,
        log: (msg) => executorLog.log(`[cli-agent] ${msg}`),
      });
    } catch (err) {
      if (err instanceof CliConcurrencyLimitError) {
        await this.store.logEntry(
          live.id,
          `cli-agent session for node '${node.id}' rejected at PTY pool ceiling (${err.active}/${err.ceiling}) — queued`,
          undefined,
          this.getRunContextFor(live.id),
        );
        // A typed, surfaced state — NOT a silent stall. The graph failure handler
        // parks the task; a later sweep / capacity opening re-runs it.
        return { outcome: "failure", value: "cli-agent-at-capacity" };
      }
      throw err;
    }

    this.activeCliTaskSessions.set(live.id, session);
    let outcome: CliTaskOutcome;
    try {
      outcome = await session.result();
    } finally {
      // Detach the live-session handle. Reaping (success) / killing (cancel) is
      // handled per-outcome below or by the abort path.
      if (this.activeCliTaskSessions.get(live.id) === session) {
        this.activeCliTaskSessions.delete(live.id);
      }
    }

    switch (outcome.kind) {
      case "success":
        // Reap the PTY at the execute→in-review handoff (autoMerge:false tasks
        // don't hold slots): graceful kill, record terminationReason "completed".
        await this.reapCliTaskSessionForHandoff(session, live.id);
        return { outcome: "success", value: "cli-agent-done" };
      case "killed":
        // Hard cancel already moved the task + killed the PTY via the abort path;
        // just unwind the graph walk.
        return { outcome: "failure", value: "cli-agent-killed" };
      case "auth-failed":
        return { outcome: "failure", value: "cli-agent-auth-failed" };
      case "user-exited":
        return { outcome: "failure", value: "cli-agent-user-exited" };
      case "needs-attention":
      default:
        return { outcome: "failure", value: "cli-agent-needs-attention" };
    }
  }

  /**
   * Reap a CLI task session at the execute→in-review handoff (U7). Graceful PTY
   * kill recorded as `completed`. Best-effort: a reap failure must not block the
   * pipeline advancement that the positive done already authorized.
   */
  private async reapCliTaskSessionForHandoff(session: CliTaskSession, taskId: string): Promise<void> {
    try {
      await session.reap();
    } catch (err) {
      executorLog.warn(`${taskId}: failed to reap cli-agent session at handoff: ${err}`);
    }
  }

  /** Terminal failure of a graph run: record the error and park the task in
   *  review so a human can act — never leave it invisible in in-progress. */
  private async handleGraphFailure(task: Task, result: WorkflowGraphTaskRunResult): Promise<void> {
    const failedNode = result.visitedNodeIds[result.visitedNodeIds.length - 1];
    const message = `Workflow graph terminated with failure at node '${failedNode ?? "unknown"}'`;
    executorLog.warn(`${task.id}: ${message}`);
    this.clearCompletedTaskWatchdog(task.id);
    this.options.stuckTaskDetector?.untrackTask(task.id);
    try {
      const live = await this.store.getTask(task.id);
      // A paused/aborted implementation is not a graph failure — leave the
      // pause machinery in charge instead of parking the task in review.
      if (live.paused || this.pausedAborted.has(task.id)) {
        executorLog.log(`${task.id}: graph run ended while task is paused — leaving pause state untouched`);
        await this.store.logEntry(task.id, `${message} (task paused — not parked)`, undefined, this.getRunContextFor(task.id));
        return;
      }
      await this.store.logEntry(task.id, message, undefined, this.getRunContextFor(task.id));
      // status "failed" doubles as the self-healing exemption: review-task
      // revival sweeps skip tasks carrying a non-null status, preventing the
      // FN-5704-style loop of re-running the graph from scratch.
      await this.store.updateTask(task.id, { error: message, status: "failed" }, this.getRunContextFor(task.id));
      if (live.column === "in-progress") {
        await this.persistTokenUsage(task.id);
        await this.handoffTaskToReview(live, "workflow-graph-failed");
      }
    } catch (err) {
      executorLog.error(
        `${task.id}: failed to park graph-failed task: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async execute(task: Task): Promise<void> {
    // Workflow graph interpreter routing (cutover M-C): graph-selected tasks
    // are orchestrated by the interpreter. The execute seam re-enters this
    // method with a completion interceptor registered (which claims the task
    // lock normally), so routing is skipped for that inner invocation.
    if (!this.graphCompletionInterceptors.has(task.id)) {
      if (this.graphRouting.has(task.id)) {
        // Duplicate dispatch while the graph runner owns this task — drop it,
        // mirroring the executingTaskLock duplicate-invocation behavior.
        executorLog.log(`execute() called for ${task.id} while graph routing is active — skipping duplicate`);
        return;
      }
      const graphOwned = await this.maybeExecuteWorkflowGraph(task);
      if (graphOwned) return;
    }

    // FN-4811 follow-up (FN-4814/FN-4809/FN-4811 production failure): claim a
    // PROCESS-WIDE lock synchronously before any other work. Per-instance
    // `this.executing` was insufficient in production because two execute()
    // invocations for the same task ID still both reached "Executor detected
    // stale merge state" (executor.ts:2661) and both generated runIds — producing
    // duplicate "Worktree created at /..." log entries within the same second.
    // The only fully-reliable guard is a singleton lock shared across all
    // TaskExecutor instances in the same process (e.g., engine restart race,
    // multi-project hybrid runtime, etc.). This is `executingTaskLock` in
    // active-session-registry.ts, a module-level Set.
    const claimed = executingTaskLock.tryClaim(task.id);
    executorLog.log(`execute() called for ${task.id} (claimed=${claimed}, perInstanceExecuting=${this.executing.has(task.id)})`);
    if (!claimed) return;

    // Maintain the per-instance Set too, for back-compat with all the existing
    // `this.executing.has()` checks throughout the file (handler gates,
    // stuck-detector, resumeTaskForAgent, etc.). Per-instance state stays
    // consistent with the process-wide lock.
    this.executing.add(task.id);

    if (task.deletedAt) {
      executorLog.warn(`${task.id}: refusing execute — task is soft-deleted`);
      this.executing.delete(task.id);
      executingTaskLock.release(task.id);
      return;
    }

    // Column-agent principal alignment (plan U5, R6): the heartbeat-deferral gate
    // must consult the EFFECTIVE principal, not blindly `assignedAgentId`. For a
    // graph-routed seam the binding context (governing node id + per-run resolver)
    // is already set by the time the seam re-enters execute() — so the effective
    // column agent (when an override/defer binding governs) is the principal whose
    // `allowParallelExecution=false` must serialize. For the legacy/no-binding path
    // `resolveEffectivePrincipalId` returns `assignedAgentId`, so the gate is
    // byte-identical to before.
    const deferralPrincipalId = this.resolveEffectivePrincipalId(task, task);
    if (deferralPrincipalId && await this.shouldDeferForHeartbeat(deferralPrincipalId)) {
      executorLog.log(`${task.id}: skipping execute — agent ${deferralPrincipalId} has active heartbeat run (allowParallelExecution=false)`);
      // Release the slot we just claimed — we never actually ran.
      this.executing.delete(task.id);
      executingTaskLock.release(task.id);
      return;
    }

    executorLog.log(`Starting ${task.id}: ${task.title || task.description.slice(0, 60)}`);

    // Fetch settings early — needed for worktree naming and later configuration.
    // Merge per-task effective workflow settings (U3, KTD-3) OVER the project/global
    // base so the ~20 flat `settings.<key>` read sites threaded from here (workflow
    // step timeout, scope enforcement, runStepsInNewSessions, model lanes,
    // reviewHandoffPolicy, …) pick up workflow values with zero read-site changes.
    // Behavior-inert when nothing is customized (declaration defaults === legacy
    // defaults; absent-default lanes never override).
    const settings = await mergeEffectiveSettings(this.store, task, await this.store.getSettings());

    // Keep runtime plugin workflow step templates synchronized into TaskStore.
    // TaskStore resolves plugin-prefixed workflow IDs from this injected cache
    // to avoid a PluginLoader↔TaskStore circular dependency.
    const pluginWorkflowStepTemplates = this.options.pluginRunner?.getPluginWorkflowStepTemplates() ?? [];
    this.store.setPluginWorkflowStepTemplates(pluginWorkflowStepTemplates);

    // Read execution mode to determine whether to skip review and workflow steps
    const executionMode = task.executionMode ?? "standard";

    // Construct run context for mutation correlation
    // Use a synthetic correlation ID: task ID + timestamp + random suffix
    const syntheticRunId = generateSyntheticRunId("exec", task.id);
    this.currentRunContexts.set(task.id, {
      runId: syntheticRunId,
      agentId: task.assignedAgentId ?? "executor",
    });

    // Build engine run context for audit instrumentation (FN-1404)
    const engineRunContext: EngineRunContext = {
      runId: syntheticRunId,
      agentId: task.assignedAgentId ?? "executor",
      taskId: task.id,
      phase: "execute",
    };

    // Create run auditor for TaskStore-backed audit emission (no-ops if store doesn't support it)
    const audit = createRunAuditor(this.store, engineRunContext);

    // Stale spec enforcement: check if PROMPT.md has aged beyond the configured threshold.
    // When enabled, stale tasks are moved back to triage with status "needs-replan"
    // so they receive fresh specification before execution. This guard runs early in
    // execute() to prevent stale tasks from entering worktree creation or agent sessions.
    // If timestamp evaluation is skipped (missing/unreadable file), continue with execution
    // so existing filesystem validation paths remain authoritative.
    // Skip for tasks that are already in-progress, in-review, merging, or done —
    // these should not be interrupted and sent back to triage for re-planning.
    const activeColumns = new Set(["in-progress", "in-review", "done"]);
    const activeMergeStatuses = new Set(["merging", "merging-pr", "merging-fix"]);
    const isActiveTask = activeColumns.has(task.column) || activeMergeStatuses.has(task.status ?? "");
    if (!isActiveTask) {
      const tasksDir = join(this.store.getFusionDir(), "tasks");
      const promptPath = getPromptPath(tasksDir, task.id);
      const staleness = await evaluateSpecStaleness({ settings, promptPath, task });
      if (staleness.isStale) {
        executorLog.warn(`Task ${task.id} specification is stale — ${staleness.reason}`);
        // Move to triage first, then set status so the task enters triage with needs-replan
        await this.store.moveTask(task.id, "triage");
        await this.store.updateTask(task.id, { status: "needs-replan" });
        await this.store.logEntry(task.id, staleness.reason, undefined, this.getRunContextFor(task.id));
        return;
      }
    }

    // Drift detection: a task that is already in-progress (i.e. we're not
    // dispatching it fresh from todo) should always carry a `worktree`. If it
    // doesn't, some prior update — most likely a partial pause/abort sequence
    // where updateTask({ worktree: null }) succeeded but the subsequent
    // moveTask()/status write failed — left the row in a half-state. The
    // executor can still recover by falling through to the fresh-worktree
    // path below, but we emit a loud audit record so these states stop being
    // silent.
    if (task.column === "in-progress" && task.mergeDetails) {
      executorLog.warn(`${task.id}: stale mergeDetails found while executing in-progress task — resetting merge state before continuing`);
      task = await this.cleanupMergeStateForReverification(
        task,
        "Executor detected stale merge state while task was in-progress — reset verification steps and merge metadata before resuming",
      );
    }

    if (task.column === "in-progress" && !task.worktree) {
      executorLog.error(
        `${task.id}: drift detected — task is in-progress with no worktree. ` +
          `Recovering by creating a fresh worktree. This usually indicates a partial ` +
          `updateTask/moveTask sequence failed somewhere upstream.`,
      );
      await this.store.logEntry(
        task.id,
        "Drift detected: in-progress with no worktree — creating fresh worktree to recover",
        undefined,
        this.getRunContextFor(task.id),
      );
    }

    // Hoist worktreePath so it's accessible in the catch block for dep-abort cleanup
    let worktreePath = task.worktree ?? "";

    // Set by stuck-abort handlers; the actual moveTask("todo") is deferred to
    // the finally block so this.executing is cleared first (prevents re-dispatch race).
    // true = requeue to todo, false = budget exhausted (already marked failed).
    let stuckRequeue: boolean | null = null;
    let taskDone = false;
    let reviewAddressingActivated = false;
    let taskEnv: NodeJS.ProcessEnv | undefined;

    try {
      await this.transitionReviewAddressing(task.id, ["queued"], "in-progress");
      reviewAddressingActivated = true;
      // Check dependencies
      const allTasks = await this.store.listTasks({ slim: true, includeArchived: false });
      const unmetDeps = task.dependencies.filter((depId) => {
        const dep = allTasks.find((t) => t.id === depId);
        return dep && dep.column !== "done" && dep.column !== "in-review" && dep.column !== "archived";
      });

      if (unmetDeps.length > 0) {
        executorLog.log(`${task.id} blocked by: ${unmetDeps.join(", ")} — deferring`);
        return;
      }

      if (!await isGitRepository(this.rootDir)) {
        await this.store.logEntry(
          task.id,
          "Cannot execute task: project directory is not a Git repository. Fusion requires a Git repository for worktree-based task execution.",
        );
        throw new Error(
          "Project directory is not a Git repository. Fusion requires a Git repository for worktree creation. Initialize with 'git init' or run from a Git project directory.",
        );
      }

      const hadAssignedWorktree = Boolean(task.worktree);
      const taskCommandAbortController = new AbortController();
      this.registerConfiguredCommandController(task.id, taskCommandAbortController);
      const acquisition = await (async () => {
        try {
          return await acquireTaskWorktree({
            task,
            rootDir: this.rootDir,
            store: this.store,
            settings,
            pool: this.options.pool,
            logger: executorLog,
            audit,
            runContext: this.getRunContextFor(task.id),
            runInitCommand: true,
            createWorktree: this.createWorktree.bind(this),
            runConfiguredCommand: (command, cwd, timeoutMs, env) =>
              runConfiguredCommand(
                command,
                cwd,
                timeoutMs,
                env,
                audit,
                taskCommandAbortController.signal,
              ).then((result) => {
                if (taskCommandAbortController.signal.aborted) {
                  throw this.createConfiguredCommandAbortError(task.id, command);
                }
                return result;
              }),
            taskEnv,
            secretsStore: this.options.secretsStore,
          });
        } finally {
          this.unregisterConfiguredCommandController(task.id, taskCommandAbortController);
        }
      })();
      worktreePath = acquisition.worktreePath;

      if (acquisition.reclaimed) {
        await audit.git({
          type: "branch:auto-reclaim",
          target: acquisition.branch,
          metadata: {
            taskId: task.id,
            branch: acquisition.branch,
            worktreePath: acquisition.worktreePath,
            existingTipSha: acquisition.reclaimed.existingTipSha,
            strandedCommitCount: acquisition.reclaimed.strandedCommitCount ?? 0,
            trigger: "dispatch-preflight",
          },
        });
      }

      if (!acquisition.isResume && acquisition.source === "fresh" && settings.setupScript) {
        const scriptCommand = settings.scripts?.[settings.setupScript];
        if (scriptCommand) {
          const setupStartedAt = Date.now();
          const setupAbortController = new AbortController();
          this.registerConfiguredCommandController(task.id, setupAbortController);
          try {
            const setupResult = await runConfiguredCommand(
              scriptCommand,
              worktreePath,
              120_000,
              taskEnv,
              audit,
              setupAbortController.signal,
            );
            if (setupAbortController.signal.aborted) {
              throw this.createConfiguredCommandAbortError(task.id, scriptCommand);
            }
            if (setupResult.spawnError || setupResult.timedOut || setupResult.exitCode !== 0) {
              throw new Error(configuredCommandErrorMessage(setupResult));
            }
            await this.store.logEntry(task.id, `[timing] Setup script '${settings.setupScript}' completed in ${Date.now() - setupStartedAt}ms`, scriptCommand, this.getRunContextFor(task.id));
          } catch (err: unknown) {
            if (err instanceof Error && err.name === "AbortError") {
              throw err;
            }
            const execError = err instanceof Error ? err : new Error(String(err));
            const message = "stderr" in execError && typeof (execError as Record<string, unknown>).stderr === "string"
              ? String((execError as Record<string, unknown>).stderr)
              : execError.message;
            await this.store.logEntry(task.id, `Setup script '${settings.setupScript}' failed: ${message}`, undefined, this.getRunContextFor(task.id));
          } finally {
            this.unregisterConfiguredCommandController(task.id, setupAbortController);
          }
        } else {
          await this.store.logEntry(task.id, `Setup script '${settings.setupScript}' not found in scripts map — skipping`, undefined, this.getRunContextFor(task.id));
        }
      }

      // Capture the base commit SHA for diff computation whenever a task
      // starts with a newly assigned worktree.
      if (!acquisition.isResume) {
        await this.captureBaseCommitSha(task, worktreePath, audit, { isResume: false });
      }

      // Contamination check must use a FRESH merge-base with the integration
      // branch — NOT task.baseCommitSha. baseCommitSha is intentionally
      // preserved across sessions for stable diff math, which makes it
      // potentially stale relative to main. Using it here would falsely flag
      // every legitimately-merged commit on main since that stale SHA as
      // "foreign contamination" (see FN-4417). The real signal we want is:
      // does the branch contain commits past its current merge-base with main
      // that are attributed to OTHER tasks? Compute the merge-base fresh.
      const contaminationBaseRef = await this.resolveContaminationBaseRef(worktreePath);
      if (contaminationBaseRef) {
        try {
          await assertCleanBranchAtBase(this.rootDir, acquisition.branch, contaminationBaseRef, task.id);
        } catch (contaminationError: unknown) {
          if (!(contaminationError instanceof BranchCrossContaminationError)) {
            throw contaminationError;
          }
          const recovered = await this.tryBootstrapMisbindingRecovery(task, contaminationError, audit);
          if (recovered) {
            return;
          }
          throw contaminationError;
        }
      }

      const expectedRoot = canonicalizePath(this.rootDir);
      let observedWorktreeRealpath: string;
      let livenessFailure: string | null = null;
      try {
        observedWorktreeRealpath = canonicalizePath(worktreePath);
        if (observedWorktreeRealpath === expectedRoot) {
          livenessFailure = "realpath_matches_repo_root";
        }
      } catch (error) {
        observedWorktreeRealpath = `unresolvable:${worktreePath}`;
        livenessFailure = `unresolvable_worktree:${error instanceof Error ? error.message : String(error)}`;
      }

      if (!livenessFailure && !isInsideWorktreesDir(this.rootDir, worktreePath, settings)) {
        livenessFailure = "outside_worktrees_dir";
      }

      let livenessFailureReason: string | null = null;
      let livenessClassification: string | null = null;
      const shouldGate = acquisition.isResume || (hadAssignedWorktree && !task.sessionFile && acquisition.source !== "fresh");
      if (!livenessFailure && shouldGate) {
        const classification = await classifyTaskWorktree(this.rootDir, worktreePath);
        if (!classification.ok) {
          const reanchor = await detectNestedWorktreeRoot(this.rootDir, worktreePath, settings);
          if (reanchor.reanchored) {
            await this.store.updateTask(task.id, { worktree: reanchor.root });
            await this.store.logEntry(task.id, `Re-anchored nested task.worktree from ${worktreePath} to ${reanchor.root}`, undefined, this.getRunContextFor(task.id));
            await this.emitWorktreeReanchoredAudit(task.id, worktreePath, reanchor.root, "executor-liveness-gate");
            worktreePath = reanchor.root;
            observedWorktreeRealpath = canonicalizePath(reanchor.root);
          } else {
            livenessClassification = classification.classification;
            livenessFailureReason = classification.reason;
            livenessFailure = `not_usable_task_worktree:${classification.classification}`;
          }
        }
      }

      if (livenessFailure) {
        const expected = `${resolveWorktreesDir(this.rootDir, settings)}/* (usable, registered)`;
        const observed = `${worktreePath} (${observedWorktreeRealpath})`;
        let registeredPaths: string[] = [];
        try {
          const registeredSnapshot = await describeRegisteredWorktrees(this.rootDir);
          registeredPaths = registeredSnapshot.canonicalized;
        } catch {
          registeredPaths = [];
        }
        const visibleRegistered = registeredPaths.slice(0, 10);
        const registeredSuffix = registeredPaths.length > 10
          ? `, … +${registeredPaths.length - 10} more`
          : "";
        const registeredSection = ` — registered=[${visibleRegistered.join(", ")}${registeredSuffix}]`;
        const reasonSection = livenessFailureReason ? ` (${livenessFailureReason})` : "";
        const failureMessage = `worktree liveness assertion failed: ${livenessFailure}${reasonSection} — observed=${observed}, expected=${expected}${registeredSection}`;
        executorLog.error(`${task.id}: ${failureMessage}`);
        await this.store.logEntry(task.id, failureMessage, undefined, this.getRunContextFor(task.id));

        const priorRequeues = task.taskDoneRetryCount ?? 0;
        const nextRequeueCount = priorRequeues + 1;
        const terminalAction = priorRequeues < MAX_TASK_DONE_REQUEUE_RETRIES ? "requeue-todo" : "park-in-review";
        if (livenessClassification) {
          await audit.git({
            type: "worktree:incomplete-detected",
            target: worktreePath,
            metadata: {
              classification: livenessClassification,
              reason: livenessFailureReason ?? undefined,
              source: "executor-liveness-gate",
              taskId: task.id,
              retryCount: nextRequeueCount,
              maxRetries: MAX_TASK_DONE_REQUEUE_RETRIES,
              terminalAction,
            },
          });
        }

        if (priorRequeues < MAX_TASK_DONE_REQUEUE_RETRIES) {
          await this.store.updateTask(task.id, {
            status: "failed",
            error: failureMessage,
            worktree: null,
            branch: null,
            sessionFile: null,
            taskDoneRetryCount: nextRequeueCount,
            paused: false,
            pausedByAgentId: null,
          });
          await this.store.logEntry(
            task.id,
            `${failureMessage} — requeued to todo immediately (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`,
            undefined,
            this.getRunContextFor(task.id),
          );
          await this.store.moveTask(task.id, "todo", { preserveProgress: true });
          executorLog.log(`✗ ${task.id} worktree liveness failed — requeued to todo (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`);
        } else {
          await this.store.updateTask(task.id, {
            status: "failed",
            error: failureMessage,
            worktree: null,
            branch: null,
            sessionFile: null,
            paused: false,
            pausedByAgentId: null,
          });
          await this.store.logEntry(task.id, `${failureMessage} — moved to in-review for inspection`, undefined, this.getRunContextFor(task.id));
          await this.persistTokenUsage(task.id);
          await this.handoffTaskToReview(task, "worktree-liveness-failed");
          executorLog.log(`✗ ${task.id} worktree liveness failed — moved to in-review`);
        }
        this.options.onError?.(task, new Error(failureMessage));
        return;
      }

      this.activeWorktrees.set(task.id, worktreePath);
      executorLog.log(`${task.id}: worktree ready at ${worktreePath}`);

      const runtimeEnvContribution = await this.options.pluginRunner?.collectExecutorRuntimeEnv({
        taskId: task.id,
        worktreePath,
        rootDir: this.rootDir,
        branch: acquisition.branch ?? undefined,
      });
      const pathPrepend = runtimeEnvContribution?.pathPrepend ?? [];
      const injectedEnv = runtimeEnvContribution?.env ?? {};
      // We intentionally do NOT mutate process.env globally. This task-scoped env is
      // passed through AgentRuntimeOptions so executor session subprocesses inherit it
      // without leaking across concurrent tasks.
      taskEnv = {
        ...process.env,
        ...injectedEnv,
        PATH: [...pathPrepend, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
      };
      executorLog.log(
        `${task.id}: executor runtime env injected (${pathPrepend.length} PATH entries, ${Object.keys(injectedEnv).length} env keys)`,
      );

      this.options.onStart?.(task, worktreePath);

      const detail = await this.store.getTask(task.id);
      executorLog.log(`${task.id}: fetched task detail (${detail.steps.length} steps, prompt length=${detail.prompt?.length ?? 0})`);

      // Initialize steps from PROMPT.md if empty
      if (detail.steps.length === 0) {
        const steps = await this.store.parseStepsFromPrompt(task.id);
        if (steps.length > 0) {
          await this.store.updateStep(task.id, 0, "pending");
        }
      }

      // On resume (task.branch already set from a prior run), reconcile step
      // statuses from git history so the agent doesn't redo already-committed work.
      if (acquisition.isResume && task.branch && detail.steps.length > 0) {
        await this.reconcileStepsFromGitHistory(task.id, detail, worktreePath);
      }

      // ── Step-Session vs Single-Session execution path ──
      // When runStepsInNewSessions is enabled, each step runs in its own
      // fresh agent session via StepSessionExecutor. Otherwise, the existing
      // single-session flow runs all steps in one monolithic session.

      // Build skill selection context early so it's available in both paths
      const skillContext = await buildSessionSkillContext({
        agentStore: this.options.agentStore!,
        task: detail,
        sessionPurpose: "executor",
        projectRootDir: this.rootDir,
        pluginRunner: this.options.pluginRunner,
      });

      // Graph-owned stepwise runs force step-session physics for the run (KTD-2/
      // KTD-8): the discrete per-step boundary the foreach driver needs exists only
      // in StepSessionExecutor. Pinned per run so a mid-flight setting toggle never
      // selects the unsupported (graph ON × step-sessions OFF) combination.
      const forceStepSession = this.graphStepSessionPinned.has(task.id);
      if (settings.runStepsInNewSessions || forceStepSession) {
        // ── Step-Session Path ──────────────────────────────────────────
        executorLog.log(`${task.id}: using step-session mode (maxParallel=${settings.maxParallelSteps ?? 2}${forceStepSession ? ", graph-pinned" : ""})`);

        const stepSessionAgent = detail.assignedAgentId && this.options.agentStore
          ? await this.options.agentStore.getAgent(detail.assignedAgentId).catch(() => null)
          : null;

        // Column-agent SESSION IDENTITY (U4, R2/R3/R4/R8): when the governing
        // step-execute node's declared column binds an agent that supersedes the
        // task's assigned agent, the per-step session's MODEL, runtime hint, and
        // attribution adopt the column agent. The core resolver decides defer vs
        // override (KTD-2); a missing agent logs + falls back (R8). Principal
        // alignment (U5, R5/R6): the gating contexts below ALSO key off the
        // effective `stepIdentityAgent`, and the effective principal is tracked for
        // the reverse-direction heartbeat guard.
        const stepColumnAgent = await this.resolveSeamColumnAgent(task, detail);
        const stepIdentityAgent = stepColumnAgent?.agent ?? stepSessionAgent;
        // U5 (R6): track the effective column-agent principal so the heartbeat
        // scheduler's reverse guard knows this agent is executing a task it may not
        // be assigned to. Cleared in deleteActiveStepExecutor.
        if (stepColumnAgent?.agent) {
          this.effectiveColumnAgentByTask.set(task.id, stepColumnAgent.agent.id);
        }
        const stepSessionRuntimeHint = extractRuntimeHint(stepIdentityAgent?.runtimeConfig);

        let accumulatedStepTokenUsage = detail.tokenUsage;
        const tokenUsageRecordedSteps = new Set<number>();

        const stepExecutor = new StepSessionExecutor({
          store: this.store,
          taskDetail: detail,
          worktreePath,
          rootDir: this.rootDir,
          settings,
          semaphore: this.options.semaphore,
          stuckTaskDetector: this.options.stuckTaskDetector,
          pluginRunner: this.options.pluginRunner,
          runtimeHint: stepSessionRuntimeHint,
          assignedAgentRuntimeConfig: (stepIdentityAgent?.runtimeConfig ?? undefined) as Record<string, unknown> | undefined,
          // Attribute the per-step run auditor to the column agent when it governs
          // (U4); absent → StepSessionExecutor falls back to assignedAgentId.
          effectiveAgentId: stepColumnAgent?.agent.id,
          actionGateContext: this.buildActionGateContext(task.id, stepIdentityAgent, settings.defaultAgentPermissionPolicy),
          permanentAgentGating: this.buildPermanentAgentGatingContext(task.id, stepIdentityAgent, settings.defaultAgentPermissionPolicy),
          // Pass skill selection context from the main executor session
          skillSelection: skillContext.skillSelectionContext,
          // Pass agentStore and messageStore for delegation and messaging tools
          agentStore: this.options.agentStore,
          messageStore: this.options.messageStore,
          taskEnv,
          onStepStart: (stepIndex) => {
            this.options.stuckTaskDetector?.recordProgress(task.id);
            try {
              this.store.updateStep(task.id, stepIndex, "in-progress").catch((err) => {
                executorLog.warn(`${task.id}: failed to update step ${stepIndex} status to in-progress: ${err}`);
              });
            } catch (err) {
              executorLog.warn(`${task.id}: failed to update step ${stepIndex} status to in-progress: ${err}`);
            }
          },
          onStepComplete: (stepIndex, result) => {
            executorLog.log(`${task.id}: step ${stepIndex} ${result.success ? "succeeded" : "failed"} (${result.retries} retries)`);
            try {
              this.store.updateStep(task.id, stepIndex, result.success ? "done" : "skipped").catch((err) => {
                executorLog.warn(`${task.id}: failed to update step ${stepIndex} status: ${err}`);
              });
            } catch (err) {
              executorLog.warn(`${task.id}: failed to update step ${stepIndex} status: ${err}`);
            }

            if (!result.tokenUsage) {
              return;
            }

            accumulatedStepTokenUsage = this.accumulateTokenUsage(accumulatedStepTokenUsage, result.tokenUsage);
            tokenUsageRecordedSteps.add(stepIndex);
            if (!accumulatedStepTokenUsage) {
              return;
            }

            this.store.updateTask(task.id, { tokenUsage: accumulatedStepTokenUsage }).catch((err) => {
              executorLog.warn(`${task.id}: failed to persist token usage on step ${stepIndex} complete: ${err}`);
            });
          },
        });
        this.setActiveStepExecutor(task.id, stepExecutor, worktreePath);

        const stepWork = async () => {
          const results = await stepExecutor.executeAll();

          // Check abort conditions after execution completes
          if (this.depAborted.has(task.id)) {
            this.depAborted.delete(task.id);
            await this.handleDepAbortCleanup(task.id, worktreePath);
            return;
          }
          if (this.pausedAborted.has(task.id)) {
            if (this.userCanceledTaskIds.has(task.id)) {
              this.pausedAborted.delete(task.id);
              this.stuckAborted.delete(task.id);
              this.userCanceledTaskIds.delete(task.id);
              await this.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
              return;
            }
            this.pausedAborted.delete(task.id);
            await this.store.logEntry(task.id, "Execution paused — step sessions terminated, moved to todo", undefined, this.getRunContextFor(task.id));
            await this.store.moveTask(task.id, "todo", { preserveResumeState: true });
            return;
          }
          if (this.stuckAborted.has(task.id)) {
            stuckRequeue = this.stuckAborted.get(task.id) ?? true;
            this.stuckAborted.delete(task.id);
            return;
          }

          for (const result of results) {
            if (!result.tokenUsage || tokenUsageRecordedSteps.has(result.stepIndex)) {
              continue;
            }
            accumulatedStepTokenUsage = this.accumulateTokenUsage(accumulatedStepTokenUsage, result.tokenUsage);
          }

          if (accumulatedStepTokenUsage) {
            await this.store.updateTask(task.id, { tokenUsage: accumulatedStepTokenUsage });
          }

          const allSuccess = results.every(r => r.success);
          if (allSuccess) {
            const updatedTask = await this.store.getTask(task.id);
            const modifiedFiles = await this.captureModifiedFiles(worktreePath, updatedTask.baseCommitSha, task.id, audit, "post-session");
            if (modifiedFiles.length > 0) {
              await this.store.updateTask(task.id, { modifiedFiles });
              executorLog.log(`${task.id}: captured ${modifiedFiles.length} modified files`);
              // Audit trail: record filesystem mutation (FN-1404)
              await audit.filesystem({ type: "file:capture-modified", target: task.id, metadata: { files: modifiedFiles } });
            }

            // Post-session branch attribution audit: walk base..branch and surface
            // any commit that's foreign (different FN-id), unattributed (no subject
            // tag AND no Fusion-Task-Id trailer), or own-but-untrailed (signals the
            // commit-msg hook didn't fire — typically a worktree without identity
            // guards or a plumbing-driven commit). Logged loudly so contamination
            // gets caught within minutes of happening rather than days later at
            // merge time (FN-5233 was this pattern).
            try {
              const attributionBase = await this.resolveContaminationBaseRef(worktreePath);
              if (attributionBase && updatedTask.branch) {
                const attribution = await reportBranchAttribution(this.rootDir, updatedTask.branch, attributionBase, task.id);
                const hasAnomaly = attribution.foreign.length > 0 || attribution.unattributed.length > 0 || attribution.ownUntrailed.length > 0;
                if (hasAnomaly) {
                  const summary = `branch-attribution anomalies on ${updatedTask.branch}: foreign=${attribution.foreign.length}, unattributed=${attribution.unattributed.length}, ownUntrailed=${attribution.ownUntrailed.length}, ownTrailed=${attribution.ownTrailed}`;
                  executorLog.warn(`${task.id}: ${summary}`);
                  await this.store.logEntry(task.id, `[branch-attribution] ${summary}`, undefined, this.getRunContextFor(task.id));
                  await audit.git({
                    type: "branch:attribution-anomaly",
                    target: updatedTask.branch,
                    metadata: {
                      taskId: task.id,
                      baseSha: attributionBase,
                      ownTrailed: attribution.ownTrailed,
                      foreign: attribution.foreign,
                      unattributed: attribution.unattributed,
                      ownUntrailed: attribution.ownUntrailed,
                    },
                  });
                }
              }
            } catch (attributionErr: unknown) {
              executorLog.warn(`${task.id}: post-session branch-attribution audit failed: ${attributionErr instanceof Error ? attributionErr.message : String(attributionErr)}`);
            }

            this.scheduleCompletedTaskWatchdog(task.id, "step-session completion");
            if (await this.shouldDeferCompletionForGlobalPause(task.id, "before workflow steps after step-session completion")) {
              return;
            }

            // ── Deterministic verification gate (FN-3345) ──────────
            // Run testCommand/buildCommand after all steps succeed but BEFORE
            // workflow steps and the in-review transition. Skipped in fast mode
            // and when no verification commands are configured.
            if (executionMode !== "fast") {
              if (settings.testCommand?.trim() || settings.buildCommand?.trim()) {
                const verificationResult = await this.runExecutorDeterministicVerification(task, worktreePath, settings, taskEnv);

                if (!verificationResult.allPassed) {
                  const failedType = verificationResult.failedCommand === "testCommand" ? "test" : "build";
                  const failedResult = failedType === "test" ? verificationResult.testResult! : verificationResult.buildResult!;
                  const failedCommand = failedResult.command;
                  const failureOutput = failedResult.stderr || failedResult.stdout || "Unknown error";
                  const summary = summarizeVerificationOutput(failureOutput, failedType);

                  executorLog.log(`${task.id}: [verification] ${failedType} failed — attempting fix agent`);
                  await this.store.logEntry(
                    task.id,
                    `[verification] ${failedType} command failed (exit ${failedResult.exitCode}). Attempting fix agent...`,
                    summary,
                    this.getRunContextFor(task.id),
                  );

                  const maxFixRetries = Math.min(settings.verificationFixRetries ?? 3, 3);

                  if (maxFixRetries === 0) {
                    executorLog.log(`${task.id}: [verification] fix retries set to 0 — sending task back immediately`);
                    await this.sendTaskBackForFix(
                      task, worktreePath,
                      `${failedType} command \`${failedCommand}\` failed (exit ${failedResult.exitCode}):\n${summary}`,
                      `Verification (${failedType})`,
                      `Deterministic verification failed (${failedType})`,
                      true,
                      true,
                    );
                    return;
                  }

                  let fixSucceeded = false;
                  for (let attempt = 1; attempt <= maxFixRetries; attempt++) {
                    const fixed = await this.attemptExecutorVerificationFix(
                      task, worktreePath,
                      {
                        command: failedCommand,
                        exitCode: failedResult.exitCode,
                        output: failureOutput,
                        type: failedType,
                      },
                      settings,
                      attempt,
                      maxFixRetries,
                      taskEnv,
                    );
                    if (fixed) {
                      fixSucceeded = true;
                      executorLog.log(`${task.id}: [verification] fix agent succeeded on attempt ${attempt}/${maxFixRetries}`);
                      await this.store.logEntry(
                        task.id,
                        `[verification] Fix agent succeeded on attempt ${attempt}/${maxFixRetries}. Verification now passing.`,
                        undefined,
                        this.getRunContextFor(task.id),
                      );
                      break;
                    }
                    executorLog.log(`${task.id}: [verification] fix agent attempt ${attempt}/${maxFixRetries} failed`);
                    await this.store.logEntry(
                      task.id,
                      `[verification] Fix agent attempt ${attempt}/${maxFixRetries} failed`,
                      undefined,
                      this.getRunContextFor(task.id),
                    );
                  }

                  if (!fixSucceeded) {
                    executorLog.log(`${task.id}: [verification] all fix attempts exhausted (${maxFixRetries}/${maxFixRetries}) — sending task back`);
                    await this.sendTaskBackForFix(
                      task, worktreePath,
                      `${failedType} command \`${failedCommand}\` failed (exit ${failedResult.exitCode}) after ${maxFixRetries} fix attempts:\n${summary}`,
                      `Verification (${failedType})`,
                      `Deterministic verification failed after ${maxFixRetries} fix attempts`,
                      true,
                      true,
                    );
                    return;
                  }
                }
              }
            }

            // Run workflow steps before moving to in-review — skip in fast mode
            if (executionMode !== "fast") {
              const workflowResult = await this.runWorkflowSteps(task, worktreePath, settings, taskEnv);
              if (workflowResult === "deferred-paused") {
                if (await this.parkTaskAfterWorkflowStepPause(task.id)) {
                  this.pausedAborted.delete(task.id);
                  return;
                }
                if (this.pausedAborted.has(task.id)) {
                  this.pausedAborted.delete(task.id);
                }
                return;
              }
              if (!workflowResult.allPassed) {
                // Check if revision was requested
                if (workflowResult.revisionRequested) {
                  const rerunScheduled = await this.handleWorkflowRevisionRequest(task, worktreePath, workflowResult.feedback, workflowResult.stepName, settings);
                  if (rerunScheduled) {
                    return;
                  }
                } else {
                  // Try to fix workflow step failures with retries
                  const retried = await this.handleWorkflowStepFailure(task, worktreePath, workflowResult.feedback, workflowResult.stepName || "Unknown");
                  if (retried) {
                    return; // Retry scheduled
                  }
                  // Retries exhausted - send back to in-progress for remediation
                  await this.sendTaskBackForFix(task, worktreePath, workflowResult.feedback, workflowResult.stepName || "Unknown", "Workflow step failed");
                  return;
                }
              }
            } else {
              executorLog.log(`${task.id}: fast mode — skipping pre-merge workflow steps`);
              await this.store.logEntry(task.id, "Fast mode — pre-merge workflow steps skipped", undefined, this.getRunContextFor(task.id));
            }

            // Reset retry counters on success
            await this.store.updateTask(task.id, { workflowStepRetries: undefined, taskDoneRetryCount: null });
            if (await this.shouldDeferCompletionForGlobalPause(task.id, "before in-review transition after step-session completion")) {
              return;
            }

            await this.handoffTaskToReview(task, "step-session-completed");
            this.clearCompletedTaskWatchdog(task.id);
            executorLog.log(`✓ ${task.id} completed (step-session) → in-review`);
            this.options.onComplete?.(task);
          } else {
            const failedSteps = results.filter(r => !r.success);
            const errorSummary = failedSteps.map(r => `Step ${r.stepIndex}: ${r.error || "unknown error"}`).join("; ");
            await this.store.updateTask(task.id, { status: "failed", error: errorSummary });
            await this.handoffTaskToReview(task, "step-session-failed");
            executorLog.log(`✗ ${task.id} step-session failed → in-review: ${errorSummary}`);
            this.options.onError?.(task, new Error(errorSummary));
          }
        };

        const retryableStepWork = () => withRateLimitRetry(stepWork, {
          onRetry: (attempt, delayMs, error) => {
            const delaySec = Math.round(delayMs / 1000);
            executorLog.warn(`⏳ ${task.id} rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
            this.store.logEntry(task.id, `Rate limited — retry ${attempt} in ${delaySec}s`, undefined, this.getRunContextFor(task.id)).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              executorLog.warn(`${task.id} failed to log rate-limit retry: ${msg}`);
            });
          },
        });

        try {
          if (this.options.semaphore) {
            await this.options.semaphore.run(retryableStepWork, PRIORITY_EXECUTE);
          } else {
            await retryableStepWork();
          }
        } catch (err: unknown) {
          const { message: errorMessage, detail: errorDetail, stack: errorStack } = formatError(err);
          if (this.depAborted.has(task.id)) {
            this.depAborted.delete(task.id);
            await this.handleDepAbortCleanup(task.id, worktreePath);
          } else if (this.pausedAborted.has(task.id)) {
            if (this.userCanceledTaskIds.has(task.id)) {
              this.pausedAborted.delete(task.id);
              this.stuckAborted.delete(task.id);
              this.userCanceledTaskIds.delete(task.id);
              await this.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
              return;
            }
            this.pausedAborted.delete(task.id);
            await this.store.logEntry(task.id, "Execution paused during step-session", undefined, this.getRunContextFor(task.id));
            await this.store.moveTask(task.id, "todo", { preserveResumeState: true });
          } else if (this.stuckAborted.has(task.id)) {
            stuckRequeue = this.stuckAborted.get(task.id) ?? true;
            this.stuckAborted.delete(task.id);
          } else if (this.options.usageLimitPauser && isUsageLimitError(errorMessage)) {
            await this.options.usageLimitPauser.onUsageLimitHit("executor", task.id, errorMessage);
          } else if (isTransientError(errorMessage)) {
            const decision = computeRecoveryDecision({
              recoveryRetryCount: task.recoveryRetryCount,
              nextRecoveryAt: task.nextRecoveryAt,
            });

            if (decision.shouldRetry) {
              const attempt = decision.nextState.recoveryRetryCount;
              const delay = formatDelay(decision.delayMs);
              if (!isSilentTransientError(errorMessage)) {
                executorLog.warn(`⚡ ${task.id} transient error — retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}: ${errorMessage}`);
                await this.store.logEntry(task.id, `Transient error (retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}): ${errorMessage}`, undefined, this.getRunContextFor(task.id));
              }
              if (worktreePath && existsSync(worktreePath)) {
                try {
                  const settings = await this.store.getSettings();
                  await removeWorktree({
                    worktreePath,
                    rootDir: this.rootDir,
                    settings,
                    taskId: task.id,
                    audit,
                    reason: RemovalReason.ExecutorTransientRetry,
                    expectedOwnerTaskId: task.id,
                    liveOwnerProbe: (path, ownerTaskId) => this.hasActiveWorktreeBinding(ownerTaskId, path),
                  });
                } catch (wtErr: unknown) {
                  const msg = wtErr instanceof Error ? wtErr.message : String(wtErr);
                  executorLog.warn(`${task.id}: worktree removal failed during transient-error retry cleanup (${worktreePath}): ${msg}`);
                }
              }
              await this.store.updateTask(task.id, {
                recoveryRetryCount: decision.nextState.recoveryRetryCount,
                nextRecoveryAt: decision.nextState.nextRecoveryAt,
                worktree: null,
                branch: null,
              });
              await this.store.moveTask(task.id, "todo", { preserveProgress: true });
              stuckRequeue = null; // Prevent outer finally from re-processing
              return;
            }

            executorLog.error(`✗ ${task.id} transient error retries exhausted: ${errorDetail}`);
            if (errorStack) {
              await this.store.logEntry(task.id, `Transient error retries exhausted: ${errorMessage}`, errorStack, this.getRunContextFor(task.id));
            }
            await this.store.updateTask(task.id, {
              status: "failed",
              error: errorMessage,
              recoveryRetryCount: null,
              nextRecoveryAt: null,
            });
            if (accumulatedStepTokenUsage) {
              await this.store.updateTask(task.id, { tokenUsage: accumulatedStepTokenUsage });
            }
            await this.handoffTaskToReview(task, "transient-retries-exhausted");
            executorLog.log(`✗ ${task.id} transient retries exhausted → in-review`);
            this.options.onError?.(task, err instanceof Error ? err : new Error(errorMessage));
          } else {
            if (accumulatedStepTokenUsage) {
              await this.store.updateTask(task.id, { tokenUsage: accumulatedStepTokenUsage });
            }
            if (await this.handleNonContinuableSessionError(task, false, errorMessage)) {
              return;
            }
            executorLog.error(`✗ ${task.id} step-session execution failed:`, errorDetail);
            await this.store.logEntry(task.id, `Step-session execution failed: ${errorMessage}`, errorStack ?? errorDetail, this.getRunContextFor(task.id));
            await this.store.updateTask(task.id, { status: "failed", error: errorMessage });
            await this.handoffTaskToReview(task, "step-session-failed");
            executorLog.log(`✗ ${task.id} step-session execution failed → in-review`);
            this.options.onError?.(task, err instanceof Error ? err : new Error(errorMessage));
          }
        } finally {
          this.executing.delete(task.id);
          executingTaskLock.release(task.id);
          this.loopRecoveryState.delete(task.id);
          // Wrap cleanup in try/catch so activeStepExecutors.delete() always runs.
          // If cleanup() throws, the executor continues to clean up the in-memory map
          // and requeue logic without leaking the reference.
          try {
            await stepExecutor.cleanup();
          } catch (cleanupErr) {
            executorLog.warn(`StepSessionExecutor cleanup failed for ${task.id}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
          }
          this.deleteActiveStepExecutor(task.id);

          // Stuck-requeue: clean up worktree and move to todo
          if (stuckRequeue === true) {
            try {
              // Re-read latest task state. Self-healing may have already moved
              // the task out of in-progress while this step-session execution
              // was unwinding; continuing the cleanup would clobber a valid
              // recovery (see the analogous block in the outer finally for the
              // full reasoning).
              const latestTask = await this.store.getTask(task.id);
              if (latestTask.column !== "in-progress" && latestTask.column !== "todo") {
                executorLog.log(
                  `${task.id} stuck-requeue skipped — task is now in '${latestTask.column}' (recovered concurrently)`,
                );
              } else {
                const settings = await this.store.getSettings();
                const preserveProgress = settings.preserveProgressOnStuckRequeue !== false;

                if (!preserveProgress) {
                  await this.resetStepsIfWorkLost(latestTask);
                }

                if (worktreePath && existsSync(worktreePath)) {
                  try {
                    await removeWorktree({
                      worktreePath,
                      rootDir: this.rootDir,
                      settings,
                      taskId: task.id,
                      reason: RemovalReason.ExecutorStuckKilled,
                      expectedOwnerTaskId: task.id,
                      liveOwnerProbe: (path, ownerTaskId) => this.hasActiveWorktreeBinding(ownerTaskId, path),
                    });
                  } catch (wtErr: unknown) {
                    const msg = wtErr instanceof Error ? wtErr.message : String(wtErr);
                    executorLog.warn(`${task.id}: worktree removal failed during stuck-requeue cleanup (${worktreePath}): ${msg}`);
                  }
                }
                await this.store.updateTask(task.id, { status: "stuck-killed", worktree: null, branch: null });
                if (latestTask.column !== "todo") {
                  await this.store.moveTask(task.id, "todo", preserveProgress ? { preserveProgress: true } : undefined);
                  executorLog.log(`${task.id} moved to todo for retry after stuck kill${preserveProgress ? " (progress preserved)" : ""}`);
                }
              }
            } catch (err: unknown) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              executorLog.error(`Failed to requeue stuck task ${task.id}: ${errorMessage}`);
            }
            stuckRequeue = null; // Prevent outer finally from re-processing
          }
        }
        // Step-session path handled completely — return before outer catch/finally
        return;
      }

      // ── Single-Session Path (default) ────────────────────────────────
      // Build custom tools for the worker
      // Track the last code review verdict per step so we can enforce REVISE
      // (block fn_task_update status="done" until the agent re-reviews and gets APPROVE).
      // Keyed by 0-indexed step (stepIndex). fn_task_update translates from
      // its 1-indexed `step` parameter via `stepIndex = step - 1` (FN-3757).
      const codeReviewVerdicts = new Map<number, ReviewVerdict>();

      let wasPaused = false;
      // Mutable ref — populated after createFnAgent, tools access lazily via closure
      const sessionRef: { current: AgentSession | null } = { current: null };
      // Keyed by 0-indexed step (stepIndex) to match fn_review_step.
      const stepCheckpoints = new Map<number, string>();

      const stuckDetector = this.options.stuckTaskDetector;
      const assignedAgentId = detail.assignedAgentId?.trim();
      const reflectionTools = this.options.reflectionService && settings.reflectionEnabled && assignedAgentId
        ? [createReflectOnPerformanceTool(this.options.reflectionService, assignedAgentId)]
        : [];
      const assignedAgent = assignedAgentId && this.options.agentStore
        ? await this.options.agentStore.getAgent(assignedAgentId).catch(() => null)
        : null;

      // Column-agent SESSION IDENTITY (U4, R2/R3/R4/R8): when the governing execute
      // seam node's declared column binds an agent that supersedes the task's
      // assigned agent, the coding session's MODEL, runtime hint, persona, and
      // memory tools adopt the column agent. The core resolver decides defer vs
      // override (KTD-2); a missing agent logs + falls back (R8). No binding →
      // `columnAgentSeam` is undefined and every line below is byte-identical to the
      // assigned-agent path (characterization parity). Gating contexts key off
      // `identityAgent` — the effective column agent when a binding governs, else
      // the assigned agent (U5/KTD-3 principal substitution).
      const columnAgentSeam = await this.resolveSeamColumnAgent(task, detail);
      const identityAgent = columnAgentSeam?.agent ?? assignedAgent;
      const executorRuntimeHint = extractRuntimeHint(identityAgent?.runtimeConfig);
      // U5 (R6): track the effective column-agent principal so the heartbeat
      // scheduler's reverse guard knows this agent is executing a task it may not
      // be assigned to. Cleared in deleteActiveSession.
      if (columnAgentSeam?.agent) {
        this.effectiveColumnAgentByTask.set(task.id, columnAgentSeam.agent.id);
      }

      // Log fast mode status
      if (executionMode === "fast") {
        executorLog.log(`${task.id}: fast mode — fn_review_step tool not injected`);
      }

      const customTools = [
        this.createTaskUpdateTool(task.id, codeReviewVerdicts, sessionRef, stepCheckpoints, stuckDetector),
        this.createTaskLogTool(task.id),
        this.createTaskCreateTool(),
        this.createTaskAddDepTool(task.id),
        this.createTaskDoneTool(task.id, worktreePath, detail.prompt ?? "", codeReviewVerdicts, () => { taskDone = true; }, audit),
        createRunVerificationTool({
          worktreePath,
          rootDir: this.rootDir,
          taskId: task.id,
          recordActivity: () => stuckDetector?.recordActivity(task.id),
          log: {
            info: (s) => executorLog.log(s),
            warn: (s) => executorLog.warn(s),
            error: (s) => executorLog.warn(s),
          },
        }),
        // Skip fn_review_step tool in fast mode — fast mode bypasses automated review gates
        ...(executionMode !== "fast" ? [
          this.createReviewStepTool(task.id, worktreePath, detail.prompt, codeReviewVerdicts, sessionRef, stepCheckpoints, detail, stuckDetector),
        ] : []),
        this.createSpawnAgentTool(task.id, worktreePath, settings, taskEnv),
        this.createTaskDocumentWriteTool(task.id),
        this.createTaskDocumentReadTool(task.id),
        this.createWorkflowListTool(),
        this.createWorkflowGetTool(),
        this.createWorkflowSelectTool(task.id),
        this.createTaskPromoteTool(task.id),
        this.createWorkflowCreateTool(),
        this.createWorkflowUpdateTool(),
        this.createWorkflowDeleteTool(),
        this.createWorkflowSettingsTool(),
        this.createTraitListTool(),
        ...(isResearchToolSurfaceEnabled(settings)
          ? createResearchTools({
            store: this.store,
            rootDir: this.rootDir,
            getSettings: async () => this.store.getSettings(),
          })
          : []),
        createWebFetchTool(),
        ...createMemoryTools(this.rootDir, settings, identityAgent ? {
          agentMemory: {
            agentId: identityAgent.id,
            agentName: identityAgent.name,
            memory: identityAgent.memory,
          },
        } : undefined),
        // Conditionally add agent self-reflection when enabled and task has an assigned agent.
        ...reflectionTools,
        // Agent delegation tools — discover and delegate work to other agents.
        ...(this.options.agentStore ? [
          createListAgentsTool(this.options.agentStore),
          createDelegateTaskTool(this.options.agentStore, this.store, { rootDir: this.rootDir }),
          ...(assignedAgentId ? [
            createGetAgentConfigTool(this.options.agentStore, assignedAgentId),
            createUpdateAgentConfigTool(this.options.agentStore, assignedAgentId),
            createAgentCreateTool(this.options.agentStore, assignedAgentId),
            createAgentDeleteTool(this.options.agentStore, assignedAgentId),
          ] : []),
        ] : []),
        // Messaging tools — allows executor agents to send and receive messages.
        ...(this.options.messageStore && assignedAgentId ? [
          createSendMessageTool(this.options.messageStore, assignedAgentId, { autoRecovery: settings.autoRecovery, runAudit: audit, taskStore: this.store, settings }),
          createReadMessagesTool(this.options.messageStore, assignedAgentId),
        ] : []),
        // Add plugin tools from PluginRunner
        ...getEnabledPluginTools(this.options.pluginRunner),
      ];

      // Accumulates the full assistant text output for the most recent session.
      // Reset to "" each time a new session begins so detectPseudoPause only
      // sees the last session's output, not the entire conversation history.
      let lastAssistantText = "";

      const agentLogger = new AgentLogger({
        store: this.store,
        taskId: task.id,
        agent: "executor",
        persistAgentToolOutput: settings.persistAgentToolOutput,
        // Executor sessions are task-scoped ephemeral workers.
        persistAgentThinkingLog: resolvePersistAgentThinkingLog(settings, { ephemeral: true }),
        onAgentText: (taskId, delta) => {
          lastAssistantText += delta;
          stuckDetector?.recordActivity(taskId);
          this.options.onAgentText?.(taskId, delta);
        },
        onAgentTool: (taskId, toolName) => {
          stuckDetector?.recordActivity(taskId);
          this.options.onAgentTool?.(taskId, toolName);
        },
      });

      const agentWork = async () => {
        // Resolve model settings using canonical lane hierarchy:
        // 1. Task override pair (modelProvider + modelId)
        // 2. Project execution lane pair (executionProvider + executionModelId)
        // 3. Global execution lane pair (executionGlobalProvider + executionGlobalModelId)
        // 4. Project default override pair (defaultProviderOverride + defaultModelIdOverride)
        // 5. Global default pair (defaultProvider + defaultModelId)
        // Column-agent session identity (U4): the model precedence input is the
        // EFFECTIVE identity agent's runtimeConfig (column agent when it governs,
        // else the assigned agent — byte-identical no-binding path).
        const { provider: executorProvider, modelId: executorModelId } = resolveExecutorSessionModel(
          detail.modelProvider,
          detail.modelId,
          settings,
          (identityAgent?.runtimeConfig ?? undefined) as Record<string, unknown> | undefined,
        );
        const executorFallbackProvider = settings.fallbackProvider;
        const executorFallbackModelId = settings.fallbackModelId;
        const executorThinkingLevel = detail.thinkingLevel ?? settings.defaultThinkingLevel;

        // Determine whether we're resuming a previous session (pause/resume)
        // or starting fresh. Use file-based sessions so conversation state
        // persists across pause/unpause cycles. Resume is allowed only when
        // persisted session metadata still matches the task's live worktree.
        let isResuming = !!task.sessionFile && existsSync(task.sessionFile);
        if (isResuming) {
          const persistedWorktreePath = await extractPersistedSessionWorktreePath(task.sessionFile!, this.rootDir, settings);
          if (!isSessionWorktreeCompatible(persistedWorktreePath, worktreePath)) {
            executorLog.warn(
              `${task.id}: stale sessionFile worktree mismatch (session=${persistedWorktreePath}, task=${worktreePath}); starting fresh session`,
            );
            await this.store.logEntry(
              task.id,
              `Detected stale persisted session metadata (worktree mismatch: ${persistedWorktreePath} vs ${worktreePath}) — discarded resume state and started fresh session`,
              undefined,
              this.getRunContextFor(task.id),
            );
            await this.store.updateTask(task.id, { sessionFile: null });
            isResuming = false;
          }
        }

        const sessionManager = isResuming
          ? SessionManager.open(task.sessionFile!)
          : SessionManager.create(worktreePath);

        executorLog.log(`${task.id}: creating agent session (provider=${executorProvider ?? "default"}, model=${executorModelId ?? "default"}, resuming=${isResuming})`);

        // Resolve per-agent custom instructions for the executor role.
        // Column-agent session identity (U4, R3/KTD-6): when a column agent governs,
        // its TYPED persona (soul/instructionsText, via buildAgentPersona — the same
        // source the custom-node path uses) supersedes the role-resolved executor
        // instructions, so the coding session speaks AS the column agent. No binding
        // → role instructions unchanged (characterization parity).
        const columnAgentPersona = columnAgentSeam ? this.buildAgentPersona(columnAgentSeam.agent) : undefined;
        const executorInstructions = columnAgentPersona
          ?? (await this.resolveInstructionsForRole("executor", settings));

        // Build structured layers for cross-session prompt caching.
        const executorPluginContributions = buildPluginPromptSection(
          "executor-system",
          this.options.pluginRunner,
        );
        if (executorPluginContributions) {
          executorLog.log(`${task.id}: applied plugin prompt contributions for executor-system surface`);
        }

        const executorGoalResolution = await resolveAndEmitGoalContext({
          lane: "executor",
          store: this.store,
          audit,
          taskId: task.id,
          runContext: engineRunContext,
        });
        const executorGoalContext = executorGoalResolution.goalContext;

        const executorLayers = buildPromptLayers({
          basePrompt: getExecutorSystemPrompt(settings),
          goalContext: executorGoalContext,
          agentInstructions: executorInstructions,
          pluginContributions: executorPluginContributions,
        });

        const executorSystemPromptFinal = collapsePromptLayers(executorLayers);

        // sessionFile must be let because it's assigned before downstream retry-session reassignment.
        let session: AgentSession;
        let sessionFile: string | null | undefined;
        try {
          const createdSession = await createResolvedAgentSession({
            sessionPurpose: "executor",
            runtimeHint: executorRuntimeHint,
            pluginRunner: this.options.pluginRunner,
            cwd: worktreePath,
            systemPrompt: executorSystemPromptFinal,
            systemPromptLayers: executorLayers,
            tools: "coding",
            customTools,
            onText: agentLogger.onText,
            onThinking: agentLogger.onThinking,
            onToolStart: agentLogger.onToolStart,
            onToolEnd: agentLogger.onToolEnd,
            defaultProvider: executorProvider,
            defaultModelId: executorModelId,
            fallbackProvider: executorFallbackProvider,
            fallbackModelId: executorFallbackModelId,
            defaultThinkingLevel: executorThinkingLevel,
            runAuditor: audit,
            settings,
            sessionManager,
            taskEnv,
            // Skill selection: use assigned agent skills if available, otherwise role fallback
            ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
            // Column-agent principal alignment (plan U5, R5): action gating is
            // computed for the agent ACTUALLY RUNNING. When the governing execute
            // seam's column binds an agent that supersedes the assigned agent,
            // `identityAgent` is that column agent; otherwise it is `assignedAgent`
            // (byte-identical to before). The builders already accept an `Agent`
            // object, so this is a call-site object swap, not gating-internals surgery.
            actionGateContext: this.buildActionGateContext(task.id, identityAgent, settings.defaultAgentPermissionPolicy),
            permanentAgentGating: this.buildPermanentAgentGatingContext(task.id, identityAgent, settings.defaultAgentPermissionPolicy),
            taskId: task.id,
            taskTitle: detail.title,
            onFallbackModelUsed: createFallbackModelObserver({
              agent: "executor",
              label: "executor",
              store: this.store,
              taskId: task.id,
              taskTitle: detail.title,
            }),
          });
          session = createdSession.session;
          sessionFile = createdSession.sessionFile;
        } catch (sessionStartError) {
          if (await this.recoverMissingWorktreeSessionStartFailure(task, worktreePath, sessionStartError, audit)) {
            return;
          }
          throw sessionStartError;
        }

        const executorModelDesc = describeModel(session);
        const executorModelMarker = `Executor using model: ${executorModelDesc}`;
        if (isResuming) {
          executorLog.log(`${task.id}: resumed session from ${task.sessionFile}`);
          await this.store.logEntry(task.id, `Resumed agent session after unpause (model: ${executorModelDesc})`, undefined, this.getRunContextFor(task.id));
        } else {
          executorLog.log(`${task.id}: using model ${executorModelDesc}`);
          await this.store.logEntry(task.id, executorModelMarker, undefined, this.getRunContextFor(task.id));
          // Persist session file path so pause/resume can reopen it
          if (sessionFile) {
            await this.store.updateTask(task.id, { sessionFile });
          }
        }
        await this.store.appendAgentLog(task.id, executorModelMarker, "text", undefined, "executor");

        // Make session available to custom tools (fn_task_update checkpoint capture, fn_review_step rewind)
        sessionRef.current = session;

        // Register session so the pause listener can terminate it
        // Initialize with empty set of seen comments
        const seenSteeringIds = new Set<string>();
        if (detail.comments) {
          for (const comment of detail.comments) {
            seenSteeringIds.add(comment.id);
          }
        }
        this.setActiveSession(task.id, {
          session,
          seenSteeringIds,
          lastResolvedModelProvider: executorProvider,
          lastResolvedModelId: executorModelId,
          lastTaskModelProvider: detail.modelProvider,
          lastTaskModelId: detail.modelId,
          lastAssignedAgentId: detail.assignedAgentId ?? null,
          // U5 (R7): the effective column-agent governing this session (null when no
          // binding governs — legacy path). The watcher re-resolves this for graph-
          // mode entries to detect a mid-flight workflow-edit / agent-config change.
          lastEffectiveColumnAgentId: columnAgentSeam?.agent.id ?? null,
        }, worktreePath);

        let leaseRenewalTimer: ReturnType<typeof setInterval> | undefined;
        if (detail.assignedAgentId && detail.checkedOutBy === detail.assignedAgentId) {
          const leaseEpoch = detail.checkoutLeaseEpoch ?? 0;
          const checkoutNodeId = detail.checkoutNodeId ?? detail.effectiveNodeId ?? detail.nodeId ?? "local";
          const runId = this.getRunContextFor(task.id)?.runId;
          await this.renewTaskLease(task.id, detail.assignedAgentId, leaseEpoch, checkoutNodeId, runId).catch(() => {});
          leaseRenewalTimer = setInterval(() => {
            void this.renewTaskLease(task.id, detail.assignedAgentId!, leaseEpoch, checkoutNodeId, runId).catch(() => {});
          }, 30_000);
        }

        // Register with stuck task detector for heartbeat monitoring
        stuckDetector?.trackTask(task.id, session);
        executorLog.log(`${task.id}: session registered (model=${describeModel(session)}, stuckDetector=${!!stuckDetector})`);

        // Invoke plugin onAgentRunStart hook (fire-and-forget)
        void this.options.pluginRunner?.invokeHookSafe("onAgentRunStart", task.id);

        try {
          // Record activity on prompt start (heartbeat for stuck detection)
          stuckDetector?.recordActivity(task.id);

          executorLog.log(`${task.id}: calling promptWithFallback()...`);
          if (isResuming) {
            // Session already has full conversation history — just tell the
            // agent it was paused and should pick up where it left off.
            await promptWithFallback(session, [
              "Your session was paused and has now been resumed.",
              "Continue working on the task from where you left off.",
              "Review the current state of your worktree and proceed with the next pending step.",
            ].join("\n"));
          } else {
            const customFieldDefs = await this.resolveTaskCustomFieldDefs(task.id);
            const agentPrompt = buildExecutionPrompt(
              detail,
              this.rootDir,
              settings,
              worktreePath,
              this.options.pluginRunner,
              customFieldDefs,
            );
            await promptWithFallback(session, agentPrompt);
          }

          // Re-raise errors that pi-coding-agent swallowed after exhausting retries.
          // session.prompt() resolves normally even when retries are exhausted —
          // the error is stored on session.state.error instead of being thrown.
          checkSessionError(session);
          await accumulateSessionTokenUsage(this.store, task.id, session, {
            agentId: task.assignedAgentId ?? undefined,
            role: "executor",
          });

          // Check if proactive context compaction is needed based on token cap setting.
          // This runs after the main prompt completes to avoid interrupting active work.
          try {
            const capResult = await this.tokenCapDetector.checkAndCompact(
              session,
              task.id,
              settings.tokenCap,
              async (s) => {
                const compactResult = await compactSessionContext(s);
                if (compactResult) {
                  await this.store.logEntry(
                    task.id,
                    `Context compacted at ${compactResult.tokensBefore} tokens (token cap: ${settings.tokenCap})`,
                    undefined,
                    this.getRunContextFor(task.id),
                  );
                }
                return compactResult;
              },
            );
            if (capResult.triggered) {
              executorLog.log(`${task.id} token cap check: ${capResult.message}`);
            }
          } catch (err) {
            executorLog.log(`${task.id} token cap check failed (non-fatal): ${err}`);
          }

          // If loop recovery is pending (compact-and-resume was triggered by
          // handleLoopDetected), consume the pending state and resume with a
          // deterministic prompt. The session has already been compacted, so
          // we just need to send a fresh prompt to continue execution.
          const loopState = this.loopRecoveryState.get(task.id);
          if (loopState?.pending) {
            loopState.pending = false;
            executorLog.log(`${task.id} consuming loop recovery — resuming with fresh context`);
            await this.store.logEntry(task.id, "Resuming execution after context compaction — taking a different approach", undefined, this.getRunContextFor(task.id));

            // Reset activity tracking so the detector doesn't immediately re-trigger
            stuckDetector?.recordProgress(task.id);

            const resumePrompt = [
              "Your conversation was compacted because you were looping without making progress.",
              "Review the current state of the worktree carefully:",
              "1. Check `git log --oneline` to see what's already been committed",
              "2. Read the files you were working on to understand current state",
              "3. Review the PROMPT.md steps to see which are still pending",
              "",
              "Take a DIFFERENT approach from what you were doing before.",
              "If the current step is complete, call fn_task_update to mark it done and move to the next step.",
              "If you're stuck on a problem, try a simpler or alternative solution.",
              "",
              "Continue the task from where you left off.",
            ].join("\n");

            await promptWithFallback(session, resumePrompt);
            checkSessionError(session);
            await accumulateSessionTokenUsage(this.store, task.id, session, {
            agentId: task.assignedAgentId ?? undefined,
            role: "executor",
          });
          }

          // If dependency was added during execution, discard worktree and move to triage
          if (this.depAborted.has(task.id)) {
            this.depAborted.delete(task.id);
            await this.handleDepAbortCleanup(task.id, worktreePath);
            return;
          }

          // If paused during execution, move to todo so the scheduler can resume
          // after unpause. This path fires when session.dispose() causes the
          // prompt to resolve gracefully instead of throwing.
          if (this.pausedAborted.has(task.id)) {
            if (this.userCanceledTaskIds.has(task.id)) {
              this.pausedAborted.delete(task.id);
              this.stuckAborted.delete(task.id);
              this.userCanceledTaskIds.delete(task.id);
              await this.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
              return;
            }
            this.pausedAborted.delete(task.id);
            wasPaused = true;
            if (await this.shouldFinalizeCompletedTask(task.id, taskDone)) {
              if (await this.shouldDeferCompletionForGlobalPause(task.id, "paused after completion")) {
                return;
              }
              executorLog.log(`${task.id} paused after completion (graceful session exit) — finalizing to in-review`);
              await this.store.logEntry(task.id, "Execution paused after completion — finalizing to in-review");
              await this.persistTokenUsage(task.id);
              await this.handoffTaskToReview(task, "paused-after-completion");
              this.clearCompletedTaskWatchdog(task.id);
              this.options.onComplete?.(task);
            } else {
              executorLog.log(`${task.id} paused (graceful session exit) — moving to todo`);
              await this.store.logEntry(task.id, "Execution paused — session preserved for resume, moved to todo");
              await this.store.moveTask(task.id, "todo", { preserveResumeState: true });
            }
            return;
          }

          // If the stuck task detector disposed the session and the agent exited
          // cleanly, stop here. The requeue is deferred to the finally block
          // (after this.executing is cleared) to prevent a race where the
          // scheduler re-dispatches while the old execution guard is still set.
          if (this.stuckAborted.has(task.id)) {
            if (this.userCanceledTaskIds.has(task.id)) {
              this.pausedAborted.delete(task.id);
              this.stuckAborted.delete(task.id);
              this.userCanceledTaskIds.delete(task.id);
              await this.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
              return;
            }
            stuckRequeue = this.stuckAborted.get(task.id) ?? true;
            this.stuckAborted.delete(task.id);
            executorLog.log(`${task.id} terminated by stuck task detector (graceful session exit)`);
            return;
          }

          // If the agent didn't explicitly call fn_task_done, check whether
          // all steps are already complete — treat as implicit done to avoid
          // unnecessary retry sessions for context-overflow / compaction cases.
          if (!taskDone) {
            const implicitCheck = await this.store.getTask(task.id);
            if (implicitCheck.steps.length > 0 &&
                implicitCheck.steps.every((s) => s.status === "done" || s.status === "skipped")) {
              // Implicit path has no summary; evaluateTaskDoneRefusal will skip summary-claims-incomplete and only enforce pending-code-review-revise / bulk-step-completion-without-review.
              const refusal = evaluateTaskDoneRefusal(implicitCheck, {}, codeReviewVerdicts);
              if (!refusal.ok) {
                await this.handleImplicitTaskDoneRefusal(implicitCheck, refusal);
                return;
              }
              taskDone = true;
              executorLog.log(`${task.id} all steps done — treating as implicit fn_task_done`);
              await this.store.logEntry(task.id, "All steps complete — implicit fn_task_done (agent did not call tool explicitly)", undefined, this.getRunContextFor(task.id));
              this.scheduleCompletedTaskWatchdog(task.id, "implicit fn_task_done");
            }
          }

          if (taskDone) {
            // Capture modified files before running workflow steps
            const updatedTask = await this.store.getTask(task.id);
            const modifiedFiles = await this.captureModifiedFiles(worktreePath, updatedTask.baseCommitSha, task.id, audit, "workflow-fanout");
            if (modifiedFiles.length > 0) {
              await this.store.updateTask(task.id, { modifiedFiles });
              executorLog.log(`${task.id}: captured ${modifiedFiles.length} modified files`);
            }

            // Graph-driven completion (interpreter cutover): the workflow graph
            // owns workflow steps, review handoff, and merge from here — stop
            // at the implementation-complete boundary and hand control back.
            const graphCompletion = this.graphCompletionInterceptors.get(task.id);
            if (graphCompletion) {
              this.clearCompletedTaskWatchdog(task.id);
              executorLog.log(`✓ ${task.id} implementation complete — graph interpreter owns the remaining lifecycle`);
              graphCompletion({ modifiedFiles });
              return;
            }

            this.scheduleCompletedTaskWatchdog(task.id, "task completion");
            if (await this.shouldDeferCompletionForGlobalPause(task.id, "before workflow steps after task completion")) {
              return;
            }

            // Run workflow steps before moving to in-review — skip in fast mode
            if (executionMode !== "fast") {
              const workflowResult = await this.runWorkflowSteps(task, worktreePath, settings, taskEnv);
              if (workflowResult === "deferred-paused") {
                if (await this.parkTaskAfterWorkflowStepPause(task.id)) {
                  this.pausedAborted.delete(task.id);
                  wasPaused = true;
                  return;
                }
                if (this.pausedAborted.has(task.id)) {
                  this.pausedAborted.delete(task.id);
                  wasPaused = true;
                }
                return;
              }
              if (!workflowResult.allPassed) {
                // Check if revision was requested
                if (workflowResult.revisionRequested) {
                  const rerunScheduled = await this.handleWorkflowRevisionRequest(task, worktreePath, workflowResult.feedback, workflowResult.stepName, settings);
                  if (rerunScheduled) {
                    return;
                  }
                } else {
                  // Try to fix workflow step failures with retries
                  const retried = await this.handleWorkflowStepFailure(task, worktreePath, workflowResult.feedback, workflowResult.stepName || "Unknown");
                  if (retried) {
                    return; // Retry scheduled
                  }
                  // Retries exhausted - send back to in-progress for remediation
                  await this.sendTaskBackForFix(task, worktreePath, workflowResult.feedback, workflowResult.stepName || "Unknown", "Workflow step failed");
                  return;
                }
              }
            } else {
              executorLog.log(`${task.id}: fast mode — skipping pre-merge workflow steps`);
              await this.store.logEntry(task.id, "Fast mode — pre-merge workflow steps skipped", undefined, this.getRunContextFor(task.id));
            }

            // Reset retry counters on success
            await this.store.updateTask(task.id, { workflowStepRetries: undefined, taskDoneRetryCount: null });
            if (await this.shouldDeferCompletionForGlobalPause(task.id, "before in-review transition after task completion")) {
              return;
            }

            await this.persistTokenUsage(task.id);
            await this.handoffTaskToReview(task, "fn_task_done");
            this.clearCompletedTaskWatchdog(task.id);
            executorLog.log(`✓ ${task.id} completed → in-review`);
            this.options.onComplete?.(task);
          } else {
            let taskDoneSessionRetries = 0;
            let retryAbortedDueToReclaim = false;
            let refusalHandled = false;
            let pendingReviewParked = false;
            while (!taskDone && taskDoneSessionRetries < MAX_TASK_DONE_SESSION_RETRIES) {
              const liveTask = await this.store.getTask(task.id);
              const hasExplicitWorktreeBinding = typeof liveTask.worktree === "string" || liveTask.worktree === null;
              const hasExplicitBranchBinding = typeof liveTask.branch === "string" || liveTask.branch === null;
              const worktreeContractIntact = liveTask.column === "in-progress"
                && !liveTask.paused
                && (!hasExplicitWorktreeBinding || liveTask.worktree === worktreePath)
                && (!hasExplicitBranchBinding || (typeof liveTask.branch === "string" && liveTask.branch.length > 0));
              if (!worktreeContractIntact) {
                const reclaimMessage = `${task.id}: worktree/branch reclaimed during no-fn_task_done retry — aborting retry and requeueing`;
                executorLog.log(reclaimMessage);
                await this.store.logEntry(task.id, reclaimMessage, undefined, this.getRunContextFor(task.id));
                this.deleteActiveSession(task.id);
                this.tokenUsageBaselines.delete(task.id);
                session.dispose();
                retryAbortedDueToReclaim = true;
                break;
              }

              const pendingReviewBlock = detectPendingReviewBlock(liveTask, codeReviewVerdicts);
              if (pendingReviewBlock.blocked) {
                executorLog.log(
                  `[executor] ${task.id}: fn_task_done not called but task is blocked on pending review (${pendingReviewBlock.reason}) — skipping retry session`,
                );
                await this.store.logEntry(
                  task.id,
                  `Agent finished without calling fn_task_done but Step ${pendingReviewBlock.stepIndex + 1} is blocked on pending review (${pendingReviewBlock.reason}) — skipping retry session`,
                  undefined,
                  this.getRunContextFor(task.id),
                );
                this.deleteActiveSession(task.id);
                this.tokenUsageBaselines.delete(task.id);
                session.dispose();
                await this.persistTokenUsage(task.id);
                // A pending-review block is not an execution failure. The executor
                // cannot continue until the reviewer decision is resolved, so park
                // the task in review without setting status=failed; otherwise the
                // merge/review queue deadlocks on a task that is both in-review and
                // failed.
                await this.handoffTaskToReview(task, "executor-exit-while-review-pending");
                pendingReviewParked = true;
                break;
              }

              taskDoneSessionRetries++;
              executorLog.log(
                `⚠ ${task.id} finished without fn_task_done — retrying with new session (${taskDoneSessionRetries}/${MAX_TASK_DONE_SESSION_RETRIES})`,
              );
              await this.store.logEntry(
                task.id,
                `Agent finished without calling fn_task_done — retrying with new session (${taskDoneSessionRetries}/${MAX_TASK_DONE_SESSION_RETRIES})`,
                undefined,
                this.getRunContextFor(task.id),
              );

              // Capture and analyse the previous session's text before resetting.
              const previousSessionText = lastAssistantText;
              const pseudoPause = detectPseudoPause(previousSessionText);

              if (pseudoPause.kind !== "none") {
                const shortMatch = (pseudoPause.matched ?? "").slice(0, 120);
                await this.store.logEntry(
                  task.id,
                  `Pseudo-pause detected (kind=${pseudoPause.kind}, matched='${shortMatch}')`,
                  undefined,
                  this.getRunContextFor(task.id),
                );
                executorLog.log(`${task.id} pseudo-pause detected (kind=${pseudoPause.kind}): ${shortMatch}`);
              }

              // Dispose old session and create a fresh one.
              // Reset lastAssistantText so the new session's text is tracked cleanly.
              lastAssistantText = "";
              this.deleteActiveSession(task.id);
              this.tokenUsageBaselines.delete(task.id);
              session.dispose();

              let retrySession: AgentSession | null = null;
              try {
                const createdRetrySession = await createResolvedAgentSession({
                  sessionPurpose: "executor",
                  runtimeHint: executorRuntimeHint,
                  pluginRunner: this.options.pluginRunner,
                  cwd: worktreePath,
                  systemPrompt: executorSystemPromptFinal,
                  systemPromptLayers: executorLayers,
                  tools: "coding",
                  customTools,
                  onText: agentLogger.onText,
                  onThinking: agentLogger.onThinking,
                  onToolStart: agentLogger.onToolStart,
                  onToolEnd: agentLogger.onToolEnd,
                  defaultProvider: executorProvider,
                  defaultModelId: executorModelId,
                  fallbackProvider: executorFallbackProvider,
                  fallbackModelId: executorFallbackModelId,
                  defaultThinkingLevel: executorThinkingLevel,
                  runAuditor: audit,
                  settings,
                  sessionManager: SessionManager.create(worktreePath),
                  taskEnv,
                  // Skill selection: use assigned agent skills if available, otherwise role fallback
                  ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
                  // U5 (R5): retry session re-keys gating to the effective principal,
                  // mirroring the primary execute-seam session above.
                  actionGateContext: this.buildActionGateContext(task.id, identityAgent, settings.defaultAgentPermissionPolicy),
                  permanentAgentGating: this.buildPermanentAgentGatingContext(task.id, identityAgent, settings.defaultAgentPermissionPolicy),
                });
                retrySession = createdRetrySession.session;
                if (createdRetrySession.sessionFile) {
                  this.store.updateTask(task.id, { sessionFile: createdRetrySession.sessionFile }).catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    executorLog.warn(`${task.id} failed to persist retry sessionFile: ${msg}`);
                  });
                }

                session = retrySession;
                sessionRef.current = retrySession;
                this.setActiveSession(task.id, {
                  session: retrySession,
                  seenSteeringIds,
                  lastResolvedModelProvider: executorProvider,
                  lastResolvedModelId: executorModelId,
                  lastTaskModelProvider: detail.modelProvider,
                  lastTaskModelId: detail.modelId,
                  lastAssignedAgentId: detail.assignedAgentId ?? null,
                  // U5 (R7): preserve the effective column-agent across the retry.
                  lastEffectiveColumnAgentId: columnAgentSeam?.agent.id ?? null,
                }, worktreePath);
                stuckDetector?.trackTask(task.id, retrySession);

                const retryCustomFieldDefs = await this.resolveTaskCustomFieldDefs(task.id);
                let retryPrompt: string;
                if (pseudoPause.kind !== "none") {
                  const shortMatch = (pseudoPause.matched ?? "").slice(0, 120);
                  retryPrompt = [
                    `Your previous turn ended with a pseudo-pause: "${shortMatch}". This is forbidden.`,
                    "",
                    "Turn-ending rules you violated:",
                    "- You MUST NOT end a turn by asking the user a question, summarizing progress, or requesting permission to continue.",
                    "- Phrases like 'If you want, I can continue', 'Should I proceed?', 'Let me know if...' are FORBIDDEN turn-endings.",
                    "- The user is not watching this conversation. Questions written as prose are ignored.",
                    "- If you genuinely cannot proceed, call fn_task_done with a clear explanation — never write the blocker as plain prose.",
                    "",
                    "What you must do now:",
                    "1. Review the PROMPT.md steps and identify the next pending step.",
                    "2. Do the work for that step immediately — call fn_task_update, write code, run tests.",
                    "3. Continue until all steps are done, then call fn_task_done.",
                    "Do NOT ask for permission. Do NOT write a summary. Just call a tool and keep working.",
                    "",
                    "Original task:",
                    buildExecutionPrompt(detail, this.rootDir, settings, worktreePath, this.options.pluginRunner, retryCustomFieldDefs),
                  ].join("\n");
                } else {
                  retryPrompt = [
                    "Your previous session ended without calling the fn_task_done tool.",
                    "The task may already be complete — review the current state of the worktree and either:",
                    "1. If the work is done, call fn_task_done with a summary of what was accomplished.",
                    "2. If there is remaining work, finish it and then call fn_task_done.",
                    "",
                    "Original task:",
                    buildExecutionPrompt(detail, this.rootDir, settings, worktreePath, this.options.pluginRunner, retryCustomFieldDefs),
                  ].join("\n");
                }

                stuckDetector?.recordActivity(task.id);
                await promptWithFallback(retrySession, retryPrompt);
                checkSessionError(retrySession);
                await accumulateSessionTokenUsage(this.store, task.id, retrySession, {
                  agentId: task.assignedAgentId ?? undefined,
                  role: "executor",
                });
              } catch (retryError) {
                this.deleteActiveSession(task.id);
                this.tokenUsageBaselines.delete(task.id);
                retrySession?.dispose();
                if (await this.recoverMissingWorktreeSessionStartFailure(task, worktreePath, retryError, audit)) {
                  return;
                }
                throw retryError;
              }

              if (!taskDone) {
                const implicitCheck = await this.store.getTask(task.id);
                if (implicitCheck.steps.length > 0 &&
                    implicitCheck.steps.every((s) => s.status === "done" || s.status === "skipped")) {
                  // Implicit path has no summary; evaluateTaskDoneRefusal will skip summary-claims-incomplete and only enforce pending-code-review-revise / bulk-step-completion-without-review.
                  const refusal = evaluateTaskDoneRefusal(implicitCheck, {}, codeReviewVerdicts);
                  if (!refusal.ok) {
                    await this.handleImplicitTaskDoneRefusal(implicitCheck, refusal);
                    retrySession?.dispose();
                    retrySession = null;
                    retryAbortedDueToReclaim = false;
                    refusalHandled = true;
                    break;
                  }
                  taskDone = true;
                  executorLog.log(`${task.id} all steps done — treating as implicit fn_task_done`);
                  await this.store.logEntry(task.id, "All steps complete — implicit fn_task_done (agent did not call tool explicitly)", undefined, this.getRunContextFor(task.id));
                  this.scheduleCompletedTaskWatchdog(task.id, "implicit fn_task_done");
                }
              }
            }

            if (taskDone) {
              const updatedTask = await this.store.getTask(task.id);
              const modifiedFiles = await this.captureModifiedFiles(worktreePath, updatedTask.baseCommitSha, task.id, audit, "no-task-done-retry");
              if (modifiedFiles.length > 0) {
                await this.store.updateTask(task.id, { modifiedFiles });
                executorLog.log(`${task.id}: captured ${modifiedFiles.length} modified files`);
              }

              this.scheduleCompletedTaskWatchdog(task.id, "task completion retry");
              if (await this.shouldDeferCompletionForGlobalPause(task.id, "before workflow steps after task completion retry")) {
                return;
              }

              // Run workflow steps before moving to in-review — skip in fast mode
              if (executionMode !== "fast") {
                const workflowResult = await this.runWorkflowSteps(task, worktreePath, settings, taskEnv);
                if (workflowResult === "deferred-paused") {
                  if (await this.parkTaskAfterWorkflowStepPause(task.id)) {
                    this.pausedAborted.delete(task.id);
                    wasPaused = true;
                    return;
                  }
                  if (this.pausedAborted.has(task.id)) {
                    this.pausedAborted.delete(task.id);
                    wasPaused = true;
                  }
                  return;
                }
                if (!workflowResult.allPassed) {
                  if (workflowResult.revisionRequested) {
                    const rerunScheduled = await this.handleWorkflowRevisionRequest(task, worktreePath, workflowResult.feedback, workflowResult.stepName, settings);
                    if (rerunScheduled) {
                      return;
                    }
                  } else {
                    await this.sendTaskBackForFix(task, worktreePath, workflowResult.feedback, workflowResult.stepName || "Unknown", "Workflow step failed on retry");
                    return;
                  }
                }
              } else {
                executorLog.log(`${task.id}: fast mode — skipping pre-merge workflow steps`);
                await this.store.logEntry(task.id, "Fast mode — pre-merge workflow steps skipped", undefined, this.getRunContextFor(task.id));
              }

              await this.store.updateTask(task.id, { workflowStepRetries: undefined, taskDoneRetryCount: null });
              if (await this.shouldDeferCompletionForGlobalPause(task.id, "before in-review transition after task completion retry")) {
                return;
              }

              await this.persistTokenUsage(task.id);
              await this.handoffTaskToReview(task, "fn_task_done-retry-completed");
              this.clearCompletedTaskWatchdog(task.id);
              executorLog.log(`✓ ${task.id} completed on retry → in-review`);
              this.options.onComplete?.(task);
            } else if (retryAbortedDueToReclaim) {
              // FN-4806: Worktree/branch was reclaimed mid-retry by an engine-side housekeeping path
              // (e.g. FN-4546 stale-active-branch reclaim, FN-4742 self-healing removals). This is NOT
              // an agent failure — the agent never got a fair retry attempt. Silently requeue to todo
              // with preserved progress so a fresh worktree is created on next pickup. Do not mark
              // status=failed, do not surface onError, do not burn taskDoneRetryCount budget.
              const silentMessage = `${task.id}: worktree/branch reclaimed mid-retry — requeued to todo (engine self-heal, no failure)`;
              await this.store.logEntry(
                task.id,
                "Worktree/branch reclaimed mid-retry — requeued to todo (engine self-heal, no failure)",
                undefined,
                this.getRunContextFor(task.id),
              );
              // Clear any stale binding so the next pickup creates a fresh worktree.
              // baseCommitSha is also cleared because it pinned to the now-reclaimed worktree;
              // the next pickup will re-anchor it on the fresh checkout.
              await this.store.updateTask(task.id, { worktree: null, branch: null, baseCommitSha: null });
              await this.persistTokenUsage(task.id);
              await this.store.moveTask(task.id, "todo", { preserveProgress: true });
              executorLog.log(silentMessage);
            } else if (refusalHandled) {
              return;
            } else if (pendingReviewParked) {
              return;
            } else {
              // FN-4806: Genuine "agent finished without calling fn_task_done after N retries"
              // exhaustion. Not a reclaim/self-heal — the agent had a fair chance and failed to
              // signal completion. Mark failed, surface onError, and either requeue (budget
              // remaining) or escalate to in-review (budget exhausted).
              const priorRequeues = task.taskDoneRetryCount ?? 0;
              const nextRequeueCount = priorRequeues + 1;
              const errorMessage = `Agent finished without calling fn_task_done (after ${MAX_TASK_DONE_SESSION_RETRIES} retries)`;

              if (priorRequeues < MAX_TASK_DONE_REQUEUE_RETRIES) {
                await this.store.updateTask(task.id, {
                  status: "failed",
                  error: errorMessage,
                  taskDoneRetryCount: nextRequeueCount,
                });
                await this.store.logEntry(
                  task.id,
                  `${errorMessage} — requeued to todo immediately (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`,
                  undefined,
                  this.getRunContextFor(task.id),
                );
                await this.store.moveTask(task.id, "todo", { preserveProgress: true });
                executorLog.log(`✗ ${task.id} failed after ${MAX_TASK_DONE_SESSION_RETRIES} retries — requeued to todo (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`);
              } else {
                await this.store.updateTask(task.id, { status: "failed", error: errorMessage });
                await this.store.logEntry(task.id, `${errorMessage} — moved to in-review for inspection`, undefined, this.getRunContextFor(task.id));
                await this.persistTokenUsage(task.id);
                await this.handoffTaskToReview(task, "max-task-done-retries-exhausted");
                executorLog.log(`✗ ${task.id} failed after ${MAX_TASK_DONE_SESSION_RETRIES} retries — no fn_task_done → in-review`);
              }
              this.options.onError?.(task, new Error(errorMessage));
            }
          }
        } finally {
          if (leaseRenewalTimer) {
            clearInterval(leaseRenewalTimer);
          }
          this.deleteActiveSession(task.id);
          stuckDetector?.untrackTask(task.id);
          await agentLogger.flush();
          await this.persistTokenUsage(task.id, session).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            executorLog.warn(`${task.id}: failed to persist final single-session token usage before dispose: ${msg}`);
          });
          session.dispose();
          // Terminate all spawned child agents when parent session ends
          await this.terminateAllChildren(task.id);
          // Clear session file when task completes or fails (not when paused —
          // the file is preserved so unpause can resume the conversation).
          // Check both the local flag (graceful exit) and the instance set
          // (error path where dispose caused prompt to throw).
          if (!wasPaused && !this.pausedAborted.has(task.id)) {
            this.store.updateTask(task.id, { sessionFile: null }).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              executorLog.warn(`${task.id} failed to clear sessionFile: ${msg}`);
            });
          }
          // Invoke plugin onAgentRunEnd hook (fire-and-forget)
          void this.options.pluginRunner?.invokeHookSafe("onAgentRunEnd", task.id);
        }
      };

      const retryableWork = () => withRateLimitRetry(agentWork, {
        onRetry: (attempt, delayMs, error) => {
          const delaySec = Math.round(delayMs / 1000);
          executorLog.warn(`⏳ ${task.id} rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
          this.store.logEntry(task.id, `Rate limited — retry ${attempt} in ${delaySec}s`, undefined, this.getRunContextFor(task.id)).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            executorLog.warn(`${task.id} failed to log rate-limit retry: ${msg}`);
          });
        },
      });

      if (this.options.semaphore) {
        await this.options.semaphore.run(retryableWork, PRIORITY_EXECUTE);
      } else {
        await retryableWork();
      }
    } catch (err: unknown) {
      const { message: errorMessage, detail: errorDetail, stack: errorStack } = formatError(err);
      if (this.depAborted.has(task.id)) {
        // Dependency added mid-execution — discard worktree and move to triage
        this.depAborted.delete(task.id);
        await this.handleDepAbortCleanup(task.id, worktreePath);
      } else if (errorMessage.includes("Invalid transition")) {
        // Task was moved by user/process while executor was running — already in desired state
        // This check must come before pausedAborted since it's more specific
        const transitionMatch = errorMessage.match(/Invalid transition: '([^']+)' → '([^']+)'/);
        const fromColumn = transitionMatch?.[1] ?? "unknown";
        const toColumn = transitionMatch?.[2] ?? "unknown";
        const logMessage = `Task already moved from '${fromColumn}' — skipping transition to '${toColumn}'`;
        executorLog.log(`${task.id} ${logMessage}`);
        await this.store.logEntry(task.id, logMessage, errorMessage, this.getRunContextFor(task.id));
        if (fromColumn === "in-review" && toColumn === "in-review") {
          try {
            const finalizeResult = await this.finalizeAlreadyReviewedTask(task.id);
            executorLog.log(`${task.id} duplicate in-review finalization result: ${finalizeResult}`);
          } catch (finalizeErr: unknown) {
            const finalizeErrMessage = finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr);
            executorLog.warn(`${task.id} failed to finalize duplicate in-review transition: ${finalizeErrMessage}`);
          }
        }
        // Task finished successfully (just already moved), so call onComplete
        this.options.onComplete?.(task);
      } else if (this.pausedAborted.has(task.id)) {
        // Task was paused mid-execution — clean up worktree and move to todo
        if (this.userCanceledTaskIds.has(task.id)) {
          this.pausedAborted.delete(task.id);
          this.stuckAborted.delete(task.id);
          this.userCanceledTaskIds.delete(task.id);
          await this.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
          return;
        }
        this.pausedAborted.delete(task.id);
        const latestTask = await this.store.getTask(task.id);
        if (
          latestTask?.column === "todo" &&
          latestTask.paused === true &&
          ((latestTask.currentStep ?? 0) > 0 || latestTask.steps?.some((step) => step.status === "done" || step.status === "in-progress"))
        ) {
          executorLog.log(`${task.id} paused-abort cleanup skipped — incomplete task is already parked with progress preserved`);
          await this.store.logEntry(
            task.id,
            "Execution abort cleanup skipped — incomplete stuck-loop task is already parked with progress preserved",
            undefined,
            this.getRunContextFor(task.id),
          );
          return;
        }
        if (await this.shouldFinalizeCompletedTask(task.id, taskDone)) {
          if (await this.shouldDeferCompletionForGlobalPause(task.id, "paused after completion")) {
            return;
          }
          executorLog.log(`${task.id} paused after completion — finalizing to in-review`);
          await this.store.logEntry(task.id, "Execution paused after completion — finalizing to in-review", undefined, this.getRunContextFor(task.id));
          await this.persistTokenUsage(task.id);
          await this.handoffTaskToReview(task, "paused-after-completion");
          this.options.onComplete?.(task);
        } else {
          executorLog.log(`${task.id} paused — moving to todo`);
          if (worktreePath && existsSync(worktreePath)) {
            try {
              const settings = await this.store.getSettings();
              await removeWorktree({
                worktreePath,
                rootDir: this.rootDir,
                settings,
                taskId: task.id,
                audit,
                reason: RemovalReason.ExecutorDispose,
                expectedOwnerTaskId: task.id,
                liveOwnerProbe: (path, ownerTaskId) => this.hasActiveWorktreeBinding(ownerTaskId, path),
              });
              executorLog.log(`Removed old worktree for paused task: ${worktreePath}`);
            } catch (cleanupErr: unknown) {
              const cleanupErrMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
              executorLog.warn(`Failed to remove old worktree ${worktreePath}: ${cleanupErrMessage}`);
            }
          }
          await this.store.updateTask(task.id, { worktree: undefined, branch: undefined });
          await this.store.logEntry(task.id, "Execution paused — agent terminated, moved to todo", undefined, this.getRunContextFor(task.id));
          await this.store.moveTask(task.id, "todo");
        }
      } else if (this.stuckAborted.has(task.id)) {
        // Task was killed by stuck task detector — defer requeue to finally block
        // (after this.executing is cleared) to prevent re-dispatch race.
        if (this.userCanceledTaskIds.has(task.id)) {
          this.pausedAborted.delete(task.id);
          this.stuckAborted.delete(task.id);
          this.userCanceledTaskIds.delete(task.id);
          await this.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
          return;
        }
        stuckRequeue = this.stuckAborted.get(task.id) ?? true;
        this.stuckAborted.delete(task.id);
        executorLog.log(`${task.id} terminated by stuck task detector — will ${stuckRequeue ? "retry" : "not retry (budget exhausted)"}`);
      } else {
        // Context-limit error reached the executor after promptWithFallback's auto-compaction
        // already attempted to recover. Recovery strategy (in order):
        //   1. Reduced-prompt retry in the same session (up to MAX_REDUCED_PROMPT_ATTEMPTS)
        //   2. Fresh-session requeue — terminate the saturated session and move the task
        //      back to "todo" so the next dispatch gets a clean session (bounded by
        //      recoveryRetryCount / MAX_RECOVERY_RETRIES).
        // FN-2182 class: Step 7 overflow after earlier compaction used to hit the
        // loopAttempts<1 guard and fail permanently; the requeue path below recovers
        // by restarting with a fresh session against the already-written step output.
        const MAX_REDUCED_PROMPT_ATTEMPTS = 3;
        const loopState = this.loopRecoveryState.get(task.id);
        const loopAttempts = loopState?.attempts ?? 0;
        const isContextError = isContextLimitError(errorMessage);

        if (isContextError && loopAttempts < MAX_REDUCED_PROMPT_ATTEMPTS) {
          const activeEntry = this.activeSessions.get(task.id);
          if (activeEntry) {
            executorLog.log(`${task.id} context limit error after auto-compaction — attempting reduced-prompt retry (${loopAttempts + 1}/${MAX_REDUCED_PROMPT_ATTEMPTS})`);
            await this.store.logEntry(task.id, `Context limit error after auto-compaction — attempting reduced-prompt retry (${loopAttempts + 1}/${MAX_REDUCED_PROMPT_ATTEMPTS}): ${errorMessage}`, undefined, this.getRunContextFor(task.id));

            this.loopRecoveryState.set(task.id, { attempts: loopAttempts + 1, pending: false });

            try {
              this.options.stuckTaskDetector?.recordProgress(task.id);
              // Build a reduced prompt that's simpler and shorter to avoid context overflow
              const reducedPrompt = [
                "Your previous attempt hit the context window limit.",
                "Focus on completing the task efficiently with minimal context:",
                "1. Review git status and git log to see what's been done",
                "2. Identify the most critical remaining work",
                "3. Complete it with a simpler, more focused approach",
                "",
                "Do not repeat what's already been done. Just complete the task and call fn_task_done.",
              ].join("\n");

              await promptWithFallback(activeEntry.session, reducedPrompt);
              checkSessionError(activeEntry.session);
              await accumulateSessionTokenUsage(this.store, task.id, activeEntry.session, {
                agentId: task.assignedAgentId ?? undefined,
                role: "executor",
              });

              // Reduced-prompt retry succeeded — return to let the finally block clean up
              // without marking the task as failed.
              executorLog.log(`${task.id} reduced-prompt recovery succeeded — continuing`);
              await this.store.logEntry(task.id, "Reduced-prompt recovery succeeded — continuing execution", undefined, this.getRunContextFor(task.id));
              return;
            } catch (reducedErr: unknown) {
              const reducedErrorMessage = reducedErr instanceof Error ? reducedErr.message : String(reducedErr);
              if (!isContextLimitError(reducedErrorMessage)) {
                executorLog.error(`${task.id} reduced-prompt recovery also failed: ${reducedErrorMessage}`);
                await this.store.logEntry(task.id, `Reduced-prompt recovery failed: ${reducedErrorMessage}`, undefined, this.getRunContextFor(task.id));
                // Non-context failure — fall through to mark task as failed
              } else {
                // Still a context error — the session is saturated beyond recovery.
                // Fall through to the fresh-session requeue path below.
                executorLog.warn(`${task.id} session still saturated after reduced-prompt retry — will attempt fresh-session requeue`);
                await this.store.logEntry(task.id, `Reduced-prompt retry still over context — will attempt fresh-session requeue`, undefined, this.getRunContextFor(task.id));
              }
            }
          }
        }

        // Fresh-session requeue for context-limit errors: the saturated session
        // cannot be salvaged, but the task's git state is intact. Move the task
        // back to todo so the next scheduling pass creates a new session.
        if (isContextError) {
          const decision = computeRecoveryDecision({
            recoveryRetryCount: task.recoveryRetryCount,
            nextRecoveryAt: task.nextRecoveryAt,
          });

          if (decision.shouldRetry) {
            const attempt = decision.nextState.recoveryRetryCount;
            const delay = formatDelay(decision.delayMs);
            executorLog.warn(`⚡ ${task.id} context-overflow fresh-session requeue ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}`);
            await this.store.logEntry(task.id, `Context-overflow fresh-session requeue (${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}): ${errorMessage}`, undefined, this.getRunContextFor(task.id));
            // Retain the worktree and accumulated step progress so the fresh
            // session resumes where the saturated one left off, but clear
            // sessionFile synchronously here so the next dispatch is forced
            // to spawn a brand-new session instead of reopening the
            // over-context one. The session-end finally block also clears
            // sessionFile, but it runs as fire-and-forget — if moveTask
            // wins the task lock first, the next executor pass would
            // observe a stale sessionFile and resume into the saturated
            // session, looping on the same context-limit failure.
            await this.store.updateTask(task.id, {
              recoveryRetryCount: decision.nextState.recoveryRetryCount,
              nextRecoveryAt: decision.nextState.nextRecoveryAt,
              sessionFile: null,
            });
            await this.store.moveTask(task.id, "todo", { preserveResumeState: true });
            return;
          }

          executorLog.error(`✗ ${task.id} context-overflow requeue budget exhausted (${MAX_RECOVERY_RETRIES} attempts): ${errorMessage}`);
          await this.store.logEntry(task.id, `Context-overflow requeues exhausted after ${MAX_RECOVERY_RETRIES} attempts: ${errorMessage}`, undefined, this.getRunContextFor(task.id));
          // Reset so downstream failure path can persist cleanly
          await this.store.updateTask(task.id, {
            recoveryRetryCount: null,
            nextRecoveryAt: null,
          });
          // Fall through to terminal failure marking
        // Contamination recovery lives in executor because branch cross-contamination
        // is surfaced here from task execution preflight; merger empty-cherry-pick
        // handling does not throw BranchCrossContaminationError in its own path.
        } else if (err instanceof BranchCrossContaminationError) {
          const details = err.foreignCommits
            .map((commit) => `${commit.sha.slice(0, 12)}:${commit.foreignTaskId}`)
            .join(", ");
          await this.store.logEntry(task.id, `[recovery] branch cross-contamination detected on ${err.branchName} since ${err.baseSha}: ${details}`, undefined, this.getRunContextFor(task.id));

          try {
            const recoveredBootstrapMisbinding = await this.tryBootstrapMisbindingRecovery(task, err, audit);
            if (recoveredBootstrapMisbinding) {
              return;
            }

            const classified = await classifyForeignCommits({
              repoDir: this.rootDir,
              branchName: err.branchName,
              baseSha: err.baseSha,
              foreignCommits: err.foreignCommits,
            });

            const misrouted: Array<{ commit: (typeof classified.unique)[number]; foreignTaskId: string; paths: string[] }> = [];
            const preOrphanUnique: typeof classified.unique = [];
            for (const commit of classified.unique) {
              const misroutedResult = await classifyMisroutedForeignCommit({
                repoDir: this.rootDir,
                sha: commit.sha,
                commitSubject: commit.subject,
                commitBody: await execAsync(`git log -1 --format=%b ${commit.sha}`, { cwd: this.rootDir, encoding: "utf-8" }).then((r) => r.stdout).catch(() => ""),
                currentTaskId: task.id,
              });
              if (misroutedResult.misrouted && misroutedResult.foreignTaskId) {
                misrouted.push({ commit, foreignTaskId: misroutedResult.foreignTaskId, paths: misroutedResult.paths ?? [] });
              } else {
                preOrphanUnique.push(commit);
              }
            }

            // Orphan-our-advance: a "unique" foreign commit attributed to a
            // task that's already `done` is a stranded merge from the pre-FF
            // ref-advance bug. FF-rehomeable orphans are advanced onto the
            // integration branch and then dropped from this task's branch
            // alongside already-upstream commits. Non-FF orphans (diverged
            // from current integration tip) are logged with a cherry-pick
            // hint and left as `genuinelyUnique` for human adjudication.
            const rehomedOrphans: typeof classified.unique = [];
            const genuinelyUnique: typeof classified.unique = [];
            const integrationBranchForOrphan = task.mergeDetails?.mergeTargetBranch
              ?? task.baseBranch
              ?? "main";
            for (const commit of preOrphanUnique) {
              const orphanBody = await execAsync(`git log -1 --format=%b ${commit.sha}`, { cwd: this.rootDir, encoding: "utf-8" })
                .then((r) => r.stdout)
                .catch(() => "");
              const orphanClass = await classifyOrphanOurAdvance({
                repoDir: this.rootDir,
                taskStore: this.store,
                integrationBranch: integrationBranchForOrphan,
                currentTaskId: task.id,
                commitSha: commit.sha,
                commitSubject: commit.subject,
                commitBody: orphanBody,
              });
              if (!orphanClass.orphan) {
                genuinelyUnique.push(commit);
                continue;
              }
              const rehome = await rehomeOrphanOntoIntegration({
                rootDir: this.rootDir,
                projectRootDir: this.rootDir,
                integrationBranch: integrationBranchForOrphan,
                orphanSha: commit.sha,
                taskId: task.id,
                audit,
              }).catch((rehomeError: unknown): { rehomed: false; reason: string } => ({
                rehomed: false,
                reason: rehomeError instanceof Error ? rehomeError.message : String(rehomeError),
              }));
              if (rehome.rehomed) {
                rehomedOrphans.push(commit);
                await this.store.logEntry(
                  task.id,
                  `[recovery] rehomed orphan-our-advance commit ${commit.sha.slice(0, 12)} (source ${orphanClass.sourceTaskId}) onto ${integrationBranchForOrphan} via fast-forward; dropping from branch`,
                  undefined,
                  this.getRunContextFor(task.id),
                );
              } else {
                const hint = "cherryPickHint" in rehome && rehome.cherryPickHint
                  ? ` — manual rehome: \`${rehome.cherryPickHint}\``
                  : "";
                await this.store.logEntry(
                  task.id,
                  `[recovery] orphan-our-advance commit ${commit.sha.slice(0, 12)} (source ${orphanClass.sourceTaskId}) refused auto-rehome: ${rehome.reason}${hint}`,
                  undefined,
                  this.getRunContextFor(task.id),
                );
                genuinelyUnique.push(commit);
              }
            }

            const alreadyShas = classified.alreadyUpstream.map((commit) => commit.sha.slice(0, 12)).join(", ") || "none";
            const misroutedShas = misrouted.map(({ commit }) => commit.sha.slice(0, 12)).join(", ") || "none";
            const rehomedShas = rehomedOrphans.map((commit) => commit.sha.slice(0, 12)).join(", ") || "none";
            const uniqueShas = genuinelyUnique.map((commit) => commit.sha.slice(0, 12)).join(", ") || "none";
            await this.store.logEntry(
              task.id,
              `[recovery] contamination classification: already-upstream=[${alreadyShas}] misrouted=[${misroutedShas}] rehomed-orphan=[${rehomedShas}] unique=[${uniqueShas}]`,
              undefined,
              this.getRunContextFor(task.id),
            );

            const alreadyAttemptedRecovery = (task.recoveryRetryCount ?? 0) > 0;
            if (genuinelyUnique.length === 0 && !alreadyAttemptedRecovery) {
              // Run the recovery inside the worktree (when one exists) so the final
              // `git checkout <branch>` step doesn't collide with the worktree's own
              // checkout. If we operate from this.rootDir while the branch is checked
              // out in a worktree, git refuses the recheckout with
              // "branch already used by worktree" and the in-line happy path silently
              // fails — every contaminated task would then fall through to the
              // dispatcher pause path even when it could have auto-recovered.
              const recoveryRepoDir = task.worktree ?? this.rootDir;
              const recovery = await autoRecoverCrossContamination({
                repoDir: recoveryRepoDir,
                branchName: err.branchName,
                baseSha: err.baseSha,
                taskId: task.id,
                shasToDrop: [
                  ...classified.alreadyUpstream.map((commit) => commit.sha),
                  ...misrouted.map(({ commit }) => commit.sha),
                  ...rehomedOrphans.map((commit) => commit.sha),
                ],
              });

              await this.store.logEntry(
                task.id,
                `[recovery] auto-recovered branch-cross-contamination: dropped ${recovery.droppedShas.length} commits (already-upstream + misrouted, SHAs: ${recovery.droppedShas.map((sha) => sha.slice(0, 12)).join(", ")}); new tip ${recovery.newTipSha.slice(0, 12)}`,
                undefined,
                this.getRunContextFor(task.id),
              );

              for (const dropped of misrouted) {
                await audit.database({
                  type: "task:auto-recover-misrouted-foreign-commit",
                  target: task.id,
                  metadata: {
                    droppedSha: dropped.commit.sha,
                    foreignTaskId: dropped.foreignTaskId,
                    paths: dropped.paths,
                  },
                });
              }

              await this.store.updateTask(task.id, {
                recoveryRetryCount: 1,
                nextRecoveryAt: null,
                paused: false,
                pausedReason: null,
                error: null,
              });
              // FN-4939: preserve the worktree across requeue. The recovery operated
              // inside the worktree (re-anchored the branch and re-checked it out), so
              // the worktree directory remains internally consistent and usable. Nulling
              // task.worktree here was the root cause of transient
              // `no-worktree-no-merge-confirmed` stall signals — a live mapped worktree
              // would still exist on disk while task.worktree was null, and downstream
              // classifiers (in-review-stall.ts, TaskChangesTab) cannot distinguish
              // "worktree gone" from "pointer not yet repopulated". Matches sibling
              // recovery paths in auto-recovery-handlers/contamination.ts,
              // tryBootstrapMisbindingRecovery, and self-healing reclaim.
              await this.store.moveTask(task.id, "todo", { preserveResumeState: true, preserveWorktree: true });
              return;
            }

            if (alreadyAttemptedRecovery) {
              await this.store.logEntry(
                task.id,
                "[recovery] auto-recovery already attempted; escalating to human adjudication",
                undefined,
                this.getRunContextFor(task.id),
              );
            } else if (genuinelyUnique.length > 0) {
              await this.store.logEntry(
                task.id,
                `[recovery] unique foreign commits require human adjudication: ${genuinelyUnique.map((commit) => commit.sha.slice(0, 12)).join(", ")}`,
                undefined,
                this.getRunContextFor(task.id),
              );
            }
          } catch (recoveryError: unknown) {
            const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
            await this.store.logEntry(task.id, `[recovery] contamination auto-recovery failed: ${recoveryMessage}`, undefined, this.getRunContextFor(task.id));
          }

          const autoRecoveryDispatcher = this.getAutoRecoveryDispatcher(audit);
          const ownCommits = err.foreignCommits.filter((commit) => commit.foreignTaskId === task.id).length;
          const foreignAttributedCommits = err.foreignCommits.filter((commit) => commit.foreignTaskId !== task.id).length;
          const foreignOnlyClassification = (task.branch && task.baseCommitSha)
            ? await classifyForeignOnlyContamination({
              repoDir: this.rootDir,
              branchName: task.branch,
              baseSha: task.baseCommitSha,
              taskId: task.id,
            }).catch(() => null)
            : null;
          const decision = await autoRecoveryDispatcher.dispatch({
            class: "branch-cross-contamination",
            taskId: task.id,
            runId: this.getRunContextFor(task.id)?.runId,
            pausedReason: "branch-cross-contamination",
            evidence: {
              ownCommits,
              foreignAttributedCommits,
              foreignOnlyKind: foreignOnlyClassification?.kind,
            },
            underlyingError: err,
          }, {
            task,
            retryCount: task.recoveryRetryCount ?? 0,
            settings: (await this.store.getSettings()).autoRecovery ?? { mode: "deterministic-only", maxRetries: 3 },
          });
          if (decision.action === "pause") {
            await this.store.updateTask(task.id, {
              status: "failed",
              error: err.message,
              paused: true,
              pausedReason: "branch-cross-contamination",
            });
          }
          return;
        } else if (isBranchConflictError(err)) {
          const conflictCount = (this.branchConflictErrorCount.get(task.id) ?? 0) + 1;
          this.branchConflictErrorCount.set(task.id, conflictCount);

          if (conflictCount > this.BRANCH_CONFLICT_TRIPWIRE_THRESHOLD) {
            const details = [
              `branch=${err.branchName}`,
              `worktree=${err.conflictingWorktreePath}`,
              `existingTipSha=${err.existingTipSha}`,
              `startPoint=${err.startPoint}`,
            ].join(" ");
            const tripwireMessage = `Branch conflict tripwire fired after ${conflictCount} events (threshold ${this.BRANCH_CONFLICT_TRIPWIRE_THRESHOLD}). ${details}`;
            await this.store.logEntry(task.id, `[recovery] ${tripwireMessage}`, undefined, this.getRunContextFor(task.id));
            const autoRecoveryDispatcher = this.getAutoRecoveryDispatcher(audit);
            const decision = await autoRecoveryDispatcher.dispatch({
              class: "branch-conflict-tripwire",
              taskId: task.id,
              runId: this.getRunContextFor(task.id)?.runId,
              pausedReason: "branch-conflict-tripwire",
              evidence: {
                branchName: err.branchName,
                conflictingWorktreePath: err.conflictingWorktreePath,
              },
              underlyingError: err,
            }, {
              task,
              retryCount: task.recoveryRetryCount ?? 0,
              settings: (await this.store.getSettings()).autoRecovery ?? { mode: "deterministic-only", maxRetries: 3 },
            });
            if (decision.action === "pause") {
              await this.store.updateTask(task.id, {
                status: "failed",
                error: tripwireMessage,
                paused: true,
                pausedReason: "branch-conflict-tripwire",
              });
            }
            return;
          }

          let outcome: "retry" | "reclaimed" | "sticky" = "sticky";
          for (let attempt = 1; attempt <= this.MAX_AUTO_RECOVERY_ATTEMPTS; attempt += 1) {
            outcome = await this.handleBranchConflict(task, err);
            if (outcome !== "retry") break;
            await this.store.logEntry(task.id, `[recovery] ${task.id} branch-conflict auto-retry requested (${attempt}/${this.MAX_AUTO_RECOVERY_ATTEMPTS})`, undefined, this.getRunContextFor(task.id));
            const taskForRetry = await this.store.getTask(task.id);
            await recordRetry({
              store: this.store,
              settings: await this.store.getSettings(),
              task: taskForRetry,
              category: "branchConflict",
              role: "executor",
              agentId: task.assignedAgentId ?? undefined,
              attempt,
            });
          }
          if (outcome === "retry") {
            const autoRecoveryDispatcher = this.getAutoRecoveryDispatcher(audit);
            const decision = await autoRecoveryDispatcher.dispatch({
              class: "branch-conflict-recovery-exhausted",
              taskId: task.id,
              runId: this.getRunContextFor(task.id)?.runId,
              pausedReason: "branch-conflict-recovery-exhausted",
              evidence: {
                branchName: err.branchName,
                conflictingWorktreePath: err.conflictingWorktreePath,
              },
              underlyingError: err,
            }, {
              task,
              retryCount: task.recoveryRetryCount ?? 0,
              settings: (await this.store.getSettings()).autoRecovery ?? { mode: "deterministic-only", maxRetries: 3 },
            });
            if (decision.action === "pause") {
              await this.store.updateTask(task.id, {
                status: "failed",
                error: err.message,
                paused: true,
                pausedReason: "branch-conflict-recovery-exhausted",
              });
            }
            return;
          }
          return;
        } else if (await this.handleNonContinuableSessionError(task, taskDone, errorMessage)) {
          return;
        } else if (await this.handleNonContinuableSessionRetry(task, errorMessage)) {
          return;
        } else if (this.options.usageLimitPauser && isUsageLimitError(errorMessage)) {
          await this.options.usageLimitPauser.onUsageLimitHit("executor", task.id, errorMessage);
        } else if (isTransientError(errorMessage)) {
          // Transient network/infrastructure error — use bounded recovery policy
          const decision = computeRecoveryDecision({
            recoveryRetryCount: task.recoveryRetryCount,
            nextRecoveryAt: task.nextRecoveryAt,
          });

          if (decision.shouldRetry) {
            const attempt = decision.nextState.recoveryRetryCount;
            const delay = formatDelay(decision.delayMs);
            // Silent transient errors (e.g., "request was aborted") are noisy — skip logging
            if (!isSilentTransientError(errorMessage)) {
              executorLog.warn(`⚡ ${task.id} transient error — retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}: ${errorMessage}`);
              await this.store.logEntry(task.id, `Transient error (retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}): ${errorMessage}`, undefined, this.getRunContextFor(task.id));
            }
            // Clean up the old worktree so the retry gets a fresh one
            if (worktreePath && existsSync(worktreePath)) {
              try {
                const settings = await this.store.getSettings();
                await removeWorktree({
                  worktreePath,
                  rootDir: this.rootDir,
                  settings,
                  taskId: task.id,
                  audit,
                  reason: RemovalReason.ExecutorTransientRetry,
                  expectedOwnerTaskId: task.id,
                  liveOwnerProbe: (path, ownerTaskId) => this.hasActiveWorktreeBinding(ownerTaskId, path),
                });
                executorLog.log(`Removed old worktree for transient retry: ${worktreePath}`);
              } catch (cleanupErr: unknown) {
                const cleanupErrMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
                executorLog.warn(`Failed to remove old worktree ${worktreePath}: ${cleanupErrMessage}`);
              }
            }
            await this.store.updateTask(task.id, {
              recoveryRetryCount: decision.nextState.recoveryRetryCount,
              nextRecoveryAt: decision.nextState.nextRecoveryAt,
              worktree: null,
              branch: null,
            });
            await this.store.moveTask(task.id, "todo", { preserveProgress: true });
            return;
          }

          // Recovery budget exhausted — escalate to real failure
          executorLog.error(`✗ ${task.id} transient error retries exhausted (${MAX_RECOVERY_RETRIES} attempts): ${errorDetail}`);
          await this.store.logEntry(task.id, `Transient error retries exhausted after ${MAX_RECOVERY_RETRIES} attempts: ${errorMessage}`, errorStack ?? errorDetail, this.getRunContextFor(task.id));
          await this.store.updateTask(task.id, {
            status: "failed",
            error: errorMessage,
            recoveryRetryCount: null,
            nextRecoveryAt: null,
          });
          await this.persistTokenUsage(task.id);
          await this.handoffTaskToReview(task, "transient-retries-exhausted");
          executorLog.log(`✗ ${task.id} transient retries exhausted → in-review`);
          this.options.onError?.(task, err instanceof Error ? err : new Error(errorMessage));
          return;
        }
        const terminalError = err instanceof RetryStormError
          ? JSON.stringify(serializeRetryStormError(err))
          : errorMessage;
        executorLog.error(`✗ ${task.id} execution failed:`, errorDetail);
        await this.store.logEntry(task.id, `Execution failed: ${terminalError}`, errorStack ?? errorDetail, this.getRunContextFor(task.id));
        await this.store.updateTask(task.id, { status: "failed", error: terminalError });
        await this.persistTokenUsage(task.id);
        await this.handoffTaskToReview(task, "execution-failed");
        executorLog.log(`✗ ${task.id} execution failed → in-review`);
        this.options.onError?.(task, err instanceof Error ? err : new Error(errorMessage));
      }
    } finally {
      if (reviewAddressingActivated) {
        const latestTask = await this.store.getTask(task.id);
        if (taskDone) {
          await this.transitionReviewAddressing(task.id, ["in-progress", "queued"], "addressed");
        } else if (latestTask.status === "failed") {
          await this.transitionReviewAddressing(task.id, ["in-progress", "queued"], "failed");
        }
      }

      this.executing.delete(task.id);
      executingTaskLock.release(task.id);
      // Clear run context at end of execute() lifecycle
      this.currentRunContexts.delete(task.id);
      // U5 (R6) leak guard: effectiveColumnAgentByTask is set() in the outer execute()
      // scope (execute-seam ~6191, step-session ~5674) BEFORE the session-entry try
      // whose finally (deleteActiveSession / deleteActiveStepExecutor) normally clears
      // it. A throw between the set() and that try would otherwise leak the entry and
      // permanently block the column agent's heartbeat ticks. Deleting here in the
      // outer finally covers BOTH paths since both run inside execute().
      this.effectiveColumnAgentByTask.delete(task.id);

      // Terminate all spawned child agents on ALL exit paths.
      // This must run here (in the outer finally) rather than only in agentWork's
      // finally block, because failures during worktree creation or before
      // agentWork is entered leave children orphaned with no other cleanup path.
      try {
        await this.terminateAllChildren(task.id);
      } catch (err) {
        executorLog.warn(`terminateAllChildren failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Reset loop recovery state at end of execute() lifecycle.
      // State is in-memory and per-run — should not persist across attempts.
      this.loopRecoveryState.delete(task.id);
      this.tokenUsageBaselines.delete(task.id);

      if (taskDone) {
        this.branchConflictErrorCount.delete(task.id);
      } else {
        const latestTask = await this.store.getTask(task.id);
        if (latestTask.column === "done" || latestTask.column === "archived") {
          this.branchConflictErrorCount.delete(task.id);
        }
      }

      // Requeue stuck-killed task AFTER this.executing is cleared.
      // This prevents the race where the scheduler re-dispatches the task
      // (via task:moved → execute()) while the old execution guard is still set,
      // which caused the new execute() call to silently no-op, stranding the
      // task in "in-progress" with no active session or worktree.
      if (stuckRequeue === true) {
        if (this.userCanceledTaskIds.has(task.id)) {
          this.pausedAborted.delete(task.id);
          this.stuckAborted.delete(task.id);
          this.userCanceledTaskIds.delete(task.id);
          await this.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
        } else {
          try {
          // Re-read latest task state. While this execute() invocation was
          // unwinding, self-healing (e.g. recoverCompletedTasks) may have
          // already transitioned the task to in-review or done. Continuing
          // the stuck-requeue cleanup in that case would destroy the worktree
          // the recovery now relies on and clobber the task back to todo with
          // all step progress reset, undoing valid completion. Skip the
          // entire cleanup if the column has moved on past in-progress/todo.
          const latestTask = await this.store.getTask(task.id);
          if (latestTask.column !== "in-progress" && latestTask.column !== "todo") {
            executorLog.log(
              `${task.id} stuck-requeue skipped — task is now in '${latestTask.column}' (recovered concurrently)`,
            );
          } else {
            const settings = await this.store.getSettings();
            const preserveProgress = settings.preserveProgressOnStuckRequeue !== false;

            // Reset steps whose work was never committed before destroying
            // the worktree. Skipped when preserveProgress is on — the
            // setting's whole point is to keep step status across the
            // requeue so the agent can resume from where it left off.
            if (!preserveProgress) {
              await this.resetStepsIfWorkLost(latestTask);
            }

            // Clean up the old worktree so the retry gets a fresh one
            if (worktreePath && existsSync(worktreePath)) {
              try {
                await removeWorktree({
                  worktreePath,
                  rootDir: this.rootDir,
                  settings,
                  taskId: task.id,
                  audit,
                  reason: RemovalReason.ExecutorStuckKilled,
                  expectedOwnerTaskId: task.id,
                  liveOwnerProbe: (path, ownerTaskId) => this.hasActiveWorktreeBinding(ownerTaskId, path),
                });
                executorLog.log(`Removed old worktree for stuck-killed retry: ${worktreePath}`);
              } catch (cleanupErr: unknown) {
                const cleanupErrMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
                executorLog.warn(`Failed to remove old worktree ${worktreePath}: ${cleanupErrMessage}`);
              }
            }
            await this.store.updateTask(task.id, { status: "stuck-killed", worktree: null, branch: null });
            // Only move to todo if not already there. Use the freshly-read
            // latestTask.column rather than the stale captured task.column —
            // the captured snapshot can be hours old and would race against
            // any concurrent recovery (see comment above).
            if (latestTask.column !== "todo") {
              await this.store.moveTask(task.id, "todo", preserveProgress ? { preserveProgress: true } : undefined);
              // Audit trail: record task move (FN-1404)
              await audit.database({ type: "task:move", target: task.id, metadata: { to: "todo" } });
              executorLog.log(`${task.id} moved to todo for retry after stuck kill${preserveProgress ? " (progress preserved)" : ""}`);
            } else {
              executorLog.log(`${task.id} already in todo — skipping redundant move`);
            }
          }
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            executorLog.error(`Failed to requeue stuck task ${task.id}: ${errorMessage}`);
          }
        }
      }
    }
  }

  // ── Custom tools for the worker agent ──────────────────────────────

  private createTaskUpdateTool(
    taskId: string,
    codeReviewVerdicts: Map<number, ReviewVerdict>,
    sessionRef: { current: AgentSession | null },
    stepCheckpoints: Map<number, string>,
    stuckDetector?: StuckTaskDetector,
  ): ToolDefinition {
    const store = this.store;
    return {
      name: "fn_task_update",
      label: "Update Step",
      description:
        "Update a step's status. Call before starting a step (in-progress), " +
        "after completing it (done), or to skip it (skipped). " +
        "Optionally update task dependencies by passing a dependencies array. " +
        "Optionally set workflow-defined custom field values by passing a custom_fields patch " +
        "(keyed by field id; validated against the workflow's field schema; pass null to clear a field). " +
        "step/status may be omitted to update only custom_fields or dependencies. " +
        "The board updates in real-time.",
      parameters: taskUpdateParams,
      execute: async (_id: string, params: Static<typeof taskUpdateParams>) => {
        const { step, status, dependencies, custom_fields } = params;

        // Bare-call guard (P1 api-contract): a call with none of
        // step/status/dependencies/custom_fields silently no-op'd, which the
        // agent cannot observe. Reject it up front so the failure is visible and
        // self-describing. The legacy no-op text is preserved as the detail.
        if (step === undefined && status === undefined && dependencies === undefined && custom_fields === undefined) {
          return {
            content: [{
              type: "text" as const,
              text: "ERROR: fn_task_update requires at least one of: step+status (report step progress), " +
                "dependencies (array of task ids), or custom_fields (workflow-defined field patch). " +
                "No-op: provide a step+status, dependencies, or custom_fields to update.",
            }],
            details: {},
            isError: true,
          };
        }

        // Custom-field patch (KTD-13): routed through the store's single write
        // authority, which validates each value against the task's workflow field
        // schema. A typed rejection surfaces the offending field id + reason as a
        // tool error so the agent can correct it. Applied first so a field-only
        // call (step omitted) returns here.
        if (custom_fields !== undefined) {
          const res = await store.updateTaskCustomFields(taskId, custom_fields);
          if (!res.ok) {
            const r = res.rejection;
            // Self-correcting rejection text: append the valid field ids (and,
            // for an enum violation, the valid values for the offending field)
            // resolved from the task's workflow field schema so a failed write
            // carries everything the agent needs to retry. Best-effort: a
            // resolution failure just omits the hint (the base reason still ships).
            let hint = "";
            try {
              const defs = await this.resolveTaskCustomFieldDefs(taskId);
              if (defs && defs.length > 0) {
                if (r.code === "unknown-field" || r.code === "no-fields-defined") {
                  hint = ` Valid field ids: ${defs.map((f) => f.id).join(", ")}.`;
                } else if (r.code === "enum-violation") {
                  const field = defs.find((f) => f.id === r.fieldId);
                  const opts = field?.options?.map((o) => o.value) ?? [];
                  if (opts.length > 0) hint = ` Valid values for '${r.fieldId}': ${opts.join(", ")}.`;
                }
              }
            } catch { /* hint is best-effort */ }
            return {
              content: [{
                type: "text" as const,
                text: `ERROR: custom field '${r.fieldId}' rejected (${r.code}): ${r.detail}${hint}`,
              }],
              details: { fieldId: r.fieldId, code: r.code, detail: r.detail },
              isError: true,
            };
          }
          // A custom-fields-only update (no step) succeeds here.
          if (step === undefined && status === undefined && dependencies === undefined) {
            const updatedKeys = Object.keys(custom_fields);
            return {
              content: [{
                type: "text" as const,
                text: `Updated custom field(s): ${updatedKeys.join(", ")}.`,
              }],
              details: { updatedFields: updatedKeys },
            };
          }
        }

        // Record step progress for stuck task detection.
        // Step transitions (in-progress, done, skipped) indicate real progress
        // and reset the loop detection counter. Generic activity (text deltas,
        // tool calls) is tracked separately via recordActivity in AgentLogger.
        if (status === "in-progress" || status === "done" || status === "skipped") {
          stuckDetector?.recordProgress(taskId);
        }

        // Dependencies-only update (no step) is permitted; handle deps then return.
        if (step === undefined) {
          if (dependencies !== undefined) {
            if (dependencies.includes(taskId)) {
              return {
                content: [{ type: "text" as const, text: `Cannot add self-dependency: ${taskId} cannot depend on itself.` }],
                details: {},
              };
            }
            const invalidIds: string[] = [];
            for (const depId of dependencies) {
              try { await store.getTask(depId); } catch { invalidIds.push(depId); }
            }
            if (invalidIds.length > 0) {
              return {
                content: [{ type: "text" as const, text: `Cannot set dependencies — the following task(s) do not exist: ${invalidIds.join(", ")}` }],
                details: {},
              };
            }
            await store.updateTask(taskId, { dependencies });
            return {
              content: [{ type: "text" as const, text: `Dependencies updated.` }],
              details: {},
            };
          }
          return {
            content: [{ type: "text" as const, text: `No-op: provide a step+status, dependencies, or custom_fields to update.` }],
            details: {},
          };
        }

        if (status === undefined) {
          return {
            content: [{ type: "text" as const, text: `Step ${step} provided without a status. Pass status (pending/in-progress/done/skipped).` }],
            details: {},
          };
        }

        if (!Number.isInteger(step) || step < 1) {
          return {
            content: [{
              type: "text" as const,
              text: `Invalid step number: ${step}. Steps are 1-indexed.`,
            }],
            details: {},
          };
        }

        const stepIndex = step - 1;

        if (status === "in-progress") {
          try {
            const latestTask = await store.getTask(taskId);
            const otherInProgressStepIndex = latestTask.steps.findIndex(
              (taskStep, index) => index !== stepIndex && taskStep.status === "in-progress",
            );
            if (otherInProgressStepIndex !== -1) {
              executorLog.warn(
                `${taskId}: fn_task_update marking step ${step} in-progress while step ${otherInProgressStepIndex + 1} is already in-progress`,
              );
            }
          } catch (err) {
            executorLog.warn(`${taskId}: failed to inspect step lease state before fn_task_update: ${err}`);
          }
        }

        // Enforce code review REVISE: block advancing to "done" when the last
        // code review for this step returned REVISE. The agent must fix the
        // issues and call fn_review_step(type="code") again before proceeding.
        // FN-3757: verdict/checkpoint maps are keyed by 0-indexed stepIndex.
        if (status === "done" && codeReviewVerdicts.get(stepIndex) === "REVISE") {
          return {
            content: [{
              type: "text" as const,
              text: `Cannot mark Step ${step} as done — the last code review returned REVISE. ` +
                `Fix the issues from the code review, commit your changes, and call ` +
                `fn_review_step(step=${step}, type="code") again. The step can only advance ` +
                `after the code review passes.`,
            }],
            details: {},
          };
        }

        // Handle dependencies parameter if provided
        if (dependencies !== undefined) {
          // Validate: prevent self-dependency
          if (dependencies.includes(taskId)) {
            return {
              content: [{
                type: "text" as const,
                text: `Cannot add self-dependency: ${taskId} cannot depend on itself.`,
              }],
              details: {},
            };
          }

          // Validate: all dependency task IDs must exist
          const invalidIds: string[] = [];
          for (const depId of dependencies) {
            try {
              await store.getTask(depId);
            } catch {
              invalidIds.push(depId);
            }
          }

          if (invalidIds.length > 0) {
            return {
              content: [{
                type: "text" as const,
                text: `Cannot set dependencies — the following task(s) do not exist: ${invalidIds.join(", ")}`,
              }],
              details: {},
            };
          }

          // Update dependencies
          await store.updateTask(taskId, { dependencies });
        }

        const task = await store.updateStep(taskId, stepIndex, status as StepStatus);
        const stepInfo = task.steps[stepIndex];
        if (!stepInfo) {
          return {
            content: [{
              type: "text" as const,
              text: `Invalid step number: ${step}. This task has ${task.steps.length} step(s) (1-indexed).`,
            }],
            details: {},
          };
        }
        const persistedStatus = stepInfo.status;
        const progress = task.steps.filter((s) => s.status === "done").length;

        // Capture session checkpoint only when the store actually moved the
        // step to in-progress, so RETHINK can rewind to it. Doing this AFTER
        // updateStep means a regression that updateStep ignores (e.g. the
        // agent re-marking an already-done step) cannot replace the
        // pre-step leaf with a later one.
        if (
          status === "in-progress" &&
          persistedStatus === "in-progress" &&
          sessionRef.current
        ) {
          const leafId = sessionRef.current.sessionManager.getLeafId();
          if (leafId) {
            // FN-3757: verdict/checkpoint maps are keyed by 0-indexed stepIndex.
            stepCheckpoints.set(stepIndex, leafId);
          }
        }

        // If the persisted status doesn't match the requested status, the
        // store rejected the transition (currently: in-progress regression
        // on a done/skipped step). FN-5168 treats repeated rebuffs after loop
        // recovery as a deterministic churn signal, but the agent-facing text
        // stays unchanged so the tool contract is preserved.
        if (persistedStatus !== status) {
          stuckDetector?.recordIgnoredStepUpdate(taskId);

          const ignoredStepUpdates = stuckDetector?.getIgnoredStepUpdateCount(taskId) ?? 0;
          const loopAttempts = this.loopRecoveryState.get(taskId)?.attempts ?? 0;
          if (loopAttempts >= 1 && ignoredStepUpdates === 25) {
            executorLog.warn(
              `${taskId}: no-progress churn detected ` +
              `(ignoredStepUpdates=${ignoredStepUpdates}, stuckKillStreak=${task.stuckKillCount ?? 0}) — ` +
              `escalating to STUCK_NO_PROGRESS_CHURN`,
            );
          }

          return {
            content: [{
              type: "text" as const,
              text: `Step ${step} (${stepInfo.name}) is already ${persistedStatus} — ${status} request ignored to preserve completed work. Progress: ${progress}/${task.steps.length} done.`,
            }],
            details: {},
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: `Step ${step} (${stepInfo.name}) → ${persistedStatus}. Progress: ${progress}/${task.steps.length} done.`,
          }],
          details: {},
        };
      },
    };
  }

  private createTaskLogTool(taskId: string): ToolDefinition {
    return sharedCreateTaskLogTool(this.store, taskId);
  }

  private createTaskCreateTool(): ToolDefinition {
    return sharedCreateTaskCreateTool(this.store, { sourceType: "api" }, { rootDir: this.rootDir });
  }

  private createTaskDocumentWriteTool(taskId: string): ToolDefinition {
    return sharedCreateTaskDocumentWriteTool(this.store, taskId);
  }

  private createTaskDocumentReadTool(taskId: string): ToolDefinition {
    return sharedCreateTaskDocumentReadTool(this.store, taskId);
  }

  private createWorkflowListTool(): ToolDefinition {
    return sharedCreateWorkflowListTool(this.store);
  }

  private createWorkflowGetTool(): ToolDefinition {
    return sharedCreateWorkflowGetTool(this.store);
  }

  private createWorkflowSelectTool(taskId: string): ToolDefinition {
    return sharedCreateWorkflowSelectTool(this.store, taskId);
  }

  private createTaskPromoteTool(taskId: string): ToolDefinition {
    return sharedCreateTaskPromoteTool(this.store, taskId);
  }

  private createWorkflowCreateTool(): ToolDefinition {
    return sharedCreateWorkflowCreateTool(this.store);
  }

  private createWorkflowUpdateTool(): ToolDefinition {
    return sharedCreateWorkflowUpdateTool(this.store);
  }

  private createWorkflowDeleteTool(): ToolDefinition {
    return sharedCreateWorkflowDeleteTool(this.store);
  }

  private createWorkflowSettingsTool(): ToolDefinition {
    return sharedCreateWorkflowSettingsTool(this.store);
  }

  private createTraitListTool(): ToolDefinition {
    return sharedCreateTraitListTool();
  }

  private createTaskAddDepTool(taskId: string): ToolDefinition {
    const store = this.store;
    return {
      name: "fn_task_add_dep",
      label: "Add Dependency",
      description:
        "Declare a dependency on an existing task. Use when you discover " +
        "mid-execution that another task must be completed first. " +
        "Adding a dependency to an in-progress task will stop execution " +
        "and discard current work, so confirm=true is required. " +
        "Without confirm=true, a warning is returned first.",
      parameters: taskAddDepParams,
      execute: async (_id: string, params: Static<typeof taskAddDepParams>) => {
        const targetId = params.task_id;

        // Prevent self-dependency
        if (targetId === taskId) {
          return {
            content: [{
              type: "text" as const,
              text: `Cannot add self-dependency: ${taskId} cannot depend on itself.`,
            }],
            details: {},
          };
        }

        // Validate target task exists
        try {
          await store.getTask(targetId);
        } catch {
          return {
            content: [{
              type: "text" as const,
              text: `Task ${targetId} not found. Cannot add dependency on a non-existent task.`,
            }],
            details: {},
          };
        }

        // Read current task to get existing dependencies
        const currentTask = await store.getTask(taskId);
        const existing = currentTask.dependencies;

        // Dedup check
        if (existing.includes(targetId)) {
          return {
            content: [{
              type: "text" as const,
              text: `${targetId} is already a dependency of ${taskId}. No changes made.`,
            }],
            details: {},
          };
        }

        // Confirmation gate — destructive action for in-progress tasks
        if (!params.confirm) {
          return {
            content: [{
              type: "text" as const,
              text: `Warning: adding a dependency to an in-progress task will stop execution and discard current work. Call with confirm=true to proceed.`,
            }],
            details: {},
          };
        }

        // Add the dependency
        await store.updateTask(taskId, { dependencies: [...existing, targetId] });
        await store.logEntry(taskId, `Added dependency on ${targetId} — stopping execution for re-planning`);

        // Trigger abort flow (same pattern as pausedAborted)
        this.depAborted.add(taskId);
        const activeSession = this.activeSessions.get(taskId);
        activeSession?.session.dispose();

        // Also terminate step sessions if active
        const stepExecutor = this.activeStepExecutors.get(taskId);
        if (stepExecutor) {
          stepExecutor.terminateAllSessions().catch(err =>
            executorLog.warn(`Failed to terminate step sessions for dep-abort ${taskId}: ${err}`)
          );
        }

        return {
          content: [{
            type: "text" as const,
            text: `Added dependency on ${targetId}. Stopping execution — task will move to triage for re-planning.`,
          }],
          details: {},
        };
      },
    };
  }

  private async transitionReviewAddressing(taskId: string, from: Array<"queued" | "in-progress" | "addressed" | "failed">, to: "queued" | "in-progress" | "addressed" | "failed"): Promise<void> {
    const task = await this.store.getTask(taskId);
    const reviewState = task.reviewState;
    if (!reviewState || reviewState.addressing.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    let changed = false;
    const addressing = reviewState.addressing.map((record) => {
      if (!from.includes(record.status)) {
        return record;
      }
      changed = true;
      return {
        ...record,
        status: to,
        startedAt: to === "in-progress" ? now : record.startedAt,
        completedAt: to === "addressed" || to === "failed" ? now : record.completedAt,
        error: to === "addressed" ? undefined : record.error,
      };
    });

    if (!changed) {
      return;
    }

    await this.store.updateTask(taskId, {
      reviewState: {
        ...reviewState,
        addressing,
      },
    });
  }

  private async verifyWorktreeInvariants(
    task: Task,
    worktreePathOverride?: string,
    allowReanchor = true,
  ): Promise<{ ok: true } | { ok: false; reason: "wrong_toplevel" | "wrong_branch" | "no_commits"; observed: string; expected: string }> {
    const settings = await this.store.getSettings();
    const branchName = resolveTaskWorkingBranch(task);
    const worktreePath = worktreePathOverride ?? task.worktree ?? this.activeWorktrees.get(task.id) ?? null;

    if (!worktreePath) {
      return {
        ok: false,
        reason: "wrong_toplevel",
        observed: "missing task.worktree",
        expected: `registered task worktree under ${resolveWorktreesDir(this.rootDir, settings)}/*`,
      };
    }

    const expectedRoot = canonicalizePath(this.rootDir);
    let expectedWorktreeRealpath: string;
    try {
      expectedWorktreeRealpath = canonicalizePath(worktreePath);
    } catch (error) {
      return {
        ok: false,
        reason: "wrong_toplevel",
        observed: `unresolvable task.worktree (${worktreePath}): ${error instanceof Error ? error.message : String(error)}`,
        expected: `resolvable task worktree under ${resolveWorktreesDir(this.rootDir, settings)}/*`,
      };
    }

    // FN-009: If worktree directory doesn't exist, skip git validation for task completion.
    // This is safe because:
    // 1. Task completion doesn't modify the worktree
    // 2. Deliverables (task documents, follow-up tasks) are stored in fusion.db
    // 3. If code changes were made, the worktree would exist
    // 4. This prevents ENOENT errors when agents complete documentation/coordination tasks
    if (!existsSync(worktreePath)) {
      executorLog.log(
        `${task.id}: worktree directory not found at ${worktreePath} — skipping git validation for task completion`,
      );
      return { ok: true };
    }

    try {
      const { stdout } = await execAsync("git rev-parse --show-toplevel", {
        cwd: worktreePath,
        encoding: "utf-8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      const observedTopLevelRaw = stdout.trim();
      if (observedTopLevelRaw) {
        const observedTopLevel = canonicalizePath(observedTopLevelRaw);

        if (
          observedTopLevel === expectedRoot ||
          !isInsideWorktreesDir(this.rootDir, observedTopLevel, settings) ||
          observedTopLevel !== expectedWorktreeRealpath
        ) {
          if (allowReanchor && observedTopLevel !== expectedRoot && isInsideWorktreesDir(this.rootDir, observedTopLevel, settings)) {
            const reanchor = await detectNestedWorktreeRoot(this.rootDir, worktreePath, settings);
            if (reanchor.reanchored) {
              await this.store.updateTask(task.id, { worktree: reanchor.root });
              executorLog.log(`${task.id}: re-anchored nested task.worktree ${worktreePath} -> ${reanchor.root}`);
              await this.store.logEntry(task.id, `Re-anchored nested task.worktree from ${worktreePath} to ${reanchor.root}`, undefined, this.getRunContextFor(task.id));
              await this.emitWorktreeReanchoredAudit(task.id, worktreePath, reanchor.root, "verify-worktree-invariants");
              return this.verifyWorktreeInvariants(task, reanchor.root, false);
            }
          }
          return {
            ok: false,
            reason: "wrong_toplevel",
            observed: observedTopLevel,
            expected: expectedWorktreeRealpath,
          };
        }
      }
    } catch (error) {
      return {
        ok: false,
        reason: "wrong_toplevel",
        observed: error instanceof Error ? error.message : String(error),
        expected: expectedWorktreeRealpath,
      };
    }

    try {
      const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
        cwd: worktreePath,
        encoding: "utf-8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      const observedBranch = stdout.trim();
      if (observedBranch && observedBranch !== branchName) {
        if (observedBranch.toLowerCase() === branchName.toLowerCase()) {
          executorLog.log(`${task.id}: branch case-mismatch detected; canonicalizing observed=${observedBranch} expected=${branchName}`);
          const autocorrectResult = await attemptBranchAutocorrect({
            worktreePath,
            observedBranch,
            expectedBranch: branchName,
            rootDir: this.rootDir,
          });
          if (autocorrectResult.status !== "failed") {
            const auditor = createRunAuditor(this.store, this.getRunContextFor(task.id));
            await auditor.git({
              type: "branch:auto-canonicalize-case",
              target: worktreePath,
              metadata: {
                taskId: task.id,
                observed: observedBranch,
                expected: branchName,
                worktreePath,
                mode: autocorrectResult.status,
              },
            });
            return { ok: true };
          }
          executorLog.warn(`${task.id}: failed to canonicalize branch case mismatch: ${autocorrectResult.reason ?? "unknown"}`);
        }
        return {
          ok: false,
          reason: "wrong_branch",
          observed: observedBranch,
          expected: branchName,
        };
      }
    } catch (error) {
      return {
        ok: false,
        reason: "wrong_branch",
        observed: error instanceof Error ? error.message : String(error),
        expected: branchName,
      };
    }

    if (task.noCommitsExpected === true) {
      executorLog.log(`${task.id}: fn_task_done no_commits guard skipped (noCommitsExpected=true)`);
      return { ok: true };
    }

    const baseRef = await this.resolveDiffBaseRef(worktreePath, task.baseCommitSha);
    if (!baseRef) {
      executorLog.warn(`${task.id}: unable to resolve diff base for invariant commit-count check; skipping no_commits guard`);
      return { ok: true };
    }

    try {
      const { stdout } = await execAsync(`git rev-list --count ${baseRef}..HEAD`, {
        cwd: worktreePath,
        encoding: "utf-8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      const trimmedCount = stdout.trim();
      if (!trimmedCount) {
        return { ok: true };
      }
      const count = Number.parseInt(trimmedCount, 10);
      if (!Number.isFinite(count) || count <= 0) {
        return {
          ok: false,
          reason: "no_commits",
          observed: Number.isFinite(count) ? String(count) : stdout.trim(),
          expected: "> 0",
        };
      }
    } catch (error) {
      return {
        ok: false,
        reason: "no_commits",
        observed: error instanceof Error ? error.message : String(error),
        expected: `git rev-list --count ${baseRef}..HEAD > 0`,
      };
    }

    return { ok: true };
  }

  private async evaluateTaskDoneScopeLeak(
    task: Task,
    worktreePath: string,
    promptContent: string,
    settings: Settings,
    audit?: RunAuditor,
  ): Promise<{ blocked: false } | { blocked: true; message: string }> {
    if (task.scopeOverride === true) {
      executorLog.log(`${task.id}: scope-leak guard bypassed (scopeOverride=true)`);
      await this.store.logEntry(task.id, "[scope-leak] scope guard bypassed via task.scopeOverride", undefined, this.getRunContextFor(task.id));
      return { blocked: false };
    }

    const declaredScope = await this.store.parseFileScopeFromPrompt(task.id).catch(() => [] as string[]);
    if (declaredScope.length === 0) {
      return { blocked: false };
    }

    const reviewLevel = parseReviewLevelFromPrompt(promptContent);
    const configuredMode = settings.planOnlyScopeLeakEnforcement ?? "warn";
    const enforcementMode: "off" | "warn" | "block" = reviewLevel === 1
      ? configuredMode
      : "warn";

    if (enforcementMode === "off") {
      return { blocked: false };
    }

    const [uncommittedTouchedFiles, branchCommittedFiles] = await Promise.all([
      this.captureUncommittedModifiedFiles(worktreePath),
      this.captureModifiedFiles(worktreePath, task.baseCommitSha, task.id, audit, "scope-leak-guard"),
    ]);

    const touchedFiles = [...new Set([...uncommittedTouchedFiles, ...branchCommittedFiles])];
    if (touchedFiles.length === 0) {
      return { blocked: false };
    }

    const offScopeFiles = touchedFiles
      .filter((filePath) => !workflowPathMatchesDeclaredScope(filePath, declaredScope))
      // FN-4811 follow-up: by convention every task may add its own changeset entry
      // under `.changeset/`, so changeset files are always considered in-scope and
      // never flagged by the scope-leak guard. The file-scope invariant at squash and
      // the broader contamination guards still catch cross-task changeset leakage at
      // a higher signal-to-noise ratio than the per-execution scope-leak warning.
      .filter((filePath) => !isAlwaysAllowedScopeLeakPath(filePath));
    if (offScopeFiles.length === 0) {
      return { blocked: false };
    }

    const renderListPreview = (items: string[], cap = 10): string => {
      if (items.length <= cap) {
        return items.join(", ");
      }
      const remaining = items.length - cap;
      return `${items.slice(0, cap).join(", ")}, … (+${remaining} more)`;
    };

    const offScopePreview = renderListPreview(offScopeFiles);
    const declaredScopePreview = renderListPreview(declaredScope);
    const message = `[scope-leak] reviewLevel=${reviewLevel} enforcement=${enforcementMode} off-scope touched files [${offScopePreview}]; declared scope [${declaredScopePreview}]; total off-scope=${offScopeFiles.length} total scope=${declaredScope.length}`;
    executorLog.warn(`${task.id}: ${message}`);
    await this.store.logEntry(task.id, message, undefined, this.getRunContextFor(task.id));

    if (enforcementMode === "block") {
      return {
        blocked: true,
        message: `Plan-Only scope-leak guard refused fn_task_done. Off-scope paths: [${offScopePreview}]. Revert them before retrying (for example: git checkout -- <paths>).`,
      };
    }

    return { blocked: false };
  }

  private async handleImplicitTaskDoneRefusal(
    task: Task,
    refusal: Extract<ReturnType<typeof evaluateTaskDoneRefusal>, { ok: false }>,
  ): Promise<void> {

    await this.store.logEntry(task.id, refusal.message, undefined, this.getRunContextFor(task.id));
    executorLog.error(`${task.id}: fn_task_done refused (${refusal.refusalClass}) — ${refusal.reason} (implicit completion)`);

    const priorRequeues = task.taskDoneRetryCount ?? 0;
    const nextRequeueCount = priorRequeues + 1;
    if (priorRequeues < MAX_TASK_DONE_REQUEUE_RETRIES) {
      await this.store.updateTask(task.id, {
        status: "failed",
        error: refusal.message,
        taskDoneRetryCount: nextRequeueCount,
        paused: false,
        pausedByAgentId: null,
        worktree: null,
        branch: null,
        sessionFile: null,
      });
      await this.store.logEntry(
        task.id,
        `${refusal.message} — requeued to todo immediately (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`,
        undefined,
        this.getRunContextFor(task.id),
      );
      await this.store.moveTask(task.id, "todo", { preserveProgress: true });
    } else {
      await this.store.updateTask(task.id, {
        status: "failed",
        error: refusal.message,
        paused: false,
        pausedByAgentId: null,
        worktree: null,
        branch: null,
        sessionFile: null,
      });
      await this.store.logEntry(task.id, `${refusal.message} — moved to in-review for inspection`, undefined, this.getRunContextFor(task.id));
      await this.persistTokenUsage(task.id);
      await this.handoffTaskToReview(task, "implicit-fn_task_done-refused");
    }

    this.deleteActiveSession(task.id);
    this.tokenUsageBaselines.delete(task.id);
  }

  private createTaskDoneTool(
    taskId: string,
    worktreePath: string,
    promptContent: string,
    codeReviewVerdicts: Map<number, ReviewVerdict>,
    onDone: () => void,
    audit?: RunAuditor,
  ): ToolDefinition {
    const store = this.store;
    return {
      name: "fn_task_done",
      label: "Mark Task Done",
      description:
        "Signal that all steps are complete, tests pass, and documentation is updated. " +
        "Call this as the final action after finishing all work. " +
        "Automatically marks all remaining steps as done. " +
        "Optionally provide a summary of what was changed/fixed.",
      parameters: Type.Object({
        summary: Type.Optional(Type.String({
          description: "Optional summary of what was changed/fixed and what was verified (2-4 sentences)",
        })),
      }),
      execute: async (_id: string, params: { summary?: string }) => {
        const task = await store.getTask(taskId);
        const completionBlocker = await this.getTaskCompletionBlocker(task);
        if (completionBlocker) {
          return {
            content: [{
              type: "text" as const,
              text: `Cannot mark task done yet — ${completionBlocker}. Resolve the blocker before calling fn_task_done().`,
            }],
            details: {},
          };
        }

        const invariantCheck = await this.verifyWorktreeInvariants(task, worktreePath);
        if (!invariantCheck.ok) {
          const refusalMessage = `fn_task_done refused: ${invariantCheck.reason} — observed=${invariantCheck.observed}, expected=${invariantCheck.expected}`;
          await store.logEntry(taskId, refusalMessage, undefined, this.getRunContextFor(task.id));
          executorLog.error(`${taskId}: fn_task_done refused (${invariantCheck.reason}) — observed=${invariantCheck.observed}, expected=${invariantCheck.expected}`);

          const priorRequeues = task.taskDoneRetryCount ?? 0;
          const nextRequeueCount = priorRequeues + 1;
          if (priorRequeues < MAX_TASK_DONE_REQUEUE_RETRIES) {
            await store.updateTask(taskId, {
              status: "failed",
              error: refusalMessage,
              taskDoneRetryCount: nextRequeueCount,
              paused: false,
              pausedByAgentId: null,
              worktree: null,
              branch: null,
              sessionFile: null,
            });
            await store.logEntry(
              taskId,
              `${refusalMessage} — requeued to todo immediately (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`,
              undefined,
              this.getRunContextFor(task.id),
            );
            await store.moveTask(taskId, "todo", { preserveProgress: true });
            executorLog.log(`✗ ${taskId} failed invariant check — requeued to todo (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`);
          } else {
            await store.updateTask(taskId, {
              status: "failed",
              error: refusalMessage,
              paused: false,
              pausedByAgentId: null,
              worktree: null,
              branch: null,
              sessionFile: null,
            });
            await store.logEntry(taskId, `${refusalMessage} — moved to in-review for inspection`, undefined, this.getRunContextFor(task.id));
            await this.persistTokenUsage(taskId);
            await store.handoffToReview(taskId, {
              ownerAgentId: this.getRunContextFor(task.id)?.agentId ?? null,
              evidence: {
                reason: "invariant-check-failed",
                runId: this.getRunContextFor(task.id)?.runId,
                agentId: this.getRunContextFor(task.id)?.agentId,
              },
            });
            executorLog.log(`✗ ${taskId} failed invariant check — moved to in-review`);
          }

          return {
            content: [{ type: "text" as const, text: refusalMessage }],
            details: {
              error: refusalMessage,
            },
          };
        }

        const taskDoneRefusal = evaluateTaskDoneRefusal(task, params, codeReviewVerdicts);
        if (!taskDoneRefusal.ok) {
          const refusalMessage = taskDoneRefusal.message;
          await store.logEntry(taskId, refusalMessage, undefined, this.getRunContextFor(task.id));
          executorLog.error(`${taskId}: fn_task_done refused (${taskDoneRefusal.refusalClass}) — ${taskDoneRefusal.reason}`);

          const priorRequeues = task.taskDoneRetryCount ?? 0;
          const nextRequeueCount = priorRequeues + 1;
          if (priorRequeues < MAX_TASK_DONE_REQUEUE_RETRIES) {
            await store.updateTask(taskId, {
              status: "failed",
              error: refusalMessage,
              taskDoneRetryCount: nextRequeueCount,
              paused: false,
              pausedByAgentId: null,
              worktree: null,
              branch: null,
              sessionFile: null,
            });
            await store.logEntry(
              taskId,
              `${refusalMessage} — requeued to todo immediately (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`,
              undefined,
              this.getRunContextFor(task.id),
            );
            await store.moveTask(taskId, "todo", { preserveProgress: true });
            executorLog.log(`✗ ${taskId} fn_task_done refusal (${taskDoneRefusal.refusalClass}) — requeued to todo (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`);
          } else {
            await store.updateTask(taskId, {
              status: "failed",
              error: refusalMessage,
              paused: false,
              pausedByAgentId: null,
              worktree: null,
              branch: null,
              sessionFile: null,
            });
            await store.logEntry(taskId, `${refusalMessage} — moved to in-review for inspection`, undefined, this.getRunContextFor(task.id));
            await this.persistTokenUsage(taskId);
            await store.handoffToReview(taskId, {
              ownerAgentId: this.getRunContextFor(task.id)?.agentId ?? null,
              evidence: {
                reason: "fn_task_done-refused",
                runId: this.getRunContextFor(task.id)?.runId,
                agentId: this.getRunContextFor(task.id)?.agentId,
              },
            });
            executorLog.log(`✗ ${taskId} fn_task_done refusal (${taskDoneRefusal.refusalClass}) — moved to in-review for inspection`);
          }

          return {
            content: [{ type: "text" as const, text: refusalMessage }],
            details: {
              error: refusalMessage,
              refusalClass: taskDoneRefusal.refusalClass,
            },
          };
        }

        // Merge per-task effective workflow settings (U3, KTD-3) so the
        // planOnlyScopeLeakEnforcement read in evaluateTaskDoneScopeLeak picks up
        // workflow values. Behavior-inert by default.
        const settings = await mergeEffectiveSettings(store, task, await store.getSettings());
        const scopeLeakCheck = await this.evaluateTaskDoneScopeLeak(task, worktreePath, promptContent, settings, audit)
          .catch((error: unknown) => {
            const errorMessage = error instanceof Error ? error.message : String(error);
            executorLog.warn(`${taskId}: scope-leak guard failed open: ${errorMessage}`);
            return { blocked: false } as const;
          });
        if (scopeLeakCheck.blocked) {
          await store.logEntry(taskId, `[scope-leak] blocked fn_task_done: ${scopeLeakCheck.message}`, undefined, this.getRunContextFor(task.id));
          return {
            content: [{ type: "text" as const, text: scopeLeakCheck.message }],
            details: {
              error: scopeLeakCheck.message,
            },
          };
        }

        onDone();

        // Mark all pending/in-progress steps as done
        for (let i = 0; i < task.steps.length; i++) {
          if (task.steps[i].status !== "done" && task.steps[i].status !== "skipped") {
            await store.updateStep(taskId, i, "done");
          }
        }
        // FN-4106: preserve the original completion summary on workflow-step reruns.
        const newSummary = params.summary?.trim();
        if (newSummary) {
          const currentTask = await store.getTask(taskId);
          const existingSummary = currentTask.summary?.trim();
          const hasRunWorkflowSteps = (currentTask.workflowStepResults?.length ?? 0) > 0;
          const rerunSuffix = `---\nRerun after workflow step revision:\n${newSummary}`;

          if (existingSummary && hasRunWorkflowSteps && !existingSummary.endsWith(rerunSuffix)) {
            await store.updateTask(taskId, {
              summary: `${currentTask.summary}\n\n${rerunSuffix}`,
            });
            await store.logEntry(taskId, "fn_task_done summary appended to existing summary (workflow-step rerun)", undefined, this.getRunContextFor(taskId));
          } else if (!existingSummary || !hasRunWorkflowSteps) {
            await store.updateTask(taskId, { summary: params.summary });
          }
        }
        const hardPauseActive = Boolean(settings.globalPause);
        // Task-level pause prevents new work from starting, not completion of
        // in-flight work. Always clear it on explicit agent completion so the
        // board cannot strand a completed task in a paused state.
        await store.updateTask(taskId, {
          paused: false,
          pausedByAgentId: null,
          status: null,
        });
        await store.logEntry(taskId, "Task marked done by agent", undefined, this.getRunContextFor(taskId));

        const latestTask = await store.getTask(taskId);
        let latestColumn = latestTask.column;
        if (latestColumn === "todo") {
          await store.logEntry(
            taskId,
            hardPauseActive
              ? "fn_task_done called while task was in todo during pause — promoting to in-progress for deferred completion handoff"
              : "fn_task_done called while task was in todo — promoting to in-progress before completion handoff",
            undefined,
            this.getRunContextFor(taskId),
          );
          await store.moveTask(taskId, "in-progress");
          latestColumn = "in-progress";
        }

        if (latestColumn === "in-progress" && !hardPauseActive) {
          this.scheduleCompletedTaskWatchdog(taskId, "fn_task_done");
        }

        const successMessage = hardPauseActive
          ? "Task marked complete. Completion handoff deferred until pause is cleared."
          : params.summary
          ? "Task marked complete with summary. All steps done. Moving to in-review."
          : "Task marked complete. All steps done. Moving to in-review.";
        return {
          content: [{ type: "text" as const, text: successMessage }],
          details: {},
        };
      },
    };
  }

  /**
   * Create the fn_review_step tool for the executor agent.
   *
   * When the reviewer returns a RETHINK verdict, this tool:
   * 1. Runs `git reset --hard <baseline>` to revert file changes
   * 2. Rewinds the conversation to the pre-step checkpoint via `session.navigateTree()`
   * 3. Resets the step status to "pending"
   * 4. Returns a re-prompt instructing the agent to take a different approach
   */
  private createReviewStepTool(
    taskId: string,
    worktreePath: string,
    promptContent: string,
    codeReviewVerdicts: Map<number, ReviewVerdict>,
    sessionRef: { current: AgentSession | null },
    stepCheckpoints: Map<number, string>,
    detail: TaskDetail,
    stuckDetector?: StuckTaskDetector,
  ): ToolDefinition {
    const store = this.store;
    const options = this.options;
    const planSpecUnavailableCounts = new Map<string, number>();

    return {
      name: "fn_review_step",
      label: "Review Step",
      description:
        "Spawn a reviewer agent to evaluate your plan or code for a step. " +
        "Returns APPROVE, REVISE, RETHINK, or UNAVAILABLE. " +
        "Call at step boundaries based on the task's review level. " +
        "Skip reviews for Step 0 (Preflight) and the final documentation step.",
      parameters: reviewStepParams,
      execute: async (_toolCallId: string, params: Static<typeof reviewStepParams>) => {
        const { step, type: reviewType, step_name, baseline } = params;
        // FN-4990: fn_review_step is externally 1-indexed; normalize to the
        // internal 0-index convention used by FN-3757 step verdict/checkpoint maps.
        const stepIndex = step - 1;
        const currentTask = await store.getTask(taskId);
        const taskSteps = currentTask.steps.length > 0 ? currentTask.steps : detail.steps;
        if (!Number.isInteger(step) || step < 1 || stepIndex >= taskSteps.length) {
          return {
            content: [{ type: "text" as const, text: `Invalid step ${step}. Task has ${taskSteps.length} step(s) and fn_review_step is 1-indexed.` }],
            details: {
              error: "invalid_step",
              step,
              maxStep: taskSteps.length,
            },
          };
        }

        reviewerLog.log(`${taskId}: ${reviewType} review for Step ${step} (${step_name})`);
        await store.logEntry(taskId, `${reviewType} review requested for Step ${step} (${step_name})`);

        // Auto-advance the step to "in-progress" if the agent is requesting a
        // review without having flipped it themselves. Some runtimes (notably
        // permanent-agent CEO sessions on the openai-codex transport) skip the
        // bookkeeping fn_task_update call entirely. Tying step state to the
        // review tool keeps the dashboard accurate without a second tool call.
        // Skip the auto-update if the step is already done/skipped (don't
        // regress completed work) — updateStep guards against that anyway.
        try {
          if (taskSteps[stepIndex]?.status === "pending") {
            await store.updateStep(taskId, stepIndex, "in-progress");
          }
        } catch (autoUpdateErr) {
          reviewerLog.warn(
            `${taskId}: failed to auto-advance Step ${step} to in-progress on review entry: ${autoUpdateErr instanceof Error ? autoUpdateErr.message : String(autoUpdateErr)}`,
          );
        }

        try {
          // Merge per-task effective workflow settings (U3, KTD-3) so the
          // validator model-lane reads below pick up workflow values; this tool
          // closure re-fetches independently. Behavior-inert by default.
          const settings = await mergeEffectiveSettings(store, detail, await store.getSettings());
          // Run the reviewer via semaphore.runNested so its slot accounting
          // is honest: activeCount transiently bumps to reflect the second
          // agent session, but the reviewer doesn't enter the wait queue
          // (avoiding a fairness regression where unrelated work could
          // overtake this task at low maxConcurrent). The parent (this
          // executor) makes no LLM calls while suspended awaiting the tool
          // result, so the soft breach of `limit` does not push real
          // LLM-active concurrency above the configured cap.
          const sem = options.semaphore;
          const invokeReviewer = () => reviewStep(
            worktreePath, taskId, step, step_name,
            reviewType, promptContent, baseline,
            {
              onText: (delta) => options.onAgentText?.(taskId, delta),
              // Execution defaults as final fallback
              defaultProvider: settings.defaultProvider,
              defaultModelId: settings.defaultModelId,
              fallbackProvider: settings.fallbackProvider,
              fallbackModelId: settings.fallbackModelId,
              defaultThinkingLevel: detail.thinkingLevel ?? settings.defaultThinkingLevel,
              // Task-level validator override (from task)
              taskValidatorProvider: detail.validatorModelProvider,
              taskValidatorModelId: detail.validatorModelId,
              // Project-level validator override
              projectValidatorProvider: settings.validatorProvider,
              projectValidatorModelId: settings.validatorModelId,
              // Project-level validator fallback
              projectValidatorFallbackProvider: settings.validatorFallbackProvider,
              projectValidatorFallbackModelId: settings.validatorFallbackModelId,
              // Global validator lane
              globalValidatorProvider: settings.validatorGlobalProvider,
              globalValidatorModelId: settings.validatorGlobalModelId,
              // Project-level default override (fallback before execution defaults)
              projectDefaultOverrideProvider: settings.defaultProviderOverride,
              projectDefaultOverrideModelId: settings.defaultModelIdOverride,
              store,
              taskId,
              task: detail,
              agentPrompts: settings.agentPrompts,
              agentStore: this.options.agentStore,
              rootDir: this.rootDir,
              settings,
              // Track the reviewer's session under this task so it's disposed
              // alongside the main session when the task moves out of
              // in-progress, is paused, or the engine globally pauses.
              onSessionCreated: (s) => this.registerSubagentSession(taskId, s),
              onSessionEnded: (s) => this.unregisterSubagentSession(taskId, s),
            },
          );
          const result = sem
            ? await sem.runNested(invokeReviewer)
            : await invokeReviewer();

          await store.logEntry(
            taskId,
            `${reviewType} review Step ${step}: ${result.verdict}`,
            result.summary,
          );
          reviewerLog.log(`${taskId}: Step ${step} ${reviewType} → ${result.verdict}`);
          stuckDetector?.recordProgress(taskId);

          // Track code review verdicts for enforcement. Plan reviews remain
          // advisory — only code reviews write to the verdict map.
          if (reviewType === "code") {
            if (result.verdict === "REVISE") {
              codeReviewVerdicts.set(stepIndex, "REVISE");
            } else if (result.verdict === "APPROVE") {
              codeReviewVerdicts.delete(stepIndex);
              // Auto-mark the step as done once its code review passes. The
              // recoverApprovedStepsOnResume path (executor.ts) already does
              // this on engine restart from log scan; doing it inline avoids
              // depending on the agent's follow-up fn_task_update call, which
              // permanent-agent runtimes routinely skip.
              try {
                const currentTask = await store.getTask(taskId);
                if (
                  stepIndex >= 0 &&
                  stepIndex < currentTask.steps.length &&
                  currentTask.steps[stepIndex].status !== "done" &&
                  currentTask.steps[stepIndex].status !== "skipped"
                ) {
                  await store.updateStep(taskId, stepIndex, "done");
                  await store.logEntry(
                    taskId,
                    `Step ${step} (${step_name}) auto-marked done by code review APPROVE`,
                  );
                }
              } catch (autoDoneErr) {
                reviewerLog.warn(
                  `${taskId}: failed to auto-mark Step ${step} done after APPROVE: ${autoDoneErr instanceof Error ? autoDoneErr.message : String(autoDoneErr)}`,
                );
              }
            }
          }

          let text: string;
          switch (result.verdict) {
            case "APPROVE": text = "APPROVE"; break;
            case "REVISE":
              if (reviewType === "code") {
                text = `REVISE — this step cannot be marked done until the code review passes.\n\n` +
                  `Fix the issues below, commit your changes, and call fn_review_step(step=${step}, ` +
                  `type="code", step_name="${step_name}", baseline="<new SHA>") again.\n\n${result.review}`;
              } else {
                text = `REVISE\n\n${result.review}`;
              }
              break;
            case "RETHINK": {
              // RETHINK mechanics (git reset to baseline + session rewind +
              // step→pending + RETHINK log entry) are the U2 substrate seam.
              // The legacy in-session path delegates to the single extracted
              // implementation in step-runner.ts so there is exactly one copy.
              // No blast-radius guard here: this path is intra-session with an
              // agent-supplied baseline (KTD-2 — the guard is for graph-owned
              // shared-isolation resets), so behavior stays byte-identical.
              const checkpointId = stepCheckpoints.get(stepIndex);
              await resetStepToBaseline(
                {
                  store,
                  worktreePath,
                  sessionRef,
                  reviewType: reviewType === "plan" ? "plan" : "code",
                  summary: result.summary,
                },
                { id: taskId, steps: taskSteps },
                stepIndex,
                reviewType === "code" ? baseline : undefined,
                checkpointId,
              );

              if (reviewType === "plan") {
                text = `RETHINK\n\nYour plan was rejected. Here is why:\n\n${result.review}\n\nTake a different approach to planning this step. Do NOT repeat the rejected strategy.`;
              } else {
                text = `RETHINK\n\nYour previous approach was rejected. Here is why:\n\n${result.review}\n\nTake a different approach. Do NOT repeat the rejected strategy. Re-read the step requirements and find an alternative solution.`;
              }
              break;
            }
            default: {
              const isAdvisoryReview = reviewType === "plan" || reviewType === ("spec" as typeof reviewType);
              if (isAdvisoryReview) {
                const key = `${reviewType}:${step}`;
                const count = (planSpecUnavailableCounts.get(key) ?? 0) + 1;
                planSpecUnavailableCounts.set(key, count);
                const advisoryType = reviewType === "plan" ? "plan" : "spec";
                const advisoryMessage = `${advisoryType} review Step ${step}: UNAVAILABLE — proceeding advisory after fallback retry exhausted`;
                await store.logEntry(taskId, advisoryMessage);
                reviewerLog.warn(`${taskId}: ${advisoryMessage}`);
                if (count >= 2) {
                  await store.logEntry(
                    taskId,
                    `${advisoryType} review Step ${step}: repeated UNAVAILABLE (${count}) — advisory continuation active; operator may inspect reviewer logs in dashboard`,
                  );
                }
                text = `UNAVAILABLE (advisory) — reviewer could not produce a verdict after fallback retry. ${advisoryType === "plan" ? "Plan" : "Spec"} reviews are advisory; proceed with implementation. Do NOT re-call fn_review_step for the ${advisoryType} of Step ${step}.`;
              } else {
                const blockingMessage = `code review Step ${step}: UNAVAILABLE — blocking until reviewer returns a usable verdict`;
                await store.logEntry(taskId, blockingMessage);
                reviewerLog.warn(`${taskId}: ${blockingMessage}`);
                text = "UNAVAILABLE — reviewer did not produce a usable verdict. Code review remains blocking; retry once or escalate via dashboard.";
              }
              break;
            }
          }

          return { content: [{ type: "text" as const, text }], details: {} };
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          reviewerLog.error(`${taskId}: review failed: ${errorMessage}`);
          await store.logEntry(taskId, `${reviewType} review failed: ${errorMessage}`);
          return {
            content: [{ type: "text" as const, text: `UNAVAILABLE — reviewer error: ${errorMessage}` }],
            details: {},
          };
        }
      },
    };
  }

  /**
   * Clean up after a dep-abort: remove worktree, delete branch, move task to triage.
   * Shared between the try-block (graceful return) and catch-block (error) paths.
   */
  private async handleDepAbortCleanup(taskId: string, worktreePath: string): Promise<void> {
    executorLog.log(`${taskId} dependency added — work discarded, moved to triage for re-planning`);

    // Remove worktree
    try {
      const settings = await this.store.getSettings();
      await this.removeOwnWorktreeWithReconcile({
        worktreePath,
        settings,
        taskId,
        reason: RemovalReason.ExecutorDispose,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`${taskId}: failed to remove worktree during dep-abort cleanup (${worktreePath}): ${msg}`);
    }

    // Delete the branch — use stored branch name if available, fall back to convention
    const task = await this.store.getTask(taskId);
    const branch = resolveTaskWorkingBranch(task);
    let branchDeleted = false;
    try {
      await execAsync(`git branch -D "${branch}"`, { cwd: this.rootDir });
      branchDeleted = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`${taskId}: failed to delete branch during dep-abort cleanup (${branch}): ${msg}`);
    }
    if (branchDeleted) {
      // FN-2165 regression guard: null baseBranch on any task that stored this branch
      try { this.store.clearStaleExecutionStartBranchReferences([branch], taskId); } catch { /* best-effort */ }
    }

    // Clear worktree tracking
    this.activeWorktrees.delete(taskId);

    // Update task: clear worktree and status, move to triage
    await this.store.updateTask(taskId, { worktree: null, status: null });
    await this.store.moveTask(taskId, "triage");
    await this.store.logEntry(taskId, "Execution stopped — work discarded, moved to triage for re-planning");
  }

  /**
   * Handle a workflow step revision request.
   *
   * Re-opens ONLY the last step so the executor has exactly one pending slot
   * to re-enter through. All earlier done steps stay done — the agent reads
   * the injected feedback from PROMPT.md and applies an in-place fix rather
   * than redoing any completed step.
   */
  private async handleWorkflowRevisionRequest(
    task: Task,
    worktreePath: string,
    feedback: string,
    stepName: string,
    settings: Settings,
  ): Promise<boolean> {
    executorLog.log(`${task.id}: workflow revision requested by step "${stepName}"`);
    this.clearCompletedTaskWatchdog(task.id);

    const shouldForkOnScopeMismatch = settings.workflowRevisionForkOnScopeMismatch !== false;
    let inScopeFeedback = feedback.trim();
    let outOfScopeFeedback = "";
    let followUpTaskId: string | undefined;

    if (shouldForkOnScopeMismatch) {
      const declaredFileScope = await this.store.parseFileScopeFromPrompt(task.id).catch(() => [] as string[]);
      const partition = partitionWorkflowRevisionFeedback(feedback, declaredFileScope);
      inScopeFeedback = partition.inScopeFeedback;
      outOfScopeFeedback = partition.outOfScopeFeedback;

      if (outOfScopeFeedback) {
        const followUpTask = await this.createWorkflowRevisionFollowUpTask(task, stepName, outOfScopeFeedback);
        followUpTaskId = followUpTask.id;
      }
    }

    if (!inScopeFeedback) {
      await this.store.logEntry(
        task.id,
        followUpTaskId
          ? `Workflow step "${stepName}" requested revision — feedback forked to follow-up ${followUpTaskId}; original task left unchanged`
          : `Workflow step "${stepName}" requested revision — no in-scope feedback detected`,
        outOfScopeFeedback || feedback,
        this.getRunContextFor(task.id),
      );
      return false;
    }

    const updatedTask = await this.store.getTask(task.id);
    const reopen = await this.reopenLastStepForRevision(task.id, updatedTask);
    const reopenSummary = reopen
      ? `re-opening Step ${reopen.index + 1} ("${reopen.name}") for in-place fix`
      : "no step to re-open (none were completed)";

    const logMessage = followUpTaskId
      ? `Workflow step "${stepName}" requested revision — split feedback: appended in-scope guidance and forked out-of-scope work to ${followUpTaskId}; ${reopenSummary}`
      : `Workflow step "${stepName}" requested revision — feedback appended to original task; ${reopenSummary}`;
    await this.store.logEntry(task.id, logMessage, inScopeFeedback, this.getRunContextFor(task.id));

    await this.injectWorkflowRevisionInstructions(task, inScopeFeedback);

    await this.store.updateTask(task.id, {
      status: null,
      sessionFile: null,
    });

    executorLog.log(`${task.id}: scheduling fresh execution after revision request`);
    this.scheduleWorkflowRerun(
      task.id,
      worktreePath,
      `${task.id}: revision rerun scheduled — moved to todo then in-progress`,
    );
    return true;
  }

  private async createWorkflowRevisionFollowUpTask(
    task: Task,
    stepName: string,
    feedback: string,
  ): Promise<Task> {
    const title = `${task.id}: workflow follow-up from ${stepName}`;
    const description = [
      `Follow-up work forked from workflow revision feedback on ${task.id}.`,
      "",
      `Original task: ${task.id}${task.title ? ` — ${task.title}` : ""}`,
      `Workflow step: ${stepName}`,
      "",
      "This feedback referenced files outside the original task's declared File Scope, so it was forked into a follow-up task instead of mutating the original PROMPT.md.",
      "",
      "## Out-of-Scope Workflow Revision Feedback",
      "",
      feedback,
    ].join("\n");

    return this.store.createTask({
      title,
      description,
      dependencies: [task.id],
      source: {
        sourceType: "workflow_step",
        sourceParentTaskId: task.id,
        sourceMetadata: {
          workflowStepName: stepName,
          routing: "scope-mismatch-fork",
        },
      },
    });
  }

  /**
   * Re-open the last non-pending step so a revision/failure handler gives the
   * executor exactly one pending slot to re-enter through. Returns the index
   * and name of the step that was flipped to `pending`, or null when there
   * was nothing to re-open.
   */
  private async reopenLastStepForRevision(
    taskId: string,
    task: Task,
  ): Promise<{ index: number; name: string } | null> {
    const steps = task.steps;
    if (steps.length === 0) return null;

    let targetIndex = -1;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].status !== "pending") {
        targetIndex = i;
        break;
      }
    }

    if (targetIndex === -1) {
      await this.store.updateTask(taskId, { currentStep: 0 });
      return null;
    }

    await this.store.updateStep(taskId, targetIndex, "pending");
    await this.store.updateTask(taskId, { currentStep: targetIndex });
    return { index: targetIndex, name: steps[targetIndex].name };
  }

  /**
   * Inject or update the "Workflow Revision Instructions" section in PROMPT.md.
   * This section contains feedback from workflow steps that requested revisions.
   * The section is replaced entirely to avoid accumulation of old feedback.
   */
  private async injectWorkflowRevisionInstructions(
    task: Task,
    feedback: string,
  ): Promise<void> {
    const promptPath = join(this.store.getFusionDir(), "tasks", task.id, "PROMPT.md");

    // Read existing PROMPT.md
    let content: string;
    try {
      content = await readFile(promptPath, "utf-8");
    } catch {
      executorLog.warn(`${task.id}: PROMPT.md not found at ${promptPath}, skipping revision injection`);
      return;
    }

    // All prior steps stay done — agent applies the feedback as an in-place
    // patch rather than re-planning or re-executing earlier steps.
    const scopeLine = "All prior steps remain **done**. Apply the feedback above as an in-place fix (make the necessary code changes, commit, and call `fn_task_done()` when complete). Do **not** re-run or re-plan any earlier step unless the feedback explicitly calls it out.";

    // Check for existing Workflow Revision Instructions section
    const revisionSectionHeader = "## Workflow Revision Instructions";
    const revisionSectionContent = `${revisionSectionHeader}

The following feedback was received from quality gates and requires implementation changes:

${feedback}

**Important:** ${scopeLine}

`;

    let newContent: string;
    if (content.includes(revisionSectionHeader)) {
      // Replace existing section
      const sectionRegex = new RegExp(
        `${revisionSectionHeader}[\\s\\S]*?(?=\\n## |\\n# |$)`,
        "i"
      );
      if (sectionRegex.test(content)) {
        newContent = content.replace(sectionRegex, revisionSectionContent);
      } else {
        // Fallback: append at end
        newContent = content + "\n" + revisionSectionContent;
      }
    } else {
      // Append new section before any closing markers or at end
      // Look for common markers like "## Acceptance Criteria" or just append
      const acceptanceCriteriaMatch = content.match(/\n##\s+Acceptance Criteria\n/);
      if (acceptanceCriteriaMatch) {
        const insertIdx = acceptanceCriteriaMatch.index!;
        newContent = content.slice(0, insertIdx) + "\n" + revisionSectionContent + content.slice(insertIdx);
      } else {
        newContent = content + "\n" + revisionSectionContent;
      }
    }

    // Write updated content
    try {
      await writeFile(promptPath, newContent);
      executorLog.log(`${task.id}: injected workflow revision instructions into PROMPT.md`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.error(`${task.id}: failed to inject revision instructions: ${errorMessage}`);
    }
  }

  /**
   * Handle workflow step hard failures by retrying execution up to MAX_WORKFLOW_STEP_RETRIES times.
   * This gives the executor a chance to fix workflow step failures automatically before
   * moving the task to in-review with failed status.
   *
   * @returns true if a retry was scheduled, false if retries are exhausted
   */
  /**
   * Run deterministic verification (test + build commands) in the task's worktree.
   * Returns a structured result indicating whether all commands passed.
   */
  private async runExecutorDeterministicVerification(
    task: Task,
    worktreePath: string,
    settings: Settings,
    extraEnv?: NodeJS.ProcessEnv,
  ): Promise<VerificationResult> {
    const testCommand = settings.testCommand?.trim();
    const buildCommand = settings.buildCommand?.trim();

    if (!testCommand && !buildCommand) {
      executorLog.log(`${task.id}: no test/build commands configured — skipping verification`);
      return { allPassed: true };
    }

    const parts: string[] = [];
    if (testCommand) parts.push(`test: ${testCommand}`);
    if (buildCommand) parts.push(`build: ${buildCommand}`);
    executorLog.log(`${task.id}: [verification] running deterministic verification (${parts.join(", ")})`);
    await this.store.logEntry(
      task.id,
      `[verification] Running deterministic verification (${parts.join(", ")})`,
      undefined,
      this.getRunContextFor(task.id),
    );

    const result: VerificationResult = { allPassed: true };

    // Run test command first if configured
    if (testCommand) {
      const testResult = await runVerificationCommand(
        this.store, worktreePath, task.id, testCommand, "test", undefined, executorLog, "executor", extraEnv,
      );
      result.testResult = testResult;

      if (!testResult.success) {
        result.allPassed = false;
        result.failedCommand = "testCommand";
        executorLog.log(`${task.id}: [verification] test failed (exit ${testResult.exitCode})`);
        return result;
      }
    }

    // Run build command second if configured
    if (buildCommand) {
      const buildResult = await runVerificationCommand(
        this.store, worktreePath, task.id, buildCommand, "build", undefined, executorLog, "executor", extraEnv,
      );
      result.buildResult = buildResult;

      if (!buildResult.success) {
        result.allPassed = false;
        result.failedCommand = "buildCommand";
        executorLog.log(`${task.id}: [verification] build failed (exit ${buildResult.exitCode})`);
        return result;
      }
    }

    executorLog.log(`${task.id}: [verification] passed`);
    await this.store.logEntry(
      task.id,
      `[verification] Deterministic verification passed`,
      undefined,
      this.getRunContextFor(task.id),
    );
    return result;
  }

  /**
   * Attempt to fix verification failures by spawning a dedicated AI fix agent.
   * Follows the pattern established by the merger's attemptInMergeVerificationFix.
   * Returns true if verification passes after the fix attempt, false otherwise.
   */
  private async attemptExecutorVerificationFix(
    task: Task,
    worktreePath: string,
    failureContext: {
      command: string;
      exitCode: number | null;
      output: string;
      type: "test" | "build";
    },
    settings: Settings,
    retryNumber: number,
    maxRetries: number,
    extraEnv?: NodeJS.ProcessEnv,
  ): Promise<boolean> {
    try {
      executorLog.log(`${task.id}: spawning executor verification fix agent (attempt ${retryNumber}/${maxRetries})`);

      const logger = new AgentLogger({
        store: this.store,
        taskId: task.id,
        agent: "executor",
        persistAgentToolOutput: settings.persistAgentToolOutput,
        // Executor sessions are task-scoped ephemeral workers.
        persistAgentThinkingLog: resolvePersistAgentThinkingLog(settings, { ephemeral: true }),
        onAgentText: this.options.onAgentText,
        onAgentTool: this.options.onAgentTool,
      });

      // Build skill selection context
      let skillContext: Awaited<ReturnType<typeof buildSessionSkillContext>> | undefined;
      if (this.options.agentStore) {
        try {
          skillContext = await buildSessionSkillContext({
            agentStore: this.options.agentStore,
            task,
            sessionPurpose: "executor",
            projectRootDir: worktreePath,
            pluginRunner: this.options.pluginRunner,
          });
        } catch {
          // Graceful fallback - no skill selection
        }
      }

      // Resolve model using the executor's model hierarchy
      const assignedRuntimeConfig = await this.getAssignedAgentRuntimeConfig(task.assignedAgentId);
      const { provider: executorProvider, modelId: executorModelId } = resolveExecutorSessionModel(
        task.modelProvider,
        task.modelId,
        settings,
        assignedRuntimeConfig,
      );

      // Create the fix agent session
      const { session } = await createResolvedAgentSession({
        sessionPurpose: "executor",
        pluginRunner: this.options.pluginRunner,
        cwd: worktreePath, // Run in the task's worktree
        systemPrompt: `You are a verification fix agent running during task execution in a worktree.

All step-session steps completed successfully but the deterministic verification command failed. Your job is to fix the failing code directly in the working directory.

## Scope
Only fix what is required to make the failing verification pass.
Do not refactor, rename broadly, or make opportunistic improvements.

## Rules
1. Read the error output carefully to understand what is failing before editing anything
2. Before assuming a code fix is needed, check whether the failure is caused by stale/missing build artifacts in a sibling workspace package — typical signatures: \`Failed to resolve import "./X.js"\` pointing into another package's \`dist/\`, \`Cannot find module\`, or \`ERR_MODULE_NOT_FOUND\` referencing a workspace-internal path. In that case, rebuild the affected package(s) (e.g. \`pnpm --filter <pkg> build\`, or \`pnpm --filter "<scope>/*" build\` for a group) and re-run verification before editing source files.
3. Make targeted fixes to the failing code path
4. After fixing, run the verification command to confirm the fix works
5. Do NOT make any git commits — just fix the code
6. You MAY modify any files needed to make the verification pass, including files unrelated to this task's original change. Pre-existing build/test breakage is in scope: fix it. Prefer the smallest change that makes verification green.
7. If you cannot fix the issue within scope, explain why and what evidence indicates a deeper/root problem`,
        tools: "coding",
        onText: logger.onText,
        onThinking: logger.onThinking,
        onToolStart: logger.onToolStart,
        onToolEnd: logger.onToolEnd,
        defaultProvider: executorProvider,
        defaultModelId: executorModelId,
        defaultThinkingLevel: settings.defaultThinkingLevel,
        runAuditor: createRunAuditor(this.store, this.getRunContextFor(task.id)),
        settings,
        taskEnv: extraEnv,
        ...(skillContext?.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
      });

      await this.store.logEntry(
        task.id,
        `Executor verification fix agent started (model: ${describeModel(session)}, attempt ${retryNumber}/${maxRetries})`,
        undefined,
        this.getRunContextFor(task.id),
      );
      await this.store.appendAgentLog(
        task.id,
        `Fix agent started (model: ${describeModel(session)}, attempt ${retryNumber}/${maxRetries})`,
        "text",
        undefined,
        "executor",
      );

      try {
        // Build the fix prompt
        const fixPrompt = `Fix the failing ${failureContext.type} verification for task ${task.id}.

## Failed command
Command: \`${failureContext.command}\`
Exit code: ${failureContext.exitCode}

## Error output
${failureContext.output.slice(0, VERIFICATION_LOG_MAX_CHARS)}

## Instructions
1. Read the error output and identify the root cause
2. Make targeted fixes to resolve the failure
3. Run the verification command \`${failureContext.command}\` to confirm your fix works
4. If the fix doesn't work, try a different approach
5. Do NOT make any git commits`;

        // Run the agent with rate limit retry
        await withRateLimitRetry(async () => {
          await promptWithFallback(session, fixPrompt);
        }, {
          onRetry: (attempt, delayMs, error) => {
            const delaySec = Math.round(delayMs / 1000);
            executorLog.warn(`⏳ ${task.id} executor fix agent rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
          },
        });
        await accumulateSessionTokenUsage(this.store, task.id, session, {
            agentId: task.assignedAgentId ?? undefined,
            role: "executor",
          });

        // Re-run full deterministic verification (test AND build) after the fix attempt
        executorLog.log(`${task.id}: re-running deterministic verification after fix attempt ${retryNumber}/${maxRetries}`);
        await this.store.logEntry(
          task.id,
          `Re-running deterministic verification (attempt ${retryNumber}/${maxRetries})`,
          undefined,
          this.getRunContextFor(task.id),
        );
        await this.store.appendAgentLog(
          task.id,
          `Re-running verification (attempt ${retryNumber}/${maxRetries})`,
          "text",
          undefined,
          "executor",
        );
        const reRunResult = await this.runExecutorDeterministicVerification(task, worktreePath, settings, extraEnv);

        return reRunResult.allPassed;
      } finally {
        await logger.flush();
        session.dispose();
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.warn(`${task.id}: executor verification fix agent error: ${errorMessage}`);
      await this.store.logEntry(
        task.id,
        `Executor verification fix agent encountered an error`,
        errorMessage,
        this.getRunContextFor(task.id),
      );
      await this.store.appendAgentLog(
        task.id,
        "Fix agent encountered an error",
        "tool_error",
        errorMessage,
        "executor",
      );
      return false;
    }
  }

  private async handleWorkflowStepFailure(
    task: Task,
    worktreePath: string,
    failureFeedback: string,
    stepName: string,
  ): Promise<boolean> {
    this.clearCompletedTaskWatchdog(task.id);
    const currentRetries = task.workflowStepRetries ?? 0;

    if (currentRetries >= MAX_WORKFLOW_STEP_RETRIES) {
      // Retries exhausted — caller should fall through to hard failure
      executorLog.warn(`${task.id}: workflow step "${stepName}" failed — retries exhausted (${MAX_WORKFLOW_STEP_RETRIES}/${MAX_WORKFLOW_STEP_RETRIES})`);
      return false;
    }

    const retryCount = currentRetries + 1;
    executorLog.log(`${task.id}: workflow step "${stepName}" failed — retry ${retryCount}/${MAX_WORKFLOW_STEP_RETRIES} (executor will attempt to fix)`);

    // 1. Update the workflowStepRetries counter on the task
    await this.store.updateTask(task.id, {
      workflowStepRetries: retryCount,
    });

    // 2. Inject failure feedback into PROMPT.md
    await this.injectWorkflowStepFailureInstructions(task, failureFeedback, stepName, retryCount);

    // 3. Re-open only the last step so the executor has a single pending
    // slot to re-enter. Earlier done steps stay done.
    const updatedTask = await this.store.getTask(task.id);
    await this.reopenLastStepForRevision(task.id, updatedTask);

    // 4. Clear any session file so we get a fresh session
    await this.store.updateTask(task.id, {
      status: null,
      sessionFile: null,
    });

    // 5. Schedule fresh execution after guard unwinds
    executorLog.log(`${task.id}: scheduling fresh execution after workflow step failure (retry ${retryCount}/${MAX_WORKFLOW_STEP_RETRIES})`);
    this.scheduleWorkflowRerun(
      task.id,
      worktreePath,
      `${task.id}: workflow step retry scheduled — moved to todo then in-progress`,
    );

    return true;
  }

  /**
   * Send a task back to in-progress after verification failure.
   * Injects failure feedback into PROMPT.md, resets steps, clears session,
   * and schedules a move to todo → in-progress after the executing guard clears.
   */
  private async sendTaskBackForFix(
    task: Task,
    worktreePath: string,
    failureFeedback: string,
    stepName: string,
    reason: string,
    preserveResumeState: boolean = true,
    mergeVerificationFailure: boolean = false,
  ): Promise<void> {
    const taskId = task.id;
    this.clearCompletedTaskWatchdog(taskId);

    // 1. Add a task comment explaining the failure
    await this.store.addTaskComment(
      taskId,
      `${reason}. The failing workflow step was "${stepName}". ` +
      `Feedback:\n${failureFeedback}\n\n` +
      `Please fix the issues so the verification can pass on the next attempt.`,
      "agent",
    );

    // 2. Log an entry explaining the task was sent back
    await this.store.logEntry(
      taskId,
      `${reason} — moved back to in-progress for remediation`,
    );

    // 3. Inject failure feedback into PROMPT.md using the existing method
    // Pass MAX_WORKFLOW_STEP_RETRIES to indicate retries are exhausted (shows "3/3 (0 remaining)")
    await this.injectWorkflowStepFailureInstructions(task, failureFeedback, stepName, MAX_WORKFLOW_STEP_RETRIES);

    // 4. Re-open only the last step for a single in-place fix pass. Earlier
    // done steps stay done so the executor doesn't redo finished work.
    const updatedTask = await this.store.getTask(taskId);
    await this.reopenLastStepForRevision(taskId, updatedTask);

    // 5. Clear error/status/session fields and reset workflow step retries
    await this.store.updateTask(taskId, {
      status: mergeVerificationFailure ? "merging-fix" : null,
      error: null,
      sessionFile: null,
      workflowStepRetries: 0,
    });

    // 6. Schedule the move after the guard unwinds (per guard-unwind requirement)
    this.scheduleWorkflowRerun(
      taskId,
      worktreePath,
      `${taskId}: sent back to in-progress for remediation`,
      preserveResumeState,
    );
  }

  /**
   * Inject or update the "Workflow Step Failure" section in PROMPT.md.
   * This section contains failure feedback from workflow steps that hard-failed.
   * The section is replaced entirely to avoid accumulation of old feedback.
   */
  private async injectWorkflowStepFailureInstructions(
    task: Task,
    failureFeedback: string,
    stepName: string,
    retryCount: number,
  ): Promise<void> {
    const promptPath = join(this.store.getFusionDir(), "tasks", task.id, "PROMPT.md");

    // Read existing PROMPT.md
    let content: string;
    try {
      content = await readFile(promptPath, "utf-8");
    } catch {
      executorLog.warn(`${task.id}: PROMPT.md not found at ${promptPath}, skipping workflow failure injection`);
      return;
    }

    const remainingRetries = MAX_WORKFLOW_STEP_RETRIES - retryCount;
    const failureSectionHeader = "## Workflow Step Failure";
    const failureSectionContent = `${failureSectionHeader}

The following workflow step failed and requires implementation fixes:

**Step:** ${stepName}

**Failure Feedback:**
${failureFeedback}

**Retry:** ${retryCount}/${MAX_WORKFLOW_STEP_RETRIES} (${remainingRetries} remaining)

**Important:** This is a workflow step failure — fix the issues above by making the necessary code changes. The task has been sent back to in-progress for remediation. The executor will attempt to fix the issues on the next pass.

`;

    let newContent: string;
    if (content.includes(failureSectionHeader)) {
      // Replace existing section
      const sectionRegex = new RegExp(
        `${failureSectionHeader}[\\s\\S]*?(?=\\n## |\\n# |$)`,
        "i"
      );
      if (sectionRegex.test(content)) {
        newContent = content.replace(sectionRegex, failureSectionContent);
      } else {
        // Fallback: append at end
        newContent = content + "\n" + failureSectionContent;
      }
    } else {
      // Remove any existing Workflow Revision Instructions section first (conflicting state)
      const revisionSectionHeader = "## Workflow Revision Instructions";
      if (content.includes(revisionSectionHeader)) {
        const revisionRegex = new RegExp(
          `${revisionSectionHeader}[\\s\\S]*?(?=\\n## |\\n# |$)`,
          "i"
        );
        content = content.replace(revisionRegex, "");
      }

      // Append new section before any closing markers or at end
      const acceptanceCriteriaMatch = content.match(/\n##\s+Acceptance Criteria\n/);
      if (acceptanceCriteriaMatch) {
        const insertIdx = acceptanceCriteriaMatch.index!;
        newContent = content.slice(0, insertIdx) + "\n" + failureSectionContent + content.slice(insertIdx);
      } else {
        newContent = content + "\n" + failureSectionContent;
      }
    }

    // Write updated content
    try {
      await writeFile(promptPath, newContent);
      executorLog.log(`${task.id}: injected workflow step failure instructions into PROMPT.md (retry ${retryCount}/${MAX_WORKFLOW_STEP_RETRIES})`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.error(`${task.id}: failed to inject workflow step failure instructions: ${errorMessage}`);
    }
  }

  private async captureBaseCommitSha(
    task: Task,
    worktreePath: string,
    audit: { git: (event: { type: "commit:create"; target: string; metadata: Record<string, unknown> }) => Promise<void> },
    options: { isResume: boolean } = { isResume: false },
  ): Promise<void> {
    try {
      // Preserve an existing baseCommitSha only on RESUME of the same
      // worktree, where diff-base stability across sessions of the same task
      // matters. On fresh/pooled acquisitions the branch was just
      // force-reset to current main, so any stored baseCommitSha is by
      // definition behind the new merge-base — preserving it would yield
      // stale diff math and (when reused as a contamination reference) the
      // FN-4417 false-positive cascade. Always recapture on non-resume.
      if (options.isResume && task.baseCommitSha) {
        try {
          execSync(`git merge-base --is-ancestor ${task.baseCommitSha} HEAD`, {
            cwd: worktreePath,
            stdio: "pipe",
          });
          executorLog.log(`${task.id}: preserved baseCommitSha ${task.baseCommitSha.slice(0, 7)} (resume)`);
          await audit.git({
            type: "commit:create",
            target: task.baseCommitSha,
            metadata: { purpose: "base", preserved: true },
          });
          return;
        } catch {
          // Existing baseCommitSha is stale or invalid. Recapture below.
        }
      }

      const baseCommitSha = await resolveCapturedBaseCommitSha(worktreePath, {
        warn: (msg) => executorLog.warn(`${task.id}: ${msg}`),
      });
      if (!baseCommitSha) {
        throw new Error("could not resolve base commit SHA");
      }

      await this.store.updateTask(task.id, { baseCommitSha });
      executorLog.log(`${task.id}: captured baseCommitSha ${baseCommitSha.slice(0, 7)}`);
      await audit.git({ type: "commit:create", target: baseCommitSha, metadata: { purpose: "base", preserved: false } });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.log(`Failed to capture baseCommitSha for ${task.id}: ${errorMessage}`);
      // Non-fatal: task can continue without baseCommitSha
    }
  }

  /**
   * Resolve a fresh merge-base against the integration branch for use as a
   * contamination check reference. Unlike {@link resolveDiffBaseRef}, this
   * NEVER falls back to `task.baseCommitSha`, because a stale stored base
   * would make the contamination check flag every legitimately-merged commit
   * since that snapshot as "foreign" (FN-4417). It also never falls back to
   * `HEAD~1`, because for a newly force-reset pooled branch HEAD~1 is a
   * commit on main itself, which would yield the same false positive on a
   * smaller scale.
   *
   * Returns `undefined` when neither `origin/main` nor `main` is resolvable;
   * the caller is expected to treat that as "contamination check skipped".
   */
  private async resolveContaminationBaseRef(worktreePath: string): Promise<string | undefined> {
    // Prefer LOCAL main over origin/main. origin/main is a tracking ref that
    // is only as fresh as the last `git fetch` — on dev machines that haven't
    // pushed in a while it can lag local main by hundreds of commits, which
    // re-introduces the FN-4417 false positive at a smaller scale (the
    // merge-base falls back to the last common ancestor between HEAD and the
    // stale origin/main, and every commit on local main since then looks
    // "foreign"). Local main is the canonical integration target for Fusion.
    try {
      const { stdout } = await execAsync(
        "git merge-base HEAD main 2>/dev/null || git merge-base HEAD origin/main",
        { cwd: worktreePath, encoding: "utf-8" },
      );
      const ref = stdout.trim();
      return ref || undefined;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.warn(`Failed merge-base lookup for contamination check in ${worktreePath}: ${errorMessage}`);
      return undefined;
    }
  }

  /**
   * Capture the list of files modified during agent execution.
   * Uses git diff against the stored baseCommitSha to determine what changed.
   * Returns an empty array if no changes or if git commands fail.
   */
  private async resolveDiffBaseRef(worktreePath: string, baseCommitSha?: string): Promise<string | undefined> {
    if (baseCommitSha) return baseCommitSha;

    try {
      const { stdout } = await execAsync(
        "git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main",
        { cwd: worktreePath, encoding: "utf-8" },
      );
      const ref = stdout.trim();
      if (ref) return ref;
    } catch (mergeBaseErr: unknown) {
      const mergeBaseMsg = mergeBaseErr instanceof Error ? mergeBaseErr.message : String(mergeBaseErr);
      executorLog.warn(`Failed merge-base lookup for diff base in ${worktreePath}, trying HEAD~1 fallback: ${mergeBaseMsg}`);
    }

    try {
      const { stdout } = await execAsync("git rev-parse HEAD~1", {
        cwd: worktreePath,
        encoding: "utf-8",
      });
      return stdout.trim() || undefined;
    } catch {
      executorLog.log(`Could not determine base commit for diff in ${worktreePath}`);
      return undefined;
    }
  }

  private async captureModifiedFiles(
    worktreePath: string,
    baseCommitSha: string | undefined,
    taskId: string,
    audit?: RunAuditor,
    source = "unspecified",
  ): Promise<string[]> {
    try {
      const baseRef = await this.resolveDiffBaseRef(worktreePath, baseCommitSha);
      if (!baseRef) {
        return [];
      }

      try {
        const attributed = await filterFilesToOwnTaskCommits({
          worktreePath,
          baseRef,
          taskId,
        });
        const divergence = attributed.rawDiffFileCount - attributed.files.length;
        if (divergence > 0) {
          await audit?.database({
            type: "task:worktree-contamination-detected",
            target: taskId,
            metadata: {
              rawDiffFileCount: attributed.rawDiffFileCount,
              attributedFileCount: attributed.files.length,
              foreignCommitCount: attributed.foreignCommits.length,
              foreignCommitShas: attributed.foreignCommits.slice(0, 5).map((commit) => commit.sha),
              source,
            },
          });
          executorLog.warn(
            `${taskId}: contamination detected — raw diff ${attributed.rawDiffFileCount} files, attributed ${attributed.files.length} (foreign commits: ${attributed.foreignCommits.length})`,
          );
        }
        return attributed.files;
      } catch (error) {
        if (error instanceof BranchAttributionError) {
          executorLog.warn(`${taskId}: branch-attribution failed (${error.message}); falling back to raw diff`);
          const { stdout } = await execAsync(`git diff --name-only ${baseRef}..HEAD`, {
            cwd: worktreePath,
            encoding: "utf-8",
          });
          const output = stdout.trim();
          return output ? output.split("\n").filter(Boolean) : [];
        }
        throw error;
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.log(`Failed to capture modified files: ${errorMessage}`);
      return [];
    }
  }

  private async captureUncommittedModifiedFiles(worktreePath: string): Promise<string[]> {
    try {
      const [unstaged, staged] = await Promise.all([
        execAsync("git diff --name-only", { cwd: worktreePath, encoding: "utf-8" }),
        execAsync("git diff --name-only --cached", { cwd: worktreePath, encoding: "utf-8" }),
      ]);
      const files = [...unstaged.stdout.split("\n"), ...staged.stdout.split("\n")]
        .map((entry) => entry.trim())
        .filter(Boolean);
      return [...new Set(files)];
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.warn(`Failed to capture uncommitted modified files: ${errorMessage}`);
      return [];
    }
  }

  // ── Worktree management ────────────────────────────────────────────

  /**
   * Create a git worktree at `path` on a new branch.
   *
   * @param branch — Branch name (e.g., `fusion/fn-042`)
   * @param path — Absolute worktree directory path
   * @param startPoint — Optional git ref to branch from (e.g., `fusion/fn-041`).
   *   When provided, the worktree starts from that ref instead of HEAD.
   */
  /**
   * Run workflow step agents sequentially after main task execution completes.
   * Each workflow step spawns a separate agent with the step's prompt.
   * Returns structured result: all passed, all passed (true), failed (false), or revision requested.
   */
  private async runWorkflowSteps(
    task: Task,
    worktreePath: string,
    settings: Settings,
    taskEnv?: NodeJS.ProcessEnv,
  ): Promise<WorkflowStepResult | "deferred-paused"> {
    await this.auditReadonlyWorkflowStepPromptsOnce(task.id);
    // Check if task has enabled workflow steps
    const currentTask = await this.store.getTask(task.id);
    if (!currentTask.enabledWorkflowSteps?.length) return { allPassed: true };

    const workflowStepIds = currentTask.enabledWorkflowSteps;
    const results: import("@fusion/core").WorkflowStepResult[] = [];

    for (const wsId of workflowStepIds) {
      const ws = await this.store.getWorkflowStep(wsId);
      if (!ws) {
        await this.store.logEntry(task.id, `[pre-merge] Workflow step ${wsId} not found — skipping`);
        results.push({
          workflowStepId: wsId,
          workflowStepName: "Unknown",
          phase: "pre-merge",
          status: "skipped",
          output: "Workflow step definition not found",
        });
        await this.store.updateTask(task.id, { workflowStepResults: results });
        continue;
      }

      // Normalize legacy steps: undefined phase → "pre-merge"
      const stepPhase = ws.phase || "pre-merge";

      // readonly review steps always run pre-merge to reuse the coding worktree — see FN-2185 post-mortem.
      // Skip non-readonly post-merge steps — those run in the merger after merge.
      if (stepPhase === "post-merge" && ws.toolMode !== "readonly") continue;

      // Normalize legacy steps without mode to prompt-mode
      const stepMode: "prompt" | "script" = ws.mode || "prompt";
      const gateMode: "gate" | "advisory" = ws.gateMode || (stepMode === "script" ? "gate" : "advisory");

      // Skip validation per mode
      if (stepMode === "prompt" && !ws.prompt?.trim()) {
        await this.store.logEntry(task.id, `[pre-merge] Workflow step '${ws.name}' has no prompt — skipping`);
        results.push({
          workflowStepId: ws.id,
          workflowStepName: ws.name,
          phase: stepPhase,
          status: "skipped",
          output: "No prompt configured for this workflow step",
        });
        await this.store.updateTask(task.id, { workflowStepResults: results });
        continue;
      }

      if (stepMode === "script" && !ws.scriptName?.trim()) {
        await this.store.logEntry(task.id, `[pre-merge] Workflow step '${ws.name}' has no scriptName — skipping`);
        results.push({
          workflowStepId: ws.id,
          workflowStepName: ws.name,
          phase: stepPhase,
          status: "skipped",
          output: "No scriptName configured for this workflow step",
        });
        await this.store.updateTask(task.id, { workflowStepResults: results });
        continue;
      }

      if (this.isFrontendUxStep(ws)) {
        try {
          const diffScopedFiles = await this.captureModifiedFiles(worktreePath, currentTask.baseCommitSha, task.id, undefined, "workflow-step-frontend-ux");
          const declaredScopedFiles = await this.store.parseFileScopeFromPrompt(task.id).catch(() => [] as string[]);
          const diffHasSignal = diffScopedFiles.length > 0;
          const declaredHasSignal = declaredScopedFiles.length > 0;
          const diffHasFrontendFiles = diffHasSignal && this.hasFrontendFilesInScope(diffScopedFiles);
          const declaredHasFrontendFiles = declaredHasSignal && this.hasFrontendFilesInScope(declaredScopedFiles);

          const shouldSkipForDiffOnly = diffHasSignal && !declaredHasSignal && !diffHasFrontendFiles;
          const shouldSkipForDeclaredOnly = declaredHasSignal && !diffHasSignal && !declaredHasFrontendFiles;
          const shouldSkipForBothSignals = diffHasSignal && declaredHasSignal && !diffHasFrontendFiles && !declaredHasFrontendFiles;

          if (shouldSkipForDiffOnly || shouldSkipForDeclaredOnly || shouldSkipForBothSignals) {
            const skippedForDeclaredScope = shouldSkipForDeclaredOnly || shouldSkipForBothSignals;
            results.push({
              workflowStepId: ws.id,
              workflowStepName: ws.name,
              phase: stepPhase,
              status: "skipped",
              output: skippedForDeclaredScope
                ? "Declared File Scope contains no frontend/UI files — auto-skipped (FN-4343)"
                : "No frontend/UI files in diff scope — auto-skipped (FN-3906)",
            });
            await this.store.updateTask(task.id, { workflowStepResults: results });
            await this.store.logEntry(
              task.id,
              skippedForDeclaredScope
                ? "[pre-merge] Auto-skipped Frontend UX Design — declared File Scope contains no frontend/UI files (FN-4343)"
                : "[pre-merge] Auto-skipped Frontend UX Design — no frontend/UI files in diff scope",
            );
            continue;
          }
        } catch {
          // best-effort scope detection only; fall through to regular execution/defer flow
        }
      }

      if (await this.shouldDeferWorkflowStepCompletion(task.id, `before workflow step '${ws.name}'`)) {
        return "deferred-paused";
      }

      if (ws.id.startsWith("plugin:")) {
        await this.store.logEntry(task.id, `[pre-merge] Starting plugin workflow step: ${ws.name} (${ws.id})`);
      } else {
        await this.store.logEntry(task.id, `[pre-merge] Starting workflow step: ${ws.name} (${stepMode} mode)`);
      }
      executorLog.log(`${task.id} — [pre-merge] running workflow step: ${ws.name} (${stepMode} mode)`);

      const startedAt = new Date().toISOString();
      const stepStartedAtMs = Date.now();
      const workflowStepScopeEnforcement = settings.workflowStepScopeEnforcement ?? "block";
      const shouldCheckWorkflowStepScope = stepPhase === "pre-merge"
        && stepMode === "prompt"
        && workflowStepScopeEnforcement !== "off";
      const preStepModifiedFiles = shouldCheckWorkflowStepScope
        ? await this.captureModifiedFiles(worktreePath, currentTask.baseCommitSha, task.id, undefined, "workflow-step-pre")
        : [];

      // Push pending entry BEFORE execution so dashboard can show live status
      results.push({
        workflowStepId: ws.id,
        workflowStepName: ws.name,
        phase: stepPhase,
        status: "pending",
        startedAt,
      });
      await this.store.updateTask(task.id, { workflowStepResults: results });

      try {
        const result: WorkflowStepOutcome = stepMode === "script"
          ? await this.executeScriptWorkflowStep(task, ws, worktreePath, settings, taskEnv)
          : await this.executeWorkflowStep(task, ws, worktreePath, settings, taskEnv);
        if (await this.shouldDeferWorkflowStepCompletion(task.id, `workflow step '${ws.name}'`)) {
          return "deferred-paused";
        }
        const completedAt = new Date().toISOString();

        if (result.success) {
          if (shouldCheckWorkflowStepScope) {
            const declaredScope = await this.store.parseFileScopeFromPrompt(task.id).catch(() => [] as string[]);
            const refreshedTask = await this.store.getTask(task.id);
            if (declaredScope.length > 0 && refreshedTask?.scopeOverride !== true) {
              const postStepModifiedFiles = await this.captureModifiedFiles(worktreePath, currentTask.baseCommitSha, task.id, undefined, "workflow-step-post");
              const preStepSet = new Set(preStepModifiedFiles);
              const stepCommittedFiles = postStepModifiedFiles.filter((filePath) => !preStepSet.has(filePath));
              const stepUncommittedFiles = await this.captureUncommittedModifiedFiles(worktreePath);
              const stepTouchedFiles = [...new Set([...stepCommittedFiles, ...stepUncommittedFiles])];
              const hasScopeOverlap = stepTouchedFiles.some((filePath) => workflowPathMatchesDeclaredScope(filePath, declaredScope));
              if (stepTouchedFiles.length > 0 && !hasScopeOverlap) {
                const scopeLeakMessage = `Workflow step '${ws.name}' wrote files outside declared File Scope. Staged: [${stepTouchedFiles.join(", ")}]. Declared: [${declaredScope.join(", ")}]. (FN-4343)`;
                await this.store.logEntry(
                  task.id,
                  `[pre-merge] Workflow step scope leak: ${ws.name} wrote off-scope files [${stepTouchedFiles.join(", ") || "<none>"}]`,
                );
                if (workflowStepScopeEnforcement === "warn") {
                  await this.store.logEntry(task.id, `[pre-merge] workflowStepScopeEnforcement=warn — ${scopeLeakMessage}`);
                } else {
                  const existingIdx = results.findIndex(r => r.workflowStepId === ws.id);
                  if (existingIdx >= 0) {
                    results[existingIdx] = {
                      ...results[existingIdx],
                      status: gateMode === "advisory" ? "advisory_failure" : "failed",
                      output: scopeLeakMessage,
                      notes: scopeLeakMessage,
                      completedAt,
                    };
                  }
                  await this.store.updateTask(task.id, { workflowStepResults: results });
                  if (gateMode === "advisory") {
                    await this.store.updateTask(task.id, { status: "advisory_failure" });
                    await this.store.logEntry(task.id, `[pre-merge] Advisory workflow step scope warning: ${ws.name}`);
                    continue;
                  }
                  return {
                    allPassed: false,
                    revisionRequested: true,
                    feedback: scopeLeakMessage,
                    stepName: ws.name,
                  };
                }
              }
            }
          }

          await this.store.logEntry(task.id, `[timing] Workflow step '${ws.name}' completed in ${Date.now() - stepStartedAtMs}ms`);
          await this.store.logEntry(task.id, `[pre-merge] Workflow step completed: ${ws.name}`);
          executorLog.log(`${task.id} — [pre-merge] workflow step passed: ${ws.name}`);
          // Update existing pending entry in place
          const existingIdx = results.findIndex(r => r.workflowStepId === ws.id);
          if (existingIdx >= 0) {
            const malformed = result.malformed === true;
            results[existingIdx] = {
              ...results[existingIdx],
              status: malformed ? "skipped" : "passed",
              output: malformed ? "malformed output — no verdict extracted" : result.output,
              verdict: result.verdict,
              notes: result.notes ?? (malformed ? undefined : result.output),
              completedAt,
            };
          }
          await this.store.updateTask(task.id, { workflowStepResults: results });
        } else if (result.revisionRequested) {
          // Revision requested — this is a structured outcome that routes back to executor
          await this.store.logEntry(task.id, `[timing] Workflow step '${ws.name}' requested revision after ${Date.now() - stepStartedAtMs}ms`);
          await this.store.logEntry(
            task.id,
            `[pre-merge] Workflow step requested revision: ${ws.name}`,
            result.output,
          );
          executorLog.log(`${task.id} — [pre-merge] workflow step requested revision: ${ws.name}`);
          // Update existing pending entry in place
          const existingIdx = results.findIndex(r => r.workflowStepId === ws.id);
          if (existingIdx >= 0) {
            results[existingIdx] = {
              ...results[existingIdx],
              status: gateMode === "advisory" ? "advisory_failure" : "failed",
              output: result.output || "Revision requested",
              verdict: result.verdict,
              notes: result.notes || result.output || "Revision requested",
              completedAt,
            };
          }
          await this.store.updateTask(task.id, { workflowStepResults: results });
          if (gateMode === "advisory") {
            await this.store.logEntry(task.id, `[pre-merge] Advisory workflow step failed: ${ws.name}`);
            continue;
          }
          return {
            allPassed: false,
            revisionRequested: true,
            feedback: result.output || "Workflow step requested revision",
            stepName: ws.name,
          };
        } else {
          // Hard failure
          await this.store.logEntry(task.id, `[timing] Workflow step '${ws.name}' failed after ${Date.now() - stepStartedAtMs}ms`);
          await this.store.logEntry(
            task.id,
            `[pre-merge] Workflow step failed: ${ws.name}`,
            result.error || "Unknown error",
          );
          executorLog.error(`${task.id} — [pre-merge] workflow step failed: ${ws.name}; output captured in task log`);
          // Update existing pending entry in place
          const existingIdx = results.findIndex(r => r.workflowStepId === ws.id);
          if (existingIdx >= 0) {
            results[existingIdx] = {
              ...results[existingIdx],
              status: gateMode === "advisory" ? "advisory_failure" : "failed",
              output: result.error || "Workflow step failed",
              notes: result.error || "Workflow step failed",
              completedAt,
            };
          }
          await this.store.updateTask(task.id, { workflowStepResults: results });
          if (gateMode === "advisory") {
            await this.store.updateTask(task.id, { status: "advisory_failure" });
            await this.store.logEntry(task.id, `[pre-merge] Advisory workflow step failed: ${ws.name}`);
            continue;
          }
          return {
            allPassed: false,
            revisionRequested: false,
            feedback: result.error || "Workflow step failed",
            stepName: ws.name,
          };
        }
      } catch (err: unknown) {
        if (await this.shouldDeferWorkflowStepCompletion(task.id, `workflow step '${ws.name}'`)) {
          return "deferred-paused";
        }
        const { message: errorMessage, detail: errorDetail, stack: errorStack } = formatError(err);
        const completedAt = new Date().toISOString();
        await this.store.logEntry(
          task.id,
          `[pre-merge] Workflow step failed: ${ws.name}`,
          errorStack ?? errorDetail,
        );
        executorLog.error(`${task.id} — [pre-merge] workflow step error: ${ws.name} — ${errorDetail}`);
        // Update existing pending entry in place
        const existingIdx = results.findIndex(r => r.workflowStepId === ws.id);
        if (existingIdx >= 0) {
          results[existingIdx] = {
            ...results[existingIdx],
            status: gateMode === "advisory" ? "advisory_failure" : "failed",
            output: errorMessage || "Workflow step error",
            notes: errorMessage || "Workflow step error",
            completedAt,
          };
        }
        await this.store.updateTask(task.id, { workflowStepResults: results });
        if (gateMode === "advisory") {
          await this.store.updateTask(task.id, { status: "advisory_failure" });
          await this.store.logEntry(task.id, `[pre-merge] Advisory workflow step error: ${ws.name}`);
          continue;
        }
        return {
          allPassed: false,
          revisionRequested: false,
          feedback: errorMessage || "Workflow step error",
          stepName: ws.name,
        };
      }
    }

    return { allPassed: true };
  }

  /**
   * Execute a script-mode workflow step by resolving the scriptName to a command
   * from project settings and running it in the task worktree.
   */
  private async executeScriptWorkflowStep(
    task: Task,
    workflowStep: WorkflowStep,
    worktreePath: string,
    settings: Settings,
    extraEnv?: NodeJS.ProcessEnv,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    const scriptName = workflowStep.scriptName!.trim();
    const scriptCommand = settings.scripts?.[scriptName];

    if (!scriptCommand) {
      const available = settings.scripts ? Object.keys(settings.scripts).join(", ") : "none";
      const msg = `Script '${scriptName}' not found in project settings. Available scripts: ${available}`;
      await this.store.logEntry(task.id, msg);
      return { success: false, error: msg };
    }

    executorLog.log(`${task.id}: workflow step '${workflowStep.name}' executing script '${scriptName}': ${scriptCommand}`);
    await this.store.logEntry(task.id, `Workflow step '${workflowStep.name}' executing script '${scriptName}': ${scriptCommand}`);

    const scriptAbortController = new AbortController();
    this.registerConfiguredCommandController(task.id, scriptAbortController);
    try {
      const scriptResult = await runConfiguredCommand(
        scriptCommand,
        worktreePath,
        120_000,
        extraEnv,
        createRunAuditor(this.store, {
          runId: this.getRunContextFor(task.id)?.runId ?? generateSyntheticRunId("exec-script", task.id),
          agentId: this.getRunContextFor(task.id)?.agentId ?? (task.assignedAgentId ?? "executor"),
          taskId: task.id,
          phase: "execute",
        }),
        scriptAbortController.signal,
      );
      if (scriptAbortController.signal.aborted) {
        throw this.createConfiguredCommandAbortError(task.id, scriptCommand);
      }
      if (scriptResult.spawnError || scriptResult.timedOut || scriptResult.exitCode !== 0) {
        return { success: false, error: configuredCommandErrorMessage(scriptResult) };
      }
      return { success: true, output: `Script '${scriptName}' completed successfully` };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      const execError = err instanceof Error ? err : new Error(String(err));
      const stderr = "stderr" in execError && typeof execError.stderr === "string" ? execError.stderr.trim() : "";
      const stdout = "stdout" in execError && typeof execError.stdout === "string" ? execError.stdout.trim() : "";
      const exitCode = "code" in execError ? execError.code : ("status" in execError ? execError.status : undefined);
      const parts: string[] = [];
      if (exitCode !== undefined) parts.push(`Exit code: ${exitCode}`);
      if (stdout) parts.push(`stdout: ${truncateWorkflowScriptOutput(stdout)}`);
      if (stderr) parts.push(`stderr: ${truncateWorkflowScriptOutput(stderr)}`);
      if (!parts.length) parts.push(execError.message || "Unknown error");
      const errorOutput = parts.join("\n");
      return { success: false, error: errorOutput };
    } finally {
      this.unregisterConfiguredCommandController(task.id, scriptAbortController);
    }
  }

  /**
   * FN-3906: Only the built-in Frontend UX Design step gets orchestrator-level
   * diff-scope auto-skip. Match by canonical template id only.
   */
  private isFrontendUxStep(workflowStep: WorkflowStep): boolean {
    return workflowStep.id === "frontend-ux-design";
  }

  /**
   * FN-3906: Detect whether the task diff scope contains frontend/UI-related
   * files so Frontend UX Design can be safely skipped when irrelevant.
   */
  private hasFrontendFilesInScope(files: string[]): boolean {
    const frontendExtensionPattern = /\.(tsx|jsx|vue|svelte|astro|html|css|scss|sass|less|styl)$/i;
    const frontendPathMarkers = [
      "/components/",
      "/app/components/",
      "/dashboard/",
      "/frontend/",
      "/ui/",
      "/styles/",
      "/themes/",
      "/design-system/",
      "/design-tokens/",
    ];
    const frontendTokenFilenamePattern = /(^|\/)(tokens|theme)\.(ts|js|json|css)$/i;

    return files.some((file) => {
      const normalized = file.replace(/\\/g, "/");
      const lowered = normalized.toLowerCase();
      return frontendExtensionPattern.test(normalized)
        || frontendPathMarkers.some((marker) => lowered.includes(marker))
        || frontendTokenFilenamePattern.test(lowered);
    });
  }

  /** Parse structured JSON verdict from workflow step output. */
  private parseWorkflowStepOutput(rawOutput: string): {
    output: string;
    verdict?: "APPROVE" | "APPROVE_WITH_NOTES" | "REVISE";
    notes?: string;
    malformed?: boolean;
  } {
    const trimmed = rawOutput.trim();
    const parsed = parseWorkflowStepVerdict(trimmed);
    if (parsed) {
      return {
        output: parsed.notes || "",
        verdict: parsed.verdict,
        notes: parsed.notes,
      };
    }

    const inferred = inferWorkflowStepVerdictFromProse(trimmed);
    if (inferred) {
      return {
        output: inferred.notes || trimmed,
        verdict: inferred.verdict,
        notes: inferred.notes,
      };
    }

    return { output: trimmed, malformed: true };
  }

  /**
   * Execute a single workflow step by spawning an agent with the step's prompt.
   * Returns structured outcome with support for revision requests.
   */
  private async executeWorkflowStep(
    task: Task,
    workflowStep: WorkflowStep,
    worktreePath: string,
    settings: Settings,
    taskEnv?: NodeJS.ProcessEnv,
  ): Promise<WorkflowStepOutcome> {
    const toolMode: "coding" | "readonly" = workflowStep.toolMode || "readonly";

    // Compute the diff scope so the workflow step agent reviews only what THIS
    // task changed — not unrelated files it might wander into. Without this,
    // open-ended review prompts (e.g. "verify visual polish") have been
    // observed to spend the entire timeout budget reading pre-existing files
    // that match the task description's keywords. See FN-3327 post-mortem.
    const scopedFiles = await this.captureModifiedFiles(worktreePath, task.baseCommitSha, task.id, undefined, "workflow-step-handler");
    let diffShortstat: string | undefined;
    try {
      const baseRef = await this.resolveDiffBaseRef(worktreePath, task.baseCommitSha);
      if (baseRef) {
        const { stdout } = await execAsync(`git diff --shortstat ${baseRef}..HEAD`, {
          cwd: worktreePath,
          encoding: "utf-8",
        });
        diffShortstat = stdout.trim() || undefined;
      }
    } catch {
      // best-effort — fall through with no shortstat
    }

    const MAX_SCOPE_FILES = 100;
    const scopeFileBlock = scopedFiles.length === 0
      ? "(no modified files detected for this task — review the worktree directly, but do NOT browse unrelated files)"
      : scopedFiles.length > MAX_SCOPE_FILES
        ? `${scopedFiles.slice(0, MAX_SCOPE_FILES).map((f) => `- ${f}`).join("\n")}\n- ... (${scopedFiles.length - MAX_SCOPE_FILES} more files truncated)`
        : scopedFiles.map((f) => `- ${f}`).join("\n");

    const scopeBlock = `Diff Scope (files changed by THIS task vs base):
${scopeFileBlock}${diffShortstat ? `\nDiff stat: ${diffShortstat}` : ""}

CRITICAL SCOPING RULES — read before doing anything else:
- Review ONLY the files listed above. Do NOT analyze unmodified files or unrelated parts of the codebase.
- If NONE of the files in the diff scope are relevant to your review category (e.g. a UX/design reviewer with no UI/CSS/component files in scope, a security reviewer with no auth/network code in scope, an a11y reviewer with no markup changes), respond IMMEDIATELY with a single short approval line such as "No relevant changes in scope — approved." and STOP. Do not start exploring the codebase.
- Your wall-clock budget is short. Spending it browsing unmodified files will cause this step to time out and block merge.`;

    const systemPrompt = `You are a workflow step agent executing: ${workflowStep.name}

Task Context:
- Task ID: ${task.id}
- Task Description: ${task.description}
- Worktree: ${worktreePath}

${scopeBlock}

Your role:
- Execute this workflow step exactly as scoped.
- Prioritize high-impact correctness/risk findings over stylistic nits.
- Keep feedback actionable and directly tied to evidence in files/outputs.

Your Instructions:
${workflowStep.prompt}

You have access to the file system to review changes.

## Feedback Format

When your review is complete, your final line MUST be a single JSON object (no markdown fences):

{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}

Rules:
- Output exactly one trailing JSON object and stop.
- verdict must be exactly APPROVE, APPROVE_WITH_NOTES, or REVISE.
- notes should be concise and actionable. Use an empty string when there are no notes.
- For out-of-scope fast-bail responses, use: {"verdict":"APPROVE","notes":"out of scope: no UI files changed"}

Backward compat fallback: if JSON is unavailable, you may still begin output with REQUEST REVISION to request changes.`;

    const agentLogger = new AgentLogger({
      store: this.store,
      taskId: task.id,
      agent: "reviewer",
      persistAgentToolOutput: settings.persistAgentToolOutput,
      // Review-in-executor sessions are task-scoped ephemeral workers.
      persistAgentThinkingLog: resolvePersistAgentThinkingLog(settings, { ephemeral: true }),
      onAgentText: (taskId, delta) => {
        this.options.onAgentText?.(taskId, delta);
      },
      onAgentTool: (taskId, toolName) => {
        this.options.onAgentTool?.(taskId, toolName);
      },
    });

    // Determine primary model and an explicit fallback. The workflow step's
    // own override takes precedence; otherwise we use the project default
    // override before falling through to the global default. The
    // fallback is the per-step override's missing-counterpart settings, then
    // the global validator/fallback pair, then the executor's `fallbackProvider`.
    const defaultModel = resolveProjectDefaultModel(settings);
    const primaryProvider = workflowStep.modelProvider || defaultModel.provider;
    const primaryModelId = workflowStep.modelId || defaultModel.modelId;
    const useOverride = !!(workflowStep.modelProvider && workflowStep.modelId);

    type ModelTuple = { provider?: string; modelId?: string };
    const fallbackCandidates: Array<ModelTuple & { label: string }> = [
      { provider: settings.validatorFallbackProvider, modelId: settings.validatorFallbackModelId, label: "validatorFallback" },
      { provider: settings.fallbackProvider, modelId: settings.fallbackModelId, label: "globalFallback" },
    ];
    const fallback = fallbackCandidates.find(
      (c) => c.provider && c.modelId && (c.provider !== primaryProvider || c.modelId !== primaryModelId),
    );

    const timeoutMs = Math.max(60_000, settings.workflowStepTimeoutMs ?? 360_000);

    const runOnce = async (
      provider: string | undefined,
      modelId: string | undefined,
      attemptLabel: string,
    ): Promise<WorkflowStepOutcome> => {
      // Workflow step agents inherit executor instructions
      const stepInstructions = await this.resolveInstructionsForRole("executor", settings);
      const stepSystemPrompt = buildSystemPromptWithInstructions(systemPrompt, stepInstructions);

      // Build skill selection context for workflow step session
      const skillContext = await buildSessionSkillContext({
        agentStore: this.options.agentStore!,
        task,
        sessionPurpose: "executor",
        projectRootDir: this.rootDir,
        pluginRunner: this.options.pluginRunner,
      });

      const workflowAgent = task.assignedAgentId && this.options.agentStore
        ? await this.options.agentStore.getAgent(task.assignedAgentId).catch(() => null)
        : null;
      const workflowRuntimeHint = extractRuntimeHint(workflowAgent?.runtimeConfig);
      const readonlyCustomTools = toolMode === "readonly"
        ? filterCustomToolsForReadonly([])
        : { allowed: [] as ToolDefinition[], denied: [] as string[] };
      if (toolMode === "readonly" && readonlyCustomTools.denied.length > 0) {
        await this.store.logEntry(
          task.id,
          `[readonly-violation] Workflow step '${workflowStep.name}' dropped denied custom tools: ${readonlyCustomTools.denied.join(", ")}`,
        );
      }

      const { session } = await createResolvedAgentSession({
        sessionPurpose: "executor",
        runtimeHint: workflowRuntimeHint,
        pluginRunner: this.options.pluginRunner,
        cwd: worktreePath,
        systemPrompt: stepSystemPrompt,
        tools: toolMode,
        defaultProvider: provider,
        defaultModelId: modelId,
        fallbackProvider: settings.fallbackProvider,
        fallbackModelId: settings.fallbackModelId,
        defaultThinkingLevel: settings.defaultThinkingLevel,
        runAuditor: createRunAuditor(this.store, this.getRunContextFor(task.id)),
        settings,
        taskEnv,
        // Skill selection: use assigned agent skills if available, otherwise role fallback
        ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
        ...(readonlyCustomTools.allowed.length > 0 ? { customTools: readonlyCustomTools.allowed } : {}),
      });

      executorLog.log(`${task.id}: workflow step '${workflowStep.name}' using model ${describeModel(session)}${useOverride && attemptLabel === "primary" ? " (workflow step override)" : ""}${attemptLabel === "fallback" ? " (fallback after timeout)" : ""}`);
      await this.store.logEntry(
        task.id,
        `Workflow step '${workflowStep.name}' using model: ${describeModel(session)}${useOverride && attemptLabel === "primary" ? " (workflow step override)" : ""}${attemptLabel === "fallback" ? " (fallback after timeout)" : ""}`,
      );
      this.setActiveWorkflowStepSession(task.id, session, worktreePath);

      let output = "";
      const deltaNormalizer = createStreamingDeltaNormalizer();
      session.subscribe((event) => {
        if (event.type === "message_update") {
          const msgEvent = event.assistantMessageEvent;
          if (msgEvent.type === "text_delta") {
            // Repair dropped sentence-boundary spaces at the shared engine delta chokepoint,
            // including tool-call cross-message boundaries (see streaming-delta.ts).
            const delta = deltaNormalizer.normalize(msgEvent.partial, msgEvent.contentIndex, msgEvent.delta, "text");
            output += delta;
            agentLogger.onText(delta);
          } else if (msgEvent.type === "thinking_delta") {
            // Repair dropped sentence-boundary spaces at the shared engine delta chokepoint,
            // including tool-call cross-message boundaries (see streaming-delta.ts).
            const delta = deltaNormalizer.normalize(msgEvent.partial, msgEvent.contentIndex, msgEvent.delta, "thinking");
            agentLogger.onThinking(delta);
          }
        }
        if (event.type === "tool_execution_start") {
          agentLogger.onToolStart(event.toolName, event.args as Record<string, unknown> | undefined);
        }
        if (event.type === "tool_execution_end") {
          agentLogger.onToolEnd(event.toolName, event.isError, event.result);
        }
      });

      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<"timeout">((resolveTimeout) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          resolveTimeout("timeout");
        }, timeoutMs);
      });

      try {
        const promptPromise = promptWithFallback(
          session,
          `Execute the workflow step "${workflowStep.name}" for task ${task.id}.\n\n` +
          `Review the work done in this worktree and evaluate it against the criteria in your instructions.`,
        );

        const outcome = await Promise.race([
          promptPromise.then(() => "completed" as const),
          timeoutPromise,
        ]);

        if (outcome === "timeout") {
          executorLog.warn(`${task.id}: workflow step '${workflowStep.name}' (${attemptLabel}) timed out after ${timeoutMs}ms — disposing session`);
          await this.store.logEntry(
            task.id,
            `Workflow step '${workflowStep.name}' ${attemptLabel === "primary" ? "primary" : "fallback"} model timed out after ${Math.round(timeoutMs / 1000)}s — aborting session`,
          );
          try { session.dispose(); } catch { /* best-effort */ }
          await agentLogger.flush();
          return { success: false, error: `workflow step timed out after ${timeoutMs}ms`, timedOut: true };
        }

        // Completed within the timeout — let any post-completion errors surface.
        checkSessionError(session);
        await accumulateSessionTokenUsage(this.store, task.id, session, {
            agentId: task.assignedAgentId ?? undefined,
            role: "executor",
          });
        session.dispose();
        await agentLogger.flush();

        const parsed = this.parseWorkflowStepOutput(output);
        if (parsed.verdict) {
          const revisionRequested = parsed.verdict === "REVISE";
          return {
            success: !revisionRequested,
            revisionRequested,
            output: parsed.output,
            verdict: parsed.verdict,
            notes: parsed.notes,
          };
        }

        if (parsed.malformed) {
          await this.store.logEntry(
            task.id,
            `[pre-merge] Workflow step '${workflowStep.name}' produced malformed output — treating as skipped`,
          );
          return { success: true, output: parsed.output, notes: undefined, malformed: true };
        }

        return { success: true, output: parsed.output };
      } catch (err: unknown) {
        await agentLogger.flush();
        try { session.dispose(); } catch { /* best-effort */ }
        if ((err instanceof ReadonlyViolationError) || ((err as { code?: string } | null)?.code === "READONLY_VIOLATION")) {
          const violation = err as ReadonlyViolationError;
          const deniedTool = violation.toolName || "unknown";
          await this.store.logEntry(
            task.id,
            `[readonly-violation] Workflow step '${workflowStep.name}' attempted denied tool '${deniedTool}'`,
          );
          return { success: false, error: `[readonly-violation] ${violation.message}` };
        }
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, error: errorMessage };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        const activeWorkflowStepSession = this.activeWorkflowStepSessions.get(task.id);
        if (activeWorkflowStepSession === session) {
          this.deleteActiveWorkflowStepSession(task.id);
        }
        // Suppress unused-variable warning; `timedOut` documents intent.
        void timedOut;
      }
    };

    const primaryOutcome = await runOnce(primaryProvider, primaryModelId, "primary");
    if (!primaryOutcome.timedOut) return primaryOutcome;

    if (!fallback) {
      executorLog.warn(`${task.id}: workflow step '${workflowStep.name}' timed out and no fallback model is configured`);
      await this.store.logEntry(
        task.id,
        `Workflow step '${workflowStep.name}' timed out — no fallback model configured (set settings.validatorFallbackProvider/Id or fallbackProvider/Id)`,
      );
      return primaryOutcome;
    }

    executorLog.log(`${task.id}: retrying workflow step '${workflowStep.name}' with fallback ${fallback.provider}/${fallback.modelId} (label=${fallback.label})`);
    return runOnce(fallback.provider, fallback.modelId, "fallback");
  }

  private async auditReadonlyWorkflowStepPromptsOnce(taskId: string): Promise<void> {
    if (this.readonlyWorkflowStepAuditDone) return;
    this.readonlyWorkflowStepAuditDone = true;
    const tokens = ["edit", "write", "commit", "stage", "modify"];
    try {
      const steps = await this.store.listWorkflowSteps();
      for (const step of steps) {
        if ((step.mode || "prompt") !== "prompt" || (step.toolMode || "readonly") !== "readonly") continue;
        const prompt = step.prompt || "";
        for (const token of tokens) {
          const re = new RegExp(`\\b${token}\\b`, "i");
          if (re.test(prompt)) {
            executorLog.warn(`[workflow-step-audit] readonly step "${step.name}" prompt contains write-implying token "${token}" — re-review intended scope (no auto-migration performed)`);
            break;
          }
        }
      }
    } catch (error) {
      executorLog.warn(`${taskId}: failed readonly workflow-step prompt audit: ${formatError(error)}`);
    }
  }

  private MAX_WORKTREE_RETRIES = 3;
  private WORKTREE_RETRY_DELAYS = [100, 500, 1000]; // ms

  /**
   * Create a git worktree with automatic recovery from conflicts.
   * Implements retry logic with exponential backoff for transient failures.
   * 
   * @param branch - The branch name to create (e.g., "fusion/fn-123")
   * @param path - The desired worktree path
   * @param taskId - The task ID for logging
   * @param startPoint - Optional base branch/commit for new branch
   * @returns The actual worktree path (may differ if recovery generated new name)
   */
  private formatBranchConflictLifecycleLog(taskId: string, error: BranchConflictError): string {
    const strandedSummary = error.strandedCommits.length > 0
      ? error.strandedCommits.map((commit) => `${commit.sha.slice(0, 12)} ${commit.subject}`).join("; ")
      : "none";
    const recommendation = "Resolve the local branch/worktree conflict with git tooling (inspect/reclaim or discard) before retrying.";
    return [
      `Branch conflict: ${error.branchName} is already checked out at ${error.conflictingWorktreePath}`,
      `Existing tip: ${error.existingTipSha}`,
      `Stranded commits since ${error.startPoint}: ${strandedSummary}`,
      recommendation,
    ].join("\n");
  }

  private formatBranchConflictAgentLog(taskId: string, error: BranchConflictError): string {
    const lines = [
      `branch=${error.branchName}`,
      `worktree=${error.conflictingWorktreePath}`,
      `existingTipSha=${error.existingTipSha}`,
      `startPoint=${error.startPoint}`,
    ];
    if (error.strandedCommits.length > 0) {
      lines.push(
        ...error.strandedCommits.map((commit) => `stranded=${commit.sha.slice(0, 12)} ${commit.subject}`),
      );
    } else {
      lines.push("stranded=none");
    }
    lines.push(
      `recommendation=Resolve the local branch/worktree conflict with git tooling (inspect/reclaim or discard) before retrying.`,
    );
    return lines.join("\n");
  }

  private readonly MAX_AUTO_RECOVERY_ATTEMPTS = 3;
  private readonly BRANCH_CONFLICT_TRIPWIRE_THRESHOLD = 5;

  private async tryBootstrapMisbindingRecovery(
    task: Task,
    contamination: BranchCrossContaminationError,
    audit: ReturnType<typeof createRunAuditor>,
  ): Promise<boolean> {
    const bootstrap = await classifyBootstrapMisbinding({
      repoDir: this.rootDir,
      branchName: contamination.branchName,
      baseSha: contamination.baseSha,
      taskId: task.id,
      foreignCommits: contamination.foreignCommits,
    });

    if (!bootstrap.isBootstrapMisbinding) {
      return false;
    }

    const worktreePath = task.worktree;
    const worktreeClassification = worktreePath
      ? await classifyTaskWorktree(this.rootDir, worktreePath)
      : { ok: false as const };
    if (!worktreePath || !worktreeClassification.ok) {
      await this.store.logEntry(task.id, `[recovery] bootstrap misbinding detected but worktree unavailable for re-anchor: ${worktreePath ?? "none"}`, undefined, this.getRunContextFor(task.id));
      return false;
    }

    await this.store.logEntry(task.id, `[recovery] bootstrap-time branch misbinding detected on ${contamination.branchName}: 0 own commits, re-anchoring to ${contamination.baseSha}`, undefined, this.getRunContextFor(task.id));

    try {
      const reanchor = await reanchorBranchToBase({
        repoDir: this.rootDir,
        worktreePath,
        branchName: contamination.branchName,
        baseSha: contamination.baseSha,
        taskId: task.id,
      });
      await audit.git({
        type: "branch:reanchor",
        target: contamination.branchName,
        metadata: {
          taskId: task.id,
          baseSha: contamination.baseSha,
          previousTipSha: reanchor.previousTipSha,
          newTipSha: reanchor.newTipSha,
          trigger: "bootstrap-misbinding",
        },
      });
      await this.store.updateTask(task.id, {
        recoveryRetryCount: null,
        nextRecoveryAt: null,
        error: null,
        paused: false,
        pausedReason: null,
      });
      await this.store.moveTask(task.id, "todo", { preserveResumeState: false, preserveWorktree: true });
      return true;
    } catch (error) {
      await this.store.logEntry(task.id, `[recovery] bootstrap re-anchor failed; falling back to contamination safety path: ${formatError(error)}`, undefined, this.getRunContextFor(task.id));
      return false;
    }
  }

  private async reclaimExistingWorktree(
    task: Task,
    livePath: string,
    branch: string,
    tipSha: string,
    count: number,
  ): Promise<void> {
    await this.store.updateTask(task.id, { worktree: livePath, branch });
    const latestTask = await this.store.getTask(task.id);
    const baseRef = await this.resolveDiffBaseRef(livePath, latestTask.baseCommitSha);
    if (baseRef) {
      await assertCleanBranchAtBase(this.rootDir, branch, baseRef, task.id);
    }
    const message = `[recovery] reclaimed existing worktree for ${task.id} at ${livePath} (${count} commits preserved, tip ${tipSha.slice(0, 12)})`;
    await this.store.logEntry(task.id, message, undefined, this.getRunContextFor(task.id));
    await this.store.appendAgentLog(task.id, "Branch conflict auto-recovery", "text", message, "executor");
  }

  private async handleBranchConflict(task: Task, error: BranchConflictError): Promise<"retry" | "reclaimed" | "sticky"> {
    // FN-4811: Before invoking inspection-based recovery (which may force-remove the
    // conflicting worktree), verify the conflict isn't currently bound to a live session.
    // If it is, refuse the whole recovery dance — a force-remove here would yank an active
    // task's filesystem out from under it, producing FN-4781/FN-4804-style cascade failures.
    const activeOwner = await this.findActiveWorktreeOwner(error.conflictingWorktreePath, task.id);
    if (activeOwner !== null) {
      const refusalMessage = `[FN-4811] Branch conflict on ${error.branchName} deferred: conflicting worktree ${error.conflictingWorktreePath} is actively owned by ${activeOwner}`;
      executorLog.warn(refusalMessage);
      await this.store.logEntry(task.id, refusalMessage, undefined, this.getRunContextFor(task.id));
      return "sticky";
    }

    const integrationRef = task.mergeDetails?.mergeTargetBranch ?? task.baseBranch ?? task.executionStartBranch ?? await resolveIntegrationBranch(this.rootDir, undefined);
    const inspection = await inspectBranchConflict({
      repoDir: this.rootDir,
      branchName: error.branchName,
      conflictingWorktreePath: error.conflictingWorktreePath,
      requestingTaskId: task.id,
      ownerTaskId: task.id,
      startPoint: error.startPoint,
      integrationRef,
    });

    if (inspection.kind === "stale-resolved") {
      await this.store.updateTask(task.id, { worktree: null, branch: null, baseCommitSha: null });
      const message = `[recovery] ${task.id} stage-A: pruned stale admin entry for ${error.branchName}`;
      await this.store.logEntry(task.id, message, undefined, this.getRunContextFor(task.id));
      await this.store.appendAgentLog(task.id, "Branch conflict auto-recovery", "text", message, "executor");
      return "retry";
    }

    if (inspection.kind === "tip-already-merged") {
      if (inspection.livePath) {
        await this.cleanupConflictingWorktree(inspection.livePath, error.branchName, task.id);
      }
      try {
        await execAsync("git worktree prune", {
          cwd: this.rootDir,
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch {
        // best-effort
      }
      try {
        await execAsync(`git branch -D ${JSON.stringify(error.branchName)}`, {
          cwd: this.rootDir,
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch {
        // best-effort
      }
      await this.store.updateTask(task.id, { worktree: null, branch: null, baseCommitSha: null });
      const message = `[recovery] ${task.id} stage-A: tip-already-merged cleanup for ${error.branchName} (${inspection.tipSha.slice(0, 12)} on ${inspection.integrationRef})`;
      await this.store.logEntry(task.id, message, undefined, this.getRunContextFor(task.id));
      await this.store.appendAgentLog(task.id, "Branch conflict auto-recovery", "text", message, "executor");
      return "retry";
    }

    if (inspection.kind === "reclaimable") {
      await this.reclaimExistingWorktree(task, inspection.livePath, error.branchName, inspection.tipSha, inspection.taskAttributedCommitCount);
      return "reclaimed";
    }

    if (inspection.kind === "fully-subsumed") {
      await this.reclaimExistingWorktree(task, inspection.livePath, error.branchName, inspection.tipSha, 0);
      return "reclaimed";
    }

    if (inspection.kind === "live-foreign") {
      const cleanupSuccess = await this.cleanupConflictingWorktree(inspection.livePath, error.branchName, task.id);
      if (cleanupSuccess) {
        try {
          await execAsync("git worktree prune", { cwd: this.rootDir });
        } catch {
          // best-effort
        }
        try {
          const worktreeMap = await this.getWorktreeBranchMap();
          if (!worktreeMap.has(error.branchName)) {
            await execAsync(`git branch -D "${error.branchName}"`, { cwd: this.rootDir });
          }
        } catch {
          // best-effort
        }
        return "retry";
      }
    }

    const conflictMessage = `Task branch conflict: ${error.branchName} is already checked out at ${error.conflictingWorktreePath}. ` +
      `Resolve the local branch/worktree conflict with git tooling (inspect/reclaim or discard) before retrying.`;
    await this.store.logEntry(task.id, this.formatBranchConflictLifecycleLog(task.id, error), undefined, this.getRunContextFor(task.id));
    await this.store.appendAgentLog(task.id, "Branch conflict recovery required", "tool_error", this.formatBranchConflictAgentLog(task.id, error), "executor");
    const autoRecoveryDispatcher = this.getAutoRecoveryDispatcher(createRunAuditor(this.store, this.getRunContextFor(task.id)));
    const decision = await autoRecoveryDispatcher.dispatch({
      class: "branch-conflict-unrecoverable",
      taskId: task.id,
      runId: this.getRunContextFor(task.id)?.runId,
      pausedReason: "branch-conflict-unrecoverable",
      evidence: {
        branchName: error.branchName,
        conflictingWorktreePath: error.conflictingWorktreePath,
      },
      underlyingError: error,
    }, {
      task,
      retryCount: task.recoveryRetryCount ?? 0,
      settings: (await this.store.getSettings()).autoRecovery ?? { mode: "deterministic-only", maxRetries: 3 },
    });

    if (decision.action === "pause") {
      await this.store.updateTask(task.id, {
        status: "failed",
        error: conflictMessage,
        branch: error.branchName,
        worktree: error.conflictingWorktreePath,
        paused: true,
        pausedReason: "branch-conflict-unrecoverable",
      });
      await this.persistTokenUsage(task.id);
      executorLog.warn(`✗ ${task.id} branch conflict sticky failure: ${error.branchName} @ ${error.conflictingWorktreePath}`);
      this.options.onError?.(task, error);
      return "sticky";
    }

    return "retry";
  }

  private async createWorktree(
    branch: string,
    path: string,
    taskId: string,
    startPoint?: string,
    allowSiblingBranchRename = false,
  ): Promise<{ path: string; branch: string }> {
    // Track the worktree path we're attempting to use (may change during recovery)
    const currentPath = path;
    let resolvedStartPoint: string | undefined;
    if (startPoint) {
      const resolved = await this.resolveWorktreeStartPoint(startPoint, taskId);
      if (resolved === null) {
        // Stored baseBranch no longer exists (e.g., upstream dep merged and branch
        // deleted while this task sat queued/stuck). Clear it on the task so any
        // subsequent retry branches from the default base, and proceed from HEAD.
        await this.store.updateTask(taskId, { executionStartBranch: null });
      } else {
        resolvedStartPoint = resolved;
      }
    }

    // When the task declares a non-main base (a sibling task's branch), the
    // legacy behavior was to fork the worktree from that branch's tip,
    // inheriting all of its commits. That caused content leakage when the
    // dep was later squash-merged to main: the dep's raw commits became
    // orphans whose content already existed in main, blocking the
    // dependent's own merge with phantom conflicts.
    //
    // Prevention: instead of forking from the dep's tip, fork from `main`
    // (or the configured remote/main if rebase-from-remote is enabled) and
    // then `git merge --squash` the dep's content into a single import
    // commit. The dependent branch then carries main's history + 1 commit
    // for the dep's content; if the dep is later squash-merged to main, the
    // patch-id on that import commit will match main's squash and Layer 2
    // recovery (or a clean rebase) handles it.
    //
    // Fall-soft: any failure in this path falls back to the legacy behavior
    // so we don't break worktree creation for setups where the squash flow
    // can't run (no main branch resolvable, network down, etc.).
    const squashImport = resolvedStartPoint
      ? await this.planSquashImportFromDep(taskId, resolvedStartPoint, startPoint)
      : null;
    const initialStartPoint = squashImport ? squashImport.mainBase : resolvedStartPoint;
    const settings = await this.store.getSettings();

    for (let attempt = 0; attempt < this.MAX_WORKTREE_RETRIES; attempt++) {
      try {
        const result = await this.tryCreateWorktree(
          branch,
          currentPath,
          taskId,
          initialStartPoint,
          attempt,
          0,
          allowSiblingBranchRename,
          settings,
        );
        // Squash-import dep content into the freshly created worktree so the
        // branch contains main's history + 1 import commit instead of the
        // dep's raw commits.
        if (squashImport) {
          await this.squashImportDepIntoWorktree(
            result.path,
            taskId,
            squashImport.depTip,
            squashImport.label,
          ).catch((importErr: unknown) => {
            executorLog.warn(
              `Squash-import of ${squashImport.label} into ${result.branch} failed for ${taskId} (continuing without): ${importErr instanceof Error ? importErr.message : String(importErr)}`,
            );
          });
        }
        // Mirror the merge-time rebase behavior: when worktreeRebaseBeforeMerge
        // is enabled, fetch the remote and rebase the just-created task branch
        // onto the latest <remote>/<defaultBranch>. This makes the worktree
        // start from origin/main + local main both, so divergence only matters
        // if the user actively skips this setting. Best-effort: failures here
        // don't abort task setup.
        await this.rebaseNewWorktreeOntoRemote(result.path, result.branch, taskId).catch((err: unknown) => {
          executorLog.warn(
            `Post-create worktree rebase failed for ${taskId} (continuing): ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        return result;
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isLastAttempt = attempt === this.MAX_WORKTREE_RETRIES - 1;
        const isBranchConflict = isBranchConflictError(error);
        const isTerminalWorktreeError = error instanceof NonRetryableWorktreeError || error instanceof StaleWorktreeIndexLockError || isBranchConflict;

        if (isLastAttempt || isTerminalWorktreeError) {
          await this.store.logEntry(
            taskId,
            `Worktree creation failed after ${this.MAX_WORKTREE_RETRIES} attempts`,
            errorMessage,
          );
          if (isBranchConflict) {
            throw error;
          }
          throw new Error(
            `Failed to create worktree after ${this.MAX_WORKTREE_RETRIES} attempts: ${errorMessage}`,
          );
        }

        // Wait before retry (exponential backoff)
        const delay = this.WORKTREE_RETRY_DELAYS[attempt] || 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Should never reach here, but TypeScript needs a return
    throw new Error("Unexpected exit from worktree creation retry loop");
  }

  private quoteShellArg(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  /**
   * Decide whether a task's declared dep base should be squash-imported
   * (instead of forked from). Returns the planned operation's data when the
   * dep tip differs from the resolvable main base; returns null when no
   * import is needed (dep is already at main) or when no main base is
   * resolvable (caller falls back to legacy fork-from-dep).
   *
   * `originalStartPoint` is the user-facing label (typically the branch name
   * like `fusion/fn-2729`) used purely for log messages. `depTip` is the
   * resolved SHA of the dep's tip — that's what gets squash-merged.
   */
  private async planSquashImportFromDep(
    _taskId: string,
    depTip: string,
    originalStartPoint: string | undefined,
  ): Promise<{ depTip: string; mainBase: string; label: string } | null> {
    let settings;
    try {
      settings = await this.store.getSettings();
    } catch {
      return null;
    }

    // Resolve the main base. Preference order:
    //   1. <remote>/<defaultBranch> when worktreeRebaseBeforeMerge is enabled
    //      and a remote is resolvable (settings.worktreeRebaseRemote wins;
    //      otherwise fall back to "origin" or the lone remote).
    //   2. rootDir's HEAD (i.e., whatever local main is currently checked out
    //      to). Used when remote rebase is disabled or no remote exists.
    let mainBase = "";

    if (settings.worktreeRebaseBeforeMerge !== false) {
      let remote = settings.worktreeRebaseRemote?.trim() || "";
      if (!remote) {
        try {
          const { stdout } = await execAsync("git remote", { cwd: this.rootDir });
          const remotes = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
          if (remotes.includes("origin")) remote = "origin";
          else if (remotes.length === 1) remote = remotes[0];
        } catch {
          // No remote resolvable.
        }
      }
      if (remote) {
        let defaultBranch = "";
        try {
          const { stdout } = await execAsync(
            `git rev-parse --abbrev-ref ${this.quoteShellArg(remote)}/HEAD`,
            { cwd: this.rootDir },
          );
          defaultBranch = stdout.trim().replace(new RegExp(`^${remote}/`), "");
        } catch {
          // origin/HEAD not set; will fall through to local HEAD below.
        }
        if (defaultBranch && defaultBranch !== "HEAD") {
          // Fetch best-effort so the remote ref reflects upstream tip.
          await execAsync(
            `git fetch ${this.quoteShellArg(remote)} ${this.quoteShellArg(defaultBranch)}`,
            { cwd: this.rootDir },
          ).catch(() => undefined);
          try {
            const { stdout } = await execAsync(
              `git rev-parse --verify "${remote}/${defaultBranch}^{commit}"`,
              { cwd: this.rootDir, encoding: "utf-8" },
            );
            mainBase = stdout.trim();
          } catch {
            // Couldn't resolve remote ref — fall through.
          }
        }
      }
    }

    if (!mainBase) {
      try {
        const { stdout } = await execAsync("git rev-parse HEAD", {
          cwd: this.rootDir,
          encoding: "utf-8",
        });
        mainBase = stdout.trim();
      } catch {
        return null;
      }
    }
    if (!mainBase) return null;

    // If the dep tip is already an ancestor of main, no squash import is
    // needed — the dep's content is already represented in main.
    try {
      await execAsync(
        `git merge-base --is-ancestor ${this.quoteShellArg(depTip)} ${this.quoteShellArg(mainBase)}`,
        { cwd: this.rootDir },
      );
      // Exit code 0 → ancestor → no import needed; legacy fork-from-main is fine.
      // Returning the plan with mainBase but signalling "no work" via dep===main.
      if (depTip === mainBase) return null;
      // Dep is ancestor of main but its tip SHA differs from main's tip; the
      // worktree should still branch off main, no squash needed.
      return { depTip: mainBase, mainBase, label: originalStartPoint || depTip.slice(0, 8) };
    } catch {
      // Not an ancestor — squash-import is the safer path.
    }

    return { depTip, mainBase, label: originalStartPoint || depTip.slice(0, 8) };
  }

  /**
   * Squash-merge the dep's content into a worktree that's already branched
   * off main. Produces one commit on the worktree branch carrying the dep's
   * content, instead of inheriting the dep's individual commits. Best-effort:
   * any failure (conflict, hooks, IO) leaves the worktree at main and the
   * caller proceeds — the dependent task will then need to import the dep's
   * content itself, but the worktree itself is still usable.
   */
  private async squashImportDepIntoWorktree(
    worktreePath: string,
    taskId: string,
    depTip: string,
    label: string,
  ): Promise<void> {
    // No-op when dep is already represented in the worktree's history.
    try {
      await execAsync(
        `git merge-base --is-ancestor ${this.quoteShellArg(depTip)} HEAD`,
        { cwd: worktreePath },
      );
      return;
    } catch {
      // Not an ancestor — proceed.
    }

    // Try a squash-merge. `--no-commit` is implied by `--squash`; the merge
    // either stages the dep's diff or fails (conflicts / unrelated histories).
    try {
      await execAsync(
        `git merge --squash --allow-unrelated-histories ${this.quoteShellArg(depTip)}`,
        { cwd: worktreePath },
      );
    } catch (err) {
      // Reset any partial state so the worktree stays usable, then rethrow
      // so the caller can decide whether to log/fall-through.
      await execAsync("git reset --hard HEAD", { cwd: worktreePath }).catch(
        () => undefined,
      );
      throw err;
    }

    // If no diff was staged the dep is content-equivalent to main; nothing
    // to commit.
    try {
      await execAsync("git diff --cached --quiet", { cwd: worktreePath });
      return; // exit 0 → no staged changes, nothing to commit
    } catch {
      // exit non-zero → staged changes exist, proceed to commit.
    }

    // Always non-empty (subject + body via two -m args). Drop
    // --allow-empty-message: we never want git to silently accept an empty
    // message — a missing message here would make the commit hard to
    // attribute / explain in `git log` and break downstream consumers that
    // parse merge metadata from commit messages.
    const subject = `chore(${taskId}): import dependency content from ${label}`;
    const body =
      `Squash-imported the working tree of ${label} as a single commit so this ` +
      `branch carries the dep's content without inheriting its individual commits. ` +
      `If the dep is later squash-merged to main, this commit's patch-id should ` +
      `match the merge and rebase cleanly.`;
    try {
      await execAsync(
        `git commit -m ${this.quoteShellArg(subject)} -m ${this.quoteShellArg(body)}`,
        { cwd: worktreePath },
      );
    } catch (commitErr) {
      await execAsync("git reset --hard HEAD", { cwd: worktreePath }).catch(
        () => undefined,
      );
      throw commitErr;
    }

    await this.store.logEntry(
      taskId,
      `Squash-imported dependency content from ${label} into worktree (single import commit instead of inheriting raw commits)`,
    );
  }

  /**
   * After creating a fresh task worktree, fetch the configured remote and
   * rebase the task branch onto `<remote>/<defaultBranch>`. The result is a
   * branch that contains origin's tip plus any local main commits, so the
   * eventual merge has fewer surprises and the executor sees the freshest
   * code its peers/CI may have published.
   *
   * No-op when `worktreeRebaseBeforeMerge` is disabled, no remote is
   * configured/resolvable, or the rebase produces conflicts (we abort and
   * leave the worktree as-is so the executor can still run).
   */
  private async rebaseNewWorktreeOntoRemote(
    worktreePath: string,
    branch: string,
    taskId: string,
  ): Promise<void> {
    let settings;
    try {
      settings = await this.store.getSettings();
    } catch {
      return;
    }
    if (settings.worktreeRebaseBeforeMerge === false) return;

    let remote = settings.worktreeRebaseRemote?.trim() || "";
    if (!remote) {
      try {
        const { stdout } = await execAsync("git remote", { cwd: this.rootDir });
        const remotes = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
        if (remotes.includes("origin")) remote = "origin";
        else if (remotes.length === 1) remote = remotes[0];
      } catch {
        // No remote resolvable — nothing to rebase against.
      }
    }
    if (!remote) return;

    let defaultBranch = "";
    try {
      const { stdout } = await execAsync(`git rev-parse --abbrev-ref ${remote}/HEAD`, { cwd: this.rootDir });
      defaultBranch = stdout.trim().replace(new RegExp(`^${remote}/`), "");
    } catch {
      // origin/HEAD not set — fall back to current branch in rootDir.
    }
    if (!defaultBranch) {
      try {
        const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: this.rootDir });
        defaultBranch = stdout.trim();
      } catch {
        return;
      }
    }
    if (!defaultBranch || defaultBranch === "HEAD") return;

    const remoteRef = `${remote}/${defaultBranch}`;

    try {
      await execAsync(`git fetch ${this.quoteShellArg(remote)} ${this.quoteShellArg(defaultBranch)}`, { cwd: this.rootDir });
    } catch (err) {
      executorLog.warn(
        `Worktree rebase: fetch ${remote} ${defaultBranch} failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    try {
      await execAsync(`git rebase ${this.quoteShellArg(remoteRef)}`, { cwd: worktreePath });
      await this.store.logEntry(
        taskId,
        `Rebased new worktree branch ${branch} onto ${remoteRef}`,
      );
    } catch (rebaseErr) {
      const msg = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
      executorLog.warn(
        `Worktree rebase: rebase onto ${remoteRef} failed for ${taskId} — aborting and leaving local base intact: ${msg}`,
      );
      try {
        await execAsync("git rebase --abort", { cwd: worktreePath });
      } catch {
        // best-effort
      }
      await this.store.logEntry(
        taskId,
        `Could not rebase new worktree onto ${remoteRef} — kept local base. The merge-time rebase will retry with conflict resolution.`,
      );
    }
  }

  /**
   * Resolve a stored baseBranch to a concrete commit SHA.
   *
   * Returns `null` (not throw) when the ref cannot be resolved — typically
   * because the upstream dep's branch was merged and deleted while this task
   * sat queued/stuck. Callers should treat null as "fall back to default base"
   * rather than fail the task permanently.
   */
  private async resolveWorktreeStartPoint(startPoint: string, taskId: string): Promise<string | null> {
    const command = isAbsolute(startPoint) && existsSync(startPoint)
      ? `git -C "${startPoint}" rev-parse --verify HEAD^{commit}`
      : `git rev-parse --verify "${startPoint}^{commit}"`;

    try {
      const { stdout } = await execAsync(command, { cwd: this.rootDir });
      return stdout.trim() || startPoint;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.store.logEntry(
        taskId,
        `Worktree base ref "${startPoint}" is missing — falling back to default base`,
        errorMessage,
      );
      return null;
    }
  }

  private async recoverMissingWorktreeSessionStartFailure(
    task: Task,
    worktreePath: string,
    error: unknown,
    audit: RunAuditor,
  ): Promise<boolean> {
    const errorText = error instanceof Error ? error.message : String(error);
    const missingWorktreeFailure = isMissingWorktreeSessionStartFailure(errorText);
    const missingTaskJsonFailure = isTransientMissingTaskJsonError(error, task);
    if (!missingWorktreeFailure && !missingTaskJsonFailure) return false;

    const classification = classifyMissingWorktreeSessionStartFailure(errorText);
    const missingTaskJsonPath = errorText.match(TRANSIENT_WORKTREE_TASK_JSON_ENOENT_PATTERN)?.[1] ?? null;
    const staleWorktreePath = extractMissingWorktreePathFromSessionStartFailure(errorText)
      ?? (missingTaskJsonPath ? resolvePath(missingTaskJsonPath, "..", "..", "..") : null)
      ?? worktreePath;

    if (missingTaskJsonFailure) {
      executorLog.log(`[transient-task-json-suppressed] taskId=${task.id} elapsedMs=0 reason=missing-task-json-under-worktree path=${missingTaskJsonPath ?? "unknown"}`);
    }

    await audit.git({
      type: "worktree:incomplete-detected",
      target: staleWorktreePath,
      metadata: { classification, reason: errorText, source: "session-start", taskId: task.id },
    });

    if (isInsideWorktreesDir(this.rootDir, staleWorktreePath)) {
      try {
        await removeWorktree({
          rootDir: this.rootDir,
          worktreePath: staleWorktreePath,
          settings: await this.store.getSettings(),
          reason: RemovalReason.PoolPrune,
          taskId: task.id,
          audit,
          expectedOwnerTaskId: task.id,
          liveOwnerProbe: (path, ownerTaskId) => this.hasActiveWorktreeBinding(ownerTaskId, path),
        });
      } catch (removeErr) {
        executorLog.warn(`${task.id}: failed to remove unusable session-start worktree ${staleWorktreePath}: ${formatError(removeErr)}`);
      }
    }

    const recovery = await autoRecoverWorktreeSessionStartFailure(this.store, task, {
      failure: error,
      source: "executor-session-start",
      auditor: audit,
    });

    await audit.git({
      type: "worktree:auto-recovered",
      target: staleWorktreePath,
      metadata: {
        classification: recovery.classification,
        action: recovery.outcome === "escalate-exhausted" ? "escalate-exhausted" : "requeue-todo",
        retries: recovery.retries,
        maxRetries: MAX_WORKTREE_SESSION_RETRIES,
        staleWorktree: staleWorktreePath,
        taskId: task.id,
      },
    });

    if (recovery.outcome === "escalate-exhausted") {
      await this.store.logEntry(
        task.id,
        `Worktree session-start auto-recovery exhausted (${recovery.retries}/${MAX_WORKTREE_SESSION_RETRIES}); task left for human inspection`,
        undefined,
        this.getRunContextFor(task.id),
      );
    } else {
      await this.store.logEntry(
        task.id,
        `Worktree was ${classification} at session start; requeued to todo for clean retry (attempt ${recovery.retries}/${MAX_WORKTREE_SESSION_RETRIES})`,
        undefined,
        this.getRunContextFor(task.id),
      );
    }
    return true;
  }

  private async emitWorktreeReanchoredAudit(
    taskId: string,
    fromPath: string,
    toPath: string,
    source: "verify-worktree-invariants" | "executor-liveness-gate",
  ): Promise<void> {
    const runContext = this.getRunContextFor(taskId);
    if (!runContext?.runId || !runContext.agentId) return;
    const auditor = createRunAuditor(this.store, {
      runId: runContext.runId,
      agentId: runContext.agentId,
      taskId,
      phase: "execute",
    });
    await auditor.git({
      type: "worktree:reanchored",
      target: toPath,
      metadata: {
        taskId,
        fromPath,
        toPath,
        source,
      },
    });
  }

  private async emitStaleLockAudit(
    taskId: string,
    event:
      | "worktree:stale-lock-detected"
      | "worktree:stale-lock-recovered"
      | "worktree:stale-lock-recovery-failed"
      | "worktree:stale-lock-refused"
      | "worktree:stale-registration-detected"
      | "worktree:stale-registration-recovered"
      | "worktree:stale-registration-recovery-failed",
    targetPath: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const runContext = this.getRunContextFor(taskId);
    if (!runContext?.runId || !runContext.agentId) return;
    const auditor = createRunAuditor(this.store, {
      runId: runContext.runId,
      agentId: runContext.agentId,
      taskId,
      phase: "execute",
    });
    await auditor.git({ type: event, target: targetPath, metadata });
  }

  private async recoverIndexLockIfStale(taskId: string, path: string, conflictInfo: { lockPath?: string; message?: string }): Promise<boolean> {
    const lockPath = conflictInfo.lockPath;
    if (!lockPath) return false;

    const classification = await classifyStaleLock({
      rootDir: this.rootDir,
      lockPath,
      activeSessionRegistry,
    });
    await this.emitStaleLockAudit(taskId, "worktree:stale-lock-detected", path, {
      lockPath,
      classification: classification.kind,
      reason: classification.reason,
      ageMs: classification.ageMs ?? null,
      owningWorktreePath: classification.owningWorktreePath ?? null,
    });

    if (classification.kind !== "stale") {
      await this.emitStaleLockAudit(taskId, "worktree:stale-lock-refused", path, {
        lockPath,
        classification: classification.kind,
        reason: classification.reason,
        ageMs: classification.ageMs ?? null,
        owningWorktreePath: classification.owningWorktreePath ?? null,
      });
      throw new StaleWorktreeIndexLockError({
        message: `Worktree creation blocked: index.lock at ${resolvePath(this.rootDir, lockPath)} is held by another git process (reason: ${classification.reason}, owning worktree ${classification.owningWorktreePath ?? "unknown"}). Resolve manually before retrying.`,
        lockPath: resolvePath(this.rootDir, lockPath),
        classification: classification.kind,
        reason: classification.reason,
      });
    }

    try {
      const removed = await tryRemoveStaleLock({ lockPath: resolvePath(this.rootDir, lockPath) });
      if (removed.removed) {
        await this.emitStaleLockAudit(taskId, "worktree:stale-lock-recovered", path, { lockPath });
        await this.store.logEntry(taskId, `Recovered stale worktree index.lock and retrying`, resolvePath(this.rootDir, lockPath), this.getRunContextFor(taskId));
        return true;
      }
      await this.emitStaleLockAudit(taskId, "worktree:stale-lock-recovery-failed", path, {
        lockPath,
        reason: removed.reason ?? "not-removed",
      });
      return false;
    } catch (error) {
      await this.emitStaleLockAudit(taskId, "worktree:stale-lock-recovery-failed", path, {
        lockPath,
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Single attempt to create a worktree with conflict detection and recovery.
   * Returns the actual worktree path used (may differ from input if recovery generated new name).
   */
  private async recoverStaleRegistration(taskId: string, path: string, conflictInfo: { path?: string; message?: string }): Promise<boolean> {
    const staleRegistrationPath = conflictInfo.path ?? path;
    await this.emitStaleLockAudit(taskId, "worktree:stale-registration-detected", path, {
      staleRegistrationPath,
      worktreePath: path,
    });

    const recovery = await recoverStaleRegistration({
      rootDir: this.rootDir,
      worktreePath: path,
      logger: executorLog,
    });

    if (recovery.recovered) {
      await this.emitStaleLockAudit(taskId, "worktree:stale-registration-recovered", path, {
        actions: recovery.actions,
      });
      await this.store.logEntry(taskId, "Recovered stale worktree registration and retrying", staleRegistrationPath, this.getRunContextFor(taskId));
      return true;
    }

    await this.emitStaleLockAudit(taskId, "worktree:stale-registration-recovery-failed", path, {
      actions: recovery.actions,
      reason: recovery.reason ?? "unknown",
    });
    return false;
  }

  private async tryCreateWorktree(
    branch: string,
    path: string,
    taskId: string,
    startPoint?: string,
    attemptNumber = 0,
    recoveryDepth = 0,
    allowSiblingBranchRename = false,
    settings: Partial<Settings> = {},
  ): Promise<{ path: string; branch: string }> {
    // Guard: refuse to create a worktree nested inside another worktree.
    // Nested worktrees happen when the executor is launched with rootDir pointed
    // at a worktree directory instead of the main repo — produces paths like
    // `.worktrees/green-finch/.worktrees/amber-panda` that bloat the filesystem
    // and confuse every tool that walks git state.
    await this.assertWorktreePathNotNested(path, taskId);

    const installGuardOrCleanup = async () => {
      try {
        await installTaskWorktreeIdentityGuard({
          worktreePath: path,
          taskId,
          commitMsgHookEnabled: settings.commitMsgHookEnabled,
          taskPrefix: settings.taskPrefix,
          taskAttributionTrailerName: settings.taskAttributionTrailerNames?.[0],
        });
      } catch (error) {
        try {
          await rm(path, { recursive: true, force: true });
        } catch {
          executorLog.log(`Warning: failed to remove worktree after identity-guard install failure: ${path}`);
        }
        throw error;
      }
    };

    // If directory exists but is not a registered worktree, remove it first
    if (existsSync(path)) {
      const isRegistered = await this.isRegisteredWorktree(path);
      if (!isRegistered) {
        await this.store.logEntry(
          taskId,
          `Removing existing directory (not a registered worktree): ${path}`,
        );
        try {
          await rm(path, { recursive: true, force: true });
        } catch (e: unknown) {
          const eMessage = e instanceof Error ? e.message : String(e);
          throw new Error(`Failed to remove existing directory ${path}: ${eMessage}`);
        }
      } else {
        executorLog.log(`Worktree already exists: ${path}`);
        await installGuardOrCleanup();
        return { path, branch };
      }
    }

    const createWithBranch = async (branchToCreate: string) => {
      const cmd = startPoint
        ? `git worktree add -b "${branchToCreate}" "${path}" "${startPoint}"`
        : `git worktree add -b "${branchToCreate}" "${path}"`;
      try {
        await execAsync(cmd, { cwd: this.rootDir });
      } catch (err) {
        // Remove any partial directory left behind so the invariant holds:
        // "if .worktrees/<slug> exists on disk, it is a fully registered git worktree."
        try {
          await rm(path, { recursive: true, force: true });
        } catch {
          // best-effort cleanup; log but don't mask the original error
          executorLog.log(`Warning: failed to remove partial worktree directory after creation failure: ${path}`);
        }
        throw err;
      }
    };

    const createFromExistingBranch = async () => {
      try {
        await execAsync(`git worktree add "${path}" "${branch}"`, { cwd: this.rootDir });
      } catch (err) {
        // Remove any partial directory left behind so the invariant holds:
        // "if .worktrees/<slug> exists on disk, it is a fully registered git worktree."
        try {
          await rm(path, { recursive: true, force: true });
        } catch {
          // best-effort cleanup; log but don't mask the original error
          executorLog.log(`Warning: failed to remove partial worktree directory after creation failure: ${path}`);
        }
        throw err;
      }
    };

    let staleLockRecoveryAttempted = false;
    let staleRegistrationRecoveryAttempted = false;
    try {
      await createWithBranch(branch);
      executorLog.log(`Worktree created: ${path}${startPoint ? ` (from ${startPoint})` : ""}`);
      if (attemptNumber > 0) {
        await this.store.logEntry(taskId, `Worktree created on attempt ${attemptNumber + 1}`, path);
      }
      await installGuardOrCleanup();
      return { path, branch };
    } catch (initialError: unknown) {
      const conflictInfo = this.extractWorktreeConflictInfo(initialError);

      if (conflictInfo.type === "index-lock-contention" && !staleLockRecoveryAttempted) {
        staleLockRecoveryAttempted = true;
        const recovered = await this.recoverIndexLockIfStale(taskId, path, conflictInfo);
        if (recovered) {
          await createWithBranch(branch);
          executorLog.log(`Worktree created after stale lock recovery: ${path}`);
          await installGuardOrCleanup();
          return { path, branch };
        }
      }

      if (conflictInfo.type === "stale-registration" && !staleRegistrationRecoveryAttempted) {
        staleRegistrationRecoveryAttempted = true;
        const recovered = await this.recoverStaleRegistration(taskId, path, conflictInfo);
        if (recovered) {
          await createWithBranch(branch);
          executorLog.log(`Worktree created after stale registration recovery: ${path}`);
          await installGuardOrCleanup();
          return { path, branch };
        }
      }

      if (conflictInfo.type === "not-git-repo") {
        throw new NonRetryableWorktreeError(
          "Project directory is not a Git repository. Fusion requires a Git repository for worktree creation. Initialize with 'git init' or run from a Git project directory.",
        );
      }

      // Handle "already used by worktree" conflict
      if (conflictInfo.type === "already-used" && conflictInfo.path) {
        const result = await this.handleWorktreeConflict(
          conflictInfo.path,
          branch,
          path,
          taskId,
          startPoint,
          attemptNumber,
          allowSiblingBranchRename,
          settings,
        );
        if (result) {
          return result;
        }
        throw new Error(
          `Worktree conflict at ${conflictInfo.path}: automatic cleanup failed`,
        );
      }

      // Handle "invalid reference" - stale branch that doesn't exist
      if (conflictInfo.type === "invalid-reference") {
        if (recoveryDepth >= this.MAX_WORKTREE_RETRIES - 1) {
          throw new NonRetryableWorktreeError(
            `Stale branch reference for ${branch} remained invalid after ${this.MAX_WORKTREE_RETRIES} cleanup attempts`,
          );
        }
        const branchCleaned = await this.cleanupStaleBranch(branch, taskId);
        if (branchCleaned) {
          await this.store.logEntry(taskId, `Removed stale branch reference, retrying`);
          return this.tryCreateWorktree(branch, path, taskId, startPoint, attemptNumber, recoveryDepth + 1, allowSiblingBranchRename, settings);
        }
        throw new Error(
          `Invalid reference for branch ${branch}: unable to clean up stale reference`,
        );
      }

      // Handle "could not create leading directories" - permission/path issues
      if (conflictInfo.type === "leading-directories") {
        throw new Error(
          `Cannot create worktree at ${path}: permission or path issue. ` +
          `Check that parent directories are writable.`,
        );
      }

      // Try creating from existing branch (branch might already exist)
      try {
        await createFromExistingBranch();
        executorLog.log(`Worktree created from existing branch: ${path}`);
        await installGuardOrCleanup();
        return { path, branch };
      } catch (fallbackError: unknown) {
        const fallbackErrorMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        // Check if the fallback also hit an "already used" conflict
        const fallbackConflictInfo = this.extractWorktreeConflictInfo(fallbackError);
        if (fallbackConflictInfo.type === "index-lock-contention" && !staleLockRecoveryAttempted) {
          staleLockRecoveryAttempted = true;
          const recovered = await this.recoverIndexLockIfStale(taskId, path, fallbackConflictInfo);
          if (recovered) {
            await createFromExistingBranch();
            executorLog.log(`Worktree created from existing branch after stale lock recovery: ${path}`);
            await installGuardOrCleanup();
            return { path, branch };
          }
        }

        if (fallbackConflictInfo.type === "stale-registration" && !staleRegistrationRecoveryAttempted) {
          staleRegistrationRecoveryAttempted = true;
          const recovered = await this.recoverStaleRegistration(taskId, path, fallbackConflictInfo);
          if (recovered) {
            await createFromExistingBranch();
            executorLog.log(`Worktree created from existing branch after stale registration recovery: ${path}`);
            await installGuardOrCleanup();
            return { path, branch };
          }
        }

        if (fallbackConflictInfo.type === "not-git-repo") {
          throw new NonRetryableWorktreeError(
            "Project directory is not a Git repository. Fusion requires a Git repository for worktree creation. Initialize with 'git init' or run from a Git project directory.",
          );
        }

        if (fallbackConflictInfo.type === "already-used" && fallbackConflictInfo.path) {
          const result = await this.handleWorktreeConflict(
            fallbackConflictInfo.path,
            branch,
            path,
            taskId,
            startPoint,
            attemptNumber,
            allowSiblingBranchRename,
            settings,
          );
          if (result) {
            return result;
          }
          throw new Error(
            `Worktree conflict at ${fallbackConflictInfo.path}: automatic cleanup failed`,
          );
        }

        // Handle stale reference in fallback path too
        if (fallbackConflictInfo.type === "invalid-reference") {
          if (recoveryDepth >= this.MAX_WORKTREE_RETRIES - 1) {
            throw new NonRetryableWorktreeError(
              `Stale branch reference for ${branch} remained invalid after ${this.MAX_WORKTREE_RETRIES} cleanup attempts`,
            );
          }
          const branchCleaned = await this.cleanupStaleBranch(branch, taskId);
          if (branchCleaned) {
            await this.store.logEntry(taskId, `Cleaned up stale reference in fallback, retrying`);
            return this.tryCreateWorktree(branch, path, taskId, startPoint, attemptNumber, recoveryDepth + 1, allowSiblingBranchRename, settings);
          }
        }

        throw new Error(`Failed to create worktree: ${fallbackErrorMessage}`);
      }
    }
  }

  /**
   * Handle "already used by worktree" conflict.
   * Either generates a new worktree name (if conflicting worktree is in use by active task)
   * or cleans up the conflicting worktree and retries.
   * 
   * @returns The worktree path if recovery succeeded, null if recovery failed
   */
  private async handleWorktreeConflict(
    conflictPath: string,
    branch: string,
    path: string,
    taskId: string,
    startPoint?: string,
    attemptNumber?: number,
    allowSiblingBranchRename = false,
    settings: Partial<Settings> = {},
  ): Promise<{ path: string; branch: string } | null> {
    const shouldGenerateNewName = await this.shouldGenerateNewWorktreeName(
      conflictPath,
      taskId,
    );

    if (shouldGenerateNewName) {
      const inspection = await inspectBranchConflict({
        repoDir: this.rootDir,
        branchName: branch,
        conflictingWorktreePath: conflictPath,
        requestingTaskId: taskId,
        ownerTaskId: taskId,
        startPoint,
        integrationRef: await resolveIntegrationBranch(this.rootDir, settings),
      });

      if (inspection.kind === "stale" || inspection.kind === "stale-resolved" || inspection.kind === "tip-already-merged") {
        const cleanupSuccess = await this.cleanupConflictingWorktree(conflictPath, branch, taskId);
        if (cleanupSuccess) {
          await this.store.logEntry(taskId, `Cleaned up conflicting worktree, retrying`, path);
          return this.tryCreateWorktree(branch, path, taskId, startPoint, attemptNumber, 0, allowSiblingBranchRename, settings);
        }
        // FN-4811: When git classifies a worktree as stale but the DB liveness gate refuses
        // removal (an active task still has this worktree bound), fall through to the
        // sibling-rename path rather than failing the whole conflict-recovery attempt. This
        // preserves the live task while letting the requesting task proceed with a fresh
        // worktree name.
      }

      if (inspection.kind === "reclaimable") {
        await this.store.logEntry(
          taskId,
          `[recovery] reclaimed existing worktree for ${taskId} at ${inspection.livePath} (${inspection.taskAttributedCommitCount} commits preserved)`,
          inspection.tipSha,
        );
        return { path: inspection.livePath, branch };
      }

      if (inspection.kind === "fully-subsumed") {
        await this.store.logEntry(
          taskId,
          `[recovery] reclaimed existing worktree for ${taskId} at ${inspection.livePath} (0 commits preserved)`,
          inspection.tipSha,
        );
        return { path: inspection.livePath, branch };
      }

      if (inspection.kind === "live-foreign") {
        const cleanupSuccess = await this.cleanupConflictingWorktree(inspection.livePath, branch, taskId);
        if (cleanupSuccess) {
          await this.store.logEntry(taskId, `Removed foreign conflicting worktree and retrying`, inspection.livePath);
          return this.tryCreateWorktree(branch, path, taskId, startPoint, attemptNumber, 0, allowSiblingBranchRename, settings);
        }
        // FN-4811: Cleanup was refused because the foreign worktree is actively bound to a
        // live session. Force-removing would yank an active task's filesystem. Fall through
        // to the sibling-rename path (suffix-2 through suffix-6) so the requesting task can
        // proceed without disturbing the live owner. If sibling-rename is disabled, the
        // generic conflict error below will trigger the caller's auto-recovery dispatcher.
      }

      if (!allowSiblingBranchRename) {
        throw new Error(`Branch ${branch} conflict could not be auto-resolved`);
      }

      const conflictStartPoint = branch;
      const newPath = resolveTaskWorktreePath(this.rootDir, settings, generateWorktreeName(this.rootDir, settings));
      for (let suffix = 2; suffix <= 6; suffix++) {
        const suffixedBranch = `${branch}-${suffix}`;
        try {
          await this.store.logEntry(
            taskId,
            `Conflicting worktree in use by active task, trying new path with branch ${suffixedBranch}`,
            newPath,
          );
          return await this.tryCreateWorktree(suffixedBranch, newPath, taskId, conflictStartPoint, attemptNumber, 0, true, settings);
        } catch (suffixErr: unknown) {
          const info = this.extractWorktreeConflictInfo(suffixErr);
          if (info.type === "already-used") {
            continue;
          }
          throw suffixErr;
        }
      }
      throw new Error(
        `Cannot create branch for task: "${branch}" and suffixes -2 through -6 are all in use by other worktrees`,
      );
    }

    const cleanupSuccess = await this.cleanupConflictingWorktree(conflictPath, branch, taskId);
    if (cleanupSuccess) {
      await this.store.logEntry(taskId, `Cleaned up conflicting worktree, retrying`, path);
      return this.tryCreateWorktree(branch, path, taskId, startPoint, attemptNumber, 0, allowSiblingBranchRename, settings);
    }

    return null;
  }

  /**
   * Check if a path is registered as a git worktree.
   */
  private async isRegisteredWorktree(path: string): Promise<boolean> {
    return isRegisteredGitWorktree(this.rootDir, path);
  }

  /**
   * Throw if `path` lies inside an existing registered worktree other than the
   * repo root. The repo root itself is a worktree (main branch) and must be
   * allowed — we only reject paths strictly *inside* a non-root worktree.
   */
  private async assertWorktreePathNotNested(path: string, taskId: string): Promise<void> {
    const target = resolvePath(path);
    const rootResolved = resolvePath(this.rootDir);
    const registered = await getRegisteredWorktreePaths(this.rootDir);

    for (const wt of registered) {
      if (wt === rootResolved) continue; // root is allowed as ancestor
      if (wt === target) continue; // exact match handled later as "already registered"
      const rel = relative(wt, target);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
        await this.store.logEntry(
          taskId,
          `Refusing to create nested worktree`,
          `target ${target} is inside registered worktree ${wt}`,
        );
        throw new NonRetryableWorktreeError(
          `Refusing to create worktree at ${target}: path is nested inside existing worktree ${wt}. ` +
          `This usually means the executor was launched with rootDir pointing at a worktree instead of the main repo.`,
        );
      }
    }
  }

  /**
   * Determine if we should generate a new worktree name instead of cleaning up.
   * Returns true if the conflicting worktree is used by an active task.
   */
  private async getWorktreeBranchMap(): Promise<Map<string, string>> {
    const { stdout } = await execAsync("git worktree list --porcelain", { cwd: this.rootDir, encoding: "utf-8" });
    const map = new Map<string, string>();
    let currentWorktree: string | null = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentWorktree = line.slice("worktree ".length).trim();
      } else if (line.startsWith("branch refs/heads/") && currentWorktree) {
        map.set(line.slice("branch refs/heads/".length).trim(), currentWorktree);
      } else if (!line.trim()) {
        currentWorktree = null;
      }
    }
    return map;
  }

  private async shouldGenerateNewWorktreeName(
    conflictPath: string,
    currentTaskId: string,
  ): Promise<boolean> {
    // Check if conflicting worktree is in our active set
    for (const [taskId, worktreePath] of this.activeWorktrees) {
      if (taskId !== currentTaskId && worktreePath === conflictPath) {
        return true;
      }
    }

    // Check if another non-done task uses this worktree
    const otherUser = await findWorktreeUser(this.store, conflictPath, currentTaskId);
    return otherUser !== null;
  }

  /**
   * FN-4811: Determine whether `worktreePath` is currently bound to an active executor or
   * merger session. If so, removing it would pull the rug out from under a live agent,
   * producing the FN-4781/FN-4804 symptoms (worktree disappears mid-task, two parallel runs,
   * cross-task contamination). Returns the task ID currently using the worktree, or null if
   * the worktree is safe to remove.
   *
   * Liveness sources, in order:
   *  1. In-memory `activeWorktrees` map (per-executor session tracking).
   *  2. DB-level: any non-done, non-paused, in-progress task with `task.worktree === path`.
   *
   * The requesting task is excluded from the check because `cleanupConflictingWorktree` is
   * only called for worktrees the requesting task is trying to displace.
   */
  private async findActiveWorktreeOwner(
    worktreePath: string,
    requestingTaskId: string,
  ): Promise<string | null> {
    for (const [taskId, path] of this.activeWorktrees) {
      if (taskId !== requestingTaskId && path === worktreePath) {
        return taskId;
      }
    }
    try {
      const tasks = await this.store.listTasks({ slim: true, includeArchived: false });
      for (const t of tasks) {
        if (t.id === requestingTaskId) continue;
        if (t.worktree !== worktreePath) continue;
        if (t.column !== "in-progress") continue;
        if (t.paused === true) continue;
        return t.id;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`findActiveWorktreeOwner: DB liveness check failed for ${worktreePath}: ${msg}`);
    }
    return null;
  }

  /**
   * Clean up a conflicting worktree and its branch.
   * Handles locked worktrees by unlocking first.
   * Returns true if cleanup succeeded.
   */
  private hasActiveWorktreeBinding(taskId: string, worktreePath: string): boolean {
    for (const [activeTaskId, activePath] of this.activeWorktrees) {
      if (activeTaskId === taskId && activePath === worktreePath) {
        return true;
      }
    }
    return false;
  }

  private async reconcileSelfOwnedBeforeRemove(worktreePath: string, taskId: string): Promise<void> {
    const outcome = reconcileSelfOwnedActiveSessionForRemoval(
      activeSessionRegistry,
      worktreePath,
      taskId,
      (path, ownerTaskId) => this.hasActiveWorktreeBinding(ownerTaskId, path),
      {
        processActiveProbe: (probeTaskId) => executingTaskLock.has(probeTaskId),
      },
    );
    if (outcome.action === "reconciled") {
      executorLog.warn(
        `[FN-5346] ${taskId}: dropped stale self-owned activeSessionRegistry entry before removeWorktree at ${worktreePath}`,
      );
      await this.store.logEntry(taskId, "Cleared stale self-owned active-session entry before remove", worktreePath);
    } else if (outcome.action === "process-active-refuses") {
      executorLog.warn(
        `[FN-5256] refused stale-self-owned reconcile for ${taskId}: process-active=true at ${worktreePath}`,
      );
      await this.store.logEntry(
        taskId,
        "Refused stale self-owned reconcile — task still actively executing",
        worktreePath,
      ).catch(() => undefined);
    } else if (outcome.action === "too-recent-refuses") {
      executorLog.warn(
        `[FN-5256] refused stale-self-owned reconcile for ${taskId}: age=${outcome.ageMs}ms (<${outcome.minIdleMs}ms) at ${worktreePath}`,
      );
      await this.store.logEntry(
        taskId,
        `Refused stale self-owned reconcile — registration too recent (${outcome.ageMs}ms < ${outcome.minIdleMs}ms)`,
        worktreePath,
      ).catch(() => undefined);
    }
  }

  private async removeOwnWorktreeWithReconcile(input: {
    worktreePath: string;
    settings: Settings;
    taskId: string;
    reason: RemovalReason;
    audit?: Parameters<typeof removeWorktree>[0]["audit"];
  }): Promise<void> {
    await this.reconcileSelfOwnedBeforeRemove(input.worktreePath, input.taskId);
    const removeArgs = {
      worktreePath: input.worktreePath,
      rootDir: this.rootDir,
      settings: input.settings,
      taskId: input.taskId,
      reason: input.reason,
      audit: input.audit,
      expectedOwnerTaskId: input.taskId,
      liveOwnerProbe: (path: string, ownerTaskId: string) => this.hasActiveWorktreeBinding(ownerTaskId, path),
      // FN-5256: route the worktree-backend defensive reconcile through the
      // hardened gates (process-active + min-idle window).
      processActiveProbe: (probeTaskId: string) => executingTaskLock.has(probeTaskId),
    } as const;
    try {
      await removeWorktree(removeArgs);
    } catch (error: unknown) {
      if (
        error instanceof ActiveSessionWorktreeRemovalError
        && error.details.taskId === input.taskId
        && !this.hasActiveWorktreeBinding(input.taskId, input.worktreePath)
      ) {
        // FN-5256: route the post-throw reconcile through the hardened path so
        // process-active and too-recent signals also gate this leg.
        const outcome = reconcileSelfOwnedActiveSessionForRemoval(
          activeSessionRegistry,
          input.worktreePath,
          input.taskId,
          (path, ownerTaskId) => this.hasActiveWorktreeBinding(ownerTaskId, path),
          {
            processActiveProbe: (probeTaskId) => executingTaskLock.has(probeTaskId),
          },
        );
        if (outcome.action === "reconciled") {
          await this.store.logEntry(
            input.taskId,
            "Reconciled stale self-owned active-session registration (post-throw)",
            input.worktreePath,
          );
          await removeWorktree(removeArgs);
          return;
        }
        if (outcome.action === "process-active-refuses" || outcome.action === "too-recent-refuses") {
          executorLog.warn(
            `[FN-5256] post-throw reconcile refused for ${input.taskId} at ${input.worktreePath}: action=${outcome.action}`,
          );
          // Refused — surface the original error so the caller can decide.
        }
      }
      throw error;
    }
  }

  private async cleanupConflictingWorktree(
    worktreePath: string,
    branch: string,
    taskId: string,
  ): Promise<boolean> {
    await this.reconcileSelfOwnedBeforeRemove(worktreePath, taskId);

    // FN-4811: Hard liveness gate — refuse to remove a worktree that is currently bound to
    // an active executor/merger session, regardless of git-level conflict classification.
    // This is the canonical guard against the FN-4781/FN-4804 race where a startup cleanup
    // pass or branch-conflict recovery yanked the worktree of a still-running session, causing
    // "assigned worktree path disappeared mid-task" + parallel-runs + cross-task contamination.
    const activeOwner = await this.findActiveWorktreeOwner(worktreePath, taskId);
    if (activeOwner !== null) {
      const refusalMessage = `[FN-4811] Refused to remove worktree ${worktreePath}: actively owned by ${activeOwner} (requested by ${taskId})`;
      executorLog.warn(refusalMessage);
      await this.store.logEntry(taskId, `Refused to remove conflicting worktree — actively owned by another task`, `${worktreePath} (owner: ${activeOwner})`);
      return false;
    }

    try {
      // Check if worktree is locked and unlock if needed
      try {
        await execAsync(`git worktree unlock "${worktreePath}"`, {
          cwd: this.rootDir,
        });
        await this.store.logEntry(taskId, `Unlocked worktree`, worktreePath);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        executorLog.warn(`${taskId}: failed to unlock conflicting worktree ${worktreePath} before cleanup: ${msg}`);
      }

      // Remove the worktree
      const settings = await this.store.getSettings();
      await this.removeOwnWorktreeWithReconcile({
        worktreePath,
        settings,
        taskId,
        reason: RemovalReason.ExecutorDispose,
      });
      await this.store.logEntry(taskId, `Removed conflicting worktree`, worktreePath);

      // Delete the branch if it exists
      try {
        await execAsync(`git branch -D "${branch}"`, {
          cwd: this.rootDir,
        });
        await this.store.logEntry(taskId, `Deleted branch`, branch);
        // FN-2165 regression guard: null baseBranch on any task that stored this branch
        this.store.clearStaleExecutionStartBranchReferences([branch], taskId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        executorLog.warn(`${taskId}: failed to delete conflicting branch ${branch}: ${msg}`);
      }

      return true;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // FN-4811 follow-up (FN-4813): when `git worktree remove --force` fails with
      // "fatal: validation failed, cannot remove working tree", the worktree directory
      // doesn't exist on disk and the git admin entry (if any) is stale. Treat as
      // already-cleaned: prune the stale admin entry, best-effort delete the branch, and
      // return success so the caller can proceed with fresh worktree creation. Without
      // this recovery, every `tryCreateWorktree` retry on a stale conflict path fails
      // with "automatic cleanup failed".
      if (/validation failed, cannot remove working tree/i.test(errorMessage)) {
        try {
          await execAsync("git worktree prune", {
            cwd: this.rootDir,
            timeout: 30_000,
            maxBuffer: 10 * 1024 * 1024,
          });
        } catch (pruneErr: unknown) {
          const pruneMsg = pruneErr instanceof Error ? pruneErr.message : String(pruneErr);
          executorLog.warn(`${taskId}: git worktree prune failed during stale-path cleanup of ${worktreePath}: ${pruneMsg}`);
        }
        try {
          await execAsync(`git branch -D "${branch}"`, { cwd: this.rootDir });
          this.store.clearStaleExecutionStartBranchReferences([branch], taskId);
        } catch {
          // best-effort — branch may not exist, which is fine for a stale-path cleanup
        }
        await this.store.logEntry(
          taskId,
          `Cleaned up stale conflicting worktree admin entry (validation failed — path likely missing on disk)`,
          worktreePath,
        );
        return true;
      }
      await this.store.logEntry(
        taskId,
        `Failed to clean up conflicting worktree`,
        `${worktreePath}: ${errorMessage}`,
      );
      return false;
    }
  }

  /**
   * Clean up a stale branch that no longer has a valid reference.
   *
   * Recovery strategy (in order):
   * 1. `git worktree prune` — remove stale worktree metadata that may
   *    hold a lock on the branch reference
   * 2. `git branch -D` — delete the branch normally
   * 3. `git update-ref -d refs/heads/<branch>` — force-remove a corrupted
   *    or dangling reference when `git branch -D` fails
   *
   * Each step is logged so operators can trace the recovery path.
   * Returns true if the branch reference was successfully removed.
   */
  private async cleanupStaleBranch(branch: string, taskId: string): Promise<boolean> {
    // Step 1: Prune stale worktree metadata that may hold a lock on the branch
    try {
      await execAsync("git worktree prune", { cwd: this.rootDir });
      await this.store.logEntry(taskId, `Pruned stale worktree metadata`, branch);
    } catch {
      // Prune is best-effort — continue even if it fails
    }

    // Step 2: Try normal branch deletion
    try {
      await execAsync(`git branch -D "${branch}"`, {
        cwd: this.rootDir,
      });
      await this.store.logEntry(taskId, `Removed stale branch`, branch);
      // FN-2165 regression guard: null baseBranch on any task that stored this branch
      try { this.store.clearStaleExecutionStartBranchReferences([branch], taskId); } catch { /* best-effort */ }
      return true;
    } catch (branchDeleteError: unknown) {
      const branchDeleteErrorMessage = branchDeleteError instanceof Error ? branchDeleteError.message : String(branchDeleteError);
      await this.store.logEntry(
        taskId,
        `git branch -D failed for stale branch, trying update-ref`,
        `${branch}: ${branchDeleteErrorMessage}`,
      );
    }

    // Step 3: Force-remove the reference directly
    try {
      const refPath = `refs/heads/${branch}`;
      await execAsync(`git update-ref -d "${refPath}"`, {
        cwd: this.rootDir,
      });
      await this.store.logEntry(taskId, `Force-removed stale branch reference via update-ref`, refPath);
      // FN-2165 regression guard: null baseBranch on any task that stored this branch
      try { this.store.clearStaleExecutionStartBranchReferences([branch], taskId); } catch { /* best-effort */ }
      return true;
    } catch (updateRefError: unknown) {
      const updateRefErrorMessage = updateRefError instanceof Error ? updateRefError.message : String(updateRefError);
      await this.store.logEntry(
        taskId,
        `Failed to remove stale branch reference`,
        `${branch}: ${updateRefErrorMessage}`,
      );
      return false;
    }
  }

  /**
   * Extract conflict information from git worktree error output.
   * Handles multiple error patterns:
   * - "already used by worktree at '...'"
   * - "invalid reference" / "unable to resolve reference" / "stale file handle"
   * - "could not create leading directories"
   * - "working tree already exists"
   */
  private extractWorktreeConflictInfo(error: unknown): {
    type: "already-used" | "invalid-reference" | "leading-directories" | "already-exists" | "not-git-repo" | "index-lock-contention" | "stale-registration" | "unknown";
    path?: string;
    lockPath?: string;
    message?: string;
  } {
    const execError = error instanceof Error ? error : new Error(String(error));
    const output = [
      execError.message,
      "stderr" in execError && typeof execError.stderr === "string" ? execError.stderr.toString() : undefined,
      "stdout" in execError && typeof execError.stdout === "string" ? execError.stdout.toString() : undefined,
    ]
      .filter(Boolean)
      .join("\n");

    // Pattern: already used by worktree at '/path/to/worktree'
    const alreadyUsedMatch = output.match(/already used by worktree at '([^']+)'/);
    if (alreadyUsedMatch) {
      return { type: "already-used", path: alreadyUsedMatch[1], message: output };
    }

    // Pattern: already checked out at '/path/to/worktree'
    const alreadyCheckedOutMatch = output.match(/is already checked out at '([^']+)'/);
    if (alreadyCheckedOutMatch) {
      return { type: "already-used", path: alreadyCheckedOutMatch[1], message: output };
    }

    const lockPath = parseIndexLockPath(output);
    if (lockPath) {
      return { type: "index-lock-contention", lockPath, message: output };
    }

    const staleRegistrationPath = parseStaleRegistrationPath(output);
    if (staleRegistrationPath) {
      return { type: "stale-registration", path: staleRegistrationPath, message: output };
    }

    // Pattern: invalid reference: 'branch-name'
    // Also covers: unable to resolve reference, stale file handle, not a valid ref
    if (
      output.match(/invalid reference/i) ||
      output.match(/unable to resolve reference/i) ||
      output.match(/stale file handle/i) ||
      output.match(/not a valid ref/i) ||
      output.match(/unable to delete.*ref/i)
    ) {
      return { type: "invalid-reference", message: output };
    }

    // Pattern: could not create leading directories
    if (output.match(/could not create leading directories/i)) {
      return { type: "leading-directories", message: output };
    }

    // Pattern: working tree already exists
    if (output.match(/working tree already exists/i)) {
      return { type: "already-exists", message: output };
    }

    // Pattern: not a git repository / not a git repo
    if (output.match(/not a git repo(sitory)?/i)) {
      return { type: "not-git-repo", message: output };
    }

    return { type: "unknown", message: output };
  }

  /**
   * Remove a task's worktree, but only if no other in-progress or todo task
   * shares the same worktree path (dependency-chain reuse). The branch is
   * always cleaned up by the merger on a per-task basis.
   */
  async cleanup(taskId: string): Promise<void> {
    const worktreePath = this.activeWorktrees.get(taskId);
    if (!worktreePath) return;

    this.activeWorktrees.delete(taskId);

    // Check if another task still needs this worktree
    const otherUser = await findWorktreeUser(this.store, worktreePath, taskId);
    if (otherUser) {
      executorLog.log(`Worktree retained for ${taskId} — still needed by ${otherUser}`);
      return;
    }

    try {
      const settings = await this.store.getSettings();
      await this.removeOwnWorktreeWithReconcile({
        worktreePath,
        settings,
        taskId,
        reason: RemovalReason.ExecutorDispose,
      });
      executorLog.log(`Cleaned up worktree for ${taskId}`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.error(`Failed to clean up worktree for ${taskId}:`, errorMessage);
    }
  }

  /**
   * When the engine restarts mid-step, an `in-progress` step may have already
   * passed its code review (log: `code review Step N: APPROVE`) but not yet
   * been flipped to `done` by the agent's next `fn_task_update` call. Without
   * intervention, the next executor pass re-enters the step and replays plan
   * + code review, which we've measured at 5–20 min of pure waste per restart.
   *
   * This reconciler scans the task log for any in-progress step whose most
   * recent approved code review is newer than its most recent `→ pending`
   * transition, and marks those steps `done`. Subsequent resume logic then
   * advances to the next actually-pending step.
   */
  private async recoverApprovedStepsOnResume(taskId: string): Promise<void> {
    let detail: TaskDetail;
    try {
      detail = await this.store.getTask(taskId);
    } catch (err) {
      executorLog.warn(`${taskId}: recoverApprovedStepsOnResume getTask failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const log = detail.log ?? [];
    if (log.length === 0) return;

    let recovered = 0;
    for (let i = 0; i < detail.steps.length; i++) {
      if (detail.steps[i].status !== "in-progress") continue;

      let lastPendingAt = -1;
      let lastApproveAt = -1;
      const stepName = detail.steps[i].name;
      // Matches "Step 3 (My Step) → pending"; name is user-controlled, so match
      // on prefix rather than a regex built from the name.
      const transitionPrefix = `Step ${i} (${stepName}) → `;
      const approvePrefix = `code review Step ${i}:`;
      for (let j = 0; j < log.length; j++) {
        const action = log[j].action || "";
        if (action.startsWith(transitionPrefix)) {
          const status = action.slice(transitionPrefix.length).trim();
          if (status === "pending") lastPendingAt = j;
        } else if (action.startsWith(approvePrefix) && action.includes("APPROVE")) {
          lastApproveAt = j;
        }
      }

      if (lastApproveAt > lastPendingAt) {
        executorLog.log(
          `${taskId}: step ${i} ("${stepName}") already has an approved code review — marking done on resume (skipping review replay)`,
        );
        try {
          await this.store.logEntry(
            taskId,
            `Step ${i} (${stepName}) recovered as done on resume — code review had already approved before the engine stopped`,
          );
          await this.store.updateStep(taskId, i, "done");
          recovered++;
        } catch (err) {
          executorLog.warn(
            `${taskId}: failed to recover step ${i} on resume: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    if (recovered > 0) {
      executorLog.log(`${taskId}: recovered ${recovered} approved step(s) on resume`);
    }
  }

  /**
   * On resume (task already has a branch from a prior run), walk git history
   * and mark steps as done when a commit matching the step-completion convention
   * is found. This prevents the agent from redoing already-committed work after
   * an auto-requeue.
   *
   * Commit message convention (case-insensitive):
   *   feat|chore|fix(FN-XXXX): complete Step N
   *
   * Called after the worktree is acquired and before the agent session starts.
   */
  private async reconcileStepsFromGitHistory(taskId: string, detail: TaskDetail, worktreePath: string): Promise<void> {
    const baseCommitSha = detail.baseCommitSha;
    if (!baseCommitSha) return;

    // Step-inversion read-through (KTD-12, U12): for graph-owned tasks, resolve
    // which artifact/parser governs the step list from the workflow's parse-steps
    // declaration so reconcile knows the step source. The `complete step N`
    // commit convention is parser-agnostic (every parser yields the same step
    // ordering the agent commits against), so the git-history reconcile below is
    // unchanged — this read-through records the governing source for diagnostics
    // and is the seam a future parser-specific reconcile would consult. Legacy
    // tasks (no parse-steps node) resolve to undefined and are untouched.
    try {
      const ir = await resolveWorkflowIrForTask(this.store, taskId);
      const stepSource = this.resolveTaskStepSource(ir);
      if (stepSource) {
        executorLog.log(
          `${taskId}: reconcile step source governed by parse-steps(artifact=${stepSource.artifact}, parser=${stepSource.parser})`,
        );
      }
    } catch {
      // Read-through is diagnostic only; never block reconcile on it.
    }

    const pendingOrInProgressSteps = detail.steps.filter(
      (s, i) => (s.status === "pending" || s.status === "in-progress") && i > 0,
    );
    if (pendingOrInProgressSteps.length === 0) return;

    let logOutput: string;
    try {
      const { stdout } = await execAsync(
        `git log "${baseCommitSha}..HEAD" --oneline`,
        { cwd: worktreePath },
      );
      logOutput = stdout;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`${taskId}: reconcileStepsFromGitHistory — git log failed: ${msg}`);
      return;
    }

    if (!logOutput.trim()) return;

    // Match: feat(FN-2978): complete Step 3  /  chore(fn-2978)!: Complete step 3
    const stepCommitRegex = /^(?:feat|chore|fix)\([Ff][Nn]-\d+\)(?:!)?:\s*complete\s+step\s+(\d+)/i;
    const reconciledStepIndices = new Set<number>();

    for (const line of logOutput.split("\n")) {
      // git log --oneline format: "<sha> <message>"
      const message = line.replace(/^[0-9a-f]+ /, "").trim();
      const match = message.match(stepCommitRegex);
      if (!match) continue;
      const stepIndex = parseInt(match[1], 10);
      if (Number.isNaN(stepIndex) || stepIndex < 0 || stepIndex >= detail.steps.length) continue;
      const step = detail.steps[stepIndex];
      if (step.status === "pending" || step.status === "in-progress") {
        reconciledStepIndices.add(stepIndex);
      }
    }

    for (const stepIndex of reconciledStepIndices) {
      await this.store.updateStep(taskId, stepIndex, "done");
      await this.store.logEntry(
        taskId,
        `Reconciled Step ${stepIndex} as done from git history (resume)`,
        undefined,
        this.getRunContextFor(taskId),
      );
      executorLog.log(`${taskId}: reconciled Step ${stepIndex} as done from git history`);
    }

    if (reconciledStepIndices.size > 0) {
      // Refresh task and update currentStep to the lowest pending index
      const updated = await this.store.getTask(taskId);
      const lowestPending = updated.steps.findIndex((s) => s.status === "pending" || s.status === "in-progress");
      if (lowestPending >= 0 && lowestPending !== updated.currentStep) {
        await this.store.updateTask(taskId, { currentStep: lowestPending });
        executorLog.log(`${taskId}: set currentStep to ${lowestPending} after step reconciliation`);
      }
    }
  }

  /**
   * Check whether the task's branch has any unique commits compared to main.
   * If the branch has no unique commits and the task has steps marked done,
   * those steps represent lost uncommitted work — reset them to "pending"
   * so the next execution doesn't skip them.
   *
   * Called during stuck-kill cleanup when the worktree is about to be destroyed.
   */
  private async resetStepsIfWorkLost(task: Task): Promise<void> {
    const completedSteps = task.steps.filter(
      (s) => s.status === "done" || s.status === "in-progress",
    );
    if (completedSteps.length === 0) return;

    const branchName = resolveTaskWorkingBranch(task);

    try {
      // Check if the branch has any unique commits vs main
      const { stdout: mergeBaseStdout } = await execAsync(
        `git merge-base "${branchName}" HEAD 2>/dev/null`,
        { cwd: this.rootDir, encoding: "utf-8" },
      );
      const { stdout: branchHeadStdout } = await execAsync(
        `git rev-parse "${branchName}" 2>/dev/null`,
        { cwd: this.rootDir, encoding: "utf-8" },
      );
      const mergeBase = mergeBaseStdout.trim();
      const branchHead = branchHeadStdout.trim();

      if (mergeBase === branchHead) {
        // Branch has no unique commits — all step work was lost
        executorLog.warn(
          `${task.id} branch has no unique commits — resetting ${completedSteps.length} step(s) to pending`,
        );

        for (let i = 0; i < task.steps.length; i++) {
          if (task.steps[i].status === "done" || task.steps[i].status === "in-progress") {
            await this.store.updateStep(task.id, i, "pending");
          }
        }

        const refreshedTask = await this.store.getTask(task.id);
        const prevCurrentStep = refreshedTask.currentStep;
        if (refreshedTask.steps.length > 0) {
          const firstPendingStep = refreshedTask.steps.findIndex((s) => s.status === "pending");
          const newCurrentStep = firstPendingStep >= 0 ? firstPendingStep : 0;
          if (newCurrentStep !== prevCurrentStep) {
            await this.store.updateTask(task.id, { currentStep: newCurrentStep });
            executorLog.log(
              `${task.id}: reset currentStep to ${newCurrentStep} after lost-work reset (was ${prevCurrentStep})`,
            );
            await this.store.logEntry(
              task.id,
              `Reset currentStep to ${newCurrentStep} after lost-work step reset (was ${prevCurrentStep})`,
            );
          }
        }

        await this.store.logEntry(
          task.id,
          `Reset ${completedSteps.length} step(s) to pending — branch had no commits (uncommitted work lost with worktree)`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`${task.id}: step-reset-on-work-lost failed (non-fatal, steps keep current status): ${msg}`);
      // Branch may not exist or git commands may fail — non-fatal.
      // Steps keep their current status (safe default: agent can
      // inspect the worktree and decide).
    }
  }

  /**
   * Mark a task as stuck-aborted so the executor's error handling
   * knows not to treat the disposed session as a genuine failure.
   * Called by the stuck task detector's onStuck callback.
   *
   * @param shouldRequeue — true to move the task back to "todo" for retry,
   *   false if the stuck kill budget is exhausted (task already marked failed).
   */
  markStuckAborted(taskId: string, shouldRequeue: boolean = true): void {
    // Terminate step-session executor if active
    const stepExecutor = this.activeStepExecutors.get(taskId);
    if (stepExecutor) {
      stepExecutor.terminateAllSessions().catch(err =>
        executorLog.warn(`Failed to terminate step sessions for stuck task ${taskId}: ${err}`)
      );
    }
    this.stuckAborted.set(taskId, shouldRequeue);

    // Safety net: if the executor's Promise never resolves (e.g. a bash subprocess
    // is blocking the agent session even after dispose()), force-requeue the task
    // directly after a short grace period.  Without this, a task with a hung tool
    // call stays stranded in "in-progress" until the engine restarts.
    if (shouldRequeue && this.executing.has(taskId)) {
      const FORCE_REQUEUE_GRACE_MS = 60_000; // 60 s — generous, but bounded
      setTimeout(async () => {
        if (!this.executing.has(taskId)) return; // executor unwound normally — nothing to do
        // Re-check the latest column: self-healing may have already moved the
        // task out of in-progress (e.g. recoverCompletedTasks → in-review).
        // Force-requeueing in that case would clobber a valid recovery, undo
        // the worktree/branch state that recovery now relies on, and reset
        // step progress.
        let latestColumn: string | undefined;
        try {
          const latestTask = await this.store.getTask(taskId);
          latestColumn = latestTask.column;
        } catch (err: unknown) {
          executorLog.warn(
            `${taskId} force-requeue could not read latest task state: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (latestColumn && latestColumn !== "in-progress") {
          executorLog.log(
            `${taskId} force-requeue skipped — task is now in '${latestColumn}' (recovered concurrently)`,
          );
          this.executing.delete(taskId);
          executingTaskLock.release(taskId);
          this.stuckAborted.delete(taskId);
          return;
        }
        executorLog.warn(
          `${taskId} still executing ${FORCE_REQUEUE_GRACE_MS / 1000}s after stuck-kill signal ` +
          `(likely a hung subprocess) — force-requeueing`,
        );
        try {
          const settings = await this.store.getSettings();
          const preserveProgress = settings.preserveProgressOnStuckRequeue !== false;
          await this.store.logEntry(
            taskId,
            `Force-requeued after stuck-kill: executor did not unwind within ${FORCE_REQUEUE_GRACE_MS / 1000}s (hung subprocess)${preserveProgress ? " — progress preserved" : ""}`,
          );
          await this.store.updateTask(taskId, { status: "stuck-killed", worktree: null, branch: null });
          await this.store.moveTask(taskId, "todo", preserveProgress ? { preserveProgress: true } : undefined);
          // Remove from executing so the scheduler can re-dispatch normally.
          // The old Promise is still running but the executing guard is cleared so
          // a fresh execute() call won't be blocked.
          this.executing.delete(taskId);
          executingTaskLock.release(taskId);
          this.stuckAborted.delete(taskId);
          executorLog.log(`${taskId} force-requeued to todo`);
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          executorLog.error(`Failed to force-requeue stuck task ${taskId}: ${errorMessage}`);
        }
      }, FORCE_REQUEUE_GRACE_MS);
    }
  }

  /**
   * Handle a loop-detected event from the stuck task detector.
   * Attempts an in-process compact-and-resume before falling back to kill/requeue.
   *
   * This method is the `onLoopDetected` callback wired through the dashboard.
   * It:
   * 1. Checks if the task has an active session
   * 2. Rejects if the one-attempt ceiling has been reached
   * 3. Calls `compactSessionContext()` to compact the conversation
   * 4. Sets recovery-pending state so the execution flow can resume
   *
   * @returns true if the executor accepted recovery ownership (detector skips kill),
   *   false if recovery should not be attempted (detector proceeds with kill/requeue)
   */
  async handleLoopDetected(event: StuckTaskEvent): Promise<boolean> {
    const { taskId } = event;
    const activeEntry = this.activeSessions.get(taskId);

    // No active session — can't compact, let detector kill/requeue
    if (!activeEntry) {
      executorLog.log(`${taskId} loop detected but no active session — falling back to kill/requeue`);
      return false;
    }

    // Check attempt ceiling (max 1 compact-and-resume per execute() lifecycle).
    // After this fallback, StuckTaskDetector -> SelfHealingManager.checkStuckBudget
    // enforces STUCK_LOOP_EXHAUSTED terminalization when retry budget is spent.
    const state = this.loopRecoveryState.get(taskId);
    if (state && state.attempts >= 1) {
      executorLog.log(`${taskId} loop detected but compact ceiling reached — falling back to kill/requeue`);
      return false;
    }

    // Attempt compaction
    const attempt = (state?.attempts ?? 0) + 1;
    executorLog.log(`${taskId} loop detected (attempt ${attempt}) — attempting compact-and-resume`);
    await this.store.logEntry(taskId, `Loop detected (${event.activitySinceProgress} events since last progress) — attempting compact-and-resume (attempt ${attempt})`);

    const compactResult = await compactSessionContext(activeEntry.session);
    if (!compactResult) {
      executorLog.log(`${taskId} compaction failed or unavailable — falling back to kill/requeue`);
      await this.store.logEntry(taskId, "Context compaction failed or unavailable — falling back to kill/requeue");
      return false;
    }

    executorLog.log(`${taskId} compaction succeeded (freed ${compactResult.tokensBefore} tokens) — setting recovery-pending`);
    await this.store.logEntry(taskId, `Context compacted successfully — will resume with fresh context`);

    // FN-5168: once loop recovery has fired in this execute() lifecycle,
    // ignored fn_task_update rebuffs can be promoted to no-progress churn.
    this.options.stuckTaskDetector?.markLoopObserved(taskId);

    // Mark recovery-pending so the execution flow can consume it
    this.loopRecoveryState.set(taskId, { attempts: attempt, pending: true });

    // Steer the session with a resume prompt to break the loop
    try {
      await activeEntry.session.steer(
        "⚠️ Loop detected: you were repeating actions without making progress. " +
        "The conversation has been compacted. Review the current state carefully, " +
        "check what's already been done (git log, file contents), and take a different " +
        "approach. Do NOT repeat the same actions. Advance to the next step if the " +
        "current work is complete.",
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.error(`${taskId} failed to steer after compaction: ${errorMessage}`);
      // Recovery-pending is still set — the execution flow will handle it
    }

    return true;
  }

  getWorktreePath(taskId: string): string | undefined {
    return this.activeWorktrees.get(taskId);
  }

  // ── Agent Spawning ─────────────────────────────────────────────────────

  /**
   * Terminate all child agents spawned by a parent task.
   * Called from the finally block of agentWork when the parent session ends.
   */
  private async terminateAllChildren(parentTaskId: string): Promise<void> {
    const childIds = this.spawnedAgents.get(parentTaskId);
    if (!childIds || childIds.size === 0) return;

    executorLog.log(`Terminating ${childIds.size} child agents for parent ${parentTaskId}`);

    for (const childId of childIds) {
      await this.terminateChildAgent(childId);
    }
    this.spawnedAgents.delete(parentTaskId);
  }

  /**
   * Terminate a single child agent by ID.
   * Disposes the session, updates AgentStore state, and cleans up tracking Maps.
   */
  private async terminateChildAgent(childId: string): Promise<void> {
    const childSession = this.childSessions.get(childId);
    if (childSession) {
      childSession.dispose();
      this.childSessions.delete(childId);
    }

    try {
      await this.options.agentStore?.updateAgentState(childId, "paused");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`Failed to update spawned child ${childId} state to 'terminated' during cleanup: ${msg}`);
    }

    this.pendingEphemeralDeletions.add(childId);
    try {
      await this.options.agentStore?.deleteAgent(childId);
    } catch (err: unknown) {
      if (!this.isBenignEphemeralDeleteRaceError(childId, err)) {
        const msg = err instanceof Error ? err.message : String(err);
        executorLog.warn(`Failed to delete spawned agent ${childId}: ${msg}`);
      }
    } finally {
      this.pendingEphemeralDeletions.delete(childId);
    }

    this.totalSpawnedCount = Math.max(0, this.totalSpawnedCount - 1);
  }

  /**
   * Run a spawned child agent's task to completion.
   * Handles state transitions and cleanup.
   */
  private async runSpawnedChild(
    agentId: string,
    childSession: AgentSession,
    taskPrompt: string,
  ): Promise<void> {
    try {
      await this.options.agentStore?.updateAgentState(agentId, "running");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`Failed to update spawned child ${agentId} state to 'running': ${msg}`);
    }

    try {
      await promptWithFallback(childSession, taskPrompt);
      // Normal completion — mark as active (available)
      try {
        await this.options.agentStore?.updateAgentState(agentId, "active");
      } catch (markActiveErr) {
        executorLog.warn(`Child agent ${agentId} updateAgentState(active) failed: ${markActiveErr instanceof Error ? markActiveErr.message : String(markActiveErr)}`);
      }
    } catch (err: unknown) {
      // Error during execution — mark as error
      try {
        await this.options.agentStore?.updateAgentState(agentId, "error");
      } catch (markErrorErr) {
        executorLog.warn(`Child agent ${agentId} updateAgentState(error) failed: ${markErrorErr instanceof Error ? markErrorErr.message : String(markErrorErr)}`);
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.warn(`Child agent ${agentId} failed: ${errorMessage}`);
    } finally {
      this.childSessions.delete(agentId);
      this.totalSpawnedCount = Math.max(0, this.totalSpawnedCount - 1);
    }
  }

  /**
   * Create the fn_spawn_agent tool definition.
   * Allows the parent agent to spawn child agents with delegated tasks.
   */
  private createSpawnAgentTool(
    taskId: string,
    worktreePath: string,
    settings: Settings,
    taskEnv?: NodeJS.ProcessEnv,
  ): ToolDefinition {
    return {
      name: "fn_spawn_agent",
      label: "Spawn Agent",
      description:
        "Spawn a child agent to handle parallel work or specialized sub-tasks. " +
        "Each child runs in its own git worktree (branched from your worktree) and executes autonomously. " +
        "When you end (fn_task_done), all spawned children are terminated.",
      parameters: spawnAgentParams,
      execute: async (_id: string, params: Static<typeof spawnAgentParams>) => {
        const { name, role, task: taskPrompt } = params;

        // Check if AgentStore is available
        if (!this.options.agentStore) {
          return {
            content: [{ type: "text" as const, text: "Agent spawning is not available (no AgentStore configured)" }],
            details: { agentId: "", state: "error" },
          };
        }

        // Read spawn limits from settings
        const maxPerParent = settings.maxSpawnedAgentsPerParent ?? 5;
        const maxGlobal = settings.maxSpawnedAgentsGlobal ?? 20;

        // Check per-parent limit
        const currentPerParent = this.spawnedAgents.get(taskId)?.size ?? 0;
        if (currentPerParent >= maxPerParent) {
          return {
            content: [{ type: "text" as const, text: `Per-parent spawn limit reached (${currentPerParent}/${maxPerParent}). Wait for children to finish or reduce parallelism.` }],
            details: { agentId: "", state: "error" },
          };
        }

        // Check global limit
        if (this.totalSpawnedCount >= maxGlobal) {
          return {
            content: [{ type: "text" as const, text: `Global spawn limit reached (${this.totalSpawnedCount}/${maxGlobal}). Cannot spawn more agents.` }],
            details: { agentId: "", state: "error" },
          };
        }

        try {
          // Create agent in AgentStore with reportsTo = parent task ID
          const agent = await this.options.agentStore.createAgent({
            name: name.trim(),
            role: role as AgentCapability,
            reportsTo: taskId,
            metadata: { type: "spawned", parentTaskId: taskId },
          });

          // Create git worktree for child (branched from parent's worktree)
          const childWorktreeName = generateWorktreeName(this.rootDir, settings);
          const childWorktreePath = resolveTaskWorktreePath(this.rootDir, settings, childWorktreeName);
          const childBranch = `fusion/spawn-${agent.id}`;
          await this.createWorktree(childBranch, childWorktreePath, taskId, worktreePath);

          // Transition agent to active state
          await this.options.agentStore.updateAgentState(agent.id, "active");

          // Child agents inherit executor instructions
          const childInstructions = await this.resolveInstructionsForRole("executor", settings);
          const childBasePrompt = `You are a child agent spawned by a parent task executor.

Your role:
- Complete the delegated task in your own worktree.
- Work autonomously, but stay tightly scoped to the delegated request.
- Prefer existing project patterns over inventing new ones.
- Run relevant tests and report what you verified.
- Do not widen scope or refactor unrelated areas.

Output expectations:
- Provide a concise summary of what you changed.
- Call out files touched and validations run.
- Explicitly mention unresolved blockers if you could not finish.

Parent task: ${taskId}
Child agent: ${agent.id} (${name})`;
          const childSystemPrompt = buildSystemPromptWithInstructions(childBasePrompt, childInstructions);

          // Build skill selection context for child agent session
          const childTask = await this.store.getTask(taskId);
          const skillContext = await buildSessionSkillContext({
            agentStore: this.options.agentStore!,
            task: childTask,
            sessionPurpose: "executor",
            projectRootDir: this.rootDir,
            pluginRunner: this.options.pluginRunner,
          });
          const parentAgent = childTask.assignedAgentId
            ? await this.options.agentStore.getAgent(childTask.assignedAgentId).catch(() => null)
            : null;
          const childRuntimeHint = extractRuntimeHint(agent.runtimeConfig)
            ?? extractRuntimeHint(parentAgent?.runtimeConfig);

          // Resolve executor model via canonical lane hierarchy so child agents
          // honor project executionProvider/executionModelId overrides (parity
          // with main executor at the top of agentWork()).
          const { provider: childExecutorProvider, modelId: childExecutorModelId } =
            resolveExecutorSessionModel(undefined, undefined, settings, agent.runtimeConfig as Record<string, unknown> | undefined);

          // Create child agent session
          const { session: childSession } = await createResolvedAgentSession({
            sessionPurpose: "executor",
            runtimeHint: childRuntimeHint,
            pluginRunner: this.options.pluginRunner,
            cwd: childWorktreePath,
            systemPrompt: childSystemPrompt,
            tools: "coding",
            defaultProvider: childExecutorProvider,
            defaultModelId: childExecutorModelId,
            fallbackProvider: settings.fallbackProvider,
            fallbackModelId: settings.fallbackModelId,
            runAuditor: createRunAuditor(this.store, this.getRunContextFor(taskId)),
            settings,
            taskEnv,
            // Skill selection: use assigned agent skills if available, otherwise role fallback
            ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
          });

          // Store tracking state
          this.childSessions.set(agent.id, childSession);
          if (!this.spawnedAgents.has(taskId)) {
            this.spawnedAgents.set(taskId, new Set());
          }
          this.spawnedAgents.get(taskId)!.add(agent.id);
          this.totalSpawnedCount++;

          // Run child asynchronously (don't await — parent continues working)
          this.runSpawnedChild(agent.id, childSession, taskPrompt).catch((err: unknown) => {
            const errorMessage = err instanceof Error ? err.message : String(err);
            executorLog.warn(`Child agent ${agent.id} async error: ${errorMessage}`);
          });

          const result: SpawnAgentResult = {
            agentId: agent.id,
            name: agent.name,
            state: "running",
            role: agent.role,
            message: `Agent "${name}" spawned and executing task: ${taskPrompt.slice(0, 100)}${taskPrompt.length > 100 ? "..." : ""}`,
          };

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Failed to spawn agent: ${errorMessage}` }],
            details: { agentId: "", state: "error", message: errorMessage },
          };
        }
      },
    };
  }
}

/**
 * Format a timestamp for display in steering comments.
 * Returns relative time for recent comments, absolute date for older ones.
 */
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

// Project commands are injected here (for reliability) and also in the PROMPT.md (by triage).
// This ensures the executor agent always sees the authoritative commands from settings,
// even if the PROMPT.md was written manually or before commands were configured.
function scopePromptToWorktree(prompt: string, rootDir?: string, worktreePath?: string): string {
  if (!rootDir || !worktreePath || rootDir === worktreePath || !prompt.includes(rootDir)) {
    return prompt;
  }

  return prompt
    .replaceAll(`${rootDir}/`, `${worktreePath}/`)
    .replaceAll(`${worktreePath}/.fusion/`, `${rootDir}/.fusion/`);
}

function buildSourceIssueRef(sourceIssue: TaskDetail["sourceIssue"]): string {
  if (!sourceIssue || sourceIssue.provider !== "github" || !sourceIssue.repository) {
    return "";
  }

  const issueNumber = sourceIssue.issueNumber
    ?? Number.parseInt(sourceIssue.externalIssueId ?? "", 10);

  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    return "";
  }

  return `${sourceIssue.repository}#${issueNumber}`;
}

export function buildExecutionPrompt(
  task: TaskDetail,
  rootDir?: string,
  settings?: Settings,
  worktreePath?: string,
  pluginRunner?: PluginRunner,
  customFieldDefs?: WorkflowFieldDefinition[],
): string {
  const prompt = scopePromptToWorktree(task.prompt, rootDir, worktreePath);
  const reviewLevel = parseReviewLevelFromPrompt(prompt);

  // Build co-author trailer arg for git commits based on settings. The user's
  // configured git identity remains the primary author; Fusion is appended as
  // a `Co-authored-by` trailer for shared credit (recognized by GitHub).
  const authorArg = settings?.commitAuthorEnabled !== false
    ? ` -m "Co-authored-by: ${settings?.commitAuthorName || "Fusion"} <${settings?.commitAuthorEmail || "noreply@runfusion.ai"}>"`
    : "";

  const sourceIssueRef = buildSourceIssueRef(task.sourceIssue);

  // Build step progress for resume
  const hasProgress = task.steps.length > 0 && task.steps.some((s) => s.status !== "pending");
  let progressSection = "";
  if (hasProgress) {
    const doneSteps = task.steps
      .map((s, i) => ({ ...s, index: i }))
      .filter((s) => s.status === "done");
    const currentStep = task.currentStep;
    const currentStepInfo = task.steps[currentStep];

    progressSection = `
## ⚠️ RESUMING — Previous progress exists

This task was already partially executed. DO NOT redo completed steps.

### Step status:
${task.steps.map((s, i) => `- Step ${i} (${s.name}): **${s.status}**`).join("\n")}

### Resume from: Step ${currentStep}${currentStepInfo ? ` (${currentStepInfo.name})` : ""}

${doneSteps.length > 0 ? `Steps ${doneSteps.map((s) => s.index).join(", ")} are already complete — skip them entirely.` : ""}
Check the git log to understand what was already implemented:
\`\`\`bash
git log --oneline
\`\`\`
`;
  }

  // Build attachments section
  let attachmentsSection = "";
  if (task.attachments && task.attachments.length > 0 && rootDir) {
    const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    const lines = ["## Attachments", ""];
    for (const att of task.attachments) {
      const absPath = `${rootDir}/.fusion/tasks/${task.id}/attachments/${att.filename}`;
      if (IMAGE_MIMES.has(att.mimeType)) {
        lines.push(`- **${att.originalName}** (screenshot): \`${absPath}\``);
      } else {
        lines.push(`- **${att.originalName}** (${att.mimeType}): \`${absPath}\` — read for context`);
      }
    }
    attachmentsSection = "\n" + lines.join("\n") + "\n";
  }

  // Build project commands section from settings
  let commandsSection = "";
  if (settings?.testCommand || settings?.buildCommand) {
    const lines = ["## Project Commands"];
    if (settings.testCommand) lines.push(`- **Test:** \`${settings.testCommand}\``);
    if (settings.buildCommand) lines.push(`- **Build:** \`${settings.buildCommand}\``);
    commandsSection = "\n" + lines.join("\n") + "\n";
  }

  // Build project memory section from settings
  // When enabled, agents consult and update project memory for durable project learnings.
  // Backend-aware: instructions branch based on memoryBackendType (file, readonly, qmd)
  const memoryEnabled = settings?.memoryEnabled !== false;
  const memoryMode: AgentMemoryInclusionMode = settings?.agentMemoryInclusionMode ?? "full";
  let memorySection = "";
  if (memoryEnabled && rootDir && memoryMode !== "off") {
    memorySection = memoryMode === "index"
      ? "\n## Project Memory (Index Only)\n\nUse fn_memory_search first to find relevant memory, then fn_memory_get for specific excerpts.\n"
      : "\n" + buildExecutionMemoryInstructions(rootDir, settings);
  }

  // Build steering comments section (last 10 comments only to avoid context bloat)
  let steeringSection = "";
  if (task.steeringComments && task.steeringComments.length > 0) {
    const recentComments = [...task.steeringComments].slice(-10);
    const lines = [
      "",
      "## Steering Comments",
      "",
      "The following comments were added by the user during execution. Consider adjusting your approach or replanning remaining steps based on this feedback.",
      "",
    ];
    for (const comment of recentComments) {
      const timestamp = formatTimestamp(comment.createdAt);
      lines.push(`**${comment.author}** — ${timestamp}`);
      lines.push(`> ${comment.text}`);
      lines.push("");
    }
    steeringSection = lines.join("\n");
  }

  // Build custom fields section (KTD-13): when the task's workflow declares
  // custom fields, the executor agent can write them via fn_task_update
  // (custom_fields) — but without the schema it is writing blind. List each
  // field's id/name/type, enum options, required flag, and current value so
  // the write is informed and self-correcting. Compact: one line per field.
  let customFieldsSection = "";
  if (customFieldDefs && customFieldDefs.length > 0) {
    const current = task.customFields ?? {};
    const lines = [
      "",
      "## Custom fields",
      "",
      "This task's workflow declares custom fields. Set them with `fn_task_update(custom_fields={...})` keyed by field id (pass null to clear).",
      "",
    ];
    for (const f of customFieldDefs) {
      const parts = [`- \`${f.id}\` (${f.name}) — type: ${f.type}`];
      if ((f.type === "enum" || f.type === "multi-enum") && f.options && f.options.length > 0) {
        const opts = f.options.map((o) => (o.label && o.label !== o.value ? `${o.value} (${o.label})` : o.value)).join(", ");
        parts.push(`options: [${opts}]`);
      }
      if (f.required) parts.push("required");
      const hasValue = Object.prototype.hasOwnProperty.call(current, f.id) && current[f.id] !== null && current[f.id] !== undefined;
      parts.push(`current: ${hasValue ? JSON.stringify(current[f.id]) : "unset"}`);
      lines.push(parts.join("; "));
    }
    customFieldsSection = lines.join("\n") + "\n";
  }

  const taskPromptContributions = pluginRunner?.getPromptContributionsForSurface("executor-task") ?? [];
  if (taskPromptContributions.length > 0) {
    executorLog.log(`${task.id}: applied ${taskPromptContributions.length} plugin prompt contributions for executor-task surface`);
  }
  const pluginTaskContributions = buildPluginPromptSection("executor-task", pluginRunner);

  return `Execute this task.

## Task: ${task.id}
${task.title ? `**${task.title}**` : ""}
${task.dependencies.length > 0 ? `Dependencies: ${task.dependencies.join(", ")}` : ""}

## PROMPT.md

${prompt}
${attachmentsSection}${commandsSection}${memorySection}${progressSection}${steeringSection}${customFieldsSection}
## Review level: ${reviewLevel}

${reviewLevel === 0 ? "No reviews required. Implement directly." : ""}
${reviewLevel >= 1 ? `Before implementing each step (except Step 0 and the final step), call:
\`fn_review_step(step=N, type="plan", step_name="...")\`` : ""}
${reviewLevel >= 2 ? `After implementing + committing each step, call:
\`fn_review_step(step=N, type="code", step_name="...", baseline="<SHA from before step>")\`` : ""}
${reviewLevel >= 3 ? `After tests, also call fn_review_step with type="code" for test review.` : ""}
${pluginTaskContributions ? `

${pluginTaskContributions}
` : ""}

## Worktree Boundaries

You are running in an **isolated git worktree**. This means:

- **All code changes must be made inside the current worktree directory.** Do not modify files outside the worktree.
- **Exception — Project memory:** You MAY read and write to files under \`.fusion/memory/\` at the project root to save durable project learnings.
- **Exception — Task attachments:** You MAY read files under \`.fusion/tasks/{taskId}/attachments/\` at the project root for context.
- **Exception — Sibling task specs:** You MAY read \`.fusion/tasks/{taskId}/PROMPT.md\` and \`.fusion/tasks/{taskId}/task.json\` at the project root (read-only) to consult dependency tasks' specifications. If those files do not exist, the dependency has been archived — call \`fn_task_show\` with its ID to load the spec from the archive.
- **Shell commands** run inside the worktree by default. Avoid using \`cd\` to navigate outside the worktree.

## Begin

${hasProgress
    ? `Resume from Step ${task.currentStep}. Do NOT redo completed steps.`
    : "Start with Step 0 (Preflight). Work through each step in order."}
Use \`fn_task_update\` to report progress on every step transition.
Use \`fn_task_log\` for important actions and decisions.
Use \`fn_task_create\` for truly separate follow-up work, not for fixes required to get tests, build, or typecheck back to green.
Commit at step boundaries: \`git commit -m "feat(${task.id}): complete Step N — <short summary>"${sourceIssueRef ? ` -m "Ref: ${sourceIssueRef}"` : ""}${authorArg}\`
The \`<short summary>\` is required — replace it with a concrete 5–10 word description of what the step changed.
When all steps are complete: call \`fn_task_done()\`

If a build command is configured, run that exact command in this worktree before calling \`fn_task_done()\`.
Treat a non-zero exit code as a blocking failure. Do not claim success without a real passing run.
Run the configured/full test suite and fix failures even when that requires edits outside the original File Scope.
If the repo has a lint command (e.g. \`pnpm lint\`, \`npm run lint\`), run it before \`fn_task_done()\` and fix any failures it reports.
If the repo has a typecheck command, run it before \`fn_task_done()\` and fix any failures it reports.
Use \`fn_task_create\` for truly separate follow-up work, not for fixes required to get tests, build, or typecheck back to green.
If lint is configured and failing, fix that too before completion.
**CRITICAL: Resolve ALL test failures (and any lint/typecheck failures) before completing the task, even if they appear unrelated or pre-existing.** Unrelated failures left unfixed accumulate technical debt and block future integrations. Investigate and fix or suppress them — do not defer them to a separate task.`;
}

/**
 * Format a comment for injection into a running agent session.
 * Used for real-time steering during task execution.
 */
function formatCommentForInjection(comment: import("@fusion/core").SteeringComment): string {
  const timestamp = formatTimestamp(comment.createdAt);
  return `📣 **New feedback** — ${timestamp} (${comment.author}):\n\n${comment.text}\n\nPlease adjust your approach based on this feedback.`;
}

/**
 * Result of a pseudo-pause detection check.
 */
export interface PseudoPauseResult {
  /** Detection method: "regex" if a regex pattern matched, "structural" for structural
   * heuristics, or "none" if no pseudo-pause was detected. */
  kind: "regex" | "structural" | "none";
  /** The matched text or pattern description when kind is not "none". */
  matched?: string;
}

/**
 * Detect whether the last assistant text output looks like a "pseudo-pause" —
 * where the agent ended a turn by asking for permission or summarizing progress
 * instead of calling a tool.
 *
 * Returns a {@link PseudoPauseResult} describing the detection kind and the
 * matched text/pattern. Returns `{ kind: "none" }` when no pseudo-pause is found.
 *
 * @param lastText - The last assistant text output from the session.
 */
export function detectPseudoPause(lastText: string): PseudoPauseResult {
  if (!lastText || lastText.trim().length === 0) {
    return { kind: "none" };
  }

  const regexPatterns: RegExp[] = [
    /\bif you (?:want|wish|need|like|prefer|'?d like)\b/i,
    /\bshould I (?:continue|proceed|go ahead|move on|start|begin)\b/i,
    /\blet me know\b/i,
    /\b(?:want|would you like) me to (?:continue|proceed|finish|complete|do)\b/i,
    /\bready to (?:proceed|continue|move on|begin)\b/i,
    /\bshall I\b/i,
    /\b(?:awaiting|waiting for) (?:your )?(?:approval|confirmation|go-ahead|response)\b/i,
  ];

  for (const pattern of regexPatterns) {
    const match = pattern.exec(lastText);
    if (match) {
      // Capture surrounding context (up to 120 chars around the match)
      const start = Math.max(0, match.index - 40);
      const end = Math.min(lastText.length, match.index + match[0].length + 80);
      const snippet = lastText.slice(start, end).replace(/\n+/g, " ").trim();
      return { kind: "regex", matched: snippet };
    }
  }

  // Structural fallback: long output that ends with a question or a markdown "next steps" heading
  const trimmed = lastText.trimEnd();
  if (trimmed.length > 200) {
    if (trimmed.endsWith("?")) {
      const lastLine = trimmed.split("\n").at(-1) ?? trimmed;
      return { kind: "structural", matched: lastLine.trim() };
    }
    const nextStepsPattern = /(?:^|\n)#+\s*(?:notes?|next steps?|summary|what'?s? next)\s*:?\s*$/i;
    if (nextStepsPattern.test(trimmed)) {
      const lastLine = trimmed.split("\n").at(-1) ?? trimmed;
      return { kind: "structural", matched: lastLine.trim() };
    }
    // Also catch plain "Next steps:" or "### Next steps" at the very end
    if (/next steps?\s*:?\s*$/i.test(trimmed)) {
      const lastLine = trimmed.split("\n").at(-1) ?? trimmed;
      return { kind: "structural", matched: lastLine.trim() };
    }
  }

  return { kind: "none" };
}

/**
 * Detect if a steering comment contains a review handoff request.
 * Matches common handoff phrases that agents can use to request
 * human review of their work.
 */
export function detectReviewHandoffIntent(commentText: string): boolean {
  const text = commentText.toLowerCase();
  const handoffPhrases = [
    "send it back to me",
    "hand off to user",
    "needs human review",
    "assign to user",
    "return to user",
    "user review needed",
    "requesting user review",
  ];

  return handoffPhrases.some((phrase) => text.includes(phrase));
}
