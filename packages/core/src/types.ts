import type { InReviewStallSignal } from "./in-review-stall.js";
import type { PlannerOverseerRuntimeSnapshot } from "./planner-overseer-state.js";
// FNXC:PlannerOversight 2026-07-04-18:00: FN-7563 needs `PlannerOverseerState`/
// `PlannerOverseerRuntimeSnapshot` as TYPE-ONLY imports in the dashboard's pure
// `plannerOverseerBadge.ts` helper. The dashboard's vite alias for "@fusion/core"
// resolves only to this file (types.ts), not the package barrel, so the types must
// be re-exported here (type-only — no engine/runtime code crosses into the browser
// bundle) rather than requiring dashboard code to import the source module path.
export type { PlannerOverseerState, PlannerOverseerRuntimeSnapshot } from "./planner-overseer-state.js";
import type { ModelPricing } from "./model-pricing.js";
import type { InReviewStalledSignal } from "./in-review-stalled.js";
import type { StalePausedReviewSignal } from "./stale-paused-review.js";
import type { StalePausedTodoSignal } from "./stale-paused-todo.js";
import type { StalledReviewSignal } from "./stalled-review-detector.js";
import type { TaskAgeStalenessSignal } from "./task-age-staleness.js";
import type { SecretScope } from "./secrets-store.js";
import type { UpdateChannel } from "./app-version.js";
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
export { exportMcpServersJson, importMcpServersJson, resolveEffectiveMcpServers } from "./mcp-config.js";
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

export type StepStatus = "pending" | "in-progress" | "done" | "skipped";

export interface TaskStep {
  name: string;
  status: StepStatus;
  /**
   * Step-inversion (KTD-11): 0-indexed indices of steps this step depends on,
   * parsed from the PROMPT.md `### Step N (depends: 1,2): Title` annotation
   * or structured parser output (1-indexed step numbers in authored content →
   * 0-indexed indices here).
   *
   * FNXC:WorkflowSteps 2026-06-29-17:52:
   * Absence and emptiness are different planner contracts. Absent means unannotated and therefore implicitly depends on the previous step; an explicit empty array means this step has no dependencies and may run as a parallel root.
   */
  dependsOn?: number[];
}

/** Correlation metadata linking a task mutation to the agent run that caused it. */
export interface RunMutationContext {
  /** The heartbeat run ID that initiated this mutation. */
  runId: string;
  /** The agent ID that performed the mutation. */
  agentId: string;
  /** Optional invocation source of the run (e.g., "on_demand", "timer", "assignment"). */
  source?: string;
}

export interface TaskLogEntry {
  timestamp: string;
  action: string;
  outcome?: string;
  /** Correlation metadata linking this entry to the agent run that produced it. */
  runContext?: RunMutationContext;
}

export type WorkflowTransitionNotificationKind =
  | "manual-merge-hold"
  | "recovery-requeue";

export interface WorkflowTransitionNotificationMarker {
  kind: WorkflowTransitionNotificationKind;
  column: ColumnId;
  transitionId: string;
  nodeId?: string;
  reason?: string;
  createdAt: string;
}

export type ActivityEventType =
  | "task:created"
  | "task:moved"
  | "task:updated"
  | "task:deleted"
  | "task:merged"
  | "task:failed"
  | "task:duplicate-warning-overridden"
  | "task:auto-archived-deterministic-duplicate"
  | "task:auto-archived-near-duplicate"
  | "task:near-duplicate-flagged"
  /*
   * FNXC:ReleaseAuthorizationGate 2026-07-09-01:00:
   * The triage release-authorization planning gate and its `task:release-authorization-required`
   * activity type were removed (FN-7732, following the engine gate removal in b5b0458). Releases
   * are kept out of Fusion by agent instruction (AGENTS.md -> "Releasing"), not by an activity/gate.
   */
  | "task:auto-archived-ghost-bug"
  | "task:auto-archived-duplicate"
  | "task:merge-worktree-reacquired"
  | "settings:updated"
  | "project:isolation-transition";

export interface ActivityLogEntry {
  id: string;
  timestamp: string;
  type: ActivityEventType;
  taskId?: string;
  taskTitle?: string;
  details: string;
  metadata?: Record<string, unknown>;
}

/** The set of agent roles that produce log entries. */
export type AgentRole = "triage" | "executor" | "reviewer" | "merger";

/*
FNXC:AgentLog-EntryTypes 2026-07-15-11:20:
`text` means a STREAMED DELTA FRAGMENT: renderers re-glue consecutive `text` rows with `join("")` and no separator, because that is the only way to reconstitute a streamed message (the FN-5787/5789/5803 streamed-spacing lineage). `AgentLogger` is the only producer of true deltas.

`status` means a COMPLETE, SELF-CONTAINED engine message (e.g. "Reviewer using model: x/y", "Deterministic merge verification passed") written directly by an engine lane rather than streamed from a model. It exists because engine lanes previously wrote these as `text`, so N consecutive standalone messages were glued edge-to-edge into one run-on string under an accurate-but-misleading "N entries" header.

Never emit `status` for model-streamed output, and never emit `text` for a whole standalone message. Renderers must render each `status` row as its own block and must never `join("")` them. Rows written before this type existed persist as `text`, so read paths that resolve engine markers out of the log must accept BOTH types (see dashboard effective-model-resolution.ts).
*/
export type AgentLogType = "text" | "status" | "tool" | "thinking" | "tool_result" | "tool_error";

/** A single chunk of agent output persisted to disk (JSONL in agent.log). */
export interface AgentLogEntry {
  /** ISO-8601 timestamp of when the entry was recorded. */
  timestamp: string;
  /** The task this log entry belongs to. */
  taskId: string;
  /** The text content (delta for "text"/"thinking", complete message for "status", tool name for "tool"/"tool_result"/"tool_error"). */
  text: string;
  /** The kind of entry — streamed text delta, standalone engine status message, tool invocation marker, thinking block, tool result, or tool error. */
  type: AgentLogType;
  /**
   * For `tool`: human-readable argument summary (for example a file path or command).
   * `tool` and successful `tool_result` detail are persisted only when `persistAgentToolOutput` is enabled;
   * failed `tool_error` detail is always persisted as bounded diagnostic signal.
   *
   * FNXC:AgentLogging 2026-07-15-16:05: FN-7995 requires failed tool-call errors to remain available
   * to task transcript renderers even when verbose successful tool output is disabled.
   */
  detail?: string;
  /** Which agent produced this entry. Absent in logs written before this field was added. */
  agent?: AgentRole;
  /** Request/tool processing duration in milliseconds. Absent for legacy rows and entries without bounded timing. */
  durationMs?: number;
  /** Time to first visible model output in milliseconds. Absent after the first visible output and on legacy rows. */
  timeToFirstTokenMs?: number;
}

/** How much of `.fusion/tasks/{ID}/agent.log` is copied into cold archive storage. */
export type ArchiveAgentLogMode = "none" | "compact" | "full";

export interface TaskAttachment {
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface SteeringComment {
  id: string;
  text: string;
  createdAt: string;
  author: "user" | "agent";
}

export interface TaskComment {
  id: string;
  text: string;
  author: string;
  createdAt: string;
  updatedAt?: string;
  source?: "user" | "agent" | "github-review" | "github-review-comment";
  externalId?: string;
  reviewState?: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
}

export interface TaskCommentInput {
  text: string;
  author: string;
}

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

export interface MergeDetails {
  commitSha?: string;
  /**
   * When merger used rebase strategy (>=2 substantive commits), this is the
   * parent SHA on the target branch before the cherry-pick chain. The canonical
   * rebase display/audit range is `rebaseBaseSha..commitSha`.
   * Unset for squash merges.
   */
  rebaseBaseSha?: string;
  /**
   * Authoritative landed file set on the merge target:
   * - squash: files touched by the final recorded squash commit
   * - rebase/cherry-pick: files touched across `rebaseBaseSha..commitSha`
   *
   * This differs from `Task.modifiedFiles`, which is an executor pre-merge
   * worktree snapshot and can include in-flight files later reverted before
   * landing.
   */
  landedFiles?: string[];
  /**
   * Shortstat file count of the final recorded merge/squash commit only.
   * For multi-commit task lineage this can undercount landed scope.
   * Use `/api/tasks/:id/diff` for lineage-backed landed totals.
   * Decision (FN-4647): this remains commit-level metadata; no separate
   * persisted lineage-level summary is added at this time.
   */
  filesChanged?: number;
  /**
   * Shortstat insertion count of the final recorded merge/squash commit only.
   * Use `/api/tasks/:id/diff` for lineage-backed landed totals.
   */
  insertions?: number;
  /**
   * Shortstat deletion count of the final recorded merge/squash commit only.
   * Use `/api/tasks/:id/diff` for lineage-backed landed totals.
   */
  deletions?: number;
  /**
   * True when rebase-strategy capture found zero commits attributable to this
   * task — the branch's work was already on main (verified-short-circuit /
   * already-on-main path). When true, `landedFiles` will be `[]` and stats
   * will be 0. Squash-strategy merges never set this flag.
   */
  noOpVerifiedShortCircuit?: boolean;
  /**
   * True when `landedFiles` / `filesChanged` / `insertions` / `deletions` were
   * captured from task-attributable commits only (rebase-strategy success path
   * via `filterFilesToOwnTaskCommits`). Self-healing `recoverDoneTaskMergeMetadata`
   * must NOT overwrite these values with the full `rebaseBaseSha..sha` range,
   * which would re-inflate them.
   */
  landedFilesAttributionRestricted?: boolean;
  /**
   * Set ONLY when `filterFilesToOwnTaskCommits` threw and the merger fell back
   * to the legacy unrestricted `<rebaseBaseSha>..<sha>` walk. Stored
   * `landedFiles` / stats may include foreign commits; this flag opts
   * self-healing back into reconcile (the inflated values are NOT intentional).
   * Never set on success paths.
   */
  landedFilesCaptureFallback?: "attribution-failed";
  mergeCommitMessage?: string;
  mergedAt?: string;
  mergeConfirmed?: boolean;
  noOpMerge?: boolean;
  noOpReason?: string;
  prNumber?: number;
  mergeTargetBranch?: string;
  mergeTargetSource?: "task-base-branch" | "task-branch-context" | "branch-group-integration" | "project-default" | "legacy-main";
  resolutionStrategy?: "ai" | "auto-resolve" | "theirs" | "ours" | "abort" | "orphan-discard-no-op";
  resolutionMethod?: "ai" | "auto" | "mixed" | "theirs" | "ours" | "abort";
  attemptsMade?: 1 | 2 | 3;
  autoResolvedCount?: number;
  /**
   * FN-4811 follow-up: persisted record of a done-task finalize-integrity warning.
   * When set, the periodic integrity sweep skips re-emitting the same warning across
   * engine restarts — the in-memory `finalizeUnprovenWarned` Set is volatile and would
   * otherwise spam the log every time the sweep ran on a fresh process.
   *
   * `warnedAt` is the ISO timestamp of the first warning; `reason` is the classifier
   * reason (e.g. "missing-evidence", "foreign-start-point", "no-owned-commit-foreign-deltas").
   * Clear this field when the task evidence is later proven (e.g., via
   * `task:integrity-reconcile-modified-files` repair path).
   */
  integrityWarning?: {
    warnedAt: string;
    reason: string;
  };
  /**
   * FN-5627 follow-up: counts how many times self-healing
   * `recoverTransientMergeFailures` has reset this task's `mergeRetries` and
   * re-enqueued it after a transient merge failure (e.g., `target-not-queued`
   * lease handoff race, or a misclassified same-SHA spurious concurrent-advance
   * left over from pre-FN-5627 code paths). Bounded by `MAX_TRANSIENT_MERGE_RECOVERIES`
   * (2) to avoid infinite recovery loops on genuinely-stuck tasks. Distinct from
   * `task.mergeRetries`, which counts in-cycle aiMergeTask retries.
   */
  transientRecoveryCount?: number;
  /**
   * FNXC:Workspace 2026-06-22-00:30 (Phase C U2, KTD3):
   * Workspace-mode aggregate landed map: sub-repo relative path → the squash sha
   * that landed on that repo's local integration ref. Set ONLY by
   * `landWorkspaceTask`'s finalize-once after EVERY acquired repo's landed
   * predicate holds; the task-level `commitSha` points at one representative
   * landed sha (the first sorted landed repo) so the existing `task:merged`
   * consumer (which reads `mergeDetails.commitSha`) is satisfied. Empty/absent
   * for single-repo tasks.
   */
  workspaceLandedShas?: Record<string, string>;
}

/** Represents an agent's checkout lease on a task. */
export interface CheckoutLease {
  /** The agent ID that holds the lease */
  agentId: string;
  /** ISO-8601 timestamp when the lease was acquired */
  checkedOutAt: string;
}

export interface CheckoutClaimContext {
  /** Node identity for the claimant. */
  nodeId: string;
  /** Owning run/session ID when known. */
  runId?: string;
  /** Expected current lease epoch for renewal operations. */
  leaseEpoch?: number;
  /** ISO-8601 timestamp for lease-renewed heartbeat updates. */
  renewedAt?: string;
}

export interface CheckoutClaimPrecondition {
  /** Null/undefined means expecting an unclaimed row. */
  expectedCheckedOutBy?: string | null;
  expectedNodeId?: string | null;
  expectedLeaseEpoch?: number | null;
}

export interface TaskClaimRow {
  projectId: string;
  taskId: string;
  ownerNodeId: string;
  ownerAgentId: string;
  ownerRunId: string | null;
  leaseEpoch: number;
  leaseRenewedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CentralClaimStore {
  tryClaimTask(input: {
    projectId: string;
    taskId: string;
    nodeId: string;
    agentId: string;
    runId: string | null;
    renewedAt: string;
    expectedEpoch?: number | null;
  }): { ok: true; claim: TaskClaimRow } | { ok: false; reason: "conflict"; current: TaskClaimRow } | Promise<{ ok: true; claim: TaskClaimRow } | { ok: false; reason: "conflict"; current: TaskClaimRow }>;
  renewTaskClaim(input: {
    projectId: string;
    taskId: string;
    nodeId: string;
    agentId: string;
    runId: string | null;
    renewedAt: string;
    expectedEpoch: number;
  }): { ok: true; claim: TaskClaimRow } | { ok: false; reason: "conflict" | "not_found"; current: TaskClaimRow | null } | Promise<{ ok: true; claim: TaskClaimRow } | { ok: false; reason: "conflict" | "not_found"; current: TaskClaimRow | null }>;
  releaseTaskClaim(input: {
    projectId: string;
    taskId: string;
    nodeId: string;
    agentId: string;
  }): { ok: true } | { ok: false; reason: "not_owner" | "not_found"; current: TaskClaimRow | null } | Promise<{ ok: true } | { ok: false; reason: "not_owner" | "not_found"; current: TaskClaimRow | null }>;
  getTaskClaim(projectId: string, taskId: string): TaskClaimRow | null | Promise<TaskClaimRow | null>;
}

/**
 * One model-specific bucket inside a task's durable token usage aggregate.
 *
 * FNXC:TokenAnalytics 2026-06-19-15:42:
 * Multi-model task lifecycles must persist unidentified, partially identified, and fully identified model buckets without tightening nullability; analytics expands these buckets while legacy task-level totals remain the grand-total source of truth.
 */
export interface TaskTokenUsagePerModel {
  /** Provider of the actually-used model for this bucket. */
  modelProvider?: string;
  /** Id of the actually-used model for this bucket. */
  modelId?: string;
  /** Cumulative prompt/input tokens consumed by this model for the task. */
  inputTokens: number;
  /** Cumulative completion/output tokens consumed by this model for the task. */
  outputTokens: number;
  /** Cumulative cache-read (cache hit) tokens reported for this model. */
  cachedTokens: number;
  /** Cumulative cache-write tokens reported for this model. */
  cacheWriteTokens: number;
  /** Cumulative total tokens for this model bucket. */
  totalTokens: number;
  /** ISO-8601 timestamp of the first recorded usage event for this model bucket. */
  firstUsedAt: string;
  /** ISO-8601 timestamp of the most recent recorded usage event for this model bucket. */
  lastUsedAt: string;
}

/**
 * Durable task-level aggregate token usage totals persisted on the task row.
 *
 * This model captures cumulative usage across all agent/run activity linked to
 * a task so usage survives process restarts and can be queried without joining
 * transient run state.
 */
export interface TaskTokenUsage {
  /** Cumulative prompt/input tokens consumed by the task. */
  inputTokens: number;
  /** Cumulative completion/output tokens consumed by the task. */
  outputTokens: number;
  /** Cumulative cache-read (cache hit) tokens reported by providers. */
  cachedTokens: number;
  /** Cumulative cache-write tokens reported by providers. */
  cacheWriteTokens: number;
  /** Cumulative total tokens for the task (input + output + cache-read + cache-write). */
  totalTokens: number;
  /** ISO-8601 timestamp of the first recorded usage event for this task. */
  firstUsedAt: string;
  /** ISO-8601 timestamp of the most recent recorded usage event for this task. */
  lastUsedAt: string;
  /**
   * FNXC:TokenAnalytics 2026-06-18-16:23:
   * Snapshot the provider of the actually-used model for analytics only. This is intentionally distinct from task.modelProvider, which is an own-model override used by model resolution and must not be written by token bookkeeping.
   */
  modelProvider?: string;
  /**
   * FNXC:TokenAnalytics 2026-06-18-16:23:
   * Snapshot the id of the actually-used model for analytics only. This is intentionally distinct from task.modelId, which is an own-model override used by model resolution and must not be written by token bookkeeping.
   */
  modelId?: string;
  /**
   * FNXC:TokenAnalytics 2026-06-19-15:38:
   * Command Center model/provider analytics must show every model that consumed tokens during a task lifecycle. Store durable per-model buckets so executor, validator, reviewer, and planning usage is attributed to the producing model while the top-level task aggregate remains backward-compatible.
   */
  perModel?: TaskTokenUsagePerModel[];
}

export interface TaskTokenBudget {
  /** Input, output, and cache-write token soft cap (cache reads excluded). When reached, emits one notification and continues. */
  soft?: number;
  /** Input, output, and cache-write token hard cap (cache reads excluded). When reached, pauses the task with pausedReason="token_budget_exceeded". */
  hard?: number;
  /** Optional per-size overrides keyed by Task.size (S/M/L). Falls back to soft/hard when absent. */
  perSize?: { S?: { soft?: number; hard?: number }; M?: { soft?: number; hard?: number }; L?: { soft?: number; hard?: number } };
}

export interface TaskTokenBudgetOverride {
  soft?: number;
  hard?: number;
  /** Optional ISO timestamp recording when an operator widened the cap on unpause. */
  raisedAt?: string;
  /** Optional free-text justification recorded with the override. */
  reason?: string;
}

/** Thrown when a checkout is attempted on a task already checked out by another agent. */
export class CheckoutConflictError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly currentHolderId: string,
    public readonly requestedById: string,
  ) {
    super(`Task ${taskId} is already checked out by agent ${currentHolderId}`);
    this.name = "CheckoutConflictError";
  }
}

/** Origin types for task creation provenance tracking. */
export type SourceType =
  | "dashboard_ui"
  | "quick_chat"
  | "chat_session"
  | "agent_heartbeat"
  | "automation"
  | "cron"
  | "workflow_step"
  | "github_import"
  | "gitlab_import"
  | "task_refine"
  | "task_duplicate"
  | "cli"
  | "api"
  | "recovery"
  | "research"
  | "unknown";

export const DUPLICATE_OF_METADATA_KEY = "duplicateOfTaskIds" as const;

/** Provenance metadata for how a task was created. */
export interface TaskSource {
  sourceType: SourceType;
  sourceAgentId?: string;
  sourceRunId?: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
  sourceParentTaskId?: string;
  /**
   * Reserved metadata keys:
   * - `duplicateOfTaskIds: string[]` stores structured duplicate lineage captured
   *   from triage parsing and backfills.
   * - near-duplicate markers: `nearDuplicateOf` (canonical task id),
   *   `nearDuplicateScore` (number), `nearDuplicateSharedTokens` (string[]),
   *   and optional `nearDuplicateDismissed` (boolean).
   */
  sourceMetadata?: Record<string, unknown>;
}

export type TaskBranchGroupSource = "planning" | "mission" | "new-task";

export type TaskBranchAssignmentMode = "shared" | "per-task-derived";

export interface TaskBranchContext {
  /**
   * The owning BranchGroup id (`BG-…`). Only set for shared-mode members that
   * were actually assigned to an ensured branch group. Non-shared members
   * (per-task-derived) carry branch context (source/assignmentMode) without a
   * groupId so they are never swept into a shared group by the legacy
   * synthetic-groupId membership fallback (see filterTasksByBranchGroup).
   */
  groupId?: string;
  source: TaskBranchGroupSource;
  assignmentMode: TaskBranchAssignmentMode;
  inheritedBaseBranch?: string;
}

export type BranchGroupPrState = "none" | "open" | "merged" | "closed";

export type BranchGroupStatus = "open" | "finalized" | "abandoned";

export interface BranchGroup {
  id: string;
  sourceType: TaskBranchGroupSource;
  sourceId: string;
  branchName: string;
  worktreePath?: string;
  autoMerge: boolean;
  prState: BranchGroupPrState;
  prUrl?: string;
  prNumber?: number;
  status: BranchGroupStatus;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

export interface BranchGroupCreateInput {
  sourceType: TaskBranchGroupSource;
  sourceId: string;
  branchName: string;
  worktreePath?: string;
  autoMerge?: boolean;
  prState?: BranchGroupPrState;
  prUrl?: string;
  prNumber?: number;
  status?: BranchGroupStatus;
  closedAt?: number;
}

export interface BranchGroupUpdate {
  sourceId?: string;
  branchName?: string;
  worktreePath?: string | null;
  autoMerge?: boolean;
  prState?: BranchGroupPrState;
  prUrl?: string | null;
  prNumber?: number | null;
  status?: BranchGroupStatus;
  closedAt?: number | null;
}

// --- Unified PR entity (feat: PR lifecycle as workflow nodes, U1) ---
//
// The single first-class record of a pull request fusion manages, regardless
// of how the work landed (a lone task or a shared branch group). Its lifecycle
// is driven by the pr-create / pr-respond / pr-merge workflow nodes; the only
// writers of the GitHub-mirror fields are the pr-create node (on a confirmed
// create) and the reconcile (R4: never persist state GitHub has not
// corroborated).

/** What a PR entity is attached to. */
export type PrEntitySourceType = "task" | "branch-group";

/**
 * Lifecycle state. Non-terminal: creating, open, responding. Terminal: merged,
 * closed. failed is a recorded, retryable creation failure (R4).
 */
export type PrEntityState =
  | "creating"
  | "open"
  | "responding"
  | "merged"
  | "closed"
  | "failed";

/** GitHub review decision mirror (matches PrInfo.lastReviewDecision shape). */
export type PrReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED"
  | null;

/** Aggregate CI rollup mirror (matches PrInfo.checkRollup shape). */
export type PrChecksRollup = "success" | "failure" | "pending" | "none";

export interface PrEntity {
  id: string;
  sourceType: PrEntitySourceType;
  /** Task id or branch-group id, depending on sourceType. */
  sourceId: string;
  repo: string;
  headBranch: string;
  baseBranch?: string;
  state: PrEntityState;
  /** GitHub-mirror fields — only the create node and reconcile write these. */
  prNumber?: number;
  prUrl?: string;
  headOid?: string;
  mergeable?: PrConflictState;
  checksRollup?: PrChecksRollup;
  reviewDecision?: PrReviewDecision;
  /** Whether auto-merge is opted in for this entity (R10). */
  autoMerge: boolean;
  /**
   * Imported-from-legacy state that GitHub has not yet corroborated. While true
   * the entity is a hard gate: excluded from auto-merge + response dispatch and
   * never advanced on stale state (R19). Cleared on first successful reconcile.
   */
  unverified: boolean;
  /** Classified failure reason when state === "failed" (R4, AE3). */
  failureReason?: string;
  /** Rework-cycle counter backing the R8 iteration cap (survives restart). */
  responseRounds: number;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

export interface PrEntityCreateInput {
  sourceType: PrEntitySourceType;
  sourceId: string;
  repo: string;
  headBranch: string;
  baseBranch?: string;
  state?: PrEntityState;
  autoMerge?: boolean;
  unverified?: boolean;
  prNumber?: number;
  prUrl?: string;
}

export interface PrEntityUpdate {
  state?: PrEntityState;
  prNumber?: number | null;
  prUrl?: string | null;
  headOid?: string | null;
  mergeable?: PrConflictState | null;
  checksRollup?: PrChecksRollup | null;
  reviewDecision?: PrReviewDecision;
  autoMerge?: boolean;
  unverified?: boolean;
  failureReason?: string | null;
  responseRounds?: number;
  closedAt?: number | null;
}

/** Per-thread response outcome, keyed by thread id + head OID (R15). */
export type PrThreadOutcome = "fixed" | "disagreed" | "pending";

export interface PrThreadState {
  prEntityId: string;
  /** GitHub review-thread node id. */
  threadId: string;
  /** Head OID the outcome was produced against (idempotency key with threadId). */
  headOid: string;
  outcome: PrThreadOutcome;
  /** Commit SHA embedded in the agent's reply marker, when a fix was pushed. */
  fixCommitSha?: string;
  updatedAt: number;
}

/**
 * FNXC:Lifecycle 2026-07-16-09:40:
 * FN-8141 cross-stage overseer memory. FN-8141 was laundered into `done`
 * because the planner overseer is stage-scoped and memoryless: it emitted
 * `stage=executor signal=failed` (parked failed with work incomplete) twice,
 * then an hour later saw `stage=merger signal=progressing` and let an empty
 * no-op merge finalize the task `done` — nothing connected the failed executor
 * verdict to the merger's finalize decision.
 *
 * This is the derived (NOT persisted-as-a-column) most-recent executor-stage
 * overseer signal, reconstructed on demand from the durable
 * `overseer:intervention` timeline the overseer already writes (see
 * `deriveExecutorSignalMemory` in the engine). It is the evidence the
 * merger-layer no-op-finalize veto (`evaluateNoOpFinalizeExecutorVeto`) reads
 * to refuse completing a zero-diff task whose executor never finished green.
 * Since the executor stage only exists while a task is `in-progress`, a later
 * green re-execution appends a non-`failed` executor observation that becomes
 * the newest entry (clearing `incompleteWork`) — this is how "no subsequent
 * execution completed green" is derived: the memory always reflects the LATEST
 * executor observation.
 */
export interface ExecutorOverseerSignalMemory {
  /** The most recent executor-stage `OverseerObservationSignal` (bare string to avoid pulling the engine stage taxonomy into core). */
  signal: string;
  /**
   * True iff `signal` is the failed-with-incomplete-work executor shape
   * (the overseer's `signal: "failed"` executor observation — "Executor stage
   * parked failed with work incomplete"). A later `progressing`/`complete`/etc.
   * executor observation supersedes it, deriving `false`.
   */
  incompleteWork: boolean;
  /** epoch-ms (or intervention-entry timestamp) of the observation that produced this memory. */
  observedAt: number;
}

export interface Task {
  id: string;
  /** Immutable lineage identity used for durable commit/task attribution. */
  lineageId?: string;
  /** Stable task-proposal idempotency key; unique per project when present. */
  proposalClaimId?: string;
  title?: string;
  description: string;
  /**
   * Task importance level. Missing legacy values normalize to `normal` when
   * tasks are hydrated from persistence.
   */
  priority?: TaskPriority;
  /** The task's current column id. Widened to {@link ColumnId} so workflow-defined
   *  custom columns are representable; flag-OFF paths only ever store legacy ids. */
  column: ColumnId;
  /** Source column captured when this task is archived; used to restore sensibly. */
  preArchiveColumn?: Column;
  dependencies: string[];
  /** User-requested hint for triage: prefer splitting into child tasks when appropriate. */
  breakIntoSubtasks?: boolean;
  /** When true, this decision-only task is expected to complete without creating git commits. */
  noCommitsExpected?: boolean;
  worktree?: string;
  /**
   * Workspace mode only. Keyed by repo path relative to workspace rootDir.
   * Each entry records the on-disk worktree path and git branch for one sub-repo.
   *
   * FNXC:Workspace 2026-06-21-20:10:
   * `baseCommitSha` is the per-repo fork-point captured at acquisition (U2/KTD3)
   * against that sub-repo's RESOLVED integration branch, local-first. It is the
   * per-repo analogue of the single-repo base-commit capture and prevents
   * cross-repo files-changed inflation when local integration is ahead of origin.
   *
   * FNXC:Workspace 2026-06-22-00:30 (Phase C U2, KTD3):
   * `landedSha` is the per-repo "this repo's branch has landed on its local
   * integration ref" marker, set by `landWorkspaceTask` after a sub-repo's squash
   * advances that repo's ref. It is the ONLY partial-land state added (no new
   * status type): a re-run's landed predicate skips a repo whose `landedSha` is
   * present AND whose recorded value is an ancestor of (or equals) the repo's
   * integration tip, so an interrupted multi-repo land retries only the un-landed
   * repos and never re-advances an already-landed ref (idempotent retry).
   */
  workspaceWorktrees?: Record<string, { worktreePath: string; branch: string; baseCommitSha?: string; landedSha?: string }>;
  steps: TaskStep[];
  currentStep: number;
  /**
   * Workflow-defined custom task field values (KTD-13), keyed by field id.
   * Persisted as the `tasks.customFields` JSON column. Treated as opaque by
   * the core row⇄Task mapping and `updateTask`; the validation/write authority
   * (type/enum/render checks against the workflow's field schema) lands in a
   * later unit. Absent on legacy tasks.
   */
  customFields?: Record<string, unknown>;
  status?: string;
  /**
   * FNXC:TaskActivity 2026-07-28-12:00:
   * Dashboard-only signal from a fresh planner agent-log SSE entry. It is never
   * persisted or sent to the server; authoritative task updates clear it.
   */
  recentAgentActivityAt?: string;
  /** ID of the in-progress task whose file scope overlaps with this task,
   *  causing the scheduler to defer it. Set when the scheduler queues
   *  the task due to file-scope overlap; cleared (set to `undefined`)
   *  when the task is eventually started or moved to done. */
  blockedBy?: string;
  /** ID of the in-progress/in-review task whose file scope overlaps with this task's
   *  file scope, causing the scheduler to defer dispatch. Set independently of
   *  `blockedBy` so overlap state survives dependency-based blockedBy transitions.
   *  Cleared when the overlap resolves (the blocker task moves to done or its
   *  scope no longer overlaps). */
  overlapBlockedBy?: string;
  /** When true, all automated agent and scheduler interaction is suspended. */
  paused?: boolean;
  /** When true, this task was explicitly moved back to todo by a user and should not auto-dispatch. */
  userPaused?: boolean;
  /** Optional machine-readable reason for automated pauses (for example dispatch-storm). */
  pausedReason?: string;
  /** ISO timestamp set when the task first crossed the soft token budget cap. */
  tokenBudgetSoftAlertedAt?: string;
  /** ISO timestamp marking first one-shot alert when worktrunk failed and fell back to native backend. */
  worktrunkFallbackAlertedAt?: string;
  /** Structured details for a fail-hard worktrunk operation failure. */
  worktrunkFailure?: {
    op: "create" | "sync" | "prune" | "remove" | "install" | "resolve-binary";
    stderr?: string;
    exitCode?: number | null;
    attemptedAt: string;
  };
  /** ISO timestamp set when the task first crossed the hard token budget cap. */
  tokenBudgetHardAlertedAt?: string;
  /** Optional per-task budget override set by an operator on resume. */
  tokenBudgetOverride?: TaskTokenBudgetOverride;
  /** Dispatch-storm cycle counter tracked by scheduler for todo↔in-progress loop detection. */
  dispatchStormCount?: number;
  /** ISO timestamp of the most recent dispatch-storm cycle increment. */
  lastDispatchAt?: string;
  /** When set, this task was paused because the agent with this ID was paused. Cleared when the agent resumes. Distinct from user-initiated pause. */
  pausedByAgentId?: string;
  /** Configured merge target/base branch for this task (task intent).
   *  Defaults to the project default branch when omitted. */
  baseBranch?: string;
  /** Per-task auto-merge override.
   *  `undefined` means no explicit per-task value: follow live `settings.autoMerge`.
   *  `true`/`false` are explicit overrides when paired with `autoMergeProvenance: "user"`.
   *  Distinct from GitHub PR metadata (`PrInfo.autoMergeOnGreen` /
   *  `PrInfo.autoMergeStrategy`), which must not be conflated with this field. */
  autoMerge?: boolean;
  /** Provenance for `autoMerge`.
   *  `"user"` means a sticky explicit user-set override.
   *  `"legacy-stamp"` means an ambiguous value written by the pre-FN-6245
   *  review-entry stamp and is operator-clearable. Absent means unknown/none. */
  autoMergeProvenance?: "user" | "legacy-stamp";
  /** Actual git working branch name used for this task's worktree. May differ from
   *  the conventional `fn/{task-id}` when conflict recovery generated a
   *  unique suffixed name (e.g., `fn/fn-042-2`). */
  branch?: string;
  /** Optional planning/mission branch-group metadata carried across related tasks. */
  branchContext?: TaskBranchContext;
  /** Internal execution-only provenance for dependency-start handoff.
   *  When set, the scheduler asked executor to start from an upstream dependency
   *  branch. This is transient execution state and should be cleared after use. */
  executionStartBranch?: string;
  /** Base commit SHA for creating this task's worktree. Used with the start ref
   *  chosen for the worktree to establish the exact starting point. */
  baseCommitSha?: string;
  /**
   * Executor-time snapshot of `git diff <baseCommitSha>..HEAD` captured in the
   * task worktree (`TaskExecutor.captureModifiedFiles`).
   *
   * This may be a stale/transient superset of files that actually landed after
   * merge resolution or follow-up commits. Done-task cards must not use this
   * field for their files-changed chip; the authoritative landed diff comes
   * from `/api/tasks/:id/diff`, with `mergeDetails.landedFiles` as committed
   * metadata fallback when live stats are unavailable.
   */
  modifiedFiles?: string[];
  /** Durable normalized symbol declarations used by scheduler admission. */
  declaredSymbols?: string[];
  /** Opt out of the squash file-scope invariant for this task. */
  scopeOverride?: boolean;
  /** Optional justification for bypassing the squash file-scope invariant. */
  scopeOverrideReason?: string;
  /** Append-only list of file paths auto-widened into `## File Scope` by merger safety checks. */
  scopeAutoWiden?: string[];
  /** Mission ID this task is linked to (for mission hierarchy) */
  missionId?: string;
  /** Slice ID this task is linked to (for mission hierarchy) */
  sliceId?: string;
  attachments?: TaskAttachment[];
  steeringComments?: SteeringComment[];
  comments?: TaskComment[];
  /** Structured review metadata shown in the Review tab (legacy contract). */
  review?: TaskReview;
  /** Structured review metadata shown in the Review tab (canonical contract). */
  reviewState?: TaskReviewState;
  /** PR information for tasks linked to GitHub pull requests */
  prInfo?: PrInfo;
  /** Canonical list of linked PRs; prInfo mirrors the primary PR for back-compat. */
  prInfos?: PrInfo[];
  mergeDetails?: MergeDetails;
  /** Issue information for tasks imported from GitHub issues */
  issueInfo?: IssueInfo;
  /**
   * Per-task tracking metadata for Fusion-emitted GitHub issues.
   * Distinct from issueInfo/sourceIssue, which describe imported source issues.
   */
  githubTracking?: TaskGithubTracking;
  /** Durable source provenance for task creation/import metadata. */
  source?: TaskSource;
  /** Durable source provenance for the originating external issue. */
  sourceIssue?: TaskSourceIssue;
  /** Linked GitLab tracking metadata for GitLab.com and self-managed GitLab items. */
  gitlabTracking?: TaskGitLabTracking;
  log: TaskLogEntry[];
  /** Pre-aggregated sum of `[timing] … in <N>ms` log durations, in milliseconds.
   *  Computed server-side so slim board listings can render the card timer
   *  without shipping the full agent log. The TaskDetailModal still derives
   *  this on the fly from `log`, so this field is only populated by the slim
   *  list path and may be omitted on the full-detail object. */
  timedExecutionMs?: number;
  /** Server-computed in-review stall signal. Undefined when no stall rule matches.
   *  Diagnostic-only: must not be used as an auto-completion signal. */
  inReviewStall?: InReviewStallSignal;
  /** Server-computed task age staleness signal. Undefined when no staleness rule matches.
   *  Diagnostic-only: must not be used as an auto-completion signal. */
  ageStaleness?: TaskAgeStalenessSignal;
  /** Server-computed stale paused review diagnostic signal. Undefined when no rule matches.
   *  Diagnostic-only: must not trigger automatic state mutation. */
  stalePausedReview?: StalePausedReviewSignal;
  /** Server-computed in-review quiet-window diagnostic signal. Undefined when no rule matches.
   *  Diagnostic-only: must not trigger automatic state mutation. */
  inReviewStalled?: InReviewStalledSignal;
  /** Server-computed stale paused todo diagnostic signal. Undefined when no rule matches.
   *  Diagnostic-only: must not trigger automatic state mutation. */
  stalePausedTodo?: StalePausedTodoSignal;
  /*
   * FNXC:WorkflowNotifications 2026-06-29-12:44:
   * Workflow transition notifications should use typed task state instead of
   * parsing human-readable task log text. Producers set this marker when a
   * workflow transition needs operator notification; NotificationService only
   * consumes it while the task remains in the recorded target column. The marker
   * column prevents stale task movement from triggering a later notification,
   * and transitionId provides stable dedupe across repeated task:updated events.
   */
  workflowTransitionNotification?: WorkflowTransitionNotificationMarker;
  /** Heuristic stalled-review diagnostic signal (legacy compatibility contract). */
  stalledReview?: StalledReviewSignal;
  /** Durable aggregate token usage totals for the task. Undefined when no usage has been recorded yet. */
  tokenUsage?: TaskTokenUsage;
  size?: "S" | "M" | "L";
  reviewLevel?: number;
  /** Model preset selected during task creation. Presets resolve to concrete model overrides at creation time. */
  modelPresetId?: string;
  /** AI model provider override for the executor agent (e.g., "anthropic").
   *  Must be set together with `modelId`. When both model fields are undefined,
   *  the executor uses global settings defaults. */
  modelProvider?: string;
  /** AI model ID override for the executor agent (e.g., "claude-sonnet-4-5").
   *  Must be set together with `modelProvider`. When both model fields are undefined,
   *  the executor uses global settings defaults. */
  modelId?: string;
  /** AI model provider override for the validator/reviewer agent.
   *  Must be set together with `validatorModelId`. When both validator model fields
   *  are undefined, the reviewer uses global settings defaults. */
  validatorModelProvider?: string;
  /** AI model ID override for the validator/reviewer agent.
   *  Must be set together with `validatorModelProvider`. When both validator model
   *  fields are undefined, the reviewer uses global settings defaults. */
  validatorModelId?: string;
  /** AI model provider override for the planning/triage agent.
   *  Must be set together with `planningModelId`. When both planning model fields
   *  are undefined, the triage agent uses global settings defaults. */
  planningModelProvider?: string;
  /** AI model ID override for the planning/triage agent.
   *  Must be set together with `planningModelProvider`. When both planning model
   *  fields are undefined, the triage agent uses global settings defaults. */
  planningModelId?: string;
  /**
   * FNXC:Settings-MergerModel 2026-07-16-12:00:
   * Per-task merger overrides take precedence over the project/global merger lane only when both fields are set; merger sessions otherwise retain their existing settings-based resolution.
   */
  mergerModelProvider?: string;
  /** Must be set together with `mergerModelProvider`. */
  mergerModelId?: string;
  /** IDs of workflow steps enabled for this task, run after implementation completes */
  enabledWorkflowSteps?: string[];
  /** Results from workflow step executions (populated after task implementation) */
  workflowStepResults?: WorkflowStepResult[];
  /** Number of merge retry attempts made for this task (auto-merge conflict recovery) */
  mergeRetries?: number;
  /** Number of workflow step failure retry attempts made for this task.
   *  When pre-merge workflow steps fail, the executor retries up to MAX_WORKFLOW_STEP_RETRIES
   *  times before marking the task as failed. Cleared on successful workflow step completion. */
  workflowStepRetries?: number;
  /** Number of times the stuck-task detector has killed this task's agent session.
   *  Incremented by the self-healing manager on each stuck kill. When this reaches
   *  `maxStuckKills`, the task is marked as permanently failed instead of re-queued. */
  stuckKillCount?: number;
  /** Number of consecutive reclaim/unpause attempts where no execution progress
   *  materialized (tip unchanged, step signature unchanged, and no active session).
   *  Incremented by self-healing for resume-limbo detection and reset when
   *  progress is observed or recovery escalates to a fresh todo dispatch. */
  resumeLimboCount?: number;
  /**
   * FNXC:WorkflowLifecycle 2026-07-12-00:00:
   * FN-7863 bounds execute-node self-requeue loops by counting consecutive requeues
   * that preserve the same execution-progress signature. Reset this counter on real
   * progress, forward moves, and manual retry; the executor caps it before writing
   * terminal status:"failed" so committed work and step progress remain visible.
   */
  executeRequeueLoopCount?: number;
  /** Bounded auto-retry attempts for transient workflow-graph failures observed
   *  immediately after engine-restart or unpause resume. Reset by manual retry
   *  and by successful forward progress; capped by the executor before terminal
   *  `status:"failed"` is recorded to preserve the FN-5704 anti-loop exemption. */
  graphResumeRetryCount?: number | null;
  /**
   * FNXC:ExecutorToolFailureRetry 2026-07-16-12:00:
   * FN-7996 persists the bounded same-model retry budget for consecutive terminal tool errors. The executor atomically claims it per run cursor so concurrent failures cannot exceed the configured cap.
   */
  consecutiveToolFailureRetryCount?: number | null;
  /**
   * FNXC:ExecutorEscalation 2026-07-16-21:00:
   * Records consumption of the one opt-in alternate model/node attempt after FN-7996 exhausts same-model retries. Reset with the retry window so unrelated failure surfaces receive their own bounded escalation.
   */
  executorEscalationAttempted?: boolean | null;
  /** Agent-log boundary captured at executor-run start; only later terminal outcomes qualify. */
  toolFailureDetectorLogCursor?: number | null;
  /** Durable compare-and-set marker which permits one exhaustion audit per retry window. */
  toolFailureRetryExhaustedAuditEmitted?: boolean | null;
  /** Branch tip SHA snapshot captured at the last reclaim/unpause attempt used
   *  by resume-limbo detection to determine whether commits advanced. */
  resumeLimboTipSha?: string;
  /** Compact execution-progress snapshot captured at the last reclaim/unpause
   *  attempt (current step + step statuses) for resume-limbo detection. */
  resumeLimboStepSignature?: string;
  /** Compact execution-progress snapshot captured at the last execute-node
   *  self-requeue (current step + step statuses) for FN-7863 loop detection. */
  executeRequeueLoopSignature?: string;
  /** Number of times workflow remediation has auto-revived this task after
   *  failed pre-merge review feedback. Incremented each time the engine sends the
   *  task back with failure feedback injected. Capped only when the workflow step
   *  resolves to a numeric maxRevisions/maxPostReviewFixes budget; built-in Code
   *  Review defaults to unbounded recovery so ordinary REVISE feedback does not
   *  terminal-fail the task. */
  postReviewFixCount?: number;
  /** Number of consecutive triage pre-execution Plan Review REVISE replans this task
   *  has consumed. Incremented by the triage Plan Review gate
   *  (packages/engine/src/triage.ts runPlanReviewBeforeExecution) each time it blocks
   *  execution with a REVISE verdict and routes the task back to `needs-replan`. When it
   *  reaches `PLAN_REVIEW_GATE_REPLAN_CAP` the task is escalated to `awaiting-approval`
   *  (awaitingApprovalReason `plan-review-replan-cap`) instead of replanning again, so a
   *  planner/reviewer disagreement can never loop forever. Reset when the gate passes
   *  (APPROVE) or on a manual retry. Distinct from `postReviewFixCount`, which bounds the
   *  executor graph's post-merge/advisory optional-step REVISE budget. */
  planReviewReplanCount?: number;
  /** Number of bounded recovery retry attempts for transient executor/triage failures.
   *  Distinct from `mergeRetries` (merge-conflict-specific). Incremented by the
   *  recovery-policy module on each recoverable failure; cleared when work restarts
   *  cleanly or reaches a terminal column (in-review, done, archived). */
  recoveryRetryCount?: number;
  /** Number of times this task has been requeued after the agent exited without
   *  calling `task_done`. Incremented by the executor for immediate `todo`
   *  requeues and by self-healing for deferred recovery of partial-progress
   *  failures. Capped by `MAX_TASK_DONE_RETRIES`; when exhausted the task stays
   *  in `in-review` for human inspection. Cleared on successful completion. */
  taskDoneRetryCount?: number;
  /**
   * FNXC:Lifecycle 2026-07-16-21:40:
   * ISO-8601 timestamp stamped when the executor's `bulk-step-completion-without-review`
   * refusal fires for this task's current execution lifecycle (FN-8141). While set, any
   * step in `skipped` state is "tainted": it must not count toward AUTOMATIC promotion
   * (executor completion-finalize, self-healing stuck-in-progress / stranded-todo recovery,
   * graph merge boundary) — see `evaluateSkipBypassTaint`. Cleared on an honest exit: an
   * ACCEPTED fn_task_done (explicit or non-tainted implicit) or an operator manual retry.
   * Null/undefined means no active taint.
   */
  bulkCompletionRefusalAt?: string;
  /*
  FNXC:WorkflowIrPin 2026-07-19-03:10 (U9b / KTD-3):
  The workflow IR version/content hash this task resolved when ENTERING its current node,
  held until that node settles. `resolveWorkflowIrForTask` is live-per-call, so without a
  durable pin a workflow edited mid-flight silently changes the graph under a running task.
  On restart, recovery compares this pin against the current IR and parks with
  `task:reconcile-workflow-drift` on mismatch rather than traversing a mutated graph.
  */
  workflowIrPin?: string;
  /** The node entry {@link workflowIrPin} was taken for. Without it a restart cannot
   *  distinguish a stale pin from the current node's pin and every resumed task reads as
   *  drifted. */
  workflowIrPinNodeId?: string;
  /** The pinned node's column AT ENTRY, so drift detection flags a column deleted out
   *  from under the task even when the node id itself survives. */
  workflowIrPinColumnId?: string;
  /*
  FNXC:LegacyAdoption 2026-07-19-03:10 (U9b / R10 / KTD-8):
  ISO timestamp stamped once when store-open reconcile or the self-healing startup sweep
  adopts this pre-cutover row through the KTD-8 adoption table. Makes adoption idempotent
  across restarts (never re-clear a status a human has since re-set, never re-park a row an
  operator un-parked) and makes "zero frozen rows" provable: an un-stamped legacy row is by
  definition one adoption never reached.
  */
  legacyAdoptedAt?: string;
  /** Number of times self-healing auto-requeued an `in-review` task that failed
   *  at session start with an unusable-worktree error. Bounded by
   *  `MAX_WORKTREE_SESSION_RETRIES`; when exhausted the task remains parked in
   *  `in-review` for human inspection. Cleared on successful completion / move
   *  out of failed state by the executor. */
  worktreeSessionRetryCount?: number;
  /** Number of completion-handoff limbo recoveries attempted for this task.
   *  Incremented by self-healing when an `in-review` task has a stale
   *  "Task marked done by agent" marker but no merge fan-out state.
   *  Capped by `MAX_COMPLETION_HANDOFF_LIMBO_RECOVERIES`; exhaustion leaves
   *  the task failed in-review for human inspection. */
  completionHandoffLimboRecoveryCount?: number;
  /** Number of times this task has bounced from `in-review` back to `in-progress`
   *  due to a deterministic verification failure during auto-merge. Incremented
   *  by the auto-merge error handler (project-engine.ts). When this reaches
   *  `MAX_VERIFICATION_FAILURE_BOUNCES`, the task is marked failed and a
   *  follow-up triage task is created so a human / fresh agent can investigate
   *  rather than endlessly re-attempting the same fix. */
  verificationFailureCount?: number;
  /** Number of times this task has bounced from `in-review` back to `in-progress`
   *  due to auto-merge conflict-retry exhaustion. Incremented by the auto-merge
   *  error handler (project-engine.ts) when conflicts can't be auto-resolved
   *  within `MAX_AUTO_MERGE_RETRIES`. When this reaches
   *  `MAX_MERGE_CONFLICT_BOUNCES`, the task is parked in `in-review` with
   *  `status="failed"` and a follow-up triage task is created — preventing the
   *  cooldown sweep from re-attempting the same impossible merge forever. */
  mergeConflictBounceCount?: number;
  /** Number of times this task has bounced from `in-review` back to `in-progress`
   *  due to post-merge audit recovery escalation. Incremented by the auto-merge
   *  error handler (project-engine.ts) when a `SquashAuditError` remains unresolved
   *  after deterministic/programmatic/AI recovery passes. When this reaches
   *  `MAX_MERGE_AUDIT_BOUNCES`, the task is parked with `status="failed"` and a
   *  recovery follow-up task is created. */
  mergeAuditBounceCount?: number;
  /** Number of transient auto-merge retries consumed after provider/network abort
   *  errors (for example AbortError, socket hang up, server_error payloads).
   *  Distinct from `mergeRetries` (in-cycle conflict retries) and
   *  `mergeConflictBounceCount` (in-review→in-progress conflict bounces).
   *  Bounded by `MAX_AUTO_MERGE_TRANSIENT_RETRIES`; once exhausted, the task is
   *  parked with `status="failed"` instead of re-enqueued. */
  mergeTransientRetryCount?: number;
  /** Number of branch-conflict recovery attempts consumed by executor branch
   *  conflict auto-recovery loops. Incremented once per recovery retry attempt. */
  branchConflictRecoveryCount?: number;
  /** Number of reviewer context-limit retries consumed by FN-4082 compact
   *  reviewer-request fallback handling. */
  reviewerContextRetryCount?: number;
  /** Number of reviewer fallback retries consumed by FN-4092 fallback-model
   *  and same-model strict-prompt retry paths. */
  reviewerFallbackRetryCount?: number;
  /** Derived retry aggregation computed at read time from retry counters.
   *  This field is not persisted to SQLite. */
  retrySummary?: RetrySummary;
  /** ISO-8601 timestamp indicating when the task becomes eligible for the next
   *  recovery retry. Scheduler and triage processor skip tasks whose
   *  `nextRecoveryAt` is still in the future. Cleared alongside `recoveryRetryCount`. */
  nextRecoveryAt?: string;
  /*
   * FNXC:ReleaseAuthorizationGate 2026-07-09-00:00:
   * DEPRECATED — the triage release-authorization gate that set this field was removed
   * (it over-fired on AI-authored specs that merely mention release tooling and stranded
   * ordinary tasks in "awaiting-approval" with no in-band exit). No code writes
   * "release-authorization" anymore; releases are kept out of Fusion by agent instruction
   * (AGENTS.md → "Releasing"), not an engine gate. The field is retained only so existing
   * task rows persisted with the legacy value still deserialize; the dashboard treats
   * that legacy value as an ordinary manual plan-approval hold (Approve/Reject Plan render
   * normally).

   * FNXC:PlanReviewReplan 2026-07-15-11:09:
   * Live writer: triage Plan Review REVISE replan-cap escalation stamps
   * `plan-review-replan-cap` when automatic REVISE replans hit PLAN_REVIEW_GATE_REPLAN_CAP.
   * Dashboard badge/detail banner/notifications must surface that reason so operators know
   * approval is required because Plan Review did not converge — not a generic require-all gate.
   * Undefined means either no hold or a routine manual plan-approval hold.
   */
  awaitingApprovalReason?: "release-authorization" | "plan-review-replan-cap";
  /*
   * FNXC:PlanApproval 2026-07-04-22:41:
   * FN-7569 — records the computePlanApprovalFingerprint (packages/core/src/plan-approval.ts)
   * hash of the exact PROMPT.md content an operator last approved via POST /tasks/:id/approve-plan.
   * The manual plan-approval gate (packages/engine/src/triage.ts finalizeApprovedTask) compares this
   * against the freshly written PROMPT.md on every re-specification (replan, plan-review retry,
   * self-healing rebound to triage) and skips re-parking at "awaiting-approval" when they match, so an
   * unchanged, already-approved plan is never re-asked. A genuine spec change produces a different
   * fingerprint and still re-asks. POST /tasks/:id/reject-plan clears this field (null) alongside
   * deleting PROMPT.md so the regenerated plan is treated as new. Stores only a hash, never plan text.
   * Additive-only, nullable: legacy/never-approved rows stay NULL and behave exactly as before.
   */
  approvedPlanFingerprint?: string;
  /** Thinking level for AI agent sessions — controls reasoning effort (off/minimal/low/medium/high) */
  thinkingLevel?: ThinkingLevel;
  /**
   * FNXC:Settings-ThinkingLevel 2026-07-13-00:27:
   * Validator and planning task fields are optional per-lane reasoning-effort overrides. When unset, those lanes inherit the shared task `thinkingLevel`, then existing settings and lane fallbacks.
   */
  validatorThinkingLevel?: ThinkingLevel;
  planningThinkingLevel?: ThinkingLevel;
  /** Independent per-task merger reasoning-effort override; unset inherits merger settings. */
  mergerThinkingLevel?: ThinkingLevel;
  /** Execution mode for task implementation.
   *  - "standard": Full execution with complete review workflow (default)
   *  - "fast": Expedited execution with minimal overhead for simple tasks
   *  Defaults to "standard" when not specified. */
  executionMode?: ExecutionMode;
  /** Per-task override of the workflow-native planner oversight level (FNXC:PlannerOversight).
   *  When set, wins over the workflow's effective `plannerOversightLevel`. Unset means
   *  "inherit workflow default" — see `resolveEffectivePlannerOversightLevel` in
   *  workflow-settings-resolver.ts for precedence. */
  plannerOversightLevel?: PlannerOversightLevel;
  /**
   * FNXC:PlannerOversight 2026-07-14-18:11:
   * Per-task override for the session advisor (LLM overseer agent). `true`/`false` force
   * on/off for this task; unset inherits `sessionAdvisorEnabledByDefault` from project
   * settings (then workflow `plannerOverseerAdvisorEnabled` for backward compat).
   * See `resolveTaskSessionAdvisorEnabled` in session-advisor.ts.
   */
  sessionAdvisorEnabled?: boolean;
  /**
   * FNXC:PlannerOversight 2026-07-04-00:00:
   * FN-7531 transient, engine-populated snapshot of the planner overseer's
   * current runtime state (idle/watching/steering/recovering/awaiting-
   * confirmation), assembled from the FN-7511 `PlannerOverseerMonitor` +
   * FN-7512/FN-7513 `PlannerRecoveryController` registries. Attached
   * best-effort to the `GET /api/tasks` payload (mirroring the additive
   * `branchProgress` board-payload convention) — NEVER written to the
   * store or task.json. Consumed by FN-7516's `TaskCard` badge.
   */
  plannerOverseerState?: PlannerOverseerRuntimeSnapshot;
  /** Explicitly assigned agent ID for task-agent linking. Distinct from Agent.taskId active execution state. */
  assignedAgentId?: string;
  /** Per-task node override. When set, this task routes to the specified node instead of the project's default node. Undefined means use the project default. Use empty string to explicitly clear. */
  nodeId?: string;
  /** The node this task is actually routed to (resolved from nodeId override or project default). Set by the scheduler at dispatch time. */
  effectiveNodeId?: string;
  /** How the effectiveNodeId was determined. Set by the scheduler at dispatch time. */
  effectiveNodeSource?: "task-override" | "project-default" | "local";
  /** Provenance: how this task was created. */
  sourceType?: SourceType;
  sourceAgentId?: string;
  sourceRunId?: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
  sourceParentTaskId?: string;
  sourceMetadata?: Record<string, unknown>;
  /** Reconstructed task prompt content when available on in-memory execution tasks. */
  prompt?: string;
  /** Explicitly assigned user ID for task-user linking. Used during review handoff to indicate
   *  which user should review the task. The sentinel value "requesting-user" indicates the
   *  user who created or steered the task. */
  assigneeUserId?: string;
  /** Agent ID currently holding the checkout lease for this task. Undefined when no active lease. */
  checkedOutBy?: string;
  /** ISO-8601 timestamp when the checkout lease was acquired. */
  checkedOutAt?: string;
  /** Node ID currently owning the checkout lease. */
  checkoutNodeId?: string;
  /** Owning run/session ID for the checkout lease when known. */
  checkoutRunId?: string;
  /** ISO-8601 timestamp of the last successful lease renewal heartbeat. */
  checkoutLeaseRenewedAt?: string;
  /** Monotonically increasing lease generation used to prevent stale reclaim attempts. */
  checkoutLeaseEpoch?: number;
  /** Path to the persisted agent session file, enabling pause/resume without
   *  losing conversation context. Set when execution starts; cleared on
   *  completion or terminal failure. */
  sessionFile?: string;
  /** Error message from the last failure, if the task failed during execution */
  error?: string;
  /** Optional summary of what was changed/fixed when task is completed */
  summary?: string;
  /** ISO-8601 timestamp of when the task last entered its current column.
   *  Used to sort cards within a column so that recently-moved cards appear at the top. */
  columnMovedAt?: string;
  /** ISO-8601 wall-clock timestamp for the first-ever transition into `in-progress`.
   *  Immutable once set: never cleared or overwritten across retries, reopens,
   *  recovery bounces, or user-initiated moves. */
  firstExecutionAt?: string;
  /** Accumulated milliseconds spent in `in-progress` across all attempts.
   *  Incremented whenever the task leaves `in-progress`; never decremented and
   *  never cleared by reopen flows. */
  cumulativeActiveMs?: number;
  /**
   * FNXC:TaskTiming 2026-08-01-10:00:
   * Monotonic active AI planning duration. Unlike column dwell this is only
   * accrued by a live planning session and is never cleared by reopen.
   */
  cumulativePlanningMs?: number;
  /** Open planning AI segment; finalized exactly once into cumulativePlanningMs. */
  planningStartedAt?: string;
  /*
  FNXC:TaskTiming 2026-06-26-10:14:
  Per-stage dwell-time instrumentation. `cumulativeActiveMs` only measures `in-progress`,
  so "how long did a task sit in todo / in-review" was unrecoverable without reconstructing
  it from agent logs. This map records cumulative wall-clock milliseconds spent in EACH
  column (column name -> total ms), accumulated at the column-transition seam in store.ts
  exactly like `cumulativeActiveMs`: on every transition we add the dwell of the column being
  LEFT (newColumnMovedAt - previousColumnMovedAt, clamped >= 0). Multi-visit columns add to
  the existing bucket; never decremented and never cleared by reopen flows. Directly queryable
  per stage by consumers like productivity-analytics.ts.
  */
  columnDwellMs?: Record<string, number>;
  /** ISO-8601 wall-clock timestamp for the current execution attempt.
   *  Set when entering `in-progress`; may be cleared on reopen to
   *  todo/triage when resume state is not preserved. */
  executionStartedAt?: string;
  /** ISO-8601 wall-clock timestamp when the task first reached `done`.
   *  Set once on first transition to `done`; may be cleared on reopen to
   *  todo/triage when resume state is not preserved. */
  executionCompletedAt?: string;
  deletedAt?: string;
  allowResurrection?: boolean;
  createdAt: string;
  updatedAt: string;
}

/*
FNXC:Workspace 2026-06-21-19:05:
R7 workspace merge-boundary guard (master-plan U0). Workspace-mode tasks populate
`task.workspaceWorktrees` (one git worktree per sub-repo); their merge must run a
per-repo loop that does NOT exist yet — it lands in master-plan U6. Until then, a
workspace task reaching ANY merge entry point (engine dispatch, store.mergeTask,
the CLI `onMergeImpl` / `runTaskMerge` callers) would run git operations against
the NON-GIT workspace root and crash. This single shared predicate is called at the
top of every merge door, BEFORE any git work, so the task is held with a clear,
actionable error instead. It lives in @fusion/core so all four call sites — including
store.mergeTask, which cannot import from @fusion/engine — share ONE implementation.
The guard throws a NAMED `WorkspaceTaskMergeError` so callers (e.g. the engine merge
dispatch catch) can distinguish this permanent config error from a transient merge
failure and avoid burning mergeRetries. Master-plan U6 REMOVES this guard when the
per-repo merge loop becomes the gate.
*/

/**
 * Error thrown by {@link assertNotWorkspaceTaskMerge} when a workspace-mode task
 * reaches a merge path. Named so callers can branch on it (e.g. park without
 * burning mergeRetries) rather than treating it as a transient merge failure.
 */
export class WorkspaceTaskMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceTaskMergeError";
  }
}

/**
 * Throws {@link WorkspaceTaskMergeError} when `task.workspaceWorktrees` has at least
 * one entry (a workspace-mode task). No-op for single-repo tasks. See the
 * FNXC:Workspace note above.
 * @param task the task about to enter a merge path
 */
export function assertNotWorkspaceTaskMerge(task: Pick<Task, "id" | "workspaceWorktrees">): void {
  if (isWorkspaceTask(task)) {
    throw new WorkspaceTaskMergeError(
      `Workspace task ${task.id} cannot merge until per-repo merge support (master-plan U6) lands`,
    );
  }
}

/*
FNXC:Workspace 2026-06-22-05:10 (Phase C review B5/B7-dep — canonical workspace predicate):
A workspace-mode task is identified by having at least one `workspaceWorktrees` entry
(one git worktree per sub-repo). This single predicate replaces the inlined
`!!task.workspaceWorktrees && Object.keys(task.workspaceWorktrees).length > 0` that was
copy-pasted across the engine merge dispatch and the merge-confirmed reachability fast-path
(B2). It lives in @fusion/core so the engine, store, and CLI doors share ONE definition.
The dashboard keeps its own local `isWorkspaceTask` (WorkspaceWorktreesSummary, UI-only) —
this core export is for engine/CLI use.
*/
export function isWorkspaceTask(task: Pick<Task, "workspaceWorktrees">): boolean {
  const worktrees = task.workspaceWorktrees;
  return !!worktrees && Object.keys(worktrees).length > 0;
}

export type RetrySummary = {
  stuckKill: number;
  recovery: number;
  taskDone: number;
  worktreeSession: number;
  workflowStep: number;
  verification: number;
  postReviewFix: number;
  mergeConflict: number;
  branchConflict: number;
  reviewerContext: number;
  reviewerFallback: number;
  total: number;
};

/*
FNXC:TaskVerificationRequest 2026-07-30-00:00:
Chat may request only a server-resolved verification profile. The persisted record
keeps executor-owned subprocess results observable without exposing raw commands.
*/
export type TaskVerificationStatus = "requested" | "running" | "passed" | "failed" | "rejected";
export type TaskVerificationProfile = "verify:fast" | "test-command";
export interface TaskVerificationResultSummary {
  success: boolean;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
}
export interface TaskVerificationRequest {
  taskId: string;
  requestId: string;
  status: TaskVerificationStatus;
  profile: TaskVerificationProfile;
  command: string;
  scope: "package" | "workspace";
  requestedBy: string;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: TaskVerificationResultSummary;
  rejectionReason?: string;
}

export interface TaskDetail extends Task {
  prompt: string;
  /** Derived aggregate of retry counters (computed on read; never persisted). */
  retrySummary?: RetrySummary;
}

/** A task candidate from the inbox-lite work selection, with metadata about why it was selected. */
export interface InboxTask {
  task: Task;
  priority: "in_progress" | "todo" | "blocked";
  reason: string;
}

export interface TaskCreateInput {
  title?: string;
  /** Optional lineage override for trusted replication/import paths only. */
  lineageId?: string;
  /** Stable task-proposal idempotency key; repeated creates return the same task. */
  proposalClaimId?: string;
  /**
   * Opt-in createTask override for soft-deleted ID reuse.
   * Not persisted to storage.
   */
  forceResurrect?: boolean;
  description: string;
  /** Configured merge target/base branch for this task (task intent).
   *  Defaults to the project default branch when omitted. */
  baseBranch?: string;
  /** Actual git working branch name used for this task's worktree. */
  branch?: string;
  /** Optional planning/mission branch-group metadata carried across related tasks. */
  branchContext?: TaskBranchContext;
  /** Optional per-task auto-merge override. Undefined means no task-level override. */
  autoMerge?: boolean;
  /** Durable source provenance for the originating external issue. */
  sourceIssue?: TaskSourceIssue;
  /** Linked GitLab tracking metadata for GitLab.com and self-managed GitLab items. */
  gitlabTracking?: TaskGitLabTracking;
  /** Optional persisted aggregate token usage snapshot for task creation/import paths. */
  tokenUsage?: TaskTokenUsage;
  /** Provenance metadata for task creation. */
  source?: TaskSource;
  /**
   * Optional task importance level. Omitted values default to `normal`.
   */
  priority?: TaskPriority;
  /** Initial column id. Widened to {@link ColumnId} (#1403) so a custom-column
   *  task can be replicated/created; flag-OFF creation only ever uses legacy ids. */
  column?: ColumnId;
  dependencies?: string[];
  breakIntoSubtasks?: boolean;
  /** When true, this task is expected to complete without creating git commits. */
  noCommitsExpected?: boolean;
  /** IDs of workflow steps to enable for this task */
  enabledWorkflowSteps?: string[];
  /**
   * Workflow selection applied atomically at task creation (U6/R3/KTD-4).
   *
   * Semantics:
   *  - `undefined` → inherit the project default workflow (today's behavior:
   *    `materializeDefaultWorkflowSteps` runs, falling back to default-on steps).
   *  - `null` → explicitly NO workflow: skip default materialization entirely;
   *    the task is created with no custom workflow steps.
   *  - `string` → that workflow's compiled steps are materialized and selected
   *    inside the creation flow, overriding any project default. Fragment IDs
   *    and unknown IDs are rejected with a clear error BEFORE the task row is
   *    created.
   *
   * Mutually exclusive with `enabledWorkflowSteps`: when `enabledWorkflowSteps`
   * is provided, it takes precedence and `workflowId` materialization is skipped.
   */
  workflowId?: string | null;
  /** Model preset selected during task creation. Presets resolve to concrete model overrides at creation time. */
  modelPresetId?: string;
  /** AI model provider override for the executor agent (e.g., "anthropic").
   *  Must be set together with `modelId`. When both model fields are undefined,
   *  the executor uses global settings defaults. */
  modelProvider?: string;
  /** AI model ID override for the executor agent (e.g., "claude-sonnet-4-5").
   *  Must be set together with `modelProvider`. When both model fields are undefined,
   *  the executor uses global settings defaults. */
  modelId?: string;
  /** AI model provider override for the validator/reviewer agent.
   *  Must be set together with `validatorModelId`. When both validator model fields
   *  are undefined, the reviewer uses global settings defaults. */
  validatorModelProvider?: string;
  /** AI model ID override for the validator/reviewer agent.
   *  Must be set together with `validatorModelProvider`. When both validator model
   *  fields are undefined, the reviewer uses global settings defaults. */
  validatorModelId?: string;
  /** AI model provider override for the planning/triage agent.
   *  Must be set together with `planningModelId`. When both planning model fields
   *  are undefined, the triage agent uses global settings defaults. */
  planningModelProvider?: string;
  /** AI model ID override for the planning/triage agent.
   *  Must be set together with `planningModelProvider`. When both planning model
   *  fields are undefined, the triage agent uses global settings defaults. */
  planningModelId?: string;
  /** Per-task merger override; provider and model id must be supplied together. */
  mergerModelProvider?: string;
  mergerModelId?: string;
  /** Thinking level for AI agent sessions — controls reasoning effort (off/minimal/low/medium/high) */
  thinkingLevel?: ThinkingLevel;
  /**
   * FNXC:Settings-ThinkingLevel 2026-07-13-00:27:
   * Validator and planning task fields are optional per-lane reasoning-effort overrides. When unset, those lanes inherit the shared task `thinkingLevel`, then existing settings and lane fallbacks.
   */
  validatorThinkingLevel?: ThinkingLevel;
  planningThinkingLevel?: ThinkingLevel;
  /** Independent per-task merger reasoning-effort override; unset inherits merger settings. */
  mergerThinkingLevel?: ThinkingLevel;
  /** When true, trigger AI title summarization if description is long and no title provided */
  summarize?: boolean;
  /** Mission ID to link this task to (for mission hierarchy) */
  missionId?: string;
  /** Slice ID to link this task to (for mission hierarchy) */
  sliceId?: string;
  /** Optional explicit agent assignment for this task */
  assignedAgentId?: string;
  /** Per-task node override. When set, this task routes to the specified node instead of the project's default node. Undefined means use the project default. Use empty string to explicitly clear. */
  nodeId?: string;
  /** Optional explicit user assignment for this task (used during review handoff) */
  assigneeUserId?: string;
  /** Opt out of the squash file-scope invariant for this task. */
  scopeOverride?: boolean;
  /** Optional justification for bypassing the squash file-scope invariant. */
  scopeOverrideReason?: string;
  /** Append-only list of file paths auto-widened into `## File Scope` by merger safety checks. */
  scopeAutoWiden?: string[];
  /** Optional declared symbols; own-property undefined is an explicit runtime clear. */
  declaredSymbols?: string[];
  /** Per-task GitHub issue tracking overrides for Fusion-created linked issues. */
  githubTracking?: Pick<TaskGithubTracking, "enabled" | "repoOverride">;
  /** Review level for task execution — controls review rigor: 0=None, 1=Plan Only, 2=Plan and Code, 3=Full */
  reviewLevel?: number;
  /** Execution mode for task implementation.
   *  - "standard": Full execution with complete review workflow (default)
   *  - "fast": Expedited execution with minimal overhead for simple tasks
   *  Defaults to "standard" when not specified. */
  executionMode?: ExecutionMode;
  /** Per-task override of the workflow-native planner oversight level (FNXC:PlannerOversight).
   *  When set, wins over the workflow's effective `plannerOversightLevel`. Unset means
   *  "inherit workflow default". */
  plannerOversightLevel?: PlannerOversightLevel;
  /**
   * FNXC:PlannerOversight 2026-07-14-18:11:
   * Per-task session advisor override at create time. Unset inherits project default.
   */
  sessionAdvisorEnabled?: boolean;
}

// ── Todo List Types ──────────────────────────────────────────────────────



/** Canonical version for shared-state snapshots exchanged across mesh nodes. */
export const SHARED_STATE_SNAPSHOT_VERSION = 1 as const;

export interface TodoList {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface TodoItem {
  id: string;
  listId: string;
  text: string;
  completed: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  sortOrder: number;
}

export interface TodoListCreateInput {
  title: string;
}

export interface TodoListUpdateInput {
  title?: string;
}

export interface TodoItemCreateInput {
  text: string;
  sortOrder?: number;
}

export interface TodoItemUpdateInput {
  text?: string;
  completed?: boolean;
  sortOrder?: number;
}

export interface TodoListWithItems extends TodoList {
  items: TodoItem[];
}

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

export interface BoardConfig {
  nextId: number;
  settings?: Settings;
}

export interface DistributedTaskIdReserveInput {
  prefix: string;
  nodeId: string;
  ttlMs?: number;
}

export interface DistributedTaskIdReserveResult {
  reservationId: string;
  taskId: string;
  sequence: number;
  expiresAt: string;
  committedClusterTaskCount: number;
}

export interface DistributedTaskIdCommitInput {
  reservationId: string;
  nodeId: string;
}

export interface DistributedTaskIdCommitResult {
  reservationId: string;
  taskId: string;
  sequence: number;
  committedClusterTaskCount: number;
  committedAt: string;
}

export interface DistributedTaskIdAbortInput {
  reservationId: string;
  nodeId: string;
  reason: "abort" | "expired" | "failed-create";
}

export interface DistributedTaskIdAbortResult {
  reservationId: string;
  taskId: string;
  sequence: number;
  committedClusterTaskCount: number;
  abortedAt: string;
}

export interface DistributedTaskIdStateInput {
  prefix: string;
}

export interface DistributedTaskIdStateResult {
  nextSequence: number;
  committedClusterTaskCount: number;
  activeReservationCount: number;
  burnedReservationCount: number;
  lastCommittedTaskId?: string;
}

export interface AutostashOrphanRecord {
  sha: string;
  ref: string;
  label: string;
  sourceTaskId: string | null;
  createdAt: string | null;
  changedPaths: string[];
  classification: "subsumed" | "live" | "unknown";
  /** Merge/recovery phase that created this stash label when known. */
  sourcePhase?: string | null;
  /** Task that detected/surfaced this orphan in the current run. */
  detectedByTaskId?: string | null;
  /** ISO timestamp when this orphan was surfaced in the current run. */
  detectedAt?: string | null;
}

/**
 * Outcome of restoring the developer's pre-merge autostash after the merge
 * completes. Surfaced on MergeResult so the UI / dashboard can show whether
 * the dev's uncommitted work was reapplied cleanly, AI-resolved, or left
 * stashed for manual recovery.
 *
 * Background: when rootDir is the developer's primary checkout, the merger
 * stashes any uncommitted edits before running its hard resets, then applies
 * them back at the end. Historically a pop conflict would log a warning and
 * silently leave the stash in place — developers had no way to discover this
 * had happened. See `restoreUnrelatedRootDirChanges` in merger.ts.
 */
export type AutostashOutcome =
  | { status: "no-changes" }
  | { status: "restored"; stashSha: string }
  | {
      status: "ai-resolved";
      stashSha: string;
      conflictedFiles: string[];
    }
  | {
      status: "conflict-needs-manual";
      stashSha: string;
      conflictedFiles: string[];
      message: string;
    }
  | { status: "failed"; stashSha?: string; errorMessage: string };

export interface MergeResult extends MergeDetails {
  task: Task;
  branch: string;
  merged: boolean;
  noOp?: boolean;
  ok?: true;
  reason?: string;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  error?: string;
  /** Whether the merged result was pushed to the remote. Only set when pushAfterMerge is enabled. */
  pushedToRemote?: boolean;
  /** Error message if push to remote failed. Non-fatal — merge is already committed locally. */
  pushError?: string;
  /** Outcome of restoring the developer's pre-merge autostash, when one was
   *  created. Absent when the working tree was already clean at merge start. */
  autostash?: AutostashOutcome;
  /** Internal flag to track if a build retry has been attempted. Not persisted. */
  _buildRetried?: boolean;
}

export type TaskCommitAssociationMatchSource =
  | "canonical-lineage-trailer"
  | "legacy-task-id-trailer"
  | "legacy-subject"
  | "manual-reconciliation";

export type TaskCommitAssociationConfidence = "canonical" | "legacy" | "ambiguous";

export interface TaskCommitAssociation {
  id: string;
  taskLineageId: string;
  taskIdSnapshot: string;
  commitSha: string;
  commitSubject: string;
  authoredAt: string;
  matchedBy: TaskCommitAssociationMatchSource;
  confidence: TaskCommitAssociationConfidence;
  note?: string;
  additions?: number;
  deletions?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CommitAssociationDiffBackfillReport {
  scannedRows: number;
  distinctCommits: number;
  updatedRows: number;
  skippedUnavailableCommits: number;
  skippedInvalidShas: number;
  dryRun: boolean;
}

export const COLUMN_LABELS: Record<Column, string> = {
  triage: "Planning",
  todo: "Todo",
  "in-progress": "In Progress",
  "in-review": "In Review",
  done: "Done",
  archived: "Archived",
};

export const COLUMN_DESCRIPTIONS: Record<Column, string> = {
  triage: "Raw ideas — AI will plan these",
  todo: "Specified and ready to start",
  "in-progress": "AI is working on this in a worktree",
  "in-review": "Complete — ready to merge",
  done: "Merged and closed",
  archived: "Completed and archived",
};

/**
 * @deprecated (workflowColumns, U12) The hardcoded legacy transition graph.
 * Transition validity is resolved from the task's workflow column graph
 * (`resolveAllowedColumns` in `workflow-transitions.ts`) plus trait guards in
 * `moveTaskInternal` — this constant remains the default-workflow parity oracle
 * while legacy call sites are retired.
 */
export const VALID_TRANSITIONS: Record<Column, Column[]> = {
  // FN-4892: intake-side heuristics may cold-archive tasks before execution starts.
  triage: ["todo", "archived"],
  // FN-4892: allow direct archival for newly specified intake tasks.
  todo: ["in-progress", "triage", "archived"],
  // NOTE: "in-progress" → "done" is enabled for mission validation tasks that complete directly.
  // Regular implementation tasks should move through "in-review" before "done".
  "in-progress": ["in-review", "todo", "triage", "done"],
  "in-review": ["done", "in-progress", "todo", "triage"],
  done: ["todo", "triage", "archived"],
  archived: ["done"],
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

// ── Plugin Activation Types ──────────────────────────────────────────────────

/**
 * Project-scoped plugin/extension activation event persisted in `plugin_activations`.
 * FNXC:CommandCenterEcosystem 2026-06-19-00:00:
 * Command Center Ecosystem uses these rows as the only source for Plugin activations; an absent row set means unavailable, not zero.
 */
export interface PluginActivation {
  id: number;
  pluginId: string;
  source: string;
  pluginVersion: string | null;
  activatedAt: string;
}

export interface PluginActivationInput {
  pluginId: string;
  source: string;
  pluginVersion?: string | null;
  activatedAt?: string;
}

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

// ── Multi-Project First-Run & Migration Types ───────────────────────────────

/** Detected project for migration consideration */
export interface DetectedProject {
  /** Absolute path to project directory */
  path: string;
  /** Auto-generated or derived project name */
  name: string;
  /** Whether the project has a valid fusion.db */
  hasDb: boolean;
  /** Persisted project identity id if present */
  identityId?: string;
}

/** Setup state for the first-run wizard UI */
export interface SetupState {
  /** Whether this is a first-run scenario (no projects registered) */
  isFirstRun: boolean;
  /** Whether any projects were detected on the filesystem */
  hasDetectedProjects: boolean;
  /** Projects detected on filesystem for potential registration */
  detectedProjects: DetectedProject[];
  /** Projects already registered in the central database */
  registeredProjects: RegisteredProject[];
  /** Recommended action based on current state */
  recommendedAction: "auto-detect" | "create-new" | "manual-setup";
  /** Local identities whose central rows are missing */
  orphanIdentities?: Array<{ path: string; identityId: string }>;
}

/** Input for setting up a project via the wizard */
export interface ProjectSetupInput {
  /** Project path */
  path: string;
  /** Display name */
  name: string;
  /** Isolation mode preference */
  isolationMode?: "in-process" | "child-process";
  /** Persisted local identity for central re-attachment */
  identity?: { id: string; createdAt: string } | null;
}

/** Result of completing the first-run setup */
export interface SetupCompletionResult {
  /** Whether the setup completed successfully */
  success: boolean;
  /** Projects that were registered */
  projects: RegisteredProject[];
  /** Recommended next steps for the user */
  nextSteps: string[];
}

/** Options for running a migration */
export interface MigrationOptions {
  /** Path to start scanning for projects (default: process.cwd()) */
  startPath?: string;
  /** Maximum recursion depth for scanning (default: 5) */
  maxDepth?: number;
  /** Whether to simulate without making changes */
  dryRun?: boolean;
  /** Whether to auto-register detected projects */
  autoRegister?: boolean;
  /** Progress callback for long-running operations */
  onProgress?: (current: number, total: number, path: string) => void;
}

/** Result of a migration operation (from MigrationOrchestrator) */
export interface MigrationResult {
  /** Projects detected during scanning */
  projectsDetected: DetectedProject[];
  /** Projects that were registered */
  projectsRegistered: RegisteredProject[];
  /** Projects that were skipped with reasons */
  projectsSkipped: Array<{ path: string; reason: string }>;
  /** Errors encountered during migration */
  errors: Array<{ path: string; error: string }>;
}


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
