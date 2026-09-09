import "./TaskDetailModal.css";
import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Pencil, Bot, X, ChevronDown, ChevronRight, GitBranch, ArrowLeft, Loader2, AlertTriangle, Sparkles, Maximize2, Minimize2, Info, Copy } from "lucide-react";
import { useViewportMode } from "../hooks/useViewportMode";
import { mergeTaskSnapshot } from "../hooks/useTasks";
import { dismissAiMergeReviewFinding } from "../api/tasks/tasks-lifecycle";
import { FloatingWindow } from "./FloatingWindow";
import { ExternalBlockNotice } from "./TaskCard";
import { TaskResetDialog } from "./TaskResetDialog";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";
import { useModalDismissPreference, useOverlayDismiss } from "../hooks/useOverlayDismiss";
import { useColumnLabel } from "../i18n/labels";
import type { DetailTaskTab } from "../hooks/useModalManager";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { sharedRehypePlugins, createMermaidCodeComponent } from "./markdownPipeline";
import type { Task, TaskDetail, TaskAttachment, ColumnId, MergeResult, Settings, GlobalSettings, Agent, TaskPriority, TaskSourceIssue, WorkflowStepResult, GithubIssueAction, TaskGitLabTrackedItem, PlannerOversightLevel, PlannerOverseerRuntimeSnapshot, TaskVerificationRequest, ThinkingLevel } from "@fusion/core";
import {
  DEFAULT_TASK_PRIORITY,
  MAX_TASK_MESSAGE_LENGTH,
  REPO_OVERRIDE_RE,
  TASK_PRIORITIES,
  PLANNER_OVERSIGHT_LEVELS,
  getErrorMessage,
} from "@fusion/core";
import { resolveEffectivePlannerOversightLevel } from "../../../core/src/workflows/workflow-settings-resolver";
import { resolveTaskSessionAdvisorEnabled } from "../../../core/src/agents/session-advisor";
import { isNearDuplicateCanonicalInactive } from "../../../core/src/duplicates/near-duplicate-canonical";
import { getRevertOfId, findOpenUndoTaskForSource, isTaskReverted } from "../utils/taskRevert";
import { isForeignTaskEvent, readTaskEventProjectId } from "../utils/taskEventProjectScope";
import {
  isCompleteColumnRole,
  isHoldColumnRole,
  isFieldEditableColumnRole,
  isPreImplementationColumnRole,
  isReviewColumnRole,
  isWipColumnRole,
} from "../utils/columnRoles";
import { resolveEffectiveAutoMerge } from "../../../core/src/merge/task-merge";
import { uploadAttachment, deleteAttachment, updateTask, repairOverlapBlocker, fetchOverlapBlockerReport, fetchTaskDetail, fetchTaskPrompt, fetchSpecLock, fetchTaskVerificationRequest, fetchSettings, fetchTaskEffectiveSettings, fetchGlobalSettings, requestSpecRevision, rebuildTaskSpec, approvePlan, rejectPlan, refineTask, fetchWorkflowResults, assignTask, fetchAgents, fetchAgent, refreshPrStatus, fetchBoardWorkflows, updateTaskCustomFields, summarizeTitle, fetchWorkflowSettingValues, nudgeOverseer, stopOverseer, explainOverseer, fetchModels, fetchNodes, api } from "../api";
import type { RevertTaskOptions, RevertTaskResult, ModelInfo, NodeInfo, SpecLockResponse, TaskOverlapBlockerReport } from "../api";
import type { BoardWorkflowsPayload, WorkflowFieldDefinition, CustomFieldRejection } from "../api";
import { WorkflowIcon } from "./WorkflowIcon";
import { ApiRequestError } from "../api";
import { TaskFieldsSection } from "./TaskFieldsSection";
import { TaskVerificationStatus } from "./TaskVerificationStatus";
import type { ToastType } from "../hooks/useToast";
import { useAgentLogs } from "../hooks/useAgentLogs";
import { useConfirm } from "../hooks/useConfirm";
import { runDuplicateTaskAction } from "../utils/duplicateTaskAction";
import { AgentLogViewer } from "./AgentLogViewer";
import { PreciseTimestamp } from "./PreciseTimestamp";
import { ModelSelectorTab } from "./ModelSelectorTab";
import { PrPanel } from "./PrPanel";
import { PrCreateModal } from "./PrCreateModal";
import { PlannerInterventionTimeline } from "./PlannerInterventionTimeline";
import { TaskComments } from "./TaskComments";
import { TaskChatTab } from "./TaskChatTab";
import { TaskPlannerChatTab } from "./TaskPlannerChatTab";
import { TaskReviewTab } from "./TaskReviewTab";
import { TaskChangesTab } from "./TaskChangesTab";
import { TaskSummaryTab } from "./TaskSummaryTab";
import { TaskRecommendationsTab } from "./TaskRecommendationsTab";
import { MergeDetails } from "./MergeDetails";
import { TaskCostTab } from "./TaskCostTab";
import { WorkspaceWorktreesSummary, isWorkspaceTask } from "./WorkspaceWorktreesSummary";
import { TaskForm, type PendingImage } from "./TaskForm";
import { useNodes } from "../hooks/useNodes";
import { WorkflowResultsTab } from "./WorkflowResultsTab";
import { RoutingTab } from "./RoutingTab";
import { TaskDocumentsTab } from "./TaskDocumentsTab";
import { TaskTokenStatsPanel } from "./TaskTokenStatsPanel";
import { BranchGroupCard } from "./BranchGroupCard";
import { PluginSlot } from "./PluginSlot";
import { ProviderIcon } from "./ProviderIcon";
import { LoadingSpinner } from "./LoadingSpinner";
import { KeepAliveView } from "./KeepAliveView";
import { subscribeSse } from "../sse-bus";
import type { SessionTerminalMode, SessionTerminalPosture } from "./SessionTerminal";
import { usePluginUiSlots } from "../hooks/usePluginUiSlots";
import { appendTokenQuery } from "../auth";
import { extractDependencyDeleteConflict, extractLineageDeleteConflict } from "../utils/taskDelete";
import { MAX_AUTO_MERGE_RETRIES, computeBlockerFanoutMap, type BlockerFanoutColumnFlags } from "../hooks/useBlockerFanout";
import { resolveEffectiveGithubRepoDefault } from "./githubTracking";
import type { TFunction } from "i18next";
import { linkifyFilePaths, linkifyReactChildren } from "../utils/filePathLinkify";
import { getInReviewStallCopy, shouldShowInReviewStallBadge } from "../utils/inReviewStallCopy";
import { getUnifiedTaskProgress } from "../utils/taskProgress";
import { getStalePausedReviewCopy, shouldShowStalePausedReviewBadge } from "../utils/stalePausedReviewCopy";
import { getTaskAgeStalenessCopy } from "../utils/taskAgeStalenessCopy";
import { splitTaskPlanSummary } from "../utils/taskPlanSummary";
import { decideTaskPromptRefresh } from "../utils/taskPromptRefresh";
import { getPriorityLabel } from "../utils/priorityIndicator";
import { hasPendingAutomaticRecovery } from "../utils/taskRecovery";
import { resolveRetryStageCopy } from "../utils/taskRetryCopy";
import { findInReviewStallLogEntry, IN_REVIEW_STALL_LOG_REGEX } from "../utils/findInReviewStallLogEntry";
import { getTaskLogEntryAction, getTaskLogEntryOutcome } from "../utils/taskLogEntryDisplay";
import { copyTextToClipboard } from "../utils/copyToClipboard";
import { getRelativeTimeBucket } from "../utils/relativeTimeAgo";
import { recordResumeEvent } from "../utils/resumeInstrumentation";
import { isReviewBudgetExhaustedApproval, isTaskAwaitingPlanApproval } from "../utils/reviewBudgetApproval";
import { getTaskStatusBadgeLabel, hasTaskStatusBadge, isTaskPlanningActive } from "../utils/taskStatusBadgeLabel";
import { ACTIVE_STATUSES, resolveEffectiveExecutor, resolveEffectivePlanning, resolveEffectiveTaskChat, resolveEffectiveValidator, type ModelSelection } from "./effective-model-resolution";
import { TaskContextMenu, buildTaskActionMenuModel, getTaskPrAutomationLabel } from "./TaskContextMenu";
import type { TaskContextMenuColumnFlags, TaskContextMenuColumnMetadata, TaskMenuItemDescriptor } from "./TaskContextMenu";
import { FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT } from "./FloatingWindow";
import { useFileBrowser } from "../context/FileBrowserContext";
import type { DetailTaskInitialActionRequest } from "../hooks/useModalManager";

/*
FNXC:TaskMessageLength 2026-08-29-08:02:
Task-detail refinement and spec-revision composers retain their counters and browser maxLength
attributes, but source their ceiling from the same server constant so operator text is never refused
locally below the task-message route contract.
*/
const STALE_PAUSED_REVIEW_LOG_REGEX = /^Stale paused review surfaced \[([^\]]+)\]/;
const EMPTY_MARKDOWN_CHILD_SEPARATOR = "";
const STRING_OBJECT_TAG = "[object String]";
const ACTIVITY_VIEW_MENU_VIEWPORT_PADDING = 16;
const ACTIVITY_VIEW_MENU_TRIGGER_GAP = 4;
const ACTIVITY_VIEW_MENU_MIN_WIDTH = 160;
const ACTIVITY_VIEW_MENU_MIN_HEIGHT = 120;
const ACTIVITY_VIEW_MENU_MAX_HEIGHT = 320;
const ACTIVITY_VIEW_MENU_OPEN_VIEWPORT_GUARD_MS = 350;
const PROMPT_REFRESH_INTERVAL_MS = 5_000;
const TASK_FEED_RESYNC_DEBOUNCE_MS = 750;

function isPromptRefreshLifecycleActive(task: Pick<Task, "status" | "workflowStepResults">): boolean {
  if (task.status === "planning" || task.status === "needs-replan") return true;
  return task.workflowStepResults?.some((result) =>
    (result.workflowStepId === "plan-review" || result.workflowStepId === "plan-replan")
    && result.startedAt != null
    && result.completedAt == null,
  ) ?? false;
}

// FNXC:TaskDetailSwipeBack 2026-07-05-12:30: FN-7587 — mobile-mode gating the presentation-only predictive-back slide/fade transition on the modal/list/nested task-detail surface uses the shared viewport classifier, so known 768px tablets do not receive phone-only presentation.
// FNXC:PlannerOversight 2026-07-05-00:00: FN-7604 — the OVERSIGHT_MENU_MOBILE_BREAKPOINT constant (formerly used to branch the oversight controls between an inline cluster and this overflow menu) was removed; the overflow-menu dropdown is now the single universal surface at every viewport, so no breakpoint gates it.

type ActivityViewMenuPosition = {
  top: number;
  left: number;
  minWidth: number;
  maxHeight: number;
};

type TaskActivityLogEntry = NonNullable<Parameters<typeof getTaskLogEntryAction>[0]> & {
  timestamp: string;
};

/*
FNXC:TaskActivityFeedCopy 2026-08-18-18:11:
Operators copy only the bounded activity already loaded into Feed, in the same newest-first order they see. Keep source timestamps, duplicate rows, and legacy action/outcome fallbacks intact, and route all clipboard attempts through the shared secure/fallback helper.
*/
function serializeTaskActivityLogs(entries: readonly TaskActivityLogEntry[]): string {
  return [...entries].reverse().map((entry) => {
    const action = getTaskLogEntryAction(entry);
    const outcome = getTaskLogEntryOutcome(entry);
    return `[${entry.timestamp}] ${action}${outcome ? `\n${outcome}` : ""}`;
  }).join("\n\n");
}

function isStringValue(value: unknown): value is string {
  return Object.prototype.toString.call(value) === STRING_OBJECT_TAG;
}

/*
FNXC:Markdown 2026-06-23-03:30:
The task DESCRIPTION (spec/prompt) + SUMMARY render via these components plus the
shared rehype chain (sharedRehypePlugins) so they gain sanitized raw HTML
(`<details>`/tables/`<kbd>`), drop HTML comments, and render ```mermaid diagrams —
matching the shared markdown renderer. They KEEP their `.markdown-body` styling
(NOT the `.mailbox-markdown` wrapper), so the look is unchanged for normal markdown.
The file-path linkify `code` renderer is preserved as the fallback for non-mermaid
code, so links AND html AND mermaid all work together.
*/
const markdownLinkifyCodeComponent: NonNullable<Components["code"]> = ({ children, ...props }) => {
  const text = React.Children.toArray(children).join(EMPTY_MARKDOWN_CHILD_SEPARATOR);
  const linkedChildren = linkifyFilePaths(text);
  if (linkedChildren.length === 1 && linkedChildren[0]?.constructor === String) {
    return <code {...props}>{children}</code>;
  }
  return <code {...props}>{linkedChildren}</code>;
};

const markdownLinkifyComponents: Components = {
  p: ({ children, ...props }) => <p {...props}>{linkifyReactChildren(children)}</p>,
  li: ({ children, ...props }) => <li {...props}>{linkifyReactChildren(children)}</li>,
  // Mermaid fences render as diagrams; all other code falls through to file-path linkify.
  code: createMermaidCodeComponent("task-detail-mermaid-diagram", markdownLinkifyCodeComponent),
};

function formatGitLabItemKind(item: Pick<TaskGitLabTrackedItem, "kind">, t?: TFunction): string {
  if (item.kind === "merge_request") return t ? t("taskDetail.gitlabTracking.kindMergeRequest", "Merge request") : "Merge request";
  if (item.kind === "group_issue") return t ? t("taskDetail.gitlabTracking.kindGroupIssue", "Group issue") : "Group issue";
  return t ? t("taskDetail.gitlabTracking.kindProjectIssue", "Project issue") : "Project issue";
}

function formatGitLabItemMarker(item: Pick<TaskGitLabTrackedItem, "kind" | "iid">): string {
  return `${item.kind === "merge_request" ? "!" : "#"}${item.iid}`;
}

function hasUsableTrackingTitle(task: { title?: string | null; description?: string | null }): boolean {
  if ((task.title ?? "").trim().length > 0) {
    return true;
  }

  const firstMeaningfulLine = (task.description ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return Boolean(firstMeaningfulLine);
}

function toTaskChatModelInfo(model: ModelSelection): { provider: string; modelId?: string } | null {
  if (!model.provider) return null;
  return model.modelId ? { provider: model.provider, modelId: model.modelId } : { provider: model.provider };
}

/*
FNXC:WorkflowStepResults 2026-06-26-18:00:
The detail Progress bar renders the UNIFIED step model (implementation steps + enabled
workflow steps), so its segment colors must cover the workflow-step statuses too:
`passed`→done/success, `failed`→error (blocking gate), `advisory_failure`→warning (amber,
non-blocking), `running`→in-progress, plus the implementation statuses. Colors mirror the
TaskCard step dots so the two surfaces read identically.
*/
function getStepStatusColor(status: string): string {
  switch (status) {
    case "done":
    case "passed":
      return "var(--color-success)";
    case "failed":
      return "var(--color-error-dark)";
    case "advisory_failure":
      return "var(--ws-warning)";
    case "not_run":
      return "var(--text-dim)";
    case "in-progress":
    case "running":
      return "var(--in-progress)";
    case "skipped":
      return "var(--text-dim)";
    case "pending":
    default:
      return "var(--border)";
  }
}

function formatTimestamp(iso: string): string {
  /*
   * FNXC:RelativeTime 2026-06-17-20:48:
   * FN-6618 routes TaskDetailModal timestamp math through getRelativeTimeBucket while preserving lowercase compact labels, future-as-just-now behavior, and the legacy Invalid Date fallback for unparseable input.
   */
  const bucket = getRelativeTimeBucket(iso);
  if (!bucket) {
    const timestampMs = Date.parse(iso);
    if (Number.isFinite(timestampMs) && Date.now() - timestampMs < 0) return "just now";
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  switch (bucket.bucket) {
    case "just-now":
      return "just now";
    case "minutes":
      return `${bucket.count}m ago`;
    case "hours":
      return `${bucket.count}h ago`;
    case "days":
      return `${bucket.count}d ago`;
    case "weeks":
    case "older":
      return bucket.date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDurationCompact(ageMs: number): string {
  const totalMinutes = Math.max(1, Math.floor(ageMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

type TabId = "summary" | "recommendations" | "cost" | "definition" | "dependencies" | "attachments" | "details" | "debug" | "chat" | "planner-chat" | "logs" | "changes" | "review" | "history" | "pr" | "comments" | "model" | "workflow" | "documents" | "stats" | "routing" | "retries" | "terminal" | "worktree-terminal" | `plugin-${string}`;
type ActivitySegment = "current" | "feed" | "raw-logs" | "interventions";
type WorkflowResultsLoadState = "idle" | "loading" | "succeeded" | "failed";

/*
FNXC:TaskDetailActivityTab 2026-06-30-00:00:
The existing task activity/steering surface keeps the stable internal `chat` tab id for deep-link/plugin compatibility, but its top-level user-facing label is Activity.

FNXC:TaskDetailPlannerChat 2026-06-30-22:30:
Task detail separates Activity from planner-model Chat. `chat` remains the legacy Activity id for old links and Activity → Live (internal `current`)/Feed/Raw Logs/steering, while `planner-chat` is the top-level Chat tab for task-aware planning conversation.

FNXC:TaskDetailActivityFirst 2026-06-30-23:59:
Task details are Activity-first by default: render Activity before planner Chat and make omitted non-done opens land on Activity → Live. The project `taskDetailChatFirst` setting restores Chat-first ordering/default when true; explicit `initialTab` deep links always win.

FNXC:TaskDetailActivity 2026-06-30-15:50:
Only an omitted initial tab is the implicit default. Preserve explicit `initialTab="chat"` requests from plugins and task-detail entrypoints so existing links continue to open Activity → Live (internal `current`). Legacy `initialTab="logs"` routes to Activity → Feed, and Raw Logs remains an Activity segment.

FNXC:TaskDetailActivity 2026-06-30-21:55:
The first Activity segment keeps the stable internal `current` id for legacy segment tests and links, but its embedded composer labels the operational steering-comment affordance explicitly. Do not reuse this segment as planner-model Chat conversation; that belongs to the `planner-chat` top-level tab.

FNXC:TaskDetailActivity 2026-06-30-23:55:
The first Activity segment is user-facing Live while legacy internals remain `current` and explicit `initialTab="chat"` continues landing there for compatibility.

FNXC:TaskDetailActivity 2026-08-28-23:05:
Activity exposes only Live, Feed, Raw, and an oversight-gated Interventions view. Legacy `logs` still routes to Activity → Feed, while detailed stage reports moved to the always-available Summary tab.

FNXC:TaskHistory 2026-08-28-23:05:
The compatibility router preserves every retired tab id without preserving duplicate content: `history` and `recommendations` route to Summary; `cost` routes to Stats; `attachments` routes to Artifacts; and `retries`, `routing`, and `debug` route to Details. `logs` remains Activity → Feed.
*/
function resolveDefaultTab(initialTab: TabId | undefined, column: ColumnId, taskDetailChatFirst = false): TabId {
  switch (initialTab) {
    case "logs":
      return "chat";
    case "history":
    case "recommendations":
      return "summary";
    case "retries":
    case "routing":
    case "debug":
      return "details";
    case "cost":
      return "stats";
    case "attachments":
      return "documents";
    default:
      break;
  }
  if (initialTab) {
    return initialTab;
  }
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-23:45 (fleet: TaskDetailModal.tsx):
  CENTRALISATION, not trait resolution — module-scope helper taking a bare column id, so no flags are
  in scope. `undefined` selects the shared fallback and behaviour is identical; the value is that the
  legacy id lives in one place and this site stays greppable as "still needs its flags threaded".
  */
  if (isCompleteColumnRole(undefined, column)) {
    return "summary";
  }
  return taskDetailChatFirst ? "planner-chat" : "chat";
}

function resolveDefaultActivitySegment(initialTab: TabId | undefined): ActivitySegment {
  return initialTab === "logs" ? "feed" : "current";
}

// Lazy-load terminal surfaces so xterm + addons stay out of the main bundle (U11).
const LazySessionTerminal = lazy(() =>
  import("./SessionTerminal").then((m) => ({ default: m.SessionTerminal })),
);
const LazyTerminalModal = lazy(() =>
  import("./TerminalModal").then((m) => ({ default: m.TerminalModal })),
);

/** CLI session record fields the terminal tab needs (mirrors @fusion/core CliSession). */
export interface CliSessionSummaryRecord {
  id: string;
  taskId: string | null;
  projectId: string;
  adapterId: string;
  agentState:
    | "starting"
    | "ready"
    | "busy"
    | "waitingOnInput"
    | "done"
    | "dead"
    | "needsAttention";
  terminationReason: string | null;
  autonomyPosture?: Record<string, unknown> | null;
}

type CliTabVisibility =
  | { kind: "hidden" }
  | { kind: "live"; readOnly: boolean; mode: SessionTerminalMode; showConfirmAdvance: boolean }
  | { kind: "replay"; mode: SessionTerminalMode };

/**
 * Tab visibility matrix (U11):
 *  - starting/ready/busy/waitingOnInput → live terminal
 *  - one-shot (planning/validator) live → read-only live + badge
 *  - done (resumable) → replay "session idle"
 *  - dead/needsAttention (PTY reaped) → replay "session ended"
 *  - no recorded session → hidden
 */
export function isCliSessionLive(session: CliSessionSummaryRecord | null): boolean {
  return session?.agentState === "starting"
    || session?.agentState === "ready"
    || session?.agentState === "busy"
    || session?.agentState === "waitingOnInput";
}

export function deriveCliTabVisibility(
  session: CliSessionSummaryRecord | null,
  opts: { oneShot?: boolean; genericIdle?: boolean } = {},
): CliTabVisibility {
  if (!session) return { kind: "hidden" };
  if (isCliSessionLive(session)) {
    return {
      kind: "live",
      readOnly: Boolean(opts.oneShot),
      mode: "live",
      showConfirmAdvance: Boolean(opts.genericIdle),
    };
  }
  if (session.agentState === "done") {
    // execute-done but resumable → scrollback replay with a "session idle" header.
    return { kind: "replay", mode: "idle" };
  }
  // dead / needsAttention → PTY reaped → "session ended".
  return { kind: "replay", mode: "ended" };
}

export interface TaskDetailModalProps {
  task: Task | TaskDetail;
  projectId?: string;
  tasks?: Task[];
  /* Per-task lifecycle traits for the blocker fan-out; see the useMemo that consumes it. */
  columnFlagsByTaskId?: ReadonlyMap<string, BlockerFanoutColumnFlags>;
  onClose: () => void;
  onOpenDetail: (task: Task | TaskDetail, initialTab?: DetailTaskTab) => void; // For clicking linked task details
  /** Opens a New Task draft from a reverted task description. */
  onReviseTask?: (task: Task) => void;
  onDeleteTask: (id: string, options?: {
    removeDependencyReferences?: boolean;
    removeLineageReferences?: boolean;
    githubIssueAction?: GithubIssueAction;
    allowResurrection?: boolean;
  }) => Promise<Task>;
  onRevertTask?: (id: string, body?: RevertTaskOptions) => Promise<RevertTaskResult>;
  onMergeTask: (id: string) => Promise<MergeResult>;
  onRetryTask?: (id: string) => Promise<Task>;
  onOpenChatWithPrefill?: (prefillText: string) => void;
  /** Shared lifecycle operations reconcile confirmed rows before detail hosts render their next frame. */
  onPauseTask?: (id: string) => Promise<Task>;
  onUnpauseTask?: (id: string) => Promise<Task>;
  /*
  FNXC:ReviewLaneBypass 2026-07-09-00:00:
  Operator-only review-lane bypass (FN-7720). Only wired here (Task Detail) so
  it never appears in the Board/List card context menus — single canonical
  affordance surface for this policy-gated escape hatch.
  */
  onBypassReview?: (id: string, reason: string) => Promise<Task>;
  onResetTask?: (id: string, options?: { description?: string }) => Promise<Task>;
  onDuplicateTask?: (id: string, options?: { workflowId?: string }) => Promise<Task>;
  onTaskUpdated?: (task: Task) => void;
  /** Publishes a successfully created refinement child to shared board state. */
  onRefinementCreated?: (task: Task) => void;
  addToast: (message: string, type?: ToastType) => void;
  prAuthAvailable?: boolean;
  autoMergeEnabled?: boolean;
  /** Prevent transient planner activity from presenting as live during an engine-wide pause. */
  globalPaused?: boolean;
  onOpenWorkflowEditor?: () => void;
  /** Open the modal with this tab active instead of the default done-aware landing view. */
  initialTab?: TabId;
  /** One-shot action the detail surface should perform after opening. */
  initialAction?: DetailTaskInitialActionRequest | null;
  /** Mobile-only header affordance mode. */
  mobileHeaderMode?: "close" | "back";
  /** Project setting: true restores Chat-first tab order/default; false or missing uses Activity-first. */
  taskDetailChatFirst?: boolean;
  /** Pre-resolved workflow field defs for this task's workflow (U13/KTD-14).
   *  When provided, these remain authoritative for custom-field rendering.
   *  Move metadata still resolves independently because field definitions do not
   *  identify the selected workflow's ordered columns. */
  workflowFieldDefs?: WorkflowFieldDefinition[] | null;
}

export type TaskDetailContentProps = Omit<TaskDetailModalProps, "onClose"> & {
  embedded?: boolean;
  /*
  FNXC:TaskDetail 2026-06-22-12:20:
  Embedded task detail can be hosted by a movable FloatingWindow. In that surface the task header is the only visible header, so onRequestClose must render a close icon beside edit instead of relying on separate window chrome.
  */
  onRequestClose?: () => void;
  /*
  FNXC:TaskDetail 2026-06-22-18:40:
  onBackToBoard powers the board-card full-panel "Back to board" affordance rendered in the gray header (far right). It is only honored when embedded is also true, so ListView split-pane and modal usages never show it.
  */
  onBackToBoard?: () => void;
  /*
  FNXC:FloatingWindow 2026-06-22-20:45:
  onPopOut, when supplied, renders the header's Maximize2 pop-out button. List/Board wire it to push this task into App's floating task-detail window array, opening the same embedded TaskDetailContent inside a movable, resizable, non-blocking FloatingWindow. It is independent of embedded/onBackToBoard so List split-pane and the board full-panel can both expose it.
  */
  onPopOut?: (task: Task) => void;
  /*
  FNXC:TaskPopupViewGating 2026-07-22-13:15:
  Keep-alive visibility gate (FN remount-churn fix R7/R8). Popped-out task FloatingWindows now hide instead of unmounting when the user leaves their origin view, so the embedded TaskDetailContent stays mounted with its terminal WebSocket alive. While `active` is false the detail's SSE subscriptions (workflow results, CLI session state) and useAgentLogs EventSource are closed, and the tab-level `active` gates (chat, planner-chat, terminal) are forced inactive — the terminal WS itself intentionally stays open. Defaults to true so every other host is unaffected.
  */
  active?: boolean;
};

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function sameStringArray(a: string[] = [], b: string[] = []): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function splitModelSelection(value: string): { provider: string; modelId: string } | null {
  const slashIdx = value.indexOf("/");
  if (!value || slashIdx === -1) return null;
  return {
    provider: value.slice(0, slashIdx),
    modelId: value.slice(slashIdx + 1),
  };
}

function normalizeSourceIssueText(value: string): string {
  return value.trim();
}

function normalizeSourceIssueUrl(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/*
FNXC:PlannerOversight 2026-07-04-17:00:
FN-7517 quick oversight-level-change control needs the workflow's effective
`plannerOversightLevel` setting to show/reset-to the TRUE effective level
for tasks with no per-task override — the same gap FN-7516's TaskCard badge
hit (Task carries no `workflowId` field; the setting is not on the task
payload). Mirrors TaskCard's module-level `(workflowId, projectId)` cache +
in-flight de-dup exactly (see packages/dashboard/app/components/TaskCard.tsx)
rather than re-deriving precedence locally — `resolveEffectivePlannerOversightLevel`
remains the single resolver both surfaces call.
*/
interface ModalWorkflowOversightSettings {
  level: PlannerOversightLevel | undefined;
  sessionAdvisorEnabled: boolean;
}

const modalWorkflowOversightEffectiveCache = new Map<string, ModalWorkflowOversightSettings>();
const modalWorkflowOversightInflight = new Map<string, Promise<void>>();

function getModalWorkflowOversightCacheKey(workflowId: string, projectId?: string): string {
  return `${projectId ?? "default"}::${workflowId}`;
}

function isPlannerOversightLevelValue(value: unknown): value is PlannerOversightLevel {
  return typeof value === "string" && (PLANNER_OVERSIGHT_LEVELS as readonly string[]).includes(value);
}

async function loadModalWorkflowOversightEffectiveLevel(workflowId: string, projectId: string | undefined): Promise<ModalWorkflowOversightSettings> {
  const key = getModalWorkflowOversightCacheKey(workflowId, projectId);
  if (modalWorkflowOversightEffectiveCache.has(key)) {
    return modalWorkflowOversightEffectiveCache.get(key) ?? { level: undefined, sessionAdvisorEnabled: false };
  }
  let inflight = modalWorkflowOversightInflight.get(key);
  if (!inflight) {
    inflight = fetchWorkflowSettingValues(workflowId, projectId)
      .then((payload) => {
        const raw = payload.effective?.plannerOversightLevel;
        modalWorkflowOversightEffectiveCache.set(key, {
          level: isPlannerOversightLevelValue(raw) ? raw : undefined,
          sessionAdvisorEnabled: payload.effective?.plannerOverseerAdvisorEnabled === true,
        });
      })
      .catch(() => {
        modalWorkflowOversightEffectiveCache.set(key, { level: undefined, sessionAdvisorEnabled: false });
      })
      .finally(() => {
        modalWorkflowOversightInflight.delete(key);
      });
    modalWorkflowOversightInflight.set(key, inflight);
  }
  await inflight;
  return modalWorkflowOversightEffectiveCache.get(key) ?? { level: undefined, sessionAdvisorEnabled: false };
}

const OVERSIGHT_LEVEL_LABEL: Record<PlannerOversightLevel, string> = {
  off: "Off",
  observe: "Observe",
  steer: "Steer",
  autonomous: "Autonomous recovery",
};

function normalizeTaskPriorityValue(priority: Task["priority"]): TaskPriority {
  return isStringValue(priority) && (TASK_PRIORITIES as readonly string[]).includes(priority)
    ? (priority as TaskPriority)
    : DEFAULT_TASK_PRIORITY;
}

interface TaskWorkflowMetadata {
  id: string;
  name: string;
  icon?: string;
  fields: WorkflowFieldDefinition[] | null;
  moveColumns: TaskContextMenuColumnMetadata[];
  currentColumnFlags?: TaskContextMenuColumnFlags;
}

/*
FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9):
The `payload.flagEnabled !== true` early return is DELETED. The server hardcodes
that field to `true`, so the guard could only ever suppress this modal's workflow
section on a malformed payload — a retired kill switch, not a real precondition.
The `!workflow || !name` guard below is the one that actually handles a payload
without resolvable workflow metadata.
*/
function resolveTaskWorkflowMetadata(payload: BoardWorkflowsPayload, task: Pick<Task, "id" | "column">): TaskWorkflowMetadata | null {
  const workflowId = payload.taskWorkflowIds[task.id] ?? payload.defaultWorkflowId;
  const workflow = payload.workflows.find((candidate) => candidate.id === workflowId);
  const name = workflow?.name?.trim();
  if (!workflow || !name) return null;

  const moveColumns = workflow.columns
    .filter((column) => column.flags.hiddenFromBoard !== true)
    .map((column) => ({ id: column.id as ColumnId, label: column.name, flags: column.flags }));
  const currentColumnFlags = moveColumns.find((column) => column.id === task.column)?.flags;
  return { id: workflow.id, name, icon: workflow.icon, fields: workflow.fields ?? null, moveColumns, currentColumnFlags };
}

function normalizeExecutionModeValue(executionMode: Task["executionMode"]): "standard" | "fast" {
  return executionMode === "fast" ? "fast" : "standard";
}

function requiresExecutionModeReplan(column: Task["column"], flags?: TaskContextMenuColumnFlags): boolean {
  /*
   FNXC:ExecutionModeReplan 2026-08-29-02:43:
   FN-252 makes Fast a dedicated no-plan/no-review lane. Entering Fast must patch the task in
   place, even from a hold or WIP lane; only returning a Fast task to Standard retains the
   confirmation and replan needed to restore its ordinary plan.

   FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
   The rule is "this card may already hold a plan or a live execution context", which the
   traits state directly: a HOLD lane (planned, waiting for capacity) or a WIP lane
   (executing). Naming `todo` and `in-progress` was the Default workflow's spelling of
   that, and it silently narrows to nothing useful on a renamed workflow. Legacy ids
   remain the fallback for callers without resolved column metadata.
   */
  if (flags) return flags.hold === true || flags.countsTowardWip === true;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-23:45 (fleet: TaskDetailModal.tsx):
  Same centralisation as `resolveDefaultTab` above. The pair is hold-or-wip — a card that has been
  planned but not finished — so it reads through those two roles rather than naming both ids.
  */
  return isHoldColumnRole(undefined, column) || isWipColumnRole(undefined, column);
}

/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
Test seam. The rule is a pure function of (column id, column flags), and asserting it
through the full modal means booting async detail loading to observe one boolean — an
earlier DOM-level attempt at this class of assertion in ListView passed with the
conversion reverted, because the text it matched also appears in a column header.
*/
export const requiresExecutionModeReplanForTest = requiresExecutionModeReplan;

interface ProvenanceDisplay {
  label: string;
  labelHref?: string;
  parentTaskId?: string;
  contextInfo?: string;
  contextHref?: string;
  contextInfoFull?: string;
  sourceAgentId?: string;
}

interface ProvenanceLabelOptions {
  sourceAgentName?: string;
  t?: TFunction<"app">;
}

function getIssueUrlFromMetadata(metadata: Task["sourceMetadata"]): string | undefined {
  const issueUrl = metadata?.issueUrl;
  return isStringValue(issueUrl) && issueUrl.length > 0 ? issueUrl : undefined;
}

function getResearchContextInfo(metadata: Task["sourceMetadata"]): string | undefined {
  const findingLabel = metadata?.findingLabel;
  if (isStringValue(findingLabel) && findingLabel.length > 0) {
    return findingLabel;
  }

  const runId = metadata?.runId;
  return isStringValue(runId) && runId.length > 0 ? runId : undefined;
}

const AgentDetailView = lazy(() => import("./AgentDetailView").then((m) => ({ default: m.AgentDetailView })));

function getProvenanceLabel(task: Task | TaskDetail, options: ProvenanceLabelOptions = {}): ProvenanceDisplay | null {
  const tr = options.t;
  switch (task.sourceType) {
    case "dashboard_ui":
      return { label: tr ? tr("taskDetail.provenance.dashboard", "Dashboard") : "Dashboard" };
    case "quick_chat":
      return { label: tr ? tr("taskDetail.provenance.quickChat", "Quick Chat") : "Quick Chat" };
    case "chat_session":
      return { label: tr ? tr("taskDetail.provenance.chatSession", "Chat Session") : "Chat Session" };
    case "agent_heartbeat": {
      const sourceLabel = options.sourceAgentName ?? task.sourceAgentId;
      return {
        label: sourceLabel ?? (tr ? tr("taskDetail.provenance.agent", "agent") : "agent"),
        sourceAgentId: task.sourceAgentId,
      };
    }
    case "automation":
      return { label: tr ? tr("taskDetail.provenance.automation", "Automation") : "Automation" };
    case "cron":
      return { label: tr ? tr("taskDetail.provenance.scheduledTask", "Scheduled Task") : "Scheduled Task" };
    case "workflow_step":
      return { label: tr ? tr("taskDetail.provenance.workflowStep", "Workflow Step") : "Workflow Step" };
    case "github_import": {
      const issueUrl = getIssueUrlFromMetadata(task.sourceMetadata);
      /*
      FNXC:TaskProvenance 2026-07-23-12:20:
      GitHub import provenance owns its source-issue link on the visible GitHub Import label. Do not restore a parsed repository/issue suffix: a missing URL must remain plain text, while a usable URL gets the sole external click target.
      */
      return {
        label: tr ? tr("taskDetail.provenance.githubImport", "GitHub Import") : "GitHub Import",
        labelHref: issueUrl,
      };
    }
    case "research": {
      const contextInfo = getResearchContextInfo(task.sourceMetadata);
      return {
        label: tr ? tr("taskDetail.provenance.research", "Research") : "Research",
        contextInfo,
        contextInfoFull: contextInfo,
      };
    }
    case "task_refine":
      return {
        label: tr ? tr("taskDetail.provenance.refinement", "Refinement") : "Refinement",
        parentTaskId: task.sourceParentTaskId,
      };
    case "task_duplicate":
      return {
        label: tr ? tr("taskDetail.provenance.duplicate", "Duplicate") : "Duplicate",
        parentTaskId: task.sourceParentTaskId,
      };
    case "cli":
      return { label: tr ? tr("taskDetail.provenance.cli", "CLI") : "CLI" };
    case "api":
      return {
        label: tr ? tr("taskDetail.provenance.api", "API") : "API",
        parentTaskId: task.sourceParentTaskId,
      };
    case "recovery":
      return { label: tr ? tr("taskDetail.provenance.recovery", "Recovery") : "Recovery" };
    case "unknown":
    default:
      return null;
  }
}

// #1403: widened to ColumnId so `.has(task.column)` accepts custom column ids
// (non-members correctly resolve to false → not editable).

/*
FNXC:WorkflowResolvedColumns 2026-07-27-15:30 (U10 / R8):
Title/description editing belongs to PRE-IMPLEMENTATION lanes — the card has no session, no
worktree, and no plan being executed against the text. That was encoded as the legacy id pair
{triage, todo}, so a workflow that renames its planning lane (or U11's Todo→Planning merge)
silently lost the Edit affordance with nothing on screen to explain it. Resolve it from the
card's own column traits instead, and keep the legacy id set as the fallback for the window
before the board-workflows payload resolves and for a column the workflow does not declare —
where the traits are unknown rather than known-false.
*/
function isTaskFieldEditableColumn(column: ColumnId, flags?: TaskContextMenuColumnFlags): boolean {
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-00:15 (U12): body moved UNCHANGED to
  `isFieldEditableColumnRole`, so this and TaskCard cannot drift apart again. TaskCard implemented the
  same affordance with the raw id set and no trait path, which is how a renamed board lost inline
  editing on the card while this surface kept it.
  */
  return isFieldEditableColumnRole(flags, column);
}
const GITHUB_TRACKING_EDITABLE_COLUMNS: Set<ColumnId> = new Set<ColumnId>(["triage", "todo", "in-progress", "in-review", "ideas"]);
const CODING_IDEAS_WORKFLOW_ID = "builtin:coding-ideas-v2";

/*
FNXC:GitHubTracking 2026-07-22-00:46:
Ideas tasks must be able to opt into or out of GitHub tracking before planning, whether they remain in the Ideas intake column or have advanced in Coding (Ideas). Use the resolved workflow ID rather than its display name so localized names and arbitrary custom workflows cannot gain this editing capability.

FNXC:WorkflowSuccession 2026-09-06-02:15:
The GitHub-tracking exception follows the surviving builtin:coding-ideas-v2 identity. Authoritative selection reads canonicalize retired rows before this UI sees them, so the removed id needs no second affordance branch.
*/
/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:59:
THE EDITABLE SET IS A HARDCODED LEGACY LANE LIST, so on a renamed board this capability disappeared.

`GITHUB_TRACKING_EDITABLE_COLUMNS` is `{triage, todo, in-progress, in-review, ideas}` — every lane
except the terminal two. It was consulted with `.has(column)` and had NO resolved branch and NO flags
fallback, so on a board with renamed lanes it matched nothing and `canTaskEditGithubTracking` returned
false for EVERY task. The operator simply could not turn GitHub tracking on or off, with no error and
no explanation; the only thing keeping it reachable was the unrelated Ideas-workflow escape
hatch on the right.

WHY NO CHECK SAW IT. The census counts COMPARISONS against legacy ids. This is a Set literal — a
DEFINITION — consulted via `.has()`, so nothing in the backlog ever pointed here. Same blind spot that
hid `TIME_INDICATOR_COLUMNS` and `BLOCKER_ESCALATION_COLUMNS`, both of which were also found by hand
rather than by any gate.

The set's meaning is "not finished": every lane except the workflow's Complete column. That is what the roles
now express. Flags are OPTIONAL and the legacy set remains the fallback, so a render before the
workflow metadata lands behaves exactly as it does today.

FLAGS MUST BE THE TASK-IDENTITY-GUARDED VALUE. The caller passes `detailColumnFlags`, which is
`undefined` unless `workflowMoveMetadata` describes THIS task — `workflowMoveMetadata` outlives a task
switch, and this file's 2026-07-30-17:30 note records six review findings from consumers that read
around that guard. Passing the unguarded value would answer about the previous card's workflow, which
is worse than the legacy fallback because it is confidently wrong rather than merely stale.
*/
function canTaskEditGithubTracking(
  column: ColumnId,
  workflowId: string | undefined,
  columnFlags: TaskContextMenuColumnFlags | undefined,
): boolean {
  if (workflowId === CODING_IDEAS_WORKFLOW_ID) return true;
  if (!columnFlags) return GITHUB_TRACKING_EDITABLE_COLUMNS.has(column);
  return !isCompleteColumnRole(columnFlags, column);
}

export function TaskDetailContent({
  task,
  projectId,
  tasks = [],
  columnFlagsByTaskId,
  onOpenDetail,
  onDeleteTask,
  onReviseTask,
  onRevertTask,
  onMergeTask,
  onRetryTask,
  onOpenChatWithPrefill,
  onPauseTask,
  onUnpauseTask,
  onBypassReview,
  onResetTask,
  onDuplicateTask,
  onTaskUpdated,
  onRefinementCreated,
  addToast,
  prAuthAvailable,
  autoMergeEnabled: autoMergeEnabledProp,
  globalPaused = false,
  onOpenWorkflowEditor,
  /**
   * FNXC:TaskDetailActivityFirst 2026-06-30-23:59:
   * The Activity tab is still addressed as `chat` internally so existing callers and deep links do not break; the visible Chat tab uses `planner-chat` and only becomes the omitted non-done default when taskDetailChatFirst is true.
   */
  initialTab,
  initialAction,
  taskDetailChatFirst = false,
  mobileHeaderMode = "close",
  embedded = false,
  active = true,
  onRequestClose,
  onBackToBoard,
  onPopOut,
  workflowFieldDefs: workflowFieldDefsProp,
}: TaskDetailContentProps) {
  const { t } = useTranslation("app");
  const columnLabel = useColumnLabel();
  const fileBrowser = useFileBrowser();
  const [activeTab, setActiveTab] = useState<TabId>(() => resolveDefaultTab(initialTab, task.column, taskDetailChatFirst));
  const [activitySegment, setActivitySegment] = useState<ActivitySegment>(() => resolveDefaultActivitySegment(initialTab));
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [plannerChatExpanded, setPlannerChatExpanded] = useState(false);

  /*
  FNXC:TaskDetailTabKeepAlive 2026-07-22-12:55:
  FN remount-churn fix R6: the Terminal, Worktree-terminal, and Planner-chat tab bodies previously lived in the mutually-exclusive activeTab ternary, so every tab flip disposed the xterm instance, closed the terminal WebSocket, and discarded the planner composer/scroll. After a tab's first open (per-tab latch, mirroring Quick Chat's everOpened gate) its body stays mounted as a hidden KeepAliveView sibling of the ternary. The latches are scoped to one task id: switching tasks (or closing the detail) resets them so terminals fully unmount and dispose exactly as before — keep-alive covers tab switching within ONE open task detail only (R10).
  */
  const [keepAliveTabs, setKeepAliveTabs] = useState({ taskId: task.id, plannerChat: false, terminal: false, worktreeTerminal: false });
  if (keepAliveTabs.taskId !== task.id) {
    setKeepAliveTabs({ taskId: task.id, plannerChat: false, terminal: false, worktreeTerminal: false });
  } else if (activeTab === "planner-chat" && !keepAliveTabs.plannerChat) {
    setKeepAliveTabs({ ...keepAliveTabs, plannerChat: true });
  } else if (activeTab === "terminal" && !keepAliveTabs.terminal) {
    setKeepAliveTabs({ ...keepAliveTabs, terminal: true });
  } else if (activeTab === "worktree-terminal" && !keepAliveTabs.worktreeTerminal) {
    setKeepAliveTabs({ ...keepAliveTabs, worktreeTerminal: true });
  }
  const keepAliveForCurrentTask = keepAliveTabs.taskId === task.id ? keepAliveTabs : { taskId: task.id, plannerChat: false, terminal: false, worktreeTerminal: false };

  // ── CLI agent session (U11) ────────────────────────────────────────────────
  const [cliSession, setCliSession] = useState<CliSessionSummaryRecord | null>(null);

  // ── Async detail loading ──────────────────────────────────────────────────
  // When opened optimistically with a Task (no prompt), fetch the full
  // TaskDetail in the background. The modal renders immediately with the
  // lightweight data and shows a loading indicator in the spec section.
  const [fullDetail, setFullDetail] = useState<TaskDetail | null>(() =>
    "prompt" in task ? (task as TaskDetail) : null,
  );
  const [detailLoading, setDetailLoading] = useState(() =>
    !("prompt" in task),
  );
  const fullDetailRef = useRef(fullDetail);
  fullDetailRef.current = fullDetail;
  const [verificationRequest, setVerificationRequest] = useState<TaskVerificationRequest | null>(null);
  const [specLock, setSpecLock] = useState<SpecLockResponse | null>(null);
  const [overlapBlockerReport, setOverlapBlockerReport] = useState<TaskOverlapBlockerReport | null>(null);
  const [overlapBlockerReportError, setOverlapBlockerReportError] = useState(false);
  const [overlapBlockerReportLoading, setOverlapBlockerReportLoading] = useState(false);
  const detailRequestGenerationRef = useRef(0);
  const detailRequestRef = useRef<{ key: string; promise: Promise<TaskDetail> } | null>(null);
  /*
  FNXC:TaskDetailPlan 2026-08-05-04:26:
  A narrow Definition response may beat a slim task's in-flight full detail response. Overlay it only when its evidence sequence is newer than the sequence captured when that detail read was issued; a prompt observed before a later authoritative read must never overwrite that read on arrival.

  FNXC:TaskDetailPlan 2026-08-28-15:31:
  The Plan view must not blank on a degradable narrow read and must recover without a close/reopen. Retain the last usable narrow prompt, sequence every adoption, and use a follow-up full detail read as prompt authority when degraded evidence needs confirmation.
  */
  const promptEvidenceSequenceRef = useRef(0);
  const latestPromptResponseRef = useRef<{ key: string; prompt: string; sequence: number } | null>(null);
  const promptReverifyInFlightRef = useRef<{key: string; promise: Promise<TaskDetail>} | null>(null);

  /*
  FNXC:TaskDetailPlan 2026-08-03-02:24:
  A slim task can need its initial detail and its visible Definition refresh in the same commit.
  Share that project-scoped request so opening Definition produces one authoritative fetch rather
  than invalidating the initial load and issuing duplicate traffic.
  */
  const requestTaskDetail = useCallback((taskId: string, requestProjectId?: string) => {
    const key = `${requestProjectId ?? ""}:${taskId}`;
    if (detailRequestRef.current?.key === key) return detailRequestRef.current.promise;

    const promise = fetchTaskDetail(taskId, requestProjectId);
    detailRequestRef.current = { key, promise };
    void promise.then(
      () => { if (detailRequestRef.current?.promise === promise) detailRequestRef.current = null; },
      () => { if (detailRequestRef.current?.promise === promise) detailRequestRef.current = null; },
    );
    return promise;
  }, []);

  const adoptAuthoritativeDetail = useCallback((
    detail: TaskDetail,
    {issuedPromptSequence, promptAuthority}: {issuedPromptSequence: number; promptAuthority: boolean},
  ) => {
    const promptResponse = latestPromptResponseRef.current;
    const promptResponseMatchesDetail = promptResponse?.key === `${projectId ?? ""}:${detail.id}`
      && promptResponse.sequence > issuedPromptSequence;
    const nextDetail = promptResponseMatchesDetail
      ? {...detail, prompt: promptResponse.prompt} as TaskDetail
      : detail;
    setFullDetail((previous) => {
      if (previous?.id !== detail.id) return nextDetail;
      const merged = mergeTaskSnapshot(previous, nextDetail, {fullSnapshot: true});
      /*
      FNXC:TaskDetailPlan 2026-08-28-15:31:
      A full detail read issued because narrow prompt evidence degraded is the freshest available statement about PROMPT.md. File content is not governed by the task row's updatedAt, so this explicit authority must carry an honest clear through equal or older row clocks.
      */
      return promptAuthority ? {...merged, prompt: nextDetail.prompt} as TaskDetail : merged;
    });
  }, [projectId]);

  /*
  FNXC:TaskPopupViewGating 2026-07-23-10:20:
  Kept-alive hidden popups (active=false) must not keep polling the verification endpoint every 5s —
  with several hidden popups mounted this multiplied into constant background requests. Suspend the
  interval while hidden; the effect re-runs on reveal, so an immediate refresh plus a fresh interval
  resume exactly the visible behavior. Visible hosts (active defaults true) are unchanged.
  */
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const refresh = () => void fetchTaskVerificationRequest(task.id, projectId)
      .then((request) => { if (!cancelled) setVerificationRequest(request); })
      .catch(() => { if (!cancelled) setVerificationRequest(null); });
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [task.id, projectId, active]);

  /*
  FNXC:SpecLockTaskDetail 2026-08-28-23:05:
  Both modal and right-dock hosts render this shared content, so Details requests the persisted
  report only when its consolidated diagnostics disclosure can be opened. Rendering must not
  re-evaluate prompt prose in-browser.
  */
  useEffect(() => {
    if (!active || activeTab !== "details") return;
    let cancelled = false;
    void fetchSpecLock(task.id, projectId)
      .then((value) => { if (!cancelled) setSpecLock(value); })
      .catch(() => { if (!cancelled) setSpecLock(null); });
    return () => { cancelled = true; };
  }, [active, activeTab, projectId, task.id]);

  useEffect(() => {
    /*
    FNXC:TaskDetailPlan 2026-08-03-02:06:
    Hidden kept-alive hosts defer their initial detail request until reveal.

    FNXC:TaskDetailPlan 2026-08-28-15:31:
    A reveal refetch may fail transiently, so keep a loaded same-task detail and its plan visible while the request runs and after rejection. A task-id switch still clears the preceding task immediately so no plan crosses task identities.
    */
    if (!active) return;
    // If the prop already has a prompt field, it's a full TaskDetail
    if ("prompt" in task) {
      setFullDetail((previous) => previous?.id === task.id ? mergeTaskSnapshot(previous, task) : task as TaskDetail);
      setDetailLoading(false);
      return;
    }

    let cancelled = false;
    const requestGeneration = ++detailRequestGenerationRef.current;
    const hasRetainedSameTaskDetail = fullDetailRef.current?.id === task.id;
    setDetailLoading(!hasRetainedSameTaskDetail);
    setFullDetail((previous) => previous?.id === task.id ? previous : null);

    const issuedPromptSequence = promptEvidenceSequenceRef.current;
    requestTaskDetail(task.id, projectId)
      .then((detail) => {
        if (!cancelled && detailRequestGenerationRef.current === requestGeneration) {
          adoptAuthoritativeDetail(detail, {issuedPromptSequence, promptAuthority: false});
          setDetailLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled && detailRequestGenerationRef.current === requestGeneration) {
          setDetailLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [task.id, projectId, active, requestTaskDetail, adoptAuthoritativeDetail]);

  // Derive a working task that always has all available fields.
  // Falls back to the optimistic Task while loading, uses fullDetail once loaded.
  // Live fields (tokenUsage, workflowStepResults, status, column, …) are taken
  // from the parent `task` prop which receives SSE updates, so the stats tab
  // keeps populating while a task runs after the modal was opened. `log` is
  // stripped to [] in SSE payloads (stripTaskListHeavyFields), so we preserve
  // fullDetail.log to keep the Activity timeline populated.
  // FN-4161: board/restart flows open the modal from slim task rows where
  // `githubTracking` is intentionally omitted; preserve the fetched full-detail
  // tracking blob instead of letting the sparse parent prop overwrite it.
  const [overlapBlockedByOverride, setOverlapBlockedByOverride] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setOverlapBlockedByOverride(undefined);
  }, [task.id]);
  const workingTask: TaskDetail = fullDetail
    ? ({
      ...mergeTaskSnapshot(fullDetail, task),
      /*
      FNXC:TaskDetailOverlapRepair 2026-06-25-04:34:
      SSE task props are authoritative for live blocker changes, but the Clear repair flow needs a local override while stale parent props catch up. Only fall back to fetched detail when the slim parent omitted the field entirely.
      */
      overlapBlockedBy: overlapBlockedByOverride !== undefined
        ? overlapBlockedByOverride
        : task.overlapBlockedBy === undefined ? fullDetail.overlapBlockedBy : task.overlapBlockedBy,
    } as TaskDetail)
    : ({ ...task, prompt: "" } as TaskDetail);
  const retainedPromptRef = useRef(workingTask.prompt);
  retainedPromptRef.current = workingTask.prompt;
  const activityLog = workingTask.log ?? [];

  useEffect(() => {
    if (!active || activeTab !== "dependencies" || !workingTask.overlapBlockedBy) {
      setOverlapBlockerReport(null);
      setOverlapBlockerReportError(false);
      setOverlapBlockerReportLoading(false);
      return;
    }
    let cancelled = false;
    const identity = `${projectId ?? ""}:${workingTask.id}:${workingTask.overlapBlockedBy}`;
    setOverlapBlockerReportLoading(true);
    setOverlapBlockerReportError(false);
    void fetchOverlapBlockerReport(workingTask.id, projectId)
      .then((report) => {
        if (!cancelled && identity === `${projectId ?? ""}:${workingTask.id}:${workingTask.overlapBlockedBy}`) {
          setOverlapBlockerReport(report);
        }
      })
      .catch(() => {
        if (!cancelled) setOverlapBlockerReportError(true);
      })
      .finally(() => {
        if (!cancelled) setOverlapBlockerReportLoading(false);
      });
    return () => { cancelled = true; };
  }, [active, activeTab, projectId, workingTask.id, workingTask.overlapBlockedBy]);
  const planSummary = useMemo(() => splitTaskPlanSummary(workingTask.prompt || ""), [workingTask.prompt]);
  const handleCopyActivityLogs = useCallback(async () => {
    if (detailLoading || activityLog.length === 0) return;
    const copied = await copyTextToClipboard(serializeTaskActivityLogs(activityLog));
    addToast(
      copied
        ? t("taskDetail.logs.copySuccess", "Displayed activity copied to clipboard")
        : t("taskDetail.logs.copyFailure", "Failed to copy displayed activity"),
      copied ? "success" : "error",
    );
  }, [activityLog, addToast, detailLoading, t]);
  /*
  FNXC:TaskStatusConsistency 2026-08-05-04:30:
  Detail hosts consume the same reconciled snapshot as board and list cards. Show live planning as
  Planning, while an idle `needs-replan` remains Queued to revise; this prevents an open modal from
  presenting a different lifecycle than the card that launched it.
  */
  const taskStatusBadgeLabel = isTaskPlanningActive(workingTask, { globalPaused })
    ? t("tasks.statusPlanning", "Planning")
    : getTaskStatusBadgeLabel(workingTask.status, t, undefined, {
      idle: true,
      overlapBlockedBy: workingTask.overlapBlockedBy ?? null,
      sessionContentionWaitReason: workingTask.sessionContentionWaitReason ?? null,
    });
  const originalTaskPrompt = workingTask.description ?? "";
  const hasOriginalTaskPrompt = originalTaskPrompt.trim().length > 0;
  /*
  FNXC:WorkflowStepResults 2026-06-26-18:00:
  The detail Progress bar must show a segment for each ENABLED workflow step, not only
  implementation steps. Drive it from the same unified model the cards use
  (getUnifiedTaskProgress: task.steps + enabledWorkflowSteps, statuses from
  task.workflowStepResults) so an enabled optional step (e.g. "Code Review") gets its own
  segment even before it runs (pending).
  */
  const unifiedProgress = useMemo(
    () => getUnifiedTaskProgress(workingTask),
    [workingTask.steps, workingTask.enabledWorkflowSteps, workingTask.workflowStepResults],
  );
  const openPromptFile = useCallback(() => {
    fileBrowser?.openFile(`.fusion/tasks/${workingTask.id}/PROMPT.md`, { workspace: "project" });
  }, [fileBrowser, workingTask.id]);
  const hasPendingRecovery = hasPendingAutomaticRecovery(task);
  const nearDuplicateOf = isStringValue(workingTask.sourceMetadata?.nearDuplicateOf)
    ? workingTask.sourceMetadata.nearDuplicateOf
    : null;
  const nearDuplicateCanonical = nearDuplicateOf
    ? tasks.find((candidate) => candidate.id === nearDuplicateOf)
    : undefined;
  /**
   * FNXC:NearDuplicateDetection 2026-06-14-12:00:
   * The duplicate banner is actionable only while the referenced canonical exists and is active.
   * Suppress the whole affordance for missing, completed, or soft-deleted canonicals so no empty banner shell or stale user-decision buttons remain.
   */
  /*
  FNXC:DuplicateIntake 2026-07-30-05:00 DELIBERATE-LITERAL: terminal check on THIS modal's own task,
  and the flags for it are not resolved at this point in the render. `workflowMoveMetadata` (which
  carries `currentColumnFlags`) is fetched asynchronously and is null on first paint, so reading it
  here would suppress the near-duplicate warning for one frame on every open — a flicker on a
  correctness banner. The completion id is stable for every board that has not renamed done,
  and the cost of the legacy answer is bounded: a renamed terminal column shows the banner one state
  too long, versus hiding it wrongly on every open.

  FNXC:WorkflowResolvedColumns 2026-07-30-20:10 (PR #2772 review — I TRIED THIS AND WAS WRONG):
  The sizing above stands, and I am recording the failed attempt so it is not retried a third time.

  I converted the check to `isCompleteColumnRole`, reasoning that the helper's
  id-fallback makes a first-paint read byte-identical to the literal, so no parent change is needed.
  tsc refused it: `detailColumnFlags` is declared ~60 lines BELOW this point (it derives from
  `workflowMoveMetadata`, a useState at ~959), so the value simply does not exist here. "The flags are
  already in this component" was true and irrelevant — they are not in scope AT THIS LINE.

  Hoisting the state and its derivation above this block is the actual fix, and it is a hook-ordering
  change in a 5000-line component, which is what the original note meant by not attempting it under
  batch pressure. Left counted.

  FNXC:WorkflowResolvedColumns 2026-07-30-23:30 (the hoist would have been WRONG, not just costly):
  Correcting the paragraph above before someone acts on it. Hoisting applies to the two terminal
  checks on `task.column`, where `detailColumnFlags` is the right flags. It does NOT extend to the
  `isNearDuplicateCanonicalInactive` call on the next line, which the seam check reports as an
  omitted supplier — and that is a case where satisfying the check would introduce a bug.

  `detailColumnFlags` describes THIS modal's task, guarded by `detailFlagsAreForThisTask`. The
  canonical is a DIFFERENT task, on a column this component never resolves. Passing the modal's flags
  would answer "is the canonical's column active?" using the open task's column traits — the per-task
  vs union confusion that `column-role-degraded-flags.test.ts` exists to catch, and it would type-check
  and read as a conversion.

  FNXC:WorkflowResolvedColumns 2026-07-31-03:10 (the "needs a fetch" blocker was never tested):
  The paragraph above rejected passing `detailColumnFlags` — correctly, that would answer about the
  wrong task — and then concluded the seam needs a data change. It does not. `columnFlagsByTaskId` is
  already a prop of this component (declared :367, destructured :727, used for the fan-out map), and
  it is keyed by task id. The canonical is `tasks.find(c => c.id === nearDuplicateOf)`, so it is
  drawn from the same loaded set the map covers — a `.get(canonical.id)` is the canonical's OWN
  flags, with no fetch.

  `Column.tsx:307` already does exactly this, with a comment making the same point about not reusing
  the row's flags. The blocker was asserted from the shape of the problem (two different tasks) rather
  than tested against what was in scope.

  A canonical the map does not cover yields `undefined`, which is the documented legacy fallback —
  strictly better than always-legacy, never a fabricated answer.
  */
  /*
  FNXC:NearDuplicateDetection 2026-08-23-04:10:
  FN-173 makes the duplicate flag acknowledgeable rather than an opaque decision. The actions row only
  exists for Delete or Keep so ordinary cards do not leave an empty shell.
  */
  // FNXC:WorkflowLifecycle 2026-08-31-07:33: DELIBERATE-LITERAL — absent canonical workflow flags require legacy terminal-column fallback semantics.
  const showNearDuplicateWarning = Boolean(nearDuplicateOf)
    && workingTask.sourceMetadata?.nearDuplicateDismissed !== true
    && task.column !== "done"
    && !isNearDuplicateCanonicalInactive(
      nearDuplicateCanonical,
      /* The CANONICAL's own flags, keyed by its id — never `detailColumnFlags`, which describes this
         modal's task. Same shape as Column.tsx:307, the sibling site that already does this. */
      nearDuplicateCanonical ? columnFlagsByTaskId?.get(nearDuplicateCanonical.id) : undefined,
    );
  const [sourceAgent, setSourceAgent] = useState<Agent | null>(null);
  const [selectedSourceAgentId, setSelectedSourceAgentId] = useState<string | null>(null);
  const provenanceDisplay = getProvenanceLabel(workingTask, {
    sourceAgentName: sourceAgent?.name,
    t,
  });
  /**
   * FNXC:TaskRevert 2026-07-04-00:00:
   * Forward direction (FN-7555): when this task IS an AI-undo task (`sourceMetadata.revertOf`
   * set by `createAiUndoTask`), surface a "Created to undo <sourceId>" provenance clause with
   * a clickable link to the source task, alongside — not replacing — the base provenance label.
   */
  const revertOfId = getRevertOfId(workingTask.sourceMetadata, workingTask.sourceParentTaskId, workingTask.sourceType);
  /**
   * FNXC:TaskRevert 2026-07-04-00:00:
   * Reverse direction (FN-7555): scan the loaded `tasks` list for the most recent OPEN undo
   * task pointing back at this task via `revertOf`. Mirrors `TaskStore.findOpenRevertTaskForSource`
   * (open board columns only) so a completed or soft-deleted prior undo attempt never renders as
   * an active "Undo task" link — that would be a stale/leftover affordance.
   */
  /* FNXC:WorkflowResolvedColumns 2026-07-31-23:20: the CANDIDATES' own flags, keyed by id — the same
     per-neighbour supply this component already uses for the near-duplicate canonical above. */
  const openUndoTask = findOpenUndoTaskForSource(tasks, workingTask.id, columnFlagsByTaskId);

  const previousInitialTabRef = useRef<TabId | undefined>(initialTab);
  const taskColumnRef = useRef(task.column);
  const taskDetailChatFirstRef = useRef(taskDetailChatFirst);
  taskColumnRef.current = task.column;
  taskDetailChatFirstRef.current = taskDetailChatFirst;

  /*
  FNXC:TaskDetailTabPersistence 2026-07-17-17:46:
  FN-8256 / issue #2282 requires live column updates to preserve the modal's selected
  tab, Activity segment, and retry expansion. This sync exists only for caller-driven
  `initialTab` changes; dedicated guards below own column-invalidated PR and Summary tabs.
  */
  useEffect(() => {
    if (initialTab === previousInitialTabRef.current) return;

    previousInitialTabRef.current = initialTab;
    setActiveTab(resolveDefaultTab(initialTab, taskColumnRef.current, taskDetailChatFirstRef.current));
    setActivitySegment(resolveDefaultActivitySegment(initialTab));
    setRetriesExpanded(initialTab === "retries");
    setRoutingExpanded(initialTab === "routing");
    setDebugExpanded(initialTab === "debug");
  }, [initialTab]);

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-02:30 (PR #2698 review — greptile P1, fourth form):
  CARRIES THE TASK IT DESCRIBES. The fetch effect resets this to null on a task change, but it is
  declared BELOW the reconciliation effects, so on the render where the modal switches tasks those
  run first and still see the PREVIOUS task's flags. Non-null is therefore not the same as
  "resolved for this task", which is what my earlier guard actually assumed.

  Tagging the payload makes that checkable instead of order-dependent: consumers compare `taskId`
  and fall back to the legacy id when it does not match, which is the same safe answer they use
  before any fetch has landed.
  */
  const [workflowMoveMetadata, setWorkflowMoveMetadata] = useState<(Partial<Pick<TaskWorkflowMetadata, "moveColumns" | "currentColumnFlags">> & { taskId: string }) | null>(null);

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-23:30 (fleet: TaskDetailModal.tsx):
  The card's ROLES, resolved from the column flags this modal already fetches. Declared immediately
  after `workflowMoveMetadata` because that state is their source — anything above this line cannot
  reference them without a temporal-dead-zone error, which is why four sites higher in the component
  are flagged in the PR rather than converted here.

  `currentColumnFlags` is null until the workflow fetch resolves, so these flip after first paint.
  Every consumer below therefore lists the role it reads in its dependency array — the same
  late-arriving-flags hazard that produced four stale memos in TaskCard (PR #2688 review). This repo
  has no react-hooks/exhaustive-deps rule, so that is checked by hand.
  */
  /*
  Flags only when they describe THIS task. On the render where the modal switches tasks the state
  still holds the previous card's payload, and using it would resolve roles from another task's
  workflow — worse than the legacy fallback, because it is confidently wrong rather than merely
  stale. `undefined` here gives every role the same answer it uses before any fetch lands.
  */
  const detailFlagsAreForThisTask = workflowMoveMetadata?.taskId === task.id;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-17:30 (one root cause, SIX review findings):
  EVERY consumer in this file reads the task-identity-guarded value. `workflowMoveMetadata` outlives a
  task switch, so while the modal is open its flags describe the PREVIOUS task for a render — and this
  component gates editability, the execution-mode replan decision, the intake affordance, the actions
  menu and the review tab on them.

  The guard existed from the start; five call sites simply read around it, and each was found
  separately: #2744 (review tab), #2696 (handleDelete deps), and the four here. Converting them
  together retires the class instead of paying another review round per site.
  */
  const detailColumnFlags = detailFlagsAreForThisTask ? workflowMoveMetadata?.currentColumnFlags : undefined;
  const isDoneColumn = isCompleteColumnRole(detailColumnFlags, task.column);
  const isWipColumn = isWipColumnRole(detailColumnFlags, task.column);
  const isReviewColumn = isReviewColumnRole(detailColumnFlags, task.column);
  // FNXC:WorkflowLifecycle 2026-08-31-07:33: DELIBERATE-LITERAL — absent detail workflow flags require the legacy mutable-column fallback.
  const isMutableLiveColumn = detailColumnFlags
    ? detailColumnFlags.complete !== true
    : task.column !== "done";

  useEffect(() => {
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-00:30 (PR #2698 review — greptile P1):
    Must use the ROLE, because tab VISIBILITY already does. Leaving this on the literal while the
    tab's visibility check resolved traits made the two disagree on a custom board: the PR tab
    appeared (the column carries the review role) and this effect immediately bounced the operator
    back to Changes, because the column is not named `in-review`. A tab that shows up and instantly
    redirects is worse than one that never shows.

    That inconsistency was created by converting half the pair. The state this reads is hoisted above
    these effects for exactly this reason — see the note at its declaration.
    */
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-01:30 (PR #2698 review — greptile P1, third form):
    DO NOT REDIRECT ON AN UNRESOLVED ROLE. `workflowMoveMetadata` is null until the workflow fetch
    lands, so on first paint `isReviewColumn` is the legacy-id fallback — false for a custom review
    column. Without this guard the modal opens, immediately bounces the operator off the PR tab they
    chose, and never restores it when the real answer arrives: the redirect is destructive and the
    correction is not.

    Waiting is the safe direction. Showing the PR tab a moment longer on a card that turns out not to
    be in review is benign and self-corrects the instant metadata resolves; throwing away a
    deliberate tab selection does not.
    */
    if (!detailFlagsAreForThisTask) return;
    if (activeTab === "pr" && !isReviewColumn) {
      setActiveTab("definition");
    }
  }, [activeTab, task.column, isReviewColumn, detailFlagsAreForThisTask]);

  /*
  FNXC:TaskRecommendations 2026-08-28-23:05:
  Summary shows Recommendations only when captured content belongs to this task. A task switch can
  briefly merge the prior full-detail snapshot into a slim prop, so use positive snapshot identity
  rather than detailLoading; rejected fetches and hidden kept-alive hosts cannot make stale advice
  appear under a different task's report.
  */
  const detailSnapshotIsForThisTask = fullDetail?.id === task.id;
  const taskOwnedRecommendations = detailSnapshotIsForThisTask
    ? workingTask.recommendations
    : task.recommendations;
  const hasRecommendations = isDoneColumn && (taskOwnedRecommendations?.length ?? 0) > 0;
  // Reset planner-chat focus when the operator opens a different task.
  useEffect(() => {
    setPlannerChatExpanded(false);
  }, [task.id]);

  const [highlightStallCode, setHighlightStallCode] = useState<string | null>(null);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [titleOverflows, setTitleOverflows] = useState(false);
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const displayTitleText = task.title || task.description || task.id;

  /*
  FNXC:TaskDetailTitle 2026-08-05-18:48:
  Browser layout proved that swapping bare heading text for the semantic title button can alter the
  exact box whose overflow decides whether that button exists. Measure an always-present text span
  with the collapsed two-line rules instead; the button is an out-of-flow accessible overlay and
  cannot feed back into eligibility. Expansion remains an operator-owned state across modal,
  full-panel, split-pane, right-dock, and floating-window hosts. Reset only for a new task or its
  title/description/id fallback, never from a resize delivery. Kept-alive hidden pop-outs are not a
  live layout authority: disconnect and fence their callbacks until their host is visible again.
  */
  useLayoutEffect(() => {
    setDescriptionExpanded(false);
    setTitleOverflows(false);
  }, [displayTitleText, task.id]);
  const [attachments, setAttachments] = useState<TaskAttachment[]>(task.attachments || []);
  const [uploading, setUploading] = useState(false);
  const [dependencies, setDependencies] = useState<string[]>(task.dependencies || []);
  const [showDepDropdown, setShowDepDropdown] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  const [assignedAgent, setAssignedAgent] = useState<Agent | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [isSavingSpec, setIsSavingSpec] = useState(false);
  const [isRequestingRevision, setIsRequestingRevision] = useState(false);
  const [isEditingSpec, setIsEditingSpec] = useState(false);
  const [specEditContent, setSpecEditContent] = useState(workingTask.prompt || "");
  const [specFeedback, setSpecFeedback] = useState("");
  const [showRefineModal, setShowRefineModal] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);

  /*
  FNXC:TaskDetailPlan 2026-08-05-04:05:
  Definition polls only PROMPT.md while planning or graph Plan Review may rewrite it; board/SSE/mutations continue to own lifecycle and workflow state. A usable narrow response may refresh the retained plan, but an absent or blank response is degradable evidence and triggers one authoritative detail re-read instead of clearing the view.
  */
  const promptRefreshLifecycleActive = isPromptRefreshLifecycleActive(task);
  useEffect(() => {
    if (!active || activeTab !== "definition") return;

    let cancelled = false;
    let inFlight = false;
    const identity = `${projectId ?? ""}:${task.id}`;
    const schedulePromptReverify = () => {
      if (promptReverifyInFlightRef.current?.key === identity) return;
      // A shared request predates this degraded observation and has not earned prompt authority.
      if (detailRequestRef.current?.key === identity) return;

      const requestGeneration = detailRequestGenerationRef.current;
      const issuedPromptSequence = promptEvidenceSequenceRef.current;
      const promise = requestTaskDetail(task.id, projectId);
      const request = {key: identity, promise};
      promptReverifyInFlightRef.current = request;
      void promise
        .then((detail) => {
          if (!mountedRef.current
            || detailRequestGenerationRef.current !== requestGeneration
            || activeTaskIdRef.current !== detail.id) return;
          adoptAuthoritativeDetail(detail, {issuedPromptSequence, promptAuthority: true});
        })
        .catch(() => undefined)
        .finally(() => {
          if (promptReverifyInFlightRef.current === request) promptReverifyInFlightRef.current = null;
        });
    };
    const refreshPrompt = () => {
      if (inFlight) return;
      inFlight = true;
      void fetchTaskPrompt(task.id, projectId)
        .then((response) => {
          if (cancelled || identity !== `${projectId ?? ""}:${task.id}` || response.id !== task.id) return;
          const decision = decideTaskPromptRefresh({
            retainedPrompt: retainedPromptRef.current,
            responsePrompt: response.prompt,
          });
          if (decision.action === "retain") {
            schedulePromptReverify();
            return;
          }
          const prompt = decision.action === "adopt" ? decision.prompt : "";
          latestPromptResponseRef.current = {
            key: identity,
            prompt,
            sequence: ++promptEvidenceSequenceRef.current,
          };
          setFullDetail((previous) => previous ? ({...previous, prompt} as TaskDetail) : previous);
        })
        .catch(() => {
          // FNXC:TaskDetailPlan 2026-08-05-04:05: retain the last good prompt; a later eligible tick may recover.
        })
        .finally(() => { inFlight = false; });
    };

    refreshPrompt();
    if (!promptRefreshLifecycleActive) return () => { cancelled = true; };

    const timer = window.setInterval(refreshPrompt, PROMPT_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, activeTab, projectId, promptRefreshLifecycleActive, task.id, requestTaskDetail, adoptAuthoritativeDetail]);
  const [prCreateOpen, setPrCreateOpen] = useState(false);

  useLayoutEffect(() => {
    // A kept-alive floating detail can be hidden while another view owns its layout. Its stale
    // ResizeObserver delivery must not change eligibility before the host becomes visible again.
    if (!active) return;

    const titleElement = titleRef.current;
    if (!titleElement) {
      setTitleOverflows(false);
      return;
    }

    // Expanded headings have natural height, so only the rendered collapsed layout is a valid
    // overflow measurement. The user choice remains mounted while this observer is disconnected.
    if (descriptionExpanded) return;

    let cancelled = false;
    const measureTitleOverflow = () => {
      if (cancelled) return;
      const overflows = titleElement.scrollHeight > titleElement.clientHeight + 1;
      setTitleOverflows((previous) => previous === overflows ? previous : overflows);
    };

    measureTitleOverflow();

    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(measureTitleOverflow)
      : null;
    resizeObserver?.observe(titleElement);
    window.addEventListener("resize", measureTitleOverflow);

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measureTitleOverflow);
    };
  }, [active, descriptionExpanded, displayTitleText, task.id]);

  /*
  FNXC:WorkflowBadges 2026-06-29-00:00:
  Task details need a stable workflow-name badge because aggregate Board cards can mix tasks from multiple workflows. Resolve the badge name and custom field definitions from the same board-workflows payload so detail headers do not issue duplicate workflow-metadata fetches.

  FNXC:CodingIdeasWorkflow 2026-07-21-00:00:
  Coding (Ideas) intake cards need selected-workflow columns to derive their truthful
  move target through TaskContextMenu. Callers may supply field definitions, but fields
  cannot encode ordered columns, so resolve move metadata independently without replacing
  the caller-owned field definitions.
  */
  const workflowMetadataIdentityRef = useRef<string | null>(null);
  const workflowMetadataFieldDefsRef = useRef<WorkflowFieldDefinition[] | null | undefined>(undefined);
  const [workflowMetadataRevision, setWorkflowMetadataRevision] = useState(0);
  const [taskWorkflowBadge, setTaskWorkflowBadge] = useState<{ id: string; name: string; icon?: string } | null>(null);
  // Custom field definitions (U13/KTD-14). Resolved for this task's workflow
  // from the board-workflows payload; absent when the workflow declares none,
  // in which case the fields section renders nothing (today's UI byte-identical).
  const [customFieldDefs, setCustomFieldDefs] = useState<WorkflowFieldDefinition[] | null>(
    workflowFieldDefsProp !== undefined ? (workflowFieldDefsProp ?? null) : null,
  );
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, unknown>>(task.customFields ?? {});
  const [customFieldError, setCustomFieldError] = useState<CustomFieldRejection | null>(null);

  // Keep local field values in sync when the task prop changes (SSE refresh).
  useEffect(() => {
    setCustomFieldValues(task.customFields ?? {});
  }, [task.id, task.customFields]);

  /*
  FNXC:TaskDetailStateStability 2026-08-05-04:26:
  Task workflow selection changes emit `workflow:updated`, not a task-object update. Revalidate
  the selected workflow payload on that event so an open unchanged-column detail cannot retain
  prior workflow badges or actions; the revision preserves the current metadata while it settles.
  */
  useEffect(() => {
    if (!active) return;
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return subscribeSse(`/api/events${query}`, {
      events: { "workflow:updated": () => setWorkflowMetadataRevision((revision) => revision + 1) },
    });
  }, [active, projectId]);

  // Resolve selected-workflow display and move metadata from the inputs the resolver consumes.
  useEffect(() => {
    /*
    FNXC:TaskDetailStateStability 2026-08-05-04:05:
    Same-task board/SSE object replacements and prompt ticks must not clear workflow badges or
    controls. Column is included because it derives action flags; only a true identity/workflow-field
    switch clears prior metadata, while column revalidation keeps resolved UI mounted until it settles.
    */
    const metadataIdentity = `${projectId ?? ""}:${task.id}`;
    const identityChanged = workflowMetadataIdentityRef.current !== metadataIdentity
      || workflowMetadataFieldDefsRef.current !== workflowFieldDefsProp;
    workflowMetadataIdentityRef.current = metadataIdentity;
    workflowMetadataFieldDefsRef.current = workflowFieldDefsProp;
    if (identityChanged) {
      if (workflowFieldDefsProp !== undefined) setCustomFieldDefs(workflowFieldDefsProp ?? null);
      else setCustomFieldDefs(null);
      setTaskWorkflowBadge(null);
      setWorkflowMoveMetadata(null);
    }
    let cancelled = false;
    void fetchBoardWorkflows(projectId)
      .then((payload) => {
        if (cancelled) return;
        const metadata = resolveTaskWorkflowMetadata(payload, task);
        if (workflowFieldDefsProp === undefined) {
          setCustomFieldDefs(metadata?.fields ?? null);
        }
        setTaskWorkflowBadge(metadata ? { id: metadata.id, name: metadata.name, icon: metadata.icon } : null);
        /*
        FNXC:WorkflowResolvedColumns 2026-07-30-06:00 (PR #2698 review — greptile P1, fifth form):
        SETTLED-EMPTY IS STILL SETTLED. Writing `null` when the lookup returns no metadata is
        indistinguishable from "has not resolved yet", so the reconciliation effects returned
        forever and an invalid tab stayed active indefinitely — the exact failure the identity guard
        was added to prevent, arrived at from the other end.

        Resolution has three states, not two: unresolved (null), resolved-with-flags, and
        resolved-empty. The last one still identifies the task, so consumers know the answer has
        landed and the roles should fall back to the legacy id — which is a real answer, not a
        placeholder.
        */
        setWorkflowMoveMetadata({
          taskId: task.id,
          moveColumns: metadata?.moveColumns,
          currentColumnFlags: metadata?.currentColumnFlags,
        });
      })
      .catch(() => {
        // Keep settled same-task metadata visible during transient revalidation failures.
        if (!cancelled && identityChanged) {
          if (workflowFieldDefsProp === undefined) setCustomFieldDefs(null);
          setTaskWorkflowBadge(null);
          setWorkflowMoveMetadata(null);
        }
      });
    return () => { cancelled = true; };
  }, [task.id, task.column, projectId, workflowFieldDefsProp, workflowMetadataRevision]);

  /*
  FNXC:PlannerOversight 2026-07-04-17:00:
  FN-7517: resolve the WORKFLOW's effective plannerOversightLevel (via the
  same cache/fetch pattern as TaskCard's card-oversight-badge, see the FNXC
  block above `modalWorkflowOversightEffectiveCache`) so the quick
  level-change control shows the TRUE effective level — not a guessed
  schema default — for tasks with no per-task override. Gated on
  `taskWorkflowBadge.id` resolving first (from the board-workflows payload
  fetch above); a known per-task override renders synchronously regardless.
  */
  const workflowIdForOversight = taskWorkflowBadge?.id;
  const [workflowOversightState, setWorkflowOversightState] = useState<ModalWorkflowOversightSettings & { resolved: boolean }>({
    level: undefined,
    sessionAdvisorEnabled: false,
    resolved: false,
  });
  useEffect(() => {
    if (!workflowIdForOversight) {
      setWorkflowOversightState({ level: undefined, sessionAdvisorEnabled: false, resolved: true });
      return;
    }
    const workflowId = workflowIdForOversight;
    const key = getModalWorkflowOversightCacheKey(workflowId, projectId);
    if (modalWorkflowOversightEffectiveCache.has(key)) {
      setWorkflowOversightState({ ...modalWorkflowOversightEffectiveCache.get(key)!, resolved: true });
      return;
    }
    setWorkflowOversightState({ level: undefined, sessionAdvisorEnabled: false, resolved: false });
    let cancelled = false;
    void loadModalWorkflowOversightEffectiveLevel(workflowId, projectId).then((settings) => {
      if (!cancelled) setWorkflowOversightState({ ...settings, resolved: true });
    });
    return () => {
      cancelled = true;
    };
  }, [workflowIdForOversight, projectId]);
  const workflowOversightEffectiveLevel = workflowOversightState.level;
  const workflowOversightResolved = workflowOversightState.resolved;
  const hasTaskOversightOverride = isPlannerOversightLevelValue(task.plannerOversightLevel);
  const effectiveOversightLevel: PlannerOversightLevel = resolveEffectivePlannerOversightLevel(
    task.plannerOversightLevel,
    workflowOversightEffectiveLevel,
  );

  const handleSaveCustomFields = useCallback(
    async (patch: Record<string, unknown>) => {
      setCustomFieldError(null);
      try {
        const updated = await updateTaskCustomFields(task.id, patch, projectId);
        setCustomFieldValues(updated.customFields ?? {});
        onTaskUpdated?.(updated);
      } catch (err) {
        if (err instanceof ApiRequestError && err.details && isStringValue(err.details.fieldId)) {
          setCustomFieldError({
            code: (err.details.code as CustomFieldRejection["code"]) ?? "type-mismatch",
            fieldId: err.details.fieldId,
            detail: isStringValue(err.details.detail) ? err.details.detail : err.message,
          });
          return;
        }
        addToast(getErrorMessage(err) || t("taskFields.saveFailed", "Failed to save field"), "error");
      }
    },
    [task.id, projectId, onTaskUpdated, addToast, t],
  );

  useEffect(() => {
    if (activeTab !== "chat" || activitySegment !== "feed") {
      setHighlightStallCode(null);
      return;
    }

    if (!highlightStallCode) {
      return;
    }

    const highlighted = activityListRef.current?.querySelector<HTMLElement>("[data-stall-highlight=\"true\"]");
    if (highlighted && typeof highlighted.scrollIntoView === "function") {
      highlighted.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeTab, activitySegment, highlightStallCode]);
  const [refineFeedback, setRefineFeedback] = useState("");
  const [isRefining, setIsRefining] = useState(false);

  // Edit mode state
  const [isEditing, setIsEditing] = useState(false);
  const [showFailureRetryPicker, setShowFailureRetryPicker] = useState(false);
  const [failureRetryModels, setFailureRetryModels] = useState<ModelInfo[]>([]);
  const [failureRetryNodes, setFailureRetryNodes] = useState<NodeInfo[]>([]);
  const [failureRetryModel, setFailureRetryModel] = useState("");
  const [failureRetryNodeId, setFailureRetryNodeId] = useState("");
  const [isFailureRetrySaving, setIsFailureRetrySaving] = useState(false);

  useEffect(() => {
    if (activeTab !== "chat" || isEditing) {
      setActivityExpanded(false);
    }
  }, [activeTab, isEditing]);

  useEffect(() => {
    setActivityExpanded(false);
  }, [task.id]);

  const [editTitle, setEditTitle] = useState(task.title || "");
  const [editDescription, setEditDescription] = useState(task.description || "");
  const editDescriptionRef = useRef(editDescription);
  editDescriptionRef.current = editDescription;
  const [editDependencies, setEditDependencies] = useState<string[]>(task.dependencies || []);
  const [editBranch, setEditBranch] = useState(task.branch ?? "");
  const [editBaseBranch, setEditBaseBranch] = useState(task.baseBranch ?? "");
  const [editExecutorModel, setEditExecutorModel] = useState("");
  const [editCredentialInstanceId, setEditCredentialInstanceId] = useState<string | undefined>(undefined);
  const [editValidatorModel, setEditValidatorModel] = useState("");
  const [editValidatorCredentialInstanceId, setEditValidatorCredentialInstanceId] = useState<string | undefined>(undefined);
  const [editPlanningModel, setEditPlanningModel] = useState("");
  const [editPlanningCredentialInstanceId, setEditPlanningCredentialInstanceId] = useState<string | undefined>(undefined);
  const [editThinkingLevel, setEditThinkingLevel] = useState("");
  // FNXC:PlannerOversight 2026-07-04-00:00: Per-task override of the workflow-native plannerOversightLevel setting (FN-7508). "" means "inherit from workflow" (clear-to-default).
  const [editPlannerOversightLevel, setEditPlannerOversightLevel] = useState("");
  const [editPresetMode, setEditPresetMode] = useState<"default" | "preset" | "custom">("default");
  const [editReviewLevel, setEditReviewLevel] = useState<number | undefined>(undefined);
  const [editPriority, setEditPriority] = useState<TaskPriority>(DEFAULT_TASK_PRIORITY);
  const [editNodeId, setEditNodeId] = useState<string | undefined>(task.nodeId);
  const [editExecutionMode, setEditExecutionMode] = useState<"standard" | "fast">(normalizeExecutionModeValue(task.executionMode));
  const [editSelectedPresetId, setEditSelectedPresetId] = useState("");
  const [editSelectedWorkflowSteps, setEditSelectedWorkflowSteps] = useState<string[]>(task.enabledWorkflowSteps || []);
  const handleEditWorkflowStepsChange = useCallback((enabledWorkflowSteps: string[]) => {
    setEditSelectedWorkflowSteps(enabledWorkflowSteps);
  }, []);
  const [editSourceIssueProvider, setEditSourceIssueProvider] = useState(task.sourceIssue?.provider ?? "");
  const [editSourceIssueRepository, setEditSourceIssueRepository] = useState(task.sourceIssue?.repository ?? "");
  const [editSourceIssueExternalId, setEditSourceIssueExternalId] = useState(task.sourceIssue?.externalIssueId ?? "");
  const [editSourceIssueUrl, setEditSourceIssueUrl] = useState(task.sourceIssue?.url ?? "");
  const [editPendingImages, setEditPendingImages] = useState<PendingImage[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isSummarizingTitle, setIsSummarizingTitle] = useState(false);
  const [inlinePriority, setInlinePriority] = useState<TaskPriority>(normalizeTaskPriorityValue(task.priority));
  const [isSavingInlinePriority, setIsSavingInlinePriority] = useState(false);
  const [inlineExecutionMode, setInlineExecutionMode] = useState<"standard" | "fast">(normalizeExecutionModeValue(task.executionMode));
  const [isSavingInlineExecutionMode, setIsSavingInlineExecutionMode] = useState(false);
  const [inlineNoCommitsExpected, setInlineNoCommitsExpected] = useState<boolean>(task.noCommitsExpected === true);
  const [isSavingInlineNoCommitsExpected, setIsSavingInlineNoCommitsExpected] = useState(false);
  // FNXC:PlannerOversight 2026-07-04-17:00: FN-7517 quick oversight-level-change + nudge/stop/explain control state.
  const [isSavingOversightLevel, setIsSavingOversightLevel] = useState(false);
  // FNXC:PlannerOversight 2026-07-14-18:11: saving state for per-task session advisor toggle.
  const [isSavingSessionAdvisor, setIsSavingSessionAdvisor] = useState(false);
  const [isNudgingOverseer, setIsNudgingOverseer] = useState(false);
  const [isStoppingOverseer, setIsStoppingOverseer] = useState(false);
  const [overseerExplainOpen, setOverseerExplainOpen] = useState(false);
  const [isLoadingOverseerExplain, setIsLoadingOverseerExplain] = useState(false);
  const [overseerExplainSnapshot, setOverseerExplainSnapshot] = useState<PlannerOverseerRuntimeSnapshot | null>(null);
  const { confirm, confirmWithCheckbox, confirmWithSelect } = useConfirm();
  const requestClose = useCallback(() => {
    onRequestClose?.();
  }, [onRequestClose]);
  const mountedRef = useRef(false);
  const activeTaskIdRef = useRef(task.id);

  // Split-menu dropdown state for footer actions
  const [showActionsMenu, setShowActionsMenu] = useState(false);
  const [showActivityViewMenu, setShowActivityViewMenu] = useState(false);
  const [activityViewMenuPosition, setActivityViewMenuPosition] = useState<ActivityViewMenuPosition | null>(null);
  const [sourceIssueExpanded, setSourceIssueExpanded] = useState(false);
  const [retriesExpanded, setRetriesExpanded] = useState(initialTab === "retries");
  /*
  FNXC:TaskDetailDetails 2026-08-28-23:05:
  Routing and diagnostics are low-density Details disclosures, closed by default to preserve the
  existing readable metadata flow. Their retired deep links expand the matching disclosure after
  routing to Details, so compatibility retains the content destination without restoring tabs.
  */
  const [routingExpanded, setRoutingExpanded] = useState(initialTab === "routing");
  const [debugExpanded, setDebugExpanded] = useState(initialTab === "debug");
  const [gitlabTrackingExpanded, setGitlabTrackingExpanded] = useState(false);
  // FNXC:TaskDetailPlan 2026-07-04-00:00: Original prompt is collapsed by default (see render site below); operator must click the chevron toggle to reveal the markdown-rendered text.
  const [originalPromptExpanded, setOriginalPromptExpanded] = useState(false);
  const [planDetailsExpanded, setPlanDetailsExpanded] = useState(false);
  useEffect(() => {
    setPlanDetailsExpanded(false);
  }, [workingTask.id]);
  const [githubTrackingExpanded, setGithubTrackingExpanded] = useState(false);
  const [githubRepoOverrideDraft, setGithubRepoOverrideDraft] = useState(task.githubTracking?.repoOverride ?? "");
  const [githubTrackingEnabledDraft, setGithubTrackingEnabledDraft] = useState<boolean | null>(null);
  const [githubRepoOverrideError, setGithubRepoOverrideError] = useState<string | null>(null);
  const [isSavingGithubTracking, setIsSavingGithubTracking] = useState(false);
  const [isCheckingPrStatus, setIsCheckingPrStatus] = useState(false);
  const activityListRef = useRef<HTMLDivElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const activityViewDropdownRef = useRef<HTMLDivElement>(null);
  const activityViewMenuRef = useRef<HTMLDivElement>(null);
  const activityViewButtonRef = useRef<HTMLButtonElement>(null);
  const activityViewMenuViewportGuardUntilRef = useRef(0);
  const activityFeedResyncTimerRef = useRef<number | null>(null);
  const activityFeedResyncRequestRef = useRef<{
    key: string;
    needsFollowUp: boolean;
  } | null>(null);

  // Plugin UI slots for task-detail-tab
  const { getSlotsForId: getPluginSlots } = usePluginUiSlots(projectId);
  const pluginTabSlots = getPluginSlots("task-detail-tab");
  const pluginTabs = pluginTabSlots.map((entry, index) => ({
    entry,
    tabId: `plugin-${entry.pluginId}-${index}` as TabId,
  }));
  const activePluginTab =
    isStringValue(activeTab) && activeTab.startsWith("plugin-")
      ? pluginTabs.find((tab) => tab.tabId === activeTab) ?? null
      : null;

  // ── CLI terminal tab visibility + posture (U11) ────────────────────────────
  const cliOneShot =
    cliSession?.adapterId != null &&
    (cliSession?.autonomyPosture?.purpose === "planning" ||
      cliSession?.autonomyPosture?.purpose === "validator" ||
      cliSession?.autonomyPosture?.readOnly === true);
  const cliGenericIdle = cliSession?.autonomyPosture?.genericIdle === true;
  const cliTabVisibility = useMemo(
    () =>
      deriveCliTabVisibility(cliSession, {
        oneShot: cliOneShot,
        genericIdle: cliGenericIdle,
      }),
    [cliSession, cliOneShot, cliGenericIdle],
  );
  const showCliTab = cliTabVisibility.kind !== "hidden";
  /*
  FNXC:TaskDetailTerminal 2026-07-11-13:20:
  FN-7826 makes the interactive Terminal tab always available in Task Detail. The first shell opens in task.worktree when present; otherwise defaultCwd stays undefined so useTerminalSessions creates a project-root shell, including for multi-repo workspace tasks with no single worktree. Terminal sessions remain task-scoped through scopeId so they do not share the footer/global terminal namespace.
  */
  const taskWorktreeCwd = typeof task.worktree === "string" && task.worktree.trim().length > 0 ? task.worktree : undefined;
  const showWorktreeTerminalTab = true;
  const cliPosture: SessionTerminalPosture | undefined = useMemo(() => {
    if (!cliSession) return undefined;
    const p = cliSession.autonomyPosture ?? {};
    const flags = Array.isArray(p.elevatedFlags) ? (p.elevatedFlags as string[]) : undefined;
    return {
      adapterName: (p.adapterName as string) ?? cliSession.adapterId,
      mode: (p.mode as string) ?? (p.autoApprove ? "auto-approve" : undefined),
      elevated: p.elevated === true,
      elevatedFlags: flags,
      resolved: Array.isArray(p.resolved) ? (p.resolved as string[]) : undefined,
    };
  }, [cliSession]);

  // Confirm-advance handler — POST /api/cli-sessions/:id/confirm-advance.
  const handleConfirmAdvance = useCallback(
    async (decision: "advance" | "not-yet") => {
      if (!cliSession) return;
      try {
        await api(`/cli-sessions/${encodeURIComponent(cliSession.id)}/confirm-advance`, {
          method: "POST",
          body: JSON.stringify({ decision, ...(projectId ? { projectId } : {}) }),
        });
      } catch {
        /* surfaced via the strip's disabled state reset */
      }
    },
    [cliSession, projectId],
  );

  // If the terminal tab is active but the session disappears, fall back.
  useEffect(() => {
    if (activeTab === "terminal" && !showCliTab) setActiveTab("definition");
  }, [activeTab, showCliTab]);


  // Track mount state to avoid setting state on unmounted component
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    activeTaskIdRef.current = task.id;
  }, [task.id]);

  // Merged project settings for effective model resolution in Raw Logs header
  const [settings, setSettings] = useState<Settings | undefined>(undefined);
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings | null>(null);

  // Workflow results state
  const [workflowResults, setWorkflowResults] = useState<WorkflowStepResult[]>([]);
  const [workflowResultsLoading, setWorkflowResultsLoading] = useState(false);
  const [workflowResultsLoadState, setWorkflowResultsLoadState] = useState<WorkflowResultsLoadState>("idle");
  const [workflowEnabledSteps, setWorkflowEnabledSteps] = useState<string[] | undefined>(task.enabledWorkflowSteps);
  const needsWorkflowResults = activeTab === "workflow" || activeTab === "summary";
  /*
  FNXC:TaskHistory 2026-08-28-23:05:
  A successful workflow-results response is authoritative even when it is empty, because the task snapshot can contain reports that were subsequently removed. Summary owns the stage-report request; the report projection uses the snapshot only after a request failure.
  */
  const historyWorkflowResults = workflowResultsLoadState === "failed"
    ? (workingTask.workflowStepResults ?? [])
    : workflowResults;
  const isNodeOverrideLocked = isWipColumn || ACTIVE_STATUSES.has(task.status as string);

  // Reset edit state when task changes
  useEffect(() => {
    setEditTitle(task.title || "");
    setEditDescription(task.description || "");
    setEditBranch(task.branch ?? "");
    setEditBaseBranch(task.baseBranch ?? "");
    setEditSourceIssueProvider(task.sourceIssue?.provider ?? "");
    setEditSourceIssueRepository(task.sourceIssue?.repository ?? "");
    setEditSourceIssueExternalId(task.sourceIssue?.externalIssueId ?? "");
    setEditSourceIssueUrl(task.sourceIssue?.url ?? "");
    setEditExecutionMode(normalizeExecutionModeValue(task.executionMode));
    setSourceIssueExpanded(false);
    setGithubRepoOverrideDraft(workingTask.githubTracking?.repoOverride ?? "");
    setGithubTrackingEnabledDraft(null);
    setGithubRepoOverrideError(null);
    setIsEditing(false);
  }, [task.id, task.title, task.description, task.branch, task.baseBranch, task.sourceIssue, task.executionMode, workingTask.githubTracking]);

  // Disclosure state belongs to the selected task, not to same-task detail
  // refreshes such as GitHub tracking updates or sparse SSE payloads.
  useEffect(() => {
    setGithubTrackingExpanded(false);
  }, [task.id]);

  useEffect(() => {
    setWorkflowEnabledSteps(task.enabledWorkflowSteps);
  }, [task.id, task.enabledWorkflowSteps]);

  useEffect(() => {
    setInlinePriority(normalizeTaskPriorityValue(task.priority));
  }, [task.id, task.priority]);

  useEffect(() => {
    setInlineExecutionMode(normalizeExecutionModeValue(task.executionMode));
  }, [task.id, task.executionMode]);

  useEffect(() => {
    setInlineNoCommitsExpected(task.noCommitsExpected === true);
  }, [task.id, task.noCommitsExpected]);

  useEffect(() => {
    if (githubTrackingEnabledDraft === null) return;
    if ((workingTask.githubTracking?.enabled === true) === githubTrackingEnabledDraft) {
      setGithubTrackingEnabledDraft(null);
    }
  }, [githubTrackingEnabledDraft, workingTask.githubTracking?.enabled]);

  // Load task-scoped settings for effective model resolution.
  useEffect(() => {
    let cancelled = false;
    /*
    FNXC:ModelResolution 2026-06-27-10:52:
    Task-detail model displays are task-scoped because project model lanes moved into workflow setting values. Fetch the effective settings for the selected task so Workflow, Activity → Raw Logs, and Model editor surfaces resolve the same Executor/Reviewer/Planning models the engine uses.
    */
    fetchTaskEffectiveSettings(task.id, projectId)
      .catch(() => fetchSettings(projectId))
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch(() => {
        // Settings fetch failure is non-blocking; fallback to "Using default"
      });
    fetchGlobalSettings()
      .then((nextGlobalSettings) => {
        if (!cancelled) setGlobalSettings(nextGlobalSettings);
      })
      .catch(() => {
        if (!cancelled) setGlobalSettings(null);
      });
    return () => { cancelled = true; };
  }, [projectId, task.id]);

  // Load workflow results when either workflow-report surface is active.
  useEffect(() => {
    if (!needsWorkflowResults) return;
    /*
    FNXC:TaskHistory 2026-08-28-23:05:
    Summary is a read-only projection over the modal's workflow result state and issues no request of its own. Admitting it to this shared load/SSE gate prevents Plan, Review, and Merge from showing zero until Workflow has been visited.
    */
    let cancelled = false;
    /*
    FNXC:TaskWorkflowDetails 2026-06-26-01:43:
    A mounted task-detail Workflow tab can switch from one task to another while the previous result list is visible. Clear results before the new fetch so live step/stage details never flash stale rows from another task while cancellation protects the in-flight request.
    */
    setWorkflowResults([]);
    setWorkflowResultsLoading(true);
    setWorkflowResultsLoadState("loading");
    fetchWorkflowResults(task.id, projectId)
      .then((results) => {
        if (!cancelled) {
          setWorkflowResults(results);
          setWorkflowResultsLoadState("succeeded");
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setWorkflowResultsLoadState((current) => current === "succeeded" ? current : "failed");
          addToast(t("taskDetail.workflow.loadFailed", "Failed to load workflow results: {{error}}", { error: getErrorMessage(err) }), "error");
        }
      })
      .finally(() => {
        if (!cancelled) setWorkflowResultsLoading(false);
      });
    return () => { cancelled = true; };
  }, [needsWorkflowResults, task.id, projectId, addToast]);

  // Subscribe to SSE for real-time workflow result updates while either report surface is active
  useEffect(() => {
    // FNXC:TaskPopupViewGating 2026-07-22-13:15: hidden kept-alive popups close this channel (R8).
    if (!needsWorkflowResults || !active) return;

    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    let cancelled = false;

    const handleTaskUpdated = (e: MessageEvent) => {
      try {
        const updatedTask = JSON.parse(e.data);
        // Only update if this is for our task and has workflow step results
        if (!isForeignTaskEvent(readTaskEventProjectId(updatedTask), projectId) && updatedTask.id === task.id && Array.isArray(updatedTask.workflowStepResults)) {
          setWorkflowResults(updatedTask.workflowStepResults);
          setWorkflowResultsLoadState("succeeded");
        }
      } catch {
        // Skip malformed events
      }
    };

    /*
    FNXC:TaskWorkflowDetails 2026-07-26-16:30:
    Resync contract (see SseSubscription in sse-bus.ts). After the initial fetch the Workflow tab's step
    results are replaced ONLY by `task:updated` payloads, and the stream is lossy: an error/heartbeat
    reconnect or the >=60s hidden-tab suspend drops the socket and /api/events keeps no replay buffer.
    Missing the gap freezes the rendered step list at its pre-suspend state — a review that failed or a
    step that finished while the phone was backgrounded still reads as running, which is exactly the
    surface an operator checks before deciding to intervene. Refetch through the same
    `fetchWorkflowResults` the load effect uses; deliberately no `setWorkflowResultsLoading(true)` and no
    list clear, so a reconnect refreshes in place instead of flashing an empty/spinner tab.
    */
    const resyncWorkflowResults = () => {
      void fetchWorkflowResults(task.id, projectId)
        .then((results) => {
          if (!cancelled) {
            setWorkflowResults(results);
            setWorkflowResultsLoadState("succeeded");
          }
        })
        .catch(() => {
          // Non-fatal: the tab keeps its last known rows and the next task:updated event corrects them.
        });
    };

    const unsubscribe = subscribeSse(`/api/events${query}`, {
      onReconnect: resyncWorkflowResults,
      events: { "task:updated": handleTaskUpdated },
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [needsWorkflowResults, active, task.id, projectId]);

  /*
  FNXC:TaskCliSession 2026-07-26-16:36:
  Hoisted out of the load effect so the `cli:session:state` subscription's onReconnect can refetch the
  SAME authoritative list rather than duplicating the request shape. Returns the most-recent session
  (the list is store-ordered) or null; the enriched list fields (adapterId / autonomyPosture) exist only
  here, which is why the SSE handler merges onto this record instead of replacing it.
  */
  const fetchLatestCliSession = useCallback(async (): Promise<CliSessionSummaryRecord | null> => {
    const search = new URLSearchParams({ taskId: task.id });
    if (projectId) search.set("projectId", projectId);
    const res = await api<{ sessions: CliSessionSummaryRecord[] }>(`/cli-sessions?${search.toString()}`);
    const sessions = res.sessions ?? [];
    return sessions.length > 0 ? sessions[sessions.length - 1] : null;
  }, [task.id, projectId]);

  // Load the CLI agent session for this task (drives the terminal tab + matrix).
  useEffect(() => {
    let cancelled = false;
    void fetchLatestCliSession()
      .then((session) => {
        if (!cancelled) setCliSession(session);
      })
      .catch(() => {
        if (!cancelled) setCliSession(null);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchLatestCliSession]);

  // Live CLI session state via SSE — MERGE payload fields onto the record
  // (never wholesale-replace: the list fetch carries enriched fields the SSE
  // payload omits, e.g. adapterId / autonomyPosture).
  useEffect(() => {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    let cancelled = false;
    const handleCliState = (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data) as {
          sessionId: string;
          taskId: string | null;
          state: string;
          terminationReason?: string | null;
        };
        if (payload.taskId !== task.id) return;
        setCliSession((prev) => {
          if (!prev || prev.id !== payload.sessionId) {
            // Unknown/new session for this task — keep the enriched record from
            // the list fetch as the source of truth; ignore until it loads.
            if (!prev) return prev;
          }
          // The machine "idle"/"resuming" states map onto persisted enums; the
          // card/tab only need the persisted set, so coerce here.
          const next = { ...prev } as CliSessionSummaryRecord;
          if (
            payload.state === "starting" ||
            payload.state === "ready" ||
            payload.state === "busy" ||
            payload.state === "waitingOnInput" ||
            payload.state === "done" ||
            payload.state === "dead" ||
            payload.state === "needsAttention"
          ) {
            next.agentState = payload.state;
          } else if (payload.state === "idle" || payload.state === "resuming") {
            next.agentState = "busy";
          }
          if (payload.terminationReason !== undefined) {
            next.terminationReason = payload.terminationReason ?? null;
          }
          return next;
        });
      } catch {
        /* skip malformed events */
      }
    };
    // FNXC:TaskPopupViewGating 2026-07-22-13:15: hidden kept-alive popups close this channel (R8); reveal re-subscribes.
    if (!active) return;
    /*
    FNXC:TaskCliSession 2026-07-26-16:40:
    Resync contract (see SseSubscription in sse-bus.ts). `agentState` is advanced ONLY by
    `cli:session:state` after the initial list fetch, and the stream is lossy: an error/heartbeat
    reconnect or the >=60s hidden-tab suspend drops the socket with no replay buffer. A terminal
    transition landing in that gap is the expensive one — the session shows "busy" forever while the
    real process is `waitingOnInput` (operator never answers the prompt) or `dead`/`done` (operator
    waits on a session that already ended). Refetch the list on reconnect and take it as authoritative:
    unlike the event handler, the list response carries every enriched field, so replacing is safe here.
    */
    const resyncCliSession = () => {
      void fetchLatestCliSession()
        .then((session) => {
          if (!cancelled) setCliSession(session);
        })
        .catch(() => {
          // Non-fatal: keep the last known record; the next state event or reopen corrects it.
        });
    };

    const unsubscribe = subscribeSse(`/api/events${query}`, {
      onReconnect: resyncCliSession,
      events: { "cli:session:state": handleCliState },
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active, task.id, projectId, fetchLatestCliSession]);

  // Reset dependency search when dropdown closes
  useEffect(() => {
    if (!showDepDropdown) {
      setDepSearch("");
    }
  }, [showDepDropdown]);

  useEffect(() => {
    if (!task.assignedAgentId) {
      setAssignedAgent(null);
      return;
    }

    const knownAgent = agents.find((agent) => agent.id === task.assignedAgentId);
    if (knownAgent) {
      setAssignedAgent(knownAgent);
      return;
    }

    let cancelled = false;
    void fetchAgent(task.assignedAgentId, projectId)
      .then((agent) => {
        if (!cancelled) setAssignedAgent(agent);
      })
      .catch(() => {
        if (!cancelled) setAssignedAgent(null);
      });

    return () => {
      cancelled = true;
    };
  }, [task.assignedAgentId, projectId, agents]);

  useEffect(() => {
    if (!task.sourceAgentId) {
      setSourceAgent(null);
      return;
    }

    const knownAgent = agents.find((agent) => agent.id === task.sourceAgentId);
    if (knownAgent) {
      setSourceAgent(knownAgent);
      return;
    }

    let cancelled = false;
    void Promise.resolve(fetchAgent(task.sourceAgentId, projectId))
      .then((agent) => {
        if (!cancelled) setSourceAgent(agent ?? null);
      })
      .catch(() => {
        if (!cancelled) setSourceAgent(null);
      });

    return () => {
      cancelled = true;
    };
  }, [task.sourceAgentId, projectId, agents]);

  useEffect(() => {
    setShowAgentPicker(false);
  }, [task.id]);

  // Close task-detail dropdown menus on outside click.
  useEffect(() => {
    const hasOpenMenu = showActionsMenu || showActivityViewMenu;
    if (!hasOpenMenu) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const inActionsMenu = actionsMenuRef.current?.contains(target);
      const inActivityViewMenu = activityViewMenuRef.current?.contains(target) || activityViewButtonRef.current?.contains(target);

      if (!inActionsMenu && showActionsMenu) {
        setShowActionsMenu(false);
      }
      if (!inActivityViewMenu && showActivityViewMenu) {
        activityViewMenuViewportGuardUntilRef.current = 0;
        setShowActivityViewMenu(false);
        setActivityViewMenuPosition(null);
      }
    };

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showActionsMenu, showActivityViewMenu]);

  // Close task-detail dropdown menus on Escape key (before modal Escape handler).
  useEffect(() => {
    const hasOpenMenu = showActionsMenu || showActivityViewMenu;
    if (!hasOpenMenu) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation(); // Prevent modal from closing
        if (showActionsMenu) setShowActionsMenu(false);
        if (showActivityViewMenu) {
          activityViewMenuViewportGuardUntilRef.current = 0;
          setShowActivityViewMenu(false);
          setActivityViewMenuPosition(null);
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showActionsMenu, showActivityViewMenu]);

  /*
  FNXC:TaskDetailPlan 2026-08-03-02:32:
  A visible Definition poll may update the authoritative prompt while an operator is editing it.
  Reset edit state only for a different task; reacting to prompt revisions would discard the active
  local draft and replace its textarea.
  */
  useEffect(() => {
    setIsEditingSpec(false);
    setSpecEditContent(workingTask.prompt || "");
    setSpecFeedback("");
  }, [task.id]);

  // Note: TaskForm handles auto-focus internally via isActive prop

  // Check if task can be edited
  const canEdit = isTaskFieldEditableColumn(task.column, detailColumnFlags) && !isSaving;
  /** The card's column name as its own workflow declares it; `undefined` when unresolved. */
  const workflowColumnDisplayName = workflowMoveMetadata?.moveColumns?.find((column) => column.id === task.column)?.label;
  const canEditGithubTracking = canTaskEditGithubTracking(task.column, taskWorkflowBadge?.id, detailColumnFlags) && !isSaving;
  const githubTrackingEnabled = githubTrackingEnabledDraft ?? (workingTask.githubTracking?.enabled === true);
  const githubTrackedIssue = workingTask.githubTracking?.issue;
  const gitlabTrackedItem = workingTask.gitlabTracking?.item;
  const githubTrackingDetailPending = detailLoading && typeof task.githubTracking === "undefined";
  const canCreateTrackingIssue = hasUsableTrackingTitle(task);
  const showInlineGithubTrackingEnableButton =
    canEditGithubTracking
    && !githubTrackedIssue
    && !githubTrackingDetailPending
    && (!githubTrackingEnabled || (isSavingGithubTracking && workingTask.githubTracking?.enabled !== true));
  const showGithubTrackingSection = (canEditGithubTracking && !gitlabTrackedItem) || githubTrackingEnabled || Boolean(githubTrackedIssue);
  const retrySummary = task.retrySummary;
  const retryRows = [
    { key: "stuckKill", label: t("taskDetail.retries.stuckKill", "Stuck kills"), title: t("taskDetail.retries.stuckKillTitle", "Stuck-task detector forced agent kill retries"), value: retrySummary?.stuckKill ?? 0 },
    { key: "recovery", label: t("taskDetail.retries.recovery", "Recovery retries"), title: t("taskDetail.retries.recoveryTitle", "Transient executor recovery retries"), value: retrySummary?.recovery ?? 0 },
    { key: "taskDone", label: t("taskDetail.retries.taskDone", "task_done retries"), title: t("taskDetail.retries.taskDoneTitle", "Agent exited without task_done and task was retried"), value: retrySummary?.taskDone ?? 0 },
    { key: "workflowStep", label: t("taskDetail.retries.workflowStep", "Workflow retries"), title: t("taskDetail.retries.workflowStepTitle", "Workflow step failure retries"), value: retrySummary?.workflowStep ?? 0 },
    { key: "verification", label: t("taskDetail.retries.verification", "Verification bounces"), title: t("taskDetail.retries.verificationTitle", "Verification failure bounce retries"), value: retrySummary?.verification ?? 0 },
    { key: "postReviewFix", label: t("taskDetail.retries.postReviewFix", "Post-review fixes"), title: t("taskDetail.retries.postReviewFixTitle", "Post-review remediation retries"), value: retrySummary?.postReviewFix ?? 0 },
    { key: "mergeConflict", label: t("taskDetail.retries.mergeConflict", "Merge conflict bounces"), title: t("taskDetail.retries.mergeConflictTitle", "Merge conflict bounce retries"), value: retrySummary?.mergeConflict ?? 0 },
    { key: "branchConflict", label: t("taskDetail.retries.branchConflict", "Branch conflict recovery"), title: t("taskDetail.retries.branchConflictTitle", "FN-4068 branch-conflict recovery retries"), value: retrySummary?.branchConflict ?? 0 },
    { key: "reviewerContext", label: t("taskDetail.retries.reviewerContext", "Reviewer context retries"), title: t("taskDetail.retries.reviewerContextTitle", "FN-4082 compact reviewer retry"), value: retrySummary?.reviewerContext ?? 0 },
    { key: "reviewerFallback", label: t("taskDetail.retries.reviewerFallback", "Reviewer fallback retries"), title: t("taskDetail.retries.reviewerFallbackTitle", "FN-4092 fallback-model retry"), value: retrySummary?.reviewerFallback ?? 0 },
  ].filter((row) => row.value > 0);
  const gitlabTrackingStale = Boolean(gitlabTrackedItem?.staleAt || gitlabTrackedItem?.staleReason);
  const gitlabTrackingStatus = gitlabTrackingStale
    ? t("taskDetail.gitlabTracking.statusStale", "Stale")
    : gitlabTrackedItem
      ? t("taskDetail.gitlabTracking.statusLinked", "Linked")
      : t("taskDetail.gitlabTracking.statusUnlinked", "Unlinked");
  const showGitLabTrackingSection = Boolean(gitlabTrackedItem || workingTask.gitlabTracking?.unlinkedAt);
  const githubTrackingStatus = githubTrackingDetailPending
    ? t("taskDetail.githubTracking.statusLoading", "Loading")
    : githubTrackedIssue
      ? t("taskDetail.githubTracking.statusLinked", "Linked")
      : githubTrackingEnabled
        ? t("taskDetail.githubTracking.statusEnabled", "Enabled")
        : t("taskDetail.githubTracking.statusDisabled", "Disabled");
  const showGithubTrackingSpinner = !githubTrackedIssue && (isSavingGithubTracking || githubTrackingDetailPending);
  const effectiveGithubRepoDefault = resolveEffectiveGithubRepoDefault(settings ?? null, globalSettings);
  const githubRepoOverrideTrimmed = githubRepoOverrideDraft.trim();
  const hasDescriptionForTitleSummary = (task.description ?? "").trim().length > 0;
  const showSummarizeTitleButton = !isEditing && canEdit && hasDescriptionForTitleSummary;

  const handleSummarizeTitle = useCallback(async () => {
    if (isSummarizingTitle || isSaving || !hasDescriptionForTitleSummary) return;
    const requestTaskId = task.id;
    setIsSummarizingTitle(true);
    try {
      const generatedTitle = await summarizeTitle(task.description || "", undefined, undefined, projectId);
      if (activeTaskIdRef.current !== requestTaskId) {
        return;
      }
      const updatedTask = await updateTask(task.id, { title: generatedTitle }, projectId);
      if (activeTaskIdRef.current !== requestTaskId) {
        return;
      }
      setFullDetail((prev) => prev
        ? ({ ...prev, ...updatedTask } as TaskDetail)
        : (updatedTask as TaskDetail));
      onTaskUpdated?.(updatedTask);
      addToast(t("taskDetail.title.summarizeSuccess", "Title updated from description"), "success");
    } catch (err) {
      if (activeTaskIdRef.current === requestTaskId) {
        addToast(t("taskDetail.title.summarizeFailed", "Failed to summarize title: {{error}}", { error: getErrorMessage(err) }), "error");
      }
    } finally {
      if (mountedRef.current && activeTaskIdRef.current === requestTaskId) {
        setIsSummarizingTitle(false);
      }
    }
  }, [addToast, hasDescriptionForTitleSummary, isSaving, isSummarizingTitle, onTaskUpdated, projectId, t, task.description, task.id]);

  const handleToggleGithubTracking = useCallback(async () => {
    if (!canEditGithubTracking || isSavingGithubTracking) return;
    const requestTaskId = task.id;
    const nextEnabled = !githubTrackingEnabled;
    setGithubTrackingEnabledDraft(nextEnabled);
    setIsSavingGithubTracking(true);
    try {
      const updatedTask = await updateTask(task.id, {
        githubTracking: {
          enabled: nextEnabled,
        },
      }, projectId);
      if (activeTaskIdRef.current !== requestTaskId) {
        return;
      }
      setFullDetail((prev) => prev
        ? ({ ...prev, ...updatedTask, githubTracking: updatedTask.githubTracking } as TaskDetail)
        : (updatedTask as TaskDetail));
      onTaskUpdated?.(updatedTask);
    } catch (err) {
      if (activeTaskIdRef.current !== requestTaskId) {
        return;
      }
      setGithubTrackingEnabledDraft(workingTask.githubTracking?.enabled === true);
      addToast(t("taskDetail.updateFailed", "Failed to update {{id}}: {{error}}", { id: task.id, error: getErrorMessage(err) }), "error");
    } finally {
      if (mountedRef.current && activeTaskIdRef.current === requestTaskId) setIsSavingGithubTracking(false);
    }
  }, [addToast, canEditGithubTracking, githubTrackingEnabled, isSavingGithubTracking, onTaskUpdated, projectId, workingTask.githubTracking?.enabled, task.id]);

  const handleSaveGithubRepoOverride = useCallback(async () => {
    if (!canEditGithubTracking || isSavingGithubTracking) return;
    const requestTaskId = task.id;
    if (githubRepoOverrideTrimmed.length > 0 && !REPO_OVERRIDE_RE.test(githubRepoOverrideTrimmed)) {
      setGithubRepoOverrideError(t("taskDetail.githubTracking.repoOverrideFormat", "Repository override must be in owner/repo format"));
      return;
    }
    setGithubRepoOverrideError(null);
    setIsSavingGithubTracking(true);
    try {
      const updatedTask = await updateTask(task.id, {
        githubTracking: {
          repoOverride: githubRepoOverrideTrimmed.length > 0 ? githubRepoOverrideTrimmed : null,
        },
      }, projectId);
      if (activeTaskIdRef.current !== requestTaskId) {
        return;
      }
      setFullDetail((prev) => prev
        ? ({ ...prev, ...updatedTask, githubTracking: updatedTask.githubTracking } as TaskDetail)
        : (updatedTask as TaskDetail));
      onTaskUpdated?.(updatedTask);
    } catch (err) {
      if (activeTaskIdRef.current !== requestTaskId) {
        return;
      }
      addToast(t("taskDetail.updateFailed", "Failed to update {{id}}: {{error}}", { id: task.id, error: getErrorMessage(err) }), "error");
    } finally {
      if (mountedRef.current && activeTaskIdRef.current === requestTaskId) setIsSavingGithubTracking(false);
    }
  }, [addToast, canEditGithubTracking, githubRepoOverrideTrimmed, isSavingGithubTracking, onTaskUpdated, projectId, task.id]);

  const handleRetryGithubTrackingIssueCreate = useCallback(async () => {
    if (!githubTrackingEnabled || githubTrackedIssue || isSavingGithubTracking) return;
    if (!hasUsableTrackingTitle(task)) {
      addToast(t("taskDetail.githubTracking.addTitleBeforeCreating", "Add a title before creating a tracking issue"), "info");
      return;
    }
    const requestTaskId = task.id;
    setIsSavingGithubTracking(true);
    try {
      const updatedTask = await updateTask(task.id, {
        githubTracking: {
          enabled: true,
        },
      }, projectId);
      if (activeTaskIdRef.current !== requestTaskId) {
        return;
      }
      setFullDetail((prev) => prev
        ? ({ ...prev, ...updatedTask, githubTracking: updatedTask.githubTracking } as TaskDetail)
        : (updatedTask as TaskDetail));
      onTaskUpdated?.(updatedTask);
      addToast(t("taskDetail.githubTracking.issueCreationRequested", "Requested GitHub tracking issue creation"), "info");
    } catch (err) {
      if (activeTaskIdRef.current !== requestTaskId) {
        return;
      }
      addToast(t("taskDetail.updateFailed", "Failed to update {{id}}: {{error}}", { id: task.id, error: getErrorMessage(err) }), "error");
    } finally {
      if (mountedRef.current && activeTaskIdRef.current === requestTaskId) setIsSavingGithubTracking(false);
    }
  }, [addToast, githubTrackedIssue, githubTrackingEnabled, isSavingGithubTracking, onTaskUpdated, projectId, task]);

  const enterEditMode = useCallback(() => {
    if (!canEdit) return;
    setIsEditing(true);
    setEditTitle(task.title || "");
    setEditDescription(task.description || "");
    setEditDependencies(task.dependencies || []);
    setEditBranch(task.branch ?? "");
    setEditBaseBranch(task.baseBranch ?? "");
    // Populate model overrides from task
    const execModel = task.modelProvider && task.modelId ? `${task.modelProvider}/${task.modelId}` : "";
    const valModel = task.validatorModelProvider && task.validatorModelId ? `${task.validatorModelProvider}/${task.validatorModelId}` : "";
    const planModel = task.planningModelProvider && task.planningModelId ? `${task.planningModelProvider}/${task.planningModelId}` : "";
    setEditExecutorModel(execModel);
    setEditCredentialInstanceId(task.credentialInstanceId);
    setEditValidatorModel(valModel);
    setEditValidatorCredentialInstanceId(task.validatorCredentialInstanceId);
    setEditPlanningModel(planModel);
    setEditPlanningCredentialInstanceId(task.planningCredentialInstanceId);
    setEditThinkingLevel(task.thinkingLevel ?? "");
    setEditPlannerOversightLevel(task.plannerOversightLevel ?? "");
    setEditNodeId(task.nodeId);
    setEditPresetMode(execModel || valModel || planModel ? "custom" : "default");
    setEditSelectedPresetId("");
    setEditSelectedWorkflowSteps(task.enabledWorkflowSteps || []);
    setEditExecutionMode(normalizeExecutionModeValue(task.executionMode));
    setEditSourceIssueProvider(task.sourceIssue?.provider ?? "");
    setEditSourceIssueRepository(task.sourceIssue?.repository ?? "");
    setEditSourceIssueExternalId(task.sourceIssue?.externalIssueId ?? "");
    setEditSourceIssueUrl(task.sourceIssue?.url ?? "");
    setEditPendingImages([]);
    setEditReviewLevel(task.reviewLevel);
    setEditPriority(normalizeTaskPriorityValue(task.priority));
  }, [canEdit, task]);

  const exitEditMode = useCallback(() => {
    setIsEditing(false);
    setEditTitle(task.title || "");
    setEditDescription(task.description || "");
    setEditDependencies(task.dependencies || []);
    setEditBranch(task.branch ?? "");
    setEditBaseBranch(task.baseBranch ?? "");
    setEditNodeId(task.nodeId);
    setEditSourceIssueProvider(task.sourceIssue?.provider ?? "");
    setEditSourceIssueRepository(task.sourceIssue?.repository ?? "");
    setEditSourceIssueExternalId(task.sourceIssue?.externalIssueId ?? "");
    setEditSourceIssueUrl(task.sourceIssue?.url ?? "");
    setEditPriority(normalizeTaskPriorityValue(task.priority));
    setEditExecutionMode(normalizeExecutionModeValue(task.executionMode));
    editPendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    setEditPendingImages([]);
  }, [task.title, task.description, task.dependencies, task.nodeId, task.priority, task.executionMode, editPendingImages]);

  const [editAutoSaveStatus, setEditAutoSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const editAutoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editAutoSaveRevisionRef = useRef(0);
  const editSaveTriggeredReplanRef = useRef(false);
  const blankDescriptionDeletePendingRef = useRef(false);
  const lastBlankDescriptionDeleteAttemptRef = useRef<string | null>(null);
  const handleDeleteRef = useRef<((canProceed?: () => boolean) => Promise<boolean | undefined>) | null>(null);

  useEffect(() => {
    if (editDescription.trim().length > 0) {
      lastBlankDescriptionDeleteAttemptRef.current = null;
    }
  }, [editDescription]);

  const buildEditUpdates = useCallback((includeDescription: boolean) => {
    const updates: Record<string, unknown> = {};
    const trimmedTitle = editTitle.trim();
    const trimmedDescription = editDescription.trim();

    if (trimmedTitle && trimmedTitle !== (task.title ?? "")) updates.title = trimmedTitle;
    if (includeDescription && trimmedDescription && trimmedDescription !== (task.description ?? "")) updates.description = trimmedDescription;
    if (!sameStringArray(editDependencies, task.dependencies ?? [])) updates.dependencies = editDependencies;
    if (!sameStringArray(editSelectedWorkflowSteps, task.enabledWorkflowSteps ?? [])) updates.enabledWorkflowSteps = editSelectedWorkflowSteps;

    const normalizedBranch = editBranch.trim() || null;
    const currentBranch = task.branch ?? null;
    if (normalizedBranch !== currentBranch) updates.branch = normalizedBranch;

    const normalizedBaseBranch = editBaseBranch.trim() || null;
    const currentBaseBranch = task.baseBranch ?? null;
    if (normalizedBaseBranch !== currentBaseBranch) updates.baseBranch = normalizedBaseBranch;

    const executorSelection = splitModelSelection(editExecutorModel);
    const currentExecutorModel = task.modelProvider && task.modelId ? `${task.modelProvider}/${task.modelId}` : "";
    if (editExecutorModel !== currentExecutorModel) {
      updates.modelProvider = executorSelection?.provider ?? null;
      updates.modelId = executorSelection?.modelId ?? null;
      updates.credentialInstanceId = null;
    } else if ((editCredentialInstanceId ?? "") !== (task.credentialInstanceId ?? "")) {
      updates.credentialInstanceId = editCredentialInstanceId ?? null;
    }

    const validatorSelection = splitModelSelection(editValidatorModel);
    const currentValidatorModel = task.validatorModelProvider && task.validatorModelId ? `${task.validatorModelProvider}/${task.validatorModelId}` : "";
    if (editValidatorModel !== currentValidatorModel) {
      updates.validatorModelProvider = validatorSelection?.provider ?? null;
      updates.validatorModelId = validatorSelection?.modelId ?? null;
      updates.validatorCredentialInstanceId = null;
    } else if ((editValidatorCredentialInstanceId ?? "") !== (task.validatorCredentialInstanceId ?? "")) {
      updates.validatorCredentialInstanceId = editValidatorCredentialInstanceId ?? null;
    }

    const planningSelection = splitModelSelection(editPlanningModel);
    const currentPlanningModel = task.planningModelProvider && task.planningModelId ? `${task.planningModelProvider}/${task.planningModelId}` : "";
    if (editPlanningModel !== currentPlanningModel) {
      updates.planningModelProvider = planningSelection?.provider ?? null;
      updates.planningModelId = planningSelection?.modelId ?? null;
      updates.planningCredentialInstanceId = null;
    } else if ((editPlanningCredentialInstanceId ?? "") !== (task.planningCredentialInstanceId ?? "")) {
      updates.planningCredentialInstanceId = editPlanningCredentialInstanceId ?? null;
    }

    const currentThinkingLevel = task.thinkingLevel ?? "";
    if (editThinkingLevel !== currentThinkingLevel) updates.thinkingLevel = editThinkingLevel !== "" ? (editThinkingLevel as ThinkingLevel) : null;
    // FNXC:PlannerOversight 2026-07-04-00:00: "" (Inherit from workflow) clears the per-task override to null so the workflow's effective plannerOversightLevel applies.
    const currentPlannerOversightLevel = task.plannerOversightLevel ?? "";
    if (editPlannerOversightLevel !== currentPlannerOversightLevel) updates.plannerOversightLevel = editPlannerOversightLevel !== "" ? (editPlannerOversightLevel as "off" | "observe" | "steer" | "autonomous") : null;
    if ((task.nodeId ?? undefined) !== editNodeId) updates.nodeId = editNodeId ?? null;
    if (editReviewLevel !== task.reviewLevel) updates.reviewLevel = editReviewLevel;
    if (editPriority !== normalizeTaskPriorityValue(task.priority)) updates.priority = editPriority;
    if (editExecutionMode !== normalizeExecutionModeValue(task.executionMode)) updates.executionMode = editExecutionMode === "fast" ? "fast" : null;

    const normalizedProvider = normalizeSourceIssueText(editSourceIssueProvider);
    const normalizedRepository = normalizeSourceIssueText(editSourceIssueRepository);
    const normalizedExternalId = normalizeSourceIssueText(editSourceIssueExternalId);
    const normalizedUrl = normalizeSourceIssueUrl(editSourceIssueUrl);
    const allSourceFieldsEmpty = normalizedProvider.length === 0 && normalizedRepository.length === 0 && normalizedExternalId.length === 0 && !normalizedUrl;

    if (allSourceFieldsEmpty) {
      if (task.sourceIssue) updates.sourceIssue = null;
    } else {
      if (!normalizedProvider || !normalizedRepository || !normalizedExternalId) {
        return { updates: null, error: t("taskDetail.edit.sourceIssueRequiredFields", "Source issue provider, repository, and issue identifier are required") };
      }
      const fallbackIssueNumber = Number.parseInt(normalizedExternalId, 10);
      const issueNumber = task.sourceIssue?.issueNumber ?? fallbackIssueNumber;
      if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
        return { updates: null, error: t("taskDetail.edit.sourceIssueIdentifierNumeric", "Source issue identifier must be numeric for new metadata") };
      }
      const nextSourceIssue: TaskSourceIssue = {
        provider: normalizedProvider,
        repository: normalizedRepository,
        externalIssueId: normalizedExternalId,
        issueNumber,
        ...(normalizedUrl ? { url: normalizedUrl } : {}),
      };
      const previousSourceIssue = task.sourceIssue;
      const sourceIssueChanged = !previousSourceIssue
        || previousSourceIssue.provider !== nextSourceIssue.provider
        || previousSourceIssue.repository !== nextSourceIssue.repository
        || previousSourceIssue.externalIssueId !== nextSourceIssue.externalIssueId
        || previousSourceIssue.issueNumber !== nextSourceIssue.issueNumber
        || (previousSourceIssue.url ?? undefined) !== nextSourceIssue.url;
      if (sourceIssueChanged) updates.sourceIssue = nextSourceIssue;
    }

    return { updates, error: null as string | null };
  }, [editBaseBranch, editBranch, editDependencies, editDescription, editExecutionMode, editCredentialInstanceId, editExecutorModel, editNodeId, editPlanningCredentialInstanceId, editPlanningModel, editPriority, editReviewLevel, editSelectedWorkflowSteps, editSourceIssueExternalId, editSourceIssueProvider, editSourceIssueRepository, editSourceIssueUrl, editThinkingLevel, editPlannerOversightLevel, editTitle, editValidatorCredentialInstanceId, editValidatorModel, task]);

  const requestBlankDescriptionDeletion = useCallback(async (descriptionAtRequest: string, force: boolean): Promise<boolean> => {
    if (blankDescriptionDeletePendingRef.current || (!force && lastBlankDescriptionDeleteAttemptRef.current === descriptionAtRequest)) return false;

    lastBlankDescriptionDeleteAttemptRef.current = descriptionAtRequest;
    blankDescriptionDeletePendingRef.current = true;
    try {
      /*
      FNXC:TaskDescriptionDeletion 2026-08-20-05:48:
      Clearing a previously populated Task Detail description is an intentional destructive gesture,
      so it must reuse the shared confirmation and deletion lifecycle rather than persist an empty
      description. The snapshot fence prevents either debounce timer from deleting a draft restored
      while its confirmation is open.
      */
      return Boolean(await handleDeleteRef.current?.(() =>
        editDescriptionRef.current === descriptionAtRequest
        && editDescriptionRef.current.trim().length === 0,
      ));
    } finally {
      blankDescriptionDeletePendingRef.current = false;
    }
  }, []);

  const persistEditChanges = useCallback(async (includeDescription: boolean, forceBlankDescriptionDeletion = false) => {
    const trimmedDescription = editDescription.trim();
    if (includeDescription && task.description.trim().length > 0 && trimmedDescription.length === 0) {
      return requestBlankDescriptionDeletion(editDescription, forceBlankDescriptionDeletion);
    }
    if (trimmedDescription.length > 0) {
      lastBlankDescriptionDeleteAttemptRef.current = null;
    }

    const { updates, error } = buildEditUpdates(includeDescription);
    if (!updates) {
      setEditAutoSaveStatus("error");
      if (error) {
        addToast(t("taskDetail.updateFailed", "Failed to update {{id}}: {{error}}", { id: task.id, error }), "error");
      }
      return false;
    }
    const replanAfterExecutionModeChange = updates.executionMode === null && requiresExecutionModeReplan(task.column, detailColumnFlags);
    if (replanAfterExecutionModeChange && !includeDescription) {
      delete updates.executionMode;
    }
    if (Object.keys(updates).length === 0) {
      return true;
    }
    if (replanAfterExecutionModeChange && includeDescription) {
      const nextMode = normalizeExecutionModeValue(updates.executionMode as Task["executionMode"]);
      const shouldChangeMode = await confirm({
        title: t("taskDetail.executionMode.replanTitle", "Change execution mode and replan?"),
        message: t("taskDetail.executionMode.replanMessage", "Changing execution mode for this task will move it back to Planning so Fusion can rebuild the plan for {{mode}} mode.", { mode: nextMode }),
      });
      if (!shouldChangeMode) {
        setEditExecutionMode(normalizeExecutionModeValue(task.executionMode));
        return false;
      }
    }
    const revision = ++editAutoSaveRevisionRef.current;
    setIsSaving(true);
    setEditAutoSaveStatus("saving");
    try {
      const updatedTask = await updateTask(task.id, updates as never, projectId);
      if (revision !== editAutoSaveRevisionRef.current) return;
      if (replanAfterExecutionModeChange && includeDescription) {
        const normalizedUpdatedMode = normalizeExecutionModeValue(updatedTask.executionMode);
        await rebuildTaskSpec(task.id, projectId);
        editSaveTriggeredReplanRef.current = true;
        setEditAutoSaveStatus("saved");
        requestClose();
        addToast(t("taskDetail.executionMode.replanning", "Execution mode updated to {{mode}} — {{id}} returned to Planning for replanning", { mode: normalizedUpdatedMode, id: task.id }), "info");
        return true;
      }
      onTaskUpdated?.(updatedTask);
      setEditAutoSaveStatus("saved");
      return true;
    } catch (err) {
      if (revision === editAutoSaveRevisionRef.current) {
        if (replanAfterExecutionModeChange) {
          setEditExecutionMode(normalizeExecutionModeValue(task.executionMode));
        }
        setEditAutoSaveStatus("error");
        addToast(t("taskDetail.updateFailed", "Failed to update {{id}}: {{error}}", { id: task.id, error: getErrorMessage(err) }), "error");
      }
      return false;
    } finally {
      if (mountedRef.current && revision === editAutoSaveRevisionRef.current) {
        setIsSaving(false);
      }
    }
  }, [addToast, buildEditUpdates, confirm, detailColumnFlags, editDescription, onTaskUpdated, projectId, requestBlankDescriptionDeletion, requestClose, task.column, task.description, task.executionMode, task.id]);

  const handleAutoSaveDescription = useCallback(async (_description: string) => {
    await persistEditChanges(true);
  }, [persistEditChanges]);

  const handleSave = useCallback(async () => {
    editSaveTriggeredReplanRef.current = false;
    const didSave = await persistEditChanges(true, true);
    if (!didSave || editSaveTriggeredReplanRef.current) {
      return;
    }
    addToast(t("taskDetail.updateSuccess", "Updated {{id}}", { id: task.id }), "success");
    if (mountedRef.current) {
      setIsEditing(false);
    }
  }, [addToast, persistEditChanges, task.id]);

  useEffect(() => {
    if (!isEditing) return;
    if (editAutoSaveTimeoutRef.current) {
      clearTimeout(editAutoSaveTimeoutRef.current);
    }
    editAutoSaveTimeoutRef.current = setTimeout(() => {
      void persistEditChanges(false);
    }, 700);

    return () => {
      if (editAutoSaveTimeoutRef.current) {
        clearTimeout(editAutoSaveTimeoutRef.current);
        editAutoSaveTimeoutRef.current = null;
      }
    };
  }, [
    isEditing,
    editTitle,
    editDependencies,
    editBranch,
    editBaseBranch,
    editExecutorModel,
    editCredentialInstanceId,
    editValidatorModel,
    editValidatorCredentialInstanceId,
    editPlanningModel,
    editPlanningCredentialInstanceId,
    editThinkingLevel,
    editPlannerOversightLevel,
    editNodeId,
    editReviewLevel,
    editPriority,
    editExecutionMode,
    editSelectedWorkflowSteps,
    editSourceIssueProvider,
    editSourceIssueRepository,
    editSourceIssueExternalId,
    editSourceIssueUrl,
    persistEditChanges,
  ]);

  const handleInlinePriorityChange = useCallback(async (nextValue: string) => {
    const normalizedNextPriority = normalizeTaskPriorityValue(nextValue as Task["priority"]);
    const currentPriority = normalizeTaskPriorityValue(task.priority);

    if (normalizedNextPriority === currentPriority) {
      setInlinePriority(currentPriority);
      return;
    }

    const previousPriority = inlinePriority;
    setInlinePriority(normalizedNextPriority);
    setIsSavingInlinePriority(true);

    try {
      const updatedTask = await updateTask(task.id, { priority: normalizedNextPriority }, projectId);
      setInlinePriority(normalizeTaskPriorityValue(updatedTask.priority));
      onTaskUpdated?.(updatedTask);
      addToast(t("taskDetail.priority.updated", "Priority updated to {{priority}}", { priority: normalizeTaskPriorityValue(updatedTask.priority) }), "success");
    } catch (err) {
      setInlinePriority(previousPriority);
      addToast(t("taskDetail.updateFailed", "Failed to update {{id}}: {{error}}", { id: task.id, error: getErrorMessage(err) }), "error");
    } finally {
      if (mountedRef.current) {
        setIsSavingInlinePriority(false);
      }
    }
  }, [task.id, task.priority, projectId, inlinePriority, onTaskUpdated, addToast]);

  const handleInlineExecutionModeToggle = useCallback(async () => {
    const currentMode = normalizeExecutionModeValue(task.executionMode);
    const nextMode = currentMode === "fast" ? "standard" : "fast";
    const previousMode = inlineExecutionMode;
    const shouldReplan = nextMode === "standard" && requiresExecutionModeReplan(task.column, detailColumnFlags);

    if (shouldReplan) {
      const shouldChangeMode = await confirm({
        title: t("taskDetail.executionMode.replanTitle", "Change execution mode and replan?"),
        message: t("taskDetail.executionMode.replanMessage", "Changing execution mode for this task will move it back to Planning so Fusion can rebuild the plan for {{mode}} mode.", { mode: nextMode }),
      });
      if (!shouldChangeMode) {
        setInlineExecutionMode(previousMode);
        return;
      }
    }

    setInlineExecutionMode(nextMode);
    setIsSavingInlineExecutionMode(true);

    try {
      const updatedTask = await updateTask(task.id, { executionMode: nextMode === "fast" ? "fast" : null }, projectId);
      const normalizedUpdatedMode = normalizeExecutionModeValue(updatedTask.executionMode);
      if (shouldReplan) {
        await rebuildTaskSpec(task.id, projectId);
        requestClose();
        addToast(t("taskDetail.executionMode.replanning", "Execution mode updated to {{mode}} — {{id}} returned to Planning for replanning", { mode: normalizedUpdatedMode, id: task.id }), "info");
        return;
      }
      setInlineExecutionMode(normalizedUpdatedMode);
      onTaskUpdated?.(updatedTask);
      addToast(t("taskDetail.executionMode.updated", "Execution mode updated to {{mode}}", { mode: normalizedUpdatedMode }), "success");
    } catch (err) {
      setInlineExecutionMode(previousMode);
      addToast(t("taskDetail.updateFailed", "Failed to update {{id}}: {{error}}", { id: task.id, error: getErrorMessage(err) }), "error");
    } finally {
      if (mountedRef.current) {
        setIsSavingInlineExecutionMode(false);
      }
    }
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-18:10 (PR #2761 review — greptile):
  `detailColumnFlags` is a DEPENDENCY, not a constant. It starts undefined on a task switch and
  populates when the metadata lands, so a callback that captures it without listing it keeps applying
  the pre-resolution answer — deciding the execution-mode replan from the legacy id on a custom hold or
  WIP column. My narrowing introduced a value that changes over time into callbacks written for one
  that did not.
  */
  }, [task.id, task.column, task.executionMode, detailColumnFlags, projectId, inlineExecutionMode, onTaskUpdated, addToast, confirm, requestClose]);

  const handleInlineNoCommitsExpectedToggle = useCallback(async () => {
    const nextValue = !inlineNoCommitsExpected;
    const previousValue = inlineNoCommitsExpected;

    setInlineNoCommitsExpected(nextValue);
    setIsSavingInlineNoCommitsExpected(true);

    try {
      const updatedTask = await updateTask(task.id, { noCommitsExpected: nextValue }, projectId);
      const normalizedUpdatedValue = updatedTask.noCommitsExpected === true;
      setInlineNoCommitsExpected(normalizedUpdatedValue);
      onTaskUpdated?.(updatedTask);
      addToast(normalizedUpdatedValue
        ? t("taskDetail.noCommits.enabled", "No-commits expectation enabled")
        : t("taskDetail.noCommits.disabled", "No-commits expectation disabled"), "success");
    } catch (err) {
      setInlineNoCommitsExpected(previousValue);
      addToast(t("taskDetail.updateFailed", "Failed to update {{id}}: {{error}}", { id: task.id, error: getErrorMessage(err) }), "error");
    } finally {
      if (mountedRef.current) {
        setIsSavingInlineNoCommitsExpected(false);
      }
    }
  }, [task.id, projectId, inlineNoCommitsExpected, onTaskUpdated, addToast]);

  /*
  FNXC:PlannerOversight 2026-07-14-18:11:
  Per-task session advisor (LLM overseer agent). Unset inherits project and
  workflow settings; explicit boolean forces on/off. Toggle writes an override
  when it differs from the full inherited state and clears to null only when it
  matches that same shared resolver result.
  */
  const projectSessionAdvisorDefault = settings?.sessionAdvisorEnabledByDefault === true;
  const hasSessionAdvisorOverride = typeof workingTask.sessionAdvisorEnabled === "boolean";
  /*
  FNXC:PlannerOversight 2026-07-18-12:00:
  FN-8247 requires the task-detail Eye/EyeOff affordances to use the shared
  session-advisor precedence contract. The workflow legacy setting travels in
  the existing workflow-settings fetch, so the UI cannot silently omit it or
  retain a divergent local resolver.
  */
  const effectiveSessionAdvisorEnabled = resolveTaskSessionAdvisorEnabled(
    workingTask,
    settings,
    workflowOversightState.sessionAdvisorEnabled,
  ).enabled;

  const inheritedSessionAdvisorEnabled = resolveTaskSessionAdvisorEnabled(
    { sessionAdvisorEnabled: undefined },
    settings,
    workflowOversightState.sessionAdvisorEnabled,
  ).enabled;

  const handleSessionAdvisorToggle = useCallback(async () => {
    setIsSavingSessionAdvisor(true);
    try {
      const nextEnabled = !effectiveSessionAdvisorEnabled;
      const nextValue: boolean | null =
        nextEnabled === inheritedSessionAdvisorEnabled ? null : nextEnabled;
      const updatedTask = await updateTask(task.id, { sessionAdvisorEnabled: nextValue }, projectId);
      onTaskUpdated?.(updatedTask);
      addToast(
        nextValue === null
          ? t("taskDetail.sessionAdvisor.reset", "Session advisor follows inherited defaults ({{default}})", {
              default: inheritedSessionAdvisorEnabled
                ? t("tasks.sessionAdvisorDefaultOn", "on")
                : t("tasks.sessionAdvisorDefaultOff", "off"),
            })
          : nextValue
            ? t("taskDetail.sessionAdvisor.enabled", "Session advisor enabled for this task")
            : t("taskDetail.sessionAdvisor.disabled", "Session advisor disabled for this task"),
        "success",
      );
    } catch (err) {
      addToast(
        t("taskDetail.updateFailed", "Failed to update {{id}}: {{error}}", {
          id: task.id,
          error: getErrorMessage(err),
        }),
        "error",
      );
    } finally {
      if (mountedRef.current) {
        setIsSavingSessionAdvisor(false);
      }
    }
  }, [
    effectiveSessionAdvisorEnabled,
    inheritedSessionAdvisorEnabled,
    task.id,
    projectId,
    onTaskUpdated,
    addToast,
    t,
  ]);

  /*
  FNXC:PlannerOversight 2026-07-04-17:00:
  FN-7517 quick oversight-level-change control. Writes the per-task override
  via the SAME `updateTask` scalar-override plumbing FN-7509/FN-7515 already
  wired (no parallel override path). `nextValue === "__inherit__"` clears the
  override back to the inherited workflow/project default (null-clear,
  mirroring the other scalar overrides' clear semantics).
  */
  const handleOversightLevelChange = useCallback(async (nextValue: string) => {
    const isClear = nextValue === "__inherit__";
    const nextOverride: PlannerOversightLevel | null = isClear ? null : (nextValue as PlannerOversightLevel);

    setIsSavingOversightLevel(true);
    try {
      const updatedTask = await updateTask(task.id, { plannerOversightLevel: nextOverride }, projectId);
      onTaskUpdated?.(updatedTask);
      addToast(
        isClear
          ? t("taskDetail.oversight.reset", "Oversight level reset to workflow default")
          : t("taskDetail.oversight.updated", "Oversight level set to {{level}}", { level: OVERSIGHT_LEVEL_LABEL[nextOverride as PlannerOversightLevel] }),
        "success",
      );
    } catch (err) {
      addToast(t("taskDetail.updateFailed", "Failed to update {{id}}: {{error}}", { id: task.id, error: getErrorMessage(err) }), "error");
    } finally {
      if (mountedRef.current) {
        setIsSavingOversightLevel(false);
      }
    }
  }, [task.id, projectId, onTaskUpdated, addToast, t]);

  /*
  FNXC:PlannerOversight 2026-07-04-17:00:
  FN-7517 manual nudge control. Guidance-only — never a merge/PR/destructive
  side effect (enforced server-side by `ProjectEngine.nudgeOverseerTask`,
  reusing the FN-7512 guidance channel). `applied: false` is a normal,
  non-error outcome (oversight off/inactive, or withheld by the human-control
  guard) surfaced as an info toast, not an error toast.
  */
  const handleNudgeOverseer = useCallback(async () => {
    setIsNudgingOverseer(true);
    try {
      const result = await nudgeOverseer(task.id, projectId);
      if (result.applied) {
        if (result.task) {
          onTaskUpdated?.(result.task);
        }
        addToast(t("taskDetail.oversight.nudged", "Manual nudge sent to the overseer"), "success");
      } else {
        addToast(t("taskDetail.oversight.nudgeNotApplicable", "Nudge not applicable ({{reason}})", { reason: result.reason }), "info");
      }
    } catch (err) {
      addToast(t("taskDetail.updateFailed", "Failed to update {{id}}: {{error}}", { id: task.id, error: getErrorMessage(err) }), "error");
    } finally {
      if (mountedRef.current) {
        setIsNudgingOverseer(false);
      }
    }
  }, [task.id, projectId, onTaskUpdated, addToast, t]);

  /*
  FNXC:PlannerOversight 2026-07-04-17:00:
  FN-7517 stop-oversight control. Disables active oversight for this task
  (per-task override -> "off") — a lightweight `confirm(...)` guards it since
  it's a disabling action, matching the PROMPT's guidance for this control.

  FNXC:PlannerOversight 2026-07-18-12:00:
  FN-8247 extends Stop to disable the independently-enabled session advisor,
  so confirmation and success copy must tell operators it stops both systems.
  */
  const handleStopOverseer = useCallback(async () => {
    const shouldStop = await confirm({
      title: t("taskDetail.oversight.stopTitle", "Stop planner oversight?"),
      message: t("taskDetail.oversight.stopMessage", "This disables planner oversight and the session advisor for this task."),
    });
    if (!shouldStop) return;

    setIsStoppingOverseer(true);
    try {
      const result = await stopOverseer(task.id, projectId);
      if (result.task) {
        onTaskUpdated?.(result.task);
      }
      addToast(t("taskDetail.oversight.stopped", "Planner oversight and session advisor stopped for this task"), "success");
    } catch (err) {
      addToast(t("taskDetail.updateFailed", "Failed to update {{id}}: {{error}}", { id: task.id, error: getErrorMessage(err) }), "error");
    } finally {
      if (mountedRef.current) {
        setIsStoppingOverseer(false);
      }
    }
  }, [task.id, projectId, onTaskUpdated, addToast, confirm, t]);

  /*
  FNXC:PlannerOversight 2026-07-04-17:00:
  FN-7517 explain-current-action control: toggles a small read-only panel and
  fetches the current overseer runtime state (watched stage, reason, last
  action, attempt count/limit). Never mutates anything.
  */
  const handleExplainOverseer = useCallback(async () => {
    if (overseerExplainOpen) {
      setOverseerExplainOpen(false);
      return;
    }
    setOverseerExplainOpen(true);
    setIsLoadingOverseerExplain(true);
    try {
      const result = await explainOverseer(task.id, projectId);
      if (mountedRef.current) {
        setOverseerExplainSnapshot(result.snapshot);
      }
    } catch {
      if (mountedRef.current) {
        setOverseerExplainSnapshot(null);
      }
    } finally {
      if (mountedRef.current) {
        setIsLoadingOverseerExplain(false);
      }
    }
  }, [task.id, projectId, overseerExplainOpen]);

  // Handle keyboard shortcuts for edit mode
  const handleEditKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isEditing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      exitEditMode();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void handleSave();
    }
  }, [isEditing, exitEditMode, handleSave]);

  useEffect(() => {
    if (!isEditing) return;
    document.addEventListener("keydown", handleEditKeyDown);
    return () => document.removeEventListener("keydown", handleEditKeyDown);
  }, [isEditing, handleEditKeyDown]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const { nodes } = useNodes();

  const handleUnlinkGithubIssue = useCallback(async () => {
    if (!canEdit || !githubTrackedIssue || isSavingGithubTracking) return;
    const confirmed = await confirm({
      title: t("taskDetail.githubTracking.unlinkTitle", "Unlink GitHub issue?"),
      message: t("taskDetail.githubTracking.unlinkMessage", "This stops Fusion from syncing with the linked GitHub issue. The issue itself will not be modified."),
      confirmLabel: t("taskDetail.githubTracking.unlinkConfirm", "Unlink"),
      danger: true,
    });
    if (!confirmed) return;

    setIsSavingGithubTracking(true);
    try {
      const updatedTask = await updateTask(task.id, { githubTracking: { issue: null } }, projectId);
      onTaskUpdated?.(updatedTask);
      addToast(t("taskDetail.githubTracking.issueUnlinked", "GitHub issue unlinked"), "success");
    } catch (err) {
      addToast(t("taskDetail.updateFailed", "Failed to update {{id}}: {{error}}", { id: task.id, error: getErrorMessage(err) }), "error");
    } finally {
      if (mountedRef.current) setIsSavingGithubTracking(false);
    }
  }, [addToast, canEdit, confirm, githubTrackedIssue, isSavingGithubTracking, onTaskUpdated, projectId, task.id]);

  const handleUnlinkGitLabItem = useCallback(async () => {
    if (!canEdit || !gitlabTrackedItem || isSavingGithubTracking) return;
    const confirmed = await confirm({
      title: t("taskDetail.gitlabTracking.unlinkTitle", "Unlink GitLab item?"),
      message: t("taskDetail.gitlabTracking.unlinkMessage", "This removes the local GitLab tracking link. The GitLab issue or merge request itself will not be modified."),
      confirmLabel: t("taskDetail.gitlabTracking.unlinkConfirm", "Unlink"),
      danger: true,
    });
    if (!confirmed) return;

    setIsSavingGithubTracking(true);
    try {
      const updatedTask = await updateTask(task.id, { gitlabTracking: { item: null } }, projectId);
      setFullDetail((prev) => prev
        ? ({ ...prev, ...updatedTask, gitlabTracking: updatedTask.gitlabTracking } as TaskDetail)
        : (updatedTask as TaskDetail));
      onTaskUpdated?.(updatedTask);
      addToast(t("taskDetail.gitlabTracking.itemUnlinked", "GitLab item unlinked"), "success");
    } catch (err) {
      addToast(t("taskDetail.updateFailed", "Failed to update {{id}}: {{error}}", { id: task.id, error: getErrorMessage(err) }), "error");
    } finally {
      if (mountedRef.current) setIsSavingGithubTracking(false);
    }
  }, [addToast, canEdit, confirm, gitlabTrackedItem, isSavingGithubTracking, onTaskUpdated, projectId, task.id, t]);

  const {
    entries: agentLogEntries,
    loading: agentLogLoading,
    loadMore: loadMoreAgentLogs,
    hasMore: agentLogHasMore,
    total: agentLogTotal,
    loadingMore: agentLogLoadingMore,
  } = useAgentLogs(
    task.id,
    // FNXC:TaskPopupViewGating 2026-07-22-13:15: `active` forces the EventSource closed while a kept-alive popup is hidden (R8).
    active && (task.status === "failed" || (activeTab === "chat" && activitySegment === "raw-logs")),
    projectId,
  );
  useEffect(() => {
    if (embedded) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isEditing) requestClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [embedded, requestClose, isEditing]);

  const handleDelete = useCallback(async (canProceed: () => boolean = () => true) => {
    let allowResurrection = false;
    let deletionSucceeded = false;
    let deleteCloseRequested = false;
    const closeBeforeDeleteRequest = () => {
      if (!canProceed()) return false;
      if (deleteCloseRequested) return true;
      /*
      FNXC:TaskDetailDelete 2026-07-01-09:40:
      Task detail hosts must close optimistically after the operator completes every required delete prompt and before each server delete request starts. Keep this helper idempotent so dependency/lineage retries preserve async prompts and toasts without reopening or repeatedly closing the modal, main panel, list split, or right-dock host.
      */
      requestClose();
      deleteCloseRequested = true;
      return true;
    };

    const { choice, checkboxValue } = await confirmWithCheckbox({
      title: t("taskDetail.delete.title", "Delete Task"),
      message: t("taskDetail.delete.message", "Delete {{id}}?", { id: task.id }),
      danger: true,
      checkbox: {
        label: t("taskDetail.delete.allowRecreation", "Allow re-creation later (operator unlock)"),
        description: t("taskDetail.delete.allowRecreationDesc", "Lets agents recreate this task ID without --force-resurrect. Leave unchecked to keep this task tombstoned."),
        defaultChecked: false,
      },
    });
    if (choice !== "primary") return;
    allowResurrection = checkboxValue === true;

    const trackedIssue = task.githubTracking?.enabled === true ? task.githubTracking.issue : undefined;
    let githubIssueAction: GithubIssueAction | undefined;
    if (trackedIssue?.owner && trackedIssue.repo && trackedIssue.number) {
      const issueRef = `${trackedIssue.owner}/${trackedIssue.repo}#${trackedIssue.number}`;
      const shouldCloseIssue = await confirm({
        title: t("taskDetail.delete.linkedIssueTitle", "Linked GitHub Issue"),
        message: t("taskDetail.delete.linkedIssueMessage", "Choose what to do with {{issueRef}} when deleting {{id}}.\n\nClose the issue?", { issueRef, id: task.id }),
        confirmLabel: t("taskDetail.delete.closeIssue", "Close Issue"),
        cancelLabel: t("taskDetail.delete.moreOptions", "More Options"),
      });

      if (shouldCloseIssue) {
        githubIssueAction = "close";
      } else {
        const shouldDeleteIssue = await confirm({
          title: t("taskDetail.delete.deleteLinkedIssueTitle", "Delete Linked GitHub Issue"),
          message: t("taskDetail.delete.deleteLinkedIssueMessage", "Delete {{issueRef}} on GitHub, or leave it unchanged?", { issueRef }),
          confirmLabel: t("taskDetail.delete.deleteIssue", "Delete Issue"),
          cancelLabel: t("taskDetail.delete.leaveUnchanged", "Leave Unchanged"),
          danger: true,
        });
        githubIssueAction = shouldDeleteIssue ? "delete" : "leave";
      }
    }

    try {
      if (!closeBeforeDeleteRequest()) return false;
      if (githubIssueAction) {
        await onDeleteTask(task.id, { githubIssueAction, allowResurrection });
      } else {
        await onDeleteTask(task.id, { allowResurrection });
      }
      const issueSuffix = trackedIssue?.owner && trackedIssue.repo && trackedIssue.number && githubIssueAction
        ? ` ${t("taskDetail.delete.issueSuffix", "and {{action}} issue {{ref}}", { action: githubIssueAction === "close" ? t("taskDetail.delete.actionClosed", "closed") : githubIssueAction === "delete" ? t("taskDetail.delete.actionDeleted", "deleted") : t("taskDetail.delete.actionLeft", "left"), ref: `${trackedIssue.owner}/${trackedIssue.repo}#${trackedIssue.number}` })}`
        : "";
      deletionSucceeded = true;
      addToast(t("taskDetail.delete.deletedToast", "Deleted {{id}}{{suffix}}", { id: task.id, suffix: issueSuffix }), "info");
      return deletionSucceeded;
    } catch (err) {
      const dependencyConflict = extractDependencyDeleteConflict(err);
      if (dependencyConflict && dependencyConflict.dependentIds.length > 0) {
        const dependentList = dependencyConflict.dependentIds.join(", ");
        const confirmed = await confirm({
          title: t("taskDetail.delete.forceDeleteTitle", "Force Delete Task"),
          message:
            `${task.id} is a dependency of ${dependentList}.\n\n` +
            t("taskDetail.delete.deleteUnlinkDepsPrompt", "Delete anyway by removing these dependency references first?"),
          danger: true,
        });
        if (!confirmed) {
          return;
        }

        try {
          closeBeforeDeleteRequest();
          await onDeleteTask(task.id, {
            removeDependencyReferences: true,
            removeLineageReferences: true,
            githubIssueAction,
            allowResurrection,
          });
          addToast(t("taskDetail.delete.deletedAfterRemovingDeps", "Deleted {{id}} after removing dependency references", { id: task.id }), "info");
        } catch (retryErr) {
          const lineageConflict = extractLineageDeleteConflict(retryErr);
          if (!lineageConflict || lineageConflict.lineageChildIds.length === 0) {
            addToast(getErrorMessage(retryErr), "error");
            return;
          }

          const confirmedLineage = await confirm({
            title: t("taskDetail.delete.forceDeleteTitle", "Force Delete Task"),
            message:
              `${task.id} has lineage children (${lineageConflict.lineageChildIds.join(", ")}) that reference it as a source parent.\n\n` +
              t("taskDetail.delete.deleteUnlinkLineagePrompt", "Delete anyway by unlinking these references first?"),
            danger: true,
          });
          if (!confirmedLineage) {
            return;
          }

          try {
            closeBeforeDeleteRequest();
            await onDeleteTask(task.id, {
              removeDependencyReferences: true,
              removeLineageReferences: true,
              githubIssueAction,
              allowResurrection,
            });
            addToast(t("taskDetail.delete.deletedAfterUnlinkLineage", "Deleted {{id}} after unlinking lineage references", { id: task.id }), "info");
          } catch (lineageRetryErr) {
            addToast(getErrorMessage(lineageRetryErr), "error");
          }
        }
        return;
      }

      const lineageConflict = extractLineageDeleteConflict(err);
      if (!lineageConflict || lineageConflict.lineageChildIds.length === 0) {
        addToast(getErrorMessage(err), "error");
        return;
      }

      const confirmed = await confirm({
        title: t("taskDetail.delete.forceDeleteTitle", "Force Delete Task"),
        message:
          `${task.id} has lineage children (${lineageConflict.lineageChildIds.join(", ")}) that reference it as a source parent.\n\n` +
          t("taskDetail.delete.deleteUnlinkLineagePrompt", "Delete anyway by unlinking these references first?"),
        danger: true,
      });
      if (!confirmed) {
        return;
      }

      try {
        closeBeforeDeleteRequest();
        await onDeleteTask(task.id, {
          removeDependencyReferences: true,
          removeLineageReferences: true,
          githubIssueAction,
          allowResurrection,
        });
        addToast(t("taskDetail.delete.deletedAfterUnlinkLineage", "Deleted {{id}} after unlinking lineage references", { id: task.id }), "info");
      } catch (retryErr) {
        addToast(getErrorMessage(retryErr), "error");
      }
    }
  }, [task.githubTracking?.enabled, task.githubTracking?.issue, task.id, onDeleteTask, requestClose, addToast, confirm, confirmWithCheckbox]);
  handleDeleteRef.current = handleDelete;

  const handleMerge = useCallback(async () => {
    const shouldMerge = await confirm({
      title: t("taskDetail.merge.title", "Merge Task"),
      message: t("taskDetail.merge.message", "Merge {{id}} into the current branch?", { id: task.id }),
    });
    if (!shouldMerge) return;
    requestClose();
    addToast(t("taskDetail.merge.merging", "Merging {{id}}…", { id: task.id }), "info");
    onMergeTask(task.id)
      .then((result) => {
        const msg = result.merged
          ? t("taskDetail.merge.merged", "Merged {{id}} (branch: {{branch}})", { id: task.id, branch: result.branch })
          : t("taskDetail.merge.closed", "Closed {{id}} ({{reason}})", { id: task.id, reason: result.error || t("taskDetail.merge.noBranchToMerge", "no branch to merge") });
        addToast(msg, "success");
      })
      .catch((err) => {
        addToast(getErrorMessage(err), "error");
      });
  }, [task.id, onMergeTask, requestClose, addToast, confirm]);

  const confirmRetryStage = useCallback(async () => {
    const copy = resolveRetryStageCopy(t, detailColumnFlags, task.column);
    const confirmed = await confirm({
      title: copy.confirmTitle,
      message: copy.confirmMessage,
      confirmLabel: copy.confirmLabel,
      cancelLabel: t("common.cancel", "Cancel"),
      danger: true,
    });
    return confirmed ? copy : null;
  }, [confirm, detailColumnFlags, t, task.column]);

  const handleRetry = useCallback(async () => {
    if (!onRetryTask) return;
    const copy = await confirmRetryStage();
    if (!copy) return;
    requestClose();
    try {
      await onRetryTask(task.id);
      addToast(copy.successMessage, "success");
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, onRetryTask, requestClose, addToast, confirmRetryStage]);

  useEffect(() => {
    if (!showFailureRetryPicker) return;
    setFailureRetryModel(task.modelProvider && task.modelId ? `${task.modelProvider}/${task.modelId}` : "");
    setFailureRetryNodeId(task.nodeId ?? "");
    void Promise.all([fetchModels(), fetchNodes()])
      .then(([models, nodes]) => {
        setFailureRetryModels(models.models);
        setFailureRetryNodes(nodes);
      })
      .catch((err) => addToast(getErrorMessage(err) || t("taskDetail.error.retryOptionsFailed", "Failed to load retry options"), "error"));
  }, [addToast, showFailureRetryPicker, t, task.id, task.modelId, task.modelProvider, task.nodeId]);

  /*
  FNXC:TaskFailedBanner 2026-07-15-16:30:
  The failed-banner picker stages model/node choices and writes one per-task override
  only when the operator confirms Retry. RoutingTab saves on selection, which would
  leave an abandoned override when the operator closes this recovery picker.

  FNXC:TaskRecoveryVocabulary 2026-08-28-01:20:
  Model and node overrides do not change Retry semantics. The shared stage confirmation must finish before either the override or the destructive stage restart is published.
  */
  const handleRetryWithOverride = useCallback(async () => {
    if (!onRetryTask || isFailureRetrySaving) return;
    const modelSelection = splitModelSelection(failureRetryModel);
    const currentModel = task.modelProvider && task.modelId ? `${task.modelProvider}/${task.modelId}` : "";
    const hasModelChange = failureRetryModel !== currentModel;
    const hasNodeChange = failureRetryNodeId !== (task.nodeId ?? "");
    if (!hasModelChange && !hasNodeChange) return;

    const copy = await confirmRetryStage();
    if (!copy) return;
    setIsFailureRetrySaving(true);
    try {
      const updatedTask = await updateTask(task.id, {
        ...(hasModelChange ? { modelProvider: modelSelection?.provider ?? null, modelId: modelSelection?.modelId ?? null } : {}),
        ...(hasNodeChange ? { nodeId: failureRetryNodeId || null } : {}),
      }, projectId);
      onTaskUpdated?.(updatedTask);
      await onRetryTask(task.id);
      addToast(copy.successMessage, "success");
      requestClose();
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    } finally {
      if (mountedRef.current) setIsFailureRetrySaving(false);
    }
  }, [addToast, confirmRetryStage, failureRetryModel, failureRetryNodeId, isFailureRetrySaving, onRetryTask, onTaskUpdated, projectId, requestClose, task.id, task.modelId, task.modelProvider, task.nodeId]);

  /*
  FNXC:ReviewLaneBypass 2026-07-09-00:00:
  Operator-only review-lane bypass (FN-7720). Requires a non-empty reason
  before firing — mirrors handleReset's window.confirm gate but needs free
  text, so it uses window.prompt rather than the checkbox-only confirm
  dialog. Does NOT close the modal (unlike handleRetry): the operator should
  see the bypassed step's state update in place via onTaskUpdated instead of
  losing detail context.
  */
  const handleBypassReview = useCallback(() => {
    if (!onBypassReview) return;
    const reason = window.prompt(
      t("taskDetail.bypassReview.promptMessage", "Reason for bypassing the failed pre-merge review step (required, audit-logged):"),
    );
    if (!reason || !reason.trim()) return;
    onBypassReview(task.id, reason.trim())
      .then((updated) => {
        onTaskUpdated?.(updated);
        addToast(t("taskDetail.bypassReview.success", "Bypassed failed review lane for {{id}}", { id: task.id }), "success");
      })
      .catch((err) => {
        addToast(getErrorMessage(err), "error");
      });
  }, [task.id, onBypassReview, onTaskUpdated, addToast, t]);

  /*
  FNXC:AIMergeReviewReconciliation 2026-08-20-22:14:
  A dismissal is an explicit, audited operator decision, so eligible active findings collect a
  required reason and use their dedicated reconciliation endpoint rather than workflow bypass.
  */
  const handleDismissAiMergeFinding = useCallback((findingId: string) => {
    const reason = window.prompt(t("taskDetail.aiMergeReview.dismissPrompt", "Reason for dismissing this AI merge finding (required, audit-logged):"));
    if (!reason?.trim()) return;
    dismissAiMergeReviewFinding(task.id, findingId, reason.trim(), projectId)
      .then((updated) => {
        onTaskUpdated?.(updated);
        addToast(t("taskDetail.aiMergeReview.dismissed", "Dismissed AI merge finding for {{id}}", { id: task.id }), "success");
      })
      .catch((err) => addToast(getErrorMessage(err), "error"));
  }, [addToast, onTaskUpdated, projectId, t, task.id]);

  /*
  FNXC:TaskReset 2026-08-28-16:31:
  Task Detail keeps its owner mounted while the editable Reset dialog submits. The detail surface closes only after the server has fenced cleanup and committed fresh Planning state; failures leave both the task and its corrected request visible for retry.
  */
  const handleReset = useCallback(() => {
    if (onResetTask) setShowResetDialog(true);
  }, [onResetTask]);

  const handleDuplicate = useCallback(async () => {
    if (!onDuplicateTask) return;
    const duplicated = await runDuplicateTaskAction({
      taskId: task.id,
      t,
      addToast,
      confirmWithSelect,
      confirm,
      duplicateTask: onDuplicateTask,
      loadBoardWorkflows: () => fetchBoardWorkflows(projectId),
    });
    if (duplicated) requestClose();
  }, [task.id, t, onDuplicateTask, requestClose, addToast, confirm, confirmWithSelect, projectId]);

  const handleDismissNearDuplicate = useCallback(async () => {
    try {
      const updatedTask = await updateTask(task.id, { dismissNearDuplicate: true }, projectId);
      onTaskUpdated?.(updatedTask);
      addToast(t("taskDetail.nearDuplicate.dismissed", "Duplicate flag cleared for {{id}}", { id: task.id }), "success");
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, projectId, onTaskUpdated, addToast]);


  /*
   * FNXC:DuplicateIntake 2026-07-16-14:00:
   * Issue #2225 requires triage-marker duplicates to offer a real clear-or-delete decision.
   * Every duplicate decision uses the existing soft-delete
   * API and clears incoming lineage references so the confirmed duplicate is actually removed.
   */
  const handleDeleteNearDuplicate = useCallback(async () => {
    const confirmed = await confirm({
      title: t("taskDetail.nearDuplicate.deleteTitle", "Delete duplicate task"),
      message: t("taskDetail.nearDuplicate.deleteMessage", "Delete {{id}} as a duplicate of {{duplicateOf}}?", { id: task.id, duplicateOf: nearDuplicateOf }),
      confirmLabel: t("taskDetail.nearDuplicate.deleteConfirm", "Delete"),
      cancelLabel: t("common.cancel", "Cancel"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await onDeleteTask(task.id, { removeLineageReferences: true });
      addToast(t("taskDetail.nearDuplicate.deleted", "Deleted {{id}}", { id: task.id }), "success");
      requestClose();
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [onDeleteTask, confirm, task.id, nearDuplicateOf, addToast, requestClose]);

  /*
  FNXC:TaskRevert 2026-07-05-00:00 (FN-7525):
  Detail-view Revert action, mirroring TaskCard's `handleRevertClick`: calls the
  API in "auto" mode, surfaces a clean-git success toast with the revert commit
  sha, an info toast for `alreadyReverted`, an error toast (never a silent AI
  fork) for `needsHuman`, and otherwise confirms before falling back to the
  AI-undo task on conflict/unsupported. The source task's column is never
  mutated as a side effect.
  */
  const isRevertable = isDoneColumn && Boolean(task.mergeDetails?.commitSha);

  const handleRevertTask = useCallback(async () => {
    if (!onRevertTask) return;
    try {
      const result = await onRevertTask(task.id, { mode: "auto" });

      if (result.mode === "ai") {
        addToast(result.alreadyOpen
          ? t("tasks.revertAlreadyOpen", "An undo task is already open: {{id}}", { id: result.createdTaskId })
          : t("tasks.revertAiCreated", "Created undo task {{id}}", { id: result.createdTaskId }), "success");
        return;
      }

      if (result.alreadyReverted) {
        addToast(t("tasks.revertAlreadyReverted", "{{taskId}} was already reverted", { taskId: task.id }), "info");
        return;
      }

      if (result.needsHuman) {
        addToast(t("tasks.revertNeedsHuman", "Cannot auto-revert {{taskId}}: {{reason}}", { taskId: task.id, reason: result.reason || t("tasks.revertNeedsHumanDefault", "human review required") }), "error");
        return;
      }

      if (result.clean && result.revertCommitSha) {
        addToast(t("tasks.reverted", "Reverted {{taskId}} in commit {{sha}}", { taskId: task.id, sha: result.revertCommitSha.slice(0, 12) }), "success");
        return;
      }

      if (!result.clean || result.unsupported) {
        const confirmed = await confirm({
          title: t("tasks.revertConflictTitle", "Revert Conflict"),
          message: t("tasks.revertConflictMessage", "Git revert conflicts with later changes. Create an AI task to undo this?"),
          cancelLabel: t("common.cancel", "Cancel"),
        });
        if (!confirmed) return;

        const aiResult = await onRevertTask(task.id, { mode: "ai" });
        if (aiResult.mode === "ai") {
          addToast(aiResult.alreadyOpen
            ? t("tasks.revertAlreadyOpen", "An undo task is already open: {{id}}", { id: aiResult.createdTaskId })
            : t("tasks.revertAiCreated", "Created undo task {{id}}", { id: aiResult.createdTaskId }), "success");
        }
        return;
      }

      addToast(t("tasks.revertFailed", "Failed to revert {{taskId}}", { taskId: task.id }), "error");
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [onRevertTask, confirm, task.id, addToast, t]);

  const isTaskPaused = task.paused || task.userPaused;
  /*
  FNXC:PlanReviewReplan 2026-07-15-11:09:
  Plan approval holds always need a clear "why" in the detail surface. Legacy
  release-authorization rows stay ordinary Approve/Reject (FN-7732). When the reason is
  plan-review-replan-cap, explain that Plan Review exhausted automatic REVISE replans
  without converging so the operator is not guessing why the task is parked.
  */
  /*
  FNXC:PlanApproval 2026-08-28-11:29:
  The approval banner follows the task's planning lane, not intake alone. Resolved intake or hold traits qualify, while the shared helper preserves the degraded `triage`/`todo` fallback so first paint cannot hide the operator's only release controls.
  */
  const isPlanningLane = isPreImplementationColumnRole(detailColumnFlags, task.column);
  const isPlanReviewReplanCapApproval = isReviewBudgetExhaustedApproval(task);
  const isAwaitingApproval = isTaskAwaitingPlanApproval(task, isPlanningLane);

  const handleTogglePause = useCallback(async () => {
    try {
      const lifecycleOperation = isTaskPaused ? onUnpauseTask : onPauseTask;
      if (!lifecycleOperation) return;
      const updatedTask = await lifecycleOperation(task.id);
      onTaskUpdated?.(updatedTask);
      addToast(
        isTaskPaused
          ? t("taskDetail.pause.unpaused", "Unpaused {{id}}", { id: task.id })
          : t("taskDetail.pause.paused", "Paused {{id}}", { id: task.id }),
        "success",
      );
      requestClose();
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [isTaskPaused, onPauseTask, onTaskUpdated, onUnpauseTask, task.id, requestClose, addToast, t]);

  const handleApprovePlan = useCallback(async () => {
    try {
      await approvePlan(task.id, projectId);
      addToast(t("taskDetail.plan.approved", "Plan approved — {{id}} moved to Todo", { id: task.id }), "success");
      requestClose();
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, requestClose, addToast]);

  const handleRejectPlan = useCallback(async () => {
    const shouldReject = await confirm({
      title: t("taskDetail.plan.rejectTitle", "Reject Plan"),
      message: t("taskDetail.plan.rejectMessage", "Reject this plan? The specification will be discarded and regenerated."),
      danger: true,
    });
    if (!shouldReject) return;
    try {
      await rejectPlan(task.id, projectId);
      addToast(t("taskDetail.plan.rejected", "Plan rejected — {{id}} returned to Planning for replanning", { id: task.id }), "info");
      requestClose();
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, requestClose, addToast, confirm]);

  const handleOpenRefineModal = useCallback(() => {
    setShowRefineModal(true);
    setRefineFeedback("");
  }, []);

  useEffect(() => {
    if (initialAction?.action !== "refine") return;
    /*
    FNXC:DoneTaskRefine 2026-07-01-00:00:
    Done-task card/list right-click and long-press menus route Refine through Task Detail so operators get the existing feedback composer, validation, toasts, and refineTask submission instead of a dead menu item or an immediate API call.
    */
    handleOpenRefineModal();
  }, [handleOpenRefineModal, initialAction?.action, initialAction?.requestId]);

  // Helper to close the retained footer Actions menu after an action.
  const closeMenus = useCallback(() => {
    setShowActionsMenu(false);
  }, []);

  const handleMergeMenuItemClick = useCallback(() => {
    closeMenus();
    void handleMerge();
  }, [closeMenus, handleMerge]);

  const handleStartPrReviewMenuItemClick = useCallback(() => {
    closeMenus();
    setPrCreateOpen(true);
  }, [closeMenus]);

  const handleCheckPrStatus = useCallback(async () => {
    if (isCheckingPrStatus) return;
    closeMenus();
    setIsCheckingPrStatus(true);
    try {
      const result = await refreshPrStatus(task.id, projectId);
      addToast(t("taskDetail.pr.statusRefreshed", "PR status refreshed"), "success");
      onTaskUpdated?.({
        ...task,
        prInfo: result.prInfo,
        prInfos: result.all?.map((entry) => entry.prInfo) ?? task.prInfos,
      });
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    } finally {
      setIsCheckingPrStatus(false);
    }
  }, [addToast, closeMenus, isCheckingPrStatus, onTaskUpdated, projectId, task]);

  const handleCloseRefineModal = useCallback(() => {
    setShowRefineModal(false);
    setRefineFeedback("");
    setIsRefining(false);
  }, []);
  /*
  FNXC:TaskDetailRefine 2026-07-12-00:00:
  The nested refine overlay must use the shared overlay-dismiss contract so the click/touch sequence that opens Refine never self-dismisses the freshly mounted composer, and so backdrop presses honor the global default-off modal-dismiss preference like every other dashboard modal.
  */
  const refineOverlayDismissProps = useOverlayDismiss(handleCloseRefineModal);

  const handleSubmitRefine = useCallback(async () => {
    if (!refineFeedback.trim()) {
      addToast(t("taskDetail.refine.feedbackRequired", "Please enter feedback describing what needs refinement"), "error");
      return;
    }
    if (refineFeedback.length > MAX_TASK_MESSAGE_LENGTH) {
      addToast(t("taskDetail.refine.feedbackTooLong", "Feedback must be {{max}} characters or less", { max: MAX_TASK_MESSAGE_LENGTH }), "error");
      return;
    }
    setIsRefining(true);
    try {
      const newTask = await refineTask(task.id, refineFeedback.trim(), projectId);
      /*
      FNXC:TaskRefinementBoardVisibility 2026-08-20-20:43:
      The returned child enters shared board state before this source detail closes, rather than
      relying on delayed SSE delivery. Its server-selected column must remain untouched here.
      */
      onRefinementCreated?.(newTask);
      addToast(t("taskDetail.refine.taskCreated", "Refinement task created: {{id}}", { id: newTask.id }), "success");
      requestClose();
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    } finally {
      setIsRefining(false);
    }
  }, [task.id, refineFeedback, addToast, onRefinementCreated, projectId, requestClose]);

  const uploadFile = useCallback(async (file: File) => {
    setUploading(true);
    try {
      const attachment = await uploadAttachment(task.id, file, projectId);
      setAttachments((prev) => [...prev, attachment]);
      addToast(t("taskDetail.attachments.attached", "Screenshot attached"), "success");
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    } finally {
      setUploading(false);
    }
  }, [task.id, addToast]);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [uploadFile]);

  /*
  FNXC:TaskPopupViewGating 2026-07-23-10:20:
  The document-level image-paste listener must not stay registered while this detail is a kept-alive
  hidden popup (active=false): pasting an image anywhere in the app would silently attach it to every
  hidden task. Gate registration on `active`; visible hosts (active defaults true) are unchanged and
  the listener re-registers on reveal.
  */
  useEffect(() => {
    if (!active) return;
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            uploadFile(file);
            return;
          }
        }
      }
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [uploadFile, active]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith("image/")) {
        uploadFile(file);
        return;
      }
    }
  }, [uploadFile]);

  const handleDeleteAttachment = useCallback(async (filename: string) => {
    try {
      await deleteAttachment(task.id, filename, projectId);
      setAttachments((prev) => prev.filter((a) => a.filename !== filename));
      addToast(t("taskDetail.attachments.deleted", "Attachment deleted"), "info");
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, addToast]);

  const handleWorkflowStepsChange = useCallback(async (enabledWorkflowSteps: string[]) => {
    const previousSteps = workflowEnabledSteps;
    setWorkflowEnabledSteps(enabledWorkflowSteps);

    try {
      const updatedTask = await updateTask(task.id, { enabledWorkflowSteps }, projectId);
      addToast(t("taskDetail.workflow.stepsUpdated", "Workflow steps updated"), "success");
      onTaskUpdated?.(updatedTask);
    } catch (err) {
      setWorkflowEnabledSteps(previousSteps);
      addToast(t("taskDetail.workflow.stepsUpdateFailed", "Failed to update workflow steps: {{error}}", { error: getErrorMessage(err) }), "error");
    }
  }, [task.id, projectId, workflowEnabledSteps, onTaskUpdated, addToast]);

  // U5 (R20): a workflow switch re-homed the card to a new column. Refetch the
  // task and push it up so the board reflects the move before the SSE catch-up.
  const handleWorkflowReconciled = useCallback(async () => {
    try {
      const detail = await fetchTaskDetail(task.id, projectId);
      setFullDetail((previous) => previous?.id === detail.id ? mergeTaskSnapshot(previous, detail, { fullSnapshot: true }) : detail);
      onTaskUpdated?.(detail);
    } catch {
      // Best-effort refresh; the SSE stream will catch the board up regardless.
    }
  }, [task.id, projectId, onTaskUpdated]);

  const handleBranchGroupReset = useCallback(async () => {
    const detail = await fetchTaskDetail(task.id, projectId);
    setFullDetail((previous) => previous?.id === detail.id ? mergeTaskSnapshot(previous, detail, { fullSnapshot: true }) : detail);
    onTaskUpdated?.(detail);
  }, [task.id, projectId, onTaskUpdated]);

  const loadAgents = useCallback(async () => {
    setAgentsLoading(true);
    try {
      const loadedAgents = await fetchAgents(undefined, projectId);
      setAgents(loadedAgents);
      setShowAgentPicker(true);
    } catch (err) {
      addToast(t("taskDetail.agent.loadFailed", "Failed to load agents: {{error}}", { error: getErrorMessage(err) }), "error");
      setShowAgentPicker(false);
    } finally {
      setAgentsLoading(false);
    }
  }, [projectId, addToast]);

  const handleAssignAgent = useCallback(async (agentId: string) => {
    try {
      const updatedTask = await assignTask(task.id, agentId, projectId);
      const selected = agents.find((agent) => agent.id === agentId) ?? null;
      if (selected) {
        setAssignedAgent(selected);
      } else {
        setAssignedAgent((prev) => (prev?.id === agentId ? prev : null));
      }
      setShowAgentPicker(false);
      onTaskUpdated?.(updatedTask);
      addToast(t("taskDetail.agent.assignedUpdated", "Assigned agent updated"), "success");
    } catch (err) {
      addToast(t("taskDetail.agent.assignFailed", "Failed to assign agent: {{error}}", { error: getErrorMessage(err) }), "error");
    }
  }, [task.id, projectId, agents, onTaskUpdated, addToast]);

  const handleClearAgent = useCallback(async () => {
    try {
      const updatedTask = await assignTask(task.id, null, projectId);
      setAssignedAgent(null);
      setShowAgentPicker(false);
      onTaskUpdated?.(updatedTask);
      addToast(t("taskDetail.agent.unassigned", "Agent unassigned"), "success");
    } catch (err) {
      addToast(t("taskDetail.agent.unassignFailed", "Failed to unassign agent: {{error}}", { error: getErrorMessage(err) }), "error");
    }
  }, [task.id, projectId, onTaskUpdated, addToast]);

  const handleAddDep = useCallback(async (depId: string) => {
    const newDeps = [...dependencies, depId];
    setDependencies(newDeps);
    try {
      await updateTask(task.id, { dependencies: newDeps }, projectId);
    } catch (err) {
      setDependencies(dependencies);
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, dependencies, addToast]);

  const handleRemoveDep = useCallback(async (e: React.MouseEvent, depId: string) => {
    e.stopPropagation(); // Prevent triggering dependency click
    const newDeps = dependencies.filter((d) => d !== depId);
    setDependencies(newDeps);
    try {
      await updateTask(task.id, { dependencies: newDeps }, projectId);
    } catch (err) {
      setDependencies(dependencies);
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, dependencies, addToast]);

  const handleClearOverlapBlocker = useCallback(async () => {
    if (!workingTask.overlapBlockedBy) return;

    const requestTaskId = task.id;

    try {
      const result = await repairOverlapBlocker(task.id, { reason: "dashboard-clear-overlap-blocker" }, projectId);
      if (activeTaskIdRef.current !== requestTaskId) {
        return;
      }
      if (result.task) {
        setOverlapBlockedByOverride(result.task.overlapBlockedBy ?? null);
        setFullDetail((prev) => prev ? ({ ...prev, ...result.task } as TaskDetail) : (result.task as TaskDetail));
        onTaskUpdated?.(result.task);
      } else {
        const updatedTask = await fetchTaskDetail(task.id, projectId);
        if (activeTaskIdRef.current !== requestTaskId) {
          return;
        }
        setOverlapBlockedByOverride(updatedTask.overlapBlockedBy ?? null);
        setFullDetail((prev) => prev ? ({ ...prev, ...updatedTask } as TaskDetail) : updatedTask);
        onTaskUpdated?.(updatedTask);
      }
      addToast(result.message, "success");
    } catch (err) {
      if (activeTaskIdRef.current !== requestTaskId) {
        return;
      }
      addToast(getErrorMessage(err), "error");
    }
  }, [activeTaskIdRef, addToast, onTaskUpdated, projectId, task.id, workingTask.overlapBlockedBy]);

  const handleDepClick = useCallback(async (depId: string) => {
    try {
      const detail = await fetchTaskDetail(depId, projectId);
      onOpenDetail(detail);
    } catch {
      addToast(t("taskDetail.deps.loadFailed", "Failed to load dependency {{id}}", { id: depId }), "error");
    }
  }, [onOpenDetail, addToast, projectId, t]);

  /*
  FNXC:SharedBranchPromotionAdvisories 2026-08-08-02:16:
  FN-8823 promotion advisories must open the landed member on Review, not its
  completed-task default tab; every member is loaded through the authoritative detail route.
  */
  const handleOpenMemberReview = useCallback(async (memberTaskId: string) => {
    try {
      const detail = await fetchTaskDetail(memberTaskId, projectId);
      onOpenDetail(detail, "review");
    } catch {
      addToast(t("branchGroup.reviewLoadFailed", "Failed to open review for {{id}}", { id: memberTaskId }), "error");
    }
  }, [addToast, onOpenDetail, projectId, t]);

  // Spec save handlers (must be declared before functions that use them)
  const handleSaveSpec = useCallback(async (newContent: string) => {
    setIsSavingSpec(true);
    try {
      await updateTask(workingTask.id, { prompt: newContent }, projectId);
      addToast(t("taskDetail.spec.updated", "Spec updated"), "success");
      // FNXC:TaskDetailPlan 2026-08-03-02:06: update immutably so the preview reflects an explicit save.
      setFullDetail((previous) => previous ? { ...previous, prompt: newContent } : previous);
    } catch (err) {
      addToast(getErrorMessage(err), "error");
      throw err;
    } finally {
      setIsSavingSpec(false);
    }
  }, [workingTask, addToast]);

  const handleRequestSpecRevision = useCallback(async (feedback: string) => {
    setIsRequestingRevision(true);
    try {
      await requestSpecRevision(task.id, feedback, projectId);
      addToast(t("taskDetail.spec.revisionRequested", "AI revision requested. Task moved to planning."), "success");
      // Task has been moved to planning, close modal
      requestClose();
    } catch (err) {
      const msg = getErrorMessage(err);
      if (msg.includes("done") || msg.includes("complete")) {
        addToast(t("taskDetail.spec.revisionColumnError", "Cannot request revision: Task must be in 'triage', 'todo', 'in-progress', or 'in-review' column."), "error");
      } else {
        addToast(msg, "error");
      }
    } finally {
      setIsRequestingRevision(false);
    }
  }, [task.id, addToast, requestClose]);

  // Spec editing handlers (depend on handleSaveSpec and handleRequestSpecRevision)
  const enterSpecEditMode = useCallback(() => {
    setIsEditingSpec(true);
    setSpecEditContent(workingTask.prompt || "");
    setSpecFeedback("");
  }, [workingTask.prompt]);

  const exitSpecEditMode = useCallback(() => {
    setIsEditingSpec(false);
    setSpecEditContent(workingTask.prompt || "");
    setSpecFeedback("");
  }, [workingTask.prompt]);

  const handleSaveSpecFromEdit = useCallback(async () => {
    if (specEditContent === (workingTask.prompt || "")) {
      exitSpecEditMode();
      return;
    }

    // Exit edit mode immediately so the UI transitions back to preview as soon
    // as save is initiated. If save fails, restore edit mode for retry.
    setIsEditingSpec(false);
    try {
      await handleSaveSpec(specEditContent);
    } catch (err) {
      setIsEditingSpec(true);
      throw err;
    }
  }, [specEditContent, workingTask.prompt, handleSaveSpec, exitSpecEditMode]);

  const handleRequestRevisionFromEdit = useCallback(async () => {
    if (!specFeedback.trim()) return;
    await handleRequestSpecRevision(specFeedback.trim());
  }, [specFeedback, handleRequestSpecRevision]);

  // Keyboard shortcuts for spec edit mode
  const handleSpecTextareaKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      exitSpecEditMode();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void handleSaveSpecFromEdit();
    }
  }, [exitSpecEditMode, handleSaveSpecFromEdit]);

  const availableTasks = tasks
    .filter((t) => t.id !== task.id && !dependencies.includes(t.id))
    .sort((a, b) => {
      const cmp = b.createdAt.localeCompare(a.createdAt);
      if (cmp !== 0) return cmp;
      const aNum = parseInt(a.id.slice(a.id.lastIndexOf("-") + 1), 10) || 0;
      const bNum = parseInt(b.id.slice(b.id.lastIndexOf("-") + 1), 10) || 0;
      return bNum - aNum;
    });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-23:20 (third fan-out surface):
  Without resolved traits this classified against `todo`/`in-review`/`done`, so on a renamed board
  the "blocking N todo task(s)" line counted zero and the `stale` marker on each blocking dependent
  was decided against lanes the operator does not use. The dependent LIST itself is lane-independent
  (core pushes `dependentIds` unconditionally), which is why the modal still looked broadly right —
  only the count and the staleness were wrong.

  Optional: a card with no entry keeps the documented legacy fallback, so the remote-node case and
  the pre-load window are byte-identical.
  */
  const blockerFanoutMap = useMemo(
    () => computeBlockerFanoutMap(tasks, columnFlagsByTaskId ? { columnFlagsByTaskId } : {}),
    [tasks, columnFlagsByTaskId],
  );
  const blockingEntry = blockerFanoutMap.get(task.id);
  const blockingDependents = useMemo(() => {
    if (!blockingEntry) return [] as Array<{ id: string; label: string; stale: boolean }>;
    const staleSet = new Set(blockingEntry.staleBlockedByDependentIds);
    return blockingEntry.dependentIds.map((dependentId) => {
      const dependentTask = tasks.find((candidate) => candidate.id === dependentId);
      return {
        id: dependentId,
        label: dependentTask?.title || dependentTask?.description || dependentId,
        stale: staleSet.has(dependentId),
      };
    });
  }, [blockingEntry, tasks]);

  const overlapBlockingSummary = blockingEntry
    ? `${task.id} is blocking ${blockingEntry.overlapBlockedTodoCount} todo task(s) via blockedBy overlap`
    : null;
  const overlapBlockerTask = workingTask.overlapBlockedBy
    ? tasks.find((candidate) => candidate.id === workingTask.overlapBlockedBy)
    : undefined;
  /*
  FNXC:OverlapBlocker 2026-07-30-05:00 DELIBERATE-LITERAL: asks about ANOTHER task's column.
  `overlapBlockerTask` is a row found in `tasks` — this modal holds resolved flags for its OWN
  column only, and nothing in scope maps an arbitrary other task's column to traits. Converting
  needs a flags-by-column map threaded in (the shape `ListView` already has), which is a prop change
  across callers, not a substitution. Sized, not guessed.
  */
  const overlapBlockerActive = Boolean(
    overlapBlockerTask && (overlapBlockerTask.column === "in-progress" || overlapBlockerTask.column === "in-review"),
  );

  const handleChatTaskUpdated = useCallback((updatedTask: Task) => {
    setFullDetail((prev) => prev ? ({ ...prev, ...updatedTask } as TaskDetail) : (updatedTask as TaskDetail));
    onTaskUpdated?.(updatedTask);
  }, [onTaskUpdated]);

  const assignedAgentLabel = assignedAgent?.name ?? task.assignedAgentId ?? null;
  const detailProviders = useMemo(() => {
    const providers: string[] = [];
    if (workingTask.modelProvider) providers.push(workingTask.modelProvider);
    if (workingTask.validatorModelProvider && !providers.includes(workingTask.validatorModelProvider)) {
      providers.push(workingTask.validatorModelProvider);
    }
    if (workingTask.planningModelProvider && !providers.includes(workingTask.planningModelProvider)) {
      providers.push(workingTask.planningModelProvider);
    }
    return providers;
  }, [workingTask.modelProvider, workingTask.validatorModelProvider, workingTask.planningModelProvider]);


  const prAutomationLabel = getTaskPrAutomationLabel(t, task.status);
  const mergeStrategy = settings?.mergeStrategy ?? "direct";
  const autoMergeEnabled = autoMergeEnabledProp ?? (settings?.autoMerge ?? false);
  const effectiveAutoMerge = resolveEffectiveAutoMerge({ autoMerge: task.autoMerge }, { autoMerge: autoMergeEnabled });
  /*
  FNXC:TaskDetailPr 2026-07-05-19:45:
  Manual PR flow visibility must follow the LIVE GLOBAL auto-merge setting
  (`autoMergeEnabled`), not the per-task effective auto-merge override
  (`effectiveAutoMerge`). Otherwise a per-task auto-merge override of `true`
  hides manual PR affordances even when global auto-merge is off, stranding
  the user with no way to manually open/manage the PR (FN-7607; regression
  introduced by FN-7255 / commit 924bcb97d, which switched this from
  `!autoMergeEnabled` to `!effectiveAutoMerge`). The `autoMerge` prop passed
  to PrPanel stays `effectiveAutoMerge` — only this flow-gating boolean is
  keyed off the live global setting.
  */
  const isManualPrFlow = mergeStrategy === "pull-request" && !autoMergeEnabled;
  /*
  FNXC:PlannerOversight 2026-07-04-17:00:
  FN-7517 enablement rules for the nudge/stop/explain controls. Nudge and
  explain require the overseer to actively be watching this task (mirrors
  `PlannerOverseerMonitor.observeTask`, which records nothing for an idle/off
  task) — approximated client-side via presence of `task.plannerOverseerState`
  (FN-7531; only ever populated while there is a live observation). Nudge
  additionally respects the human-control safeguards this task must NOT
  re-implement (FN-7513/FN-7514): user-pause (`isTaskPaused`), workflow Complete
  columns, and the `autoMerge:false` in-review human-review terminal
  (approximated here via `effectiveAutoMerge`, the same resolver the merge UI
  already uses — the server-side `evaluateOverseerHumanControl` guard is the
  real enforcement; this is a client-side disable heuristic only). Stop is
  hidden once oversight is already off — there is nothing left to stop.

  FNXC:PlannerOversight 2026-07-05-00:00:
  FN-7582: the original disabled-Nudge copy ("overseer is not actively
  watching this task") read as a fault report — operators seeing it on a
  healthy IN PROGRESS task assumed the overseer had broken, when the real
  cause is benign: `pollPlannerOverseer` observes in-progress/in-review tasks
  on a bounded ~45s poll, and `plannerOverseerState` is only populated once
  that poll records a live observation for the current stage (FN-7531). The
  reworded copy below differentiates two distinct disabled reasons instead of
  one alarming message: (1) no observation yet — reassuring, periodic-poll
  framing (`nudgeDisabledTitle`); (2) human-control suppressed — user-paused,
  workflow Complete, or the `autoMerge:false` in-review human-review terminal —
  which gets its own distinct copy (`nudgeSuppressedTitle`) naming manual
  control as the reason instead of implying the overseer is idle. Neither
  `canNudgeOverseer` nor any other enablement/gating boolean changed; this is
  copy-only, selected via the already-computed `overseerHumanControlSuppressed`
  / `overseerActive` booleans below.
  */
  /*
  FNXC:PlannerOversight 2026-07-05-00:00:
  FN-7600: this used to read `task.plannerOverseerState` — the transient
  snapshot enrichment from `GET /api/tasks` (list) — but the modal is
  frequently opened via `fetchTaskDetail` (dependency chips, Documents view,
  logs, or the post-open detail refetch) where the parent `task` prop never
  carries the snapshot, so `overseerActive`/`canNudgeOverseer` were almost
  always false and Nudge showed the periodic-observation copy even while the
  overseer was actively watching. `GET /api/tasks/:id` now attaches the same
  snapshot (mirrors the list route), so read it from `workingTask` — the
  full-detail-backed merged object — instead of the raw prop.
  */
  const overseerSnapshot = workingTask.plannerOverseerState ?? null;
  const overseerActive = Boolean(overseerSnapshot);
  const isOverseerHumanReviewTerminal = isReviewColumn && !effectiveAutoMerge;
  const overseerHumanControlSuppressed = Boolean(isTaskPaused) || isDoneColumn || isOverseerHumanReviewTerminal;
  const oversightIsOff = effectiveOversightLevel === "off";
  /*
  FNXC:PlannerOversight 2026-09-05-23:27:
  The footer Oversight group remains available for an applicable session advisor independently of lifecycle-oversight resolution. Stable inheritance inputs or an explicit override keep the advisor toggle reachable while lifecycle-specific choices wait for a resolved workflow.
  */
  const lifecycleOversightControlsResolved = hasTaskOversightOverride || workflowOversightResolved;
  const sessionAdvisorMenuApplicable =
    hasSessionAdvisorOverride ||
    projectSessionAdvisorDefault ||
    workflowOversightState.sessionAdvisorEnabled;
  const showOversightMenuTrigger = lifecycleOversightControlsResolved || sessionAdvisorMenuApplicable;
  /*
  FNXC:PlannerOversight 2026-09-05-23:27:
  Suppress the autonomous fallback while workflow lifecycle oversight is unresolved. The footer heading's combined state still tracks the shared advisor resolver immediately rather than reporting a stale active value.
  */
  const overseerTriggerOn =
    (lifecycleOversightControlsResolved && !oversightIsOff) || effectiveSessionAdvisorEnabled;
  const canNudgeOverseer = overseerActive && !oversightIsOff && !overseerHumanControlSuppressed;
  const showStopOverseer = !oversightIsOff;
  /*
  FNXC:PlannerOversight 2026-09-05-23:27:
  Compute the disabled reason once for the footer Actions note. Prefer the human-control explanation when suppression is active even if the overseer is also inactive, because it gives the operator the actionable cause.
  */
  const nudgeDisabledReason = overseerHumanControlSuppressed
    ? t("taskDetail.oversight.nudgeSuppressedTitle", "Nudge is paused while this task is under manual control.")
    : t("taskDetail.oversight.nudgeDisabledTitle", "Nudge becomes available once the overseer is observing this task's current stage — it checks periodically.");
  const isActivityExpanded = activityExpanded && activeTab === "chat" && !isEditing;
  const isPlannerChatExpanded = plannerChatExpanded && activeTab === "planner-chat" && !isEditing;
  /*
  FNXC:TaskDetailActivity 2026-06-30-23:55:
  Maximized Activity applies to Live, Feed, and Raw Logs, not only the legacy `current` chat segment. Reserve the detail surface for header context and Activity content, and do not mount branch-group chrome in this mode so expand/promote controls are not hidden-but-focusable.
  */
  const shouldShowBranchGroupCard = Boolean(task.branchContext?.groupId && !isActivityExpanded);
  /*
  FNXC:TaskDetailPlannerChat 2026-07-01-00:00:
  Maximized Planner Chat reserves vertical room for task identity and the planner conversation, so failed-task chrome is not mounted in that state. Normal detail, Activity expansion, and collapsed Planner Chat still surface task failures immediately.
  */
  /*
  FNXC:TaskFailedBanner 2026-07-15-16:30:
  Failed tasks must always expose recovery controls, including legacy/errorless failures,
  without mounting an empty error-message shell. The default banner fetches agent logs
  independently of the Raw Logs segment because FN-7995 persists bounded `tool_error`
  detail there; the Raw-Logs-gated display list is not a diagnostic data source.

  FNXC:TaskFailedBanner 2026-08-07-23:36:
  Only the latest tool completion can supply failure detail. A later `tool_result` or a blank latest `tool_error` prevents an older recovered error from being attributed to the current failure.

  FNXC:TaskRecoveryVocabulary 2026-08-28-01:20:
  A scheduled automatic recovery must not hide the failed-task alert. Operators still need the pending-recovery explanation and an immediate, stage-aware Retry choice.
  */
  const shouldShowTaskFailureAlert = Boolean(task.status === "failed" && !isPlannerChatExpanded);
  const taskFailureReason = task.error?.trim() || t("taskDetail.error.genericFailureReason", "The task failed before it could complete.");
  const taskFailureToolDetail = useMemo(() => {
    const lastToolCompletion = agentLogEntries.findLast(
      (entry) => entry.type === "tool_result" || entry.type === "tool_error",
    );
    return lastToolCompletion?.type === "tool_error"
      ? lastToolCompletion.detail?.trim().slice(0, 1024) || undefined
      : undefined;
  }, [agentLogEntries]);
  const taskFailureHint = /workflow graph terminated|step-execute|no files? (were )?modified/i.test(`${task.error ?? ""}\n${taskFailureToolDetail ?? ""}`)
    ? t("taskDetail.error.retryHint", "Consider retrying with a different model or node.")
    : null;

  const taskActionMenuModel = useMemo(() => buildTaskActionMenuModel({
    task,
    t,
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-18:10 (PR #2761 review — greptile, and the finding is on my
    own change): BOTH FIELDS OR NEITHER. Guarding `currentColumnFlags` alone left `moveColumns` coming
    from the PREVIOUS task, so the action model mixed one task's roles with another's move targets —
    an inconsistency my narrowing created, and arguably worse than leaving both unguarded, because the
    menu then offers destinations from a card the operator is no longer looking at.
    */
    currentColumnFlags: detailColumnFlags,
    hasDuplicateHandler: Boolean(onDuplicateTask),
    hasRetryHandler: Boolean(onRetryTask),
    hasResetHandler: Boolean(onResetTask),
    hasBypassReviewHandler: Boolean(onBypassReview),
    mergeStrategy,
    autoMergeEnabled: effectiveAutoMerge,
    prAutomationLabel,
    isCheckingPrStatus,
    onDelete: handleDelete,
    onDuplicate: handleDuplicate,
    onOpenRefine: handleOpenRefineModal,
    onRetry: handleRetry,
    onReset: handleReset,
    onTogglePause: handleTogglePause,
    onMerge: handleMergeMenuItemClick,
    onStartPrReview: handleStartPrReviewMenuItemClick,
    onCheckPrStatus: handleCheckPrStatus,
    onBypassReview: handleBypassReview,
  }), [
    task,
    t,
    workflowMoveMetadata,
    onDuplicateTask,
    onRetryTask,
    onResetTask,
    onBypassReview,
    mergeStrategy,
    effectiveAutoMerge,
    prAutomationLabel,
    isCheckingPrStatus,
    handleDelete,
    handleDuplicate,
    handleOpenRefineModal,
    handleRetry,
    handleReset,
    handleTogglePause,
    handleMergeMenuItemClick,
    handleStartPrReviewMenuItemClick,
    handleCheckPrStatus,
    handleBypassReview,
  ]);

  /*
  FNXC:TaskDetailFooterActions 2026-09-05-23:27:
  Task Detail keeps Quick Add's attach → GitHub → Oversight → Priority → Fast order, but contributes those controls as labeled items to the existing flat footer Actions menu. Every actionable selection follows the menu's one close path before the retained persistence handler runs; the existing toast supplies completion feedback, and opening focuses the first enabled action (normally Attach file) instead of introducing a second toggle-menu behavior.
  */
  const detailQuickActionItems = useMemo<TaskMenuItemDescriptor[]>(() => {
    const items: TaskMenuItemDescriptor[] = [
      {
        id: "detail-inline-attach",
        testId: "detail-inline-attach",
        label: t("taskDetail.attachments.attachInline", "Attach file"),
        disabled: uploading,
        onSelect: () => fileInputRef.current?.click(),
      },
    ];

    if (canEditGithubTracking && !gitlabTrackedItem) {
      items.push({
        id: "detail-inline-github-toggle",
        testId: "detail-inline-github-toggle",
        label: t("taskDetail.githubTracking.toggleInline", "Toggle GitHub tracking"),
        pressed: githubTrackingEnabled,
        disabled: isSavingGithubTracking,
        onSelect: () => void handleToggleGithubTracking(),
      });
    }

    if (showOversightMenuTrigger) {
      items.push({
        id: "detail-actions-oversight-heading",
        testId: "detail-actions-oversight-heading",
        label: t("taskDetail.actions.oversightHeading", "Oversight: {{state}}", {
          state: overseerTriggerOn
            ? t("tasks.sessionAdvisorDefaultOn", "on")
            : t("tasks.sessionAdvisorDefaultOff", "off"),
        }),
        tone: "note",
      });

      if (lifecycleOversightControlsResolved) {
        const selectedOversightLevel = hasTaskOversightOverride
          ? task.plannerOversightLevel as string
          : "__inherit__";
        items.push({
          id: "detail-oversight-level-__inherit__",
          testId: "detail-oversight-level-__inherit__",
          label: t("taskDetail.oversight.inherit", "Inherit ({{level}})", {
            level: OVERSIGHT_LEVEL_LABEL[effectiveOversightLevel],
          }),
          pressed: selectedOversightLevel === "__inherit__",
          disabled: isSavingOversightLevel,
          onSelect: () => void handleOversightLevelChange("__inherit__"),
        });
        for (const level of PLANNER_OVERSIGHT_LEVELS) {
          items.push({
            id: `detail-oversight-level-${level}`,
            testId: `detail-oversight-level-${level}`,
            label: OVERSIGHT_LEVEL_LABEL[level],
            pressed: selectedOversightLevel === level,
            disabled: isSavingOversightLevel,
            onSelect: () => void handleOversightLevelChange(level),
          });
        }
      }

      items.push({
        id: "detail-session-advisor-toggle",
        testId: "detail-session-advisor-toggle",
        label: `${t("taskDetail.sessionAdvisor.label", "Session advisor: {{state}}", {
          state: effectiveSessionAdvisorEnabled
            ? t("tasks.sessionAdvisorDefaultOn", "on")
            : t("tasks.sessionAdvisorDefaultOff", "off"),
        })}${hasSessionAdvisorOverride ? "" : t("taskDetail.sessionAdvisor.inheritSuffix", " (inherited)")}`,
        pressed: effectiveSessionAdvisorEnabled,
        disabled: isSavingSessionAdvisor,
        onSelect: () => void handleSessionAdvisorToggle(),
      });

      if (lifecycleOversightControlsResolved && !oversightIsOff) {
        items.push({
          id: "detail-oversight-controls-label",
          testId: "detail-oversight-controls-label",
          label: t("taskDetail.oversight.controlsLabel", "Overseer controls"),
          tone: "note",
        });
        items.push({
          id: "detail-overseer-nudge",
          testId: "detail-overseer-nudge",
          label: t("taskDetail.oversight.nudgeAriaLabel", "Manual nudge"),
          disabled: !canNudgeOverseer || isNudgingOverseer,
          onSelect: () => void handleNudgeOverseer(),
        });
        if (!canNudgeOverseer) {
          items.push({
            id: "detail-overseer-nudge-disabled-reason",
            testId: "detail-overseer-nudge-disabled-reason",
            label: nudgeDisabledReason,
            tone: "note",
          });
        }
      }

      if (lifecycleOversightControlsResolved && showStopOverseer) {
        items.push({
          id: "detail-overseer-stop",
          testId: "detail-overseer-stop",
          label: t("taskDetail.oversight.stopAriaLabel", "Stop oversight"),
          disabled: isStoppingOverseer,
          onSelect: () => void handleStopOverseer(),
        });
      }
      if (lifecycleOversightControlsResolved && !oversightIsOff) {
        items.push({
          id: "detail-overseer-explain",
          testId: "detail-overseer-explain",
          label: t("taskDetail.oversight.explainAriaLabel", "Explain current action"),
          pressed: overseerExplainOpen,
          onSelect: () => void handleExplainOverseer(),
        });
      }
    }

    items.push({
      id: "detail-actions-priority-heading",
      testId: "detail-actions-priority-heading",
      label: t("taskDetail.actions.priorityHeading", "Priority"),
      tone: "note",
    });
    for (const priority of TASK_PRIORITIES) {
      items.push({
        id: `detail-priority-option-${priority}`,
        testId: `detail-priority-option-${priority}`,
        label: getPriorityLabel(priority),
        pressed: inlinePriority === priority,
        disabled: isSavingInlinePriority,
        onSelect: () => void handleInlinePriorityChange(priority),
      });
    }
    items.push({
      id: "detail-execution-mode-toggle",
      testId: "detail-execution-mode-toggle",
      label: t("taskDetail.executionMode.ariaLabel", "Execution mode: {{mode}}", { mode: inlineExecutionMode }),
      pressed: inlineExecutionMode === "fast",
      disabled: isSavingInlineExecutionMode,
      onSelect: () => void handleInlineExecutionModeToggle(),
    });

    return items;
  }, [
    uploading,
    canEditGithubTracking,
    gitlabTrackedItem,
    githubTrackingEnabled,
    isSavingGithubTracking,
    handleToggleGithubTracking,
    showOversightMenuTrigger,
    overseerTriggerOn,
    lifecycleOversightControlsResolved,
    hasTaskOversightOverride,
    task.plannerOversightLevel,
    effectiveOversightLevel,
    isSavingOversightLevel,
    handleOversightLevelChange,
    effectiveSessionAdvisorEnabled,
    hasSessionAdvisorOverride,
    isSavingSessionAdvisor,
    handleSessionAdvisorToggle,
    oversightIsOff,
    canNudgeOverseer,
    isNudgingOverseer,
    handleNudgeOverseer,
    nudgeDisabledReason,
    showStopOverseer,
    isStoppingOverseer,
    handleStopOverseer,
    overseerExplainOpen,
    handleExplainOverseer,
    inlinePriority,
    isSavingInlinePriority,
    handleInlinePriorityChange,
    inlineExecutionMode,
    isSavingInlineExecutionMode,
    handleInlineExecutionModeToggle,
    t,
  ]);
  const reviewAction = taskActionMenuModel.reviewAction;

  const closeActivityViewMenuAndFocusTrigger = useCallback(() => {
    activityViewMenuViewportGuardUntilRef.current = 0;
    setShowActivityViewMenu(false);
    setActivityViewMenuPosition(null);
    activityViewButtonRef.current?.focus();
  }, []);

  const markActivityViewMenuOpening = useCallback(() => {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    activityViewMenuViewportGuardUntilRef.current = now + ACTIVITY_VIEW_MENU_OPEN_VIEWPORT_GUARD_MS;
  }, []);

  /*
    FNXC:TaskDetailActivity 2026-07-01-12:20:
    The Activity view menu is `position: fixed` and portaled to <body>, so it is anchored to the LAYOUT viewport, and `getBoundingClientRect()` returns layout-viewport-relative coordinates that a fixed element consumes directly.
    Position it purely from the layout viewport (`document.documentElement.clientWidth/clientHeight`) and never mix in `window.visualViewport` width/height/offset: under pinch-zoom or an open mobile keyboard the visual viewport diverges from the layout viewport (smaller width, nonzero offsetLeft/Top), and combining a shrunken visual-viewport width with a layout-viewport `getBoundingClientRect()` clamped `left` far off the trigger, so the popup rendered detached to the left of the modal instead of under the "Activity" tab.

    FNXC:TaskDetailActivity 2026-07-04-18:37:
    The menu is root-portaled so it can escape `.detail-tabs` and `.floating-window__body` clipping, but that means it must actively follow a dragged/resized task-detail popup. Recompute from the live Activity trigger rect after FloatingWindow geometry commits and pointer movement, keeping the menu above and attached to its owning modal instead of behind or detached on a stale fixed coordinate.
  */
  const updateActivityViewMenuPosition = useCallback(() => {
    const trigger = activityViewButtonRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const docEl = document.documentElement;
    const viewportWidth = docEl?.clientWidth || window.innerWidth;
    const viewportHeight = docEl?.clientHeight || window.innerHeight;
    const horizontalPadding = ACTIVITY_VIEW_MENU_VIEWPORT_PADDING;
    const verticalPadding = ACTIVITY_VIEW_MENU_VIEWPORT_PADDING;
    const gap = ACTIVITY_VIEW_MENU_TRIGGER_GAP;
    const preferredWidth = Math.max(rect.width, ACTIVITY_VIEW_MENU_MIN_WIDTH);
    const width = Math.min(preferredWidth, Math.max(viewportWidth - horizontalPadding * 2, ACTIVITY_VIEW_MENU_MIN_WIDTH));
    const spaceBelow = viewportHeight - rect.bottom;
    const spaceAbove = rect.top;
    const availableBelow = Math.max(spaceBelow - verticalPadding - gap, ACTIVITY_VIEW_MENU_MIN_HEIGHT);
    const availableAbove = Math.max(spaceAbove - verticalPadding - gap, ACTIVITY_VIEW_MENU_MIN_HEIGHT);
    const openUpward = spaceBelow < ACTIVITY_VIEW_MENU_MIN_HEIGHT && spaceAbove > spaceBelow;
    const maxHeight = Math.max(
      Math.min(openUpward ? availableAbove : availableBelow, ACTIVITY_VIEW_MENU_MAX_HEIGHT),
      ACTIVITY_VIEW_MENU_MIN_HEIGHT,
    );
    // Anchor the menu's left edge under the trigger, shifting left only enough to stay on-screen, and never past the left padding.
    const left = Math.max(
      horizontalPadding,
      Math.min(rect.left, viewportWidth - horizontalPadding - width),
    );
    const top = openUpward
      ? Math.max(verticalPadding, rect.top - maxHeight - gap)
      : Math.min(rect.bottom + gap, viewportHeight - verticalPadding - maxHeight);

    setActivityViewMenuPosition((current) => {
      if (current?.top === top && current.left === left && current.minWidth === width && current.maxHeight === maxHeight) {
        return current;
      }
      return { top, left, minWidth: width, maxHeight };
    });
  }, []);

  /*
  FNXC:PlannerOversight 2026-07-04-19:00:
  FN-7571 moves the FN-7519 Intervention Timeline out of the inline oversight
  cluster and into the Activity view dropdown as a fourth `interventions`
  segment, alongside Live/Feed/Raw. It is gated on the SAME oversight-active
  expression the inline mount used to use (`hasTaskOversightOverride ||
  workflowOversightResolved`, minus `oversightIsOff`) so the option never
  appears — and never leaves an always-empty segment — when oversight is off
  or unresolved for the task.
  */
  const oversightActive = (hasTaskOversightOverride || workflowOversightResolved) && !oversightIsOff;

  const activityViewOptions = useMemo<Array<{ value: ActivitySegment; label: string }>>(() => [
    { value: "current", label: t("taskDetail.activity.current", "Live") },
    { value: "feed", label: t("taskDetail.activity.feed", "Feed") },
    { value: "raw-logs", label: t("taskDetail.activity.raw", "Raw") },
    ...(oversightActive ? [{ value: "interventions" as const, label: t("taskDetail.activity.interventions", "Interventions") }] : []),
  ], [t, oversightActive]);
  const selectedActivityViewLabel = activityViewOptions.find((option) => option.value === activitySegment)?.label ?? activityViewOptions[0]?.label ?? "Live";

  // FNXC:PlannerOversight 2026-07-04-19:00: if oversight turns off (or was never active) while
  // the Interventions segment is selected, fall back to Live so a hidden dropdown option never
  // leaves a blank/selected segment behind.
  useEffect(() => {
    if (!oversightActive && activitySegment === "interventions") {
      setActivitySegment("current");
    }
  }, [oversightActive, activitySegment]);

  /*
  FNXC:TaskActivityFeedFreshness 2026-08-28-00:13:
  A Feed resync shares an initial slim-task detail request without invalidating its loading settlement.
  Later reads are deduplicated by requestTaskDetail and still fence against the current task generation.

  FNXC:TaskActivityFeedFreshness 2026-08-28-00:42:
  FN-205 must not lose an activity append that arrives while the shared initial detail request is in
  flight. Mark that request dirty and issue one follow-up authoritative read after it settles; asking
  requestTaskDetail during the flight would only receive the stale shared promise again.
  */
  const resyncActivityFeed = useCallback((reason: string) => {
    void reason;
    const requestKey = `${projectId ?? ""}:${task.id}`;
    const activeRequest = activityFeedResyncRequestRef.current;
    if (activeRequest?.key === requestKey) {
      activeRequest.needsFollowUp = true;
      return;
    }

    const requestGeneration = detailRequestGenerationRef.current;
    const issuedPromptSequence = promptEvidenceSequenceRef.current;
    const promise = requestTaskDetail(task.id, projectId);
    const request = { key: requestKey, needsFollowUp: false };
    activityFeedResyncRequestRef.current = request;
    void promise
      .then((detail) => {
        if (!mountedRef.current
          || detailRequestGenerationRef.current !== requestGeneration
          || activeTaskIdRef.current !== detail.id) return;

        adoptAuthoritativeDetail(detail, {issuedPromptSequence, promptAuthority: false});
      })
      .catch(() => undefined)
      .finally(() => {
        if (activityFeedResyncRequestRef.current !== request) return;
        activityFeedResyncRequestRef.current = null;
        if (!request.needsFollowUp
          || !mountedRef.current
          || activeTaskIdRef.current !== task.id) return;
        resyncActivityFeed("task-updated-during-refresh");
      });
  }, [task.id, projectId, requestTaskDetail, adoptAuthoritativeDetail]);

  /*
  FNXC:TaskActivityFeedFreshness 2026-08-28-00:13:
  FN-205 requires Feed to read authoritative activity on becoming visible, after each update for its
  task while visible, and after an SSE reconnect. The journal is stripped from stream payloads, so this
  coalesced detail read is the only live source for appended entries. Do not poll while the Feed is
  hidden or its kept-alive host is inactive (FNXC:TaskPopupViewGating); reveal immediately resyncs it.
  */
  useEffect(() => {
    if (!active || activeTab !== "chat" || activitySegment !== "feed") return;

    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const scheduleResync = () => {
      if (activityFeedResyncTimerRef.current !== null) {
        window.clearTimeout(activityFeedResyncTimerRef.current);
      }
      activityFeedResyncTimerRef.current = window.setTimeout(() => {
        activityFeedResyncTimerRef.current = null;
        resyncActivityFeed("task-updated");
      }, TASK_FEED_RESYNC_DEBOUNCE_MS);
    };
    const handleTaskUpdated = (event: MessageEvent) => {
      try {
        const updatedTask = JSON.parse(event.data) as { id?: unknown };
        if (!isForeignTaskEvent(readTaskEventProjectId(updatedTask), projectId) && updatedTask.id === task.id) scheduleResync();
      } catch {
        // FNXC:TaskActivityFeedFreshness 2026-08-28-00:13: Ignore malformed stream payloads; the next authoritative resync remains available.
      }
    };
    const handleReconnect = () => {
      recordResumeEvent({
        view: "taskActivityFeed",
        trigger: "sse-reconnect",
        projectId,
        replayAttempted: false,
        reason: "sse-reconnect",
      });
      resyncActivityFeed("sse-reconnect");
    };

    recordResumeEvent({
      view: "taskActivityFeed",
      trigger: "route-active",
      projectId,
      replayAttempted: false,
      reason: "segment-visible",
    });
    resyncActivityFeed("segment-visible");
    const unsubscribe = subscribeSse(`/api/events${query}`, {
      onReconnect: handleReconnect,
      events: { "task:updated": handleTaskUpdated },
    });

    return () => {
      if (activityFeedResyncTimerRef.current !== null) {
        window.clearTimeout(activityFeedResyncTimerRef.current);
        activityFeedResyncTimerRef.current = null;
      }
      unsubscribe();
    };
  }, [active, activeTab, activitySegment, projectId, resyncActivityFeed, task.id]);

  const selectActivityView = useCallback((value: ActivitySegment) => {
    activityViewMenuViewportGuardUntilRef.current = 0;
    setActiveTab("chat");
    setActivitySegment(value);
    setShowActivityViewMenu(false);
    setActivityViewMenuPosition(null);
    requestAnimationFrame(() => activityViewButtonRef.current?.focus());
  }, []);

  const handleActivityTabKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    const shouldOpenMenu = event.key === "ArrowDown" || (event.altKey && event.key === "ArrowDown");
    if (!shouldOpenMenu) {
      return;
    }

    event.preventDefault();
    markActivityViewMenuOpening();
    setActiveTab("chat");
    setShowActivityViewMenu(true);
  }, [markActivityViewMenuOpening]);

  const handleActivityViewMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    closeActivityViewMenuAndFocusTrigger();
  }, [closeActivityViewMenuAndFocusTrigger]);

  useLayoutEffect(() => {
    if (!showActivityViewMenu) {
      setActivityViewMenuPosition(null);
      return;
    }

    updateActivityViewMenuPosition();
  }, [showActivityViewMenu, updateActivityViewMenuPosition]);

  useEffect(() => {
    if (!showActivityViewMenu) {
      return;
    }

    const closeForViewportChange = () => {
      activityViewMenuViewportGuardUntilRef.current = 0;
      setShowActivityViewMenu(false);
      setActivityViewMenuPosition(null);
    };

    /*
      FNXC:TaskDetailActivity 2026-07-03-18:00:
      Mobile iOS can emit visualViewport scroll/resize as part of the same tap sequence that opens the root-portaled Activity menu. Ignore only that short opening echo and keep the layout-viewport position fresh; later viewport, orientation, outside, Escape, task-change, and selection closes still clean up the menu.

      FNXC:TaskDetailActivity 2026-07-04-19:10:
      FN-7536: this recurred on Android/mobile Chrome because the window `resize`/`orientationchange`/`scroll` (capture) close path below had NO opening-guard, unlike visualViewport's. Tapping the Activity tab can itself trigger a same-gesture window `scroll` or `resize` echo (browser auto-scrolling the tapped element into view, URL-bar collapse, or IME/keyboard show), which closed the menu the instant it opened. Route ALL of resize/orientationchange/scroll through the SAME opening-viewport-guard as visualViewport so a same-gesture echo only repositions, while a later, real, viewport change still closes it.
    */
    const handleGuardedViewportChange = () => {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (now <= activityViewMenuViewportGuardUntilRef.current) {
        updateActivityViewMenuPosition();
        return;
      }
      closeForViewportChange();
    };

    /*
      FNXC:TaskDetailActivity 2026-07-04-19:10:
      `.detail-tabs` is an intentional horizontal overflow scroller (FN-6xx tab strip), so scrolling it — including a mobile drag that brings the Activity tab into view — is benign, expected interaction, NOT a "true viewport change" that should close the menu. The window `scroll` listener uses capture so it also observes this nested scroller's scroll events; reposition-only (never close) when the scroll originated inside `.detail-tabs`.
    */
    const handleScrollChange = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && activityViewDropdownRef.current?.closest(".detail-tabs")?.contains(target)) {
        updateActivityViewMenuPosition();
        return;
      }
      handleGuardedViewportChange();
    };

    let positionFrame = 0;
    const schedulePositionUpdate = () => {
      if (positionFrame) return;
      positionFrame = requestAnimationFrame(() => {
        positionFrame = 0;
        updateActivityViewMenuPosition();
      });
    };

    window.addEventListener("resize", handleGuardedViewportChange);
    window.addEventListener("orientationchange", handleGuardedViewportChange);
    window.addEventListener("scroll", handleScrollChange, true);
    window.addEventListener(FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT, schedulePositionUpdate);
    document.addEventListener("pointermove", schedulePositionUpdate, true);
    document.addEventListener("pointerup", schedulePositionUpdate, true);
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", handleGuardedViewportChange);
    visualViewport?.addEventListener("scroll", handleGuardedViewportChange);

    return () => {
      if (positionFrame) cancelAnimationFrame(positionFrame);
      window.removeEventListener("resize", handleGuardedViewportChange);
      window.removeEventListener("orientationchange", handleGuardedViewportChange);
      window.removeEventListener("scroll", handleScrollChange, true);
      window.removeEventListener(FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT, schedulePositionUpdate);
      document.removeEventListener("pointermove", schedulePositionUpdate, true);
      document.removeEventListener("pointerup", schedulePositionUpdate, true);
      visualViewport?.removeEventListener("resize", handleGuardedViewportChange);
      visualViewport?.removeEventListener("scroll", handleGuardedViewportChange);
    };
  }, [showActivityViewMenu, updateActivityViewMenuPosition]);

  useEffect(() => {
    activityViewMenuViewportGuardUntilRef.current = 0;
    setShowActivityViewMenu(false);
    setActivityViewMenuPosition(null);
  }, [task.id]);

  useEffect(() => {
    if (!showActivityViewMenu || !activityViewMenuPosition) {
      return;
    }

    const selectedMenuItem = activityViewMenuRef.current?.querySelector<HTMLButtonElement>(".activity-view-menu-item[aria-current='true']");
    const firstMenuItem = activityViewMenuRef.current?.querySelector<HTMLButtonElement>(".activity-view-menu-item");
    (selectedMenuItem ?? firstMenuItem)?.focus();
  }, [showActivityViewMenu, activityViewMenuPosition]);

  const renderActivityViewMenu = () => {
    if (!showActivityViewMenu || !activityViewMenuPosition || typeof document === "undefined") {
      return null;
    }

    return createPortal(
      <div
        ref={activityViewMenuRef}
        className="activity-view-menu"
        role="menu"
        aria-label={t("taskDetail.activity.menuLabel", "Activity views")}
        onKeyDown={handleActivityViewMenuKeyDown}
        style={{
          top: activityViewMenuPosition.top,
          left: activityViewMenuPosition.left,
          minWidth: activityViewMenuPosition.minWidth,
          maxHeight: activityViewMenuPosition.maxHeight,
        }}
      >
        {activityViewOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            className="activity-view-menu-item"
            role="menuitem"
            aria-current={activitySegment === option.value ? "true" : undefined}
            onClick={() => selectActivityView(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>,
      document.body,
    );
  };

  const renderActivityTab = () => (
    <div className="detail-tab-dropdown" ref={activityViewDropdownRef}>
      {/*
        FNXC:TaskDetailActivity 2026-06-30-23:59:
        The top-level Activity tab is the only Activity view dropdown trigger. Keep the stable internal `chat` tab id and `current`/`feed`/`raw-logs` segment ids, but remove the in-panel Activity view select so desktop, embedded, and mobile tab strips have one canonical view switcher.

        FNXC:TaskDetailActivity 2026-07-01-00:00:
        Mobile task-detail tabs intentionally overflow-scroll horizontally, so the Activity view menu must be root-portaled and viewport-positioned instead of rendered inside `.detail-tabs` where overflow clipping can blank adjacent tabs and content.
      */}
      <button
        ref={activityViewButtonRef}
        type="button"
        className={`detail-tab detail-tab--activity${activeTab === "chat" ? " detail-tab-active" : ""}`}
        onClick={() => {
          const shouldOpen = !showActivityViewMenu;
          /*
          FNXC:TaskDetailActivity 2026-08-28-23:05:
          The former Workflow-mount carve-out only protected the removed Activity → Summaries fetch gate. Summary now owns that gate, so Activity may always become active when its selector opens.
          */
          setActiveTab("chat");
          if (shouldOpen) {
            markActivityViewMenuOpening();
          } else {
            activityViewMenuViewportGuardUntilRef.current = 0;
            setActivityViewMenuPosition(null);
          }
          setShowActivityViewMenu(shouldOpen);
        }}
        onKeyDown={handleActivityTabKeyDown}
        aria-haspopup="menu"
        aria-expanded={showActivityViewMenu}
        aria-label={t("taskDetail.tabs.activity", "Activity")}
        title={t("taskDetail.activity.tabDropdownLabel", "Activity view: {{view}}", { view: selectedActivityViewLabel })}
      >
        <span>{t("taskDetail.tabs.activity", "Activity")}</span>
        <ChevronDown className="detail-tab-chevron" aria-hidden="true" />
      </button>
      {renderActivityViewMenu()}
    </div>
  );

  /*
  FNXC:TaskDetailMeta 2026-09-05-23:27:
  Provenance, undo and PR context, timestamps, and workflow identity belong at the top of Details instead of occupying permanent space above every task tab. Preserve the existing nodes and conditions as one metadata section so modal and embedded hosts expose the same information without duplicate header chrome.
  */
  const renderTaskMetadata = () => (
    <div className="detail-section detail-section--task-metadata">
                {provenanceDisplay && (
                  <div className="detail-provenance">
                    <GitBranch aria-hidden="true" />
                    <span>
                      {workingTask.sourceType === "agent_heartbeat" ? (
                        <>
                          {t("taskDetail.provenance.createdBy", "Created by")}{" "}
                          {provenanceDisplay.sourceAgentId ? (
                            <button
                              type="button"
                              className="detail-provenance-link"
                              onClick={() => setSelectedSourceAgentId(provenanceDisplay.sourceAgentId!)}
                            >
                              {provenanceDisplay.label}
                            </button>
                          ) : (
                            provenanceDisplay.label
                          )}
                        </>
                      ) : (
                        <>
                          {t("taskDetail.provenance.createdVia", "Created via")} {provenanceDisplay.labelHref ? (
                            <a
                              className="detail-provenance-link"
                              href={provenanceDisplay.labelHref}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {provenanceDisplay.label}
                            </a>
                          ) : (
                            provenanceDisplay.label
                          )}
                        </>
                      )}
                      {provenanceDisplay.parentTaskId && (
                        <>
                          {" "}{t("taskDetail.provenance.parentTaskOf", "of")}{" "}
                          <button
                            type="button"
                            className="detail-provenance-link"
                            onClick={() => handleDepClick(provenanceDisplay.parentTaskId!)}
                          >
                            {provenanceDisplay.parentTaskId}
                          </button>
                        </>
                      )}
                      {provenanceDisplay.contextInfo ? (
                        <>
                          {" ("}
                          {provenanceDisplay.contextHref ? (
                            <a
                              className="detail-provenance-link detail-provenance-context"
                              href={provenanceDisplay.contextHref}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={provenanceDisplay.contextInfoFull}
                            >
                              {provenanceDisplay.contextInfo}
                            </a>
                          ) : (
                            <span className="detail-provenance-context" title={provenanceDisplay.contextInfoFull}>
                              {provenanceDisplay.contextInfo}
                            </span>
                          )}
                          {")"}
                        </>
                      ) : (
                        ""
                      )}
                    </span>
                  </div>
                )}
                {revertOfId && (
                  <div className="detail-provenance detail-revert-of-row">
                    <GitBranch aria-hidden="true" />
                    <span>
                      {t("taskDetail.provenance.createdToUndo", "Created to undo")}{" "}
                      <button
                        type="button"
                        className="detail-provenance-link"
                        onClick={() => handleDepClick(revertOfId)}
                      >
                        {revertOfId}
                      </button>
                    </span>
                  </div>
                )}
                {openUndoTask && (
                  <div className="detail-provenance detail-undo-task-row">
                    <GitBranch aria-hidden="true" />
                    <span>
                      {t("taskDetail.provenance.undoTask", "Undo task")}:{" "}
                      <button
                        type="button"
                        className="detail-provenance-link"
                        onClick={() => handleDepClick(openUndoTask.id)}
                      >
                        {openUndoTask.id}
                      </button>
                    </span>
                  </div>
                )}
                {(task.prInfo?.number || task.mergeDetails?.prNumber) && (
                  <div className="detail-provenance detail-pr-link-row">
                    <GitBranch aria-hidden="true" />
                    <span>
                      {t("taskDetail.pr.label", "PR")} {" "}
                      {task.prInfo?.url ? (
                        <a
                          className="detail-provenance-link"
                          href={task.prInfo.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          #{task.prInfo.number}
                        </a>
                      ) : (
                        <span>#{task.prInfo?.number ?? task.mergeDetails?.prNumber}</span>
                      )}
                    </span>
                  </div>
                )}
                <div className="detail-timestamps" aria-label={t("taskDetail.timestamps.ariaLabel", "Task timestamps")}>
                  <span className="detail-timestamp-item">
                    <span className="detail-timestamp-label">{t("taskDetail.timestamps.created", "Created")}</span>{" "}
                    <time dateTime={task.createdAt} title={new Date(task.createdAt).toLocaleString()}>
                      {formatTimestamp(task.createdAt)}
                    </time>
                  </span>
                  <span className="detail-timestamp-separator" aria-hidden="true">
                    ·
                  </span>
                  <span className="detail-timestamp-item">
                    <span className="detail-timestamp-label">{t("taskDetail.timestamps.updated", "Updated")}</span>{" "}
                    <time dateTime={task.updatedAt} title={new Date(task.updatedAt).toLocaleString()}>
                      {formatTimestamp(task.updatedAt)}
                    </time>
                  </span>
                  {taskWorkflowBadge && (
                    <span className="detail-workflow-badge" data-testid="task-detail-workflow-badge">
                      <WorkflowIcon workflowId={taskWorkflowBadge.id} icon={taskWorkflowBadge.icon} decorative />
                      <span>{taskWorkflowBadge.name}</span>
                    </span>
                  )}
                </div>
    </div>
  );

  const renderAttachmentsSection = () => (
    <div className="detail-section">
      <h4>{t("taskDetail.attachments.heading", "Attachments")}</h4>
      {attachments.length > 0 ? (
        <div className="detail-attachments-grid">
          {attachments.map((attachment) => {
            const attachmentUrl = appendTokenQuery(`/api/tasks/${task.id}/attachments/${attachment.filename}`);
            return (
              <div key={attachment.filename} className="detail-attachment-card">
                <a
                  className="detail-attachment-link"
                  href={attachmentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <img
                    src={attachmentUrl}
                    alt={attachment.originalName}
                    className="detail-attachment-image"
                  />
                </a>
                <div className="detail-attachment-meta">
                  {attachment.originalName} ({formatBytes(attachment.size)})
                </div>
                <button
                  className="detail-attachment-delete"
                  onClick={() => handleDeleteAttachment(attachment.filename)}
                  title={t("taskDetail.attachments.deleteTitle", "Delete attachment")}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="detail-empty-inline">{t("taskDetail.attachments.none", "(no attachments)")}</div>
      )}
      <button
        className="btn btn-sm"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
      >
        {uploading ? t("taskDetail.attachments.uploading", "Uploading…") : t("taskDetail.attachments.attachBtn", "Attach Screenshot")}
      </button>
    </div>
  );

  const renderDebugDetails = () => (
    <>
      {workingTask.ageStaleness && (() => {
        const copy = getTaskAgeStalenessCopy(workingTask.ageStaleness);
        if (!copy) return null;
        return (
          <div className="detail-section">
            <div className="detail-sidebar-title">{t("taskDetail.ageStaleness.title", "Task age staleness")}</div>
            <div>{copy.headline}</div>
            <div className="detail-description">{copy.description}</div>
            <div className="detail-in-review-stall-meta">
              <span>{t("taskDetail.ageStaleness.column", "Column")} {workingTask.ageStaleness.column}</span>
              <span>{t("taskDetail.ageStaleness.age", "Age")} {formatDurationCompact(workingTask.ageStaleness.ageMs)}</span>
              <span>{t("taskDetail.ageStaleness.warning", "Warning")} {formatDurationCompact(workingTask.ageStaleness.warningThresholdMs)}</span>
              <span>{t("taskDetail.ageStaleness.critical", "Critical")} {formatDurationCompact(workingTask.ageStaleness.criticalThresholdMs)}</span>
              <span>{t("taskDetail.ageStaleness.observed", "Observed")} {formatTimestamp(workingTask.ageStaleness.observedAt)}</span>
              <span>{workingTask.ageStaleness.paused ? t("taskDetail.ageStaleness.paused", "Paused") : t("taskDetail.ageStaleness.active", "Active")}</span>
            </div>
          </div>
        );
      })()}
      {specLock && (
        <section className="detail-section spec-lock-report" data-testid="spec-lock-report" aria-label={t("taskDetail.specLock.alignmentLabel", "Spec lock alignment")}>
          <div className="detail-source-header">
            <div className="detail-source-summary">
              <span className="detail-source-label">{t("taskDetail.specLock.alignment", "Spec alignment")}</span>
              <span className="badge">{specLock.report?.alignment ?? "unavailable"}</span>
            </div>
          </div>
          <dl className="detail-source-grid">
            <div><dt>{t("taskDetail.specLock.latestLock", "Latest lock")}</dt><dd>v{specLock.latestLock?.version ?? "—"}</dd></div>
            <div><dt>{t("taskDetail.specLock.currentPlan", "Current plan")}</dt><dd>v{specLock.currentPlan?.version ?? "—"}</dd></div>
            <div><dt>{t("taskDetail.specLock.lockState", "Lock state")}</dt><dd>{specLock.activeLock ? "active" : "inactive"}</dd></div>
            <div><dt>{t("taskDetail.specLock.findings", "Findings")}</dt><dd>{specLock.report?.findings.length ?? 0}</dd></div>
          </dl>
          {specLock.latestLock && (
            <p className="spec-lock-provenance">
              {t("taskDetail.specLock.accepted", "Accepted {{acceptedAt}} · plan hash {{planHash}} · approval {{approval}}", { acceptedAt: specLock.latestLock.acceptedAt, planHash: specLock.latestLock.currentPlanHash, approval: specLock.latestLock.approvalFingerprint })}
            </p>
          )}
          {specLock.currentPlan && (
            <p className="spec-lock-provenance">
              {t("taskDetail.specLock.captured", "Captured {{capturedAt}} · source revision {{sourceRevision}} · source hash {{sourceHash}}", { capturedAt: specLock.currentPlan.capturedAt, sourceRevision: specLock.currentPlan.sourceRevision, sourceHash: specLock.currentPlan.sourceHash })}
            </p>
          )}
          {specLock.latestLock?.diff?.changedSections.length ? (
            <p className="spec-lock-provenance">{t("taskDetail.specLock.relockChanged", "Re-lock changed: {{sections}}", { sections: specLock.latestLock.diff.changedSections.join(", ") })}</p>
          ) : null}
          {(specLock.history?.locks.length ?? 0) > 1 || (specLock.history?.currentPlans.length ?? 0) > 1 || (specLock.history?.reports.length ?? 0) > 1 ? (
            <p className="spec-lock-provenance">
              {t("taskDetail.specLock.retainedHistory", "Retained history: {{locks}}; {{plans}}; {{reports}} reports", { locks: specLock.history.locks.map((lock) => `lock v${lock.version}`).join(", ") || "no locks", plans: specLock.history.currentPlans.map((plan) => `plan v${plan.version}`).join(", ") || "no plan evidence", reports: specLock.history.reports.length })}
            </p>
          ) : null}
          {specLock.report?.findings.length ? (
            <ul className="spec-lock-findings">
              {specLock.report.findings.map((finding, index) => (
                <li key={`${finding.kind}:${finding.category}:${finding.path ?? index}`}>
                  {finding.kind}: {finding.category}{finding.path ? ` (${finding.path})` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      )}
      {!workingTask.ageStaleness && !specLock && (
        <div className="detail-empty-inline">{t("taskDetail.debug.none", "No debug details available.")}</div>
      )}
    </>
  );

  return (
    <div
      className={`task-detail-content${embedded ? " task-detail-content--embedded" : ""}${isActivityExpanded ? " task-detail-content--chat-expanded" : ""}${isPlannerChatExpanded ? " task-detail-content--planner-chat-expanded" : ""}`}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="modal-header">
          <div className="detail-title-row">
            <span className="detail-id" id="task-detail-modal-title">{task.id}</span>
            {/*
            FNXC:WorkflowResolvedColumns 2026-07-27-15:35 (U10 / R8):
            The badge names the card's column in the card's OWN workflow vocabulary. `columnLabel`
            is the shared lifecycle translator keyed on legacy ids, so a workflow-declared column
            it does not know fell through to the raw stored id ("staging") beside properly named
            lanes elsewhere in the UI. Prefer the workflow's declared column name; keep
            `columnLabel` for the column a workflow does not declare and for the window before the
            board-workflows payload resolves.
            */}
            {/*
            FNXC:TaskDetailStateStability 2026-08-05-02:55:
            The header is the lifecycle presentation users watch during scheduler activity. Render the
            timestamp-reconciled working snapshot, never the raw prop, so a late Todo board/detail
            payload cannot flash over a newer queued dependency or file-overlap state.
            */}
            <span className={`detail-column-badge badge-${workingTask.column}`}>
              {workflowColumnDisplayName ?? columnLabel(workingTask.column)}
            </span>
            {hasTaskStatusBadge(workingTask.status) && (
              <span className="card-status-badge" data-testid="task-detail-status-badge">
                {taskStatusBadgeLabel}
              </span>
            )}
          </div>
          <div className="modal-header-actions">
            {!isEditing && canEdit && (
              <button
                className="modal-edit-btn"
                onClick={enterEditMode}
                title={t("taskDetail.header.editTask", "Edit task")}
                aria-label={t("taskDetail.header.editTask", "Edit task")}
              >
                <Pencil size={14} />
              </button>
            )}
            {/*
            FNXC:FloatingWindow 2026-06-22-20:45 (updated 2026-06-22-18:32):
            "Pop out" affordance opens this task detail in a movable, resizable, non-blocking FloatingWindow. Header action order is edit, then expand/pop-out, then Back to board pinned far right so board-card detail controls read as edit/resize/navigation.
            */}
            {onPopOut && (
              <button
                type="button"
                className="modal-edit-btn"
                onClick={() => onPopOut(task)}
                title={t("taskDetail.header.popOut", "Pop out")}
                aria-label={t("taskDetail.header.popOut", "Pop out")}
                data-testid="task-detail-pop-out"
              >
                <Maximize2 size={14} />
              </button>
            )}
            {/*
            FNXC:TaskDetail 2026-06-22-18:40 (updated 2026-06-22-18:32):
            Board-card full-panel "Back to board" must be the far-right header action, after edit and expand/pop-out. margin-left:auto pushes it away from the utility controls while keeping it in the same gray header row. Only rendered when embedded AND onBackToBoard are supplied (board-card detail), never in ListView split-pane or modal usages.
            */}
            {embedded && onBackToBoard && (
              <button
                type="button"
                className="task-detail-header-back-btn"
                onClick={onBackToBoard}
              >
                <ArrowLeft size={14} aria-hidden="true" />
                <span>{t("app.taskDetail.backToBoard", "Back to board")}</span>
              </button>
            )}
            {embedded && onRequestClose && !onBackToBoard && (
              <button
                className="modal-close task-detail-floating-close"
                onClick={requestClose}
                aria-label={t("common.close", "Close")}
                type="button"
              >
                <X size={16} aria-hidden="true" />
              </button>
            )}
            {!embedded && mobileHeaderMode === "back" && (
              <button
                className="modal-close task-detail-mobile-back"
                onClick={requestClose}
                aria-label={t("taskDetail.header.backToList", "Back to task list")}
                type="button"
              >
                <ArrowLeft aria-hidden="true" />
                <span>{t("taskDetail.header.back", "Back")}</span>
              </button>
            )}
            {!embedded && mobileHeaderMode !== "back" && (
              <button className="modal-close" onClick={requestClose} aria-label={t("common.close", "Close")} type="button">
                &times;
              </button>
            )}
          </div>
        </div>
        <div className={`detail-body${activeTab === "chat" && activitySegment === "feed" && !isActivityExpanded && !isEditing ? " detail-body--feed" : ""}${activeTab === "chat" && activitySegment === "raw-logs" && !isEditing ? " detail-body--agent-log" : ""}${activeTab === "chat" && (activitySegment === "current" || isActivityExpanded) && !isEditing ? " detail-body--chat" : ""}${activeTab === "planner-chat" && !isEditing ? " detail-body--planner-chat" : ""}`}>
          <div className="detail-body-content">
          {isEditing ? (
            <div className="modal-edit-form">
              <TaskForm
                mode="edit"
                title={editTitle}
                onTitleChange={setEditTitle}
                description={editDescription}
                onDescriptionChange={setEditDescription}
                dependencies={editDependencies}
                onDependenciesChange={setEditDependencies}
                branch={editBranch}
                onBranchChange={setEditBranch}
                baseBranch={editBaseBranch}
                onBaseBranchChange={setEditBaseBranch}
                executorModel={editExecutorModel}
                onExecutorModelChange={(value) => { setEditCredentialInstanceId(undefined); setEditExecutorModel(value); }}
                credentialInstanceId={editCredentialInstanceId}
                onCredentialInstanceIdChange={(instanceId) => setEditCredentialInstanceId(instanceId || undefined)}
                validatorModel={editValidatorModel}
                onValidatorModelChange={(value) => { setEditValidatorCredentialInstanceId(undefined); setEditValidatorModel(value); }}
                validatorCredentialInstanceId={editValidatorCredentialInstanceId}
                onValidatorCredentialInstanceIdChange={(instanceId) => setEditValidatorCredentialInstanceId(instanceId || undefined)}
                planningModel={editPlanningModel}
                onPlanningModelChange={(value) => { setEditPlanningCredentialInstanceId(undefined); setEditPlanningModel(value); }}
                planningCredentialInstanceId={editPlanningCredentialInstanceId}
                onPlanningCredentialInstanceIdChange={(instanceId) => setEditPlanningCredentialInstanceId(instanceId || undefined)}
                thinkingLevel={editThinkingLevel}
                onThinkingLevelChange={setEditThinkingLevel}
                plannerOversightLevel={editPlannerOversightLevel}
                onPlannerOversightLevelChange={setEditPlannerOversightLevel}
                presetMode={editPresetMode}
                onPresetModeChange={setEditPresetMode}
                selectedPresetId={editSelectedPresetId}
                onSelectedPresetIdChange={setEditSelectedPresetId}
                optionalStepsWorkflowId={taskWorkflowBadge?.id}
                enabledWorkflowSteps={editSelectedWorkflowSteps}
                onEnabledWorkflowStepsChange={handleEditWorkflowStepsChange}
                pendingImages={editPendingImages}
                onImagesChange={setEditPendingImages}
                tasks={tasks.filter((t) => t.id !== task.id)}
                projectId={projectId}
                disabled={isSaving}
                addToast={addToast}
                isActive={isEditing}
                onAutoSaveDescription={handleAutoSaveDescription}
                reviewLevel={editReviewLevel}
                onReviewLevelChange={setEditReviewLevel}
                priority={editPriority}
                onPriorityChange={setEditPriority}
                nodeId={editNodeId}
                onNodeIdChange={setEditNodeId}
                nodeOptions={nodes}
                nodeOverrideDisabled={isNodeOverrideLocked}
                nodeOverrideDisabledReason={isNodeOverrideLocked ? t("taskDetail.edit.nodeOverrideLocked", "Execution node override is locked while a task is active/in progress.") : undefined}
                executionMode={editExecutionMode}
                onExecutionModeChange={setEditExecutionMode}
                renderBelowModelConfiguration={(
                  <div className="form-group detail-source-edit-group">
                    <label>{t("taskDetail.edit.sourceIssueLabel", "Source Issue")}</label>
                    <div className="detail-source-edit-grid">
                      <input
                        type="text"
                        className="modal-edit-input"
                        placeholder={t("taskDetail.edit.sourceProviderPlaceholder", "Provider (e.g. github)")}
                        value={editSourceIssueProvider}
                        onChange={(e) => setEditSourceIssueProvider(e.target.value)}
                        disabled={isSaving}
                        data-testid="task-source-provider-input"
                      />
                      <input
                        type="text"
                        className="modal-edit-input"
                        placeholder={t("taskDetail.edit.sourceRepositoryPlaceholder", "Repository (e.g. owner/repo)")}
                        value={editSourceIssueRepository}
                        onChange={(e) => setEditSourceIssueRepository(e.target.value)}
                        disabled={isSaving}
                        data-testid="task-source-repository-input"
                      />
                      <input
                        type="text"
                        className="modal-edit-input"
                        placeholder={t("taskDetail.edit.sourceExternalIdPlaceholder", "Issue identifier")}
                        value={editSourceIssueExternalId}
                        onChange={(e) => setEditSourceIssueExternalId(e.target.value)}
                        disabled={isSaving}
                        data-testid="task-source-external-id-input"
                      />
                      <input
                        type="url"
                        className="modal-edit-input"
                        placeholder={t("taskDetail.edit.sourceUrlPlaceholder", "Issue URL")}
                        value={editSourceIssueUrl}
                        onChange={(e) => setEditSourceIssueUrl(e.target.value)}
                        disabled={isSaving}
                        data-testid="task-source-url-input"
                      />
                    </div>
                    <small>{t("taskDetail.edit.sourceIssueHint", "Leave all fields empty to clear source issue metadata.")}</small>
                  </div>
                )}
              />
            </div>
          ) : (
            <>
              <>
                {/*
                FNXC:TaskDetail 2026-06-22-20:00:
                Summarize-as-title renders inline with the title inside .detail-heading-row and is positioned (CSS) to the far bottom-right as an in-field affordance, not a separate full-width row. Markup order is preserved; only layout changed.
                */}
                <div className="detail-heading-row">
                  {/*
                  FNXC:TaskDetailTitle 2026-08-04-18:00:
                  An overflowing task-detail title is its own sole expansion control. Keep the semantic button inside the h2 so pointer, touch, and keyboard activation share one accessible target; the separate Show more/Show less row must not return.
                  */}
                  <h2 className={`detail-title${descriptionExpanded ? "" : " detail-title--collapsed"}`}>
                    <span ref={titleRef} className="detail-title-measurement">
                      {displayTitleText}
                    </span>
                    {titleOverflows || descriptionExpanded ? (
                      <button
                        type="button"
                        className="detail-title-control"
                        aria-expanded={descriptionExpanded}
                        aria-label={descriptionExpanded
                          ? t("taskDetail.title.collapse", "Collapse task title")
                          : t("taskDetail.title.expand", "Expand task title")}
                        onClick={() => setDescriptionExpanded((expanded) => !expanded)}
                      />
                    ) : null}
                  </h2>
                  {showSummarizeTitleButton && (
                    <button
                      type="button"
                      className="detail-summarize-title-btn"
                      onClick={() => void handleSummarizeTitle()}
                      disabled={isSummarizingTitle || isSaving}
                      data-testid="summarize-title-btn"
                    >
                      {isSummarizingTitle ? <Loader2 size={14} className="spinner" /> : <Sparkles size={14} />}
                      <span>{t("taskDetail.title.summarize", "Summarize")}</span>
                    </button>
                  )}
                </div>
              </>
              {customFieldDefs && customFieldDefs.length > 0 ? (
                <TaskFieldsSection
                  fieldDefs={customFieldDefs}
                  customFields={customFieldValues}
                  onSave={handleSaveCustomFields}
                  error={customFieldError}
                />
              ) : null}
              {showNearDuplicateWarning && (
                <div className="detail-near-duplicate-banner" role="status" aria-live="polite">
                  <div className="detail-near-duplicate-banner__header">
                    <AlertTriangle aria-hidden="true" />
                    <span className="detail-near-duplicate-banner__headline">{t("taskDetail.nearDuplicate.headline", "Potential duplicate detected")}</span>
                  </div>
                  <p className="detail-near-duplicate-banner__copy">
                    {t("taskDetail.nearDuplicate.copy", "This task appears to be a near-duplicate of")}{" "}
                    <button
                      type="button"
                      className="detail-provenance-link"
                      onClick={() => {
                        if (nearDuplicateOf) {
                          handleDepClick(nearDuplicateOf);
                        }
                      }}
                    >
                      {nearDuplicateOf}
                    </button>
                    {". "}{t("taskDetail.nearDuplicate.actions", "Keep it to clear this flag, or delete it if the work is already covered.")}
                  </p>
                  <div className="detail-near-duplicate-banner__actions">
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => void handleDeleteNearDuplicate()}>
                      {t("taskDetail.nearDuplicate.deleteBtn", "Delete")}
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void handleDismissNearDuplicate()}>
                      {t("taskDetail.nearDuplicate.keepBtn", "Keep")}
                    </button>
                  </div>
                </div>
              )}
              {/*
              FNXC:PlanReviewReplan 2026-07-15-11:09:
              Always explain why this task is parked for plan approval before the operator
              clicks Approve/Reject. Replan-cap escalations get a stronger, distinct reason;
              ordinary require-all / workflow manual gates get a clear pre-execution gate note.
              */}
              {isAwaitingApproval && (
                <div
                  className={`detail-plan-approval-banner${isPlanReviewReplanCapApproval ? " detail-plan-approval-banner--replan-cap" : ""}`}
                  role="status"
                  aria-live="polite"
                  data-testid="detail-plan-approval-banner"
                  data-awaiting-approval-reason={task.awaitingApprovalReason ?? "manual"}
                >
                  <div className="detail-plan-approval-banner__header">
                    <Info aria-hidden="true" />
                    <span className="detail-plan-approval-banner__headline">
                      {isPlanReviewReplanCapApproval
                        ? t(
                            "taskDetail.plan.replanCapHeadline",
                            "Approval needed: Plan Review did not converge",
                          )
                        : t(
                            "taskDetail.plan.approvalHeadline",
                            "Approval needed before implementation",
                          )}
                    </span>
                  </div>
                  <p className="detail-plan-approval-banner__copy">
                    {isPlanReviewReplanCapApproval
                      ? t(
                          "taskDetail.plan.replanCapCopy",
                          "Plan Review requested automatic planning revisions repeatedly without approving a plan. Fusion stopped the replan loop so a human can decide. Approve the current PROMPT.md to move this task to Todo, or Reject Plan to discard it and regenerate.",
                        )
                      : t(
                          "taskDetail.plan.approvalCopy",
                          "This project's plan-approval settings require a human decision before work starts. Review the plan below, then Approve Plan to continue to Todo or Reject Plan to regenerate it.",
                        )}
                  </p>
                  {/*
                  FNXC:PlanApproval 2026-08-01-06:34:
                  Approval actions must sit beside the top approval message as well as in the persistent footer,
                  so an operator can act without scrolling through a long task body.
                  */}
                  {workingTask.prompt && (
                    <div className="detail-plan-approval-banner__actions" data-testid="detail-plan-approval-banner-actions">
                      <button className="btn btn-primary btn-sm" data-testid="detail-plan-approval-banner-approve" onClick={handleApprovePlan}>
                        {t("taskDetail.plan.approveBtn", "Approve Plan")}
                      </button>
                      <button className="btn btn-danger btn-sm" data-testid="detail-plan-approval-banner-reject" onClick={handleRejectPlan}>
                        {t("taskDetail.plan.rejectBtn", "Reject Plan")}
                      </button>
                    </div>
                  )}
                </div>
              )}
                {/*
                FNXC:TaskDetailAttachments 2026-07-17-12:30:
                FN-8232: keep the hidden file input mounted independently of activeTab.
                The paperclip renders on every non-editing tab while task details default
                to Activity or Summary; a Definition-only input made that control a no-op.
                */}
                <input
                  className="detail-hidden-file-input"
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleUpload}
                />
                {task.aiMergeReviewReconciliation && (() => {
                  const reconciliation = task.aiMergeReviewReconciliation;
                  const pending = reconciliation.findings.filter((finding) => finding.disposition === "pending" || finding.disposition === "still-present");
                  return (
                    <section className={`ai-merge-review-reconciliation ${reconciliation.terminal ? "ai-merge-review-reconciliation-terminal" : ""}`} aria-label={t("taskDetail.aiMergeReview.title", "AI merge review reconciliation")}>
                      <h3>{reconciliation.consecutiveCleanApprovals > 0 ? t("taskDetail.aiMergeReview.approvedWithPending", "Approved — {{count}} prior finding(s) unconfirmed", { count: pending.length }) : t("taskDetail.aiMergeReview.title", "AI merge review reconciliation")}</h3>
                      {reconciliation.candidateSha && <p>{t("taskDetail.aiMergeReview.candidate", "Candidate:")} <code>{reconciliation.candidateSha}</code></p>}
                      {pending.length > 0 && <ul>{pending.map((finding) => <li key={finding.id}>{finding.text}{(reconciliation.terminal || finding.disposition === "still-present") && <button type="button" className="btn btn-secondary" onClick={() => handleDismissAiMergeFinding(finding.id)}>{t("taskDetail.aiMergeReview.dismissFinding", "Dismiss this finding")}</button>}</li>)}</ul>}
                      {reconciliation.terminal && <p>{t("taskDetail.aiMergeReview.terminalGuidance", "Rebase or re-push the branch, dismiss a finding with justification, or land manually.")}</p>}
                    </section>
                  );
                })()}
              {/* FNXC:TaskVerificationStatus 2026-07-19-12:00: Verification status moved below metadata controls per UX feedback — empty state "No chat verification requested" was appearing too prominently near the top of the card. */}
              <TaskVerificationStatus request={verificationRequest} />
              {shouldShowBranchGroupCard && task.branchContext?.groupId && (
                /* FNXC:BranchGroupDetails 2026-06-30-00:00: Task-detail branch groups must return to their compact collapsed default when users switch tasks, including between members of the same shared branch group. Key by task and group so a manual expansion never leaks into the next task detail view. */
                <BranchGroupCard
                  key={`${task.id}:${task.branchContext.groupId}`}
                  groupId={task.branchContext.groupId}
                  taskId={task.id}
                  projectId={projectId}
                  onBranchGroupReset={handleBranchGroupReset}
                  onOpenReviewTask={handleOpenMemberReview}
                />
              )}
            </>
          )}
          <ExternalBlockNotice task={task as Task} variant="detail" onOpenChatWithPrefill={onOpenChatWithPrefill} onRetryTask={onRetryTask} addToast={addToast} />
          {shouldShowTaskFailureAlert && (
            <div className="detail-error-alert" role="alert">
              <span className="detail-error-icon">⚠</span>
              <div className="detail-error-content">
                <div className="detail-error-title">{t("taskDetail.error.taskFailed", "Task Failed")}</div>
                <div className="detail-error-message">{taskFailureReason}</div>
                {taskFailureToolDetail ? (
                  <div className="detail-error-detail">
                    {taskFailureToolDetail}
                  </div>
                ) : null}
                {taskFailureHint ? <div className="detail-error-hint">{taskFailureHint}</div> : null}
                {hasPendingRecovery ? <div className="detail-error-hint">{t("taskDetail.retry.pendingAutomaticRecovery", "Automatic recovery is pending. You can Retry now to restart this stage.")}</div> : null}
                {onRetryTask && isMutableLiveColumn ? (
                  <div className="detail-error-actions">
                    <button type="button" className="btn btn-sm" onClick={handleRetry}>
                      {t("taskDetail.error.retry", "Retry")}
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => setShowFailureRetryPicker(true)}>
                      {t("taskDetail.error.retryWithModel", "Retry with a different model/node")}
                    </button>
                  </div>
                ) : null}
                {showFailureRetryPicker && onRetryTask && isMutableLiveColumn ? (
                  <div className="detail-error-retry-picker">
                    <label htmlFor={`failure-retry-model-${task.id}`}>
                      {t("taskDetail.error.retryModelLabel", "Executor model")}
                    </label>
                    <select
                      id={`failure-retry-model-${task.id}`}
                      className="select"
                      value={failureRetryModel}
                      disabled={isFailureRetrySaving}
                      onChange={(event) => setFailureRetryModel(event.target.value)}
                    >
                      <option value="">{t("taskDetail.error.retryModelDefault", "Use project default")}</option>
                      {failureRetryModels.map((model) => (
                        <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
                          {model.provider}/{model.name || model.id}
                        </option>
                      ))}
                    </select>
                    <label htmlFor={`failure-retry-node-${task.id}`}>
                      {t("taskDetail.error.retryNodeLabel", "Execution node")}
                    </label>
                    <select
                      id={`failure-retry-node-${task.id}`}
                      className="select"
                      value={failureRetryNodeId}
                      disabled={isFailureRetrySaving}
                      onChange={(event) => setFailureRetryNodeId(event.target.value)}
                    >
                      <option value="">{t("taskDetail.error.retryNodeDefault", "Use project default")}</option>
                      {failureRetryNodes.map((node) => (
                        <option key={node.id} value={node.id}>{node.name} ({node.type})</option>
                      ))}
                    </select>
                    <div className="detail-error-actions">
                      <button type="button" className="btn btn-sm" onClick={() => setShowFailureRetryPicker(false)} disabled={isFailureRetrySaving}>
                        {t("common.cancel", "Cancel")}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void handleRetryWithOverride()}
                        disabled={isFailureRetrySaving || (failureRetryModel === (task.modelProvider && task.modelId ? `${task.modelProvider}/${task.modelId}` : "") && failureRetryNodeId === (task.nodeId ?? ""))}
                      >
                        {t("taskDetail.error.confirmRetry", "Apply and retry")}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          )}
          {task.pausedReason === "worktrunk_operation_failed" && (
            <div className="task-pause-reason" role="status" aria-live="polite">
              <div className="task-pause-reason-label">{t("taskDetail.pause.worktrunkFailed", "Worktrunk operation failed")}</div>
              {task.worktrunkFailure?.stderr && (
                <pre className="task-pause-stderr">{task.worktrunkFailure.stderr.slice(0, 2048)}</pre>
              )}
            </div>
          )}
          {!isEditing && (
            <>
          <div className="detail-tabs">
            {/*
              FNXC:TaskDetailActivityFirst 2026-06-30-23:59:
              Activity is first/default for omitted non-done task opens unless the project setting taskDetailChatFirst is true. Keep both stable ids (`chat` for Activity, `planner-chat` for Chat) so explicit deep links and plugin callers retain their destinations.
            */}
            {taskDetailChatFirst ? (
              <>
                <button
                  className={`detail-tab${activeTab === "planner-chat" ? " detail-tab-active" : ""}`}
                  onClick={() => setActiveTab("planner-chat")}
                >
                  {t("taskDetail.tabs.chat", "Chat")}
                </button>
                {renderActivityTab()}
              </>
            ) : (
              <>
                {renderActivityTab()}
                <button
                  className={`detail-tab${activeTab === "planner-chat" ? " detail-tab-active" : ""}`}
                  onClick={() => setActiveTab("planner-chat")}
                >
                  {t("taskDetail.tabs.chat", "Chat")}
                </button>
              </>
            )}
            <button
              className={`detail-tab${activeTab === "definition" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("definition")}
            >
              {t("taskDetail.tabs.definition", "Plan")}
            </button>
            {(isWipColumn || isReviewColumn || isDoneColumn) && (
              <button
                className={`detail-tab${activeTab === "changes" ? " detail-tab-active" : ""}`}
                onClick={() => setActiveTab("changes")}
              >
                {t("taskDetail.tabs.changes", "Changes")}
              </button>
            )}
            <button
              className={`detail-tab${activeTab === "summary" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("summary")}
            >
              {t("taskDetail.tabs.summary", "Summary")}
            </button>
            <button
              className={`detail-tab${activeTab === "stats" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("stats")}
            >
              {t("taskDetail.tabs.stats", "Stats")}
            </button>
            <button
              className={`detail-tab${activeTab === "review" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("review")}
            >
              {t("taskDetail.tabs.review", "Review")}
            </button>
            {isReviewColumn && (
              <button
                className={`detail-tab${activeTab === "pr" ? " detail-tab-active" : ""}`}
                onClick={() => setActiveTab("pr")}
              >
                {t("taskDetail.tabs.pullRequest", "Pull Request")}
              </button>
            )}
            <button
              className={`detail-tab${activeTab === "comments" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("comments")}
            >
              {t("taskDetail.tabs.comments", "Comments")}
            </button>
            <button className={`detail-tab${activeTab === "dependencies" ? " detail-tab-active" : ""}`} onClick={() => setActiveTab("dependencies")}>
              {t("taskDetail.tabs.dependencies", "Dependencies")}
            </button>
            <button
              className={`detail-tab${activeTab === "documents" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("documents")}
            >
              {/* FNXC:ArtifactRegistry 2026-06-21-21:56: Keep the internal "documents" tab id stable for persisted task-modal state while presenting the expanded user-facing tab as Artifacts. */}
              {t("taskDetail.tabs.documents", "Artifacts")}
            </button>
            <button
              className={`detail-tab${activeTab === "model" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("model")}
            >
              {t("taskDetail.tabs.model", "Model")}
            </button>
            <button
              className={`detail-tab${activeTab === "workflow" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("workflow")}
            >
              {t("taskDetail.tabs.workflow", "Workflow")}
            </button>
            {/*
            FNXC:TaskDetailTabs 2026-08-28-23:05:
            Definition is plan-only. Details owns original prompt, retries, source and agent metadata,
            tracking, no-commits, routing, and diagnostics; Artifacts owns registered artifacts and
            attachments; Summary owns agent reports and recommendations. Retired deep links resolve
            to those owners rather than restoring duplicate tab buttons.
            */}
            <button className={`detail-tab${activeTab === "details" ? " detail-tab-active" : ""}`} onClick={() => setActiveTab("details")}>
              {t("taskDetail.tabs.details", "Details")}
            </button>
            {showWorktreeTerminalTab && (
              <button
                className={`detail-tab${activeTab === "worktree-terminal" ? " detail-tab-active" : ""}`}
                onClick={() => setActiveTab("worktree-terminal")}
              >
                {t("taskDetail.tabs.worktreeTerminal", "Terminal")}
              </button>
            )}
            {showCliTab && (
              <button
                className={`detail-tab${activeTab === "terminal" ? " detail-tab-active" : ""}`}
                onClick={() => setActiveTab("terminal")}
              >
                {t("taskDetail.tabs.terminal", "Session")}
              </button>
            )}
            {/* Plugin tabs */}
            {pluginTabs.map(({ entry, tabId }) => {
              return (
                <button
                  key={`plugin-tab-${entry.pluginId}-${tabId}`}
                  className={`detail-tab${activeTab === tabId ? " detail-tab-active" : ""}`}
                  onClick={() => setActiveTab(tabId)}
                >
                  {entry.slot.label}
                </button>
              );
            })}
          </div>
          {activeTab === "workflow" ? (
            <div className="detail-section">
              <WorkflowResultsTab
                columnFlags={detailColumnFlags}
                taskId={task.id}
                task={task}
                results={workflowResults}
                loading={workflowResultsLoading}
                enabledWorkflowSteps={workflowEnabledSteps}
                canEdit={canEdit}
                projectId={projectId}
                isTaskInProgress={
                  isWipColumn
                  && !task.paused
                  && !task.userPaused
                  && task.status !== "paused"
                  && task.status !== "awaiting-user-input"
                  && task.status !== "awaiting-cli-approval"
                }
                onWorkflowStepsChange={handleWorkflowStepsChange}
                onWorkflowReconciled={handleWorkflowReconciled}
                taskStatus={task.status}
                taskPausedReason={task.pausedReason}
                settings={settings}
                agentLogEntries={agentLogEntries}
                assignedAgent={assignedAgent}
                onEditWorkflow={onOpenWorkflowEditor}
              />
            </div>
          ) : activeTab === "model" ? (
            <div className="detail-section">
              <ModelSelectorTab
                task={task}
                addToast={addToast}
                onTaskUpdated={onTaskUpdated}
                settings={settings}
                projectId={projectId}
              />
            </div>
          ) : activeTab === "summary" ? (
            <div className="detail-section detail-section--summary">
              <TaskSummaryTab task={workingTask} results={historyWorkflowResults} loading={workflowResultsLoading} />
              {hasRecommendations && (
                <section className="task-summary-section task-summary-section--recommendations">
                  <h3>{t("taskDetail.tabs.recommendations", "Recommendations")}</h3>
                  <TaskRecommendationsTab
                    task={workingTask}
                    projectId={projectId}
                    onTaskReconciled={(updatedTask) => {
                      /*
                      FNXC:TaskRecommendations 2026-08-08-05:27:
                      The create route returns the durable parent link update. Publish that exact snapshot
                      to the board owner and retained detail snapshot so modal, main-panel, list, and
                      floating hosts cannot retain a stale Create affordance while SSE catches up.
                      */
                      setFullDetail((previous) => previous?.id === updatedTask.id
                        ? mergeTaskSnapshot(previous, updatedTask, { fullSnapshot: true })
                        : previous);
                      onTaskUpdated?.(updatedTask);
                    }}
                  />
                </section>
              )}
              <MergeDetails task={workingTask} columnFlags={detailColumnFlags} />
            </div>
          ) : activeTab === "planner-chat" ? (
            /* FNXC:TaskDetailTabKeepAlive 2026-07-22-12:55: body renders from the kept-alive sibling below the ternary; null here prevents fall-through to Definition. */
            null
          ) : activeTab === "chat" ? (
            <div className={`detail-section detail-section--activity${activitySegment === "feed" && !isActivityExpanded ? " detail-section--feed" : ""}${activitySegment === "current" || isActivityExpanded ? " detail-section--chat" : ""}${activitySegment === "raw-logs" ? " detail-section--agent-log" : ""}`}>
              {/*
                FNXC:TaskDetailPlannerChat 2026-08-28-23:05:
                Activity owns steering/current view, Feed, raw agent logs, and Interventions inside one compact selector. The stable Activity tab id remains `chat`, legacy `logs` callers land on Feed, and Raw is the only selector option that enables raw agent-log fetching. Detailed stage reports belong only to Summary; planner-model conversation belongs to the separate `planner-chat` tab and must not route into steering comments.

                FNXC:TaskDetailActivity 2026-06-30-23:55:
                The first Activity segment is user-facing Live but keeps the legacy `current` segment id. Activity expansion is segment-wide, so the same reachable toggle must remain present on Live, Feed, and Raw without fetching Raw outside the Raw segment.

                FNXC:TaskDetailActivity 2026-06-30-23:59:
                The Activity tab in the top-level tab strip is now the view dropdown for Live, Feed, and Raw. The in-panel Activity view select was removed so Activity expansion remains the only Activity-level affordance inside the panel while legacy routing and Raw-only fetching keep their stable ids (`chat`, `current`, `feed`, `raw-logs`).

                FNXC:TaskDetailActivity 2026-07-01-00:00:
                Activity expansion must not reserve a standalone toolbar row. Live uses TaskChatTab's anchored overlay button, Feed renders the same Activity toggle over its feed panel, and Raw keeps AgentLogViewer's fullscreen control so only one Raw expand affordance is reachable.
              */}
              {activitySegment === "current" ? (
                <TaskChatTab
                  columnFlags={detailColumnFlags}
                  task={workingTask}
                  projectId={projectId}
                  active={active && activeTab === "chat" && activitySegment === "current"}
                  addToast={addToast}
                  sessionLive={isCliSessionLive(cliSession)}
                  onTaskUpdated={handleChatTaskUpdated}
                  onRefinementCreated={onRefinementCreated}
                  expanded={isActivityExpanded}
                  onToggleExpanded={() => setActivityExpanded((value) => !value)}
                  effectiveModels={{
                    triage: toTaskChatModelInfo(resolveEffectivePlanning(workingTask, agentLogEntries, settings)),
                    executor: toTaskChatModelInfo(resolveEffectiveExecutor(workingTask, agentLogEntries, assignedAgent, settings, detailColumnFlags)),
                    reviewer: toTaskChatModelInfo(resolveEffectiveValidator(workingTask, agentLogEntries, assignedAgent, settings, detailColumnFlags)),
                    merger: toTaskChatModelInfo(resolveEffectiveValidator(workingTask, agentLogEntries, assignedAgent, settings, detailColumnFlags)),
                  }}
                />
              ) : activitySegment === "raw-logs" ? (
                <AgentLogViewer
                  entries={agentLogEntries}
                  loading={agentLogLoading}
                  executorModel={resolveEffectiveExecutor(task, agentLogEntries, assignedAgent, settings, detailColumnFlags)}
                  validatorModel={resolveEffectiveValidator(task, agentLogEntries, assignedAgent, settings, detailColumnFlags)}
                  planningModel={resolveEffectivePlanning(task, agentLogEntries, settings)}
                  hasMore={agentLogHasMore}
                  onLoadMore={loadMoreAgentLogs}
                  loadingMore={agentLogLoadingMore}
                  totalCount={agentLogTotal}
                  showMissingDetailHint
                />
              ) : activitySegment === "interventions" ? (
                // FNXC:PlannerOversight 2026-07-04-19:00: FN-7571 relocates the FN-7519
                // Intervention Timeline from the inline oversight cluster into this
                // Activity segment. Reachable only via the dropdown, which already gates
                // on oversightActive, so no `hidden` prop is needed here.
                <div className="detail-activity detail-activity--interventions" role="tabpanel">
                  <PlannerInterventionTimeline taskId={task.id} projectId={projectId} />
                </div>
              ) : (
                <div className="detail-activity" role="tabpanel">
                  <div className="detail-activity-actions">
                    <button
                      type="button"
                      className="btn btn-sm detail-activity-copy"
                      onClick={() => void handleCopyActivityLogs()}
                      disabled={detailLoading || activityLog.length === 0}
                      aria-label={t("taskDetail.logs.copyDisplayed", "Copy displayed activity logs")}
                      title={t("taskDetail.logs.copyDisplayed", "Copy displayed activity logs")}
                      data-testid="task-activity-copy-logs"
                    >
                      <Copy aria-hidden="true" />
                      {t("taskDetail.logs.copy", "Copy logs")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-sm activity-expand-toggle activity-expand-toggle--overlay"
                      onClick={() => setActivityExpanded((value) => !value)}
                      aria-label={isActivityExpanded ? t("taskDetail.activity.collapse", "Collapse activity") : t("taskDetail.activity.expand", "Expand activity to full modal")}
                      aria-pressed={isActivityExpanded}
                      data-testid="task-chat-expand-toggle"
                    >
                      {isActivityExpanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
                    </button>
                  </div>
                  <h4>{t("taskDetail.activity.feedHeading", "Feed")}</h4>
                  {(workingTask as typeof workingTask & { activityLogTruncatedCount?: number }).activityLogTruncatedCount ? (
                    <div className="detail-log-truncated">
                      {t("taskDetail.logs.truncated", "Showing the most recent {{count}} activity entries.", { count: activityLog.length })}
                    </div>
                  ) : null}
                  {detailLoading ? (
                    <div className="detail-log-loading" role="status" aria-live="polite">
                      <Loader2 className="animate-spin" aria-hidden="true" />
                      <span>{t("taskDetail.logs.loadingActivity", "Loading activity…")}</span>
                    </div>
                  ) : activityLog.length > 0 ? (
                    <div className="detail-activity-list" ref={activityListRef}>
                      {(() => {
                        // FNXC:TaskDetail 2026-06-14-13:43 Activity rendering must tolerate legacy `text`/`detail` log entries.
                        let highlightedOnce = false;
                        return [...activityLog].reverse().map((entry, i) => {
                          const action = getTaskLogEntryAction(entry);
                          const outcome = getTaskLogEntryOutcome(entry);
                          const stallMatch = action.match(IN_REVIEW_STALL_LOG_REGEX)
                            ?? action.match(STALE_PAUSED_REVIEW_LOG_REGEX);
                          const isHighlighted = !highlightedOnce
                            && highlightStallCode != null
                            && stallMatch?.[1] === highlightStallCode;
                          if (isHighlighted) {
                            highlightedOnce = true;
                          }
                          return (
                            <div
                              key={i}
                              className={`detail-log-entry${isHighlighted ? " detail-log-entry--stall-highlight" : ""}`}
                              data-stall-highlight={isHighlighted ? "true" : undefined}
                            >
                              <div className="detail-log-header">
                                {/*
                                FNXC:PreciseTaskLogTimestamps 2026-09-01-01:03:
                                FN-272 keeps Feed's compact relative timestamp for scanability and adds the task action's precise local wall-clock time beside it.
                                This wrapper exists only at the activity-log render site, leaving task metadata timestamps on their established relative contract.
                                */}
                                <div className="detail-log-timestamps">
                                  <span className="detail-log-timestamp">
                                    {formatTimestamp(entry.timestamp)}
                                  </span>
                                  <PreciseTimestamp
                                    timestamp={entry.timestamp}
                                    className="detail-log-precise-timestamp"
                                    testId="task-activity-precise-timestamp"
                                  />
                                </div>
                                <span className="detail-log-action">{action}</span>
                              </div>
                              {outcome && (
                                <div className="detail-log-outcome">{outcome}</div>
                              )}
                            </div>
                          );
                        });
                      })()}
                    </div>
                  ) : (
                    <div className="detail-log-empty">{t("taskDetail.logs.noActivity", "(no activity)")}</div>
                  )}
                </div>
              )}
            </div>
          ) : activeTab === "changes" ? (
            <TaskChangesTab taskId={task.id} worktree={task.worktree} projectId={projectId} column={task.column} columnFlags={detailColumnFlags} mergeDetails={task.mergeDetails} modifiedFiles={task.modifiedFiles} isWorkspace={isWorkspaceTask(workingTask)} />
          ) : activeTab === "review" ? (
            <TaskReviewTab
              /*
              FNXC:WorkflowResolvedColumns 2026-07-30-11:10 (#2744 review — greptile P1):
              `detailColumnFlags`, NOT the raw payload. That local applies `detailFlagsAreForThisTask`
              (`workflowMoveMetadata?.taskId === task.id`), and on the render where the modal switches
              tasks the state still holds the PREVIOUS card's payload. Passing the raw flags would resolve
              the review tab's roles from another task's workflow — confidently wrong rather than merely
              stale, which is the exact reasoning already recorded where that local is defined. I passed
              the raw value and reviewed past the guard sitting six lines above my own conversion.
              */
              columnFlags={detailColumnFlags}
              task={task}
              addToast={addToast}
              projectId={projectId}
              onTaskUpdated={onTaskUpdated}
              prAuthAvailable={prAuthAvailable}
              autoMergeEnabled={autoMergeEnabled}
              onRequestCreatePr={() => setPrCreateOpen(true)}
            />
          ) : activeTab === "pr" ? (
            <div className="detail-section detail-pr-tab">
              {isReviewColumn && (
                <>
                  {shouldShowInReviewStallBadge(workingTask, detailColumnFlags) && workingTask.inReviewStall && (() => {
                    const copy = getInReviewStallCopy(workingTask.inReviewStall, {
                      mergeRetries: workingTask.mergeRetries,
                      maxAutoMergeRetries: MAX_AUTO_MERGE_RETRIES,
                    });
                    const logMatch = findInReviewStallLogEntry(workingTask, workingTask.inReviewStall.code);
                    return (
                      <div
                        className={`detail-section detail-in-review-stall detail-in-review-stall--${copy.code}`}
                        data-stall-code={copy.code}
                      >
                        <div className="detail-in-review-stall-header">
                          <span className="card-status-badge card-status-badge--in-review in-review-stall">
                            {copy.badgeLabel}{copy.counter ? ` ${copy.counter}` : ""}
                          </span>
                          <span className="detail-in-review-stall-headline">{copy.headline}</span>
                        </div>
                        <div className="detail-in-review-stall-reason">{workingTask.inReviewStall.reason}</div>
                        <div className="detail-in-review-stall-description">{copy.description}</div>
                        <div className="detail-in-review-stall-action">{copy.suggestedAction}</div>
                        <div className="detail-in-review-stall-meta">
                          <span>{t("taskDetail.stall.observed", "Observed")} {formatTimestamp(workingTask.inReviewStall.observedAt)}</span>
                          {logMatch ? (
                            <button
                              type="button"
                              className="btn btn-sm detail-in-review-stall-jump"
                              onClick={() => {
                                setActiveTab("chat");
                                setActivitySegment("feed");
                                setHighlightStallCode(workingTask.inReviewStall?.code ?? null);
                              }}
                            >
                              {t("taskDetail.stall.viewActivityLog", "View activity log")}
                            </button>
                          ) : (
                            <span
                              className="detail-in-review-stall-no-log"
                              title={t("taskDetail.stall.noLogEntryTitle", "No 'In-review stall surfaced' entry on this task yet — self-healing may not have logged one within its rate-limit window.")}
                            >
                              {t("taskDetail.stall.noLogEntry", "No log entry yet")}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                  {shouldShowStalePausedReviewBadge(workingTask, detailColumnFlags) && workingTask.stalePausedReview && (() => {
                    const copy = getStalePausedReviewCopy(workingTask.stalePausedReview);
                    const logMatch = [...(workingTask.log ?? [])].reverse().find((entry) => {
                      const match = getTaskLogEntryAction(entry).match(STALE_PAUSED_REVIEW_LOG_REGEX);
                      return match?.[1] === workingTask.stalePausedReview?.code;
                    });
                    return (
                      <div
                        className={`detail-section detail-in-review-stall detail-in-review-stall--${copy.code}`}
                        data-stall-code={copy.code}
                      >
                        <div className="detail-in-review-stall-header">
                          <span className="card-status-badge card-status-badge--in-review stale-paused-review">
                            {copy.badgeLabel}
                          </span>
                          <span className="detail-in-review-stall-headline">{copy.headline}</span>
                        </div>
                        <div className="detail-in-review-stall-reason">{workingTask.stalePausedReview.reason}</div>
                        <div className="detail-in-review-stall-description">{copy.description}</div>
                        <div className="detail-in-review-stall-action">{copy.suggestedAction}</div>
                        <div className="detail-in-review-stall-meta">
                          <span>{t("taskDetail.ageStaleness.age", "Age")} {formatDurationCompact(workingTask.stalePausedReview.ageMs)}</span>
                          <span>{t("taskDetail.stall.threshold", "Threshold")} {formatDurationCompact(workingTask.stalePausedReview.thresholdMs)}</span>
                          <span>{t("taskDetail.stall.observed", "Observed")} {formatTimestamp(workingTask.stalePausedReview.observedAt)}</span>
                          {logMatch ? (
                            <button
                              type="button"
                              className="btn btn-sm detail-in-review-stall-jump"
                              onClick={() => {
                                setActiveTab("chat");
                                setActivitySegment("feed");
                                setHighlightStallCode(workingTask.stalePausedReview?.code ?? null);
                              }}
                            >
                              {t("taskDetail.stall.viewActivityLog", "View activity log")}
                            </button>
                          ) : (
                            <span className="detail-in-review-stall-no-log">{t("taskDetail.stall.noLogEntry", "No log entry yet")}</span>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                  <div className="detail-section detail-pr-section">
                    <PrPanel
                      taskId={task.id}
                      projectId={projectId}
                      prInfo={task.prInfo}
                      prInfos={task.prInfos}
                      automationStatus={task.status ?? null}
                      taskColumn={task.column}
                      taskColumnFlags={detailColumnFlags}
                      autoMerge={effectiveAutoMerge}
                      isManualPrFlow={isManualPrFlow}
                      directMergeCommitStrategy={settings?.directMergeCommitStrategy}
                      prAuthAvailable={prAuthAvailable ?? false}
                      onRequestCreatePr={() => setPrCreateOpen(true)}
                      onPrUpdated={(prInfo) => {
                        const existing = task.prInfos ?? (task.prInfo ? [task.prInfo] : []);
                        const nextPrInfos = existing.some((entry) => entry.number === prInfo.number)
                          ? existing.map((entry) => (entry.number === prInfo.number ? prInfo : entry))
                          : [...existing, prInfo];
                        (task as TaskDetail).prInfos = nextPrInfos;
                        (task as TaskDetail).prInfo = nextPrInfos[0] ?? prInfo;
                      }}
                      onPrsRefreshed={(prInfos) => {
                        (task as TaskDetail).prInfos = prInfos;
                        (task as TaskDetail).prInfo = prInfos[0];
                      }}
                      onPrUnlinked={(prNumber) => {
                        const nextPrInfos = (task.prInfos ?? (task.prInfo ? [task.prInfo] : [])).filter((entry) => entry.number !== prNumber);
                        (task as TaskDetail).prInfos = nextPrInfos;
                        (task as TaskDetail).prInfo = nextPrInfos[0];
                      }}
                      addToast={addToast}
                    />
                  </div>
                </>
              )}
            </div>
          ) : activeTab === "comments" ? (
            <TaskComments task={task} addToast={addToast} projectId={projectId} onTaskUpdated={onTaskUpdated} />
          ) : activeTab === "documents" ? (
            <>
              <TaskDocumentsTab
                taskId={task.id}
                addToast={addToast}
                projectId={projectId}
                onTaskUpdated={onTaskUpdated}
                canEdit={canEdit}
              />
              {renderAttachmentsSection()}
            </>
          ) : activePluginTab ? (
            <div className="detail-section">
              {/*
              FNXC:Quality 2026-07-14-21:50:
              Pass task context into plugin task-detail tabs so Quality QA (and future tabs)
              can scope worktree runs, preview servers, and suggestions without URL scraping.
              */}
              <PluginSlot
                slotId="task-detail-tab"
                projectId={projectId}
                pluginIds={[activePluginTab.entry.pluginId]}
                taskId={task.id}
                worktree={typeof task.worktree === "string" ? task.worktree : undefined}
                context={{
                  taskId: task.id,
                  projectId,
                  worktree: typeof task.worktree === "string" ? task.worktree : undefined,
                  title: task.title,
                  modifiedFiles: Array.isArray(task.modifiedFiles) ? task.modifiedFiles : undefined,
                }}
              />
            </div>
          ) : activeTab === "stats" ? (
            <div className="detail-section">
              {/*
              FNXC:TaskDetailStats 2026-08-29-05:45:
              Summary owns landed-commit facts in its trailing MergeDetails panel, while Stats owns every
              token and cost number. The panel supplies task-level totals and cache ratios, and TaskCostTab
              supplies the per-model derived-USD breakdown without restating those metrics elsewhere.
              */}
              <TaskTokenStatsPanel
                tokenUsage={workingTask.tokenUsage}
                loading={detailLoading}
                task={workingTask}
                columnFlags={detailColumnFlags}
              />
              <div className="detail-section--cost">
                <TaskCostTab task={workingTask} pricingOverrides={globalSettings?.modelPricingOverrides} />
              </div>
            </div>
          ) : activeTab === "terminal" ? (
            /* FNXC:TaskDetailTabKeepAlive 2026-07-22-12:55: body renders from the kept-alive sibling below the ternary. */
            null
          ) : activeTab === "worktree-terminal" && showWorktreeTerminalTab ? (
            /* FNXC:TaskDetailTabKeepAlive 2026-07-22-12:55: body renders from the kept-alive sibling below the ternary. */
            null
          ) : activeTab === "dependencies" ? (
            <>
          <div className="detail-deps">
            <h4>{t("taskDetail.deps.heading", "Dependencies")}</h4>
            {dependencies.length > 0 ? (
              <ul className="detail-dep-list">
                {dependencies.map((dep) => {
                  // Look up dependency metadata from tasks prop
                  const depTask = tasks.find((t) => t.id === dep);
                  const depLabel = depTask?.title || depTask?.description || dep;

                  return (
                    <li key={dep} className="detail-dep-item">
                      <span
                        className="detail-dep-link"
                        onClick={() => handleDepClick(dep)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleDepClick(dep);
                          }
                        }}
                        role="link"
                        tabIndex={0}
                        title={t("taskDetail.deps.clickToView", "Click to view {{id}}", { id: dep })}
                      >
                        <span className="detail-dep-id">{dep}</span>
                        <span className="detail-dep-label">{truncate(depLabel, 40)}</span>
                      </span>
                      <button
                        className="dep-remove-btn"
                        onClick={(e) => handleRemoveDep(e, dep)}
                        title={t("taskDetail.deps.removeTitle", "Remove dependency {{id}}", { id: dep })}
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="detail-empty-inline">{t("taskDetail.deps.none", "(no dependencies)")}</div>
            )}
            {workingTask.overlapBlockedBy && (
              <div className="detail-empty-inline">
                <span>
                  {t("taskDetail.deps.overlapBlocker", "File scope overlap blocker:")} {workingTask.overlapBlockedBy}
                  {!overlapBlockerActive && ` ${t("taskDetail.deps.stale", "(stale)")}`}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void handleClearOverlapBlocker()}
                  title={t("taskDetail.deps.clearBlockerTitle", "Clear overlap blocker {{id}}", { id: workingTask.overlapBlockedBy })}
                >
                  {t("taskDetail.deps.clearBtn", "Clear")}
                </button>
              </div>
            )}
            {workingTask.overlapBlockedBy && (
              <div className="detail-overlap-files" aria-live="polite">
                {overlapBlockerReportLoading ? (
                  <div className="detail-overlap-files__loading">{t("taskDetail.deps.overlapFiles.loading", "Loading overlapping files…")}</div>
                ) : overlapBlockerReportError ? (
                  <div className="detail-overlap-files__error">{t("taskDetail.deps.overlapFiles.error", "Could not load overlapping files.")}</div>
                ) : overlapBlockerReport?.blockerScopeCount === 0 ? (
                  <div>{t("taskDetail.deps.overlapFiles.noScope", "The blocker declares no file scope.")}</div>
                ) : overlapBlockerReport && overlapBlockerReport.overlaps.length === 0 ? (
                  <div>{t("taskDetail.deps.overlapFiles.none", "No overlapping files found.")}</div>
                ) : overlapBlockerReport ? (
                  <ul className="detail-overlap-files__list">
                    {overlapBlockerReport.overlaps.map(({ path, blockerPath }) => (
                      <li key={`${path}:${blockerPath}`}>
                        <code>{path}</code>
                        {path !== blockerPath && <span> {t("taskDetail.deps.overlapFiles.matches", "matches {{path}}", { path: blockerPath })}</span>}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
            <div className="dep-trigger-wrap">
              <button
                type="button"
                className="btn btn-sm dep-trigger"
                onClick={() => {
                  if (showDepDropdown) setDepSearch("");
                  setShowDepDropdown((v) => !v);
                }}
              >
                {t("taskDetail.deps.addBtn", "Add Dependency")}
              </button>
              {showDepDropdown && (() => {
                const term = depSearch.toLowerCase();
                const filtered = term
                  ? availableTasks.filter((t) =>
                      t.id.toLowerCase().includes(term) ||
                      (t.title && t.title.toLowerCase().includes(term)) ||
                      (t.description && t.description.toLowerCase().includes(term))
                    )
                  : availableTasks;
                return (
                  <div className="dep-dropdown">
                    <input
                      className="dep-dropdown-search"
                      placeholder={t("taskDetail.deps.searchPlaceholder", "Search tasks…")}
                      autoFocus
                      value={depSearch}
                      onChange={(e) => setDepSearch(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    {filtered.length === 0 ? (
                      <div className="dep-dropdown-empty">{t("taskDetail.deps.noAvailableTasks", "No available tasks")}</div>
                    ) : (
                      filtered.map((t) => (
                        <div
                          key={t.id}
                          className="dep-dropdown-item"
                          onClick={() => {
                            handleAddDep(t.id);
                            setShowDepDropdown(false);
                          }}
                        >
                          <span className="dep-dropdown-id">{t.id}</span>
                          <span className="dep-dropdown-title">{truncate(t.title || t.description || t.id, 30)}</span>
                        </div>
                      ))
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
          <div className="detail-deps detail-blocking">
            <h4>{t("taskDetail.blocking.heading", "Blocking")}</h4>
            {blockingEntry && (
              <div className="detail-empty-inline">
                {overlapBlockingSummary}
              </div>
            )}
            {blockingDependents.length > 0 ? (
              <ul className="detail-dep-list">
                {blockingDependents.map((dependent) => (
                  <li key={dependent.id} className="detail-dep-item">
                    <span
                      className="detail-dep-link"
                      onClick={() => handleDepClick(dependent.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleDepClick(dependent.id);
                        }
                      }}
                      role="link"
                      tabIndex={0}
                      title={t("taskDetail.deps.clickToView", "Click to view {{id}}", { id: dependent.id })}
                    >
                      <span className="detail-dep-id">{dependent.id}</span>
                      <span className="detail-dep-label">{truncate(dependent.label, 40)}</span>
                    </span>
                    {dependent.stale && (
                      <span
                        className="detail-blocking-item--stale"
                        title={t("taskDetail.blocking.staleTitle", "Stale blockedBy edge: self-healing clearStaleBlockedBy should clear this automatically")}
                      >
                        {t("taskDetail.blocking.stale", "(stale)")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="detail-empty-inline">{t("taskDetail.blocking.none", "(no downstream tasks blocked)")}</div>
            )}
          </div>
            </>
          ) : activeTab === "details" ? (
            <>
          {renderTaskMetadata()}
          <div className="detail-section detail-section--original-prompt">
            {/**
             * FNXC:TaskDetailPlan 2026-07-04-00:00:
             * Operators need the exact prompt they entered to stay visible after planning generates PROMPT.md. Keep this section read-only and backed by task.description so PROMPT.md editing/revision controls cannot imply they mutate the original request.
             *
             * FNXC:TaskDetailPlan 2026-07-04-00:00:
             * The original operator prompt is now rendered as Markdown (shared PROMPT.md renderer) and collapsed by default behind a chevron toggle, superseding the earlier plain-preserved-text rule. It remains read-only and backed by task.description; the generated PROMPT.md editor/revision flow is unaffected. The toggle only renders when there is content — the empty fallback never shows a chevron.
             */}
            <div className="detail-source-header">
              <h4>{t("taskDetail.originalPrompt.heading", "Original prompt")}</h4>
              {hasOriginalTaskPrompt && (
                <button
                  type="button"
                  className="detail-source-toggle"
                  aria-expanded={originalPromptExpanded}
                  aria-label={originalPromptExpanded ? t("taskDetail.originalPrompt.collapse", "Collapse original prompt") : t("taskDetail.originalPrompt.expand", "Expand original prompt")}
                  onClick={() => setOriginalPromptExpanded((expanded) => !expanded)}
                >
                  <ChevronRight size={16} className={originalPromptExpanded ? "detail-source-chevron--expanded" : undefined} />
                </button>
              )}
            </div>
            {hasOriginalTaskPrompt ? (
              originalPromptExpanded && (
                <div className="markdown-body" data-testid="task-detail-original-prompt">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={sharedRehypePlugins} components={markdownLinkifyComponents}>
                    {originalTaskPrompt}
                  </ReactMarkdown>
                </div>
              )
            ) : (
              <p className="detail-original-prompt-empty">
                {t("taskDetail.originalPrompt.empty", "No original prompt recorded.")}
              </p>
            )}
          </div>
          {/*
          FNXC:Workspace 2026-09-03-14:19:
          FN-289 keeps the multi-repository landing count and per-repository list in Details instead
          of the permanent header. Render from the hydrated workingTask because workspaceWorktrees
          arrives with fetched detail after optimistic opening; TaskCard deliberately remains count-only.
          */}
          {isWorkspaceTask(workingTask) && (
            <div className="detail-section detail-section--workspace-repos">
              <WorkspaceWorktreesSummary task={workingTask} />
            </div>
          )}
          {/* FNXC:TaskDetailSummaryTab 2026-07-29-00:00: FN-8197 keeps Definition focused on plan, retry, and source metadata; completed merge metadata renders exclusively in the done-only Summary tab. */}
          {(retrySummary?.total ?? 0) > 0 && (
            <div className="detail-section detail-retries-section">
              <div className="detail-source-header">
                <div className="detail-source-summary">
                  <span className="detail-source-label">{t("taskDetail.retries.label", "Retries")}</span>
                  <span className="detail-source-number">{retrySummary?.total ?? 0}</span>
                </div>
                <button
                  type="button"
                  className="detail-source-toggle"
                  aria-expanded={retriesExpanded}
                  aria-label={retriesExpanded ? t("taskDetail.retries.collapse", "Collapse retries details") : t("taskDetail.retries.expand", "Expand retries details")}
                  onClick={() => setRetriesExpanded((expanded) => !expanded)}
                >
                  <ChevronRight size={16} className={retriesExpanded ? "detail-source-chevron--expanded" : undefined} />
                </button>
              </div>
              {retriesExpanded && (
                <dl className="detail-source-grid detail-retries-grid">
                  {retryRows.map((row) => (
                    <div key={row.key}>
                      <dt title={row.title}>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {settings?.maxTotalRetriesBeforeFail != null && (retrySummary?.total ?? 0) >= settings.maxTotalRetriesBeforeFail && (
                <p className="detail-retries-warning">{t("taskDetail.retries.capReached", "Retry cap reached for this task.")}</p>
              )}
            </div>
          )}
          {task.sourceIssue && (
            <div className="detail-section detail-source-section">
              <div className="detail-source-header">
                <div className="detail-source-summary">
                  <span className="detail-source-label">{t("taskDetail.sourceIssue.label", "Source issue")}</span>
                  {task.sourceIssue.provider.toLowerCase() === "github" && (
                    <span className="detail-source-provider-badge" aria-label={t("taskDetail.sourceIssue.githubAriaLabel", "GitHub source issue")}>
                      <GitBranch aria-hidden="true" />
                      <span>{t("taskDetail.sourceIssue.githubBadge", "GitHub")}</span>
                    </span>
                  )}
                  {task.sourceIssue.provider.toLowerCase() === "gitlab" && (
                    <span className="detail-source-provider-badge" aria-label={t("taskDetail.sourceIssue.gitlabAriaLabel", "GitLab source item")}>
                      <GitBranch aria-hidden="true" />
                      <span>{t("taskDetail.sourceIssue.gitlabBadge", "GitLab")}</span>
                    </span>
                  )}
                  {task.sourceIssue.url ? (
                    <a
                      className="detail-source-link detail-source-link--summary detail-source-number"
                      href={task.sourceIssue.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {`(#${task.sourceIssue.issueNumber})`}
                    </a>
                  ) : (
                    <span className="detail-source-number">{`(#${task.sourceIssue.issueNumber})`}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="detail-source-toggle"
                  aria-expanded={sourceIssueExpanded}
                  aria-label={sourceIssueExpanded ? t("taskDetail.sourceIssue.collapse", "Collapse source issue details") : t("taskDetail.sourceIssue.expand", "Expand source issue details")}
                  onClick={() => setSourceIssueExpanded((expanded) => !expanded)}
                >
                  <ChevronRight
                    size={16}
                    className={sourceIssueExpanded ? "detail-source-chevron--expanded" : undefined}
                  />
                </button>
              </div>
              {sourceIssueExpanded && (
                <dl className="detail-source-grid">
                  <div>
                    <dt>{t("taskDetail.sourceIssue.provider", "Provider")}</dt>
                    <dd>{task.sourceIssue.provider}</dd>
                  </div>
                  <div>
                    <dt>{t("taskDetail.sourceIssue.repository", "Repository")}</dt>
                    <dd>{task.sourceIssue.repository}</dd>
                  </div>
                  <div>
                    <dt>{t("taskDetail.sourceIssue.identifier", "Issue Identifier")}</dt>
                    <dd>{task.sourceIssue.externalIssueId}</dd>
                  </div>
                  <div>
                    <dt>{t("taskDetail.sourceIssue.url", "URL")}</dt>
                    <dd>
                      {task.sourceIssue.url ? (
                        <a
                          className="detail-source-link"
                          href={task.sourceIssue.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {task.sourceIssue.url}
                        </a>
                      ) : (
                        <span className="detail-source-empty">{t("taskDetail.sourceIssue.none", "(none)")}</span>
                      )}
                    </dd>
                  </div>
                </dl>
              )}
            </div>
          )}
          <div className="detail-section detail-agent-section">
            <div className="detail-meta-row">
              <div className="detail-meta-left">
                {detailProviders.length > 0 && (
                  <span className="detail-provider-icons" data-testid="detail-provider-icons">
                    {detailProviders.map((provider) => (
                      <ProviderIcon key={provider} provider={provider} size="sm" />
                    ))}
                  </span>
                )}
                <span className="detail-meta-label">
                  <Bot size={14} className="detail-meta-label-icon" />
                  {t("taskDetail.agent.label", "Agent")}
                </span>
              </div>
              <div className="detail-agent-actions">
                {assignedAgentLabel ? (
                  <span className="detail-agent-chip">
                    <Bot size={14} />
                    {assignedAgentLabel}
                    <button
                      className="detail-agent-clear"
                      onClick={() => void handleClearAgent()}
                      title={t("taskDetail.agent.unassignTitle", "Unassign agent")}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ) : (
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      if (showAgentPicker) {
                        setShowAgentPicker(false);
                      } else {
                        void loadAgents();
                      }
                    }}
                  >
                    {t("taskDetail.agent.assignBtn", "Assign Agent")}
                  </button>
                )}
                {showAgentPicker && (
                  <div className="agent-picker-dropdown">
                    {agentsLoading && <div className="agent-picker-loading"><LoadingSpinner label={t("taskDetail.agent.loadingAgents", "Loading agents...")} /></div>}
                    {!agentsLoading && agents.map((a) => (
                      <button
                        key={a.id}
                        className={`agent-picker-item${task.assignedAgentId === a.id ? " selected" : ""}`}
                        onClick={() => void handleAssignAgent(a.id)}
                      >
                        <Bot size={14} />
                        <span className="agent-picker-name">{a.name}</span>
                        <span className="agent-picker-role">{a.role}</span>
                      </button>
                    ))}
                    {!agentsLoading && agents.length === 0 && (
                      <div className="agent-picker-empty">{t("taskDetail.agent.noAgents", "No agents available")}</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
          {showGitLabTrackingSection && (
            <div className="detail-section detail-gitlab-tracking-section" data-testid="detail-gitlab-tracking-section">
              <div className="detail-source-header">
                <div className="detail-source-summary">
                  <span className="detail-source-label">{t("taskDetail.gitlabTracking.label", "GitLab tracking")}</span>
                  <span className={`detail-source-provider-badge ${gitlabTrackingStale ? "detail-source-provider-badge--stale" : ""}`} aria-label={t("taskDetail.gitlabTracking.statusAriaLabel", "GitLab tracking status")}>
                    <GitBranch aria-hidden="true" />
                    <span>{gitlabTrackingStatus}</span>
                  </span>
                  {gitlabTrackedItem ? (
                    <a className="detail-source-link detail-source-link--summary detail-source-number" href={gitlabTrackedItem.url} target="_blank" rel="noopener noreferrer">
                      {`${formatGitLabItemKind(gitlabTrackedItem, t)} ${formatGitLabItemMarker(gitlabTrackedItem)}`}
                    </a>
                  ) : (
                    <span className="detail-source-empty">{t("taskDetail.gitlabTracking.unlinked", "No linked GitLab item")}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="detail-source-toggle"
                  aria-expanded={gitlabTrackingExpanded}
                  aria-label={gitlabTrackingExpanded ? t("taskDetail.gitlabTracking.collapse", "Collapse GitLab tracking details") : t("taskDetail.gitlabTracking.expand", "Expand GitLab tracking details")}
                  onClick={() => setGitlabTrackingExpanded((expanded) => !expanded)}
                >
                  <ChevronRight size={16} className={gitlabTrackingExpanded ? "detail-source-chevron--expanded" : undefined} />
                </button>
              </div>
              {gitlabTrackingExpanded && (
                <div className="detail-gitlab-tracking-content">
                  {gitlabTrackedItem && (
                    <dl className="detail-source-grid detail-gitlab-tracking-grid">
                      <div>
                        <dt>{t("taskDetail.gitlabTracking.item", "Item")}</dt>
                        <dd><a className="detail-source-link" href={gitlabTrackedItem.url} target="_blank" rel="noopener noreferrer">{gitlabTrackedItem.title || `${formatGitLabItemKind(gitlabTrackedItem, t)} ${formatGitLabItemMarker(gitlabTrackedItem)}`}</a></dd>
                      </div>
                      <div>
                        <dt>{t("taskDetail.gitlabTracking.kind", "Kind")}</dt>
                        <dd>{formatGitLabItemKind(gitlabTrackedItem, t)}</dd>
                      </div>
                      <div>
                        <dt>{t("taskDetail.gitlabTracking.state", "State")}</dt>
                        <dd><span className={`detail-gitlab-item-state ${gitlabTrackingStale ? "detail-gitlab-item-state--stale" : ""}`}>{gitlabTrackedItem.state || t("taskDetail.gitlabTracking.stateUnknown", "unknown")}</span></dd>
                      </div>
                      <div>
                        <dt>{t("taskDetail.gitlabTracking.instance", "Instance")}</dt>
                        <dd>{gitlabTrackedItem.host}</dd>
                      </div>
                      {(gitlabTrackedItem.projectPath || gitlabTrackedItem.groupPath) && (
                        <div>
                          <dt>{t("taskDetail.gitlabTracking.namespace", "Namespace")}</dt>
                          <dd>{gitlabTrackedItem.projectPath || gitlabTrackedItem.groupPath}</dd>
                        </div>
                      )}
                      {gitlabTrackedItem.lastSyncedAt && (
                        <div>
                          <dt>{t("taskDetail.gitlabTracking.lastSynced", "Last synced")}</dt>
                          <dd>{formatTimestamp(gitlabTrackedItem.lastSyncedAt)}</dd>
                        </div>
                      )}
                      {gitlabTrackingStale && (
                        <div>
                          <dt>{t("taskDetail.gitlabTracking.stale", "Stale")}</dt>
                          <dd>{gitlabTrackedItem.staleReason || (gitlabTrackedItem.staleAt ? formatTimestamp(gitlabTrackedItem.staleAt) : t("taskDetail.gitlabTracking.staleUnknown", "Sync data is stale"))}</dd>
                        </div>
                      )}
                    </dl>
                  )}
                  {gitlabTrackedItem && (
                    <div className="detail-gitlab-tracking-controls">
                      <a className="btn btn-sm touch-target" href={gitlabTrackedItem.url} target="_blank" rel="noopener noreferrer" aria-label={t("taskDetail.gitlabTracking.openAriaLabel", "Open linked GitLab item")}>{t("taskDetail.gitlabTracking.openBtn", "Open in GitLab")}</a>
                      {canEdit && (
                        <button className="btn btn-sm btn-danger touch-target" onClick={() => void handleUnlinkGitLabItem()} disabled={isSavingGithubTracking}>{t("taskDetail.gitlabTracking.unlinkBtn", "Unlink GitLab item")}</button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {showGithubTrackingSection && (
            <div className="detail-section detail-github-tracking-section">
              <div className="detail-source-header">
                <div className="detail-source-summary">
                  <span className="detail-source-label">{t("taskDetail.githubTracking.label", "GitHub tracking")}</span>
                  <span className="detail-source-provider-badge" aria-label={t("taskDetail.githubTracking.statusAriaLabel", "GitHub tracking status")}>
                    <GitBranch aria-hidden="true" />
                    <span>{githubTrackingStatus}</span>
                  </span>
                  {!githubTrackedIssue && (
                    <span className="detail-source-empty">
                      {githubTrackingDetailPending
                        ? t("taskDetail.githubTracking.checking", "Checking tracking status")
                        : githubTrackingEnabled
                          ? t("taskDetail.githubTracking.notYetCreated", "Issue not yet created")
                          : t("taskDetail.githubTracking.disabled", "Tracking is currently disabled")}
                    </span>
                  )}
                </div>
                {showInlineGithubTrackingEnableButton && (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary detail-github-tracking-enable"
                    aria-label={t("taskDetail.githubTracking.enableAriaLabel", "Enable GitHub tracking")}
                    disabled={isSavingGithubTracking}
                    onClick={() => void handleToggleGithubTracking()}
                  >
                    {t("taskDetail.githubTracking.enableBtn", "Enable")}
                  </button>
                )}
                {showGithubTrackingSpinner && (
                  <span
                    className="detail-github-tracking-spinner"
                    role="status"
                    aria-live="polite"
                    aria-label={isSavingGithubTracking ? t("taskDetail.githubTracking.enablingAriaLabel", "Enabling GitHub tracking") : t("taskDetail.githubTracking.loadingAriaLabel", "Loading GitHub tracking status")}
                  >
                    <Loader2 size={16} className="spin" aria-hidden="true" />
                    <span className="visually-hidden">
                      {isSavingGithubTracking ? t("taskDetail.githubTracking.enabling", "Enabling GitHub tracking…") : t("taskDetail.githubTracking.loading", "Loading GitHub tracking status…")}
                    </span>
                  </span>
                )}
                <button
                  type="button"
                  className="detail-source-toggle"
                  aria-expanded={githubTrackingExpanded}
                  aria-label={githubTrackingExpanded ? t("taskDetail.githubTracking.collapse", "Collapse GitHub tracking details") : t("taskDetail.githubTracking.expand", "Expand GitHub tracking details")}
                  onClick={() => setGithubTrackingExpanded((expanded) => !expanded)}
                >
                  <ChevronRight
                    size={16}
                    className={githubTrackingExpanded ? "detail-source-chevron--expanded" : undefined}
                  />
                </button>
              </div>
              {githubTrackingExpanded && (
                <div className="detail-github-tracking-content">
                  {githubTrackedIssue && (
                    <dl className="detail-source-grid detail-github-tracking-grid">
                      <div>
                        <dt>{t("taskDetail.githubTracking.issue", "Issue")}</dt>
                        <dd>
                          {githubTrackedIssue.url ? (
                            <a className="detail-source-link" href={githubTrackedIssue.url} target="_blank" rel="noopener noreferrer">
                              {`${githubTrackedIssue.owner}/${githubTrackedIssue.repo}#${githubTrackedIssue.number}`}
                            </a>
                          ) : (
                            <span>{`${githubTrackedIssue.owner}/${githubTrackedIssue.repo}#${githubTrackedIssue.number}`}</span>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("taskDetail.githubTracking.state", "State")}</dt>
                        <dd>
                          <span className={`detail-github-issue-state ${task.issueInfo?.state === "closed" ? "detail-github-issue-state--closed" : "detail-github-issue-state--open"}`}>
                            {task.issueInfo?.state ?? "open"}
                          </span>
                        </dd>
                      </div>
                    </dl>
                  )}
                  <div className="detail-github-tracking-controls">
                    {!githubTrackedIssue && githubTrackingEnabled && (
                      <>
                        <button
                          className="btn btn-sm touch-target"
                          onClick={() => void handleRetryGithubTrackingIssueCreate()}
                          disabled={isSavingGithubTracking || !canCreateTrackingIssue}
                          title={!canCreateTrackingIssue ? t("taskDetail.githubTracking.createIssueDisabledTitle", "Add a title or description so a tracking issue can be created.") : undefined}
                        >
                          {t("taskDetail.githubTracking.createIssueBtn", "Create tracking issue")}
                        </button>
                        {!canCreateTrackingIssue && (
                          <small className="detail-github-tracking-helper">{t("taskDetail.githubTracking.createIssueHelper", "Tracking issue will be created once this task has a title or description to summarize.")}</small>
                        )}
                      </>
                    )}
                    {canEditGithubTracking && (
                      <>
                        <label className="checkbox-label" htmlFor="detail-github-tracking-toggle">
                          <input
                            id="detail-github-tracking-toggle"
                            type="checkbox"
                            checked={githubTrackingEnabled}
                            disabled={isSavingGithubTracking}
                            onChange={() => void handleToggleGithubTracking()}
                          />
                          {t("taskDetail.githubTracking.enableCheckboxLabel", "Enable GitHub tracking")}
                        </label>
                        <div className="detail-github-tracking-repo-row">
                          <input
                            className="input"
                            value={githubRepoOverrideDraft}
                            onChange={(event) => {
                              setGithubRepoOverrideDraft(event.target.value);
                              setGithubRepoOverrideError(null);
                            }}
                            placeholder={effectiveGithubRepoDefault || "owner/repo"}
                          />
                          <button className="btn btn-sm" onClick={() => void handleSaveGithubRepoOverride()} disabled={isSavingGithubTracking}>
                            {t("common.save", "Save")}
                          </button>
                        </div>
                        {githubRepoOverrideError && <small className="detail-github-tracking-error">{githubRepoOverrideError}</small>}
                        {githubTrackedIssue && (
                          <button className="btn btn-sm touch-target" onClick={() => void handleUnlinkGithubIssue()} disabled={isSavingGithubTracking}>
                            {t("taskDetail.githubTracking.unlinkBtn", "Unlink GitHub issue")}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="detail-section detail-no-commits-expected-section">
            <div className="form-group">
              <label className="checkbox-label" htmlFor="detail-no-commits-expected-toggle">
                <input
                  id="detail-no-commits-expected-toggle"
                  type="checkbox"
                  checked={inlineNoCommitsExpected}
                  disabled={isSavingInlineNoCommitsExpected}
                  onChange={() => {
                    void handleInlineNoCommitsExpectedToggle();
                  }}
                />
                {t("taskDetail.noCommits.label", "No commits expected (decision-only task)")}
              </label>
              <small>{t("taskDetail.noCommits.hint", "Allows the task to complete without producing git commits. Use for evaluation, verification, or audit tasks where the deliverable is the recorded decision.")}</small>
            </div>
          </div>
          <div className="detail-section detail-routing-section">
            <div className="detail-source-header">
              <span className="detail-source-label">{t("taskDetail.tabs.routing", "Routing")}</span>
              <button
                type="button"
                className="detail-source-toggle"
                aria-expanded={routingExpanded}
                aria-label={routingExpanded
                  ? t("taskDetail.details.collapseRouting", "Collapse routing details")
                  : t("taskDetail.details.expandRouting", "Expand routing details")}
                onClick={() => setRoutingExpanded((expanded) => !expanded)}
              >
                <ChevronRight size={16} className={routingExpanded ? "detail-source-chevron--expanded" : undefined} />
              </button>
            </div>
            {routingExpanded && (
              <RoutingTab
                task={task}
                columnFlags={detailColumnFlags}
                settings={settings}
                addToast={addToast}
                onTaskUpdated={onTaskUpdated}
              />
            )}
          </div>
          <div className="detail-section detail-debug-section">
            <div className="detail-source-header">
              <span className="detail-source-label">{t("taskDetail.tabs.debug", "Debug")}</span>
              <button
                type="button"
                className="detail-source-toggle"
                aria-expanded={debugExpanded}
                aria-label={debugExpanded
                  ? t("taskDetail.details.collapseDebug", "Collapse debug details")
                  : t("taskDetail.details.expandDebug", "Expand debug details")}
                onClick={() => setDebugExpanded((expanded) => !expanded)}
              >
                <ChevronRight size={16} className={debugExpanded ? "detail-source-chevron--expanded" : undefined} />
              </button>
            </div>
            {debugExpanded && renderDebugDetails()}
          </div>
            </>
          ) : (
          <>
          <div className="detail-section detail-step-progress">
            <h4>{t("taskDetail.progress.heading", "Progress")}</h4>
            {unifiedProgress.total > 0 ? (
              <div className="step-progress-wrapper">
                <div className="step-progress-bar">
                  {unifiedProgress.items.map((item) => (
                    <div
                      key={item.id}
                      className={`step-progress-segment step-progress-segment--${item.status} step-progress-segment--source-${item.source}`}
                      data-tooltip={`${item.name} (${item.source === "workflow" ? "workflow step · " : ""}${item.status})`}
                      style={{ backgroundColor: getStepStatusColor(item.status) }}
                    />
                  ))}
                </div>
                <span className="step-progress-label">
                  {t("taskDetail.progress.stepCount", { count: unifiedProgress.completed, total: unifiedProgress.total, defaultValue_one: "{{count}}/{{total}} step", defaultValue_other: "{{count}}/{{total}} steps" })}
                </span>
              </div>
            ) : (
              <div className="step-progress-empty">{t("taskDetail.progress.noSteps", "(no steps defined)")}</div>
            )}
          </div>
          <div className="detail-section detail-section--plan-prompt">
            {!isEditingSpec && (
              <div className="detail-spec-edit-trigger">
                {/**
                 * FNXC:TaskDetailPlan 2026-06-30-00:00:
                 * The Plan tab keeps the internal definition route for stable links, while exposing a direct PROMPT.md editor action so operators can comment on the executable task plan file without replacing the inline AI revision flow.
                 *
                 * FNXC:TaskDetailPlan 2026-06-30-00:00:
                 * The Plan prompt surfaces must span the task-detail card body in modal and embedded renderings. Keep the scoped wrapper around markdown, no-prompt fallback, inline edit, and AI revision controls so width fixes do not alter unrelated detail sections.
                 */}
                {fileBrowser && (
                  <button
                    className="btn btn-sm"
                    onClick={openPromptFile}
                    title={t("taskDetail.spec.openPromptTitle", "Open this task's PROMPT.md in the file editor")}
                  >
                    {t("taskDetail.spec.openPromptBtn", "Open PROMPT.md")}
                  </button>
                )}
                <button className="btn btn-sm" onClick={enterSpecEditMode}>
                  {t("taskDetail.spec.editBtn", "Edit")}
                </button>
              </div>
            )}
            {isEditingSpec ? (
              <div className="spec-editor-edit-mode">
                <textarea
                  className="spec-editor-textarea"
                  value={specEditContent}
                  onChange={(e) => setSpecEditContent(e.target.value)}
                  onKeyDown={handleSpecTextareaKeyDown}
                  disabled={isSavingSpec}
                  placeholder={t("taskDetail.spec.placeholder", "Enter task specification in Markdown...")}
                  rows={12}
                />
                <div className="spec-editor-actions-row">
                  <button
                    className="btn btn-sm"
                    onClick={exitSpecEditMode}
                    disabled={isSavingSpec}
                  >
                    {t("common.cancel", "Cancel")}
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => void handleSaveSpecFromEdit()}
                    disabled={specEditContent === (workingTask.prompt || "") || isSavingSpec}
                  >
                    {isSavingSpec ? t("taskDetail.spec.saving", "Saving…") : t("common.save", "Save")}
                  </button>
                </div>
                <div className="spec-editor-hint">
                  <kbd>Ctrl</kbd>+<kbd>Enter</kbd> {t("taskDetail.spec.hintSave", "to save")} · <kbd>Escape</kbd> {t("taskDetail.spec.hintCancel", "to cancel")}
                </div>
                {/* AI Revision Section */}
                <div className="spec-editor-revision">
                  <h4>{t("taskDetail.spec.aiReviseHeading", "Ask AI to Revise")}</h4>
                  <p className="spec-editor-revision-help">
                    {t("taskDetail.spec.aiReviseHelp", "Provide feedback for the AI to improve this specification. The task will move to planning for replanning.")}
                  </p>
                  <textarea
                    className="spec-editor-feedback"
                    value={specFeedback}
                    onChange={(e) => setSpecFeedback(e.target.value)}
                    placeholder={t("taskDetail.spec.feedbackPlaceholder", "e.g., 'Add more details about error handling', 'Split this into smaller steps', 'Include tests for the API endpoints'...")}
                    disabled={isRequestingRevision}
                    rows={4}
                    maxLength={MAX_TASK_MESSAGE_LENGTH}
                  />
                  <div className="spec-editor-revision-actions">
                    <span className="spec-editor-char-count">
                      {specFeedback.length}/{MAX_TASK_MESSAGE_LENGTH}
                    </span>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => void handleRequestRevisionFromEdit()}
                      disabled={!specFeedback.trim() || isRequestingRevision}
                    >
                      {isRequestingRevision ? t("taskDetail.spec.requesting", "Requesting…") : t("taskDetail.spec.requestRevisionBtn", "Request AI Revision")}
                    </button>
                  </div>
                </div>
              </div>
            ) : detailLoading ? (
              <div className="spec-loading"><LoadingSpinner label={t("taskDetail.spec.loading", "Loading specification…")} /></div>
            ) : workingTask.prompt ? (
              planSummary.hasSummary ? (
                <>
                  {/*
                  FNXC:TaskDetailPlan 2026-08-27-10:22:
                  Definition shows the product summary and Before → After first so operators can confirm
                  intent at a glance. A plan without either summary heading stays fully visible, while
                  remaining technical detail is available through this explicit disclosure.
                  */}
                  <div className="markdown-body" data-testid="task-detail-plan-summary">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={sharedRehypePlugins} components={markdownLinkifyComponents}>
                      {planSummary.summaryMarkdown}
                    </ReactMarkdown>
                  </div>
                  {planSummary.restMarkdown.trim() && (
                    <>
                      <button
                        type="button"
                        className="btn btn-sm touch-target detail-plan-details-toggle"
                        data-testid="task-detail-plan-details-toggle"
                        aria-expanded={planDetailsExpanded}
                        aria-controls={`${workingTask.id}-plan-details`}
                        onClick={() => setPlanDetailsExpanded((expanded) => !expanded)}
                      >
                        <ChevronRight size={16} className={planDetailsExpanded ? "detail-source-chevron--expanded" : undefined} />
                        {planDetailsExpanded
                          ? t("taskDetail.spec.hideDetailsBtn", "Hide details")
                          : t("taskDetail.spec.moreDetailsBtn", "See more details")}
                      </button>
                      {planDetailsExpanded && (
                        <div className="markdown-body" id={`${workingTask.id}-plan-details`} data-testid="task-detail-plan-details">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={sharedRehypePlugins} components={markdownLinkifyComponents}>
                            {planSummary.restMarkdown}
                          </ReactMarkdown>
                        </div>
                      )}
                    </>
                  )}
                </>
              ) : (
                <div className="markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={sharedRehypePlugins} components={markdownLinkifyComponents}>
                    {planSummary.restMarkdown}
                  </ReactMarkdown>
                </div>
              )
            ) : (
              <div className="detail-prompt">{t("taskDetail.spec.noPrompt", "(no prompt)")}</div>
            )}
          </div>
          </>
          )}
          </>
          )}
          {/*
          FNXC:TaskDetailTabKeepAlive 2026-07-22-12:55:
          Kept-alive tab bodies (mounted after each tab's first open for this task, hidden via KeepAliveView's out-of-flow visibility contract while another tab is active):
          - Planner chat keeps its composer draft and scroll; `active` closes its useAgentLogs EventSource while hidden (R8).
          - Terminal keeps the WebSocket and xterm scrollback alive intentionally; `active` drives SessionTerminal's reveal refit + dead-socket recovery (R9).
          - Worktree terminal keeps the embedded TerminalModal shell session alive across tab flips.
          Task switch or modal close resets the latches, so terminals dispose exactly as before keep-alive (R10).
          */}
          {keepAliveForCurrentTask.plannerChat ? (
            <KeepAliveView hidden={activeTab !== "planner-chat"} testId="planner-chat-keep-alive">
              <div className="detail-section detail-section--planner-chat">
                <TaskPlannerChatTab
                  task={workingTask}
                  /* FNXC:WorkflowResolvedColumns 2026-07-30-23:40: the kept-alive sibling renders the
                     body now, so it carries the resolved flags the inline render used to. Without
                     them TaskPlannerChatTab's `isWipColumnRole(columnFlags, task.column)` falls back
                     to the legacy id and `agentRunning` is wrong on a renamed board. */
                  columnFlags={detailColumnFlags}
                  projectId={projectId}
                  active={active && activeTab === "planner-chat"}
                  expanded={isPlannerChatExpanded}
                  onExpandedChange={setPlannerChatExpanded}
                  taskChatModel={resolveEffectiveTaskChat(settings)}
                  addToast={addToast}
                  onTaskUpdated={onTaskUpdated}
                />
              </div>
            </KeepAliveView>
          ) : null}
          {keepAliveForCurrentTask.terminal ? (
            <KeepAliveView hidden={activeTab !== "terminal"} testId="terminal-keep-alive">
              <div className="detail-section detail-section--terminal">
                {cliSession && cliTabVisibility.kind !== "hidden" ? (
                  <Suspense fallback={<div className="detail-loading"><LoadingSpinner label={t("taskDetail.terminal.loading", "Loading terminal…")} /></div>}>
                    <LazySessionTerminal
                      sessionId={cliSession.id}
                      projectId={projectId}
                      posture={cliPosture}
                      active={active && activeTab === "terminal"}
                      readOnly={
                        cliTabVisibility.kind === "replay" ||
                        (cliTabVisibility.kind === "live" && cliTabVisibility.readOnly)
                      }
                      mode={cliTabVisibility.mode}
                      showConfirmAdvance={
                        cliTabVisibility.kind === "live" && cliTabVisibility.showConfirmAdvance
                      }
                      onConfirmAdvance={handleConfirmAdvance}
                    />
                  </Suspense>
                ) : null}
              </div>
            </KeepAliveView>
          ) : null}
          {keepAliveForCurrentTask.worktreeTerminal && showWorktreeTerminalTab ? (
            <KeepAliveView hidden={activeTab !== "worktree-terminal"} testId="worktree-terminal-keep-alive">
              <div className="detail-section detail-section--worktree-terminal">
                <Suspense fallback={<div className="detail-loading"><LoadingSpinner label={t("taskDetail.terminal.loadingInteractive", "Loading interactive terminal…")} /></div>}>
                  <LazyTerminalModal
                    isOpen={true}
                    /*
                    FNXC:TaskPopupViewGating 2026-07-23-10:20:
                    Keep-alive contract for the worktree terminal: isOpen stays true so xterm and the
                    terminal WebSocket survive hidden popups and tab flips, while `active` (popup
                    visible AND this tab selected — same composition as SessionTerminal above)
                    suspends only auxiliary work: visual-viewport/keyboard listeners, resize
                    observers, refit rAF loops, and keydown handlers. See TerminalModal `active`.
                    */
                    active={active && activeTab === "worktree-terminal"}
                    onClose={() => setActiveTab("definition")}
                    embedded
                    defaultCwd={taskWorktreeCwd}
                    scopeId={task.id}
                    projectId={projectId}
                  />
                </Suspense>
              </div>
            </KeepAliveView>
          ) : null}
        </div>
      </div>
      {isReviewColumn && (
          <PrCreateModal
            open={prCreateOpen}
            taskId={task.id}
            projectId={projectId}
            defaultBaseBranch={undefined}
            onClose={() => setPrCreateOpen(false)}
            onCreated={(prInfo) => {
              const nextPrInfos = [...(task.prInfos ?? (task.prInfo ? [task.prInfo] : [])), prInfo];
              (task as TaskDetail).prInfo = nextPrInfos[0] ?? prInfo;
              (task as TaskDetail).prInfos = nextPrInfos;
              onTaskUpdated?.({ ...workingTask, prInfo: nextPrInfos[0] ?? prInfo, prInfos: nextPrInfos } as Task);
              setPrCreateOpen(false);
            }}
            addToast={addToast}
          />
        )}
        {/*
        FNXC:Workspace 2026-06-24-23:10:
        The "Branch needs reattachment" banner was removed. It fired for any in-review task with a
        null singular `task.branch`, which is the NORMAL, healthy state for a workspace task (its
        attachment is the per-sub-repo worktrees in `task.workspaceWorktrees`, not a root branch), so
        the banner was a permanent false positive for workspace tasks. Reattachment of a genuinely
        lost binding is handled automatically by self-healing's reconcileInReviewBranchRebind, which
        runs event-driven on the move-to-in-review and on its sweep — no manual user action needed.
        */}
        {!isEditing && overseerExplainOpen && (
          <div className="detail-overseer-explain-panel" data-testid="detail-overseer-explain-panel" role="region" aria-live="polite">
            {isLoadingOverseerExplain ? (
              <span className="detail-overseer-explain-panel__loading">
                <Loader2 className="spin" aria-hidden="true" />
                {t("taskDetail.oversight.explainLoading", "Loading overseer state…")}
              </span>
            ) : overseerExplainSnapshot ? (
              <dl className="detail-overseer-explain-panel__grid">
                <dt>{t("taskDetail.oversight.explainStage", "Watched stage")}</dt>
                <dd>{overseerExplainSnapshot.watchedStage ?? t("taskDetail.oversight.explainUnknown", "Unknown")}</dd>
                <dt>{t("taskDetail.oversight.explainReason", "Reason")}</dt>
                <dd>{overseerExplainSnapshot.reason ?? t("taskDetail.oversight.explainUnknown", "Unknown")}</dd>
                <dt>{t("taskDetail.oversight.explainLastAction", "Last action")}</dt>
                <dd>{overseerExplainSnapshot.lastAction ?? t("taskDetail.oversight.explainNone", "None yet")}</dd>
                <dt>{t("taskDetail.oversight.explainAttempts", "Attempts")}</dt>
                <dd>
                  {overseerExplainSnapshot.attemptCount ?? 0}
                  {" / "}
                  {overseerExplainSnapshot.attemptLimit ?? "—"}
                </dd>
              </dl>
            ) : (
              <span className="detail-overseer-explain-panel__empty">
                {t("taskDetail.oversight.explainEmpty", "The overseer is not currently watching this task.")}
              </span>
            )}
          </div>
        )}
        <div className="modal-actions">
          {isEditing ? (
            <>
              <span className="modal-edit-hint">
                {editAutoSaveStatus === "saving" ? t("taskDetail.edit.autosaving", "Autosaving…") : editAutoSaveStatus === "saved" ? t("taskDetail.edit.saved", "Saved") : editAutoSaveStatus === "error" ? t("taskDetail.edit.saveFailed", "Save failed") : t("taskDetail.edit.autosaveHint", "Changes autosave as you edit")}
              </span>
              <div className="modal-actions-spacer" />
              <button
                className="btn btn-sm"
                onClick={exitEditMode}
                disabled={isSaving}
              >
                {t("common.cancel", "Cancel")}
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void handleSave()}
                disabled={isSaving}
              >
                {isSaving ? t("taskDetail.edit.saving", "Saving…") : t("common.save", "Save")}
              </button>
            </>
          ) : (
            <>
              {/* Approve/Reject Plan buttons for manual plan-approval holds (also covers
                  legacy rows with awaitingApprovalReason === "release-authorization"). */}
              {isAwaitingApproval && workingTask.prompt && (
                <>
                  <button className="btn btn-primary btn-sm" data-testid="detail-plan-approval-footer-approve" onClick={handleApprovePlan}>
                    {t("taskDetail.plan.approveBtn", "Approve Plan")}
                  </button>
                  <button className="btn btn-danger btn-sm" data-testid="detail-plan-approval-footer-reject" onClick={handleRejectPlan}>
                    {t("taskDetail.plan.rejectBtn", "Reject Plan")}
                  </button>
                </>
              )}

              {/*
              FNXC:TaskRevert 2026-08-01-19:51:
              A reverted task remains accessible for provenance, but cannot present as ordinary
              completed work. Detail therefore retains guarded Delete and routes Revise through
              the shared New Task draft callback with the original description.
              */}
              {isTaskReverted(task.sourceMetadata) && (
                <>
                  <button className="btn btn-sm btn-danger" onClick={() => void handleDelete()} aria-label={t("taskDetail.reverted.deleteAria", "Delete reverted task")}>{t("taskDetail.delete.btn", "Delete")}</button>
                  {onReviseTask && <button className="btn btn-sm" onClick={() => { onReviseTask(task); requestClose?.(); }}>{t("taskDetail.revise", "Revise")}</button>}
                </>
              )}

              {/*
              FNXC:TaskRevert 2026-07-05-00:00 (FN-7525):
              Detail-view Revert button for workflow Complete tasks, mirroring the
              standalone triage Delete button above. Rendered (not just menu-only)
              because the detail view is the primary surface for reviewing a
              completed task's outcome. Omitted — not disabled — when the task has
              no landed commit to revert, avoiding an empty button shell.
              */}
              {isDoneColumn && onRevertTask && isRevertable && (
                <button
                  className="btn btn-sm"
                  onClick={() => void handleRevertTask()}
                  aria-label={t("tasks.revertTask", "Revert this task's changes")}
                  title={t("tasks.revertTask", "Revert this task's changes")}
                >
                  {t("tasks.revert", "Revert")}
                </button>
              )}

              {/* Actions dropdown — quick controls and less common operations */}
              {(taskActionMenuModel.shouldShowActionsMenu || detailQuickActionItems.length > 0) && (
                <div className="detail-actions-dropdown" ref={actionsMenuRef}>
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      setShowActionsMenu((prev) => !prev);
                    }}
                    aria-haspopup="menu"
                    aria-expanded={showActionsMenu}
                  >
                    <span className="detail-footer-button-label">
                      {t("taskDetail.actions.menuBtn", "Actions")}
                    </span>
                    <ChevronDown size={12} />
                  </button>
                  {showActionsMenu && (
                    <>
                      {/*
                      FNXC:TaskPauseControls 2026-06-21-00:00:
                      Users may pause or unpause agent-assigned and agent-paused tasks at any time from the detail Actions menu. The Paused by agent note remains informational context, not a substitute for the actionable unpause control.
                      */}
                      <TaskContextMenu
                        actions={[...detailQuickActionItems, ...taskActionMenuModel.actions]}
                        className="detail-actions-menu"
                        itemClassName="detail-actions-menu-item"
                        dangerItemClassName="detail-actions-menu-item-danger"
                        noteItemClassName="detail-actions-menu-note"
                        onActionSelect={(action) => {
                          closeMenus();
                          if (action.tone === "note") return;
                        }}
                      />
                    </>
                  )}
                </div>
              )}

              <div className="modal-actions-spacer" />

              {/*
              FNXC:TaskDetailFooter 2026-08-27-12:01:
              FN-198 deliberately leaves no relocation control in the footer. The review action is
              its only primary footer button, while lifecycle placement stays workflow-owned.
              */}
              {reviewAction && (
                <button
                  className="btn btn-primary btn-sm"
                  onClick={reviewAction.onSelect}
                  disabled={reviewAction.disabled}
                >
                  <span className="detail-footer-button-label">{reviewAction.label}</span>
                </button>
              )}
            </>
          )}
      </div>
      {showResetDialog && onResetTask && (
        <TaskResetDialog
          taskId={task.id}
          initialDescription={workingTask.description}
          onReset={onResetTask}
          addToast={addToast}
          onResetCompleted={requestClose}
          onClose={() => setShowResetDialog(false)}
        />
      )}
      {showRefineModal && (
          <div
            className="modal-overlay open detail-refine-overlay"
            {...refineOverlayDismissProps}
            role="dialog"
            aria-modal="true"
          >
            <div className="modal detail-refine-modal">
              <div className="modal-header">
                <h3 className="detail-refine-title">{t("taskDetail.refine.modalTitle", "Refine")}</h3>
                <button className="modal-close" onClick={handleCloseRefineModal} aria-label={t("common.close", "Close")}>
                  &times;
                </button>
              </div>
              <div className="detail-body">
                <div className="detail-body-content">
                  <p className="detail-refine-help">
                    {t("taskDetail.refine.help", "Describe what needs to be refined or improved...")}
                  </p>
                  <textarea
                    className="detail-refine-textarea"
                    value={refineFeedback}
                    onChange={(e) => setRefineFeedback(e.target.value)}
                    placeholder={t("taskDetail.refine.placeholder", "Enter your feedback here...")}
                    rows={6}
                    maxLength={MAX_TASK_MESSAGE_LENGTH}
                    autoFocus
                  />
                  <div className="detail-refine-input-group">
                    <div className="detail-refine-char-count">
                      {t("taskDetail.refine.charCount", "{{count}}/{{max}} characters", { count: refineFeedback.length, max: MAX_TASK_MESSAGE_LENGTH })}
                    </div>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={handleSubmitRefine}
                      disabled={!refineFeedback.trim() || isRefining}
                    >
                      {isRefining ? t("taskDetail.refine.creating", "Creating...") : t("taskDetail.refine.createBtn", "Create Refinement Task")}
                    </button>
                  </div>
                </div>
              </div>
              <div className="modal-actions">
                <button className="btn btn-sm" onClick={handleCloseRefineModal} disabled={isRefining}>
                  {t("common.cancel", "Cancel")}
                </button>
              </div>
            </div>
          </div>
        )}
        {selectedSourceAgentId && (
          <Suspense fallback={null}>
            <AgentDetailView
              agentId={selectedSourceAgentId}
              projectId={projectId}
              onClose={() => setSelectedSourceAgentId(null)}
              addToast={addToast}
              floatingWindowKey="agent-detail-task"
            />
          </Suspense>
        )}
    </div>
  );
}

export function TaskDetailModal({ onClose, ...props }: TaskDetailModalProps) {
  const viewportMode = useViewportMode();
  useMobileScrollLock(true);
  const dismissOnOutsidePointerDown = useModalDismissPreference();
  /*
  FNXC:TaskDetailSwipeBack 2026-07-25-00:00:
  Gate predictive-back animation through useViewportMode, the same physical-screen-aware
  classifier used for resize behavior. This preserves phone animation while keeping known
  768px tablets in their desktop/tablet presentation.
  */
  const isMobileTransition = viewportMode === "mobile";

  return (
    <FloatingWindow
      windowKey="task-detail"
      title="Task detail"
      ariaLabelledBy="task-detail-modal-title"
      onClose={onClose}
      modal
      hideHeader
      dragHandleSelector=".task-detail-content > .modal-header"
      className="floating-window--task-detail"
      /* FNXC:ModalTouchGeometry 2026-07-26-19:05: Task Detail shares its layer with Quick Chat and pop-outs so interaction order remains coordinated by floatingWindowStack. */
      layer="task-detail"
      defaultSize={{ width: 800, height: 680 }}
      minSize={{ width: 480, height: 480 }}
      /* FNXC:ModalTouchGeometry 2026-07-26-19:05: Replace legacy size-only persistence with complete geometry and suspend it for phone and short sheet layouts. */
      persistGeometryKey="floating-window:task-detail"
      suspendGeometryPersistenceOnMobile
      suspendGeometryPersistenceOnShortViewport
      /* FNXC:ModalTouchGeometry 2026-07-26-19:05: Keep outside dismissal preference-gated; unconditional pointer-down would regress the default-off contract. */
      closeOnOutsidePointerDown={dismissOnOutsidePointerDown}
    >
      <div className={`modal modal-lg task-detail-modal${isMobileTransition ? " task-detail-modal--mobile-transition" : ""}`}>
        <TaskDetailContent {...props} onRequestClose={onClose} />
      </div>
    </FloatingWindow>
  );
}
