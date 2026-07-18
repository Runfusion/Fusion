import "./TaskDetailModal.css";
import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Pencil, Bot, X, ChevronDown, ChevronRight, GitBranch, ArrowLeft, Zap, Loader2, AlertTriangle, Sparkles, Maximize2, Minimize2, Send, Square, Info, Paperclip, Eye, EyeOff } from "lucide-react";
import { useModalResizePersist } from "../hooks/useModalResizePersist";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss";
import { useColumnLabel } from "../i18n/labels";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { sharedRehypePlugins, createMermaidCodeComponent } from "./markdownPipeline";
import type { Task, TaskDetail, TaskAttachment, Column, ColumnId, MergeResult, Settings, GlobalSettings, Agent, TaskPriority, TaskSourceIssue, WorkflowStepResult, GithubIssueAction, TaskGitLabTrackedItem, PlannerOversightLevel, PlannerOverseerRuntimeSnapshot } from "@fusion/core";
import {
  DEFAULT_TASK_PRIORITY,
  REPO_OVERRIDE_RE,
  TASK_PRIORITIES,
  PLANNER_OVERSIGHT_LEVELS,
  getErrorMessage,
} from "@fusion/core";
import { resolveEffectivePlannerOversightLevel } from "../../../core/src/workflow-settings-resolver";
import { resolveTaskSessionAdvisorEnabled } from "../../../core/src/session-advisor";
import { isNearDuplicateCanonicalInactive } from "../../../core/src/near-duplicate-canonical";
import { getRevertOfId, findOpenUndoTaskForSource } from "../utils/taskRevert";
import { resolveEffectiveAutoMerge } from "../../../core/src/task-merge";
import { uploadAttachment, deleteAttachment, updateTask, repairOverlapBlocker, pauseTask, unpauseTask, fetchTaskDetail, fetchSettings, fetchTaskEffectiveSettings, fetchGlobalSettings, requestSpecRevision, rebuildTaskSpec, approvePlan, rejectPlan, refineTask, fetchWorkflowResults, assignTask, fetchAgents, fetchAgent, refreshPrStatus, fetchBoardWorkflows, updateTaskCustomFields, summarizeTitle, fetchWorkflowSettingValues, nudgeOverseer, stopOverseer, explainOverseer, fetchModels, fetchNodes, api } from "../api";
import type { RevertTaskOptions, RevertTaskResult, ModelInfo, NodeInfo } from "../api";
import type { BoardWorkflowsPayload, WorkflowFieldDefinition, CustomFieldRejection } from "../api";
import { WorkflowIcon } from "./WorkflowIcon";
import { ApiRequestError } from "../api";
import { TaskFieldsSection } from "./TaskFieldsSection";
import type { ToastType } from "../hooks/useToast";
import { useAgentLogs } from "../hooks/useAgentLogs";
import { useConfirm } from "../hooks/useConfirm";
import { AgentLogViewer } from "./AgentLogViewer";
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
import { subscribeSse } from "../sse-bus";
import type { SessionTerminalMode, SessionTerminalPosture } from "./SessionTerminal";
import { usePluginUiSlots } from "../hooks/usePluginUiSlots";
import { appendTokenQuery } from "../auth";
import { extractDependencyDeleteConflict, extractLineageDeleteConflict } from "../utils/taskDelete";
import { MAX_AUTO_MERGE_RETRIES, computeBlockerFanoutMap } from "../hooks/useBlockerFanout";
import { resolveEffectiveGithubRepoDefault } from "./githubTracking";
import type { TFunction } from "i18next";
import { linkifyFilePaths, linkifyReactChildren } from "../utils/filePathLinkify";
import { getInReviewStallCopy, shouldShowInReviewStallBadge } from "../utils/inReviewStallCopy";
import { getUnifiedTaskProgress } from "../utils/taskProgress";
import { getStalePausedReviewCopy, shouldShowStalePausedReviewBadge } from "../utils/stalePausedReviewCopy";
import { getTaskAgeStalenessCopy } from "../utils/taskAgeStalenessCopy";
import { getPriorityColorVar, getPriorityIcon, getPriorityLabel } from "../utils/priorityIndicator";
import { hasPendingAutomaticRecovery, isTaskManuallyRetryable } from "../utils/taskRecovery";
import { findInReviewStallLogEntry, IN_REVIEW_STALL_LOG_REGEX } from "../utils/findInReviewStallLogEntry";
import { getTaskLogEntryAction, getTaskLogEntryOutcome } from "../utils/taskLogEntryDisplay";
import { getRelativeTimeBucket } from "../utils/relativeTimeAgo";
import { isReviewBudgetExhaustedApproval } from "../utils/reviewBudgetApproval";
import { ACTIVE_STATUSES, resolveEffectiveExecutor, resolveEffectivePlanning, resolveEffectiveValidator, type ModelSelection } from "./effective-model-resolution";
import { TaskContextMenu, buildTaskActionMenuModel, getTaskPrAutomationLabel } from "./TaskContextMenu";
import { FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT } from "./FloatingWindow";
import { useFileBrowser } from "../context/FileBrowserContext";
import type { DetailTaskInitialActionRequest } from "../hooks/useModalManager";

const STALE_PAUSED_REVIEW_LOG_REGEX = /^Stale paused review surfaced \[([^\]]+)\]/;
const EMPTY_MARKDOWN_CHILD_SEPARATOR = "";
const STRING_OBJECT_TAG = "[object String]";
const ACTIVITY_VIEW_MENU_VIEWPORT_PADDING = 16;
const ACTIVITY_VIEW_MENU_TRIGGER_GAP = 4;
const ACTIVITY_VIEW_MENU_MIN_WIDTH = 160;
const ACTIVITY_VIEW_MENU_MIN_HEIGHT = 120;
const ACTIVITY_VIEW_MENU_MAX_HEIGHT = 320;
const ACTIVITY_VIEW_MENU_OPEN_VIEWPORT_GUARD_MS = 350;
// FNXC:TaskDetailSwipeBack 2026-07-05-12:30: FN-7587 — mobile breakpoint gating the presentation-only predictive-back slide/fade transition on the modal/list/nested task-detail surface; matches the `@media (max-width: 768px)` convention already used in this file.
// FNXC:PlannerOversight 2026-07-05-00:00: FN-7604 — the OVERSIGHT_MENU_MOBILE_BREAKPOINT constant (formerly used to branch the oversight controls between an inline cluster and this overflow menu) was removed; the overflow-menu dropdown is now the single universal surface at every viewport, so no breakpoint gates it.
const TASK_DETAIL_MOBILE_TRANSITION_BREAKPOINT = 768;

type ActivityViewMenuPosition = {
  top: number;
  left: number;
  minWidth: number;
  maxHeight: number;
};

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

type TabId = "summary" | "cost" | "definition" | "chat" | "planner-chat" | "logs" | "changes" | "review" | "pr" | "comments" | "model" | "workflow" | "documents" | "stats" | "routing" | "retries" | "terminal" | "worktree-terminal" | `plugin-${string}`;
type ActivitySegment = "current" | "feed" | "raw-logs" | "interventions";

/*
FNXC:TaskDetailActivityTab 2026-06-30-00:00:
The existing task activity/steering surface keeps the stable internal `chat` tab id for deep-link/plugin compatibility, but its top-level user-facing label is Activity. Done tasks keep Summary as their omitted-initial-tab landing surface so completed work still opens on the completion report.

FNXC:TaskDetailPlannerChat 2026-06-30-22:30:
Task detail separates Activity from planner-model Chat. `chat` remains the legacy Activity id for old links and Activity → Live (internal `current`)/Feed/Raw Logs/steering, while `planner-chat` is the top-level Chat tab for task-aware planning conversation.

FNXC:TaskDetailActivityFirst 2026-06-30-23:59:
Task details are Activity-first by default: render Activity before planner Chat and make omitted non-done opens land on Activity → Live. The project `taskDetailChatFirst` setting restores Chat-first ordering/default when true; explicit `initialTab` deep links always win.

FNXC:TaskDetailActivity 2026-06-30-15:50:
Only an omitted initial tab is the implicit default. Preserve explicit `initialTab="chat"` requests from plugins and task-detail entrypoints so existing links continue to open Activity → Live (internal `current`). Legacy `initialTab="logs"` now routes to Activity → Feed, and Raw Logs remains an Activity segment.

FNXC:TaskDetailActivity 2026-06-30-21:55:
The first Activity segment keeps the stable internal `current` id for legacy segment tests and links, but its embedded composer labels the operational steering-comment affordance explicitly. Do not reuse this segment as planner-model Chat conversation; that belongs to the `planner-chat` top-level tab.

FNXC:TaskDetailActivity 2026-06-30-23:55:
The first Activity segment is user-facing Live while legacy internals remain `current` and explicit `initialTab="chat"` continues landing there for compatibility.

FNXC:TaskDetailActivity 2026-06-30-23:59:
Activity view switching lives in the top-level Activity tab dropdown for Live, Feed, and Raw while retaining the internal `current`, `feed`, and `raw-logs` segment ids. Legacy `chat` and `logs` initial-tab routing remains compatible so older links still open Activity → Live or Activity → Feed.
*/
function resolveDefaultTab(initialTab: TabId | undefined, column: ColumnId, taskDetailChatFirst = false): TabId {
  if (initialTab === "retries") {
    return "definition";
  }
  if (initialTab === "logs") {
    return "chat";
  }
  if (initialTab) {
    return initialTab;
  }
  if (column === "done") {
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
  onClose: () => void;
  onOpenDetail: (task: Task | TaskDetail) => void; // For clicking dependencies
  onMoveTask: (id: string, column: Column, optionsOrPosition?: { preserveProgress?: boolean } | number) => Promise<Task>;
  onDeleteTask: (id: string, options?: {
    removeDependencyReferences?: boolean;
    removeLineageReferences?: boolean;
    githubIssueAction?: GithubIssueAction;
    allowResurrection?: boolean;
  }) => Promise<Task>;
  onArchiveTask?: (id: string, options?: { removeLineageReferences?: boolean }) => Promise<Task>;
  /* FNXC:TaskRevert 2026-07-05-00:00 (FN-7525): threaded alongside onArchiveTask; never mutates the source task's column. */
  onRevertTask?: (id: string, body?: RevertTaskOptions) => Promise<RevertTaskResult>;
  onMergeTask: (id: string) => Promise<MergeResult>;
  onRetryTask?: (id: string) => Promise<Task>;
  /*
  FNXC:ReviewLaneBypass 2026-07-09-00:00:
  Operator-only review-lane bypass (FN-7720). Only wired here (Task Detail) so
  it never appears in the Board/List card context menus — single canonical
  affordance surface for this policy-gated escape hatch.
  */
  onBypassReview?: (id: string, reason: string) => Promise<Task>;
  onResetTask?: (id: string) => Promise<Task>;
  onDuplicateTask?: (id: string) => Promise<Task>;
  onTaskUpdated?: (task: Task) => void;
  addToast: (message: string, type?: ToastType) => void;
  prAuthAvailable?: boolean;
  autoMergeEnabled?: boolean;
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
   *  When provided (e.g. threaded from a Board that already holds the payload)
   *  the modal skips its own board-workflows fetch entirely. Falls back to the
   *  self-fetch when absent (e.g. modal opened from non-board contexts). */
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
  onPopOut, when supplied, renders a Maximize2 "Pop out" button in the gray header. List/Board wire it to push this task into App's floating task-detail window array, opening the same embedded TaskDetailContent inside a movable, resizable, non-blocking FloatingWindow. It is independent of embedded/onBackToBoard so List split-pane and the board full-panel can both expose it.
  */
  onPopOut?: (task: Task) => void;
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

function resolveTaskWorkflowMetadata(payload: BoardWorkflowsPayload, taskId: string): { id: string; name: string; icon?: string; fields: WorkflowFieldDefinition[] | null } | null {
  if (payload.flagEnabled !== true) return null;
  const workflowId = payload.taskWorkflowIds[taskId] ?? payload.defaultWorkflowId;
  const workflow = payload.workflows.find((candidate) => candidate.id === workflowId);
  const name = workflow?.name?.trim();
  if (!workflow || !name) return null;
  return { id: workflow.id, name, icon: workflow.icon, fields: workflow.fields ?? null };
}

function normalizeExecutionModeValue(executionMode: Task["executionMode"]): "standard" | "fast" {
  return executionMode === "fast" ? "fast" : "standard";
}

function requiresExecutionModeReplan(column: Task["column"]): boolean {
  /*
   FNXC:ExecutionModeReplan 2026-06-30-00:00:
   Todo and in-progress tasks can already hold a generated plan or active execution context. Changing Standard/Fast mode invalidates that plan, so the dashboard must confirm the change and send the task back through the existing replanning path instead of silently patching executionMode in place.
   */
  return column === "todo" || column === "in-progress";
}

interface ProvenanceDisplay {
  label: string;
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

function parseGithubIssueLabel(url: string): { label: string; href: string } | null {
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:$|[/?#])/);
  if (!match) {
    return null;
  }

  const [, owner, repo, , number] = match;
  return {
    label: `${owner}/${repo}#${number}`,
    href: url,
  };
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
      const parsedIssue = issueUrl ? parseGithubIssueLabel(issueUrl) : null;
      return {
        label: tr ? tr("taskDetail.provenance.githubImport", "GitHub Import") : "GitHub Import",
        contextInfo: issueUrl ? (parsedIssue?.label ?? (tr ? tr("taskDetail.provenance.openIssue", "Open issue") : "Open issue")) : undefined,
        contextHref: issueUrl,
        contextInfoFull: issueUrl,
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
      return { label: tr ? tr("taskDetail.provenance.api", "API") : "API" };
    case "recovery":
      return { label: tr ? tr("taskDetail.provenance.recovery", "Recovery") : "Recovery" };
    case "unknown":
    default:
      return null;
  }
}

// #1403: widened to ColumnId so `.has(task.column)` accepts custom column ids
// (non-members correctly resolve to false → not editable).
const EDITABLE_COLUMNS: Set<ColumnId> = new Set<ColumnId>(["triage", "todo"]);
const GITHUB_TRACKING_EDITABLE_COLUMNS: Set<ColumnId> = new Set<ColumnId>(["triage", "todo", "in-progress", "in-review"]);

export function TaskDetailContent({
  task,
  projectId,
  tasks = [],
  onOpenDetail,
  onMoveTask,
  onDeleteTask,
  onArchiveTask,
  onRevertTask,
  onMergeTask,
  onRetryTask,
  onBypassReview,
  onResetTask,
  onDuplicateTask,
  onTaskUpdated,
  addToast,
  prAuthAvailable,
  autoMergeEnabled: autoMergeEnabledProp,
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

  useEffect(() => {
    // If the prop already has a prompt field, it's a full TaskDetail
    if ("prompt" in task) {
      setFullDetail(task as TaskDetail);
      setDetailLoading(false);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    setFullDetail(null);

    fetchTaskDetail(task.id, projectId)
      .then((detail) => {
        if (!cancelled) {
          setFullDetail(detail);
          setDetailLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDetailLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [task.id, projectId]);

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
      ...fullDetail,
      ...task,
      prompt: fullDetail.prompt,
      log: fullDetail.log,
      githubTracking: task.githubTracking ?? fullDetail.githubTracking,
      gitlabTracking: task.gitlabTracking ?? fullDetail.gitlabTracking,
      assignedAgentId: task.assignedAgentId === undefined ? fullDetail.assignedAgentId : task.assignedAgentId,
      checkedOutBy: task.checkedOutBy === undefined ? fullDetail.checkedOutBy : task.checkedOutBy,
      status: task.status === undefined ? fullDetail.status : task.status,
      column: task.column === undefined ? fullDetail.column : task.column,
      paused: task.paused === undefined ? fullDetail.paused : task.paused,
      userPaused: task.userPaused === undefined ? fullDetail.userPaused : task.userPaused,
      pausedReason: task.pausedReason === undefined ? fullDetail.pausedReason : task.pausedReason,
      /*
      FNXC:TaskDetailOverlapRepair 2026-06-25-04:34:
      SSE task props are authoritative for live blocker changes, but the Clear repair flow needs a local override while stale parent props catch up. Only fall back to fetched detail when the slim parent omitted the field entirely.
      */
      overlapBlockedBy: overlapBlockedByOverride !== undefined
        ? overlapBlockedByOverride
        : task.overlapBlockedBy === undefined ? fullDetail.overlapBlockedBy : task.overlapBlockedBy,
    } as TaskDetail)
    : ({ ...task, prompt: "" } as TaskDetail);
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
  const canRetryTask = isTaskManuallyRetryable(task);
  const nearDuplicateOf = isStringValue(workingTask.sourceMetadata?.nearDuplicateOf)
    ? workingTask.sourceMetadata.nearDuplicateOf
    : null;
  const nearDuplicateCanonical = nearDuplicateOf
    ? tasks.find((candidate) => candidate.id === nearDuplicateOf)
    : undefined;
  /**
   * FNXC:NearDuplicateDetection 2026-06-14-12:00:
   * The Archive/Keep decision banner is actionable only while the referenced canonical exists and is active.
   * Suppress the whole affordance for missing, archived, done, or soft-deleted canonicals so no empty banner shell or stale user-decision buttons remain.
   */
  // FNXC:DuplicateIntake 2026-07-16-13:00: Issue #2225 reuses this linked banner for triage-marker Keep/Delete decisions.
  const isTriageMarkerDuplicate = workingTask.sourceMetadata?.duplicateSource === "triage-marker";
  const showNearDuplicateWarning = Boolean(nearDuplicateOf)
    && workingTask.sourceMetadata?.nearDuplicateDismissed !== true
    && task.column !== "archived"
    && task.column !== "done"
    && !isNearDuplicateCanonicalInactive(nearDuplicateCanonical);
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
   * (open board columns only) so a done/archived/soft-deleted prior undo attempt never renders as
   * an active "Undo task" link — that would be a stale/leftover affordance.
   */
  const openUndoTask = findOpenUndoTaskForSource(tasks, workingTask.id);

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
    if (initialTab === "retries") {
      setRetriesExpanded(true);
    }
  }, [initialTab]);

  useEffect(() => {
    if (activeTab === "pr" && task.column !== "in-review") {
      setActiveTab("definition");
    }
  }, [activeTab, task.column]);

  useEffect(() => {
    if (activeTab === "summary" && task.column !== "done") {
      setActiveTab("definition");
    }
  }, [activeTab, task.column]);

  // Reset description and planner-chat focus state when task changes
  useEffect(() => {
    setDescriptionExpanded(false);
    setPlannerChatExpanded(false);
  }, [task.column, task.id]);

  const [highlightStallCode, setHighlightStallCode] = useState<string | null>(null);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [titleOverflows, setTitleOverflows] = useState(false);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const displayTitleText = task.title || task.description || task.id;
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
  const [prCreateOpen, setPrCreateOpen] = useState(false);

  useLayoutEffect(() => {
    const titleElement = titleRef.current;
    if (!titleElement) {
      setTitleOverflows(false);
      return;
    }

    const measureTitleOverflow = () => {
      let addedCollapsedClass = false;
      if (descriptionExpanded && !titleElement.classList.contains("detail-title--collapsed")) {
        titleElement.classList.add("detail-title--collapsed");
        addedCollapsedClass = true;
      }

      const overflows = titleElement.scrollHeight > titleElement.clientHeight + 1;

      if (addedCollapsedClass) {
        titleElement.classList.remove("detail-title--collapsed");
      }

      setTitleOverflows(overflows);
    };

    measureTitleOverflow();

    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(measureTitleOverflow)
      : null;
    resizeObserver?.observe(titleElement);
    window.addEventListener("resize", measureTitleOverflow);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measureTitleOverflow);
    };
  }, [descriptionExpanded, displayTitleText, task.id]);

  /*
  FNXC:WorkflowBadges 2026-06-29-00:00:
  Task details need a stable workflow-name badge because aggregate Board cards can mix tasks from multiple workflows. Resolve the badge name and custom field definitions from the same board-workflows payload so detail headers do not issue duplicate workflow-metadata fetches.
  */
  const [taskWorkflowBadge, setTaskWorkflowBadge] = useState<{ id: string; name: string; icon?: string } | null>(null);
  // Custom field definitions (U13/KTD-14). Resolved for this task's workflow
  // from the board-workflows payload; absent when the workflow declares none,
  // in which case the fields section renders nothing (today's UI byte-identical).
  // When `workflowFieldDefsProp` is provided by the caller (e.g. the Board
  // already holds the payload) we skip the self-fetch entirely.
  const [customFieldDefs, setCustomFieldDefs] = useState<WorkflowFieldDefinition[] | null>(
    workflowFieldDefsProp !== undefined ? (workflowFieldDefsProp ?? null) : null,
  );
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, unknown>>(task.customFields ?? {});
  const [customFieldError, setCustomFieldError] = useState<CustomFieldRejection | null>(null);

  // Keep local field values in sync when the task prop changes (SSE refresh).
  useEffect(() => {
    setCustomFieldValues(task.customFields ?? {});
  }, [task.id, task.customFields]);

  // Resolve this task's workflow field definitions and display name once per task. Skipped when
  // the caller supplies `workflowFieldDefs` directly (Board context). Best-effort:
  // a failed fetch (or flag-OFF empty payload) leaves defs/name null → no section/badge.
  useEffect(() => {
    if (workflowFieldDefsProp !== undefined) {
      // Prop-driven path: keep in sync if the prop changes (task switch etc.).
      setCustomFieldDefs(workflowFieldDefsProp ?? null);
      setTaskWorkflowBadge(null);
      return;
    }
    /*
    FNXC:WorkflowBadges 2026-06-29-16:48:
    Mounted task-detail hosts can swap from one task to another (List split-pane, right dock, floating windows). Clear the previous workflow badge before the shared board-workflows lookup resolves so aggregate-board context never shows a stale cross-workflow label.
    */
    setCustomFieldDefs(null);
    setTaskWorkflowBadge(null);
    let cancelled = false;
    void fetchBoardWorkflows(projectId)
      .then((payload) => {
        if (cancelled) return;
        const metadata = resolveTaskWorkflowMetadata(payload, task.id);
        setCustomFieldDefs(metadata?.fields ?? null);
        setTaskWorkflowBadge(metadata ? { id: metadata.id, name: metadata.name, icon: metadata.icon } : null);
      })
      .catch(() => {
        if (!cancelled) {
          setCustomFieldDefs(null);
          setTaskWorkflowBadge(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, projectId, workflowFieldDefsProp]);

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
  const [editDependencies, setEditDependencies] = useState<string[]>(task.dependencies || []);
  const [editBranch, setEditBranch] = useState(task.branch ?? "");
  const [editBaseBranch, setEditBaseBranch] = useState(task.baseBranch ?? "");
  const [editExecutorModel, setEditExecutorModel] = useState("");
  const [editValidatorModel, setEditValidatorModel] = useState("");
  const [editPlanningModel, setEditPlanningModel] = useState("");
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
  const [showInlinePriorityPicker, setShowInlinePriorityPicker] = useState(false);
  const inlinePriorityPickerRef = useRef<HTMLDivElement>(null);
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
  /*
  FNXC:PlannerOversight 2026-07-04-19:00:
  FN-7545 — collapse the oversight action controls into an overflow menu so
  the detail control bar fits narrow viewports; menu never renders an empty
  shell when oversight is off/inactive.

  FNXC:PlannerOversight 2026-07-05-00:00:
  FN-7604 — the overflow menu is now the single universal surface at every
  viewport (desktop and mobile); the `isOversightMenuMobile` resize-driven
  branch selector was removed since there is no longer a second branch to
  select between.
  */
  const [showOversightMenu, setShowOversightMenu] = useState(false);
  const oversightMenuRef = useRef<HTMLDivElement>(null);
  const oversightMenuButtonRef = useRef<HTMLButtonElement>(null);
  const { confirm, confirmWithChoice, confirmWithCheckbox } = useConfirm();
  const requestClose = useCallback(() => {
    onRequestClose?.();
  }, [onRequestClose]);
  const mountedRef = useRef(false);
  const activeTaskIdRef = useRef(task.id);

  // Split-menu dropdown state for footer actions
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const [showActionsMenu, setShowActionsMenu] = useState(false);
  const [showActivityViewMenu, setShowActivityViewMenu] = useState(false);
  const [activityViewMenuPosition, setActivityViewMenuPosition] = useState<ActivityViewMenuPosition | null>(null);
  const [sourceIssueExpanded, setSourceIssueExpanded] = useState(false);
  const [retriesExpanded, setRetriesExpanded] = useState(initialTab === "retries");
  const [gitlabTrackingExpanded, setGitlabTrackingExpanded] = useState(false);
  // FNXC:TaskDetailPlan 2026-07-04-00:00: Original prompt is collapsed by default (see render site below); operator must click the chevron toggle to reveal the markdown-rendered text.
  const [originalPromptExpanded, setOriginalPromptExpanded] = useState(false);
  const [githubTrackingExpanded, setGithubTrackingExpanded] = useState(false);
  const [githubRepoOverrideDraft, setGithubRepoOverrideDraft] = useState(task.githubTracking?.repoOverride ?? "");
  const [githubTrackingEnabledDraft, setGithubTrackingEnabledDraft] = useState<boolean | null>(null);
  const [githubRepoOverrideError, setGithubRepoOverrideError] = useState<string | null>(null);
  const [isSavingGithubTracking, setIsSavingGithubTracking] = useState(false);
  const [isCheckingPrStatus, setIsCheckingPrStatus] = useState(false);
  const moveMenuRef = useRef<HTMLDivElement>(null);
  const activityListRef = useRef<HTMLDivElement>(null);
  const moveButtonRef = useRef<HTMLButtonElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const activityViewDropdownRef = useRef<HTMLDivElement>(null);
  const activityViewMenuRef = useRef<HTMLDivElement>(null);
  const activityViewButtonRef = useRef<HTMLButtonElement>(null);
  const activityViewMenuViewportGuardUntilRef = useRef(0);

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
  const [workflowEnabledSteps, setWorkflowEnabledSteps] = useState<string[] | undefined>(task.enabledWorkflowSteps);
  const isNodeOverrideLocked = task.column === "in-progress" || ACTIVE_STATUSES.has(task.status as string);

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
    setGithubTrackingExpanded(false);
    setGithubRepoOverrideDraft(workingTask.githubTracking?.repoOverride ?? "");
    setGithubTrackingEnabledDraft(null);
    setGithubRepoOverrideError(null);
    setIsEditing(false);
  }, [task.id, task.title, task.description, task.branch, task.baseBranch, task.sourceIssue, task.executionMode, workingTask.githubTracking]);

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

  // Load workflow results when workflow tab is active
  useEffect(() => {
    if (activeTab !== "workflow") return;
    let cancelled = false;
    /*
    FNXC:TaskWorkflowDetails 2026-06-26-01:43:
    A mounted task-detail Workflow tab can switch from one task to another while the previous result list is visible. Clear results before the new fetch so live step/stage details never flash stale rows from another task while cancellation protects the in-flight request.
    */
    setWorkflowResults([]);
    setWorkflowResultsLoading(true);
    fetchWorkflowResults(task.id, projectId)
      .then((results) => {
        if (!cancelled) setWorkflowResults(results);
      })
      .catch((err) => {
        if (!cancelled) {
          addToast(t("taskDetail.workflow.loadFailed", "Failed to load workflow results: {{error}}", { error: getErrorMessage(err) }), "error");
        }
      })
      .finally(() => {
        if (!cancelled) setWorkflowResultsLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeTab, task.id, projectId, addToast]);

  // Subscribe to SSE for real-time workflow result updates while workflow tab is active
  useEffect(() => {
    if (activeTab !== "workflow") return;

    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

    const handleTaskUpdated = (e: MessageEvent) => {
      try {
        const updatedTask = JSON.parse(e.data);
        // Only update if this is for our task and has workflow step results
        if (updatedTask.id === task.id && Array.isArray(updatedTask.workflowStepResults)) {
          setWorkflowResults(updatedTask.workflowStepResults);
        }
      } catch {
        // Skip malformed events
      }
    };

    return subscribeSse(`/api/events${query}`, {
      events: { "task:updated": handleTaskUpdated },
    });
  }, [activeTab, task.id, projectId]);

  // Load the CLI agent session for this task (drives the terminal tab + matrix).
  useEffect(() => {
    let cancelled = false;
    const search = new URLSearchParams({ taskId: task.id });
    if (projectId) search.set("projectId", projectId);
    void api<{ sessions: CliSessionSummaryRecord[] }>(`/cli-sessions?${search.toString()}`)
      .then((res) => {
        if (cancelled) return;
        // Most-recent session for the task (the list is store-ordered).
        const sessions = res.sessions ?? [];
        setCliSession(sessions.length > 0 ? sessions[sessions.length - 1] : null);
      })
      .catch(() => {
        if (!cancelled) setCliSession(null);
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, projectId]);

  // Live CLI session state via SSE — MERGE payload fields onto the record
  // (never wholesale-replace: the list fetch carries enriched fields the SSE
  // payload omits, e.g. adapterId / autonomyPosture).
  useEffect(() => {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
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
    return subscribeSse(`/api/events${query}`, {
      events: { "cli:session:state": handleCliState },
    });
  }, [task.id, projectId]);

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

  // Close task-detail dropdown menus on outside click
  useEffect(() => {
    const hasOpenMenu = showMoveMenu || showActionsMenu || showActivityViewMenu || showOversightMenu || showInlinePriorityPicker;
    if (!hasOpenMenu) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const inMoveMenu = moveMenuRef.current?.contains(target);
      const inActionsMenu = actionsMenuRef.current?.contains(target);
      const inActivityViewMenu = activityViewMenuRef.current?.contains(target) || activityViewButtonRef.current?.contains(target);
      const inOversightMenu = oversightMenuRef.current?.contains(target) || oversightMenuButtonRef.current?.contains(target);
      const inInlinePriorityPicker = inlinePriorityPickerRef.current?.contains(target);

      if (!inMoveMenu && showMoveMenu) {
        setShowMoveMenu(false);
      }
      if (!inActionsMenu && showActionsMenu) {
        setShowActionsMenu(false);
      }
      if (!inActivityViewMenu && showActivityViewMenu) {
        activityViewMenuViewportGuardUntilRef.current = 0;
        setShowActivityViewMenu(false);
        setActivityViewMenuPosition(null);
      }
      if (!inOversightMenu && showOversightMenu) {
        setShowOversightMenu(false);
      }
      if (!inInlinePriorityPicker && showInlinePriorityPicker) {
        setShowInlinePriorityPicker(false);
      }
    };

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showMoveMenu, showActionsMenu, showActivityViewMenu, showOversightMenu, showInlinePriorityPicker]);

  // Close task-detail dropdown menus on Escape key (before modal Escape handler)
  useEffect(() => {
    const hasOpenMenu = showMoveMenu || showActionsMenu || showActivityViewMenu || showOversightMenu || showInlinePriorityPicker;
    if (!hasOpenMenu) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation(); // Prevent modal from closing
        if (showMoveMenu) setShowMoveMenu(false);
        if (showActionsMenu) setShowActionsMenu(false);
        if (showActivityViewMenu) {
          activityViewMenuViewportGuardUntilRef.current = 0;
          setShowActivityViewMenu(false);
          setActivityViewMenuPosition(null);
        }
        if (showOversightMenu) {
          setShowOversightMenu(false);
        }
        if (showInlinePriorityPicker) {
          setShowInlinePriorityPicker(false);
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showMoveMenu, showActionsMenu, showActivityViewMenu, showOversightMenu, showInlinePriorityPicker]);

  // Reset spec edit state when task changes
  useEffect(() => {
    setIsEditingSpec(false);
    setSpecEditContent(workingTask.prompt || "");
    setSpecFeedback("");
  }, [task.id, workingTask.prompt]);

  // Note: TaskForm handles auto-focus internally via isActive prop

  // Check if task can be edited
  const canEdit = EDITABLE_COLUMNS.has(task.column) && !isSaving;
  const canEditGithubTracking = GITHUB_TRACKING_EDITABLE_COLUMNS.has(task.column) && !isSaving;
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
    setEditValidatorModel(valModel);
    setEditPlanningModel(planModel);
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
    }

    const validatorSelection = splitModelSelection(editValidatorModel);
    const currentValidatorModel = task.validatorModelProvider && task.validatorModelId ? `${task.validatorModelProvider}/${task.validatorModelId}` : "";
    if (editValidatorModel !== currentValidatorModel) {
      updates.validatorModelProvider = validatorSelection?.provider ?? null;
      updates.validatorModelId = validatorSelection?.modelId ?? null;
    }

    const planningSelection = splitModelSelection(editPlanningModel);
    const currentPlanningModel = task.planningModelProvider && task.planningModelId ? `${task.planningModelProvider}/${task.planningModelId}` : "";
    if (editPlanningModel !== currentPlanningModel) {
      updates.planningModelProvider = planningSelection?.provider ?? null;
      updates.planningModelId = planningSelection?.modelId ?? null;
    }

    const currentThinkingLevel = task.thinkingLevel ?? "";
    if (editThinkingLevel !== currentThinkingLevel) updates.thinkingLevel = editThinkingLevel !== "" ? (editThinkingLevel as "minimal" | "low" | "medium" | "high" | "xhigh") : null;
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
  }, [editBaseBranch, editBranch, editDependencies, editDescription, editExecutionMode, editExecutorModel, editNodeId, editPlanningModel, editPriority, editReviewLevel, editSelectedWorkflowSteps, editSourceIssueExternalId, editSourceIssueProvider, editSourceIssueRepository, editSourceIssueUrl, editThinkingLevel, editPlannerOversightLevel, editTitle, editValidatorModel, task]);

  const persistEditChanges = useCallback(async (includeDescription: boolean) => {
    const { updates, error } = buildEditUpdates(includeDescription);
    if (!updates) {
      setEditAutoSaveStatus("error");
      if (error) {
        addToast(t("taskDetail.updateFailed", "Failed to update {{id}}: {{error}}", { id: task.id, error }), "error");
      }
      return false;
    }
    const replanAfterExecutionModeChange = Object.prototype.hasOwnProperty.call(updates, "executionMode") && requiresExecutionModeReplan(task.column);
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
  }, [addToast, buildEditUpdates, confirm, onTaskUpdated, projectId, requestClose, task.column, task.executionMode, task.id]);

  const handleAutoSaveDescription = useCallback(async (_description: string) => {
    await persistEditChanges(true);
  }, [persistEditChanges]);

  const handleSave = useCallback(async () => {
    editSaveTriggeredReplanRef.current = false;
    const didSave = await persistEditChanges(true);
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
    editValidatorModel,
    editPlanningModel,
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
    const shouldReplan = requiresExecutionModeReplan(task.column);

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
  }, [task.id, task.column, task.executionMode, projectId, inlineExecutionMode, onTaskUpdated, addToast, confirm, requestClose]);

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
    task.status === "failed" || (activeTab === "chat" && activitySegment === "raw-logs"),
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

  const handleMove = useCallback(
    async (column: Column) => {
      try {
        const hasStepProgress = task.steps.some((step) => step.status !== "pending");
        const shouldPrompt = (column === "todo" || column === "triage") && hasStepProgress;

        let moveOptions: { preserveProgress?: boolean } | undefined;
        if (shouldPrompt) {
          const keepProgress = await confirm({
            title: t("taskDetail.move.preserveProgressTitle", "Preserve Progress?"),
            message: t("taskDetail.move.preserveProgressMessage", "This task has completed steps. Keep progress before moving?"),
            confirmLabel: t("taskDetail.move.keepProgress", "Keep Progress"),
            cancelLabel: t("taskDetail.move.resetProgress", "Reset Progress"),
          });

          if (keepProgress) {
            moveOptions = { preserveProgress: true };
          } else {
            const resetProgress = await confirm({
              title: t("taskDetail.move.resetProgressTitle", "Reset Progress?"),
              message: t("taskDetail.move.resetProgressMessage", "Reset all step progress before moving this task?"),
              confirmLabel: t("taskDetail.move.resetProgress", "Reset Progress"),
              cancelLabel: t("taskDetail.move.cancelMove", "Cancel Move"),
              danger: true,
            });
            if (!resetProgress) {
              return;
            }
          }
        }

        await onMoveTask(task.id, column, moveOptions);
        requestClose();
        addToast(t("taskDetail.move.movedTo", "Moved to {{column}}", { column: columnLabel(column) }), "success");
      } catch (err) {
        addToast(getErrorMessage(err), "error");
      }
    },
    [task.id, task.steps, onMoveTask, requestClose, addToast, confirm],
  );

  const handleDelete = useCallback(async () => {
    let allowResurrection = false;
    let deleteCloseRequested = false;
    const closeBeforeDeleteRequest = () => {
      if (deleteCloseRequested) {
        return;
      }
      /*
      FNXC:TaskDetailDelete 2026-07-01-09:40:
      Task detail hosts must close optimistically after the operator completes every required delete prompt and before each server delete request starts. Keep this helper idempotent so dependency/lineage retries preserve async prompts and toasts without reopening or repeatedly closing the modal, main panel, list split, or right-dock host.
      */
      requestClose();
      deleteCloseRequested = true;
    };

    if (task.column !== "archived" && onArchiveTask) {
      const deleteChoice = await confirmWithChoice({
        title: t("taskDetail.delete.title", "Delete Task"),
        message: t("taskDetail.delete.message", "Delete {{id}}?", { id: task.id }),
        confirmLabel: t("taskDetail.delete.confirm", "Delete"),
        cancelLabel: t("common.cancel", "Cancel"),
        tertiaryLabel: t("taskDetail.delete.archiveInstead", "Archive Instead"),
        danger: true,
      });
      if (deleteChoice === "tertiary") {
        try {
          await onArchiveTask(task.id);
          addToast(t("taskDetail.nearDuplicate.archived", "Archived {{id}}", { id: task.id }), "success");
          requestClose();
        } catch (err) {
          const lineageConflict = extractLineageDeleteConflict(err);
          if (!lineageConflict || lineageConflict.lineageChildIds.length === 0) {
            addToast(getErrorMessage(err), "error");
            return;
          }

          const confirmedArchive = await confirm({
            title: t("taskDetail.delete.forceDeleteTitle", "Force Delete Task"),
            message:
              `${task.id} has lineage children (${lineageConflict.lineageChildIds.join(", ")}) that reference it as a source parent.\n\n` +
              t("taskDetail.delete.archiveUnlinkPrompt", "Archive anyway by unlinking these references first?"),
            danger: true,
          });
          if (!confirmedArchive) {
            return;
          }

          try {
            await onArchiveTask(task.id, { removeLineageReferences: true });
            addToast(t("taskDetail.delete.archivedAfterUnlink", "Archived {{id}} after unlinking lineage references", { id: task.id }), "success");
            requestClose();
          } catch (retryErr) {
            addToast(getErrorMessage(retryErr), "error");
          }
        }
        return;
      }
      if (deleteChoice !== "primary") {
        return;
      }
    } else {
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
    }

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
      closeBeforeDeleteRequest();
      if (githubIssueAction) {
        await onDeleteTask(task.id, { githubIssueAction, allowResurrection });
      } else {
        await onDeleteTask(task.id, { allowResurrection });
      }
      const issueSuffix = trackedIssue?.owner && trackedIssue.repo && trackedIssue.number && githubIssueAction
        ? ` ${t("taskDetail.delete.issueSuffix", "and {{action}} issue {{ref}}", { action: githubIssueAction === "close" ? t("taskDetail.delete.actionClosed", "closed") : githubIssueAction === "delete" ? t("taskDetail.delete.actionDeleted", "deleted") : t("taskDetail.delete.actionLeft", "left"), ref: `${trackedIssue.owner}/${trackedIssue.repo}#${trackedIssue.number}` })}`
        : "";
      addToast(t("taskDetail.delete.deletedToast", "Deleted {{id}}{{suffix}}", { id: task.id, suffix: issueSuffix }), "info");
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
  }, [task.column, task.githubTracking?.enabled, task.githubTracking?.issue, task.id, onDeleteTask, onArchiveTask, requestClose, addToast, confirm, confirmWithChoice, confirmWithCheckbox]);

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

  const handleRetry = useCallback(() => {
    if (!onRetryTask) return;
    requestClose();
    onRetryTask(task.id)
      .then(() => {
        addToast(t("taskDetail.retry.retried", "Retried {{id}}", { id: task.id }), "success");
      })
      .catch((err) => {
        addToast(getErrorMessage(err), "error");
      });
  }, [task.id, onRetryTask, requestClose, addToast, t]);

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
  */
  const handleRetryWithOverride = useCallback(async () => {
    if (!onRetryTask || isFailureRetrySaving) return;
    const modelSelection = splitModelSelection(failureRetryModel);
    const currentModel = task.modelProvider && task.modelId ? `${task.modelProvider}/${task.modelId}` : "";
    const hasModelChange = failureRetryModel !== currentModel;
    const hasNodeChange = failureRetryNodeId !== (task.nodeId ?? "");
    if (!hasModelChange && !hasNodeChange) return;

    setIsFailureRetrySaving(true);
    try {
      const updatedTask = await updateTask(task.id, {
        ...(hasModelChange ? { modelProvider: modelSelection?.provider ?? null, modelId: modelSelection?.modelId ?? null } : {}),
        ...(hasNodeChange ? { nodeId: failureRetryNodeId || null } : {}),
      }, projectId);
      onTaskUpdated?.(updatedTask);
      await onRetryTask(task.id);
      addToast(t("taskDetail.retry.retried", "Retried {{id}}", { id: task.id }), "success");
      requestClose();
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    } finally {
      if (mountedRef.current) setIsFailureRetrySaving(false);
    }
  }, [addToast, failureRetryModel, failureRetryNodeId, isFailureRetrySaving, onRetryTask, onTaskUpdated, projectId, requestClose, t, task.id, task.modelId, task.modelProvider, task.nodeId]);

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

  const handleReset = useCallback(async () => {
    if (!onResetTask) return;
    const shouldReset = await confirm({
      title: t("taskDetail.reset.btn", "Reset"),
      message: t("taskDetail.reset.confirmMessage", "This will erase all progress for {{id}} and start the task from scratch. Continue?", { id: task.id }),
      confirmLabel: t("taskDetail.reset.btn", "Reset"),
      cancelLabel: t("common.cancel", "Cancel"),
      danger: true,
    });
    if (!shouldReset) return;
    requestClose();
    try {
      await onResetTask(task.id);
      addToast(t("taskDetail.reset.resetSuccess", "Reset {{id}} — fresh run will be allocated", { id: task.id }), "success");
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, onResetTask, requestClose, addToast, confirm, t]);

  const handleDuplicate = useCallback(async () => {
    if (!onDuplicateTask) return;
    const shouldDuplicate = await confirm({
      title: t("taskDetail.duplicate.title", "Duplicate Task"),
      message: t("taskDetail.duplicate.message", "Duplicate {{id}}? This will create a new task in Triage with the same description and prompt.", { id: task.id }),
    });
    if (!shouldDuplicate) return;
    try {
      const newTask = await onDuplicateTask(task.id);
      requestClose();
      addToast(t("taskDetail.duplicate.success", "Duplicated {{id}} → {{newId}}", { id: task.id, newId: newTask.id }), "success");
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, onDuplicateTask, requestClose, addToast, confirm]);

  const handleDismissNearDuplicate = useCallback(async () => {
    try {
      const updatedTask = await updateTask(task.id, { dismissNearDuplicate: true }, projectId);
      onTaskUpdated?.(updatedTask);
      addToast(t("taskDetail.nearDuplicate.kept", "Kept {{id}} and dismissed duplicate warning", { id: task.id }), "success");
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, projectId, onTaskUpdated, addToast]);

  const handleArchiveNearDuplicate = useCallback(async () => {
    if (!onArchiveTask) return;
    const confirmed = await confirm({
      title: t("taskDetail.nearDuplicate.archiveTitle", "Archive near-duplicate task"),
      message: t("taskDetail.nearDuplicate.archiveMessage", "Archive {{id}} as a duplicate of {{duplicateOf}}?", { id: task.id, duplicateOf: nearDuplicateOf }),
      confirmLabel: t("taskDetail.nearDuplicate.archiveConfirm", "Archive"),
      cancelLabel: t("common.cancel", "Cancel"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await onArchiveTask(task.id);
      addToast(t("taskDetail.nearDuplicate.archived", "Archived {{id}}", { id: task.id }), "success");
      requestClose();
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [onArchiveTask, confirm, task.id, nearDuplicateOf, addToast, requestClose]);

  /*
   * FNXC:DuplicateIntake 2026-07-16-14:00:
   * Issue #2225 requires triage-marker duplicates to offer a real Keep/Delete decision.
   * Unlike the ordinary near-duplicate Archive action, Delete calls the existing soft-delete
   * API and clears incoming lineage references so the confirmed duplicate is actually removed.
   */
  const handleDeleteTriageDuplicate = useCallback(async () => {
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
  const isRevertable = (task.column === "done" || task.column === "archived")
    && Boolean(task.mergeDetails?.commitSha);

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
  const isAwaitingApproval = task.column === "triage" && task.status === "awaiting-approval";
  const isPlanReviewReplanCapApproval = isReviewBudgetExhaustedApproval(task);

  const handleTogglePause = useCallback(async () => {
    try {
      if (isTaskPaused) {
        await unpauseTask(task.id, projectId);
        addToast(t("taskDetail.pause.unpaused", "Unpaused {{id}}", { id: task.id }), "success");
      } else {
        await pauseTask(task.id, projectId);
        addToast(t("taskDetail.pause.paused", "Paused {{id}}", { id: task.id }), "success");
      }
      requestClose();
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [isTaskPaused, task.id, requestClose, addToast]);

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

  const handleRespecify = useCallback(async () => {
    const shouldRebuild = await confirm({
      title: t("taskDetail.plan.rebuildTitle", "Rebuild Plan"),
      message: t("taskDetail.plan.rebuildMessage", "Rebuild the plan for this task? The task will move to planning for replanning."),
    });
    if (!shouldRebuild) return;
    try {
      await rebuildTaskSpec(task.id, projectId);
      requestClose();
      addToast(t("taskDetail.plan.replanning", "Replanning {{id}}…", { id: task.id }), "info");
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, projectId, requestClose, addToast, confirm]);

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

  // Helper to close dropdown menus after action
  const closeMenus = useCallback(() => {
    setShowMoveMenu(false);
    setShowActionsMenu(false);
  }, []);

  // Menu item click handlers that close menus after action
  const handleMoveMenuItemClick = useCallback((column: Column) => {
    closeMenus();
    handleMove(column);
  }, [closeMenus]);

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
    if (refineFeedback.length > 2000) {
      addToast(t("taskDetail.refine.feedbackTooLong", "Feedback must be 2000 characters or less"), "error");
      return;
    }
    setIsRefining(true);
    try {
      const newTask = await refineTask(task.id, refineFeedback.trim(), projectId);
      addToast(t("taskDetail.refine.taskCreated", "Refinement task created: {{id}}", { id: newTask.id }), "success");
      requestClose();
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    } finally {
      setIsRefining(false);
    }
  }, [task.id, refineFeedback, addToast, requestClose]);

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

  useEffect(() => {
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
  }, [uploadFile]);

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
      setFullDetail(detail);
      onTaskUpdated?.(detail);
    } catch {
      // Best-effort refresh; the SSE stream will catch the board up regardless.
    }
  }, [task.id, projectId, onTaskUpdated]);

  const handleBranchGroupReset = useCallback(async () => {
    const detail = await fetchTaskDetail(task.id, projectId);
    setFullDetail(detail);
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
  }, [onOpenDetail, addToast]);

  // Spec save handlers (must be declared before functions that use them)
  const handleSaveSpec = useCallback(async (newContent: string) => {
    setIsSavingSpec(true);
    try {
      await updateTask(workingTask.id, { prompt: newContent }, projectId);
      addToast(t("taskDetail.spec.updated", "Spec updated"), "success");
      // Update local detail data
      if (fullDetail) {
        fullDetail.prompt = newContent;
      }
    } catch (err) {
      addToast(getErrorMessage(err), "error");
      throw err;
    } finally {
      setIsSavingSpec(false);
    }
  }, [workingTask, fullDetail, addToast]);

  const handleRequestSpecRevision = useCallback(async (feedback: string) => {
    setIsRequestingRevision(true);
    try {
      await requestSpecRevision(task.id, feedback, projectId);
      addToast(t("taskDetail.spec.revisionRequested", "AI revision requested. Task moved to planning."), "success");
      // Task has been moved to planning, close modal
      requestClose();
    } catch (err) {
      const msg = getErrorMessage(err);
      if (msg.includes("done") || msg.includes("archived")) {
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

  const blockerFanoutMap = useMemo(() => computeBlockerFanoutMap(tasks), [tasks]);
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
  re-implement (FN-7513/FN-7514): user-pause (`isTaskPaused`), done/archived
  terminal columns, and the `autoMerge:false` in-review human-review terminal
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
  done/archived, or the `autoMerge:false` in-review human-review terminal —
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
  const isDoneOrArchivedColumn = task.column === "done" || task.column === "archived";
  const isOverseerHumanReviewTerminal = task.column === "in-review" && !effectiveAutoMerge;
  const overseerHumanControlSuppressed = Boolean(isTaskPaused) || isDoneOrArchivedColumn || isOverseerHumanReviewTerminal;
  const oversightIsOff = effectiveOversightLevel === "off";
  /*
  FNXC:PlannerOversight 2026-07-18-14:00:
  FN-8263 keeps the task-detail eye available for a session advisor independently
  of lifecycle-oversight resolution. Its applicability uses stable inheritance
  inputs (or an explicit override), so toggling an enabled advisor off repaints
  EyeOff instead of unmounting the trigger while a workflow request is pending.
  */
  const lifecycleOversightControlsResolved = hasTaskOversightOverride || workflowOversightResolved;
  const sessionAdvisorMenuApplicable =
    hasSessionAdvisorOverride ||
    projectSessionAdvisorDefault ||
    workflowOversightState.sessionAdvisorEnabled;
  const showOversightMenuTrigger = lifecycleOversightControlsResolved || sessionAdvisorMenuApplicable;
  /*
  FNXC:PlannerOversight 2026-07-18-14:10:
  FN-8263 suppresses the resolver's autonomous fallback while workflow
  lifecycle oversight is unresolved. The eye still tracks the shared advisor
  resolver immediately, rather than falsely staying lit after the advisor turns off.
  */
  const overseerTriggerOn =
    (lifecycleOversightControlsResolved && !oversightIsOff) || effectiveSessionAdvisorEnabled;
  const canNudgeOverseer = overseerActive && !oversightIsOff && !overseerHumanControlSuppressed;
  const canExplainOverseer = overseerActive && !oversightIsOff;
  const showStopOverseer = !oversightIsOff;
  /*
  FNXC:PlannerOversight 2026-07-05-00:00:
  FN-7582 shared disabled-reason string, computed once and reused at all four
  render sites (mobile menu title + helper, desktop inline title + helper) so
  the two copies can never drift out of sync. Picks the human-control-suppressed
  copy when suppression is the active cause even though `!overseerActive` may
  also be true in that state (e.g. a paused task that never got observed) —
  suppression is the more actionable/accurate explanation for the operator.
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
  */
  const shouldShowTaskFailureAlert = Boolean(task.status === "failed" && !hasPendingRecovery && !isPlannerChatExpanded);
  const taskFailureReason = task.error?.trim() || t("taskDetail.error.genericFailureReason", "The task failed before it could complete.");
  const taskFailureToolDetail = useMemo(() => {
    const lastToolError = [...agentLogEntries].reverse().find((entry) => entry.type === "tool_error" && entry.detail?.trim());
    return lastToolError?.detail?.trim().slice(0, 1024);
  }, [agentLogEntries]);
  const taskFailureHint = /workflow graph terminated|step-execute|no files? (were )?modified/i.test(`${task.error ?? ""}\n${taskFailureToolDetail ?? ""}`)
    ? t("taskDetail.error.retryHint", "Consider retrying with a different model or node.")
    : null;

  const taskActionMenuModel = useMemo(() => buildTaskActionMenuModel({
    task,
    t,
    columnLabel,
    canRetryTask,
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
    onRespecify: handleRespecify,
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
    columnLabel,
    canRetryTask,
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
    handleRespecify,
    handleRetry,
    handleReset,
    handleTogglePause,
    handleMergeMenuItemClick,
    handleStartPrReviewMenuItemClick,
    handleCheckPrStatus,
    handleBypassReview,
  ]);
  const primaryMoveTransition = taskActionMenuModel.moveTransitions[0]?.column;
  const secondaryMoveTransitions = taskActionMenuModel.moveTransitions.slice(1);
  const hasSecondaryMoveOptions = secondaryMoveTransitions.length > 0;
  const reviewAction = taskActionMenuModel.reviewAction;

  const closeMoveMenuAndFocusTrigger = useCallback(() => {
    setShowMoveMenu(false);
    moveButtonRef.current?.focus();
  }, []);

  const handleMoveButtonClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (!hasSecondaryMoveOptions) {
      if (primaryMoveTransition) {
        void handleMoveMenuItemClick(primaryMoveTransition as Column);
      }
      return;
    }

    const arrowZone = event.currentTarget.querySelector<HTMLSpanElement>(".detail-move-btn__arrow");
    const clickedArrow = Boolean(
      (event.target instanceof Element && event.target.closest(".detail-move-btn__arrow")) ||
      (arrowZone && event.clientX > 0 && event.clientX >= arrowZone.getBoundingClientRect().left),
    );

    if (clickedArrow) {
      setShowMoveMenu((prev) => !prev);
      setShowActionsMenu(false);
      return;
    }

    if (primaryMoveTransition) {
      void handleMoveMenuItemClick(primaryMoveTransition as Column);
    }
  }, [hasSecondaryMoveOptions, primaryMoveTransition, handleMoveMenuItemClick]);

  const handleMoveButtonKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!hasSecondaryMoveOptions) {
      return;
    }

    const shouldOpenMenu = event.key === "ArrowDown" || (event.altKey && event.key === "ArrowDown");
    if (!shouldOpenMenu) {
      return;
    }

    event.preventDefault();
    setShowMoveMenu(true);
    setShowActionsMenu(false);
  }, [hasSecondaryMoveOptions]);

  const handleMoveMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    closeMoveMenuAndFocusTrigger();
  }, [closeMoveMenuAndFocusTrigger]);

  /*
  FNXC:PlannerOversight 2026-07-04-19:00:
  FN-7545 — mobile oversight overflow-menu open/close/keyboard handling,
  mirroring `handleMoveButtonClick`/`handleMoveButtonKeyDown`/`handleMoveMenuKeyDown`
  above so the two popovers behave consistently (toggle on click, ArrowDown
  opens, Escape closes and returns focus to the trigger).
  */
  const closeOversightMenuAndFocusTrigger = useCallback(() => {
    setShowOversightMenu(false);
    oversightMenuButtonRef.current?.focus();
  }, []);

  const handleOversightMenuButtonClick = useCallback(() => {
    setShowOversightMenu((prev) => !prev);
    setShowMoveMenu(false);
    setShowActionsMenu(false);
  }, []);

  const handleOversightMenuButtonKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    const shouldOpenMenu = event.key === "ArrowDown" || (event.altKey && event.key === "ArrowDown");
    if (!shouldOpenMenu) {
      return;
    }

    event.preventDefault();
    setShowOversightMenu(true);
  }, []);

  const handleOversightMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    closeOversightMenuAndFocusTrigger();
  }, [closeOversightMenuAndFocusTrigger]);

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

  useEffect(() => {
    if (!showMoveMenu) {
      return;
    }

    const firstMenuItem = moveMenuRef.current?.querySelector<HTMLButtonElement>(".detail-move-menu-item");
    firstMenuItem?.focus();
  }, [showMoveMenu]);

  /*
  FNXC:PlannerOversight 2026-07-17-16:35:
  FN-8245 schedules oversight-menu autofocus after the opening commit, matching the
  sibling activity-view menu. The first actionable button (never the native level
  select) must receive focus at both breakpoints; synchronously focusing in the
  effect could lose the focus race while concurrent dashboard rendering settled.
  */
  useEffect(() => {
    if (!showOversightMenu) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      const firstMenuItem = oversightMenuRef.current?.querySelector<HTMLButtonElement>("button.detail-oversight-menu-item");
      firstMenuItem?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [showOversightMenu]);

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

  return (
    <div
      className={`task-detail-content${embedded ? " task-detail-content--embedded" : ""}${isActivityExpanded ? " task-detail-content--chat-expanded" : ""}${isPlannerChatExpanded ? " task-detail-content--planner-chat-expanded" : ""}`}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="modal-header">
          <div className="detail-title-row">
            <span className="detail-id">{task.id}</span>
            <span className={`detail-column-badge badge-${task.column}`}>
              {columnLabel(task.column)}
            </span>
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
                aria-label="Pop out"
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
        <div className={`detail-body${activeTab === "chat" && activitySegment === "raw-logs" && !isEditing ? " detail-body--agent-log" : ""}${activeTab === "chat" && (activitySegment === "current" || isActivityExpanded) && !isEditing ? " detail-body--chat" : ""}${activeTab === "planner-chat" && !isEditing ? " detail-body--planner-chat" : ""}`}>
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
                onExecutorModelChange={setEditExecutorModel}
                validatorModel={editValidatorModel}
                onValidatorModelChange={setEditValidatorModel}
                planningModel={editPlanningModel}
                onPlanningModelChange={setEditPlanningModel}
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
                  <h2
                    ref={titleRef}
                    className={`detail-title${descriptionExpanded ? "" : " detail-title--collapsed"}`}
                  >
                    {displayTitleText}
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
                {(titleOverflows || descriptionExpanded) && (
                  <button
                    className="detail-description-toggle"
                    onClick={() => setDescriptionExpanded(!descriptionExpanded)}
                  >
                    {descriptionExpanded ? t("taskDetail.description.showLess", "Show less") : t("taskDetail.description.showMore", "Show more")}
                  </button>
                )}
              </>
              {customFieldDefs && customFieldDefs.length > 0 ? (
                <TaskFieldsSection
                  fieldDefs={customFieldDefs}
                  customFields={customFieldValues}
                  onSave={handleSaveCustomFields}
                  error={customFieldError}
                  readOnly={Boolean(task.column === "archived")}
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
                    {". "}{isTriageMarkerDuplicate
                      ? t("taskDetail.nearDuplicate.triageActions", "Choose Delete to remove this duplicate, or Keep to continue anyway.")
                      : t("taskDetail.nearDuplicate.actions", "Choose Archive to move this task to archived, or Keep to continue with this task.")}
                  </p>
                  <div className="detail-near-duplicate-banner__actions">
                    {isTriageMarkerDuplicate ? (
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => void handleDeleteTriageDuplicate()}>
                        {t("taskDetail.nearDuplicate.deleteBtn", "Delete")}
                      </button>
                    ) : onArchiveTask ? (
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => void handleArchiveNearDuplicate()}>
                        {t("taskDetail.nearDuplicate.archiveBtn", "Archive")}
                      </button>
                    ) : null}
                    <button type="button" className="btn btn-sm" onClick={() => void handleDismissNearDuplicate()}>
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
                </div>
              )}
              <div className="detail-meta">
                {/*
                FNXC:QuickAddActionRow 2026-07-16-16:00:
                FN-8194: task-detail metadata mirrors Quick Add's action order:
                attach, GitHub tracking, Oversight, Priority, then Fast. The compact
                controls delegate to the existing single file-input upload and
                GitHub-tracking handlers so this row never forks persistence paths.
                */}
                <div className="detail-meta-inline-controls" data-testid="detail-meta-inline-controls">
                  <button
                    type="button"
                    className="btn btn-icon btn-sm"
                    data-testid="detail-inline-attach"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    aria-label={t("taskDetail.attachments.attachInline", "Attach file")}
                    title={t("taskDetail.attachments.attachInline", "Attach file")}
                  >
                    <Paperclip size={12} aria-hidden="true" />
                  </button>
                  {canEditGithubTracking && !gitlabTrackedItem && (
                    <button
                      type="button"
                      className={`btn btn-icon btn-sm ${githubTrackingEnabled ? "btn-primary" : ""}`}
                      data-testid="detail-inline-github-toggle"
                      onClick={() => void handleToggleGithubTracking()}
                      disabled={isSavingGithubTracking}
                      aria-pressed={githubTrackingEnabled}
                      aria-label={t("taskDetail.githubTracking.toggleInline", "Toggle GitHub tracking")}
                      title={t("taskDetail.githubTracking.toggleInline", "Toggle GitHub tracking")}
                    >
                      <ProviderIcon provider="github" size="sm" />
                    </button>
                  )}
                  {/*
                  FNXC:PlannerOversight 2026-07-04-17:00:
                  FN-7517 quick oversight-level-change control. Shows the current
                  EFFECTIVE level (resolved via the single `resolveEffectivePlannerOversightLevel`
                  resolver, not re-derived locally) and distinguishes an explicit
                  per-task override from an inherited workflow/project default via
                  the "Inherit workflow default" option. Withheld entirely until the
                  workflow tier resolves (or a per-task override renders it
                  synchronously), mirroring FN-7516's TaskCard badge gating so this
                  never shows a guessed schema-default value for a beat.

                  FNXC:PlannerOversight 2026-07-04-19:00:
                  FN-7545 — collapse the oversight action controls into a mobile
                  overflow menu so the detail control bar fits narrow viewports;
                  menu never renders an empty shell when oversight is off/inactive.
                  Shares the SAME enablement gates (`hasTaskOversightOverride`,
                  `workflowOversightResolved`, `oversightIsOff`, `showStopOverseer`,
                  `canNudgeOverseer`, `canExplainOverseer`) and the SAME handlers
                  as before.

                  FNXC:PlannerOversight 2026-07-05-00:00:
                  FN-7604 — the oversight action controls (level select / nudge /
                  stop / explain) render ONLY behind the "Oversight" overflow-menu
                  trigger on every surface (desktop and mobile); the former desktop
                  inline cluster was removed for a consistent, simpler control bar.

                  FNXC:PlannerOversight 2026-07-16-16:00:
                  FN-8194: use Eye for the Oversight overflow trigger so task detail
                  matches Quick Add's planner-advisor affordance without changing
                  the labeled menu's accessibility or behavior.

                  FNXC:PlannerOversight 2026-07-17-12:00:
                  FN-8209: the Oversight trigger is icon-only and uses `btn-icon`,
                  so its Eye resolves through the shared `--icon-size-sm` sizing on
                  mobile and stays visually aligned with Quick Add.
                  */}
                  {showOversightMenuTrigger && (
                      <div className="detail-oversight-menu-dropdown" ref={oversightMenuRef}>
                        <button
                          type="button"
                          ref={oversightMenuButtonRef}
                          className="btn btn-icon btn-sm detail-oversight-menu-trigger"
                          data-testid="detail-oversight-menu-trigger"
                          onClick={handleOversightMenuButtonClick}
                          onKeyDown={handleOversightMenuButtonKeyDown}
                          aria-haspopup="menu"
                          aria-expanded={showOversightMenu}
                          aria-label={t("taskDetail.oversight.menuAriaLabel", "Oversight actions")}
                          title={t("taskDetail.oversight.menuAriaLabel", "Oversight actions")}
                        >
                          {overseerTriggerOn ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
                        </button>
                        {showOversightMenu && (
                          <div className="detail-oversight-menu" role="menu" onKeyDown={handleOversightMenuKeyDown}>
                            {lifecycleOversightControlsResolved && (
                              <label className="detail-oversight-menu-item detail-oversight-menu-item--select">
                                <span>{t("taskDetail.oversight.label", "Oversight:")}</span>
                              <select
                                className="detail-oversight-select detail-oversight-menu-item"
                                data-testid="detail-oversight-level-select"
                                value={hasTaskOversightOverride ? (task.plannerOversightLevel as string) : "__inherit__"}
                                onChange={(event) => {
                                  void handleOversightLevelChange(event.target.value);
                                }}
                                disabled={isSavingOversightLevel}
                                aria-label={t("taskDetail.oversight.ariaLabel", "Planner oversight level")}
                              >
                                <option value="__inherit__">
                                  {t("taskDetail.oversight.inherit", "Inherit ({{level}})", { level: OVERSIGHT_LEVEL_LABEL[effectiveOversightLevel] })}
                                </option>
                                {PLANNER_OVERSIGHT_LEVELS.map((levelOption) => (
                                  <option key={levelOption} value={levelOption}>
                                    {OVERSIGHT_LEVEL_LABEL[levelOption]}
                                  </option>
                                ))}
                                </select>
                              </label>
                            )}
                            {/*
                            FNXC:PlannerOversight 2026-07-14-18:11:
                            Per-task session advisor toggle inside the Oversight menu.
                            */}
                            <button
                              type="button"
                              className={`detail-oversight-menu-item ${effectiveSessionAdvisorEnabled ? "detail-oversight-menu-item--active" : ""}`}
                              role="menuitem"
                              data-testid="detail-session-advisor-toggle"
                              onClick={() => {
                                void handleSessionAdvisorToggle();
                              }}
                              onKeyDown={handleOversightMenuKeyDown}
                              disabled={isSavingSessionAdvisor}
                              aria-pressed={effectiveSessionAdvisorEnabled}
                              title={
                                hasSessionAdvisorOverride
                                  ? t(
                                      "taskDetail.sessionAdvisor.overrideTitle",
                                      "Session advisor {{state}} (task override; project default {{default}})",
                                      {
                                        state: effectiveSessionAdvisorEnabled
                                          ? t("tasks.sessionAdvisorDefaultOn", "on")
                                          : t("tasks.sessionAdvisorDefaultOff", "off"),
                                        default: projectSessionAdvisorDefault
                                          ? t("tasks.sessionAdvisorDefaultOn", "on")
                                          : t("tasks.sessionAdvisorDefaultOff", "off"),
                                      },
                                    )
                                  : t(
                                      "taskDetail.sessionAdvisor.inheritTitle",
                                      "Session advisor {{state}} (follows inherited defaults)",
                                      {
                                        state: effectiveSessionAdvisorEnabled
                                          ? t("tasks.sessionAdvisorDefaultOn", "on")
                                          : t("tasks.sessionAdvisorDefaultOff", "off"),
                                      },
                                    )
                              }
                              aria-label={t("taskDetail.sessionAdvisor.ariaLabel", "Toggle session advisor for this task")}
                            >
                              {isSavingSessionAdvisor ? <Loader2 className="spin" aria-hidden="true" /> : effectiveSessionAdvisorEnabled ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
                              <span>
                                {t("taskDetail.sessionAdvisor.label", "Session advisor: {{state}}", {
                                  state: effectiveSessionAdvisorEnabled
                                    ? t("tasks.sessionAdvisorDefaultOn", "on")
                                    : t("tasks.sessionAdvisorDefaultOff", "off"),
                                })}
                                {hasSessionAdvisorOverride
                                  ? ""
                                  : t("taskDetail.sessionAdvisor.inheritSuffix", " (inherited)")}
                              </span>
                            </button>
                            {lifecycleOversightControlsResolved && !oversightIsOff && (
                              <span className="detail-oversight-controls-label" data-testid="detail-oversight-controls-label">
                                {t("taskDetail.oversight.controlsLabel", "Overseer controls")}
                              </span>
                            )}
                            {lifecycleOversightControlsResolved && !oversightIsOff && (
                              <button
                                type="button"
                                className={`detail-oversight-menu-item detail-overseer-nudge ${isNudgingOverseer ? "detail-overseer-nudge--saving" : ""}`}
                                role="menuitem"
                                data-testid="detail-overseer-nudge"
                                onClick={() => {
                                  void handleNudgeOverseer();
                                  setShowOversightMenu(false);
                                }}
                                onKeyDown={handleOversightMenuKeyDown}
                                disabled={!canNudgeOverseer || isNudgingOverseer}
                                title={canNudgeOverseer ? t("taskDetail.oversight.nudgeTitle", "Inject steering guidance into the current stage now") : nudgeDisabledReason}
                                aria-label={t("taskDetail.oversight.nudgeAriaLabel", "Manual nudge")}
                              >
                                {isNudgingOverseer ? <Loader2 className="spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
                                <span>{t("taskDetail.oversight.nudge", "Nudge")}</span>
                              </button>
                            )}
                            {lifecycleOversightControlsResolved && !oversightIsOff && !canNudgeOverseer && (
                              <span className="detail-oversight-controls-helper" data-testid="detail-overseer-nudge-disabled-reason">
                                {nudgeDisabledReason}
                              </span>
                            )}
                            {lifecycleOversightControlsResolved && showStopOverseer && (
                              <button
                                type="button"
                                className={`detail-oversight-menu-item detail-overseer-stop ${isStoppingOverseer ? "detail-overseer-stop--saving" : ""}`}
                                role="menuitem"
                                data-testid="detail-overseer-stop"
                                onClick={() => {
                                  void handleStopOverseer();
                                  setShowOversightMenu(false);
                                }}
                                onKeyDown={handleOversightMenuKeyDown}
                                disabled={isStoppingOverseer}
                                aria-label={t("taskDetail.oversight.stopAriaLabel", "Stop oversight")}
                              >
                                {isStoppingOverseer ? <Loader2 className="spin" aria-hidden="true" /> : <Square aria-hidden="true" />}
                                <span>{t("taskDetail.oversight.stop", "Stop")}</span>
                              </button>
                            )}
                            {lifecycleOversightControlsResolved && !oversightIsOff && (
                              <button
                                type="button"
                                className="detail-oversight-menu-item detail-overseer-explain"
                                role="menuitem"
                                data-testid="detail-overseer-explain"
                                onClick={() => {
                                  void handleExplainOverseer();
                                  setShowOversightMenu(false);
                                }}
                                onKeyDown={handleOversightMenuKeyDown}
                                title={canExplainOverseer ? t("taskDetail.oversight.explainTitle", "Explain the overseer's current action") : t("taskDetail.oversight.explainInactiveTitle", "Overseer is not currently watching this task — Explain shows its last known state")}
                                aria-label={t("taskDetail.oversight.explainAriaLabel", "Explain current action")}
                                aria-expanded={overseerExplainOpen}
                              >
                                <Info aria-hidden="true" />
                                <span>{t("taskDetail.oversight.explain", "Explain")}</span>
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  {(() => {
                    const PriorityIcon = getPriorityIcon(inlinePriority);
                    const priorityLabel = t("taskDetail.priority.triggerLabel", "Priority: {{priority}}", {
                      priority: getPriorityLabel(inlinePriority),
                    });
                    return (
                      <div className="detail-priority-picker" ref={inlinePriorityPickerRef}>
                        {/*
                        FNXC:QuickAddActionRow 2026-07-17-12:00:
                        FN-8209: Task Detail mirrors Quick Add's icon-only flag
                        priority control and picker, while retaining the existing
                        `handleInlinePriorityChange` persistence path.
                        */}
                        <button
                          type="button"
                          className="btn btn-icon btn-sm"
                          data-testid="detail-priority-trigger"
                          onClick={() => setShowInlinePriorityPicker((isOpen) => !isOpen)}
                          disabled={isSavingInlinePriority}
                          aria-haspopup="menu"
                          aria-expanded={showInlinePriorityPicker}
                          aria-label={priorityLabel}
                          title={priorityLabel}
                        >
                          <PriorityIcon size={14} aria-hidden="true" style={{ color: getPriorityColorVar(inlinePriority) }} />
                        </button>
                        {showInlinePriorityPicker && (
                          <div className="detail-priority-picker-dropdown priority-picker-dropdown" role="menu">
                            <div className="detail-priority-picker-heading">{t("tasks.selectPriority", "Select priority")}</div>
                            {TASK_PRIORITIES.map((priorityOption) => {
                              const OptionPriorityIcon = getPriorityIcon(priorityOption);
                              return (
                                <button
                                  key={priorityOption}
                                  type="button"
                                  className={`detail-priority-picker-option${inlinePriority === priorityOption ? " selected" : ""}`}
                                  data-testid={`detail-priority-option-${priorityOption}`}
                                  role="menuitem"
                                  onClick={() => {
                                    setShowInlinePriorityPicker(false);
                                    void handleInlinePriorityChange(priorityOption);
                                  }}
                                  disabled={isSavingInlinePriority}
                                >
                                  <OptionPriorityIcon size={12} aria-hidden="true" style={{ color: getPriorityColorVar(priorityOption) }} />
                                  <span>{getPriorityLabel(priorityOption)}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  <button
                    type="button"
                    className={`btn btn-icon btn-sm detail-execution-mode-toggle ${inlineExecutionMode === "fast" ? "btn-primary detail-execution-mode-toggle--fast" : ""} ${isSavingInlineExecutionMode ? "detail-execution-mode-toggle--saving" : ""}`}
                    onClick={() => {
                      void handleInlineExecutionModeToggle();
                    }}
                    disabled={isSavingInlineExecutionMode}
                    aria-label={t("taskDetail.executionMode.ariaLabel", "Execution mode: {{mode}}", { mode: inlineExecutionMode })}
                    title={t("taskDetail.executionMode.ariaLabel", "Execution mode: {{mode}}", { mode: inlineExecutionMode })}
                    aria-pressed={inlineExecutionMode === "fast"}
                  >
                    <Zap size={14} aria-hidden="true" />
                  </button>
                </div>
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
                {overseerExplainOpen && (
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
                        <>{t("taskDetail.provenance.createdVia", "Created via")} {provenanceDisplay.label}</>
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
              {shouldShowBranchGroupCard && task.branchContext?.groupId && (
                /* FNXC:BranchGroupDetails 2026-06-30-00:00: Task-detail branch groups must return to their compact collapsed default when users switch tasks, including between members of the same shared branch group. Key by task and group so a manual expansion never leaks into the next task detail view. */
                <BranchGroupCard
                  key={`${task.id}:${task.branchContext.groupId}`}
                  groupId={task.branchContext.groupId}
                  taskId={task.id}
                  projectId={projectId}
                  onBranchGroupReset={handleBranchGroupReset}
                />
              )}
              {/* FNXC:Workspace 2026-06-21-00:00: workspace tasks have no singular
                  task.worktree/task.branch; surface their acquired per-sub-repo worktrees
                  as a flat read-only list so the detail view isn't blank (U3/KTD5). */}
              {/* FNXC:Workspace 2026-06-22-09:00: gate/render off the hydrated
                  workingTask, not the sparse task row. workspaceWorktrees is only
                  present in fetched detail, so keying off task renders blank on the
                  optimistic-open path before the detail fetch resolves. */}
              {isWorkspaceTask(workingTask) && <WorkspaceWorktreesSummary task={workingTask} />}
            </>
          )}
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
                {onRetryTask && canRetryTask ? (
                  <div className="detail-error-actions">
                    <button type="button" className="btn btn-sm" onClick={handleRetry}>
                      {t("taskDetail.error.retry", "Retry")}
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => setShowFailureRetryPicker(true)}>
                      {t("taskDetail.error.retryWithModel", "Retry with a different model/node")}
                    </button>
                  </div>
                ) : null}
                {showFailureRetryPicker && onRetryTask && canRetryTask ? (
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
            {task.column === "done" && (
              <button
                className={`detail-tab${activeTab === "summary" ? " detail-tab-active" : ""}`}
                onClick={() => setActiveTab("summary")}
              >
                {t("taskDetail.tabs.summary", "Summary")}
              </button>
            )}
            <button
              className={`detail-tab${activeTab === "definition" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("definition")}
            >
              {t("taskDetail.tabs.definition", "Plan")}
            </button>
            {(task.column === "in-progress" || task.column === "in-review" || task.column === "done") && (
              <button
                className={`detail-tab${activeTab === "changes" ? " detail-tab-active" : ""}`}
                onClick={() => setActiveTab("changes")}
              >
                {t("taskDetail.tabs.changes", "Changes")}
              </button>
            )}
            <button
              className={`detail-tab${activeTab === "review" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("review")}
            >
              {t("taskDetail.tabs.review", "Review")}
            </button>
            {task.column === "in-review" && (
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
            {/* FNXC:TaskDetailCost 2026-07-11-00:00: Keep the tab strip's operator workflow as Comments → Terminal → Cost so discussion, shell context, and model spend sit together. Cost remains always reachable (unlike done-only Summary) and uses costFor via the shared taskTokenCost helper without persisting derived USD. */}
            {showWorktreeTerminalTab && (
              <button
                className={`detail-tab${activeTab === "worktree-terminal" ? " detail-tab-active" : ""}`}
                onClick={() => setActiveTab("worktree-terminal")}
              >
                {t("taskDetail.tabs.worktreeTerminal", "Terminal")}
              </button>
            )}
            <button
              className={`detail-tab${activeTab === "cost" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("cost")}
            >
              {t("taskDetail.tabs.cost", "Cost")}
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
            <button
              className={`detail-tab${activeTab === "stats" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("stats")}
            >
              {t("taskDetail.tabs.stats", "Stats")}
            </button>
            <button
              className={`detail-tab${activeTab === "routing" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("routing")}
            >
              {t("taskDetail.tabs.routing", "Routing")}
            </button>
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
                taskId={task.id}
                task={task}
                results={workflowResults}
                loading={workflowResultsLoading}
                enabledWorkflowSteps={workflowEnabledSteps}
                canEdit={canEdit}
                projectId={projectId}
                isTaskInProgress={
                  task.column === "in-progress"
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
          ) : activeTab === "summary" && task.column === "done" ? (
            <div className="detail-section detail-section--summary">
              <TaskSummaryTab task={workingTask} pricingOverrides={globalSettings?.modelPricingOverrides} />
            </div>
          ) : activeTab === "cost" ? (
            <div className="detail-section detail-section--cost">
              <TaskCostTab task={workingTask} pricingOverrides={globalSettings?.modelPricingOverrides} />
            </div>
          ) : activeTab === "planner-chat" ? (
            <div className="detail-section detail-section--planner-chat">
              <TaskPlannerChatTab
                task={workingTask}
                projectId={projectId}
                active={activeTab === "planner-chat"}
                expanded={isPlannerChatExpanded}
                onExpandedChange={setPlannerChatExpanded}
                planningModel={resolveEffectivePlanning(workingTask, agentLogEntries, settings)}
                addToast={addToast}
                onTaskUpdated={onTaskUpdated}
              />
            </div>
          ) : activeTab === "chat" ? (
            <div className={`detail-section detail-section--activity${activitySegment === "current" || isActivityExpanded ? " detail-section--chat" : ""}${activitySegment === "raw-logs" ? " detail-section--agent-log" : ""}`}>
              {/*
                FNXC:TaskDetailPlannerChat 2026-06-30-22:30:
                Activity owns the existing steering/current view, Feed, and raw agent logs inside one compact selector. The stable Activity tab id remains `chat`, legacy `logs` callers land on Feed, and Raw is the only selector option that enables raw agent-log fetching. Planner-model conversation belongs to the separate `planner-chat` tab and must not route into steering comments.

                FNXC:TaskDetailActivity 2026-06-30-23:55:
                The first Activity segment is user-facing Live but keeps the legacy `current` segment id. Activity expansion is segment-wide, so the same reachable toggle must remain present on Live, Feed, and Raw without fetching Raw outside the Raw segment.

                FNXC:TaskDetailActivity 2026-06-30-23:59:
                The Activity tab in the top-level tab strip is now the view dropdown for Live, Feed, and Raw. The in-panel Activity view select was removed so Activity expansion remains the only Activity-level affordance inside the panel while legacy routing and Raw-only fetching keep their stable ids (`chat`, `current`, `feed`, `raw-logs`).

                FNXC:TaskDetailActivity 2026-07-01-00:00:
                Activity expansion must not reserve a standalone toolbar row. Live uses TaskChatTab's anchored overlay button, Feed renders the same Activity toggle over its feed panel, and Raw keeps AgentLogViewer's fullscreen control so only one Raw expand affordance is reachable.
              */}
              {activitySegment === "current" ? (
                <TaskChatTab
                  task={workingTask}
                  projectId={projectId}
                  active={activeTab === "chat" && activitySegment === "current"}
                  addToast={addToast}
                  sessionLive={isCliSessionLive(cliSession)}
                  onTaskUpdated={handleChatTaskUpdated}
                  expanded={isActivityExpanded}
                  onToggleExpanded={() => setActivityExpanded((value) => !value)}
                  effectiveModels={{
                    triage: toTaskChatModelInfo(resolveEffectivePlanning(workingTask, agentLogEntries, settings)),
                    executor: toTaskChatModelInfo(resolveEffectiveExecutor(workingTask, agentLogEntries, assignedAgent, settings)),
                    reviewer: toTaskChatModelInfo(resolveEffectiveValidator(workingTask, agentLogEntries, assignedAgent, settings)),
                    merger: toTaskChatModelInfo(resolveEffectiveValidator(workingTask, agentLogEntries, assignedAgent, settings)),
                  }}
                />
              ) : activitySegment === "raw-logs" ? (
                <AgentLogViewer
                  entries={agentLogEntries}
                  loading={agentLogLoading}
                  executorModel={resolveEffectiveExecutor(task, agentLogEntries, assignedAgent, settings)}
                  validatorModel={resolveEffectiveValidator(task, agentLogEntries, assignedAgent, settings)}
                  planningModel={resolveEffectivePlanning(task, agentLogEntries, settings)}
                  hasMore={agentLogHasMore}
                  onLoadMore={loadMoreAgentLogs}
                  loadingMore={agentLogLoadingMore}
                  totalCount={agentLogTotal}
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
                  <h4>{t("taskDetail.activity.feedHeading", "Feed")}</h4>
                  {(workingTask as typeof workingTask & { activityLogTruncatedCount?: number }).activityLogTruncatedCount ? (
                    <div className="detail-log-truncated">
                      {t("taskDetail.logs.truncated", "Showing the most recent {{count}} activity entries.", { count: workingTask.log.length })}
                    </div>
                  ) : null}
                  {detailLoading ? (
                    <div className="detail-log-loading" role="status" aria-live="polite">
                      <Loader2 className="animate-spin" aria-hidden="true" />
                      <span>{t("taskDetail.logs.loadingActivity", "Loading activity…")}</span>
                    </div>
                  ) : workingTask.log && workingTask.log.length > 0 ? (
                    <div className="detail-activity-list" ref={activityListRef}>
                      {(() => {
                        // FNXC:TaskDetail 2026-06-14-13:43 Activity rendering must tolerate legacy `text`/`detail` log entries.
                        let highlightedOnce = false;
                        return [...workingTask.log].reverse().map((entry, i) => {
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
                                <span className="detail-log-timestamp">
                                  {formatTimestamp(entry.timestamp)}
                                </span>
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
            <TaskChangesTab taskId={task.id} worktree={task.worktree} projectId={projectId} column={task.column} mergeDetails={task.mergeDetails} modifiedFiles={task.modifiedFiles} isWorkspace={isWorkspaceTask(workingTask)} />
          ) : activeTab === "review" ? (
            <TaskReviewTab
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
              {task.column === "in-review" && (
                <>
                  {shouldShowInReviewStallBadge(workingTask) && workingTask.inReviewStall && (() => {
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
                  {shouldShowStalePausedReviewBadge(workingTask) && workingTask.stalePausedReview && (() => {
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
            <TaskDocumentsTab
              taskId={task.id}
              addToast={addToast}
              projectId={projectId}
              onTaskUpdated={onTaskUpdated}
              canEdit={canEdit}
            />
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
              <TaskTokenStatsPanel
                tokenUsage={workingTask.tokenUsage}
                loading={detailLoading}
                task={workingTask}
              />
            </div>
          ) : activeTab === "routing" ? (
            <div className="detail-section">
              <RoutingTab
                task={task}
                settings={settings}
                addToast={addToast}
                onTaskUpdated={onTaskUpdated}
              />
            </div>
          ) : activeTab === "terminal" ? (
            <div className="detail-section detail-section--terminal">
              {cliSession && cliTabVisibility.kind !== "hidden" ? (
                <Suspense fallback={<div className="detail-loading"><LoadingSpinner label={t("taskDetail.terminal.loading", "Loading terminal…")} /></div>}>
                  <LazySessionTerminal
                    sessionId={cliSession.id}
                    projectId={projectId}
                    posture={cliPosture}
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
          ) : activeTab === "worktree-terminal" && showWorktreeTerminalTab ? (
            <div className="detail-section detail-section--worktree-terminal">
              <Suspense fallback={<div className="detail-loading"><LoadingSpinner label={t("taskDetail.terminal.loadingInteractive", "Loading interactive terminal…")} /></div>}>
                <LazyTerminalModal
                  isOpen={true}
                  onClose={() => setActiveTab("definition")}
                  embedded
                  defaultCwd={taskWorktreeCwd}
                  scopeId={task.id}
                  projectId={projectId}
                />
              </Suspense>
            </div>
          ) : (
          <>
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
                    maxLength={2000}
                  />
                  <div className="spec-editor-revision-actions">
                    <span className="spec-editor-char-count">
                      {specFeedback.length}/2000
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
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={sharedRehypePlugins} components={markdownLinkifyComponents}>
                  {workingTask.prompt.replace(/^#\s+[^\n]*\n+/, "")}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="detail-prompt">{t("taskDetail.spec.noPrompt", "(no prompt)")}</div>
            )}
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
          <div className="detail-section">
            <h4>{t("taskDetail.attachments.heading", "Attachments")}</h4>
            {attachments.length > 0 ? (
              <div className="detail-attachments-grid">
                {attachments.map((a) => {
                  const attachmentUrl = appendTokenQuery(`/api/tasks/${task.id}/attachments/${a.filename}`);
                  return (
                    <div key={a.filename} className="detail-attachment-card">
                      <a
                        className="detail-attachment-link"
                        href={attachmentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <img
                          src={attachmentUrl}
                          alt={a.originalName}
                          className="detail-attachment-image"
                        />
                      </a>
                      <div className="detail-attachment-meta">
                        {a.originalName} ({formatBytes(a.size)})
                      </div>
                      <button
                        className="detail-attachment-delete"
                        onClick={() => handleDeleteAttachment(a.filename)}
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
          </>
          )}
          </>
          )}
        </div>
        {task.column === "in-review" && (
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
                  <button className="btn btn-primary btn-sm" onClick={handleApprovePlan}>
                    {t("taskDetail.plan.approveBtn", "Approve Plan")}
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={handleRejectPlan}>
                    {t("taskDetail.plan.rejectBtn", "Reject Plan")}
                  </button>
                </>
              )}

              {/* Standalone Delete button for triage-column tasks — triage tasks
                  hide the Actions dropdown (see condition below) so the user has
                  no quick way to delete a freshly-created task otherwise. */}
              {task.column === "triage" && !isAwaitingApproval && !canRetryTask && (
                <button
                  className="btn btn-sm btn-danger"
                  onClick={handleDelete}
                  aria-label={t("taskDetail.delete.ariaLabel", "Delete task")}
                  title={t("taskDetail.delete.ariaLabel", "Delete task")}
                >
                  {t("taskDetail.delete.btn", "Delete")}
                </button>
              )}

              {/*
              FNXC:TaskRevert 2026-07-05-00:00 (FN-7525):
              Detail-view Revert button for done/archived tasks, mirroring the
              standalone triage Delete button above. Rendered (not just menu-only)
              because the detail view is the primary surface for reviewing a
              completed task's outcome. Omitted — not disabled — when the task has
              no landed commit to revert, avoiding an empty button shell.
              */}
              {(task.column === "done" || task.column === "archived") && onRevertTask && isRevertable && (
                <button
                  className="btn btn-sm"
                  onClick={() => void handleRevertTask()}
                  aria-label={t("tasks.revertTask", "Revert this task's changes")}
                  title={t("tasks.revertTask", "Revert this task's changes")}
                >
                  {t("tasks.revert", "Revert")}
                </button>
              )}

              {/* Actions dropdown — less common operations */}
              {taskActionMenuModel.shouldShowActionsMenu && (
                <div className="detail-actions-dropdown" ref={actionsMenuRef}>
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      setShowActionsMenu((prev) => !prev);
                      setShowMoveMenu(false);
                    }}
                    aria-haspopup="menu"
                    aria-expanded={showActionsMenu}
                  >
                    {t("taskDetail.actions.menuBtn", "Actions")}
                    <ChevronDown size={12} />
                  </button>
                  {showActionsMenu && (
                    <>
                      {/*
                      FNXC:TaskPauseControls 2026-06-21-00:00:
                      Users may pause or unpause agent-assigned and agent-paused tasks at any time from the detail Actions menu. The Paused by agent note remains informational context, not a substitute for the actionable unpause control.
                      */}
                      <TaskContextMenu
                        actions={taskActionMenuModel.actions}
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

              {/* Move dropdown — column transitions and merge actions */}
              <div className="detail-move-dropdown" ref={moveMenuRef}>
                {task.column === "in-review" ? (
                  <div className="detail-move-actions-in-review">
                    <div>
                      <button
                        ref={moveButtonRef}
                        className="btn btn-primary btn-sm detail-move-btn"
                        onClick={handleMoveButtonClick}
                        onKeyDown={handleMoveButtonKeyDown}
                        disabled={!primaryMoveTransition}
                        aria-label={primaryMoveTransition ? t("taskDetail.move.moveTo", "Move to {{column}}", { column: columnLabel(primaryMoveTransition) }) : undefined}
                        aria-haspopup={hasSecondaryMoveOptions ? "menu" : undefined}
                        aria-expanded={hasSecondaryMoveOptions ? showMoveMenu : undefined}
                      >
                        <span className="detail-move-btn__label">
                          {t("taskDetail.move.moveTo", "Move to {{column}}", { column: primaryMoveTransition ? columnLabel(primaryMoveTransition) : "" })}
                        </span>
                        {hasSecondaryMoveOptions && (
                          <span className="detail-move-btn__arrow" aria-hidden="true">
                            <ChevronDown size={12} />
                          </span>
                        )}
                      </button>
                      {showMoveMenu && hasSecondaryMoveOptions && (
                        <div className="detail-move-menu" role="menu" onKeyDown={handleMoveMenuKeyDown}>
                          {secondaryMoveTransitions.map((moveAction) => (
                            <button
                              key={moveAction.column}
                              className="detail-move-menu-item"
                              role="menuitem"
                              onClick={() => handleMoveMenuItemClick(moveAction.column as Column)}
                              onKeyDown={handleMoveMenuKeyDown}
                            >
                              {moveAction.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {reviewAction && (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={reviewAction.onSelect}
                        disabled={reviewAction.disabled}
                      >
                        {reviewAction.label}
                      </button>
                    )}
                  </div>
                ) : (
                  <div>
                    <button
                      ref={moveButtonRef}
                      className="btn btn-primary btn-sm detail-move-btn"
                      onClick={handleMoveButtonClick}
                      onKeyDown={handleMoveButtonKeyDown}
                      disabled={!primaryMoveTransition}
                      aria-label={primaryMoveTransition ? t("taskDetail.move.moveTo", "Move to {{column}}", { column: columnLabel(primaryMoveTransition) }) : undefined}
                      aria-haspopup={hasSecondaryMoveOptions ? "menu" : undefined}
                      aria-expanded={hasSecondaryMoveOptions ? showMoveMenu : undefined}
                    >
                      <span className="detail-move-btn__label">
                        {t("taskDetail.move.moveTo", "Move to {{column}}", { column: primaryMoveTransition ? columnLabel(primaryMoveTransition) : "" })}
                      </span>
                      {hasSecondaryMoveOptions && (
                        <span className="detail-move-btn__arrow" aria-hidden="true">
                          <ChevronDown size={12} />
                        </span>
                      )}
                    </button>
                    {showMoveMenu && hasSecondaryMoveOptions && (
                      <div className="detail-move-menu" role="menu" onKeyDown={handleMoveMenuKeyDown}>
                        {secondaryMoveTransitions.map((moveAction) => (
                          <button
                            key={moveAction.column}
                            className="detail-move-menu-item"
                            role="menuitem"
                            onClick={() => handleMoveMenuItemClick(moveAction.column as Column)}
                            onKeyDown={handleMoveMenuKeyDown}
                          >
                            {moveAction.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
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
                <p className="detail-refine-help">
                  {t("taskDetail.refine.help", "Describe what needs to be refined or improved...")}
                </p>
                <textarea
                  className="detail-refine-textarea"
                  value={refineFeedback}
                  onChange={(e) => setRefineFeedback(e.target.value)}
                  placeholder={t("taskDetail.refine.placeholder", "Enter your feedback here...")}
                  rows={6}
                  maxLength={2000}
                  autoFocus
                />
                <div className="detail-refine-input-group">
                  <div className="detail-refine-char-count">
                    {t("taskDetail.refine.charCount", "{{count}}/2000 characters", { count: refineFeedback.length })}
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
            />
          </Suspense>
        )}
    </div>
  );
}

export function TaskDetailModal({ onClose, ...props }: TaskDetailModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  useModalResizePersist(modalRef, true, "task-detail-modal-size");
  useMobileScrollLock(true);
  const overlayDismissProps = useOverlayDismiss(onClose);
  /*
  FNXC:TaskDetailSwipeBack 2026-07-05-12:30:
  FN-7587 — track the mobile breakpoint locally (mirrors the same resize-listener pattern
  used elsewhere in this file) so the list/modal/nested task-detail surface gets the same
  presentation-only predictive-back slide/fade enter transition as the board main-panel
  (MainContent.tsx), without threading a new isMobile prop through App.tsx/AppModals.tsx. This
  is presentation-only: it never touches onClose/onRequestClose timing or the underlying
  useNavigationHistory dismissal routing, and honors prefers-reduced-motion (see
  TaskDetailModal.css). Defaults false so JSDOM/unit tests keep exercising the desktop (no
  animation) branch unless a test explicitly narrows the viewport.
  */
  const [isMobileTransition, setIsMobileTransition] = useState(false);
  useEffect(() => {
    const updateIsMobileTransition = () => {
      setIsMobileTransition(window.innerWidth <= TASK_DETAIL_MOBILE_TRANSITION_BREAKPOINT);
    };

    updateIsMobileTransition();
    window.addEventListener("resize", updateIsMobileTransition);

    return () => {
      window.removeEventListener("resize", updateIsMobileTransition);
    };
  }, []);

  return (
    <div
      className="modal-overlay open"
      {...overlayDismissProps}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`modal modal-lg task-detail-modal${isMobileTransition ? " task-detail-modal--mobile-transition" : ""}`}
        ref={modalRef}
      >
        <TaskDetailContent
          {...props}
          onRequestClose={onClose}
        />
      </div>
    </div>
  );
}
