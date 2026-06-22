import "./TaskCard.css";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { memo, useCallback, useState, useRef, useEffect, useMemo, type ReactElement } from "react";
import { Link, Clock, Layers, Pencil, ChevronDown, Folder, Target, Bot, Trash2, RotateCw, Zap, GitBranch, GitPullRequest, AlertTriangle, ArrowUpRight } from "lucide-react";
import type { Task, TaskDetail, Column, ColumnId, PrInfo, IssueInfo, TaskPriority, GithubIssueAction } from "@fusion/core";
import {
  DEFAULT_TASK_PRIORITY,
  HIGH_FANOUT_BLOCKER_TODO_THRESHOLD,
  TASK_PRIORITIES,
  VALID_TRANSITIONS,
  getErrorMessage,
} from "@fusion/core";
import { resolveEffectiveAutoMerge } from "../../../core/src/task-merge";
import { fetchTaskDetail, uploadAttachment, fetchMission, fetchAgent, type WorkflowFieldDefinition } from "../api";
import { GitHubBadge } from "./GitHubBadge";
import { PrCreateModal } from "./PrCreateModal";
import { ProviderIcon } from "./ProviderIcon";
import { PluginSlot } from "./PluginSlot";
import { useBadgeWebSocket } from "../hooks/useBadgeWebSocket";
import { useCoarsePointer } from "../hooks/useCoarsePointer";
import { getFreshBatchData } from "../hooks/useBatchBadgeFetch";
import { useTaskDiffStats } from "../hooks/useTaskDiffStats";
import { useAgentsMapCache } from "../hooks/useAgentsMapCache";
import { isTaskStuck } from "../utils/taskStuck";
import { getStalledReviewSignal } from "../utils/taskStalledReview";
import { getInReviewStallCopy, shouldShowInReviewStallBadge } from "../utils/inReviewStallCopy";
import { getStalePausedReviewCopy, shouldShowStalePausedReviewBadge } from "../utils/stalePausedReviewCopy";
import { getTaskAgeStalenessCopy, shouldShowTaskAgeStalenessBadge } from "../utils/taskAgeStalenessCopy";
import { getUnifiedTaskProgress } from "../utils/taskProgress";
import { getActiveRuntimeMs, getEndToEndDurationMs, getTimedDurationMs, getWorkflowRuntimeMs, parseTimestampToMs } from "../utils/taskTiming";
import type { ToastType } from "../hooks/useToast";
import { useConfirm } from "../hooks/useConfirm";
import { extractDependencyDeleteConflict, extractLineageDeleteConflict } from "../utils/taskDelete";
import { MAX_AUTO_MERGE_RETRIES, type BlockerFanoutEntry } from "../hooks/useBlockerFanout";
import { useRetryWarning } from "../context/RetryWarningContext";
import { useColumnLabel } from "../i18n/labels";
import { WorkspaceWorktreesSummary, isWorkspaceTask } from "./WorkspaceWorktreesSummary";

/** Per-branch progress snapshot (U13). Surfaced as an optional additive field
 *  on the task payload for the parallel-window badge (U9). */
interface BranchProgressEntry {
  branchId: string;
  nodeId: string;
  status: string;
}
type TaskWithBranchProgress = Task & { branchProgress?: BranchProgressEntry[] };

// ── Mission title caching ───────────────────────────────────────────────────

const missionTitleCache = new Map<string, string>();

/** @internal Test helper to reset the mission title cache between tests */
export function __test_clearMissionTitleCache(): void {
  missionTitleCache.clear();
}

async function getMissionTitle(missionId: string, projectId?: string): Promise<string> {
  const cached = missionTitleCache.get(missionId);
  if (cached) return cached;

  try {
    const mission = await fetchMission(missionId, projectId);
    missionTitleCache.set(missionId, mission.title);
    return mission.title;
  } catch {
    return missionId;
  }
}

const MAX_MISSION_TITLE_LENGTH = 12;

function abbreviateMissionTitle(title: string): string {
  if (title.length <= MAX_MISSION_TITLE_LENGTH) return title;
  return title.slice(0, MAX_MISSION_TITLE_LENGTH - 3) + "...";
}

// ── Assigned agent name caching ─────────────────────────────────────────────

const agentNameCache = new Map<string, string>();

/** @internal Test helper to reset the assigned agent cache between tests */
export function __test_clearAgentNameCache(): void {
  agentNameCache.clear();
}

async function getAgentName(agentId: string, projectId?: string): Promise<string> {
  const cached = agentNameCache.get(agentId);
  if (cached) return cached;

  try {
    const agent = await fetchAgent(agentId, projectId);
    agentNameCache.set(agentId, agent.name);
    return agent.name;
  } catch {
    return agentId;
  }
}

function normalizeTaskPriorityValue(priority: Task["priority"]): TaskPriority {
  return typeof priority === "string" && (TASK_PRIORITIES as readonly string[]).includes(priority)
    ? (priority as TaskPriority)
    : DEFAULT_TASK_PRIORITY;
}

function abbreviateBadge(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

function getResolvedAgentNameFromMap(
  agentId: string | undefined,
  agentsMap: ReadonlyMap<string, { name?: string | null }>,
): string | undefined {
  if (typeof agentId !== "string" || agentId.trim().length === 0) {
    return undefined;
  }

  const cachedName = agentsMap.get(agentId)?.name;
  return typeof cachedName === "string" && cachedName.trim().length > 0 ? cachedName.trim() : undefined;
}

function getSourceAgentName(
  task: Task,
  agentsMap?: ReadonlyMap<string, { name?: string | null }>,
): string | undefined {
  const metadataAgentName = task.sourceMetadata?.agentName;
  if (typeof metadataAgentName === "string" && metadataAgentName.trim().length > 0) {
    return metadataAgentName.trim();
  }

  const resolvedAgentName = getResolvedAgentNameFromMap(task.sourceAgentId, agentsMap ?? new Map());
  if (resolvedAgentName) {
    return resolvedAgentName;
  }

  if (typeof task.sourceAgentId === "string" && task.sourceAgentId.trim().length > 0) {
    return task.sourceAgentId.trim();
  }

  return undefined;
}

function isAgentCreatedTask(task: Task): boolean {
  return task.sourceType === "agent_heartbeat" || task.sourceType === "automation" || Boolean(getSourceAgentName(task));
}

// ── Constants ───────────────────────────────────────────────────────────────

// Issue 1403: widened to ColumnId so `.has(task.column)` accepts custom column ids
// (which are not members and correctly resolve to false).
const EDITABLE_COLUMNS: Set<ColumnId> = new Set<ColumnId>(["triage", "todo"]);

const ACTIVE_STATUSES = new Set(["planning", "researching", "executing", "finalizing", "merging", "merging-fix"]);
const ACTIVE_MERGE_STATUSES = new Set(["merging", "merging-pr", "merging-fix"]);

const COLUMN_PROGRESS_COLOR_MAP: Record<Column, string> = {
  triage: "var(--triage)",
  todo: "var(--todo)",
  "in-progress": "var(--in-progress)",
  "in-review": "var(--in-review)",
  done: "var(--done)",
  archived: "var(--text-muted)",
};

const TIME_INDICATOR_COLUMNS = new Set<ColumnId>([
  "in-progress",
  "in-review",
  "done",
]);
const LIVE_TIME_INDICATOR_POLL_MS = 30_000;

function getTaskStatusLabel(status: string, t: TFunction<"app">): string {
  if (status === "merging-fix") return t("tasks.statusMergingFix", "Merging fixes…");
  return status;
}

function getDoneCompletionMs(task: Task): number | null {
  const completionMs = parseTimestampToMs(task.columnMovedAt ?? task.updatedAt);
  if (completionMs == null) return null;

  const now = Date.now();
  if (completionMs > now) return null;

  return completionMs;
}

function getInProgressElapsedMs(task: Task, nowMs: number): number | null {
  const startedMs = parseTimestampToMs(task.columnMovedAt ?? task.updatedAt);
  if (startedMs == null) return null;

  return Math.max(0, nowMs - startedMs);
}

// Wall-clock end-to-end runtime: from when the task first entered in-progress
// to when it first entered done (or `now` if not yet done). Preferred over the
// instrumented `[timing]` sum on cards in in-progress / in-review / done so the
// timer reflects how long the task actually took, not just the time spent
// inside instrumented code paths. Returns null on legacy tasks that completed
// before `executionStartedAt` was tracked, so callers can fall back.
function getTaskEndToEndDurationMs(task: Task, nowMs: number): number | null {
  if (task.cumulativeActiveMs == null) {
    return getEndToEndDurationMs(task.executionStartedAt, task.executionCompletedAt, nowMs);
  }
  return getActiveRuntimeMs(task, nowMs);
}

function getInReviewCompletionMs(task: Task): number | null {
  return task.column === "done" ? getDoneCompletionMs(task) : null;
}

function getMergeElapsedMs(task: Task, nowMs: number): number | null {
  const mergeStartedMs = parseTimestampToMs(task.updatedAt);
  if (mergeStartedMs == null) {
    return null;
  }

  return Math.max(0, nowMs - mergeStartedMs);
}

function getActiveMergeTotalMs(task: Task, nowMs: number): number | null {
  const endToEndMs = getTaskEndToEndDurationMs(task, nowMs);
  if (endToEndMs != null) {
    return endToEndMs;
  }

  const mergeElapsedMs = getMergeElapsedMs(task, nowMs);
  const instrumentedMs = getInstrumentedDurationMs(task, nowMs);
  if (instrumentedMs != null) {
    return instrumentedMs + (mergeElapsedMs ?? 0);
  }

  return mergeElapsedMs;
}


function getInstrumentedDurationMs(task: Task, nowMs: number): number | null {
  // Prefer server aggregate when present: it is the canonical persisted runtime
  // and may already include workflow execution. Avoid adding workflow runtime
  // again in that case.
  if (typeof task.timedExecutionMs === "number") {
    return task.timedExecutionMs;
  }

  const timed = getTimedDurationMs(task.log);
  const workflow = getWorkflowRuntimeMs(task.workflowStepResults, nowMs);
  if (timed == null && workflow == null) return null;
  return (timed ?? 0) + (workflow ?? 0);
}

function formatElapsedDuration(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "";

  if (elapsedMs < 60_000) return "<1m";

  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}d`;
}

function normalizeBranchValue(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getVisibleTaskCardBranches(task: Task): { branch: string | null; baseBranch: string | null } {
  const branch = normalizeBranchValue(task.branch);
  const baseBranch = normalizeBranchValue(task.baseBranch);
  const defaultBranchPrefix = `fusion/${task.id.toLowerCase()}`;

  const visibleBranch =
    branch && (branch === defaultBranchPrefix || branch.startsWith(`${defaultBranchPrefix}-`))
      ? null
      : branch;

  const visibleBaseBranch = baseBranch?.toLowerCase() === "main" ? null : baseBranch;

  return {
    branch: visibleBranch,
    baseBranch: visibleBaseBranch ?? null,
  };
}

export function formatElapsedDurationDone(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "";
  if (elapsedMs === 0) return "";

  const elapsedMinutes = Math.ceil(elapsedMs / 60_000);
  if (elapsedMinutes < 59) return `${elapsedMinutes}m`;

  const elapsedHours = Math.ceil(elapsedMs / 3_600_000);
  if (elapsedHours < 24) return `${elapsedHours}h`;

  const elapsedDays = Math.ceil(elapsedMs / 86_400_000);
  return `${elapsedDays}d`;
}


/** Max number of card-placed custom fields rendered before an overflow chip
 *  (KTD-14: "max 3 card fields rendered with a +N overflow indicator"). */
const MAX_CARD_FIELDS = 3;

/** Render a single card-placed custom field value as a badge/chip (U13/KTD-14).
 *  Returns null for empty/unset values so absent fields take no card space. */
function renderCardFieldBadge(
  field: WorkflowFieldDefinition,
  value: unknown,
): ReactElement | null {
  const colorOf = (v: string): string | undefined => field.options?.find((o) => o.value === v)?.color;
  const labelOf = (v: string): string => field.options?.find((o) => o.value === v)?.label ?? v;

  if (field.type === "boolean") {
    // Boolean true → labeled chip; false/unset → nothing.
    if (value !== true) return null;
    return (
      <span key={field.id} className="card-field-badge card-field-badge--boolean" title={field.name}>
        {field.name}
      </span>
    );
  }
  if (field.type === "enum") {
    if (typeof value !== "string" || value === "") return null;
    const color = colorOf(value);
    return (
      <span
        key={field.id}
        className="card-field-badge card-field-badge--enum"
        title={`${field.name}: ${labelOf(value)}`}
        style={color ? { backgroundColor: color, borderColor: color, color: "white" } : undefined}
      >
        {labelOf(value)}
      </span>
    );
  }
  if (field.type === "multi-enum") {
    const arr = Array.isArray(value) ? (value as string[]) : [];
    if (arr.length === 0) return null;
    return (
      <span key={field.id} className="card-field-badge card-field-badge--multi" title={field.name}>
        {arr.map((v) => {
          const color = colorOf(v);
          return (
            <span
              key={v}
              className="card-field-badge-token"
              style={color ? { backgroundColor: color, borderColor: color, color: "white" } : undefined}
            >
              {labelOf(v)}
            </span>
          );
        })}
      </span>
    );
  }
  // string / text / number / date / url → simple labeled chip.
  if (value === undefined || value === null || value === "") return null;
  const display = field.type === "date" && typeof value === "string" ? value.slice(0, 10) : String(value);
  return (
    <span key={field.id} className="card-field-badge" title={`${field.name}: ${display}`}>
      {display}
    </span>
  );
}

interface TaskCardProps {
  task: Task;
  projectId?: string;
  queued?: boolean;
  onOpenDetail: (task: Task | TaskDetail) => void;
  onOpenGroupModal?: (groupId: string) => void;
  addToast: (message: string, type?: ToastType) => void;
  globalPaused?: boolean;
  onUpdateTask?: (
    id: string,
    updates: { title?: string; description?: string; dependencies?: string[]; dismissNearDuplicate?: boolean }
  ) => Promise<Task>;
  onArchiveTask?: (id: string, options?: { removeLineageReferences?: boolean }) => Promise<Task>;
  onUnarchiveTask?: (id: string) => Promise<Task>;
  onDeleteTask?: (id: string, options?: {
    removeDependencyReferences?: boolean;
    removeLineageReferences?: boolean;
    githubIssueAction?: GithubIssueAction;
  }) => Promise<Task>;
  onRetryTask?: (id: string) => Promise<Task>;
  onOpenDetailWithTab?: (task: Task | TaskDetail, initialTab: "changes" | "retries" | "workflow") => void;
  /** Project-level stuck task timeout in milliseconds (undefined = disabled) */
  taskStuckTimeoutMs?: number;
  /** Called when user clicks the mission badge on a task card. */
  onOpenMission?: (missionId: string) => void;
  /** Called when user moves a task to a different column from the card. */
  onMoveTask?: (id: string, column: Column, optionsOrPosition?: { preserveProgress?: boolean } | number) => Promise<Task>;
  /** Called when user promotes a held task out of a hold column. */
  onPromote?: (taskId: string) => Promise<void>;
  /** True while this task's promote action is in flight. */
  isPromoting?: boolean;
  /** Timestamp (ms) when task data was last confirmed fresh from the server. Used for freshness-aware stuck detection. */
  lastFetchTimeMs?: number;
  /** Lookup of workflow step IDs to display names, fetched once at board level. */
  workflowStepNameLookup?: ReadonlyMap<string, string>;
  /** Disable card drag semantics when embedding in custom draggable containers (e.g. dependency graph). */
  disableDrag?: boolean;
  /** Downstream fan-out entry for this task, computed at board-level. */
  fanout?: BlockerFanoutEntry;
  /** Whether GitHub CLI auth is available for creating PRs from task cards. */
  prAuthAvailable?: boolean;
  /** Project default auto-merge setting; per-task overrides are applied via resolveEffectiveAutoMerge. */
  autoMergeEnabled?: boolean;
  /** Card-placed custom field definitions for this task's workflow (U13/KTD-14).
   *  Empty/undefined → no field badges render (card byte-identical to today). */
  cardFieldDefs?: WorkflowFieldDefinition[];
  /** Unified PR entity node-state for this task's work, surfaced on the card (R12).
   *  When present, the card shows a node-state badge linking to the PR view. The
   *  `failed` state renders a DISTINCT error badge (not the open-PR badge). */
  prNode?: { id: string; state: "creating" | "open" | "responding" | "merged" | "closed" | "failed"; prNumber?: number };
  /** Called when the PR node badge is clicked — opens the dedicated PR view (R12). */
  onOpenPullRequest?: (prEntityId: string) => void;
  /**
   * CLI agent session state for this task's session (CLI Agent Executor, U11).
   * Drives the waiting-on-input / needs-attention card badges, which are
   * DISTINCT from staleness/stall badges (which U8 suppresses in these states).
   * Undefined when the task has no CLI session → no badge (card unchanged).
   */
  /** True when the board-level task list proves the near-duplicate canonical is inactive or missing. */
  nearDuplicateCanonicalInactive?: boolean;
  cliSessionState?: CliCardState;
}

/** Minimal CLI session shape the card needs for its badges (U11). */
export interface CliCardState {
  agentState:
    | "starting"
    | "ready"
    | "busy"
    | "waitingOnInput"
    | "done"
    | "dead"
    | "needsAttention";
}

function getTaskPrimaryPrInfo(task: Pick<Task, "prInfo" | "prInfos">): PrInfo | undefined {
  return task.prInfos?.[0] ?? task.prInfo;
}

function areTaskBadgeInfosEqual(
  previous: PrInfo | IssueInfo | undefined,
  next: PrInfo | IssueInfo | undefined,
): boolean {
  if (!previous && !next) return true;
  if (!previous || !next) return false;

  const previousKeys = Object.keys(previous) as Array<keyof typeof previous>;
  const nextKeys = Object.keys(next) as Array<keyof typeof next>;

  if (previousKeys.length !== nextKeys.length) return false;

  return previousKeys.every((key) => previous[key] === next[key]);
}

function areTaskStepsEqual(previous: Task["steps"], next: Task["steps"]): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((step, index) => step.name === next[index]?.name && step.status === next[index]?.status);
}

function areTaskDependenciesEqual(previous: string[], next: string[]): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((dependency, index) => dependency === next[index]);
}

function areTaskWorkflowStepIdsEqual(previous?: string[], next?: string[]): boolean {
  if (!previous && !next) return true;
  if (!previous || !next) return false;
  if (previous.length !== next.length) return false;
  return previous.every((stepId, index) => stepId === next[index]);
}

function getIssueUrlFromMetadata(metadata: Task["sourceMetadata"]): string | undefined {
  const issueUrl = metadata?.issueUrl;
  return typeof issueUrl === "string" && issueUrl.length > 0 ? issueUrl : undefined;
}

function parseGithubIssueUrl(url?: string): { owner: string; repo: string; number: number } | null {
  if (!url) return null;
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:$|[/?#])/i);
  if (!match) return null;

  const issueNumber = Number(match[3]);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return null;

  return {
    owner: match[1],
    repo: match[2],
    number: issueNumber,
  };
}

function areTaskWorkflowResultsEqual(previous?: Task["workflowStepResults"], next?: Task["workflowStepResults"]): boolean {
  if (!previous && !next) return true;
  if (!previous || !next) return false;
  if (previous.length !== next.length) return false;
  return previous.every((result, index) => {
    const nextResult = next[index];
    if (!nextResult) return false;
    return (
      result.workflowStepId === nextResult.workflowStepId &&
      result.workflowStepName === nextResult.workflowStepName &&
      result.phase === nextResult.phase &&
      result.status === nextResult.status &&
      result.output === nextResult.output &&
      result.startedAt === nextResult.startedAt &&
      result.completedAt === nextResult.completedAt
    );
  });
}

/**
 * Lightweight comparison for attachment metadata (not file content).
 * Compares counts and top-level fields that affect card rendering.
 */
function areAttachmentsEqual(previous: Task["attachments"], next: Task["attachments"]): boolean {
  if (!previous && !next) return true;
  if (!previous || !next) return false;
  if (previous.length !== next.length) return false;

  // Compare attachment metadata that affects card rendering
  return previous.every((att, i) => {
    const nextAtt = next[i];
    if (!nextAtt) return false;
    // Compare fields that affect the card's visual state
    return (
      att.filename === nextAtt.filename &&
      att.mimeType === nextAtt.mimeType &&
      att.size === nextAtt.size
    );
  });
}

/**
 * Lightweight comparison for comments.
 * Compares counts and top-level fields that affect card rendering.
 */
function areCommentsEqual(previous: Task["comments"], next: Task["comments"]): boolean {
  if (!previous && !next) return true;
  if (!previous || !next) return false;
  if (previous.length !== next.length) return false;

  // Compare comment metadata that affects card rendering
  return previous.every((comment, i) => {
    const nextComment = next[i];
    if (!nextComment) return false;
    return (
      comment.author === nextComment.author &&
      comment.text === nextComment.text &&
      comment.createdAt === nextComment.createdAt
    );
  });
}

// Keep this comparator aligned with the fields TaskCard renders directly and the
// task metadata that influences child badge freshness/subscriptions.
function areTaskCardPropsEqual(previous: TaskCardProps, next: TaskCardProps): boolean {
  const previousTask = previous.task;
  const nextTask = next.task;

  return (
    previous.queued === next.queued &&
    previous.projectId === next.projectId &&
    previous.globalPaused === next.globalPaused &&
    previous.taskStuckTimeoutMs === next.taskStuckTimeoutMs &&
    previous.prAuthAvailable === next.prAuthAvailable &&
    previous.autoMergeEnabled === next.autoMergeEnabled &&
    previous.onOpenPullRequest === next.onOpenPullRequest &&
    previous.prNode?.id === next.prNode?.id &&
    previous.prNode?.state === next.prNode?.state &&
    previous.prNode?.prNumber === next.prNode?.prNumber &&
    previous.cliSessionState?.agentState === next.cliSessionState?.agentState &&
    previous.nearDuplicateCanonicalInactive === next.nearDuplicateCanonicalInactive &&
    previous.cardFieldDefs === next.cardFieldDefs &&
    (previous.cardFieldDefs == null && next.cardFieldDefs == null
      ? true
      : JSON.stringify(previousTask.customFields ?? null) === JSON.stringify(nextTask.customFields ?? null)) &&
    previous.onOpenDetail === next.onOpenDetail &&
    previous.onOpenGroupModal === next.onOpenGroupModal &&
    previous.addToast === next.addToast &&
    previous.onUpdateTask === next.onUpdateTask &&
    previous.onArchiveTask === next.onArchiveTask &&
    previous.onUnarchiveTask === next.onUnarchiveTask &&
    previous.onDeleteTask === next.onDeleteTask &&
    previous.onRetryTask === next.onRetryTask &&
    previous.onOpenDetailWithTab === next.onOpenDetailWithTab &&
    previous.onOpenMission === next.onOpenMission &&
    previous.onMoveTask === next.onMoveTask &&
    previous.onPromote === next.onPromote &&
    previous.isPromoting === next.isPromoting &&
    previous.workflowStepNameLookup === next.workflowStepNameLookup &&
    previous.disableDrag === next.disableDrag &&
    previous.fanout?.totalCount === next.fanout?.totalCount &&
    previous.fanout?.activeTodoCount === next.fanout?.activeTodoCount &&
    previous.fanout?.isHighFanout === next.fanout?.isHighFanout &&
    previous.fanout?.overlapBlockedTodoCount === next.fanout?.overlapBlockedTodoCount &&
    previous.fanout?.escalation?.blockingAgeMs === next.fanout?.escalation?.blockingAgeMs &&
    areTaskDependenciesEqual(previous.fanout?.dependentIds ?? [], next.fanout?.dependentIds ?? []) &&
    areTaskDependenciesEqual(previous.fanout?.staleBlockedByDependentIds ?? [], next.fanout?.staleBlockedByDependentIds ?? []) &&
    previousTask.id === nextTask.id &&
    previousTask.title === nextTask.title &&
    previousTask.description === nextTask.description &&
    previousTask.column === nextTask.column &&
    ((previousTask as TaskWithBranchProgress).branchProgress?.length ?? 0) ===
      ((nextTask as TaskWithBranchProgress).branchProgress?.length ?? 0) &&
    previousTask.columnMovedAt === nextTask.columnMovedAt &&
    previousTask.timedExecutionMs === nextTask.timedExecutionMs &&
    previousTask.updatedAt === nextTask.updatedAt &&
    previousTask.createdAt === nextTask.createdAt &&
    previousTask.status === nextTask.status &&
    previousTask.priority === nextTask.priority &&
    previousTask.executionMode === nextTask.executionMode &&
    previousTask.paused === nextTask.paused &&
    previousTask.userPaused === nextTask.userPaused &&
    previousTask.error === nextTask.error &&
    previousTask.size === nextTask.size &&
    previousTask.blockedBy === nextTask.blockedBy &&
    previousTask.overlapBlockedBy === nextTask.overlapBlockedBy &&
    previousTask.worktree === nextTask.worktree &&
    // FNXC:Workspace 2026-06-21-22:30: re-render the card when a workspace task acquires/
    // releases sub-repo worktrees so the "N repos acquired" placeholder stays current (U3).
    // F7 — compare the sorted key SETS, not just the count: a same-count repo swap (one
    // repo released, a different one acquired) keeps the count but must still re-render,
    // otherwise the placeholder shows a stale repo set.
    // FNXC:Workspace 2026-06-22-09:00: compare full VALUES, not only the key set. A
    // pool-reclaim re-acquire keeps the same repo key but produces a different
    // worktreePath/branch; a key-set-only check would leave the card showing stale path
    // text. Whole-map JSON compare covers keys and values at negligible cost for small N.
    JSON.stringify(previousTask.workspaceWorktrees ?? null) ===
      JSON.stringify(nextTask.workspaceWorktrees ?? null) &&
    previousTask.branch === nextTask.branch &&
    previousTask.baseBranch === nextTask.baseBranch &&
    previousTask.breakIntoSubtasks === nextTask.breakIntoSubtasks &&
    previousTask.currentStep === nextTask.currentStep &&
    previousTask.modelProvider === nextTask.modelProvider &&
    previousTask.modelId === nextTask.modelId &&
    previousTask.validatorModelProvider === nextTask.validatorModelProvider &&
    previousTask.validatorModelId === nextTask.validatorModelId &&
    previousTask.planningModelProvider === nextTask.planningModelProvider &&
    previousTask.planningModelId === nextTask.planningModelId &&
    previousTask.reviewLevel === nextTask.reviewLevel &&
    previousTask.missionId === nextTask.missionId &&
    previousTask.assignedAgentId === nextTask.assignedAgentId &&
    previousTask.mergeRetries === nextTask.mergeRetries &&
    previousTask.retrySummary?.total === nextTask.retrySummary?.total &&
    previousTask.sourceType === nextTask.sourceType &&
    previousTask.sourceAgentId === nextTask.sourceAgentId &&
    previousTask.sourceMetadata?.issueUrl === nextTask.sourceMetadata?.issueUrl &&
    previousTask.sourceMetadata?.agentName === nextTask.sourceMetadata?.agentName &&
    previousTask.sourceMetadata?.nearDuplicateOf === nextTask.sourceMetadata?.nearDuplicateOf &&
    previousTask.sourceMetadata?.nearDuplicateDismissed === nextTask.sourceMetadata?.nearDuplicateDismissed &&
    previousTask.stalledReview?.reason === nextTask.stalledReview?.reason &&
    previousTask.stalledReview?.heuristic === nextTask.stalledReview?.heuristic &&
    previousTask.stalledReview?.matchCount === nextTask.stalledReview?.matchCount &&
    previousTask.stalledReview?.firstMatchAt === nextTask.stalledReview?.firstMatchAt &&
    previousTask.stalledReview?.lastMatchAt === nextTask.stalledReview?.lastMatchAt &&
    previousTask.ageStaleness?.level === nextTask.ageStaleness?.level &&
    previousTask.ageStaleness?.reason === nextTask.ageStaleness?.reason &&
    previousTask.ageStaleness?.observedAt === nextTask.ageStaleness?.observedAt &&
    previousTask.ageStaleness?.ageMs === nextTask.ageStaleness?.ageMs &&
    previousTask.ageStaleness?.warningThresholdMs === nextTask.ageStaleness?.warningThresholdMs &&
    previousTask.ageStaleness?.criticalThresholdMs === nextTask.ageStaleness?.criticalThresholdMs &&
    previousTask.ageStaleness?.column === nextTask.ageStaleness?.column &&
    previousTask.ageStaleness?.paused === nextTask.ageStaleness?.paused &&
    areAttachmentsEqual(previousTask.attachments, nextTask.attachments) &&
    areCommentsEqual(previousTask.comments, nextTask.comments) &&
    areTaskDependenciesEqual(previousTask.dependencies, nextTask.dependencies) &&
    areTaskStepsEqual(previousTask.steps, nextTask.steps) &&
    areTaskWorkflowStepIdsEqual(previousTask.enabledWorkflowSteps, nextTask.enabledWorkflowSteps) &&
    areTaskWorkflowResultsEqual(previousTask.workflowStepResults, nextTask.workflowStepResults) &&
    areTaskBadgeInfosEqual(previousTask.prInfo, nextTask.prInfo) &&
    ((previousTask.prInfos?.length ?? 0) === (nextTask.prInfos?.length ?? 0)) &&
    (previousTask.prInfos ?? []).every((pr, index) => {
      const nextPr = nextTask.prInfos?.[index];
      return nextPr?.number === pr.number && nextPr?.status === pr.status;
    }) &&
    areTaskBadgeInfosEqual(previousTask.issueInfo, nextTask.issueInfo)
  );
}

function TaskCardComponent({
  task,
  projectId,
  queued,
  onOpenDetail,
  onOpenGroupModal,
  addToast,
  globalPaused,
  onUpdateTask,
  onArchiveTask,
  onUnarchiveTask,
  onDeleteTask,
  onRetryTask,
  onOpenDetailWithTab,
  taskStuckTimeoutMs,
  onOpenMission,
  onMoveTask,
  onPromote,
  isPromoting = false,
  lastFetchTimeMs,
  workflowStepNameLookup,
  disableDrag,
  fanout,
  prAuthAvailable,
  autoMergeEnabled = false,
  cardFieldDefs,
  prNode,
  onOpenPullRequest,
  cliSessionState,
  nearDuplicateCanonicalInactive,
}: TaskCardProps) {
  const { t } = useTranslation("app");
  const columnLabel = useColumnLabel();
  const [dragging, setDragging] = useState(false);
  const [fileDragOver, setFileDragOver] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editDescription, setEditDescription] = useState(task.description || "");
  const [isSaving, setIsSaving] = useState(false);
  const [showSteps, setShowSteps] = useState(
    task.column === "in-progress" ||
    (task.column === "triage" && task.steps.some(s => s.status === "done" || s.status === "skipped"))
  );
  const [missionTitle, setMissionTitle] = useState<string | null>(null);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [showSendBackMenu, setShowSendBackMenu] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isPrCreateOpen, setIsPrCreateOpen] = useState(false);
  const [timeIndicatorNowMs, setTimeIndicatorNowMs] = useState(() => Date.now());

  const descTextareaRef = useRef<HTMLTextAreaElement>(null);
  const touchOpenHandledRef = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const sendBackRef = useRef<HTMLDivElement>(null);
  const [isInViewport, setIsInViewport] = useState(false);
  const { badgeUpdates, subscribeToBadge, unsubscribeFromBadge } = useBadgeWebSocket(projectId);
  const { agentsMap } = useAgentsMapCache(projectId);
  const { confirm } = useConfirm();
  const retryWarningThreshold = useRetryWarning();

  // Touch gesture detection refs
  const touchStartPosRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const hasTouchMovedRef = useRef(false);

  const isInteractiveTarget = useCallback((target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    return !!target.closest("button, a, input, textarea, select, label, [role='button']");
  }, []);

  // Reset edit state when task changes
  useEffect(() => {
    setEditDescription(task.description || "");
  }, [task.id, task.description]);

  // Close send-back menu on outside click
  useEffect(() => {
    if (!showSendBackMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (sendBackRef.current && !sendBackRef.current.contains(e.target as Node)) {
        setShowSendBackMenu(false);
      }
    };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [showSendBackMenu]);

  // Fetch mission title when missionId is set
  useEffect(() => {
    if (!task.missionId) {
      setMissionTitle(null);
      return;
    }

    // Check cache synchronously first
    const cached = missionTitleCache.get(task.missionId);
    if (cached) {
      setMissionTitle(cached);
      return;
    }

    let cancelled = false;
    void getMissionTitle(task.missionId, projectId).then((title) => {
      if (!cancelled) setMissionTitle(title);
    });
    return () => { cancelled = true; };
  }, [task.missionId, projectId]);

  // Fetch assigned agent name when assignedAgentId is set
  useEffect(() => {
    if (!task.assignedAgentId) {
      setAgentName(null);
      return;
    }

    const cachedFromMap = getResolvedAgentNameFromMap(task.assignedAgentId, agentsMap);
    if (cachedFromMap) {
      agentNameCache.set(task.assignedAgentId, cachedFromMap);
      setAgentName(cachedFromMap);
      return;
    }

    const cached = agentNameCache.get(task.assignedAgentId);
    if (cached) {
      setAgentName(cached);
      return;
    }

    setAgentName(null);

    let cancelled = false;
    void getAgentName(task.assignedAgentId, projectId).then((name) => {
      if (!cancelled) setAgentName(name);
    });
    return () => { cancelled = true; };
  }, [agentsMap, task.assignedAgentId, projectId]);

  // Auto-focus and auto-resize description textarea when entering edit mode
  useEffect(() => {
    if (isEditing && descTextareaRef.current) {
      const el = descTextareaRef.current;
      el.focus();
      // Apply the same resize logic used in handleDescChange so the textarea
      // opens at the correct height for existing long descriptions without
      // requiring the user to type first.
      el.style.height = "auto";
      el.style.height = el.scrollHeight + "px";
    }
  }, [isEditing]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      setIsInViewport(true);
      return;
    }

    const element = cardRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsInViewport(entry?.isIntersecting ?? true);
      },
      { rootMargin: "200px" },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [isEditing, task.id]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", task.id);
    e.dataTransfer.effectAllowed = "move";
    setDragging(true);
  }, [task.id]);

  const handleDragEnd = useCallback(() => {
    setDragging(false);
  }, []);

  const isFileDrag = useCallback((e: React.DragEvent) => {
    return e.dataTransfer.types.includes("Files");
  }, []);

  const handleFileDragOver = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setFileDragOver(true);
  }, [isFileDrag]);

  const handleFileDragLeave = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setFileDragOver(false);
  }, [isFileDrag]);

  const handleFileDrop = useCallback(async (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setFileDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      try {
        await uploadAttachment(task.id, file, projectId);
        addToast(t("tasks.attachedFile", "Attached {{fileName}} to {{taskId}}", { fileName: file.name, taskId: task.id }), "success");
      } catch (err) {
        addToast(t("tasks.attachFileFailed", "Failed to attach {{fileName}}: {{error}}", { fileName: file.name, error: getErrorMessage(err) }), "error");
      }
    }
  }, [task.id, isFileDrag, addToast]);

  const handleClick = useCallback(() => {
    if (isEditing) return; // Don't open detail when editing
    onOpenDetail(task);
  }, [task, onOpenDetail, isEditing]);

  const handleCardClick = useCallback((e: React.MouseEvent) => {
    if (touchOpenHandledRef.current) {
      touchOpenHandledRef.current = false;
      return;
    }
    if (isInteractiveTarget(e.target)) return;
    void handleClick();
  }, [handleClick, isInteractiveTarget]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    
    touchStartPosRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    hasTouchMovedRef.current = false;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartPosRef.current) return;
    
    const touch = e.touches[0];
    if (!touch) return;
    
    const dx = Math.abs(touch.clientX - touchStartPosRef.current.x);
    const dy = Math.abs(touch.clientY - touchStartPosRef.current.y);
    
    // If moved beyond threshold, mark as moved (scrolling/dragging)
    if (dx > TOUCH_MOVE_THRESHOLD || dy > TOUCH_MOVE_THRESHOLD) {
      hasTouchMovedRef.current = true;
    }
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (isInteractiveTarget(e.target)) return;
    
    // Check if this was a valid tap (not a scroll)
    if (!touchStartPosRef.current) return;
    
    const touchDuration = Date.now() - touchStartPosRef.current.time;
    const isQuickTap = touchDuration < TOUCH_TAP_MAX_DURATION;
    const isStationary = !hasTouchMovedRef.current;
    
    // Only open modal for quick taps that didn't move significantly.
    // Prevent default here to suppress Android compatibility mouse events
    // (mousedown/mouseup/click) that would otherwise hit a newly-mounted overlay.
    if (isQuickTap && isStationary) {
      e.preventDefault();
      touchOpenHandledRef.current = true;
      void handleClick();
    }
    
    // Reset touch tracking
    touchStartPosRef.current = null;
    hasTouchMovedRef.current = false;
  }, [handleClick, isInteractiveTarget]);

  const handleDepClick = useCallback(async (e: React.MouseEvent, depId: string) => {
    e.stopPropagation(); // Prevent card click
    try {
      const detail = await fetchTaskDetail(depId, projectId);
      onOpenDetail(detail);
    } catch {
      addToast(t("tasks.loadDependencyFailed", "Failed to load dependency {{depId}}", { depId }), "error");
    }
  }, [onOpenDetail, addToast]);

  const isDoneColumn = task.column === "done";
  const visualStatus = isDoneColumn ? "done" : task.status;
  const isFailed = !isDoneColumn && task.status === "failed";
  const isPaused = !isDoneColumn && (task.paused === true || task.userPaused === true);
  const pausedByAgent = Boolean(!isDoneColumn && task.paused && task.pausedByAgentId);
  const normalizedPriority = normalizeTaskPriorityValue(task.priority);
  const showPriorityBadge = normalizedPriority !== DEFAULT_TASK_PRIORITY;
  const isStuck = isTaskStuck(task, taskStuckTimeoutMs, lastFetchTimeMs);
  const stalledReview = getStalledReviewSignal(task);
  const showStalledReview = Boolean(stalledReview && task.column === "in-review" && !isPaused);
  const hasInReviewStall = shouldShowInReviewStallBadge(task);
  // CLI agent session badges (U11) — distinct from staleness/stall badges.
  const cliWaitingOnInput = cliSessionState?.agentState === "waitingOnInput";
  const cliNeedsAttention = cliSessionState?.agentState === "needsAttention";
  const stallCopy = task.inReviewStall
    ? getInReviewStallCopy(task.inReviewStall, {
      mergeRetries: task.mergeRetries,
      maxAutoMergeRetries: MAX_AUTO_MERGE_RETRIES,
    })
    : undefined;
  const hasStalePausedReview = shouldShowStalePausedReviewBadge(task);
  const stalePausedReviewCopy = task.stalePausedReview ? getStalePausedReviewCopy(task.stalePausedReview) : undefined;
  const hasTaskAgeStaleness = shouldShowTaskAgeStalenessBadge(task);
  const taskAgeStalenessCopy = getTaskAgeStalenessCopy(task.ageStaleness);
  const isAwaitingApproval = task.column === "triage" && task.status === "awaiting-approval";
  const isAwaitingInput = task.status === "awaiting-user-input";
  const isArchived = task.column === "archived";
  const isAgentActive = !globalPaused && !queued && !isFailed && !isPaused && !isStuck && !isAwaitingApproval && !isAwaitingInput && (task.column === "in-progress" || ACTIVE_STATUSES.has(visualStatus as string));
  // Native HTML5 drag is desktop-mouse only — it doesn't move cards via touch.
  // On touch-primary devices the `draggable` attribute still arms the browser's
  // touch-drag heuristic, which intermittently hijacks horizontal swipes meant
  // to scroll the board. Drop drag on coarse pointers so panning stays reliable.
  const isCoarsePointer = useCoarsePointer();
  const isDraggable = !disableDrag && !queued && !isPaused && !isEditing && !isArchived && !isCoarsePointer; // Disable drag during edit/archived, host embedding, or touch

  // Check if this card can be edited inline
  const canEdit = EDITABLE_COLUMNS.has(task.column) && !isAgentActive && !isPaused && !queued && onUpdateTask;
  const githubTrackedIssue = task.githubTracking?.issue;
  const hasGithubTrackingLink = Boolean(githubTrackedIssue);
  const isGitHubImportedTask = task.sourceType === "github_import";
  const sourceIssueUrl = getIssueUrlFromMetadata(task.sourceMetadata);
  const sourceIssueFromUrl = useMemo(() => parseGithubIssueUrl(sourceIssueUrl), [sourceIssueUrl]);
  const issueInfoFromUrl = useMemo(() => parseGithubIssueUrl(task.issueInfo?.url), [task.issueInfo?.url]);
  const issueInfoOwner = issueInfoFromUrl?.owner;
  const issueInfoRepo = issueInfoFromUrl?.repo;
  const hasMatchingIssueInfoBadge = Boolean(
    task.issueInfo
    && githubTrackedIssue
    && task.issueInfo.number === githubTrackedIssue.number
    && issueInfoOwner === githubTrackedIssue.owner
    && issueInfoRepo === githubTrackedIssue.repo,
  );
  const hasMatchingSourceIssue = Boolean(
    sourceIssueFromUrl
    && githubTrackedIssue
    && sourceIssueFromUrl.number === githubTrackedIssue.number
    && sourceIssueFromUrl.owner === githubTrackedIssue.owner
    && sourceIssueFromUrl.repo === githubTrackedIssue.repo,
  );
  const showLinkedIssueChipForImport = isGitHubImportedTask
    && hasGithubTrackingLink
    && (hasMatchingIssueInfoBadge || hasMatchingSourceIssue);
  const showTrackingIndicator = hasGithubTrackingLink
    && !hasMatchingIssueInfoBadge
    && !hasMatchingSourceIssue;
  /**
   * FNXC:NearDuplicateDetection 2026-06-14-12:00:
   * The card chip is a user-facing duplicate affordance, so hide it when a parent with the task list proves the canonical is inactive or missing.
   * Undefined preserves legacy rendering for embedded card surfaces that cannot resolve the canonical locally.
   */
  const showNearDuplicateChip = Boolean(task.sourceMetadata?.nearDuplicateOf)
    && task.sourceMetadata?.nearDuplicateDismissed !== true
    && task.column !== "archived"
    && task.column !== "done"
    && nearDuplicateCanonicalInactive !== true;
  const branchMetadata = useMemo(() => getVisibleTaskCardBranches(task), [task.id, task.branch, task.baseBranch]);
  const hasBranchMetadata = Boolean(branchMetadata.branch || branchMetadata.baseBranch);
  const isAgentCreated = isAgentCreatedTask(task);
  const sourceAgentName = getSourceAgentName(task, agentsMap);
  const agentCreatedVisibleLabel = sourceAgentName ? abbreviateBadge(sourceAgentName, 15) : t("tasks.agentLabel", "Agent");
  const agentCreatedTitle = sourceAgentName
    ? t("tasks.createdByAgentNamed", "Created by agent: {{name}}", { name: sourceAgentName })
    : t("tasks.createdByAgent", "Created by agent");
  const assignedAgentNameFromMap = getResolvedAgentNameFromMap(task.assignedAgentId, agentsMap);
  const assignedAgentNameFromCache = task.assignedAgentId ? agentNameCache.get(task.assignedAgentId) ?? null : null;
  const resolvedAssignedAgentName = assignedAgentNameFromMap ?? assignedAgentNameFromCache ?? agentName;
  const assignedAgentBadgeLabel = resolvedAssignedAgentName ?? task.assignedAgentId ?? "";
  const isAgentNameLoading = Boolean(task.assignedAgentId && !resolvedAssignedAgentName);
  const taskProviders = useMemo(() => {
    const providers: string[] = [];
    if (task.modelProvider) providers.push(task.modelProvider);
    if (task.validatorModelProvider && !providers.includes(task.validatorModelProvider)) {
      providers.push(task.validatorModelProvider);
    }
    if (task.planningModelProvider && !providers.includes(task.planningModelProvider)) {
      providers.push(task.planningModelProvider);
    }
    return providers;
  }, [task.modelProvider, task.validatorModelProvider, task.planningModelProvider]);
  const unifiedProgress = useMemo(
    () => getUnifiedTaskProgress(task, workflowStepNameLookup),
    [task.steps, task.enabledWorkflowSteps, task.workflowStepResults, workflowStepNameLookup],
  );
  const showProgressSection =
    unifiedProgress.total > 0 && (task.status === "executing" || task.column === "in-progress");

  useEffect(() => {
    if (task.column !== "in-progress" && task.column !== "in-review") {
      return;
    }

    const merging = task.status != null && ACTIVE_MERGE_STATUSES.has(task.status);

    if (task.column === "in-progress") {
      const endToEndMs = getTaskEndToEndDurationMs(task, Date.now());
      const elapsedMs = getInProgressElapsedMs(task, Date.now());
      const instrumentedMs = getInstrumentedDurationMs(task, Date.now());
      if (endToEndMs == null && elapsedMs == null && instrumentedMs == null) {
        return;
      }
    }

    if (!merging && task.column === "in-review") {
      const endToEndMs = getTaskEndToEndDurationMs(task, Date.now());
      const instrumentedMs = getInstrumentedDurationMs(task, Date.now());
      if (endToEndMs == null && instrumentedMs == null) {
        return;
      }
    }

    setTimeIndicatorNowMs(Date.now());
    const interval = window.setInterval(() => {
      setTimeIndicatorNowMs(Date.now());
    }, LIVE_TIME_INDICATOR_POLL_MS);

    return () => window.clearInterval(interval);
  }, [task.column, task.status, task.columnMovedAt, task.updatedAt, task.workflowStepResults, task.timedExecutionMs, task.firstExecutionAt, task.cumulativeActiveMs, task.executionStartedAt, task.executionCompletedAt]);

  const timeIndicator = useMemo(() => {
    if (!TIME_INDICATOR_COLUMNS.has(task.column)) {
      return null;
    }

    // While a merge is actively running, continue showing live end-to-end
    // execution time. For legacy tasks without executionStartedAt, fall back
    // to instrumented runtime plus live merge-phase elapsed since `updatedAt`.
    if (task.status != null && ACTIVE_MERGE_STATUSES.has(task.status)) {
      const totalMs = getActiveMergeTotalMs(task, timeIndicatorNowMs);
      if (totalMs != null) {
        const elapsedLabel = formatElapsedDurationDone(totalMs);
        if (elapsedLabel) {
          const mergeElapsedMs = getMergeElapsedMs(task, timeIndicatorNowMs);
          const mergeLabel = mergeElapsedMs == null ? null : formatElapsedDuration(mergeElapsedMs);
          const title = mergeLabel
            ? t("tasks.executionTimeMergePhase", "Execution time {{elapsed}}. Merge phase {{merge}}", { elapsed: elapsedLabel, merge: mergeLabel })
            : t("tasks.executionTimeMerging", "Execution time {{elapsed}}. Merging", { elapsed: elapsedLabel });
          return {
            label: elapsedLabel,
            title,
            ariaLabel: title,
          };
        }
      }
    }

    if (task.column === "in-progress") {
      // Prefer the persistent execution start (set on first transition to
      // in-progress, never reset on retry-loop bounces). Fall back to the
      // columnMovedAt heuristic for legacy tasks predating the new field.
      const elapsedMs =
        getTaskEndToEndDurationMs(task, timeIndicatorNowMs)
        ?? getInProgressElapsedMs(task, timeIndicatorNowMs)
        ?? getInstrumentedDurationMs(task, timeIndicatorNowMs);
      if (elapsedMs == null) {
        return null;
      }

      const elapsedLabel = formatElapsedDuration(elapsedMs);
      if (!elapsedLabel) {
        return null;
      }

      return {
        label: elapsedLabel,
        title: t("tasks.inProgressTime", "In progress {{elapsed}}", { elapsed: elapsedLabel }),
        ariaLabel: t("tasks.inProgressTime", "In progress {{elapsed}}", { elapsed: elapsedLabel }),
      };
    }

    // in-review and done: show wall-clock end-to-end runtime. Falls back to
    // the instrumented `[timing]` aggregate for tasks completed before
    // `executionStartedAt`/`executionCompletedAt` were tracked.
    const endToEndMs = getTaskEndToEndDurationMs(task, timeIndicatorNowMs);
    const totalMs = endToEndMs ?? getInstrumentedDurationMs(task, timeIndicatorNowMs);
    if (totalMs == null) {
      return null;
    }

    const elapsedLabel = formatElapsedDurationDone(totalMs);
    if (!elapsedLabel) {
      return null;
    }

    const completionMs = getInReviewCompletionMs(task);
    if (completionMs == null) {
      return {
        label: elapsedLabel,
        title: t("tasks.executionTime", "Execution time {{elapsed}}", { elapsed: elapsedLabel }),
        ariaLabel: t("tasks.executionTime", "Execution time {{elapsed}}", { elapsed: elapsedLabel }),
      };
    }

    const completedAt = new Date(completionMs).toLocaleString();
    return {
      label: elapsedLabel,
      title: t("tasks.executionTimeCompleted", "Execution time {{elapsed}}. Completed {{completedAt}}", { elapsed: elapsedLabel, completedAt }),
      ariaLabel: t("tasks.executionTimeCompleted", "Execution time {{elapsed}}. Completed {{completedAt}}", { elapsed: elapsedLabel, completedAt }),
    };
  }, [task.column, task.status, task.columnMovedAt, task.timedExecutionMs, task.updatedAt, task.workflowStepResults, task.log, task.firstExecutionAt, task.cumulativeActiveMs, task.executionStartedAt, task.executionCompletedAt, timeIndicatorNowMs]);

  const liveBadgeData = badgeUpdates.get(`${projectId ?? "default"}:${task.id}`);

  // Get fresh batch data if available
  const batchData = useMemo(() => getFreshBatchData(task.id, projectId), [task.id, projectId]);

  const hasEverHadGitHubBadgeSourceRef = useRef(false);
  const hasCurrentGitHubBadgeSource = Boolean(
    getTaskPrimaryPrInfo(task)
    || task.issueInfo
    || liveBadgeData?.prInfo
    || liveBadgeData?.issueInfo
    || batchData?.result?.prInfo
    || batchData?.result?.issueInfo,
  );
  if (hasCurrentGitHubBadgeSource) {
    hasEverHadGitHubBadgeSourceRef.current = true;
  }
  const hasGitHubBadgeSource = hasCurrentGitHubBadgeSource || hasEverHadGitHubBadgeSourceRef.current;

  useEffect(() => {
    if (!hasGitHubBadgeSource || !isInViewport) {
      unsubscribeFromBadge(task.id);
      return;
    }

    subscribeToBadge(task.id);
    return () => {
      unsubscribeFromBadge(task.id);
    };
  }, [hasGitHubBadgeSource, isInViewport, subscribeToBadge, task.id, unsubscribeFromBadge]);

  // Compute step version for diff stats refresh when steps change
  const isActiveColumn = task.column === "in-progress" || task.column === "in-review";
  const stepVersion = useMemo(
    () => task.steps.map((s) => `${s.name}:${s.status}`).join("|"),
    [task.steps],
  );
  const mergeSignature = useMemo(() => {
    if (task.column !== "done") {
      return undefined;
    }

    const landedFilesCount = task.mergeDetails?.landedFiles?.length ?? "";
    const filesChanged = task.mergeDetails?.filesChanged ?? "";
    return `${landedFilesCount}:${filesChanged}`;
  }, [task.column, task.mergeDetails?.landedFiles?.length, task.mergeDetails?.filesChanged]);

  // Viewport-gated diff stats fetching - only fetch when card is visible
  const { stats: diffStats, loading: diffLoading } = useTaskDiffStats(
    task.id,
    task.column,
    task.mergeDetails?.commitSha,
    projectId,
    {
      enabled: isInViewport,
      worktree: task.worktree,
      stepVersion: isActiveColumn ? stepVersion : undefined,
      mergeSignature,
      pollIntervalMs: isActiveColumn ? 30_000 : undefined,
    },
  );

  // Pick the freshest data among WebSocket, batch, and task data
  const livePrInfo = useMemo(() => {
    const wsData = liveBadgeData?.prInfo;
    const wsTimestamp = liveBadgeData?.timestamp;
    const batchInfo = batchData?.result?.prInfo;
    const batchTimestamp = batchData?.timestamp ? new Date(batchData.timestamp).toISOString() : undefined;
    const taskInfo = getTaskPrimaryPrInfo(task);
    const taskTimestamp = taskInfo?.lastCheckedAt ?? task.updatedAt;

    let bestData = taskInfo;
    let bestTimestamp = taskTimestamp;

    if (wsData && (!bestTimestamp || (wsTimestamp != null && wsTimestamp >= bestTimestamp))) {
      bestData = wsData;
      bestTimestamp = wsTimestamp ?? bestTimestamp;
    }

    if (batchInfo && (!bestTimestamp || (batchTimestamp != null && batchTimestamp >= bestTimestamp))) {
      bestData = batchInfo;
    }

    return bestData;
  }, [liveBadgeData, batchData, task, task.updatedAt]);
  const liveIssueInfo = useMemo(() => {
    const wsData = liveBadgeData?.issueInfo;
    const wsTimestamp = liveBadgeData?.timestamp;
    const batchInfo = batchData?.result?.issueInfo;
    const batchTimestamp = batchData?.timestamp ? new Date(batchData.timestamp).toISOString() : undefined;
    const taskInfo = task.issueInfo;
    const taskTimestamp = task.issueInfo?.lastCheckedAt ?? task.updatedAt;

    let bestData = taskInfo;
    let bestTimestamp = taskTimestamp;

    if (wsData && (!bestTimestamp || (wsTimestamp != null && wsTimestamp >= bestTimestamp))) {
      bestData = wsData;
      bestTimestamp = wsTimestamp ?? bestTimestamp;
    }

    if (batchInfo && (!bestTimestamp || (batchTimestamp != null && batchTimestamp >= bestTimestamp))) {
      bestData = batchInfo;
    }

    return bestData;
  }, [liveBadgeData, batchData, task.issueInfo, task.updatedAt]);

  const showInReviewMoveControl = task.column === "in-review" && Boolean(onMoveTask);
  const effectiveAutoMerge = resolveEffectiveAutoMerge({ autoMerge: task.autoMerge }, { autoMerge: autoMergeEnabled ?? false });
  const showCreatePrQuickAction =
    task.column === "in-review"
    && !effectiveAutoMerge
    && !livePrInfo
    && prAuthAvailable === true
    && !isPaused
    && !isFailed
    && !queued;
  const metaRowVisible =
    (task.dependencies?.length ?? 0) > 0
    || queued
    || task.status === "queued"
    || Boolean(task.blockedBy)
    || Boolean(task.overlapBlockedBy)
    || Boolean(fanout && fanout.totalCount > 0);
  const shouldRenderActionRow = Boolean(onPromote) || showCreatePrQuickAction || (showInReviewMoveControl && !metaRowVisible);

  const renderInReviewMoveControl = () => (
    <div className="card-send-back" ref={sendBackRef}>
      <button
        className="card-send-back-btn"
        onClick={handleSendBackClick}
        title={t("tasks.moveTask", "Move task")}
        aria-label={t("tasks.moveTask", "Move task")}
        aria-haspopup="menu"
        aria-expanded={showSendBackMenu}
      >
        {t("tasks.move", "Move")}
        <ChevronDown size={10} />
      </button>
      {showSendBackMenu && (
        <div className="card-send-back-menu" role="menu">
          {VALID_TRANSITIONS["in-review"].map((col) => (
            <button
              key={col}
              className="card-send-back-menu-item"
              role="menuitem"
              onClick={(e) => handleSendBackOptionClick(e, col)}
            >
              {col === "done" ? t("tasks.doneNoMerge", "Done (no merge)") : columnLabel(col)}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const enterEditMode = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!canEdit || isSaving) return;
    setIsEditing(true);
    setEditDescription(task.description || "");
  }, [canEdit, isSaving, task.description]);

  const exitEditMode = useCallback(() => {
    setIsEditing(false);
    setEditDescription(task.description || "");
  }, [task.description]);

  const hasChanges = useCallback(() => {
    return editDescription !== (task.description || "");
  }, [editDescription, task.description]);

  const saveChanges = useCallback(async () => {
    if (!onUpdateTask || isSaving) return;
    if (!hasChanges()) {
      exitEditMode();
      return;
    }

    setIsSaving(true);
    try {
      await onUpdateTask(task.id, {
        description: editDescription.trim() || undefined,
      });
      addToast(t("tasks.updated", "Updated {{taskId}}", { taskId: task.id }), "success");
      setIsEditing(false);
    } catch (err) {
      addToast(t("tasks.updateFailed", "Failed to update {{taskId}}: {{error}}", { taskId: task.id, error: getErrorMessage(err) }), "error");
      // Stay in edit mode on error so user can retry
    } finally {
      setIsSaving(false);
    }
  }, [onUpdateTask, task.id, editDescription, isSaving, hasChanges, exitEditMode, addToast]);

  const handleDescKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void saveChanges();
    } else if (e.key === "Escape") {
      e.preventDefault();
      exitEditMode();
    }
  }, [saveChanges, exitEditMode]);

  const handleBlur = useCallback(() => {
    // Small delay to allow focus to move before checking if we should save or cancel
    setTimeout(() => {
      const activeElement = document.activeElement;
      const isFocusInEditArea =
        activeElement === descTextareaRef.current ||
        activeElement?.closest(".card-editing-content");

      if (!isFocusInEditArea) {
        if (hasChanges()) {
          void saveChanges();
        } else {
          exitEditMode();
        }
      }
    }, 0);
  }, [hasChanges, saveChanges, exitEditMode]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (canEdit) {
      e.stopPropagation();
      enterEditMode(e);
    }
  }, [canEdit, enterEditMode]);

  const handleEditClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    enterEditMode(e);
  }, [enterEditMode]);

  // Auto-resize textarea (similar to InlineCreateCard)
  const handleDescChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditDescription(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, []);

  const handleDismissNearDuplicate = useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!onUpdateTask) return;

    try {
      await onUpdateTask(task.id, { dismissNearDuplicate: true });
      addToast(t("tasks.duplicateDismissed", "Kept {{taskId}}; duplicate warning dismissed", { taskId: task.id }), "success");
    } catch (err) {
      addToast(t("tasks.keepFailed", "Failed to keep {{taskId}}: {{error}}", { taskId: task.id, error: getErrorMessage(err) }), "error");
    }
  }, [addToast, onUpdateTask, task.id]);

  const handleArchiveClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!onArchiveTask) return;

    void onArchiveTask(task.id).then(() => {
      addToast(t("tasks.archived", "Archived {{taskId}}", { taskId: task.id }), "success");
    }).catch(async (err) => {
      const lineageConflict = extractLineageDeleteConflict(err);
      if (!lineageConflict || lineageConflict.lineageChildIds.length === 0) {
        addToast(t("tasks.archiveFailed", "Failed to archive {{taskId}}: {{error}}", { taskId: task.id, error: getErrorMessage(err) }), "error");
        return;
      }

      const confirmed = await confirm({
        title: t("tasks.forceDeleteTitle", "Force Delete Task"),
        message:
          t("tasks.archiveLineageConflict", "{{taskId}} has lineage children ({{children}}) that reference it as a source parent.\n\nArchive anyway by unlinking these references first?", { taskId: task.id, children: lineageConflict.lineageChildIds.join(", ") }),
        danger: true,
      });
      if (!confirmed) {
        return;
      }

      try {
        await onArchiveTask(task.id, { removeLineageReferences: true });
        addToast(t("tasks.archivedUnlinked", "Archived {{taskId}} after unlinking lineage references", { taskId: task.id }), "success");
      } catch (retryErr) {
        addToast(t("tasks.archiveFailed", "Failed to archive {{taskId}}: {{error}}", { taskId: task.id, error: getErrorMessage(retryErr) }), "error");
      }
    });
  }, [addToast, confirm, onArchiveTask, task.id]);

  const handleUnarchiveClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!onUnarchiveTask) return;

    void onUnarchiveTask(task.id).then(() => {
      addToast(t("tasks.unarchived", "Unarchived {{taskId}}", { taskId: task.id }), "success");
    }).catch((err) => {
      addToast(t("tasks.unarchiveFailed", "Failed to unarchive {{taskId}}: {{error}}", { taskId: task.id, error: getErrorMessage(err) }), "error");
    });
  }, [addToast, onUnarchiveTask, task.id]);

  const handleDeleteClick = useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!onDeleteTask) return;

    const shouldDelete = await confirm({
      title: t("tasks.deleteTitle", "Delete Task"),
      message: t("tasks.deleteConfirm", "Delete {{taskId}}?", { taskId: task.id }),
      danger: true,
    });
    if (!shouldDelete) {
      return;
    }

    const trackedIssue = task.githubTracking?.enabled === true ? task.githubTracking.issue : undefined;
    const sourceIssueRef = (() => {
      if (trackedIssue) {
        return null;
      }

      const sourceIssue = task.sourceIssue;
      if (sourceIssue?.provider === "github") {
        const [owner, repo, extra] = sourceIssue.repository.split("/");
        if (owner && repo && !extra && Number.isInteger(sourceIssue.issueNumber) && sourceIssue.issueNumber > 0) {
          return { owner, repo, number: sourceIssue.issueNumber };
        }
      }

      return parseGithubIssueUrl(getIssueUrlFromMetadata(task.sourceMetadata) ?? task.issueInfo?.url);
    })();

    const issueRef = trackedIssue?.owner && trackedIssue.repo && trackedIssue.number
      ? { owner: trackedIssue.owner, repo: trackedIssue.repo, number: trackedIssue.number }
      : sourceIssueRef;

    let githubIssueAction: GithubIssueAction | undefined;
    if (issueRef?.owner && issueRef.repo && issueRef.number) {
      const issueLabel = `${issueRef.owner}/${issueRef.repo}#${issueRef.number}`;
      const shouldCloseIssue = await confirm({
        title: t("tasks.linkedIssueTitle", "Linked GitHub Issue"),
        message: t("tasks.linkedIssueMessage", "Choose what to do with {{issueLabel}} when deleting {{taskId}}.\n\nClose the issue?", { issueLabel, taskId: task.id }),
        confirmLabel: t("tasks.closeIssue", "Close Issue"),
        cancelLabel: t("tasks.moreOptions", "More Options"),
      });

      if (shouldCloseIssue) {
        githubIssueAction = "close";
      } else {
        const shouldDeleteIssue = await confirm({
          title: t("tasks.deleteLinkedIssueTitle", "Delete Linked GitHub Issue"),
          message: t("tasks.deleteLinkedIssueMessage", "Delete {{issueLabel}} on GitHub, or leave it unchanged?", { issueLabel }),
          confirmLabel: t("tasks.deleteIssue", "Delete Issue"),
          cancelLabel: t("tasks.leaveUnchanged", "Leave Unchanged"),
          danger: true,
        });
        githubIssueAction = shouldDeleteIssue ? "delete" : "leave";
      }
    }

    try {
      if (githubIssueAction) {
        await onDeleteTask(task.id, { githubIssueAction });
      } else {
        await onDeleteTask(task.id);
      }
      const issueSuffix = issueRef?.owner && issueRef.repo && issueRef.number && githubIssueAction
        ? ` and ${githubIssueAction === "close" ? t("tasks.issueClosed", "closed") : githubIssueAction === "delete" ? t("tasks.issueDeleted", "deleted") : t("tasks.issueLeft", "left")} issue ${issueRef.owner}/${issueRef.repo}#${issueRef.number}`
        : "";
      addToast(t("tasks.deleted", "Deleted {{taskId}}{{suffix}}", { taskId: task.id, suffix: issueSuffix }), "success");
    } catch (err) {
      const dependencyConflict = extractDependencyDeleteConflict(err);
      if (dependencyConflict && dependencyConflict.dependentIds.length > 0) {
        const dependentList = dependencyConflict.dependentIds.join(", ");
        const confirmed = await confirm({
          title: t("tasks.forceDeleteTitle", "Force Delete Task"),
          message:
            t("tasks.dependencyConflict", "{{taskId}} is a dependency of {{dependentList}}.\n\nDelete anyway by removing these dependency references first?", { taskId: task.id, dependentList }),
          danger: true,
        });
        if (!confirmed) {
          return;
        }

        try {
          await onDeleteTask(task.id, {
            removeDependencyReferences: true,
            removeLineageReferences: true,
            githubIssueAction,
          });
          addToast(t("tasks.deletedRemovedDeps", "Deleted {{taskId}} after removing dependency references", { taskId: task.id }), "success");
        } catch (retryErr) {
          const lineageConflict = extractLineageDeleteConflict(retryErr);
          if (!lineageConflict || lineageConflict.lineageChildIds.length === 0) {
            addToast(t("tasks.deleteFailed", "Failed to delete {{taskId}}: {{error}}", { taskId: task.id, error: getErrorMessage(retryErr) }), "error");
            return;
          }

          const confirmedLineage = await confirm({
            title: t("tasks.forceDeleteTitle", "Force Delete Task"),
            message:
              t("tasks.lineageConflict", "{{taskId}} has lineage children ({{children}}) that reference it as a source parent.\n\nDelete anyway by unlinking these references first?", { taskId: task.id, children: lineageConflict.lineageChildIds.join(", ") }),
            danger: true,
          });
          if (!confirmedLineage) {
            return;
          }

          try {
            await onDeleteTask(task.id, {
              removeDependencyReferences: true,
              removeLineageReferences: true,
              githubIssueAction,
            });
            addToast(t("tasks.deletedUnlinked", "Deleted {{taskId}} after unlinking lineage references", { taskId: task.id }), "success");
          } catch (lineageRetryErr) {
            addToast(t("tasks.deleteFailed", "Failed to delete {{taskId}}: {{error}}", { taskId: task.id, error: getErrorMessage(lineageRetryErr) }), "error");
          }
        }
        return;
      }

      const lineageConflict = extractLineageDeleteConflict(err);
      if (!lineageConflict || lineageConflict.lineageChildIds.length === 0) {
        addToast(t("tasks.deleteFailed", "Failed to delete {{taskId}}: {{error}}", { taskId: task.id, error: getErrorMessage(err) }), "error");
        return;
      }

      const confirmed = await confirm({
        title: t("tasks.forceDeleteTitle", "Force Delete Task"),
        message:
          t("tasks.lineageConflict", "{{taskId}} has lineage children ({{children}}) that reference it as a source parent.\n\nDelete anyway by unlinking these references first?", { taskId: task.id, children: lineageConflict.lineageChildIds.join(", ") }),
        danger: true,
      });
      if (!confirmed) {
        return;
      }

      try {
        await onDeleteTask(task.id, {
          removeDependencyReferences: true,
          removeLineageReferences: true,
          githubIssueAction,
        });
        addToast(t("tasks.deletedUnlinked", "Deleted {{taskId}} after unlinking lineage references", { taskId: task.id }), "success");
      } catch (retryErr) {
        addToast(t("tasks.deleteFailed", "Failed to delete {{taskId}}: {{error}}", { taskId: task.id, error: getErrorMessage(retryErr) }), "error");
      }
    }
  }, [addToast, confirm, onDeleteTask, t, task.githubTracking?.enabled, task.githubTracking?.issue, task.id, task.issueInfo?.url, task.sourceIssue, task.sourceMetadata]);

  const handleOpenFiles = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onOpenDetailWithTab?.(task, "changes");
  }, [task, onOpenDetailWithTab]);

  const handleOpenRetries = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onOpenDetailWithTab?.(task, "retries");
  }, [task, onOpenDetailWithTab]);

  const handleToggleSteps = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setShowSteps((current) => !current);
  }, []);

  const handleMissionClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (task.missionId && onOpenMission) {
      onOpenMission(task.missionId);
    }
  }, [task.missionId, onOpenMission]);

  const handleSendBackClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowSendBackMenu((current) => !current);
  }, []);

  const handleSendBackOptionClick = useCallback(async (e: React.MouseEvent, column: Column) => {
    e.stopPropagation();
    setShowSendBackMenu(false);
    if (!onMoveTask) return;

    try {
      const hasStepProgress = task.steps.some((step) => step.status !== "pending");
      const shouldPrompt = (column === "todo" || column === "triage") && hasStepProgress;
      let moveOptions: { preserveProgress?: boolean } | undefined;

      if (shouldPrompt) {
        const keepProgress = await confirm({
          title: t("tasks.preserveProgressTitle", "Preserve Progress?"),
          message: t("tasks.preserveProgressMessage", "This task has completed steps. Keep progress before moving?"),
          confirmLabel: t("tasks.keepProgress", "Keep Progress"),
          cancelLabel: t("tasks.resetProgress", "Reset Progress"),
        });

        if (keepProgress) {
          moveOptions = { preserveProgress: true };
        } else {
          const resetProgress = await confirm({
            title: t("tasks.resetProgressTitle", "Reset Progress?"),
            message: t("tasks.resetProgressMessage", "Reset all step progress before moving this task?"),
            confirmLabel: t("tasks.resetProgress", "Reset Progress"),
            cancelLabel: t("tasks.cancelMove", "Cancel Move"),
            danger: true,
          });
          if (!resetProgress) {
            return;
          }
        }
      }

      await onMoveTask(task.id, column, moveOptions);
      addToast(t("tasks.moved", "Moved {{taskId}} to {{column}}", { taskId: task.id, column: columnLabel(column) }), "success");
    } catch (err) {
      addToast(t("tasks.moveFailed", "Failed to move {{taskId}}: {{error}}", { taskId: task.id, error: getErrorMessage(err) }), "error");
    }
  }, [addToast, confirm, onMoveTask, task.id, task.steps]);

  const handlePromoteClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!onPromote || isPromoting) return;
    void onPromote(task.id);
  }, [isPromoting, onPromote, task.id]);

  const handleRetryTask = useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!onRetryTask || isRetrying) return;

    setIsRetrying(true);
    try {
      await onRetryTask(task.id);
    } catch (err) {
      addToast(t("tasks.retryFailed", "Failed to retry {{taskId}}: {{error}}", { taskId: task.id, error: getErrorMessage(err) }), "error");
    } finally {
      setIsRetrying(false);
    }
  }, [addToast, isRetrying, onRetryTask, task.id]);

  const cardClass = `card${dragging ? " dragging" : ""}${queued ? " queued" : ""}${isAgentActive ? " agent-active" : ""}${isFailed ? " failed" : ""}${isPaused ? " paused" : ""}${isStuck ? " stuck" : ""}${isAwaitingApproval ? " awaiting-approval" : ""}${isAwaitingInput ? " awaiting-input" : ""}${fileDragOver ? " file-drop-target" : ""}${isEditing ? " card-editing" : ""}${isSaving ? " card-saving" : ""}`;

  const filesChangedButton = (() => {
    if (task.column === "in-progress") {
      const activeDiffCount = diffStats?.filesChanged;
      const fallbackCount =
        activeDiffCount == null
          ? task.modifiedFiles?.length
          : undefined;
      const displayCount = activeDiffCount ?? fallbackCount;
      if (displayCount == null || displayCount === 0) {
        return null;
      }

      return (
        <button
          type="button"
          className="card-session-files"
          onClick={handleOpenFiles}
          disabled={!onOpenDetailWithTab}
        >
          <Folder size={12} />
          <span>{t("tasks.filesChanged", "{{count}} file changed", { count: displayCount, defaultValue_one: "{{count}} file changed", defaultValue_other: "{{count}} files changed" })}</span>
        </button>
      );
    }

    if (task.column === "in-review") {
      const reviewDiffCount = diffStats?.filesChanged;
      const fallbackCount =
        reviewDiffCount == null
          ? task.modifiedFiles?.length
          : undefined;
      const displayCount = reviewDiffCount ?? fallbackCount;
      if (displayCount == null || displayCount === 0) {
        return null;
      }

      return (
        <button
          type="button"
          className="card-session-files"
          onClick={handleOpenFiles}
          disabled={!onOpenDetailWithTab}
        >
          <Folder size={12} />
          <span>{t("tasks.filesChanged", "{{count}} file changed", { count: displayCount, defaultValue_one: "{{count}} file changed", defaultValue_other: "{{count}} files changed" })}</span>
        </button>
      );
    }

    if (task.column === "done") {
      // Done cards only display committed diff counts from authoritative lineage
      // stats or recorded landed files; transient execution-touched files are not shown.
      let displayCount: number | undefined;
      if (diffStats) {
        const landed = task.mergeDetails?.landedFiles;
        const restricted = task.mergeDetails?.landedFilesAttributionRestricted === true;
        displayCount = (restricted && Array.isArray(landed))
          ? Math.min(diffStats.filesChanged, landed.length)
          : diffStats.filesChanged;
      } else if (diffLoading) {
        displayCount = task.mergeDetails?.filesChanged ?? undefined;
      } else {
        displayCount = task.mergeDetails?.landedFiles?.length;
      }
      if (displayCount != null && displayCount > 0) {
        return (
          <button
            type="button"
            className="card-session-files"
            onClick={handleOpenFiles}
            disabled={!onOpenDetailWithTab}
          >
            <Folder size={12} />
            <span>{t("tasks.filesChanged", "{{count}} file changed", { count: displayCount, defaultValue_one: "{{count}} file changed", defaultValue_other: "{{count}} files changed" })}</span>
          </button>
        );
      }
    }

    return null;
  })();

  const chipFarRight = TIME_INDICATOR_COLUMNS.has(task.column)
    && filesChangedButton == null
    && showTrackingIndicator
    && Boolean(githubTrackedIssue);
  const hasCardMetaBadges = showPriorityBadge
    || task.executionMode === "fast"
    || isAgentCreated;

  if (isEditing) {
    return (
      <div
        ref={cardRef}
        className={cardClass}
        data-id={task.id}
        data-column={task.column}
        onDoubleClick={handleDoubleClick}
      >
        <div className="card-editing-content">
          <textarea
            ref={descTextareaRef}
            className="card-edit-desc-textarea"
            placeholder={t("tasks.descriptionPlaceholder", "Task description")}
            value={editDescription}
            onChange={handleDescChange}
            onKeyDown={handleDescKeyDown}
            onBlur={handleBlur}
            disabled={isSaving}
            rows={4}
          />
          {isSaving && (
            <div className="card-edit-loading">
              <span className="card-edit-loading-spinner" />
              <span className="card-edit-loading-text">{t("tasks.saving", "Saving...")}</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={cardRef}
      className={cardClass}
      data-id={task.id}
      data-column={task.column}
      draggable={isDraggable}
      onDragStart={isDraggable ? handleDragStart : undefined}
      onDragEnd={isDraggable ? handleDragEnd : undefined}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
      onClick={handleCardClick}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onDoubleClick={handleDoubleClick}
    >
      <div className="card-header">
        <span className="card-id">{task.id}</span>
        {isPaused && (
          <span
            className="card-status-badge paused"
          >
            {pausedByAgent ? t("tasks.pausedByAgent", "paused by agent") : t("tasks.paused", "paused")}
          </span>
        )}
        {!isPaused && visualStatus && visualStatus !== "queued" && (
          <span
            className={`card-status-badge card-status-badge--${task.column}${isAwaitingApproval ? " awaiting-approval" : ""}${isAwaitingInput ? " awaiting-input" : ""}${ACTIVE_STATUSES.has(visualStatus) ? " pulsing" : ""}${isFailed ? " failed" : ""}${isStuck ? " stuck" : ""}`}
          >
            {isStuck ? t("tasks.stuck", "Stuck") : isAwaitingApproval ? t("tasks.awaitingApproval", "Awaiting Approval") : isAwaitingInput ? t("tasks.needsInput", "Needs input") : visualStatus === "merging-fix" ? t("tasks.statusMergingFix", "Merging fixes…") : getTaskStatusLabel(visualStatus, t)}
          </span>
        )}
        {hasInReviewStall && stallCopy && (
          <span
            className={`card-status-badge card-status-badge--in-review in-review-stall in-review-stall--${stallCopy.code}`}
            title={`${stallCopy.headline} — ${stallCopy.description}`}
            data-stall-code={stallCopy.code}
          >
            {stallCopy.badgeLabel}{stallCopy.counter ? ` ${stallCopy.counter}` : ""}
          </span>
        )}
        {cliWaitingOnInput && (
          <span
            className="card-status-badge card-status-badge--cli-waiting"
            data-cli-state="waitingOnInput"
            title={t("tasks.cliWaitingOnInputTitle", "The CLI agent is waiting for your input")}
          >
            {t("tasks.cliWaitingOnInput", "Waiting on input")}
          </span>
        )}
        {cliNeedsAttention && (
          <span
            className="card-status-badge card-status-badge--cli-attention failed"
            data-cli-state="needsAttention"
            title={t("tasks.cliNeedsAttentionTitle", "The CLI agent needs your attention")}
          >
            {t("tasks.cliNeedsAttention", "Needs attention")}
          </span>
        )}
        {hasStalePausedReview && stalePausedReviewCopy && (
          <span
            className={`card-status-badge card-status-badge--in-review stale-paused-review stale-paused-review--${stalePausedReviewCopy.code}`}
            title={`${stalePausedReviewCopy.headline} — ${stalePausedReviewCopy.description}`}
            data-stale-paused-review-code={stalePausedReviewCopy.code}
          >
            {stalePausedReviewCopy.badgeLabel}
          </span>
        )}
        {hasTaskAgeStaleness && taskAgeStalenessCopy && (
          <span
            className={`card-status-badge card-task-age-staleness-badge card-task-age-staleness-badge--${taskAgeStalenessCopy.badgeTone}`}
            title={`${taskAgeStalenessCopy.headline} — ${taskAgeStalenessCopy.description}`}
          >
            {taskAgeStalenessCopy.badgeLabel}
          </span>
        )}
        {isStuck && (isPaused || !task.status || task.status === "queued") && (
          <span className="card-status-badge stuck">
            {t("tasks.stuck", "Stuck")}
          </span>
        )}
        {/* U13/U9: per-branch progress badges while the card is in a parallel
            window. Reads an optional additive `branchProgress` field on the task
            payload (server-persisted by U13); absent → nothing renders. */}
        {Array.isArray((task as TaskWithBranchProgress).branchProgress) &&
          (task as TaskWithBranchProgress).branchProgress!.length > 0 && (
            <span
              className="card-status-badge card-branch-progress"
              title={t("tasks.branchProgressTitle", "Parallel branches in progress")}
              data-testid="branch-progress-badge"
            >
              {t("tasks.branchProgress", "{{done}}/{{total}} branches", {
                done: (task as TaskWithBranchProgress).branchProgress!.filter(
                  (b) => b.status === "completed",
                ).length,
                total: (task as TaskWithBranchProgress).branchProgress!.length,
              })}
            </span>
          )}
        {showStalledReview && stalledReview && (
          <span
            className="card-status-badge card-status-badge--in-review stalled-review"
            title={stalledReview.reason}
          >
            {t("tasks.stalled", "Stalled")}
          </span>
        )}
        {(livePrInfo || liveIssueInfo) && (
          <>
            {livePrInfo && (task.prInfos?.length ?? 0) >= 2 ? (
              <a className={`card-github-badge card-github-badge--${livePrInfo.status}`} title={t("tasks.prBadgeTitle", "PR #{{number}}: {{title}}", { number: livePrInfo.number, title: livePrInfo.title })} href={livePrInfo.url} target="_blank" rel="noopener noreferrer">
                <GitPullRequest size={10} />
                <span>{`${task.prInfos?.length}x #${livePrInfo.number}`}</span>
              </a>
            ) : null}
            {(task.prInfos?.length ?? 0) < 2 || liveIssueInfo ? (
              <GitHubBadge
                prInfo={(task.prInfos?.length ?? 0) >= 2 ? undefined : livePrInfo}
                issueInfo={liveIssueInfo}
              />
            ) : null}
          </>
        )}
        {prNode && (
          prNode.state === "failed" ? (
            <button
              type="button"
              className="card-status-badge card-pr-node-badge card-pr-node-badge--failed"
              data-testid="pr-node-badge-failed"
              title={t("tasks.prNodeFailedTitle", "PR creation failed — open the PR view")}
              onClick={(e) => {
                e.stopPropagation();
                onOpenPullRequest?.(prNode.id);
              }}
            >
              <AlertTriangle size={10} aria-hidden="true" />
              <span>{t("tasks.prNodeFailed", "PR failed")}</span>
            </button>
          ) : (
            <button
              type="button"
              className={`card-status-badge card-pr-node-badge card-pr-node-badge--${prNode.state}`}
              data-testid={`pr-node-badge-${prNode.state}`}
              title={t("tasks.prNodeTitle", "PR {{state}} — open the PR view", { state: prNode.state })}
              onClick={(e) => {
                e.stopPropagation();
                onOpenPullRequest?.(prNode.id);
              }}
            >
              <GitPullRequest size={10} aria-hidden="true" />
              <span>
                {prNode.prNumber != null
                  ? t("tasks.prNodeWithNumber", "PR #{{number}} · {{state}}", { number: prNode.prNumber, state: prNode.state })
                  : t("tasks.prNodeState", "PR · {{state}}", { state: prNode.state })}
              </span>
            </button>
          )
        )}
        {hasCardMetaBadges && (
          <div className="card-meta-badges" data-testid="card-meta-badges">
            {showPriorityBadge && (
              <span className={`card-priority-badge card-priority-badge--${normalizedPriority}`}>
                {normalizedPriority}
              </span>
            )}
            {task.executionMode === "fast" && (
              <span
                className="card-execution-mode-badge card-execution-mode-badge--fast"
                title={t("tasks.fastMode", "Fast mode")}
                aria-label={t("tasks.fastMode", "Fast mode")}
              >
                <Zap aria-hidden="true" />
                <span className="visually-hidden">{t("tasks.fastMode", "Fast mode")}</span>
              </span>
            )}
            {isAgentCreated && (
              <span
                className="card-agent-created-badge"
                title={agentCreatedTitle}
                aria-label={agentCreatedTitle}
              >
                <Bot size={11} aria-hidden="true" />
                <span className="visually-hidden">{agentCreatedTitle}</span>
                <span aria-hidden="true">{agentCreatedVisibleLabel}</span>
              </span>
            )}
          </div>
        )}
        {task.noCommitsExpected === true && (
          <span className="card-no-commits-expected-badge" title={t("tasks.decisionOnlyTitle", "Decision-only task")}>{t("tasks.decisionOnly", "decision-only")}</span>
        )}
        {task.missionId && (
          <span
            className="card-mission-badge"
            onClick={handleMissionClick}
            title={t("tasks.missionBadgeTitle", "Mission: {{name}}", { name: missionTitle ?? task.missionId })}
            role={onOpenMission ? "button" : undefined}
            tabIndex={onOpenMission ? 0 : undefined}
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            <Target size={11} />
            {abbreviateMissionTitle(missionTitle ?? task.missionId)}
          </span>
        )}
        <div className="card-header-actions">
          {isAwaitingInput && onOpenDetailWithTab && (
            <button
              className="card-answer-questions-btn"
              onClick={(e) => {
                e.stopPropagation();
                onOpenDetailWithTab(task, "workflow");
              }}
              title={t("tasks.answerQuestions", "Answer questions")}
              aria-label={t("tasks.answerQuestions", "Answer questions")}
            >
              {t("tasks.answerQuestions", "Answer questions")}
            </button>
          )}
          {canEdit && (
            <button
              className="card-edit-btn"
              onClick={handleEditClick}
              title={t("tasks.editTask", "Edit task")}
              aria-label={t("tasks.editTask", "Edit task")}
            >
              <Pencil size={12} />
            </button>
          )}
          {task.column === "triage" && onDeleteTask && (
            <button
              className="card-delete-btn"
              onClick={handleDeleteClick}
              title={t("tasks.deleteTask", "Delete task")}
              aria-label={t("tasks.deleteTask", "Delete task")}
            >
              <Trash2 size={12} />
            </button>
          )}
          {task.column === "done" && onArchiveTask && (
            <button
              className="card-archive-btn"
              onClick={handleArchiveClick}
              title={t("tasks.archiveTask", "Archive task")}
              aria-label={t("tasks.archiveTask", "Archive task")}
            >
              {t("tasks.archive", "Archive")}
            </button>
          )}
          {task.column === "archived" && onUnarchiveTask && (
            <button
              className="card-unarchive-btn"
              onClick={handleUnarchiveClick}
              title={t("tasks.unarchiveTask", "Unarchive task")}
              aria-label={t("tasks.unarchiveTask", "Unarchive task")}
            >
              {t("tasks.unarchive", "Unarchive")}
            </button>
          )}
          {task.column === "in-progress" && onMoveTask && (
            <div className="card-send-back" ref={sendBackRef}>
              <button
                className="card-send-back-btn"
                onClick={handleSendBackClick}
                title={t("tasks.sendBack", "Send back")}
                aria-label={t("tasks.sendBack", "Send back")}
                aria-haspopup="menu"
                aria-expanded={showSendBackMenu}
              >
                {t("tasks.sendBack", "Send back")}
                <ChevronDown size={10} />
              </button>
              {showSendBackMenu && (
                <div className="card-send-back-menu" role="menu">
                  {VALID_TRANSITIONS["in-progress"]
                    .filter((col) => col !== "in-review")
                    .map((col) => (
                      <button
                        key={col}
                        className="card-send-back-menu-item"
                        role="menuitem"
                        onClick={(e) => handleSendBackOptionClick(e, col)}
                      >
                        {columnLabel(col)}
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}
          {task.size && (
            <span className={`card-size-badge size-${task.size.toLowerCase()}`}>
              {task.size}
            </span>
          )}
        </div>
      </div>
      {showStalledReview && stalledReview && (
        <div className="card-stalled-review-reason" title={stalledReview.reason}>
          {stalledReview.reason}
        </div>
      )}
      {isFailed && task.error && (
        <div className="card-error" title={task.error}>
          <span className="card-error-icon">⚠</span>
          <span className="card-error-text">{task.error.length > 60 ? task.error.slice(0, 60) + "…" : task.error}</span>
          {onRetryTask && (
            <button
              type="button"
              className="btn btn-sm card-error-retry-btn"
              onClick={handleRetryTask}
              disabled={isRetrying}
            >
              <RotateCw size={12} />
              {isRetrying ? t("tasks.retrying", "Retrying…") : t("tasks.retry", "Retry")}
            </button>
          )}
        </div>
      )}
      <div className="card-title" title={task.title || task.description || undefined}>
        {truncate(task.title, MAX_TITLE_LENGTH) || truncate(task.description, MAX_TITLE_LENGTH) || task.id}
      </div>
      {(() => {
        // Card-placed custom field badges (U13/KTD-14). Bounded to MAX_CARD_FIELDS
        // with a "+N" overflow chip. Nothing renders when no card fields are
        // defined or all values are empty — card stays byte-identical to today.
        const cardDefs = (cardFieldDefs ?? []).filter((f) => f.render?.placement === "card");
        if (cardDefs.length === 0) return null;
        const values = task.customFields ?? {};
        const badges = cardDefs
          .map((f) => renderCardFieldBadge(f, values[f.id]))
          .filter((b): b is ReactElement => b !== null);
        if (badges.length === 0) return null;
        const shown = badges.slice(0, MAX_CARD_FIELDS);
        const overflow = badges.length - shown.length;
        return (
          <div className="card-field-badges" data-testid="card-field-badges">
            {shown}
            {overflow > 0 ? (
              <span className="card-field-badge card-field-badge--overflow" data-testid="card-field-overflow">
                +{overflow}
              </span>
            ) : null}
          </div>
        );
      })()}
      {/* FNXC:Workspace 2026-06-21-00:00: workspace tasks have no singular task.branch,
          so the branch-metadata row below renders nothing. Surface the acquired sub-repos
          as a compact "N repos acquired" placeholder so the card isn't blank (U3/KTD5). */}
      {isWorkspaceTask(task) && <WorkspaceWorktreesSummary task={task} compact />}
      {hasBranchMetadata && (
        <div className="card-branch-row" aria-label={t("tasks.branchMetadata", "Branch metadata")}>
          {branchMetadata.branch && (
            <span className="card-branch-chip" title={branchMetadata.branch}>
              <span className="card-branch-label">{t("tasks.branch", "Branch")}</span>
              <span className="card-branch-value">{branchMetadata.branch}</span>
            </span>
          )}
          {branchMetadata.baseBranch && (
            <span className="card-branch-chip" title={branchMetadata.baseBranch}>
              <span className="card-branch-label">{t("tasks.baseBranch", "Base")}</span>
              <span className="card-branch-value">{branchMetadata.baseBranch}</span>
            </span>
          )}
          {task.branchContext?.groupId && (() => {
            const { branchContext } = task;
            // Capture into a const: narrowing on the optional groupId does not
            // survive into the onClick closure below.
            const groupId = branchContext?.groupId;
            if (!branchContext || !groupId) return null;
            return (
              <span
                className="card-branch-chip"
                title={
                  branchContext.assignmentMode === "shared" && branchMetadata.branch
                    ? `${groupId} · ${branchMetadata.branch}`
                    : groupId
                }
                onClick={(event) => {
                  if (!onOpenGroupModal) return;
                  event.stopPropagation();
                  onOpenGroupModal(groupId);
                }}
              >
                <span className="card-branch-label">
                  {branchContext.assignmentMode === "shared" ? t("tasks.sharedBranch", "Shared") : t("tasks.groupBranch", "Group")}
                </span>
                <span className="card-branch-value">
                  {branchContext.assignmentMode === "shared" && branchMetadata.branch
                    ? branchMetadata.branch
                    : groupId}
                </span>
              </span>
            );
          })()}
        </div>
      )}
      {showProgressSection && (() => {
        const progressPercent = (unifiedProgress.completed / unifiedProgress.total) * 100;
        return (
          <>
            <div className="card-progress">
              <div className="card-progress-bar">
                <div
                  className="card-progress-fill"
                  style={{
                    width: `${progressPercent}%`,
                    // Issue 1403: custom columns have no legacy progress color → fall back to accent.
                    backgroundColor:
                      (COLUMN_PROGRESS_COLOR_MAP as Record<string, string>)[task.column] ?? "var(--accent)",
                  }}
                />
              </div>
              <span className="card-progress-label">{unifiedProgress.completed}/{unifiedProgress.total}</span>
            </div>
            <button
              type="button"
              className="card-steps-toggle"
              onClick={handleToggleSteps}
              aria-expanded={showSteps}
              aria-label={showSteps ? t("tasks.hideSteps", "Hide steps") : t("tasks.showSteps", "Show steps")}
            >
              <span>{t("tasks.stepCount", "{{count}} step", { count: unifiedProgress.total, defaultValue_one: "{{count}} step", defaultValue_other: "{{count}} steps" })}</span>
              <ChevronDown
                size={14}
                className={`card-steps-toggle-icon${showSteps ? " expanded" : ""}`}
              />
            </button>
            {showSteps && (
              <div className="card-steps-list">
                {unifiedProgress.items.map((step) => {
                  const isWorkflowFailed = step.source === "workflow" && step.status === "failed";

                  return (
                    <div key={step.id} className="card-step-item">
                      <span
                        className={`card-step-dot card-step-dot--${step.status}${isWorkflowFailed ? " card-step-dot--workflow-failed" : ""}`}
                        aria-hidden="true"
                      />
                      <span className={`card-step-name${step.status === "done" ? " completed" : ""}`}>
                        {step.name}
                      </span>
                      {step.source === "workflow" && (
                        <span
                          className={`card-step-workflow-badge card-step-workflow-badge--${step.phase}`}
                          title={t("tasks.workflowCheck", "Workflow check")}
                        >
                          {t("tasks.workflow", "workflow")}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        );
      })()}
      {(filesChangedButton || isGitHubImportedTask || timeIndicator || showNearDuplicateChip || ((showTrackingIndicator || showLinkedIssueChipForImport) && githubTrackedIssue) || (task.retrySummary?.total ?? 0) > 0) && (
        <div className={`card-footer-row${chipFarRight ? " card-footer-row--chip-far-right" : ""}`}>
          {filesChangedButton}
          {isGitHubImportedTask && !showLinkedIssueChipForImport && (
            <span
              className="card-source-provenance"
              title={sourceIssueUrl ? t("tasks.importedFromGitHubUrl", "Imported from GitHub: {{url}}", { url: sourceIssueUrl }) : t("tasks.importedFromGitHub", "Imported from GitHub")}
              aria-label={t("tasks.importedFromGitHub", "Imported from GitHub")}
            >
              <ProviderIcon provider="github" size="sm" />
            </span>
          )}
          {(timeIndicator || showNearDuplicateChip || ((showTrackingIndicator || showLinkedIssueChipForImport) && githubTrackedIssue) || (task.retrySummary?.total ?? 0) > 0) && (
            <div className="card-footer-row-right">
              {showNearDuplicateChip && (
                <>
                  <span
                    className="card-duplicate-chip"
                    title={t("tasks.nearDuplicateTitle", "Potential near-duplicate of {{id}}", { id: String(task.sourceMetadata?.nearDuplicateOf) })}
                    aria-label={t("tasks.nearDuplicateTitle", "Potential near-duplicate of {{id}}", { id: String(task.sourceMetadata?.nearDuplicateOf) })}
                  >
                    <span>{t("tasks.duplicateOf", "Duplicate of {{id}}", { id: String(task.sourceMetadata?.nearDuplicateOf) })}</span>
                  </span>
                  {onUpdateTask && (
                    <button
                      type="button"
                      className="card-duplicate-keep"
                      onClick={(e) => void handleDismissNearDuplicate(e)}
                      title={t("tasks.keepTaskTitle", "Keep this task and dismiss duplicate warning")}
                      aria-label={t("tasks.keepTaskTitle", "Keep this task and dismiss duplicate warning")}
                    >
                      {t("tasks.keep", "Keep")}
                    </button>
                  )}
                </>
              )}
              {chipFarRight && (showTrackingIndicator || showLinkedIssueChipForImport) && githubTrackedIssue && (
                <a
                  className="card-github-tracking-chip card-github-tracking-link"
                  href={githubTrackedIssue.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t("tasks.linkedIssueChipTitle", "Linked GitHub issue: {{owner}}/{{repo}}#{{number}}", { owner: githubTrackedIssue.owner, repo: githubTrackedIssue.repo, number: githubTrackedIssue.number })}
                  aria-label={t("tasks.linkedIssueChipAriaLabel", "Linked GitHub issue #{{number}}", { number: githubTrackedIssue.number })}
                  onClick={(e) => e.stopPropagation()}
                >
                  <ProviderIcon provider="github" size="sm" />
                  <span>{`#${githubTrackedIssue.number}`}</span>
                </a>
              )}
              {(task.retrySummary?.total ?? 0) > 0 && (
                <span
                  className={`card-retry-badge${(retryWarningThreshold != null && (task.retrySummary?.total ?? 0) >= retryWarningThreshold) ? " card-retry-badge--error" : " card-retry-badge--warning"}`}
                  onClick={handleOpenRetries}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      onOpenDetailWithTab?.(task, "retries");
                    }
                  }}
                  aria-label={t("tasks.retriesAriaLabel", "{{count}} retries", { count: task.retrySummary?.total ?? 0 })}
                  title={t("tasks.openRetryBreakdown", "Open retry breakdown")}
                >
                  <RotateCw size={11} />
                  <span>{task.retrySummary?.total ?? 0}</span>
                </span>
              )}
              {(!chipFarRight || !((showTrackingIndicator || showLinkedIssueChipForImport) && githubTrackedIssue))
                && (showTrackingIndicator || showLinkedIssueChipForImport) && githubTrackedIssue && (
                  <a
                    className="card-github-tracking-chip card-github-tracking-link"
                    href={githubTrackedIssue.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={t("tasks.linkedIssueChipTitle", "Linked GitHub issue: {{owner}}/{{repo}}#{{number}}", { owner: githubTrackedIssue.owner, repo: githubTrackedIssue.repo, number: githubTrackedIssue.number })}
                    aria-label={t("tasks.linkedIssueChipAriaLabel", "Linked GitHub issue #{{number}}", { number: githubTrackedIssue.number })}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ProviderIcon provider="github" size="sm" />
                    <span>{`#${githubTrackedIssue.number}`}</span>
                  </a>
                )}
              {/*
              FNXC:TaskCardTimingBadge 2026-06-13-17:20:
              The execution-time badge belongs in the bottom-right footer cluster and must match sibling footer badge sizing while preserving its existing label, title, aria text, and live-update data.
              */}
              {timeIndicator && (
                <span
                  className="card-time-indicator"
                  title={timeIndicator.title}
                  aria-label={timeIndicator.ariaLabel}
                >
                  <Clock size={12} />
                  <span>{timeIndicator.label}</span>
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {metaRowVisible && (
        <div className="card-meta">
          {task.dependencies && task.dependencies.length > 0 && (
            <div className="card-dep-list">
              {task.dependencies.map((depId) => (
                <span
                  key={depId}
                  className="card-dep-badge clickable"
                  onClick={(e) => void handleDepClick(e, depId)}
                  title={t("tasks.viewDependency", "Click to view {{depId}}", { depId })}
                >
                  <Link size={12} style={{ verticalAlign: "middle" }} /> {depId}
                </span>
              ))}
            </div>
          )}
          {(task.overlapBlockedBy || task.blockedBy) && (
            <span className="card-scope-badge" data-tooltip={t("tasks.blockedByTooltip", "Blocked by {{taskId}} (file overlap)", { taskId: task.overlapBlockedBy || task.blockedBy })}>
              <Layers size={12} style={{ verticalAlign: "middle" }} /> {task.overlapBlockedBy || task.blockedBy}
            </span>
          )}
          {fanout && fanout.totalCount > 0 && (
            <span
              className={`card-fanout-badge${fanout.staleBlockedByDependentIds.length > 0 ? " card-fanout-badge--stale" : ""}`}
              data-tooltip={t("tasks.fanoutTooltip", "Blocking {{count}} active task(s); overlap blockedBy queue: {{queueCount}} todo{{highFanout}}{{escalation}}", { count: fanout.totalCount, queueCount: fanout.overlapBlockedTodoCount, highFanout: fanout.isHighFanout ? t("tasks.fanoutHighFanoutSuffix", " (overlap bottleneck threshold: {{threshold}})", { threshold: HIGH_FANOUT_BLOCKER_TODO_THRESHOLD }) : "", escalation: fanout.escalation ? t("tasks.fanoutEscalationSuffix", " · escalated after {{minutes}}m in blocking column", { minutes: Math.floor(fanout.escalation.blockingAgeMs / 60000) }) : "" })}
            >
              <GitBranch size={12} style={{ verticalAlign: "middle" }} />
              <span>
                {fanout.escalation ? t("tasks.fanoutEscalated", "Escalated overlap") : fanout.isHighFanout ? t("tasks.fanoutBottleneck", "Overlap bottleneck") : t("tasks.fanoutBlocks", "Blocks")}{" "}
                <span className="card-fanout-count">{fanout.totalCount}</span>
                {fanout.staleBlockedByDependentIds.length > 0 ? ` (${t("tasks.fanoutStale", "{{count}} stale", { count: fanout.staleBlockedByDependentIds.length })})` : ""}
              </span>
            </span>
          )}
          {(queued || task.status === "queued") && task.column !== "in-progress" && <span className="queued-badge"><Clock size={12} style={{ verticalAlign: "middle" }} /> {t("tasks.queued", "Queued")}</span>}
          {showInReviewMoveControl && renderInReviewMoveControl()}
        </div>
      )}
      {(task.assignedAgentId || taskProviders.length > 0) && (
        <div className="card-agent-row">
          {taskProviders.length > 0 && (
            <span className="card-provider-icons" data-testid="card-provider-icons">
              {taskProviders.map((provider) => (
                <ProviderIcon key={provider} provider={provider} size="sm" />
              ))}
            </span>
          )}
          {task.assignedAgentId && (
            <span
              className={`card-agent-badge${isAgentNameLoading ? " card-agent-badge--loading" : ""}`}
              title={t("tasks.assignedTo", "Assigned to {{name}}", { name: assignedAgentBadgeLabel })}
            >
              <Bot size={11} />
              <span className="card-agent-badge-text" aria-hidden="true">
                {abbreviateBadge(assignedAgentBadgeLabel, 15)}
              </span>
              <span className="visually-hidden">{t("tasks.assignedTo", "Assigned to {{name}}", { name: assignedAgentBadgeLabel })}</span>
            </span>
          )}
        </div>
      )}
      {shouldRenderActionRow && (
        <div className="card-action-row">
          {showCreatePrQuickAction && (
            <button
              type="button"
              className="card-create-pr-action"
              title={t("tasks.createPrTitle", "Create a PR for this task")}
              aria-label={t("tasks.createPrAriaLabel", "Create pull request")}
              onClick={(event) => {
                event.stopPropagation();
                setIsPrCreateOpen(true);
              }}
            >
              <GitPullRequest size={12} />
              {t("tasks.createPr", "Create PR")}
            </button>
          )}
          {onPromote && (
            <button
              type="button"
              className="card-promote-action card-send-back-btn"
              data-testid={`card-promote-${task.id}`}
              title={t("tasks.promoteTask", "Promote task")}
              aria-label={t("tasks.promoteTask", "Promote task")}
              disabled={isPromoting}
              onClick={handlePromoteClick}
            >
              <ArrowUpRight size={12} />
              {isPromoting ? t("tasks.promoting", "Promoting…") : t("tasks.promote", "Promote")}
            </button>
          )}
          {showInReviewMoveControl && !metaRowVisible && renderInReviewMoveControl()}
        </div>
      )}
      <PluginSlot slotId="task-card-badge" projectId={projectId} />
      {(showCreatePrQuickAction || isPrCreateOpen) && (
        <PrCreateModal
          open={isPrCreateOpen}
          taskId={task.id}
          projectId={projectId}
          onClose={() => setIsPrCreateOpen(false)}
          onCreated={(prInfo) => {
            setIsPrCreateOpen(false);
            addToast(t("tasks.createdPr", "Created PR #{{number}}", { number: prInfo.number }), "success");
          }}
          addToast={addToast}
        />
      )}
    </div>
  );
}

const TOUCH_MOVE_THRESHOLD = 10; // pixels
const TOUCH_TAP_MAX_DURATION = 300; // milliseconds
const MAX_TITLE_LENGTH = 140;

function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** @internal Test helper to verify TaskCard memo comparator behavior */
export function __test_areTaskCardPropsEqual(previous: TaskCardProps, next: TaskCardProps): boolean {
  return areTaskCardPropsEqual(previous, next);
}

export const TaskCard = memo(TaskCardComponent, areTaskCardPropsEqual);
TaskCard.displayName = "TaskCard";
